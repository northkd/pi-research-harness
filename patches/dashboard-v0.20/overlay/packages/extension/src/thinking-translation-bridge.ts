import { isThinkingTranslationFrame, THINKING_TRANSLATION_CHANNEL, type ThinkingTranslationFrame } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation.js";

interface TranslationBus {
  on(channel: string, handler: (value: unknown) => void): (() => void) | void;
  emit(channel: string, value: unknown): void;
}

/** One narrow volatile lane, deliberately not a generic widget/event forwarder. */
export function registerThinkingTranslationBridge(bus: TranslationBus, deps: {
  getSessionId: () => string;
  isActive: () => boolean;
  isReady: () => boolean;
  isConnected: () => boolean;
  send: (frame: ThinkingTranslationFrame) => void;
}): { requestStatus(): void; dispose(): void } {
  let disposed = false;
  const unsubscribe = bus.on(THINKING_TRANSLATION_CHANNEL, (value) => {
    if (disposed || !deps.isActive() || !deps.isReady() || !deps.isConnected()) return;
    if (!isThinkingTranslationFrame(value) || value.sessionId !== deps.getSessionId()) return;
    deps.send(value);
  });
  return {
    dispose() { disposed = true; if (typeof unsubscribe === "function") unsubscribe(); },
    requestStatus() {
      if (!disposed && deps.isActive() && deps.isReady() && deps.isConnected()) bus.emit("thinking-translator:status-request", { sessionId: deps.getSessionId() });
    },
  };
}
