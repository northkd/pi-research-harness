import { REDACTION_PLACEHOLDER, REDACTION_VERSION, redactSecrets } from "./redaction.js";
const SNAPSHOT_ASSISTANT_TEXT_MAX = 8192;
const SNAPSHOT_TOOL_CALLS_MAX = 5;
const SNAPSHOT_TOOL_SUMMARY_MAX = 120;
const SNAPSHOT_SCAN_WINDOW = 1e3;
const ASSISTANT_TEXT_INPUT_MAX = 4 * SNAPSHOT_ASSISTANT_TEXT_MAX;
const TOOL_SUMMARY_INPUT_MAX = 4096;
const REDACTION_MARGIN_CHARS = 256;
const SNAPSHOT_WORKFLOW_RUN_MAX = 8192;
const EXCLUDED_TOOLS = /* @__PURE__ */ new Set(["ask_user"]);
const SUMMARY_KEYS = ["command", "path", "file_path", "filePath", "pattern", "query", "url", "name", "description", "prompt"];
const SENSITIVE_KEY_RE = /pass(word|wd)?|secret|token|api[_-]?key|auth(orization)?|credential|private[_-]?key|cookie/i;
const REDACT_DEEP_MAX_DEPTH = 8;
const DEPTH_PLACEHOLDER = "[\u2026]";
function redactDeep(value, depth = 0) {
  if (typeof value === "string") return redactSecrets(value);
  if (!value || typeof value !== "object") return value;
  if (depth >= REDACT_DEEP_MAX_DEPTH) return DEPTH_PLACEHOLDER;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTION_PLACEHOLDER : redactDeep(v, depth + 1);
  }
  return out;
}
function assistantTextOf(data) {
  const msg = data?.message;
  if (msg?.role !== "assistant") return "";
  if (typeof msg.content === "string") return msg.content;
  if (!Array.isArray(msg.content)) return "";
  return msg.content.map((p) => p && typeof p === "object" && p.type === "text" && typeof p.text === "string" ? p.text : "").join("");
}
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
function summarizeArgs(args) {
  if (typeof args === "string") return oneLine(args);
  if (!args || typeof args !== "object") return "";
  const rec = args;
  for (const key of SUMMARY_KEYS) {
    if (typeof rec[key] === "string" && rec[key]) return oneLine(rec[key]);
  }
  for (const v of Object.values(rec)) if (typeof v === "string" && v) return oneLine(v);
  try {
    return oneLine(JSON.stringify(args) ?? "");
  } catch {
    return "";
  }
}
function hasRetentionGap(events) {
  if (events.length === 0) return false;
  if (events.length < SNAPSHOT_SCAN_WINDOW && events[0].seq > 1) return true;
  for (let i = 1; i < events.length; i++) if (events[i].seq - events[i - 1].seq > 1) return true;
  return false;
}
function capWorkflowRun(value) {
  let size;
  try {
    size = JSON.stringify(value)?.length ?? 0;
  } catch {
    size = Number.POSITIVE_INFINITY;
  }
  return size <= SNAPSHOT_WORKFLOW_RUN_MAX ? value : { truncated: true, originalChars: Number.isFinite(size) ? size : null };
}
function buildQuestionSnapshot(input) {
  const { eventStore, sessionId, metadata } = input;
  const maxSeq = eventStore.getMaxSeq(sessionId);
  const events = maxSeq > 0 ? eventStore.getEventsEndingAt(sessionId, 0, maxSeq, SNAPSHOT_SCAN_WINDOW) : [];
  let assistantText;
  const tools = [];
  for (let i = events.length - 1; i >= 0; i--) {
    const { event } = events[i];
    if (assistantText === void 0 && event.eventType === "message_end") {
      const text = assistantTextOf(event.data);
      if (text.trim()) assistantText = text;
    } else if (tools.length < SNAPSHOT_TOOL_CALLS_MAX && event.eventType === "tool_execution_start") {
      const data = event.data ?? {};
      const name = typeof data.toolName === "string" ? data.toolName : "";
      if (!name || EXCLUDED_TOOLS.has(name) || data.parentToolCallId) continue;
      const summary = redactSecrets(summarizeArgs(data.args).slice(0, TOOL_SUMMARY_INPUT_MAX + REDACTION_MARGIN_CHARS)).slice(0, SNAPSHOT_TOOL_SUMMARY_MAX);
      tools.push({ name: redactSecrets(name.slice(0, SNAPSHOT_TOOL_SUMMARY_MAX)), summary });
    }
    if (assistantText !== void 0 && tools.length >= SNAPSHOT_TOOL_CALLS_MAX) break;
  }
  tools.reverse();
  const snapshot = { toolCalls: tools, redactionVersion: REDACTION_VERSION };
  if (assistantText !== void 0) {
    snapshot.assistantText = redactSecrets(assistantText.slice(-ASSISTANT_TEXT_INPUT_MAX)).slice(-SNAPSHOT_ASSISTANT_TEXT_MAX);
  } else {
    snapshot.assistantAbsentReason = hasRetentionGap(events) ? "evicted" : "none";
  }
  if (metadata && metadata.workflowRun !== void 0) snapshot.workflowRun = capWorkflowRun(redactDeep(metadata.workflowRun));
  return snapshot;
}
export {
  SNAPSHOT_ASSISTANT_TEXT_MAX,
  buildQuestionSnapshot,
  redactDeep
};
