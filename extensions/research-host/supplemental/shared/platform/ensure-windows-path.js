import { existsSync } from "node:fs";
import path from "node:path";
function ensureWindowsSystemPath(env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  const exists = opts.exists ?? existsSync;
  const systemRoot = env.SYSTEMROOT || env.SystemRoot || env.systemroot || "C:\\Windows";
  const localAppData = env.LOCALAPPDATA || env.LocalAppData || env.localappdata || "";
  const join = path.win32.join;
  const candidates = [
    join(systemRoot, "System32"),
    systemRoot,
    join(systemRoot, "System32", "Wbem"),
    join(systemRoot, "System32", "WindowsPowerShell", "v1.0"),
    join(systemRoot, "System32", "OpenSSH")
  ];
  if (localAppData) {
    candidates.push(join(localAppData, "Microsoft", "WindowsApps"));
  }
  const currentPath = env.PATH ?? "";
  const currentLower = currentPath.toLowerCase();
  const addedLower = /* @__PURE__ */ new Set();
  const toAdd = [];
  for (const dir of candidates) {
    if (!exists(dir)) continue;
    const dirLower = dir.toLowerCase();
    if (currentLower.includes(dirLower)) continue;
    if (addedLower.has(dirLower)) continue;
    addedLower.add(dirLower);
    toAdd.push(dir);
  }
  if (toAdd.length === 0) return env;
  const DELIM = ";";
  const newPath = currentPath ? `${toAdd.join(DELIM)}${DELIM}${currentPath}` : toAdd.join(DELIM);
  return { ...env, PATH: newPath };
}
export {
  ensureWindowsSystemPath
};
