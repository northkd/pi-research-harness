import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResearchCollaborationSnapshot } from "@blackbelt-technology/pi-dashboard-shared/research-collaboration.js";
import type { ResearchCollaborationController } from "../use-research-collaboration.js";
import { moveQueuedTask, ResearchConcurrencyControls, ResearchDispatchQueue, ResearchDetachDialog } from "../ResearchCollaborationControls.js";

vi.mock("@blackbelt-technology/pi-dashboard-client-utils/Dialog", () => ({
  Dialog: ({ open, title, children }: any) => open ? <div role="dialog" aria-label={title}>{children}</div> : null,
}));
afterEach(cleanup);
function snapshot(): ResearchCollaborationSnapshot {
  return {
    schema: "pi-research-collaboration.v1", cwd: "/project", adopted: true, revision: 7,
    currentTenureId: "tenure-current", currentMainSessionId: "main", limits: { maxMultiAgents: 4, maxSubagents: 3 }, limitMaximums: { maxMultiAgents: 8, maxSubagents: 32 },
    tenures: [{ id: "tenure-current", ordinal: 2, mainSessionId: "main", startedAt: "2026-11-16T00:00:00Z", status: "current", sessionIds: ["main", "multi"] }],
    detachedSessionIds: [], nativeQueue: [], plans: [{
      id: "plan", parentSessionId: "main", rootSessionId: "main", tenureId: "tenure-current", status: "running", revision: 12, concurrency: 4, effectiveConcurrency: 4, createdAt: "2026-11-16T00:00:00Z",
      tasks: [
        { id: "active", role: "compute", task: "正在计算", dependsOn: [], status: "running" },
        { id: "ready", role: "review", task: "反例核查", dependsOn: [], status: "queued", rank: 1 },
        { id: "blocked", role: "analysis", task: "NEB方案", dependsOn: ["active"], status: "queued", rank: 2 },
        { id: "last", role: "audit", task: "结果复核", dependsOn: [], status: "queued", rank: 3 },
      ],
    }],
  };
}
function controller(value = snapshot()) {
  return { scope: "project-scope", snapshot: value, loading: false, stale: false, error: null, busy: false,
    refresh: vi.fn().mockResolvedValue(value), mutate: vi.fn().mockResolvedValue(value) } satisfies ResearchCollaborationController;
}
function transfer() { return { effectAllowed: "none", dropEffect: "none", setData: vi.fn() }; }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

describe("live concurrency settings", () => {
  it("shows the saved limits in the compact collaboration bar and uses the reviewed revision", async () => {
    const ctl = controller();
    ctl.mutate.mockResolvedValue({ ...ctl.snapshot, revision: 8, limits: { maxMultiAgents: 6, maxSubagents: 4 } });
    render(<ResearchConcurrencyControls controller={ctl} />);
    expect(screen.getByTestId("research-concurrency-open").textContent).toContain("Multi 4 / Sub 3");
    fireEvent.click(screen.getByTestId("research-concurrency-open"));
    fireEvent.change(screen.getByLabelText("Multi-agents 并发数"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Subagents 并发数"), { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并立即生效" }));
    await screen.findByText("已实时生效");
    expect(ctl.mutate).toHaveBeenCalledWith("limits", { maxMultiAgents: 6, maxSubagents: 4, expectedRevision: 7 });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("rejects fractions and counts above the server-advertised maximum", () => {
    const ctl = controller(); render(<ResearchConcurrencyControls controller={ctl} />);
    fireEvent.click(screen.getByTestId("research-concurrency-open"));
    for (const value of ["0", "9", "2.5", ""]) {
      fireEvent.change(screen.getByLabelText("Multi-agents 并发数"), { target: { value } });
      expect((screen.getByRole("button", { name: "保存并立即生效" }) as HTMLButtonElement).disabled).toBe(true);
    }
    expect(ctl.mutate).not.toHaveBeenCalled();
  });
  it("does not display a successful setting without a matching server receipt", async () => {
    const ctl = controller(); render(<ResearchConcurrencyControls controller={ctl} />);
    fireEvent.click(screen.getByTestId("research-concurrency-open"));
    fireEvent.change(screen.getByLabelText("Multi-agents 并发数"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并立即生效" }));
    expect((await screen.findByRole("alert")).textContent).toContain("回执");
    expect(screen.queryByText("已实时生效")).toBeNull();
    expect((screen.getByLabelText("Multi-agents 并发数") as HTMLInputElement).value).toBe("6");
  });
  it("does not silently replace a dialog's reviewed revision with a later snapshot", async () => {
    const ctl = controller(); const view = render(<ResearchConcurrencyControls controller={ctl} />);
    fireEvent.click(screen.getByTestId("research-concurrency-open"));
    view.rerender(<ResearchConcurrencyControls controller={{ ...ctl, snapshot: { ...ctl.snapshot, revision: 10 } }} />);
    fireEvent.click(screen.getByRole("button", { name: "保存并立即生效" }));
    await act(async () => {});
    expect(ctl.mutate.mock.calls[0][1]?.expectedRevision).toBe(7);
  });
  it("keeps edited limits after conflict and only retries on a second explicit click with a freshly read revision", async () => {
    const ctl = controller();
    ctl.mutate.mockRejectedValueOnce(new Error("协作状态已变化"))
      .mockResolvedValueOnce({ ...ctl.snapshot, revision: 10, limits: { maxMultiAgents: 6, maxSubagents: 3 } });
    ctl.refresh.mockResolvedValue({ ...ctl.snapshot, revision: 9 });
    render(<ResearchConcurrencyControls controller={ctl} />);
    fireEvent.click(screen.getByTestId("research-concurrency-open"));
    fireEvent.change(screen.getByLabelText("Multi-agents 并发数"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并立即生效" }));
    await screen.findByRole("alert");
    await act(async () => {});
    expect(ctl.mutate).toHaveBeenCalledTimes(1);
    expect((screen.getByLabelText("Multi-agents 并发数") as HTMLInputElement).value).toBe("6");
    fireEvent.click(screen.getByRole("button", { name: "保存并立即生效" }));
    await screen.findByText("已实时生效");
    expect(ctl.mutate.mock.calls.map(call => call[1]?.expectedRevision)).toEqual([7, 9]);
  });
  it("does not let a previous workspace failure or refresh change a newly opened settings dialog", async () => {
    const ctl = controller(), pending = deferred<ResearchCollaborationSnapshot>();
    ctl.mutate.mockReturnValue(pending.promise);
    ctl.refresh.mockResolvedValue({ ...ctl.snapshot, revision: 99 });
    const view = render(<ResearchConcurrencyControls controller={ctl} />);
    fireEvent.click(screen.getByTestId("research-concurrency-open"));
    fireEvent.change(screen.getByLabelText("Multi-agents 并发数"), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("button", { name: "保存并立即生效" }));
    const next = { ...controller({ ...snapshot(), cwd: "/other", revision: 11 }), scope: "other-scope" };
    view.rerender(<ResearchConcurrencyControls controller={next} />);
    fireEvent.click(screen.getByTestId("research-concurrency-open"));
    await act(async () => { pending.reject(new Error("旧目录连接已断开")); });
    expect(screen.queryByText("旧目录连接已断开")).toBeNull();
    expect(ctl.refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "保存并立即生效" }));
    await act(async () => {});
    expect(next.mutate.mock.calls[0][1]?.expectedRevision).toBe(11);
  });
});

describe("durable dispatch queue controls", () => {
  it("shows the actual parent queue, role and honestly unconfirmed model", () => {
    render(<ResearchDispatchQueue controller={controller()} sessionName={id => id === "main" ? "主 Agent" : id} />);
    const cards = screen.getAllByTestId("research-queue-card");
    expect(cards).toHaveLength(3);
    expect(cards.map(card => card.getAttribute("data-task-id"))).toEqual(["ready", "blocked", "last"]);
    expect(cards[0].textContent).toContain("review · 模型待启动确认");
    expect(screen.getByLabelText("主 Agent 的待调度队列")).toBeTruthy();
    expect(within(cards[1]).getByRole("button", { name: "立即开始" }).getAttribute("disabled")).not.toBeNull();
  });
  it("persists a mouse drag in the same parent plan with the captured queue revision", async () => {
    const ctl = controller(); render(<ResearchDispatchQueue controller={ctl} />);
    const cards = screen.getAllByTestId("research-queue-card"), dataTransfer = transfer();
    fireEvent.dragStart(cards[2], { dataTransfer }); fireEvent.dragOver(cards[0], { dataTransfer }); fireEvent.drop(cards[0], { dataTransfer });
    await screen.findByText("队列顺序已保存。");
    expect(ctl.mutate).toHaveBeenCalledWith("reorder", { planId: "plan", sessionId: "main", taskIds: ["last", "ready", "blocked"], queueRevision: 12 });
    expect(ctl.mutate.mock.calls.some(call => call[0] === "start")).toBe(false);
  });
  it("also offers keyboard ordering without submitting an incomplete task list", async () => {
    const ctl = controller(); render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "移动任务 结果复核" }), { key: "ArrowLeft" });
    await screen.findByText("队列顺序已保存。");
    expect(ctl.mutate.mock.calls[0][1]?.taskIds).toEqual(["ready", "last", "blocked"]);
  });
  it("cancels an in-progress drag when the server queue changes", async () => {
    const ctl = controller(), view = render(<ResearchDispatchQueue controller={ctl} />);
    const cards = screen.getAllByTestId("research-queue-card"), dataTransfer = transfer();
    fireEvent.dragStart(cards[2], { dataTransfer });
    const next = { ...ctl.snapshot, plans: ctl.snapshot.plans.map(plan => ({ ...plan, revision: 13 })) };
    view.rerender(<ResearchDispatchQueue controller={{ ...ctl, snapshot: next }} />);
    fireEvent.drop(screen.getAllByTestId("research-queue-card")[0], { dataTransfer });
    expect(ctl.mutate).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain("重新拖动");
  });
  it("does not claim a full-capacity task is already running after priority start", async () => {
    const ctl = controller(); render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.click(within(screen.getAllByTestId("research-queue-card")[0]).getByRole("button", { name: "立即开始" }));
    expect((await screen.findByRole("status")).textContent).toContain("已优先排队");
    expect(ctl.mutate).toHaveBeenCalledWith("start", { planId: "plan", sessionId: "main", taskId: "ready", queueRevision: 12 });
    expect(screen.queryByText("任务已进入启动流程。")).toBeNull();
  });
  it("shows startup only when the returned task is actually launching", async () => {
    const ctl = controller();
    ctl.mutate.mockResolvedValue({ ...ctl.snapshot, plans: ctl.snapshot.plans.map(plan => ({ ...plan, tasks: plan.tasks.map(task => task.id === "ready" ? { ...task, status: "launching" } : task) })) });
    render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.click(within(screen.getAllByTestId("research-queue-card")[0]).getByRole("button", { name: "立即开始" }));
    await screen.findByText("任务已进入启动流程。");
  });
  it.each(["failed", "cancelled", "blocked", "recovery-required"])("does not report a %s task as started or successfully reprioritized", async status => {
    const ctl = controller();
    ctl.mutate.mockResolvedValue({ ...ctl.snapshot, plans: ctl.snapshot.plans.map(plan => ({ ...plan, tasks: plan.tasks.map(task => task.id === "ready" ? { ...task, status } : task) })) });
    render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.click(within(screen.getAllByTestId("research-queue-card")[0]).getByRole("button", { name: "立即开始" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("任务已进入启动流程。")).toBeNull();
    expect(screen.queryByText(/已优先排队/)).toBeNull();
    expect(ctl.mutate).toHaveBeenCalledTimes(1);
  });
  it("keeps a missing task receipt unconfirmed and never retries start automatically", async () => {
    const ctl = controller();
    ctl.mutate.mockResolvedValue({ ...ctl.snapshot, plans: [] });
    render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.click(within(screen.getAllByTestId("research-queue-card")[0]).getByRole("button", { name: "立即开始" }));
    expect((await screen.findByRole("alert")).textContent).toContain("未找到该任务");
    expect(ctl.mutate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("status")).toBeNull();
  });
  it("does not let external drag payloads mutate a queue", () => {
    const ctl = controller(); render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.drop(screen.getAllByTestId("research-queue-card")[0], { dataTransfer: transfer() });
    expect(ctl.mutate).not.toHaveBeenCalled();
  });
  it("does not present historical plans as dispatchable current work", () => {
    const state = snapshot(); state.plans[0].tenureId = "historical";
    render(<ResearchDispatchQueue controller={controller(state)} />);
    expect(screen.queryByTestId("research-queue-card")).toBeNull();
    expect(screen.getByText(/暂无待调度任务/)).toBeTruthy();
  });
  it("reorders native subagents only within their parent with a frozen collaboration revision", async () => {
    const state = snapshot(); state.nativeQueue = [
      { id: "n1", requestId: "r1", parentSessionId: "multi", tenureId: "tenure-current", kind: "subagent", role: "review", model: "model-real-config", task: "子复核一", status: "queued", rank: 1, createdAt: "2026-11-16" },
      { id: "n2", requestId: "r2", parentSessionId: "multi", tenureId: "tenure-current", kind: "subagent", role: "review", task: "子复核二", status: "queued", rank: 2, createdAt: "2026-11-16" },
      { id: "other", requestId: "r3", parentSessionId: "another", tenureId: "tenure-current", kind: "subagent", role: "review", task: "另一父会话", status: "queued", rank: 1, createdAt: "2026-11-16" },
    ];
    const ctl = controller(state); render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "移动 Subagent 子复核二" }), { key: "ArrowLeft" });
    await screen.findByText("Subagent 排队顺序已保存。");
    expect(ctl.mutate).toHaveBeenCalledWith("native-reorder", { sessionId: "multi", taskIds: ["n2", "n1"], expectedRevision: 7 });
    expect(screen.getAllByTestId("research-native-queue-item")[0].textContent).toContain("model-real-config");
  });
  it("cancels a native drag when switching workspaces even if parent IDs and revisions happen to match", async () => {
    const state = snapshot(); state.plans = []; state.nativeQueue = [
      { id: "n1", requestId: "r1", parentSessionId: "multi", tenureId: "tenure-current", kind: "subagent", role: "review", task: "子复核一", status: "queued", rank: 1, createdAt: "2026-11-16" },
      { id: "n2", requestId: "r2", parentSessionId: "multi", tenureId: "tenure-current", kind: "subagent", role: "review", task: "子复核二", status: "queued", rank: 2, createdAt: "2026-11-16" },
    ];
    const ctl = controller(state), dataTransfer = transfer();
    const view = render(<ResearchDispatchQueue controller={ctl} />);
    fireEvent.dragStart(screen.getAllByTestId("research-native-queue-item")[1], { dataTransfer });
    const next = { ...controller({ ...state, cwd: "/other" }), scope: "other-scope" };
    view.rerender(<ResearchDispatchQueue controller={next} />);
    fireEvent.drop(screen.getAllByTestId("research-native-queue-item")[0], { dataTransfer });
    await act(async () => {});
    expect(ctl.mutate).not.toHaveBeenCalled();
    expect(next.mutate).not.toHaveBeenCalled();
  });
  it("keeps stale state readable but disables write actions", () => {
    const ctl = { ...controller(), stale: true }; render(<><ResearchConcurrencyControls controller={ctl} /><ResearchDispatchQueue controller={ctl} /></>);
    expect((screen.getByTestId("research-concurrency-open") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByTestId("research-queue-card").every(card => card.getAttribute("draggable") === "false")).toBe(true);
    expect(screen.getAllByRole("button", { name: "立即开始" }).every(button => (button as HTMLButtonElement).disabled)).toBe(true);
  });
});

describe("detachment in the roles panel", () => {
  it("sends an exact tenure target and explains association removal without transcript deletion", async () => {
    const ctl = controller(), onClose = vi.fn();
    ctl.mutate.mockResolvedValue({ ...ctl.snapshot, currentTenureId: null, currentMainSessionId: null, detachedSessionIds: ["main", "multi"],
      tenures: ctl.snapshot.tenures.map(tenure => ({ ...tenure, status: "removed", detachedSessionIds: ["main", "multi"] })) });
    render(<ResearchDetachDialog controller={ctl} target={{ sessionId: "main", tenureId: "tenure-current", title: "当前主会话", main: true }} onClose={onClose} />);
    expect(screen.getByRole("dialog").textContent).toContain("保留原对话、文件");
    expect(screen.getByRole("dialog").textContent).toContain("全部下属");
    fireEvent.click(screen.getByTestId("research-detach-confirm"));
    await act(async () => {});
    expect(ctl.mutate).toHaveBeenCalledWith("detach", { sessionId: "main", tenureId: "tenure-current" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("preserves the confirmation on an unconfirmed server error", async () => {
    const ctl = controller(), onClose = vi.fn(); ctl.mutate.mockRejectedValue(new Error("状态已变化"));
    render(<ResearchDetachDialog controller={ctl} target={{ sessionId: "multi", title: "协作者", main: false }} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("research-detach-confirm"));
    await screen.findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
  });
  it("leaves partial association cleanup visible instead of silently claiming complete removal", async () => {
    const ctl = controller(), onClose = vi.fn();
    ctl.mutate.mockResolvedValue({ ...ctl.snapshot, detachedSessionIds: ["multi"],
      tenures: ctl.snapshot.tenures.map(tenure => ({ ...tenure, detachedSessionIds: ["multi"] })), warnings: ["association-metadata-pending:multi"] });
    render(<ResearchDetachDialog controller={ctl} target={{ sessionId: "multi", title: "协作者", main: false }} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("research-detach-confirm"));
    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("部分关联标记尚未清理");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("不强制终止进程");
  });
  it("does not close a current dialog on an absent acknowledgement", async () => {
    const ctl = controller(), onClose = vi.fn(); ctl.mutate.mockResolvedValue(null);
    render(<ResearchDetachDialog controller={ctl} target={{ sessionId: "multi", title: "协作者", main: false }} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("research-detach-confirm"));
    await act(async () => {});
    expect(onClose).not.toHaveBeenCalled();
  });
  it("does not equate an unchanged snapshot with confirmed detachment", async () => {
    const ctl = controller(), onClose = vi.fn();
    render(<ResearchDetachDialog controller={ctl} target={{ sessionId: "main", tenureId: "tenure-current", title: "当前主会话", main: true }} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("research-detach-confirm"));
    await screen.findByRole("alert");
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").textContent).toContain("当前主会话");
  });
  it("does not attach a late old-target error to a different workspace removal dialog", async () => {
    const ctl = controller(), onClose = vi.fn(), pending = deferred<ResearchCollaborationSnapshot>();
    ctl.mutate.mockReturnValue(pending.promise);
    const view = render(<ResearchDetachDialog controller={ctl} target={{ sessionId: "main", title: "原主会话", main: true }} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("research-detach-confirm"));
    const next = { ...controller({ ...snapshot(), cwd: "/other" }), scope: "other-scope" };
    view.rerender(<ResearchDetachDialog controller={next} target={{ sessionId: "other-main", title: "另一主会话", main: true }} onClose={onClose} />);
    await act(async () => { pending.reject(new Error("旧目标移出结果未知")); });
    expect(screen.queryByText("旧目标移出结果未知")).toBeNull();
    expect(screen.getByRole("dialog").textContent).toContain("另一主会话");
    expect(onClose).not.toHaveBeenCalled();
  });
});

it("moves a queue task without mutating the previous order", () => {
  const ids = ["a", "b", "c"];
  expect(moveQueuedTask(ids, "a", "c")).toEqual(["b", "c", "a"]);
  expect(ids).toEqual(["a", "b", "c"]);
  expect(moveQueuedTask(ids, "missing", "c")).toBe(ids);
});
