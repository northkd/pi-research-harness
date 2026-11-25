import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { useThinkingTranslation } from "../../../hooks/useThinkingTranslation.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThinkingTranslationPanel } from "../ThinkingTranslationPanel.js";
import { ThinkingTranslationSettings } from "../ThinkingTranslationSettings.js";

vi.mock("../../../lib/i18n/i18n.js", () => ({ useI18n: () => ({ language: "zh-CN", t: (_key: string, _vars: unknown, fallback: string) => fallback }) }));
vi.mock("../../../lib/api/api-context.js", () => ({ useApiBase: () => "" }));
vi.mock("../../../lib/api/res-workflow-api.js", () => ({ getResWorkflowModels: async () => [{ provider: "fake", id: "nested/translator", name: "Nested translator" }, { provider: "other", id: "translator", name: "Other translator" }] }));
vi.mock("../../settings/ModelSelector.js", () => ({ ModelSelector: ({ current, models, onSelect }: any) => <select aria-label="translation model" value={current ?? ""} onChange={(event) => onSelect(event.target.value)}><option value="">Choose</option>{models.map((m: any) => <option key={`${m.provider}/${m.id}`} value={`${m.provider}/${m.id}`}>{m.name}</option>)}</select> }));

class FakeSocket extends EventTarget {
  send = vi.fn();
  message(frame: unknown) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(frame) })); }
}
const frame = (patch: Record<string, unknown> = {}) => ({ type: "thinking_translation", kind: "snapshot", sessionId: "session-one", runtimeId: "runtime-one", generation: 1, sequence: 1, turnId: "turn-one", expiresAt: Date.now() + 30_000, blocks: [{ messageId: "message-one", blockId: "0:0", original: "Observable thinking.", translation: "可见思考译文。" }], ...patch });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("transient thinking translation panel", () => {
  it("uses display memory, supports original comparison and clears at TTL without storage or requests", async () => {
    vi.useFakeTimers();
    const storage = vi.spyOn(Storage.prototype, "setItem");
    const socket = new FakeSocket();
    render(<ThinkingTranslationPanel sessionId="session-one" ws={socket as unknown as WebSocket} connected />);
    expect(screen.queryByTestId("thinking-translation-panel")).toBeNull();
    act(() => socket.message(frame()));
    expect(screen.getByText("可见思考译文。")).toBeTruthy();
    const summary = screen.getByText("查看原文对照");
    fireEvent.click(summary);
    expect(screen.getByText("Observable thinking.")).toBeTruthy();
    expect(storage).not.toHaveBeenCalled(); expect(socket.send).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(30_001));
    expect(screen.queryByTestId("thinking-translation-panel")).toBeNull();
  });
  it("isolates session, generation and disconnect; late old frames never reappear", () => {
    const socket = new FakeSocket();
    const view = render(<ThinkingTranslationPanel sessionId="session-one" ws={socket as unknown as WebSocket} connected />);
    act(() => socket.message(frame()));
    expect(screen.getByText("可见思考译文。")).toBeTruthy();
    act(() => socket.message(frame({ generation: 0, sequence: 100, blocks: [{ messageId: "older", blockId: "0", original: "old", translation: "过期译文" }] })));
    expect(screen.queryByText("过期译文")).toBeNull();
    view.rerender(<ThinkingTranslationPanel sessionId="session-two" ws={socket as unknown as WebSocket} connected />);
    expect(screen.queryByText("可见思考译文。")).toBeNull();
    act(() => socket.message(frame({ sequence: 2 })));
    expect(screen.queryByTestId("thinking-translation-panel")).toBeNull();
    act(() => socket.message(frame({ sessionId: "session-two" })));
    expect(screen.getByText("可见思考译文。")).toBeTruthy();
    act(() => socket.dispatchEvent(new Event("close")));
    act(() => socket.message(frame({ sessionId: "session-two", sequence: 2 })));
    expect(screen.queryByTestId("thinking-translation-panel")).toBeNull();
  });
  it("never returns an old snapshot even in the first render after same-session socket replacement", () => {
    const first = new FakeSocket(), second = new FakeSocket();
    const samples: Array<ReturnType<typeof useThinkingTranslation>> = [];
    const hook = renderHook(({ ws }) => { const value = useThinkingTranslation("session-one", ws, true); samples.push(value); return value; }, { initialProps: { ws: first as unknown as WebSocket } });
    act(() => first.message(frame()));
    expect(hook.result.current.snapshot).not.toBeNull();
    const before = samples.length;
    hook.rerender({ ws: second as unknown as WebSocket });
    expect(samples.slice(before).every((sample) => sample.snapshot === null && !sample.blocked)).toBe(true);
    act(() => first.message(frame({ sequence: 2 })));
    expect(hook.result.current.snapshot).toBeNull();
  });
  it("a translation failure has a local status only and cannot write chat messages", () => {
    const socket = new FakeSocket();
    render(<ThinkingTranslationPanel sessionId="session-one" ws={socket as unknown as WebSocket} connected />);
    const status = frame({ kind: "status", state: "blocked", blocks: undefined });
    act(() => socket.message(status));
    expect(screen.getByRole("status").textContent).toContain("原始回答继续");
    expect(socket.send).not.toHaveBeenCalled();
  });
});

describe("separate explicit translation consent", () => {
  const initial = { success: true, sessionId: "session-one", enabled: false, model: null, runtime: "pending-safe-load" };
  it("does nothing without a session; cancellation never authorizes or switches the main model", async () => {
    const fetch = vi.fn(async () => Response.json(initial)); vi.stubGlobal("fetch", fetch);
    const view = render(<ThinkingTranslationSettings />);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("请先选择一个 Pi 会话，再为该会话授权翻译。")).toBeTruthy();
    view.rerender(<ThinkingTranslationSettings sessionId="session-one" cwd="/isolated/qa" />);
    await screen.findByText(/插件待安全加载/);
    fireEvent.click(screen.getByRole("button", { name: "选择模型并授权" }));
    await screen.findByRole("dialog");
    expect((screen.getByRole("button", { name: "确认授权" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(fetch.mock.calls.every((call: any[]) => !call[1]?.method || call[1].method === "GET")).toBe(true);
  });
  it("requires model plus scope confirmation and preserves nested physical model IDs", async () => {
    const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => options?.method === "PUT" ? Response.json({ ...initial, enabled: true, model: { provider: "fake", id: "nested/translator" } }) : Response.json(initial));
    vi.stubGlobal("fetch", fetch);
    render(<ThinkingTranslationSettings sessionId="session-one" cwd="/isolated/qa" />);
    await waitFor(() => expect((screen.getByRole("button", { name: "选择模型并授权" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "选择模型并授权" }));
    await screen.findByRole("option", { name: "Nested translator" });
    fireEvent.change(screen.getByLabelText("translation model"), { target: { value: "fake/nested/translator" } });
    expect((screen.getByRole("button", { name: "确认授权" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "确认授权" }));
    await waitFor(() => expect(fetch.mock.calls.some((call: any[]) => call[1]?.method === "PUT")).toBe(true));
    const put = fetch.mock.calls.find((call: any[]) => call[1]?.method === "PUT")!;
    expect(JSON.parse(String(put[1]?.body))).toEqual({ sessionId: "session-one", enabled: true, model: { provider: "fake", id: "nested/translator" }, consent: true });
    expect(fetch.mock.calls.some((call: any[]) => String(call[0]).includes("set_model"))).toBe(false);
  });
});
