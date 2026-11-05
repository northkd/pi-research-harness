import type { TerminalSession } from "@blackbelt-technology/pi-dashboard-shared/terminal-types.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  connected: vi.fn(),
  disconnected: vi.fn(),
  visibility: vi.fn(),
}));

// Keep the real provider and terminal-tab layer; replace only xterm/its socket
// boundary so this test observes when the workspace would reconnect the PTY.
vi.mock("../../terminal/TerminalView.js", async () => {
  const React = await import("react");
  return {
    TerminalView: ({ terminalId, visible, onClose }: {
      terminalId: string;
      visible: boolean;
      onClose?: (id: string) => void;
    }) => {
      React.useEffect(() => {
        lifecycle.connected(terminalId);
        return () => lifecycle.disconnected(terminalId);
      }, [terminalId]);
      React.useEffect(() => {
        lifecycle.visibility(visible);
      }, [visible]);
      return (
        <section data-testid={`terminal:${terminalId}`} hidden={!visible} data-active={String(visible)}>
          <button type="button" onClick={() => onClose?.(terminalId)}>Close terminal</button>
        </section>
      );
    },
  };
});

import {
  SplitWorkspaceProvider,
  type SplitWorkspaceContextValue,
  useSplitWorkspace,
} from "../../split/SplitWorkspaceContext.js";
import { TerminalPaneLayer } from "../TerminalPaneLayer.js";

let workspace: SplitWorkspaceContextValue;
function Probe() {
  workspace = useSplitWorkspace();
  return null;
}

const terminals: TerminalSession[] = [{
  id: "workspace-terminal",
  cwd: "/workspace/project",
  shell: "/bin/bash",
  title: "Project shell",
  status: "active",
  createdAt: 1,
}];

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe("terminal lifetime across workspace navigation", () => {
  it("keeps one terminal mounted while the pane and file tabs change, then disposes on explicit close", () => {
    const onKillTerminal = vi.fn();
    render(
      <SplitWorkspaceProvider
        sessionId="terminal-workspace"
        cwd="/workspace/project"
        orientation="h"
        terminals={terminals}
        onKillTerminal={onKillTerminal}
      >
        <Probe />
        <TerminalPaneLayer />
      </SplitWorkspaceProvider>,
    );
    expect(screen.queryByTestId("terminal:workspace-terminal")).toBeNull();

    act(() => workspace.terminal.openTerminal("workspace-terminal"));
    const terminal = screen.getByTestId("terminal:workspace-terminal");
    const expectActive = (active: boolean) => {
      expect(screen.getByTestId("terminal:workspace-terminal")).toBe(terminal);
      expect(terminal.hidden).toBe(!active);
      expect(terminal.getAttribute("data-active")).toBe(String(active));
      expect(lifecycle.connected).toHaveBeenCalledTimes(1);
      expect(lifecycle.disconnected).not.toHaveBeenCalled();
      expect(onKillTerminal).not.toHaveBeenCalled();
    };
    expectActive(true);

    act(() => workspace.setMode("closed"));
    expectActive(false);
    expect(workspace.paneState.openFiles.some(file => file.path === "term:workspace-terminal")).toBe(true);

    act(() => workspace.setMode("split"));
    expectActive(true);

    act(() => workspace.openInSplit("METHODS.md"));
    expectActive(false);

    act(() => workspace.terminal.openTerminal("workspace-terminal"));
    expectActive(true);
    expect(lifecycle.visibility.mock.calls.map(([visible]) => visible)).toEqual([true, false, true, false, true]);

    fireEvent.click(screen.getByRole("button", { name: "Close terminal" }));
    expect(screen.queryByTestId("terminal:workspace-terminal")).toBeNull();
    expect(lifecycle.connected).toHaveBeenCalledTimes(1);
    expect(lifecycle.disconnected).toHaveBeenCalledExactlyOnceWith("workspace-terminal");
    expect(onKillTerminal).toHaveBeenCalledExactlyOnceWith("workspace-terminal");
    expect(workspace.paneState.openFiles.some(file => file.path === "term:workspace-terminal")).toBe(false);
    expect(workspace.paneState.openFiles.some(file => file.path === "METHODS.md")).toBe(true);
  });
});
