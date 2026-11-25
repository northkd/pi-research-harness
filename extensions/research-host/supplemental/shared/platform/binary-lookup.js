import { supplementalHomeDir } from "../../runtime-home.mjs";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { MANAGED_BIN, MANAGED_DIR } from "../managed-paths.js";
import { ensureWindowsSystemPath } from "./ensure-windows-path.js";
import { normalizeEnvPathKey } from "./env-path-key.js";
import { buildSafeArgv, execSync, spawnSync } from "./exec.js";
import { augmentEnvWithGitSource } from "./git-source.js";
const MANAGED_PI_PACKAGES = ["@earendil-works/pi-coding-agent"];
function safeRealpath(p) {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}
function isAppImageSelfHit(candidatePath, opts) {
  if (!candidatePath) return false;
  const execPath = opts && "execPath" in opts ? opts.execPath : process.execPath;
  const appDir = opts && "appDir" in opts ? opts.appDir : process.env.APPDIR;
  const appImage = opts && "appImage" in opts ? opts.appImage : process.env.APPIMAGE;
  const realCandidate = safeRealpath(candidatePath);
  if (execPath) {
    const realExec = safeRealpath(execPath);
    if (realCandidate === realExec) return true;
    if (candidatePath === execPath) return true;
  }
  if (appDir) {
    const realAppDir = safeRealpath(appDir);
    const sep = path.sep;
    const prefix = realAppDir.endsWith(sep) ? realAppDir : realAppDir + sep;
    if (realCandidate === realAppDir || realCandidate.startsWith(prefix)) return true;
    const litPrefix = appDir.endsWith(sep) ? appDir : appDir + sep;
    if (candidatePath === appDir || candidatePath.startsWith(litPrefix)) return true;
  }
  if (appImage) {
    const realAppImage = safeRealpath(appImage);
    if (realCandidate === realAppImage) return true;
    if (candidatePath === appImage) return true;
  }
  return false;
}
const GLOBAL_REGISTRY_KEY = /* @__PURE__ */ Symbol.for("pi-dashboard.tool-registry");
function tryGetRegistry() {
  const reg = globalThis[GLOBAL_REGISTRY_KEY];
  return reg ?? null;
}
class ToolResolver {
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
    const managed = path.join(MANAGED_BIN, name + ext);
    if (existsSync(managed)) return managed;
    for (const dir of this.ctx.extraBinDirs ?? []) {
      const candidate = path.join(dir, name + ext);
      if (existsSync(candidate)) return candidate;
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
      const tsxCli = path.join(MANAGED_DIR, "node_modules", "tsx", "dist", "cli.mjs");
      if (existsSync(tsxCli)) {
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
      const candidate = path.join(dir, nodeName);
      if (existsSync(candidate)) return candidate;
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
    const delimiter = platform === "win32" ? ";" : path.delimiter;
    const currentPath = base.PATH || "";
    const parts = [];
    if (!currentPath.includes(MANAGED_BIN)) {
      parts.push(MANAGED_BIN);
    }
    const nodeBin = this.ctx.processExecPath ? path.dirname(this.ctx.processExecPath) : null;
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
}
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
  const home = supplementalHomeDir();
  return [
    path.join(home, ".local", "bin"),
    path.join(home, ".npm-global", "bin"),
    "/usr/local/bin"
  ].filter((d) => existsSync(d));
}
export {
  MANAGED_PI_PACKAGES,
  ToolResolver,
  isAppImageSelfHit,
  whichSync,
  whichViaLoginShell
};
