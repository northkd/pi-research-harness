import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDashboardUrl, navigationAction, withRuntimePath, validateHealth } from '../runtime/desktop-policy.mjs';

test('only HTTPS or loopback HTTP dashboard addresses are accepted', () => {
  assert.equal(normalizeDashboardUrl('https://example.org/'), 'https://example.org/');
  assert.equal(normalizeDashboardUrl('http://127.0.0.1:18400'), 'http://127.0.0.1:18400/');
  assert.equal(normalizeDashboardUrl('http://[::1]:8000'), 'http://[::1]:8000/');
  for (const address of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.org', 'https://user:pass@example.org', 'https://example.org/#token', 'https://example.org/?token=secret']) {
    assert.throws(() => normalizeDashboardUrl(address));
  }
});

test('off-origin navigation cannot replace the desktop dashboard', () => {
  assert.equal(navigationAction('http://127.0.0.1:18400/', 'http://127.0.0.1:18400/settings'), 'allow');
  assert.equal(navigationAction('http://127.0.0.1:18400/', 'https://example.org/paper'), 'external');
  assert.equal(navigationAction('http://127.0.0.1:18400/', 'file:///etc/passwd'), 'deny');
  assert.equal(navigationAction('https://example.org/', 'https://user:pass@example.org/'), 'deny');
});

test('Windows Path key is preserved and no HOME variable is rewritten', () => {
  const original = { Path: 'C:\\Windows', HOME: 'untouched', USERPROFILE: 'also-untouched' };
  const result = withRuntimePath(original, ['C:\\My App\\node', 'C:\\My App\\bin'], 'win32');
  assert.equal(result.Path, 'C:\\My App\\node;C:\\My App\\bin;C:\\Windows');
  assert.equal(result.PATH, undefined);
  assert.equal(result.HOME, original.HOME);
  assert.deepEqual(original, { Path: 'C:\\Windows', HOME: 'untouched', USERPROFILE: 'also-untouched' });
});

test('health must belong to our child and cannot be a recovery page', () => {
  assert.equal(validateHealth({ ok: true, pid: 42 }, 42), true);
  assert.equal(validateHealth({ ok: true, pid: 43 }, 42), false);
  assert.equal(validateHealth({ ok: false, pid: 42 }, 42), false);
  assert.equal(validateHealth({ ok: true, mode: 'recovery', pid: 42 }, 42), false);
  assert.equal(validateHealth({}, 42), false);
});
