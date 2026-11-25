import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { configureResearch, charterHash } from '../src/adoption.mjs';
import { appendAttempt, appendNarrow, analyze, readLedger } from '../src/ledger.mjs';
import {
  readResearchBudget, updateResearchBudget, createResearchBudgetScope, readResearchBudgetScope,
  attestResearchBudgetScope, installResearchBudgetScopeExtension, reserveResearchBudget,
  settleResearchBudget, ResearchBudgetError,
} from '../src/research-budget.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const sha = value => createHash('sha256').update(value).digest('hex');
const fixtureDirs = [];
after(() => { for (const cwd of fixtureDirs) fs.rmSync(cwd, { recursive: true, force: true }); });

function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'synthetic-research-budget-'));
  fixtureDirs.push(cwd);
  const { state } = configureResearch(cwd, { objective: 'Synthetic accounting verification', successCriteria: ['Synthetic checks pass'] });
  return { cwd, state, charterHash: charterHash(cwd) };
}

function policy(f, attempts = 3, modelRequests = 2, expectedRevision = null, requestId = 'policy-request-1') {
  return updateResearchBudget({ ...f, expectedRevision, requestId, limits: { attempts, modelRequests } });
}

function scope(f, scopeId = 'scope-synthetic') {
  const descriptor = createResearchBudgetScope({ ...f, scopeId, parentSessionId: 'parent-synthetic' });
  const source = 'export const synthetic = true;\n';
  installResearchBudgetScopeExtension({ ...f, scopeId, parentSessionId: 'parent-synthetic', source });
  attestResearchBudgetScope({ ...f, scopeId, parentSessionId: 'parent-synthetic', extensionSha256: sha(source), physicalTransport: 'sse-http' });
  return descriptor;
}

test('unconfigured reads are pure and an attested accounting scope can record a physical request', () => {
  const f = fixture();
  const root = path.join(f.cwd, '.pi/research-loop/research-budget');
  const initial = readResearchBudget(f);
  assert.equal(initial.revision, null);
  assert.equal(initial.configured, false);
  assert.deepEqual(initial.limits, { attempts: null, modelRequests: null });
  assert.equal(fs.existsSync(root), false);
  assert.throws(() => reserveResearchBudget({ ...f, scopeId: 'scope-synthetic', requestId: 'request-unconfigured', kind: 'model-request' }), error => error instanceof ResearchBudgetError && error.code === 'research-budget-scope-mismatch');
  scope(f);
  const recorded = reserveResearchBudget({ ...f, scopeId: 'scope-synthetic', requestId: 'request-unconfigured', kind: 'model-request' });
  assert.equal(recorded.slot, 1);
  assert.equal(recorded.budget.configured, false);
  assert.deepEqual(recorded.budget.limits, { attempts: null, modelRequests: null });
  assert.throws(() => policy(f, null, 2), error => error.code === 'research-budget-invalid');
});

test('historical policy SHA CAS, exact request idempotency and finite journal values are preserved', () => {
  const f = fixture(), first = policy(f);
  assert.match(first.revision, /^[a-f0-9]{64}$/);
  assert.equal(policy(f).revision, first.revision);
  assert.equal(updateResearchBudget({ ...f, expectedRevision: null, requestId: 'policy-request-1', limits: { modelRequests: 2, attempts: 3 } }).revision, first.revision);
  assert.throws(() => policy(f, 4, 2, null, 'policy-request-2'), error => error.code === 'research-budget-revision-conflict');
  assert.throws(() => policy(f, 4, 2, null, 'policy-request-1'), error => error.code === 'research-budget-request-conflict');
  const next = policy(f, 4, 3, first.revision, 'policy-request-2');
  assert.notEqual(next.revision, first.revision);
  assert.deepEqual(next.limits, { attempts: null, modelRequests: null });
  const journal = JSON.parse(fs.readFileSync(path.join(f.cwd, '.pi/research-loop/research-budget/policy-000000000002.json'), 'utf8'));
  assert.deepEqual(journal.limits, { attempts: 4, modelRequests: 3 });
  assert.equal(journal.previousRevision, first.revision);
  assert.equal(readResearchBudget(f).revision, next.revision);
});

test('only an attested immutable scope permits reservation and metadata is allowlisted', () => {
  const f = fixture();
  policy(f);
  const descriptor = createResearchBudgetScope({ ...f, scopeId: 'scope-synthetic', parentSessionId: 'parent-synthetic' });
  assert.equal(readResearchBudget(f).enforcement.modelRequests, false);
  assert.throws(() => reserveResearchBudget({ ...f, scopeId: descriptor.scopeId, requestId: 'physical-request-1', kind: 'model-request' }), error => error.code === 'research-budget-scope-mismatch');
  scope(f);
  const proof = readResearchBudgetScope({ ...f, scopeId: descriptor.scopeId, parentSessionId: descriptor.parentSessionId });
  assert.equal(proof.attested, true);
  assert.equal(readResearchBudget(f).scopedRuns, 1);
  assert.throws(() => reserveResearchBudget({ ...f, scopeId: descriptor.scopeId, requestId: 'physical-request-1', kind: 'model-request', metadata: { prompt: 'forbidden body' } }), error => error.code === 'research-budget-invalid');
  assert.throws(() => createResearchBudgetScope({ ...f, scopeId: descriptor.scopeId, parentSessionId: 'other-parent' }), error => error.code === 'research-budget-scope-mismatch');
});

test('physical intents stay durable, request replays deduplicate and unknown outcomes retain accounting', () => {
  const f = fixture();
  policy(f);
  scope(f);
  const request = { ...f, scopeId: 'scope-synthetic', requestId: 'physical-request-1', kind: 'model-request', metadata: { phase: 'review', role: 'reviewer', model: { provider: 'synthetic', id: 'physical' } } };
  const first = reserveResearchBudget(request);
  assert.equal(first.slot, 1);
  assert.equal(first.reused, false);
  assert.equal(reserveResearchBudget(request).reused, true);
  assert.throws(() => reserveResearchBudget({ ...request, metadata: { phase: 'summary' } }), error => error.code === 'research-budget-request-conflict');
  settleResearchBudget({ ...f, reservationId: first.reservationId, outcome: 'unknown', usage: { input: 1, output: 2 } });
  const observed = readResearchBudget(f);
  assert.equal(observed.usage.modelRequests, 1);
  assert.equal(observed.usage.unknown, 1);
  assert.equal(observed.usage.inFlight, 0);
  const lowered = policy(f, 3, 0, observed.revision, 'policy-lower-req');
  assert.equal(lowered.usage.modelRequests, 1);
  assert.deepEqual(lowered.limits, { attempts: null, modelRequests: null });
  const second = reserveResearchBudget({ ...request, requestId: 'physical-request-2' });
  assert.equal(second.slot, 2);
  assert.equal(second.budget.usage.modelRequests, 2);
  assert.equal(second.budget.usage.unknown, 1);
  assert.throws(() => settleResearchBudget({ ...f, reservationId: first.reservationId, outcome: 'completed' }), error => error.code === 'research-budget-request-conflict');
});

test('attempt accounting includes narrowing and retained finite policies preserve measured progress', () => {
  const f = fixture();
  appendAttempt(f.cwd, f.state, { kind: 'experiment', signal: 'positive', action: 'Synthetic first' });
  assert.equal(readResearchBudget(f).usage.attempts, 1);
  policy(f, 2, 2);
  scope(f);
  appendNarrow(f.cwd, f.state, { action: 'Synthetic narrowing', reason: 'Synthetic narrowing', dropped: ['Synthetic scope'], evidence: ['synthetic.md'] });
  assert.equal(readLedger(f.cwd).length, 2);
  assert.equal(readResearchBudget(f).usage.attempts, 2);
  assert.equal(analyze(f.cwd, f.state).thresholds.maxAttempts, null);
  appendAttempt(f.cwd, f.state, { kind: 'experiment', signal: 'positive', action: 'Completed in-flight third' });
  assert.equal(readLedger(f.cwd).length, 3);
  assert.equal(analyze(f.cwd, f.state).level, 'progressing');
  const request = reserveResearchBudget({ ...f, scopeId: 'scope-synthetic', requestId: 'accounted-after-attempts', kind: 'model-request' });
  assert.equal(request.slot, 1);
  assert.equal(readResearchBudget(f).usage.attempts, 3);
  assert.equal(readResearchBudget(f).usage.modelRequests, 1);
});

test('a corrupt scope or replaced extension refuses another physical accounting slot', () => {
  const f = fixture();
  policy(f);
  const descriptor = scope(f);
  fs.appendFileSync(descriptor.extensionFile, '// changed\n');
  assert.throws(() => reserveResearchBudget({ ...f, scopeId: descriptor.scopeId, requestId: 'changed-extension-1', kind: 'model-request' }), error => error.code === 'research-budget-scope-mismatch');
  fs.writeFileSync(descriptor.scopeFile, '{}');
  assert.throws(() => readResearchBudget(f), error => error.code === 'research-budget-scope-mismatch');
});

test('independent recorders preserve unique sequential slots beyond a historical numeric ceiling', async () => {
  const f = fixture();
  policy(f, 3, 1);
  scope(f);
  const module = path.resolve(here, '../src/research-budget.mjs'), ready = path.join(f.cwd, 'race-go');
  const program = `
    import fs from 'node:fs';
    import { reserveResearchBudget } from ${JSON.stringify(module)};
    while (!fs.existsSync(${JSON.stringify(ready)})) await new Promise(resolve => setTimeout(resolve, 5));
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        const value = reserveResearchBudget({ cwd: ${JSON.stringify(f.cwd)}, charterHash: ${JSON.stringify(f.charterHash)}, scopeId: 'scope-synthetic', requestId: process.argv[1], kind: 'model-request' });
        fs.writeFileSync(process.argv[2], JSON.stringify({ ok: true, slot: value.slot, reservationId: value.reservationId }));
        break;
      } catch (error) {
        if (error.code !== 'research-budget-unavailable' || attempt === 99) throw error;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  `;
  const run = requestId => new Promise((resolve, reject) => {
    const output = path.join(f.cwd, requestId + '.json');
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, requestId, output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorText = '';
    child.stderr.on('data', value => { errorText += value; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        if (code) reject(new Error(errorText));
        else resolve(JSON.parse(fs.readFileSync(output, 'utf8')));
      } catch (error) { reject(error); }
    });
  });
  const first = run('race-request-one'), second = run('race-request-two');
  fs.writeFileSync(ready, 'go');
  const results = await Promise.all([first, second]);
  assert.ok(results.every(value => value.ok));
  assert.deepEqual(results.map(value => value.slot).sort(), [1, 2]);
  assert.equal(new Set(results.map(value => value.reservationId)).size, 2);
  assert.equal(readResearchBudget(f).usage.modelRequests, 2);
});

test('host extension installation is exclusive and idempotent and a missing charter rejects accounting', () => {
  const f = fixture();
  policy(f);
  const descriptor = createResearchBudgetScope({ ...f, scopeId: 'scope-install', parentSessionId: 'parent-synthetic' });
  const first = installResearchBudgetScopeExtension({ ...f, scopeId: descriptor.scopeId, parentSessionId: descriptor.parentSessionId, source: 'export const value = 1;\n' });
  assert.equal(first.extensionSha256, sha('export const value = 1;\n'));
  assert.equal(installResearchBudgetScopeExtension({ ...f, scopeId: descriptor.scopeId, parentSessionId: descriptor.parentSessionId, source: 'export const value = 1;\n' }).extensionSha256, first.extensionSha256);
  assert.throws(() => installResearchBudgetScopeExtension({ ...f, scopeId: descriptor.scopeId, parentSessionId: descriptor.parentSessionId, source: 'export const value = 2;\n' }), error => error.code === 'research-budget-scope-mismatch');
  fs.unlinkSync(path.join(f.cwd, '.pi/research-loop/state.json'));
  assert.throws(() => readResearchBudget({ ...f, charterHash: charterHash(f.cwd) }), error => error.code === 'research-budget-scope-mismatch');
});
