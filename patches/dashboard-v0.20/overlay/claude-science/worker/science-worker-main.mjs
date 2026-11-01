import { fileURLToPath } from "node:url";
import { createScienceHostClient } from "@blackbelt-technology/pi-dashboard-server/science-host-client";
import { followScienceTask, loadScienceWorkerConfig, readSciencePrompt, ScienceWorkerError } from "./science-worker.mjs";

const KNOWN = new Set(["config-refused", "input-refused", "authority-refused", "authority-expired", "deadline", "host-lost", "response-refused", "artifact-refused", "stopped", "upstream-failed", "upstream-cancelled", "read-unavailable"]);
function failure(error) {
  const suffix = error instanceof ScienceWorkerError ? error.code.slice("science-worker-".length) : "unavailable";
  const code = KNOWN.has(suffix) ? `science-worker-${suffix}` : "science-worker-unavailable";
  const mayContinue = !(error instanceof ScienceWorkerError) || error.upstreamMayContinue;
  return { message: `${code}${mayContinue ? "; upstream may continue" : ""}\n`, exitCode: suffix === "deadline" ? 124 : suffix === "stopped" ? 130 : suffix.startsWith("upstream-") ? 3 : 1 };
}

/** Test seams are code-only, never CLI/env/prompt options. Production uses the actual private SDK client. */
export async function runScienceWorkerCli({ args = process.argv.slice(2), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, signal, loadConfig = loadScienceWorkerConfig, createClient = createScienceHostClient } = {}) {
  let client;
  try {
    if (args.length !== 2 || args[0] !== "--config") throw new ScienceWorkerError("science-worker-config-refused");
    const lease = await loadConfig(args[1]);
    await readSciencePrompt(stdin, { signal });
    client = createClient({ privateDir: lease.config.hostPrivateDir });
    const manifest = await followScienceTask(lease, client, { signal });
    client.dispose(); client = undefined;
    stdout.write(`${JSON.stringify(manifest)}\n`);
    return 0;
  } catch (error) {
    const result = failure(error); stderr.write(result.message); return result.exitCode;
  } finally { try { client?.dispose(); } catch { /* Fixed diagnostics above; cleanup cannot expose a host exception. */ } }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) process.once(signal, () => controller.abort());
  process.exitCode = await runScienceWorkerCli({ signal: controller.signal });
}
