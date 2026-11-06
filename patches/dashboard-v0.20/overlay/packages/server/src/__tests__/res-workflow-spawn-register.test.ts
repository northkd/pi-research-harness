import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { metaPath, readSessionMeta, writeSessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { createSessionCreation, projectSessionCreation } from "@blackbelt-technology/pi-dashboard-shared/session-creation.js";
import { projectResearchSession } from "@blackbelt-technology/pi-dashboard-shared/research-session.js";
import { wireEvents } from "../event-wiring.js";
import { createBrowserGateway } from "../pairing/browser-gateway.js";
import { createPendingForkRegistry } from "../pending/pending-fork-registry.js";
import { createPendingPrincipalOwnerRegistry } from "../pending/pending-principal-owner-registry.js";
import { createPendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";
import { createMemoryEventStore } from "../persistence/memory-event-store.js";
import { createMetaPersistence } from "../persistence/meta-persistence.js";
import { createMemorySessionManager } from "../session/memory-session-manager.js";
import { createSessionArchive } from "../session/session-archive.js";
import { scanAllSessions, sessionFromMeta } from "../session/session-scanner.js";
import { sessionToMeta } from "../session/session-to-meta.js";
import { resWorkflowAccess } from "../res-workflow/access.js";
import { createResWorkflowParticipants } from "../res-workflow/participants.js";
import { makeFakeDirectoryService } from "./helpers/load-fixtures.js";

const owner = { iss: "fixture", sub: "research-owner" };
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "res-register-"));
  const cwd = path.join(root, "project"); const history = path.join(root, "history");
  fs.mkdirSync(cwd); fs.mkdirSync(history);
  const sessionManager = createMemorySessionManager();
  sessionManager.register({ id: "anchor", cwd, source: "dashboard" } as never); sessionManager.update("anchor", { principalOwner: owner });
  const piGateway = { start: vi.fn(), stop: vi.fn(), sendToSession: vi.fn(), clearHostPressure: vi.fn(), getConnectedSessionIds: vi.fn(() => []), hasSession: vi.fn(() => true), isSessionConnected: vi.fn(() => true), onEvent: undefined } as any;
  const eventStore = createMemoryEventStore(() => false);
  const browserGateway = createBrowserGateway(sessionManager, eventStore, piGateway);
  const archive = createSessionArchive({ sessionManager, metaPersistence: createMetaPersistence(), getPinnedDirs: () => [] });
  const owners = createPendingPrincipalOwnerRegistry();
  let clock = 0;
  const registry = createPendingPluginRefRegistry({ now: () => clock, warn: () => {} });
  const metaPersistence = createMetaPersistence();
  const accessDeps = { knownCwds: () => [cwd], history: () => [...sessionManager.listAll(), ...archive.rows()], isResolverActive: () => true };
  const participants = createResWorkflowParticipants({ sessionManager, sessionArchive: archive, registry, metaPersistence, isResolverActive: () => true, accessFor: (cwd, identity) => resWorkflowAccess(accessDeps, identity, cwd), connection: async access => ({ cwd: access.cwd, adopted: true }), broadcast: (id, update) => browserGateway.broadcastSessionUpdated(id, update) });
  const attempts: Promise<unknown>[] = [];
  const registerParticipant = vi.fn((id, registration, ref) => {
    const promise = participants.registerSpawn(id, registration, ref); attempts.push(promise.catch(err => err)); return promise;
  });
  async function settleRegistrations() {
    // The production registration barrier queues `associate` in a microtask.
    // Let it file the promises before awaiting them, including in teardown.
    await Promise.resolve();
    return Promise.all(attempts);
  }
  wireEvents({ sessionManager, eventStore, piGateway, browserGateway, sessionOrderManager: { insert: vi.fn(), remove: vi.fn(), getOrder: vi.fn(() => []), reorder: vi.fn(), getAllOrders: vi.fn(() => ({})), moveToFront: vi.fn(), rekey: vi.fn() }, preferencesStore: { getPinnedDirectories: () => [], getAutoNameSessions: () => false }, pendingForkRegistry: createPendingForkRegistry(), directoryService: makeFakeDirectoryService().service, knownSessionIds: new Set<string>(), pendingDashboardSpawns: new Map<string, number>(), pendingPrincipalOwnerRegistry: owners, pendingPluginRefRegistry: registry, registerResWorkflowParticipant: registerParticipant } as any);
  cleanups.push(async () => { await settleRegistrations(); for (const row of sessionManager.listAll()) piGateway.onEvent(row.id, { type: "replay_complete", sessionId: row.id }); browserGateway.wss.close(); metaPersistence.flushAll(); fs.rmSync(root, { recursive: true, force: true }); });
  async function intent(token: string, stampOwner = true) {
    const ref = await participants.prepareSpawn(cwd, { principal: owner, write: true });
    registry.file(token, ref, "res-workflow"); if (stampOwner) owners.file(token, owner);
    return ref;
  }
  function register(id: string, token?: string, options: { cwd?: string; principalOwner?: typeof owner; provisional?: boolean; noResidentFile?: boolean } = {}) {
    const target = options.cwd ?? cwd; const file = path.join(history, `2026-11-06T00-00-00-000Z_${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: "session", id, cwd: target }) + "\n");
    sessionManager.register({ id, cwd: target, source: "tui", ...(options.noResidentFile ? {} : { sessionFile: file }) } as never);
    if (options.principalOwner) sessionManager.update(id, { principalOwner: options.principalOwner });
    piGateway.onEvent(id, { type: "session_register", sessionId: id, cwd: target, source: "tui", sessionFile: file, spawnToken: token, dashboardSpawned: !!token, provisional: options.provisional });
    return file;
  }
  return { root, cwd, sessionManager, archive, metaPersistence, accessDeps, participants, browserGateway, owners, registry, registerParticipant, settleRegistrations, intent, register, expire: () => { clock = 60_001; } };
}

describe("res-workflow real registration binding (fake bridge only)", () => {
  it("persists ordinary user creation through the exact registration, later join, archive, and restart", async () => {
    const f = setup();
    const creation = createSessionCreation(f.cwd, "dashboard");
    f.registry.file("user-create", { sessionCreation: creation }, "res-workflow");
    f.owners.file("user-create", owner);
    const unrelatedFile = f.register("unrelated");
    const provisionalFile = f.register("provisional-user", "user-create", { provisional: true });
    expect(f.registry.has("user-create")).toBe(true);
    const file = f.register("user-session", "user-create");
    expect(f.registerParticipant).not.toHaveBeenCalled();
    expect(readSessionMeta(unrelatedFile)?.pluginRefs).toBeUndefined();
    expect(readSessionMeta(provisionalFile)?.pluginRefs).toBeUndefined();
    expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]).toEqual({ sessionCreation: creation });
    expect(f.sessionManager.get("user-session")?.resWorkflow).toBeUndefined();
    expect(f.sessionManager.get("user-session")?.principalOwner).toEqual(owner);
    f.sessionManager.update("user-session", { status: "ended", live: false });
    f.metaPersistence.save(file, sessionToMeta(f.sessionManager.get("user-session")!));
    f.metaPersistence.flush(file);
    expect(projectSessionCreation(sessionFromMeta("user-session", file, path.dirname(file), readSessionMeta(file)!, Date.now()), f.cwd)).toEqual(creation);

    const access = await resWorkflowAccess(f.accessDeps, { principal: owner, write: true }, f.cwd);
    await f.participants.join(access, "user-session", "manual");
    expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]).toMatchObject({ sessionCreation: creation, resWorkflow: { via: "manual" } });
    expect(f.archive.archiveSession("user-session", "manual").ok).toBe(true);
    expect(projectSessionCreation(f.archive.getById("user-session"), f.cwd)).toEqual(creation);
    const restarted = scanAllSessions(f.root, { archiveAfterDays: 0, legacyPass: false }).archived.find(row => row.id === "user-session");
    expect(projectSessionCreation(restarted, f.cwd)).toEqual(creation);
  });

  it("keeps explicit UI creation when joining at spawn without persisting the private binding", async () => {
    const f = setup();
    const ref = await f.participants.prepareSpawn(f.cwd, { principal: owner, write: true });
    const creation = createSessionCreation(f.cwd, "research-stage");
    f.registry.file("stage-create", { ...ref, sessionCreation: creation }, "res-workflow");
    f.owners.file("stage-create", owner);
    const file = f.register("stage-session", "stage-create");
    await f.settleRegistrations();
    expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]).toMatchObject({ sessionCreation: creation, resWorkflow: { via: "spawn" } });
    expect(JSON.stringify(readSessionMeta(file))).not.toContain("resWorkflowBinding");
  });

  it("does not apply creation labels to a different cwd or treat creation-only refs as membership", () => {
    const f = setup();
    f.registry.file("wrong-origin-cwd", { sessionCreation: createSessionCreation("/unrelated", "dashboard") }, "res-workflow");
    const file = f.register("wrong-origin", "wrong-origin-cwd");
    expect(f.registerParticipant).not.toHaveBeenCalled();
    expect(readSessionMeta(file)?.pluginRefs).toBeUndefined();
  });

  it("retains user creation when the bridge resolves a UI cwd symlink", () => {
    const f = setup(); const alias = path.join(f.root, "alias");
    fs.symlinkSync(f.cwd, alias, "dir");
    const creation = createSessionCreation(alias, "dashboard");
    f.registry.file("alias-origin", { sessionCreation: creation }, "res-workflow");
    f.register("alias-user-session", "alias-origin");
    expect(projectSessionCreation(f.sessionManager.get("alias-user-session"), f.cwd)).toEqual({ ...creation, cwd: f.cwd });
  });

  it("reads legacy dispatch provenance without membership, preserves it in archive, and rejects malformed or foreign-cwd records", () => {
    const f = setup(); const file = f.register("legacy-child");
    const provenance = {
      schema: "pi-research-session.v1", parentSessionId: "anchor", creatorSessionId: "anchor", creatorAgent: "research_session",
      role: "reviewer", task: "Verify the assigned result", stage: "3-review", charterHash: `sha256:${"a".repeat(64)}`,
      adoptionId: `adopt-${"a".repeat(24)}`, workflowCwd: f.cwd, spawnToken: "legacy-token", createdAt: "2026-11-06T00:00:00.000Z", origin: "research_session", relation: "dispatch",
    };
    const meta = { cwd: f.cwd, status: "ended", live: false, principalOwner: owner, researchSession: provenance };
    writeSessionMeta(file, meta);
    const before = fs.readFileSync(metaPath(file), "utf8");
    const restored = sessionFromMeta("legacy-child", file, path.dirname(file), readSessionMeta(file)!, Date.now());
    expect(restored.researchSession).toEqual(provenance);
    expect(restored.resWorkflow).toBeUndefined();
    expect(restored.pluginRefs).toEqual({ "res-workflow": { researchSession: provenance } });
    expect(fs.readFileSync(metaPath(file), "utf8")).toBe(before);
    f.sessionManager.update("legacy-child", restored);
    f.sessionManager.update("legacy-child", { name: "Renamed legacy collaborator" });
    f.metaPersistence.save(file, sessionToMeta(f.sessionManager.get("legacy-child")!));
    f.metaPersistence.flush(file);
    expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]).toEqual({ researchSession: provenance });
    f.sessionManager.register({ id: "legacy-child", cwd: f.cwd, source: "tui", sessionFile: file } as never);
    expect(f.sessionManager.get("legacy-child")?.researchSession).toEqual(provenance);
    f.sessionManager.update("legacy-child", { status: "ended", live: false });
    expect(f.archive.archiveSession("legacy-child", "manual").ok).toBe(true);
    expect(projectResearchSession(f.archive.getById("legacy-child")!)?.provenance).toEqual(provenance);
    const restarted = scanAllSessions(f.root, { archiveAfterDays: 0, legacyPass: false }).archived.find(row => row.id === "legacy-child");
    expect(projectResearchSession(restarted!)?.provenance).toEqual(provenance);
    expect(sessionFromMeta("foreign", file, path.dirname(file), { ...meta, cwd: "/unrelated" }, Date.now()).researchSession).toBeUndefined();
    expect(sessionFromMeta("malformed", file, path.dirname(file), { ...meta, researchSession: { ...provenance, creatorSessionId: "wrong-parent" } } as any, Date.now()).researchSession).toBeUndefined();
    const existingBag = { "res-workflow": { resWorkflow: { canonicalCwd: f.cwd, via: "manual", joinedAt: provenance.createdAt }, retained: "x".repeat(12_000) } };
    const largeRecord = { ...provenance, tasks: Array.from({ length: 3 }, (_, index) => ({ id: `task-${index}`, role: "reviewer", task: "x".repeat(4_000), stage: "3-review" })) };
    const bounded = sessionFromMeta("large-legacy", file, path.dirname(file), { ...meta, researchSession: largeRecord, pluginRefs: existingBag } as any, Date.now());
    expect(bounded.pluginRefs).toEqual(existingBag);
    expect(bounded.researchSession?.parentSessionId).toBe("anchor");
  });

  it("stamps the real principal first and persists only the association bag after a fast registration", async () => {
    const f = setup(); await f.intent("early-token");
    const file = f.register("early-session", "early-token");
    await f.settleRegistrations();
    expect(f.registerParticipant).toHaveBeenCalledTimes(1);
    expect(f.sessionManager.get("early-session")?.resWorkflow).toMatchObject({ canonicalCwd: f.cwd, via: "spawn" });
    const meta = readSessionMeta(file)!;
    expect(meta.principalOwner).toEqual(owner); expect(meta.pluginRefs?.["res-workflow"]?.resWorkflow).toEqual(f.sessionManager.get("early-session")?.resWorkflow);
    expect(JSON.stringify(meta)).not.toMatch(/resWorkflowBinding|ownerKey|expiresAt/);
    expect((meta as Record<string, unknown>).resWorkflow).toBeUndefined();
    expect(f.registry.has("early-token")).toBe(false);
  });

  it("an unrelated same-cwd, no-token or expired-token registration never inherits the intent", async () => {
    const f = setup(); await f.intent("chosen-token");
    f.register("ordinary", "other-token"); f.register("legacy-no-token");
    expect(f.registerParticipant).not.toHaveBeenCalled(); expect(f.registry.has("chosen-token")).toBe(true);
    f.expire(); f.register("too-late", "chosen-token");
    expect(f.registerParticipant).not.toHaveBeenCalled();
    for (const id of ["ordinary", "legacy-no-token", "too-late"]) expect(f.sessionManager.get(id)?.resWorkflow).toBeUndefined();
  });

  it("consumes a mismatched actual cwd/owner without persisting a false association or falling back to cwd", async () => {
    const f = setup(); const other = path.join(f.root, "other"); fs.mkdirSync(other);
    await f.intent("wrong-cwd"); const wrongCwdFile = f.register("wrong-cwd-session", "wrong-cwd", { cwd: other });
    await f.intent("wrong-owner", false); const wrongOwnerFile = f.register("wrong-owner-session", "wrong-owner", { principalOwner: { iss: owner.iss, sub: "other-owner" } });
    await f.settleRegistrations();
    for (const file of [wrongCwdFile, wrongOwnerFile]) expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]).toBeUndefined();
    expect(f.sessionManager.get("wrong-cwd-session")?.resWorkflow).toBeUndefined(); expect(f.sessionManager.get("wrong-owner-session")?.resWorkflow).toBeUndefined();
    expect(f.registry.has("wrong-cwd")).toBe(false); expect(f.registry.has("wrong-owner")).toBe(false);
  });

  it("a provisional id consumes neither the research intent nor its principal binding", async () => {
    const f = setup(); await f.intent("pending-real-id");
    const provisionalFile = f.register("provisional", "pending-real-id", { provisional: true });
    expect(f.registry.has("pending-real-id")).toBe(true); expect(f.registerParticipant).not.toHaveBeenCalled();
    expect(readSessionMeta(provisionalFile)?.pluginRefs?.["res-workflow"]).toBeUndefined();
    const file = f.register("real-id", "pending-real-id"); await f.settleRegistrations();
    expect(f.sessionManager.get("real-id")?.resWorkflow?.canonicalCwd).toBe(f.cwd);
    expect(readSessionMeta(file)?.principalOwner).toEqual(owner);
  });

  it("uses the exact register message's verified file when the resident has not learned it yet", async () => {
    const f = setup(); await f.intent("file-race");
    const file = f.register("file-race-session", "file-race", { noResidentFile: true }); await f.settleRegistrations();
    expect(f.sessionManager.get("file-race-session")?.resWorkflow?.canonicalCwd).toBe(f.cwd);
    expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]?.resWorkflow).toBeDefined();
  });
});
