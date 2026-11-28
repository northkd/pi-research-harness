import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createResearchServices, ResearchSessionError } from '../index.mjs';

function fixture(t) {
  const privateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'research-services-composition-'));
  t.after(() => fs.rmSync(privateDir, { recursive: true, force: true }));
  const principal = { iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' };
  const scope = { cwd: '/synthetic/project', ownerKey: JSON.stringify([principal.iss, principal.sub]),
    adoptionId: 'adopt-' + 'a'.repeat(24), charterHash: 'sha256:' + 'b'.repeat(64) };
  const rows = [{ id: 'lead', cwd: scope.cwd, status: 'idle', principalOwner: principal,
    resWorkflow: { canonicalCwd: scope.cwd, joinedAt: new Date().toISOString(), via: 'manual' } }];
  const refs = new Map(), prompts = new Map(), notifications = [];
  let launches = 0, preflights = 0, acknowledgements, unsubscribed = 0, spawnOutcome = 'registered';
  const access = { ...scope, write: true, revalidate: async () => {}, canReadHistory: async row => row.cwd === scope.cwd };
  const deps = {
    privateDir,
    getSession: id => rows.find(row => row.id === id),
    listSessions: () => rows,
    principalForSession: row => row.principalOwner ?? principal,
    isLocalOperator: value => value === principal,
    verifyParent: async ({ parent }) => ({ ...scope, cwd: parent.cwd }),
    accessFor: async () => access,
    connection: async () => ({ adopted: true }),
    joinParticipant: async (_access, id) => {
      rows.find(row => row.id === id).resWorkflow = { canonicalCwd: scope.cwd, via: 'manual' };
    },
    detachParticipant: async (_access, id) => { delete rows.find(row => row.id === id).resWorkflow; },
    prepareSpawn: async () => ({}),
    pendingPluginRefRegistry: { file(token, value) { refs.set(token, value); return true; }, remove: token => refs.delete(token) },
    pendingPrincipalOwnerRegistry: { file: () => true, remove() {} },
    initialPrompts: { enqueue(_cwd, value, token) { prompts.set(token, value); return true; }, remove: (_cwd, token) => prompts.delete(token) },
    spawn: async (cwd, { spawnToken }) => {
      const id = 'worker-' + ++launches;
      if (spawnOutcome === 'unknown') throw new Error('synthetic process response lost');
      const researchSession = refs.get(spawnToken).researchSession;
      rows.push({ id, cwd, status: 'idle', principalOwner: principal, researchSession,
        nativeRegistrationConfirmed: spawnOutcome !== 'prepared', resWorkflow: { canonicalCwd: cwd, via: 'spawn' } });
      return { success: true, spawnToken, pid: 1000 + launches };
    },
    beforeLaunch: async () => { preflights++; },
    notifyParent: async (...args) => { notifications.push(args); return true; },
    subscribeReceiptAcks(handler) { acknowledgements = handler; return () => { unsubscribed++; }; },
  };
  let services = createResearchServices(deps);
  t.after(() => services.dispose());
  const f = {
    scope, principal, access, deps, rows, notifications, prompts,
    services: () => services,
    launches: () => launches,
    preflights: () => preflights,
    unsubscribed: () => unsubscribed,
    setSpawnOutcome: value => { spawnOutcome = value; },
    async restart() { services.dispose(); services = createResearchServices(deps); await services.tick(); },
    ack: (sessionId, promptId) => acknowledgements(sessionId, promptId),
    call: body => services.dispatch.handle({ body, principal }),
    async selectMain() {
      const snapshot = await services.collaboration.snapshot(access);
      const selected = await services.collaboration.mutate(access, {
        action: 'select-main', sessionId: 'lead', expectedRevision: snapshot.revision,
      }, { principal });
      await services.collaboration.mutate(access, { action: 'limits', expectedRevision: selected.revision,
        maxMultiAgents: 1, maxSubagents: 1 }, { principal });
    },
  };
  return f;
}

const tasks = ['one', 'two'].map(id => ({ id, role: 'research-worker', task: 'Synthetic bounded task ' + id,
  stage: '2-experiment', dependsOn: [] }));

test('queued peer mail survives restart and is delivered when a parent report frees its slot', async t => {
  const f = fixture(t);
  await f.selectMain();
  const communicate = (sessionId, body) => f.services().communication.handle({ principal: f.principal, body: { sessionId, ...body } });
  await f.call({ sessionId: 'lead', action: 'plan', planId: 'mailbox-plan', tasks });
  const note = { action: 'send', requestId: 'note-for-two', kind: 'decision', to: 'two', summary: 'Use the agreed units.' };
  assert.equal((await communicate('worker-1', note)).deferred, true);
  await f.restart();
  await communicate('worker-1', note);
  assert.equal(f.launches(), 1);
  await communicate('worker-1', { action: 'report', requestId: 'one-complete', to: 'parent', status: 'completed', summary: 'Units checked.' });
  assert.equal(f.launches(), 2);
  const inbox = await communicate('worker-2', { action: 'pending' });
  assert.deepEqual(inbox.messages.map(row => [row.from, row.to, row.kind, row.summary]),
    [['worker-1', 'worker-2', 'decision', note.summary]]);
  assert.ok(f.notifications.some(([to, body]) => to === 'worker-2' && body.includes('[research_communication peer')));
});

test('standalone composition retains queue, reservations and receipts across restart', async t => {
  const f = fixture(t);
  await f.selectMain();
  const first = await f.call({ sessionId: 'lead', action: 'plan', planId: 'synthetic-plan', tasks });
  assert.equal(f.launches(), 1);
  assert.equal(first.planHistory.counts.total, 2);
  const child = f.rows.find(row => row.id === 'worker-1');
  const launchReceipt = first.plans[0].tasks.find(row => row.id === 'one');
  assert.equal(launchReceipt.sessionId, child.id);
  assert.equal(child.researchSession.dispatchId, first.plans[0].id);
  assert.equal(child.researchSession.taskId, launchReceipt.id);
  assert.equal(launchReceipt.spawnToken, child.researchSession.spawnToken);
  assert.ok(launchReceipt.registeredAt);
  await f.restart();
  const reconnected = await f.call({ sessionId: 'lead', action: 'plan', planId: 'synthetic-plan', tasks });
  assert.equal(reconnected.plans[0].id, first.plans[0].id);
  assert.equal(reconnected.plans[0].tasks[0].sessionId, child.id);
  assert.equal(f.launches(), 1, 'same persisted plan cannot launch the registered child again');
  await f.call({ sessionId: child.id, action: 'report', status: 'completed', summary: 'Evidence saved', evidence: ['results/one.json'] });
  assert.equal(f.launches(), 2, 'one completed child frees exactly one queue slot');
  assert.ok(f.notifications.some(([id]) => id === 'lead'));
  const intermediate = await f.call({ sessionId: 'lead', action: 'status' });
  assert.equal(intermediate.plans[0].status, 'running');
  assert.equal(intermediate.plans[0].tasks[0].status, 'completed');
  assert.match(f.notifications.at(-1)[1], /has a completed task delivery/);
  assert.equal(intermediate.plans[0].tasks[1].sessionId, 'worker-2');
  await f.services().tick();
  assert.equal(f.launches(), 2);
  assert.ok(f.preflights() >= 2);
  assert.ok(f.prompts.size >= 2);
  assert.ok(f.unsubscribed() >= 1);
});

test('standalone composition delivers an intermediate failure before the remaining task finishes', async t => {
  const f = fixture(t);
  await f.selectMain();
  await f.call({ sessionId: 'lead', action: 'plan', planId: 'failure-plan', tasks });
  await f.call({ sessionId: 'worker-1', action: 'report', status: 'failed', summary: 'Actual fixture failure', evidence: ['results/failure.json'] });
  const status = await f.call({ sessionId: 'lead', action: 'status' });
  assert.equal(status.plans[0].status, 'running');
  assert.equal(status.plans[0].tasks[0].status, 'failed');
  assert.equal(status.plans[0].tasks[1].sessionId, 'worker-2');
  assert.match(f.notifications.at(-1)[1], /has a failed task delivery/);
  assert.equal(f.notifications.at(-1)[0], 'lead');
  const receipt = f.notifications.at(-1)[2];
  await f.services().dispatch.acknowledgeReceipt('lead', receipt);
  await f.restart();
  const afterRestart = await f.call({ sessionId: 'lead', action: 'status' });
  assert.equal(afterRestart.plans[0].tasks[0].status, 'failed');
  assert.equal(afterRestart.plans[0].tasks[0].notificationId, receipt);
  assert.ok(afterRestart.plans[0].tasks[0].notifiedAt);
});

test('an unknown process result keeps its reservation across restart and never claims registration', async t => {
  const f = fixture(t);
  await f.selectMain();
  f.setSpawnOutcome('unknown');
  const first = await f.call({ sessionId: 'lead', action: 'plan', planId: 'unknown-plan', tasks });
  const uncertain = first.plans[0].tasks[0];
  assert.equal(f.launches(), 1);
  assert.equal(uncertain.status, 'recovery-required');
  assert.equal(uncertain.error, 'research-session-spawn-outcome-unknown');
  assert.equal(uncertain.sessionId, undefined);
  assert.equal(uncertain.registeredAt, undefined);
  f.setSpawnOutcome('registered');
  await f.restart();
  const current = await f.call({ sessionId: 'lead', action: 'plan', planId: 'unknown-plan', tasks });
  assert.equal(f.launches(), 1);
  assert.equal(current.plans[0].tasks[0].status, 'recovery-required');
  assert.equal(current.plans[0].tasks[1].status, 'queued');
  assert.ok(f.services().dispatch.unregisteredReservations().length);
});

test('standalone composition pauses pending launches while retaining the running task', async t => {
  const f = fixture(t);
  await f.selectMain();
  await f.call({ sessionId: 'lead', action: 'plan', planId: 'synthetic-plan', tasks });
  await f.call({ sessionId: 'lead', action: 'pause' });
  await f.call({ sessionId: 'worker-1', action: 'report', status: 'completed', summary: 'Evidence saved' });
  assert.equal(f.launches(), 1);
  await f.restart();
  assert.equal(f.launches(), 1);
  await f.call({ sessionId: 'lead', action: 'resume' });
  assert.equal(f.launches(), 2);
});

test('standalone native leases preserve the selected host concurrency', async t => {
  const f = fixture(t);
  await f.selectMain();
  const one = { sessionId: 'lead', action: 'subagent-acquire', requestId: 'native-one', attemptId: 'attempt-one', role: 'research-worker' };
  const two = { ...one, requestId: 'native-two', attemptId: 'attempt-two' };
  const acquired = await f.services().collaboration.native(f.access, one, { principal: f.principal });
  assert.equal(acquired.status, 'acquired');
  assert.equal((await f.services().collaboration.native(f.access, two, { principal: f.principal })).status, 'queued');
  await f.restart();
  assert.equal((await f.services().collaboration.native(f.access, two, { principal: f.principal })).status, 'queued');
  await f.services().collaboration.native(f.access, { ...one, action: 'subagent-release', leaseToken: acquired.leaseToken }, { principal: f.principal });
  assert.equal((await f.services().collaboration.native(f.access, two, { principal: f.principal })).status, 'acquired');
});

test('a direct session receipt returns its exact registered child identity when the host confirms it', async t => {
  const f = fixture(t);
  await f.selectMain();
  const body = { parentSessionId: 'lead', requestId: 'direct-session-request', role: 'research-worker',
    task: 'Synthetic bounded direct task', stage: '2-experiment' };
  const spawned = await f.services().sessions.create({ body, principal: f.principal });
  assert.equal(spawned.registration, 'registered');
  assert.equal(spawned.sessionId, 'worker-1');
  assert.equal(f.rows.find(row => row.id === spawned.sessionId).researchSession.spawnToken, spawned.spawnToken);
  await f.restart();
  const repeated = await f.services().sessions.create({ body, principal: f.principal });
  assert.equal(repeated.sessionId, spawned.sessionId);
  assert.equal(repeated.registration, 'registered');
  assert.equal(f.launches(), 1);
  f.rows.find(row => row.id === spawned.sessionId).nativeRegistrationConfirmed = false;
  const recovering = await f.services().sessions.create({ body, principal: f.principal });
  assert.equal(recovering.registration, 'pending');
  assert.equal(recovering.sessionId, spawned.sessionId);
  assert.equal(f.launches(), 1);
});

test('prepared metadata stays pending until the native host confirms registration', async t => {
  const f = fixture(t);
  await f.selectMain();
  f.setSpawnOutcome('prepared');
  const body = { parentSessionId: 'lead', requestId: 'direct-prepared-request', role: 'research-worker',
    task: 'Synthetic registration boundary', stage: '2-experiment' };
  const pending = await f.services().sessions.create({ body, principal: f.principal });
  assert.equal(pending.registration, 'pending');
  assert.equal(pending.sessionId, undefined);
  f.rows.find(row => row.id === 'worker-1').nativeRegistrationConfirmed = true;
  const registered = await f.services().sessions.create({ body, principal: f.principal });
  assert.equal(registered.registration, 'registered');
  assert.equal(registered.sessionId, 'worker-1');
  assert.equal(f.launches(), 1);
});

test('dispatcher confirms the child identity only after its native registration', async t => {
  const f = fixture(t);
  await f.selectMain();
  f.setSpawnOutcome('prepared');
  const first = await f.call({ sessionId: 'lead', action: 'plan', planId: 'prepared-plan', tasks: tasks.slice(0, 1) });
  assert.equal(first.plans[0].tasks[0].sessionId, undefined);
  assert.equal(first.plans[0].tasks[0].registeredAt, undefined);
  f.rows.find(row => row.id === 'worker-1').nativeRegistrationConfirmed = true;
  await f.services().tick();
  const confirmed = await f.call({ sessionId: 'lead', action: 'status' });
  assert.equal(confirmed.plans[0].tasks[0].sessionId, 'worker-1');
  assert.ok(confirmed.plans[0].tasks[0].registeredAt);
  assert.equal(f.launches(), 1);
  f.rows.find(row => row.id === 'worker-1').nativeRegistrationConfirmed = false;
  await f.services().tick();
  const recovering = await f.call({ sessionId: 'lead', action: 'status' });
  assert.equal(recovering.plans[0].tasks[0].status, 'recovery-required');
  assert.equal(recovering.plans[0].tasks[0].error, 'research-dispatch-native-registration-unconfirmed');
  assert.equal(f.launches(), 1);
});

test('required host verification and resource hooks are checked before service creation', () => {
  assert.throws(() => createResearchServices({ privateDir: '/tmp/synthetic-private' }), /getSession-required/);
  assert.throws(() => createResearchServices({ privateDir: 'relative' }), /private-directory-required/);
});

test('parent reply to an already-live child bypasses process-launch memory gate, while resuming a completed direct child still checks it', async t => {
  const f = fixture(t);
  await f.selectMain();
  let memoryLow = false;
  const origBeforeLaunch = f.deps.beforeLaunch;
  f.deps.beforeLaunch = async (...args) => {
    if (memoryLow) throw new ResearchSessionError(409, 'research-session-resource-budget-unavailable');
    return origBeforeLaunch(...args);
  };
  await f.restart();

  // Launch a direct child while memory is healthy.
  const spawned = await f.services().sessions.create({
    body: { parentSessionId: 'lead', requestId: 'live-reply-req', role: 'research-worker', task: 'Run check', stage: '2-experiment' },
    principal: f.principal,
  });
  const childId = spawned.sessionId;
  const childReq = await f.services().communication.handle({
    body: { sessionId: childId, action: 'send', to: 'parent', kind: 'request', requestId: 'child-asks-help', summary: 'Need guidance' },
    principal: f.principal,
  });

  // Memory drops below threshold while child is live and waiting for parent reply.
  memoryLow = true;
  const reply = await f.services().communication.handle({
    body: { sessionId: 'lead', action: 'reply', messageId: childReq.message.id, requestId: 'lead-guides-live-child', summary: 'Wait for memory and proceed' },
    principal: f.principal,
  });
  assert.equal(reply.status, 'ok');
  assert.equal(reply.persisted, true);

  // Once the direct child reports completion (releasing capacity), actually resuming it still enforces beforeLaunch.
  await f.services().communication.handle({
    body: { sessionId: childId, action: 'report', requestId: 'child-done', status: 'completed', summary: 'Finished', evidence: [] },
    principal: f.principal,
  });
  await assert.rejects(
    f.services().communication.handle({
      body: { sessionId: 'lead', action: 'send', to: childId, kind: 'decision', requestId: 'resume-while-low-mem', summary: 'Do extra work' },
      principal: f.principal,
    }),
    /resource-budget-unavailable/,
  );
});

test('child with an open parent request cannot prematurely report blocked until parent replies', async t => {
  const f = fixture(t);
  await f.selectMain();
  await f.call({ sessionId: 'lead', action: 'plan', planId: 'wait-on-req-plan', concurrency: 1, tasks: tasks.slice(0, 1) });
  const req = await f.services().communication.handle({
    body: { sessionId: 'worker-1', action: 'send', to: 'parent', kind: 'request', requestId: 'need-perm-1', summary: 'Need permission to read extra folder' },
    principal: f.principal,
  });
  const childStatus = await f.call({ sessionId: 'worker-1', action: 'status' });
  assert.equal(childStatus.awaitingParentReply, true);

  await assert.rejects(
    f.services().communication.handle({
      body: { sessionId: 'worker-1', action: 'report', requestId: 'premature-block', status: 'blocked', summary: 'Giving up early', evidence: [] },
      principal: f.principal,
    }),
    /awaiting-parent-reply/,
  );
  await assert.rejects(
    f.call({ sessionId: 'worker-1', action: 'report', status: 'blocked', summary: 'Giving up early', evidence: [] }),
    /awaiting-parent-reply/,
  );

  // Parent replies -> request resolves -> child may continue and report cleanly.
  await f.services().communication.handle({
    body: { sessionId: 'lead', action: 'reply', messageId: req.message.id, requestId: 'parent-reply-1', summary: 'Permission granted; proceed' },
    principal: f.principal,
  });
  const afterReply = await f.call({ sessionId: 'worker-1', action: 'status' });
  assert.equal(afterReply.awaitingParentReply, false);
  await f.call({ sessionId: 'worker-1', action: 'report', status: 'completed', summary: 'Completed after parent reply', evidence: [] });
  assert.equal((await f.call({ sessionId: 'lead', action: 'status' })).plans[0].status, 'completed');
});

test('parent can reopen blocked, completed, and exited tasks in the original child session via reopen or downward communication', async t => {
  const f = fixture(t);
  const resumedSessions = [];
  f.deps.history = () => f.rows;
  f.deps.resumeSession = async (session) => {
    resumedSessions.push(session.id);
    const row = f.rows.find(item => item.id === session.id);
    if (row) row.status = 'idle';
    return { success: true, pid: 9999 };
  };
  await f.restart();
  await f.selectMain();

  // 1. Plan with concurrency: 1 stays allowed; worker-1 reports blocked, then parent reopens it via action="reopen".
  await f.call({ sessionId: 'lead', action: 'plan', planId: 'reopen-plan', concurrency: 1, tasks: tasks.slice(0, 1) });
  assert.equal(f.launches(), 1);
  const workerRow = f.rows.find(row => row.id === 'worker-1');
  workerRow.sessionFile = '/tmp/synthetic-worker-1.jsonl';
  await f.call({ sessionId: 'worker-1', action: 'report', status: 'blocked', summary: 'Hit temporary blocker', evidence: [] });
  assert.equal((await f.call({ sessionId: 'lead', action: 'status' })).plans[0].status, 'blocked');

  // Simulate auto-retire having exited worker-1 before parent reopens it.
  workerRow.status = 'ended';
  const reopened = await f.call({ sessionId: 'lead', action: 'reopen', planId: 'reopen-plan', taskId: tasks[0].id, reason: 'Blocker resolved; continue in original agent' });
  assert.equal(f.launches(), 1, 'must NOT spawn a brand new agent when reopening original session');
  assert.deepEqual(resumedSessions, ['worker-1']);
  assert.equal(reopened.plans[0].status, 'running');
  assert.equal(reopened.plans[0].tasks[0].status, 'running');
  assert.equal(reopened.plans[0].tasks[0].sessionId, 'worker-1');
  assert.ok(f.notifications.some(([to, body]) => to === 'worker-1' && body.includes('[research_dispatch reopen')));

  // 2. Worker-1 completes, exits again, and parent reopens the completed task via downward research_communication.
  await f.call({ sessionId: 'worker-1', action: 'report', status: 'completed', summary: 'First pass done', evidence: [] });
  assert.equal((await f.call({ sessionId: 'lead', action: 'status' })).plans[0].status, 'completed');
  workerRow.status = 'ended';
  const followup = await f.services().communication.handle({
    body: { sessionId: 'lead', action: 'send', to: 'worker-1', kind: 'decision', requestId: 'reopen-via-comm', summary: 'Add one more verification column' },
    principal: f.principal,
  });
  assert.equal(followup.status, 'ok');
  assert.equal(f.launches(), 1, 'reopening via communication still reuses original agent');
  assert.deepEqual(resumedSessions, ['worker-1', 'worker-1']);
  const afterComm = await f.call({ sessionId: 'lead', action: 'status' });
  assert.equal(afterComm.plans[0].status, 'running');
  assert.equal(afterComm.plans[0].tasks[0].status, 'running');
  assert.equal(f.services().dispatch.isCompleted(workerRow.researchSession.spawnToken), false);

  // Collaboration snapshot exposes compact scoped communications for the topology live sidebar.
  const collabSnap = await f.services().collaboration.snapshot(f.access);
  assert.ok(Array.isArray(collabSnap.communications));
  assert.ok(collabSnap.communications.some(msg => msg.from === 'lead' && msg.to === 'worker-1' && msg.summary.includes('Add one more verification column')));
});
