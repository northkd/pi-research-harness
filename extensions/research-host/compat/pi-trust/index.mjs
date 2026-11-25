import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createPiTrustMirrorService } from './upstream.mjs';

export const SOURCE_KINDS = Object.freeze(['worktreeInit', 'workflow', 'pinned', 'folderWorkspaces', 'accessGrants']);
const MAX_STATE_BYTES = 32 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function normalizeMirrorConfig(raw) {
  const value = object(raw) ? raw : {};
  const sources = { worktreeInit: true, workflow: true, pinned: true, folderWorkspaces: true, accessGrants: false };
  for (const kind of SOURCE_KINDS) if (typeof value.sources?.[kind] === 'boolean') sources[kind] = value.sources[kind];
  return { enabled: typeof value.enabled === 'boolean' ? value.enabled : true,
    coverInteractive: typeof value.coverInteractive === 'boolean' ? value.coverInteractive : false, sources };
}

function canonicalPath(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.normalize(file) !== file || file.includes('\0')) throw new Error('pi-trust-path-invalid');
  return file;
}

function inspectFile(file, { maxBytes = MAX_STATE_BYTES, privateMode = true } = {}) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.isSymbolicLink() || fs.realpathSync(file) !== file
      || info.uid !== process.getuid?.() || info.size > maxBytes || privateMode && (info.mode & 0o077) !== 0) throw new Error('pi-trust-state-refused');
  return info;
}

export function readTrustJson(file, { maxBytes = MAX_STATE_BYTES, privateMode = true } = {}) {
  canonicalPath(file);
  const before = inspectFile(file, { maxBytes, privateMode });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev) throw new Error('pi-trust-state-changed');
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, read);
      if (!count) throw new Error('pi-trust-state-changed');
      read += count;
    }
    const after = fs.fstatSync(fd), named = inspectFile(file, { maxBytes, privateMode });
    if (after.ino !== before.ino || after.dev !== before.dev || named.ino !== before.ino || named.dev !== before.dev
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error('pi-trust-state-changed');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } finally { fs.closeSync(fd); }
}

function checkOptionalFile(file) {
  try { inspectFile(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

function writeAtomic(file, content, mode) {
  canonicalPath(file);
  if (Buffer.byteLength(content) > MAX_STATE_BYTES) throw new Error('pi-trust-state-too-large');
  const directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(directory);
  if (fs.realpathSync(directory) !== directory || !parent.isDirectory() || parent.uid !== process.getuid?.()
      || (parent.mode & 0o022) !== 0) throw new Error('pi-trust-state-refused');
  checkOptionalFile(file);
  const temporary = path.join(directory, '.' + path.basename(file) + '.' + randomBytes(12).toString('hex') + '.tmp');
  let created = false;
  try {
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
    created = true;
    try { fs.writeFileSync(fd, content); fs.fchmodSync(fd, mode); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    checkOptionalFile(file);
    fs.renameSync(temporary, file);
    const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } finally { if (created) fs.rmSync(temporary, { force: true }); }
}

/** Read-only compatibility for the absent-or-legacy worktree hook trust map. */
export function readWorktreeTrust(file) {
  let value;
  try { value = readTrustJson(file); }
  catch { return []; }
  if (!object(value)) return [];
  return Object.entries(value).flatMap(([key, decision]) => {
    const separator = key.indexOf('\0');
    if (decision !== true || separator <= 0) return [];
    const repoRoot = key.slice(0, separator), hash = key.slice(separator + 1);
    return path.isAbsolute(repoRoot) && hash ? [{ repoRoot, hash }] : [];
  });
}

/** Construction and reads leave snapshot and overrides bytes untouched. */
export function createPiTrustMirror({ snapshotFile, overridesFile, getConfig, listPinned, listWorkspaceFolders,
  listWorktreeTrust, listPersistedGrants, home = os.homedir(), canWrite, warn, ...options }) {
  canonicalPath(snapshotFile); canonicalPath(overridesFile);
  if (snapshotFile === overridesFile || [getConfig, listPinned, listWorkspaceFolders, listWorktreeTrust, listPersistedGrants].some(value => typeof value !== 'function')) throw new Error('pi-trust-dependencies-required');
  const checkFiles = () => { checkOptionalFile(snapshotFile); checkOptionalFile(overridesFile); };
  checkFiles();
  const service = createPiTrustMirrorService({ ...options, home, snapshotPath: snapshotFile, overridesPath: overridesFile,
    getConfig: () => normalizeMirrorConfig(getConfig()), listPinned, listWorkspaceFolders, listWorktreeTrust,
    listPersistedGrants, canWrite, warn, writeAtomic });
  return Object.fromEntries(Object.entries(service).map(([name, method]) => [name, (...args) => {
    checkFiles();
    if (canWrite && ['setChoice', 'grant', 'revoke', 'revokeMany', 'rewriteSnapshot', 'rebuildAtBoot'].includes(name) && !canWrite()) throw new Error('pi-trust-mirror: this server does not hold the home lock');
    return method(...args);
  }]));
}
