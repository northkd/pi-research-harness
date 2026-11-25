// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/path-containment.ts
import fs from "node:fs/promises";
import path7 from "node:path";

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
function isFilesystemRoot(resolved, platform = process.platform) {
  if (!resolved) return false;
  if (platform === "win32") {
    if (/^[A-Za-z]:[\\/]$/.test(resolved)) return true;
    if (/^\\\\[^\\]+\\[^\\]+\\?$/.test(resolved)) return true;
    if (resolved === "/" || resolved === "\\") return true;
    return false;
  }
  return resolved === "/";
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
  return new Promise((resolve) => {
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
      resolve(r);
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
  const rel = path7.relative(base, p);
  return rel === "" || !rel.startsWith(`..${path7.sep}`) && rel !== ".." && !path7.isAbsolute(rel);
}
async function safeRealpath(p) {
  try {
    return await fs.realpath(p);
  } catch {
    const parent = path7.dirname(p);
    if (parent === p) return p;
    const realParent = await safeRealpath(parent);
    return path7.join(realParent, path7.basename(p));
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

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/writable-md-target.ts
import fs2 from "node:fs/promises";
import os3 from "node:os";
import path8 from "node:path";
var WRITABLE_MD_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".mdx", ".adoc", ".asciidoc", ".csv"]);
var DIRECTORY_ONLY_WRITABLE_EXTENSIONS = /* @__PURE__ */ new Set([".mmd", ".mermaid"]);
function extOf2(p) {
  const base = path8.basename(p);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}
async function allowedRoot(opts) {
  const raw = opts.cwd ? path8.resolve(opts.cwd) : (() => {
    const home = opts.home ?? os3.homedir();
    return home ? path8.join(home, ".pi", "agent") : null;
  })();
  if (!raw) return null;
  try {
    return await fs2.realpath(raw);
  } catch {
    return null;
  }
}
async function isWritableMdTarget(absPath, opts = {}) {
  if (!path8.isAbsolute(absPath)) return false;
  try {
    const root = await allowedRoot(opts);
    if (!root) return false;
    const real = await safeRealpath(path8.resolve(absPath));
    const ext = extOf2(real);
    if (!WRITABLE_MD_EXTENSIONS.has(ext) && !(opts.cwd && DIRECTORY_ONLY_WRITABLE_EXTENSIONS.has(ext))) {
      return false;
    }
    return within(real, root);
  } catch {
    return false;
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/file-write-lock.ts
var fileWriteLocks = /* @__PURE__ */ new Map();
function serializeWrite(key, task) {
  const run2 = (fileWriteLocks.get(key) ?? Promise.resolve()).then(task, task);
  const tail = run2.then(
    () => {
    },
    () => {
    }
  );
  fileWriteLocks.set(key, tail);
  const release = () => {
    if (fileWriteLocks.get(key) === tail) fileWriteLocks.delete(key);
  };
  void tail.then(release).catch((err) => console.warn("[file-write-lock] release failed", err));
  return run2;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/mime-types.ts
var TABLE = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".adoc": "text/asciidoc; charset=utf-8",
  ".asciidoc": "text/asciidoc; charset=utf-8"
};
function extToContentType(ext) {
  return TABLE[ext.toLowerCase()] ?? "application/octet-stream";
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/decode-file-uri.ts
function decodeFileUri(value) {
  if (!/^file:\/\//i.test(value)) return value;
  const payload = value.replace(/^file:\/\//i, "");
  try {
    return decodeURIComponent(payload);
  } catch {
    return payload;
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/md-candidates.ts
import fs3 from "node:fs/promises";
import os4 from "node:os";
import path9 from "node:path";
var MD_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".mdx"]);
var SKIP_DIRS = /* @__PURE__ */ new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".venv",
  "__pycache__",
  ".worktrees",
  ".cache",
  "vendor"
]);
var MAX_DEPTH = 6;
var MAX_CANDIDATES = 500;
function scopeRoot(opts) {
  if (opts.cwd) return path9.resolve(opts.cwd);
  const home = opts.home ?? os4.homedir();
  if (!home) return null;
  return path9.join(home, ".pi", "agent");
}
function extOf3(p) {
  const base = path9.basename(p);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}
async function walkMd(dir, depth, found) {
  if (depth > MAX_DEPTH || found.length >= MAX_CANDIDATES) return;
  let entries;
  try {
    entries = await fs3.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (found.length >= MAX_CANDIDATES) return;
    const abs = path9.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkMd(abs, depth + 1, found);
    } else if (entry.isFile() && MD_EXTENSIONS.has(extOf3(entry.name))) {
      found.push(abs);
    }
  }
}
async function enumerateMdCandidates(opts = {}) {
  const root = scopeRoot(opts);
  if (!root) return [];
  const found = [];
  await walkMd(root, 0, found);
  const allowed = [];
  for (const abs of found) {
    if (await isWritableMdTarget(abs, opts)) {
      allowed.push({ path: abs, relPath: path9.relative(root, abs) });
    }
  }
  allowed.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return allowed;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/lib/artifact-roots.ts
import fs4 from "node:fs";
import os5 from "node:os";
import path10 from "node:path";
var IMAGE_EXTS = /* @__PURE__ */ new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
var cached2 = null;
function artifactRoots() {
  if (cached2) return cached2;
  const candidates = [
    path10.join(os5.homedir(), ".agent-browser", "tmp"),
    process.env.AGENT_BROWSER_SCREENSHOT_DIR
  ].filter((p) => typeof p === "string" && p.length > 0);
  const roots = [];
  for (const c of candidates) {
    try {
      roots.push(fs4.realpathSync(c));
    } catch {
    }
  }
  cached2 = roots;
  return cached2;
}
async function isImageUnderArtifactRoot(resolved) {
  const ext = path10.extname(resolved).slice(1).toLowerCase();
  if (!IMAGE_EXTS.has(ext)) return false;
  const roots = artifactRoots();
  if (roots.length === 0) return false;
  const real = await safeRealpath(resolved);
  return roots.some((root) => within(real, root));
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/browse.ts
import fs5 from "node:fs/promises";
import os6 from "node:os";
import path11 from "node:path";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/project-name.ts
var MAX_PROJECT_NAME_BYTES = 255;
var CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/;
var FORBIDDEN_CHARS = /[/\\:*?"<>|]/;
var WINDOWS_RESERVED = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])$/i;
function projectNameProblem(name) {
  if (typeof name !== "string" || name.length === 0) return "invalid_name";
  if (name !== name.trim() || name === "." || name === "..") return "invalid_name";
  if (CONTROL_CHARS.test(name) || FORBIDDEN_CHARS.test(name) || name.endsWith(".")) return "invalid_name";
  if (WINDOWS_RESERVED.test(name.split(".")[0].trimEnd())) return "reserved_name";
  if (new TextEncoder().encode(name).length > MAX_PROJECT_NAME_BYTES) return "too_long";
  return null;
}
function isPortableProjectName(name) {
  return projectNameProblem(name) === null;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/semaphore.ts
function createSemaphore(max) {
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`Semaphore max must be a positive integer, got ${max}`);
  }
  let limit = Math.floor(max);
  let active = 0;
  const queue = [];
  function drain() {
    while (active < limit && queue.length > 0) {
      const next = queue.shift();
      active++;
      next();
    }
  }
  function release() {
    active--;
    queueMicrotask(drain);
  }
  return {
    run(fn) {
      return new Promise((resolve, reject) => {
        const start = () => {
          let settled = false;
          try {
            Promise.resolve().then(fn).then(
              (value) => {
                if (!settled) {
                  settled = true;
                  release();
                  resolve(value);
                }
              },
              (err) => {
                if (!settled) {
                  settled = true;
                  release();
                  reject(err);
                }
              }
            );
          } catch (err) {
            if (!settled) {
              settled = true;
              release();
              reject(err);
            }
          }
        };
        if (active < limit) {
          active++;
          start();
        } else {
          queue.push(start);
        }
      });
    },
    setMax(n) {
      if (!Number.isFinite(n) || n < 1) {
        throw new Error(`Semaphore max must be a positive integer, got ${n}`);
      }
      limit = Math.floor(n);
      drain();
    },
    size() {
      return active + queue.length;
    }
  };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/browse.ts
var MAX_ENTRIES = 200;
var MAX_FLAG_PATHS = 100;
var FLAG_PROBE_CONCURRENCY = 32;
async function probeFlags(absolutePath) {
  const [isGit, isPi] = await Promise.all([
    fs5.access(path11.join(absolutePath, ".git")).then(() => true, () => false),
    fs5.access(path11.join(absolutePath, ".pi")).then(() => true, () => false)
  ]);
  return { isGit, isPi };
}
var WORD_BOUNDARY_CHARS = /* @__PURE__ */ new Set(["-", "_", ".", " ", "/"]);
function rankTier(name, qLower) {
  const nameLower = name.toLowerCase();
  if (nameLower === qLower) return 0;
  if (nameLower.startsWith(qLower)) return 1;
  const idx = nameLower.indexOf(qLower);
  if (idx < 0) return 4;
  const prev = nameLower[idx - 1];
  if (idx === 0 || prev !== void 0 && WORD_BOUNDARY_CHARS.has(prev)) return 2;
  return 3;
}
async function listDirectories(dirPath, q, opts) {
  const detect = opts?.detect === true;
  const resolved = dirPath ?? os6.homedir();
  const stat = await fs5.stat(resolved);
  if (!stat.isDirectory()) {
    throw new Error("not a directory");
  }
  const rawEntries = await fs5.readdir(resolved, { withFileTypes: true });
  let dirs = rawEntries.filter(
    (e) => e.isDirectory() && !e.name.startsWith(".")
  );
  const qTrim = (q ?? "").trim();
  if (qTrim) {
    const qLower = qTrim.toLowerCase();
    const ranked = dirs.map((d) => ({ d, tier: rankTier(d.name, qLower) })).filter((x) => x.tier < 4);
    ranked.sort((a, b) => {
      if (a.tier !== b.tier) return a.tier - b.tier;
      return a.d.name.toLowerCase().localeCompare(b.d.name.toLowerCase());
    });
    dirs = ranked.map((x) => x.d);
  } else {
    dirs.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  }
  const capped = dirs.slice(0, MAX_ENTRIES);
  const entries = detect ? await Promise.all(
    capped.map(async (d) => {
      const fullPath = path11.join(resolved, d.name);
      const flags = await probeFlags(fullPath);
      return { name: d.name, path: fullPath, isGit: flags.isGit, isPi: flags.isPi };
    })
  ) : capped.map((d) => ({ name: d.name, path: path11.join(resolved, d.name) }));
  const parent = isFilesystemRoot(resolved) ? null : path11.dirname(resolved);
  return { entries, parent, current: resolved, platform: process.platform };
}
async function classifyPaths(paths) {
  if (paths.length === 0) return {};
  const sem = createSemaphore(FLAG_PROBE_CONCURRENCY);
  const result = {};
  await Promise.all(
    paths.map(
      (p) => sem.run(async () => {
        result[p] = await probeFlags(p);
      })
    )
  );
  return result;
}
function parseFlagsQuery(rawPaths) {
  if (typeof rawPaths !== "string" || rawPaths.length === 0) {
    return { ok: false, error: "invalid paths" };
  }
  let parsed;
  try {
    parsed = JSON.parse(rawPaths);
  } catch {
    return { ok: false, error: "invalid paths" };
  }
  if (!Array.isArray(parsed)) return { ok: false, error: "invalid paths" };
  if (!parsed.every((p) => typeof p === "string")) {
    return { ok: false, error: "invalid paths" };
  }
  if (parsed.length > MAX_FLAG_PATHS) {
    return { ok: false, error: "too many paths" };
  }
  return { ok: true, paths: parsed };
}
function validateMkdirName(name) {
  if (typeof name !== "string") return "invalid name";
  if (name.length === 0) return "invalid name";
  if (name !== name.trim()) return "invalid name";
  if (name === "." || name === "..") return "invalid name";
  if (name.includes("/") || name.includes("\\")) return "invalid name";
  if (name.includes("\0")) return "invalid name";
  return null;
}
async function createDirectory(parent, name) {
  const nameErr = validateMkdirName(name);
  if (nameErr) throw new Error(nameErr);
  if (typeof parent !== "string" || parent.length === 0 || !path11.isAbsolute(parent)) {
    throw new Error("parent not found");
  }
  let parentStat;
  try {
    parentStat = await fs5.stat(parent);
  } catch {
    throw new Error("parent not found");
  }
  if (!parentStat.isDirectory()) {
    throw new Error("parent is not a directory");
  }
  const target = path11.join(parent, name);
  try {
    await fs5.mkdir(target, { recursive: false });
  } catch (err) {
    const e = err;
    if (e?.code === "EEXIST") throw new Error("already exists");
    throw err;
  }
  return target;
}
var CreateProjectError = class extends Error {
  reason;
  constructor(reason, message) {
    super(message);
    this.reason = reason;
    this.name = "CreateProjectError";
  }
};
var PROJECTS_ROOT_NAME = "Projects";
var errCode = (err) => err?.code;
async function isDirectory(p) {
  try {
    return (await fs5.stat(p)).isDirectory();
  } catch {
    return false;
  }
}
async function removeCreated(target) {
  try {
    if ((await fs5.lstat(target)).isDirectory()) await fs5.rmdir(target);
  } catch {
  }
}
async function createProjectDirectory(name, homeDir = os6.homedir()) {
  if (!isPortableProjectName(name)) {
    const problem = projectNameProblem(name) ?? "invalid_name";
    throw new CreateProjectError(problem, problem === "reserved_name" ? "reserved name" : problem === "too_long" ? "name too long" : "invalid name");
  }
  if (!await isDirectory(homeDir)) {
    throw new CreateProjectError("home_missing", "home directory not found");
  }
  const root = path11.join(homeDir, PROJECTS_ROOT_NAME);
  try {
    await fs5.mkdir(root, { recursive: false });
  } catch (err) {
    if (errCode(err) !== "EEXIST") throw new CreateProjectError("fs_error", "could not create projects root");
  }
  let rootReal;
  try {
    rootReal = await fs5.realpath(root);
  } catch (err) {
    if (errCode(err) === "ENOENT") {
      throw new CreateProjectError("root_not_a_directory", "projects root is not a directory");
    }
    throw new CreateProjectError("fs_error", "could not resolve projects root");
  }
  if (!await isDirectory(rootReal)) {
    throw new CreateProjectError("root_not_a_directory", "projects root is not a directory");
  }
  const rootPrefix = rootReal.endsWith(path11.sep) ? rootReal : rootReal + path11.sep;
  const target = path11.resolve(rootReal, name);
  if (!target.startsWith(rootPrefix)) {
    throw new CreateProjectError("invalid_name", "invalid name");
  }
  let created = false;
  try {
    await fs5.mkdir(target, { recursive: false });
    created = true;
  } catch (err) {
    const code = errCode(err);
    if (code === "ENAMETOOLONG") throw new CreateProjectError("too_long", "name too long");
    if (code !== "EEXIST") throw new CreateProjectError("fs_error", "could not create project directory");
  }
  let targetReal;
  try {
    targetReal = await fs5.realpath(target);
  } catch (err) {
    if (created) await removeCreated(target);
    if (errCode(err) === "ENOENT") throw new CreateProjectError("not_a_directory", "target is not a directory");
    throw new CreateProjectError("fs_error", "could not resolve project directory");
  }
  if (!targetReal.startsWith(rootPrefix)) {
    if (created) await removeCreated(target);
    throw new CreateProjectError("outside_root", "project directory resolves outside the projects root");
  }
  if (!await isDirectory(targetReal)) {
    throw new CreateProjectError("not_a_directory", "target is not a directory");
  }
  return { path: targetReal, existed: !created };
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/file-kind.ts
var MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
var DIGEST_CEILING_BYTES = 256 * 1024 * 1024;
var OFFICE_SIZE_CAPS = {
  docx: 40 * 1024 * 1024,
  pptx: 100 * 1024 * 1024,
  sheet: 50 * 1024 * 1024
};
var MARKDOWN_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".mdx", ".markdown"]);
var WRITABLE_MARKDOWN_EXTENSIONS = /* @__PURE__ */ new Set([".md", ".mdx"]);
var TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".py",
  ".go",
  ".rs",
  ".yaml",
  ".yml",
  ".css",
  ".scss",
  ".less",
  ".sql",
  ".sh",
  ".bash",
  ".zsh",
  ".txt",
  ".xml",
  ".toml",
  ".ini",
  ".conf",
  ".log",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".java",
  ".rb",
  ".php",
  ".lua",
  ".vue",
  ".svelte",
  ".graphql",
  ".proto"
]);
var IMAGE_EXTENSIONS = /* @__PURE__ */ new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".ico",
  ".bmp",
  ".avif"
]);
var HTML_EXTENSIONS = /* @__PURE__ */ new Set([".html", ".htm"]);
var MERMAID_EXTENSIONS = /* @__PURE__ */ new Set([".mmd", ".mermaid"]);
var AUDIO_EXTENSIONS = /* @__PURE__ */ new Set([".mp3", ".wav", ".ogg", ".m4a", ".flac"]);
var VIDEO_EXTENSIONS = /* @__PURE__ */ new Set([".mp4", ".webm", ".mov"]);
var DOCX_EXTENSIONS = /* @__PURE__ */ new Set([".docx"]);
var PPTX_EXTENSIONS = /* @__PURE__ */ new Set([".pptx"]);
var SPREADSHEET_EXTENSIONS = /* @__PURE__ */ new Set([".xlsx", ".xls", ".csv"]);
var ASCIIDOC_EXTENSIONS = /* @__PURE__ */ new Set([".adoc", ".asciidoc"]);
var DIAGRAM_EXTENSIONS = /* @__PURE__ */ new Set([".puml", ".plantuml"]);
var EMAIL_EXTENSIONS = /* @__PURE__ */ new Set([".eml"]);
var MIME_BY_EXT = {
  ".ts": "text/x.typescript",
  ".tsx": "text/x.typescript",
  ".js": "text/javascript",
  ".jsx": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".json": "application/json",
  ".jsonc": "application/json",
  ".py": "text/x-python",
  ".go": "text/x-go",
  ".rs": "text/x-rust",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".html": "text/html",
  ".htm": "text/html",
  ".css": "text/css",
  ".sql": "text/x-sql",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".zsh": "text/x-shellscript",
  ".xml": "application/xml",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
  ".pdf": "application/pdf",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".m4a": "audio/mp4",
  ".flac": "audio/flac",
  ".mmd": "text/vnd.mermaid",
  ".mermaid": "text/vnd.mermaid",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xls": "application/vnd.ms-excel",
  ".adoc": "text/asciidoc",
  ".asciidoc": "text/asciidoc",
  ".puml": "text/x-plantuml",
  ".plantuml": "text/x-plantuml",
  ".eml": "message/rfc822",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".markdown": "text/markdown"
};
function isAbsolutePath(p) {
  return p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");
}
function extOf4(absPath) {
  const lastSlash = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  const base = lastSlash >= 0 ? absPath.slice(lastSlash + 1) : absPath;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "";
  return base.slice(dot).toLowerCase();
}
function looksBinary(sniff) {
  const limit = Math.min(sniff.length, 1024);
  for (let i = 0; i < limit; i++) {
    const byte = typeof sniff === "string" ? sniff.charCodeAt(i) : sniff[i];
    if (byte === 0) return true;
  }
  return false;
}
function richKind(ext, mimeOf) {
  if (DOCX_EXTENSIONS.has(ext)) {
    return {
      kind: "docx",
      mimeType: mimeOf("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      viewer: "docx",
      editable: false
    };
  }
  if (PPTX_EXTENSIONS.has(ext)) {
    return {
      kind: "pptx",
      mimeType: mimeOf("application/vnd.openxmlformats-officedocument.presentationml.presentation"),
      viewer: "pptx",
      editable: false
    };
  }
  if (SPREADSHEET_EXTENSIONS.has(ext)) {
    return {
      kind: "spreadsheet",
      mimeType: mimeOf("application/octet-stream"),
      viewer: "spreadsheet",
      editable: ext === ".csv"
    };
  }
  if (ASCIIDOC_EXTENSIONS.has(ext)) {
    return { kind: "asciidoc", mimeType: mimeOf("text/asciidoc"), viewer: "asciidoc", editable: true };
  }
  if (EMAIL_EXTENSIONS.has(ext)) {
    return { kind: "email", mimeType: mimeOf("message/rfc822"), viewer: "email", editable: false };
  }
  if (DIAGRAM_EXTENSIONS.has(ext)) {
    return { kind: "diagram", mimeType: mimeOf("text/x-plantuml"), viewer: "diagram", editable: false };
  }
  return null;
}
function fileKind(absPath, sniff) {
  if (!isAbsolutePath(absPath)) {
    throw new Error(`fileKind requires an absolute path, got: ${absPath}`);
  }
  const ext = extOf4(absPath);
  const mimeOf = (fallback) => MIME_BY_EXT[ext] ?? fallback;
  if (MARKDOWN_EXTENSIONS.has(ext)) {
    return {
      kind: "markdown",
      mimeType: mimeOf("text/markdown"),
      viewer: "markdown",
      editable: WRITABLE_MARKDOWN_EXTENSIONS.has(ext)
    };
  }
  if (ext === ".pdf") {
    return { kind: "pdf", mimeType: mimeOf("application/pdf"), viewer: "pdf", editable: false };
  }
  if (HTML_EXTENSIONS.has(ext)) {
    return { kind: "html", mimeType: mimeOf("text/html"), viewer: "html", editable: false };
  }
  if (MERMAID_EXTENSIONS.has(ext)) {
    return { kind: "mermaid", mimeType: mimeOf("text/vnd.mermaid"), viewer: "mermaid", editable: false };
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return { kind: "audio", mimeType: mimeOf("application/octet-stream"), viewer: "audio", editable: false };
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return { kind: "video", mimeType: mimeOf("application/octet-stream"), viewer: "video", editable: false };
  }
  if (IMAGE_EXTENSIONS.has(ext)) {
    return { kind: "image", mimeType: mimeOf("application/octet-stream"), viewer: "image", editable: false };
  }
  const rich = richKind(ext, mimeOf);
  if (rich) return rich;
  if (TEXT_EXTENSIONS.has(ext)) {
    return { kind: "text", mimeType: mimeOf("text/plain"), viewer: "monaco", editable: false };
  }
  if (sniff !== void 0 && looksBinary(sniff)) {
    return { kind: "binary", mimeType: "application/octet-stream", viewer: "binary-warn", editable: false };
  }
  return { kind: "unknown", mimeType: mimeOf("text/plain"), viewer: "monaco", editable: false };
}
export {
  CreateProjectError,
  DIGEST_CEILING_BYTES,
  classifyPaths,
  createDirectory,
  createProjectDirectory,
  decodeFileUri,
  enumerateMdCandidates,
  extToContentType,
  fileKind,
  isAllowed,
  isImageUnderArtifactRoot,
  isWritableMdTarget,
  listDirectories,
  parseFlagsQuery,
  safeRealpath,
  serializeWrite,
  validateMkdirName,
  within
};
