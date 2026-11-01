import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResWorkflowService } from "../res-workflow/adoption-service.js";
import { registerResWorkflowRoutes } from "../routes/res-workflow-routes.js";
import { LOCAL_OPERATOR } from "../identity/session-access.js";
import type { HostPolicy } from "../identity/host-access.js";

const apps: FastifyInstance[] = [];
const dirs: string[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); await Promise.all(dirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true }))); });
async function setup(options: { active?: boolean; principal?: { iss: string; sub: string }; sessionOwner?: { iss: string; sub: string }; policy?: HostPolicy } = {}) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "res-routes-")); dirs.push(cwd);
  let known = [cwd];
  const app = Fastify(); apps.push(app);
  if (options.principal) app.addHook("onRequest", async (request) => { (request as any).principal = options.principal; });
  const snapshot = vi.fn(async (access) => ({ cwd: access.cwd, adopted: false, research: { "state.json": null, "ledger.jsonl": null, "events.jsonl": null, "auto-run.json": null }, adoption: null }));
  const create = vi.fn(async (_access, request) => ({ id: "adopt-0123456789abcdef01234567", cwd, status: "inventory", requestId: request.requestId }));
  const service = { snapshot, create, connection: vi.fn(async access => ({ cwd: access.cwd, adopted: true })), historyCandidates: vi.fn(async () => ({ candidates: [], partial: false, skipped: [] })), joinParticipant: vi.fn(async (access, sessionId) => ({ sessionId, resWorkflow: { canonicalCwd: access.cwd, joinedAt: "2026-10-24T00:00:00Z", via: "manual" } })), models: vi.fn(async () => []), get: vi.fn(), analyze: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), source: vi.fn(), dispose: vi.fn() } as unknown as ResWorkflowService;
  let owner = options.sessionOwner;
  registerResWorkflowRoutes(app, { networkGuard: async () => {}, knownCwds: () => known, history: () => owner ? [{ id: "fixture-session", cwd, principalOwner: owner }] : [], historyRoots: () => [], researchLoopRoot: "/unused-fixture-backend", isResolverActive: () => options.active ?? false, hostPolicy: options.policy, service });
  return { app, cwd, snapshot, create, service, revoke: () => { known = []; }, transfer: () => { owner = { iss: "fixture-issuer", sub: "other-owner" }; } };
}

describe("res-workflow narrow routes", () => {
  it("serves connection/candidate metadata and a real-session association through the same guarded cwd", async () => {
    const f = await setup();
    for (const endpoint of ["connection", "history-candidates"]) {
      const reply = await f.app.inject({ method: "GET", url: `/api/res-workflow/${endpoint}?cwd=${encodeURIComponent(f.cwd)}` });
      expect(reply.statusCode).toBe(200);
      expect(JSON.stringify(reply.json())).not.toMatch(/sessionFile|content|ledger/);
    }
    const joined = await f.app.inject({ method: "POST", url: "/api/res-workflow/participants", payload: { cwd: f.cwd, sessionId: "real-session" } });
    expect(joined.statusCode).toBe(200);
    expect(joined.json()).toMatchObject({ sessionId: "real-session", resWorkflow: { canonicalCwd: f.cwd } });
    expect(f.create).not.toHaveBeenCalled(); expect(f.service.analyze).not.toHaveBeenCalled();
  });

  it("metadata/association endpoints do not bypass owner admission or accept a path rider", async () => {
    const f = await setup({ active: true, principal: { iss: "fixture", sub: "alice" }, sessionOwner: { iss: "fixture", sub: "bob" } });
    for (const endpoint of ["connection", "history-candidates"]) expect((await f.app.inject({ method: "GET", url: `/api/res-workflow/${endpoint}?cwd=${encodeURIComponent(f.cwd)}` })).statusCode).toBe(404);
    expect((await f.app.inject({ method: "POST", url: "/api/res-workflow/participants", payload: { cwd: f.cwd, sessionId: "foreign-session" } })).statusCode).toBe(404);
    expect(f.service.historyCandidates).not.toHaveBeenCalled(); expect(f.service.joinParticipant).not.toHaveBeenCalled();
    const own = await setup();
    expect((await own.app.inject({ method: "GET", url: `/api/res-workflow/history-candidates?cwd=${encodeURIComponent(own.cwd)}&path=/outside` })).statusCode).toBe(400);
    expect((await own.app.inject({ method: "POST", url: "/api/res-workflow/participants", payload: { cwd: own.cwd, sessionId: "real-session", path: "/outside" } })).statusCode).toBe(400);
  });
  it("validates and admits cwd before invoking even the narrow service", async () => {
    const f = await setup();
    expect((await f.app.inject({ method: "GET", url: "/api/res-workflow" })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "GET", url: "/api/res-workflow?cwd=relative" })).statusCode).toBe(400);
    const other = await fs.mkdtemp(path.join(os.tmpdir(), "res-denied-")); dirs.push(other);
    expect((await f.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(other)}` })).statusCode).toBe(403);
    expect(f.snapshot).not.toHaveBeenCalled();
  });

  it("an empty pinned directory can read a snapshot without requiring or starting any session", async () => {
    const f = await setup();
    const reply = await f.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(f.cwd)}` });
    expect(reply.statusCode).toBe(200); expect(reply.json().adopted).toBe(false);
    expect(f.create).not.toHaveBeenCalled();
    expect(await fs.readdir(f.cwd)).toEqual([]);
  });

  it("rechecks resolver identity after an asynchronous directory-policy decision", async () => {
    const options = { active: true, principal: { iss: "fixture", sub: "owner" }, policy: undefined as HostPolicy | undefined };
    options.policy = { hasPolicy: () => true, authorize: vi.fn(async () => { options.active = false; return true; }) };
    const f = await setup(options);
    const reply = await f.app.inject({ method: "GET", url: `/api/res-workflow/connection?cwd=${encodeURIComponent(f.cwd)}` });
    expect(reply.statusCode).toBe(403); expect(reply.json().code).toBe("adoption-identity-expired");
    expect(f.service.connection).not.toHaveBeenCalled();
  });

  it("rejects unbound principals and derives owner only from the authenticated request", async () => {
    const anonymous = await setup({ active: true });
    expect((await anonymous.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(anonymous.cwd)}` })).statusCode).toBe(404);
    const f = await setup({ active: true, principal: { iss: "fixture-issuer", sub: "owner-one" }, sessionOwner: { iss: "fixture-issuer", sub: "owner-one" } });
    const reply = await f.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(f.cwd)}` });
    expect(reply.statusCode).toBe(200);
    expect(f.snapshot.mock.calls[0][0].ownerKey).toContain("owner-one");
  });

  it("Alice cannot read or scan a directory known only through Bob's session", async () => {
    const f = await setup({ active: true, principal: { iss: "fixture-issuer", sub: "alice" }, sessionOwner: { iss: "fixture-issuer", sub: "bob" } });
    const get = await f.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(f.cwd)}` });
    const create = await f.app.inject({ method: "POST", url: "/api/res-workflow/adoptions", payload: { cwd: f.cwd, historySelection: [], requestId: "cross-owner-scan" } });
    expect(get.statusCode).toBe(404); expect(create.statusCode).toBe(404);
    expect(f.snapshot).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled();
  });

  it("every background batch loses access when its session owner changes", async () => {
    const f = await setup({ active: true, principal: { iss: "fixture-issuer", sub: "owner-one" }, sessionOwner: { iss: "fixture-issuer", sub: "owner-one" } });
    expect((await f.app.inject({ method: "POST", url: "/api/res-workflow/adoptions", payload: { cwd: f.cwd, historySelection: [], requestId: "owner-bound-scan" } })).statusCode).toBe(202);
    const access = f.create.mock.calls[0][0]; f.transfer();
    await expect(access.revalidate()).rejects.toMatchObject({ statusCode: 404 });
  });

  it("session-less pins require an existing explicit path policy or the local operator", async () => {
    const owner = { iss: "fixture-issuer", sub: "owner-one" };
    const ordinary = await setup({ active: true, principal: owner });
    expect((await ordinary.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(ordinary.cwd)}` })).statusCode).toBe(404);
    const operator = await setup({ active: true, principal: LOCAL_OPERATOR });
    expect((await operator.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(operator.cwd)}` })).statusCode).toBe(200);
    const authorize = vi.fn(async (input) => input.action === "workspace.read" && input.resource.kind === "workspace" && typeof input.resource.path === "string");
    const allowed = await setup({ active: true, principal: owner, policy: { hasPolicy: () => true, authorize } });
    expect((await allowed.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(allowed.cwd)}` })).statusCode).toBe(200);
    expect(authorize).toHaveBeenCalledWith(expect.objectContaining({ principal: owner, action: "workspace.read", resource: { kind: "workspace", path: allowed.cwd } }));
    expect((await allowed.app.inject({ method: "POST", url: "/api/res-workflow/adoptions", payload: { cwd: allowed.cwd, historySelection: [], requestId: "policy-denies-write" } })).statusCode).toBe(404);
  });

  it("rejects caller path/owner/endpoint escalation and revalidates admission for background batches", async () => {
    const f = await setup();
    expect((await f.app.inject({ method: "GET", url: `/api/res-workflow?cwd=${encodeURIComponent(f.cwd)}&path=/etc/passwd` })).statusCode).toBe(400);
    expect((await f.app.inject({ method: "POST", url: "/api/res-workflow/adoptions", payload: { cwd: f.cwd, historySelection: [], requestId: "fixture-request", ownerKey: "foreign" } })).statusCode).toBe(400);
    const reply = await f.app.inject({ method: "POST", url: "/api/res-workflow/adoptions", payload: { cwd: f.cwd, historySelection: [], requestId: "fixture-request" } });
    expect(reply.statusCode).toBe(202);
    const access = f.create.mock.calls[0][0]; f.revoke();
    await expect(access.revalidate()).rejects.toMatchObject({ statusCode: 403 });
  });
});
