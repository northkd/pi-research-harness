import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { prepareScienceGatewayConfig } from "./science-gateway-config.js";

const image = "sha256:8e03771cd4846b3f3547ef8b2d60a58f64e80754fccd0f18850da5c649fba323";
const limit = 1024 * 1024;
const placeholder = "science-maintenance-placeholder-00000000000000000000000000000000";
const phases = ["prepared", "stopping", "stopped", "writing", "written", "starting", "started"] as const;
type Phase = typeof phases[number];

export interface ScienceGatewayMaintenanceTarget {
  containerId: string;
  containerName: string;
  imageId: string;
  configFile: string;
  containerConfig: string;
  privateDirectory: string;
  device: string;
  inode: string;
  originalMode: number;
}

export interface ScienceGatewayMaintenanceObservation {
  containerId: string;
  containerName: string;
  imageId: string;
  running: boolean;
  restarting: boolean;
  pid: number;
  mounts: readonly { type: string; source: string; destination: string; readWrite: boolean }[];
  /** Stopped containers have no live PID namespace. These identify the freshly
   * stat'ed host source of the exact inspected single-file mount declaration. */
  boundDevice: string;
  boundInode: string;
}

export interface ScienceGatewayMaintenanceReview {
  readonly schemaVersion: 1;
  readonly target: Readonly<ScienceGatewayMaintenanceTarget>;
  readonly actions: readonly string[];
}

export interface ScienceGatewayMaintenanceReceipt {
  status: "approval-required" | "prepared" | "gateway-started" | "conflict" | "unknown" | "locked";
  reason?: "target-changed" | "private-state-unconfirmed" | "operation-unconfirmed" | "reconciliation-required" | "post-start-validation-required";
  observed?: { config: "original" | "candidate" | "other"; service: "running" | "stopped" | "other" };
}

/** Host capabilities only. No route, generic shell command, receipt-file
 * parser or authority-minting function is exported. Host owns the cooperative
 * maintenance/lifecycle window; the file guard excludes conflicting opens.
 * Neither that guard nor fresh inspect prevents an administrator bypassing the
 * window to start Docker. Observed interference stops all further progression. */
export interface ScienceGatewayMaintenanceLease {
  readonly review: ScienceGatewayMaintenanceReview;
  observe: () => Promise<ScienceGatewayMaintenanceObservation>;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  withExclusiveConfigWindow: (operation: (handle: fs.FileHandle) => Promise<void>) => Promise<void>;
}

interface Host {
  observe: () => Promise<ScienceGatewayMaintenanceObservation>;
  /** Kept only in the host closure. JSON, booleans and serialized copies cannot
   * recreate a key's identity. The module never adds entries to this map. */
  authorizations: WeakMap<object, ScienceGatewayMaintenanceLease>;
  generateKey?: () => string;
}

interface Snapshot {
  bytes: Buffer;
  device: string;
  inode: string;
  mode: number;
}

interface State {
  key: string;
  original: Buffer;
  candidate: Buffer;
  phase: Phase;
}

function refuse(): never { throw new Error("science-maintenance-check-failed"); }
function unknown(reason: ScienceGatewayMaintenanceReceipt["reason"] = "operation-unconfirmed"): ScienceGatewayMaintenanceReceipt {
  return { status: "unknown", reason };
}
function conflict(): ScienceGatewayMaintenanceReceipt { return { status: "conflict", reason: "target-changed" }; }
async function closeQuietly(handle?: fs.FileHandle) { try { await handle?.close(); } catch { /* Fixed receipts only. */ } }
function errno(error: unknown, code: string) {
  try { return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code; }
  catch { return false; }
}

function canonical(value: string) { return typeof value === "string" && path.isAbsolute(value) && path.resolve(value) === value; }

function checkedTarget(input: ScienceGatewayMaintenanceTarget) {
  if (process.platform !== "linux" || !canonical(input.configFile) || !canonical(input.privateDirectory)
    || !/^[a-f0-9]{64}$/.test(input.containerId) || input.containerName !== "cli-proxy-api" || input.imageId !== image
    || input.containerConfig !== "/CLIProxyAPI/config.yaml" || !/^\d+$/.test(input.device) || !/^\d+$/.test(input.inode)
    || input.originalMode !== 0o644) refuse();
  return Object.freeze({
    containerId: input.containerId, containerName: input.containerName, imageId: input.imageId,
    configFile: input.configFile, containerConfig: input.containerConfig, privateDirectory: input.privateDirectory,
    device: input.device, inode: input.inode, originalMode: input.originalMode,
  });
}

async function ancestors(filename: string) {
  if (!canonical(filename)) refuse();
  let current = path.parse(filename).root;
  for (const part of path.dirname(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) refuse();
  }
}

function sameInode(left: { device: string; inode: string }, right: { device: string; inode: string }) {
  return left.device === right.device && left.inode === right.inode;
}

function statIdentity(stat: import("node:fs").BigIntStats) { return { device: String(stat.dev), inode: String(stat.ino) }; }

async function readHandle(handle: fs.FileHandle, modes: readonly number[]) {
  const before = await handle.stat({ bigint: true });
  const mode = Number(before.mode & 0o7777n);
  if (!before.isFile() || before.nlink !== 1n || before.uid !== BigInt(process.getuid!()) || !modes.includes(mode)
    || before.size > BigInt(limit)) refuse();
  const bytes = Buffer.alloc(Number(before.size) + 1);
  let read = 0;
  while (read < bytes.length) {
    const result = await handle.read(bytes, read, bytes.length - read, read);
    if (!result.bytesRead) break;
    read += result.bytesRead;
  }
  const after = await handle.stat({ bigint: true });
  if (read !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) refuse();
  return { bytes: bytes.subarray(0, read), ...statIdentity(after), mode };
}

async function readFile(filename: string, modes: readonly number[], anchored = false): Promise<Snapshot> {
  if (!anchored) await ancestors(filename);
  const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const snapshot = await readHandle(handle, modes);
    const named = await fs.lstat(filename, { bigint: true });
    if (named.isSymbolicLink() || !sameInode(snapshot, statIdentity(named))) refuse();
    return snapshot;
  } finally { await handle.close(); }
}

function validUtf8(bytes: Buffer) { return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes); }

function matchesObservation(value: ScienceGatewayMaintenanceObservation, target: Readonly<ScienceGatewayMaintenanceTarget>) {
  const bindings = value.mounts.filter((entry) => entry.destination === target.containerConfig);
  const mount = bindings[0];
  return value.containerId === target.containerId && value.containerName === target.containerName && value.imageId === target.imageId
    && value.boundDevice === target.device && value.boundInode === target.inode && bindings.length === 1
    && mount?.type === "bind" && mount.source === target.configFile && mount.readWrite === true;
}

function stopped(value: ScienceGatewayMaintenanceObservation) { return value.running === false && value.restarting === false && value.pid === 0; }
function active(value: ScienceGatewayMaintenanceObservation) { return value.running === true && value.restarting === false && value.pid > 0; }

async function requireObservation(lease: Pick<ScienceGatewayMaintenanceLease, "observe">, target: Readonly<ScienceGatewayMaintenanceTarget>, state: "running" | "stopped") {
  const observation = await lease.observe();
  if (!matchesObservation(observation, target) || !(state === "running" ? active(observation) : stopped(observation))) refuse();
}

interface Store {
  handle: fs.FileHandle;
  file: (name: string) => string;
  assertCurrent: () => Promise<void>;
}

function privateDirectory(stat: import("node:fs").BigIntStats) {
  return stat.isDirectory() && stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o7777n) === 0o700n;
}

async function openStore(root: string, create: boolean): Promise<Store> {
  await ancestors(root);
  const parent = await fs.open(path.dirname(root), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let handle: fs.FileHandle | undefined;
  try {
    const anchored = `/proc/self/fd/${parent.fd}/${path.basename(root)}`;
    if (create) {
      try { await fs.mkdir(anchored, { mode: 0o700 }); await parent.sync(); }
      catch (error) { if (!errno(error, "EEXIST")) throw error; }
    }
    handle = await fs.open(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const expected = await handle.stat({ bigint: true });
    if (!privateDirectory(expected)) refuse();
    const pinned = handle;
    const assertCurrent = async () => {
      await ancestors(root);
      const named = await fs.lstat(root, { bigint: true });
      if (!privateDirectory(named) || !sameInode(statIdentity(expected), statIdentity(named))) refuse();
    };
    await assertCurrent();
    return { handle: pinned, file: (name) => `/proc/self/fd/${pinned.fd}/${name}`, assertCurrent };
  } catch (error) { await closeQuietly(handle); throw error; }
  finally { await parent.close(); }
}

async function createPrivate(store: Store, name: string, content: Buffer | string) {
  const handle = await fs.open(store.file(name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.chmod(0o600); await handle.writeFile(content); await handle.sync(); }
  finally { await handle.close(); }
}

async function readPrivate(store: Store, name: string) { return (await readFile(store.file(name), [0o600], true)).bytes; }

async function recordPhase(store: Store, target: Readonly<ScienceGatewayMaintenanceTarget>, phase: Phase, initial = false) {
  await store.assertCurrent();
  const data = JSON.stringify({ schemaVersion: 1, phase, target, originalMode: target.originalMode });
  await createPrivate(store, initial ? "intent.json" : "intent.next", data);
  if (!initial) await fs.rename(store.file("intent.next"), store.file("intent.json"));
  await store.handle.sync();
  await store.assertCurrent();
}

async function loadState(store: Store, target: Readonly<ScienceGatewayMaintenanceTarget>): Promise<State | null> {
  await store.assertCurrent();
  const names = await fs.readdir(store.file("."));
  const records = ["client.key", "original.yaml", "candidate.yaml", "intent.json", "intent.next"];
  if (!names.includes("intent.json")) {
    if (names.some((name) => records.includes(name))) refuse();
    return null;
  }
  if (names.includes("intent.next")) refuse();
  const intent = JSON.parse((await readPrivate(store, "intent.json")).toString("utf8"));
  if (intent.schemaVersion !== 1 || !phases.includes(intent.phase) || !isDeepStrictEqual(intent.target, target) || intent.originalMode !== target.originalMode) refuse();
  const key = (await readPrivate(store, "client.key")).toString("utf8");
  const original = await readPrivate(store, "original.yaml");
  const candidate = await readPrivate(store, "candidate.yaml");
  if (!validUtf8(original) || !validUtf8(candidate) || !/^[A-Za-z0-9_-]{32,128}$/.test(key)
    || prepareScienceGatewayConfig(original.toString("utf8"), key).source !== candidate.toString("utf8")) refuse();
  return { key, original, candidate, phase: intent.phase };
}

async function lockStore(store: Store) {
  const lock = await fs.open(store.file("maintenance.lock"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await lock.sync(); await store.handle.sync(); return lock; }
  catch (error) { await closeQuietly(lock); throw error; }
}

async function releaseLock(store: Store, lock: fs.FileHandle) {
  const held = await lock.stat({ bigint: true });
  const named = await fs.lstat(store.file("maintenance.lock"), { bigint: true });
  if (!sameInode(statIdentity(held), statIdentity(named))) refuse();
  await fs.unlink(store.file("maintenance.lock"));
  await store.handle.sync();
}

function sourceMatches(snapshot: Snapshot, target: Readonly<ScienceGatewayMaintenanceTarget>, bytes: Buffer, mode: number) {
  return sameInode(snapshot, target) && snapshot.mode === mode && snapshot.bytes.equals(bytes);
}

function expectedIntermediate(state: State, written: number) {
  const expected = Buffer.alloc(Math.max(state.original.length, written));
  state.original.copy(expected);
  state.candidate.copy(expected, 0, 0, written);
  return expected;
}

function observedConfig(snapshot: Snapshot, state: State): "original" | "candidate" | "other" {
  if (snapshot.bytes.equals(state.original)) return "original";
  return snapshot.bytes.equals(state.candidate) ? "candidate" : "other";
}

function observedService(observation: ScienceGatewayMaintenanceObservation): "running" | "stopped" | "other" {
  if (active(observation)) return "running";
  return stopped(observation) ? "stopped" : "other";
}

/** Importing does not observe Docker, read configuration or start a service.
 * All calls in tests use an isolated fake host. Production authorization and
 * an exclusive host adapter remain external prerequisites. */
export function createScienceGatewayMaintenance(input: ScienceGatewayMaintenanceTarget, host: Host) {
  const target = checkedTarget(input);
  const review: ScienceGatewayMaintenanceReview = Object.freeze({
    schemaVersion: 1, target,
    actions: Object.freeze(["stop-exact-container", "chmod-config-0644-to-0600", "write-approved-key-and-alias", "verify-and-start-exact-container"]),
  });
  const generateKey = host.generateKey ?? (() => randomBytes(32).toString("hex"));
  let uncertain = false;

  async function observedState(store: Store, state: State): Promise<ScienceGatewayMaintenanceReceipt> {
    const observation = await host.observe();
    const snapshot = await readFile(target.configFile, [0o644, 0o600]);
    if (!matchesObservation(observation, target) || !sameInode(snapshot, target)) return conflict();
    const config = observedConfig(snapshot, state);
    const service = observedService(observation);
    await store.assertCurrent();
    const prepared = state.phase === "prepared" && config === "original" && snapshot.mode === target.originalMode;
    return { status: prepared ? "prepared" : "unknown", ...(prepared ? {} : { reason: "reconciliation-required" as const }), observed: { config, service } };
  }

  async function existingPreparation(): Promise<ScienceGatewayMaintenanceReceipt | null> {
    let store: Store | undefined;
    try {
      store = await openStore(target.privateDirectory, false);
      const state = await loadState(store, target);
      if (!state) return null;
      const result = await observedState(store, state);
      return result.status === "prepared" ? { status: "prepared" } : result;
    } catch (error) {
      return errno(error, "ENOENT") ? null : unknown("private-state-unconfirmed");
    } finally { await closeQuietly(store?.handle); }
  }

  async function preparationSource() {
    const observation = await host.observe();
    const snapshot = await readFile(target.configFile, [target.originalMode]);
    if (!matchesObservation(observation, target) || !sameInode(snapshot, target) || !validUtf8(snapshot.bytes)) refuse();
    const planning = prepareScienceGatewayConfig(snapshot.bytes.toString("utf8"), placeholder);
    if (!planning.addedKey || !planning.addedAlias || Buffer.byteLength(planning.source, "utf8") > limit) refuse();
    return snapshot;
  }

  async function stagePreparation(store: Store, original: Snapshot) {
    const existing = await loadState(store, target);
    if (existing) {
      if ((await observedState(store, existing)).status !== "prepared") refuse();
      return;
    }
    const fresh = await preparationSource();
    if (!sourceMatches(fresh, target, original.bytes, target.originalMode)) refuse();
    const key = generateKey();
    const prepared = prepareScienceGatewayConfig(original.bytes.toString("utf8"), key);
    if (!prepared.addedKey || !prepared.addedAlias || Buffer.byteLength(prepared.source, "utf8") > limit) refuse();
    const candidate = prepared.source;
    await createPrivate(store, "client.key", key);
    await createPrivate(store, "original.yaml", original.bytes);
    await createPrivate(store, "candidate.yaml", candidate);
    await recordPhase(store, target, "prepared", true);
  }

  async function prepare(): Promise<ScienceGatewayMaintenanceReceipt> {
    if (uncertain) return unknown("private-state-unconfirmed");
    const previous = await existingPreparation();
    if (previous) return previous;
    let original: Snapshot;
    try { original = await preparationSource(); } catch { return conflict(); }
    let store: Store | undefined;
    let lock: fs.FileHandle | undefined;
    try {
      store = await openStore(target.privateDirectory, true);
      lock = await lockStore(store);
      await stagePreparation(store, original);
      await releaseLock(store, lock);
      return { status: "prepared" };
    } catch (error) {
      if (!lock && errno(error, "EEXIST")) return { status: "locked" };
      uncertain = true;
      return unknown("private-state-unconfirmed");
    } finally { await closeQuietly(lock); await closeQuietly(store?.handle); }
  }

  function authorized(receipt: unknown) {
    if (typeof receipt !== "object" || receipt === null) return null;
    try {
      const lease = host.authorizations.get(receipt);
      if (lease?.review !== review) return null;
      const controls = [lease.observe, lease.stop, lease.start, lease.withExclusiveConfigWindow];
      return controls.every((control) => typeof control === "function") ? lease : null;
    } catch { return null; }
  }

  async function originalBeforeStop(state: State, lease: ScienceGatewayMaintenanceLease) {
    await requireObservation(lease, target, "running");
    const snapshot = await readFile(target.configFile, [target.originalMode]);
    if (!sourceMatches(snapshot, target, state.original, target.originalMode)) refuse();
  }

  async function stopExact(store: Store, state: State, lease: ScienceGatewayMaintenanceLease) {
    await recordPhase(store, target, "stopping");
    await originalBeforeStop(state, lease);
    await store.assertCurrent();
    await lease.stop();
    await requireObservation(lease, target, "stopped");
    await recordPhase(store, target, "stopped");
  }

  async function requireBytes(handle: fs.FileHandle, expected: Buffer, mode: number) {
    const opened = await readHandle(handle, [mode]);
    // Opening the same pathname again would break our own Linux write lease.
    // Read bytes through the inherited OFD; lstat only verifies the bound name.
    const named = await fs.lstat(target.configFile, { bigint: true });
    if (!sourceMatches(opened, target, expected, mode) || named.isSymbolicLink()
      || !sameInode(opened, statIdentity(named)) || Number(named.mode & 0o7777n) !== mode) refuse();
  }

  async function rewrite(handle: fs.FileHandle, state: State, lease: ScienceGatewayMaintenanceLease) {
    let written = 0;
    while (written < state.candidate.length) {
      await requireObservation(lease, target, "stopped");
      await requireBytes(handle, expectedIntermediate(state, written), 0o600);
      const result = await handle.write(state.candidate, written, state.candidate.length - written, written);
      if (!result.bytesWritten || result.bytesWritten > state.candidate.length - written) refuse();
      written += result.bytesWritten;
    }
    await handle.sync();
    await requireBytes(handle, state.candidate, 0o600);
    const prepared = prepareScienceGatewayConfig(state.original.toString("utf8"), state.key).source;
    if (prepared !== state.candidate.toString("utf8")) refuse();
  }

  async function writeStopped(store: Store, state: State, lease: ScienceGatewayMaintenanceLease) {
    await requireObservation(lease, target, "stopped");
    await recordPhase(store, target, "writing");
    let invoked = false;
    let completed = false;
    await lease.withExclusiveConfigWindow(async (handle) => {
      if (invoked) refuse();
      invoked = true;
      await requireObservation(lease, target, "stopped");
      await requireBytes(handle, state.original, target.originalMode);
      await store.assertCurrent();
      await handle.chmod(0o600);
      await handle.sync();
      await rewrite(handle, state, lease);
      await requireObservation(lease, target, "stopped");
      await recordPhase(store, target, "written");
      completed = true;
    });
    if (!completed) refuse();
  }

  async function requireCandidate(state: State) {
    const snapshot = await readFile(target.configFile, [0o600]);
    if (!sourceMatches(snapshot, target, state.candidate, 0o600)) refuse();
  }

  async function readyToStart(store: Store, state: State, lease: ScienceGatewayMaintenanceLease) {
    await requireObservation(lease, target, "stopped");
    await requireCandidate(state);
    await store.assertCurrent();
  }

  async function startExact(store: Store, state: State, lease: ScienceGatewayMaintenanceLease) {
    await readyToStart(store, state, lease);
    await recordPhase(store, target, "starting");
    await readyToStart(store, state, lease);
    await lease.start();
    await requireObservation(lease, target, "running");
    await requireCandidate(state);
    await recordPhase(store, target, "started");
    await requireObservation(lease, target, "running");
    await requireCandidate(state);
  }

  async function applyPrepared(store: Store, lease: ScienceGatewayMaintenanceLease): Promise<ScienceGatewayMaintenanceReceipt> {
    const state = await loadState(store, target);
    if (state?.phase !== "prepared") return unknown("reconciliation-required");
    try { await originalBeforeStop(state, lease); } catch { return conflict(); }
    uncertain = true; // Every later interruption may include chmod or service control.
    await stopExact(store, state, lease);
    await writeStopped(store, state, lease);
    await startExact(store, state, lease);
    uncertain = false;
    return { status: "gateway-started", reason: "post-start-validation-required" };
  }

  async function apply(receipt?: unknown): Promise<ScienceGatewayMaintenanceReceipt> {
    const lease = authorized(receipt);
    if (!lease) return { status: "approval-required" };
    if (uncertain) return unknown();
    let store: Store | undefined;
    let lock: fs.FileHandle | undefined;
    try {
      store = await openStore(target.privateDirectory, false);
      if ((await loadState(store, target))?.phase !== "prepared") return unknown("reconciliation-required");
      lock = await lockStore(store);
      const result = await applyPrepared(store, lease);
      if (result.status !== "unknown") await releaseLock(store, lock);
      return result;
    } catch (error) {
      if (!lock && errno(error, "EEXIST")) return { status: "locked" };
      uncertain = true;
      return unknown();
    } finally { await closeQuietly(lock); await closeQuietly(store?.handle); }
  }

  async function reconcile(): Promise<ScienceGatewayMaintenanceReceipt> {
    let store: Store | undefined;
    try {
      store = await openStore(target.privateDirectory, false);
      const state = await loadState(store, target);
      return state ? await observedState(store, state) : unknown("reconciliation-required");
    } catch { return unknown("reconciliation-required"); }
    finally { await closeQuietly(store?.handle); }
  }

  return { review: () => review, prepare, apply, reconcile };
}
