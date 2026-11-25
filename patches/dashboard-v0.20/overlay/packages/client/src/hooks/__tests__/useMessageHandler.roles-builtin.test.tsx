/**
 * Regression for change: fix-builtin-role-names-relay.
 *
 * The `roles_list` handler MUST carry `builtinRoleNames` into the roles
 * plugin config. BuiltInRolesSettings reads `cfg.builtinRoleNames` to render
 * the Built-in/Custom split and the "＋ Add custom role" control; dropping it
 * here collapses the panel to the flat back-compat layout.
 */

import { getPluginConfig } from "@blackbelt-technology/dashboard-plugin-runtime/context";
import type { ServerToBrowserMessage } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { SessionState } from "../../lib/chat/event-reducer.js";
import { useMessageHandler } from "../useMessageHandler.js";

function setup() {
  const sessionStatesRef = { current: new Map<string, SessionState>() };
  const setSessionStates = vi.fn((updater: any) => {
    sessionStatesRef.current =
      typeof updater === "function" ? updater(sessionStatesRef.current) : updater;
  });
  const setters: any = {
    setSessions: vi.fn(), setSessionStates, setSessionCommands: vi.fn(), setSessionFlows: vi.fn(),
    setFileResults: vi.fn(), setOpenspecMap: vi.fn(), setModelsMap: vi.fn(), setRolesMap: vi.fn(),
    setSpawnResult: vi.fn(), setSessionOrderMap: vi.fn(), setPinnedDirectories: vi.fn(),
    setFavoriteModels: vi.fn(), setTerminals: vi.fn(), setEditorStatuses: vi.fn(),
    setDiscoveredServers: vi.fn(), setSpawnErrors: vi.fn(), setResumeErrors: vi.fn(),
    setLoadingHistory: vi.fn(), setModelRefreshErrorsMap: vi.fn(),
  };
  const deps: any = {
    send: vi.fn(), navigate: vi.fn(), clearSpawningCwd: vi.fn(),
    spawningCwdsRef: { current: new Set() }, subscribedRef: { current: new Set() },
    pendingTerminalCwdRef: { current: null }, lastCreatedTerminalIdRef: { current: null },
    maxSeqMapRef: { current: new Map() }, selectedSessionIdRef: { current: undefined },
    loadingHistoryTimersRef: { current: new Map() },
  };
  const { result } = renderHook(() => useMessageHandler(setters, deps));
  return { dispatch: (msg: ServerToBrowserMessage) => result.current(msg), setModelsMap: setters.setModelsMap };
}

describe("useMessageHandler models_list visibility", () => {
  it("filters native anthropic from both session pickers and plugin models, without rewriting the message", () => {
    const { dispatch, setModelsMap } = setup();
    const models = [
      { provider: "anthropic", id: "claude-native" },
      { provider: "cliproxy", id: "anthropic/claude-proxy" },
      { provider: "deepseek", id: "deepseek-chat" },
    ];
    dispatch({ type: "models_list", sessionId: "s1", models } as ServerToBrowserMessage);
    const next = setModelsMap.mock.calls[0][0](new Map());
    expect(next.get("s1")).toEqual(models.slice(1));
    expect(getPluginConfig("roles").models).toEqual(models.slice(1));
    expect(models).toHaveLength(3);
  });
});

describe("useMessageHandler roles_list → builtinRoleNames", () => {
  it("writes builtinRoleNames into the roles plugin config", () => {
    const { dispatch } = setup();
    const builtin = ["planning", "coding", "compact", "fast", "vision", "research"];

    dispatch({
      type: "roles_list",
      sessionId: "s1",
      roles: { fast: "deepseek/deepseek-v4-flash" },
      presets: [],
      activePreset: null,
      builtinRoleNames: builtin,
    } as unknown as ServerToBrowserMessage);

    const cfg = getPluginConfig("roles");
    expect(cfg.builtinRoleNames).toEqual(builtin);
    expect(cfg.roles).toEqual({ fast: "deepseek/deepseek-v4-flash" });
  });
});
