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
import { pathToFileURL } from "node:url";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getDashboardConfigDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import type { ResearchSessionProvenance } from "@blackbelt-technology/pi-dashboard-shared/research-session.js";
import { LOCAL_OPERATOR, isLocalOperator, sessionPrincipalOf } from "../identity/session-access.js";
import { resolveInstalledResearchLoopRoot, type ResWorkflowAccess } from "../res-workflow/adoption-service.js";
import type { ResWorkflowSpawnRef } from "../res-workflow/participants.js";
import type { ResWorkflowIdentity } from "../res-workflow/access.js";
import type { PendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";
import type { PendingPrincipalOwnerRegistry } from "../pending/pending-principal-owner-registry.js";
import type { SessionManager } from "../session/memory-session-manager.js";
import type { SpawnResult } from "../spawn-process/process-manager.js";
import type { SpawnStrategy } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import type { NetworkGuard } from "./route-deps.js";
import { hasLocalCredential } from "../auth/local-credential.js";
import { isGenuinelyLocal } from "../auth/localhost-guard.js";
import { ResWorkflowError } from "../res-workflow/adoption-service.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { ArchivedSessionSummary } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { ResWorkflowConnection } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { createResearchServices, ResearchCollaborationError, ResearchSessionError } from "../../../../../research-host/services/index.mjs";

export interface ResearchSessionInitialPromptRegistry {
  enqueue(cwd: string, prompt: string, spawnToken?: string): boolean;
  remove?(cwd: string, spawnToken?: string): boolean | void;
}

export interface ResearchSessionRouteDeps {
  networkGuard: NetworkGuard;
  sessionManager: Pick<SessionManager, "get" | "listAll">;
  accessFor(cwd: string, identity: ResWorkflowIdentity): Promise<ResWorkflowAccess>;
  history?(): (DashboardSession | ArchivedSessionSummary)[];
  connection?(access: ResWorkflowAccess): Promise<ResWorkflowConnection>;
  joinParticipant?(access: ResWorkflowAccess, sessionId: string): Promise<unknown>;
  detachParticipant?(access: ResWorkflowAccess, sessionId: string): Promise<unknown>;
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
  notifyParent?(sessionId: string, text: string, promptId: string): boolean | Promise<boolean>;
  subscribeReceiptAcks?(handler: (sessionId: string, promptId: string) => void): () => void;
}

function sameOwner(a: { iss: string; sub: string } | null | undefined, b: { iss: string; sub: string } | null | undefined): boolean {
  return !!a && !!b && a.iss === b.iss && a.sub === b.sub;
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
    if (typeof module.inspectWorkbenchRecordContext !== "function") throw new ResearchSessionError(503, "research-session-verifier-unavailable");
    let inspection: any;
    try {
      const live = deps.sessionManager.get(parent.id);
      const registered = live === parent && ['active', 'idle', 'streaming'].includes(parent.status);
      inspection = module.inspectWorkbenchRecordContext({
        cwd,
        sessionManager: {
          getSessionId: () => parent.id,
          getSessionFile: () => parent.sessionFile,
          // The authenticated gateway registration owns these fields before Pi
          // flushes its first JSONL. The persisted owner/membership is still read
          // and checked by the native verifier; corrupt existing files fail.
          ...(registered ? { getHeader: () => ({ type: 'session', id: parent.id, cwd: parent.cwd }) } : {}),
        },
      }, { privateDir, ...(parent.principalOwner ? { expectedOwnerKey: JSON.stringify([parent.principalOwner.iss, parent.principalOwner.sub]) } : {}) });
    } catch {
      throw new ResearchSessionError(503, "research-workbench-proof-unavailable");
    }
    if (inspection.status !== 'ready') {
      if (inspection.status === 'not-joined') throw new ResearchSessionError(404, 'research-session-parent-not-joined');
      const code = /^research-workbench-[a-z-]+$/.test(inspection.error ?? '') ? inspection.error : 'research-workbench-proof-unavailable';
      throw new ResearchSessionError(inspection.status === 'unavailable' ? 503 : 409, code);
    }
    const context = inspection.context;
    if (!context || context.sessionId !== parent.id) throw new ResearchSessionError(404, "research-session-parent-not-joined");
    return { cwd, charterHash: context.charterHash, adoptionId: context.adoptionId, ownerKey: inspection.ownerKey };
  };
}

export function registerResWorkflowResearchSessionRoutes(fastify: FastifyInstance, deps: ResearchSessionRouteDeps) {
  const verifyParent = createDefaultResearchSessionVerifier(deps);
  const verifyLaunch = async ({ parent }: { parent: any }) => {
    // Ordinary session ownership/membership still governs dispatch. The retired
    // task grant is not a second authorization or expiry gate for either mode.
    // Background launches retain the exact existing mainline resource floor;
    // an earlier successful plan call is not an enduring resource permit.
    const root = deps.researchLoopRoot ?? await resolveInstalledResearchLoopRoot();
    const module = await import(pathToFileURL(path.join(root, "..", "mainline-supervision", "src", "core.mjs")).href);
    const supervision = new module.MainlineStore(parent.cwd);
    if (!supervision.resourceGate().ok) throw new ResearchSessionError(409, "research-session-resource-budget-unavailable");
  };
  const services = createResearchServices({
    privateDir: deps.privateDir ?? path.join(getDashboardConfigDir(), "res-workflow"),
    getSession: (id: string) => deps.sessionManager.get(id),
    listSessions: () => deps.sessionManager.listAll(),
    history: deps.history,
    accessFor: deps.accessFor,
    connection: deps.connection,
    joinParticipant: deps.joinParticipant,
    detachParticipant: deps.detachParticipant,
    verifyParent,
    prepareSpawn: deps.prepareSpawn,
    pendingPluginRefRegistry: deps.pendingPluginRefRegistry,
    pendingPrincipalOwnerRegistry: deps.pendingPrincipalOwnerRegistry,
    initialPrompts: deps.initialPrompts,
    spawn: deps.spawn,
    spawnStrategy: deps.spawnStrategy,
    onSpawnResult: deps.onSpawnResult,
    beforeLaunch: verifyLaunch,
    notifyParent: deps.notifyParent ?? (() => false),
    subscribeReceiptAcks: deps.subscribeReceiptAcks,
    principalForSession: (session: DashboardSession | undefined) => session?.principalOwner ?? LOCAL_OPERATOR,
    isLocalOperator: (principal: Parameters<typeof isLocalOperator>[0]) => isLocalOperator(principal),
  });

  // Reconcile real registration, queue slots and durable receipts through one scheduler.
  const tick = () => { void services.tick().catch(() => { /* Persisted jobs remain inspectable. */ }); };
  const timer = setInterval(tick, 2_000);
  timer.unref?.();
  fastify.addHook("onClose", async () => { clearInterval(timer); services.dispose(); });
  tick();

  const guarded = { preHandler: deps.networkGuard };
  const actor = (request: FastifyRequest) => ({
    principal: sessionPrincipalOf(request),
    expiresAt: (request as FastifyRequest & { principalExpiresAt?: number | null }).principalExpiresAt ?? null,
  });
  async function handle(reply: FastifyReply, fallback: string, run: () => Promise<unknown>) {
    try { return await run(); }
    catch (error) {
      const failure = error instanceof ResWorkflowError || error instanceof ResearchSessionError || error instanceof ResearchCollaborationError;
      const code = failure ? error.code : fallback;
      reply.code(failure ? error.statusCode : 503);
      return { success: false, error: code, code };
    }
  }
  const checked = (input: unknown, allowed: string[]): Record<string, unknown> => {
    if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !allowed.includes(key))) {
      throw new ResearchCollaborationError(400, "research-collaboration-request-invalid");
    }
    return input as Record<string, unknown>;
  };

  fastify.get("/api/res-workflow/collaboration", guarded, (request, reply) => handle(reply, "research-collaboration-unavailable", async () => {
    const query = checked(request.query, ["cwd"]);
    return services.collaboration.snapshot(await deps.accessFor(query.cwd as string, { ...actor(request), write: false }));
  }));

  fastify.post("/api/res-workflow/collaboration", guarded, (request, reply) => handle(reply, "research-collaboration-unavailable", async () => {
    const body = checked(request.body, ["cwd", "action", "expectedRevision", "sessionId", "tenureId", "maxMultiAgents", "maxSubagents", "planId", "taskId", "taskIds", "queueRevision", "text", "requestId"]);
    const identity = actor(request);
    const access = await deps.accessFor(body.cwd as string, { ...identity, write: true });
    return services.collaboration.mutate(access, body, identity);
  }));

  fastify.post("/api/res-workflow/collaboration/native", guarded, (request, reply) => handle(reply, "research-native-admission-unavailable", async () => {
    if (!isGenuinelyLocal(request.ip, request.headers) || !hasLocalCredential(request.headers)) {
      throw new ResearchCollaborationError(403, "research-native-local-credential-required");
    }
    const body = checked(request.body, ["sessionId", "action", "requestId", "attemptId", "role", "model", "task", "leaseToken", "phase", "childSessionId"]);
    const cleanup = body.action === "subagent-release" || (body.action === "subagent-heartbeat" && body.phase === "running");
    const parent = typeof body.sessionId === "string"
      ? deps.sessionManager.get(body.sessionId) ?? (cleanup ? deps.history?.().find(row => row.id === body.sessionId) : undefined)
      : undefined;
    if (!parent || parent.originDeviceId) throw new ResearchCollaborationError(404, "research-collaboration-session-not-found");
    const identity = actor(request);
    const access = await deps.accessFor(parent.cwd, { ...identity, write: true });
    return services.collaboration.native(access, body, identity);
  }));

  fastify.post("/api/res-workflow/communication", guarded, (request, reply) => handle(reply, "research-communication-unavailable",
    () => services.communication.handle({ body: request.body, ...actor(request) })));
  fastify.post("/api/res-workflow/dispatch", guarded, (request, reply) => handle(reply, "research-dispatch-unavailable",
    () => services.dispatch.handle({ body: request.body, ...actor(request) })));
  fastify.post("/api/res-workflow/participants/spawn", guarded, (request, reply) => handle(reply, "research-session-unavailable",
    () => services.sessions.create({ body: request.body, ...actor(request) })));

  return services.collaboration;
}
