import assert from 'node:assert/strict';
import test from 'node:test';
import { checksumFor, nodeAsset, NODE_VERSION } from '../scripts/download-node.mjs';
import { validateSmokeReport } from '../scripts/smoke-installed.mjs';
import verifyResources from '../scripts/verify-resources.cjs';

test('native release filenames match the official Node distributions', () => {
  assert.equal(NODE_VERSION, '24.15.0');
  for (const [platform, arch, filename, executable] of [
    ['darwin', 'arm64', 'node-v24.15.0-darwin-arm64.tar.gz', 'bin/node'],
    ['darwin', 'x64', 'node-v24.15.0-darwin-x64.tar.gz', 'bin/node'],
    ['win32', 'x64', 'node-v24.15.0-win-x64.zip', 'node.exe'],
    ['linux', 'x64', 'node-v24.15.0-linux-x64.tar.gz', 'bin/node'],
  ]) {
    const asset = nodeAsset(platform, arch);
    assert.equal(asset.filename, filename);
    assert.equal(asset.executable, executable);
    assert.equal(asset.url, `https://nodejs.org/dist/v${NODE_VERSION}/${filename}`);
    assert.equal(asset.directory, filename.replace(/\.(tar\.gz|zip)$/, ''));
  }
});

test('unsupported architectures fail before downloading an incompatible runtime', () => {
  assert.throws(() => nodeAsset('win32', 'ia32'), /Unsupported/);
  assert.throws(() => nodeAsset('darwin', 'riscv64'), /Unsupported/);
  assert.throws(() => nodeAsset('freebsd', 'x64'), /Unsupported/);
});

test('beforePack uses the requested electron-builder architecture and requires a native host', () => {
  assert.deepEqual(verifyResources.nativeTarget({ electronPlatformName: 'darwin', arch: 3 }, { platform: 'darwin', arch: 'arm64' }), { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(verifyResources.nativeTarget({ electronPlatformName: 'win32', arch: 1 }, { platform: 'win32', arch: 'x64' }), { platform: 'win32', arch: 'x64' });
  assert.throws(() => verifyResources.nativeTarget({ electronPlatformName: 'darwin', arch: 1 }, { platform: 'darwin', arch: 'arm64' }), /matching native host/);
  assert.throws(() => verifyResources.nativeTarget({ electronPlatformName: 'win32', arch: 1 }, { platform: 'linux', arch: 'x64' }), /matching native host/);
  assert.throws(() => verifyResources.nativeTarget({ electronPlatformName: 'darwin', arch: 4 }, { platform: 'darwin', arch: 'arm64' }), /Unsupported/);
  assert.throws(() => verifyResources.nativeTarget({ electronPlatformName: 'win32', arch: 3 }, { platform: 'win32', arch: 'arm64' }), /Unsupported/);
});

test('SHASUMS lookup matches the complete filename, including CRLF and binary markers', () => {
  const wanted = nodeAsset('win32', 'x64').filename;
  const expected = 'a'.repeat(64);
  const text = `${'b'.repeat(64)}  ${wanted}.extra\r\n${expected} *${wanted}\r\n`;
  assert.equal(checksumFor(text, wanted), expected);
});

test('missing, malformed, or duplicate official checksum records stop the build', () => {
  const wanted = nodeAsset('darwin', 'arm64').filename;
  assert.throws(() => checksumFor('', wanted), /exactly one/);
  assert.throws(() => checksumFor(`not-a-hash  ${wanted}\n`, wanted), /exactly one/);
  const line = `${'a'.repeat(64)}  ${wanted}\n`;
  assert.throws(() => checksumFor(line + line, wanted), /exactly one/);
});

const nativeReport = {
  ok: true,
  packaged: true,
  platform: 'darwin',
  arch: 'arm64',
  nodeVersion: 'v24.15.0',
  healthStatus: 200,
  uiLoaded: true,
  recovery: false,
  baseUrl: 'http://127.0.0.1:19423',
};

test('installer smoke accepts a native packaged application with a healthy loopback server', () => {
  assert.equal(validateSmokeReport(nativeReport, 'darwin', 'arm64'), nativeReport);
});

test('installer smoke rejects source launches, wrong runtimes, recovery UI, or a remote server', () => {
  for (const changes of [
    { ok: false }, { packaged: false }, { platform: 'win32' }, { arch: 'x64' },
    { nodeVersion: 'v22.19.0' }, { healthStatus: 503 }, { uiLoaded: false },
    { recovery: true }, { baseUrl: 'http://example.com:19423' },
    { baseUrl: 'http://127.0.0.1' }, { baseUrl: 'http://token@127.0.0.1:19423' },
  ]) {
    assert.throws(() => validateSmokeReport({ ...nativeReport, ...changes }, 'darwin', 'arm64'));
  }
});
