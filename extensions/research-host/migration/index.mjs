import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const MIGRATION_SCHEMA = 'pi-research-cli-migration.v1';
const MANIFEST_NAME = 'migration-manifest.json';
const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIRECTORY_MODE = 0o700;
const hash = value => createHash('sha256').update(value).digest('hex');
const sort = values => values.sort((a, b) => a.localeCompare(b, 'en'));
const stamp = info => [info.dev, info.ino, info.mode, info.nlink, info.size, info.mtimeMs, info.ctimeMs].join(':');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = code => { const error = new Error(code); error.code = code; throw error; };

function absolute(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) fail('migration-path-not-canonical');
  return value;
}

function relative(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || path.isAbsolute(value) || path.normalize(value) !== value || value === '.' || value === '..' || value.startsWith('../')) fail('migration-target-invalid');
  return value;
}

function inspectAncestors(value) {
  absolute(value);
  let current = path.parse(value).root;
  for (const part of value.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let info;
    try { info = fs.lstatSync(current); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (info.isSymbolicLink()) fail('migration-symlink-rejected');
  }
}

function knownPath(value, directory) {
  inspectAncestors(value);
  const info = fs.lstatSync(value);
  if (fs.realpathSync(value) !== value || (directory ? !info.isDirectory() : !info.isFile())) fail('migration-source-invalid');
  return info;
}

function inside(directory, candidate) {
  const rel = path.relative(directory, candidate);
  return rel === '' || rel !== '..' && !rel.startsWith('../') && !path.isAbsolute(rel);
}

function digestFile(file, expected) {
  const before = knownPath(file, false);
  if (before.nlink !== 1 || expected && stamp(before) !== expected) fail('migration-source-changed');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (stamp(opened) !== stamp(before)) fail('migration-source-changed');
    const digest = createHash('sha256');
    const chunk = Buffer.alloc(1024 * 1024);
    let count = 0;
    for (;;) {
      const bytes = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (!bytes) break;
      count += bytes;
      digest.update(chunk.subarray(0, bytes));
    }
    if (count !== before.size || stamp(fs.fstatSync(fd)) !== stamp(before) || stamp(fs.lstatSync(file)) !== stamp(before)) fail('migration-source-changed');
    return { sha256: digest.digest('hex'), size: count, mode: before.mode & 0o777, stamp: stamp(before) };
  } finally { fs.closeSync(fd); }
}

function scanRoot(root, { digest = true, maximumFiles = 100_000 } = {}) {
  const source = absolute(root.source);
  inspectAncestors(source);
  let info;
  try { info = fs.lstatSync(source); }
  catch (error) {
    if (error.code === 'ENOENT' && root.optional === true) return { id: root.id, source, target: root.target, exists: false, entries: [] };
    throw error;
  }
  const entries = [];
  let visited = 0;
  const visit = (file, name) => {
    if (++visited > maximumFiles) fail('migration-source-too-many-files');
    const entry = fs.lstatSync(file);
    if (entry.isSymbolicLink()) fail('migration-symlink-rejected');
    if (entry.isDirectory()) {
      entries.push({ path: name, type: 'directory', mode: entry.mode & 0o777, stamp: stamp(entry) });
      const names = sort(fs.readdirSync(file));
      for (const child of names) visit(path.join(file, child), name ? path.join(name, child) : child);
      if (stamp(fs.lstatSync(file)) !== stamp(entry)) fail('migration-source-changed');
    } else if (entry.isFile()) {
      if (entry.nlink !== 1) fail('migration-hardlink-rejected');
      entries.push({ path: name, type: 'file', ...(digest ? digestFile(file, stamp(entry)) : { size: entry.size, mode: entry.mode & 0o777, stamp: stamp(entry) }) });
    } else fail('migration-special-file-rejected');
  };
  visit(source, '');
  return { id: root.id, source, target: root.target, exists: true, type: info.isDirectory() ? 'directory' : 'file', entries };
}

function validatePlan(plan, destinationDir) {
  if (!object(plan) || plan.schema !== MIGRATION_SCHEMA || !Array.isArray(plan.copy) || !Array.isArray(plan.retain)) fail('migration-plan-invalid');
  const ids = new Set(), targets = [];
  for (const root of plan.copy) {
    if (!object(root) || typeof root.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(root.id) || ids.has(root.id)) fail('migration-plan-invalid');
    ids.add(root.id);
    absolute(root.source);
    relative(root.target);
    const destination = destinationDir && path.join(destinationDir, 'data', root.target);
    if (destination && (inside(root.source, destinationDir) || inside(destinationDir, root.source))) fail('migration-path-overlap');
    if (targets.some(target => inside(target, root.target) || inside(root.target, target))) fail('migration-target-overlap');
    targets.push(root.target);
  }
  for (const root of plan.retain) {
    if (!object(root) || typeof root.id !== 'string' || !/^[a-z0-9-]{1,80}$/.test(root.id) || ids.has(root.id)) fail('migration-plan-invalid');
    ids.add(root.id);
    absolute(root.source);
    if (destinationDir && (inside(root.source, destinationDir) || inside(destinationDir, root.source))) fail('migration-path-overlap');
  }
  return plan;
}

export function createDefaultMigrationPlan({ homeDir = os.homedir(), projectRoot = path.join(homeDir, '.local/share/pi-research'), legacyDashboardDir = path.join(homeDir, '.pi/dashboard'), nativeSessionsDir = path.join(homeDir, '.pi/agent/sessions') } = {}) {
  const copy = [
    ['res-workflow', 'res-workflow', 'res-workflow'],
    ['research-access-modes', 'research-access-modes', 'research-access-modes'],
    ['research-task-permissions', 'research-task-permissions', 'research-task-permissions'],
    ['goals', 'goals', 'goals'],
    ['attachments', 'attachments', 'attachments'],
    ['questions', 'questions', 'questions'],
    ['legacy-config', 'config.json', 'legacy/config.json'],
    ['legacy-identity-key', 'identity.key', 'legacy/identity.key'],
    ['legacy-local-token', 'local/token', 'legacy/local/token'],
    ['legacy-paired-devices', 'paired-devices.json', 'legacy/paired-devices.json'],
    ['legacy-instances', 'instances', 'legacy/instances'],
    ['legacy-boot-state', 'boot-state.json', 'legacy/boot-state.json'],
    ['legacy-headless-process-records', 'headless-pids.json', 'legacy/headless-pids.json'],
    ['legacy-preferences', 'preferences.json', 'legacy/preferences.json'],
    ['legacy-tool-overrides', 'tool-overrides.json', 'legacy/tool-overrides.json'],
    ['legacy-access-grants', 'access-grants.json', 'legacy/access-grants.json'],
    ['legacy-grant-store-id', 'grant-store-id', 'legacy/grant-store-id'],
    ['legacy-trust-overrides', 'pi-trust-overrides.json', 'legacy/pi-trust-overrides.json'],
    ['legacy-trust-mirror', 'pi-trust-mirror.json', 'legacy/pi-trust-mirror.json'],
    ['legacy-vault-projects', 'vault-projects.json', 'legacy/vault-projects.json'],
  ].map(([id, source, target]) => ({ id, source: path.join(legacyDashboardDir, source), target, optional: id !== 'res-workflow' }));
  copy.find(root => root.id === 'res-workflow').preserveSourceIdentity = true;
  copy.push({ id: 'workbench-sync-state', source: path.join(projectRoot, 'workbench-sync/state'), target: 'workbench-sync/state', optional: true });
  copy.push({ id: 'workbench-sync-config', source: path.join(projectRoot, 'workbench-sync/config.json'), target: 'legacy/workbench-sync-config.json', optional: true });
  return validatePlan({ schema: MIGRATION_SCHEMA, copy, retain: [
    { id: 'native-sessions', source: nativeSessionsDir, optional: false, reason: 'Retain original JSONL, metadata, child history and canonical session paths.' },
    { id: 'project-knowledge-base', source: path.join(projectRoot, '.pi/dashboard'), optional: true, reason: 'Project knowledge-base data stays at its existing project-relative path.' },
  ] });
}

function summary(root) {
  const files = root.entries.filter(entry => entry.type === 'file');
  return { id: root.id, source: root.source, ...(root.target ? { target: root.target } : {}), exists: root.exists,
    files: files.length, directories: root.entries.length - files.length, bytes: files.reduce((total, entry) => total + entry.size, 0),
    fileModes: [...new Set(files.map(entry => entry.mode.toString(8)))].sort(),
  };
}

export function inspectMigration({ plan = createDefaultMigrationPlan(), digest = false } = {}) {
  validatePlan(plan);
  const copy = plan.copy.map(root => scanRoot(root, { digest }));
  const retain = plan.retain.map(root => scanRoot(root, { digest }));
  return { schema: MIGRATION_SCHEMA, observedAt: new Date().toISOString(), copy: copy.map(summary), retain: retain.map(summary),
    copyBytes: copy.reduce((total, root) => total + summary(root).bytes, 0),
    retainedBytes: retain.reduce((total, root) => total + summary(root).bytes, 0),
  };
}

function privateDirectory(directory, boundary) {
  if (!inside(boundary, directory)) fail('migration-target-invalid');
  if (directory !== boundary) privateDirectory(path.dirname(directory), boundary);
  try { fs.mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE }); fs.chmodSync(directory, PRIVATE_DIRECTORY_MODE); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const info = knownPath(directory, true);
  if (info.mode & 0o077) fail('migration-destination-not-private');
}

function syncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeManifest(directory, record) {
  const file = path.join(directory, MANIFEST_NAME);
  const temporary = path.join(directory, '.' + MANIFEST_NAME + '.' + randomUUID());
  const bytes = JSON.stringify(record, null, 2) + '\n';
  const fd = fs.openSync(temporary, 'wx', PRIVATE_FILE_MODE);
  try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
  syncDirectory(directory);
}

function copyFile(source, destination, expected) {
  const input = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let output;
  try {
    if (stamp(fs.fstatSync(input)) !== expected.stamp) fail('migration-source-changed');
    output = fs.openSync(destination, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, PRIVATE_FILE_MODE);
    fs.fchmodSync(output, PRIVATE_FILE_MODE);
    const digest = createHash('sha256');
    const buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      const count = fs.readSync(input, buffer, 0, buffer.length, null);
      if (!count) break;
      total += count;
      digest.update(buffer.subarray(0, count));
      let written = 0;
      while (written < count) written += fs.writeSync(output, buffer, written, count - written, null);
    }
    if (total !== expected.size || digest.digest('hex') !== expected.sha256 || stamp(fs.fstatSync(input)) !== expected.stamp || stamp(fs.lstatSync(source)) !== expected.stamp) fail('migration-source-changed');
    fs.fsyncSync(output);
  } finally {
    fs.closeSync(input);
    if (output !== undefined) fs.closeSync(output);
  }
}

function sameSnapshot(left, right) { return JSON.stringify(left) === JSON.stringify(right); }

async function confirmQuiescent(assertQuiescent) {
  if (typeof assertQuiescent !== 'function') fail('migration-writer-quiescence-required');
  const result = await assertQuiescent();
  if (!object(result) || result.ok !== true || !Array.isArray(result.evidence) || result.evidence.length === 0 || result.evidence.some(item => typeof item !== 'string' || !item.trim()) || typeof result.observedAt !== 'string' || !Number.isFinite(Date.parse(result.observedAt))) fail('migration-writer-quiescence-unconfirmed');
  return { observedAt: result.observedAt, evidence: result.evidence };
}

/** The orchestrator must stop both old writers and new scheduling before calling. */
export async function prepareMigration({ destinationDir, plan = createDefaultMigrationPlan(), assertQuiescent, afterCopy } = {}) {
  absolute(destinationDir);
  validatePlan(plan, destinationDir);
  inspectAncestors(destinationDir);
  knownPath(path.dirname(destinationDir), true);
  try { fs.lstatSync(destinationDir); fail('migration-destination-exists'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const beforeGuard = await confirmQuiescent(assertQuiescent);
  const sourceSnapshot = plan.copy.map(root => scanRoot(root));
  const retainedSnapshot = plan.retain.map(root => scanRoot(root));
  await confirmQuiescent(assertQuiescent);
  fs.mkdirSync(destinationDir, { mode: PRIVATE_DIRECTORY_MODE });
  const dataDir = path.join(destinationDir, 'data');
  privateDirectory(dataDir, destinationDir);
  const base = { schema: MIGRATION_SCHEMA, id: randomUUID(), status: 'copying', createdAt: new Date().toISOString(), destinationDir,
    plan, sourceSnapshot, retainedSnapshot, snapshotSha256: hash(JSON.stringify({ sourceSnapshot, retainedSnapshot })),
    quiescence: { before: beforeGuard },
  };
  writeManifest(destinationDir, base);
  try {
    for (const root of sourceSnapshot) {
      if (!root.exists) continue;
      const targetRoot = path.join(dataDir, root.target);
      for (const entry of root.entries) {
        const destination = entry.path ? path.join(targetRoot, entry.path) : targetRoot;
        if (entry.type === 'directory') privateDirectory(destination, destinationDir);
        else {
          privateDirectory(path.dirname(destination), destinationDir);
          copyFile(entry.path ? path.join(root.source, entry.path) : root.source, destination, entry);
        }
      }
    }
    const directories = scanRoot({ id: 'data', source: dataDir }, { digest: false }).entries.filter(entry => entry.type === 'directory');
    for (const entry of directories.reverse()) syncDirectory(entry.path ? path.join(dataDir, entry.path) : dataDir);
    if (typeof afterCopy === 'function') await afterCopy();
    const afterGuard = await confirmQuiescent(assertQuiescent);
    const afterSnapshot = plan.copy.map(root => scanRoot(root));
    const afterRetained = plan.retain.map(root => scanRoot(root));
    if (!sameSnapshot(sourceSnapshot, afterSnapshot) || !sameSnapshot(retainedSnapshot, afterRetained)) fail('migration-source-changed');
    const ready = { ...base, status: 'ready', completedAt: new Date().toISOString(), quiescence: { before: beforeGuard, after: afterGuard } };
    ready.manifestSha256 = hash(JSON.stringify(ready));
    writeManifest(destinationDir, ready);
    const verification = verifyMigration({ destinationDir, verifySources: true });
    return { directory: destinationDir, manifest: path.join(destinationDir, MANIFEST_NAME), ...verification };
  } catch (error) {
    writeManifest(destinationDir, { ...base, status: 'failed', failedAt: new Date().toISOString(), error: /^migration-[a-z-]+$/.test(error.code ?? '') ? error.code : 'migration-copy-failed' });
    throw error;
  }
}

export function verifyMigration({ destinationDir, verifySources = false } = {}) {
  knownPath(absolute(destinationDir), true);
  const manifestFile = path.join(destinationDir, MANIFEST_NAME);
  const info = knownPath(manifestFile, false);
  if (info.mode & 0o077 || info.size > 100 * 1024 * 1024) fail('migration-manifest-invalid');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.schema !== MIGRATION_SCHEMA || manifest.status !== 'ready' || manifest.destinationDir !== destinationDir || typeof manifest.manifestSha256 !== 'string') fail('migration-manifest-not-ready');
  const { manifestSha256, ...payload } = manifest;
  if (manifestSha256 !== hash(JSON.stringify(payload)) || payload.snapshotSha256 !== hash(JSON.stringify({ sourceSnapshot: payload.sourceSnapshot, retainedSnapshot: payload.retainedSnapshot }))) fail('migration-manifest-changed');
  validatePlan(payload.plan, destinationDir);
  const expected = new Map();
  for (const root of payload.sourceSnapshot) {
    if (!root.exists) continue;
    for (const entry of root.entries) expected.set(entry.path ? path.join(root.target, entry.path) : root.target, entry);
  }
  const actual = scanRoot({ id: 'data', source: path.join(destinationDir, 'data'), optional: false });
  const seen = new Set();
  for (const entry of actual.entries) {
    if (!entry.path) { if (entry.type !== 'directory' || entry.mode !== PRIVATE_DIRECTORY_MODE) fail('migration-destination-not-private'); continue; }
    const wanted = expected.get(entry.path);
    if (!wanted) {
      if (entry.type !== 'directory' || ![...expected.keys()].some(name => inside(entry.path, name))) fail('migration-unexpected-destination-file');
    } else {
      if (entry.type !== wanted.type || entry.type === 'file' && (entry.size !== wanted.size || entry.sha256 !== wanted.sha256)) fail('migration-destination-changed');
      seen.add(entry.path);
    }
    if (entry.mode !== (entry.type === 'file' ? PRIVATE_FILE_MODE : PRIVATE_DIRECTORY_MODE)) fail('migration-destination-not-private');
  }
  if (seen.size !== expected.size) fail('migration-destination-incomplete');
  if (verifySources) {
    if (!sameSnapshot(payload.sourceSnapshot, payload.plan.copy.map(root => scanRoot(root))) || !sameSnapshot(payload.retainedSnapshot, payload.plan.retain.map(root => scanRoot(root)))) fail('migration-source-changed');
  }
  return { ok: true, id: payload.id, status: 'ready', files: actual.entries.filter(entry => entry.type === 'file').length,
    bytes: actual.entries.reduce((total, entry) => total + (entry.size ?? 0), 0), manifestSha256,
    sourceVerified: verifySources,
    requiredRuntimeRoots: payload.plan.copy.filter(root => root.preserveSourceIdentity === true).map(root => ({ id: root.id, source: root.source, reason: 'Existing sealed plans bind this canonical path and original filesystem identities.' })),
    retainedRoots: payload.retainedSnapshot.map(root => ({ id: root.id, source: root.source, exists: root.exists, files: root.entries.filter(entry => entry.type === 'file').length })),
  };
}
