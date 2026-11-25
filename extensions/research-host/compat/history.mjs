import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import path from 'node:path';
import { fail, reply } from '../http.mjs';
import { openVerifiedTranscript, readTranscriptPage, readTranscriptRawWindow, readTranscriptToolResult, TRANSCRIPT_LIMITS } from '../transcript.mjs';

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const fingerprint = value => createHash('sha256').update(value).digest('hex');

export function isDetachedNativeHistory(row) {
  return row.cwdMissing === true && row.live !== true && !row.originDeviceId && row.origin?.local !== false;
}

function segment(value) {
  try { return decodeURIComponent(value); }
  catch { fail(400, 'history-path-invalid'); }
}

function query(url, allowed) {
  for (const name of url.searchParams.keys()) {
    if (!allowed.includes(name) || url.searchParams.getAll(name).length !== 1) fail(400, 'history-query-invalid');
  }
  const input = Object.fromEntries(url.searchParams);
  if (input.limit !== undefined) {
    if (!/^[1-9][0-9]*$/.test(input.limit)) fail(400, 'history-limit-invalid');
    input.limit = Number(input.limit);
  }
  if (input.cursor !== undefined && (input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor))) fail(400, 'history-cursor-invalid');
  return input;
}

function sameSubject(before, after) {
  return before.id === after.id && before.cwd === after.cwd && before.sessionFile === after.sessionFile
    && before.originDeviceId === after.originDeviceId
    && JSON.stringify(before.principalOwner ?? null) === JSON.stringify(after.principalOwner ?? null);
}

async function hasCompletionMarker(file) {
  let handle;
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const actual = await handle.stat();
    return actual.isFile() && actual.ino === info.ino && actual.dev === info.dev;
  } catch { return false; }
  finally { await handle?.close(); }
}

function eventEnvelope(sessionId, sequence, event) {
  if (typeof event.eventType === 'string' && object(event.data)) return { ...event, sessionId };
  if (typeof event.type !== 'string') fail(503, 'history-event-invalid');
  const { type, ...data } = event;
  return { sessionId, eventType: type, data, sequence };
}

function eventWindow(sessionId, sequence, event, input, subject = 'event') {
  const raw = Buffer.from(JSON.stringify(event)), maximum = input.limit ?? TRANSCRIPT_LIMITS.entryChunkBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 4 || maximum > TRANSCRIPT_LIMITS.recordBytes) fail(400, 'history-limit-invalid');
  if (!input.cursor && raw.length <= TRANSCRIPT_LIMITS.recordBytes) return event;
  const hash = fingerprint(raw);
  let offset = 0;
  if (input.cursor) {
    let cursor;
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')); }
    catch { fail(400, 'history-cursor-invalid'); }
    if (cursor?.kind !== 'event' || cursor.subject !== subject || cursor.sessionId !== sessionId || cursor.sequence !== sequence || cursor.hash !== hash
      || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > raw.length) fail(409, 'history-event-cursor-changed');
    offset = cursor.offset;
  }
  let length = Math.min(maximum, raw.length - offset), content;
  for (let dropped = 0; dropped < 4; dropped++) {
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(offset, offset + length)); break; }
    catch { length--; }
  }
  if (content === undefined || length < 0) fail(400, 'history-cursor-invalid');
  const complete = offset + length === raw.length;
  const nextCursor = complete ? null : Buffer.from(JSON.stringify({ kind: 'event', subject, sessionId, sequence, hash, offset: offset + length })).toString('base64url');
  return { sessionId, sequence, eventType: event.eventType, encoding: 'json-utf8', content, offset,
    totalBytes: raw.length, complete, nextCursor, partial: true };
}

/** Preserve the historical small-response envelopes. Large reads add opaque
 * continuations: retained entries are raw JSONL strings, exact events use raw
 * JSON windows, and tool results use lossless native entry windows. No sequence
 * or tool completion is synthesized when a real journal/result is absent. */
export function createHistoryCompatibility(options) {
  const { sessions, sessionsDir, workbench, localOperatorPrincipal, retentionDir } = options;
  if (typeof sessions?.getSession !== 'function') fail(503, 'history-session-host-required');

  async function admitted(sessionId, context) {
    if (!SESSION_ID.test(sessionId)) fail(400, 'history-session-id-invalid');
    const row = await sessions.getSession(sessionId);
    if (!row) fail(404, 'session-not-found');
    const principal = context.principal ?? localOperatorPrincipal;
    if (options.authorizeSession) {
      if (await options.authorizeSession(context, row, false) !== true) fail(404, 'session-not-found');
    } else if (principal === localOperatorPrincipal && isDetachedNativeHistory(row)) {
      const { handle } = await openVerifiedTranscript(row, { sessionsDir });
      await handle.close();
    } else {
      if (typeof workbench?.accessFor !== 'function') fail(503, 'history-access-check-required');
      const access = await workbench.accessFor(row.cwd, { principal, expiresAt: null, write: false });
      if (access.canReadHistory && !await access.canReadHistory(row)) fail(404, 'session-not-found');
      await access.revalidate?.();
    }
    return { ...row, ...(row.principalOwner ? { principalOwner: { ...row.principalOwner } } : {}) };
  }

  async function readRetained(row, input) {
    if (input.format !== undefined && input.format !== 'raw') fail(400, 'history-query-invalid');
    if (!row.originDeviceId && row.origin?.local !== false) return reply({ success: false,
      error: `session ${row.id} originated on this host; its transcript is read from its own session file, not from remote retention` }, 403);
    if (!retentionDir) return reply({ success: false, error: 'remote transcript retention is not enabled' }, 503);
    const file = path.join(path.resolve(retentionDir), row.id + '.jsonl');
    try { await lstat(file); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      return reply({ success: true, data: { entries: [], state: 'absent', nextCursor: null, partial: false } });
    }
    const marker = file + '.complete', before = await hasCompletionMarker(marker);
    const retained = { ...row, sessionFile: file };
    const readOptions = { sessionsDir: retentionDir, remoteRetention: true, rawEntries: true };
    if (input.format === 'raw') {
      const window = await readTranscriptRawWindow(retained, input, readOptions);
      return reply({ success: true, data: { ...window, state: before && await hasCompletionMarker(marker) ? 'complete' : 'incomplete' } });
    }
    const page = await readTranscriptPage(retained, input, readOptions);
    const opened = await openVerifiedTranscript(retained, readOptions);
    const header = opened.rawHeader;
    await opened.handle.close();
    const complete = before && await hasCompletionMarker(marker);
    return reply({ success: true, data: { entries: page.nextCursor ? page.entries : [header, ...page.entries],
      state: complete ? 'complete' : 'incomplete', nextCursor: page.nextCursor, partial: page.partial,
      ...(page.partial ? { rawAvailable: true } : {}),
      ...(page.nextCursor ? { header } : {}) } });
  }

  async function readEvent(row, sequence, input) {
    if (!row.originDeviceId && row.origin?.local !== false) {
      const verified = await openVerifiedTranscript(row, { sessionsDir });
      await verified.handle.close();
    }
    const record = options.readJournalEvent
      ? await options.readJournalEvent(row.id, sequence)
      : (await sessions.readEvents?.(row.id, { after: sequence - 1, limit: 1 }))?.events?.find(entry => entry.sequence === sequence);
    if (!record) return reply({ success: false, error: 'Event not found' }, 404);
    const event = record.event ?? record;
    if (!object(event)) fail(503, 'history-event-invalid');
    if (event.sessionId !== undefined && event.sessionId !== row.id) fail(409, 'history-event-identity-mismatch');
    return reply({ success: true, data: eventWindow(row.id, sequence, eventEnvelope(row.id, sequence, event), input) });
  }

  async function readToolResult(row, toolCallId, input) {
    if (!toolCallId || toolCallId.length > 256 || /[\u0000-\u001f\u007f]/.test(toolCallId)) fail(400, 'history-tool-call-id-invalid');
    if (input.pending !== undefined && input.pending !== '1') fail(400, 'history-query-invalid');
    const stored = await options.findToolEndEvent?.(row.id, toolCallId, row.status !== 'ended' ? { skipHealedBy: 'session_ended' } : undefined);
    if (stored) {
      const data = stored.data ?? stored;
      if (data.toolCallId !== undefined && data.toolCallId !== toolCallId) fail(409, 'history-tool-call-identity-mismatch');
      if (row.status === 'ended' || data.healedBy !== 'session_ended') {
        const native = { result: data.result ?? '', isError: data.isError === true };
        return reply(eventWindow(row.id, 0, native, input, 'tool-result:' + toolCallId));
      }
    }
    const result = row.sessionFile && !row.originDeviceId
      ? await readTranscriptToolResult(row, toolCallId, input, { sessionsDir }) : { status: 'not-found' };
    if (result.status === 'searching') return reply({ searching: true, partial: true, toolCallId,
      nextCursor: result.nextCursor, scannedBytes: result.scannedBytes, totalBytes: result.totalBytes }, 202);
    if (result.status === 'ready') {
      if (result.entry) return reply({ result: result.result, isError: result.isError });
      const { entry: _entry, status: _status, ...window } = result;
      return reply(window);
    }
    if (await options.wasToolEndEvicted?.(row.id, toolCallId)) return reply({ error: 'result no longer available' }, 410);
    if (input.pending === '1' && await options.isToolInFlight?.(row.id, toolCallId) === true) return reply({ pending: true }, 202);
    return reply({ error: 'tool call still in flight or unknown', ...(result.partial ? { partial: true } : {}) }, 404);
  }

  return async function historyCompatibility(context) {
    const { method, pathname, url } = context;
    if (method !== 'GET') return undefined;
    const retained = /^\/api\/sessions\/([^/]+)\/retained-transcript$/.exec(pathname);
    const event = /^\/api\/events\/([^/]+)\/([0-9]+)$/.exec(pathname);
    const tool = /^\/api\/sessions\/([^/]+)\/tool-result\/([^/]+)$/.exec(pathname);
    if (!retained && !event && !tool) return undefined;
    const input = query(url, tool ? ['pending', 'cursor', 'limit'] : retained ? ['cursor', 'limit', 'format'] : ['cursor', 'limit']);
    const sessionId = segment((retained ?? event ?? tool)[1]), row = await admitted(sessionId, context);
    let result;
    if (retained) result = await readRetained(row, input);
    else if (event) {
      const sequence = Number(event[2]);
      if (!Number.isSafeInteger(sequence) || sequence < 1) fail(400, 'history-event-sequence-invalid');
      result = await readEvent(row, sequence, input);
    } else result = await readToolResult(row, segment(tool[2]), input);
    const fresh = await admitted(sessionId, context);
    if (!sameSubject(row, fresh)) fail(409, 'history-session-changed');
    return result;
  };
}
