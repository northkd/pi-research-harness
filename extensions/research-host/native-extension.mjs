import { readBoundedJson, readResearchHostLocalAuth } from '../research-loop/src/workbench-session-tool.mjs';
import { createNativePromptReceipts } from './native-receipts.mjs';
import { registerNativeRuntime } from './supplemental/native-runtime.mjs';
import { registerNativeSessionControls } from './compat/native-controls.mjs';
import { registerPiTrust } from './compat/pi-trust/register.mjs';
import { registerNativePathGate } from './compat/grants/index.mjs';
import { readLocalHostConfig } from './config.mjs';
import { QUESTION_CONTEXT_RECORD, registerNativeQuestionTools } from './supplemental/questions/native.mjs';
import { readTranslationRevision } from '../thinking-translator/shared/thinking-translation-auth.ts';
import { THINKING_TRANSLATION_CHANNEL, isThinkingTranslationFrame } from '../thinking-translator/shared/thinking-translation.ts';
import fs from 'node:fs';
import path from 'node:path';
import { loadNativeProviderConfigs, applyNativeProviderConfigs } from './compat/providers/native.mjs';
import { processIdentity } from './session-host/files.mjs';

const HOST_MANAGED = Symbol.for('pi-research-host.managed-native-process');

async function exchange(pathname, data) {
  const { baseUrl, token } = readResearchHostLocalAuth();
  const response = await fetch(new URL(pathname, baseUrl), {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/json', 'x-pi-local-token': token },
    body: JSON.stringify(data),
    signal: AbortSignal.timeout(3500),
  });
  if (!response.ok) throw new Error('research-host-registration-unavailable');
  return readBoundedJson(response, 2 * 1024 * 1024);
}

/** Register a native terminal session without replacing its interactive UI.
 * Hosted RPC sessions already use the keeper's registration and inbox. */
export default async function researchHostNativeExtension(pi) {
  if (process.env.PI_RESEARCH_BACKEND === 'dashboard') return;
  registerPiTrust(pi);
  if (!process.env.PI_RESEARCH_HOST_DIR) return;
  // Keep the process role through /reload. Spawned Pi children must register
  // their own session identity and cannot inherit the parent keeper role.
  process[HOST_MANAGED] ??= process.env.PI_RESEARCH_HOST_MANAGED === '1';
  delete process.env.PI_RESEARCH_HOST_MANAGED;
  delete process.env.PI_RESEARCH_HOST_SESSION_ID;
  const managed = process[HOST_MANAGED];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  let providerStamp, providerUpdate, registeredProviders = new Set();
  const providerFiles = ['providers.json', 'provider-models-cache.json', 'models.json', 'auth.json'];
  function providerInputStamp() {
    return providerFiles.map(file => {
      try {
        const status = fs.lstatSync(path.join(agentDir, file), { bigint: true });
        return [status.dev, status.ino, status.mtimeNs, status.ctimeNs, status.size].join(':');
      } catch (error) {
        if (error.code === 'ENOENT') return '-';
        throw error;
      }
    }).join('/');
  }
  async function syncProviders(ctx) {
    if (!agentDir || !ctx.modelRegistry?.refresh || !pi.registerProvider || !pi.unregisterProvider) return;
    if (providerUpdate) await providerUpdate;
    const stamp = providerInputStamp();
    if (providerStamp === stamp) return;
    providerUpdate = (async () => {
      // Native Pi has already read its own models/auth at startup. The first
      // pass only needs to refresh if there are additional host providers.
      const configs = loadNativeProviderConfigs({ agentDir, registryModels: ctx.modelRegistry.getAll?.() ?? [] });
      if (providerStamp !== undefined || Object.keys(configs).length > 0) {
        const result = await applyNativeProviderConfigs({ pi, ctx, configs, previous: registeredProviders });
        registeredProviders = result.registered;
        if (result.errors?.size || ctx.modelRegistry.getError?.()) throw new Error('native-provider-config-unconfirmed');
      }
      providerStamp = stamp;
    })().finally(() => { providerUpdate = undefined; });
    await providerUpdate;
  }
  const nativeQuestions = registerNativeQuestionTools(pi, {
    remoteDialogs: !managed,
    getConfig: () => {
      try { return readLocalHostConfig(); } catch { return {}; }
    },
    publishContext: (data, ctx) => exchange('/internal/native/event', {
      sessionId: ctx.sessionManager.getSessionId(), event: { type: QUESTION_CONTEXT_RECORD, data },
    }),
  });
  const controls = registerNativeSessionControls(pi, {
    publish: managed ? undefined : (event, ctx) => exchange('/internal/native/event', {
      sessionId: ctx.sessionManager.getSessionId(), event,
    }),
    syncProviders,
  });
  const plugins = await registerNativeRuntime(pi, {
    request: exchange, forwardNativeEvents: !managed, activateAnthropic: true, pollEvents: false,
  });
  let current;
  let announced = false;
  let toolEvents = Promise.resolve();
  const forwardTool = (event, ctx) => {
    if (managed || typeof event.toolCallId !== 'string') return;
    const sessionId = ctx.sessionManager.getSessionId();
    toolEvents = toolEvents.then(() => exchange('/internal/native/event', { sessionId, event: {
      type: event.type, toolCallId: event.toolCallId, toolName: event.toolName, parentToolCallId: event.parentToolCallId,
    } })).catch(() => {});
  };
  pi.on('tool_execution_start', forwardTool);
  pi.on('tool_execution_end', forwardTool);
  const releaseTranslation = pi.events?.on(THINKING_TRANSLATION_CHANNEL, frame => {
    if (!current || !isThinkingTranslationFrame(frame)) return;
    const { ctx } = current;
    const sessionId = ctx.sessionManager.getSessionId(), sessionFile = ctx.sessionManager.getSessionFile();
    if (frame.sessionId !== sessionId || !sessionFile) return;
    void exchange('/internal/native/thinking-translation', {
      sessionId, sessionFile, cwd: ctx.cwd, frame, revision: readTranslationRevision(sessionId),
    }).catch(() => {});
  });

  async function acknowledge(sessionId, promptId) {
    try { await exchange('/internal/native/acknowledge', { sessionId, promptId }); }
    catch { /* The pending delivery and id remain available for retry. */ }
  }

  async function poll(state) {
    if (state !== current || state.busy) return;
    state.busy = true;
    try {
      const { ctx } = state;
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionId || !sessionFile) return;
      if (ctx.isIdle()) {
        try { await syncProviders(ctx); } catch { /* A browser model refresh returns the exact native failure. */ }
      }
      const identity = { cwd: ctx.cwd, sessionId, sessionFile };
      const reply = managed ? await exchange('/internal/native/inbox', identity)
        : await exchange('/internal/native/register', {
          ...identity, header: ctx.sessionManager.getHeader?.(),
          process: processIdentity(process.pid),
          status: ctx.isIdle() ? 'idle' : 'streaming',
        });
      if (state !== current || reply.data?.sessionId !== sessionId) return;
      announced = false;
      const translationRevision = readTranslationRevision(sessionId);
      if (state.translationRevision !== translationRevision || state.translationHostInstance !== reply.data.hostInstanceId) {
        state.translationRevision = translationRevision;
        state.translationHostInstance = reply.data.hostInstanceId;
        pi.events?.emit('thinking-translator:status-request', { sessionId });
      }
      await nativeQuestions.publishPending(ctx, { force: state.questionHostInstance !== reply.data.hostInstanceId });
      state.questionHostInstance = reply.data.hostInstanceId;
      if (!state.mcpRegistered && process.env.PI_RESEARCH_HOST_MCP === '1' && typeof pi.registerMcpServer === 'function') {
        try {
          const response = await exchange('/internal/native/mcp-token', identity);
          const token = response.data;
          if (typeof token === 'string') {
            const { baseUrl } = readResearchHostLocalAuth();
            pi.registerMcpServer('pi-research-host', {
              url: new URL('/mcp', baseUrl).href, protocolVersion: '2026-07-28',
              headers: { Authorization: 'Bearer ' + token },
            });
            state.mcpRegistered = true;
          }
        } catch { /* The next exact-session poll can retry an unregistered MCP connection. */ }
      }
      const pluginEvents = [];
      for (const event of reply.data?.events ?? []) {
        if (event.eventType === 'research-host:question-response') {
          const answer = await nativeQuestions.consumeEvent(event, ctx);
          if (answer?.status === 'accepted') {
            await exchange('/internal/native/event-acknowledge', { sessionId, eventId: event.eventId });
          } else {
            await exchange('/internal/native/event-reject', { sessionId, eventId: event.eventId, reason: 'native-question-answer-unconfirmed' });
          }
          continue;
        }
        if (event.eventType !== 'research-host:session-control') {
          pluginEvents.push(event);
          continue;
        }
        try {
          const result = await controls.apply(event.data, ctx);
          if (state !== current) return;
          if (result?.pending === true) return;
          if (result?.accepted !== true) throw new Error('native-session-control-unconfirmed');
          await exchange('/internal/native/event-acknowledge', { sessionId, eventId: event.eventId });
        } catch {
          if (state !== current) return;
          await exchange('/internal/native/event-reject', { sessionId, eventId: event.eventId, reason: 'native-session-control-unconfirmed' });
        }
      }
      if (pluginEvents.length) await plugins.consumeEvents(pluginEvents);
      for (const message of reply.data?.prompts ?? []) {
        if (state !== current) return;
        if (!await state.receipts.deliver(message)) break;
      }
    } catch {
      if (!announced && state === current && state.ctx.hasUI) {
        announced = true;
        state.ctx.ui.notify('Pi Research host is unavailable. Research dispatch status is unconfirmed.', 'warning');
      }
    } finally { state.busy = false; }
  }

  const close = () => {
    if (current) clearInterval(current.interval);
    current = undefined;
  };
  pi.on('session_start', async (_event, ctx) => {
    close();
    const state = { ctx, receipts: createNativePromptReceipts(pi, ctx, acknowledge), busy: false, mcpRegistered: false };
    state.interval = setInterval(() => void poll(state), 1500);
    state.interval.unref();
    current = state;
    try { await syncProviders(ctx); } catch { /* Local startup keeps native models when additional provider configuration is unavailable. */ }
    await poll(state);
  });
  pi.on('session_shutdown', event => {
    close();
    if (event?.reason === 'reload' || event?.reason === 'quit') releaseTranslation?.();
  });
  pi.on('message_start', event => current?.receipts.observe(event.message));
  pi.on('agent_settled', () => { if (current) setImmediate(() => { if (current) void poll(current); }); });
  registerNativePathGate(pi, { request: exchange });
}
