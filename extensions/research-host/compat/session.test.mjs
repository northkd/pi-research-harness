import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionCompatibility } from './session.mjs';

function fixture(patches = {}) {
  const rows = new Map([['native-header-id', { id: 'native-header-id', cwd: '/synthetic/project',
    sessionFile: '/synthetic/history/file-name-a4.jsonl', status: 'idle', live: true,
    nativeRegistrationConfirmed: true, pendingUIRequests: [] }]]);
  const calls = [];
  let refusePrompt = false;
  const principal = Object.freeze({ iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' });
  const sessions = {
    getSession: id => rows.get(id), listSessions: () => [...rows.values()],
    updateSession: (id, patch) => { calls.push({ type: 'update', id, patch }); rows.set(id, { ...rows.get(id), ...patch }); },
    deliverPrompt: async (id, input) => { calls.push({ type: 'prompt', id, input }); return { accepted: !refusePrompt, disposition: 'queued' }; },
    command: async (id, input) => { calls.push({ type: 'command', id, input }); return { success: true }; },
    abort: async id => { calls.push({ type: 'abort', id }); return { success: true }; },
    terminate: async id => { calls.push({ type: 'terminate', id }); return { requested: true }; },
    respondUI: async (id, input) => { calls.push({ type: 'ui', id, input }); return { accepted: true }; },
    createSession: async input => {
      calls.push({ type: 'create', input });
      const previous = rows.get(input.sessionId);
      rows.set(input.sessionId, { ...previous, ...input.metadata, id: input.sessionId, cwd: input.cwd,
        sessionFile: input.sessionFile ?? '/synthetic/history/' + input.sessionId + '.jsonl', live: true, status: 'idle',
        nativeRegistrationConfirmed: true, initialPromptStatus: input.prompt ? 'accepted' : 'absent',
        ...(input.rawRef ? { pluginRefs: { 'res-workflow': input.rawRef } } : {}) });
      return { success: true, sessionId: input.sessionId, sessionFile: rows.get(input.sessionId).sessionFile };
    },
    ...patches.sessions,
  };
  const workbench = {
    accessFor: async (cwd, identity) => {
      calls.push({ type: 'access', cwd, identity });
      return { cwd, ownerKey: '["host","inert-operator"]', canReadHistory: async () => true, revalidate: async () => {} };
    },
    prepareSpawn: async (cwd, identity) => {
      calls.push({ type: 'prepare', cwd, identity });
      return { resWorkflow: { canonicalCwd: cwd, via: 'spawn' }, resWorkflowBinding: { ownerKey: '["host","inert-operator"]' } };
    },
    verifyParent: async input => { calls.push({ type: 'verify', input }); return { cwd: input.parent.cwd, ownerKey: '["host","inert-operator"]' }; },
    ...patches.workbench,
  };
  const handle = createSessionCompatibility({ sessions, workbench, localOperatorPrincipal: principal,
    beforeLaunch: async input => { calls.push({ type: 'resource-check', input }); await patches.beforeLaunch?.(input); } });
  return { handle, sessions, workbench, principal, rows, calls, refuse: () => { refusePrompt = true; },
    post: (action, body = {}) => handle({ method: 'POST', pathname: '/api/session/native-header-id/' + action, body }),
    spawn: body => handle({ method: 'POST', pathname: '/api/session/spawn', body }) };
}

test('legacy prompt reports transmission only after exact native acceptance and retains images and prompt ID', async () => {
  const f = fixture();
  const images = [{ type: 'image', mimeType: 'image/png', data: 'synthetic' }];
  const reply = await f.post('prompt', { text: 'Synthetic user request', images, promptId: 'stable-native-prompt' });
  assert.deepEqual(reply, { statusCode: 200, body: { success: true, transmitted: true, promptId: 'stable-native-prompt' } });
  assert.deepEqual(f.calls.find(call => call.type === 'prompt').input, { text: 'Synthetic user request', images, promptId: 'stable-native-prompt' });
  f.refuse();
  await assert.rejects(f.post('prompt', { text: 'Refused request' }), { statusCode: 502, code: 'session-prompt-not-accepted' });
});

test('external inbox persistence cannot be mistaken for prompt transmission', async () => {
  const f = fixture({ sessions: { deliverPrompt: undefined } });
  f.rows.set('native-header-id', { ...f.rows.get('native-header-id'), external: true });
  await assert.rejects(f.post('prompt', { text: 'Synthetic user request' }), { statusCode: 503, code: 'session-prompt-receipts-unavailable' });
  assert.equal(f.calls.some(call => call.type === 'command' || call.type === 'prompt'), false);
});

test('continue resumes the persisted header identity and exact file despite a different filename', async () => {
  const f = fixture();
  const row = f.rows.get('native-header-id');
  row.live = false; row.status = 'ended';
  const reply = await f.post('resume', { mode: 'continue' });
  const input = f.calls.find(call => call.type === 'create').input;
  assert.equal(input.sessionId, 'native-header-id');
  assert.equal(input.sessionFile, '/synthetic/history/file-name-a4.jsonl');
  assert.equal(input.resume, true);
  assert.equal(reply.body.data.sessionId, 'native-header-id');
});

test('continue refuses live or alternate writers and managed collaborator forks require a fresh assignment', async () => {
  const f = fixture();
  await assert.rejects(f.post('resume', { mode: 'continue' }), { statusCode: 409, code: 'session-already-active' });
  f.rows.get('native-header-id').live = false;
  f.rows.set('other-writer', { ...f.rows.get('native-header-id'), id: 'other-writer', live: true });
  await assert.rejects(f.post('resume', { mode: 'continue' }), { code: 'session-history-already-active' });
  f.rows.get('native-header-id').researchSession = { parentSessionId: 'lead', spawnToken: 'old-assignment' };
  await assert.rejects(f.post('resume', { mode: 'fork' }), { statusCode: 409, code: 'research-session-fork-assignment-required' });
  assert.equal(f.calls.some(call => call.type === 'create'), false);
});

test('stage spawn joins before initial prompt and verifies native registration and target binding', async () => {
  const f = fixture();
  const reply = await f.spawn({ cwd: '/synthetic/project', initialPrompt: 'Synthetic bounded phase task',
    joinResWorkflow: true, creationEntryPoint: 'research-stage', requestId: 'stable-stage-spawn' });
  assert.equal(reply.body.success, true);
  assert.equal(reply.body.transmitted, true);
  const input = f.calls.find(call => call.type === 'create').input;
  assert.equal(input.prompt, 'Synthetic bounded phase task');
  assert.equal(input.rawRef.resWorkflow.canonicalCwd, '/synthetic/project');
  assert.equal(input.rawRef.sessionCreation.entryPoint, 'research-stage');
  assert.equal(input.principalOwner, undefined);
  const prepared = f.calls.findIndex(call => call.type === 'prepare');
  const launched = f.calls.findIndex(call => call.type === 'create');
  const verified = f.calls.findIndex(call => call.type === 'verify');
  assert.ok(prepared < launched && launched < verified);
  const duplicate = await f.spawn({ cwd: '/synthetic/project', initialPrompt: 'Synthetic bounded phase task',
    joinResWorkflow: true, creationEntryPoint: 'research-stage', requestId: 'stable-stage-spawn' });
  assert.equal(duplicate.body.data.duplicate, true);
  assert.equal(f.calls.filter(call => call.type === 'create').length, 1);
  await assert.rejects(f.spawn({ cwd: '/synthetic/project', initialPrompt: 'Different task', joinResWorkflow: true,
    creationEntryPoint: 'research-stage', requestId: 'stable-stage-spawn' }), { code: 'session-spawn-request-conflict' });
});

test('invalid prompt, ACP, missing workbench and resource refusal stop before a new process', async () => {
  const f = fixture();
  await assert.rejects(f.spawn({ cwd: '/synthetic/project', initialPrompt: 'x'.repeat(16_385) }), { statusCode: 400 });
  await assert.rejects(f.spawn({ cwd: '/synthetic/project', agent: 'codex' }), { statusCode: 501, code: 'session-acp-driver-unavailable' });
  await assert.rejects(f.spawn({ cwd: '/synthetic/project', creationEntryPoint: 'research-stage' }), { statusCode: 400 });
  assert.equal(f.calls.some(call => call.type === 'create'), false);
  const noBinding = fixture({ workbench: { prepareSpawn: undefined } });
  await assert.rejects(noBinding.spawn({ cwd: '/synthetic/project', joinResWorkflow: true }), { statusCode: 503 });
  const resourceBlocked = fixture({ beforeLaunch: async () => { throw Object.assign(new Error('resource blocked'), { code: 'resource-blocked' }); } });
  await assert.rejects(resourceBlocked.spawn({ cwd: '/synthetic/project' }), { code: 'resource-blocked' });
  assert.equal(resourceBlocked.calls.some(call => call.type === 'create'), false);
});

test('unconfirmed first prompt or native registration is a failed spawn response', async () => {
  const f = fixture();
  const realCreate = f.sessions.createSession;
  f.sessions.createSession = async input => {
    const result = await realCreate(input);
    f.rows.get(result.sessionId).initialPromptStatus = 'sending';
    return result;
  };
  await assert.rejects(f.spawn({ cwd: '/synthetic/project', initialPrompt: 'Synthetic request' }), { statusCode: 503, code: 'session-spawn-unconfirmed' });
});

test('configured ACP spawn returns ready native identity, persists correlation and cannot replay a launch', async () => {
  const f = fixture();
  f.sessions.acpAgents = () => [{ id: 'fixture-agent', name: 'Fixture' }];
  f.sessions.startAcp = async input => {
    f.calls.push({ type: 'acp-create', input });
    f.rows.set(input.sessionId, { ...input.metadata, id: input.sessionId, cwd: input.cwd, driver: 'acp',
      acpAgentId: input.agent, live: true, status: 'idle', nativeRegistrationConfirmed: true });
    return { success: true, sessionId: input.sessionId, nativeRegistrationConfirmed: true, driver: 'acp' };
  };
  const body = { cwd: '/synthetic/project', agent: 'fixture-agent', requestId: 'stable-acp-spawn', name: 'ACP session' };
  const started = await f.spawn(body);
  assert.equal(started.body.success, true);
  assert.equal(started.body.data.driver, 'acp');
  const created = f.calls.find(call => call.type === 'acp-create').input;
  assert.equal(created.prompt, undefined);
  assert.equal(created.rawRef, undefined);
  assert.equal(created.principalOwner, undefined);
  assert.equal(created.name, 'ACP session');
  assert.match(created.spawnToken, /^[a-f0-9-]{36}$/);
  const duplicate = await f.spawn(body);
  assert.equal(duplicate.body.data.duplicate, true);
  assert.equal(duplicate.body.data.sessionId, started.body.data.sessionId);
  assert.equal(f.calls.filter(call => call.type === 'acp-create').length, 1);
  await assert.rejects(f.spawn({ ...body, name: 'Different session' }), { code: 'session-spawn-request-conflict' });
});

test('legacy ACP first prompt and workflow join retain exact pre-launch refusal codes', async () => {
  const f = fixture({ sessions: { acpAgents: () => [{ id: 'fixture-agent', name: 'Fixture' }],
    startAcp: async () => assert.fail('Rejected legacy ACP request launched a process') } });
  const base = { cwd: '/synthetic/project', agent: 'fixture-agent' };
  const prompt = await f.spawn({ ...base, initialPrompt: 'Unsupported first prompt' });
  assert.equal(prompt.statusCode, 400);
  assert.equal(prompt.body.code, 'INITIAL_PROMPT_UNSUPPORTED_ACP');
  const join = await f.spawn({ ...base, joinResWorkflow: true, creationEntryPoint: 'research-stage' });
  assert.equal(join.statusCode, 400);
  assert.equal(join.body.code, 'JOIN_RES_WORKFLOW_UNSUPPORTED_ACP');
  assert.equal((await f.spawn({ ...base, agent: 'unknown' })).statusCode, 400);
  assert.equal(f.calls.some(call => call.type === 'create' || call.type === 'prepare'), false);
});

test('ACP start failure and absent native readiness cannot return successful spawn', async () => {
  const f = fixture({ sessions: { acpAgents: () => [{ id: 'fixture-agent', name: 'Fixture' }],
    startAcp: async () => ({ success: false, code: 'acp-initialize-failed', message: 'Fixture initialization refused' }) } });
  const body = { cwd: '/synthetic/project', agent: 'fixture-agent' };
  const refused = await f.spawn(body);
  assert.equal(refused.statusCode, 503);
  assert.equal(refused.body.success, false);
  assert.equal(refused.body.code, 'acp-initialize-failed');
  f.sessions.startAcp = async input => {
    f.rows.set(input.sessionId, { id: input.sessionId, cwd: input.cwd, driver: 'acp', live: true, nativeRegistrationConfirmed: false });
    return { success: true, sessionId: input.sessionId };
  };
  await assert.rejects(f.spawn(body), { code: 'session-spawn-unconfirmed' });
});

test('rename persists user provenance and model and thinking changes require native success', async () => {
  const f = fixture();
  assert.equal((await f.post('rename', { name: 'Human chosen name' })).body.success, true);
  assert.equal(f.rows.get('native-header-id').nameSource, 'user');
  assert.deepEqual(f.calls.find(call => call.type === 'command').input, { type: 'set_session_name', name: 'Human chosen name' });
  await f.post('model', { provider: 'synthetic', modelId: 'new-model' });
  assert.equal(f.rows.get('native-header-id').model, 'synthetic/new-model');
  await f.post('thinking-level', { level: 'xhigh' });
  assert.equal(f.rows.get('native-header-id').thinkingLevel, 'xhigh');
  f.sessions.command = async () => ({ success: false });
  await assert.rejects(f.post('model', { provider: 'synthetic', modelId: 'refused' }), { code: 'native-command-rejected' });
  assert.equal(f.rows.get('native-header-id').model, 'synthetic/new-model');
});

test('legacy UI answers map to the exact pending native confirm, select and editor IDs', async () => {
  const f = fixture();
  f.rows.get('native-header-id').pendingUIRequests = [
    { id: 'confirm-exact', method: 'confirm' },
    { id: 'select-exact', method: 'select', options: ['Approve', 'Decline'] },
    { id: 'editor-exact', method: 'editor' },
  ];
  await f.post('extension-ui-response', { requestId: 'confirm-exact', result: false });
  await f.post('extension-ui-response', { requestId: 'select-exact', result: 'Decline' });
  await f.post('extension-ui-response', { requestId: 'editor-exact', cancelled: true });
  const answers = f.calls.filter(call => call.type === 'ui').map(call => call.input);
  assert.deepEqual(answers, [
    { type: 'extension_ui_response', id: 'confirm-exact', confirmed: false },
    { type: 'extension_ui_response', id: 'select-exact', value: 'Decline' },
    { type: 'extension_ui_response', id: 'editor-exact', cancelled: true },
  ]);
  await assert.rejects(f.post('extension-ui-response', { requestId: 'wrong-id', result: true }), { code: 'native-ui-request-not-pending' });
});

test('shutdown distinguishes pending process exit and marks explicit manual closure', async () => {
  const f = fixture();
  const result = await f.post('shutdown');
  assert.deepEqual(result.body, { success: true, pending: true });
  assert.equal(f.rows.get('native-header-id').closedReason, 'manual');
  await f.post('abort');
  assert.equal(f.calls.some(call => call.type === 'abort'), true);
});

test('proposal and cooperative lifecycle controls require a native receipt provider', async () => {
  const f = fixture();
  await assert.rejects(f.post('attach-proposal', { changeName: 'valid-change' }), { statusCode: 501, code: 'native-session-control-events-unavailable' });
  await assert.rejects(f.post('detach-proposal'), { statusCode: 501, code: 'native-session-control-events-unavailable' });
  await assert.rejects(f.post('flow-control', { action: 'toggle_autonomous' }), { statusCode: 501 });
  await assert.rejects(f.post('lifecycle', { action: 'retry' }), { statusCode: 501, code: 'native-session-control-events-unavailable' });
  assert.equal(await f.handle({ method: 'GET', pathname: '/api/session/native-header-id/prompt', body: null }), null);
});

test('archive waits for exact worker end and unarchive restores visibility without starting a worker', async () => {
  const f = fixture();
  f.sessions.terminate = async id => {
    const row = f.rows.get(id);
    row.live = false; row.status = 'ended';
    f.calls.push({ type: 'terminate', id });
    return { stopped: true, workerExited: true };
  };
  const archived = await f.post('archive');
  assert.deepEqual(archived.body, { success: true });
  assert.equal(f.rows.get('native-header-id').archived, true);
  assert.equal(f.rows.get('native-header-id').closedReason, 'manual');
  const live = await f.handle({ method: 'GET', pathname: '/api/sessions' });
  assert.deepEqual(live.body.data, []);
  const listed = await f.handle({ method: 'GET', pathname: '/api/sessions/archived', url: new URL('http://localhost/api/sessions/archived?limit=1') });
  assert.equal(listed.body.data.items[0].id, 'native-header-id');
  assert.equal((await f.post('unarchive')).body.success, true);
  const row = f.rows.get('native-header-id');
  assert.equal(row.archived, false);
  assert.equal(row.hidden, false);
  assert.equal(row.status, 'ended');
  assert.equal(f.calls.some(call => call.type === 'create'), false);
});

test('archive refuses running or unknown sessions before recording intent', async () => {
  const f = fixture();
  f.rows.get('native-header-id').status = 'streaming';
  await assert.rejects(f.post('archive'), { statusCode: 409, code: 'session-is-running' });
  f.rows.get('native-header-id').status = 'unknown';
  await assert.rejects(f.post('archive'), { statusCode: 409, code: 'session-live-outcome-unknown' });
  assert.equal(f.calls.some(call => call.type === 'update'), false);
});

test('durable ACP metadata is awaited before shutdown, archive success and restore response', async () => {
  let f;
  let notify;
  const writes = [];
  f = fixture({ sessions: {
    subscribeEvents: handler => { notify = handler; return () => {}; },
    updateSession: async (id, patch) => {
      writes.push(patch);
      await new Promise(resolve => setTimeout(resolve, 3));
      f.rows.set(id, { ...f.rows.get(id), ...patch });
      notify?.(id, { type: 'metadata_changed' });
    },
    terminate: async id => {
      assert.ok(f.rows.get(id).archiveRequestedAt);
      f.rows.set(id, { ...f.rows.get(id), status: 'ended', live: false });
      notify?.(id, { type: 'session_end' });
      return { stopped: true };
    },
  } });
  f.rows.get('native-header-id').driver = 'acp';
  assert.equal((await f.post('archive')).body.success, true);
  assert.equal(f.rows.get('native-header-id').archived, true);
  assert.equal(writes.filter(patch => patch.archived === true).length, 1);
  assert.equal((await f.post('unarchive')).body.success, true);
  assert.equal(f.rows.get('native-header-id').archived, false);
  assert.equal((await f.post('rename', { name: 'Durable name' })).body.success, true);
  assert.equal(f.rows.get('native-header-id').name, 'Durable name');
  f.handle.dispose();
});

test('a pending archive request survives host restart and settles only after confirmed process end', async () => {
  const f = fixture({ sessions: { terminate: async () => ({ stopped: false, state: 'stopping' }) } });
  const pending = await f.post('archive');
  assert.equal(pending.statusCode, 202);
  assert.equal(pending.body.pending, true);
  assert.equal(f.rows.get('native-header-id').archived, undefined);
  assert.ok(f.rows.get('native-header-id').archiveRequestedAt);
  f.handle.dispose();
  f.rows.get('native-header-id').status = 'ended';
  f.rows.get('native-header-id').live = false;
  const resumed = createSessionCompatibility({ sessions: f.sessions, workbench: f.workbench, localOperatorPrincipal: f.principal });
  assert.equal(f.rows.get('native-header-id').archived, true);
  assert.equal(f.rows.get('native-header-id').archiveRequestedAt, undefined);
  resumed.dispose();
});

test('archived listing has stable paging, searchable records and explicit invalid cursor errors', async () => {
  const f = fixture();
  for (let number = 1; number <= 3; number++) f.rows.set('archived-' + number, {
    id: 'archived-' + number, cwd: '/synthetic/project', archived: true, archivedAt: number,
    name: 'Synthetic archived ' + number, status: 'ended', live: false,
  });
  const list = query => f.handle({ method: 'GET', pathname: '/api/sessions/archived', url: new URL('http://localhost/api/sessions/archived?' + query) });
  const first = await list('limit=2');
  assert.deepEqual(first.body.data.items.map(row => row.id), ['archived-3', 'archived-2']);
  const second = await list('limit=2&cursor=' + encodeURIComponent(first.body.data.nextCursor));
  assert.deepEqual(second.body.data.items.map(row => row.id), ['archived-1']);
  assert.equal(second.body.data.nextCursor, undefined);
  const searched = await list('q=' + encodeURIComponent('archived 2'));
  assert.deepEqual(searched.body.data.items.map(row => row.id), ['archived-2']);
  await assert.rejects(list('cursor=not-a-cursor'), { statusCode: 400, code: 'invalid-session-archive-cursor' });
});

test('legacy archive deletion requires an archived row and the native deletion hook', async () => {
  const f = fixture();
  const request = () => f.handle({ method: 'DELETE', pathname: '/api/sessions/archived/native-header-id', body: {} });
  await assert.rejects(request(), { statusCode: 404, code: 'session-not-archived' });
  Object.assign(f.rows.get('native-header-id'), { archived: true, live: false, status: 'ended' });
  await assert.rejects(request(), { statusCode: 501, code: 'session-archive-delete-unavailable' });
  f.sessions.deleteArchivedSession = async id => { f.calls.push({ type: 'delete', id }); f.rows.delete(id); return { success: true }; };
  assert.equal((await request()).body.success, true);
  assert.equal(f.rows.has('native-header-id'), false);
});
