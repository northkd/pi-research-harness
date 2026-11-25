function isRecord(v) {
  return typeof v === "object" && v !== null;
}
function positiveNumber(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : void 0;
}
function boolean(v) {
  return typeof v === "boolean" ? v : void 0;
}
function mapOpenAiEntry(m) {
  if (typeof m.id !== "string") return null;
  const caps = isRecord(m.capabilities) ? m.capabilities : void 0;
  const advertised = {};
  const contextWindow = positiveNumber(m.context_length) ?? positiveNumber(caps?.contextWindow);
  if (contextWindow !== void 0) advertised.contextWindow = contextWindow;
  const maxTokens = positiveNumber(m.max_completion_tokens) ?? positiveNumber(caps?.maxOutput);
  if (maxTokens !== void 0) advertised.maxTokens = maxTokens;
  const reasoning = boolean(caps?.reasoning);
  if (reasoning !== void 0) advertised.reasoning = reasoning;
  const vision = boolean(caps?.vision);
  if (vision !== void 0) advertised.input = vision ? ["text", "image"] : ["text"];
  return {
    id: m.id,
    ...typeof m.owned_by === "string" ? { owned_by: m.owned_by } : {},
    advertised
  };
}
function mapGoogleEntry(m) {
  if (typeof m.name !== "string") return null;
  const advertised = {};
  const contextWindow = positiveNumber(m.inputTokenLimit);
  if (contextWindow !== void 0) advertised.contextWindow = contextWindow;
  const maxTokens = positiveNumber(m.outputTokenLimit);
  if (maxTokens !== void 0) advertised.maxTokens = maxTokens;
  return { id: m.name.replace(/^models\//, ""), advertised };
}
function mapAdvertisedModels(body) {
  if (!isRecord(body)) return [];
  if (Array.isArray(body.data)) {
    return body.data.filter(isRecord).map(mapOpenAiEntry).filter((r) => r !== null);
  }
  if (Array.isArray(body.models)) {
    return body.models.filter(isRecord).map(mapGoogleEntry).filter((r) => r !== null);
  }
  return [];
}
function isFullyAdvertised(advertised) {
  return advertised.contextWindow !== void 0 && advertised.maxTokens !== void 0 && advertised.reasoning !== void 0 && advertised.input !== void 0;
}
export {
  isFullyAdvertised,
  mapAdvertisedModels
};
