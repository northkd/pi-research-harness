import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createNativeSessionFork, loadManagedSessionManager } from './native-fork.mjs';

const SessionManager = await loadManagedSessionManager();
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-fork-contract-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const history = path.join(directory, 'history'); fs.mkdirSync(history);
  const calls = [];
  const fork = createNativeSessionFork({ loadSessionManager: async () => SessionManager, sessions: {
    createSession: async input => { calls.push(input); return { success: true, sessionId: input.sessionId, sessionFile: input.sessionFile }; },
  } });
  return { directory, cwd, history, calls, fork };
}

test('fork uses the native active branch and labels, preserves parent bytes and records exact lineage', async t => {
  const f = fixture(t);
  const parent = SessionManager.create(f.cwd, f.history);
  const rootEntry = parent.appendMessage({ role: 'user', content: [{ type: 'text', text: 'shared root' }], timestamp: 1 });
  parent.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'abandoned answer' }], timestamp: 2 });
  parent.branch(rootEntry);
  parent.appendMessage({ role: 'user', content: [{ type: 'text', text: 'active branch' }], timestamp: 3 });
  parent.appendLabelChange(rootEntry, 'saved-label');
  const source = parent.getSessionFile();
  const before = fs.readFileSync(source);
  const result = await f.fork({ id: parent.getSessionId(), cwd: f.cwd, sessionFile: source, name: 'Original name' });
  assert.notEqual(result.sessionId, parent.getSessionId());
  assert.notEqual(result.sessionFile, source);
  assert.deepEqual(fs.readFileSync(source), before);
  const branch = SessionManager.open(result.sessionFile);
  assert.equal(branch.getHeader().parentSession, source);
  assert.equal(branch.getCwd(), f.cwd);
  const messages = branch.getEntries().filter(entry => entry.type === 'message').map(entry => entry.message.content[0].text);
  assert.deepEqual(messages, ['shared root', 'active branch']);
  assert.equal(branch.getLabel(rootEntry), 'saved-label');
  assert.equal(f.calls[0].metadata.parentSessionId, parent.getSessionId());
  assert.equal(f.calls[0].metadata.parentSessionFile, source);
  assert.equal(f.calls[0].metadata.researchSession, undefined);
  assert.equal(fs.statSync(result.sessionFile).mode & 0o777, 0o600);
});

test('older native histories migrate inside the private snapshot while parent file remains byte identical', async t => {
  const f = fixture(t), source = path.join(f.history, 'legacy-file.jsonl');
  const entries = [
    { type: 'session', version: 1, id: 'legacy-native-header-id', cwd: f.cwd, timestamp: '2026-01-01T00:00:00.000Z' },
    { type: 'message', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'user', content: 'Legacy message', timestamp: 1 } },
  ];
  fs.writeFileSync(source, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  const before = fs.readFileSync(source);
  const result = await f.fork({ id: entries[0].id, cwd: f.cwd, sessionFile: source });
  assert.deepEqual(fs.readFileSync(source), before);
  const branch = SessionManager.open(result.sessionFile);
  assert.equal(branch.getHeader().version, 3);
  assert.equal(branch.getHeader().parentSession, source);
  assert.equal(branch.getEntries()[0].message.content, 'Legacy message');
  assert.equal(typeof branch.getEntries()[0].id, 'string');
});

test('header-only histories fork to a distinct persisted native session with real parent provenance', async t => {
  const f = fixture(t), source = path.join(f.history, 'empty-conversation.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'session', version: 3, id: 'source-empty', cwd: f.cwd, timestamp: '2026-01-01T00:00:00.000Z' }) + '\n', { mode: 0o600 });
  const result = await f.fork({ id: 'source-empty', cwd: f.cwd, sessionFile: source });
  const branch = SessionManager.open(result.sessionFile);
  assert.notEqual(branch.getSessionId(), 'source-empty');
  assert.equal(branch.getHeader().parentSession, source);
  assert.deepEqual(branch.getEntries(), []);
});

test('managed assignments and unsafe source aliases are refused before a worker is requested', async t => {
  const f = fixture(t);
  await assert.rejects(f.fork({ id: 'managed', researchSession: { spawnToken: 'old-task', readOnly: true } }), { code: 'research-session-fork-assignment-required' });
  const source = path.join(f.history, 'source.jsonl');
  fs.writeFileSync(source, JSON.stringify({ type: 'session', version: 3, id: 'source', cwd: f.cwd }) + '\n');
  const alias = path.join(f.history, 'alias.jsonl'); fs.symlinkSync(source, alias);
  await assert.rejects(f.fork({ id: 'source', cwd: f.cwd, sessionFile: alias }), { code: 'session-fork-source-unsafe' });
  assert.equal(f.calls.length, 0);
});
