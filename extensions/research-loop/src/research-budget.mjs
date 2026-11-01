import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { charterHash as currentCharterHash } from './adoption.mjs';

export class ResearchBudgetError extends Error {
  constructor(code, statusCode = code === 'research-budget-invalid' ? 400 : 409) { super(code); this.name = 'ResearchBudgetError'; this.code = code; this.statusCode = statusCode; }
}
const fail = code => { throw new ResearchBudgetError(code); };
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const plain = value => !!value && typeof value === 'object' && !Array.isArray(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const requestId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(value);
const safeInt = value => Number.isSafeInteger(value) && value >= 0;
const stamp = stat => JSON.stringify([stat.dev, stat.ino, stat.mode, stat.uid, stat.nlink, stat.size, stat.mtimeMs, stat.ctimeMs]);
const slotName = n => String(n).padStart(12, '0');
const FILE_FLAGS = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
const DIR_FLAGS = fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW;
const CODE_INVALID = 'research-budget-invalid', CODE_SCOPE = 'research-budget-scope-mismatch', CODE_UNAVAILABLE = 'research-budget-unavailable';

function binding(options) {
  if (!options || typeof options.cwd !== 'string' || !path.isAbsolute(options.cwd) || path.resolve(options.cwd) !== options.cwd || typeof options.charterHash !== 'string' || options.charterHash.length > 128) fail(CODE_INVALID);
  let canonical, actual;
  try { canonical = fs.realpathSync(options.cwd); actual = currentCharterHash(options.cwd); } catch { fail(CODE_UNAVAILABLE); }
  if (canonical !== options.cwd || actual !== options.charterHash || actual === `sha256:${hash('null')}`) fail(CODE_SCOPE);
  return { cwd: options.cwd, charterHash: options.charterHash };
}
function anchor(cwd, parts, create = false) {
  const chain = []; let target = cwd;
  const close = () => { for (const item of chain.reverse()) fs.closeSync(item.fd); };
  try {
    let fd = fs.openSync(cwd, DIR_FLAGS), info = fs.fstatSync(fd); chain.push({ name: cwd, fd, dev: info.dev, ino: info.ino });
    for (const part of parts) {
      const parent = chain.at(-1), named = path.join(target, part), leaf = process.platform === 'linux' ? `/proc/self/fd/${parent.fd}/${part}` : named;
      try { fd = fs.openSync(leaf, DIR_FLAGS); }
      catch (error) { if (error.code !== 'ENOENT') throw error; if (!create) { close(); return null; } fs.mkdirSync(leaf, { mode: 0o700 }); fd = fs.openSync(leaf, DIR_FLAGS); }
      target = named; info = fs.fstatSync(fd); chain.push({ name: target, fd, dev: info.dev, ino: info.ino });
    }
    const check = () => {
      for (const item of chain) { const named = fs.lstatSync(item.name), opened = fs.fstatSync(item.fd); if (!named.isDirectory() || named.isSymbolicLink() || !opened.isDirectory() || named.dev !== item.dev || named.ino !== item.ino || opened.dev !== item.dev || opened.ino !== item.ino) fail(CODE_UNAVAILABLE); }
      const last = chain.at(-1), named = fs.lstatSync(last.name), opened = fs.fstatSync(last.fd);
      if (parts.length >= 3 && (opened.uid !== process.getuid?.() || named.uid !== opened.uid || (opened.mode & 0o777) !== 0o700 || (named.mode & 0o777) !== 0o700) || fs.realpathSync(target) !== target) fail(CODE_UNAVAILABLE);
    };
    check(); return { target, fd: chain.at(-1).fd, check, close, leaf: name => { if (!/^[A-Za-z0-9_.-]{1,180}$/.test(name)) fail(CODE_INVALID); return process.platform === 'linux' ? `/proc/self/fd/${chain.at(-1).fd}/${name}` : path.join(target, name); } };
  } catch (error) { close(); if (error instanceof ResearchBudgetError) throw error; fail(CODE_UNAVAILABLE); }
}
const rootParts = ['.pi', 'research-loop', 'research-budget'];
function regular(stat) { if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) fail(CODE_UNAVAILABLE); }
function readText(a, name, maxBytes = 16384) {
  let fd;
  try {
    a.check(); fd = fs.openSync(a.leaf(name), fs.constants.O_RDONLY | FILE_FLAGS); const before = fs.fstatSync(fd); regular(before); if (before.size > maxBytes) fail(CODE_UNAVAILABLE);
    const text = fs.readFileSync(fd, 'utf8'), after = fs.fstatSync(fd), named = fs.lstatSync(path.join(a.target, name)); a.check(); regular(after); regular(named);
    if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || Buffer.from(text).toString('utf8') !== text) fail(CODE_UNAVAILABLE); return text;
  } catch (error) { if (error.code === 'ENOENT') return null; if (error instanceof ResearchBudgetError) throw error; fail(CODE_UNAVAILABLE); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function readRecord(a, name, b) {
  const text = readText(a, name); if (text === null) return null;
  let record; try { record = JSON.parse(text); } catch { fail(CODE_UNAVAILABLE); }
  if (!plain(record) || record.cwd !== b.cwd || record.charterHash !== b.charterHash) fail(CODE_SCOPE); return record;
}
function writePrivateText(a, name, text) {
  const pending = `pending-${randomUUID()}.json`; let fd;
  try {
    a.check(); fd = fs.openSync(a.leaf(pending), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | FILE_FLAGS, 0o600); const first = fs.fstatSync(fd);
    const check = currentName => { a.check(); const opened = fs.fstatSync(fd), named = fs.lstatSync(path.join(a.target, currentName)); regular(opened); regular(named); if (opened.dev !== first.dev || opened.ino !== first.ino || stamp(opened) !== stamp(named)) fail(CODE_UNAVAILABLE); };
    check(pending); fs.writeFileSync(fd, text); fs.fsyncSync(fd); check(pending);
    fs.linkSync(a.leaf(pending), a.leaf(name)); fs.unlinkSync(a.leaf(pending)); check(name); fs.fsyncSync(a.fd); check(name);
  } catch (error) { if (error instanceof ResearchBudgetError) throw error; fail(CODE_UNAVAILABLE); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function writeRecord(a, name, value) { return writePrivateText(a, name, JSON.stringify(value) + '\n'); }
function fixedErrors(action) { try { return action(); } catch (error) { if (error instanceof ResearchBudgetError) throw error; fail(CODE_UNAVAILABLE); } }
function withLock(b, action) {
  const a = anchor(b.cwd, rootParts, true); let fd, owned;
  const lockName = 'writer.lock';
  try {
    try { fd = fs.openSync(a.leaf(lockName), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | FILE_FLAGS, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const before = fs.lstatSync(path.join(a.target, lockName)), text = readText(a, lockName, 1024); let old;
      try { old = JSON.parse(text); } catch { fail(CODE_UNAVAILABLE); }
      if (!Number.isSafeInteger(old?.pid) || old.pid < 1 || typeof old.token !== 'string') fail(CODE_UNAVAILABLE);
      try { process.kill(old.pid, 0); fail(CODE_UNAVAILABLE); } catch (probe) { if (probe.code !== 'ESRCH') fail(CODE_UNAVAILABLE); }
      try { fs.mkdirSync(a.leaf('takeover.lock'), { mode: 0o700 }); } catch { fail(CODE_UNAVAILABLE); }
      try { const now = fs.lstatSync(path.join(a.target, lockName)); if (now.dev !== before.dev || now.ino !== before.ino || readText(a, lockName, 1024) !== text) fail(CODE_UNAVAILABLE); fs.unlinkSync(a.leaf(lockName)); fd = fs.openSync(a.leaf(lockName), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | FILE_FLAGS, 0o600); }
      finally { fs.rmdirSync(a.leaf('takeover.lock')); }
    }
    owned = fs.fstatSync(fd); regular(owned); a.check(); const named = fs.lstatSync(path.join(a.target, lockName)); if (named.dev !== owned.dev || named.ino !== owned.ino) fail(CODE_UNAVAILABLE);
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token: randomUUID() })); fs.fsyncSync(fd); fs.fsyncSync(a.fd); a.check();
    return action(a);
  } catch (error) { if (error instanceof ResearchBudgetError) throw error; fail(CODE_UNAVAILABLE); }
  finally { fixedErrors(() => { try { if (fd !== undefined) { try { const named = fs.lstatSync(path.join(a.target, lockName)); if (owned && named.dev === owned.dev && named.ino === owned.ino) { fs.unlinkSync(a.leaf(lockName)); fs.fsyncSync(a.fd); } } finally { fs.closeSync(fd); } } } finally { a.close(); } }); }
}
function safeMetadata(value) {
  if (value === undefined) return undefined;
  if (!plain(value) || Object.keys(value).some(k => !['phase', 'role', 'model'].includes(k))) fail(CODE_INVALID);
  const output = {};
  for (const key of ['phase', 'role']) if (value[key] !== undefined) { if (!token(value[key])) fail(CODE_INVALID); output[key] = value[key]; }
  if (value.model !== undefined) { const m = value.model; if (!plain(m) || Object.keys(m).sort().join(',') !== 'id,provider' || ![m.provider, m.id].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x20]/.test(v))) fail(CODE_INVALID); output.model = { provider: m.provider, id: m.id }; }
  return output;
}
function safeUsage(value) {
  if (value === undefined) return undefined;
  const keys = ['input', 'output', 'totalTokens', 'inputTokens', 'outputTokens', 'cacheRead', 'cacheWrite', 'reasoning'];
  if (!plain(value) || Object.entries(value).some(([k, v]) => !keys.includes(k) || !safeInt(v))) fail(CODE_INVALID); return Object.fromEntries(keys.filter(k => value[k] !== undefined).map(k => [k, value[k]]));
}
function scientificAttempts(cwd) {
  const a = anchor(cwd, ['.pi', 'research-loop']); if (!a) return 0;
  try {
    // Identical JSONL entry semantics to readLedger().length, through a verified descriptor.
    const text = readText(a, 'ledger.jsonl', Number.MAX_SAFE_INTEGER); if (text === null) return 0;
    let count = 0; for (const line of text.split('\n').filter(Boolean)) { JSON.parse(line); count++; }
    if (!safeInt(count)) fail(CODE_UNAVAILABLE); return count;
  } catch (error) { if (error instanceof ResearchBudgetError) throw error; fail(CODE_UNAVAILABLE); } finally { a.close(); }
}
function scopeDescriptor(b, scopeId, parentSessionId, requireAttested = false) {
  if (!token(scopeId) || parentSessionId !== undefined && !token(parentSessionId)) fail(CODE_INVALID);
  const a = anchor(b.cwd, [...rootParts, 'scopes', hash(scopeId)]); if (!a) fail(CODE_SCOPE);
  try {
    const record = readRecord(a, 'scope.json', b);
    if (!record || record.schema !== 'pi-research-budget-scope.v1' || record.scopeId !== scopeId || !token(record.parentSessionId) || parentSessionId !== undefined && parentSessionId !== record.parentSessionId || typeof record.createdAt !== 'string') fail(CODE_SCOPE);
    const attestation = readRecord(a, 'attestation.json', b);
    let attested = false;
    if (attestation) { if (attestation.schema !== 'pi-research-budget-scope-attestation.v1' || attestation.scopeId !== scopeId || attestation.parentSessionId !== record.parentSessionId || attestation.physicalTransport !== 'sse-http' || !/^[a-f0-9]{64}$/.test(attestation.extensionSha256)) fail(CODE_SCOPE); const code = readText(a, 'extension.mjs', 256 * 1024); if (code === null || hash(code) !== attestation.extensionSha256) fail(CODE_SCOPE); attested = true; }
    if (requireAttested && !attested) fail(CODE_SCOPE);
    return { scopeId, parentSessionId: record.parentSessionId, createdAt: record.createdAt, scopeFile: path.join(a.target, 'scope.json'), extensionFile: path.join(a.target, 'extension.mjs'), attested, ...(attestation ? { extensionSha256: attestation.extensionSha256 } : {}) };
  } finally { a.close(); }
}
function state(b, a) {
  if (!a) return { policies: [], reservations: [], settlements: new Map(), scopedRuns: 0 };
  a.check(); const names = fs.readdirSync(a.target); const policies = [], reservations = [], settlements = new Map();
  for (const name of names.filter(n => /^policy-\d{12,16}\.json$/.test(n)).sort((x, y) => Number(x.slice(7, -5)) - Number(y.slice(7, -5)))) {
    const record = readRecord(a, name, b), previous = policies.at(-1);
    if (!record || record.schema !== 'pi-research-budget-policy.v1' || record.sequence !== policies.length + 1 || name !== `policy-${slotName(record.sequence)}.json` || record.previousRevision !== (previous ? hash(previous) : null) || !requestId(record.requestId) || !/^[a-f0-9]{64}$/.test(record.requestHash) || !plain(record.limits) || Object.keys(record.limits).sort().join(',') !== 'attempts,modelRequests' || !safeInt(record.limits.attempts) || !safeInt(record.limits.modelRequests) || record.requestHash !== hash({ expectedRevision: record.previousRevision, limits: { attempts: record.limits.attempts, modelRequests: record.limits.modelRequests } }) || policies.some(p => p.requestId === record.requestId)) fail(CODE_UNAVAILABLE); policies.push(record);
  }
  for (const name of names.filter(n => /^reservation-\d{12,16}\.json$/.test(n)).sort((x, y) => Number(x.slice(12, -5)) - Number(y.slice(12, -5)))) {
    const record = readRecord(a, name, b);
    if (!record || record.schema !== 'pi-research-budget-reservation.v1' || record.kind !== 'model-request' || !safeInt(record.slot) || record.slot !== reservations.length + 1 || name !== `reservation-${slotName(record.slot)}.json` || !/^reservation-[a-f0-9]{32}$/.test(record.reservationId) || !requestId(record.requestId) || !token(record.scopeId) || !Number.isSafeInteger(record.pid) || record.pid < 1 || reservations.some(r => r.requestId === record.requestId || r.reservationId === record.reservationId)) fail(CODE_UNAVAILABLE);
    const metadata = safeMetadata(record.metadata); if (record.requestHash !== hash({ scopeId: record.scopeId, kind: record.kind, ...(metadata ? { metadata } : {}) }) || record.reservationId !== `reservation-${hash([b, record.requestId]).slice(0, 32)}`) fail(CODE_UNAVAILABLE); reservations.push(record);
    const settlement = readRecord(a, `settlement-${record.reservationId}.json`, b);
    if (settlement) { if (settlement.schema !== 'pi-research-budget-settlement.v1' || settlement.reservationId !== record.reservationId || !['completed', 'failed', 'unknown'].includes(settlement.outcome)) fail(CODE_UNAVAILABLE); safeUsage(settlement.usage); settlements.set(record.reservationId, settlement); }
  }
  if (reservations.length && !policies.length || names.some(n => /^settlement-/.test(n) && !reservations.some(r => n === `settlement-${r.reservationId}.json`))) fail(CODE_UNAVAILABLE);
  let scopedRuns = 0; const scopes = anchor(b.cwd, [...rootParts, 'scopes']);
  if (scopes) try { for (const name of fs.readdirSync(scopes.target)) { if (!/^[a-f0-9]{64}$/.test(name)) fail(CODE_SCOPE); const one = anchor(b.cwd, [...rootParts, 'scopes', name]); let record; try { record = readRecord(one, 'scope.json', b); } finally { one?.close(); } if (!record || hash(record.scopeId) !== name) fail(CODE_SCOPE); if (scopeDescriptor(b, record.scopeId).attested) scopedRuns++; } } finally { scopes.close(); }
  return { policies, reservations, settlements, scopedRuns };
}
function snapshot(b, s) {
  const policy = s.policies.at(-1); let inFlight = 0, unknown = 0;
  for (const r of s.reservations) { const end = s.settlements.get(r.reservationId); if (end?.outcome === 'unknown') unknown++; else if (!end) { try { process.kill(r.pid, 0); inFlight++; } catch (error) { if (error.code === 'ESRCH') unknown++; else inFlight++; } } }
  const times = [...s.policies, ...s.reservations, ...s.settlements.values()].map(v => v.at).filter(v => typeof v === 'string').sort();
  return { cwd: b.cwd, revision: policy ? hash(policy) : null, configured: !!policy, scopedRuns: s.scopedRuns, limits: policy ? { ...policy.limits } : { attempts: null, modelRequests: null }, usage: { attempts: scientificAttempts(b.cwd), modelRequests: s.reservations.length, inFlight, unknown }, updatedAt: times.at(-1) ?? null, enforcement: { attempts: !!policy, modelRequests: !!policy && s.scopedRuns > 0, scope: 'native-research-workflow', physicalTransport: 'sse-http' } };
}
export function readResearchBudget(options) { return fixedErrors(() => { const b = binding(options), a = anchor(b.cwd, rootParts); try { return snapshot(b, state(b, a)); } finally { a?.close(); } }); }
export function updateResearchBudget(options) {
  const b = binding(options), limits = options.limits;
  if (!requestId(options.requestId) || options.expectedRevision !== null && (typeof options.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(options.expectedRevision)) || !plain(limits) || Object.keys(limits).sort().join(',') !== 'attempts,modelRequests' || !safeInt(limits.attempts) || !safeInt(limits.modelRequests)) fail(CODE_INVALID);
  const normalized = { attempts: limits.attempts, modelRequests: limits.modelRequests };
  return withLock(b, a => { const s = state(b, a), requestHash = hash({ expectedRevision: options.expectedRevision, limits: normalized }), existing = s.policies.find(p => p.requestId === options.requestId); if (existing) { if (existing.requestHash !== requestHash) fail('research-budget-request-conflict'); return snapshot(b, s); } const previous = s.policies.at(-1), revision = previous ? hash(previous) : null; if (options.expectedRevision !== revision) fail('research-budget-revision-conflict'); const record = { schema: 'pi-research-budget-policy.v1', ...b, sequence: s.policies.length + 1, previousRevision: revision, requestId: options.requestId, requestHash, limits: normalized, at: new Date().toISOString() }; writeRecord(a, `policy-${slotName(record.sequence)}.json`, record); s.policies.push(record); return snapshot(b, s); });
}
export function createResearchBudgetScope(options) {
  const b = binding(options); if (!token(options.scopeId) || !token(options.parentSessionId)) fail(CODE_INVALID);
  return withLock(b, () => { const a = anchor(b.cwd, [...rootParts, 'scopes', hash(options.scopeId)], true); try { const existing = readRecord(a, 'scope.json', b); if (existing) { if (existing.scopeId !== options.scopeId || existing.parentSessionId !== options.parentSessionId) fail(CODE_SCOPE); } else writeRecord(a, 'scope.json', { schema: 'pi-research-budget-scope.v1', ...b, scopeId: options.scopeId, parentSessionId: options.parentSessionId, createdAt: new Date().toISOString() }); } finally { a.close(); } return scopeDescriptor(b, options.scopeId, options.parentSessionId); });
}
export function readResearchBudgetScope(options) { return fixedErrors(() => { const b = binding(options); return scopeDescriptor(b, options.scopeId, options.parentSessionId); }); }
/** Host-generated source only; no API request may supply this payload. */
export function installResearchBudgetScopeExtension(options) {
  const b = binding(options), source = options.source;
  if (!token(options.scopeId) || !token(options.parentSessionId) || typeof source !== 'string' || !source || Buffer.byteLength(source) > 256 * 1024 || Buffer.from(source).toString('utf8') !== source) fail(CODE_INVALID);
  return withLock(b, () => { scopeDescriptor(b, options.scopeId, options.parentSessionId); const a = anchor(b.cwd, [...rootParts, 'scopes', hash(options.scopeId)]); try { const old = readText(a, 'extension.mjs', 256 * 1024); if (old !== null) { if (old !== source) fail(CODE_SCOPE); } else writePrivateText(a, 'extension.mjs', source); } finally { a.close(); } return { ...scopeDescriptor(b, options.scopeId, options.parentSessionId), extensionSha256: hash(source) }; });
}
export function attestResearchBudgetScope(options) {
  const b = binding(options); if (!token(options.scopeId) || !token(options.parentSessionId) || options.physicalTransport !== 'sse-http' || !/^[a-f0-9]{64}$/.test(options.extensionSha256)) fail(CODE_INVALID);
  return withLock(b, () => { const descriptor = scopeDescriptor(b, options.scopeId, options.parentSessionId), a = anchor(b.cwd, [...rootParts, 'scopes', hash(options.scopeId)]); try { const code = readText(a, 'extension.mjs', 256 * 1024); if (code === null || hash(code) !== options.extensionSha256) fail(CODE_SCOPE); const existing = readRecord(a, 'attestation.json', b); if (existing) { if (existing.extensionSha256 !== options.extensionSha256 || existing.parentSessionId !== options.parentSessionId || existing.physicalTransport !== options.physicalTransport) fail(CODE_SCOPE); } else writeRecord(a, 'attestation.json', { schema: 'pi-research-budget-scope-attestation.v1', ...b, scopeId: descriptor.scopeId, parentSessionId: descriptor.parentSessionId, extensionSha256: options.extensionSha256, physicalTransport: 'sse-http', at: new Date().toISOString() }); } finally { a.close(); } return scopeDescriptor(b, options.scopeId, options.parentSessionId, true); });
}
export function reserveResearchBudget(options) {
  const b = binding(options), metadata = safeMetadata(options.metadata); if (!token(options.scopeId) || !requestId(options.requestId) || options.kind !== 'model-request') fail(CODE_INVALID);
  return withLock(b, a => { const s = state(b, a), policy = s.policies.at(-1); if (!policy) fail('research-budget-not-configured'); scopeDescriptor(b, options.scopeId, undefined, true); const requestHash = hash({ scopeId: options.scopeId, kind: options.kind, ...(metadata ? { metadata } : {}) }), old = s.reservations.find(r => r.requestId === options.requestId); if (old && old.requestHash !== requestHash) fail('research-budget-request-conflict'); let r = old; if (!r) { if (scientificAttempts(b.cwd) >= policy.limits.attempts) fail('research-budget-attempts-exhausted'); if (s.reservations.length >= policy.limits.modelRequests) fail('research-budget-model-requests-exhausted'); const slot = s.reservations.length + 1; if (!safeInt(slot)) fail(CODE_UNAVAILABLE); r = { schema: 'pi-research-budget-reservation.v1', ...b, reservationId: `reservation-${hash([b, options.requestId]).slice(0, 32)}`, slot, scopeId: options.scopeId, requestId: options.requestId, requestHash, kind: 'model-request', ...(metadata ? { metadata } : {}), pid: process.pid, at: new Date().toISOString() }; writeRecord(a, `reservation-${slotName(slot)}.json`, r); s.reservations.push(r); } const end = s.settlements.get(r.reservationId); return { reservationId: r.reservationId, slot: r.slot, scopeId: r.scopeId, kind: r.kind, reused: !!old, outcome: end?.outcome ?? 'in-flight', budget: snapshot(b, s) }; });
}
export function settleResearchBudget(options) {
  const b = binding(options), usage = safeUsage(options.usage); if (!/^reservation-[a-f0-9]{32}$/.test(options.reservationId) || !['completed', 'failed', 'unknown'].includes(options.outcome)) fail(CODE_INVALID);
  return withLock(b, a => { const s = state(b, a), r = s.reservations.find(r => r.reservationId === options.reservationId); if (!r) fail(CODE_SCOPE); const old = s.settlements.get(r.reservationId), payload = { outcome: options.outcome, ...(usage ? { usage } : {}) }; if (old) { if (hash({ outcome: old.outcome, ...(old.usage ? { usage: old.usage } : {}) }) !== hash(payload)) fail('research-budget-request-conflict'); } else { const record = { schema: 'pi-research-budget-settlement.v1', ...b, reservationId: r.reservationId, ...payload, at: new Date().toISOString() }; writeRecord(a, `settlement-${r.reservationId}.json`, record); s.settlements.set(r.reservationId, record); } return snapshot(b, s); });
}
export function withResearchAttemptBudget(options, action) {
  if (typeof action !== 'function') fail(CODE_INVALID); const b = binding(options), a = anchor(b.cwd, rootParts);
  let configured; try { configured = !!state(b, a).policies.length; } finally { a?.close(); }
  if (!configured) return action();
  return withLock(b, locked => { const s = state(b, locked), limit = s.policies.at(-1)?.limits.attempts; if (limit === undefined) fail('research-budget-not-configured'); const result = action(); if (result && typeof result.then === 'function') fail(CODE_INVALID); const scientific = anchor(b.cwd, ['.pi', 'research-loop']); let fd; try { scientific.check(); fd = fs.openSync(scientific.leaf('ledger.jsonl'), fs.constants.O_RDONLY | FILE_FLAGS); const before = fs.fstatSync(fd); regular(before); fs.fsyncSync(fd); scientific.check(); const named = fs.lstatSync(path.join(scientific.target, 'ledger.jsonl')), after = fs.fstatSync(fd); regular(named); regular(after); if (stamp(before) !== stamp(after) || stamp(after) !== stamp(named)) fail(CODE_UNAVAILABLE); } finally { if (fd !== undefined) fs.closeSync(fd); scientific?.close(); } return result; });
}
