// Stage-granular dispatch and migration tests. Local synthetic evidence only; no model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { MainlineStore } from '../src/core.mjs';
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-cadence-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'plan.md'), 'Synthetic frozen research plan');
  const store = new MainlineStore(cwd, { meminfo: 'MemAvailable: 4194304 kB' });
  store.configure({ coreText: 'Synthetic CPU method, no scientific claims.', approvedPaths: ['plan.md'], authorized: true });
  return { cwd, store };
}
function material(store, id = 'e') {
  return store.record({ type: 'tool_result', sessionId: 'synthetic', toolName: 'bash', toolCallId: id, input: { command: 'synthetic check' }, result: 'actual test outcome' });
}
function complete(store, requestId = 'r', error) {
  const b = store.beginReview({ sessionId: 'synthetic', requestId, automatic: true }); assert.equal(b.ok, true, JSON.stringify(b));
  store.attachRun(requestId, 'mock-' + requestId);
  store.finishReview(requestId, { verdict: 'ON_TRACK', findings: [], runId: 'mock-' + requestId, ...(error ? { error } : {}) });
  return b;
}
test('cadence: many same-stage edits/test/cleanup outcomes accumulate, not auto-review', t => {
  const { store } = fixture(t); complete(store);
  for (let i = 0; i < 15; i++) { material(store, 'followup-' + i); assert.equal(store.reviewEligibility({ automatic: true }).ok, false); }
  const s = store.getState(); assert.equal(s.pendingChanges, true); assert.equal(s.eventCount, 15);
  assert.equal(store.beginReview({ sessionId: 'synthetic', requestId: 'cleanup', automatic: true }).reason, 'no-research-checkpoint');
  assert.match(store.statusText(), /阶段内证据积累/);
  store.recordCheckpoint({ stageId: 'CPU-method-A', kind: 'stage_complete' });
  const b = complete(store, 'merged');
  const e = JSON.parse(fs.readFileSync(path.join(b.packetDir, 'EVIDENCE.json')));
  assert.equal(e.events.filter(x => x.material).length, 15); assert.equal(e.checkpoints.length, 1); assert.equal(e.checkpoints[0].executionProof, false);
  material(store, 'post-acceptance-packaging');
  assert.equal(store.recordCheckpoint({ stageId: 'CPU-method-A', kind: 'stage_complete' }).changed, false);
  assert.equal(new MainlineStore(store.cwd).reviewEligibility({ automatic: true }).ok, false);
  assert.equal(store.getState().pendingChanges, true, 'Packaging evidence not falsely reviewed');
});
test('cadence: plan/scope/acceptance/drift checkpoints merge once, failure never replays', t => {
  const { store } = fixture(t); complete(store); material(store);
  for (const kind of ['plan_change', 'scope_change', 'stage_complete', 'drift_signal'])
    store.recordCheckpoint({ stageId: 'method-B', kind });
  assert.equal(store.reviewEligibility({ automatic: true }).checkpoints.length, 4);
  const b = complete(store, 'failed-node', 'timeout');
  assert.equal(store.getState().lastVerdict, 'FAILED'); const rawFailure = fs.readFileSync(path.join(b.packetDir, 'RESULT.json'));
  material(store, 'closing-log'); assert.equal(store.reviewEligibility({ automatic: true }).ok, false);
  for (const kind of ['plan_change', 'scope_change', 'stage_complete', 'drift_signal'])
    assert.equal(store.recordCheckpoint({ stageId: 'method-B', kind }).changed, false);
  assert.equal(store.reviewEligibility({ automatic: true }).ok, false); assert.equal(store.getState().blocked, false);
  store.recordCheckpoint({ stageId: 'method-C', kind: 'plan_change' }); assert.equal(store.reviewEligibility({ automatic: true }).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(b.packetDir, 'RESULT.json')), rawFailure);
});
test('cadence: old state migration preserves pending evidence/history without catch-up model calls', t => {
  const { cwd, store } = fixture(t); complete(store, 'old'); material(store, 'old-unreviewed-tail');
  const statePath = path.join(store.root, 'state.json'), old = store.getState(); delete old.reviewCadence;
  fs.writeFileSync(statePath, JSON.stringify(old));
  const next = new MainlineStore(cwd), s = next.getState();
  assert.equal(s.reviewCadence.mode, 'stage-checkpoints'); assert.equal(s.reviewCadence.checkpoints.length, 0);
  assert.equal(s.lastVerdict, old.lastVerdict); assert.equal(s.reviewedRevision, old.reviewedRevision); assert.equal(s.materialRevision, old.materialRevision);
  assert.equal(s.pendingChanges, true); assert.equal(next.reviewEligibility({ automatic: true }).ok, false);
  assert.equal(next.recordCheckpoint({ stageId: 'next-actual-decision', kind: 'plan_change' }).changed, true);
  assert.equal(next.reviewEligibility({ automatic: true }).ok, true);
});
test('cadence: checkpoint declarations do not introduce journal gaps or become material', t => {
  const { store } = fixture(t); complete(store); material(store);
  const before = store.getState();
  store.recordCheckpoint({ stageId: 'stable-stage', kind: 'stage_complete' });
  const after = store.getState(); assert.equal(after.revision, before.revision); assert.equal(after.materialRevision, before.materialRevision);
  assert.equal(store.eventsThrough(after.revision).length, before.eventCount);
  assert.throws(() => store.recordCheckpoint({ stageId: '../unsafe', kind: 'stage_complete' }));
  assert.throws(() => store.recordCheckpoint({ stageId: 'routine-cleanup', kind: 'cleanup' }));
  assert.equal(store.getState().reviewCadence.checkpoints.length, after.reviewCadence.checkpoints.length);
});
test('cadence: evidence-scope widening alone is not a research node; confirmed core change is', t => {
  const { store } = fixture(t); complete(store);
  store.configure({ coreText: store.getState().coreText, approvedPaths: ['plan.md', 'new-evidence.txt'], authorized: true });
  assert.equal(store.reviewEligibility({ automatic: true }).ok, false); assert.equal(store.getState().pendingChanges, true);
  store.configure({ coreText: 'Human-confirmed new scientific target', approvedPaths: ['plan.md'], authorized: true });
  assert.equal(store.reviewEligibility({ automatic: true }).ok, true);
});
test('cadence: no-material checkpoints are ignored; human check is explicit and cannot retry same failure', t => {
  const { store } = fixture(t); complete(store, 'first', 'network');
  assert.equal(store.recordCheckpoint({ stageId: 'empty-checkpoint', kind: 'stage_complete' }).changed, false);
  assert.equal(store.requestHumanCheck().changed, false);
  material(store); assert.equal(store.requestHumanCheck().changed, true); complete(store, 'human');
  assert.equal(store.requestHumanCheck().changed, false); assert.equal(store.getState().lastVerdict, 'ON_TRACK');
});
test('cadence: evidence/node arriving during active review survives without automatic cascade', t => {
  const { store } = fixture(t); const b = store.beginReview({ sessionId: 'synthetic', requestId: 'active', automatic: true });
  store.attachRun('active', 'mock-active'); material(store, 'during-run');
  store.recordCheckpoint({ stageId: 'new-decision', kind: 'plan_change' });
  assert.equal(store.beginReview({ sessionId: 'synthetic', requestId: 'duplicate', automatic: true }).ok, false);
  store.finishReview('active', { verdict: 'ON_TRACK', findings: [], runId: 'mock-active' });
  assert.equal(store.getState().reviewedRevision, b.revision); assert.equal(store.getState().pendingChanges, true);
  assert.equal(store.reviewEligibility({ automatic: true }).checkpoints.length, 1);
});
