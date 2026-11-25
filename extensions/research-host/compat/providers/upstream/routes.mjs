import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
export function createProviderRoutesModule(host) {
const {collectDashboardOrigins,isSelfPointing,refreshModelRegistry,probeProvider,resolveProbeApiKey,getTunnelUrl,
      deleteProviderHealth,getAllProviderHealth,retainProviderHealth,setProviderHealth} = host;
const REDACTED = "***";
const CONFIG_PATH = host.configPath;
function toHealth(result) {
  return result.ok ? { ok: true, status: result.status, modelCount: result.modelCount, testedAt: Date.now() } : { ok: false, status: result.status, error: result.error, testedAt: Date.now() };
}
async function probeAndCacheProvider(name, entry) {
  if (!entry.baseUrl || !entry.api) {
    deleteProviderHealth(name);
    return;
  }
  const resolved = resolveProbeApiKey({ apiKey: entry.apiKey, name, readProviders: readProvidersRaw });
  if (!resolved.ok) {
    setProviderHealth(name, { ok: false, error: resolved.error, testedAt: Date.now() });
    return;
  }
  const result = await probeProvider({ baseUrl: entry.baseUrl, apiKey: resolved.key, api: entry.api });
  if (!result.ok && resolved.key) result.error = result.error.split(resolved.key).join(REDACTED);
  setProviderHealth(name, toHealth(result));
}
function readProvidersRaw() {
  return readProvidersFileDataChecked().fileData.providers ?? {};
}
const quarantinedProviderBackups = /* @__PURE__ */ new Set();
function quarantineStamp(date = /* @__PURE__ */ new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(".", "");
}
function quarantineCorruptProvidersFile(bytes) {
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (quarantinedProviderBackups.has(digest)) return true;
  const base = `${CONFIG_PATH}.corrupt-${quarantineStamp()}`;
  let target = base;
  for (let n = 1; ; n++) {
    try {
      writeFileSync(target, bytes, { flag: "wx", mode: 384 });
    } catch (err) {
      if (err?.code === "EEXIST") {
        target = `${base}-${n}`;
        continue;
      }
      try {
        unlinkSync(target);
      } catch {
      }
      console.warn(
        `[providers] could not quarantine corrupt providers.json: write ${target} failed:`,
        err?.message ?? err
      );
      return false;
    }
    quarantinedProviderBackups.add(digest);
    console.warn(
      `[providers] providers.json is corrupt (unparseable content); quarantined a byte-exact copy to ${target}`
    );
    return true;
  }
}
function readProvidersFileDataChecked() {
  if (!existsSync(CONFIG_PATH)) return { fileData: {}, corrupt: false, quarantined: false };
  let bytes;
  try {
    bytes = readFileSync(CONFIG_PATH);
  } catch (err) {
    if (err?.code === "ENOENT") return { fileData: {}, corrupt: false, quarantined: false };
    throw err;
  }
  try {
    const text = bytes.toString("utf-8");
    const stripped = text.charCodeAt(0) === 65279 ? text.slice(1) : text;
    const parsed = JSON.parse(stripped);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new SyntaxError("providers.json content is not a JSON object");
    }
    const providers = parsed.providers;
    if (providers !== void 0 && providers !== null && (typeof providers !== "object" || Array.isArray(providers))) {
      throw new SyntaxError("providers.json `providers` is not a JSON object");
    }
    return { fileData: parsed, corrupt: false, quarantined: false };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    const quarantined = quarantineCorruptProvidersFile(bytes);
    return { fileData: {}, corrupt: true, quarantined };
  }
}
function corruptProvidersRefusal(quarantined) {
  return {
    success: false,
    error: quarantined ? `Refusing to write providers: ${CONFIG_PATH} is corrupt. A byte-exact copy was quarantined beside it. Fix or remove the file manually, then try again.` : `Refusing to write providers: ${CONFIG_PATH} is corrupt and could not be backed up. Fix or remove the file manually, then try again.`
  };
}
function writeProvidersFileData(fileData) {
  const dir = dirname(CONFIG_PATH);
  mkdirSync(dir, { recursive: true });
  const tmp = `${CONFIG_PATH}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(fileData, null, 2) + "\n", { encoding: "utf-8", mode: 384 });
  chmodSync(tmp, 384);
  syncPath(tmp);
  renameSync(tmp, CONFIG_PATH);
  syncPath(dir);
}
function syncPath(path) {
  let fd;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } catch {
  } finally {
    if (fd !== void 0) {
      try {
        closeSync(fd);
      } catch {
      }
    }
  }
}
function redactProviders(providers) {
  const redacted = {};
  for (const [name, entry] of Object.entries(providers)) {
    const isEnvRef = !!(entry.apiKey && entry.apiKey.startsWith("$"));
    redacted[name] = {
      ...entry,
      apiKey: isEnvRef ? entry.apiKey : entry.apiKey ? REDACTED : ""
    };
    if (isEnvRef) {
      const varName = entry.apiKey.slice(1);
      const value = varName ? host.env[varName] : void 0;
      redacted[name].apiKeyResolved = value !== void 0 && value !== "";
    }
  }
  return redacted;
}
function registerProviderRoutes(fastify, deps) {
  const { networkGuard, piGateway } = deps;
  fastify.get(
    "/api/providers",
    { preHandler: networkGuard },
    async () => {
      const providers = readProvidersRaw();
      return { success: true, providers: redactProviders(providers), health: getAllProviderHealth() };
    }
  );
  fastify.put(
    "/api/providers",
    { preHandler: networkGuard },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object" || !body.providers || typeof body.providers !== "object") {
        return reply.code(400).send({ success: false, error: "Invalid body" });
      }
      const incoming = body.providers;
      for (const name of Object.keys(incoming)) {
        if (name.trim() === "") {
          return reply.code(400).send({
            success: false,
            error: "Provider name is required"
          });
        }
      }
      const dashboardPort = deps.port ?? 8e3;
      const tunnelUrl = getTunnelUrl();
      const tunnelHostname = tunnelUrl ? new URL(tunnelUrl).hostname : void 0;
      const origins = collectDashboardOrigins(dashboardPort, { tunnelHostname });
      for (const [name, entry] of Object.entries(incoming)) {
        if (entry.baseUrl && isSelfPointing(entry.baseUrl, origins)) {
          return reply.code(400).send({
            success: false,
            code: "RECURSIVE_PROXY",
            message: `Provider "${name}" baseUrl points back at this dashboard`,
            offendingBaseUrl: entry.baseUrl
          });
        }
      }
      const existing = readProvidersRaw();
      for (const [name, entry] of Object.entries(incoming)) {
        if (entry.apiKey === REDACTED && !existing[name]) {
          return reply.code(400).send({
            success: false,
            error: `Provider "${name}" has no saved API key to preserve; enter the API key before saving.`
          });
        }
      }
      const merged = {};
      for (const [name, entry] of Object.entries(incoming)) {
        merged[name] = {
          baseUrl: entry.baseUrl,
          apiKey: entry.apiKey === REDACTED && existing[name] ? existing[name].apiKey : entry.apiKey,
          api: entry.api
        };
      }
      const putRead = readProvidersFileDataChecked();
      if (putRead.corrupt) {
        return reply.code(409).send(corruptProvidersRefusal(putRead.quarantined));
      }
      const fileData = putRead.fileData;
      fileData.providers = merged;
      writeProvidersFileData(fileData);
      if (piGateway) {
        piGateway.broadcast({ type: "credentials_updated" });
      }
      refreshModelRegistry().catch(() => {
      });
      retainProviderHealth(Object.keys(merged));
      await Promise.all(Object.entries(merged).map(([name, entry]) => probeAndCacheProvider(name, entry)));
      return { success: true };
    }
  );
  fastify.patch(
    "/api/providers/:name",
    { preHandler: networkGuard },
    async (request, reply) => {
      const name = request.params.name;
      if (typeof name !== "string" || name.trim() === "") {
        return reply.code(400).send({ success: false, error: "Provider name is required" });
      }
      const body = request.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ success: false, error: "Invalid body" });
      }
      for (const field of ["baseUrl", "apiKey", "api"]) {
        if (body[field] !== void 0 && typeof body[field] !== "string") {
          return reply.code(400).send({ success: false, error: `Invalid ${field}` });
        }
      }
      const patchRead = readProvidersFileDataChecked();
      if (patchRead.corrupt) {
        return reply.code(409).send(corruptProvidersRefusal(patchRead.quarantined));
      }
      const fileData = patchRead.fileData;
      const existing = fileData.providers ?? {};
      const prev = existing[name];
      if (body.apiKey === REDACTED && !prev) {
        return reply.code(400).send({
          success: false,
          error: `Provider "${name}" has no saved API key to preserve; enter the API key before saving.`
        });
      }
      const entry = {
        baseUrl: typeof body.baseUrl === "string" ? body.baseUrl : prev?.baseUrl ?? "",
        apiKey: body.apiKey === REDACTED ? prev.apiKey : typeof body.apiKey === "string" ? body.apiKey : prev?.apiKey ?? "",
        api: typeof body.api === "string" ? body.api : prev?.api
      };
      const dashboardPort = deps.port ?? 8e3;
      const tunnelUrl = getTunnelUrl();
      const tunnelHostname = tunnelUrl ? new URL(tunnelUrl).hostname : void 0;
      const origins = collectDashboardOrigins(dashboardPort, { tunnelHostname });
      if (entry.baseUrl && isSelfPointing(entry.baseUrl, origins)) {
        return reply.code(400).send({
          success: false,
          code: "RECURSIVE_PROXY",
          message: `Provider "${name}" baseUrl points back at this dashboard`,
          offendingBaseUrl: entry.baseUrl
        });
      }
      existing[name] = entry;
      fileData.providers = existing;
      writeProvidersFileData(fileData);
      if (piGateway) {
        piGateway.broadcast({ type: "credentials_updated" });
      }
      refreshModelRegistry().catch(() => {
      });
      retainProviderHealth(Object.keys(existing));
      void probeAndCacheProvider(name, entry).catch(() => {
      });
      return { success: true };
    }
  );
  fastify.delete(
    "/api/providers/:name",
    { preHandler: networkGuard },
    async (request, reply) => {
      const name = request.params.name;
      if (typeof name !== "string" || name.trim() === "") {
        return reply.code(400).send({ success: false, error: "Provider name is required" });
      }
      const deleteRead = readProvidersFileDataChecked();
      if (deleteRead.corrupt) {
        return reply.code(409).send(corruptProvidersRefusal(deleteRead.quarantined));
      }
      const fileData = deleteRead.fileData;
      const existing = fileData.providers ?? {};
      if (!(name in existing)) {
        return { success: true };
      }
      delete existing[name];
      fileData.providers = existing;
      writeProvidersFileData(fileData);
      if (piGateway) {
        piGateway.broadcast({ type: "credentials_updated" });
      }
      refreshModelRegistry().catch(() => {
      });
      deleteProviderHealth(name);
      return { success: true };
    }
  );
  fastify.post(
    "/api/providers/:name/refresh",
    { preHandler: networkGuard },
    async (request, reply) => {
      const name = request.params.name;
      const read = readProvidersFileDataChecked();
      if (read.corrupt) {
        return reply.code(409).send(corruptProvidersRefusal(read.quarantined));
      }
      const providers = read.fileData.providers ?? {};
      if (typeof name !== "string" || !Object.hasOwn(providers, name)) {
        return reply.code(404).send({ success: false, error: `Provider "${name}" not found` });
      }
      if (piGateway) {
        piGateway.broadcast({ type: "credentials_updated", refreshProviders: [name] });
      }
      refreshModelRegistry().catch(() => {
      });
      await probeAndCacheProvider(name, providers[name]).catch(() => {
      });
      return { success: true, health: getAllProviderHealth()[name] ?? null };
    }
  );
  fastify.post(
    "/api/providers/test",
    { preHandler: networkGuard },
    async (request, reply) => {
      const body = request.body;
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ ok: false, error: "Invalid body" });
      }
      const name = typeof body.name === "string" ? body.name : void 0;
      const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
      const apiKey = typeof body.apiKey === "string" ? body.apiKey : "";
      const api = typeof body.api === "string" ? body.api : void 0;
      if (!baseUrl) {
        return reply.code(400).send({ ok: false, error: "baseUrl is required" });
      }
      if (!apiKey) {
        return reply.code(400).send({ ok: false, error: "apiKey is required" });
      }
      if (!api) {
        return reply.code(400).send({ ok: false, error: "api type is required" });
      }
      const resolved = resolveProbeApiKey({
        apiKey,
        name,
        readProviders: readProvidersRaw
      });
      if (!resolved.ok) {
        if (name) setProviderHealth(name, { ok: false, error: resolved.error, testedAt: Date.now() });
        return { ok: false, error: resolved.error };
      }
      const result = await probeProvider({
        baseUrl,
        apiKey: resolved.key,
        api
      });
      if (name) setProviderHealth(name, toHealth(result));
      return result;
    }
  );
}
return {registerProviderRoutes};
}
