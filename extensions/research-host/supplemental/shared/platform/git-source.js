import {
  selectGitSource
} from "./select-git-source.js";
import {
  ensureBundledGitOnPath,
  resolveBundledGitDir
} from "./ensure-bundled-git.js";
import { spawnSync } from "./exec.js";
import path from "node:path";
let configuredSetting = "auto";
let cached = null;
function setWindowsGitSourceSetting(setting) {
  if (setting !== configuredSetting) {
    configuredSetting = setting;
    invalidateGitSourceCache();
  }
}
function invalidateGitSourceCache() {
  cached = null;
  readoutCache = null;
}
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
let readoutCache = null;
function probeVersion(gitPath) {
  try {
    const r = spawnSync(gitPath, ["--version"], { encoding: "utf8", timeout: 5e3 });
    return r.status === 0 ? (r.stdout || "").trim() || null : null;
  } catch {
    return null;
  }
}
function getGitSourceReadout(which, opts = {}) {
  if (process.platform !== "win32") return null;
  if (readoutCache) return readoutCache;
  const { source, setting, gitDir } = getActiveGitSource(which, opts);
  let gitPath = null;
  let shellPath = null;
  if (source === "bundled" && gitDir) {
    gitPath = path.win32.join(gitDir, "cmd", "git.exe");
    shellPath = path.win32.join(gitDir, "usr", "bin", "sh.exe");
  } else {
    gitPath = which("git");
    shellPath = which("bash") ?? which("sh");
  }
  readoutCache = {
    setting,
    source,
    gitPath,
    gitVersion: gitPath ? probeVersion(gitPath) : null,
    shellPath
  };
  return readoutCache;
}
export {
  augmentEnvWithGitSource,
  getActiveGitSource,
  getGitSourceReadout,
  invalidateGitSourceCache,
  setWindowsGitSourceSetting
};
