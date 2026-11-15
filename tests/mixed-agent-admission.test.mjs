import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scheduleResearchSubagent } from '../extensions/research-loop/src/subagent-scheduling.mjs';
import { createResearchCollaborationService, createResearchCollaborationStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-collaboration-service.mjs';
import { createResearchSessionService, createResearchSessionStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';
import { createResearchDispatchService, createResearchDispatchStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';

const owner = { iss: 'fixture-mixed-admission', sub: 'operator' };
const ownerKey = JSON.stringify([owner.iss, owner.sub]);
const charterHash = 'sha256:' + 'a'.repeat(64), adoptionId = 'adopt-' + 'b'.repeat(24);
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
const jobs = count => Array.from({ length: count }, (_, i) => ({ id: `task-${i}`, role: 'researcher', task: `Prepared fixture task ${i}`, stage: '2-experiment' }));

/** All three real admission paths and both persistent stores are used. Only
 * existing identity proof and the actual OS/model execution boundary are fake. */
async function fixture(t, { maxSubagents = 3, nativeOperator = false } = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'research-mixed-admission-'));
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const access = { cwd, ownerKey, write: true, revalidate: async () => {}, canReadHistory: async row => row.principalOwner?.iss === owner.iss && row.principalOwner?.sub === owner.sub };
  const nativeAccess = nativeOperator ? { ...access, ownerKey: '["urn:pi-dashboard:local-operator","local-operator"]', canReadHistory: async () => true } : access;
  const rows = [{ id: 'root', cwd, name: 'Fixture root', status: 'idle', principalOwner: owner, resWorkflow: { canonicalCwd: cwd } }];
  const refs = new Map(), spawns = [], nativeChildren = [], released = new Set(), sleepers = [], controllers = [], nativePromises = [];
  let collaboration, sessions, dispatcher, sequence = 0, attempts = 0, unknownNext = false, failedNext = false;
  let at = Date.parse('2026-11-16T01:00:00.000Z'), peak = 0;
  const row = id => rows.find(item => item.id === id);
  const verified = parent => ({ parent, cwd, ownerKey, charterHash, adoptionId });
  const active = parentId => spawns.filter(item => item.parentSessionId === parentId && !released.has(item.spawnToken)).length + nativeChildren.filter(item => item.parentSessionId === parentId && item.disposals === 0).length;
  const observe = parentId => { peak = Math.max(peak, active(parentId)); };

  function boot() {
    collaboration = createResearchCollaborationService({
      store: createResearchCollaborationStore(path.join(directory, 'collaboration')),
      listSessions: () => rows, connection: async () => ({ adopted: true }),
      verifySelected: async parent => verified(parent),
      detach: async (_access, id) => { delete row(id).resWorkflow; },
      listPlans: scope => dispatcher?.listForScope(scope) ?? [],
      manageQueue: input => dispatcher.manageQueue(input),
      suspendSessions: (ids, reason) => dispatcher.suspendSessions(ids, reason),
      isSessionCompleted: token => released.has(token) || dispatcher?.isCompleted(token) === true,
      isRecoveringSession: candidate => dispatcher?.isRecoveringSession(candidate) === true,
      onChanged: () => dispatcher.tick(),
      now: () => new Date(at), mintId: () => `fixture-${++sequence}`,
    });
    sessions = createResearchSessionService({
      store: createResearchSessionStore(path.join(directory, 'session-requests')),
      getSession: row, listSessions: () => rows,
      verifyParent: async ({ parent }) => verified(parent), isLocalOperator: () => false,
      getSchedulingPolicy: input => collaboration.getSchedulingPolicy(input),
      assertDispatchAllowed: input => collaboration.assertDispatchAllowed(input),
      acquireSchedulingReservation: input => collaboration.acquireSchedulingReservation(input),
      releaseSchedulingReservation: token => collaboration.releaseSchedulingReservation(token),
      prepareSpawn: async (_cwd, _identity, value) => ({ researchSession: value.researchSession }),
      pendingPluginRefRegistry: { file: (token, ref) => { refs.set(token, ref); return true; }, remove: token => refs.delete(token) },
      pendingPrincipalOwnerRegistry: { file: () => true, remove: () => {} },
      initialPrompts: { enqueue: () => true, remove: () => {} },
      spawn: async (_cwd, { spawnToken }) => {
        if (failedNext) { failedNext = false; return { success: false }; }
        const provenance = structuredClone(refs.get(spawnToken).researchSession);
        spawns.push(provenance); observe(provenance.parentSessionId);
        if (unknownNext) { unknownNext = false; throw new Error('fixture response lost after possible process start'); }
        rows.push({ id: `session-child-${spawns.length}`, cwd, status: 'idle', principalOwner: owner, resWorkflow: { canonicalCwd: cwd }, researchSession: provenance });
        return { success: true };
      },
      isCompleted: token => released.has(token) || dispatcher?.isCompleted(token) === true,
      isWaitingCoordinator: id => dispatcher?.isWaitingCoordinator(id) === true,
      isRecoveringSession: candidate => dispatcher?.isRecoveringSession(candidate) === true,
      unregisteredReservations: () => dispatcher?.unregisteredReservations() ?? [],
      maxTotal: 64, maxResident: 128, availableMemory: () => 16 * 1024 ** 3,
      now: () => new Date(at), mintToken: () => `fixture-token-${++sequence}`,
    });
    dispatcher = createResearchDispatchService({
      store: createResearchDispatchStore(path.join(directory, 'dispatch')),
      getSession: row, listSessions: () => rows, authorize: sessions.authorize, createSession: sessions.create,
      getSchedulingPolicy: input => collaboration.getSchedulingPolicy(input),
      assertDispatchAllowed: input => collaboration.assertDispatchAllowed(input),
      releaseSession: async token => { await sessions.release(token); released.add(token); },
      principalForSession: candidate => candidate?.principalOwner,
      now: () => new Date(at),
    });
  }
  boot();
  const snapshot = () => collaboration.snapshot(access);
  const mutate = async body => collaboration.mutate(access, { expectedRevision: (await snapshot()).revision, ...body }, { principal: owner });
  const current = await mutate({ action: 'select-main', sessionId: 'root' });
  for (const id of ['multi-a', 'multi-b']) rows.push({ id, cwd, status: 'idle', principalOwner: owner, resWorkflow: { canonicalCwd: cwd },
    researchSession: { parentSessionId: 'root', rootSessionId: 'root', depth: 1, workflowCwd: cwd, charterHash, adoptionId, tenureId: current.currentTenureId, role: 'researcher', spawnToken: `seed-${id}`, createdAt: new Date(at).toISOString() },
  });
  if (maxSubagents !== 3) await mutate({ action: 'limits', maxMultiAgents: 4, maxSubagents });
  const nativeOptions = {
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:1234', token: 'fixture-only-auth' }), heartbeatMs: 0,
    randomUUID: () => `native-attempt-${++attempts}`,
    fetchImpl: async (_url, input) => {
      try { return Response.json(await collaboration.native(nativeAccess, JSON.parse(input.body), { principal: nativeOperator ? { iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' } : owner })); }
      catch (error) { return Response.json({ error: error.code }, { status: error.statusCode ?? 500 }); }
    },
    wait: (_ms, signal) => new Promise((resolve, reject) => {
      const abort = () => reject(new Error('research-subagent-launch-cancelled'));
      signal?.addEventListener('abort', abort, { once: true });
      sleepers.push(() => { signal?.removeEventListener('abort', abort); resolve(); });
    }),
  };
  const native = (parentSessionId, runId) => {
    const controller = new AbortController(); controllers.push(controller);
    const promise = scheduleResearchSubagent({ cwd, model: 'fixture/native-model', signal: controller.signal, runtime: { parentSessionId, runId, childIndex: 0, agent: 'researcher' } }, () => {
      const child = { parentSessionId, sessionId: `native-child-${runId}`, modelId: 'fixture/native-model', disposals: 0, async dispose() { this.disposals++; } };
      nativeChildren.push(child); observe(parentSessionId); return child;
    }, { task: 'A prepared native task' }, nativeOptions);
    // A queued launch is intentional. Attach a handler now so later deliberate
    // cancellation does not create a transient unhandled rejection.
    promise.catch(() => {}); nativePromises.push(promise);
    return { promise, controller };
  };
  t.after(async () => {
    controllers.forEach(controller => controller.abort());
    await Promise.allSettled(nativePromises);
    await Promise.allSettled(nativeChildren.map(child => child.dispose()));
    dispatcher.dispose(); fs.rmSync(directory, { recursive: true, force: true });
  });
  return { rows, spawns, nativeChildren, native, snapshot, mutate, active, peak: () => peak,
    direct: (parentSessionId, requestId) => sessions.create({ principal: owner, body: { parentSessionId, requestId, role: 'researcher', task: 'Fixture direct work', stage: '2-experiment' } }),
    plan: (sessionId, planId, count) => dispatcher.handle({ principal: owner, body: { sessionId, action: 'plan', planId, tasks: jobs(count) } }),
    release: async token => { await sessions.release(token); released.add(token); },
    tick: () => dispatcher.tick(),
    nativeTick: async () => { const pending = sleepers.splice(0); pending.forEach(wake => wake()); await flush(); },
    restart: () => { dispatcher.dispose(); boot(); },
    unknownNext: () => { unknownNext = true; },
    failedNext: () => { failedNext = true; },
    advanceClock: ms => { at += ms; },
  };
}

test('native, direct and queued child executions share one three-slot Multi-agent allowance', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const direct = await f.direct('multi-a', 'direct-first');
  await f.native('multi-a', 'native-first').promise;
  const result = await f.plan('multi-a', 'mixed-plan', 4);
  const tasks = result.plans[0].tasks;
  assert.equal(tasks.filter(task => task.status === 'running').length, 1);
  assert.equal(tasks.filter(task => task.status === 'queued').length, 3);
  assert.equal(f.active('multi-a'), 3);
  await assert.rejects(f.direct('multi-a', 'direct-overflow'), /concurrency-limit|capacity-limit/);
  const next = f.native('multi-a', 'native-overflow'); await flush();
  assert.equal(f.nativeChildren.length, 1);
  assert.equal((await f.snapshot()).nativeQueue.filter(item => item.status === 'queued').length, 1);
  await f.release(direct.spawnToken); await f.nativeTick();
  await next.promise;
  assert.equal(f.active('multi-a'), 3);
  await f.tick(); assert.equal(f.active('multi-a'), 3);
  assert.equal(f.peak(), 3);
});

test('mixed admission reacts to live increases and drains a decrease without killing existing work', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxSubagents: 1 });
  const direct = await f.direct('multi-a', 'direct-first');
  const waiting = f.native('multi-a', 'native-waiting'); await flush();
  assert.equal(f.nativeChildren.length, 0);
  await f.mutate({ action: 'limits', maxMultiAgents: 4, maxSubagents: 2 });
  await f.nativeTick(); const native = await waiting.promise;
  assert.equal(f.active('multi-a'), 2);
  const plan = await f.plan('multi-a', 'after-native', 2);
  assert.equal(plan.plans[0].tasks.every(task => task.status === 'queued'), true);
  await f.mutate({ action: 'limits', maxMultiAgents: 4, maxSubagents: 1 });
  assert.equal(native.disposals, 0); assert.equal(f.active('multi-a'), 2);
  await native.dispose(); await f.tick();
  assert.equal(f.active('multi-a'), 1); assert.equal(f.spawns.length, 1);
  await f.release(direct.spawnToken); await f.tick();
  assert.equal(f.active('multi-a'), 1); assert.equal(f.spawns.length, 2);
});

test('racing native and direct requests cannot double-claim the last shared seats', { timeout: 8000 }, async t => {
  const f = await fixture(t);
  const pendingNative = [], pendingDirect = [];
  for (let i = 0; i < 8; i++) {
    pendingNative.push(f.native('multi-a', `race-native-${i}`));
    pendingDirect.push(f.direct('multi-a', `race-direct-${i}`));
  }
  const directResults = await Promise.allSettled(pendingDirect); await flush();
  assert.equal(f.active('multi-a'), 3);
  assert.equal(f.peak(), 3);
  assert.equal(directResults.filter(item => item.status === 'fulfilled').length + f.nativeChildren.length, 3);
  assert.ok(directResults.filter(item => item.status === 'rejected').every(item => /concurrency-limit|capacity-limit/.test(item.reason.code)));
  pendingNative.forEach(item => item.controller.abort());
  await Promise.allSettled(pendingNative.map(item => item.promise));
  assert.equal(f.peak(), 3);
});

test('a direct unknown launch remains reserved across service restart and cannot be duplicated', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxSubagents: 1 });
  f.unknownNext();
  await assert.rejects(f.direct('multi-a', 'same-request'), /spawn-outcome-unknown/);
  assert.equal(f.spawns.length, 1);
  await assert.rejects(f.direct('multi-a', 'same-request'), /unknown|recovery/);
  f.restart(); f.advanceClock(300_000);
  await assert.rejects(f.direct('multi-a', 'same-request'), /unknown|recovery/);
  await assert.rejects(f.direct('multi-a', 'different-request'), /concurrency-limit|capacity-limit/);
  const native = f.native('multi-a', 'after-restart'); await flush();
  assert.equal(f.nativeChildren.length, 0);
  assert.equal(f.spawns.length, 1);
  await f.tick(); await f.nativeTick();
  assert.equal(f.spawns.length, 1); assert.equal(f.nativeChildren.length, 0);
  native.controller.abort(); await assert.rejects(native.promise, /launch-cancelled/);
});

test('one Multi-agent cannot borrow another parent allowance or block an independent parent', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxSubagents: 1 });
  await f.direct('multi-a', 'direct-a');
  await f.native('multi-b', 'native-b').promise;
  assert.equal(f.active('multi-a'), 1); assert.equal(f.active('multi-b'), 1);
  const queued = f.native('multi-a', 'overflow-a'); await flush();
  await assert.rejects(f.direct('multi-b', 'overflow-b'), /concurrency-limit|capacity-limit/);
  assert.equal(f.nativeChildren.length, 1); assert.equal(f.spawns.length, 1);
  queued.controller.abort(); await assert.rejects(queued.promise, /launch-cancelled/);
});

test('a confirmed ended direct child frees capacity without requiring a nonexistent dispatch report', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxSubagents: 1 });
  await f.direct('multi-a', 'first-direct');
  const child = f.rows.find(row => row.id === 'session-child-1');
  child.status = 'ended';
  child.dataUnavailable = false;
  await f.direct('multi-a', 'after-confirmed-exit');
  assert.equal(f.spawns.length, 2);
});

test('host-authenticated native work uses its named-owner parent ledger rather than a hidden parallel pool', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxSubagents: 1, nativeOperator: true });
  const native = await f.native('multi-a', 'host-auth').promise;
  const [extra] = await Promise.allSettled([f.direct('multi-a', 'named-owner-overflow')]);
  assert.deepEqual({ visibleNativeRequests: (await f.snapshot()).nativeQueue.length, extraAdmission: extra.status, active: f.active('multi-a') },
    { visibleNativeRequests: 1, extraAdmission: 'rejected', active: 1 });
  assert.match(extra.reason.code, /concurrency-limit|capacity-limit/);
  await f.mutate({ action: 'detach', sessionId: 'multi-a' });
  assert.equal(native.disposals, 0);
  await native.dispose();
  assert.equal((await f.snapshot()).nativeQueue[0].status, 'released', 'host-authenticated disposal still reaches the original named-owner lease after detachment');
});

test('a proven no-process launch failure can retry the same direct request without leaking a reservation', { timeout: 8000 }, async t => {
  const f = await fixture(t, { maxSubagents: 1 });
  f.failedNext();
  await assert.rejects(f.direct('multi-a', 'retry-safe-failure'), /spawn-failed/);
  assert.equal(f.spawns.length, 0);
  await f.direct('multi-a', 'retry-safe-failure');
  assert.equal(f.spawns.length, 1);
  const waiting = f.native('multi-a', 'after-retried-direct'); await flush();
  assert.equal(f.nativeChildren.length, 0); assert.equal(f.active('multi-a'), 1);
  waiting.controller.abort(); await assert.rejects(waiting.promise, /launch-cancelled/);
});
