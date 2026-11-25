import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseDocument } from "yaml";
import { prepareScienceGatewayConfig } from "./science-gateway-config.js";

const maximumBytes = 1024 * 1024;
const planningKey = "science-planning-placeholder-000000000000000000000000000000000000";
const pinnedRuntimeSha256 = "163fe79fdd84e7b071520212382d798a2163edfe3b85183312a1d17bd7dcc4a7";
const privateFiles = ["client.key", "original.yaml", "candidate.yaml", "intent.json", "intent.next"];

export interface ScienceGatewayProvisionPaths {
  /** Host configuration only; never take these paths from a browser request. */
  configFile: string;
  privateDirectory: string;
}

export interface ScienceGatewayTargetIdentity {
  device: string;
  inode: string;
  size: number;
}

export interface ScienceGatewayProvisionDependencies {
  generateKey?: () => string;
  /** Fresh host-owned check of the pinned runtime, Docker bind and live watcher.
   * This gate cannot waive the append-only proof implemented below. */
  inspectRuntime?: (identity: ScienceGatewayTargetIdentity) => Promise<{
    binarySha256: string;
    boundDevice: string;
    boundInode: string;
    watcherReady: boolean;
  } | null>;
}

export interface ScienceGatewayProvisionReceipt {
  status: "prepared" | "applied" | "maintenance-required" | "conflict" | "unknown" | "unavailable" | "locked";
  reason?: "non-append-update" | "unsafe-authentication-prefix" | "runtime-not-verified" | "target-unavailable"
    | "private-state-unavailable" | "incomplete-private-state" | "configuration-changed" | "write-unconfirmed" | "not-prepared";
}

interface Intent extends ScienceGatewayTargetIdentity {
  version: 1;
  stage: "prepared" | "appending" | "applied";
}

interface PrivateState {
  key: string;
  original: Buffer;
  candidate: Buffer;
  intent: Intent;
}

interface PrivateDirectory {
  name: string;
  handle: fs.FileHandle;
  identity: ScienceGatewayTargetIdentity;
  file: (name: string) => string;
}

function sameIdentity(left: ScienceGatewayTargetIdentity, right: ScienceGatewayTargetIdentity) {
  return left.device === right.device && left.inode === right.inode;
}

function identity(stat: import("node:fs").BigIntStats): ScienceGatewayTargetIdentity {
  return { device: String(stat.dev), inode: String(stat.ino), size: Number(stat.size) };
}

async function checkAncestors(file: string) {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error();
  let current = path.parse(file).root;
  for (const part of path.dirname(file).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
  }
}

function checkRegular(stat: import("node:fs").BigIntStats) {
  if (!stat.isFile() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())
    || (stat.mode & 0o077n) !== 0n || stat.size > BigInt(maximumBytes)) throw new Error();
}

async function openRegular(file: string, flags = constants.O_RDONLY, anchored = false) {
  if (!anchored) await checkAncestors(file);
  const handle = await fs.open(file, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    checkRegular(stat);
    const named = await fs.lstat(file, { bigint: true });
    if (!sameIdentity(identity(stat), identity(named)) || named.isSymbolicLink()) throw new Error();
    return handle;
  } catch { await handle.close(); throw new Error(); }
}

async function readHandle(handle: fs.FileHandle) {
  const before = await handle.stat({ bigint: true });
  checkRegular(before);
  const buffer = Buffer.alloc(Number(before.size) + 1);
  let length = 0;
  while (length < buffer.length) {
    const result = await handle.read(buffer, length, buffer.length - length, length);
    if (!result.bytesRead) break;
    length += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
    || before.ctimeNs !== after.ctimeNs || !sameIdentity(identity(before), identity(after))) throw new Error();
  return { bytes: buffer.subarray(0, length), identity: identity(after) };
}

async function readRegular(file: string) {
  const handle = await openRegular(file);
  try { return await readHandle(handle); }
  finally { await handle.close(); }
}

function parseConfiguration(source: string) {
  const document = parseDocument(source, { uniqueKeys: true, logLevel: "silent" });
  if (document.errors.length || document.warnings.length) return null;
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function proveAppend(original: string, candidate: string, key: string) {
  if (!candidate.startsWith(original)) return "non-append-update" as const;
  const before = parseConfiguration(original);
  const keys = before?.["api-keys"];
  if (!before || !Array.isArray(keys) || !keys.length
    || keys.some((value) => typeof value !== "string" || /^\p{White_Space}*$/u.test(value))) return "unsafe-authentication-prefix" as const;
  const tail = candidate.slice(original.length);
  // A single quoted scalar is the only live edit supported. No byte of the
  // existing YAML moves, changes or disappears, including its entire auth list.
  if (!/^(?:\r?\n)? *- "[A-Za-z0-9_-]{32,128}"\r?\n$/.test(tail) || tail.length > 256) {
    return "non-append-update" as const;
  }
  for (let count = 0; count <= tail.length; count++) {
    const value = parseConfiguration(original + tail.slice(0, count));
    if (!value) continue; // The pinned runtime retains its last good config.
    const observed = value["api-keys"];
    if (!Array.isArray(observed)) return "unsafe-authentication-prefix" as const;
    // Trailing null/empty entries leave authentication unchanged in the pinned
    // isolated v7.3.1 probe. normalizeKeys drops empty strings; the old nonempty
    // credential stays accepted and missing/empty/wrong credentials stay denied.
    const effective = observed.filter((entry) => entry !== null && entry !== "");
    if (!isDeepStrictEqual(effective, keys) && !isDeepStrictEqual(effective, [...keys, key])) {
      return "unsafe-authentication-prefix" as const;
    }
    value["api-keys"] = keys;
    if (!isDeepStrictEqual(value, before)) return "unsafe-authentication-prefix" as const;
  }
  return null;
}

async function openPrivateDirectory(directory: string, create: boolean): Promise<PrivateDirectory> {
  // Linux-only host: directory descriptors pin both creation and every secret
  // file operation. A renamed/replaced ancestor cannot redirect those writes.
  if (process.platform !== "linux") throw new Error();
  await checkAncestors(directory);
  const parent = await fs.open(path.dirname(directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let handle: fs.FileHandle | undefined;
  try {
    const anchored = `/proc/self/fd/${parent.fd}/${path.basename(directory)}`;
    if (create) {
      try { await fs.mkdir(anchored, { mode: 0o700 }); await parent.sync(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw new Error(); }
    }
    handle = await fs.open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const stat = await handle.stat({ bigint: true });
    if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o777n) !== 0o700n) throw new Error();
    const result: PrivateDirectory = {
      name: directory, handle, identity: identity(stat), file: (name) => `/proc/self/fd/${handle!.fd}/${name}`,
    };
    if (!await privateDirectoryCurrent(result)) throw new Error();
    return result;
  } catch (error) { if (handle) await handle.close(); throw error; }
  finally { await parent.close(); }
}

async function privateDirectoryCurrent(directory: PrivateDirectory) {
  try {
    await checkAncestors(directory.name);
    const named = await fs.lstat(directory.name, { bigint: true });
    return named.isDirectory() && !named.isSymbolicLink() && named.uid === BigInt(process.getuid!())
      && (named.mode & 0o777n) === 0o700n && sameIdentity(directory.identity, identity(named));
  } catch { return false; }
}

async function readPrivate(directory: PrivateDirectory, name: string) {
  const handle = await openRegular(directory.file(name), constants.O_RDONLY, true);
  try { return await readHandle(handle); }
  finally { await handle.close(); }
}

async function writePrivate(directory: PrivateDirectory, name: string, bytes: Buffer | string) {
  const handle = await fs.open(directory.file(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); }
  finally { await handle.close(); }
}

async function updateIntent(directory: PrivateDirectory, intent: Intent) {
  await writePrivate(directory, "intent.next", JSON.stringify(intent));
  await fs.rename(directory.file("intent.next"), directory.file("intent.json"));
  await directory.handle.sync();
}

async function loadState(directory: PrivateDirectory): Promise<PrivateState | null> {
  const names = await fs.readdir(directory.file("."));
  if (!names.includes("intent.json")) {
    if (names.some((name) => privateFiles.includes(name))) throw new Error("incomplete");
    return null;
  }
  if (names.includes("intent.next")) throw new Error("incomplete");
  const key = (await readPrivate(directory, "client.key")).bytes.toString("utf8");
  const original = (await readPrivate(directory, "original.yaml")).bytes;
  const candidate = (await readPrivate(directory, "candidate.yaml")).bytes;
  const intent: Intent = JSON.parse((await readPrivate(directory, "intent.json")).bytes.toString("utf8"));
  if (intent.version !== 1 || !["prepared", "appending", "applied"].includes(intent.stage)
    || !/^\d+$/.test(intent.device) || !/^\d+$/.test(intent.inode) || intent.size !== original.length
    || !/^[A-Za-z0-9_-]{32,128}$/.test(key)) throw new Error();
  if (!Buffer.from(original.toString("utf8"), "utf8").equals(original)
    || !Buffer.from(candidate.toString("utf8"), "utf8").equals(candidate)
    || !candidate.subarray(0, original.length).equals(original)
    || prepareScienceGatewayConfig(original.toString("utf8"), key).source !== candidate.toString("utf8")
    || proveAppend(original.toString("utf8"), candidate.toString("utf8"), key)) throw new Error();
  return { key, original, candidate, intent };
}

function compareState(state: PrivateState, target: Awaited<ReturnType<typeof readRegular>>): ScienceGatewayProvisionReceipt {
  if (!sameIdentity(state.intent, target.identity)) return { status: "conflict", reason: "configuration-changed" };
  if (state.intent.stage === "applied" && target.bytes.equals(state.candidate)) return { status: "applied" };
  if (state.intent.stage === "prepared" && target.bytes.equals(state.original)) return { status: "prepared" };
  if (state.intent.stage !== "prepared" && target.bytes.length >= state.original.length
    && target.bytes.subarray(0, state.original.length).equals(state.original)
    && state.candidate.subarray(0, target.bytes.length).equals(target.bytes)) return { status: "unknown", reason: "write-unconfirmed" };
  return { status: "conflict", reason: "configuration-changed" };
}

async function closeQuietly(handle?: fs.FileHandle) {
  try { await handle?.close(); } catch { /* Preserve fixed receipts; never expose raw errors. */ }
}

async function releaseLock(directory: PrivateDirectory, lock: fs.FileHandle) {
  try {
    const held = await lock.stat({ bigint: true });
    const named = await fs.lstat(directory.file("provision.lock"), { bigint: true });
    if (sameIdentity(identity(held), identity(named))) await fs.unlink(directory.file("provision.lock"));
  } catch { /* A replaced lock belongs to somebody else. */ }
  await closeQuietly(lock);
  await closeQuietly(directory.handle);
}

async function appendTail(handle: fs.FileHandle, state: PrivateState) {
  let written = 0;
  const tail = state.candidate.subarray(state.original.length);
  while (written < tail.length) {
    // O_APPEND protects intervening bytes from a noncooperating writer.
    // The caller detects such conflicts without rolling anything back.
    const result = await handle.write(tail, written, tail.length - written, null);
    if (!result.bytesWritten || result.bytesWritten > tail.length - written) throw new Error();
    written += result.bytesWritten;
  }
  await handle.sync();
}

/** No route or CLI is registered here. This API stays inside the host process;
 * receipts deliberately contain no source, keys, paths, digests or raw errors.
 * The lock only serializes cooperating Science writers. It cannot exclude an
 * unrelated writer; pre/post CAS detects observed conflicts without rollback. */
export function createScienceGatewayProvisioner(paths: ScienceGatewayProvisionPaths, dependencies: ScienceGatewayProvisionDependencies = {}) {
  const directory = paths.privateDirectory;
  const keyGenerator = dependencies.generateKey ?? (() => randomBytes(32).toString("hex"));
  let unconfirmedWrite = false;

  async function runtimeVerified(target: ScienceGatewayTargetIdentity) {
    const observation = await dependencies.inspectRuntime?.(target);
    return observation?.binarySha256 === pinnedRuntimeSha256 && observation.watcherReady === true
      && observation.boundDevice === target.device && observation.boundInode === target.inode;
  }

  function privateFailure(error: unknown): ScienceGatewayProvisionReceipt {
    if (unconfirmedWrite) return { status: "unknown", reason: "write-unconfirmed" };
    return (error as Error).message === "incomplete" ? { status: "unknown", reason: "incomplete-private-state" }
      : { status: "unavailable", reason: "private-state-unavailable" };
  }

  async function locked(operation: (directory: PrivateDirectory) => Promise<ScienceGatewayProvisionReceipt>): Promise<ScienceGatewayProvisionReceipt> {
    let lock: fs.FileHandle;
    let privateDirectory: PrivateDirectory | undefined;
    try {
      privateDirectory = await openPrivateDirectory(directory, true);
      lock = await fs.open(privateDirectory.file("provision.lock"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      await closeQuietly(privateDirectory?.handle);
      return (error as NodeJS.ErrnoException).code === "EEXIST" ? { status: "locked" } : { status: "unavailable", reason: "private-state-unavailable" };
    }
    try { return await operation(privateDirectory); }
    catch (error) { return privateFailure(error); }
    finally { await releaseLock(privateDirectory, lock); }
  }

  async function existingPreparation(target: Awaited<ReturnType<typeof readRegular>>): Promise<ScienceGatewayProvisionReceipt | null> {
    // Check an existing durable intent before planning a new credential. No
    // private directory is created for an unsupported live-write layout.
    try {
      await fs.lstat(directory);
      const opened = await openPrivateDirectory(directory, false);
      try {
        const state = await loadState(opened);
        if (state) return await privateDirectoryCurrent(opened) ? compareState(state, target) : { status: "conflict", reason: "configuration-changed" };
      } finally { await opened.handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return privateFailure(error);
    }
    return null;
  }

  async function preparationGate(target: Awaited<ReturnType<typeof readRegular>>): Promise<ScienceGatewayProvisionReceipt | null> {
    const source = target.bytes.toString("utf8");
    if (!Buffer.from(source, "utf8").equals(target.bytes)) return { status: "maintenance-required", reason: "unsafe-authentication-prefix" };
    let reason: ReturnType<typeof proveAppend>;
    try { reason = proveAppend(source, prepareScienceGatewayConfig(source, planningKey).source, planningKey); }
    catch { return { status: "maintenance-required", reason: "unsafe-authentication-prefix" }; }
    if (reason) return { status: "maintenance-required", reason };
    try {
      if (!await runtimeVerified(target.identity)) return { status: "maintenance-required", reason: "runtime-not-verified" };
    } catch { return { status: "maintenance-required", reason: "runtime-not-verified" }; }
    return null;
  }

  async function stagePreparation(opened: PrivateDirectory, target: Awaited<ReturnType<typeof readRegular>>): Promise<ScienceGatewayProvisionReceipt> {
    const existing = await loadState(opened);
    if (existing) return compareState(existing, await readRegular(paths.configFile));
    const current = await readRegular(paths.configFile);
    if (!sameIdentity(target.identity, current.identity) || !current.bytes.equals(target.bytes)) return { status: "conflict", reason: "configuration-changed" };
    const source = target.bytes.toString("utf8");
    const key = keyGenerator();
    const candidate = prepareScienceGatewayConfig(source, key).source;
    if (proveAppend(source, candidate, key)) return { status: "maintenance-required", reason: "unsafe-authentication-prefix" };
    const intent: Intent = { version: 1, stage: "prepared", ...target.identity };
    await writePrivate(opened, "client.key", key);
    await writePrivate(opened, "original.yaml", target.bytes);
    await writePrivate(opened, "candidate.yaml", candidate);
    await writePrivate(opened, "intent.json", JSON.stringify(intent));
    await opened.handle.sync();
    if (!await privateDirectoryCurrent(opened)) return { status: "conflict", reason: "configuration-changed" };
    return { status: "prepared" };
  }

  async function prepare(): Promise<ScienceGatewayProvisionReceipt> {
    let target: Awaited<ReturnType<typeof readRegular>>;
    try { target = await readRegular(paths.configFile); }
    catch { return { status: "unavailable", reason: "target-unavailable" }; }
    const existing = await existingPreparation(target);
    if (existing) return existing;
    const refused = await preparationGate(target);
    if (refused) return refused;
    return locked((opened) => stagePreparation(opened, target));
  }

  async function reconcile(): Promise<ScienceGatewayProvisionReceipt> {
    if (unconfirmedWrite) return { status: "unknown", reason: "write-unconfirmed" };
    try {
      const opened = await openPrivateDirectory(directory, false);
      try {
        const state = await loadState(opened);
        if (!state) return { status: "unavailable", reason: "not-prepared" };
        if (!await privateDirectoryCurrent(opened)) return { status: "conflict", reason: "configuration-changed" };
        return compareState(state, await readRegular(paths.configFile));
      } finally { await opened.handle.close(); }
    } catch (error) { return privateFailure(error); }
  }

  async function originalObserved(handle: fs.FileHandle, state: PrivateState) {
    const before = await readHandle(handle);
    return sameIdentity(state.intent, before.identity) && before.bytes.equals(state.original);
  }

  async function readyToAppend(handle: fs.FileHandle, opened: PrivateDirectory, state: PrivateState) {
    const ready = await readHandle(handle);
    const stillNamed = await fs.lstat(paths.configFile, { bigint: true });
    return sameIdentity(ready.identity, identity(stillNamed)) && ready.bytes.equals(state.original)
      && await privateDirectoryCurrent(opened);
  }

  async function candidateObserved(handle: fs.FileHandle, state: PrivateState) {
    const after = await readHandle(handle);
    const named = await fs.lstat(paths.configFile, { bigint: true });
    return sameIdentity(after.identity, identity(named)) && after.bytes.equals(state.candidate);
  }

  async function acknowledge(opened: PrivateDirectory, state: PrivateState): Promise<ScienceGatewayProvisionReceipt> {
    await updateIntent(opened, { ...state.intent, stage: "applied" });
    if (!await privateDirectoryCurrent(opened)) {
      unconfirmedWrite = true;
      return { status: "unknown", reason: "write-unconfirmed" };
    }
    return { status: "applied" };
  }

  async function closeTarget(handle: fs.FileHandle, appending: boolean) {
    try { await handle.close(); }
    catch { if (appending) unconfirmedWrite = true; throw new Error(); }
  }

  async function appendPrepared(handle: fs.FileHandle, opened: PrivateDirectory, state: PrivateState): Promise<ScienceGatewayProvisionReceipt> {
    let appending = false;
    try {
      if (!await originalObserved(handle, state)) return { status: "conflict", reason: "configuration-changed" };
      // Once this durable intent exists, every interruption is unknown; neither
      // apply nor reconcile rolls back, re-appends or regenerates a key.
      await updateIntent(opened, { ...state.intent, stage: "appending" });
      appending = true;
      if (!await readyToAppend(handle, opened, state)) return { status: "conflict", reason: "configuration-changed" };
      await appendTail(handle, state);
      if (!await candidateObserved(handle, state)) return { status: "conflict", reason: "configuration-changed" };
      return await acknowledge(opened, state);
    } catch {
      if (appending) unconfirmedWrite = true;
      return appending ? { status: "unknown", reason: "write-unconfirmed" } : { status: "unavailable", reason: "private-state-unavailable" };
    } finally { await closeTarget(handle, appending); }
  }

  async function applyPrepared(opened: PrivateDirectory): Promise<ScienceGatewayProvisionReceipt> {
    const state = await loadState(opened);
    if (!state) return { status: "unavailable", reason: "not-prepared" };
    const current = await readRegular(paths.configFile);
    const comparison = compareState(state, current);
    if (comparison.status !== "prepared") return comparison;
    if (!await runtimeVerified(current.identity)) return { status: "maintenance-required", reason: "runtime-not-verified" };
    const handle = await openRegular(paths.configFile, constants.O_RDWR | constants.O_APPEND);
    return appendPrepared(handle, opened, state);
  }

  async function apply(): Promise<ScienceGatewayProvisionReceipt> {
    if (unconfirmedWrite) return { status: "unknown", reason: "write-unconfirmed" };
    return locked(applyPrepared);
  }

  return { prepare, apply, reconcile };
}
