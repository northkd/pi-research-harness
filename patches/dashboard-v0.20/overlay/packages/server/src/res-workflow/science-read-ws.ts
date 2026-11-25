/** Host-only, transport-free contract for the pinned native Science event stream. */
import { performance } from "node:perf_hooks";

export const SCIENCE_READ_WS_UPSTREAM_PATH = "/api/ws?explicit_subscribe=1";
export const SCIENCE_READ_WS_SOURCE_PINS = Object.freeze({
  binarySha256: "2139fa524389ec338ad86d50f66e7e7d0c4aa8bf9d7036a15fb196b5bde6a31b",
  mainJsSha256: "efede46f82c2c615bfb352c633795e8fe9e86b16406a682046d0f82754cb468d",
  explicitSubscribeByteOffset: 103528426,
  frameUpdateByteOffset: 97222336,
  textChunkByteOffset: 97230228,
  messageDeltaByteOffset: 97234080,
  projectCreationByteOffset: 99940116,
});
export interface ScienceReadWsBinding { projectId: string; taskId: string; rootFrameId: string; frameId: string }
type Reason = "closed" | "scope-unavailable" | "invalid-message" | "unsupported-message" | "scope-mismatch" | "frame-unverified" | "presence-ignored" | "already-subscribed" | "message-budget" | "byte-budget" | "queue-budget";
export type ScienceReadWsDecision = { action: "forward"; message: string } | { action: "drop" | "close"; reason: Reason };
export interface ScienceReadWsDeps {
  binding: ScienceReadWsBinding;
  /** Live owner/canonical-cwd lease and exact native binding check, supplied by trusted host code. */
  revalidate(): Promise<void>;
  /** Fresh, independent same-project/root proof for a descendant. An event cannot prove its own scope. */
  assertFrame?(frameId: string, binding: Readonly<ScienceReadWsBinding>): Promise<void>;
  /** Host test clock only; never derived from a packet. */
  now?: () => number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROJECT = /^proj_[0-9a-f]{12}$/;
const MAX_MESSAGE_BYTES = 65536;
const MAX_WINDOW_BYTES = 524288;
const MAX_MESSAGES = 200;
const MAX_PENDING = 16;
const STATUSES = new Set(["processing", "completed", "failed", "success", "replaced", "cancelled", "awaiting_plan_approval", "awaiting_user_response"]);
const PRESENCE = new Set(["view_session", "unview_session", "session_attention"]);
const FRAME_FIELDS = ["type", "project_id", "root_frame_id", "frame_id", "status", "agent_name", "delegate_name", "parent_frame_id", "conversation_type", "name", "task_summary", "status_description", "mentioned_files", "specialists_used", "is_hidden", "starred_at", "plan_claims", "step_statuses", "plan_pointers", "sent_user_messages", "has_pending_input", "pending_input_requests", "message_count", "user_message_count", "latest_tool_block", "created_at", "updated_at", "completed_at", "model", "effort", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_cost", "aux_cost", "running_children", "running_executions", "metadata_only"];
const FRAME_COUNTS = ["message_count", "user_message_count"];
const FRAME_FLAGS = ["has_pending_input", "is_hidden", "metadata_only"];
const FRAME_SCOPE = ["type", "project_id", "root_frame_id", "frame_id", "status"];
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function shape(value: Record<string, unknown>, required: string[], allowed = required): boolean { return required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => allowed.includes(key)); }
function uuid(value: unknown): value is string { return typeof value === "string" && UUID.test(value); }
function count(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function privateText(value: string): boolean { return /(?:https?|wss?):\/\/[^\s]*[?&](?:nonce|token|access_token|auth_token|api[_-]?key|secret|csrf)=/i.test(value) || /\bBearer\s+[A-Za-z0-9._~-]{8,}|operon-csrf\./i.test(value); }
function parse(raw: string): Record<string, unknown> | null {
  try { const value: unknown = JSON.parse(raw); return record(value) && JSON.stringify(value) === raw ? value : null; } catch { return null; }
}
function drop(reason: Reason): ScienceReadWsDecision { return { action: "drop", reason }; }
function forward(value: Record<string, unknown>): ScienceReadWsDecision { return { action: "forward", message: JSON.stringify(value) }; }
function projectText(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!shape(value, ["type", "root_frame_id", "frame_id", "chunk", "block_type"]) || typeof value.chunk !== "string" || value.chunk.length > MAX_MESSAGE_BYTES || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value.chunk) || privateText(value.chunk) || typeof value.block_type !== "string" || !["text", "thinking"].includes(value.block_type)) return null;
  return { type: value.type, root_frame_id: value.root_frame_id, frame_id: value.frame_id, chunk: value.chunk, block_type: value.block_type };
}
function projectFrame(value: Record<string, unknown>): Record<string, unknown> | null {
  if (!shape(value, FRAME_SCOPE, FRAME_FIELDS) || typeof value.status !== "string" || !STATUSES.has(value.status) || FRAME_COUNTS.some(key => value[key] !== undefined && !count(value[key])) || FRAME_FLAGS.some(key => value[key] !== undefined && typeof value[key] !== "boolean") || value.is_hidden === true) return null;
  const projected: Record<string, unknown> = { type: value.type, project_id: value.project_id, root_frame_id: value.root_frame_id, frame_id: value.frame_id, status: value.status };
  for (const key of [...FRAME_COUNTS, ...FRAME_FLAGS]) if (value[key] !== undefined) projected[key] = value[key];
  return projected;
}
function projectEvent(value: Record<string, unknown>): Record<string, unknown> | null {
  switch (value.type) {
    case "text_chunk": return projectText(value);
    case "text_reset":
      return shape(value, ["type", "root_frame_id", "frame_id"]) ? { type: value.type, root_frame_id: value.root_frame_id, frame_id: value.frame_id } : null;
    case "frame_messages_delta":
      if (!shape(value, ["type", "root_frame_id", "frame_id", "base_idx", "appended"]) || !count(value.base_idx) || value.appended !== null && (!Array.isArray(value.appended) || value.appended.length > 128)) return null;
      // Native tV(frame, base, null) invalidates only that message window. Never forward nested messages.
      return { type: value.type, root_frame_id: value.root_frame_id, frame_id: value.frame_id, base_idx: value.base_idx, appended: null };
    case "frame_update": return projectFrame(value);
    default: return null;
  }
}

/** No socket, URL, cookie, service control or model capability is created here. */
export function createScienceReadWsFilter(deps: ScienceReadWsDeps) {
  if (!record(deps?.binding) || !shape(deps.binding, ["projectId", "taskId", "rootFrameId", "frameId"]) || typeof deps.binding.projectId !== "string" || !PROJECT.test(deps.binding.projectId) || ![deps.binding.taskId, deps.binding.rootFrameId, deps.binding.frameId].every(uuid) || deps.binding.taskId !== deps.binding.rootFrameId || typeof deps.revalidate !== "function" || deps.assertFrame !== undefined && typeof deps.assertFrame !== "function" || deps.now !== undefined && typeof deps.now !== "function") throw new Error("science-read-ws-invalid-context");
  const binding = Object.freeze({ ...deps.binding });
  const revalidate = deps.revalidate; const assertFrame = deps.assertFrame;
  const now = deps.now ?? (() => performance.now());
  const budget = { browser: { at: 0, bytes: 0, messages: 0 }, server: { at: 0, bytes: 0, messages: 0 } };
  let closed: Reason | null = null; let subscribed = false; let pending = 0; let tail: Promise<unknown> = Promise.resolve();
  function end(reason: Reason): ScienceReadWsDecision { closed ??= reason; return { action: "close", reason: closed }; }
  async function active(): Promise<boolean> {
    if (closed) return false;
    try { const result = await revalidate(); if (result !== undefined || closed) { end("scope-unavailable"); return false; } return true; }
    catch { end("scope-unavailable"); return false; }
  }
  function run(task: () => Promise<ScienceReadWsDecision>): Promise<ScienceReadWsDecision> {
    if (closed) return Promise.resolve(end(closed));
    if (pending >= MAX_PENDING) return Promise.resolve(end("queue-budget"));
    pending++;
    const result = tail.then(async () => closed ? end(closed) : task()).catch(() => end("scope-unavailable"));
    tail = result;
    return result.finally(() => { pending--; });
  }
  function consumeBudget(direction: "browser" | "server", bytes: number): ScienceReadWsDecision | null {
    let at: number;
    try { at = now(); } catch { return end("scope-unavailable"); }
    if (!Number.isFinite(at) || at < 0) return end("scope-unavailable");
    const row = budget[direction];
    if (at - row.at >= 1000) { row.at = at; row.bytes = 0; row.messages = 0; }
    row.bytes += bytes; row.messages++;
    if (row.messages > MAX_MESSAGES) return end("message-budget");
    if (row.bytes > MAX_WINDOW_BYTES) return end("byte-budget");
    return null;
  }
  function reserve(direction: "browser" | "server", raw: unknown): { text: string } | ScienceReadWsDecision {
    if (closed) return end(closed);
    if (typeof raw !== "string") return end("invalid-message");
    if (raw.length > MAX_MESSAGE_BYTES) return end("byte-budget");
    const bytes = Buffer.byteLength(raw);
    if (bytes > MAX_MESSAGE_BYTES) return end("byte-budget");
    return consumeBudget(direction, bytes) ?? { text: raw };
  }
  async function provenFrame(id: unknown): Promise<boolean> {
    if (!uuid(id)) return false;
    if (id === binding.rootFrameId || id === binding.frameId) return true;
    if (!assertFrame) return false;
    try { return await assertFrame(id, binding) === undefined; } catch { return false; }
  }
  async function checkedForward(value: Record<string, unknown>): Promise<ScienceReadWsDecision> { return await active() ? forward(value) : end("scope-unavailable"); }
  async function browserMessage(value: Record<string, unknown>): Promise<ScienceReadWsDecision> {
    if (value.type === "ping" && shape(value, ["type"])) return checkedForward({ type: "ping" });
    if (typeof value.type === "string" && PRESENCE.has(value.type) && shape(value, ["type", "root_frame_id"]) && value.root_frame_id === binding.rootFrameId) return drop("presence-ignored");
    return drop("unsupported-message");
  }
  async function serverMessage(value: Record<string, unknown>): Promise<ScienceReadWsDecision> {
    if (value.type === "pong" && shape(value, ["type"])) return checkedForward({ type: "pong" });
    const projected = projectEvent(value);
    if (!projected) return drop("unsupported-message");
    if (value.root_frame_id !== binding.rootFrameId || value.type === "frame_update" && value.project_id !== binding.projectId) return drop("scope-mismatch");
    if (!await provenFrame(value.frame_id)) return drop("frame-unverified");
    return checkedForward(projected);
  }
  function message(direction: "browser" | "server", raw: unknown): Promise<ScienceReadWsDecision> {
    const reserved = reserve(direction, raw);
    if (!("text" in reserved)) return Promise.resolve(reserved);
    return run(async () => {
      if (!await active()) return end("scope-unavailable");
      const value = parse(reserved.text);
      if (!value) return drop("invalid-message");
      return direction === "browser" ? browserMessage(value) : serverMessage(value);
    });
  }
  return {
    upstreamPath: SCIENCE_READ_WS_UPSTREAM_PATH,
    hostSubscribe(): Promise<ScienceReadWsDecision> { return run(async () => {
      if (!await active()) return end("scope-unavailable");
      if (subscribed) return drop("already-subscribed");
      if (!await active()) return end("scope-unavailable");
      subscribed = true; return forward({ type: "subscribe", root_frame_id: binding.rootFrameId });
    }); },
    fromBrowser(raw: unknown) { return message("browser", raw); },
    fromServer(raw: unknown) { return message("server", raw); },
    close() { end("closed"); },
  };
}
