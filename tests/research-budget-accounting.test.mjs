import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { configureResearch } from '../extensions/research-loop/src/adoption.mjs';
import { appendAttempt, sha256 } from '../extensions/research-loop/src/ledger.mjs';
import * as store from '../extensions/research-loop/src/research-budget.mjs';
import { bindResearchBudgetRuntime, isResearchBudgetRuntime } from '../extensions/research-loop/src/research-budget-runtime.mjs';
import { RESEARCH_BUDGET_RPC_KEY, RESEARCH_BUDGET_REQUIRED_ID, createResearchBudgetChildExtension, spawnBudgetedResearchWorkflow } from '../extensions/research-loop/src/research-budget-bridge.mjs';

function fixture(t, limits) {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'research-accounting-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { state } = configureResearch(cwd, { objective: 'Synthetic research accounting', successCriteria: ['Verifiable evidence'] });
  const binding = { cwd, charterHash: sha256(state.charter) };
  if (limits) store.updateResearchBudget({ ...binding, expectedRevision: null, requestId: 'legacy-policy-0001', limits });
  return { cwd, state, binding, root: path.join(cwd, '.pi', 'research-loop', 'research-budget') };
}

function attestedScope(binding, scopeId = 'synthetic-scope') {
  const descriptor = { schema: 'pi-research-budget-scope.v1', ...binding, scopeId, parentSessionId: 'synthetic-parent' };
  const scope = store.createResearchBudgetScope(descriptor);
  const source = 'export default function extension() {}\n';
  store.installResearchBudgetScopeExtension({ ...descriptor, source });
  store.attestResearchBudgetScope({ ...descriptor, extensionSha256: createHash('sha256').update(source).digest('hex'), physicalTransport: 'sse-http' });
  return { descriptor, scope };
}

function unbounded(snapshot) {
  assert.equal(snapshot.configured, false);
  assert.deepEqual(snapshot.limits, { attempts: null, modelRequests: null });
  assert.equal(snapshot.enforcement.attempts, false);
  assert.equal(snapshot.enforcement.modelRequests, false);
}

test('scoped accounting needs no policy and retains every request outcome and usage record', t => {
  const { binding, root } = fixture(t), { descriptor } = attestedScope(binding);
  const first = store.reserveResearchBudget({ ...descriptor, requestId: 'request-0001', kind: 'model-request', metadata: { role: 'research-theory' } });
  unbounded(first.budget);
  assert.equal(first.budget.usage.modelRequests, 1);
  assert.equal(first.budget.usage.inFlight, 1);
  const usage = { inputTokens: 13, outputTokens: 7, totalTokens: 20, reasoning: 3 };
  store.settleResearchBudget({ ...descriptor, reservationId: first.reservationId, outcome: 'completed', usage });
  const replay = store.reserveResearchBudget({ ...descriptor, requestId: 'request-0001', kind: 'model-request', metadata: { role: 'research-theory' } });
  assert.equal(replay.reused, true);
  assert.equal(replay.reservationId, first.reservationId);
  assert.equal(replay.outcome, 'completed');
  assert.throws(() => store.reserveResearchBudget({ ...descriptor, requestId: 'request-0001', kind: 'model-request', metadata: { role: 'research-reviewer' } }), /research-budget-request-conflict/);
  for (const [index, outcome] of ['failed', 'unknown'].entries()) {
    const reservation = store.reserveResearchBudget({ ...descriptor, requestId: `request-000${index + 2}`, kind: 'model-request' });
    store.settleResearchBudget({ ...descriptor, reservationId: reservation.reservationId, outcome });
  }
  const snapshot = store.readResearchBudget(binding);
  unbounded(snapshot);
  assert.deepEqual(snapshot.usage, { attempts: 0, modelRequests: 3, inFlight: 0, unknown: 1 });
  assert.equal(snapshot.scopedRuns, 1);
  assert.equal(snapshot.revision, null);
  assert.equal(fs.readdirSync(root).some(name => name.startsWith('policy-')), false);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `settlement-${first.reservationId}.json`), 'utf8')).usage, usage);
});

test('saved zero and finite policies stay readable without limiting scientific attempts or requests', t => {
  const { cwd, state, binding, root } = fixture(t, { attempts: 0, modelRequests: 0 });
  const policyFile = path.join(root, 'policy-000000000001.json'), originalPolicy = fs.readFileSync(policyFile);
  const original = store.readResearchBudget(binding);
  unbounded(original);
  assert.match(original.revision, /^[a-f0-9]{64}$/);
  for (let i = 0; i < 3; i++) store.withResearchAttemptBudget(binding, () => appendAttempt(cwd, state, { kind: 'experiment', signal: 'positive', action: `Observed result ${i}`, fingerprint: `distinct-${i}` }));
  const { descriptor } = attestedScope(binding);
  for (let i = 0; i < 3; i++) store.reserveResearchBudget({ ...descriptor, requestId: `zero-policy-request-${i}`, kind: 'model-request' });
  const changed = store.updateResearchBudget({ ...binding, expectedRevision: original.revision, requestId: 'legacy-policy-0002', limits: { attempts: 1, modelRequests: 1 } });
  unbounded(changed);
  store.reserveResearchBudget({ ...descriptor, requestId: 'finite-policy-request-4', kind: 'model-request' });
  const snapshot = store.readResearchBudget(binding);
  unbounded(snapshot);
  assert.equal(snapshot.usage.attempts, 3);
  assert.equal(snapshot.usage.modelRequests, 4);
  assert.deepEqual(fs.readFileSync(policyFile), originalPolicy);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'policy-000000000002.json'), 'utf8')).limits, { attempts: 1, modelRequests: 1 });
  assert.throws(() => store.updateResearchBudget({ ...binding, expectedRevision: original.revision, requestId: 'stale-policy-0003', limits: { attempts: 2, modelRequests: 2 } }), /research-budget-revision-conflict/);
});

test('removing caps keeps scope, charter, attestation and journal integrity checks', async t => {
  const { binding, root } = fixture(t);
  const descriptor = { schema: 'pi-research-budget-scope.v1', ...binding, scopeId: 'synthetic-scope', parentSessionId: 'synthetic-parent' };
  store.createResearchBudgetScope(descriptor);
  const reserve = extra => store.reserveResearchBudget({ ...descriptor, requestId: 'request-0001', kind: 'model-request', ...extra });
  assert.throws(() => reserve(), /research-budget-scope-mismatch/);
  const { scope } = attestedScope(binding);
  assert.throws(() => reserve({ charterHash: `sha256:${'f'.repeat(64)}` }), /research-budget-scope-mismatch/);
  assert.throws(() => store.readResearchBudgetScope({ ...descriptor, parentSessionId: 'another-parent' }), /research-budget-scope-mismatch/);
  await assert.rejects(bindResearchBudgetRuntime({}, { ...descriptor, parentSessionId: 'another-parent' }), /research-budget-scope-mismatch/);
  fs.writeFileSync(scope.extensionFile, 'export default function changed() {}\n');
  assert.throws(() => reserve(), /research-budget-scope-mismatch/);
  fs.writeFileSync(scope.extensionFile, 'export default function extension() {}\n');
  const orphan = path.join(root, 'settlement-orphan.json');
  fs.writeFileSync(orphan, '{}\n', { mode: 0o600 });
  assert.throws(() => store.readResearchBudget(binding), /research-budget-unavailable/);
});

test('legacy runtime counts physical transport retries with absent or zero policy', async t => {
  for (const limits of [undefined, { attempts: 0, modelRequests: 0 }]) {
    const { binding } = fixture(t, limits), { descriptor } = attestedScope(binding);
    const observed = [], message = { stopReason: 'stop', usage: { input: 3, output: 2 } };
    const runtime = {
      streamSimple(_model, _context, options) {
        observed.push(options);
        return { async result() {
          for (let i = 0; i < 2; i++) {
            const response = await options.fetch('https://synthetic.invalid/model', { method: 'POST' });
            await response.text();
            if (response.ok) return message;
          }
          throw Error('synthetic retries failed');
        } };
      },
    };
    const wrapped = await bindResearchBudgetRuntime(runtime, descriptor);
    let fetches = 0;
    const result = await wrapped.completeSimple({ provider: 'synthetic', id: 'synthetic-model', api: 'openai-completions' }, {}, { maxTokens: 12345, fetch: async (_url, init) => {
      fetches++;
      assert.equal(init.redirect, 'error');
      return new Response(fetches === 1 ? 'retry' : 'done', { status: fetches === 1 ? 503 : 200 });
    } });
    assert.equal(result, message);
    assert.equal(fetches, 2);
    assert.equal(observed[0].maxTokens, 12345);
    assert.equal(observed[0].transport, 'sse');
    assert.equal(isResearchBudgetRuntime(wrapped, descriptor), true);
    assert.equal(isResearchBudgetRuntime(runtime, descriptor), false);
    const snapshot = store.readResearchBudget(binding);
    unbounded(snapshot);
    assert.deepEqual(snapshot.usage, { attempts: 0, modelRequests: 2, inFlight: 0, unknown: 0 });
    const root = path.join(binding.cwd, '.pi', 'research-loop', 'research-budget');
    const outcomes = fs.readdirSync(root).filter(name => name.startsWith('settlement-')).map(name => JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')).outcome).sort();
    assert.deepEqual(outcomes, ['completed', 'failed']);
    assert.throws(() => wrapped.streamSimple({ provider: 'synthetic', api: 'unknown-api' }, {}), /research-budget-transport-unsupported/);
    const cancelled = new AbortController(); cancelled.abort();
    assert.throws(() => wrapped.streamSimple({ provider: 'synthetic', api: 'openai-completions' }, {}, { signal: cancelled.signal }), /research-budget-aborted/);
    assert.equal(store.readResearchBudget(binding).usage.modelRequests, 2);
  }
});

test('the legacy workflow bridge starts without a policy and keeps native scope binding', async t => {
  const { cwd, binding } = fixture(t), bus = new EventEmitter(), requests = [], registrations = [], pending = [];
  const pi = { events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name, value) => bus.emit(name, value) } };
  const runtime = {}, ctx = { cwd, sessionManager: { getSessionId: () => 'synthetic-parent' }, modelRegistry: runtime };
  let disposed = false, scoped;
  bus.on('subagents:rpc:v1:request', request => {
    requests.push(request);
    pending.push((async () => {
      let data;
      if (request.method === 'ping') data = { researchBudgetProtocol: 1 };
      else {
        const binding = globalThis[RESEARCH_BUDGET_RPC_KEY].get(request.requestId);
        scoped = await binding.bindContext(ctx, registration => { registrations.push(registration); return { dispose() { disposed = true; } }; });
        const source = fs.readFileSync(request.params.args.researchBudget.extension, 'utf8');
        assert.match(source, /bindScopedResearchRuntime/);
        const descriptor = { schema: 'pi-research-budget-scope.v1', ...bindingForDescriptor, scopeId: request.params.args.researchBudget.scopeId, parentSessionId: 'synthetic-parent' };
        const hooks = new Map();
        createResearchBudgetChildExtension(descriptor)({ on(name, handler) { hooks.set(name, handler); } });
        hooks.get('session_start')({}, scoped.ctx);
        assert.throws(() => hooks.get('session_start')({}, ctx), /research-budget-bridge-unavailable-open-new-session/);
        scoped.dispose();
        data = { runId: 'synthetic-run' };
      }
      bus.emit('subagents:rpc:v1:reply:' + request.requestId, { requestId: request.requestId, success: true, data });
    })().catch(error => {
      bus.emit('subagents:rpc:v1:reply:' + request.requestId, { requestId: request.requestId, success: false });
      throw error;
    }));
  });
  const bindingForDescriptor = binding;
  const result = await spawnBudgetedResearchWorkflow({ pi, ctx, ...binding, launchId: 'synthetic-launch', params: { workflow: 'auto-research', args: { topic: 'Synthetic topic' } } });
  await Promise.all(pending);
  assert.deepEqual(result, { runId: 'synthetic-run' });
  assert.deepEqual(requests.map(request => request.method), ['ping', 'spawn']);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].requireForAllRunners, true);
  assert.equal(registrations[0].extensions[0].id, RESEARCH_BUDGET_REQUIRED_ID);
  assert.equal(disposed, true);
  assert.equal(ctx.modelRegistry, runtime);
  assert.notEqual(scoped.ctx.modelRegistry, runtime);
  assert.equal(globalThis[RESEARCH_BUDGET_RPC_KEY].has(requests[1].requestId), false);
  unbounded(store.readResearchBudget(binding));
});
