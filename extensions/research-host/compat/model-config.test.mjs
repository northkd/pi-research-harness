import { randomUUID as releaseFixtureRandomUUID } from 'node:crypto';
const fixtureCredential1 = releaseFixtureRandomUUID();
const fixtureCredential2 = releaseFixtureRandomUUID();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createModelConfigApi, supportedThinkingLevels } from './model-config.mjs';

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'model-config-'));
  fs.chmodSync(root, 0o700);
  const agentDir = path.join(root, 'agent'); fs.mkdirSync(agentDir, { mode: 0o700 });
  const file = name => path.join(agentDir, name);
  const write = (name, value) => fs.writeFileSync(file(name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  write('settings.json', { defaultProvider: 'configured', defaultModel: 'first', defaultThinkingLevel: 'max',
    enabledModels: ['configured/*:high'], extensionOwned: { retain: true } });
  write('auth.json', {});
  const models = [
    { provider: 'configured', id: 'first', name: 'First', reasoning: true, input: ['text', 'image'], contextWindow: 8192, maxTokens: 1024,
      thinkingLevelMap: { xhigh: 'xhigh', max: 'max' }, cost: { input: 1, output: 2 }, apiKey: 'DO_NOT_EXPOSE', headers: { authorization: 'DO_NOT_EXPOSE' } },
    { provider: 'other', id: 'second', reasoning: false, contextWindow: 8192 },
    { provider: 'anthropic', id: 'claude-3-5-haiku-latest', reasoning: false },
    { provider: 'missing', id: 'third' },
  ];
  let reloaded = 0;
  const api = createModelConfigApi({ agentDir, loadRuntime: async () => ({ runtime: { getModels: () => models },
    credentials: { configured: { type: 'api_key', key: 'synthetic-key' }, other: { type: 'oauth', access: 'synthetic-access' },
      anthropic: { type: 'oauth', refresh: 'synthetic-refresh' } }, maxSupported: true }),
    reloadConnectedSessions: () => ++reloaded, ...options });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, agentDir, file, write, api, models, get reloaded() { return reloaded; } };
}
const request = (api, method, route, body) => api.handle({ method, url: new URL(route, 'http://local'), body });

test('legacy global introspection has exact qualified ids, auth exclusions and no scope filter/secrets', async t => {
  const f = fixture(t);
  const result = await request(f.api, 'GET', '/api/models');
  assert.equal(result.statusCode, 200); assert.equal(result.body.object, 'list');
  assert.deepEqual(result.body.data.map(model => model.id), ['configured/first', 'other/second']);
  assert.equal(JSON.stringify(result.body).includes('DO_NOT_EXPOSE'), false);
  assert.equal('name' in result.body.data[0], false);
  assert.deepEqual(result.body.data[0].thinkingLevelMap, { xhigh: 'xhigh', max: 'max' });
  const annotated = (await request(f.api, 'GET', '/api/models?annotated=1')).body.data;
  assert.deepEqual(annotated.map(model => model.excludedReason), [null, null, 'oauth-incompatible', 'no-credential']);
});

test('session picker uses the live native registry then exact global enabledModels matching', async t => {
  let command, refreshed = false;
  const f = fixture(t, { getSession: id => ({ id, live: true }), refreshSessionModelRegistry: async (_row, options) => {
    assert.deepEqual(options, { allowNetwork: false }); refreshed = true;
  }, command: async (_id, value) => {
    assert.equal(refreshed, true);
    command = value; return { success: true, data: { models: f.models } };
  } });
  const selected = await f.api.sessionModels('synthetic-session');
  assert.deepEqual(command, { type: 'get_available_models' });
  assert.equal(selected.type, 'models_list'); assert.equal(selected.sessionId, 'synthetic-session');
  assert.deepEqual(selected.models.map(model => model.id), ['first']);
  assert.equal(selected.models[0].vision, true);
  assert.ok(selected.models[0].supportedThinkingLevels.includes('max'));
  assert.equal(JSON.stringify(selected).includes('DO_NOT_EXPOSE'), false);
  assert.deepEqual(supportedThinkingLevels({ reasoning: true, thinkingLevelMap: { high: null, xhigh: 'xhigh', max: 'max' } }, false), ['off', 'minimal', 'low', 'medium', 'xhigh']);
});

test('typed settings patch preserves unknown keys, rejects stale writes, rejects managed defaults, and reloads only after success', async t => {
  const f = fixture(t);
  const initial = (await request(f.api, 'GET', '/api/pi-settings')).body;
  const result = await request(f.api, 'PUT', '/api/pi-settings', { baseEtag: initial.etag, patch: { enabledModels: ['other/*'], compaction: { enabled: false } } });
  assert.equal(result.statusCode, 200); assert.equal(result.body.reloadedSessions, 1);
  const saved = JSON.parse(fs.readFileSync(f.file('settings.json')));
  assert.deepEqual(saved.extensionOwned, { retain: true }); assert.equal(saved.defaultModel, 'first');
  assert.deepEqual(saved.enabledModels, ['other/*']); assert.equal(saved.compaction.enabled, false);
  assert.equal((await request(f.api, 'PUT', '/api/pi-settings', { baseEtag: initial.etag, patch: { enabledModels: [] } })).statusCode, 409);
  assert.equal((await request(f.api, 'PUT', '/api/pi-settings', { baseEtag: result.body.etag, patch: { defaultModel: 'forbidden' } })).statusCode, 400);
  assert.equal(f.reloaded, 1);
});

test('raw editor validates and restores managed keys using the deployed writer', async t => {
  const f = fixture(t);
  const initial = await f.api.readSettings();
  const result = await request(f.api, 'PUT', '/api/pi-settings/raw', { baseEtag: initial.etag,
    raw: JSON.stringify({ defaultProvider: 'changed', defaultModel: 'changed', defaultThinkingLevel: 'low', quietStartup: true }) });
  assert.equal(result.statusCode, 200);
  assert.deepEqual(result.body.restoredKeys.sort(), ['defaultModel', 'defaultProvider', 'defaultThinkingLevel'].sort());
  assert.equal(result.body.settings.defaultModel, 'first');
  assert.equal(result.body.settings.quietStartup, true);
  assert.equal((await request(f.api, 'PUT', '/api/pi-settings/raw', { baseEtag: result.body.etag, raw: ' '.repeat(256 * 1024) })).statusCode, 413);
});

test('default saves preserve host config and mirror persisted native fields without reloading sessions', async t => {
  const f = fixture(t);
  const defaultsFile = path.join(f.root, 'config.json');
  fs.writeFileSync(defaultsFile, JSON.stringify({ bindHost: '127.0.0.1', keep: true }), { mode: 0o600 });
  const api = createModelConfigApi({ agentDir: f.agentDir, defaultsFile });
  const result = await api.setDefaults({ defaultModel: 'configured/renamed/model', defaultThinkingLevel: 'high' });
  assert.deepEqual(result.piMirror, { ok: true });
  const saved = JSON.parse(fs.readFileSync(f.file('settings.json')));
  assert.equal(saved.defaultProvider, 'configured'); assert.equal(saved.defaultModel, 'renamed/model'); assert.equal(saved.defaultThinkingLevel, 'high');
  assert.equal(JSON.parse(fs.readFileSync(defaultsFile)).keep, true);
  assert.equal((await api.syncDefaults()).statusCode, 200);
  assert.equal(f.reloaded, 0);
});

test('settings/provider read responses redact credentials and malformed raw; raw writes cannot overwrite masked secrets', async t => {
  const f = fixture(t);
  f.write('settings.json', { openaiApiKey: fixtureCredential1, providers: { custom: { apiKey: 'SYNTHETIC_NESTED_SECRET' } }, enabledModels: [] });
  f.write('providers.json', { providers: { custom: { baseUrl: 'https://user:SYNTHETIC_URL_SECRET@example.invalid/v1?token=SYNTHETIC_QUERY_SECRET',
    apiKey: fixtureCredential2, headers: { Authorization: 'SYNTHETIC_HEADER_SECRET' } }, env: { apiKey: '$SYNTHETIC_ENV' } } });
  const settings = await f.api.readSettings();
  const providers = f.api.readProviders();
  for (const value of [settings, providers]) assert.equal(JSON.stringify(value).includes('_SECRET'), false);
  assert.equal(providers.providers.custom.apiKey, '***'); assert.equal(providers.providers.env.apiKey, '$SYNTHETIC_ENV');
  assert.equal((await request(f.api, 'PUT', '/api/pi-settings/raw', { raw: settings.raw, baseEtag: settings.etag })).statusCode, 409);
  fs.writeFileSync(f.file('settings.json'), '{ "apiKey": "SYNTHETIC_BROKEN_SECRET');
  const malformed = await f.api.readSettings();
  assert.equal(malformed.raw, ''); assert.equal(JSON.stringify(malformed).includes('_SECRET'), false);
});

test('auth boundary and migration gates remain explicit for provider/OAuth writes', async t => {
  const f = fixture(t, { authorize: () => false });
  assert.equal((await request(f.api, 'GET', '/api/models')).statusCode, 403);
  assert.equal(await request(f.api, 'PUT', '/api/providers', { providers: {} }), null);
  assert.equal(await request(f.api, 'POST', '/api/provider-auth/start', { provider: 'openai-codex' }), null);
  assert.deepEqual(f.api.migrationGates().externalProviderCatalogues, []);
  assert.equal(f.api.migrationGates().oauthFlowsImplemented, false);
});

test('actual selected Pi SDK loads synthetic native models with read-only credentials and zero fetch', async t => {
  const f = fixture(t);
  f.write('models.json', { providers: { fixture: { api: 'openai-completions', baseUrl: 'http://127.0.0.1:1/v1',
    apiKey: 'synthetic-config-key', models: [{ id: 'fixture-model', name: 'Fixture', reasoning: true, input: ['text'],
      contextWindow: 8192, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } });
  f.write('auth.json', { fixture: { type: 'api_key', key: 'synthetic-auth-key' } });
  const before = fs.readFileSync(f.file('auth.json'), 'utf8');
  let fetched = 0;
  const original = globalThis.fetch;
  globalThis.fetch = async () => { fetched++; throw new Error('No external calls allowed'); };
  t.after(() => { globalThis.fetch = original; });
  const api = createModelConfigApi({ agentDir: f.agentDir, managedInstallRoot: path.join(os.homedir(), '.pi/agent/install') });
  const result = await api.models();
  assert.ok(result.data.some(model => model.id === 'fixture/fixture-model'));
  assert.equal(fetched, 0); assert.equal(fs.readFileSync(f.file('auth.json'), 'utf8'), before);
  assert.equal(fs.existsSync(f.file('models-store.json')), false);
});
