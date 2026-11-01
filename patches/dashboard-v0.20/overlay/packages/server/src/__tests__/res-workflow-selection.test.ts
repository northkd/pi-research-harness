import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResWorkflowService, type ResWorkflowAccess } from "../res-workflow/adoption-service.js";
import { readBoundedRegular } from "../res-workflow/safe-files.js";
import { discoverHistoryCandidates } from "../res-workflow/history-candidates.js";

vi.mock("../res-workflow/safe-files.js", async (original) => {
  const actual = await original<typeof import("../res-workflow/safe-files.js")>();
  return { ...actual, readBoundedRegular: vi.fn(actual.readBoundedRegular) };
});
const dirs: string[] = [];
const services: Array<{ dispose(): void }> = [];
afterEach(async () => { for (const service of services.splice(0)) service.dispose(); vi.clearAllMocks(); await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true }))); });
const model = { provider: "fake", id: "physical" };
const consent = { scope: "research-files-and-normal-messages" as const, includeUnpublished: true as const };
const researchLoopRoot = fileURLToPath(new URL("../../../../../research-loop", import.meta.url));
const transcript = (cwd: string, id: string, text: string) => [
  { type: "session", id, cwd, timestamp: "2026-10-01T00:00:00Z" },
  { type: "message", id: `${id}-m1`, timestamp: "2026-10-01T00:00:01Z", message: { role: "user", content: text } },
].map(value => JSON.stringify(value)).join("\n") + "\n";
async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "res-selected-")); dirs.push(root);
  const cwd = path.join(root, "project"); const historyRoot = path.join(root, "history");
  await fs.mkdir(cwd); await fs.mkdir(historyRoot);
  await fs.writeFile(path.join(cwd, "goal.md"), "Finite research files only");
  const files = { one: path.join(historyRoot, "one.jsonl"), two: path.join(historyRoot, "two.jsonl"), loose: path.join(historyRoot, "loose.jsonl") };
  await fs.writeFile(files.one, transcript(cwd, "session-one", "QA_SELECTED_RESEARCH"));
  await fs.writeFile(files.two, transcript(cwd, "session-two", "QA_UNSELECTED_CHAT"));
  await fs.writeFile(files.loose, transcript(cwd, "loose-session", "QA_UNREGISTERED_HISTORY"));
  const readRetained = vi.fn(async () => ({ raw: transcript(cwd, "remote-session", "QA_REMOTE_CHAT"), retained: true, complete: false }));
  const stream = vi.fn(async function* (_model: unknown, context: any) {
    const sources = JSON.parse(context.messages[0].content[0].text).sources;
    yield { type: "text_delta", delta: JSON.stringify({ summary: "Unverified selection", objective: "Check selected evidence", successCriteria: ["Evidence verified"], unresolved: [], items: [{ text: "Unverified source", sourceIds: [sources[0].id] }] }) };
    yield { type: "done", message: { content: [] } };
  });
  const joinParticipant = vi.fn(async (_access: ResWorkflowAccess, sessionId: string, via: "manual" | "adoption") => ({ sessionId, resWorkflow: { canonicalCwd: cwd, joinedAt: "2026-10-24T00:00:00Z", via } }));
  const deps = {
    privateDir: path.join(root, "private"), researchLoopRoot,
    history: () => [{ id: "session-one", cwd, sessionFile: files.one, name: "Selected research" }, { id: "session-two", cwd, sessionFile: files.two, name: "Unrelated chat" }, { id: "remote-session", cwd, sessionFile: files.two, originDeviceId: "remote-device" }],
    historyRoots: () => [historyRoot], readRetained, joinParticipant,
    resolveModel: vi.fn(async () => ({ ...model, fingerprint: "fake-config", contextWindow: 64000, maxTokens: 4096, model, runtime: { getModels: () => [], getPhysicalModel: () => undefined, checkAuth: async () => true, streamSimple: stream } })),
  };
  const service = createResWorkflowService(deps); services.push(service);
  const access: ResWorkflowAccess = { cwd, ownerKey: "owner-one", revalidate: async () => {} };
  return { root, cwd, files, service, access, stream, readRetained, joinParticipant, deps };
}
async function settled(f: Awaited<ReturnType<typeof setup>>, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = await f.service.get(f.access, id);
    if (!["inventory", "analyzing"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error("Fake job did not settle");
}
const bodyReads = () => vi.mocked(readBoundedRegular).mock.calls.filter(call => call[0].endsWith(".jsonl") && path.basename(path.dirname(call[0])) === "history").map(call => call[0]);

describe("res-workflow explicit history selection", () => {
  it("lists bounded registered/unregistered/retained metadata without body or model reads", async () => {
    const f = await setup();
    const result = await f.service.historyCandidates(f.access);
    expect(result.candidates).toHaveLength(4);
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "loose-session", registered: false }), expect.objectContaining({ sessionId: "remote-session", kind: "retained", incomplete: true })]));
    expect(JSON.stringify(result)).not.toMatch(/QA_SELECTED|QA_UNSELECTED|QA_REMOTE|sessionFile|history\//);
    expect(bodyReads()).toEqual([]); expect(f.readRetained).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled();
  });

  it("returns a bounded partial candidate list when its metadata deadline expires", async () => {
    const f = await setup(); const start = Date.now(); let tick = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => start + tick++ * 100);
    try {
      const result = await discoverHistoryCandidates({ cwd: f.cwd, history: f.deps.history(), historyRoots: [], signal: new AbortController().signal, revalidate: f.access.revalidate, limits: { timeoutMs: 150 } }, f.access.ownerKey);
      expect(result.partial).toBe(true); expect(result.candidates).toHaveLength(1);
      expect(result.skipped).toContainEqual({ label: "Pi history", reason: "time-budget" });
      expect(bodyReads()).toEqual([]); expect(f.readRetained).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it("requires an explicit selection on new creates; missing is never all histories", async () => {
    const f = await setup();
    await expect(f.service.create(f.access, { cwd: f.cwd, requestId: "no-scope", model, consent } as any)).rejects.toMatchObject({ statusCode: 400, code: "explicit-history-selection-required" });
    expect(bodyReads()).toEqual([]); expect(f.stream).not.toHaveBeenCalled();
  });

  it("empty selection means files only and reads no local or retained body", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, requestId: "only-files", historySelection: [], model, consent });
    const job = await settled(f, created.id);
    expect(job.status).toBe("proposal-ready"); expect(job.historySelection).toEqual([]);
    expect(job.sources.every(source => source.kind !== "session-message")).toBe(true);
    expect(bodyReads()).toEqual([]); expect(f.readRetained).not.toHaveBeenCalled();
    expect(JSON.stringify(f.stream.mock.calls)).not.toMatch(/QA_UNSELECTED|QA_SELECTED|QA_REMOTE/);
  });

  it("only selected local normal messages enter the snapshot and model context", async () => {
    const f = await setup(); const listed = await f.service.historyCandidates(f.access);
    const selected = listed.candidates.find(candidate => candidate.sessionId === "session-one")!;
    const created = await f.service.create(f.access, { cwd: f.cwd, requestId: "one-history", historySelection: [selected.id], model, consent });
    const job = await settled(f, created.id);
    expect(job.status).toBe("proposal-ready"); expect(job.selectedHistories).toEqual([selected]);
    expect(job.sources.filter(source => source.kind === "session-message").map(source => source.sessionId)).toEqual(["session-one"]);
    expect(bodyReads()).toEqual([f.files.one]); expect(f.readRetained).not.toHaveBeenCalled();
    const context = JSON.stringify(f.stream.mock.calls);
    expect(context).toContain("QA_SELECTED_RESEARCH"); expect(context).not.toMatch(/QA_UNSELECTED_CHAT|QA_REMOTE_CHAT|QA_UNREGISTERED_HISTORY/);
  });

  it("normalizes selection-set order for idempotency and rejects a changed set", async () => {
    const f = await setup(); const listed = await f.service.historyCandidates(f.access);
    const ids = listed.candidates.filter(candidate => candidate.kind === "local").slice(0, 2).map(candidate => candidate.id);
    const request = { cwd: f.cwd, requestId: "same-selection", historySelection: ids, model, consent };
    const first = await f.service.create(f.access, request); await settled(f, first.id);
    const second = await f.service.create(f.access, { ...request, historySelection: [...ids].reverse() });
    expect(second.id).toBe(first.id); expect(f.stream).toHaveBeenCalledTimes(1);
    await expect(f.service.create(f.access, { ...request, historySelection: [] })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("rejects unknown or another owner's candidate before any body read", async () => {
    const f = await setup(); const listed = await f.service.historyCandidates(f.access);
    const chosen = listed.candidates[0];
    await expect(f.service.create({ ...f.access, ownerKey: "other-owner" }, { cwd: f.cwd, requestId: "foreign-scope", historySelection: [chosen.id], model, consent })).rejects.toMatchObject({ statusCode: 404 });
    await expect(f.service.create(f.access, { cwd: f.cwd, requestId: "forged-scope", historySelection: ["hist-forged"], model, consent })).rejects.toMatchObject({ statusCode: 404 });
    expect(bodyReads()).toEqual([]); expect(f.stream).not.toHaveBeenCalled();
  });

  it("source confirmation and participant failures are separate, and join retry never reanalyzes", async () => {
    const f = await setup(); const listed = await f.service.historyCandidates(f.access);
    const chosen = listed.candidates.find(candidate => candidate.sessionId === "session-one")!;
    f.joinParticipant.mockRejectedValueOnce(new Error("participant-write-failed"));
    const created = await f.service.create(f.access, { cwd: f.cwd, requestId: "join-later", historySelection: [chosen.id], model, consent });
    const job = await settled(f, created.id);
    const confirmed = await f.service.confirm(f.access, created.id, { cwd: f.cwd, proposalHash: job.proposalHash!, objective: "Confirmed objective", successCriteria: ["Checked evidence"] });
    expect(confirmed.status).toBe("confirmed"); expect(confirmed.participantFailures).toEqual([{ sessionId: "session-one", reason: "participant-write-failed" }]);
    await f.service.joinParticipant(f.access, "session-one");
    expect((await f.service.snapshot(f.access)).adoption?.participantFailures).toEqual([]);
    expect(f.stream).toHaveBeenCalledTimes(1);
  });
});
