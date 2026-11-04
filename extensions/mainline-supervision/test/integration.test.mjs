// Actual core + adapter + installed public RPC implementation; ONLY model executor is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MainlineStore, MODEL } from '../src/core.mjs';
import { loadAdapter, loadRpcBridge } from '../scripts/host-env.mjs';
// Real public bridge and real core/adapter; the model executor below is a local mock.
const { registerSubagentRpcBridge } = await loadRpcBridge();
const imported = await loadAdapter();
const { createMainlineAdapter } = imported.default?.createMainlineAdapter ? imported.default : imported;
const GOOD = { verdict: 'ON_TRACK', findings: [], coverage: 'Only the frozen synthetic file event and actual snapshot.', unverified: [] };
const OFF = { verdict: 'OFF_TRACK', findings: [{ evidence: 'off-event', coreStep: 'candidate finder', relation: 'UNRELATED', issue: 'Wrong documented goal', correction: 'Repair plan.md and recheck' }], coverage: 'Frozen packet', unverified: [],
  science: { status: 'UNVERIFIED', limitations: [] }, restrictions: [{ paths: ['plan.md'], eventIds: ['off-event'], evidence: 'EVIDENCE event off-event', reason: 'Observed unrelated action' }] };
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve)); };
class TestStore extends MainlineStore {
  constructor(cwd) { super(cwd, { meminfo: 'MemAvailable: 4194304 kB' }); }
}
function harness(t, opts = {}) {
  const cwd = opts.cwd ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-integration-'));
  const parentFile = path.join(cwd, 'parent.jsonl');
  if (!fs.existsSync(path.join(cwd, 'plan.md'))) fs.writeFileSync(path.join(cwd, 'plan.md'), 'Synthetic core plan: find candidates only.');
  if (opts.git) {
    const git = args => execFileSync('/usr/bin/git', args, { cwd, env: { PATH: '/usr/bin:/bin', HOME: '/nonexistent' }, stdio: ['ignore', 'pipe', 'pipe'] });
    git(['init', '-q']); git(['config', 'user.email', 'fixture@example.invalid']); git(['config', 'user.name', 'Fixture']);
    git(['add', '--', 'plan.md']); git(['commit', '-qm', 'fixture']);
  }
  const listeners = new Map(), hooks = new Map(), requests = [], messages = [], statuses = [];
  const events = { on(n, fn) { if (!listeners.has(n)) listeners.set(n, new Set()); listeners.get(n).add(fn); return () => listeners.get(n)?.delete(fn); }, emit(n, p) { for (const fn of listeners.get(n) ?? []) fn(p); } };
  let tool, command, inTurn = false, consent = true, confirmHandler, memAvailable = 4194304;
  class FixtureStore extends TestStore { constructor(cwd) { super(cwd); this.meminfo = () => `MemAvailable: ${memAvailable} kB`; } }
  const ctx = { cwd, hasUI: true, isIdle: () => !inTurn, sessionManager: { getSessionId: () => opts.sessionId ?? 'parent-session', getSessionFile: () => parentFile }, ui: { confirm: async (...args) => confirmHandler ? confirmHandler(...args) : consent, setStatus(k, v) { statuses.push({ k, v }); }, notify() {} } };
  const bridge = registerSubagentRpcBridge({
    events, getContext: () => ctx,
    execute: async (_call, p) => {
      requests.push(p);
      if (opts.spawnError) throw new Error(opts.spawnError);
      assert.equal(p.output, false, 'Do not claim a child-authored text file for structured-only readonly replies');
      assert.equal('outputMode' in p, false, 'File-only settlement conflicts with native structured_output');
      assert.ok(p.outputSchema, 'Keep native structured output persistence and validation enabled');
      const id = `mock-native-${requests.length}`;
      const dir = path.join(cwd, 'async', id); fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify({ runId: id, sessionId: parentFile, state: 'running', steps: [] }));
      return { content: [{ type: 'text', text: 'mock executor only' }], details: { mode: 'single', runId: id, asyncId: id, asyncDir: dir, results: [] } };
    },
  });
  const pi = { events, on(n, fn) { hooks.set(n, fn); }, registerTool(v) { tool = v; }, registerCommand(_n, v) { command = v; }, sendMessage(m, options) { assert.equal(options.triggerTurn, false); messages.push(m); } };
  createMainlineAdapter(pi, { Store: FixtureStore, env: {}, autoApprove: opts.autoApprove, reconcileIntervalMs: 60000 });
  const fire = (n, e = {}) => hooks.get(n)?.(e, ctx);
  fire('session_start');
  const act = p => tool.execute('integration-tool', p, undefined, () => {}, ctx);
  const configure = async () => {
    const previousTurn = inTurn; inTurn = true;
    await act({ action: 'configure', coreText: 'Synthetic frozen research core: implement CPU candidate finder and verify bounds.', approvedPaths: ['plan.md'], authorized: true });
    new MainlineStore(cwd).record({ type: 'tool_result', sessionId: 'parent-session', toolName: 'write', toolCallId: 'off-event', input: { path: 'plan.md' }, result: 'Synthetic concrete branch event' });
    inTurn = previousTurn; if (!inTurn) fire('agent_settled');
  };
  const get = () => new MainlineStore(cwd).getState();
  const complete = async (review = GOOD) => {
    const a = get().reviewActivity;
    fs.writeFileSync(path.join(a.packetDir, 'RAW_REVIEW.json'), JSON.stringify(review), { mode: 0o600 });
    events.emit('subagent:async-complete', { id: a.runId, runId: a.runId, sessionId: parentFile, state: 'complete', success: true, toolCallId: `rpc-spawn-${a.requestId}`, results: [{ agent: 'research-mainline-supervisor', success: true, structuredOutput: review }] });
    await flush();
  };
  const stop = () => { fire('session_shutdown'); bridge.dispose(); };
  t.after(() => { stop(); if (!opts.cwd) fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, parentFile, fire, act, configure, get, complete, requests, statuses, messages, command, stop, humanCheck: () => command.handler('check', ctx),
    setTurn(v) { inTurn = v; }, setConsent(v) { consent = v; }, setConfirm(fn) { confirmHandler = fn; }, setMemory(v) { memAvailable = v; } };
}

test('real core + real public RPC validation: actual event -> async review -> raw artifact -> idle', async t => {
  const h = harness(t); h.setTurn(true); await h.configure(); await flush();
  assert.equal(h.requests.length, 0, 'No dispatch during foreground work');
  h.fire('tool_call', { toolName: 'read', toolCallId: 'source-1', input: { path: 'plan.md' } });
  h.fire('tool_result', { toolName: 'read', toolCallId: 'source-1', input: { path: 'plan.md' }, content: [{ type: 'text', text: fs.readFileSync(path.join(h.cwd, 'plan.md'), 'utf8') }], isError: false });
  assert.equal(h.fire('agent_end', { messages: [] }), undefined);
  h.setTurn(false);
  h.fire('agent_settled'); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.requests[0].model, MODEL);
  assert.equal(h.requests[0].async, true); assert.equal(h.requests[0].context, 'fresh');
  const a = h.get().reviewActivity;
  const evidence = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'EVIDENCE.json')));
  assert.ok(evidence.events.some(e => e.toolCallId === 'source-1' && e.source === 'runtime-event'));
  assert.ok(evidence.artifacts.some(e => e.path === 'plan.md' && e.text.includes('Synthetic core')));
  assert.equal(h.get().reviewActivity.state, 'reviewing'); // Installed SDK smoke separately checks foreground idle.
  await h.complete(); assert.equal(h.get().lastVerdict, 'ON_TRACK'); assert.equal(h.get().blocked, false);
  assert.equal(h.get().reviewActivity.state, 'standby');
});

test('correction allows only declared repair paths; pause/core replacement requires user, original verdict retained', async t => {
  const h = harness(t, { autoApprove: false }); await h.configure(); await flush(); await h.complete(OFF);
  assert.equal(h.get().blocked, true); const original = h.get().lastVerdict;
  h.setConsent(false);
  await assert.rejects(h.act({ action: 'pause' }), /Human approval/);
  await assert.rejects(h.act({ action: 'configure', coreText: 'Evade original core', approvedPaths: [], authorized: false }), /Human approval/);
  assert.equal(h.get().enabled, true); assert.equal(h.get().lastVerdict, original);
  assert.equal(h.fire('tool_call', { toolName: 'write', input: { path: 'plan.md', content: 'repair' } }).block, true);
  await h.act({ action: 'correction', text: 'Fix specific approved plan only', evidencePaths: ['plan.md'] });
  assert.equal(h.get().blocked, true);
  assert.equal(h.fire('tool_call', { toolName: 'edit', toolCallId: 'repair', input: { path: 'plan.md', edits: [] } }), undefined);
  assert.equal((await h.fire('tool_call', { toolName: 'bash', input: { command: 'unrestricted work' } })).block, true);
  fs.writeFileSync(path.join(h.cwd, 'plan.md'), 'Corrected candidate finder plan');
  h.fire('tool_result', { toolName: 'edit', toolCallId: 'repair', input: { path: 'plan.md' }, content: [], isError: false });
  await h.act({ action: 'checkpoint', stageId: 'bounded-repair', kind: 'stage_complete' });
  await h.act({ action: 'check' }); await flush(); await h.complete();
  assert.equal(h.get().blocked, false); assert.deepEqual(h.get().correctionPaths, []);
  assert.match(fs.readFileSync(path.join(h.cwd, '.pi/mainline-supervision/findings-corrections.jsonl'), 'utf8'), /OFF_TRACK/);
});

test('owner exited: new session reconciles exact complete status using session file, without relaunch', async t => {
  const h = harness(t); await h.configure(); await flush(); const a = h.get().reviewActivity; h.stop();
  const stateFile = path.join(h.cwd, '.pi/mainline-supervision/state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.reviewActivity.owner = { pid: 99999999, identity: 'exited' };
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(new MainlineStore(h.cwd).getState().reviewActivity.state, 'unverified');
  fs.writeFileSync(path.join(a.packetDir, 'RAW_REVIEW.json'), JSON.stringify(GOOD));
  const receipt = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'ADAPTER_RECEIPT.json')));
  fs.writeFileSync(path.join(receipt.asyncDir, 'status.json'), JSON.stringify({ runId: a.runId, sessionId: receipt.ownerSessionFile, state: 'complete', steps: [{ agent: 'research-mainline-supervisor', status: 'complete', structuredOutput: GOOD }] }));
  const reopened = harness(t, { cwd: h.cwd, sessionId: 'next-session' }); await flush();
  assert.equal(reopened.requests.length, 0); assert.equal(reopened.get().lastVerdict, 'ON_TRACK');
});

test('ordinary children, parent self-status and review artifact reads cannot cause a recursive review', async t => {
  const h = harness(t); await h.configure(); await flush(); await h.complete(); const revision = h.get().revision;
  h.fire('before_agent_start', { prompt: 'status only' });
  h.fire('tool_call', { toolName: 'read', input: { path: '.pi/mainline-supervision/state.json' } });
  h.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Status: completed.' }] }] });
  h.fire('agent_settled'); await flush();
  assert.equal(h.get().revision, revision); assert.equal(h.requests.length, 1);
  let registered = false;
  createMainlineAdapter({ registerTool() { registered = true; } }, { env: { PI_SUBAGENT_CHILD: '1' } });
  assert.equal(registered, false);
});

test('failed child and missing/symlink raw artifact fail closed with real core', async t => {
  const h = harness(t); await h.configure(); await flush();
  const a = h.get().reviewActivity;
  fs.symlinkSync(path.join(h.cwd, 'plan.md'), path.join(a.packetDir, 'RAW_REVIEW.json'));
  await h.complete();
  assert.equal(h.get().blocked, false); assert.equal(h.get().lastVerdict, 'FAILED');
  assert.equal(h.get().reviewedRevision, 0);
});

test('native structured-only completion persists the correlated raw review without any child-written file', async t => {
  const h = harness(t); await h.configure(); await flush();
  const a = h.get().reviewActivity;
  const raw = path.join(a.packetDir, 'RAW_REVIEW.json');
  assert.equal(fs.existsSync(raw), false);
  // Simulate only the exact native terminal shape; no model or child file writer is involved.
  const receipt = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'ADAPTER_RECEIPT.json')));
  fs.writeFileSync(path.join(receipt.asyncDir, 'status.json'), JSON.stringify({ runId: a.runId, sessionId: receipt.ownerSessionFile, state: 'complete', steps: [{ agent: 'research-mainline-supervisor', status: 'complete', structuredOutput: GOOD }] }));
  await h.act({ action: 'check' }); await flush();
  assert.equal(h.get().lastVerdict, 'ON_TRACK');
  assert.equal(h.get().blocked, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(raw, 'utf8')), GOOD);
  assert.equal(fs.statSync(raw).mode & 0o777, 0o600);
  assert.equal(h.requests.length, 1, 'Consume the existing run; do not relaunch');
});

test('failed native terminal remains failed even when it contains a valid structured review', async t => {
  const h = harness(t); await h.configure(); await flush();
  const a = h.get().reviewActivity;
  const receipt = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'ADAPTER_RECEIPT.json')));
  fs.writeFileSync(path.join(receipt.asyncDir, 'status.json'), JSON.stringify({ runId: a.runId, sessionId: receipt.ownerSessionFile, state: 'failed', error: 'Required file-only output was not produced', steps: [{ agent: 'research-mainline-supervisor', status: 'failed', error: 'Required file-only output was not produced', structuredOutput: GOOD }] }));
  await h.act({ action: 'check' }); await flush();
  assert.equal(h.get().lastVerdict, 'FAILED');
  assert.equal(h.get().blocked, false);
  assert.equal(h.get().reviewedRevision, 0);
  assert.equal(fs.existsSync(path.join(a.packetDir, 'RAW_REVIEW.json')), false);
  h.fire('agent_settled'); await flush();
  assert.equal(h.requests.length, 1);
});

test('RPC infrastructure rejection is preserved privately, fails closed and is not retried', async t => {
  const h = harness(t, { spawnError: 'Synthetic runner startup rejected token=synthetic-secret' });
  await h.configure(); await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.get().lastVerdict, 'FAILED');
  assert.equal(h.get().blocked, false);
  assert.equal(h.get().reviewedRevision, 0);
  const dir = path.join(h.cwd, '.pi/mainline-supervision/reviews');
  const packet = fs.readdirSync(dir)[0];
  const errorPath = path.join(dir, packet, 'DISPATCH_ERROR.json');
  const error = JSON.parse(fs.readFileSync(errorPath, 'utf8'));
  assert.equal(error.error.code, 'execution_failed');
  assert.match(error.error.message, /Synthetic runner startup rejected/);
  assert.match(error.error.message, /\[redacted\]/);
  assert.doesNotMatch(error.error.message, /synthetic-secret/);
  assert.equal(fs.statSync(errorPath).mode & 0o777, 0o600);
  h.fire('agent_settled'); await flush();
  assert.equal(h.requests.length, 1, 'Failed revision must not be relaunched');
});

test('bounded capture UI gate retains scoped restrictions and explicit material review, no global freeze', async t => {
  const h = harness(t, { git: true, autoApprove: false }); await h.configure(); await flush(); await h.complete(OFF);
  const request = { action: 'capture', capturePaths: ['plan.md'], outputDir: 'research/tasks/capture-test/' };
  h.setConsent(false);
  await assert.rejects(h.act(request), /declined/);
  assert.equal(fs.existsSync(path.join(h.cwd, 'research/tasks/capture-test')), false);
  assert.equal(h.get().blocked, true); assert.equal(h.requests.length, 1);
  h.setConsent(true);
  const result = await h.act(request);
  assert.ok(result.details.manifestPath); assert.ok(result.details.outputs.length > 1);
  assert.equal(h.get().blocked, true); assert.equal(h.get().lastVerdict, 'OFF_TRACK');
  h.setConsent(false);
  assert.equal((await h.fire('tool_call', { toolName: 'bash', toolCallId: 'denied-after-capture', input: { command: 'arbitrary' } })).block, true);
  h.setConsent(true);
  await h.act({ action: 'check' }); await flush(); assert.equal(h.requests.length, 1, 'Capture supplement alone is not a new research checkpoint');
  await h.act({ action: 'checkpoint', stageId: 'branch-evidence-complete', kind: 'stage_complete' });
  await h.act({ action: 'check' }); await flush(); assert.equal(h.requests.length, 2);
  const a = h.get().reviewActivity;
  const evidence = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'EVIDENCE.json')));
  assert.equal(evidence.captures.length, 1);
  assert.equal(evidence.captures[0].receipt.consent.source, 'direct-human-ui');
  await h.complete(OFF);
  for (let i = 0; i < 3; i++) { h.fire('agent_settled'); await flush(); }
  assert.equal(h.requests.length, 2, 'No self-retry without material evidence');
});

test('real adapter suppresses status reads, denied tool results and declarations across completion wakes', async t => {
  const h = harness(t, { autoApprove: false }); await h.configure(); await flush(); await h.complete(OFF);
  const material = h.get().materialRevision;
  h.setConsent(false);
  for (const prompt of ['Subagent updates above.', 'Background task failed: **research-mainline-supervisor**', 'why did it fail?']) {
    h.fire('before_agent_start', { prompt });
    h.fire('tool_call', { toolName: 'read', toolCallId: 'status-read', input: { path: '/tmp/exact-native-status.json' } });
    h.fire('tool_result', { toolName: 'read', toolCallId: 'status-read', input: { path: '/tmp/exact-native-status.json' }, content: [], isError: false });
    assert.equal((await h.fire('tool_call', { toolName: 'bash', toolCallId: 'denied', input: { command: 'not permitted' } })).block, true);
    h.fire('tool_result', { toolName: 'bash', toolCallId: 'denied', input: { command: 'not permitted' }, content: [], isError: true });
    await h.act({ action: 'correction', text: 'Accept same finding; no repair', evidencePaths: ['plan.md'] });
    h.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Accepted; nothing repaired.' }] }] });
    h.fire('agent_settled'); await flush();
    await h.act({ action: 'check' }); await flush();
  }
  assert.equal(h.get().materialRevision, material); assert.equal(h.requests.length, 1); assert.equal(h.get().blocked, true);
});

test('B2: blocked adapter rejects stale correction path after scope narrowing or symlink replacement', async t => {
  const h = harness(t); await h.configure(); await flush(); await h.complete(OFF);
  await h.act({ action: 'correction', text: 'Only plan', evidencePaths: ['plan.md'] });
  fs.unlinkSync(path.join(h.cwd, 'plan.md')); fs.symlinkSync('/proc/meminfo', path.join(h.cwd, 'plan.md'));
  assert.equal(h.fire('tool_call', { toolName: 'write', toolCallId: 'symlink-repair', input: { path: 'plan.md', content: 'no' } }).block, true);
  fs.unlinkSync(path.join(h.cwd, 'plan.md')); fs.writeFileSync(path.join(h.cwd, 'plan.md'), 'restored fixture');
  await h.act({ action: 'configure', coreText: h.get().coreText, approvedPaths: [], authorized: true });
  assert.equal(h.fire('tool_call', { toolName: 'edit', toolCallId: 'stale-repair', input: { path: 'plan.md', edits: [] } }).block, true);
});

test('B5: ordinary child steering is material; exact supervisor self-control remains audit-only', async t => {
  const h = harness(t); await h.configure(); await flush(); await h.complete();
  h.fire('before_agent_start', { prompt: 'change child plan' });
  const steer = { toolName: 'subagent', toolCallId: 'ordinary-steer', input: { action: 'steer', id: 'ordinary-child', message: 'Change scientific plan' } };
  h.fire('tool_call', steer); h.fire('tool_result', { ...steer, content: [], isError: false });
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 1, 'Steering is evidence, not itself a separate review');
  await h.act({ action: 'checkpoint', stageId: 'child-method-change', kind: 'plan_change' });
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 2);
  await h.complete(); const material = h.get().materialRevision;
  const control = { toolName: 'subagent', toolCallId: 'supervisor-stop', input: { action: 'stop', id: h.get().reviewActivity.lastRunId } };
  h.fire('tool_call', control); h.fire('tool_result', { ...control, content: [], isError: false });
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 2); assert.equal(h.get().materialRevision, material);
});

test('P1 batch checks all children before confirmation; hard boundaries win', async t => {
  const h = harness(t, { autoApprove: false }); await h.configure(); await flush(); await h.complete(OFF);
  let asked = 0; h.setConfirm(async () => { asked++; return true; });
  const denied = await h.fire('tool_call', { toolName: 'parallel', toolCallId: 'batch', input: { tool_uses: [
    { recipient_name: 'functions.bash', parameters: { command: 'opaque local command' } },
    { recipient_name: 'functions.write', parameters: { path: 'raw/input.csv', content: 'no overwrite' } },
  ] } });
  assert.equal(denied.block, true); assert.equal(asked, 0, 'Cannot confirm away a later hard refusal');
  let release; h.setConfirm(() => new Promise(resolve => { release = resolve; }));
  const pending = h.fire('tool_call', { toolName: 'parallel', toolCallId: 'batch-resource', input: { tool_uses: [
    { recipient_name: 'functions.bash', parameters: { command: 'opaque local command' } },
  ] } });
  h.setMemory(1000); release(true); assert.equal((await pending).block, true);
  assert.equal(h.fire('tool_call', { toolName: 'ask_user', input: {} }), undefined);
});
test('P1 permission confirmation rechecks branch, core and visible files changed during UI', async t => {
  for (const changed of ['restriction', 'core', 'file']) {
    const h = harness(t, { autoApprove: false }); await h.configure(); await flush();
    let release; h.setConfirm(() => new Promise(resolve => { release = resolve; }));
    const pending = h.fire('tool_call', { toolName: 'bash', toolCallId: 'during-ui', input: { command: 'python3 plan.md', timeout: 121 } });
    if (changed === 'restriction') await h.complete(OFF);
    if (changed === 'file') fs.appendFileSync(path.join(h.cwd, 'plan.md'), 'changed during approval');
    if (changed === 'core') new MainlineStore(h.cwd).configure({ coreText: 'Legitimate new frozen core', approvedPaths: ['plan.md'], authorized: true });
    release(true); assert.equal((await pending).block, true, changed);
  }
});
test('P1 entire v2 RAW/native result mismatch fails without applying restrictions or science', async t => {
  const h = harness(t); await h.configure(); await flush();
  const a = h.get().reviewActivity;
  const raw = { ...OFF, restrictions: [] };
  fs.writeFileSync(path.join(a.packetDir, 'RAW_REVIEW.json'), JSON.stringify(raw));
  const receipt = JSON.parse(fs.readFileSync(path.join(a.packetDir, 'ADAPTER_RECEIPT.json')));
  fs.writeFileSync(path.join(receipt.asyncDir, 'status.json'), JSON.stringify({ runId: a.runId, sessionId: receipt.ownerSessionFile, state: 'complete',
    steps: [{ agent: 'research-mainline-supervisor', status: 'complete', structuredOutput: { ...OFF, science: { status: 'SUPPORTED', limitations: [] } } }] }));
  await h.act({ action: 'check' }); await flush();
  assert.equal(h.get().lastVerdict, 'FAILED'); assert.equal(h.get().reviewedRevision, 0);
  assert.equal(h.get().branchRestrictions.length, 0); assert.equal(h.get().lastScience.status, 'NOT_ASSESSED');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(a.packetDir, 'RAW_REVIEW.json'))), raw);
});
test('P2 memory/control observation results never manufacture new material review', async t => {
  const h = harness(t); await h.configure(); await flush(); await h.complete(); const material = h.get().materialRevision;
  for (const [toolName, input] of [['memory_read', { target: 'daily' }], ['memory_search', { query: 'status' }],
    ['subagent_supervisor', { action: 'status' }], ['subagent', { action: 'mission.show', id: 'known-mission' }],
    ['canvas', { target: { kind: 'file', path: 'plan.md' } }]]) {
    const e = { toolName, input, toolCallId: 'read-' + toolName };
    await h.fire('tool_call', e); h.fire('tool_result', { ...e, content: [], isError: false });
  }
  h.fire('agent_settled'); await flush(); assert.equal(h.get().materialRevision, material); assert.equal(h.requests.length, 1);
});
test('cadence integration: stage follow-up and completion cleanup never spawn additional review', async t => {
  const h = harness(t); await h.configure(); await flush(); await h.complete();
  for (let i = 0; i < 6; i++) {
    h.fire('before_agent_start', { prompt: i % 2 ? 'Continue same-stage packaging' : '<background-task-notification>test completed</background-task-notification>' });
    h.fire('tool_result', { toolName: 'bash', toolCallId: 'followup-' + i, input: { command: 'synthetic packaging' }, content: [], isError: false });
    h.fire('agent_end', { messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Same stage cleanup done.' }] }] });
    h.fire('agent_settled'); await h.act({ action: 'check' }); await flush();
    assert.equal(h.requests.length, 1);
  }
  assert.equal(h.get().pendingChanges, true);
  await h.act({ action: 'checkpoint', stageId: 'method-A', kind: 'stage_complete' });
  await h.act({ action: 'checkpoint', stageId: 'method-A', kind: 'plan_change' });
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 2); await h.complete();
  const packet = JSON.parse(fs.readFileSync(path.join(h.get().reviewActivity.lastPacketDir, 'EVIDENCE.json')));
  assert.equal(packet.checkpoints.length, 2); assert.ok(packet.events.some(e => e.toolCallId === 'followup-5'));
  h.fire('before_agent_start', { prompt: 'Post-acceptance file cleanup only' });
  h.fire('tool_result', { toolName: 'bash', toolCallId: 'post-acceptance', input: {}, content: [], isError: false });
  await h.act({ action: 'checkpoint', stageId: 'method-A', kind: 'stage_complete' });
  h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 2);
  await h.humanCheck(); await flush(); assert.equal(h.requests.length, 3, 'Direct human check can explicitly review new material');
});
test('cadence integration: completion wake cannot cascade a checkpoint queued during review', async t => {
  const h = harness(t); await h.configure(); await flush();
  h.fire('tool_result', { toolName: 'bash', toolCallId: 'genuine-new-material', input: {}, content: [], isError: false });
  await h.act({ action: 'checkpoint', stageId: 'new-method', kind: 'plan_change' });
  await h.complete();
  h.fire('before_agent_start', { prompt: 'Subagent updates above.' }); h.fire('agent_settled'); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.get().pendingChanges, true);
  h.fire('before_agent_start', { prompt: 'Continue genuine research decision' }); h.fire('agent_settled'); await flush(); assert.equal(h.requests.length, 2);
});
test('cadence integration: unchanged governance reminder is not injected on every cleanup turn', async t => {
  const h = harness(t); await h.configure(); await flush(); await h.complete({ verdict: 'INSUFFICIENT_CONTEXT', findings: [], coverage: 'Synthetic uncertain direction', unverified: [] });
  assert.ok(h.fire('before_agent_start', { prompt: 'continue' })?.message);
  assert.equal(h.fire('before_agent_start', { prompt: 'followup cleanup' }), undefined);
  assert.equal(h.fire('before_agent_start', { prompt: '<background-task-notification>complete</background-task-notification>' }), undefined);
  assert.equal(h.requests.length, 1);
});
test('capture failure is persisted and refuses later dispatch even after reopen', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-failed-capture-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new MainlineStore(cwd); store.configure({ coreText: 'Frozen core', approvedPaths: [], authorized: true });
  store.markCaptureFailure(); const reopened = new MainlineStore(cwd);
  assert.equal(reopened.getState().blocked, false); assert.equal(reopened.getState().reviewHealth.status, 'BLIND_SPOT');
  assert.equal(reopened.beginReview({ sessionId: 's', requestId: 'r' }).reason, 'source-capture-failed');
});
