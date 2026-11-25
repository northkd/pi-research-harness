import { createHash } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
const PUBLIC_HOSTS = {
  "github.com": "github",
  "gitlab.com": "gitlab",
  "codeberg.org": "gitea",
  "gitea.com": "gitea"
};
const SEGMENT = /^[A-Za-z0-9._-]+$/;
function parseRemoteUrl(url) {
  const u = url.trim();
  const scp = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(u);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(u)) return { scheme: "ssh", host: scp[1].toLowerCase(), hostname: scp[1].toLowerCase(), path: scp[2] };
  try {
    const parsed = new URL(u);
    const proto = parsed.protocol.replace(":", "");
    if (!["http", "https", "ssh", "git"].includes(proto)) return null;
    const hostname = parsed.hostname.toLowerCase();
    const host = proto === "http" || proto === "https" ? parsed.host.toLowerCase() : hostname;
    return { scheme: proto === "http" || proto === "https" ? proto : "ssh", host, hostname, path: parsed.pathname.replace(/^\/+/, "") };
  } catch {
    return null;
  }
}
function resolveForge(remoteUrl, cfg) {
  if (!remoteUrl) return { kind: "unsupported", reason: "no remote" };
  const p = parseRemoteUrl(remoteUrl);
  if (!p) return { kind: "unsupported", reason: "unparseable remote" };
  const hosts = cfg.forge.hosts;
  const forge = hosts[p.host] ?? hosts[p.hostname] ?? PUBLIC_HOSTS[p.hostname];
  if (!forge) return { kind: "unsupported", reason: `host ${p.hostname} has no forge adapter` };
  const segments = p.path.replace(/\.git\/?$/, "").replace(/\/+$/, "").split("/");
  const lastOk = segments.every((s) => SEGMENT.test(s) && s !== "." && s !== "..");
  const lenOk = forge === "gitlab" ? segments.length >= 2 : segments.length === 2;
  if (!lastOk || !lenOk) return { kind: "unsupported", reason: "invalid repository path" };
  return { kind: "ok", forge, host: p.host, hostname: p.hostname, segments, identity: `${p.host}/${segments.join("/")}`.toLowerCase() };
}
function ensureRepoDir(repo, baseDir) {
  for (const d of [baseDir, repo.dir]) {
    mkdirSync(d, { recursive: true, mode: 448 });
    try {
      chmodSync(d, 448);
    } catch {
    }
  }
  if (!existsSync(repo.dbPath)) closeSync(openSync(repo.dbPath, "a", 384));
  try {
    chmodSync(repo.dbPath, 384);
  } catch {
  }
}
function resolveRepo(cwd, cfg, deps) {
  if (!cfg.enabled) return { ok: false, kind: "disabled", reason: "git scope disabled (git.enabled is false)" };
  if (!existsSync(cwd)) return { ok: false, kind: "unavailable", reason: "directory removed" };
  let out;
  try {
    out = deps.git(["rev-parse", "--git-common-dir", "--show-toplevel"], cwd);
  } catch (e) {
    const ge = e;
    if (ge.code === "ENOENT") return { ok: false, kind: "unavailable", reason: "git is not installed" };
    return { ok: false, kind: "unavailable", reason: "not a git repository" };
  }
  const [commonRaw, topRaw] = out.split("\n").map((l) => l.trim());
  if (!commonRaw || !topRaw) return { ok: false, kind: "unavailable", reason: "not a git repository" };
  const commonDir = realpathSync(resolve(cwd, commonRaw));
  const toplevel = realpathSync(resolve(cwd, topRaw));
  const repoKey = createHash("sha256").update(commonDir).digest("hex").slice(0, 16);
  let remoteUrl = null;
  try {
    remoteUrl = deps.git(["remote", "get-url", cfg.remote], cwd).trim() || null;
  } catch {
  }
  const dir = join(deps.baseDir, repoKey);
  return { ok: true, repo: { repoKey, commonDir, toplevel, dir, dbPath: join(dir, "index.db"), hintPath: join(dir, "hint"), forge: resolveForge(remoteUrl, cfg) } };
}
export {
  ensureRepoDir,
  resolveRepo
};
