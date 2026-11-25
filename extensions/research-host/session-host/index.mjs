import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { spawn as spawnProcess } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SESSION_ID, object, fail, privateDir, atomicJson, writeExclusiveJson, maybeJson, readJson, sessionHeader, metaPath, sameProcess, processIdentity } from './files.mjs';
import { createSessionJournal, readSessionJournal } from './journal.mjs';
import { updateActiveToolCalls, observedToolName } from './event-status.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const promptHash = message => hash(message.images?.length || message.delivery && message.delivery !== 'steer'
  ? JSON.stringify([message.text, message.images ?? [], message.delivery ?? 'steer']) : message.text);
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const id = value => { if (!SESSION_ID.test(value ?? '')) fail('session-id-invalid'); return value; };
const token = value => { if (!SESSION_ID.test(value ?? '')) fail('session-spawn-token-invalid'); return value; };

function canonicalCwd(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) fail('session-cwd-invalid');
  const canonical = fs.realpathSync(value);
  if (!fs.statSync(canonical).isDirectory()) fail('session-cwd-invalid');
  return canonical;
}

function historicalCwd(value) {
  try {
    const cwd = canonicalCwd(value);
    if (cwd !== value) fail('session-history-cwd-mismatch');
    return { cwd, cwdMissing: false };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { cwd: value, cwdMissing: true };
  }
}

// The former Dashboard addressed native files by their trailing filename UUID.
// Only this witnessed filename convention grants an alias; metadata cannot do so.
function filenameAliases(row) {
  const match = path.basename(row.sessionFile).match(/^\d{4}-\d{2}-\d{2}T[^/]+_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i);
  return match && match[1] !== row.id ? [match[1]] : [];
}

function observedLocalProcess(value) {
  if (!object(value) || !Number.isSafeInteger(value.pid) || value.pid < 1 || typeof value.startTime !== 'string'
    || !/^[0-9]{1,32}$/.test(value.startTime)) fail('session-external-process-invalid');
  const actual = processIdentity(value.pid);
  if (!actual || actual.startTime !== value.startTime || fs.statSync('/proc/' + value.pid).uid !== process.getuid()) fail('session-external-process-unverified');
  return actual;
}

function sameLocalProcess(value) {
  try { return !!value && sameProcess(value) && fs.statSync('/proc/' + value.pid).uid === process.getuid(); }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return false; throw error; }
}

export function createSessionHost(options) {
  const stateDir = privateDir(path.resolve(options.stateDir));
  const sessionsDir = privateDir(path.resolve(options.sessionsDir));
  const recordsDir = privateDir(path.join(stateDir, 'records'));
  const keepersDir = privateDir(path.join(stateDir, 'keepers'));
  const pendingDir = privateDir(path.join(stateDir, 'pending'));
  const externalDir = privateDir(path.join(stateDir, 'external'));
  const nativeEventsDir = privateDir(path.join(stateDir, 'native-events'));
  const deletionsDir = privateDir(path.join(stateDir, 'deletions'));
  const rows = new Map(), events = new Set(), acknowledgements = new Set(), cursors = new Map(), externalJournals = new Map();
  const externalTtlMs = options.externalTtlMs ?? 45_000;
  let closed = false;
  const now = options.now ?? (() => Date.now());
  const recordPath = sessionId => path.join(recordsDir, id(sessionId) + '.json');
  const keeperDir = sessionId => path.join(keepersDir, id(sessionId));
  const pendingPath = value => path.join(pendingDir, token(value) + '.json');
  const externalPath = sessionId => path.join(externalDir, id(sessionId) + '.json');
  const nativeEventsPath = sessionId => path.join(nativeEventsDir, id(sessionId) + '.json');
  const deletionPath = sessionId => path.join(deletionsDir, id(sessionId) + '.json');
  const pending = value => maybeJson(pendingPath(value)) ?? { schema: 'pi-research-pending-session.v1', token: value };
  const savePending = value => atomicJson(pendingPath(value.token), value);
  const saveRow = row => {
    row = { ...row, legacySessionIds: filenameAliases(row) };
    atomicJson(recordPath(row.id), row); rows.set(row.id, clone(row)); return row;
  };
  function aliasOwners(alias) { return [...rows.values()].filter(row => filenameAliases(row).includes(alias)); }
  function resolveSessionId(sessionId) {
    id(sessionId);
    if (rows.has(sessionId)) return sessionId;
    const owners = aliasOwners(sessionId);
    if (owners.length > 1) fail('session-history-alias-ambiguous');
    if (!owners.length) return sessionId;
    const row = owners[0], header = sessionHeader(row.sessionFile);
    if (header.id !== row.id || header.cwd !== row.cwd) fail('session-history-identity-mismatch');
    return row.id;
  }
  const fileWitness = file => {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || fs.realpathSync(file) !== file) fail('session-archive-file-unsafe');
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs };
  };
  function finishArchivedDeletion(deletion) {
    if (deletion.schema !== 'pi-research-session-deletion.v1' || !SESSION_ID.test(deletion.sessionId ?? '')
      || typeof deletion.sessionFile !== 'string' || !deletion.sessionFile.startsWith(sessionsDir + path.sep)
      || !deletion.sessionFile.endsWith('.jsonl')) fail('session-archive-deletion-invalid');
    const currentStatus = maybeJson(path.join(keeperDir(deletion.sessionId), 'status.json'));
    if (currentStatus && (sameProcess(currentStatus.worker) || sameProcess(currentStatus.keeper))) fail('session-archive-process-live');
    for (const [file, expected] of [[deletion.sessionFile, deletion.source], [metaPath(deletion.sessionFile), deletion.meta]]) {
      if (!fs.existsSync(file)) continue;
      const current = fileWitness(file);
      if (!expected || ['dev', 'ino', 'size', 'mtimeMs'].some(key => current[key] !== expected[key])) fail('session-archive-file-changed');
      if (file === deletion.sessionFile) {
        const header = sessionHeader(file);
        if (header.id !== deletion.sessionId || header.cwd !== deletion.cwd) fail('session-archive-identity-changed');
      }
      fs.unlinkSync(file);
    }
    fs.rmSync(recordPath(deletion.sessionId), { force: true });
    rows.delete(deletion.sessionId); cursors.delete(deletion.sessionId);
    atomicJson(deletionPath(deletion.sessionId), { ...deletion, complete: true });
  }

  function importSession(sessionFile, { external = false } = {}) {
    const file = path.resolve(sessionFile), header = sessionHeader(file);
    const { cwd } = historicalCwd(header.cwd);
    const meta = maybeJson(metaPath(file), 128 * 1024) ?? {};
    if (meta.id !== undefined && meta.id !== header.id || meta.cwd !== undefined && meta.cwd !== cwd) fail('session-history-meta-mismatch');
    const previous = rows.get(header.id);
    if (previous && previous.sessionFile !== file) fail('session-id-duplicate-history');
    const row = { ...meta, id: header.id, cwd, sessionFile: file, startedAt: header.timestamp,
      ...previous, ...(external ? { external: true } : {}) };
    saveRow(row);
    return getSession(header.id);
  }

  function refreshHistory() {
    let visited = 0;
    function visit(directory, depth = 0) {
      if (depth > 4) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        if (++visited > 16_384) fail('session-history-inventory-too-large');
        const target = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(target, depth + 1);
        else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
          try { importSession(target); }
          catch (error) { options.onDiagnostic?.(error.code ?? 'session-history-import-failed'); }
        }
      }
    }
    visit(sessionsDir);
  }

  for (const name of fs.readdirSync(deletionsDir)) {
    if (name.endsWith('.json')) finishArchivedDeletion(readJson(path.join(deletionsDir, name)));
  }
  for (const name of fs.readdirSync(recordsDir)) {
    if (!name.endsWith('.json')) continue;
    const row = readJson(path.join(recordsDir, name));
    if (row.id + '.json' !== name) fail('session-host-record-identity-invalid');
    const header = sessionHeader(row.sessionFile);
    if (header.id !== row.id || header.cwd !== row.cwd) fail('session-host-record-identity-invalid');
    rows.set(row.id, row);
  }
  if (options.discoverHistory !== false) refreshHistory();

  function getSession(sessionId) {
    sessionId = resolveSessionId(sessionId);
    const row = rows.get(id(sessionId));
    if (!row) return undefined;
    const { cwdMissing } = historicalCwd(row.cwd);
    const candidates = filenameAliases(row);
    const legacySessionIds = candidates.filter(alias => !rows.has(alias) && aliasOwners(alias).length === 1);
    const meta = maybeJson(metaPath(row.sessionFile), 128 * 1024) ?? {};
    if (meta.id !== undefined && meta.id !== sessionId || meta.cwd !== undefined && meta.cwd !== row.cwd) fail('session-history-meta-mismatch');
    const savedStatus = maybeJson(path.join(keeperDir(sessionId), 'status.json'));
    const status = row.launchId && savedStatus?.launchId !== row.launchId ? undefined : savedStatus;
    const liveKeeper = status && sameProcess(status.keeper);
    const liveWorker = status && sameProcess(status.worker);
    const external = row.external ? maybeJson(externalPath(sessionId), 8 * 1024 * 1024) : undefined;
    const externalProcessAlive = external?.process ? sameLocalProcess(external.process) : undefined;
    const externalLive = external && externalProcessAlive !== false && now() - external.lastSeenAt <= externalTtlMs;
    const state = liveKeeper && liveWorker ? status.status
      : liveWorker ? 'unknown'
        : externalProcessAlive === false ? 'ended'
          : externalLive ? external.status ?? 'idle'
          : row.external ? 'unknown'
            : status?.phase === 'ended' ? 'ended'
              : row.phase === 'prepared' || row.phase === 'launching' || row.phase === 'unknown' || meta.live === true ? 'unknown' : 'ended';
    return clone({ ...row, ...meta, id: sessionId, cwd: row.cwd, sessionFile: row.sessionFile,
      cwdMissing, ...(cwdMissing ? { resumeAvailable: false, resumeBlockedReason: 'session-cwd-missing' } : {}),
      legacySessionIds, legacyAliasConflicts: candidates.filter(alias => !legacySessionIds.includes(alias)),
      status: state, live: !!(liveKeeper && liveWorker || externalLive),
      ...(status ? { keeperPid: liveKeeper ? status.keeper.pid : undefined, pid: liveWorker ? status.worker.pid : undefined,
        pendingUIRequests: liveKeeper ? status.pendingUIRequests ?? [] : [], eventCursor: status.lastSequence ?? 0,
        initialPromptStatus: status.initialPromptStatus, hostError: status.error, currentTool: status.currentTool ?? null,
        activeToolCalls: status.activeToolCalls ?? [],
        compacting: status.compacting === true, ...(status.model ? { model: status.model } : {}),
        ...(status.thinkingLevel !== undefined ? { thinkingLevel: status.thinkingLevel } : {}) } : {}),
      ...(row.phase ? { nativeRegistrationConfirmed: status?.nativeRegistrationConfirmed === true
        && ['absent', 'accepted'].includes(status.initialPromptStatus) } : {}),
      ...(row.external ? { external: true, lastSeenAt: external?.lastSeenAt, eventCursor: external?.eventCursor ?? 0,
        pendingUIRequests: external?.pendingUIRequests ?? [], activeToolCalls: external?.activeToolCalls ?? [],
        currentTool: external?.currentTool ?? null,
        nativeExternalProcess: external?.process, pid: externalProcessAlive ? external.process.pid : undefined } : {}) });
  }

  function listSessions() { return [...rows.keys()].map(getSession); }

  function updateSession(sessionId, patch) {
    if (!object(patch)) fail('session-meta-patch-invalid');
    const row = rows.get(id(sessionId)); if (!row) fail('session-not-found');
    for (const name of ['id', 'cwd', 'sessionFile']) if (Object.hasOwn(patch, name) && patch[name] !== row[name]) fail('session-meta-identity-immutable');
    const meta = maybeJson(metaPath(row.sessionFile), 128 * 1024) ?? {};
    const next = { ...meta }, nextRow = { ...row };
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) { delete next[key]; delete nextRow[key]; }
      else { next[key] = clone(value); nextRow[key] = clone(value); }
    }
    atomicJson(metaPath(row.sessionFile), next);
    saveRow(nextRow);
    return getSession(sessionId);
  }

  async function keeperRequest(sessionId, action, value = {}, timeoutMs = 35_000) {
    const row = rows.get(id(sessionId)); if (!row) fail('session-not-found');
    const config = readJson(path.join(keeperDir(sessionId), 'config.json'), 2 * 1024 * 1024);
    const status = maybeJson(path.join(keeperDir(sessionId), 'status.json'));
    if (status && !sameProcess(status.keeper)) fail('session-keeper-unavailable');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(config.socketPath), requestId = randomUUID();
      const decoder = new StringDecoder('utf8'); let text = '';
      const timer = setTimeout(() => { socket.destroy(); reject(new Error('session-keeper-command-outcome-unknown')); }, timeoutMs);
      socket.on('connect', () => socket.write(JSON.stringify({ ...value, action, key: config.key, requestId }) + '\n'));
      socket.on('error', error => { clearTimeout(timer); reject(error); });
      socket.on('data', chunk => {
        text += decoder.write(chunk);
        if (text.length > 8 * 1024 * 1024) { socket.destroy(); clearTimeout(timer); reject(new Error('session-keeper-response-too-large')); return; }
        const newline = text.indexOf('\n'); if (newline < 0) return;
        clearTimeout(timer); socket.end();
        try {
          const response = JSON.parse(text.slice(0, newline));
          if (response.requestId !== requestId) fail('session-keeper-response-mismatch');
          if (!response.success) fail(response.error ?? 'session-keeper-request-failed');
          resolve(response.value);
        } catch (error) { reject(error); }
      });
    });
  }

  async function createSession(input) {
    if (closed) fail('session-host-closed');
    if (input.sessionId) input = { ...input, sessionId: resolveSessionId(input.sessionId) };
    if (input.sessionId && rows.get(input.sessionId)?.cwd === input.cwd && historicalCwd(input.cwd).cwdMissing) fail('session-cwd-missing');
    const cwd = canonicalCwd(input.cwd), sessionId = id(input.sessionId ?? randomUUID());
    if (fs.existsSync(deletionPath(sessionId))) fail('session-id-was-deleted');
    const existing = rows.get(sessionId);
    if (existing && (existing.cwd !== cwd || input.sessionFile && existing.sessionFile !== input.sessionFile)) fail('session-idempotency-conflict');
    if (existing) {
      const current = getSession(sessionId);
      if (current.live) return { success: true, sessionId, sessionFile: current.sessionFile, pid: current.pid, keeperPid: current.keeperPid, duplicate: true };
      if (current.status === 'unknown') fail('session-launch-outcome-unknown');
      if (input.resume !== true) fail('session-resume-required');
    }
    let sessionFile = existing?.sessionFile;
    if (input.sessionFile) {
      sessionFile = path.resolve(input.sessionFile);
      const header = sessionHeader(sessionFile);
      if (header.id !== sessionId || header.cwd !== cwd) fail('session-history-identity-mismatch');
    }
    if (!sessionFile) {
      const projectDir = privateDir(path.join(sessionsDir, '--' + cwd.replace(/[/\\:]/g, '-') + '--'));
      sessionFile = path.join(projectDir, new Date(now()).toISOString().replace(/[:.]/g, '-') + '_' + sessionId + '.jsonl');
      writeExclusiveJson(sessionFile, { type: 'session', version: 3, id: sessionId, cwd, timestamp: new Date(now()).toISOString() });
    }
    const meta = maybeJson(metaPath(sessionFile), 128 * 1024) ?? {};
    const rawRef = input.rawRef;
    if (rawRef?.researchSession?.readOnly === true && input.readOnly === false) fail('session-readonly-inheritance-invalid');
    const nextMeta = { ...meta, ...(input.metadata ?? {}), id: sessionId, cwd, sessionFile,
      ...(input.principalOwner ? { principalOwner: clone(input.principalOwner) } : {}),
      ...(rawRef?.researchSession ? { researchSession: clone(rawRef.researchSession) } : {}),
      ...(rawRef ? { pluginRefs: { ...meta.pluginRefs, 'res-workflow': clone(rawRef) } } : {}) };
    atomicJson(metaPath(sessionFile), nextMeta);
    saveRow({ ...nextMeta, external: false, phase: 'prepared', startedAt: existing?.startedAt ?? new Date(now()).toISOString() });
    if (rawRef && options.onRegistered) await options.onRegistered(sessionId, { cwd, sessionFile }, clone(rawRef));
    const directory = privateDir(keeperDir(sessionId));
    const old = maybeJson(path.join(directory, 'status.json'));
    if (old && sameProcess(old.worker)) fail('session-worker-outcome-unknown');
    if (old && sameProcess(old.keeper)) {
      process.kill(old.keeper.pid, 'SIGTERM');
      for (let count = 0; count < 100 && sameProcess(old.keeper); count++) await wait(25);
      if (sameProcess(old.keeper)) fail('session-keeper-shutdown-unconfirmed');
    }
    const socketPath = path.join(os.tmpdir(), 'pi-rs-' + process.getuid() + '-' + hash(stateDir + '\0' + sessionId).slice(0, 24) + '.sock');
    if (fs.existsSync(socketPath)) fail('session-keeper-socket-outcome-unknown');
    const configFile = path.join(directory, 'config.json');
    const launchId = randomUUID();
    const config = { schema: 'pi-research-session-launch.v1', sessionId, cwd, sessionFile, directory, socketPath, launchId,
      key: randomBytes(32).toString('hex'), piCommand: options.piCommand,
      piArgs: options.piArgs ?? [], env: options.env ?? {}, extensionPath: options.extensionPath,
      model: input.model, name: input.name, initialPrompt: input.prompt, startupTimeoutMs: options.startupTimeoutMs ?? 30_000 };
    atomicJson(configFile, config);
    saveRow({ ...rows.get(sessionId), phase: 'launching', launchId });
    const stderr = fs.openSync(path.join(directory, 'keeper.stderr.log'), 'a', 0o600);
    let child, launchError;
    try {
      child = (options.spawnImpl ?? spawnProcess)(process.execPath, [path.join(HERE, 'keeper.mjs'), configFile], { detached: true,
        cwd, env: { ...process.env, ...options.env }, stdio: ['ignore', 'ignore', stderr] });
      child.once('error', error => { launchError = error; });
      child.unref();
    } finally { fs.closeSync(stderr); }
    const deadline = now() + (options.startupTimeoutMs ?? 30_000);
    while (now() < deadline) {
      if (launchError) { saveRow({ ...rows.get(sessionId), phase: 'unknown' }); throw launchError; }
      const status = maybeJson(path.join(directory, 'status.json'));
      if (status?.launchId !== launchId) { await wait(25); continue; }
      if (status?.phase === 'ready' && !status.error && (!input.prompt || status.initialPromptStatus === 'accepted') && sameProcess(status.keeper) && sameProcess(status.worker)) {
        saveRow({ ...rows.get(sessionId), phase: 'running' });
        return { success: true, sessionId, sessionFile, pid: status.worker.pid, keeperPid: status.keeper.pid,
          spawnToken: input.spawnToken, dashboardSpawned: false };
      }
      if (status?.error || status?.phase === 'ended') {
        saveRow({ ...rows.get(sessionId), phase: 'unknown' });
        fail(status.error ?? 'session-worker-ended-during-startup');
      }
      await wait(25);
    }
    saveRow({ ...rows.get(sessionId), phase: 'unknown' });
    fail('session-launch-outcome-unknown');
  }

  const pendingPluginRefRegistry = {
    file(value, ref, ownerId) { token(value); if (!object(ref) || ownerId !== 'res-workflow') return false; const record = pending(value); if (record.ref && JSON.stringify(record.ref) !== JSON.stringify(ref)) return false; savePending({ ...record, ref: clone(ref) }); return true; },
    remove(value) { const record = pending(value); delete record.ref; savePending(record); },
    resolve(value) { return clone(pending(value).ref); },
  };
  const pendingPrincipalOwnerRegistry = {
    file(value, owner) { if (!object(owner) || typeof owner.iss !== 'string' || typeof owner.sub !== 'string') return false; const record = pending(value); savePending({ ...record, owner: { iss: owner.iss, sub: owner.sub } }); return true; },
    remove(value) { const record = pending(value); delete record.owner; savePending(record); },
  };
  const initialPrompts = {
    enqueue(cwd, prompt, value) { if (typeof prompt !== 'string' || prompt.length > 128 * 1024) return false; const record = pending(value); savePending({ ...record, cwd: canonicalCwd(cwd), prompt }); return true; },
    remove(cwd, value) { const record = pending(value); if (record.cwd === canonicalCwd(cwd)) { delete record.prompt; savePending(record); } },
  };

  async function spawn(cwd, { spawnToken }) {
    const record = pending(token(spawnToken));
    if (record.cwd !== canonicalCwd(cwd) || !record.ref?.researchSession || typeof record.prompt !== 'string') fail('session-spawn-preparation-missing');
    if (record.phase && !record.sessionId) fail('session-spawn-outcome-unknown');
    const sessionId = record.sessionId ?? randomUUID();
    if (!record.sessionId) savePending({ ...record, sessionId, phase: 'reserved' });
    const result = await createSession({ cwd, sessionId, rawRef: record.ref, principalOwner: record.owner,
      prompt: record.prompt, spawnToken, name: record.ref.researchSession.role });
    savePending({ ...record, sessionId, phase: 'spawned' });
    return result;
  }

  function registerExternalSession(input) {
    const sessionId = id(input.sessionId);
    const witnessed = input.process === undefined ? undefined : observedLocalProcess(input.process);
    const previousExternal = maybeJson(externalPath(sessionId), 8 * 1024 * 1024);
    if (witnessed && previousExternal?.process && sameLocalProcess(previousExternal.process)
      && (previousExternal.process.pid !== witnessed.pid || previousExternal.process.startTime !== witnessed.startTime)) fail('session-external-process-conflict');
    if (!fs.existsSync(input.sessionFile)) {
      const header = input.header, file = path.resolve(input.sessionFile);
      if (!object(header) || header.type !== 'session' || header.id !== sessionId || header.cwd !== canonicalCwd(input.cwd)
        || !file.startsWith(sessionsDir + path.sep) || !file.endsWith('.jsonl')) fail('session-external-header-invalid');
      const parent = path.dirname(file);
      if (fs.realpathSync(parent) !== parent || !fs.statSync(parent).isDirectory()) fail('session-external-history-unsafe');
      writeExclusiveJson(file, header);
    }
    const header = sessionHeader(input.sessionFile);
    if (header.id !== sessionId || header.cwd !== canonicalCwd(input.cwd)) fail('session-external-identity-invalid');
    const previous = rows.get(sessionId);
    const current = previous && !previous.external ? getSession(sessionId) : undefined;
    if (current?.live || current?.pid) fail('session-already-hosted');
    importSession(input.sessionFile, { external: true });
    const old = maybeJson(externalPath(sessionId), 8 * 1024 * 1024) ?? { schema: 'pi-research-external-session.v1', sessionId, inbox: [] };
    atomicJson(externalPath(sessionId), { ...old, ...(witnessed ? { process: witnessed } : {}), lastSeenAt: now(), status: input.status ?? 'idle' });
    return getSession(sessionId);
  }
  function externalInbox(sessionId) {
    const row = getSession(id(sessionId)); if (!row?.external) fail('session-external-not-found');
    return clone(maybeJson(externalPath(sessionId), 8 * 1024 * 1024)?.inbox ?? []);
  }
  function acknowledgeExternal(sessionId, promptId) {
    const record = readJson(externalPath(id(sessionId)), 8 * 1024 * 1024), message = record.inbox.find(item => item.promptId === promptId);
    if (!message) fail('session-external-prompt-not-found');
    record.inbox = record.inbox.filter(item => item.promptId !== promptId);
    record.acceptedHashes ??= {}; record.acceptedHashes[promptId] = promptHash(message);
    atomicJson(externalPath(sessionId), record);
    for (const handler of acknowledgements) handler(sessionId, promptId);
    return { accepted: true };
  }
  function queueExternalPrompt(sessionId, message) {
    if (typeof message.text !== 'string' || message.text.length > 128 * 1024 || !/^[A-Za-z0-9_-]{1,160}$/.test(message.promptId ?? '')) fail('session-prompt-invalid');
    if (!['steer', 'followUp'].includes(message.delivery ?? 'steer')) fail('session-prompt-delivery-invalid');
    if (message.images !== undefined && (!Array.isArray(message.images) || message.images.some(image => image?.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string'))) fail('session-prompt-images-invalid');
    const record = readJson(externalPath(sessionId), 8 * 1024 * 1024), signature = promptHash(message);
    if (record.acceptedHashes?.[message.promptId]) {
      if (record.acceptedHashes[message.promptId] !== signature) fail('session-prompt-idempotency-conflict');
      for (const handler of acknowledgements) handler(sessionId, message.promptId);
      return { accepted: true, duplicate: true };
    }
    const previous = record.inbox.find(item => item.promptId === message.promptId);
    if (previous && promptHash(previous) !== signature) fail('session-prompt-idempotency-conflict');
    if (!previous) {
      if (Object.keys(record.acceptedHashes ?? {}).length + record.inbox.length >= 16_384 || record.inbox.length >= 1024) fail('session-external-inbox-full');
      record.inbox.push(clone(message));
      if (Buffer.byteLength(JSON.stringify(record)) >= 8 * 1024 * 1024) fail('session-external-inbox-full');
      atomicJson(externalPath(sessionId), record);
    }
    return { accepted: false, queued: true, duplicate: !!previous };
  }
  async function notifyParent(sessionId, text, promptId) {
    if (typeof text !== 'string' || text.length > 128 * 1024 || !/^[A-Za-z0-9_-]{1,160}$/.test(promptId ?? '')) fail('session-prompt-invalid');
    const row = getSession(id(sessionId)); if (!row) return false;
    if (row.external) {
      queueExternalPrompt(sessionId, { promptId, text, delivery: 'steer' });
      return true;
    }
    try { const response = await keeperRequest(sessionId, 'deliver', { text, promptId }); return response.accepted === true; }
    catch (error) { options.onDiagnostic?.(error.code ?? error.message); return false; }
  }
  async function deliverPrompt(sessionId, { text, images, promptId = randomUUID(), delivery = 'followUp', acceptanceTimeoutMs = 30_000 }) {
    const row = getSession(id(sessionId)); if (!row) fail('session-not-found');
    if (row.external) {
      if (!Number.isFinite(acceptanceTimeoutMs) || acceptanceTimeoutMs < 1 || acceptanceTimeoutMs > 120_000) fail('session-prompt-timeout-invalid');
      const queued = queueExternalPrompt(sessionId, { text, images, promptId, delivery });
      if (queued.accepted) return queued;
      return new Promise((resolve, reject) => {
        const acknowledged = (receivedSessionId, receivedPromptId) => {
          if (receivedSessionId !== sessionId || receivedPromptId !== promptId) return;
          clearTimeout(timer); acknowledgements.delete(acknowledged);
          resolve({ accepted: true, disposition: 'accepted', promptId });
        };
        const timer = setTimeout(() => {
          acknowledgements.delete(acknowledged);
          const error = new Error('session-prompt-acceptance-unconfirmed');
          error.code = error.message; error.promptId = promptId; error.pending = true; reject(error);
        }, acceptanceTimeoutMs);
        acknowledgements.add(acknowledged);
      });
    }
    return keeperRequest(sessionId, 'deliver', { text, images, promptId, delivery });
  }
  function readEvents(sessionId, { after = 0, limit = 200 } = {}) {
    return readSessionJournal(keeperDir(id(sessionId)), { after, limit });
  }
  function recordExternalEvent(sessionId, event) {
    if (!getSession(id(sessionId))?.external || !object(event)) fail('session-external-event-invalid');
    let journal = externalJournals.get(sessionId);
    if (!journal) { journal = createSessionJournal(keeperDir(sessionId)); externalJournals.set(sessionId, journal); }
    const entry = journal.append(event);
    const external = readJson(externalPath(sessionId), 8 * 1024 * 1024);
    const calls = new Map((external.activeToolCalls ?? []).map(call => [call.toolCallId, call]));
    if (updateActiveToolCalls(calls, event)) {
      external.activeToolCalls = [...calls.values()];
      external.currentTool = observedToolName(calls);
    }
    external.eventCursor = entry.sequence; atomicJson(externalPath(sessionId), external);
    for (const listener of events) listener(sessionId, clone(event));
  }
  function eventInbox(sessionId) {
    if (!getSession(id(sessionId))) fail('session-not-found');
    return clone(maybeJson(nativeEventsPath(sessionId), 8 * 1024 * 1024)?.queue ?? []);
  }
  function emitEventToSession(sessionId, event) {
    if (!getSession(id(sessionId))) fail('session-not-found');
    if (!object(event) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(event.eventId ?? '') || typeof event.eventType !== 'string' || !object(event.data)) fail('session-native-event-invalid');
    const record = maybeJson(nativeEventsPath(sessionId), 8 * 1024 * 1024) ?? { schema: 'pi-research-native-events.v1', queue: [], accepted: {} };
    const signature = hash(JSON.stringify(event));
    if (record.rejected?.[event.eventId]) {
      const rejected = record.rejected[event.eventId];
      if (rejected.hash !== signature) fail('session-native-event-idempotency-conflict');
      return { queued: false, accepted: false, rejected: true, reason: rejected.reason, duplicate: true };
    }
    if (record.accepted[event.eventId]) {
      if (record.accepted[event.eventId] !== signature) fail('session-native-event-idempotency-conflict');
      return { queued: false, accepted: true, duplicate: true };
    }
    const previous = record.queue.find(item => item.eventId === event.eventId);
    if (previous && JSON.stringify(previous) !== JSON.stringify(event)) fail('session-native-event-idempotency-conflict');
    if (!previous) {
      if (record.queue.length + Object.keys(record.accepted).length + Object.keys(record.rejected ?? {}).length >= 16_384) fail('session-native-event-capacity');
      record.queue.push(clone(event));
      if (Buffer.byteLength(JSON.stringify(record)) >= 8 * 1024 * 1024) fail('session-native-event-capacity');
      atomicJson(nativeEventsPath(sessionId), record);
    }
    return { queued: true, accepted: false, duplicate: !!previous };
  }
  function acknowledgeEvent(sessionId, eventId) {
    const record = readJson(nativeEventsPath(id(sessionId)), 8 * 1024 * 1024);
    if (record.rejected?.[eventId]) fail('session-native-event-was-rejected');
    const event = record.queue.find(item => item.eventId === eventId);
    if (!event) {
      if (record.accepted[eventId]) return { accepted: true, duplicate: true };
      fail('session-native-event-not-found');
    }
    record.accepted[eventId] = hash(JSON.stringify(event));
    record.queue = record.queue.filter(item => item.eventId !== eventId);
    atomicJson(nativeEventsPath(sessionId), record);
    return { accepted: true };
  }
  function rejectEvent(sessionId, eventId, reason) {
    if (typeof reason !== 'string' || !reason.trim() || reason.length > 200 || /[\u0000-\u001f\u007f]/.test(reason)) fail('session-native-event-reason-invalid');
    const record = readJson(nativeEventsPath(id(sessionId)), 8 * 1024 * 1024);
    if (record.accepted[eventId]) fail('session-native-event-already-accepted');
    if (record.rejected?.[eventId]) {
      const previous = record.rejected[eventId];
      if (previous.reason !== reason) fail('session-native-event-rejection-conflict');
      return { rejected: true, reason: previous.reason, duplicate: true };
    }
    const event = record.queue.find(item => item.eventId === eventId);
    if (!event) fail('session-native-event-not-found');
    record.rejected ??= {};
    record.rejected[eventId] = { hash: hash(JSON.stringify(event)), reason, at: new Date(now()).toISOString() };
    record.queue = record.queue.filter(item => item.eventId !== eventId);
    atomicJson(nativeEventsPath(sessionId), record);
    return { rejected: true, reason };
  }
  const timer = setInterval(() => {
    if (!events.size && !acknowledgements.size) return;
    for (const [sessionId, row] of rows) {
      if (row.external) continue;
      try {
        const result = readEvents(sessionId, { after: cursors.get(sessionId) ?? 0, limit: 2000 });
        for (const entry of result.events) {
          if (entry.event.type === 'prompt_received') for (const handler of acknowledgements) handler(sessionId, entry.event.promptId);
          for (const listener of events) listener(sessionId, clone(entry.event));
        }
        cursors.set(sessionId, result.nextCursor);
      } catch (error) { options.onDiagnostic?.(error.code ?? 'session-events-unavailable'); }
    }
  }, options.pollMs ?? 500);
  timer.unref();
  const command = (sessionId, rpcCommand) => {
    if (!object(rpcCommand) || ['new_session', 'switch_session', 'fork', 'fork_session'].includes(rpcCommand.type)) fail('session-command-identity-change-forbidden');
    return keeperRequest(sessionId, 'command', { command: rpcCommand });
  };
  const respondUI = (sessionId, response) => keeperRequest(sessionId, 'ui', { response });
  async function terminate(sessionId) {
    const status = readJson(path.join(keeperDir(id(sessionId)), 'status.json'));
    if (!sameProcess(status.keeper)) {
      if (sameProcess(status.worker)) fail('session-worker-owner-unavailable');
      return { stopped: true, workerExited: true, state: 'stopped' };
    }
    await keeperRequest(sessionId, 'terminate', {}, 12_000);
    const deadline = Date.now() + 3000;
    while (sameProcess(status.keeper) && Date.now() < deadline) await wait(25);
    if (sameProcess(status.keeper) || sameProcess(status.worker)) return { stopped: false, state: 'stopping' };
    return { stopped: true, workerExited: true, state: 'stopped' };
  }
  async function retireIfIdle(sessionId, { pid, reportId }) {
    const row = getSession(id(sessionId)); if (!row) fail('session-not-found');
    if (row.external) return { retired: false, committed: false, state: 'retained', reason: 'session-retirement-external', reportId };
    const status = readJson(path.join(keeperDir(sessionId), 'status.json'));
    if (['prepared', 'launching', 'unknown'].includes(row.phase) || row.launchId && status.launchId !== row.launchId) {
      return { retired: false, committed: false, state: 'retained', reason: 'session-retirement-unready', reportId };
    }
    if (!sameProcess(status.keeper)) {
      if (status.retirement?.committed && status.retirement.reportId === reportId && status.retirement.pid === pid && !sameProcess(status.worker)) {
        return { retired: true, committed: true, state: 'retired', workerExited: true, reportId };
      }
      fail('session-retirement-owner-unavailable');
    }
    const result = await keeperRequest(sessionId, 'retire', { pid, reportId }, 12_000);
    if (!result.committed) return result;
    const deadline = Date.now() + 3000;
    while (sameProcess(status.keeper) && Date.now() < deadline) await wait(25);
    const ended = !sameProcess(status.keeper) && !sameProcess(status.worker);
    return { ...result, retired: ended, state: ended ? 'retired' : 'retiring', workerExited: !sameProcess(status.worker) };
  }
  function deleteArchivedSession(sessionId) {
    const existing = maybeJson(deletionPath(id(sessionId)));
    if (existing) { finishArchivedDeletion(existing); return { ok: true, deleted: true, duplicate: true }; }
    const row = getSession(sessionId); if (!row) fail('session-not-found');
    if (row.archived !== true || row.status !== 'ended' || row.live || row.originDeviceId) fail('session-archive-delete-not-safe');
    if (!row.sessionFile.startsWith(sessionsDir + path.sep)) fail('session-archive-history-root-mismatch');
    const header = sessionHeader(row.sessionFile);
    if (header.id !== row.id || header.cwd !== row.cwd) fail('session-archive-identity-changed');
    const sidecar = metaPath(row.sessionFile), meta = maybeJson(sidecar, 128 * 1024);
    if (!meta || meta.archived !== true || meta.id !== undefined && meta.id !== row.id || meta.cwd !== undefined && meta.cwd !== row.cwd) fail('session-archive-metadata-invalid');
    const deletion = { schema: 'pi-research-session-deletion.v1', sessionId, cwd: row.cwd, sessionFile: row.sessionFile,
      source: fileWitness(row.sessionFile), meta: fileWitness(sidecar), complete: false, at: new Date(now()).toISOString() };
    writeExclusiveJson(deletionPath(sessionId), deletion);
    finishArchivedDeletion(deletion);
    return { ok: true, deleted: true };
  }
  const resolved = operation => (sessionId, ...args) => operation(resolveSessionId(sessionId), ...args);
  return {
    getSession, listSessions, importSession, refreshHistory, resolveSessionId,
    updateSession: resolved(updateSession), updateSessionMeta: resolved(updateSession), createSession,
    spawn, pendingPluginRefRegistry, pendingPrincipalOwnerRegistry, initialPrompts,
    notifyParent: resolved(notifyParent), deliverPrompt: resolved(deliverPrompt),
    command: resolved(command), readEvents: resolved(readEvents), respondUI: resolved(respondUI), respondUi: resolved(respondUI),
    abort: resolved(sessionId => command(sessionId, { type: 'abort' })), terminate: resolved(terminate),
    retireIfIdle: resolved(retireIfIdle), deleteArchivedSession: resolved(deleteArchivedSession),
    registerExternalSession, externalInbox: resolved(externalInbox), acknowledgeExternal: resolved(acknowledgeExternal),
    recordExternalEvent: resolved(recordExternalEvent), eventInbox: resolved(eventInbox), emitEventToSession: resolved(emitEventToSession),
    acknowledgeEvent: resolved(acknowledgeEvent), rejectEvent: resolved(rejectEvent),
    subscribeReceiptAcks(handler) { acknowledgements.add(handler); return () => acknowledgements.delete(handler); },
    subscribeEvents(handler) { events.add(handler); return () => events.delete(handler); },
    close() { closed = true; clearInterval(timer); events.clear(); acknowledgements.clear(); for (const journal of externalJournals.values()) journal.close(); externalJournals.clear(); },
  };
}
