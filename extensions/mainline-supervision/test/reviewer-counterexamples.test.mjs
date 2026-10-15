// Targeted, executable reviewer B1–B4/B6 counterexamples. Synthetic fixtures only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MainlineStore } from '../src/core.mjs';
import { prepareCapture, publishCapture } from '../src/capture.mjs';
function fixture(t, gitRepo = false) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-review-fix-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src/a.txt'), 'captured-marker-ONLY_THIS_GRANT\n');
  const store = new MainlineStore(cwd);
  store.configure({ coreText: 'Synthetic frozen core.', approvedPaths: ['src/a.txt'], authorized: true });
  const git = args => execFileSync('/usr/bin/git', args, { cwd, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
  if (gitRepo) { git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']); git(['add', '--', 'src/a.txt']); git(['commit', '-qm', 'fixture']); }
  return { cwd, store, git };
}
function start(store, id = crypto.randomUUID()) { const b = store.beginReview({ sessionId: 'fixture', requestId: id }); assert.equal(b.ok, true); store.attachRun(id, 'synthetic-' + id); return b; }
function finish(store, b, verdict = 'ON_TRACK') { return store.finishReview(b.requestId, { verdict, findings: [], runId: 'synthetic-' + b.requestId }); }
function stripLegacy(cwd, extra = {}) {
  const p = path.join(cwd, '.pi/mainline-supervision/state.json'); const s = JSON.parse(fs.readFileSync(p));
  for (const k of ['materialRevision', 'reviewedMaterialRevision', 'lastAttemptMaterialRevision', 'materialFileDigests', 'captureReceipts']) delete s[k];
  if (s.reviewActivity) delete s.reviewActivity.materialRevision;
  Object.assign(s, extra); fs.writeFileSync(p, JSON.stringify(s));
}
test('B1: legacy real edit pending after attempted revision survives migration and old ON_TRACK', t => {
  const { cwd, store } = fixture(t); const first = start(store, 'legacy-running');
  const e = { sessionId: 'fixture', toolName: 'edit', toolCallId: 'legacy-change', input: { path: 'src/a.txt' } };
  store.record({ ...e, type: 'tool_call' }); fs.appendFileSync(path.join(cwd, 'src/a.txt'), 'real pending change');
  store.record({ ...e, type: 'tool_result', result: 'saved' });
  stripLegacy(cwd); const reopened = new MainlineStore(cwd);
  assert.equal(reopened.reviewEligibility().ok, true);
  finish(reopened, first);
  assert.equal(reopened.getState().blocked, false);
  assert.equal(reopened.getState().pendingChanges, true);
});
test('B1: unknown legacy tail is pending/blocked rather than silently discarded', t => {
  const { cwd, store } = fixture(t); const b = start(store); finish(store, b);
  stripLegacy(cwd, { revision: store.getState().revision + 2 });
  const s = new MainlineStore(cwd); assert.equal(s.reviewEligibility().ok, true);
  assert.equal(s.getState().blocked, false); assert.equal(s.getState().pendingChanges, true);
});
test('B1 final gate: a new ON_TRACK cannot clear an unknown legacy evidence tail', t => {
  const { cwd, store } = fixture(t); const b = start(store); finish(store, b);
  stripLegacy(cwd, { revision: store.getState().revision + 2 });
  const reopened = new MainlineStore(cwd);
  assert.ok(reopened.getState().migrationUnverifiedTail);
  const next = start(reopened, 'unknown-tail-review');
  const evidence = JSON.parse(fs.readFileSync(path.join(next.packetDir, 'EVIDENCE.json')));
  const manifest = JSON.parse(fs.readFileSync(path.join(next.packetDir, 'MANIFEST.json')));
  assert.ok(evidence.sourceGaps.some(g => g.kind === 'unverified-legacy-tail'));
  assert.ok(manifest.omissions.some(message => /legacy.*unverified/i.test(message)));
  finish(reopened, next, 'ON_TRACK');
  const terminal = JSON.parse(fs.readFileSync(path.join(next.packetDir, 'RESULT.json')));
  assert.equal(terminal.verdict, 'ON_TRACK'); assert.equal(terminal.error, undefined);
  assert.ok(terminal.sourceGaps.some(g => g.kind === 'unverified-legacy-tail'));
  assert.equal(terminal.publicationAuthorized, false);
  const after = new MainlineStore(cwd).getState();
  assert.equal(after.blocked, false); assert.equal(after.reviewHealth.status, 'BLIND_SPOT');
  assert.ok(after.migrationUnverifiedTail);
  assert.equal(reopened.reviewEligibility().ok, false, 'Failure cannot self-retry the same material');
});
test('B1 final gate: a declaration, scope change or unrelated capture cannot certify the historical gap', t => {
  const { cwd, store } = fixture(t, true); const b = start(store); finish(store, b);
  stripLegacy(cwd, { revision: store.getState().revision + 1 });
  const s = new MainlineStore(cwd);
  s.recordCorrection({ text: 'Declaration is not recovered evidence', evidencePaths: ['src/a.txt'] });
  s.configure({ coreText: s.getState().coreText, approvedPaths: ['src/a.txt', 'src/b.txt'], authorized: true });
  const p = prepareCapture(s, { capturePaths: ['src/a.txt'], outputDir: 'research/tasks/unrelated/' });
  publishCapture(s, p, { source: 'direct-human-ui', confirmed: true, previewDigest: p.previewDigest });
  const next = start(s); finish(s, next, 'ON_TRACK');
  assert.equal(s.getState().blocked, false); assert.ok(s.getState().migrationUnverifiedTail);
  assert.equal(s.getState().publicationPending, true);
});
test('B2: scope replacement revokes prior correction grant', t => {
  const { store } = fixture(t); const b = start(store); finish(store, b, 'OFF_TRACK');
  store.recordCorrection({ text: 'Repair only a', evidencePaths: ['src/a.txt'] });
  store.configure({ coreText: store.getState().coreText, approvedPaths: [], authorized: true });
  assert.deepEqual(store.getState().correctionPaths, []);
});
test('B3: partial capture scope withholds marker across events/artifacts/corrections, not just captures', t => {
  const { cwd, store } = fixture(t, true);
  const p = prepareCapture(store, { capturePaths: ['src/a.txt'], outputDir: 'research/tasks/fixture/' });
  publishCapture(store, p, { source: 'direct-human-ui', confirmed: true, previewDigest: p.previewDigest });
  const marked = p.parts.find(x => x.bytes.toString().includes('captured-marker-ONLY_THIS_GRANT'));
  assert.ok(marked);
  store.record({ type: 'tool_result', sessionId: 'fixture', toolName: 'read', toolCallId: 'chunk-read', input: { path: marked.path }, result: marked.bytes.toString() });
  store.recordCorrection({ text: 'Captured chunk bookkeeping', evidencePaths: [marked.path] });
  store.configure({ coreText: store.getState().coreText, approvedPaths: [marked.path], authorized: true });
  const b = start(store); const text = fs.readFileSync(path.join(b.packetDir, 'EVIDENCE.json'), 'utf8');
  assert.doesNotMatch(text, /captured-marker-ONLY_THIS_GRANT/);
  assert.match(text, /capture-scope-withheld/);
});
test('B4: real failed edit is material exactly once; gate rejection remains nonmaterial', t => {
  const { store } = fixture(t); const b = start(store); finish(store, b);
  const e = { sessionId: 'fixture', toolName: 'edit', toolCallId: 'actual-failure', input: { path: 'src/a.txt' } };
  store.record({ ...e, type: 'tool_call' });
  const result = { ...e, type: 'tool_result', result: 'oldText not found', isError: true };
  assert.equal(store.record(result).materialChanged, true);
  const revision = store.getState().materialRevision;
  assert.equal(store.record(result).changed, false); assert.equal(store.getState().materialRevision, revision);
  const next = start(store); finish(store, next);
  store.record({ ...e, type: 'tool_result', toolCallId: 'gate-rejected', result: 'not executed', isError: true, gateDenied: true });
  assert.equal(store.reviewEligibility().ok, false);
});
test('B6: promisor repo with missing blob is refused without SSH helper execution or publication', t => {
  const { cwd, store, git } = fixture(t, true);
  const blob = git(['rev-parse', 'HEAD:src/a.txt']).toString().trim();
  fs.unlinkSync(path.join(cwd, '.git/objects', blob.slice(0, 2), blob.slice(2)));
  const sentinel = path.join(cwd, 'transport-helper-ran');
  const helper = path.join(cwd, 'ssh-sentinel');
  fs.writeFileSync(helper, '#!/bin/sh\ntouch "' + sentinel + '"\nexit 1\n', { mode: 0o700 });
  git(['config', 'remote.origin.url', 'ssh://fixture.invalid/never-network']);
  git(['config', 'remote.origin.promisor', 'true']); git(['config', 'extensions.partialClone', 'origin']);
  git(['config', 'core.sshCommand', helper]);
  assert.throws(() => prepareCapture(store, { capturePaths: ['src/a.txt'], outputDir: 'research/tasks/refused/' }), /promisor|partial|local-only|transport/i);
  assert.equal(fs.existsSync(sentinel), false); assert.equal(fs.existsSync(path.join(cwd, 'research/tasks/refused')), false);
});
