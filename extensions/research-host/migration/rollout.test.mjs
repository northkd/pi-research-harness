import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMachineRolloutPlan, stageRolloutArtifacts, runRollout, rollbackRollout, rolloutFingerprint, LEGACY_UNITS, NEW_UNITS } from './rollout.mjs';
import { knownDashboardRegistrations } from './configuration.mjs';
import { seedRuntimeState, rollbackRuntimeState } from './runtime-state.mjs';
import { ROLLOUT_PAUSE_FILE } from '../config.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const evidence = text => ({ ok: true, observedAt: new Date().toISOString(), evidence: [text] });

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rollout-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const homeDir = path.join(directory, 'home'), projectRoot = path.join(directory, 'project');
  const hostRoot = path.join(projectRoot, 'research-host'), legacy = path.join(homeDir, '.pi/dashboard');
  const sessionRoot = path.join(homeDir, '.pi/agent/sessions'), cwd = path.join(directory, 'research-project');
  const write = (file, bytes, mode = 0o600) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, bytes, { mode }); return file; };
  for (const value of [path.join(projectRoot, 'dashboard/node_modules'), path.join(projectRoot, 'dashboard-startup'), path.join(legacy, 'res-workflow'), cwd,
    path.join(projectRoot, 'research-loop'), path.join(homeDir, '.pi/agent/install/releases/1.3.0/node_modules')]) fs.mkdirSync(value, { recursive: true, mode: 0o700 });
  write(path.join(projectRoot, 'mainline-supervision/src/core.mjs'), 'export class MainlineStore {}');
  write(path.join(homeDir, '.local/bin/pi'), '#!/bin/sh\n', 0o700);
  write(path.join(homeDir, '.local/bin/pi-research'), '#!/bin/sh\nexec /synthetic/pi "$@"\n', 0o700);
  write(path.join(homeDir, '.local/bin/pi-research-dashboard'), '#!/bin/sh\n', 0o700);
  write(path.join(projectRoot, 'dashboard/package.json'), '{"synthetic":true}\n');
  write(path.join(projectRoot, 'dashboard-access/caddy'), 'synthetic executable bytes', 0o700);
  write(path.join(projectRoot, 'dashboard-access/Caddyfile'), 'https://127.0.0.1:8443 {\n basic_auth {\n synthetic-user $2a$14$' + 'A'.repeat(53) + '\n }\n}\n');
  write(path.join(legacy, 'config.json'), JSON.stringify({ port: 8000, piSessionsDir: sessionRoot, automation: {} }));
  write(path.join(legacy, 'preferences.json'), JSON.stringify({ pinnedDirectories: [cwd] }));
  write(path.join(legacy, 'goals/goals.json'), '{"schemaVersion":1,"goals":[]}\n');
  write(path.join(legacy, 'res-workflow/preserved.json'), '{"schema":"synthetic-original-record"}\n');
  write(path.join(sessionRoot, 'project/session.jsonl'), JSON.stringify({ type: 'session', id: 'synthetic-history', cwd, timestamp: '2026-01-01T00:00:00Z' }) + '\n');
  const registrations = knownDashboardRegistrations({ homeDir, projectRoot });
  write(path.join(homeDir, '.pi/agent/settings.json'), JSON.stringify({ packages: ['npm:pi-subagents@0.79.2', registrations.sources[0]], extensions: registrations.bridges.map(item => item.source), skills: ['/synthetic/retained-skill'] }, null, 2) + '\n');
  write(path.join(homeDir, '.pi/agent/mcp.json'), '{"mcpServers":{"pi-dashboard":{"url":"http://127.0.0.1:8000/mcp"},"user-server":{"command":"retained"}}}\n');
  for (const unit of LEGACY_UNITS) write(path.join(homeDir, '.config/systemd/user', unit), '[Service]\nExecStart=/synthetic/old-service\n', 0o644);
  for (const relative of ['server.mjs', 'native-extension.mjs', 'launch.mjs', 'cli/main.mjs', 'supplemental/flow-bridge.mjs']) write(path.join(hostRoot, relative), 'export default function () {}\n');
  write(path.join(hostRoot, 'deploy/pi-research-host.service'), fs.readFileSync(path.join(HERE, '../deploy/pi-research-host.service')));
  write(path.join(hostRoot, 'deploy/pi-research-proxy.service.in'), fs.readFileSync(path.join(HERE, '../deploy/pi-research-proxy.service.in')));
  fs.symlinkSync(path.join(projectRoot, 'dashboard/node_modules'), path.join(projectRoot, 'node_modules'));
  const states = new Map([...LEGACY_UNITS.map(unit => [unit, { active: true, enabled: true }]), ...NEW_UNITS.map(unit => [unit, { active: false, enabled: false }])]);
  const calls = [];
  let failProof = false, dirtyConfig = false;
  const adapter = {
    async serviceState(unit) { calls.push('state:' + unit); return { ...states.get(unit) }; },
    async stop(unit) { calls.push('stop:' + unit); states.get(unit).active = false; },
    async start(unit) { calls.push('start:' + unit); states.get(unit).active = true; },
    async enable(unit) { calls.push('enable:' + unit); states.get(unit).enabled = true; },
    async disable(unit) { calls.push('disable:' + unit); states.get(unit).enabled = false; },
    async daemonReload() { calls.push('reload'); },
    async assertQuiescent() { assert.equal([...states.values()].some(row => row.active), false); calls.push('quiescent'); return evidence('fixture writers are stopped'); },
    async verifyHealth({ plan }) {
      calls.push('health');
      assert.equal(states.get(NEW_UNITS[0]).active, true);
      assert.equal(JSON.parse(fs.readFileSync(plan.targets.config)).workbenchDir, path.join(legacy, 'res-workflow'));
      return evidence('fixture installed config and running states checked');
    },
    async verifyProofs({ plan }) {
      calls.push('proofs');
      assert.equal(fs.existsSync(path.join(plan.stateDir, 'workspace-directories.json')), true);
      assert.equal(JSON.parse(fs.readFileSync(path.join(plan.stateDir, ROLLOUT_PAUSE_FILE))).id, plan.id);
      if (dirtyConfig) fs.appendFileSync(plan.targets.settings, '\n');
      if (failProof) { const error = new Error('fixture-proof-failed'); error.code = 'fixture-proof-failed'; throw error; }
      return evidence('fixture seeded directories checked');
    },
    async verifyRestart() { calls.push('restart-proof'); return evidence('fixture restart hook checked'); },
    async quiesceNewSessions() { calls.push('quiesce-new-sessions'); return evidence('fixture has no native workers'); },
  };
  const plan = createMachineRolloutPlan({ homeDir, projectRoot });
  const bundle = stageRolloutArtifacts(plan);
  return { directory, homeDir, projectRoot, hostRoot, legacy, plan, bundle, adapter, states, calls, write,
    fail(value = true) { failProof = value; }, dirty(value = true) { dirtyConfig = value; } };
}

test('headless rollout retires old code only after real state seeding and all proof hooks', async t => {
  const f = fixture(t), original = rolloutFingerprint(path.join(f.legacy, 'res-workflow/preserved.json'));
  const result = await runRollout({ plan: f.plan, bundle: f.bundle, adapter: f.adapter, seedRuntimeState });
  assert.equal(result.ok, true); assert.equal(result.phase, 'complete');
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'dashboard')), false);
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'dashboard-access')), false);
  assert.deepEqual(rolloutFingerprint(path.join(f.legacy, 'res-workflow/preserved.json')), original);
  assert.equal(fs.readlinkSync(path.join(f.projectRoot, 'node_modules')), f.plan.nodeModulesTarget);
  const installed = JSON.parse(fs.readFileSync(f.plan.targets.settings));
  assert.deepEqual(installed.packages, ['npm:pi-subagents@0.79.2']); assert.deepEqual(installed.skills, ['/synthetic/retained-skill']);
  assert.equal(fs.readFileSync(f.plan.targets.caddyfile, 'utf8').includes('index.html'), false);
  assert.match(fs.readFileSync(f.plan.targets.launcher, 'utf8'), /research-host\/launch\.mjs/);
  assert.ok(JSON.parse(fs.readFileSync(f.plan.targets.settings, 'utf8')).extensions.includes(f.plan.sources.nativeExtension));
  const journal = JSON.parse(fs.readFileSync(result.journalFile));
  assert.deepEqual(journal.events.map(event => event.step), ['stop-legacy', 'snapshot', 'install', 'seed-state', 'start-new', 'retire-legacy']);
  assert.ok(f.calls.indexOf('restart-proof') < f.calls.lastIndexOf('health'));
  assert.equal(journal.events.findIndex(event => event.step === 'retire-legacy'), 5);
  assert.equal(fs.existsSync(journal.retired[0].destination), true);
  assert.equal(fs.existsSync(path.join(f.plan.stateDir, ROLLOUT_PAUSE_FILE)), false);
});

test('failed post-start proof restores exact files, symlink, old units and original active states', async t => {
  const f = fixture(t), settings = fs.readFileSync(f.plan.targets.settings), oldLink = fs.readlinkSync(f.plan.targets.nodeModules);
  f.fail();
  await assert.rejects(runRollout({ plan: f.plan, bundle: f.bundle, adapter: f.adapter, seedRuntimeState }), { code: 'fixture-proof-failed' });
  assert.deepEqual(fs.readFileSync(f.plan.targets.settings), settings);
  assert.equal(fs.readlinkSync(f.plan.targets.nodeModules), oldLink);
  assert.equal(fs.existsSync(f.plan.targets.hostService), false); assert.equal(fs.existsSync(f.plan.targets.token), false);
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'dashboard')), true);
  assert.equal(fs.existsSync(path.join(f.plan.stateDir, ROLLOUT_PAUSE_FILE)), false);
  for (const unit of LEGACY_UNITS) assert.deepEqual(f.states.get(unit), { active: true, enabled: true });
  for (const unit of NEW_UNITS) assert.deepEqual(f.states.get(unit), { active: false, enabled: false });
  const journal = JSON.parse(fs.readFileSync(path.join(f.plan.backupDir, 'rollout.json')));
  assert.equal(journal.phase, 'rolled-back'); assert.equal(journal.retired.length, 0);
});

test('changed legacy configuration prevents all service mutations', async t => {
  const f = fixture(t); fs.appendFileSync(f.plan.sources.settings, '\n');
  await assert.rejects(runRollout({ plan: f.plan, bundle: f.bundle, adapter: f.adapter, seedRuntimeState }), { code: 'rollout-path-changed' });
  assert.equal(f.calls.length, 0);
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'dashboard')), true);
});

test('bundle target tampering is refused before stopping services', async t => {
  const f = fixture(t), bad = structuredClone(f.bundle);
  bad.files[0].target = path.join(f.directory, 'unrelated-user-file');
  await assert.rejects(runRollout({ plan: f.plan, bundle: bad, adapter: f.adapter, seedRuntimeState }), { code: 'rollout-artifacts-invalid' });
  assert.equal(f.calls.length, 0); assert.equal(fs.existsSync(bad.files[0].target), false);
});

test('rollback refuses to overwrite a new user configuration and holds both schedulers stopped', async t => {
  const f = fixture(t); f.dirty(); f.fail();
  await assert.rejects(runRollout({ plan: f.plan, bundle: f.bundle, adapter: f.adapter, seedRuntimeState }), { code: 'rollout-rollback-needs-reconciliation' });
  assert.equal(fs.readFileSync(f.plan.targets.settings, 'utf8').endsWith('\n\n'), true);
  for (const unit of [...LEGACY_UNITS, ...NEW_UNITS]) assert.equal(f.states.get(unit).active, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.plan.backupDir, 'rollout.json'))).phase, 'rollback-needs-reconciliation');
});

test('a completed rollout can load its durable journal and restore the old code paths', async t => {
  const f = fixture(t);
  const result = await runRollout({ plan: f.plan, bundle: f.bundle, adapter: f.adapter, seedRuntimeState });
  f.write(path.join(f.projectRoot, 'backups/.pi-research-rollout.lock'), JSON.stringify({ pid: 2147483647, planSha256: f.plan.planSha256, journalFile: result.journalFile }));
  const restored = await rollbackRollout({ journalPath: result.journalFile, adapter: f.adapter, rollbackRuntimeState });
  assert.equal(restored.ok, true); assert.equal(restored.phase, 'rolled-back');
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'dashboard/package.json')), true);
  assert.equal(fs.existsSync(path.join(f.projectRoot, 'dashboard-access/Caddyfile')), true);
  assert.equal(fs.readlinkSync(f.plan.targets.nodeModules), path.join(f.projectRoot, 'dashboard/node_modules'));
  const before = f.calls.length;
  assert.equal((await rollbackRollout({ journalPath: result.journalFile, adapter: f.adapter, rollbackRuntimeState })).phase, 'rolled-back');
  assert.equal(f.calls.length, before);
});

test('an existing transaction lock prevents concurrent cutovers before service writes', async t => {
  const f = fixture(t), lock = path.join(f.projectRoot, 'backups/.pi-research-rollout.lock');
  const owner = JSON.stringify({ pid: process.pid, planSha256: f.plan.planSha256, journalFile: path.join(f.plan.backupDir, 'rollout.json') });
  f.write(lock, owner);
  await assert.rejects(runRollout({ plan: f.plan, bundle: f.bundle, adapter: f.adapter, seedRuntimeState }), { code: 'rollout-transaction-already-locked' });
  assert.equal(f.calls.length, 0); assert.equal(fs.readFileSync(lock, 'utf8'), owner);
});

test('journal rollback recovers interrupted file installs and retirement rename boundaries', async t => {
  const f = fixture(t);
  const result = await runRollout({ plan: f.plan, bundle: f.bundle, adapter: f.adapter, seedRuntimeState });
  const record = JSON.parse(fs.readFileSync(result.journalFile));
  const settings = record.updates.find(item => item.target === f.plan.targets.settings);
  const displaced = path.join(path.dirname(settings.target), '.' + path.basename(settings.target) + '.pi-rollout-' + f.plan.id);
  fs.copyFileSync(settings.snapshot, displaced); fs.chmodSync(displaced, settings.prior.mode);
  fs.linkSync(settings.target, displaced + '.new');
  const unit = record.retired.find(item => item.fingerprint.type === 'file');
  const retired = path.join(path.dirname(unit.source), '.' + path.basename(unit.source) + '.pi-retired-' + f.plan.id);
  fs.copyFileSync(unit.destination, retired); fs.chmodSync(retired, unit.fingerprint.mode); fs.unlinkSync(unit.destination);
  assert.equal((await rollbackRollout({ journalPath: result.journalFile, adapter: f.adapter, rollbackRuntimeState })).ok, true);
  assert.deepEqual(rolloutFingerprint(settings.target), settings.prior);
  assert.deepEqual(rolloutFingerprint(unit.source), unit.fingerprint);
  assert.equal(fs.existsSync(displaced), false); assert.equal(fs.existsSync(displaced + '.new'), false);
});
