import test from 'node:test';
import assert from 'node:assert/strict';
import { scheduleResearchSubagent } from '../extensions/research-loop/src/subagent-scheduling.mjs';
import { createResearchCollaborationService } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-collaboration-service.mjs';

const cwd = '/fixture/project';
const ownerKey = '["host","inert-operator"]';
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };

async function fixture() {
  const rows = [
    { id: 'main-1', name: 'Current main', cwd, status: 'idle', resWorkflow: { canonicalCwd: cwd } },
    { id: 'main-2', name: 'Next main', cwd, status: 'idle', resWorkflow: { canonicalCwd: cwd } },
    ...['multi-1', 'multi-2'].map(id => ({ id, name: id, cwd, status: 'idle', resWorkflow: { canonicalCwd: cwd }, researchSession: { parentSessionId: 'main-1', workflowCwd: cwd, adoptionId: 'adoption-1', charterHash: 'charter-1', role: 'research-theory' } })),
    { id: 'unmanaged', name: 'Ordinary conversation', cwd, status: 'idle' },
  ];
  const access = { cwd, ownerKey, write: true, revalidate: async () => {}, canReadHistory: async () => true };
  const saved = new Map(), sleeping = [], created = [], requests = [];
  let sequence = 0, attempt = 0;
  const deps = {
    listSessions: () => rows,
    connection: async () => ({ adopted: true }),
    verifySelected: async parent => ({ parent, cwd, ownerKey, adoptionId: 'adoption-1', charterHash: 'charter-1' }),
    detach: async (_access, id) => { delete rows.find(row => row.id === id).resWorkflow; },
    mintId: () => 'fixture-' + (++sequence),
    store: { readAll: () => [...saved.values()].map(row => structuredClone(row)), write: state => { saved.set(state.ownerKey + state.cwd, structuredClone(state)); } },
  };
  let service = createResearchCollaborationService(deps);
  const snapshot = () => service.snapshot(access);
  const mutate = async body => service.mutate(access, { expectedRevision: (await snapshot()).revision, ...body });
  await mutate({ action: 'select-main', sessionId: 'main-1' });
  const options = {
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:1234', token: 'fixture-auth-only' }),
    fetchImpl: async (url, init) => {
      assert.equal(url, 'http://127.0.0.1:1234/api/res-workflow/collaboration/native');
      assert.equal(init.headers['x-pi-local-token'], 'fixture-auth-only');
      const body = JSON.parse(init.body); requests.push(body);
      try { return Response.json(await service.native(access, body)); }
      catch (error) { return Response.json({ error: error.code }, { status: error.statusCode ?? 500 }); }
    },
    wait: (_ms, signal) => new Promise((resolve, reject) => {
      const abort = () => reject(new Error('research-subagent-launch-cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      sleeping.push(() => { signal?.removeEventListener('abort', abort); resolve(); });
    }),
    heartbeatMs: 0, randomUUID: () => 'attempt-' + (++attempt),
  };
  const run = (parent, runId) => scheduleResearchSubagent({ cwd, model: 'fixture/requested-model', runtime: { parentSessionId: parent, runId, childIndex: 0, agent: 'research-theory' } }, () => {
    const child = { sessionId: `child-${runId}`, modelId: 'fixture/actual-model', disposals: 0, async dispose() { this.disposals++; } };
    created.push(child); return child;
  }, { task: 'Validate a prepared research result' }, options);
  return { rows, created, requests, run, mutate, snapshot,
    restart: () => { service = createResearchCollaborationService(deps); },
    tick: async () => { const pending = sleeping.splice(0); pending.forEach(wake => wake()); await flush(); },
  };
}

test('native adapter and actual collaboration service share live per-parent slots across restart', { timeout: 5000 }, async () => {
  const f = await fixture();
  const live = [];
  for (let i = 1; i <= 3; i++) live.push(await f.run('multi-1', `run-${i}`));
  const waiting = f.run('multi-1', 'run-4');
  await flush();
  let state = await f.snapshot();
  assert.deepEqual(state.limits, { maxMultiAgents: 4, maxSubagents: 3 });
  assert.equal(f.created.length, 3);
  assert.equal(state.nativeQueue.filter(row => row.status === 'queued').length, 1);
  assert.equal(state.nativeQueue.every(row => row.parentSessionId === 'multi-1'), true);
  assert.equal(state.nativeQueue.every(row => !('leaseToken' in row) && !('attemptId' in row)), true);
  assert.equal(state.nativeQueue.find(row => row.status === 'running').model, 'fixture/actual-model');
  assert.equal(state.nativeQueue.find(row => row.status === 'queued').model, 'fixture/requested-model');
  f.restart();
  state = await f.snapshot();
  assert.equal(state.nativeQueue.length, 4);
  await f.mutate({ action: 'limits', maxMultiAgents: 4, maxSubagents: 4 });
  await f.tick(); live.push(await waiting);
  assert.equal(f.created.length, 4);
  await f.mutate({ action: 'limits', maxMultiAgents: 4, maxSubagents: 2 });
  const fifth = f.run('multi-1', 'run-5'); await flush();
  assert.equal(live.every(child => child.disposals === 0), true);
  await live[0].dispose(); await live[1].dispose(); await f.tick();
  assert.equal(f.created.length, 4); // Active count equals the lowered cap.
  await live[2].dispose(); await f.tick();
  const last = await fifth;
  assert.equal(f.created.length, 5);
  await live[3].dispose(); await last.dispose();
  assert.equal((await f.snapshot()).nativeQueue.every(row => row.status === 'released'), true);
});

test('native admission is parent-scoped and drag reorder changes the next eligible launch', { timeout: 5000 }, async () => {
  const f = await fixture();
  await f.mutate({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  const first = await f.run('multi-1', 'first');
  const second = await f.run('multi-2', 'independent');
  const waitingA = f.run('multi-1', 'waiting-a');
  const waitingB = f.run('multi-1', 'waiting-b');
  await flush();
  const queue = (await f.snapshot()).nativeQueue.filter(row => row.status === 'queued');
  assert.equal(queue.length, 2); assert.equal(f.created.length, 2);
  await f.mutate({ action: 'native-reorder', sessionId: 'multi-1', taskIds: queue.map(row => row.id).reverse() });
  await first.dispose(); await f.tick();
  const promoted = await waitingB;
  assert.equal(f.created.at(-1).sessionId, 'child-waiting-b');
  assert.equal(second.disposals, 0);
  await promoted.dispose(); await f.tick();
  const remaining = await waitingA;
  await remaining.dispose(); await second.dispose();
});

test('historical and detached parents cannot silently become unmanaged, while active leases drain', { timeout: 5000 }, async () => {
  const f = await fixture();
  await f.mutate({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  const first = await f.run('multi-1', 'before-change');
  const waiting = f.run('multi-1', 'waiting');
  const refused = assert.rejects(waiting, /research-native-attempt-ended|historical-main/);
  await flush();
  await f.mutate({ action: 'select-main', sessionId: 'main-2' });
  await f.tick(); await refused;
  assert.equal(first.disposals, 0);
  await assert.rejects(f.run('multi-1', 'old-parent'), /historical-main|not-current-descendant/);
  await first.dispose();
  const current = await f.run('main-2', 'current');
  await f.mutate({ action: 'detach', sessionId: 'main-2' });
  assert.equal(current.disposals, 0);
  assert.equal(f.rows.find(row => row.id === 'main-2').resWorkflow, undefined);
  await assert.rejects(f.run('main-2', 'removed'), /main-not-selected|session-detached/);
  await current.dispose();
  const ordinary = await f.run('unmanaged', 'ordinary');
  assert.equal((await f.snapshot()).nativeQueue.some(row => row.parentSessionId === 'unmanaged'), false);
  await ordinary.dispose();
});

test('a restarted caller cannot relaunch an unconfirmed native attempt', { timeout: 5000 }, async () => {
  const f = await fixture();
  const first = await f.run('multi-1', 'stable-native-run');
  f.restart();
  await assert.rejects(f.run('multi-1', 'stable-native-run'), /subagent-launch-recovery-required/);
  assert.equal(f.created.length, 1);
  assert.equal((await f.snapshot()).nativeQueue[0].status, 'running');
  await first.dispose();
  const retry = await f.run('multi-1', 'stable-native-run');
  assert.equal(f.created.length, 2);
  await retry.dispose();
});
