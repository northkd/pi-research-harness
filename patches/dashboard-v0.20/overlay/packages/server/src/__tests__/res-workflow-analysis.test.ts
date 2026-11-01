import { describe, expect, it, vi } from "vitest";
import type { ResWorkflowSource } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { ADOPTION_SYSTEM_PROMPT, analyzeSnapshot, validateProposal } from "../res-workflow/analysis.js";
import type { ResolvedAnalysisModel } from "../res-workflow/strict-model.js";

const sources: ResWorkflowSource[] = [{ id: "src-one", kind: "file", path: "research.md", label: "research.md", sha256: "fixture", bytes: 20, incomplete: false, unverified: true }];
const proposal = { summary: "A concrete draft", objective: "A falsifiable target", successCriteria: ["Independent evidence"], unresolved: ["Historical result unverified"], items: [{ text: "Historical observation", sourceIds: ["src-one"], accepted: true }], accepted: true, publicationAuthorized: true };
function fixture(events: unknown[]) {
  const stream = vi.fn(async function* (_model: unknown, _context: unknown) { for (const event of events) yield event; });
  const model: ResolvedAnalysisModel = { provider: "fixture", id: "chosen", baseUrl: "https://fixture.example/v1", fingerprint: "one", contextWindow: 64000, maxTokens: 4096, model: {}, runtime: { getModels: () => [], getPhysicalModel: () => undefined, checkAuth: async () => true, streamSimple: stream } };
  return { model, stream };
}

describe("res-workflow no-tools analysis contract", () => {
  it("accepts only bounded structured drafts with real source references; scientific authority is never copied", () => {
    const parsed = validateProposal(JSON.stringify(proposal), sources);
    expect(parsed.items[0]).toEqual({ text: "Historical observation", sourceIds: ["src-one"], unverified: true });
    expect(parsed).not.toHaveProperty("accepted"); expect(parsed).not.toHaveProperty("publicationAuthorized");
    expect(() => validateProposal(JSON.stringify({ ...proposal, items: [{ text: "Forged", sourceIds: ["not-in-snapshot"] }] }), sources)).toThrow(/source/);
    expect(() => validateProposal(JSON.stringify({ ...proposal, successCriteria: [] }), sources)).toThrow(/invalid/);
  });

  it("ignores visible thinking deltas and requires a completed text-only response", async () => {
    const f = fixture([{ type: "thinking_delta", delta: "NOT IN THE DRAFT" }, { type: "text_delta", delta: JSON.stringify(proposal) }, { type: "done", message: { content: [] } }]);
    expect(await analyzeSnapshot(f.model, "finite materials", new AbortController().signal)).not.toContain("NOT IN THE DRAFT");
    expect(ADOPTION_SYSTEM_PROMPT).toMatch(/untrusted data/);
    const incomplete = fixture([{ type: "text_delta", delta: "{}" }]);
    await expect(analyzeSnapshot(incomplete.model, "materials", new AbortController().signal)).rejects.toThrow(/incomplete/);
  });

  it("never executes model-requested tools", async () => {
    const f = fixture([{ type: "toolcall_start", toolCall: { name: "bash", arguments: { command: "forbidden" } } }]);
    await expect(analyzeSnapshot(f.model, "materials", new AbortController().signal)).rejects.toThrow(/failed/);
    expect(f.stream.mock.calls[0][1]).toMatchObject({ tools: [] });
  });

  it("a context overflow, cancelled request, or changed auth endpoint sends no model request", async () => {
    const f = fixture([]);
    await expect(analyzeSnapshot({ ...f.model, contextWindow: 4096 }, "x".repeat(8000), new AbortController().signal)).rejects.toThrow(/budget/);
    const cancel = new AbortController(); cancel.abort();
    await expect(analyzeSnapshot(f.model, "materials", cancel.signal)).rejects.toThrow(/cancel/);
    f.model.runtime.getAuth = async () => ({ auth: { baseUrl: "https://changed.example/v1" } });
    await expect(analyzeSnapshot(f.model, "materials", new AbortController().signal)).rejects.toThrow(/endpoint-changed/);
    expect(f.stream).not.toHaveBeenCalled();
    const delayed = fixture([]); const order: string[] = [];
    delayed.model.runtime.getAuth = async () => { order.push("auth"); return { auth: {} }; };
    await expect(analyzeSnapshot(delayed.model, "materials", new AbortController().signal, async () => { order.push("owner"); throw new Error("source-owner-changed"); })).rejects.toThrow(/owner-changed/);
    expect(order).toEqual(["auth", "owner"]); expect(delayed.stream).not.toHaveBeenCalled();
  });
});
