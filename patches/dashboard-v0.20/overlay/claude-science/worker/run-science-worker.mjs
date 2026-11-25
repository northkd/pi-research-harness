#!/usr/bin/env node
/** Host must start this with /usr/bin/env -i so NODE_OPTIONS is cleared before the first Node starts. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveNativeTsLoader } from "@blackbelt-technology/pi-dashboard-shared/platform/ts-loader-select.mjs";

export const scienceWorkerEnvironment = () => ({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });

async function validateOnHost(file, output, options) {
  await import(resolveNativeTsLoader({ anchor: import.meta.url }));
  const { validateScienceWorkerManifest } = await import("./science-worker-host-validator.mjs");
  return validateScienceWorkerManifest(file, output, options);
}

/** Import-only seams cannot be selected by CLI arguments, environment or prompt text. */
export async function launchScienceWorker(args = process.argv.slice(2), { spawnChild = spawn, validateManifest = validateOnHost, signals = process, stdout = process.stdout, stderr = process.stderr } = {}) {
  if (args.length !== 2 || args[0] !== "--config") { stderr.write("science-worker-config-refused; upstream may continue\n"); return 1; }
  let child, childClosed = false, stopped = false, forceKill;
  const controller = new AbortController();
  const killChild = signal => {
    if (!child || childClosed) return;
    try { child.kill(signal); } catch { /* Only this launcher's owned child is controlled. */ }
    forceKill ??= setTimeout(() => { if (!childClosed) { try { child.kill("SIGKILL"); } catch { /* Fixed diagnostics below. */ } } }, 3_000);
  };
  const listeners = ["SIGTERM", "SIGINT", "SIGHUP"].map(signal => {
    const listener = () => { stopped = true; controller.abort(); killChild(signal); };
    signals.on(signal, listener); return [signal, listener];
  });
  try {
    try {
      child = spawnChild(process.execPath, ["--import", resolveNativeTsLoader({ anchor: import.meta.url }), fileURLToPath(new URL("./science-worker-main.mjs", import.meta.url)), ...args], { cwd: "/", env: scienceWorkerEnvironment(), stdio: ["inherit", "pipe", "pipe"] });
    } catch { stderr.write("science-worker-launch-unavailable; upstream may continue\n"); return 1; }
    let bytes = 0, chunks = [], diagnostic = "", outputRefused = false;
    child.stdout.on("data", chunk => {
      if (outputRefused) return;
      bytes += chunk.length;
      if (!Buffer.isBuffer(chunk) || bytes > 16_384) { outputRefused = true; chunks = []; killChild("SIGTERM"); }
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { if (diagnostic.length < 1024) diagnostic += chunk.toString("utf8").slice(0, 1024 - diagnostic.length); });
    const code = await new Promise(resolve => { child.once("error", () => resolve(1)); child.once("close", value => resolve(value ?? 1)); });
    childClosed = true; clearTimeout(forceKill);
    if (stopped) { stderr.write("science-worker-stopped; upstream may continue\n"); return 130; }
    if (outputRefused) { stderr.write("science-worker-response-refused; upstream may continue\n"); return 1; }
    if (code === 0) {
      const manifest = await validateManifest(args[1], Buffer.concat(chunks, bytes), { signal: controller.signal });
      if (stopped || controller.signal.aborted) { stderr.write("science-worker-stopped; upstream may continue\n"); return 130; }
      const output = `${JSON.stringify(manifest)}\n`;
      if (manifest?.hostValidated !== true || manifest.requiresHostValidation !== false || manifest.scientificAccepted !== false || Buffer.byteLength(output) > 16_384) {
        stderr.write("science-worker-response-refused; upstream may continue\n"); return 1;
      }
      stdout.write(output); return 0;
    }
    const safe = /^science-worker-(?:config-refused|input-refused|authority-refused|authority-expired|deadline|host-lost|response-refused|artifact-refused|stopped|upstream-failed|upstream-cancelled|read-unavailable|unavailable)(?:; upstream may continue)?\n$/;
    stderr.write(safe.test(diagnostic) ? diagnostic : "science-worker-runtime-unavailable; upstream may continue\n");
    return code || 1;
  } catch (error) {
    const known = /^science-worker-(?:config-refused|authority-refused|authority-expired|deadline|response-refused|artifact-refused|stopped|read-unavailable)$/;
    const code = stopped || controller.signal.aborted ? "science-worker-stopped" : known.test(error?.code) ? error.code : "science-worker-runtime-unavailable";
    stderr.write(`${code}; upstream may continue\n`);
    return code === "science-worker-stopped" ? 130 : code === "science-worker-deadline" ? 124 : 1;
  } finally {
    clearTimeout(forceKill);
    for (const [signal, listener] of listeners) signals.removeListener(signal, listener);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await launchScienceWorker();
