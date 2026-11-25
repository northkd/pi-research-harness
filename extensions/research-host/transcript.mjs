import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const TRANSCRIPT_LIMITS = Object.freeze({
  defaultEntries: 50,
  maxEntries: 200,
  headerBytes: 64 * 1024,
  scanBytes: 1024 * 1024,
  recordBytes: 128 * 1024,
  responseBytes: 512 * 1024,
  entryChunkBytes: 64 * 1024,
  indexEntries: 100000,
  cachedIndexes: 4,
});

const digest = value => createHash('sha256').update(value).digest('hex');

function fail(code, statusCode = 400) {
  const error = new Error(code);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}

async function validatePath(file, root) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || !file.endsWith('.jsonl')) fail('transcript-path-invalid');
  const canonicalRoot = await realpath(root);
  const relative = path.relative(canonicalRoot, file);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) fail('transcript-path-invalid');
  let current = canonicalRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (info.isSymbolicLink()) fail('transcript-path-invalid');
    if (current !== file && !info.isDirectory()) fail('transcript-path-invalid');
  }
  if (await realpath(file) !== file) fail('transcript-path-invalid');
}

async function readAt(handle, position, length) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const next = await handle.read(buffer, read, length - read, position + read);
    if (next.bytesRead === 0) break;
    read += next.bytesRead;
  }
  return buffer.subarray(0, read);
}

function decodeJson(bytes) {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function decodeCursor(value, fingerprint, headerEnd, size) {
  if (value === undefined || value === null || value === '') return { offset: size, size, dropping: false };
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('transcript-cursor-invalid');
  let cursor;
  try { cursor = decodeJson(Buffer.from(value, 'base64url')); }
  catch { fail('transcript-cursor-invalid'); }
  if (cursor?.version !== 1 || cursor.file !== fingerprint || !Number.isSafeInteger(cursor.offset)
      || !Number.isSafeInteger(cursor.size) || cursor.offset < headerEnd || cursor.offset > cursor.size
      || cursor.size > size || typeof cursor.dropping !== 'boolean' || !/^[a-f0-9]{64}$/.test(cursor.anchor ?? '')) fail('transcript-cursor-invalid');
  return cursor;
}

async function cursorAnchor(handle, offset, headerEnd) {
  const start = Math.max(headerEnd, offset - 64);
  return digest(await readAt(handle, start, offset - start));
}

async function encodeCursor(handle, fingerprint, offset, snapshotSize, dropping, headerEnd) {
  if (offset <= headerEnd) return null;
  const cursor = { version: 1, file: fingerprint, offset, size: snapshotSize, dropping,
    anchor: await cursorAnchor(handle, offset, headerEnd) };
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

async function openTranscript(row, { sessionsDir, remoteRetention = false } = {}) {
  if (typeof row?.id !== 'string' || !row.id || typeof row.cwd !== 'string' || !path.isAbsolute(row.cwd)) fail('transcript-identity-mismatch', 409);
  const root = sessionsDir ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), '.pi', 'agent'), 'sessions');
  await validatePath(row.sessionFile, root);
  if (!remoteRetention) {
    try { if (await realpath(row.cwd) !== row.cwd) fail('transcript-identity-mismatch', 409); }
    catch (error) {
      // Native history remains readable after its original project directory is
      // removed. The original absolute cwd is still checked against the header.
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const handle = await open(row.sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.nlink !== 1 || !Number.isSafeInteger(info.size)) fail('transcript-file-invalid', 409);
    const prefix = await readAt(handle, 0, Math.min(info.size, TRANSCRIPT_LIMITS.headerBytes));
    const newline = prefix.indexOf(10);
    if (newline < 0) fail('transcript-header-invalid', 409);
    let header;
    try { header = decodeJson(prefix.subarray(0, newline)); }
    catch { fail('transcript-header-invalid', 409); }
    if (header?.type !== 'session' || header.id !== row.id || header.cwd !== row.cwd) fail('transcript-identity-mismatch', 409);
    const fingerprint = digest(JSON.stringify([String(info.dev), String(info.ino), header.id, header.cwd, header.timestamp]));
    return { handle, info, header, rawHeader: prefix.subarray(0, newline).toString('utf8'), headerEnd: newline + 1, fingerprint };
  } catch (error) {
    await handle.close();
    throw error;
  }
}

export const openVerifiedTranscript = openTranscript;

/** Forward, byte-bounded raw JSONL windows retain giant records verbatim. */
export async function readTranscriptRawWindow(row, { cursor, limit = TRANSCRIPT_LIMITS.entryChunkBytes } = {}, options = {}) {
  if (!Number.isSafeInteger(limit) || limit < 4 || limit > TRANSCRIPT_LIMITS.recordBytes) fail('transcript-limit-invalid');
  let handle;
  try {
    const opened = await openTranscript(row, options);
    ({ handle } = opened);
    const { info, fingerprint, headerEnd } = opened;
    let offset = 0, size = info.size, anchor = await cursorAnchor(handle, size, headerEnd);
    if (cursor) {
      if (typeof cursor !== 'string' || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) fail('transcript-raw-cursor-invalid');
      let value;
      try { value = decodeJson(Buffer.from(cursor, 'base64url')); }
      catch { fail('transcript-raw-cursor-invalid'); }
      if (value?.version !== 1 || value.kind !== 'raw-transcript' || value.file !== fingerprint
        || !Number.isSafeInteger(value.offset) || !Number.isSafeInteger(value.size) || value.offset < 0 || value.offset > value.size
        || value.size < headerEnd || value.size > info.size || !/^[a-f0-9]{64}$/.test(value.anchor ?? '')
        || await cursorAnchor(handle, value.size, headerEnd) !== value.anchor) fail('transcript-raw-cursor-invalid');
      ({ offset, size, anchor } = value);
    }
    const raw = await readAt(handle, offset, Math.min(limit, size - offset));
    let content, length = raw.length;
    for (let dropped = 0; dropped < 4; dropped++) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, length)); break; }
      catch { length--; }
    }
    if (content === undefined || length < 0) fail('transcript-raw-cursor-invalid');
    await verifyReadSnapshot(handle, row, info, headerEnd, info.size === size ? anchor : undefined);
    const complete = offset + length === size;
    const nextCursor = complete ? null : Buffer.from(JSON.stringify({ version: 1, kind: 'raw-transcript', file: fingerprint,
      offset: offset + length, size, anchor })).toString('base64url');
    return { encoding: 'jsonl-utf8', content, offset, totalBytes: size, complete, nextCursor, partial: !complete };
  } catch (error) {
    if (error?.code?.startsWith('transcript-')) throw error;
    fail(error?.code === 'ENOENT' ? 'transcript-not-found' : 'transcript-read-unavailable', error?.code === 'ENOENT' ? 404 : 503);
  } finally { await handle?.close(); }
}

async function verifyReadSnapshot(handle, row, before, headerEnd, anchor) {
  const after = await handle.stat();
  const named = await lstat(row.sessionFile);
  if (after.ino !== before.ino || after.dev !== before.dev || after.size < before.size || named.isSymbolicLink()
      || named.ino !== before.ino || named.dev !== before.dev
      || after.size === before.size && (after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)) fail('transcript-file-changed', 409);
  if (anchor && await cursorAnchor(handle, before.size, headerEnd) !== anchor) fail('transcript-file-changed', 409);
}

/** Newest-page first, with records within each page in original order. */
export async function readTranscriptPage(row, { cursor, limit = TRANSCRIPT_LIMITS.defaultEntries } = {}, options = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > TRANSCRIPT_LIMITS.maxEntries) fail('transcript-limit-invalid');
  let handle;
  try {
    const opened = await openTranscript(row, options);
    ({ handle } = opened);
    const { info, headerEnd, fingerprint } = opened;
    const position = decodeCursor(cursor, fingerprint, headerEnd, info.size);
    if (position.anchor && await cursorAnchor(handle, position.offset, headerEnd) !== position.anchor) fail('transcript-cursor-invalid');
    if (position.offset === headerEnd) return { entries: [], nextCursor: null, partial: false };

    const start = Math.max(headerEnd, position.offset - TRANSCRIPT_LIMITS.scanBytes);
    const buffer = await readAt(handle, start, position.offset - start);
    if (buffer.length !== position.offset - start) fail('transcript-file-changed', 409);
    let end = buffer.length;
    let partial = position.dropping;
    // An active append can stop in the middle of a JSON record or UTF-8 codepoint.
    if (end && buffer[end - 1] !== 10) {
      partial = true;
      const lastNewline = buffer.lastIndexOf(10);
      if (lastNewline < 0) {
        return { entries: [], nextCursor: await encodeCursor(handle, fingerprint, start, position.size, true, headerEnd), partial };
      }
      end = lastNewline + 1;
    }

    const atBoundary = start === headerEnd || (await readAt(handle, start - 1, 1))[0] === 10;
    const firstNewline = atBoundary ? -1 : buffer.indexOf(10);
    const parseStart = atBoundary ? 0 : firstNewline + 1;
    if (!atBoundary && (firstNewline < 0 || parseStart >= end)) {
      return { entries: [], nextCursor: await encodeCursor(handle, fingerprint, start, position.size, true, headerEnd), partial: true };
    }

    const entries = [];
    let outputBytes = 2;
    let boundary = end;
    while (boundary > parseStart) {
      const previousNewline = buffer.lastIndexOf(10, boundary - 2);
      const lineStart = Math.max(parseStart, previousNewline + 1);
      const line = buffer.subarray(lineStart, boundary - 1);
      if (entries.length >= limit || entries.length && outputBytes + line.length + 1 > TRANSCRIPT_LIMITS.responseBytes) break;
      const lineEnd = boundary;
      boundary = lineStart;
      if (!line.length) continue;
      if (line.length > TRANSCRIPT_LIMITS.recordBytes) { partial = true; continue; }
      try {
        const entry = decodeJson(line);
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { partial = true; continue; }
        const output = options.rawEntries ? line.toString('utf8') : entry;
        const recordBytes = Buffer.byteLength(JSON.stringify(output));
        if (recordBytes > TRANSCRIPT_LIMITS.recordBytes) { partial = true; continue; }
        if (entries.length && outputBytes + recordBytes + 1 > TRANSCRIPT_LIMITS.responseBytes) { boundary = lineEnd; break; }
        entries.push(output);
        outputBytes += recordBytes + 1;
      } catch { partial = true; }
    }
    const nextOffset = start + boundary;
    await verifyReadSnapshot(handle, row, info, headerEnd);
    return { entries: entries.reverse(), nextCursor: await encodeCursor(handle, fingerprint, nextOffset, position.size, false, headerEnd), partial };
  } catch (error) {
    if (error?.code?.startsWith('transcript-')) throw error;
    fail(error?.code === 'ENOENT' ? 'transcript-not-found' : 'transcript-read-unavailable', error?.code === 'ENOENT' ? 404 : 503);
  } finally {
    await handle?.close();
  }
}

const entryIndexes = new Map();
const metadataFields = new Set(['id', 'parentId', 'type', 'customType', 'entryId']);

function metadataScanner() {
  return { depth: 0, inString: false, escaped: false, expectsKey: true, key: undefined,
    capture: undefined, stringKind: undefined, invalid: false, metadata: {},
    correlation: { stack: [], inString: false, escaped: false, capture: undefined, path: undefined, stringKind: undefined, metadata: {} } };
}

function scanToolCorrelation(scanner, byte) {
  if (scanner.invalid) return;
  if (scanner.inString) {
    if (scanner.capture && scanner.capture.length < 4096) scanner.capture.push(byte);
    else scanner.capture = undefined;
    if (scanner.escaped) { scanner.escaped = false; return; }
    if (byte === 92) { scanner.escaped = true; return; }
    if (byte !== 34) return;
    scanner.inString = false;
    if (scanner.capture) {
      let value;
      try { value = decodeJson(Buffer.from(scanner.capture)); } catch { return; }
      const current = scanner.stack.at(-1);
      if (scanner.stringKind === 'key') { current.key = value; current.expectsKey = false; }
      else if (scanner.path === 'message.role') scanner.metadata.messageRole = value;
      else if (scanner.path === 'message.toolCallId') scanner.metadata.toolCallId = value;
      else if (scanner.path === 'message.toolName') scanner.metadata.toolName = value;
    }
    scanner.capture = undefined;
    return;
  }
  const current = scanner.stack.at(-1);
  if (byte === 34) {
    scanner.inString = true;
    scanner.stringKind = current?.kind === 'object' && current.expectsKey ? 'key' : 'value';
    if (scanner.stringKind === 'key') current.key = undefined;
    scanner.path = current?.path ? current.path + '.' + current.key : current?.key;
    if (scanner.stringKind === 'key' || ['message.role', 'message.toolCallId', 'message.toolName'].includes(scanner.path)) scanner.capture = [34];
  } else if (byte === 123 || byte === 91) {
    if (scanner.stack.length >= 128) { scanner.invalid = true; scanner.metadata = {}; return; }
    const valuePath = current?.path ? current.path + '.' + current.key : current?.key;
    scanner.stack.push({ kind: byte === 123 ? 'object' : 'array', expectsKey: true, key: undefined, path: valuePath });
  } else if (byte === 125 || byte === 93) scanner.stack.pop();
  else if (byte === 44 && current?.kind === 'object') { current.expectsKey = true; current.key = undefined; }
}

// Keep only root identity/parent fields while walking arbitrarily large payloads.
function scanMetadata(scanner, byte) {
  scanToolCorrelation(scanner.correlation, byte);
  if (scanner.inString) {
    if (scanner.capture) {
      if (scanner.capture.length < 4096) scanner.capture.push(byte);
      else { scanner.capture = undefined; scanner.invalid = true; }
    }
    if (scanner.escaped) { scanner.escaped = false; return; }
    if (byte === 92) { scanner.escaped = true; return; }
    if (byte !== 34) return;
    scanner.inString = false;
    if (scanner.capture) {
      try {
        const value = decodeJson(Buffer.from(scanner.capture));
        if (scanner.stringKind === 'key') scanner.key = value;
        else if (metadataFields.has(scanner.key)) scanner.metadata[scanner.key] = value;
      } catch { scanner.invalid = true; }
    }
    if (scanner.stringKind === 'key') scanner.expectsKey = false;
    scanner.capture = undefined;
    scanner.stringKind = undefined;
    return;
  }
  if (byte === 34) {
    scanner.inString = true;
    scanner.stringKind = scanner.depth === 1 ? (scanner.expectsKey ? 'key' : 'value') : undefined;
    if (scanner.stringKind === 'key' || scanner.stringKind === 'value' && metadataFields.has(scanner.key)) scanner.capture = [34];
    return;
  }
  if (byte === 123 || byte === 91) { scanner.depth++; return; }
  if (byte === 125 || byte === 93) { scanner.depth--; if (scanner.depth < 0) scanner.invalid = true; return; }
  if (byte === 44 && scanner.depth === 1) { scanner.expectsKey = true; scanner.key = undefined; }
}

function entryCursor(index, entryId, phase, offset = 0) {
  return Buffer.from(JSON.stringify({ version: 1, kind: 'entry', token: index.token, entryId, phase, offset })).toString('base64url');
}

function decodeEntryCursor(value, entryId) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('transcript-entry-cursor-invalid');
  let parsed;
  try { parsed = decodeJson(Buffer.from(value, 'base64url')); }
  catch { fail('transcript-entry-cursor-invalid'); }
  if (parsed?.version !== 1 || parsed.kind !== 'entry' || parsed.entryId !== entryId
      || !['search', 'content'].includes(parsed.phase) || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0
      || typeof parsed.token !== 'string') fail('transcript-entry-cursor-invalid');
  return parsed;
}

function currentBranchContains(index, entryId) {
  let current = index.records.get(index.explicitLeaf ?? index.leaf);
  if (!current) return index.records.has(entryId);
  const visited = new Set();
  let found = false;
  while (current) {
    if (visited.has(current.id)) return index.records.has(entryId); // Native reader's cycle fallback is linear order.
    visited.add(current.id);
    if (current.id === entryId) found = true;
    current = current.parentId ? index.records.get(current.parentId) : undefined;
  }
  return found;
}

async function advanceEntryIndex(index, handle) {
  if (index.pending) return index.pending;
  index.pending = (async () => {
    const length = Math.min(TRANSCRIPT_LIMITS.scanBytes, index.size - index.offset);
    const bytes = await readAt(handle, index.offset, length);
    if (bytes.length !== length) fail('transcript-file-changed', 409);
    for (let position = 0; position < bytes.length; position++) {
      if (bytes[position] !== 10) { scanMetadata(index.scanner, bytes[position]); continue; }
      const end = index.offset + position + 1;
      const { metadata, depth, inString, invalid } = index.scanner;
      if (index.scanner.correlation.invalid) index.partial = true;
      if (!invalid && !inString && depth === 0) {
        if (typeof metadata.id === 'string' && metadata.id && metadata.type !== 'session') {
          if (index.records.size >= TRANSCRIPT_LIMITS.indexEntries && !index.records.has(metadata.id)) fail('transcript-index-limit', 413);
          index.records.set(metadata.id, { ...metadata, ...index.scanner.correlation.metadata, start: index.lineStart, end: end - 1 });
          index.leaf = metadata.id;
        }
        if (metadata.type === 'leaf' && typeof metadata.entryId === 'string') index.explicitLeaf = metadata.entryId;
      } else index.partial = true;
      index.lineStart = end;
      index.scanner = metadataScanner();
    }
    index.offset += length;
    index.complete = index.offset === index.size;
    if (index.complete && index.lineStart !== index.size) index.partial = true;
  })().finally(() => { index.pending = undefined; });
  return index.pending;
}

async function obtainEntryIndex(opened, continuation) {
  const { handle, fingerprint, headerEnd, info } = opened;
  let index = continuation ? entryIndexes.get(continuation.token) : [...entryIndexes.values()].find(value => value.file === fingerprint && value.size === info.size);
  if (continuation && !index) fail('transcript-entry-cursor-expired', 410);
  if (index && info.size === index.size && (info.mtimeMs !== index.mtime || info.ctimeMs !== index.ctime)) {
    entryIndexes.delete(index.token);
    if (continuation) fail('transcript-entry-cursor-invalid');
    index = undefined;
  }
  if (!index) {
    const anchor = await cursorAnchor(handle, info.size, headerEnd);
    if (entryIndexes.size >= TRANSCRIPT_LIMITS.cachedIndexes) entryIndexes.delete(entryIndexes.keys().next().value);
    index = { token: randomUUID(), file: fingerprint, size: info.size, offset: headerEnd, lineStart: headerEnd,
      mtime: info.mtimeMs, ctime: info.ctimeMs, anchor, records: new Map(), scanner: metadataScanner(), complete: false, partial: false };
    entryIndexes.set(index.token, index);
  }
  if (index.file !== fingerprint || info.size < index.size || await cursorAnchor(handle, index.size, headerEnd) !== index.anchor) fail('transcript-entry-cursor-invalid');
  return index;
}

/** Exact native entry lookup, followed by bounded raw JSON content chunks. */
export async function readTranscriptEntry(row, entryId, { cursor, limit = TRANSCRIPT_LIMITS.entryChunkBytes } = {}, options = {}) {
  if (typeof entryId !== 'string' || !entryId || entryId.length > 256 || /[/\\]/.test(entryId) || entryId.includes('..')) fail('transcript-entry-id-invalid', 404);
  if (!Number.isSafeInteger(limit) || limit < 4 || limit > TRANSCRIPT_LIMITS.recordBytes) fail('transcript-limit-invalid');
  const continuation = decodeEntryCursor(cursor, entryId);
  let handle;
  try {
    const opened = await openTranscript(row, options);
    ({ handle } = opened);
    const { headerEnd, info } = opened;
    const index = await obtainEntryIndex(opened, continuation);
    if (!index.complete) await advanceEntryIndex(index, handle);
    await verifyReadSnapshot(handle, row, info, headerEnd, info.size === index.size ? index.anchor : undefined);
    if (!index.complete) return { status: 'searching', entryId, scannedBytes: index.offset, totalBytes: index.size,
      entries: [], nextCursor: entryCursor(index, entryId, 'search'), partial: true };
    const record = index.records.get(entryId);
    if (!record || !currentBranchContains(index, entryId)) return { status: 'not-found', entryId, complete: true, nextCursor: null, partial: index.partial };
    const totalBytes = record.end - record.start;
    if (totalBytes <= TRANSCRIPT_LIMITS.recordBytes) {
      let entry;
      try { entry = decodeJson(await readAt(handle, record.start, totalBytes)); }
      catch { fail('transcript-entry-invalid', 409); }
      if (entry.id !== entryId) fail('transcript-entry-invalid', 409);
      if (Buffer.byteLength(JSON.stringify(entry)) <= TRANSCRIPT_LIMITS.recordBytes) {
        await verifyReadSnapshot(handle, row, info, headerEnd, info.size === index.size ? index.anchor : undefined);
        return { status: 'ready', entryId, entry, complete: true, nextCursor: null, partial: index.partial };
      }
    }
    const offset = continuation?.phase === 'content' ? continuation.offset : 0;
    if (offset > totalBytes) fail('transcript-entry-cursor-invalid');
    if (offset === totalBytes) return { status: 'ready', entryId, type: record.type, customType: record.customType,
      encoding: 'jsonl-utf8', content: '', offset, totalBytes, complete: true, nextCursor: null, partial: true };
    const raw = await readAt(handle, record.start + offset, Math.min(limit, totalBytes - offset));
    let content, length = raw.length;
    for (let dropped = 0; dropped < 4; dropped++) {
      try { content = new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(0, length)); break; }
      catch { length--; }
    }
    if (content === undefined || length <= 0) fail('transcript-entry-encoding-invalid', 409);
    await verifyReadSnapshot(handle, row, info, headerEnd, info.size === index.size ? index.anchor : undefined);
    const complete = offset + length === totalBytes;
    return { status: 'ready', entryId, type: record.type, customType: record.customType, encoding: 'jsonl-utf8',
      content, offset, totalBytes, complete, nextCursor: complete ? null : entryCursor(index, entryId, 'content', offset + length), partial: true };
  } catch (error) {
    if (error?.code?.startsWith('transcript-')) throw error;
    fail(error?.code === 'ENOENT' ? 'transcript-not-found' : 'transcript-read-unavailable', error?.code === 'ENOENT' ? 404 : 503);
  } finally { await handle?.close(); }
}

function decodeToolResultCursor(value, toolCallId) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(value)) fail('transcript-tool-cursor-invalid');
  let parsed;
  try { parsed = decodeJson(Buffer.from(value, 'base64url')); }
  catch { fail('transcript-tool-cursor-invalid'); }
  if (parsed?.version !== 1 || parsed.kind !== 'tool-result' || parsed.toolCallId !== toolCallId || typeof parsed.token !== 'string'
    || parsed.entryId !== undefined && typeof parsed.entryId !== 'string'
    || parsed.entryCursor !== undefined && typeof parsed.entryCursor !== 'string') fail('transcript-tool-cursor-invalid');
  return parsed;
}

function toolResultCursor(index, toolCallId, entryId, cursor) {
  return Buffer.from(JSON.stringify({ version: 1, kind: 'tool-result', token: index.token, toolCallId,
    ...(entryId ? { entryId, entryCursor: cursor } : {}) })).toString('base64url');
}

/** Native tool-result identity lookup with the same bounded branch index and
 * raw entry windows as exact entry reads. A large result retains its full
 * native JSON envelope so images, text and tool details stay recoverable. */
export async function readTranscriptToolResult(row, toolCallId, { cursor, limit = TRANSCRIPT_LIMITS.entryChunkBytes } = {}, options = {}) {
  if (typeof toolCallId !== 'string' || !toolCallId || toolCallId.length > 256 || /[\u0000-\u001f\u007f]/.test(toolCallId)) fail('transcript-tool-call-id-invalid', 404);
  if (!Number.isSafeInteger(limit) || limit < 4 || limit > TRANSCRIPT_LIMITS.recordBytes) fail('transcript-limit-invalid');
  const continuation = decodeToolResultCursor(cursor, toolCallId);
  let handle;
  try {
    const opened = await openTranscript(row, options);
    ({ handle } = opened);
    const index = await obtainEntryIndex(opened, continuation);
    if (!index.complete) await advanceEntryIndex(index, handle);
    await verifyReadSnapshot(handle, row, opened.info, opened.headerEnd, opened.info.size === index.size ? index.anchor : undefined);
    if (!index.complete) return { status: 'searching', toolCallId, scannedBytes: index.offset, totalBytes: index.size,
      nextCursor: toolResultCursor(index, toolCallId), partial: true };
    const candidates = [...index.records.values()].filter(record => record.messageRole === 'toolResult' && record.toolCallId === toolCallId);
    const record = candidates.reverse().find(candidate => currentBranchContains(index, candidate.id));
    if (!record) return { status: 'not-found', toolCallId, complete: true, nextCursor: null, partial: index.partial };
    if (continuation?.entryId && continuation.entryId !== record.id) fail('transcript-tool-cursor-invalid');
    const innerCursor = continuation?.entryCursor ?? entryCursor(index, record.id, 'content');
    const result = await readTranscriptEntry(row, record.id, { cursor: innerCursor, limit }, options);
    if (result.entry) {
      const message = result.entry.message;
      if (message?.role !== 'toolResult' || message.toolCallId !== toolCallId) fail('transcript-tool-result-changed', 409);
      const text = typeof message.content === 'string' ? message.content
        : Array.isArray(message.content) ? message.content.filter(part => part.type === 'text').map(part => part.text ?? '').join('') : '';
      return { status: 'ready', toolCallId, entryId: record.id, result: text, isError: message.isError === true,
        entry: result.entry, complete: true, nextCursor: null, partial: result.partial };
    }
    return { ...result, toolCallId, source: 'native-tool-result-entry',
      nextCursor: result.nextCursor ? toolResultCursor(index, toolCallId, record.id, result.nextCursor) : null };
  } catch (error) {
    if (error?.code?.startsWith('transcript-')) throw error;
    fail(error?.code === 'ENOENT' ? 'transcript-not-found' : 'transcript-read-unavailable', error?.code === 'ENOENT' ? 404 : 503);
  } finally { await handle?.close(); }
}
