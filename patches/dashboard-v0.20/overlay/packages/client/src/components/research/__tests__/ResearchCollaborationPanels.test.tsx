import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResearchCollaborationSnapshot } from "@blackbelt-technology/pi-dashboard-shared/research-collaboration.js";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import { ResearchExecutionPanels } from "../ResearchExecutionPanels.js";
import { projectResearch, type ResearchSnapshot } from "../research-projection.js";
import type { ResearchCollaborationController } from "../use-research-collaboration.js";

const formal: ResearchSnapshot = { state: { charter: { objective: "研究目标保留", revision: 1 }, claims: [] }, events: [], attempts: [], receipt: null };
const props = { stage: null, includeUnstaged: true, stale: false, mode: "teams" as const, cwd: "/project", onAgent: vi.fn() };
const names = [
  { id: "lead", name: "当前研究主会话" }, { id: "worker", name: "迁移路径搜索" },
  { id: "former", name: "上一轮研究主会话" }, { id: "removed", name: "已移出的会话" },
];
function snapshot(): ResearchCollaborationSnapshot {
  return { schema: "pi-research-collaboration.v1", cwd: "/project", adopted: true, revision: 9,
    currentTenureId: "t-current", currentMainSessionId: "lead", limits: { maxMultiAgents: 4, maxSubagents: 3 },
    limitMaximums: { maxMultiAgents: 32, maxSubagents: 32 }, detachedSessionIds: [], nativeQueue: [],
    tenures: [
      { id: "t-old", ordinal: 1, mainSessionId: "former", sessionIds: ["former"], status: "historical", startedAt: "2026-11-15T00:00:00Z", endedAt: "2026-11-16T00:00:00Z", snapshots: { former: { title: "旧任期的研究", model: "actual/old-model" } } },
      { id: "t-current", ordinal: 2, mainSessionId: "lead", sessionIds: ["lead", "worker"], status: "current", startedAt: "2026-11-16T00:00:00Z" },
    ],
    plans: [{ id: "plan-current", parentSessionId: "lead", rootSessionId: "lead", tenureId: "t-current", status: "running", revision: 7, concurrency: 4, effectiveConcurrency: 4, createdAt: "2026-11-16T00:00:00Z", tasks: [
      { id: "queued-review", role: "verification", task: "待分发的证据复核", dependsOn: [], status: "queued", rank: 0 },
    ] }],
  };
}
function controller(value: ResearchCollaborationSnapshot | null = snapshot()): ResearchCollaborationController {
  return { scope: "host/project", snapshot: value, loading: false, stale: false, error: null, busy: false,
    refresh: vi.fn(async () => value), mutate: vi.fn(async () => value) };
}
function observation(): ResearchWorkbenchObservation {
  return { schema: "res-workflow.workbench-observation.v1", cwd: "/project", adoptionId: "adopt-1", charterHash: `sha256:${"a".repeat(64)}`,
    revision: `sha256:${"b".repeat(64)}`, updatedAt: "2026-11-16T12:00:00Z", heartbeatAt: "2026-11-16T12:00:00Z",
    coverage: { partial: false, reasons: [], parentSessions: 3, nativeRuns: 1 },
    executions: [
      { id: "session-lead", kind: "pi-session", sessionId: "lead", status: "idle", observedModel: "actual/lead" },
      { id: "session-worker", kind: "pi-session", sessionId: "worker", status: "running", parentExecutionId: "session-lead", role: "path-search", observedModel: "actual/worker" },
      { id: "session-former", kind: "pi-session", sessionId: "former", status: "idle", observedModel: "actual/newer-model" },
      { id: "native-child", kind: "native-subagent", parentExecutionId: "session-worker", role: "verification", status: "running", observedModel: "actual/child", startedAt: "2026-11-16T12:00:00Z" },
    ], relations: [], observedUsage: { responses: 1, inputTokens: 2, outputTokens: 3, inheritedExcluded: 0, metric: "observed-assistant-responses" },
  };
}
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: names.map(row => ({ ...row, cwd: "/project", nameSource: "manual" })) }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("collaboration panel integration", () => {
  it("exposes live limits and the queue even with no observed sessions or active lead", () => {
    const value = snapshot(); value.currentMainSessionId = null; value.currentTenureId = null; value.tenures = []; value.plans = [];
    render(<ResearchExecutionPanels {...props} projection={projectResearch(formal)} collaboration={controller(value)} />);
    expect(screen.getByTestId("research-concurrency-open")).toBeTruthy();
    expect(screen.getByText("尚未绑定当前主 Agent")).toBeTruthy();
    expect(screen.getByTestId("research-dispatch-queue")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "会话与下属角色" })).toBeTruthy();
    expect(screen.queryAllByTestId("canvas-session-node")).toHaveLength(0);
  });

  it("renders the authoritative current family, queue and historical family in that order", async () => {
    const controls = controller();
    render(<ResearchExecutionPanels {...props} projection={projectResearch(formal, observation())} collaboration={controls} />);
    await waitFor(() => expect(within(screen.getByTestId("research-canvas-viewport")).getByText("迁移路径搜索")).toBeTruthy());
    const current = screen.getByTestId("research-canvas-viewport"), queue = screen.getByTestId("research-dispatch-queue"), historic = screen.getByRole("region", { name: "历史主 Agent" });
    expect(current.compareDocumentPosition(queue) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(queue.compareDocumentPosition(historic) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(current.textContent).toContain("actual/worker");
    expect(historic.textContent).toContain("actual/old-model");
    expect(historic.textContent).not.toContain("actual/newer-model");
    fireEvent.click(within(queue).getByRole("button", { name: "立即开始" }));
    await waitFor(() => expect(controls.mutate).toHaveBeenCalledWith("start", { planId: "plan-current", sessionId: "lead", taskId: "queued-review", queueRevision: 7 }));
  });

  it("uses a real Main session and exact tenure for cascade confirmation without Subagent remove actions", async () => {
    const controls = controller();
    render(<ResearchExecutionPanels {...props} projection={projectResearch(formal, observation())} collaboration={controls} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作：当前研究主会话" })).toBeTruthy());
    expect(within(screen.getByTestId("research-canvas-viewport")).getAllByRole("button", { name: /更多操作/ })).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "更多操作：当前研究主会话" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移出 res-workflow" }));
    const dialog = screen.getByTestId("research-detach-dialog");
    expect(dialog.textContent).toContain("当前研究主会话");
    expect(dialog.textContent).toContain("此任期下实际派发的全部下属");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(controls.mutate).toHaveBeenCalledWith("detach", { sessionId: "lead", tenureId: "t-current" }));
  });

  it("keeps historical reuse visible after current detach and lets list actions target a specific tenure", async () => {
    const value = snapshot();
    value.tenures[0] = { ...value.tenures[0], mainSessionId: "lead", sessionIds: ["lead"], snapshots: { lead: { title: "曾经的主会话", model: "actual/frozen" } } };
    value.tenures[1].detachedSessionIds = ["lead"];
    value.detachedSessionIds = ["lead"];
    const controls = controller(value);
    render(<ResearchExecutionPanels {...props} projection={projectResearch(formal, observation())} collaboration={controls} />);
    await waitFor(() => expect(within(screen.getByTestId("historical-canvas-viewport")).getByText("曾经的主会话")).toBeTruthy());
    fireEvent.click(within(screen.getByRole("group", { name: "协作视图布局" })).getByRole("button", { name: "列表" }));
    await waitFor(() => expect(screen.getByLabelText("更多操作：当前研究主会话")).toBeTruthy());
    fireEvent.click(screen.getByLabelText("更多操作：当前研究主会话"));
    fireEvent.click(screen.getByRole("menuitem", { name: "移出 res-workflow · 第 1 任期" }));
    const dialog = screen.getByTestId("research-detach-dialog");
    expect(dialog.textContent).toContain("曾经的主会话");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认移出" }));
    await waitFor(() => expect(controls.mutate).toHaveBeenCalledWith("detach", { sessionId: "lead", tenureId: "t-old" }));
  });

  it("closes an old workspace detach target before a new workspace can submit it", async () => {
    const controls = controller();
    const view = render(<ResearchExecutionPanels {...props} projection={projectResearch(formal, observation())} collaboration={controls} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "更多操作：迁移路径搜索" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "更多操作：迁移路径搜索" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "移出 res-workflow" }));
    expect(screen.getByTestId("research-detach-dialog")).toBeTruthy();
    view.rerender(<ResearchExecutionPanels {...props} cwd="/different" projection={projectResearch(formal)} collaboration={{ ...controller(null), scope: "host/different" }} />);
    expect(screen.queryByTestId("research-detach-dialog")).toBeNull();
    expect(controls.mutate).not.toHaveBeenCalled();
  });

  it("keeps legacy fallback, list details and role matrix when collaboration is unavailable", () => {
    render(<ResearchExecutionPanels {...props} projection={projectResearch(formal, observation())} />);
    expect(screen.getByRole("region", { name: "协作拓扑画布" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("group", { name: "协作视图布局" })).getByRole("button", { name: "列表" }));
    expect(screen.getAllByText("会话详情与纠偏").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "角色矩阵" }));
    expect(screen.getByText("1. 多智能体协作会话 (3 个研究会话)")).toBeTruthy();
    expect(screen.getByText("2. 原生 Subagent 任务清单 (1 项执行)")).toBeTruthy();
    expect(screen.queryByTestId("research-concurrency-open")).toBeNull();
  });
});
