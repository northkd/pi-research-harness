// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/access/access-grants.ts
import * as fs2 from "node:fs";
import * as path2 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/forbidden-subjects.ts
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/paths.ts
function isDriveLetterForm(value) {
  return /^[A-Za-z]:(?![\\/])/.test(value);
}
function driveLetterPrefix(value) {
  const m = value.match(/^([A-Za-z]:)(?![\\/])/);
  return m ? m[1] : null;
}
function getRoot(p, platform) {
  if (platform === "win32") {
    const unc = p.match(/^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)(?:[\\/]|$)/);
    if (unc) return `\\\\${unc[1]}\\${unc[2]}\\`;
    const drive = p.match(/^([A-Za-z]:)[\\/]/);
    if (drive) return `${drive[1]}\\`;
    return "";
  }
  return p.startsWith("/") ? "/" : "";
}
function normalizeSegments(rest, sep) {
  const split = rest.split(/[\\/]+/).filter((s) => s.length > 0);
  const out = [];
  for (const seg of split) {
    if (seg === ".") continue;
    if (seg === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      continue;
    }
    out.push(seg);
  }
  return out;
}
function normalizePath(p, platform = process.platform) {
  if (!p) return p;
  if (platform === "win32") {
    if (isDriveLetterForm(p)) {
      const prefix = driveLetterPrefix(p);
      const rest = p.slice(prefix.length);
      if (!rest) return prefix + "\\";
      return normalizePath(prefix + "\\" + rest, "win32");
    }
    const root2 = getRoot(p, "win32");
    if (root2) {
      const rest = p.slice(root2.length);
      const segments3 = normalizeSegments(rest, "\\");
      if (segments3.length === 0) return root2;
      return root2 + segments3.join("\\");
    }
    const segments2 = normalizeSegments(p, "\\");
    return segments2.join("\\");
  }
  const root = getRoot(p, platform);
  if (root) {
    const segments2 = normalizeSegments(p.slice(root.length), "/");
    if (segments2.length === 0) return root;
    return root + segments2.join("/");
  }
  const segments = normalizeSegments(p, "/");
  return segments.join("/");
}
function samePath(a, b, platform = process.platform) {
  if (!a || !b) return a === b;
  const na = normalizePath(a, platform);
  const nb = normalizePath(b, platform);
  if (platform === "linux") return na === nb;
  return na.toLowerCase() === nb.toLowerCase();
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/forbidden-subjects.ts
function realpathNearestAncestor(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    const parent = path.dirname(p);
    if (parent === p) return p;
    return path.join(realpathNearestAncestor(parent), path.basename(p));
  }
}
var POSIX_SYSTEM_DIRS = ["/etc", "/usr", "/var", "/Library", "/System", "/bin", "/sbin", "/opt"];
var WINDOWS_SYSTEM_DIRS = [
  ["SystemRoot", "C:\\Windows"],
  ["ProgramFiles", "C:\\Program Files"],
  ["ProgramFiles(x86)", "C:\\Program Files (x86)"],
  ["ProgramData", "C:\\ProgramData"]
];
function pathOps(env) {
  const platform = env?.platform ?? process.platform;
  const windows = platform === "win32";
  const p = windows ? path.win32 : path.posix;
  const hostIsWindows = process.platform === "win32";
  const canonical = (x) => {
    const resolved = p.resolve(x);
    return windows === hostIsWindows ? realpathNearestAncestor(resolved) : resolved;
  };
  const same = (a, b) => samePath(a, b, platform);
  return { platform, windows, p, canonical, same };
}
function forbiddenGrantSubjects(env) {
  const { windows, p, canonical } = pathOps(env);
  const vars = env?.env ?? process.env;
  const home = env?.homedir ?? os.homedir();
  const system = windows ? WINDOWS_SYSTEM_DIRS.map(([name, fallback]) => vars[name] || fallback) : POSIX_SYSTEM_DIRS;
  const root = windows ? p.parse(p.resolve(vars.SystemRoot || "C:\\")).root : "/";
  const whole = [root, home, ...system];
  const sensitive = [p.join(home, ".ssh"), p.join(home, ".pi")];
  return { whole: whole.map(canonical), sensitive: sensitive.map(canonical) };
}
function isForbiddenGrantSubject(subject, env, sets) {
  const ops = pathOps(env);
  const real = ops.canonical(subject);
  const { whole, sensitive } = sets ?? forbiddenGrantSubjects(env);
  if (whole.some((f) => ops.same(real, f))) return true;
  return sensitive.some((forbidden) => subsumes(forbidden, real, ops));
}
function subsumes(candidate, other, ops) {
  if (ops.same(candidate, other)) return true;
  const rel = ops.p.relative(candidate, other);
  return rel !== "" && !rel.startsWith("..") && !ops.p.isAbsolute(rel);
}
function subsumesForbiddenGrantSubject(candidate, env, sets) {
  const ops = pathOps(env);
  const real = ops.canonical(candidate);
  const { whole, sensitive } = sets ?? forbiddenGrantSubjects(env);
  return [...whole, ...sensitive].some((forbidden) => subsumes(real, forbidden, ops));
}
function isUngrantableSubject(subject, env) {
  const sets = forbiddenGrantSubjects(env);
  return isForbiddenGrantSubject(subject, env, sets) || subsumesForbiddenGrantSubject(subject, env, sets);
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/access/access-grants.ts
function createAccessGrantStore({ storeFile, homedir, onChanged }) {
  const isUngrantableSubject2 = (subject) => isUngrantableSubject(subject, { homedir });
  let grantsChanged;
  function setGrantsChangedListener(fn) {
    grantsChanged = fn;
  }
  function notifyGrantsChanged() {
    try {
      grantsChanged?.();
    } catch {
    }
  }
  const GRANT_CAP_PER_SCOPE = 200;
  function accessGrantsStorePath() {
    return storeFile;
  }
  let cache = null;
  const sessionGrants = [];
  function __resetAccessGrants() {
    cache = null;
    sessionGrants.length = 0;
    loadCount = 0;
  }
  let loadCount = 0;
  function __accessGrantsLoadCount() {
    return loadCount;
  }
  function emptyStore() {
    return [];
  }
  function loadFromDisk() {
    loadCount += 1;
    let raw;
    try {
      raw = fs2.readFileSync(accessGrantsStorePath(), "utf8");
    } catch (err) {
      if (err?.code !== "ENOENT") {
        console.warn(`[access-grants] store unreadable: ${err?.message}`);
      }
      return emptyStore();
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      console.warn("[access-grants] store is not valid JSON \u2014 treating as empty");
      return emptyStore();
    }
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.grants)) return emptyStore();
    if (parsed.version !== 1) {
      console.warn(`[access-grants] unknown store version ${String(parsed.version)} \u2014 refusing to read`);
      return emptyStore();
    }
    const valid = parsed.grants.filter(
      (g) => !!g && typeof g === "object" && typeof g.subject === "string" && g.subject.length > 0 && // Only `project` scope is persisted. Accepting a `session` entry here
      // would resurrect it across restarts (contradicting "session = until
      // server restart") and leave it unrevocable through the scoped API,
      // which only touches the in-memory list.
      g.scope === "project" && // `NaN`/`Infinity` pass a bare `typeof` check and would poison the
      // eviction sort, so require a finite number.
      typeof g.grantedAt === "number" && Number.isFinite(g.grantedAt)
    ).map((g) => ({ ...g, origin: typeof g.origin === "string" ? g.origin : "unknown" })).filter((g) => !isUngrantableSubject2(g.subject));
    enforceCap(valid, "project");
    return valid;
  }
  function persisted() {
    if (cache === null) cache = loadFromDisk();
    return cache;
  }
  function realpathNearestAncestor3(p) {
    try {
      return fs2.realpathSync(p);
    } catch {
      const parent = path2.dirname(p);
      if (parent === p) return p;
      return path2.join(realpathNearestAncestor3(parent), path2.basename(p));
    }
  }
  function normalizeGrantSubject(input) {
    const real = realpathNearestAncestor3(path2.resolve(input));
    try {
      if (!fs2.statSync(real).isDirectory()) return path2.dirname(real);
    } catch {
    }
    return real;
  }
  function listGrants() {
    return [...persisted(), ...sessionGrants];
  }
  function grantedSubjects() {
    const seen = /* @__PURE__ */ new Set();
    for (const g of persisted()) seen.add(g.subject);
    for (const g of sessionGrants) seen.add(g.subject);
    return [...seen];
  }
  function enforceCap(grants, scope, protect) {
    const inScope = grants.filter((g) => g.scope === scope);
    if (inScope.length <= GRANT_CAP_PER_SCOPE) return;
    const excess = inScope.length - GRANT_CAP_PER_SCOPE;
    const evictOrder = inScope.filter((g) => g !== protect).map((g, i) => ({ g, i })).sort((a, b) => a.g.grantedAt - b.g.grantedAt || a.i - b.i).slice(0, excess).map((x) => x.g);
    const doomed = new Set(evictOrder);
    for (let i = grants.length - 1; i >= 0; i -= 1) {
      if (doomed.has(grants[i])) grants.splice(i, 1);
    }
  }
  function writeAtomic(target, contents) {
    const dir = path2.dirname(target);
    fs2.mkdirSync(dir, { recursive: true });
    const tmp = path2.join(dir, `.${path2.basename(target)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs2.writeFileSync(tmp, contents, "utf8");
      fs2.renameSync(tmp, target);
    } catch (err) {
      try {
        fs2.rmSync(tmp, { force: true });
      } catch {
      }
      throw err;
    }
  }
  function buildGrant(base, widenedFrom, via) {
    const grant = { ...base };
    if (widenedFrom) grant.widenedFrom = widenedFrom;
    if (via) grant.via = via;
    return grant;
  }
  function recordGrant(input) {
    const scope = input.scope ?? "project";
    const origin = input.origin ?? "unknown";
    const subject = normalizeGrantSubject(input.subject);
    const grantedAt = input.now ?? Date.now();
    if (isUngrantableSubject2(subject)) {
      return { ok: false, error: "forbidden subject" };
    }
    const widen = input.widenedFrom && normalizeGrantSubject(input.widenedFrom) !== subject ? normalizeGrantSubject(input.widenedFrom) : void 0;
    if (scope === "session") {
      const existing2 = sessionGrants.find((g) => g.subject === subject);
      if (existing2) return { ok: true, grant: existing2 };
      const grant2 = buildGrant({ subject, scope, grantedAt, origin }, widen, input.via);
      sessionGrants.push(grant2);
      enforceCap(sessionGrants, "session", grant2);
      return { ok: true, grant: grant2 };
    }
    const grants = [...persisted()];
    const existing = grants.find((g) => g.subject === subject);
    if (existing) return { ok: true, grant: existing };
    const grant = buildGrant({ subject, scope, grantedAt, origin }, widen, input.via);
    grants.push(grant);
    enforceCap(grants, "project", grant);
    const file = { version: 1, grants };
    try {
      writeAtomic(accessGrantsStorePath(), JSON.stringify(file, null, 2));
    } catch (err) {
      console.warn(
        `[access-grants] failed to persist grant for ${subject}: ${err?.message}`
      );
      return { ok: false, error: err?.message ?? "write failed" };
    }
    cache = grants;
    notifyGrantsChanged();
    return { ok: true, grant };
  }
  function revokeGrant(subject, scope) {
    const target = normalizeGrantSubject(subject);
    let removed = false;
    if (scope !== "project") {
      for (let i = sessionGrants.length - 1; i >= 0; i -= 1) {
        if (sessionGrants[i].subject === target) {
          sessionGrants.splice(i, 1);
          removed = true;
        }
      }
    }
    if (scope === "session") return removed;
    const grants = persisted();
    const kept = grants.filter((g) => g.subject !== target);
    if (kept.length === grants.length) return removed;
    try {
      writeAtomic(accessGrantsStorePath(), JSON.stringify({ version: 1, grants: kept }, null, 2));
    } catch (err) {
      console.warn(
        `[access-grants] failed to persist revoke for ${target}: ${err?.message}`
      );
      return false;
    }
    cache = kept;
    notifyGrantsChanged();
    return true;
  }
  setGrantsChangedListener(onChanged);
  return { listGrants, grantedSubjects, recordGrant, revokeGrant, normalizeGrantSubject, accessGrantsStorePath };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/path-containment.ts
import fs3 from "node:fs/promises";
import path9 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/git.ts
import { realpath as fsRealpath } from "node:fs/promises";
import path8 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/runner.ts
import { existsSync as existsSync4 } from "node:fs";
import path7 from "node:path";
import { StringDecoder } from "node:string_decoder";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/binary-lookup.ts
import { existsSync as existsSync3, realpathSync as realpathSync3 } from "node:fs";
import os3 from "node:os";
import path6 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/managed-paths.ts
import path3 from "node:path";
import os2 from "node:os";
function getManagedDir(env) {
  return path3.join(env?.homedir ?? os2.homedir(), ".pi-dashboard");
}
function getManagedBin(env) {
  return path3.join(getManagedDir(env), "node_modules", ".bin");
}
function getPiSettingsPath(env) {
  return path3.join(env?.homedir ?? os2.homedir(), ".pi", "agent", "settings.json");
}
var MANAGED_DIR = getManagedDir();
var MANAGED_BIN = getManagedBin();
var PI_SETTINGS_PATH = getPiSettingsPath();

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/ensure-windows-path.ts
import { existsSync } from "node:fs";
import path4 from "node:path";
function ensureWindowsSystemPath(env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  const exists = opts.exists ?? existsSync;
  const systemRoot = env.SYSTEMROOT || env.SystemRoot || env.systemroot || "C:\\Windows";
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || env.localappdata || "";
  const join2 = path4.win32.join;
  const candidates = [
    join2(systemRoot, "System32"),
    systemRoot,
    join2(systemRoot, "System32", "Wbem"),
    join2(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    join2(systemRoot, "System32", "OpenSSH")
  ];
  if (localAppData) {
    candidates.push(join2(localAppData, "Microsoft", "WindowsApps"));
  }
  const currentPath = env.PATH ?? "";
  const currentLower = currentPath.toLowerCase();
  const addedLower = /* @__PURE__ */ new Set();
  const toAdd = [];
  for (const dir of candidates) {
    if (!exists(dir)) continue;
    const dirLower = dir.toLowerCase();
    if (currentLower.includes(dirLower)) continue;
    if (addedLower.has(dirLower)) continue;
    addedLower.add(dirLower);
    toAdd.push(dir);
  }
  if (toAdd.length === 0) return env;
  const DELIM = ";";
  const newPath = currentPath ? `${toAdd.join(DELIM)}${DELIM}${currentPath}` : toAdd.join(DELIM);
  return { ...env, PATH: newPath };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/env-path-key.ts
function normalizeEnvPathKey(env, platform = process.platform) {
  if (platform !== "win32") return env;
  const variants = Object.keys(env).filter((k) => k.toUpperCase() === "PATH");
  if (variants.length === 0) return env;
  if (variants.length === 1 && variants[0] === "PATH" && typeof env.PATH === "string") return env;
  const ordered = [
    ...variants.filter((k) => k === "PATH"),
    ...variants.filter((k) => k !== "PATH").sort()
  ];
  const values = ordered.map((k) => env[k]).filter((v) => typeof v === "string");
  const out = { ...env };
  for (const key of variants) delete out[key];
  if (values.length > 0) out.PATH = mergePathEntries(values);
  return out;
}
function mergePathEntries(values) {
  const seen = /* @__PURE__ */ new Set();
  const entries = [];
  for (const entry of values.flatMap((v) => v.split(";"))) {
    const lower = entry.toLowerCase();
    if (entry === "" || seen.has(lower)) continue;
    seen.add(lower);
    entries.push(entry);
  }
  return entries.join(";");
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/exec.ts
import {
  execSync as nodeExecSync,
  execFileSync as nodeExecFileSync,
  exec as nodeExec,
  execFile as nodeExecFile,
  spawnSync as nodeSpawnSync,
  spawn as nodeSpawn
} from "node:child_process";
function buildSafeArgv(cmd, args = [], platform = process.platform) {
  if (platform === "win32") {
    const isShim = /\.(cmd|bat)$/i.test(cmd);
    const hasExtension = /\.[A-Za-z0-9]+$/.test(cmd);
    if (isShim || !hasExtension) {
      return {
        argv: ["cmd.exe", "/d", "/s", "/c", cmd, ...args],
        spawnOptions: { shell: false, windowsHide: true }
      };
    }
  }
  return {
    argv: [cmd, ...args],
    spawnOptions: { shell: false, windowsHide: true }
  };
}
function withHide(opts) {
  const hide = opts?.windowsHide ?? true;
  return { ...opts ?? {}, windowsHide: hide };
}
function execSync(command, options) {
  return nodeExecSync(command, withHide(options));
}
function spawnSync(command, args, options) {
  return nodeSpawnSync(command, args ?? [], withHide(options));
}
function spawn(command, args, options) {
  return nodeSpawn(command, args ?? [], withHide(options));
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/select-git-source.ts
function hostHasGitAndShell(which) {
  return which("git") !== null && which("bash") !== null;
}
function selectGitSource(opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return "host";
  const setting = opts.setting ?? "auto";
  if (setting === "bundled") return "bundled";
  const which = opts.which ?? (() => null);
  if (setting === "host") {
    return hostHasGitAndShell(which) ? "host" : "bundled";
  }
  return hostHasGitAndShell(which) ? "host" : "bundled";
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/ensure-bundled-git.ts
import { existsSync as existsSync2 } from "node:fs";
import path5 from "node:path";
var GIT_LIBDIRS = ["mingw64", "clangarm64"];
var GIT_LAUNCHER_REL = path5.win32.join("cmd", "git.exe");
function resolveBundledGitDir(opts = {}) {
  const exists = opts.exists ?? existsSync2;
  const join2 = path5.win32.join;
  const roots = [];
  if (opts.resourcesPath) roots.push(join2(opts.resourcesPath, "git"));
  for (const c of opts.candidates ?? []) roots.push(c);
  for (const root of roots) {
    if (exists(join2(root, GIT_LAUNCHER_REL))) return root;
  }
  return null;
}
function resolveLibDir(gitDir, exists) {
  for (const name of GIT_LIBDIRS) {
    if (exists(path5.win32.join(gitDir, name))) return name;
  }
  return null;
}
function ensureBundledGitOnPath(env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  if (opts.source && opts.source !== "bundled") return env;
  const exists = opts.exists ?? existsSync2;
  const gitDir = opts.gitDir !== void 0 ? opts.gitDir : resolveBundledGitDir({
    platform,
    resourcesPath: opts.resourcesPath,
    candidates: opts.candidates,
    exists
  });
  if (!gitDir) return env;
  const join2 = path5.win32.join;
  const libDir = resolveLibDir(gitDir, exists);
  const dirs = [join2(gitDir, "cmd"), join2(gitDir, "usr", "bin")];
  if (libDir) dirs.push(join2(gitDir, libDir, "bin"));
  const currentPath = env.PATH ?? "";
  const present = new Set(
    currentPath.split(";").map((e) => e.trim().replace(/[\\/]+$/, "").toLowerCase()).filter(Boolean)
  );
  const seen = /* @__PURE__ */ new Set();
  const toAdd = [];
  for (const dir of dirs) {
    if (!exists(dir)) continue;
    const lower = dir.replace(/[\\/]+$/, "").toLowerCase();
    if (present.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    toAdd.push(dir);
  }
  const DELIM = ";";
  let out = env;
  if (toAdd.length > 0) {
    const newPath = currentPath ? `${toAdd.join(DELIM)}${DELIM}${currentPath}` : toAdd.join(DELIM);
    out = { ...out, PATH: newPath };
  }
  if (libDir) {
    const execPath = join2(gitDir, libDir, "libexec", "git-core");
    if (exists(execPath) && out.GIT_EXEC_PATH !== execPath) {
      out = { ...out, GIT_EXEC_PATH: execPath };
    }
  }
  if (libDir) {
    const caBundle = join2(gitDir, libDir, "ssl", "certs", "ca-bundle.crt");
    if (exists(caBundle) && out.SSL_CERT_FILE !== caBundle) {
      out = { ...out, SSL_CERT_FILE: caBundle };
    }
  }
  return out;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/git-source.ts
var configuredSetting = "auto";
var cached = null;
function getActiveGitSource(which, opts = {}) {
  if (cached) return cached;
  const source = selectGitSource({ setting: configuredSetting, which });
  const gitDir = source === "bundled" ? resolveBundledGitDir({
    resourcesPath: opts.resourcesPath ?? process.resourcesPath,
    candidates: opts.candidates
  }) : null;
  cached = { source, setting: configuredSetting, gitDir };
  return cached;
}
function augmentEnvWithGitSource(env, which, opts = {}) {
  try {
    const { source, gitDir } = getActiveGitSource(which, opts);
    return ensureBundledGitOnPath(env, { source, gitDir });
  } catch {
    return env;
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/binary-lookup.ts
var GLOBAL_REGISTRY_KEY = /* @__PURE__ */ Symbol.for("pi-dashboard.tool-registry");
function tryGetRegistry() {
  const reg = globalThis[GLOBAL_REGISTRY_KEY];
  return reg ?? null;
}
var ToolResolver = class {
  ctx;
  constructor(ctx = {}) {
    this.ctx = ctx;
  }
  /**
   * Resolve a binary by name. Returns absolute path or null.
   * Search order: managed bin → extra dirs → system PATH → login shell.
   */
  which(name) {
    const ext = process.platform === "win32" ? ".cmd" : "";
    const managed = path6.join(MANAGED_BIN, name + ext);
    if (existsSync3(managed)) return managed;
    for (const dir of this.ctx.extraBinDirs ?? []) {
      const candidate = path6.join(dir, name + ext);
      if (existsSync3(candidate)) return candidate;
    }
    const systemPath = whichSync(name);
    if (systemPath) return systemPath;
    if (this.ctx.useLoginShell && process.platform !== "win32") {
      return whichViaLoginShell(name);
    }
    return null;
  }
  /**
   * Resolve pi as spawn-ready argv `[cmd, ...prefixArgs]`.
   *
   * Fully delegates to `ToolRegistry.resolveExecutor("pi")`, which
   * owns per-OS discovery + interpreter assembly (on Windows: find
   * `pi-coding-agent/dist/cli.js` via managed/bare-import/npm-global
   * and prepend `node.exe`; on Unix: find `pi` binary on PATH).
   *
   * Returns null when the registry is not yet constructed AND pi is
   * not on PATH (very early boot / standalone tests). Production code
   * always has the registry available before spawn.
   */
  resolvePi() {
    const registry = tryGetRegistry();
    if (registry?.has("pi")) {
      const exec = registry.resolveExecutor("pi");
      if (exec.ok && exec.argv.length > 0) return exec.argv;
    }
    const piPath = this.which("pi");
    return piPath ? [piPath] : null;
  }
  /**
   * Resolve tsx as [cmd, ...prefixArgs].
   * On Windows, avoids .cmd by returning [node.exe, tsx/dist/cli.mjs].
   */
  resolveTsx() {
    if (process.platform === "win32") {
      const tsxCli = path6.join(MANAGED_DIR, "node_modules", "tsx", "dist", "cli.mjs");
      if (existsSync3(tsxCli)) {
        const node = this.resolveNode();
        if (node) return [node, tsxCli];
      }
    }
    const tsxPath = this.which("tsx");
    if (tsxPath) return [tsxPath];
    return null;
  }
  /**
   * Resolve Node.js binary path.
   * Checks processExecPath, extra dirs, managed, system PATH, login shell.
   */
  resolveNode() {
    if (this.ctx.processExecPath) {
      return this.ctx.processExecPath;
    }
    for (const dir of this.ctx.extraBinDirs ?? []) {
      const nodeName = process.platform === "win32" ? "node.exe" : "node";
      const candidate = path6.join(dir, nodeName);
      if (existsSync3(candidate)) return candidate;
    }
    return this.which("node");
  }
  /**
   * Build a spawn environment with managed bin, node bin, extra dirs,
   * and common user bin dirs prepended to PATH.
   *
   * On Windows, additionally guarantees canonical system directories
   * (System32, Wbem, PowerShell, WindowsApps) are present via
   * `ensureWindowsSystemPath`. See change:
   * fix-windows-path-system32-missing.
   */
  buildSpawnEnv(base = process.env, opts = {}) {
    const ELECTRON_VARS_TO_STRIP = /* @__PURE__ */ new Set([
      "ELECTRON_RUN_AS_NODE",
      "ELECTRON_DEFAULT_ERROR_MODE",
      "ELECTRON_ENABLE_STACK_DUMPING"
    ]);
    const strippedBase = {};
    for (const [k, v] of Object.entries(base)) {
      if (!ELECTRON_VARS_TO_STRIP.has(k)) strippedBase[k] = v;
    }
    const platform = opts.platform ?? process.platform;
    base = normalizeEnvPathKey(strippedBase, platform);
    const delimiter = platform === "win32" ? ";" : path6.delimiter;
    const currentPath = base.PATH || "";
    const parts = [];
    if (!currentPath.includes(MANAGED_BIN)) {
      parts.push(MANAGED_BIN);
    }
    const nodeBin = this.ctx.processExecPath ? path6.dirname(this.ctx.processExecPath) : null;
    if (nodeBin && !currentPath.includes(nodeBin)) {
      parts.push(nodeBin);
    }
    for (const dir of this.ctx.extraBinDirs ?? []) {
      if (!currentPath.includes(dir)) {
        parts.push(dir);
      }
    }
    for (const dir of getUserBinDirs()) {
      if (!currentPath.includes(dir)) {
        parts.push(dir);
      }
    }
    const out = parts.length === 0 ? base : { ...base, PATH: `${parts.join(delimiter)}${delimiter}${currentPath}` };
    const withSystem = ensureWindowsSystemPath(out, opts);
    return augmentEnvWithGitSource(withSystem, whichSync);
  }
};
function whereAllLines(whichCmd, target) {
  try {
    const { argv, spawnOptions } = buildSafeArgv(whichCmd, [target]);
    const result = spawnSync(argv[0], argv.slice(1), {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions
    });
    if (result.status !== 0) return [];
    const text = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
    return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}
function extOf(p) {
  const slash = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  const dot = p.lastIndexOf(".");
  return dot > slash ? p.slice(dot).toLowerCase() : "";
}
function whichSync(cmd) {
  const isWin = process.platform === "win32";
  if (!isWin) {
    const lines2 = whereAllLines("which", cmd);
    return lines2[0] ?? null;
  }
  const lines = whereAllLines("where", cmd);
  if (lines.length === 0) return null;
  const callerHasExt = /\.[A-Za-z0-9]+$/.test(cmd);
  if (callerHasExt) return lines[0];
  const pathextRaw = process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC;.PS1";
  const pathext = pathextRaw.split(";").map((e) => e.trim().toLowerCase()).filter(Boolean);
  let best = null;
  let bestRank = Infinity;
  for (const line of lines) {
    const rank = pathext.indexOf(extOf(line));
    if (rank === -1) continue;
    if (rank < bestRank) {
      best = line;
      bestRank = rank;
    }
  }
  if (best) return best;
  return lines[0];
}
function whichViaLoginShell(cmd) {
  const shell = process.env.SHELL || "/bin/zsh";
  try {
    const raw = execSync(`${shell} -lc "which ${cmd}"`, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 5e3,
      windowsHide: true
    });
    const output = (typeof raw === "string" ? raw : String(raw)).trim();
    const pathLine = output.split("\n").find((l) => l.trim().startsWith("/"));
    return pathLine?.trim() || null;
  } catch {
    return null;
  }
}
function getUserBinDirs() {
  const home = os3.homedir();
  return [
    path6.join(home, ".local", "bin"),
    path6.join(home, ".npm-global", "bin"),
    "/usr/local/bin"
  ].filter((d) => existsSync3(d));
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/runner.ts
var sharedResolver = new ToolResolver({
  processExecPath: process.execPath,
  useLoginShell: true
});
var GLOBAL_REGISTRY_KEY2 = /* @__PURE__ */ Symbol.for("pi-dashboard.tool-registry");
function tryGetRegistry2() {
  const reg = globalThis[GLOBAL_REGISTRY_KEY2];
  return reg ?? null;
}
function electronAsNodeRequired(argv0, deps) {
  const execPath = deps?.execPath ?? process.execPath;
  const electronVersion = deps?.electronVersion ?? process.versions?.electron;
  return Boolean(electronVersion) && argv0 === execPath;
}
function buildSpawnEnvForArgv(execCmd, ctxEnv, deps) {
  const electronAsNode = electronAsNodeRequired(execCmd, deps);
  if (!ctxEnv && !electronAsNode) return void 0;
  const p = deps?.platform ?? process.platform;
  const inherited = normalizeEnvPathKey({ ...process.env }, p);
  const merged = ctxEnv ? { ...inherited, ...normalizeEnvPathKey(ctxEnv, p) } : { ...inherited };
  if (electronAsNode) merged.ELECTRON_RUN_AS_NODE = "1";
  return merged;
}
function isPathLike(cmd) {
  if (path7.isAbsolute(cmd)) return true;
  if (cmd.startsWith("./") || cmd.startsWith("../")) return true;
  if (cmd.startsWith(".\\") || cmd.startsWith("..\\")) return true;
  return false;
}
function resolveExecutorArgv(name, recipeArgs) {
  if (isPathLike(name)) {
    if (existsSync4(name)) return [name, ...recipeArgs];
    return null;
  }
  const registry = tryGetRegistry2();
  if (registry && registry.has(name)) {
    const exec = registry.resolveExecutor(name);
    if (exec.ok && exec.argv.length > 0) {
      return [...exec.argv, ...recipeArgs];
    }
    return null;
  }
  const p = sharedResolver.which(name);
  return p ? [p, ...recipeArgs] : null;
}
var DEFAULT_TIMEOUT_MS = 5e3;
function runAsync(recipe, input, ctx = {}) {
  const argv = recipe.argv(input);
  if (argv.length === 0) {
    ctx.onClose?.();
    return Promise.resolve({ ok: false, error: { kind: "spawn-failure", message: "Recipe produced empty argv" } });
  }
  const [rawCmd, ...recipeArgs] = argv;
  if (ctx.signal?.aborted) {
    ctx.onClose?.();
    return Promise.resolve({ ok: false, error: { kind: "aborted", binary: rawCmd, message: `${rawCmd} aborted` } });
  }
  const execArgv = resolveExecutorArgv(rawCmd, recipeArgs);
  if (!execArgv) {
    ctx.onClose?.();
    return Promise.resolve({ ok: false, error: { kind: "not-found", binary: rawCmd } });
  }
  const timeout = ctx.timeout ?? recipe.timeout ?? DEFAULT_TIMEOUT_MS;
  const [execCmd, ...execArgs] = execArgv;
  const { argv: safeArgv, spawnOptions } = buildSafeArgv(execCmd, execArgs);
  return new Promise((resolve2) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let closed = false;
    const closeOnce = () => {
      if (closed) return;
      closed = true;
      ctx.onClose?.();
    };
    const settle = (r) => {
      if (settled) return;
      settled = true;
      resolve2(r);
    };
    let child;
    try {
      child = spawn(safeArgv[0], safeArgv.slice(1), {
        cwd: ctx.cwd,
        env: buildSpawnEnvForArgv(execCmd, ctx.env),
        stdio: ["ignore", "pipe", "pipe"],
        ...spawnOptions
        // shell: false, windowsHide: true
      });
    } catch (err) {
      closeOnce();
      settle({ ok: false, error: { kind: "spawn-failure", message: err instanceof Error ? err.message : String(err) } });
      return;
    }
    const terminate = () => {
      try {
        child.kill("SIGTERM");
      } catch {
      }
      const sigkillTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, 3e3);
      child.once("close", () => clearTimeout(sigkillTimer));
    };
    const timer = setTimeout(() => {
      terminate();
      settle({ ok: false, error: { kind: "timeout", timeoutMs: timeout, binary: rawCmd, stdout, stderr } });
    }, timeout);
    const onAbort = () => {
      if (settled) return;
      clearTimeout(timer);
      terminate();
      settle({ ok: false, error: { kind: "aborted", binary: rawCmd, message: `${rawCmd} aborted` } });
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });
    const detachAbort = () => ctx.signal?.removeEventListener("abort", onAbort);
    child.once("exit", closeOnce);
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const maxBuffer = recipe.maxBuffer;
    let stdoutBytes = 0;
    child.stdout?.on("data", (chunk) => {
      if (settled) return;
      if (maxBuffer !== void 0) {
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxBuffer) {
          clearTimeout(timer);
          terminate();
          stdout = "";
          settle({
            ok: false,
            error: {
              kind: "output-too-large",
              binary: rawCmd,
              limitBytes: maxBuffer,
              message: `${rawCmd} output exceeded ${maxBuffer} bytes`
            }
          });
          return;
        }
      }
      stdout += stdoutDecoder.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += stderrDecoder.write(chunk);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      detachAbort();
      closeOnce();
      if (err.code === "ETIMEDOUT" || err.message?.includes("ETIMEDOUT")) {
        settle({ ok: false, error: { kind: "timeout", timeoutMs: timeout, binary: rawCmd, stdout, stderr } });
        return;
      }
      settle({ ok: false, error: { kind: "spawn-failure", message: err.message } });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      detachAbort();
      closeOnce();
      if (settled) return;
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      const tolerated = code !== 0 && code !== null && recipe.tolerate?.includes(code);
      if (code === 0 || tolerated) {
        try {
          settle({ ok: true, value: recipe.parse(stdout, input) });
        } catch (err) {
          settle({ ok: false, error: { kind: "spawn-failure", message: err instanceof Error ? err.message : String(err) } });
        }
        return;
      }
      settle({ ok: false, error: { kind: "exit", code, signal, stdout, stderr } });
    });
  });
}
function unwrap(result, fallback) {
  return result.ok ? result.value : fallback;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/git.ts
var GIT_TIMEOUT = 15e3;
var GIT_TOPLEVEL = {
  argv: () => ["git", "rev-parse", "--show-toplevel"],
  parse: (out) => out.trim() || void 0,
  timeout: GIT_TIMEOUT
};
var GIT_DIR_ABS = {
  argv: () => ["git", "rev-parse", "--path-format=absolute", "--git-dir"],
  parse: (out) => out.trim() || void 0,
  timeout: GIT_TIMEOUT
};
var GIT_COMMON_DIR_ABS = {
  argv: () => ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
  parse: (out) => out.trim() || void 0,
  timeout: GIT_TIMEOUT
};
var GIT_CONFIG_LOCAL_CORE_WORKTREE = {
  argv: ({ gitDir }) => ["git", "--git-dir", gitDir, "config", "--local", "--get", "core.worktree"],
  parse: (out) => out.trim() || void 0,
  timeout: GIT_TIMEOUT,
  tolerate: [1]
};
var GIT_CONFIG_LOCAL_CORE_BARE = {
  argv: ({ gitDir }) => ["git", "--git-dir", gitDir, "config", "--local", "--type=bool", "--get", "core.bare"],
  parse: (out) => out.trim() || void 0,
  timeout: GIT_TIMEOUT,
  tolerate: [1]
};
var GIT_DIFF_ALL_MAX_BYTES = 32 * 1024 * 1024;
function hasGitPathSegment(p, platform = process.platform) {
  return normalizePath(p, platform).split(/[\\/]+/).some((seg) => seg === ".git");
}
function tryProbe(read) {
  try {
    return read();
  } catch {
    return void 0;
  }
}
function readBareness(probes, commonDir) {
  try {
    return probes.localCoreBare(commonDir);
  } catch {
    return "unknown";
  }
}
function isLinked(gitDirRaw, commonDirRaw, platform = process.platform) {
  return !samePath(normalizePath(gitDirRaw, platform), normalizePath(commonDirRaw, platform), platform);
}
function wantsBareness(commonDirRaw, platform = process.platform) {
  return path8.basename(normalizePath(commonDirRaw, platform)) === ".git";
}
function resolveCheckoutRootsFrom(probes, platform = process.platform) {
  const gitDirRaw = tryProbe(probes.gitDir);
  const commonDirRaw = tryProbe(probes.commonDir);
  if (!gitDirRaw || !commonDirRaw) return null;
  const gitDir = normalizePath(gitDirRaw, platform);
  const commonDir = normalizePath(commonDirRaw, platform);
  const topLevelRaw = tryProbe(probes.topLevel);
  const thisCheckout = topLevelRaw ? normalizePath(topLevelRaw, platform) : null;
  const isLinkedWorktree = isLinked(gitDir, commonDir, platform);
  if (!isLinkedWorktree) return { thisCheckout, isLinkedWorktree, mainCheckout: thisCheckout, commonDir, gitDir };
  const configured = tryProbe(() => probes.localCoreWorktree(commonDir));
  if (configured) {
    return {
      thisCheckout,
      isLinkedWorktree,
      mainCheckout: normalizePath(path8.resolve(commonDir, configured), platform),
      commonDir,
      gitDir
    };
  }
  const bare = wantsBareness(commonDir, platform) ? readBareness(probes, commonDir) : "unknown";
  if (bare === "not-bare") {
    return {
      thisCheckout,
      isLinkedWorktree,
      mainCheckout: normalizePath(path8.dirname(commonDir), platform),
      commonDir,
      gitDir
    };
  }
  return { thisCheckout, isLinkedWorktree, mainCheckout: null, commonDir, gitDir };
}
async function tryProbeAsync(read) {
  try {
    return await read();
  } catch {
    return void 0;
  }
}
async function resolveCheckoutRootsFromAsync(probes, platform = process.platform) {
  const [gitDir, commonDir, topLevel] = await Promise.all([
    tryProbeAsync(probes.gitDir),
    tryProbeAsync(probes.commonDir),
    tryProbeAsync(probes.topLevel)
  ]);
  if (!gitDir || !commonDir) return null;
  let worktree;
  let bare;
  if (isLinked(gitDir, commonDir, platform)) {
    worktree = await tryProbeAsync(() => probes.localCoreWorktree(commonDir));
    if (!worktree && wantsBareness(commonDir, platform)) {
      try {
        bare = await probes.localCoreBare(commonDir);
      } catch {
        bare = "unknown";
      }
    }
  }
  return resolveCheckoutRootsFrom(
    {
      gitDir: () => gitDir,
      commonDir: () => commonDir,
      topLevel: () => topLevel,
      localCoreWorktree: () => worktree,
      localCoreBare: () => {
        if (bare === void 0) throw new Error("bareness probe was not pre-run");
        return bare;
      }
    },
    platform
  );
}
async function checkoutRootsAsync(input) {
  const ctx = { cwd: input.cwd, timeout: input.timeout };
  return resolveCheckoutRootsFromAsync({
    gitDir: async () => unwrap(await runAsync(GIT_DIR_ABS, input, ctx), void 0),
    commonDir: async () => unwrap(await runAsync(GIT_COMMON_DIR_ABS, input, ctx), void 0),
    topLevel: async () => unwrap(await runAsync(GIT_TOPLEVEL, input, ctx), void 0),
    localCoreWorktree: async (commonDir) => unwrap(await runAsync(GIT_CONFIG_LOCAL_CORE_WORKTREE, { cwd: input.cwd, gitDir: commonDir }, ctx), void 0),
    localCoreBare: async (commonDir) => {
      const r = await runAsync(GIT_CONFIG_LOCAL_CORE_BARE, { cwd: input.cwd, gitDir: commonDir }, ctx);
      if (!r.ok) return "unknown";
      return r.value === "true" ? "bare" : "not-bare";
    }
  });
}
async function realpathOrNullAsync(p) {
  try {
    return await fsRealpath(p);
  } catch {
    return null;
  }
}
async function canonicalAsync(p, platform = process.platform) {
  return normalizePath(await realpathOrNullAsync(p) ?? p, platform);
}
function isUnder(p, base) {
  const rel = path8.relative(base, p);
  return rel === "" || !rel.startsWith(".." + path8.sep) && rel !== ".." && !path8.isAbsolute(rel);
}
function bindDecision(candidateCanon, commonCanon, reResolved, reCommonCanon, reThisCanon, platform) {
  if (!reResolved) return false;
  if (!reCommonCanon || !samePath(reCommonCanon, commonCanon, platform)) return false;
  if (!reThisCanon) return false;
  if (!samePath(reThisCanon, candidateCanon, platform)) return false;
  return !isUnder(candidateCanon, commonCanon);
}
async function isBoundCheckoutAsync(candidate, commonDir, opts = {}) {
  const platform = process.platform;
  const candidateReal = await realpathOrNullAsync(candidate);
  if (!candidateReal || hasGitPathSegment(candidateReal)) return false;
  const reResolved = await checkoutRootsAsync({ cwd: candidateReal, timeout: opts.timeout });
  const [candidateCanon, commonCanon, reCommonCanon, reThisCanon] = await Promise.all([
    canonicalAsync(candidateReal, platform),
    canonicalAsync(commonDir, platform),
    reResolved ? canonicalAsync(reResolved.commonDir, platform) : Promise.resolve(null),
    reResolved?.thisCheckout ? canonicalAsync(reResolved.thisCheckout, platform) : Promise.resolve(null)
  ]);
  return bindDecision(candidateCanon, commonCanon, reResolved, reCommonCanon, reThisCanon, platform);
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/path-containment.ts
var PROBE_TIMEOUT_MS = 2e3;
function within(p, base) {
  const rel = path9.relative(base, p);
  return rel === "" || !rel.startsWith(`..${path9.sep}`) && rel !== ".." && !path9.isAbsolute(rel);
}
async function safeRealpath(p) {
  try {
    return await fs3.realpath(p);
  } catch {
    const parent = path9.dirname(p);
    if (parent === p) return p;
    const realParent = await safeRealpath(parent);
    return path9.join(realParent, path9.basename(p));
  }
}
async function checkoutAnchors(anchor) {
  const roots = await checkoutRootsAsync({ cwd: anchor, timeout: PROBE_TIMEOUT_MS });
  if (!roots) return [];
  const candidates = [];
  for (const candidate of [roots.thisCheckout, roots.mainCheckout]) {
    if (!candidate) continue;
    if (candidates.some((seen) => samePath(seen, candidate))) continue;
    candidates.push(candidate);
  }
  const bound = [];
  for (const candidate of candidates) {
    if (await isBoundCheckoutAsync(candidate, roots.commonDir, { timeout: PROBE_TIMEOUT_MS })) {
      bound.push(candidate);
    }
  }
  return bound;
}
async function isGrantAdmitted(resolved, subjects) {
  if (subjects.length === 0) return false;
  let real;
  try {
    real = await fs3.realpath(resolved);
  } catch {
    return false;
  }
  return subjects.some((subject) => within(real, subject));
}
async function isAllowed(resolved, { anchors }) {
  for (const anchor of anchors) {
    if (within(resolved, anchor)) return true;
  }
  const realResolved = await safeRealpath(resolved);
  for (const anchor of anchors) {
    for (const root of await checkoutAnchors(anchor)) {
      if (samePath(root, anchor)) continue;
      if (within(realResolved, await safeRealpath(root))) return true;
    }
  }
  return false;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/access/ancestor-ladder.ts
import * as fs4 from "node:fs";
import os4 from "node:os";
import path10 from "node:path";
var PROBE_TIMEOUT_MS2 = 2e3;
var CHECKOUT_ROOT_CACHE_TTL_MS = 5e3;
var CHECKOUT_ROOT_CACHE_MAX = 256;
var checkoutRootCache = /* @__PURE__ */ new Map();
async function cachedCheckoutRoot(real) {
  const now = Date.now();
  const hit = checkoutRootCache.get(real);
  if (hit && now - hit.at < CHECKOUT_ROOT_CACHE_TTL_MS) return hit.root;
  const roots = await checkoutRootsAsync({ cwd: real, timeout: PROBE_TIMEOUT_MS2 });
  const root = roots?.thisCheckout ?? null;
  checkoutRootCache.delete(real);
  if (checkoutRootCache.size >= CHECKOUT_ROOT_CACHE_MAX) {
    const oldest = checkoutRootCache.keys().next().value;
    if (oldest !== void 0) checkoutRootCache.delete(oldest);
  }
  checkoutRootCache.set(real, { root, at: now });
  return root;
}
function realpathOrNull(p) {
  try {
    return fs4.realpathSync(p);
  } catch {
    return null;
  }
}
async function checkoutBoundary(real) {
  try {
    const candidate = await cachedCheckoutRoot(real);
    return candidate ? realpathNearestAncestor2(candidate) : null;
  } catch {
    return null;
  }
}
function realpathNearestAncestor2(p) {
  try {
    return fs4.realpathSync(p);
  } catch {
    const parent = path10.dirname(p);
    if (parent === p) return p;
    return path10.join(realpathNearestAncestor2(parent), path10.basename(p));
  }
}
async function offeredAncestorLadder(subject, opts) {
  const home = opts?.homedir ?? os4.homedir();
  const realHome = realpathNearestAncestor2(path10.resolve(home));
  const real = realpathOrNull(path10.resolve(subject));
  if (real === null) return [];
  const start = path10.dirname(real);
  if (samePath(start, realHome)) return [];
  const checkoutRoot = await checkoutBoundary(real);
  if (checkoutRoot && samePath(checkoutRoot, real)) return [];
  const forbidden = forbiddenGrantSubjects({ homedir: home });
  const rungs = [];
  const fsRoot = path10.parse(real).root;
  let cur = start;
  while (!samePath(cur, fsRoot)) {
    if (checkoutRoot && samePath(cur, checkoutRoot)) {
      if (!subsumesForbiddenGrantSubject(cur, { homedir: home }, forbidden)) rungs.push(cur);
      break;
    }
    if (samePath(cur, realHome)) break;
    if (subsumesForbiddenGrantSubject(cur, { homedir: home }, forbidden)) break;
    rungs.push(cur);
    const parent = path10.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return rungs;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/canonical-subject.ts
import * as fs5 from "node:fs";
import path11 from "node:path";
var probeCache = /* @__PURE__ */ new Map();
function nearestExistingDir(p) {
  let cur = path11.resolve(p);
  for (; ; ) {
    try {
      return fs5.statSync(cur).isDirectory() ? cur : path11.dirname(cur);
    } catch {
      const parent = path11.dirname(cur);
      if (parent === cur) return null;
      cur = parent;
    }
  }
}
function flipCase(name) {
  const flipped = /[a-z]/.test(name) ? name.toUpperCase() : name.toLowerCase();
  return flipped === name ? null : flipped;
}
function volumeCaseInsensitive(existingPath) {
  const dir = nearestExistingDir(existingPath);
  if (!dir) return false;
  let dev;
  try {
    dev = String(fs5.statSync(dir).dev);
  } catch {
    return false;
  }
  const cached2 = probeCache.get(dev);
  if (cached2 !== void 0) return cached2;
  let answer = false;
  let cur = dir;
  for (; ; ) {
    const flipped = flipCase(path11.basename(cur));
    if (flipped) {
      answer = fs5.existsSync(path11.join(path11.dirname(cur), flipped));
      break;
    }
    const parent = path11.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  probeCache.set(dev, answer);
  return answer;
}
function canonicalSubject(subject, opts) {
  if (!subject) return null;
  let real;
  try {
    real = fs5.realpathSync(path11.resolve(subject));
  } catch {
    return null;
  }
  const caseInsensitive = opts?.caseInsensitive ?? volumeCaseInsensitive(real);
  const nfc = real.normalize("NFC");
  return {
    canonical: caseInsensitive ? nfc.toLowerCase() : nfc,
    caseInsensitive
  };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/tool-path-resolve.ts
import * as fs6 from "node:fs";
import os5 from "node:os";
import nodePath from "node:path";
import { fileURLToPath } from "node:url";
function defaultResolveEnv() {
  return {
    path: nodePath,
    platform: process.platform,
    homeDir: os5.homedir(),
    realpathSync: (p) => fs6.realpathSync(p),
    exists: (p) => {
      try {
        fs6.accessSync(p, fs6.constants.F_OK);
        return true;
      } catch {
        return false;
      }
    },
    isDirectory: (p) => {
      try {
        return fs6.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    isSymlink: (p) => {
      try {
        return fs6.lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    },
    readlink: (p) => fs6.readlinkSync(p)
  };
}
var UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
function normalizeWindowsShellPath(filePath) {
  if (!filePath.startsWith("/") || filePath.startsWith("//") || filePath.includes("\\")) return filePath;
  const match = filePath.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return filePath;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1].toUpperCase()}:\\${suffix ?? ""}`;
}
function normalizeInput(input, env, stripAt) {
  let n = input.replace(UNICODE_SPACES, " ");
  if (stripAt && n.startsWith("@")) n = n.slice(1);
  if (env.platform === "win32") n = normalizeWindowsShellPath(n);
  if (n === "~") return env.homeDir;
  if (n.startsWith("~/") || env.platform === "win32" && n.startsWith("~\\")) {
    return env.path.join(env.homeDir, n.slice(2));
  }
  if (/^file:\/\//.test(n)) return fileURLToPath(n);
  return n;
}
function resolveToolPath(input, cwd, env = defaultResolveEnv()) {
  const normalized = normalizeInput(input, env, true);
  const base = normalizeInput(cwd, env, false);
  return env.path.isAbsolute(normalized) ? env.path.resolve(normalized) : env.path.resolve(base, normalized);
}
function resolveReadTarget(resolved, env = defaultResolveEnv()) {
  if (env.exists(resolved)) return resolved;
  const amPm = resolved.replace(/ (AM|PM)\./gi, "\u202F$1.");
  if (amPm !== resolved && env.exists(amPm)) return amPm;
  const nfd = resolved.normalize("NFD");
  if (nfd !== resolved && env.exists(nfd)) return nfd;
  const curly = resolved.replace(/'/g, "\u2019");
  if (curly !== resolved && env.exists(curly)) return curly;
  const nfdCurly = nfd.replace(/'/g, "\u2019");
  if (nfdCurly !== resolved && env.exists(nfdCurly)) return nfdCurly;
  return resolved;
}
var MAX_SYMLINK_HOPS = 40;
function resolveLinkText(linkPath, text, env) {
  const p = env.path;
  const root = p.isAbsolute(text) ? p.parse(text).root : "";
  let base = root || env.realpathSync(p.dirname(linkPath));
  const parts = text.slice(root.length).split(env.platform === "win32" ? /[\\/]+/ : "/");
  for (const part of parts) {
    if (part !== "" && part !== ".") base = part === ".." ? p.dirname(base) : realOrSelf(p.join(base, part), env);
  }
  return base;
}
function realOrSelf(next, env) {
  return tryRealpath(next, env) ?? next;
}
function tryRealpath(p, env) {
  try {
    return env.realpathSync(p);
  } catch {
    return void 0;
  }
}
function joinTail(env, base, tail) {
  return tail.length ? env.path.join(base, ...[...tail].reverse()) : base;
}
function canonicalizeTarget(absPath, env = defaultResolveEnv()) {
  const p = env.path;
  const tail = [];
  let cur = absPath;
  let hops = 0;
  for (; ; ) {
    const real = tryRealpath(cur, env);
    if (real !== void 0) return joinTail(env, real, tail);
    if (env.isSymlink?.(cur) && env.readlink) {
      if (++hops > MAX_SYMLINK_HOPS) throw new Error(`too many symbolic links resolving ${absPath}`);
      cur = joinTail(env, resolveLinkText(cur, env.readlink(cur), env), tail);
      tail.length = 0;
      continue;
    }
    const parent = p.dirname(cur);
    if (parent === cur) return joinTail(env, cur, tail);
    tail.push(p.basename(cur));
    cur = parent;
  }
}
function fold(s, ci) {
  const nfc = s.normalize("NFC");
  return ci ? nfc.toLowerCase() : nfc;
}
function defaultVolumeProbe(canonical, env) {
  const realHost = env.path === nodePath && env.platform === process.platform;
  if (realHost) return volumeCaseInsensitive(canonical);
  return env.platform === "win32" || env.platform === "darwin";
}
function isWithinRoot(candidate, root, env, ci) {
  const p = env.path;
  const c = fold(candidate, ci);
  const r = fold(root, ci);
  if (c === r) return true;
  const rel = p.relative(r, c);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}
function isPathWithinRoots(canonical, roots, opts = {}) {
  const env = opts.env ?? defaultResolveEnv();
  const containedBy = (ci2) => roots.some((root) => isWithinRoot(canonical, root, env, ci2));
  if (containedBy(false)) return true;
  const ci = opts.caseInsensitive ?? (opts.volumeCaseProbe ? opts.volumeCaseProbe(canonical) : defaultVolumeProbe(canonical, env));
  return ci ? containedBy(true) : false;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-extension/src/path-gate/decide.ts
function decidePathAccess(input) {
  const env = input.env ?? defaultResolveEnv();
  const lexical = resolveToolPath(input.rawPath, input.cwd, env);
  const abs = input.access === "read" ? resolveReadTarget(lexical, env) : lexical;
  const canonical = canonicalizeTarget(abs, env);
  const r = input.roots;
  const rooted = [
    [...r.workspace],
    [...r.readWrite],
    [...r.grants],
    ...input.access === "read" ? [[...r.readOnly]] : []
  ];
  const inRoot = isPathWithinRoots(canonical, rooted.flat(), {
    env,
    caseInsensitive: input.caseInsensitive,
    volumeCaseProbe: input.volumeCaseProbe
  });
  if (inRoot) return { verdict: "in-root", canonical };
  const p = env.path;
  const suppressionKey = p.dirname(canonical);
  const subject = env.isDirectory(canonical) ? canonical : suppressionKey;
  return {
    verdict: "ask",
    canonical,
    // Flagging errs toward flagging (case-folded): a false flag only adds a warning.
    sensitive: input.sensitiveDirs.some((d) => isWithinRoot(canonical, d, env, true)),
    subject,
    grantable: !input.isUngrantable(subject),
    suppressionKey
  };
}
var OPT_ALLOW_ONCE = "Allow once";
var OPT_DENY = "Deny";
var optAlways = (subject) => `Always allow ${subject}\u2026`;
function buildOptions(i) {
  const options = [OPT_ALLOW_ONCE, OPT_DENY];
  if (i.grantable && i.storeMatch) {
    const alwaysLabel = optAlways(i.subject);
    return { options: [OPT_ALLOW_ONCE, alwaysLabel, OPT_DENY], alwaysLabel };
  }
  if (i.grantable && !i.storeMatch) return { options, note: "Always allow can't be remembered here" };
  return { options, note: "Always allow isn't available for this location" };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-extension/src/path-gate/suppression.ts
var SUPPRESSION_MS = 12e4;
var Suppression = class {
  denied = /* @__PURE__ */ new Map();
  now;
  constructor(now = Date.now) {
    this.now = now;
  }
  deny(key) {
    this.denied.set(key, this.now() + SUPPRESSION_MS);
  }
  isSuppressed(key) {
    const until = this.denied.get(key);
    if (until === void 0) return false;
    if (this.now() >= until) {
      this.denied.delete(key);
      return false;
    }
    return true;
  }
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-extension/src/path-gate/handler.ts
var GATED_TOOLS = ["read", "write", "edit"];
var KIND_SELECT = "agent-path-gate";
var KIND_CONFIRM = "agent-path-gate-confirm";
function block(code, detail) {
  return { block: true, reason: `path-gate: ${code}${detail ? ` \u2014 ${detail}` : ""}` };
}
function createPathGateHandler(deps) {
  const env = deps.env ?? defaultResolveEnv();
  const now = deps.now ?? Date.now;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h));
  const newId = deps.newId ?? (() => crypto.randomUUID());
  const suppression = deps.suppression ?? new Suppression(now);
  const chains = /* @__PURE__ */ new Map();
  const emit = (line) => deps.log(line.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "?"));
  const log = (outcome, tool, access, canonical, sensitive, sid) => {
    emit(
      `[path-gate] ${outcome} tool=${tool} access=${access === "read" ? "r" : "w"} path=${canonical} session=${sid} sensitive=${sensitive}`
    );
  };
  async function ask(tool, access, d, input, toolCallId, cwd, sid) {
    const supKey = `${sid}\0${d.suppressionKey}`;
    if (suppression.isSuppressed(supKey)) {
      log("recently-denied", tool, access, d.canonical, d.sensitive, sid);
      return block("recently-denied", `access under ${d.suppressionKey} was denied moments ago`);
    }
    const timeoutMs = Math.max(1, deps.getConfig().timeoutSeconds) * 1e3;
    let openId = null;
    let expired = false;
    let onExpire = () => {
    };
    const expiry = new Promise((resolve2) => {
      onExpire = () => resolve2("expired");
    });
    const timer = setTimer(() => {
      expired = true;
      if (openId) deps.prompter.cancel(openId);
      onExpire();
    }, timeoutMs);
    const settleDeny = () => {
      suppression.deny(supKey);
      log("denied", tool, access, d.canonical, d.sensitive, sid);
      return block("denied", `operator declined ${access} access to ${d.canonical}`);
    };
    const settleTimeout = () => {
      suppression.deny(supKey);
      log("timeout", tool, access, d.canonical, d.sensitive, sid);
      return block("timeout", `no answer within ${Math.round(timeoutMs / 1e3)}s`);
    };
    try {
      const offer = buildOptions({
        grantable: d.grantable,
        sensitive: d.sensitive,
        storeMatch: deps.grantStoreMatch(),
        subject: d.subject
      });
      const detail = access === "write" && tool === "edit" ? `${Array.isArray(input.edits) ? input.edits.length : 0} edit(s)` : access === "write" && typeof input.content === "string" ? `${Buffer.byteLength(input.content)} bytes` : void 0;
      const message = [
        `Path: \`${d.canonical}\``,
        `Tool: ${tool}${detail ? ` (${detail})` : ""}`,
        `Session cwd: \`${cwd}\``,
        d.sensitive ? "\u26A0 **Sensitive location** (credentials or the agent's own control plane)." : "",
        offer.note ?? ""
      ].filter(Boolean).join("\n\n");
      const plainMessage = [
        `Path: ${d.canonical}`,
        `Tool: ${tool}${detail ? ` (${detail})` : ""}`,
        `Session cwd: ${cwd}`,
        d.sensitive ? "\u26A0 Sensitive location (credentials or the agent's own control plane)." : "",
        offer.note ?? ""
      ].filter(Boolean).join("\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f\u2028\u2029]/g, "?");
      const id1 = newId();
      openId = id1;
      deps.counters && deps.counters.asked++;
      log("asked", tool, access, d.canonical, d.sensitive, sid);
      const answer = await Promise.race([
        deps.prompter.select({
          id: id1,
          // The TUI shows only title + options (metadata is dashboard-card detail),
          // so the title itself names the target and flags a sensitive location.
          title: `Agent wants to ${tool} outside its workspace: ${d.canonical.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "?")}${d.sensitive ? "  \u26A0 sensitive location" : ""}`,
          options: offer.options,
          metadata: {
            kind: KIND_SELECT,
            path: d.canonical,
            subject: d.subject,
            access,
            sensitive: d.sensitive,
            tool,
            message,
            plainMessage,
            ...offer.note ? { note: offer.note } : {},
            ...toolCallId ? { toolCallId } : {}
          }
        }),
        expiry
      ]);
      openId = null;
      if (answer === "expired" || expired) return settleTimeout();
      if (answer === void 0 || answer === OPT_DENY) {
        if (deps.reportRefusal && deps.yoloSupported?.() && deps.grantStoreMatch()) {
          try {
            deps.reportRefusal({ promptId: id1, path: d.canonical, subject: d.subject });
          } catch {
          }
        }
        return settleDeny();
      }
      if (answer === OPT_ALLOW_ONCE) {
        log("allowed-once", tool, access, d.canonical, d.sensitive, sid);
        return void 0;
      }
      if (answer !== offer.alwaysLabel) return settleDeny();
      const id2 = newId();
      openId = id2;
      const confirmed = await Promise.race([
        deps.prompter.confirm({
          id: id2,
          title: `Always allow the agent to access ${d.subject}?`,
          message: `This persists for the directory ${d.subject} (and everything inside it). Revoke it any time in Settings \u25B8 Access.`,
          metadata: { kind: KIND_CONFIRM, path: d.canonical, subject: d.subject, message: `Directory: ${d.subject}`, ...toolCallId ? { toolCallId } : {} }
        }),
        expiry
      ]);
      const confirmId = id2;
      openId = null;
      if (confirmed === "expired" || expired) return settleTimeout();
      if (confirmed !== true) return settleDeny();
      let result;
      try {
        result = await Promise.race([
          deps.requestGrant({ promptId: confirmId, path: d.canonical, subject: d.subject }),
          expiry.then(() => ({ ok: false, error: "timeout" }))
        ]);
      } catch (err) {
        result = { ok: false, error: err instanceof Error ? err.message : "error" };
      }
      log("allowed-always", tool, access, d.canonical, d.sensitive, sid);
      if (!result.ok) {
        emit(`[path-gate] grant-not-saved error=${result.error ?? "unknown"} path=${d.canonical}`);
        deps.notify?.(`Path access allowed once \u2014 not saved: ${result.error ?? "unknown error"}`);
      }
      return void 0;
    } finally {
      clearTimer(timer);
    }
  }
  return async function onToolCall(event, ctx) {
    const tool = event?.toolName;
    if (!tool || !GATED_TOOLS.includes(tool)) return void 0;
    let cfg;
    try {
      cfg = deps.getConfig();
    } catch {
      cfg = { enabled: true, timeoutSeconds: 120 };
    }
    if (!cfg.enabled) return void 0;
    try {
      const input = event.input ?? {};
      const rawPath = input.path;
      if (typeof rawPath !== "string" || rawPath === "") return void 0;
      const access = tool === "read" ? "read" : "write";
      const cwd = ctx.cwd;
      const grants = deps.getGrants();
      const sensitiveDirs = deps.getSensitiveDirs();
      const decide = (roots) => decidePathAccess({ access, rawPath, cwd, roots, sensitiveDirs, isUngrantable: deps.isUngrantable, env });
      let decision = decide(await deps.getRoots(grants, false, cwd));
      if (decision.verdict === "ask") decision = decide(await deps.getRoots(grants, true, cwd));
      if (decision.verdict === "in-root") {
        if (deps.counters) deps.counters.inRoot++;
        return void 0;
      }
      const d = decision;
      const sid = deps.sessionId();
      const fullAccessSupported = deps.fullAccessSupported?.() === true;
      const recentlyDenied = () => {
        log("recently-denied", tool, access, d.canonical, d.sensitive, sid);
        if (deps.counters) deps.counters.blocked++;
        return block("recently-denied", `access under ${d.suppressionKey} was denied moments ago`);
      };
      if (!fullAccessSupported && suppression.isSuppressed(`${sid}\0${d.suppressionKey}`)) return recentlyDenied();
      if (deps.yoloDecide && (fullAccessSupported || !d.sensitive && d.grantable) && deps.yoloSupported?.() && deps.grantStoreMatch()) {
        let verdict = "decline";
        try {
          verdict = await deps.yoloDecide({ path: d.canonical, access: access === "read" ? "r" : "w", tool });
        } catch {
          verdict = "decline";
        }
        if (verdict === "auto-allow") {
          log("yolo-allowed", tool, access, d.canonical, d.sensitive, sid);
          if (deps.counters) deps.counters.yoloAllowed = (deps.counters.yoloAllowed ?? 0) + 1;
          return void 0;
        }
        if (verdict === "task-blocked") {
          log("task-blocked", tool, access, d.canonical, d.sensitive, sid);
          if (deps.counters) deps.counters.blocked++;
          return block("task-blocked", "the task authorization is unavailable, expired, revoked, or does not cover this path. Check the task authorization status, continue independent authorized work and report the missing condition; do not wait for a dialog");
        }
        if (verdict === "refused") {
          log("yolo-refused", tool, access, d.canonical, d.sensitive, sid);
          if (deps.counters) deps.counters.blocked++;
          return block("yolo-refused", `${d.subject} was denied earlier; clear it in Settings \u25B8 Access`);
        }
      }
      if (suppression.isSuppressed(`${sid}\0${d.suppressionKey}`)) return recentlyDenied();
      if (!ctx.hasUI) {
        log("no-ui", tool, access, d.canonical, d.sensitive, sid);
        if (deps.counters) deps.counters.blocked++;
        return block("no-ui", "no interactive UI is attached to approve out-of-workspace access");
      }
      const prior = chains.get(sid) ?? Promise.resolve();
      const run2 = prior.then(() => ask(tool, access, d, input, event.toolCallId, cwd, sid));
      const tail = run2.catch(() => void 0);
      chains.set(sid, tail);
      void tail.catch(() => void 0).then(() => {
        if (chains.get(sid) === tail) chains.delete(sid);
      });
      const result = await run2;
      if (result && deps.counters) deps.counters.blocked++;
      return result;
    } catch (err) {
      emit(`[path-gate] error tool=${tool} session=${safeSession(deps)} ${err instanceof Error ? err.message : String(err)}`);
      if (deps.counters) deps.counters.blocked++;
      return block("error", "the path gate failed and fails closed");
    }
  };
}
function safeSession(deps) {
  try {
    return deps.sessionId();
  } catch {
    return "unknown";
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-extension/src/path-gate/roots.ts
import * as fs7 from "node:fs";
import os6 from "node:os";
import nodePath2 from "node:path";
var PROBE_TIMEOUT_MS3 = 2e3;
var PROBE_BOUND_MS = 3e3;
function realpathOr(p) {
  try {
    return fs7.realpathSync(p);
  } catch {
    return p;
  }
}
async function probeCheckoutRoots(cwd) {
  try {
    const roots = await checkoutRootsAsync({ cwd, timeout: PROBE_TIMEOUT_MS3 });
    if (!roots) return [];
    const cands = [];
    for (const c of [roots.thisCheckout, roots.mainCheckout]) {
      if (c && !cands.some((s) => samePath(s, c))) cands.push(c);
    }
    const bound = [];
    for (const c of cands) {
      if (await isBoundCheckoutAsync(c, roots.commonDir, { timeout: PROBE_TIMEOUT_MS3 })) bound.push(realpathOr(c));
    }
    return bound;
  } catch {
    return [];
  }
}
function withBound(p, ms, fallback) {
  return new Promise((resolve2) => {
    const t = setTimeout(() => resolve2(fallback), ms);
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve2(v);
      },
      () => {
        clearTimeout(t);
        resolve2(fallback);
      }
    );
  });
}
var RootsProvider = class {
  probePromise = null;
  probeCwd = null;
  settled = null;
  probeGen = 0;
  cachedKey = "";
  cachedStatic = null;
  opts;
  constructor(opts) {
    this.opts = opts;
  }
  /** Start (or restart for a new cwd) the bounded checkout probe. */
  startProbe(cwdArg) {
    const cwd = cwdArg ?? this.opts.getCwd();
    if (this.probeCwd === cwd && this.probePromise !== null) return;
    const gen = ++this.probeGen;
    this.probeCwd = cwd;
    this.settled = null;
    const probe = this.opts.probe ?? probeCheckoutRoots;
    this.probePromise = withBound(probe(cwd), this.opts.probeBoundMs ?? PROBE_BOUND_MS, []).then((r) => {
      if (gen === this.probeGen) this.settled = r;
      return r;
    });
  }
  /** Workspace + built-ins. Awaits the probe only when it has not settled yet. */
  async roots(grants, needsCheckout, cwdArg) {
    const cwd = cwdArg ?? this.opts.getCwd();
    this.startProbe(cwd);
    const mine = this.probePromise;
    const gen = this.probeGen;
    let checkout = this.settled ?? [];
    if (this.settled === null && needsCheckout) {
      const r = await mine;
      checkout = gen === this.probeGen && this.probeCwd === cwd ? r : [];
    }
    const workspace = [realpathOr(cwd), ...checkout];
    return { workspace, grants, ...this.staticRoots() };
  }
  /** True when probe has settled (in-root latency budget applies from then). */
  get probeSettled() {
    return this.settled !== null;
  }
  staticRoots() {
    const res = this.opts.getPiResources();
    const sessionDir = this.opts.getSessionDir();
    const key = JSON.stringify([res, sessionDir]);
    if (this.cachedStatic && key === this.cachedKey) return this.cachedStatic;
    const ro = [res.agentDir, res.docsDir, ...res.skillDirs, ...res.contextFiles].filter((x) => !!x).map(realpathOr);
    const rw = [os6.tmpdir(), ...nodePath2.sep === "/" ? ["/tmp"] : [], ...sessionDir ? [sessionDir] : []].map(realpathOr);
    this.cachedKey = key;
    this.cachedStatic = { readOnly: ro, readWrite: rw };
    return this.cachedStatic;
  }
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-extension/src/path-gate/grant-cache.ts
import * as fs8 from "node:fs";
import os7 from "node:os";
import nodePath3 from "node:path";
function defaultGrantsFile() {
  const override = process.env.PI_ACCESS_GRANTS_STORE;
  if (override?.trim()) return nodePath3.resolve(override);
  return nodePath3.join(os7.homedir(), ".pi", "dashboard", "access-grants.json");
}
var GrantCache = class {
  sig = "";
  subjects = [];
  file;
  opts;
  constructor(opts = {}) {
    this.opts = opts;
    this.file = opts.file ?? defaultGrantsFile();
  }
  /** Project-scope grant subjects; re-read only when mtime/size changed. */
  get() {
    const stat = this.opts.statSync ?? ((p) => fs8.statSync(p));
    let st;
    try {
      st = stat(this.file);
    } catch {
      this.sig = "";
      this.subjects = [];
      return this.subjects;
    }
    const sig = `${st.mtimeMs}:${st.size}:${st.ino ?? 0}:${st.ctimeMs ?? 0}`;
    if (sig === this.sig) return this.subjects;
    this.sig = sig;
    this.subjects = this.parse();
    return this.subjects;
  }
  parse() {
    try {
      const raw = (this.opts.readFileSync ?? ((p) => fs8.readFileSync(p, "utf8")))(this.file);
      const json = JSON.parse(raw);
      const store = json;
      if (!store || store.version !== 1 || !Array.isArray(store.grants)) return [];
      const list = store.grants;
      const out = [];
      for (const g of list) {
        if (!g || typeof g !== "object") continue;
        const { subject, scope } = g;
        if (typeof subject === "string" && subject && (scope === void 0 || scope === "project")) out.push(subject);
      }
      return out;
    } catch {
      return [];
    }
  }
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/config.ts
import os8 from "node:os";
import path12 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/acp/acp-config.ts
var DEFAULT_ACP_SETTINGS = {
  protocolV2: false,
  spawnTimeoutMs: 3e4,
  requestTimeoutMs: 3e4,
  maxLineBytes: 4 * 1024 * 1024,
  eventLogMaxBytes: 64 * 1024 * 1024
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/file-kind.ts
var MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
var DIGEST_CEILING_BYTES = 256 * 1024 * 1024;
var OFFICE_SIZE_CAPS = {
  docx: 40 * 1024 * 1024,
  pptx: 100 * 1024 * 1024,
  sheet: 50 * 1024 * 1024
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/heap-limits.ts
var DEFAULT_SESSION_HEAP = {
  /**
   * 512. Measured peak across 11 live sessions was 148 MB `heapUsed` against
   * the 8384 MB ceiling they inherited from the server — the headroom is
   * unused, and V8 sizes major-GC aggressiveness against the ceiling.
   */
  maxOldSpaceMb: 512
};
var DEFAULT_SERVER_HEAP = {
  /**
   * 1536. ~112 MB non-store baseline + the 768 MiB store budget expressed as
   * HEAP (~1024 MB — the budget counts serialized `data` bytes, not V8 heap
   * bytes) + ~51 MB `GLOBAL_TRIM_SLACK` ⇒ ~1187 MB steady state against a
   * ~1417 MB effective crash point: ~84% occupancy, an accepted trade-off
   * rather than a comfortable margin. Raise to 2048 (~65%) if the telemetry
   * this change adds shows sustained pressure.
   */
  maxOldSpaceMb: 1536
};
var BYTES_PER_MIB = 1024 * 1024;

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/memory-limits.ts
var DEFAULT_MEMORY_LIMITS = {
  // 20000 (was 5000): subagent-heavy turns forward thousands of inner events
  // into the parent buffer; the old cap trimmed the chat head.
  // See change: preserve-chat-head-on-event-trim.
  maxEventsPerSession: 2e4,
  maxStringFieldSize: 0,
  maxWsBufferBytes: 4 * 1024 * 1024,
  /**
   * 2000 (was 0 = unlimited): at `0` nobody gets windowing without reading the
   * issue thread. `computeReplayWindow` early-returns when the compacted stream
   * fits, so any session compacting below 2000 takes the pre-change path
   * exactly. Geometry at 2000: head 200 (at `HEAD_CAP`, so the protected chat
   * head is maximal), tail 1800. `0` remains the exact rollback.
   * See change: lazy-load-session-history (D13), fix-lazy-history-backfill-ux (D7).
   */
  maxReplayEvents: 2e3,
  // The shipped shape stays the default; `tail-only` is opt-in and is also the
  // rollback lever (unset the field). See change: add-tail-only-replay-window.
  replayWindowMode: "head-tail",
  /**
   * 32 MiB. BELOW the 36 MB measured per pegged session on the live server
   * (heap snapshot, 35.8 h uptime) ON PURPOSE: a default above the observed
   * occupancy never fires, and the sessions that filled the heap were each
   * individually legal. A normal 1–3 KiB-event session is 20–60 MiB, so this
   * binds on exactly the chatty sessions that caused the OOM.
   * See change: bound-event-store-by-bytes (D5).
   */
  maxBytesPerSession: 32 * 1024 * 1024,
  /**
   * 768 MiB, sized to the 686 MB currently resident on the live server. The
   * per-session budget alone is insufficient — `maxBytesPerSession ×
   * maxCachedSessions` is the true envelope, and 32 × 32 MiB = 1 GiB exceeds
   * the global budget, so this is the binding constraint.
   * See change: bound-event-store-by-bytes (D7).
   */
  maxTotalEventBytes: 768 * 1024 * 1024,
  /**
   * 32 (was hardcoded 100 at `server.ts:925`). Covers the observed 13 active /
   * 19 pegged sessions with headroom; evicted sessions rehydrate from their
   * transcript on reopen, so the cost is latency on an old session, not loss.
   * MUST equal the store's `DEFAULT_MAX_CACHED_SESSIONS` (asserted by a test).
   * See change: bound-event-store-by-bytes (D8).
   */
  maxCachedSessions: 32
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/vault-delivery.ts
var VAULT_GRACE_DEFAULT_HOURS = 24;

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/config.ts
var CONFIG_DIR = path12.join(os8.homedir(), ".pi", "dashboard");
var CONFIG_FILE = path12.join(CONFIG_DIR, "config.json");
var DEFAULT_REATTACH_PLACEMENT = "always";
var DEFAULT_REOPEN_SESSIONS_AFTER_SHUTDOWN = "ask";
var DEFAULT_VAULT_CONFIG = { deliveryEnabled: true, offlineGraceHours: VAULT_GRACE_DEFAULT_HOURS };
var DEFAULT_EDITOR_CONFIG = {
  largeFileLimitMb: MAX_PREVIEW_BYTES / (1024 * 1024)
};
var DEFAULT_OPENSPEC_POLL = {
  enabled: true,
  // 60s baseline: even after local derivation kills the per-change spawn
  // storm, a larger interval reduces churn for large change sets.
  // See change: optimize-openspec-poll-derive-artifacts-locally.
  pollIntervalSeconds: 60,
  maxConcurrentSpawns: 3,
  changeDetection: "mtime",
  useWorker: true,
  jitterSeconds: 5,
  optOutDirectories: [],
  offerInitialization: true,
  workflowSchema: { defaultForNewProjects: false }
};
var DEFAULT_SESSIONS = {
  useLoadWorker: true
};
var DEFAULT_SESSION_LIST = {
  archiveAfterDays: 30,
  archiveSweepIntervalMinutes: 60,
  archiveServiceSessionsOnEnd: true
};
var DEFAULT_KEEPER_LOG = {
  capturePiOutput: false,
  maxBytes: 134217728,
  // 128 MiB
  checkIntervalMs: 5e3
};
var DEFAULT_EMBED_LIFECYCLE = {
  enabled: false,
  idleTimeoutSeconds: 1800,
  hardCeilingSeconds: 3600,
  graceWindowSeconds: 30,
  sweepIntervalSeconds: 60,
  registerTimeoutSeconds: 30,
  maxActiveEmbedSessionsPerVisitor: 5,
  maxActiveEmbedSessionsGlobal: 50
};
var DEFAULT_TLS_PORT = 8443;
var DEFAULT_TLS_HOST = "127.0.0.1";
var DEFAULT_TLS = {
  enabled: false,
  port: DEFAULT_TLS_PORT,
  host: DEFAULT_TLS_HOST,
  sources: []
};
var DEFAULT_MODEL_PROXY = {
  enabled: true,
  maxConcurrentStreams: 16,
  perKeyConcurrentStreams: 4,
  logRequests: false,
  apiKeys: []
};
var DEFAULT_TERMINALS_CONFIG = {
  maxConcurrent: 32,
  maxPerOwner: 16,
  inlineOrphanTtlMs: 6e5
};
var DEFAULT_BROWSE_CONFIG = { confineRemote: true };
var DEFAULT_KROKI_CONFIG = {
  allowRemote: false
};
var DEFAULT_MERMAID_REPAIR = {
  enabled: false,
  maxChars: 2e4,
  timeoutMs: 3e4
};
var DEFAULT_PI_TRUST_MIRROR = {
  enabled: true,
  coverInteractive: false,
  sources: { worktreeInit: true, workflow: true, pinned: true, folderWorkspaces: true, accessGrants: false }
};
var DEFAULT_AGENT_PATH_GATE = { enabled: true, timeoutSeconds: 120 };
function resolveAgentPathGate(cfg, env = process.env) {
  const v = env.PI_DASHBOARD_AGENT_PATH_GATE?.trim().toLowerCase();
  if (v === "off") return { ...cfg, enabled: false };
  if (v === "on") return { ...cfg, enabled: true };
  return cfg;
}
var DEFAULT_BRIDGE_ACTIVATION = { enabled: true };
var DEFAULT_QUESTIONS = { autoBrief: true, minBriefChars: 240 };
var DEFAULT_ASK_USER_PROMPT_TIMEOUT_SECONDS = 300;
var HEALTH_CHECK_TIMEOUT_MS = 1e4;
var SPAWN_READINESS_BUDGET_MS = HEALTH_CHECK_TIMEOUT_MS * 3;
var SERVER_STARTUP_DEADLINE_MS = SPAWN_READINESS_BUDGET_MS * 4;
var DEFAULT_REMOVE_BATCH_CAP = 50;
var DEFAULT_DASHBOARD_PORT = 8e3;
var DEFAULT_GATEWAY_PORT = 9999;
var DEFAULT_SUBAGENT_TICK_THROTTLE_MS = 500;
var DEFAULT_IDENTITY = {
  trustedResolverPlugins: [],
  resolverTimeoutMs: 2e3,
  policyTimeoutMs: 500
};
var DEFAULT_MAX_CONCURRENT_SUBAGENTS = 2;
var DEFAULTS = {
  plugins: {},
  terminals: { ...DEFAULT_TERMINALS_CONFIG },
  browse: { ...DEFAULT_BROWSE_CONFIG },
  kroki: { ...DEFAULT_KROKI_CONFIG },
  mermaidRepair: { ...DEFAULT_MERMAID_REPAIR },
  modelProxy: { ...DEFAULT_MODEL_PROXY },
  tls: { ...DEFAULT_TLS, sources: [] },
  port: DEFAULT_DASHBOARD_PORT,
  piPort: DEFAULT_GATEWAY_PORT,
  bindHost: "127.0.0.1",
  autoStart: true,
  autoShutdown: false,
  shutdownIdleSeconds: 300,
  // Historical hardcoded value of the bridge cold-start health window — the
  // shared health-poll constant, referenced rather than respelled so the two
  // cannot drift. See change: add-configurable-readiness-timeout.
  readinessTimeoutMs: HEALTH_CHECK_TIMEOUT_MS,
  subagentTickThrottleMs: DEFAULT_SUBAGENT_TICK_THROTTLE_MS,
  maxConcurrentSubagents: DEFAULT_MAX_CONCURRENT_SUBAGENTS,
  removeBatchCap: DEFAULT_REMOVE_BATCH_CAP,
  spawnStrategy: "headless",
  tunnel: {
    enabled: true,
    zrok: { persistent: false },
    watchdog: {
      enabled: true,
      intervalMs: 6e4,
      failureThreshold: 2,
      probeTimeoutMs: 1e4
    }
  },
  devBuildOnReload: false,
  accessGrants: { promptEnabled: false },
  piTrustMirror: { ...DEFAULT_PI_TRUST_MIRROR, sources: { ...DEFAULT_PI_TRUST_MIRROR.sources } },
  agentPathGate: { ...DEFAULT_AGENT_PATH_GATE },
  bridge: { ...DEFAULT_BRIDGE_ACTIVATION },
  defaultModel: "",
  defaultThinkingLevel: "",
  memoryLimits: { ...DEFAULT_MEMORY_LIMITS },
  sessionHeap: { ...DEFAULT_SESSION_HEAP },
  serverHeap: { ...DEFAULT_SERVER_HEAP },
  openspec: { ...DEFAULT_OPENSPEC_POLL },
  editor: { ...DEFAULT_EDITOR_CONFIG },
  vault: { ...DEFAULT_VAULT_CONFIG },
  sessions: { ...DEFAULT_SESSIONS },
  sessionList: { ...DEFAULT_SESSION_LIST },
  embedLifecycle: { ...DEFAULT_EMBED_LIFECYCLE },
  keeperLog: { ...DEFAULT_KEEPER_LOG },
  acpAgents: [],
  acp: { ...DEFAULT_ACP_SETTINGS },
  allowedHosts: [],
  hostGate: { mode: "enforce" },
  trustedNetworks: [],
  requireLocalProof: false,
  resolvedTrustedNetworks: [],
  cors: { allowedOrigins: [] },
  pairing: { publicBaseUrls: [], acceptLanRequests: false },
  electronMode: false,
  knownServers: [],
  questions: { ...DEFAULT_QUESTIONS },
  askUserPromptTimeoutSeconds: DEFAULT_ASK_USER_PROMPT_TIMEOUT_SECONDS,
  reattachPlacement: DEFAULT_REATTACH_PLACEMENT,
  reopenSessionsAfterShutdown: DEFAULT_REOPEN_SESSIONS_AFTER_SHUTDOWN,
  completedFirst: false,
  questionFirst: false,
  folderListMode: "classic",
  folderAttentionPeek: true,
  spawnRegisterTimeoutMs: 3e4,
  gitWorktreeEnabled: true,
  windowsGitSource: "auto",
  identity: { ...DEFAULT_IDENTITY }
};
export {
  DEFAULT_AGENT_PATH_GATE,
  GrantCache,
  RootsProvider,
  Suppression,
  buildOptions,
  canonicalSubject,
  canonicalizeTarget,
  createAccessGrantStore,
  createPathGateHandler,
  decidePathAccess,
  defaultResolveEnv,
  forbiddenGrantSubjects,
  isAllowed,
  isGrantAdmitted,
  isPathWithinRoots,
  isUngrantableSubject,
  offeredAncestorLadder,
  realpathNearestAncestor,
  resolveAgentPathGate,
  resolveReadTarget,
  resolveToolPath,
  within
};
