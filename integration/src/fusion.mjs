import { artifactPaths, buildManifest } from "./artifacts.mjs";
import { independentModelCheck, resolveRoute } from "./routes.mjs";

const textOf = (result) => (Array.isArray(result?.content) ? result.content.filter((item) => item?.type === "text").map((item) => item.text).join("\n") : "");
const detailsOf = (result) => result?.details ?? result?.result?.details;

export function normalizeToolObservation(toolName, request, outcome) {
  const result = outcome?.result ?? outcome;
  const details = detailsOf(result) ?? {};
  const text = textOf(result);
  const responseId = details.responseId ?? details.searchId ?? details.fetchId;
  const threadId = details.threadId;
  const urls = Array.isArray(details.urls) ? details.urls : Array.isArray(details.fetchUrls) ? details.fetchUrls : [];
  const providers = details.queryProviders ?? details.providers ?? details.provider;
  const actualProvider = details.actualProvider ?? details.provider;
  const fallbackDiagnostics = details.fallbackDiagnostics ?? details.fallback ?? [];
  const isError = outcome?.isError === true || result?.isError === true;
  const ok = outcome?.ok ?? result?.ok;
  const state = outcome?.state ?? result?.state ?? details.state;
  const error = isError ? (text || details.error || "tool returned an error") : undefined;
  return { toolName, request, status: error ? "failed" : "completed", text, details, responseId, threadId, urls, providers, actualProvider, fallbackDiagnostics, isError, ok, state, error };
}

export async function callPiTool(ctx, toolName, request, signal, onUpdate) {
  if (!ctx || typeof ctx.executeTool !== "function") return { toolName, request, status: "blocked", error: "Pi executeTool is unavailable" };
  try {
    const outcome = await ctx.executeTool(toolName, request, { signal, onUpdate });
    return normalizeToolObservation(toolName, request, outcome);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { toolName, request, status: signal?.aborted ? "cancelled" : "failed", error: message };
  }
}

export async function searchEvidence(ctx, input, signal, onUpdate) {
  const request = input.source === "feynman"
    ? { source: input.databaseSource ?? "openalex", query: input.query, ...(input.limit === undefined ? {} : { limit: input.limit }), ...(input.sort ? { sort: input.sort } : {}) }
    : { queries: Array.isArray(input.queries) ? input.queries : [input.query], ...(input.numResults === undefined ? {} : { numResults: input.numResults }), ...(input.provider ? { provider: input.provider } : {}), ...(input.recencyFilter ? { recencyFilter: input.recencyFilter } : {}) };
  const tool = input.source === "feynman" ? "feynman_science_database_search" : (input.toolName ?? "web_search");
  return callPiTool(ctx, tool, request, signal, onUpdate);
}

export async function fetchEvidence(ctx, input, signal, onUpdate) {
  const urls = Array.isArray(input.urls) ? input.urls : [input.url];
  return callPiTool(ctx, input.toolName ?? "fetch_content", { urls, ...(input.mode ? { mode: input.mode } : {}), ...(input.answerModel ? { answerModel: input.answerModel } : {}) }, signal, onUpdate);
}

export function reviewGate(input = {}) {
  const responses = Array.isArray(input.responses) ? input.responses : [];
  const executor = { ...(input.executor ?? {}) };
  const route = resolveRoute({ backend: input.backend ?? "mcp", alias: input.alias ?? "codex", role: "externalReviewer", model: input.model }, executor);
  const diagnostics = [];
  if (route.status !== "ready") diagnostics.push(route.reason ?? route.code);
  if (route.acceptance === "blocked-until-observation") diagnostics.push(route.independence?.reason ?? "reviewer independence is not observed");
  if (route.requiredPin && route.observedPin?.status !== "eligible") diagnostics.push(route.observedPin?.reason ?? "required ARIS model/effort is not observed");
  if (responses.length < (input.requiredRounds ?? 1)) diagnostics.push("required external review rounds are missing");
  // Multi-round evidence needs distinct response identities; copying one
  // completed response cannot satisfy an additional review round.
  if (responses.length > 1 || (input.requiredRounds ?? 1) > 1) {
    const seen = new Set();
    for (const response of responses) {
      const id = typeof response?.responseId === "string" ? response.responseId.trim() : "";
      if (!id) diagnostics.push("multi-round review responseId is missing");
      else if (seen.has(id)) diagnostics.push("duplicate review responseId");
      else seen.add(id);
    }
  }
  for (const response of responses) {
    if (response.status !== "completed") diagnostics.push(`review response must have status completed (received ${response.status ?? "missing"})`);
    if (response.isError === true) diagnostics.push("review response isError is true");
    if (response.ok === false) diagnostics.push("review response ok is false");
    if (response.state && !["completed", "succeeded", "done"].includes(response.state)) diagnostics.push(`review response state is ${response.state}`);
    if (response.ok !== true && !["completed", "succeeded", "done"].includes(response.state)) diagnostics.push("review response lacks positive completion proof");
    if (response.error) diagnostics.push(`review response failed: ${response.error}`);
    if (!response.text && !response.output && !response.content) diagnostics.push("review response content is missing");
    if (!response.threadId && input.requireThread !== false) diagnostics.push("review threadId is missing");
    if (input.backend === "manual") {
      const declared = typeof response.text === "string" ? response.text.match(/^Reviewer-Model:\s*(\S+)/m)?.[1] : undefined;
      if (!declared) diagnostics.push("manual response lacks Reviewer-Model identity");
      else if (executor.reviewerObservation?.modelId !== declared) diagnostics.push("manual Reviewer-Model text is not confirmed by executor metadata");
    }
  }
  const independence = independentModelCheck(executor);
  if (independence.status !== "independent") diagnostics.push(independence.reason);
  const explicitAccepted = responses.length > 0 && responses.every((response) => response.verdict === "accepted");
  const acceptanceCandidate = diagnostics.length === 0 && explicitAccepted;
  const verdict = diagnostics.length ? (route.status === "provisional" ? "provisional" : "blocked") : (acceptanceCandidate && input.testOnly !== true ? "accepted" : "provisional");
  return { verdict, acceptanceCandidate, route, responses, diagnostics, independence, trace: responses.map((response) => ({ threadId: response.threadId, responseId: response.responseId })), ...(input.testOnly === true ? { testOnly: true } : {}) };
}

export function derivationGate(input = {}) {
  const derivations = Array.isArray(input.derivations) ? input.derivations : [];
  const obligations = Array.isArray(input.unresolvedObligations) ? input.unresolvedObligations : [];
  const diagnostics = [];
  if (derivations.length < 2 || derivations.some((item) => item.context !== "fresh")) diagnostics.push("two fresh derivation observations are required");
  if (derivations.some((item) => typeof item.body !== "string" && typeof item.text !== "string" && typeof item.content !== "string")) diagnostics.push("derivation正文 is missing; run references alone are not proof input");
  if (!input.counterexample || input.counterexample.status !== "completed") diagnostics.push("completed numerical/counterexample check is required");
  const juryRoute = resolveRoute({ backend: input.juryBackend ?? "native", role: "jury", model: input.juryModel }, input.executor ?? {});
  if (juryRoute.status !== "ready") diagnostics.push(juryRoute.reason ?? juryRoute.code);
  if (juryRoute.acceptance === "blocked-until-observation") diagnostics.push(juryRoute.independence?.reason ?? "jury independence is not observed");
  if (obligations.length) diagnostics.push("unresolved proof obligations remain");
  return { verdict: diagnostics.length ? "blocked" : "provisional", juryRoute, derivations, counterexample: input.counterexample, unresolvedObligations: obligations, diagnostics, majorityIsNotProof: true, ...(input.testOnly === true ? { testOnly: true } : {}) };
}

export function manifestFor(root, topic, stages) { return buildManifest(root, topic, stages); }
export { artifactPaths, independentModelCheck };
