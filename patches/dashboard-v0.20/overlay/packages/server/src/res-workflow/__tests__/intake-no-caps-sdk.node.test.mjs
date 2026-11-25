/** Offline integration with the installed Pi 1.3 SDK; no live credentials/provider. */
import {registerHooks, stripTypeScriptTypes} from 'node:module';
import {readFileSync, existsSync, promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import path from 'node:path';
import assert from 'node:assert/strict';
import {test, after} from 'node:test';
const tree = process.env.RES_WORKFLOW_SOURCE_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = pathToFileURL(path.resolve(tree, '..') + '/').href;
registerHooks({
  resolve(s, c, next) {
    if (c.parentURL?.startsWith(prefix) && s.startsWith('.') && s.endsWith('.js')) {
      const target = new URL(s.replace(/\.js$/, '.ts'), c.parentURL);
      const alternate = path.resolve(sdkDependencies, '../packages/server/src', path.relative(path.resolve(tree, '..'), fileURLToPath(target)));
      return {url: existsSync(fileURLToPath(target)) ? target.href : pathToFileURL(alternate).href, shortCircuit: true};
    }
    return next(s, c);
  },
  load(url, c, next) {
    if (url.startsWith(prefix) && url.endsWith('.ts')) return {format: 'module', source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true};
    return next(url, c);
  },
});
let sdkDependencies;
for (let root = tree; root !== path.dirname(root); root = path.dirname(root)) {
  sdkDependencies = [path.join(root, 'node_modules'), path.join(root, '.runtime/dashboard-source/node_modules')]
    .find(candidate => existsSync(path.join(candidate, '@earendil-works/pi-agent-core/dist/index.js')));
  if (sdkDependencies) break;
}
assert.ok(sdkDependencies, 'install the pinned Dashboard/Pi SDK dependencies before this integration test');
assert.equal(JSON.parse(readFileSync(path.join(sdkDependencies, '@earendil-works/pi-agent-core/package.json'), 'utf8')).version, '1.3.0');
const {Agent} = await import(pathToFileURL(path.join(sdkDependencies, '@earendil-works/pi-agent-core/dist/index.js')).href);
const {createAssistantMessageEventStream} = await import(pathToFileURL(path.join(sdkDependencies, '@earendil-works/pi-ai/dist/index.js')).href);
const {runReadonlyAdoptionAgent} = await import(pathToFileURL(path.join(tree, 'analysis-agent.ts')).href);
const {runFullHistoryAgent, FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH} = await import(pathToFileURL(path.join(tree, 'full-history-agent.ts')).href);
const {createFullHistoryAgentStore} = await import(pathToFileURL(path.join(tree, 'full-history-agent-store.ts')).href);
const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const stage = await fs.mkdtemp(path.join(tmpdir(), 'intake-no-caps-sdk-'));
const fetchBefore = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => {networkAttempts++; throw Error('network forbidden in offline SDK regression');};
after(async () => {globalThis.fetch = fetchBefore; await fs.rm(stage, {recursive: true, force: true}); assert.equal(networkAttempts, 0);});
const physical = {provider: 'synthetic', id: 'physical', api: 'openai-completions', baseUrl: 'https://synthetic.invalid',
  reasoning: false, input: ['text'], contextWindow: 1_000_000, maxTokens: 8192, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}};
const factory = {createAgent: options => new Agent(options), createEventStream: createAssistantMessageEventStream};
const resultMessage = (content, stopReason = 'stop') => ({role: 'assistant', content, api: physical.api, provider: physical.provider, model: physical.id,
  usage: {input: 10, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 12, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, stopReason, timestamp: Date.now()});
const proposal = sourceId => JSON.stringify({summary: 'Synthetic reviewed source', objective: 'Verify the fixture', successCriteria: ['Keep provenance'],
  unresolved: ['Synthetic material remains unverified'], items: [{text: 'Observed fixture text', sourceIds: [sourceId]}]});
const noOp = async () => {};
const resolvedFor = runtime => ({provider: physical.provider, id: physical.id, api: physical.api, baseUrl: physical.baseUrl,
  fingerprint: 'synthetic-fingerprint', contextWindow: physical.contextWindow, maxTokens: physical.maxTokens,
  model: physical, runtime, agentFactory: factory});

test('actual SDK reads 40 pages over 9 model requests and more than 128 KiB without hidden quotas', async () => {
  const body = 'q'.repeat(40 * 4096), source = {id: 'src-fixture', kind: 'file', label: 'Synthetic fixture',
    sha256: digest(body), bytes: Buffer.byteLength(body), incomplete: false, unverified: true};
  const intents = [], drafts = [];
  let calls = 0;
  const runtime = {async *streamSimple() {
    const call = calls++;
    const content = call < 8 ? Array.from({length: 5}, (_, i) => ({type: 'toolCall', id: `read-${call}-${i}`, name: 'read_source',
      arguments: {sourceId: source.id, offsetBytes: (call * 5 + i) * 4096, limitBytes: 4096}})) : [{type: 'text', text: proposal('R001')}];
    const message = resultMessage(content, call < 8 ? 'toolUse' : 'stop');
    yield {type: 'done', reason: message.stopReason, message};
  }};
  const resolved = resolvedFor(runtime);
  const result = await runReadonlyAdoptionAgent({resolved, snapshot: {sources: [source], content: {[source.id]: body}, partial: false,
    skipped: [], progress: {files: 1, sessions: 0, bytes: body.length}}, signal: new AbortController().signal,
    assertScope: noOp, assertHistoryOwnership: noOp, resolveCurrentModel: async () => resolved,
    onBeforeSend: async intent => {intents.push(intent);}, onDraftCandidate: async draft => {drafts.push(draft);}});
  assert.equal(calls, 9); assert.equal(result.progress.requests, 9); assert.equal(result.progress.toolCalls, 40);
  assert.ok(result.progress.readBytes > 128 * 1024); assert.equal(result.coverage.completeSources, 1);
  assert.equal(result.coverage.partial, false); assert.equal(drafts.length, 1); assert.equal(drafts[0].validation, 'valid');
  assert.deepEqual(intents.map(intent => intent.request), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test('actual SDK still rejects physical context overflow before a provider request', async () => {
  let calls = 0;
  const resolved = resolvedFor({async *streamSimple() {calls++; throw Error('should not dispatch');}});
  resolved.contextWindow = 1; resolved.model = {...physical, contextWindow: 1};
  await assert.rejects(runReadonlyAdoptionAgent({resolved, snapshot: {sources: [], content: {}, partial: false, skipped: [], progress: {files: 0, sessions: 0, bytes: 0}},
    signal: new AbortController().signal, assertScope: noOp, assertHistoryOwnership: noOp, resolveCurrentModel: async () => resolved,
    onBeforeSend: noOp, onDraftCandidate: noOp}), /model-context-budget-exceeded/);
  assert.equal(calls, 0);
});

for (const legacyCap of [undefined, 0]) test(`actual SDK completes repeated repairs beyond old per-node/grant limits with cap ${String(legacyCap)}`, async () => {
  const root = await fs.mkdtemp(path.join(stage, 'job-')); await fs.chmod(root, 0o700);
  const body = 'Synthetic normal conversation', source = {id: 'src-history', kind: 'session-message', label: 'Synthetic history',
    sha256: digest(body), bytes: body.length, incomplete: false, unverified: true};
  const prompt = JSON.stringify({sources: [{id: source.id, text: body}]});
  const nodes = [{id: 'batch-0', kind: 'batch', inputNodeIds: [], sourceIds: [source.id], materialHash: digest(prompt)},
    {id: 'final-0', kind: 'final', inputNodeIds: ['batch-0'], sourceIds: [source.id]}];
  const plan = {planId: 'hplan-' + 'b'.repeat(24), planHash: 'c'.repeat(64), model: {...physical, fingerprint: 'synthetic-fingerprint'}, maxRequests: 2, nodes};
  const grant = {analysisMode: 'full-history-agent-v2', grantHash: 'd'.repeat(64), materialPlanId: plan.planId, materialPlanHash: plan.planHash,
    model: {provider: physical.provider, id: physical.id}, historySelection: ['synthetic'], baseRequests: 2, retryReserve: 1, maxRequests: 3,
    policy: {id: 'bounded-intake-v2', maxNodeAttempts: 3, maxJsonRepairsPerNode: 1, maxUnknownRetriesPerNode: 1, maxLengthEscalationsPerNode: 1,
      unknownRetryMayBillAgain: true, grantLifetimeMs: 86400000, initialOutputTokens: 4096, maxOutputTokens: 8192}};
  const binding = {root, jobId: 'adopt-' + 'a'.repeat(24), ownerKey: 'synthetic-owner', cwd: '/synthetic/project'};
  const store = createFullHistoryAgentStore(binding), now = Date.now();
  await store.authorize({grant, modelFingerprint: plan.model.fingerprint, requestId: 'synthetic-authorize', requestHash: digest('authorize'),
    authorizedAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), nodeIds: nodes.map(node => node.id),
    promptSchemaHash: FULL_HISTORY_AGENT_PROMPT_SCHEMA_HASH, ...(legacyCap === undefined ? {} : {initialBudget: {maxRequests: legacyCap,
      consent: {scope: 'this-job', budgetMayIncreaseCharges: true, unknownRetryMayBillAgain: true}}})});
  const before = await fs.readFile(path.join(root, 'grant.json'));
  let calls = 0;
  const runtime = {async *streamSimple(_model, context) {
    const content = context.messages.findLast(message => message.role === 'user').content;
    const input = JSON.parse(typeof content === 'string' ? content : content.map(part => part.text ?? '').join(''));
    calls++;
    const raw = calls <= 4 ? '{"wrongSchema":true}' : input.kind === 'final' ? proposal(source.id) : JSON.stringify({summary: 'Synthetic summary', sourceIds: [source.id]});
    const message = resultMessage([{type: 'text', text: raw}]); yield {type: 'done', reason: 'stop', message};
  }};
  const resolved = resolvedFor(runtime), lease = await store.acquire();
  try {
    const result = await runFullHistoryAgent({jobId: binding.jobId, workerEpoch: lease.epoch, grant, plan, resolved,
      signal: new AbortController().signal, getBudgetAuthorization: () => store.getBudgetAuthorization(),
      assertScope: () => lease.assertCurrent(), assertHistoryOwnership: noOp, resolveCurrentModel: async () => resolved,
      readBatch: async () => ({prompt, sources: [source]}), readAttempts: nodeId => store.attempts(nodeId), readCheckpoint: nodeId => store.readCheckpoint(nodeId),
      onBeforeSend: draft => store.beforeSend(draft, lease), onReceipt: receipt => store.receipt(receipt), onCheckpoint: checkpoint => store.checkpoint(checkpoint), onProgress: noOp});
    assert.equal(result.outcome, 'complete'); assert.equal(calls, 6); assert.equal(result.checkpoints.length, 2);
    const state = await store.state({strict: true}); assert.equal(state.attempts.filter(row => row.intent.nodeId === 'batch-0').length, 5);
    assert.equal(state.attempts.reduce((total, row) => total + row.receipt.usage.totalTokens, 0), 72);
    assert.deepEqual(await fs.readFile(path.join(root, 'grant.json')), before);
    assert.equal(state.budgetRevisions.length, legacyCap === undefined ? 0 : 1);
  } finally {await lease.release();}
});

test('material packing and cold plan read accept more than 128 planned requests', async () => {
  const {prepareFullHistoryMaterial, readFullHistoryPlan} = await import(pathToFileURL(path.join(tree, 'full-history-material.ts')).href);
  const cwd = path.join(stage, 'material-project'), privateDir = path.join(stage, 'material-private');
  await fs.mkdir(cwd); await fs.mkdir(privateDir, {mode: 0o700});
  const sessionFile = path.join(stage, 'synthetic-history.jsonl'), sessionId = 'synthetic-history';
  await fs.writeFile(sessionFile, JSON.stringify({type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date().toISOString()}) + '\n' +
    JSON.stringify({type: 'message', id: 'entry-0', parentId: null, timestamp: new Date().toISOString(), message: {role: 'user', content: [{type: 'text', text: 'Synthetic authorized normal text.'}], timestamp: Date.now()}}) + '\n');
  const body = 'p'.repeat(128 * 1024), snapshotSources = Array.from({length: 100}, (_, i) => ({id: `src-snapshot-${i}`, kind: 'file', label: `Fixture ${i}`,
    path: `fixture-${i}.txt`, sha256: digest(body), bytes: body.length, incomplete: false, unverified: true}));
  const signal = new AbortController().signal;
  const prepared = await prepareFullHistoryMaterial({cwd, privateDir, selectedHistories: [{id: 'hist-fixture', sessionId, kind: 'local'}],
    historyBindings: [{id: sessionId, cwd, sessionFile}], model: {...physical, fingerprint: 'synthetic-fingerprint'},
    snapshotSources, snapshotContent: Object.fromEntries(snapshotSources.map(source => [source.id, body])), snapshotFingerprint: digest('synthetic-snapshot'),
    signal, revalidate: noOp, canReadHistory: async () => true});
  assert.deepEqual(prepared.publicPlan.blockers, []);
  assert.ok(prepared.privatePlan.nodes.length > 128, `expected more than 128 requests, got ${prepared.privatePlan.nodes.length}`);
  const reopened = await readFullHistoryPlan({privateDir, planId: prepared.privatePlan.planId, expectedPlanHash: prepared.privatePlan.planHash,
    signal, revalidate: noOp});
  assert.equal(reopened.nodes.length, prepared.privatePlan.nodes.length);
  assert.equal(reopened.maxRequests, reopened.nodes.length);
});
