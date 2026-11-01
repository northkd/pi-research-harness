import { scienceArtifactTabPath } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import { beforeEach, describe, expect, it } from "vitest";
import { EDITOR_PANE_KEY_PREFIX, EMPTY_PANE_STATE, editorPaneReducer, loadEditorPaneState } from "../layout/editor-pane-state.js";

beforeEach(() => localStorage.clear());

describe("Science pseudo-tab state", () => {
  it("reuses only exact registry-scoped artifact targets without a real file path", () => {
    const path = scienceArtifactTabPath("si-00000000-0000-4000-8000-000000000001", "sa-00000000-0000-4000-8000-000000000002");
    const opened = editorPaneReducer(EMPTY_PANE_STATE, { type: "openFile", path, viewer: "science" });
    expect(editorPaneReducer(opened, { type: "openFile", path, viewer: "science" }).openFiles).toHaveLength(1);
    for (const invalid of [`${path}?url=http://private`, `${path}:extra`, path.replace("sa-", "../../"), "science:artifact:task-1:artifact-1"]) expect(editorPaneReducer(EMPTY_PANE_STATE, { type: "openFile", path: invalid, viewer: "science" })).toBe(EMPTY_PANE_STATE);
  });
  it("reuses a strictly parsed Science target without opening another tab", () => {
    const opened = editorPaneReducer(EMPTY_PANE_STATE, { type: "openFile", path: "science:task:task-1", viewer: "science" });
    const again = editorPaneReducer(opened, { type: "openFile", path: "science:task:task-1", viewer: "science" });
    expect(again.openFiles).toHaveLength(1);
    expect(again.openFiles[0]?.viewer).toBe("science");
  });

  it("rejects arbitrary navigation and malformed Science virtual paths before storing a tab", () => {
    for (const path of ["science:", "science:task:", "science:workspace?nonce=secret", "science:task:../x", "science:task:%2e%2e", "science:task:a/b", "science:task:a:b"]) {
      expect(editorPaneReducer(EMPTY_PANE_STATE, { type: "openFile", path, viewer: "science" })).toBe(EMPTY_PANE_STATE);
    }
  });

  it("drops a corrupt saved Science target while preserving the neighboring file tab", () => {
    localStorage.setItem(`${EDITOR_PANE_KEY_PREFIX}folder:/isolated`, JSON.stringify({
      openFiles: [{ path: "science:task:../x", viewer: "science", addedAt: 1 }, { path: "notes.md", viewer: "markdown", addedAt: 2 }], activeIndex: 1, treeOpenRoots: [],
    }));
    const state = loadEditorPaneState("folder:/isolated");
    expect(state.openFiles.map(file => file.path)).toEqual(["notes.md"]);
    expect(state.activeIndex).toBe(0);
  });
});
