import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findPackageJSON } from "node:module";
import { resolvePiAgentDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import { modelInScope } from "@blackbelt-technology/pi-dashboard-shared/enabled-models-match.js";
import { pkgDirForEntry } from "@blackbelt-technology/pi-dashboard-shared/pi-installs/index.js";
import { getDefaultRegistry } from "@blackbelt-technology/pi-dashboard-shared/tool-registry/index.js";
import type { ModelInfo } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { openVerifiedRegularFile } from "../access/verified-read.js";

interface NativeModel {
  provider: string;
  id: string;
  name?: string;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: string[];
}

export interface AnalysisModelRuntime {
  getModels(): readonly NativeModel[];
  getPhysicalModel(provider: string, id: string): NativeModel | undefined;
  checkAuth(provider: string): Promise<unknown>;
  getAuth?(model: unknown, options?: { signal?: AbortSignal }): Promise<{ auth?: { baseUrl?: string } } | undefined>;
  streamSimple(model: unknown, context: unknown, options?: { signal?: AbortSignal; maxTokens?: number; temperature?: number }): AsyncIterable<unknown>;
}

export interface ResolvedAnalysisModel {
  provider: string;
  id: string;
  baseUrl?: string;
  api?: string;
  headers?: Record<string, string>;
  fingerprint: string;
  contextWindow: number;
  maxTokens: number;
  model: unknown;
  runtime: AnalysisModelRuntime;
  /** Lazy, same managed SDK as the selected physical model. No global runtime mutation. */
  loadAgentFactory?(): Promise<AnalysisAgentFactory>;
}

export interface AnalysisAgentFactory {
  createAgent(options: unknown): unknown;
  createEventStream(): unknown;
}

interface LoadedRuntime {
  runtime: AnalysisModelRuntime;
  identity: string;
  configurationHash: string;
  enabledModels?: string[];
  loadAgentFactory?(): Promise<AnalysisAgentFactory>;
}

/** Catalogue reads do not load an Agent. Missing/mismatched SDK support fails only agent startup. */
export function selectedAgentFactoryLoader(entry: string, sdkVersion: string): () => Promise<AnalysisAgentFactory> {
  let pending: Promise<AnalysisAgentFactory> | undefined;
  return () => pending ??= (async () => {
    try {
      const packageRoot = async (name: string) => {
        const selected = findPackageJSON(name, pathToFileURL(entry));
        if (!selected) throw new Error();
        const manifestPath = await realpath(selected);
        const sdkRoot = path.resolve(path.dirname(entry), "..");
        const dependencyRoot = path.resolve(sdkRoot, "../..");
        const declared = await Promise.all([path.join(sdkRoot, "node_modules", name, "package.json"), path.join(dependencyRoot, name, "package.json")].map(file => realpath(file).catch(() => null)));
        if (!declared.includes(manifestPath)) throw new Error();
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.name !== name || manifest.version !== sdkVersion) throw new Error();
        return path.dirname(manifestPath);
      };
      const [coreRoot, aiRoot] = await Promise.all([packageRoot("@earendil-works/pi-agent-core"), packageRoot("@earendil-works/pi-ai")]);
      const [core, streams] = await Promise.all([import(pathToFileURL(path.join(coreRoot, "dist", "index.js")).href), import(pathToFileURL(path.join(aiRoot, "dist", "utils", "event-stream.js")).href)]);
      if (typeof core.Agent !== "function" || typeof streams.createAssistantMessageEventStream !== "function" || !["prompt", "subscribe", "abort", "waitForIdle"].every(key => typeof core.Agent.prototype[key] === "function")) throw new Error();
      return Object.freeze({ createAgent: (options: unknown) => new core.Agent(options), createEventStream: () => streams.createAssistantMessageEventStream() });
    } catch { throw new Error("model-agent-runtime-unavailable"); }
  })();
}

const digest = (text: string) => createHash("sha256").update(text).digest("hex");

export function createStrictModelResolver(load: () => Promise<LoadedRuntime>) {
  const resolveModel = async (provider: string, id: string): Promise<ResolvedAnalysisModel> => {
    if (!provider || !id || provider.startsWith("@") || id.startsWith("@") || /[\x00-\x20]/.test(provider) || /[\x00-\x1f]/.test(id) || provider.length > 128 || id.length > 512) {
      throw new Error("An explicit provider and model id are required");
    }
    const loaded = await load();
    const model = loaded.runtime.getPhysicalModel(provider, id);
    if (!model || model.provider !== provider || model.id !== id || (loaded.enabledModels?.length && !modelInScope(model, loaded.enabledModels))) {
      throw new Error("Selected physical model unavailable; no fallback was used");
    }
    let authenticated = false;
    try { authenticated = !!(await loaded.runtime.checkAuth(provider)); }
    catch { throw new Error("Selected model credential check unavailable"); }
    if (!authenticated) throw new Error("Selected model has no usable credential");
    if (!Number.isFinite(model.contextWindow) || Number(model.contextWindow) < 4096) throw new Error("Selected model context budget unavailable");
    if (model.baseUrl) {
      let url: URL;
      try { url = new URL(model.baseUrl); } catch { throw new Error("Selected model endpoint invalid"); }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Selected model endpoint invalid");
    }
    return {
      provider, id, baseUrl: model.baseUrl, api: model.api, headers: model.headers,
      fingerprint: digest(JSON.stringify([loaded.identity, loaded.configurationHash, provider, id, model.baseUrl, model.api, model.headers])),
      contextWindow: Number(model.contextWindow), maxTokens: Number(model.maxTokens) || 4096,
      model, runtime: loaded.runtime, ...(loaded.loadAgentFactory ? { loadAgentFactory: loaded.loadAgentFactory } : {}),
    };
  };
  const listAnalysisModels = async (): Promise<ModelInfo[]> => {
    const { runtime, enabledModels } = await load();
    const out: ModelInfo[] = [];
    const auth = new Map<string, boolean>();
    for (const model of runtime.getModels()) {
      if (!runtime.getPhysicalModel(model.provider, model.id) || (enabledModels?.length && !modelInScope(model, enabledModels))) continue;
      if (!auth.has(model.provider)) auth.set(model.provider, !!(await runtime.checkAuth(model.provider)));
      if (!auth.get(model.provider)) continue;
      out.push({ provider: model.provider, id: model.id, name: model.name ?? model.id, reasoning: model.reasoning === true, vision: model.input?.includes("image") === true, contextWindow: model.contextWindow });
      if (out.length >= 2000) break;
    }
    return out;
  };
  return { resolveModel, listAnalysisModels };
}

async function configText(file: string): Promise<string> {
  let handle;
  try {
    handle = await openVerifiedRegularFile(file);
    if ((await handle.stat()).size > 512 * 1024) throw new Error("Global model configuration too large");
    return await handle.readFile("utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw new Error("Global model configuration unavailable");
  } finally { await handle?.close(); }
}

function parsedConfig(raw: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new Error("Global model configuration invalid"); }
}

function containsCommand(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith("!");
  if (Array.isArray(value)) return value.some(containsCommand);
  return !!value && typeof value === "object" && Object.values(value).some(containsCommand);
}

/** Follows the selected managed launcher, not the dashboard's older npm import tree. */
async function selectedSdkEntry(agentDir: string): Promise<string> {
  const resolution = getDefaultRegistry().resolve("pi");
  if (resolution.ok && resolution.source === "override" && resolution.path) {
    const pkgDir = pkgDirForEntry(resolution.path);
    if (pkgDir) return path.join(pkgDir, "dist", "index.js");
    // Shell executor wrappers have no SDK package; use their managed selection below.
    if (!(await stat(resolution.path)).isFile()) throw new Error("Selected Pi SDK unavailable");
  }
  const install = process.env.PI_MANAGED_INSTALL_ROOT || path.join(agentDir, "install");
  let version: string | undefined;
  try { version = (await readFile(path.join(install, "current-version"), "utf8")).trim(); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Managed Pi selection unavailable"); }
  if (version !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version)) throw new Error("Managed Pi selection invalid");
    return path.join(install, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  }
  if (!resolution.ok || !resolution.path) throw new Error("Selected Pi SDK unavailable");
  const pkgDir = pkgDirForEntry(resolution.path);
  if (!pkgDir) throw new Error("Selected Pi SDK unavailable");
  return path.join(pkgDir, "dist", "index.js");
}

async function loadNativeRuntime(): Promise<LoadedRuntime> {
  const agentDir = resolvePiAgentDir();
  const entry = await realpath(await selectedSdkEntry(agentDir));
  if (!(await stat(entry)).isFile()) throw new Error("Selected Pi SDK unavailable");
  const modelsPath = path.join(agentDir, "models.json");
  const [modelsRaw, settingsRaw] = await Promise.all([configText(modelsPath), configText(path.join(agentDir, "settings.json"))]);
  const modelConfig = parsedConfig(modelsRaw);
  const settings = parsedConfig(settingsRaw);
  // The no-tools client must not execute pi's command-valued credential templates.
  if (containsCommand(modelConfig)) throw new Error("Command-valued model configuration is not allowed for restricted analysis");
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.ModelRuntime?.create !== "function") throw new Error("Selected Pi SDK does not provide a compatible model runtime");
  const runtime = await module.ModelRuntime.create({ modelsPath: null, authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  if (typeof runtime.getPhysicalModel !== "function" || typeof runtime.checkAuth !== "function" || typeof runtime.streamSimple !== "function" || typeof runtime.registerProvider !== "function") throw new Error("Selected Pi SDK does not provide a restricted model client");
  // Register the checked in-memory snapshot, not a second racing read of models.json.
  if (modelConfig.providers && typeof modelConfig.providers === "object" && !Array.isArray(modelConfig.providers)) {
    for (const [provider, config] of Object.entries(modelConfig.providers)) {
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Global provider configuration invalid");
      runtime.registerProvider(provider, config);
    }
  }
  return {
    runtime, identity: `${entry}:${module.VERSION ?? "unknown"}`,
    loadAgentFactory: selectedAgentFactoryLoader(entry, String(module.VERSION ?? "unknown")),
    configurationHash: digest(modelsRaw),
    enabledModels: Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((v): v is string => typeof v === "string") : undefined,
  };
}

export const { resolveModel, listAnalysisModels } = createStrictModelResolver(loadNativeRuntime);
