import { loadConfig } from "../../host-paths.mjs";
import { parse as parseYaml } from "../../vendor/yaml/browser/dist/index.js";
import {
  categoryForOnKind,
  onKindForCategory,
  TRIGGER_TAXONOMY
} from "./trigger-registry.js";
import { normalizeActionKind } from "./action-registry.js";
const TAXONOMY_KINDS = new Set(
  TRIGGER_TAXONOMY.map((c) => onKindForCategory(c.category))
);
const MULTI_TYPE_CATEGORIES = new Set(
  TRIGGER_TAXONOMY.filter((c) => c.multiType).map((c) => c.category)
);
const MODES = ["worktree", "local"];
const SANDBOXES = ["read-only", "workspace-write", "full-access"];
const CONCURRENCIES = ["skip", "queue", "parallel"];
const VISIBILITIES = ["hidden", "shown"];
const DEFAULT_MODE = "worktree";
const DEFAULT_SANDBOX = "workspace-write";
const DEFAULT_CONCURRENCY = "skip";
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function parseAutomationYaml(rawText, knownKinds, knownActionIds = /* @__PURE__ */ new Set(), knownSourceIds = /* @__PURE__ */ new Set(), knownAgentIds) {
  let doc;
  try {
    doc = parseYaml(rawText);
  } catch (e) {
    return { error: `YAML parse error: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isRecord(doc)) {
    return { error: "automation.yaml must be a mapping" };
  }
  const on = doc.on;
  if (!isRecord(on)) {
    return { error: "missing or invalid `on:` trigger block" };
  }
  const kind = on.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    return { error: "`on.kind` must be a non-empty string" };
  }
  if (!knownKinds.has(kind) && !TAXONOMY_KINDS.has(kind)) {
    return { error: `unknown trigger kind: "${kind}"` };
  }
  const category = categoryForOnKind(kind);
  let events;
  if (on.events !== void 0) {
    if (!Array.isArray(on.events) || on.events.length === 0 || !on.events.every((e) => typeof e === "string" && e.length > 0)) {
      return { error: "`on.events` must be a non-empty array of event-type strings" };
    }
    events = on.events;
  }
  if (MULTI_TYPE_CATEGORIES.has(category) && !events) {
    return {
      error: `trigger category "${category}" requires a non-empty \`on.events\` selection`
    };
  }
  const isBatch = kind === "schedule.batch";
  if (isBatch) {
    const source = on.source;
    if (typeof source !== "string" || source.length === 0) {
      return { error: "`schedule.batch` requires a non-empty `on.source`" };
    }
    if (!knownSourceIds.has(source)) {
      return { error: `unknown work source: "${source}"` };
    }
  }
  const action = doc.action;
  const actionsRaw = doc.actions;
  if (action !== void 0 && actionsRaw !== void 0) {
    return { error: "`action` and `actions` are mutually exclusive \u2014 declare only one" };
  }
  if (action === void 0 && actionsRaw === void 0) {
    return { error: "missing `action:` or `actions:` block" };
  }
  if (isBatch && actionsRaw !== void 0) {
    return {
      error: "`schedule.batch` requires a single `action:` (one leased item \u2192 one child); `actions:` is not allowed"
    };
  }
  let singleAction;
  let actions;
  if (actionsRaw !== void 0) {
    if (!Array.isArray(actionsRaw) || actionsRaw.length === 0) {
      return { error: "`actions` must be a non-empty array" };
    }
    actions = [];
    for (let i = 0; i < actionsRaw.length; i++) {
      const entry = actionsRaw[i];
      if (!isRecord(entry)) {
        return { error: `actions[${i}]: must be a mapping` };
      }
      const r = validateAction(entry, knownActionIds);
      if ("error" in r) return { error: `actions[${i}]: ${r.error}` };
      actions.push(r.value);
    }
  } else {
    if (!isRecord(action)) {
      return { error: "missing or invalid `action:` block" };
    }
    const actionResult = validateAction(action, knownActionIds);
    if ("error" in actionResult) return { error: actionResult.error };
    singleAction = actionResult.value;
  }
  if (isBatch && singleAction?.count !== void 0) {
    return {
      error: "`count` is not allowed on a `schedule.batch` action \u2014 fan-out width is the number of leased items"
    };
  }
  let maxConcurrentSpawns;
  if (doc.maxConcurrentSpawns !== void 0) {
    const m = doc.maxConcurrentSpawns;
    if (typeof m !== "number" || !Number.isInteger(m) || m < 1) {
      return { error: "`maxConcurrentSpawns` must be an integer >= 1" };
    }
    maxConcurrentSpawns = m;
  }
  const agentResult = validateAgent(doc.agent, [singleAction, ...actions ?? []], knownAgentIds);
  if ("error" in agentResult) return { error: agentResult.error };
  const agent = agentResult.agent;
  const model = doc.model === void 0 && agent ? "" : doc.model;
  if (typeof model !== "string" || model.length === 0 && !agent) {
    return { error: "`model` must be a non-empty string (a provider/model id or @role)" };
  }
  const mode = pickEnum(doc.mode, MODES, DEFAULT_MODE, "mode");
  if ("error" in mode) return { error: mode.error };
  const sandbox = pickEnum(doc.sandbox, SANDBOXES, DEFAULT_SANDBOX, "sandbox");
  if ("error" in sandbox) return { error: sandbox.error };
  const concurrency = pickEnum(doc.concurrency, CONCURRENCIES, DEFAULT_CONCURRENCY, "concurrency");
  if ("error" in concurrency) return { error: concurrency.error };
  let visibility;
  if (doc.visibility !== void 0) {
    if (typeof doc.visibility !== "string" || !VISIBILITIES.includes(doc.visibility)) {
      return { error: `\`visibility\` must be one of ${VISIBILITIES.join(" | ")}` };
    }
    visibility = doc.visibility;
  }
  let disabled;
  if (doc.disabled !== void 0) {
    if (typeof doc.disabled !== "boolean") {
      return { error: "`disabled` must be a boolean" };
    }
    disabled = doc.disabled;
  }
  const config = {
    on: { ...on, kind, ...events ? { events } : {} },
    ...singleAction ? { action: singleAction } : {},
    ...actions ? { actions } : {},
    ...maxConcurrentSpawns !== void 0 ? { maxConcurrentSpawns } : {},
    ...agent ? { agent } : {},
    model,
    mode: mode.value,
    sandbox: sandbox.value,
    concurrency: concurrency.value,
    ...visibility ? { visibility } : {},
    ...disabled ? { disabled } : {}
  };
  return { config };
}
function validateAgent(raw, actions, knownAgentIds) {
  if (raw === void 0) return {};
  if (typeof raw !== "string" || raw.length === 0) return { error: "`agent` must be a non-empty string" };
  const known = knownAgentIds ?? new Set(loadConfig().acpAgents.map((a) => a.id));
  if (!known.has(raw)) return { error: `unknown ACP agent: "${raw}"` };
  for (const a of actions) {
    if (a && normalizeActionKind(a.kind) !== "core.prompt") {
      return { error: `an automation with \`agent\` only supports the core.prompt action (got "${a.kind}")` };
    }
  }
  return { agent: raw };
}
function validateAction(action, knownActionIds) {
  const kind = action.kind;
  if (typeof kind !== "string" || kind.length === 0) {
    return { error: "`action.kind` must be a non-empty string" };
  }
  let payload;
  if (action.payload !== void 0) {
    if (!isRecord(action.payload)) {
      return { error: "`action.payload` must be a mapping" };
    }
    payload = action.payload;
  }
  let count;
  if (action.count !== void 0) {
    const c = action.count;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1) {
      return { error: "`count` must be an integer >= 1" };
    }
    count = c;
  }
  const withPayload = (v) => {
    let out = v;
    if (payload) out = { ...out, payload };
    if (count !== void 0) out = { ...out, count };
    return out;
  };
  if (kind === "prompt") {
    const prompt = action.prompt;
    if (typeof prompt !== "string" || prompt.length === 0) {
      return { error: "`action.prompt` must be a path string for prompt actions" };
    }
    return { value: withPayload({ kind: "prompt", prompt }) };
  }
  if (kind === "skill") {
    const skill = action.skill;
    if (typeof skill !== "string" || skill.length === 0) {
      return { error: "`action.skill` must be a `$skill-name` string for skill actions" };
    }
    return { value: withPayload({ kind: "skill", skill }) };
  }
  if (knownActionIds.has(kind)) {
    return { value: withPayload({ kind }) };
  }
  return { error: `unknown action kind: "${kind}"` };
}
function pickEnum(raw, allowed, fallback, field) {
  if (raw === void 0) return { value: fallback };
  if (typeof raw !== "string" || !allowed.includes(raw)) {
    return { error: `\`${field}\` must be one of ${allowed.join(" | ")}` };
  }
  return { value: raw };
}
export {
  parseAutomationYaml
};
