import { PluginContextProvider } from "@blackbelt-technology/dashboard-plugin-runtime";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScienceViewer } from "../ScienceViewer.js";
import { I18nProvider, loadCatalog } from "../../../lib/i18n/i18n.js";

class FakeWs extends EventTarget {
  readyState: number = WebSocket.OPEN;
  emit(message: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

const lease = (id = "lease_1234567890123456", expiresAt = Date.now() + 60_000) => ({ availability: "ready", leaseId: id, expiresAt });
const frame = (leaseId = "lease_1234567890123456") => ({ type: "science_view_frame", leaseId, jpegBase64: "/9j/2Q==", metadata: { deviceWidth: 1000, deviceHeight: 800, timestamp: 1 } });
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function mount({ cwd = "/isolated/project", path = "science:workspace", ws = new FakeWs() } = {}) {
  const send = vi.fn();
  const view = (directory: string, target: string, socket: FakeWs) => (
    <I18nProvider><PluginContextProvider ws={socket as unknown as WebSocket} send={send} connectionStatus="connected">
      <ScienceViewer cwd={directory} path={target} />
    </PluginContextProvider></I18nProvider>
  );
  const result = render(view(cwd, path, ws));
  return { ...result, ws, send, change: (directory: string, target = path, socket = ws) => result.rerender(view(directory, target, socket)) };
}
const messages = (send: ReturnType<typeof vi.fn>, type: string) => send.mock.calls.map(([message]) => message).filter(message => message.type === type);

describe("Science viewer uses host-issued leases without a Pi session", () => {
  it("fails closed for a malformed target without calling file or Science APIs", async () => {
    const r = mount({ path: "science:task:../../private" });
    expect(screen.getByTestId("science-view-status").textContent).toContain("Invalid");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(r.send).not.toHaveBeenCalled();
  });

  it("shows unavailable and never renders raw URL/title/reason from an upstream response", async () => {
    fetchMock.mockResolvedValue(json({ availability: "unavailable", reason: "host-unconfigured", url: "http://private/?nonce=secret", title: "secret title" }));
    const r = mount();
    await waitFor(() => expect(screen.getByTestId("science-view-status").textContent).toContain("not configured"));
    expect(document.body.innerHTML).not.toMatch(/nonce|private|secret title|host-unconfigured/);
    expect(r.send).not.toHaveBeenCalled();
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/res-workflow/science/view");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ cwd: "/isolated/project", target: { kind: "workspace" } });
  });

  it("waits for a valid frame of this lease, forwards finite input, and only unsubscribes on close", async () => {
    fetchMock.mockResolvedValue(json(lease()));
    const r = mount({ path: "science:task:task-1" });
    await waitFor(() => expect(messages(r.send, "science_view_subscribe")).toHaveLength(1));
    expect(screen.getByTestId("science-view-status").textContent).toContain("Waiting");
    expect(screen.queryByTestId("science-view-frame")).toBeNull();
    act(() => r.ws.emit(frame("another-lease")));
    expect(screen.queryByTestId("science-view-frame")).toBeNull();
    act(() => r.ws.emit(frame()));
    const image = screen.getByTestId("science-view-frame");
    expect(image.getAttribute("src")).toBe("data:image/jpeg;base64,/9j/2Q==");
    fireEvent.click(screen.getByTestId("science-view-input-toggle"));
    fireEvent.change(screen.getByTestId("science-view-text-bridge"), { target: { value: "中文" } });
    expect(messages(r.send, "science_view_input").map(message => message.input.text)).toEqual(["中", "文"]);
    r.unmount();
    expect(messages(r.send, "science_view_unsubscribe")).toHaveLength(1);
    expect(r.send.mock.calls.some(([message]) => /stop|cancel|submit/.test(message.type))).toBe(false);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)).target).toEqual({ kind: "task", taskId: "task-1" });
  });

  it("clears the old frame immediately when scope changes and ignores late old frames", async () => {
    fetchMock.mockResolvedValueOnce(json(lease())).mockResolvedValueOnce(json({ availability: "unknown", reason: "binding-unavailable" }));
    const r = mount();
    await waitFor(() => expect(messages(r.send, "science_view_subscribe")).toHaveLength(1));
    act(() => r.ws.emit(frame()));
    expect(screen.queryByTestId("science-view-frame")).toBeTruthy();
    r.change("/isolated/other");
    expect(screen.queryByTestId("science-view-frame")).toBeNull();
    act(() => r.ws.emit(frame()));
    await waitFor(() => expect(screen.getByTestId("science-view-status").textContent).toContain("unavailable"));
    expect(screen.queryByTestId("science-view-frame")).toBeNull();
    expect(messages(r.send, "science_view_unsubscribe")).toHaveLength(1);
  });

  it("does not promote an invalid lease or a raw HTTP error to a connected view", async () => {
    fetchMock.mockResolvedValueOnce(json({ ...lease(), leaseId: "http://private/?nonce=secret" }));
    const r = mount();
    await waitFor(() => expect(screen.getByTestId("science-view-status").textContent).toContain("unavailable"));
    expect(r.send).not.toHaveBeenCalled();
    expect(document.body.innerHTML).not.toMatch(/nonce|secret/);
    fetchMock.mockRejectedValueOnce(new Error("http://private/?nonce=secret"));
    fireEvent.click(screen.getByTestId("science-view-retry"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(document.body.innerHTML).not.toMatch(/nonce|secret/);
  });

  it("drops frames and disables input when the host revokes or expires the lease", async () => {
    fetchMock.mockResolvedValue(json(lease()));
    const r = mount();
    await waitFor(() => expect(messages(r.send, "science_view_subscribe")).toHaveLength(1));
    act(() => r.ws.emit(frame()));
    act(() => r.ws.emit({ type: "science_view_status", leaseId: lease().leaseId, state: "expired" }));
    expect(screen.queryByTestId("science-view-frame")).toBeNull();
    expect((screen.getByTestId("science-view-text-bridge") as HTMLInputElement).disabled).toBe(true);
    act(() => r.ws.emit(frame()));
    expect(screen.queryByTestId("science-view-frame")).toBeNull();
  });

  it("obtains one new view lease on a replacement authenticated socket", async () => {
    fetchMock.mockImplementation(async () => json(lease()));
    const r = mount();
    await waitFor(() => expect(messages(r.send, "science_view_subscribe")).toHaveLength(1));
    r.change("/isolated/project", "science:workspace", new FakeWs());
    await waitFor(() => expect(messages(r.send, "science_view_subscribe")).toHaveLength(2));
    expect(messages(r.send, "science_view_unsubscribe")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("releases a late lease response after changing cwd without subscribing it", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }))
      .mockResolvedValueOnce(json({ availability: "unknown", reason: "binding-unavailable" }));
    const r = mount();
    r.change("/isolated/other");
    resolveOld(json(lease()));
    await waitFor(() => expect(messages(r.send, "science_view_unsubscribe")).toHaveLength(1));
    expect(messages(r.send, "science_view_subscribe")).toHaveLength(0);
    expect(screen.queryByTestId("science-view-frame")).toBeNull();
  });

  it("does not queue input after the authenticated socket closes", async () => {
    fetchMock.mockResolvedValue(json(lease()));
    const r = mount();
    await waitFor(() => expect(messages(r.send, "science_view_subscribe")).toHaveLength(1));
    act(() => r.ws.emit(frame()));
    fireEvent.click(screen.getByTestId("science-view-input-toggle"));
    r.ws.readyState = WebSocket.CLOSED;
    fireEvent.change(screen.getByTestId("science-view-text-bridge"), { target: { value: "x" } });
    expect(messages(r.send, "science_view_input")).toHaveLength(0);
  });

  it("uses the Chinese catalog for unavailable state and controls", async () => {
    await loadCatalog("zh-CN");
    localStorage.setItem("pi-dashboard-language", "zh-CN");
    fetchMock.mockResolvedValue(json({ availability: "unavailable", reason: "host-unconfigured" }));
    mount();
    await waitFor(() => expect(screen.getByTestId("science-view-status").textContent).toBe("尚未配置 Science 查看服务"));
    expect(screen.getByTestId("science-view-retry").textContent).toBe("重新连接画面");
  });
});
