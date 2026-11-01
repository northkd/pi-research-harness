/** Runtime facts only. Importing performs no IO and no result grants task authority. */
import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { lstat, open, readlink } from "node:fs/promises";

export const NATIVE_SCIENCE_SHA256 = "2139fa524389ec338ad86d50f66e7e7d0c4aa8bf9d7036a15fb196b5bde6a31b";
export const NATIVE_RUNTIME_PATHS = Object.freeze({
  facts: "/opt/pi-claude-science/viewer-20261026/native-runtime.json",
  binary: "/opt/pi-claude-science/stdin-20261025/science",
  aliasData: "/home/science/.csswitch/sandbox/home/.claude-science",
  physicalData: "/var/lib/pi-claude-science/home/.csswitch/sandbox/home/.claude-science",
  maskedConfig: "/var/lib/pi-claude-science/home/.csswitch/config.json",
} as const);
const VIEWER_CGROUP = "/system.slice/pi-claude-science-viewer.service";
const NATIVE_CGROUP = "/system.slice/pi-claude-science.service";
const FACT_BYTES = 8192;
const PROC_BYTES = 16384;
const MAX_U64 = (1n << 64n) - 1n;

/** Root's immutable descriptor, not an owner/cwd/material/task authorization. */
export interface NativeRuntimeFacts {
  schemaVersion: 1;
  nativePid: number;
  nativeStartTicks: string;
  nativeCgroup: typeof NATIVE_CGROUP;
  viewerCgroup: typeof VIEWER_CGROUP;
  hostUserNamespace: string;
  binary: { sha256: typeof NATIVE_SCIENCE_SHA256; dev: string; ino: string };
  data: { dev: string; ino: string };
}
export type NativeRuntimeStat = Pick<BigIntStats, "dev" | "ino" | "mode" | "uid" | "gid" | "nlink" | "size" | "mtimeNs" | "ctimeNs" | "isFile" | "isDirectory" | "isSymbolicLink">;
interface RuntimeFile {
  stat(): Promise<NativeRuntimeStat>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
/** Trusted code/test injection only; never install an IO adapter from client data. */
export interface NativeRuntimeIo {
  ids(): { platform: string; uid: number | undefined; euid: number | undefined; gid: number | undefined; egid: number | undefined };
  lstat(path: string): Promise<NativeRuntimeStat>;
  readlink(path: string): Promise<string>;
  open(path: string): Promise<RuntimeFile>;
}
export class ScienceNativeRuntimeError extends Error {
  constructor() { super("science-native-runtime-unavailable"); this.name = "ScienceNativeRuntimeError"; }
}
function requireFact(value: unknown): asserts value { if (!value) throw new Error("runtime-fact-refused"); }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function decimal(value: unknown, positive = false): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= MAX_U64 && (!positive || BigInt(value) > 0n);
}
function parseFacts(value: unknown): NativeRuntimeFacts {
  requireFact(record(value) && exact(value, ["schemaVersion", "nativePid", "nativeStartTicks", "nativeCgroup", "viewerCgroup", "hostUserNamespace", "binary", "data"]));
  requireFact(value.schemaVersion === 1 && typeof value.nativePid === "number" && Number.isSafeInteger(value.nativePid) && value.nativePid > 0 && value.nativePid <= 2147483647 && decimal(value.nativeStartTicks, true));
  requireFact(value.nativeCgroup === NATIVE_CGROUP && value.viewerCgroup === VIEWER_CGROUP && typeof value.hostUserNamespace === "string");
  const namespace = /^user:\[([0-9]+)\]$/.exec(value.hostUserNamespace);
  requireFact(namespace && decimal(namespace[1], true));
  requireFact(record(value.binary) && exact(value.binary, ["sha256", "dev", "ino"]) && value.binary.sha256 === NATIVE_SCIENCE_SHA256 && decimal(value.binary.dev) && decimal(value.binary.ino, true));
  requireFact(record(value.data) && exact(value.data, ["dev", "ino"]) && decimal(value.data.dev) && decimal(value.data.ino, true));
  return value as unknown as NativeRuntimeFacts;
}
function stamp(stat: NativeRuntimeStat): string {
  return [stat.dev, stat.ino, stat.mode, stat.uid, stat.gid, stat.nlink, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}
function rootFile(stat: NativeRuntimeStat, mode?: bigint) {
  requireFact(stat.isFile() && !stat.isSymbolicLink() && stat.uid === 0n && stat.gid === 0n && stat.nlink === 1n);
  const permissions = stat.mode & 0o7777n;
  requireFact(mode === undefined ? (permissions & 0o7222n) === 0n : permissions === mode);
}
async function bounded(file: RuntimeFile, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []; let length = 0;
  while (length <= maximum) {
    const chunk = await file.read(length, maximum + 1 - length);
    requireFact(chunk instanceof Uint8Array && chunk.byteLength <= maximum + 1 - length);
    if (!chunk.byteLength) break;
    chunks.push(chunk); length += chunk.byteLength;
  }
  requireFact(length <= maximum);
  return Buffer.concat(chunks, length);
}
async function text(io: NativeRuntimeIo, path: string): Promise<string> {
  const file = await io.open(path);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(await bounded(file, PROC_BYTES)); }
  finally { await file.close(); }
}
async function readFacts(io: NativeRuntimeIo) {
  const before = await io.lstat(NATIVE_RUNTIME_PATHS.facts); rootFile(before, 0o444n);
  requireFact(before.size > 0n && before.size <= BigInt(FACT_BYTES));
  const file = await io.open(NATIVE_RUNTIME_PATHS.facts);
  try {
    const opened = await file.stat(); rootFile(opened, 0o444n); requireFact(stamp(opened) === stamp(before));
    const bytes = await bounded(file, FACT_BYTES);
    requireFact(BigInt(bytes.byteLength) === before.size && stamp(await file.stat()) === stamp(before) && stamp(await io.lstat(NATIVE_RUNTIME_PATHS.facts)) === stamp(before));
    return { facts: parseFacts(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))), fingerprint: stamp(before) };
  } finally { await file.close(); }
}
function field(status: string, name: string): string {
  const values = status.split("\n").filter(line => line.startsWith(`${name}:`));
  requireFact(values.length === 1); return values[0].slice(name.length + 1).trim();
}
function statusFacts(status: string, self: boolean) {
  for (const name of ["Uid", "Gid"]) {
    const values = field(status, name).split(/\s+/); requireFact(values.length === 4 && values.every(value => value === "1000"));
  }
  for (const name of ["CapEff", "CapPrm", "CapInh", "CapAmb", ...(self ? ["CapBnd"] : [])]) {
    const value = field(status, name); requireFact(/^[0-9a-f]{1,16}$/i.test(value) && BigInt(`0x${value}`) === 0n);
  }
  requireFact(field(status, "NoNewPrivs") === "1");
}
function identity(io: NativeRuntimeIo) {
  const ids = io.ids(); requireFact(ids.platform === "linux" && ids.uid === 1000 && ids.euid === 1000 && ids.gid === 1000 && ids.egid === 1000);
}
async function selfFacts(io: NativeRuntimeIo, facts: NativeRuntimeFacts) {
  identity(io); statusFacts(await text(io, "/proc/self/status"), true);
  requireFact((await text(io, "/proc/self/cgroup")).trim() === `0::${VIEWER_CGROUP}`);
  requireFact(await io.readlink("/proc/self/ns/user") === facts.hostUserNamespace);
}
async function nativeFacts(io: NativeRuntimeIo, facts: NativeRuntimeFacts) {
  // This rejects PID reuse, not same-PID exec. Root attests the initial binary
  // association separately; target exe/argv/env are deliberately never read.
  const base = `/proc/${facts.nativePid}`;
  const stat = await text(io, `${base}/stat`); const closing = stat.lastIndexOf(")");
  requireFact(stat.startsWith(`${facts.nativePid} (`) && closing > 0 && stat[closing + 1] === " ");
  // After the final comm ')' the first token is field3; field22 is index19.
  const fields = stat.slice(closing + 2).trim().split(/\s+/);
  requireFact(fields.length >= 20 && decimal(fields[19], true) && fields[19] === facts.nativeStartTicks);
  statusFacts(await text(io, `${base}/status`), false);
  requireFact((await text(io, `${base}/cgroup`)).trim() === `0::${NATIVE_CGROUP}`);
}
async function dataFacts(io: NativeRuntimeIo, facts: NativeRuntimeFacts) {
  for (const path of [NATIVE_RUNTIME_PATHS.aliasData, NATIVE_RUNTIME_PATHS.physicalData]) {
    const stat = await io.lstat(path);
    requireFact(stat.isDirectory() && !stat.isSymbolicLink() && stat.dev.toString() === facts.data.dev && stat.ino.toString() === facts.data.ino);
  }
  // Deliberately lstat only. Never open or read the outer credential config.
  const mask = await io.lstat(NATIVE_RUNTIME_PATHS.maskedConfig);
  requireFact(mask.isFile() && !mask.isSymbolicLink() && mask.uid === 0n && mask.gid === 0n && (mask.mode & 0o7777n) === 0n);
}
async function hashBinary(io: NativeRuntimeIo, expected: NativeRuntimeFacts["binary"]) {
  const before = await io.lstat(NATIVE_RUNTIME_PATHS.binary); rootFile(before);
  requireFact(before.dev.toString() === expected.dev && before.ino.toString() === expected.ino);
  requireFact(before.size > 0n && before.size <= BigInt(Number.MAX_SAFE_INTEGER));
  const file = await io.open(NATIVE_RUNTIME_PATHS.binary);
  try {
    const opened = await file.stat(); rootFile(opened); requireFact(stamp(opened) === stamp(before));
    const hash = createHash("sha256"); let offset = 0; const size = Number(before.size);
    while (offset < size) {
      const length = Math.min(65536, size - offset), chunk = await file.read(offset, length);
      requireFact(chunk instanceof Uint8Array && chunk.byteLength > 0 && chunk.byteLength <= length);
      hash.update(chunk); offset += chunk.byteLength;
    }
    requireFact((await file.read(size, 1)).byteLength === 0 && hash.digest("hex") === NATIVE_SCIENCE_SHA256);
    requireFact(stamp(await file.stat()) === stamp(before) && stamp(await io.lstat(NATIVE_RUNTIME_PATHS.binary)) === stamp(before));
    return { fingerprint: stamp(before), dev: before.dev.toString(), ino: before.ino.toString() };
  } finally { await file.close(); }
}

/** Only asserts recorded process facts and the installed binary, not current-exe
 * identity. Task/owner/cwd authorization remains a separate gate. */
export function createNativeRuntimeAssertion(io: NativeRuntimeIo): () => Promise<void> {
  let binaryProof: ReturnType<typeof hashBinary> | undefined;
  const binaryFacts = async (facts: NativeRuntimeFacts) => {
    if (!binaryProof) binaryProof = hashBinary(io, facts.binary).catch(error => { binaryProof = undefined; throw error; });
    const proof = await binaryProof, current = await io.lstat(NATIVE_RUNTIME_PATHS.binary); rootFile(current);
    requireFact(proof.dev === facts.binary.dev && proof.ino === facts.binary.ino && stamp(current) === proof.fingerprint);
  };
  return async () => {
    try {
      identity(io); const { facts, fingerprint } = await readFacts(io);
      await selfFacts(io, facts); await nativeFacts(io, facts);
      await binaryFacts(facts); await dataFacts(io, facts);
      await selfFacts(io, facts); await nativeFacts(io, facts);
      requireFact(stamp(await io.lstat(NATIVE_RUNTIME_PATHS.facts)) === fingerprint);
      await binaryFacts(facts);
    } catch { throw new ScienceNativeRuntimeError(); }
  };
}
const nodeIo: NativeRuntimeIo = {
  ids: () => ({ platform: process.platform, uid: process.getuid?.(), euid: process.geteuid?.(), gid: process.getgid?.(), egid: process.getegid?.() }),
  lstat: path => lstat(path, { bigint: true }),
  readlink,
  async open(path) {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return {
      stat: () => file.stat({ bigint: true }),
      async read(offset, length) { const data = Buffer.alloc(length); const { bytesRead } = await file.read(data, 0, length, offset); return data.subarray(0, bytesRead); },
      close: () => file.close(),
    };
  },
};
/** Lazy default for trusted host code. Construction/import opens nothing. */
export const assertNativeRuntime = createNativeRuntimeAssertion(nodeIo);
