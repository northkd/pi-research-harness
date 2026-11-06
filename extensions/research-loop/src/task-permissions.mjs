import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { charterHash as currentCharterHash, withScientificRecordLock } from './adoption.mjs';

export const TASK_PERMISSION_HOURS = Object.freeze([12, 24, 48, 72]);
const SCHEMA = 'pi-research-task-permissions.v1';
const MAX_BYTES = 64 * 1024;
const CAPABILITIES = ['localExecution', 'delegation', 'publicResearch', 'projectDependencies'];
const hash = value => createHash('sha256').update(value).digest('hex');
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = code => { throw new TaskPermissionError(code); };
const safeString = (v, n) => typeof v === 'string' && v.length > 0 && v.length <= n && !/[\u0000-\u001f\u007f]/u.test(v);
export class TaskPermissionError extends Error {
  constructor(code) { super(code); this.name = 'TaskPermissionError'; this.code = code; }
}
/** Host-private, task-specific authorization records. Never a global Pi setting. */
export const taskPermissionStoreDir = () => path.join(os.homedir(), '.pi', 'dashboard', 'research-task-permissions');

function binding(input) {
  if (!safeString(input?.cwd, 4096) || !path.isAbsolute(input.cwd) || !/^sha256:[a-f0-9]{64}$/.test(input.charterHash ?? '')) fail('task-permissions-invalid');
  if (fs.realpathSync(input.cwd) !== input.cwd || currentCharterHash(input.cwd) !== input.charterHash || input.charterHash === `sha256:${hash('null')}`) fail('task-permissions-scope-mismatch');
  return { cwd: input.cwd, charterHash: input.charterHash };
}
function safeDirectory(dir, create) {
  const absolute = path.resolve(dir); let cursor = path.parse(absolute).root;
  for (const part of absolute.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { const stat = fs.lstatSync(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) fail('task-permissions-unavailable'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) return null; fs.mkdirSync(cursor, { mode: 0o700 }); }
  }
  if (fs.realpathSync(absolute) !== absolute) fail('task-permissions-unavailable');
  return absolute;
}
function fileFor(input, create = false) {
  const root = safeDirectory(input.storeDir ?? taskPermissionStoreDir(), create);
  return root ? path.join(root, `${hash(input.cwd)}.json`) : null;
}
function readRecord(input) {
  const file = fileFor(input); if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const before = fs.fstatSync(fd), named = fs.lstatSync(file);
    if (!before.isFile() || named.isSymbolicLink() || before.nlink !== 1 || before.size > MAX_BYTES || named.ino !== before.ino || named.dev !== before.dev) fail('task-permissions-unavailable');
    const bytes = Buffer.alloc(before.size + 1), read = fs.readSync(fd, bytes, 0, bytes.length, 0), after = fs.fstatSync(fd);
    if (read !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) fail('task-permissions-unavailable');
    const value = JSON.parse(bytes.subarray(0, read).toString('utf8'));
    if (!validRecord(value) || value.cwd !== input.cwd) fail('task-permissions-unavailable');
    if (input.ownerKey !== undefined && value.ownerKey !== input.ownerKey) fail('task-permissions-owner-mismatch');
    return value;
  } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof TaskPermissionError) throw error; fail('task-permissions-unavailable'); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function validCapabilities(caps) { return object(caps) && Object.keys(caps).length === CAPABILITIES.length && CAPABILITIES.every(k => typeof caps[k] === 'boolean'); }
function validRecord(value) {
  return object(value) && value.schema === SCHEMA && safeString(value.ownerKey, 2048) && safeString(value.cwd, 4096)
    && /^sha256:[a-f0-9]{64}$/.test(value.charterHash) && /^[a-f0-9-]{36}$/.test(value.revision)
    && typeof value.enabled === 'boolean' && typeof value.task === 'string' && value.task.length <= 4000
    && validCapabilities(value.capabilities) && Array.isArray(value.additionalRoots) && value.additionalRoots.length <= 16 && value.additionalRoots.every(p => safeString(p, 4096))
    && Number.isSafeInteger(value.authorizedAt) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.authorizedAt
    && TASK_PERMISSION_HOURS.includes(value.durationHours) && Array.isArray(value.blockers) && value.blockers.length <= 20 && value.blockers.every(b => object(b) && /^[a-z][a-z0-9-]{0,79}$/.test(b.code) && /^[A-Za-z0-9_.:-]{1,80}$/.test(b.tool) && (b.target === undefined || safeString(b.target, 4096)) && typeof b.at === 'string' && Number.isFinite(Date.parse(b.at)) && Number.isSafeInteger(b.hits) && b.hits > 0 && b.hits <= 1000000);
}
function status(record, b, now) {
  if (!record) return 'unconfigured';
  if (record.charterHash !== b.charterHash) return 'scope-changed';
  if (!record.enabled) return 'revoked';
  if (record.expiresAt <= now) return 'expired';
  return 'active';
}
function project(record, b, now) {
  return {
    cwd: b.cwd, charterHash: b.charterHash, revision: record?.revision ?? null, status: status(record, b, now),
    task: record?.task ?? '', capabilities: record?.capabilities ?? { localExecution: true, delegation: true, publicResearch: true, projectDependencies: false },
    additionalRoots: record?.additionalRoots ?? [], durationHours: record?.durationHours ?? 24,
    authorizedAt: record ? new Date(record.authorizedAt).toISOString() : null, expiresAt: record ? new Date(record.expiresAt).toISOString() : null,
    inheritance: 'joined-workbench-descendants', blockers: record?.blockers ?? [],
  };
}
export function readTaskPermissions(input) {
  try { const b = binding(input); return project(readRecord(input), b, input.now ?? Date.now()); }
  catch (error) { if (error instanceof TaskPermissionError) throw error; fail('task-permissions-unavailable'); }
}
export function safeTaskPermissionRoot(raw, input = {}) {
  if (!safeString(raw, 4096) || !path.isAbsolute(raw)) fail('task-permissions-invalid-root');
  const real = fs.realpathSync(raw); if (!fs.statSync(real).isDirectory()) fail('task-permissions-invalid-root');
  const home = input.home ?? os.homedir();
  const forbidden = [path.parse(real).root, home, '/etc', '/usr', '/var', '/bin', '/sbin', '/proc', '/sys', '/dev', '/root', '/home', '/tmp', '/private', '/opt'];
  const controlRoots = [path.join(home, '.pi'), path.join(home, '.ssh'), path.join(home, '.aws'), path.join(home, '.config'), input.storeDir ?? taskPermissionStoreDir()];
  if (forbidden.includes(real) || ['/etc', '/usr', '/bin', '/sbin', '/proc', '/sys', '/dev'].some(root => within(real, root)) || controlRoots.some(root => within(real, root) || within(root, real))) fail('task-permissions-invalid-root');
  return real;
}
function writeRecord(input, record) {
  const serialized = JSON.stringify(record);
  if (Buffer.byteLength(serialized) > MAX_BYTES) fail('task-permissions-invalid-record-size');
  const file = fileFor(input, true), tmp = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(tmp, serialized, { mode: 0o600, flag: 'wx' }); fs.renameSync(tmp, file); }
  finally { try { fs.unlinkSync(tmp); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
}
/** Called only by the admitted operator route; agents have no grant-writing tool. */
export function updateTaskPermissions(input) {
  const b = binding(input);
  if (!safeString(input.ownerKey, 2048) || input.confirmed !== true || !['authorize', 'revoke'].includes(input.action)
    || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId ?? '') || !(input.expectedRevision === null || /^[a-f0-9-]{36}$/.test(input.expectedRevision ?? ''))) fail('task-permissions-invalid');
  const now = input.now ?? Date.now();
  return withScientificRecordLock(b.cwd, () => {
    const previous = readRecord(input);
    const fingerprint = hash(JSON.stringify([input.action, input.task, input.durationHours, input.capabilities, input.additionalRoots, b.charterHash]));
    if (previous?.requestId === input.requestId) {
      if (previous.fingerprint !== fingerprint) fail('task-permissions-request-conflict');
      return project(previous, b, now);
    }
    if ((previous?.revision ?? null) !== input.expectedRevision) fail('task-permissions-revision-conflict');
    if (input.action === 'revoke') {
      if (!previous) return project(null, b, now);
      const next = { ...previous, enabled: false, revision: randomUUID(), requestId: input.requestId, fingerprint };
      writeRecord(input, next); return project(next, b, now);
    }
    if (typeof input.task !== 'string' || !input.task.trim() || input.task.length > 4000 || !TASK_PERMISSION_HOURS.includes(input.durationHours) || !validCapabilities(input.capabilities)
      || !Array.isArray(input.additionalRoots) || input.additionalRoots.length > 16) fail('task-permissions-invalid');
    const additionalRoots = [...new Set(input.additionalRoots.map(root => safeTaskPermissionRoot(root, input)))];
    const next = { schema: SCHEMA, ...b, ownerKey: input.ownerKey, enabled: true, task: input.task.trim(), capabilities: { ...input.capabilities }, additionalRoots,
      revision: randomUUID(), requestId: input.requestId, fingerprint, authorizedAt: now, expiresAt: now + input.durationHours * 3600000, durationHours: input.durationHours, blockers: [] };
    // Reserve room for later diagnostics and revocation metadata before saving a grant.
    if (Buffer.byteLength(JSON.stringify(next)) > MAX_BYTES - 4096) fail('task-permissions-invalid-record-size');
    if (currentCharterHash(b.cwd) !== b.charterHash) fail('task-permissions-scope-mismatch');
    writeRecord(input, next); return project(next, b, now);
  });
}
function within(target, root) { const relative = path.relative(root, target); return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); }
export function resolveTaskPermissionPath(target, depth = 0) {
  if (typeof target !== 'string' || !path.isAbsolute(target) || target.includes('\0') || depth > 40) return null;
  let ancestor = path.resolve(target), suffix = [];
  while (true) {
    try { return path.join(fs.realpathSync(ancestor), ...suffix); }
    catch (error) {
      if (error.code !== 'ENOENT') return null;
      // A dangling link still redirects a future write. Never discard its target.
      try {
        if (fs.lstatSync(ancestor).isSymbolicLink()) return resolveTaskPermissionPath(path.resolve(path.dirname(ancestor), fs.readlinkSync(ancestor), ...suffix), depth + 1);
      } catch (statError) { if (statError.code !== 'ENOENT') return null; }
      const parent = path.dirname(ancestor); if (parent === ancestor) return null;
      suffix.unshift(path.basename(ancestor)); ancestor = parent;
    }
  }
}
export function taskPermissionPathDecision(profile, target, access = 'w') {
  if (profile?.status !== 'active') return null;
  if (access === 'w' && !profile.capabilities.localExecution) return 'out-of-scope';
  const real = resolveTaskPermissionPath(target); if (!real) return 'out-of-scope';
  return [profile.cwd, ...profile.additionalRoots].some(root => within(real, root)) ? 'allow' : 'out-of-scope';
}
/** Classifies only soft supervisor holds. Hard policy denies/resource/budget gates remain authoritative. */
export function taskPermissionAllowsOperation(profile, event, depth = 0) {
  if (profile?.status !== 'active' || depth > 4) return false;
  const name = event?.toolName ?? event?.name ?? '', input = event?.input ?? {};
  if (name === 'parallel' || name === 'multi_tool_use.parallel') return depth < 4 && Array.isArray(input.tool_uses) && input.tool_uses.length > 0 && input.tool_uses.length <= 64
    && input.tool_uses.every(t => typeof t?.recipient_name === 'string' && object(t.parameters) && taskPermissionAllowsOperation(profile, { toolName: t.recipient_name.split('.').at(-1), input: t.parameters }, depth + 1));
  if (name === 'research_dispatch') return input.action === 'plan' ? profile.capabilities.delegation : ['status', 'report', 'atomic', 'cancel'].includes(input.action);
  if (name === 'research_session' || name === 'subagent' || /^(bg_delegate|bg_run_pi)$/.test(name)) return profile.capabilities.delegation;
  if (/^(web_search|fetch_content|source_check)$/.test(name)) return profile.capabilities.publicResearch;
  if (name === 'write' || name === 'edit') return profile.capabilities.localExecution && taskPermissionPathDecision(profile, path.resolve(profile.cwd, input.path ?? '')) === 'allow';
  if (!['bash', 'bg_run', 'ctx_execute', 'ctx_batch_execute'].includes(name) || !profile.capabilities.localExecution) return false;
  const command = String(input.command ?? input.code ?? '');
  // These scopes require an independent concrete authorization, never inferred from unattended execution.
  if (/\b(?:sudo|doas|su|ssh|scp|rsync|sftp|mkfs|shutdown|reboot|kubectl|terraform)\b|\bgit\s+(?:push|reset\s+--hard|clean)\b|\b(?:npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgh\s+(?:pr|release|issue)\s+(?:create|merge|comment)\b/.test(command)) return false;
  if (/\b(?:pip3?|uv|npm|pnpm|yarn|conda)\s+(?:install|add|sync|create)\b/.test(command)) {
    if (!profile.capabilities.projectDependencies || /(?:^|\s)(?:--global|-g|--user)(?:\s|$)/.test(command)) return false;
  }
  return true;
}
export function taskPermissionGuidance(profile) {
  if (profile?.status !== 'active') return `Task preauthorization: ${profile?.status ?? 'unconfigured'}. Use existing direct user authorization; do not assume extra access.`;
  return [
    `The user authorized this research task until ${profile.expiresAt}: ${profile.task}`,
    `Inherited capabilities: ${JSON.stringify(profile.capabilities)}. Approved workspace: ${profile.cwd}. Additional file-access roots (writes require localExecution): ${JSON.stringify(profile.additionalRoots)}.`,
    'Use only the listed capabilities without repeatedly requesting approvals already granted. When localExecution is true, start/resume task-local computation within existing budgets. When delegation is true, distribute the authorized work. Install project-scoped dependencies only when both localExecution and projectDependencies are true.',
    'This task grant does not raise resource/model budgets, authorize publication or messages, bypass OS/provider credentials, change the research charter, or authorize destructive remote operations. If a required capability is unavailable, record the precise blocker and continue independent work; do not wait silently for an operator.',
  ].join('\n');
}

/** Bounded observations do not expand the grant, renew expiry, or change its CAS revision. */
export function recordTaskPermissionBlock(input) {
  const b = binding(input);
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(input.code ?? '') || !/^[A-Za-z0-9_.:-]{1,80}$/.test(input.tool ?? '')) return;
  withScientificRecordLock(b.cwd, () => {
    const record = readRecord(input); if (!record || record.charterHash !== b.charterHash) return;
    const target = typeof input.target === 'string' ? input.target.replace(/[\u0000-\u001f\u007f]/g, '?').slice(0, 512) : undefined;
    const previous = record.blockers.find(item => item.code === input.code && item.tool === input.tool && item.target === target);
    const blocker = { code: input.code, tool: input.tool, ...(target ? { target } : {}), at: new Date(input.now ?? Date.now()).toISOString(), hits: Math.min(1000000, (previous?.hits ?? 0) + 1) };
    record.blockers = [blocker, ...record.blockers.filter(item => item !== previous)].slice(0, 20);
    // Diagnostics can never make a previously valid grant unreadable or impossible to revoke.
    while (record.blockers.length && Buffer.byteLength(JSON.stringify(record)) > MAX_BYTES) record.blockers.pop();
    writeRecord(input, record);
  });
}
