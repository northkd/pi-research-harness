import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelCatalogue, fetchScopeCatalogue } from "../models-api.js";

const rows = [
  { id: "anthropic/claude-native", provider: "anthropic", name: "Native Claude" },
  { id: "cliproxy/anthropic/claude-proxy", provider: "cliproxy", name: "Proxy Claude" },
  { id: "deepseek/deepseek-chat", provider: "deepseek", name: "DeepSeek" },
];

function respond(data = rows) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data }), {
    headers: { "content-type": "application/json" },
  })));
}

afterEach(() => vi.unstubAllGlobals());

describe("model catalogue visibility", () => {
  it("hides only the native anthropic provider, retaining proxy Claude and other providers", async () => {
    respond();
    const result = await fetchModelCatalogue();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a readable catalogue");
    expect(result.models.map(model => model.provider)).toEqual(["cliproxy", "deepseek"]);
    expect(result.models[0].id).toBe("anthropic/claude-proxy");
  });

  it("keeps a successfully empty visible catalogue distinct from a failure", async () => {
    respond(rows.slice(0, 1));
    expect(await fetchModelCatalogue()).toEqual({ status: "ok", models: [] });
  });

  it("retains the full configuration catalogue, without changing stored credentials", async () => {
    respond();
    const result = await fetchScopeCatalogue();
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("Expected a readable configuration catalogue");
    expect(result.rows.map(row => row.provider)).toEqual(["anthropic", "cliproxy", "deepseek"]);
    expect(vi.mocked(fetch).mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
  });
});
