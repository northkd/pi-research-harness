import { cleanup, fireEvent, render, screen, within, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchAgentDetail, instanceKey, type ResearchAgentInstance } from "../ResearchAgentDetail.js";
import type { ResearchExecution } from "../research-projection.js";

const { map, navigate } = vi.hoisted(() => ({ map: new Map(), navigate: vi.fn() }));
vi.mock("@blackbelt-technology/dashboard-plugin-runtime", () => ({ useSessionSubagents: () => map }));
vi.mock("wouter", () => ({ useLocation: () => ["/", navigate] }));
vi.mock("../../preview/MarkdownContent.js", () => ({ MarkdownContent: ({ content }: { content: string }) => <div>{content}</div> }));

const role = { name: "research-explorer", skills: ["idea-creator"], model: "configured/model", note: "独立探索" };
function instance(key: string, childRunId: string): ResearchAgentInstance {
  return {
    run: { runId: "actual-run", parentSessionId: "parent /id", status: "running", launchOrder: 1, steps: [] },
    step: { runId: "actual-run", key, childRunId, agent: role.name, stage: "1-idea", status: "completed", summary: `${key} 的实际结果`, evidence: ["runs/result.json"] },
  };
}

afterEach(() => { cleanup(); map.clear(); navigate.mockClear(); vi.unstubAllGlobals(); });

describe("ResearchAgentDetail", () => {
  it("shows configuration without manufacturing an unobserved instance", () => {
    render(<ResearchAgentDetail role={role} instances={[]} onClose={vi.fn()} />);
    expect(screen.getByTestId("research-agent-unstarted").textContent).toContain("暂无可验证运行记录");
    expect(screen.queryByTestId("research-agent-instance-detail")).toBeNull();
    expect(screen.getByTestId("research-agent-configuration").textContent).toContain("configured/model");
  });

  it("does not silently select the first of multiple runs", () => {
    render(<ResearchAgentDetail role={role} instances={[instance("one", "child-one"), instance("two", "child-two")]} onClose={vi.fn()} />);
    expect(screen.getAllByTestId("research-agent-instance")).toHaveLength(2);
    expect(screen.queryByTestId("research-agent-instance-detail")).toBeNull();
    fireEvent.click(screen.getAllByTestId("research-agent-instance")[1]);
    expect(screen.getByTestId("research-agent-instance-detail").textContent).toContain("two 的实际结果");
  });

  it("never substitutes a configured model for the actual observed model", () => {
    const first = instance("one", "child-one");
    render(<ResearchAgentDetail role={role} instances={[first]} initialInstance={instanceKey(first)} onClose={vi.fn()} />);
    const detail = screen.getByTestId("research-agent-instance-detail");
    expect(within(detail).getByText("尚未观测")).toBeTruthy();
    expect(detail.textContent).not.toContain("configured/model");
  });

  it("does not construct a legacy detail link for an unresolved native id", () => {
    const first = instance("one", "native-child");
    map.set("unrelated-id", { id: "unrelated-id", status: "completed" });
    render(<ResearchAgentDetail role={role} instances={[first]} initialInstance={instanceKey(first)} onClose={vi.fn()} />);
    expect(screen.queryByRole("button", { name: "打开关联对话" })).toBeNull();
    expect(screen.getByText(/暂无可验证的完整对话关联/)).toBeTruthy();
  });

  it("opens only a genuinely resolved conversation and encodes both identities", () => {
    const first = instance("one", "child /#1");
    map.set(first.step.childRunId, { id: first.step.childRunId, status: "completed" });
    render(<ResearchAgentDetail role={role} instances={[first]} initialInstance={instanceKey(first)} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "打开关联对话" }));
    expect(navigate).toHaveBeenCalledWith("/session/parent%20%2Fid/subagent/child%20%2F%231");
  });

  it("opens a recorded artifact in the existing editor and closes only the detail", () => {
    const first = instance("one", "child-one");
    const open = vi.fn(), close = vi.fn();
    render(<ResearchAgentDetail role={role} instances={[first]} initialInstance={instanceKey(first)} onOpenArtifact={open} onClose={close} />);
    fireEvent.click(screen.getByRole("button", { name: "runs/result.json" }));
    expect(open).toHaveBeenCalledWith("runs/result.json");
    expect(close).toHaveBeenCalledOnce();
  });

  it("renders unknown status names as text rather than inherited object properties", () => {
    const first = instance("one", "child-one");
    first.step.status = "__proto__";
    render(<ResearchAgentDetail role={role} instances={[first]} initialInstance={instanceKey(first)} onClose={vi.fn()} />);
    expect(screen.getByTestId("research-agent-instance-detail").textContent).toContain("__proto__");
  });

  it("displays a blocked business result separately from completed execution", () => {
    const first = instance("one", "child-one");
    first.step.businessStatus = "blocked";
    render(<ResearchAgentDetail role={role} instances={[first]} initialInstance={instanceKey(first)} onClose={vi.fn()} />);
    expect(screen.getByTestId("research-agent-instance-detail").textContent).toContain("阻塞（不代表科学验收）");
    expect(screen.getByTestId("research-agent-instance-detail").textContent).toContain("已结束");
  });

  it("keeps corrections as drafts without claiming delivery when the record has no target session", () => {
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    const execution: ResearchExecution = { id: "native-without-channel", kind: "native-subagent", source: "observation", status: "completed", evidence: [] };
    render(<ResearchAgentDetail role={role} instances={[]} executions={[execution]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /核对实验条件/ }));
    const draft = screen.getByRole("textbox", { name: "纠偏指令草稿" }) as HTMLTextAreaElement;
    expect(draft.value).toContain("已声明的实验条件");
    expect(draft.value).not.toMatch(/1200|AIMD|DFT/);
    expect((screen.getByRole("button", { name: "发送纠偏" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(draft, { key: "Enter" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(screen.queryByText(/已提交到目标会话/)).toBeNull();
  });

  it("requires a deliberate send after editing a template and reports only the actual encoded target response", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ success: true, transmitted: true, promptId: "receipt-one" }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const execution: ResearchExecution = { id: "session-run", kind: "pi-session", sessionId: "real /#session", source: "observation", status: "idle", evidence: [] };
    render(<ResearchAgentDetail role={role} instances={[]} executions={[execution]} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /核对实验条件/ }));
    expect(fetcher).not.toHaveBeenCalled();
    const draft = screen.getByRole("textbox", { name: "纠偏指令草稿" });
    fireEvent.change(draft, { target: { value: "仅复核已记录参数，列出未确认项。" } });
    fireEvent.click(screen.getByRole("button", { name: "发送纠偏" }));
    await waitFor(() => expect(screen.getByText(/已提交到目标会话/)).toBeTruthy());
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][0]).toBe("/api/session/real%20%2F%23session/prompt");
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toEqual({ text: "仅复核已记录参数，列出未确认项。" });
  });

  it("prioritizes stale observations, keeps the real end time unknown, and preserves a hidden draft", () => {
    const execution: ResearchExecution = { id: "stale-run", kind: "pi-session", sessionId: "real-session", source: "observation", status: "running", lastActivityAt: "2026-11-05T09:00:00.000Z", evidence: [] };
    const props = { role, instances: [], executions: [execution], observationsStale: true, onClose: vi.fn() };
    const view = render(<ResearchAgentDetail {...props} />);
    expect(screen.getAllByText(/观测已过期/).length).toBeGreaterThan(0);
    expect(screen.queryByText("持续执行中")).toBeNull();
    expect(screen.getByText("结束时间").parentElement?.parentElement?.textContent).toContain("未记录");
    fireEvent.change(screen.getByRole("textbox", { name: "纠偏指令草稿" }), { target: { value: "保留这段尚未发送的纠偏" } });
    view.rerender(<ResearchAgentDetail {...props} visible={false} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    view.rerender(<ResearchAgentDetail {...props} visible />);
    expect((screen.getByRole("textbox", { name: "纠偏指令草稿" }) as HTMLTextAreaElement).value).toBe("保留这段尚未发送的纠偏");
  });
});
