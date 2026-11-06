import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchSessionService } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';
import { createResearchDispatchService, createResearchDispatchStore, RESEARCH_DISPATCH_LIMITS } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';

const OWNER = Object.freeze({ iss: 'delegation-fixture', sub: 'operator' });
const CHARTER = 'sha256:' + 'c'.repeat(64), ADOPTION = 'adopt-' + 'd'.repeat(24);
const OBJECTIVE = 'Inspect the image pipeline, run independent implementation and regression checks, then return the measured findings and evidence.';
const jobs = () => [
  { id: 'inspect', role: 'reviewer', task: 'Inspect the image pipeline and record evidence.', stage: '3-review' },
  { id: 'verify', role: 'verifier', task: 'Verify the findings against the regression fixtures.', stage: '3-review', dependsOn: ['inspect'] },
];

/** Exercise actual session admission, ancestry, scheduler and fsync storage.
 * Only process creation, membership proof and the notification transport are
 * fixtures; this does not claim to validate a model's semantic decomposition. */
function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'delegated-objective-'));
  const cwd = path.join(directory, 'project');
  fs.mkdirSync(cwd);
  const sessions = [{ id: 'root', cwd, status: 'idle', principalOwner: OWNER }];
  const refs = new Map(), spawns = [], notices = [], launches = [];
  const disk = createResearchDispatchStore(path.join(directory, 'private', 'dispatch'));
  let dispatcher, service, tokenSequence = 0, at = Date.parse('2026-11-06T12:00:00.000Z');
  const row = id => sessions.find(session => session.id === id);
  function boot() {
    service = createResearchSessionService({
      getSession: row, listSessions: () => sessions,
      verifyParent: async () => ({ cwd, charterHash: CHARTER, adoptionId: ADOPTION, ownerKey: JSON.stringify([OWNER.iss, OWNER.sub]) }),
      prepareSpawn: async (_cwd, _identity, verified) => ({ researchSession: verified.researchSession }),
      pendingPluginRefRegistry: { file: (token, ref) => { refs.set(token, ref); return true; }, remove: token => refs.delete(token) },
      pendingPrincipalOwnerRegistry: { file: () => true, remove: () => {} },
      initialPrompts: { enqueue: () => true, remove: () => true },
      spawn: async (_cwd, { spawnToken }) => {
        spawns.push(spawnToken);
        if (options.register !== false) sessions.push({
          id: `child-${spawns.length}`, cwd, status: 'idle', principalOwner: OWNER,
          researchSession: structuredClone(refs.get(spawnToken).researchSession),
        });
        return { success: true };
      },
      isLocalOperator: () => false, now: () => new Date(at), mintToken: () => `delegated-token-${++tokenSequence}`,
      availableMemory: () => 8 * 1024 ** 3,
      isCompleted: token => dispatcher?.isCompleted(token) ?? false,
      isWaitingCoordinator: id => dispatcher?.isWaitingCoordinator(id) ?? false,
      isRecoveringSession: session => dispatcher?.isRecoveringSession(session) ?? false,
      unregisteredReservations: () => dispatcher?.unregisteredReservations() ?? [],
    });
    dispatcher = createResearchDispatchService({
      store: disk, getSession: row, listSessions: () => sessions,
      authorize: service.authorize,
      createSession: input => { launches.push(structuredClone(input.body)); return service.create(input); },
      releaseSession: service.release, principalForSession: session => session?.principalOwner ?? null,
      beforeLaunch: options.beforeLaunch, now: () => new Date(at),
      notifyParent: (sessionId, text, promptId) => { notices.push({ sessionId, text, promptId }); return true; },
    });
  }
  boot();
  t.after(() => { dispatcher.dispose(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = (sessionId, body, principal = OWNER) => dispatcher.handle({ principal, body: { sessionId, ...body } });
  return {
    sessions, spawns, notices, launches, row, disk, request,
    status: id => request(id, { action: 'status' }),
    delegate: (planId = 'objective-one', fields = {}) => request('root', { action: 'delegate', planId, task: OBJECTIVE, stage: '3-review', ...fields }),
    plan: (sessionId, planId = 'work-plan', tasks = jobs(), fields = {}) => request(sessionId, { action: 'plan', planId, tasks, ...fields }),
    report: (sessionId, status = 'completed', summary = 'Measured result', evidence = []) => request(sessionId, { action: 'report', status, summary, evidence }),
    tick: () => dispatcher.tick(), reservations: () => dispatcher.unregisteredReservations(),
    advanceClock: ms => { at += ms; }, reboot: () => { dispatcher.dispose(); boot(); },
  };
}

test('joined roots require an explicit dispatch or atomic decision before their first bulk task', async t => {
  const f = fixture(t);
  const before = await f.status('root');
  assert.equal(before.collaborator, false);
  assert.equal(before.brief, null);
  assert.equal(before.decisionRequired, true);
  assert.equal(before.childrenPending, false);
  assert.equal(f.spawns.length, 0);
  const atomic = await f.request('root', { action: 'atomic', reason: 'One bounded lookup in a known file.' });
  assert.equal(atomic.decisionRequired, false);
  assert.equal(f.spawns.length, 0);
});

test('a delegated objective has one real coordinator, then workers, then one root receipt', async t => {
  const f = fixture(t);
  const rootStart = await f.delegate();
  const rootPlan = rootStart.plans[0];
  assert.equal(rootStart.decisionRequired, false);
  assert.equal(rootStart.childrenPending, true);
  assert.equal(rootPlan.mode, 'delegate');
  assert.equal(rootPlan.clientPlanId, 'objective-one');
  assert.equal(rootPlan.concurrency, 1);
  assert.equal(rootPlan.tasks.length, 1, 'the wrapper must not fabricate a second task');
  assert.equal(f.spawns.length, 1);
  const coordinator = f.row('child-1');
  assert.equal(coordinator.researchSession.role, 'research-coordinator');
  assert.equal(coordinator.researchSession.parentSessionId, 'root');
  assert.equal(coordinator.researchSession.task, OBJECTIVE);
  assert.equal(coordinator.researchSession.depth, 1);
  const planning = await f.status(coordinator.id);
  assert.deepEqual(planning.brief, { task: OBJECTIVE, role: 'research-coordinator', stage: '3-review', readOnly: false });
  assert.equal(planning.assignment.planId, rootPlan.id);
  assert.equal(planning.assignment.taskId, 'coordinator');
  assert.equal(planning.decisionRequired, true);

  await f.plan(coordinator.id);
  assert.equal(f.spawns.length, 2, 'a dependency must wait for its actual prerequisite report');
  await assert.rejects(f.report(coordinator.id), error => error.code === 'research-dispatch-children-pending');
  await f.report('child-2', 'completed', 'LEAF_DETAIL_ONLY: inspected all call sites.', ['evidence/inspection.json']);
  assert.equal(f.spawns.length, 3);
  assert.equal(f.row('child-3').researchSession.parentSessionId, coordinator.id);
  assert.equal(f.row('child-3').researchSession.depth, 2);
  assert.match((await f.status('child-3')).assignment.dependencies[0].summary, /LEAF_DETAIL_ONLY/);
  await f.report('child-3', 'completed', 'LEAF_DETAIL_ONLY: regression checks passed.', ['evidence/tests.json']);
  assert.equal((await f.status('root')).plans[0].status, 'running', 'worker reports alone are not the coordinator result');
  assert.ok(f.notices.some(notice => notice.sessionId === coordinator.id));
  assert.equal(f.notices.some(notice => notice.sessionId === 'root'), false);

  await f.report(coordinator.id, 'completed', 'The implementation and regression evidence agree.', ['reports/final.md']);
  const rootEnd = await f.status('root');
  assert.equal(rootEnd.plans.length, 1);
  assert.equal(rootEnd.plans[0].tasks.length, 1);
  assert.equal(rootEnd.plans[0].status, 'completed');
  assert.equal(rootEnd.plans[0].tasks[0].summary, 'The implementation and regression evidence agree.');
  assert.deepEqual(rootEnd.plans[0].tasks[0].evidence, ['reports/final.md']);
  assert.equal(rootEnd.childrenPending, false);
  assert.doesNotMatch(JSON.stringify(rootEnd), /LEAF_DETAIL_ONLY/);
  assert.equal(f.notices.filter(notice => notice.sessionId === 'root').length, 1);
});

test('delegate is an internal one-task mode, while ordinary plans still require real multiple tasks', async t => {
  const f = fixture(t);
  await assert.rejects(f.plan('root', 'fake-single', jobs().slice(0, 1)), error => error.code === 'research-dispatch-task-count-invalid');
  for (const fields of [{ task: ' ' }, { task: 'x'.repeat(4001) }, { stage: 'unknown' }, { tasks: jobs() }, { concurrency: 2 }, { mode: 'tasks' }, { role: 'custom-worker' }]) {
    await assert.rejects(f.delegate('invalid', fields));
  }
  assert.equal(f.spawns.length, 0);
  const task = '研'.repeat(4000);
  await f.delegate('max-objective', { task });
  assert.equal(f.row('child-1').researchSession.task, task);
  assert.equal((await f.status('child-1')).brief.task, task, 'full original task remains available independently of startup prompt size');
});

test('delegate replay is durable and cannot change its objective, mode or constraint', async t => {
  const f = fixture(t);
  const first = await f.delegate('stable-objective');
  f.reboot();
  const replay = await f.delegate('stable-objective');
  assert.equal(replay.plans[0].id, first.plans[0].id);
  assert.equal(f.spawns.length, 1);
  await assert.rejects(f.delegate('stable-objective', { task: 'A different objective' }), error => error.code === 'research-dispatch-idempotency-conflict');
  await assert.rejects(f.delegate('stable-objective', { readOnly: true }), error => error.code === 'research-dispatch-idempotency-conflict');
  await assert.rejects(f.plan('root', 'stable-objective'), error => error.code === 'research-dispatch-idempotency-conflict');
  assert.equal(f.spawns.length, 1);
  await f.plan('child-1');
  f.reboot();
  await f.report('child-2');
  await f.report('child-3');
  await f.report('child-1', 'completed', 'Restored coordinator aggregated both reports.', ['reports/final.md']);
  assert.equal((await f.status('root')).plans[0].status, 'completed');
  assert.equal(f.spawns.length, 3);
});

test('ordinary pre-mode plans retain stable replay after the new coordinator mode is installed', async t => {
  const f = fixture(t);
  const first = await f.plan('root', 'legacy-plan');
  const legacy = f.disk.readAll().find(row => row.parentSessionId === 'root');
  delete legacy.mode;
  f.disk.write(legacy);
  f.reboot();
  const replay = await f.plan('root', 'legacy-plan');
  assert.equal(replay.plans[0].id, first.plans[0].id);
  assert.equal(replay.plans[0].mode, 'tasks');
  assert.equal(f.spawns.length, 1, 'the second job still waits for its prerequisite; replay creates neither again');
});

test('failed workers require a truthful coordinator failure and never a successful root receipt', async t => {
  const f = fixture(t);
  await f.delegate();
  await f.plan('child-1');
  await f.report('child-2', 'failed', 'The implementation check failed with measured evidence.', ['evidence/failure.json']);
  assert.equal(f.spawns.length, 2, 'dependent work must not launch on a failed prerequisite');
  await assert.rejects(f.report('child-1'), error => error.code === 'research-dispatch-child-failure-unresolved');
  await f.report('child-1', 'failed', 'The prerequisite failed; verification was not run.', ['reports/failure.md']);
  const root = await f.status('root');
  assert.equal(root.plans[0].status, 'failed');
  assert.equal(root.childrenPending, false);
  assert.match(root.plans[0].tasks[0].summary, /not run/);
});

test('root cancellation prevents queued descendants from launching after restart', async t => {
  const f = fixture(t);
  await f.delegate();
  await f.plan('child-1');
  assert.equal(f.spawns.length, 2);
  await f.request('root', { action: 'cancel', planId: 'objective-one', reason: 'The user cancelled this objective.' });
  f.reboot();
  await f.tick();
  assert.equal(f.spawns.length, 2);
  assert.equal((await f.status('root')).plans[0].status, 'blocked');
  const childPlan = (await f.status('child-1')).plans[0];
  assert.equal(childPlan.status, 'blocked');
  assert.ok(childPlan.tasks.every(task => task.status === 'blocked'));
  await assert.rejects(f.report('child-1'), error => error.code === 'research-dispatch-child-failure-unresolved');
});

test('an unregistered coordinator retains its reservation and is not relaunched on replay or reboot', async t => {
  const f = fixture(t, { register: false });
  await f.delegate();
  f.reboot();
  await f.delegate();
  assert.equal(f.spawns.length, 1);
  assert.equal(f.reservations().length, 1);
  f.advanceClock(RESEARCH_DISPATCH_LIMITS.registrationGraceMs + 1);
  await f.tick();
  const root = await f.status('root');
  assert.equal(root.plans[0].status, 'blocked');
  assert.equal(root.plans[0].tasks[0].error, 'research-dispatch-registration-unconfirmed');
  assert.equal(f.reservations().length, 1, 'a blocked result is not proof of process exit');
  assert.equal(f.spawns.length, 1);
});

test('delegate preserves owner authorization and known preflight failures allocate no process', async t => {
  const f = fixture(t, { beforeLaunch: async () => { throw Object.assign(new Error('revoked'), { code: 'task-permissions-authorization-revoked' }); } });
  await assert.rejects(f.request('root', { action: 'delegate', planId: 'wrong-owner', task: OBJECTIVE, stage: '3-review' }, { iss: OWNER.iss, sub: 'another-owner' }));
  assert.equal(f.disk.readAll().length, 0);
  const rejected = await f.delegate();
  assert.equal(rejected.plans[0].status, 'blocked');
  assert.equal(rejected.plans[0].tasks[0].error, 'task-permissions-authorization-revoked');
  assert.equal(f.spawns.length, 0);
  assert.equal(f.reservations().length, 0);
  f.reboot();
  await f.tick();
  assert.equal(f.spawns.length, 0);
});

test('read-only delegation narrows the coordinator and every descendant without a false override', async t => {
  const f = fixture(t);
  await assert.rejects(f.delegate('invalid-constraint', { readOnly: false }), error => error.code === 'research-dispatch-read-only-invalid');
  await f.delegate('read-only-objective', { readOnly: true });
  assert.equal(f.launches[0].readOnly, true);
  assert.equal(f.row('child-1').researchSession.readOnly, true);
  assert.equal((await f.status('child-1')).brief.readOnly, true);
  await assert.rejects(f.plan('child-1', 'unrestrict', jobs(), { readOnly: false }), error => error.code === 'research-dispatch-read-only-invalid');
  const plan = await f.plan('child-1');
  assert.equal(plan.plans[0].readOnly, true);
  assert.equal(f.launches[1].readOnly, true);
  assert.equal(f.row('child-2').researchSession.readOnly, true);
  f.reboot();
  await f.report('child-2');
  assert.equal(f.row('child-3').researchSession.readOnly, true);
  await assert.rejects(f.delegate('read-only-objective'), error => error.code === 'research-dispatch-idempotency-conflict');
});

test('ordinary read-only plans also fingerprint and propagate their narrowed constraint', async t => {
  const f = fixture(t);
  const plan = await f.plan('root', 'read-only-plan', jobs(), { readOnly: true });
  assert.equal(plan.plans[0].mode, 'tasks');
  assert.equal(plan.plans[0].readOnly, true);
  assert.equal(f.row('child-1').researchSession.readOnly, true);
  f.reboot();
  await f.plan('root', 'read-only-plan', jobs(), { readOnly: true });
  assert.equal(f.spawns.length, 1);
  await assert.rejects(f.plan('root', 'read-only-plan'), error => error.code === 'research-dispatch-idempotency-conflict');
});
