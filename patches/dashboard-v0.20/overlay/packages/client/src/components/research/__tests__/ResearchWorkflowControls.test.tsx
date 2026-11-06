import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResearchPipelinePage } from "../ResearchPipelinePage.js";

const { liveState } = vi.hoisted(() => ({ liveState: {
  snapshot: { state: null, attempts: [], events: [], receipt: null },
  adoption: null, adopted: false, loading: false, refreshing: false, error: null,
  checkedAt: "2026-11-06T10:00:00Z", refresh: vi.fn(), workbench: null,
  observationStatus: "unavailable", observationError: null,
} }));
vi.mock("../use-research-loop-live.js", () => ({ useResearchLoopLive: () => liveState }));
vi.mock("../ScienceInstances.js", () => ({ ScienceInstances: () => null }));
vi.mock("../ResearchAccessControls.js", () => ({ ResearchAccessControls: () => null }));
vi.mock("@blackbelt-technology/dashboard-plugin-runtime", () => ({ useSessionSubagents: () => new Map(), randomUuid: () => "test-request", usePluginSocket: () => null, useShellConnectionStatus: () => "connected" }));

const sessions = [
  { id: "session-a", cwd: "/project", name: "研究主会话 A", status: "idle", model: "provider/model-a" },
  { id: "session-b", cwd: "/project", name: "研究主会话 B", status: "streaming", model: "provider/model-b" },
  { id: "ended", cwd: "/project", name: "已结束的研究", status: "ended" },
  { id: "foreign", cwd: "/other", name: "另一个项目", status: "idle" },
  { id: "remote", cwd: "/project", name: "远端同名目录", status: "idle", originDeviceId: "another-host" },
  { id: "acp", cwd: "/project", name: "ACP 会话", status: "idle", driver: "acp" },
];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function api(post?: (url: string, init: RequestInit) => Promise<Response>, options: { sessions?: unknown[]; connection?: (cwd: string) => Response } = {}) {
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === "POST") return post ? post(String(url), init) : response({ success: true, transmitted: true, promptId: "prompt-one" });
    if (String(url).endsWith("/api/sessions")) return response({ data: options.sessions ?? sessions });
    if (String(url).includes("/api/res-workflow/charter-binding?")) {
      const query = new URL(String(url), "http://fixture.invalid").searchParams;
      return response({ schema: "pi-research-charter-binding.v1", cwd: query.get("cwd"), adopted: false, adoptionId: null,
        status: "not-adopted", bindingRevision: 0, boundCharterHash: null, boundCharterRevision: null,
        currentCharterHash: null, currentCharterRevision: null, currentObjective: null, canRebind: false, updatedAt: null,
        ...(query.get("sessionId") ? { session: { sessionId: query.get("sessionId"), status: "not-joined" } } : {}),
      });
    }
    if (String(url).includes("/api/res-workflow/connection?")) {
      const cwd = new URL(String(url), "http://fixture.invalid").searchParams.get("cwd")!;
      return options.connection?.(cwd) ?? response({ cwd, adopted: false });
    }
    return response({ data: [] });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const props = { cwd: "/project", surface: "workbench" as const, activeSessionId: "session-a" };
beforeEach(() => { window.localStorage.clear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("visible research execution controls", () => {
  it("keeps all five independent stage launches above the collapsible execution records", async () => {
    const fetcher = api();
    render(<ResearchPipelinePage {...props} />);
    const stageIds = ["1-idea", "2-experiment", "3-review", "4-summary", "5-writing"];
    for (const id of stageIds) expect(screen.getByTestId(`research-stage-start-${id}`).closest("[hidden]")).toBeNull();
    fireEvent.click(within(screen.getByTestId("research-run-status")).getByRole("button", { name: "收起" }));
    for (const id of stageIds) {
      fireEvent.click(screen.getByTestId(`research-stage-start-${id}`));
      expect(screen.getByRole("dialog", { name: "独立启动阶段会话" })).toBeTruthy();
      expect((screen.getByTestId("research-stage-prompt") as HTMLTextAreaElement).value).toContain(id);
      fireEvent.click(screen.getByRole("button", { name: "关闭阶段启动编辑器" }));
    }
    fireEvent.click(screen.getByTestId("research-stage-3-review"));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("submits the edited stage prompt through the existing spawn path and retains it after a failed receipt", async () => {
    let succeeded = false;
    const fetcher = api(async () => response(succeeded ? { success: true } : { success: false, error: "fixture launch refused" }));
    render(<ResearchPipelinePage {...props} />);
    fireEvent.click(screen.getByTestId("research-stage-start-2-experiment"));
    fireEvent.change(screen.getByTestId("research-stage-prompt"), { target: { value: "只运行指定的数值验证，保存原始结果。" } });
    fireEvent.click(screen.getByTestId("research-stage-launch"));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("fixture launch refused"));
    expect((screen.getByTestId("research-stage-prompt") as HTMLTextAreaElement).value).toBe("只运行指定的数值验证，保存原始结果。");
    expect(screen.queryByText(/已成功为/)).toBeNull();
    const failedCall = fetcher.mock.calls.find(([url]) => String(url).endsWith("/api/session/spawn"))!;
    expect(JSON.parse(String(failedCall[1]?.body))).toEqual({ cwd: "/project", initialPrompt: "只运行指定的数值验证，保存原始结果。", joinResWorkflow: true, creationEntryPoint: "research-stage" });
    succeeded = true;
    fireEvent.click(screen.getByTestId("research-stage-launch"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("已提交");
  });

  it("selects only local Pi sessions in this workspace and sends the task to the chosen main agent", async () => {
    const fetcher = api();
    render(<ResearchPipelinePage {...props} />);
    const selector = screen.getByTestId("research-main-agent-select") as HTMLSelectElement;
    await waitFor(() => expect(selector.value).toBe("session-a"));
    expect(within(selector).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["", "session-a", "session-b", "ended"]);
    fireEvent.change(selector, { target: { value: "session-b" } });
    expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/session-b");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "拆分三项独立验证，交给子 agent 执行并核对结论。" } });
    fireEvent.click(screen.getByTestId("research-main-agent-send"));
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("已提交"));
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(String(posts[0][0])).toBe("/api/session/session-b/prompt");
    expect(JSON.parse(String(posts[0][1]?.body)).text).toContain("拆分三项独立验证，交给子 agent 执行并核对结论。");
    expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("研究主会话 B");
  });

  it("retains the chosen main agent across views and remounts without assigning it to another workspace", async () => {
    api();
    const view = render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    fireEvent.change(screen.getByTestId("research-main-agent-select"), { target: { value: "session-b" } });
    view.rerender(<ResearchPipelinePage {...props} surface="agents" />);
    expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-b");
    view.unmount();
    const next = render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-b"));
    next.rerender(<ResearchPipelinePage {...props} cwd="/other" activeSessionId="foreign" />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("foreign"));
    expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/foreign");
  });

  it("keeps ended sessions viewable but never submits a task to an ended or unknown main agent", async () => {
    const fetcher = api();
    render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    fireEvent.change(screen.getByTestId("research-main-agent-select"), { target: { value: "ended" } });
    expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/ended");
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "不得误投递" } });
    expect((screen.getByTestId("research-main-agent-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("research-main-agent-controls").textContent).toContain("已结束");
    fireEvent.change(screen.getByTestId("research-main-agent-select"), { target: { value: "" } });
    expect((screen.getByTestId("research-main-agent-send") as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does not report a 200 response without a transmission receipt as a successful main-agent submission", async () => {
    const fetcher = api(async () => response({ success: true }));
    render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "保留这个任务草稿" } });
    fireEvent.click(screen.getByTestId("research-main-agent-send"));
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").getAttribute("role")).toBe("alert"));
    expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("未确认");
    expect((screen.getByTestId("research-main-agent-prompt") as HTMLTextAreaElement).value).toBe("保留这个任务草稿");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("keeps the selected task destination when a collaborator becomes the active navigation session", async () => {
    api();
    const view = render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    view.rerender(<ResearchPipelinePage {...props} activeSessionId="session-b" />);
    expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a");
    expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/session-a");
  });

  it("shares an explicit main-agent choice between simultaneously mounted workspace surfaces", async () => {
    api();
    render(<><ResearchPipelinePage {...props} /><ResearchPipelinePage {...props} surface="agents" /></>);
    const selectors = screen.getAllByTestId("research-main-agent-select") as HTMLSelectElement[];
    await waitFor(() => expect(selectors.map(selector => selector.value)).toEqual(["session-a", "session-a"]));
    fireEvent.change(selectors[0]!, { target: { value: "session-b" } });
    expect(selectors.map(selector => selector.value)).toEqual(["session-b", "session-b"]);
    expect(screen.getAllByTestId("research-main-agent-open").map(link => link.getAttribute("href"))).toEqual(["/session/session-b", "/session/session-b"]);
  });

  it("uses the admitted canonical workspace for aliases and shares the preference with the canonical path", async () => {
    api(undefined, {
      sessions: [...sessions,
        { id: "participant-alias", cwd: "/second-alias", status: "idle", resWorkflow: { canonicalCwd: "/project" } },
        { id: "stale-binding", cwd: "/project-alias/", status: "idle", resWorkflow: { canonicalCwd: "/other" } },
      ],
      connection: () => response({ cwd: "/project/", adopted: false }),
    });
    const view = render(<ResearchPipelinePage {...props} cwd="/project-alias/" />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    const selector = screen.getByTestId("research-main-agent-select");
    expect(within(selector).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["", "session-a", "session-b", "ended", "participant-alias"]);
    fireEvent.change(selector, { target: { value: "session-b" } });
    view.unmount();
    render(<ResearchPipelinePage {...props} cwd="/project" />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-b"));
  });

  it("never admits a foreign active session when workspace canonicalization fails", async () => {
    const fetcher = api(undefined, { connection: () => response({ error: "directory unavailable" }, 503) });
    render(<ResearchPipelinePage {...props} activeSessionId="foreign" />);
    await waitFor(() => expect(screen.getByTestId("research-main-agent-controls").textContent).toContain("工作目录未确认"));
    expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("");
    expect(screen.queryByTestId("research-main-agent-open")).toBeNull();
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "不可发送到另一个目录" } });
    expect((screen.getByTestId("research-main-agent-send") as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("reports a disconnected bridge as a failed submission and retains the task without retrying", async () => {
    const fetcher = api(async () => response({ success: false, transmitted: false, error: "no bridge connection for session" }, 502));
    render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "等待恢复后由我重试" } });
    fireEvent.click(screen.getByTestId("research-main-agent-send"));
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("no bridge connection"));
    expect((screen.getByTestId("research-main-agent-prompt") as HTMLTextAreaElement).value).toBe("等待恢复后由我重试");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("labels demo submissions as simulations without claiming real sessions or model execution", async () => {
    api(async () => response({ success: true, transmitted: true, simulated: true }));
    render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "模拟界面检查" } });
    fireEvent.click(screen.getByTestId("research-main-agent-send"));
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("模拟投递；未调用模型"));
    fireEvent.click(screen.getByTestId("research-stage-start-5-writing"));
    fireEvent.click(screen.getByTestId("research-stage-launch"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText(/模拟启动；未创建真实会话、未调用模型/)).toBeTruthy();
  });
});
