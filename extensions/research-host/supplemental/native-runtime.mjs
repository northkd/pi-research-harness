import { createHash } from 'node:crypto';
import { readLocalHostConfig, hostStateDir } from '../config.mjs';
import { registerFlowBridge } from './flow-bridge.mjs';
import activateAnthropicBridge from './anthropic/bridge/index.js';
import { createFlowControlAdapter } from './flow-control.mjs';
import { collectFlowFiles } from './flows/bridge/flow-files-reporter.js';

const ENTRY = 'research-host-native-event';
const INCOMING_EVENTS = new Set([
  'flow:run', 'flow:abort', 'flow:architect-abort', 'flow:toggle-autonomous',
  'flow:summary-dismissed', 'flow:set-edit-mode', 'flow:delete-request',
  'flow:rediscover', 'dashboard-flows:report-files',
]);
const ID = /^[A-Za-z0-9_.-]{1,200}$/;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Private token-authenticated loopback transport. It performs no model calls. */
export function createNativeTransport({ readAuth = () => readLocalHostConfig(hostStateDir()), fetchImpl = fetch } = {}) {
  return async (pathname, body) => {
    const auth = readAuth();
    const origin = auth.baseUrl || 'http://' + auth.bindHost + ':' + auth.port;
    const target = new URL(pathname, origin);
    if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1' || target.username || target.password || !target.pathname.startsWith('/internal/native/') || !pathname.startsWith('/internal/native/')) throw new Error('native-transport-loopback-required');
    const response = await fetchImpl(target, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'x-pi-local-token': auth.token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('native-transport-request-refused');
    let text = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 2 * 1024 * 1024) throw new Error('native-transport-response-too-large');
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  };
}

function historicalEntry(ctx, eventId) {
  const entries = ctx?.sessionManager?.getBranch?.() || [];
  return [...entries].reverse().find(entry => entry?.type === 'custom' && entry.customType === ENTRY && entry.data?.eventId === eventId)?.data;
}

/** Register once per Pi process. Hosted RPC raw events already travel via keeper. */
export async function registerNativeRuntime(pi, options) {
  if (!pi?.events || typeof options?.request !== 'function') throw new Error('native-runtime-transport-required');
  const request = options.request;
  const diagnostic = options.onDiagnostic || (() => {});
  let current;
  let disposed = false;
  let pullTimer;
  let pulling = false;
  let pending = Promise.resolve();
  const unknown = new Set();
  const executeFlow = createFlowControlAdapter(pi.events, { timeoutMs: options.effectTimeoutMs, verifyEffect: options.verifyFlowEffect });
  const sessionId = () => (options.getContext?.() || current)?.sessionManager?.getSessionId?.();
  const context = () => options.getContext?.() || current;
  const serialize = action => {
    const next = pending.catch(() => {}).then(action);
    pending = next.catch(() => {});
    return next;
  };

  function forward(event) {
    const id = sessionId();
    if (!id || disposed) return Promise.resolve(false);
    return serialize(async () => {
      if (sessionId() !== id || disposed) return false;
      try { await request('/internal/native/event', { sessionId: id, event }); return true; }
      catch { diagnostic('native-event-forward-unconfirmed'); return false; }
    });
  }

  async function consumeEvents(events) {
    if (!Array.isArray(events) || events.length > 128) throw new Error('native-events-invalid');
    return serialize(async () => {
      const ctx = context();
      const id = sessionId();
      if (!id || disposed) throw new Error('native-event-session-unavailable');
      const outcomes = [];
      for (const event of events) {
        if (sessionId() !== id || disposed) throw new Error('native-event-session-switched');
        if (!ID.test(event?.eventId || '') || !INCOMING_EVENTS.has(event.eventType) || !event.data || typeof event.data !== 'object' || Array.isArray(event.data)) throw new Error('native-event-invalid');
        const eventHash = hash({ eventType: event.eventType, data: event.data });
        if (Buffer.byteLength(JSON.stringify(event.data)) > 256 * 1024) throw new Error('native-event-too-large');
        const prior = historicalEntry(ctx, event.eventId);
        if (prior && prior.eventHash !== eventHash) throw new Error('native-event-id-conflict');
        if (prior?.status === 'accepted') {
          await request('/internal/native/event-acknowledge', { sessionId: id, eventId: event.eventId });
          outcomes.push({ eventId: event.eventId, status: 'accepted', duplicate: true });
          continue;
        }
        if (prior?.status === 'rejected') {
          await request('/internal/native/event-reject', { sessionId: id, eventId: event.eventId, reason: prior.reason });
          outcomes.push({ eventId: event.eventId, status: 'rejected', reason: prior.reason, duplicate: true });
          continue;
        }
        if (prior) {
          if (!unknown.has(event.eventId)) { diagnostic('native-event-outcome-unconfirmed'); unknown.add(event.eventId); }
          outcomes.push({ eventId: event.eventId, status: 'unconfirmed' });
          continue;
        }
        if (typeof pi.appendEntry !== 'function') throw new Error('native-event-durability-unavailable');
        let outcome;
        const received = () => pi.appendEntry(ENTRY, { eventId: event.eventId, eventHash, status: 'received' });
        try {
          if (event.eventType === 'dashboard-flows:report-files') {
            received();
            await request('/internal/native/plugin', { sessionId: id, pluginId: 'flows', name: 'flow-files/report', payload: collectFlowFiles(pi.events) });
            outcome = { status: 'accepted', observation: 'flow_files_reported' };
          } else outcome = await executeFlow(event, received);
        } catch (error) {
          diagnostic('native-event-outcome-unconfirmed');
          outcomes.push({ eventId: event.eventId, status: 'unconfirmed' });
          continue;
        }
        if (outcome.status === 'rejected') {
          pi.appendEntry(ENTRY, { eventId: event.eventId, eventHash, status: 'rejected', reason: outcome.reason });
          await request('/internal/native/event-reject', { sessionId: id, eventId: event.eventId, reason: outcome.reason });
          outcomes.push({ eventId: event.eventId, ...outcome });
          continue;
        }
        if (outcome.status !== 'accepted') {
          diagnostic('native-event-outcome-unconfirmed');
          outcomes.push({ eventId: event.eventId, ...outcome });
          continue;
        }
        pi.appendEntry(ENTRY, { eventId: event.eventId, eventHash, status: 'accepted', observation: outcome.observation });
        await request('/internal/native/event-acknowledge', { sessionId: id, eventId: event.eventId });
        outcomes.push({ eventId: event.eventId, status: 'accepted', duplicate: false });
      }
      return outcomes;
    });
  }

  async function pollEvents() {
    const id = sessionId();
    if (!id || disposed || pulling) return;
    pulling = true;
    try {
      const response = options.pullEvents
        ? await options.pullEvents(id)
        : await request('/internal/native/pull-events', { sessionId: id });
      const events = Array.isArray(response) ? response : response?.data?.events || response?.events;
      if (sessionId() === id && Array.isArray(events) && events.length) await consumeEvents(events);
    } catch { diagnostic('native-event-pull-unconfirmed'); }
    finally { pulling = false; }
  }

  pi.on('session_start', (_event, ctx) => {
    current = ctx; disposed = false;
    clearInterval(pullTimer);
    if (options.pollEvents !== false) {
      pullTimer = setInterval(() => void pollEvents(), options.pollMs || 1000);
      pullTimer.unref?.();
      void pollEvents();
    }
  });
  pi.on('session_shutdown', () => { clearInterval(pullTimer); current = undefined; disposed = true; });
  registerFlowBridge(pi, {
    requestPlugin: async (pluginId, name, payload) => {
      const id = sessionId();
      if (!id || disposed) throw new Error('native-plugin-session-unavailable');
      const reply = await request('/internal/native/plugin', { sessionId: id, pluginId, name, payload });
      return reply?.data ?? reply;
    },
    emitSnapshot: event => { void forward(event); },
  });
  if (options.activateAnthropic !== false) await activateAnthropicBridge(pi);
  if (options.forwardNativeEvents) {
    for (const name of ['agent_start', 'message_start', 'message_end', 'turn_end', 'agent_end', 'agent_settled']) {
      pi.on(name, event => { void forward({ ...event, type: name }); });
    }
  }
  return { consumeEvents, pollEvents, forwardNativeEvent: forward, flush: () => pending, dispose() { clearInterval(pullTimer); disposed = true; current = undefined; } };
}

export default async function nativeRuntime(pi) {
  if (!process.env.PI_RESEARCH_HOST_DIR) return;
  const runtime = await registerNativeRuntime(pi, {
    request: createNativeTransport(),
    forwardNativeEvents: process.env.PI_RESEARCH_HOST_MANAGED !== '1',
  });
  pi.events.on('research-host:consume-native-events', input => {
    if (!input || !Array.isArray(input.events)) return;
    input.promise = runtime.consumeEvents(input.events);
  });
}
