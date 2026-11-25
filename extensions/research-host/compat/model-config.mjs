import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { findPackageJSON } from 'node:module';
import { modelInScope } from '../adoption/shared/enabled-models-match.mjs';
import { readPiSettings, applyPiSettingsPatch, writePiSettingsRaw, mirrorDefaultsToPi } from './model-config-settings.mjs';
import { atomicJson } from '../session-host/files.mjs';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const OLD_ANTHROPIC = new Set(['claude-3-5-haiku-20241022', 'claude-3-5-haiku-latest', 'claude-3-5-sonnet-20240620',
  'claude-3-5-sonnet-20241022', 'claude-3-7-sonnet-20250219', 'claude-3-opus-20240229', 'claude-3-haiku-20240307', 'claude-3-sonnet-20240229']);
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const response = (body, statusCode = 200) => ({ statusCode, body });

function readDocument(file, fallback = {}, maxBytes = 512 * 1024) {
  let descriptor;
  try {
    descriptor = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const info = fs.fstatSync(descriptor);
    if (!info.isFile() || info.size > maxBytes || info.uid !== process.getuid?.()) fail('model-config-file-unsafe', 503);
    const raw = fs.readFileSync(descriptor, 'utf8');
    let value;
    try { value = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { fail('model-config-json-invalid', 503); }
    if (!object(value)) fail('model-config-json-object-required', 503);
    return { raw, value };
  } catch (error) { if (error.code === 'ENOENT') return { raw: '', value: clone(fallback) }; throw error; }
  finally { if (descriptor !== undefined) fs.closeSync(descriptor); }
}

function containsCommand(value) {
  if (typeof value === 'string') return value.startsWith('!');
  if (Array.isArray(value)) return value.some(containsCommand);
  return object(value) && Object.values(value).some(containsCommand);
}

function secretKey(name) { return /(?:api.?key|password|secret|token|authorization|credential)/i.test(name) || ['key', 'access', 'refresh'].includes(name); }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      let changed = false;
      if (url.username || url.password) { url.username = '***'; url.password = ''; changed = true; }
      for (const key of url.searchParams.keys()) if (secretKey(key)) { url.searchParams.set(key, '***'); changed = true; }
      if (changed) return url.href;
    } catch { return value; }
  }
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, secretKey(key) && typeof child === 'string' && child ? '***' : redact(child)]));
}
function hasSecrets(value) {
  return JSON.stringify(value) !== JSON.stringify(redact(value));
}
function legacyCredentials(settings, credentials) {
  const entries = [];
  const add = (key, provider, value) => {
    if (typeof value !== 'string' || !value) return;
    const saved = credentials?.[provider];
    entries.push({ key, provider, masked: '••••', auth: !provider || !credentials ? 'different' : !saved ? 'none'
      : saved.type === 'api_key' && saved.key === value ? 'same' : 'different' });
  };
  add('anthropicApiKey', 'anthropic', settings.anthropicApiKey); add('openaiApiKey', 'openai', settings.openaiApiKey); add('apiKey', null, settings.apiKey);
  for (const [provider, entry] of Object.entries(settings.providers ?? {})) if (object(entry)) add(`providers.${provider}.apiKey`, provider.replace(/-api$/, ''), entry.apiKey);
  return entries;
}

function introspectionRow(model, excludedReason) {
  return { id: `${model.provider}/${model.id}`, provider: model.provider,
    ...(model.reasoning != null ? { reasoning: model.reasoning } : {}), ...(model.input ? { input: clone(model.input) } : {}),
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}), ...(model.maxTokens ? { maxTokens: model.maxTokens } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: clone(model.thinkingLevelMap) } : {}), ...(model.cost ? { cost: clone(model.cost) } : {}),
    ...(excludedReason !== undefined ? { excludedReason } : {}) };
}

/** Deployed sparse override rule; max remains gated by the actual Pi helper. */
export function supportedThinkingLevels(model, maxSupported) {
  if (model.reasoning !== true) return ['off'];
  return LEVELS.filter(level => model.thinkingLevelMap?.[level] !== null
    && (level !== 'xhigh' || model.thinkingLevelMap?.[level] !== undefined)
    && (level !== 'max' || maxSupported && model.thinkingLevelMap?.[level] != null));
}

export function toSessionModel(model, maxSupported = false) {
  const thinking = typeof model.reasoning === 'boolean' || object(model.thinkingLevelMap);
  return { provider: model.provider, id: model.id, ...(typeof model.name === 'string' ? { name: model.name } : {}),
    ...(typeof model.reasoning === 'boolean' ? { reasoning: model.reasoning } : {}),
    ...(Array.isArray(model.input) ? { vision: model.input.includes('image') } : {}),
    ...(typeof model.contextWindow === 'number' ? { contextWindow: model.contextWindow } : {}),
    metadataSource: 'catalog', ...(thinking ? { supportedThinkingLevels: supportedThinkingLevels(model, maxSupported) } : {}) };
}

async function selectedModule(agentDir, installRoot) {
  const install = installRoot ?? process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(agentDir, 'install');
  const version = fs.readFileSync(path.join(install, 'current-version'), 'utf8').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,79}$/.test(version)) fail('model-runtime-selection-invalid', 503);
  const entry = fs.realpathSync(path.join(install, 'releases', version, 'node_modules/@earendil-works/pi-coding-agent/dist/index.js'));
  const sdk = await import(pathToFileURL(entry).href);
  if (typeof sdk.ModelRuntime?.create !== 'function') fail('model-runtime-unavailable', 503);
  let maxSupported = false;
  const aiManifest = findPackageJSON('@earendil-works/pi-ai', pathToFileURL(entry));
  if (aiManifest) {
    const ai = await import(pathToFileURL(path.join(path.dirname(fs.realpathSync(aiManifest)), 'dist/models.js')).href);
    if (typeof ai.getSupportedThinkingLevels === 'function') maxSupported = ai.getSupportedThinkingLevels({ reasoning: true, thinkingLevelMap: { max: 'max' } }).includes('max');
  }
  return { sdk, maxSupported };
}

/** Local configuration only: no token refresh, auth mutation, model or catalogue requests. */
export function createModelConfigApi(options = {}) {
  const agentDir = path.resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi/agent'));
  const fsDeps = { agentDirEnv: agentDir };
  let cachedKey, cachedRuntime, defaultsTail = Promise.resolve();
  const loadDocument = name => readDocument(path.join(agentDir, name));
  async function loadRuntime() {
    if (options.loadRuntime) return options.loadRuntime();
    const models = loadDocument('models.json'), auth = loadDocument('auth.json'), providers = loadDocument('providers.json');
    if (containsCommand(models.value) || containsCommand(providers.value)) fail('model-config-command-value-unavailable', 503);
    const projected = options.projectProviderConfigs?.(models.value);
    const key = createHash('sha256').update(models.raw + '\0' + auth.raw + '\0' + providers.raw + '\0' + JSON.stringify(projected ?? {})).digest('hex');
    if (key !== cachedKey) {
      cachedKey = key;
      cachedRuntime = (async () => {
        const { sdk, maxSupported } = await selectedModule(agentDir, options.managedInstallRoot);
        const credentials = { read: async provider => clone(auth.value[provider]),
          list: async () => Object.entries(auth.value).filter(([, value]) => ['api_key', 'oauth'].includes(value?.type)).map(([providerId, value]) => ({ providerId, type: value.type })),
          modify: async () => fail('model-config-read-only-credentials', 503), delete: async () => fail('model-config-read-only-credentials', 503) };
        const runtime = await sdk.ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
        const native = models.value.providers ?? {}, custom = providers.value.providers ?? {};
        for (const [provider, config] of Object.entries(native)) {
          if (!object(config)) fail('model-provider-config-invalid', 503);
          runtime.registerProvider(provider, { ...config });
        }
        for (const [provider, config] of Object.entries(projected ?? custom)) {
          if (!object(config)) fail('model-provider-config-invalid', 503);
          runtime.registerProvider(provider, { ...(native[provider] ?? {}), ...config });
        }
        return { runtime, credentials: auth.value, customProviders: custom, maxSupported };
      })().catch(error => { cachedKey = undefined; throw error; });
    }
    return cachedRuntime;
  }
  function invalidateRuntime() { cachedKey = undefined; cachedRuntime = undefined; }
  function authFor(loaded, provider) {
    const custom = loaded.customProviders?.[provider];
    if (typeof custom?.apiKey === 'string' && custom.apiKey) {
      const key = custom.apiKey.startsWith('$') ? (options.env ?? process.env)[custom.apiKey.slice(1)] : custom.apiKey;
      if (key) return { type: 'api_key', key };
    }
    return loaded.credentials?.[provider];
  }
  function modelExclusion(loaded, model) {
    const credential = authFor(loaded, model.provider);
    const usable = credential?.type === 'api_key' && credential.key
      || credential?.type === 'oauth' && (credential.access || credential.refresh);
    if (!usable) return 'no-credential';
    return credential.type === 'oauth'
      && (model.oauthCompatible === false || model.provider === 'anthropic' && OLD_ANTHROPIC.has(model.id)) ? 'oauth-incompatible' : null;
  }
  async function resolvePhysicalModel(provider, id) {
    const loaded = await loadRuntime();
    const selected = loaded.runtime.getModels().find(model => model.provider === provider && model.id === id && model.api !== 'pi-virtual');
    return selected && modelExclusion(loaded, selected) === null ? selected : undefined;
  }
  async function models({ annotated = false } = {}) {
    const loaded = await loadRuntime();
    const data = [];
    for (const model of loaded.runtime.getModels()) {
      const excluded = modelExclusion(loaded, model);
      if (annotated || !excluded) data.push(introspectionRow(model, annotated ? excluded : undefined));
    }
    return { object: 'list', data };
  }
  async function sessionModels(id, principal) {
    const row = await options.getSession?.(id);
    if (!row) fail('model-session-not-found', 404);
    if (await options.authorizeSession?.(row, principal) === false) fail('model-session-not-found', 404);
    if (row.driver === 'acp') return { type: 'models_list', sessionId: id, models: clone(row.models ?? []) };
    if (!row.live) fail('model-session-registry-unavailable', 409);
    const refreshed = await options.refreshSessionModelRegistry?.(row, { allowNetwork: false });
    let available = refreshed?.models;
    if (!row.external && !Array.isArray(available) && typeof options.command === 'function') {
      const result = await options.command(id, { type: 'get_available_models' });
      if (result?.success === true) available = result.data?.models;
    }
    if (!Array.isArray(available)) fail('model-session-registry-unavailable', 503);
    const loaded = await loadRuntime();
    const rawPatterns = readPiSettings(fsDeps).settings.enabledModels;
    const patterns = Array.isArray(rawPatterns) ? rawPatterns.filter(value => typeof value === 'string') : [];
    const sources = new Map((options.getDiscoveredModels?.() ?? []).map(model => [model.provider + '/' + model.id, model.metadataSource]));
    const native = loadDocument('models.json').value.providers ?? {};
    const choices = available.filter(model => !patterns.length || modelInScope(model, patterns))
      .map(model => {
        const choice = toSessionModel(model, loaded.maxSupported);
        const authored = native[model.provider]?.models?.some(entry => entry.id === model.id);
        return { ...choice, metadataSource: authored ? choice.metadataSource
          : sources.get(model.provider + '/' + model.id) ?? choice.metadataSource };
      });
    return { type: 'models_list', sessionId: id, models: choices };
  }
  function readProviders() {
    const providers = loadDocument('providers.json').value.providers ?? {};
    const projected = {};
    for (const [name, entry] of Object.entries(providers)) {
      if (!object(entry)) fail('model-provider-config-invalid', 503);
      const envRef = typeof entry.apiKey === 'string' && entry.apiKey.startsWith('$');
      projected[name] = { ...redact(entry), apiKey: envRef ? entry.apiKey : entry.apiKey ? '***' : '',
        ...(envRef ? { apiKeyResolved: !!(options.env ?? process.env)[entry.apiKey.slice(1)] } : {}) };
    }
    return { success: true, providers: projected, health: {} };
  }
  async function readSettings() {
    const state = readPiSettings(fsDeps);
    let credentials;
    try { credentials = loadDocument('auth.json').value; } catch { /* Settings stay editable when credential storage needs repair. */ }
    // Never send malformed source text or a legacy credential through the raw editor.
    const raw = state.parseError ? '' : hasSecrets(state.settings) ? JSON.stringify(redact(state.settings), null, 2) + '\n' : state.raw;
    return { success: true, settings: redact(state.settings), raw, etag: state.etag,
      ...(state.parseError ? { parseError: state.parseError } : {}),
      themes: options.scanThemes ? await options.scanThemes() : ['dark', 'light', 'system'], legacyCredentials: legacyCredentials(state.settings, credentials) };
  }
  const settingsRevision = () => createHash('sha256').update(readPiSettings(fsDeps).raw).digest('hex');
  async function requestReload(retry = false) {
    const result = await options.reloadConnectedSessions?.(settingsRevision(), retry);
    return typeof result === 'number' ? { reloadedSessions: result } : result ?? { reloadedSessions: 0 };
  }
  async function writeSettings(body, raw = false) {
    if (typeof body?.baseEtag !== 'string') return response({ success: false, error: 'baseEtag is required' }, 400);
    if (raw && Buffer.byteLength(JSON.stringify(body)) > 256 * 1024) return response({ success: false, error: 'Request body too large' }, 413);
    // A redacted raw payload cannot safely replace existing credentials.
    if (raw && hasSecrets(readPiSettings(fsDeps).settings)) return response({ success: false, error: 'raw-settings-contain-redacted-credentials' }, 409);
    const result = await (raw ? writePiSettingsRaw(body.raw, body.baseEtag, fsDeps) : applyPiSettingsPatch(body.patch, body.baseEtag, fsDeps));
    if (!result.ok) {
      const status = { invalid: 400, parse: 400, stale: 409, busy: 503, io: 500 }[result.error] ?? 500;
      if (result.error === 'stale') return response({ ...await readSettings(), success: false, error: 'stale' }, status);
      return response({ success: false, error: result.error === 'invalid' ? result.errors.map(error => error.message).join('; ') : result.parseError ?? result.error,
        ...(result.errors ? { errors: result.errors } : {}), ...(result.parseError ? { parseError: result.parseError } : {}) }, status);
    }
    return response({ ...await readSettings(), ...await requestReload(), ...(result.restoredKeys ? { restoredKeys: result.restoredKeys } : {}) });
  }
  function getDefaults() {
    if (options.readDefaults) {
      const config = options.readDefaults();
      if (!object(config) || typeof config.then === 'function') fail('model-defaults-synchronous-read-required', 503);
      return { defaultModel: config.defaultModel, defaultThinkingLevel: config.defaultThinkingLevel };
    }
    if (options.defaultsFile) {
      const config = readDocument(options.defaultsFile).value;
      return { defaultModel: config.defaultModel, defaultThinkingLevel: config.defaultThinkingLevel };
    }
    const settings = readPiSettings(fsDeps).settings;
    return { defaultModel: settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : '',
      defaultThinkingLevel: settings.defaultThinkingLevel };
  }
  function setDefaults(partial) {
    const run = async () => {
      if (!object(partial) || !Object.keys(partial).length || Object.keys(partial).some(key => !['defaultModel', 'defaultThinkingLevel'].includes(key))) fail('model-defaults-patch-invalid');
      if (partial.defaultModel !== undefined && (typeof partial.defaultModel !== 'string' || partial.defaultModel.length > 1024 || /[\x00-\x1f]/.test(partial.defaultModel))) fail('model-default-invalid');
      if (partial.defaultThinkingLevel !== undefined && !['', ...LEVELS].includes(partial.defaultThinkingLevel)) fail('model-thinking-level-invalid');
      if (options.writeDefaults) {
        const saved = await options.writeDefaults(partial); if (saved?.success === false) fail('model-defaults-write-failed', 500);
      } else if (options.defaultsFile) atomicJson(options.defaultsFile, { ...readDocument(options.defaultsFile).value, ...partial });
      else fail('model-defaults-storage-unavailable', 501);
      const piMirror = await mirrorDefaultsToPi(getDefaults, Object.keys(partial), fsDeps);
      return { success: true, piMirror, ...getDefaults(), ...(piMirror.ok ? await requestReload() : {}) };
    };
    const task = defaultsTail.then(run, run); defaultsTail = task.catch(() => {}); return task;
  }
  async function syncDefaults() {
    const piMirror = await mirrorDefaultsToPi(getDefaults, ['defaultModel', 'defaultThinkingLevel'], fsDeps);
    if (!piMirror.ok) return response({ success: false, error: piMirror.error }, piMirror.error === 'busy' ? 503 : 400);
    return response({ ...await readSettings(), piMirror, ...await requestReload() });
  }
  async function handle({ method, url, body, principal }) {
    const pathname = url.pathname;
    const known = method === 'GET' && ['/api/models', '/api/providers', '/api/pi-settings', '/api/pi-settings/reload'].includes(pathname)
      || method === 'PUT' && ['/api/pi-settings', '/api/pi-settings/raw'].includes(pathname)
      || method === 'POST' && ['/api/pi-settings/sync-defaults', '/api/pi-settings/reload'].includes(pathname);
    if (!known) return null;
    if (await options.authorize?.({ method, pathname, principal }) === false) return response({ success: false, error: 'model-config-access-denied' }, 403);
    try {
      if (pathname === '/api/models') return response(await models({ annotated: ['1', 'true'].includes(url.searchParams.get('annotated')) }));
      if (pathname === '/api/providers') return response(readProviders());
      if (pathname === '/api/pi-settings/reload') {
        if (!options.getReload && !options.reloadConnectedSessions) fail('model-settings-reload-unavailable', 503);
        return response({ success: true, ...(method === 'GET' ? options.getReload?.() : await requestReload(true)) });
      }
      if (method === 'GET') return response(await readSettings());
      if (pathname.endsWith('/sync-defaults')) return syncDefaults();
      return writeSettings(body, pathname.endsWith('/raw'));
    } catch (error) {
      if (pathname === '/api/models') return response({ code: 'MODEL_PROXY_RUNTIME_MISSING', message: 'pi-ai is not installed or cannot be resolved' }, 503);
      return response({ success: false, error: error.code ?? 'model-config-unavailable' }, error.statusCode ?? 503);
    }
  }
  function migrationGates() {
    const providers = loadDocument('providers.json').value.providers ?? {};
    return { externalProviderCatalogues: Object.keys(providers), providerWritesImplemented: false, providerTestsImplemented: false,
      oauthFlowsImplemented: false, credentialWritesImplemented: false,
      sessionRegistryRefreshImplemented: typeof options.refreshSessionModelRegistry === 'function',
      liveSettingsReloadImplemented: typeof options.reloadConnectedSessions === 'function',
      themeScannerImplemented: typeof options.scanThemes === 'function',
      rawEditorRedacted: hasSecrets(readPiSettings(fsDeps).settings) };
  }
  return { handle, models, resolvePhysicalModel, sessionModels, readProviders, readSettings, writeSettings, settingsRevision, invalidateRuntime,
    getDefaults, setDefaults, syncDefaults, migrationGates };
}
