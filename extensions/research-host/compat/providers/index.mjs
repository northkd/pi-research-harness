import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createProbeModule } from './upstream/probe.mjs';
import { createProviderRoutesModule } from './upstream/routes.mjs';
import { createDiscoveryModule } from './upstream/discovery.mjs';
import { collectDashboardOrigins, isSelfPointing } from './shared/recursion-guard.mjs';
import lockfile from './upstream/lockfile.mjs';
import { readProviderCatalogue, writeProviderCatalogue, providerFingerprint, projectNativeProviders } from './native.mjs';
export { projectNativeProviders, loadNativeProviderConfigs, applyNativeProviderConfigs, readProviderCatalogue, toRegisterApiKey } from './native.mjs';

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const clone = value => structuredClone(value);
const json = (body, statusCode = 200) => ({ statusCode, body });
const fail = (code, statusCode = 400) => { throw Object.assign(new Error(code), { code, statusCode }); };
const unsafeNames = new Set(['__proto__', 'prototype', 'constructor']);
const secretParameter = /(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|client[-_]?secret)/i;

/** The network wrapper bounds bodies and never forwards a provider key through a redirect. */
function boundedFetch(fetchImpl, bodyLimit = 4 * 1024 * 1024) {
  return async (input, options) => {
    const url = new URL(input);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid provider URL');
    const response = await fetchImpl(url.href, { ...options, redirect: 'error' });
    if (!response.body) return response;
    const length = Number(response.headers?.get('content-length'));
    if (Number.isFinite(length) && length > bodyLimit) { await response.body.cancel(); throw new Error('Provider response body is too large'); }
    const reader = response.body.getReader(), chunks = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > bodyLimit) { await reader.cancel(); throw new Error('Provider response body is too large'); }
        chunks.push(Buffer.from(result.value));
      }
    } finally { reader.releaseLock(); }
    return new Response(Buffer.concat(chunks, size), { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

function scrub(value, secrets) {
  if (typeof value === 'string') {
    for (const secret of secrets) if (secret) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  return object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)])) : value;
}

function redactResponse(value) {
  if (Array.isArray(value)) return value.map(redactResponse);
  if (typeof value === 'string' && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      let changed = false;
      if (url.username || url.password) { url.username = '***'; url.password = ''; changed = true; }
      for (const key of url.searchParams.keys()) if (secretParameter.test(key)) { url.searchParams.set(key, '***'); changed = true; }
      if (changed) return url.href;
    } catch { return value; }
  }
  if (!object(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    typeof item === 'string' && item && /(?:api[-_]?key|authorization|password|secret|access[-_]?token|refresh[-_]?token)/i.test(key)
      ? key === 'apiKey' && item.startsWith('$') ? item : '***' : redactResponse(item)]));
}

export function createProviderApi(options = {}) {
  if (typeof options.invalidateRegistry !== 'function' || typeof options.notifySessions !== 'function') fail('provider-host-hooks-required', 500);
  const agentDir = path.resolve(options.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), '.pi/agent'));
  const configPath = path.join(agentDir, 'providers.json');
  const catalogueFile = options.catalogueFile ?? path.join(agentDir, 'provider-models-cache.json');
  const env = options.env ?? process.env;
  const fingerprint = value => providerFingerprint(value, env);
  const health = new Map(), discovered = new Map(), pending = new Set();
  let generation = 0, disposed = false;
  const controllers = new Set();
  const fetchBounded = boundedFetch((url, init) => (options.fetch ?? globalThis.fetch)(url, init), options.maxResponseBytes);
  const fetchImpl = async (url, init) => {
    if (disposed) throw new Error('Provider API is closed');
    const controller = new AbortController(); controllers.add(controller);
    try { return await fetchBounded(url, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal }); }
    finally { controllers.delete(controller); }
  };
  const track = promise => {
    const job = Promise.resolve(promise);
    pending.add(job);
    job.catch(() => options.onDiagnostic?.('provider-background-operation-failed')).finally(() => pending.delete(job));
    return job;
  };
  const probes = createProbeModule({ configPath, env, fetch: fetchImpl });
  const readProviders = () => { assertConfigFile(); return clone(probes.readProvidersFromDisk()); };
  const resolveProbeApiKey = input => probes.resolveProbeApiKey({ ...input, readProviders });
  const discovery = createDiscoveryModule({ ...probes,
    listProviderModels: input => probes.listProviderModels({ ...input, timeoutMs: options.probeTimeoutMs ?? input.timeoutMs }),
    readProvidersFromDisk: readProviders, resolveProbeApiKey });
  const secretsFor = () => Object.values(readProviders()).flatMap(entry => {
    const resolved = typeof entry?.apiKey === 'string' ? resolveProbeApiKey({ apiKey: entry.apiKey }) : undefined;
    return resolved?.ok ? [resolved.key] : [];
  });
  try {
    const current = readProviders();
    for (const model of readProviderCatalogue(catalogueFile, current, env)) {
      let record = discovered.get(model.provider);
      if (!record) { record = { fingerprint: fingerprint(current[model.provider]), models: [] }; discovered.set(model.provider, record); }
      record.models.push(model);
    }
  } catch { options.onDiagnostic?.('provider-catalogue-cache-unavailable'); }

  function assertConfigFile() {
    let info;
    try { info = fs.lstatSync(configPath); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || info.size > 2 * 1024 * 1024) fail('provider-config-file-unsafe', 503);
  }
  function origins(port, details) {
    return [...collectDashboardOrigins(port, details), ...(typeof options.origins === 'function' ? options.origins() : options.origins ?? [])];
  }
  function validateName(name) {
    if (typeof name !== 'string' || name.trim() === '' || name.length > 256 || /[\x00-\x1f]/.test(name) || unsafeNames.has(name)) fail('Provider name is required');
  }
  function validateEntry(entry) {
    if (!object(entry)) fail('Invalid provider');
    for (const key of ['baseUrl', 'apiKey', 'api']) if (entry[key] !== undefined && typeof entry[key] !== 'string') fail(`Invalid ${key}`);
    if (entry.baseUrl) {
      let url;
      try { url = new URL(entry.baseUrl); } catch { fail('Invalid baseUrl'); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash
        || [...url.searchParams.keys()].some(key => secretParameter.test(key))) fail('Provider baseUrl must be an HTTP URL without embedded credentials');
    }
    if (entry.apiKey?.includes('\0') || entry.api?.includes('\0')) fail('Invalid provider');
  }
  function probeProvider(input) {
    return track(probes.probeProvider({ ...input, timeoutMs: options.probeTimeoutMs ?? input.timeoutMs })
      .then(result => scrub(result, [input.apiKey])));
  }
  function getDiscoveredModels() {
    const current = readProviders();
    return [...discovered].flatMap(([name, value]) => object(current[name]) && value.fingerprint === fingerprint(current[name]) ? clone(value.models) : []);
  }
  async function refreshRegistry() {
    const snapshot = readProviders();
    const entries = Object.entries(snapshot);
    for (const [name, entry] of entries) { validateName(name); validateEntry(entry); }
    writeProviderCatalogue(catalogueFile, snapshot, getDiscoveredModels(), env);
    await options.invalidateRegistry({ generation: ++generation, models: getDiscoveredModels(), phase: 'configuration' });
    const results = await Promise.all(entries.map(async ([name, entry]) => {
      const resolved = typeof entry?.apiKey === 'string' ? resolveProbeApiKey({ apiKey: entry.apiKey }) : undefined;
      const models = await discovery.discoverProviderModels(name, entry);
      return { name, fingerprint: fingerprint(entry), models: models.filter(model => !resolved?.ok || !model.id.includes(resolved.key)) };
    }));
    if (disposed) return { generation, models: getDiscoveredModels(), phase: 'cancelled' };
    const current = readProviders();
    for (const result of results) if (object(current[result.name]) && fingerprint(current[result.name]) === result.fingerprint) discovered.set(result.name, result);
    for (const name of discovered.keys()) if (!Object.hasOwn(current, name)) discovered.delete(name);
    const result = { generation: ++generation, models: getDiscoveredModels(), phase: 'catalogue' };
    writeProviderCatalogue(catalogueFile, current, result.models, env);
    await options.invalidateRegistry(result);
    return result;
  }
  const routeModule = createProviderRoutesModule({ configPath, env, collectDashboardOrigins: origins, isSelfPointing,
    getTunnelUrl: () => options.tunnelUrl?.(), refreshModelRegistry: () => track(refreshRegistry()),
    probeProvider, resolveProbeApiKey,
    deleteProviderHealth: name => health.delete(name), getAllProviderHealth: () => scrub(Object.fromEntries(health), secretsFor()),
    retainProviderHealth: names => { const keep = new Set(names); for (const name of health.keys()) if (!keep.has(name)) health.delete(name); },
    setProviderHealth: (name, value) => health.set(name, clone(value)) });

  const routes = [];
  const register = method => (pattern, config, handler) => {
    routes.push({ method, pattern, handler: handler ?? config });
  };
  routeModule.registerProviderRoutes({ get: register('GET'), put: register('PUT'), patch: register('PATCH'), delete: register('DELETE'), post: register('POST') },
    { networkGuard: () => {}, port: options.port ?? 18768,
      piGateway: { broadcast: message => track(Promise.resolve().then(() => options.notifySessions(clone(message)))) } });

  function routeFor(method, pathname) {
    for (const route of routes) {
      if (route.method !== method) continue;
      if (!route.pattern.includes(':name') && pathname === route.pattern) return { route, params: {} };
      if (route.pattern.includes(':name')) {
        const match = new RegExp('^' + route.pattern.replace(':name', '([^/]+)') + '$').exec(pathname);
        if (match) {
          let name;
          try { name = decodeURIComponent(match[1]); } catch { fail('Invalid provider name'); }
          validateName(name);
          return { route, params: { name } };
        }
      }
    }
  }
  async function handle(request) {
    let selected;
    try { selected = routeFor(request.method, request.pathname ?? request.url?.pathname); }
    catch (error) { return json({ success: false, error: error.code }, error.statusCode ?? 400); }
    if (!selected) return null;
    if (disposed) return json({ success: false, error: 'provider-api-closed' }, 503);
    if (await options.authorize?.(request) === false) return json({ success: false, error: 'provider-access-denied' }, 403);
    let release;
    try {
      assertConfigFile();
      const { method, body } = request;
      if (method === 'PUT') {
        if (!object(body) || !object(body.providers)) fail('Invalid body');
        for (const [name, entry] of Object.entries(body.providers)) { validateName(name); validateEntry(entry); }
      }
      if (method === 'PATCH') validateEntry(body);
      if (method === 'POST' && selected.route.pattern === '/api/providers/test') {
        if (!object(body)) fail('Invalid body');
        validateEntry(body);
        if (body.name !== undefined) validateName(body.name);
      }
      if (['PUT', 'PATCH', 'DELETE'].includes(method)) {
        fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
        const info = fs.lstatSync(agentDir);
        if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || fs.realpathSync(agentDir) !== agentDir) fail('provider-directory-unsafe', 503);
        release = await lockfile.lock(configPath, { realpath: false, stale: 30_000,
          retries: { retries: 10, minTimeout: 20, maxTimeout: 200 }, onCompromised: () => options.onDiagnostic?.('provider-lock-compromised') });
        assertConfigFile();
      }
      let statusCode = 200, sent, completed = false;
      const reply = { code(value) { statusCode = value; return this; }, send(value) { sent = value; completed = true; return value; } };
      const value = await selected.route.handler({ ...request, params: selected.params }, reply);
      const result = completed ? sent : value;
      return json(redactResponse(scrub(result, secretsFor())), statusCode);
    } catch (error) {
      return json({ success: false, error: error.code === 'ELOCKED' ? 'provider-settings-busy' : error.code ?? 'provider-operation-failed' }, error.code === 'ELOCKED' ? 503 : error.statusCode ?? 500);
    } finally { if (release) await release().catch(() => {}); }
  }
  async function whenIdle() { while (pending.size) await Promise.allSettled([...pending]); }
  return { handle, readProviders, getDiscoveredModels, refreshRegistry: () => track(refreshRegistry()),
    nativeConfigs: modelsDocument => projectNativeProviders({ providers: readProviders(), discoveredModels: getDiscoveredModels(), modelsDocument }),
    catalogueFile,
    discover: () => track(refreshRegistry()), whenIdle,
    health: () => scrub(Object.fromEntries(health), secretsFor()),
    async dispose() { disposed = true; for (const controller of controllers) controller.abort(); await whenIdle(); } };
}
