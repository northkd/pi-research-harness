import fs from "node:fs";
import path from "node:path";
import { parseAutomationYaml } from "./automation-schema.js";
function automationRootFor(scopeBase) {
  return path.join(scopeBase, ".pi", "automation");
}
function scanScope(scopeBase, scope, knownKinds, knownActionIds = /* @__PURE__ */ new Set(), knownSourceIds = /* @__PURE__ */ new Set()) {
  const root = automationRootFor(scopeBase);
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    if (ent.name === "runs") continue;
    const dir = path.join(root, ent.name);
    const yamlPath = path.join(dir, "automation.yaml");
    let rawText;
    try {
      rawText = fs.readFileSync(yamlPath, "utf-8");
    } catch {
      continue;
    }
    const { config, error } = parseAutomationYaml(rawText, knownKinds, knownActionIds, knownSourceIds);
    if (config) {
      out.push({ name: ent.name, scope, dir, config, valid: true });
    } else {
      out.push({ name: ent.name, scope, dir, valid: false, error: error ?? "invalid" });
    }
  }
  return out;
}
function scanAutomations(opts, knownKinds, knownActionIds = /* @__PURE__ */ new Set(), knownSourceIds = /* @__PURE__ */ new Set()) {
  const out = [];
  if (opts.scanFolder !== false && opts.repoRoot) {
    out.push(...scanScope(opts.repoRoot, "folder", knownKinds, knownActionIds, knownSourceIds));
  }
  if (opts.scanGlobal !== false && opts.homeDir) {
    out.push(...scanScope(opts.homeDir, "global", knownKinds, knownActionIds, knownSourceIds));
  }
  return out;
}
export {
  automationRootFor,
  scanAutomations,
  scanScope
};
