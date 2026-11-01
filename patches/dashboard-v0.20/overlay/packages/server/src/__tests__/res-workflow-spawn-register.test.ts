import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { wireEvents } from "../event-wiring.js";
import { createBrowserGateway } from "../pairing/browser-gateway.js";
import { createPendingForkRegistry } from "../pending/pending-fork-registry.js";
import { createPendingPrincipalOwnerRegistry } from "../pending/pending-principal-owner-registry.js";
import { createPendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";
import { createMemoryEventStore } from "../persistence/memory-event-store.js";
import { createMetaPersistence } from "../persistence/meta-persistence.js";
import { createMemorySessionManager } from "../session/memory-session-manager.js";
import { createSessionArchive } from "../session/session-archive.js";
import { resWorkflowAccess } from "../res-workflow/access.js";
import { createResWorkflowParticipants } from "../res-workflow/participants.js";
import { makeFakeDirectoryService } from "./helpers/load-fixtures.js";

const owner = { iss: "fixture", sub: "research-owner" };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "res-register-"));
  const cwd = path.join(root, "project"); const history = path.join(root, "history");
  fs.mkdirSync(cwd); fs.mkdirSync(history);
  const sessionManager = createMemorySessionManager();
  sessionManager.register({ id: "anchor", cwd, source: "dashboard" } as never); sessionManager.update("anchor", { principalOwner: owner });
  const piGateway = { start: vi.fn(), stop: vi.fn(), sendToSession: vi.fn(), getConnectedSessionIds: vi.fn(() => []), hasSession: vi.fn(() => true), isSessionConnected: vi.fn(() => true), onEvent: undefined } as any;
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
  wireEvents({ sessionManager, eventStore, piGateway, browserGateway, sessionOrderManager: { insert: vi.fn(), remove: vi.fn(), getOrder: vi.fn(() => []), reorder: vi.fn(), getAllOrders: vi.fn(() => ({})), moveToFront: vi.fn(), rekey: vi.fn() }, preferencesStore: { getPinnedDirectories: () => [], getAutoNameSessions: () => false }, pendingForkRegistry: createPendingForkRegistry(), directoryService: makeFakeDirectoryService().service, knownSessionIds: new Set<string>(), pendingDashboardSpawns: new Map<string, number>(), pendingPrincipalOwnerRegistry: owners, pendingPluginRefRegistry: registry, registerResWorkflowParticipant: registerParticipant } as any);
  cleanups.push(() => { for (const row of sessionManager.listAll()) piGateway.onEvent(row.id, { type: "replay_complete", sessionId: row.id }); browserGateway.wss.close(); metaPersistence.flushAll(); fs.rmSync(root, { recursive: true, force: true }); });
  async function intent(token: string, stampOwner = true) {
    const ref = await participants.prepareSpawn(cwd, { principal: owner, write: true });
    registry.file(token, ref, "res-workflow"); if (stampOwner) owners.file(token, owner);
    return ref;
  }
  function register(id: string, token?: string, options: { cwd?: string; principalOwner?: typeof owner; provisional?: boolean; noResidentFile?: boolean } = {}) {
    const target = options.cwd ?? cwd; const file = path.join(history, `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: "session", id, cwd: target }) + "\n");
    sessionManager.register({ id, cwd: target, source: "tui", ...(options.noResidentFile ? {} : { sessionFile: file }) } as never);
    if (options.principalOwner) sessionManager.update(id, { principalOwner: options.principalOwner });
    piGateway.onEvent(id, { type: "session_register", sessionId: id, cwd: target, source: "tui", sessionFile: file, spawnToken: token, dashboardSpawned: !!token, provisional: options.provisional });
    return file;
  }
  return { root, cwd, sessionManager, browserGateway, owners, registry, registerParticipant, attempts, intent, register, expire: () => { clock = 60_001; } };
}

describe("res-workflow real registration binding (fake bridge only)", () => {
  it("stamps the real principal first and persists only the association bag after a fast registration", async () => {
    const f = setup(); await f.intent("early-token");
    const file = f.register("early-session", "early-token");
    await Promise.all(f.attempts);
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
    await Promise.all(f.attempts);
    for (const file of [wrongCwdFile, wrongOwnerFile]) expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]).toBeUndefined();
    expect(f.sessionManager.get("wrong-cwd-session")?.resWorkflow).toBeUndefined(); expect(f.sessionManager.get("wrong-owner-session")?.resWorkflow).toBeUndefined();
    expect(f.registry.has("wrong-cwd")).toBe(false); expect(f.registry.has("wrong-owner")).toBe(false);
  });

  it("a provisional id consumes neither the research intent nor its principal binding", async () => {
    const f = setup(); await f.intent("pending-real-id");
    const provisionalFile = f.register("provisional", "pending-real-id", { provisional: true });
    expect(f.registry.has("pending-real-id")).toBe(true); expect(f.registerParticipant).not.toHaveBeenCalled();
    expect(readSessionMeta(provisionalFile)?.pluginRefs?.["res-workflow"]).toBeUndefined();
    const file = f.register("real-id", "pending-real-id"); await Promise.all(f.attempts);
    expect(f.sessionManager.get("real-id")?.resWorkflow?.canonicalCwd).toBe(f.cwd);
    expect(readSessionMeta(file)?.principalOwner).toEqual(owner);
  });

  it("uses the exact register message's verified file when the resident has not learned it yet", async () => {
    const f = setup(); await f.intent("file-race");
    const file = f.register("file-race-session", "file-race", { noResidentFile: true }); await Promise.all(f.attempts);
    expect(f.sessionManager.get("file-race-session")?.resWorkflow?.canonicalCwd).toBe(f.cwd);
    expect(readSessionMeta(file)?.pluginRefs?.["res-workflow"]?.resWorkflow).toBeDefined();
  });
});
