import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHistoryCompatibility } from './history.mjs';
import { TRANSCRIPT_LIMITS } from '../transcript.mjs';

const toolResult = (id, toolCallId, text, parentId = null, isError = false) => ({ type: 'message', id, parentId,
  message: { role: 'toolResult', toolCallId, toolName: 'synthetic-tool', isError, content: [{ type: 'text', text }] } });

async function fixture(t, entries = [], options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-history-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessionsDir = path.join(root, 'sessions'), retentionDir = path.join(root, 'remote'), cwd = path.join(root, 'project');
  await Promise.all([fs.mkdir(sessionsDir), fs.mkdir(retentionDir), fs.mkdir(cwd)]);
  const row = { id: 'native-header-id', cwd, sessionFile: path.join(sessionsDir, 'legacy-filename-id.jsonl'), status: 'ended' };
  const header = { type: 'session', version: 3, id: row.id, cwd, timestamp: '2030-01-01T00:00:00.000Z' };
  await fs.writeFile(row.sessionFile, [header, ...entries].map(value => JSON.stringify(value)).join('\n') + '\n');
  const rows = new Map([[row.id, row]]), journal = new Map();
  let lookups = 0;
  const sessions = {
    getSession(id) { lookups++; return rows.get(id); },
    readEvents(id, { after, limit }) { return { events: (journal.get(id) ?? []).filter(entry => entry.sequence > after).slice(0, limit) }; },
  };
  const handle = createHistoryCompatibility({ sessions, sessionsDir, retentionDir, authorizeSession: async () => true, ...options });
  const get = async (pathname, search = '') => handle({ method: 'GET', pathname, url: new URL(pathname + search, 'http://localhost'), principal: { iss: 'synthetic', sub: 'reader' } });
  return { root, row, header, rows, journal, sessionsDir, retentionDir, sessions, handle, get, lookups: () => lookups };
}

async function completeToolRead(f, toolCallId, query = '') {
  const pathname = '/api/sessions/' + f.row.id + '/tool-result/' + encodeURIComponent(toolCallId);
  let result = await f.get(pathname, query), calls = 1;
  while (result.body.searching) {
    result = await f.get(pathname, '?cursor=' + result.body.nextCursor);
    assert.ok(++calls < 120);
  }
  return { result, calls };
}

test('small historical tool results preserve the former envelope and select the exact active native branch', async t => {
  const f = await fixture(t, [toolResult('good', 'call/one', '真实结果😀'), toolResult('other', 'call/one', 'other branch'),
    { type: 'custom', id: 'decoy', data: { message: { role: 'toolResult', toolCallId: 'call/decoy' } } },
    { type: 'message', id: 'leaf', parentId: 'good', message: { role: 'user', content: 'continue' } }]);
  const { result } = await completeToolRead(f, 'call/one');
  assert.equal(result.statusCode, 200); assert.deepEqual(result.body, { result: '真实结果😀', isError: false });
  assert.equal((await completeToolRead(f, 'call/decoy')).result.statusCode, 404);
  f.rows.set('legacy-filename-id', { ...f.row, id: 'legacy-filename-id' });
  await assert.rejects(f.get('/api/sessions/legacy-filename-id/tool-result/call'), { code: 'transcript-identity-mismatch' });
});

test('tool result pending and eviction responses require their exact positive evidence', async t => {
  const f = await fixture(t, [], {
    findToolEndEvent: async () => ({ data: { toolCallId: 'call', result: 'synthetic death', healedBy: 'session_ended' } }),
    isToolInFlight: async () => true,
  });
  f.row.status = 'streaming';
  const pathname = '/api/sessions/' + f.row.id + '/tool-result/call';
  assert.equal((await f.get(pathname)).statusCode, 404);
  assert.deepEqual(await f.get(pathname, '?pending=1'), { statusCode: 202, body: { pending: true } });
  const evicted = createHistoryCompatibility({ sessions: f.sessions, sessionsDir: f.sessionsDir, authorizeSession: () => true,
    isToolInFlight: () => true, wasToolEndEvicted: () => true });
  const gone = await evicted({ method: 'GET', pathname, url: new URL(pathname + '?pending=1', 'http://localhost') });
  assert.deepEqual(gone, { statusCode: 410, body: { error: 'result no longer available' } });
});

test('a greater-than-61MB native transcript yields bounded search pages and lossless large tool entry windows', async t => {
  const f = await fixture(t);
  const handle = await fs.open(f.row.sessionFile, 'a');
  const padding = 'p'.repeat(64 * 1024);
  let parent = null;
  try {
    for (let i = 0; i < 980; i++) {
      const id = 'padding-' + i;
      await handle.write(JSON.stringify({ type: 'custom', id, parentId: parent, data: padding }) + '\n');
      parent = id;
    }
    const entry = toolResult('large-result', 'large-call', '逐字恢复😀\n'.repeat(45_000), parent, true);
    await handle.write(JSON.stringify(entry) + '\n');
    await handle.sync();
    assert.ok((await handle.stat()).size > 61 * 1024 * 1024);
    let { result, calls } = await completeToolRead(f, 'large-call');
    assert.ok(calls > 40); assert.equal(result.body.encoding, 'jsonl-utf8');
    const chunks = [], pathname = '/api/sessions/' + f.row.id + '/tool-result/large-call';
    let offset = 0;
    do {
      assert.equal(result.statusCode, 200); assert.equal(result.body.offset, offset);
      assert.ok(Buffer.byteLength(result.body.content) <= TRANSCRIPT_LIMITS.entryChunkBytes);
      chunks.push(result.body.content); offset += Buffer.byteLength(result.body.content);
      if (!result.body.nextCursor) break;
      result = await f.get(pathname, '?cursor=' + result.body.nextCursor);
    } while (true);
    assert.deepEqual(JSON.parse(chunks.join('')), entry);
    assert.equal(result.body.complete, true);
  } finally { await handle.close(); }
});

test('event lookup returns the actual journal sequence and paginates a large event without inventing entries', async t => {
  const f = await fixture(t), event = { type: 'tool_execution_end', toolCallId: 'actual-call', result: { content: [{ type: 'text', text: '原文😀'.repeat(50_000) }] } };
  f.journal.set(f.row.id, [{ sequence: 17, event }]);
  assert.equal((await f.get('/api/events/' + f.row.id + '/16')).statusCode, 404);
  let result = await f.get('/api/events/' + f.row.id + '/17'), cursor, content = '';
  do {
    assert.equal(result.statusCode, 200); assert.equal(result.body.data.sequence, 17);
    assert.equal(result.body.data.encoding, 'json-utf8'); content += result.body.data.content;
    cursor = result.body.data.nextCursor;
    if (cursor) result = await f.get('/api/events/' + f.row.id + '/17', '?cursor=' + cursor);
  } while (cursor);
  const decoded = JSON.parse(content);
  assert.equal(decoded.eventType, 'tool_execution_end'); assert.deepEqual(decoded.data.result, event.result);
  const first = await f.get('/api/events/' + f.row.id + '/17');
  f.journal.get(f.row.id)[0].event = { ...event, changed: true };
  await assert.rejects(f.get('/api/events/' + f.row.id + '/17', '?cursor=' + first.body.data.nextCursor), { code: 'history-event-cursor-changed' });
});

test('retained remote transcripts retain raw lines, state and bounded pages while local origin is refused', async t => {
  const f = await fixture(t);
  const pathname = '/api/sessions/' + f.row.id + '/retained-transcript';
  assert.equal((await f.get(pathname)).statusCode, 403);
  f.row.originDeviceId = 'synthetic-remote';
  assert.equal((await f.get(pathname)).body.data.state, 'absent');
  const file = path.join(f.retentionDir, f.row.id + '.jsonl');
  const rawHeader = JSON.stringify({ ...f.header, cwd: '/foreign/project' });
  f.row.cwd = '/foreign/project';
  const first = '{ "type": "message", "id": "first", "message": {"role":"user","content":"keep spacing"} }';
  const second = '{"type":"message","id":"second","message":{"role":"user","content":"next"}}';
  await fs.writeFile(file, rawHeader + '\n' + first + '\n' + second + '\n');
  const newest = await f.get(pathname, '?limit=1');
  assert.equal(newest.body.data.state, 'incomplete'); assert.deepEqual(newest.body.data.entries, [second]);
  assert.equal(newest.body.data.header, rawHeader);
  await fs.writeFile(file + '.complete', '');
  const older = await f.get(pathname, '?limit=1&cursor=' + newest.body.data.nextCursor);
  assert.equal(older.body.data.state, 'complete'); assert.deepEqual(older.body.data.entries, [rawHeader, first]);
  assert.equal(older.body.data.nextCursor, null);
});

test('shape and ACL checks run before content reads and revalidate after a successful lookup', async t => {
  const f = await fixture(t, [toolResult('a', 'call', 'sensitive')]);
  const before = f.lookups();
  await assert.rejects(f.get('/api/sessions/' + f.row.id + '/retained-transcript', '?path=/etc/passwd'), { statusCode: 400 });
  assert.equal(f.lookups(), before);
  const denied = createHistoryCompatibility({ sessions: f.sessions, sessionsDir: f.sessionsDir, authorizeSession: () => false });
  const pathname = '/api/sessions/' + f.row.id + '/tool-result/call';
  await assert.rejects(denied({ method: 'GET', pathname, url: new URL(pathname, 'http://localhost') }), { statusCode: 404 });
  let checks = 0;
  const revoked = createHistoryCompatibility({ sessions: f.sessions, sessionsDir: f.sessionsDir, authorizeSession: () => ++checks === 1 });
  await assert.rejects(revoked({ method: 'GET', pathname, url: new URL(pathname, 'http://localhost') }), { statusCode: 404 });
  assert.equal(checks, 2);
});

test('retained giant records remain byte-for-byte available through raw windows', async t => {
  const f = await fixture(t);
  f.row.originDeviceId = 'synthetic-remote';
  const file = path.join(f.retentionDir, f.row.id + '.jsonl');
  const raw = JSON.stringify(f.header) + '\n' + JSON.stringify({ type: 'message', id: 'giant', message: {
    role: 'user', content: '逐字保留😀\n'.repeat(90_000) } }) + '\n';
  await fs.writeFile(file, raw); await fs.writeFile(file + '.complete', '');
  const pathname = '/api/sessions/' + f.row.id + '/retained-transcript';
  let cursor, content = '';
  do {
    const result = await f.get(pathname, '?format=raw' + (cursor ? '&cursor=' + cursor : ''));
    assert.equal(result.body.data.state, 'complete');
    assert.ok(Buffer.byteLength(result.body.data.content) <= TRANSCRIPT_LIMITS.entryChunkBytes);
    content += result.body.data.content; cursor = result.body.data.nextCursor;
  } while (cursor);
  assert.equal(content, raw);
});
