import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchPipelinePage } from "../ResearchPipelinePage.js";
import { ResearchPersistentDrawer } from "../ResearchWorkspaceSummary.js";
import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";

const { liveState } = vi.hoisted(() => ({ liveState: {
  snapshot: { state: { charter: { objective: "可追溯的阶段任务", revision: 1 }, budget: { maxAttempts: 12 }, claims: [] }, attempts: [], events: [], receipt: null },
  adoption: null, adopted: false, loading: false, refreshing: false, error: null,
  checkedAt: "2026-11-05T09:00:00Z", refresh: vi.fn(), workbench: null as ResearchWorkbenchObservation | null,
  observationStatus: "unavailable", observationError: null,
} }));
vi.mock("../use-research-loop-live.js", () => ({ useResearchLoopLive: () => liveState }));
vi.mock("../ScienceInstances.js", () => ({ ScienceInstances: () => <div>Science 实例入口</div> }));
vi.mock("@blackbelt-technology/dashboard-plugin-runtime", () => ({ useSessionSubagents: () => new Map(), randomUuid: () => "test-request", usePluginSocket: () => null, useShellConnectionStatus: () => "connected" }));

beforeEach(() => { window.localStorage.clear(); liveState.workbench = null; liveState.observationStatus = "unavailable"; vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [] })))); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("research workspace surfaces", () => {
  it("defaults to workflow with five tabs, keeps complete aggregation, and offers the agents destination", () => {
    const openAgents = vi.fn();
    render(<ResearchPipelinePage cwd="/test/project" surface="workbench" onOpenAgents={openAgents} />);
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByTestId("research-tab-workflow").getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByTestId("research-tab-teams")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "智能体协作" }));
    expect(openAgents).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("research-stage-3-review"));
    expect(screen.getByText("实际阶段 · 未登记")).toBeTruthy();
    expect(screen.getByTestId("research-stage-3-review").getAttribute("aria-current")).toBeNull();
    fireEvent.click(screen.getByTestId("research-tab-all"));
    for (const id of ["research-agent-topology", "research-run-status", "research-overview-and-budget", "research-claims", "research-attempts-ledger"]) expect(screen.getByTestId(id)).toBeTruthy();
    expect(screen.getByTestId("research-tab-overview").textContent).toContain("12 次");
    expect(screen.getByTestId("research-tab-overview").textContent).not.toContain("¥");
  });

  it("retains an edited stage prompt across hidden panes and a visit to the agents surface", () => {
    const props = { cwd: "/test/project", surface: "workbench" as const };
    const view = render(<ResearchPipelinePage {...props} />);
    fireEvent.click(screen.getByRole("button", { name: /^调研与发散$/ }));
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
    expect(screen.queryByRole("complementary", { name: "任务概览" })).toBeNull();
    width = 1200; fireEvent(window, new Event("resize"));
    expect(screen.getByRole("complementary", { name: "任务概览" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "收起任务概览" }));
    width = 1300; fireEvent(window, new Event("resize"));
    expect(screen.queryByRole("complementary", { name: "任务概览" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
    width = 900; fireEvent(window, new Event("resize"));
    expect(screen.getByRole("complementary", { name: "任务概览" })).toBeTruthy();
    view.unmount();
    render(<ResearchPipelinePage cwd="/width/project" surface="workbench" />);
    expect(screen.getByRole("complementary", { name: "任务概览" })).toBeTruthy();
  });

  it("opens the exact collaborator execution even when provenance supplies a different display role", async () => {
    liveState.observationStatus = "current";
    liveState.workbench = {
      schema: "res-workflow.workbench-observation.v1", cwd: "/test/project", adoptionId: "adopt-one", charterHash: `sha256:${"a".repeat(64)}`, revision: `sha256:${"b".repeat(64)}`,
      updatedAt: "2026-11-05T09:00:00Z", heartbeatAt: "2026-11-05T09:00:00Z", coverage: { partial: false, reasons: [], parentSessions: 1, nativeRuns: 0 },
      executions: [{ id: "session-collab", sessionId: "collab", kind: "pi-session", status: "idle" }], relations: [], observedUsage: { responses: 0, inputTokens: 0, outputTokens: 0, inheritedExcluded: 0, metric: "observed-assistant-responses" },
    };
    const provenance = { schema: "pi-research-session.v1", parentSessionId: "parent", creatorSessionId: "parent", creatorAgent: "research_session", role: "experiment", task: "A bounded task", stage: "2-experiment", charterHash: `sha256:${"a".repeat(64)}`, adoptionId: `adopt-${"b".repeat(24)}`, workflowCwd: "/test/project", spawnToken: "spawn-token-1234", createdAt: "2026-11-04T00:00:00Z", origin: "research_session", relation: "dispatch" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ data: [{ id: "collab", name: "实验协作者", nameSource: "manual", researchSession: provenance }] }))));
    render(<ResearchPipelinePage cwd="/test/project" surface="agents" />);
    await waitFor(() => expect(screen.getByRole("button", { name: "聚焦实验协作者" })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "聚焦实验协作者" }));
    fireEvent.click(screen.getByRole("button", { name: "会话详情与纠偏" }));
    expect(screen.getByTestId("research-correction-target").textContent).toContain("发送到会话 collab");
    expect(screen.queryByText("暂无可验证运行记录")).toBeNull();
  });
});
