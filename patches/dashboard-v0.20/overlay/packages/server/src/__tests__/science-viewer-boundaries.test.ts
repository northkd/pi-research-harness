import { describe, expect, it } from "vitest";
import { routeTier, hasRouteTier } from "@blackbelt-technology/pi-dashboard-shared/route-tiers.js";
import { wsMessageTier } from "@blackbelt-technology/pi-dashboard-shared/ws-message-tiers.js";
import { isDenylisted } from "../../../mcp-server-plugin/src/server/tools.denylist.js";
import { classifyWsRoad } from "../identity/ws-road-classification.js";
import { classifyBrowserMessage } from "../identity/ws-message-scope.js";

describe("Science viewer's generic API boundaries", () => {
  it("classifies every viewer road without exposing it through MCP", () => {
    const path = "/api/res-workflow/science/view";
    expect(hasRouteTier("POST", path)).toBe(true); expect(routeTier("POST", path)).toBe("observe"); expect(isDenylisted(path)).toBe(true);
    for (const [type, tier, action] of [["science_view_subscribe", "observe", "workspace.read"], ["science_view_unsubscribe", "observe", "workspace.read"], ["science_view_input", "operate", "workspace.write"]]) {
      expect(wsMessageTier(type)).toBe(tier);
      expect(classifyBrowserMessage(type)).toBe("non-session");
      expect(classifyWsRoad({ type, cwd: "/fixture" })).toEqual({ action, resource: { kind: "workspace", ws: type, cwd: "/fixture" } });
      expect(isDenylisted(type)).toBe(true);
    }
    expect(wsMessageTier("science_view_navigate")).toBe("operate");
  });
});
