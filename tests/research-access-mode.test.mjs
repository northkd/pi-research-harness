import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { readResearchAccessMode, updateResearchAccessMode, readResearchAccessModeContext } from '../extensions/research-loop/src/access-mode.mjs';

const moduleUrl = new URL('../extensions/research-loop/src/access-mode.mjs', import.meta.url).href;
const localOwner = JSON.stringify(['host', 'inert-operator']);
const json = (file, value) => fs.writeFileSync(file, JSON.stringify(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'research-access-mode-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'workspace'), other = path.join(root, 'other'), storeDir = path.join(root, 'private-modes');
  fs.mkdirSync(cwd); fs.mkdirSync(other);
  const binding = { cwd, ownerKey: localOwner, storeDir };
  const request = { ...binding, mode: 'full-access', expectedRevision: null, requestId: 'mode-request-first' };
  function session(id, owner, extras = {}) {
    const sessionFile = path.join(root, id + '.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id, cwd }) + '\n');
    json(sessionFile.slice(0, -6) + '.meta.json', { cwd, driver: 'pi', ...(owner ? { principalOwner: owner } : {}), ...extras });
    return { cwd, sessionManager: { getSessionId: () => id, getSessionFile: () => sessionFile } };
  }
  return { root, cwd, other, storeDir, binding, request, session };
}

test('default needs no research adoption, charter, task, budget or created project files', t => {
  const f = fixture(t);
  assert.deepEqual(readResearchAccessMode(f.binding), { cwd: f.cwd, mode: 'default', revision: null, updatedAt: null, inheritance: 'workspace-sessions' });
  assert.equal(fs.existsSync(f.storeDir), false);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});

test('an explicit full-access choice persists across a fresh process without a task expiry', t => {
  const f = fixture(t), saved = updateResearchAccessMode({ ...f.request, now: 1700000000000 });
  assert.equal(saved.mode, 'full-access');
  assert.equal('expiresAt' in saved, false);
  assert.equal('task' in saved, false);
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import {readResearchAccessMode} from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(readResearchAccessMode(${JSON.stringify(f.binding)})));`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), saved);
  assert.deepEqual(fs.readdirSync(f.cwd), []);
});

test('a freshly registered session can use its native header before JSONL flush, but never guesses a missing owner', t => {
  const f = fixture(t), owner = { iss: 'issuer', sub: 'alice' };
  updateResearchAccessMode({ ...f.request, ownerKey: JSON.stringify([owner.iss, owner.sub]) });
  const ctx = f.session('fresh-native', owner), file = ctx.sessionManager.getSessionFile();
  fs.unlinkSync(file);
  ctx.sessionManager.getHeader = () => ({ type: 'session', id: 'fresh-native', cwd: f.cwd });
  assert.equal(readResearchAccessModeContext(ctx, { storeDir: f.storeDir })?.profile.mode, 'full-access');
  ctx.sessionManager.getHeader = () => ({ type: 'session', id: 'different', cwd: f.cwd });
  assert.equal(readResearchAccessModeContext(ctx, { storeDir: f.storeDir }), null);
  ctx.sessionManager.getHeader = () => ({ type: 'session', id: 'fresh-native', cwd: f.cwd });
  fs.unlinkSync(file.slice(0, -6) + '.meta.json');
  assert.equal(readResearchAccessModeContext(ctx, { storeDir: f.storeDir }), null);
});

test('single choice uses idempotent requests and CAS, and returning to default takes effect immediately', t => {
  const f = fixture(t), full = updateResearchAccessMode(f.request);
  assert.deepEqual(updateResearchAccessMode(f.request), full);
  assert.throws(() => updateResearchAccessMode({ ...f.request, mode: 'default' }), /request-conflict/);
  assert.throws(() => updateResearchAccessMode({ ...f.request, requestId: 'stale-request' }), /revision-conflict/);
  const restored = updateResearchAccessMode({ ...f.request, mode: 'default', expectedRevision: full.revision, requestId: 'restore-default' });
  assert.equal(restored.mode, 'default');
  assert.notEqual(restored.revision, full.revision);
  assert.deepEqual(readResearchAccessMode(f.binding), restored);
  assert.throws(() => updateResearchAccessMode({ ...f.request, mode: 'allow-everything-typo' }), /invalid/);
});

test('concurrent operator processes cannot both commit the same expected revision', async t => {
  const f = fixture(t);
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => new Promise((resolve, reject) => {
    const source = `import { updateResearchAccessMode } from ${JSON.stringify(moduleUrl)}; try { updateResearchAccessMode(${JSON.stringify({ ...f.request, requestId: 'concurrent-choice-' + index })}); process.stdout.write('saved'); } catch (error) { process.stdout.write(error.code); }`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source]);
    let output = ''; child.stdout.on('data', chunk => { output += chunk; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve(output) : reject(new Error('Concurrent writer exited ' + code)));
  })));
  assert.equal(results.filter(result => result === 'saved').length, 1);
  assert.ok(results.every(result => ['saved', 'access-mode-busy', 'access-mode-revision-conflict'].includes(result)));
  assert.equal(readResearchAccessMode(f.binding).mode, 'full-access');
});

test('an abandoned writer lock is never deleted by a competing request and does not stop active mode reads', t => {
  const f = fixture(t), saved = updateResearchAccessMode(f.request);
  const file = path.join(f.storeDir, fs.readdirSync(f.storeDir).find(name => name.endsWith('.json')));
  const lock = file + '.lock'; json(lock, { pid: 2147483647 });
  const before = fs.statSync(lock);
  assert.throws(() => updateResearchAccessMode({ ...f.request, mode: 'default', expectedRevision: saved.revision, requestId: 'cannot-steal-stale-lock' }), /access-mode-busy/);
  assert.equal(fs.statSync(lock).ino, before.ino);
  assert.deepEqual(readResearchAccessMode(f.binding), saved);
});

test('operator and canonical workspace isolate settings; local-operator aliases share the same choice', t => {
  const f = fixture(t); updateResearchAccessMode(f.request);
  assert.equal(readResearchAccessMode({ ...f.binding, ownerKey: JSON.stringify(['issuer', 'someone-else']) }).mode, 'default');
  assert.equal(readResearchAccessMode({ ...f.binding, cwd: f.other }).mode, 'default');
  assert.equal(readResearchAccessMode({ ...f.binding, ownerKey: JSON.stringify(['urn:pi-dashboard:local-operator', 'local-operator']) }).mode, 'full-access');
  const alias = path.join(f.root, 'alias'); fs.symlinkSync(f.cwd, alias);
  assert.throws(() => readResearchAccessMode({ ...f.binding, cwd: alias }), /invalid/);
  assert.throws(() => readResearchAccessMode({ ...f.binding, ownerKey: 'body-selected-owner' }), /invalid/);
});

test('tampered, linked or oversized mode records cannot turn default into full access', t => {
  const f = fixture(t); updateResearchAccessMode(f.request);
  const file = path.join(f.storeDir, fs.readdirSync(f.storeDir).find(name => name.endsWith('.json')));
  const original = fs.readFileSync(file);
  fs.linkSync(file, path.join(f.root, 'record-link'));
  assert.throws(() => readResearchAccessMode(f.binding), /unavailable/);
  fs.unlinkSync(path.join(f.root, 'record-link'));
  json(file, { mode: 'full-access' });
  assert.throws(() => readResearchAccessMode(f.binding), /unavailable/);
  fs.writeFileSync(file, ' '.repeat(17000));
  assert.throws(() => readResearchAccessMode(f.binding), /unavailable/);
  fs.writeFileSync(file, original);
  const alias = path.join(f.root, 'store-alias'); fs.symlinkSync(f.storeDir, alias);
  assert.throws(() => readResearchAccessMode({ ...f.binding, storeDir: alias }), /unavailable/);
});

test('main, multi-agent and native child contexts share a live workspace setting without adoption', t => {
  const f = fixture(t), full = updateResearchAccessMode(f.request);
  const sessions = [f.session('lead'), f.session('collaborator'), f.session('child', undefined, { pluginHidden: true, archiveOnEnd: true })];
  for (const ctx of sessions) assert.equal(readResearchAccessModeContext(ctx, { storeDir: f.storeDir })?.profile.mode, 'full-access');
  updateResearchAccessMode({ ...f.request, mode: 'default', expectedRevision: full.revision, requestId: 'disable-for-all' });
  for (const ctx of sessions) assert.equal(readResearchAccessModeContext(ctx, { storeDir: f.storeDir })?.profile.mode, 'default');
});

test('named session owners cannot inherit another owner or local operator access', t => {
  const f = fixture(t); updateResearchAccessMode(f.request);
  const owner = { iss: 'test-issuer', sub: 'operator-A' }, other = { iss: 'test-issuer', sub: 'operator-B' };
  const owned = f.session('owned', owner), foreign = f.session('foreign', other);
  assert.equal(readResearchAccessModeContext(owned, { storeDir: f.storeDir })?.profile.mode, 'default');
  updateResearchAccessMode({ ...f.request, ownerKey: JSON.stringify([owner.iss, owner.sub]) });
  assert.equal(readResearchAccessModeContext(owned, { storeDir: f.storeDir })?.profile.mode, 'full-access');
  assert.equal(readResearchAccessModeContext(foreign, { storeDir: f.storeDir })?.profile.mode, 'default');
});

test('missing metadata, substituted session identity, remote host and non-Pi sessions do not inherit', t => {
  const f = fixture(t); updateResearchAccessMode(f.request);
  for (const extras of [{ originDeviceId: 'remote-host' }, { driver: 'acp' }, { cwd: f.other }, { principalOwner: { iss: '', sub: 'broken' } }]) {
    assert.equal(readResearchAccessModeContext(f.session('ineligible', undefined, extras), { storeDir: f.storeDir }), null);
  }
  const ctx = f.session('original');
  assert.equal(readResearchAccessModeContext({ ...ctx, sessionManager: { ...ctx.sessionManager, getSessionId: () => 'forged-id' } }, { storeDir: f.storeDir }), null);
  fs.unlinkSync(ctx.sessionManager.getSessionFile().slice(0, -6) + '.meta.json');
  assert.equal(readResearchAccessModeContext(ctx, { storeDir: f.storeDir }), null);
  assert.equal(readResearchAccessModeContext({ cwd: f.cwd, sessionManager: {} }, { storeDir: f.storeDir }), null);
});
