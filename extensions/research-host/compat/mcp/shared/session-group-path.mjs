import { normalizePath } from "./platform/paths.mjs";
function inferPlatform(samples, override) {
  if (override) return override;
  for (const s of samples) {
    if (!s) continue;
    if (/^[A-Za-z]:[\\/]/.test(s) || s.includes("\\")) return "win32";
    if (s.startsWith("/")) return "linux";
  }
  return "linux";
}
function pathKey(p, platform) {
  const normalized = normalizePath(p, platform);
  if (platform === "linux") return normalized;
  return normalized.toLowerCase();
}
function resolveSessionGroupPath(session, pinnedKeys, platform) {
  const cwdKey = pathKey(session.cwd, platform);
  if (pinnedKeys.has(cwdKey)) return session.cwd;
  const wtMain = session.gitWorktree?.mainPath;
  if (wtMain && wtMain.length > 0) return wtMain;
  return session.cwd;
}
export {
  inferPlatform,
  pathKey,
  resolveSessionGroupPath
};
