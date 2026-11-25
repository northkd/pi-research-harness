import { createHash } from "node:crypto";
import { lstat, opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { openVerifiedRegularFile } from "../access/verified-read.mjs";
import { assertNoLinks } from "./safe-files.mjs";
async function collectHistoryCandidates(options, check, skip) {
  const candidates = [...options.history];
  let entries = 0;
  const maxEntries = options.limits?.maxHistoryEntries ?? 3e3;
  const walk = async (root, relative = "", depth = 0) => {
    await check();
    const dir = path.join(root, relative);
    await assertNoLinks(root, dir);
    const handle = await opendir(dir);
    try {
      for await (const entry of handle) {
        if (++entries > maxEntries) {
          skip("Pi history", "history-entry-budget");
          return;
        }
        await check();
        const rel = path.join(relative, entry.name);
        if (entry.isSymbolicLink()) {
          skip("Pi history", "history-symlink");
          continue;
        }
        if (entry.isDirectory()) {
          if (depth < 3) await walk(root, rel, depth + 1);
          else skip("Pi history", "history-depth-budget");
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) candidates.push({ sessionFile: path.join(root, rel), unregistered: true });
      }
    } finally {
      await handle.close().catch(() => {
      });
    }
  };
  for (const rootRaw of [...new Set(options.historyRoots)]) {
    try {
      const info = await lstat(rootRaw);
      if (!info.isDirectory() || info.isSymbolicLink()) {
        skip("Pi history", "unsafe-history-root");
        continue;
      }
      await walk(await realpath(rootRaw));
    } catch (err) {
      if (options.signal.aborted) throw new Error("cancelled");
      if (err.message === "time-budget") {
        skip("Pi history", "time-budget");
        break;
      }
      if (err.code !== "ENOENT") skip("Pi history", "history-unreadable");
    }
  }
  return candidates;
}
async function readLocalHistoryHeader(file, cwd, expectedId) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(file) !== file) throw new Error("unsafe-history-file");
  const peek = await openVerifiedRegularFile(file);
  let first;
  try {
    const buffer = Buffer.alloc(4096);
    const { bytesRead } = await peek.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8").trimStart();
    const newline = prefix.indexOf("\n");
    if (newline < 0) throw new Error("invalid-history-header");
    try {
      first = JSON.parse(prefix.slice(0, newline));
    } catch {
      throw new Error("invalid-history-header");
    }
  } finally {
    await peek.close();
  }
  if (first?.type !== "session" || typeof first.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(first.id) || typeof first.cwd !== "string" || !path.isAbsolute(first.cwd)) throw new Error("invalid-history-header");
  if (await realpath(first.cwd).catch(() => "") !== cwd || expectedId && expectedId !== first.id) throw new Error("history-cwd-or-id-mismatch");
  return { id: first.id, cwd, ...typeof first.timestamp === "string" ? { timestamp: first.timestamp } : {}, bytes: info.size };
}
async function discoverHistoryCandidates(options, ownerKey) {
  const result = { candidates: [], bindings: /* @__PURE__ */ new Map(), partial: false, skipped: [] };
  const deadline = Date.now() + (options.limits?.timeoutMs ?? 15e3);
  const check = async () => {
    if (options.signal.aborted) throw new Error("cancelled");
    await options.revalidate();
    if (options.signal.aborted) throw new Error("cancelled");
    if (Date.now() > deadline) throw new Error("time-budget");
  };
  const skip = (label, reason, partial = true) => {
    if (result.skipped.length < 200) result.skipped.push({ label, reason });
    result.partial ||= partial;
  };
  const candidates = await collectHistoryCandidates(options, check, skip);
  const seenFiles = /* @__PURE__ */ new Set();
  const seenSessions = /* @__PURE__ */ new Set();
  let headers = 0;
  for (const candidate of candidates) {
    try {
      await check();
      const remote = !!candidate.originDeviceId;
      if (candidate.cwd && path.resolve(candidate.cwd) !== options.cwd && (remote || await realpath(candidate.cwd).catch(() => "") !== options.cwd)) continue;
      if (options.canReadHistory && !await options.canReadHistory(candidate)) {
        skip("Pi history", "history-owner-unavailable");
        continue;
      }
      let sessionId;
      let timestamp = candidate.timestamp;
      let incomplete = remote;
      let identity;
      if (remote) {
        if (!candidate.id || !/^[A-Za-z0-9_-]{1,128}$/.test(candidate.id) || !candidate.cwd || path.resolve(candidate.cwd) !== options.cwd) continue;
        sessionId = candidate.id;
        identity = `retained:${candidate.originDeviceId}:${sessionId}`;
      } else {
        const file = candidate.sessionFile;
        if (!file || !path.isAbsolute(file) || seenFiles.has(file)) continue;
        seenFiles.add(file);
        if (++headers > 256) {
          skip("Pi history", "history-header-budget");
          break;
        }
        const header = await readLocalHistoryHeader(file, options.cwd, candidate.id);
        sessionId = header.id;
        timestamp = header.timestamp ?? timestamp;
        incomplete = false;
        identity = `local:${file}:${sessionId}`;
      }
      const dedupe = `${remote ? `remote:${candidate.originDeviceId}` : "local"}:${sessionId}`;
      if (seenSessions.has(dedupe)) continue;
      const binding = { ...candidate, id: sessionId, cwd: options.cwd };
      if (options.canReadHistory && !await options.canReadHistory(binding)) {
        skip("Pi history", "history-owner-unavailable");
        continue;
      }
      seenSessions.add(dedupe);
      const id = `hist-${createHash("sha256").update(JSON.stringify([ownerKey, options.cwd, identity])).digest("hex").slice(0, 24)}`;
      const publicCandidate = {
        id,
        sessionId,
        kind: remote ? "retained" : "local",
        registered: !candidate.unregistered && !!candidate.id,
        ...typeof candidate.name === "string" ? { name: candidate.name.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256) } : {},
        ...typeof timestamp === "string" ? { timestamp } : {},
        incomplete
      };
      result.candidates.push(publicCandidate);
      result.bindings.set(id, binding);
      if (result.candidates.length >= 256) {
        skip("Pi history", "history-candidate-budget");
        break;
      }
    } catch (err) {
      if (options.signal.aborted) throw new Error("cancelled");
      const reason = err.message;
      if (reason === "time-budget") {
        skip("Pi history", "time-budget");
        break;
      }
      if (reason === "history-cwd-or-id-mismatch" && !candidate.id && !candidate.cwd) continue;
      const safe = ["history-cwd-or-id-mismatch", "unsafe-history-file", "invalid-history-header"].includes(reason) ? reason : "history-unreadable-or-malformed";
      skip("Pi history", safe);
    }
  }
  await options.revalidate();
  if (options.signal.aborted) throw new Error("cancelled");
  return result;
}
export {
  collectHistoryCandidates,
  discoverHistoryCandidates,
  readLocalHistoryHeader
};
