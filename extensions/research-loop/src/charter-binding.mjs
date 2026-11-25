import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sha256, withScientificRecordLock, writePrivate } from './adoption.mjs';

const HASH = /^sha256:[a-f0-9]{64}$/;
const ADOPTION = /^adopt-[a-f0-9]{24}$/;
const REQUEST = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_HISTORY_BYTES = 8 * 1024 * 1024;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));

export class ResearchCharterBindingError extends Error {
  constructor(code, statusCode = 409) { super(code); this.code = code; this.statusCode = statusCode; }
}
const fail = (code, status = 409) => { throw new ResearchCharterBindingError('research-charter-binding-' + code, status); };

function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file) fail('proof-unavailable');
  return file;
}

/** Private proof and scientific records must be regular, bounded, stable reads. */
function read(file, maximum = 256 * 1024) {
  canonical(file);
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) fail('proof-unavailable');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    const stamp = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink]);
    if (stamp(opened) !== stamp(before) || !opened.isFile()) fail('proof-unavailable');
    const buffer = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < buffer.length) { const size = fs.readSync(fd, buffer, count, buffer.length - count, null); if (!size) break; count += size; }
    const bytes = buffer.subarray(0, count), text = bytes.toString('utf8');
    if (count !== opened.size || !Buffer.from(text).equals(bytes) || stamp(opened) !== stamp(fs.fstatSync(fd)) || stamp(opened) !== stamp(fs.lstatSync(file)) || fs.realpathSync(file) !== file) fail('proof-unavailable');
    const value = JSON.parse(text);
    if (!object(value)) fail('proof-unavailable');
    return { value, hash: 'sha256:' + digest(bytes) };
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function bindingInput(input) {
  const cwd = canonical(input.cwd);
  let owner;
  try { owner = JSON.parse(input.ownerKey); } catch { fail('invalid-request', 400); }
  if (!Array.isArray(owner) || owner.length !== 2 || owner.some(part => typeof part !== 'string' || !part || part.length > 4096) || JSON.stringify(owner) !== input.ownerKey) fail('invalid-request', 400);
  if (typeof input.privateDir !== 'string' || !path.isAbsolute(input.privateDir) || path.resolve(input.privateDir) !== input.privateDir) fail('proof-unavailable');
  return { cwd, ownerKey: input.ownerKey, privateDir: input.privateDir, scope: path.join(input.privateDir, digest(input.ownerKey), digest(cwd)) };
}

function validCharter(value) {
  return object(value) && Number.isSafeInteger(value.revision) && value.revision >= 1 && typeof value.objective === 'string' && !!value.objective.trim() &&
    Array.isArray(value.successCriteria) && value.successCriteria.length > 0 && value.successCriteria.every(item => typeof item === 'string' && !!item.trim()) &&
    ['constraints', 'nonGoals'].every(key => value[key] === undefined || Array.isArray(value[key]) && value[key].every(item => typeof item === 'string'));
}

function requestHash(input) {
  return sha256({ adoptionId: input.adoptionId, expectedBindingRevision: input.expectedBindingRevision,
    expectedBoundCharterHash: input.expectedBoundCharterHash, expectedCharterHash: input.expectedCharterHash, requestId: input.requestId });
}

function proof(input) {
  const b = bindingInput(input);
  let pointer;
  try { pointer = read(path.join(b.scope, 'adopted.json')).value; }
  catch (error) { if (error.code === 'ENOENT') return { ...b, notAdopted: true }; throw error; }
  // Reconnect deliberately persists this exact tombstone after archiving and
  // detaching the original operation. It is a known empty state, not corrupt proof.
  if (pointer.confirmed === false && timestamp(pointer.reconnectedAt) && Object.keys(pointer).every(key => ['confirmed', 'reconnectedAt'].includes(key))) return { ...b, notAdopted: true };
  if (pointer.confirmed !== true || !ADOPTION.test(pointer.id ?? '') || !HASH.test(pointer.confirmationHash ?? '')) fail('proof-unavailable');
  canonical(b.privateDir);
  const operation = read(path.join(b.scope, pointer.id + '.json'), MAX_HISTORY_BYTES).value;
  if (operation.schema !== 'pi-res-workflow-operation.v1' || operation.ownerKey !== b.ownerKey || operation.cwd !== b.cwd || operation.adoption?.id !== pointer.id || operation.adoption.cwd !== b.cwd) fail('proof-unavailable');
  if (operation.detachedAt || operation.adoption.status !== 'confirmed') return { ...b, notAdopted: true };
  const original = read(path.join(b.cwd, '.pi', 'research-loop', 'adoptions', pointer.id, 'confirmation.json'));
  const receipt = original.value;
  if (receipt.schema !== 'pi-research-adoption-confirmation.v1' || receipt.adoptionId !== pointer.id || receipt.confirmationHash !== pointer.confirmationHash || !HASH.test(receipt.charterHash ?? '') || receipt.autoRun !== false ||
    operation.confirmationIntent && operation.confirmationIntent.hash !== receipt.confirmationHash ||
    operation.adoption.proposalHash && operation.adoption.proposalHash !== receipt.proposalHash) fail('proof-unavailable');
  const state = read(path.join(b.cwd, '.pi', 'research-loop', 'state.json')).value;
  if (!validCharter(state.charter)) fail('proof-unavailable');
  const historyFile = path.join(b.scope, pointer.id + '.charter-bindings.json');
  const root = { schema: 'pi-research-charter-bindings.v1', ownerKey: b.ownerKey, cwd: b.cwd, adoptionId: pointer.id,
    confirmationHash: receipt.confirmationHash, confirmationReceiptHash: original.hash, initialCharterHash: receipt.charterHash };
  let history;
  try { history = read(historyFile, MAX_HISTORY_BYTES).value; }
  catch (error) { if (error.code !== 'ENOENT') throw error; history = { ...root, entries: [] }; }
  if (Object.entries(root).some(([key, value]) => history[key] !== value) || !Array.isArray(history.entries) || history.entries.length > 512) fail('proof-unavailable');
  let hash = receipt.charterHash, revision = null, previousEntryHash = sha256(root);
  const requests = new Set();
  for (const [index, entry] of history.entries.entries()) {
    if (!object(entry)) fail('proof-unavailable');
    const { entryHash, ...signed } = entry;
    if (entry.bindingRevision !== index + 1 || entry.fromCharterHash !== hash || entry.fromCharterRevision !== revision || !validCharter(entry.toCharter) ||
      entry.toCharterHash !== sha256(entry.toCharter) || entry.toCharterHash === hash || revision !== null && entry.toCharter.revision <= revision ||
      entry.previousEntryHash !== previousEntryHash || sha256(signed) !== entryHash || !timestamp(entry.at) || !REQUEST.test(entry.requestId ?? '') || requests.has(entry.requestId) ||
      entry.requestHash !== requestHash({ adoptionId: pointer.id, expectedBindingRevision: index, expectedBoundCharterHash: hash, expectedCharterHash: entry.toCharterHash, requestId: entry.requestId })) fail('proof-unavailable');
    requests.add(entry.requestId); hash = entry.toCharterHash; revision = entry.toCharter.revision; previousEntryHash = entryHash;
  }
  return { ...b, pointer, receipt, state, history, historyFile, boundHash: hash, boundRevision: revision, previousEntryHash };
}

function projection(value) {
  const empty = { schema: 'pi-research-charter-binding.v1', cwd: value.cwd, adopted: false, adoptionId: null,
    status: 'not-adopted', bindingRevision: 0, boundCharterHash: null, boundCharterRevision: null,
    currentCharterHash: null, currentCharterRevision: null, currentObjective: null, canRebind: false, updatedAt: null };
  if (value.notAdopted) return empty;
  const currentHash = sha256(value.state.charter), stale = value.boundHash !== currentHash;
  return { ...empty, adopted: true, adoptionId: value.pointer.id, status: stale ? 'stale' : 'current', bindingRevision: value.history.entries.length,
    boundCharterHash: value.boundHash, boundCharterRevision: value.boundRevision, currentCharterHash: currentHash,
    currentCharterRevision: value.state.charter.revision, currentObjective: value.state.charter.objective, currentCharter: value.state.charter,
    canRebind: stale, updatedAt: value.history.entries.at(-1)?.at ?? (timestamp(value.receipt.at) ? value.receipt.at : null) };
}

/** The HTTP service and native session verifier consume this same proof chain. */
export function readResearchCharterBinding(input) {
  try { return projection(proof(input)); }
  catch {
    return { ...projection({ cwd: input.cwd, notAdopted: true }), status: 'unavailable', error: 'research-charter-binding-proof-unavailable' };
  }
}

/** Authenticated operator action only. This does not reassign existing tasks or run work. */
export function updateResearchCharterBinding(input) {
  if (input?.write !== true) fail('write-required', 403);
  if (!ADOPTION.test(input.adoptionId ?? '') || !REQUEST.test(input.requestId ?? '') || !Number.isSafeInteger(input.expectedBindingRevision) || input.expectedBindingRevision < 0 || !HASH.test(input.expectedBoundCharterHash ?? '') || !HASH.test(input.expectedCharterHash ?? '')) fail('invalid-request', 400);
  const b = bindingInput(input);
  try {
    return withScientificRecordLock(b.cwd, () => {
      const value = proof(input);
      if (value.notAdopted) fail('not-confirmed');
      const current = projection(value);
      if (current.adoptionId !== input.adoptionId || current.currentCharterHash !== input.expectedCharterHash) fail('conflict');
      const replay = value.history.entries.find(entry => entry.requestId === input.requestId);
      if (replay) {
        if (replay.requestHash !== requestHash(input) || replay.bindingRevision !== current.bindingRevision || current.status !== 'current') fail('conflict');
        return current;
      }
      if (current.bindingRevision !== input.expectedBindingRevision || current.boundCharterHash !== input.expectedBoundCharterHash || current.status !== 'stale') fail('conflict');
      // A restored backup can expose an older or same-number target. Reject it
      // before writing: every continuation must remain a valid increasing chain.
      if (value.boundRevision !== null && current.currentCharterRevision <= value.boundRevision) fail('conflict');
      if (value.history.entries.length >= 512) fail('history-limit');
      const entry = { bindingRevision: current.bindingRevision + 1, requestId: input.requestId, requestHash: requestHash(input),
        fromCharterHash: value.boundHash, fromCharterRevision: value.boundRevision, toCharterHash: current.currentCharterHash,
        toCharter: value.state.charter, previousEntryHash: value.previousEntryHash, at: new Date().toISOString() };
      const history = { ...value.history, entries: [...value.history.entries, { ...entry, entryHash: sha256(entry) }] };
      const text = JSON.stringify(history, null, 2) + '\n';
      if (Buffer.byteLength(text) > MAX_HISTORY_BYTES) fail('history-limit');
      // Existing proof parents were checked by the read above; a symlink is never
      // used as a binding destination. Atomic replacement preserves every entry.
      canonical(path.dirname(value.historyFile));
      try { read(value.historyFile, MAX_HISTORY_BYTES); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      writePrivate(value.historyFile, text);
      const fd = fs.openSync(value.historyFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      const parent = fs.openSync(path.dirname(value.historyFile), 'r');
      try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      return projection(proof(input));
    });
  } catch (error) {
    if (error instanceof ResearchCharterBindingError) throw error;
    if (error?.message === 'Research charter is busy') fail('conflict');
    fail('proof-unavailable');
  }
}
