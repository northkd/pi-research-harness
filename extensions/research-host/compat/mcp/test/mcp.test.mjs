import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createMcpCompatibility, AuthFailureThrottle, MODERN_PROTOCOL_VERSION, META_VERSION_KEY } from '../index.mjs';

function fixture(t, extra = {}) {
  const rows = [{ id: 'caller', cwd: '/synthetic/project', status: 'idle', startedAt: 100 }, { id: 'other', cwd: '/synthetic/project', status: 'active', startedAt: 200 }];
  const calls = [];
  const listeners = new Set();
  const api = createMcpCompatibility({
    getSession: id => rows.find(row => row.id === id), listSessions: () => rows,
    sendPrompt: async (...args) => { calls.push(['prompt', ...args]); return true; },
    spawnSession: async (...args) => { calls.push(['spawn', ...args]); return { success: true, sessionId: 'new-session' }; },
    abortSession: async (...args) => { calls.push(['abort', ...args]); return false; },
    hasRoute: (method, path) => method === 'GET' && path === '/api/file' || method === 'POST' && path === '/api/session/:id/lifecycle',
    invokeRoute: async (input, caller, request) => { calls.push(['route', input, caller, request]); return { statusCode: 200, body: { success: true, data: { actual: true } } }; },
    onEvent: handler => { listeners.add(handler); return () => listeners.delete(handler); },
    ...extra,
  });
  t.after(() => api.dispose());
  const token = api.mintForSession('caller');
  const call = (method = 'tools/list', params = {}, changes = {}) => api.handle({ method: 'POST', pathname: '/mcp', headers: { authorization: `Bearer ${token}` }, remoteAddress: '127.0.0.1', body: { jsonrpc: '2.0', id: 1, method, params }, ...changes });
  const modern = (method, params = {}, changes = {}) => call(method, { ...params, _meta: { [META_VERSION_KEY]: MODERN_PROTOCOL_VERSION } }, { headers: { authorization: `Bearer ${token}`, 'mcp-protocol-version': MODERN_PROTOCOL_VERSION }, ...changes });
  return { api, rows, calls, listeners, token, call, modern, emit(sessionId, event) { for (const listener of listeners) listener(sessionId, event); } };
}

test('MCP requires a bearer on every request, including local and cookie-authenticated callers', async t => {
  const f = fixture(t);
  assert.equal((await f.call('tools/list', {}, { headers: {} })).statusCode, 401);
  assert.equal((await f.call('tools/list', {}, { headers: { cookie: 'session=trusted', 'x-pi-local-token': f.token } })).statusCode, 401);
  assert.equal((await f.call('tools/list', {}, { headers: { authorization: ['Bearer ' + f.token] } })).statusCode, 401);
  assert.equal((await f.call()).statusCode, 200);
  f.api.revokeSession('caller');
  assert.equal((await f.call()).statusCode, 401);
});

test('only implemented nondelisted roads and actual handlers are advertised', async t => {
  const f = fixture(t);
  const result = await f.call();
  const names = result.body.result.tools.map(tool => tool.name);
  assert.deepEqual(new Set(names), new Set(['list_sessions', 'send_prompt', 'spawn_session', 'abort', 'file_read', 'stop_after_turn', 'retry_session']));
  assert.ok(result.body.result.tools.every(tool => !('bind' in tool)));
  assert.ok(f.api.surface().omitted.some(tool => tool.name === 'file_write'));
  assert.equal((await f.call('tools/call', { name: 'file_write', arguments: { path: '/tmp/out', content: 'x' } })).statusCode, 404);
  assert.equal((await f.call('tools/call', { name: 'grant_response', arguments: {} })).statusCode, 404);
  assert.equal(f.calls.length, 0);
});

test('legacy initialization and fresh uninitialized requests share the same tool surface', async t => {
  const f = fixture(t);
  const initialized = await f.call('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'synthetic', version: '1' } });
  assert.equal(initialized.body.result.protocolVersion, '2025-11-25');
  assert.match(initialized.headers['Mcp-Session-Id'], /^[a-f0-9]{32}$/);
  assert.deepEqual(initialized.body.result.capabilities, { tools: { listChanged: false } });
  assert.equal((await f.call('ping')).statusCode, 200);
  const notification = await f.call('notifications/initialized');
  assert.equal(notification.statusCode, 202);
  assert.equal(notification.empty, true);
  assert.equal(notification.body, null);
  assert.ok((await f.call()).body.result.tools.length > 0);
});

test('modern revision enforces exact header/meta agreement and refuses removed handshake', async t => {
  const f = fixture(t);
  assert.equal((await f.modern('server/discover')).body.result.protocolVersions.includes(MODERN_PROTOCOL_VERSION), true);
  const missingMeta = await f.call('tools/list', {}, { headers: { authorization: `Bearer ${f.token}`, 'mcp-protocol-version': MODERN_PROTOCOL_VERSION } });
  assert.equal(missingMeta.statusCode, 400);
  assert.equal(missingMeta.body.error.data.type, 'MissingProtocolVersion');
  const mismatch = await f.call('tools/list', { _meta: { [META_VERSION_KEY]: '2025-11-25' } }, { headers: { authorization: `Bearer ${f.token}`, 'mcp-protocol-version': MODERN_PROTOCOL_VERSION } });
  assert.equal(mismatch.body.error.data.type, 'HeaderMismatch');
  const repeated = await f.modern('tools/list', {}, { headers: { authorization: `Bearer ${f.token}`, 'mcp-protocol-version': MODERN_PROTOCOL_VERSION + ',' + MODERN_PROTOCOL_VERSION } });
  assert.equal(repeated.body.error.data.type, 'AmbiguousHeader');
  const removed = await f.call('initialize', { protocolVersion: MODERN_PROTOCOL_VERSION });
  assert.equal(removed.statusCode, 404);
  assert.equal(removed.body.error.code, -32601);
});

test('observe and control roads cap existing credentials and preserve scope challenges', async t => {
  const f = fixture(t);
  const list = await f.call('tools/list', {}, { pathname: '/mcp/observe' });
  assert.deepEqual(new Set(list.body.result.tools.map(tool => tool.name)), new Set(['list_sessions', 'file_read']));
  const denied = await f.call('tools/call', { name: 'send_prompt', arguments: { sessionId: 'other', text: 'synthetic prompt' } }, { pathname: '/mcp/observe' });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.body.error.code, -32001);
  assert.match(denied.headers['WWW-Authenticate'], /insufficient_scope.*control/);
  assert.equal(f.calls.length, 0);
  assert.equal((await f.call('tools/list', {}, { pathname: '/mcp/operate' })).statusCode, 404);
  assert.equal((await f.call('tools/list', {}, { method: 'GET' })).headers.Allow, 'POST');
});

test('minted session identity prevents self control and keeps failed abort results truthful', async t => {
  const f = fixture(t);
  for (const sessionId of ['caller', ' CALLER ', '"caller"']) {
    const denied = await f.call('tools/call', { name: 'send_prompt', arguments: { sessionId, text: '/synthetic-command' } });
    assert.equal(denied.statusCode, 403);
    assert.equal(denied.body.error.data.type, 'SelfTargetRefused');
  }
  assert.equal(f.calls.length, 0);
  const delivered = await f.call('tools/call', { name: 'send_prompt', arguments: { sessionId: 'other', text: 'synthetic prompt' } });
  assert.deepEqual(JSON.parse(delivered.body.result.content[0].text), { delivered: true });
  const aborted = await f.call('tools/call', { name: 'abort', arguments: { sessionId: 'other' } });
  assert.deepEqual(JSON.parse(aborted.body.result.content[0].text), { aborted: false });
  f.rows[0].status = 'ended';
  assert.equal((await f.call()).statusCode, 401);
  assert.throws(() => f.api.mintForSession('caller'), /unavailable/);
});

test('REST tools bind real routes, preserve fixed actions and never report a failed road as success', async t => {
  const f = fixture(t);
  const result = await f.call('tools/call', { name: 'stop_after_turn', arguments: { sessionId: 'other', action: 'force_kill' } });
  assert.equal(result.statusCode, 200);
  assert.equal(f.calls[0][1].url, '/api/session/other/lifecycle');
  assert.equal(f.calls[0][1].payload.action, 'stop_after_turn');
  const malformed = await f.call('tools/call', { name: 'stop_after_turn', arguments: { sessionId: '../other' } });
  assert.equal(malformed.statusCode, 400);
  assert.equal(f.calls.length, 1);
  const unavailable = fixture(t, { invokeRoute: async () => ({ statusCode: 409, body: { success: false, error: 'session-disconnected' } }) });
  const failed = await unavailable.call('tools/call', { name: 'file_read', arguments: { path: 'synthetic.md' } });
  assert.equal(failed.body.result.isError, true);
  assert.match(failed.body.result.content[0].text, /session-disconnected/);
});

test('session list is bounded and a cursor cannot change filters', async t => {
  const f = fixture(t);
  const first = await f.call('tools/call', { name: 'list_sessions', arguments: { limit: 1 } });
  const page = JSON.parse(first.body.result.content[0].text);
  assert.equal(page.sessions.length, 1);
  assert.equal(page.total, 2);
  const changed = await f.call('tools/call', { name: 'list_sessions', arguments: { limit: 2, cursor: page.nextCursor } });
  assert.equal(changed.statusCode, 400);
  const zero = await f.call('tools/call', { name: 'list_sessions', arguments: { limit: 0 } });
  assert.equal(zero.statusCode, 400);
});

test('malformed bodies, missing methods and oversized input keep JSON-RPC error shapes', async t => {
  const f = fixture(t);
  assert.equal((await f.call('anything')).body.error.code, -32601);
  assert.equal((await f.call('', {}, { body: {} })).body.error.code, -32600);
  assert.equal((await f.call('', {}, { parseError: true })).body.error.code, -32700);
  const large = await f.call('tools/list', { huge: 'x'.repeat(1024 * 1024) });
  assert.equal(large.statusCode, 413);
  assert.equal(large.body.error.code, -32700);
});

test('failed authentication throttles the credential and healthy credentials stay usable', async t => {
  const f = fixture(t, { throttle: new AuthFailureThrottle(2, 60000, 60000, 100, 100) });
  const changes = { headers: { authorization: 'Bearer synthetic-invalid' } };
  assert.equal((await f.call('tools/list', {}, changes)).statusCode, 401);
  assert.equal((await f.call('tools/list', {}, changes)).statusCode, 401);
  assert.equal((await f.call('tools/list', {}, changes)).statusCode, 429);
  assert.equal((await f.call()).statusCode, 200);
});

test('device credentials require identity-aware routing and keep the originating bearer', async t => {
  const verifyDeviceTokenTier = token => token === 'synthetic-device' ? { id: 'paired-device', tier: 'observe' } : null;
  const unsafe = fixture(t, { verifyDeviceTokenTier });
  const headers = { authorization: 'Bearer synthetic-device', 'x-forwarded-for': '198.51.100.2' };
  assert.equal((await unsafe.call('tools/list', {}, { headers })).statusCode, 401);
  const calls = [];
  const scoped = fixture(t, { verifyDeviceTokenTier, invokeForDevice: async (...args) => { calls.push(args); return { statusCode: 200, body: { actual: true } }; } });
  const list = await scoped.call('tools/list', {}, { headers });
  assert.deepEqual(list.body.result.tools.map(tool => tool.name), ['file_read']);
  const read = await scoped.call('tools/call', { name: 'file_read', arguments: { path: 'synthetic.md' } }, { headers, remoteAddress: '198.51.100.2' });
  assert.equal(read.statusCode, 200);
  assert.equal(calls[0][0].headers.authorization, 'Bearer synthetic-device');
  assert.equal(calls[0][0].remoteAddress, '198.51.100.2');
  assert.equal(calls[0][1].kind, 'device');
});

test('modern NDJSON subscriptions filter sessions and close when the bearer is revoked', async t => {
  const f = fixture(t);
  const response = await f.modern('subscriptions/listen', { sessionIds: ['other'] });
  assert.equal(typeof response.stream, 'function');
  const rawRequest = new EventEmitter();
  const rawResponse = new EventEmitter();
  const chunks = [];
  let ended = 0;
  rawResponse.writeHead = (status, headers) => { assert.equal(status, 200); assert.equal(headers['Content-Type'], 'application/x-ndjson'); };
  rawResponse.flushHeaders = () => {};
  rawResponse.write = chunk => { chunks.push(JSON.parse(chunk)); return true; };
  rawResponse.end = () => { ended += 1; };
  response.stream(rawRequest, rawResponse);
  assert.equal(f.listeners.size, 1);
  f.emit('caller', { hidden: true });
  assert.equal(chunks.length, 0);
  f.emit('other', { type: 'synthetic-progress' });
  assert.deepEqual(chunks[0], { sessionId: 'other', payload: { type: 'synthetic-progress' } });
  f.api.revokeSession('caller');
  f.emit('other', { type: 'must-not-deliver' });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[1].error, 'stream terminated');
  assert.equal(ended, 1);
  assert.equal(f.listeners.size, 0);
});
