import { describe, expect, it, vi } from "vitest";
import { LocalBridgeSocket } from "../../acp-bridge/local-bridge-socket.js";
import { wireEvents } from "../../event-wiring.js";
import { createBrowserGateway } from "../../pairing/browser-gateway.js";
import { createPendingForkRegistry } from "../../pending/pending-fork-registry.js";
import { createMemoryEventStore } from "../../persistence/memory-event-store.js";
import { createPiGateway } from "../../pi/pi-gateway.js";
import { createMemorySessionManager } from "../../session/memory-session-manager.js";
import { buildLoadGatewayEx, flushAsync, makeFakeDirectoryService, seedSessions } from "../../__tests__/helpers/load-fixtures.js";
import { createDrainingWs } from "../../__tests__/helpers/draining-ws.js";

const status = (sessionId: string) => ({ type: "thinking_translation", kind: "status", state: "disabled", sessionId, runtimeId: "runtime-one", generation: 1, sequence: 1, turnId: "turn-one", expiresAt: Date.now() + 30_000 } as const);

describe("translation lane across real gateways with fake peers", () => {
  it("cannot auto-register a placeholder or forge another registered session", async () => {
    const manager = createMemorySessionManager();
    const gateway = createPiGateway(manager, { pingInterval: 0 });
    const socket = new LocalBridgeSocket(() => {});
    const onEvent = vi.fn(); gateway.onEvent = onEvent;
    gateway.attachLocalConnection(socket);
    try {
      socket.receive(status("session-one"));
      await flushAsync(4);
      expect(manager.get("session-one")).toBeUndefined();
      expect(onEvent).not.toHaveBeenCalled();
      socket.receive({ type: "session_register", sessionId: "session-one", cwd: "/isolated/translation-qa", source: "terminal" });
      await vi.waitFor(() => expect(manager.get("session-one")).toBeDefined());
      onEvent.mockClear();
      socket.receive(status("another-session"));
      await flushAsync(4);
      expect(manager.get("another-session")).toBeUndefined();
      expect(onEvent).not.toHaveBeenCalled();
      const ownFrame = status("session-one");
      socket.receive(ownFrame);
      await vi.waitFor(() => expect(onEvent).toHaveBeenCalledWith("session-one", ownFrame));
    } finally { socket.close(); gateway.stop(); }
  });
  it("routes before EventStore, persisted session state, raw plugins and transcript broadcasts", () => {
    const sessionManager = createMemorySessionManager();
    const eventStore = createMemoryEventStore(() => false);
    const piGateway = { start: vi.fn(), stop: vi.fn(), sendToSession: vi.fn(), getConnectedSessionIds: vi.fn(() => []), onEvent: vi.fn() } as any;
    const browserGateway = createBrowserGateway(sessionManager, eventStore, piGateway);
    const handle = vi.fn();
    const rawPlugin = vi.fn();
    const insert = vi.spyOn(eventStore, "insertEvent"), update = vi.spyOn(sessionManager, "update"), broadcast = vi.spyOn(browserGateway, "broadcastEvent");
    wireEvents({
      sessionManager, eventStore, piGateway, browserGateway,
      sessionOrderManager: { insert: vi.fn(), remove: vi.fn(), getOrder: () => [], reorder: vi.fn(), getAllOrders: () => ({}), moveToFront: vi.fn(), rekey: vi.fn() } as any,
      preferencesStore: { getPinnedDirectories: () => [], getSessionOrder: () => ({}), getAutoNameSessions: () => false } as any,
      pendingForkRegistry: createPendingForkRegistry(), directoryService: makeFakeDirectoryService().service,
      knownSessionIds: new Set(), pendingDashboardSpawns: new Map(),
      thinkingTranslationService: { handle, forget: vi.fn(), runtimeStatus: () => "pending-safe-load" },
      dispatchPluginRawEvent: rawPlugin,
    });
    const frame = status("session-one");
    piGateway.onEvent("session-one", frame);
    expect(handle).toHaveBeenCalledExactlyOnceWith("session-one", frame);
    expect(insert).not.toHaveBeenCalled(); expect(update).not.toHaveBeenCalled(); expect(broadcast).not.toHaveBeenCalled(); expect(rawPlugin).not.toHaveBeenCalled();
    expect(eventStore.getEvents("session-one", 1)).toEqual([]);
  });
  it("fans out only to subscribed browser sockets, never in-process consumers or a replay", async () => {
    const seed = seedSessions({ focusedCwd: "/isolated/translation-qa", idleCwds: [] });
    const { gateway, eventStore } = buildLoadGatewayEx(seed.manager);
    const first = createDrainingWs({ drainRateBytesPerMs: 1 }), second = createDrainingWs({ drainRateBytesPerMs: 1 });
    gateway.wss.emit("connection", first, {}); gateway.wss.emit("connection", second, {});
    first.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: seed.focusedSessionId })));
    second.emit("message", Buffer.from(JSON.stringify({ type: "subscribe", sessionId: seed.focusedSessionId })));
    await flushAsync(10);
    first.drainFully(); second.drainFully();
    const inProcess = vi.fn(); const dispose = gateway.addInProcessSubscriber(seed.focusedSessionId, inProcess);
    const frame = status(seed.focusedSessionId);
    gateway.sendEphemeralToSubscribers(seed.focusedSessionId, frame);
    expect(first.sent.filter((m) => m.type === "thinking_translation")).toHaveLength(1);
    expect(second.sent.filter((m) => m.type === "thinking_translation")).toHaveLength(1);
    expect(inProcess).not.toHaveBeenCalled();
    expect(eventStore.getEvents(seed.focusedSessionId, 1)).toEqual([]);
    dispose(); first.close(); second.close(); gateway.wss.close();
  });
});
