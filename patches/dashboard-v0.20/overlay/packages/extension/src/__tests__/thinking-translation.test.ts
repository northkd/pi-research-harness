import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as auth from "@blackbelt-technology/pi-dashboard-shared/thinking-translation-auth.js";
import * as frames from "@blackbelt-technology/pi-dashboard-shared/thinking-translation.js";
import * as redaction from "@blackbelt-technology/pi-dashboard-shared/redaction.js";
import { registerThinkingTranslationBridge } from "../thinking-translation-bridge.js";

const roots: string[] = [];
const cleanups: Array<() => Promise<unknown>> = [];
const nativePath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../thinking-translator/extensions/thinking-translator.ts");
const model = { provider: "fake", id: "nested/translator", api: "openai-completions", baseUrl: "https://example.invalid/v1" };
const original = "I am considering the observable evidence and will preserve uncertainty rather than invent a research conclusion.";
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
  vi.unstubAllEnvs();
  for (const p of roots.splice(0)) rmSync(p, { force: true, recursive: true });
});

function busFixture() {
  const handlers = new Map<string, Set<(value: unknown) => void>>();
  return {
    on(channel: string, fn: (value: unknown) => void) { let set = handlers.get(channel); if (!set) handlers.set(channel, set = new Set()); set.add(fn); return () => { set.delete(fn); }; },
    emit(channel: string, value: unknown) { for (const fn of handlers.get(channel) ?? []) fn(value); },
  };
}

function nativeFixture(options: { stream?: (model: unknown, context: unknown, options: { signal: AbortSignal }) => AsyncIterable<unknown>; authBaseUrl?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "native-translation-test-")); roots.push(dir);
  vi.stubEnv("PI_CODING_AGENT_DIR", dir);
  const code = transformSync(readFileSync(nativePath, "utf8"), { loader: "ts", format: "cjs", target: "node20" }).code;
  const module = { exports: {} as any };
  const nativeRequire = createRequire(import.meta.url);
  const requireMock = (specifier: string) => {
    if (specifier.endsWith("thinking-translation-auth.js")) return auth;
    if (specifier.endsWith("thinking-translation.js")) return frames;
    if (specifier.endsWith("redaction.js")) return redaction;
    if (specifier === "@earendil-works/pi-coding-agent") return { getMarkdownTheme: () => ({}) };
    if (specifier === "@earendil-works/pi-tui") return { Markdown: class { text: string; constructor(text: string) { this.text = text; } render() { return [this.text]; } }, truncateToWidth: (s: string, width: number) => s.slice(0, width) };
    if (specifier === "@earendil-works/pi-ai") throw new Error("removed pi-ai.stream API must not be imported");
    return nativeRequire(specifier);
  };
  new Function("require", "module", "exports", code)(requireMock, module, module.exports);
  const eventHandlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const events = busFixture();
  const published: frames.ThinkingTranslationFrame[] = [];
  events.on(frames.THINKING_TRANSLATION_CHANNEL, (value) => published.push(value as frames.ThinkingTranslationFrame));
  let command: any;
  const appendEntry = vi.fn(), sendMessage = vi.fn(), sendUserMessage = vi.fn();
  const pi = { events, registerCommand: (_name: string, definition: unknown) => { command = definition; }, on: (type: string, handler: (event: any, ctx: any) => unknown) => { let list = eventHandlers.get(type); if (!list) eventHandlers.set(type, list = []); list.push(handler); }, appendEntry, sendMessage, sendUserMessage };
  const widgets: unknown[] = [];
  const ctx: any = {
    cwd: dir,
    sessionManager: { getSessionId: () => "session-one" },
    modelRegistry: {
      find: vi.fn((provider: string, id: string) => provider === model.provider && id === model.id ? model : undefined),
      getAvailable: () => [model],
      getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, baseUrl: options.authBaseUrl })),
      stream: vi.fn(options.stream ?? (async function* () { yield { type: "text_delta", delta: "我会保留不确定性，不编造研究结论。" }; yield { type: "done" }; })),
    },
    ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn((_key: string, content: any) => { widgets.push(content); if (typeof content === "function") content({ requestRender: vi.fn() }, { fg: (_color: string, text: string) => text }); }), select: vi.fn(async () => `${model.provider}/${model.id}`), confirm: vi.fn(async () => false) },
  };
  module.exports.default(pi);
  const emit = async (type: string, event: any = {}) => { for (const handler of eventHandlers.get(type) ?? []) await handler(event, ctx); };
  const authorize = () => auth.writeTranslationAuthorization({ version: 1, sessionId: "session-one", enabled: true, model: { provider: model.provider, id: model.id }, modelFingerprint: auth.translationModelFingerprint(model), contentTypes: ["thinking"], targetLanguage: "Simplified Chinese", acceptedAt: "2026-10-23T00:00:00.000Z", owner: auth.LOCAL_TRANSLATION_OWNER }, dir);
  const thinking = () => emit("message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: original } });
  cleanups.push(() => emit("session_shutdown", { reason: "quit" }));
  return { dir, ctx, events, published, emit, authorize, thinking, command, widgets, appendEntry, sendMessage, sendUserMessage, eventHandlers, testing: module.exports.__testing };
}

describe("pinned native translator compatibility", () => {
  it("uses current registry.stream and exports nothing before separate user authorization", async () => {
    const f = nativeFixture();
    writeFileSync(join(f.dir, "thinking-translator.json"), JSON.stringify({ enabled: true, consent: true, translatorModel: model, contentTypes: ["thinking", "text"] }));
    await f.emit("session_start"); await f.thinking();
    expect(f.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.stream).not.toHaveBeenCalled();
    expect(f.published.some((frame) => frame.kind === "snapshot")).toBe(false);
    expect(f.testing.DEFAULT_CONFIG.enabled).toBe(false);
    expect(f.testing.getProjectConfigPath(f.dir)).toBeUndefined();
    await f.command.handler("enable", f.ctx);
    expect(f.ctx.ui.confirm).toHaveBeenCalled();
    expect(auth.readTranslationAuthorization("session-one", f.dir)).toBeNull();
  });
  it("hides native anthropic and role aliases while preserving proxied physical choices without implicit authorization", async () => {
    const f = nativeFixture();
    const native = { ...model, provider: "anthropic", id: "native-current" };
    const proxy = { ...model, provider: "cliproxy", id: "anthropic/qa-proxy-model" };
    const available = [native, proxy, model, { ...model, provider: "@fast" }, { ...model, id: "@fast" }, { ...model, api: "pi-virtual" }];
    const labels = available.map((item) => `${item.provider}/${item.id}`);
    f.ctx.model = { ...native };
    f.ctx.modelRegistry.getAvailable = () => available;
    f.ctx.ui.select.mockResolvedValueOnce(undefined);
    await f.command.handler("enable", f.ctx);
    expect(f.ctx.ui.select.mock.calls[0][1]).toEqual(["cliproxy/anthropic/qa-proxy-model", "fake/nested/translator"]);
    expect(f.ctx.ui.confirm).not.toHaveBeenCalled();
    expect(auth.readTranslationAuthorization("session-one", f.dir)).toBeNull();
    f.ctx.ui.select.mockResolvedValueOnce("cliproxy/anthropic/qa-proxy-model");
    await f.command.handler("enable", f.ctx);
    expect(f.ctx.ui.confirm).toHaveBeenCalledTimes(1);
    expect(f.ctx.ui.confirm.mock.calls[0][1]).toContain("cliproxy/anthropic/qa-proxy-model");
    expect(auth.readTranslationAuthorization("session-one", f.dir)).toBeNull();
    expect(readdirSync(f.dir)).not.toContain("thinking-translator-authorizations");
    expect(f.ctx.modelRegistry.find).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.stream).not.toHaveBeenCalled();
    expect(f.ctx.model).toEqual(native);
    expect(available.map((item) => `${item.provider}/${item.id}`)).toEqual(labels);
  });
  it("streams the exact authorized physical model without tools and displays both widget and transient frame", async () => {
    const f = nativeFixture(); f.authorize(); await f.emit("session_start"); await f.emit("agent_start"); await f.emit("turn_start", { turnIndex: 7 });
    const originalEvent = Object.freeze({ type: "thinking_end", contentIndex: 0, content: original });
    await f.emit("message_update", { assistantMessageEvent: originalEvent });
    await vi.waitFor(() => expect(f.published.some((frame) => frame.kind === "snapshot")).toBe(true));
    expect(originalEvent).toEqual({ type: "thinking_end", contentIndex: 0, content: original });
    expect(f.ctx.modelRegistry.stream).toHaveBeenCalledTimes(1);
    const [actualModel, context] = f.ctx.modelRegistry.stream.mock.calls[0];
    expect(actualModel).toEqual(model);
    expect(context).toHaveProperty("messages");
    expect(context).not.toHaveProperty("tools");
    expect(context.messages[0].content[0].text).toContain(original);
    const displayed = f.published.find((frame) => frame.kind === "snapshot") as Extract<frames.ThinkingTranslationFrame, { kind: "snapshot" }>;
    expect(displayed.turnId).toContain(":7");
    expect(displayed.blocks[0]).toMatchObject({ original, translation: "我会保留不确定性，不编造研究结论。", blockId: "0:0" });
    expect(f.widgets.some((widget) => typeof widget === "function")).toBe(true);
    expect(f.appendEntry).not.toHaveBeenCalled(); expect(f.sendMessage).not.toHaveBeenCalled(); expect(f.sendUserMessage).not.toHaveBeenCalled();
    for (const name of ["context", "context_with_system", "before_agent_start", "before_provider_request", "session_before_compact"]) expect(f.eventHandlers.has(name)).toBe(false);
    const grantFile = readdirSync(join(f.dir, "thinking-translator-authorizations"));
    expect(grantFile).toHaveLength(1);
    const raw = readFileSync(join(f.dir, "thinking-translator-authorizations", grantFile[0]), "utf8");
    expect(raw).not.toContain(original); expect(raw).not.toContain("我会保留");
    const before = JSON.stringify({ role: "assistant", content: [{ type: "thinking", thinking: original }] });
    await f.emit("message_update", { assistantMessageEvent: { type: "text_end", contentIndex: 1, content: "A final answer is not authorized for translation." } });
    expect(f.ctx.modelRegistry.stream).toHaveBeenCalledTimes(1);
    expect(before).toContain(original);
  });
  it("blocks endpoint changes, known credential-looking visible content and unavailable models without fallback", async () => {
    const f = nativeFixture({ authBaseUrl: "https://other.invalid/v1" }); f.authorize(); await f.emit("session_start"); await f.thinking();
    await vi.waitFor(() => expect(f.ctx.modelRegistry.getApiKeyAndHeaders).toHaveBeenCalled());
    expect(f.ctx.modelRegistry.stream).not.toHaveBeenCalled();
    await f.emit("agent_start");
    await f.emit("message_update", { assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Visible text includes API_KEY=FAKE_ONLY_FOR_TEST and must not be sent." } });
    expect(f.ctx.modelRegistry.stream).not.toHaveBeenCalled();
    f.ctx.modelRegistry.find.mockReturnValueOnce(undefined);
    await f.thinking();
    expect(f.ctx.modelRegistry.stream).not.toHaveBeenCalled();
    expect(f.ctx.ui.notify.mock.calls.flat().join(" ")).not.toContain("FAKE_ONLY_FOR_TEST");
  });
  it("refuses Pi virtual model routing even if a private grant names that alias", async () => {
    const f = nativeFixture();
    const virtual = { ...model, api: "pi-virtual" };
    f.authorize();
    const prior = auth.readTranslationAuthorization("session-one", f.dir)!;
    auth.writeTranslationAuthorization({ ...prior, modelFingerprint: auth.translationModelFingerprint(virtual) }, f.dir);
    f.ctx.modelRegistry.find.mockReturnValue(virtual);
    await f.emit("session_start"); await f.thinking();
    expect(f.ctx.modelRegistry.getApiKeyAndHeaders).not.toHaveBeenCalled();
    expect(f.ctx.modelRegistry.stream).not.toHaveBeenCalled();
  });
  it("aborts in-flight translation and drops queued work at a new generation", async () => {
    let signal: AbortSignal | undefined;
    const f = nativeFixture({ stream: async function* (_m, _c, options) { signal = options.signal; yield { type: "text_delta", delta: "临时" }; await new Promise<void>((done) => { options.signal.addEventListener("abort", () => done(), { once: true }); }); } });
    f.authorize(); await f.emit("session_start"); await f.thinking();
    await vi.waitFor(() => expect(signal).toBeDefined());
    await f.emit("agent_start");
    expect(signal?.aborted).toBe(true);
    expect(f.published.at(-1)?.kind).toBe("clear");
    await new Promise((done) => setTimeout(done, 220));
    expect(f.published.at(-1)?.kind).toBe("clear");
  });
  it("invalidates a delayed translator at every tool-continuation turn boundary", async () => {
    let signal: AbortSignal | undefined, release: (() => void) | undefined;
    const f = nativeFixture({ stream: async function* (_m, _c, options) {
      signal = options.signal;
      yield { type: "text_delta", delta: "旧轮次片段" };
      await new Promise<void>((done) => { release = done; options.signal.addEventListener("abort", () => done(), { once: true }); });
      yield { type: "text_delta", delta: "迟到的旧轮次译文" };
    } });
    f.authorize(); await f.emit("session_start"); await f.emit("turn_start", { turnIndex: 1 }); await f.thinking();
    await vi.waitFor(() => expect(signal).toBeDefined());
    const before = f.published.length;
    await f.emit("turn_start", { turnIndex: 2 });
    release?.();
    await new Promise((done) => setTimeout(done, 240));
    expect(signal?.aborted).toBe(true);
    expect(f.published.slice(before).some((event) => event.kind === "snapshot")).toBe(false);
    expect(f.published.at(-1)?.kind).toBe("clear");
  });
  it("reconnect/status requests clear rather than replaying an old translation", async () => {
    const f = nativeFixture(); f.authorize(); await f.emit("session_start"); await f.thinking();
    await vi.waitFor(() => expect(f.published.some((frame) => frame.kind === "snapshot")).toBe(true));
    const calls = f.ctx.modelRegistry.stream.mock.calls.length;
    f.events.emit("thinking-translator:status-request", { sessionId: "session-one" });
    expect(f.published.at(-1)?.kind).toBe("status");
    expect(f.published.at(-2)?.kind).toBe("clear");
    expect(f.ctx.modelRegistry.stream).toHaveBeenCalledTimes(calls);
  });
});

describe("narrow native display bridge", () => {
  it("never buffers disconnected or other-session text and never uses event_forward", () => {
    const bus = busFixture(), send = vi.fn(); let connected = false;
    const bridge = registerThinkingTranslationBridge(bus, { getSessionId: () => "session-one", isReady: () => true, isActive: () => true, isConnected: () => connected, send });
    const frame = { type: "thinking_translation", kind: "status", state: "disabled", sessionId: "session-one", runtimeId: "runtime-one", turnId: "turn-one", generation: 1, sequence: 1, expiresAt: Date.now() + 30_000 };
    bus.emit(frames.THINKING_TRANSLATION_CHANNEL, frame);
    expect(send).not.toHaveBeenCalled();
    connected = true;
    expect(send).not.toHaveBeenCalled();
    bus.emit(frames.THINKING_TRANSLATION_CHANNEL, { ...frame, sessionId: "another-session" });
    expect(send).not.toHaveBeenCalled();
    bus.emit(frames.THINKING_TRANSLATION_CHANNEL, frame);
    expect(send).toHaveBeenCalledExactlyOnceWith(frame);
    bridge.dispose(); bus.emit(frames.THINKING_TRANSLATION_CHANNEL, frame);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
