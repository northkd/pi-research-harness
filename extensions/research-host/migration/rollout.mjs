import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { initializeLocalHost, ROLLOUT_PAUSE_FILE } from '../config.mjs';
import { createCaddyCutoverTemplate, validateProxyEnvironment } from '../deploy/proxy.mjs';
import { derivePiSettings, deriveMcpConfiguration, prepareHostConfiguration, knownDashboardRegistrations } from './configuration.mjs';
import { prepareMigration } from './index.mjs';
import { createRuntimeStateMigrationPlan } from './runtime-state.mjs';

export const ROLLOUT_SCHEMA = 'pi-research-rollout.v1';
export const LEGACY_UNITS = Object.freeze(['pi-research-dashboard-https.service', 'pi-research-workbench-sync.service', 'pi-research-dashboard.service']);
export const NEW_UNITS = Object.freeze(['pi-research-host.service', 'pi-research-proxy.service']);
const digest = value => createHash('sha256').update(value).digest('hex');
const objectHash = value => digest(JSON.stringify(value));
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safeCode = error => /^[a-z0-9-]{1,160}$/.test(error?.code ?? '') ? error.code : 'rollout-operation-failed';
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const shellQuote = value => "'" + value.replace(/'/g, "'\\''") + "'";

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value === '/' || /[\r\n\0]/.test(value)) fail('rollout-path-invalid');
  return value;
}

function within(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

function parents(file) {
  const directory = path.dirname(absolute(file));
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { if (fs.lstatSync(current).isSymbolicLink()) fail('rollout-symlink-parent-rejected'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

function fileHash(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), chunk = Buffer.alloc(1024 * 1024), hash = createHash('sha256');
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1) fail('rollout-file-invalid');
    for (;;) { const bytes = fs.readSync(fd, chunk, 0, chunk.length, null); if (!bytes) break; hash.update(chunk.subarray(0, bytes)); }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.dev !== after.dev || named.ino !== after.ino) fail('rollout-source-changed');
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}

export function rolloutFingerprint(file) {
  parents(file);
  let info;
  try { info = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return { type: 'absent' }; throw error; }
  if (info.isSymbolicLink()) return { type: 'symlink', target: fs.readlinkSync(file) };
  const mode = info.mode & 0o777;
  if (info.isFile()) return { type: 'file', mode, size: info.size, sha256: fileHash(file) };
  if (info.isDirectory()) return { type: 'directory', mode, dev: info.dev, ino: info.ino };
  fail('rollout-special-file-rejected');
}

function assertFingerprint(file, expected) { if (!equal(rolloutFingerprint(file), expected)) fail('rollout-path-changed'); }
function assertBackup(file, original) { assertFingerprint(file, original.type === 'file' ? { ...original, mode: 0o600 } : original); }

function privateDirectory(directory) {
  parents(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(directory) !== directory || !fs.lstatSync(directory).isDirectory() || fs.statSync(directory).mode & 0o077) fail('rollout-private-directory-required');
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function privateJson(file, value) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID());
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
}

function readJson(file) { const info = rolloutFingerprint(file); if (info.type !== 'file' || info.size > 16 * 1024 * 1024) fail('rollout-record-invalid'); return JSON.parse(fs.readFileSync(file, 'utf8')); }

function clearRolloutPause(plan) {
  const file = path.join(plan.stateDir, ROLLOUT_PAUSE_FILE);
  if (rolloutFingerprint(file).type === 'absent') return;
  if (readJson(file).id !== plan.id) fail('rollout-pause-owner-changed');
  fs.unlinkSync(file);
  syncDirectory(plan.stateDir);
}

function readLegacyAuth(text) {
  const users = [...text.matchAll(/^\s*([A-Za-z0-9_.-]{1,80})\s+(\$2[aby]\$\d{2}\$[A-Za-z0-9./]{53})\s*$/gm)];
  const site = /^\s*(https:\/\/[^\s{}]+)\s*\{/m.exec(text);
  if (users.length !== 1 || !site) fail('rollout-legacy-proxy-auth-unrecognized');
  return { user: users[0][1], passwordHash: users[0][2], site: site[1] };
}

export function createMachineRolloutPlan({ homeDir = os.homedir(), projectRoot = path.join(homeDir, '.local/share/pi-research'), hostPort = 18768, frontendRoot, backupDir, nodeModulesTarget = path.join(homeDir, '.pi/agent/install/releases/1.3.0/node_modules') } = {}) {
  absolute(homeDir); absolute(projectRoot); absolute(nodeModulesTarget);
  const id = randomUUID(), hostRoot = path.join(projectRoot, 'research-host');
  const unitDir = path.join(homeDir, '.config/systemd/user'), binDir = path.join(homeDir, '.local/bin');
  const legacyRoot = path.join(homeDir, '.pi/dashboard'), stateDir = path.join(homeDir, '.pi/research-host');
  const backup = absolute(backupDir ?? path.join(projectRoot, 'backups/cli-cutover-' + id));
  if (!within(path.join(projectRoot, 'backups'), backup) || backup === path.join(projectRoot, 'backups')) fail('rollout-backup-scope-invalid');
  if (rolloutFingerprint(backup).type !== 'absent' || rolloutFingerprint(stateDir).type !== 'absent') fail('rollout-fresh-state-required');
  const sources = {
    settings: path.join(homeDir, '.pi/agent/settings.json'), mcp: path.join(homeDir, '.pi/agent/mcp.json'),
    legacyConfig: path.join(legacyRoot, 'config.json'), legacyPreferences: path.join(legacyRoot, 'preferences.json'),
    caddyfile: path.join(projectRoot, 'dashboard-access/Caddyfile'), caddy: path.join(projectRoot, 'dashboard-access/caddy'),
    launcher: path.join(binDir, 'pi-research'),
    hostService: path.join(hostRoot, 'deploy/pi-research-host.service'), proxyService: path.join(hostRoot, 'deploy/pi-research-proxy.service.in'),
    host: path.join(hostRoot, 'server.mjs'), nativeExtension: path.join(hostRoot, 'native-extension.mjs'),
    cli: path.join(hostRoot, 'cli/main.mjs'), launchModule: path.join(hostRoot, 'launch.mjs'),
    flowBridge: path.join(hostRoot, 'supplemental/flow-bridge.mjs'),
  };
  const sourceFingerprints = Object.fromEntries(Object.entries(sources).map(([name, file]) => [name, rolloutFingerprint(file)]));
  for (const [name, info] of Object.entries(sourceFingerprints)) if (info.type !== 'file' && !(name === 'mcp' && info.type === 'absent')) fail('rollout-required-source-missing');
  if (fs.realpathSync(nodeModulesTarget) !== nodeModulesTarget || !fs.statSync(nodeModulesTarget).isDirectory() || within(path.join(projectRoot, 'dashboard'), nodeModulesTarget)) fail('rollout-independent-modules-required');
  const proxy = readLegacyAuth(fs.readFileSync(sources.caddyfile, 'utf8'));
  const configuration = prepareHostConfiguration({ homeDir, projectRoot, hostRoot, stateDir,
    legacyConfig: readJson(sources.legacyConfig), legacyPreferences: readJson(sources.legacyPreferences), port: hostPort });
  if (frontendRoot !== undefined && frontendRoot !== null) {
    absolute(frontendRoot);
    if (rolloutFingerprint(path.join(frontendRoot, 'index.html')).type !== 'file') fail('rollout-frontend-index-missing');
  }
  const targets = {
    settings: sources.settings, ...(sourceFingerprints.mcp.type === 'file' ? { mcp: sources.mcp } : {}), launcher: sources.launcher,
    cliLauncher: path.join(binDir, 'pi-research-host'), config: path.join(stateDir, 'config.json'), token: path.join(stateDir, 'local/token'),
    proxyEnvironment: path.join(homeDir, '.config/pi-research/host-proxy.env'), caddyfile: path.join(hostRoot, 'deploy/Caddyfile'), caddy: path.join(hostRoot, 'deploy/caddy'),
    hostService: path.join(unitDir, NEW_UNITS[0]), proxyService: path.join(unitDir, NEW_UNITS[1]), nodeModules: path.join(projectRoot, 'node_modules'),
  };
  const targetFingerprints = Object.fromEntries(Object.entries(targets).map(([name, file]) => [name, rolloutFingerprint(file)]));
  for (const name of ['cliLauncher', 'config', 'token', 'proxyEnvironment', 'caddyfile', 'caddy', 'hostService', 'proxyService']) if (targetFingerprints[name].type !== 'absent') fail('rollout-new-target-exists');
  const nodeLink = targetFingerprints.nodeModules;
  if (nodeLink.type !== 'symlink' || path.resolve(projectRoot, nodeLink.target) !== path.join(projectRoot, 'dashboard/node_modules')) fail('rollout-legacy-modules-link-unrecognized');
  const retirement = [path.join(projectRoot, 'dashboard'), path.join(projectRoot, 'dashboard-access'), path.join(projectRoot, 'dashboard-startup'), path.join(binDir, 'pi-research-dashboard'), ...LEGACY_UNITS.map(name => path.join(unitDir, name))]
    .map(file => ({ file, fingerprint: rolloutFingerprint(file) })).filter(entry => entry.fingerprint.type !== 'absent');
  for (const entry of retirement) if (entry.fingerprint.type === 'directory' && !within(projectRoot, entry.file)) fail('rollout-retirement-scope-invalid');
  const plan = { schema: ROLLOUT_SCHEMA, id, homeDir, projectRoot, hostRoot, stateDir, backupDir: backup, nodeModulesTarget, sources, sourceFingerprints, targets, targetFingerprints,
    retirement, configuration: configuration.config, publicAddress: proxy.site, frontendRoot: frontendRoot ?? null,
    tlsStorage: { data: path.join(homeDir, '.local/share/caddy'), config: path.join(homeDir, '.config/caddy') },
  };
  return { ...plan, planSha256: objectHash(plan) };
}

export function verifyRolloutPlan(plan) {
  const { planSha256, ...body } = plan;
  if (plan.schema !== ROLLOUT_SCHEMA || objectHash(body) !== planSha256) fail('rollout-plan-changed');
  for (const [name, file] of Object.entries(plan.sources)) assertFingerprint(file, plan.sourceFingerprints[name]);
  for (const [name, file] of Object.entries(plan.targets)) assertFingerprint(file, plan.targetFingerprints[name]);
  for (const entry of plan.retirement) assertFingerprint(entry.file, entry.fingerprint);
  return { ok: true, planSha256 };
}

function recoverInterruptedInstall(item, id) {
  const displaced = path.join(path.dirname(item.target), '.' + path.basename(item.target) + '.pi-rollout-' + id), temporary = displaced + '.new';
  // A crash between link and unlink leaves two names for the fully written file.
  if (fs.existsSync(temporary)) {
    const pending = fs.lstatSync(temporary);
    let current; try { current = fs.lstatSync(item.target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current && pending.dev === current.dev && pending.ino === current.ino) fs.unlinkSync(temporary);
    else { assertFingerprint(temporary, item.installed); fs.unlinkSync(temporary); }
  }
  if (rolloutFingerprint(displaced).type !== 'absent') {
    assertFingerprint(displaced, item.prior);
    const current = rolloutFingerprint(item.target);
    if (current.type === 'absent') fs.renameSync(displaced, item.target);
    else if (equal(current, item.prior) || equal(current, item.installed)) fs.unlinkSync(displaced);
    else fail('rollout-new-config-changed');
  }
}

export function stageRolloutArtifacts(plan) {
  verifyRolloutPlan(plan);
  privateDirectory(plan.backupDir);
  const directory = path.join(plan.backupDir, 'artifacts');
  if (rolloutFingerprint(directory).type !== 'absent') fail('rollout-artifact-directory-exists');
  privateDirectory(directory);
  const initialized = initializeLocalHost(path.join(directory, 'credential-init'), plan.configuration);
  const auth = readLegacyAuth(fs.readFileSync(plan.sources.caddyfile, 'utf8'));
  const env = { PI_RESEARCH_UI_USER: auth.user, PI_RESEARCH_UI_PASSWORD_HASH: auth.passwordHash, PI_RESEARCH_HOST_TOKEN: initialized.token };
  validateProxyEnvironment(env);
  const settingsText = fs.readFileSync(plan.sources.settings, 'utf8');
  const settings = derivePiSettings(JSON.parse(settingsText), { catalog: knownDashboardRegistrations({ homeDir: plan.homeDir, projectRoot: plan.projectRoot }),
    nativeExtensionPath: plan.sources.nativeExtension, sourceText: settingsText });
  const shared = `export PI_CODING_AGENT_DIR=${shellQuote(path.join(plan.homeDir, '.pi/agent'))}\nexport PI_SKIP_VERSION_CHECK=1\nexport PI_TELEMETRY=0\nexport PI_RESEARCH_LOOP_ROOT=${shellQuote(path.join(plan.projectRoot, 'research-loop'))}\nexport PI_RESEARCH_HOST_DIR=${shellQuote(plan.stateDir)}\nexport PI_RESEARCH_WORKBENCH_DIR=${shellQuote(plan.configuration.workbenchDir)}\nexport PI_RESEARCH_ACCESS_MODE_STORE_DIR=${shellQuote(plan.configuration.accessModeStoreDir)}\nexport PI_RESEARCH_TASK_PERMISSION_STORE_DIR=${shellQuote(plan.configuration.taskPermissionStoreDir)}\nexport PI_RESEARCH_HOST_MCP=1\n`;
  const launcher = '#!/usr/bin/env bash\nset -euo pipefail\numask 077\nexec /usr/bin/node '
    + shellQuote(plan.sources.launchModule) + ' "$@"\n';
  const cliLauncher = `#!/usr/bin/env bash\nset -euo pipefail\numask 077\n${shared}exec /usr/bin/node ${shellQuote(plan.sources.cli)} "$@"\n`;
  const generated = createCaddyCutoverTemplate({ publicAddress: plan.publicAddress, upstreamPort: plan.configuration.port, frontendRoot: plan.frontendRoot,
    accessLog: path.join(plan.hostRoot, 'deploy/http-access.jsonl') });
  const proxyService = fs.readFileSync(plan.sources.proxyService, 'utf8').replaceAll('@DEPLOY_DIRECTORY@', path.join(plan.hostRoot, 'deploy'))
    .replaceAll('@CADDY_BINARY@', plan.targets.caddy).replaceAll('@CADDYFILE@', plan.targets.caddyfile);
  const content = {
    settings: [settings.text, 0o600], launcher: [launcher, 0o700], cliLauncher: [cliLauncher, 0o700],
    config: [JSON.stringify(plan.configuration, null, 2) + '\n', 0o600], token: [initialized.token + '\n', 0o600],
    proxyEnvironment: [Object.entries(env).map(([name, value]) => name + '=' + value).join('\n') + '\n' + `XDG_DATA_HOME=${path.join(plan.homeDir, '.local/share')}\nXDG_CONFIG_HOME=${path.join(plan.homeDir, '.config')}\n`, 0o600],
    caddyfile: [generated.template, 0o600], caddy: [fs.readFileSync(plan.sources.caddy), 0o700],
    hostService: [fs.readFileSync(plan.sources.hostService), 0o644], proxyService: [proxyService, 0o644],
  };
  if (plan.targets.mcp) {
    const sourceText = fs.readFileSync(plan.sources.mcp, 'utf8');
    content.mcp = [deriveMcpConfiguration(JSON.parse(sourceText), { removeObsoleteDashboardEntry: true, sourceText }).text, 0o600];
  }
  const files = Object.entries(content).map(([name, [bytes, mode]]) => {
    const source = path.join(directory, name); fs.writeFileSync(source, bytes, { flag: 'wx', mode }); fs.chmodSync(source, mode);
    return { name, source, target: plan.targets[name], mode, fingerprint: rolloutFingerprint(source) };
  });
  const bundle = { schema: ROLLOUT_SCHEMA, planSha256: plan.planSha256, directory, files,
    symlink: { target: plan.targets.nodeModules, value: plan.nodeModulesTarget },
  };
  privateJson(path.join(directory, 'manifest.json'), bundle);
  return bundle;
}

function copyBackup(file, destination, fingerprint) {
  if (fingerprint.type === 'file') {
    fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL); fs.chmodSync(destination, 0o600);
    const descriptor = fs.openSync(destination, 'r'); try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    if (fileHash(destination) !== fingerprint.sha256) fail('rollout-backup-hash-mismatch');
  } else if (fingerprint.type === 'symlink') fs.symlinkSync(fingerprint.target, destination);
  syncDirectory(path.dirname(destination));
}

/** Compare, displace and install exclusively, preserving an intervening writer's bytes. */
function install(file, expected, artifact, id) {
  parents(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); assertFingerprint(file, expected);
  const displaced = path.join(path.dirname(file), '.' + path.basename(file) + '.pi-rollout-' + id);
  const temporary = displaced + '.new';
  if (artifact.type === 'file') { fs.copyFileSync(artifact.source, temporary, fs.constants.COPYFILE_EXCL); fs.chmodSync(temporary, artifact.mode); const fd = fs.openSync(temporary, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  if (expected.type !== 'absent') {
    fs.renameSync(file, displaced);
    if (!equal(rolloutFingerprint(displaced), expected)) {
      if (rolloutFingerprint(file).type === 'absent') fs.renameSync(displaced, file);
      if (artifact.type === 'file') fs.unlinkSync(temporary);
      fail('rollout-concurrent-config-write');
    }
  }
  try {
    if (artifact.type === 'file') fs.linkSync(temporary, file);
    else fs.symlinkSync(artifact.value, file);
  } catch (error) {
    if (expected.type !== 'absent' && rolloutFingerprint(file).type === 'absent') fs.renameSync(displaced, file);
    throw error;
  } finally { if (artifact.type === 'file' && fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  if (expected.type !== 'absent') fs.unlinkSync(displaced);
  syncDirectory(path.dirname(file));
}

function journalFile(plan) { return path.join(plan.backupDir, 'rollout.json'); }

function acquireRolloutLock(plan, recover = false) {
  const file = path.join(plan.projectRoot, 'backups/.pi-research-rollout.lock');
  parents(file); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const owner = { pid: process.pid, planSha256: plan.planSha256, journalFile: journalFile(plan), nonce: randomUUID() };
  let descriptor;
  try { descriptor = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const prior = readJson(file);
    if (!recover || prior.planSha256 !== plan.planSha256 || prior.journalFile !== journalFile(plan) || !Number.isInteger(prior.pid)) fail('rollout-transaction-already-locked');
    try { process.kill(prior.pid, 0); fail('rollout-transaction-already-locked'); }
    catch (pending) { if (pending.code !== 'ESRCH') throw pending; }
    fs.unlinkSync(file);
    return acquireRolloutLock(plan);
  }
  try { fs.writeFileSync(descriptor, JSON.stringify(owner)); fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  syncDirectory(path.dirname(file));
  return () => { if (!equal(readJson(file), owner)) fail('rollout-transaction-lock-changed'); fs.unlinkSync(file); syncDirectory(path.dirname(file)); };
}

function requireAdapter(adapter) {
  for (const name of ['serviceState', 'stop', 'start', 'enable', 'disable', 'daemonReload', 'assertQuiescent', 'verifyHealth', 'verifyProofs', 'verifyRestart', 'quiesceNewSessions']) if (typeof adapter?.[name] !== 'function') fail('rollout-adapter-contract-required');
}

function verifyBundle(plan, bundle) {
  if (bundle?.schema !== ROLLOUT_SCHEMA || bundle.planSha256 !== plan.planSha256 || bundle.directory !== path.join(plan.backupDir, 'artifacts') ||
      bundle.symlink?.target !== plan.targets.nodeModules || bundle.symlink?.value !== plan.nodeModulesTarget) fail('rollout-artifacts-invalid');
  const names = new Set();
  for (const file of bundle.files ?? []) {
    if (names.has(file.name) || file.name === 'nodeModules' || file.target !== plan.targets[file.name] || !within(bundle.directory, file.source) || file.source !== path.join(bundle.directory, file.name) || file.mode !== file.fingerprint?.mode) fail('rollout-artifacts-invalid');
    names.add(file.name); assertFingerprint(file.source, file.fingerprint);
  }
  if (names.size !== Object.keys(plan.targets).length - 1) fail('rollout-artifacts-incomplete');
}

async function proof(adapter, name, context) {
  const result = await adapter[name](context);
  if (result?.ok !== true || !Array.isArray(result.evidence) || !result.evidence.length) fail('rollout-' + name.toLowerCase() + '-unconfirmed');
  return result;
}

export async function runRollout(options = {}) {
  verifyRolloutPlan(options.plan); verifyBundle(options.plan, options.bundle);
  const release = acquireRolloutLock(options.plan);
  try { return await runRolloutLocked(options); } finally { release(); }
}

async function runRolloutLocked({ plan, bundle, adapter, seedRuntimeState, expectedPlanSha256 = plan?.planSha256 } = {}) {
  requireAdapter(adapter);
  if (typeof seedRuntimeState !== 'function' || expectedPlanSha256 !== plan.planSha256 || bundle.planSha256 !== plan.planSha256) fail('rollout-input-unconfirmed');
  verifyRolloutPlan(plan);
  verifyBundle(plan, bundle);
  const record = { schema: ROLLOUT_SCHEMA, plan, phase: 'preparing', updates: [], retired: [], services: {}, events: [] };
  if (rolloutFingerprint(journalFile(plan)).type !== 'absent') fail('rollout-already-started');
  for (const unit of [...LEGACY_UNITS, ...NEW_UNITS]) record.services[unit] = await adapter.serviceState(unit);
  for (const unit of NEW_UNITS) if (record.services[unit].active) fail('rollout-new-service-already-active');
  const save = () => privateJson(journalFile(plan), record);
  const step = async (name, action) => { record.phase = name; save(); await action(); record.events.push({ step: name, at: new Date().toISOString() }); save(); };
  let seeded;
  try {
    await step('stop-legacy', async () => { for (const unit of LEGACY_UNITS) await adapter.stop(unit); await proof(adapter, 'assertQuiescent', { plan, phase: 'legacy-stopped' }); });
    await step('snapshot', async () => {
      record.snapshot = await prepareMigration({ destinationDir: path.join(plan.backupDir, 'snapshot'), plan: createRuntimeStateMigrationPlan({ homeDir: plan.homeDir, projectRoot: plan.projectRoot, projectCwds: plan.configuration.knownCwds }),
        assertQuiescent: () => adapter.assertQuiescent({ plan, phase: 'snapshot' }) });
    });
    await step('install', async () => {
      const backup = path.join(plan.backupDir, 'original-files'); privateDirectory(backup);
      for (const artifact of bundle.files) {
        const expected = plan.targetFingerprints[artifact.name], snapshot = path.join(backup, artifact.name);
        assertFingerprint(artifact.target, expected); copyBackup(artifact.target, snapshot, expected);
        const update = { target: artifact.target, prior: expected, snapshot, installed: artifact.fingerprint, phase: 'intent' };
        record.updates.push(update); save();
        install(artifact.target, expected, { type: 'file', source: artifact.source, mode: artifact.mode }, plan.id);
        update.phase = 'done'; save();
      }
      const target = bundle.symlink.target, prior = plan.targetFingerprints.nodeModules, snapshot = path.join(backup, 'nodeModules');
      assertFingerprint(target, prior); copyBackup(target, snapshot, prior);
      const update = { target, prior, snapshot, installed: { type: 'symlink', target: bundle.symlink.value }, phase: 'intent' };
      record.updates.push(update); save(); install(target, prior, { type: 'symlink', value: bundle.symlink.value }, plan.id); update.phase = 'done'; save();
    });
    await step('seed-state', async () => {
      seeded = await seedRuntimeState({ snapshotDir: path.join(plan.backupDir, 'snapshot'), stateDir: plan.stateDir, backupDir: path.join(plan.backupDir, 'runtime-seed'), hostConfiguration: plan.configuration,
        assertQuiescent: () => adapter.assertQuiescent({ plan, phase: 'seed-state' }) });
      record.runtimeStateManifest = seeded.manifestFile; save();
      const verified = await seeded.verify({ verifySources: true });
      if (verified?.ok !== true) fail('rollout-runtime-seed-unverified');
    });
    await step('start-new', async () => {
      const pauseFile = path.join(plan.stateDir, ROLLOUT_PAUSE_FILE);
      if (rolloutFingerprint(pauseFile).type !== 'absent') fail('rollout-pause-already-present');
      privateJson(pauseFile, { id: plan.id });
      await adapter.daemonReload();
      for (const unit of LEGACY_UNITS) await adapter.disable(unit);
      for (const unit of NEW_UNITS) await adapter.enable(unit);
      await adapter.start(NEW_UNITS[0]);
      record.health = await proof(adapter, 'verifyHealth', { plan, bundle, publicReady: false });
      record.proofs = await proof(adapter, 'verifyProofs', { plan, bundle, publicReady: false });
      record.restart = await proof(adapter, 'verifyRestart', { plan, bundle, publicReady: false });
      await adapter.start(NEW_UNITS[1]);
      record.publicHealth = await proof(adapter, 'verifyHealth', { plan, bundle, publicReady: true });
    });
    await step('retire-legacy', async () => {
      const retired = path.join(plan.backupDir, 'retired'); privateDirectory(retired);
      for (const [index, entry] of plan.retirement.entries()) {
        assertFingerprint(entry.file, entry.fingerprint);
        const destination = path.join(retired, String(index).padStart(3, '0') + '-' + path.basename(entry.file));
        const item = { source: entry.file, destination, fingerprint: entry.fingerprint, phase: 'intent' }; record.retired.push(item); save();
        if (entry.fingerprint.type === 'directory') { fs.renameSync(entry.file, destination); syncDirectory(path.dirname(entry.file)); syncDirectory(retired); }
        else {
          const displaced = path.join(path.dirname(entry.file), '.' + path.basename(entry.file) + '.pi-retired-' + plan.id);
          fs.renameSync(entry.file, displaced);
          if (!equal(rolloutFingerprint(displaced), entry.fingerprint)) {
            if (rolloutFingerprint(entry.file).type === 'absent') fs.renameSync(displaced, entry.file);
            fail('rollout-retirement-source-changed');
          }
          copyBackup(displaced, destination, entry.fingerprint); fs.unlinkSync(displaced); syncDirectory(path.dirname(entry.file));
        }
        item.phase = 'done'; save();
      }
      await adapter.daemonReload();
      record.finalHealth = await proof(adapter, 'verifyHealth', { plan, bundle, publicReady: true });
      for (const item of record.retired) if (rolloutFingerprint(item.source).type !== 'absent') fail('rollout-retired-path-recreated');
    });
    clearRolloutPause(plan);
    record.phase = 'complete'; save();
    return { ok: true, phase: record.phase, journalFile: journalFile(plan), backupDir: plan.backupDir, retiredPaths: record.retired.map(item => item.source) };
  } catch (error) {
    record.failure = safeCode(error); save();
    try { await rollbackRolloutLocked({ journalPath: journalFile(plan), adapter, rollbackRuntimeState: seeded ? () => seeded.rollback() : undefined }); }
    catch (rollbackError) { const blocked = new Error('rollout-rollback-needs-reconciliation'); blocked.code = 'rollout-rollback-needs-reconciliation'; blocked.cause = safeCode(rollbackError); blocked.journalFile = journalFile(plan); throw blocked; }
    const failed = new Error(safeCode(error)); failed.code = safeCode(error); failed.journalFile = journalFile(plan); throw failed;
  }
}

export async function rollbackRollout(options = {}) {
  const record = readJson(absolute(options.journalPath));
  const release = acquireRolloutLock(record.plan, true);
  try { return await rollbackRolloutLocked(options); } finally { release(); }
}

async function rollbackRolloutLocked({ journalPath, adapter, rollbackRuntimeState } = {}) {
  requireAdapter(adapter);
  const record = readJson(absolute(journalPath)), plan = record.plan;
  const { planSha256, ...planBody } = plan;
  if (record.schema !== ROLLOUT_SCHEMA || journalPath !== journalFile(plan) || objectHash(planBody) !== planSha256) fail('rollout-journal-invalid');
  if (record.phase === 'rolled-back') return { ok: true, phase: record.phase, journalFile: journalPath };
  const save = () => privateJson(journalPath, record);
  record.phase = 'rolling-back'; save();
  try {
    await proof(adapter, 'quiesceNewSessions', { plan, installed: record.updates.length > 0 });
    for (const unit of [...NEW_UNITS].reverse()) await adapter.stop(unit);
    await proof(adapter, 'assertQuiescent', { plan, phase: 'rollback' });
    clearRolloutPause(plan);
    if (record.runtimeStateManifest) {
      if (typeof rollbackRuntimeState !== 'function') fail('rollout-runtime-rollback-required');
      const result = await rollbackRuntimeState({ manifestFile: record.runtimeStateManifest, assertQuiescent: () => adapter.assertQuiescent({ plan, phase: 'runtime-rollback' }) });
      if (result?.requiresReconciliation || result?.ok === false) fail('rollout-runtime-reconciliation-required');
    }
    for (const item of [...record.retired].reverse()) {
      const displaced = path.join(path.dirname(item.source), '.' + path.basename(item.source) + '.pi-retired-' + plan.id);
      if (rolloutFingerprint(item.source).type === 'absent' && rolloutFingerprint(displaced).type !== 'absent') {
        assertFingerprint(displaced, item.fingerprint); fs.renameSync(displaced, item.source); syncDirectory(path.dirname(item.source));
      }
      const present = rolloutFingerprint(item.source);
      if (equal(present, item.fingerprint)) continue;
      if (present.type !== 'absent') fail('rollout-retired-path-recreated');
      if (item.fingerprint.type === 'directory') { assertFingerprint(item.destination, item.fingerprint); fs.renameSync(item.destination, item.source); }
      else { assertBackup(item.destination, item.fingerprint); const artifact = item.fingerprint.type === 'file'
        ? { type: 'file', source: item.destination, mode: item.fingerprint.mode } : { type: 'symlink', value: item.fingerprint.target };
        install(item.source, { type: 'absent' }, artifact, plan.id + '-restore'); }
    }
    for (const item of [...record.updates].reverse()) {
      recoverInterruptedInstall(item, plan.id);
      const current = rolloutFingerprint(item.target);
      if (equal(current, item.prior)) continue;
      if (!equal(current, item.installed)) fail('rollout-new-config-changed');
      if (item.prior.type === 'absent') fs.unlinkSync(item.target);
      else { assertBackup(item.snapshot, item.prior); install(item.target, current, item.prior.type === 'file' ? { type: 'file', source: item.snapshot, mode: item.prior.mode } : { type: 'symlink', value: item.prior.target }, plan.id + '-restore'); }
    }
    await adapter.daemonReload();
    for (const unit of NEW_UNITS) await adapter.disable(unit);
    for (const unit of LEGACY_UNITS) {
      const previous = record.services[unit];
      if (previous.enabled) await adapter.enable(unit); else await adapter.disable(unit);
      if (previous.active) await adapter.start(unit);
    }
    record.phase = 'rolled-back'; save(); return { ok: true, phase: record.phase, journalFile: journalPath };
  } catch (error) {
    record.phase = 'rollback-needs-reconciliation'; record.rollbackFailure = safeCode(error); save(); throw error;
  }
}
