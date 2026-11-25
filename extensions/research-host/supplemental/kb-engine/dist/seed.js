import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import * as sqlite from "node:sqlite";
import { sourceIsSeedable } from "./index-gate.js";
import { STALENESS_VERSION } from "./staleness.js";
function seedOptionsFromConfig(cfg, o = {}) {
  return {
    enabled: cfg.seedFromMainWorktree !== false && !o.noSeed && !o.explicitSources,
    cwd: cfg.cwd,
    dbAbsPath: cfg.dbAbsPath,
    customDb: !!o.customDb
  };
}
const GIT_TIMEOUT_MS = 2e3;
const CONFIG_UNSET = 1;
function git(cwd, args) {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", timeout: GIT_TIMEOUT_MS, stdio: ["ignore", "pipe", "ignore"] }).trim();
    return { ok: true, out };
  } catch (e) {
    const status = e.status;
    return { ok: false, status: typeof status === "number" ? status : null };
  }
}
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";
function canon(p) {
  let r;
  try {
    r = realpathSync.native(p);
  } catch {
    r = resolve(p);
  }
  while (r.length > 1 && r.endsWith(sep)) r = r.slice(0, -1);
  return FOLD_CASE ? r.toLowerCase() : r;
}
function findMainCheckout(cwd) {
  const dirs = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
  if (!dirs.ok) return { status: "not-a-worktree" };
  const [gitDir, commonDir, ...extra] = dirs.out.split("\n");
  if (extra.length || !gitDir || !commonDir || !isAbsolute(gitDir) || !isAbsolute(commonDir)) return { status: "no-main-checkout" };
  if (canon(gitDir) === canon(commonDir)) return { status: "not-a-worktree" };
  const top = git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]);
  if (!top.ok || !isAbsolute(top.out)) return { status: "no-main-checkout" };
  const main = mainPathFromConfig(cwd, commonDir);
  if (main === null || !isSameRepoOtherCheckout(main, top.out, commonDir)) return { status: "no-main-checkout" };
  return { status: "ok", main, toplevel: top.out };
}
function mainPathFromConfig(cwd, common) {
  const cfgFile = join(common, "config");
  const wt = git(cwd, ["config", "--file", cfgFile, "--get", "core.worktree"]);
  if (wt.ok) return resolve(common, wt.out);
  if (wt.status !== CONFIG_UNSET || basename(common) !== ".git") return null;
  const bare = git(cwd, ["config", "--file", cfgFile, "--type=bool", "--get", "core.bare"]);
  const notBare = bare.ok ? bare.out === "false" : bare.status === CONFIG_UNSET;
  return notBare ? dirname(common) : null;
}
function isSameRepoOtherCheckout(main, toplevel, common) {
  try {
    if (!statSync(main).isDirectory()) return false;
  } catch {
    return false;
  }
  if (canon(main) === canon(toplevel)) return false;
  const theirs = git(main, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return theirs.ok && canon(theirs.out) === canon(common);
}
function realpathLoose(p) {
  const rest = [];
  let cur = resolve(p);
  for (; ; ) {
    try {
      return join(realpathSync.native(cur), ...rest.reverse());
    } catch {
      const up = dirname(cur);
      if (up === cur) return resolve(p);
      rest.push(basename(cur));
      cur = up;
    }
  }
}
const inside = (rel) => rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
function removeDb(path) {
  for (const ext of ["", "-wal", "-shm"]) {
    try {
      unlinkSync(path + ext);
    } catch {
    }
  }
}
function prepareSeed(opts, tmpPath, isBuilding) {
  if (!opts.enabled) return { ok: false, reason: "disabled" };
  const found = findMainCheckout(opts.cwd);
  if (found.status !== "ok") return { ok: false, reason: found.status };
  const dbRel = relative(realpathLoose(found.toplevel), realpathLoose(opts.dbAbsPath));
  if (opts.customDb || !inside(dbRel)) return { ok: false, reason: "custom-dbpath" };
  const seedDb = join(found.main, dbRel);
  let size = 0;
  try {
    size = statSync(seedDb).size;
  } catch {
  }
  if (size === 0) return { ok: false, reason: isBuilding(seedDb) ? "main-building" : "no-main-index" };
  try {
    removeDb(tmpPath);
    mkdirSync(dirname(tmpPath), { recursive: true });
    const db = new sqlite.DatabaseSync(seedDb);
    try {
      db.exec("PRAGMA busy_timeout=2000");
      db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } finally {
      db.close();
    }
  } catch {
    removeDb(tmpPath);
    return { ok: false, reason: "snapshot-error" };
  }
  return { ok: true, main: found.main, toplevel: found.toplevel, cwdRel: relative(realpathLoose(found.toplevel), realpathLoose(opts.cwd)) };
}
function acceptSeed(store, gate, passedRoots) {
  store.reconcileChunkMap();
  const passed = new Set(passedRoots);
  const kept = [];
  for (const root of store.rootsPresent()) {
    if (passed.has(root) && sourceIsSeedable(store, gate, root)) kept.push(root);
    else store.dropRoot(root);
  }
  store.invalidateMtimes(kept);
  return kept;
}
function dropUnwalked(store, missingRoots) {
  for (const r of missingRoots) store.dropRoot(r);
  store.sweepPlaceholders();
}
const STALENESS_REL = join(".pi", "dashboard", "kb", "dox-staleness.json");
function copyStaleness(main, cwdRel, cwd, log) {
  const src = join(main, cwdRel, STALENESS_REL);
  const target = join(cwd, STALENESS_REL);
  try {
    if (!existsSync(src) || existsSync(target)) return;
    let raw;
    try {
      raw = JSON.parse(readFileSync(src, "utf8"));
    } catch {
      return;
    }
    if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return;
    const version = raw.version;
    if ("version" in raw && version !== STALENESS_VERSION) return;
    mkdirSync(dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    try {
      copyFileSync(src, tmp);
      renameSync(tmp, target);
    } catch (e) {
      try {
        unlinkSync(tmp);
      } catch {
      }
      throw e;
    }
  } catch (e) {
    log(`[kb] seed-staleness-skipped=${e?.code ?? "error"}`);
  }
}
export {
  acceptSeed,
  copyStaleness,
  dropUnwalked,
  findMainCheckout,
  prepareSeed,
  seedOptionsFromConfig
};
