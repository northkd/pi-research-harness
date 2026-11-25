const DEFAULT_ROLE_NAMES = [
  "planning",
  "coding",
  "compact",
  "fast",
  "vision",
  "research",
  // Auto session naming resolves `@naming` first and falls back to `@fast`, so
  // making naming work does not force a global downgrade of the shared `fast`
  // slot. See change: fix-auto-naming-reasoning-model (design D1).
  "naming"
];
function effectiveRoleNames(cfg) {
  const removed = new Set(cfg.removedRoles ?? []);
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const n of [...DEFAULT_ROLE_NAMES, ...cfg.roleNames ?? [], ...Object.keys(cfg.roles)]) {
    if (removed.has(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}
function overlayRoles(cfg) {
  const out = {};
  for (const name of effectiveRoleNames(cfg)) out[name] = cfg.roles[name] ?? "";
  return out;
}
function splitRef(ref) {
  const out = {};
  let model = ref;
  const lastColon = ref.lastIndexOf(":");
  if (lastColon !== -1) {
    const level = ref.slice(lastColon + 1);
    if (level !== "") out.thinkingLevel = level;
    model = ref.slice(0, lastColon);
  }
  if (model !== "") out.model = model;
  const slash = ref.indexOf("/");
  if (slash > 0) out.provider = ref.slice(0, slash);
  return out;
}
function joinRef(model, level) {
  return level ? `${model}:${level}` : model;
}
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ROLE_REF_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function splitCanonicalLevel(value) {
  const idx = value.lastIndexOf(":");
  if (idx <= 0) return { base: value };
  const tail = value.slice(idx + 1);
  if (!THINKING_LEVELS.includes(tail)) return { base: value };
  return { base: value.slice(0, idx), level: tail };
}
function parseModelRef(value) {
  const v = typeof value === "string" ? value.trim() : "";
  if (v === "") return { kind: "invalid", reason: "empty model ref" };
  if (v.startsWith("@")) {
    const { base: base2, level: level2 } = splitCanonicalLevel(v.slice(1));
    if (!ROLE_REF_NAME_RE.test(base2)) return { kind: "invalid", reason: `invalid role ref "${v}"` };
    return level2 ? { kind: "role", role: base2, level: level2 } : { kind: "role", role: base2 };
  }
  const { base, level } = splitCanonicalLevel(v);
  return level ? { kind: "direct", model: base, level } : { kind: "direct", model: base };
}
function concrete(model, level) {
  const slash = model.indexOf("/");
  const out = { model };
  if (slash > 0) {
    out.provider = model.slice(0, slash);
    out.id = model.slice(slash + 1);
  }
  if (level) out.level = level;
  return out;
}
function resolveModelRef(ref, cfg) {
  const parsed = parseModelRef(ref);
  if (parsed.kind === "invalid") return { kind: "direct", unresolved: parsed.reason };
  if (parsed.kind === "direct") return { kind: "direct", ...concrete(parsed.model, parsed.level) };
  const assigned = cfg.roles[parsed.role];
  if (typeof assigned !== "string" || assigned.trim() === "") {
    return { kind: "role", role: parsed.role, unresolved: `role '${parsed.role}' not configured yet` };
  }
  const { base, level } = splitCanonicalLevel(assigned.trim());
  return { kind: "role", role: parsed.role, ...concrete(base, parsed.level ?? level) };
}
function parseRoleConfig(raw) {
  const obj = raw && typeof raw === "object" ? raw : {};
  return {
    roles: parseRoles(obj.roles),
    rolePresets: parsePresets(obj.rolePresets),
    activePreset: typeof obj.activePreset === "string" ? obj.activePreset : null,
    roleNames: parseStringArray(obj.roleNames),
    removedRoles: parseStringArray(obj.removedRoles)
  };
}
function parseRoles(raw) {
  const roles = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === "string" && v.trim() !== "") roles[k] = v.trim();
    }
  }
  return roles;
}
function isValidPreset(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
  const e = entry;
  return typeof e.name === "string" && !!e.roles && typeof e.roles === "object" && !Array.isArray(e.roles);
}
function parsePresets(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const entry of raw) {
    if (!isValidPreset(entry) || seen.has(entry.name)) continue;
    seen.add(entry.name);
    out.push({ name: entry.name, roles: entry.roles });
  }
  return out;
}
function parseStringArray(raw) {
  return Array.isArray(raw) ? raw.filter((n) => typeof n === "string") : void 0;
}
export {
  DEFAULT_ROLE_NAMES,
  THINKING_LEVELS,
  effectiveRoleNames,
  joinRef,
  overlayRoles,
  parseModelRef,
  parseRoleConfig,
  resolveModelRef,
  splitRef
};
