import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listAnalysisModels, resolveModel } from "../res-workflow/strict-model.js";

const registry = vi.hoisted(() => ({ resolution: { ok: true, source: "path", path: "/fixture/old-agent/npm/pi" } }));
vi.mock("@blackbelt-technology/pi-dashboard-shared/tool-registry/index.js", () => ({ getDefaultRegistry: () => ({ resolve: () => registry.resolution }) }));
const dirs: string[] = [];
afterEach(async () => {
  registry.resolution = { ok: true, source: "path", path: "/fixture/old-agent/npm/pi" };
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function nativeFixture(command = false) {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "res-native-sdk-")); dirs.push(agentDir);
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir); vi.stubEnv("PI_MANAGED_INSTALL_ROOT", path.join(agentDir, "install"));
  const sdk = path.join(agentDir, "install/releases/1.3.0/node_modules/@earendil-works/pi-coding-agent");
  await fs.mkdir(path.join(sdk, "dist"), { recursive: true });
  await fs.writeFile(path.join(agentDir, "install/current-version"), "1.3.0\n");
  await fs.writeFile(path.join(sdk, "package.json"), '{"name":"@earendil-works/pi-coding-agent","type":"module"}');
  await fs.writeFile(path.join(sdk, "dist/index.js"), `export const VERSION = "1.3.0-fixture";
export const ModelRuntime = { async create(options) {
  if (options.modelsPath !== null || options.allowModelNetwork !== false || options.refreshOnCreate !== false) throw new Error("unsafe runtime options");
  const models = [];
  return { getModels: () => models, getPhysicalModel: (p,id) => models.find(m=>m.provider===p&&m.id===id), checkAuth: async () => ({type:"api_key"}), getAuth: async () => ({auth:{}}), streamSimple: () => { throw new Error("QA must never call a model"); }, registerProvider(provider, config) { models.push(...config.models.map(m=>({...m,provider,api:config.api,baseUrl:config.baseUrl}))); } };
} };
`);
  await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: { cliproxy: { api: "openai-completions", baseUrl: "https://fixture.example/v1", apiKey: command ? "!must-not-execute" : "fixture-placeholder", models: [{ id: "anthropic/model", contextWindow: 64000, maxTokens: 4096 }] } } }));
  return agentDir;
}

async function wrapperFixture() {
  const agentDir = await nativeFixture();
  const wrapper = path.join(agentDir, "bin/pi-research");
  await fs.mkdir(path.dirname(wrapper));
  await fs.writeFile(wrapper, "#!/bin/sh\nexit 99\n");
  registry.resolution = { ok: true, source: "override", path: wrapper };
  return agentDir;
}

describe("managed native restricted model adapter", () => {
  it("lists and resolves managed models when the selected executor is a shell wrapper", async () => {
    await wrapperFixture();
    expect(await listAnalysisModels()).toEqual([expect.objectContaining({ provider: "cliproxy", id: "anthropic/model" })]);
    expect(await resolveModel("cliproxy", "anthropic/model")).toMatchObject({ provider: "cliproxy", id: "anthropic/model", baseUrl: "https://fixture.example/v1" });
  });

  it.each([
    { selection: undefined, error: /Selected Pi SDK unavailable/ },
    { selection: "../../old", error: /selection invalid/ },
    { selection: "uninstalled-release", error: /ENOENT/ },
  ])("does not fall back from a wrapper with managed selection $selection", async ({ selection, error }) => {
    const dir = await wrapperFixture();
    const selector = path.join(dir, "install/current-version");
    if (selection === undefined) await fs.unlink(selector);
    else await fs.writeFile(selector, `${selection}\n`);
    await expect(listAnalysisModels()).rejects.toThrow(error);
  });

  it.each(["missing", "directory"])("rejects a no-longer-valid $0 executor override", async (kind) => {
    await wrapperFixture();
    const wrapper = registry.resolution.path;
    await fs.unlink(wrapper);
    if (kind === "directory") await fs.mkdir(wrapper);
    await expect(listAnalysisModels()).rejects.toThrow(/Selected Pi SDK unavailable|ENOENT/);
  });

  it("keeps an explicit package executor authoritative and does not hide its SDK failure", async () => {
    const dir = await nativeFixture();
    const sdk = path.join(dir, "explicit-sdk");
    await fs.mkdir(path.join(sdk, "dist"), { recursive: true });
    await fs.writeFile(path.join(sdk, "package.json"), '{"name":"@earendil-works/pi-coding-agent","type":"module"}');
    await fs.writeFile(path.join(sdk, "dist/cli.js"), "// fixture executor, never launched\n");
    await fs.writeFile(path.join(sdk, "dist/index.js"), 'throw new Error("explicit-package-sdk-selected");\n');
    registry.resolution = { ok: true, source: "override", path: path.join(sdk, "dist/cli.js") };
    await expect(listAnalysisModels()).rejects.toThrow("explicit-package-sdk-selected");
  });

  it("uses managed current-version and checked global configuration rather than the older npm path", async () => {
    await nativeFixture();
    const model = await resolveModel("cliproxy", "anthropic/model");
    expect(model).toMatchObject({ provider: "cliproxy", id: "anthropic/model", baseUrl: "https://fixture.example/v1", api: "openai-completions" });
    expect(model.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it("blocks command-valued credentials before constructing any model request", async () => {
    await nativeFixture(true);
    await expect(resolveModel("cliproxy", "anthropic/model")).rejects.toThrow(/Command-valued/);
  });

  it("invalid managed selection fails without importing the older npm SDK", async () => {
    const dir = await nativeFixture();
    await fs.writeFile(path.join(dir, "install/current-version"), "../../old\n");
    await expect(resolveModel("cliproxy", "anthropic/model")).rejects.toThrow(/selection invalid/);
  });
});
