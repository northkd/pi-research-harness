import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import registerResearchLoop from '../extensions/research-loop/src/index.ts';
import { configureResearch } from '../extensions/research-loop/src/adoption.mjs';
import { analyze, appendAttempt, loadState, readLedger, sha256 } from '../extensions/research-loop/src/ledger.mjs';
import { updateResearchBudget } from '../extensions/research-loop/src/research-budget.mjs';

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'research-no-budget-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const { state } = configureResearch(cwd, { objective: 'Synthetic bounded research', successCriteria: ['Reproducible evidence'] });
  return { cwd, state };
}

function legacyZeroBudget(cwd, state) {
  updateResearchBudget({ cwd, charterHash: sha256(state.charter), expectedRevision: null, requestId: 'legacy-budget-zero', limits: { attempts: 0, modelRequests: 0 } });
}

function host(t, cwd, { admitted = 1, accepted = true } = {}) {
  const originalExec = childProcess.execFileSync;
  t.mock.method(childProcess, 'execFileSync', (file, args, options) => {
    if (String(args?.[0]).endsWith('/explorer-capacity.mjs')) return JSON.stringify({ admit: admitted });
    return originalExec(file, args, options);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const bus = new EventEmitter(), tools = new Map(), hooks = new Map(), requests = [];
  const pi = {
    on(name, handler) { const list = hooks.get(name) ?? []; list.push(handler); hooks.set(name, list); },
    registerTool(tool) { tools.set(tool.name, tool); },
    registerCommand() {},
    events: { on(name, handler) { bus.on(name, handler); return () => bus.off(name, handler); }, emit: (name, value) => bus.emit(name, value) },
  };
  bus.on('subagents:rpc:v1:request', request => {
    requests.push(request);
    bus.emit('subagents:rpc:v1:reply:' + request.requestId, {
      requestId: request.requestId, success: accepted,
      data: { details: { runId: 'synthetic-run', asyncDir: path.join(cwd, 'runs', 'synthetic-run') } },
    });
  });
  registerResearchLoop(pi);
  const ctx = { cwd, hasUI: false, sessionManager: { getSessionId: () => 'synthetic-parent' } };
  t.after(async () => { for (const handler of hooks.get('session_shutdown') ?? []) await handler({}, ctx); });
  return { requests, run: () => tools.get('research_loop').execute('call', { action: 'run', maxExplorers: 1 }, undefined, undefined, ctx) };
}

test('the actual research_loop launch dispatches without configured request or attempt budgets', async t => {
  const { cwd } = fixture(t), f = host(t, cwd);
  const result = await f.run();
  assert.deepEqual(f.requests.map(request => request.method), ['spawn']);
  assert.equal(f.requests[0].params.args.researchBudget, undefined);
  assert.equal(f.requests[0].params.async, true);
  assert.equal(result.details.launched, true);
  assert.equal(fs.existsSync(path.join(cwd, '.pi', 'research-loop', 'research-budget')), false);
});

test('a former zero budget does not silently block a new normal workflow', async t => {
  const { cwd, state } = fixture(t);
  legacyZeroBudget(cwd, state);
  const f = host(t, cwd), result = await f.run();
  assert.deepEqual(f.requests.map(request => request.method), ['spawn']);
  assert.equal(result.details.launched, true);
  assert.equal(f.requests[0].params.args.researchBudget, undefined);
});

test('removing budget setup preserves memory admission and unconfirmed RPC outcomes', async t => {
  const { cwd } = fixture(t), lowMemory = host(t, cwd, { admitted: 0 });
  const blocked = await lowMemory.run();
  assert.equal(blocked.details.status, 'blocked');
  assert.match(blocked.details.reason, /memory headroom/);
  assert.deepEqual(lowMemory.requests, []);
});

test('a failed spawn stays unconfirmed and is never automatically retried', async t => {
  const { cwd } = fixture(t), f = host(t, cwd, { accepted: false });
  const result = await f.run();
  assert.equal(result.details.status, 'unconfirmed');
  assert.equal(result.details.launched, undefined);
  assert.equal(f.requests.length, 1);
});

test('scientific progress no longer stops at a default or formerly saved attempt quota', t => {
  const { cwd, state } = fixture(t);
  legacyZeroBudget(cwd, state);
  state.budget.maxAttempts = 1;
  for (let i = 0; i < 61; i++) appendAttempt(cwd, state, { kind: 'experiment', signal: 'positive', action: `Distinct completed attempt ${i}`, fingerprint: `attempt-${i}` });
  const health = analyze(cwd, state);
  assert.equal(health.attempts, 61);
  assert.equal(health.level, 'progressing');
  assert.equal(health.thresholds.maxAttempts, null);
  assert.doesNotMatch(JSON.stringify(health.reasons), /budget|exhausted/);
  assert.equal(sha256(loadState(cwd).charter), sha256(state.charter));
});

test('unused legacy budget files cannot prevent recording real evidence', t => {
  const { cwd, state } = fixture(t), oldDir = path.join(cwd, '.pi', 'research-loop', 'research-budget');
  fs.mkdirSync(oldDir, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'policy-000000000001.json'), 'incomplete old budget file');
  appendAttempt(cwd, state, { kind: 'experiment', signal: 'positive', action: 'Record the actual completed calculation', evidence: ['runs/result.csv'] });
  assert.equal(readLedger(cwd).length, 1);
  assert.equal(analyze(cwd, state).level, 'progressing');
});

test('repetition, missing progress and charter integrity remain effective', t => {
  const { cwd, state } = fixture(t);
  for (let i = 0; i < 3; i++) appendAttempt(cwd, state, { kind: 'experiment', signal: 'negative', action: 'Same unsuccessful action', fingerprint: 'same-action' });
  const health = analyze(cwd, state);
  assert.equal(health.level, 'stuck');
  assert.equal(health.repeated[0].count, 3);
  assert.match(health.reasons.join(' '), /no positive signal/);
  assert.throws(() => appendAttempt(cwd, { ...state, charter: { ...state.charter, objective: 'Unconfirmed replacement' } }, { kind: 'experiment', signal: 'positive', action: 'Must not record' }), /charter changed/i);
  assert.equal(readLedger(cwd).length, 3);
});

async function workflow(args, overrides = {}) {
  const source = fs.readFileSync(new URL('../extensions/research-loop/workflows/auto-research.js', import.meta.url), 'utf8');
  const calls = [], events = [];
  const runs = {
    all: async inputs => { calls.push(...inputs); return inputs.map(() => ({ ok: true, structuredOutput: { cards: [{ hypothesisId: 'one', claim: 'Unverified hypothesis' }] } })); },
    run: async (key, input) => {
      calls.push({ key, ...input });
      if (key === 'plan') return { ok: true, structuredOutput: { chosen: 'one', milestones: [{ id: 'test-one', task: 'Check one claim', executor: 'numerics' }], killCriteria: ['Counterexample'] } };
      if (key.startsWith('experiment-')) return { ok: true, structuredOutput: { status: 'blocked', commands: [], evidence: [], notes: 'No actual evidence' } };
      return { ok: true, output: 'Synthetic screen' };
    },
    ...overrides,
  };
  const result = await new Function('args', 'runs', 'emit', `return (async () => {\n${source}\n})();`)(args, runs, event => events.push(event));
  return { calls, events, result };
}

test('the shipped workflow reaches its plan without a budget adapter or hidden per-child quota', async () => {
  const { calls, result } = await workflow({ topic: 'A synthetic topic', maxExplorers: 2, stopAfter: 'plan' });
  assert.equal(result.status, 'planned');
  assert.deepEqual(calls.map(call => call.key), ['explorer-1', 'explorer-2', 'screen', 'plan']);
  assert.ok(calls.every(call => call.async === true));
  assert.ok(calls.every(call => call.extensions === undefined));
});

test('the workflow still stops on a blocked experiment and never claims a review result', async () => {
  const { calls, events, result } = await workflow({ topic: 'A synthetic topic', taskDir: '/synthetic-task', maxExplorers: 1 });
  assert.equal(result.status, 'blocked');
  assert.match(result.reason, /milestone test-one blocked/);
  assert.equal(calls.some(call => call.key.startsWith('review-')), false);
  assert.equal(events.at(-1).outcome, 'blocked');
});
