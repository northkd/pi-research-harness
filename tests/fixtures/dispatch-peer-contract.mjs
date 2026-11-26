import test from 'node:test';
import assert from 'node:assert/strict';

const scope = { cwd: '/synthetic/peer-project', ownerKey: 'owner', adoptionId: 'adopt-' + 'a'.repeat(24), charterHash: 'sha256:' + 'b'.repeat(64) };
const job = id => ({ id, role: 'research-worker', stage: '2-experiment', task: 'Private assignment ' + id, dependsOn: [], requestId: 'request-' + id, status: 'queued' });

export function dispatchPeerContract({ createResearchDispatchService, researchDispatchPeerState }, label) {
  test(label + ' maps task and session lifecycle to three peer states', () => {
    for (const status of ['launching', 'running', 'recovery-required']) {
      assert.equal(researchDispatchPeerState({ status }), 'in_progress');
      for (const ended of ['ended', 'closed', 'archived']) assert.equal(researchDispatchPeerState({ status }, { status: ended }), 'ended');
    }
    assert.equal(researchDispatchPeerState({ status: 'queued' }), 'queued');
    for (const status of ['completed', 'failed', 'blocked']) assert.equal(researchDispatchPeerState({ status }, { status: 'idle' }), 'ended');
  });

  test(label + ' exposes bounded same-plan metadata while retaining queued state and hiding sibling bodies', async () => {
    const tasks = Array.from({ length: 36 }, (_, index) => ({ ...job('task-' + index), summary: 'Private result ' + index, evidence: ['secret-' + index + '.json'] }));
    tasks[0].status = 'running'; tasks[0].spawnToken = 'token-0';
    tasks[1].status = 'running'; tasks[1].spawnToken = 'token-1'; tasks[1].sessionId = 'live-peer';
    tasks[2].waitingReason = 'capacity'; tasks[3].status = 'completed';
    const plan = { schema: 'pi-research-dispatch.v1', kind: 'plan', id: 'plan', parentSessionId: 'lead', rootSessionId: 'lead', ...scope,
      status: 'running', tasks, schedulingPaused: true, concurrency: 2, createdAt: '2026-11-25T00:00:00Z' };
    const provenance = index => ({ ...scope, workflowCwd: scope.cwd, parentSessionId: 'lead', rootSessionId: 'lead',
      dispatchId: 'plan', taskId: 'task-' + index, requestId: 'request-task-' + index, spawnToken: 'token-' + index });
    const rows = [{ id: 'lead', status: 'idle' }, { id: 'sender', status: 'idle', researchSession: provenance(0) },
      { id: 'live-peer', status: 'idle', researchSession: provenance(1) }];
    const service = createResearchDispatchService({ store: { readAll: () => [plan], write() {} }, listSessions: () => rows.filter(row => !row.retained),
      getSession: id => rows.find(row => row.id === id), authorize: async ({ sessionId }) => ({ ...scope, parent: rows.find(row => row.id === sessionId) }) });
    const snapshot = await service.handle({ body: { sessionId: 'sender', action: 'status' } });
    assert.equal(snapshot.peers.length, 32); assert.equal(snapshot.omittedPeers, 3);
    assert.equal(snapshot.peers[0].sessionId, 'live-peer');
    assert.equal(snapshot.peers[1].state, 'queued'); assert.equal(snapshot.peers[1].sessionId, null);
    assert.equal(snapshot.peers[1].waitingReason, 'capacity');
    assert.deepEqual(snapshot.peers[1].communicatable, { message: 'deferred', request: false });
    assert.equal(snapshot.peers[2].state, 'ended');
    assert.equal(JSON.stringify(snapshot.peers).includes('Private'), false);
    assert.equal(JSON.stringify(snapshot.peers).includes('secret-'), false);
    assert.equal(service.getPeerContext('sender').peers.length, 35, 'internal broadcast targets retain the complete bounded plan');
    rows[2].status = 'archived'; rows[2].retained = true;
    assert.equal(service.getPeerTask({ planId: 'plan', taskId: 'task-1' }).state, 'ended');
    rows[0].researchSession = { ...provenance(0), dispatchId: undefined };
    assert.equal(service.getPeerContext('lead'), null);
    rows[1].researchSession.tenureId = 'foreign-tenure';
    assert.equal(service.getPeerContext('sender'), null);
    service.dispose();
  });

  test(label + ' requires exact formal plan, task, token and retained session identity', () => {
    const task = { ...job('one'), status: 'launching' };
    delete task.requestId;
    const plan = { kind: 'plan', id: 'plan', parentSessionId: 'lead', rootSessionId: 'lead', ...scope,
      status: 'running', tasks: [task], concurrency: 1 };
    const p = { ...scope, workflowCwd: scope.cwd, parentSessionId: 'lead', dispatchId: 'plan', taskId: 'one' };
    const rows = [{ id: 'tokenless', status: 'idle', researchSession: p }];
    const service = createResearchDispatchService({ store: { readAll: () => [plan], write() {} }, listSessions: () => rows,
      getSession: id => rows.find(row => row.id === id) });
    assert.equal(service.getPeerContext('tokenless'), null, 'two missing tokens cannot prove membership');
    assert.equal(service.getPeerTask({ planId: 'plan', taskId: 'one' }).sessionId, null);
    service.dispose();
    task.requestId = 'valid-request';
    rows[0].researchSession.requestId = task.requestId;
    task.status = 'queued';
    const queued = createResearchDispatchService({ store: { readAll: () => [plan], write() {} }, listSessions: () => rows,
      getSession: id => rows.find(row => row.id === id) });
    assert.equal(queued.getPeerContext('tokenless'), null, 'a queued task has no registered sender');
    queued.dispose();
    task.status = 'launching'; task.sessionId = 'retained-worker';
    rows.push({ id: 'retained-worker', status: 'archived', researchSession: { ...p, requestId: task.requestId } });
    const reloaded = createResearchDispatchService({ store: { readAll: () => [plan], write() {} }, listSessions: () => rows.slice(0, 1),
      getSession: id => rows.find(row => row.id === id) });
    assert.equal(reloaded.getPeerContext('tokenless'), null, 'recorded session identity takes precedence over duplicate claims');
    assert.equal(reloaded.getPeerTask({ planId: 'plan', taskId: 'one' }).state, 'ended');
    assert.equal(reloaded.getPeerTask({ planId: 'plan', taskId: 'one' }).sessionId, 'retained-worker');
    rows[1].researchSession.dispatchId = 'foreign-plan';
    assert.equal(reloaded.getPeerTask({ planId: 'plan', taskId: 'one' }).sessionId, null);
    reloaded.dispose();
  });

  test(label + ' binds deferred mail only after registration and expires queued cancellation without launching it', async () => {
    const rows = [{ id: 'lead', status: 'idle' }], records = new Map(), bound = [], expired = [];
    let launches = 0, filed;
    const service = createResearchDispatchService({ store: { readAll: () => [...records.values()], write: row => records.set(row.id, structuredClone(row)) },
      listSessions: () => rows, getSession: id => rows.find(row => row.id === id),
      authorize: async ({ sessionId }) => ({ ...scope, parent: rows.find(row => row.id === sessionId) }),
      createSession: async ({ body, taskContext }) => {
        launches++; filed = { ...scope, workflowCwd: scope.cwd, parentSessionId: 'lead', rootSessionId: 'lead',
          requestId: body.requestId, spawnToken: 'pending-token', ...taskContext };
        return { spawnToken: 'pending-token' };
      }, bindDeferredPeerMessages: value => bound.push(value), expireDeferredPeerMessages: value => expired.push(value) });
    const snapshot = await service.handle({ body: { sessionId: 'lead', action: 'plan', planId: 'mailbox-lifecycle', concurrency: 1,
      tasks: [job('one'), job('two')].map(({ requestId, status, ...task }) => task) } });
    const planId = snapshot.plans[0].id;
    assert.equal(launches, 1); assert.equal(bound.length, 0);
    assert.equal(service.getPeerTask({ planId, taskId: 'one' }).state, 'in_progress');
    assert.equal(service.getPeerTask({ planId, taskId: 'one' }).sessionId, null);
    rows.push({ id: 'registered-worker', status: 'idle', nativeRegistrationConfirmed: false, researchSession: filed });
    await service.tick();
    assert.equal(bound.length, 0, 'native registration must confirm before binding mailbox delivery');
    rows.at(-1).nativeRegistrationConfirmed = true;
    await service.tick();
    assert.ok(bound.some(row => row.planId === planId && row.taskId === 'one' && row.sessionId === 'registered-worker'));
    await service.handle({ body: { sessionId: 'lead', action: 'cancel', planId, reason: 'Stop queued work' } });
    assert.ok(expired.some(row => row.planId === planId && row.taskId === 'two'));
    assert.equal(launches, 1);
    service.dispose();
  });

  test(label + ' reads the exact archived identity as ended and retains terminal addresses without history', () => {
    const task = { ...job('one'), status: 'running', spawnToken: 'token', sessionId: 'archived-worker' };
    const plan = { kind: 'plan', id: 'plan', parentSessionId: 'lead', rootSessionId: 'lead', ...scope,
      status: 'running', tasks: [task], concurrency: 1 };
    const archived = { id: 'archived-worker', cwd: scope.cwd, archivedAt: Date.now(), pluginRefs: { 'res-workflow': {
      researchSession: { workflowCwd: scope.cwd, charterHash: scope.charterHash, adoptionId: scope.adoptionId,
        parentSessionId: 'lead', dispatchId: 'plan', taskId: 'one', spawnToken: 'token', requestId: task.requestId } } } };
    let scans = 0;
    const deps = { store: { readAll: () => [plan], write() {} }, listSessions: () => { scans++; return []; },
      getSession: () => undefined, history: () => [archived] };
    const service = createResearchDispatchService(deps);
    expectEnded(service.getPeerTask({ planId: 'plan', taskId: 'one' }));
    assert.equal(service.getPeerContext('archived-worker'), null, 'history cannot authorize an active sender');
    assert.equal(scans, 0, 'a bound mailbox lookup avoids enumerating live sessions');
    service.dispose();

    task.status = 'completed';
    const withoutHistory = createResearchDispatchService({ ...deps, history: undefined });
    expectEnded(withoutHistory.getPeerTask({ planId: 'plan', taskId: 'one' }));
    withoutHistory.dispose();
    function expectEnded(peer) {
      assert.equal(peer.state, 'ended'); assert.equal(peer.sessionId, 'archived-worker');
      assert.deepEqual(peer.communicatable, { message: false, request: false });
    }
  });

}
