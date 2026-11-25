import { existsSync } from "node:fs";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ToolResolver } from "./binary-lookup.js";
import { normalizeEnvPathKey } from "./env-path-key.js";
import { buildSafeArgv, spawn, spawnSync } from "./exec.js";
const sharedResolver = new ToolResolver({
  processExecPath: process.execPath,
  useLoginShell: true
});
function resetResolverCache() {
  try {
    const reg = tryGetRegistry();
    if (reg) reg.rescan();
  } catch {
  }
}
const GLOBAL_REGISTRY_KEY = /* @__PURE__ */ Symbol.for("pi-dashboard.tool-registry");
function tryGetRegistry() {
  const reg = globalThis[GLOBAL_REGISTRY_KEY];
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
  if (path.isAbsolute(cmd)) return true;
  if (cmd.startsWith("./") || cmd.startsWith("../")) return true;
  if (cmd.startsWith(".\\") || cmd.startsWith("..\\")) return true;
  return false;
}
function resolveBinary(name) {
  if (isPathLike(name)) {
    if (existsSync(name)) return name;
    return null;
  }
  const registry = tryGetRegistry();
  if (registry && registry.has(name)) {
    const resolved = registry.resolve(name);
    return resolved.ok ? resolved.path : null;
  }
  return sharedResolver.which(name);
}
function resolveExecutorArgv(name, recipeArgs) {
  if (isPathLike(name)) {
    if (existsSync(name)) return [name, ...recipeArgs];
    return null;
  }
  const registry = tryGetRegistry();
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
const DEFAULT_TIMEOUT_MS = 5e3;
function run(recipe, input, ctx = {}) {
  const argv = recipe.argv(input);
  if (argv.length === 0) {
    return { ok: false, error: { kind: "spawn-failure", message: "Recipe produced empty argv" } };
  }
  const [rawCmd, ...recipeArgs] = argv;
  const execArgv = resolveExecutorArgv(rawCmd, recipeArgs);
  if (!execArgv) {
    return { ok: false, error: { kind: "not-found", binary: rawCmd } };
  }
  const timeout = ctx.timeout ?? recipe.timeout ?? DEFAULT_TIMEOUT_MS;
  const [execCmd, ...execArgs] = execArgv;
  const { argv: safeArgv, spawnOptions } = buildSafeArgv(execCmd, execArgs);
  try {
    const result = spawnSync(safeArgv[0], safeArgv.slice(1), {
      cwd: ctx.cwd,
      env: buildSpawnEnvForArgv(execCmd, ctx.env),
      encoding: "utf-8",
      timeout,
      stdio: ["pipe", "pipe", "pipe"],
      ...spawnOptions
      // shell: false, windowsHide: true
    });
    if (result.error) {
      const err = result.error;
      if (err.code === "ETIMEDOUT" || err.message?.includes("ETIMEDOUT")) {
        return { ok: false, error: { kind: "timeout", timeoutMs: timeout, binary: rawCmd } };
      }
      return { ok: false, error: { kind: "spawn-failure", message: err.message } };
    }
    if (result.status === null && result.signal) {
      return { ok: false, error: { kind: "timeout", timeoutMs: timeout, binary: rawCmd } };
    }
    const stdout = typeof result.stdout === "string" ? result.stdout : String(result.stdout ?? "");
    const stderr = typeof result.stderr === "string" ? result.stderr : String(result.stderr ?? "");
    const status = result.status;
    const tolerated = status !== 0 && recipe.tolerate?.includes(status ?? -1);
    if (status === 0 || tolerated) {
      return { ok: true, value: recipe.parse(stdout, input) };
    }
    return { ok: false, error: { kind: "exit", code: status, signal: result.signal, stdout, stderr } };
  } catch (err) {
    return {
      ok: false,
      error: { kind: "spawn-failure", message: err instanceof Error ? err.message : String(err) }
    };
  }
}
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
export {
  buildSpawnEnvForArgv,
  electronAsNodeRequired,
  resetResolverCache,
  resolveExecutorArgv,
  run,
  runAsync,
  unwrap
};
