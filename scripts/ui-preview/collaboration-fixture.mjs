/** Durable, explicitly synthetic collaboration data for the REAL Dashboard.
 *
 * This runs before the isolated server starts. The real collaboration/dispatch
 * services produce their normal private ledgers; no HTTP route is intercepted.
 * All transcript sidecars stay ENDED. A fixture-only in-memory live catalog is
 * used while recording historical selections, never to launch a Pi process.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createResearchCollaborationService, createResearchCollaborationStore } from '../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-collaboration-service.mjs';
import { createResearchDispatchService, createResearchDispatchStore } from '../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';
import { ResearchSessionError } from '../../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';

const MODEL = 'demo/ui-fixture-unpriced';
const metaFile = session => session.sessionFile.replace(/\.jsonl$/, '.meta.json');

function privateJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

function endedSession(directory, cwd, title, index) {
  const id = randomUUID(), startedAt = Date.now() - (index + 1) * 60_000;
  const timestamp = new Date(startedAt).toISOString();
  const sessionFile = path.join(directory, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`);
  const name = `【演示】${title}`;
  const entries = [
    { type: 'session', version: 3, id, timestamp, cwd },
    { type: 'model_change', id: 'model', parentId: null, timestamp, provider: 'demo', modelId: 'ui-fixture-unpriced' },
    { type: 'session_info', id: 'title', parentId: 'model', timestamp, name },
    { type: 'message', id: 'question', parentId: 'title', timestamp,
      message: { role: 'user', timestamp: startedAt, content: [{ type: 'text', text: `${name}：仅为协作界面夹具；没有调用模型或执行研究。` }] } },
    { type: 'message', id: 'answer', parentId: 'question', timestamp: new Date(startedAt + 1000).toISOString(),
      message: { role: 'assistant', api: 'openai-completions', provider: 'demo', model: 'ui-fixture-unpriced', stopReason: 'stop', timestamp: startedAt + 1000,
        content: [{ type: 'text', text: '【演示】此已结束会话只验证层级、模型来源与历史分组，不是一次真实模型运行或科学结论。' }],
        usage: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 } } },
  ];
  fs.writeFileSync(sessionFile, entries.map(entry => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  privateJson(metaFile({ sessionFile }), { cwd, source: 'tui', status: 'ended', hidden: false, archived: false,
    name, nameSource: 'user', firstMessage: entries[3].message.content[0].text, startedAt, endedAt: startedAt + 1000, tags: ['demo'] });
  return { id, name, status: 'ended', synthetic: true, sessionFile };
}

/** Mutates only the launcher's newly-created synthetic project/temp HOME. */
export async function seedCollaborationFixture({ previewHome, project, sessions, binding }) {
  const temporary = fs.realpathSync(previewHome), temporaryRoot = fs.realpathSync(os.tmpdir());
  assert.equal(path.dirname(temporary), temporaryRoot, 'Fixture requires the isolated temporary HOME');
  assert.ok(path.basename(temporary).startsWith('pi-ui-preview-'));
  assert.ok(sessions.length === 3 && sessions.every(row => row.synthetic && row.status === 'ended'));
  assert.equal(binding.cwd, project);
  assert.equal(binding.privateDir, path.join(temporary, '.pi/dashboard/res-workflow'));

  const state = JSON.parse(fs.readFileSync(path.join(project, '.pi/research-loop/state.json'), 'utf8'));
  const charterHash = 'sha256:' + createHash('sha256').update(JSON.stringify(state.charter)).digest('hex');
  const ownerKey = JSON.stringify(['host', 'inert-operator']);
  assert.equal(binding.ownerKey, ownerKey);
  const directory = path.dirname(sessions[0].sessionFile);
  const definitions = [
    { title: '结构预处理', role: 'research-structure' },
    { title: '迁移路径搜索', role: 'research-theory' },
    { title: '能量计算与评估', role: 'research-compute' },
    { title: '方案汇总', role: 'research-reviewer' },
  ];
  const currentMain = sessions[0], formerMain = sessions[2], formerChild = sessions[1];
  const children = definitions.map((item, index) => ({ ...endedSession(directory, project, item.title, index + 8), role: item.role }));
  sessions.push(...children);
  let clock = new Date(Date.now() - 30_000), sequence = 0;
  const rows = [];
  function row(session, provenance) {
    return { ...session, cwd: project, status: 'idle', model: MODEL,
      resWorkflow: { canonicalCwd: project, joinedAt: clock.toISOString(), via: provenance ? 'spawn' : 'manual' },
      ...(provenance ? { researchSession: provenance } : {}) };
  }
  function provenance(parent, tenureId, role) {
    return { schema: 'pi-research-session.v1', parentSessionId: parent.id, creatorSessionId: parent.id,
      creatorAgent: 'research_session', role, task: '【演示】仅验证协作关系；未执行任何模型任务。', stage: '2-experiment',
      charterHash, adoptionId: binding.adoptionId, workflowCwd: project, spawnToken: randomUUID(),
      createdAt: clock.toISOString(), origin: 'research_session', relation: 'dispatch', tenureId };
  }
  rows.push(row(formerMain), row(currentMain));
  const access = { cwd: project, ownerKey, write: true, revalidate: async () => {}, canReadHistory: async candidate => candidate.cwd === project };
  const verified = parent => ({ cwd: project, ownerKey, adoptionId: binding.adoptionId, charterHash, parent });
  const store = createResearchCollaborationStore(path.join(binding.privateDir, 'collaboration'));
  const dispatchStore = createResearchDispatchStore(path.join(binding.privateDir, 'dispatch'));
  let dispatcher;
  const service = createResearchCollaborationService({
    store, listSessions: () => rows, now: () => clock, mintId: () => `demo-${++sequence}`,
    connection: async () => ({ adopted: true }), verifySelected: async parent => verified(parent),
    join: async () => {}, detach: async () => {},
    listPlans: scope => dispatcher?.listForScope(scope) ?? [],
    suspendSessions: (...args) => dispatcher?.suspendSessions(...args),
  });
  const mutate = async body => service.mutate(access, { expectedRevision: (await service.snapshot(access)).revision, ...body });
  const old = await mutate({ action: 'select-main', sessionId: formerMain.id });
  rows.push(row(formerChild, provenance(formerMain, old.currentTenureId, 'research-literature')));
  await service.snapshot(access);
  clock = new Date(clock.getTime() + 10_000);
  const current = await mutate({ action: 'select-main', sessionId: currentMain.id });
  for (const child of children) rows.push(row(child, provenance(currentMain, current.currentTenureId, child.role)));
  await service.snapshot(access);

  // The real DAG service creates its durable queue. Its preflight deliberately
  // returns a documented capacity denial; the process seam must never run.
  dispatcher = createResearchDispatchService({
    store: dispatchStore, now: () => clock, listSessions: () => rows, getSession: id => rows.find(candidate => candidate.id === id),
    authorize: async ({ sessionId }) => verified(rows.find(candidate => candidate.id === sessionId)),
    getSchedulingPolicy: input => service.getSchedulingPolicy(input),
    assertDispatchAllowed: input => service.assertDispatchAllowed(input),
    beforeLaunch: async () => { throw new ResearchSessionError(409, 'research-session-concurrency-limit'); },
    createSession: async () => { throw new Error('Fixture must never cross the Pi process boundary'); },
  });
  const plan = await dispatcher.handle({ body: { sessionId: currentMain.id, action: 'plan', planId: 'demo-next-work', concurrency: 4,
    tasks: [
      { id: 'counterexample', role: 'research-reviewer', task: '【演示】反例核查', stage: '3-review', dependsOn: [] },
      { id: 'neb', role: 'research-theory', task: '【演示】NEB 方案', stage: '2-experiment', dependsOn: ['counterexample'] },
      { id: 'replicate', role: 'research-reviewer', task: '【演示】结果复核', stage: '3-review', dependsOn: [] },
      { id: 'convergence', role: 'research-compute', task: '【演示】收敛性对比', stage: '2-experiment', dependsOn: [] },
    ] } });
  assert.equal(plan.plans.length, 1);
  assert.equal(plan.plans[0].tasks.filter(task => task.status === 'queued').length, 4);

  // Record real lease decisions with a controlled catalog, then release the
  // acquired leases: no synthetic process is claimed alive after bootstrap.
  const nativeParent = children[1], leases = [];
  for (let index = 0; index < 4; index++) {
    const request = { sessionId: nativeParent.id, requestId: `demo-sub-${index}`, attemptId: `demo-attempt-${index}`,
      role: 'research-reviewer', model: MODEL, task: `【演示】子任务 ${index + 1}` };
    const result = await service.native(access, { ...request, action: 'subagent-acquire' });
    if (index < 3) { assert.equal(result.status, 'acquired'); leases.push({ request, leaseToken: result.leaseToken }); }
    else assert.equal(result.status, 'queued');
  }
  for (const { request, leaseToken } of leases) await service.native(access, { ...request, leaseToken, action: 'subagent-release' });

  // Persist native transcript metadata exactly as the live server scanner
  // reads it. Membership/provenance survives; status remains truthfully ended.
  for (const live of rows) {
    const session = sessions.find(candidate => candidate.id === live.id);
    const metadata = JSON.parse(fs.readFileSync(metaFile(session), 'utf8'));
    metadata.pluginRefs ??= {};
    metadata.pluginRefs['res-workflow'] = { ...metadata.pluginRefs['res-workflow'], resWorkflow: live.resWorkflow,
      ...(live.researchSession ? { researchSession: live.researchSession } : {}) };
    if (live.researchSession) delete metadata.researchSession;
    metadata.status = 'ended';
    privateJson(metaFile(session), metadata);
  }

  // A labelled persisted observer checkpoint supplies completed native child
  // records; the actual workbench routes merge this with native session data.
  const checkpointFile = path.join(temporary, '.pi/dashboard/workbench-sync/state/synthetic-owner/synthetic-project/checkpoint.json');
  const checkpoint = JSON.parse(fs.readFileSync(checkpointFile, 'utf8'));
  checkpoint.scope = { cwd: project, ownerKey, adoptionId: binding.adoptionId, charterHash };
  checkpoint.parents = Object.fromEntries(rows.map(live => [live.id, { execution: {
    id: 'session-' + live.id, sessionId: live.id, kind: 'pi-session', role: live.researchSession?.role ?? 'research-lead',
    ...(live.researchSession ? { parentExecutionId: 'session-' + live.researchSession.parentSessionId } : {}),
    status: 'ended', prompt: live.name, observedModel: MODEL, startedAt: clock.toISOString(), lastActivityAt: clock.toISOString(),
  } }]));
  checkpoint.native = {};
  const nativeDefinitions = [
    { parent: children[1], id: 'demo-neb-review', role: 'verification', title: '【演示】NEB 复核' },
    { parent: children[1], id: 'demo-path-review', role: 'review', title: '【演示】路径检查' },
    { parent: children[2], id: 'demo-energy-audit', role: 'audit', title: '【演示】能量验证' },
    { parent: formerChild, id: 'demo-old-sub', role: 'organize', title: '【演示】历史文件整理' },
  ];
  for (const native of nativeDefinitions) checkpoint.native[native.id] = {
    rootParentId: native.parent.id, sourceKind: 'native-status',
    execution: { id: native.id, kind: 'native-subagent', parentExecutionId: 'session-' + native.parent.id,
      role: native.role, prompt: native.title, observedModel: MODEL, status: 'completed', startedAt: clock.toISOString(), endedAt: clock.toISOString() },
    relation: { id: `edge-${native.id}`, fromExecutionId: 'session-' + native.parent.id, toExecutionId: native.id,
      kind: 'dispatch', evidence: { source: 'native-status', eventId: `demo-${native.id}` } },
  };
  privateJson(checkpointFile, checkpoint);

  const snapshot = await service.snapshot(access);
  assert.equal(snapshot.tenures.length, 2);
  assert.equal(snapshot.currentMainSessionId, currentMain.id);
  assert.equal(snapshot.tenures.find(tenure => tenure.id === snapshot.currentTenureId).sessionIds.length, 5);
  dispatcher.dispose();
  return { synthetic: true, realModelCalls: 0, transcriptStatus: 'ended',
    currentMainSessionId: currentMain.id, formerMainSessionId: formerMain.id, formerChildSessionId: formerChild.id,
    currentTenureId: snapshot.currentTenureId, historicalTenureId: old.currentTenureId,
    childSessionIds: children.map(child => child.id), nativeExecutionIds: nativeDefinitions.map(native => native.id),
    planId: plan.plans[0].id, initialQueuedTasks: 4,
    queueNote: 'Synthetic ended parents cannot execute. The real dispatcher may correctly block their pending queue after its recovery grace period.' };
}
