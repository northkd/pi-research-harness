#!/usr/bin/env node
/** Actual installed Pi loader/lifecycle gates; all review verdicts seeded locally. No model, network or private project. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { host, packageRoot as root, agentDir } from './host-env.mjs';
const installedEntry = path.join(root, 'src/index.ts');
const { MainlineStore } = await import(root + '/src/core.mjs');
const { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } = await import(host + '/dist/index.js');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-sdk-proportional-'));
fs.mkdirSync(path.join(cwd, 'src')); fs.mkdirSync(path.join(cwd, 'tests'));
fs.writeFileSync(path.join(cwd, 'src/a.py'), '# synthetic branch a\n');
fs.writeFileSync(path.join(cwd, 'src/b.py'), '# synthetic branch b\n');
fs.writeFileSync(path.join(cwd, 'tests/check.py'), 'print("synthetic local test ran")\n');
const store = new MainlineStore(cwd, { meminfo: 'MemAvailable: 4194304 kB' });
store.configure({ coreText: 'Synthetic CPU-only development goal. Testing unfinished is not drift.', approvedPaths: ['src/', 'tests/'], authorized: true });
const base = verdict => ({ verdict, findings: [], coverage: 'Synthetic seeded local direction result; no native model ran.', unverified: ['Tests not run yet'],
  science: { status: 'UNVERIFIED', limitations: ['No scientific acceptance'] }, restrictions: [] });
function finish(requestId, review) {
  const begun = store.beginReview({ sessionId: 'synthetic-seed', requestId }); assert.equal(begun.ok, true, JSON.stringify(begun));
  store.attachRun(requestId, 'mock-' + requestId);
  const outputPath = path.join(begun.packetDir, 'RAW_REVIEW.json'); fs.writeFileSync(outputPath, JSON.stringify(review));
  assert.equal(store.finishReview(requestId, { verdict: review.verdict, findings: review.findings, review, outputPath, runId: 'mock-' + requestId }).ok, true);
}
finish('initial', base('INSUFFICIENT_CONTEXT'));
const statePath = path.join(store.root, 'state.json');
const legacy = store.getState(); delete legacy.policyVersion; legacy.blocked = true; legacy.omittedEvents = 3;
legacy.eventSourceGaps.push({ kind: 'unpersisted-source-events', count: 3, status: 'UNVERIFIED', executionProof: false });
fs.writeFileSync(statePath, JSON.stringify(legacy));
const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [installedEntry], systemPrompt: 'Local synthetic integration checks only, no model prompts.' });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader,
  settingsManager: settings, sessionManager: SessionManager.inMemory(), tools: ['mainline_supervision'] });
let allow = true, confirmations = 0;
const errors = [];
const ui = new Proxy({ confirm: async () => { confirmations++; return allow; }, setStatus() {}, notify() {}, setWidget() {},
  getEditorText: () => '', select: async () => undefined, input: async () => undefined, editor: async () => undefined },
  { get(t, key) { return key in t ? t[key] : () => {}; } });
let report;
try {
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: e => errors.push({ event: e.event, error: e.error }) });
  const runner = session.extensionRunner;
  const tool = runner.getToolDefinition('mainline_supervision'); assert.ok(tool);
  for (const action of ['capture', 'allow_operation', 'decision']) assert.ok(tool.parameters.properties.action.enum.includes(action));
  const call = (name, input, id = name) => runner.emitToolCall({ type: 'tool_call', toolName: name, toolCallId: id, input });
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().legacyGate.blocked, true);
  assert.equal(store.getState().omittedEvents, 3); assert.equal(store.getState().publicationPending, true);
  assert.equal(await call('ask_user', { method: 'confirm', title: 'Synthetic question' }), undefined);
  assert.equal(await call('write', { path: 'src/b.py', content: '# allowed development' }), undefined);
  const input = { command: 'python3 tests/check.py', timeout: 30 };
  const confirmationsBeforeTest = confirmations;
  assert.equal(await call('bash', input, 'short-test'), undefined);
  assert.equal(confirmations, confirmationsBeforeTest, 'Visible short test adds no repeated supervision consent');
  const testOutput = execFileSync('/usr/bin/python3', ['tests/check.py'], { cwd, timeout: 30000, encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(testOutput.trim(), 'synthetic local test ran');
  await runner.emitToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: 'short-test', input,
    content: [{ type: 'text', text: testOutput }], isError: false });
  assert.equal((await call('write', { path: 'raw/input.csv', content: 'must not overwrite' })).block, true);
  assert.equal((await call('bash', { command: 'rm src/a.py' })).block, true);
  assert.equal((await call('parallel', { tool_uses: [
    { recipient_name: 'functions.bash', parameters: { command: 'opaque local command' } },
    { recipient_name: 'functions.write', parameters: { path: 'raw/input.csv', content: 'must not overwrite' } },
  ] })).block, true);
  store.record({ type: 'tool_result', sessionId: 'synthetic-seed', toolName: 'write', toolCallId: 'off-a', input: { path: 'src/a.py' }, result: 'synthetic unrelated branch event' });
  finish('off', { ...base('OFF_TRACK'), findings: [{ evidence: 'event off-a', coreStep: 'CPU development', relation: 'UNRELATED', issue: 'Synthetic unrelated a only', correction: 'Bounded a repair' }],
    restrictions: [{ paths: ['src/a.py'], eventIds: ['off-a'], evidence: 'EVIDENCE event off-a', reason: 'Observed a only' }] });
  assert.equal(store.getState().blocked, true);
  assert.equal((await call('edit', { path: 'src/a.py', edits: [] })).block, true);
  assert.equal(await call('edit', { path: 'src/b.py', edits: [] }), undefined);
  assert.equal(await call('ask_user', {}), undefined);
  const ctx = runner.createToolContext('human-decision');
  const ids = store.getState().branchRestrictions.map(r => r.id);
  allow = false;
  await assert.rejects(tool.execute('decline', { action: 'decision', effect: 'release_branch', restrictionIds: ids, text: 'Synthetic scoped resumption' }, undefined, () => {}, ctx), /declined/);
  assert.equal(store.getState().blocked, true);
  allow = true;
  await tool.execute('accept', { action: 'decision', effect: 'release_branch', restrictionIds: ids, text: 'Synthetic human branch decision only, not scientific publication' }, undefined, () => {}, ctx);
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().lastVerdict, 'OFF_TRACK');
  assert.equal(store.getState().omittedEvents, 3);
  store.markCaptureFailure();
  assert.equal(await call('ask_user', {}), undefined); assert.equal(await call('edit', { path: 'src/b.py', edits: [] }), undefined);
  const saved = store.getState(); fs.writeFileSync(statePath, '{damaged-json');
  assert.equal(await call('ask_user', {}), undefined, 'Human input bypasses even unreadable state');
  assert.equal(await call('edit', { path: 'src/b.py', edits: [] }), undefined, 'Damaged evidence state does not freeze safe development');
  assert.equal((await call('write', { path: 'raw/input.csv', content: 'must not overwrite' })).block, true);
  fs.writeFileSync(statePath, JSON.stringify(saved));
  assert.equal(session.isStreaming, false); assert.deepEqual(errors, []);
  report = { result: 'PASS', mode: 'actual-installed-sdk-proportional-no-model', modelCalled: false,
    reviewExecutor: 'local seeded synthetic verdicts, not native model execution', fixture: cwd, policyVersion: store.getState().policyVersion,
    installedEntry, installedEntrySha256: sha(installedEntry), sourceSha256: Object.fromEntries(['index.ts', 'core.mjs', 'capture.mjs', 'policy.mjs'].map(f => [f, sha(path.join(root, 'src', f))])),
    loaderErrors: errors, foregroundIdle: !session.isStreaming, confirmations,
    checks: { humanChannelUnderDamagedState: true, legacyUncertaintyNotGlobalFreeze: true, historicalGapsPreserved: true,
      lowRiskTestActuallyExecuted: true, lowRiskTestNoRepeatedConsent: true, otherBranchContinues: true, exactDriftBranchPaused: true,
      humanScopedDecision: true, hardDataAndDestructiveGate: true, batchHardGatePriority: true, captureBlindSpotNotGlobalFreeze: true },
    scientificPublicationAuthorized: false, productionRestarted: false, existingSessionsReloaded: false, privateResearchProjectActivated: false };
} finally { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
console.log(JSON.stringify(report, null, 2));
