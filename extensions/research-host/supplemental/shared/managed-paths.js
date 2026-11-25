import { supplementalHomeDir } from "../runtime-home.mjs";
import path from "node:path";
function getManagedDir(env) {
  return path.join(env?.homedir ?? supplementalHomeDir(), ".pi-dashboard");
}
function getManagedBin(env) {
  return path.join(getManagedDir(env), "node_modules", ".bin");
}
function getPiSettingsPath(env) {
  return path.join(env?.homedir ?? supplementalHomeDir(), ".pi", "agent", "settings.json");
}
const MANAGED_DIR = getManagedDir();
const MANAGED_BIN = getManagedBin();
const PI_SETTINGS_PATH = getPiSettingsPath();
export {
  MANAGED_BIN,
  MANAGED_DIR,
  PI_SETTINGS_PATH,
  getManagedBin,
  getManagedDir,
  getPiSettingsPath
};
