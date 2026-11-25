/** Read-only follower. Native IDs, cookies, task mutations and scientific acceptance stay in the host. */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { validHostPartition } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import { isScienceInstanceId, projectScienceArtifact, projectScienceDetailResponse } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";

const POLL_MS = 5_000, RECONNECT_MS = 60_000, FRESH_MS = 30_000, READ_MS = 6_000;
const CONFIG_BYTES = 8_192, PROMPT_BYTES = 65_536;
const object = value => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const absolute = value => typeof value === "string" && value.length <= 4096 && !value.includes("\0") && path.isAbsolute(value) && path.resolve(value) === value;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const configIo = Object.freeze({ lstat, open, realpath });

export class ScienceWorkerError extends Error {
  constructor(code, upstreamMayContinue = true) { super(code); this.name = "ScienceWorkerError"; this.code = code; this.upstreamMayContinue = upstreamMayContinue; }
}
const failed = code => new ScienceWorkerError(code);
function requireValue(value, code) { if (!value) throw failed(code); }
function stopped(signal) { if (signal?.aborted) throw failed("science-worker-stopped"); }

async function interrupted(promise, signal, ms, timeoutCode) {
  stopped(signal);
  let timer, abort;
  const interruption = new Promise((_, reject) => {
    abort = () => reject(failed("science-worker-stopped"));
    signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(failed(timeoutCode)), Math.max(1, ms));
  });
  try { return await Promise.race([promise, interruption]); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** The complete Pi system/task wrapper is inert. It supplies neither selectors nor grants. */
export async function readSciencePrompt(stream, { signal } = {}) {
  const read = async () => {
    const decoder = new TextDecoder("utf-8", { fatal: true }); let size = 0;
    try {
      for await (const chunk of stream) {
        stopped(signal);
        requireValue(Buffer.isBuffer(chunk) && (size += chunk.length) <= PROMPT_BYTES && !chunk.includes(0), "science-worker-input-refused");
        decoder.decode(chunk, { stream: true });
      }
      decoder.decode();
    } catch (error) { if (error instanceof ScienceWorkerError) throw error; throw failed("science-worker-input-refused"); }
  };
  try { await interrupted(read(), signal, READ_MS, "science-worker-input-refused"); }
  finally { stream.destroy(); }
}

function checkedConfig(value, now) {
  requireValue(exact(value, ["schemaVersion", "taskRef", "partition", "hostPrivateDir", "expiresAt", "deadlineAt"]) && value.schemaVersion === 1 && isScienceInstanceId(value.taskRef)
    && exact(value.partition, ["ownerKey", "cwd"]) && validHostPartition(value.partition) && value.partition.ownerKey.length <= 512 && !/[\x00-\x1f\x7f]/.test(value.partition.ownerKey)
    && absolute(value.partition.cwd) && absolute(value.hostPrivateDir) && timestamp(value.expiresAt) && timestamp(value.deadlineAt) && value.deadlineAt > now && value.deadlineAt - now <= 86_100_000 && value.expiresAt >= value.deadlineAt,
  "science-worker-config-refused");
  return Object.freeze({ ...value, partition: Object.freeze({ ...value.partition }) });
}

async function rootAncestors(file, io) {
  const result = [];
  for (let current = path.dirname(file); ; current = path.dirname(current)) {
    const entry = await io.lstat(current);
    requireValue(entry.isDirectory() && !entry.isSymbolicLink() && entry.uid === 0 && (entry.mode & 0o022) === 0 && await io.realpath(current) === current, "science-worker-config-refused");
    result.push({ path: current, dev: entry.dev, ino: entry.ino });
    if (current === "/") return result;
  }
}
async function readPrivateConfig(file, io) {
  requireValue(process.platform === "linux" && process.getgid && absolute(file), "science-worker-config-refused");
  const ancestry = await rootAncestors(file, io), parent = path.dirname(file), directory = await io.lstat(parent);
  requireValue(directory.uid === 0 && directory.gid === process.getgid() && (directory.mode & 0o7777) === 0o750, "science-worker-config-refused");
  const before = await io.lstat(file);
  const privateFile = entry => entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.uid === 0 && entry.gid === process.getgid() && (entry.mode & 0o7777) === 0o440 && entry.size > 0 && entry.size <= CONFIG_BYTES;
  requireValue(privateFile(before), "science-worker-config-refused");
  const handle = await io.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    requireValue(privateFile(opened) && sameFile(opened, before) && await io.realpath(`/proc/self/fd/${handle.fd}`) === file, "science-worker-config-refused");
    const bytes = Buffer.alloc(opened.size + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat(), current = await io.lstat(file), afterDir = await io.lstat(parent), afterAncestry = await rootAncestors(file, io);
    requireValue(offset === opened.size && privateFile(after) && privateFile(current) && sameFile(opened, after) && sameFile(opened, current) && directory.dev === afterDir.dev && directory.ino === afterDir.ino && afterDir.gid === process.getgid() && (afterDir.mode & 0o7777) === 0o750 && JSON.stringify(ancestry) === JSON.stringify(afterAncestry), "science-worker-config-refused");
    return { stat: opened, ancestry, sha256: digest(bytes.subarray(0, offset)), bytes: bytes.subarray(0, offset) };
  } finally { await handle.close(); }
}

/** Main passes a fixed host-private path in launch args. File privacy is a transport boundary;
 * it does not install host authority. Every client read still revalidates the host's live scope. */
export async function loadScienceWorkerConfig(file, { io = configIo } = {}) {
  try {
    const pinned = await readPrivateConfig(file, io), config = checkedConfig(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(pinned.bytes)), Date.now());
    requireValue(await io.realpath(config.partition.cwd) === config.partition.cwd && (await io.lstat(config.partition.cwd)).isDirectory(), "science-worker-config-refused");
    return Object.freeze({ config, async revalidate() {
      try {
        const current = await readPrivateConfig(file, io);
        requireValue(Date.now() < config.expiresAt && sameFile(pinned.stat, current.stat) && pinned.sha256 === current.sha256 && JSON.stringify(pinned.ancestry) === JSON.stringify(current.ancestry), "science-worker-authority-refused");
      } catch { throw failed("science-worker-authority-refused"); }
    } });
  } catch { throw failed("science-worker-config-refused"); }
}

/** Only the already-authorized host read interface is retained. No submit/cancel member is read. */
export async function followScienceTask(lease, client, { signal, now = Date.now, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const config = structuredClone(lease.config), revalidate = lease.revalidate.bind(lease);
  const detail = client.detail.bind(client), readArtifact = client.readArtifact.bind(client);
  let lostSince;
  const checkTime = () => { stopped(signal); requireValue(now() < config.expiresAt, "science-worker-authority-expired"); requireValue(now() < config.deadlineAt, "science-worker-deadline"); };
  const guard = async () => {
    checkTime();
    try { await revalidate(); } catch { throw failed("science-worker-authority-refused"); }
    checkTime();
  };
  const call = async operation => {
    await guard();
    let value;
    try { value = await interrupted(Promise.resolve().then(operation), signal, Math.min(READ_MS, config.expiresAt - now(), config.deadlineAt - now()), "science-worker-read-unavailable"); }
    catch (error) { checkTime(); throw error; }
    await guard(); return value;
  };
  const fresh = instance => !instance.stale && instance.lastObservedAt !== null && instance.lastObservedAt <= now() && now() - instance.lastObservedAt <= FRESH_MS;
  const readDetail = async () => {
    let result;
    try { result = projectScienceDetailResponse(await call(() => detail({ ...config.partition }, config.taskRef))); }
    catch (error) { if (error instanceof ScienceWorkerError && error.code !== "science-worker-read-unavailable") throw error; result = { availability: "unknown", reason: "host-offline" }; }
    if (result.availability !== "ready") {
      if (result.reason === "invalid-host-response") throw failed("science-worker-response-refused");
      if (result.reason !== "host-offline") throw failed("science-worker-authority-refused");
      return null;
    }
    requireValue(result.instance.id === config.taskRef, "science-worker-response-refused");
    return result.instance;
  };
  const wait = async () => { await guard(); await interrupted(Promise.resolve().then(() => pause(Math.min(POLL_MS, config.deadlineAt - now(), config.expiresAt - now()))), signal, Math.min(POLL_MS + READ_MS, config.deadlineAt - now(), config.expiresAt - now()), "science-worker-deadline"); await guard(); };
  const verifyArtifacts = async instance => {
    requireValue(instance.artifacts.length > 0, "science-worker-artifact-refused");
    for (const expected of instance.artifacts) {
      const result = await call(() => readArtifact({ ...config.partition }, config.taskRef, expected.id));
      if (result?.availability !== "ready") {
        if (result?.reason === "binding-unavailable") throw failed("science-worker-authority-refused");
        throw failed("science-worker-artifact-refused");
      }
      const metadata = projectScienceArtifact(result.artifact);
      requireValue(metadata && JSON.stringify(metadata) === JSON.stringify(expected) && result.content instanceof Uint8Array && result.content.byteLength === expected.bytes && digest(result.content) === expected.sha256, "science-worker-artifact-refused");
    }
  };
  for (;;) {
    await guard();
    requireValue(lostSince === undefined || now() - lostSince < RECONNECT_MS, "science-worker-host-lost");
    const first = await readDetail();
    if (!first || !fresh(first)) {
      lostSince ??= now();
      requireValue(now() - lostSince < RECONNECT_MS, "science-worker-host-lost");
      await wait(); continue;
    }
    lostSince = undefined;
    if (first.status === "failed" || first.status === "cancelled") throw new ScienceWorkerError(`science-worker-upstream-${first.status}`, false);
    if (first.status !== "completed") { await wait(); continue; }
    await verifyArtifacts(first);
    const final = await readDetail();
    await guard();
    if (!final || !fresh(final) || final.status !== "completed" || JSON.stringify(final.artifacts) !== JSON.stringify(first.artifacts)) { await wait(); continue; }
    const manifest = {
      schemaVersion: 1, kind: "science-external-cli-manifest", taskRef: config.taskRef, status: "completed", observedAt: final.lastObservedAt,
      artifactsVerified: true, requiresHostValidation: true, scientificAccepted: false,
      actualModelIdentity: "unknown", actualProvider: "unknown", actualEffort: "unknown", artifacts: final.artifacts,
    };
    requireValue(Buffer.byteLength(JSON.stringify(manifest)) <= 16_384, "science-worker-response-refused");
    return manifest;
  }
}
