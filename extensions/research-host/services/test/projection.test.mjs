import test from 'node:test';
import assert from 'node:assert/strict';
import { projectDispatchContext, dispatchContextBytes, DISPATCH_CONTEXT_BYTES } from '../../../research-loop/src/dispatch-context.mjs';
import { createResearchDispatchClient, registerWorkbenchDispatchTool } from '../../../research-loop/src/workbench-dispatch-tool.mjs';

const at = '2026-11-23T12:00:00.000Z';
function snapshot() {
  return { status: 'ok', sessionId: 'lead', collaborator: false, childrenPending: true,
    decisionRequired: false, plans: [{ id: 'dispatch-actual', clientPlanId: 'client-plan', status: 'running', tasks: [
      { id: 'registered', role: 'research-worker', status: 'running', sessionId: 'child-actual', registeredAt: at },
      { id: 'requested', role: 'research-worker', status: 'running', launchedAt: at },
      { id: 'queued', role: 'research-worker', status: 'queued', waitingReason: 'capacity' },
      { id: 'uncertain', role: 'research-worker', status: 'recovery-required', error: 'research-session-spawn-outcome-unknown' },
      { id: 'lost', role: 'research-worker', status: 'blocked', processUnconfirmed: true, sessionId: 'old-child', registeredAt: at },
    ] }] };
}

for (const action of ['plan', 'delegate', 'status', 'resume']) test(`${action} exposes exact child identity and registration outcome`, () => {
  const projected = projectDispatchContext(snapshot(), { action, planId: 'client-plan' });
  const rows = new Map(projected.plans[0].tasks.map(row => [row.id, row]));
  assert.equal(projected.sessionId, 'lead');
  assert.equal(projected.plans[0].id, 'dispatch-actual');
  assert.equal(rows.get('registered').sessionId, 'child-actual');
  assert.equal(rows.get('registered').registration, 'registered');
  assert.equal(rows.get('requested').registration, 'pending');
  assert.equal(rows.get('requested').sessionId, undefined);
  assert.equal(rows.get('queued').status, 'queued');
  assert.equal(rows.get('queued').waitingReason, 'capacity');
  assert.equal(rows.get('uncertain').registration, 'unknown');
  assert.equal(rows.get('lost').registration, 'unknown');
  assert.equal(rows.get('lost').sessionId, 'old-child');
});

test('identity acknowledgements stay bounded and preserve detail hashes', () => {
  const source = snapshot();
  source.plans[0].tasks = Array.from({ length: 64 }, (_, index) => ({
    id: 'task-' + index, status: 'running', role: 'research-worker', sessionId: 'child-' + index,
    registeredAt: at, summary: 'Long synthetic summary '.repeat(1000), evidence: ['a/'.repeat(4000)],
  }));
  const first = projectDispatchContext(source, { action: 'status', view: 'detail', planId: 'client-plan', taskId: 'task-0' });
  for (const action of ['plan', 'delegate', 'status']) {
    const projection = projectDispatchContext(source, { action, planId: 'client-plan' });
    assert.ok(dispatchContextBytes(projection) <= DISPATCH_CONTEXT_BYTES);
    assert.equal(projection.counts.total, 64);
    assert.ok(projection.plans[0].tasks.length > 0);
    assert.equal(projection.plans[0].tasks.length + projection.plans[0].omittedTasks, 64);
  }
  const second = projectDispatchContext(source, { action: 'status', view: 'detail', planId: 'client-plan', taskId: 'task-0' });
  assert.equal(second.recordHash, first.recordHash);
  assert.equal(second.content, first.content);
});

test('a newly registered session invalidates unchanged-summary suppression while heartbeats stay quiet', async () => {
  let tool;
  const current = snapshot();
  current.sessionId = 'lead';
  current.plans[0].tasks = [{ id: 'one', role: 'research-worker', status: 'running' }];
  registerWorkbenchDispatchTool({ registerTool: value => { tool = value; } }, {
    readContext: async () => ({ sessionId: 'lead', charterHash: 'same', adoptionId: 'same' }),
    request: async () => structuredClone(current),
  });
  const ctx = { sessionManager: { getSessionId: () => 'lead' } };
  const call = () => tool.execute('synthetic', { action: 'status' }, undefined, undefined, ctx);
  assert.equal((await call()).details.plans[0].tasks[0].registration, 'pending');
  assert.equal((await call()).details.unchanged, true);
  Object.assign(current.plans[0].tasks[0], { sessionId: 'child-actual', registeredAt: at, lastSeenAt: at });
  const registered = (await call()).details;
  assert.equal(registered.unchanged, undefined);
  assert.equal(registered.plans[0].tasks[0].sessionId, 'child-actual');
  current.plans[0].tasks[0].lastSeenAt = '2026-11-23T12:00:01.000Z';
  const unchanged = (await call()).details;
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.sessionId, 'lead');
});

for (const changed of ['response-session', 'native-session', 'charter']) test(`dispatch transport rejects ${changed} changes during a request`, async () => {
  const context = { sessionId: 'lead', cwd: '/synthetic/project', ownerKey: 'owner', adoptionId: 'adopt', charterHash: 'charter' };
  let nativeSession = 'lead';
  const client = createResearchDispatchClient({
    readContext: async () => ({ ...context }),
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:12345', token: 'synthetic' }),
    fetchImpl: async () => {
      if (changed === 'native-session') nativeSession = 'different';
      if (changed === 'charter') context.charterHash = 'different';
      return new Response(JSON.stringify({ status: 'ok', sessionId: changed === 'response-session' ? 'different' : 'lead', plans: [] }));
    },
  });
  await assert.rejects(client({ sessionManager: { getSessionId: () => nativeSession } }, { action: 'status' }), /response-scope-changed/);
});

test('dispatch transport requires the requested plan effect in its authenticated acknowledgement', async () => {
  const ctx = { sessionManager: { getSessionId: () => 'lead' } };
  let plans = [];
  const client = createResearchDispatchClient({
    readContext: async () => ({ sessionId: 'lead', charterHash: 'charter', adoptionId: 'adopt' }),
    resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:12345', token: 'synthetic' }),
    fetchImpl: async () => new Response(JSON.stringify({ status: 'ok', sessionId: 'lead', plans })),
  });
  const request = { action: 'plan', planId: 'requested-plan', tasks: [] };
  await assert.rejects(client(ctx, request), /plan-effect-unconfirmed/);
  plans = [{ id: 'dispatch-old', clientPlanId: 'different-plan' }];
  await assert.rejects(client(ctx, request), /plan-effect-unconfirmed/);
  plans = [{ id: 'dispatch-actual', clientPlanId: request.planId }];
  assert.equal((await client(ctx, request)).plans[0].id, 'dispatch-actual');
});
