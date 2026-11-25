import { createHash } from "node:crypto";
import { readTranslationAuthorization } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation-auth.js";
import { isThinkingTranslationFrame, THINKING_TRANSLATION_MIN_INTERVAL_MS, THINKING_TRANSLATION_TTL_MS, type ThinkingTranslationFrame, type TranslationAuthorization } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation.js";

export interface ThinkingTranslationService {
  handle(sessionId: string, frame: unknown): boolean;
  runtimeStatus(sessionId: string): "pending-safe-load" | "disabled" | "ready" | "blocked";
  forget(sessionId: string): void;
}

/** Display-only lane: retain cursors/capability, never translated text or a replay. */
export function createThinkingTranslationService(deps: {
  sendToSubscribers: (sessionId: string, frame: ThinkingTranslationFrame) => void;
  readAuthorization?: (sessionId: string) => TranslationAuthorization | null;
  now?: () => number;
}): ThinkingTranslationService {
  const now = deps.now ?? Date.now;
  const readAuthorization = deps.readAuthorization ?? readTranslationAuthorization;
  const cursors = new Map<string, { runtimeId: string; generation: number; sequence: number; turnId: string; sentAt: number; digest: string; state: "disabled" | "ready" | "blocked" }>();
  return {
    handle(sessionId, raw) {
      if (!isThinkingTranslationFrame(raw) || raw.sessionId !== sessionId) return false;
      const frame = raw;
      const previous = cursors.get(sessionId);
      if (previous?.runtimeId === frame.runtimeId && (frame.generation < previous.generation || (frame.generation === previous.generation && frame.sequence <= previous.sequence))) return false;
      const time = now();
      if (frame.kind === "snapshot" && (frame.expiresAt <= time || frame.expiresAt > time + THINKING_TRANSLATION_TTL_MS + 1000)) return false;
      if (frame.kind === "snapshot" && !readAuthorization(sessionId)?.enabled) return false;
      const sameTurn = previous?.runtimeId === frame.runtimeId && previous.generation === frame.generation && previous.turnId === frame.turnId;
      const digest = frame.kind === "snapshot" ? createHash("sha256").update(JSON.stringify(frame.blocks)).digest("hex") : frame.kind === "status" && sameTurn ? previous.digest : "";
      if (frame.kind === "status" && sameTurn && previous.state === frame.state) return false;
      if (frame.kind === "snapshot" && sameTurn && (digest === previous.digest || time - previous.sentAt < THINKING_TRANSLATION_MIN_INTERVAL_MS)) return false;
      if (!cursors.has(sessionId) && cursors.size >= 256) cursors.delete(cursors.keys().next().value!);
      cursors.set(sessionId, {
        runtimeId: frame.runtimeId, generation: frame.generation, sequence: frame.sequence, turnId: frame.turnId,
        sentAt: frame.kind === "snapshot" ? time : sameTurn ? previous.sentAt : 0, digest,
        state: frame.kind === "status" ? frame.state : previous?.state ?? "disabled",
      });
      deps.sendToSubscribers(sessionId, frame);
      return true;
    },
    runtimeStatus(sessionId) { return cursors.get(sessionId)?.state ?? "pending-safe-load"; },
    forget(sessionId) {
      const cursor = cursors.get(sessionId);
      if (!cursor) return;
      deps.sendToSubscribers(sessionId, { type: "thinking_translation", kind: "clear", sessionId, runtimeId: cursor.runtimeId, generation: cursor.generation + 1, sequence: cursor.sequence + 1, turnId: cursor.turnId, expiresAt: now() });
      cursors.delete(sessionId);
    },
  };
}
