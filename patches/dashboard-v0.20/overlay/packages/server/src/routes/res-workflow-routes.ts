import path from "node:path";
import type { Socket } from "node:net";
import type { AdmitCwdOptions } from "@blackbelt-technology/pi-dashboard-shared/cwd-guard.js";
import { loadConfig } from "@blackbelt-technology/pi-dashboard-shared/config.js";
import { getDashboardConfigDir, resolvePiAgentDir, resolvePiSessionsDir } from "@blackbelt-technology/pi-dashboard-shared/dashboard-paths.js";
import type { ResWorkflowAnalyzeRequest, ResWorkflowConfirmRequest, ResWorkflowCreateRequest, ResWorkflowHistoryReviewPrepareRequest, ResWorkflowAgentCreateRequest, ResWorkflowAgentAuthorizeRequest, ResWorkflowAgentResumeRequest, ResWorkflowAgentBudgetUpdateRequest } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { isLocalOperator, sessionPrincipalOf } from "../identity/session-access.js";
import { readLocalTokenIfPresent } from "../auth/local-token.js";
import { isGenuinelyLocal } from "../auth/localhost-guard.js";
import type { HostPolicy } from "../identity/host-access.js";
import { createResWorkflowService, ResWorkflowError, type ResWorkflowAccess, type ResWorkflowService, type ResWorkflowServiceDeps } from "../res-workflow/adoption-service.js";
import { resWorkflowAccess } from "../res-workflow/access.js";
import type { RemoteTranscriptStore } from "../session/remote-transcript-store.js";
import type { NetworkGuard } from "./route-deps.js";
import { isResWorkflowResearchBudgetUpdateRequest } from "@blackbelt-technology/pi-dashboard-shared/research-budget.js";
import { createResWorkflowResearchBudgetService } from "../res-workflow/research-budget-service.js";

export interface ResWorkflowRouteDeps extends Omit<ResWorkflowServiceDeps, "privateDir" | "historyRoots"> {
  networkGuard: NetworkGuard;
  knownCwds(): string[];
  privateDir?: string;
  historyRoots?(): string[];
  remoteTranscriptStore?: RemoteTranscriptStore;
  isResolverActive?(): boolean;
  hostPolicy?: HostPolicy;
  admitOptions?: AdmitCwdOptions;
  service?: ResWorkflowService;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return object(value) && Object.keys(value).every(key => keys.includes(key));
}

const preparingSockets = new WeakMap<Socket, { previousTimeout: number; pending: number }>();
/** Only the admitted local preparation borrows a finite budget; global routes stay unchanged. */
function holdPreparationTimeout(request: FastifyRequest, reply: FastifyReply): () => void {
  const socket = request.raw.socket;
  if (!socket || socket.destroyed || typeof socket.setTimeout !== "function") return () => {};
  let state = preparingSockets.get(socket);
  if (!state) { state = { previousTimeout: socket.timeout ?? 0, pending: 0 }; preparingSockets.set(socket, state); }
  const lease = state;
  lease.pending++; socket.setTimeout(Math.max(lease.previousTimeout, 240_000));
  let released = false;
  const release = () => {
    if (released) return; released = true;
    request.raw.removeListener("aborted", release); reply.raw.removeListener("finish", release); reply.raw.removeListener("close", release);
    if (--lease.pending === 0) { preparingSockets.delete(socket); if (!socket.destroyed) socket.setTimeout(lease.previousTimeout); }
  };
  request.raw.once("aborted", release); reply.raw.once("finish", release); reply.raw.once("close", release);
  return release;
}

export function registerResWorkflowRoutes(fastify: FastifyInstance, deps: ResWorkflowRouteDeps): ResWorkflowService {
  const service = deps.service ?? createResWorkflowService({
    ...deps, privateDir: deps.privateDir ?? path.join(getDashboardConfigDir(), "res-workflow"),
    historyRoots: deps.historyRoots ?? (() => [...new Set([resolvePiSessionsDir({ piSessionsDir: loadConfig().piSessionsDir }), resolvePiSessionsDir(), path.join(resolvePiAgentDir(), "sessions")])]),
    readRetained: deps.readRetained ?? (deps.remoteTranscriptStore?.readRawBounded ? (id, maxBytes) => deps.remoteTranscriptStore!.readRawBounded!(id, maxBytes) : undefined),
  });
  fastify.addHook("onClose", async () => { service.dispose(); });
  const researchBudget = createResWorkflowResearchBudgetService({ researchLoopRoot: deps.researchLoopRoot, connection: access => service.connection(access) });

  const accessFor = (request: FastifyRequest, cwd: unknown) => resWorkflowAccess(deps, {
    principal: sessionPrincipalOf(request),
    expiresAt: (request as FastifyRequest & { principalExpiresAt?: number | null }).principalExpiresAt,
    write: !["GET", "HEAD"].includes(request.method),
  }, cwd);

  async function execute(request: FastifyRequest, reply: FastifyReply, rawCwd: unknown, action: (access: ResWorkflowAccess) => Promise<unknown>) {
    try { return await action(await accessFor(request, rawCwd)); }
    catch (err) {
      const failure = err instanceof ResWorkflowError ? err : new ResWorkflowError(503, "res-workflow-unavailable");
      reply.code(failure.statusCode);
      if (failure.code === "cwd-admission-unavailable") reply.header("Retry-After", "1");
      return { success: false, error: failure.message, code: failure.code };
    }
  }

  const query = (request: FastifyRequest) => {
    if (!shape(request.query, ["cwd"])) throw new ResWorkflowError(400, "only-cwd-query-allowed");
    return request.query.cwd;
  };
  const body = (request: FastifyRequest, keys: string[]) => {
    if (!shape(request.body, keys)) throw new ResWorkflowError(400, "invalid-adoption-request");
    const value = request.body;
    const consentKeys = value.expectedRevision !== undefined ? ["scope", "budgetMayIncreaseCharges", "unknownRetryMayBillAgain"] : value.consent && object(value.consent) && value.consent.analysisMode === "full-history-agent-v2" ? ["scope", "includeUnpublished", "analysisMode", "grantHash", "maxRequests", "policyId", "unknownRetryMayBillAgain"] : ["scope", "includeUnpublished", "analysisMode", "planId", "planHash", "maxRequests"];
    if (value.model !== undefined && !shape(value.model, ["provider", "id"]) || value.consent !== undefined && !shape(value.consent, consentKeys)) throw new ResWorkflowError(400, "invalid-adoption-request");
    if (value.recovery !== undefined && !shape(value.recovery, ["mode", "previousPlanId", "previousPlanHash"])) throw new ResWorkflowError(400, "invalid-adoption-request");
    if (value.budget !== undefined && (!shape(value.budget, ["maxRequests", "consent"]) || !shape(value.budget.consent, ["scope", "budgetMayIncreaseCharges", "unknownRetryMayBillAgain"]))) throw new ResWorkflowError(400, "invalid-adoption-request");
    return value;
  };
  const guarded = { preHandler: deps.networkGuard };
  const read = (url: string, action: (access: ResWorkflowAccess, request: FastifyRequest) => Promise<unknown>) => fastify.get(url, guarded, async (request, reply) => {
    try { return await execute(request, reply, query(request), access => action(access, request)); }
    catch { reply.code(400); return { success: false, error: "only-cwd-query-allowed", code: "only-cwd-query-allowed" }; }
  });
  const mutate = (url: string, keys: string[], action: (access: ResWorkflowAccess, value: Record<string, unknown>, request: FastifyRequest) => Promise<unknown>, accepted = false, preparation = false) => fastify.post(url, guarded, async (request, reply) => {
    let value: Record<string, unknown>;
    try { value = body(request, keys); }
    catch { reply.code(400); return { success: false, error: "invalid-adoption-request", code: "invalid-adoption-request" }; }
    const result = await execute(request, reply, value.cwd, async access => {
      const release = preparation ? holdPreparationTimeout(request, reply) : undefined;
      try { return await action(access, { ...value, cwd: access.cwd }, request); }
      finally { release?.(); }
    });
    if (accepted && reply.statusCode === 200) reply.code(202);
    return result;
  });
  const idOf = (request: FastifyRequest) => (request.params as { id: string }).id;

  read("/api/res-workflow", access => service.snapshot(access));
  fastify.get("/api/res-workflow/workbench-sync", guarded, async (request, reply) => {
    if (request.headers.dpop) {
      reply.code(403);
      return { success: false, error: "caller-proof-forwarding-unsupported" };
    }
    let rawCwd: unknown;
    try { rawCwd = query(request); }
    catch { reply.code(400); return { success: false, error: "only-cwd-query-allowed" }; }
    return execute(request, reply, rawCwd, async access => {
      const token = readLocalTokenIfPresent();
      if (!token) throw new ResWorkflowError(503, "workbench-sync-unavailable");
      const principal = sessionPrincipalOf(request);
      const localCaller = isLocalOperator(principal) ||
        (!(deps.isResolverActive?.() ?? false) && isGenuinelyLocal(request.ip, request.headers));
      const headers: Record<string, string> = {
        "x-pi-local-token": token,
        "x-pi-caller-local": localCaller ? "1" : "0",
      };
      for (const name of ["cookie", "authorization"] as const) {
        const value = request.headers[name];
        if (typeof value === "string") headers[name] = value;
      }
      const response = await fetch(`http://127.0.0.1:18767/api/res-workflow/workbench-sync?cwd=${encodeURIComponent(access.cwd)}`, {
        headers, redirect: "error", signal: AbortSignal.timeout(8000),
      });
      const data = await response.json();
      await access.revalidate();
      reply.code(response.status);
      return data;
    });
  });
  read("/api/res-workflow/connection", access => service.connection(access));
  read("/api/res-workflow/research-budget", access => researchBudget.read(access));
  fastify.post("/api/res-workflow/research-budget", guarded, async (request, reply) => {
    if (!isResWorkflowResearchBudgetUpdateRequest(request.body)) {
      reply.code(400);
      return { success: false, error: "research-budget-invalid", code: "research-budget-invalid" };
    }
    const value = request.body;
    return execute(request, reply, value.cwd, access => researchBudget.update(access, { ...value, cwd: access.cwd }));
  });
  read("/api/res-workflow/history-candidates", access => service.historyCandidates(access));
  read("/api/res-workflow/models", async access => ({ models: await service.models(access) }));
  mutate("/api/res-workflow/reconnect", ["cwd"], access => service.reconnect(access));
  read("/api/res-workflow/adoptions/:id", async (access, request) => ({ adoption: await service.get(access, idOf(request)) }));
  read("/api/res-workflow/adoptions/:id/sources/:sourceId", (access, request) => service.source(access, idOf(request), (request.params as { sourceId: string }).sourceId));
  mutate("/api/res-workflow/participants", ["cwd", "sessionId"], (access, value) => service.joinParticipant(access, value.sessionId as string));
  mutate("/api/res-workflow/adoptions", ["cwd", "requestId", "historySelection", "model", "consent"], async (access, value) => ({ adoption: await service.create(access, value as unknown as ResWorkflowCreateRequest) }), true);
  mutate("/api/res-workflow/adoptions/agent", ["cwd", "requestId", "historySelection", "model"], async (access, value) => ({ adoption: await service.createAgent(access, value as unknown as ResWorkflowAgentCreateRequest) }), true);
  mutate("/api/res-workflow/adoptions/:id/agent/authorize", ["cwd", "requestId", "model", "consent", "budget"], async (access, value, request) => ({ adoption: await service.authorizeAgent(access, idOf(request), value as unknown as ResWorkflowAgentAuthorizeRequest) }), true);
  mutate("/api/res-workflow/adoptions/:id/agent/budget", ["cwd", "requestId", "grantHash", "expectedRevision", "maxRequests", "consent"], async (access, value, request) => ({ adoption: await service.updateAgentBudget(access, idOf(request), value as unknown as ResWorkflowAgentBudgetUpdateRequest) }));
  mutate("/api/res-workflow/adoptions/:id/agent/resume", ["cwd", "requestId", "grantHash"], async (access, value, request) => ({ adoption: await service.resumeAgent(access, idOf(request), value as unknown as ResWorkflowAgentResumeRequest) }), true);
  mutate("/api/res-workflow/adoptions/:id/analyze", ["cwd", "requestId", "model", "consent"], async (access, value, request) => ({ adoption: await service.analyze(access, idOf(request), value as unknown as ResWorkflowAnalyzeRequest) }), true);
  mutate("/api/res-workflow/adoptions/:id/history-review/prepare", ["cwd", "requestId", "model", "recovery"], async (access, value, request) => ({ adoption: await service.prepareHistoryReview(access, idOf(request), value as unknown as ResWorkflowHistoryReviewPrepareRequest) }), false, true);
  mutate("/api/res-workflow/adoptions/:id/history-review/analyze", ["cwd", "requestId", "model", "consent"], async (access, value, request) => ({ adoption: await service.analyzeHistoryReview(access, idOf(request), value as unknown as ResWorkflowAnalyzeRequest) }), true);
  mutate("/api/res-workflow/adoptions/:id/confirm", ["cwd", "proposalHash", "objective", "successCriteria"], async (access, value, request) => ({ adoption: await service.confirm(access, idOf(request), value as unknown as ResWorkflowConfirmRequest) }));
  mutate("/api/res-workflow/adoptions/:id/cancel", ["cwd"], async (access, _value, request) => ({ adoption: await service.cancel(access, idOf(request)) }));
  return service;
}
