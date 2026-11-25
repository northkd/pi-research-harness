import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { liveVerification, waitForOperationalReadiness } from './live-verification.mjs';

const plan = { stateDir: '/fixture/state', publicAddress: 'https://203.0.113.8:8443', tlsStorage: { data: '/fixture/caddy' } };
const healthy = () => ({ status: 200, json: async () => ({ success: true, service: 'pi-research-host' }) });
const refused = () => new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });

function clock() {
  let elapsed = 0;
  return { now: () => elapsed, sleep: async milliseconds => { elapsed += milliseconds; }, elapsed: () => elapsed };
}

function dependencies(extra = {}) {
  return { ...clock(), readConfig: () => ({ port: 18768, token: 'synthetic-private-token' }), fetchFn: async () => healthy(), ...extra };
}

function mockHttps(actions, calls = []) {
  return (options, callback) => {
    calls.push(options);
    const request = new EventEmitter();
    request.destroy = error => queueMicrotask(() => request.emit('error', error));
    queueMicrotask(() => {
      const action = actions.shift() ?? { statusCode: 401, headers: { 'www-authenticate': 'Basic realm="fixture"' }, resume() {} };
      if (action instanceof Error) request.emit('error', action);
      else callback(action);
    });
    return request;
  };
}

test('cold loopback startup can exceed the old 7.5 second window without losing authenticated health proof', async () => {
  let attempts = 0;
  const d = dependencies({ fetchFn: async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:18768/api/health');
    assert.equal(options.headers['x-pi-local-token'], 'synthetic-private-token');
    if (++attempts <= 40) throw refused();
    return healthy();
  } });
  const result = await liveVerification(plan, {}, d).verifyHealth({ publicReady: false });
  assert.equal(result.ok, true); assert.equal(attempts, 41); assert.equal(d.elapsed(), 10_000);
});

test('monotonic deadline reports the precise last retryable network cause', async () => {
  const d = clock();
  await assert.rejects(waitForOperationalReadiness(async () => { throw refused(); }, { ...d, timeoutMs: 1000 }),
    { code: 'rollout-host-startup-timeout-econnrefused' });
  assert.equal(d.elapsed(), 1000);
});

test('health identity, auth status, JSON and private configuration errors fail immediately', async () => {
  const cases = [
    [async () => ({ status: 200, json: async () => ({ success: true, service: 'different-service' }) }), 'rollout-health-identity-mismatch'],
    [async () => ({ status: 401, json: async () => ({}) }), 'rollout-operational-api-unconfirmed'],
    [async () => ({ status: 200, json: async () => { throw new SyntaxError('fixture invalid JSON'); } }), 'rollout-operational-response-invalid'],
  ];
  for (const [fetchFn, code] of cases) {
    const d = dependencies({ fetchFn });
    await assert.rejects(liveVerification(plan, {}, d).verifyHealth({}), { code });
    assert.equal(d.elapsed(), 0);
  }
  const d = dependencies({ readConfig: () => { throw new Error('unsafe-research-host-file'); } });
  await assert.rejects(liveVerification(plan, {}, d).verifyHealth({}), { code: 'rollout-host-unsafe-research-host-file' });
  assert.equal(d.elapsed(), 0);
});

test('public readiness waits for CA creation and Caddy listener before checking the real challenge', async () => {
  let reads = 0;
  const calls = [], d = dependencies({
    readCa: file => {
      assert.equal(file, '/fixture/caddy/pki/authorities/local/root.crt');
      if (++reads <= 2) throw Object.assign(new Error('not ready'), { code: 'ENOENT' });
      return Buffer.from('synthetic-ca');
    },
    httpsGet: mockHttps([Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }), Object.assign(new Error('reset'), { code: 'ECONNRESET' })], calls),
  });
  const result = await liveVerification(plan, {}, d).verifyHealth({ publicReady: true });
  assert.equal(result.ok, true); assert.equal(reads, 5); assert.equal(d.elapsed(), 1000);
  assert.equal(calls.length, 3); assert.equal(calls[0].hostname, '127.0.0.1');
  assert.equal(calls[0].servername, '203.0.113.8'); assert.equal(calls[0].headers.host, '203.0.113.8:8443');
  assert.equal(calls[0].timeout <= 6000, true); assert.equal(calls[0].rejectUnauthorized, undefined);
});

test('public certificate identity/trust errors and missing Basic Auth fail without retries', async () => {
  for (const [nativeCode, code] of [
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'rollout-https-startup-certificate-name-mismatch'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'rollout-https-startup-certificate-untrusted'],
    ['CERT_HAS_EXPIRED', 'rollout-https-startup-certificate-expired'],
  ]) {
    const calls = [], d = dependencies({ readCa: () => Buffer.from('synthetic-ca'),
      httpsGet: mockHttps([Object.assign(new Error('fixture TLS failure'), { code: nativeCode })], calls) });
    await assert.rejects(liveVerification(plan, {}, d).verifyHealth({ publicReady: true }), { code });
    assert.equal(calls.length, 1); assert.equal(d.elapsed(), 0);
  }
  const d = dependencies({ readCa: () => Buffer.from('synthetic-ca'),
    httpsGet: mockHttps([{ statusCode: 200, headers: {}, resume() {} }]) });
  await assert.rejects(liveVerification(plan, {}, d).verifyHealth({ publicReady: true }), { code: 'rollout-https-challenge-unconfirmed' });
  assert.equal(d.elapsed(), 0);
});

test('public CA and request timeouts retain distinct safe evidence', async () => {
  const absent = dependencies({ startupTimeoutMs: 1000, readCa: () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); } });
  await assert.rejects(liveVerification(plan, {}, absent).verifyHealth({ publicReady: true }), { code: 'rollout-https-startup-timeout-ca-not-ready' });
  const timeout = dependencies({ startupTimeoutMs: 500, fetchFn: async () => { const error = new Error('deadline'); error.name = 'TimeoutError'; throw error; } });
  await assert.rejects(liveVerification(plan, {}, timeout).verifyHealth({}), { code: 'rollout-host-startup-timeout-timeout' });
});
