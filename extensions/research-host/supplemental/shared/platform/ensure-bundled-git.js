import { existsSync } from "node:fs";
import path from "node:path";
const GIT_LIBDIRS = ["mingw64", "clangarm64"];
const GIT_LAUNCHER_REL = path.win32.join("cmd", "git.exe");
function resolveBundledGitDir(opts = {}) {
  const exists = opts.exists ?? existsSync;
  const join = path.win32.join;
  const roots = [];
  if (opts.resourcesPath) roots.push(join(opts.resourcesPath, "git"));
  for (const c of opts.candidates ?? []) roots.push(c);
  for (const root of roots) {
    if (exists(join(root, GIT_LAUNCHER_REL))) return root;
  }
  return null;
}
function resolveLibDir(gitDir, exists) {
  for (const name of GIT_LIBDIRS) {
    if (exists(path.win32.join(gitDir, name))) return name;
  }
  return null;
}
function ensureBundledGitOnPath(env, opts = {}) {
  const platform = opts.platform ?? process.platform;
  if (platform !== "win32") return env;
  if (opts.source && opts.source !== "bundled") return env;
  const exists = opts.exists ?? existsSync;
  const gitDir = opts.gitDir !== void 0 ? opts.gitDir : resolveBundledGitDir({
    platform,
    resourcesPath: opts.resourcesPath,
    candidates: opts.candidates,
    exists
  });
  if (!gitDir) return env;
  const join = path.win32.join;
  const libDir = resolveLibDir(gitDir, exists);
  const dirs = [join(gitDir, "cmd"), join(gitDir, "usr", "bin")];
  if (libDir) dirs.push(join(gitDir, libDir, "bin"));
  const currentPath = env.PATH ?? "";
  const present = new Set(
    currentPath.split(";").map((e) => e.trim().replace(/[\\/]+$/, "").toLowerCase()).filter(Boolean)
  );
  const seen = /* @__PURE__ */ new Set();
  const toAdd = [];
  for (const dir of dirs) {
    if (!exists(dir)) continue;
    const lower = dir.replace(/[\\/]+$/, "").toLowerCase();
    if (present.has(lower) || seen.has(lower)) continue;
    seen.add(lower);
    toAdd.push(dir);
  }
  const DELIM = ";";
  let out = env;
  if (toAdd.length > 0) {
    const newPath = currentPath ? `${toAdd.join(DELIM)}${DELIM}${currentPath}` : toAdd.join(DELIM);
    out = { ...out, PATH: newPath };
  }
  if (libDir) {
    const execPath = join(gitDir, libDir, "libexec", "git-core");
    if (exists(execPath) && out.GIT_EXEC_PATH !== execPath) {
      out = { ...out, GIT_EXEC_PATH: execPath };
    }
  }
  if (libDir) {
    const caBundle = join(gitDir, libDir, "ssl", "certs", "ca-bundle.crt");
    if (exists(caBundle) && out.SSL_CERT_FILE !== caBundle) {
      out = { ...out, SSL_CERT_FILE: caBundle };
    }
  }
  return out;
}
export {
  ensureBundledGitOnPath,
  resolveBundledGitDir
};
