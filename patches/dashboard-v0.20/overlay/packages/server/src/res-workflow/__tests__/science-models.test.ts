import { describe, expect, it } from "vitest";
import { createScienceModelCatalog } from "../science-models.js";

const targets = ["ark-sci-deepseek-v4.1-flash", "gpt-6.1-sol(max)", "gpt-6-astra(high)"];

describe("Science CSSwitch model catalogue", () => {
  it("binds all four roles and the default to exactly three requested candidates", () => {
    const catalog = createScienceModelCatalog(targets);
    const modelFor = (selector: string) => catalog.routes.find((route) => route.selector_id === selector)?.upstream_model;
    expect(catalog.schema_version).toBe(1);
    expect(catalog.adapter).toBe("openai-custom");
    expect(catalog.routes).toHaveLength(3);
    expect(modelFor(catalog.default_selector_id)).toBe(targets[0]);
    expect(Object.fromEntries(Object.entries(catalog.role_bindings).map(([role, selector]) => [role, modelFor(selector)]))).toEqual({
      sonnet: targets[0], opus: targets[1], haiku: targets[0], fable: targets[2],
    });
    expect(catalog.role_bindings.sonnet).toBe(catalog.role_bindings.haiku);
  });

  it("uses internal Science-shaped selectors without rewriting upstream IDs or effort", () => {
    const catalog = createScienceModelCatalog(targets);
    expect(new Set(catalog.routes.map((route) => route.selector_id)).size).toBe(3);
    for (const route of catalog.routes) expect(route.selector_id).toMatch(/^claude-[A-Za-z0-9_.-]+$/);
    expect(catalog.routes.map((route) => route.upstream_model)).toEqual(targets);
    expect(catalog.routes[0].display_name).toBe("deepseek-v4.1-flash");
    expect(JSON.stringify(catalog)).not.toContain("[1m]");
    expect(catalog.legacy_aliases).toEqual([]);
  });

  it.each(targets)("fails closed when candidate %s is absent", (missing) => {
    expect(() => createScienceModelCatalog(targets.filter((id) => id !== missing))).toThrow(missing);
  });

  it.each([
    ["deepseek-v4.1-flash", targets[1], targets[2]],
    ["deepseek-v4.1-flash[1m]", targets[1], targets[2]],
    [targets[0], "gpt-6.1-sol(high)", targets[2]],
    [targets[0], targets[1], "gpt-6-astra(max)"],
    ["deepseek-v4-flash", "gpt-6.1-sol(max)[1m]", "gpt-6-astra(high)[1m]"],
  ])("does not substitute a nearby model, effort or context alias: %j", (...ids) => {
    expect(() => createScienceModelCatalog(ids)).toThrow(/Science model unavailable/);
  });

  it.each([null, {}, [1], ["invalid\nmodel"], ["invalid\x7fmodel"], ["x".repeat(513)], Array(4097).fill("id")].map((input) => ({ input })))("rejects malformed catalogue input %# without echoing its contents", ({ input }) => {
    expect(() => createScienceModelCatalog(input)).toThrow("Invalid Science model catalogue");
  });

  it.each([["x".repeat(512), ...targets], ["é".repeat(256), ...targets], [...Array(4093).fill("unrelated"), ...targets]].map((input) => ({ input })))("accepts exact byte/count boundaries %# without exposing unrelated IDs", ({ input }) => {
    expect(createScienceModelCatalog(input).routes.map((route) => route.upstream_model)).toEqual(targets);
  });

  it("retains unknown capabilities instead of claiming tools, vision or reasoning passed", () => {
    const catalog = createScienceModelCatalog(targets);
    for (const route of catalog.routes) {
      expect(route.supports_tools).toBeNull();
      expect(route.capabilities).toEqual({ reasoning_round_trip: "none", forced_tool_choice: null, structured_output: null, vision: null });
    }
  });

  it("matches the pinned CSSwitch v1 length-prefixed SHA-256 fingerprint", () => {
    expect(createScienceModelCatalog(targets).catalog_fp).toBe("2ee2a84cad02c4f50d513b835ca7d8618feb72aa978b8558e82eb235bd94825f");
  });

  it("ignores unrelated available IDs and does not mutate or retain caller state", () => {
    const input = ["unrelated-model", ...targets];
    const catalog = createScienceModelCatalog(input);
    expect(input).toEqual(["unrelated-model", ...targets]);
    input.splice(0);
    catalog.routes.splice(0);
    expect(createScienceModelCatalog(targets).routes.map((route) => route.upstream_model)).toEqual(targets);
  });
});
