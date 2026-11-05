import { DISPLAY_PRESETS } from "@blackbelt-technology/pi-dashboard-shared/display-prefs.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../../lib/chat/event-reducer.js";
import type { ChatItem, ToolCallGroup } from "../../lib/chat/group-tool-calls.js";
import { DisplayPrefsProvider } from "../../lib/state/DisplayPrefsContext.js";
import { ToolBurstGroup } from "../chat/ToolBurstGroup.js";
import { ChatViewMenu } from "../chat/ChatViewMenu.js";
import { ThemeProvider } from "../settings/ThemeProvider.js";

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});
afterEach(cleanup);

const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, toolCallId: id, role: "toolResult", toolName: "bash", content: "", timestamp: 1,
  toolStatus: "complete", args: { command: `task ${id}` }, result: `output ${id}`, ...patch,
});
const prefs = { ...DISPLAY_PRESETS.standard, toolGroupDefaultCollapsed: true };
function tree(items: ChatItem[]) {
  return <ThemeProvider><DisplayPrefsProvider value={{ global: prefs, getSessionOverride: () => undefined }}>
    <ToolBurstGroup burst={{ id: "b1", type: "burst", items }} toolContext={{}} />
  </DisplayPrefsProvider></ThemeProvider>;
}

describe("execution records keep attention visible", () => {
  it("keeps ordinary logs folded while exposing a failed tool and its original output", () => {
    const normal = message("normal");
    const failed = message("failed", { toolStatus: "error", result: "Original error: simulation did not converge" });
    const { container } = render(tree([normal, failed]));
    expect(screen.getByTestId("tool-burst-header").getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-tool-call-id="normal"]')).toBeNull();
    expect(screen.getByText("Original error: simulation did not converge", { exact: false })).toBeTruthy();
    expect(screen.getByTestId("tool-burst-error-glyph")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tool-burst-header"));
    expect(container.querySelector('[data-tool-call-id="normal"]')).toBeTruthy();
    fireEvent.click(screen.getByTestId("tool-burst-header"));
    expect(container.querySelector('[data-tool-call-id="failed"]')).toBeTruthy();
    expect(container.querySelector('[data-tool-call-id="normal"]')).toBeNull();
  });

  it("keeps a failed nested repeated call mounted across parent expansion", () => {
    const first = message("poll-1");
    const failed = message("poll-2", { toolStatus: "error", result: "Recorded poll failure" });
    const third = message("poll-3");
    const group: ToolCallGroup = { type: "group", toolName: "bash", summary: "poll", messages: [first, failed, third], rendered: [first, failed, third] };
    const { container } = render(tree([group, message("other")]));
    const errorRow = container.querySelector('[data-tool-call-id="poll-2"]');
    expect(errorRow).toBeTruthy();
    expect(container.querySelector('[data-tool-call-id="poll-1"]')).toBeNull();
    fireEvent.click(screen.getByTestId("tool-burst-header"));
    expect(container.querySelector('[data-tool-call-id="poll-2"]')).toBe(errorRow);
    fireEvent.click(screen.getByTestId("tool-burst-header"));
    expect(container.querySelector('[data-tool-call-id="poll-2"]')).toBe(errorRow);
  });

  it("never buries an ask_user row when ordinary records are folded", () => {
    const prompt = message("question", { toolName: "ask_user", toolStatus: "running", args: { question: "Which dataset?" } });
    const { container, rerender } = render(tree([message("read"), prompt]));
    const question = container.querySelector('[data-tool-call-id="question"]');
    expect(question).toBeTruthy();
    fireEvent.click(screen.getByTestId("tool-burst-header"));
    expect(container.querySelector('[data-tool-call-id="question"]')).toBe(question);
    fireEvent.click(screen.getByTestId("tool-burst-header"));
    rerender(tree([message("read"), { ...prompt, duration: 500 }]));
    expect(container.querySelector('[data-tool-call-id="question"]')).toBe(question);
  });

  it("changes only the existing execution-collapse preference and retains unrelated session overrides", () => {
    const send = vi.fn();
    render(<ThemeProvider><DisplayPrefsProvider value={{ global: prefs, getSessionOverride: () => undefined }}>
      <ChatViewMenu sessionId="s1" send={send} currentOverride={{ reasoning: true, toolCalls: { read: false } }} />
    </DisplayPrefsProvider></ThemeProvider>);
    fireEvent.click(screen.getByTitle("View options"));
    fireEvent.click(screen.getByRole("button", { name: "Live details" }));
    expect(send).toHaveBeenCalledWith({ type: "setSessionDisplayPrefs", sessionId: "s1", override: { reasoning: true, toolCalls: { read: false }, toolGroupDefaultCollapsed: false } });
  });
});
