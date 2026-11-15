import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUuid } from "@blackbelt-technology/dashboard-plugin-runtime";
import { ResearchPipelinePage } from "../ResearchPipelinePage.js";
import type { ResearchCollaborationSnapshot } from "@blackbelt-technology/pi-dashboard-shared/research-collaboration.js";

const { liveState } = vi.hoisted(() => ({ liveState: {
  snapshot: { state: null, attempts: [], events: [], receipt: null },
  adoption: null, adopted: false, loading: false, refreshing: false, error: null,
  checkedAt: "2026-11-06T10:00:00Z", refresh: vi.fn(), workbench: null,
  observationStatus: "unavailable", observationError: null,
} }));
vi.mock("../use-research-loop-live.js", () => ({ useResearchLoopLive: () => liveState }));
vi.mock("../ScienceInstances.js", () => ({ ScienceInstances: () => null }));
vi.mock("../ResearchAccessControls.js", () => ({ ResearchAccessControls: () => null }));
vi.mock("@blackbelt-technology/dashboard-plugin-runtime", () => ({ useSessionSubagents: () => new Map(), randomUuid: vi.fn(() => "test-request"), usePluginSocket: () => null, useShellConnectionStatus: () => "connected" }));

const sessions = [
  { id: "session-a", cwd: "/project", name: "研究主会话 A", status: "idle", model: "provider/model-a" },
  { id: "session-b", cwd: "/project", name: "研究主会话 B", status: "streaming", model: "provider/model-b" },
  { id: "ended", cwd: "/project", name: "已结束的研究", status: "ended" },
  { id: "foreign", cwd: "/other", name: "另一个项目", status: "idle" },
  { id: "remote", cwd: "/project", name: "远端同名目录", status: "idle", originDeviceId: "another-host" },
  { id: "acp", cwd: "/project", name: "ACP 会话", status: "idle", driver: "acp" },
];
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
function collaboration(cwd: string, sessionId: string | null): ResearchCollaborationSnapshot {
  return { schema: "pi-research-collaboration.v1", cwd, adopted: true, revision: 1,
    currentMainSessionId: sessionId, currentTenureId: sessionId ? `tenure-${sessionId}` : null,
    limits: { maxMultiAgents: 4, maxSubagents: 3 }, limitMaximums: { maxMultiAgents: 8, maxSubagents: 32 },
    tenures: sessionId ? [{ id: `tenure-${sessionId}`, ordinal: 1, mainSessionId: sessionId, startedAt: "2026-11-16T00:00:00Z", status: "current", sessionIds: [sessionId] }] : [],
    detachedSessionIds: [], plans: [], nativeQueue: [],
  };
}
function api(post?: (url: string, init: RequestInit, normal: ResearchCollaborationSnapshot | null) => Promise<Response>, options: { sessions?: unknown[]; connection?: (cwd: string) => Response; canonical?: (cwd: string) => string; initialMains?: Record<string, string | null> } = {}) {
  const states = new Map<string, ResearchCollaborationSnapshot>();
  const current = (cwd: string) => {
    const canonical = options.canonical?.(cwd) ?? cwd.replace(/\/$/, "");
    if (!states.has(canonical)) states.set(canonical, collaboration(canonical, options.initialMains && canonical in options.initialMains ? options.initialMains[canonical]! : canonical === "/other" ? "foreign" : "session-a"));
    return states.get(canonical)!;
  };
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).includes("/api/res-workflow/collaboration")) {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        const previous = current(body.cwd);
        let next: ResearchCollaborationSnapshot = { ...previous, revision: previous.revision + 1 };
        if (body.action === "select-main") next = { ...next, currentMainSessionId: body.sessionId, currentTenureId: `tenure-${body.sessionId}`,
          tenures: [...previous.tenures.map(tenure => ({ ...tenure, status: "historical" as const })), { id: `tenure-${body.sessionId}`, ordinal: previous.tenures.length + 1, mainSessionId: body.sessionId, startedAt: "2026-11-16T01:00:00Z", status: "current", sessionIds: [body.sessionId] }] };
        if (body.action === "send-main-task") next = { ...next, promptReceipt: { success: true, transmitted: true, promptId: "prompt-one" } };
        const result = post ? await post(String(url), init, next) : response(next);
        if (result.ok) {
          const json = await result.clone().json();
          if (json.schema === "pi-research-collaboration.v1") states.set(previous.cwd, json);
        }
        return result;
      }
      return response(current(new URL(String(url), "http://fixture.invalid").searchParams.get("cwd")!));
    }
    if (init?.method === "POST") return post ? post(String(url), init, null) : response({ success: true, transmitted: true, promptId: "prompt-one" });
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
beforeEach(() => { window.localStorage.clear(); vi.mocked(randomUuid).mockReset().mockReturnValue("test-request"); });
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
    await waitFor(() => expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/session-b"));
    await waitFor(() => expect(selector.disabled).toBe(false));
    const choice = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(String(choice[0])).toBe("/api/res-workflow/collaboration");
    expect(JSON.parse(String(choice[1]?.body))).toEqual({ cwd: "/project", action: "select-main", sessionId: "session-b", expectedRevision: 1 });
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "拆分三项独立验证，交给子 agent 执行并核对结论。" } });
    fireEvent.click(screen.getByTestId("research-main-agent-send"));
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("已提交"));
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts).toHaveLength(2);
    expect(String(posts[1][0])).toBe("/api/res-workflow/collaboration");
    const task = JSON.parse(String(posts[1][1]?.body));
    expect(task).toMatchObject({ action: "send-main-task", sessionId: "session-b", cwd: "/project", expectedRevision: 2, requestId: "test-request" });
    expect(task.text).toContain("拆分三项独立验证，交给子 agent 执行并核对结论。");
    expect(posts.some(([url]) => String(url).includes("/prompt"))).toBe(false);
    expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("研究主会话 B");
  });

  it("retains the chosen main agent across views and remounts without assigning it to another workspace", async () => {
    api();
    const view = render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    fireEvent.change(screen.getByTestId("research-main-agent-select"), { target: { value: "session-b" } });
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-b"));
    view.rerender(<ResearchPipelinePage {...props} surface="agents" />);
    expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-b");
    view.unmount();
    const next = render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-b"));
    next.rerender(<ResearchPipelinePage {...props} cwd="/other" activeSessionId="foreign" />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("foreign"));
    expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/foreign");
  });

  it("keeps an ended authoritative main viewable but never submits a task to it", async () => {
    const fetcher = api(undefined, { initialMains: { "/project": "ended" } });
    render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("ended"));
    expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/ended");
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "不得误投递" } });
    expect((screen.getByTestId("research-main-agent-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("research-main-agent-controls").textContent).toContain("已结束");
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does not bind an active tab or a saved browser preference when the server has no main", async () => {
    window.localStorage.setItem("res_workflow_main_agent:/project", "session-b");
    const fetcher = api(undefined, { initialMains: { "/project": null } });
    render(<ResearchPipelinePage {...props} activeSessionId="session-b" />);
    const selector = screen.getByTestId("research-main-agent-select") as HTMLSelectElement;
    await waitFor(() => expect(selector.disabled).toBe(false));
    expect(selector.value).toBe("");
    expect(screen.queryByTestId("research-main-agent-open")).toBeNull();
    expect((within(selector).getByRole("option", { name: "已结束的研究 · 已结束" }) as HTMLOptionElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "不得自动指定" } });
    expect((screen.getByTestId("research-main-agent-send") as HTMLButtonElement).disabled).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("does not report a 200 response without a transmission receipt as a successful main-agent submission", async () => {
    const fetcher = api(async (_url, _init, normal) => { const { promptReceipt: _receipt, ...value } = normal!; return response(value); });
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

  it("waits for a confirmed receipt and reuses the delivery key when retrying an unchanged draft after an unknown result", async () => {
    let resolveFirst!: (value: Response) => void;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    let submissions = 0;
    const fetcher = api(async (_url, _init, normal) => ++submissions === 1 ? first : response(normal));
    vi.mocked(randomUuid).mockReturnValueOnce("stable-delivery").mockReturnValue("unexpected-new-key");
    render(<ResearchPipelinePage {...props} />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("research-main-agent-compose"));
    fireEvent.change(screen.getByTestId("research-main-agent-prompt"), { target: { value: "未知回执不能变成第二个模型轮次" } });
    fireEvent.click(screen.getByTestId("research-main-agent-send"));
    expect((screen.getByTestId("research-main-agent-send") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByTestId("research-main-agent-feedback")).toBeNull();
    await act(async () => { resolveFirst(response({ error: "delivery-unconfirmed" }, 502)); });
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").getAttribute("role")).toBe("alert"));
    expect((screen.getByTestId("research-main-agent-prompt") as HTMLTextAreaElement).value).toBe("未知回执不能变成第二个模型轮次");
    await waitFor(() => expect((screen.getByTestId("research-main-agent-send") as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByTestId("research-main-agent-send"));
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("已提交"));
    const posts = fetcher.mock.calls.filter(([, init]) => init?.method === "POST").map(([, init]) => JSON.parse(String(init?.body)));
    expect(posts).toHaveLength(2);
    expect(posts.map(post => post.requestId)).toEqual(["stable-delivery", "stable-delivery"]);
    expect(randomUuid).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId("research-main-agent-prompt") as HTMLTextAreaElement).value).toBe("");
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
    await waitFor(() => expect(selectors.map(selector => selector.value)).toEqual(["session-b", "session-b"]));
    expect(screen.getAllByTestId("research-main-agent-open").map(link => link.getAttribute("href"))).toEqual(["/session/session-b", "/session/session-b"]);
  });

  it("uses the admitted canonical workspace for aliases and shares the authoritative tenure with the canonical path", async () => {
    const fetcher = api(undefined, {
      sessions: [...sessions,
        { id: "participant-alias", cwd: "/second-alias", status: "idle", resWorkflow: { canonicalCwd: "/project" } },
        { id: "stale-binding", cwd: "/project-alias/", status: "idle", resWorkflow: { canonicalCwd: "/other" } },
      ],
      connection: () => response({ cwd: "/project/", adopted: false }),
      canonical: () => "/project",
    });
    const view = render(<ResearchPipelinePage {...props} cwd="/project-alias/" />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-a"));
    const selector = screen.getByTestId("research-main-agent-select");
    expect(within(selector).getAllByRole("option").map(option => (option as HTMLOptionElement).value)).toEqual(["", "session-a", "session-b", "ended", "participant-alias"]);
    fireEvent.change(selector, { target: { value: "session-b" } });
    await waitFor(() => expect((selector as HTMLSelectElement).value).toBe("session-b"));
    const choice = fetcher.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(choice[1]?.body)).cwd).toBe("/project");
    view.unmount();
    render(<ResearchPipelinePage {...props} cwd="/project" />);
    await waitFor(() => expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).toBe("session-b"));
  });

  it("never admits a foreign active session when workspace canonicalization fails", async () => {
    const fetcher = api(undefined, { connection: () => response({ error: "directory unavailable" }, 503) });
    render(<ResearchPipelinePage {...props} activeSessionId="foreign" />);
    await waitFor(() => expect(screen.getByTestId("research-main-agent-controls").textContent).toContain("工作目录未确认"));
    expect((screen.getByTestId("research-main-agent-select") as HTMLSelectElement).value).not.toBe("foreign");
    expect(screen.getByTestId("research-main-agent-open").getAttribute("href")).toBe("/session/session-a");
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
    await waitFor(() => expect(screen.getByTestId("research-main-agent-feedback").textContent).toContain("HTTP 502"));
    expect((screen.getByTestId("research-main-agent-prompt") as HTMLTextAreaElement).value).toBe("等待恢复后由我重试");
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });

  it("labels demo submissions as simulations without claiming real sessions or model execution", async () => {
    api(async (_url, _init, normal) => response(normal ? { ...normal, promptReceipt: { ...normal.promptReceipt, simulated: true } } : { success: true, transmitted: true, simulated: true }));
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
