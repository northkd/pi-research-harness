import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { chunkMarkdown } from "./chunker.js";
import { resolveRowPath } from "./dox.js";
import { parseRows } from "./dox-triage.js";
import { readStaleness } from "./staleness.js";
const execFileAsync = promisify(execFile);
const RENAME_SCAN_TIMEOUT_MS = 2e3;
const SUBJECT_CAP = 8;
const HASH_CAP_BYTES = 1048576;
const COVERAGE_CAP_BYTES = 262144;
const WORST = { GONE: 0, MOVED: 1, STALE: 2, UNVERIFIED: 3, FRESH: 4 };
const nodeFs = {
  stat(p) {
    let s;
    try {
      s = statSync(p);
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  },
  read(p, cap) {
    const fd = openSync(p, "r");
    try {
      const size = Math.min(fstatSync(fd).size, cap);
      const buf = Buffer.alloc(size);
      let read = 0;
      while (read < size) {
        const n = readSync(fd, buf, read, size - read, read);
        if (n <= 0) break;
        read += n;
      }
      return buf.subarray(0, read);
    } finally {
      closeSync(fd);
    }
  }
};
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
function isBinary(buf) {
  return buf.subarray(0, 8e3).includes(0);
}
function insideRoot(abs, cwd) {
  return abs === cwd || abs.startsWith(cwd + sep);
}
function bodyOf(hit, ctx) {
  const inline = hit.body;
  if (typeof inline === "string") return inline;
  if (ctx.loadBody) {
    try {
      const loaded = ctx.loadBody(hit);
      if (loaded != null) return loaded;
    } catch {
      return "";
    }
  }
  return bodyFromDisk(hit, ctx.cwd);
}
function bodyFromDisk(hit, cwd) {
  try {
    const abs = resolve(cwd, hit.root, hit.path);
    if (!existsSync(abs)) return "";
    const parsed = chunkMarkdown({ root: hit.root, path: hit.path, text: readFileSync(abs, "utf8") });
    return parsed.chunks.find((c) => c.headingPath === hit.headingPath)?.body ?? "";
  } catch {
    return "";
  }
}
function isDoxSection(headingPath) {
  const leaf = headingPath.split(" > ").pop() ?? headingPath;
  return /^DOX\b/.test(leaf.trim());
}
function sectionSubjects(hit, ctx, bodyCache) {
  if (!isDoxSection(hit.headingPath)) return [];
  const cacheKey = `${hit.root}/${hit.path}/${hit.headingPath}`;
  let body = bodyCache.get(cacheKey);
  if (body === void 0) {
    body = bodyOf(hit, ctx);
    bodyCache.set(cacheKey, body);
  }
  const agentsAbs = resolve(ctx.cwd, hit.root, hit.path);
  const agentsDir = dirname(agentsAbs);
  const out = [];
  for (const row of parseRows(body)) {
    const abs = resolveRowPath(agentsDir, ctx.cwd, row.path);
    if (!insideRoot(abs, ctx.cwd)) continue;
    out.push({ abs, rel: relative(ctx.cwd, abs) });
  }
  return out;
}
function applyRenameRecord(map, parts, status, i) {
  if (!(status.startsWith("R") || status.startsWith("C"))) return i + 1;
  const from = parts[i];
  const to = parts[i + 1];
  if (!from || !to) return parts.length;
  const prev = map.get(from);
  if (prev === void 0) map.set(from, to);
  else if (prev !== to) map.set(from, "\0ambiguous");
  return i + 2;
}
function parseRenameRecords(out, map) {
  const parts = out.split("\0");
  let i = 0;
  while (i < parts.length) {
    const status = parts[i++];
    if (!status) break;
    i = applyRenameRecord(map, parts, status, i);
  }
}
async function runGit(cwd, git, args, signal) {
  if (git) return git(args, cwd);
  const { stdout } = await execFileAsync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: RENAME_SCAN_TIMEOUT_MS, signal });
  return stdout;
}
async function renameBatch(cwd, git, signal) {
  const map = /* @__PURE__ */ new Map();
  let out;
  try {
    out = await runGit(cwd, git, ["diff", "HEAD", "--name-status", "-M", "-z"], signal);
  } catch {
    return map;
  }
  parseRenameRecords(out, map);
  map.forEach((to, from) => {
    if (to === "\0ambiguous") map.delete(from);
  });
  return map;
}
function emptyCounts() {
  return { fresh: 0, stale: 0, moved: 0, gone: 0, unverified: 0, checked: 0, total: 0 };
}
function defaultAcks(cwd) {
  try {
    return readStaleness(resolve(cwd, ".pi", "dashboard", "kb", "dox-staleness.json"));
  } catch {
    return {};
  }
}
function labelExistingSubject(abs, st, ack, fs) {
  if (!ack?.sha256) return "UNVERIFIED";
  if (ack.size != null && ack.mtimeMs != null && ack.size === st.size && ack.mtimeMs === st.mtimeMs) {
    return "FRESH";
  }
  if (st.size > HASH_CAP_BYTES) return "UNVERIFIED";
  try {
    const buf = fs.read(abs, st.size);
    if (isBinary(buf)) return "UNVERIFIED";
    return sha256(buf) === ack.sha256 ? "FRESH" : "STALE";
  } catch {
    return "UNVERIFIED";
  }
}
const COUNT_KEY = {
  FRESH: "fresh",
  STALE: "stale",
  MOVED: "moved",
  GONE: "gone",
  UNVERIFIED: "unverified"
};
function absentLabel(rel, renames, movedTo) {
  const successor = renames.get(rel.split(sep).join("/"));
  if (successor) {
    movedTo.push(successor);
    return "MOVED";
  }
  return "GONE";
}
function verdictForHit(checked, total, stats, renames, acks, fs) {
  const counts = emptyCounts();
  counts.total = total;
  counts.checked = checked.length;
  const movedTo = [];
  const labels = [];
  for (let i = 0; i < checked.length; i++) {
    const s = checked[i];
    const st = stats[i];
    const relKey = s.rel.split(sep).join("/");
    let label;
    if (st === "unreadable") {
      label = "UNVERIFIED";
    } else if (st === null) {
      label = absentLabel(s.rel, renames, movedTo);
    } else {
      label = labelExistingSubject(s.abs, st, acks[relKey], fs);
    }
    labels.push(label);
    counts[COUNT_KEY[label]]++;
  }
  const worst = labels.reduce((w, l) => WORST[l] < WORST[w] ? l : w, "FRESH");
  const verdict = { label: worst, counts };
  if (movedTo.length) verdict.movedTo = movedTo;
  return verdict;
}
async function enrichOne(hit, ctx, fs, acks, bodyCache, getRenames) {
  if (hit.docType !== "agents") {
    hit.verdict = null;
    return;
  }
  const subjects = sectionSubjects(hit, ctx, bodyCache);
  if (subjects.length === 0) {
    hit.verdict = null;
    return;
  }
  const checked = subjects.slice(0, SUBJECT_CAP);
  const stats = [];
  for (const s of checked) {
    try {
      stats.push(fs.stat(s.abs));
    } catch {
      stats.push("unreadable");
    }
  }
  const renames = stats.some((s) => s === null) ? await getRenames() : /* @__PURE__ */ new Map();
  hit.verdict = verdictForHit(checked, subjects.length, stats, renames, acks, fs);
  if (ctx.coverage?.query) hit.coverage = coverageScore(checked, fs, ctx.coverage.query);
}
async function enrichHits(hits, ctx) {
  if (ctx.verdicts === false) return hits;
  const fs = ctx.fs ?? nodeFs;
  const acks = ctx.acks ?? defaultAcks(ctx.cwd);
  const pageBodyCache = /* @__PURE__ */ new Map();
  let renamesCache = null;
  const getRenames = () => renamesCache ??= renameBatch(ctx.cwd, ctx.git, ctx.signal);
  for (const hit of hits) await enrichOne(hit, ctx, fs, acks, pageBodyCache, getRenames);
  return hits;
}
function coverageScore(subjects, fs, query) {
  const terms = [...new Set(query.toLowerCase().split(/[^a-z0-9_]+/).filter((t) => t.length > 1))];
  if (!terms.length) return void 0;
  let matched = 0;
  for (const t of terms) if (termCovered(t, subjects, fs)) matched++;
  return matched / terms.length;
}
function termCovered(term, subjects, fs) {
  for (const s of subjects) {
    try {
      const buf = fs.read(s.abs, COVERAGE_CAP_BYTES);
      if (isBinary(buf)) continue;
      if (buf.toString("utf8").toLowerCase().includes(term)) return true;
    } catch {
      continue;
    }
  }
  return false;
}
export {
  COVERAGE_CAP_BYTES,
  HASH_CAP_BYTES,
  RENAME_SCAN_TIMEOUT_MS,
  SUBJECT_CAP,
  enrichHits
};
