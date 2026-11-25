import {isFullyAdvertised} from '../shared/provider-model-metadata.mjs';
export function createDiscoveryModule(host) {
const {listProviderModels,readProvidersFromDisk,resolveProbeApiKey} = host;
const KNOWN_PROBE_APIS = /* @__PURE__ */ new Set([
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai"
]);
const FALLBACK = {
  "anthropic-messages": { contextWindow: 2e5, maxTokens: 64e3 },
  "google-generative-ai": { contextWindow: 1e6, maxTokens: 65536 },
  "openai-completions": { contextWindow: 128e3, maxTokens: 16384 }
};
async function discoverProviderModels(name, entry) {
  const api = entry.api && KNOWN_PROBE_APIS.has(entry.api) ? entry.api : "openai-completions";
  const baseUrl = entry.baseUrl?.trim() ?? "";
  if (!baseUrl) return [];
  const resolved = resolveProbeApiKey({ apiKey: entry.apiKey ?? "", name, readProviders: readProvidersFromDisk });
  if (!resolved.ok) return [];
  const discovered = await listProviderModels({ baseUrl, apiKey: resolved.key, api });
  const floor = FALLBACK[api] ?? FALLBACK["openai-completions"];
  return discovered.map(({ id, advertised }) => ({
    id,
    provider: name,
    api,
    baseUrl,
    contextWindow: advertised.contextWindow ?? floor.contextWindow,
    maxTokens: advertised.maxTokens ?? floor.maxTokens,
    reasoning: advertised.reasoning ?? false,
    input: advertised.input ?? ["text"],
    // No probed provider advertises pricing; inventing it is out of scope.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    // Weakest adopted tier: "endpoint" only when every projected field came
    // from the provider, else "fallback" — so a floor value is never presented
    // as confirmed. See change: fix-custom-provider-model-metadata (D6).
    metadataSource: isFullyAdvertised(advertised) ? "endpoint" : "fallback"
  }));
}
async function discoverAllCustomProviders(providers) {
  const results = await Promise.all(
    Object.entries(providers).map(([name, entry]) => discoverProviderModels(name, entry))
  );
  return results.flat();
}
return {discoverProviderModels,discoverAllCustomProviders};
}
