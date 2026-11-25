import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { attachSession } from './attach.mjs';
import { CliError, createHostClient, loadHostAuth } from './client.mjs';
import { modelReference, parseArguments, runCli } from './main.mjs';

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _encoding, done) { text += chunk.toString(); done(); } });
  return { stream, text: () => text };
}

function context(overrides = {}) {
  const out = sink(), err = sink();
  return { out, err, dependencies: { cwd: os.tmpdir(), stdin: new PassThrough(), stdout: out.stream, stderr: err.stream, ...overrides } };
}

function jsonFile(t, body) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-cli-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'request.json');
  fs.writeFileSync(file, JSON.stringify(body));
  return file;
}

test('argument parsing preserves explicit history selection and literal prompt text', () => {
  assert.deepEqual(parseArguments(['adoption', 'create', '--history', 'one', '--history=two', '--json']).options, { history: ['one', 'two'], json: true });
  assert.deepEqual(parseArguments(['sessions', 'send', 'session', '--', '--flag is literal']).words, ['sessions', 'send', 'session', '--flag is literal']);
  assert.throws(() => parseArguments(['status', '--unknown']), /未知选项/);
  assert.throws(() => parseArguments(['status', '--cwd', '--json']), /需要值/);
  assert.deepEqual(modelReference('provider/model/with/slashes'), { provider: 'provider', id: 'model/with/slashes' });
});

test('local auth accepts private token and rejects public token, symlink and remote destinations', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'research-cli-auth-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.mkdirSync(path.join(directory, 'local'));
  fs.writeFileSync(path.join(directory, 'config.json'), JSON.stringify({ bindHost: '127.0.0.1', port: 18768 }));
  const token = path.join(directory, 'local/token');
  fs.writeFileSync(token, 'synthetic-private-token\n', { mode: 0o600 });
  const env = { PI_RESEARCH_HOST_DIR: directory };
  assert.deepEqual(loadHostAuth({ env }), { baseUrl: 'http://127.0.0.1:18768', token: 'synthetic-private-token' });
  fs.chmodSync(token, 0o644);
  assert.throws(() => loadHostAuth({ env }), { code: 'host-auth-unsafe' });
  fs.unlinkSync(token);
  fs.writeFileSync(path.join(directory, 'secret'), 'synthetic-private-token', { mode: 0o600 });
  fs.symlinkSync(path.join(directory, 'secret'), token);
  assert.throws(() => loadHostAuth({ env }), { code: 'host-auth-unsafe' });
  assert.throws(() => createHostClient({ auth: { baseUrl: 'https://remote.invalid', token: 'synthetic' } }), { code: 'host-destination-invalid' });
});

test('transport preserves accepted progress, checks action failures and never retries unknown mutations', async () => {
  const calls = [];
  const request = createHostClient({ auth: { baseUrl: 'http://127.0.0.1:18768', token: 'synthetic' }, fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ adoption: { id: 'adopt-synthetic', status: 'analyzing', progress: { files: 2 } } }, { status: 202 });
  } });
  const reply = await request('POST', '/api/res-workflow/adoptions', { requestId: 'known-request' });
  assert.equal(reply.adoption.status, 'analyzing');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers['x-pi-local-token'], 'synthetic');
  await assert.rejects(request('GET', 'https://remote.invalid/api/x'), { code: 'host-endpoint-invalid' });
  await assert.rejects(request('GET', '/api/../../outside'), { code: 'host-endpoint-invalid' });
  assert.equal(calls.length, 1);
  let failedCalls = 0;
  const failed = createHostClient({ auth: { baseUrl: 'http://127.0.0.1:18768', token: 'synthetic' }, fetchImpl: async () => { failedCalls++; throw new TypeError('connection-reset'); } });
  await assert.rejects(failed('POST', '/api/res-workflow/adoptions', {}), { code: 'host-request-unconfirmed' });
  assert.equal(failedCalls, 1);
  const refused = createHostClient({ auth: { baseUrl: 'http://127.0.0.1:18768', token: 'synthetic' }, fetchImpl: async () => Response.json({ success: false, code: 'scope-changed' }) });
  await assert.rejects(refused('GET', '/api/sessions'), { code: 'scope-changed' });
});

test('queue plan approval displays complete input and decline submits no action', async t => {
  const body = { tasks: [{ id: 'one', role: 'research-worker', task: 'Synthetic bounded task', stage: '2-experiment' }] };
  const file = jsonFile(t, body);
  const calls = [];
  const ctx = context({ confirm: async () => false, request: async (...args) => calls.push(args) });
  await assert.rejects(runCli(['queue', 'plan', '--session', 'lead', '--body', file], ctx.dependencies), { code: 'cli-cancelled' });
  assert.equal(calls.length, 0);
  assert.match(ctx.out.text(), /Synthetic bounded task/);
  const accepted = context({ request: async (...args) => { calls.push(args); return { status: 'ok', plans: [] }; } });
  await runCli(['queue', 'plan', '--session', 'lead', '--body', file, '--yes', '--request-id', 'stable-plan', '--json'], accepted.dependencies);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['POST', '/api/res-workflow/dispatch']);
  assert.equal(calls[0][2].planId, 'stable-plan');
  assert.equal(calls[0][2].sessionId, 'lead');
});

test('charter rebind uses current hashes and revision after human confirmation', async () => {
  const calls = [];
  const binding = { canRebind: true, adoptionId: 'adopt-synthetic', bindingRevision: 7,
    boundCharterHash: 'sha256:old', currentCharterHash: 'sha256:current', currentCharter: { objective: 'Synthetic current goal' } };
  const ctx = context({ confirm: async () => true, request: async (method, route, body) => {
    calls.push({ method, route, body });
    return method === 'GET' ? binding : { status: 'current' };
  } });
  await runCli(['target', 'bind', '--request-id', 'stable-binding'], ctx.dependencies);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].body, { cwd: fs.realpathSync(os.tmpdir()), adoptionId: binding.adoptionId,
    expectedBindingRevision: 7, expectedBoundCharterHash: 'sha256:old', expectedCharterHash: 'sha256:current', requestId: 'stable-binding' });
});

test('adoption defaults to empty history selection and requires approval for model material consent', async t => {
  const calls = [];
  const ctx = context({ request: async (method, route, body) => { calls.push({ method, route, body }); return { adoption: { status: 'inventory' } }; } });
  await runCli(['adoption', 'create', '--request-id', 'synthetic-local'], ctx.dependencies);
  assert.deepEqual(calls[0].body.historySelection, []);
  assert.equal(calls[0].body.consent, undefined);
  const file = jsonFile(t, { model: { provider: 'synthetic', id: 'synthetic-model' }, consent: { scope: 'research-files-and-normal-messages', includeUnpublished: true } });
  const declined = context({ confirm: async () => false, request: ctx.dependencies.request });
  await assert.rejects(runCli(['adoption', 'create', '--body', file], declined.dependencies), { code: 'cli-cancelled' });
  assert.equal(calls.length, 1);
});

test('attach replays stable cursors and omits resolved historical confirmations', async () => {
  const out = sink(), err = sink();
  const requested = [];
  const reply = await attachSession({ id: 'lead', request: async (method, route) => {
    requested.push({ method, route });
    if (route === '/api/sessions') return [{ id: 'lead', eventCursor: 4, pendingUIRequests: [] }];
    return { events: [
      { sequence: 1, event: { type: 'extension_ui_request', id: 'old', method: 'confirm', title: 'DO NOT ASK AGAIN' } },
      { sequence: 2, event: { type: 'extension_ui_resolved', id: 'old' } },
      { sequence: 3, event: { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'saved text' } } },
      { sequence: 4, event: { type: 'agent_settled' } },
    ], nextCursor: 4 };
  }, stdin: new PassThrough(), stdout: out.stream, stderr: err.stream, once: true });
  assert.equal(reply.nextCursor, 4);
  assert.match(out.text(), /saved text/);
  assert.doesNotMatch(out.text(), /DO NOT ASK AGAIN/);
  assert.equal(requested[1].route, '/api/sessions/lead/events?after=0&limit=200');
});

test('attach forwards a pending native selection and detach leaves worker running', async () => {
  const input = new PassThrough();
  const out = sink(), err = sink();
  const calls = [];
  const pending = { type: 'extension_ui_request', id: 'pick', method: 'select', title: 'Select an option', options: ['Allow', 'Block'] };
  const request = async (method, route, body) => {
    calls.push({ method, route, body });
    if (route === '/api/sessions') return [{ id: 'lead', eventCursor: 1, pendingUIRequests: [pending] }];
    if (method === 'GET') return { events: [{ sequence: 1, event: pending }], nextCursor: 1 };
    return { success: true };
  };
  const promise = attachSession({ id: 'lead', request, stdin: input, stdout: out.stream, stderr: err.stream, intervalMs: 1 });
  input.end('2\n/detach\n');
  const result = await promise;
  assert.equal(result.detached, true);
  const answer = calls.find(row => row.route.endsWith('/ui'));
  assert.deepEqual(answer.body, { type: 'extension_ui_response', id: 'pick', value: 'Block' });
  assert.equal(calls.some(row => row.route.endsWith('/stop') || row.route.endsWith('/abort')), false);
  assert.equal(err.text(), '');
});

test('new dialogs arriving during journal catchup are actionable after the inventory cursor', async () => {
  const out = sink(), err = sink();
  await attachSession({ id: 'lead', request: async (_method, route) => route === '/api/sessions'
    ? [{ id: 'lead', eventCursor: 0, pendingUIRequests: [] }]
    : { events: [{ sequence: 1, event: { type: 'extension_ui_request', id: 'fresh', method: 'confirm', title: 'NEW APPROVAL' } }], nextCursor: 1 },
  stdin: new PassThrough(), stdout: out.stream, stderr: err.stream, once: true });
  assert.match(out.text(), /NEW APPROVAL/);
});

test('JSON attach preserves native records and opaque IDs for another client', async () => {
  const out = sink(), err = sink();
  const event = { sequence: 7, event: { type: 'extension_ui_request', id: 'native-id', method: 'confirm', title: 'Synthetic' } };
  await attachSession({ id: 'lead', request: async (_method, route) => route === '/api/sessions'
    ? [{ id: 'lead', eventCursor: 7, pendingUIRequests: [event.event] }]
    : { events: [event], nextCursor: 7 }, stdin: new PassThrough(), stdout: out.stream, stderr: err.stream, json: true, after: 6, once: true });
  assert.deepEqual(JSON.parse(out.text()), event);
});
