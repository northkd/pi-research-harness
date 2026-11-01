import { execFile } from "node:child_process";
import type { BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import { withScienceGatewayFileWindow } from "./science-gateway-file-window.js";
import type { ScienceGatewayMaintenanceLease, ScienceGatewayMaintenanceObservation, ScienceGatewayMaintenanceReview, ScienceGatewayMaintenanceTarget } from "./science-gateway-maintenance.js";

const image = "sha256:8e03771cd4846b3f3547ef8b2d60a58f64e80754fccd0f18850da5c649fba323";
const metadataLimit = 65536;
const sourceLimit = 1024 * 1024;
const actions = ["stop-exact-container", "chmod-config-0644-to-0600", "write-approved-key-and-alias", "verify-and-start-exact-container"];
const targetKeys = ["containerId", "containerName", "imageId", "configFile", "containerConfig", "privateDirectory", "device", "inode", "originalMode"];

// Enumerate public fields rather than serializing Docker's Config/State: those
// objects can contain environment credentials or arbitrary daemon error text.
const inspectFormat = '{"containerId":{{json .Id}},"containerName":{{json .Name}},"imageId":{{json .Image}},'
  + '"running":{{json .State.Running}},"restarting":{{json .State.Restarting}},"paused":{{json .State.Paused}},'
  + '"dead":{{json .State.Dead}},"status":{{json .State.Status}},"pid":{{json .State.Pid}},'
  + '"stopTimeout":{{json (index .Config "StopTimeout")}},"mounts":[{{range $i, $mount := .Mounts}}{{if $i}},{{end}}'
  + '{"type":{{json $mount.Type}},"source":{{json $mount.Source}},"destination":{{json $mount.Destination}},"readWrite":{{json $mount.RW}}}{{end}}]}';

type FailureCode = "science-docker-invalid-target" | "science-docker-unsafe-client-config" | "science-docker-inspection-unavailable"
  | "science-docker-target-changed" | "science-docker-state-unavailable" | "science-docker-stop-timeout-unsupported" | "science-docker-operation-unconfirmed";

class HostFailure extends Error {
  readonly code: FailureCode;
  constructor(code: FailureCode) { super(code); this.code = code; this.name = "ScienceGatewayDockerHostError"; }
}

export interface ScienceGatewayDockerHost {
  observe: () => Promise<ScienceGatewayMaintenanceObservation>;
  readonly lease: ScienceGatewayMaintenanceLease;
}

interface Inspected {
  observation: ScienceGatewayMaintenanceObservation;
  source: BigIntStats;
  mode: number;
  stopTimeout: unknown;
}

function fail(code: FailureCode): never { throw new HostFailure(code); }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errno(error: unknown, code: string) { return record(error) && error.code === code; }
function canonical(value: unknown): value is string {
  return typeof value === "string" && value.length <= 4096 && !value.includes("\0") && path.isAbsolute(value) && path.resolve(value) === value;
}
function exactKeys(value: object, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && Object.hasOwn(descriptor, "value");
  });
}
function exactActions(value: unknown) {
  return Array.isArray(value) && Object.isFrozen(value) && value.length === actions.length
    && actions.every((action, index) => Object.getOwnPropertyDescriptor(value, String(index))?.value === action);
}

function checkedTarget(review: ScienceGatewayMaintenanceReview): Readonly<ScienceGatewayMaintenanceTarget> {
  try {
    if (process.platform !== "linux" || !record(review) || !Object.isFrozen(review) || !exactKeys(review, ["schemaVersion", "target", "actions"])
      || review.schemaVersion !== 1 || !exactActions(review.actions)) fail("science-docker-invalid-target");
    const target = review.target;
    if (!record(target) || !Object.isFrozen(target) || !exactKeys(target, targetKeys)
      || !canonical(target.configFile) || !canonical(target.privateDirectory)) fail("science-docker-invalid-target");
    if (!/^[a-f0-9]{64}$/.test(target.containerId) || target.containerName !== "cli-proxy-api" || target.imageId !== image
      || target.containerConfig !== "/CLIProxyAPI/config.yaml" || typeof target.device !== "string" || typeof target.inode !== "string"
      || !/^\d{1,20}$/.test(target.device) || !/^\d{1,20}$/.test(target.inode)
      || target.originalMode !== 0o644) fail("science-docker-invalid-target");
    return target;
  } catch { return fail("science-docker-invalid-target"); }
}

async function directories(filename: string, allowMissing = false) {
  let current = path.parse(filename).root;
  for (const part of path.dirname(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("science-docker-target-changed");
    } catch (error) {
      if (allowMissing && errno(error, "ENOENT")) return;
      throw error;
    }
  }
}

async function safeClientConfig(target: Readonly<ScienceGatewayMaintenanceTarget>) {
  try {
    await directories(path.join(target.privateDirectory, "config.json"), true);
    try {
      const stat = await fs.lstat(target.privateDirectory, { bigint: true });
      if (!stat.isDirectory() || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7777n) !== 0o700n) fail("science-docker-unsafe-client-config");
    } catch (error) { if (!errno(error, "ENOENT")) throw error; }
    try { await fs.lstat(path.join(target.privateDirectory, "config.json")); }
    catch (error) { if (errno(error, "ENOENT")) return; throw error; }
  } catch { return fail("science-docker-unsafe-client-config"); }
  fail("science-docker-unsafe-client-config");
}

async function sourceMetadata(target: Readonly<ScienceGatewayMaintenanceTarget>) {
  try {
    await directories(target.configFile);
    const stat = await fs.lstat(target.configFile, { bigint: true });
    const mode = Number(stat.mode & 0o7777n);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n || stat.uid !== BigInt(process.getuid!())
      || ![0o600, target.originalMode].includes(mode) || stat.size > BigInt(sourceLimit)
      || String(stat.dev) !== target.device || String(stat.ino) !== target.inode) fail("science-docker-target-changed");
    return stat;
  } catch { return fail("science-docker-target-changed"); }
}

function unchangedSource(before: BigIntStats, after: BigIntStats) {
  return before.dev === after.dev && before.ino === after.ino && before.mode === after.mode && before.size === after.size
    && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs;
}

function command(target: Readonly<ScienceGatewayMaintenanceTarget>, args: string[], timeout: number, code: FailureCode): Promise<string> {
  return new Promise((resolve, reject) => {
    try {
      execFile("/usr/bin/docker", ["--host", "unix:///var/run/docker.sock", "--config", target.privateDirectory, ...args], {
        encoding: "utf8", shell: false, maxBuffer: metadataLimit, timeout,
        env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
      }, (error, stdout) => {
        if (error || typeof stdout !== "string" || Buffer.byteLength(stdout, "utf8") > metadataLimit) reject(new HostFailure(code));
        else resolve(stdout);
      });
    } catch { reject(new HostFailure(code)); }
  });
}

function parseMetadata(stdout: string) {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!record(value)) fail("science-docker-inspection-unavailable");
    return value;
  } catch { return fail("science-docker-inspection-unavailable"); }
}

function targetMount(value: Record<string, unknown>, target: Readonly<ScienceGatewayMaintenanceTarget>) {
  if (!Array.isArray(value.mounts) || value.mounts.length > 128) fail("science-docker-target-changed");
  const matches = value.mounts.filter((entry: unknown) => record(entry) && entry.destination === target.containerConfig);
  const mount: unknown = matches[0];
  if (matches.length !== 1 || !record(mount) || mount.type !== "bind" || mount.source !== target.configFile || mount.readWrite !== true) fail("science-docker-target-changed");
  return { type: "bind", source: target.configFile, destination: target.containerConfig, readWrite: true };
}

function runtime(value: Record<string, unknown>) {
  if (typeof value.running !== "boolean" || value.restarting !== false || value.paused !== false || value.dead !== false
    || typeof value.pid !== "number" || !Number.isSafeInteger(value.pid)) fail("science-docker-state-unavailable");
  const expected = value.running ? value.status === "running" && value.pid > 0 : value.status === "exited" && value.pid === 0;
  if (!expected) fail("science-docker-state-unavailable");
  return { running: value.running, restarting: false, pid: value.pid };
}

function observation(value: Record<string, unknown>, target: Readonly<ScienceGatewayMaintenanceTarget>): ScienceGatewayMaintenanceObservation {
  if (value.containerId !== target.containerId || value.containerName !== `/${target.containerName}` || value.imageId !== target.imageId) fail("science-docker-target-changed");
  const mount = targetMount(value, target);
  return {
    containerId: target.containerId, containerName: target.containerName, imageId: target.imageId,
    ...runtime(value), mounts: [mount], boundDevice: target.device, boundInode: target.inode,
  };
}

function stopBudget(value: unknown) {
  // Do not turn a missing daemon StopTimeout into a new stop/kill duration.
  // A client deadline only bounds waiting; expiry leaves the outcome unknown.
  if (value === undefined || value === null) return 60000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 300) fail("science-docker-stop-timeout-unsupported");
  return (value + 15) * 1000;
}

function requireState(value: Inspected, running: boolean) {
  if (value.observation.running !== running) fail("science-docker-state-unavailable");
}

function controlBudget(value: Inspected, target: Readonly<ScienceGatewayMaintenanceTarget>, action: "stop" | "start") {
  requireState(value, action === "stop");
  const mode = action === "stop" ? target.originalMode : 0o600;
  if (value.mode !== mode) fail("science-docker-target-changed");
  return action === "stop" ? stopBudget(value.stopTimeout) : 60000;
}

/** Lazy host capabilities bound to this exact frozen review object. Construction
 * grants no approval and never writes the controller's private authorization
 * WeakMap. The caller must separately authorize and own its maintenance.lock.
 * Fresh metadata checks detect observed interference in that cooperative
 * window; they do not fence an administrator starting Docker outside it. */
export function createScienceGatewayDockerHost(review: ScienceGatewayMaintenanceReview): ScienceGatewayDockerHost {
  const target = checkedTarget(review);
  let unconfirmed = false;

  async function inspect(): Promise<Inspected> {
    await safeClientConfig(target);
    const before = await sourceMetadata(target);
    const value = parseMetadata(await command(target, ["inspect", "--type", "container", "--format", inspectFormat, target.containerId], 15000, "science-docker-inspection-unavailable"));
    const observed = observation(value, target);
    const after = await sourceMetadata(target);
    if (!unchangedSource(before, after)) fail("science-docker-target-changed");
    return { observation: observed, source: after, mode: Number(after.mode & 0o7777n), stopTimeout: value.stopTimeout };
  }

  async function observe() { return (await inspect()).observation; }

  async function control(action: "stop" | "start") {
    if (unconfirmed) fail("science-docker-operation-unconfirmed");
    const current = await inspect();
    const timeout = controlBudget(current, target, action);
    if (unconfirmed) fail("science-docker-operation-unconfirmed");
    unconfirmed = true;
    try {
      // Manual Docker stop suppresses restart-policy restarts; no policy edit,
      // extra kill timeout, recreate, fallback or retry is issued here.
      const stdout = await command(target, [action, target.containerId], timeout, "science-docker-operation-unconfirmed");
      if (stdout.trim() !== target.containerId) fail("science-docker-operation-unconfirmed");
      const confirmed = await inspect();
      requireState(confirmed, action === "start");
      if (!unchangedSource(current.source, confirmed.source)) fail("science-docker-operation-unconfirmed");
      unconfirmed = false;
    } catch { return fail("science-docker-operation-unconfirmed"); }
  }

  async function stopped() {
    if (unconfirmed) fail("science-docker-operation-unconfirmed");
    requireState(await inspect(), false);
  }

  async function withExclusiveConfigWindow(operation: (handle: fs.FileHandle) => Promise<void>) {
    await stopped();
    try {
      await withScienceGatewayFileWindow({ configFile: target.configFile, device: target.device, inode: target.inode }, async handle => {
        await stopped();
        await operation(handle);
        await stopped();
      });
      await stopped();
    } catch { unconfirmed = true; return fail("science-docker-operation-unconfirmed"); }
  }

  const lease: ScienceGatewayMaintenanceLease = Object.freeze({ review, observe, stop: () => control("stop"), start: () => control("start"), withExclusiveConfigWindow });
  return Object.freeze({ observe, lease });
}
