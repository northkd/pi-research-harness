import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { registerNativeRuntime, createNativeTransport } from '../native-runtime.mjs';
import { createAutomationSpawner, planAutomationSpawn } from '../automation-spawn.mjs';
import { createSupplementalRuntime } from '../index.mjs';

function nativeFixture() {
  const history = [];
  const requests = [];
  const events = new EventEmitter();
  events.on('flow:list-flows', query => { query.flows = [{ name: 'synthetic-flow' }]; });
  const hooks = new Map();
  const context = { sessionManager: { getSessionId: () => 'synthetic-session', getBranch: () => history } };
  const pi = {
    events, getCommands: () => [],
    on(name, handler) { if (!hooks.has(name)) hooks.set(name, []); hooks.get(name).push(handler); },
    appendEntry(customType, data) { history.push({ type: 'custom', customType, data }); },
  };
  const options = { activateAnthropic: false, getContext: () => context, request: async (pathname, body) => { requests.push({ pathname, body }); return { success: true, data: {} }; } };
  return { pi, options, requests, history, events };
}

test('native event acceptance survives extension reload and forwards original flow completion', async () => {
  const f = nativeFixture();
  let launches = 0;
  f.events.on('flow:run', data => { launches += 1; f.events.emit('flow:flow-started', { flowName: data.flowName }); });
  const first = await registerNativeRuntime(f.pi, f.options);
  const event = { eventId: 'event-one', eventType: 'flow:run', data: { flowName: 'synthetic-flow' } };
  const accepted = await first.consumeEvents([event]);
  assert.equal(accepted[0].status, 'accepted');
  assert.equal(launches, 1);
  first.dispose();
  const second = await registerNativeRuntime(f.pi, f.options);
  const replay = await second.consumeEvents([event]);
  assert.equal(replay[0].duplicate, true);
  assert.equal(launches, 1);
  f.events.emit('flow:complete', { success: true, outputs: { evidence: 'synthetic' } });
  await second.flush();
  assert.ok(f.requests.some(value => value.pathname === '/internal/native/event' && value.body.event.eventType === 'flow_complete'));
  assert.equal(f.requests.filter(value => value.pathname === '/internal/native/event-acknowledge').length, 2);
  second.dispose();
});

test('uncertain native emission stays unresolved and a changed event cannot reuse its identity', async () => {
  const f = nativeFixture();
  let emits = 0;
  f.events.on('flow:run', () => { emits += 1; throw new Error('Synthetic interrupted listener'); });
  const runtime = await registerNativeRuntime(f.pi, f.options);
  const event = { eventId: 'event-unknown', eventType: 'flow:run', data: { flowName: 'synthetic-flow' } };
  assert.equal((await runtime.consumeEvents([event]))[0].status, 'unconfirmed');
  assert.equal((await runtime.consumeEvents([event]))[0].status, 'unconfirmed');
  assert.equal(emits, 1);
  assert.equal(f.requests.filter(value => value.pathname.endsWith('acknowledge')).length, 0);
  await assert.rejects(runtime.consumeEvents([{ ...event, data: { flowName: 'other-flow' } }]), /id-conflict/);
  await assert.rejects(runtime.consumeEvents([{ eventId: 'event-refused', eventType: 'roles:set', data: {} }]), /event-invalid/);
  runtime.dispose();
});

test('native local transport handles split UTF-8 and refuses remote targets before fetch', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ data: '合成材料' }));
  let calls = 0;
  const transport = createNativeTransport({ readAuth: () => ({ baseUrl: 'http://127.0.0.1:18768', token: 'synthetic-token' }), fetchImpl: async (_url, input) => {
    calls += 1;
    assert.equal(input.headers['x-pi-local-token'], 'synthetic-token');
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(bytes.slice(0, 10)); controller.enqueue(bytes.slice(10)); controller.close(); } }));
  } });
  assert.deepEqual(await transport('/internal/native/plugin', {}), { data: '合成材料' });
  await assert.rejects(transport('https://example.com/private', {}), /loopback-required/);
  assert.equal(calls, 1);
});

test('automation spawn reports the deployed compatibility scope and rejects unsupported ACP before spawn', async () => {
  const requested = { cwd: '/tmp/synthetic-project', mode: 'worktree', sandbox: 'read-only', model: 'synthetic/model', pluginRef: { kind: 'automation', automationRun: { runId: 'synthetic-run' } }, lifecycle: { recover: false } };
  const plan = planAutomationSpawn(requested);
  assert.equal(plan.effective.mode, 'local');
  assert.equal(plan.effective.sandbox, null);
  assert.equal(plan.warnings.length, 2);
  const spawns = [];
  const spawn = createAutomationSpawner({ authorizeCwd: () => true, createSession: async input => { spawns.push(input); return { success: true, sessionId: 'synthetic-session' }; } });
  const result = await spawn(requested);
  assert.equal(result.success, true);
  assert.equal(spawns[0].metadata.automationRun.runId, 'synthetic-run');
  assert.equal(spawns[0].metadata.automationScope.effective.mode, 'local');
  const rejected = await spawn({ ...requested, agent: 'unsupported-acp' });
  assert.equal(rejected.success, false);
  assert.match(rejected.message, /acp-agent-unavailable/);
  assert.equal(spawns.length, 1);
  const forbidden = createAutomationSpawner({ authorizeCwd: () => false, createSession: async () => { throw new Error('must not spawn'); } });
  assert.equal((await forbidden(requested)).message, 'automation-cwd-not-authorized');
});

test('supplemental HOME injection isolates global automation discovery and KB config', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-supplemental-home-'));
  const homeDir = path.join(temporary, 'home');
  const dataDir = path.join(temporary, 'state');
  const project = path.join(temporary, 'project');
  await fs.mkdir(project, { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'knowledge_base.json'), JSON.stringify({ sources: [{ kind: 'filesystem', ref: 'synthetic-only-docs' }] }));
  const runtime = await createSupplementalRuntime({ homeDir, dataDir, getSession: () => undefined, listSessions: () => [], knownCwds: () => [project], logger: { info() {}, warn() {}, error() {} } });
  try {
    const url = new URL('http://127.0.0.1/api/kb/config'); url.searchParams.set('cwd', project);
    const config = await runtime.handle({ method: 'GET', pathname: url.pathname, url });
    assert.equal(config.body.config.allSourceSpecs[0].ref, 'synthetic-only-docs');
    assert.equal(config.body.config.cacheDirAbs, path.join(dataDir, 'kb/sources'));
    const listUrl = new URL('http://127.0.0.1/api/plugins/automation/list'); listUrl.searchParams.set('cwd', project);
    const listed = await runtime.handle({ method: 'GET', pathname: listUrl.pathname, url: listUrl });
    assert.deepEqual(listed.body.automations, []);
  } finally { runtime.dispose(); await fs.rm(temporary, { recursive: true, force: true }); }
});
