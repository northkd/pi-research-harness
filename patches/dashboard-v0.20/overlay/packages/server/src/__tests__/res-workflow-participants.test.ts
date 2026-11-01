import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readSessionMeta, writeSessionMeta } from "@blackbelt-technology/pi-dashboard-shared/session-meta.js";
import { createResWorkflowParticipants } from "../res-workflow/participants.js";
import type { ResWorkflowAccess } from "../res-workflow/adoption-service.js";
import { createMemorySessionManager } from "../session/memory-session-manager.js";
import { createSessionArchive } from "../session/session-archive.js";
import { scanAllSessions, sessionFromMeta } from "../session/session-scanner.js";
import { sessionToMeta } from "../session/session-to-meta.js";
import { createMetaPersistence } from "../persistence/meta-persistence.js";
import { createPendingPluginRefRegistry } from "../pending/pending-plugin-ref-registry.js";

vi.mock("@blackbelt-technology/pi-dashboard-shared/session-meta.js", async original => {
  const actual = await original<typeof import("@blackbelt-technology/pi-dashboard-shared/session-meta.js")>();
  return { ...actual, writeSessionMeta: vi.fn(actual.writeSessionMeta) };
});
const dirs: string[] = [];
const owner = { iss: "fixture", sub: "owner-one" };
afterEach(() => { vi.clearAllMocks(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup(archived = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "res-participant-")); dirs.push(root);
  const cwd = path.join(root, "project"); const history = path.join(root, "history");
  fs.mkdirSync(cwd); fs.mkdirSync(history);
  const sessionId = "real-session"; const sessionFile = path.join(history, "2026-10-24T00-00-00-000Z_real-session.jsonl");
  fs.writeFileSync(sessionFile, JSON.stringify({ type: "session", id: sessionId, cwd }) + "\n" + JSON.stringify({ type: "message", message: { role: "user", content: "QA_NEVER_READ_CHAT_BODY" } }) + "\n");
  writeSessionMeta(sessionFile, { cwd, status: "ended", principalOwner: owner, pluginRefs: { demo: { demoKey: "keep" } }, ...(archived ? { archived: true, archivedAt: 123 } : {}) });
  const sessionManager = createMemorySessionManager();
  if (!archived) { sessionManager.register({ id: sessionId, cwd, source: "dashboard" } as never); sessionManager.update(sessionId, { sessionFile, principalOwner: owner, pluginRefs: { demo: { demoKey: "keep" } }, status: "ended" }); }
  const metaPersistence = createMetaPersistence();
  const archive = createSessionArchive({ sessionManager, metaPersistence, getPinnedDirs: () => [] });
  if (archived) archive.seed([{ id: sessionId, cwd, groupPath: cwd, sessionFile, principalOwner: owner, endedAt: 100, archivedAt: 123 }]);
  const registry = createPendingPluginRefRegistry({ warn: () => {} });
  let active = true;
  const access: ResWorkflowAccess = { cwd, ownerKey: JSON.stringify([owner.iss, owner.sub]), revalidate: vi.fn(async () => {}), canReadHistory: async row => row.principalOwner?.iss === owner.iss && row.principalOwner?.sub === owner.sub };
  const broadcast = vi.fn();
  const connection = vi.fn(async () => ({ cwd, adopted: true }));
  const accessFor = vi.fn(async () => access);
  const participants = createResWorkflowParticipants({ sessionManager, sessionArchive: archive, metaPersistence, registry, isResolverActive: () => active, accessFor, connection, broadcast });
  return { root, cwd, sessionId, sessionFile, sessionManager, archive, metaPersistence, registry, access, participants, broadcast, connection, accessFor, inert: () => { active = false; } };
}

describe("res-workflow metadata-only participation", () => {
  it("joins an ended resident, preserves plugin bags and survives a routine save/restart without resuming", async () => {
    const f = setup();
    f.metaPersistence.save(f.sessionFile, sessionToMeta(f.sessionManager.get(f.sessionId)!));
    const first = await f.participants.join(f.access, f.sessionId, "manual");
    expect(first.resWorkflow).toMatchObject({ canonicalCwd: f.cwd, via: "manual" });
    expect(f.sessionManager.get(f.sessionId)?.status).toBe("ended");
    expect(f.sessionManager.get(f.sessionId)?.pluginRefs?.demo).toEqual({ demoKey: "keep" });
    f.metaPersistence.save(f.sessionFile, sessionToMeta(f.sessionManager.get(f.sessionId)!)); f.metaPersistence.flush(f.sessionFile);
    const meta = readSessionMeta(f.sessionFile)!;
    expect(meta.pluginRefs?.["res-workflow"]).toEqual({ resWorkflow: first.resWorkflow });
    expect((meta as Record<string, unknown>).resWorkflow).toBeUndefined();
    expect(sessionFromMeta(f.sessionId, f.sessionFile, f.cwd, meta, 100).resWorkflow).toEqual(first.resWorkflow);
    expect((await f.participants.join(f.access, f.sessionId, "adoption")).resWorkflow).toEqual(first.resWorkflow);
    expect(f.broadcast).toHaveBeenCalledWith(f.sessionId, expect.objectContaining({ resWorkflow: first.resWorkflow }));
  });

  it("updates an archive row and sidecar without restoring, starting or unarchiving it", async () => {
    const f = setup(true); const restore = vi.spyOn(f.archive, "unarchiveSession");
    const joined = await f.participants.join(f.access, f.sessionId, "manual");
    expect(f.sessionManager.get(f.sessionId)).toBeUndefined(); expect(restore).not.toHaveBeenCalled();
    expect(f.archive.getById(f.sessionId)?.resWorkflow).toEqual(joined.resWorkflow);
    expect(f.archive.list({ limit: 10 }).items[0].resWorkflow).toEqual(joined.resWorkflow);
    const cold = scanAllSessions(f.root, { archiveAfterDays: 0, archiveServiceSessionsOnEnd: false });
    expect(cold.archived.find(row => row.id === f.sessionId)?.resWorkflow).toEqual(joined.resWorkflow);
    expect(cold.sessions.some(row => row.id === f.sessionId)).toBe(false);
    expect(readSessionMeta(f.sessionFile)).toMatchObject({ archived: true, archivedAt: 123, pluginRefs: { demo: { demoKey: "keep" }, "res-workflow": { resWorkflow: joined.resWorkflow } } });
  });

  it("rejects remote, foreign-owner, wrong-directory and invented ids before metadata writes", async () => {
    const f = setup(); vi.mocked(writeSessionMeta).mockClear();
    for (const update of [{ originDeviceId: "remote-device" }, { principalOwner: { iss: "fixture", sub: "other-owner" } }, { cwd: f.root }]) {
      f.sessionManager.update(f.sessionId, { cwd: f.cwd, principalOwner: owner, originDeviceId: undefined, ...update });
      await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: 404 });
    }
    await expect(f.participants.join(f.access, "invented-id", "manual")).rejects.toMatchObject({ statusCode: 404 });
    expect(writeSessionMeta).not.toHaveBeenCalled(); expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("refuses link/corrupt sidecars and does not claim success after a failed atomic write", async () => {
    const f = setup();
    const sidecar = f.sessionFile.replace(/\.jsonl$/, ".meta.json");
    const outside = path.join(f.root, "outside.json"); fs.writeFileSync(outside, "{}");
    fs.unlinkSync(sidecar); fs.symlinkSync(outside, sidecar);
    await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: 409 });
    expect(fs.readFileSync(outside, "utf8")).toBe("{}");
    fs.unlinkSync(sidecar); fs.writeFileSync(sidecar, "broken metadata");
    await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: 409 });
    fs.writeFileSync(sidecar, "{}");
    vi.mocked(writeSessionMeta).mockImplementationOnce(() => { throw new Error("fixture-write-failed"); });
    await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: 503 });
    expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined(); expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("prepares only a private intent; validates the actual registration before recording an association", async () => {
    const f = setup();
    const ref = await f.participants.prepareSpawn(f.cwd, { principal: owner, write: true });
    expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined();
    const joined = await f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, ref);
    expect(joined.resWorkflow.via).toBe("spawn");
    expect(readSessionMeta(f.sessionFile)?.pluginRefs?.["res-workflow"]).toEqual({ resWorkflow: joined.resWorkflow });
    expect(JSON.stringify(readSessionMeta(f.sessionFile))).not.toMatch(/resWorkflowBinding|ownerKey|expiresAt/);
  });

  it("can associate a verified fresh register before Pi creates its first transcript, without creating a fake chat", async () => {
    const f = setup(); fs.unlinkSync(f.sessionFile);
    const ref = await f.participants.prepareSpawn(f.cwd, { principal: owner, write: true });
    const joined = await f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, ref);
    expect(joined.resWorkflow.via).toBe("spawn"); expect(fs.existsSync(f.sessionFile)).toBe(false);
    expect(readSessionMeta(f.sessionFile)?.pluginRefs?.["res-workflow"]?.resWorkflow).toEqual(joined.resWorkflow);
  });

  it.each(["id", "cwd"])("fails closed when a previously missing transcript appears with a different %s during revalidation", async mismatch => {
    const f = setup(); fs.unlinkSync(f.sessionFile);
    const ref = await f.participants.prepareSpawn(f.cwd, { principal: owner, write: true });
    vi.mocked(f.access.revalidate).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => {
      fs.writeFileSync(f.sessionFile, JSON.stringify({ type: "session", id: mismatch === "id" ? "unrelated-session" : f.sessionId, cwd: mismatch === "cwd" ? f.root : f.cwd }) + "\n");
    });
    vi.mocked(writeSessionMeta).mockClear();
    await expect(f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, ref)).rejects.toMatchObject({ statusCode: 409 });
    expect(writeSessionMeta).not.toHaveBeenCalled(); expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined();
    expect(readSessionMeta(f.sessionFile)?.pluginRefs?.["res-workflow"]).toBeUndefined();
  });

  it.each(["pluginHidden", "archiveOnEnd"])("excludes a resident marked %s at the host boundary", async flag => {
    const f = setup(); f.sessionManager.update(f.sessionId, { [flag]: true });
    vi.mocked(writeSessionMeta).mockClear();
    await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: 404 });
    expect(writeSessionMeta).not.toHaveBeenCalled(); expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined();
  });

  it.each(["pluginHidden", "archiveOnEnd"])("excludes archived %s metadata even with a stale index, and retains the exclusion after cold reseed", async flag => {
    const f = setup(true); const sidecar = f.sessionFile.replace(/\.jsonl$/, ".meta.json");
    const original = readSessionMeta(f.sessionFile)!;
    fs.writeFileSync(sidecar, JSON.stringify({ ...original, [flag]: true }));
    vi.mocked(writeSessionMeta).mockClear();
    await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: 404 });
    expect(writeSessionMeta).not.toHaveBeenCalled();
    const cold = scanAllSessions(f.root, { archiveAfterDays: 0, archiveServiceSessionsOnEnd: false });
    expect(cold.archived.find(row => row.id === f.sessionId)).toMatchObject({ [flag]: true });
    f.archive.seed(cold.archived);
    // A known excluded index row also stays excluded if its sidecar is stale.
    fs.writeFileSync(sidecar, JSON.stringify(original));
    await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: 404 });
    expect(writeSessionMeta).not.toHaveBeenCalled(); expect(f.broadcast).not.toHaveBeenCalled();
    expect(f.sessionManager.get(f.sessionId)).toBeUndefined(); expect(f.archive.has(f.sessionId)).toBe(true);
  });

  it.each([false, true].flatMap(archived => ["pluginHidden", "archiveOnEnd", "owner"].map(kind => ({ archived, kind }))))("rejects current $kind before a stale queued flush (archived=$archived)", async ({ archived, kind }) => {
    const f = setup(archived); const sidecar = f.sessionFile.replace(/\.jsonl$/, ".meta.json");
    const stale = readSessionMeta(f.sessionFile)!;
    f.metaPersistence.save(f.sessionFile, stale);
    const changed = kind === "owner" ? { principalOwner: { iss: owner.iss, sub: "new-owner" } } : { [kind]: true };
    const before = JSON.stringify({ ...stale, ...changed }); fs.writeFileSync(sidecar, before);
    const flush = vi.spyOn(f.metaPersistence, "flush"); vi.mocked(writeSessionMeta).mockClear();
    try {
      await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: kind === "owner" ? 409 : 404 });
      expect(flush).not.toHaveBeenCalled(); expect(writeSessionMeta).not.toHaveBeenCalled();
      expect(fs.readFileSync(sidecar, "utf8")).toBe(before); expect(f.broadcast).not.toHaveBeenCalled();
      expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined(); expect(f.archive.getById(f.sessionId)?.resWorkflow).toBeUndefined();
    } finally { f.metaPersistence.dispose(); }
  });

  it.each(["pluginHidden", "archiveOnEnd", "owner"])("still rechecks %s introduced by a queued flush before associating", async kind => {
    const f = setup(); const original = readSessionMeta(f.sessionFile)!;
    const changed = kind === "owner" ? { principalOwner: { iss: owner.iss, sub: "new-owner" } } : { [kind]: true };
    f.metaPersistence.save(f.sessionFile, { ...original, ...changed });
    const flush = vi.spyOn(f.metaPersistence, "flush"); vi.mocked(writeSessionMeta).mockClear();
    try {
      await expect(f.participants.join(f.access, f.sessionId, "manual")).rejects.toMatchObject({ statusCode: kind === "owner" ? 409 : 404 });
      expect(flush).toHaveBeenCalledOnce(); expect(writeSessionMeta).toHaveBeenCalledOnce();
      expect(readSessionMeta(f.sessionFile)).toMatchObject(changed);
      expect(readSessionMeta(f.sessionFile)?.pluginRefs?.["res-workflow"]).toBeUndefined();
      expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined(); expect(f.broadcast).not.toHaveBeenCalled();
    } finally { f.metaPersistence.dispose(); }
  });

  it.each([false, true])("still permits an ordinary user-hidden session (archived=%s) without changing its lifecycle", async archived => {
    const f = setup(archived); const sidecar = f.sessionFile.replace(/\.jsonl$/, ".meta.json");
    fs.writeFileSync(sidecar, JSON.stringify({ ...readSessionMeta(f.sessionFile), hidden: true }));
    if (!archived) f.sessionManager.update(f.sessionId, { hidden: true });
    const joined = await f.participants.join(f.access, f.sessionId, "manual");
    expect(joined.resWorkflow.canonicalCwd).toBe(f.cwd); expect(readSessionMeta(f.sessionFile)?.hidden).toBe(true);
    expect(f.archive.has(f.sessionId)).toBe(archived);
    if (!archived) expect(f.sessionManager.get(f.sessionId)?.status).toBe("ended");
  });

  it("never transfers a prepared spawn association to a different cwd/owner or expired identity", async () => {
    const f = setup(); const ref = await f.participants.prepareSpawn(f.cwd, { principal: owner, write: true });
    f.sessionManager.update(f.sessionId, { principalOwner: { iss: "fixture", sub: "wrong-owner" } });
    await expect(f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, ref)).rejects.toMatchObject({ statusCode: 404 });
    f.sessionManager.update(f.sessionId, { principalOwner: owner });
    await expect(f.participants.registerSpawn(f.sessionId, { cwd: f.root, sessionFile: f.sessionFile }, ref)).rejects.toMatchObject({ statusCode: 409 });
    await expect(f.participants.prepareSpawn(f.cwd, { principal: owner, expiresAt: Date.now() - 1, write: true })).rejects.toMatchObject({ statusCode: 403 });
    const expired = { ...ref, resWorkflowBinding: { ...ref.resWorkflowBinding, identity: { ...ref.resWorkflowBinding.identity, expiresAt: Date.now() - 1 } } };
    await expect(f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, expired)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined(); expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("rechecks the prepared spawn owner after asynchronous work even in inert operator mode", async () => {
    const f = setup(); f.inert(); f.sessionManager.update(f.sessionId, { principalOwner: undefined });
    writeSessionMeta(f.sessionFile, { cwd: f.cwd }); f.access.canReadHistory = async () => true;
    const ref = await f.participants.prepareSpawn(f.cwd, { write: true });
    f.connection.mockImplementationOnce(async () => { f.sessionManager.update(f.sessionId, { principalOwner: { iss: "fixture", sub: "new-owner" } }); return { cwd: f.cwd, adopted: true }; });
    await expect(f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, ref)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined(); expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("rejects a resolver change during preparation rather than filing a differently scoped intent", async () => {
    const f = setup();
    f.connection.mockImplementationOnce(async () => { f.inert(); return { cwd: f.cwd, adopted: true }; });
    await expect(f.participants.prepareSpawn(f.cwd, { principal: owner, write: true })).rejects.toMatchObject({ statusCode: 403 });
    expect(f.broadcast).not.toHaveBeenCalled();
  });

  it.each(["resWorkflow", "resWorkflowBinding"])("refuses preparation if another plugin owns essential %s", async key => {
    const f = setup(); f.registry.sanitize({ [key]: "foreign" }, "other-feature");
    await expect(f.participants.prepareSpawn(f.cwd, { principal: owner, write: true })).rejects.toMatchObject({ statusCode: 409 });
    expect(f.sessionManager.get(f.sessionId)?.resWorkflow).toBeUndefined(); expect(f.broadcast).not.toHaveBeenCalled();
  });

  it("requires the directory connection again when a spawn registers, and rejects a resolver-mode change", async () => {
    const f = setup(); const ref = await f.participants.prepareSpawn(f.cwd, { principal: owner, write: true });
    f.connection.mockResolvedValueOnce({ cwd: f.cwd, adopted: false });
    await expect(f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, ref)).rejects.toMatchObject({ statusCode: 409 });
    f.inert();
    await expect(f.participants.registerSpawn(f.sessionId, { cwd: f.cwd, sessionFile: f.sessionFile }, ref)).rejects.toMatchObject({ statusCode: 403 });
    expect(f.broadcast).not.toHaveBeenCalled();
  });
});
