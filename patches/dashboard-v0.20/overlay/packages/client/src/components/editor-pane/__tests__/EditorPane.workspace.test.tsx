import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({ scienceClosed: vi.fn() }));
vi.mock("../CappedViewer.js", async () => {
  const React = await import("react");
  return { CappedViewer: ({ path }: { path: string }) => {
    const [value, setValue] = React.useState("");
    return <input aria-label={`draft:${path}`} value={value} onChange={event => setValue(event.target.value)} />;
  } };
});
vi.mock("../pseudo-tab-registry.js", async () => {
  const React = await import("react");
  const Research = () => {
    const [draft, setDraft] = React.useState("");
    return <input aria-label="intake-draft" value={draft} onChange={event => setDraft(event.target.value)} />;
  };
  const Science = () => {
    React.useEffect(() => () => lifecycle.scienceClosed(), []);
    return <div>Science viewer</div>;
  };
  return { pseudoTabRegistry: { research: Research, science: Science, terminal: () => null } };
});

import { EditorPane } from "../EditorPane.js";
import { SplitWorkspaceProvider, useSplitWorkspace, type SplitWorkspaceContextValue } from "../../split/SplitWorkspaceContext.js";

let api: SplitWorkspaceContextValue;
function Probe() { api = useSplitWorkspace(); return null; }
function Harness({ sessionId = "s1", cwd = "/project", changeDetection = false, retainAuthoring = true, changedFiles, onWatchFiles }: {
  sessionId?: string; cwd?: string; changeDetection?: boolean; retainAuthoring?: boolean;
  changedFiles?: Map<string, number>; onWatchFiles?: (sessionId: string, cwd: string, paths: string[]) => void;
}) {
  return <SplitWorkspaceProvider sessionId={sessionId} cwd={cwd} orientation="h" changeDetection={changeDetection}
    retainAuthoring={retainAuthoring} changedFiles={changedFiles} onWatchFiles={onWatchFiles}><Probe /><EditorPane workspaceChrome /></SplitWorkspaceProvider>;
}
const disk = new Map<string, string>();
const digests: Array<{ path: string; purpose: string }> = [];
beforeEach(() => {
  localStorage.clear();
  disk.clear();
  digests.length = 0;
  lifecycle.scienceClosed.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    if (url.pathname === "/api/file/digest") {
      const path = url.searchParams.get("path") ?? "";
      digests.push({ path, purpose: url.searchParams.get("purpose") ?? "" });
      return new Response(JSON.stringify({ success: true, data: { sha1: disk.get(path) ?? "initial", size: 1, mtime: 1 } }));
    }
    return new Response(JSON.stringify({ success: true, data: { entries: [] } }));
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("workspace authoring state", () => {
  it("preserves document and intake drafts when switching between files and research", () => {
    render(<Harness />);
    act(() => api.openInSplit("METHODS.md"));
    fireEvent.change(screen.getByLabelText("draft:METHODS.md"), { target: { value: "unsaved methods" } });
    act(() => api.openResearch());
    fireEvent.change(screen.getByLabelText("intake-draft"), { target: { value: "unsubmitted source selection" } });
    act(() => api.openFiles?.());
    expect((screen.getByLabelText("draft:METHODS.md") as HTMLInputElement).value).toBe("unsaved methods");
    act(() => api.openResearch("agents"));
    expect((screen.getByLabelText("intake-draft") as HTMLInputElement).value).toBe("unsubmitted source selection");
  });

  it("drops retained state only for an explicitly closed tab or another scope", () => {
    const view = render(<Harness />);
    act(() => api.openInSplit("METHODS.md"));
    fireEvent.change(screen.getByLabelText("draft:METHODS.md"), { target: { value: "private draft A" } });
    act(() => api.openResearch());
    act(() => api.dispatch({ type: "closeByPath", path: "METHODS.md" }));
    expect(screen.queryByLabelText("draft:METHODS.md")).toBeNull();
    view.rerender(<Harness sessionId="s2" cwd="/other" />);
    expect(screen.queryByLabelText("intake-draft")).toBeNull();
    act(() => api.openInSplit("METHODS.md"));
    expect((screen.getByLabelText("draft:METHODS.md") as HTMLInputElement).value).toBe("");
  });

  it("releases Science subscriptions when the pane is hidden and preserves its tab", () => {
    render(<Harness />);
    act(() => api.openScience());
    expect(screen.getByText("Science viewer")).toBeTruthy();
    act(() => api.setMode("closed"));
    expect(screen.queryByText("Science viewer")).toBeNull();
    expect(lifecycle.scienceClosed).toHaveBeenCalledTimes(1);
    expect(api.paneState.openFiles[0].path).toBe("science:workspace");
  });

  it("keeps a dirty buffer while returning through the real baseline verification path", async () => {
    render(<Harness changeDetection />);
    act(() => api.openInSplit("A.md"));
    await waitFor(() => expect(screen.getByLabelText("draft:A.md")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("draft:A.md"), { target: { value: "A is still unsaved" } });
    act(() => api.openInSplit("B.md"));
    await waitFor(() => expect(screen.getByLabelText("draft:B.md")).toBeTruthy());
    act(() => api.openInSplit("A.md"));
    expect((screen.getByLabelText("draft:A.md") as HTMLInputElement).value).toBe("A is still unsaved");
    await act(async () => {});
    expect((screen.getByLabelText("draft:A.md") as HTMLInputElement).value).toBe("A is still unsaved");
  });

  it("does not intercept file-search shortcuts while retained behind the chat", () => {
    render(<Harness />);
    act(() => api.openInSplit("A.md"));
    act(() => api.setMode("closed"));
    const event = new KeyboardEvent("keydown", { key: "p", ctrlKey: true, bubbles: true, cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });

  it("keeps the original disk baseline and conflict banner when returning to a retained draft", async () => {
    const view = render(<Harness changeDetection />);
    act(() => api.openInSplit("A.md"));
    const draft = await screen.findByLabelText("draft:A.md");
    fireEvent.change(draft, { target: { value: "unsaved A" } });
    act(() => api.openInSplit("B.md"));
    await screen.findByLabelText("draft:B.md");
    disk.set("A.md", "changed externally");
    view.rerender(<Harness changeDetection changedFiles={new Map([["A.md", 1]])} />);
    await waitFor(() => expect(api.changedFiles?.has("A.md")).toBe(true));

    act(() => api.openInSplit("A.md"));
    await act(async () => {});
    expect(screen.getByLabelText("draft:A.md")).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("unsaved A");
    expect(screen.getByTestId("changed-on-disk-banner")).toBeTruthy();
    expect(digests.filter(call => call.path === "A.md" && call.purpose === "baseline")).toHaveLength(1);

    // Only the operator's explicit reload adopts the current disk baseline.
    fireEvent.click(screen.getByTestId("changed-refresh"));
    await waitFor(() => expect((screen.getByLabelText("draft:A.md") as HTMLInputElement).value).toBe(""));
    expect(digests.filter(call => call.path === "A.md" && call.purpose === "baseline")).toHaveLength(2);
    expect(screen.queryByTestId("changed-on-disk-banner")).toBeNull();
  });

  it("watches retained real files while Chat is active and reports external edits on return", async () => {
    const onWatchFiles = vi.fn();
    const view = render(<Harness changeDetection onWatchFiles={onWatchFiles} />);
    act(() => api.openInSplit("A.md"));
    await screen.findByLabelText("draft:A.md");
    act(() => api.openResearch());
    act(() => api.setMode("closed"));
    // Research live watches release on hide; the authoring file keeps its watch.
    expect(onWatchFiles).toHaveBeenLastCalledWith("s1", "/project", ["A.md"]);
    disk.set("A.md", "changed while chatting");
    view.rerender(<Harness changeDetection onWatchFiles={onWatchFiles} changedFiles={new Map([["A.md", 1]])} />);
    await waitFor(() => expect(api.changedFiles?.has("A.md")).toBe(true));
    act(() => api.openFiles?.());
    expect(screen.getByTestId("changed-on-disk-banner")).toBeTruthy();
    expect(digests.filter(call => call.path === "A.md" && call.purpose === "baseline")).toHaveLength(1);
    view.unmount();
    expect(onWatchFiles).toHaveBeenLastCalledWith("s1", "/project", []);
  });

  it("keeps the legacy provider watch release when authoring retention is not requested", () => {
    const onWatchFiles = vi.fn();
    render(<Harness retainAuthoring={false} onWatchFiles={onWatchFiles} />);
    act(() => api.openInSplit("A.md"));
    expect(onWatchFiles).toHaveBeenLastCalledWith("s1", "/project", ["A.md"]);
    act(() => api.setMode("closed"));
    expect(onWatchFiles).toHaveBeenLastCalledWith("s1", "/project", []);
  });

  it("refreshes only the selected document without remounting another retained draft", () => {
    render(<Harness />);
    act(() => api.openInSplit("A.md"));
    const draft = screen.getByLabelText("draft:A.md");
    fireEvent.change(draft, { target: { value: "retain A through B refresh" } });
    act(() => api.openInSplit("B.md"));
    fireEvent.change(screen.getByLabelText("draft:B.md"), { target: { value: "reload B" } });
    fireEvent.click(screen.getByTitle("Reload file"));
    expect((screen.getByLabelText("draft:B.md") as HTMLInputElement).value).toBe("");
    act(() => api.openInSplit("A.md"));
    expect(screen.getByLabelText("draft:A.md")).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("retain A through B refresh");
  });

  it("keeps an authoring draft while source-line navigation changes in another file", () => {
    render(<Harness />);
    act(() => api.openInSplit("A.md", 12));
    const draft = screen.getByLabelText("draft:A.md");
    fireEvent.change(draft, { target: { value: "draft survives line deep links" } });
    act(() => api.openInSplit("B.ts", 80));
    act(() => api.openInSplit("A.md"));
    expect(screen.getByLabelText("draft:A.md")).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("draft survives line deep links");
  });

  it("does not close a hidden draft with Ctrl-W and restores the shortcut when Files returns", async () => {
    render(<Harness />);
    act(() => api.openInSplit("A.md"));
    const draft = screen.getByLabelText("draft:A.md");
    fireEvent.change(draft, { target: { value: "keep hidden draft" } });
    act(() => api.setMode("closed"));
    const hiddenEvent = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true });
    act(() => window.dispatchEvent(hiddenEvent));
    expect(hiddenEvent.defaultPrevented).toBe(false);
    expect(api.paneState.openFiles.some(file => file.path === "A.md")).toBe(true);
    expect((draft as HTMLInputElement).value).toBe("keep hidden draft");
    act(() => api.openFiles?.());
    const visibleEvent = new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true, cancelable: true });
    await act(async () => { window.dispatchEvent(visibleEvent); });
    expect(visibleEvent.defaultPrevented).toBe(true);
    expect(api.paneState.openFiles).toHaveLength(0);
  });
});
