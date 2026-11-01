import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { readFileSync, promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const tree = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = pathToFileURL(tree + '/').href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(prefix) && specifier.startsWith('.') && specifier.endsWith('.js')) return { url: new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL).href, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(prefix) && url.endsWith('.ts')) return { format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
    return next(url, context);
  },
});
const { createFullHistoryAgentStore } = await import(pathToFileURL(path.join(tree, 'full-history-agent-store.ts')).href);
const { writeFullHistoryAgentBudgetAmendment, FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION } = await import(pathToFileURL(path.join(tree, 'full-history-agent-budget.ts')).href);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const consent = { scope: 'this-job', budgetMayIncreaseCharges: true, unknownRetryMayBillAgain: true };
const stage = await fs.mkdtemp(path.join(tmpdir(), 'intake-budget-node-'));
console.log('synthetic stage:', stage);
async function fixture({ legacy = false, initialBudget } = {}) {
  const scope = await fs.mkdtemp(path.join(stage, 'scope-')), root = path.join(scope, 'job'); await fs.mkdir(root, { mode: 0o700 });
  const binding = { root, jobId: 'adopt-' + 'a'.repeat(24), ownerKey: 'synthetic-owner', cwd: '/synthetic/project' };
  const grant = { analysisMode: 'full-history-agent-v2', grantHash: 'b'.repeat(64), materialPlanId: 'hplan-' + 'c'.repeat(24), materialPlanHash: 'd'.repeat(64), model: { provider: 'synthetic', id: 'physical' }, historySelection: ['synthetic'], baseRequests: 2, retryReserve: 1, maxRequests: 3, policy: { id: 'bounded-intake-v2', maxNodeAttempts: 3, maxJsonRepairsPerNode: 1, maxUnknownRetriesPerNode: 1, maxLengthEscalationsPerNode: 1, unknownRetryMayBillAgain: true, grantLifetimeMs: 86400000, initialOutputTokens: 4096, maxOutputTokens: 8192 } };
  const at = Date.now(), record = { grant, modelFingerprint: 'synthetic-fp', requestId: 'authorize', requestHash: digest('authorize'), authorizedAt: new Date(at).toISOString(), expiresAt: new Date(at + 86400000).toISOString(), nodeIds: ['batch-0', 'final-0'], promptSchemaHash: 'f'.repeat(64), ...(initialBudget ? { initialBudget } : {}) };
  const store = createFullHistoryAgentStore(binding); await store.authorize(record);
  if (legacy) await writeFullHistoryAgentBudgetAmendment({ ...binding, scopeDir: scope, grantHash: grant.grantHash, materialPlanHash: grant.materialPlanHash, modelFingerprint: record.modelFingerprint, promptSchemaHash: record.promptSchemaHash, authorizedAt: record.authorizedAt, expiresAt: record.expiresAt }, { schema: 'pi-full-agent-budget-amendment.v1', mode: 'unlimited', ownerKey: binding.ownerKey, cwd: binding.cwd, jobId: binding.jobId, grantHash: grant.grantHash, materialPlanHash: grant.materialPlanHash, modelFingerprint: record.modelFingerprint, promptSchemaHash: record.promptSchemaHash, authorizedAt: new Date().toISOString(), expiresAt: record.expiresAt, userInstruction: FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION });
  const held = await store.acquire(); let released = false;
  const lease = { ...held, async release() { if (!released) { released = true; await held.release(); } } };
  const update = (maxRequests, expectedRevision, requestId = 'budget-' + expectedRevision) => store.updateBudget({ requestId, requestHash: digest([requestId, maxRequests, expectedRevision]), grantHash: grant.grantHash, expectedRevision, maxRequests, consent });
  const send = async () => {
    const rows = await store.attempts('batch-0');
    const intent = await store.beforeSend({ nodeId: 'batch-0', nodeAttempt: rows.length + 1, kind: rows.length ? 'retry-unknown' : 'initial', baseInputHash: '1'.repeat(64), requestHash: digest(['request', rows.length]), promptSchemaHash: record.promptSchemaHash, modelFingerprint: record.modelFingerprint, requestBytes: 42, maxTokens: 4096 }, lease);
    return intent;
  };
  return { scope, root, store, lease, update, send, binding, record, grant };
}
test('finite total cap bypasses old reserve/node retry counts, decrease preserves unknown history and immutable files', async () => {
  const f = await fixture(); try {
    const original = await fs.readFile(path.join(f.root, 'grant.json'));
    await f.update(6, 0); for (let i = 0; i < 6; i++) await f.send();
    await assert.rejects(f.send(), /budget-exhausted/);
    const oldIntents = await Promise.all((await fs.readdir(f.root)).filter(n => n.endsWith('.intent.json')).map(async n => [n, await fs.readFile(path.join(f.root, n))]));
    await f.update(1, 1); await assert.rejects(f.send(), /budget-exhausted/);
    await f.lease.release(); const cold = createFullHistoryAgentStore(f.binding); const state = await cold.state({ strict: true });
    assert.equal(state.attempts.length, 6); assert.equal(state.budgetAuthorization.maxRequests, 1); assert.equal(state.budgetAuthorization.revision, 2);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'grant.json')), original);
    for (const [name, bytes] of oldIntents) assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
  } finally { await f.lease.release(); }
});
test('revision CAS and idempotency serialize with reservations; zero cap blocks next dispatch', async () => {
  const f = await fixture(); try {
    await f.update(0, 0); await f.update(0, 0); await assert.rejects(f.update(null, 0), /request-id-conflict/); await assert.rejects(f.update(2, 0, 'stale'), /revision-conflict/); await assert.rejects(f.send(), /budget-exhausted/);
    await f.update(null, 1); const first = await f.send(); assert.equal(first.slot, 1);
    await Promise.all([f.update(1, 2), assert.rejects(f.send(), /budget-exhausted/)]);
    const state = await f.store.state(); assert.equal(state.attempts.length, 1); assert.equal(state.budgetAuthorization.revision, 3);
  } finally { await f.lease.release(); }
});
test('legacy unlimited historical attempts survive finite cap on cold reopen', async () => {
  const f = await fixture({ legacy: true }); try {
    for (let i = 0; i < 5; i++) await f.send(); await f.update(0, 0); await assert.rejects(f.send(), /budget-exhausted/);
    await f.lease.release(); const cold = createFullHistoryAgentStore(f.binding); assert.equal((await cold.state({ strict: true })).attempts.length, 5);
  } finally { await f.lease.release(); }
});
test('invalid cap/consent, cancellation and foreign scope cannot append', async () => {
  const f = await fixture(); try {
    for (const cap of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '8']) await assert.rejects(f.update(cap, 0), /budget-invalid/);
    await assert.rejects(f.store.updateBudget({ requestId: 'bad-consent', requestHash: digest('bad'), grantHash: f.grant.grantHash, expectedRevision: 0, maxRequests: null, consent: { ...consent, budgetMayIncreaseCharges: false } }), /budget-invalid/);
    const foreign = createFullHistoryAgentStore({ ...f.binding, ownerKey: 'foreign' }); await assert.rejects(foreign.state({ strict: true }), /record-invalid/);
    await f.store.cancel(); await assert.rejects(f.update(2, 0), /cancelled/);
  } finally { await f.lease.release(); }
});
test('initial cap0 survives cold reopen using one grant record, without a second publication window', async () => {
  const f = await fixture({ initialBudget: { maxRequests: 0, consent } }); try {
    await assert.rejects(f.send(), /budget-exhausted/); await f.lease.release();
    assert.deepEqual(await fs.readdir(f.root), ['grant.json']);
    const cold = createFullHistoryAgentStore(f.binding), state = await cold.state({ strict: true });
    assert.equal(state.budgetAuthorization.maxRequests, 0); assert.equal(state.budgetAuthorization.revision, 1); assert.equal(state.attempts.length, 0);
  } finally { await f.lease.release(); }
});
test('foreign store cannot race live worker; expired authority cannot append and cancellation still accounts in-flight', async () => {
  const f = await fixture(); const now = Date.now; try {
    const other = createFullHistoryAgentStore(f.binding);
    await assert.rejects(other.updateBudget({ requestId: 'foreign-store', requestHash: digest('foreign'), grantHash: f.grant.grantHash, expectedRevision: 0, maxRequests: null, consent }), /worker-busy/);
    const intent = await f.send(); Date.now = () => now() + 86400001;
    await assert.rejects(f.update(5, 0), /authorization-expired/); await assert.rejects(f.send(), /authorization-expired/); Date.now = now;
    await f.store.cancel();
    await f.store.receipt({ schema: 'pi-full-agent-attempt-receipt.v2', attemptId: intent.attemptId, nodeId: intent.nodeId, slot: intent.slot, requestHash: intent.requestHash, outcome: 'unknown', sdkStopReason: 'error', providerTerminalObserved: false });
    assert.equal((await f.store.state()).attempts[0].receipt.outcome, 'unknown');
  } finally { Date.now = now; await f.lease.release(); }
});
