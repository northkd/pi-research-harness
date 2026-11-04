import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { canonPath } from "@blackbelt-technology/pi-dashboard-shared/cwd-guard.js";
import { metaPath, writeSessionMeta, type SessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { isResWorkflowServiceSession, type ResWorkflowConnection, type ResWorkflowParticipantResponse, type ResWorkflowParticipation } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { isResearchSessionProvenance, normalizeResearchSessionProvenance, type ResearchSessionProvenance } from "@blackbelt-technology/pi-dashboard-shared/research-session.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { isLocalOperator } from "../identity/session-access.js";
import type { PendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";
import type { MetaPersistence } from "../persistence/meta-persistence.js";
import type { SessionManager } from "../session/memory-session-manager.js";
import { mergePluginRefBag, sanitizePersistedBags } from "../session/plugin-refs.js";
import type { SessionArchive } from "../session/session-archive.js";
import { ResWorkflowError, type ResWorkflowAccess } from "./adoption-service.js";
import type { ResWorkflowIdentity } from "./access.js";
import { readLocalHistoryHeader, type HistoryCandidate } from "./history-candidates.js";

export interface ResWorkflowSpawnRef {
  resWorkflow: ResWorkflowParticipation;
  /** Private pending-token binding; never promoted or persisted as a plugin ref. */
  resWorkflowBinding: { ownerKey: string; identity: ResWorkflowIdentity; resolverActive: boolean };
  /** Optional top-level-collaborator provenance supplied by the native tool road. */
  researchSession?: ResearchSessionProvenance;
}
/** A verified parent may supply the child's exact two-part owner key. */
function ownerKeyRealm(value: string): boolean {
  try {
    const parts: unknown = JSON.parse(value);
    return Array.isArray(parts) && parts.length === 2 &&
      parts.every(part => typeof part === "string" && part.length > 0 && part.length <= 256);
  } catch { return false; }
}
export interface ResWorkflowSpawnSupport {
  prepare(cwd: string, identity: ResWorkflowIdentity): Promise<ResWorkflowSpawnRef>;
  registry: Pick<PendingPluginRefRegistry, "file" | "remove">;
}
interface ParticipantDeps {
  sessionManager: Pick<SessionManager, "get" | "update">;
  sessionArchive: Pick<SessionArchive, "getById" | "updatePluginRefs">;
  metaPersistence: Pick<MetaPersistence, "flush">;
  registry: Pick<PendingPluginRefRegistry, "sanitize">;
  isResolverActive(): boolean;
  accessFor(cwd: string, identity: ResWorkflowIdentity): Promise<ResWorkflowAccess>;
  connection(access: ResWorkflowAccess): Promise<ResWorkflowConnection>;
  broadcast(sessionId: string, update: Partial<DashboardSession>): void;
}
const sameOwner = (a: HistoryCandidate["principalOwner"], b: HistoryCandidate["principalOwner"]) => a?.iss === b?.iss && a?.sub === b?.sub;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function participation(value: unknown, cwd: string): ResWorkflowParticipation | undefined {
  if (!object(value) || value.canonicalCwd !== cwd || typeof value.joinedAt !== "string" || !Number.isFinite(Date.parse(value.joinedAt)) || !["manual", "adoption", "spawn"].includes(value.via as string)) return;
  return { canonicalCwd: cwd, joinedAt: value.joinedAt, via: value.via as ResWorkflowParticipation["via"] };
}
function identityValid(identity: ResWorkflowIdentity): void {
  if (typeof identity.expiresAt === "number" && Date.now() >= identity.expiresAt) throw new ResWorkflowError(403, "adoption-identity-expired");
}

/** Known local sessions only. Association changes no lifecycle or material/model authorization. */
export function createResWorkflowParticipants(deps: ParticipantDeps) {
  const lookup = (id: string) => deps.sessionManager.get(id) ?? deps.sessionArchive.getById(id);
  const matches = (row: HistoryCandidate | undefined, access: ResWorkflowAccess) => !!row && !row.originDeviceId && !isResWorkflowServiceSession(row) && typeof row.cwd === "string" && path.isAbsolute(row.cwd) && canonPath(row.cwd) === access.cwd;
  const connected = async (access: ResWorkflowAccess) => {
    await access.revalidate();
    if (!(await deps.connection(access)).adopted) throw new ResWorkflowError(409, "res-workflow-not-connected");
  };

  async function join(access: ResWorkflowAccess, sessionId: string, via: ResWorkflowParticipation["via"], spawn?: { resWorkflow: ResWorkflowParticipation; sessionFile?: string; principalOwner?: HistoryCandidate["principalOwner"]; researchSession?: unknown }): Promise<ResWorkflowParticipantResponse> {
    const researchSession = spawn?.researchSession === undefined
      ? undefined
      : isResearchSessionProvenance(spawn.researchSession)
        ? normalizeResearchSessionProvenance(spawn.researchSession)
        : (() => { throw new ResWorkflowError(409, "participant-spawn-binding-invalid"); })();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new ResWorkflowError(400, "real-session-id-required");
    await connected(access);
    const row = lookup(sessionId);
    if (!matches(row, access)) throw new ResWorkflowError(404, "participant-session-not-found");
    const expected = { ...row! };
    if (!access.canReadHistory || !(await access.canReadHistory(expected))) throw new ResWorkflowError(404, "participant-session-not-found");
    const registeredFile = spawn?.sessionFile;
    const file = expected.sessionFile ?? registeredFile;
    if (typeof file !== "string" || !path.isAbsolute(file) || path.resolve(file) !== file || !file.endsWith(".jsonl") || file.length > 4096) throw new ResWorkflowError(409, "participant-session-file-unavailable");
    const initial = await lstat(file).catch(() => null);
    if (initial) {
      try { await readLocalHistoryHeader(file, access.cwd, sessionId); }
      catch { throw new ResWorkflowError(409, "participant-session-file-unavailable"); }
    } else if (via !== "spawn") throw new ResWorkflowError(409, "participant-session-file-unavailable");
    await access.revalidate();
    // No awaits between the final identity/path checks, atomic sidecar write and
    // projection update. A queued whole-meta save is flushed before the merge.
    const current = lookup(sessionId);
    if (!matches(current, access) || (current!.sessionFile ?? registeredFile) !== file || !sameOwner(current!.principalOwner, expected.principalOwner) || spawn && !sameOwner(current!.principalOwner, spawn.principalOwner)) throw new ResWorkflowError(404, "participant-session-not-found");
    try {
      const parent = path.dirname(file);
      if (!lstatSync(parent).isDirectory() || realpathSync(parent) !== parent) throw new ResWorkflowError(409, "participant-metadata-unsafe");
      const actual = (() => { try { return lstatSync(file); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; } })();
      // Missing is allowed only while STILL missing. A newly appeared path has
      // no verified header/inode binding; leave it for explicit manual retry.
      if (actual && (!initial || !actual.isFile() || actual.isSymbolicLink() || realpathSync(file) !== file || actual.dev !== initial.dev || actual.ino !== initial.ino) || !actual && via !== "spawn") throw new ResWorkflowError(409, "participant-metadata-unsafe");
      const sidecar = metaPath(file);
      const inspect = (target: string) => { try { return lstatSync(target); } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; } };
      const readAdmittedMeta = (): SessionMeta => {
        const side = inspect(sidecar);
        if (side && (!side.isFile() || side.isSymbolicLink() || side.size > 128 * 1024) || inspect(`${sidecar}.tmp`)) throw new ResWorkflowError(409, "participant-metadata-unsafe");
        let meta: SessionMeta = {};
        if (side) {
          try { const parsed: unknown = JSON.parse(readFileSync(sidecar, "utf8")); if (!object(parsed)) throw new Error(); meta = parsed as SessionMeta; }
          catch { throw new ResWorkflowError(409, "participant-metadata-invalid"); }
        }
        if (isResWorkflowServiceSession(meta)) throw new ResWorkflowError(404, "participant-session-not-found");
        if (meta.principalOwner && !sameOwner(meta.principalOwner, current!.principalOwner) || meta.cwd && canonPath(meta.cwd) !== access.cwd) throw new ResWorkflowError(409, "participant-session-changed");
        return meta;
      };
      // Admission must precede a queued whole-meta save that could erase its evidence.
      readAdmittedMeta();
      deps.metaPersistence.flush(file);
      const meta = readAdmittedMeta();
      const disk = sanitizePersistedBags(meta.pluginRefs);
      const memory = sanitizePersistedBags((current as DashboardSession).pluginRefs);
      const bags = { ...disk };
      for (const [owner, bag] of Object.entries(memory ?? {})) bags[owner] = { ...bags[owner], ...bag };
      const resWorkflow = participation(bags["res-workflow"]?.resWorkflow, access.cwd) ?? spawn?.resWorkflow ?? { canonicalCwd: access.cwd, joinedAt: new Date().toISOString(), via };
      const sanitized = deps.registry.sanitize({ resWorkflow, ...(researchSession ? { researchSession } : {}) }, "res-workflow");
      if (!sanitized.resWorkflow || researchSession && sanitized.researchSession === undefined) throw new ResWorkflowError(409, "participant-ref-unavailable");
      const pluginRefs = mergePluginRefBag(bags, "res-workflow", sanitized);
      if (!pluginRefs) throw new ResWorkflowError(409, "participant-ref-unavailable");
      const nextMeta = { ...meta, pluginRefs, ...(researchSession ? { researchSession } : {}) } as SessionMeta & { researchSession?: ResearchSessionProvenance };
      writeSessionMeta(file, nextMeta);
      if (deps.sessionManager.get(sessionId)) deps.sessionManager.update(sessionId, { pluginRefs, resWorkflow, ...(researchSession ? { researchSession } : {}) });
      else deps.sessionArchive.updatePluginRefs(sessionId, pluginRefs);
      deps.broadcast(sessionId, { resWorkflow, ...(researchSession ? { researchSession } : {}) });
      return { sessionId, resWorkflow, ...(researchSession ? { researchSession } : {}) };
    } catch (err) {
      if (err instanceof ResWorkflowError) throw err;
      throw new ResWorkflowError(503, "participant-metadata-write-failed");
    }
  }

  async function prepareSpawn(cwd: string, identity: ResWorkflowIdentity, verified: { ownerKey?: string; researchSession?: ResearchSessionProvenance } = {}): Promise<ResWorkflowSpawnRef> {
    identityValid(identity);
    const resolverActive = deps.isResolverActive();
    const access = await deps.accessFor(cwd, identity);
    const ownerKey = verified.ownerKey ?? access.ownerKey;
    // A local operator may create a sibling in the parent's proven local realm
    // (host/inert or local-operator). A named principal never overrides its own
    // admitted owner key.
    if (ownerKey !== access.ownerKey) {
      if (!isLocalOperator(identity.principal ?? undefined) || !ownerKeyRealm(ownerKey)) throw new ResWorkflowError(404, "participant-session-not-found");
      await access.revalidate();
    } else {
      await connected(access);
    }
    identityValid(identity);
    if (resolverActive !== deps.isResolverActive()) throw new ResWorkflowError(403, "adoption-identity-expired");
    const researchSession = verified.researchSession === undefined ? undefined : normalizeResearchSessionProvenance(verified.researchSession);
    const ref: ResWorkflowSpawnRef = {
      resWorkflow: { canonicalCwd: access.cwd, joinedAt: new Date().toISOString(), via: "spawn" },
      resWorkflowBinding: { ownerKey, identity: { ...identity, principal: identity.principal ?? null, expiresAt: identity.expiresAt ?? null }, resolverActive },
      ...(researchSession ? { researchSession } : {}),
    };
    const sanitized = deps.registry.sanitize(ref, "res-workflow");
    if (!sanitized.resWorkflow || !sanitized.resWorkflowBinding || researchSession && sanitized.researchSession === undefined) throw new ResWorkflowError(409, "participant-ref-unavailable");
    return ref;
  }

  async function registerSpawn(sessionId: string, registration: { cwd: string; sessionFile?: string }, raw: unknown): Promise<ResWorkflowParticipantResponse> {
    if (!object(raw) || !object(raw.resWorkflowBinding) || !object(raw.resWorkflowBinding.identity) || !object(raw.resWorkflow) || typeof raw.resWorkflow.canonicalCwd !== "string") throw new ResWorkflowError(409, "participant-spawn-binding-invalid");
    const binding = raw.resWorkflowBinding as unknown as ResWorkflowSpawnRef["resWorkflowBinding"];
    identityValid(binding.identity);
    if (binding.resolverActive !== deps.isResolverActive()) throw new ResWorkflowError(403, "adoption-identity-expired");
    const intent = participation(raw.resWorkflow, raw.resWorkflow.canonicalCwd);
    if (!intent || intent.via !== "spawn" || canonPath(registration.cwd) !== intent.canonicalCwd) throw new ResWorkflowError(409, "participant-spawn-cwd-mismatch");
    const admitted = await deps.accessFor(intent.canonicalCwd, binding.identity);
    if (admitted.cwd !== intent.canonicalCwd) throw new ResWorkflowError(404, "participant-session-not-found");
    if (admitted.ownerKey !== binding.ownerKey) {
      // Only the local operator may register into a proven local parent realm.
      if (!isLocalOperator(binding.identity.principal ?? undefined) || !ownerKeyRealm(binding.ownerKey)) throw new ResWorkflowError(404, "participant-session-not-found");
    }
    const access = admitted.ownerKey === binding.ownerKey ? admitted : { ...admitted, ownerKey: binding.ownerKey };
    const row = lookup(sessionId);
    const bindingOwner = (() => {
      try {
        const parts = JSON.parse(binding.ownerKey) as unknown;
        if (!Array.isArray(parts) || parts.length !== 2 || typeof parts[0] !== "string" || typeof parts[1] !== "string") return undefined;
        const local = parts[0] === "host" && parts[1] === "inert-operator" ||
          parts[0] === "urn:pi-dashboard:local-operator" && parts[1] === "local-operator";
        return local ? undefined : { iss: parts[0], sub: parts[1] };
      } catch { return undefined; }
    })();
    const expectedOwner = binding.resolverActive
      ? isLocalOperator(binding.identity.principal ?? undefined)
        ? bindingOwner
        : binding.identity.principal ?? undefined
      : undefined;
    if (!matches(row, access) || !sameOwner(row!.principalOwner, expectedOwner) || row!.sessionFile && row!.sessionFile !== registration.sessionFile) throw new ResWorkflowError(404, "participant-session-not-found");
    return join(access, sessionId, "spawn", { resWorkflow: intent, sessionFile: registration.sessionFile, principalOwner: expectedOwner, researchSession: raw.researchSession });
  }
  return { join, prepareSpawn, registerSpawn };
}
