/** A root-installed, short-lived marker only suppresses the old unit's replacement CLI. */
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export const MANAGED_RELEASE_UNIT = "pi-research-dashboard.service";
export const MANAGED_RELEASE_CGROUP = "/user.slice/user-1000.slice/user@1000.service/app.slice/pi-research-dashboard.service";
export const MANAGED_RELEASE_MARKER = "/run/pi-research-dashboard-release/restart.json";
export interface ManagedReleaseMarker {
  schemaVersion: 1; releaseId: string; unit: typeof MANAGED_RELEASE_UNIT; cgroup: typeof MANAGED_RELEASE_CGROUP;
  invocationId: string; oldMainPid: number; oldMainStartTicks: string; oldServerPid: number; oldServerStartTicks: string;
  createdAtMs: number; expiresAtMs: number;
}
/** Trusted code/test IO only. Never reconstructed from marker/project JSON. */
export interface ManagedReleaseLaunchIo {
  invocationId(): string | undefined;
  pid(): number;
  cgroup(): string;
  readRootMarker(): unknown | null;
  startTicks(pid: number): string | null;
  now(): number;
}
function fail(): never { throw new Error("managed-dashboard-launch-refused"); }
const HEX = /^[0-9a-f]{32}$/;
const DECIMAL = /^[1-9][0-9]{0,19}$/;
const pid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value <= 2147483647;
const ticks = (value: unknown): value is string => typeof value === "string" && DECIMAL.test(value) && BigInt(value) <= (1n << 64n) - 1n;
function parseMarker(value: unknown): ManagedReleaseMarker {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>, keys = ["schemaVersion", "releaseId", "unit", "cgroup", "invocationId", "oldMainPid", "oldMainStartTicks", "oldServerPid", "oldServerStartTicks", "createdAtMs", "expiresAtMs"];
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) fail();
  if (row.schemaVersion !== 1 || row.unit !== MANAGED_RELEASE_UNIT || row.cgroup !== MANAGED_RELEASE_CGROUP || typeof row.releaseId !== "string" || !HEX.test(row.releaseId) || typeof row.invocationId !== "string" || !HEX.test(row.invocationId)) fail();
  if (!pid(row.oldMainPid) || !pid(row.oldServerPid) || row.oldMainPid === row.oldServerPid || !ticks(row.oldMainStartTicks) || !ticks(row.oldServerStartTicks)) fail();
  if (!Number.isSafeInteger(row.createdAtMs) || !Number.isSafeInteger(row.expiresAtMs) || (row.createdAtMs as number) < 0 || (row.expiresAtMs as number) <= (row.createdAtMs as number) || (row.expiresAtMs as number) - (row.createdAtMs as number) > 120000) fail();
  return Object.freeze({ ...row }) as unknown as ManagedReleaseMarker;
}
function bounded(path: string, limit: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const bytes = Buffer.alloc(limit + 1); let size = 0;
    while (size <= limit) { const count = readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count; }
    if (size > limit) fail(); return bytes.subarray(0, size).toString("utf8");
  } finally { closeSync(fd); }
}
function rootDirectory(path: string) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0) fail();
}
function stamp(value: NonNullable<ReturnType<typeof lstatSync>>): string { return [value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode, value.uid, value.gid, value.nlink].join(":"); }
function readRootMarker(): unknown | null {
  try { lstatSync(MANAGED_RELEASE_MARKER); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  rootDirectory("/run"); rootDirectory("/run/pi-research-dashboard-release");
  const before = lstatSync(MANAGED_RELEASE_MARKER);
  if (!before.isFile() || before.isSymbolicLink() || before.uid !== 0 || before.gid !== 0 || before.nlink !== 1 || (before.mode & 0o7777) !== 0o444 || before.size > 8192) fail();
  const fd = openSync(MANAGED_RELEASE_MARKER, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (stamp(fstatSync(fd)) !== stamp(before)) fail();
    const bytes = Buffer.alloc(8193); let size = 0;
    while (size < bytes.length) { const count = readSync(fd, bytes, size, bytes.length - size, size); if (!count) break; size += count; }
    if (size > 8192 || stamp(fstatSync(fd)) !== stamp(before) || stamp(lstatSync(MANAGED_RELEASE_MARKER)) !== stamp(before)) fail();
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally { closeSync(fd); }
}
function startTicks(selected: number): string | null {
  let text: string;
  try { text = bounded(`/proc/${selected}/stat`, 16384); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return null; throw error; }
  const end = text.lastIndexOf(")"), fields = text.slice(end + 2).trim().split(/\s+/);
  if (!text.startsWith(`${selected} (`) || end < 0 || !ticks(fields[19])) fail(); return fields[19];
}
const nodeIo: ManagedReleaseLaunchIo = {
  invocationId: () => process.env.INVOCATION_ID, pid: () => process.pid,
  cgroup: () => bounded("/proc/self/cgroup", 16384).trim(), readRootMarker, startTicks, now: () => Date.now(),
};

/** False/absent means ordinary startup. True exits this new CLI before any server/Pi cleanup. */
export function suppressManagedDashboardLaunch(io: ManagedReleaseLaunchIo = nodeIo): boolean {
  const invocation = io.invocationId();
  if (typeof invocation !== "string" || !HEX.test(invocation)) return false;
  if (io.cgroup() !== `0::${MANAGED_RELEASE_CGROUP}`) return false;
  const raw = io.readRootMarker(); if (raw === null) return false;
  const marker = parseMarker(raw); if (invocation !== marker.invocationId) return false;
  const now = io.now(), self = io.pid(), current = io.startTicks(self);
  if (!Number.isSafeInteger(now) || now < marker.createdAtMs || now >= marker.expiresAtMs || !pid(self) || self === marker.oldMainPid || self === marker.oldServerPid || current === null || !ticks(current)) fail();
  if (BigInt(current) <= BigInt(marker.oldMainStartTicks) || BigInt(current) <= BigInt(marker.oldServerStartTicks)) fail();
  for (const [selected, expected] of [[marker.oldMainPid, marker.oldMainStartTicks], [marker.oldServerPid, marker.oldServerStartTicks]] as const) {
    const actual = io.startTicks(selected); if (actual !== null && actual !== expected) fail();
  }
  // Main's next unit start carries a fresh InvocationID, so it bypasses this old-generation suppression.
  return true;
}
