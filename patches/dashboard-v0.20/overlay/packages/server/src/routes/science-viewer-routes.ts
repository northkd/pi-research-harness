import type { Socket } from "node:net";
import { isScienceViewTarget, type ScienceViewHost } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { sessionPrincipalOf } from "../identity/session-access.js";
import { resWorkflowAccess, type ResWorkflowAccessDeps } from "../res-workflow/access.js";
import { ResWorkflowError } from "../res-workflow/adoption-service.js";
import { SCIENCE_HOST_OPEN_DEADLINE_MS } from "../res-workflow/science-host-client.js";
import { createScienceViewer, type ScienceViewerSocket } from "../res-workflow/science-viewer.js";
import type { NetworkGuard } from "./route-deps.js";

const openingSockets = new WeakMap<Socket, { previousTimeout: number; pending: number }>();

/** Borrow the existing finite host-open budget only after HTTP authorization. */
function holdOpenTimeout(request: FastifyRequest, reply: FastifyReply): void {
  const socket = request.raw.socket;
  if (!socket || socket.destroyed || typeof socket.setTimeout !== "function") return;
  let state = openingSockets.get(socket);
  if (!state) {
    state = { previousTimeout: socket.timeout ?? 0, pending: 0 };
    openingSockets.set(socket, state);
  }
  state.pending++;
  socket.setTimeout(Math.max(state.previousTimeout, SCIENCE_HOST_OPEN_DEADLINE_MS));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    request.raw.removeListener("aborted", release);
    reply.raw.removeListener("finish", release);
    reply.raw.removeListener("close", release);
    if (--state.pending === 0) {
      openingSockets.delete(socket);
      if (!socket.destroyed) socket.setTimeout(state.previousTimeout);
    }
  };
  request.raw.once("aborted", release);
  reply.raw.once("finish", release);
  reply.raw.once("close", release);
}

export interface ScienceViewerRouteDeps extends ResWorkflowAccessDeps {
  networkGuard: NetworkGuard;
  /** Host-owned injected private connection. Never derived from client/project configuration. */
  host?: ScienceViewHost;
  gateway: {
    registerHandler(type: string, handler: (message: unknown, socket: ScienceViewerSocket) => void): void;
    registerDisconnectHandler(handler: (socket: ScienceViewerSocket) => void): void;
  };
}
export function registerScienceViewerRoutes(fastify: FastifyInstance, deps: ScienceViewerRouteDeps) {
  const viewer = createScienceViewer({ host: deps.host, socketAccess: (socket, cwd, write) => resWorkflowAccess(deps, {
    principal: socket.principal, expiresAt: socket.principalExpiresAt, write,
  }, cwd) });
  fastify.addHook("onClose", async () => { viewer.dispose(); });
  for (const type of ["science_view_subscribe", "science_view_unsubscribe", "science_view_input"]) deps.gateway.registerHandler(type, (message, socket) => viewer.handleMessage(message, socket));
  deps.gateway.registerDisconnectHandler(viewer.disconnect);
  fastify.post("/api/res-workflow/science/view", { preHandler: deps.networkGuard }, async (request, reply) => {
    const value = request.body;
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["cwd", "target"].includes(key)) || Object.keys(request.query as object).length > 0 || !isScienceViewTarget((value as Record<string, unknown>).target)) {
      reply.code(400); return { success: false, code: "invalid-science-view-request", error: "invalid-science-view-request" };
    }
    const body = value as Record<string, unknown>;
    try {
      const access = await resWorkflowAccess(deps, { principal: sessionPrincipalOf(request), expiresAt: (request as FastifyRequest & { principalExpiresAt?: number }).principalExpiresAt, write: false }, body.cwd);
      holdOpenTimeout(request, reply);
      return await viewer.open(access, body.target as Parameters<typeof viewer.open>[1]);
    } catch (error) {
      const failure = error instanceof ResWorkflowError ? error : new ResWorkflowError(503, "science-view-unavailable");
      reply.code(failure.statusCode);
      if (failure.code === "cwd-admission-unavailable") reply.header("Retry-After", "1");
      return { success: false, error: failure.code, code: failure.code };
    }
  });
  return viewer;
}
