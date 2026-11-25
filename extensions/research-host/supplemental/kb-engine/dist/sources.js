import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { supplementalHomeDir as homedir } from "../../runtime-home.mjs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { extractArchiveSafely } from "./archive-guard.js";
import { assertPublicHost, guardedFetch } from "./net-guard.js";
import { isTrusted, recordTrust } from "./trust.js";
const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 12e4;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
class KbUntrustedSourceError extends Error {
  spec;
  constructor(spec) {
    super(`remote source ${spec.kind ?? classifyRef(spec.ref)}:${spec.ref} not trusted \u2014 run interactively or pre-approve`);
    this.spec = spec;
    this.name = "KbUntrustedSourceError";
  }
}
function classifyRef(ref) {
  if (ref.startsWith("npm:")) return "npm";
  if (ref.startsWith("git:") || ref.startsWith("git@")) return "git";
  if (/^(https?|ssh):\/\//.test(ref)) return "https";
  return "filesystem";
}
function npmBareName(ref) {
  const rest = ref.startsWith("npm:") ? ref.slice(4) : ref;
  if (rest.startsWith("@")) {
    const at2 = rest.indexOf("@", 1);
    return at2 >= 0 ? rest.slice(0, at2) : rest;
  }
  const at = rest.indexOf("@");
  return at >= 0 ? rest.slice(0, at) : rest;
}
function sourceIdentity(spec, cwd = ".") {
  const ref = spec.ref;
  const k = spec.kind ?? classifyRef(ref);
  if (k === "npm") return `npm:${npmBareName(ref)}`;
  if (k === "git" || k === "https") {
    const lastAt = ref.lastIndexOf("@");
    if (lastAt > 0) {
      const tail = ref.slice(lastAt + 1);
      if (!tail.includes(":") && !tail.includes("/")) return ref.slice(0, lastAt);
    }
    return ref;
  }
  return isAbsolute(ref) ? ref : resolve(cwd, ref);
}
function shortHash(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
}
function cacheKey(spec) {
  return shortHash(`${spec.kind ?? classifyRef(spec.ref)}:${spec.ref}:${spec.pin ?? ""}`);
}
async function ensureTrusted(spec, ctx) {
  if (isTrusted(spec)) return;
  const prompt = ctx.promptTrust ?? (async () => false);
  const ok = await prompt(spec);
  if (!ok) throw new KbUntrustedSourceError(spec);
  recordTrust(spec);
}
function isStale(spec, markerPath) {
  if (!existsSync(markerPath)) return true;
  const ttlMs = typeof spec.refresh === "object" ? spec.refresh.ttlMs : void 0;
  if (!ttlMs) return false;
  return Date.now() - Number(statSync(markerPath).mtimeMs) > ttlMs;
}
const filesystemResolver = {
  kind: "filesystem",
  async resolve(spec, ctx) {
    const base = isAbsolute(spec.ref) ? spec.ref : resolve(ctx.cwd, spec.ref);
    const dir = spec.subdir ? join(base, spec.subdir) : base;
    return { id: spec.ref, dir, priority: spec.priority ?? 0, identity: sourceIdentity(spec, ctx.cwd) };
  }
};
const npmResolver = {
  kind: "npm",
  async resolve(spec, ctx) {
    await ensureTrusted(spec, ctx);
    const bare = npmBareName(spec.ref);
    const candidates = [
      join(homedir(), ".pi", "agent", "npm", "node_modules", bare),
      join(ctx.cwd, ".pi", "npm", "node_modules", bare),
      join(ctx.cwd, "node_modules", bare)
    ];
    const pkgDir = candidates.find((p) => existsSync(p));
    if (!pkgDir) throw new Error(`npm source ${spec.ref} not found (looked in ${candidates.join(", ")}). Install it first.`);
    const dir = spec.subdir ? join(pkgDir, spec.subdir) : pkgDir;
    return { id: spec.ref, dir, priority: spec.priority ?? 0, identity: sourceIdentity(spec, ctx.cwd) };
  }
};
function gitUrlOf(spec) {
  const ref = spec.ref.startsWith("git:") ? spec.ref.slice(4) : spec.ref;
  if (ref.startsWith("git@")) return ref;
  if (/^github\.com\//.test(ref)) return `https://${ref}`;
  if (!/^[a-z]+:\/\//.test(ref)) return `https://${ref}`;
  return ref;
}
function gitRefOf(spec) {
  if (spec.pin) return spec.pin;
  const ref = spec.ref;
  if (!ref.startsWith("git@")) {
    const lastAt = ref.lastIndexOf("@");
    if (lastAt > 0) {
      const tail = ref.slice(lastAt + 1);
      if (!tail.includes(":") && !tail.includes("/")) return tail;
    }
  }
  return void 0;
}
function assertSafeGitRef(label, v) {
  if (v !== void 0 && (v.startsWith("-") || /[\x00-\x1f]/.test(v))) throw new Error(`git ${label} ${JSON.stringify(v)} is not allowed (option-like)`);
}
function parseGitTarget(url) {
  const scp = /^git@([^:/]+):/.exec(url);
  if (scp) return { scheme: "ssh", host: scp[1], port: "" };
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`git source URL is not valid: ${url}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "ssh:") {
    throw new Error(`git source scheme ${u.protocol}// is not allowed (only https, ssh, git@host:path)`);
  }
  return { scheme: u.protocol === "https:" ? "https" : "ssh", host: u.hostname, port: u.port };
}
let warnedOldGit = false;
const gitResolver = {
  kind: "git",
  async resolve(spec, ctx) {
    await ensureTrusted(spec, ctx);
    const hooks = ctx.testHooks ?? {};
    const git = hooks.git ?? (async (args) => (await execFileAsync("git", args, { encoding: "utf8", timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER })).stdout);
    const rawRef = spec.ref.startsWith("git:") ? spec.ref.slice(4) : spec.ref;
    if (/^[a-z][a-z0-9+.-]*::/i.test(rawRef)) throw new Error(`git transport helper refs are not allowed: ${rawRef}`);
    const url = gitUrlOf(spec);
    const ref = gitRefOf(spec);
    assertSafeGitRef("pin", spec.pin);
    assertSafeGitRef("ref", ref);
    const target = parseGitTarget(url);
    const cloneDir = join(ctx.cacheDir, cacheKey(spec));
    const hasGit = existsSync(join(cloneDir, ".git"));
    const shouldPull = ctx.refresh || spec.refresh === "on-index" || !hasGit;
    const hardening = [];
    if (shouldPull) {
      const addrs = await assertPublicHost(target.host, { lookup: hooks.lookup });
      hardening.push(
        "-c",
        "protocol.allow=never",
        "-c",
        "protocol.https.allow=always",
        "-c",
        "protocol.ssh.allow=always",
        "-c",
        "http.followRedirects=false",
        "-c",
        "submodule.recurse=false",
        "-c",
        "fetch.recurseSubmodules=false"
      );
      if (target.scheme === "https" && !isIPLiteral(target.host)) {
        const m = /git version (\d+)\.(\d+)/.exec(await git(["version"]));
        if (m && (Number(m[1]) > 2 || Number(m[1]) === 2 && Number(m[2]) >= 37)) {
          const ip = addrs[0].family === 6 ? `[${addrs[0].address}]` : addrs[0].address;
          hardening.push("-c", `http.curloptResolve=${target.host}:${target.port || "443"}:${ip}`);
        } else if (!warnedOldGit) {
          warnedOldGit = true;
          console.warn("[kb] git < 2.37: http.curloptResolve unavailable \u2014 host is checked but not pinned");
        }
      }
    }
    if (hasGit && shouldPull) {
      let origins = [];
      try {
        origins = (await git(["-C", cloneDir, "config", "--get-all", "remote.origin.url"])).split("\n").map((l) => l.trim()).filter(Boolean);
      } catch {
      }
      if (origins.length !== 1) {
        throw new Error(`git cache entry ${cloneDir} has ${origins.length} configured origin URLs (expected exactly 1: ${url}); remove it and retry`);
      }
      if (origins[0] !== url) {
        throw new Error(`git cache entry ${cloneDir} was cloned from a different origin (${origins[0]}) than the checked URL (${url}); remove it and retry`);
      }
    }
    if (!hasGit) {
      mkdirSync(ctx.cacheDir, { recursive: true });
      await git([...hardening, "clone", "--depth", "1", ...ref ? ["--branch", ref] : [], "--", url, cloneDir]);
    } else if (shouldPull) {
      if (ref) {
        await git([...hardening, "-C", cloneDir, "fetch", "--no-recurse-submodules", "--depth", "1", "origin", ref]);
        await git([...hardening, "-C", cloneDir, "checkout", "--no-recurse-submodules", ref]);
      } else await git([...hardening, "-C", cloneDir, "pull", "--no-recurse-submodules", "--ff-only"]);
    }
    const rev = (await git(["-C", cloneDir, "rev-parse", "--short", "HEAD"])).trim();
    const dir = spec.subdir ? join(cloneDir, spec.subdir) : cloneDir;
    return { id: spec.ref, dir, priority: spec.priority ?? 0, identity: sourceIdentity(spec, ctx.cwd), revision: rev };
  }
};
function isIPLiteral(host) {
  return isIP(host.startsWith("[") ? host.slice(1, -1) : host) !== 0;
}
function archiveKindOf(pathname) {
  if (/\.zip$/i.test(pathname)) return "zip";
  if (/\.(tar\.gz|tgz|tar\.bz2)$/i.test(pathname)) return "tar";
  return void 0;
}
function plainFileName(pathname) {
  let name = pathname.endsWith("/") ? "" : basename(pathname);
  try {
    name = decodeURIComponent(name);
  } catch {
  }
  name = name.replace(/[\x00-\x1f\x7f\\/:]/g, "_");
  return name === "" || name === "." || name === ".." ? "index.md" : name;
}
function swapInto(dest, fresh, rename) {
  const backup = `${dest}.old-${Date.now()}-${randomUUID()}`;
  const hadDest = existsSync(dest);
  if (hadDest) rename(dest, backup);
  try {
    rename(fresh, dest);
  } catch (e) {
    if (hadDest) {
      try {
        rename(backup, dest);
      } catch {
      }
    }
    throw e;
  }
  if (hadDest) rmSync(backup, { recursive: true, force: true });
}
const BACKUP_GRACE_MS = 6e4;
const BACKUP_MAX_AGE_MS = 60 * 6e4;
const backupStamp = (name) => Number(/\.old-(\d+)-/.exec(name)?.[1] ?? 0);
function recoverBackups(dest) {
  const dir = dirname(dest);
  const prefix = `${basename(dest)}.old-`;
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.startsWith(prefix));
  } catch {
    return;
  }
  const age = (n) => Date.now() - backupStamp(n);
  names.sort((x, y) => backupStamp(y) - backupStamp(x));
  if (!existsSync(dest) && !names.some((n) => age(n) <= BACKUP_GRACE_MS)) {
    const abandoned = names[0];
    if (abandoned) {
      try {
        renameSync(join(dir, abandoned), dest);
        names.splice(names.indexOf(abandoned), 1);
      } catch {
      }
    }
  }
  for (const n of names) {
    if (age(n) > BACKUP_MAX_AGE_MS) rmSync(join(dir, n), { recursive: true, force: true });
  }
}
const httpsResolver = {
  kind: "https",
  async resolve(spec, ctx) {
    await ensureTrusted(spec, ctx);
    const hooks = ctx.testHooks ?? {};
    const dest = join(ctx.cacheDir, cacheKey(spec));
    const marker = join(dest, ".fetched");
    let url;
    try {
      url = new URL(spec.ref);
    } catch {
      throw new Error(`invalid source URL: ${spec.ref}`);
    }
    if (url.protocol !== "https:") throw new Error(`only https:// sources are allowed (got ${url.protocol}//): ${spec.ref}`);
    recoverBackups(dest);
    const shouldFetch = ctx.refresh || spec.refresh === "on-index" || isStale(spec, marker);
    if (shouldFetch) {
      mkdirSync(ctx.cacheDir, { recursive: true });
      const stage = mkdtempSync(join(ctx.cacheDir, ".stage-"));
      try {
        const out = join(stage, "out");
        mkdirSync(out);
        const body = await (hooks.fetch ?? ((u) => guardedFetch(u)))(spec.ref);
        const kind = archiveKindOf(url.pathname);
        if (kind) {
          const archive = join(stage, kind === "zip" ? "archive.zip" : "archive.tar");
          writeFileSync(archive, body);
          await extractArchiveSafely(kind, archive, out, hooks.archiveLimits);
        } else {
          writeFileSync(join(out, plainFileName(url.pathname)), body);
        }
        writeFileSync(join(out, ".fetched"), String(Date.now()));
        swapInto(dest, out, hooks.rename ?? renameSync);
      } finally {
        rmSync(stage, { recursive: true, force: true });
      }
    }
    return { id: spec.ref, dir: dest, priority: spec.priority ?? 0, identity: sourceIdentity(spec, ctx.cwd) };
  }
};
const RESOLVERS = {
  filesystem: filesystemResolver,
  npm: npmResolver,
  git: gitResolver,
  https: httpsResolver
};
function resolverFor(kind) {
  return RESOLVERS[kind];
}
async function resolveAll(specs, ctx) {
  const out = [];
  for (const spec of specs) {
    const kind = spec.kind ?? classifyRef(spec.ref);
    out.push(await resolverFor(kind).resolve(spec, ctx));
  }
  return out;
}
export {
  KbUntrustedSourceError,
  cacheKey,
  classifyRef,
  filesystemResolver,
  gitResolver,
  httpsResolver,
  npmResolver,
  recoverBackups,
  resolveAll,
  resolverFor,
  sourceIdentity
};
