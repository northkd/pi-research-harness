import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { createProviderApi, loadNativeProviderConfigs, applyNativeProviderConfigs } from '../index.mjs';
import { providerFingerprint } from '../native.mjs';
import lockfile from '../upstream/lockfile.mjs';

const key = 'synthetic-local-provider-key';
async function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-api-'));
  fs.chmodSync(root, 0o700);
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir, { mode: 0o700 });
  const configPath = path.join(agentDir, 'providers.json');
  const requests = [], changes = [], notifications = [], apis = [];
  const sockets = new Set();
  const state = { ids: ['first', 'second'], fail: false, slow: false };
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    if (state.slow) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{'); return; }
    if (state.fail) { response.writeHead(401); response.end('key=' + key + '; Authorization: Bearer OTHER_SECRET_12345678; api_key=SECOND_SECRET_12345678'); return; }
    if (request.url.startsWith('/redirect')) { response.writeHead(302, { location: 'http://127.0.0.1:1/forbidden' }); response.end(); return; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(request.url.startsWith('/google') ? { models: state.ids.map(id => ({ name: 'models/' + id, inputTokenLimit: 50000, outputTokenLimit: 4096 })) }
      : { data: state.ids.map(id => ({ id, context_length: 32768, max_completion_tokens: 4096, capabilities: { reasoning: true, vision: true } })) }));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:' + server.address().port;
  const create = extra => {
    const api = createProviderApi({ agentDir, port: 18768,
      fetch: (url, init) => { assert.equal(new URL(url).hostname, '127.0.0.1'); return fetch(url, init); },
      invalidateRegistry: change => changes.push(change), notifySessions: message => notifications.push(message),
      ...options, ...extra }); apis.push(api); return api;
  };
  const api = create();
  t.after(async () => { for (const item of apis) await item.dispose(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const write = value => fs.writeFileSync(configPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return { root, agentDir, configPath, api, create, baseUrl, requests, changes, notifications, state, write };
}
const call = (api, method, pathname, body) => api.handle({ method, url: new URL(pathname, 'http://host'), body });

test('whole-map save has real local probes, durable private config, discovered metadata and runtime invalidation', async t => {
  const f = await fixture(t);
  f.write({ roles: [{ name: 'keep' }], rolePresets: { keep: true }, activePreset: 'keep' });
  const saved = await call(f.api, 'PUT', '/api/providers', { providers: { local: { baseUrl: f.baseUrl + '/v1', apiKey: key, api: 'openai-completions' } } });
  assert.deepEqual(saved, { statusCode: 200, body: { success: true } });
  await f.api.whenIdle();
  const disk = JSON.parse(fs.readFileSync(f.configPath));
  assert.deepEqual(disk.roles, [{ name: 'keep' }]); assert.equal(disk.providers.local.apiKey, key);
  assert.equal(fs.statSync(f.configPath).mode & 0o777, 0o600);
  assert.ok(f.requests.length >= 2); assert.ok(f.requests.every(request => request.headers.authorization === 'Bearer ' + key));
  const got = await call(f.api, 'GET', '/api/providers');
  assert.equal(got.body.providers.local.apiKey, '***'); assert.equal(got.body.health.local.ok, true);
  assert.equal(got.body.health.local.modelCount, 2);
  assert.equal(JSON.stringify(got).includes(key), false);
  const models = f.api.getDiscoveredModels();
  assert.equal(models.length, 2); assert.equal(models[0].contextWindow, 32768); assert.equal(models[0].metadataSource, 'endpoint');
  assert.ok(f.changes.some(change => change.phase === 'configuration'));
  assert.ok(f.changes.some(change => change.phase === 'catalogue' && change.models.length === 2));
  assert.ok(f.notifications.some(message => message.type === 'credentials_updated'));
  assert.equal(fs.statSync(f.api.catalogueFile).mode & 0o777, 0o600);
  assert.equal(fs.readFileSync(f.api.catalogueFile, 'utf8').includes(key), false);
});

test('single-provider PATCH preserves sentinel/omitted fields and encoded names; DELETE prunes exact entry and snapshot', async t => {
  const f = await fixture(t);
  f.write({ roles: { keep: true }, providers: { unrelated: { baseUrl: '', apiKey: '', api: '' } } });
  assert.equal((await call(f.api, 'PATCH', '/api/providers/team%2Flocal', { baseUrl: f.baseUrl + '/v1', apiKey: key, api: 'openai-responses' })).statusCode, 200);
  await f.api.whenIdle();
  assert.equal((await call(f.api, 'PATCH', '/api/providers/team%2Flocal', { apiKey: '***' })).statusCode, 200);
  await f.api.whenIdle();
  let saved = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(saved.providers['team/local'].baseUrl, f.baseUrl + '/v1'); assert.equal(saved.providers['team/local'].apiKey, key);
  assert.equal(saved.roles.keep, true); assert.ok(saved.providers.unrelated);
  assert.equal((await call(f.api, 'DELETE', '/api/providers/team%2Flocal')).statusCode, 200);
  await f.api.whenIdle();
  saved = JSON.parse(fs.readFileSync(f.configPath));
  assert.equal(saved.providers['team/local'], undefined); assert.ok(saved.providers.unrelated);
  assert.equal(f.api.getDiscoveredModels().length, 0);
  const bytes = fs.readFileSync(f.configPath, 'utf8');
  assert.equal((await call(f.api, 'DELETE', '/api/providers/team%2Flocal')).statusCode, 200);
  assert.equal(fs.readFileSync(f.configPath, 'utf8'), bytes);
});

test('test and refresh use saved/env keys, correct Google/Anthropic paths, actual samples and scrub upstream secrets', async t => {
  const f = await fixture(t, { env: { SYNTHETIC_KEY: key } });
  f.write({ providers: { env: { baseUrl: f.baseUrl + '/v1', apiKey: '$SYNTHETIC_KEY', api: 'openai-completions' } } });
  let result = await call(f.api, 'POST', '/api/providers/test', { name: 'env', baseUrl: f.baseUrl + '/v1', apiKey: '***', api: 'openai-completions' });
  assert.equal(result.body.ok, true); assert.deepEqual(result.body.sample, ['first', 'second']);
  assert.equal((await call(f.api, 'GET', '/api/providers')).body.providers.env.apiKeyResolved, true);
  result = await call(f.api, 'POST', '/api/providers/test', { baseUrl: f.baseUrl + '/google', apiKey: key, api: 'google-generative-ai' });
  assert.equal(result.body.ok, true); assert.ok(f.requests.at(-1).url.includes('/google/models?key='));
  result = await call(f.api, 'POST', '/api/providers/test', { baseUrl: f.baseUrl + '/anthropic', apiKey: key, api: 'anthropic-messages' });
  assert.equal(result.body.ok, true); assert.equal(f.requests.at(-1).headers['x-api-key'], key); assert.ok(f.requests.at(-1).url.endsWith('/anthropic/v1/models'));
  f.state.ids = ['refreshed'];
  result = await call(f.api, 'POST', '/api/providers/env/refresh', {});
  await f.api.whenIdle();
  assert.equal(result.body.success, true); assert.equal(result.body.health.modelCount, 1);
  assert.equal(f.api.getDiscoveredModels()[0].id, 'refreshed');
  f.state.fail = true;
  result = await call(f.api, 'POST', '/api/providers/test', { name: 'env', baseUrl: f.baseUrl + '/v1', apiKey: '***', api: 'openai-completions' });
  assert.equal(result.body.ok, false); assert.equal(result.body.status, 401);
  assert.equal(JSON.stringify(result).includes(key), false); assert.equal(JSON.stringify(result).includes('OTHER_SECRET'), false); assert.equal(JSON.stringify(result).includes('SECOND_SECRET'), false);
});

test('corrupt bytes are quarantined exactly and writes refuse without losing role state', async t => {
  const f = await fixture(t);
  const corrupt = '{"roles":["valuable"],"providers":'; f.write(corrupt);
  const read = await call(f.api, 'GET', '/api/providers');
  assert.equal(read.statusCode, 200); assert.deepEqual(read.body.providers, {});
  const write = await call(f.api, 'PATCH', '/api/providers/new', { apiKey: key });
  assert.equal(write.statusCode, 409); assert.equal(fs.readFileSync(f.configPath, 'utf8'), corrupt);
  const copies = fs.readdirSync(f.agentDir).filter(name => name.startsWith('providers.json.corrupt-'));
  assert.equal(copies.length, 1); assert.equal(fs.readFileSync(path.join(f.agentDir, copies[0]), 'utf8'), corrupt);
});

test('invalid shapes, missing sentinels, recursive URLs, symlinks and authorization are refused before effects', async t => {
  const f = await fixture(t);
  assert.equal((await call(f.api, 'PUT', '/api/providers', { providers: [] })).statusCode, 400);
  assert.equal((await call(f.api, 'PATCH', '/api/providers/new', { apiKey: '***' })).statusCode, 400);
  assert.equal((await call(f.api, 'PATCH', '/api/providers/%20', { apiKey: key })).statusCode, 400);
  const recursive = await call(f.api, 'PATCH', '/api/providers/new', { baseUrl: 'http://127.0.0.1:18768/v1', apiKey: key });
  assert.equal(recursive.statusCode, 400); assert.equal(recursive.body.code, 'RECURSIVE_PROXY');
  assert.equal((await call(f.api, 'PATCH', '/api/providers/new', { baseUrl: 'file:///private', apiKey: key })).statusCode, 400);
  assert.equal((await call(f.api, 'PATCH', '/api/providers/new', { baseUrl: 'http://user:secret@127.0.0.1/v1', apiKey: key })).statusCode, 400);
  assert.equal((await call(f.create({ authorize: () => false }), 'GET', '/api/providers')).statusCode, 403);
  const outside = path.join(f.root, 'outside.json'); fs.writeFileSync(outside, '{}'); fs.symlinkSync(outside, f.configPath);
  assert.equal((await call(f.api, 'PATCH', '/api/providers/new', { apiKey: key })).statusCode, 503);
  assert.equal(fs.readFileSync(outside, 'utf8'), '{}'); assert.equal(f.requests.length, 0);
});

test('provider lock prevents concurrent cross-process read-modify-write loss', async t => {
  const f = await fixture(t);
  f.write({ roles: { keep: true }, providers: {} });
  const release = await lockfile.lock(f.configPath, { realpath: false, stale: 30_000 });
  const saving = call(f.api, 'PATCH', '/api/providers/new', { baseUrl: '', apiKey: '', api: '' });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.deepEqual(JSON.parse(fs.readFileSync(f.configPath)).providers, {});
  await release();
  assert.equal((await saving).statusCode, 200); await f.api.whenIdle();
  assert.ok(JSON.parse(fs.readFileSync(f.configPath)).providers.new);
});

test('body timeouts and redirects fail with genuine probe errors and no redirected request', async t => {
  const f = await fixture(t, { probeTimeoutMs: 80 });
  f.state.slow = true;
  const started = Date.now();
  let result = await call(f.api, 'POST', '/api/providers/test', { baseUrl: f.baseUrl, apiKey: key, api: 'openai-completions' });
  assert.equal(result.body.ok, false); assert.ok(Date.now() - started < 3000);
  f.state.slow = false;
  result = await call(f.api, 'POST', '/api/providers/test', { baseUrl: f.baseUrl + '/redirect', apiKey: key, api: 'openai-completions' });
  assert.equal(result.body.ok, false); assert.equal(f.requests.filter(request => request.url.includes('forbidden')).length, 0);
});

test('private snapshot survives host restart, binds saved key/env config and feeds exact native SDK without boot egress', async t => {
  const f = await fixture(t);
  await call(f.api, 'PATCH', '/api/providers/local', { baseUrl: f.baseUrl + '/v1', apiKey: '!literal$key', api: 'openai-completions' });
  await f.api.whenIdle();
  const requestCount = f.requests.length;
  const second = f.create();
  assert.equal(second.getDiscoveredModels().length, 2); assert.equal(f.requests.length, requestCount);
  const modelsDocument = { providers: { local: { models: [{ id: 'first', contextWindow: 64000, maxTokens: 8192, reasoning: false,
    input: ['text'], thinkingLevelMap: { high: null }, compat: { thinkingFormat: 'test' } }] } } };
  fs.writeFileSync(path.join(f.agentDir, 'models.json'), JSON.stringify(modelsDocument), { mode: 0o600 });
  const configs = loadNativeProviderConfigs({ agentDir: f.agentDir });
  assert.equal(configs.local.apiKey, '$!literal$$key'); assert.equal(configs.local.models.length, 2);
  assert.equal(configs.local.models[0].contextWindow, 64000); assert.equal(configs.local.models[0].reasoning, false);
  assert.deepEqual(configs.local.models[0].compat, { thinkingFormat: 'test' });
  const version = fs.readFileSync(path.join(os.homedir(), '.pi/agent/install/current-version'), 'utf8').trim();
  const sdk = await import(pathToFileURL(path.join(os.homedir(), '.pi/agent/install/releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js')));
  const credentials = { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('read-only'); }, delete: async () => { throw new Error('read-only'); } };
  const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  for (const [name, config] of Object.entries(configs)) runtime.registerProvider(name, config);
  assert.equal(runtime.getPhysicalModel('local', 'first').contextWindow, 64000);
  assert.equal(runtime.getPhysicalModel('local', 'second').contextWindow, 32768);
  assert.equal(f.requests.length, requestCount);
  const saved = JSON.parse(fs.readFileSync(f.configPath)); saved.providers.local.apiKey = 'rotated'; f.write(saved);
  assert.equal(second.getDiscoveredModels().length, 0);
  assert.notEqual(providerFingerprint({ apiKey: '$ENV' }, { ENV: 'first' }), providerFingerprint({ apiKey: '$ENV' }, { ENV: 'second' }));
});

test('legacy embedded URL/header credentials are masked on read without contacting the provider', async t => {
  const f = await fixture(t);
  f.write({ providers: { legacy: { baseUrl: 'https://user:URL_CREDENTIAL@example.invalid/v1?api_key=QUERY_CREDENTIAL',
    apiKey: key, headers: { Authorization: 'Bearer HEADER_CREDENTIAL' } } } });
  const result = await call(f.api, 'GET', '/api/providers');
  assert.equal(result.statusCode, 200);
  const text = JSON.stringify(result);
  assert.equal(text.includes('_CREDENTIAL'), false); assert.equal(text.includes(key), false);
  assert.equal(f.requests.length, 0);
});

test('native application unregisters exact stale providers, isolates registration failures and performs local refresh', async () => {
  const registered = new Map([['removed', {}], ['changed', { old: true }]]), calls = [];
  const pi = { unregisterProvider: name => { calls.push(['remove', name]); registered.delete(name); },
    registerProvider: (name, config) => { if (name === 'bad') throw new Error('invalid-provider'); registered.set(name, config); } };
  const ctx = { modelRegistry: { refresh: async options => { assert.deepEqual(options, { allowNetwork: false }); return { aborted: false, errors: new Map() }; } } };
  const result = await applyNativeProviderConfigs({ pi, ctx, previous: new Set(['removed', 'changed']),
    configs: { bad: {}, changed: { new: true }, good: { works: true } } });
  assert.deepEqual(calls, [['remove', 'removed'], ['remove', 'changed']]);
  assert.deepEqual([...result.registered], ['changed', 'good']); assert.equal(result.errors.has('bad'), true);
  assert.equal(registered.has('removed'), false); assert.deepEqual(registered.get('changed'), { new: true });
});
