import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createResWorkflowService, type ResWorkflowAccess } from "../res-workflow/adoption-service.js";
import type { ResolvedAnalysisModel } from "../res-workflow/strict-model.js";
import { inventoryResearch, type InventoryOptions } from "../res-workflow/inventory.js";

const temporary: string[] = [];
const services: Array<{ dispose(): void }> = [];
afterEach(async () => { for (const s of services.splice(0)) s.dispose(); await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
const model = { provider: "fixture", id: "physical-model" };
const consent = { scope: "research-files-and-normal-messages" as const, includeUnpublished: true as const };
const researchLoopRoot = fileURLToPath(new URL("../../../../../research-loop", import.meta.url));

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "res-service-")); temporary.push(root);
  const cwd = path.join(root, "project"); await fs.mkdir(cwd);
  await fs.writeFile(path.join(cwd, "research.md"), "A PRIVATE NORMAL MESSAGE retained only in its finite snapshot");
  let fingerprint = "configuration-one";
  const stream = vi.fn(async function* (_model: unknown, context: any) {
    const materials = JSON.parse(context.messages[0].content[0].text).sources;
    const proposal = { summary: "Unverified imported research", objective: "Test the imported hypothesis", successCriteria: ["Independent evidence"], unresolved: ["Result not verified"], items: [{ text: "A historical lead, not an accepted claim", sourceIds: [materials[0].id] }] };
    yield { type: "text_delta", delta: JSON.stringify(proposal) };
    yield { type: "done", message: { content: [] } };
  });
  const resolve = vi.fn(async (provider: string, id: string): Promise<ResolvedAnalysisModel> => {
    if (provider !== model.provider || id !== model.id) throw new Error("Selected model unavailable");
    return { provider, id, fingerprint, contextWindow: 64000, maxTokens: 4096, model, runtime: { getModels: () => [], getPhysicalModel: () => undefined, checkAuth: async () => true, streamSimple: stream } };
  });
  const deps = { privateDir: path.join(root, "private"), researchLoopRoot, history: () => [], historyRoots: () => [], resolveModel: resolve, listModels: async () => [model] };
  const service = createResWorkflowService(deps); services.push(service);
  const access: ResWorkflowAccess = { cwd, ownerKey: "owner-one", revalidate: async () => {} };
  return { root, cwd, deps, service, access, stream, resolve, changeConfiguration: () => { fingerprint = "configuration-two"; } };
}

async function settle(service: ReturnType<typeof createResWorkflowService>, access: ResWorkflowAccess, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = await service.get(access, id);
    if (!["inventory", "analyzing"].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("fixture job did not settle");
}

describe("res-workflow private adoption service", () => {
  it("a read or cancelled first-entry step neither scans nor creates research state or a model call", async () => {
    const f = await setup();
    expect(await f.service.snapshot(f.access)).toMatchObject({ adopted: false, adoption: null, research: { "state.json": null } });
    expect(f.stream).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(f.cwd, ".pi"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("local-only inventory waits for a separate explicit model consent and saves no chat body in the project", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "inventory-one" });
    const job = await settle(f.service, f.access, created.id);
    expect(job.status).toBe("awaiting-model"); expect(f.stream).not.toHaveBeenCalled();
    const manifest = await fs.readFile(path.join(f.cwd, ".pi/research-loop/adoptions", job.id, "manifest.json"), "utf8");
    expect(manifest).not.toContain("A PRIVATE NORMAL MESSAGE"); expect(manifest).not.toMatch(/consent|ownerKey/);
    expect((await f.service.source(f.access, job.id, job.sources[0].id)).content).toContain("A PRIVATE NORMAL MESSAGE");
    await expect(f.service.source(f.access, job.id, "../../.env")).rejects.toMatchObject({ statusCode: 404 });
    await expect(fs.stat(path.join(f.cwd, ".pi/research-loop/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires actual request consent; a project consent:true cannot authorize analysis", async () => {
    const f = await setup();
    await fs.writeFile(path.join(f.cwd, "config.json"), '{"consent":true}');
    await expect(f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "missing-consent", model })).rejects.toMatchObject({ statusCode: 400 });
    expect(f.stream).not.toHaveBeenCalled();
  });

  it("binds one finite snapshot to one physical model, with no tools or scientific writes", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "analyze-one", model, consent });
    const job = await settle(f.service, f.access, created.id);
    expect(job.status).toBe("proposal-ready"); expect(f.stream).toHaveBeenCalledTimes(1);
    expect(f.stream.mock.calls[0][0]).toEqual(model);
    expect(f.stream.mock.calls[0][1].tools).toEqual([]);
    expect(f.stream.mock.calls[0][1].systemPrompt).toMatch(/untrusted|data/i);
    expect(job.proposal?.items[0]).toMatchObject({ unverified: true });
    await expect(fs.stat(path.join(f.cwd, ".pi/research-loop/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(f.cwd, ".pi/research-loop/ledger.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requestId is idempotent, scope has a single flight, and another owner cannot read the job", async () => {
    const f = await setup();
    const request = { cwd: f.cwd, historySelection: [], requestId: "same-request", model, consent };
    const [a, b] = await Promise.all([f.service.create(f.access, request), f.service.create(f.access, request)]);
    expect(a.id).toBe(b.id);
    await settle(f.service, f.access, a.id);
    expect(f.stream).toHaveBeenCalledTimes(1);
    await expect(f.service.get({ ...f.access, ownerKey: "owner-two" }, a.id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(f.service.create(f.access, { ...request, model: { provider: "wrong", id: "other" } })).rejects.toMatchObject({ statusCode: 409 });
  });

  it("missing explicit model blocks instead of falling back or creating a Pi task", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "missing-model", model: { provider: "missing", id: "missing" }, consent });
    const job = await settle(f.service, f.access, created.id);
    expect(job.status).toBe("blocked"); expect(f.stream).not.toHaveBeenCalled();
    expect(f.resolve.mock.calls.every(([provider]) => provider === "missing")).toBe(true);
    expect((await f.service.cancel(f.access, job.id)).status).toBe("cancelled");
    expect((await f.service.cancel(f.access, job.id)).status).toBe("cancelled");
    const retry = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "explicit-new-request", model, consent });
    expect(retry.id).not.toBe(job.id);
    expect((await settle(f.service, f.access, retry.id)).status).toBe("proposal-ready");
    expect(f.stream).toHaveBeenCalledTimes(1);
  });

  it("confirmation freezes a new charter only after proposal and target confirmation, without autoRun", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "confirmed", model, consent });
    const job = await settle(f.service, f.access, created.id);
    await expect(f.service.confirm(f.access, job.id, { cwd: f.cwd, proposalHash: "forged", objective: "bad", successCriteria: ["bad"] })).rejects.toMatchObject({ statusCode: 409 });
    const confirmed = await f.service.confirm(f.access, job.id, { cwd: f.cwd, proposalHash: job.proposalHash!, objective: job.proposal!.objective, successCriteria: job.proposal!.successCriteria });
    expect(confirmed.status).toBe("confirmed");
    const snapshot = await f.service.snapshot(f.access);
    expect(snapshot.adopted).toBe(true);
    expect(JSON.parse(snapshot.research["state.json"]!)).toMatchObject({ attempts: 0, claims: [], charter: { objective: job.proposal!.objective } });
    expect(snapshot.research["ledger.jsonl"]).toBeNull(); expect(snapshot.research["auto-run.json"]).toBeNull();
    expect((await f.service.snapshot(f.access)).adoption?.id).toBe(job.id); expect(f.stream).toHaveBeenCalledTimes(1);
  });

  it("detects concurrent charter creation and never overwrites it", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "charter-race", model, consent });
    const job = await settle(f.service, f.access, created.id);
    const stateFile = path.join(f.cwd, ".pi/research-loop/state.json");
    const state = JSON.stringify({ charter: { objective: "Concurrent target", revision: 1 }, claims: [] });
    await fs.writeFile(stateFile, state);
    await expect(f.service.confirm(f.access, job.id, { cwd: f.cwd, proposalHash: job.proposalHash!, objective: job.proposal!.objective, successCriteria: job.proposal!.successCriteria })).rejects.toMatchObject({ statusCode: 409 });
    expect(await fs.readFile(stateFile, "utf8")).toBe(state);
  });

  it("refuses malformed or symlinked scientific state rather than reporting it empty", async () => {
    const f = await setup();
    await fs.mkdir(path.join(f.cwd, ".pi/research-loop"), { recursive: true });
    await fs.writeFile(path.join(f.cwd, ".pi/research-loop/state.json"), "broken");
    await expect(f.service.snapshot(f.access)).rejects.toMatchObject({ statusCode: 409 });
    await fs.unlink(path.join(f.cwd, ".pi/research-loop/state.json"));
    await fs.symlink(path.join(f.cwd, "research.md"), path.join(f.cwd, ".pi/research-loop/state.json"));
    await expect(f.service.snapshot(f.access)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("cancellation and per-directory single flight fence a scan before any outbound request", async () => {
    const f = await setup();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inventoryStarted = new Promise<void>((resolve) => { entered = resolve; });
    Object.assign(f.deps, { inventory: async (options: InventoryOptions) => { entered(); await gate; return inventoryResearch(options); } });
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "cancel-scan-one", model, consent });
    await inventoryStarted;
    await expect(f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "parallel-scan-two" })).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.service.cancel(f.access, created.id)).status).toBe("cancelled");
    release(); await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await f.service.get(f.access, created.id)).status).toBe("cancelled"); expect(f.stream).not.toHaveBeenCalled();
    await expect(fs.stat(path.join(f.cwd, ".pi/research-loop/state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("an explicitly cancelled operation does not prevent immediate re-entry or reclaim the new current operation", async () => {
    const f = await setup(); let first = true; let release!: () => void; let entered!: () => void; let finished!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const stopped = new Promise<void>(resolve => { finished = resolve; });
    Object.assign(f.deps, { inventory: async (options: InventoryOptions) => {
      if (!first) return inventoryResearch(options);
      first = false; entered();
      try { await gate; return await inventoryResearch(options); } finally { finished(); }
    } });
    const previous = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "cancel-before-reentry", model, consent });
    await started; await f.service.cancel(f.access, previous.id);
    try {
      const next = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "explicit-reentry", model, consent });
      expect((await settle(f.service, f.access, next.id)).status).toBe("proposal-ready");
      release(); await stopped;
      expect((await f.service.get(f.access, previous.id)).status).toBe("cancelled");
      expect((await f.service.snapshot(f.access)).adoption?.id).toBe(next.id); expect(f.stream).toHaveBeenCalledTimes(1);
    } finally { release(); await stopped; }
  });

  it("a changed model configuration invalidates the pre-scan consent rather than changing the receiver", async () => {
    const f = await setup();
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const inventoryStarted = new Promise<void>((resolve) => { entered = resolve; });
    Object.assign(f.deps, { inventory: async (options: InventoryOptions) => { entered(); await gate; return inventoryResearch(options); } });
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "config-change", model, consent });
    await inventoryStarted; f.changeConfiguration(); release();
    const job = await settle(f.service, f.access, created.id);
    expect(job.status).toBe("blocked"); expect(job.error).toMatch(/configuration-changed/); expect(f.stream).not.toHaveBeenCalled();
  });

  it("explicit analysis consumes only the sealed finite snapshot, not new or changed project files", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "snapshot-scan" });
    await settle(f.service, f.access, created.id);
    await fs.writeFile(path.join(f.cwd, "research.md"), "NEW UNAUTHORIZED MATERIAL");
    await fs.writeFile(path.join(f.cwd, "later.md"), "LATER FILE MUST NOT BE READ");
    await f.service.analyze(f.access, created.id, { cwd: f.cwd, requestId: "explicit-analyze", model, consent });
    const job = await settle(f.service, f.access, created.id);
    expect(job.status).toBe("proposal-ready");
    const prompt = f.stream.mock.calls[0][1].messages[0].content[0].text;
    expect(prompt).toContain("A PRIVATE NORMAL MESSAGE"); expect(prompt).not.toMatch(/NEW UNAUTHORIZED|LATER FILE/);
    const privateFiles = await fs.readdir(f.deps.privateDir);
    expect(privateFiles).toHaveLength(1);
    expect((await fs.stat(f.deps.privateDir)).mode & 0o777).toBe(0o700);
  });

  it("history owner revocation fences finite source preview and the later model send", async () => {
    const f = await setup(); const history = path.join(f.root, "history.jsonl");
    await fs.writeFile(history, [JSON.stringify({ type: "session", id: "owned-history", cwd: f.cwd }), JSON.stringify({ type: "message", id: "normal-entry", message: { role: "user", content: "Owner-bound historical note" } })].join("\n") + "\n");
    let owned = true;
    const access = { ...f.access, canReadHistory: async () => owned };
    Object.assign(f.deps, { history: () => [{ id: "owned-history", cwd: f.cwd, sessionFile: history }] });
    const historySelection = (await f.service.historyCandidates(access)).candidates.map(candidate => candidate.id);
    const created = await f.service.create(access, { cwd: f.cwd, historySelection, requestId: "owner-history-scan" });
    const scanned = await settle(f.service, access, created.id);
    const source = scanned.sources.find((s) => s.kind === "session-message")!; expect(source).toBeTruthy();
    owned = false;
    await expect(f.service.source(access, created.id, source.id)).rejects.toMatchObject({ statusCode: 403 });
    await f.service.analyze(access, created.id, { cwd: f.cwd, requestId: "owner-revoked-send", model, consent });
    expect((await settle(f.service, access, created.id)).status).toBe("blocked"); expect(f.stream).not.toHaveBeenCalled();
  });

  it("a provider ignoring abort becomes an explicit unknown result, never an automatic resend", async () => {
    const f = await setup();
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    f.stream.mockImplementation(async function* () { await gate; yield { type: "done", message: { content: [] } }; });
    Object.assign(f.deps, { analysisTimeoutMs: 10 });
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "unknown-result", model, consent });
    const job = await settle(f.service, f.access, created.id);
    expect(job.status).toBe("blocked"); expect(job.error).toMatch(/unknown/); expect(f.stream).toHaveBeenCalledTimes(1);
    await expect(f.service.analyze(f.access, job.id, { cwd: f.cwd, requestId: "no-automatic-retry", model, consent })).rejects.toMatchObject({ statusCode: 409 });
    release();
  });

  it("a restart reconciles an unknown send without scanning, resending or trusting project status", async () => {
    const f = await setup();
    const created = await f.service.create(f.access, { cwd: f.cwd, historySelection: [], requestId: "restart-1", model, consent });
    const job = await settle(f.service, f.access, created.id);
    const recordFiles: string[] = [];
    const walk = async (dir: string) => { for (const e of await fs.readdir(dir, { withFileTypes: true })) { const p = path.join(dir, e.name); if (e.isDirectory()) await walk(p); else if (e.name === `${job.id}.json`) recordFiles.push(p); } };
    await walk(f.deps.privateDir);
    const record = JSON.parse(await fs.readFile(recordFiles[0], "utf8")); record.adoption.status = "analyzing";
    await fs.writeFile(recordFiles[0], JSON.stringify(record));
    f.service.dispose();
    const restarted = createResWorkflowService(f.deps); services.push(restarted);
    const recovered = await restarted.get(f.access, job.id);
    expect(recovered.status).toBe("blocked"); expect(recovered.error).toMatch(/interrupted|unknown/i); expect(f.stream).toHaveBeenCalledTimes(1);
  });
});
