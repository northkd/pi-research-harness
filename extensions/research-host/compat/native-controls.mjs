import { createHash } from 'node:crypto';
import { registerSessionContextInjector, readNativeSessionContext } from './open-spec/native-context.mjs';
import { createOwnedProcessGroups } from './process-groups.mjs';
import { registerNativeSettingsReload } from './native-reload/index.mjs';

export const CONTROL_COMMAND = '__research_host_control';
export const CONTROL_RESULT_EVENT = 'research_host_control_result';
export const CONTROL_RECORD = 'pi-research-native-control';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
const boundedText = (value, maximum) => typeof value === 'string' && value.length > 0 && value.length <= maximum && !/[\x00-\x1f]/.test(value);

function availableCommands(pi) {
  if (typeof pi.getCommands !== 'function') throw new Error('native-command-list-unavailable');
  const commands = pi.getCommands();
  if (!Array.isArray(commands) || commands.length > 1000) throw new Error('native-command-list-unconfirmed');
  const projected = commands.map(command => {
    if (!command || !boundedText(command.name, 1024) || !['extension', 'prompt', 'skill'].includes(command.source)) throw new Error('native-command-list-unconfirmed');
    if (command.description !== undefined && (typeof command.description !== 'string' || command.description.length > 4096)) throw new Error('native-command-list-unconfirmed');
    return { name: command.name, source: command.source, ...(command.description === undefined ? {} : { description: command.description }) };
  });
  if (Buffer.byteLength(JSON.stringify(projected)) > 512 * 1024) throw new Error('native-command-list-unconfirmed');
  return projected;
}

function availableModels(registry) {
  if (typeof registry.getAvailable !== 'function') throw new Error('native-model-list-unavailable');
  const models = registry.getAvailable();
  if (!Array.isArray(models)) throw new Error('native-model-list-unconfirmed');
  if (models.length > 1000) throw new Error('native-model-list-too-large');
  const string = (value, limit) => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f]/.test(value);
  const projected = models.map(model => {
    if (!model || !string(model.provider, 256) || !string(model.id, 1024)) throw new Error('native-model-list-unconfirmed');
    const row = { provider: model.provider, id: model.id };
    if (model.name !== undefined) {
      if (!string(model.name, 2048)) throw new Error('native-model-list-unconfirmed');
      row.name = model.name;
    }
    if (model.reasoning !== undefined) {
      if (typeof model.reasoning !== 'boolean') throw new Error('native-model-list-unconfirmed');
      row.reasoning = model.reasoning;
    }
    if (model.input !== undefined) {
      if (!Array.isArray(model.input) || model.input.length > 2 || model.input.some(value => !['text', 'image'].includes(value))) throw new Error('native-model-list-unconfirmed');
      row.input = [...model.input];
    }
    if (model.contextWindow !== undefined) {
      if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1) throw new Error('native-model-list-unconfirmed');
      row.contextWindow = model.contextWindow;
    }
    if (model.thinkingLevelMap !== undefined) {
      if (!model.thinkingLevelMap || typeof model.thinkingLevelMap !== 'object' || Array.isArray(model.thinkingLevelMap)) throw new Error('native-model-list-unconfirmed');
      const entries = Object.entries(model.thinkingLevelMap);
      if (entries.some(([level, value]) => !THINKING_LEVELS.has(level) || value !== null && !string(value, 256))) throw new Error('native-model-list-unconfirmed');
      row.thinkingLevelMap = Object.fromEntries(entries);
    }
    return row;
  });
  if (Buffer.byteLength(JSON.stringify(projected)) > 512 * 1024) throw new Error('native-model-list-too-large');
  return projected;
}

function recentEntries(ctx) {
  if (!ctx.sessionManager.getLeafEntry || !ctx.sessionManager.getEntry) return (ctx.sessionManager.getBranch?.() ?? []).slice(-256);
  const entries = [];
  let entry = ctx.sessionManager.getLeafEntry();
  while (entry && entries.length < 256) {
    entries.push(entry);
    entry = entry.parentId ? ctx.sessionManager.getEntry(entry.parentId) : null;
  }
  return entries;
}

function previousReceipt(ctx, requestId) {
  const manager = ctx.sessionManager;
  if (manager.getLeafEntry && manager.getEntry) {
    let entry = manager.getLeafEntry();
    while (entry) {
      if (entry.type === 'custom' && entry.customType === CONTROL_RECORD && entry.data?.requestId === requestId) return entry.data;
      entry = entry.parentId ? manager.getEntry(entry.parentId) : null;
    }
    return;
  }
  const branch = manager.getBranch?.() ?? [];
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (entry.type === 'custom' && entry.customType === CONTROL_RECORD && entry.data?.requestId === requestId) return entry.data;
  }
}

function pendingStop(ctx) {
  const manager = ctx.sessionManager;
  let entry = manager.getLeafEntry?.();
  const reversed = entry ? null : (manager.getBranch?.() ?? []).slice().reverse();
  let index = 0;
  while (entry || reversed && index < reversed.length) {
    const current = entry ?? reversed[index++];
    const result = current.type === 'custom' && current.customType === CONTROL_RECORD && current.data?.status === 'applied' ? current.data.result : null;
    if (result?.action === 'stop_after_turn' && result.sessionId === manager.getSessionId()) return result.state === 'armed' && result.accepted ? result : undefined;
    entry = entry?.parentId ? manager.getEntry(entry.parentId) : null;
  }
}

export function nativeControlReceipt(event) {
  if (event?.type === CONTROL_RESULT_EVENT) return event;
  const entry = event?.type === 'entry_appended' ? event.entry : null;
  return entry?.type === 'custom' && entry.customType === CONTROL_RECORD && entry.data?.status === 'applied' ? entry.data.result : undefined;
}

function decode(value) {
  if (typeof value !== 'string' || value.length > 32 * 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('native-control-invalid');
  const request = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  if (!request || !/^[A-Za-z0-9_-]{1,160}$/.test(request.requestId ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(request.sessionId ?? '') || !['proposal-context', 'set-name', 'set-model', 'set-thinking-level', 'abort', 'shutdown', 'list-commands', 'stop_after_turn', 'retry', 'kill_process', 'refresh-models', 'reload-settings'].includes(request.action)) throw new Error('native-control-invalid');
  return request;
}

export function registerNativeSessionControls(pi, options = {}) {
  const settingsReload = registerNativeSettingsReload(pi, { ...options, recordType: CONTROL_RECORD, eventType: CONTROL_RESULT_EVENT });
  let state;
  let monitor;
  let monitorTimer;
  const emit = async (event, ctx) => {
    if (options.publish) await options.publish(event, ctx);
    else pi.events?.emit('research-host:native-control-result', event);
  };
  const resultEvent = (request, data) => ({ type: CONTROL_RESULT_EVENT, sessionId: request.sessionId, requestId: request.requestId,
    action: request.action, requestHash: hash(request), ...data });
  registerSessionContextInjector(pi);
  pi.on('session_start', (_event, ctx) => {
    const stopReceipt = pendingStop(ctx);
    state = { sessionId: ctx.sessionManager.getSessionId(), stopAfterTurn: !!stopReceipt, stopReceipt };
    clearInterval(monitorTimer);
    if (process.platform === 'linux' || options.processGroups) {
      monitor = options.processGroups ?? createOwnedProcessGroups();
      const observe = () => { try { monitor.observe(); } catch { /* Unknown processes cannot be selected for termination. */ } };
      observe(); monitorTimer = setInterval(observe, 2000); monitorTimer.unref?.();
    }
  });
  pi.on('session_shutdown', () => { state = undefined; clearInterval(monitorTimer); });
  pi.on('turn_end', (_event, ctx) => {
    if (state?.sessionId !== ctx.sessionManager.getSessionId() || !state.stopAfterTurn) return;
    state.stopAfterTurn = false;
    const result = { ...state.stopReceipt, state: 'completed' };
    pi.appendEntry(CONTROL_RECORD, { requestId: result.requestId, requestHash: result.requestHash, status: 'applied', result });
    ctx.shutdown();
  });

  async function apply(request, ctx) {
    const sessionId = ctx.sessionManager.getSessionId();
    if (request.sessionId !== sessionId) throw new Error('native-control-session-mismatch');
    if (request.action === 'reload-settings') return settingsReload.apply(request, ctx);
    const signature = hash(request);
    if (request.action === 'list-commands') {
      const result = resultEvent(request, { accepted: true, state: 'observed', commands: availableCommands(pi) });
      if (!options.publish) pi.appendEntry(CONTROL_RECORD, { requestId: request.requestId, requestHash: signature, status: 'applied', result });
      await emit(result, ctx);
      return result;
    }
    if (request.action === 'refresh-models') {
      if (request.includeModels !== undefined && typeof request.includeModels !== 'boolean') throw new Error('native-model-refresh-invalid');
      await options.syncProviders?.(ctx);
      if (typeof ctx.modelRegistry?.refresh !== 'function') throw new Error('native-model-refresh-unavailable');
      const refreshed = await ctx.modelRegistry.refresh({ allowNetwork: false });
      if (!refreshed || refreshed.aborted !== false || typeof refreshed.errors?.size !== 'number') throw new Error('native-model-refresh-unconfirmed');
      if (refreshed.errors.size || ctx.modelRegistry.getError?.()) throw new Error('native-model-refresh-failed');
      const result = resultEvent(request, { accepted: true, state: 'refreshed', allowNetwork: false,
        ...(request.includeModels ? { models: availableModels(ctx.modelRegistry) } : {}) });
      // Refresh is idempotent: avoid walking the transcript or filing intent.
      // External sessions publish into the host event journal. Pi 1.3 RPC has
      // no custom event API, so it needs one native appendEntry receipt.
      if (!options.publish) {
        if (typeof pi.appendEntry !== 'function') throw new Error('native-control-durability-unavailable');
        pi.appendEntry(CONTROL_RECORD, { requestId: request.requestId, requestHash: signature, status: 'applied', result });
      }
      await emit(result, ctx);
      return result;
    }
    const previous = previousReceipt(ctx, request.requestId);
    if (previous) {
      if (previous.requestHash !== signature) throw new Error('native-control-id-conflict');
      const event = previous.status === 'applied' ? previous.result : resultEvent(request, { accepted: false, state: 'unconfirmed' });
      // appendEntry supplies the canonical RPC event even when extension stdout
      // is redirected. A replay reissues only its receipt, never its effect.
      if (previous.status === 'applied') pi.appendEntry(CONTROL_RECORD, { requestId: request.requestId, requestHash: signature, status: 'applied', result: event });
      await emit(event, ctx); return event;
    }
    if (typeof pi.appendEntry !== 'function') throw new Error('native-control-durability-unavailable');
    pi.appendEntry(CONTROL_RECORD, { requestId: request.requestId, requestHash: signature, status: 'received' });
    let result;
    if (request.action === 'proposal-context') {
      const context = readNativeSessionContext(ctx);
      if (context.attachedChange !== request.attachedChange) throw new Error('native-proposal-binding-changed');
      result = resultEvent(request, { accepted: true, state: 'applied', ...context });
    } else if (request.action === 'set-name') {
      if (typeof request.name !== 'string' || request.name.length > 4096 || request.name.includes('\0') || typeof pi.setSessionName !== 'function' || typeof pi.getSessionName !== 'function') throw new Error('native-session-name-invalid');
      pi.setSessionName(request.name);
      if ((pi.getSessionName() ?? '') !== request.name) throw new Error('native-session-name-unconfirmed');
      result = resultEvent(request, { accepted: true, state: 'applied', name: request.name });
    } else if (request.action === 'set-model') {
      if (!boundedText(request.provider, 256) || !boundedText(request.modelId, 1024)) throw new Error('native-model-selection-invalid');
      await options.syncProviders?.(ctx);
      if (typeof ctx.modelRegistry?.find !== 'function' || typeof pi.setModel !== 'function') throw new Error('native-model-selection-unavailable');
      const model = ctx.modelRegistry.find(request.provider, request.modelId);
      if (!model || model.provider !== request.provider || model.id !== request.modelId) throw new Error('native-model-not-found');
      if (await pi.setModel(model) !== true) throw new Error('native-model-selection-refused');
      if (ctx.model?.provider !== request.provider || ctx.model?.id !== request.modelId) throw new Error('native-model-selection-unconfirmed');
      const thinkingLevel = pi.getThinkingLevel?.();
      result = resultEvent(request, { accepted: true, state: 'applied', provider: ctx.model.provider, modelId: ctx.model.id,
        ...(THINKING_LEVELS.has(thinkingLevel) ? { thinkingLevel } : {}) });
    } else if (request.action === 'set-thinking-level') {
      if (!THINKING_LEVELS.has(request.level)) throw new Error('native-thinking-level-invalid');
      if (typeof pi.setThinkingLevel !== 'function' || typeof pi.getThinkingLevel !== 'function') throw new Error('native-thinking-level-unavailable');
      pi.setThinkingLevel(request.level);
      const level = pi.getThinkingLevel();
      if (!THINKING_LEVELS.has(level)) throw new Error('native-thinking-level-unconfirmed');
      result = resultEvent(request, { accepted: true, state: 'applied', level, requestedLevel: request.level, clamped: level !== request.level });
    } else if (request.action === 'abort') {
      if (typeof ctx.abort !== 'function' || typeof ctx.isIdle !== 'function') throw new Error('native-abort-unavailable');
      const alreadyIdle = ctx.isIdle() === true;
      ctx.abort();
      const deadline = Date.now() + (options.abortTimeoutMs ?? 5000);
      while (ctx.isIdle() !== true && ctx.sessionManager.getSessionId() === sessionId && Date.now() < deadline) await pause(20);
      if (ctx.sessionManager.getSessionId() !== sessionId || ctx.isIdle() !== true) throw new Error('native-abort-unconfirmed');
      result = resultEvent(request, { accepted: true, state: 'idle', idle: true, alreadyIdle,
        ...(typeof ctx.hasPendingMessages === 'function' ? { hasPendingMessages: ctx.hasPendingMessages() } : {}) });
    } else if (request.action === 'shutdown') {
      if (typeof ctx.shutdown !== 'function') throw new Error('native-shutdown-unavailable');
      result = resultEvent(request, { accepted: true, state: 'shutdown-requested' });
    } else if (request.action === 'stop_after_turn') {
      if (typeof ctx.shutdown !== 'function') throw new Error('native-shutdown-unavailable');
      state ??= { sessionId, stopAfterTurn: false };
      state.stopAfterTurn = true;
      result = resultEvent(request, { accepted: true, state: 'armed' });
      state.stopReceipt = result;
    } else if (request.action === 'retry') {
      if (!ctx.isIdle()) throw new Error('native-retry-session-not-idle');
      pi.sendMessage({ customType: 'pi-research:retry', content: "Continue the interrupted response without repeating the user's request.",
        display: false, details: { requestId: request.requestId } }, { triggerTurn: true });
      const deadline = Date.now() + (options.retryAcceptanceMs ?? 5000);
      let accepted = false;
      do {
        accepted = recentEntries(ctx).some(entry => entry.type === 'custom_message' && entry.customType === 'pi-research:retry' && entry.details?.requestId === request.requestId);
        if (accepted) break;
        await pause(20);
      } while (Date.now() < deadline && ctx.sessionManager.getSessionId() === sessionId);
      if (!accepted) throw new Error('native-retry-acceptance-unconfirmed');
      result = resultEvent(request, { accepted: true, state: 'submitted' });
    } else {
      if (!monitor) throw new Error('native-process-group-control-unavailable');
      result = resultEvent(request, { accepted: true, state: 'signal-sent', ...monitor.kill(request.pgid) });
    }
    pi.appendEntry(CONTROL_RECORD, { requestId: request.requestId, requestHash: signature, status: 'applied', result });
    await emit(result, ctx);
    if (request.action === 'shutdown') ctx.shutdown();
    return result;
  }

  async function applyWithReceipt(request, ctx) {
    try { return await apply(request, ctx); }
    catch (error) {
      // Reload may have invalidated this instance. Its fresh replacement
      // owns the receipt and the old handler must never call captured APIs.
      if (request.action === 'reload-settings') throw error;
      const event = resultEvent(request, { accepted: false, state: 'unconfirmed', error: error.code ?? error.message });
      if (!options.publish) pi.appendEntry(CONTROL_RECORD, { requestId: request.requestId, requestHash: event.requestHash, status: 'applied', result: event });
      await emit(event, ctx);
      throw error;
    }
  }
  pi.registerCommand(CONTROL_COMMAND, { description: 'Apply an authenticated Pi Research host control request.',
    handler: (args, ctx) => applyWithReceipt(decode(args.trim()), ctx) });
  return { apply: applyWithReceipt, dispose() { clearInterval(monitorTimer); state = undefined; settingsReload.dispose(); } };
}

export default function nativeSessionControls(pi) { return registerNativeSessionControls(pi); }
