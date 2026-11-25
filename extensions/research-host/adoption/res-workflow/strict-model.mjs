import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { findPackageJSON } from "node:module";
import { homedir } from "node:os";
const resolvePiAgentDir = () => process.env.PI_CODING_AGENT_DIR || path.join(homedir(), ".pi", "agent");
import { modelInScope } from "../shared/enabled-models-match.mjs";
import { openVerifiedRegularFile } from "../access/verified-read.mjs";
function selectedAgentFactoryLoader(entry, sdkVersion) {
  let pending;
  return () => pending ??= (async () => {
    try {
      const packageRoot = async (name) => {
        const selected = findPackageJSON(name, pathToFileURL(entry));
        if (!selected) throw new Error();
        const manifestPath = await realpath(selected);
        const sdkRoot = path.resolve(path.dirname(entry), "..");
        const dependencyRoot = path.resolve(sdkRoot, "../..");
        const declared = await Promise.all([path.join(sdkRoot, "node_modules", name, "package.json"), path.join(dependencyRoot, name, "package.json")].map((file) => realpath(file).catch(() => null)));
        if (!declared.includes(manifestPath)) throw new Error();
        const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
        if (manifest.name !== name || manifest.version !== sdkVersion) throw new Error();
        return path.dirname(manifestPath);
      };
      const [coreRoot, aiRoot] = await Promise.all([packageRoot("@earendil-works/pi-agent-core"), packageRoot("@earendil-works/pi-ai")]);
      const [core, streams] = await Promise.all([import(pathToFileURL(path.join(coreRoot, "dist", "index.js")).href), import(pathToFileURL(path.join(aiRoot, "dist", "utils", "event-stream.js")).href)]);
      if (typeof core.Agent !== "function" || typeof streams.createAssistantMessageEventStream !== "function" || !["prompt", "subscribe", "abort", "waitForIdle"].every((key) => typeof core.Agent.prototype[key] === "function")) throw new Error();
      return Object.freeze({ createAgent: (options) => new core.Agent(options), createEventStream: () => streams.createAssistantMessageEventStream() });
    } catch {
      throw new Error("model-agent-runtime-unavailable");
    }
  })();
}
const digest = (text) => createHash("sha256").update(text).digest("hex");
function createStrictModelResolver(load) {
  const resolveModel2 = async (provider, id) => {
    if (!provider || !id || provider.startsWith("@") || id.startsWith("@") || /[\x00-\x20]/.test(provider) || /[\x00-\x1f]/.test(id) || provider.length > 128 || id.length > 512) {
      throw new Error("An explicit provider and model id are required");
    }
    const loaded = await load();
    const model = loaded.runtime.getPhysicalModel(provider, id);
    if (!model || model.provider !== provider || model.id !== id || loaded.enabledModels?.length && !modelInScope(model, loaded.enabledModels)) {
      throw new Error("Selected physical model unavailable; no fallback was used");
    }
    let authenticated = false;
    try {
      authenticated = !!await loaded.runtime.checkAuth(provider);
    } catch {
      throw new Error("Selected model credential check unavailable");
    }
    if (!authenticated) throw new Error("Selected model has no usable credential");
    if (!Number.isFinite(model.contextWindow) || Number(model.contextWindow) < 4096) throw new Error("Selected model context budget unavailable");
    if (model.baseUrl) {
      let url;
      try {
        url = new URL(model.baseUrl);
      } catch {
        throw new Error("Selected model endpoint invalid");
      }
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Selected model endpoint invalid");
    }
    return {
      provider,
      id,
      baseUrl: model.baseUrl,
      api: model.api,
      headers: model.headers,
      fingerprint: digest(JSON.stringify([loaded.identity, loaded.configurationHash, provider, id, model.baseUrl, model.api, model.headers])),
      contextWindow: Number(model.contextWindow),
      maxTokens: Number(model.maxTokens) || 4096,
      model,
      runtime: loaded.runtime,
      ...loaded.loadAgentFactory ? { loadAgentFactory: loaded.loadAgentFactory } : {}
    };
  };
  const listAnalysisModels2 = async () => {
    const { runtime, enabledModels } = await load();
    const out = [];
    const auth = /* @__PURE__ */ new Map();
    for (const model of runtime.getModels()) {
      if (!runtime.getPhysicalModel(model.provider, model.id) || enabledModels?.length && !modelInScope(model, enabledModels)) continue;
      if (!auth.has(model.provider)) auth.set(model.provider, !!await runtime.checkAuth(model.provider));
      if (!auth.get(model.provider)) continue;
      out.push({ provider: model.provider, id: model.id, name: model.name ?? model.id, reasoning: model.reasoning === true, vision: model.input?.includes("image") === true, contextWindow: model.contextWindow });
      if (out.length >= 2e3) break;
    }
    return out;
  };
  return { resolveModel: resolveModel2, listAnalysisModels: listAnalysisModels2 };
}
async function configText(file) {
  let handle;
  try {
    handle = await openVerifiedRegularFile(file);
    if ((await handle.stat()).size > 512 * 1024) throw new Error("Global model configuration too large");
    return await handle.readFile("utf8");
  } catch (err) {
    if (err.code === "ENOENT") return "{}";
    throw new Error("Global model configuration unavailable");
  } finally {
    await handle?.close();
  }
}
function parsedConfig(raw) {
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new Error("Global model configuration invalid");
  }
}
function containsCommand(value) {
  if (typeof value === "string") return value.startsWith("!");
  if (Array.isArray(value)) return value.some(containsCommand);
  return !!value && typeof value === "object" && Object.values(value).some(containsCommand);
}
async function selectedSdkEntry(agentDir) {
  const install = process.env.PI_MANAGED_INSTALL_ROOT || path.join(agentDir, "install");
  let version;
  try {
    version = (await readFile(path.join(install, "current-version"), "utf8")).trim();
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error("Managed Pi selection unavailable");
  }
  if (version !== void 0) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version)) throw new Error("Managed Pi selection invalid");
    return path.join(install, "releases", version, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js");
  }
  throw new Error("Managed Pi selection unavailable");
}
async function loadNativeRuntime() {
  const agentDir = resolvePiAgentDir();
  const entry = await realpath(await selectedSdkEntry(agentDir));
  if (!(await stat(entry)).isFile()) throw new Error("Selected Pi SDK unavailable");
  const modelsPath = path.join(agentDir, "models.json");
  const [modelsRaw, settingsRaw] = await Promise.all([configText(modelsPath), configText(path.join(agentDir, "settings.json"))]);
  const modelConfig = parsedConfig(modelsRaw);
  const settings = parsedConfig(settingsRaw);
  if (containsCommand(modelConfig)) throw new Error("Command-valued model configuration is not allowed for restricted analysis");
  const module = await import(pathToFileURL(entry).href);
  if (typeof module.ModelRuntime?.create !== "function") throw new Error("Selected Pi SDK does not provide a compatible model runtime");
  const runtime = await module.ModelRuntime.create({ modelsPath: null, authPath: path.join(agentDir, "auth.json"), refreshOnCreate: false, allowModelNetwork: false });
  if (typeof runtime.getPhysicalModel !== "function" || typeof runtime.checkAuth !== "function" || typeof runtime.streamSimple !== "function" || typeof runtime.registerProvider !== "function") throw new Error("Selected Pi SDK does not provide a restricted model client");
  if (modelConfig.providers && typeof modelConfig.providers === "object" && !Array.isArray(modelConfig.providers)) {
    for (const [provider, config] of Object.entries(modelConfig.providers)) {
      if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("Global provider configuration invalid");
      runtime.registerProvider(provider, config);
    }
  }
  return {
    runtime,
    identity: `${entry}:${module.VERSION ?? "unknown"}`,
    loadAgentFactory: selectedAgentFactoryLoader(entry, String(module.VERSION ?? "unknown")),
    configurationHash: digest(modelsRaw),
    enabledModels: Array.isArray(settings.enabledModels) ? settings.enabledModels.filter((v) => typeof v === "string") : void 0
  };
}
const { resolveModel, listAnalysisModels } = createStrictModelResolver(loadNativeRuntime);
export {
  createStrictModelResolver,
  listAnalysisModels,
  resolveModel,
  selectedAgentFactoryLoader
};
