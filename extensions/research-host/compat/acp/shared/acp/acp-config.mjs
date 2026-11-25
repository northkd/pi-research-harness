const DEFAULT_ACP_SETTINGS = {
  protocolV2: false,
  spawnTimeoutMs: 3e4,
  requestTimeoutMs: 3e4,
  maxLineBytes: 4 * 1024 * 1024,
  eventLogMaxBytes: 64 * 1024 * 1024
};
const RANGES = {
  spawnTimeoutMs: [5e3, 12e4],
  requestTimeoutMs: [1e3, 3e5],
  maxLineBytes: [65536, 67108864],
  eventLogMaxBytes: [1048576, 1073741824]
};
const defaultWarn = (msg) => console.warn(`[config] ${msg}`);
const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function parseEnv(raw) {
  if (raw === void 0) return {};
  if (!isRec(raw)) return void 0;
  const env = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string") return void 0;
    env[k] = v;
  }
  return env;
}
function parseAgent(raw) {
  if (!isRec(raw)) return "entry is not an object";
  if (typeof raw.id !== "string" || raw.id === "") return "missing id";
  if (typeof raw.command !== "string" || raw.command === "") return `agent "${raw.id}": missing command`;
  const args = raw.args === void 0 ? [] : raw.args;
  if (!Array.isArray(args) || !args.every((a) => typeof a === "string")) return `agent "${raw.id}": args must be a string array`;
  const env = parseEnv(raw.env);
  if (!env) return `agent "${raw.id}": env must be a string map`;
  if (raw.durable !== void 0 && typeof raw.durable !== "boolean") return `agent "${raw.id}": durable must be boolean`;
  return {
    id: raw.id,
    name: typeof raw.name === "string" && raw.name !== "" ? raw.name : raw.id,
    command: raw.command,
    args,
    env,
    durable: raw.durable === true
  };
}
function parseAcpAgents(raw, warn = defaultWarn) {
  if (raw === void 0) return [];
  if (!Array.isArray(raw)) {
    warn("acpAgents must be an array; ignoring");
    return [];
  }
  const out = [];
  for (const entry of raw) {
    const parsed = parseAgent(entry);
    if (typeof parsed === "string") {
      warn(`acpAgents: dropped entry (${parsed})`);
    } else if (out.some((a) => a.id === parsed.id)) {
      warn(`acpAgents: dropped duplicate id "${parsed.id}" (first entry wins)`);
    } else out.push(parsed);
  }
  return out;
}
function clamp(key, raw, warn) {
  const fallback = DEFAULT_ACP_SETTINGS[key];
  if (raw === void 0) return fallback;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    warn(`acp.${key} must be a number; using default ${fallback}`);
    return fallback;
  }
  const [min, max] = RANGES[key];
  const v = Math.min(max, Math.max(min, Math.trunc(raw)));
  if (v !== raw) warn(`acp.${key}=${raw} out of range [${min}, ${max}]; using ${v}`);
  return v;
}
function parseAcpSettings(raw, warn = defaultWarn) {
  if (raw !== void 0 && !isRec(raw)) {
    warn("acp must be an object; using defaults");
    return { ...DEFAULT_ACP_SETTINGS };
  }
  const r = raw ?? {};
  return {
    protocolV2: r.protocolV2 === true,
    spawnTimeoutMs: clamp("spawnTimeoutMs", r.spawnTimeoutMs, warn),
    requestTimeoutMs: clamp("requestTimeoutMs", r.requestTimeoutMs, warn),
    maxLineBytes: clamp("maxLineBytes", r.maxLineBytes, warn),
    eventLogMaxBytes: clamp("eventLogMaxBytes", r.eventLogMaxBytes, warn)
  };
}
export {
  DEFAULT_ACP_SETTINGS,
  parseAcpAgents,
  parseAcpSettings
};
