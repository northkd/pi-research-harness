import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { MainlineStore } from '../src/core.mjs';
import { prepareCapture, publishCapture, capturePreview } from '../src/capture.mjs';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-repair-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const git = args => execFileSync('/usr/bin/git', args, { cwd, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.writeFileSync(path.join(cwd, 'src/example.txt'), 'before\n');
  git(['add', '--', 'src/example.txt']); git(['commit', '-qm', 'fixture']);
  fs.writeFileSync(path.join(cwd, 'src/example.txt'), '中文🙂\n'.repeat(1500));
  const store = new MainlineStore(cwd);
  store.configure({ coreText: 'Synthetic core unchanged during capture.', approvedPaths: ['src/example.txt'], authorized: true });
  return { cwd, store, git };
}
function request(extra = {}) { return { capturePaths: ['src/example.txt'], outputDir: 'research/tasks/fixture/', ...extra }; }
function consent(p) { return { source: 'direct-human-ui', confirmed: true, previewDigest: p.previewDigest, confirmedAt: 1234, sessionId: 'fixture' }; }
function finish(store, verdict = 'INSUFFICIENT_CONTEXT') {
  const started = store.beginReview({ sessionId: 'fixture', requestId: crypto.randomUUID() });
  assert.equal(started.ok, true); store.attachRun(started.requestId, 'fixture-run');
  store.finishReview(started.requestId, { verdict, findings: [], runId: 'fixture-run' });
  return started;
}
test('real core: audit reads, declarations and bookkeeping cannot restart failed/blocked evidence', t => {
  const { store } = fixture(t); finish(store);
  const attempted = store.getState().lastAttemptMaterialRevision;
  store.record({ type: 'tool_result', sessionId: 'fixture', toolName: 'read', input: { path: 'src/example.txt' }, result: 'actual source read' });
  store.record({ type: 'tool_result', sessionId: 'fixture', toolName: 'read', input: { path: '/tmp/known-status.json' }, result: 'terminal' });
  store.record({ type: 'tool_result', sessionId: 'fixture', toolName: 'bash', input: { command: 'denied' }, isError: true, gateDenied: true });
  store.recordCorrection({ text: 'Accepted; no new evidence', evidencePaths: ['src/example.txt'] });
  assert.equal(store.getState().materialRevision, attempted);
  assert.equal(store.reviewEligibility().ok, false);
  assert.equal(store.beginReview({ sessionId: 'fixture', requestId: 'repeat' }).reason, 'no-new-evidence');
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().lastVerdict, 'INSUFFICIENT_CONTEXT');
});
test('real core: actual changed source triggers once; unchanged edits do not', t => {
  const { cwd, store } = fixture(t); finish(store);
  const event = { sessionId: 'fixture', toolName: 'edit', input: { path: 'src/example.txt' } };
  store.record({ ...event, type: 'tool_call', toolCallId: 'edit1' });
  fs.appendFileSync(path.join(cwd, 'src/example.txt'), 'changed\n');
  assert.equal(store.record({ ...event, type: 'tool_result', toolCallId: 'edit1', result: 'saved' }).materialChanged, true);
  assert.equal(store.reviewEligibility().ok, true); finish(store);
  store.record({ ...event, type: 'tool_call', toolCallId: 'edit2' });
  assert.equal(store.record({ ...event, type: 'tool_result', toolCallId: 'edit2', result: 'same bytes' }).materialChanged, false);
  assert.equal(store.reviewEligibility().ok, false);
});
test('real core: known observation/declaration-only legacy tail preserves failure without reload retry', t => {
  const { cwd, store } = fixture(t); finish(store);
  store.record({ type: 'tool_result', sessionId: 'fixture', toolName: 'read', input: { path: 'src/example.txt' }, result: 'known source observation' });
  store.recordCorrection({ text: 'Known declaration only', evidencePaths: ['src/example.txt'] });
  const state = store.getState(); delete state.materialRevision; delete state.reviewedMaterialRevision; delete state.lastAttemptMaterialRevision;
  state.lastVerdict = 'FAILED'; state.blocked = true;
  fs.writeFileSync(path.join(cwd, '.pi/mainline-supervision/state.json'), JSON.stringify(state));
  const reopened = new MainlineStore(cwd);
  assert.equal(reopened.getState().lastVerdict, 'FAILED'); assert.equal(reopened.getState().blocked, false);
  assert.equal(reopened.reviewEligibility().ok, false);
});
test('real core: old ON_TRACK cannot release subsequent material changes', t => {
  const { cwd, store } = fixture(t);
  const b = store.beginReview({ sessionId: 'fixture', requestId: 'before-edit' }); store.attachRun('before-edit', 'old');
  const e = { sessionId: 'fixture', toolName: 'edit', input: { path: 'src/example.txt' } };
  store.record({ ...e, type: 'tool_call' }); fs.appendFileSync(path.join(cwd, 'src/example.txt'), 'new\n'); store.record({ ...e, type: 'tool_result' });
  store.finishReview('before-edit', { verdict: 'ON_TRACK', findings: [], runId: 'old' });
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().pendingChanges, true); assert.equal(store.getState().reviewedRevision, b.revision);
  assert.equal(store.reviewEligibility().ok, true);
});
test('fixed capture: UTF8 full coverage, commands, UI grant, frozen core, and denied publication', t => {
  const { cwd, store } = fixture(t); finish(store);
  const core = store.getState().coreText;
  const p = prepareCapture(store, request());
  assert.ok(capturePreview(p, 'fixed-model').includes('fixed-model'));
  assert.ok(p.parts.every(part => part.bytes.length <= 6144));
  assert.throws(() => publishCapture(store, p, { ...consent(p), confirmed: false }), /consent/);
  assert.equal(fs.existsSync(path.join(cwd, p.directory)), false);
  publishCapture(store, p, consent(p));
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().coreText, core);
  assert.equal(store.getState().publicationPending, true);
  const b = store.beginReview({ sessionId: 'fixture', requestId: 'captured' }); assert.equal(b.ok, true);
  const e = JSON.parse(fs.readFileSync(path.join(b.packetDir, 'EVIDENCE.json')));
  assert.equal(e.captures.length, 1);
  const cap = e.captures[0];
  const catalog = Buffer.concat(cap.manifest.inventoryParts.map(leaf => Buffer.from(cap.files.find(f => f.path === p.directory + '/' + leaf).text)));
  assert.equal(hash(catalog), cap.manifest.inventorySha256);
  const index = JSON.parse(catalog);
  for (const stream of index.inventory) {
    const bytes = Buffer.concat(stream.parts.map(part => Buffer.from(cap.files.find(f => f.path === p.directory + '/' + part.leaf).text)));
    assert.equal(hash(bytes), stream.sha256); assert.equal(bytes.length, stream.bytes);
  }
  assert.ok(index.operations.some(o => o.argv.includes('--no-textconv')));
  assert.ok(index.operations.every(o => o.executable === '/usr/bin/git'));
  assert.equal(cap.receipt.consent.source, 'direct-human-ui');
  assert.equal(store.reviewEligibility().ok, false);
});
test('fixed capture: escape, subtree, injection, sensitive and symlink sources fail closed', t => {
  const { cwd, store } = fixture(t);
  for (const source of ['../escape', '/etc/passwd', 'src/', '.env', '.pi/state.json', 'src/example.txt;touch', ':(glob)**'])
    assert.throws(() => prepareCapture(store, request({ capturePaths: [source] })), undefined, source);
  assert.throws(() => prepareCapture(store, request({ command: 'arbitrary' })), /Unknown/);
  assert.throws(() => prepareCapture(store, request({ outputDir: 'src/' })), /research\/tasks/);
  fs.symlinkSync('/proc/meminfo', path.join(cwd, 'src/link.txt'));
  assert.throws(() => store.configure({ coreText: store.getState().coreText, approvedPaths: ['src/link.txt'], authorized: true }), /Symlink/);
  fs.unlinkSync(path.join(cwd, 'src/example.txt')); fs.symlinkSync('/proc/meminfo', path.join(cwd, 'src/example.txt'));
  assert.throws(() => prepareCapture(store, request()), /Symlink/);
});
test('fixed capture: no clean/process/external/fsmonitor Git helper is executed', t => {
  const { cwd, store, git } = fixture(t);
  const sentinel = path.join(cwd, 'helper-ran');
  fs.writeFileSync(path.join(cwd, '.gitattributes'), 'src/example.txt filter=malicious diff=malicious\n');
  const command = `sh -c 'touch "${sentinel}"; cat'`;
  git(['config', 'filter.malicious.clean', command]); git(['config', 'filter.malicious.process', command]);
  git(['config', 'filter.malicious.required', 'true']); git(['config', 'diff.malicious.command', command]);
  git(['config', 'diff.malicious.textconv', command]); git(['config', 'core.fsmonitor', command]);
  const p = prepareCapture(store, request());
  assert.ok(p.parts.length > 0); assert.equal(fs.existsSync(sentinel), false);
});
test('fixed capture: changed core during confirmation refuses publication', t => {
  const { cwd, store } = fixture(t); const p = prepareCapture(store, request());
  store.configure({ coreText: 'Human-changed core after preview', approvedPaths: ['src/example.txt'], authorized: true });
  assert.throws(() => publishCapture(store, p, consent(p)), /changed during consent/);
  assert.equal(fs.existsSync(path.join(cwd, p.directory)), false);
});
test('fixed capture: modified published chunks fail packet creation instead of proving ON_TRACK', t => {
  const { cwd, store } = fixture(t); finish(store);
  const p = prepareCapture(store, request()); publishCapture(store, p, consent(p));
  fs.appendFileSync(path.join(cwd, p.parts[0].path), 'tamper');
  assert.equal(store.beginReview({ sessionId: 'fixture', requestId: 'tampered' }).reason, 'packet-creation-failed');
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().reviewHealth.kind, 'packet-failure');
});
test('fixed capture: scope narrowing withholds previously captured bytes', t => {
  const { store } = fixture(t);
  const p = prepareCapture(store, request()); publishCapture(store, p, consent(p));
  store.configure({ coreText: store.getState().coreText, approvedPaths: [], authorized: true });
  const b = store.beginReview({ sessionId: 'fixture', requestId: 'narrowed' }); assert.equal(b.ok, true);
  const e = JSON.parse(fs.readFileSync(path.join(b.packetDir, 'EVIDENCE.json')));
  assert.equal(e.captures[0].omitted, 'capture-scope-withheld'); assert.doesNotMatch(JSON.stringify(e.captures), /中文/);
});
