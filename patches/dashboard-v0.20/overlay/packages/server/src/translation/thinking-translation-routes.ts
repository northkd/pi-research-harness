import { readTranslationAuthorization, readTranslationRevision, translationModelFingerprint, writeTranslationAuthorization, writeTranslationRevocation, LOCAL_TRANSLATION_OWNER } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation-auth.js";
import type { TranslationAuthorization, TranslationModelRef, TranslationOwner } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation.js";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { canAccessSession, sessionPrincipalOf } from "../identity/session-access.js";
import { resolveModel } from "../res-workflow/strict-model.js";
import type { NetworkGuard } from "../routes/route-deps.js";
import type { ThinkingTranslationService } from "./thinking-translation-service.js";

interface TranslationRouteDeps {
  networkGuard: NetworkGuard;
  sessionManager: { get(id: string): { principalOwner?: TranslationOwner } | undefined };
  isResolverActive?: () => boolean;
  service: ThinkingTranslationService;
  agentDir?: string;
  notifyAuthorizationChanged?: (sessionId: string) => void;
  resolveModel?: (provider: string, id: string) => Promise<{ provider: string; id: string; baseUrl?: unknown; api?: unknown; headers?: unknown }>;
}

export function registerThinkingTranslationRoutes(fastify: FastifyInstance, deps: TranslationRouteDeps): void {
  const resolve = deps.resolveModel ?? resolveModel;
  const admitted = (request: FastifyRequest, id: unknown): { id: string; owner: TranslationOwner } | null => {
    if (typeof id !== "string" || !id || id.length > 300) return null;
    const session = deps.sessionManager.get(id);
    const principal = sessionPrincipalOf(request);
    if (!session || !canAccessSession({ active: deps.isResolverActive?.() ?? false, principal, owner: session.principalOwner })) return null;
    return { id, owner: principal ?? LOCAL_TRANSLATION_OWNER };
  };
  const status = (id: string, owner: TranslationOwner) => {
    const grant = readTranslationAuthorization(id, deps.agentDir);
    const own = grant && grant.owner.iss === owner.iss && grant.owner.sub === owner.sub;
    return {
      success: true, sessionId: id, enabled: own ? grant.enabled : false,
      model: own ? grant.model : null, contentTypes: ["thinking"], targetLanguage: "Simplified Chinese",
      runtime: deps.service.runtimeStatus(id),
    };
  };
  fastify.get<{ Querystring: { sessionId?: string } }>("/api/thinking-translation/settings", { preHandler: deps.networkGuard }, async (request, reply) => {
    const scope = admitted(request, request.query.sessionId);
    if (!scope) return reply.code(404).send({ success: false, error: "session not found" });
    return status(scope.id, scope.owner);
  });
  fastify.put<{ Body: { sessionId?: unknown; enabled?: unknown; model?: TranslationModelRef; consent?: unknown } }>("/api/thinking-translation/settings", { preHandler: deps.networkGuard, bodyLimit: 4096 }, async (request, reply) => {
    const scope = admitted(request, request.body?.sessionId);
    if (!scope) return reply.code(404).send({ success: false, error: "session not found" });
    const body = request.body;
    if (typeof body.enabled !== "boolean") return reply.code(400).send({ success: false, error: "enabled must be boolean" });
    const revision = readTranslationRevision(scope.id, deps.agentDir);
    const prior = readTranslationAuthorization(scope.id, deps.agentDir);
    if (prior && (prior.owner.iss !== scope.owner.iss || prior.owner.sub !== scope.owner.sub)) return reply.code(409).send({ success: false, error: "translation authorization belongs to another operator" });
    if (!body.enabled) {
      try { writeTranslationRevocation(scope.id, scope.owner, deps.agentDir); }
      catch { return reply.code(409).send({ success: false, error: "translation revocation could not be saved; retry explicitly" }); }
      deps.service.forget(scope.id);
      deps.notifyAuthorizationChanged?.(scope.id);
      return status(scope.id, scope.owner);
    }
    if (body.consent !== true || !body.model || typeof body.model.provider !== "string" || typeof body.model.id !== "string" || body.model.provider.startsWith("@") || body.model.id.startsWith("@") || !body.model.provider || !body.model.id || body.model.provider.includes("/")) return reply.code(400).send({ success: false, error: "explicit physical model and visible-thinking consent required" });
    let model: Awaited<ReturnType<typeof resolve>>;
    try {
      model = await resolve(body.model.provider, body.model.id);
      if (model.provider !== body.model.provider || model.id !== body.model.id) throw new Error("translation model mismatch");
    } catch {
      return reply.code(409).send({ success: false, error: "selected translation model unavailable; no fallback or model request was made" });
    }
    if (!admitted(request, scope.id)) return reply.code(404).send({ success: false, error: "session not found" });
    const grant: TranslationAuthorization = {
      version: 1, sessionId: scope.id, enabled: true, model: { provider: model.provider, id: model.id },
      modelFingerprint: translationModelFingerprint(model), contentTypes: ["thinking"], targetLanguage: "Simplified Chinese", acceptedAt: new Date().toISOString(), owner: scope.owner,
    };
    try { writeTranslationAuthorization(grant, deps.agentDir, revision); }
    catch { return reply.code(409).send({ success: false, error: "translation authorization changed or could not be saved; enable was not applied" }); }
    deps.service.forget(scope.id);
    deps.notifyAuthorizationChanged?.(scope.id);
    return status(scope.id, scope.owner);
  });
}
