import { parseRoleConfig, resolveModelRef } from "./role-schema.js";
function createBriefModelResolver(deps) {
  return async function resolveBriefModel() {
    let raw;
    try {
      raw = await deps.readProviders();
    } catch (err) {
      console.warn(`[questions] cannot read providers.json, brief generation unavailable: ${err.message}`);
      return { ok: false, reason: "providers.json unreadable" };
    }
    let parsed = {};
    if (raw !== void 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        console.warn("[questions] providers.json is not valid JSON, brief generation unavailable");
        return { ok: false, reason: "providers.json malformed" };
      }
    }
    const ref = resolveModelRef("@fast", parseRoleConfig(parsed));
    if (ref.unresolved || !ref.provider || !ref.id) return { ok: false, reason: ref.unresolved ?? "@fast does not resolve" };
    if (!deps.hasStreamFn()) return { ok: false, reason: "model runtime not initialized" };
    try {
      const registry = await deps.getRegistry();
      if (!registry) return { ok: false, reason: "model registry unavailable" };
      const model = await registry.find(ref.provider, ref.id);
      if (!model) return { ok: false, reason: `model ${ref.provider}/${ref.id} not in registry` };
      return { ok: true, model };
    } catch (err) {
      console.warn(`[questions] model registry lookup failed, brief generation unavailable: ${err.message}`);
      return { ok: false, reason: "model registry error" };
    }
  };
}
export {
  createBriefModelResolver
};
