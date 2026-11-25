// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/access.ts
import { lstat as lstat2 } from "node:fs/promises";
import path9 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/cwd-guard.ts
import { realpathSync as realpathSync2 } from "node:fs";
import { resolve } from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/git.ts
import { realpath as fsRealpath } from "node:fs/promises";
import path6 from "node:path";

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

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/runner.ts
import { existsSync as existsSync4 } from "node:fs";
import path5 from "node:path";
import { StringDecoder } from "node:string_decoder";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/binary-lookup.ts
import { existsSync as existsSync3, realpathSync } from "node:fs";
import os2 from "node:os";
import path4 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/managed-paths.ts
import path from "node:path";
import os from "node:os";
function getManagedDir(env) {
  return path.join(env?.homedir ?? os.homedir(), ".pi-dashboard");
}
function getManagedBin(env) {
  return path.join(getManagedDir(env), "node_modules", ".bin");
}
function getPiSettingsPath(env) {
  return path.join(env?.homedir ?? os.homedir(), ".pi", "agent", "settings.json");
}
var MANAGED_DIR = getManagedDir();
var MANAGED_BIN = getManagedBin();
var PI_SETTINGS_PATH = getPiSettingsPath();

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/platform/ensure-windows-path.ts
import { existsSync } from "node:fs";
import path2 from "node:path";
function ensureWindowsSystemPath(env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  const exists = opts.exists ?? existsSync;
  const systemRoot = env.SYSTEMROOT || env.SystemRoot || env.systemroot || "C:\\Windows";
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || env.localappdata || "";
  const join = path2.win32.join;
  const candidates = [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    join(systemRoot, "System32", "OpenSSH")
  ];
  if (localAppData) {
    candidates.push(join(localAppData, "Microsoft", "WindowsApps"));
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
import path3 from "node:path";
var GIT_LIBDIRS = ["mingw64", "clangarm64"];
var GIT_LAUNCHER_REL = path3.win32.join("cmd", "git.exe");
function resolveBundledGitDir(opts = {}) {
  const exists = opts.exists ?? existsSync2;
  const join = path3.win32.join;
  const roots = [];
  if (opts.resourcesPath) roots.push(join(opts.resourcesPath, "git"));
  for (const c of opts.candidates ?? []) roots.push(c);
  for (const root of roots) {
    if (exists(join(root, GIT_LAUNCHER_REL))) return root;
  }
  return null;
}
function resolveLibDir(gitDir, exists) {
  for (const name of GIT_LIBDIRS) {
    if (exists(path3.win32.join(gitDir, name))) return name;
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
  const join = path3.win32.join;
  const libDir = resolveLibDir(gitDir, exists);
  const dirs = [join(gitDir, "cmd"), join(gitDir, "usr", "bin")];
  if (libDir) dirs.push(join(gitDir, libDir, "bin"));
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
    const execPath = join(gitDir, libDir, "libexec", "git-core");
    if (exists(execPath) && out.GIT_EXEC_PATH !== execPath) {
      out = { ...out, GIT_EXEC_PATH: execPath };
    }
  }
  if (libDir) {
    const caBundle = join(gitDir, libDir, "ssl", "certs", "ca-bundle.crt");
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
    const managed = path4.join(MANAGED_BIN, name + ext);
    if (existsSync3(managed)) return managed;
    for (const dir of this.ctx.extraBinDirs ?? []) {
      const candidate = path4.join(dir, name + ext);
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
      const tsxCli = path4.join(MANAGED_DIR, "node_modules", "tsx", "dist", "cli.mjs");
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
      const candidate = path4.join(dir, nodeName);
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
    const delimiter = platform === "win32" ? ";" : path4.delimiter;
    const currentPath = base.PATH || "";
    const parts = [];
    if (!currentPath.includes(MANAGED_BIN)) {
      parts.push(MANAGED_BIN);
    }
    const nodeBin = this.ctx.processExecPath ? path4.dirname(this.ctx.processExecPath) : null;
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
    const text2 = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
    return text2.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
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
  const home = os2.homedir();
  return [
    path4.join(home, ".local", "bin"),
    path4.join(home, ".npm-global", "bin"),
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
  if (path5.isAbsolute(cmd)) return true;
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
  return path6.basename(normalizePath(commonDirRaw, platform)) === ".git";
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
      mainCheckout: normalizePath(path6.resolve(commonDir, configured), platform),
      commonDir,
      gitDir
    };
  }
  const bare = wantsBareness(commonDir, platform) ? readBareness(probes, commonDir) : "unknown";
  if (bare === "not-bare") {
    return {
      thisCheckout,
      isLinkedWorktree,
      mainCheckout: normalizePath(path6.dirname(commonDir), platform),
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
function isUnder(p, base) {
  const rel = path6.relative(base, p);
  return rel === "" || !rel.startsWith(".." + path6.sep) && rel !== ".." && !path6.isAbsolute(rel);
}
function bindDecision(candidateCanon, commonCanon, reResolved, reCommonCanon, reThisCanon, platform) {
  if (!reResolved) return false;
  if (!reCommonCanon || !samePath(reCommonCanon, commonCanon, platform)) return false;
  if (!reThisCanon) return false;
  if (!samePath(reThisCanon, candidateCanon, platform)) return false;
  return !isUnder(candidateCanon, commonCanon);
}
async function realpathAsync(p) {
  try {
    return { kind: "ok", path: await fsRealpath(p) };
  } catch (err) {
    const code = err?.code ?? "UNKNOWN";
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "error", code };
  }
}
function classifiedRunner(opts) {
  const runner = opts.runner ?? runAsync;
  const injected = opts.runner !== void 0;
  return async (recipe, input) => {
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      opts.onProbeEnd?.();
    };
    opts.onProbeStart?.();
    try {
      return await runner(recipe, input, {
        cwd: input.cwd,
        timeout: opts.timeout,
        signal: opts.signal,
        onClose: end
      });
    } finally {
      if (injected && !opts.signal?.aborted) end();
    }
  };
}
async function checkoutRootsClassifiedAsync(input, opts = {}) {
  const exec = classifiedRunner(opts);
  const failed = [];
  const fail = (name) => {
    if (!failed.includes(name)) failed.push(name);
  };
  const roots = await resolveCheckoutRootsFromAsync({
    gitDir: async () => {
      const r = await exec(GIT_DIR_ABS, input);
      if (r.ok) return r.value;
      if (r.error.kind !== "exit") fail("git-dir");
      return void 0;
    },
    commonDir: async () => {
      const r = await exec(GIT_COMMON_DIR_ABS, input);
      if (r.ok) return r.value;
      if (r.error.kind !== "exit") fail("git-common-dir");
      return void 0;
    },
    topLevel: async () => {
      const r = await exec(GIT_TOPLEVEL, input);
      if (r.ok) return r.value;
      if (r.error.kind !== "exit") fail("show-toplevel");
      return void 0;
    },
    localCoreWorktree: async (commonDir) => {
      const r = await exec(GIT_CONFIG_LOCAL_CORE_WORKTREE, { cwd: input.cwd, gitDir: commonDir });
      if (r.ok) return r.value;
      fail("config core.worktree");
      return void 0;
    },
    localCoreBare: async (commonDir) => {
      if (failed.length > 0) return "unknown";
      const r = await exec(GIT_CONFIG_LOCAL_CORE_BARE, { cwd: input.cwd, gitDir: commonDir });
      if (!r.ok) {
        fail("config core.bare");
        return "unknown";
      }
      return r.value === "true" ? "bare" : "not-bare";
    }
  });
  if (failed.length > 0) return { kind: "failed", failedProbes: failed };
  return roots ? { kind: "roots", roots } : { kind: "none" };
}
async function canonicalClassified(p, platform, realpath3) {
  const r = await realpath3(p);
  if (r.kind === "error") return null;
  return normalizePath(r.kind === "ok" ? r.path : p, platform);
}
async function bindCheckoutClassifiedAsync(candidate, commonDir, opts = {}) {
  const platform = process.platform;
  const realpath3 = opts.realpath ?? realpathAsync;
  const real = await realpath3(candidate);
  if (real.kind === "missing") return { kind: "unbound" };
  if (real.kind === "error") return { kind: "failed", failedProbes: ["realpath"] };
  if (hasGitPathSegment(real.path)) return { kind: "unbound" };
  const re = await checkoutRootsClassifiedAsync({ cwd: real.path }, opts);
  if (re.kind === "failed") return re;
  if (re.kind === "none") return { kind: "unbound" };
  const reResolved = re.roots;
  const [candidateCanon, commonCanon, reCommonCanon, reThisCanon] = await Promise.all([
    canonicalClassified(real.path, platform, realpath3),
    canonicalClassified(commonDir, platform, realpath3),
    canonicalClassified(reResolved.commonDir, platform, realpath3),
    reResolved.thisCheckout ? canonicalClassified(reResolved.thisCheckout, platform, realpath3) : Promise.resolve("")
  ]);
  if (candidateCanon === null || commonCanon === null || reCommonCanon === null || reThisCanon === null) {
    return { kind: "failed", failedProbes: ["realpath"] };
  }
  return bindDecision(candidateCanon, commonCanon, reResolved, reCommonCanon, reThisCanon || null, platform) ? { kind: "bound" } : { kind: "unbound" };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/cwd-guard.ts
function canonPath(p) {
  const abs = resolve(p);
  try {
    return realpathSync2(abs);
  } catch {
    return abs;
  }
}
var ADMISSION_MAX_CONCURRENT = 4;
var ADMISSION_PROBE_TIMEOUT_MS = 1e3;
var ADMISSION_DEADLINE_MS = 3e3;
var tokens = /* @__PURE__ */ new WeakMap();
function mintToken(canonCwd, rawCwd) {
  const token = Object.freeze({ canonCwd, rawCwd });
  tokens.set(token, { live: true });
  return token;
}
function releaseAdmission(token) {
  const state = tokens.get(token);
  if (state) state.live = false;
}
var activeDerivations = 0;
var slotWaiters = [];
function acquireSlot() {
  if (activeDerivations < ADMISSION_MAX_CONCURRENT) {
    activeDerivations++;
    return { granted: Promise.resolve(), cancel: () => false };
  }
  let wake;
  const granted = new Promise((res) => {
    wake = res;
  });
  slotWaiters.push(wake);
  return {
    granted,
    cancel: () => {
      const i = slotWaiters.indexOf(wake);
      if (i < 0) return false;
      slotWaiters.splice(i, 1);
      return true;
    }
  };
}
function releaseSlot() {
  const next = slotWaiters.shift();
  if (next) next();
  else activeDerivations--;
}
var inflight = /* @__PURE__ */ new Map();
function derive(canon, known, opts, enteredAt) {
  const existing = inflight.get(canon);
  if (existing) return existing;
  const promise = new Promise((resolveOuter) => {
    const abort = new AbortController();
    let liveProbes = 0;
    let finished = false;
    let slotHeld = false;
    let slotReleased = false;
    let settledOuter = false;
    const settle = (d) => {
      if (settledOuter) return;
      settledOuter = true;
      clearTimeout(deadlineTimer);
      inflight.delete(canon);
      resolveOuter(d);
    };
    const maybeRelease = () => {
      if (slotHeld && finished && liveProbes === 0 && !slotReleased) {
        slotReleased = true;
        releaseSlot();
      }
    };
    const deadlineMs = opts.deadlineMs ?? ADMISSION_DEADLINE_MS;
    const slot = acquireSlot();
    const deadlineTimer = setTimeout(
      () => {
        const wasQueued = slot.cancel();
        abort.abort();
        settle({ kind: "indeterminate", failedProbes: ["deadline"] });
        if (wasQueued) return;
        finished = true;
        maybeRelease();
      },
      Math.max(0, deadlineMs - (Date.now() - enteredAt))
    );
    const gitOpts = {
      timeout: opts.probeTimeoutMs ?? ADMISSION_PROBE_TIMEOUT_MS,
      signal: abort.signal,
      runner: opts.runner,
      onProbeStart: () => {
        liveProbes++;
      },
      onProbeEnd: () => {
        liveProbes--;
        maybeRelease();
      }
    };
    void (async () => {
      await slot.granted;
      if (settledOuter) {
        slotHeld = true;
        finished = true;
        maybeRelease();
        return;
      }
      slotHeld = true;
      try {
        settle(await deriveOnce(canon, known, gitOpts, opts.realpath ?? realpathAsync));
      } catch {
        settle({ kind: "indeterminate", failedProbes: ["derivation"] });
      } finally {
        finished = true;
        maybeRelease();
      }
    })();
  });
  inflight.set(canon, promise);
  return promise;
}
async function deriveOnce(canon, known, gitOpts, realpath3) {
  const rootsResult = await checkoutRootsClassifiedAsync({ cwd: canon }, gitOpts);
  if (rootsResult.kind === "failed") return { kind: "indeterminate", failedProbes: rootsResult.failedProbes };
  if (rootsResult.kind === "none") return { kind: "refuse" };
  const { mainCheckout, commonDir } = rootsResult.roots;
  if (!mainCheckout) return { kind: "refuse" };
  const bound = await bindCheckoutClassifiedAsync(mainCheckout, commonDir, gitOpts);
  if (bound.kind === "failed") return { kind: "indeterminate", failedProbes: bound.failedProbes };
  if (bound.kind === "unbound") return { kind: "refuse" };
  const main = await realpath3(resolve(mainCheckout));
  if (main.kind === "error") return { kind: "indeterminate", failedProbes: ["realpath"] };
  if (main.kind === "missing") return { kind: "refuse" };
  const knownCanon = await canonKnownClassified(known, realpath3);
  if (knownCanon.canon.includes(main.path)) return { kind: "admit" };
  return knownCanon.uncertain ? { kind: "indeterminate", failedProbes: ["realpath"] } : { kind: "refuse" };
}
async function canonKnownClassified(known, realpath3 = realpathAsync) {
  const resolved = await Promise.all(
    known().map(async (p) => {
      const abs = resolve(p);
      const r = await realpath3(abs);
      if (r.kind === "error") return null;
      return r.kind === "ok" ? r.path : abs;
    })
  );
  const canon = resolved.filter((p) => p !== null);
  return { canon, uncertain: canon.length !== resolved.length };
}
async function admitCwd(cwd, known, opts = {}) {
  const enteredAt = Date.now();
  const run2 = { fenced: false, loggedCwd: cwd };
  const indeterminate = (failedProbes) => {
    const info = { cwd: run2.loggedCwd, failedProbes, elapsedMs: Date.now() - enteredAt };
    try {
      opts.onIndeterminate?.(info);
    } catch {
    }
    return { kind: "indeterminate", failedProbes, elapsedMs: info.elapsedMs };
  };
  let timer;
  const expired = new Promise((resolveExpired) => {
    timer = setTimeout(() => {
      run2.fenced = true;
      resolveExpired(indeterminate(["deadline"]));
    }, opts.deadlineMs ?? ADMISSION_DEADLINE_MS);
  });
  try {
    return await Promise.race([decideAdmission(cwd, known, opts, enteredAt, run2, indeterminate), expired]);
  } finally {
    clearTimeout(timer);
  }
}
async function decideAdmission(cwd, known, opts, enteredAt, run2, indeterminate) {
  const STOP = { kind: "refuse" };
  const realpath3 = opts.realpath ?? realpathAsync;
  const abs = resolve(cwd);
  const real = await realpath3(abs);
  if (run2.fenced) return STOP;
  if (real.kind === "error") return indeterminate(["realpath"]);
  const canon = real.kind === "ok" ? real.path : abs;
  run2.loggedCwd = canon;
  if (hasGitPathSegment(canon)) return { kind: "refuse" };
  const knownCanon = await canonKnownClassified(known, realpath3);
  if (run2.fenced) return STOP;
  if (knownCanon.canon.includes(canon)) return { kind: "admit", token: mintToken(canon, cwd) };
  const derived = real.kind === "missing" ? { kind: "refuse" } : await derive(canon, known, opts, enteredAt);
  if (run2.fenced) return STOP;
  if (derived.kind === "indeterminate") return indeterminate(derived.failedProbes);
  if (derived.kind === "admit") return { kind: "admit", token: mintToken(canon, cwd) };
  return knownCanon.uncertain ? indeterminate(["realpath"]) : { kind: "refuse" };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/session-meta.ts
import fs from "node:fs";
import path7 from "node:path";
function metaPath(sessionFile) {
  const dir = path7.dirname(sessionFile);
  const base = path7.basename(sessionFile, ".jsonl");
  return path7.join(dir, `${base}.meta.json`);
}
function writeSessionMeta(sessionFile, meta) {
  const p = metaPath(sessionFile);
  const dir = path7.dirname(p);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = p + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(meta, null, 2) + "\n");
  fs.renameSync(tmpPath, p);
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/identity/host-resources.ts
var HostActions = {
  workspaceRead: "workspace.read",
  workspaceWrite: "workspace.write",
  openspecRead: "openspec.read",
  openspecWrite: "openspec.write",
  branchRead: "branch.read",
  branchWrite: "branch.write",
  terminalRead: "terminal.read",
  terminalCreate: "terminal.create",
  terminalWrite: "terminal.write",
  systemRead: "system.read",
  systemWrite: "system.write",
  // D24 families: every core non-session road is classifiable.
  filesRead: "files.read",
  filesWrite: "files.write",
  configRead: "config.read",
  configWrite: "config.write",
  providersRead: "providers.read",
  providersWrite: "providers.write",
  pluginsRead: "plugins.read",
  pluginsWrite: "plugins.write",
  packagesRead: "packages.read",
  packagesWrite: "packages.write",
  accessRead: "access.read",
  accessWrite: "access.write",
  gatewayRead: "gateway.read",
  gatewayWrite: "gateway.write",
  // Proxied roads (18.37c): `/editor/` = code-server (always a write capability), `/live/` = dev-server preview.
  editorWrite: "editor.write",
  liveRead: "live.read",
  liveWrite: "live.write",
  /** Manage the credential vault (`/api/vault*`, `ungranted`). See change: retro-ux-credential-vault (D11). */
  vaultManage: "vault.manage",
  /** A plugin-emitted global domain event (fan-out road, §10). */
  domainEvent: "domain.event"
};
var hostResource = {
  workspace: (path12) => ({ kind: "workspace", ...path12 ? { path: path12 } : {} }),
  openspec: (cwd) => ({ kind: "openspec", ...cwd ? { cwd } : {} }),
  branch: (cwd) => ({ kind: "branch", ...cwd ? { cwd } : {} }),
  terminal: (id) => ({ kind: "terminal", ...id ? { id } : {} }),
  system: () => ({ kind: "system" }),
  vault: () => ({ kind: "vault" }),
  /** A plugin domain event; identifies the emitter + event type, never payload. */
  domain: (pluginId, eventType) => ({
    kind: "domain",
    pluginId,
    eventType
  })
};

// ../../../../../tmp/pi-research-cli-migration.v7tTjLEI/research-host/workbench/errors.mjs
var ResWorkflowError = class extends Error {
  constructor(statusCode, code, message = code) {
    super(message);
    this.name = "ResWorkflowError";
    this.statusCode = statusCode;
    this.code = code;
  }
};

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/safe-files.ts
import { lstat, mkdir, realpath } from "node:fs/promises";
import path8 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/access/verified-read.ts
import { constants, promises as fs2 } from "node:fs";
var VerifiedReadRefused = class extends Error {
  reason;
  subject;
  constructor(reason, subject) {
    super(`refused grant-admitted read of ${subject}: ${reason}`);
    this.name = "VerifiedReadRefused";
    this.reason = reason;
    this.subject = subject;
  }
};
var OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
var SYMLINK_ERRNOS = /* @__PURE__ */ new Set(["ELOOP", "EMLINK"]);
async function openVerifiedRegularFile(resolved) {
  const linkStat = await fs2.lstat(resolved);
  if (!linkStat.isFile()) throw new VerifiedReadRefused("not-regular", resolved);
  let handle;
  try {
    handle = await fs2.open(resolved, OPEN_FLAGS);
  } catch (err) {
    const code = err.code;
    if (code && SYMLINK_ERRNOS.has(code)) {
      throw new VerifiedReadRefused("not-regular", resolved);
    }
    throw err;
  }
  try {
    const handleStat = await handle.stat();
    if (!handleStat.isFile() || handleStat.dev !== linkStat.dev || handleStat.ino !== linkStat.ino) {
      throw new VerifiedReadRefused("handle-mismatch", resolved);
    }
    return handle;
  } catch (err) {
    await handle.close().catch(() => {
    });
    throw err;
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/safe-files.ts
function inside(root, target) {
  const relative = path8.relative(root, target);
  return relative === "" || !relative.startsWith(`..${path8.sep}`) && relative !== ".." && !path8.isAbsolute(relative);
}
async function assertNoLinks(root, target) {
  const realRoot = await realpath(root).catch(() => root);
  const realTarget = await realpath(target).catch(() => target);
  if (!inside(realRoot, realTarget)) throw new Error("path-outside-root");
  let current = realRoot;
  for (const part of path8.relative(realRoot, realTarget).split(path8.sep).filter(Boolean)) {
    current = path8.join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new Error("symlink");
  }
}
async function readBoundedRegular(file, maxBytes, root) {
  if (root) await assertNoLinks(root, file);
  const handle = await openVerifiedRegularFile(file);
  try {
    const before = await handle.stat();
    if (before.size > maxBytes) throw new Error("byte-budget");
    if (process.platform === "linux" && root && await realpath(`/proc/self/fd/${handle.fd}`) !== file) throw new Error("path-outside-root");
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytesRead > maxBytes) throw new Error("source-changed");
    return { text: buffer.subarray(0, bytesRead).toString("utf8"), bytes: bytesRead, timestamp: before.mtime.toISOString() };
  } finally {
    await handle.close();
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/access.ts
async function resWorkflowAccess(deps, identity, rawCwd) {
  const isLocalOperator = deps.isLocalOperator ?? (() => false);
  const canAccessSession = ({ active: active2, principal: principal2, owner }) => !active2 || isLocalOperator(principal2) || !!owner && !!principal2 && owner.iss === principal2.iss && owner.sub === principal2.sub;
  if (typeof rawCwd !== "string" || !rawCwd || rawCwd.length > 4096 || rawCwd.includes("\0") || !path9.isAbsolute(rawCwd)) throw new ResWorkflowError(400, "absolute-cwd-required");
  const active = deps.isResolverActive?.() ?? false;
  const principal = identity.principal;
  if (active && !principal) throw new ResWorkflowError(404, "workspace-not-found");
  const validateIdentity = () => {
    if (active !== (deps.isResolverActive?.() ?? false) || typeof identity.expiresAt === "number" && Date.now() >= identity.expiresAt) throw new ResWorkflowError(403, "adoption-identity-expired");
  };
  const operator = !active || isLocalOperator(principal);
  const admitForOwner = async (target) => {
    const admission = await admitCwd(target, deps.knownCwds, deps.admitOptions);
    if (admission.kind !== "admit" || operator) return admission;
    const ownedCwds = deps.history().filter((row) => !row.originDeviceId && row.cwd && canAccessSession({ active, principal, owner: row.principalOwner })).map((row) => row.cwd);
    const owned = ownedCwds.length ? await admitCwd(admission.token.canonCwd, () => ownedCwds, deps.admitOptions) : { kind: "refuse" };
    if (owned.kind === "admit") {
      releaseAdmission(owned.token);
      return admission;
    }
    if (owned.kind === "indeterminate") {
      releaseAdmission(admission.token);
      return owned;
    }
    if (principal && deps.hostPolicy?.hasPolicy()) {
      try {
        const action = identity.write ? HostActions.workspaceWrite : HostActions.workspaceRead;
        if (await deps.hostPolicy.authorize({ principal, action, resource: hostResource.workspace(admission.token.canonCwd) })) return admission;
      } catch {
      }
    }
    releaseAdmission(admission.token);
    return { kind: "refuse" };
  };
  validateIdentity();
  const admitted = await admitForOwner(rawCwd);
  if (admitted.kind === "indeterminate") throw new ResWorkflowError(503, "cwd-admission-unavailable");
  if (admitted.kind !== "admit") throw new ResWorkflowError(operator ? 403 : 404, operator ? "cwd-not-allowed" : "workspace-not-found");
  const cwd = admitted.token.canonCwd;
  releaseAdmission(admitted.token);
  if (!(await lstat2(cwd).catch(() => null))?.isDirectory()) throw new ResWorkflowError(404, "folder-not-found");
  validateIdentity();
  return {
    cwd,
    ownerKey: JSON.stringify(principal ? [principal.iss, principal.sub] : ["host", "inert-operator"]),
    write: identity.write,
    async revalidate() {
      validateIdentity();
      const current = await admitForOwner(cwd);
      if (current.kind === "indeterminate") throw new ResWorkflowError(503, "cwd-admission-unavailable");
      if (current.kind !== "admit") throw new ResWorkflowError(operator ? 403 : 404, operator ? "cwd-not-allowed" : "workspace-not-found");
      try {
        if (current.token.canonCwd !== cwd || !(await lstat2(cwd)).isDirectory()) throw new ResWorkflowError(409, "cwd-changed");
        validateIdentity();
      } finally {
        releaseAdmission(current.token);
      }
    },
    async canReadHistory(candidate) {
      validateIdentity();
      if (!active || isLocalOperator(principal)) return true;
      let owner = candidate.principalOwner;
      if (!candidate.unregistered) {
        const current = deps.history().find((item) => item.id === candidate.id && item.sessionFile === candidate.sessionFile && item.originDeviceId === candidate.originDeviceId);
        if (!current) return false;
        owner = current.principalOwner;
      } else if (candidate.sessionFile) {
        try {
          const meta = JSON.parse((await readBoundedRegular(metaPath(candidate.sessionFile), 128 * 1024)).text);
          owner = meta?.principalOwner && typeof meta.principalOwner.iss === "string" && typeof meta.principalOwner.sub === "string" ? { iss: meta.principalOwner.iss, sub: meta.principalOwner.sub } : void 0;
        } catch {
          return false;
        }
      }
      validateIdentity();
      return canAccessSession({ active, principal, owner });
    }
  };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/participants.ts
import { lstatSync, readFileSync, realpathSync as realpathSync3 } from "node:fs";
import { lstat as lstat4 } from "node:fs/promises";
import path11 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/res-workflow.ts
function isResWorkflowServiceSession(session) {
  return session.pluginHidden === true || session.archiveOnEnd === true;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/research-session.ts
var RESEARCH_SESSION_SCHEMA = "pi-research-session.v1";
var RESEARCH_SESSION_STAGES = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"];
var RESEARCH_SESSION_LIMITS = Object.freeze({
  maxPerParent: 4,
  maxTotal: 8,
  maxTaskChars: 4e3,
  maxRoleChars: 40
});
var ID = /^[A-Za-z0-9_-]{1,128}$/;
var ROLE = /^[a-z][a-z0-9-]{1,39}$/;
var ADOPTION = /^adopt-[a-f0-9]{24}$/;
var HASH = /^sha256:[a-f0-9]{64}$/;
var TOKEN = /^[A-Za-z0-9_-]{8,128}$/;
var iso = (value) => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var text = (value, max) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);
function isResearchSessionProvenance(value) {
  if (!object(value)) return false;
  const row = value;
  return row.schema === RESEARCH_SESSION_SCHEMA && ID.test(row.parentSessionId ?? "") && ID.test(row.creatorSessionId ?? "") && row.parentSessionId === row.creatorSessionId && row.creatorAgent === "research_session" && ROLE.test(row.role ?? "") && text(row.task, RESEARCH_SESSION_LIMITS.maxTaskChars) && RESEARCH_SESSION_STAGES.includes(row.stage) && HASH.test(row.charterHash ?? "") && ADOPTION.test(row.adoptionId ?? "") && text(row.workflowCwd, 4096) && row.workflowCwd.startsWith("/") && TOKEN.test(row.spawnToken ?? "") && iso(row.createdAt) && row.origin === "research_session" && row.relation === "dispatch" && (row.readOnly === void 0 || row.readOnly === true) && (row.requestId === void 0 || TOKEN.test(row.requestId)) && (row.rootSessionId === void 0 || ID.test(row.rootSessionId)) && (row.tenureId === void 0 || ID.test(row.tenureId)) && (row.depth === void 0 || Number.isSafeInteger(row.depth) && row.depth >= 1 && row.depth <= 3) && (row.dispatchId === void 0 || ID.test(row.dispatchId)) && (row.taskId === void 0 || ID.test(row.taskId)) && (row.tasks === void 0 || Array.isArray(row.tasks) && row.tasks.length >= 1 && row.tasks.length <= 64 && row.tasks.every((task) => object(task) && ID.test(task.id ?? "") && ROLE.test(task.role ?? "") && text(task.task, 4e3) && RESEARCH_SESSION_STAGES.includes(task.stage) && (task.dependsOn === void 0 || Array.isArray(task.dependsOn) && task.dependsOn.length <= 12 && task.dependsOn.every((id) => typeof id === "string" && ID.test(id)))));
}
function normalizeResearchSessionProvenance(value) {
  if (!isResearchSessionProvenance(value)) throw new Error("research-session-provenance-invalid");
  return {
    schema: value.schema,
    parentSessionId: value.parentSessionId,
    creatorSessionId: value.creatorSessionId,
    creatorAgent: value.creatorAgent,
    role: value.role,
    task: value.task,
    stage: value.stage,
    charterHash: value.charterHash,
    adoptionId: value.adoptionId,
    workflowCwd: value.workflowCwd,
    spawnToken: value.spawnToken,
    createdAt: value.createdAt,
    origin: value.origin,
    relation: value.relation,
    ...value.readOnly === true ? { readOnly: true } : {},
    ...value.requestId === void 0 ? {} : { requestId: value.requestId },
    ...value.rootSessionId === void 0 ? {} : { rootSessionId: value.rootSessionId },
    ...value.tenureId === void 0 ? {} : { tenureId: value.tenureId },
    ...value.depth === void 0 ? {} : { depth: value.depth },
    ...value.dispatchId === void 0 ? {} : { dispatchId: value.dispatchId },
    ...value.taskId === void 0 ? {} : { taskId: value.taskId },
    ...value.tasks === void 0 ? {} : { tasks: value.tasks.map((task) => ({ id: task.id, role: task.role, task: task.task, stage: task.stage, dependsOn: [...task.dependsOn ?? []] })) }
  };
}
var RESEARCH_SESSION_INITIAL_PROMPT_BYTES = 16 * 1024;

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/session-creation.ts
var object2 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var pathKey = (value) => {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) return;
  if (!/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(value)) return;
  const normalized = /^[A-Za-z]:[\\/]|^\\\\/.test(value) ? value.replace(/\\/g, "/") : value;
  return normalized.replace(/\/+$/, "") || "/";
};
function isSessionCreation(value) {
  if (!object2(value) || Object.keys(value).length !== 5) return false;
  return value.schema === "pi-session-creation.v1" && value.kind === "user" && (value.entryPoint === "dashboard" || value.entryPoint === "research-stage") && pathKey(value.cwd) !== void 0 && typeof value.createdAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.createdAt) && Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/pending/pending-plugin-ref-registry.ts
var PENDING_PLUGIN_REF_TTL_MS = 6e4;
var CORE_RESERVED_REF_KEYS = /* @__PURE__ */ new Set([
  "sessionId",
  "cwd",
  "source",
  "status",
  "closedReason",
  "live",
  "liveEpoch",
  "recover",
  "finalizeOnSocketClose",
  // Settable only through the lifecycle declaration, never a ref body.
  // See change: archive-service-sessions-on-end.
  "archiveOnEnd",
  "spawnToken",
  "sessionFile",
  "startedAt",
  "endedAt",
  "name",
  "nameSource",
  // Server-owned provenance witness; a ref body cannot forge it.
  // See change: investigate-auto-name-provenance-relabel.
  "nameSourceFor",
  // Core-owned container of every plugin's durable refs (session/plugin-refs.ts).
  "pluginRefs",
  // Settable only through the lifecycle `close` declaration; a ref body must
  // not forge another plugin's policy. See change: add-session-close-plugin-hook.
  "closePolicy"
]);
var MIN_CLOSE_IDLE_MS = 1e3;
function normalizeCloseDeclaration(close) {
  if (close === void 0) return void 0;
  if (!isPlainObject(close)) return null;
  const mode = close.mode ?? "sleep";
  if (mode !== "sleep" && mode !== "archive") return null;
  if (close.idle === void 0) return { mode };
  if (!isPlainObject(close.idle)) return null;
  const ms = close.idle.afterMs;
  if (typeof ms !== "number" || !Number.isInteger(ms) || ms < MIN_CLOSE_IDLE_MS) return null;
  return { idle: { afterMs: ms }, mode };
}
function isPlainObject(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function sanitizePluginRef(ref, ownerId, keyOwners, warnOnce) {
  if (!isPlainObject(ref)) {
    warnOnce("*");
    return {};
  }
  const out = {};
  for (const [k, v] of Object.entries(ref)) {
    if (CORE_RESERVED_REF_KEYS.has(k)) {
      warnOnce(k);
      continue;
    }
    const owner = keyOwners.get(k);
    if (owner === void 0) {
      keyOwners.set(k, ownerId);
    } else if (owner !== ownerId) {
      warnOnce(k);
      continue;
    }
    out[k] = v;
  }
  return out;
}
function createPendingPluginRefRegistry(opts = {}) {
  const now = opts.now ?? (() => Date.now());
  const warn = opts.warn ?? ((m) => console.warn(m));
  const store = /* @__PURE__ */ new Map();
  const keyOwners = /* @__PURE__ */ new Map();
  const warnedKeys = /* @__PURE__ */ new Set();
  function warnOnceForKey(key) {
    if (warnedKeys.has(key)) return;
    warnedKeys.add(key);
    warn(`[pending-plugin-ref-registry] dropped ref key "${key}" (reserved, malformed, or owned by another plugin)`);
  }
  function claimKeys(ownerId, keys) {
    for (const k of keys) {
      if (!CORE_RESERVED_REF_KEYS.has(k) && !keyOwners.has(k)) keyOwners.set(k, ownerId);
    }
  }
  function sweep() {
    const cutoff = now() - PENDING_PLUGIN_REF_TTL_MS;
    for (const [token, entry] of store) {
      if (entry.filedAt < cutoff) store.delete(token);
    }
  }
  return {
    file(token, ref, ownerId, declared) {
      if (!token) return false;
      let lifecycle = declared;
      sweep();
      const sanitized = sanitizePluginRef(ref, ownerId, keyOwners, warnOnceForKey);
      if (lifecycle?.close !== void 0) {
        const close = normalizeCloseDeclaration(lifecycle.close);
        const { close: _dropped, ...rest } = lifecycle;
        if (!close) {
          warn(`[pending-plugin-ref-registry] dropped invalid close declaration from plugin "${ownerId}" (spawnToken ${token})`);
          lifecycle = rest;
        } else {
          lifecycle = { ...rest, close };
        }
      }
      const hasLifecycle = lifecycle !== void 0 && (lifecycle.recover !== void 0 || lifecycle.finalizeOnSocketClose !== void 0 || lifecycle.hidden !== void 0 || lifecycle.archiveOnEnd !== void 0 || lifecycle.close !== void 0);
      if (Object.keys(sanitized).length === 0 && !hasLifecycle) {
        return false;
      }
      store.set(token, {
        ref: sanitized,
        ownerId,
        ...hasLifecycle ? { lifecycle } : {},
        filedAt: now()
      });
      return true;
    },
    resolve(token) {
      if (!token) return null;
      sweep();
      const entry = store.get(token);
      if (!entry) return null;
      store.delete(token);
      return { ref: entry.ref, ownerId: entry.ownerId, ...entry.lifecycle ? { lifecycle: entry.lifecycle } : {} };
    },
    has(token, ownerId) {
      if (!token) return false;
      sweep();
      const entry = store.get(token);
      return !!entry && (ownerId === void 0 || entry.ownerId === ownerId);
    },
    sanitize(ref, ownerId) {
      return sanitizePluginRef(ref, ownerId, keyOwners, warnOnceForKey);
    },
    claimPersisted(sessions) {
      for (const s of sessions) {
        for (const [ownerId, bag] of Object.entries(s.pluginRefs ?? {})) claimKeys(ownerId, Object.keys(bag ?? {}));
      }
    },
    remove(token) {
      if (!token) return;
      store.delete(token);
    },
    size() {
      sweep();
      return store.size;
    }
  };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/session/plugin-refs.ts
var PLUGIN_REF_BAG_MAX_BYTES = 16 * 1024;
function isPlainObject2(v) {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}
function isJsonPlain(v, seen = /* @__PURE__ */ new Set()) {
  if (v === null || typeof v === "string" || typeof v === "boolean") return true;
  if (typeof v === "number") return Number.isFinite(v);
  if (typeof v !== "object") return false;
  if (seen.has(v)) return false;
  seen.add(v);
  const items = Array.isArray(v) ? v : isPlainObject2(v) ? Object.values(v) : null;
  const ok = items !== null && items.every((x) => isJsonPlain(x, seen));
  seen.delete(v);
  return ok;
}
function isOwnableKey(k) {
  return !CORE_RESERVED_REF_KEYS.has(k) && k !== "__proto__" && k !== "constructor" && k !== "prototype";
}
function sanitizePersistedBags(raw) {
  if (!isPlainObject2(raw)) return void 0;
  const out = {};
  for (const [owner, bag] of Object.entries(raw)) {
    if (!isOwnableKey(owner) || !isPlainObject2(bag)) continue;
    const clean = {};
    for (const [k, v] of Object.entries(bag)) {
      if (isOwnableKey(k) && isJsonPlain(v)) clean[k] = v;
    }
    if (Object.keys(clean).length > 0 && JSON.stringify(clean).length <= PLUGIN_REF_BAG_MAX_BYTES) out[owner] = clean;
  }
  return Object.keys(out).length > 0 ? out : void 0;
}
function mergePluginRefBag(bags, ownerId, sanitized) {
  const bag = { ...bags?.[ownerId] ?? {} };
  for (const [k, v] of Object.entries(sanitized)) {
    if (v === void 0) delete bag[k];
    else bag[k] = v;
  }
  if (!isJsonPlain(bag) || JSON.stringify(bag).length > PLUGIN_REF_BAG_MAX_BYTES) return null;
  const next = { ...bags ?? {} };
  if (Object.keys(bag).length > 0) next[ownerId] = bag;
  else delete next[ownerId];
  return Object.keys(next).length > 0 ? next : void 0;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/history-candidates.ts
import { lstat as lstat3, opendir, realpath as realpath2 } from "node:fs/promises";
import path10 from "node:path";
async function readLocalHistoryHeader(file, cwd, expectedId) {
  const info = await lstat3(file);
  if (!info.isFile() || info.isSymbolicLink() || await realpath2(file) !== file) throw new Error("unsafe-history-file");
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
  if (first?.type !== "session" || typeof first.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(first.id) || typeof first.cwd !== "string" || !path10.isAbsolute(first.cwd)) throw new Error("invalid-history-header");
  if (await realpath2(first.cwd).catch(() => "") !== cwd || expectedId && expectedId !== first.id) throw new Error("history-cwd-or-id-mismatch");
  return { id: first.id, cwd, ...typeof first.timestamp === "string" ? { timestamp: first.timestamp } : {}, bytes: info.size };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/participants.ts
function ownerKeyRealm(value) {
  try {
    const parts = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 && parts.every((part) => typeof part === "string" && part.length > 0 && part.length <= 256);
  } catch {
    return false;
  }
}
var sameOwner = (a, b) => a?.iss === b?.iss && a?.sub === b?.sub;
var object3 = (value) => !!value && typeof value === "object" && !Array.isArray(value);
function participation(value, cwd) {
  if (!object3(value) || value.canonicalCwd !== cwd || typeof value.joinedAt !== "string" || !Number.isFinite(Date.parse(value.joinedAt)) || !["manual", "adoption", "spawn"].includes(value.via)) return;
  return { canonicalCwd: cwd, joinedAt: value.joinedAt, via: value.via };
}
function identityValid(identity) {
  if (typeof identity.expiresAt === "number" && Date.now() >= identity.expiresAt) throw new ResWorkflowError(403, "adoption-identity-expired");
}
function createResWorkflowParticipants(deps) {
  const isLocalOperator = deps.isLocalOperator ?? (() => false);
  const lookup = (id) => deps.sessionManager.get(id) ?? deps.sessionArchive.getById(id);
  const matches = (row, access) => !!row && !row.originDeviceId && !isResWorkflowServiceSession(row) && typeof row.cwd === "string" && path11.isAbsolute(row.cwd) && canonPath(row.cwd) === access.cwd;
  const connected = async (access) => {
    await access.revalidate();
    if (!(await deps.connection(access)).adopted) throw new ResWorkflowError(409, "res-workflow-not-connected");
  };
  async function join(access, sessionId, via, spawn2) {
    const researchSession = spawn2?.researchSession === void 0 ? void 0 : isResearchSessionProvenance(spawn2.researchSession) ? normalizeResearchSessionProvenance(spawn2.researchSession) : (() => {
      throw new ResWorkflowError(409, "participant-spawn-binding-invalid");
    })();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new ResWorkflowError(400, "real-session-id-required");
    await connected(access);
    const sessionCreation = isSessionCreation(spawn2?.sessionCreation) && canonPath(spawn2.sessionCreation.cwd) === access.cwd ? spawn2.sessionCreation : void 0;
    const row = lookup(sessionId);
    if (!matches(row, access)) throw new ResWorkflowError(404, "participant-session-not-found");
    const expected = { ...row };
    if (!access.canReadHistory || !await access.canReadHistory(expected)) throw new ResWorkflowError(404, "participant-session-not-found");
    const registeredFile = spawn2?.sessionFile;
    const file = expected.sessionFile ?? registeredFile;
    if (typeof file !== "string" || !path11.isAbsolute(file) || path11.resolve(file) !== file || !file.endsWith(".jsonl") || file.length > 4096) throw new ResWorkflowError(409, "participant-session-file-unavailable");
    const initial = await lstat4(file).catch(() => null);
    if (initial) {
      try {
        await readLocalHistoryHeader(file, access.cwd, sessionId);
      } catch {
        throw new ResWorkflowError(409, "participant-session-file-unavailable");
      }
    } else if (via !== "spawn") throw new ResWorkflowError(409, "participant-session-file-unavailable");
    await access.revalidate();
    const current = lookup(sessionId);
    if (!matches(current, access) || (current.sessionFile ?? registeredFile) !== file || !sameOwner(current.principalOwner, expected.principalOwner) || spawn2 && !sameOwner(current.principalOwner, spawn2.principalOwner)) throw new ResWorkflowError(404, "participant-session-not-found");
    deps.assertParticipationAllowed?.({ cwd: access.cwd, sessionId, researchSession, via });
    try {
      const parent = path11.dirname(file);
      if (!lstatSync(parent).isDirectory() || realpathSync3(parent) !== parent) throw new ResWorkflowError(409, "participant-metadata-unsafe");
      const actual = (() => {
        try {
          return lstatSync(file);
        } catch (err) {
          if (err.code === "ENOENT") return null;
          throw err;
        }
      })();
      if (actual && (!initial || !actual.isFile() || actual.isSymbolicLink() || realpathSync3(file) !== file || actual.dev !== initial.dev || actual.ino !== initial.ino) || !actual && via !== "spawn") throw new ResWorkflowError(409, "participant-metadata-unsafe");
      const sidecar = metaPath(file);
      const inspect = (target) => {
        try {
          return lstatSync(target);
        } catch (err) {
          if (err.code === "ENOENT") return null;
          throw err;
        }
      };
      const readAdmittedMeta = () => {
        const side = inspect(sidecar);
        if (side && (!side.isFile() || side.isSymbolicLink() || side.size > 128 * 1024) || inspect(`${sidecar}.tmp`)) throw new ResWorkflowError(409, "participant-metadata-unsafe");
        let meta2 = {};
        if (side) {
          try {
            const parsed = JSON.parse(readFileSync(sidecar, "utf8"));
            if (!object3(parsed)) throw new Error();
            meta2 = parsed;
          } catch {
            throw new ResWorkflowError(409, "participant-metadata-invalid");
          }
        }
        if (isResWorkflowServiceSession(meta2)) throw new ResWorkflowError(404, "participant-session-not-found");
        if (meta2.principalOwner && !sameOwner(meta2.principalOwner, current.principalOwner) || meta2.cwd && canonPath(meta2.cwd) !== access.cwd) throw new ResWorkflowError(409, "participant-session-changed");
        return meta2;
      };
      readAdmittedMeta();
      deps.metaPersistence.flush(file);
      const meta = readAdmittedMeta();
      const disk = sanitizePersistedBags(meta.pluginRefs);
      const memory = sanitizePersistedBags(current.pluginRefs);
      const bags = { ...disk };
      for (const [owner, bag] of Object.entries(memory ?? {})) bags[owner] = { ...bags[owner], ...bag };
      const resWorkflow = participation(bags["res-workflow"]?.resWorkflow, access.cwd) ?? spawn2?.resWorkflow ?? { canonicalCwd: access.cwd, joinedAt: (/* @__PURE__ */ new Date()).toISOString(), via };
      const sanitized = deps.registry.sanitize({ resWorkflow, ...researchSession ? { researchSession } : {}, ...sessionCreation ? { sessionCreation } : {} }, "res-workflow");
      if (!sanitized.resWorkflow || researchSession && sanitized.researchSession === void 0) throw new ResWorkflowError(409, "participant-ref-unavailable");
      const pluginRefs = mergePluginRefBag(bags, "res-workflow", sanitized);
      if (!pluginRefs) throw new ResWorkflowError(409, "participant-ref-unavailable");
      const nextMeta = { ...meta, pluginRefs, ...researchSession ? { researchSession } : {} };
      writeSessionMeta(file, nextMeta);
      if (deps.sessionManager.get(sessionId)) deps.sessionManager.update(sessionId, { pluginRefs, resWorkflow, ...researchSession ? { researchSession } : {} });
      else deps.sessionArchive.updatePluginRefs(sessionId, pluginRefs);
      deps.broadcast(sessionId, { pluginRefs, resWorkflow, ...researchSession ? { researchSession } : {} });
      return { sessionId, resWorkflow, ...researchSession ? { researchSession } : {} };
    } catch (err) {
      if (err instanceof ResWorkflowError) throw err;
      throw new ResWorkflowError(503, "participant-metadata-write-failed");
    }
  }
  async function detach(access, sessionId) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new ResWorkflowError(400, "real-session-id-required");
    if (access.write !== true) throw new ResWorkflowError(403, "res-workflow-write-required");
    await access.revalidate();
    const row = lookup(sessionId);
    if (!matches(row, access) || !access.canReadHistory || !await access.canReadHistory(row)) throw new ResWorkflowError(404, "participant-session-not-found");
    const expected = { ...row }, file = expected.sessionFile;
    if (typeof file !== "string" || !path11.isAbsolute(file) || path11.resolve(file) !== file || !file.endsWith(".jsonl") || file.length > 4096) throw new ResWorkflowError(409, "participant-session-file-unavailable");
    const initial = await lstat4(file).catch(() => null);
    if (initial) {
      try {
        await readLocalHistoryHeader(file, access.cwd, sessionId);
      } catch {
        throw new ResWorkflowError(409, "participant-session-file-unavailable");
      }
    }
    await access.revalidate();
    const current = lookup(sessionId);
    if (!matches(current, access) || current.sessionFile !== file || !sameOwner(current.principalOwner, expected.principalOwner)) throw new ResWorkflowError(404, "participant-session-not-found");
    try {
      const parent = path11.dirname(file);
      if (!lstatSync(parent).isDirectory() || realpathSync3(parent) !== parent) throw new ResWorkflowError(409, "participant-metadata-unsafe");
      const inspect = (target) => {
        try {
          return lstatSync(target);
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      };
      const actual = inspect(file);
      if (actual && (!initial || !actual.isFile() || actual.isSymbolicLink() || realpathSync3(file) !== file || actual.dev !== initial.dev || actual.ino !== initial.ino) || initial && !actual) throw new ResWorkflowError(409, "participant-metadata-unsafe");
      const sidecar = metaPath(file);
      const read = () => {
        const side = inspect(sidecar);
        if (side && (!side.isFile() || side.isSymbolicLink() || side.size > 128 * 1024) || inspect(`${sidecar}.tmp`)) throw new ResWorkflowError(409, "participant-metadata-unsafe");
        let meta2 = {};
        if (side) {
          try {
            const parsed = JSON.parse(readFileSync(sidecar, "utf8"));
            if (!object3(parsed)) throw new Error();
            meta2 = parsed;
          } catch {
            throw new ResWorkflowError(409, "participant-metadata-invalid");
          }
        }
        if (isResWorkflowServiceSession(meta2) || meta2.principalOwner && !sameOwner(meta2.principalOwner, current.principalOwner) || meta2.cwd && canonPath(meta2.cwd) !== access.cwd) throw new ResWorkflowError(409, "participant-session-changed");
        return meta2;
      };
      read();
      deps.metaPersistence.flush(file);
      const meta = read();
      const bags = { ...sanitizePersistedBags(meta.pluginRefs) };
      for (const [owner, bag] of Object.entries(sanitizePersistedBags(current.pluginRefs) ?? {})) bags[owner] = { ...bags[owner], ...bag };
      if (bags["res-workflow"]) {
        const bag = { ...bags["res-workflow"] };
        delete bag.resWorkflow;
        if (Object.keys(bag).length) bags["res-workflow"] = bag;
        else delete bags["res-workflow"];
      }
      const nextMeta = { ...meta, pluginRefs: bags };
      delete nextMeta.resWorkflow;
      writeSessionMeta(file, nextMeta);
      if (deps.sessionManager.get(sessionId)) deps.sessionManager.update(sessionId, { pluginRefs: bags, resWorkflow: void 0 });
      else deps.sessionArchive.updatePluginRefs(sessionId, bags);
      deps.broadcast(sessionId, { pluginRefs: bags, resWorkflow: null });
      return { sessionId, removed: true };
    } catch (error) {
      if (error instanceof ResWorkflowError) throw error;
      throw new ResWorkflowError(503, "participant-metadata-write-failed");
    }
  }
  async function prepareSpawn(cwd, identity, verified = {}) {
    identityValid(identity);
    const resolverActive = deps.isResolverActive();
    const access = await deps.accessFor(cwd, identity);
    const ownerKey = verified.ownerKey ?? access.ownerKey;
    if (ownerKey !== access.ownerKey) {
      if (!isLocalOperator(identity.principal ?? void 0) || !ownerKeyRealm(ownerKey)) throw new ResWorkflowError(404, "participant-session-not-found");
      await access.revalidate();
    } else {
      await connected(access);
    }
    identityValid(identity);
    if (resolverActive !== deps.isResolverActive()) throw new ResWorkflowError(403, "adoption-identity-expired");
    const researchSession = verified.researchSession === void 0 ? void 0 : normalizeResearchSessionProvenance(verified.researchSession);
    const ref = {
      resWorkflow: { canonicalCwd: access.cwd, joinedAt: (/* @__PURE__ */ new Date()).toISOString(), via: "spawn" },
      resWorkflowBinding: { ownerKey, identity: { ...identity, principal: identity.principal ?? null, expiresAt: identity.expiresAt ?? null }, resolverActive },
      ...researchSession ? { researchSession } : {}
    };
    const sanitized = deps.registry.sanitize(ref, "res-workflow");
    if (!sanitized.resWorkflow || !sanitized.resWorkflowBinding || researchSession && sanitized.researchSession === void 0) throw new ResWorkflowError(409, "participant-ref-unavailable");
    return ref;
  }
  async function registerSpawn(sessionId, registration, raw) {
    if (!object3(raw) || !object3(raw.resWorkflowBinding) || !object3(raw.resWorkflowBinding.identity) || !object3(raw.resWorkflow) || typeof raw.resWorkflow.canonicalCwd !== "string") throw new ResWorkflowError(409, "participant-spawn-binding-invalid");
    const binding = raw.resWorkflowBinding;
    identityValid(binding.identity);
    if (binding.resolverActive !== deps.isResolverActive()) throw new ResWorkflowError(403, "adoption-identity-expired");
    const intent = participation(raw.resWorkflow, raw.resWorkflow.canonicalCwd);
    if (!intent || intent.via !== "spawn" || canonPath(registration.cwd) !== intent.canonicalCwd) throw new ResWorkflowError(409, "participant-spawn-cwd-mismatch");
    const admitted = await deps.accessFor(intent.canonicalCwd, binding.identity);
    if (admitted.cwd !== intent.canonicalCwd) throw new ResWorkflowError(404, "participant-session-not-found");
    if (admitted.ownerKey !== binding.ownerKey) {
      if (!isLocalOperator(binding.identity.principal ?? void 0) || !ownerKeyRealm(binding.ownerKey)) throw new ResWorkflowError(404, "participant-session-not-found");
    }
    const access = admitted.ownerKey === binding.ownerKey ? admitted : { ...admitted, ownerKey: binding.ownerKey };
    const row = lookup(sessionId);
    const bindingOwner = (() => {
      try {
        const parts = JSON.parse(binding.ownerKey);
        if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== "string" || typeof parts[1] !== "string") return void 0;
        const local = parts[0] === "host" && parts[1] === "inert-operator" || parts[0] === "urn:pi-dashboard:local-operator" && parts[1] === "local-operator";
        return local ? void 0 : { iss: parts[0], sub: parts[1] };
      } catch {
        return void 0;
      }
    })();
    const expectedOwner = binding.resolverActive ? isLocalOperator(binding.identity.principal ?? void 0) ? bindingOwner : binding.identity.principal ?? void 0 : void 0;
    if (!matches(row, access) || !sameOwner(row.principalOwner, expectedOwner) || row.sessionFile && row.sessionFile !== registration.sessionFile) throw new ResWorkflowError(404, "participant-session-not-found");
    return join(access, sessionId, "spawn", { resWorkflow: intent, sessionFile: registration.sessionFile, principalOwner: expectedOwner, researchSession: raw.researchSession, sessionCreation: raw.sessionCreation });
  }
  return { join, detach, prepareSpawn, registerSpawn };
}
export {
  createPendingPluginRefRegistry,
  createResWorkflowParticipants,
  readLocalHistoryHeader,
  resWorkflowAccess
};
