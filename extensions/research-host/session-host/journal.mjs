import fs from 'node:fs';
import path from 'node:path';
import { fail, privateDir } from './files.mjs';

const CHECKPOINT_BYTES = 16;
const MAX_LINE_BYTES = 64 * 1024 * 1024;
const checkpoint = (sequence, offset) => {
  const bytes = Buffer.alloc(CHECKPOINT_BYTES);
  bytes.writeBigUInt64LE(BigInt(sequence), 0);
  bytes.writeBigUInt64LE(BigInt(offset), 8);
  return bytes;
};

function inspect(file) {
  const info = fs.lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid()) fail('session-journal-unsafe');
  return info;
}

function finalSequence(fd, size, allowPartial = false) {
  if (!size) return 0;
  let remaining = size, tail = Buffer.alloc(0);
  while (remaining > 0 && tail.length <= MAX_LINE_BYTES) {
    const count = Math.min(64 * 1024, remaining), bytes = Buffer.alloc(count);
    remaining -= count; fs.readSync(fd, bytes, 0, count, remaining);
    tail = Buffer.concat([bytes, tail]);
    const end = tail.lastIndexOf(10), start = tail.lastIndexOf(10, end - 1);
    if (end >= 0 && (start >= 0 || remaining === 0)) {
      if (end !== tail.length - 1 && !allowPartial) fail('session-journal-partial-tail');
      const entry = JSON.parse(tail.subarray(start + 1, end).toString('utf8'));
      if (!Number.isSafeInteger(entry.sequence) || entry.sequence < 1) fail('session-journal-sequence-invalid');
      return entry.sequence;
    }
  }
  fail('session-journal-record-too-large');
}

export function createSessionJournal(directory) {
  privateDir(directory);
  const file = path.join(directory, 'events.jsonl'), indexFile = path.join(directory, 'events.index');
  const fd = fs.openSync(file, 'a+', 0o600), indexFd = fs.openSync(indexFile, 'a+', 0o600);
  inspect(file); inspect(indexFile);
  let offset = fs.fstatSync(fd).size, sequence = finalSequence(fd, offset), dirty = false, checkpointOffset = offset;
  const indexSize = fs.fstatSync(indexFd).size;
  if (indexSize % CHECKPOINT_BYTES !== 0) fail('session-journal-index-partial');
  if (!indexSize) fs.writeSync(indexFd, checkpoint(0, 0));
  return {
    get sequence() { return sequence; },
    append(event, durable = true) {
      const entry = { sequence: ++sequence, event }, bytes = Buffer.from(JSON.stringify(entry) + '\n');
      if (bytes.length > MAX_LINE_BYTES) fail('session-journal-record-too-large');
      fs.writeSync(fd, bytes); offset += bytes.length; dirty = true;
      if (durable || sequence % 128 === 0 || offset - checkpointOffset >= 64 * 1024) {
        fs.writeSync(indexFd, checkpoint(sequence, offset)); checkpointOffset = offset;
      }
      if (durable) { fs.fsyncSync(fd); fs.fsyncSync(indexFd); dirty = false; }
      return entry;
    },
    flush() { if (dirty) { fs.fsyncSync(fd); fs.fsyncSync(indexFd); dirty = false; } },
    close() { this.flush(); fs.closeSync(fd); fs.closeSync(indexFd); },
  };
}

function locateCheckpoint(indexFile, after, journalSize) {
  let info;
  try { info = inspect(indexFile); } catch (error) { if (error.code === 'ENOENT') return { sequence: 0, offset: 0 }; throw error; }
  const count = Math.floor(info.size / CHECKPOINT_BYTES);
  if (!count) return { sequence: 0, offset: 0 };
  const fd = fs.openSync(indexFile, 'r'), bytes = Buffer.alloc(CHECKPOINT_BYTES);
  let left = 0, right = count - 1, answer = { sequence: 0, offset: 0 };
  try {
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      if (fs.readSync(fd, bytes, 0, bytes.length, middle * CHECKPOINT_BYTES) !== CHECKPOINT_BYTES) fail('session-journal-index-invalid');
      const sequence = Number(bytes.readBigUInt64LE(0)), offset = Number(bytes.readBigUInt64LE(8));
      if (!Number.isSafeInteger(sequence) || !Number.isSafeInteger(offset)) fail('session-journal-index-invalid');
      if (sequence <= after && offset <= journalSize) { answer = { sequence, offset }; left = middle + 1; }
      else right = middle - 1;
    }
    return answer;
  } finally { fs.closeSync(fd); }
}

export function readSessionJournal(directory, { after = 0, limit = 200 } = {}) {
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isInteger(limit) || limit < 1 || limit > 2000) fail('session-events-query-invalid');
  const file = path.join(directory, 'events.jsonl'), indexFile = path.join(directory, 'events.index');
  let info;
  try { info = inspect(file); } catch (error) { if (error.code === 'ENOENT') return { events: [], nextCursor: after, lastSequence: 0, scannedBytes: 0 }; throw error; }
  const initial = locateCheckpoint(indexFile, after, info.size), events = [];
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024);
  let position = initial.offset, previous = initial.sequence, nextCursor = after, pending = Buffer.alloc(0), scannedBytes = 0;
  try {
    const lastSequence = finalSequence(fd, info.size, true);
    while (position < info.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, info.size - position), position);
      if (!count) break;
      position += count; scannedBytes += count;
      pending = Buffer.concat([pending, buffer.subarray(0, count)]);
      let newline;
      while ((newline = pending.indexOf(10)) >= 0) {
        const line = pending.subarray(0, newline); pending = pending.subarray(newline + 1);
        const entry = JSON.parse(line.toString('utf8'));
        if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previous || !entry.event || typeof entry.event !== 'object') fail('session-journal-sequence-invalid');
        previous = entry.sequence;
        if (entry.sequence <= after) continue;
        events.push(entry); nextCursor = entry.sequence;
        if (events.length >= limit) return { events, nextCursor, lastSequence, scannedBytes };
      }
      if (pending.length > MAX_LINE_BYTES) fail('session-journal-record-too-large');
    }
    return { events, nextCursor, lastSequence, scannedBytes };
  } finally { fs.closeSync(fd); }
}
