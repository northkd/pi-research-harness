import { describe, expect, it, vi } from "vitest";
import { createStrictModelResolver } from "../res-workflow/strict-model.js";

function setup(overrides: Record<string, unknown> = {}) {
  const model = { provider: "cliproxy", id: "anthropic/test", api: "openai-completions", baseUrl: "https://models.example/v1", contextWindow: 64000, maxTokens: 8000, input: ["text"] };
  const runtime = {
    getModels: () => [model],
    getPhysicalModel: (p: string, id: string) => p === model.provider && id === model.id ? model : undefined,
    checkAuth: vi.fn(async () => ({ type: "api_key" })),
    streamSimple: vi.fn(),
    ...overrides,
  };
  const load = vi.fn(async () => ({ runtime, identity: "native-1.3", configurationHash: "config-a", enabledModels: ["@(!(anthropic))/**"] }));
  return { model, runtime, load, ...createStrictModelResolver(load) };
}

describe("res-workflow strict model resolution", () => {
  it("finds native proxy models without using the HTTP catalogue, defaults, or aliases", async () => {
    const f = setup();
    const result = await f.resolveModel("cliproxy", "anthropic/test");
    expect(result).toMatchObject({ provider: "cliproxy", id: "anthropic/test", contextWindow: 64000 });
    expect(f.runtime.streamSimple).not.toHaveBeenCalled();
    await expect(f.resolveModel("@fast", "anthropic/test")).rejects.toThrow(/explicit|model/i);
    await expect(f.resolveModel("deepseek", "missing")).rejects.toThrow(/unavailable/i);
  });

  it("refuses absent auth and virtual-only models instead of substituting another target", async () => {
    const absent = setup({ checkAuth: vi.fn(async () => undefined) });
    await expect(absent.resolveModel("cliproxy", "anthropic/test")).rejects.toThrow(/credential/i);
    const virtual = setup({ getPhysicalModel: () => undefined });
    await expect(virtual.resolveModel("cliproxy", "anthropic/test")).rejects.toThrow(/unavailable/i);
    expect(absent.runtime.streamSimple).not.toHaveBeenCalled();
  });

  it("binds the endpoint and global configuration, but never returns credential fields in the catalogue", async () => {
    const a = setup();
    const first = await a.resolveModel("cliproxy", "anthropic/test");
    a.load.mockResolvedValueOnce({ runtime: a.runtime, identity: "native-1.3", configurationHash: "config-b", enabledModels: ["@(!(anthropic))/**"] });
    const second = await a.resolveModel("cliproxy", "anthropic/test");
    expect(second.fingerprint).not.toBe(first.fingerprint);
    expect(await a.listAnalysisModels()).toEqual([{ provider: "cliproxy", id: "anthropic/test", name: "anthropic/test", reasoning: false, vision: false, contextWindow: 64000 }]);
  });

  it("keeps native anthropic hidden while preserving proxy Claude choices", async () => {
    const f = setup();
    f.runtime.getModels = () => [f.model, { ...f.model, provider: "anthropic" }];
    expect((await f.listAnalysisModels()).map((m) => m.provider)).toEqual(["cliproxy"]);
  });
});
