import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { ResearchSessionProvenance } from "@blackbelt-technology/pi-dashboard-shared/research-session.js";
import { writeSessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { createResearchChildAutoRetire } from "../res-workflow/research-child-auto-retire.js";
import { registerResWorkflowResearchSessionRoutes } from "../routes/res-workflow-research-session-routes.js";
import { createLocalCredentialVerifier } from "../auth/local-credential.js";
import { resWorkflowAccess } from "../res-workflow/access.js";
import { createResWorkflowParticipants, type ResWorkflowSpawnRef } from "../res-workflow/participants.js";
import { createMemorySessionManager } from "../session/memory-session-manager.js";
import { createSessionArchive } from "../session/session-archive.js";
import { createMetaPersistence } from "../persistence/meta-persistence.js";
import { createPendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";
import { createPendingPrincipalOwnerRegistry } from "../pending/pending-principal-owner-registry.js";

function makeSession(overrides: Partial<DashboardSession> & { id: string }): DashboardSession {
  return {
    cwd: "/tmp/project",
    name: overrides.id,
    source: "dashboard",
    status: "idle",
    model: "claude-sonnet",
    thinkingLevel: "off",
    startedAt: 1_000,
    tokensIn: 0,
    tokensOut: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    pid: 4242,
    pidRecordedAt: 1_000,
    pendingQueues: { steering: [], followUp: [] },
    ...overrides,
  } as DashboardSession;
}

function makeProvenance(overrides: Partial<ResearchSessionProvenance> = {}): ResearchSessionProvenance {
  return {
    schema: "pi-research-session.v1",
    parentSessionId: "main-1",
    creatorSessionId: "main-1",
    creatorAgent: "research_session",
    role: "research-worker",
    task: "Run targeted check",
    stage: "2-experiment",
    workflowCwd: "/tmp/project",
    charterHash: "sha256:" + "a".repeat(64),
    adoptionId: "adopt-" + "b".repeat(24),
    spawnToken: "tok-worker-1",
    createdAt: new Date(1_000).toISOString(),
    origin: "research_session",
    relation: "dispatch",
    ...overrides,
  };
}

describe("createResearchChildAutoRetire", () => {
  it("retires a completed idle Multi-Agent child after the settle grace window and unregisters if still alive", async () => {
    let clock = 10_000;
    const child = makeSession({ id: "worker-1", pid: 9001, researchSession: makeProvenance() });
    const main = makeSession({ id: "main-1", pid: 9000 });
    const sessions = new Map<string, DashboardSession>([
      [main.id, main],
      [child.id, child],
    ]);

    const markManualClose = vi.fn();
    const sendShutdownHint = vi.fn(() => true);
    const terminate = vi.fn(async () => ({ outcome: "confirmed-dead" as const, terminated: true, pid: 9001 }));
    const unregisterIfAlive = vi.fn((id: string) => {
      const rec = sessions.get(id);
      if (rec) rec.status = "ended";
    });

    const retire = createResearchChildAutoRetire({
      listSessions: () => [...sessions.values()],
      getSession: (id) => sessions.get(id),
      isSessionCompleted: (token) => token === "tok-worker-1",
      completedAt: () => 5_000,
      isCurrentMainSession: (id) => id === "main-1",
      hasActiveChildren: () => false,
      hasOpenRequests: () => false,
      hasPendingUiRequest: () => false,
      hasPendingPromptRequests: () => false,
      hasSubscriber: () => false,
      markManualClose,
      sendShutdownHint,
      terminate,
      unregisterIfAlive,
      signalZero: () => "esrch",
      settleGraceMs: 8_000,
      shutdownGraceMs: 1_000,
      pollIntervalMs: 10,
      now: () => clock,
      sleep: async () => { clock += 50; },
      log: () => {},
      warn: () => {},
    });

    // First sweep arms the settle timer; must not retire yet.
    await retire.sweep();
    expect(sendShutdownHint).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();

    // Still inside the 8s grace window.
    clock += 7_500;
    await retire.sweep();
    expect(terminate).not.toHaveBeenCalled();

    // Grace window elapsed → graceful shutdown hint + terminate + fallback unregister.
    clock += 1_000;
    await retire.sweep();
    expect(markManualClose).toHaveBeenCalledWith("worker-1");
    expect(sendShutdownHint).toHaveBeenCalledWith("worker-1");
    expect(terminate).toHaveBeenCalledWith("worker-1", {
      graceMs: 0,
      verifyIdentity: true,
      stampManualClose: true,
    });
    expect(unregisterIfAlive).toHaveBeenCalledWith("worker-1");
    expect(child.status).toBe("ended");

    // Main Agent must never be touched.
    expect(terminate).not.toHaveBeenCalledWith("main-1", expect.anything());
    retire.dispose();
  });

  it("resets the settle timer if the worker resumes streaming or receives queued prompts before grace elapses", async () => {
    let clock = 10_000;
    const child = makeSession({ id: "worker-1", researchSession: makeProvenance() });
    const terminate = vi.fn(async () => ({ outcome: "confirmed-dead" as const, terminated: true, pid: 4242 }));

    const retire = createResearchChildAutoRetire({
      listSessions: () => [child],
      getSession: (id) => (id === child.id ? child : undefined),
      isSessionCompleted: () => true,
      isCurrentMainSession: () => false,
      hasActiveChildren: () => false,
      hasOpenRequests: () => false,
      hasPendingUiRequest: () => false,
      hasPendingPromptRequests: () => false,
      sendShutdownHint: () => true,
      terminate,
      signalZero: () => "esrch",
      settleGraceMs: 5_000,
      shutdownGraceMs: 0,
      now: () => clock,
      log: () => {},
      warn: () => {},
    });

    await retire.sweep();
    clock += 3_000;
    child.status = "streaming";
    await retire.sweep();

    // Back to idle at t=13_000 → timer restarts, must wait another 5s.
    child.status = "idle";
    await retire.sweep();
    clock += 4_000;
    await retire.sweep();
    expect(terminate).not.toHaveBeenCalled();

    clock += 1_500;
    await retire.sweep();
    expect(terminate).toHaveBeenCalledTimes(1);
    retire.dispose();
  });

  it("never retires a promoted Main Agent, incomplete child, child with active descendants/requests/asks, or manually resumed subscribed chat", async () => {
    const clock = 100_000;
    const completedAt = 20_000;
    const promotedMain = makeSession({
      id: "promoted-main",
      researchSession: makeProvenance({ spawnToken: "tok-promoted" }),
    });
    const incomplete = makeSession({
      id: "worker-incomplete",
      researchSession: makeProvenance({ spawnToken: "tok-incomplete" }),
    });
    const withSubagent = makeSession({
      id: "worker-subagent",
      researchSession: makeProvenance({ spawnToken: "tok-subagent" }),
    });
    const withLiveChild = makeSession({
      id: "worker-parent",
      researchSession: makeProvenance({ spawnToken: "tok-parent" }),
    });
    const liveGrandchild = makeSession({
      id: "grandchild-1",
      status: "streaming",
      researchSession: makeProvenance({ parentSessionId: "worker-parent", spawnToken: "tok-grandchild" }),
    });
    const withOpenReq = makeSession({
      id: "worker-req",
      researchSession: makeProvenance({ spawnToken: "tok-req" }),
    });
    const withPendingAsk = makeSession({
      id: "worker-ask",
      researchSession: makeProvenance({ spawnToken: "tok-ask" }),
    });
    const reactivated = makeSession({
      id: "worker-reactivated",
      researchSession: makeProvenance({ spawnToken: "tok-reactivated" }),
    });
    const manuallyResumed = makeSession({
      id: "worker-resumed",
      pidRecordedAt: completedAt + 30_000,
      researchSession: makeProvenance({ spawnToken: "tok-resumed" }),
    });

    const all = [
      promotedMain,
      incomplete,
      withSubagent,
      withLiveChild,
      liveGrandchild,
      withOpenReq,
      withPendingAsk,
      reactivated,
      manuallyResumed,
    ];
    const byId = new Map(all.map((s) => [s.id, s]));
    const terminate = vi.fn(async () => ({ outcome: "confirmed-dead" as const, terminated: true }));

    const retire = createResearchChildAutoRetire({
      listSessions: () => all,
      getSession: (id) => byId.get(id),
      isSessionCompleted: (token) => token !== "tok-incomplete" && token !== "tok-grandchild",
      completedAt: () => completedAt,
      isCurrentMainSession: (id) => id === "promoted-main",
      hasActiveChildren: (id) => id === "worker-subagent",
      hasOpenRequests: (id) => id === "worker-req",
      hasReactivatedReservation: (token) => token === "tok-reactivated",
      hasPendingUiRequest: (id) => id === "worker-ask",
      hasPendingPromptRequests: () => false,
      hasSubscriber: (id) => id === "worker-resumed",
      sendShutdownHint: () => true,
      terminate,
      settleGraceMs: 0,
      shutdownGraceMs: 0,
      now: () => clock,
      log: () => {},
      warn: () => {},
    });

    await retire.sweep();
    expect(terminate).not.toHaveBeenCalled();

    // Once the user closes the manually resumed session pane, it becomes eligible.
    let resumedHasSub = true;
    const retire2 = createResearchChildAutoRetire({
      listSessions: () => [manuallyResumed],
      getSession: (id) => (id === manuallyResumed.id ? manuallyResumed : undefined),
      isSessionCompleted: () => true,
      completedAt: () => completedAt,
      isCurrentMainSession: () => false,
      hasActiveChildren: () => false,
      hasOpenRequests: () => false,
      hasPendingUiRequest: () => false,
      hasPendingPromptRequests: () => false,
      hasSubscriber: () => resumedHasSub,
      sendShutdownHint: () => true,
      terminate,
      settleGraceMs: 0,
      shutdownGraceMs: 0,
      now: () => clock,
      log: () => {},
      warn: () => {},
    });

    await retire2.sweep();
    expect(terminate).not.toHaveBeenCalled();

    resumedHasSub = false;
    await retire2.sweep();
    expect(terminate).toHaveBeenCalledWith("worker-resumed", expect.objectContaining({ verifyIdentity: true }));
    retire.dispose();
    retire2.dispose();
  });

  it("waits briefly for graceful Pi exit after sending shutdown hint before calling terminate", async () => {
    let clock = 1_000;
    let pidAlive = true;
    const child = makeSession({ id: "worker-grace", pid: 7777, researchSession: makeProvenance() });
    const events: string[] = [];

    const retire = createResearchChildAutoRetire({
      listSessions: () => [child],
      getSession: () => child,
      isSessionCompleted: () => true,
      isCurrentMainSession: () => false,
      hasActiveChildren: () => false,
      hasOpenRequests: () => false,
      hasPendingUiRequest: () => false,
      hasPendingPromptRequests: () => false,
      sendShutdownHint: () => {
        events.push("shutdown-hint");
        return true;
      },
      terminate: async () => {
        events.push(pidAlive ? "terminate-while-alive" : "terminate-after-clean-exit");
        return { outcome: "confirmed-dead", terminated: true, pid: 7777 };
      },
      signalZero: () => (pidAlive ? "alive" : "esrch"),
      settleGraceMs: 0,
      shutdownGraceMs: 1_000,
      pollIntervalMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (clock >= 1_200) {
          child.status = "ended";
          pidAlive = false;
        }
      },
      log: () => {},
      warn: () => {},
    });

    await retire.sweep();
    expect(events).toEqual(["shutdown-hint", "terminate-after-clean-exit"]);
    retire.dispose();
  });
});

describe("res-workflow route integration for Multi-Agent auto-retirement", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0)) await fn();
  });

  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, JSON.stringify(value) + "\n", { mode: 0o600 });
  };

  it("automatically retires a dispatched Multi-Agent worker after it reports completion while keeping its transcript and ended history", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-auto-retire-"));
    const cwd = path.join(root, "project");
    const privateDir = path.join(root, "private");
    fs.mkdirSync(cwd);
    const charter = { revision: 1, objective: "Auto retire integration", successCriteria: ["Free memory on completion"] };
    const charterHash = `sha256:${digest(JSON.stringify(charter))}`;
    const ownerKey = JSON.stringify(["host", "inert-operator"]);
    const adoptionId = `adopt-${digest(cwd).slice(0, 24)}`;
    const confirmationHash = `sha256:${digest("confirm-auto-retire")}`;
    const scope = path.join(privateDir, digest(ownerKey), digest(cwd));
    writeJson(path.join(cwd, ".pi/research-loop/state.json"), { schema: "pi-research-state.v1", stage: "2-experiment", charter, claims: [] });
    writeJson(path.join(scope, "adopted.json"), { confirmed: true, id: adoptionId, confirmationHash });
    writeJson(path.join(scope, `${adoptionId}.json`), { schema: "pi-res-workflow-operation.v1", ownerKey, cwd, adoption: { id: adoptionId, cwd, status: "confirmed" } });
    writeJson(path.join(cwd, ".pi/research-loop/adoptions", adoptionId, "confirmation.json"), { schema: "pi-research-adoption-confirmation.v1", adoptionId, confirmationHash, charterHash, autoRun: false });

    const sessionManager = createMemorySessionManager();
    const metaPersistence = createMetaPersistence();
    const archive = createSessionArchive({ sessionManager, metaPersistence, getPinnedDirs: () => [] });
    const registry = createPendingPluginRefRegistry({ warn: () => {} });
    const accessDeps = { knownCwds: () => [cwd], history: () => [...sessionManager.listAll(), ...archive.rows()], isResolverActive: () => false };
    const connection = async () => ({ cwd, adopted: true });
    const accessFor = (target: string, identity: Parameters<typeof resWorkflowAccess>[1]) => resWorkflowAccess(accessDeps, identity, target);
    const participants = createResWorkflowParticipants({
      sessionManager, sessionArchive: archive, registry, metaPersistence,
      accessFor, connection, isResolverActive: () => false, broadcast: () => {},
    });

    function register(id: string, researchSession?: ResearchSessionProvenance) {
      const sessionFile = path.join(root, "sessions", `${id}.jsonl`);
      const resWorkflow = { canonicalCwd: cwd, joinedAt: new Date().toISOString(), via: "manual" as const };
      writeJson(sessionFile, { type: "session", id, cwd });
      writeSessionMeta(sessionFile, { cwd, pluginRefs: { "res-workflow": { resWorkflow, ...(researchSession ? { researchSession } : {}) } }, ...(researchSession ? { researchSession } : {}) });
      sessionManager.register({ id, cwd, source: "dashboard", sessionFile, pid: id === "main-1" ? 5000 : 5001 });
      sessionManager.update(id, { name: id, status: "idle", sessionFile, resWorkflow, ...(researchSession ? { researchSession } : {}) });
      return sessionFile;
    }

    register("main-1");
    const app = Fastify();
    const token = "synthetic-local-token";
    const verifier = createLocalCredentialVerifier({ token, acceptLegacyToken: true, log: () => {} });
    app.addHook("onRequest", async (req) => { verifier.stamp(req.raw, { kind: "http", boundAt: 0 }); });

    const terminated: string[] = [];
    const hinted: string[] = [];
    let workerFile = "";
    const spawn = vi.fn(async (_target: string, options: { spawnToken: string }) => {
      const filed = registry.resolve(options.spawnToken);
      const ref = filed!.ref as unknown as ResWorkflowSpawnRef;
      workerFile = register("worker-1", ref.researchSession);
      await participants.registerSpawn("worker-1", { cwd, sessionFile: workerFile }, ref);
      return { success: true, spawnToken: options.spawnToken, message: "ok" };
    });

    const collaboration = registerResWorkflowResearchSessionRoutes(app, {
      networkGuard: async () => {},
      sessionManager,
      history: accessDeps.history,
      accessFor,
      connection,
      joinParticipant: (access, id) => participants.join(access, id, "manual"),
      detachParticipant: participants.detach,
      prepareSpawn: participants.prepareSpawn,
      pendingPluginRefRegistry: registry,
      pendingPrincipalOwnerRegistry: createPendingPrincipalOwnerRegistry(),
      initialPrompts: { enqueue: () => true, remove: () => true },
      spawn,
      isResolverActive: () => false,
      privateDir,
      researchLoopRoot: process.env.PI_RESEARCH_LOOP_ROOT ?? fileURLToPath(new URL("../../../../../../extensions/research-loop", import.meta.url)),
      sendShutdownHint: (id) => { hinted.push(id); return true; },
      terminateSession: async (id) => {
        terminated.push(id);
        return { outcome: "confirmed-dead", terminated: true, pid: 5001 };
      },
      markManualClose: (id) => {
        const rec = sessionManager.get(id);
        if (rec) sessionManager.update(id, { closedReason: "manual" });
      },
      unregisterIfAlive: (id) => {
        const rec = sessionManager.get(id);
        if (rec && rec.status !== "ended") sessionManager.unregister(id, { closedReason: "manual" });
      },
      autoRetireSettleGraceMs: 0,
      autoRetireShutdownGraceMs: 0,
    });
    participants.setParticipationGuard(collaboration.assertParticipationAllowed);
    cleanups.push(async () => { await app.close(); metaPersistence.flushAll(); fs.rmSync(root, { recursive: true, force: true }); });

    const snap0 = (await app.inject({ method: "GET", url: `/api/res-workflow/collaboration?cwd=${encodeURIComponent(cwd)}` })).json();
    await app.inject({
      method: "POST",
      url: "/api/res-workflow/collaboration",
      payload: { cwd, expectedRevision: snap0.revision, action: "select-main", sessionId: "main-1" },
    });

    const planReply = await app.inject({
      method: "POST",
      url: "/api/res-workflow/dispatch",
      payload: {
        sessionId: "main-1",
        action: "plan",
        planId: "auto-retire-plan",
        tasks: [{ id: "t1", role: "research-worker", task: "Verify one metric", stage: "2-experiment" }],
      },
    });
    expect(planReply.statusCode, planReply.body).toBe(200);
    expect(sessionManager.get("worker-1")?.status).toBe("idle");
    expect(terminated).toEqual([]);

    // Worker reports completion.
    const reportReply = await app.inject({
      method: "POST",
      url: "/api/res-workflow/dispatch",
      payload: {
        sessionId: "worker-1",
        action: "report",
        status: "completed",
        summary: "Metric verified.",
        evidence: [],
      },
    });
    expect(reportReply.statusCode, reportReply.body).toBe(200);

    // Wait for the route's 2s scheduler tick to sweep and retire worker-1.
    await vi.waitFor(() => {
      expect(terminated).toEqual(["worker-1"]);
    }, { timeout: 5_000 });

    expect(hinted).toEqual(["worker-1"]);
    expect(sessionManager.get("worker-1")?.status).toBe("ended");
    expect(sessionManager.get("worker-1")?.closedReason).toBe("manual");
    expect(sessionManager.get("main-1")?.status).toBe("idle");
    expect(fs.existsSync(workerFile)).toBe(true);
  });
});
