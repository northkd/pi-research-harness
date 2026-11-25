import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createResWorkflowService, createStrictModelResolver, inventoryResearch, readFullHistoryPlan, readFullHistoryBatch } from '../index.mjs';
import { FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH } from '../res-workflow/full-history-agent.mjs';

const backend = fileURLToPath(new URL('../../../research-loop', import.meta.url));
const model = { provider: 'synthetic', id: 'physical' };
const consent = { scope: 'research-files-and-normal-messages', includeUnpublished: true, analysisMode: 'snapshot-agent-v1' };
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

async function fixture(t, overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-adoption-regression-'));
  const cwd = path.join(root, 'project');
  const historyRoot = path.join(root, 'histories');
  await fs.mkdir(cwd);
  await fs.mkdir(historyRoot);
  await fs.writeFile(path.join(cwd, 'research.md'), 'Synthetic research evidence available for explicit adoption.');
  const state = { calls: 0, modelChecks: 0, fingerprint: 'configuration-one', revoked: false, owned: true, joins: [] };
  const fakeAgent = async args => {
    await args.assertScope();
    await args.assertHistoryOwnership();
    await args.onBeforeSend({ request: 1, requestBytes: 100, fingerprint: args.resolved.fingerprint });
    state.calls += 1;
    const source = args.snapshot.sources[0];
    const raw = JSON.stringify({ summary: 'Synthetic unverified import', objective: 'Evaluate the synthetic mechanism', successCriteria: ['Independent evidence reproduced'], unresolved: ['Scientific result remains unverified'], items: [{ text: 'Synthetic historical hypothesis', sourceIds: [source.id] }] });
    const at = new Date().toISOString();
    const progress = { phase: 'drafting', requests: 1, toolCalls: 2, readSources: 1, readBytes: source.bytes, startedAt: at, updatedAt: at };
    const candidate = { raw, request: 1, validation: 'valid', readSourceIds: [source.id], readReferences: [{ citationRef: source.id, sourceId: source.id }], progress, fingerprint: args.resolved.fingerprint, snapshotFingerprint: digest(args.snapshot), readRanges: [{ sourceId: source.id, totalBytes: source.bytes, ranges: [{ offsetBytes: 0, endOffsetBytes: source.bytes }] }] };
    await args.onDraftCandidate(candidate);
    await args.onProgress(progress);
    return { raw, readSourceIds: [source.id], progress, coverage: { partial: args.snapshot.sources.length > 1, readSources: 1, totalSources: args.snapshot.sources.length, completeSources: 1 } };
  };
  const deps = {
    privateDir: path.join(root, 'private'), researchLoopRoot: backend,
    history: () => [], historyRoots: () => [historyRoot],
    resolveModel: async (provider, id) => {
      state.modelChecks += 1;
      if (provider !== model.provider || id !== model.id) throw new Error('Synthetic model unavailable');
      return { ...model, fingerprint: state.fingerprint, contextWindow: 200000, maxTokens: 8192,
        model: { ...model, api: 'synthetic', contextWindow: 200000, maxTokens: 8192 }, runtime: {}, loadAgentFactory: async () => ({}) };
    },
    listModels: async () => [model], runAgent: fakeAgent,
    joinParticipant: async (_access, id, via) => { state.joins.push({ id, via }); return { sessionId: id }; },
    ...overrides,
  };
  const access = { cwd, ownerKey: JSON.stringify(['fixture', 'owner']), write: true,
    revalidate: async () => { if (state.revoked) throw new Error('synthetic admission revoked'); }, canReadHistory: async () => state.owned };
  const service = createResWorkflowService(deps);
  const services = [service];
  t.after(async () => { services.forEach(value => value.dispose()); await fs.rm(root, { recursive: true, force: true }); });
  return { root, cwd, historyRoot, state, deps, access, service,
    restart() { service.dispose(); const replacement = createResWorkflowService(deps); services.push(replacement); return replacement; },
    async addHistory(id, body = 'Synthetic normal historical note') {
      const sessionFile = path.join(historyRoot, `${id}.jsonl`);
      const entries = [{ type: 'session', version: 3, id, cwd, timestamp: '2026-10-01T00:00:00Z' },
        { type: 'message', id: `${id}-m1`, parentId: null, timestamp: '2026-10-01T00:00:01Z', message: { role: 'user', content: body } }];
      await fs.writeFile(sessionFile, entries.map(value => JSON.stringify(value)).join('\n') + '\n', { mode: 0o600 });
      return { id, cwd, sessionFile };
    },
  };
}

async function settle(service, access, id) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await service.get(access, id);
    if (!['inventory', 'analyzing'].includes(result.status)) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic adoption did not settle');
}
const create = (f, requestId, additional = {}) => f.service.create(f.access, { cwd: f.cwd, requestId, historySelection: [], ...additional });
const analyze = (f, id, requestId, additional = {}) => f.service.analyze(f.access, id, { cwd: f.cwd, requestId, model, consent, ...additional });

test('observation creates no project state and performs no model work', async t => {
  const f = await fixture(t);
  assert.equal((await f.service.snapshot(f.access)).adopted, false);
  assert.equal((await f.service.historyCandidates(f.access)).candidates.length, 0);
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.modelChecks, 0);
  await assert.rejects(fs.stat(path.join(f.cwd, '.pi')), { code: 'ENOENT' });
});

test('empty history selection freezes files only until explicit physical model consent', async t => {
  const f = await fixture(t);
  await f.addHistory('unselected', 'A SYNTHETIC HISTORY THAT IS NOT SELECTED');
  const created = await create(f, 'files-only-001');
  const job = await settle(f.service, f.access, created.id);
  assert.equal(job.status, 'awaiting-model');
  assert.ok(job.sources.length > 0);
  assert.ok(job.sources.every(source => source.kind !== 'session-message'));
  assert.equal(f.state.calls, 0);
  assert.equal(f.state.modelChecks, 0);
  await assert.rejects(fs.stat(path.join(f.cwd, '.pi/research-loop/state.json')), { code: 'ENOENT' });
});

test('missing selection, physical model or exact consent are refused before a model call', async t => {
  const f = await fixture(t);
  await assert.rejects(f.service.create(f.access, { cwd: f.cwd, requestId: 'missing-selection' }), { code: 'explicit-history-selection-required' });
  await assert.rejects(create(f, 'missing-consent', { model }), { code: 'explicit-model-and-material-consent-required' });
  await assert.rejects(create(f, 'old-consent-mode', { model, consent: { ...consent, analysisMode: undefined } }), { code: 'snapshot-agent-consent-required-refresh-and-authorize' });
  assert.equal(f.state.calls, 0);
});

test('fake analysis seals and cites the authorized snapshot, and confirmation preserves the explicit target', async t => {
  const f = await fixture(t);
  const created = await create(f, 'freeze-snapshot');
  const scanned = await settle(f.service, f.access, created.id);
  const originalSource = scanned.sources[0];
  await fs.writeFile(path.join(f.cwd, 'research.md'), 'Later content outside the authorized snapshot');
  await analyze(f, created.id, 'snapshot-analysis');
  const job = await settle(f.service, f.access, created.id);
  assert.equal(job.status, 'proposal-ready');
  assert.equal(f.state.calls, 1);
  assert.match((await f.service.source(f.access, job.id, originalSource.id)).content, /Synthetic research evidence/);
  assert.ok(job.proposal.items.every(item => item.unverified === true));
  await assert.rejects(f.service.confirm(f.access, job.id, { cwd: f.cwd, proposalHash: 'forged', objective: 'Changed', successCriteria: ['Changed'] }), { code: 'proposal-hash-or-status-conflict' });
  const confirmed = await f.service.confirm(f.access, job.id, { cwd: f.cwd, proposalHash: job.proposalHash, objective: 'User confirmed synthetic goal', successCriteria: ['User confirmed criterion'] });
  assert.equal(confirmed.status, 'confirmed');
  const snapshot = await f.service.snapshot(f.access);
  const research = JSON.parse(snapshot.research['state.json']);
  assert.equal(snapshot.adopted, true);
  assert.equal(research.charter.objective, 'User confirmed synthetic goal');
  assert.deepEqual(research.claims, []);
  assert.equal(snapshot.research['auto-run.json'], null);
  assert.equal(snapshot.research['ledger.jsonl'], null);
  assert.equal(f.state.calls, 1);
});

test('request replay and restart preserve one model execution and another owner cannot read the adoption', async t => {
  const f = await fixture(t);
  const body = { model, consent };
  const first = await create(f, 'idempotent-create', body);
  await settle(f.service, f.access, first.id);
  assert.equal((await create(f, 'idempotent-create', body)).id, first.id);
  const replacement = f.restart();
  assert.equal((await replacement.get(f.access, first.id)).status, 'proposal-ready');
  await assert.rejects(replacement.get({ ...f.access, ownerKey: 'different-owner' }, first.id), { statusCode: 404 });
  await assert.rejects(replacement.create(f.access, { cwd: f.cwd, requestId: 'idempotent-create', historySelection: [] }), { code: 'request-id-conflict' });
  assert.equal(f.state.calls, 1);
});

test('cancelled scan remains cancelled and a new request can enter immediately', async t => {
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { inventory: async options => { entered(); await gate; return inventoryResearch(options); } });
  const first = await create(f, 'cancel-inventory');
  await started;
  assert.equal((await f.service.cancel(f.access, first.id)).status, 'cancelled');
  release();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal((await f.service.get(f.access, first.id)).status, 'cancelled');
  assert.equal(f.state.calls, 0);
  const second = await create(f, 'fresh-inventory');
  assert.equal((await settle(f.service, f.access, second.id)).status, 'awaiting-model');
});

test('unknown model result remains blocked after restart and is never resent', async t => {
  const f = await fixture(t, { analysisTimeoutMs: 1500, runAgent: async args => {
    await args.onBeforeSend({ request: 1, requestBytes: 10, fingerprint: args.resolved.fingerprint });
    f.state.calls += 1;
    await new Promise(() => {});
  } });
  const created = await create(f, 'unknown-model-result', { model, consent });
  const job = await settle(f.service, f.access, created.id);
  assert.equal(job.status, 'blocked');
  assert.match(job.error, /unknown/);
  const replacement = f.restart();
  assert.equal((await replacement.get(f.access, job.id)).status, 'blocked');
  await assert.rejects(replacement.analyze(f.access, job.id, { cwd: f.cwd, requestId: 'forbidden-resend', model, consent }), { code: 'explicit-new-adoption-required' });
  assert.equal(f.state.calls, 1);
});

test('history candidate identifiers are owner-bound and include no conversation body', async t => {
  const f = await fixture(t);
  await f.addHistory('history-one', 'SYNTHETIC FULL HISTORY CONTENT');
  const listed = await f.service.historyCandidates(f.access);
  assert.equal(listed.candidates.length, 1);
  assert.equal(listed.candidates[0].sessionId, 'history-one');
  assert.equal(listed.candidates[0].registered, false);
  assert.doesNotMatch(JSON.stringify(listed), /SYNTHETIC FULL HISTORY CONTENT|sessionFile/);
  await assert.rejects(f.service.create({ ...f.access, ownerKey: 'foreign' }, { cwd: f.cwd, requestId: 'foreign-history', historySelection: [listed.candidates[0].id] }), { code: 'history-source-unavailable' });
  f.state.owned = false;
  assert.equal((await f.service.historyCandidates(f.access)).candidates.length, 0);
  assert.equal(f.state.calls, 0);
});

test('full selected history preparation is local, hash-bound and requires separate send consent', async t => {
  const f = await fixture(t);
  await f.addHistory('selected-history', 'Synthetic selected history needs full review.');
  const listed = await f.service.historyCandidates(f.access);
  const created = await f.service.create(f.access, { cwd: f.cwd, requestId: 'selected-create', historySelection: [listed.candidates[0].id] });
  assert.equal((await settle(f.service, f.access, created.id)).status, 'awaiting-model');
  const prepared = await f.service.prepareHistoryReview(f.access, created.id, { cwd: f.cwd, requestId: 'prepare-full-history', model });
  assert.equal(prepared.historyReview.status, 'prepared');
  assert.equal(prepared.historyReview.canConfirm, false);
  assert.equal(prepared.historyReview.plan.histories.length, 1);
  assert.equal(prepared.historyReview.plan.eligibleMessages, 1);
  assert.deepEqual(prepared.historyReview.plan.blockers, []);
  assert.equal(f.state.calls, 0);
  const privateDir = path.join(f.deps.privateDir, digest(f.access.ownerKey), digest(f.cwd), `${created.id}.history-review`);
  const options = { privateDir, planId: prepared.historyReview.plan.planId, expectedPlanHash: prepared.historyReview.plan.planHash,
    signal: new AbortController().signal, revalidate: f.access.revalidate };
  const plan = await readFullHistoryPlan(options);
  const node = plan.nodes.find(value => value.kind === 'batch' && value.historyId);
  const batch = await readFullHistoryBatch({ ...options, plan, nodeId: node.id });
  assert.match(JSON.stringify(batch), /Synthetic selected history needs full review/);
  await assert.rejects(f.service.analyzeHistoryReview(f.access, created.id, { cwd: f.cwd, requestId: 'mismatched-full-consent', model,
    consent: { ...consent, analysisMode: 'full-history-review-v1', planId: plan.planId, planHash: '0'.repeat(64), maxRequests: plan.nodes.length } }), { code: 'analysis-full-plan-consent-mismatch' });
  assert.equal(f.state.calls, 0);
});

test('revoked admission fences source reads, confirmation and reconnect', async t => {
  const f = await fixture(t);
  const created = await create(f, 'revoked-source', { model, consent });
  const job = await settle(f.service, f.access, created.id);
  f.state.revoked = true;
  await assert.rejects(f.service.source(f.access, job.id, job.sources[0].id));
  await assert.rejects(f.service.confirm(f.access, job.id, { cwd: f.cwd, proposalHash: job.proposalHash, objective: job.proposal.objective, successCriteria: job.proposal.successCriteria }));
  await assert.rejects(f.service.reconnect(f.access));
  assert.equal(f.state.calls, 1);
});

test('full history agent requires its exact grant and cold observations preserve unknown accounting without replay', async t => {
  let executions = 0;
  const f = await fixture(t, { runFullHistoryAgent: async args => {
    await args.assertScope();
    const node = args.plan.nodes[0];
    const previous = await args.readAttempts(node.id);
    const intent = await args.onBeforeSend({ nodeId: node.id, nodeAttempt: previous.length + 1, kind: previous.length ? 'retry-unknown' : 'initial',
      baseInputHash: digest(node), requestHash: digest([node.id, previous.length]), promptSchemaHash: FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH,
      modelFingerprint: args.resolved.fingerprint, requestBytes: 100, maxTokens: args.grant.policy.initialOutputTokens });
    executions += 1;
    await args.onReceipt({ schema: 'pi-full-agent-attempt-receipt.v2', attemptId: intent.attemptId, nodeId: node.id, slot: intent.slot,
      requestHash: intent.requestHash, outcome: 'unknown', sdkStopReason: 'error', providerTerminalObserved: false, errorCode: 'analysis-full-result-unknown' });
    return { outcome: 'awaiting-user', reason: 'result-incomplete', sources: [], checkpoints: [] };
  } });
  await f.addHistory('agent-selected-history');
  const listed = await f.service.historyCandidates(f.access);
  const created = await f.service.createAgent(f.access, { cwd: f.cwd, requestId: 'agent-local-create', historySelection: [listed.candidates[0].id], model });
  async function waitFor(service, predicate) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const job = await service.get(f.access, created.id);
      if (predicate(job)) return job;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Synthetic full-history agent did not settle');
  }
  const prepared = await waitFor(f.service, job => job.agentJob?.phase === 'awaiting-authorization' && !job.agentJob.workerActive);
  assert.equal(executions, 0);
  const request = { cwd: f.cwd, requestId: 'agent-scope-grant', model, consent: { ...consent, analysisMode: 'full-history-agent-v2', grantHash: prepared.agentJob.grant.grantHash,
    policyId: prepared.agentJob.grant.policy.id, unknownRetryMayBillAgain: true } };
  await assert.rejects(f.service.authorizeAgent(f.access, created.id, { ...request, consent: { ...request.consent, grantHash: 'forged' } }), { code: 'analysis-full-agent-grant-mismatch' });
  await f.service.authorizeAgent(f.access, created.id, request);
  const completed = await waitFor(f.service, job => job.agentJob?.phase === 'awaiting-user' && !job.agentJob.workerActive);
  assert.equal(completed.agentJob.budget.usedRequests, 1);
  assert.equal(completed.agentJob.budget.unknownRequests, 1);
  assert.equal(executions, 1);
  await f.service.authorizeAgent(f.access, created.id, request);
  assert.equal(executions, 1);
  const replacement = f.restart();
  const cold = await replacement.get(f.access, created.id);
  assert.equal(cold.agentJob.workerActive, false);
  assert.equal(cold.agentJob.budget.usedRequests, 1);
  assert.equal(cold.agentJob.budget.unknownRequests, 1);
  assert.equal(executions, 1);
  assert.equal(cold.agentJob.resumeRequired, true);
});

test('managed physical model matching preserves proxy models and hides a disabled native provider', async () => {
  const physical = { provider: 'cliproxy', id: 'anthropic/test', contextWindow: 64000, maxTokens: 8192, baseUrl: 'https://synthetic.invalid/v1', api: 'synthetic', input: ['text'] };
  const native = { ...physical, provider: 'anthropic' };
  let authenticated = true;
  let configurationHash = 'one';
  const runtime = { getModels: () => [physical, native], getPhysicalModel: (provider, id) => [physical, native].find(value => value.provider === provider && value.id === id), checkAuth: async () => authenticated, streamSimple: () => { throw new Error('No model requests allowed'); } };
  const resolver = createStrictModelResolver(async () => ({ runtime, identity: 'synthetic-sdk', configurationHash, enabledModels: ['@(!(anthropic))/**'] }));
  const first = await resolver.resolveModel('cliproxy', 'anthropic/test');
  assert.deepEqual((await resolver.listAnalysisModels()).map(value => value.provider), ['cliproxy']);
  await assert.rejects(resolver.resolveModel('anthropic', 'anthropic/test'), /unavailable/);
  await assert.rejects(resolver.resolveModel('@fast', 'anthropic/test'), /explicit/);
  configurationHash = 'two';
  assert.notEqual((await resolver.resolveModel('cliproxy', 'anthropic/test')).fingerprint, first.fingerprint);
  authenticated = false;
  await assert.rejects(resolver.resolveModel('cliproxy', 'anthropic/test'), /credential/);
});
