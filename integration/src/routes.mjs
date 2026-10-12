const EFFORTS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const ARIS_REVIEW_PIN = Object.freeze({ model: "gpt-6-astra", effort: "ultra", identity: "unverified" });
export const EXTERNAL_PROFILES = Object.freeze({
  "codex-exec": { profile: "codex-exec", unsupported: ["modelOverride", "structuredOutput", "fork", "resume", "steer"] },
  "codex-exec-writer": { profile: "codex-exec-writer", unsupported: ["modelOverride", "structuredOutput", "fork", "resume", "steer"] },
  "claude-code": { profile: "claude-code", unsupported: ["modelOverride", "structuredOutput", "fork", "resume", "steer"] },
  "claude-code-writer": { profile: "claude-code-writer", unsupported: ["modelOverride", "structuredOutput", "fork", "resume", "steer"] },
});
const NATIVE_AGENTS = Object.freeze({ author: "worker", internalReviewer: "reviewer", derivation: "oracle", numericalChecker: "reviewer", jury: "reviewer" });
const clone = (value) => { if (value === undefined) return undefined; try { return JSON.parse(JSON.stringify(value)); } catch { return { uncopyable: true }; } };
function effort(value) { if (value === undefined || value === null || value === "") return undefined; if (typeof value !== "string" || !EFFORTS.has(value.trim())) return { error: `effort must be one of ${[...EFFORTS].join(", ")}` }; return value.trim(); }

export function normalizeModelPin(value, label = "model") {
  if (value === undefined || value === null || value === "") return { pin: undefined };
  let raw; let pinEffort;
  if (typeof value === "string") raw = value.trim();
  else if (value && typeof value === "object" && !Array.isArray(value)) {
    raw = typeof value.model === "string" ? value.model.trim() : undefined;
    pinEffort = value.effort;
  }
  if (!raw) return { error: `${label} must be an explicit model label.` };
  const e = effort(pinEffort);
  if (e && typeof e === "object") return e;
  return { pin: { requested: raw, ...(e ? { effort: e } : {}) } };
}

function explicitModel(input) {
  const raw = input.modelPin ?? input.model;
  const normalized = normalizeModelPin(raw);
  return normalized.error ? normalized : { source: "explicit-per-run", pin: normalized.pin };
}

function toolNames(executor) {
  return new Set((Array.isArray(executor?.registeredTools) ? executor.registeredTools : []).map((x) => typeof x === "string" ? x : x?.name).filter(Boolean));
}
function observed(value) { return value && typeof value.modelId === "string" && typeof value.family === "string" ? value : undefined; }
export function independentModelCheck(executor = {}) {
  const ro = observed(executor.reviewerObservation); const ao = observed(executor.authorObservation);
  if (!ro || !ao) return { status: "unknown", reason: "Pi executor has not supplied trusted observed model and family evidence" };
  if (ro.modelId === ao.modelId) return { status: "blocked", reason: "reviewer and author resolve to the same observed model" };
  if (ro.family === ao.family) return { status: "blocked", reason: "reviewer and author are in the same observed model family" };
  return { status: "independent", reviewerFamily: ro.family, authorFamily: ao.family };
}

export function resolveRoute(input = {}, executor = {}) {
  const request = input && typeof input === "object" ? input : {};
  const backend = typeof request.backend === "string" ? request.backend : "native";
  const model = explicitModel(request);
  if (model.error) return { status: "blocked", code: "invalid-model-pin", reason: model.error, request: clone(request) };
  const base = { request: clone(request), ...(model.pin ? { requestedModel: model.pin, modelSource: model.source } : {}) };
  const role = request.role ?? "author";
  const needsIndependent = request.requireIndependent === true || role === "jury" || role === "externalReviewer";
  const independence = needsIndependent ? independentModelCheck(executor) : undefined;
  const independenceAcceptance = needsIndependent
    ? (independence?.status === "independent" ? "eligible-after-observation" : "blocked-until-observation")
    : undefined;
  const pinObservation = executor.reviewerObservation;
  const pinCheck = (requiredPin) => {
    if (!requiredPin) return undefined;
    if (!pinObservation || typeof pinObservation.modelId !== "string" || typeof pinObservation.effort !== "string") return { status: "unknown", reason: "required reviewer model/effort has not been observed by Pi" };
    if (pinObservation.modelId !== requiredPin.model) return { status: "blocked", reason: "observed reviewer model does not match the required ARIS pin" };
    if (pinObservation.effort !== requiredPin.effort) return { status: "blocked", reason: "observed reviewer effort does not match the required ARIS pin" };
    if (Array.isArray(executor.thinkingLevels) && !executor.thinkingLevels.includes(requiredPin.effort)) return { status: "blocked", reason: "the executor does not advertise the required reviewer effort" };
    return { status: "eligible" };
  };

  if (backend === "native") {
    if (model.pin?.effort === "ultra") return { ...base, status: "blocked", code: "native-effort-unsupported", reason: "Pi native thinking levels do not include ultra; do not silently downgrade the requested effort." };
    return {
      ...base, status: "ready", kind: "native-pi-subagent",
      agent: request.agent || NATIVE_AGENTS[role] || "worker",
      context: request.context === "fork" ? "fork" : "fresh",
      execution: "runs.run|runs.all|runs.lanes", modelOverride: Boolean(model.pin),
      ...(independenceAcceptance ? { independence, acceptance: independenceAcceptance } : {}),
    };
  }

  if (backend === "external-cli") {
    const name = typeof request.profile === "string" ? request.profile : "";
    const profile = EXTERNAL_PROFILES[name];
    if (!profile) return { ...base, status: "blocked", code: "unknown-external-profile", reason: "Only installed code-owned external profiles are allowed." };
    if (model.pin || request.effort) return { ...base, status: "blocked", code: "external-model-override-unsupported", reason: `${name} does not support native model or effort overrides; pass only an explicit profile ID.`, profile };
    return { ...base, status: "provisional", kind: "pi-subagents-external-cli", profile, acceptance: "advisory-only", reason: "Pi owns the external profile; launch-time identity and authentication are unverified, so this route cannot certify an ARIS reviewer pin." };
  }

  if (backend === "mcp" || backend === "manual") {
    const alias = request.alias || request.tool;
    const mapped = executor.mcpReviewTools && typeof alias === "string" ? executor.mcpReviewTools[alias] : undefined;
    const tool = mapped || (typeof request.tool === "string" && toolNames(executor).has(request.tool) ? request.tool : undefined);
    if (!tool || !toolNames(executor).has(tool)) return { ...base, status: "blocked", code: "reviewer-backend-unavailable", reason: "No configured reviewer MCP tool is registered in this Pi session; research-browser is not a Codex/manual reviewer.", alias };
    const requiredPin = backend === "mcp" && role === "externalReviewer" ? ARIS_REVIEW_PIN : undefined;
    const observedPin = pinCheck(requiredPin);
    return { ...base, status: "ready", kind: backend === "mcp" ? "mcp-reviewer" : "manual-review-mcp", tool, alias, independence, acceptance: independenceAcceptance ?? "eligible-after-response-contract", requiredPin, observedPin, requireReviewerModel: backend === "manual" };
  }

  if (backend === "ssh") return { ...base, status: "blocked", code: "ssh-route-not-activated", reason: "SSH route is reserved but this integration does not read or change SSH configuration." };
  return { ...base, status: "blocked", code: "unknown-backend", reason: `Unsupported backend: ${backend}` };
}

export const externalProfile = (name) => EXTERNAL_PROFILES[name];
