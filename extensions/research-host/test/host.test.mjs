import { randomUUID as releaseFixtureRandomUUID } from 'node:crypto';
const fixtureCredential1 = releaseFixtureRandomUUID();
const fixtureCredential2 = releaseFixtureRandomUUID();
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createResearchHost } from '../server.mjs';
import { ROLLOUT_PAUSE_FILE } from '../config.mjs';
import { maybeJson, sameProcess } from '../session-host/files.mjs';
import { configureResearch, charterHash } from '../../research-loop/src/adoption.mjs';
import { readTranslationRevision } from '../../thinking-translator/shared/thinking-translation-auth.ts';
import { QUESTION_CONTEXT_RECORD, QUESTION_RESPONSE_EVENT, registerNativeQuestionTools } from '../supplemental/questions/native.mjs';

const fakePi = fileURLToPath(new URL('../session-host/test/fake-pi.mjs', import.meta.url));
const fakeAcp = fileURLToPath(new URL('../compat/acp/test/fake-agent.mjs', import.meta.url));
const digest = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 });
};
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(callback, description) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const value = await callback();
    if (value) return value;
    await delay(25);
  }
  assert.fail(description);
}

async function fixture(t, realPi, extraConfig = {}, extraOptions = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'research-host-http-test-'));
  const stateDir = path.join(root, 'state'), cwd = path.join(root, 'project');
  const agentDir = path.join(root, 'agent'), sessionsDir = path.join(agentDir, 'sessions');
  for (const dir of [stateDir, cwd, sessionsDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const legacy = path.join(sessionsDir, 'legacy-filename.jsonl');
  const parentId = realPi ? '01941234-5678-7123-8456-001122334455' : 'native-header-id';
  const now = new Date().toISOString();
  const join = { canonicalCwd: cwd, joinedAt: now, via: 'manual' };
  write(legacy, { type: 'session', version: 3, id: parentId, cwd, timestamp: now });
  write(legacy.replace(/\.jsonl$/, '.meta.json'), { cwd, pluginRefs: { 'res-workflow': { resWorkflow: join } }, resWorkflow: join });
  configureResearch(cwd, { objective: 'Test preserved research identity', successCriteria: ['True task handoff'] });
  const ownerKey = JSON.stringify(['host', 'inert-operator']);
  const scope = path.join(stateDir, 'res-workflow', digest(ownerKey), digest(cwd));
  const adoptionId = 'adopt-0123456789abcdef01234567', confirmationHash = 'sha256:' + 'a'.repeat(64);
  write(path.join(scope, 'adopted.json'), { confirmed: true, id: adoptionId, confirmationHash });
  write(path.join(scope, adoptionId + '.json'), {
    schema: 'pi-res-workflow-operation.v1', ownerKey, cwd, adoption: { id: adoptionId, cwd, status: 'confirmed' },
  });
  write(path.join(cwd, '.pi/research-loop/adoptions', adoptionId, 'confirmation.json'), {
    schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash: charterHash(cwd), autoRun: false,
  });
  const config = {
    stateDir, sessionsDir, agentDir, piCommand: realPi ?? process.execPath,
    piArgs: realPi ? ['--offline', '--no-mcp', '--no-extensions', '--no-context-files'] : [fakePi],
    bindHost: '127.0.0.1', port: 0, token: fixtureCredential1,
    pollMs: 100, nativeRoots: [], knownCwds: [cwd],
    ...extraConfig,
  };
  const options = {
    beforeLaunch() {},
    workerEnv: { HOME: root, PI_OFFLINE: '1' },
    sessionHost: { pollMs: 20, startupTimeoutMs: realPi ? 15_000 : 5000 },
    ...extraOptions,
  };
  let host, origin;
  async function start() {
    host = await createResearchHost(config, options);
    const address = await host.listen();
    origin = 'http://127.0.0.1:' + address.port;
    write(path.join(stateDir, 'config.json'), { ...config, token: undefined, port: address.port });
    fs.mkdirSync(path.join(stateDir, 'local'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(stateDir, 'local/token'), config.token, { mode: 0o600 });
  }
  t.after(async () => {
    if (host) {
      const live = host.sessions.listSessions().filter(row => row.live && !row.external);
      await Promise.allSettled(live.map(row => host.sessions.terminate(row.id)));
      await until(() => live.every(row => {
        const status = maybeJson(path.join(stateDir, 'session-host', 'keepers', row.id, 'status.json'));
        return !status || !sameProcess(status.keeper);
      }), 'isolated keepers should finish their last writes before fixture removal');
      await host.close();
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await start();
  async function api(method, endpoint, body, token = config.token) {
    const result = await fetch(origin + endpoint, {
      method, headers: { 'x-pi-local-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(realPi ? 20_000 : 12_000),
    });
    return { http: result.status, data: await result.json() };
  }
  return {
    root, cwd, legacy, parentId, adoptionId, api,
    get origin() { return origin; },
    mintMcpToken(id) { return host.mcp.mintForSession(id); },
    async restart() { await host.close(); await start(); },
    workflow: '/api/res-workflow',
    projectQuery: '?cwd=' + encodeURIComponent(cwd),
    scoped(pathname = '') { return '/api/res-workflow' + pathname + '?cwd=' + encodeURIComponent(cwd); },
  };
}

test('browser can create a project, launch it and revoke a persistent grant across host restart', async t => {
  const f = await fixture(t);
  const response = await fetch(f.origin + '/api/browse/create-project', {
    method: 'POST', headers: {
      'content-type': 'application/json', origin: 'https://unrelated.invalid',
      'x-pi-local-token': fixtureCredential1,
    },
    body: JSON.stringify({ name: 'refused-project' }),
  });
  assert.equal(response.status, 403);
  assert.equal(fs.existsSync(path.join(f.root, 'Projects/refused-project')), false);
  const created = await f.api('POST', '/api/browse/create-project', { name: 'new-project' });
  assert.equal(created.http, 200, JSON.stringify(created.data));
  const cwd = created.data.data.path;
  assert.equal(fs.statSync(cwd).isDirectory(), true);
  const launched = await f.api('POST', '/api/session/spawn', { cwd, requestId: 'frontend-create-and-run' });
  assert.equal(launched.http, 200, JSON.stringify(launched.data));
  const pinned = await f.api('PATCH', '/api/pinned-dirs', { action: 'pin', path: cwd });
  assert.deepEqual(pinned.data.data, [f.cwd, cwd]);

  const shared = path.join(f.root, 'external-grant'), other = path.join(f.root, 'other-external');
  for (const folder of [shared, other]) fs.mkdirSync(folder, { mode: 0o700 });
  const file = path.join(shared, 'fact.md');
  fs.writeFileSync(file, 'Granted reading works');
  const query = '/api/file?' + new URLSearchParams({ cwd, path: file });
  const denial = await f.api('GET', query);
  assert.equal(denial.http, 403, JSON.stringify(denial.data));
  assert.equal(denial.data.subject, shared);
  const accept = subject => f.api('POST', '/api/access/grants', { denialId: denial.data.denialId, subject, scope: 'project' });
  assert.equal((await accept(other)).http, 403);
  assert.equal((await accept(shared)).http, 200);
  assert.equal((await f.api('GET', query)).data.data.content, 'Granted reading works');
  await f.restart();
  assert.deepEqual((await f.api('GET', '/api/pinned-dirs')).data.data, [f.cwd, cwd]);
  assert.equal((await f.api('GET', '/api/access/grants')).data.data.pathGrants[0].subject, shared);
  assert.equal((await f.api('GET', query)).data.data.content, 'Granted reading works');
  assert.equal((await f.api('DELETE', '/api/access/grants', { subject: shared, scope: 'project' })).http, 200);
  assert.equal((await f.api('GET', query)).http, 403);
});

test('browser answers a registered terminal question after host restart and observes native acceptance', async t => {
  const f = await fixture(t);
  const history = [];
  const identity = { sessionId: f.parentId, cwd: f.cwd, sessionFile: f.legacy };
  const register = () => f.api('POST', '/internal/native/register', { ...identity, status: 'idle' });
  assert.equal((await register()).http, 200);
  const context = {
    sessionManager: { getSessionId: () => f.parentId, getBranch: () => history },
    ui: { select() {}, confirm() {}, input: (_title, _value, { signal }) =>
      new Promise(resolve => signal.addEventListener('abort', () => resolve(undefined), { once: true })) },
  };
  const native = registerNativeQuestionTools({ on() {}, registerTool() {}, appendEntry(customType, data) { history.push({ type: 'custom', customType, data }); } }, {
    remoteDialogs: true, getConfig: () => ({ askUserPromptTimeoutSeconds: -1 }),
    publishContext: (data) => f.api('POST', '/internal/native/event', { sessionId: f.parentId, event: { type: QUESTION_CONTEXT_RECORD, data } }),
  });
  const pending = native.tool.execute('terminal-call', { method: 'input', title: 'Synthetic question' }, undefined, undefined, context);
  const before = await until(async () => (await f.api('GET', '/api/questions')).data.data?.[0], 'terminal question should be visible');
  await f.restart();
  assert.equal((await register()).http, 200);
  await native.publishPending(context);
  assert.equal((await f.api('GET', '/api/questions')).data.data[0].id, before.id);
  const answer = f.api('POST', '/api/questions/' + before.id + '/answer', { answer: 'Verified answer' });
  const event = await until(async () => (await f.api('POST', '/internal/native/inbox', identity)).data.data?.events.find(row => row.eventType === QUESTION_RESPONSE_EVENT), 'browser answer should be queued to the terminal');
  assert.equal((await native.consumeEvent(event, context)).status, 'accepted');
  await f.api('POST', '/internal/native/event-acknowledge', { sessionId: f.parentId, eventId: event.eventId });
  assert.equal((await answer).data.data.transmitted, true);
  assert.equal((await pending).details.result, 'Verified answer');
});

test('frontend can resume a legacy native ID, observe a registered child, and replay the parent receipt after restart', async t => {
  const f = await fixture(t);
  assert.equal((await f.api('GET', '/api/health', undefined, 'invalid-token')).http, 401);
  assert.equal((await f.api('GET', f.scoped())).data.adopted, true);
  const parent = await f.api('POST', '/api/sessions', { cwd: f.cwd, sessionId: f.parentId, resume: true });
  assert.equal(parent.http, 201, JSON.stringify(parent.data));
  assert.equal(parent.data.data.sessionFile, f.legacy);
  assert.equal((await f.api('GET', '/api/sessions/legacy-filename')).http, 404);
  const parentPid = parent.data.data.pid;
  let collaboration = (await f.api('GET', f.scoped('/collaboration'))).data;
  const selected = await f.api('POST', f.workflow + '/collaboration', {
    cwd: f.cwd, action: 'select-main', sessionId: f.parentId, expectedRevision: collaboration.revision,
  });
  assert.equal(selected.http, 200, JSON.stringify(selected.data));
  collaboration = selected.data;
  assert.equal(collaboration.currentMainSessionId, f.parentId);
  const limit = await f.api('POST', f.workflow + '/collaboration', {
    cwd: f.cwd, action: 'limits', expectedRevision: collaboration.revision, maxMultiAgents: 1, maxSubagents: 1,
  });
  assert.equal(limit.http, 200, JSON.stringify(limit.data));

  const sendDispatch = body => f.api('POST', f.workflow + '/dispatch', { sessionId: f.parentId, ...body });
  const tasks = ['first', 'second'].map(id => ({ id, role: 'research-worker', task: 'Synthetic task ' + id, stage: '2-experiment' }));
  const submission = await sendDispatch({ action: 'plan', planId: 'frontend-plan', tasks, readOnly: true });
  assert.equal(submission.http, 200, JSON.stringify(submission.data));
  const execution = await until(async () => {
    const result = await sendDispatch({ action: 'status', planId: 'frontend-plan' });
    assert.equal(result.http, 200, JSON.stringify(result.data));
    const plan = result.data.plans.find(row => row.clientPlanId === 'frontend-plan');
    return plan?.tasks?.[0]?.sessionId ? plan : null;
  }, 'assigned child should register with the durable plan');
  const first = execution.tasks[0], child = (await f.api('GET', '/api/sessions/' + first.sessionId)).data.data;
  assert.equal(execution.tasks[1].sessionId, undefined);
  assert.equal(child.researchSession.parentSessionId, f.parentId);
  assert.equal(child.researchSession.dispatchId, execution.id);
  assert.equal(child.researchSession.taskId, first.id);
  assert.equal(child.researchSession.readOnly, true);
  assert.equal(child.nativeRegistrationConfirmed, true);
  assert.equal((await f.api('POST', '/api/sessions/' + first.sessionId + '/command', { type: 'bash', command: 'true' })).http, 403);

  const report = await f.api('POST', f.workflow + '/dispatch', {
    sessionId: child.id, action: 'report', status: 'completed', summary: 'Synthetic result recorded', evidence: [],
  });
  assert.equal(report.http, 200, JSON.stringify(report.data));
  const receipt = await until(async () => {
    const result = (await f.api('GET', '/api/sessions/' + f.parentId + '/events')).data.data;
    return result.events.find(row => row.event.type === 'prompt_received');
  }, 'parent should see its child receipt while another task is queued');
  await until(async () => {
    const result = (await sendDispatch({ action: 'status', planId: 'frontend-plan' })).data;
    return result.plans?.find(row => row.clientPlanId === 'frontend-plan')?.tasks?.[1]?.sessionId;
  }, 'the second task should start without another parent request');

  await f.restart();
  const resumed = (await f.api('GET', '/api/sessions/' + f.parentId)).data.data;
  assert.equal(resumed.pid, parentPid);
  const replay = (await f.api('GET', '/api/sessions/' + f.parentId + '/events')).data.data;
  assert.ok(replay.events.some(entry => entry.sequence === receipt.sequence && entry.event.promptId === receipt.event.promptId));
  const reread = (await sendDispatch({ action: 'status', planId: 'frontend-plan' })).data;
  assert.equal(reread.plans.find(row => row.clientPlanId === 'frontend-plan').tasks[0].sessionId, first.sessionId);
});

test('frontend can read scoped controls, verify writes, and page a transcript', async t => {
  const f = await fixture(t);
  const pauseFile = path.join(f.root, 'state', ROLLOUT_PAUSE_FILE);
  write(pauseFile, { id: 'fixture-rollout' });
  await f.restart();
  const accessMode = await f.api('GET', f.scoped('/access-mode'));
  assert.equal(accessMode.http, 200, JSON.stringify(accessMode.data));
  const update = {
    cwd: f.cwd, mode: 'full-access', expectedRevision: accessMode.data.revision, requestId: 'fixture-permission-mode',
  };
  const paused = await f.api('POST', f.workflow + '/access-mode', update);
  assert.equal(paused.http, 503);
  assert.equal(paused.data.code, 'research-host-rollout-paused');
  assert.equal((await f.api('GET', f.scoped('/access-mode'))).data.mode, accessMode.data.mode);
  fs.unlinkSync(pauseFile);
  const changed = await f.api('POST', f.workflow + '/access-mode', update);
  assert.equal(changed.http, 200, JSON.stringify(changed.data));
  assert.equal((await f.api('GET', f.scoped('/access-mode'))).data.mode, 'full-access');
  const state = await f.api('GET', f.scoped('/charter-binding'));
  assert.equal(state.http, 200, JSON.stringify(state.data));
  assert.equal(state.data.status, 'current');
  const observation = await until(async () => {
    const response = await f.api('GET', f.scoped('/workbench-sync'));
    return response.http === 200 && response;
  }, 'the collector should restart after the rollout pause is cleared');
  assert.equal(observation.data.adoptionId ?? observation.data.scope?.adoptionId, f.adoptionId);
  const notes = await f.api('GET', '/api/sessions/' + f.parentId + '/transcript?limit=5');
  assert.equal(notes.http, 200, JSON.stringify(notes.data));
  assert.ok(Array.isArray(notes.data.data.entries));
  const invalid = await f.api('POST', f.workflow + '/access-mode', { cwd: f.cwd, mode: 'invalid' });
  assert.equal(invalid.http, 400);
  assert.equal((await f.api('GET', f.scoped('/access-mode'))).data.mode, 'full-access');
});

test('legacy URL opens detached native transcript, tool results and attachments', async t => {
  const f = await fixture(t);
  const nativeId = '01941234-5678-7123-8456-000000000001';
  const oldId = '01941234-5678-7123-8456-000000000002';
  const cwd = path.join(f.root, 'missing-project');
  const file = path.join(path.dirname(f.legacy), '2026-01-01T00-00-00-000Z_' + oldId + '.jsonl');
  const image = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const data = image.toString('base64');
  write(file, { type: 'session', version: 3, id: nativeId, cwd, timestamp: '2026-01-01T00:00:00.000Z' });
  fs.appendFileSync(file, JSON.stringify({ type: 'message', id: 'native-tool', parentId: null,
    message: { role: 'toolResult', toolCallId: 'legacy-tool', toolName: 'fixture', isError: false,
      content: [{ type: 'text', text: 'preserved output' }, { type: 'image', mimeType: 'image/png', data }] } }) + '\n');
  await f.restart();
  const endpoint = '/api/sessions/' + oldId;
  const row = await f.api('GET', endpoint);
  assert.equal(row.http, 200, JSON.stringify(row.data));
  assert.equal(row.data.data.id, nativeId);
  assert.equal(row.data.data.resumeAvailable, false);
  const page = await f.api('GET', endpoint + '/transcript');
  assert.equal(page.http, 200, JSON.stringify(page.data));
  assert.equal(page.data.data.entries[0].id, 'native-tool');
  const result = await f.api('GET', endpoint + '/tool-result/legacy-tool');
  assert.equal(result.http, 200, JSON.stringify(result.data));
  assert.deepEqual(result.data, { result: 'preserved output', isError: false });
  const attachment = await fetch(f.origin + endpoint + '/attachments/' + digest(data), {
    headers: { 'x-pi-local-token': fixtureCredential1 },
  });
  assert.equal(attachment.status, 200);
  assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), image);
  const resume = await f.api('POST', '/api/session/' + oldId + '/resume', { mode: 'continue' });
  assert.equal(resume.http, 409);
  assert.equal(resume.data.code, 'session-cwd-missing');
});

test('browser WebSocket replays native prompts and applies an exact pending confirmation', async t => {
  const f = await fixture(t);
  const parent = await f.api('POST', '/api/sessions', { cwd: f.cwd, sessionId: f.parentId, resume: true });
  assert.equal(parent.http, 201, JSON.stringify(parent.data));
  const body = { scope: 'browser' };
  assert.equal((await f.api('POST', '/api/ws-ticket', body, 'invalid-token')).http, 401);
  const valid = await f.api('POST', '/api/ws-ticket', body);
  assert.equal(valid.http, 200, JSON.stringify(valid.data));
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws?ticket=' + valid.data.ticket);
  const messages = [];
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  t.after(() => { if (socket.readyState < 2) socket.close(); });
  await until(() => socket.readyState === WebSocket.OPEN, 'browser should connect with its one-use ticket');
  socket.send(JSON.stringify({ type: 'subscribe', sessionId: f.parentId, lastSeq: 0 }));
  await until(() => messages.find(message => message.type === 'session_snapshot'), 'browser should receive a verified snapshot');
  socket.send(JSON.stringify({ type: 'send_prompt', sessionId: f.parentId, text: 'ask-ui', promptId: 'fixture-browser-prompt' }));
  const prompt = await until(() => messages.find(message => message.type === 'prompt_result'), 'browser should receive a real prompt receipt');
  assert.equal(prompt.accepted, true);
  assert.equal(prompt.promptId, 'fixture-browser-prompt');
  await until(async () => {
    const result = await f.api('GET', '/api/sessions/' + f.parentId);
    return result.data.data?.pendingUIRequests?.some(entry => entry.id === 'fake-dialog');
  }, 'pending native confirmation should be visible to the UI');
  socket.send(JSON.stringify({ type: 'extension_ui_response', sessionId: f.parentId, requestId: 'fake-dialog', confirmed: true }));
  const confirmation = await until(() => messages.find(message => message.type === 'extension_ui_response_result'), 'browser should receive a native confirmation receipt');
  assert.equal(confirmation.accepted, true);
  const state = await f.api('GET', '/api/sessions/' + f.parentId);
  assert.equal(state.data.data.pendingUIRequests.length, 0);
  assert.equal(messages.filter(message => message.type === 'error').length, 0);
  socket.close();
});

test('browser receives authorized thinking translations only live and revocation rejects stale frames', async t => {
  const model = { provider: 'synthetic', id: 'physical-model', api: 'openai-completions', baseUrl: 'http://127.0.0.1:9' };
  const f = await fixture(t, undefined, {}, { modelConfig: { loadRuntime: async () => ({
    runtime: { getModels: () => [model] }, credentials: { synthetic: { type: 'api_key', key: 'fixture-key' } },
  }) } });
  const identity = { sessionId: f.parentId, cwd: f.cwd, sessionFile: f.legacy };
  assert.equal((await f.api('POST', '/internal/native/register', { ...identity, status: 'idle' })).http, 200);
  const settings = '/api/thinking-translation/settings', frameRoute = '/internal/native/thinking-translation';
  const selection = { sessionId: f.parentId, enabled: true, model: { provider: model.provider, id: model.id } };
  assert.equal((await f.api('PUT', settings, selection)).http, 400);
  const enabled = (await f.api('PUT', settings, { ...selection, consent: true })).data;
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.runtime, 'pending-safe-load');
  const revision = readTranslationRevision(f.parentId, path.join(f.root, 'agent'));
  assert.match(revision, /^[a-f0-9]{64}$/);
  const ticket = await f.api('POST', '/api/ws-ticket', { scope: 'browser' });
  const socket = new WebSocket(f.origin.replace('http:', 'ws:') + '/ws?ticket=' + ticket.data.ticket);
  const messages = [];
  socket.addEventListener('message', event => messages.push(JSON.parse(event.data)));
  t.after(() => { if (socket.readyState < 2) socket.close(); });
  await until(() => socket.readyState === WebSocket.OPEN, 'browser should connect');
  socket.send(JSON.stringify({ type: 'subscribe', sessionId: f.parentId, lastSeq: 0 }));
  await until(() => messages.some(event => event.type === 'session_snapshot'), 'browser should be subscribed');
  const status = { type: 'thinking_translation', kind: 'status', state: 'ready', sessionId: f.parentId,
    runtimeId: 'synthetic-runtime', generation: 1, sequence: 1, turnId: 'synthetic-turn', expiresAt: Date.now() + 30_000 };
  const snapshot = { ...status, kind: 'snapshot', sequence: 2, blocks: [{
    messageId: 'message', blockId: 'thinking', original: 'Synthetic source', translation: '合成译文',
  }] };
  delete snapshot.state;
  const publish = frame => f.api('POST', frameRoute, { ...identity, frame, revision });
  assert.equal((await publish(status)).data.published, true);
  assert.equal((await publish(snapshot)).data.published, true);
  assert.equal((await publish(snapshot)).data.published, false);
  await until(() => messages.some(event => event.kind === 'snapshot' && event.blocks?.[0]?.translation === '合成译文'), 'translator snapshot should be displayed');
  assert.equal((await f.api('GET', settings + '?sessionId=' + f.parentId)).data.runtime, 'ready');
  assert.equal((await f.api('PUT', settings, { sessionId: f.parentId, enabled: false })).data.enabled, false);
  await until(() => messages.some(event => event.type === 'thinking_translation' && event.kind === 'clear'), 'revocation should clear the display');
  assert.equal((await publish({ ...snapshot, sequence: 3 })).data.published, false);
  const journal = await f.api('GET', '/api/sessions/' + f.parentId + '/events');
  assert.ok(!JSON.stringify(journal.data).includes('合成译文'));
  socket.close();
});

test('MCP HTTP authorizes per-session Bearer separately from the UI credential', async t => {
  const f = await fixture(t);
  const parent = await f.api('POST', '/api/sessions', { cwd: f.cwd, sessionId: f.parentId, resume: true });
  assert.equal(parent.http, 201);
  const body = {
    jsonrpc: '2.0', id: 'list-tools-browser-test', method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  };
  const auxiliary = await f.api('POST', '/mcp', body);
  assert.equal(auxiliary.http, 401);
  const response = await fetch(f.origin + '/mcp', {
    method: 'POST', body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28', authorization: 'Bearer ' + f.mintMcpToken(f.parentId) },
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.ok((await response.json()).result?.tools?.some(tool => tool.name === 'list_sessions'));
});

test('installed Pi connects to the standalone keeper and keeps identity across host restart', async t => {
  const pi = process.env.PI_RESEARCH_REAL_PI ?? path.join(os.homedir(), '.local/bin/pi');
  fs.accessSync(pi, fs.constants.X_OK);
  const f = await fixture(t, pi);
  const started = await f.api('POST', '/api/sessions', { cwd: f.cwd, sessionId: f.parentId, resume: true });
  if (started.http !== 201) {
    const directory = path.join(f.root, 'state/session-host/keepers', f.parentId);
    const diagnostics = ['worker.stderr.log', 'keeper.stderr.log', 'status.json'].flatMap(name => {
      const file = path.join(directory, name);
      return fs.existsSync(file) ? [fs.readFileSync(file, 'utf8').slice(-2048)] : [];
    }).join('\n');
    assert.fail(JSON.stringify(started.data) + '\n' + diagnostics);
  }
  const command = { type: 'get_state' };
  const before = await f.api('POST', '/api/sessions/' + f.parentId + '/command', command);
  assert.equal(before.http, 200, JSON.stringify(before.data));
  assert.equal(before.data.data.data.sessionId, f.parentId);
  const controls = await f.api('POST', '/api/sessions/' + f.parentId + '/command', { type: 'get_commands' });
  assert.equal(controls.http, 200);
  assert.ok(controls.data.data.data.commands.some(command => command.name === '__research_host_control'));
  const settings = await f.api('GET', '/api/pi-settings');
  assert.equal(settings.http, 200);
  const saved = await f.api('PUT', '/api/pi-settings', { baseEtag: settings.data.etag, patch: { steeringMode: 'all' } });
  assert.equal(saved.http, 200, JSON.stringify(saved.data));
  const reloaded = await until(async () => {
    const result = await f.api('GET', '/api/pi-settings/reload');
    const target = result.data.reload?.sessions?.find(row => row.sessionId === f.parentId);
    if (target?.state === 'unconfirmed') assert.fail(JSON.stringify(target));
    return target?.state === 'reloaded' ? target : null;
  }, 'settings should be loaded by a new native extension instance');
  assert.match(reloaded.settingsHash, /^[a-f0-9]{64}$/);
  const currentSettings = await f.api('POST', '/api/sessions/' + f.parentId + '/command', command);
  assert.equal(currentSettings.data.data.data.steeringMode, 'all');
  await f.restart();
  const after = await f.api('GET', '/api/sessions/' + f.parentId);
  assert.equal(after.data.data.pid, started.data.data.pid);
  assert.equal(after.data.data.sessionFile, f.legacy);
});

test('provider changes and credentials use the standalone HTTP runtime and the native catalogue', async t => {
  const f = await fixture(t, undefined, {}, { providers: { fetch: async () => new Response(JSON.stringify({
    object: 'list', data: [{ id: 'synthetic-registered-model' }],
  }), { status: 200, headers: { 'content-type': 'application/json' } }) } });
  assert.equal((await f.api('GET', '/api/provider-auth/status', undefined, 'wrong-token')).http, 401);
  const saved = await f.api('PUT', '/api/providers', { providers: {
    'synthetic-proxy': { baseUrl: 'http://127.0.0.1:43117/v1', apiKey: fixtureCredential2, api: 'openai-completions' },
  } });
  assert.equal(saved.http, 200, JSON.stringify(saved.data));
  const discovered = await until(async () => {
    const models = await f.api('GET', '/api/models');
    assert.equal(models.http, 200, JSON.stringify(models.data));
    return models.data.data.find(model => model.id === 'synthetic-proxy/synthetic-registered-model');
  }, 'saved provider should affect real selected Pi SDK catalogue');
  assert.equal(discovered.provider, 'synthetic-proxy');
  const projection = await f.api('GET', '/api/providers');
  assert.ok(!JSON.stringify(projection.data).includes(fixtureCredential2));
  const key = 'synthetic-openai-credential';
  assert.equal((await f.api('PUT', '/api/provider-auth/api-key', { provider: 'openai', key })).http, 200);
  assert.equal(maybeJson(path.join(f.root, 'agent/auth.json')).openai.key, key);
  assert.ok(!JSON.stringify((await f.api('GET', '/api/provider-auth/status')).data).includes(key));
  assert.equal((await f.api('DELETE', '/api/provider-auth/openai', {})).http, 409);
  assert.equal((await f.api('DELETE', '/api/provider-auth/openai-api', {})).http, 200);
  assert.equal(maybeJson(path.join(f.root, 'agent/auth.json')).openai, undefined);
});

test('legacy browser ACP spawn returns the native driver and durable prompt acceptance', async t => {
  const f = await fixture(t, undefined, { acpAgents: [{
    id: 'fixture', name: 'Synthetic ACP', command: process.execPath, args: [fakeAcp, '1'], env: {}, durable: true,
  }] });
  const agents = await f.api('GET', '/api/acp/agents');
  assert.deepEqual(agents.data.data, [{ id: 'fixture', name: 'Synthetic ACP' }]);
  const started = await f.api('POST', '/api/session/spawn', { cwd: f.cwd, agent: 'fixture', requestId: 'fixture-acp-spawn' });
  assert.equal(started.http, 200, JSON.stringify(started.data));
  const id = started.data.data.sessionId;
  const row = await f.api('GET', '/api/sessions/' + id);
  assert.equal(row.data.data.driver, 'acp');
  const prompt = await f.api('POST', '/api/session/' + id + '/prompt', { text: 'Synthetic ACP turn', promptId: 'fixture-acp-prompt' });
  assert.equal(prompt.http, 200, JSON.stringify(prompt.data));
  assert.equal(prompt.data.transmitted, true);
  assert.equal(prompt.data.promptId, 'fixture-acp-prompt');
});
