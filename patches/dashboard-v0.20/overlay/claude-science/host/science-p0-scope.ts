import type { BigIntStats } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname } from "node:path";
import { inspect, TextDecoder } from "node:util";

const AUTHORITY = "/var/lib/pi-claude-science-viewer-authority/p0-binding.json";
const NATIVE_BASE = "/var/lib/pi-claude-science";
const CHECKPOINT = "/var/lib/pi-claude-science/home/.local/state/pi-science-p0/checkpoint.json";
const HOME = "/var/lib/pi-claude-science/home";
const CWD = "/home/example/.local/share/pi-research/dashboard-ui/claude-science/qa/synthetic-workspace";
const OWNER = JSON.stringify(["host", "inert-operator"]);
const REQUEST_HASH = "cdde40745c26fab81103b2d29619ed6766777a35b23717ee6e46d7ec4842b690";
const ERROR_CODE = "science-p0-scope-unavailable";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ScienceP0FileStamp {
  kind: "file" | "directory" | "other";
  dev: bigint; ino: bigint; uid: number; gid: number; mode: number; nlink: number;
  size: number; mtimeNs: bigint; ctimeNs: bigint;
}

/** Trusted host-side test seam. No client or project configuration is accepted. */
export interface ScienceP0ScopeIo {
  lstat(path: string): Promise<ScienceP0FileStamp>;
  realpath(path: string): Promise<string>;
  open(path: string): Promise<{
    stat(): Promise<ScienceP0FileStamp>;
    read(offset: number, length: number): Promise<Uint8Array>;
    close(): Promise<void>;
  }>;
}

interface Descriptor {
  schemaVersion: 1; runId: string; intentId: string; projectId: string;
  rootFrameId: string; frameId: string; requestSha256: string;
}

export interface SyntheticP0Scope {
  scope: {
    partition: Readonly<{ ownerKey: string; cwd: string }>;
    binding: Readonly<{ projectId: string; taskId: string; rootFrameId: string; frameId: string }>;
    revalidate(): Promise<void>;
  };
  expectedVisibleProjectName: string;
}

class ScopeUnavailable extends Error {
  constructor() { super(ERROR_CODE); this.name = ERROR_CODE; }
  [inspect.custom]() { return ERROR_CODE; }
  toJSON() { return { code: ERROR_CODE }; }
}

function fail(): never { throw new ScopeUnavailable(); }

function privateValue<T extends object>(value: T): Readonly<T> {
  Object.defineProperties(value, {
    toJSON: { value: () => "science-p0-private" },
    [inspect.custom]: { value: () => "science-p0-private" },
  });
  return Object.freeze(value);
}

function sameIdentity(left: ScienceP0FileStamp, right: ScienceP0FileStamp): boolean {
  return left.kind === right.kind && left.dev === right.dev && left.ino === right.ino &&
    left.uid === right.uid && left.gid === right.gid && left.mode === right.mode && left.nlink === right.nlink;
}

function sameFile(left: ScienceP0FileStamp, right: ScienceP0FileStamp): boolean {
  return sameIdentity(left, right) && left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function directoryPaths(target: string): string[] {
  const paths = [target];
  while (paths[0] !== "/") paths.unshift(dirname(paths[0]));
  return paths;
}

function controlledRoot(stamp: ScienceP0FileStamp): boolean {
  return stamp.uid === 0 && (stamp.gid === 0 || stamp.gid === 1000) && (stamp.mode & 0o7022) === 0;
}

function controlledUser(stamp: ScienceP0FileStamp): boolean {
  return stamp.uid === 1000 && stamp.gid === 1000 && (stamp.mode & 0o7022) === 0;
}

function checkpointDirectoryAllowed(path: string, stamp: ScienceP0FileStamp): boolean {
  if (path === NATIVE_BASE && controlledUser(stamp) && stamp.mode === 0o700) return true;
  const user = path === HOME || path.startsWith(`${HOME}/`);
  return (user ? controlledUser(stamp) : controlledRoot(stamp)) && (path !== dirname(CHECKPOINT) || stamp.mode === 0o700);
}

function directoryAllowed(path: string, stamp: ScienceP0FileStamp, kind: "authority" | "checkpoint" | "workspace"): boolean {
  if (stamp.kind !== "directory") return false;
  if (kind === "authority") return controlledRoot(stamp) && (path !== dirname(AUTHORITY) || (stamp.gid === 1000 && stamp.mode === 0o750));
  if (kind === "checkpoint") return checkpointDirectoryAllowed(path, stamp);
  const controlled = controlledRoot(stamp) || (stamp.uid === 1000 && [1000, 1001].includes(stamp.gid) && (stamp.mode & 0o7022) === 0);
  return controlled && (path !== CWD || controlledUser(stamp));
}

async function directoryChain(io: ScienceP0ScopeIo, target: string, kind: "authority" | "checkpoint" | "workspace"): Promise<ScienceP0FileStamp[]> {
  const stamps: ScienceP0FileStamp[] = [];
  for (const path of directoryPaths(target)) {
    const stamp = await io.lstat(path);
    if (!directoryAllowed(path, stamp, kind)) fail();
    stamps.push(stamp);
  }
  if (await io.realpath(target) !== target) fail();
  return stamps;
}

function sameChain(before: ScienceP0FileStamp[], after: ScienceP0FileStamp[]): boolean {
  return before.length === after.length && before.every((stamp, index) => {
    const current = after[index];
    return stamp.kind === current.kind && stamp.dev === current.dev && stamp.ino === current.ino &&
      stamp.uid === current.uid && stamp.gid === current.gid && stamp.mode === current.mode;
  });
}

function fileAllowed(stamp: ScienceP0FileStamp, authority: boolean): boolean {
  return stamp.kind === "file" && stamp.uid === (authority ? 0 : 1000) && stamp.gid === 1000 &&
    stamp.mode === (authority ? 0o440 : 0o600) && stamp.nlink === 1 && Number.isSafeInteger(stamp.size) && stamp.size > 0 && stamp.size <= 1024;
}

async function boundedRead(handle: Awaited<ReturnType<ScienceP0ScopeIo["open"]>>, expectedSize: number): Promise<Uint8Array> {
  const bytes = new Uint8Array(1025);
  let offset = 0;
  while (offset < bytes.length) {
    const chunk = await handle.read(offset, bytes.length - offset);
    if (chunk.length === 0) break;
    if (chunk.length > bytes.length - offset) fail();
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  if (offset !== expectedSize || offset > 1024) fail();
  return bytes.slice(0, offset);
}

async function verifiedJson(io: ScienceP0ScopeIo, authority: boolean): Promise<unknown> {
  const path = authority ? AUTHORITY : CHECKPOINT;
  const kind = authority ? "authority" : "checkpoint";
  const beforeDirs = await directoryChain(io, dirname(path), kind);
  const before = await io.lstat(path);
  if (!fileAllowed(before, authority)) fail();
  const handle = await io.open(path);
  try {
    const opened = await handle.stat();
    if (!sameFile(before, opened)) fail();
    const bytes = await boundedRead(handle, opened.size);
    if (!sameFile(opened, await handle.stat()) || !sameFile(opened, await io.lstat(path))) fail();
    if (!sameChain(beforeDirs, await directoryChain(io, dirname(path), kind))) fail();
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } finally { await handle.close(); }
}

function exactObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail();
  const object = value as Record<string, unknown>;
  const actual = Object.keys(object);
  if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(object, key))) fail();
  return object;
}

function parseDescriptor(value: unknown): Descriptor {
  const object = exactObject(value, ["schemaVersion", "runId", "intentId", "projectId", "rootFrameId", "frameId", "requestSha256"]);
  if (object.schemaVersion !== 1 || object.requestSha256 !== REQUEST_HASH) fail();
  if (typeof object.runId !== "string" || !/^[0-9a-f]{32}$/.test(object.runId)) fail();
  if (typeof object.intentId !== "string" || !UUID.test(object.intentId)) fail();
  if (typeof object.projectId !== "string" || !/^proj_[0-9a-f]{12}$/.test(object.projectId)) fail();
  if (typeof object.rootFrameId !== "string" || !UUID.test(object.rootFrameId) || object.frameId !== object.rootFrameId) fail();
  return object as unknown as Descriptor;
}

function checkCheckpoint(value: unknown, descriptor: Descriptor): void {
  const object = exactObject(value, ["schema", "run_id", "intent_id", "request_sha256", "project_id", "frame_id", "creation_attempted", "submission_attempted", "cancel_attempted", "approval_attempted"]);
  if (object.schema !== 1 || object.run_id !== descriptor.runId || object.intent_id !== descriptor.intentId || object.request_sha256 !== REQUEST_HASH) fail();
  if (object.project_id !== descriptor.projectId || object.frame_id !== descriptor.rootFrameId) fail();
  if (object.creation_attempted !== true || object.submission_attempted !== true || object.cancel_attempted !== false || typeof object.approval_attempted !== "boolean") fail();
}

function sameDescriptor(left: Descriptor, right: Descriptor): boolean {
  return left.runId === right.runId && left.intentId === right.intentId && left.projectId === right.projectId && left.rootFrameId === right.rootFrameId && left.frameId === right.frameId && left.requestSha256 === right.requestSha256;
}

/** Compiled grant for the previously approved synthetic CSV task only. */
export function createSyntheticP0ScopeLoader(io: ScienceP0ScopeIo): () => Promise<SyntheticP0Scope> {
  return async () => {
    try {
      const workspace = await directoryChain(io, CWD, "workspace");
      const descriptor = parseDescriptor(await verifiedJson(io, true));
      checkCheckpoint(await verifiedJson(io, false), descriptor);
      const revalidate = async () => {
        try {
          if (!sameChain(workspace, await directoryChain(io, CWD, "workspace"))) fail();
          if (!sameDescriptor(descriptor, parseDescriptor(await verifiedJson(io, true)))) fail();
          checkCheckpoint(await verifiedJson(io, false), descriptor);
          if (!sameChain(workspace, await directoryChain(io, CWD, "workspace"))) fail();
        } catch { fail(); }
      };
      const partition = privateValue({ ownerKey: OWNER, cwd: CWD });
      const binding = privateValue({ projectId: descriptor.projectId, taskId: descriptor.rootFrameId, rootFrameId: descriptor.rootFrameId, frameId: descriptor.frameId });
      const result = privateValue({ scope: privateValue({ partition, binding, revalidate }), expectedVisibleProjectName: `science-synthetic-${descriptor.runId}` });
      await revalidate();
      return result;
    } catch { fail(); }
  };
}

function nodeStamp(stat: BigIntStats): ScienceP0FileStamp {
  return { kind: stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other", dev: stat.dev, ino: stat.ino, uid: Number(stat.uid), gid: Number(stat.gid), mode: Number(stat.mode & 0o7777n), nlink: Number(stat.nlink), size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

const nodeIo: ScienceP0ScopeIo = {
  async lstat(path) { return nodeStamp(await lstat(path, { bigint: true })); },
  realpath,
  async open(path) {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return {
      async stat() { return nodeStamp(await handle.stat({ bigint: true })); },
      async read(offset, length) { const bytes = Buffer.alloc(length); const result = await handle.read(bytes, 0, length, offset); return bytes.subarray(0, result.bytesRead); },
      async close() { await handle.close(); },
    };
  },
};

/** Importing this module performs no IO. Native runtime liveness is a separate host check. */
export async function loadSyntheticP0Scope(): Promise<SyntheticP0Scope> {
  return createSyntheticP0ScopeLoader(nodeIo)();
}
