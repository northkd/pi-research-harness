#!/usr/bin/env node
/** Actual Pi SDK/extension loader, bounded UI capture and independent safety gate. No model or native child. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { host, packageRoot as root, agentDir } from './host-env.mjs';
import { MODEL } from '../src/core.mjs';
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(host + '/dist/index.js');
const { MainlineStore } = await import(root + '/src/core.mjs');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-sdk-repair-'));
fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'Synthetic authorized capture file.\n');
const git = args => execFileSync('/usr/bin/git', args, { cwd, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
git(['add', '--', 'fixture.txt']); git(['commit', '-qm', 'fixture']);
const store = new MainlineStore(cwd);
store.configure({ coreText: 'Synthetic fixed core; only capture tested, not a scientific claim.', approvedPaths: ['fixture.txt'], authorized: true });
// Synthetic local result avoids any provider or subagent call in this smoke.
const begun = store.beginReview({ sessionId: 'smoke', requestId: 'smoke-blocked' }); store.attachRun('smoke-blocked', 'synthetic');
store.finishReview('smoke-blocked', { verdict: 'INSUFFICIENT_CONTEXT', findings: [], runId: 'synthetic' });
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [path.join(root, 'src/index.ts')], systemPrompt: 'Synthetic local host smoke only.' });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader,
  settingsManager: settings, sessionManager: SessionManager.inMemory(), tools: ['mainline_supervision'] });
const errors = [], confirmations = [];
let allow = false;
const ui = new Proxy({ confirm: async (title, message) => {
  confirmations.push({ title, sourceNamesPresent: message.includes('fixture.txt'), namedModel: message.includes(MODEL), allow }); return allow;
}, notify() {}, setStatus() {}, setWidget() {}, getEditorText: () => '', select: async () => undefined,
  input: async () => undefined, editor: async () => undefined }, { get(t, key) { return key in t ? t[key] : () => {}; } });
let report;
try {
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: e => errors.push({ event: e.event, error: e.error }) });
  const runner = session.extensionRunner;
  const tool = runner.getToolDefinition('mainline_supervision'); assert.ok(tool);
  const ctx = runner.createToolContext('capture-smoke');
  const request = { action: 'capture', capturePaths: ['fixture.txt'], outputDir: 'research/tasks/smoke/' };
  await assert.rejects(tool.execute('declined', request, undefined, () => {}, ctx), /declined/);
  assert.equal(fs.existsSync(path.join(cwd, 'research/tasks/smoke')), false);
  assert.equal(store.getState().blocked, false, 'Missing direction context is not a global execution freeze');
  allow = true;
  const result = await tool.execute('approved', request, undefined, () => {}, ctx);
  assert.ok(result.details.manifestPath); assert.ok(fs.existsSync(path.join(cwd, result.details.manifestPath)));
  assert.equal(store.getState().coreText, 'Synthetic fixed core; only capture tested, not a scientific claim.');
  assert.equal(store.getState().blocked, false); assert.equal(store.getState().enabled, true);
  const block = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'blocked', input: { command: 'rm fixture.txt' } });
  assert.equal(block?.block, true);
  await runner.emitToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: 'blocked', input: { command: 'rm fixture.txt' }, content: [], details: undefined, isError: true });
  const material = store.getState().materialRevision;
  await runner.emitToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'external-status', input: { path: '/tmp/known-native-status.json' } });
  await runner.emitToolResult({ type: 'tool_result', toolName: 'read', toolCallId: 'external-status', input: { path: '/tmp/known-native-status.json' }, content: [], details: undefined, isError: false });
  assert.equal(store.getState().materialRevision, material);
  assert.equal(session.isStreaming, false); assert.deepEqual(errors, []);
  report = { result: 'PASS', mode: 'actual-sdk-no-model-host-repair', fixture: cwd, modelCalled: false,
    loaderErrors: errors, confirmations, deniedWithoutPublication: true, capturePublished: true, fixedCorePreserved: true,
    destructiveGatePreserved: true, contextUncertaintyNotGlobalFreeze: true, auditReadsNonMaterial: true, installedSessionReloaded: false, capturedManifest: result.details.manifestPath,
    packetBeforeCapture: begun.packetDir, sourceModule: path.join(root, 'src/index.ts') };
} finally { await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
console.log(JSON.stringify({ ...report, cleanupCompleted: true }, null, 2));
