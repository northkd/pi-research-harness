import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const implementations = [
  ['host', await import('../research-communication-service.mjs')],
  ['overlay', await import('../../../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-communication-service.mjs')],
];
const scope = { cwd: '/synthetic/project', ownerKey: 'operator', adoptionId: 'adopt-example', charterHash: 'sha256:example' };
const plan = { id: 'dispatch-team', ...scope, parentSessionId: 'lead', rootSessionId: 'lead', tenureId: 'tenure-one' };
const state = task => ['completed', 'failed', 'blocked', 'cancelled'].includes(task.rawStatus) ? 'ended'
  : task.rawStatus === 'queued' ? 'queued' : 'in_progress';

function fixture(t, implementation) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-communication-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const tasks = [
    { taskId: 'task-a', role: 'research-theory', rawStatus: 'running', sessionId: 'a' },
    { taskId: 'task-b', role: 'research-critic', rawStatus: 'running', sessionId: 'b' },
    { taskId: 'task-q', role: 'research-literature', rawStatus: 'queued', sessionId: null, waitingReason: 'capacity' },
    { taskId: 'task-ended', role: 'research-numerics', rawStatus: 'completed', sessionId: 'ended' },
    { taskId: 'task-launch', role: 'research-explorer', rawStatus: 'launching', sessionId: null },
  ];
  const session = (id, taskId) => ({ id, status: 'idle', scope: { ...scope },
    researchSession: { ...scope, workflowCwd: scope.cwd, parentSessionId: 'lead', rootSessionId: 'lead',
      dispatchId: plan.id, taskId, tenureId: plan.tenureId, spawnToken: 'spawn-' + id } });
  const rows = [{ id: 'lead', status: 'idle', scope: { ...scope } },
    session('a', 'task-a'), session('b', 'task-b'), session('ended', 'task-ended')];
  const describe = task => ({ ...task, state: ['ended', 'closed', 'archived'].includes(rows.find(row => row.id === task.sessionId)?.status) ? 'ended' : state(task) });
  const getPeerContext = id => {
    const task = tasks.find(row => row.sessionId === id);
    return task ? { plan, task: describe(task), state: state(task), peers: tasks.filter(row => row !== task).map(describe) } : null;
  };
  const notifications = [], controls = [];
  let transportAvailable = true;
  const disk = implementation.createResearchCommunicationStore(directory);
  let rejectedWrite = () => false;
  const store = { readAll: disk.readAll, write(row) {
    if (rejectedWrite(row)) throw new Error('synthetic write failure');
    disk.write(row);
  } };
  const deps = { store, getSession: id => rows.find(row => row.id === id), listSessions: () => rows,
    getPeerContext, getPeerTask: ({ planId, taskId }) => planId === plan.id ? tasks.filter(row => row.taskId === taskId).map(describe)[0] : null,
    authorize: async ({ sessionId }) => {
      const parent = rows.find(row => row.id === sessionId);
      if (!parent) throw new Error('no session');
      return { parent, ...parent.scope };
    },
    notifyParent: async (...args) => { notifications.push(args); return transportAvailable; },
    activateSession: (...args) => controls.push(['activate', ...args]),
    releaseSession: (...args) => controls.push(['release', ...args]),
    reportAssignment: (...args) => controls.push(['report', ...args]),
  };
  let service = implementation.createResearchCommunicationService(deps);
  return { tasks, rows, notifications, controls, store,
    failWrites(predicate) { rejectedWrite = predicate; },
    setTransportAvailable(value) { transportAvailable = value; },
    service: () => service,
    call: (sessionId, body) => service.handle({ body: { sessionId, ...body } }),
    restart() { service.dispose(); service = implementation.createResearchCommunicationService(deps); },
    launch(taskId, id) {
      const task = tasks.find(row => row.taskId === taskId);
      Object.assign(task, { sessionId: id, rawStatus: 'running' });
      rows.push(session(id, taskId));
    },
  };
}
const note = (to, requestId = 'memo') => ({ action: 'send', to, requestId, kind: 'decision', summary: 'Use the verified shared method.' });

for (const [name, implementation] of implementations) {
  test(`${name}: peers address live task or session, wake distinctly and reply to exact requests`, async t => {
    const f = fixture(t, implementation);
    const sent = await f.call('a', { ...note('task-b'), kind: 'request' });
    assert.equal(sent.message.to, 'b');
    assert.equal(sent.message.edgeKind, 'peer');
    assert.match(f.notifications[0][1], /research_communication peer/);
    assert.match(f.notifications[0][1], /task-a.*research-theory/);
    assert.match(f.notifications[0][1], /readOnly\/noExport/);
    const inbox = await f.call('b', { action: 'pending' });
    assert.equal(inbox.messages[0].id, sent.message.id);
    await f.call('b', { action: 'ack', messageId: sent.message.id });
    assert.equal((await f.call('b', { action: 'pending' })).messages.length, 1);
    await f.call('b', { action: 'reply', requestId: 'answer', messageId: sent.message.id, summary: 'Confirmed in the existing scope.' });
    assert.equal((await f.call('b', { action: 'pending' })).messages.length, 0);
    assert.equal((await f.call('a', { action: 'pending' })).messages[0].kind, 'reply');
    await assert.rejects(f.call('a', { action: 'reply', requestId: 'wrong-answer', messageId: sent.message.id, summary: 'Wrong receiver.' }), /request-not-found/);
    assert.deepEqual(f.controls, []);
  });

  test(`${name}: queued notes persist without scheduling and bind immediately after launch`, async t => {
    const f = fixture(t, implementation), before = structuredClone(f.tasks);
    const saved = await f.call('a', note('task-q'));
    assert.equal(saved.deferred, true);
    assert.equal(saved.targetState, 'queued');
    assert.equal(f.store.readAll()[0].targetTaskId, 'task-q');
    assert.equal(f.store.readAll()[0].deferredToQueued, true);
    assert.deepEqual(f.tasks, before);
    assert.equal(f.notifications.length, 0);
    await assert.rejects(f.call('a', { ...note('task-q', 'request-queued'), kind: 'request' }), /peer-queued/);
    f.restart();
    f.tasks[0].rawStatus = 'completed';
    f.launch('task-q', 'new-q');
    await f.service().tick(); // Recover a registration committed before the binding callback ran.
    assert.equal(f.notifications.length, 1);
    const pending = await f.call('new-q', { action: 'pending' });
    assert.equal(pending.messages[0].id, saved.message.id);
    assert.equal(pending.messages[0].to, 'new-q');
    await f.service().bindDeferredPeerMessages({ planId: plan.id, taskId: 'task-q', sessionId: 'new-q' });
    assert.equal(f.notifications.length, 1);
    assert.deepEqual(f.controls, []);
  });

  test(`${name}: launching task accepts requests before registration and binds after registration`, async t => {
    const f = fixture(t, implementation);
    const saved = await f.call('a', { ...note('task-launch'), kind: 'request' });
    assert.equal(saved.deferred, true);
    assert.equal(saved.targetState, 'in_progress');
    f.launch('task-launch', 'new-launch');
    await f.service().bindDeferredPeerMessages({ planId: plan.id, taskId: 'task-launch', sessionId: 'new-launch' });
    assert.equal((await f.call('new-launch', { action: 'pending' })).messages[0].id, saved.message.id);
    assert.equal(f.notifications.length, 1);
  });

  test(`${name}: queued mailbox cannot leak through a task/session ID collision and expires when blocked`, async t => {
    const f = fixture(t, implementation);
    const saved = await f.call('a', note('task-q'));
    f.rows.push({ id: 'task-q', status: 'idle', scope: { ...scope } });
    assert.equal((await f.call('task-q', { action: 'pending' })).messages.length, 0);
    await assert.rejects(f.call('task-q', { action: 'ack', messageId: saved.message.id }), /message-not-found/);
    f.tasks[2].rawStatus = 'blocked';
    await f.service().expireDeferredPeerMessages({ planId: plan.id, taskId: 'task-q' });
    assert.ok(f.store.readAll()[0].expiredAt);
    f.launch('task-q', 'forbidden-reopen');
    await f.service().tick();
    assert.equal((await f.call('forbidden-reopen', { action: 'pending' })).messages.length, 0);
    assert.equal(f.notifications.length, 0);
  });

  test(`${name}: terminal task and session states reject send and reply and settle retirement requests`, async t => {
    const f = fixture(t, implementation);
    const sent = await f.call('a', { ...note('b'), kind: 'request' });
    f.tasks[1].rawStatus = 'completed';
    await assert.rejects(f.call('a', note('b', 'late-send')), /peer-ended/);
    await assert.rejects(f.call('b', { action: 'reply', requestId: 'late-reply', messageId: sent.message.id, summary: 'Too late.' }), /peer-ended/);
    for (const id of ['a', 'b']) {
      const pending = await f.call(id, { action: 'pending' });
      assert.equal(pending.messages[0].peerSettled, true);
      assert.match(pending.messages[0].notice, /parent/);
      assert.deepEqual(pending.retirement.supervisorRequests, []);
    }
    assert.equal(f.store.readAll()[0].peerSettled, true);
    f.tasks[1].rawStatus = 'running';
    f.rows.find(row => row.id === 'b').status = 'archived';
    await assert.rejects(f.call('a', note('b', 'archived-send')), /peer-ended/);
  });

  test(`${name}: broadcast fanout is independently idempotent, defers queued peers and skips ended peers`, async t => {
    const f = fixture(t, implementation);
    const first = await f.call('a', note('peers'));
    assert.equal(first.activeCount, 2);
    assert.equal(first.queuedCount, 1);
    assert.equal(first.skippedEnded, 1);
    assert.equal(first.deliveredCount, 1);
    assert.equal(new Set(first.messages.map(row => row.id)).size, 3);
    f.restart();
    const second = await f.call('a', note('peers'));
    assert.deepEqual(second.messages.map(row => row.id), first.messages.map(row => row.id));
    assert.equal(f.store.readAll().length, 3);
    assert.equal(f.notifications.length, 1);
    await f.call('b', { action: 'ack', messageId: first.messages.find(row => row.targetTaskId === 'task-b').id });
    await assert.rejects(f.call('a', { ...note('peers', 'bad-broadcast'), kind: 'request' }), /kind-invalid/);
    await assert.rejects(f.call('a', { ...note('peers', 'bad-report'), action: 'report', status: 'completed' }), /report-parent-required/);
    const req = await f.call('a', { ...note('b', 'direct-request'), kind: 'request' });
    await assert.rejects(f.call('b', { ...note('peers', 'bad-reply'), action: 'reply', messageId: req.message.id }), /relationship-invalid/);
  });

  test(`${name}: unicast pair limit survives restart while parent escalation and broadcasts stay available`, async t => {
    const f = fixture(t, implementation);
    for (let i = 0; i < 8; i++) await f.call(i % 2 ? 'b' : 'a', note(i % 2 ? 'a' : 'b', 'round-' + i));
    f.restart();
    await f.call('a', note('b', 'round-0'));
    await assert.rejects(f.call('a', note('b', 'overflow')), /peer-loop-limit/);
    await f.call('a', note('parent', 'escalate'));
    await f.call('a', note('peers', 'team-progress'));
    assert.deepEqual(f.controls, []);
  });

  test(`${name}: peer scope, plan, parent, tenure and self boundaries are enforced`, async t => {
    const f = fixture(t, implementation), sibling = f.rows.find(row => row.id === 'b');
    await assert.rejects(f.call('a', note('a')), /relationship-invalid/);
    for (const [key, value] of [['dispatchId', 'different-plan'], ['parentSessionId', 'cousin'], ['tenureId', 'different-tenure']]) {
      const original = sibling.researchSession[key];
      sibling.researchSession[key] = value;
      await assert.rejects(f.call('a', note('b')), /relationship-invalid/);
      sibling.researchSession[key] = original;
    }
    sibling.scope.ownerKey = 'foreign';
    await assert.rejects(f.call('a', note('b')), /scope-mismatch/);
    assert.equal(f.store.readAll().length, 0);
  });

  test(`${name}: explicit parent and exact reply identities survive colliding sibling task IDs`, async t => {
    const f = fixture(t, implementation);
    f.tasks[2].taskId = 'lead';
    const parent = await f.call('a', note('parent', 'parent-help'));
    assert.equal(parent.message.to, 'lead');
    assert.equal(parent.message.edgeKind, undefined);
    const defaultParent = await f.call('a', { action: 'send', requestId: 'default-parent-help', kind: 'request', summary: 'Need parent approval.' });
    assert.equal(defaultParent.message.to, 'lead');
    const parentRequest = await f.call('lead', { ...note('a', 'parent-request'), kind: 'request' });
    const parentReply = await f.call('a', { action: 'reply', requestId: 'reply-to-parent', messageId: parentRequest.message.id, summary: 'Exact parent receives this.' });
    assert.equal(parentReply.message.to, 'lead');
    assert.equal(parentReply.message.edgeKind, undefined);
    await assert.rejects(f.call('a', note('lead', 'ambiguous-parent')), /relationship-invalid/);
    f.tasks[2].taskId = 'a';
    await assert.rejects(f.call('b', note('a', 'ambiguous-peer')), /relationship-invalid/);
    const req = await f.call('a', { ...note('b', 'request-before-reply'), kind: 'request' });
    const reply = await f.call('b', { action: 'reply', requestId: 'exact-reply', messageId: req.message.id, summary: 'Exact sender only.' });
    assert.equal(reply.message.to, 'a');
    assert.equal(reply.message.targetTaskId, 'task-a');
  });

  test(`${name}: unbound requests cannot be read, acknowledged or retired by task/session aliases`, async t => {
    const f = fixture(t, implementation);
    const req = await f.call('a', { ...note('task-launch'), kind: 'request' });
    f.rows.push({ id: 'task-launch', status: 'archived', scope: { ...scope } });
    const aliased = await f.call('task-launch', { action: 'pending' });
    assert.deepEqual(aliased.messages, []);
    assert.deepEqual(aliased.retirement.supervisorRequests, []);
    assert.equal(f.store.readAll()[0].peerSettled, undefined);
    await assert.rejects(f.call('task-launch', { action: 'ack', messageId: req.message.id }), /message-not-found/);
    await assert.rejects(f.call('task-launch', { action: 'reply', requestId: 'forged', messageId: req.message.id, summary: 'Unauthorized answer.' }), /request-not-found/);
  });

  test(`${name}: maximum broadcast returns a bounded receipt without message bodies`, async t => {
    const f = fixture(t, implementation);
    for (let i = 0; i < 59; i++) f.tasks.push({ taskId: ('queued-' + i).padEnd(128, 'q'), role: 'research-literature', rawStatus: 'queued', sessionId: null });
    const result = await f.call('a', { ...note('peers'), summary: 'x'.repeat(4000), evidence: Array.from({ length: 4 }, (_, i) => ('evidence-' + i).padEnd(1024, 'e')) });
    assert.equal(result.messages.length, 62);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 24 * 1024);
    for (const receipt of result.messages) {
      assert.equal(receipt.summary, undefined);
      assert.equal(receipt.evidence, undefined);
    }
  });

  test(`${name}: interrupted peer reply repairs request settlement after restart`, async t => {
    const f = fixture(t, implementation);
    const request = await f.call('a', { ...note('b'), kind: 'request' });
    f.failWrites(row => row.id === request.message.id && !!row.resolvedBy);
    await assert.rejects(f.call('b', { action: 'reply', requestId: 'interrupted-reply', messageId: request.message.id, summary: 'Durable answer.' }), /write failure/);
    assert.equal(f.store.readAll().length, 2);
    f.failWrites(() => false);
    f.restart();
    await f.service().tick();
    const pending = await f.call('b', { action: 'pending' });
    assert.deepEqual(pending.messages, []);
    assert.deepEqual(pending.retirement.supervisorRequests, []);
    assert.equal((await f.call('a', { action: 'pending' })).messages[0].kind, 'reply');
  });

  test(`${name}: unavailable live transport reports zero accepted broadcast wakeups`, async t => {
    const f = fixture(t, implementation);
    f.setTransportAvailable(false);
    const result = await f.call('a', note('peers'));
    assert.equal(result.deliveredCount, 0);
    assert.equal(result.activeCount, 2);
    assert.equal(f.store.readAll().length, 3);
    assert.equal((await f.call('b', { action: 'pending' })).messages.length, 1);
    f.setTransportAvailable(true);
    const retry = await f.call('a', note('peers'));
    assert.equal(retry.deliveredCount, 1);
    assert.equal(f.store.readAll().length, 3);
  });
}
