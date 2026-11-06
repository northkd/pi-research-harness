import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchSessionService } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';
import { createResearchDispatchService, createResearchDispatchStore, RESEARCH_DISPATCH_LIMITS } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';

const CHARTER = 'sha256:' + 'a'.repeat(64);
const ADOPTION = 'adopt-' + 'b'.repeat(24);
const OWNER = Object.freeze({ iss: 'review-fixture', sub: 'operator' });
const jobs = (count = 2, task = 'Bounded independent research task') => Array.from({ length: count }, (_, index) => ({
  id: `task-${index}`, role: 'researcher', task: `${task}${index}`, stage: '2-experiment',
}));

/** Real session admission and disk persistence; only process creation, membership
 * verification and the websocket transport are replaced. No provider/model runs. */
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'dispatch-review-'));
  const cwd = path.join(directory, 'project');
  fs.mkdirSync(cwd);
  let at = Date.parse('2026-11-06T00:00:00.000Z'), tokenSequence = 0, sessionSequence = 0;
  let dispatcher, sessionService, peakWorkers = 0, failReceiptWrite = false;
  const sessions = [{ id: 'root', cwd, principalOwner: OWNER, status: 'idle', live: true }];
  const filed = new Map(), spawns = [], notices = [], released = [];
  const disk = createResearchDispatchStore(path.join(directory, 'private', 'dispatch'));
  const store = {
    readAll: () => disk.readAll(),
    write(record) {
      if (failReceiptWrite && record.tasks.some(task => task.reportedAt)) {
        failReceiptWrite = false;
        throw new Error('synthetic receipt write failure');
      }
      disk.write(record);
    },
  };
  const workers = () => sessions.filter(session => session.researchSession && !['ended', 'closed', 'archived'].includes(session.status)
    && !dispatcher.isCompleted(session.researchSession.spawnToken) && !dispatcher.isWaitingCoordinator(session.id)).length;
  function register(token) {
    const provenance = filed.get(token)?.researchSession;
    assert.ok(provenance, 'a real spawn must have filed its provenance first');
    const existing = sessions.find(session => session.researchSession?.spawnToken === token);
    if (existing) return existing;
    const row = { id: `child-${++sessionSequence}`, cwd, principalOwner: OWNER, status: 'idle', live: true, researchSession: structuredClone(provenance) };
    sessions.push(row);
    peakWorkers = Math.max(peakWorkers, workers());
    return row;
  }
  function boot() {
    sessionService = createResearchSessionService({
      getSession: id => sessions.find(session => session.id === id), listSessions: () => sessions,
      verifyParent: async () => ({ cwd, charterHash: CHARTER, adoptionId: ADOPTION, ownerKey: JSON.stringify([OWNER.iss, OWNER.sub]) }),
      prepareSpawn: async (_cwd, _identity, verified) => ({ researchSession: verified.researchSession }),
      pendingPluginRefRegistry: { file: (token, ref) => { filed.set(token, ref); return true; }, remove: token => filed.delete(token) },
      pendingPrincipalOwnerRegistry: { file: () => true, remove: () => {} },
      initialPrompts: { enqueue: () => true, remove: () => true },
      spawn: async (_cwd, { spawnToken }) => {
        spawns.push(spawnToken);
        if (options.register !== false) register(spawnToken);
        return { success: true };
      },
      isLocalOperator: () => false, now: () => new Date(at), mintToken: () => `review-token-${++tokenSequence}`,
      // Memory admission is deterministic on both small CI containers and large hosts.
      availableMemory: () => 8 * 1024 ** 3,
      isCompleted: token => dispatcher?.isCompleted(token) ?? false,
      isWaitingCoordinator: id => dispatcher?.isWaitingCoordinator(id) ?? false,
      isRecoveringSession: session => dispatcher?.isRecoveringSession(session) ?? false,
      unregisteredReservations: () => dispatcher?.unregisteredReservations() ?? [],
    });
    dispatcher = createResearchDispatchService({
      store, getSession: id => sessions.find(session => session.id === id), listSessions: () => sessions,
      authorize: sessionService.authorize, createSession: sessionService.create,
      releaseSession: token => { released.push(token); sessionService.release(token); },
      principalForSession: session => session?.principalOwner ?? null,
      beforeLaunch: options.beforeLaunch,
      now: () => new Date(at),
      notifyParent: (sessionId, text, promptId) => { notices.push({ sessionId, text, promptId }); return true; },
    });
  }
  boot();
  t.after(() => { dispatcher.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (sessionId, body) => dispatcher.handle({ principal: OWNER, body: { sessionId, ...body } });
  return {
    sessions, spawns, notices, released, register,
    request, status: id => request(id, { action: 'status' }),
    plan: (id, planId, tasks = jobs(), concurrency = 2) => request(id, { action: 'plan', planId, tasks, concurrency }),
    report: (id, status = 'completed', summary = 'Measured result', evidence = []) => request(id, { action: 'report', status, summary, evidence }),
    records: () => disk.readAll(), tick: () => dispatcher.tick(),
    acknowledge: (id, promptId) => dispatcher.acknowledgeReceipt(id, promptId),
    reservations: () => dispatcher.unregisteredReservations(), completed: token => dispatcher.isCompleted(token),
    advanceClock: milliseconds => { at += milliseconds; },
    reboot: () => { dispatcher.dispose(); boot(); },
    failNextReceiptWrite: () => { failReceiptWrite = true; },
    peakWorkers: () => peakWorkers,
  };
}

test('persisted root replay does not duplicate children or promote idle and failed work to success', async t => {
  const f = fixture(t);
  const first = await f.plan('root', 'root-plan');
  await f.plan('child-1', 'nested-plan');
  await assert.rejects(f.report('child-1'), error => error.code === 'research-dispatch-children-pending');
  f.reboot();
  const restored = await f.status('root');
  assert.equal(restored.plans[0].status, 'running');
  assert.equal(restored.childrenPending, true);
  assert.equal(f.spawns.length, 4);
  const replay = await f.plan('root', 'root-plan');
  assert.equal(replay.plans[0].id, first.plans[0].id);
  assert.equal(f.spawns.length, 4);
  await f.report('child-3', 'failed', 'Dependency failed with measured evidence');
  await f.report('child-4');
  await assert.rejects(f.report('child-1'), error => error.code === 'research-dispatch-child-failure-unresolved');
  await f.report('child-1', 'failed', 'Nested dependency failed');
  await f.report('child-2');
  const settled = await f.status('root');
  assert.equal(settled.plans[0].status, 'failed');
  assert.equal(settled.childrenPending, false);
});

test('three levels of coordinators leave runnable capacity for leaves and remain globally bounded', async t => {
  const f = fixture(t);
  await f.plan('root', 'root-fanout', jobs(3), 3);
  const first = f.sessions.filter(row => row.researchSession?.depth === 1);
  for (const session of first) await f.plan(session.id, `split-${session.id}`);
  const second = f.sessions.filter(row => row.researchSession?.depth === 2);
  assert.equal(second.length, 6);
  for (const session of second) await f.plan(session.id, `split-${session.id}`);
  assert.ok(f.sessions.some(row => row.researchSession?.depth === 3), 'waiting coordinators must not consume every runnable slot');
  const leafAtLimit = f.sessions.find(row => row.researchSession?.depth === 3), beforeDepthCheck = f.spawns.length;
  await assert.rejects(f.plan(leafAtLimit.id, 'too-deep'), error => error.code === 'research-session-depth-limit');
  assert.equal(f.spawns.length, beforeDepthCheck);
  const reported = new Set();
  for (let turn = 0; turn < 24; turn++) {
    const leaf = f.sessions.find(row => row.researchSession?.depth === 3 && !reported.has(row.id));
    if (!leaf) break;
    reported.add(leaf.id);
    await f.report(leaf.id);
  }
  assert.equal(reported.size, 12, 'queued leaves must eventually acquire released slots');
  for (const session of second) await f.report(session.id);
  for (const session of first) await f.report(session.id);
  assert.equal((await f.status('root')).plans[0].status, 'completed');
  assert.equal(f.spawns.length, 21);
  assert.ok(f.peakWorkers() <= 8, `runnable worker limit exceeded: ${f.peakWorkers()}`);
  await assert.rejects(f.plan(leafAtLimit.id, 'after-completion'), error => error.code === 'research-dispatch-upstream-terminal');
  assert.equal(f.spawns.length, 21);
});

test('maximum permitted UTF-8 task reports remain durable and readable after restart', async t => {
  const f = fixture(t);
  const tasks = jobs(12).map(task => ({ ...task, task: '研'.repeat(4000) }));
  const summary = '结'.repeat(4000);
  const evidence = Array.from({ length: 16 }, (_, index) => `proofs/${index}-${'证'.repeat(1000)}`);
  await f.plan('root', 'max-receipts', tasks, 3);
  for (let index = 1; index <= 12; index++) await f.report(`child-${index}`, 'completed', summary, evidence);
  f.reboot();
  const [plan] = f.records();
  assert.equal(plan.status, 'completed');
  assert.equal(plan.tasks.length, 12);
  assert.ok(plan.tasks.every(task => task.summary === summary && JSON.stringify(task.evidence) === JSON.stringify(evidence)));
  assert.equal((await f.status('root')).plans[0].status, 'completed');
  assert.equal(f.spawns.length, 12);
});

test('a failed receipt write does not publish completion or release its worker slot', async t => {
  const f = fixture(t);
  await f.plan('root', 'durable-report');
  const token = f.sessions.find(row => row.id === 'child-1').researchSession.spawnToken;
  f.failNextReceiptWrite();
  await assert.rejects(f.report('child-1'), /synthetic receipt write failure/);
  assert.equal(f.completed(token), false);
  assert.equal(f.released.length, 0);
  assert.equal(f.records()[0].tasks[0].status, 'running');
  await f.report('child-1');
  assert.equal(f.completed(token), true);
  assert.deepEqual(f.released, [token]);
});

test('unconfirmed registration survives restart without another process and ends as blocked after grace', async t => {
  const f = fixture(t, { register: false });
  await f.plan('root', 'unconfirmed-plan');
  assert.equal(f.spawns.length, 2);
  f.reboot();
  await f.tick();
  assert.equal(f.spawns.length, 2);
  assert.equal(f.reservations().length, 2);
  f.advanceClock(RESEARCH_DISPATCH_LIMITS.registrationGraceMs + 1);
  await f.tick();
  const status = await f.status('root');
  assert.equal(status.plans[0].status, 'blocked');
  assert.ok(status.plans[0].tasks.every(task => task.error === 'research-dispatch-registration-unconfirmed'));
  assert.equal(f.reservations().length, 2, 'no proof of process exit means no returned process capacity');
  assert.equal(f.spawns.length, 2);
});

test('an explicitly ended worker becomes a failed receipt rather than eternal running or success', async t => {
  const f = fixture(t);
  await f.plan('root', 'worker-exit');
  const worker = f.sessions.find(row => row.id === 'child-1');
  Object.assign(worker, { status: 'ended', live: false, dataUnavailable: false, closedReason: 'crash' });
  await f.tick();
  await f.report('child-2');
  const status = await f.status('root');
  assert.equal(status.plans[0].status, 'failed');
  assert.equal(status.plans[0].tasks[0].error, 'research-dispatch-worker-ended-without-report');
  assert.equal(f.spawns.length, 2);
});

test('a successful websocket send retries until the owning coordinator acknowledges the durable receipt', async t => {
  const f = fixture(t);
  await f.plan('root', 'ack-plan');
  await f.report('child-1');
  await f.report('child-2');
  assert.equal(f.notices.length, 1);
  const notice = f.notices[0];
  assert.equal(f.records()[0].notifiedAt, undefined, 'socket send is not a delivery acknowledgement');
  await f.acknowledge('another-session', notice.promptId);
  f.advanceClock(RESEARCH_DISPATCH_LIMITS.receiptRetryMs + 1);
  await f.tick();
  assert.equal(f.notices.length, 2);
  assert.equal(f.notices[1].promptId, notice.promptId);
  await f.acknowledge('root', notice.promptId);
  assert.ok(f.records()[0].notifiedAt);
  f.reboot();
  f.advanceClock(RESEARCH_DISPATCH_LIMITS.receiptRetryMs + 1);
  await f.tick();
  assert.equal(f.notices.length, 2);
});

test('cold-start ended placeholders may reattach without failing the persisted plan', async t => {
  const f = fixture(t);
  await f.plan('root', 'reattach-plan');
  // server.ts intentionally restores live sessions as ended/dataUnavailable
  // before a surviving Pi process can reconnect after a dashboard restart.
  for (const session of f.sessions) Object.assign(session, { status: 'ended', dataUnavailable: true });
  f.reboot();
  f.advanceClock(1000);
  await f.tick();
  assert.equal(f.records()[0].status, 'running', 'cold-start placeholders are not witnessed process exits');
  for (const session of f.sessions) Object.assign(session, { status: 'idle', dataUnavailable: false });
  await f.tick();
  const status = await f.status('root');
  assert.equal(status.plans[0].status, 'running');
  assert.ok(status.plans[0].tasks.every(task => task.status === 'running'));
  assert.equal(f.spawns.length, 2);
});

test('a pre-launch permission refusal cannot reserve a nonexistent process after restart', async t => {
  let allowed = false;
  const f = fixture(t, { beforeLaunch: () => {
    if (!allowed) throw Object.assign(new Error('Authorization revoked before launch'), { code: 'task-permissions-authorization-revoked', statusCode: 409 });
  } });
  const refused = await f.plan('root', 'refused-plan');
  assert.equal(refused.plans[0].status, 'blocked');
  assert.ok(refused.plans[0].tasks.every(task => task.error === 'task-permissions-authorization-revoked'));
  assert.equal(f.spawns.length, 0);
  assert.equal(f.reservations().length, 0);
  f.reboot();
  assert.equal(f.reservations().length, 0);
  allowed = true;
  await f.plan('root', 'newly-authorized-plan');
  assert.equal(f.spawns.length, 2);
});

test('cancelling a coordinator stops queued descendants without claiming running workers exited', async t => {
  const f = fixture(t);
  await f.plan('root', 'root-cancel', jobs(), 1);
  await f.plan('child-1', 'nested-cancel', jobs(), 1);
  assert.equal(f.spawns.length, 2);
  await f.request('root', { action: 'cancel', planId: 'root-cancel', reason: 'This research branch was withdrawn' });
  await f.tick();
  assert.equal(f.spawns.length, 2, 'cancellation must not start queued grandchildren');
  assert.ok(f.records().every(plan => plan.status === 'blocked'));
  const token = f.sessions.find(row => row.id === 'child-2').researchSession.spawnToken;
  assert.equal(f.completed(token), false, 'a cancelled ledger is not proof of process termination');
  await assert.rejects(f.plan('child-1', 'restart-cancelled-child'), error => error.code === 'research-dispatch-upstream-terminal');
});

test('cancelling an unregistered spawn retains its unknown process reservation across restart', async t => {
  const f = fixture(t, { register: false });
  await f.plan('root', 'unregistered-cancel');
  await f.request('root', { action: 'cancel', planId: 'unregistered-cancel', reason: 'Stop scheduling, preserving unknown process accounting' });
  assert.equal(f.reservations().length, 2);
  f.reboot();
  assert.equal(f.reservations().length, 2);
  f.advanceClock(RESEARCH_DISPATCH_LIMITS.registrationGraceMs + 1);
  await f.tick();
  assert.equal(f.spawns.length, 2);
  assert.equal(f.reservations().length, 2);
});
