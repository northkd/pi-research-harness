import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { inventoryResearch } from "../res-workflow/inventory.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true }))); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "res-inventory-")); dirs.push(root);
  const cwd = path.join(root, "project"); const histories = path.join(root, "history");
  await fs.mkdir(cwd); await fs.mkdir(histories);
  const options = { cwd, historyRoots: [histories], history: [], signal: new AbortController().signal, revalidate: async () => {} };
  return { root, cwd, histories, options };
}
function transcript(cwd: string, id = "session-one") {
  return [
    { type: "session", id, cwd, timestamp: "2026-10-01T01:00:00Z" },
    { type: "message", id: "m1", parentId: null, timestamp: "2026-10-01T01:00:01Z", message: { role: "user", content: "Research objective" } },
    { type: "message", id: "discarded", parentId: "m1", message: { role: "assistant", content: [{ type: "text", text: "Off branch" }] } },
    { type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: [{ type: "thinking", thinking: "Private visible thinking excluded" }, { type: "toolCall", arguments: { command: "never run" } }, { type: "text", text: "A normal result; inspect results.csv" }] } },
  ].map((v) => JSON.stringify(v)).join("\n") + "\n";
}

describe("res-workflow bounded read-only inventory", () => {
  it("includes only admitted regular research files and metadata for large/binary artifacts", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "goal.md"), "A falsifiable objective");
    await fs.writeFile(path.join(f.cwd, ".env"), "NEVER_READ_THIS");
    await fs.mkdir(path.join(f.cwd, "node_modules")); await fs.writeFile(path.join(f.cwd, "node_modules", "hidden.md"), "dependency");
    await fs.writeFile(path.join(f.root, "outside.md"), "outside");
    await fs.symlink(path.join(f.root, "outside.md"), path.join(f.cwd, "linked.md"));
    await fs.writeFile(path.join(f.cwd, "data.pdf"), Buffer.from([0, 1, 2, 3]));
    execFileSync("mkfifo", [path.join(f.cwd, "pipe.txt")]);
    const result = await inventoryResearch(f.options);
    expect(Object.values(result.content).join("\n")).toContain("A falsifiable objective");
    expect(Object.values(result.content).join("\n")).not.toMatch(/NEVER_READ_THIS|outside|dependency/);
    expect(result.sources.find((s) => s.path === "data.pdf")).toMatchObject({ kind: "artifact", incomplete: true, unverified: true });
    expect(result.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ label: "linked.md", reason: "symlink" }), expect.objectContaining({ label: "pipe.txt", reason: "not-regular" })]));
  });

  it("unions configured history with registered and archived candidates but verifies actual header cwd", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.histories, "encoded"));
    const file = path.join(f.histories, "encoded", "one.jsonl");
    await fs.writeFile(file, transcript(f.cwd) + "broken-json\n");
    await fs.writeFile(path.join(f.histories, "foreign.jsonl"), transcript(f.root, "other"));
    const result = await inventoryResearch({ ...f.options, history: [{ id: "session-one", cwd: f.cwd, sessionFile: file, originDeviceId: undefined }] });
    expect(result.sources.filter((s) => s.kind === "session-message").map((s) => s.entryId)).toEqual(["m1", "m2"]);
    const all = Object.values(result.content).join("\n");
    expect(all).toContain("A normal result");
    expect(all).not.toMatch(/Private visible|never run|Off branch/);
    expect(result.sources.find((s) => s.entryId === "m1")).toMatchObject({ timestamp: "2026-10-01T01:00:01Z", incomplete: true });
    expect(result.sources.find((s) => s.entryId === "m2")?.timestamp).toBeUndefined();
    expect(result.partial).toBe(true);
  });

  it("never reads a remote claimed local path and uses only bounded retained transcripts", async () => {
    const f = await fixture();
    const local = path.join(f.root, "claimed.jsonl"); await fs.writeFile(local, transcript(f.cwd, "remote"));
    const absent = await inventoryResearch({ ...f.options, history: [{ id: "remote", cwd: f.cwd, sessionFile: local, originDeviceId: "other-device" }] });
    expect(absent.sources.filter((s) => s.kind === "session-message")).toEqual([]);
    expect(absent.skipped.some((s) => s.reason === "retained-transcript-unavailable")).toBe(true);
    const retained = await inventoryResearch({ ...f.options, history: [{ id: "remote", cwd: f.cwd, sessionFile: local, originDeviceId: "other-device" }], readRetained: async () => ({ raw: transcript(f.cwd, "remote"), retained: true, complete: false }) });
    expect(retained.sources.filter((s) => s.kind === "session-message")).toHaveLength(2);
    expect(retained.sources.filter((s) => s.kind === "session-message").every((s) => s.incomplete)).toBe(true);
  });

  it("reports explicit budgets, checks cancellation and never creates scientific state", async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.cwd, "a.md"), "a".repeat(200));
    await fs.writeFile(path.join(f.cwd, "b.md"), "b".repeat(200));
    const limited = await inventoryResearch({ ...f.options, limits: { maxFiles: 1, maxTextBytes: 100 } });
    expect(limited.partial).toBe(true);
    expect(limited.skipped.some((s) => /budget/.test(s.reason))).toBe(true);
    const abort = new AbortController(); abort.abort();
    await expect(inventoryResearch({ ...f.options, signal: abort.signal })).rejects.toThrow(/cancel/i);
    await expect(fs.stat(path.join(f.cwd, ".pi", "research-loop", "state.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
