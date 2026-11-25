import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJson, maybeJson, processIdentity } from '../../session-host/files.mjs';

export const RELOAD_COMMAND = '__research_host_reload_settings';
const SCHEMA = 'pi-research-native-reload.v1';
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = code => Object.assign(new Error(code), { code });

function validate(request) {
  if (!object(request) || request.action !== 'reload-settings' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.sessionId ?? '') ||
      !/^[A-Za-z0-9_-]{1,160}$/.test(request.requestId ?? '')) throw error('native-settings-reload-invalid');
}

function identity(ctx) {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionFile = ctx.sessionManager.getSessionFile();
  const cwd = ctx.cwd;
  const process = processIdentity(globalThis.process.pid);
  if (!sessionId || !path.isAbsolute(sessionFile ?? '') || !path.isAbsolute(cwd ?? '') || !process) throw error('native-settings-reload-identity-unavailable');
  return { sessionId, sessionFile, cwd, process };
}

/** Validate both native settings documents before asking Pi to reload. The
 * handoff keeps only hashes, never settings values or credentials. */
function settingsSources(cwd, agentDir) {
  const sources = [path.join(agentDir, 'settings.json'), path.join(cwd, '.pi', 'settings.json')].map(file => {
    let fd;
    try {
      fd = fs.openSync(file, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw error('native-settings-source-invalid');
      const content = fs.readFileSync(fd);
      if (!object(JSON.parse(content.toString('utf8').replace(/^\uFEFF/, '')))) throw error('native-settings-source-invalid');
      return { file, hash: createHash('sha256').update(content).digest('hex') };
    } catch (cause) {
      if (cause.code === 'ENOENT') return { file, hash: null };
      throw error('native-settings-source-invalid');
    } finally { if (fd !== undefined) fs.closeSync(fd); }
  });
  return digest(sources);
}

/** Reload invalidates all captured Pi APIs. Only the new extension instance
 * may publish success; the old instance waits using plain filesystem reads. */
export function registerNativeSettingsReload(pi, options = {}) {
  const generation = randomUUID();
  const timers = new Set();
  const hostDir = path.resolve(options.stateDir ?? process.env.PI_RESEARCH_HOST_DIR ?? path.join(os.homedir(), '.pi', 'research-host'));
  const agentDir = path.resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi', 'agent'));
  const recordType = options.recordType ?? 'pi-research-native-control';
  const eventType = options.eventType ?? 'research_host_control_result';
  const paths = request => {
    const directory = path.join(hostDir, 'native-reload', request.sessionId);
    return { record: path.join(directory, 'r-' + request.requestId + '.json'), current: path.join(directory, 'current.json') };
  };
  const receipt = (request, data) => ({ type: eventType, action: request.action, sessionId: request.sessionId,
    requestId: request.requestId, requestHash: digest(request), ...data });

  async function publish(result, ctx) {
    if (options.publish) await options.publish(result, ctx);
    else pi.appendEntry(recordType, { requestId: result.requestId, requestHash: result.requestHash, status: 'applied', result });
  }

  async function waitForCompletion(file, requestHash) {
    const deadline = Date.now() + (options.timeoutMs ?? 45_000);
    do {
      const handoff = maybeJson(file);
      if (handoff && handoff.requestHash !== requestHash) throw error('native-settings-reload-conflict');
      if (handoff?.status === 'completed' && handoff.published === true) return handoff.result;
      if (handoff?.status === 'failed') throw error(handoff.error ?? 'native-settings-reload-unconfirmed');
      await delay(20);
    } while (Date.now() < deadline);
    throw error('native-settings-reload-unconfirmed');
  }

  async function run(request, ctx) {
    validate(request);
    const exact = identity(ctx);
    if (exact.sessionId !== request.sessionId) throw error('native-settings-reload-session-mismatch');
    const file = paths(request);
    const requestHash = digest(request);
    const previous = maybeJson(file.record);
    if (previous) {
      if (previous.requestHash !== requestHash || previous.sessionFile !== exact.sessionFile || previous.cwd !== exact.cwd) throw error('native-settings-reload-conflict');
      if (previous.status === 'completed') { await publish(previous.result, ctx); return previous.result; }
      if (previous.status === 'failed') throw error(previous.error ?? 'native-settings-reload-unconfirmed');
      // A fresh TUI's session_start handler can replay its inbox while the
      // enclosing reload still awaits initialization. Leave delivery pending
      // instead of waiting recursively for that same reload to return.
      if (typeof ctx.reload !== 'function') return { accepted: false, pending: true, state: 'reloading', sessionId: request.sessionId, requestId: request.requestId };
      return waitForCompletion(file.record, requestHash);
    }
    if (ctx.isIdle() !== true || ctx.hasPendingMessages?.() !== false) throw error('native-settings-reload-busy');
    if (typeof pi.getSettings !== 'function') throw error('native-settings-reload-unavailable');
    const sourcesHash = settingsSources(exact.cwd, agentDir);
    if (typeof ctx.reload !== 'function') {
      // The public API synchronously selects a registered extension command
      // before prompt/queue/model handling when expansion is explicitly enabled.
      if (typeof pi.sendUserMessage !== 'function' || !pi.getCommands?.().some(command => command.name === RELOAD_COMMAND)) throw error('native-settings-reload-command-unavailable');
      pi.sendUserMessage('/' + RELOAD_COMMAND + ' ' + Buffer.from(JSON.stringify(request)).toString('base64url'), { expandPromptTemplates: true });
      return waitForCompletion(file.record, requestHash);
    }
    const active = maybeJson(file.current);
    if (active?.requestId && active.requestId !== request.requestId) {
      if (!/^[A-Za-z0-9_-]{1,160}$/.test(active.requestId)) throw error('native-settings-reload-conflict');
      const activeRequest = { ...request, requestId: active.requestId };
      if (['pending', 'initialized'].includes(maybeJson(paths(activeRequest).record)?.status)) throw error('native-settings-reload-in-progress');
    }
    const reload = ctx.reload.bind(ctx);
    const handoff = { schema: SCHEMA, ...exact, request, requestHash, previousGeneration: generation,
      sourcesHash, status: 'pending', createdAt: new Date().toISOString() };
    atomicJson(file.record, handoff);
    atomicJson(file.current, { schema: SCHEMA, requestId: request.requestId });
    try {
      await reload();
      // Even the interactive UI's post-reload setup has now returned. Only
      // plain state-file access is allowed through this invalidated instance.
      const saved = maybeJson(file.record);
      if (saved?.status === 'initialized') atomicJson(file.record, { ...saved, reloadReturned: true });
      else if (saved?.status === 'pending') atomicJson(file.record, { ...saved, status: 'failed', error: 'native-settings-reload-unconfirmed' });
    }
    catch {
      // The old ctx and pi may already be stale. Do not call either here.
      const saved = maybeJson(file.record);
      if (['pending', 'initialized'].includes(saved?.status)) atomicJson(file.record, { ...saved, status: 'failed', error: 'native-settings-reload-failed' });
    }
    return waitForCompletion(file.record, requestHash);
  }

  pi.registerCommand(RELOAD_COMMAND, { description: 'Reload Pi Research settings with a fresh native-instance receipt.',
    async handler(args, ctx) {
      if (!/^[A-Za-z0-9_-]{1,32768}$/.test(args.trim())) throw error('native-settings-reload-invalid');
      const request = JSON.parse(Buffer.from(args.trim(), 'base64url').toString('utf8'));
      return run(request, ctx);
    } });

  pi.on('session_start', async (event, ctx) => {
    if (event.reason !== 'reload') return;
    const exact = identity(ctx);
    const directory = path.join(hostDir, 'native-reload', exact.sessionId);
    const current = maybeJson(path.join(directory, 'current.json'));
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(current?.requestId ?? '')) return;
    const file = paths({ sessionId: exact.sessionId, requestId: current.requestId });
    const handoff = maybeJson(file.record);
    if (!handoff || handoff.status !== 'pending') return;
    try {
      validate(handoff.request);
      if (handoff.schema !== SCHEMA || handoff.requestHash !== digest(handoff.request) || handoff.sessionId !== exact.sessionId ||
          handoff.sessionFile !== exact.sessionFile || handoff.cwd !== exact.cwd || digest(handoff.process) !== digest(exact.process) ||
          handoff.previousGeneration === generation || handoff.sourcesHash !== settingsSources(exact.cwd, agentDir)) throw error('native-settings-reload-proof-mismatch');
      const settings = pi.getSettings();
      if (!object(settings)) throw error('native-settings-reload-proof-unavailable');
      const result = receipt(handoff.request, { accepted: true, state: 'reloaded', generation,
        previousGeneration: handoff.previousGeneration, ...exact, settingsHash: digest(settings), settingsFilesHash: handoff.sourcesHash });
      atomicJson(file.record, { ...handoff, status: 'initialized', result });
      let busy = false;
      const deadline = Date.now() + (options.timeoutMs ?? 45_000);
      const timer = setInterval(async () => {
        if (busy) return;
        busy = true;
        try {
          const saved = maybeJson(file.record);
          if (saved?.status !== 'initialized') { clearInterval(timer); timers.delete(timer); return; }
          if (Date.now() >= deadline) throw error('native-settings-reload-unconfirmed');
          if (!saved.reloadReturned) return;
          if (digest(identity(ctx)) !== digest(exact) || settingsSources(exact.cwd, agentDir) !== handoff.sourcesHash) throw error('native-settings-reload-proof-mismatch');
          const liveSettings = pi.getSettings();
          if (!object(liveSettings)) throw error('native-settings-reload-proof-unavailable');
          const completed = { ...result, settingsHash: digest(liveSettings) };
          await publish(completed, ctx);
          atomicJson(file.record, { ...saved, status: 'completed', result: completed, published: true });
          clearInterval(timer); timers.delete(timer);
        } catch (cause) {
          try { atomicJson(file.record, { ...handoff, status: 'failed', error: cause.code ?? 'native-settings-reload-unconfirmed' }); }
          catch { /* A failed durable write can never turn into confirmation. */ }
          clearInterval(timer); timers.delete(timer);
        } finally { busy = false; }
      }, 20);
      timer.unref?.(); timers.add(timer);
    } catch (cause) {
      atomicJson(file.record, { ...handoff, status: 'failed', error: cause.code ?? 'native-settings-reload-unconfirmed' });
    }
  });
  const dispose = () => { for (const timer of timers) clearInterval(timer); timers.clear(); };
  pi.on('session_shutdown', dispose);
  return { apply: run, generation, dispose };
}
