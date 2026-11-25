import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {mapAdvertisedModels} from '../shared/provider-model-metadata.mjs';
export function createProbeModule(host) {
const fetch = host.fetch;
const configPath = () => host.configPath;
const REDACTED = "***";
const DEFAULT_TIMEOUT_MS = 8e3;
const MAX_ERROR_BODY_CHARS = 500;
const SAMPLE_LIMIT = 5;
function stripTrailingSlash(url) {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
function buildProbeRequest(input) {
  const base = stripTrailingSlash(input.baseUrl);
  switch (input.api) {
    case "openai-completions":
    case "openai-responses":
      return {
        url: `${base}/models`,
        headers: {
          Authorization: `Bearer ${input.apiKey}`,
          "Content-Type": "application/json"
        }
      };
    case "anthropic-messages":
      return {
        url: `${base}/v1/models`,
        headers: {
          "x-api-key": input.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      };
    case "google-generative-ai":
      return {
        url: `${base}/models?key=${encodeURIComponent(input.apiKey)}`,
        headers: {
          "Content-Type": "application/json"
        }
      };
    default:
      throw new Error(`Unsupported api type: ${String(input.api)}`);
  }
}
function readProvidersFromDisk() {
  const path = configPath();
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return raw.providers ?? {};
  } catch {
    return {};
  }
}
function resolveProbeApiKey(args) {
  let raw = args.apiKey;
  if (!raw) {
    return { ok: false, error: "apiKey is required" };
  }
  if (raw === REDACTED) {
    if (!args.name) {
      return { ok: false, error: "No provider name given for saved API key lookup" };
    }
    const providers = args.readProviders();
    const entry = providers[args.name];
    if (!entry) {
      return { ok: false, error: `No saved API key for provider "${args.name}"` };
    }
    raw = entry.apiKey;
    if (!raw) {
      return { ok: false, error: `Stored API key for "${args.name}" is empty` };
    }
  }
  if (raw.startsWith("$")) {
    const envName = raw.slice(1);
    const value = host.env[envName];
    if (!value) {
      return { ok: false, error: `Environment variable ${envName} is not set` };
    }
    return { ok: true, key: value };
  }
  return { ok: true, key: raw };
}
function redactErrorText(text, apiKey) {
  let out = text;
  if (apiKey && out.includes(apiKey)) {
    out = out.split(apiKey).join("[REDACTED]");
  }
  out = out.replace(CREDENTIAL_PATTERNS, (...args) => {
    const prefix = args.slice(1, 4).find((g) => g !== void 0) ?? "";
    return `${prefix}[REDACTED]`;
  });
  return out.length > MAX_ERROR_BODY_CHARS ? out.slice(0, MAX_ERROR_BODY_CHARS) : out;
}
const CREDENTIAL_PATTERNS = new RegExp(
  [
    // `Bearer <token>` / `Basic <blob>` in an echoed Authorization header.
    String.raw`(\b(?:Bearer|Basic)\s+)[\w\-._~+/]{8,}={0,2}`,
    // `"api_key": "..."`, `apiKey=...`, `access_token: ...` and friends.
    String.raw`((?:api[-_]?key|access[-_]?token|refresh[-_]?token|client[-_]?secret)["']?\s*[:=]\s*["']?)[\w\-._~+/]{8,}={0,2}`,
    // Vendor-prefixed keys that are self-identifying regardless of context.
    String.raw`(\b(?:sk|pk|rk|sk-proj|xoxb|ghp|gho|ghs|glpat)-)[\w\-]{12,}`
  ].join("|"),
  "gi"
);
function extractModelIds(body) {
  if (body && Array.isArray(body.data)) {
    return body.data.filter((m) => m && typeof m.id === "string").map((m) => m.id);
  }
  if (body && Array.isArray(body.models)) {
    return body.models.filter((m) => m && typeof m.name === "string").map((m) => m.name.replace(/^models\//, ""));
  }
  return [];
}
async function fetchProviderModelBody(input) {
  let req;
  try {
    req = buildProbeRequest(input);
  } catch {
    return null;
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(req.url, { method: "GET", headers: req.headers, signal: controller.signal });
    if (!response.ok) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
async function listProviderModelIds(input) {
  const body = await fetchProviderModelBody(input);
  return body === null ? [] : extractModelIds(body);
}
async function listProviderModels(input) {
  const body = await fetchProviderModelBody(input);
  return body === null ? [] : mapAdvertisedModels(body);
}
async function probeProvider(input) {
  let req;
  try {
    req = buildProbeRequest(input);
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  }
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(req.url, {
      method: "GET",
      headers: req.headers,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) {
      let bodyText = "";
      try {
        bodyText = await response.text();
      } catch {
        bodyText = "";
      }
      const excerpt = redactErrorText(
        bodyText || response.statusText || `HTTP ${response.status}`,
        input.apiKey
      );
      return { ok: false, status: response.status, error: excerpt };
    }
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    const ids = extractModelIds(body);
    return {
      ok: true,
      status: response.status,
      modelCount: ids.length,
      sample: ids.slice(0, SAMPLE_LIMIT)
    };
  } catch (err) {
    clearTimeout(timer);
    const message = err?.message ?? String(err);
    return { ok: false, error: redactErrorText(message, input.apiKey) };
  }
}
return {readProvidersFromDisk,buildProbeRequest,resolveProbeApiKey,probeProvider,listProviderModels,listProviderModelIds};
}
