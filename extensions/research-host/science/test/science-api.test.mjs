import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createScienceApi, createScienceInstancesHost, SCIENCE_HOST_OPEN_DEADLINE_MS } from '../index.mjs';

const cwd = '/synthetic/project';
const principal = { iss: 'synthetic', sub: 'alice' };
const ownerKey = JSON.stringify([principal.iss, principal.sub]);
const taskId = 'si-00000000-0000-4000-8000-000000000001';
const artifactId = 'sa-00000000-0000-4000-8000-000000000002';
const content = Buffer.from('value\n1\n2\n3\n');
const artifact = { id: artifactId, name: 'values.csv', mediaType: 'text/csv', bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') };
const summary = { id: taskId, status: 'waiting-approval', createdAt: 1000, lastObservedAt: 2000, stale: false };
const detail = { ...summary, modelIds: ['ark-sci-deepseek-v4.1-flash'], usage: null, cost: null, artifacts: [artifact] };

function fixture(t, extra = {}) {
  const state = { revoked: false, calls: [], input: [], frames: [], unsubscribed: 0 };
  const host = { list: async partition => { state.calls.push(['list', partition]); return { availability: 'ready', instances: [{ ...summary, prompt: 'PRIVATE PROMPT', url: 'http://private/?nonce=secret' }] }; },
    detail: async (partition, id) => { state.calls.push(['detail', partition, id]); return { availability: 'ready', instance: { ...detail, root: '/private', ownerKey: 'OTHER' } }; },
    readArtifact: async (partition, id, selected) => { state.calls.push(['artifact', partition, id, selected]); return { availability: 'ready', artifact, content }; } };
  const accessFor = async (selectedCwd, identity) => {
    if (selectedCwd !== cwd || identity.principal !== principal) throw Object.assign(new Error('workspace-not-found'), { code: 'workspace-not-found', statusCode: 404 });
    if (identity.expiresAt && identity.expiresAt < Date.now()) throw Object.assign(new Error('adoption-identity-expired'), { code: 'adoption-identity-expired', statusCode: 403 });
    return { cwd, ownerKey, write: identity.write, revalidate: async () => {
      if (state.revoked) throw Object.assign(new Error('workspace-not-found'), { code: 'workspace-not-found', statusCode: 404 });
    } };
  };
  const viewHost = { openWorkspace: async partition => {
    state.calls.push(['open', partition]);
    return { availability: 'ready', view: { subscribe: async (frame, unavailable) => {
      state.frames.push(frame); state.unavailable = unavailable;
      return { input: async value => { state.input.push(value); }, unsubscribe: () => { state.unsubscribed += 1; } };
    } } };
  } };
  const api = createScienceApi({ useInstalledHost: false, accessFor, scienceInstancesHost: host, scienceViewHost: viewHost, ...extra });
  t.after(() => api.dispose());
  const call = (suffix = '/instances', method = 'GET', body, search = '?cwd=' + encodeURIComponent(cwd), additional = {}) => api.handle({ method, url: new URL('http://127.0.0.1/api/res-workflow/science' + suffix + search), body, principal, ...additional });
  return { api, host, viewHost, state, call };
}

test('list and detail use trusted partitions and remove private host fields', async t => {
  const f = fixture(t);
  const listed = await f.call();
  assert.deepEqual(listed.body, { availability: 'ready', instances: [summary] });
  assert.deepEqual(f.state.calls[0], ['list', { ownerKey, cwd }]);
  assert.equal(listed.headers['Cache-Control'], 'private, no-store');
  assert.equal(listed.headers.Vary, 'Cookie, Authorization');
  const selected = await f.call('/instances/' + taskId);
  assert.deepEqual(selected.body, { availability: 'ready', instance: detail });
  assert.doesNotMatch(JSON.stringify(selected.body), /PRIVATE|OTHER|private|nonce/);
});

test('rider queries, duplicate cwd, unsafe IDs and GET bodies fail before the host', async t => {
  const f = fixture(t);
  for (const search of ['?cwd=' + encodeURIComponent(cwd) + '&ownerKey=other', '?cwd=' + encodeURIComponent(cwd) + '&cwd=' + encodeURIComponent(cwd), '?url=http://private', '']) {
    assert.equal((await f.call('/instances', 'GET', undefined, search)).statusCode, 400);
  }
  assert.equal((await f.call('/instances/arbitrary')).statusCode, 400);
  assert.equal((await f.call(`/instances/${taskId}/artifacts/unsafe`)).statusCode, 400);
  assert.equal((await f.call('/instances', 'GET', { cwd })).statusCode, 400);
  assert.equal(f.state.calls.length, 0);
  assert.equal(await f.call('/instances', 'POST', {}), null);
});

test('foreign and expired admission deny reads before accessing records', async t => {
  const f = fixture(t);
  assert.equal((await f.call('/instances', 'GET', undefined, '?cwd=' + encodeURIComponent(cwd), { principal: { ...principal } })).statusCode, 404);
  assert.equal((await f.call('/instances', 'GET', undefined, '?cwd=' + encodeURIComponent(cwd), { principalExpiresAt: Date.now() - 1 })).statusCode, 403);
  assert.equal(f.state.calls.length, 0);
});

test('ownership is rechecked after asynchronous record reads and artifact reads', async t => {
  const f = fixture(t);
  f.host.list = async () => { f.state.revoked = true; return { availability: 'ready', instances: [summary] }; };
  const list = await f.call();
  assert.equal(list.statusCode, 404);
  assert.doesNotMatch(JSON.stringify(list.body), /si-/);
  f.state.revoked = false;
  f.host.readArtifact = async () => { f.state.revoked = true; return { availability: 'ready', artifact, content }; };
  const bytes = await f.call(`/instances/${taskId}/artifacts/${artifactId}`);
  assert.equal(bytes.statusCode, 404);
  assert.doesNotMatch(JSON.stringify(bytes.body), /value/);
});

test('artifact reads return exact verified bytes and inert content headers', async t => {
  const f = fixture(t);
  const result = await f.call(`/instances/${taskId}/artifacts/${artifactId}`);
  assert.equal(result.statusCode, 200);
  assert.ok(Buffer.isBuffer(result.body));
  assert.deepEqual(result.body, content);
  assert.equal(result.headers['Content-Type'], 'text/csv');
  assert.equal(result.headers['X-Science-Artifact-Sha256'], artifact.sha256);
  assert.match(result.headers['Content-Disposition'], /attachment; filename=/);
  assert.match(result.headers['Content-Security-Policy'], /sandbox/);
  assert.equal(result.headers['X-Content-Type-Options'], 'nosniff');
  assert.deepEqual(f.state.calls[0], ['artifact', { ownerKey, cwd }, taskId, artifactId]);
});

test('malformed metadata, false completion data and artifact integrity failures stay unavailable', async t => {
  const f = fixture(t);
  f.host.list = async () => ({ availability: 'ready', instances: [{ ...summary, id: 'http://private' }] });
  assert.deepEqual((await f.call()).body, { availability: 'unknown', reason: 'invalid-host-response' });
  f.host.detail = async () => ({ availability: 'ready', instance: { ...detail, id: 'si-00000000-0000-4000-8000-000000000099' } });
  assert.deepEqual((await f.call('/instances/' + taskId)).body, { availability: 'unknown', reason: 'invalid-host-response' });
  for (const value of [
    { artifact, content: Buffer.from('wrong') },
    { artifact: { ...artifact, name: '../../secret' }, content },
    { artifact: { ...artifact, mediaType: 'image/png' }, content },
    { artifact: { ...artifact, mediaType: 'text/html' }, content },
  ]) {
    f.host.readArtifact = async () => ({ availability: 'ready', ...value });
    const result = await f.call(`/instances/${taskId}/artifacts/${artifactId}`);
    assert.equal(result.statusCode, 503);
    assert.deepEqual(result.body, { availability: 'unknown', reason: 'invalid-host-response' });
  }
});

test('unconfigured and offline hosts preserve their actual availability', async t => {
  const f = fixture(t, { scienceInstancesHost: undefined, scienceViewHost: undefined });
  assert.deepEqual((await f.call()).body, { availability: 'unavailable', reason: 'host-unconfigured' });
  assert.equal((await f.call(`/instances/${taskId}/artifacts/${artifactId}`)).statusCode, 503);
  const other = fixture(t);
  other.host.list = async () => { throw new Error('private endpoint credential'); };
  assert.deepEqual((await other.call()).body, { availability: 'unknown', reason: 'host-offline' });
  other.host.readArtifact = async () => ({ availability: 'unavailable', reason: 'binding-unavailable' });
  assert.equal((await other.call(`/instances/${taskId}/artifacts/${artifactId}`)).statusCode, 404);
});

test('viewer open uses a finite lease and only exact authenticated subscriptions receive frames', async t => {
  const f = fixture(t);
  const result = await f.call('/view', 'POST', { cwd, target: { kind: 'workspace' } }, '');
  assert.equal(result.body.availability, 'ready');
  assert.match(result.body.leaseId, /^sv-[a-f0-9]{48}$/);
  const received = [];
  const socket = { principal, readyState: 1, sessionTier: () => 'observe', send: value => received.push(JSON.parse(value)) };
  const message = { type: 'science_view_subscribe', cwd, leaseId: result.body.leaseId };
  await f.api.handleMessage(message, socket);
  f.state.frames[0]({ jpegBase64: '/9j/2Q==', metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1 } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(received.some(value => value.type === 'science_view_frame'));
  f.api.disconnect(socket);
  assert.equal(f.state.unsubscribed, 1);
  const foreign = { ...socket, principal: { ...principal }, send: value => received.push(JSON.parse(value)) };
  await f.api.handleMessage(message, foreign);
  assert.equal(f.state.frames.length, 1);
});

test('viewer control requires a current write admission and operate tier', async t => {
  const f = fixture(t);
  const opened = await f.call('/view', 'POST', { cwd, target: { kind: 'workspace' } }, '');
  const socket = { principal, readyState: 1, sessionTier: () => 'operate', send() {} };
  const base = { cwd, leaseId: opened.body.leaseId };
  await f.api.handleMessage({ ...base, type: 'science_view_subscribe' }, socket);
  const input = { kind: 'resize', width: 900, height: 700 };
  await f.api.handleMessage({ ...base, type: 'science_view_input', input }, socket);
  assert.deepEqual(f.state.input, [input]);
  f.state.revoked = true;
  await f.api.handleMessage({ ...base, type: 'science_view_input', input }, socket);
  assert.equal(f.state.input.length, 1);
  assert.equal(f.state.unsubscribed, 1);
});

test('viewer host open borrows and restores the finite socket budget', async t => {
  const f = fixture(t);
  const socket = { timeout: 15000, setTimeout(value) { this.timeout = value; } };
  const rawRequest = new EventEmitter(); rawRequest.socket = socket;
  const rawResponse = new EventEmitter();
  const result = await f.call('/view', 'POST', { cwd, target: { kind: 'workspace' } }, '', { rawRequest, rawResponse });
  assert.equal(result.body.availability, 'ready');
  assert.equal(socket.timeout, SCIENCE_HOST_OPEN_DEADLINE_MS);
  rawResponse.emit('finish');
  assert.equal(socket.timeout, 15000);
});

test('registry read adapter never opens a writer or accepts another task artifact', async () => {
  const calls = [];
  const host = createScienceInstancesHost({ list: async partition => { calls.push(partition); return [summary]; },
    detail: async () => detail, readArtifact: async () => ({ ...artifact, bytes: content }) });
  assert.deepEqual(await host.list({ ownerKey, cwd }), { availability: 'ready', instances: [summary] });
  const bytes = await host.readArtifact({ ownerKey, cwd }, taskId, artifactId);
  assert.deepEqual(Buffer.from(bytes.content), content);
  assert.deepEqual(calls, [{ ownerKey, cwd }]);
  const foreign = await host.readArtifact({ ownerKey, cwd }, taskId, 'sa-00000000-0000-4000-8000-000000000099');
  assert.deepEqual(foreign, { availability: 'unavailable', reason: 'binding-unavailable' });
});
