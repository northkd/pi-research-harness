/** Host-only native Science HTTP adapter. Importing starts nothing. */
import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import * as fs from "node:fs/promises";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import path from "node:path";
import { writeSciencePrivateFile } from "../science-runtime.js";
import type { ScienceArtifactMedia, ScienceArtifactSource, ScienceObservation, ScienceRegistryDriver, ScienceRemoteBinding, ScienceSubmission } from "./science-registry.js";

const ORIGIN = "http://127.0.0.1:18765";
const DEFAULT_SELECTOR = "claude-pi-science-default";
const ARK = "ark-sci-deepseek-v4.1-flash";
const MODELS = new Set([ARK, "gpt-6.1-sol(max)", "gpt-6-astra(high)"]);
const PROJECT = /^proj_[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH = /^[0-9a-f]{64}$/;
const VERSION = /^[A-Za-z0-9_-]{1,96}$/;
const MAX_BYTES = 1024 * 1024;
const MAX_ROOTS = 8;
const MEDIA = new Set<ScienceArtifactMedia>(["image/png", "image/jpeg", "application/pdf", "text/csv", "text/plain"]);
const STATUSES = new Map<string, ScienceObservation["status"]>([
  ["processing", "running"], ["completed", "completed"], ["success", "completed"], ["failed", "failed"], ["cancelled", "cancelled"],
  ["awaiting_plan_approval", "waiting-approval"], ["awaiting_user_response", "waiting-approval"],
]);
type Action = "submit" | "reconcile" | "observe" | "cancel" | "artifacts";
type Code = "science-native-unavailable" | "science-native-invalid-input" | "science-native-response-invalid" | "science-native-outcome-unknown" | "science-native-artifact-refused";
export class ScienceNativeDriverError extends Error {
  readonly code: Code;
  constructor(code: Code) { super(code); this.name = "ScienceNativeDriverError"; this.code = code; }
}

export interface ScienceNativeRuntimeContext {
  projectId: string;
  binding?: ScienceRemoteBinding;
  intentId?: string;
  requestHash?: string;
  selectedModelId?: string;
  permittedModelIds?: string[];
}
export interface ScienceNativeDriverDeps {
  /** Host code checks its current controlled runtime receipt, process/profile identity and live action scope.
   * submit must prove every reachable configured role target is permitted, not just Ark.
   * cancel includes its read-only confirmation; no JSON/boolean installs a capability. */
  runtime: { assertCapability(action: Action, context: ScienceNativeRuntimeContext): Promise<void> };
  /** Host privately consumes its owned nonce; the adapter receives only the two cookies. */
  privateSession(): Promise<{ authCookie: string; csrfCookie: string }>;
  /** Explicit host selection bound to the durable intent/hash. No default or array-order inference. */
  selectedModelFor?(request: { projectId: string; intentId: string; requestHash: string }): Promise<string | null | undefined>;
  /** Same independent code-owned exact-task root resolver as registry.artifactRootFor. */
  artifactRootFor?(binding: ScienceRemoteBinding): Promise<string | null>;
  /** Host/test seam; never sourced from a client request or URL. Omit for the fixed native transport. */
  exchange?: ScienceNativeExchange;
}
export interface ScienceNativeWireRequest { method: "GET" | "POST"; path: string; headers: Record<string, string>; body?: Buffer; maxBytes: number; timeoutMs: number }
export interface ScienceNativeWireResponse { status: number; contentType: string; contentEncoding: string; complete: boolean; body: Uint8Array }
export type ScienceNativeExchange = (request: ScienceNativeWireRequest) => Promise<ScienceNativeWireResponse>;
interface Context { action: Action; data: ScienceNativeRuntimeContext; deadline: number; count: number; limit: number; secrets: Set<string> }
type NativeRow = Record<string, unknown>;
function requireValue(value: unknown, code: Code = "science-native-invalid-input"): asserts value { if (!value) throw new ScienceNativeDriverError(code); }
function object(value: unknown): value is NativeRow { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: NativeRow, names: string[]) { return Object.keys(value).length === names.length && Object.keys(value).every(name => names.includes(name)); }
function hash(value: unknown) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function cleanName(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 160 && !/[\x00-\x1f\x7f/\\]/.test(value) && value !== "." && value !== ".."; }
function privateString(value: string, ctx: Context) { return [...ctx.secrets].some(secret => value.includes(secret)); }
function context(action: Action, data: ScienceNativeRuntimeContext, limit: number): Context { return { action, data, limit, count: 0, deadline: performance.now() + 10000, secrets: new Set() }; }
function checkedBinding(raw: ScienceRemoteBinding): ScienceRemoteBinding {
  const value: unknown = structuredClone(raw);
  requireValue(object(value) && exact(value, ["projectId", "taskId", "rootFrameId", "frameId"]) && typeof value.projectId === "string" && PROJECT.test(value.projectId)
    && typeof value.rootFrameId === "string" && UUID.test(value.rootFrameId) && value.frameId === value.rootFrameId && value.taskId === value.rootFrameId);
  return value as unknown as ScienceRemoteBinding;
}
/** Native Science exposes a root frame, not a separate task object. All three
 * task/root/frame fields here deliberately anchor the same real upstream root ID. */
function bindingFor(projectId: string, root: unknown, frame: unknown, ctx: Context): ScienceRemoteBinding {
  requireValue(typeof root === "string" && UUID.test(root) && root === frame && !privateString(root, ctx), "science-native-response-invalid");
  return { projectId, taskId: root, rootFrameId: root, frameId: root };
}
function checkedRow(raw: unknown, binding: ScienceRemoteBinding): NativeRow {
  requireValue(object(raw) && raw.id === binding.frameId && raw.root_frame_id === binding.rootFrameId && raw.project_id === binding.projectId, "science-native-response-invalid");
  return raw;
}
function observation(raw: unknown, binding: ScienceRemoteBinding): ScienceObservation {
  const row = checkedRow(raw, binding);
  const pending = object(row.output_data) ? row.output_data.pending_input_requests : null;
  const privatePending = object(row.context_data) ? row.context_data._pending_input_requests : null;
  const hasPending = (value: unknown) => value !== null && value !== undefined && (!Array.isArray(value) || value.length > 0);
  const status = hasPending(pending) || hasPending(privatePending) ? "waiting-approval" : typeof row.status === "string" ? STATUSES.get(row.status) ?? "unknown" : "unknown";
  return { ...binding, status };
}

/** No proxy/DNS/redirect/browser policy. Fixed loopback peer and a whole-request
 * deadline include connect, headers, body and a streaming/truncated response. */
const nativeExchange: ScienceNativeExchange = wire => new Promise((resolve, reject) => {
  let outgoing: ClientRequest | undefined, incoming: IncomingMessage | undefined, settled = false;
  const finish = (result?: ScienceNativeWireResponse) => {
    if (settled) return; settled = true; clearTimeout(timer);
    if (result) resolve(result);
    else { outgoing?.destroy(); incoming?.destroy(); reject(new ScienceNativeDriverError("science-native-unavailable")); }
  };
  const timer = setTimeout(() => finish(), wire.timeoutMs);
  try {
    outgoing = httpRequest({ hostname: "127.0.0.1", port: 18765, method: wire.method, path: wire.path, headers: wire.headers, agent: false }, response => {
      incoming = response;
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => { if (settled) return; size += chunk.length; if (size > wire.maxBytes) finish(); else chunks.push(Buffer.from(chunk)); });
      response.once("aborted", () => finish()); response.once("error", () => finish());
      response.once("end", () => {
        if (!response.complete) { finish(); return; }
        const mime = response.headers["content-type"], encoding = response.headers["content-encoding"];
        if (typeof mime !== "string" || encoding !== undefined && typeof encoding !== "string") { finish(); return; }
        finish({ status: response.statusCode ?? 0, contentType: mime, contentEncoding: encoding ?? "identity", complete: true, body: Buffer.concat(chunks, size) });
      });
    });
    outgoing.once("error", () => finish()); outgoing.end(wire.body);
  } catch { finish(); }
});

async function guarded<T>(run: () => Promise<T>): Promise<T> {
  try { return await run(); } catch (error) { if (error instanceof ScienceNativeDriverError) throw error; throw new ScienceNativeDriverError("science-native-unavailable"); }
}
async function privateRoot(root: string) {
  requireValue(typeof root === "string" && path.isAbsolute(root) && path.resolve(root) === root && await fs.realpath(root) === root, "science-native-artifact-refused");
  const entry = await fs.lstat(root); requireValue(entry.isDirectory() && entry.uid === process.getuid?.() && (entry.mode & 0o7777) === 0o700, "science-native-artifact-refused");
  return entry;
}
function sameRoot(left: Stats, right: Stats) { requireValue(left.dev === right.dev && left.ino === right.ino, "science-native-artifact-refused"); }
async function existingBytes(root: string, file: string, bytes: Buffer): Promise<boolean> {
  const target = path.join(root, file); let before: Stats;
  try { before = await fs.lstat(target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
  requireValue(before.isFile() && before.nlink === 1 && before.uid === process.getuid?.() && (before.mode & 0o7777) === 0o600 && before.size === bytes.length, "science-native-artifact-refused");
  const handle = await fs.open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat(); requireValue(opened.dev === before.dev && opened.ino === before.ino && opened.isFile() && opened.nlink === 1 && await fs.realpath(`/proc/self/fd/${handle.fd}`) === target, "science-native-artifact-refused");
    const buffer = Buffer.alloc(bytes.length + 1); let offset = 0;
    while (offset < buffer.length) { const read = await handle.read(buffer, offset, buffer.length - offset, offset); if (!read.bytesRead) break; offset += read.bytesRead; }
    const after = await handle.stat();
    requireValue(offset === bytes.length && after.size === before.size && after.mtimeMs === before.mtimeMs && after.ctimeMs === before.ctimeMs && after.nlink === 1 && buffer.subarray(0, offset).equals(bytes), "science-native-artifact-refused");
    return true;
  } finally { await handle.close(); }
}
function mediaValid(bytes: Buffer, media: ScienceArtifactMedia) {
  switch (media) {
    case "image/png": return bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR";
    case "image/jpeg": return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
    case "application/pdf": return bytes.toString("ascii", 0, 5) === "%PDF-";
    default: try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return !bytes.includes(0); } catch { return false; }
  }
}

export function createScienceNativeRegistryDriver(deps: ScienceNativeDriverDeps): ScienceRegistryDriver {
  requireValue(typeof deps?.runtime?.assertCapability === "function" && typeof deps.privateSession === "function" && (deps.exchange === undefined || typeof deps.exchange === "function"), "science-native-unavailable");
  const exchange = deps.exchange ?? nativeExchange;
  const submitted = new Set<string>(), cancelled = new Set<string>(); // Registry owns the durable mutation latch across process restarts.
  async function gate(ctx: Context) { requireValue(await deps.runtime.assertCapability(ctx.action, structuredClone(ctx.data)) === undefined, "science-native-unavailable"); }
  async function send(ctx: Context, method: "GET" | "POST", endpoint: string, body?: unknown, media = "application/json", maximum = MAX_BYTES): Promise<Buffer> {
    await gate(ctx);
    const session = await deps.privateSession();
    requireValue(object(session) && exact(session, ["authCookie", "csrfCookie"]) && [session.authCookie, session.csrfCookie].every(value => typeof value === "string" && value.length > 0 && value.length <= 4096 && /^[\x21-\x7e]+$/.test(value) && !value.includes(";")), "science-native-unavailable");
    ctx.secrets.add(session.authCookie); ctx.secrets.add(session.csrfCookie);
    const encoded = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    requireValue(!privateString(endpoint, ctx) && (!encoded || !privateString(encoded.toString(), ctx)), "science-native-invalid-input");
    requireValue(++ctx.count <= ctx.limit, "science-native-unavailable");
    const headers: Record<string, string> = { Origin: ORIGIN, Cookie: `operon_auth=${session.authCookie}; operon_csrf=${session.csrfCookie}`, "Accept-Encoding": "identity" };
    if (method === "POST") { headers["x-operon-csrf"] = session.csrfCookie; headers["Content-Type"] = "application/json"; }
    await gate(ctx); // A delayed session lookup must not carry a revoked host grant across the send boundary.
    const timeoutMs = ctx.deadline - performance.now(); requireValue(timeoutMs > 0, "science-native-unavailable");
    const response = await exchange({ method, path: endpoint, headers, body: encoded, maxBytes: maximum, timeoutMs });
    requireValue(response.status === 200 && response.complete === true && typeof response.contentType === "string" && response.contentType.split(";", 1)[0].trim().toLowerCase() === media
      && typeof response.contentEncoding === "string" && ["", "identity"].includes(response.contentEncoding.trim().toLowerCase()) && response.body instanceof Uint8Array && response.body.byteLength <= maximum && performance.now() <= ctx.deadline, "science-native-response-invalid");
    return Buffer.from(response.body);
  }
  async function json(ctx: Context, method: "GET" | "POST", endpoint: string, body?: unknown): Promise<unknown> { return JSON.parse((await send(ctx, method, endpoint, body)).toString("utf8")); }
  async function read(binding: ScienceRemoteBinding, ctx: Context) { return observation(await json(ctx, "GET", `/api/frames/${binding.frameId}?shallow=true`), binding); }
  return {
    submit(raw) { return guarded(async () => {
      const request: unknown = structuredClone(raw);
      requireValue(object(request) && exact(request, ["projectId", "prompt", "modelIds", "materials", "intentId", "requestHash"]) && typeof request.projectId === "string" && PROJECT.test(request.projectId)
        && typeof request.prompt === "string" && Buffer.byteLength(request.prompt) > 0 && Buffer.byteLength(request.prompt) <= 16384 && !request.prompt.includes("\0")
        && typeof request.intentId === "string" && UUID.test(request.intentId) && typeof request.requestHash === "string" && HASH.test(request.requestHash)
        && Array.isArray(request.modelIds) && request.modelIds.length > 0 && request.modelIds.length <= 3 && request.modelIds.every(model => typeof model === "string" && MODELS.has(model)) && new Set(request.modelIds).size === request.modelIds.length
        && Array.isArray(request.materials), "science-native-invalid-input");
      // Material uploads have no verified contract yet; never silently drop an authorized manifest.
      requireValue(request.materials.length === 0 && request.modelIds.includes(ARK) && typeof deps.selectedModelFor === "function", "science-native-unavailable");
      const canonical: ScienceSubmission = { projectId: request.projectId, prompt: request.prompt, modelIds: [...request.modelIds as string[]].sort(), materials: [] };
      requireValue(hash(canonical) === request.requestHash);
      requireValue(!submitted.has(request.intentId), "science-native-outcome-unknown");
      requireValue(submitted.size < 128, "science-native-unavailable");
      const selected = await deps.selectedModelFor({ projectId: request.projectId, intentId: request.intentId, requestHash: request.requestHash });
      requireValue(selected === ARK, "science-native-unavailable");
      const ctx = context("submit", { projectId: request.projectId, intentId: request.intentId, requestHash: request.requestHash, selectedModelId: selected, permittedModelIds: [...request.modelIds as string[]] }, 1);
      await gate(ctx);
      requireValue(!submitted.has(request.intentId), "science-native-outcome-unknown");
      requireValue(submitted.size < 128, "science-native-unavailable"); submitted.add(request.intentId);
      try {
        const result = await json(ctx, "POST", `/api/projects/${request.projectId}/request`, { input_data: { request: request.prompt }, model: DEFAULT_SELECTOR, intent_id: request.intentId, task_source: "user", plan_mode: true });
        requireValue(object(result) && result.status === "accepted", "science-native-response-invalid");
        return bindingFor(request.projectId, result.root_frame_id, result.frame_id, ctx);
      } catch { throw new ScienceNativeDriverError("science-native-outcome-unknown"); }
    }); },
    reconcile(raw) { return guarded(async () => {
      const request: unknown = structuredClone(raw);
      requireValue(object(request) && exact(request, ["projectId", "intentId", "requestHash"]) && typeof request.projectId === "string" && PROJECT.test(request.projectId)
        && typeof request.intentId === "string" && UUID.test(request.intentId) && typeof request.requestHash === "string" && HASH.test(request.requestHash));
      const ctx = context("reconcile", { projectId: request.projectId, intentId: request.intentId, requestHash: request.requestHash }, MAX_ROOTS + 1);
      const rows = await json(ctx, "GET", `/api/frames?project_id=${request.projectId}&root_only=true&limit=${MAX_ROOTS}`);
      requireValue(Array.isArray(rows) && rows.length <= MAX_ROOTS, "science-native-response-invalid");
      const matches: ScienceRemoteBinding[] = [];
      for (const row of rows) {
        if (!object(row) || row.project_id !== request.projectId || typeof row.id !== "string" || !UUID.test(row.id)) continue;
        const candidate = bindingFor(request.projectId, row.id, row.id, ctx);
        const frame = checkedRow(await json(ctx, "GET", `/api/frames/${row.id}?shallow=true`), candidate);
        if (object(frame.input_data) && frame.input_data._intent_id === request.intentId) matches.push(candidate);
      }
      // The list may be truncated: no match never proves not-submitted and never triggers a POST.
      return matches.length === 1 ? matches[0] : null;
    }); },
    observe(raw) { return guarded(async () => { const binding = checkedBinding(raw); return read(binding, context("observe", { projectId: binding.projectId, binding }, 1)); }); },
    cancel(raw) { return guarded(async () => {
      const binding = checkedBinding(raw), key = `${binding.projectId}:${binding.taskId}`;
      if (cancelled.has(key)) return null;
      requireValue(cancelled.size < 128, "science-native-unavailable");
      const ctx = context("cancel", { projectId: binding.projectId, binding }, 3); await gate(ctx);
      if (cancelled.has(key)) return null;
      requireValue(cancelled.size < 128, "science-native-unavailable"); cancelled.add(key);
      const before = await read(binding, ctx); // The global Science identity is not an owner/cwd partition.
      if (before.status === "cancelled") return before;
      try { await json(ctx, "POST", `/api/frames/${binding.rootFrameId}/cancel?reason=science-host-user-cancelled`, {}); } catch { /* Unknown outcome is only reconciled by the next GET. */ }
      try { const result = await read(binding, ctx); return result.status === "cancelled" ? result : null; } catch { return null; }
    }); },
    artifacts(raw) { return guarded(async () => {
      const binding = checkedBinding(raw), ctx = context("artifacts", { projectId: binding.projectId, binding }, MAX_ROOTS + 1); await gate(ctx);
      requireValue(typeof deps.artifactRootFor === "function", "science-native-artifact-refused");
      const root = await deps.artifactRootFor(structuredClone(binding)); requireValue(typeof root === "string", "science-native-artifact-refused"); const identity = await privateRoot(root);
      const rows = await json(ctx, "GET", `/api/projects/${binding.projectId}/artifacts?exclude_intermediate=true&limit=${MAX_ROOTS}`);
      requireValue(Array.isArray(rows) && rows.length <= MAX_ROOTS, "science-native-response-invalid");
      const result: ScienceArtifactSource[] = [];
      for (const row of rows) {
        if (!object(row) || row.project_id !== binding.projectId || row.root_frame_id !== binding.rootFrameId || row.is_user_upload !== false || row.is_intermediate !== false || row.superseded_by_artifact_id != null) continue;
        requireValue(typeof row.version_id === "string" && VERSION.test(row.version_id) && !privateString(row.version_id, ctx) && cleanName(row.filename) && !privateString(row.filename, ctx)
          && typeof row.content_type === "string" && MEDIA.has(row.content_type as ScienceArtifactMedia) && Number.isSafeInteger(row.size_bytes) && (row.size_bytes as number) > 0 && (row.size_bytes as number) <= MAX_BYTES, "science-native-artifact-refused");
        const mediaType = row.content_type as ScienceArtifactMedia;
        const bytes = await send(ctx, "GET", `/api/artifacts/versions/${row.version_id}`, undefined, mediaType, row.size_bytes as number);
        requireValue(bytes.length === row.size_bytes && mediaValid(bytes, mediaType), "science-native-artifact-refused");
        // file_path/ref_host_path from Science are intentionally never used.
        const relativePath = `native-${hash([binding.projectId, binding.taskId, row.version_id])}.bin`;
        await gate(ctx); requireValue(await deps.artifactRootFor(structuredClone(binding)) === root, "science-native-artifact-refused"); sameRoot(identity, await privateRoot(root));
        if (!await existingBytes(root, relativePath, bytes)) await writeSciencePrivateFile(root, relativePath, bytes, { expectAbsent: true });
        sameRoot(identity, await privateRoot(root));
        result.push({ taskId: binding.taskId, root, relativePath, name: row.filename, mediaType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
      return result;
    }); },
  };
}
