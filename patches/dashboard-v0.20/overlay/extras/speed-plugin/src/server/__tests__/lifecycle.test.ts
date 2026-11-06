import { afterEach, describe, expect, it, vi } from "vitest";
import registerPlugin from "../index.js";
import { getActiveGeneration, markGenerationEnd } from "../stats.js";

async function fixture() {
  let event: (sessionId: string, event: unknown) => void = () => {};
  let ended: (sessionId: string) => void = () => {};
  const routes = new Map();
  await registerPlugin({
    fastify: { get: (path: string, ...args: unknown[]) => routes.set(path, args.at(-1)) },
    sessionManager: { listAll: () => [], getSession: () => undefined },
    onEvent: (handler: typeof event) => { event = handler; },
    onSessionEnded: (handler: typeof ended) => { ended = handler; },
  } as any);
  return { event: (id: string, value: unknown) => event(id, value), ended: (id: string) => ended(id), routes };
}

afterEach(() => {
  for (const id of ["speed-live", "speed-other"]) markGenerationEnd(id);
  vi.useRealTimers();
});

describe("speed plugin event provenance", () => {
  it("replayed starts never create a live request or reset a new performance sample", async () => {
    const f = await fixture();
    const start = { eventType: "message_start", data: { message: { role: "assistant", model: "demo" } } };
    f.event("speed-live", { ...start, replay: true });
    expect(getActiveGeneration("speed-live")).toBeNull();
    f.event("speed-live", { ...start, replay: false });
    expect(getActiveGeneration("speed-live")?.model).toBe("demo");
    f.event("speed-live", { ...start, replay: true });
    expect(getActiveGeneration("speed-live")).toBeNull();
    f.event("speed-live", { ...start, replay: false });
    f.ended("speed-live");
    expect(getActiveGeneration("speed-live")).toBeNull();
  });

  it("user and tool messages do not start or finish another session's observed interval", async () => {
    const f = await fixture();
    f.event("speed-live", { eventType: "message_start", data: { message: { role: "assistant", model: "demo" } } });
    f.event("speed-other", { eventType: "message_start", data: { message: { role: "user" } } });
    f.event("speed-live", { eventType: "message_end", data: { message: { role: "toolResult" } } });
    expect(getActiveGeneration("speed-other")).toBeNull();
    expect(getActiveGeneration("speed-live")).not.toBeNull();
    f.event("speed-live", { eventType: "message_end", data: { message: { role: "assistant" } } });
    expect(getActiveGeneration("speed-live")).toBeNull();
    expect([...f.routes.keys()]).toEqual(["/api/speed-monitor/billing", "/api/speed-monitor/stats"]);
  });
});
