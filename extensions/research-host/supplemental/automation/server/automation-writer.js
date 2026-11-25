import fs from "node:fs";
import path from "node:path";
import { stringify as stringifyYaml } from "../../vendor/yaml/browser/dist/index.js";
const NAME_RE = /^[A-Za-z0-9._-]+$/;
function isValidAutomationName(name) {
  return NAME_RE.test(name) && name !== "runs" && name !== "." && name !== "..";
}
function writeAutomation(input) {
  if (!isValidAutomationName(input.name)) {
    throw new Error(`invalid automation name: "${input.name}"`);
  }
  const dir = path.join(input.scopeBase, ".pi", "automation", input.name);
  const intent = input.intent ?? "create";
  const existed = fs.existsSync(path.join(dir, "automation.yaml"));
  if (intent === "create" && existed) {
    throw new Error(`automation "${input.name}" already exists in this scope`);
  }
  if (intent === "update" && !existed) {
    throw new Error(`automation "${input.name}" does not exist in this scope`);
  }
  fs.mkdirSync(dir, { recursive: true });
  const config = { ...input.config };
  let promptPath;
  if (config.action?.kind === "prompt") {
    const count = config.action.count;
    config.action = { kind: "prompt", prompt: "./prompt.md", ...count !== void 0 ? { count } : {} };
    promptPath = path.join(dir, "prompt.md");
    fs.writeFileSync(promptPath, (input.promptBody ?? "").trim() + "\n");
  }
  const yamlPath = path.join(dir, "automation.yaml");
  const tmp = yamlPath + ".tmp";
  fs.writeFileSync(tmp, stringifyYaml(config));
  fs.renameSync(tmp, yamlPath);
  return { dir, yamlPath, ...promptPath ? { promptPath } : {} };
}
function deleteAutomation(scopeBase, name) {
  if (!isValidAutomationName(name)) return false;
  const dir = path.join(scopeBase, ".pi", "automation", name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}
export {
  deleteAutomation,
  isValidAutomationName,
  writeAutomation
};
