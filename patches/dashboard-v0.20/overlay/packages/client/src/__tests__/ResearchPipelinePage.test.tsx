import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchPipelinePage } from "../components/research/ResearchPipelinePage.js";
vi.mock("@blackbelt-technology/dashboard-plugin-runtime", () => ({ useSessionSubagents: () => new Map(), randomUuid: () => "fixture-request-id", usePluginSocket: () => null, useShellConnectionStatus: () => "connected" }));
const CWD = "/research-project";
const charter = { objective: "验证科学记录与执行观测分别更新", successCriteria: ["有可追溯证据"], revision: 1 };
const state = { charter, phase: 2, claims: [] as unknown[] };
const adoption = { id: "adoption-1", cwd: CWD, status: "confirmed", createdAt: "2026-10-30T00:00:00.000Z", updatedAt: "2026-10-30T00:00:00.000Z", partial: false, progress: { files: 1, sessions: 0, bytes: 1 }, sources: [], skipped: [], charterHash: `sha256:${"0".repeat(64)}` };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function fakeApi({ initialState = state as unknown, events = [] as unknown[], adopted = false, observed = undefined as unknown } = {}) {
  let currentState = initialState, observation = observed, denied = false;
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const path = new URL(String(input), "http://localhost").pathname;
    if (path === "/api/res-workflow") return denied ? json({ error: "forbidden" }, 403) : json({ cwd: CWD, adopted, adoption: adopted ? adoption : null, research: { "state.json": typeof currentState === "string" ? currentState : JSON.stringify(currentState), "ledger.jsonl": "", "events.jsonl": events.map(row => JSON.stringify(row)).join("\n"), "auto-run.json": null } });
    if (path.endsWith("/workbench-sync")) return observation ? json(observation) : json({ error: "unavailable" }, 503);
    if (path.endsWith("/science/instances")) return json({ availability: "ready", instances: [] });
    return json({ error: "unavailable" }, 503);
  });
  vi.stubGlobal("fetch", fetcher); return { fetcher, setState: (next: unknown) => { currentState = next; }, setObservation: (next: unknown) => { observation = next; }, deny: () => { denied = true; } };
}
async function flush() { await vi.waitFor(() => expect(screen.queryByText("正在加载研究状态…")).toBeNull()); }
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("ResearchPipelinePage formal science and actual executions", () => {
  it("shows an unknown actual stage without filling default actors, models or a schematic workflow", async () => {
    fakeApi(); render(<ResearchPipelinePage cwd={CWD} />); await flush();
    expect(screen.getByTestId("research-current-stage").textContent).toBe("尚未登记研究阶段");
    expect(screen.queryAllByTestId("role-status")).toHaveLength(0); expect(screen.queryAllByTestId("research-agent-node")).toHaveLength(0);
    expect(document.body.textContent).not.toMatch(/astra\(high\)|glm-5|deepseek-v4/); expect(screen.queryByText("默认显示")).toBeNull();
    expect(screen.queryByTestId("research-live-activity")).toBeNull();
  });
  it("keeps explicit workflow steps and stage browsing functional without marking prior stages complete", async () => {
    fakeApi({ events: [{ kind: "run-registered", detail: { runId: "actual-run", charterRevision: 1 } }, { kind: "stage-enter", detail: { runId: "actual-run", stage: "2-experiment", sourceSeq: 1 } }, { kind: "run-step", detail: { runId: "actual-run", key: "real-step", agent: "research-numerics", stage: "2-experiment", status: "completed", observedModel: "actual/model", summary: "真实结果" } }] });
    render(<ResearchPipelinePage cwd={CWD} />); await flush(); expect(screen.getByTestId("research-current-stage").textContent).toBe("实验与验证");
    expect(screen.getAllByTestId("research-agent-node")).toHaveLength(1); expect(screen.getByText("最新观测模型：actual/model")).toBeTruthy();
    expect(screen.queryByText("已完成")).toBeNull(); fireEvent.click(screen.getByTestId("research-stage-3-review")); expect(screen.queryAllByTestId("research-agent-node")).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "跟随当前实际记录" })); expect(screen.getAllByTestId("research-agent-node")).toHaveLength(1);
  });
  it("shows every claim gate independently and exposes only safe evidence in the same pane", async () => {
    const open = vi.fn(); fakeApi({ initialState: { ...state, claims: [{ id: "accepted", statement: "one fact", status: "supported", acceptance: { verdict: "accepted", counterexample: { status: "completed" } }, publication: { authorized: true } }, { id: "blocked", statement: "still unresolved", status: "proposed", evidence: ["runs/result.csv", "../secret"], acceptance: { verdict: "blocked", diagnostics: ["second family missing"] } }] }, events: [{ kind: "review-gate", detail: { verdict: "blocked", diagnostics: ["review not complete"] } }] });
    render(<ResearchPipelinePage cwd={CWD} onOpenArtifact={open} />); await flush(); expect(screen.getAllByTestId("research-claim-gate")).toHaveLength(2);
    expect(screen.getByText(/1 \/ 2 条主张/)).toBeTruthy(); expect(screen.getByText("second family missing")).toBeTruthy(); expect(screen.getByText("review not complete")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "runs/result.csv" })); expect(open).toHaveBeenCalledWith("runs/result.csv"); expect(screen.queryByText("../secret")).toBeNull();
    expect(within(screen.getByTestId("research-claims")).getByText("发表已授权（非实际发表）")).toBeTruthy();
  });
  it("does not call an adopted directory unstarted and prepares continuation after checking current tasks", async () => {
    fakeApi({ adopted: true }); render(<ResearchPipelinePage cwd={CWD} />); await flush();
    expect(screen.getByTestId("research-current-stage").textContent).toBe("已接入，研究阶段尚未登记"); expect(screen.queryByText("已接入，尚未启动研究")).toBeNull();
    expect(screen.getByTestId("research-continue-choice").getAttribute("aria-pressed")).toBe("true");
  });
  it("refreshes formal claims and clears them after a directory denial while preserving honest errors", async () => {
    const api = fakeApi(); render(<ResearchPipelinePage cwd={CWD} />); await flush(); api.setState({ ...state, claims: [{ id: "new", statement: "new recorded claim", status: "proposed" }] });
    fireEvent.click(screen.getByRole("button", { name: "刷新", exact: true })); expect(await screen.findByText("new recorded claim")).toBeTruthy();
    api.deny(); fireEvent.click(screen.getByRole("button", { name: "刷新", exact: true })); expect(await screen.findByText(/无权读取科研记录/)).toBeTruthy(); expect(screen.queryByText("new recorded claim")).toBeNull();
  });
});
