import { randomUUID as releaseFixtureRandomUUID } from 'node:crypto';
const fixtureCredential1 = releaseFixtureRandomUUID();
const fixtureCredential2 = releaseFixtureRandomUUID();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { createCaddyCutoverTemplate, validateProxyEnvironment } from './proxy.mjs';
import { createHostHttpServer, authenticateRequest, reply } from '../http.mjs';
import { createRealtimeAdapter } from '../compat/realtime/index.mjs';
import { WebSocket } from '../compat/realtime/vendor/ws/wrapper.mjs';

const INDEPENDENT_CADDY = 'research-host/deploy/caddy';
const CADDY = process.env.PI_RESEARCH_TEST_CADDY || (fs.existsSync(INDEPENDENT_CADDY) ? INDEPENDENT_CADDY : 'dashboard-access/caddy');
const TOKEN = fixtureCredential1;
const PASSWORD = fixtureCredential2;
const USER = 'fixture-operator';
const BASIC = 'Basic ' + Buffer.from(USER + ':' + PASSWORD).toString('base64');
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function request(port, target, { method = 'GET', authorization, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const raw = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: target, method,
      headers: { ...(authorization ? { authorization } : {}), ...(raw ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) } : {}), ...headers } }, response => {
      const chunks = []; response.on('data', data => chunks.push(data));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject); req.end(raw);
  });
}

async function unusedPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function until(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await wait(20); }
  assert.fail(message);
}

test('template is restricted to one HTTPS origin and independent loopback upstream', () => {
  const result = createCaddyCutoverTemplate({ publicAddress: 'https://49.51.47.99:8443', frontendRoot: '/synthetic/ui', accessLog: '/synthetic/access.jsonl' });
  assert.equal(result.upstream, '127.0.0.1:18768');
  assert.match(result.template, /basic_auth/); assert.match(result.template, /request>headers delete/); assert.match(result.template, /request>uri delete/);
  assert.match(result.template, /default_sni 49\.51\.47\.99/);
  assert.equal(result.template.includes(TOKEN), false); assert.equal(result.template.includes(PASSWORD), false);
  assert.throws(() => createCaddyCutoverTemplate({ publicAddress: 'http://0.0.0.0:18769', frontendRoot: '/ui', accessLog: '/log', fixture: true }), { code: 'proxy-address-scope-invalid' });
  assert.throws(() => createCaddyCutoverTemplate({ publicAddress: 'http://49.51.47.99:8443', frontendRoot: '/ui', accessLog: '/log' }), { code: 'proxy-address-scope-invalid' });
  assert.throws(() => validateProxyEnvironment({}), { code: 'proxy-credential-environment-invalid' });
  const headless = createCaddyCutoverTemplate({ publicAddress: 'https://49.51.47.99:8443', accessLog: '/synthetic/access.jsonl' });
  assert.equal(headless.headless, true); assert.equal(headless.template.includes('index.html'), false);
  assert.match(headless.template, /rewrite \* \/api\/health/);
});

test('production HTTPS template preserves IP default SNI and parses in the deployed Caddy', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proxy-adapt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { template } = createCaddyCutoverTemplate({ publicAddress: 'https://49.51.47.99:8443', accessLog: path.join(directory, 'access.jsonl') });
  const file = path.join(directory, 'Caddyfile'); fs.writeFileSync(file, template, { mode: 0o600 });
  const output = execFileSync(CADDY, ['adapt', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PI_RESEARCH_UI_USER: USER, PI_RESEARCH_UI_PASSWORD_HASH: '$2a$14$' + 'A'.repeat(53), PI_RESEARCH_HOST_TOKEN: TOKEN } });
  const config = JSON.parse(output), servers = Object.values(config.apps.http.servers);
  assert.equal(servers.some(server => server.tls_connection_policies.some(policy => policy.default_sni === '49.51.47.99')), true);
});

async function verifyProxy(t, headless) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-proxy-fixture-'));
  fs.chmodSync(directory, 0o700);
  const frontendRoot = headless ? undefined : path.join(directory, 'ui');
  if (frontendRoot) {
    fs.mkdirSync(frontendRoot, { mode: 0o700 });
    fs.writeFileSync(path.join(frontendRoot, 'index.html'), '<!doctype html><title>Synthetic Pi UI</title>');
  }
  const upstreamCalls = [], delivered = [], listeners = new Set();
  const row = { id: 'synthetic-session', cwd: directory, status: 'idle', pendingUIRequests: [] };
  const events = [];
  const sessions = {
    getSession: id => id === row.id ? row : undefined,
    readEvents(_id, { after, limit }) { const page = events.filter(entry => entry.sequence > after).slice(0, limit); return { events: page, nextCursor: page.at(-1)?.sequence ?? after, lastSequence: events.length }; },
    subscribeEvents(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    async deliverPrompt(id, body) {
      delivered.push({ id, promptId: body.promptId, text: body.text });
      fs.appendFileSync(path.join(directory, 'accepted.jsonl'), JSON.stringify(delivered.at(-1)) + '\n', { mode: 0o600 });
      events.push({ sequence: events.length + 1, event: { type: 'prompt_received', promptId: body.promptId } });
      for (const listener of listeners) listener(id);
      return { accepted: true };
    },
  };
  let realtime;
  const backend = createHostHttpServer({ token: TOKEN, handle: async ({ pathname, request: req, body }) => {
    upstreamCalls.push({ path: pathname, authorizationPresent: req.headers.authorization !== undefined, token: req.headers['x-pi-local-token'] });
    if (pathname === '/api/ws-ticket') return reply(await realtime.mintTicket(req, body));
    if (pathname === '/api/res-workflow/workbench-sync') return reply({ success: true, fixture: 'same-new-host' });
    if (pathname === '/api/health') return reply({ success: true, fixture: true });
    return reply({ success: true, fixture: 'unexpected-upstream' });
  } });
  realtime = createRealtimeAdapter({ server: backend, sessions, authenticate: req => authenticateRequest(req, TOKEN), authorizeSession: () => true });
  let caddy, socket;
  t.after(async () => {
    socket?.terminate(); realtime.dispose();
    if (caddy && caddy.exitCode === null) {
      caddy.kill('SIGTERM');
      await Promise.race([new Promise(resolve => caddy.once('exit', resolve)), wait(2000)]);
      if (caddy.exitCode === null) caddy.kill('SIGKILL');
    }
    if (backend.listening) await new Promise(resolve => backend.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(0, '127.0.0.1', resolve); });
  const publicPort = await unusedPort(), origin = `http://127.0.0.1:${publicPort}`;
  const accessLog = path.join(directory, 'access.jsonl');
  const generated = createCaddyCutoverTemplate({ publicAddress: origin, upstreamPort: backend.address().port, frontendRoot, accessLog, fixture: true });
  const configFile = path.join(directory, 'Caddyfile'); fs.writeFileSync(configFile, generated.template, { mode: 0o600 });
  const passwordHash = execFileSync(CADDY, ['hash-password', '--plaintext', PASSWORD], { encoding: 'utf8' }).trim();
  const env = { ...process.env, PI_RESEARCH_UI_USER: USER, PI_RESEARCH_UI_PASSWORD_HASH: passwordHash, PI_RESEARCH_HOST_TOKEN: TOKEN,
    XDG_DATA_HOME: path.join(directory, 'data'), XDG_CONFIG_HOME: path.join(directory, 'config') };
  validateProxyEnvironment(env);
  let diagnostics = '';
  caddy = spawn(CADDY, ['run', '--config', configFile, '--adapter', 'caddyfile'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  caddy.stdout.on('data', value => { diagnostics += value.toString(); }); caddy.stderr.on('data', value => { diagnostics += value.toString(); });
  let launchError; caddy.once('error', error => { launchError = error; });
  await until(async () => {
    if (launchError) throw launchError;
    if (caddy.exitCode !== null) throw new Error('fixture-caddy-exited-' + caddy.exitCode);
    try { return (await request(publicPort, '/')).status === 401; } catch { return false; }
  }, 'fixture Caddy became ready');
  assert.equal((await request(publicPort, '/')).status, 401);
  assert.equal((await request(publicPort, '/api/health')).status, 401);
  assert.equal((await request(publicPort, '/api/res-workflow/workbench-sync')).status, 401);
  assert.equal((await request(publicPort, '/internal/native/register')).status, 401);
  assert.equal((await request(publicPort, '/mcp')).status, 401);
  assert.equal((await request(publicPort, '/api/health', { headers: { 'x-pi-local-token': TOKEN } })).status, 401);
  assert.equal((await request(publicPort, '/api/health', { authorization: 'Basic ' + Buffer.from(USER + ':wrong-password').toString('base64') })).status, 401);
  const page = await request(publicPort, '/', { authorization: BASIC }); assert.equal(page.status, 200);
  if (headless) assert.equal(JSON.parse(page.body).fixture, true);
  else assert.match(page.body, /Synthetic Pi UI/);
  const health = await request(publicPort, '/api/health', { authorization: BASIC, headers: { 'x-pi-local-token': 'attacker-supplied-token', 'x-pi-local-proof': 'spoofed-proof' } });
  assert.equal(health.status, 200); assert.equal(upstreamCalls.at(-1).token, TOKEN); assert.equal(upstreamCalls.at(-1).authorizationPresent, false);
  const sync = await request(publicPort, '/api/res-workflow/workbench-sync?cwd=%2Fsynthetic', { authorization: BASIC });
  assert.equal(sync.status, 200); assert.equal(JSON.parse(sync.body).fixture, 'same-new-host');
  const beforeReserved = upstreamCalls.length;
  for (const target of ['/internal', '/internal/native/register', '/mcp', '/mcp/observe', '/mcp/control', '/api/internal/native/event', '/api/../internal/native/register', '/api/%2e%2e/internal/native/register']) {
    assert.equal((await request(publicPort, target, { authorization: BASIC })).status, 404, target);
  }
  assert.equal(upstreamCalls.length, beforeReserved);
  const ticketResponse = await request(publicPort, '/api/ws-ticket', { method: 'POST', authorization: BASIC, headers: { origin }, body: { scope: 'browser' } });
  assert.equal(ticketResponse.status, 200); const ticket = JSON.parse(ticketResponse.body).ticket;
  const deniedWs = new WebSocket(`ws://127.0.0.1:${publicPort}/ws`);
  const deniedStatus = await new Promise((resolve, reject) => { deniedWs.once('unexpected-response', (_req, response) => { response.resume(); deniedWs.terminate(); resolve(response.statusCode); }); deniedWs.once('open', () => reject(new Error('unauthenticated websocket opened'))); deniedWs.on('error', () => {}); });
  assert.equal(deniedStatus, 401);
  const frames = [];
  socket = new WebSocket(`ws://127.0.0.1:${publicPort}/ws?ticket=${ticket}`, { origin, headers: { authorization: BASIC } });
  socket.on('message', bytes => frames.push(JSON.parse(bytes.toString('utf8'))));
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'subscribe', sessionId: row.id }));
  await until(() => frames.some(frame => frame.type === 'session_snapshot'), 'WebSocket replay through proxy');
  socket.send(JSON.stringify({ type: 'send_prompt', sessionId: row.id, requestId: 'proxy-stable-prompt', text: 'Synthetic proxy prompt' }));
  await until(() => frames.some(frame => frame.type === 'prompt_result'), 'WebSocket prompt receipt through proxy');
  assert.equal(delivered.length, 1); assert.equal(JSON.parse(fs.readFileSync(path.join(directory, 'accepted.jsonl'), 'utf8')).promptId, 'proxy-stable-prompt');
  socket.close(); await new Promise(resolve => socket.once('close', resolve));
  await until(() => fs.existsSync(accessLog) && fs.readFileSync(accessLog, 'utf8').includes('"status":200'), 'fixture access log written');
  const logs = fs.readFileSync(accessLog, 'utf8');
  for (const value of [TOKEN, PASSWORD, BASIC, ticket, 'attacker-supplied-token', 'spoofed-proof']) assert.equal(logs.includes(value), false);
  for (const line of logs.trim().split('\n')) {
    const record = JSON.parse(line);
    if (record.request) { assert.equal(Object.hasOwn(record.request, 'headers'), false); assert.equal(Object.hasOwn(record.request, 'uri'), false); }
  }
  assert.equal(fs.statSync(accessLog).mode & 0o777, 0o600);
  assert.equal(diagnostics.includes(TOKEN), false);
}

test('Caddy authenticates UI/API/WS, injects its separate credential, hides private routes and redacts access logs', t => verifyProxy(t, false));
test('headless Caddy preserves authenticated API/WS using real host health without a frontend index', t => verifyProxy(t, true));
