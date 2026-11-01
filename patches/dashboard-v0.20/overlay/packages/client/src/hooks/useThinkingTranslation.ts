import { isThinkingTranslationFrame, THINKING_TRANSLATION_TTL_MS, type ThinkingTranslationFrame } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation.js";
import { useEffect, useState } from "react";

type Snapshot = Extract<ThinkingTranslationFrame, { kind: "snapshot" }>;

/** Display memory only; never feed this value to chat reducers, storage or outgoing messages. */
export function useThinkingTranslation(sessionId: string | undefined, ws: WebSocket | null, connected: boolean) {
  const [snapshotState, setSnapshotState] = useState<{ frame: Snapshot; ws: WebSocket } | null>(null);
  const [blockedScope, setBlockedScope] = useState<{ sessionId: string; ws: WebSocket } | null>(null);
  useEffect(() => {
    setSnapshotState(null);
    setBlockedScope(null);
    if (!sessionId || !ws || !connected) return;
    let active = true;
    let cursor: { runtimeId: string; generation: number; sequence: number } | null = null;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const clear = () => { clearTimeout(expiry); setSnapshotState(null); };
    const onMessage = (event: MessageEvent) => {
      if (!active) return;
      try {
        const frame: unknown = JSON.parse(String(event.data));
        if (!isThinkingTranslationFrame(frame) || frame.sessionId !== sessionId) return;
        if (cursor?.runtimeId === frame.runtimeId && (frame.generation < cursor.generation || (frame.generation === cursor.generation && frame.sequence <= cursor.sequence))) return;
        cursor = { runtimeId: frame.runtimeId, generation: frame.generation, sequence: frame.sequence };
        if (frame.kind === "clear") { clear(); return; }
        if (frame.kind === "status") {
          setBlockedScope(frame.state === "blocked" ? { sessionId, ws } : null);
          if (frame.state !== "ready") clear();
          return;
        }
        const remaining = frame.expiresAt - Date.now();
        if (remaining <= 0 || remaining > THINKING_TRANSLATION_TTL_MS + 1000) { clear(); return; }
        clearTimeout(expiry);
        setBlockedScope(null);
        setSnapshotState({ frame, ws });
        expiry = setTimeout(clear, Math.min(remaining, THINKING_TRANSLATION_TTL_MS));
      } catch { /* Malformed display frames never affect the original chat. */ }
    };
    const onClose = () => { active = false; clear(); setBlockedScope(null); };
    const onVisibility = () => setSnapshotState((value) => value && value.frame.expiresAt > Date.now() ? value : null);
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      clearTimeout(expiry);
      ws.removeEventListener("message", onMessage);
      ws.removeEventListener("close", onClose);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [sessionId, ws, connected]);
  const snapshot = snapshotState && snapshotState.ws === ws ? snapshotState.frame : null;
  return { snapshot: connected && snapshot && snapshot.sessionId === sessionId && snapshot.expiresAt > Date.now() ? snapshot : null, blocked: connected && blockedScope?.sessionId === sessionId && blockedScope?.ws === ws };
}
