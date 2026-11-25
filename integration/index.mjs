import { resolveRoute } from "./src/routes.mjs";
import { buildManifest } from "./src/artifacts.mjs";
import { derivationGate, fetchEvidence, reviewGate, searchEvidence } from "./src/fusion.mjs";

const PARAMETERS = {
  type: "object", additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["route", "search", "fetch", "review-gate", "derivation-gate", "manifest"] },
    backend: { type: "string" }, role: { type: "string" }, profile: { type: "string" }, alias: { type: "string" }, tool: { type: "string" },
    model: { type: ["string", "object"] }, topic: { type: "string" }, root: { type: "string" }, source: { type: "string" }, query: { type: "string" }, queries: { type: "array", items: { type: "string" } },
    urls: { type: "array", items: { type: "string" } }, url: { type: "string" }, databaseSource: { type: "string" }, limit: { type: "number" }, sort: { type: "string" }, numResults: { type: "number" }, provider: { type: "string" }, recencyFilter: { type: "string" }, mode: { type: "string" }, answerModel: { type: "string" },
    responses: { type: "array" }, requiredRounds: { type: "number" }, requireThread: { type: "boolean" }, juryBackend: { type: "string" }, juryModel: { type: "string" }, derivations: { type: "array" }, counterexample: { type: "object" }, unresolvedObligations: { type: "array" }, stages: { type: "array" },
  }, required: ["action"],
};
function executorContext(ctx) {
  const tools = Array.isArray(ctx?.tools) ? ctx.tools : [];
  const registeredTools = tools.map((tool) => ({ name: tool.name, namespace: tool.namespace?.name ?? tool.namespace }));
  const mcpReviewTools = {};
  for (const tool of registeredTools) {
    if (tool.namespace === "mcp__codex" && tool.name === "codex") mcpReviewTools.codex = tool.name;
    if (tool.namespace === "mcp__manual_review" && tool.name === "review") mcpReviewTools.manual = tool.name;
  }
  return { registeredTools, mcpReviewTools };
}
function output(value, isError = false) { return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: value, isError }; }
export async function executeResearchAction(params, ctx, signal, onUpdate) {
  const action = params?.action; const executor = executorContext(ctx);
  if (action === "route") return resolveRoute(params, executor);
  if (action === "search") return searchEvidence(ctx, params, signal, onUpdate);
  if (action === "fetch") return fetchEvidence(ctx, params, signal, onUpdate);
  if (action === "review-gate") return reviewGate({ ...params, executor });
  if (action === "derivation-gate") return derivationGate({ ...params, executor });
  if (action === "manifest") return buildManifest(params.root, params.topic, params.stages);
  return { status: "blocked", code: "unknown-action", reason: "Choose route, search, fetch, review-gate, derivation-gate, or manifest." };
}
export default function registerResearchIntegration(pi) {
  pi.registerTool({ name: "pi_research_fusion", label: "Research Fusion", description: "Thin Pi-native research adapters: preserve web/Feynman tool observations, expose explicit route diagnostics, compose review/derivation gates, and map Feynman draft artifacts into ARIS paper-stage paths. It never invents reviewer backends or model identity.", promptSnippet: "Use for source-backed research adapters, route diagnostics, evidence gates, and Feynman-to-ARIS artifact mapping.", parameters: PARAMETERS, annotations: { readOnlyHint: true, openWorldHint: false }, async execute(_toolCallId, params, signal, onUpdate, ctx) {
    try {
      const value = await executeResearchAction(params, ctx, signal, onUpdate);
      const isError = value?.status === "failed" || value?.status === "blocked" || value?.status === "cancelled" || value?.verdict === "blocked";
      return output(value, isError);
    } catch (error) { return output({ status: "failed", error: error instanceof Error ? error.message : String(error) }, true); }
  } });
}
export { buildManifest };
