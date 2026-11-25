import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSupplementalRuntime, getBillingReport, createGoalStore, createGoalSupervisor } from '../index.mjs';

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-supplemental-'));
const originalHome = process.env.HOME;
const originalDirectory = process.env.PI_RESEARCH_HOST_DIR;
process.env.HOME = temporary;
process.env.PI_RESEARCH_HOST_DIR = path.join(temporary, '.pi', 'research-host');
const project = path.join(temporary, 'project');
await fs.mkdir(project, { recursive: true });
const sessions = [{ id: 'main', cwd: project, status: 'idle', cost: 1.5 }];
const sent = [];
const emitted = [];
const spawned = [];
const runtime = await createSupplementalRuntime({
  getSession: id => sessions.find(session => session.id === id),
  listSessions: () => sessions,
  knownCwds: () => [project],
  assignSessionRef: (id, values) => Object.assign(sessions.find(session => session.id === id), values),
  renameSession: (id, name) => { sessions.find(session => session.id === id).name = name; },
  sendToSession: (id, text) => { sent.push({ id, text }); return true; },
  spawnSession: async input => {
    spawned.push(input);
    const id = 'automatic-' + spawned.length;
    sessions.push({ id, cwd: input.cwd, status: 'idle', ...input.pluginRef });
    return { success: true, spawnToken: 'synthetic-spawn-' + spawned.length };
  },
  emitEventToSession: (id, type, data) => { emitted.push({ id, type, data }); return true; },
  abortSpawnedRun: async () => true,
  logger: { info() {}, warn() {}, error() {} },
});
test.after(async () => {
  runtime.dispose();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalDirectory === undefined) delete process.env.PI_RESEARCH_HOST_DIR; else process.env.PI_RESEARCH_HOST_DIR = originalDirectory;
  await fs.rm(temporary, { recursive: true, force: true });
});
const request = (method, pathname, body, params = { cwd: project }) => {
  const url = new URL(pathname, 'http://127.0.0.1');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return runtime.handle({ method, pathname, url, body });
};

test('monthly RMB billing includes nested children once and reloads current model rates', async () => {
  const agent = path.join(temporary, '.pi', 'agent');
  const root = path.join(agent, 'sessions', 'project');
  await fs.mkdir(root, { recursive: true });
  const price = { providers: { cliproxy: { models: [{ id: 'fixture', cost: { input: 2.4, output: 12, cacheRead: 0.24, cacheWrite: 3 } }] } } };
  const writePrices = () => fs.writeFile(path.join(agent, 'models.json'), JSON.stringify(price));
  await writePrices();
  const assistant = id => ({ type: 'message', id, timestamp: '2026-01-01T00:00:10.000Z', message: { role: 'assistant', provider: 'cliproxy', model: 'fixture', timestamp: Date.parse('2026-01-01T00:00:00.000Z'), usage: { input: 0, output: 1000, cacheRead: 0, cacheWrite: 0 } } });
  const main = path.join(root, '2026_main.jsonl');
  const child = path.join(root, '2026_main', 'child', 'run-1', 'session.jsonl');
  await fs.mkdir(path.dirname(child), { recursive: true });
  await fs.writeFile(main, [{ type: 'session', id: 'main', cwd: project }, assistant('m1')].map(JSON.stringify).join('\n') + '\n');
  await fs.writeFile(child, [{ type: 'session', id: 'child', cwd: project }, assistant('c1')].map(JSON.stringify).join('\n') + '\n');
  const report = await getBillingReport('2026-01', [{ id: 'child', sessionFile: child, cwd: project }]);
  assert.equal(report.sessions.length, 1);
  assert.equal(report.sessions[0].turnCount, 2);
  assert.ok(Math.abs(report.billing.sessionTotalCost - 0.024) < 1e-10);
  assert.ok(Math.abs(report.billing.subagentTotalCost - 0.012) < 1e-10);
  price.providers.cliproxy.models[0].cost.output = 24;
  await writePrices();
  const updated = await getBillingReport('2026-01');
  assert.ok(Math.abs(updated.billing.sessionTotalCost - 0.048) < 1e-10);
  assert.equal((await request('GET', '/api/speed-monitor/billing', undefined, { month: '2026-00' })).statusCode, 400);
});

test('goals CRUD preserves linked metadata, native goal commands and disk shape', async () => {
  const created = await request('POST', '/api/folders/goals', { objective: 'Synthetic objective', criteria: [{ text: 'Synthetic evidence', done: false }], autoRespawn: true });
  assert.equal(created.statusCode, 201);
  const id = created.body.data.id;
  const linked = await request('POST', '/api/folders/goals/' + id + '/sessions', { sessionId: 'main' });
  assert.equal(linked.statusCode, 200);
  assert.equal(sessions[0].goalId, id);
  assert.ok(sent.some(message => message.text.includes('/goal Synthetic objective')));
  const store = createGoalStore({ dataDir: path.join(process.env.PI_RESEARCH_HOST_DIR, 'goals') });
  const old = await store.list(project);
  assert.equal(old[0].driverSessionId, 'main');
  assert.equal(old[0].criteria[0].text, 'Synthetic evidence');
  store.dispose();
  const denied = await request('GET', '/api/folders/goals', undefined, { cwd: path.join(temporary, 'foreign') });
  assert.equal(denied.statusCode, 403);
  const invalid = await request('PATCH', '/api/folders/goals/' + id, { status: 'respawning' });
  assert.equal(invalid.statusCode, 400);
  const removed = await request('DELETE', '/api/folders/goals/' + id);
  assert.equal(removed.statusCode, 200);
  assert.equal(sessions[0].goalId, undefined);
});

test('goal supervisor persists respawn state and stale completion cannot revive a cleared goal', async () => {
  const directory = path.join(temporary, 'supervisor-goals');
  const store = createGoalStore({ dataDir: directory, debounceMs: 0 });
  const goal = await store.create(project, { objective: 'Synthetic restart', autoRespawn: true });
  await store.linkSession(project, goal.id, 'dead-driver');
  let launch;
  let finishLaunch;
  let stopped = 0;
  const timers = [];
  const supervisor = createGoalSupervisor({ store, isSessionLive: () => false,
    resolveSessionFile: () => '/tmp/synthetic-session.jsonl', mintSpawnToken: () => 'synthetic-token',
    spawnDriver: input => { launch = input; return new Promise(resolve => { finishLaunch = resolve; }); },
    killByToken: async () => { stopped += 1; return true; }, killBySession: async () => true,
    buildReprime: () => 'Synthetic objective', headlessAvailable: () => true,
    setTimer: fn => { timers.push(fn); return { unref() {} }; }, clearTimer() {}, log() {},
  });
  try {
    await supervisor.onDriverDeath('dead-driver');
    assert.equal((await store.list(project))[0].status, 'respawning');
    const pending = timers.shift()();
    for (let index = 0; index < 100 && !launch; index++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(launch.spawnToken, 'synthetic-token');
    assert.equal((await store.list(project))[0].inFlightSpawn.spawnToken, 'synthetic-token');
    await store.finalize(project, goal.id, { status: 'cleared', statusReason: 'Synthetic clear', clearInFlightSpawn: true });
    finishLaunch({ success: true });
    await pending;
    assert.equal((await store.list(project))[0].status, 'cleared');
    assert.ok(stopped >= 1);
  } finally { supervisor.dispose(); store.dispose(); }
});

test('KB uses existing project config, coalesces indexing and searches the saved index', async () => {
  const docs = path.join(project, 'docs');
  await fs.mkdir(docs, { recursive: true });
  await fs.writeFile(path.join(docs, 'guide.md'), '# Synthetic migration\n\nThe reproducible sodium conductivity guide describes independent experimental evidence and preserved materials records.\n');
  const saved = await request('PUT', '/api/kb/config', { sources: [{ kind: 'filesystem', ref: 'docs' }], include: ['**/*.md'], exclude: [] });
  assert.equal(saved.statusCode, 200);
  assert.ok(saved.body.projectPath.endsWith('.pi/dashboard/knowledge_base.json'));
  const read = await request('GET', '/api/kb/config');
  assert.equal(read.body.config.allSourceSpecs[0].ref, 'docs');
  const first = await request('POST', '/api/kb/reindex');
  const second = await request('POST', '/api/kb/reindex');
  assert.equal(first.statusCode, 202);
  assert.equal(first.body.jobId, second.body.jobId);
  for (let index = 0; index < 200 && runtime.registry.isRunning(project); index++) await new Promise(resolve => setTimeout(resolve, 5));
  const stats = await request('GET', '/api/kb/stats');
  assert.equal(stats.body.jobStatus, 'idle');
  assert.ok(stats.body.chunks > 0);
  const found = await request('GET', '/api/kb/search', undefined, { cwd: project, q: 'sodium conductivity' });
  assert.ok(found.body.hits.some(hit => hit.path.endsWith('guide.md')));
});

test('automation definitions execute a correlated native child and persist real result text', async () => {
  const config = { on: { kind: 'schedule', cron: '0 0 1 1 *' }, model: 'cliproxy/fixture', mode: 'local', sandbox: 'read-only', concurrency: 'skip', action: { kind: 'prompt', prompt: './prompt.md' } };
  const created = await request('POST', '/api/plugins/automation/create', { scope: 'folder', cwd: project, name: 'synthetic-job', config, promptBody: 'Read synthetic evidence' });
  assert.equal(created.statusCode, 200);
  const definition = await request('GET', '/api/plugins/automation/definition', undefined, { cwd: project, scope: 'folder', name: 'synthetic-job' });
  assert.equal(definition.body.promptBody, 'Read synthetic evidence\n');
  const collision = await request('POST', '/api/plugins/automation/create', { cwd: project, name: 'synthetic-job', config });
  assert.equal(collision.statusCode, 400);
  const ran = await request('POST', '/api/plugins/automation/run', { cwd: project, scope: 'folder', name: 'synthetic-job' });
  assert.equal(ran.statusCode, 200);
  assert.equal(ran.body.ok, true);
  await new Promise(resolve => setTimeout(resolve, 10));
  const input = spawned.at(-1);
  assert.equal(input.mode, 'local');
  assert.equal(input.sandbox, 'read-only');
  assert.equal(input.pluginRef.kind, 'automation');
  const child = sessions.find(session => session.automationRun?.runId === input.pluginRef.automationRun.runId);
  runtime.onPiEvent(child.id, { type: 'agent_start' });
  assert.ok(sent.some(message => message.id === child.id && message.text === 'Read synthetic evidence'));
  runtime.onPiEvent(child.id, { type: 'turn_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Synthetic measured outcome' }] } });
  runtime.onPiEvent(child.id, { type: 'agent_end' });
  const result = await request('GET', '/api/plugins/automation/result', undefined, { cwd: project, runId: child.automationRun.runId, scope: 'folder' });
  assert.equal(result.statusCode, 200);
  assert.ok(result.body.result.includes('Synthetic measured outcome'));
  const history = await request('GET', '/api/plugins/automation/runs');
  assert.ok(history.body.runs.some(run => run.runId === ran.body.runId && run.status !== 'running'));
  const deleted = await request('DELETE', '/api/plugins/automation', undefined, { cwd: project, scope: 'folder', name: 'synthetic-job' });
  assert.equal(deleted.statusCode, 200);
});

test('flows native controls use original event names and report only allowed files', async () => {
  runtime.onPiEvent('main', { type: 'flows_list', flows: [{ name: 'synthetic-flow', source: path.join(project, 'flow.yaml') }] });
  const state = await request('GET', '/api/plugins/flows/state', undefined, { sessionId: 'main' });
  assert.equal(state.body.flows[0].name, 'synthetic-flow');
  const ran = await request('POST', '/api/plugins/flows/control', { sessionId: 'main', action: 'run', payload: { flowName: 'synthetic-flow', inputs: { question: 'Synthetic evidence' } } });
  assert.equal(ran.statusCode, 200);
  assert.equal(emitted.at(-1).type, 'flow:run');
  await request('POST', '/api/plugins/flows/control', { sessionId: 'main', action: 'abort' });
  assert.equal(emitted.at(-1).type, 'flow:abort');
  const flow = path.join(project, 'flow.yaml');
  const other = path.join(project, 'private.txt');
  await fs.writeFile(flow, 'name: synthetic-flow\nsteps: []\n');
  await fs.writeFile(other, 'Synthetic private record');
  await runtime.requestPlugin('flows', 'flow-files/report', { flows: [{ name: 'synthetic-flow', source: flow }], agents: [] }, 'main');
  const file = await request('GET', '/api/plugins/flows/file', undefined, { sessionId: 'main', path: flow });
  assert.equal(file.statusCode, 200);
  assert.ok(file.body.data.content.includes('synthetic-flow'));
  const refused = await request('GET', '/api/plugins/flows/file', undefined, { sessionId: 'main', path: other });
  assert.equal(refused.statusCode, 403);
});
