import test from 'node:test';
import assert from 'node:assert/strict';
import { DISPATCH_CONTEXT_BYTES, DISPATCH_DETAIL_BYTES, projectDispatchContext, dispatchContextBytes } from '../extensions/research-loop/src/dispatch-context.mjs';

function largeSnapshot() {
  const task = '完整任务说明'.repeat(650).slice(0, 4000);
  const summary = '待核验证据结论'.repeat(600).slice(0, 4000);
  const evidence = Array.from({ length: 16 }, (_, index) => `evidence/${index}/` + '材'.repeat(990));
  return { status: 'ok', collaborator: false, decisionRequired: false, childrenPending: false, declaredTasks: 0,
    plans: Array.from({ length: 2 }, (_, p) => ({ id: `plan-${p}`, mode: 'tasks', status: p ? 'failed' : 'completed',
      tasks: Array.from({ length: 12 }, (_, n) => ({ id: `task-${p}-${n}`, role: 'research-critic', task, stage: '3-review',
        summary, evidence, dependsOn: [], status: p && n === 11 ? 'failed' : 'completed',
        ...(p && n === 11 ? { error: 'actual-evidence-check-failed' } : {}) })) })) };
}

test('large valid multilingual receipts stay bounded without hiding failure counts', t => {
  const snapshot = largeSnapshot();
  const oldBytes = Buffer.byteLength(JSON.stringify(snapshot, null, 2));
  const projected = projectDispatchContext(snapshot, { action: 'status' });
  const currentBytes = dispatchContextBytes(projected);
  assert.ok(oldBytes > 1_000_000);
  assert.ok(currentBytes <= DISPATCH_CONTEXT_BYTES);
  assert.deepEqual(projected.counts, { total: 24, completed: 23, failed: 1, blocked: 0, active: 0, queued: 0 });
  assert.ok(projected.plans[0].tasks.some(task => task.error === 'actual-evidence-check-failed'));
  assert.ok(projected.plans.some(plan => plan.omittedTasks > 0));
  assert.ok(projected.plans.flatMap(plan => plan.tasks).every(task => task.summaryTruncated));
  assert.ok(projected.plans.flatMap(plan => plan.tasks).every(task => task.omittedEvidence === 16));
  assert.ok(!JSON.stringify(projected).includes(snapshot.plans[0].tasks[0].task));
  t.diagnostic(JSON.stringify({ scenario: '24-completed-or-failed-long-CJK-receipts', oldModelBytes: oldBytes,
    newModelBytes: currentBytes, reductionPercent: Number(((1 - currentBytes / oldBytes) * 100).toFixed(2)), synthetic: true, tokenMeasurement: false }));
});

test('mutation acknowledgements do not echo task specifications or accumulated receipts', () => {
  const snapshot = largeSnapshot();
  for (const action of ['delegate', 'plan', 'report', 'atomic', 'cancel', 'pause', 'resume']) {
    const projected = projectDispatchContext(snapshot, { action });
    assert.ok(dispatchContextBytes(projected) <= DISPATCH_CONTEXT_BYTES);
    assert.equal(projected.plans.flatMap(plan => plan.tasks).length, 0);
    assert.equal(projected.counts.failed, 1);
    assert.ok(!JSON.stringify(projected).includes(snapshot.plans[0].tasks[0].summary));
  }
});

test('compact live-queue history preserves main pause state and omitted historical outcomes together', () => {
  const snapshot = { status: 'ok', childrenPending: true, planHistory: {
    total: 9, shown: 1, counts: { total: 36, completed: 28, failed: 3, blocked: 1, active: 1, queued: 3 },
  }, plans: [{ id: 'current-plan', status: 'running', schedulingPaused: true, tasks: [
    { id: 'active', status: 'running' },
    { id: 'next', status: 'queued' },
  ] }] };
  const projected = projectDispatchContext(snapshot);
  assert.equal(projected.childrenPending, true);
  assert.equal(projected.plans[0].schedulingPaused, true);
  assert.equal(projected.counts.queued, 1);
  assert.deepEqual(projected.planHistory, snapshot.planHistory);
  assert.match(projected.hint, /Old plan bodies are omitted/);
  assert.ok(dispatchContextBytes(projected) <= DISPATCH_CONTEXT_BYTES);
});

test('detail pages reconstruct complete evidence with Unicode and escaped code units', () => {
  const snapshot = largeSnapshot();
  const target = snapshot.plans[0].tasks[0];
  target.summary += '🧪'.repeat(500) + '\ud800'.repeat(500);
  let offset = 0, reconstructed = '', pages = 0, recordHash;
  do {
    const page = projectDispatchContext(snapshot, { action: 'status', view: 'detail', planId: 'plan-0', taskId: target.id, offset, recordHash });
    assert.ok(dispatchContextBytes(page) <= DISPATCH_DETAIL_BYTES);
    assert.equal(page.offset, offset);
    assert.ok(page.content.length > 0);
    reconstructed += page.content; pages++;
    offset = page.nextOffset;
    recordHash = page.recordHash;
    assert.equal(page.complete, offset === null);
    assert.ok(pages < 30);
  } while (offset !== null);
  assert.ok(pages > 1);
  assert.deepEqual(JSON.parse(reconstructed), { planId: 'plan-0', task: target });
});

test('self brief is complete without bulk prerequisite bodies; dependency detail is explicit', () => {
  const snapshot = { status: 'ok', plans: [], brief: { task: 'Precise objective', role: 'research-critic', stage: '3-review', readOnly: true },
    assignment: { planId: 'parent-plan', taskId: 'review', status: 'running',
      dependencies: [{ id: 'experiment', summary: 'RAW_DEPENDENCY'.repeat(1000), evidence: ['results/raw.csv'] }] } };
  const self = projectDispatchContext(snapshot, { view: 'detail', taskId: 'self' });
  assert.equal(self.complete, true);
  const parsed = JSON.parse(self.content);
  assert.deepEqual(parsed.brief, snapshot.brief);
  assert.deepEqual(parsed.assignment.dependencyIds, ['experiment']);
  assert.ok(!self.content.includes('RAW_DEPENDENCY'));
  const dependency = projectDispatchContext(snapshot, { view: 'detail', taskId: 'experiment' });
  assert.equal(dependency.source, 'dependency');
  assert.ok(dependency.content.includes('RAW_DEPENDENCY'));
  assert.equal(projectDispatchContext(snapshot, { view: 'detail', taskId: 'not-a-dependency' }).status, 'blocked');
});

test('detail selection rejects ambiguity and invalid offsets without changing receipts', () => {
  const snapshot = largeSnapshot(), original = JSON.stringify(snapshot);
  snapshot.plans[1].tasks[0].id = snapshot.plans[0].tasks[0].id;
  assert.equal(projectDispatchContext(snapshot, { view: 'detail', taskId: 'task-0-0' }).status, 'blocked');
  assert.equal(projectDispatchContext(snapshot, { view: 'detail', planId: 'plan-0', taskId: 'task-0-0', offset: -1 }).status, 'blocked');
  assert.equal(projectDispatchContext(snapshot, { view: 'detail', planId: 'plan-0', taskId: 'task-0-0', offset: 1e12 }).status, 'blocked');
  snapshot.plans[1].tasks[0].id = 'task-1-0';
  assert.equal(JSON.stringify(snapshot), original);
});

test('delegated objective returns one bounded aggregate receipt with exact short evidence paths', () => {
  const snapshot = { status: 'ok', plans: [{ id: 'root-goal', mode: 'delegate', status: 'completed',
    tasks: [{ id: 'coordinator', role: 'research-coordinator', status: 'completed', summary: '结论'.repeat(1500), evidence: ['report/final.md', 'runs/raw.csv'] }] }] };
  const projected = projectDispatchContext(snapshot);
  assert.equal(projected.plans[0].tasks.length, 1);
  assert.equal(projected.plans[0].tasks[0].summaryTruncated, true);
  assert.deepEqual(projected.plans[0].tasks[0].evidence, ['report/final.md', 'runs/raw.csv']);
  assert.ok(dispatchContextBytes(projected) <= DISPATCH_CONTEXT_BYTES);
});

test('changed detail records cannot silently corrupt evidence between pages', () => {
  const snapshot = largeSnapshot();
  const request = { view: 'detail', planId: 'plan-0', taskId: 'task-0-0' };
  const first = projectDispatchContext(snapshot, request);
  assert.notEqual(first.nextOffset, null);
  assert.equal(projectDispatchContext(snapshot, { ...request, offset: first.nextOffset }).status, 'blocked');
  snapshot.plans[0].tasks[0].status = 'blocked';
  const changed = projectDispatchContext(snapshot, { ...request, offset: first.nextOffset, recordHash: first.recordHash });
  assert.equal(changed.error, 'research-dispatch-detail-record-changed');
  assert.notEqual(projectDispatchContext(snapshot, request).recordHash, first.recordHash);
});

test('a prerequisite remains addressable when an owned task has the same ID', () => {
  const snapshot = { status: 'ok', plans: [{ id: 'own-plan', tasks: [{ id: 'same', summary: 'own receipt' }] }],
    assignment: { planId: 'parent-plan', dependencies: [{ id: 'same', summary: 'prerequisite receipt' }] } };
  assert.equal(projectDispatchContext(snapshot, { view: 'detail', taskId: 'same' }).status, 'blocked');
  const own = projectDispatchContext(snapshot, { view: 'detail', planId: 'own-plan', taskId: 'same' });
  const dependency = projectDispatchContext(snapshot, { view: 'detail', planId: 'parent-plan', taskId: 'same' });
  assert.equal(JSON.parse(own.content).task.summary, 'own receipt');
  assert.equal(JSON.parse(dependency.content).dependency.summary, 'prerequisite receipt');
});

test('peer roster forwards only contact metadata and derives three-state capabilities', () => {
  const snapshot = { status: 'ok', collaborator: true, plans: [], peers: ['in_progress', 'queued', 'ended'].map((state, index) => ({
    taskId: 'peer-' + index, role: 'research-critic', stage: '3-review', state,
    rawStatus: ['running', 'queued', 'completed'][index], waitingReason: state === 'queued' ? 'capacity' : null,
    registration: state === 'queued' ? 'not-started' : 'registered', sessionId: state === 'queued' ? null : 'session-' + index,
    task: 'PRIVATE_SIBLING_TASK', summary: 'PRIVATE_SIBLING_SUMMARY', evidence: ['PRIVATE_SIBLING_EVIDENCE'],
    communicatable: { message: true, request: true },
  })) };
  const projected = projectDispatchContext(snapshot);
  assert.equal(projected.omittedPeers, 0);
  assert.equal(projected.peers.length, 3);
  assert.deepEqual(projected.peers.map(peer => peer.communicatable), [
    { message: true, request: true }, { message: 'deferred', request: false }, { message: false, request: false },
  ]);
  assert.equal(projected.peers[1].sessionId, null);
  assert.equal(projected.peers[1].waitingReason, 'capacity');
  assert.deepEqual(Object.keys(projected.peers[0]), ['taskId', 'role', 'stage', 'state', 'rawStatus', 'waitingReason', 'registration', 'sessionId', 'communicatable']);
  assert.equal(JSON.stringify(projected).includes('PRIVATE_SIBLING_'), false);
});

test('peer overflow preserves assignments, plans and all failure counts inside the summary budget', () => {
  const snapshot = largeSnapshot();
  snapshot.assignment = { planId: 'parent-plan', taskId: 'self', status: 'running', dependencies: [{ id: 'prerequisite' }] };
  snapshot.peers = Array.from({ length: 32 }, (_, index) => ({ taskId: 'peer-' + index, role: 'research-critic',
    stage: '3-review', state: 'in_progress', rawStatus: 'running', registration: 'registered', sessionId: 'session-' + index,
    waitingReason: '材🧪"\\'.repeat(3000), task: 'PRIVATE_TASK'.repeat(10000) }));
  snapshot.omittedPeers = 7;
  const expected = projectDispatchContext({ ...snapshot, peers: [], omittedPeers: 0 });
  const projected = projectDispatchContext(snapshot);
  assert.ok(dispatchContextBytes(projected) <= DISPATCH_CONTEXT_BYTES);
  assert.deepEqual(projected.assignment, expected.assignment);
  assert.deepEqual(projected.plans, expected.plans);
  assert.deepEqual(projected.counts, expected.counts);
  assert.equal(projected.counts.failed, 1);
  assert.ok(projected.omittedPeers > 7);
  assert.equal(projected.peers.length + projected.omittedPeers, 39);
  assert.equal(JSON.stringify(projected).includes('PRIVATE_TASK'), false);
});

test('unbounded peer inputs cap roster size and count omitted contacts', () => {
  const snapshot = { status: 'ok', plans: [], peers: Array.from({ length: 100 }, (_, index) => ({
    taskId: 'peer-' + index, role: 'worker', state: 'queued', rawStatus: 'queued', registration: 'not-started',
    waitingReason: '🧪"\\'.repeat(5000),
  })) };
  const projected = projectDispatchContext(snapshot);
  assert.ok(projected.peers.length > 0 && projected.peers.length <= 32);
  assert.equal(projected.peers.length + projected.omittedPeers, 100);
  assert.ok(dispatchContextBytes(projected) <= DISPATCH_CONTEXT_BYTES);
  assert.ok(projected.peers.every(peer => Buffer.byteLength(JSON.stringify(peer.waitingReason)) <= 180));
});
