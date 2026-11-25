import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import registerResearchLoop from '../src/index.ts';
import { readEventsTolerant } from '../src/workflow-progress.mjs';
import { charterHash } from '../src/adoption.mjs';
import { updateResearchBudget } from '../src/research-budget.mjs';
import { spawnBudgetedResearchWorkflow } from '../src/research-budget-bridge.mjs';

function fixture(t, { foreignOwner = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'research-extension-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'project');
  fs.mkdirSync(cwd);
  const subscribers = new Map(), lifecycle = new Map();
  let tool, spawned = 0, pings = 0;
  mock.method(childProcess, 'execFileSync', (_command, args) => {
    assert(args[0].endsWith('explorer-capacity.mjs'), 'No real subprocess or model call is allowed');
    return JSON.stringify({ admit: 1 });
  });
  syncBuiltinESMExports();
  t.after(() => { mock.restoreAll(); syncBuiltinESMExports(); });
  const pi = {
    on(name, callback) { lifecycle.set(name, callback); },
    registerTool(definition) { tool = definition; },
    registerCommand() {},
    events: {
      on(name, callback) { subscribers.set(name, callback); return () => subscribers.delete(name); },
      emit(name, request) {
        assert.equal(name, 'subagents:rpc:v1:request');
        if (request.method === 'ping') {
          pings += 1;
          subscribers.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({ version: 1, method: 'ping', requestId: request.requestId, success: true, data: { researchBudgetProtocol: 1 } });
          return;
        }
        assert.equal(request.method, 'spawn');
        const binding = globalThis[Symbol.for('pi-research-budget-rpc.v1')]?.get(request.requestId);
        void (async () => {
          const scoped = binding ? await binding.bindContext(ctx, registration => {
            assert.equal(registration.sessionId, 'fixture-parent');
            assert.equal(registration.requireForAllRunners, true);
            assert.equal(registration.extensions[0].id, 'research-budget-v1');
            assert(fs.existsSync(registration.extensions[0].path));
            return { dispose() {} };
          }, new AbortController().signal) : undefined;
          try {
            if (scoped) {
              assert.equal(binding.version, 1);
              assert.notEqual(scoped.ctx.modelRegistry, ctx.modelRegistry);
            } else assert.equal(request.params.args.researchBudget, undefined, 'Routine launches use the native host without a generated accounting scope');
            spawned += 1;
            const runId = `fixture-run-${spawned}`;
            const asyncDir = path.join(home, 'native', runId);
            fs.mkdirSync(asyncDir, { recursive: true });
            const native = { runId, mode: 'workflow', cwd, sessionId: foreignOwner ? 'other-parent' : 'fixture-parent', state: 'completed', steps: [], workflow: { emits: [{ type: 'workflow-result', outcome: 'planned' }] } };
            fs.writeFileSync(path.join(asyncDir, 'status.json'), JSON.stringify(native));
            fs.writeFileSync(path.join(asyncDir, 'events.jsonl'), JSON.stringify({ type: 'subagent.workflow.completed', runId, state: 'completed', ts: 1792713600000 }) + '\n');
            subscribers.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({ version: 1, method: 'spawn', requestId: request.requestId, success: true, data: { details: { runId, asyncDir } } });
          } finally { scoped?.dispose(); }
        })().catch(error => {
          subscribers.get(`subagents:rpc:v1:reply:${request.requestId}`)?.({ version: 1, method: 'spawn', requestId: request.requestId, success: false, error: { message: error.message } });
        });
      },
    },
  };
  registerResearchLoop(pi);
  const ctx = { cwd, hasUI: false, modelRegistry: {}, sessionManager: { getSessionId: () => 'fixture-parent' } };
  t.after(async () => { await lifecycle.get('session_shutdown')?.({}, ctx); });
  return {
    cwd, tool, ctx, pi, lifecycle, spawned: () => spawned, pings: () => pings,
    saveBudget: () => updateResearchBudget({ cwd, charterHash: charterHash(cwd), expectedRevision: null, requestId: 'fixture-budget-save', limits: { attempts: 60, modelRequests: 10 } }),
    records: () => readEventsTolerant(path.join(cwd, '.pi/research-loop/events.jsonl')),
  };
}
const configure = { action: 'configure', objective: '离线接线验收，不运行科研', successCriteria: ['真实身份与进度可追溯'], maxExplorers: 1 };
function details(result) {
  assert(Array.isArray(result.content), 'Pi tools must return AgentToolResult.content');
  assert.equal(result.content[0]?.type, 'text');
  assert.deepEqual(JSON.parse(result.content[0].text), JSON.parse(JSON.stringify(result.details)));
  return result.details;
}

test('historical initialization does not launch a workflow and returns a valid tool result', async t => {
  const f = fixture(t);
  const result = details(await f.tool.execute('configure-offline', { ...configure, autoRun: false }, undefined, undefined, f.ctx));
  assert.equal(result.charter.objective, configure.objective);
  assert.equal(f.spawned(), 0);
  assert(!fs.existsSync(path.join(f.cwd, '.pi/research-loop/auto-run.json')));
});

test('run with a historical saved budget launches once and recovery never launches again', async t => {
  const f = fixture(t);
  details(await f.tool.execute('configure-offline', { ...configure, autoRun: false }, undefined, undefined, f.ctx));
  f.saveBudget();
  const raw = await f.tool.execute('run-budgeted', { action: 'run', maxExplorers: 1 }, undefined, undefined, f.ctx);
  const provisional = raw.details ?? raw;
  assert.equal(provisional.launched, true);
  assert.notEqual(provisional.tracking, 'unavailable', provisional.reason);
  const result = details(raw);
  assert.equal(result.launched, true);
  assert.equal(f.pings(), 0);
  assert.equal(f.spawned(), 1);
  const registered = f.records().find(e => e.kind === 'run-registered');
  assert.equal(registered.detail.runId, 'fixture-run-1');
  assert.equal(registered.detail.parentSessionId, 'fixture-parent');
  assert(registered.detail.configuration.stages['1-idea']);
  const statePath = path.join(f.cwd, '.pi/research-loop/state.json');
  const stateBefore = fs.readFileSync(statePath, 'utf8');
  const eventsBefore = JSON.stringify(f.records());
  await f.lifecycle.get('session_start')({}, f.ctx);
  assert.equal(f.spawned(), 1);
  assert.equal(fs.readFileSync(statePath, 'utf8'), stateBefore);
  assert.equal(JSON.stringify(f.records()), eventsBefore);
  assert(!fs.existsSync(path.join(f.cwd, '.pi/research-loop/ledger.jsonl')));
});

test('a foreign native owner is not registered as the current research run', async t => {
  const f = fixture(t, { foreignOwner: true });
  details(await f.tool.execute('configure-offline', { ...configure, autoRun: false }, undefined, undefined, f.ctx));
  f.saveBudget();
  const raw = await f.tool.execute('foreign-owner', { action: 'run', maxExplorers: 1 }, undefined, undefined, f.ctx);
  const result = raw.details ?? raw;
  assert.equal(f.spawned(), 1);
  assert.equal(f.records().filter(e => e.kind === 'run-registered').length, 0);
  assert.equal(result.tracking, 'unavailable');
});

test('autoRun without a saved policy launches once through the native host', async t => {
  const f = fixture(t);
  const result = details(await f.tool.execute('configure-without-budget', { ...configure, autoRun: true }, undefined, undefined, f.ctx));
  assert.equal(result.autoRun.launched, true);
  assert.equal(f.spawned(), 1);
  assert.equal(f.pings(), 0);
  assert.equal(fs.existsSync(path.join(f.cwd, '.pi/research-loop/research-budget')), false);
});

test('an explicit legacy accounting adapter still binds the exact native scope', async t => {
  const f = fixture(t);
  details(await f.tool.execute('configure-offline', { ...configure, autoRun: false }, undefined, undefined, f.ctx));
  const result = await spawnBudgetedResearchWorkflow({ pi: f.pi, ctx: f.ctx, cwd: f.cwd,
    charterHash: charterHash(f.cwd), launchId: 'synthetic-legacy-adapter',
    params: { workflow: '/synthetic/workflow.js', cwd: f.cwd, args: {}, async: true } });
  assert.equal(result.details.runId, 'fixture-run-1');
  assert.equal(f.pings(), 1);
  assert.equal(f.spawned(), 1);
});
