import { randomBytes, randomUUID } from 'node:crypto';
import { WebSocketServer, WebSocket } from './vendor/ws/wrapper.mjs';

export const REALTIME_PROTOCOL = 'pi-research-realtime.v1';
export const REALTIME_LIMITS = Object.freeze({ messageBytes: 2 * 1024 * 1024, frameBytes: 65 * 1024 * 1024, replayBytes: 1024 * 1024, bufferedBytes: 4 * 1024 * 1024, pageEntries: 200, pagesPerTurn: 5, subscriptions: 16, connections: 64, tickets: 1024, ticketTtlMs: 30_000 });
const LOCAL_OWNERS = new Set(['urn:pi-dashboard:local-operator\u0000local-operator', 'host\u0000inert-operator']);
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,160}$/;
const DIALOGS = new Set(['select', 'confirm', 'input', 'editor']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const safeCode = error => /^[a-z0-9-]{1,120}$/.test(error?.code ?? error?.message ?? '') ? error.code ?? error.message : 'realtime-operation-unavailable';
const fail = (code, statusCode = 400) => { const error = new Error(code); error.code = code; error.statusCode = statusCode; throw error; };

function identity(value, expression, code) {
  if (typeof value !== 'string' || !expression.test(value)) fail(code);
  return value;
}

function cursor(value = 0) {
  if (!Number.isSafeInteger(value) || value < 0) fail('realtime-cursor-invalid');
  return value;
}

function sameOrigin(request) {
  if (!request.headers?.origin) return true;
  try {
    const origin = new URL(request.headers.origin);
    return ['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && origin.host === request.headers.host;
  } catch { return false; }
}

function defaultAdmission(_request, row) {
  if (row.originDeviceId || row.originDeviceID || row.origin?.deviceId || row.origin?.local === false) return false;
  const principal = row.principalOwner;
  return !principal || LOCAL_OWNERS.has(principal.iss + '\u0000' + principal.sub);
}

function uiFrame(sessionId, event) {
  const { type: _type, id, method, ...params } = event;
  return { type: 'extension_ui_request', sessionId, requestId: id, method, params };
}

function uiResponse(message, pending) {
  const response = { type: 'extension_ui_response', id: pending.id };
  if (message.cancelled === true) {
    if (message.result !== undefined || message.value !== undefined || message.confirmed !== undefined) fail('realtime-ui-answer-invalid');
    return { ...response, cancelled: true };
  }
  if (pending.method === 'confirm') {
    const confirmed = message.confirmed ?? message.result;
    if (typeof confirmed !== 'boolean' || message.value !== undefined) fail('realtime-ui-answer-invalid');
    return { ...response, confirmed };
  }
  const value = message.value ?? message.result;
  if (typeof value !== 'string' || value.length > 128 * 1024 || message.confirmed !== undefined) fail('realtime-ui-answer-invalid');
  if (pending.method === 'select' && Array.isArray(pending.options) && !pending.options.includes(value)) fail('realtime-ui-selection-invalid');
  return { ...response, value };
}

/** Browser replay uses the same durable sequence as the native session host. */
export function createRealtimeAdapter({ server, authenticate, sessions, authorizeSession = defaultAdmission, getMessages, handleExtraMessage, extraMessageTypes = [], onDisconnect, onError = () => {}, now = () => Date.now(), limits = {}, WebSocketServerImpl = WebSocketServer } = {}) {
  if (!server?.on || typeof authenticate !== 'function' || typeof sessions?.readEvents !== 'function' || typeof sessions?.getSession !== 'function' || typeof sessions?.subscribeEvents !== 'function') fail('realtime-host-contract-required');
  const bound = { ...REALTIME_LIMITS, ...limits };
  if (!Array.isArray(extraMessageTypes) || extraMessageTypes.some(type => typeof type !== 'string' || !/^[a-z][a-z0-9_-]{0,79}$/.test(type))) fail('realtime-extra-message-types-invalid');
  const websocket = new WebSocketServerImpl({ noServer: true, maxPayload: bound.messageBytes, perMessageDeflate: false });
  const clients = new Set(), tickets = new Map();
  let disposed = false;

  const send = (client, value) => {
    if (client.socket.readyState !== WebSocket.OPEN) return false;
    if (client.socket.bufferedAmount > bound.bufferedBytes) { client.socket.close(1013, 'reconnect-for-replay'); return false; }
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > bound.frameBytes) fail('realtime-output-too-large');
    client.socket.send(bytes);
    return true;
  };
  const sendError = (client, error, request) => {
    const code = safeCode(error);
    if ((error?.statusCode ?? 0) >= 500) onError(code);
    send(client, { type: 'error', success: false, code, error: code,
      ...(REQUEST_ID.test(request?.requestId ?? '') ? { requestId: request.requestId } : {}),
      ...(SESSION_ID.test(request?.sessionId ?? '') ? { sessionId: request.sessionId } : {}),
    });
  };
  const admitted = async (client, sessionId, write = false) => {
    identity(sessionId, SESSION_ID, 'realtime-session-id-invalid');
    const row = await sessions.getSession(sessionId);
    if (!row || await authorizeSession(client.request, row, write) !== true) fail('realtime-session-not-found', 404);
    return row;
  };

  function pruneTickets() {
    for (const [value, ticket] of tickets) if (ticket.expiresAt <= now()) tickets.delete(value);
  }

  async function mintTicket(request, body = { scope: 'browser' }) {
    if (disposed) fail('realtime-host-closed', 503);
    if (!object(body) || body.scope !== 'browser' || Object.keys(body).some(key => key !== 'scope')) fail('realtime-ticket-scope-invalid');
    if (!sameOrigin(request) || await authenticate(request) !== true) fail('research-host-auth-required', 401);
    pruneTickets();
    if (tickets.size >= bound.tickets) fail('realtime-ticket-capacity', 429);
    const ticket = randomBytes(32).toString('base64url'), expiresAt = now() + bound.ticketTtlMs;
    tickets.set(ticket, { expiresAt, address: request.socket.remoteAddress, origin: request.headers.origin ?? null, host: request.headers.host });
    return { success: true, ticket, scope: 'browser', expiresAt: new Date(expiresAt).toISOString() };
  }

  async function snapshot(client, subscription) {
    const row = await admitted(client, subscription.sessionId);
    const messages = typeof getMessages === 'function' ? await getMessages(subscription.sessionId) : undefined;
    if (client.subscriptions.get(subscription.sessionId) !== subscription) return;
    await admitted(client, subscription.sessionId);
    send(client, { type: 'session_updated', session: row });
    send(client, { type: 'session_snapshot', sessionId: row.id, cursor: subscription.cursor,
      ...(messages === undefined ? {} : { messages }),
      pendingUIRequests: row.pendingUIRequests ?? [],
    });
    for (const request of row.pendingUIRequests ?? []) {
      if (request?.type === 'extension_ui_request' && DIALOGS.has(request.method)) send(client, uiFrame(row.id, request));
    }
  }

  function sideEvent(client, sessionId, event) {
    if (event.type === 'extension_ui_request') send(client, uiFrame(sessionId, event));
    if (event.type === 'extension_ui_resolved') send(client, { type: 'ui_dismiss', sessionId, requestId: event.id });
  }

  function sendReplay(client, sessionId, records, isLast) {
    let group = [], bytes = 0;
    for (const record of records) {
      const recordBytes = Buffer.byteLength(JSON.stringify(record));
      if (group.length && bytes + recordBytes > bound.replayBytes) {
        if (!send(client, { type: 'event_replay', sessionId, events: group, isLast: false })) return false;
        group = []; bytes = 0;
      }
      group.push(record); bytes += recordBytes;
    }
    return send(client, { type: 'event_replay', sessionId, events: group, isLast });
  }

  async function drain(client, subscription) {
    if (subscription.draining || disposed) return;
    subscription.draining = true;
    let more = false;
    try {
      for (let page = 0; page < bound.pagesPerTurn; page++) {
        await admitted(client, subscription.sessionId);
        if (client.subscriptions.get(subscription.sessionId) !== subscription) return;
        const result = await sessions.readEvents(subscription.sessionId, { after: subscription.cursor, limit: bound.pageEntries });
        if (!Array.isArray(result?.events) || result.events.length > bound.pageEntries) fail('realtime-event-page-invalid', 503);
        if (result.lastSequence !== undefined && (!Number.isSafeInteger(result.lastSequence) || result.lastSequence < subscription.cursor)) fail('realtime-cursor-ahead-of-history', 409);
        const records = result.events.map(entry => {
          if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= subscription.cursor || !object(entry.event)) fail('realtime-event-cursor-invalid', 503);
          subscription.cursor = entry.sequence;
          return { seq: entry.sequence, event: entry.event };
        });
        if (result.nextCursor !== subscription.cursor) fail('realtime-event-cursor-invalid', 503);
        await admitted(client, subscription.sessionId);
        if (client.subscriptions.get(subscription.sessionId) !== subscription) return;
        more = records.length === bound.pageEntries;
        if (subscription.replaying) {
          if (!sendReplay(client, subscription.sessionId, records, !more)) return;
        } else {
          for (const record of records) {
            if (!send(client, { type: 'event', sessionId: subscription.sessionId, ...record })) return;
            sideEvent(client, subscription.sessionId, record.event);
          }
        }
        if (!more) {
          if (subscription.replaying) { subscription.replaying = false; await snapshot(client, subscription); }
          break;
        }
      }
    } catch (error) {
      client.subscriptions.delete(subscription.sessionId);
      sendError(client, error, { sessionId: subscription.sessionId });
    } finally {
      subscription.draining = false;
      if (more && client.subscriptions.get(subscription.sessionId) === subscription) setImmediate(() => { void drain(client, subscription); });
    }
  }

  function publish(sessionId) {
    for (const client of clients) {
      const subscription = client.subscriptions.get(sessionId);
      if (subscription) void drain(client, subscription);
    }
  }

  async function publishTransient(sessionId, frame, current = () => true) {
    await Promise.all([...clients].flatMap(client => {
      const subscription = client.subscriptions.get(sessionId);
      if (!subscription || subscription.replaying) return [];
      return [admitted(client, sessionId).then(() => {
        if (client.subscriptions.get(sessionId) === subscription && current()) send(client, frame);
      }).catch(() => { /* A closed or no-longer-authorized subscription has no display recipient. */ })];
    }));
  }

  async function handle(client, message) {
    if (!object(message) || typeof message.type !== 'string') fail('realtime-message-invalid');
    if (message.requestId !== undefined) identity(message.requestId, REQUEST_ID, 'realtime-request-id-invalid');
    if (message.type === 'subscribe' || message.type === 'resync') {
      const row = await admitted(client, message.sessionId);
      if (!client.subscriptions.has(row.id) && client.subscriptions.size >= bound.subscriptions) fail('realtime-subscription-capacity', 429);
      const subscription = { sessionId: row.id, cursor: cursor(message.lastSeq), replaying: true, draining: false };
      client.subscriptions.set(row.id, subscription);
      await drain(client, subscription);
      return;
    }
    if (message.type === 'unsubscribe') {
      identity(message.sessionId, SESSION_ID, 'realtime-session-id-invalid');
      client.subscriptions.delete(message.sessionId);
      return;
    }
    if (!['send_prompt', 'extension_ui_response', 'abort'].includes(message.type)) {
      if (message.sessionId !== undefined) await admitted(client, message.sessionId, true);
      const handled = typeof handleExtraMessage === 'function' && await handleExtraMessage(message, client.context);
      if (handled === true) return;
      fail('realtime-message-unsupported', 501);
    }
    const row = await admitted(client, message.sessionId, true);
    if (message.type === 'send_prompt') {
      if (typeof message.text !== 'string' || !message.text.trim() || message.text.length > 128 * 1024 || message.delivery !== undefined && !['steer', 'followUp'].includes(message.delivery)) fail('realtime-prompt-invalid');
      if (message.images !== undefined && (!Array.isArray(message.images) || message.images.length > 16 || message.images.some(image => !object(image) || image.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string'))) fail('realtime-prompt-invalid');
      const promptId = identity(message.promptId ?? message.requestId ?? randomUUID(), REQUEST_ID, 'realtime-prompt-id-invalid');
      const result = await sessions.deliverPrompt(row.id, { text: message.text, images: message.images, promptId, delivery: message.delivery ?? 'followUp' });
      if (result?.accepted !== true) fail('realtime-prompt-acceptance-unconfirmed', 503);
      send(client, { type: 'prompt_result', sessionId: row.id, promptId, requestId: message.requestId, success: true, accepted: true });
      publish(row.id);
      return;
    }
    if (message.type === 'extension_ui_response') {
      const requestId = identity(message.requestId, REQUEST_ID, 'realtime-ui-request-id-invalid');
      const pending = (row.pendingUIRequests ?? []).find(request => request.id === requestId && DIALOGS.has(request.method));
      if (!pending) fail('session-ui-request-not-pending', 409);
      const result = await sessions.respondUI(row.id, uiResponse(message, pending));
      if (result?.accepted !== true) fail('realtime-ui-acceptance-unconfirmed', 503);
      send(client, { type: 'extension_ui_response_result', sessionId: row.id, requestId, success: true, accepted: true });
      publish(row.id);
      return;
    }
    if (message.type === 'abort') {
      const result = await sessions.abort(row.id);
      if (result?.success !== true) fail('realtime-abort-unconfirmed', 503);
      send(client, { type: 'command_result', command: 'abort', sessionId: row.id, requestId: message.requestId, success: true });
      publish(row.id);
      return;
    }
  }

  websocket.on('connection', (socket, request) => {
    if (clients.size >= bound.connections) { socket.close(1013, 'connection-capacity'); return; }
    const client = { socket, request, subscriptions: new Map(), chain: Promise.resolve() };
    const gatewaySocket = { principal: request.principal, principalExpiresAt: request.principalExpiresAt,
      get readyState() { return socket.readyState; }, get bufferedAmount() { return socket.bufferedAmount; },
      send(value) {
        if (typeof value !== 'string' || Buffer.byteLength(value) > bound.frameBytes) fail('realtime-output-too-large');
        if (socket.readyState === WebSocket.OPEN && socket.bufferedAmount <= bound.bufferedBytes) socket.send(value);
      },
    };
    client.context = { request, send: value => send(client, value), sessionId: undefined, socket: gatewaySocket };
    clients.add(client);
    socket.on('close', () => {
      clients.delete(client); client.subscriptions.clear();
      try { Promise.resolve(onDisconnect?.(client.context)).catch(error => onError(safeCode(error))); } catch (error) { onError(safeCode(error)); }
    });
    socket.on('error', () => {});
    socket.on('message', (bytes, binary) => {
      client.chain = client.chain.then(async () => {
        let message;
        try {
          if (binary || Buffer.byteLength(bytes) > bound.messageBytes) fail('realtime-message-invalid');
          try { message = JSON.parse(bytes.toString('utf8')); } catch { fail('realtime-message-invalid'); }
          client.context.sessionId = message.sessionId;
          await handle(client, message);
        } catch (error) { sendError(client, error, message); }
      }).catch(error => { onError(safeCode(error)); socket.close(1011, 'realtime-unavailable'); });
    });
    send(client, { type: 'host_capabilities', protocol: REALTIME_PROTOCOL, features: { durableReplay: true, nativeUiDialogs: true, promptIds: true },
      messages: ['subscribe', 'resync', 'unsubscribe', 'send_prompt', 'extension_ui_response', 'abort', ...extraMessageTypes],
      unavailable: ['terminal-component-widgets'],
    });
  });

  const upgrade = (request, socket, head) => {
    void (async () => {
      let target;
      if (typeof request.url !== 'string' || !request.url.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192) fail('realtime-upgrade-refused', 401);
      try { target = new URL(request.url, 'http://127.0.0.1'); } catch { return; }
      if (target.pathname !== '/ws') return;
      if (disposed || !sameOrigin(request) || request.method !== 'GET' || target.username || target.password || [...target.searchParams.keys()].some(key => key !== 'ticket')) fail('realtime-upgrade-refused', 401);
      let valid = false;
      const ticketValue = target.searchParams.get('ticket');
      if (ticketValue !== null) {
        pruneTickets();
        const ticket = tickets.get(ticketValue); tickets.delete(ticketValue);
        valid = target.searchParams.getAll('ticket').length === 1 && ticket && ticket.address === request.socket.remoteAddress && ticket.host === request.headers.host && ticket.origin === (request.headers.origin ?? null) && ticket.expiresAt > now();
      } else valid = await authenticate(request) === true;
      if (!valid) fail('research-host-auth-required', 401);
      if (clients.size >= bound.connections) fail('realtime-connection-capacity', 429);
      websocket.handleUpgrade(request, socket, head, ws => websocket.emit('connection', ws, request));
    })().catch(error => {
      const status = error.statusCode === 429 ? 429 : 401;
      socket.end(`HTTP/1.1 ${status} ${status === 429 ? 'Too Many Requests' : 'Unauthorized'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
  };
  server.on('upgrade', upgrade);
  const unsubscribe = sessions.subscribeEvents(sessionId => publish(sessionId));
  const refresh = setInterval(() => { for (const client of clients) for (const subscription of client.subscriptions.values()) void drain(client, subscription); }, 1000);
  refresh.unref?.();

  return { protocol: REALTIME_PROTOCOL, mintTicket, publish, publishTransient,
    dispose() {
      if (disposed) return;
      disposed = true; clearInterval(refresh); unsubscribe?.(); tickets.clear(); server.off('upgrade', upgrade);
      const closing = [...clients];
      for (const client of closing) client.socket.close(1001, 'host-stopping');
      const forceClose = setTimeout(() => { for (const client of closing) client.socket.terminate(); }, 500);
      forceClose.unref?.();
      clients.clear(); websocket.close();
    },
  };
}
