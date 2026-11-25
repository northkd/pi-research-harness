import assert from 'node:assert/strict';
import os from 'node:os';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { createResearchApi } from '../api.mjs';
import { createHostClient } from './client.mjs';
import { runCli } from './main.mjs';

function fixture() {
  const calls = [];
  const sessionRows = [{ id: 'lead', cwd: os.tmpdir(), status: 'idle', eventCursor: 1, pendingUIRequests: [] }];
  const services = {
    dispatch: { handle: async ({ body }) => { calls.push({ action: 'dispatch', body }); return { status: 'ok', sessionId: body.sessionId, plans: [] }; } },
    communication: {}, sessions: {},
    collaboration: { snapshot: async () => ({ revision: 5, currentMainSessionId: 'lead', limits: { maxMultiAgents: 4, maxSubagents: 3 }, plans: [] }) },
  };
  const api = createResearchApi({
    services,
    sessions: {
      listSessions: () => sessionRows,
      getSession: id => sessionRows.find(row => row.id === id),
      createSession: async input => { calls.push({ action: 'session-start', body: input }); return { success: true, sessionId: 'new-session', status: 'idle' }; },
      readEvents: async (_id, input) => ({ events: input.after ? [] : [{ sequence: 1, event: { type: 'agent_settled' } }], nextCursor: 1 }),
      command: async (id, body) => { calls.push({ action: 'command', id, body }); return { success: true, type: 'response', data: { disposition: 'queued' } }; },
      respondUi: async (id, body) => { calls.push({ action: 'ui', id, body }); return { success: true }; },
      abort: async () => ({ success: true }),
      terminate: async () => ({ success: true }),
    },
    workbench: {
      accessFor: async (cwd, identity) => ({ cwd, ...identity }),
      snapshot: async access => ({ cwd: access.cwd, adopted: true, research: {}, adoption: null }),
    },
    adoption: {
      create: async (_access, body) => { calls.push({ action: 'adoption', body }); return { id: 'adopt-new', status: 'inventory', progress: { files: 0 } }; },
      historyCandidates: async () => ({ candidates: [{ id: 'source-one', sessionId: 'lead', kind: 'local', registered: true }], partial: false, skipped: [] }),
    },
    localOperatorPrincipal: { iss: 'urn:pi-research:local-operator', sub: 'local-operator' },
  });
  const statuses = [];
  const request = createHostClient({ auth: { baseUrl: 'http://127.0.0.1:18768', token: 'synthetic' }, fetchImpl: async (url, options) => {
    const result = await api({ method: options.method, pathname: url.pathname, url, body: options.body ? JSON.parse(options.body) : null });
    assert.ok(result, `Missing route ${url.pathname}`);
    statuses.push(result.statusCode);
    return Response.json(result.body, { status: result.statusCode });
  } });
  let output = '';
  const stdout = new Writable({ write(chunk, _encoding, done) { output += chunk.toString(); done(); } });
  return { calls, statuses, request, output: () => output, reset: () => { output = ''; }, dependencies: { cwd: os.tmpdir(), request, stdout, stderr: stdout, stdin: new PassThrough() } };
}

test('CLI and API agree on session IDs, native accepted disposition and durable event cursor', async () => {
  const f = fixture();
  await runCli(['sessions', 'start', '--json'], f.dependencies);
  assert.equal(JSON.parse(f.output()).sessionId, 'new-session');
  assert.equal(f.statuses[0], 201);
  f.reset();
  await runCli(['sessions', 'send', 'lead', 'Synthetic task', '--json'], f.dependencies);
  assert.equal(JSON.parse(f.output()).data.disposition, 'queued');
  assert.deepEqual(f.calls[1].body, { type: 'prompt', message: 'Synthetic task', streamingBehavior: 'steer' });
  f.reset();
  await runCli(['sessions', 'attach', 'lead', '--json', '--once'], f.dependencies);
  assert.deepEqual(JSON.parse(f.output()), { sequence: 1, event: { type: 'agent_settled' } });
});

test('CLI and API preserve asynchronous adoption progress and explicit source selection', async () => {
  const f = fixture();
  await runCli(['adoption', 'create', '--history', 'source-one', '--request-id', 'stable-intake', '--json'], f.dependencies);
  assert.equal(f.statuses[0], 202);
  const reply = JSON.parse(f.output());
  assert.equal(reply.adoption.status, 'inventory');
  assert.deepEqual(f.calls[0].body.historySelection, ['source-one']);
  assert.equal(f.calls[0].body.requestId, 'stable-intake');
  f.reset();
  await runCli(['history', '--json'], f.dependencies);
  assert.equal(JSON.parse(f.output()).candidates[0].id, 'source-one');
});

test('CLI raw local API preserves explicit native UI response identity', async () => {
  const f = fixture();
  const result = await f.request('POST', '/api/sessions/lead/ui', { type: 'extension_ui_response', id: 'exact-native-question', confirmed: false });
  assert.equal(result.success, true);
  assert.deepEqual(f.calls[0], { action: 'ui', id: 'lead', body: { type: 'extension_ui_response', id: 'exact-native-question', confirmed: false } });
});
