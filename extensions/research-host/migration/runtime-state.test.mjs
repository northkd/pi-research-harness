import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMigration, verifyMigration } from './index.mjs';
import { prepareHostConfiguration } from './configuration.mjs';
import { createRuntimeStateMigrationPlan, seedRuntimeState, verifyRuntimeStateSeed, rollbackRuntimeState } from './runtime-state.mjs';

const stopped = () => ({ ok: true, observedAt: new Date().toISOString(), evidence: ['synthetic legacy writers stopped', 'synthetic new host inactive'] });
const hash = value => createHash('sha256').update(value).digest('hex');

async function fixture(t, { snapshot = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-state-seed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const homeDir = path.join(directory, 'home'), projectRoot = path.join(directory, 'project');
  const legacyDashboardDir = path.join(homeDir, '.pi/dashboard');
  const nativeSessionsDir = path.join(homeDir, '.pi/agent/sessions');
  const stateDir = path.join(homeDir, '.pi/research-host');
  const backupDir = path.join(directory, 'rollout-backup');
  const snapshotDir = path.join(directory, 'snapshot');
  const pinned = path.join(directory, 'pinned-project');
  const put = (file, bytes) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, typeof bytes === 'string' || Buffer.isBuffer(bytes) ? bytes : JSON.stringify(bytes) + '\n', { mode: 0o600 });
  };
  for (const root of [nativeSessionsDir, path.join(legacyDashboardDir, 'res-workflow'), path.join(legacyDashboardDir, 'research-access-modes'),
    path.join(legacyDashboardDir, 'research-task-permissions'), path.join(projectRoot, 'research-loop'), pinned]) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  put(path.join(nativeSessionsDir, 'legacy-file.jsonl'), JSON.stringify({ type: 'session', id: 'native-id', cwd: pinned }) + '\n');
  put(path.join(homeDir, '.pi/agent/models.json'), { providers: {}, syntheticPrice: 1 });
  put(path.join(legacyDashboardDir, 'res-workflow/adopted.json'), { id: 'adopt-synthetic', originalIdentity: true });
  put(path.join(legacyDashboardDir, 'goals/folder.json'), { schemaVersion: 1,
    goals: Array.from({ length: 5 }, (_, i) => ({ id: 'goal-' + i, status: i < 3 ? 'paused' : 'achieved', sessionIds: ['native-id'], driverSessionId: 'native-id' })) });
  put(path.join(legacyDashboardDir, 'attachments/original.bin'), Buffer.from([0, 255, 128, 1]));
  put(path.join(legacyDashboardDir, 'access-grants.json'), { version: 1, grants: Array.from({ length: 36 }, (_, i) => ({ id: 'grant-' + i })) });
  put(path.join(legacyDashboardDir, 'pi-trust-mirror.json'), { version: 1 });
  put(path.join(legacyDashboardDir, 'pi-trust-overrides.json'), { version: 1 });
  put(path.join(legacyDashboardDir, 'knowledge_base.json'), { sources: [] });
  put(path.join(legacyDashboardDir, 'kb-source-trust.json'), { version: 1 });
  put(path.join(legacyDashboardDir, 'kb/sources/source/index.bin'), Buffer.from([1, 2, 3]));
  put(path.join(legacyDashboardDir, 'custom-event-groups.json'), { version: 1, groups: [] });
  put(path.join(legacyDashboardDir, 'services-run/retained/record.json'), { id: 'existing-service-record' });
  put(path.join(legacyDashboardDir, 'tool-overrides.json'), { read: true });
  put(path.join(legacyDashboardDir, 'vault-projects.json'), { version: 1, projects: [] });
  put(path.join(projectRoot, 'workbench-sync/state/owner/scope/checkpoint.json'), { schema: 'synthetic-checkpoint', seenResponses: ['original-response'], cursor: 17 });
  const preferences = { pinnedDirectories: [pinned], favoriteModels: ['synthetic-model'], workspaces: [], sessionOrder: ['native-id'] };
  const legacyConfig = { piSessionsDir: nativeSessionsDir, piTrustMirror: { sources: ['pinned'] }, defaultModel: 'synthetic-model' };
  put(path.join(legacyDashboardDir, 'preferences.json'), preferences);
  put(path.join(legacyDashboardDir, 'config.json'), legacyConfig);
  const hostConfiguration = prepareHostConfiguration({ homeDir, projectRoot, stateDir, legacyConfig,
    legacyPreferences: preferences, checkFilesystem: false }).config;
  put(path.join(stateDir, 'config.json'), { existingRuntimeConfig: true });
  put(path.join(stateDir, 'local/token'), 'synthetic-new-host-credential\n');
  const plan = createRuntimeStateMigrationPlan({ homeDir, projectRoot, legacyDashboardDir, nativeSessionsDir, projectCwds: [pinned] });
  if (snapshot) await prepareMigration({ destinationDir: snapshotDir, plan, assertQuiescent: stopped });
  return { directory, homeDir, projectRoot, legacyDashboardDir, nativeSessionsDir, stateDir, backupDir,
    snapshotDir, pinned, hostConfiguration, plan, put, seed: options => seedRuntimeState({ snapshotDir, stateDir,
      backupDir, hostConfiguration, assertQuiescent: stopped, ...options }) };
}

test('seeds operational records and ordered pins while preserving sealed roots and new credentials', async t => {
  const f = await fixture(t);
  const kept = [f.hostConfiguration.workbenchDir, f.nativeSessionsDir, f.hostConfiguration.agentDir, f.hostConfiguration.legacyAttachmentRoots[0]];
  const identities = kept.map(file => [fs.statSync(file).dev, fs.statSync(file).ino]);
  const config = fs.readFileSync(path.join(f.stateDir, 'config.json'));
  const credential = fs.readFileSync(path.join(f.stateDir, 'local/token'));
  const result = await f.seed();
  assert.equal(result.ok, true);
  assert.equal(result.retainedRoots, 9);
  assert.equal(result.verify({ verifySources: true }).ok, true);
  for (const relative of ['goals/folder.json', 'preferences.json', 'knowledge_base.json', 'kb-source-trust.json',
    'kb/sources/source/index.bin', 'custom-event-groups.json', 'services-run/retained/record.json', 'tool-overrides.json', 'vault-projects.json']) {
    assert.deepEqual(fs.readFileSync(path.join(f.stateDir, relative)), fs.readFileSync(path.join(f.legacyDashboardDir, relative)));
    assert.equal(fs.statSync(path.join(f.stateDir, relative)).mode & 0o777, 0o600);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'workspace-directories.json'))), { version: 1, pinned: [f.pinned], created: [] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, 'goals/folder.json'))).goals.length, 5);
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'workbench-sync/state/owner/scope/checkpoint.json')),
    fs.readFileSync(path.join(f.projectRoot, 'workbench-sync/state/owner/scope/checkpoint.json')));
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'config.json')), config);
  assert.deepEqual(fs.readFileSync(path.join(f.stateDir, 'local/token')), credential);
  assert.deepEqual(kept.map(file => [fs.statSync(file).dev, fs.statSync(file).ino]), identities);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'res-workflow')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'access-grants.json')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'attachments')), false);
});

test('rollback reloads from its manifest and removes only this seed transaction', async t => {
  const f = await fixture(t);
  const original = fs.readFileSync(path.join(f.legacyDashboardDir, 'goals/folder.json'));
  const result = await f.seed();
  assert.equal((await rollbackRuntimeState({ manifestFile: result.manifestFile, assertQuiescent: stopped })).rolledBack, true);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'goals')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'workbench-sync')), false);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'config.json')), true);
  assert.equal(fs.existsSync(path.join(f.stateDir, 'local/token')), true);
  assert.deepEqual(fs.readFileSync(path.join(f.legacyDashboardDir, 'goals/folder.json')), original);
  assert.equal((await rollbackRuntimeState({ manifestFile: result.manifestFile, assertQuiescent: stopped })).rolledBack, true);
});

test('byte-identical existing roots are reused and survive rollback', async t => {
  const f = await fixture(t);
  f.put(path.join(f.stateDir, 'goals/folder.json'), fs.readFileSync(path.join(f.legacyDashboardDir, 'goals/folder.json')));
  const before = fs.statSync(path.join(f.stateDir, 'goals/folder.json')).ino;
  const result = await f.seed();
  await result.rollback();
  assert.equal(fs.statSync(path.join(f.stateDir, 'goals/folder.json')).ino, before);
});

test('an existing empty root keeps its inode after copy and rollback', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.stateDir, 'goals'), { mode: 0o700 });
  const before = fs.statSync(path.join(f.stateDir, 'goals')).ino;
  const result = await f.seed();
  await result.rollback();
  assert.equal(fs.statSync(path.join(f.stateDir, 'goals')).ino, before);
  assert.deepEqual(fs.readdirSync(path.join(f.stateDir, 'goals')), []);
});

test('conflicting user bytes and symlinked destinations are rejected before a seed journal is created', async t => {
  const f = await fixture(t);
  f.put(path.join(f.stateDir, 'preferences.json'), 'existing user changes\n');
  await assert.rejects(f.seed(), { code: 'runtime-state-existing-content-conflict' });
  assert.equal(fs.readFileSync(path.join(f.stateDir, 'preferences.json'), 'utf8'), 'existing user changes\n');
  assert.equal(fs.existsSync(f.backupDir), false);
  fs.unlinkSync(path.join(f.stateDir, 'preferences.json'));
  fs.symlinkSync(path.join(f.legacyDashboardDir, 'goals'), path.join(f.stateDir, 'goals'));
  await assert.rejects(f.seed(), { code: 'runtime-state-symlink-rejected' });
});

test('source changes and stale quiescence evidence cannot produce a verified runtime seed', async t => {
  const f = await fixture(t);
  await assert.rejects(f.seed({ assertQuiescent: undefined }), { code: 'runtime-state-quiescence-required' });
  await assert.rejects(f.seed({ assertQuiescent: () => ({ ok: true, observedAt: '2000-01-01T00:00:00Z', evidence: ['stale'] }) }), { code: 'runtime-state-quiescence-unconfirmed' });
  await assert.rejects(f.seed({ afterSeed: () => f.put(path.join(f.legacyDashboardDir, 'goals/folder.json'), { schemaVersion: 1, goals: [] }) }), { code: 'migration-source-changed' });
  const manifestFile = path.join(f.backupDir, 'runtime-state-seed/manifest.json');
  assert.throws(() => verifyRuntimeStateSeed({ manifestFile }), { code: 'runtime-state-manifest-not-ready' });
  await rollbackRuntimeState({ manifestFile, assertQuiescent: stopped });
  assert.equal(fs.existsSync(path.join(f.stateDir, 'goals')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.legacyDashboardDir, 'goals/folder.json'))).goals.length, 0);
});

test('new runtime writes are archived for reconciliation and remain available during rollback', async t => {
  const f = await fixture(t);
  const result = await f.seed();
  const file = path.join(f.stateDir, 'goals/folder.json');
  const next = JSON.parse(fs.readFileSync(file)); next.goals.push({ id: 'new-runtime-goal', status: 'paused' });
  f.put(file, next);
  assert.throws(() => result.verify(), { code: 'runtime-state-destination-changed' });
  const rolledBack = await result.rollback();
  assert.equal(rolledBack.code, 'runtime-state-rollback-reconciliation-required');
  assert.equal(rolledBack.requiresReconciliation, true);
  assert.equal(verifyMigration({ destinationDir: rolledBack.preservedSnapshot }).ok, true);
  assert.deepEqual(fs.readFileSync(path.join(rolledBack.preservedSnapshot, 'data/goals/folder.json')), fs.readFileSync(file));
  const replay = await rollbackRuntimeState({ manifestFile: result.manifestFile, assertQuiescent: stopped });
  assert.equal(replay.preservedSnapshot, rolledBack.preservedSnapshot);
  assert.equal(JSON.parse(fs.readFileSync(file)).goals.length, 6);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.legacyDashboardDir, 'goals/folder.json'))).goals.length, 5);
});

test('sealed paths and pinned directory mismatches are rejected', async t => {
  const f = await fixture(t);
  await assert.rejects(f.seed({ hostConfiguration: { ...f.hostConfiguration, workbenchDir: path.join(f.directory, 'copied-workbench') } }), { code: 'runtime-state-retained-root-mismatch' });
  await assert.rejects(f.seed({ hostConfiguration: { ...f.hostConfiguration, knownCwds: [] } }), { code: 'runtime-state-pinned-directories-mismatch' });
});

test('uncovered operational source roots require a complete verified snapshot', async t => {
  const f = await fixture(t, { snapshot: false });
  const incomplete = { ...f.plan, copy: f.plan.copy.filter(root => root.id !== 'kb-global-config') };
  await prepareMigration({ destinationDir: f.snapshotDir, plan: incomplete, assertQuiescent: stopped });
  await assert.rejects(f.seed(), { code: 'runtime-state-snapshot-coverage-incomplete' });
});

test('journal alteration and replay cannot redirect rollback to unrelated paths', async t => {
  const f = await fixture(t);
  const result = await f.seed();
  const manifest = JSON.parse(fs.readFileSync(result.manifestFile));
  manifest.roots[0].target = '../unrelated';
  const { manifestSha256: _old, ...payload } = manifest;
  manifest.manifestSha256 = hash(JSON.stringify(payload));
  f.put(result.manifestFile, manifest);
  await assert.rejects(rollbackRuntimeState({ manifestFile: result.manifestFile, assertQuiescent: stopped }), { code: 'runtime-state-manifest-invalid' });
  assert.equal(fs.existsSync(path.join(f.stateDir, 'goals/folder.json')), true);
  f.put(result.manifestFile, 'null\n');
  await assert.rejects(rollbackRuntimeState({ manifestFile: result.manifestFile, assertQuiescent: stopped }), { code: 'runtime-state-manifest-invalid' });
});
