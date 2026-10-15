#!/usr/bin/env node
/** Real installed Pi SDK + real core/adapter, fixed local RPC executor mock. No native child/model/network. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { host, packageRoot as root, agentDir } from './host-env.mjs';
const entry = path.join(root, 'src/index.ts');
const { MainlineStore } = await import(root + '/src/core.mjs');
const { DefaultResourceLoader, SettingsManager, createAgentSession, SessionManager } = await import(host + '/dist/index.js');
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-sdk-cadence-'));
fs.writeFileSync(path.join(cwd, 'plan.md'), 'Synthetic CPU plan; no scientific acceptance.');
const store = new MainlineStore(cwd, { meminfo: 'MemAvailable: 4194304 kB' });
store.configure({ coreText: 'Synthetic stage cadence research core.', approvedPaths: ['plan.md'], authorized: true });
const statePath = path.join(store.root, 'state.json');
const legacy = store.getState(); delete legacy.reviewCadence; fs.writeFileSync(statePath, JSON.stringify(legacy));
const settings = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
let testBus, off;
const requests = [], errors = [];
const sessionManager = SessionManager.inMemory();
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager: settings,
  noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
  additionalExtensionPaths: [entry], systemPrompt: 'Synthetic no-model SDK cadence smoke.',
  extensionFactories: [(pi) => {
    testBus = pi.events;
    off = pi.events.on('subagents:rpc:v1:request', request => {
      if (request.method === 'ping') {
        pi.events.emit('subagents:rpc:v1:reply:' + request.requestId, { version: 1, requestId: request.requestId, method: 'ping', success: true,
          data: { version: 1, capabilities: { asyncSpawn: true }, events: { asyncComplete: 'subagent:async-complete' },
            session: { sessionId: sessionManager.getSessionId() } } });
      } else if (request.method === 'spawn') {
        requests.push(request);
        const runId = 'local-executor-mock-' + requests.length, asyncDir = path.join(cwd, 'mock-native', runId);
        fs.mkdirSync(asyncDir, { recursive: true });
        fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify({ runId, state: 'running', sessionId: sessionManager.getSessionId(), steps: [] }));
        pi.events.emit('subagents:rpc:v1:reply:' + request.requestId, { version: 1, requestId: request.requestId, method: 'spawn', success: true,
          data: { details: { runId, asyncId: runId, asyncDir } } });
      }
    });
  }],
});
await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader,
  settingsManager: settings, sessionManager, tools: ['mainline_supervision'] });
const ui = new Proxy({ confirm: async () => true, setStatus() {}, notify() {}, setWidget() {}, getEditorText: () => '' },
  { get(t, key) { return key in t ? t[key] : () => {}; } });
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); };
let report;
try {
  await session.bindExtensions({ mode: 'rpc', uiContext: ui, onError: e => errors.push({ event: e.event, error: e.error }) });
  const runner = session.extensionRunner, tool = runner.getToolDefinition('mainline_supervision');
  assert.ok(tool.parameters.properties.action.enum.includes('checkpoint')); assert.ok(tool.parameters.properties.stageId);
  const ctx = runner.createToolContext('cadence-checkpoint');
  const act = params => tool.execute('local-' + params.action, params, undefined, () => {}, ctx);
  const material = async id => {
    const input = { command: 'synthetic local fixture command' };
    await runner.emitToolResult({ type: 'tool_result', toolName: 'bash', toolCallId: id, input, content: [], isError: false });
  };
  const settle = async prompt => {
    await runner.emit({ type: 'before_agent_start', prompt, systemPrompt: '', images: undefined });
    await runner.emit({ type: 'agent_end', messages: [] }); await runner.emit({ type: 'agent_settled' }); await flush();
  };
  const finish = async () => {
    const a = store.getState().reviewActivity;
    const review = { verdict: 'ON_TRACK', findings: [], coverage: 'Synthetic executor mock result only.', unverified: ['No scientific verification'],
      science: { status: 'UNVERIFIED', limitations: ['Model not invoked'] }, restrictions: [] };
    testBus.emit('subagent:async-complete', { id: a.runId, runId: a.runId, state: 'complete', success: true,
      sessionId: sessionManager.getSessionId(), toolCallId: 'rpc-spawn-' + a.requestId,
      results: [{ agent: 'research-mainline-supervisor', success: true, structuredOutput: review }] });
    await flush(); assert.equal(store.getState().lastVerdict, 'ON_TRACK');
  };
  await settle('Resume old project after reload'); assert.equal(requests.length, 0, 'No replay of legacy material');
  await material('stage-A-code');
  await act({ action: 'checkpoint', stageId: 'method-A', kind: 'plan_change' });
  await act({ action: 'checkpoint', stageId: 'method-A', kind: 'stage_complete' });
  await settle('Genuine phase decision'); assert.equal(requests.length, 1); await finish();
  for (let i = 0; i < 8; i++) {
    await material('cleanup-' + i);
    await settle(i % 2 ? 'Same-stage packaging, no new method' : '<background-task-notification>ordinary test completed</background-task-notification>');
    await act({ action: 'check' }); await flush(); assert.equal(requests.length, 1);
  }
  await act({ action: 'checkpoint', stageId: 'method-A', kind: 'stage_complete' });
  await settle('Final file cleanup only'); assert.equal(requests.length, 1, 'Duplicate same-stage checkpoint never reopens');
  assert.equal(store.getState().pendingChanges, true, 'Accumulating evidence is not falsely marked reviewed');
  await act({ action: 'checkpoint', stageId: 'method-B', kind: 'scope_change' });
  await act({ action: 'checkpoint', stageId: 'method-B', kind: 'drift_signal' });
  await settle('New genuine method/scope decision'); assert.equal(requests.length, 2);
  const a = store.getState().reviewActivity, packet = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'EVIDENCE.json')));
  assert.equal(packet.checkpoints.length, 2); assert.ok(packet.events.some(e => e.toolCallId === 'cleanup-7'));
  await finish();
  assert.equal((await runner.emitToolCall({ type: 'tool_call', toolName: 'write', toolCallId: 'hard', input: { path: 'raw/data.csv', content: 'no' } })).block, true);
  assert.equal(await runner.emitToolCall({ type: 'tool_call', toolName: 'ask_user', toolCallId: 'human', input: {} }), undefined);
  assert.equal(session.isStreaming, false); assert.deepEqual(errors, []);
  report = { result: 'PASS', mode: 'actual-installed-sdk-stage-cadence-no-model', modelCalled: false, nativeChildStarted: false,
    executor: 'fixed local RPC mock; not a native model run', loaderErrors: errors, foregroundIdle: true,
    mockReviewRequests: requests.length, followupTurnsWithoutExtraReview: 8, policyVersion: store.getState().policyVersion,
    cadenceVersion: store.getState().reviewCadence.version, cadenceMode: store.getState().reviewCadence.mode,
    checks: { legacyNoCatchup: true, sameStageDedup: true, multiCheckpointMerged: true, routineToolCheckNoNewReview: true,
      pendingEvidencePreserved: true, completionCleanupNoCascade: true, newScopeAndDriftCheckpointReview: true,
      precisePacketBinding: true, dataGatePreserved: true, humanChannelPreserved: true },
    installedEntry: entry, installedEntrySha256: sha(entry),
    sourceSha256: Object.fromEntries(['index.ts', 'core.mjs', 'capture.mjs', 'policy.mjs'].map(f => [f, sha(path.join(root, 'src', f))])),
    privateResearchProjectModified: false, productionRestarted: false, otherSessionsReloaded: false };
} finally { off?.(); await session.extensionRunner.emit({ type: 'session_shutdown' }); session.dispose(); }
console.log(JSON.stringify(report, null, 2));
