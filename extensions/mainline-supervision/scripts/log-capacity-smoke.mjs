#!/usr/bin/env node
// Actual Pi SDK/extension boundary; all events/verdicts are synthetic, no model or native child.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { host, packageRoot as root, agentDir } from './host-env.mjs';
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(host + '/dist/index.js');
const { MainlineStore } = await import(root + '/src/core.mjs');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-sdk-log-cap-'));
const store = new MainlineStore(cwd); fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'Synthetic only.');
store.configure({ coreText: 'Synthetic capacity only; no research acceptance.', approvedPaths: ['fixture.txt'], authorized: true });
const original = store.getState(), key = crypto.createHash('sha256').update('seed').digest('hex').slice(0, 32);
const legacy = path.join(store.root, 'events', key + '.jsonl'); fs.mkdirSync(path.dirname(legacy), { recursive: true });
const events = Array.from({ length: 2000 }, (_, i) => ({ type: 'tool_result', sessionId: 'seed', revision: i + 2,
  source: 'runtime-event', toolName: 'read', material: false, coverage: ['synthetic'], omissions: [] }));
const bytes = events.map(e => JSON.stringify(e) + '\n').join(''); fs.writeFileSync(legacy, bytes);
for (const k of ['eventJournalVersion', 'eventJournalFiles', 'eventSourceGaps']) delete original[k];
Object.assign(original, { eventCount: 2000, eventBytes: Buffer.byteLength(bytes), revision: 2001,
  materialRevision: 2001, reviewedRevision: 2001, reviewedMaterialRevision: 2001, lastAttemptMaterialRevision: 2001 });
fs.writeFileSync(path.join(store.root, 'state.json'), JSON.stringify(original));
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, packages: [] });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [path.join(root, 'src/index.ts')], systemPrompt: 'Synthetic local capacity smoke only.' });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader,
  settingsManager: settings, sessionManager: SessionManager.inMemory(), tools: ['mainline_supervision'] });
const errors = [], ui = new Proxy({ confirm: async () => false, notify() {}, setStatus() {}, setWidget() {},
  getEditorText: () => '' }, { get(t, k) { return k in t ? t[k] : () => {}; } });
let report;
try {
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: e => errors.push({ event: e.event, error: e.error }) });
  const runner = session.extensionRunner;
  await runner.emitToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'post-count', input: { path: 'fixture.txt' } });
  await runner.emitToolResult({ type: 'tool_result', toolName: 'read', toolCallId: 'post-count', input: { path: 'fixture.txt' }, content: [{ type: 'text', text: 'Synthetic only.' }], isError: false });
  assert.equal(store.getState().eventCount, 2002); assert.equal(store.getState().omittedEvents, 0);
  assert.equal(fs.readFileSync(legacy, 'utf8'), bytes);
  assert.equal(store.getState().materialRevision, 2001, 'An audit read cannot launch review');
  const tool = runner.getToolDefinition('mainline_supervision'); assert.ok(tool);
  const status = await tool.execute('status', { action: 'status' }, undefined, () => {}, runner.createToolContext('status'));
  assert.equal(status.details.eventJournalVersion, 1);
  // Old omissions remain disclosed, but do not freeze development or human permission questions.
  const s = store.getState(); s.omittedEvents = 12; s.captureLimitReached = true; s.blocked = true;
  fs.writeFileSync(path.join(store.root, 'state.json'), JSON.stringify(s));
  const denied = await runner.emitToolCall({ type: 'tool_call', toolName: 'bash', toolCallId: 'must-not-run', input: { command: 'not executed' } });
  assert.equal(denied?.block, true);
  await runner.emitToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: 'must-not-run', input: { command: 'not executed' }, content: [], isError: true });
  assert.equal(store.getState().omittedEvents, 12); assert.ok(store.getState().eventSourceGaps.some(g => g.count === 12));
  assert.equal(store.getState().blocked, false);
  assert.equal(await runner.emitToolCall({ type: 'tool_call', toolName: 'ask_user', toolCallId: 'human-channel', input: {} }), undefined);
  assert.equal(await runner.emitToolCall({ type: 'tool_call', toolName: 'edit', toolCallId: 'safe-development', input: { path: 'fixture.txt', edits: [] } }), undefined);
  assert.equal(session.isStreaming, false); assert.deepEqual(errors, []);
  report = { result: 'PASS', mode: 'actual-sdk-no-model-log-capacity', modelCalled: false, loaderErrors: [],
    legacySourceUnchanged: true, eventCountBoundaryPersisted: true, auditReadNonMaterial: true,
    existingOmissionsDisclosed: true, opaqueExecutionRequiresPermission: true, historicalGapNotGlobalFreeze: true, humanChannelAvailable: true, sourceModule: path.join(root, 'src/index.ts'),
    productionProjectTouched: false };
} finally {
  await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose();
  fs.rmSync(cwd, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...report, cleanupCompleted: true }, null, 2));
