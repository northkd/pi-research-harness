import { existsSync, linkSync, readdirSync, renameSync, statSync, unlinkSync, utimesSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import * as sqlite from "node:sqlite";
import { beginForcedSource, sourceGateIsStale, stampPass, stampSource } from "./index-gate.js";
import { indexSource } from "./indexer.js";
import { acceptSeed, copyStaleness, dropUnwalked, prepareSeed } from "./seed.js";
import { SCHEMA_VERSION, SqliteFtsStore } from "./sqlite-store.js";
const BUILDING_LINE = "(index is still being built \u2014 no results available yet; retry shortly)";
const LIVE_BUILD_WINDOW_MS = 12e4;
const FUTURE_SKEW_MS = 2e3;
const ORPHAN_AGE_MS = 60 * 6e4;
const HEARTBEAT_INTERVAL_MS = 3e4;
const DEFAULT_INSTALL_MAX_WAIT_MS = 3e4;
function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e?.code === "EPERM";
  }
}
function listTempBuilds(dbPath) {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.tmp-`;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const byPid = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (!e.startsWith(prefix)) continue;
    const rest = e.slice(prefix.length);
    const pid = Number(rest.split(/[.-]/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const abs = join(dir, e);
    const b = byPid.get(pid) ?? { pid, files: [], mtimeMs: 0 };
    b.files.push(abs);
    if (!e.endsWith("-shm")) {
      try {
        b.mtimeMs = Math.max(b.mtimeMs, statSync(abs).mtimeMs);
      } catch {
      }
    }
    byPid.set(pid, b);
  }
  return [...byPid.values()];
}
function isFirstIndexLive(dbPath, opts = {}) {
  const now = (opts.now ?? Date.now)();
  for (const b of listTempBuilds(dbPath)) {
    if (b.pid === process.pid) continue;
    const age = now - b.mtimeMs;
    if (age < -FUTURE_SKEW_MS || age > LIVE_BUILD_WINDOW_MS) continue;
    if (isProcessAlive(b.pid)) return true;
  }
  return false;
}
function sweepOrphanTemps(dbPath, opts = {}) {
  const now = (opts.now ?? Date.now)();
  for (const b of listTempBuilds(dbPath)) {
    const alive = b.pid === process.pid || isProcessAlive(b.pid);
    const abandoned = b.pid !== process.pid && now - b.mtimeMs > ORPHAN_AGE_MS;
    if (alive && !abandoned) continue;
    for (const f of b.files) {
      try {
        unlinkSync(f);
      } catch {
      }
    }
  }
}
function makeHeartbeat(tmpPath, deps = {}) {
  const now = deps.now ?? Date.now;
  const utimes = deps.utimes ?? utimesSync;
  const interval = deps.intervalMs ?? HEARTBEAT_INTERVAL_MS;
  let last = now();
  return () => {
    const n = now();
    if (n - last < interval) return;
    last = n;
    try {
      utimes(tmpPath, new Date(n), new Date(n));
    } catch {
    }
  };
}
const BACKUP_RETRY_CODES = /* @__PURE__ */ new Set([0, 5, 6]);
function removeTemp(tmp) {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(tmp + ext);
    } catch {
    }
  }
}
function installByLinkOrRename(tmp, dbPath, d) {
  try {
    d.linkSync(tmp, dbPath);
    removeTemp(tmp);
    return "link";
  } catch (e) {
    if (e?.code === "EEXIST" || d.existsSync(dbPath)) return null;
    d.renameSync(tmp, dbPath);
    removeTemp(tmp);
    return "rename";
  }
}
async function installByBackup(tmp, dbPath, d, t0) {
  const src = new sqlite.DatabaseSync(tmp);
  let retries = 0;
  let delay = 100;
  const fail = (reason) => {
    try {
      src.close();
    } catch {
    }
    removeTemp(tmp);
    d.log(`[kb] install-failed=${reason} retries=${retries} ms=${Math.max(0, Math.round(d.now() - t0))}`);
    throw new Error(`kb index: could not install the built index at ${dbPath} (${reason}); the existing database was left in place`);
  };
  const pages = Math.max(1, Number(src.prepare("PRAGMA page_count").get().page_count));
  for (; ; ) {
    try {
      await d.backup(src, dbPath, { rate: pages });
      src.close();
      removeTemp(tmp);
      return retries;
    } catch (err) {
      const errcode = err?.errcode;
      if (typeof errcode !== "number" || !BACKUP_RETRY_CODES.has(errcode)) return fail(`backup-error:${typeof errcode === "number" ? errcode : "unknown"}`);
      if (d.now() - t0 + delay > d.maxWaitMs) return fail("busy-timeout");
      await d.sleep(delay);
      retries++;
      delay = Math.min(delay * 2, 2e3);
    }
  }
}
async function installIndex(tmp, dbPath, overrides = {}) {
  const d = {
    linkSync,
    renameSync,
    existsSync,
    backup: (src, path, o) => sqlite.backup(src, path, o),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: Date.now,
    maxWaitMs: Number(process.env.KB_INSTALL_MAX_WAIT_MS) > 0 ? Number(process.env.KB_INSTALL_MAX_WAIT_MS) : DEFAULT_INSTALL_MAX_WAIT_MS,
    log: (l) => process.stderr.write(`${l}
`),
    ...Object.fromEntries(Object.entries(overrides).filter(([, v]) => v !== void 0))
  };
  const t0 = d.now();
  const done = (branch, retries) => {
    const ms = Math.max(0, Math.round(d.now() - t0));
    d.log(`[kb] install=${branch} retries=${retries} ms=${ms}`);
    return { branch, retries, ms };
  };
  const quick = installByLinkOrRename(tmp, dbPath, d);
  if (quick) return done(quick, 0);
  return done("backup", await installByBackup(tmp, dbPath, d, t0));
}
function assertIndexable(sources, explicit) {
  if (explicit) {
    for (const s of sources) {
      if (!existsSync(s.dir)) throw new Error(`kb index: --source directory does not exist: ${s.dir}`);
    }
  }
  if (!sources.some((s) => existsSync(s.dir))) {
    throw new Error("kb index: no configured source directory exists");
  }
}
function legacyGateStale(store, facetConfigHash) {
  const ver = store.getUserVersion?.() ?? 0;
  const storedHash = store.getMeta?.("facetConfigHash") ?? null;
  return ver < SCHEMA_VERSION || facetConfigHash != null && storedHash !== facetConfigHash;
}
class SeededBuildError extends Error {
  original;
  constructor(original) {
    super(original instanceof Error ? original.message : String(original));
    this.original = original;
  }
}
async function runIndexAtomic(opts) {
  const { dbPath, sources } = opts;
  assertIndexable(sources, opts.explicit);
  sweepOrphanTemps(dbPath);
  const preexisting = existsSync(dbPath);
  if (preexisting || !opts.seed) return build(opts, preexisting, null);
  const tmp = `${dbPath}.tmp-${process.pid}`;
  const seedLog = opts.seedLog ?? ((line) => process.stderr.write(`${line}
`));
  const prep = opts.gate && !opts.indexOpts?.force ? prepareSeed(opts.seed, tmp, isFirstIndexLive) : { ok: false, reason: "disabled" };
  if (!prep.ok) {
    const r = await build(opts, false, null);
    seedLog(`[kb] seed-skipped=${prep.reason}`);
    return r;
  }
  try {
    return await build(opts, false, prep);
  } catch (e) {
    if (!(e instanceof SeededBuildError)) throw e;
    const r = await build(opts, false, null);
    seedLog("[kb] seed-skipped=snapshot-error");
    return r;
  }
}
async function walkOne(store, opts, s, preexisting, legacyStale, heartbeat) {
  const { indexOpts, gate } = opts;
  const force = !!indexOpts?.force || legacyStale || !!gate && preexisting && sourceGateIsStale(store, gate, s.id);
  const onFirstBatch = force && gate ? beginForcedSource(store, s.id) : void 0;
  const st = await indexSource(store, { root: s.id, dir: s.dir }, { ...indexOpts, force, heartbeat, onFirstBatch });
  if (gate && !st.missing) stampSource(store, gate, s.id);
  return st;
}
async function walkSources(store, opts, preexisting, legacyStale, heartbeat, seeded) {
  const { sources } = opts;
  const total = { scanned: 0, changed: 0, deleted: 0, chunks: 0, parseFailures: 0 };
  let keptRoots = seeded && opts.gate ? acceptSeed(store, opts.gate, sources.map((s) => s.id)) : [];
  const missing = [];
  for (const s of sources) {
    const st = await walkOne(store, opts, s, preexisting, legacyStale, heartbeat);
    if (st.missing) missing.push(s.id);
    total.scanned += st.scanned;
    total.changed += st.changed;
    total.deleted += st.deleted;
    total.chunks += st.chunks;
    total.parseFailures = (total.parseFailures ?? 0) + (st.parseFailures ?? 0);
  }
  if (seeded) {
    dropUnwalked(store, missing);
    keptRoots = keptRoots.filter((r) => !missing.includes(r));
  }
  return { total, keptRoots };
}
async function build(opts, preexisting, prep) {
  const { dbPath, sources } = opts;
  const target = preexisting ? dbPath : `${dbPath}.tmp-${process.pid}`;
  const store = new SqliteFtsStore(target);
  store.init();
  const legacyStale = preexisting && !opts.gate && legacyGateStale(store, opts.facetConfigHash);
  const heartbeat = preexisting ? void 0 : makeHeartbeat(target, opts.heartbeat);
  let ok = false;
  try {
    let walked;
    try {
      walked = await walkSources(store, opts, preexisting, legacyStale, heartbeat, prep !== null);
    } catch (e) {
      throw prep ? new SeededBuildError(e) : e;
    }
    const counts = store.counts();
    stampAfterPass(store, opts);
    if (preexisting) store.close();
    else {
      store.checkpointAndClose();
      await installIndex(target, dbPath, { log: opts.log, ...opts.install });
    }
    ok = true;
    if (prep && opts.seed) {
      const seedLog = opts.seedLog ?? ((line) => process.stderr.write(`${line}
`));
      seedLog(`[kb] seed=${prep.main} sources=${walked.keptRoots.length}/${sources.length}`);
      copyStaleness(prep.main, prep.cwdRel, opts.seed.cwd, seedLog);
    }
    return { ...walked.total, counts };
  } finally {
    if (!ok) discardFailedRun(store, preexisting);
  }
}
function stampAfterPass(store, opts) {
  if (opts.gate) stampPass(store, opts.gate);
  else {
    store.setUserVersion?.(SCHEMA_VERSION);
    if (opts.facetConfigHash != null) store.setMeta?.("facetConfigHash", opts.facetConfigHash);
  }
}
function discardFailedRun(store, preexisting) {
  if (preexisting) {
    try {
      store.close();
    } catch {
    }
  } else {
    store.closeAndUnlink();
  }
}
export {
  BUILDING_LINE,
  installIndex,
  isFirstIndexLive,
  makeHeartbeat,
  runIndexAtomic,
  sweepOrphanTemps
};
