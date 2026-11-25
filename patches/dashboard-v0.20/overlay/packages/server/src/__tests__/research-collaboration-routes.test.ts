import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionMeta, writeSessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import type { ResearchSessionProvenance } from "@blackbelt-technology/pi-dashboard-shared/research-session.js";
import { registerResWorkflowResearchSessionRoutes } from "../routes/res-workflow-research-session-routes.js";
import { createLocalCredentialVerifier } from "../auth/local-credential.js";
import { resWorkflowAccess } from "../res-workflow/access.js";
import { createResWorkflowParticipants, type ResWorkflowSpawnRef } from "../res-workflow/participants.js";
import { createMemorySessionManager } from "../session/memory-session-manager.js";
import { createSessionArchive } from "../session/session-archive.js";
import { createMetaPersistence } from "../persistence/meta-persistence.js";
import { createPendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";
import { createPendingPrincipalOwnerRegistry } from "../pending/pending-principal-owner-registry.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function write(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-collaboration-"));
  const cwd = path.join(root, "project"), privateDir = path.join(root, "private");
  fs.mkdirSync(cwd);
  const charter = { revision: 1, objective: "Synthetic route coordination", successCriteria: ["Preserve exact dispatch ancestry"] };
  const charterHash = `sha256:${digest(JSON.stringify(charter))}`;
  const ownerKey = JSON.stringify(["host", "inert-operator"]);
  const adoptionId = `adopt-${digest(cwd).slice(0, 24)}`;
  const confirmationHash = `sha256:${digest("synthetic-confirmation")}`;
  const scope = path.join(privateDir, digest(ownerKey), digest(cwd));
  write(path.join(cwd, ".pi/research-loop/state.json"), { schema: "pi-research-state.v1", stage: "2-experiment", charter, claims: [] });
  write(path.join(scope, "adopted.json"), { confirmed: true, id: adoptionId, confirmationHash });
  write(path.join(scope, `${adoptionId}.json`), { schema: "pi-res-workflow-operation.v1", ownerKey, cwd, adoption: { id: adoptionId, cwd, status: "confirmed" } });
  write(path.join(cwd, ".pi/research-loop/adoptions", adoptionId, "confirmation.json"), { schema: "pi-research-adoption-confirmation.v1", adoptionId, confirmationHash, charterHash, autoRun: false });

  const sessionManager = createMemorySessionManager();
  const metaPersistence = createMetaPersistence();
  const archive = createSessionArchive({ sessionManager, metaPersistence, getPinnedDirs: () => [] });
  const registry = createPendingPluginRefRegistry({ warn: () => {} });
  const accessDeps = { knownCwds: () => [cwd], history: () => [...sessionManager.listAll(), ...archive.rows()], isResolverActive: () => false };
  const connection = async () => ({ cwd, adopted: true });
  const accessFor = (target: string, identity: Parameters<typeof resWorkflowAccess>[1]) => resWorkflowAccess(accessDeps, identity, target);
  const participants = createResWorkflowParticipants({ sessionManager, sessionArchive: archive, registry, metaPersistence,
    accessFor, connection, isResolverActive: () => false, broadcast: () => {} });
  function register(id: string, researchSession?: ResearchSessionProvenance) {
    const sessionFile = path.join(root, "sessions", `${id}.jsonl`);
    const resWorkflow = { canonicalCwd: cwd, joinedAt: new Date().toISOString(), via: "manual" as const };
    write(sessionFile, { type: "session", id, cwd });
    writeSessionMeta(sessionFile, { cwd, pluginRefs: { "res-workflow": { resWorkflow, ...(researchSession ? { researchSession } : {}) } }, ...(researchSession ? { researchSession } : {}) });
    sessionManager.register({ id, cwd, source: "dashboard", sessionFile });
    sessionManager.update(id, { name: id, status: "idle", sessionFile, resWorkflow, ...(researchSession ? { researchSession } : {}) });
    return sessionFile;
  }
  register("main-a"); register("main-b");
  const app = Fastify();
  const token = randomUUID();
  const verifier = createLocalCredentialVerifier({ token, acceptLegacyToken: true, log: () => {} });
  app.addHook("onRequest", async request => { verifier.stamp(request.raw, { kind: "http", boundAt: 0 }); });
  const spawn = vi.fn(async (_target: string, options: { spawnToken: string }) => {
    const filed = registry.resolve(options.spawnToken);
    if (!filed) throw new Error("synthetic-ref-not-filed");
    const ref = filed.ref as unknown as ResWorkflowSpawnRef;
    const id = `worker-${spawn.mock.calls.length}`;
    const sessionFile = register(id, ref.researchSession);
    await participants.registerSpawn(id, { cwd, sessionFile }, ref);
    return { success: true, spawnToken: options.spawnToken, message: "Synthetic session registered" };
  });
  const collaboration = registerResWorkflowResearchSessionRoutes(app, {
    networkGuard: async () => {}, sessionManager, history: accessDeps.history, accessFor, connection,
    joinParticipant: (access, id) => participants.join(access, id, "manual"),
    detachParticipant: participants.detach,
    prepareSpawn: participants.prepareSpawn, pendingPluginRefRegistry: registry,
    pendingPrincipalOwnerRegistry: createPendingPrincipalOwnerRegistry(),
    initialPrompts: { enqueue: () => true, remove: () => true }, spawn,
    isResolverActive: () => false, privateDir,
    researchLoopRoot: process.env.PI_RESEARCH_LOOP_ROOT ?? fileURLToPath(new URL("../../../../../../extensions/research-loop", import.meta.url)),
  });
  participants.setParticipationGuard(collaboration.assertParticipationAllowed);
  cleanups.push(async () => { await app.close(); metaPersistence.flushAll(); fs.rmSync(root, { recursive: true, force: true }); });
  const snapshot = async () => {
    const reply = await app.inject({ method: "GET", url: `/api/res-workflow/collaboration?cwd=${encodeURIComponent(cwd)}` });
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json();
  };
  const mutate = async (body: Record<string, unknown>) => {
    const state = await snapshot();
    const reply = await app.inject({ method: "POST", url: "/api/res-workflow/collaboration", payload: { cwd, expectedRevision: state.revision, ...body } });
    expect(reply.statusCode, reply.body).toBe(200);
    return reply.json();
  };
  const native = (body: Record<string, unknown>, headers: Record<string, string> = { "x-pi-local-token": token }) =>
    app.inject({ method: "POST", url: "/api/res-workflow/collaboration/native", remoteAddress: "127.0.0.1", headers, payload: body });
  return { cwd, app, snapshot, mutate, native, register, spawn, participants, accessFor, sessionManager, archive, collaboration, token, charterHash, adoptionId };
}

describe("Dashboard managed collaboration route integration", () => {
  it("keeps separate main tenures and detaches the chosen old tree while preserving its current main and transcript", async () => {
    const f = fixture();
    const initial = await f.snapshot();
    expect(initial.limits).toEqual({ maxMultiAgents: 4, maxSubagents: 3 });
    let state = await f.mutate({ action: "select-main", sessionId: "main-a" });
    const stale = await f.app.inject({ method: "POST", url: "/api/res-workflow/collaboration", payload: {
      cwd: f.cwd, action: "limits", expectedRevision: initial.revision, maxMultiAgents: 1, maxSubagents: 1,
    } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe("research-collaboration-revision-conflict");
    const firstTenure = state.currentTenureId;
    const provenance: ResearchSessionProvenance = {
      schema: "pi-research-session.v1", parentSessionId: "main-a", creatorSessionId: "main-a", creatorAgent: "research_session",
      role: "research-worker", task: "Synthetic assignment", stage: "2-experiment", workflowCwd: f.cwd,
      charterHash: f.charterHash, adoptionId: f.adoptionId, spawnToken: "synthetic-child-token", createdAt: new Date().toISOString(),
      tenureId: firstTenure, origin: "research_session", relation: "dispatch",
    };
    const childFile = f.register("old-child", provenance);
    const transcript = fs.readFileSync(childFile, "utf8");
    state = await f.snapshot();
    expect(state.tenures[0].sessionIds).toEqual(["main-a", "old-child"]);
    expect(state.tenures[0].snapshots["old-child"].parentSessionId).toBe("main-a");
    await f.mutate({ action: "select-main", sessionId: "main-b" });
    state = await f.mutate({ action: "select-main", sessionId: "main-a" });
    expect(state.tenures.map((row: { status: string }) => row.status)).toEqual(["historical", "historical", "current"]);
    const currentTenure = state.currentTenureId;
    state = await f.mutate({ action: "detach", sessionId: "main-a", tenureId: firstTenure });
    expect(state.currentTenureId).toBe(currentTenure);
    expect(state.currentMainSessionId).toBe("main-a");
    expect(state.tenures[0].status).toBe("removed");
    expect(state.tenures[0].detachedSessionIds).toEqual(["main-a", "old-child"]);
    expect(f.sessionManager.get("main-a")?.resWorkflow?.canonicalCwd).toBe(f.cwd);
    expect(f.sessionManager.get("old-child")?.resWorkflow).toBeNull();
    expect(readSessionMeta(childFile)?.pluginRefs?.["res-workflow"]?.researchSession).toEqual(provenance);
    expect(fs.readFileSync(childFile, "utf8")).toBe(transcript);
    expect(() => f.collaboration.assertParticipationAllowed({ cwd: f.cwd, sessionId: "late-child", via: "spawn", researchSession: { ...provenance, parentSessionId: "old-child" } })).toThrow("research-collaboration-session-detached");
  });

  it("applies the saved Multi-Agent limit to real queued dispatches and automatically admits the next worker", async () => {
    const f = fixture();
    await f.mutate({ action: "select-main", sessionId: "main-a" });
    await f.mutate({ action: "limits", maxMultiAgents: 1, maxSubagents: 1 });
    const reply = await f.app.inject({ method: "POST", url: "/api/res-workflow/dispatch", payload: {
      sessionId: "main-a", action: "plan", planId: "synthetic-queue", concurrency: 3,
      tasks: ["one", "two", "three"].map(id => ({ id, role: "research-worker", task: `Synthetic task ${id}`, stage: "2-experiment" })),
    } });
    expect(reply.statusCode, reply.body).toBe(200);
    let state = await f.snapshot();
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(state.plans[0].tasks.map((row: { status: string }) => row.status)).toEqual(["running", "queued", "queued"]);
    expect(state.tenures[0].sessionIds).toContain("worker-1");
    state = await f.mutate({ action: "limits", maxMultiAgents: 2, maxSubagents: 1 });
    expect(f.spawn).toHaveBeenCalledTimes(2);
    expect(state.plans[0].tasks.map((row: { status: string }) => row.status)).toEqual(["running", "running", "queued"]);
    expect(f.sessionManager.get("worker-2")?.researchSession?.tenureId).toBe(state.currentTenureId);
  });

  it("uses one native lease pool and rejects relayed or unverified local requests", async () => {
    const f = fixture();
    await f.mutate({ action: "select-main", sessionId: "main-a" });
    await f.mutate({ action: "limits", maxMultiAgents: 2, maxSubagents: 1 });
    const body = { sessionId: "main-a", action: "subagent-acquire", requestId: "first-native", attemptId: "first-attempt" };
    expect((await f.native(body, {})).statusCode).toBe(403);
    expect((await f.native(body, { "x-pi-local-token": f.token, "x-forwarded-for": "192.0.2.1" })).statusCode).toBe(403);
    const first = await f.native(body);
    expect(first.statusCode, first.body).toBe(200);
    expect(first.json().status).toBe("acquired");
    const secondBody = { ...body, requestId: "second-native", attemptId: "second-attempt" };
    const second = await f.native(secondBody);
    expect(second.statusCode, second.body).toBe(200);
    expect(second.json().status).toBe("queued");
    expect((await f.snapshot()).nativeQueue.map((row: { status: string }) => row.status)).toEqual(["launching", "queued"]);
    const released = await f.native({ ...body, action: "subagent-release", leaseToken: first.json().leaseToken });
    expect(released.statusCode, released.body).toBe(200);
    expect((await f.native(secondBody)).json().status).toBe("acquired");
  });

  it("releases an existing native lease after its parent is archived", async () => {
    const f = fixture();
    await f.mutate({ action: "select-main", sessionId: "main-a" });
    const body = { sessionId: "main-a", action: "subagent-acquire", requestId: "archived-native", attemptId: "archived-attempt" };
    const acquired = await f.native(body);
    expect(acquired.statusCode, acquired.body).toBe(200);
    expect(acquired.json().status).toBe("acquired");
    f.sessionManager.update("main-a", { status: "ended", live: false });
    expect(f.archive.archiveSession("main-a", "manual").ok).toBe(true);
    expect(f.sessionManager.get("main-a")).toBeUndefined();
    expect((await f.native({ ...body, requestId: "new-archived-native", attemptId: "new-archived-attempt" })).statusCode).toBe(404);
    expect((await f.native({ ...body, action: "subagent-heartbeat", phase: "launching", leaseToken: acquired.json().leaseToken })).statusCode).toBe(404);
    const heartbeat = await f.native({ ...body, action: "subagent-heartbeat", phase: "running", leaseToken: acquired.json().leaseToken });
    expect(heartbeat.statusCode, heartbeat.body).toBe(200);
    const released = await f.native({ ...body, action: "subagent-release", leaseToken: acquired.json().leaseToken });
    expect(released.statusCode, released.body).toBe(200);
    expect(released.json().status).toBe("released");
    expect((await f.snapshot()).nativeQueue[0].status).toBe("released");
  });

  it("removes a frozen historical child after its row leaves the registry", async () => {
    const f = fixture();
    let state = await f.mutate({ action: "select-main", sessionId: "main-a" });
    const firstTenure = state.currentTenureId;
    const provenance: ResearchSessionProvenance = {
      schema: "pi-research-session.v1", parentSessionId: "main-a", creatorSessionId: "main-a", creatorAgent: "research_session",
      role: "research-worker", task: "Synthetic lost-history assignment", stage: "2-experiment", workflowCwd: f.cwd,
      charterHash: f.charterHash, adoptionId: f.adoptionId, spawnToken: "synthetic-missing-token", createdAt: new Date().toISOString(),
      tenureId: firstTenure, origin: "research_session", relation: "dispatch",
    };
    const childFile = f.register("missing-child", provenance);
    const descendantFile = f.register("missing-grandchild", { ...provenance, parentSessionId: "missing-child", creatorSessionId: "missing-child", spawnToken: randomUUID() });
    const original = [childFile, descendantFile].map(file => fs.readFileSync(file, "utf8"));
    await f.mutate({ action: "select-main", sessionId: "main-b" });
    f.sessionManager.remove("missing-child");
    f.sessionManager.remove("missing-grandchild");
    state = await f.mutate({ action: "detach", sessionId: "missing-child", tenureId: firstTenure });
    expect(state.currentMainSessionId).toBe("main-b");
    expect(state.tenures[0].detachedSessionIds).toEqual(["missing-child", "missing-grandchild"]);
    expect([childFile, descendantFile].map(file => fs.readFileSync(file, "utf8"))).toEqual(original);
  });
});
