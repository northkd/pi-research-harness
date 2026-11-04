/**
 * Dedicated local loopback road for the native `research_session` tool.
 *
 * The caller supplies only role/task/stage and the parent session id sourced
 * from its tool context. This route derives cwd, owner, charter and adoption
 * from the parent's exact persisted res-workflow membership; no destination,
 * project, model or tenant is accepted from the request body.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDashboardConfigDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import type { ResearchSessionProvenance } from "@blackbelt-technology/pi-dashboard-shared/research-session.js";
import { isLocalOperator, sessionPrincipalOf } from "../identity/session-access.js";
import { resolveInstalledResearchLoopRoot, type ResWorkflowAccess } from "../res-workflow/adoption-service.js";
import type { ResWorkflowSpawnRef } from "../res-workflow/participants.js";
import type { ResWorkflowIdentity } from "../res-workflow/access.js";
import type { PendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";
import type { PendingPrincipalOwnerRegistry } from "../pending/pending-principal-owner-registry.js";
import type { SessionManager } from "../session/memory-session-manager.js";
import type { SpawnResult } from "../spawn-process/process-manager.js";
import type { SpawnStrategy } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { NetworkGuard } from "./route-deps.js";
import { createResearchSessionService, ResearchSessionError } from "../res-workflow/research-session-service.mjs";

export interface ResearchSessionInitialPromptRegistry {
  enqueue(cwd: string, prompt: string, spawnToken?: string): boolean;
  remove?(cwd: string, spawnToken?: string): boolean | void;
}

export interface ResearchSessionRouteDeps {
  networkGuard: NetworkGuard;
  sessionManager: Pick<SessionManager, "get" | "listAll">;
  accessFor(cwd: string, identity: ResWorkflowIdentity): Promise<ResWorkflowAccess>;
  prepareSpawn(cwd: string, identity: ResWorkflowIdentity, verified?: { ownerKey?: string; researchSession?: ResearchSessionProvenance }): Promise<ResWorkflowSpawnRef>;
  pendingPluginRefRegistry: Pick<PendingPluginRefRegistry, "file" | "remove">;
  pendingPrincipalOwnerRegistry: Pick<PendingPrincipalOwnerRegistry, "file" | "remove">;
  initialPrompts: ResearchSessionInitialPromptRegistry;
  spawn(cwd: string, options: { spawnToken: string; strategy?: SpawnStrategy }): Promise<SpawnResult>;
  spawnStrategy?(): SpawnStrategy;
  /** Called after a launch so the host can arm its watchdog/pid registry. */
  onSpawnResult?(cwd: string, result: SpawnResult): void;
  isResolverActive(): boolean;
  researchLoopRoot?: string;
  privateDir?: string;
}

const hash = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

function readBoundedJson(file: string): Record<string, unknown> | null {
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024) return null;
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return object(value) ? value : null;
  } catch { return null; }
}

function sameOwner(a: { iss: string; sub: string } | null | undefined, b: { iss: string; sub: string } | null | undefined): boolean {
  return !!a && !!b && a.iss === b.iss && a.sub === b.sub;
}

function ownerKeyFor(cwd: string, adoptionId: string, principalOwner: { iss: string; sub: string } | undefined, privateDir: string): string {
  if (principalOwner) return JSON.stringify([principalOwner.iss, principalOwner.sub]);
  const candidates = [
    JSON.stringify(["host", "inert-operator"]),
    JSON.stringify(["urn:pi-dashboard:local-operator", "local-operator"]),
  ];
  const matches = candidates.filter(ownerKey => {
    const scope = path.join(privateDir, hash(ownerKey), hash(cwd));
    const adopted = readBoundedJson(path.join(scope, "adopted.json"));
    const operation = readBoundedJson(path.join(scope, `${adoptionId}.json`));
    return adopted?.confirmed === true && adopted.id === adoptionId &&
      operation?.schema === "pi-res-workflow-operation.v1" && operation.cwd === cwd &&
      operation.adoption && typeof operation.adoption === "object" &&
      (operation.adoption as Record<string, unknown>).id === adoptionId;
  });
  if (matches.length !== 1) throw new ResearchSessionError(404, "research-session-parent-not-joined");
  return matches[0]!;
}

/** Default verifier: the same persisted membership/adoption/charter proof the hook uses. */
export function createDefaultResearchSessionVerifier(deps: Pick<ResearchSessionRouteDeps, "sessionManager" | "researchLoopRoot" | "privateDir">) {
  const privateDir = deps.privateDir ?? path.join(getDashboardConfigDir(), "res-workflow");
  return async ({ parent, principal }: { parent: any; principal: { iss: string; sub: string } | null | undefined; expiresAt?: number | null }) => {
    if (!parent || typeof parent.id !== "string" || typeof parent.cwd !== "string" || typeof parent.sessionFile !== "string") {
      throw new ResearchSessionError(404, "research-session-parent-not-found");
    }
    let cwd: string;
    try { cwd = fs.realpathSync(parent.cwd); } catch { throw new ResearchSessionError(404, "research-session-parent-not-found"); }
    if (cwd !== parent.cwd) throw new ResearchSessionError(404, "research-session-parent-not-joined");
    if (principal && !isLocalOperator(principal)) {
      if (!sameOwner(parent.principalOwner, principal)) throw new ResearchSessionError(404, "research-session-parent-not-found");
    } else if (!principal && parent.principalOwner) {
      throw new ResearchSessionError(404, "research-session-parent-not-found");
    }
    const root = deps.researchLoopRoot ?? await resolveInstalledResearchLoopRoot();
    const module = await import(pathToFileURL(path.join(root, "src", "workbench-context.mjs")).href);
    if (typeof module.readWorkbenchRecordContext !== "function") throw new ResearchSessionError(503, "research-session-verifier-unavailable");
    let context: any;
    try {
      context = module.readWorkbenchRecordContext({
        cwd,
        sessionManager: {
          getSessionId: () => parent.id,
          getSessionFile: () => parent.sessionFile,
        },
      }, { privateDir });
    } catch {
      throw new ResearchSessionError(404, "research-session-parent-not-joined");
    }
    if (!context || context.sessionId !== parent.id) throw new ResearchSessionError(404, "research-session-parent-not-joined");
    const ownerKey = ownerKeyFor(cwd, context.adoptionId, parent.principalOwner, privateDir);
    return { cwd, charterHash: context.charterHash, adoptionId: context.adoptionId, ownerKey };
  };
}

export function registerResWorkflowResearchSessionRoutes(fastify: FastifyInstance, deps: ResearchSessionRouteDeps) {
  const verifyParent = createDefaultResearchSessionVerifier(deps);
  const service = createResearchSessionService({
    getSession: id => deps.sessionManager.get(id),
    listSessions: () => deps.sessionManager.listAll(),
    verifyParent,
    prepareSpawn: (cwd, identity, verified) => deps.prepareSpawn(cwd, identity, verified),
    pendingPluginRefRegistry: deps.pendingPluginRefRegistry,
    pendingPrincipalOwnerRegistry: deps.pendingPrincipalOwnerRegistry,
    initialPrompts: deps.initialPrompts,
    spawn: async (cwd, options) => {
      const result = await deps.spawn(cwd, options);
      try { deps.onSpawnResult?.(cwd, result); } catch { /* watchdog/persistence is host-owned */ }
      return result;
    },
    spawnStrategy: deps.spawnStrategy,
    isLocalOperator: principal => isLocalOperator(principal as { iss: string; sub: string } | null | undefined),
  });

  fastify.post("/api/res-workflow/participants/spawn", { preHandler: deps.networkGuard }, async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      return await service.create({
        body: request.body,
        principal: sessionPrincipalOf(request),
        expiresAt: (request as FastifyRequest & { principalExpiresAt?: number | null }).principalExpiresAt ?? null,
      });
    } catch (error) {
      if (error instanceof ResearchSessionError) {
        reply.code(error.statusCode);
        return { success: false, error: error.code, code: error.code };
      }
      reply.code(503);
      return { success: false, error: "research-session-unavailable", code: "research-session-unavailable" };
    }
  });
}
