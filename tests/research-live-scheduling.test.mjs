import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchDispatchService, createResearchDispatchStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';
import { createResearchSessionService, createResearchSessionStore, ResearchSessionError } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';
import { createResearchSessionTool } from '../extensions/research-loop/src/workbench-session-tool.mjs';

const OWNER = { iss: 'synthetic-live-queue', sub: 'operator' };
const CHARTER = 'sha256:' + 'a'.repeat(64), ADOPTION = 'adopt-' + 'b'.repeat(24);
const jobs = count => Array.from({ length: count }, (_, i) => ({ id: `task-${i}`, role: 'researcher', task: `Synthetic task ${i}`, stage: '2-experiment' }));

/** Real scheduler, native session admission, and atomic disk writes. Only the
 * OS process boundary and existing owner/charter verifier are simulated. */
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'research-live-queue-'));
  const cwd = path.join(directory, 'project'); fs.mkdirSync(cwd);
  const rows = [{ id: 'root', cwd, status: 'idle', principalOwner: OWNER }];
  const policy = { maxMultiAgents: 4, maxSubagents: 3, mainSessionId: 'root', tenureId: 'tenure-1', managed: true, ...options.policy };
  const denied = new Set(), refs = new Map(), spawns = [], released = [];
  const disk = createResearchDispatchStore(path.join(directory, 'private', 'dispatch'));
  const sessionDisk = createResearchSessionStore(path.join(directory, 'private', 'session-reservations'));
  let dispatcher, sessionService, sequence = 0, at = Date.parse('2026-11-16T00:00:00.000Z'), memory = 8 * 1024 ** 3, failWrite = false;
  const row = id => rows.find(value => value.id === id);
  const getSchedulingPolicy = ({ parent }) => ({ ...policy, isMainAgent: parent.id === policy.mainSessionId });
  const assertDispatchAllowed = ({ parent }) => {
    if (!policy.mainSessionId) throw new ResearchSessionError(409, 'research-collaboration-main-not-selected');
    if (denied.has(parent.id)) throw new ResearchSessionError(409, 'research-collaboration-detached');
    if (parent.id !== policy.mainSessionId && parent.researchSession?.tenureId !== policy.tenureId && !(policy.importLegacy && !parent.researchSession?.tenureId)) throw new ResearchSessionError(409, 'research-collaboration-historical');
  };
  function boot() {
    sessionService = createResearchSessionService({
      store: sessionDisk,
      getSession: row, listSessions: () => rows,
      verifyParent: async () => ({ cwd, charterHash: CHARTER, adoptionId: ADOPTION, ownerKey: JSON.stringify([OWNER.iss, OWNER.sub]) }),
      getSchedulingPolicy, assertDispatchAllowed,
      prepareSpawn: async (_cwd, _identity, verified) => ({ researchSession: verified.researchSession }),
      pendingPluginRefRegistry: { file: (token, ref) => { refs.set(token, ref); return true; }, remove: token => refs.delete(token) },
      pendingPrincipalOwnerRegistry: { file: () => true, remove: () => {} },
      initialPrompts: { enqueue: () => true, remove: () => {} },
      spawn: async (_cwd, { spawnToken }) => {
        const provenance = structuredClone(refs.get(spawnToken).researchSession);
        spawns.push(provenance);
        if (options.register !== false) rows.push({ id: `child-${spawns.length}`, cwd, status: 'idle', principalOwner: OWNER, researchSession: provenance });
        if (options.unknownOutcome) throw Error('synthetic transport lost');
        return { success: true };
      },
      beforeSpawn: options.beforeSpawn,
      isLocalOperator: () => false,
      maxTotal: options.maxTotal ?? 32,
      availableMemory: () => memory, now: () => new Date(at), mintToken: () => `live-queue-token-${++sequence}`,
      isCompleted: token => dispatcher?.isCompleted(token) ?? false,
      isWaitingCoordinator: id => dispatcher?.isWaitingCoordinator(id) ?? false,
      isRecoveringSession: session => dispatcher?.isRecoveringSession(session) ?? false,
      unregisteredReservations: () => dispatcher?.unregisteredReservations() ?? [],
    });
    dispatcher = createResearchDispatchService({
      store: { readAll: () => disk.readAll(), write: record => { if (failWrite) { failWrite = false; throw Error('synthetic write failure'); } disk.write(record); } },
      getSession: row, listSessions: () => rows,
      authorize: sessionService.authorize, createSession: sessionService.create,
      releaseSession: token => { released.push(token); return sessionService.release(token); },
      getSchedulingPolicy, assertDispatchAllowed, principalForSession: session => session?.principalOwner,
      now: () => new Date(at),
    });
  }
  boot();
  t.after(() => { dispatcher.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const call = (sessionId, body, principal = OWNER) => dispatcher.handle({ body: { sessionId, ...body }, principal });
  return {
    policy, denied, rows, row, spawns, refs, released, records: () => disk.readAll(),
    plan: (sessionId = 'root', count = 6, planId = 'plan-one', tasks = jobs(count)) => call(sessionId, { action: 'plan', planId, tasks }),
    status: (id = 'root') => call(id, { action: 'status' }),
    lookup: (id, planId) => call(id, { action: 'status', planId }),
    control: (action, planId, sessionId = 'root') => call(sessionId, { action, planId }),
    report: (id, status = 'completed') => call(id, { action: 'report', status, summary: 'Synthetic measured result', evidence: [] }),
    queue: (fields, principal = OWNER) => dispatcher.manageQueue({ body: { sessionId: 'root', ...fields }, principal }),
    direct: (sessionId, requestId) => sessionService.create({ principal: OWNER, body: { parentSessionId: sessionId, role: 'researcher', task: 'Synthetic direct work', stage: '2-experiment', requestId } }),
    create: body => sessionService.create({ principal: OWNER, body }),
    tick: () => dispatcher.tick(), suspend: (ids, tenureId) => dispatcher.suspendSessions(ids, 'research-collaboration-detached', tenureId),
    list: () => dispatcher.listForScope({ cwd, ownerKey: JSON.stringify([OWNER.iss, OWNER.sub]) }),
    reboot: () => { dispatcher.dispose(); boot(); }, memory: bytes => { memory = bytes; }, advanceClock: ms => { at += ms; },
    failWrite: () => { failWrite = true; },
  };
}

test('live project defaults dispatch four root peers and three children; excess tasks are already durable', async t => {
  const f = fixture(t);
  const first = (await f.plan()).plans[0];
  assert.equal(first.concurrency, 4);
  assert.equal(first.tasks.filter(task => task.status === 'running').length, 4);
  assert.equal(first.tasks.filter(task => task.status === 'queued').length, 2);
  assert.equal(first.tenureId, 'tenure-1');
  const nested = (await f.plan('child-1', 5, 'nested')).plans[0];
  assert.equal(nested.concurrency, 3);
  assert.equal(nested.tasks.filter(task => task.status === 'running').length, 3);
  assert.equal(nested.tasks.filter(task => task.status === 'queued').length, 2);
  assert.ok(f.spawns.every(p => p.tenureId === 'tenure-1'));
});

test('raising limits fills slots on tick and lowering drains without killing or over-admitting', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 2 } });
  await f.plan('root', 8);
  assert.equal(f.spawns.length, 2);
  f.policy.maxMultiAgents = 4; await f.tick();
  assert.equal(f.spawns.length, 4);
  f.policy.maxMultiAgents = 1; await f.tick();
  assert.equal(f.spawns.length, 4);
  assert.ok(f.rows.slice(1).every(row => row.status === 'idle'), 'no running process is killed');
  for (const id of ['child-1', 'child-2', 'child-3']) { await f.report(id); assert.equal(f.spawns.length, 4); }
  await f.report('child-4');
  assert.equal(f.spawns.length, 5);
  assert.equal((await f.status()).plans[0].concurrency, 1);
});

test('drag ordering is durable, heartbeat-stable, revision-guarded, and honored after restart', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const plan = (await f.plan('root', 5)).plans[0];
  const reordered = await f.queue({ action: 'reorder', planId: plan.id, expectedRevision: plan.revision, taskIds: ['task-4', 'task-2', 'task-1', 'task-3'] });
  const revision = reordered.plans[0].revision;
  await f.tick(); await f.tick();
  assert.equal((await f.status()).plans[0].revision, revision);
  await assert.rejects(f.queue({ action: 'reorder', planId: plan.id, expectedRevision: plan.revision, taskIds: ['task-1', 'task-2', 'task-3', 'task-4'] }), error => error.code === 'research-queue-revision-conflict');
  f.reboot();
  assert.deepEqual((await f.status()).plans[0].tasks.filter(task => task.status === 'queued').map(task => task.id), ['task-4', 'task-2', 'task-1', 'task-3']);
  await f.report('child-1');
  assert.equal(f.spawns.at(-1).taskId, 'task-4');
  assert.equal(f.spawns.length, 2);
});

test('pause advances queue CAS, permits durable drag ordering, and fences start until explicit resume', async t => {
  const f = fixture(t);
  const initial = (await f.plan()).plans[0];
  const paused = (await f.control('pause', initial.id)).plans[0];
  assert.equal(paused.schedulingPaused, true);
  assert.equal(paused.revision, initial.revision + 1);
  assert.equal(f.list()[0].schedulingPaused, true);
  await f.report('child-1');
  assert.equal(f.spawns.length, 4, 'a released slot does not override pause');
  await assert.rejects(f.queue({ action: 'start', planId: initial.id, taskId: 'task-4', expectedRevision: initial.revision }), /queue-revision-conflict/);
  await assert.rejects(f.queue({ action: 'start', planId: initial.id, taskId: 'task-4', expectedRevision: paused.revision }), /dispatch-scheduling-paused/);
  const reordered = (await f.queue({ action: 'reorder', planId: initial.id, taskIds: ['task-5', 'task-4'], expectedRevision: paused.revision })).plans[0];
  assert.equal(reordered.schedulingPaused, true);
  assert.equal(f.spawns.length, 4);
  f.reboot();
  assert.equal((await f.status()).plans[0].schedulingPaused, true);
  const resumed = (await f.control('resume', initial.id)).plans[0];
  assert.equal(resumed.schedulingPaused, false);
  assert.ok(resumed.revision > reordered.revision);
  assert.equal(f.spawns.length, 5);
  assert.equal(f.spawns.at(-1).taskId, 'task-5');
});

test('start-now promotes at full capacity, starts immediately with a free slot, and never bypasses dependencies', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const tasks = jobs(5); tasks[2].dependsOn = ['task-0'];
  let plan = (await f.plan('root', 5, 'prioritized', tasks)).plans[0];
  await assert.rejects(f.queue({ action: 'start', planId: plan.id, taskId: 'task-2', expectedRevision: plan.revision }), error => error.code === 'research-queue-dependencies-pending');
  const promoted = await f.queue({ action: 'start', planId: plan.id, taskId: 'task-3', expectedRevision: plan.revision });
  assert.equal(promoted.startResult.status, 'queued');
  assert.equal(promoted.startResult.waitingReason, 'capacity');
  assert.equal(f.spawns.length, 1);
  plan = promoted.plans[0];
  f.policy.maxMultiAgents = 2;
  const started = await f.queue({ action: 'start', planId: plan.id, taskId: 'task-4', expectedRevision: plan.revision });
  assert.equal(started.startResult.status, 'running');
  assert.equal(f.spawns.at(-1).taskId, 'task-4');
  await f.report('child-1');
  assert.equal(f.spawns.at(-1).taskId, 'task-3');
});

test('two clients cannot overwrite each other with a stale drag revision', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const plan = (await f.plan('root', 4)).plans[0];
  const results = await Promise.allSettled([
    f.queue({ action: 'reorder', planId: plan.id, expectedRevision: plan.revision, taskIds: ['task-3', 'task-2', 'task-1'] }),
    f.queue({ action: 'reorder', planId: plan.id, expectedRevision: plan.revision, taskIds: ['task-2', 'task-1', 'task-3'] }),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'research-queue-revision-conflict');
});

test('queue actions require the parent owner, full queued ID set, and a concrete revision', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const plan = (await f.plan('root', 3)).plans[0];
  await assert.rejects(f.queue({ action: 'start', planId: plan.id, taskId: 'task-1', expectedRevision: plan.revision }, { ...OWNER, sub: 'another-user' }), error => error.code === 'research-session-parent-not-found');
  await assert.rejects(f.queue({ action: 'reorder', planId: plan.id, taskIds: ['task-2', 'task-1'] }), error => error.code === 'research-queue-revision-required');
  await assert.rejects(f.queue({ action: 'reorder', planId: plan.id, expectedRevision: plan.revision, taskIds: ['task-0', 'task-1'] }), error => error.code === 'research-queue-order-invalid');
  assert.equal(f.spawns.length, 1);
});

test('a failed queue write changes neither memory order nor process creation', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const plan = (await f.plan('root', 4)).plans[0];
  f.failWrite();
  await assert.rejects(f.queue({ action: 'reorder', planId: plan.id, expectedRevision: plan.revision, taskIds: ['task-3', 'task-2', 'task-1'] }), /synthetic write failure/);
  const after = (await f.status()).plans[0];
  assert.equal(after.revision, plan.revision);
  assert.deepEqual(after.tasks.filter(task => task.status === 'queued').map(task => task.id), ['task-1', 'task-2', 'task-3']);
  assert.equal(f.spawns.length, 1);
});

test('detach cancels pending only and a previously running child may still report', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  await f.plan('root', 4);
  f.denied.add('root'); await f.suspend(['root']);
  await f.tick();
  assert.equal(f.spawns.length, 1);
  let plan = f.records()[0];
  assert.equal(plan.tasks[0].status, 'running');
  assert.ok(plan.tasks.slice(1).every(task => task.status === 'blocked'));
  await f.report('child-1');
  plan = f.records()[0];
  assert.equal(plan.tasks[0].status, 'completed');
  assert.equal(plan.status, 'blocked');
  await assert.rejects(f.plan('root', 2, 'after-detach'), error => error.code === 'research-collaboration-detached');
});

test('switch and re-promote preserve historical plans, reject old queues, and allow a fresh idempotency scope', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const old = (await f.plan('root', 3, 'same-client-id')).plans[0];
  f.policy.tenureId = 'tenure-2';
  await f.suspend(['root']);
  const current = (await f.plan('root', 3, 'same-client-id')).plans[0];
  assert.notEqual(current.id, old.id);
  assert.equal(current.tenureId, 'tenure-2');
  assert.equal((await f.status()).plans.length, 1, 'current root status excludes historical tenure plans');
  assert.equal(f.list().length, 2, 'history remains available for UI grouping');
  await assert.rejects(f.queue({ action: 'start', planId: old.id, taskId: 'task-1', expectedRevision: old.revision }), error => error.code === 'research-dispatch-tenure-changed');
  await f.report('child-1');
  assert.equal(f.spawns.length, 2, 'old completion releases capacity for current work only');
  assert.equal(f.spawns.at(-1).tenureId, 'tenure-2');
});

test('a promoted former Multi-agent becomes the new lineage root and gets the Main concurrency limit', async t => {
  const f = fixture(t);
  await f.plan('root', 2);
  f.policy.mainSessionId = 'child-1'; f.policy.tenureId = 'tenure-2';
  await f.suspend(['root']);
  const current = await f.plan('child-1', 5, 'new-tenure-plan');
  assert.equal(current.collaborator, false);
  assert.equal(current.assignment, null);
  assert.equal(current.plans[0].concurrency, 4);
  assert.equal(current.plans[0].rootSessionId, 'child-1');
  const children = f.spawns.filter(p => p.tenureId === 'tenure-2');
  assert.equal(children.length, 4);
  assert.ok(children.every(p => p.rootSessionId === 'child-1' && p.depth === 1));
});

test('detaching during asynchronous spawn preparation prevents crossing the process boundary', async t => {
  let release, entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = fixture(t, { policy: { maxMultiAgents: 1 }, beforeSpawn: async () => { entered(); await gate; } });
  const pending = f.plan('root', 3);
  await waiting;
  f.denied.add('root'); release();
  const result = await pending;
  assert.equal(f.spawns.length, 0);
  assert.ok(result.plans[0].tasks.every(task => task.status === 'blocked'));
  assert.equal(f.refs.size, 0, 'known preflight denial cleans pending provenance');
});

test('direct and queued launches share live limits and concurrent direct calls cannot over-admit', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 2 } });
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => f.direct('root', `direct-request-${i}`)));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 2);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => result.reason.code === 'research-session-concurrency-limit'));
  const plan = (await f.plan('root', 3)).plans[0];
  assert.ok(plan.tasks.every(task => task.status === 'queued'));
  f.policy.maxMultiAgents = 3; await f.tick();
  assert.equal(f.spawns.length, 3);
});

test('lowering a limit during preflight is rechecked before spawning', async t => {
  let calls = 0;
  const f = fixture(t, { policy: { maxMultiAgents: 3 }, beforeSpawn: () => { if (++calls === 2) f.policy.maxMultiAgents = 1; } });
  const result = await f.plan('root', 4);
  assert.equal(f.spawns.length, 1);
  assert.equal(result.plans[0].tasks.filter(task => task.status === 'queued').length, 3);
});

test('resource admission is a resumable wait, not a fabricated failed scientific result', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  f.memory(0);
  const plan = (await f.plan('root', 3)).plans[0];
  assert.ok(plan.tasks.every(task => task.status === 'queued' && task.waitingReason === 'research-session-memory-limit'));
  assert.equal(f.spawns.length, 0);
  await f.tick();
  assert.equal((await f.status()).plans[0].revision, plan.revision, 'known capacity retries do not invalidate every drag revision');
  f.memory(8 * 1024 ** 3); await f.tick();
  assert.equal(f.spawns.length, 1);
});

test('completed history does not impose a cumulative 24-task research budget', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  let reported = 0;
  for (let batch = 0; batch < 3; batch++) {
    await f.plan('root', 12, `batch-${batch}`);
    for (let i = 0; i < 12; i++) {
      const id = `child-${++reported}`;
      await f.report(id);
      f.row(id).status = 'ended';
    }
  }
  assert.equal(f.spawns.length, 36);
  assert.ok(f.records().every(plan => plan.status === 'completed'));
  const status = await f.status();
  assert.equal(status.plans.length, 2);
  assert.equal(status.planHistory.total, 3);
  assert.equal(status.planHistory.counts.completed, 36);
  const older = await f.lookup('root', 'batch-0');
  assert.equal(older.plans.length, 1);
  assert.equal(older.plans[0].clientPlanId, 'batch-0');
});

test('a child may explicitly select its parent plan for a prerequisite without seeing siblings', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const tasks = jobs(3); tasks[1].dependsOn = ['task-0']; tasks[2].dependsOn = ['task-1'];
  const plan = (await f.plan('root', 3, 'dependencies', tasks)).plans[0];
  await f.report('child-1');
  const receipt = await f.lookup('child-2', plan.id);
  assert.equal(receipt.plans.length, 0);
  assert.deepEqual(receipt.assignment.dependencies.map(task => task.id), ['task-0']);
  await assert.rejects(f.lookup('child-2', 'unknown-plan'), error => error.code === 'research-dispatch-plan-not-found');
});

test('unknown process outcome keeps its reservation through restart and priority actions cannot duplicate it', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 }, register: false, unknownOutcome: true });
  let plan = (await f.plan('root', 3)).plans[0];
  assert.equal(plan.tasks[0].status, 'recovery-required');
  assert.equal(f.spawns.length, 1);
  f.reboot();
  plan = (await f.status()).plans[0];
  await f.queue({ action: 'start', planId: plan.id, taskId: 'task-2', expectedRevision: plan.revision });
  assert.equal(f.spawns.length, 1);
});

test('a direct unregistered spawn has durable idempotency even without a dispatcher plan', async t => {
  const f = fixture(t, { register: false, unknownOutcome: true, policy: { maxMultiAgents: 1 } });
  await assert.rejects(f.direct('root', 'direct-unknown-request'), error => error.code === 'research-session-spawn-outcome-unknown');
  assert.equal(f.spawns.length, 1);
  assert.equal(f.records().length, 0, 'this reproduction has no dispatcher ledger to protect it');
  f.reboot();
  await assert.rejects(f.direct('root', 'direct-unknown-request'), error => error.code === 'research-session-spawn-outcome-unknown');
  await assert.rejects(f.direct('root', 'another-direct-request'), error => error.code === 'research-session-concurrency-limit');
  assert.equal(f.spawns.length, 1, 'unknown launch and its shared slot survive process-service restart');
});

test('a successful direct launch pending registration replays its original token across restart', async t => {
  const f = fixture(t, { register: false, policy: { maxMultiAgents: 1 } });
  const launched = await f.direct('root', 'direct-pending-request');
  f.reboot();
  const replay = await f.direct('root', 'direct-pending-request');
  assert.equal(replay.spawnToken, launched.spawnToken);
  assert.equal(replay.registration, 'pending');
  assert.equal(f.spawns.length, 1);
  await assert.rejects(f.direct('root', 'direct-another-pending'), error => error.code === 'research-session-concurrency-limit');
});

test('first upgrade holds legacy queues until explicit main selection and imports only that proven subtree', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1, tenureId: undefined } });
  const legacy = (await f.plan('root', 3, 'legacy-client-plan')).plans[0];
  const oldToken = f.spawns[0].spawnToken;
  f.policy.mainSessionId = null; f.reboot();
  await f.report('child-1');
  let stored = f.records()[0];
  assert.equal(f.spawns.length, 1, 'no main selected means no new worker launch');
  assert.equal(stored.tasks[0].status, 'completed');
  assert.ok(stored.tasks.slice(1).every(task => task.status === 'queued' && task.waitingReason === 'main-agent-not-selected'));
  f.policy.mainSessionId = 'root'; f.policy.tenureId = 'tenure-import'; f.policy.importLegacy = true;
  await f.tick();
  stored = f.records()[0];
  assert.equal(stored.id, legacy.id, 'legacy plan identity is not rewritten or duplicated');
  assert.equal(stored.tenureId, 'tenure-import');
  assert.equal(stored.importedLegacy, true);
  assert.equal(stored.tasks[0].spawnToken, oldToken);
  assert.equal(stored.tasks[0].status, 'completed');
  assert.equal(f.spawns.length, 2);
  assert.equal(f.spawns[1].tenureId, 'tenure-import');
  const replay = await f.plan('root', 3, 'legacy-client-plan');
  assert.equal(replay.plans[0].id, legacy.id);
  assert.equal(f.records().length, 1);
});

test('a delayed historical suspension cannot freeze a newer tenure using the same parent session', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  const old = (await f.plan('root', 3, 'old-plan')).plans[0];
  f.policy.tenureId = 'tenure-2';
  const fresh = (await f.plan('root', 3, 'new-plan')).plans[0];
  await f.suspend(['root'], 'tenure-1');
  const stored = f.records().find(plan => plan.id === fresh.id);
  assert.ok(stored.tasks.every(task => task.status === 'queued'));
  assert.notEqual(stored.suspendedReason, 'research-collaboration-detached');
  assert.ok(f.records().find(plan => plan.id === old.id).tasks.slice(1).every(task => task.status === 'blocked'));
});

test('identical caller request ids from different parents cannot collapse host process reservations', async t => {
  const options = { maxTotal: 4 };
  const f = fixture(t, options);
  await f.plan('root', 2);
  options.register = false;
  await f.direct('child-1', 'same-request-id');
  await f.direct('child-2', 'same-request-id');
  assert.equal(f.spawns.length, 4);
  await assert.rejects(f.direct('child-1', 'another-request-id'), error => error.code === 'research-session-capacity-limit');
  f.reboot();
  await assert.rejects(f.direct('child-2', 'last-request-id'), error => error.code === 'research-session-capacity-limit');
  assert.equal(f.spawns.length, 4);
});

test('cold-start placeholders retain their process seats beyond the reattachment grace time', async t => {
  const f = fixture(t, { policy: { maxMultiAgents: 1 } });
  await f.plan('root', 3);
  Object.assign(f.row('child-1'), { status: 'ended', dataUnavailable: true });
  f.reboot(); f.advanceClock(300_000); await f.tick();
  let task = f.records()[0].tasks[0];
  assert.equal(task.status, 'recovery-required');
  assert.equal(task.error, 'research-dispatch-worker-recovery-required');
  assert.equal(f.spawns.length, 1);
  await assert.rejects(f.direct('root', 'after-reattach-grace'), error => error.code === 'research-session-concurrency-limit');
  Object.assign(f.row('child-1'), { status: 'idle', dataUnavailable: false });
  await f.tick();
  task = f.records()[0].tasks[0];
  assert.equal(task.status, 'running');
  await f.report('child-1');
  assert.equal(f.spawns.length, 2, 'only an explicit terminal receipt frees the seat');
});

test('native direct tool returns an unknown request reference that can be retried unchanged after server restart', async t => {
  const f = fixture(t, { register: false, unknownOutcome: true });
  const bodies = [];
  const makeTool = () => createResearchSessionTool({ registerTool() {} }, {
    readContext: async () => ({ sessionId: 'root', charterHash: CHARTER }),
    resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:1234', token: 'synthetic-local-token' }),
    requestId: () => 'stable-tool-request',
    fetchImpl: async (_url, input) => {
      const body = JSON.parse(input.body); bodies.push(body);
      try { return Response.json(await f.create(body)); }
      catch (error) { return Response.json({ code: error.code }, { status: error.statusCode ?? 503 }); }
    },
  });
  const ctx = { cwd: f.row('root').cwd, sessionManager: { getSessionId: () => 'root' } };
  const params = { role: 'researcher', task: 'An unchanged direct task', stage: '2-experiment' };
  const first = await makeTool().execute('first-model-call', params, undefined, undefined, ctx);
  assert.equal(first.details.error, 'research-session-spawn-outcome-unknown');
  assert.equal(first.details.requestId, 'stable-tool-request');
  assert.match(first.details.hint, /SAME requestId/);
  f.reboot();
  const retried = await makeTool().execute('new-model-call', { ...params, requestId: first.details.requestId, model: 'untrusted-provider/model', cwd: '/untrusted-host-path' }, undefined, undefined, ctx);
  assert.equal(retried.details.error, 'research-session-spawn-outcome-unknown');
  assert.equal(f.spawns.length, 1);
  assert.equal(bodies[1].requestId, bodies[0].requestId);
  assert.deepEqual(Object.keys(bodies[1]).sort(), ['parentSessionId', 'requestId', 'role', 'stage', 'task']);
});
