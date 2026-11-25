/** Independent host reads are required before the outer launcher reports completion. */
import { createHash } from "node:crypto";
import { createScienceHostClient } from "@blackbelt-technology/pi-dashboard-server/science-host-client";
import { projectScienceArtifact, projectScienceDetailResponse, SCIENCE_RECORD_LIMITS } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import { loadScienceWorkerConfig, ScienceWorkerError } from "./science-worker.mjs";

const LIMIT = 16_384, READ_MS = 5_000, FRESH_MS = 30_000;
const manifestKeys = ["schemaVersion", "kind", "taskRef", "status", "observedAt", "artifactsVerified", "requiresHostValidation", "scientificAccepted", "actualModelIdentity", "actualProvider", "actualEffort", "artifacts"];
const artifactKeys = ["id", "name", "mediaType", "bytes", "sha256"];
const exact = (value, keys) => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const failed = code => new ScienceWorkerError(code);
const requireValue = (value, code) => { if (!value) throw failed(code); };
const stopped = signal => requireValue(!signal?.aborted, "science-worker-stopped");
const equal = (left, right) => JSON.stringify(left) === JSON.stringify(right);

async function bounded(operation, signal, milliseconds = READ_MS) {
  stopped(signal);
  let timer, abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(failed("science-worker-stopped"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(failed("science-worker-read-unavailable")), Math.max(1, milliseconds));
  });
  try { return await Promise.race([Promise.resolve().then(operation), interrupted]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}
function parseManifest(output, now) {
  let value;
  try {
    requireValue(typeof output === "string" || output instanceof Uint8Array, "science-worker-response-refused");
    const bytes = typeof output === "string" ? Buffer.from(output) : output;
    requireValue(bytes.byteLength > 0 && bytes.byteLength <= LIMIT, "science-worker-response-refused");
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw failed("science-worker-response-refused"); }
  requireValue(exact(value, manifestKeys) && value.schemaVersion === 1 && value.kind === "science-external-cli-manifest" && value.status === "completed"
    && Number.isSafeInteger(value.observedAt) && value.observedAt >= 0 && value.observedAt <= now()
    && value.artifactsVerified === true && value.requiresHostValidation === true && value.scientificAccepted === false
    && value.actualModelIdentity === "unknown" && value.actualProvider === "unknown" && value.actualEffort === "unknown"
    && Array.isArray(value.artifacts) && value.artifacts.length > 0 && value.artifacts.length <= SCIENCE_RECORD_LIMITS.artifacts,
  "science-worker-response-refused");
  const artifacts = value.artifacts.map(artifact => exact(artifact, artifactKeys) ? projectScienceArtifact(artifact) : null);
  requireValue(artifacts.every(Boolean) && new Set(artifacts.map(artifact => artifact?.id)).size === artifacts.length, "science-worker-response-refused");
  return { ...value, artifacts };
}

/** Fakes are available only to imports. CLI, environment and stdin cannot select these callbacks. */
export async function validateScienceWorkerManifest(configPath, childOutput, { signal, now = Date.now, loadConfig = loadScienceWorkerConfig, createClient = createScienceHostClient } = {}) {
  let client, disposed = false;
  const dispose = () => { if (!disposed) { disposed = true; try { client?.dispose(); } catch { /* Never expose private transport errors. */ } } };
  try {
    stopped(signal);
    const manifest = parseManifest(childOutput, now);
    let lease;
    try { lease = await bounded(() => loadConfig(configPath), signal); }
    catch (error) { stopped(signal); throw failed("science-worker-config-refused"); }
    const config = structuredClone(lease.config), revalidate = lease.revalidate.bind(lease);
    const checkTime = () => { stopped(signal); requireValue(now() < config.expiresAt, "science-worker-authority-expired"); requireValue(now() < config.deadlineAt, "science-worker-deadline"); };
    const remaining = () => Math.min(READ_MS, config.expiresAt - now(), config.deadlineAt - now());
    const guard = async () => {
      checkTime();
      try { await bounded(revalidate, signal, remaining()); }
      catch { checkTime(); throw failed("science-worker-authority-refused"); }
      checkTime();
    };
    await guard();
    requireValue(manifest.taskRef === config.taskRef, "science-worker-response-refused");
    client = createClient({ privateDir: config.hostPrivateDir });
    signal?.addEventListener("abort", dispose, { once: true });
    const detail = client.detail.bind(client), readArtifact = client.readArtifact.bind(client);
    const call = async operation => {
      await guard();
      let value;
      try { value = await bounded(operation, signal, remaining()); }
      catch (error) { checkTime(); throw error; }
      await guard(); return value;
    };
    const readDetail = async () => {
      const result = projectScienceDetailResponse(await call(() => detail({ ...config.partition }, config.taskRef)));
      if (result.availability !== "ready") throw failed(result.reason === "binding-unavailable" ? "science-worker-authority-refused" : result.reason === "invalid-host-response" ? "science-worker-response-refused" : "science-worker-read-unavailable");
      const instance = result.instance;
      requireValue(instance.id === config.taskRef && instance.status === "completed" && !instance.stale && instance.lastObservedAt !== null && instance.lastObservedAt <= now()
        && now() - instance.lastObservedAt <= FRESH_MS && manifest.observedAt <= instance.lastObservedAt, "science-worker-response-refused");
      requireValue(equal(instance.artifacts, manifest.artifacts), "science-worker-artifact-refused");
      return instance;
    };
    await readDetail();
    for (const expected of manifest.artifacts) {
      const result = await call(() => readArtifact({ ...config.partition }, config.taskRef, expected.id));
      if (result?.availability !== "ready") throw failed(result?.reason === "binding-unavailable" ? "science-worker-authority-refused" : "science-worker-artifact-refused");
      const metadata = projectScienceArtifact(result.artifact);
      requireValue(metadata && equal(metadata, expected) && result.content instanceof Uint8Array && result.content.byteLength === expected.bytes
        && createHash("sha256").update(result.content).digest("hex") === expected.sha256, "science-worker-artifact-refused");
    }
    const final = await readDetail();
    const result = { ...manifest, observedAt: final.lastObservedAt, requiresHostValidation: false, hostValidated: true, artifacts: final.artifacts };
    requireValue(Buffer.byteLength(JSON.stringify(result)) + 1 <= LIMIT, "science-worker-response-refused");
    await guard(); return result;
  } catch (error) {
    if (error instanceof ScienceWorkerError) throw error;
    throw failed("science-worker-read-unavailable");
  } finally { signal?.removeEventListener("abort", dispose); dispose(); }
}
