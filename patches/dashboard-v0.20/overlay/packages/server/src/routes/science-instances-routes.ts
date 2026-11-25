import { createHash } from "node:crypto";
import { isScienceArtifactId, isScienceInstanceId, projectScienceArtifact, projectScienceDetailResponse, projectScienceListResponse, projectScienceUnavailable, SCIENCE_RECORD_LIMITS, type ScienceArtifact, type ScienceArtifactReadResponse, type ScienceInstancesHost } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionPrincipalOf } from "../identity/session-access.js";
import { type ResWorkflowAccessDeps, resWorkflowAccess } from "../res-workflow/access.js";
import { ResWorkflowError } from "../res-workflow/adoption-service.js";
import type { NetworkGuard } from "./route-deps.js";

export interface ScienceInstancesRouteDeps extends ResWorkflowAccessDeps {
  networkGuard: NetworkGuard;
  /** Independent host connection supplied by trusted server configuration only. */
  host?: ScienceInstancesHost;
}
const UNCONFIGURED = { availability: "unavailable", reason: "host-unconfigured" } as const;
const OFFLINE = { availability: "unknown", reason: "host-offline" } as const;
const INVALID = { availability: "unknown", reason: "invalid-host-response" } as const;

async function boundedRead<T>(read: () => Promise<T>): Promise<T | typeof OFFLINE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(read), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("science-read-timeout")), 5000); timer.unref?.(); })]);
  } catch { return OFFLINE; }
  finally { if (timer) clearTimeout(timer); }
}
function privateHeaders(reply: FastifyReply) {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Cookie, Authorization");
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
}
function failure(reply: FastifyReply, error: unknown) {
  const safe = error instanceof ResWorkflowError ? error : new ResWorkflowError(503, "science-records-unavailable");
  reply.code(safe.statusCode);
  if (safe.code === "cwd-admission-unavailable") reply.header("Retry-After", "1");
  return { success: false, code: safe.code, error: safe.code };
}
const BINARY_PREFIXES = new Map<ScienceArtifact["mediaType"], Buffer>([
  ["image/png", Buffer.from("89504e470d0a1a0a", "hex")],
  ["image/jpeg", Buffer.from("ffd8ff", "hex")],
  ["application/pdf", Buffer.from("%PDF-", "ascii")],
]);
function matchesArtifactType(content: Buffer, mediaType: ScienceArtifact["mediaType"]): boolean {
  const prefix = BINARY_PREFIXES.get(mediaType);
  if (prefix) return content.subarray(0, prefix.byteLength).equals(prefix);
  try { new TextDecoder("utf-8", { fatal: true }).decode(content); return !content.includes(0); }
  catch { return false; }
}
function checkedArtifact(value: Extract<ScienceArtifactReadResponse, { availability: "ready" }>, artifactId: string) {
  const artifact = projectScienceArtifact(value.artifact);
  if (!artifact || artifact.id !== artifactId || !(value.content instanceof Uint8Array) || value.content.byteLength > SCIENCE_RECORD_LIMITS.artifactBytes || value.content.byteLength !== artifact.bytes) return null;
  const content = Buffer.from(value.content);
  return createHash("sha256").update(content).digest("hex") === artifact.sha256 && matchesArtifactType(content, artifact.mediaType) ? { artifact, content } : null;
}
function sendArtifact(reply: FastifyReply, artifact: ScienceArtifact, content: Buffer) {
  const encodedName = encodeURIComponent(artifact.name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  reply.header("Content-Disposition", `attachment; filename="${artifact.id}"; filename*=UTF-8''${encodedName}`);
  reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
  reply.header("X-Science-Artifact-Sha256", artifact.sha256);
  reply.header("Access-Control-Expose-Headers", "X-Science-Artifact-Sha256");
  reply.header("Content-Length", content.byteLength);
  return reply.type(artifact.mediaType).send(content);
}

/** Read-only projection; no task creation, approval, cancellation or filesystem path API. */
export function registerScienceInstancesRoutes(fastify: FastifyInstance, deps: ScienceInstancesRouteDeps) {
  const access = async (request: FastifyRequest) => {
    const query = request.query as Record<string, unknown>;
    if (!query || Object.keys(query).length !== 1 || !Object.hasOwn(query, "cwd") || request.body !== undefined) throw new ResWorkflowError(400, "invalid-science-read-request");
    return resWorkflowAccess(deps, { principal: sessionPrincipalOf(request), expiresAt: (request as FastifyRequest & { principalExpiresAt?: number }).principalExpiresAt, write: false }, query.cwd);
  };
  fastify.get("/api/res-workflow/science/instances", { preHandler: deps.networkGuard, exposeHeadRoute: false }, async (request, reply) => {
    privateHeaders(reply);
    try {
      const grant = await access(request); await grant.revalidate();
      if (!deps.host) return UNCONFIGURED;
      const value = await boundedRead(() => deps.host!.list({ ownerKey: grant.ownerKey, cwd: grant.cwd }));
      const result = projectScienceListResponse(value); await grant.revalidate(); return result;
    } catch (error) { return failure(reply, error); }
  });
  fastify.get("/api/res-workflow/science/instances/:taskId", { preHandler: deps.networkGuard, exposeHeadRoute: false }, async (request, reply) => {
    privateHeaders(reply);
    try {
      const { taskId } = request.params as { taskId: unknown };
      if (!isScienceInstanceId(taskId)) throw new ResWorkflowError(400, "invalid-science-task-id");
      const grant = await access(request); await grant.revalidate();
      if (!deps.host) return UNCONFIGURED;
      const value = await boundedRead(() => deps.host!.detail({ ownerKey: grant.ownerKey, cwd: grant.cwd }, taskId));
      const result = projectScienceDetailResponse(value);
      await grant.revalidate();
      return result.availability === "ready" && result.instance.id !== taskId ? INVALID : result;
    } catch (error) { return failure(reply, error); }
  });
  fastify.get("/api/res-workflow/science/instances/:taskId/artifacts/:artifactId", { preHandler: deps.networkGuard, exposeHeadRoute: false }, async (request, reply) => {
    privateHeaders(reply);
    try {
      const { taskId, artifactId } = request.params as { taskId: unknown; artifactId: unknown };
      if (!isScienceInstanceId(taskId) || !isScienceArtifactId(artifactId)) throw new ResWorkflowError(400, "invalid-science-artifact-id");
      const grant = await access(request); await grant.revalidate();
      if (!deps.host) { reply.code(503); return UNCONFIGURED; }
      const value = await boundedRead(() => deps.host!.readArtifact({ ownerKey: grant.ownerKey, cwd: grant.cwd }, taskId, artifactId));
      if (value?.availability !== "ready") { await grant.revalidate(); const result = projectScienceUnavailable(value); reply.code(result.reason === "binding-unavailable" ? 404 : 503); return result; }
      const checked = checkedArtifact(value, artifactId);
      if (!checked) { await grant.revalidate(); reply.code(503); return INVALID; }
      const { artifact, content } = checked;
      await grant.revalidate();
      return sendArtifact(reply, artifact, content);
    } catch (error) { return failure(reply, error); }
  });
}
