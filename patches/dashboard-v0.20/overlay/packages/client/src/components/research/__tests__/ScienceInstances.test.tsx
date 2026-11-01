import { PluginContextProvider } from "@blackbelt-technology/dashboard-plugin-runtime";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, loadCatalog } from "../../../lib/i18n/i18n.js";
import { ScienceInstances } from "../ScienceInstances.js";

const TASK = "si-00000000-0000-4000-8000-000000000001";
const ARTIFACT = "sa-00000000-0000-4000-8000-000000000002";
const summary = { id: TASK, status: "waiting-approval", createdAt: 1000, lastObservedAt: 2000, stale: false };
const detail = { ...summary, modelIds: ["ark-sci-deepseek-v4.1-flash"], usage: null, cost: null, artifacts: [{ id: ARTIFACT, name: "values.csv", mediaType: "text/csv", bytes: 10, sha256: "a".repeat(64) }] };
const ready = () => ({ availability: "ready", instances: [summary] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => { localStorage.clear(); fetchMock.mockReset(); vi.stubGlobal("fetch", fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount(cwd = "/fixture/project") {
  const openTask = vi.fn(), openArtifact = vi.fn();
  const view = (directory: string) => <I18nProvider><ScienceInstances cwd={directory} onOpenTask={openTask} onOpenArtifact={openArtifact} /></I18nProvider>;
  const result = render(view(cwd));
  return { ...result, openTask, openArtifact, change: (directory: string) => result.rerender(view(directory)) };
}

const fakeSocket = () => new EventTarget() as unknown as WebSocket;
type Connection = "connected" | "disconnected" | "auth_required";
function ConnectedRecords({ socket, connection = "connected", commit }: { socket: WebSocket | null; connection?: Connection; commit?: (hasRecords: boolean) => void }) {
  useLayoutEffect(() => { commit?.(screen.queryAllByTestId("science-instance").length > 0); });
  return <I18nProvider><PluginContextProvider ws={socket} connectionStatus={connection}><ScienceInstances cwd="/fixture/project" /></PluginContextProvider></I18nProvider>;
}

describe("Science directory instance records", () => {
  it("clears same-cwd records before passive effects when a replacement owner socket appears", async () => {
    const socket = fakeSocket(); const commits: boolean[] = [];
    const commit = (hasRecords: boolean) => { commits.push(hasRecords); };
    fetchMock.mockResolvedValueOnce(json(ready()));
    const r = render(<ConnectedRecords socket={socket} commit={commit} />);
    await screen.findByText("Waiting for approval");
    fetchMock.mockImplementation(() => new Promise(() => {}));
    r.rerender(<ConnectedRecords socket={fakeSocket()} commit={commit} />);
    expect(commits.at(-1)).toBe(false);
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("never reuses old records or selected details when socket A changes to B and back to A", async () => {
    const socket = fakeSocket();
    fetchMock.mockResolvedValueOnce(json(ready())).mockResolvedValueOnce(json({ availability: "ready", instance: detail }));
    const r = render(<ConnectedRecords socket={socket} />);
    await screen.findByText("Waiting for approval"); fireEvent.click(screen.getByRole("button", { name: "Details" })); await screen.findByText("values.csv");
    fetchMock.mockImplementation(() => new Promise(() => {}));
    r.rerender(<ConnectedRecords socket={fakeSocket()} />);
    expect(screen.queryAllByTestId("science-instance")).toHaveLength(0);
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    r.rerender(<ConnectedRecords socket={socket} />);
    expect(screen.queryAllByTestId("science-instance")).toHaveLength(0); expect(screen.queryByText("values.csv")).toBeNull();
    await act(async () => finish(json(ready())));
    await screen.findByText("Waiting for approval");
    expect(screen.getByRole("button", { name: "Details" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("values.csv")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("keeps same-owner records stale during disconnect but fences a new non-null socket", async () => {
    const socket = fakeSocket(); fetchMock.mockResolvedValueOnce(json(ready()));
    const r = render(<ConnectedRecords socket={socket} />); await screen.findByText("Waiting for approval");
    r.rerender(<ConnectedRecords socket={null} connection="disconnected" />);
    expect(screen.getByText("Waiting for approval")).toBeTruthy(); expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockResolvedValueOnce(json({ availability: "unknown", reason: "host-offline" }));
    fireEvent.click(screen.getByRole("button", { name: "Refresh Science records" })); await screen.findByText("Stale");
    expect(screen.getByRole("status").textContent).toContain("last observation");
    fetchMock.mockImplementation(() => new Promise(() => {}));
    r.rerender(<ConnectedRecords socket={fakeSocket()} />);
    expect(screen.queryByText("Waiting for approval")).toBeNull(); expect(fetchMock).toHaveBeenCalledTimes(3);
  });
  it("clears records during auth_required without reading until authentication returns", async () => {
    const socket = fakeSocket(); fetchMock.mockResolvedValueOnce(json(ready()));
    const r = render(<ConnectedRecords socket={socket} />); await screen.findByText("Waiting for approval");
    r.rerender(<ConnectedRecords socket={null} connection="auth_required" />);
    expect(screen.queryAllByTestId("science-instance")).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toContain("unavailable");
    expect((screen.getByRole("button", { name: "Refresh Science records" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    fetchMock.mockImplementation(() => new Promise(() => {}));
    r.rerender(<ConnectedRecords socket={socket} />);
    expect(screen.queryAllByTestId("science-instance")).toHaveLength(0); expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("ignores an old owner's late list response after a new socket has loaded", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const r = render(<ConnectedRecords socket={fakeSocket()} />);
    fetchMock.mockResolvedValueOnce(json({ availability: "ready", instances: [] }));
    r.rerender(<ConnectedRecords socket={fakeSocket()} />);
    expect(fetchMock).toHaveBeenCalledTimes(2); await screen.findByText("No Science instances are bound to this directory.");
    await act(async () => finish(json(ready())));
    expect(screen.queryByText("Waiting for approval")).toBeNull();
  });
  it("shows an honest unavailable state and never displays raw host errors or page metadata", async () => {
    fetchMock.mockResolvedValue(json({ availability: "unavailable", reason: "host-unconfigured", title: "private title", url: "http://private/?nonce=secret" }));
    mount(); await waitFor(() => expect(screen.getByRole("status").textContent).toContain("not configured"));
    expect(document.body.innerHTML).not.toMatch(/private|nonce|secret|host-unconfigured/);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/res-workflow/science/instances?cwd=%2Ffixture%2Fproject");
  });

  it("opens a bound task and its artifact without creating or resubmitting an analysis", async () => {
    fetchMock.mockResolvedValueOnce(json(ready())).mockResolvedValueOnce(json({ availability: "ready", instance: detail }));
    const r = mount(); await screen.findByText("Waiting for approval");
    fireEvent.click(screen.getByRole("button", { name: "Open task" })); expect(r.openTask).toHaveBeenCalledWith(TASK);
    fireEvent.click(screen.getByRole("button", { name: "Details" }));
    await screen.findByText("values.csv");
    expect(screen.getByText("Recorded")).toBeTruthy(); expect(screen.queryByText("Created")).toBeNull();
    expect(screen.getByText("ark-sci-deepseek-v4.1-flash")).toBeTruthy();
    expect(screen.getAllByText("Unknown").length).toBeGreaterThanOrEqual(2);
    fireEvent.click(screen.getByRole("button", { name: "Preview" })); expect(r.openArtifact).toHaveBeenCalledWith(TASK, ARTIFACT);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    expect(fetchMock.mock.calls.some(([input]) => /\/api\/file|submit|cancel|approve/.test(String(input)))).toBe(false);
  });

  it("retains only this directory's last observation and marks it stale when the host is offline", async () => {
    fetchMock.mockResolvedValueOnce(json(ready())).mockRejectedValueOnce(new Error("http://private/?nonce=secret"));
    mount(); await screen.findByText("Waiting for approval");
    fireEvent.click(screen.getByRole("button", { name: "Refresh Science records" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("last observation"));
    expect(screen.getByText("Waiting for approval")).toBeTruthy(); expect(screen.getByText("Stale")).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(/nonce|secret/);
  });

  it("clears the previous partition immediately and ignores a late response after switching cwd", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockResolvedValueOnce(json({ availability: "ready", instances: [] }));
    const r = mount(); r.change("/fixture/other");
    await screen.findByText("No Science instances are bound to this directory.");
    await act(async () => finish(json(ready())));
    expect(screen.queryByText("Waiting for approval")).toBeNull();
    expect(r.openTask).not.toHaveBeenCalled();
  });

  it("drops cached records when a refresh refuses access", async () => {
    fetchMock.mockResolvedValueOnce(json(ready())).mockResolvedValueOnce(json({ error: "workspace-not-found" }, 404));
    mount(); await screen.findByText("Waiting for approval");
    fireEvent.click(screen.getByRole("button", { name: "Refresh Science records" }));
    await waitFor(() => expect(screen.queryByText("Waiting for approval")).toBeNull());
    expect(screen.getByRole("status").textContent).toContain("unavailable");
  });

  it("renders translated unknown values and approval state without claiming scientific acceptance", async () => {
    await loadCatalog("zh-CN"); localStorage.setItem("pi-dashboard-language", "zh-CN");
    fetchMock.mockResolvedValueOnce(json(ready())).mockResolvedValueOnce(json({ availability: "ready", instance: detail }));
    mount(); await screen.findByText("等待审批"); fireEvent.click(screen.getByRole("button", { name: "详情" }));
    await screen.findByText("values.csv"); expect(screen.getAllByText("未知").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("登记时间")).toBeTruthy(); expect(screen.queryByText("创建时间")).toBeNull();
    expect(document.body.textContent).toContain("不等于科学验收");
  });
});
