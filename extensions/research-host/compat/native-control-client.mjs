import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fail } from '../http.mjs';
import { CONTROL_COMMAND, nativeControlReceipt } from './native-controls.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const safeCode = value => typeof value === 'string' && /^[a-z][a-z0-9-]{1,100}$/.test(value);

/** All controls are resolved by the exact native session. Receipt reads use
 * the bounded event journal and never request the whole conversation. */
export function createNativeControlClient({ sessions, timeoutMs = 6000 } = {}) {
  async function probe(row) {
    if (typeof sessions.readEvents !== 'function') fail(501, 'native-session-control-events-unavailable');
    if (row.external) {
      if (typeof sessions.emitEventToSession !== 'function') fail(501, 'native-session-controls-unavailable');
      return;
    }
    const reply = await sessions.command(row.id, { type: 'get_commands' });
    if (reply?.success !== true || !reply.data?.commands?.some(command => command.name === CONTROL_COMMAND)) fail(501, 'native-session-controls-unavailable');
  }

  async function apply(row, action, data = {}) {
    await probe(row);
    const request = { sessionId: row.id, requestId: data.requestId ?? randomUUID(), action, ...data };
    const signature = digest(request);
    let cursor = sessions.getSession(row.id)?.eventCursor ?? 0;
    if (row.external) {
      sessions.emitEventToSession(row.id, { eventId: 'control-' + request.requestId, eventType: 'research-host:session-control', data: request });
    } else {
      const message = '/' + CONTROL_COMMAND + ' ' + Buffer.from(JSON.stringify(request)).toString('base64url');
      const accepted = await sessions.command(row.id, { type: 'prompt', message, streamingBehavior: 'steer' });
      if (accepted?.success !== true || accepted.data?.disposition !== 'handled') fail(503, 'native-session-control-unconfirmed');
    }
    const deadline = Date.now() + timeoutMs;
    do {
      const page = await sessions.readEvents(row.id, { after: cursor, limit: 200 });
      if (!Array.isArray(page?.events) || !Number.isSafeInteger(page.nextCursor)) fail(503, 'native-session-control-events-invalid');
      for (const entry of page.events) {
        const event = nativeControlReceipt(entry.event);
        if (!event || event.requestId !== request.requestId) continue;
        if (event.sessionId !== row.id || event.requestHash !== signature || event.action !== action) fail(409, 'native-session-control-receipt-conflict');
        if (event.accepted !== true) fail(409, safeCode(event.error) ? event.error : 'native-session-control-unconfirmed');
        return event;
      }
      if (page.nextCursor < cursor) fail(503, 'native-session-control-cursor-changed');
      cursor = page.nextCursor;
      if (page.events.length < 200) await delay(25);
    } while (Date.now() < deadline);
    fail(503, 'native-session-control-acceptance-unconfirmed');
  }
  return { probe, apply };
}
