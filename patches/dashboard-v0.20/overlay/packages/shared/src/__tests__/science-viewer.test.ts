import { describe, expect, it } from "vitest";
import { fileKind } from "../file-kind.js";
import { isScienceViewInput, isScienceViewTarget, parseScienceTabPath, scienceTabPath } from "../science-viewer.js";
import { paneTabPrefixOf } from "../dashboard-plugin/editor-pane-tab.js";

describe("Science's finite viewer contract", () => {
  it("round-trips only workspace and bounded opaque task paths", () => {
    for (const target of [{ kind: "workspace" }, { kind: "task", taskId: "task_42-finished" }] as const) {
      expect(parseScienceTabPath(scienceTabPath(target))).toEqual(target);
      expect(paneTabPrefixOf(scienceTabPath(target))).toBeNull();
      expect(isScienceViewTarget(target)).toBe(true);
    }
    for (const value of ["science:workspace?nonce=private", "science:workspace/", "science:task:", "science:task:../other", "science:task:%2fetc", "science:task:a:b", "science:task:𓀀", "science:task:" + "a".repeat(129), "/science:workspace"]) {
      expect(parseScienceTabPath(value), value).toBeNull();
    }
    expect(isScienceViewTarget({ kind: "workspace", url: "http://private/" })).toBe(false);
    expect(isScienceViewTarget({ kind: "task", taskId: "task", ownerKey: "owner" })).toBe(false);
    expect(() => scienceTabPath({ kind: "task", taskId: "../other" })).toThrow();
    for (const value of [null, undefined, 42, {}]) expect(parseScienceTabPath(value)).toBeNull();
  });

  it("accepts only bounded basic viewer input, without navigation or CDP", () => {
    for (const input of [{ kind: "mouse", x: 0, y: 1, action: "click", button: "left", clickCount: 1 }, { kind: "scroll", x: 0.5, y: 0.5, deltaX: 0, deltaY: 20 }, { kind: "key", keyType: "char", text: "hello" }, { kind: "resize", width: 960, height: 600 }, { kind: "bringToFront" }]) expect(isScienceViewInput(input)).toBe(true);
    for (const input of [{ kind: "mouse", x: -0.1, y: 1 }, { kind: "mouse", x: NaN, y: 1 }, { kind: "scroll", x: 0, y: 0, deltaY: Infinity }, { kind: "key", text: "a".repeat(4097) }, { kind: "resize", width: 999999, height: 600 }, { kind: "bringToFront", method: "Runtime.evaluate" }, { kind: "navigate", url: "http://private" }]) expect(isScienceViewInput(input)).toBe(false);
  });

  it("never makes a pseudo-view path readable as a file", () => {
    expect(() => fileKind("science:workspace")).toThrow();
    expect(() => fileKind("science:task:a")).toThrow();
    expect(fileKind("/project/science:workspace").viewer).toBe("monaco");
  });
});
