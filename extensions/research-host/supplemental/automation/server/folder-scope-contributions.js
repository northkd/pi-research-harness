import path from "node:path";
const FOLDER_SCOPE_CONTRIBUTION_PREFIX = "automation.folderscope.";
function collectFolderScopeBases(entries, opts) {
  const { warn, homeDir, warnedKeys } = opts;
  const resolvedHome = typeof homeDir === "string" && homeDir.length > 0 ? path.resolve(homeDir) : void 0;
  const bases = /* @__PURE__ */ new Set();
  for (const { key, value } of entries) {
    const rejected = (reason) => {
      if (warnedKeys?.has(key)) return;
      warnedKeys?.add(key);
      warn(`[folder-scope] ignored contribution "${key}": ${reason}`);
    };
    try {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        rejected("value must be a non-null, non-array object with a { base } string");
        continue;
      }
      const proto = Object.getPrototypeOf(value);
      if (proto !== null && proto !== Object.prototype) {
        rejected("value must be a plain object (no Date/Map/class instance)");
        continue;
      }
      const base = value.base;
      if (typeof base !== "string" || base.trim().length === 0) {
        rejected("`base` must be a non-empty string");
        continue;
      }
      const trimmed = base.trim();
      if (!path.isAbsolute(trimmed)) {
        rejected("`base` must be an absolute path (relative bases would resolve against the server cwd)");
        continue;
      }
      const resolved = path.resolve(trimmed);
      if (resolvedHome !== void 0 && resolved === resolvedHome) continue;
      bases.add(resolved);
    } catch (e) {
      rejected(`rejected \u2014 read threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return [...bases];
}
export {
  FOLDER_SCOPE_CONTRIBUTION_PREFIX,
  collectFolderScopeBases
};
