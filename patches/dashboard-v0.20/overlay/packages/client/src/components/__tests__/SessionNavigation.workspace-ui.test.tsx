import { createSlotRegistry, PluginContextProvider } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type React from "react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";
import { useMobile } from "../../hooks/useMobile.js";
import { SessionCard } from "../session/SessionCard.js";
import { SessionList } from "../session/SessionList.js";
import { ThemeProvider } from "../settings/ThemeProvider.js";

vi.mock("../../hooks/useMobile.js", () => ({ useMobile: vi.fn(() => false) }));
vi.mock("@blackbelt-technology/pi-dashboard-speed-plugin", () => ({
  SessionBillingCost: () => <span>¥0.42</span>,
  FolderBillingCost: () => <span>¥1.28</span>,
}));

beforeEach(() => {
  vi.mocked(useMobile).mockReturnValue(false);
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn((query: string) => ({ matches: false, media: query, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const session = (patch: Partial<DashboardSession> = {}): DashboardSession => ({
  id: "s1", cwd: "/research/project", name: "Review experiment results", source: "tui",
  status: "idle", startedAt: 1000, tokensIn: 0, tokensOut: 0, cost: 0,
  model: "provider/research-model", ...patch,
});

const baseCard = {
  selectedId: "s1", onSelect: vi.fn(), now: 2000, showGitInfo: true,
  isHidden: false, onArchive: vi.fn(), onShutdown: vi.fn(),
};

function listTree(props: Partial<React.ComponentProps<typeof SessionList>> = {}, registry = createSlotRegistry()) {
  const { hook } = memoryLocation({ path: "/", static: true });
  return <Router hook={hook}><ThemeProvider><PluginContextProvider registry={registry}>
    <SessionList sessions={[session()]} onSelect={() => {}} {...props} />
  </PluginContextProvider></ThemeProvider></Router>;
}

describe("research workspace session navigation", () => {
  it("defaults to compact, keeps the comfortable view available, and restores the chosen density", () => {
    const first = render(listTree());
    expect(screen.getByTestId("session-card-desktop").getAttribute("data-density")).toBe("compact");
    fireEvent.click(screen.getByRole("button", { name: "Comfortable" }));
    expect(screen.getByTestId("session-card-desktop").getAttribute("data-density")).toBe("comfortable");
    first.unmount();
    render(listTree());
    expect(screen.getByRole("button", { name: "Comfortable" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("session-card-desktop").getAttribute("data-density")).toBe("comfortable");
  });

  it("folds project tools without unmounting plugin state and remembers the folder disclosure", () => {
    const mounted = vi.fn();
    function Tool() {
      const [count, setCount] = useState(0);
      useEffect(() => { mounted(); }, []);
      return <button onClick={() => setCount((n) => n + 1)}>Plugin task {count}</button>;
    }
    const registry = createSlotRegistry();
    registry.addClaim({ pluginId: "preserved-tool", slot: "sidebar-folder-section", priority: 100, Component: Tool });
    const first = render(listTree({}, registry));
    const toggle = screen.getByTestId("folder-project-tools-toggle-/research/project");
    const region = screen.getByTestId("folder-project-tools-/research/project");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(region.hidden).toBe(true);
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Plugin task 0" }));
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: "Plugin task 1" })).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(1);
    first.unmount();
    render(listTree({}, registry));
    expect(screen.getByTestId("folder-project-tools-toggle-/research/project").getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps full session details and plugin state behind a named disclosure without selecting the session", () => {
    const onSelect = vi.fn();
    const mounted = vi.fn();
    function Memory() {
      useEffect(() => { mounted(); }, []);
      return <span data-testid="preserved-memory">Memory history</span>;
    }
    const registry = createSlotRegistry();
    registry.addClaim({ pluginId: "memory", slot: "session-card-memory", priority: 100, Component: Memory });
    render(<PluginContextProvider registry={registry}>
      <SessionCard {...baseCard} session={session()} onSelect={onSelect} density="compact" />
    </PluginContextProvider>);
    const details = screen.getByTestId("session-card-details-s1");
    expect(details.hidden).toBe(true);
    expect(within(details).getByText("research-model")).toBeTruthy();
    expect(within(details).getByText("¥0.42")).toBeTruthy();
    expect(mounted).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("session-card-details-toggle-s1"));
    expect(details.hidden).toBe(false);
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("session-card-details-toggle-s1"));
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it("keeps background process safety and the existing session menu reachable while details are folded", () => {
    const onSelect = vi.fn();
    render(<SessionCard {...baseCard} session={session()} onSelect={onSelect} density="compact"
      processes={[{ pid: 8, pgid: 8, command: "python experiment.py", elapsedMs: 1000 } as never]} onKillProcess={vi.fn()} />);
    const safety = screen.getByTestId("process-safety-chip");
    expect(safety.closest("[hidden]")).toBeNull();
    fireEvent.click(safety);
    expect(screen.getByTestId("process-safety-sheet")).toBeTruthy();
    fireEvent.click(screen.getByTestId("process-safety-sheet"));
    fireEvent.click(screen.getByTestId("session-actions-trigger-s1"));
    const menu = screen.getByTestId("session-actions-menu-s1");
    expect(menu.querySelector('[data-item-id="archive-session"]')).toBeTruthy();
    expect(menu.querySelector('[data-item-id="exit"]')).toBeTruthy();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps the compact session menu usable on narrow screens", () => {
    vi.mocked(useMobile).mockReturnValue(true);
    render(<SessionCard {...baseCard} session={session()} density="compact" />);
    fireEvent.click(screen.getByTestId("session-actions-trigger-s1"));
    expect(screen.getByTestId("session-actions-menu-s1").querySelector('[data-item-id="exit"]')).toBeTruthy();
  });

  it("surfaces an OpenSpec readiness blocker before its detailed card is expanded", () => {
    render(<SessionCard {...baseCard} session={session()} density="compact"
      openspecReadiness={{ state: "BROKEN", reason: "missing-changes-dir" } as never}
      openspecChanges={[]} onSendPrompt={vi.fn()} onAttachProposal={vi.fn()} onDetachProposal={vi.fn()} onSeekToFolderOpenSpec={vi.fn()} />);
    const warning = screen.getByTestId("session-openspec-attention");
    expect(warning.closest("[hidden]")).toBeNull();
    fireEvent.click(warning);
    expect(screen.getByTestId("session-openspec-disabled").closest("[hidden]")).toBeNull();
    expect(screen.getByTestId("session-openspec-remediate")).toBeTruthy();
  });

  it("selects the compact row from the keyboard but keeps Details independent", () => {
    const onSelect = vi.fn();
    render(<SessionCard {...baseCard} session={session()} onSelect={onSelect} density="compact" />);
    fireEvent.keyDown(screen.getByTestId("session-card-desktop"), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("s1");
    onSelect.mockClear();
    fireEvent.keyDown(screen.getByTestId("session-card-details-toggle-s1"), { key: "Enter" });
    expect(onSelect).not.toHaveBeenCalled();
  });
});
