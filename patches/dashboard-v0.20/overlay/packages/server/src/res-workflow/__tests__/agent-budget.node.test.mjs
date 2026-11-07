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
async function fixture({ legacy = false, initialBudget, nodeCount = 2 } = {}) {
  const scope = await fs.mkdtemp(path.join(stage, 'scope-')), root = path.join(scope, 'job'); await fs.mkdir(root, { mode: 0o700 });
  const binding = { root, jobId: 'adopt-' + 'a'.repeat(24), ownerKey: 'synthetic-owner', cwd: '/synthetic/project' };
  const grant = { analysisMode: 'full-history-agent-v2', grantHash: 'b'.repeat(64), materialPlanId: 'hplan-' + 'c'.repeat(24), materialPlanHash: 'd'.repeat(64), model: { provider: 'synthetic', id: 'physical' }, historySelection: ['synthetic'], baseRequests: nodeCount, retryReserve: nodeCount === 2 ? 1 : 0, maxRequests: nodeCount + (nodeCount === 2 ? 1 : 0), policy: { id: 'bounded-intake-v2', maxNodeAttempts: 3, maxJsonRepairsPerNode: 1, maxUnknownRetriesPerNode: 1, maxLengthEscalationsPerNode: 1, unknownRetryMayBillAgain: true, grantLifetimeMs: 86400000, initialOutputTokens: 4096, maxOutputTokens: 8192 } };
  const at = Date.now(), record = { grant, modelFingerprint: 'synthetic-fp', requestId: 'authorize', requestHash: digest('authorize'), authorizedAt: new Date(at).toISOString(), expiresAt: new Date(at + 86400000).toISOString(), nodeIds: Array.from({length: nodeCount}, (_, i) => i === nodeCount - 1 ? 'final-0' : `batch-${i}`), promptSchemaHash: 'f'.repeat(64), ...(initialBudget ? { initialBudget } : {}) };
  const store = createFullHistoryAgentStore(binding); await store.authorize(record);
  if (legacy) await writeFullHistoryAgentBudgetAmendment({ ...binding, scopeDir: scope, grantHash: grant.grantHash, materialPlanHash: grant.materialPlanHash, modelFingerprint: record.modelFingerprint, promptSchemaHash: record.promptSchemaHash, authorizedAt: record.authorizedAt, expiresAt: record.expiresAt }, { schema: 'pi-full-agent-budget-amendment.v1', mode: 'unlimited', ownerKey: binding.ownerKey, cwd: binding.cwd, jobId: binding.jobId, grantHash: grant.grantHash, materialPlanHash: grant.materialPlanHash, modelFingerprint: record.modelFingerprint, promptSchemaHash: record.promptSchemaHash, authorizedAt: new Date().toISOString(), expiresAt: record.expiresAt, userInstruction: FULL_HISTORY_AGENT_UNLIMITED_INSTRUCTION });
  const held = await store.acquire(); let released = false;
  const lease = { ...held, async release() { if (!released) { released = true; await held.release(); } } };
  const update = (maxRequests, expectedRevision, requestId = 'budget-' + expectedRevision) => store.updateBudget({ requestId, requestHash: digest([requestId, maxRequests, expectedRevision]), grantHash: grant.grantHash, expectedRevision, maxRequests, consent });
  const send = async (nodeId = 'batch-0') => {
    const rows = await store.attempts(nodeId);
    const intent = await store.beforeSend({ nodeId, nodeAttempt: rows.length + 1, kind: rows.length ? 'retry-unknown' : 'initial', baseInputHash: '1'.repeat(64), requestHash: digest(['request', rows.length]), promptSchemaHash: record.promptSchemaHash, modelFingerprint: record.modelFingerprint, requestBytes: 42, maxTokens: 4096 }, lease);
    return intent;
  };
  return { scope, root, store, lease, update, send, binding, record, grant };
}
test('default grant counts and repeated retry kinds do not cap sends; cold replay retains accounting', async () => {
  const f = await fixture(); try {
    const original = await fs.readFile(path.join(f.root, 'grant.json'));
    for (let i = 0; i < 6; i++) {
      const intent = await f.send();
      await f.store.receipt({ schema: 'pi-full-agent-attempt-receipt.v2', attemptId: intent.attemptId,
        nodeId: intent.nodeId, slot: intent.slot, requestHash: intent.requestHash, outcome: 'unknown',
        sdkStopReason: 'error', providerTerminalObserved: false, usage: { input: 10, output: 2, totalTokens: 12 } });
    }
    const immutable = await Promise.all((await fs.readdir(f.root)).filter(n => /\.(?:intent|receipt)\.json$/.test(n))
      .map(async n => [n, await fs.readFile(path.join(f.root, n))]));
    await f.lease.release();
    const state = await createFullHistoryAgentStore(f.binding).state({ strict: true });
    assert.equal(state.attempts.length, 6); assert.equal(state.budgetAuthorization, null);
    assert.equal(state.attempts.reduce((total, row) => total + row.receipt.usage.totalTokens, 0), 72);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'grant.json')), original);
    assert.equal((await fs.readdir(f.root)).some(n => n.startsWith('budget-')), false, 'no fabricated budget consent/revision');
    for (const [name, bytes] of immutable) assert.deepEqual(await fs.readFile(path.join(f.root, name)), bytes);
  } finally { await f.lease.release(); }
});
test('legacy finite and zero policies are preserved but do not block more than 128 physical requests', async () => {
  const f = await fixture({ initialBudget: { maxRequests: 0, consent } }); try {
    const original = await fs.readFile(path.join(f.root, 'grant.json'));
    for (let i = 0; i < 129; i++) await f.send();
    await f.update(1, 1); await f.send(); await f.update(0, 2); await f.send();
    await f.lease.release();
    const state = await createFullHistoryAgentStore(f.binding).state({ strict: true });
    assert.equal(state.attempts.length, 131); assert.equal(state.budgetAuthorization.maxRequests, 0);
    assert.equal(state.budgetAuthorization.revision, 3);
    assert.deepEqual(await fs.readFile(path.join(f.root, 'grant.json')), original);
  } finally { await f.lease.release(); }
});
test('legacy budget revisions retain CAS/idempotency without influencing reservations', async () => {
  const f = await fixture(); try {
    await f.update(0, 0); await f.update(0, 0);
    await assert.rejects(f.update(null, 0), /request-id-conflict/);
    await assert.rejects(f.update(2, 0, 'stale'), /revision-conflict/);
    assert.equal((await f.send()).slot, 1);
    await Promise.all([f.update(0, 1), f.send()]);
    const state = await f.store.state();
    assert.equal(state.attempts.length, 2); assert.equal(state.budgetAuthorization.revision, 2);
  } finally { await f.lease.release(); }
});
test('historical unlimited amendment followed by finite zero stays readable and unrestricted', async () => {
  const f = await fixture({ legacy: true }); try {
    for (let i = 0; i < 5; i++) await f.send();
    await f.update(0, 0); await f.send(); await f.lease.release();
    assert.equal((await createFullHistoryAgentStore(f.binding).state({ strict: true })).attempts.length, 6);
  } finally { await f.lease.release(); }
});
test('invalid metadata and foreign scope cannot append; cancellation still denies a new send', async () => {
  const f = await fixture(); try {
    for (const cap of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '8']) await assert.rejects(f.update(cap, 0), /budget-invalid/);
    await assert.rejects(f.store.updateBudget({ requestId: 'bad-consent', requestHash: digest('bad'), grantHash: f.grant.grantHash,
      expectedRevision: 0, maxRequests: null, consent: { ...consent, budgetMayIncreaseCharges: false } }), /budget-invalid/);
    await assert.rejects(createFullHistoryAgentStore({ ...f.binding, ownerKey: 'foreign' }).state({ strict: true }), /record-invalid/);
    await f.store.cancel(); await assert.rejects(f.send(), /cancelled/); await assert.rejects(f.update(2, 0), /cancelled/);
  } finally { await f.lease.release(); }
});
test('plans with more than 128 nodes authorize; no paid work or consent revision is fabricated', async () => {
  const f = await fixture({ nodeCount: 130 }); try {
    assert.equal((await f.store.state()).attempts.length, 0);
    assert.equal((await f.send('batch-128')).slot, 1);
    await f.lease.release(); const state = await createFullHistoryAgentStore(f.binding).state({ strict: true });
    assert.equal(state.authorization.nodeIds.length, 130); assert.equal(state.attempts.length, 1);
    assert.equal(state.budgetRevisions.length, 0);
  } finally { await f.lease.release(); }
});
test('worker ownership and expiry still stop sends; cancellation preserves in-flight usage receipts', async () => {
  const f = await fixture(); const now = Date.now; try {
    const other = createFullHistoryAgentStore(f.binding);
    await assert.rejects(other.updateBudget({ requestId: 'foreign-store', requestHash: digest('foreign'), grantHash: f.grant.grantHash,
      expectedRevision: 0, maxRequests: null, consent }), /worker-busy/);
    const intent = await f.send(); Date.now = () => now() + 86400001;
    await assert.rejects(f.update(5, 0), /authorization-expired/); await assert.rejects(f.send(), /authorization-expired/); Date.now = now;
    await f.store.cancel();
    await f.store.receipt({ schema: 'pi-full-agent-attempt-receipt.v2', attemptId: intent.attemptId, nodeId: intent.nodeId,
      slot: intent.slot, requestHash: intent.requestHash, outcome: 'unknown', sdkStopReason: 'error', providerTerminalObserved: false,
      usage: { input: 20, output: 4, totalTokens: 24 } });
    const row = (await f.store.state()).attempts[0]; assert.equal(row.receipt.outcome, 'unknown'); assert.equal(row.receipt.usage.totalTokens, 24);
  } finally { Date.now = now; await f.lease.release(); }
});
