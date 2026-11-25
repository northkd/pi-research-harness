import { supplementalHomeDir } from "../runtime-home.mjs";
import fs from "node:fs";
import path from "node:path";
import { parseRoleConfig } from "./role-schema.js";
function providersJsonPath(homeDir = supplementalHomeDir()) {
  return path.join(homeDir, ".pi", "agent", "providers.json");
}
function readRoleConfigFromDisk(homeDir) {
  try {
    return parseRoleConfig(JSON.parse(fs.readFileSync(providersJsonPath(homeDir), "utf-8")));
  } catch {
    return parseRoleConfig(void 0);
  }
}
export {
  providersJsonPath,
  readRoleConfigFromDisk
};
