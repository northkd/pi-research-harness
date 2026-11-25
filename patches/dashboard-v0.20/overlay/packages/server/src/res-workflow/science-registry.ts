/** Private technical records for the independent Science host. Importing starts nothing. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import { assertNoLinks, readBoundedRegular, serializeWrite, writeSciencePrivateFile } from "../science-runtime.js";

const MAX_RECORDS = 128;
const MAX_ARTIFACTS = 32;
const MAX_BYTES = 1024 * 1024;
const MODELS = new Set(["ark-sci-deepseek-v4.1-flash", "gpt-6.1-sol(max)", "gpt-6-astra(high)"]);
const STATUSES = new Set(["unknown", "running", "completed", "failed", "waiting-approval", "cancelled"]);
const MEDIA = new Set(["image/png", "image/jpeg", "application/pdf", "text/csv", "text/plain"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const OPAQUE = /^si-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ARTIFACT_ID = /^sa-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;

export interface SciencePartition { ownerKey: string; cwd: string }
export type ScienceInstanceStatus = "unknown" | "running" | "completed" | "failed" | "waiting-approval" | "cancelled";
export type ScienceArtifactMedia = "image/png" | "image/jpeg" | "application/pdf" | "text/csv" | "text/plain";
export interface ScienceMaterial { name: string; bytes: number; sha256: string }
export interface ScienceSubmission { projectId: string; prompt: string; modelIds: string[]; materials: ScienceMaterial[] }
export interface ScienceRemoteBinding { projectId: string; taskId: string; rootFrameId: string; frameId: string }
export interface ScienceObservation extends ScienceRemoteBinding { status: ScienceInstanceStatus }
export interface ScienceArtifactSource extends ScienceMaterial {
  taskId: string;
  root: string;
  relativePath: string;
  mediaType: ScienceArtifactMedia;
}
export interface ScienceArtifactMetadata extends ScienceMaterial { id: string; mediaType: ScienceArtifactMedia }
export interface ScienceInstanceSummary {
  id: string; status: ScienceInstanceStatus;
  /** Local registry recording/import time, never the native task's creation time. */
  createdAt: number;
  lastObservedAt: number | null; stale: boolean;
}
export interface ScienceInstanceDetail extends ScienceInstanceSummary { modelIds: string[]; usage: null; cost: null; artifacts: ScienceArtifactMetadata[] }
export type ScienceRegistryAction =
  | { kind: "view" }
  | { kind: "bind"; projectId: string; binding?: ScienceRemoteBinding }
  | { kind: "submit"; requestHash: string; modelIds: string[]; materials: ScienceMaterial[] }
  | { kind: "cancel"; instanceId: string; binding: ScienceRemoteBinding }
  | { kind: "collect-artifacts"; instanceId: string; binding: ScienceRemoteBinding };
export interface ScienceRegistryAuthority {
  /** Trusted host callback. No JSON record, project file or client assertion installs this authority. */
  assert(partition: SciencePartition, action: ScienceRegistryAction): Promise<void>;
}
export interface ScienceRegistryDriver {
  /** Driver implements only independently verified upstream contracts. Never retry a mutation internally. */
  submit(request: ScienceSubmission & { intentId: string; requestHash: string }): Promise<ScienceRemoteBinding>;
  reconcile(request: { projectId: string; intentId: string; requestHash: string }): Promise<ScienceRemoteBinding | null>;
  observe(binding: ScienceRemoteBinding): Promise<ScienceObservation>;
  cancel(binding: ScienceRemoteBinding): Promise<ScienceObservation | null>;
  /** Only sources explicitly returned for this exact upstream task; no client-selected paths. */
  artifacts?(binding: ScienceRemoteBinding): Promise<ScienceArtifactSource[]>;
}
export interface ScienceRegistryDeps {
  authority: ScienceRegistryAuthority;
  driver: ScienceRegistryDriver;
  /** Independent host configuration of this exact task's output root. Upstream metadata cannot install it. */
  artifactRootFor?(partition: SciencePartition, binding: ScienceRemoteBinding): Promise<string | null>;
}
type Phase = "prepared" | "sending" | "bound" | "unknown" | "not-submitted";
interface StoredArtifact extends ScienceArtifactMetadata { file: string }
interface Instance extends SciencePartition {
  id: string; projectId: string; binding: ScienceRemoteBinding | null;
  /** Submission intent for request rows; only a local row epoch for existing-task imports. */
  intentId: string;
  request: ScienceSubmission | null; requestHash: string | null;
  authorization: { requestHash: string; modelIds: string[]; materials: ScienceMaterial[]; recordedAt: number } | null;
  phase: Phase; status: ScienceInstanceStatus; createdAt: number; lastObservedAt: number | null;
  offline: boolean; tracking: boolean; cancelState: "none" | "requesting" | "unknown" | "confirmed";
  artifacts: StoredArtifact[];
}
interface RegistryState { schemaVersion: 1; projects: (SciencePartition & { projectId: string })[]; instances: Instance[] }
type Code = "registry-invalid-input" | "registry-unsafe-root" | "registry-busy" | "registry-unavailable" | "registry-writer-lost" | "registry-access-denied" | "registry-not-found" | "registry-budget" | "registry-state-invalid" | "registry-artifact-refused";
export class ScienceRegistryError extends Error {
  readonly code: Code;
  constructor(code: Code) { super(code); this.name = "ScienceRegistryError"; this.code = code; }
}
function requireValue(value: unknown, code: Code = "registry-invalid-input"): asserts value { if (!value) throw new ScienceRegistryError(code); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)); }
function timestamp(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function cleanName(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f/\\]/.test(value) && value !== "." && value !== ".."; }
function material(value: unknown): value is ScienceMaterial { return object(value) && exact(value, ["name", "bytes", "sha256"]) && cleanName(value.name) && Number.isSafeInteger(value.bytes) && (value.bytes as number) >= 0 && (value.bytes as number) <= MAX_BYTES && typeof value.sha256 === "string" && HASH.test(value.sha256); }
function modelIds(value: unknown): value is string[] { return Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every(id => typeof id === "string" && MODELS.has(id)) && new Set(value).size === value.length; }
function submission(value: unknown): value is ScienceSubmission { return object(value) && exact(value, ["projectId", "prompt", "modelIds", "materials"]) && typeof value.projectId === "string" && ID.test(value.projectId) && typeof value.prompt === "string" && value.prompt.length > 0 && Buffer.byteLength(value.prompt) <= 16384 && !value.prompt.includes("\0") && modelIds(value.modelIds) && Array.isArray(value.materials) && value.materials.length <= 32 && value.materials.every(material) && new Set(value.materials.map(row => row.name)).size === value.materials.length; }
function remoteBinding(value: unknown): value is ScienceRemoteBinding { return object(value) && exact(value, ["projectId", "taskId", "rootFrameId", "frameId"]) && Object.values(value).every(id => typeof id === "string" && ID.test(id)); }
function samePartition(left: SciencePartition, right: SciencePartition) { return left.ownerKey === right.ownerKey && left.cwd === right.cwd; }
function sameBinding(left: ScienceRemoteBinding, right: ScienceRemoteBinding) { return left.projectId === right.projectId && left.taskId === right.taskId && left.rootFrameId === right.rootFrameId && left.frameId === right.frameId; }
function copy<T>(value: T): T { return structuredClone(value); }
function digest(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function canonicalRequest(value: ScienceSubmission): ScienceSubmission { return { projectId: value.projectId, prompt: value.prompt, modelIds: [...value.modelIds].sort(), materials: value.materials.map(row => ({ name: row.name, bytes: row.bytes, sha256: row.sha256 })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) }; }
function summary(row: Instance): ScienceInstanceSummary { return { id: row.id, status: row.status, createdAt: row.createdAt, lastObservedAt: row.lastObservedAt, stale: row.offline || row.lastObservedAt === null || Date.now() - row.lastObservedAt > 30000 }; }
function detail(row: Instance): ScienceInstanceDetail { return { ...summary(row), modelIds: [...row.request?.modelIds ?? []], usage: null, cost: null, artifacts: row.artifacts.map(({ file: _, ...metadata }) => ({ ...metadata })) }; }

function validPartition(value: unknown): value is SciencePartition {
  return object(value) && typeof value.ownerKey === "string" && value.ownerKey.length > 0 && value.ownerKey.length <= 512 && !/[\x00-\x1f\x7f]/.test(value.ownerKey) && typeof value.cwd === "string" && value.cwd.length <= 4096 && !value.cwd.includes("\0") && path.isAbsolute(value.cwd) && path.resolve(value.cwd) === value.cwd;
}
function parseState(raw: string): RegistryState {
  const value: unknown = JSON.parse(raw);
  requireValue(object(value) && exact(value, ["schemaVersion", "projects", "instances"]) && value.schemaVersion === 1 && Array.isArray(value.projects) && value.projects.length <= MAX_RECORDS && Array.isArray(value.instances) && value.instances.length <= MAX_RECORDS, "registry-state-invalid");
  const state = value as unknown as RegistryState;
  for (const project of state.projects) requireValue(validPartition(project) && object(project) && exact(project, ["ownerKey", "cwd", "projectId"]) && typeof project.projectId === "string" && ID.test(project.projectId), "registry-state-invalid");
  requireValue(new Set(state.projects.map(row => row.projectId)).size === state.projects.length, "registry-state-invalid");
  for (const row of state.instances) validateInstance(state, row);
  requireValue(new Set(state.instances.map(row => row.id)).size === state.instances.length && new Set(state.instances.filter(row => row.binding).map(row => `${row.projectId}:${row.binding!.taskId}`)).size === state.instances.filter(row => row.binding).length, "registry-state-invalid");
  return state;
}
function validateInstance(state: RegistryState, row: Instance) {
    requireValue(validPartition(row) && object(row) && exact(row, ["ownerKey", "cwd", "id", "projectId", "binding", "intentId", "request", "requestHash", "authorization", "phase", "status", "createdAt", "lastObservedAt", "offline", "tracking", "cancelState", "artifacts"]) && OPAQUE.test(row.id) && ID.test(row.projectId) && /^[0-9a-f-]{36}$/.test(row.intentId) && ["prepared", "sending", "bound", "unknown", "not-submitted"].includes(row.phase) && STATUSES.has(row.status) && timestamp(row.createdAt) && (row.lastObservedAt === null || timestamp(row.lastObservedAt)) && typeof row.offline === "boolean" && typeof row.tracking === "boolean" && ["none", "requesting", "unknown", "confirmed"].includes(row.cancelState) && Array.isArray(row.artifacts) && row.artifacts.length <= MAX_ARTIFACTS, "registry-state-invalid");
    requireValue(state.projects.some(project => project.projectId === row.projectId && samePartition(project, row)) && (row.binding === null || remoteBinding(row.binding) && row.binding.projectId === row.projectId), "registry-state-invalid");
    if (row.request === null) requireValue(row.requestHash === null && row.authorization === null && row.phase === "bound" && row.binding !== null, "registry-state-invalid");
    else {
      requireValue(submission(row.request) && row.request.projectId === row.projectId && row.requestHash === digest(canonicalRequest(row.request)) && object(row.authorization) && exact(row.authorization, ["requestHash", "modelIds", "materials", "recordedAt"]) && row.authorization.requestHash === row.requestHash && digest(row.authorization.modelIds) === digest(row.request.modelIds) && digest(row.authorization.materials) === digest(row.request.materials) && timestamp(row.authorization.recordedAt), "registry-state-invalid");
    }
    for (const artifact of row.artifacts) requireValue(object(artifact) && exact(artifact, ["id", "name", "bytes", "sha256", "mediaType", "file"]) && ARTIFACT_ID.test(artifact.id) && cleanName(artifact.name) && Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0 && artifact.bytes <= MAX_BYTES && HASH.test(artifact.sha256) && MEDIA.has(artifact.mediaType) && artifact.file === `artifact-${artifact.id}.bin`, "registry-state-invalid");
    requireValue(new Set(row.artifacts.map(item => item.id)).size === row.artifacts.length, "registry-state-invalid");
}
function recoverState(state: RegistryState): boolean {
  let recovery = false;
  for (const row of state.instances) {
    if (row.phase === "prepared" || row.phase === "sending") { row.phase = "unknown"; recovery = true; }
    if (row.cancelState === "requesting") { row.cancelState = "unknown"; recovery = true; }
    if (!row.offline) { row.offline = true; recovery = true; }
  }
  return recovery;
}
function validateArtifactSource(source: unknown, taskId: string): asserts source is ScienceArtifactSource {
  requireValue(object(source) && exact(source, ["taskId", "root", "relativePath", "name", "mediaType", "bytes", "sha256"]) && source.taskId === taskId && material({ name: source.name, bytes: source.bytes, sha256: source.sha256 }) && typeof source.mediaType === "string" && MEDIA.has(source.mediaType) && typeof source.root === "string" && path.isAbsolute(source.root) && path.resolve(source.root) === source.root && typeof source.relativePath === "string" && source.relativePath.length > 0 && source.relativePath.length <= 512 && !source.relativePath.includes("\0") && !source.relativePath.includes("\\") && !path.isAbsolute(source.relativePath) && !source.relativePath.split("/").some(piece => !piece || piece === "." || piece === ".."), "registry-artifact-refused");
}
async function assertNewCacheFile(file: string) {
  try { await fs.lstat(file); throw new ScienceRegistryError("registry-artifact-refused"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

async function rootIdentity(root: string) {
  requireValue(typeof root === "string" && path.isAbsolute(root) && path.resolve(root) === root, "registry-unsafe-root");
  const entry = await fs.lstat(root);
  requireValue(entry.isDirectory() && entry.uid === process.getuid?.() && (entry.mode & 0o7777) === 0o700 && await fs.realpath(root) === root, "registry-unsafe-root");
  return { dev: entry.dev, ino: entry.ino };
}
async function privateFile(file: string) {
  const entry = await fs.lstat(file);
  requireValue(entry.isFile() && entry.nlink === 1 && entry.uid === process.getuid?.() && (entry.mode & 0o7777) === 0o600, "registry-state-invalid");
  return entry;
}

/** A real flock belongs to an open file description. Crash releases it; no stale-lock stealing. */
async function acquireWriter(root: string) {
  const file = path.join(root, "writer.lock");
  let handle: FileHandle;
  try { handle = await fs.open(file, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; handle = await fs.open(file, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const entry = await privateFile(file); const opened = await handle.stat();
    requireValue(entry.dev === opened.dev && entry.ino === opened.ino && opened.size === 0, "registry-state-invalid");
    child = spawn("/usr/bin/flock", ["--exclusive", "--nonblock", "3"], { cwd: "/", env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" }, stdio: ["ignore", "ignore", "ignore", handle.fd] });
    const writer = child;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new ScienceRegistryError("registry-unavailable")), 3000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
      writer.once("exit", code => finish(code === 0 ? undefined : new ScienceRegistryError("registry-busy")));
      writer.once("error", () => finish(new ScienceRegistryError("registry-unavailable")));
    });
    return { handle, identity: { dev: opened.dev, ino: opened.ino } };
  } catch (error) { if (child && child.exitCode === null) child.kill(); await handle.close(); throw error; }
}

export async function openScienceRegistry(root: string, deps: ScienceRegistryDeps) {
  let lock: Awaited<ReturnType<typeof acquireWriter>> | undefined;
  try {
    const identity = await rootIdentity(root);
    requireValue(typeof deps?.authority?.assert === "function" && typeof deps.driver?.submit === "function" && typeof deps.driver?.observe === "function" && typeof deps.driver?.reconcile === "function" && typeof deps.driver?.cancel === "function");
    lock = await acquireWriter(root);
    const owned = lock;
    let closed = false; let lost = false; let state: RegistryState = { schemaVersion: 1, projects: [], instances: [] };
    async function gate() {
      requireValue(!closed && !lost && owned.handle.fd >= 0, "registry-writer-lost");
      const current = await rootIdentity(root); const file = await privateFile(path.join(root, "writer.lock"));
      requireValue(current.dev === identity.dev && current.ino === identity.ino && file.dev === owned.identity.dev && file.ino === owned.identity.ino, "registry-writer-lost");
    }
    async function persist(next: RegistryState) {
      await gate(); const text = JSON.stringify(next); requireValue(Buffer.byteLength(text) <= MAX_BYTES, "registry-budget");
      try { await writeSciencePrivateFile(root, "registry.json", text); state = next; }
      catch { lost = true; throw new ScienceRegistryError("registry-unavailable"); }
    }
    try { await privateFile(path.join(root, "registry.json")); state = parseState((await readBoundedRegular(path.join(root, "registry.json"), MAX_BYTES, root)).text); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    // A previous process may have sent either mutation. Recovery only observes.
    if (recoverState(state)) await persist(copy(state));
    async function access(partition: SciencePartition, action: ScienceRegistryAction = { kind: "view" }) {
      try {
        requireValue(validPartition(partition), "registry-access-denied");
        requireValue(await fs.realpath(partition.cwd) === partition.cwd && (await fs.stat(partition.cwd)).isDirectory(), "registry-access-denied");
        await deps.authority.assert(copy(partition), copy(action));
      } catch { throw new ScienceRegistryError("registry-access-denied"); }
    }
    function operation<T>(run: () => Promise<T>): Promise<T> {
      return serializeWrite(path.join(root, "registry-operation"), async () => {
        try { await gate(); return await run(); }
        catch (error) { if (error instanceof ScienceRegistryError) throw error; throw new ScienceRegistryError("registry-unavailable"); }
      });
    }
    function instance(partition: SciencePartition, id: string, from = state) {
      requireValue(typeof id === "string" && OPAQUE.test(id), "registry-not-found");
      const row = from.instances.find(item => item.id === id && samePartition(item, partition)); requireValue(row, "registry-not-found"); return row;
    }
    function addProject(next: RegistryState, partition: SciencePartition, projectId: string) {
      const existing = next.projects.find(row => row.projectId === projectId);
      requireValue(!existing || samePartition(existing, partition), "registry-not-found");
      if (!existing) { requireValue(next.projects.length < MAX_RECORDS, "registry-budget"); next.projects.push({ ...partition, projectId }); }
    }
    function applyBinding(next: RegistryState, row: Instance, binding: ScienceRemoteBinding) {
      requireValue(remoteBinding(binding) && binding.projectId === row.projectId, "registry-state-invalid");
      requireValue(!next.instances.some(other => other.id !== row.id && other.binding?.projectId === binding.projectId && other.binding.taskId === binding.taskId), "registry-state-invalid");
      row.binding = copy(binding); row.phase = "bound";
    }
    function observed(row: Instance, value: ScienceObservation) {
      const { status, ...binding } = value ?? {};
      requireValue(remoteBinding(binding) && row.binding && sameBinding(row.binding, binding) && STATUSES.has(status), "registry-state-invalid");
      row.status = status; row.lastObservedAt = Date.now(); row.offline = false;
    }
    const api = {
      bindProject(partition: SciencePartition, projectId: string) { partition = { ...partition }; return operation(async () => {
        requireValue(typeof projectId === "string" && ID.test(projectId)); await access(partition, { kind: "bind", projectId });
        const next = copy(state); addProject(next, partition, projectId); await persist(next);
      }); },
      bind(partition: SciencePartition, binding: ScienceRemoteBinding) { partition = { ...partition }; binding = { ...binding }; return operation(async () => {
        requireValue(remoteBinding(binding)); await access(partition);
        await access(partition, { kind: "bind", projectId: binding.projectId, binding: copy(binding) });
        const next = copy(state); addProject(next, partition, binding.projectId);
        const existing = next.instances.find(row => row.binding?.projectId === binding.projectId && row.binding.taskId === binding.taskId);
        if (existing) { requireValue(samePartition(existing, partition) && sameBinding(existing.binding!, binding), "registry-not-found"); await access(partition); return detail(existing); }
        requireValue(next.instances.length < MAX_RECORDS, "registry-budget");
        const row: Instance = { ...partition, id: `si-${randomUUID()}`, intentId: randomUUID(), projectId: binding.projectId, binding: copy(binding), request: null, requestHash: null, authorization: null, phase: "bound", status: "unknown", createdAt: Date.now(), lastObservedAt: null, offline: true, tracking: true, cancelState: "none", artifacts: [] };
        next.instances.push(row); await persist(next); await access(partition); return detail(row);
      }); },
      submit(partition: SciencePartition, input: ScienceSubmission) { partition = { ...partition }; return operation(async () => {
        requireValue(submission(input)); const request = canonicalRequest(input); const requestHash = digest(request);
        const action: ScienceRegistryAction = { kind: "submit", requestHash, modelIds: request.modelIds, materials: request.materials };
        await access(partition, action);
        requireValue(state.projects.some(row => row.projectId === request.projectId && samePartition(row, partition)), "registry-not-found");
        const existing = state.instances.find(row => samePartition(row, partition) && row.requestHash === requestHash);
        if (existing) return detail(existing); // Unknown never becomes a retry.
        requireValue(state.instances.length < MAX_RECORDS, "registry-budget");
        const createdAt = Date.now();
        const row: Instance = { ...partition, id: `si-${randomUUID()}`, intentId: randomUUID(), projectId: request.projectId, binding: null, request, requestHash, authorization: { requestHash, modelIds: request.modelIds, materials: request.materials, recordedAt: createdAt }, phase: "prepared", status: "unknown", createdAt, lastObservedAt: null, offline: true, tracking: true, cancelState: "none", artifacts: [] };
        let next = copy(state); next.instances.push(row); await persist(next);
        next = copy(state); instance(partition, row.id, next).phase = "sending"; await persist(next);
        try {
          await gate(); await access(partition, action);
          const result = await deps.driver.submit({ ...copy(request), intentId: row.intentId, requestHash });
          next = copy(state); applyBinding(next, instance(partition, row.id, next), result);
        } catch { next = copy(state); instance(partition, row.id, next).phase = "unknown"; }
        await persist(next); await access(partition); return detail(instance(partition, row.id));
      }); },
      reconcile(partition: SciencePartition, id: string) { partition = { ...partition }; return operation(async () => {
        await access(partition); const row = instance(partition, id); if (row.binding || !row.requestHash) return detail(row);
        const next = copy(state); const update = instance(partition, id, next);
        try { const binding = await deps.driver.reconcile({ projectId: row.projectId, intentId: row.intentId, requestHash: row.requestHash }); if (binding) applyBinding(next, update, binding); }
        catch { update.offline = true; }
        await access(partition); await persist(next); await access(partition); return detail(update);
      }); },
      observe(partition: SciencePartition, id: string) { partition = { ...partition }; return operation(async () => {
        await access(partition); const row = instance(partition, id); if (!row.binding) return detail(row);
        const next = copy(state); const update = instance(partition, id, next);
        try { observed(update, await deps.driver.observe(copy(row.binding))); } catch { update.offline = true; }
        await access(partition); await persist(next); await access(partition); return detail(update);
      }); },
      cancel(partition: SciencePartition, id: string) { partition = { ...partition }; return operation(async () => {
        await access(partition); const row = instance(partition, id); requireValue(row.binding, "registry-not-found");
        if (row.cancelState !== "none") return detail(row);
        const action: ScienceRegistryAction = { kind: "cancel", instanceId: id, binding: row.binding };
        await access(partition, action);
        let next = copy(state); instance(partition, id, next).cancelState = "requesting"; await persist(next);
        next = copy(state); const update = instance(partition, id, next);
        try {
          await gate(); await access(partition, action); const result = await deps.driver.cancel(copy(row.binding));
          if (result?.status === "cancelled") { observed(update, result); update.cancelState = "confirmed"; }
          else update.cancelState = "unknown";
        } catch { update.cancelState = "unknown"; update.offline = true; }
        await persist(next); await access(partition); return detail(update);
      }); },
      stopTracking(partition: SciencePartition, id: string) { partition = { ...partition }; return operation(async () => { await access(partition); const next = copy(state); instance(partition, id, next).tracking = false; await persist(next); }); },
      list(partition: SciencePartition) { partition = { ...partition }; return operation(async () => { await access(partition); return state.instances.filter(row => samePartition(row, partition)).map(summary); }); },
      detail(partition: SciencePartition, id: string) { partition = { ...partition }; return operation(async () => { await access(partition); return detail(instance(partition, id)); }); },
      async accessFor(partition: SciencePartition) {
        partition = { ...partition };
        try { await operation(async () => { await access(partition); }); return { ...copy(partition), revalidate: () => operation(() => access(partition)) }; } catch { return null; }
      },
      async resolveBinding(partition: SciencePartition, id?: string) {
        partition = { ...partition };
        try { return await operation(async () => {
          await access(partition);
          if (id !== undefined) {
            const row = instance(partition, id);
            if (!row.binding) return null;
            const binding = Object.freeze(copy(row.binding)); const intentId = row.intentId;
            return Object.freeze({ ...copy(partition), projectId: binding.projectId, instanceId: id, binding, revalidate: () => operation(async () => {
              await access(partition); const current = instance(partition, id);
              requireValue(current.intentId === intentId && current.binding && sameBinding(current.binding, binding), "registry-not-found");
            }) });
          }
          const projects = state.projects.filter(row => samePartition(row, partition));
          const projectId = projects.length === 1 ? projects[0].projectId : null;
          return projectId ? { ...copy(partition), projectId, revalidate: () => operation(async () => { await access(partition); requireValue(state.projects.some(row => row.projectId === projectId && samePartition(row, partition)), "registry-not-found"); }) } : null;
        }); } catch { return null; }
      },
      collectArtifacts(partition: SciencePartition, id: string) { partition = { ...partition }; return operation(async () => {
        await access(partition); const row = instance(partition, id); requireValue(row.binding, "registry-not-found");
        requireValue(typeof deps.driver.artifacts === "function", "registry-artifact-refused");
        requireValue(typeof deps.artifactRootFor === "function", "registry-artifact-refused");
        const action: ScienceRegistryAction = { kind: "collect-artifacts", instanceId: id, binding: row.binding }; await access(partition, action);
        const artifactRoot = await deps.artifactRootFor(copy(partition), copy(row.binding));
        requireValue(typeof artifactRoot === "string" && path.isAbsolute(artifactRoot) && path.resolve(artifactRoot) === artifactRoot && await fs.realpath(artifactRoot) === artifactRoot, "registry-artifact-refused");
        const sources = await deps.driver.artifacts(copy(row.binding)); requireValue(Array.isArray(sources) && sources.length <= MAX_ARTIFACTS, "registry-budget");
        const next = copy(state); const update = instance(partition, id, next);
        for (const source of sources) { validateArtifactSource(source, row.binding.taskId); requireValue(source.root === artifactRoot, "registry-artifact-refused"); }
        for (const source of sources) {
          if (update.artifacts.some(item => item.name === source.name && item.sha256 === source.sha256)) continue;
          requireValue(update.artifacts.length < MAX_ARTIFACTS, "registry-budget");
          const bytes = await readArtifactBytes(source.root, source.relativePath, source.bytes, source.sha256, false); validateMedia(bytes, source.mediaType);
          const artifact: StoredArtifact = { id: `sa-${randomUUID()}`, name: source.name, bytes: source.bytes, sha256: source.sha256, mediaType: source.mediaType, file: "" };
          artifact.file = `artifact-${artifact.id}.bin`;
          await assertNewCacheFile(path.join(root, artifact.file));
          await access(partition, action); await gate(); await writeSciencePrivateFile(root, artifact.file, bytes, { expectAbsent: true }); update.artifacts.push(artifact);
          await persist(copy(next));
        }
        await access(partition, action); await persist(next); await access(partition); return detail(update);
      }); },
      readArtifact(partition: SciencePartition, id: string, artifactId: string) { partition = { ...partition }; return operation(async () => {
        await access(partition); const row = instance(partition, id); requireValue(typeof artifactId === "string" && ARTIFACT_ID.test(artifactId), "registry-not-found");
        const artifact = row.artifacts.find(item => item.id === artifactId); requireValue(artifact, "registry-not-found");
        const bytes = await readArtifactBytes(root, artifact.file, artifact.bytes, artifact.sha256, true); validateMedia(bytes, artifact.mediaType); await access(partition);
        return { bytes, name: artifact.name, mediaType: artifact.mediaType, sha256: artifact.sha256 };
      }); },
      async close() {
        if (closed) return;
        await serializeWrite(path.join(root, "registry-operation"), async () => {
          if (closed) return; closed = true;
          await owned.handle.close();
        });
      },
    };
    return api;
  } catch (error) {
    await lock?.handle.close().catch(() => {});
    if (error instanceof ScienceRegistryError) throw error;
    throw new ScienceRegistryError("registry-unavailable");
  }
}
export type ScienceRegistry = Awaited<ReturnType<typeof openScienceRegistry>>;

async function readArtifactBytes(root: string, relativePath: string, size: number, sha256: string, cached: boolean) {
  try {
  requireValue(size <= MAX_BYTES && await fs.realpath(root) === root, "registry-artifact-refused");
  const file = path.join(root, relativePath); await assertNoLinks(root, file);
  const before = await fs.lstat(file); requireValue(before.isFile() && before.nlink === 1 && before.size === size && (!cached || before.uid === process.getuid?.() && (before.mode & 0o7777) === 0o600), "registry-artifact-refused");
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat(); requireValue(opened.isFile() && opened.nlink === 1 && opened.dev === before.dev && opened.ino === before.ino && await fs.realpath(`/proc/self/fd/${handle.fd}`) === file, "registry-artifact-refused");
    const bytes = Buffer.alloc(size + 1); let offset = 0;
    while (offset < bytes.length) { const result = await handle.read(bytes, offset, bytes.length - offset, offset); if (!result.bytesRead) break; offset += result.bytesRead; }
    const after = await handle.stat();
    requireValue(offset === size && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.nlink === 1, "registry-artifact-refused");
    const result = bytes.subarray(0, offset); requireValue(createHash("sha256").update(result).digest("hex") === sha256, "registry-artifact-refused"); return result;
  } finally { await handle.close(); }
  } catch { throw new ScienceRegistryError("registry-artifact-refused"); }
}
function validateMedia(bytes: Buffer, mediaType: ScienceArtifactMedia) {
  let valid = false;
  switch (mediaType) {
    case "image/png": valid = bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR"; break;
    case "image/jpeg": valid = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217; break;
    case "application/pdf": valid = bytes.toString("ascii", 0, 5) === "%PDF-"; break;
    case "text/csv": case "text/plain": try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); valid = !bytes.includes(0); } catch { valid = false; } break;
  }
  requireValue(valid, "registry-artifact-refused");
}
