import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRuntime, pathsFor, sessionId, promptMessage, supportedMessages, UUID, validateMetadataPatch } from './runtime.mjs';
import { connectWorker } from './client.mjs';
import { parseAcpAgents, parseAcpSettings } from './shared/acp/acp-config.mjs';
import { privateDir, readJson, maybeJson, atomicJson, writeExclusiveJson, sameProcess, fail } from '../../session-host/files.mjs';
import { readSessionJournal } from '../../session-host/journal.mjs';

export { createAcpSessionAdapter } from './acp-bridge/acp-session-adapter.mjs';
export { createAcpConnection, LineSplitter } from './acp-bridge/acp-connection.mjs';
export { parseAcpAgents, parseAcpSettings, DEFAULT_ACP_SETTINGS } from './shared/acp/acp-config.mjs';
export { buildAgentEnv, launchAgentProcess } from './acp-bridge/child-env.mjs';
export { supportedMessages } from './runtime.mjs';
export { createAcpSessionFacade } from './facade.mjs';
const clone = value => structuredClone(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const WORKER = fileURLToPath(new URL('./worker.mjs', import.meta.url));

/** Trusted local driver. HTTP/device admission stays with the host's normal router. */
export function createAcpHost(options) {
  const directory = privateDir(path.resolve(options.stateDir));
  const configured = parseAcpAgents(options.agents, options.onDiagnostic);
  const settings = parseAcpSettings(options.settings, options.onDiagnostic);
  const runtimes = new Map(), clients = new Map(), connecting = new Map(), listeners = new Set();
  let closed = false;
  function authorize(action, resource, principal) {
    if (closed) fail('acp-host-closed');
    const verdict = options.authorize?.(action, resource, principal);
    if (verdict && typeof verdict.then === 'function') fail('acp-synchronous-authorization-required');
    if (verdict === false) fail('acp-access-denied');
  }
  function emit(message) {
    options.onMessage?.(message);
    for (const listener of listeners) {
      try { listener(message.sessionId, clone(message)); }
      catch (error) { options.onDiagnostic?.('acp-listener-failed: ' + error.message); }
    }
  }
  function metadata(id) {
    const value = maybeJson(pathsFor(directory, id).meta);
    if (!value) return undefined;
    if (value.id !== undefined && value.id !== id || value.driver !== 'acp' || typeof value.cwd !== 'string' || !path.isAbsolute(value.cwd)) fail('acp-session-record-invalid');
    return { ...value, id, driver: 'acp', sessionFile: pathsFor(directory, id).session };
  }
  function getSession(id, principal) {
    sessionId(id);
    const runtime = runtimes.get(id);
    const saved = runtime?.getSession() ?? metadata(id);
    if (!saved) return undefined;
    authorize('read', { id, cwd: saved.cwd }, principal);
    if (runtime) return saved;
    const status = maybeJson(pathsFor(directory, id).status);
    if (saved.durable && status?.row?.id === id && sameProcess(status.worker)) {
      return clone({ ...status.row, workerPid: status.worker.pid, nativeRegistrationConfirmed: status.row.ready === true });
    }
    // Original ACP has no session/load resume; ended sidecars remain readable.
    return clone({ ...saved, live: false, status: 'ended', agentRunning: false, pendingUIRequests: [],
      endedAt: saved.endedAt ?? saved.startedAt ?? Date.now() });
  }
  function listSessions(principal) {
    const result = [];
    for (const entry of fs.readdirSync(directory)) {
      const id = entry.endsWith('.meta.json') ? entry.slice(0, -10) : '';
      if (!UUID.test(id)) continue;
      try { const row = getSession(id, principal); if (row) result.push(row); }
      catch (error) { if (error.code !== 'acp-access-denied') throw error; }
    }
    return result.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }
  async function clientFor(id) {
    if (clients.get(id) && !clients.get(id).closed) return clients.get(id);
    if (connecting.has(id)) return connecting.get(id);
    const connection = (async () => {
      const launch = readJson(pathsFor(directory, id).launch);
      if (launch.id !== id || launch.schema !== 'pi-research-acp-launch.v1'
        || launch.socket !== path.join(directory, `${id}.sock`)) fail('acp-worker-launch-invalid');
      const client = await connectWorker(launch, { timeoutMs: settings.requestTimeoutMs,
        onMessage: emit, onClose: () => clients.delete(id) });
      if (closed) { client.close(); fail('acp-host-closed'); }
      clients.set(id, client);
      return client;
    })();
    connecting.set(id, connection);
    try { return await connection; } finally { connecting.delete(id); }
  }
  async function start(request, principal) {
    const agentId = request.agentId ?? request.agent;
    const agent = configured.find(entry => entry.id === agentId);
    if (!agent) fail(configured.length ? 'acp-agent-unknown' : 'acp-agents-not-configured');
    if (['scope', 'resume', 'model'].some(key => request[key] !== undefined)) fail('acp-pi-options-incompatible');
    if (typeof request.cwd !== 'string' || !path.isAbsolute(request.cwd)) fail('acp-cwd-invalid');
    const cwd = fs.realpathSync(request.cwd);
    if (!fs.statSync(cwd).isDirectory()) fail('acp-cwd-invalid');
    authorize('start', { cwd, agentId }, principal);
    const id = sessionId(request.sessionId ?? randomUUID());
    const files = pathsFor(directory, id);
    if (fs.existsSync(files.meta) || fs.existsSync(files.launch) || fs.existsSync(files.deleted)) fail('acp-session-already-exists');
    if (!agent.durable) {
      const runtime = createRuntime({ agent, settings, cwd, id, directory, spawnToken: request.spawnToken,
        onMessage: emit, onDiagnostic: options.onDiagnostic });
      runtimes.set(id, runtime);
      const row = await runtime.start();
      if (!row.ready || !row.live) {
        await runtime.stop();
        throw Object.assign(new Error(row.hostError ?? 'ACP agent did not become ready'), { code: 'acp-start-failed', sessionId: id });
      }
      return { ...row, nativeRegistrationConfirmed: true };
    }
    if (process.platform !== 'linux') fail('acp-durable-platform-unsupported');
    const socket = path.join(directory, `${id}.sock`);
    if (Buffer.byteLength(socket) > 100) fail('acp-worker-socket-path-too-long');
    writeExclusiveJson(files.launch, { schema: 'pi-research-acp-launch.v1', id, agent, settings, cwd,
      ...(request.spawnToken ? { spawnToken: request.spawnToken } : {}), socket, capability: randomBytes(32).toString('hex') });
    const logFile = path.join(directory, `${id}.worker.log`);
    const log = fs.openSync(logFile, 'ax', 0o600);
    let child;
    try {
      child = spawn(process.execPath, [WORKER, files.launch], { cwd, env: process.env, shell: false,
        detached: true, stdio: ['ignore', log, log], windowsHide: true });
    } finally { fs.closeSync(log); }
    let launchError;
    child.on('error', error => { launchError = error; });
    child.unref();
    const deadline = Date.now() + settings.spawnTimeoutMs + 5_000;
    let connected = false;
    for (;;) {
      if (launchError) throw launchError;
      if (Date.now() > deadline) throw Object.assign(new Error('ACP worker did not become ready'), { code: 'acp-start-timeout', sessionId: id });
      const status = maybeJson(files.status);
      if (!connected && status && sameProcess(status.worker) && fs.existsSync(socket)) {
        await clientFor(id); connected = true;
      }
      // The worker fsyncs its sidecar before its first runtime witness; seeing
      // the first file alone must not turn that brief startup gap into "ended".
      const row = status ? getSession(id, principal) : undefined;
      if (row?.ready && row.live) return row;
      if (row?.status === 'ended' || child.exitCode !== null) throw Object.assign(new Error(row?.hostError ?? 'ACP worker exited before becoming ready'), { code: 'acp-start-failed', sessionId: id });
      await pause(25);
    }
  }
  async function sendMessage(id, message, principal) {
    const row = getSession(id, principal);
    if (!row?.live) return { delivered: false, reason: 'acp-session-ended' };
    authorize('control', { id, cwd: row.cwd, type: message?.type }, principal);
    if (!message || message.sessionId !== id || !supportedMessages.has(message.type)) fail('acp-message-unsupported');
    const runtime = runtimes.get(id);
    return runtime ? runtime.receive(message) : (await clientFor(id)).request('send', { message });
  }
  async function stop(id, principal) {
    const row = getSession(id, principal);
    if (!row) return undefined;
    authorize('stop', { id, cwd: row.cwd }, principal);
    if (!row.live) return row;
    const runtime = runtimes.get(id);
    const result = runtime ? await runtime.stop() : await (await clientFor(id)).request('stop');
    clients.get(id)?.close(); clients.delete(id);
    return result;
  }
  async function reconnect(id, principal) {
    const row = getSession(id, principal);
    if (!row?.live) fail('acp-session-ended');
    authorize('control', { id, cwd: row.cwd, type: 'reattach' }, principal);
    const runtime = runtimes.get(id);
    if (runtime) await runtime.reconnected();
    else await clientFor(id);
    return getSession(id, principal);
  }
  async function updateSession(id, patch, principal) {
    const row = getSession(id, principal);
    if (!row) fail('acp-session-missing');
    authorize('control', { id, cwd: row.cwd, type: 'metadata' }, principal);
    const runtime = runtimes.get(id);
    if (runtime) return runtime.updateSession(patch);
    if (row.live) return (await clientFor(id)).request('update', { patch });
    validateMetadataPatch(patch);
    const next = { ...row };
    for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete next[key]; else next[key] = clone(value); }
    atomicJson(pathsFor(directory, id).meta, next); return next;
  }
  function readEvents(id, query, principal) {
    if (!getSession(id, principal)) fail('acp-session-missing');
    return readSessionJournal(path.join(directory, `${sessionId(id)}.journal`), query);
  }
  async function deleteArchivedSession(id, principal) {
    const row = getSession(id, principal);
    const files = pathsFor(directory, id);
    const previous = maybeJson(files.deleted);
    if (previous && (previous.schema !== 'pi-research-acp-deletion.v1' || previous.id !== id)) fail('acp-deletion-record-invalid');
    if (previous?.complete) return { ok: true, deleted: true, duplicate: true };
    if (!row && !previous) fail('acp-session-missing');
    authorize('delete', { id, cwd: row?.cwd ?? previous.cwd }, principal);
    const status = maybeJson(files.status);
    if (row && (row.archived !== true || row.live || sameProcess(row.process)) || sameProcess(status?.worker)) fail('acp-archive-delete-not-safe');
    clients.get(id)?.close(); clients.delete(id);
    const journal = path.join(directory, `${id}.journal`);
    const targets = [files.meta, files.events, files.receipts, files.launch, files.status,
      path.join(directory, `${id}.worker.log`), path.join(journal, 'events.jsonl'), path.join(journal, 'events.index')];
    if (fs.existsSync(journal)) {
      const info = fs.lstatSync(journal);
      if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || fs.realpathSync(journal) !== journal) fail('acp-archive-file-unsafe');
      if (fs.readdirSync(journal).some(name => !['events.jsonl', 'events.index'].includes(name))) fail('acp-archive-file-unsafe');
    }
    const witnesses = {};
    for (const target of targets) {
      try {
        const info = fs.lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.()) fail('acp-archive-file-unsafe');
        const witness = { dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs };
        const key = path.relative(directory, target);
        if (previous && JSON.stringify(previous.files?.[key]) !== JSON.stringify(witness)) fail('acp-archive-file-changed');
        witnesses[key] = witness;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const deletion = previous ?? { schema: 'pi-research-acp-deletion.v1', id, cwd: row.cwd, timestamp: Date.now(), files: witnesses, complete: false };
    if (!previous) atomicJson(files.deleted, deletion);
    for (const target of targets) if (witnesses[path.relative(directory, target)]) fs.unlinkSync(target);
    if (fs.existsSync(journal)) fs.rmdirSync(journal);
    atomicJson(files.deleted, { ...deletion, complete: true });
    runtimes.delete(id);
    return { ok: true, deleted: true };
  }
  async function dispose({ stopDurable = false } = {}) {
    if (closed) return;
    for (const [id, runtime] of runtimes) await runtime.stop();
    if (stopDurable) for (const row of listSessions()) if (row.durable && row.live) await stop(row.id);
    closed = true;
    for (const client of clients.values()) client.close();
    clients.clear(); listeners.clear();
  }
  return { agents: () => configured.map(({ id, name }) => ({ id, name })), getSession, listSessions, start, updateSession, readEvents, deleteArchivedSession,
    send: async (id, message, principal) => (await sendMessage(id, message, principal)).delivered,
    sendMessage, prompt: (id, text, promptOptions, principal) => sendMessage(id, promptMessage(id, text, promptOptions), principal),
    cancel: async (id, principal) => (await sendMessage(id, { type: 'abort', sessionId: id }, principal)).delivered,
    stop, reconnect, onEvent: listener => { listeners.add(listener); return () => listeners.delete(listener); }, dispose };
}
