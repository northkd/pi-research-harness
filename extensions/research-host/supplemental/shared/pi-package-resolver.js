import { supplementalHomeDir } from "../runtime-home.mjs";
import * as fs from "node:fs";
import * as path from "node:path";
import { rootGlobalOr } from "./platform/npm.js";
let cachedNpmRoot;
function defaultNpmRoot() {
  if (cachedNpmRoot === void 0) cachedNpmRoot = rootGlobalOr("");
  return cachedNpmRoot;
}
function resetNpmRootCacheForTests() {
  cachedNpmRoot = void 0;
}
function resolvePiPackage(spec, opts = {}) {
  const agentDir = opts.agentDir ?? path.join(supplementalHomeDir(), ".pi", "agent");
  const scope = opts.scope ?? "any";
  const cwd = opts.cwd;
  const npmRoot = opts.npmRoot ?? defaultNpmRoot();
  if ((scope === "project" || scope === "any") && cwd) {
    const hit = findInScope(spec, "project", { agentDir, cwd, npmRoot });
    if (hit) return hit;
  }
  if (scope === "user" || scope === "any") {
    const hit = findInScope(spec, "user", { agentDir, cwd, npmRoot });
    if (hit) return hit;
  }
  return null;
}
function resolvePiPackageEntry(spec, opts = {}) {
  return resolvePiPackage(spec, opts)?.entryPath ?? null;
}
function listPiPackages(opts = {}) {
  const agentDir = opts.agentDir ?? path.join(supplementalHomeDir(), ".pi", "agent");
  const scope = opts.scope ?? "any";
  const cwd = opts.cwd;
  const npmRoot = opts.npmRoot ?? defaultNpmRoot();
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  const collect = (s) => {
    for (const r of iterateInScope(s, { agentDir, cwd, npmRoot })) {
      if (seen.has(r.packageDir)) continue;
      seen.add(r.packageDir);
      out.push(r);
    }
  };
  if ((scope === "project" || scope === "any") && cwd) collect("project");
  if (scope === "user" || scope === "any") collect("user");
  return out;
}
function findInScope(spec, scope, ctx) {
  for (const r of iterateInScope(scope, ctx)) {
    if (r.packageJsonName === spec) return r;
  }
  return null;
}
function* iterateInScope(scope, ctx) {
  const settingsPath = scope === "user" ? path.join(ctx.agentDir, "settings.json") : ctx.cwd ? path.join(ctx.cwd, ".pi", "settings.json") : null;
  if (!settingsPath) return;
  const packages = readSettingsPackages(settingsPath);
  if (packages.length === 0) return;
  const settingsDir = path.dirname(settingsPath);
  for (const entry of packages) {
    const parsed = parseSource(entry);
    if (!parsed) continue;
    const packageDir = computeInstallPath(parsed, scope, ctx, settingsDir);
    if (!packageDir || !fs.existsSync(packageDir)) continue;
    const pkgJson = readPackageJson(packageDir);
    const name = pkgJson?.name ?? null;
    const entryPath = resolveEntryPath(packageDir, pkgJson ?? {});
    yield {
      packageDir,
      entryPath,
      scope,
      source: parsed.original,
      packageJsonName: name
    };
  }
}
function parseSource(entry) {
  const original = typeof entry === "string" ? entry : typeof entry === "object" && entry !== null && typeof entry.source === "string" ? entry.source : "";
  if (!original) return null;
  if (original.startsWith("npm:")) {
    const pkgName = original.slice(4).replace(/@[^/]*$/, "");
    return { kind: "npm", value: pkgName, original };
  }
  if (original.startsWith("git:") || original.startsWith("git@") || original.startsWith("https://") || original.startsWith("http://") || original.startsWith("ssh://") || original.startsWith("github:")) {
    let url = original.replace(/^git:/, "");
    url = url.replace(/^github:/, "github.com/");
    url = url.replace(/^git@([^:]+):/, "$1/");
    url = url.replace(/^(https?|ssh|git):\/\//, "");
    url = url.replace(/^[^@]+@/, "");
    url = url.replace(/\.git$/, "").replace(/@[^/]*$/, "");
    return { kind: "git", value: url, original };
  }
  if (path.isAbsolute(original)) {
    return { kind: "local-abs", value: original, original };
  }
  return { kind: "local-rel", value: original, original };
}
function computeInstallPath(parsed, scope, ctx, settingsDir) {
  switch (parsed.kind) {
    case "npm": {
      if (scope === "project") {
        if (!ctx.cwd) return null;
        return path.join(ctx.cwd, ".pi", "npm", "node_modules", parsed.value);
      }
      const managed = path.join(ctx.agentDir, "npm", "node_modules", parsed.value);
      if (fs.existsSync(managed)) return managed;
      if (!ctx.npmRoot) return managed;
      const legacy = path.join(ctx.npmRoot, parsed.value);
      return fs.existsSync(legacy) ? legacy : managed;
    }
    case "git": {
      if (scope === "project") {
        if (!ctx.cwd) return null;
        return path.join(ctx.cwd, ".pi", "git", parsed.value);
      }
      return path.join(ctx.agentDir, "git", parsed.value);
    }
    case "local-abs":
      return parsed.value;
    case "local-rel":
      return path.resolve(settingsDir, parsed.value);
  }
}
function readSettingsPackages(settingsPath) {
  try {
    if (!fs.existsSync(settingsPath)) return [];
    const raw = fs.readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw);
    const pkgs = parsed && typeof parsed === "object" ? parsed.packages : void 0;
    return Array.isArray(pkgs) ? pkgs : [];
  } catch (err) {
    console.warn(
      `[pi-package-resolver] failed to read ${settingsPath}: ${err.message}`
    );
    return [];
  }
}
function readPackageJson(packageDir) {
  const pkgJsonPath = path.join(packageDir, "package.json");
  try {
    if (!fs.existsSync(pkgJsonPath)) return null;
    const raw = fs.readFileSync(pkgJsonPath, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[pi-package-resolver] failed to parse ${pkgJsonPath}: ${err.message}`
    );
    return null;
  }
}
function resolveEntryPath(packageDir, pkg) {
  const exportsDot = extractExportsDot(pkg.exports);
  if (typeof exportsDot === "string") {
    const candidate = path.resolve(packageDir, exportsDot);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (typeof pkg.main === "string" && pkg.main.length > 0) {
    const candidate = path.resolve(packageDir, pkg.main);
    if (fs.existsSync(candidate)) return candidate;
  }
  if (pkg.pi && Array.isArray(pkg.pi.extensions) && pkg.pi.extensions.length > 0) {
    const first = pkg.pi.extensions[0];
    if (typeof first === "string") {
      const candidate = path.resolve(packageDir, first);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const idxJs = path.join(packageDir, "index.js");
  if (fs.existsSync(idxJs)) return idxJs;
  const idxTs = path.join(packageDir, "index.ts");
  if (fs.existsSync(idxTs)) return idxTs;
  return null;
}
function extractExportsDot(exportsField) {
  if (typeof exportsField === "string") {
    return exportsField;
  }
  if (!exportsField || typeof exportsField !== "object") return null;
  const root = exportsField;
  const dot = root["."];
  if (typeof dot === "string") return dot;
  if (dot && typeof dot === "object") {
    const cond = dot;
    for (const key of ["import", "default", "node"]) {
      const v = cond[key];
      if (typeof v === "string") return v;
    }
  }
  return null;
}
export {
  listPiPackages,
  resetNpmRootCacheForTests,
  resolvePiPackage,
  resolvePiPackageEntry
};
