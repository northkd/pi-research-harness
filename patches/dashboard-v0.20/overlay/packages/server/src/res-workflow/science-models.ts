import { createHash } from "node:crypto";

const candidates = [
  ["claude-pi-science-default", "ark-sci-deepseek-v4.1-flash", "deepseek-v4.1-flash"],
  ["claude-pi-science-quality", "gpt-6.1-sol(max)", "gpt-6.1-sol(max)"],
  ["claude-pi-science-fable", "gpt-6-astra(high)", "gpt-6-astra(high)"],
] as const;

export function createScienceModelCatalog(availableModelIds: unknown) {
  if (!Array.isArray(availableModelIds) || availableModelIds.length > 4096 || availableModelIds.some((id) =>
    typeof id !== "string" || Buffer.byteLength(id, "utf8") > 512 || /[\x00-\x1f\x7f]/.test(id)
  )) {
    throw new Error("Invalid Science model catalogue");
  }
  const available = new Set(availableModelIds);
  for (const [, model] of candidates) {
    if (!available.has(model)) throw new Error(`Science model unavailable: ${model}`);
  }

  const catalog = {
    schema_version: 1,
    adapter: "openai-custom",
    default_selector_id: candidates[0][0],
    routes: candidates.map(([selector_id, upstream_model, display_name]) => ({
      selector_id,
      display_name,
      upstream_model,
      supports_tools: null,
      capabilities: { reasoning_round_trip: "none", forced_tool_choice: null, structured_output: null, vision: null },
    })),
    role_bindings: { sonnet: candidates[0][0], opus: candidates[1][0], haiku: candidates[0][0], fable: candidates[2][0] },
    legacy_aliases: [],
  };

  // shortcut: optional capabilities stay null and legacy aliases empty; extend hashing before enabling either.
  if (catalog.legacy_aliases.length || catalog.routes.some((route) => [route.supports_tools, route.capabilities.forced_tool_choice, route.capabilities.structured_output, route.capabilities.vision].some((value) => value !== null))) {
    throw new Error("Science capability metadata must remain unknown");
  }
  // CSSwitch ddff6de static_profile.rs v1 hashes ordered, length-prefixed UTF-8, not JSON.
  const digest = createHash("sha256");
  const integer = (value: number) => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    digest.update(bytes);
  };
  const text = (value: string) => {
    const bytes = Buffer.from(value, "utf8");
    integer(bytes.length);
    digest.update(bytes);
  };
  digest.update("csswitch-static-catalog-fp-v1\0");
  integer(catalog.schema_version);
  text(catalog.adapter);
  text(catalog.default_selector_id);
  integer(catalog.routes.length);
  for (const route of catalog.routes) {
    text(route.selector_id);
    text(route.display_name);
    text(route.upstream_model);
    digest.update(Buffer.from([0]));
    text(route.capabilities.reasoning_round_trip);
    digest.update(Buffer.from([0, 0, 0]));
  }
  for (const role of ["sonnet", "opus", "haiku", "fable"] as const) text(catalog.role_bindings[role]);
  integer(catalog.legacy_aliases.length);
  return { ...catalog, catalog_fp: digest.digest("hex") };
}
