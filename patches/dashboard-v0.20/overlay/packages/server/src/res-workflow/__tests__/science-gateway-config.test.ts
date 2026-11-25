import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import { prepareScienceGatewayConfig } from "../science-gateway-config.js";
import { createScienceModelCatalog } from "../science-models.js";

const key = "fixture-science-client-key-0000000000000000";
const alias = "ark-sci-deepseek-v4.1-flash";
const fixture = `# synthetic credentials only
api-keys:
  - fixture-existing-key-0000000000000000 # keep key comment
claude-api-key:
  - api-key: fixture-ark-upstream-key
    base-url: https://ark.cn-beijing.volces.com/api/coding
    models:
      - name: deepseek-v4.1-flash
        alias: deepseek-v4.1-flash
      - name: deepseek-v4.1-flash
        alias: deepseek-v4.1-flash[1m] # keep model comment
openai-compatibility:
  - name: fixture-other-provider
    base-url: https://models.example/v1
    api-key-entries:
      - api-key: fixture-other-upstream-key
    models:
      - name: deepseek-v4.1-flash
        alias: deepseek-v4.1-flash
routing:
  strategy: round-robin # keep unrelated setting
`;

function expected(source: string, newline = "\n") {
  return source
    .replace(`  - fixture-existing-key-0000000000000000 # keep key comment${newline}`, `  - fixture-existing-key-0000000000000000 # keep key comment${newline}  - "${key}"${newline}`)
    .replace(`        alias: deepseek-v4.1-flash[1m] # keep model comment${newline}`, `        alias: deepseek-v4.1-flash[1m] # keep model comment${newline}      - name: deepseek-v4.1-flash${newline}        alias: ${alias}${newline}`);
}

describe("Science minimal gateway configuration patch", () => {
  it("only inserts a new client key and a unique alias on the existing Ark entry", () => {
    const result = prepareScienceGatewayConfig(fixture, key);
    expect(result.source).toBe(expected(fixture));
    expect(result).toMatchObject({ addedKey: true, addedAlias: true, oldKeyCount: 1, newKeyCount: 2 });
    const before = parse(fixture);
    const after = parse(result.source);
    expect(after["api-keys"]).toEqual([...before["api-keys"], key]);
    expect(after["claude-api-key"][0].models).toEqual([...before["claude-api-key"][0].models, { name: "deepseek-v4.1-flash", alias }]);
    after["api-keys"].pop();
    after["claude-api-key"][0].models.pop();
    expect(after).toEqual(before);
  });

  it("does not let YAML conversion warnings print source fragments", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const emitted = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    try {
      const source = fixture + "? [fixture-secret-collection-key]\n: fixture-value\n";
      try { prepareScienceGatewayConfig(source, key); }
      catch (failure) { expect((failure as Error).message).not.toContain("fixture-secret-collection-key"); }
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
      expect(emitted).not.toHaveBeenCalled();
    } finally { warn.mockRestore(); error.mockRestore(); emitted.mockRestore(); }
  });

  it("still refuses YAML parse warnings when source logging is silent", () => {
    expect(() => prepareScienceGatewayConfig(fixture + "unrelated: !fixture-unsupported fixture-secret-marker\n", key)).toThrow("Invalid gateway configuration");
  });

  it.each(["   ", "\\t", "\\r\\n", "\\u0085"])("rejects whitespace-only existing client keys %# before preparing edits", (value) => {
    const source = fixture.replace("fixture-existing-key-0000000000000000", `"${value}"`);
    expect(() => prepareScienceGatewayConfig(source, key)).toThrow("Client API keys unavailable");
  });

  it("pins the alias/model shared invariant across patcher and Science catalogue", () => {
    const patched = parse(prepareScienceGatewayConfig(fixture, key).source);
    const mapping = patched["claude-api-key"][0].models.at(-1);
    const catalog = createScienceModelCatalog([alias, "gpt-6.1-sol(max)", "gpt-6-astra(high)"]);
    expect(catalog.routes[0].upstream_model).toBe(mapping.alias);
    expect(catalog.routes[0].display_name).toBe(mapping.name);
  });

  it("can append only the alias when the private client key is already present", () => {
    const keyOnly = fixture.replace("  - fixture-existing-key-0000000000000000 # keep key comment\n", `  - fixture-existing-key-0000000000000000 # keep key comment\n  - "${key}"\n`);
    const result = prepareScienceGatewayConfig(keyOnly, key);
    expect(result.source).toBe(expected(fixture));
    expect(result).toMatchObject({ addedKey: false, addedAlias: true, oldKeyCount: 2, newKeyCount: 2 });
  });

  it("rejects duplicate owned aliases before preparing any edit", () => {
    const source = expected(fixture).replace("openai-compatibility:", `      - name: deepseek-v4.1-flash\n        alias: ${alias}\nopenai-compatibility:`);
    expect(() => prepareScienceGatewayConfig(source, key)).toThrow("Science alias collision");
  });

  it("rejects edited flow models but preserves a correctly bound untouched flow sequence", () => {
    const start = fixture.indexOf("    models:\n");
    const end = fixture.indexOf("openai-compatibility:");
    const flow = (bound: string) => fixture.slice(0, start) + `    models: [{name: deepseek-v4.1-flash, alias: ${bound}}]\n` + fixture.slice(end);
    expect(() => prepareScienceGatewayConfig(flow("deepseek-v4.1-flash"), key)).toThrow("Unsupported YAML layout");
    const result = prepareScienceGatewayConfig(flow(alias), key);
    expect(result.addedAlias).toBe(false);
    expect(result.source).toBe(flow(alias).replace("  - fixture-existing-key-0000000000000000 # keep key comment\n", `  - fixture-existing-key-0000000000000000 # keep key comment\n  - "${key}"\n`));
  });

  it("is idempotent for the same private key and correctly bound alias", () => {
    const first = prepareScienceGatewayConfig(fixture, key);
    const second = prepareScienceGatewayConfig(first.source, key);
    expect(second.source).toBe(first.source);
    expect(second).toMatchObject({ addedKey: false, addedAlias: false, oldKeyCount: 2, newKeyCount: 2 });
  });

  it("can finish only the missing key without duplicating an existing correct alias", () => {
    const aliasOnly = expected(fixture).replace(`  - "${key}"\n`, "");
    const result = prepareScienceGatewayConfig(aliasOnly, key);
    expect(result.source).toBe(expected(fixture));
    expect(result).toMatchObject({ addedKey: true, addedAlias: false });
  });

  it("retains CRLF and comments without reserializing any existing values", () => {
    const source = fixture.replaceAll("\n", "\r\n");
    expect(prepareScienceGatewayConfig(source, key).source).toBe(expected(source, "\r\n"));
  });

  it("preserves a missing final newline when edited sequences are not at EOF", () => {
    const source = fixture.trimEnd();
    expect(prepareScienceGatewayConfig(source, key).source).toBe(expected(source));
  });

  it("handles a final key sequence without a newline and preserves the earlier Ark block", () => {
    const source = fixture.replace(/api-keys:\n  - fixture-existing-key-0000000000000000 # keep key comment\n/, "") + "api-keys:\n  - fixture-existing-key-0000000000000000";
    const result = prepareScienceGatewayConfig(source, key);
    expect(parse(result.source)["api-keys"]).toEqual(["fixture-existing-key-0000000000000000", key]);
    expect(result.source).toContain(`  - fixture-existing-key-0000000000000000\n  - "${key}"\n`);
  });

  it.each([
    "https://models.example/v1",
    "https://ark.cn-beijing.volces.com.evil.example/v1",
    "http://ark.cn-beijing.volces.com/api/coding",
    "https://user:password@ark.cn-beijing.volces.com/api/coding",
  ])("does not guess Ark routing for %s", (url) => {
    expect(() => prepareScienceGatewayConfig(fixture.replace("https://ark.cn-beijing.volces.com/api/coding", url), key)).toThrow(/Ark route unavailable/);
  });

  it("refuses multiple matching Ark entries instead of picking one", () => {
    const value = parse(fixture);
    const duplicate = fixture.replace("openai-compatibility:", "  - api-key: fixture-second-ark-key\n    base-url: https://ark.cn-beijing.volces.com/api/coding\n    models:\n      - name: deepseek-v4.1-flash\n        alias: deepseek-v4.1-flash\nopenai-compatibility:");
    expect(value["claude-api-key"]).toHaveLength(1);
    expect(() => prepareScienceGatewayConfig(duplicate, key)).toThrow(/Ark route unavailable/);
  });

  it("rejects an alias already assigned to another provider", () => {
    const conflict = fixture + `extra-provider:\n  models:\n    - name: other-model\n      alias: ${alias}\n`;
    expect(() => prepareScienceGatewayConfig(conflict, key)).toThrow(/Science alias collision/);
  });

  it("rejects an existing Ark alias for a different upstream model", () => {
    const conflict = fixture.replace("openai-compatibility:", `      - name: different-model\n        alias: ${alias}\nopenai-compatibility:`);
    expect(() => prepareScienceGatewayConfig(conflict, key)).toThrow(/Science alias collision/);
  });

  it.each([null, "short", "fixture-science-key-with-newline\n000000000", "x".repeat(129)])("rejects invalid new key %# without echoing it", (value) => {
    expect(() => prepareScienceGatewayConfig(fixture, value)).toThrow("Invalid Science credential");
  });

  it.each([
    fixture + "api-keys: fixture-secret-marker\n",
    fixture.replace("api-keys:\n  - fixture-existing-key-0000000000000000 # keep key comment", "api-keys: []"),
    fixture.replace("api-keys:\n  - fixture-existing-key-0000000000000000 # keep key comment", "api-keys: [fixture-existing-key]"),
    fixture + "copied-models: &fixture-anchor [one]\nother-models: *fixture-anchor\n",
  ])("fails closed on duplicate keys, empty/flow sequences and YAML aliases %#", (source) => {
    try {
      prepareScienceGatewayConfig(source, key);
      throw new Error("Expected safe rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toBe("Expected safe rejection");
      expect((error as Error).message).not.toContain("fixture-secret-marker");
    }
  });
});
