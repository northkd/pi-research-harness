import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const unsafe = new Set(['__proto__', 'constructor', 'prototype']);
export const providerFingerprint = (value, env = process.env) => createHash('sha256').update(JSON.stringify([value,
  typeof value?.apiKey === 'string' && value.apiKey.startsWith('$') ? env[value.apiKey.slice(1)] ?? null : null])).digest('hex');
export function literalConfigValue(value) {
  let result = String(value).replace(/\$/g, () => '$$');
  if (result.startsWith('!')) result = '$' + result;
  return result;
}
export function toRegisterApiKey(value) {
  return value.startsWith('$') ? value : literalConfigValue(value);
}

function nativeModels(document) {
  const entries = new Map();
  const add = entry => {
    if (object(entry) && typeof entry.provider === 'string' && typeof entry.id === 'string') entries.set(`${entry.provider}/${entry.id}`, entry);
  };
  if (Array.isArray(document)) document.forEach(add);
  else if (object(document)) {
    if (Array.isArray(document.models)) document.models.forEach(add);
    for (const [provider, config] of Object.entries(document.providers ?? {})) {
      if (Array.isArray(config?.models)) config.models.forEach(entry => add({ ...entry, provider }));
    }
  }
  return [...entries.values()];
}

/** Actual ProviderConfigInput; native authored capabilities win field by field. */
export function projectNativeProviders({ providers, discoveredModels = [], modelsDocument = {}, registryModels = [] }) {
  const native = nativeModels(modelsDocument), result = Object.create(null);
  for (const [name, entry] of Object.entries(providers ?? {})) {
    if (!object(entry) || unsafe.has(name)) continue;
    const byId = new Map(), lower = new Map(registryModels.filter(model => model.provider === name).map(model => [model.id, model]));
    for (const model of discoveredModels) if (model.provider === name) byId.set(model.id, { ...lower.get(model.id), ...model });
    for (const model of native) if (model.provider === name) byId.set(model.id, { ...lower.get(model.id), ...byId.get(model.id), ...model });
    const api = entry.api || 'openai-completions';
    const floor = api === 'anthropic-messages' ? { contextWindow: 200_000, maxTokens: 64_000 }
      : api === 'google-generative-ai' ? { contextWindow: 1_000_000, maxTokens: 65_536 } : { contextWindow: 128_000, maxTokens: 16_384 };
    result[name] = { baseUrl: entry.baseUrl ?? '', api, apiKey: toRegisterApiKey(entry.apiKey ?? ''),
      models: [...byId.values()].map(model => ({ id: model.id, name: model.name ?? model.id,
        ...(model.api ? { api: model.api } : {}), ...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
        reasoning: model.reasoning ?? false, input: clone(model.input ?? ['text']),
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...(model.cost ?? {}) },
        contextWindow: model.contextWindow ?? floor.contextWindow, maxTokens: model.maxTokens ?? floor.maxTokens,
        ...(model.thinkingLevelMap ? { thinkingLevelMap: clone(model.thinkingLevelMap) } : {}),
        ...(model.compat ? { compat: clone(model.compat) } : {}),
        ...(model.samplingParams ? { samplingParams: clone(model.samplingParams) } : {}),
        ...(model.samplingParamsByThinkingLevel ? { samplingParamsByThinkingLevel: clone(model.samplingParamsByThinkingLevel) } : {}),
        ...(model.headers ? { headers: Object.fromEntries(Object.entries(model.headers).map(([key, value]) => [key, literalConfigValue(value)])) } : {}) })) };
  }
  return result;
}

export function readPrivateJson(file, maximum = 16 * 1024 * 1024) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.uid !== process.getuid?.() || info.size > maximum) throw new Error('provider-private-file-unsafe');
    return JSON.parse(fs.readFileSync(fd, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function readProviderCatalogue(file, providers, env = process.env) {
  try { if ((fs.lstatSync(file).mode & 0o077) !== 0) throw new Error('provider-catalogue-mode-unsafe'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const stored = readPrivateJson(file);
  if (!stored) return [];
  if (stored.schema !== 'pi-research-provider-catalogue.v1' || !object(stored.providers)) throw new Error('provider-catalogue-invalid');
  return Object.entries(stored.providers).flatMap(([name, entry]) => object(entry) && object(providers?.[name])
    && entry.fingerprint === providerFingerprint(providers[name], env) && Array.isArray(entry.models)
    ? entry.models.filter(model => object(model) && model.provider === name && typeof model.id === 'string').map(clone) : []);
}

export function writeProviderCatalogue(file, providers, models, env = process.env) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const dir = fs.lstatSync(path.dirname(file));
  if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid?.() || fs.realpathSync(path.dirname(file)) !== path.dirname(file)) throw new Error('provider-catalogue-directory-unsafe');
  const records = Object.create(null);
  for (const [name, entry] of Object.entries(providers)) records[name] = { fingerprint: providerFingerprint(entry, env), models: models.filter(model => model.provider === name) };
  const snapshot = { schema: 'pi-research-provider-catalogue.v1', updatedAt: Date.now(), providers: records };
  const temporary = file + '.' + randomUUID() + '.tmp';
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(snapshot) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.renameSync(temporary, file); } catch (error) { fs.rmSync(temporary, { force: true }); throw error; }
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

/** Safe to call at native extension startup: reads local files and makes no requests. */
export function loadNativeProviderConfigs({ agentDir, catalogueFile = path.join(agentDir, 'provider-models-cache.json'), registryModels = [] }) {
  const providers = readPrivateJson(path.join(agentDir, 'providers.json'))?.providers ?? {};
  const modelsDocument = readPrivateJson(path.join(agentDir, 'models.json')) ?? {};
  const discoveredModels = readProviderCatalogue(catalogueFile, providers);
  return projectNativeProviders({ providers, discoveredModels, modelsDocument, registryModels });
}

export async function applyNativeProviderConfigs({ pi, ctx, configs, previous = new Set() }) {
  const errors = new Map(), registered = new Set();
  for (const name of previous) if (!Object.hasOwn(configs, name)) {
    try { pi.unregisterProvider(name); } catch (error) { errors.set(name, error); }
  }
  for (const [name, config] of Object.entries(configs)) {
    try {
      if (previous.has(name)) pi.unregisterProvider(name);
      pi.registerProvider(name, config); registered.add(name);
    } catch (error) { errors.set(name, error); }
  }
  const refresh = await ctx.modelRegistry.refresh({ allowNetwork: false });
  return { registered, refresh, errors };
}
