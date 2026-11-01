/** Root sibling facts attest only one export; main code owns collection scope. Import is inert. */
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";
import type { ScienceArtifactSource, SciencePartition, ScienceRemoteBinding } from "./science-registry.js";

export const SYNTHETIC_CSV_ARTIFACT_PATHS = Object.freeze({
  sourceRoot: "/var/lib/pi-claude-science/home/.local/state/pi-science-p0/export",
  sourceFile: "/var/lib/pi-claude-science/home/.local/state/pi-science-p0/export/synthetic-values.csv",
  proofDirectory: "/var/lib/pi-claude-science-viewer-authority",
  proof: "/var/lib/pi-claude-science-viewer-authority/csv-artifact.json",
  bindingFile: "/var/lib/pi-claude-science-viewer-authority/p0-binding.json",
});
export type SyntheticCsvArtifactStat = Pick<BigIntStats, "dev" | "ino" | "mode" | "uid" | "gid" | "nlink" | "size" | "mtimeNs" | "ctimeNs" | "isFile" | "isDirectory" | "isSymbolicLink">;
export interface SyntheticCsvArtifactIo {
  lstat(file: string): Promise<SyntheticCsvArtifactStat>;
  realpath(file: string): Promise<string>;
  open(file: string): Promise<{ readonly fd: number; stat(): Promise<SyntheticCsvArtifactStat>; read(offset: number, length: number): Promise<Uint8Array>; close(): Promise<void> }>;
}
export interface SyntheticCsvArtifactProviderOptions { partition: SciencePartition; binding: ScienceRemoteBinding; revalidate(): unknown | Promise<unknown> }
export interface SyntheticCsvArtifactProvider {
  rootFor(partition: SciencePartition, binding: ScienceRemoteBinding): Promise<string | null>;
  sourcesFor(binding: ScienceRemoteBinding): Promise<ScienceArtifactSource[]>;
  status(): { available: boolean; code: "synthetic-csv-artifact-ready" | "synthetic-csv-artifact-unavailable" };
}
const REQUEST = "cdde40745c26fab81103b2d29619ed6766777a35b23717ee6e46d7ec4842b690";
const EXPORTER = "91c34a99b2ac6dd59f399a4aa4facc24cac6c4961ae03c17b386241497296b62";
const HASH = /^[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]{0,19})$/;
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const BINDING_KEYS = ["projectId", "taskId", "rootFrameId", "frameId"] as const;
const PROOF_KEYS = ["schemaVersion", "requestSha256", "bindingFile", "exporterSha256", "bytes", "sha256", "fileDev", "fileIno"];
const P = SYNTHETIC_CSV_ARTIFACT_PATHS;
interface BindingFileStamp { dev: string; ino: string; bytes: number; mtimeNs: string; ctimeNs: string }
interface Proof { bindingFile: BindingFileStamp; bytes: number; sha256: string; fileDev: string; fileIno: string }
interface Snapshot { proof: Proof; fingerprint: string }
class Unavailable extends Error {
  readonly code = "synthetic-csv-artifact-unavailable";
  constructor() { super("synthetic-csv-artifact-unavailable"); this.name = "ScienceSyntheticCsvArtifactError"; }
}
function need(value: unknown): asserts value { if (!value) throw new Unavailable(); }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)); }
function validBinding(value: unknown): value is ScienceRemoteBinding {
  return record(value) && exact(value, BINDING_KEYS) && typeof value.projectId === "string" && /^proj_[0-9a-f]{12}$/.test(value.projectId) &&
    [value.taskId, value.rootFrameId, value.frameId].every(id => typeof id === "string" && UUID.test(id)) && value.taskId === value.rootFrameId && value.frameId === value.rootFrameId;
}
function sameBinding(left: ScienceRemoteBinding, right: ScienceRemoteBinding): boolean { return BINDING_KEYS.every(key => left[key] === right[key]); }
function validPartition(value: unknown): value is SciencePartition {
  return record(value) && exact(value, ["ownerKey", "cwd"]) && typeof value.ownerKey === "string" && value.ownerKey.length > 0 && value.ownerKey.length <= 256 && !/[\x00-\x1f\x7f]/.test(value.ownerKey) &&
    typeof value.cwd === "string" && !value.cwd.includes("\0") && path.isAbsolute(value.cwd) && path.resolve(value.cwd) === value.cwd;
}
function fileStamp(value: SyntheticCsvArtifactStat): string { return [value.dev, value.ino, value.mode, value.uid, value.gid, value.nlink, value.size, value.mtimeNs, value.ctimeNs].join(":"); }
function directoryStamp(value: SyntheticCsvArtifactStat): string { return [value.dev, value.ino, value.mode, value.uid, value.gid].join(":"); }
function regular(value: SyntheticCsvArtifactStat, uid: bigint, mode: bigint): void {
  need(value.isFile() && !value.isSymbolicLink() && value.uid === uid && value.gid === 1000n && (value.mode & 0o7777n) === mode && value.nlink === 1n && value.size > 0n && value.size <= 4096n);
}
function directoryMetadata(value: SyntheticCsvArtifactStat, file: string, rootOnly: boolean): void {
  need(value.isDirectory() && !value.isSymbolicLink() && (value.mode & 0o7022n) === 0n && (rootOnly ? value.uid === 0n : value.uid === 0n || value.uid === 1000n && value.gid === 1000n));
  if (file === P.proofDirectory) need(value.uid === 0n && value.gid === 1000n && (value.mode & 0o7777n) === 0o750n);
  if (file === P.sourceRoot) need(value.uid === 1000n && value.gid === 1000n && (value.mode & 0o7777n) === 0o700n);
}
const nativeIo: SyntheticCsvArtifactIo = {
  lstat: file => fs.lstat(file, { bigint: true }), realpath: file => fs.realpath(file),
  async open(file) {
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    return { fd: handle.fd, stat: () => handle.stat({ bigint: true }), async read(offset, length) {
      const buffer = Buffer.alloc(length); const result = await handle.read(buffer, 0, length, offset); return buffer.subarray(0, result.bytesRead);
    }, close: () => handle.close() };
  },
};
function ancestors(directory: string): string[] {
  const result = [directory];
  while (result[0] !== "/") result.unshift(path.dirname(result[0]));
  return result;
}
async function directories(io: SyntheticCsvArtifactIo): Promise<string> {
  const result: string[] = [];
  for (const [directory, rootOnly] of [[P.proofDirectory, true], [P.sourceRoot, false]] as const) {
    for (const file of ancestors(directory)) {
      const value = await io.lstat(file);
      directoryMetadata(value, file, rootOnly);
      need(await io.realpath(file) === file); result.push(`${file}:${directoryStamp(value)}`);
    }
  }
  return result.join("|");
}
function validBindingFile(value: unknown): value is BindingFileStamp {
  return record(value) && exact(value, ["dev", "ino", "bytes", "mtimeNs", "ctimeNs"]) &&
    [value.dev, value.ino, value.mtimeNs, value.ctimeNs].every(item => typeof item === "string" && DECIMAL.test(item)) && Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0 && (value.bytes as number) <= 4096;
}
function parseProof(bytes: Uint8Array): Proof {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); const value: unknown = JSON.parse(text);
  need(record(value) && exact(value, PROOF_KEYS) && value.schemaVersion === 1 && value.requestSha256 === REQUEST && value.exporterSha256 === EXPORTER && validBindingFile(value.bindingFile));
  need(Number.isSafeInteger(value.bytes) && (value.bytes as number) > 0 && (value.bytes as number) <= 4096 && typeof value.sha256 === "string" && HASH.test(value.sha256) &&
    typeof value.fileDev === "string" && DECIMAL.test(value.fileDev) && typeof value.fileIno === "string" && DECIMAL.test(value.fileIno));
  // Exact fixed objects have thirteen property occurrences; "bytes" appears in both.
  const keys = Array.from(text.matchAll(/("(?:\\.|[^"\\])*")\s*:/g), match => JSON.parse(match[1]) as unknown);
  need(keys.length === 13);
  return { bindingFile: { ...value.bindingFile }, bytes: value.bytes as number, sha256: value.sha256, fileDev: value.fileDev, fileIno: value.fileIno };
}
async function bindingMetadata(io: SyntheticCsvArtifactIo, expected: BindingFileStamp): Promise<string> {
  const before = await io.lstat(P.bindingFile); regular(before, 0n, 0o440n);
  need(before.dev.toString() === expected.dev && before.ino.toString() === expected.ino && before.size === BigInt(expected.bytes) &&
    before.mtimeNs.toString() === expected.mtimeNs && before.ctimeNs.toString() === expected.ctimeNs && await io.realpath(P.bindingFile) === P.bindingFile);
  const handle = await io.open(P.bindingFile);
  try {
    const opened = await handle.stat(); regular(opened, 0n, 0o440n);
    need(fileStamp(opened) === fileStamp(before) && await io.realpath(`/proc/self/fd/${handle.fd}`) === P.bindingFile && fileStamp(await handle.stat()) === fileStamp(before) && fileStamp(await io.lstat(P.bindingFile)) === fileStamp(before));
    return fileStamp(before); // Existing scope loader alone reads/verifies its IDs; no body read/hash here.
  } finally { await handle.close(); }
}
async function readProof(io: SyntheticCsvArtifactIo): Promise<{ proof: Proof; stamp: string }> {
  const before = await io.lstat(P.proof); regular(before, 0n, 0o440n); need(await io.realpath(P.proof) === P.proof);
  const handle = await io.open(P.proof);
  try {
    const opened = await handle.stat(); regular(opened, 0n, 0o440n);
    need(fileStamp(before) === fileStamp(opened) && await io.realpath(`/proc/self/fd/${handle.fd}`) === P.proof);
    const chunks: Uint8Array[] = []; let offset = 0; const budget = Number(before.size) + 1;
    while (offset < budget) {
      const chunk = await handle.read(offset, budget - offset); need(chunk instanceof Uint8Array && chunk.length <= budget - offset);
      if (!chunk.length) break; chunks.push(chunk); offset += chunk.length;
    }
    need(offset === Number(before.size) && fileStamp(await handle.stat()) === fileStamp(before) && fileStamp(await io.lstat(P.proof)) === fileStamp(before));
    return { proof: parseProof(Buffer.concat(chunks)), stamp: fileStamp(before) };
  } finally { await handle.close(); }
}
async function sourceMetadata(io: SyntheticCsvArtifactIo, proof: Proof): Promise<string> {
  const before = await io.lstat(P.sourceFile); regular(before, 1000n, 0o600n);
  need(before.size === BigInt(proof.bytes) && before.dev.toString() === proof.fileDev && before.ino.toString() === proof.fileIno && await io.realpath(P.sourceFile) === P.sourceFile);
  const handle = await io.open(P.sourceFile);
  try {
    const opened = await handle.stat(); regular(opened, 1000n, 0o600n);
    need(fileStamp(opened) === fileStamp(before) && await io.realpath(`/proc/self/fd/${handle.fd}`) === P.sourceFile && fileStamp(await handle.stat()) === fileStamp(before) && fileStamp(await io.lstat(P.sourceFile)) === fileStamp(before));
    return fileStamp(before); // The registry's verified reader alone reads/hash-checks CSV bytes.
  } finally { await handle.close(); }
}
async function snapshot(io: SyntheticCsvArtifactIo): Promise<Snapshot> {
  const before = await directories(io); const { proof, stamp } = await readProof(io); const bound = await bindingMetadata(io, proof.bindingFile); const source = await sourceMetadata(io, proof);
  need(fileStamp(await io.lstat(P.proof)) === stamp && await directories(io) === before);
  need(fileStamp(await io.lstat(P.bindingFile)) === bound);
  return { proof, fingerprint: `${before}|${stamp}|${bound}|${source}` };
}

/** Main's existing loader asserts descriptor IDs/epoch for the captured task. Facts contain only its FD version, never IDs or grants. */
export function createSyntheticCsvArtifactProvider(options: SyntheticCsvArtifactProviderOptions, io: SyntheticCsvArtifactIo = nativeIo): SyntheticCsvArtifactProvider {
  need(record(options) && exact(options, ["partition", "binding", "revalidate"]) && validPartition(options.partition) && validBinding(options.binding) && typeof options.revalidate === "function");
  need(io && typeof io.lstat === "function" && typeof io.realpath === "function" && typeof io.open === "function");
  const partition = Object.freeze({ ...options.partition }); const binding = Object.freeze({ ...options.binding }); const revalidate = options.revalidate;
  const operations = Object.freeze({ lstat: io.lstat.bind(io), realpath: io.realpath.bind(io), open: io.open.bind(io) });
  let selected: Snapshot | undefined; let available = false;
  async function scope() { need(await revalidate() === undefined); }
  const provider: SyntheticCsvArtifactProvider = {
    async rootFor(incomingPartition, incomingBinding) {
      selected = undefined; available = false;
      try {
        need(validPartition(incomingPartition) && incomingPartition.ownerKey === partition.ownerKey && incomingPartition.cwd === partition.cwd && validBinding(incomingBinding) && sameBinding(incomingBinding, binding));
        await scope(); const current = await snapshot(operations); await scope();
        selected = current; available = true; return P.sourceRoot;
      } catch { selected = undefined; available = false; return null; }
    },
    async sourcesFor(incomingBinding) {
      available = false; const expected = selected;
      try {
        need(expected && validBinding(incomingBinding) && sameBinding(incomingBinding, binding));
        await scope(); const current = await snapshot(operations);
        need(current.fingerprint === expected.fingerprint); await scope();
        const source: ScienceArtifactSource = Object.freeze({ name: "synthetic-values.csv", bytes: current.proof.bytes, sha256: current.proof.sha256, taskId: binding.taskId,
          root: P.sourceRoot, relativePath: "synthetic-values.csv", mediaType: "text/csv" });
        available = true; return [source];
      } catch { selected = undefined; available = false; return []; }
    },
    status() { return { available, code: available ? "synthetic-csv-artifact-ready" : "synthetic-csv-artifact-unavailable" }; },
  };
  return Object.freeze(provider);
}
