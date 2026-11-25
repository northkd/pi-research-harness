import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { parseSessionEntries, splitTranscriptLines } from "../session/session-file-reader.mjs";
import { projectResearchMessages } from "../session/research-message-projection.mjs";
import { collectHistoryCandidates } from "./history-candidates.mjs";
import { assertNoLinks, readBoundedRegular } from "./safe-files.mjs";
import { excerptHistoryText, planHistoryMessages, streamLocalHistory } from "./local-history-stream.mjs";
const DEFAULT_LIMITS = {
  maxFiles: 128,
  maxDepth: 5,
  maxEntries: 2500,
  maxTextBytes: 512 * 1024,
  maxFileBytes: 48 * 1024,
  maxHistoryFiles: 40,
  maxHistoryBytes: 768 * 1024,
  maxHistoryEntries: 3e3,
  maxSources: 256,
  timeoutMs: 15e3
};
const EXCLUDE = /^(?:\.git|\.pi|\.env(?:\..*)?|\.ssh|\.aws|\.azure|\.config|\.npmrc|\.pypirc|node_modules|vendor|venv|\.venv|__pycache__|\.cache|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.next|dist|build|target|coverage|backups?|caches?|browser-profile|auth(?:\..*)?|credentials?(?:\..*)?|secrets?(?:\..*)?|tokens?(?:\..*)?|id_rsa|id_ed25519|AGENTS\.md|CLAUDE\.md|SKILL\.md|prompt\.txt)$/i;
const SECRET_PATH = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|credentials?|secrets?|(?:^|[._-])auth(?:[._-]|$)|\.(?:pem|key|p12|pfx)$)/i;
const TEXT_EXT = /* @__PURE__ */ new Set([".md", ".txt", ".tex", ".bib", ".csv", ".tsv", ".json", ".yaml", ".yml", ".rst", ".adoc"]);
const SECRET_TEXT = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|secret|credential|cookie)\s*(?:["']\s*)?[:=]\s*\S+|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})/i;
const hash = (text) => createHash("sha256").update(text).digest("hex");
async function inventoryResearch(options) {
  const { cwd, signal } = options;
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const result = { sources: [], skipped: [], content: {}, partial: false, progress: { files: 0, sessions: 0, bytes: 0 }, historyBindings: [] };
  const deadline = Date.now() + limits.timeoutMs;
  let visited = 0;
  const check = async () => {
    if (signal.aborted) throw new Error("cancelled");
    await options.revalidate();
    if (signal.aborted) throw new Error("cancelled");
    if (Date.now() > deadline) throw new Error("time-budget");
  };
  const skip = (label, reason, partial = true) => {
    if (result.skipped.length < 200) result.skipped.push({ label, reason });
    result.partial ||= partial;
  };
  const add = (source, text) => {
    const bytes = Buffer.byteLength(text);
    if (result.sources.length >= limits.maxSources || result.progress.bytes + bytes > limits.maxTextBytes) {
      skip(source.label, "text-budget");
      return;
    }
    if (SECRET_TEXT.test(text)) {
      skip(source.label, "sensitive-content");
      return;
    }
    const sha256 = hash(text);
    const id = `src-${hash(JSON.stringify([source.kind, source.path, source.sessionId, source.entryId, sha256])).slice(0, 24)}`;
    if (result.content[id] !== void 0) return;
    result.sources.push({ ...source, id, sha256, bytes, unverified: true });
    result.partial ||= source.incomplete;
    result.content[id] = text;
    result.progress.bytes += bytes;
    options.onProgress?.({ ...result.progress });
  };
  const visit = async (relative, depth) => {
    await check();
    const directory = path.join(cwd, relative);
    await assertNoLinks(cwd, directory);
    const handle = await opendir(directory);
    try {
      for await (const entry of handle) {
        await check();
        if (++visited > limits.maxEntries) {
          skip(relative || ".", "entry-budget");
          return;
        }
        const rel = path.join(relative, entry.name);
        if (EXCLUDE.test(entry.name) || SECRET_PATH.test(entry.name)) {
          skip(rel, "excluded-scope", false);
          continue;
        }
        const absolute = path.join(cwd, rel);
        const info = await lstat(absolute).catch(() => null);
        if (!info) {
          skip(rel, "unreadable");
          continue;
        }
        if (info.isSymbolicLink()) {
          skip(rel, "symlink");
          continue;
        }
        if (info.isDirectory()) {
          if (depth >= limits.maxDepth) skip(rel, "depth-budget");
          else await visit(rel, depth + 1).catch((err) => {
            if (signal.aborted || err.message === "time-budget") throw err;
            skip(rel, "unreadable-directory");
          });
          continue;
        }
        if (!info.isFile()) {
          skip(rel, "not-regular");
          continue;
        }
        if (result.progress.files >= limits.maxFiles) {
          skip(rel, "file-budget");
          continue;
        }
        result.progress.files++;
        if (!TEXT_EXT.has(path.extname(entry.name).toLowerCase()) || info.size > limits.maxFileBytes) {
          add({ kind: "artifact", path: rel, label: rel, timestamp: info.mtime.toISOString(), incomplete: true }, JSON.stringify({ path: rel, bytes: info.size, modifiedAt: info.mtime.toISOString(), note: "Metadata only; artifact contents were not read or verified." }));
          result.partial = true;
          continue;
        }
        try {
          const read = await readBoundedRegular(absolute, limits.maxFileBytes, cwd);
          await check();
          if (read.text.includes("\0") || read.text.includes("\uFFFD")) {
            skip(rel, "non-text");
            continue;
          }
          add({ kind: "file", path: rel, label: rel, timestamp: read.timestamp, incomplete: false }, read.text);
        } catch (err) {
          if (signal.aborted || err.message === "time-budget") throw err;
          skip(rel, err.message === "byte-budget" ? "byte-budget" : "unreadable-or-changed");
        }
        await yieldTurn();
      }
    } finally {
      await handle.close().catch(() => {
      });
    }
  };
  const selectedHistoryFirst = options.history.length > 0;
  const visitFiles = async () => {
    try {
      await visit("", 0);
    } catch (err) {
      if (signal.aborted) throw new Error("cancelled");
      if (err.message === "time-budget") skip(".", "time-budget");
      else throw err;
    }
  };
  if (!selectedHistoryFirst) await visitFiles();
  const candidates = await collectHistoryCandidates(options, check, skip);
  const seenFiles = /* @__PURE__ */ new Set();
  const seenSessions = /* @__PURE__ */ new Set();
  let examined = 0;
  let headersExamined = 0;
  let historyBytes = 0, historySources = 0, candidatePosition = -1;
  const historyByteReserve = Math.floor(limits.maxTextBytes / 2), historySourceReserve = Math.max(1, Math.floor(limits.maxSources / 2));
  for (const candidate of candidates) {
    candidatePosition++;
    try {
      await check();
      const remote = !!candidate.originDeviceId;
      if (candidate.cwd && path.resolve(candidate.cwd) !== cwd && (remote || await realpath(candidate.cwd).catch(() => "") !== cwd)) continue;
      if (options.canReadHistory && !await options.canReadHistory(candidate)) {
        skip("Pi history", "history-owner-unavailable");
        continue;
      }
      let raw;
      let complete = true;
      const remainingHistories = Math.max(1, Math.min(candidates.length - candidatePosition, limits.maxHistoryFiles - examined));
      const textQuota = selectedHistoryFirst ? Math.max(0, Math.floor((historyByteReserve - historyBytes) / remainingHistories)) : Math.max(0, limits.maxTextBytes - result.progress.bytes);
      const sourceQuota = selectedHistoryFirst ? Math.max(0, Math.floor((historySourceReserve - historySources) / remainingHistories)) : Math.max(0, limits.maxSources - result.sources.length);
      const beforeBytes = result.progress.bytes, beforeSources = result.sources.length;
      if (remote) {
        if (!candidate.id || !options.readRetained) {
          skip("Pi history", "retained-transcript-unavailable");
          continue;
        }
        const key = `remote:${candidate.id}`;
        if (seenFiles.has(key)) continue;
        seenFiles.add(key);
        if (examined++ >= limits.maxHistoryFiles) {
          skip("Pi history", "history-file-budget");
          break;
        }
        const retained = await options.readRetained(candidate.id, limits.maxHistoryBytes);
        if (!retained.retained) {
          skip("Pi history", "retained-transcript-unavailable");
          continue;
        }
        raw = retained.raw;
        complete = retained.complete;
        if (Buffer.byteLength(raw) > limits.maxHistoryBytes) {
          skip("Pi history", "history-byte-budget");
          continue;
        }
      } else {
        if (!candidate.sessionFile || !path.isAbsolute(candidate.sessionFile) || seenFiles.has(candidate.sessionFile)) continue;
        seenFiles.add(candidate.sessionFile);
        if (++headersExamined > 256) {
          skip("Pi history", "history-header-budget");
          break;
        }
        const file = candidate.sessionFile;
        let binding2 = candidate;
        const extracted = await streamLocalHistory({
          file,
          cwd,
          expectedId: candidate.id,
          signal,
          deadline,
          maxTextBytes: textQuota,
          maxSources: sourceQuota,
          maxMessageBytes: limits.maxFileBytes,
          acceptText: (text) => !SECRET_TEXT.test(text),
          revalidate: async () => {
            await check();
            if (options.canReadHistory && !await options.canReadHistory(binding2)) throw new Error("history-owner-unavailable");
          },
          onHeader: async (header2) => {
            if (seenSessions.has(`local:${header2.id}`)) throw new Error("history-duplicate-session");
            binding2 = { ...candidate, id: header2.id, cwd };
            if (options.canReadHistory && !await options.canReadHistory(binding2)) throw new Error("history-owner-unavailable");
            if (examined++ >= limits.maxHistoryFiles) throw new Error("history-file-budget");
          }
        });
        await check();
        seenSessions.add(`local:${extracted.id}`);
        result.historyBindings.push(binding2);
        result.progress.sessions++;
        for (const reason of extracted.reasons) skip(`Pi ${extracted.id}`, reason);
        for (const message of extracted.messages) add({ kind: "session-message", sessionId: extracted.id, entryId: message.entryId, label: `Pi ${extracted.id} \xB7 ${message.entryId}`, timestamp: message.timestamp, incomplete: message.incomplete }, message.text);
        historyBytes += result.progress.bytes - beforeBytes;
        historySources += result.sources.length - beforeSources;
        await yieldTurn();
        continue;
      }
      await check();
      const lines = splitTranscriptLines(raw);
      const header = JSON.parse(lines[0]);
      if (header?.type !== "session" || typeof header.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(header.id) || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) {
        skip("Pi history", "invalid-history-header");
        continue;
      }
      const headerCwd = remote ? path.resolve(header.cwd) : await realpath(header.cwd).catch(() => "");
      if (headerCwd !== cwd || candidate.id && candidate.id !== header.id) {
        skip("Pi history", "history-cwd-or-id-mismatch");
        continue;
      }
      if (seenSessions.has(`${remote ? "remote" : "local"}:${header.id}`)) continue;
      seenSessions.add(`${remote ? "remote" : "local"}:${header.id}`);
      const binding = { ...candidate, id: header.id, cwd: headerCwd };
      if (options.canReadHistory && !await options.canReadHistory(binding)) {
        skip("Pi history", "history-owner-unavailable");
        continue;
      }
      result.historyBindings.push(binding);
      let malformed = !raw.endsWith("\n");
      const ids = /* @__PURE__ */ new Set();
      const parents = /* @__PURE__ */ new Map();
      for (const line of lines.slice(1)) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry || typeof entry !== "object") {
            malformed = true;
            continue;
          }
          if (typeof entry.id === "string") {
            if (ids.has(entry.id)) malformed = true;
            ids.add(entry.id);
            if (typeof entry.parentId === "string") parents.set(entry.id, entry.parentId);
          }
        } catch {
          malformed = true;
        }
      }
      const checked = /* @__PURE__ */ new Set();
      for (const [id, parent] of parents) {
        if (!ids.has(parent)) malformed = true;
        if (checked.has(id)) continue;
        const seen = /* @__PURE__ */ new Set();
        let next = id;
        while (next && parents.has(next) && !checked.has(next)) {
          if (seen.has(next)) {
            malformed = true;
            break;
          }
          seen.add(next);
          next = parents.get(next);
        }
        for (const visitedId of seen) checked.add(visitedId);
      }
      let messages;
      if (options.pool) {
        const dispatch = options.pool.load({ sessionId: header.id, raw, mode: "research-messages" });
        const cancel = () => options.pool?.cancel(dispatch.jobId);
        signal.addEventListener("abort", cancel, { once: true });
        try {
          const loaded = await dispatch.result;
          if (!loaded.success || !loaded.researchMessages) throw new Error(loaded.error ?? "history-parse-failed");
          messages = loaded.researchMessages;
        } finally {
          signal.removeEventListener("abort", cancel);
        }
      } else {
        messages = projectResearchMessages(parseSessionEntries(lines));
      }
      await check();
      result.progress.sessions++;
      if (malformed || !complete) {
        result.partial = true;
        skip(`Pi ${header.id}`, malformed ? "history-incomplete-or-malformed" : "retained-transcript-incomplete");
      }
      const admittedMessages = messages.filter((message) => {
        if (!SECRET_TEXT.test(message.text)) return true;
        skip(`Pi ${header.id}`, "sensitive-content");
        return false;
      });
      const plan = planHistoryMessages(admittedMessages.map((message) => Buffer.byteLength(message.text)), textQuota, sourceQuota, limits.maxFileBytes);
      if (plan.sampled) skip(`Pi ${header.id}`, "history-message-sampled");
      for (const index of plan.indexes) {
        const message = admittedMessages[index];
        if (!message.entryId) {
          skip(`Pi ${header.id}`, "message-id-missing");
          continue;
        }
        const text = excerptHistoryText(message.text, plan.allocations.get(index));
        if (!text) {
          skip(`Pi ${header.id}`, "history-text-excerpt");
          continue;
        }
        const excerpted = text !== message.text;
        if (excerpted) skip(`Pi ${header.id}`, "history-text-excerpt");
        add({ kind: "session-message", sessionId: header.id, entryId: message.entryId, label: `Pi ${header.id} \xB7 ${message.entryId}`, timestamp: message.timestamp, incomplete: malformed || !complete || !message.timestamp || excerpted || plan.sampled }, text);
      }
      historyBytes += result.progress.bytes - beforeBytes;
      historySources += result.sources.length - beforeSources;
      await yieldTurn();
    } catch (err) {
      if (signal.aborted) throw new Error("cancelled");
      const reason = err.message;
      if (reason === "history-duplicate-session") continue;
      if (reason === "history-cwd-or-id-mismatch" && !candidate.id && !candidate.cwd) continue;
      if (reason === "time-budget" || reason === "history-file-budget") {
        skip("Pi history", reason);
        break;
      }
      skip("Pi history", reason === "byte-budget" ? "history-byte-budget" : ["history-source-changed", "invalid-history-header", "history-cwd-or-id-mismatch", "history-owner-unavailable"].includes(reason) ? reason : "history-unreadable-or-malformed");
    }
  }
  if (selectedHistoryFirst) await visitFiles();
  await options.revalidate();
  if (signal.aborted) throw new Error("cancelled");
  return result;
}
export {
  inventoryResearch
};
