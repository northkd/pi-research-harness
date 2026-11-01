import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { deriveSelectedSessionId, deriveSettingsSessionId } from "../lib/session/selectedSessionId.js";

// @structural-pin Both SettingsPanel mounts must use the captured launching session, not the settings URL's empty selection.
it("binds both settings surfaces to the captured session and cwd", () => {
  const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "../App.tsx"), "utf8");
  expect(app.split("selectedCwd={settingsSession?.cwd} selectedSessionId={settingsSession?.id}")).toHaveLength(3);
});

describe("deriveSettingsSessionId", () => {
  it.each(["/session/S1", "/session/S1/editor", "/session/S1/diff"])("uses the captured real session route %s", path => {
    expect(deriveSettingsSessionId({ path, source: "captured" })).toBe("S1");
  });

  it("does not authorize a synthesized cold-load background", () => {
    expect(deriveSettingsSessionId({ path: "/session/S1", source: "synthesized" })).toBeUndefined();
  });

  it.each(["/", "/settings/sessions", "/folder/encoded/research", "/session/", "/session/S1/not-a-session-view"])("does not invent a session from %s", path => {
    expect(deriveSettingsSessionId({ path, source: "captured" })).toBeUndefined();
  });
});

// Regression coverage for fix-changed-files-desktop-route.
//
// Before the fix, `selectedId` was `match ? params?.id : undefined` — so on
// `/session/:id/diff` (which the exact `/session/:id` wouter route does NOT
// match) `selectedId` collapsed to undefined, `sessionDetail` became null, and
// the desktop content area fell through to `<LandingPage>` instead of
// `<FileDiffView>`. The diff sub-route now contributes to `selectedId`.
describe("deriveSelectedSessionId", () => {
  it("returns the chat-route id when /session/:id matches", () => {
    expect(deriveSelectedSessionId(true, { id: "S1" }, false, null)).toBe("S1");
  });

  it("returns the diff-route id when only /session/:id/diff matches (regression)", () => {
    expect(deriveSelectedSessionId(false, null, true, { id: "S1" })).toBe("S1");
  });

  it("prefers the chat-route id when both matches are somehow present", () => {
    expect(
      deriveSelectedSessionId(true, { id: "chat" }, true, { id: "diff" }),
    ).toBe("chat");
  });

  it("returns undefined when neither route matches", () => {
    expect(deriveSelectedSessionId(false, null, false, null)).toBeUndefined();
  });

  it("returns undefined when matching route has no id param", () => {
    expect(deriveSelectedSessionId(true, {}, false, null)).toBeUndefined();
    expect(deriveSelectedSessionId(false, null, true, {})).toBeUndefined();
  });
});
