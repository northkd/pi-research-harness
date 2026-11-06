import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { test } = require('node:test');

const implementation = path.resolve('scripts/demo-simulator.cjs');
const shared = path.resolve('patches/dashboard-v0.20/overlay/packages/shared/src/research-workbench.ts');
const cwd = '/tmp/demo-project';
const charter = { objective: '【演示】样例', successCriteria: ['仅模拟'], revision: 1 };

test('demo sessions never borrow real charter-binding proof or mutate its audit chain', async () => {
  const sim = require(implementation);
  const calls = [];
  const runtime = sim.createDemoRuntime({ cwd, origin: 'http://127.0.0.1:8000',
    upstream: async (...args) => { calls.push(args); throw new Error('Synthetic session reached the real binding API'); }, notify() {} });
  const endpoint = '/api/res-workflow/charter-binding';
  const response = await runtime.fetch(endpoint + '?cwd=' + encodeURIComponent(cwd) + '&sessionId=DEMO%3Amain');
  assert.equal(response.status, 200);
  const binding = await response.json();
  const { isResearchCharterBinding } = await import(pathToFileURL(path.resolve('patches/dashboard-v0.20/overlay/packages/shared/src/research-charter-binding.ts')).href);
  assert.equal(isResearchCharterBinding(binding), true);
  assert.equal(binding.status, 'unavailable');
  assert.equal(binding.canRebind, false);
  assert.equal(binding.session, undefined);
  assert.equal((await runtime.fetch(endpoint, { method: 'POST', body: JSON.stringify({ cwd }) })).status, 403);
  assert.deepEqual(calls, []);
});

test('the simulated collaboration graph satisfies the dashboard contract', async () => {
  assert.ok(fs.existsSync(implementation), 'demo simulator has not been created');
  const sim = require(implementation);
  const { isResearchWorkbenchObservation } = await import(pathToFileURL(shared).href);
  const observation = await sim.makeObservation(cwd, charter, 0);
  assert.equal(isResearchWorkbenchObservation(observation), true);
  assert.equal(observation.executions.filter((entry) => entry.kind === 'pi-session').length, 4);
  assert.equal(observation.executions.filter((entry) => entry.kind === 'native-subagent').length, 8);
  assert.equal(observation.relations.length, 11);
  assert.equal(observation.executions.find(entry => entry.id === 'DEMO:review').parentExecutionId, 'DEMO:experiment');
  assert.ok(observation.relations.some(edge => edge.fromExecutionId === 'DEMO:experiment' && edge.toExecutionId === 'DEMO:review'));
  assert.equal(observation.executions.filter(entry => entry.parentExecutionId === 'DEMO:literature' && entry.role === 'research-literature').length, 2);
  assert.ok(observation.executions.some((entry) => entry.kind === 'native-subagent' && entry.stage === '3-review'));
  assert.ok(observation.executions.every((entry) => entry.prompt.includes('模拟')));
  assert.equal(observation.observedUsage.responses, 0);
});

test('demo mode blocks real mutations and simulates only the demo project', async () => {
  assert.ok(fs.existsSync(implementation), 'demo simulator has not been created');
  const sim = require(implementation);
  const calls = [];
  const upstream = async (url, init) => {
    calls.push([String(url), init?.method ?? 'GET']);
    const events = [
      { kind: 'run-step', detail: { stage: '1-idea', key: 'earlier' } },
      { kind: 'run-step', detail: { stage: '3-review', key: 'overlapping-demo-record', simulation: true } },
    ].map(JSON.stringify).join('\n');
    return new Response(JSON.stringify({ cwd, adopted: false, adoption: null, research: { 'state.json': JSON.stringify({ charter }), 'ledger.jsonl': null, 'events.jsonl': events, 'auto-run.json': null } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const runtime = sim.createDemoRuntime({ cwd, origin: 'http://127.0.0.1:8000', upstream, notify() {} });
  const snapshot = await (await runtime.fetch('/api/res-workflow?cwd=' + encodeURIComponent(cwd))).json();
  assert.equal(snapshot.adopted, true);
  assert.equal(snapshot.adoption.id, 'DEMO-adoption');
  assert.match(snapshot.research['events.jsonl'], /earlier/);
  assert.doesNotMatch(snapshot.research['events.jsonl'], /overlapping-demo-record/);
  const observed = await (await runtime.fetch('/api/res-workflow/workbench-sync?cwd=' + encodeURIComponent(cwd))).json();
  assert.equal(observed.executions.length, 12);
  const before = calls.length;
  const blocked = await runtime.fetch('/api/session/other/prompt', { method: 'POST', body: '{}' });
  assert.equal(blocked.status, 403);
  assert.equal(calls.length, before);
  const simulated = await runtime.fetch('/api/session/spawn', { method: 'POST', body: JSON.stringify({ cwd }) });
  assert.equal(simulated.status, 200);
  assert.equal(calls.length, before);
  const wrongProject = await runtime.fetch('/api/session/spawn', { method: 'POST', body: JSON.stringify({ cwd: '/tmp/not-the-demo' }) });
  assert.equal(wrongProject.status, 403);
  assert.equal(calls.length, before);
  const external = await runtime.fetch('https://example.com/');
  assert.equal(external.status, 403);
  assert.equal(calls.length, before);
  const changedBudget = await (await runtime.fetch('/api/res-workflow/research-budget', { method: 'POST', body: JSON.stringify({ cwd, limits: { attempts: 18, modelRequests: 9 } }) })).json();
  assert.deepEqual(changedBudget.limits, { attempts: 18, modelRequests: 9 });
  assert.equal(calls.length, before);
  const permissionUrl = '/api/res-workflow/access-mode';
  const initialPermissions = await (await runtime.fetch(permissionUrl + '?cwd=' + encodeURIComponent(cwd))).json();
  assert.equal(initialPermissions.mode, 'default');
  const grant = { cwd, expectedRevision: null, requestId: 'demo-mode-1', mode: 'full-access' };
  const approved = await (await runtime.fetch(permissionUrl, { method: 'POST', body: JSON.stringify(grant) })).json();
  assert.equal(approved.mode, 'full-access');
  assert.equal(approved.inheritance, 'workspace-sessions');
  assert.equal((await runtime.fetch(permissionUrl, { method: 'POST', body: JSON.stringify(grant) })).status, 409);
  assert.equal((await runtime.fetch(permissionUrl, { method: 'POST', body: JSON.stringify({ ...grant, cwd: '/tmp/other-project' }) })).status, 403);
  const revoked = await (await runtime.fetch(permissionUrl, { method: 'POST', body: JSON.stringify({ cwd, expectedRevision: approved.revision,
    requestId: 'demo-mode-2', mode: 'default' }) })).json();
  assert.equal(revoked.mode, 'default');
  assert.equal(calls.length, before, 'synthetic access changes must never reach real permission APIs');
  const sessions = await (await runtime.fetch('/api/sessions')).json();
  assert.equal(sessions.length, 4);
  assert.ok(sessions.every(row => row.cwd === cwd && row.name.includes('模拟')));
  const sent = await (await runtime.fetch('/api/session/' + encodeURIComponent(sessions[1].id) + '/prompt', {
    method: 'POST', body: JSON.stringify({ text: '仅模拟委派目标' }),
  })).json();
  assert.equal(sent.transmitted, true);
  assert.equal(sent.simulated, true);
  assert.equal(runtime.state.prompts.at(-1).sessionId, sessions[1].id);
  assert.equal(calls.length, before, 'demo main-agent prompts must stay in memory');
  const goalUrl = '/api/folders/goals?cwd=' + encodeURIComponent(cwd);
  const goals = await (await runtime.fetch(goalUrl)).json();
  assert.equal(goals.success, true);
  assert.ok(goals.data.length >= 2 && goals.data.every((goal) => goal.objective.includes('模拟')));
  const created = await (await runtime.fetch(goalUrl, { method: 'POST', body: JSON.stringify({ objective: '测试目标' }) })).json();
  assert.equal(created.success, true);
  assert.match(created.data.objective, /模拟/);
  assert.equal(calls.length, before);
  assert.equal(sim.isAllowedSocketMessage(JSON.stringify({ type: 'subscribe' })), true);
  assert.equal(sim.isAllowedSocketMessage(JSON.stringify({ type: 'send_prompt', text: 'hello' })), false);
  assert.equal(sim.isAllowedSocketMessage(JSON.stringify({ type: 'spawn_session' })), false);
  assert.equal(sim.isAllowedSocketMessage('unknown'), false);
});

test('ordinary dashboard tabs and unrelated project URLs remain untouched', () => {
  const sim = require(implementation);
  const originalFetch = () => {};
  const ordinary = { location: { href: 'http://127.0.0.1:8000/session/real-session' }, fetch: originalFetch };
  sim.install(ordinary);
  assert.equal(ordinary.fetch, originalFetch);
  const unrelated = { location: { href: 'http://127.0.0.1:8000/session/real-session?res-demo=1' }, fetch: originalFetch };
  sim.install(unrelated);
  assert.equal(unrelated.fetch, originalFetch);
});

test('simulated stage feedback never claims a real session was created', () => {
  const sim = require(implementation);
  const value = sim.rewriteStageFeedback('已成功为「实验与验证」创建新会话！新智能体已自动注入研究基础总结指令。');
  assert.match(value, /模拟/);
  assert.match(value, /没有创建真实会话/);
  assert.equal(sim.rewriteStageFeedback('普通提示'), '普通提示');
});

test('blocked chat and session creation receive explicit local acknowledgements', () => {
  const sim = require(implementation);
  const chat = sim.simulatedSocketReply(JSON.stringify({ type: 'send_prompt', sessionId: 'DEMO-session', text: 'private text' }));
  assert.deepEqual(chat, { type: 'prompt_received', sessionId: 'DEMO-session', fresh: false });
  assert.ok(!JSON.stringify(chat).includes('private text'));
  const spawn = sim.simulatedSocketReply(JSON.stringify({ type: 'spawn_session', cwd, requestId: 'demo-request' }));
  assert.equal(spawn.type, 'spawn_result');
  assert.equal(spawn.success, false);
  assert.match(spawn.message, /模拟/);
});

test('demo entry selects only an active session from the demo project and falls back to the project', () => {
  const sim = require(implementation);
  const sessions = [
    { id: 'other-session', cwd: '/other', status: 'active' },
    { id: 'demo-live', cwd, status: 'active' },
    { id: 'demo-ended', cwd, status: 'ended' },
  ];
  assert.equal(sim.selectDemoPath(sessions, cwd, 'missing', 'demo-folder'), '/session/demo-live');
  assert.equal(sim.selectDemoPath(sessions.slice(0, 1), cwd, 'missing', 'demo-folder'), '/folder/demo-folder/research');
});


test('the demo entry requires an explicit demo-named absolute project', () => {
  const sim=require(implementation);
  assert.equal(sim.parseDemoEntry('http://127.0.0.1:8000/?res-demo=1'),null);
  assert.equal(sim.parseDemoEntry('http://127.0.0.1:8000/?res-demo=1&demo-project=%2Fwork%2Freal'),null);
  assert.equal(sim.parseDemoEntry('http://127.0.0.1:8000/?res-demo=1&demo-project=relative-demo'),null);
  assert.equal(sim.parseDemoEntry('http://127.0.0.1:8000/res-workflow-demo.html?res-demo=1&demo-project=%2Fwork%2Fmy-demo').cwd,'/work/my-demo');
});
