import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResWorkflowAdoption } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { useResearchWorkbenchLive } from "../use-research-workbench-live.js";
const charter = { objective: "confirmed objective", successCriteria: ["verified"], revision: 1 };
const adoption = { id: "adoption-1", cwd: "/project", charterHash: `sha256:${"0".repeat(64)}` } as ResWorkflowAdoption;
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const digest = vi.fn(async (_algorithm: string, bytes: Uint8Array) => {
  const changed = new TextDecoder().decode(bytes) !== JSON.stringify(charter);
  return new Uint8Array(32).fill(changed ? 0xcd : 0xab).buffer;
});
const value = () => ({ schema: "res-workflow.workbench-observation.v1", cwd: "/project", adoptionId: adoption.id, charterHash: `sha256:${"ab".repeat(32)}`, revision: `sha256:${"b".repeat(64)}`, updatedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), coverage: { partial: false, reasons: [], parentSessions: 1, nativeRuns: 0 }, executions: [{ id: "pi:main", kind: "pi-session", sessionId: "main", status: "streaming", observedModel: "actual/model" }], relations: [], observedUsage: { responses: 2, inputTokens: 3, outputTokens: 4, inheritedExcluded: 1, metric: "observed-assistant-responses" } });
async function flush() { await act(async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); }); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-10-30T10:00:00.000Z")); digest.mockClear(); vi.stubGlobal("crypto", { subtle: { digest } }); Object.defineProperty(document, "hidden", { configurable: true, value: false }); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("owner-scoped scientific execution observations", () => {
  it("hashes the current raw charter instead of the pre-confirmation adoption hash", async () => {
    const fetcher = vi.fn(async () => response(value())); vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useResearchWorkbenchLive({ cwd: "/project", adopted: true, adoption, charter })); await flush();
    expect(result.current.observationStatus).toBe("current"); expect(result.current.workbench?.charterHash).not.toBe(adoption.charterHash);
    expect(digest).toHaveBeenCalledWith("SHA-256", new TextEncoder().encode(JSON.stringify(charter)));
  });
  it("refreshes every five seconds and retains stale observations after network failure", async () => {
    const fetcher = vi.fn(async () => response(value())).mockRejectedValueOnce(new Error("private secret")); vi.stubGlobal("fetch", fetcher);
    const { result } = renderHook(() => useResearchWorkbenchLive({ cwd: "/project", adopted: true, adoption, charter })); await flush(); expect(result.current.workbench).toBeNull();
    await act(async () => vi.advanceTimersByTime(5000)); await flush(); expect(result.current.observationStatus).toBe("current");
    fetcher.mockRejectedValueOnce(new Error("private secret")); await act(async () => vi.advanceTimersByTime(5000)); await flush();
    expect(result.current.observationStatus).toBe("stale"); expect(result.current.workbench?.executions).toHaveLength(1); expect(result.current.observationError).not.toContain("secret");
  });
  it("fences changed current charters and rejects payloads for another adoption", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(value())));
    const { result, rerender } = renderHook(({ currentCharter, currentAdoption }) => useResearchWorkbenchLive({ cwd: "/project", adopted: true, adoption: currentAdoption, charter: currentCharter }), { initialProps: { currentCharter: charter, currentAdoption: adoption } });
    await flush(); expect(result.current.workbench).not.toBeNull();
    rerender({ currentCharter: { ...charter, revision: 2 }, currentAdoption: adoption }); expect(result.current.workbench).toBeNull(); await flush(); expect(result.current.workbench).toBeNull();
    rerender({ currentCharter: charter, currentAdoption: { ...adoption, id: "foreign" } }); await flush(); expect(result.current.workbench).toBeNull();
  });
  it("clears cached observation records on hard refusal and does not accept an unproven crypto fallback", async () => {
    const fetcher = vi.fn(async () => response(value())); vi.stubGlobal("fetch", fetcher);
    const view = renderHook(() => useResearchWorkbenchLive({ cwd: "/project", adopted: true, adoption, charter })); await flush(); expect(view.result.current.workbench).not.toBeNull();
    fetcher.mockResolvedValueOnce(response({ error: "private forbidden" }, 403)); await act(async () => vi.advanceTimersByTime(5000)); await flush(); expect(view.result.current.workbench).toBeNull(); view.unmount();
    vi.stubGlobal("crypto", {}); fetcher.mockClear(); const noProof = renderHook(() => useResearchWorkbenchLive({ cwd: "/project", adopted: true, adoption, charter })); await flush(); expect(noProof.result.current.observationStatus).toBe("unavailable"); expect(fetcher).not.toHaveBeenCalled();
  });
});
