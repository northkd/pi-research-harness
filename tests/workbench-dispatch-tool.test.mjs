import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchDispatchClient, registerWorkbenchDispatchTool, RESEARCH_DISPATCH_RESPONSE_BYTES } from '../extensions/research-loop/src/workbench-dispatch-tool.mjs';
import { createResearchReceiptHandler } from '../patches/dashboard-v0.20/overlay/packages/extension/src/research-dispatch-receipts.mjs';

const context = { cwd: '/workspace', sessionManager: { getSessionId: () => 'child-one' } };
const joined = async () => ({ sessionId: 'child-one', researchSession: { parentSessionId: 'parent-one' } });
const baseSnapshot = () => ({ status: 'ok', sessionId: 'child-one', collaborator: true, plans: [], assignment: { status: 'running' }, decisionRequired: true, childrenPending: false, declaredTasks: 0 });
function fixture(initial = {}, requestOverride, readContext = joined) {
  const handlers = new Map(), calls = [], continuations = [];
  let snapshot = { ...baseSnapshot(), ...initial }, tool;
  const pi = {
    registerTool(value) { tool = value; },
    on(name, handler) { handlers.set(name, handler); },
    sendUserMessage(...args) { continuations.push(args); },
  };
  registerWorkbenchDispatchTool(pi, {
    readContext,
    request: async (_ctx, body) => { calls.push(body); return requestOverride ? requestOverride(body) : snapshot; },
  });
  return { calls, continuations, tool, set: value => { snapshot = { ...snapshot, ...value }; }, emit: (name, event = {}) => handlers.get(name)?.(event, context) };
}

test('native dispatch fixes routing to its joined session and local authenticated endpoint', async () => {
  let observed;
  const request = createResearchDispatchClient({ readContext: joined, resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:4131', token: 'test-local-token' }), fetchImpl: async (url, options) => { observed = { url, options }; return new Response(JSON.stringify(baseSnapshot())); } });
  await request(context, { action: 'status', sessionId: 'forged-parent' });
  assert.equal(observed.url.pathname, '/api/res-workflow/dispatch');
  assert.equal(JSON.parse(observed.options.body).sessionId, 'child-one');
  assert.equal(observed.options.headers['x-pi-local-token'], 'test-local-token');
  assert.equal(observed.options.redirect, 'error');
  let sent = false;
  const blocked = createResearchDispatchClient({ readContext: joined, resolveAuth: () => ({ baseUrl: 'https://external.invalid', token: 'test-local-token' }), fetchImpl: async () => { sent = true; } });
  await assert.rejects(blocked(context, { action: 'status' }), /destination-not-loopback/);
  assert.equal(sent, false);
});

test('native dispatch reads the full bounded worst-case receipt projection', async () => {
  // JSON permits escaped lone code units; exercise the byte bound rather than
  // assuming one character equals one byte. The backend string limits allow these.
  const long = '\ud800'.repeat(4000), evidence = Array.from({ length: 16 }, (_, i) => `evidence/${i}/` + '\ud800'.repeat(1000));
  const task = { id: 'one', role: 'review', task: long, stage: '3-review', summary: long, evidence, status: 'completed', dependsOn: [] };
  const reply = { ...baseSnapshot(), plans: [0, 1].map(i => ({ id: `plan${i}`, status: 'completed', tasks: Array.from({ length: 12 }, (_, j) => ({ ...task, id: String(j) })) })), assignment: { status: 'running', dependencies: Array.from({ length: 11 }, (_, i) => ({ id: String(i), summary: long, evidence })) } };
  const raw = JSON.stringify(reply);
  assert.ok(Buffer.byteLength(raw) > 4 * 1024 * 1024);
  assert.ok(Buffer.byteLength(raw) < RESEARCH_DISPATCH_RESPONSE_BYTES);
  const client = createResearchDispatchClient({ readContext: joined, resolveAuth: () => ({ baseUrl: 'http://localhost:4131', token: 'test' }), fetchImpl: async () => new Response(raw) });
  const read = await client(context, { action: 'status' });
  assert.equal(read.plans[1].tasks[11].summary, long);
  assert.deepEqual(read.assignment.dependencies[10].evidence, evidence);
  const oversized = createResearchDispatchClient({ readContext: joined, resolveAuth: () => ({ baseUrl: 'http://localhost:4131', token: 'test' }), fetchImpl: async () => new Response('{}', { headers: { 'content-length': String(RESEARCH_DISPATCH_RESPONSE_BYTES + 1) } }) });
  await assert.rejects(oversized(context, { action: 'status' }), /response-too-large/);
});

test('collaborators get three planning reads and must decide before the fourth', async () => {
  const f = fixture();
  await f.emit('before_agent_start', { prompt: 'Review these separable claims' });
  for (const toolName of ['read', 'web_search', 'grep']) assert.equal(await f.emit('tool_call', { toolName, input: {} }), undefined);
  const fourth = await f.emit('tool_call', { toolName: 'read', input: {} });
  assert.equal(fourth.block, true);
  assert.match(fourth.reason, /plan/);
  assert.equal((await f.emit('tool_call', { toolName: 'bash', input: { command: 'echo work' } })).block, true);
  f.set({ decisionRequired: false, atomicReason: 'One exact equation substitution' });
  assert.equal(await f.emit('tool_call', { toolName: 'read', input: {} }), undefined);
  assert.equal(await f.emit('tool_call', { toolName: 'bash', input: { command: 'echo work' } }), undefined);
});

test('pending children gate real research_loop execution and publication actions', async () => {
  const f = fixture({ decisionRequired: false, childrenPending: true, plans: [{ status: 'running' }] });
  for (const action of ['run', 'configure', 'stage', 'claim', 'claim-gate', 'publish', 'review-round', 'review-gate']) {
    const decision = await f.emit('tool_call', { toolName: 'research_loop', input: { action, autoRun: true } });
    assert.equal(decision?.block, true, action);
  }
  for (const action of ['status', 'log', 'report']) assert.equal(await f.emit('tool_call', { toolName: 'research_loop', input: { action } }), undefined);
  for (let i = 0; i < 5; i++) assert.equal(await f.emit('tool_call', { toolName: 'read', input: { path: 'evidence/results.json' } }), undefined);
});

test('declared multiple tasks cannot bypass execution with unplanned local work', async () => {
  const f = fixture({ decisionRequired: false, declaredTasks: 2 });
  assert.equal((await f.emit('tool_call', { toolName: 'edit', input: {} })).block, true);
  await f.emit('input', { source: 'user', text: 'Do not delegate any more work' });
  assert.equal((await f.tool.execute('call', { action: 'plan', tasks: [] }, undefined, undefined, context)).isError, true);
  assert.equal((await f.emit('tool_call', { toolName: 'research_session', input: {} })).block, true);
  assert.equal(await f.emit('tool_call', { toolName: 'ask_user', input: {} }), undefined);
});

test('known managed children fail closed when the execution ledger is unavailable', async () => {
  const f = fixture({}, async () => { throw new Error('network unavailable'); });
  assert.equal((await f.emit('tool_call', { toolName: 'write', input: {} })).block, true);
});

test('unreported final turns get two reminders then a truthful blocked receipt', async () => {
  const f = fixture({ decisionRequired: false, atomicReason: 'One indivisible check' });
  await f.emit('agent_end'); await f.emit('agent_end');
  assert.equal(f.continuations.length, 2);
  assert.equal(f.calls.filter(row => row.action === 'report').length, 0);
  await f.emit('agent_end');
  const reports = f.calls.filter(row => row.action === 'report');
  assert.equal(reports.length, 1);
  assert.equal(reports[0].status, 'blocked');
  assert.match(reports[0].summary, /no successful outcome/);
  f.set({ childrenPending: true });
  await f.emit('agent_end');
  assert.equal(f.calls.filter(row => row.action === 'report').length, 1);
  assert.equal(f.continuations.length, 2);
});

test('joined lead must decide before bulk work and cannot silently take over on service failure', async () => {
  const root = async () => ({ sessionId: 'child-one' });
  const f = fixture({ collaborator: false, assignment: null }, undefined, root);
  for (let n = 0; n < 3; n++) assert.equal(await f.emit('tool_call', { toolName: 'read' }), undefined);
  assert.equal((await f.emit('tool_call', { toolName: 'read' })).block, true);
  assert.match((await f.emit('tool_call', { toolName: 'write' })).reason, /delegate/);
  const unavailable = fixture({ collaborator: false, assignment: null }, async () => { throw new Error('service offline'); }, root);
  assert.equal((await unavailable.emit('tool_call', { toolName: 'bash', input: { command: 'perform bulk work' } })).block, true);
});

test('lead stops repeated exploration while the execution coordinator is working', async () => {
  const f = fixture({ collaborator: false, assignment: null, decisionRequired: false, childrenPending: true, plans: [{ id: 'goal', mode: 'delegate', status: 'running' }] }, undefined,
    async () => ({ sessionId: 'child-one' }));
  for (let n = 0; n < 3; n++) assert.equal(await f.emit('tool_call', { toolName: 'read' }), undefined);
  const blocked = await f.emit('tool_call', { toolName: 'read' });
  assert.equal(blocked.block, true);
  assert.match(blocked.reason, /execution coordinator/);
  assert.equal(await f.emit('tool_call', { toolName: 'ask_user' }), undefined);
});

test('delegate forwards the goal and inherited read-only constraint without projection controls', async () => {
  const f = fixture({ decisionRequired: false }, undefined, async () => ({ sessionId: 'child-one', researchSession: { parentSessionId: 'root', readOnly: true } }));
  await f.tool.execute('delegate-goal', { action: 'delegate', planId: 'goal-1', task: 'Review evidence', stage: '3-review',
    view: 'summary', refresh: true, readOnly: false }, undefined, undefined, context);
  assert.deepEqual(f.calls.at(-1), { action: 'delegate', planId: 'goal-1', task: 'Review evidence', stage: '3-review', readOnly: true });
  for (const toolName of ['write', 'edit', 'bash', 'subagent']) assert.equal((await f.emit('tool_call', { toolName })).block, true);
  assert.equal(await f.emit('tool_call', { toolName: 'read' }), undefined);
  await f.emit('input', { source: 'user', text: 'Do not delegate' });
  assert.equal((await f.tool.execute('forbidden', { action: 'delegate' }, undefined, undefined, context)).isError, true);
});

test('repeated status is compact, refresh is explicit and raw rows never leak through details', async () => {
  const f = fixture({ decisionRequired: false, plans: [{ id: 'plan-one', status: 'completed', tasks: [{ id: 'task-one', status: 'completed', task: 'UNNEEDED_TASK_BODY'.repeat(300), summary: 'Verified conclusion', evidence: ['report.md'] }] }] });
  const first = await f.tool.execute('first', { action: 'status' }, undefined, undefined, context);
  assert.ok(Buffer.byteLength(first.content[0].text) <= 8192);
  assert.ok(!JSON.stringify(first).includes('UNNEEDED_TASK_BODY'));
  const repeated = await f.tool.execute('second', { action: 'status' }, undefined, undefined, context);
  assert.equal(repeated.details.unchanged, true);
  const refreshed = await f.tool.execute('third', { action: 'status', refresh: true }, undefined, undefined, context);
  assert.equal(refreshed.details.plans[0].tasks[0].summary, 'Verified conclusion');
  const detail = await f.tool.execute('detail', { action: 'status', view: 'detail', planId: 'plan-one', taskId: 'task-one' }, undefined, undefined, context);
  assert.ok(detail.content[0].text.includes('UNNEEDED_TASK_BODY'));
  assert.ok(Buffer.byteLength(detail.content[0].text) <= 16384);
  assert.ok(!('view' in f.calls.at(-1)));
});

test('verified scope loss cannot bypass inherited read-only or lead coordination gates', async () => {
  let available = true;
  const f = fixture({}, undefined, async () => available ? { sessionId: 'child-one', researchSession: { readOnly: true } } : null);
  assert.equal(await f.emit('tool_call', { toolName: 'read' }), undefined);
  available = false;
  assert.equal((await f.emit('tool_call', { toolName: 'write' })).block, true);
  assert.equal((await f.emit('tool_call', { toolName: 'read' })).block, true);
});

test('unchanged status preserves failed and blocked assignment state', async () => {
  for (const status of ['failed', 'blocked']) {
    const f = fixture({ decisionRequired: false, assignment: { planId: 'parent', taskId: 'child', status, error: 'real-blocker' } });
    await f.tool.execute('first', { action: 'status' }, undefined, undefined, context);
    const repeated = await f.tool.execute('second', { action: 'status' }, undefined, undefined, context);
    assert.equal(repeated.details.unchanged, true);
    assert.equal(repeated.details.assignment.status, status);
    assert.equal(repeated.details.assignment.error, 'real-blocker');
  }
});

const promptId = 'research-dispatch-receipt-dispatch-' + 'a'.repeat(40);
const receipt = { type: 'send_prompt', sessionId: 'child-one', promptId, text: `[research_dispatch receipt ${promptId}] Plan completed.` };
test('receipt handoff waits for acceptance, deduplicates retries, and recovers from history', async () => {
  let release, deliveries = 0; const acks = [];
  const accepted = new Promise(resolve => { release = resolve; });
  const handler = createResearchReceiptHandler({ getSessionId: () => 'child-one', readHistory: () => [], sendAck: ack => acks.push(ack), handle: async () => { deliveries++; await accepted; return undefined; } });
  const first = handler(receipt), duplicate = handler(receipt);
  assert.equal(deliveries, 1); assert.equal(acks.length, 0);
  release(); await Promise.all([first, duplicate]);
  await handler(receipt); assert.equal(deliveries, 1); assert.ok(acks.length >= 2);
  const restarted = createResearchReceiptHandler({ getSessionId: () => 'child-one', readHistory: () => [{ message: { role: 'user', content: [{ type: 'text', text: receipt.text }] } }], sendAck: ack => acks.push(ack), handle: async () => { deliveries++; } });
  await restarted(receipt); assert.equal(deliveries, 1); assert.equal(acks.at(-1).promptId, promptId);
});

test('failed receipt handoff does not acknowledge or suppress a retry', async () => {
  let deliveries = 0; const acks = [];
  const handler = createResearchReceiptHandler({ getSessionId: () => 'child-one', readHistory: () => [], sendAck: ack => acks.push(ack), handle: async () => { deliveries++; return { type: 'command_error' }; } });
  await handler(receipt); await handler(receipt);
  assert.equal(deliveries, 2); assert.equal(acks.length, 0);
});
