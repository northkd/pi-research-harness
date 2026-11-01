import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryResearch } from "../res-workflow/inventory.js";
import { createRemoteTranscriptStore } from "../session/remote-transcript-store.js";
import { loadAndReplay } from "../session/session-load-worker.js";
import { createSessionLoadWorkerPool } from "../session/session-load-worker-pool.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
async function root() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), "res-history-boundary-")); roots.push(dir); return dir; }
function lines(cwd: string) {
  return [
    JSON.stringify({ type: "session", id: "history-fixture", cwd }),
    JSON.stringify({ type: "message", id: "one", parentId: null, timestamp: "2026-10-01T00:00:00Z", message: { role: "user", content: "Normal message" } }),
    JSON.stringify({ type: "message", id: "two", parentId: "one", message: { role: "assistant", content: [{ type: "thinking", thinking: "Do not import" }, { type: "text", text: "A bounded normal answer" }, { type: "toolCall", name: "bash", arguments: { command: "not allowed" } }] } }),
    JSON.stringify({ type: "message", id: "three", parentId: "two", message: { role: "toolResult", content: [{ type: "text", text: "Tool result must not import" }] } }),
  ];
}

describe("res-workflow history boundary reuse", () => {
  it("the existing hydration worker's narrow mode returns normal branch entries but no replay/events", () => {
    const result = loadAndReplay({ jobId: 1, sessionId: "history-fixture", raw: lines("/qa/project").join("\n") + "\n", mode: "research-messages" });
    expect(result.success).toBe(true); expect(result.events).toEqual([]);
    expect(result.researchMessages?.map((m) => m.text)).toEqual(["Normal message", "A bounded normal answer"]);
    expect(result.researchMessages?.map((m) => m.entryId)).toEqual(["one", "two"]);
  });

  it("local inventory streams admitted normal messages without sending a whole transcript to the parser pool", async () => {
    const dir = await root(); const cwd = path.join(dir, "project"); const histories = path.join(dir, "history");
    await fs.mkdir(cwd); await fs.mkdir(histories);
    await fs.writeFile(path.join(histories, "session.jsonl"), lines(cwd).join("\n") + "\n");
    const pool = createSessionLoadWorkerPool({ useWorker: false }); const load = vi.spyOn(pool, "load");
    try {
      const result = await inventoryResearch({ cwd, history: [], historyRoots: [histories], signal: new AbortController().signal, revalidate: async () => {}, pool });
      expect(result.sources.map((s) => s.entryId)).toEqual(["one", "two"]);
      expect(load).not.toHaveBeenCalled();
      expect(result.historyBindings).toEqual([expect.objectContaining({ id: "history-fixture", cwd, unregistered: true })]);
    } finally { await pool.dispose(); }
  });

  it("a foreign cwd header is excluded before its oversized conversation body is read", async () => {
    const dir = await root(); const cwd = path.join(dir, "project"); const histories = path.join(dir, "history");
    await fs.mkdir(cwd); await fs.mkdir(histories);
    await fs.writeFile(path.join(histories, "foreign.jsonl"), JSON.stringify({ type: "session", id: "foreign", cwd: dir }) + "\n" + "x".repeat(2 * 1024 * 1024));
    const result = await inventoryResearch({ cwd, history: [], historyRoots: [histories], signal: new AbortController().signal, revalidate: async () => {} });
    expect(result.sources).toEqual([]);
    expect(result.skipped.some((s) => s.reason === "history-byte-budget")).toBe(false);
  });

  it("the retained store exposes a finite verified read and never follows a retained-file symlink", async () => {
    const home = await root(); const store = createRemoteTranscriptStore({ homedir: home });
    store.append("retained-fixture", lines("/qa/project"), { restarted: true, complete: true });
    await expect(store.readRawBounded!("retained-fixture", 10)).rejects.toThrow(/budget/);
    expect(await store.readRawBounded!("retained-fixture", 8192)).toMatchObject({ retained: true, complete: true });
    const file = path.join(home, ".pi/dashboard/remote-transcripts/retained-fixture.jsonl");
    const outside = path.join(home, "outside.jsonl"); await fs.writeFile(outside, "DO NOT READ THIS");
    await fs.unlink(file); await fs.symlink(outside, file);
    await expect(store.readRawBounded!("retained-fixture", 8192)).rejects.toThrow(/symlink|outside/);
  });
});
