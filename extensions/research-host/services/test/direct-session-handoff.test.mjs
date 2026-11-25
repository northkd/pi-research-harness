import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchSessionPrompt } from '../../../research-loop/src/workbench-session-tool.mjs';
import { registerWorkbenchDispatchTool } from '../../../research-loop/src/workbench-dispatch-tool.mjs';
import { buildResearchSessionInitialPrompt as installedPrompt } from '../research-session-service.mjs';
import { buildResearchSessionInitialPrompt as mirroredPrompt } from '../research-session-service.mjs';

const provenance = { role: 'msd-synthetic', stage: '2-experiment', parentSessionId: 'parent',
  charterHash: 'sha256:' + 'a'.repeat(64), adoptionId: 'adopt-' + 'b'.repeat(24), task: 'Synthetic task.' };

for (const [name, build] of [['extension', buildResearchSessionPrompt], ['installed-server', installedPrompt], ['source-mirror', mirroredPrompt]]) {
  test(`${name}: direct sessions hand evidence to parent without inventing dispatcher assignments`, () => {
    const prompt = build(provenance);
    assert.match(prompt, /direct research_session/);
    assert.match(prompt, /HANDOFF/);
    assert.doesNotMatch(prompt, /Finish an assigned task with research_dispatch report/);
    assert.doesNotMatch(prompt, /for one indivisible item record atomic/);
  });
  test(`${name}: dispatcher-managed assignments retain their real report contract`, () => {
    const prompt = build(provenance, { dispatchId: 'dispatch-test', taskId: 'material' });
    assert.match(prompt, /Finish an assigned task with research_dispatch report/);
    assert.match(prompt, /Dispatcher plan reference: dispatch-test/);
  });
  test(`${name}: long direct task retains full-brief paging and stays within startup cap`, () => {
    const prompt = build({ ...provenance, task: '研'.repeat(4000) });
    assert.ok(Buffer.byteLength(prompt) < 16 * 1024);
    assert.match(prompt, /HANDOFF/);
  });
}

function fixture({ assigned = false } = {}) {
  const calls = [], tools = new Map();
  const joined = { sessionId: 'worker', researchSession: { origin: 'research_session', depth: 1,
    parentSessionId: 'parent', rootSessionId: 'parent', dispatcherManaged: assigned, declaredTasks: 0 } };
  const snapshot = { status: 'ok', sessionId: 'worker', collaborator: true, declaredTasks: 0,
    assignment: assigned ? { status: 'running', taskId: 'material', planId: 'plan', dependencies: [] } : null,
    brief: { task: 'Original complete brief' }, plans: [], childrenPending: false };
  registerWorkbenchDispatchTool({ registerTool: tool => tools.set(tool.name, tool) }, {
    readContext: async () => joined, request: async (_ctx, params) => { calls.push(params); return snapshot; },
  });
  const ctx = { sessionManager: { getSessionId: () => 'worker' } };
  return { calls, snapshot, execute: params => tools.get('research_dispatch').execute('test', params, undefined, undefined, ctx) };
}

test('direct report refusal explains parent handoff and issues no server report mutation', async () => {
  const f = fixture();
  const reply = await f.execute({ action: 'report', status: 'completed', summary: 'Synthetic only', evidence: [] });
  assert.equal(reply.isError, true);
  assert.equal(reply.details.reportSubmitted, false);
  assert.equal(reply.details.reportMode, 'parent-handoff');
  assert.ok(f.calls.every(row => row.action === 'status'));
});

test('direct status explicitly distinguishes handoff from dispatcher reporting', async () => {
  const f = fixture();
  const reply = await f.execute({ action: 'status' });
  assert.equal(reply.details.executionMode, 'direct-worker');
  assert.equal(reply.details.reportMode, 'parent-handoff');
  assert.equal(reply.details.assignment, undefined);
});

test('managed report still submits exactly one actual report', async () => {
  const f = fixture({ assigned: true });
  await f.execute({ action: 'report', status: 'blocked', summary: 'Synthetic unresolved finding', evidence: [] });
  assert.equal(f.calls.filter(row => row.action === 'report').length, 1);
});

test('detail paging uses complete server snapshot locally and never sends unsupported API fields', async () => {
  const f = fixture();
  const reply = await f.execute({ action: 'status', view: 'detail', taskId: 'self', offset: 0 });
  assert.equal(reply.details.status, 'ok');
  assert.equal(reply.details.source, 'own-assignment');
  assert.equal(JSON.parse(reply.details.content).brief.task, 'Original complete brief');
  assert.deepEqual(f.calls, [{ action: 'status' }]);
});
