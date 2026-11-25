import fs from "node:fs";
import path from "node:path";
const DEFAULT_RETENTION = 100;
function countFindings(result) {
  let n = 0;
  for (const line of result.split("\n")) {
    if (/^[-*] +\S/.test(line)) n++;
  }
  return n;
}
function runsRootFor(scopeBase) {
  return path.join(scopeBase, ".pi", "automation", "runs");
}
let _runSeq = 0;
function makeRunId(name, at = /* @__PURE__ */ new Date()) {
  const iso = at.toISOString();
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 19).replace(/:/g, "");
  const seq = (_runSeq = (_runSeq + 1) % 1e5).toString().padStart(5, "0");
  return `${date}-${time}-${name}-${seq}`;
}
function runDir(scopeBase, runId) {
  return path.join(runsRootFor(scopeBase), runId);
}
function readRecord(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, "run.json"), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
function isSafeRunId(runId) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(runId) && !runId.includes("..");
}
function resolveRunDir(scopeBase, runId) {
  if (!isSafeRunId(runId)) return null;
  const top = runDir(scopeBase, runId);
  if (fs.existsSync(path.join(top, "run.json"))) return top;
  const root = runsRootFor(scopeBase);
  let parents;
  try {
    parents = fs.readdirSync(root);
  } catch {
    return null;
  }
  for (const p of parents) {
    const childDir = path.join(root, p, runId);
    if (fs.existsSync(path.join(childDir, "run.json"))) return childDir;
  }
  return null;
}
function writeRecordAt(dir, rec) {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, "run.json.tmp");
  fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}
`);
  fs.renameSync(tmp, path.join(dir, "run.json"));
}
function writeRecord(scopeBase, rec) {
  writeRecordAt(runDir(scopeBase, rec.runId), rec);
}
function startRun(scopeBase, name, opts = {}) {
  const runId = opts.runId ?? makeRunId(name, opts.at);
  const rec = {
    runId,
    name,
    status: "running",
    dir: runDir(scopeBase, runId),
    startedAt: (opts.at ?? /* @__PURE__ */ new Date()).getTime(),
    ...opts.sessionId ? { sessionId: opts.sessionId } : {}
  };
  writeRecord(scopeBase, rec);
  return rec;
}
function startParentRun(scopeBase, name, opts = {}) {
  const runId = opts.runId ?? makeRunId(name, opts.at);
  const rec = {
    runId,
    name,
    status: "running",
    dir: runDir(scopeBase, runId),
    startedAt: (opts.at ?? /* @__PURE__ */ new Date()).getTime(),
    children: [],
    ...opts.warning ? { warning: opts.warning } : {}
  };
  writeRecord(scopeBase, rec);
  return rec;
}
function startChildRun(scopeBase, parentRunId, name, opts = {}) {
  const childRunId = opts.runId ?? makeRunId(name, opts.at);
  const childDir = path.join(runDir(scopeBase, parentRunId), childRunId);
  const rec = {
    runId: childRunId,
    name,
    status: "running",
    dir: childDir,
    startedAt: (opts.at ?? /* @__PURE__ */ new Date()).getTime(),
    parentRunId,
    ...opts.sessionId ? { sessionId: opts.sessionId } : {},
    ...opts.actionLabel ? { actionLabel: opts.actionLabel } : {}
  };
  writeRecordAt(childDir, rec);
  const parentDir = runDir(scopeBase, parentRunId);
  const parent = readRecord(parentDir);
  if (parent) {
    const children = parent.children ?? [];
    if (!children.includes(childRunId)) children.push(childRunId);
    writeRecordAt(parentDir, { ...parent, children });
  }
  return rec;
}
function setSessionId(scopeBase, runId, sessionId) {
  const dir = resolveRunDir(scopeBase, runId);
  if (!dir) return;
  const rec = readRecord(dir);
  if (!rec) return;
  writeRecordAt(dir, { ...rec, sessionId });
}
function finishRun(scopeBase, runId, opts) {
  const dir = resolveRunDir(scopeBase, runId);
  if (!dir) return null;
  const existing = readRecord(dir);
  if (!existing) return null;
  const result = (opts.result ?? "").trim();
  fs.writeFileSync(path.join(dir, "result.md"), result + (result ? "\n" : ""));
  const archived = result.length === 0;
  const findings = archived ? 0 : countFindings(result);
  const rec = {
    ...existing,
    status: opts.status,
    endedAt: (opts.at ?? /* @__PURE__ */ new Date()).getTime(),
    findings,
    ...archived ? { archived: true } : {},
    ...opts.error ? { error: opts.error } : {}
  };
  writeRecordAt(dir, rec);
  pruneRuns(scopeBase, existing.name, opts.retention ?? DEFAULT_RETENTION);
  return rec;
}
function finishParentRun(scopeBase, parentRunId, opts) {
  const dir = runDir(scopeBase, parentRunId);
  const existing = readRecord(dir);
  if (!existing) return null;
  const rec = {
    ...existing,
    status: opts.status,
    endedAt: (opts.at ?? /* @__PURE__ */ new Date()).getTime(),
    findings: opts.findings,
    ...opts.warning ? { warning: opts.warning } : {},
    ...opts.error ? { error: opts.error } : {}
  };
  writeRecordAt(dir, rec);
  pruneRuns(scopeBase, existing.name, opts.retention ?? DEFAULT_RETENTION);
  return rec;
}
function readChildRuns(scopeBase, parent) {
  const out = [];
  for (const childId of parent.children ?? []) {
    const childDir = path.join(runDir(scopeBase, parent.runId), childId);
    const rec = readRecord(childDir);
    if (rec) out.push(rec);
  }
  return out;
}
function findRunBySessionId(scopeBase, sessionId) {
  if (!sessionId) return null;
  for (const rec of listRuns(scopeBase)) {
    if (rec.sessionId === sessionId) return rec;
    if (rec.children) {
      const child = readChildRuns(scopeBase, rec).find((c) => c.sessionId === sessionId);
      if (child) return child;
    }
  }
  return null;
}
function listRuns(scopeBase, name) {
  const root = runsRootFor(scopeBase);
  let dirs;
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return [];
  }
  const recs = [];
  for (const d of dirs) {
    const rec = readRecord(path.join(root, d));
    if (!rec) continue;
    if (name && rec.name !== name) continue;
    recs.push(rec);
  }
  recs.sort((a, b) => a.startedAt - b.startedAt);
  return recs;
}
function listStaleRunningRuns(scopeBase, maxAgeMs, now = Date.now()) {
  const stale = [];
  for (const rec of listRuns(scopeBase)) {
    if (rec.children) {
      for (const child of readChildRuns(scopeBase, rec)) {
        if (child.status === "running" && now - child.startedAt > maxAgeMs) stale.push(child);
      }
      continue;
    }
    if (rec.status === "running" && now - rec.startedAt > maxAgeMs) stale.push(rec);
  }
  return stale;
}
function pruneRuns(scopeBase, name, retention = DEFAULT_RETENTION) {
  const prunable = listRuns(scopeBase, name).filter((r) => r.status !== "running");
  const overflow = prunable.length - retention;
  if (overflow <= 0) return 0;
  let pruned = 0;
  for (let i = 0; i < overflow; i++) {
    const rec = prunable[i];
    try {
      fs.rmSync(rec.dir, { recursive: true, force: true });
      pruned++;
    } catch {
    }
  }
  return pruned;
}
export {
  DEFAULT_RETENTION,
  countFindings,
  findRunBySessionId,
  finishParentRun,
  finishRun,
  isSafeRunId,
  listRuns,
  listStaleRunningRuns,
  makeRunId,
  pruneRuns,
  readChildRuns,
  resolveRunDir,
  runsRootFor,
  setSessionId,
  startChildRun,
  startParentRun,
  startRun
};
