import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const SPEED_TIMING_CUSTOM_TYPE = "dashboard-speed-timing";
type OutputKind = "text" | "thinking" | "toolcall";
type Identity = { messageTimestamp: number; provider: string; model: string };
type Timing = Identity & {
  version: 1;
  source: "pi-stream";
  requestDurationMs: number | null;
  firstTokenMs: number | null;
  generationDurationMs: number | null;
  firstOutputKind: OutputKind | null;
};
type Attempt = {
  requestStart: number | null;
  identity: Identity | null;
  firstOutput: number | null;
  kind: OutputKind | null;
};
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function identity(message: unknown): Identity | null {
  if (!object(message) || message.role !== "assistant"
    || typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp) || message.timestamp < 0
    || typeof message.provider !== "string" || !message.provider
    || typeof message.model !== "string" || !message.model) return null;
  return { messageTimestamp: message.timestamp, provider: message.provider, model: message.model };
}
const same = (a: Identity | null, b: Identity | null) => a !== null && b !== null
  && a.messageTimestamp === b.messageTimestamp && a.provider === b.provider && a.model === b.model;
function outputKind(event: unknown): OutputKind | null {
  if (!object(event)) return null;
  if (typeof event.delta === "string" && event.delta.length > 0) {
    if (event.type === "text_delta") return "text";
    if (event.type === "thinking_delta") return "thinking";
    if (event.type === "toolcall_delta") return "toolcall";
  }
  // A function name is output too; empty block-start/role/usage events are not.
  if (event.type === "toolcall_start" && object(event.partial) && Array.isArray(event.partial.content)
    && Number.isInteger(event.contentIndex)) {
    const block: unknown = event.partial.content[event.contentIndex as number];
    if (object(block) && block.type === "toolCall" && typeof block.name === "string" && block.name.length > 0) return "toolcall";
  }
  return null;
}

/** Observe native Pi events before WebSocket coalescing, without reading request payloads.
 * Custom entries contain timings/identity only and never enter the model transcript.
 * This measures client-observed output, not a provider's internal decoding clock.
 */
export function registerGenerationTiming(
  pi: Pick<ExtensionAPI, "on">,
  options: { isActive: () => boolean; now?: () => number },
) {
  const now = options.now ?? (() => performance.now());
  let current: Attempt | null = null;
  // Pi can pass an extension replacement into this handler, then copy its
  // enumerable properties onto the original message before appendMessage.
  // An opaque, non-serializable ticket survives that exact in-process copy;
  // timestamps or reloaded JSON cannot manufacture one.
  const ticketKey = Symbol("dashboard-speed-timing");
  let completed = new WeakMap<object, Timing>();
  const reset = () => { current = null; completed = new WeakMap(); };

  pi.on("before_provider_request", () => {
    if (!options.isActive() || current?.identity) return;
    // Cache warming can reuse the provider hooks without any agent events.
    // Never reset a live assistant. Multiple pre-start requests make TTFT
    // ambiguous; retain only the subsequently observed output window.
    const ambiguous = current !== null;
    current = { requestStart: ambiguous ? null : now(), identity: null, firstOutput: null, kind: null };
  });
  pi.on("turn_start", () => { current = null; });
  pi.on("message_start", (event) => {
    if (!options.isActive()) return;
    const id = identity(event.message);
    if (!id) return;
    if (!current || (current.identity && !same(current.identity, id))) {
      current = { requestStart: null, identity: null, firstOutput: null, kind: null };
    }
    current.identity = id;
  });
  pi.on("message_update", (event) => {
    if (!options.isActive() || !current || current.firstOutput !== null || !same(current.identity, identity(event.message))) return;
    const kind = outputKind(event.assistantMessageEvent);
    if (kind) { current.firstOutput = now(); current.kind = kind; }
  });
  pi.on("message_end", (event) => {
    if (!options.isActive() || !current || !same(current.identity, identity(event.message))) return;
    const attempt = current;
    current = null;
    const end = now();
    const clocks = [end, attempt.requestStart, attempt.firstOutput].filter((x): x is number => x !== null);
    if (!clocks.every(Number.isFinite)
      || (attempt.requestStart !== null && end < attempt.requestStart)
      || (attempt.firstOutput !== null && (end < attempt.firstOutput
        || (attempt.requestStart !== null && attempt.firstOutput < attempt.requestStart)))) return;
    const ticket = {};
    completed.set(ticket, {
      ...attempt.identity!, version: 1, source: "pi-stream",
      requestDurationMs: attempt.requestStart === null ? null : end - attempt.requestStart,
      firstTokenMs: attempt.requestStart === null || attempt.firstOutput === null ? null : attempt.firstOutput - attempt.requestStart,
      generationDurationMs: attempt.firstOutput === null ? null : end - attempt.firstOutput,
      firstOutputKind: attempt.kind,
    });
    Object.defineProperty(event.message, ticketKey, { value: ticket, enumerable: true, configurable: true, writable: true });
  });
  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("agent_end", () => { current = null; });

  return {
    /** Pi appends after awaited message_end handlers. Bind to the actual returned
     * entry ID, never the previous leaf, a wall-time guess or a replayed message.
     */
    afterAppend(message: unknown, entryId: unknown, append: (type: string, data: Timing & { messageEntryId: string }) => void): void {
      if (!options.isActive() || !object(message)) return;
      const ticket: unknown = (message as Record<symbol, unknown>)[ticketKey];
      if (!object(ticket)) return;
      const timing = completed.get(ticket);
      if (!timing) return;
      completed.delete(ticket);
      delete (message as Record<symbol, unknown>)[ticketKey];
      if (typeof entryId !== "string" || !entryId || entryId.length > 200 || !same(timing, identity(message))) return;
      append(SPEED_TIMING_CUSTOM_TYPE, { ...timing, messageEntryId: entryId });
    },
  };
}
