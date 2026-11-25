import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchPipelinePage } from "../ResearchPipelinePage.js";
import { ResearchPersistentDrawer } from "../ResearchWorkspaceSummary.js";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import type { CollaborationSnapshot } from "../use-research-collaboration.js";

const { liveState } = vi.hoisted(() => ({ liveState: {
  snapshot: { state: { charter: { objective: "可追溯的阶段任务", revision: 1 }, budget: { maxAttempts: 12 }, claims: [] }, attempts: [], events: [], receipt: null },
  adoption: null, adopted: false, loading: false, refreshing: false, error: null,
  checkedAt: "2026-11-05T09:00:00Z", refresh: vi.fn(), workbench: null as ResearchWorkbenchObservation | null,
  observationStatus: "unavailable", observationError: null, socket: null as EventTarget | null,
} }));
vi.mock("../use-research-loop-live.js", () => ({ useResearchLoopLive: () => liveState }));
vi.mock("@blackbelt-technology/dashboard-plugin-runtime", () => ({ useSessionSubagents: () => new Map(), randomUuid: () => "test-request", usePluginSocket: () => liveState.socket, useShellConnectionStatus: () => "connected" }));

const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
const emptyCollaboration = (cwd = "/test/project"): CollaborationSnapshot => ({
  schema: "pi-research-collaboration.v1", cwd, adopted: true, revision: 8,
  currentTenureId: null, currentMainSessionId: null, tenures: [], plans: [], nativeQueue: [],
  limits: { maxMultiAgents: 4, maxSubagents: 3 }, limitMaximums: { maxMultiAgents: 8, maxSubagents: 32 },
});

beforeEach(() => {
  window.localStorage.clear(); liveState.workbench = null; liveState.socket = null; liveState.observationStatus = "unavailable";
  vi.stubGlobal("fetch", vi.fn(async url => {
    const cwd = new URL(String(url), "http://fixture.invalid").searchParams.get("cwd") ?? "/test/project";
    return response(String(url).includes("/collaboration") ? emptyCollaboration(cwd) : { data: [] });
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("research workspace surfaces", () => {
  it("defaults to workflow with five tabs, keeps complete aggregation, and offers the agents destination", () => {
    const openAgents = vi.fn();
    render(<ResearchPipelinePage cwd="/test/project" surface="workbench" onOpenAgents={openAgents} />);
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByTestId("research-tab-workflow").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("research-tab-teams")).toBeNull();
    expect(screen.queryByRole("button", { name: "智能体协作" })).toBeNull();
    fireEvent.click(screen.getByTestId("research-stage-3-review"));
    expect(screen.getByText("实际阶段 · 未登记")).toBeTruthy();
    expect(screen.getByTestId("research-stage-3-review").getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByTestId("research-tab-all"));
    for (const id of ["research-agent-topology", "research-run-status", "research-overview-and-budget", "research-claims", "research-attempts-ledger"]) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId("research-tab-overview").textContent).toBe("研究总览");
    expect(screen.getByTestId("research-tab-overview").textContent).not.toContain("¥");
  });

  it("retains an edited stage prompt across hidden panes and a visit to the agents surface", () => {
    const props = { cwd: "/test/project", surface: "workbench" as const };
    const view = render(<ResearchPipelinePage {...props} />);
    fireEvent.click(screen.getByTestId("research-stage-start-1-idea"));
    const prompt = screen.getByPlaceholderText("输入该阶段新智能体的第一条启动 Prompt…");
    fireEvent.change(prompt, { target: { value: "仅整理已存在的材料，并列出待确认问题。" } });
    view.rerender(<ResearchPipelinePage {...props} visible={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<ResearchPipelinePage {...props} surface="agents" />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    view.rerender(<ResearchPipelinePage {...props} />);
    expect((screen.getByPlaceholderText("输入该阶段新智能体的第一条启动 Prompt…") as HTMLTextAreaElement).value).toBe("仅整理已存在的材料，并列出待确认问题。");
    const fetcher = vi.mocked(globalThis.fetch);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps intake drafts mounted while the closed drawer is absent from accessible navigation", () => {
    const onClose = vi.fn();
    const view = render(<ResearchPersistentDrawer open title="资料接入" onClose={onClose}><input aria-label="接入草稿" defaultValue="initial" /></ResearchPersistentDrawer>);
    fireEvent.change(screen.getByRole("textbox", { name: "接入草稿" }), { target: { value: "edited" } });
    view.rerender(<ResearchPersistentDrawer open={false} title="资料接入" onClose={onClose}><input aria-label="接入草稿" defaultValue="initial" /></ResearchPersistentDrawer>);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<ResearchPersistentDrawer open title="资料接入" onClose={onClose}><input aria-label="接入草稿" defaultValue="initial" /></ResearchPersistentDrawer>);
    expect((screen.getByRole("textbox", { name: "接入草稿" }) as HTMLInputElement).value).toBe("edited");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("bases the overview default on workspace width and keeps an explicit choice across resizing and remounts", () => {
    let width = 900;
    const originalMeasure = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid !== "research-pipeline") return originalMeasure.call(this);
      return { width, height: 800, top: 0, left: 0, right: width, bottom: 800, x: 0, y: 0, toJSON: () => ({}) };
    });
    const view = render(<ResearchPipelinePage cwd="/width/project" surface="workbench" />);
    expect(screen.queryByRole("complementary", { name: "运行概览" })).toBeNull();
    width = 1200; fireEvent(window, new Event("resize"));
    expect(screen.getByRole("complementary", { name: "运行概览" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起运行概览" }));
    width = 1300; fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("complementary", { name: "运行概览" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "运行概览" }));
    width = 900; fireEvent(window, new Event("resize"));
    expect(screen.getByRole("complementary", { name: "运行概览" })).toBeTruthy();
    view.unmount();
    render(<ResearchPipelinePage cwd="/width/project" surface="workbench" />);
    expect(screen.getByRole("complementary", { name: "运行概览" })).toBeTruthy();
  });

  it("opens the exact collaborator execution even when provenance supplies a different display role", async () => {
    liveState.observationStatus = "current";
    liveState.workbench = {
      schema: "res-workflow.workbench-observation.v1", cwd: "/test/project", adoptionId: "adopt-one", charterHash: `sha256:${"a".repeat(64)}`, revision: `sha256:${"b".repeat(64)}`,
      updatedAt: "2026-11-05T09:00:00Z", heartbeatAt: "2026-11-05T09:00:00Z", coverage: { partial: false, reasons: [], parentSessions: 1, nativeRuns: 0 },
      executions: [{ id: "session-collab", sessionId: "collab", kind: "pi-session", status: "idle" }], relations: [], observedUsage: { responses: 0, inputTokens: 0, outputTokens: 0, inheritedExcluded: 0, metric: "observed-assistant-responses" },
    };
    const provenance = { schema: "pi-research-session.v1", parentSessionId: "parent", creatorSessionId: "parent", creatorAgent: "research_session", role: "experiment", task: "A bounded task", stage: "2-experiment", charterHash: `sha256:${"a".repeat(64)}`, adoptionId: `adopt-${"b".repeat(24)}`, workflowCwd: "/test/project", spawnToken: "spawn-token-1234", createdAt: "2026-11-04T00:00:00Z", origin: "research_session", relation: "dispatch" };
    const collaboration = emptyCollaboration();
    collaboration.currentTenureId = "tenure-one"; collaboration.currentMainSessionId = "parent";
    collaboration.tenures = [{ id: "tenure-one", ordinal: 1, mainSessionId: "parent", status: "current", startedAt: "2026-11-04T00:00:00.000Z",
      sessionIds: ["parent", "collab"], snapshots: { parent: { title: "研究主会话" }, collab: { title: "实验协作者", role: "experiment", parentSessionId: "parent" } } }];
    vi.stubGlobal("fetch", vi.fn(async url => response(String(url).includes("/collaboration") ? collaboration
      : { data: [{ id: "collab", cwd: "/test/project", name: "实验协作者", nameSource: "manual", researchSession: provenance }] })));
    render(<ResearchPipelinePage cwd="/test/project" surface="agents" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "聚焦实验协作者" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "聚焦实验协作者" }));
    fireEvent.click(screen.getByRole("button", { name: "详情与纠偏" }));
    expect(screen.getByTestId("research-correction-target").textContent).toContain("发送到会话 collab");
    expect(screen.queryByText("暂无可验证运行记录")).toBeNull();
  });

  it("keeps each main-agent tenure in its own tree and saves scoped limits and removals", async () => {
    const state = emptyCollaboration();
    state.currentTenureId = "tenure-two"; state.currentMainSessionId = "new-main";
    state.tenures = [
      { id: "tenure-one", ordinal: 1, mainSessionId: "old-main", status: "historical", startedAt: "2026-11-04T00:00:00.000Z", endedAt: "2026-11-05T00:00:00.000Z",
        sessionIds: ["old-main", "old-worker"], snapshots: { "old-main": { title: "上一轮主会话" }, "old-worker": { title: "上一轮协作者", parentSessionId: "old-main" } } },
      { id: "tenure-two", ordinal: 2, mainSessionId: "new-main", status: "current", startedAt: "2026-11-05T00:00:00.000Z",
        sessionIds: ["new-main", "new-worker"], snapshots: { "new-main": { title: "当前主会话" }, "new-worker": { title: "当前协作者", parentSessionId: "new-main" } } },
    ];
    state.plans = [{ id: "queued-plan", tenureId: "tenure-two", parentSessionId: "new-main", tasks: [
      { id: "waiting", role: "experiment", task: "排队中的真实计划任务", status: "queued", waitingReason: "capacity" },
      { id: "done", role: "review", task: "已完成任务", status: "completed" },
    ] }];
    const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes("/collaboration")) return response({ data: [] });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        expect(body.cwd).toBe("/test/project"); expect(body.expectedRevision).toBe(state.revision);
        if (body.action === "limits") state.limits = { maxMultiAgents: body.maxMultiAgents, maxSubagents: body.maxSubagents };
        else {
          const tenure = state.tenures.find(row => row.id === body.tenureId)!;
          expect(tenure.sessionIds).toContain(body.sessionId);
          tenure.detachedSessionIds = [body.sessionId];
          if (body.sessionId === tenure.mainSessionId) {
            tenure.status = "removed"; state.currentMainSessionId = null; state.currentTenureId = null;
          }
        }
        state.revision++;
      }
      return response(state);
    });
    vi.stubGlobal("fetch", fetcher);
    render(<ResearchPipelinePage cwd="/test/project" surface="agents" />);
    await waitFor(() => expect(screen.getAllByTestId("research-collaboration-tenure")).toHaveLength(2));
    const oldTree = screen.getByRole("region", { name: "批次 #1" });
    const newTree = screen.getByRole("region", { name: "批次 #2" });
    expect(within(oldTree).getByText("调度拓扑")).toBeTruthy();
    expect(within(newTree).getByText("调度拓扑")).toBeTruthy();
    expect(within(oldTree).getAllByTestId("canvas-parent-edge")).toHaveLength(1);
    expect(within(newTree).getAllByTestId("canvas-parent-edge")).toHaveLength(1);
    expect(within(oldTree).queryByText("当前协作者")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^从当前批次移除 / })).toHaveLength(4);
    expect(screen.getByText("Multi-Agent 1")).toBeTruthy();
    expect(screen.getByText("排队中的真实计划任务")).toBeTruthy();
    expect(screen.getByText("等待并发槽位")).toBeTruthy();
    expect(screen.queryByText("已完成任务")).toBeNull();

    const multiInput = screen.getByLabelText("Multi-Agent 并发数") as HTMLInputElement;
    const subInput = screen.getByLabelText("Subagent 并发数") as HTMLInputElement;
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    fireEvent.change(multiInput, { target: { value: "2" } });
    fireEvent.change(subInput, { target: { value: "1" } });
    fireEvent.blur(subInput);
    await waitFor(() => expect(state.limits).toEqual({ maxMultiAgents: 2, maxSubagents: 1 }));
    await waitFor(() => expect(multiInput.disabled).toBe(false));
    fireEvent.click(within(oldTree).getByRole("button", { name: "从当前批次移除 上一轮协作者" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(within(oldTree).queryByRole("button", { name: "聚焦上一轮协作者" })).toBeNull());
    expect(within(newTree).getByRole("button", { name: "聚焦当前协作者" })).toBeTruthy();
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
    expect(posts).toEqual([
      { cwd: "/test/project", expectedRevision: 8, action: "limits", maxMultiAgents: 2, maxSubagents: 1 },
      { cwd: "/test/project", expectedRevision: 9, action: "detach", tenureId: "tenure-one", sessionId: "old-worker" },
    ]);
    fireEvent.click(within(newTree).getByRole("button", { name: "从当前批次移除 当前主会话" }));
    fireEvent.click(screen.getByRole("button", { name: "确认移除" }));
    await waitFor(() => expect(screen.getAllByTestId("research-collaboration-tenure")).toHaveLength(1));
  });

  it("opens the selected historical session when a newer session has the same role", async () => {
    const state = emptyCollaboration();
    state.tenures = [{ id: "old-round", ordinal: 1, mainSessionId: "old-main", status: "historical", startedAt: "2026-11-04T00:00:00.000Z", endedAt: "2026-11-05T00:00:00.000Z",
      sessionIds: ["old-main", "old-worker"], snapshots: { "old-main": { title: "原主任期" }, "old-worker": { title: "原实验会话", role: "experiment", parentSessionId: "old-main" } } }];
    liveState.observationStatus = "current";
    liveState.workbench = {
      schema: "res-workflow.workbench-observation.v1", cwd: state.cwd, adoptionId: "adopt-one", charterHash: `sha256:${"a".repeat(64)}`, revision: `sha256:${"b".repeat(64)}`,
      updatedAt: "2026-11-06T09:00:00.000Z", heartbeatAt: "2026-11-06T09:00:00.000Z", coverage: { partial: true, reasons: [], parentSessions: 1, nativeRuns: 0 },
      executions: [{ id: "session-new-worker", sessionId: "new-worker", kind: "pi-session", role: "experiment", status: "idle" }], relations: [],
      observedUsage: { responses: 0, inputTokens: 0, outputTokens: 0, inheritedExcluded: 0, metric: "observed-assistant-responses" },
    };
    vi.stubGlobal("fetch", vi.fn(async url => response(String(url).includes("/collaboration") ? state : { data: [] })));
    render(<ResearchPipelinePage cwd={state.cwd} surface="agents" />);
    fireEvent.click(await screen.findByRole("button", { name: "聚焦原实验会话" }));
    fireEvent.click(screen.getByRole("button", { name: "详情与纠偏" }));
    expect(screen.getByTestId("research-correction-target").textContent).toContain("发送到会话 old-worker");
  });

  it("refreshes a newly dispatched child from the registration event before the fallback poll", async () => {
    liveState.socket = new EventTarget();
    const state = emptyCollaboration();
    state.currentTenureId = "tenure-one"; state.currentMainSessionId = "main";
    state.tenures = [{ id: "tenure-one", ordinal: 1, mainSessionId: "main", status: "current", startedAt: "2026-11-05T00:00:00.000Z",
      sessionIds: ["main"], snapshots: { main: { title: "研究主会话" } } }];
    vi.stubGlobal("fetch", vi.fn(async url => response(String(url).includes("/collaboration") ? state : { data: [] })));
    render(<ResearchPipelinePage cwd="/test/project" surface="agents" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "聚焦研究主会话" })).toBeTruthy());
    state.tenures[0]!.sessionIds.push("registered-worker");
    state.tenures[0]!.snapshots["registered-worker"] = { title: "刚注册的协作者", parentSessionId: "main" };
    state.revision++;
    act(() => liveState.socket!.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({
      type: "session_added", session: { id: "registered-worker", cwd: "/test/project" },
    }) })));
    await waitFor(() => expect(screen.getByRole("button", { name: "聚焦刚注册的协作者" })).toBeTruthy(), { timeout: 1500 });
    expect(screen.getAllByTestId("canvas-parent-edge")).toHaveLength(1);
  });

  it("lets operators start, reorder Multi-Agent queue tasks and reorder Subagent queues", async () => {
    const state = emptyCollaboration();
    state.currentTenureId = "tenure-1";
    state.currentMainSessionId = "main-1";
    state.tenures = [{
      id: "tenure-1",
      ordinal: 1,
      mainSessionId: "main-1",
      status: "current",
      startedAt: "2026-11-24T06:00:00.000Z",
      sessionIds: ["main-1"],
      snapshots: { "main-1": { title: "研究主会话" } },
    }];
    state.plans = [{
      id: "plan-1",
      tenureId: "tenure-1",
      parentSessionId: "main-1",
      revision: 3,
      schedulingPaused: false,
      tasks: [
        { id: "t-done", role: "lit", task: "已完成", status: "completed", queueRank: 0 },
        { id: "t-first", role: "theory", task: "排队第一", status: "queued", waitingReason: "capacity", queueRank: 1, dependsOn: ["t-done"] },
        { id: "t-second", role: "experiment", task: "排队第二", status: "queued", waitingReason: "capacity", queueRank: 2, dependsOn: ["t-done"] },
      ],
    }];
    state.nativeQueue = [
      { id: "n-1", parentSessionId: "main-1", tenureId: "tenure-1", role: "worker-a", task: "首个子任务", status: "queued", rank: 1, queueReason: "subagent-capacity" },
      { id: "n-2", parentSessionId: "main-1", tenureId: "tenure-1", role: "worker-b", task: "第二个子任务", status: "queued", rank: 2, queueReason: "subagent-capacity" },
    ];
    const posts: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      if (!String(url).includes("/collaboration")) return response({ data: [] });
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        posts.push(body);
        state.revision++;
        if (body.action === "start") {
          return response({ ...state, queueAction: { startResult: { planId: "plan-1", taskId: body.taskId, status: "running" } } });
        }
      }
      return response(state);
    }));

    render(<ResearchPipelinePage cwd="/test/project" surface="agents" />);
    await waitFor(() => expect(screen.getByTestId("research-multi-agent-queue")).toBeTruthy());
    expect(screen.getByTestId("research-subagent-queue")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "插队启动 experiment" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({
      cwd: "/test/project",
      expectedRevision: 8,
      action: "start",
      sessionId: "main-1",
      planId: "plan-1",
      taskId: "t-second",
      queueRevision: 3,
    });
    expect(screen.getByText(/已插队并立即启动/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "置顶 experiment" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(posts[1]).toEqual({
      cwd: "/test/project",
      expectedRevision: 9,
      action: "reorder",
      sessionId: "main-1",
      planId: "plan-1",
      taskIds: ["t-second", "t-first"],
      queueRevision: 3,
    });

    fireEvent.click(screen.getByRole("button", { name: "置顶 Subagent worker-b" }));
    await waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]).toEqual({
      cwd: "/test/project",
      expectedRevision: 10,
      action: "native-reorder",
      sessionId: "main-1",
      taskIds: ["n-2", "n-1"],
    });
  });
});
