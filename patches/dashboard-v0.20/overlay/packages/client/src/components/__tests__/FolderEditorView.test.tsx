/**
 * FolderEditorView — the folder-scoped internal Monaco pane that replaces the
 * removed external code-server EditorView.
 *
 * See change: remove-external-editor-integration.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router, useLocation } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("../../lib/api/api-context.js", () => ({ getApiBase: () => "" }));
vi.mock("../../hooks/useMobile.js", () => ({ useMobile: () => false }));

import { folderPaneId } from "../../lib/layout/folder-pane-id.js";
import { loadSplitState, saveSplitState } from "../../lib/layout/split-state.js";
import { buildFolderEditorUrl, buildFolderHomeUrl } from "../../lib/nav/route-builders.js";
import { TREE_VISIBLE_KEY_PREFIX } from "../../lib/util/tree-visible.js";
import { FolderEditorView } from "../folder/FolderEditorView.js";
import { DirectoryHomeView } from "../folder/DirectoryHomeView.js";
import { FolderSplitProvider } from "../folder/FolderSplitProvider.js";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
  globalThis.fetch = vi.fn(() =>
    Promise.resolve({ json: () => Promise.resolve({ success: true, data: { entries: [] } }) }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("FolderEditorView", () => {
  it("mounts the internal editor pane rooted at the folder cwd", () => {
    render(<FolderEditorView cwd="/proj" />);
    // The EditorPane's discoverable rail toggle proves the internal pane mounted.
    expect(screen.getByTestId("tree-toggle")).toBeTruthy();
    // No external code-server iframe.
    expect(document.querySelector("iframe")).toBeNull();
  });

  it("persists pane state under the namespaced folder key (not a session id)", () => {
    render(<FolderEditorView cwd="/proj" />);
    const toggle = screen.getByTestId("tree-toggle");
    fireEvent.click(toggle);
    // Tree-visible persists under `${prefix}folder:/proj`, disjoint from any UUID.
    expect(localStorage.getItem(`${TREE_VISIBLE_KEY_PREFIX}${folderPaneId("/proj")}`)).toBe("true");
  });

  it("shows no changed-on-disk banner in folder scope (Non-Goal v1)", () => {
    render(<FolderEditorView cwd="/proj" />);
    expect(screen.queryByTestId("changed-on-disk-banner")).toBeNull();
  });

  it("returns from the direct editor route to a visible conversation and persists that layout", async () => {
    const cwd = "/proj";
    const home = buildFolderHomeUrl(cwd);
    const editor = buildFolderEditorUrl(cwd);
    const location = memoryLocation({ path: editor, record: true });
    const onSpawnSession = vi.fn();
    function Routes() {
      const [route] = useLocation();
      return route === editor ? <FolderEditorView cwd={cwd} /> : (
        <FolderSplitProvider cwd={cwd}>
          <DirectoryHomeView cwd={cwd} onSpawnSession={onSpawnSession} />
        </FolderSplitProvider>
      );
    }
    const view = render(<Router hook={location.hook}><Routes /></Router>);
    expect(loadSplitState(folderPaneId(cwd)).mode).toBe("full");
    fireEvent.click(screen.getByTestId("workspace-view-chat"));
    await waitFor(() => expect(location.history.at(-1)).toBe(home));
    expect(loadSplitState(folderPaneId(cwd)).mode).toBe("closed");
    expect(screen.getByTestId("workspace-view-chat").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("split-chat-pane").classList.contains("hidden")).toBe(false);
    expect(screen.getByTestId("composer-card")).toBeTruthy();
    expect(onSpawnSession).not.toHaveBeenCalled();

    // A fresh home mount uses the persisted conversation layout; the editor's
    // one-shot reveal is still honored on a later explicit editor route.
    view.unmount();
    const revisit = memoryLocation({ path: home, record: true });
    render(<Router hook={revisit.hook}><Routes /></Router>);
    expect(screen.getByTestId("split-chat-pane").classList.contains("hidden")).toBe(false);
    act(() => revisit.navigate(editor));
    await waitFor(() => expect(loadSplitState(folderPaneId(cwd)).mode).toBe("full"));
    expect(screen.getByTestId("tree-toggle")).toBeTruthy();
  });

  it("keeps a stored chat layout from dismissing a new explicit editor route, and persists toolbar close", async () => {
    const cwd = "/proj";
    const home = buildFolderHomeUrl(cwd);
    const editor = buildFolderEditorUrl(cwd);
    saveSplitState(folderPaneId(cwd), { mode: "closed", ratio: .65, orientation: "h" });
    const location = memoryLocation({ path: editor, record: true });
    function Routes() {
      const [route] = useLocation();
      return route === editor ? <FolderEditorView cwd={cwd} /> : <div data-testid="folder-home-route" />;
    }
    render(<Router hook={location.hook}><Routes /></Router>);
    expect(location.history.at(-1)).toBe(editor);
    expect(loadSplitState(folderPaneId(cwd))).toMatchObject({ mode: "full", ratio: .65 });
    fireEvent.click(screen.getByTitle("Close editor"));
    await waitFor(() => expect(screen.getByTestId("folder-home-route")).toBeTruthy());
    expect(location.history.at(-1)).toBe(home);
    expect(loadSplitState(folderPaneId(cwd))).toMatchObject({ mode: "closed", ratio: .65 });
  });
});
