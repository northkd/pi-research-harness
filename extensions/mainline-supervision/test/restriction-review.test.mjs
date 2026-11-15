import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainlineStore } from '../src/core.mjs';
import { digest } from '../src/policy.mjs';

// Local unit test with synthetic state. It verifies dispatch semantics only:
// no model is called and no scientific verdict is implied.
function setup(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'restriction-review-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'notes'));
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), 'v1');
  const store = new MainlineStore(cwd, { clock: () => 1234 });
  store.configure({ coreText: 'Measure convergence honestly.', approvedPaths: ['notes/'], authorized: true });
  return { cwd, store };
}

function activateRestriction(store) {
  store.mutate((s) => {
    s.branchRestrictions.push({
      id: 'r1:0', paths: ['notes/plan.md'], eventIds: ['call-1'], evidence: 'synthetic',
      reason: 'synthetic restriction for dispatch test', requestId: 'r1', runId: 'mock-r1',
      coreRevision: s.coreRevision, coreDigest: digest(s.coreText), revision: s.revision, active: true,
      source: 'grounded-native-review',
    });
    s.blocked = true;
    return s;
  });
}

test('no restriction: check does not invent a review node', (t) => {
  const { store } = setup(t);
  store.record({ type: 'tool_result', sessionId: 'parent-A', toolName: 'write', toolCallId: 'call-1', input: { path: 'notes/plan.md' }, result: 'ok' });
  const result = store.requestRestrictionReview();
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-active-restriction');
});

test('restriction without a correction: no targeted review', (t) => {
  const { store } = setup(t);
  activateRestriction(store);
  store.record({ type: 'tool_result', sessionId: 'parent-A', toolName: 'write', toolCallId: 'call-2', input: { path: 'notes/plan.md' }, result: 'ok' });
  const result = store.requestRestrictionReview();
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'no-declared-correction');
});

test('correction plus new evidence creates exactly one targeted review node', (t) => {
  const { store } = setup(t);
  activateRestriction(store);
  store.recordCorrection({ text: 'Rewrote the convergence check to use the declared tolerance.', evidencePaths: ['notes/plan.md'] });
  store.record({ type: 'tool_result', sessionId: 'parent-A', toolName: 'write', toolCallId: 'call-3', input: { path: 'notes/plan.md' }, result: 'ok' });

  const first = store.requestRestrictionReview();
  assert.equal(first.changed, true);
  assert.equal(first.checkpoint.kind, 'stage_complete');
  assert.equal(first.checkpoint.source, 'restriction-correction-review');

  // Calling check again without new material must not spawn another review.
  const second = store.requestRestrictionReview();
  assert.equal(second.changed, false);
});

test('restriction review does nothing once supervision is disabled', (t) => {
  const { store } = setup(t);
  activateRestriction(store);
  store.recordCorrection({ text: 'fix', evidencePaths: ['notes/plan.md'] });
  store.record({ type: 'tool_result', sessionId: 'parent-A', toolName: 'write', toolCallId: 'call-4', input: { path: 'notes/plan.md' }, result: 'ok' });
  store.setEnabled(false);
  const result = store.requestRestrictionReview();
  assert.equal(result.changed, false);
  assert.equal(result.reason, 'supervision-not-enabled');
});
