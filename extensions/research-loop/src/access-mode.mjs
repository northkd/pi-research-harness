import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const SCHEMA = 'pi-research-access-mode.v1';
const MAX_BYTES = 16 * 1024;
const LOCAL_OWNER = JSON.stringify(['host', 'inert-operator']);
const LOCAL_ALIAS = JSON.stringify(['urn:pi-dashboard:local-operator', 'local-operator']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safe = (value, max) => typeof value === 'string' && !!value && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);
const revision = value => value === null || typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
const validMode = value => value === 'default' || value === 'full-access';
const hash = value => createHash('sha256').update(value).digest('hex');
export class ResearchAccessModeError extends Error {
  constructor(code) { super(code); this.name = 'ResearchAccessModeError'; this.code = code; }
}
const fail = code => { throw new ResearchAccessModeError(code); };

/** Host-private preference; never copied into a project or child prompt. */
export const researchAccessModeStoreDir = () => path.join(os.homedir(), '.pi', 'dashboard', 'research-access-modes');
export function researchAccessOwnerKey(principal) {
  if (principal === undefined) return LOCAL_OWNER;
  if (!object(principal) || !safe(principal.iss, 1024) || !safe(principal.sub, 1024)) fail('access-mode-invalid-owner');
  return normalizeOwner(JSON.stringify([principal.iss, principal.sub]));
}
function normalizeOwner(value) {
  let owner; try { owner = JSON.parse(value); } catch { fail('access-mode-invalid-owner'); }
  if (!Array.isArray(owner) || owner.length !== 2 || !owner.every(part => safe(part, 1024))) fail('access-mode-invalid-owner');
  const key = JSON.stringify(owner);
  return key === LOCAL_ALIAS ? LOCAL_OWNER : key;
}
function binding(input) {
  if (!safe(input?.cwd, 4096) || !path.isAbsolute(input.cwd)) fail('access-mode-invalid-cwd');
  try { if (fs.realpathSync(input.cwd) !== input.cwd || !fs.statSync(input.cwd).isDirectory()) fail('access-mode-invalid-cwd'); }
  catch (error) { if (error instanceof ResearchAccessModeError) throw error; fail('access-mode-invalid-cwd'); }
  return { cwd: input.cwd, ownerKey: normalizeOwner(input.ownerKey) };
}
function directory(dir, create) {
  const absolute = path.resolve(dir); let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('access-mode-unavailable');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      if (!create) return null;
      try { fs.mkdirSync(cursor, { mode: 0o700 }); }
      catch (createError) { if (createError.code !== 'EEXIST') throw createError; }
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('access-mode-unavailable');
    }
  }
  return absolute;
}
function recordFile(input, b, create = false) {
  const dir = directory(input.storeDir ?? researchAccessModeStoreDir(), create);
  return dir && path.join(dir, `${hash(JSON.stringify([b.ownerKey, b.cwd]))}.json`);
}
function readJson(file, maximum = MAX_BYTES, header = false) {
  if (fs.realpathSync(file) !== path.resolve(file)) fail('access-mode-unavailable');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || !header && before.size > maximum) fail('access-mode-unavailable');
    const buffer = Buffer.alloc(Math.min(before.size, maximum) + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev || after.nlink !== 1) fail('access-mode-unavailable');
    const end = header ? buffer.indexOf(10, 0) : count;
    if (header ? end < 0 || end >= count || end > maximum : count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('access-mode-unavailable');
    const bytes = buffer.subarray(0, end), text = bytes.toString('utf8');
    if (!Buffer.from(text).equals(bytes)) fail('access-mode-unavailable');
    const value = JSON.parse(text);
    if (!object(value)) fail('access-mode-unavailable');
    return value;
  } finally { fs.closeSync(fd); }
}
function readRecord(file, b) {
  if (!file) return null;
  try {
    const value = readJson(file);
    if (value.schema !== SCHEMA || value.cwd !== b.cwd || value.ownerKey !== b.ownerKey
      || !validMode(value.mode) || !revision(value.revision) || value.revision === null
      || !safe(value.requestId, 128) || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))) fail('access-mode-unavailable');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof ResearchAccessModeError) throw error; fail('access-mode-unavailable'); }
}
const project = (record, cwd) => ({ cwd, mode: record?.mode ?? 'default', revision: record?.revision ?? null, updatedAt: record?.updatedAt ?? null, inheritance: 'workspace-sessions' });

export function readResearchAccessMode(input) {
  const b = binding(input);
  return project(readRecord(recordFile(input, b), b), b.cwd);
}

function withLock(file, action) {
  const lock = file + '.lock'; let fd;
  try { fd = fs.openSync(lock, 'wx', 0o600); }
  catch (error) {
    // Never unlink another writer's lock based on a stale PID observation: two
    // reclaimers could remove a newly acquired lock and defeat revision CAS.
    // An interrupted save leaves a visible busy error until the host clears its
    // abandoned lock; reading the last saved mode is unaffected.
    if (error.code === 'EEXIST') fail('access-mode-busy');
    throw error;
  }
  try {
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    return action();
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

/** Only the admitted operator HTTP route writes this preference. No agent tool does. */
export function updateResearchAccessMode(input) {
  const b = binding(input);
  if (!validMode(input.mode) || !revision(input.expectedRevision) || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? '')) fail('access-mode-invalid');
  const file = recordFile(input, b, true);
  return withLock(file, () => {
    const previous = readRecord(file, b);
    if (previous?.requestId === input.requestId) {
      if (previous.mode !== input.mode) fail('access-mode-request-conflict');
      return project(previous, b.cwd);
    }
    if ((previous?.revision ?? null) !== input.expectedRevision) fail('access-mode-revision-conflict');
    const next = { schema: SCHEMA, ...b, mode: input.mode, revision: randomUUID(), updatedAt: new Date(input.now ?? Date.now()).toISOString(), requestId: input.requestId };
    const temp = `${file}.${randomUUID()}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: 'wx' }); fs.renameSync(temp, file); }
    finally { try { fs.unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return project(next, b.cwd);
  });
}

/** Native session identity, not a prompt, chooses the operator and workspace.
 * Hidden native children are eligible; research adoption and charter are unrelated.
 */
export function readResearchAccessModeContext(ctx, options = {}) {
  try {
    const cwd = fs.realpathSync(ctx?.cwd);
    const id = ctx?.sessionManager?.getSessionId?.(), file = ctx?.sessionManager?.getSessionFile?.();
    if (!safe(id, 128) || typeof file !== 'string' || !path.isAbsolute(file) || !file.endsWith('.jsonl')) return null;
    // Pi writes a new JSONL only after the first assistant message. Its native
    // read-only SessionManager already owns the header at session_start. The
    // dashboard synchronously persists a token-resolved owner before dispatching
    // the first prompt, so do not wait for a transcript to flush to read it.
    let header;
    try { header = readJson(file, MAX_BYTES, true); }
    catch (error) {
      if (error.code !== 'ENOENT') return null;
      header = ctx.sessionManager.getHeader?.();
    }
    if (!object(header)) return null;
    if (header.type !== 'session' || header.id !== id || typeof header.cwd !== 'string' || fs.realpathSync(header.cwd) !== cwd) return null;
    const meta = readJson(file.slice(0, -6) + '.meta.json', 128 * 1024);
    if (meta.id !== undefined && meta.id !== id || meta.cwd !== undefined && fs.realpathSync(meta.cwd) !== cwd || meta.originDeviceId || meta.driver && meta.driver !== 'pi') return null;
    const b = { cwd, ownerKey: researchAccessOwnerKey(meta.principalOwner), ...(options.storeDir ? { storeDir: options.storeDir } : {}) };
    try { return { profile: readResearchAccessMode(b), binding: b }; }
    catch { return { profile: null, unavailable: true }; }
  } catch { return null; }
}

export function researchAccessModeGuidance(profile) {
  if (profile?.mode !== 'full-access') return 'Pi access mode: default. Follow the normal tool permission decisions; there is no separate long-task grant or expiry to renew.';
  return [
    'Pi access mode: full access for this operator and local workspace, shared by its registered Pi main, collaboration and dispatched sessions. This persistent mode has no task approval form or expiry.',
    'Execute the user-requested work without repeat approval for ordinary local file access, commands or available network tools. Do not ask the user to reapprove this access mode or renew an old task grant.',
    'Operating-system rights, remote-account credentials and independent explicit policy restrictions still apply. Full tool access does not expand the user task, authorize unrelated actions or establish scientific validity.',
  ].join('\n');
}
