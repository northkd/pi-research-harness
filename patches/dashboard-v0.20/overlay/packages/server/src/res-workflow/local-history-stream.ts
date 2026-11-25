import type { Stats } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { openVerifiedRegularFile } from "../access/verified-read.js";
import { projectResearchMessages, type ResearchMessage } from "../session/research-message-projection.js";

export const LOCAL_HISTORY_STREAM_LIMITS = Object.freeze({ rawBytes: 64 * 1024 * 1024, lineBytes: 16 * 1024 * 1024, entries: 50000, chunkBytes: 64 * 1024, nesting: 32, structuralTokens: 250000 });
interface Options {
  file: string; cwd: string; expectedId?: string; signal: AbortSignal; deadline: number;
  revalidate(): Promise<void>; acceptText(text: string): boolean;
  onHeader(header: { id: string; cwd: string }): Promise<void>;
  maxTextBytes: number; maxSources: number; maxMessageBytes: number;
  mode?: "snapshot" | "full";
  /** Only a trusted complete retained-store read may supply this immutable full-mode input. */
  retainedRaw?: string;
  /** Internal tests may only shorten the production ceilings. Never comes from HTTP. */
  limits?: { rawBytes?: number; lineBytes?: number; entries?: number };
}
interface FilteredCounts { toolMessages: number; nonTextMessages: number; customEntries: number; compactionEntries: number; thinkingParts: number; toolParts: number; imageParts: number; offBranchEntries: number }
interface Row { id: string; parent?: string; offset: number; bytes: number; normalBytes: number; full?: { candidateBytes: number; sensitive: boolean; timestampUnknown: boolean; filtered: FilteredCounts } }
export interface FullHistoryExtractionCoverage {
  complete: boolean; blockers: string[]; normalMessages: number; normalBytes: number; eligibleMessages: number; eligibleBytes: number;
  sensitiveFilteredMessages: number; timestampUnknownMessages: number; filteredCounts: FilteredCounts;
  sourceStamp: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
  retainedSha256?: string;
}
export interface LocalHistoryExtraction {
  id: string; messages: (ResearchMessage & { incomplete: boolean })[]; partial: boolean; reasons: string[];
  scannedBytes: number; indexedEntries: number; normalMessages: number; maxBufferedLineBytes: number;
  full?: FullHistoryExtractionCoverage;
}
export function planHistoryMessages(lengths: number[], maxTextBytes: number, maxSources: number, maxMessageBytes: number) {
  const count = Math.max(0, Math.min(lengths.length, maxSources, Math.floor(maxTextBytes / 4)));
  const indexes = count <= 0 ? [] : count === 1 ? [Math.floor((lengths.length - 1) / 2)] : Array.from({ length: count }, (_, index) => Math.round(index * (lengths.length - 1) / (count - 1)));
  const allocations = new Map<number, number>(); let remaining = maxTextBytes, left = count;
  for (const index of [...indexes].sort((a, b) => lengths[a] - lengths[b])) { const bytes = Math.min(lengths[index], maxMessageBytes, Math.floor(remaining / left)); allocations.set(index, bytes); remaining -= bytes; left--; }
  return { indexes, allocations, sampled: count < lengths.length };
}
export function excerptHistoryText(text: string, maxBytes: number): string {
  const full = Buffer.from(text); let end = Math.min(full.length, maxBytes);
  while (end > 0 && end < full.length && (full[end] & 0xc0) === 0x80) end--;
  return full.subarray(0, end).toString("utf8");
}

/** Authorized local files only. One verified descriptor, bounded lines, metadata index, then selected line reads. */
export async function streamLocalHistory(options: Options): Promise<LocalHistoryExtraction> {
  const fullMode = options.mode === "full";
  const caps = { ...LOCAL_HISTORY_STREAM_LIMITS, ...options.limits };
  for (const key of ["rawBytes", "lineBytes", "entries"] as const) if (!Number.isSafeInteger(caps[key]) || caps[key] < 1 || caps[key] > LOCAL_HISTORY_STREAM_LIMITS[key]) throw new Error("history-stream-limit-invalid");
  if (options.retainedRaw !== undefined && (!fullMode || typeof options.retainedRaw !== "string" || Buffer.byteLength(options.retainedRaw) > caps.rawBytes)) throw new Error("history-full-retained-invalid");
  const retainedBuffer = options.retainedRaw === undefined ? undefined : Buffer.from(options.retainedRaw, "utf8");
  if (retainedBuffer && retainedBuffer.toString("utf8") !== options.retainedRaw) throw new Error("history-full-retained-invalid");
  const retainedSha256 = retainedBuffer ? createHash("sha256").update(retainedBuffer).digest("hex") : undefined;
  const handle = retainedBuffer ? {
    stat: async () => ({ dev: 0, ino: 0, size: retainedBuffer.length, mtimeMs: 0, ctimeMs: 0, isFile: () => true }),
    read: async (buffer: Buffer, offset: number, length: number, position: number) => ({ bytesRead: retainedBuffer.copy(buffer, offset, position, Math.min(retainedBuffer.length, position + length)), buffer }),
    close: async () => { retainedBuffer.fill(0); },
  } : await openVerifiedRegularFile(options.file);
  const reasons = new Set<string>(), rows: Row[] = [], byId = new Map<string, Row>();
  let scannedBytes = 0, indexedEntries = 0, normalMessages = 0, maxBufferedLineBytes = 0;
  let leaf: string | undefined, explicitLeaf: string | undefined, id = "", unknownMetadata = false;
  let before: Pick<Stats, "dev" | "ino" | "size" | "mtimeMs" | "ctimeMs" | "isFile">;
  try { before = await handle.stat(); } catch (error) { await handle.close(); throw error; }
  const stamp = (stat: typeof before) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
  const original = stamp(before);
  const emptyCounts = (): FilteredCounts => ({ toolMessages: 0, nonTextMessages: 0, customEntries: 0, compactionEntries: 0, thinkingParts: 0, toolParts: 0, imageParts: 0, offBranchEntries: 0 });
  let fullCoverage: FullHistoryExtractionCoverage | undefined = fullMode ? { complete: false, blockers: [], normalMessages: 0, normalBytes: 0, eligibleMessages: 0, eligibleBytes: 0, sensitiveFilteredMessages: 0, timestampUnknownMessages: 0, filteredCounts: emptyCounts(), sourceStamp: { dev: before.dev, ino: before.ino, size: before.size, mtimeMs: before.mtimeMs, ctimeMs: before.ctimeMs }, ...(retainedSha256 ? { retainedSha256 } : {}) } : undefined;
  const finish = (messages: LocalHistoryExtraction["messages"]): LocalHistoryExtraction => {
    if (fullCoverage) {
      fullCoverage.blockers = [...reasons];
      fullCoverage.complete = !reasons.size && messages.length === fullCoverage.eligibleMessages && messages.reduce((sum, message) => sum + Buffer.byteLength(message.text), 0) === fullCoverage.eligibleBytes;
      if (!fullCoverage.complete) messages = [];
      return { id, messages, partial: !fullCoverage.complete, reasons: [...reasons], scannedBytes, indexedEntries, normalMessages, maxBufferedLineBytes, full: fullCoverage };
    }
    const partial = reasons.size > 0 || messages.some(message => message.incomplete);
    if (reasons.size > 0) for (const message of messages) message.incomplete = true;
    return { id, messages, partial, reasons: [...reasons], scannedBytes, indexedEntries, normalMessages, maxBufferedLineBytes };
  };
  async function guarded<T>(promise: Promise<T>): Promise<T> {
    if (options.signal.aborted) throw new Error("cancelled");
    return new Promise<T>((resolve, reject) => {
      const abort = () => { cleanup(); reject(new Error("cancelled")); };
      const timer = setTimeout(() => { cleanup(); reject(new Error("time-budget")); }, Math.max(1, options.deadline - Date.now()));
      const cleanup = () => { clearTimeout(timer); options.signal.removeEventListener("abort", abort); };
      options.signal.addEventListener("abort", abort, { once: true });
      promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
      if (options.signal.aborted) abort();
    });
  }
  async function check() {
    if (options.signal.aborted) throw new Error("cancelled");
    await guarded(options.revalidate());
    if (options.signal.aborted) throw new Error("cancelled");
    if (Date.now() > options.deadline) throw new Error("time-budget");
    if (retainedBuffer) return;
    const [current, named, resolved] = await Promise.all([handle.stat(), lstat(options.file), realpath(options.file)]);
    if (!current.isFile() || !named.isFile() || named.isSymbolicLink() || resolved !== options.file || stamp(current) !== original || stamp(named) !== original) throw new Error("history-source-changed");
  }
  async function read(position: number, length: number): Promise<Buffer> {
    await check();
    const allowed = Math.min(length, caps.chunkBytes, caps.rawBytes - scannedBytes);
    if (allowed <= 0) throw new Error("history-raw-scan-budget");
    const buffer = Buffer.alloc(allowed), value = await handle.read(buffer, 0, allowed, position);
    scannedBytes += value.bytesRead;
    if (!value.bytesRead && length) throw new Error("history-source-changed");
    return buffer.subarray(0, value.bytesRead);
  }
  function lineBudgetRefusal(buffer: Buffer): string | undefined {
    let depth = 0, structuralTokens = 0, quoted = false, escaped = false;
    for (const byte of buffer) {
      if (quoted) { if (escaped) escaped = false; else if (byte === 92) escaped = true; else if (byte === 34) quoted = false; }
      else if (byte === 34) quoted = true;
      else {
        if ((byte === 123 || byte === 125 || byte === 91 || byte === 93 || byte === 44 || byte === 58) && ++structuralTokens > caps.structuralTokens) return "history-line-complexity-budget";
        if (byte === 123 || byte === 91) { if (++depth > caps.nesting) return "history-line-nesting-budget"; }
        else if (byte === 125 || byte === 93) depth--;
      }
    }
    return undefined;
  }
  function parsed(buffer: Buffer): any { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer)); }
  function project(entry: any): ResearchMessage | undefined { return projectResearchMessages([entry])[0]; }
  function filtered(entry: any): FilteredCounts {
    const counts = emptyCounts();
    if (entry.type === "compaction") counts.compactionEntries++;
    else if (entry.type !== "message") counts.customEntries++;
    else if (!["user", "assistant"].includes(entry.message?.role)) counts.toolMessages++;
    else {
      if (!project(entry)) counts.nonTextMessages++;
      if (Array.isArray(entry.message.content)) for (const part of entry.message.content) {
        if (part?.type === "thinking") counts.thinkingParts++;
        else if (part?.type === "toolCall" || part?.type === "toolResult") counts.toolParts++;
        else if (part?.type === "image") counts.imageParts++;
      }
    }
    return counts;
  }
  async function indexLine(buffer: Buffer | undefined, offset: number, bytes: number): Promise<boolean> {
    if (++indexedEntries > caps.entries) { reasons.add("history-entry-budget"); unknownMetadata = true; return false; }
    if (!buffer) { reasons.add("history-line-byte-budget"); unknownMetadata = true; return true; }
    const refusal = lineBudgetRefusal(buffer);
    if (refusal) { reasons.add(refusal); unknownMetadata = true; return true; }
    let entry: any;
    try { const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer); if (!line.trim()) return true; entry = JSON.parse(line); } catch { reasons.add("history-incomplete-or-malformed"); return true; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) { reasons.add("history-incomplete-or-malformed"); return true; }
    if (entry.type === "leaf") {
      if (typeof entry.entryId === "string" && entry.entryId.length <= 256) explicitLeaf = entry.entryId;
      else { reasons.add("history-entry-id-budget"); unknownMetadata = true; }
    }
    if (entry.type === "session") return true;
    if (typeof entry.id !== "string" || !entry.id || entry.id.length > 256) {
      if (entry.id) { reasons.add("history-entry-id-budget"); unknownMetadata = true; }
      if (project(entry)) reasons.add("message-id-missing"); return true;
    }
    let parent: string | undefined;
    if (typeof entry.parentId === "string" && entry.parentId.length <= 256) parent = entry.parentId || undefined;
    else if (entry.parentId !== undefined && entry.parentId !== null) { reasons.add("history-incomplete-or-malformed"); unknownMetadata = true; }
    const message = project(entry);
    const sensitive = !!message && !options.acceptText(message.text);
    let normalBytes = 0;
    if (message) {
      if (sensitive) { if (!fullMode) reasons.add("sensitive-content"); }
      else if (Buffer.from(message.text).toString("utf8") !== message.text) reasons.add("history-incomplete-or-malformed");
      else normalBytes = Buffer.byteLength(message.text);
    }
    const row: Row = { id: entry.id, parent, offset, bytes, normalBytes, ...(fullMode ? { full: { candidateBytes: message ? Buffer.byteLength(message.text) : 0, sensitive, timestampUnknown: !!message && !message.timestamp, filtered: filtered(entry) } } : {}) };
    if (byId.has(row.id)) reasons.add("history-incomplete-or-malformed");
    byId.set(row.id, row); rows.push(row); leaf = row.id;
    return true;
  }
  async function scan(start: number): Promise<void> {
    let position = start, lineStart = start, lineBytes = 0, oversized = false, parts: Buffer[] = [];
    while (position < before.size) {
      if (scannedBytes >= caps.rawBytes) { reasons.add("history-raw-scan-budget"); unknownMetadata = true; return; }
      const chunk = await read(position, Math.min(caps.chunkBytes, before.size - position));
      let cursor = 0;
      while (cursor < chunk.length) {
        const newline = chunk.indexOf(10, cursor), end = newline < 0 ? chunk.length : newline;
        lineBytes += end - cursor;
        if (lineBytes > caps.lineBytes) { oversized = true; parts = []; }
        else if (!oversized) { parts.push(chunk.subarray(cursor, end)); maxBufferedLineBytes = Math.max(maxBufferedLineBytes, lineBytes); }
        if (newline < 0) break;
        if (!(await indexLine(oversized ? undefined : Buffer.concat(parts, lineBytes), lineStart, lineBytes))) return;
        lineStart = position + newline + 1; lineBytes = 0; oversized = false; parts = []; cursor = newline + 1;
      }
      position += chunk.length;
    }
    if (lineBytes || oversized) {
      reasons.add("history-incomplete-or-malformed");
      await indexLine(oversized ? undefined : Buffer.concat(parts, lineBytes), lineStart, lineBytes);
    }
  }
  try {
    await check();
    if (!before.size) throw new Error("invalid-history-header");
    const headerBytes = await read(0, Math.min(4096, before.size)), newline = headerBytes.indexOf(10);
    if (newline < 0) throw new Error("invalid-history-header");
    let header: any;
    try { header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(headerBytes.subarray(0, newline)).trimStart()); } catch { throw new Error("invalid-history-header"); }
    if (header?.type !== "session" || typeof header.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(header.id) || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) throw new Error("invalid-history-header");
    if ((retainedBuffer ? path.resolve(header.cwd) : await realpath(header.cwd).catch(() => "")) !== options.cwd || options.expectedId && options.expectedId !== header.id) throw new Error("history-cwd-or-id-mismatch");
    id = header.id;
    await guarded(options.onHeader({ id, cwd: options.cwd })); await check();
    await scan(newline + 1); await check();
    if (unknownMetadata) { reasons.add("history-branch-unresolved"); return finish([]); }
    const checked = new Set<string>();
    for (const row of rows) {
      if (row.parent && !byId.has(row.parent)) reasons.add("history-incomplete-or-malformed");
      if (checked.has(row.id)) continue;
      const seen = new Set<string>(); let next: string | undefined = row.id;
      while (next && byId.has(next) && !checked.has(next)) { if (seen.has(next)) { reasons.add("history-incomplete-or-malformed"); break; } seen.add(next); next = byId.get(next)!.parent; }
      for (const value of seen) checked.add(value);
    }
    const branch: Row[] = [], seen = new Set<string>(); let current = byId.get(explicitLeaf ?? leaf ?? ""), cyclic = false;
    while (current) { if (seen.has(current.id)) { cyclic = true; break; } seen.add(current.id); branch.push(current); current = current.parent ? byId.get(current.parent) : undefined; }
    if (explicitLeaf && !byId.has(explicitLeaf)) { reasons.add("history-branch-unresolved"); return finish([]); }
    const ordered = cyclic || !branch.length ? rows : branch.reverse();
    if (fullCoverage) {
      fullCoverage.filteredCounts.offBranchEntries = rows.length - ordered.length;
      for (const row of ordered) if (row.full) {
        if (row.full.candidateBytes) { fullCoverage.normalMessages++; fullCoverage.normalBytes += row.full.candidateBytes; }
        if (row.full.sensitive) fullCoverage.sensitiveFilteredMessages++;
        if (row.full.timestampUnknown && row.normalBytes) fullCoverage.timestampUnknownMessages++;
        for (const key of Object.keys(row.full.filtered) as (keyof FilteredCounts)[]) fullCoverage.filteredCounts[key] += row.full.filtered[key];
      }
      if (fullCoverage.sensitiveFilteredMessages) reasons.add("history-sensitive-normal-blocked");
    }
    const normal = ordered.filter(row => row.normalBytes > 0); normalMessages = normal.length;
    if (fullCoverage) {
      fullCoverage.eligibleMessages = normal.length; fullCoverage.eligibleBytes = normal.reduce((sum, row) => sum + row.normalBytes, 0);
      if (fullCoverage.eligibleMessages > options.maxSources) reasons.add("history-full-source-budget");
      if (fullCoverage.eligibleBytes > options.maxTextBytes) reasons.add("history-full-text-budget");
      if (normal.some(row => row.normalBytes > options.maxMessageBytes)) reasons.add("history-full-message-budget");
      if (reasons.size) return finish([]);
    }
    const plan = fullMode ? { indexes: normal.map((_, index) => index), allocations: new Map(normal.map((row, index) => [index, row.normalBytes])), sampled: false } : planHistoryMessages(normal.map(row => row.normalBytes), options.maxTextBytes, options.maxSources, options.maxMessageBytes);
    if (plan.sampled) reasons.add("history-message-sampled");
    const messages: LocalHistoryExtraction["messages"] = [];
    for (const index of plan.indexes) {
      const row = normal[index];
      if (row.bytes > caps.rawBytes - scannedBytes) { reasons.add("history-raw-scan-budget"); continue; }
      let position = row.offset; const end = row.offset + row.bytes, parts: Buffer[] = [];
      while (position < end) { const chunk = await read(position, end - position); parts.push(chunk); position += chunk.length; }
      const entry = parsed(Buffer.concat(parts, row.bytes)), message = project(entry);
      if (entry.id !== row.id || !message || Buffer.byteLength(message.text) !== row.normalBytes || !options.acceptText(message.text)) throw new Error("history-source-changed");
      const text = excerptHistoryText(message.text, plan.allocations.get(index)!);
      if (!text) { reasons.add("history-text-excerpt"); continue; }
      const excerpted = text !== message.text;
      if (excerpted) reasons.add("history-text-excerpt");
      messages.push({ ...message, text, incomplete: excerpted || !fullMode && !message.timestamp });
    }
    await check(); return finish(messages);
  } finally { await handle.close(); }
}
