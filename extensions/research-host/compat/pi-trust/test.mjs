import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createPiTrustMirror, readTrustJson, readWorktreeTrust } from './index.mjs';
import { decideProjectTrust, registerPiTrust, captureTrustActivation } from './register.mjs';

function json(file, value) { fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 }); }
const noDeny = () => ({ exact: [], subtree: [] });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-trust-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), stateDir = path.join(root, 'host'), agentDir = path.join(home, '.pi/agent');
  fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(path.join(stateDir, 'legacy'), { recursive: true });
  const snapshotFile = path.join(stateDir, 'legacy/pi-trust-mirror.json'), overridesFile = path.join(stateDir, 'legacy/pi-trust-overrides.json');
  const project = path.join(home, 'project'); fs.mkdirSync(path.join(project, '.pi'), { recursive: true });
  json(path.join(project, '.pi/settings.json'), {});
  const pins = [project], grants = [], folders = [], hooks = [];
  const config = { enabled: true, coverInteractive: true, sources: { pinned: true, accessGrants: false } };
  const options = { snapshotFile, overridesFile, getConfig: () => config, home,
    listPinned: () => pins, listPersistedGrants: () => grants, listWorkspaceFolders: () => folders,
    listWorktreeTrust: () => hooks, denyRules: noDeny };
  const mirror = createPiTrustMirror(options);
  const decide = (extra = {}) => decideProjectTrust({ eventCwd: project, activationCwd: project, home, agentDir,
    snapshotFile, mirrorConfig: config, denyRules: noDeny, ...extra });
  return { root, home, stateDir, agentDir, project, snapshotFile, overridesFile, pins, grants, folders, hooks, config, options, mirror, decide };
}

test('service preserves existing snapshot and choices until a real refresh and never writes native trust', t => {
  const f = fixture(t);
  f.mirror.rebuildAtBoot();
  f.mirror.setChoice('accessGrants', f.project, true);
  const before = [fs.readFileSync(f.snapshotFile), fs.readFileSync(f.overridesFile)];
  const reopened = createPiTrustMirror(f.options);
  assert.deepEqual(fs.readFileSync(f.snapshotFile), before[0]);
  assert.deepEqual(fs.readFileSync(f.overridesFile), before[1]);
  assert.equal(reopened.readSnapshot().entries.length, 1);
  assert.equal(reopened.choiceFor('accessGrants', f.project), true);
  assert.equal(fs.existsSync(path.join(f.agentDir, 'trust.json')), false);
  assert.equal(fs.statSync(f.snapshotFile).mode & 0o777, 0o600);
});

test('live pin and persisted-grant changes rebuild exact source entries and apply original per-entry choices', t => {
  const f = fixture(t);
  f.mirror.refresh();
  assert.deepEqual(f.mirror.readSnapshot().entries.map(row => row.sourceKind), ['pinned']);
  f.grants.push({ subject: f.project });
  f.mirror.refresh();
  assert.equal(f.mirror.readSnapshot().entries.length, 1);
  f.mirror.setChoice('accessGrants', f.project, true); f.mirror.refresh();
  assert.deepEqual(f.mirror.readSnapshot().entries.map(row => row.sourceKind), ['pinned', 'accessGrants']);
  f.pins.length = 0; f.mirror.refresh();
  assert.deepEqual(f.mirror.readSnapshot().entries.map(row => row.sourceKind), ['accessGrants']);
  f.grants.length = 0; f.mirror.refresh();
  assert.deepEqual(f.mirror.readSnapshot().entries, []);
});

test('ordered grants and revokes update choices, source and snapshot in the original order', t => {
  const f = fixture(t);
  f.pins.length = 0;
  f.mirror.rebuildAtBoot();
  f.mirror.grant('pinned', f.project, true, () => {
    assert.equal(readTrustJson(f.overridesFile).choices['pinned\0' + f.project], true);
    assert.equal(f.mirror.readSnapshot().entries.length, 0);
    f.pins.push(f.project);
  });
  assert.equal(f.mirror.readSnapshot().entries.length, 1);
  f.mirror.revoke('pinned', f.project, () => {
    assert.equal(f.mirror.readSnapshot().entries.length, 0);
    f.pins.length = 0;
  });
  assert.equal(f.mirror.choiceFor('pinned', f.project), undefined);
  assert.throws(() => f.mirror.grant('pinned', f.project, true, () => { throw new Error('synthetic-source-write-failed'); }), /synthetic-source-write-failed/);
  assert.equal(f.mirror.choiceFor('pinned', f.project), undefined);
  assert.equal(f.mirror.readSnapshot().entries.length, 0);
});

test('mirror coverage is live, session-only and yields to both true and false recorded Pi entries', t => {
  const f = fixture(t);
  f.mirror.refresh();
  assert.deepEqual(f.decide(), { trusted: 'yes', remember: false });
  for (const decision of [false, true]) {
    json(path.join(f.agentDir, 'trust.json'), { [f.project]: decision });
    assert.deepEqual(f.decide(), { trusted: 'undecided' });
  }
  fs.writeFileSync(path.join(f.agentDir, 'trust.json'), '{truncated');
  assert.deepEqual(f.decide(), { trusted: 'undecided' });
  fs.rmSync(path.join(f.agentDir, 'trust.json'));
  f.config.enabled = false;
  assert.deepEqual(f.decide(), { trusted: 'undecided' });
  f.config.enabled = true; f.config.coverInteractive = false;
  assert.deepEqual(f.decide(), { trusted: 'undecided' });
  assert.deepEqual(f.decide({ managed: true, headless: true }), { trusted: 'yes', remember: false });
});

test('activation is exact, blocks forbidden folders and scrubs its marker without losing reload identity', t => {
  const f = fixture(t), holder = {}, env = { PI_RESEARCH_HOST_TRUST_ACTIVATION: '1' };
  const first = captureTrustActivation(env, holder, f.project);
  assert.equal(env.PI_RESEARCH_HOST_TRUST_ACTIVATION, undefined);
  assert.deepEqual(first, { managed: true, activationCwd: f.project });
  assert.deepEqual(captureTrustActivation(env, holder, f.home), first);
  assert.deepEqual(captureTrustActivation({}, {}, f.home), { managed: false, activationCwd: f.home });
  assert.deepEqual(f.decide({ managed: true, headless: true, snapshotFile: '/missing' }), { trusted: 'yes', remember: false });
  assert.deepEqual(f.decide({ managed: true, headless: true, activationCwd: f.home }), { trusted: 'undecided' });
  assert.deepEqual(f.decide({ managed: true, headless: true, denyRules: () => ({ exact: [f.project], subtree: [] }) }), { trusted: 'undecided' });
});

test('snapshot identity, corrupt state and symlink substitution fail closed', t => {
  const f = fixture(t);
  f.mirror.refresh();
  fs.renameSync(f.project, f.project + '-old'); fs.mkdirSync(f.project);
  assert.deepEqual(f.decide(), { trusted: 'undecided' });
  fs.writeFileSync(f.snapshotFile, '{truncated');
  assert.deepEqual(f.decide(), { trusted: 'undecided' });
  fs.rmSync(f.snapshotFile); fs.symlinkSync(path.join(f.root, 'other'), f.snapshotFile);
  assert.deepEqual(f.decide(), { trusted: 'undecided' });
  assert.throws(() => createPiTrustMirror(f.options), /pi-trust-state-refused/);
});

test('global extension registers the trust handler synchronously and reads config changes each event', t => {
  const f = fixture(t); f.mirror.refresh();
  let handler;
  const pi = { on(name, value) { assert.equal(name, 'project_trust'); handler = value; return () => { handler = null; }; } };
  const stop = registerPiTrust(pi, { stateDir: f.stateDir, home: f.home, readConfiguration: () => ({ agentDir: f.agentDir, piTrustMirror: f.config }), denyRules: noDeny });
  assert.equal(typeof handler, 'function');
  assert.deepEqual(handler({ cwd: f.project }, {}), { trusted: 'yes', remember: false });
  f.config.enabled = false;
  assert.deepEqual(handler({ cwd: f.project }, {}), { trusted: 'undecided' });
  assert.deepEqual(handler({}, { get cwd() { throw new Error('stale-context'); } }), { trusted: 'undecided' });
  stop(); assert.equal(handler, null);
});

test('legacy persisted worktree trust is read without state migration or session grant synthesis', t => {
  const f = fixture(t), file = path.join(f.stateDir, 'worktree-init-trust.json');
  assert.deepEqual(readWorktreeTrust(file), []);
  json(file, { [f.project + '\0synthetic-hash']: true, ignored: true, [f.home + '\0refused']: false });
  const before = fs.readFileSync(file);
  assert.deepEqual(readWorktreeTrust(file), [{ repoRoot: f.project, hash: 'synthetic-hash' }]);
  assert.deepEqual(fs.readFileSync(file), before);
  fs.writeFileSync(file, '{truncated');
  assert.deepEqual(readWorktreeTrust(file), []);
});

test('revoke aborts before changing its source when the snapshot writer is unavailable', t => {
  const f = fixture(t); f.mirror.refresh();
  const before = fs.readFileSync(f.snapshotFile);
  const blocked = createPiTrustMirror({ ...f.options, canWrite: () => false });
  let sourceWritten = false;
  assert.throws(() => blocked.revoke('pinned', f.project, () => { sourceWritten = true; f.pins.length = 0; }), /does not hold the home lock/);
  assert.equal(sourceWritten, false);
  assert.deepEqual(fs.readFileSync(f.snapshotFile), before);
  assert.deepEqual(f.pins, [f.project]);
  assert.throws(() => blocked.grant('pinned', f.project, true, () => { sourceWritten = true; }), /does not hold the home lock/);
  assert.equal(sourceWritten, false);
  assert.equal(fs.existsSync(f.overridesFile), false);
});

test('installed native Pi resolves the registered handler before defaults and leaves trust.json unchanged', async t => {
  const f = fixture(t); f.mirror.refresh();
  const native = process.env.PI_NATIVE_TEST_ROOT ?? '/example/operator/.pi/agent/install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent/dist';
  const { resolveProjectTrusted } = await import(pathToFileURL(path.join(native, 'core/project-trust.js')));
  const { ProjectTrustStore } = await import(pathToFileURL(path.join(native, 'core/trust-manager.js')));
  const trustStore = new ProjectTrustStore(f.agentDir);
  let handler;
  registerPiTrust({ on(_name, value) { handler = value; return () => {}; } }, { stateDir: f.stateDir, home: f.home,
    readConfiguration: () => ({ agentDir: f.agentDir, piTrustMirror: f.config }), denyRules: noDeny });
  const options = { cwd: f.project, trustStore, defaultProjectTrust: 'never',
    extensionsResult: { extensions: [{ path: 'synthetic-standalone-trust', handlers: new Map([['project_trust', [handler]]]) }] },
    projectTrustContext: { cwd: f.project, hasUI: false }, onExtensionError: message => assert.fail(message) };
  assert.equal(await resolveProjectTrusted(options), true);
  assert.equal(fs.existsSync(path.join(f.agentDir, 'trust.json')), false);
  json(path.join(f.agentDir, 'trust.json'), { [f.project]: false });
  const before = fs.readFileSync(path.join(f.agentDir, 'trust.json'));
  assert.equal(await resolveProjectTrusted(options), false);
  assert.deepEqual(fs.readFileSync(path.join(f.agentDir, 'trust.json')), before);
});
