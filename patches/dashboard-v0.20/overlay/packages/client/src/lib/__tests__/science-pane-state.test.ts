import { beforeEach, describe, expect, it } from "vitest";
import { EDITOR_PANE_KEY_PREFIX, loadEditorPaneState } from "../layout/editor-pane-state.js";

beforeEach(() => localStorage.clear());

describe("saved Science tabs", () => {
  it.each([1, 2])("drops retired tabs and keeps the neighboring file selected (%s)", activeIndex => {
    localStorage.setItem(`${EDITOR_PANE_KEY_PREFIX}folder:/isolated`, JSON.stringify({
      openFiles: [
        { path: "science:workspace", viewer: "science", addedAt: 1 },
        { path: "science:task:task-1", viewer: "science", addedAt: 2 },
        { path: "notes.md", viewer: "markdown", addedAt: 3 },
      ],
      activeIndex,
      treeOpenRoots: [],
    }));
    const state = loadEditorPaneState("folder:/isolated");
    expect(state.openFiles.map(file => file.path)).toEqual(["notes.md"]);
    expect(state.activeIndex).toBe(0);
  });
});
