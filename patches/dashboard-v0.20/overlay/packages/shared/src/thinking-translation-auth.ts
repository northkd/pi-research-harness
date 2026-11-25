import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { TranslationAuthorization, TranslationOwner } from "./thinking-translation.js";

const MAX_AUTHORIZATION_BYTES = 16_384;
export const LOCAL_TRANSLATION_OWNER = { iss: "urn:pi-dashboard:local-operator", sub: "local-operator" } as const;

export function translationAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function authorizationPath(sessionId: string, agentDir = translationAgentDir()): string {
  const id = createHash("sha256").update(sessionId).digest("hex");
  return join(agentDir, "thinking-translator-authorizations", `${id}.json`);
}

/** Bind the physical request target without retaining credentials in an authorization. */
export function translationModelFingerprint(model: { provider: string; id: string; baseUrl?: unknown; api?: unknown; headers?: unknown }): string {
  const headers = model.headers && typeof model.headers === "object"
    ? Object.entries(model.headers as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    : [];
  return createHash("sha256").update(JSON.stringify([model.provider, model.id, model.baseUrl ?? "", model.api ?? "", headers])).digest("hex");
}

function privateOwnedStat(stat: Stats): boolean {
  return (stat.mode & 0o077) === 0 && (typeof process.getuid !== "function" || stat.uid === process.getuid());
}

function trustedDirectory(agentDir: string, create: boolean): string {
  const dir = join(agentDir, "thinking-translator-authorizations");
  if (create) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwnedStat(stat)) throw new Error("translation authorization directory is not private");
  return dir;
}

function validGrant(v: unknown, sessionId: string): v is TranslationAuthorization {
  if (!v || typeof v !== "object") return false;
  const a = v as TranslationAuthorization;
  return a.version === 1 && a.sessionId === sessionId && typeof a.enabled === "boolean"
    && a.model && typeof a.model.provider === "string" && a.model.provider.length > 0 && a.model.provider.length <= 200 && !a.model.provider.includes("/") && !a.model.provider.startsWith("@")
    && typeof a.model.id === "string" && a.model.id.length > 0 && a.model.id.length <= 400 && !a.model.id.startsWith("@")
    && /^[a-f0-9]{64}$/.test(a.modelFingerprint) && a.targetLanguage === "Simplified Chinese"
    && Array.isArray(a.contentTypes) && a.contentTypes.length === 1 && a.contentTypes[0] === "thinking"
    && typeof a.acceptedAt === "string" && Number.isFinite(Date.parse(a.acceptedAt))
    && !!a.owner && typeof a.owner.iss === "string" && a.owner.iss.length > 0 && a.owner.iss.length <= 500 && typeof a.owner.sub === "string" && a.owner.sub.length > 0 && a.owner.sub.length <= 500;
}

function readAuthorizationText(sessionId: string, agentDir: string): string | null {
  let fd: number | undefined;
  try {
    trustedDirectory(agentDir, false);
    fd = openSync(authorizationPath(sessionId, agentDir), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || !privateOwnedStat(stat) || stat.size > MAX_AUTHORIZATION_BYTES) return null;
    const text = readFileSync(fd, "utf8");
    return Buffer.byteLength(text) <= MAX_AUTHORIZATION_BYTES ? text : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function readTranslationAuthorization(sessionId: string, agentDir = translationAgentDir()): TranslationAuthorization | null {
  try {
    const text = readAuthorizationText(sessionId, agentDir);
    const value: unknown = text === null ? null : JSON.parse(text);
    return validGrant(value, sessionId) ? value : null;
  } catch { return null; }
}

/** Includes revocation tombstones, so absence cannot revive an earlier pending enable. */
export function readTranslationRevision(sessionId: string, agentDir = translationAgentDir()): string | null {
  const text = readAuthorizationText(sessionId, agentDir);
  return text === null ? null : createHash("sha256").update(text).digest("hex");
}

function writeAuthorizationRecord(record: object & { sessionId: string }, agentDir: string, expectedRevision?: string | null): void {
  trustedDirectory(agentDir, true);
  const file = authorizationPath(record.sessionId, agentDir);
  const lock = `${file}.lock`;
  mkdirSync(lock, { mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    if (expectedRevision !== undefined && readTranslationRevision(record.sessionId, agentDir) !== expectedRevision) {
      throw Object.assign(new Error("translation authorization changed"), { code: "translation-authorization-conflict" });
    }
    try {
      const prior = lstatSync(file);
      if (!prior.isFile() || prior.isSymbolicLink() || !privateOwnedStat(prior)) throw new Error("translation authorization target is not private");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    writeFileSync(temp, JSON.stringify({ ...record, revision: randomUUID() }) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  } finally {
    try { unlinkSync(temp); } catch { /* Renamed successfully or never created. */ }
    rmdirSync(lock);
  }
}

export function writeTranslationAuthorization(grant: TranslationAuthorization, agentDir = translationAgentDir(), expectedRevision?: string | null): void {
  if (!validGrant(grant, grant.sessionId)) throw new Error("invalid translation authorization");
  writeAuthorizationRecord(grant, agentDir, expectedRevision);
}

export function writeTranslationRevocation(sessionId: string, owner: TranslationOwner, agentDir = translationAgentDir()): void {
  const prior = readTranslationAuthorization(sessionId, agentDir);
  const revocation = { ...(prior ?? { version: 1, acceptedAt: new Date().toISOString() }), sessionId, owner, enabled: false };
  writeAuthorizationRecord(revocation, agentDir);
}
