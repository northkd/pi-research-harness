import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { MainlineStore, MODEL } from '../src/core.mjs';

// Local filesystem/unit tests: verdicts, run IDs and runtime events are MOCK, not live-model proof.
function setup(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-core-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.mkdirSync(path.join(cwd, 'notes'));
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), 'actual artifact v1');
  const store = new MainlineStore(cwd, { clock: () => 1234, ...options });
  const configure = (extra = {}) => store.configure({ coreText: 'Measure convergence honestly.', approvedPaths: ['notes/'], authorized: true, ...extra });
  return { cwd, store, configure };
}
const capture = (store, extra = {}) => store.record({ type: 'tool_result', sessionId: 'parent-A', toolName: 'write', toolCallId: 'call-1', input: { path: 'notes/plan.md', content: 'actual artifact v1' }, result: 'write succeeded', ...extra });
function start(store, requestId = 'r1') {
  const begun = store.beginReview({ sessionId: 'parent-A', requestId });
  assert.equal(begun.ok, true);
  assert.equal(store.attachRun(requestId, `mock-${requestId}`).ok, true);
  return begun;
}
const finish = (store, verdict = 'ON_TRACK', requestId = 'r1', extra = {}) => store.finishReview(requestId, { verdict, findings: [], runId: `mock-${requestId}`, ...extra });
const packet = (begun, file = 'EVIDENCE.json') => JSON.parse(fs.readFileSync(path.join(begun.packetDir, file), 'utf8'));
function child(cwd, code) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import {MainlineStore} from ${JSON.stringify(new URL('../src/core.mjs', import.meta.url).href)}; const s=new MainlineStore(${JSON.stringify(cwd)}); ${code}`], { encoding: 'utf8' });
}

test('configure, model lock, authorization, pause/resume and reopen', (t) => {
  const { cwd, store, configure } = setup(t);
  assert.equal(store.getState().enabled, false);
  assert.equal(configure().model, MODEL);
  assert.throws(() => configure({ model: 'other' }), /fixed/);
  assert.throws(() => configure({ coreText: '' }), /nonempty/);
  store.setEnabled(false);
  const reopened = new MainlineStore(cwd);
  assert.equal(reopened.getState().enabled, false);
  assert.equal(reopened.beginReview({ sessionId: 's', requestId: 'r' }).reason, 'disabled');
  reopened.setEnabled(true);
  assert.equal(reopened.getState().authorized, true);
  const state = reopened.configure({ coreText: 'Explicitly replaced core', approvedPaths: [] });
  assert.equal(state.authorized, false);
  assert.equal(state.coreRevision, 2);
  assert.equal(state.pendingChanges, true);
  assert.equal(reopened.beginReview({ sessionId: 's', requestId: 'r' }).reason, 'unauthorized');
});

test('packet provenance separates source, artifact snapshot, failure metadata and withheld summaries', (t) => {
  const { cwd, store, configure } = setup(t); configure(); capture(store);
  store.record({ type: 'plan', sessionId: 'parent-A', text: 'SELF_REPORT_NOT_PROOF' });
  store.record({ type: 'tool_result', sessionId: 'parent-B', toolName: 'bash', input: { command: 'PRIVATE_COMMAND' }, result: 'PRIVATE_OUTPUT', isError: true });
  const begun = start(store); const e = packet(begun); const m = packet(begun, 'MANIFEST.json');
  assert.equal(e.events.length, 3);
  assert.equal(e.events[0].source, 'runtime-event');
  assert.equal(e.events[0].artifact.text, 'actual artifact v1');
  assert.equal(e.events[0].result.text, 'write succeeded');
  assert.equal(e.events[2].status, 'error');
  assert.ok(e.events[1].omissions.length);
  assert.doesNotMatch(JSON.stringify(e), /SELF_REPORT_NOT_PROOF|PRIVATE_COMMAND|PRIVATE_OUTPUT/);
  assert.deepEqual(m.eventRange, [2, 4]);
  assert.deepEqual(m.capturedScope, ['notes/']);
  assert.match(m.provenance, /not execution proof/);
  assert.equal(fs.readdirSync(path.join(cwd, '.pi/mainline-supervision/events')).length, 2);
  for (const file of ['CORE.md', 'EVIDENCE.json', 'MANIFEST.json']) assert.equal(fs.statSync(path.join(begun.packetDir, file)).mode & 0o777, 0o600);
  assert.equal(fs.statSync(begun.packetDir).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(cwd, '.pi/mainline-supervision/state.json')).mode & 0o777, 0o600);
});

test('privacy whitelist denies sensitive/outside paths and redacts secrets before persistence', (t) => {
  const { cwd, store, configure } = setup(t);
  for (const p of ['../outside', '/tmp/outside', '.env', 'nested/.env.prod', '.npmrc', 'auth.json', 'settings.json', 'models.json', 'auth_token.json', 'id_rsa', '.git/', '.pi/', 'raw/', 'private/', 'trajectories/', 'notes/../foo']) assert.throws(() => configure({ approvedPaths: [p] }), undefined, p);
  configure();
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), 'api_key=VERY_SECRET_VALUE');
  capture(store, { input: { path: 'notes/plan.md', content: 'password=NEVER_STORE' }, result: 'Bearer THIS_IS_PRIVATE' });
  capture(store, { toolCallId: 'outside', input: { path: '../outside', content: 'OUTSIDE_PAYLOAD' }, result: 'OUTSIDE_PAYLOAD' });
  const begun = start(store);
  assert.doesNotMatch(JSON.stringify(packet(begun)), /VERY_SECRET_VALUE|NEVER_STORE|THIS_IS_PRIVATE|OUTSIDE_PAYLOAD/);
  assert.match(JSON.stringify(packet(begun)), /secret-marker/);
  for (const file of fs.readdirSync(path.join(cwd, '.pi/mainline-supervision/events'))) assert.doesNotMatch(fs.readFileSync(path.join(cwd, '.pi/mainline-supervision/events', file), 'utf8'), /VERY_SECRET_VALUE|NEVER_STORE|THIS_IS_PRIVATE/);
});

test('symlink escape rejected at configuration and capture; internal symlinks rejected', (t) => {
  const { cwd, store, configure } = setup(t);
  fs.symlinkSync(os.tmpdir(), path.join(cwd, 'escape'));
  assert.throws(() => configure({ approvedPaths: ['escape/'] }), /Symlink/);
  configure();
  fs.unlinkSync(path.join(cwd, 'notes/plan.md'));
  fs.symlinkSync('/proc/meminfo', path.join(cwd, 'notes/plan.md'));
  capture(store);
  assert.doesNotMatch(JSON.stringify(packet(start(store))), /MemTotal/);
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-symlink-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  fs.symlinkSync(cwd, path.join(other, '.pi'));
  assert.throws(() => new MainlineStore(other), /Symlink/);
});

test('dedupe and supervisor loop suppression retain other actual subagent activity', (t) => {
  const { store, configure } = setup(t); configure();
  assert.equal(capture(store).changed, true);
  assert.equal(capture(store, { timestamp: 999 }).changed, false);
  for (const toolName of ['mainline_supervision', 'contact_supervisor']) assert.equal(capture(store, { toolName }).changed, false);
  assert.equal(capture(store, { toolName: 'subagent', input: { agent: 'research-mainline-supervisor' } }).changed, false);
  assert.equal(capture(store, { toolName: 'subagent', input: { agent: 'research-numerics' } }).changed, true);
  assert.equal(capture(store, { sessionId: 'research-mainline-supervisor' }).changed, false);
  assert.equal(store.record({ type: 'stage_result', sessionId: 's', text: 'Subagent updates above.' }).changed, false);
  assert.equal(store.record({ type: 'unknown', sessionId: 's' }).changed, false);
  store.setEnabled(false);
  assert.equal(capture(store, { toolCallId: 'new' }).changed, false);
});

test('frozen evidence and exact request/run completion preserve future revisions', (t) => {
  const { cwd, store, configure } = setup(t); configure(); capture(store);
  const begun = start(store); const before = JSON.stringify(packet(begun));
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), 'later artifact'); capture(store, { toolCallId: 'later' });
  assert.equal(store.attachRun('wrong', 'wrong').ok, false);
  assert.equal(store.attachRun('r1', 'replacement').ok, false);
  assert.equal(finish(store, 'ON_TRACK', 'wrong').ok, false);
  assert.equal(finish(store, 'ON_TRACK', 'r1', { runId: 'wrong' }).ok, false);
  assert.equal(store.finishReview('r1', { verdict: 'ON_TRACK' }).ok, false);
  assert.equal(finish(store).ok, true);
  assert.equal(store.getState().reviewedRevision, begun.revision);
  assert.equal(store.getState().pendingChanges, true);
  assert.equal(JSON.stringify(packet(begun)), before);
  start(store, 'r2'); finish(store, 'ON_TRACK', 'r2');
  assert.equal(store.getState().pendingChanges, false);
  assert.equal(store.beginReview({ sessionId: 's', requestId: 'third' }).reason, 'no-new-evidence');
});

test('active review observed across session and process reopen; no age reclamation', (t) => {
  const { cwd, store, configure } = setup(t); configure(); start(store);
  const reopened = new MainlineStore(cwd, { clock: () => Number.MAX_SAFE_INTEGER });
  assert.equal(reopened.getState().reviewActivity.runId, 'mock-r1');
  assert.equal(reopened.beginReview({ sessionId: 'B', requestId: 'B' }).ok, false);
  const result = child(cwd, `console.log(JSON.stringify(s.beginReview({sessionId:'child',requestId:'child'})));`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, false);
  assert.equal(reopened.getState().reviewActivity.state, 'reviewing');
});

test('dead owner is unreviewed, not reclaimed, without freezing development until exact terminal evidence', (t) => {
  const { cwd, store, configure } = setup(t); configure();
  const result = child(cwd, `s.beginReview({sessionId:'child',requestId:'dead'}); s.attachRun('dead','mock-dead');`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(store.getState().reviewActivity.state, 'unverified');
  assert.equal(store.getState().blocked, false);
  assert.equal(store.getState().reviewHealth.status, 'UNREVIEWED');
  assert.equal(store.beginReview({ sessionId: 's', requestId: 'new' }).ok, false);
  assert.equal(store.finishReview('dead', { error: 'terminal failure', runId: 'wrong' }).ok, false);
  assert.equal(store.finishReview('dead', { error: 'terminal failure', runId: 'mock-dead' }).state, 'failed');
});

test('correction never erases OFF_TRACK or releases progress without re-review', (t) => {
  const { cwd, store, configure } = setup(t); configure(); capture(store); const begun = start(store);
  const off = { verdict: 'OFF_TRACK', findings: [{ evidence: 'call-1', coreStep: 'convergence', relation: 'UNRELATED', issue: 'Observed unrelated goal', correction: 'repair exact plan' }],
    coverage: 'frozen synthetic event', unverified: [], science: { status: 'UNVERIFIED', limitations: [] },
    restrictions: [{ paths: ['notes/plan.md'], eventIds: ['call-1'], evidence: 'EVIDENCE event call-1', reason: 'Observed unrelated action' }] };
  finish(store, 'OFF_TRACK', 'r1', { findings: off.findings, review: off });
  const original = fs.readFileSync(path.join(begun.packetDir, 'RESULT.json'), 'utf8');
  store.recordCorrection({ text: 'Declared correction', evidencePaths: ['notes/plan.md'] });
  assert.equal(store.getState().blocked, true);
  assert.equal(store.getState().lastVerdict, 'OFF_TRACK');
  assert.equal(store.getState().pendingChanges, false, 'A declaration is not new material evidence');
  assert.equal(store.beginReview({ sessionId: 'parent-A', requestId: 'declaration-only' }).reason, 'no-new-evidence');
  store.record({ type: 'tool_call', sessionId: 'parent-A', toolName: 'edit', input: { path: 'notes/plan.md' }, toolCallId: 'actual-repair' });
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), 'actual corrected artifact');
  capture(store, { toolName: 'edit', toolCallId: 'actual-repair', input: { path: 'notes/plan.md' }, result: 'actual repair saved' });
  assert.equal(store.getState().pendingChanges, true);
  assert.equal(packet(start(store, 'r2')).corrections[0].executionProof, false);
  finish(store, 'ON_TRACK', 'r2');
  assert.equal(store.getState().blocked, false);
  assert.equal(fs.readFileSync(path.join(begun.packetDir, 'RESULT.json'), 'utf8'), original);
  assert.equal(fs.readFileSync(path.join(cwd, '.pi/mainline-supervision/review-index.jsonl'), 'utf8').trim().split('\n').length, 2);
  assert.throws(() => store.recordCorrection({ text: 'claim', evidencePaths: ['private/secret'] }), /outside/);
});

test('advisory verdicts and unscoped OFF_TRACK do not freeze project; malformed/failed results cannot pass or auto-retry', (t) => {
  for (const verdict of ['DRIFT_RISK', 'OFF_TRACK', 'INSUFFICIENT_CONTEXT', 'INVALID']) {
    const { store, configure } = setup(t); configure(); start(store); finish(store, verdict);
    assert.equal(store.getState().blocked, false);
    assert.equal(store.getState().reviewActivity.state, verdict === 'INVALID' ? 'failed' : 'standby');
    assert.equal(store.beginReview({ sessionId: 's', requestId: 'retry' }).reason, 'no-new-evidence');
  }
  const { store, configure } = setup(t); configure(); store.beginReview({ sessionId: 's', requestId: 'r' });
  assert.equal(store.finishReview('r', { verdict: 'ON_TRACK' }).state, 'failed');
  capture(store); start(store, 'r2');
  assert.equal(finish(store, 'ON_TRACK', 'r2', { findings: [{}] }).state, 'failed');
});

test('changed core, tampered packets, missing output and secret findings fail closed', (t) => {
  for (const kind of ['core', 'packet', 'outside', 'missing', 'findings', 'error']) {
    const { store, configure } = setup(t); configure(); const begun = start(store);
    if (kind === 'core') configure({ coreText: 'Explicitly replaced core' });
    if (kind === 'packet') fs.writeFileSync(path.join(begun.packetDir, 'EVIDENCE.json'), '{}');
    const extra = kind === 'outside' ? { outputPath: '/etc/passwd' } : kind === 'missing' ? { outputPath: path.join(begun.packetDir, 'RAW_REVIEW.json') } : kind === 'findings' ? { findings: ['password=neverpersist'] } : kind === 'error' ? { error: 'password=neverpersist' } : {};
    assert.equal(finish(store, 'ON_TRACK', 'r1', extra).state, 'failed');
    assert.equal(store.getState().reviewedRevision, 0);
    assert.doesNotMatch(fs.readFileSync(path.join(begun.packetDir, 'RESULT.json'), 'utf8'), /neverpersist/);
  }
});

test('exact authorized output file can corroborate result', (t) => {
  const { store, configure } = setup(t); configure(); const begun = start(store);
  const outputPath = path.join(begun.packetDir, 'RAW_REVIEW.json');
  fs.writeFileSync(outputPath, JSON.stringify({ verdict: 'ON_TRACK', findings: [], coverage: 'synthetic', unverified: [] }), { mode: 0o600 });
  assert.equal(finish(store, 'ON_TRACK', 'r1', { outputPath }).state, 'standby');
});

test('scope narrowing withholds old evidence; explicit file and binary snapshot coverage', (t) => {
  const { cwd, store, configure } = setup(t); configure(); capture(store);
  configure({ approvedPaths: [], authorized: true });
  const e = JSON.stringify(packet(start(store)));
  assert.doesNotMatch(e, /actual artifact v1/);
  assert.match(e, /previous-scope-content-withheld/);
  finish(store);
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), 'binary\0data');
  configure({ approvedPaths: ['notes/plan.md'], authorized: true });
  const e2 = packet(start(store, 'r2'));
  assert.equal(e2.artifacts[0].omitted, 'binary-artifact');
});

test('bounded source storage and resource availability fail closed', (t) => {
  const { cwd, store, configure } = setup(t, { meminfo: 'MemAvailable: 2097152 kB\n' }); configure();
  assert.deepEqual(store.resourceGate(), { ok: true, memAvailableMiB: 2048 });
  assert.equal(new MainlineStore(cwd, { meminfo: 'MemAvailable: 2097151 kB\n' }).resourceGate().ok, false);
  assert.equal(new MainlineStore(cwd, { meminfo: '' }).resourceGate().ok, false);
  assert.equal(new MainlineStore(cwd, { meminfo: () => { throw new Error('missing'); } }).resourceGate().ok, false);
  fs.writeFileSync(path.join(cwd, 'notes/plan.md'), 'x'.repeat(9000)); capture(store);
  const begun = start(store);
  assert.match(JSON.stringify(packet(begun)), /oversized-artifact/);
  finish(store);
  const state = store.getState(); state.eventCount = 2000; // Deliberately corrupt synthetic source counter, not a real capacity fixture.
  state.materialRevision = ++state.revision;
  fs.writeFileSync(path.join(cwd, '.pi/mainline-supervision/state.json'), JSON.stringify(state));
  assert.equal(store.beginReview({ sessionId: 's', requestId: 'counter-mismatch' }).reason, 'source-event-journal-unverified');
  assert.equal(store.getState().blocked, false);
  assert.equal(store.getState().reviewHealth.status, 'BLIND_SPOT');
  assert.equal(store.getState().captureFailure, true);
  assert.equal(store.getState().omittedEvents, 0);
  assert.equal(store.beginReview({ sessionId: 's', requestId: 'no-retry' }).reason, 'source-capture-failed');
});
