import { supplementalHostDir } from "../../runtime-home.mjs";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
function storePath() {
  return process.env.KB_SOURCE_TRUST_PATH ?? join(supplementalHostDir(), "kb-source-trust.json");
}
function canonicalSource(s) {
  const k = s.kind ?? "filesystem";
  return `${k}\0${s.ref}\0${s.subdir ?? ""}\0${s.pin ?? ""}`;
}
function sourceHash(s) {
  return createHash("sha256").update(canonicalSource(s)).digest("hex");
}
function sourceSubject(s) {
  const k = s.kind ?? "filesystem";
  return `${k}:${s.ref}${s.subdir ? `/${s.subdir}` : ""}${s.pin ? `@${s.pin}` : ""}`;
}
function isEntry(v) {
  return v === true || typeof v === "object" && v !== null && !Array.isArray(v);
}
function load() {
  try {
    const raw = readFileSync(storePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch {
  }
  return {};
}
function save(map) {
  const p = storePath();
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(tmp, JSON.stringify(map, null, 2), "utf8");
    renameSync(tmp, p);
    return true;
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
    }
    console.warn(`[kb-source-trust] failed to persist: ${err?.message}`);
    return false;
  }
}
function isTrusted(s) {
  return isEntry(load()[sourceHash(s)]);
}
function recordTrust(s) {
  const map = load();
  map[sourceHash(s)] = { subject: sourceSubject(s) };
  return save(map);
}
function revokeTrust(s) {
  const hash = sourceHash(s);
  const map = load();
  if (Object.prototype.hasOwnProperty.call(map, hash)) {
    delete map[hash];
    save(map);
  }
}
function revokeTrustByHash(hash) {
  const map = load();
  if (!Object.prototype.hasOwnProperty.call(map, hash)) return false;
  delete map[hash];
  save(map);
  return true;
}
function listTrustedSources() {
  const out = [];
  for (const [hash, entry] of Object.entries(load())) {
    if (!isEntry(entry)) continue;
    out.push({ hash, subject: entry === true ? null : entry.subject ?? null });
  }
  return out;
}
async function defaultPromptTrust(s) {
  const { createInterface } = await import("node:readline");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`KB wants to fetch remote source ${s.kind}:${s.ref}${s.pin ? `@${s.pin}` : ""}. Allow? [y/N] `, (ans) => {
      rl.close();
      resolve(/^y/i.test(ans.trim()));
    });
  });
}
export {
  canonicalSource,
  defaultPromptTrust,
  isTrusted,
  listTrustedSources,
  recordTrust,
  revokeTrust,
  revokeTrustByHash,
  sourceHash,
  sourceSubject
};
