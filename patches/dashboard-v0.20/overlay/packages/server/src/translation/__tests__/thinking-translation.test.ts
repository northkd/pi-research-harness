import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authorizationPath, readTranslationAuthorization, translationModelFingerprint } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation-auth.js";
import type { ThinkingTranslationFrame, TranslationAuthorization } from "@blackbelt-technology/pi-dashboard-shared/thinking-translation.js";
import { createThinkingTranslationService } from "../thinking-translation-service.js";
import { registerThinkingTranslationRoutes } from "../thinking-translation-routes.js";
import { classifyHttpRoad } from "../../identity/http-road-classification.js";

const roots: string[] = [];
const model = { provider: "fake", id: "nested/translator", baseUrl: "https://example.invalid/v1", api: "openai-completions" };
const owner = { iss: "test", sub: "owner" };
const grant: TranslationAuthorization = { version: 1, sessionId: "session-one", enabled: true, model: { provider: model.provider, id: model.id }, modelFingerprint: translationModelFingerprint(model), contentTypes: ["thinking"], targetLanguage: "Simplified Chinese", acceptedAt: "2026-10-23T00:00:00.000Z", owner };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { force: true, recursive: true }); });
const fixture = (patch: Record<string, unknown> = {}): ThinkingTranslationFrame => {
  const frame = { type: "thinking_translation", kind: "snapshot", sessionId: "session-one", runtimeId: "runtime-one", generation: 1, sequence: 1, turnId: "turn-one", expiresAt: 31_000, blocks: [{ messageId: "message-one", blockId: "0:0", original: "Visible thinking.", translation: "可见思考。" }], ...patch };
  if (frame.kind !== "snapshot") delete (frame as { blocks?: unknown }).blocks;
  return frame as ThinkingTranslationFrame;
};

describe("ephemeral thinking translation relay", () => {
  it("requires private authorization, correct socket identity, bounded fresh data and monotonic cursors", () => {
    let time = 1000, authorization: TranslationAuthorization | null = null;
    const send = vi.fn();
    const service = createThinkingTranslationService({ sendToSubscribers: send, now: () => time, readAuthorization: () => authorization });
    expect(service.runtimeStatus("session-one")).toBe("pending-safe-load");
    expect(service.handle("session-one", fixture())).toBe(false);
    authorization = grant;
    expect(service.handle("another-session", fixture())).toBe(false);
    expect(service.handle("session-one", fixture({ expiresAt: 999 }))).toBe(false);
    expect(service.handle("session-one", fixture({ expiresAt: 99_999 }))).toBe(false);
    expect(service.handle("session-one", fixture())).toBe(true);
    expect(service.handle("session-one", fixture())).toBe(false);
    time += 250;
    expect(service.handle("session-one", fixture({ sequence: 2 }))).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
    expect(service.handle("session-one", fixture({ kind: "status", state: "ready", sequence: 3 }))).toBe(true);
    expect(service.runtimeStatus("session-one")).toBe("ready");
    expect(service.handle("session-one", fixture({ kind: "status", state: "ready", sequence: 4 }))).toBe(false);
    service.forget("session-one");
    expect(send.mock.calls.at(-1)?.[1].kind).toBe("clear");
    expect(service.runtimeStatus("session-one")).toBe("pending-safe-load");
    expect(JSON.stringify(service)).not.toContain("可见思考");
  });
  it("fans one producer result out without ever starting a model", () => {
    const first: unknown[] = [], second: unknown[] = [];
    const service = createThinkingTranslationService({ now: () => 1000, readAuthorization: () => grant, sendToSubscribers: (_id, frame) => { first.push(frame); second.push(frame); } });
    service.handle("session-one", fixture());
    expect(first).toEqual(second);
    expect(first).toHaveLength(1);
  });
});

describe("explicit session-owner translation authorization", () => {
  it("classifies per-session settings as handler-owner-gated roads and leaves unknown roads closed", () => {
    expect(classifyHttpRoad("GET", "/api/thinking-translation/settings")).toEqual({ road: "session-handler" });
    expect(classifyHttpRoad("PUT", "/api/thinking-translation/settings")).toEqual({ road: "session-handler" });
    expect(classifyHttpRoad("GET", "/api/thinking-translation/unknown")).toBeUndefined();
  });
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "translation-route-test-")); roots.push(dir);
    const app = Fastify();
    let principal = owner;
    let currentOwner = owner;
    const resolve = vi.fn(async () => model);
    const notify = vi.fn();
    const service = createThinkingTranslationService({ sendToSubscribers: () => {}, readAuthorization: (id) => readTranslationAuthorization(id, dir) });
    app.addHook("onRequest", async (request) => { (request as any).principal = principal; });
    registerThinkingTranslationRoutes(app, { networkGuard: async () => {}, sessionManager: { get: (id) => id === "session-one" ? { principalOwner: currentOwner } : undefined }, isResolverActive: () => true, service, agentDir: dir, resolveModel: resolve, notifyAuthorizationChanged: notify });
    return { app, dir, resolve, notify, principal: (p: typeof owner) => { principal = p; }, owner: (p: typeof owner) => { currentOwner = p; } };
  }
  it("is disabled on read; no consent or cancellation creates a grant or resolves a model", async () => {
    const f = await setup();
    try {
      const read = await f.app.inject({ method: "GET", url: "/api/thinking-translation/settings?sessionId=session-one" });
      expect(read.json()).toMatchObject({ enabled: false, model: null, runtime: "pending-safe-load" });
      const invalid = await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: true, model, consent: false } });
      expect(invalid.statusCode).toBe(400);
      expect(f.resolve).not.toHaveBeenCalled();
      expect(readTranslationAuthorization("session-one", f.dir)).toBeNull();
    } finally { await f.app.close(); }
  });
  it("stores only the authorized physical model/scope and not credentials or thinking", async () => {
    const f = await setup();
    try {
      const result = await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: true, model: { provider: model.provider, id: model.id }, consent: true, contentTypes: ["text"] } });
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({ enabled: true, model: { provider: "fake", id: "nested/translator" }, contentTypes: ["thinking"] });
      expect(f.resolve).toHaveBeenCalledExactlyOnceWith("fake", "nested/translator");
      expect(f.notify).toHaveBeenCalledWith("session-one");
      const raw = readFileSync(authorizationPath("session-one", f.dir), "utf8");
      expect(raw).not.toContain(model.baseUrl);
      expect(raw).not.toContain("apiKey");
      expect(readTranslationAuthorization("session-one", f.dir)?.contentTypes).toEqual(["thinking"]);
      const disable = await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: false } });
      expect(disable.json().enabled).toBe(false);
      expect(f.resolve).toHaveBeenCalledTimes(1);
    } finally { await f.app.close(); }
  });
  it("owner-gates reads/writes before model resolution and rechecks after asynchronous resolution", async () => {
    const f = await setup();
    try {
      f.principal({ ...owner, sub: "other" });
      expect((await f.app.inject({ url: "/api/thinking-translation/settings?sessionId=session-one" })).statusCode).toBe(404);
      expect((await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: true, model, consent: true } })).statusCode).toBe(404);
      expect(f.resolve).not.toHaveBeenCalled();
      f.principal(owner);
      f.resolve.mockImplementationOnce(async () => { f.owner({ ...owner, sub: "other" }); return model; });
      expect((await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: true, model, consent: true } })).statusCode).toBe(404);
      expect(readTranslationAuthorization("session-one", f.dir)).toBeNull();
    } finally { await f.app.close(); }
  });
  it.each([false, true])("a completed disable invalidates an older asynchronous enable (prior grant: %s)", async (withPrior) => {
    const f = await setup();
    try {
      if (withPrior) await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: true, model, consent: true } });
      let finish!: (value: typeof model) => void;
      f.resolve.mockImplementationOnce(() => new Promise((done) => { finish = done; }));
      const pendingEnable = f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: true, model, consent: true } });
      await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
      const disabled = await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: false } });
      expect(disabled.statusCode).toBe(200);
      finish(model);
      const late = await pendingEnable;
      expect(late.statusCode).toBe(409);
      expect(readTranslationAuthorization("session-one", f.dir)?.enabled ?? false).toBe(false);
    } finally { await f.app.close(); }
  });
  it("never silently falls back after a selected-model failure or mismatch", async () => {
    const f = await setup();
    try {
      f.resolve.mockRejectedValueOnce(new Error("selected unavailable"));
      const result = await f.app.inject({ method: "PUT", url: "/api/thinking-translation/settings", payload: { sessionId: "session-one", enabled: true, model, consent: true } });
      expect(result.statusCode).toBe(409);
      expect(f.resolve).toHaveBeenCalledTimes(1);
      expect(result.body).not.toContain("selected unavailable");
      expect(readTranslationAuthorization("session-one", f.dir)).toBeNull();
    } finally { await f.app.close(); }
  });
});
