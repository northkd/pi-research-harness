import { __resetSlotClaimsVersionForTests, createSlotRegistry, PluginContextProvider } from "@blackbelt-technology/dashboard-plugin-runtime";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SplitWorkspaceProvider, useSplitWorkspace, type SplitWorkspaceContextValue } from "../../split/SplitWorkspaceContext.js";
import { EditorPane } from "../EditorPane.js";
import { FileHandlerLayer } from "../file-handler/FileHandlerLayer.js";
import { createFileHandlerStore } from "../file-handler/file-handler-store.js";
import { FileHandlerStoreProvider } from "../file-handler/use-file-handler-store.js";

vi.mock("../CappedViewer.js", () => ({ CappedViewer: () => <div data-testid="built-in-viewer" /> }));

let api: SplitWorkspaceContextValue;
let mounts = 0;
let unmounts = 0;
function Probe() { api = useSplitWorkspace(); return null; }
function Handler({ isActive, setDirty }: { isActive: boolean; setDirty: (dirty: boolean) => void }) {
  const [draft, setDraft] = useState("");
  useEffect(() => {
    mounts++;
    setDirty(true);
    return () => { unmounts++; };
  }, []);
  return <input aria-label="plugin-draft" data-active={String(isActive)} value={draft} onChange={event => setDraft(event.target.value)} />;
}

beforeEach(() => {
  localStorage.clear();
  __resetSlotClaimsVersionForTests();
  mounts = 0;
  unmounts = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ success: true, data: { entries: [], sha1: "initial", size: 1, mtime: 1 } }))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("retained workspace file-handler lifecycle", () => {
  it("deactivates a hidden plugin while keeping its unsaved instance and draft", async () => {
    const registry = createSlotRegistry();
    registry.addClaim({
      pluginId: "workspace-edit", priority: 1000, slot: "editor-pane-file-handler", Component: Handler,
      fileHandler: { id: "document", extensions: [".docx"], mode: "edit", label: "Edit document", keepAlive: { max: 3 }, copySuffix: "copy" },
    } as never);
    const store = createFileHandlerStore();
    render(
      <PluginContextProvider registry={registry}>
        <FileHandlerStoreProvider value={store}>
          <SplitWorkspaceProvider sessionId="s1" cwd="/project" orientation="h" changeDetection retainAuthoring>
            <Probe /><EditorPane workspaceChrome /><FileHandlerLayer />
          </SplitWorkspaceProvider>
        </FileHandlerStoreProvider>
      </PluginContextProvider>,
    );
    act(() => api.openInSplit("report.docx"));
    act(() => api.dispatch({ type: "setHandlerMode", path: "report.docx", mode: "workspace-edit/document" }));
    const draft = await screen.findByLabelText("plugin-draft");
    await waitFor(() => expect(draft.getAttribute("data-active")).toBe("true"));
    fireEvent.change(draft, { target: { value: "unsaved plugin content" } });
    expect(mounts).toBe(1);

    act(() => api.setMode("closed"));
    expect(draft.getAttribute("data-active")).toBe("false");
    expect(screen.getByTestId("file-handler-instance").getAttribute("data-visible")).toBe("0");
    expect(store.getState().visibleKey).toBeNull();
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);

    act(() => api.openFiles?.());
    await waitFor(() => expect(draft.getAttribute("data-active")).toBe("true"));
    expect(screen.getByLabelText("plugin-draft")).toBe(draft);
    expect((draft as HTMLInputElement).value).toBe("unsaved plugin content");
    expect(mounts).toBe(1);
    expect(unmounts).toBe(0);
  });
});
