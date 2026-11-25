import fs from "node:fs";
import path from "node:path";
import { BUILTIN_ACTION_ALIASES } from "../shared/automation-types.js";
const MAX_PER_SOURCE = 12;
class ActionRegistry {
  byId = /* @__PURE__ */ new Map();
  countBySource = /* @__PURE__ */ new Map();
  warn;
  constructor(opts) {
    this.warn = opts?.warn ?? ((m) => console.warn(m));
  }
  /**
   * Register an action. Rejected (with a logged warning, no throw) when the
   * source is already at the per-source cap, when the id is malformed, or on
   * a duplicate id.
   */
  register(reg) {
    if (!/^[a-z0-9-]+\.[a-z0-9-]+$/i.test(reg.id)) {
      this.warn(`[action-registry] rejected malformed action id "${reg.id}" (expected <source>.<verb>)`);
      return false;
    }
    if (!reg.buildPrompt === !reg.buildEvent) {
      this.warn(`[action-registry] rejected "${reg.id}": exactly one of buildPrompt/buildEvent required`);
      return false;
    }
    if (reg.buildEvent && !(Array.isArray(reg.emits) && reg.emits.length > 0)) {
      this.warn(`[action-registry] rejected "${reg.id}": buildEvent actions must declare a non-empty \`emits\` list`);
      return false;
    }
    if (this.byId.has(reg.id)) {
      this.warn(`[action-registry] rejected duplicate action id "${reg.id}"`);
      return false;
    }
    const count = this.countBySource.get(reg.source) ?? 0;
    if (count >= MAX_PER_SOURCE) {
      this.warn(`[action-registry] source "${reg.source}" at cap (${MAX_PER_SOURCE}); rejected "${reg.id}"`);
      return false;
    }
    this.byId.set(reg.id, reg);
    this.countBySource.set(reg.source, count + 1);
    return true;
  }
  get(id) {
    return this.byId.get(id);
  }
  has(id) {
    return this.byId.has(id);
  }
  /** All registered action ids (for schema validation). */
  ids() {
    return new Set(this.byId.keys());
  }
  /**
   * Serializable descriptors for the dialog, resolved for one cwd: each
   * action's `available(cwd)` is evaluated and `enum` option lists are
   * populated. Sorted by source then id for stable grouping.
   */
  descriptorsForCwd(cwd) {
    const out = [];
    for (const reg of this.byId.values()) {
      const available = reg.available ? safeBool(reg.available, cwd) : true;
      const payloadSchema = (reg.payloadSchema ?? []).map((f) => ({
        key: f.key,
        label: f.label,
        type: f.type,
        ...f.help ? { help: f.help } : {},
        ...f.type === "enum" ? { options: f.options ? safeOptions(f.options, cwd) : [] } : {}
      }));
      out.push({
        id: reg.id,
        source: reg.source,
        label: reg.label,
        ...reg.description ? { description: reg.description } : {},
        available,
        ...!available && reg.unavailableReason ? { unavailableReason: reg.unavailableReason } : {},
        payloadSchema
      });
    }
    out.sort((a, b) => a.source === b.source ? a.id.localeCompare(b.id) : a.source.localeCompare(b.source));
    return out;
  }
}
function safeBool(fn, cwd) {
  try {
    return fn(cwd);
  } catch {
    return false;
  }
}
function safeOptions(fn, cwd) {
  try {
    return fn(cwd);
  } catch {
    return [];
  }
}
function coreActionContributions() {
  return [
    {
      id: "core.prompt",
      source: "core",
      label: "Prompt",
      description: "Seed a fresh session with a prompt file.",
      buildPrompt: ({ automation }) => {
        const action = automation.config?.action;
        const p = action?.prompt;
        if (!p) return "";
        const promptPath = path.isAbsolute(p) ? p : path.join(automation.dir, p);
        try {
          return fs.readFileSync(promptPath, "utf-8").trim();
        } catch {
          return "";
        }
      }
    },
    {
      id: "core.skill",
      source: "core",
      label: "Skill",
      description: "Invoke a $skill in a fresh session.",
      buildPrompt: ({ automation }) => {
        const skill = automation.config?.action?.skill;
        if (!skill) return "";
        return skill.startsWith("$") ? skill : `$${skill}`;
      }
    }
  ];
}
function createActionRegistryWithBuiltins(opts) {
  const reg = new ActionRegistry(opts);
  for (const c of coreActionContributions()) reg.register(c);
  return reg;
}
const ACTION_CONTRIBUTION_PREFIX = "automation.action.";
function collectActionRegistry(entries, opts) {
  const reg = new ActionRegistry(opts);
  for (const { value } of entries) {
    const contribs = Array.isArray(value) ? value : [value];
    for (const c of contribs) {
      if (c && typeof c === "object") reg.register(c);
    }
  }
  return reg;
}
function normalizeActionKind(kind) {
  return BUILTIN_ACTION_ALIASES[kind] ?? kind;
}
export {
  ACTION_CONTRIBUTION_PREFIX,
  ActionRegistry,
  MAX_PER_SOURCE,
  collectActionRegistry,
  coreActionContributions,
  createActionRegistryWithBuiltins,
  normalizeActionKind
};
