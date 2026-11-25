import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Duplex } from 'node:stream';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRealtimeAdapter } from './index.mjs';
import { createSessionJournal, readSessionJournal } from '../../session-host/journal.mjs';

class MemorySocket extends Duplex {
  constructor() { super(); this.remoteAddress = '127.0.0.1'; this.output = []; }
  _read() {}
  _write(chunk, _encoding, callback) { this.output.push(Buffer.from(chunk)); callback(); }
  setTimeout() { return this; }
  setNoDelay() { return this; }
  setKeepAlive() { return this; }
  get bytes() { return Buffer.concat(this.output); }
  get headers() { return this.bytes.toString('utf8').split('\r\n\r\n', 1)[0]; }
  get messages() {
    const bytes = this.bytes, result = [];
    let offset = bytes.indexOf('\r\n\r\n') + 4;
    if (offset < 4) return result;
    while (offset + 2 <= bytes.length) {
      const opcode = bytes[offset] & 15;
      let size = bytes[offset + 1] & 127, header = 2;
      if (size === 126) { if (offset + 4 > bytes.length) break; size = bytes.readUInt16BE(offset + 2); header = 4; }
      else if (size === 127) { if (offset + 10 > bytes.length) break; size = Number(bytes.readBigUInt64BE(offset + 2)); header = 10; }
      if (offset + header + size > bytes.length) break;
      if (opcode === 1) result.push(JSON.parse(bytes.subarray(offset + header, offset + header + size).toString('utf8')));
      offset += header + size;
    }
    return result;
  }
  send(value) {
    const body = Buffer.from(JSON.stringify(value)), mask = Buffer.from([11, 22, 33, 44]);
    let header;
    if (body.length < 126) header = Buffer.from([0x81, 0x80 | body.length]);
    else if (body.length < 65536) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0xfe; header.writeUInt16BE(body.length, 2); }
    else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0xff; header.writeBigUInt64BE(BigInt(body.length), 2); }
    const payload = Buffer.from(body);
    for (let index = 0; index < payload.length; index++) payload[index] ^= mask[index % mask.length];
    this.push(Buffer.concat([header, mask, payload]));
  }
}

const pause = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await pause(); }
  assert.fail('expected asynchronous fixture result');
}

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-realtime-test-'));
  const journals = new Map(), listeners = new Set(), rows = new Map(), sockets = [];
  const deliveries = [], responses = [], diagnostics = [];
  let allowed = true, tick = 0;
  const sessions = {
    getSession: id => rows.get(id),
    readEvents: (id, query) => readSessionJournal(path.join(directory, id), query),
    subscribeEvents(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    async deliverPrompt(sessionId, body) {
      deliveries.push({ sessionId, ...body });
      append(sessionId, { type: 'prompt_received', promptId: body.promptId });
      return { accepted: true };
    },
    async respondUI(sessionId, body) {
      const row = rows.get(sessionId), pending = row.pendingUIRequests.find(item => item.id === body.id);
      if (!pending) throw new Error('session-ui-request-not-pending');
      responses.push({ sessionId, ...body }); row.pendingUIRequests = row.pendingUIRequests.filter(item => item.id !== body.id);
      append(sessionId, { type: 'extension_ui_resolved', id: body.id });
      return { accepted: true };
    },
    async abort(sessionId) { append(sessionId, { type: 'agent_settled', reason: 'aborted' }); return { success: true }; },
  };
  function add(id, owner) {
    rows.set(id, { id, cwd: '/synthetic-project', status: 'idle', pendingUIRequests: [], principalOwner: owner });
    journals.set(id, createSessionJournal(path.join(directory, id)));
    return rows.get(id);
  }
  function append(id, event) {
    const record = journals.get(id).append(event);
    rows.get(id).eventCursor = record.sequence;
    if (event.type === 'extension_ui_request') rows.get(id).pendingUIRequests.push(event);
    for (const handler of listeners) handler(id, event);
    return record;
  }
  const server = createServer();
  const authenticate = request => request.socket.remoteAddress === '127.0.0.1' && request.headers['x-pi-local-token'] === 'synthetic-token';
  const args = { server, authenticate, sessions, onError: code => diagnostics.push(code), now: () => tick, limits: { pageEntries: 2, pagesPerTurn: 1 }, ...options };
  if (!options.defaultAdmission) args.authorizeSession = () => allowed;
  delete args.defaultAdmission;
  let adapter = createRealtimeAdapter(args);
  function request(url = '/ws', headers = {}) {
    const socket = new MemorySocket(); sockets.push(socket);
    return { url, method: 'GET', socket, headers: { host: '127.0.0.1:8000', upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', 'sec-websocket-version': '13', ...headers } };
  }
  async function connect(url = '/ws', headers = { 'x-pi-local-token': 'synthetic-token' }) {
    const req = request(url, headers);
    server.emit('upgrade', req, req.socket, Buffer.alloc(0));
    await until(() => req.socket.headers.includes('HTTP/1.1'));
    if (req.socket.headers.includes('101 Switching Protocols')) await until(() => req.socket.messages.some(item => item.type === 'host_capabilities'));
    return req.socket;
  }
  t.after(() => { adapter.dispose(); for (const socket of sockets) socket.destroy(); for (const journal of journals.values()) journal.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { directory, rows, deliveries, responses, diagnostics, add, append, connect, request, sessions, server,
    get adapter() { return adapter; }, setAllowed(value) { allowed = value; }, advance(ms) { tick += ms; },
    restart() { adapter.dispose(); for (const socket of sockets) socket.destroy(); adapter = createRealtimeAdapter(args); },
  };
}

test('actual vendored WebSocket handshake rejects missing token and cross-origin upgrades', async t => {
  const f = fixture(t);
  assert.match((await f.connect('/ws', {})).headers, /401 Unauthorized/);
  assert.match((await f.connect('/ws', { 'x-pi-local-token': 'synthetic-token', origin: 'https://other.invalid' })).headers, /401 Unauthorized/);
  const socket = await f.connect();
  assert.match(socket.headers, /101 Switching Protocols/);
  assert.equal(socket.messages[0].protocol, 'pi-research-realtime.v1');
});

test('short-lived browser tickets preserve origin and are single-use', async t => {
  const f = fixture(t);
  const headers = { 'x-pi-local-token': 'synthetic-token', origin: 'http://127.0.0.1:8000' };
  const grant = await f.adapter.mintTicket(f.request('/api/ws-ticket', headers), { scope: 'browser' });
  assert.match((await f.connect('/ws?ticket=' + grant.ticket, { origin: headers.origin })).headers, /101 Switching Protocols/);
  assert.match((await f.connect('/ws?ticket=' + grant.ticket, { origin: headers.origin })).headers, /401 Unauthorized/);
  const expired = await f.adapter.mintTicket(f.request('/api/ws-ticket', headers), { scope: 'browser' });
  f.advance(30_001);
  assert.match((await f.connect('/ws?ticket=' + expired.ticket, { origin: headers.origin })).headers, /401 Unauthorized/);
  await assert.rejects(f.adapter.mintTicket(f.request('/api/ws-ticket'), { scope: 'browser' }), { code: 'research-host-auth-required' });
});

test('durable replay is ordered, continues over bounded pages, and switches to live events', async t => {
  const f = fixture(t); f.add('one');
  for (let index = 0; index < 5; index++) f.append('one', { type: 'message_update', text: 'synthetic-' + index });
  const socket = await f.connect(); socket.send({ type: 'subscribe', sessionId: 'one', lastSeq: 1 });
  await until(() => socket.messages.some(item => item.type === 'session_snapshot'));
  const replay = socket.messages.filter(item => item.type === 'event_replay');
  assert.deepEqual(replay.flatMap(item => item.events.map(record => record.seq)), [2, 3, 4, 5]);
  assert.equal(replay.at(-1).isLast, true);
  f.append('one', { type: 'agent_settled' });
  await until(() => socket.messages.some(item => item.type === 'event' && item.seq === 6));
  socket.send({ type: 'unsubscribe', sessionId: 'one' }); await pause(); await pause();
  f.append('one', { type: 'message_update', text: 'after unsubscribe' });
  await pause(); await pause();
  assert.equal(socket.messages.some(item => item.type === 'event' && item.seq === 7), false);
});

test('a host restart replays the same journal from the client last sequence', async t => {
  const f = fixture(t); f.add('one');
  f.append('one', { type: 'agent_start' }); f.append('one', { type: 'message_end' });
  const first = await f.connect(); first.send({ type: 'subscribe', sessionId: 'one' });
  await until(() => first.messages.some(item => item.type === 'session_snapshot'));
  f.restart(); f.append('one', { type: 'agent_settled' });
  const second = await f.connect(); second.send({ type: 'subscribe', sessionId: 'one', lastSeq: 2 });
  await until(() => second.messages.some(item => item.type === 'session_snapshot'));
  assert.deepEqual(second.messages.filter(item => item.type === 'event_replay').flatMap(item => item.events.map(record => record.seq)), [3]);
});

test('authoritative admission is rechecked on replay and on a prompt write', async t => {
  const f = fixture(t); f.add('one');
  const socket = await f.connect(); socket.send({ type: 'subscribe', sessionId: 'one' });
  await until(() => socket.messages.some(item => item.type === 'session_snapshot'));
  f.setAllowed(false); f.append('one', { type: 'message_end', text: 'private result' });
  await until(() => socket.messages.some(item => item.code === 'realtime-session-not-found'));
  assert.equal(socket.messages.some(item => item.type === 'event' && item.event.text === 'private result'), false);
  socket.send({ type: 'send_prompt', sessionId: 'one', text: 'denied' });
  await pause(); await pause();
  assert.equal(f.deliveries.length, 0);
});

test('default scope rejects named foreign owners and remote session histories', async t => {
  const f = fixture(t, { defaultAdmission: true });
  f.add('foreign', { iss: 'named-realm', sub: 'someone-else' });
  f.add('remote'); f.rows.get('remote').originDeviceId = 'other-device';
  const socket = await f.connect();
  socket.send({ type: 'subscribe', sessionId: 'foreign' }); socket.send({ type: 'subscribe', sessionId: 'remote' });
  await until(() => socket.messages.filter(item => item.code === 'realtime-session-not-found').length === 2);
  assert.equal(socket.messages.some(item => item.type === 'session_snapshot'), false);
});

test('prompt acceptance preserves stable identity and explicit delivery mode', async t => {
  const f = fixture(t); f.add('one');
  const socket = await f.connect();
  socket.send({ type: 'send_prompt', sessionId: 'one', requestId: 'stable-request', text: 'Synthetic prompt', delivery: 'followUp' });
  await until(() => socket.messages.some(item => item.type === 'prompt_result'));
  assert.equal(f.deliveries[0].promptId, 'stable-request'); assert.equal(f.deliveries[0].delivery, 'followUp');
  assert.equal(socket.messages.find(item => item.type === 'prompt_result').accepted, true);
});

test('exact pending native confirmation IDs survive replay and accept one real answer', async t => {
  const f = fixture(t); f.add('one');
  f.append('one', { type: 'extension_ui_request', id: 'confirmed-id', method: 'confirm', title: 'Synthetic approval' });
  const socket = await f.connect(); socket.send({ type: 'subscribe', sessionId: 'one' });
  await until(() => socket.messages.some(item => item.type === 'extension_ui_request'));
  assert.equal(socket.messages.find(item => item.type === 'extension_ui_request').requestId, 'confirmed-id');
  socket.send({ type: 'extension_ui_response', sessionId: 'one', requestId: 'wrong-id', result: true });
  await until(() => socket.messages.some(item => item.code === 'session-ui-request-not-pending'));
  assert.equal(f.responses.length, 0);
  socket.send({ type: 'extension_ui_response', sessionId: 'one', requestId: 'confirmed-id', result: true });
  await until(() => socket.messages.some(item => item.type === 'extension_ui_response_result'));
  assert.deepEqual(f.responses[0], { sessionId: 'one', type: 'extension_ui_response', id: 'confirmed-id', confirmed: true });
  socket.send({ type: 'extension_ui_response', sessionId: 'one', requestId: 'confirmed-id', result: true });
  await pause(); await pause(); assert.equal(f.responses.length, 1);
});

test('future cursors and unknown controls fail explicitly', async t => {
  const f = fixture(t); f.add('one');
  const socket = await f.connect(); socket.send({ type: 'subscribe', sessionId: 'one', lastSeq: 100 });
  await until(() => socket.messages.some(item => item.code === 'realtime-cursor-ahead-of-history'));
  socket.send({ type: 'force_kill', sessionId: 'one' });
  await until(() => socket.messages.some(item => item.code === 'realtime-message-unsupported'));
});

test('large native events retain their real content and replay frames split at the byte budget', async t => {
  const f = fixture(t, { limits: { pageEntries: 10, replayBytes: 256, pagesPerTurn: 1 } }); f.add('one');
  const text = 'synthetic '.repeat(200_000);
  f.append('one', { type: 'message_end', text }); f.append('one', { type: 'agent_settled' });
  const socket = await f.connect(); socket.send({ type: 'subscribe', sessionId: 'one' });
  await until(() => socket.messages.some(item => item.type === 'session_snapshot'));
  const frames = socket.messages.filter(item => item.type === 'event_replay');
  assert.equal(frames.length, 2); assert.equal(frames[0].events[0].event.text, text);
  assert.equal(frames[1].isLast, true);
});

test('extra feature handlers share a stable native socket context and disconnect cleanup', async t => {
  const received = [], disconnected = [];
  const f = fixture(t, {
    handleExtraMessage(message, context) {
      if (message.type !== 'fixture_subscribe') return false;
      received.push(context.socket);
      assert.equal(context.socket.readyState, 1);
      context.socket.send(JSON.stringify({ type: 'fixture_state', subscriptionId: message.subscriptionId }));
      return true;
    },
    onDisconnect(context) { disconnected.push(context.socket); },
  });
  const socket = await f.connect(); socket.send({ type: 'fixture_subscribe', subscriptionId: 'fixture' });
  await until(() => socket.messages.some(item => item.type === 'fixture_state' && item.subscriptionId === 'fixture'));
  socket.destroy(); await until(() => disconnected.length === 1);
  assert.equal(disconnected[0], received[0]);
});
