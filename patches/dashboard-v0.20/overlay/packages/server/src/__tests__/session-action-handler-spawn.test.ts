/**
 * Tests for handleSpawnSession — preflight gate, watchdog arming, failure log.
 * See change: spawn-failure-diagnostics.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

// Mock everything the handler depends on.
vi.mock("../spawn-process/spawn-preflight.js", () => ({
  preflightSpawn: vi.fn().mockReturnValue({ ok: true, reasons: [] }),
}));

vi.mock("../spawn-process/spawn-register-watchdog.js", () => ({
  getSpawnRegisterWatchdog: vi.fn().mockReturnValue({
    arm: vi.fn(),
  }),
}));

vi.mock("../spawn-process/spawn-failure-log.js", () => ({
  appendSpawnFailure: vi.fn(),
}));

vi.mock("../spawn-process/process-manager.js", () => ({
  spawnPiSession: vi.fn(),
}));

vi.mock("@blackbelt-technology/pi-dashboard-shared/config.js", () => ({
  loadConfig: vi.fn().mockReturnValue({
    spawnStrategy: "headless",
    spawnRegisterTimeoutMs: 30000,
    acpAgents: [],
  }),
}));

vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/binary-lookup.js", () => ({
  ToolResolver: function MockToolResolver() {
    return {
      resolvePi: vi.fn().mockReturnValue(["pi"]),
      resolveNode: vi.fn().mockReturnValue("/usr/bin/node"),
    };
  },
}));

import { handleSpawnSession } from "../browser-handlers/session-action-handler.js";
import { spawnPiSession } from "../spawn-process/process-manager.js";
import { appendSpawnFailure } from "../spawn-process/spawn-failure-log.js";
import { preflightSpawn } from "../spawn-process/spawn-preflight.js";
import { getSpawnRegisterWatchdog } from "../spawn-process/spawn-register-watchdog.js";

const mockSpawnPiSession = vi.mocked(spawnPiSession);
const mockPreflightSpawn = vi.mocked(preflightSpawn);
const mockAppendSpawnFailure = vi.mocked(appendSpawnFailure);

function makeCtx() {
  const messages: unknown[] = [];
  const ws = {
    readyState: WebSocket.OPEN,
    send: vi.fn((data: string) => messages.push(JSON.parse(data))),
  } as unknown as WebSocket;

  const sendTo = vi.fn((_ws: WebSocket, msg: unknown) => messages.push(msg));

  return {
    ws,
    messages,
    sendTo,
    headlessPidRegistry: { register: vi.fn() } as never,
    pendingDashboardSpawns: new Map(),
    pendingAttachRegistry: { enqueue: vi.fn() } as never,
    sessionManager: {} as never,
    broadcast: vi.fn() as never,
    piGateway: {} as never,
  };
}

describe("handleSpawnSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preflight failure sends spawn_error with PREFLIGHT_FAILED", async () => {
    mockPreflightSpawn.mockReturnValue({
      ok: false,
      reasons: [{ code: "PI_NOT_FOUND", message: "pi not found" }],
    });

    const ctx = makeCtx();
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);

    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    const errorMsg = ctx.messages.find((m: any) => m.type === "spawn_error") as any;
    expect(errorMsg).toBeDefined();
    expect(errorMsg.code).toBe("PREFLIGHT_FAILED");
    expect(mockAppendSpawnFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "PREFLIGHT_FAILED" }));
  });

  it("successful headless spawn arms watchdog with pid", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockResolvedValue({
      success: true,
      pid: 123,
      process: {} as never,
      dashboardSpawned: true,
      message: "spawned",
      logPath: "/tmp/pi-spawn.log",
    });

    const watchdog = { arm: vi.fn() };
    vi.mocked(getSpawnRegisterWatchdog).mockReturnValue(watchdog as never);

    const ctx = makeCtx();
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);

    expect(watchdog.arm).toHaveBeenCalledWith(expect.objectContaining({
      pid: 123,
      cwd: "/p/x",
      logPath: "/tmp/pi-spawn.log",
    }));
  });

  it("failed spawn forwards code and appends log", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockResolvedValue({
      success: false,
      code: "PI_CRASHED" as never,
      message: "crashed",
      stderr: "error output",
    });

    const ctx = makeCtx();
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);

    const errorMsg = ctx.messages.find((m: any) => m.type === "spawn_error") as any;
    expect(errorMsg.code).toBe("PI_CRASHED");
    expect(errorMsg.stderr).toBe("error output");
    expect(mockAppendSpawnFailure).toHaveBeenCalledWith(expect.objectContaining({
      code: "PI_CRASHED",
      stderrTail: "error output",
    }));
  });

  it("thrown exception appends SPAWN_ERRNO entry", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockRejectedValue(new Error("ENOENT"));

    const ctx = makeCtx();
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);

    expect(mockAppendSpawnFailure).toHaveBeenCalledWith(expect.objectContaining({ code: "SPAWN_ERRNO" }));
  });
});

describe("handleSpawnSession — owner stamping (§6.2 / D11)", () => {
  beforeEach(() => vi.clearAllMocks());

  const principal = { iss: "https://kc/realms/app", sub: "user-1", email: "u@x" };

  /** Build a ctx with an owner registry + resolver-active predicate + optional socket principal. */
  function ownerCtx(opts: { active: boolean; withPrincipal: boolean }) {
    const base = makeCtx();
    const owners = { file: vi.fn(), resolve: vi.fn(), remove: vi.fn(), size: vi.fn() };
    if (opts.withPrincipal) (base.ws as unknown as { principal?: unknown }).principal = principal;
    return {
      ...base,
      pendingPrincipalOwnerRegistry: owners as never,
      isResolverActive: () => opts.active,
      owners,
    };
  }

  it("files the owner (iss,sub only) + passes a spawnToken when active and principal present", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockResolvedValue({ success: true, pid: 1, process: {} as never, message: "ok" });
    const ctx = ownerCtx({ active: true, withPrincipal: true });
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);
    expect(ctx.owners.file).toHaveBeenCalledTimes(1);
    const [token, owner] = ctx.owners.file.mock.calls[0]!;
    expect(owner).toEqual({ iss: principal.iss, sub: principal.sub }); // no email
    expect(typeof token).toBe("string");
    // The same token rode the spawn so event-wiring can correlate on register.
    expect(mockSpawnPiSession).toHaveBeenCalledWith("/p/x", expect.objectContaining({ spawnToken: token }));
  });

  it("stamps no owner when the resolver is inert", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockResolvedValue({ success: true, pid: 1, process: {} as never, message: "ok" });
    const ctx = ownerCtx({ active: false, withPrincipal: true });
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);
    expect(ctx.owners.file).not.toHaveBeenCalled();
    expect(mockSpawnPiSession).toHaveBeenCalledWith("/p/x", expect.not.objectContaining({ spawnToken: expect.anything() }));
  });

  it("stamps no owner for a principal-less socket", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockResolvedValue({ success: true, pid: 1, process: {} as never, message: "ok" });
    const ctx = ownerCtx({ active: true, withPrincipal: false });
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);
    expect(ctx.owners.file).not.toHaveBeenCalled();
  });

  it("removes the pre-filed owner when the spawn fails", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockResolvedValue({ success: false, code: "PI_CRASHED" as never, message: "crashed" });
    const ctx = ownerCtx({ active: true, withPrincipal: true });
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);
    const [token] = ctx.owners.file.mock.calls[0]!;
    expect(ctx.owners.remove).toHaveBeenCalledWith(token);
  });

  it("removes the pre-filed owner when the spawn throws", async () => {
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockRejectedValue(new Error("ENOENT"));
    const ctx = ownerCtx({ active: true, withPrincipal: true });
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x" } as never, ctx as never);
    const [token] = ctx.owners.file.mock.calls[0]!;
    expect(ctx.owners.remove).toHaveBeenCalledWith(token);
  });
});

describe("handleSpawnSession — explicit res-workflow intent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPreflightSpawn.mockReturnValue({ ok: true, reasons: [] });
    mockSpawnPiSession.mockImplementation(async (_cwd, options) => ({ success: true, message: "fake spawn", spawnToken: options?.spawnToken }));
  });
  function joinedCtx() {
    const registry = { file: vi.fn((_token: string, _ref: unknown, _ownerId: string) => true), remove: vi.fn() };
    const prepare = vi.fn(async () => ({ resWorkflow: { canonicalCwd: "/p/x", joinedAt: "2026-10-24T00:00:00Z", via: "spawn" }, resWorkflowBinding: { ownerKey: "fixture", resolverActive: false, identity: { write: true, principal: null, expiresAt: null } } }));
    const ctx = { ...makeCtx(), resWorkflowSpawnSupport: { prepare, registry } };
    return { ctx, registry, prepare };
  }

  it("files a token before the spawn await even in inert mode, without claiming a joined session early", async () => {
    const f = joinedCtx();
    mockSpawnPiSession.mockImplementation(async (_cwd, options) => {
      expect(f.registry.file).toHaveBeenCalledWith(options?.spawnToken, expect.objectContaining({ resWorkflow: expect.any(Object) }), "res-workflow");
      return { success: true, message: "fake spawn", spawnToken: options?.spawnToken };
    });
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x", joinResWorkflow: true, model: "fixture/model", thinkingLevel: "high", requestId: "client-request" } as never, f.ctx as never);
    expect(f.prepare).toHaveBeenCalledWith("/p/x", expect.objectContaining({ write: true }));
    const token = f.registry.file.mock.calls[0]?.[0]; expect(typeof token).toBe("string");
    expect(mockSpawnPiSession).toHaveBeenCalledWith("/p/x", expect.objectContaining({ spawnToken: token, model: "fixture/model", thinking: "high" }));
    expect(f.ctx.messages).toContainEqual(expect.objectContaining({ type: "spawn_result", success: true, requestId: "client-request" }));
    expect(JSON.stringify(f.ctx.messages)).not.toMatch(/resWorkflowBinding|canonicalCwd|joinedAt/);
  });

  it("an ordinary same-cwd creation neither checks connection nor files an association", async () => {
    const f = joinedCtx();
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x", requestId: "ordinary" } as never, f.ctx as never);
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.registry.file).not.toHaveBeenCalled();
    expect(mockSpawnPiSession).toHaveBeenCalledWith("/p/x", { strategy: "headless" });
  });

  it("concurrent same-cwd join intents receive distinct pre-minted tokens, never a cwd association queue", async () => {
    const f = joinedCtx(); const tokens: string[] = []; const releases: Array<() => void> = [];
    mockSpawnPiSession.mockImplementation(async (_cwd, options) => { tokens.push(options!.spawnToken!); await new Promise<void>(resolve => releases.push(resolve)); return { success: true, message: "fake", spawnToken: options?.spawnToken }; });
    const first = handleSpawnSession({ type: "spawn_session", cwd: "/p/x", joinResWorkflow: true } as never, f.ctx as never);
    const second = handleSpawnSession({ type: "spawn_session", cwd: "/p/x", joinResWorkflow: true } as never, f.ctx as never);
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    expect(new Set(tokens).size).toBe(2); expect(tokens.every(Boolean)).toBe(true);
    releases.reverse().forEach(release => release()); await Promise.all([first, second]);
    expect(f.registry.file.mock.calls.map(call => call[0])).toEqual(tokens);
  });

  it.each(["preflight", "failed", "throws", "invalid-agent"])("rolls back only its token on %s failure", async kind => {
    const f = joinedCtx();
    if (kind === "preflight") mockPreflightSpawn.mockReturnValue({ ok: false, reasons: [{ code: "PI_NOT_FOUND", message: "fixture" }] });
    if (kind === "failed") mockSpawnPiSession.mockResolvedValueOnce({ success: false, message: "fixture failed" });
    if (kind === "throws") mockSpawnPiSession.mockRejectedValueOnce(new Error("fixture failed"));
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x", joinResWorkflow: true, ...(kind === "invalid-agent" ? { agent: "unknown-agent" } : {}) } as never, f.ctx as never);
    const token = f.registry.file.mock.calls[0]?.[0]; expect(typeof token).toBe("string");
    expect(f.registry.remove).toHaveBeenCalledWith(token);
    expect(f.ctx.messages).toContainEqual(expect.objectContaining({ type: "spawn_result", success: false }));
  });

  it("a refused connection or ref filing does not silently fall back to an ordinary spawn", async () => {
    const f = joinedCtx();
    f.prepare.mockRejectedValueOnce(Object.assign(new Error("fixture"), { code: "res-workflow-not-connected" }));
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x", joinResWorkflow: true, initialPrompt: "fixture" } as never, f.ctx as never);
    expect(mockSpawnPiSession).not.toHaveBeenCalled(); expect(f.registry.file).not.toHaveBeenCalled();
    f.registry.file.mockReturnValueOnce(false);
    await handleSpawnSession({ type: "spawn_session", cwd: "/p/x", joinResWorkflow: true } as never, f.ctx as never);
    expect(mockSpawnPiSession).not.toHaveBeenCalled();
    expect(f.ctx.messages.filter((msg: any) => msg.type === "spawn_result" && !msg.success)).toHaveLength(2);
  });
});
