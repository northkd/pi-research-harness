import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createDefaultMigrationPlan, prepareMigration, verifyMigration } from './index.mjs';
import { createSupplementalStateMappings } from '../supplemental/state-compat.mjs';

const SCHEMA = 'pi-research-runtime-state-seed.v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const stamp = info => [info.dev, info.ino, info.size, info.mode, info.mtimeMs, info.ctimeMs].join(':');
const inside = (root, value) => value === root || value.startsWith(root + path.sep);
const COPY_TARGETS = new Map([
  ['goals', 'goals'], ['questions', 'questions'], ['kb-global-config', 'knowledge_base.json'],
  ['kb-global-trust', 'kb-source-trust.json'], ['kb-global-cache', 'kb/sources'],
  ['workbench-sync-state', 'workbench-sync/state'], ['legacy-preferences', 'preferences.json'],
  ['legacy-tool-overrides', 'tool-overrides.json'], ['legacy-vault-projects', 'vault-projects.json'],
  ['legacy-custom-event-groups', 'custom-event-groups.json'], ['legacy-services-run', 'services-run'],
]);

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || value === '/') fail('runtime-state-path-invalid');
  return value;
}

function inspectPath(value, { optional = false, owner = true } = {}) {
  absolute(value);
  let cursor = path.parse(value).root;
  for (const segment of value.slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, segment);
    let info;
    try { info = fs.lstatSync(cursor); }
    catch (error) { if (optional && error.code === 'ENOENT') return undefined; throw error; }
    if (info.isSymbolicLink()) fail('runtime-state-symlink-rejected');
  }
  const info = fs.lstatSync(value);
  if (fs.realpathSync(value) !== value || owner && info.uid !== process.getuid?.()) fail('runtime-state-owner-invalid');
  return info;
}

function digestFile(file) {
  const before = inspectPath(file);
  if (!before.isFile() || before.nlink !== 1) fail('runtime-state-file-invalid');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    if (stamp(fs.fstatSync(descriptor)) !== stamp(before)) fail('runtime-state-file-changed');
    const digest = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    for (;;) {
      const count = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (!count) break;
      size += count; digest.update(buffer.subarray(0, count));
    }
    if (size !== before.size || stamp(fs.fstatSync(descriptor)) !== stamp(before) || stamp(fs.lstatSync(file)) !== stamp(before)) fail('runtime-state-file-changed');
    return { sha256: digest.digest('hex'), size };
  } finally { fs.closeSync(descriptor); }
}

function inventory(root) {
  if (!inspectPath(root, { optional: true })) return undefined;
  const entries = [];
  const visit = (file, relative) => {
    if (entries.length >= 100_000) fail('runtime-state-file-capacity');
    const before = inspectPath(file);
    if (before.isDirectory()) {
      entries.push({ path: relative, type: 'directory', mode: before.mode & 0o777 });
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), relative ? path.join(relative, name) : name);
      if (stamp(fs.lstatSync(file)) !== stamp(before)) fail('runtime-state-file-changed');
    } else if (before.isFile()) entries.push({ path: relative, type: 'file', mode: before.mode & 0o777, ...digestFile(file) });
    else fail('runtime-state-special-file-rejected');
  };
  visit(root, '');
  return entries;
}

const contents = entries => entries?.map(({ path: relative, type, mode, size, sha256 }) => ({ path: relative, type, mode, ...(type === 'file' ? { size, sha256 } : {}) }));
const sameContents = (left, right) => JSON.stringify(contents(left)) === JSON.stringify(contents(right));
const privateEntries = entries => entries.map(entry => ({ ...entry, mode: entry.type === 'directory' ? 0o700 : 0o600 }));

function ensureDirectory(directory, created, requirePrivate = true) {
  const existing = inspectPath(directory, { optional: true, owner: requirePrivate });
  if (existing) {
    if (!existing.isDirectory() || requirePrivate && existing.mode & 0o077) fail('runtime-state-directory-not-private');
    return;
  }
  ensureDirectory(path.dirname(directory), created, false);
  fs.mkdirSync(directory, { mode: 0o700 });
  created.push(directory);
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeRecord(file, value) {
  const temporary = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID());
  const descriptor = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(descriptor); }
  finally { fs.closeSync(descriptor); }
  fs.renameSync(temporary, file); syncDirectory(path.dirname(file));
}

function signed(record) {
  const { manifestSha256: _previous, ...payload } = record;
  return { ...payload, manifestSha256: hash(JSON.stringify(payload)) };
}

function readRecord(file) {
  const info = inspectPath(file);
  if (!info.isFile() || info.nlink !== 1 || info.mode & 0o077 || info.size > 100 * 1024 * 1024) fail('runtime-state-manifest-invalid');
  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { fail('runtime-state-manifest-invalid'); }
  if (!object(record)) fail('runtime-state-manifest-invalid');
  const { manifestSha256, ...payload } = record;
  if (record.schema !== SCHEMA || manifestSha256 !== hash(JSON.stringify(payload))) fail('runtime-state-manifest-changed');
  absolute(record.stateDir); absolute(record.snapshotDir);
  if (!Array.isArray(record.roots) || !Array.isArray(record.bindings) || !Array.isArray(record.createdDirectories)) fail('runtime-state-manifest-invalid');
  for (const root of record.roots) {
    const target = root.id === 'workspace-directories' ? 'workspace-directories.json' : COPY_TARGETS.get(root.id);
    if (!target || root.target !== target || !Array.isArray(root.entries)) fail('runtime-state-manifest-invalid');
    for (const entry of root.entries) {
      if (typeof entry.path !== 'string' || entry.path && (path.isAbsolute(entry.path) || path.normalize(entry.path) !== entry.path
          || entry.path === '..' || entry.path.startsWith('../')) || !['file', 'directory'].includes(entry.type)) fail('runtime-state-manifest-invalid');
    }
  }
  if (record.createdDirectories.some(directory => !inside(record.stateDir, absolute(directory)))) fail('runtime-state-manifest-invalid');
  return record;
}

async function quiescent(assertQuiescent) {
  if (typeof assertQuiescent !== 'function') fail('runtime-state-quiescence-required');
  const evidence = await assertQuiescent();
  const observed = Date.parse(evidence?.observedAt);
  if (evidence?.ok !== true || !Number.isFinite(observed) || observed > Date.now() + 1000 || Date.now() - observed > 60_000
      || !Array.isArray(evidence.evidence) || !evidence.evidence.length || evidence.evidence.some(item => typeof item !== 'string' || !item.trim())) fail('runtime-state-quiescence-unconfirmed');
  return { observedAt: evidence.observedAt, evidence: evidence.evidence };
}

/** Include operational state alongside the existing sealed-root snapshot plan. */
export function createRuntimeStateMigrationPlan(options = {}) {
  const settings = { ...options, homeDir: options.homeDir ?? os.homedir() };
  const base = createDefaultMigrationPlan(settings);
  const additional = createSupplementalStateMappings({ ...settings, sessionsDir: settings.nativeSessionsDir });
  const legacy = settings.legacyDashboardDir ?? path.join(settings.homeDir, '.pi/dashboard');
  for (const [id, relative] of [['legacy-custom-event-groups', 'custom-event-groups.json'], ['legacy-services-run', 'services-run']]) {
    additional.copy.push({ id, source: path.join(legacy, relative), target: 'legacy/' + relative, optional: true });
  }
  for (const group of ['copy', 'retain']) for (const root of additional[group]) {
    const duplicate = base[group].find(existing => existing.id === root.id || existing.source === root.source);
    if (duplicate) {
      if (duplicate.source !== root.source) fail('runtime-state-source-mapping-conflict');
    } else base[group].push(root);
  }
  return base;
}

function runtimeBindings(manifest, config) {
  if (!object(config)) fail('runtime-state-configuration-required');
  const roots = new Map([...manifest.plan.copy, ...manifest.plan.retain].map(root => [root.id, root]));
  const bindings = [];
  for (const [id, field] of [
    ['res-workflow', 'workbenchDir'], ['native-sessions', 'sessionsDir'], ['research-access-modes', 'accessModeStoreDir'],
    ['research-task-permissions', 'taskPermissionStoreDir'], ['legacy-access-grants', 'accessGrantsFile'],
    ['legacy-trust-mirror', 'piTrustMirrorSnapshotFile'], ['legacy-trust-overrides', 'piTrustMirrorOverridesFile'],
  ]) {
    const root = roots.get(id);
    if (!root || config[field] === undefined && root.optional === true && !fs.existsSync(root.source)) continue;
    if (config[field] !== root.source) fail('runtime-state-retained-root-mismatch');
    const info = inspectPath(root.source, { optional: root.optional === true });
    bindings.push({ id, field, source: root.source, exists: !!info,
      ...(info?.isDirectory() ? { identity: [info.dev, info.ino] } : {}) });
  }
  const attachments = roots.get('attachments');
  if (attachments && fs.existsSync(attachments.source)) {
    if (!Array.isArray(config.legacyAttachmentRoots) || !config.legacyAttachmentRoots.includes(attachments.source)) fail('runtime-state-retained-root-mismatch');
    const info = inspectPath(attachments.source);
    bindings.push({ id: attachments.id, field: 'legacyAttachmentRoots', source: attachments.source, exists: true, identity: [info.dev, info.ino] });
  }
  const prices = roots.get('native-model-prices');
  if (prices) {
    if (config.agentDir !== path.dirname(prices.source)) fail('runtime-state-retained-root-mismatch');
    const info = inspectPath(config.agentDir);
    bindings.push({ id: 'native-agent-directory', field: 'agentDir', source: config.agentDir, exists: true, identity: [info.dev, info.ino] });
  }
  return bindings;
}

function verifyBindings(bindings) {
  for (const binding of bindings) {
    const info = inspectPath(binding.source, { optional: !binding.exists });
    if (binding.exists && !info || binding.identity && JSON.stringify([info.dev, info.ino]) !== JSON.stringify(binding.identity)) fail('runtime-state-retained-identity-changed');
  }
}

function copyRoot(root, stateDir, createdDirectories) {
  const target = path.join(stateDir, root.target);
  for (const entry of root.entries) {
    const destination = entry.path ? path.join(target, entry.path) : target;
    if (entry.type === 'directory') ensureDirectory(destination, createdDirectories);
    else {
      ensureDirectory(path.dirname(destination), createdDirectories);
      if (root.content !== undefined) {
        const fd = fs.openSync(destination, 'wx', 0o600);
        try { fs.writeFileSync(fd, root.content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      } else {
        const source = entry.path ? path.join(root.source, entry.path) : root.source;
        const before = digestFile(source);
        if (before.sha256 !== entry.sha256 || before.size !== entry.size) fail('runtime-state-snapshot-changed');
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 0o600);
        const fd = fs.openSync(destination, 'r');
        try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
    }
  }
  for (const entry of [...root.entries].reverse()) if (entry.type === 'directory') syncDirectory(entry.path ? path.join(target, entry.path) : target);
  syncDirectory(path.dirname(target));
}

export function verifyRuntimeStateSeed({ manifestFile, verifySources = false }) {
  const manifest = readRecord(absolute(manifestFile));
  if (manifest.status !== 'ready') fail('runtime-state-manifest-not-ready');
  verifyMigration({ destinationDir: manifest.snapshotDir, verifySources });
  verifyBindings(manifest.bindings);
  for (const root of manifest.roots) if (!sameContents(root.entries, inventory(path.join(manifest.stateDir, root.target)))) fail('runtime-state-destination-changed');
  return { ok: true, id: manifest.id, roots: manifest.roots.length, files: manifest.roots.reduce((sum, root) => sum + root.entries.filter(entry => entry.type === 'file').length, 0), retainedRoots: manifest.bindings.length };
}

/** Seed only exclusive new roots. A running host must be stopped before verification or rollback. */
export async function seedRuntimeState({ snapshotDir, stateDir, backupDir, hostConfiguration, assertQuiescent, afterSeed }) {
  for (const value of [snapshotDir, stateDir, backupDir]) absolute(value);
  if (inside(stateDir, backupDir) || inside(backupDir, stateDir)) fail('runtime-state-path-overlap');
  const before = await quiescent(assertQuiescent);
  verifyMigration({ destinationDir: snapshotDir, verifySources: true });
  const snapshot = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'migration-manifest.json'), 'utf8'));
  const bindings = runtimeBindings(snapshot, hostConfiguration);
  const expectedPlan = createRuntimeStateMigrationPlan({ homeDir: path.dirname(path.dirname(hostConfiguration.agentDir)),
    projectRoot: path.dirname(hostConfiguration.researchLoopRoot), legacyDashboardDir: path.dirname(hostConfiguration.workbenchDir),
    nativeSessionsDir: hostConfiguration.sessionsDir, projectCwds: hostConfiguration.knownCwds ?? [] });
  for (const group of ['copy', 'retain']) for (const root of expectedPlan[group]) {
    if (inspectPath(root.source, { optional: true }) && !snapshot.plan[group].some(candidate => candidate.source === root.source)) {
      fail('runtime-state-snapshot-coverage-incomplete');
    }
  }
  for (const binding of bindings) if (inside(binding.source, stateDir) || inside(stateDir, binding.source)) fail('runtime-state-path-overlap');
  const roots = snapshot.sourceSnapshot.filter(root => root.exists && COPY_TARGETS.has(root.id)).map(root => ({
    id: root.id, source: path.join(snapshotDir, 'data', root.target), target: COPY_TARGETS.get(root.id), entries: privateEntries(root.entries),
  }));
  const preferences = roots.find(root => root.id === 'legacy-preferences');
  if (preferences) {
    const value = JSON.parse(fs.readFileSync(preferences.source, 'utf8'));
    if (!Array.isArray(value.pinnedDirectories) || value.pinnedDirectories.some(item => typeof item !== 'string' || !path.isAbsolute(item) || path.resolve(item) !== item)) fail('runtime-state-preferences-invalid');
    const pinned = [...new Set(value.pinnedDirectories)];
    if (JSON.stringify(hostConfiguration.knownCwds) !== JSON.stringify(pinned)) fail('runtime-state-pinned-directories-mismatch');
    const content = JSON.stringify({ version: 1, pinned, created: [] }, null, 2) + '\n';
    roots.push({ id: 'workspace-directories', target: 'workspace-directories.json', content,
      entries: [{ path: '', type: 'file', mode: 0o600, size: Buffer.byteLength(content), sha256: hash(content) }] });
  }
  for (const root of roots) {
    const existing = inventory(path.join(stateDir, root.target));
    root.owned = !existing;
    root.initialEmpty = !!existing && existing.length === 1 && existing[0].type === 'directory' && existing[0].mode === 0o700;
    if (existing && !root.initialEmpty && !sameContents(root.entries, existing)) fail('runtime-state-existing-content-conflict');
    root.reused = !!existing && !root.initialEmpty;
  }
  const createdDirectories = [];
  ensureDirectory(backupDir, createdDirectories);
  const journalDir = path.join(backupDir, 'runtime-state-seed');
  if (inspectPath(journalDir, { optional: true })) fail('runtime-state-transaction-exists');
  fs.mkdirSync(journalDir, { mode: 0o700 });
  const manifestFile = path.join(journalDir, 'manifest.json');
  const manifest = { schema: SCHEMA, id: randomUUID(), status: 'copying', snapshotDir, stateDir,
    createdAt: new Date().toISOString(), roots, bindings, createdDirectories: [], quiescence: { before } };
  writeRecord(manifestFile, signed(manifest));
  try {
    ensureDirectory(stateDir, createdDirectories);
    for (const root of roots) if (!root.reused) {
      copyRoot(root, stateDir, createdDirectories);
      if (!sameContents(root.entries, inventory(path.join(stateDir, root.target)))) fail('runtime-state-destination-changed');
      root.installed = true;
    }
    if (typeof afterSeed === 'function') await afterSeed();
    const after = await quiescent(assertQuiescent);
    verifyMigration({ destinationDir: snapshotDir, verifySources: true });
    verifyBindings(bindings);
    manifest.status = 'ready'; manifest.createdDirectories = createdDirectories.filter(directory => inside(stateDir, directory));
    manifest.quiescence.after = after;
    writeRecord(manifestFile, signed(manifest));
    const verified = verifyRuntimeStateSeed({ manifestFile, verifySources: true });
    return { ...verified, manifestFile,
      verify: options => verifyRuntimeStateSeed({ manifestFile, ...options }),
      rollback: () => rollbackRuntimeStateSeed({ manifestFile, assertQuiescent }) };
  } catch (error) {
    manifest.status = 'failed'; manifest.createdDirectories = createdDirectories.filter(directory => inside(stateDir, directory));
    manifest.error = /^[a-z-]{1,100}$/.test(error.code ?? '') ? error.code : 'runtime-state-seed-failed';
    writeRecord(manifestFile, signed(manifest));
    error.runtimeStateManifest = manifestFile;
    throw error;
  }
}

export async function rollbackRuntimeStateSeed({ manifestFile, assertQuiescent }) {
  const manifest = readRecord(absolute(manifestFile));
  if (manifest.status === 'rolled-back') return { ok: true, rolledBack: true, id: manifest.id };
  await quiescent(assertQuiescent);
  verifyBindings(manifest.bindings);
  const changed = manifest.roots.filter(root => !root.reused && (root.installed || inventory(path.join(manifest.stateDir, root.target)))
    && !sameContents(root.entries, inventory(path.join(manifest.stateDir, root.target))));
  if (changed.length) {
    let destinationDir = path.join(path.dirname(manifestFile), 'changed-runtime-state');
    let reusable = false;
    if (inspectPath(destinationDir, { optional: true })) {
      try { reusable = verifyMigration({ destinationDir, verifySources: true }).ok; }
      catch { destinationDir += '-' + randomUUID(); }
    }
    if (!reusable) await prepareMigration({ destinationDir, assertQuiescent,
      plan: { schema: 'pi-research-cli-migration.v1', copy: changed.map(root => ({ id: root.id, source: path.join(manifest.stateDir, root.target), target: root.target, optional: false })), retain: [] } });
    writeRecord(manifestFile, signed({ ...manifest, status: 'reconciliation-required', preservedSnapshot: destinationDir }));
    return { ok: false, rolledBack: false, requiresReconciliation: true, id: manifest.id,
      code: 'runtime-state-rollback-reconciliation-required', preservedSnapshot: destinationDir };
  }
  for (const root of [...manifest.roots].reverse()) {
    if (root.reused || !inventory(path.join(manifest.stateDir, root.target))) continue;
    const destination = path.join(manifest.stateDir, root.target);
    if (root.initialEmpty) for (const entry of [...root.entries].reverse()) {
      if (!entry.path) continue;
      const file = path.join(destination, entry.path);
      if (entry.type === 'directory') fs.rmdirSync(file); else fs.unlinkSync(file);
    }
    else fs.rmSync(destination, { recursive: true });
  }
  for (const directory of [...manifest.createdDirectories].reverse()) {
    try { fs.rmdirSync(directory); } catch (error) { if (!['ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error; }
  }
  await quiescent(assertQuiescent);
  writeRecord(manifestFile, signed({ ...manifest, status: 'rolled-back', rolledBackAt: new Date().toISOString() }));
  return { ok: true, rolledBack: true, id: manifest.id };
}

export const rollbackRuntimeState = rollbackRuntimeStateSeed;
