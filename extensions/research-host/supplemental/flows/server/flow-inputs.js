import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "../../vendor/yaml/browser/dist/index.js";
const VALID_TYPES = ["string", "number", "boolean", "object", "array"];
function flowYamlPath(cwd, flowId) {
  const m = /^([\w.-]+):([\w.-]+)$/.exec(flowId);
  if (!m) return null;
  return path.join(cwd, ".pi", "flows", "flows", m[1], m[2], "flow.yaml");
}
function readFlowInputs(cwd, flowId) {
  const p = flowYamlPath(cwd, flowId);
  if (!p) return [];
  let doc;
  try {
    doc = parseYaml(fs.readFileSync(p, "utf-8"));
  } catch {
    return [];
  }
  const raw = doc?.inputs;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out = [];
  for (const [name, decl] of Object.entries(raw)) {
    const d = decl;
    const type = d?.type;
    if (typeof type !== "string" || !VALID_TYPES.includes(type)) continue;
    out.push({ name, type, required: d?.required === true });
  }
  return out;
}
export {
  flowYamlPath,
  readFlowInputs
};
