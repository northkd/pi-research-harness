// Synthetic task-control and path fixtures; no research data, live processes or model calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainlineStore } from '../src/core.mjs';
import { operationDecision, observationTool, needsResource } from '../src/policy.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mainline-runtime-control-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new MainlineStore(cwd, { meminfo: 'MemAvailable: 4194304 kB' });
  store.configure({ coreText: 'Synthetic research task', approvedPaths: ['src/'], authorized: true });
  return { cwd, store };
}
const event = (toolName, input = {}) => ({ toolName, input });

test('communication inbox controls remain observations when capture and resources are unavailable', t => {
  const { store } = fixture(t);
  store.markCaptureFailure();
  store.meminfo = 'MemAvailable: 1000 kB';
  for (const action of ['pending', 'status', 'ack']) {
    const call = event('research_communication', { action });
    assert.equal(observationTool(call.toolName, call.input), true, action);
    assert.equal(needsResource(call), false, action);
    assert.equal(operationDecision(store, store.getState(), call).allow, true, action);
    const before = store.getState().revision;
    store.record({ ...call, type: 'tool_result', sessionId: 'fixture', result: 'bounded control receipt' });
    assert.equal(store.getState().revision, before, 'inbox bookkeeping creates no research checkpoint material');
  }
});

test('communication sends, replies and reports are control operations, not new computation', t => {
  const { store } = fixture(t);
  store.markCaptureFailure();
  store.meminfo = 'MemAvailable: 1000 kB';
  for (const action of ['send', 'reply', 'report']) {
    const call = event('research_communication', { action });
    assert.equal(needsResource(call), false, action);
    assert.equal(operationDecision(store, store.getState(), call).allow, true, action);
  }
  assert.equal(operationDecision(store, store.getState(), event('research_communication', { action: 'spawn' })).allow, false);
});

test('low memory permits durable plan registration while immediate computation remains gated', t => {
  const { store } = fixture(t);
  store.markCaptureFailure();
  store.meminfo = 'MemAvailable: 1000 kB';
  const state = store.getState();
  for (const action of ['plan', 'delegate']) {
    const call = event('research_dispatch', { action, planId: 'fixture-plan', task: 'Bounded existing authorized work',
      tasks: [{ id: 'queued', role: 'research-numerics', task: 'Compute after admission', stage: '2-experiment' }] });
    assert.equal(needsResource(call), false, action);
    assert.equal(observationTool(call.toolName, call.input), false, 'a new research plan remains reviewable evidence');
    const decision = operationDecision(store, state, call);
    assert.equal(decision.allow, true, action);
    assert.equal(decision.confirmable, undefined, 'queue registration creates no additional execution approval');
    const before = store.getState().materialRevision;
    store.record({ ...call, type: 'tool_result', sessionId: 'fixture', result: 'queued; zero process started' });
    assert.ok(store.getState().materialRevision > before, 'persisted plan metadata is retained for the next genuine checkpoint');
  }
  for (const call of [event('research_session', { role: 'numerics', task: 'Compute now' }),
    event('subagent', { agent: 'research-numerics', task: 'Compute now' }),
    event('bash', { command: 'python3 compute.py', timeout: 10 })]) {
    assert.equal(needsResource(call), true, call.toolName);
    assert.equal(operationDecision(store, state, call).allow, false, call.toolName);
  }
  for (const action of ['pause', 'resume']) {
    assert.equal(needsResource(event('research_dispatch', { action })), false);
    assert.equal(operationDecision(store, state, event('research_dispatch', { action })).allow, true);
  }
  assert.deepEqual(store.getState().operationGrants, [], 'queuing cannot create a launch or execution grant');
  assert.equal(store.getState().publicationPending, true);
});

test('plan registration preserves exact scoped restrictions and independent task permissions', t => {
  const { store } = fixture(t);
  store.meminfo = 'MemAvailable: 1000 kB';
  const state = { ...store.getState(), branchRestrictions: [{ id: 'paused-branch', active: true,
    coreRevision: store.getState().coreRevision, paths: ['src/paused.py'] }] };
  for (const action of ['plan', 'delegate']) {
    const input = action === 'plan' ? { action, tasks: [{ task: 'Inspect src/paused.py' }] }
      : { action, task: 'Inspect src/paused.py' };
    const decision = operationDecision(store, state, event('research_dispatch', input));
    assert.equal(decision.allow, false, action);
    assert.match(decision.reason, /已证实偏离分支/);
    assert.notEqual(decision.confirmable, true);
  }
  assert.equal(operationDecision(store, state, event('research_dispatch', { action: 'delegate', task: 'Inspect src/unrelated.py' })).allow, true);
  assert.deepEqual(store.getState().operationGrants, []);
});

test('direction health does not add confirmation to static local execution or resource observations', t => {
  const { store } = fixture(t);
  const base = store.getState();
  const healthStates = [
    { pendingChanges: true },
    { captureFailure: true, reviewHealth: { status: 'BLIND_SPOT' } },
    { lastVerdict: 'INSUFFICIENT_CONTEXT' },
    { lastVerdict: 'DRIFT_RISK' },
    { lastVerdict: 'FAILED', omittedEvents: 5 },
  ];
  for (const health of healthStates) {
    const state = { ...base, ...health };
    for (const command of ['cat notes/status.txt', 'free -m', "grep '^MemAvailable:' /proc/meminfo"]) {
      const decision = operationDecision(store, state, event('bash', { command, timeout: 10 }));
      assert.equal(decision.allow, true, JSON.stringify({ health, command }));
      assert.equal(decision.confirmable, undefined);
    }
    assert.equal(operationDecision(store, state, event('bash', { command: 'rm notes/status.txt', timeout: 10 })).hard, true);
  }
  store.meminfo = 'MemAvailable: 1000 kB';
  const state = { ...base, captureFailure: true, reviewHealth: { status: 'BLIND_SPOT' } };
  assert.equal(operationDecision(store, state, event('bash', { command: 'free -m', timeout: 10 })).allow, true);
  assert.equal(operationDecision(store, state, event('bash', { command: 'python3 compute.py', timeout: 10 })).allow, false);
});

test('new source helper leaves are not mistaken for model configuration or weights', t => {
  const { cwd, store } = fixture(t);
  for (const name of ['src/fit_transport_models.py', 'src/compare_models.mjs', 'src/validate_model.ts',
    'src/transport_models.cpp', 'src/render_models.jl']) {
    assert.equal(store.scopePath(name), name, name);
    assert.equal(operationDecision(store, store.getState(), event('write', { path: name, content: '// source fixture' })).allow, true, name);
  }
  for (const name of ['models.py', 'src/models.py', 'models.json', 'src/model_weights.bin', 'src/transport_models.pt',
    'src/transport_models.safetensors', 'src/transport_models.yaml', 'src/transport_models.json',
    'models/compare_models.py', 'raw/compare_models.py', 'secrets/compare_models.py',
    'src/private_models.py', 'src/credentials_models.py', 'src/auth_models.py',
    'src/settings_models.py', 'src/compare_models.pem', '../compare_models.py'])
    assert.throws(() => store.scopePath(name), undefined, name);
  fs.mkdirSync(path.join(cwd, 'src'));
  fs.symlinkSync(path.join(cwd, 'src'), path.join(cwd, 'linked'));
  fs.symlinkSync(path.join(cwd, 'src'), path.join(cwd, 'src', 'fit_transport_models.py'));
  for (const name of ['linked/compare_models.py', 'src/fit_transport_models.py'])
    assert.throws(() => store.scopePath(name), /Symlink/, name);
});
