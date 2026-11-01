import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { appendEvent, charterFrom, newState, rootDir, saveState, sha256, writePrivate, ensurePrivateDir } from './ledger.mjs';

export { sha256, writePrivate, ensurePrivateDir };

function projectTree(cwd, parts, create = false) {
  if (fs.realpathSync(cwd) !== cwd) throw new Error('Unsafe noncanonical research directory');
  let current = cwd;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) return false;
      fs.mkdirSync(current, { mode: 0o700 });
    }
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink() || fs.realpathSync(current) !== current) throw new Error('Unsafe symlink research directory');
  }
  return true;
}

function regularJson(file, maxBytes = 262144) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw new Error('Unsafe research record');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || !opened.isFile() || opened.size > maxBytes) throw new Error('Research record changed');
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) { const read = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    const stamp = value => JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode]);
    if (count !== opened.size || count > maxBytes || stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || named.isSymbolicLink()) throw new Error('Research record changed');
    const raw = bytes.subarray(0, count), text = raw.toString('utf8');
    if (!Buffer.from(text).equals(raw)) throw new Error('Research record changed');
    return JSON.parse(text);
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function stateFor(cwd) {
  if (!projectTree(cwd, ['.pi', 'research-loop'])) return null;
  const file = path.join(rootDir(cwd), 'state.json');
  try {
    const state = regularJson(file);
    if (!state || typeof state !== 'object' || Array.isArray(state) || !state.charter || typeof state.charter.objective !== 'string' || !Array.isArray(state.charter.successCriteria) || !state.charter.successCriteria.length) throw new Error('Invalid charter');
    return state;
  } catch (err) { if (err.code === 'ENOENT') return null; throw new Error('Malformed or unsafe research state; refusing to overwrite'); }
}

export function charterHash(cwd) {
  return sha256(stateFor(cwd)?.charter ?? null);
}

const activeRecordLocks = new Map();

/** One synchronous lock for charter changes and scientific record read/modify/write. */
export function withScientificRecordLock(cwd, fn) {
  projectTree(cwd, ['.pi', 'research-loop'], true);
  const file = path.join(rootDir(cwd), '.charter-configure.lock');
  const active = activeRecordLocks.get(cwd);
  if (active) {
    const named = fs.lstatSync(file);
    const value = regularJson(file, 512);
    if (named.isSymbolicLink() || named.dev !== active.dev || named.ino !== active.ino || value.pid !== process.pid || value.nonce !== active.nonce) throw new Error('Research charter is busy');
    const result = fn();
    if (result && typeof result.then === 'function') throw new Error('Research record transaction must be synchronous');
    return result;
  }
  let fd, owned;
  try {
    try { fd = fs.openSync(file, 'wx', 0o600); }
    catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const before = fs.lstatSync(file);
      let lock;
      try { lock = regularJson(file, 512); } catch { throw new Error('Research charter is busy'); }
      if (lock.schema !== 'pi-research-charter-lock.v1' || !Number.isSafeInteger(lock.pid) || lock.pid < 1) throw new Error('Research charter is busy');
      let dead = false;
      try { process.kill(lock.pid, 0); } catch (probe) { dead = probe.code === 'ESRCH'; }
      if (!dead) throw new Error('Research charter is busy');
      const takeover = file + '.takeover';
      let guard;
      try { fs.mkdirSync(takeover, { mode: 0o700 }); guard = fs.lstatSync(takeover); }
      catch { throw new Error('Research charter is busy'); }
      try {
        const now = fs.lstatSync(file);
        if (before.ino !== now.ino || before.dev !== now.dev || JSON.stringify(regularJson(file, 512)) !== JSON.stringify(lock)) throw new Error('Research charter is busy');
        fs.unlinkSync(file);
        fd = fs.openSync(file, 'wx', 0o600);
      } finally {
        const current = fs.lstatSync(takeover);
        if (current.isDirectory() && !current.isSymbolicLink() && current.dev === guard.dev && current.ino === guard.ino) fs.rmdirSync(takeover);
      }
    }
    owned = fs.fstatSync(fd);
    const nonce = randomUUID();
    fs.writeFileSync(fd, JSON.stringify({ schema: 'pi-research-charter-lock.v1', pid: process.pid, nonce }));
    fs.fsyncSync(fd);
    const named = fs.lstatSync(file);
    if (!owned.isFile() || named.isSymbolicLink() || named.dev !== owned.dev || named.ino !== owned.ino) throw new Error('Research charter is busy');
    activeRecordLocks.set(cwd, { dev: owned.dev, ino: owned.ino, nonce });
    try {
      const value = fn();
      if (value && typeof value.then === 'function') throw new Error('Research record transaction must be synchronous');
      return value;
    }
    finally {
      activeRecordLocks.delete(cwd);
      try { const current = fs.lstatSync(file); if (current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(file); } catch { /* already removed */ }
    }
  } finally {
    if (fd !== undefined) {
      try { const current = fs.lstatSync(file); if (owned && current.ino === owned.ino && current.dev === owned.dev) fs.unlinkSync(file); } catch { /* another owner or already removed */ }
      fs.closeSync(fd);
    }
  }
}

/** Shared by the Pi configure action and adoption confirmation; never starts a run. */
export function configureResearch(cwd, input, options = {}) {
  return withScientificRecordLock(cwd, () => configureUnlocked(cwd, input, options));
}

function configureUnlocked(cwd, input, options) {
  const previous = stateFor(cwd);
  if (options.expectedCharterHash !== undefined && sha256(previous?.charter ?? null) !== options.expectedCharterHash) throw new Error('Research charter changed; reload before confirming');
  if (options.preserveExisting && previous) return { state: previous, configured: false };
  const charter = charterFrom(input, previous);
  const state = previous ? { ...previous, charter, updatedAt: new Date().toISOString() } : newState(charter);
  try { saveState(cwd, state, { exclusive: !previous }); }
  catch (err) { if (err.code === 'EEXIST') throw new Error('Research charter changed; reload before confirming'); throw err; }
  appendEvent(cwd, 'configure', { revision: charter.revision, ...(options.adoptionId ? { adoptionId: options.adoptionId, autoRun: false } : {}) });
  return { state, configured: !previous };
}

export function confirmationHash(input) {
  charterFrom({ objective: input.objective, successCriteria: input.successCriteria }, null);
  return sha256({ id: input.id, proposalHash: input.proposalHash, objective: input.objective, successCriteria: input.successCriteria, expectedCharterHash: input.expectedCharterHash, sourceHash: sha256(input.sources) });
}

/** A confirmed source association is not an experiment, an accepted claim or publication permission. */
export function confirmAdoption(cwd, input) {
  if (!/^adopt-[a-f0-9]{24}$/.test(input?.id ?? '')) throw new Error('Invalid adoption id');
  if (input.autoRun !== false) throw new Error('Adoption confirmation requires autoRun:false');
  if (!input.proposal || sha256(input.proposal) !== input.proposalHash) throw new Error('Adoption proposal hash mismatch');
  if (!Array.isArray(input.sources) || input.sources.length > 256 || !Array.isArray(input.proposal.items)) throw new Error('Invalid adoption sources');
  const ids = new Set(input.sources.map((source) => source.id));
  if (ids.size !== input.sources.length || input.proposal.items.some((item) => !Array.isArray(item.sourceIds) || item.sourceIds.length === 0 || item.sourceIds.some((id) => !ids.has(id)))) throw new Error('Invalid adoption source reference');
  // Validate new targets even when an existing charter will be preserved.
  charterFrom({ objective: input.objective, successCriteria: input.successCriteria }, null);
  const intentHash = confirmationHash(input);
  return withScientificRecordLock(cwd, () => {
    const parts = ['.pi', 'research-loop', 'adoptions', input.id];
    projectTree(cwd, parts, true);
    const receiptFile = path.join(cwd, ...parts, 'confirmation.json');
    if (fs.existsSync(receiptFile)) {
      const receipt = regularJson(receiptFile);
      if (receipt.confirmationHash !== intentHash || receipt.charterHash !== sha256(stateFor(cwd)?.charter ?? null)) throw new Error('Adoption confirmation conflicts with the current charter');
      return { ...receipt, configured: false };
    }
    const result = configureUnlocked(cwd, { objective: input.objective, successCriteria: input.successCriteria, autoRun: false }, { expectedCharterHash: input.expectedCharterHash, preserveExisting: true, adoptionId: input.id });
    const receipt = { schema: 'pi-research-adoption-confirmation.v1', adoptionId: input.id, proposalHash: input.proposalHash, confirmationHash: intentHash, charterHash: sha256(result.state.charter), configured: result.configured, autoRun: false, at: new Date().toISOString() };
    writePrivate(receiptFile, JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  });
}
