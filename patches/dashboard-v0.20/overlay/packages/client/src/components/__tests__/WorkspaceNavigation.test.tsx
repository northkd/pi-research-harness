import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitWorkspaceProvider, useSplitWorkspace, type SplitWorkspaceContextValue } from "../split/SplitWorkspaceContext.js";
import { SplitWorkspace } from "../split/SplitWorkspace.js";
import { WorkspaceNavigation, WorkspaceTools } from "../split/WorkspaceNavigation.js";
import { loadEditorPaneState } from "../../lib/layout/editor-pane-state.js";
import { loadSplitState } from "../../lib/layout/split-state.js";

let workspace: SplitWorkspaceContextValue;
function Probe() {
  workspace = useSplitWorkspace();
  return <output data-testid="pane-state">{JSON.stringify(workspace.paneState)}</output>;
}
function Shell({ sessionId = "s1", cwd = "/project", onOpenConversation }: { sessionId?: string; cwd?: string; onOpenConversation?: () => void }) {
  return <SplitWorkspaceProvider sessionId={sessionId} cwd={cwd} orientation="h">
    <WorkspaceNavigation onOpenConversation={onOpenConversation} /><WorkspaceTools /><Probe />
  </SplitWorkspaceProvider>;
}
beforeEach(() => localStorage.clear());
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("task-oriented workspace navigation", () => {
  it("reuses the research tab for both surfaces and retains every opened file", () => {
    render(<Shell />);
    act(() => workspace.openInSplit("METHODS.md"));
    fireEvent.click(screen.getByTestId("workspace-view-workbench"));
    expect(workspace.researchSurface).toBe("workbench");
    expect(workspace.split.mode).toBe("full");
    fireEvent.click(screen.getByTestId("workspace-view-agents"));
    expect(workspace.researchSurface).toBe("agents");
    expect(workspace.paneState.openFiles.map(file => file.path)).toEqual(["METHODS.md", "research:"]);
    fireEvent.click(screen.getByTestId("workspace-view-files"));
    expect(workspace.paneState.openFiles[workspace.paneState.activeIndex].path).toBe("METHODS.md");
    fireEvent.click(screen.getByTestId("workspace-view-chat"));
    expect(workspace.split.mode).toBe("closed");
    expect(workspace.paneState.openFiles).toHaveLength(2);
  });

  it("can browse an empty file pane without closing a research tab", () => {
    render(<Shell />);
    fireEvent.click(screen.getByTestId("workspace-view-workbench"));
    fireEvent.click(screen.getByTestId("workspace-view-files"));
    expect(workspace.paneState.activeIndex).toBe(-1);
    expect(workspace.paneState.openFiles[0].path).toBe("research:");
    expect(workspace.filesRevealSignal).toBe(1);
    expect(screen.getByTestId("workspace-view-files").getAttribute("aria-selected")).toBe("true");
    const restored = loadEditorPaneState("s1");
    expect(restored.activeIndex).toBe(-1);
    expect(restored.openFiles.map(file => file.path)).toEqual(["research:"]);
  });

  it("persists chat mode before a navigation callback can unmount its provider", () => {
    let modeAtNavigation: string | undefined;
    const onOpenConversation = vi.fn(() => { modeAtNavigation = loadSplitState("s1").mode; });
    render(<Shell onOpenConversation={onOpenConversation} />);
    fireEvent.click(screen.getByTestId("workspace-view-files"));
    expect(workspace.split.mode).toBe("full");
    fireEvent.click(screen.getByTestId("workspace-view-chat"));
    expect(onOpenConversation).toHaveBeenCalledTimes(1);
    expect(modeAtNavigation).toBe("closed");
    expect(workspace.split.mode).toBe("closed");
  });

  it("opens Science at folder scope without a Pi session and keeps browser tools honest", () => {
    render(<Shell sessionId="folder:/project" />);
    fireEvent.click(screen.getByTestId("workspace-view-science"));
    expect(workspace.paneState.openFiles[0]).toMatchObject({ viewer: "science", path: "science:workspace" });
    expect(screen.getByRole("button", { name: "Browser" }).hasAttribute("disabled")).toBe(true);
  });

  it("supports keyboard navigation and the original split presets", () => {
    render(<Shell />);
    fireEvent.keyDown(screen.getByTestId("workspace-view-chat"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("workspace-view-workbench"));
    expect(workspace.researchSurface).toBe("workbench");
    fireEvent.click(screen.getByRole("button", { name: "65:35" }));
    expect(workspace.split.mode).toBe("split");
    expect(workspace.split.ratio).toBe(.65);
  });

  it("isolates the chosen research surface by scope and restores it on return", () => {
    const view = render(<Shell />);
    fireEvent.click(screen.getByTestId("workspace-view-agents"));
    view.rerender(<Shell sessionId="s2" cwd="/other" />);
    expect(workspace.researchSurface).toBe("workbench");
    view.rerender(<Shell />);
    expect(workspace.researchSurface).toBe("agents");
  });
});

describe("workspace keep-mounted mode", () => {
  it("preserves both draft trees across chat, full and tablet views", () => {
    const mounts = { chat: 0, editor: 0 };
    function Draft({ name }: { name: "chat" | "editor" }) {
      const [value, setValue] = useState("");
      useEffect(() => { mounts[name]++; }, []);
      return <input aria-label={name} value={value} onChange={event => setValue(event.target.value)} />;
    }
    const props = { ratio: .5, orientation: "h" as const, onRatioChange: vi.fn(), onModeChange: vi.fn(), keepMounted: true,
      chat: <Draft name="chat" />, editor: <Draft name="editor" /> };
    const view = render(<SplitWorkspace {...props} mode="split" />);
    fireEvent.change(screen.getByLabelText("chat"), { target: { value: "unsent question" } });
    fireEvent.change(screen.getByLabelText("editor"), { target: { value: "unsaved draft" } });
    view.rerender(<SplitWorkspace {...props} mode="closed" />);
    expect(screen.getByTestId("split-editor-pane").style.display).toBe("none");
    view.rerender(<SplitWorkspace {...props} mode="full" replaceChat />);
    view.rerender(<SplitWorkspace {...props} mode="split" />);
    expect((screen.getByLabelText("chat") as HTMLInputElement).value).toBe("unsent question");
    expect((screen.getByLabelText("editor") as HTMLInputElement).value).toBe("unsaved draft");
    expect(mounts).toEqual({ chat: 1, editor: 1 });
  });
});
