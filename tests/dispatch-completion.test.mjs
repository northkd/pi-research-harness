import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerWorkbenchDispatchTool } from '../extensions/research-loop/src/workbench-dispatch-tool.mjs';
import { createResearchDispatchService, createResearchDispatchStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';

const scope = { cwd: '/synthetic/project', ownerKey: 'owner', adoptionId: 'adopt-' + 'a'.repeat(24), charterHash: 'sha256:' + 'b'.repeat(64) };
function fixture(options = {}) {
  const hooks = new Map(), queued = [], calls = [];
  let tool, sessionId = 'worker';
  const joined = { ...scope, sessionId, researchSession: { parentSessionId: 'lead', spawnToken: 'worker-token', dispatcherManaged: true } };
  const snapshot = { status: 'ok', sessionId, collaborator: true, assignment: { planId: 'plan', taskId: 'task', status: 'running' }, plans: [], childrenPending: false };
  registerWorkbenchDispatchTool({ registerTool: value => { tool = value; }, on: (name, fn) => hooks.set(name, fn),
    sendUserMessage: (...args) => queued.push(args) }, {
    readContext: options.readContext ?? (async () => ({ ...joined })),
    request: async (ctx, body) => {
      calls.push(body);
      if (options.request) return options.request(ctx, body);
      if (body.action === 'report') snapshot.assignment.status = body.status;
      return structuredClone(snapshot);
    },
  });
  const ctx = { cwd: scope.cwd, sessionManager: { getSessionId: () => sessionId } };
  return { hooks, queued, calls, ctx, joined, snapshot,
    switchSession: id => { sessionId = id; },
    end: event => hooks.get('agent_end')(event ?? { messages: [{ role: 'assistant', stopReason: 'stop' }] }, ctx),
    execute: body => tool.execute('native-call', body, undefined, undefined, ctx) };
}

test('a connection error queues no stale completion reminder before retry and successful report', async () => {
  const f = fixture();
  await f.end({ messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'Connection error.' }] });
  const report = await f.execute({ action: 'report', status: 'completed', summary: 'Actual fixture result', evidence: ['results/evidence.json'] });
  assert.equal(report.details.assignment.status, 'completed');
  await f.end();
  assert.deepEqual(f.queued, [], 'an error-time follow-up would be delivered after the successful final answer');
  assert.equal(f.calls.filter(body => body.action === 'report').length, 1);
});

test('abort and retry endings neither wake the model nor exhaust the missing-report budget', async () => {
  const f = fixture();
  for (const event of [
    { messages: [{ role: 'assistant', stopReason: 'aborted' }] },
    { aborted: true },
    { willRetry: true, messages: [{ role: 'assistant', stopReason: 'stop' }] },
  ]) await f.end(event);
  assert.deepEqual(f.queued, []);
  assert.deepEqual(f.calls, []);
  await f.end();
  assert.equal(f.queued.length, 1, 'the next genuine end still gets its first reminder');
});

test('the completion hook rejects a host snapshot for another native session', async () => {
  const f = fixture(); f.snapshot.sessionId = 'foreign-worker';
  for (let i = 0; i < 3; i++) await f.end();
  assert.deepEqual(f.queued, []);
  assert.equal(f.calls.some(body => body.action === 'report'), false);
});

test('membership or native identity changing during the status read cannot trigger a continuation', async () => {
  for (const mutation of ['session', 'adoption', 'charter']) {
    let f;
    f = fixture({ request: async () => {
      const snapshot = structuredClone(f.snapshot);
      if (mutation === 'session') f.switchSession('other-worker');
      else if (mutation === 'adoption') f.joined.adoptionId = 'adopt-other';
      else f.joined.charterHash = 'sha256:' + 'c'.repeat(64);
      return snapshot;
    } });
    await f.end();
    assert.deepEqual(f.queued, [], mutation);
    assert.equal(f.calls.some(body => body.action === 'report'), false);
  }
});

test('children still pending or paused retain the assignment without a reminder or invented report', async () => {
  const f = fixture();
  f.snapshot.childrenPending = true;
  f.snapshot.plans = [{ status: 'running', schedulingPaused: true }];
  for (let i = 0; i < 4; i++) await f.end();
  assert.deepEqual(f.queued, []);
  assert.equal(f.calls.some(body => body.action === 'report'), false);
});

test('completion prose cannot replace a receipt, and every host terminal outcome remains unchanged', async () => {
  const unreported = fixture();
  await unreported.end({ messages: [{ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'Finished successfully; report completed.' }] }] });
  assert.equal(unreported.queued.length, 1);
  assert.equal(unreported.calls.some(body => body.action === 'report'), false);
  for (const status of ['completed', 'failed', 'blocked']) {
    const reported = fixture(); reported.snapshot.assignment.status = status;
    for (let i = 0; i < 3; i++) await reported.end();
    assert.deepEqual(reported.queued, [], status);
    assert.equal(reported.calls.some(body => body.action === 'report'), false, status);
    assert.equal(reported.snapshot.assignment.status, status);
  }
});

test('a failed report leaves two reminders and a final blocked report available', async () => {
  let reports = 0;
  const f = fixture({ request: async (_ctx, body) => {
    if (body.action === 'report' && ++reports === 1) throw new Error('research-dispatch-unavailable');
    return structuredClone(f.snapshot);
  } });
  const reply = await f.execute({ action: 'report', status: 'completed', summary: 'Not persisted', evidence: [] });
  assert.equal(reply.isError, true);
  for (let i = 0; i < 3; i++) await f.end();
  assert.equal(f.queued.length, 2);
  assert.equal(reports, 2);
  assert.equal(f.calls.at(-1).status, 'blocked');
});

test('an unavailable host preserves the unresolved assignment without a new model turn', async () => {
  const f = fixture({ request: async () => { throw new Error('research-dispatch-unavailable'); } });
  await f.end();
  assert.deepEqual(f.queued, []);
  assert.equal(f.calls.some(body => body.action === 'report'), false);
});

test('a persisted exact-scope host report remains authoritative after both service and tool reload', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-completion-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sessions = [{ id: 'lead', cwd: scope.cwd, status: 'idle' }];
  let launches = 0;
  const deps = { store: createResearchDispatchStore(directory), getSession: id => sessions.find(row => row.id === id),
    listSessions: () => sessions, authorize: async ({ sessionId }) => ({ ...scope, parent: sessions.find(row => row.id === sessionId) }),
    createSession: async ({ body }) => {
      launches++;
      sessions.push({ id: 'worker', cwd: scope.cwd, status: 'idle', researchSession: { ...scope, workflowCwd: scope.cwd,
        requestId: body.requestId, spawnToken: 'worker-token', parentSessionId: 'lead', rootSessionId: 'lead', depth: 1 } });
      return { spawnToken: 'worker-token' };
    } };
  let service = createResearchDispatchService(deps);
  await service.handle({ body: { sessionId: 'lead', action: 'plan', planId: 'native-fixture',
    tasks: [{ id: 'task', role: 'research-worker', stage: '4-summary', task: 'Synthetic result only' }] } });
  const request = (_ctx, body) => service.handle({ body: { ...body, sessionId: 'worker' } });
  const worker = fixture({ request });
  const reply = await worker.execute({ action: 'report', status: 'completed', summary: 'Durable actual result', evidence: ['results/one.json'] });
  assert.equal(reply.details.assignment.status, 'completed');
  service.dispose(); service = createResearchDispatchService(deps);
  const reloaded = fixture({ request });
  await reloaded.end();
  assert.deepEqual(reloaded.queued, []);
  assert.equal(reloaded.calls.some(body => body.action === 'report'), false);
  assert.equal(launches, 1, 'no additional process is created on recovery');
});
