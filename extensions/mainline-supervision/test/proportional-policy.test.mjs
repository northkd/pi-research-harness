// Synthetic direction/science, scoped restrictions and human authorization regression. No live model/project.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainlineStore } from '../src/core.mjs';
import { validReview, operationDecision, validateLocalOperation, referencesEvent } from '../src/policy.mjs';
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-proportional-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'src')); fs.mkdirSync(path.join(cwd, 'tests'));
  for (const f of ['src/a.py', 'src/b.py', 'tests/a.py']) fs.writeFileSync(path.join(cwd, f), 'print("synthetic")\n');
  const store = new MainlineStore(cwd, { meminfo: 'MemAvailable: 4194304 kB' });
  store.configure({ coreText: 'Synthetic core: develop CPU candidate finder; testing is unfinished.', approvedPaths: ['src/', 'tests/'], authorized: true });
  return { cwd, store };
}
const review = (verdict = 'ON_TRACK', extra = {}) => ({ verdict, findings: [], coverage: 'Frozen synthetic development evidence', unverified: ['Tests unfinished'],
  science: { status: 'UNVERIFIED', limitations: ['No test success yet'] }, restrictions: [], ...extra });
function complete(store, result, id = 'r') {
  const b = store.beginReview({ sessionId: 'fixture', requestId: id }); assert.equal(b.ok, true, JSON.stringify(b));
  store.attachRun(id, 'run-' + id);
  fs.writeFileSync(path.join(b.packetDir, 'RAW_REVIEW.json'), JSON.stringify(result));
  assert.equal(store.finishReview(id, { verdict: result.verdict, findings: result.findings, review: result,
    outputPath: path.join(b.packetDir, 'RAW_REVIEW.json'), runId: 'run-' + id }).ok, true);
  return b;
}
const decide = (store, toolName, input) => operationDecision(store, store.getState(), { toolName, input });
const consent = { source: 'direct-human-ui', confirmed: true };
function grant(store, extra = {}) {
  return store.allowOperation({ toolName: 'bash', input: { command: 'python3 tests/a.py', timeout: 30 }, paths: ['tests/a.py'],
    reason: 'Obtain missing test evidence, not publication', expectedCoreRevision: store.getState().coreRevision, consent, ...extra });
}
function off(store) {
  const e = { type: 'tool_result', sessionId: 'fixture', toolName: 'write', toolCallId: 'actual-a', input: { path: 'src/a.py' }, result: 'saved' };
  store.record(e);
  const result = review('OFF_TRACK', { findings: [{ evidence: 'actual-a', coreStep: 'CPU finder', relation: 'UNRELATED', issue: 'Demonstrated synthetic unrelated branch', correction: 'repair a only' }],
    restrictions: [{ paths: ['src/a.py'], eventIds: ['actual-a'], evidence: 'EVIDENCE.json event actual-a', reason: 'Observed unrelated action' }] });
  return complete(store, result);
}
test('direction ON_TRACK coexists with science UNVERIFIED and does not authorize publication', t => {
  const { store } = fixture(t); const v = review(); assert.equal(validReview(v), true); complete(store, v);
  assert.equal(store.getState().lastVerdict, 'ON_TRACK'); assert.equal(store.getState().lastScience.status, 'UNVERIFIED');
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().publicationPending, true);
  assert.equal(decide(store, 'edit', { path: 'src/a.py', edits: [] }).allow, true);
});
test('risk, missing direction context and failed review do not freeze development or human input', t => {
  for (const verdict of ['DRIFT_RISK', 'INSUFFICIENT_CONTEXT']) {
    const { store } = fixture(t); complete(store, review(verdict));
    assert.equal(store.getState().blocked, false); assert.equal(decide(store, 'ask_user', {}).allow, true);
    assert.equal(decide(store, 'write', { path: 'src/b.py', content: 'research continues' }).allow, true);
    grant(store); assert.equal(decide(store, 'bash', { command: 'python3 tests/a.py', timeout: 30 }).allow, true);
  }
  const { store } = fixture(t); const b = store.beginReview({ sessionId: 'fixture', requestId: 'failed' }); store.attachRun('failed', 'run-failed');
  store.finishReview('failed', { error: 'network', runId: 'run-failed' });
  assert.equal(store.getState().lastVerdict, 'FAILED'); assert.equal(store.getState().blocked, false);
  assert.equal(store.getState().reviewHealth.status, 'UNREVIEWED');
  assert.equal(decide(store, 'edit', { path: 'src/a.py' }).allow, true); assert.equal(decide(store, 'ask_user', {}).allow, true);
  assert.equal(store.reviewEligibility().ok, false); assert.ok(b.packetDir);
});
test('grounded OFF_TRACK pauses exact affected file, not other development or human channel', t => {
  const { store } = fixture(t); const b = off(store); const before = fs.readFileSync(path.join(b.packetDir, 'RESULT.json'));
  assert.equal(store.getState().blocked, true); assert.equal(store.getState().branchRestrictions.length, 1);
  assert.equal(decide(store, 'write', { path: 'src/a.py' }).allow, false);
  assert.equal(decide(store, 'write', { path: 'src/b.py' }).allow, true); assert.equal(decide(store, 'ask_user', {}).allow, true);
  store.recordCorrection({ text: 'Repair bounded a branch', evidencePaths: ['src/a.py'] });
  assert.equal(decide(store, 'edit', { path: 'src/a.py' }).allow, true);
  const ids = store.getState().branchRestrictions.map(r => r.id);
  assert.throws(() => store.recordHumanDecision({ restrictionIds: ids, effect: 'release_branch', text: 'No confirmation' }), /human/i);
  store.recordHumanDecision({ restrictionIds: ids, effect: 'release_branch', text: 'Human accepts this branch resumption; no scientific pass', consent });
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().lastVerdict, 'OFF_TRACK');
  assert.deepEqual(fs.readFileSync(path.join(b.packetDir, 'RESULT.json')), before); assert.equal(store.getState().publicationPending, true);
});
test('OFF_TRACK without exact material path event is advisory and cannot invent a global freeze', t => {
  const { store } = fixture(t);
  complete(store, review('OFF_TRACK', { restrictions: [{ paths: ['src/'], eventIds: ['missing'], evidence: 'not observed', reason: 'guess' }] }));
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().branchRestrictions.length, 0);
  assert.equal(decide(store, 'edit', { path: 'src/b.py' }).allow, true);
});
test('old omissions stay blind spots; current direction does not retroactively certify old evidence', t => {
  const { store } = fixture(t); const s = store.getState(); s.omittedEvents = 12; s.captureLimitReached = true; s.blocked = true;
  delete s.policyVersion; fs.writeFileSync(path.join(store.root, 'state.json'), JSON.stringify(s));
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().legacyGate.blocked, true);
  const b = complete(store, review()); const result = JSON.parse(fs.readFileSync(path.join(b.packetDir, 'RESULT.json')));
  assert.equal(store.getState().omittedEvents, 12); assert.ok(result.sourceGaps.some(g => g.count === 12));
  assert.equal(result.publicationAuthorized, false); assert.equal(store.getState().reviewHealth.status, 'BLIND_SPOT');
  grant(store); assert.equal(decide(store, 'bash', { command: 'python3 tests/a.py', timeout: 30 }).allow, true);
});
test('bounded local operation binds input, file versions and core, preserves data/egress/resource boundaries', t => {
  const { cwd, store } = fixture(t); complete(store, review('INSUFFICIENT_CONTEXT')); grant(store);
  const input = { command: 'python3 tests/a.py', timeout: 30 };
  assert.equal(decide(store, 'bash', input).allow, true);
  assert.equal(decide(store, 'bash', input).grantId, store.getState().operationGrants[0].id);
  assert.equal(decide(store, 'bash', { ...input, timeout: 31 }).grantId, undefined);
  fs.appendFileSync(path.join(cwd, 'tests/a.py'), '# changed'); assert.equal(decide(store, 'bash', input).grantId, undefined);
  for (const command of ['curl https://example.invalid', 'rm src/a.py', 'node -e code', 'python3 -c code', 'node --require src/a.py tests/a.py'])
    assert.throws(() => validateLocalOperation(store, 'bash', { command, timeout: 30 }, ['tests/a.py']), undefined, command);
  assert.throws(() => grant(store, { input: { command: 'python3 tests/a.py', timeout: 121 } }), /120/);
  assert.equal(decide(store, 'write', { path: 'raw/input.csv' }).allow, false); assert.equal(decide(store, 'edit', { path: '.env' }).allow, false);
  assert.notEqual(decide(store, 'web_search', { query: 'private data' }).allow, true);
  grant(store); store.meminfo = 'MemAvailable: 1000 kB'; assert.equal(decide(store, 'bash', input).allow, false);
  assert.equal(decide(store, 'ask_user', {}).allow, true); store.meminfo = 'MemAvailable: 4194304 kB';
  store.configure({ coreText: 'Human changed core', approvedPaths: ['src/', 'tests/'], authorized: true });
  assert.equal(store.getState().operationGrants.length, 0);
});
test('bounded visible tests keep original task permissions without repeated supervision approval', t => {
  const { store } = fixture(t); complete(store, review('INSUFFICIENT_CONTEXT'));
  const input = { command: 'python3 tests/a.py', timeout: 30 };
  assert.equal(decide(store, 'bash', input).allow, true); assert.equal(store.getState().operationGrants.length, 0);
  const preview = validateLocalOperation(store, 'bash', input, ['tests/a.py']);
  fs.appendFileSync(path.join(store.cwd, 'tests/a.py'), '# changed during UI');
  assert.throws(() => grant(store, { expectedPathDigests: preview.pathDigests }), /changed during consent/);
  grant(store); store.meminfo = 'MemAvailable: 1000 kB';
  assert.equal(decide(store, 'bash', input).allow, false);
  assert.equal(decide(store, 'bg_run', { command: 'node tests/a.py', timeoutSeconds: 30, name: 'Local check', isAgent: false }).allow, false);
  assert.equal(decide(store, 'ask_user', {}).allow, true);
});
test('one UNRELATED finding cannot ground a different restricted event', t => {
  const { store } = fixture(t);
  store.record({ type: 'tool_result', sessionId: 'fixture', toolName: 'write', toolCallId: 'actual-a', input: { path: 'src/a.py' }, result: 'saved' });
  complete(store, review('OFF_TRACK', { findings: [{ evidence: 'different-event', coreStep: 'CPU', relation: 'UNRELATED', issue: 'Other event only', correction: 'inspect' }],
    restrictions: [{ paths: ['src/a.py'], eventIds: ['actual-a'], evidence: 'actual-a', reason: 'not connected to finding' }] }));
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().branchRestrictions.length, 0);
});
test('P2 exact event references reject prefix and numeric revision collisions', t => {
  assert.equal(referencesEvent('event call-10', 'call-1'), false);
  assert.equal(referencesEvent('event call-1', 'call-1'), true);
  assert.equal(referencesEvent('revision 20', '2'), false); assert.equal(referencesEvent('2 issues', '2'), false);
  assert.equal(referencesEvent('revision:2', '2'), true);
  const { store } = fixture(t);
  for (const [toolCallId, p] of [['call-1', 'src/a.py'], ['call-10', 'src/b.py']])
    store.record({ type: 'tool_result', sessionId: 'fixture', toolName: 'write', toolCallId, input: { path: p }, result: 'saved' });
  complete(store, review('OFF_TRACK', { findings: [{ evidence: 'event call-10', coreStep: 'CPU', relation: 'UNRELATED', issue: 'Only b', correction: 'b' }],
    restrictions: [{ paths: ['src/a.py'], eventIds: ['call-1'], evidence: 'call-1', reason: 'prefix mismatch' }] }));
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().branchRestrictions.length, 0);
});
test('capture failure keeps dispatch unverified but not every development action denied', t => {
  const { store } = fixture(t); store.markCaptureFailure();
  assert.equal(store.beginReview({ sessionId: 'fixture', requestId: 'missing' }).reason, 'source-capture-failed');
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().reviewHealth.status, 'BLIND_SPOT');
  assert.equal(decide(store, 'edit', { path: 'src/a.py' }).allow, true); assert.equal(decide(store, 'ask_user', {}).allow, true);
});
