import { execFile, execFileSync, spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { supplementalHomeDir as homedir } from "../../../runtime-home.mjs";
import { delimiter, join } from "node:path";
class GitExecError extends Error {
  code;
  stderr;
  constructor(message, code, stderr) {
    super(message);
    this.name = "GitExecError";
    this.code = code;
    this.stderr = stderr;
  }
}
const GIT_ENV = { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" };
function realGit(args, cwd) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 3e4, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...GIT_ENV } });
  } catch (e) {
    const err = e;
    throw new GitExecError(err.message, err.code ?? err.status ?? null, String(err.stderr ?? ""));
  }
}
const binCache = /* @__PURE__ */ new Map();
function resolveBinOnPath(name, env = process.env) {
  if (binCache.has(name)) return binCache.get(name) ?? null;
  const dirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const extra of ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", join(homedir(), ".local", "bin")]) if (!dirs.includes(extra)) dirs.push(extra);
  let found = null;
  for (const d of dirs) {
    const p = join(d, name);
    try {
      if (!statSync(p).isFile()) continue;
      accessSync(p, constants.X_OK);
      found = p;
      break;
    } catch {
    }
  }
  binCache.set(name, found);
  return found;
}
function realRunCli(bin, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(bin, args, { encoding: "utf8", timeout: opts.timeoutMs ?? 3e4, maxBuffer: 16 * 1024 * 1024, signal: opts.signal, env: opts.env ?? process.env }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err;
      if (typeof e.code === "string") return resolve({ code: null, stdout: stdout ?? "", stderr: stderr ?? "", spawnError: `${e.code}: ${e.message}` });
      resolve({ code: typeof e.code === "number" ? e.code : 1, stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
function defaultDeps() {
  return {
    git: realGit,
    spawnGit: (args, cwd) => spawn("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...GIT_ENV } }),
    resolveBin: (name) => resolveBinOnPath(name),
    runCli: realRunCli,
    fetch: (...a) => globalThis.fetch(...a),
    now: () => Date.now(),
    requestTimeoutMs: 3e4,
    env: process.env,
    baseDir: join(homedir(), ".pi", "dashboard", "kb", "git"),
    owner: `${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
    log: (line) => console.log(`[kb-git] ${line}`)
  };
}
export {
  GitExecError,
  defaultDeps
};
