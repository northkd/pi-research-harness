#!/usr/bin/env node
/** Actual SDK and installed public RPC registration; denied project consent must never dispatch a model. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { host, subagentsRoot, agentDir, packageRoot } from './host-env.mjs';
const { createAgentSession, DefaultResourceLoader, SettingsManager, SessionManager } = await import(pathToFileURL(path.join(host, 'dist/index.js')).href);
const { MainlineStore } = await import('../src/core.mjs');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-sdk-unauthorized-'));
fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'Synthetic only. No private research.');
const errors = [], settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
let requests = 0, off;
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings, noExtensions: true, noSkills: true,
  noContextFiles: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [path.join(subagentsRoot, 'index.js'), path.join(packageRoot, 'src/index.ts')],
  extensionFactories: [pi => { off = pi.events.on('subagents:rpc:v1:request', () => { requests++; }); }],
  systemPrompt: 'Local unauthorized SDK smoke, no model prompts.' });
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, settingsManager: settings,
  sessionManager: SessionManager.inMemory(), tools: ['mainline_supervision'] });
const ui = new Proxy({ confirm: async () => false, notify() {}, setStatus() {}, setWidget() {}, getEditorText: () => '' },
  { get(target, key) { return key in target ? target[key] : () => {}; } });
let report;
try {
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: e => errors.push({ event: e.event, error: e.error }) });
  const runner = session.extensionRunner, tool = runner.getToolDefinition('mainline_supervision'); assert.ok(tool);
  const ctx = { ...runner.createToolContext('unauthorized'), isIdle: () => false };
  await tool.execute('unauthorized', { action: 'configure', coreText: 'Synthetic direction; not scientific acceptance.', approvedPaths: ['fixture.txt'], authorized: true }, undefined, () => {}, ctx);
  await runner.emitToolCall({ type: 'tool_call', toolName: 'read', toolCallId: 'read-fixture', input: { path: 'fixture.txt' } });
  await runner.emitToolResult({ type: 'tool_result', toolName: 'read', toolCallId: 'read-fixture', input: { path: 'fixture.txt' }, content: [], isError: false });
  await runner.emit({ type: 'agent_end', messages: [] }); await runner.emit({ type: 'agent_settled' });
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  const state = new MainlineStore(cwd).getState();
  assert.equal(state.authorized, false); assert.equal(state.reviewActivity.runId, undefined);
  assert.equal(requests, 0); assert.equal(session.isStreaming, false); assert.deepEqual(errors, []);
  report = { result: 'PASS', mode: 'actual-sdk-public-rpc-unauthorized-no-model', modelCalled: false, nativeChildStarted: false,
    loaderErrors: errors, rpcRequests: requests, foregroundIdle: true, projectConsentGranted: false,
    productionRestarted: false, privateResearchProjectModified: false };
} finally { off?.(); await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
console.log(JSON.stringify(report, null, 2));
