// Project-local persistence for the human auto-approve toggle.
// This stores one boolean and never reads project content, transcripts or credentials.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const AUTO_APPROVE_SCHEMA = 'pi-mainline-auto-approve.v1';
const MAX_STATE_BYTES = 1024;

export function autoApproveExplicitlyDisabled(env = {}, options = {}) {
  return env.PI_RESEARCH_AUTO_APPROVE_SUPERVISION === '0' ||
    env.PI_RESEARCH_AUTO_APPROVE_SUPERVISION === 'false' || options.autoApprove === false;
}

export function autoApproveDefault(env = {}, options = {}) {
  return !autoApproveExplicitlyDisabled(env, options);
}

export function autoApproveStatePath(cwd) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return undefined;
  return path.join(cwd, '.pi', 'mainline-supervision', 'auto-approve.json');
}

// Reject symlinked or non-directory ancestors. A missing tail is allowed so the
// ordinary project state directory can be created by the writer.
function assertSafeStateDirectory(dir) {
  const absolute = path.resolve(dir);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Unsafe auto-approve state directory');
    if (!stat.isDirectory()) throw new Error('Auto-approve state parent is not a directory');
  }
}

export function readAutoApproveState(cwd) {
  const file = autoApproveStatePath(cwd);
  if (!file) return { status: 'no-project' };
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    return error?.code === 'ENOENT' ? { status: 'absent' } : { status: 'invalid', error: 'Auto-approve state is unreadable' };
  }
  if (stat.isSymbolicLink()) return { status: 'unsafe', error: 'Auto-approve state path is a symlink' };
  if (!stat.isFile()) return { status: 'invalid', error: 'Auto-approve state is not a regular file' };
  if (stat.size > MAX_STATE_BYTES) return { status: 'invalid', error: 'Auto-approve state is too large' };
  try { assertSafeStateDirectory(path.dirname(file)); }
  catch (error) { return { status: 'unsafe', error: String(error?.message ?? error) }; }
  let saved;
  try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return { status: 'invalid', error: 'Auto-approve state is malformed' }; }
  if (!saved || typeof saved !== 'object' || Array.isArray(saved) ||
      Object.keys(saved).sort().join(',') !== 'autoApprove,schema' ||
      saved.schema !== AUTO_APPROVE_SCHEMA || typeof saved.autoApprove !== 'boolean')
    return { status: 'invalid', error: 'Auto-approve state schema is invalid' };
  return { status: 'restored', autoApprove: saved.autoApprove };
}

// Atomic per-project write with an observable failure result.
export function writeAutoApproveState(cwd, autoApprove) {
  if (typeof autoApprove !== 'boolean') return { persisted: false, error: 'Auto-approve value must be boolean' };
  const file = autoApproveStatePath(cwd);
  if (!file) return { persisted: false, error: 'No absolute project directory' };
  let temp;
  try {
    const dir = path.dirname(file);
    assertSafeStateDirectory(dir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    assertSafeStateDirectory(dir);
    let existing;
    try { existing = fs.lstatSync(file); }
    catch (error) { if (error?.code !== 'ENOENT') throw error; }
    if (existing && (existing.isSymbolicLink() || !existing.isFile()))
      throw new Error('Existing auto-approve state is not a regular file');
    temp = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ schema: AUTO_APPROVE_SCHEMA, autoApprove }), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
    temp = undefined;
    return { persisted: true };
  } catch (error) {
    return { persisted: false, error: String(error?.message ?? error).slice(0, 300) };
  } finally {
    if (temp) { try { fs.rmSync(temp, { force: true }); } catch { /* best-effort temp cleanup */ } }
  }
}
