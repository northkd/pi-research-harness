import test from 'node:test';
import assert from 'node:assert/strict';
import { registerWorkbenchCommunicationTool, createResearchCommunicationClient } from '../../../research-loop/src/workbench-communication-tool.mjs';
import { registerWorkbenchDispatchTool } from '../../../research-loop/src/workbench-dispatch-tool.mjs';

function toolFixture(request) {
  const tools = new Map(), hooks = new Map(), wakes = [];
  registerWorkbenchCommunicationTool({ registerTool: tool => tools.set(tool.name, tool), on: (name, fn) => hooks.set(name, fn), sendUserMessage: (...args) => wakes.push(args) }, { request });
  return { tools, hooks, wakes };
}
test('recovery wakes unprocessed durable messages after restart/turn end and stops bounded reminders', async () => {
  const inbox = { status: 'ok', sessionId: 'lead', messages: [{ id: 'message-test', processed: false }] };
  const f = toolFixture(async () => inbox);
  await f.hooks.get('session_start')({}, {});
  await f.hooks.get('agent_end')({}, {});
  await f.hooks.get('agent_end')({}, {});
  assert.equal(f.wakes.length, 2);
  inbox.messages[0].processed = true;
  await f.hooks.get('agent_end')({}, {});
  assert.equal(f.wakes.length, 2);
});
test('explicit user abort does not auto-resume messages', async () => {
  const f = toolFixture(async () => ({ sessionId: 'lead', messages: [{ id: 'one', processed: false }] }));
  await f.hooks.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'aborted' }] }, {});
  assert.equal(f.wakes.length, 0);
});
test('recovery ignores routine progress and partial results even from an older host', async () => {
  const f = toolFixture(async () => ({ sessionId: 'lead', messages: [
    { id: 'progress', kind: 'progress', processed: false },
    { id: 'checkpoint', kind: 'result', status: 'partial', processed: false },
  ] }));
  await f.hooks.get('session_start')({}, {});
  await f.hooks.get('agent_end')({}, {});
  assert.equal(f.wakes.length, 0);
});
test('an interrupted or retrying turn cannot queue a stale inbox reminder', async () => {
  const f = toolFixture(async () => ({ sessionId: 'lead', messages: [{ id: 'request', kind: 'request', processed: false }] }));
  await f.hooks.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'error' }] }, {});
  await f.hooks.get('agent_end')({ willRetry: true, messages: [{ role: 'assistant', stopReason: 'stop' }] }, {});
  assert.equal(f.wakes.length, 0);
  await f.hooks.get('agent_end')({ messages: [{ role: 'assistant', stopReason: 'stop' }] }, {});
  assert.equal(f.wakes.length, 1);
});
test('an already queued notification or user turn does not get a duplicate recovery wakeup', async () => {
  let reads = 0;
  const f = toolFixture(async () => { reads++; return { sessionId: 'lead', messages: [{ id: 'result', kind: 'result', status: 'completed', processed: false }] }; });
  await f.hooks.get('agent_end')({}, { hasPendingMessages: () => true });
  assert.equal(reads, 0); assert.equal(f.wakes.length, 0);
  await f.hooks.get('agent_end')({}, { hasPendingMessages: () => false });
  assert.equal(f.wakes.length, 1, 'unhandled delivery still recovers once the queue is clear');
});
test('a received and acknowledged request still recovers until an actual reply resolves it', async () => {
  const f = toolFixture(async () => ({ sessionId: 'lead', messages: [{ id: 'waiting-request', kind: 'request', processed: true, resolved: false }] }));
  await f.hooks.get('session_start')({}, {});
  assert.equal(f.wakes.length, 1);
});
test('native communication derives caller identity; tool parameters cannot impersonate another session', async () => {
  let sent;
  const client = createResearchCommunicationClient({ readContext: async () => ({ sessionId: 'actual' }),
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'synthetic' }),
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify({ status: 'ok' })); } });
  const ctx = { sessionManager: { getSessionId: () => 'actual' } };
  await assert.rejects(client(ctx, { action: 'pending', sessionId: 'victim' }), /unknown-field/);
  await client(ctx, { action: 'pending' }); assert.equal(sent.sessionId, 'actual');
});
test('lead confirms initial plan once; authorized branch decomposition needs no repeated user confirmation', async () => {
  const tools = new Map(), calls = []; let confirmed = 0;
  const context = { sessionId: 'lead', charterHash: 'hash', adoptionId: 'adoption' };
  registerWorkbenchDispatchTool({ registerTool: tool => tools.set(tool.name, tool) }, {
    readContext: async () => context, confirmInitialPlan: async () => { confirmed++; return true; },
    request: async (_ctx, body) => { calls.push(body); return { status: 'ok', plans: [], decisionRequired: false }; },
  });
  const ctx = { sessionManager: { getSessionId: () => context.sessionId } };
  const execute = params => tools.get('research_dispatch').execute('test', params, undefined, undefined, ctx);
  const plan = { action: 'plan', planId: 'initial', tasks: [{ id: 'one', role: 'research-worker', task: 'Question', stage: '1-idea' }] };
  await execute(plan); await execute(plan); assert.equal(confirmed, 1);
  await execute({ ...plan, planId: 'next-material', tasks: [{ ...plan.tasks[0], task: 'Next in-scope material' }] });
  assert.equal(confirmed, 1, 'a later in-scope plan reuses the initial goal approval');
  context.sessionId = 'branch'; context.researchSession = { parentSessionId: 'lead' };
  await execute({ ...plan, planId: 'branch-next' }); assert.equal(confirmed, 1);
  assert.equal(calls.filter(row => row.action === 'plan').length, 4);
});

test('goal approval survives extension reload and changes with the charter or adoption', async () => {
  const entries = [], context = { sessionId: 'lead', charterHash: 'hash-one', adoptionId: 'adoption-one' };
  let confirmed = 0, tool;
  const ctx = { sessionManager: { getSessionId: () => 'lead', getEntries: () => entries } };
  const register = () => registerWorkbenchDispatchTool({ registerTool: value => { tool = value; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }, {
    readContext: async () => ({ ...context }), confirmInitialPlan: async () => { confirmed++; return true; },
    request: async () => ({ status: 'ok', plans: [] }),
  });
  const execute = planId => tool.execute('test', { action: 'plan', planId, tasks: [] }, undefined, undefined, ctx);
  register(); await execute('initial'); register(); await execute('after-reload');
  assert.equal(confirmed, 1); assert.equal(entries.length, 1);
  context.charterHash = 'hash-two'; await execute('new-goal'); assert.equal(confirmed, 2);
  context.adoptionId = 'adoption-two'; await execute('new-adoption'); assert.equal(confirmed, 3);
});

test('an already approved native plan is recovered only against the current host scope', async () => {
  for (const [matches, hostSession, nativeSuccess] of [[true, 'lead', true], [false, 'lead', true], [true, 'foreign', true], [true, 'lead', false]]) {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: 'native-call', name: 'research_dispatch', arguments: { action: 'plan', planId: 'original' } }] } },
      { type: 'message', message: { role: 'toolResult', toolName: 'research_dispatch', toolCallId: 'native-call', isError: !nativeSuccess,
        details: { status: 'ok', action: 'plan' } } },
    ];
    let tool, confirmations = 0, launches = 0;
    registerWorkbenchDispatchTool({ registerTool: value => { tool = value; },
      appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) }, {
      readContext: async () => ({ sessionId: 'lead', charterHash: 'hash', adoptionId: 'adoption' }),
      confirmInitialPlan: async () => { confirmations++; return true; },
      request: async (_ctx, body) => {
        if (body.action === 'status') return { status: 'ok', sessionId: hostSession, plans: matches ? [{ clientPlanId: 'original' }] : [] };
        launches++; return { status: 'ok', plans: [] };
      },
    });
    await tool.execute('test', { action: 'plan', planId: 'next', tasks: [] }, undefined, undefined,
      { sessionManager: { getSessionId: () => 'lead', getEntries: () => entries } });
    assert.equal(confirmations, matches && hostSession === 'lead' && nativeSuccess ? 0 : 1); assert.equal(launches, 1);
  }
});

test('a goal changed during confirmation gets neither a reusable approval nor a launch', async () => {
  const context = { sessionId: 'lead', charterHash: 'before', adoptionId: 'adopt' }, entries = [];
  let tool, launches = 0;
  registerWorkbenchDispatchTool({ registerTool: value => { tool = value; }, appendEntry: (...entry) => entries.push(entry) }, {
    readContext: async () => ({ ...context }),
    confirmInitialPlan: async () => { context.charterHash = 'after'; return true; },
    request: async () => { launches++; return { status: 'ok' }; },
  });
  const result = await tool.execute('test', { action: 'plan', planId: 'initial', tasks: [] }, undefined, undefined,
    { sessionManager: { getSessionId: () => 'lead', getEntries: () => [] } });
  assert.equal(result.details.error, 'research-dispatch-approval-scope-changed');
  assert.equal(launches, 0); assert.deepEqual(entries, []);
});
test('initial plan without a native confirmation channel does not dispatch', async () => {
  let tool, calls = 0;
  registerWorkbenchDispatchTool({ registerTool: value => { tool = value; } }, { readContext: async () => ({ sessionId: 'lead' }), request: async () => { calls++; } });
  const reply = await tool.execute('test', { action: 'plan', planId: 'first', tasks: [] }, undefined, undefined, { sessionManager: { getSessionId: () => 'lead' } });
  assert.equal(reply.details.error, 'research-dispatch-initial-plan-confirmation-required'); assert.equal(calls, 0);
});

test('verified clean formal child uses native graceful shutdown only after settled', async () => {
  let shutdowns = 0;
  const binding = { sessionId: 'worker', adoptionId: 'adopt-' + 'a'.repeat(24), charterHash: 'sha256:' + 'b'.repeat(64),
    researchSession: { origin: 'research_session', parentSessionId: 'lead' } };
  const reportReceipt = { id: 'report-native', sessionId: 'worker', parentSessionId: 'lead',
    adoptionId: binding.adoptionId, charterHash: binding.charterHash, status: 'completed', persisted: true };
  const hooks = new Map(); let tool;
  registerWorkbenchCommunicationTool({ registerTool: value => { tool = value; }, on: (name, fn) => hooks.set(name, fn) }, {
    request: async () => ({ status: 'ok', reportReceipt }), readContext: async () => binding,
    retirementProbe: async ({ scope }) => ({ ...scope, complete: true, observedAt: Date.now(), backgroundTasks: [], subagents: [],
      formalChildren: [], supervisorRequests: [], descendantProcesses: [], heldLocks: [], unknownTools: [] }),
  });
  const ctx = { cwd: '/synthetic/project', sessionManager: { getSessionId: () => 'worker', getEntries: () => [] },
    isIdle: () => true, hasPendingMessages: () => false, shutdown: () => { shutdowns++; } };
  await tool.execute('report-tool', { action: 'report', requestId: 'actual-result', status: 'completed', summary: 'Scoped work finished' }, undefined, undefined, ctx);
  assert.equal(shutdowns, 0);
  await hooks.get('agent_settled')({}, ctx);
  assert.equal(shutdowns, 1);
  await hooks.get('agent_settled')({}, ctx);
  assert.equal(shutdowns, 1);
});
