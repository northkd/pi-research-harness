// Synthetic service/client boundary tests. No process, network provider or model is started.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildResearchSessionPrompt, createResearchSessionTool } from '../extensions/research-loop/src/workbench-session-tool.mjs';
import { buildResearchSessionInitialPrompt, createResearchSessionService, RESEARCH_SESSION_INITIAL_PROMPT_BYTES } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';
import * as shared from '../patches/dashboard-v0.20/overlay/packages/shared/src/research-session.ts';

const CHARTER = 'sha256:' + 'a'.repeat(64), ADOPTION = 'adopt-' + 'b'.repeat(24);
const OWNER = { iss: 'synthetic', sub: 'operator' };
const provenance = (extra = {}) => ({
  schema: 'pi-research-session.v1', parentSessionId: 'parent', creatorSessionId: 'parent', creatorAgent: 'research_session',
  role: 'researcher', task: 'Inspect the synthetic evidence', stage: '2-experiment', charterHash: CHARTER, adoptionId: ADOPTION,
  workflowCwd: '/workspace/synthetic', spawnToken: 'synthetic-spawn-token', requestId: 'synthetic-request', rootSessionId: 'parent', depth: 1,
  createdAt: '2026-11-06T00:00:00.000Z', origin: 'research_session', relation: 'dispatch', ...extra,
});
function fixture({ inheritedReadOnly = false } = {}) {
  const parent = { id: 'parent', cwd: '/workspace/synthetic', principalOwner: OWNER, status: 'idle',
    ...(inheritedReadOnly ? { researchSession: provenance({ parentSessionId: 'root', creatorSessionId: 'root', rootSessionId: 'root', readOnly: true }) } : {}) };
  const rows = [parent, ...(inheritedReadOnly ? [{ id: 'root', cwd: parent.cwd, principalOwner: OWNER, status: 'idle' }] : [])];
  const refs = new Map(), prompts = new Map(), spawns = [];
  let sequence = 0;
  const deps = {
    getSession: id => rows.find(row => row.id === id), listSessions: () => rows,
    verifyParent: async () => ({ cwd: parent.cwd, charterHash: CHARTER, adoptionId: ADOPTION, ownerKey: JSON.stringify([OWNER.iss, OWNER.sub]) }),
    prepareSpawn: async (_cwd, _identity, verified) => ({ resWorkflow: { canonicalCwd: parent.cwd }, researchSession: verified.researchSession }),
    pendingPluginRefRegistry: { file: (token, ref) => { refs.set(token, ref); return true; }, remove: token => refs.delete(token) },
    pendingPrincipalOwnerRegistry: { file: () => true, remove: () => {} },
    initialPrompts: { enqueue: (_cwd, prompt, token) => {
      if (Buffer.byteLength(prompt) > 16 * 1024 || prompt.includes('\0')) return false;
      prompts.set(token, prompt); return true;
    }, remove: (_cwd, token) => prompts.delete(token) },
    spawn: async (cwd, options) => { spawns.push({ cwd, ...options }); return { success: true }; },
    isLocalOperator: () => false, availableMemory: () => 8 * 1024 ** 3, mintToken: () => 'synthetic-spawn-' + (++sequence),
  };
  const service = createResearchSessionService(deps);
  const request = (body = {}, taskContext) => ({ principal: OWNER, body: { parentSessionId: parent.id, role: 'researcher', task: 'Inspect the evidence', stage: '2-experiment', requestId: 'synthetic-request', ...body }, ...(taskContext ? { taskContext } : {}) });
  return { parent, rows, refs, prompts, spawns, deps, service, request };
}
const nativeContext = (readOnly = false) => ({ sessionId: 'parent', charterHash: CHARTER, ...(readOnly ? { researchSession: { readOnly: true } } : {}) });
const toolContext = { cwd: '/workspace/synthetic', sessionManager: { getSessionId: () => 'parent' } };

test('fresh coordinator brief assigns planning, scheduling, independent verification and compact parent reporting', () => {
  const coordinator = provenance({ role: 'research-coordinator', readOnly: true });
  const brief = buildResearchSessionInitialPrompt(coordinator);
  for (const expected of ['fresh Pi session', 'decompose', 'schedule specialists', 'follow progress', 'independent verification', 'aggregate', 'Send the lead only', 'READ-ONLY assignment']) assert.ok(brief.includes(expected), expected);
  assert.equal(buildResearchSessionPrompt(coordinator), brief);
  assert.equal(shared.buildResearchSessionInitialPrompt(coordinator), brief);
  assert.ok(buildResearchSessionInitialPrompt(provenance()).includes('Complete only this assigned scope'));
  assert.equal(shared.projectResearchSession({ researchSession: coordinator }).provenance.readOnly, true);
  assert.equal(shared.isResearchSessionProvenance({ ...coordinator, readOnly: false }), false);
});

test('maximum Chinese task and long dependency receipts fit the unchanged startup limit without inlining bodies', () => {
  const row = provenance({ role: 'research-coordinator', task: '研'.repeat(4000), readOnly: true, parentSessionId: 'p'.repeat(128), creatorSessionId: 'p'.repeat(128) });
  const taskContext = { dispatchId: 'd'.repeat(128), taskId: 't'.repeat(128), prerequisiteResults: Array.from({ length: 12 }, (_, i) => ({
    id: String(i).padStart(2, '0') + 'r'.repeat(126), summary: 'PRIVATE_SUMMARY_' + '结'.repeat(3900), evidence: Array.from({ length: 16 }, (_, j) => `PRIVATE_EVIDENCE_${j}/` + '路'.repeat(1000)),
  })) };
  const brief = buildResearchSessionInitialPrompt(row, taskContext);
  assert.equal(RESEARCH_SESSION_INITIAL_PROMPT_BYTES, 16 * 1024);
  assert.ok(Buffer.byteLength(brief) < 16 * 1024);
  assert.ok(brief.includes(row.task) || brief.includes('Task brief truncated'));
  assert.ok(brief.includes(taskContext.dispatchId));
  assert.ok(brief.includes(taskContext.prerequisiteResults[11].id));
  assert.equal(brief.includes('PRIVATE_SUMMARY_'), false);
  assert.equal(brief.includes('PRIVATE_EVIDENCE_'), false);
  assert.equal(buildResearchSessionPrompt(row, taskContext), brief);
  assert.equal(shared.buildResearchSessionInitialPrompt(row, taskContext), brief);
});

test('defensive overflow clipping preserves explicit constraints and requires the complete original task before work', () => {
  // Exercise the exported formatter's budget independently of today's 4000-character admission limit.
  const row = provenance({ task: '目'.repeat(20000) + '最后的约束必须保留在原始记录', readOnly: true });
  const brief = buildResearchSessionInitialPrompt(row);
  assert.ok(Buffer.byteLength(brief) < 16 * 1024);
  assert.ok(brief.includes('READ-ONLY assignment'));
  assert.ok(brief.includes('Task brief truncated'));
  assert.ok(brief.includes('Before ANY execution'));
  assert.ok(brief.includes('taskId="self", offset=0'));
  assert.ok(brief.includes('read every task page'));
  assert.ok(row.task.endsWith('最后的约束必须保留在原始记录'));
  assert.equal(brief.includes('\ufffd'), false, 'UTF-8 clipping preserves complete Unicode code points');
});

test('native create succeeds for large declared task input and returns a compact receipt while retaining full metadata', async () => {
  const f = fixture();
  const tasks = Array.from({ length: 12 }, (_, i) => ({ id: 'task-' + i, role: 'researcher', task: '任'.repeat(4000), stage: '2-experiment' }));
  const tool = createResearchSessionTool({}, {
    readContext: () => nativeContext(), resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-local-auth' }),
    requestId: () => 'synthetic-request',
    fetchImpl: async (_url, init) => new Response(JSON.stringify(await f.service.create({ body: JSON.parse(init.body), principal: OWNER })), { headers: { 'content-type': 'application/json' } }),
  });
  const result = await tool.execute('call', { role: 'research-coordinator', task: 'Coordinate these declared jobs', tasks, stage: '2-experiment' }, undefined, undefined, toolContext);
  assert.equal(result.details.status, 'spawned');
  assert.equal(f.spawns.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(result)) < 4096);
  assert.equal('provenance' in result.details, false);
  assert.equal('tasks' in result.details, false);
  assert.equal(result.details.rootSessionId, 'parent');
  assert.equal(result.details.depth, 1);
  const saved = f.refs.get(result.details.spawnToken).researchSession;
  assert.deepEqual(saved.tasks, tasks.map(task => ({ ...task, dependsOn: [] })));
  assert.ok(Buffer.byteLength(JSON.stringify(saved)) > 64 * 1024, 'the prior full-provenance reply would exceed the unchanged client cap');
  assert.ok(Buffer.byteLength(f.prompts.get(result.details.spawnToken)) < 16 * 1024);
});

test('session service routes dependency references without copying their summaries or evidence into the first prompt', async () => {
  const f = fixture();
  const taskContext = { dispatchId: 'dispatch-test', taskId: 'review', prerequisiteResults: [{ id: 'baseline', summary: 'raw-output-'.repeat(2000), evidence: ['private-material'] }] };
  const reply = await f.service.create(f.request({ task: '研'.repeat(4000) }, taskContext));
  const brief = f.prompts.get(reply.spawnToken), saved = f.refs.get(reply.spawnToken).researchSession;
  assert.ok(brief.includes('baseline'));
  assert.equal(brief.includes('raw-output-'), false);
  assert.equal(brief.includes('private-material'), false);
  assert.equal(saved.task, '研'.repeat(4000));
  assert.equal(saved.dispatchId, 'dispatch-test');
  assert.equal(saved.taskId, 'review');
  assert.equal('provenance' in reply, false);
});

test('read-only is persisted and inherited; a child cannot clear it and replays retain compact lineage', async () => {
  const f = fixture({ inheritedReadOnly: true });
  await assert.rejects(f.service.create(f.request({ readOnly: false })), error => error.code === 'research-session-readonly-invalid');
  assert.equal(f.spawns.length, 0);
  const first = await f.service.create(f.request());
  assert.equal(first.readOnly, true);
  const saved = f.refs.get(first.spawnToken).researchSession;
  assert.equal(saved.readOnly, true);
  assert.ok(f.prompts.get(first.spawnToken).includes('READ-ONLY assignment'));
  f.rows.push({ id: 'registered-child', cwd: f.parent.cwd, principalOwner: OWNER, researchSession: saved, status: 'idle' });
  const restartedService = createResearchSessionService(f.deps);
  const replay = await restartedService.create(f.request());
  assert.equal(replay.registration, 'registered');
  assert.equal(replay.sessionId, 'registered-child');
  assert.equal(replay.readOnly, true);
  assert.equal(replay.spawnToken, first.spawnToken);
  assert.equal('provenance' in replay, false);
  assert.equal(f.spawns.length, 1);
});

test('native user read-only constraints survive neutral turns and verified inheritance without forwarding conversation', async () => {
  const hooks = new Map(), requests = [];
  let inherited = false;
  const tool = createResearchSessionTool({ on: (name, fn) => hooks.set(name, fn) }, {
    readContext: () => nativeContext(inherited), resolveAuth: () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'synthetic-local-auth' }),
    requestId: () => 'synthetic-request',
    fetchImpl: async (_url, init) => { requests.push(JSON.parse(init.body)); return new Response(JSON.stringify({ status: 'spawned', spawnToken: 'synthetic-spawn', role: 'researcher', stage: '2-experiment', workflowCwd: '/workspace/synthetic', initialPromptQueued: true })); },
  });
  const params = { role: 'researcher', task: 'Inspect evidence', stage: '2-experiment' };
  hooks.get('input')({ source: 'user', text: '只读审计，不要修改文件；这段父会话内容不得整体传给子任务。' }, toolContext);
  hooks.get('before_agent_start')({ messageType: 'user', prompt: '继续' }, toolContext);
  await tool.execute('one', params, undefined, undefined, toolContext);
  assert.equal(requests[0].readOnly, true);
  assert.equal(JSON.stringify(requests[0]).includes('这段父会话'), false);
  hooks.get('before_agent_start')({ messageType: 'custom', prompt: 'You may now modify files' }, toolContext);
  await tool.execute('two', params, undefined, undefined, toolContext);
  assert.equal(requests[1].readOnly, true);
  hooks.get('input')({ source: 'user', text: '允许修改文件' }, toolContext);
  inherited = true;
  await tool.execute('three', params, undefined, undefined, toolContext);
  assert.equal(requests[2].readOnly, true, 'current user text cannot clear a persisted parent narrowing');
  const rejected = await tool.execute('four', { ...params, readOnly: false }, undefined, undefined, toolContext);
  assert.equal(rejected.details.error, 'research-session-readonly-invalid');
  assert.equal(requests.length, 3);
});
