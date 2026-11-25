import { promises as fs } from "node:fs";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ScienceHostOpenResult } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { registerScienceViewerRoutes } from "../routes/science-viewer-routes.js";

// A real HTTP connection, with the production 10s idle budget accelerated.
const CONNECTION_TIMEOUT_MS = 150;
const COLD_OPEN_MS = CONNECTION_TIMEOUT_MS * 3;
const OPEN_TIMEOUT_MS = 60_000;
const VIEW_PATH = "/api/res-workflow/science/view";
const principal = { iss: "fixture", sub: "alice" };
const ready = (): ScienceHostOpenResult => ({ availability: "ready", view: { subscribe: async () => ({ unsubscribe() {}, async input() {} }) } });
const apps: FastifyInstance[] = [];
const sockets = new Set<Socket>();
const agents: http.Agent[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const agent of agents.splice(0)) agent.destroy();
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const app of apps.splice(0)) await app.close();
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

interface Seen {
  raw: IncomingMessage;
  response: ServerResponse;
  socket: Socket;
  before: number | undefined;
  during?: number;
  afterFinish?: number;
  listeners: { finish: number; close: number; aborted: number };
}
async function fixture(options: { foreign?: boolean; expired?: boolean; priorTimeout?: number; slowAdmission?: boolean; workspace?: () => Promise<ScienceHostOpenResult> } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "science-http-timeout-fixture-")); dirs.push(cwd);
  const app = Fastify({ connectionTimeout: CONNECTION_TIMEOUT_MS, keepAliveTimeout: 3000 }); apps.push(app);
  let knownCwds = [cwd];
  const seen: Seen[] = [];
  const setTimeoutCalls = new Map<Socket, MockInstance<Socket["setTimeout"]>>();
  app.server.on("connection", socket => { sockets.add(socket); socket.once("close", () => { sockets.delete(socket); }); });
  app.addHook("onRequest", async request => {
    Object.assign(request, { principal, principalExpiresAt: options.expired ? Date.now() - 1 : undefined });
    if (options.priorTimeout !== undefined) request.raw.socket.setTimeout(options.priorTimeout);
  });
  app.addHook("onSend", async (request, _reply, payload) => {
    const row = seen.find(item => item.raw === request.raw);
    if (row) row.during = row.socket.timeout;
    return payload;
  });
  const openWorkspace = vi.fn(options.workspace ?? (async () => { await delay(COLD_OPEN_MS); return ready(); }));
  const openTask = vi.fn(async () => { await delay(COLD_OPEN_MS); return ready(); });
  registerScienceViewerRoutes(app, {
    networkGuard: async (request, reply) => {
      const socket = request.raw.socket;
      if (!setTimeoutCalls.has(socket)) setTimeoutCalls.set(socket, vi.spyOn(socket, "setTimeout"));
      const row: Seen = { raw: request.raw, response: reply.raw, socket, before: socket.timeout,
        listeners: { finish: reply.raw.listenerCount("finish"), close: reply.raw.listenerCount("close"), aborted: request.raw.listenerCount("aborted") } };
      seen.push(row);
      reply.raw.once("finish", () => { queueMicrotask(() => { row.afterFinish = socket.timeout; }); });
      row.listeners.finish = reply.raw.listenerCount("finish");
    },
    knownCwds: () => knownCwds,
    history: () => options.slowAdmission ? [] : [{ id: "fixture", cwd, principalOwner: options.foreign ? { iss: "fixture", sub: "bob" } : principal }],
    isResolverActive: () => true,
    ...(options.slowAdmission ? { hostPolicy: { hasPolicy: () => true, authorize: async () => { await delay(COLD_OPEN_MS); return false; } } } : {}),
    host: { openWorkspace, openTask },
    gateway: { registerHandler() {}, registerDisconnectHandler() {} },
  });
  app.get("/ordinary", async request => { const timeout = request.raw.socket.timeout; await delay(COLD_OPEN_MS); return { timeout }; });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const addr = app.server.address();
  if (!addr || typeof addr === "string") throw new Error("fixture-listen-failed");
  return { app, cwd, seen, setTimeoutCalls, openWorkspace, openTask, revoke: () => { knownCwds = []; }, port: addr.port, url: `http://127.0.0.1:${addr.port}`, body: { cwd, target: { kind: "workspace" } } };
}

function post(url: string, body: unknown, agent: http.Agent | false = false) {
  const encoded = JSON.stringify(body);
  let request!: http.ClientRequest;
  const response = new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    request = http.request(`${url}${VIEW_PATH}`, { method: "POST", agent, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(encoded) } }, res => {
      let text = "";
      res.setEncoding("utf8"); res.on("data", data => { text += data; });
      res.on("end", () => { try { resolve({ status: res.statusCode!, body: JSON.parse(text) }); } catch (error) { reject(error); } });
      res.on("error", reject);
    });
    request.on("error", reject); request.end(encoded);
  });
  return { response, request };
}

describe("Science view's finite HTTP open budget", () => {
  it("answers a cold authorized open after the ordinary connection timeout", async () => {
    const f = await fixture();
    const result = await post(f.url, f.body).response.catch((error: NodeJS.ErrnoException) => ({ transportError: error.code }));
    expect(result).toMatchObject({ status: 200, body: { availability: "ready" } });
    expect(f.openWorkspace).toHaveBeenCalledTimes(1);
    expect(f.seen[0]).toMatchObject({ before: CONNECTION_TIMEOUT_MS, during: OPEN_TIMEOUT_MS });
    expect(f.app.server.timeout).toBe(CONNECTION_TIMEOUT_MS);
    expect(f.setTimeoutCalls.get(f.seen[0].socket)!.mock.calls.some(([ms]) => ms === 0)).toBe(false);
  });

  it.each(["shape", "target", "cwd", "foreign", "expired"] as const)("keeps the original budget for a rejected %s request", async kind => {
    const f = await fixture({ foreign: kind === "foreign", expired: kind === "expired" });
    const body = kind === "shape" ? { ...f.body, url: "http://untrusted.invalid" } : kind === "target" ? { ...f.body, target: { kind: "navigate" } } : kind === "cwd" ? { ...f.body, cwd: "relative" } : f.body;
    const result = await post(f.url, body).response;
    expect(result.status).toBe(kind === "foreign" ? 404 : kind === "expired" ? 403 : 400);
    expect(f.openWorkspace).not.toHaveBeenCalled();
    expect(f.seen[0].during).toBe(CONNECTION_TIMEOUT_MS);
    expect(f.setTimeoutCalls.get(f.seen[0].socket)!.mock.calls.some(([ms]) => ms === OPEN_TIMEOUT_MS || ms === 0)).toBe(false);
  });

  it("does not extend an owner-policy check that has not authorized the request", async () => {
    const f = await fixture({ slowAdmission: true });
    await expect(post(f.url, f.body).response).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(f.openWorkspace).not.toHaveBeenCalled();
    expect(f.setTimeoutCalls.get(f.seen[0].socket)!.mock.calls.some(([ms]) => ms === OPEN_TIMEOUT_MS || ms === 0)).toBe(false);
  });

  it("keeps an unrelated slow route on the ordinary connection timeout", async () => {
    const f = await fixture();
    const response = new Promise((resolve, reject) => { const request = http.get(`${f.url}/ordinary`, { agent: false }, resolve); request.on("error", reject); });
    await expect(response).rejects.toMatchObject({ code: "ECONNRESET" });
    expect(f.app.server.timeout).toBe(CONNECTION_TIMEOUT_MS);
    expect(f.openWorkspace).not.toHaveBeenCalled();
  });

  it.each(["ready", "failure"] as const)("restores the exact prior timeout after a %s response finishes", async outcome => {
    const f = await fixture({ priorTimeout: 287, ...(outcome === "failure" ? { workspace: async () => { throw new Error("fixture-host-offline"); } } : {}) });
    const agent = new http.Agent({ keepAlive: true }); agents.push(agent);
    const result = await post(f.url, f.body, agent).response;
    expect(result.body.availability).toBe(outcome === "ready" ? "ready" : "unknown");
    await vi.waitFor(() => { expect(f.seen[0].afterFinish).toBe(287); });
    const row = f.seen[0];
    expect(row.socket.destroyed).toBe(false);
    expect(row.raw.listenerCount("aborted")).toBeLessThanOrEqual(row.listeners.aborted);
    expect(row.response.listenerCount("close")).toBeLessThanOrEqual(row.listeners.close);
    expect(row.response.listenerCount("finish")).toBeLessThanOrEqual(row.listeners.finish);
  });

  it("holds the shared socket budget until the last overlapping open finishes", async () => {
    const f = await fixture({ workspace: async () => { await delay(50); return ready(); } });
    const packet = (target: object) => {
      const body = JSON.stringify({ cwd: f.cwd, target });
      return `POST ${VIEW_PATH} HTTP/1.1\r\nHost: 127.0.0.1:${f.port}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: keep-alive\r\n\r\n${body}`;
    };
    const received = new Promise<string>((resolve, reject) => {
      const socket = net.createConnection({ port: f.port, host: "127.0.0.1" }); sockets.add(socket);
      let text = "";
      socket.on("error", reject);
      socket.on("end", () => { reject(new Error("fixture-pipeline-ended-before-both-responses")); });
      socket.on("data", data => { text += data.toString(); if ((text.match(/"availability":"ready"/g) ?? []).length === 2) resolve(text); });
      socket.once("connect", () => { socket.write(packet({ kind: "workspace" }) + packet({ kind: "task", taskId: "si-11111111-1111-4111-8111-111111111111" })); });
    });
    expect((await received).match(/HTTP\/1\.1 200 OK/g)).toHaveLength(2);
    expect(f.seen[0].socket).toBe(f.seen[1].socket);
    expect(f.seen[0].afterFinish).toBe(OPEN_TIMEOUT_MS);
    await vi.waitFor(() => { expect(f.seen[1].afterFinish).toBe(CONNECTION_TIMEOUT_MS); });
    expect(f.openWorkspace).toHaveBeenCalledTimes(1); expect(f.openTask).toHaveBeenCalledTimes(1);
  });

  it("restores the prior timeout when post-open authority revalidation denies the response", async () => {
    const f = await fixture({ priorTimeout: 287 });
    const agent = new http.Agent({ keepAlive: true }); agents.push(agent);
    const pending = post(f.url, f.body, agent).response;
    await vi.waitFor(() => { expect(f.openWorkspace).toHaveBeenCalledTimes(1); });
    f.revoke();
    expect(await pending).toMatchObject({ status: 404, body: { code: "workspace-not-found" } });
    await vi.waitFor(() => { expect(f.seen[0].afterFinish).toBe(287); });
  });

  it("cleans up an aborted response without touching its destroyed socket again", async () => {
    const f = await fixture();
    const pending = post(f.url, f.body);
    const result = pending.response.catch(error => error);
    await vi.waitFor(() => { expect(f.openWorkspace).toHaveBeenCalledTimes(1); });
    const row = f.seen[0], timeout = f.setTimeoutCalls.get(row.socket)!;
    expect(row.socket.timeout).toBe(OPEN_TIMEOUT_MS);
    const callsBeforeAbort = timeout.mock.calls.length;
    pending.request.destroy(); await result;
    await vi.waitFor(() => { expect(row.socket.destroyed).toBe(true); expect(row.response.destroyed).toBe(true); });
    expect(timeout).toHaveBeenCalledTimes(callsBeforeAbort);
    expect(row.raw.listenerCount("aborted")).toBeLessThanOrEqual(row.listeners.aborted);
    expect(row.response.listenerCount("close")).toBeLessThanOrEqual(row.listeners.close);
    expect(row.response.listenerCount("finish")).toBeLessThanOrEqual(row.listeners.finish);
    await delay(COLD_OPEN_MS);
    expect(timeout).toHaveBeenCalledTimes(callsBeforeAbort);
  });
});
