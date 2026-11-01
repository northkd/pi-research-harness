/**
 * Header redesign (change: redesign-split-layout-controls).
 *
 * F4 (test-plan): the desktop SessionHeader renders the layout-mode switch
 * after name+rename and immediately before the Seek button, drops the `model`
 * and `thinkingLevel` segments (both already live on the session card), and
 * KEEPS the `pi <version>` segment (the only per-session pi surface).
 */

import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { cleanup, render, screen } from "@testing-library/react";
import type React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createInitialState } from "../../lib/chat/event-reducer.js";

afterEach(() => {
  cleanup();
  vi.resetModules();
  vi.doUnmock("../../hooks/useMobile.js");
});
beforeEach(() => localStorage.clear());

function makeSession(overrides?: Partial<DashboardSession>): DashboardSession {
  return {
    id: "s1",
    status: "idle",
    cwd: "/tmp",
    startedAt: Date.now() - 60_000,
    model: "claude-opus-4",
    thinkingLevel: "high",
    piVersion: "0.9.9",
    ...overrides,
  } as DashboardSession;
}

async function loadDesktopHeader() {
  vi.doMock("../../hooks/useMobile.js", () => ({ useMobile: () => false }));
  const mod = await import("../session/SessionHeader.js");
  return mod.SessionHeader;
}

async function renderInProvider(node: React.ReactElement) {
  // vi.resetModules creates a fresh context; use the provider from that same graph.
  const { SplitWorkspaceProvider } = await import("../split/SplitWorkspaceContext.js");
  return render(
    <SplitWorkspaceProvider sessionId="s1" cwd="/tmp" orientation="h">
      {node}
    </SplitWorkspaceProvider>,
  );
}

const FOLLOWS = Node.DOCUMENT_POSITION_FOLLOWING;

describe("SessionHeader layout redesign (F4)", () => {
  it("orders back → name → mode-switch → Seek, before the flex spacer", async () => {
    const SessionHeader = await loadDesktopHeader();
    await renderInProvider(
      <SessionHeader session={makeSession()} state={createInitialState()} onRename={() => {}} showBack onBack={() => {}} onSeekToCard={() => {}} />,
    );
    const back = screen.getByTestId("back-button");
    const sw = screen.getByTestId("layout-mode-switch");
    const seek = screen.getByTestId("session-header-seek-card");
    // back precedes the switch; the switch precedes Seek.
    expect(back.compareDocumentPosition(sw) & FOLLOWS).toBeTruthy();
    expect(sw.compareDocumentPosition(seek) & FOLLOWS).toBeTruthy();
  });

  it("does not expose a session-level research entry, even for an old caller", async () => {
    const SessionHeader = await loadDesktopHeader();
    const legacy = { onOpenResearch: vi.fn() };
    await renderInProvider(
      <SessionHeader session={makeSession()} state={createInitialState()} onRename={() => {}} {...legacy} />,
    );
    expect(screen.queryByTestId("session-header-research")).toBeNull();
    expect(screen.getByTestId("layout-mode-switch")).toBeTruthy();
    expect(legacy.onOpenResearch).not.toHaveBeenCalled();
  });

  it("keeps mobile layout controls without a session-level research entry", async () => {
    vi.doMock("../../hooks/useMobile.js", () => ({ useMobile: () => true }));
    const { SessionHeader } = await import("../session/SessionHeader.js");
    const { SplitWorkspaceProvider: MobileProvider } = await import("../split/SplitWorkspaceContext.js");
    render(
      <MobileProvider sessionId="s1" cwd="/tmp" orientation="v">
        <SessionHeader session={makeSession({ name: "Current session" })} state={createInitialState()} showBack onBack={() => {}} mobileActions={{}} />
      </MobileProvider>,
    );
    expect(screen.queryByTestId("session-header-research")).toBeNull();
    expect(screen.queryByTestId("mobile-session-actions")).toBeNull();
    expect(screen.getByTestId("layout-mode-switch")).toBeTruthy();
  });

  it("wraps controls instead of shrinking them into vertical text at narrow desktop widths", async () => {
    const SessionHeader = await loadDesktopHeader();
    await renderInProvider(
      <SessionHeader
        session={makeSession({ name: "Narrow session name", status: "ended", sessionFile: "/tmp/s.jsonl" })}
        state={createInitialState()}
        onRename={() => {}}
        onResume={() => {}}
        onSeekToCard={() => {}}
        onOpenDiffView={() => {}}
        hasFileChanges
      />,
    );
    // The toolbar may wrap as a whole; labels themselves must never break per-character.
    expect(screen.getByTestId("session-header").className).toContain("flex-wrap");
    expect(screen.getByTestId("layout-mode-switch").className).toContain("shrink-0");
    for (const id of ["session-header-seek-card", "changed-files-chip", "header-resume-button", "header-fork-button"]) {
      const control = screen.getByTestId(id);
      expect(control.className).toContain("whitespace-nowrap");
      expect(control.className).toContain("shrink-0");
    }
    // A title clipped by the narrow toolbar remains discoverable in full.
    expect(screen.getByText("Narrow session name").closest("[title]")?.getAttribute("title")).toBe("Narrow session name");
  });

  it("drops model + thinkingLevel, keeps the pi version segment", async () => {
    const SessionHeader = await loadDesktopHeader();
    await renderInProvider(
      <SessionHeader session={makeSession()} state={createInitialState()} onRename={() => {}} onSeekToCard={() => {}} />,
    );
    expect(screen.queryByText("claude-opus-4")).toBeNull();
    expect(screen.queryByText("high")).toBeNull();
    expect(screen.getByText(/pi 0\.9\.9/)).toBeTruthy();
  });
});
