import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { SessionList } from "../../session/SessionList.js";
import { ThemeProvider } from "../../settings/ThemeProvider.js";

const CWD = "/isolated/res-workflow";
const session = (id: string, status = "ended") => ({ id, cwd: CWD, status, source: "tui", startedAt: 1, tokensIn: 0, tokensOut: 0, cost: 0 }) as DashboardSession;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, entries: [] }), { headers: { "content-type": "application/json" } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("directory res-workflow entry", () => {
  it.each([
    ["empty pinned folder", []],
    ["history-only folder", [session("old")]],
    ["multiple sessions sharing a folder", [session("a", "idle"), session("b")]],
  ])("opens one shared pane for an %s", (_label, sessions) => {
    const onOpenResearch = vi.fn();
    const { hook } = memoryLocation({ path: "/", static: true });
    render(<Router hook={hook}><ThemeProvider><SessionList sessions={sessions} onSelect={vi.fn()} pinnedDirectories={[CWD]} onOpenResearch={onOpenResearch} /></ThemeProvider></Router>);
    const entry = screen.getByTestId(`folder-res-workflow-${CWD}`);
    expect(screen.getAllByTestId(/^folder-res-workflow-/)).toHaveLength(1);
    expect(entry.parentElement?.className).toContain("grid-cols");
    const legend = entry.querySelector<HTMLElement>("[data-slot-pill-legend]");
    expect(legend?.textContent).toBe("res-workflow");
    expect(legend?.style.textTransform).toBe("none");
    fireEvent.click(entry);
    fireEvent.keyDown(entry, { key: "Enter" });
    expect(onOpenResearch.mock.calls).toEqual([[CWD], [CWD]]);
    expect(screen.queryByTestId("session-header-research")).toBeNull();
  });
});
