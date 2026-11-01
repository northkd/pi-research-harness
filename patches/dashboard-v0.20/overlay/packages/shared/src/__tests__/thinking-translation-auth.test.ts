import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { authorizationPath, readTranslationAuthorization, readTranslationRevision, translationModelFingerprint, writeTranslationAuthorization, writeTranslationRevocation } from "../thinking-translation-auth.js";
import { isThinkingTranslationFrame } from "../thinking-translation.js";

const roots: string[] = [];
const root = () => { const p = mkdtempSync(join(tmpdir(), "thinking-auth-test-")); roots.push(p); return p; };
const model = { provider: "fake", id: "visible-thinking-translator", api: "openai-completions", baseUrl: "https://example.invalid/v1" };
const owner = { iss: "test", sub: "one" };
const grant = { version: 1 as const, sessionId: "session-one", enabled: true as const, model: { provider: model.provider, id: model.id }, modelFingerprint: translationModelFingerprint(model), contentTypes: ["thinking"] as ["thinking"], targetLanguage: "Simplified Chinese" as const, acceptedAt: "2026-10-23T00:00:00.000Z", owner };
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }); });

describe("trusted translation authorization", () => {
  it("defaults to no authorization; ignores a project-looking consent object", () => {
    const agentDir = root();
    writeFileSync(join(agentDir, "thinking-translator.json"), JSON.stringify({ consent: true, enabled: true, translatorModel: model }));
    expect(readTranslationAuthorization("session-one", agentDir)).toBeNull();
  });
  it("writes a private exact-session grant and never copies source thinking", () => {
    const agentDir = root();
    writeTranslationAuthorization(grant, agentDir);
    const p = authorizationPath("session-one", agentDir);
    expect(readTranslationAuthorization("session-one", agentDir)).toMatchObject(grant);
    expect(readTranslationAuthorization("session-two", agentDir)).toBeNull();
    expect(lstatSync(p).mode & 0o777).toBe(0o600);
    expect(lstatSync(join(agentDir, "thinking-translator-authorizations")).mode & 0o777).toBe(0o700);
    expect(readFileSync(p, "utf8")).not.toContain("sourceText");
  });
  it("refuses symlink authorization directories and never follows a symlink file", () => {
    const agentDir = root(), outside = root();
    symlinkSync(outside, join(agentDir, "thinking-translator-authorizations"));
    expect(() => writeTranslationAuthorization(grant, agentDir)).toThrow();
    expect(readTranslationAuthorization("session-one", agentDir)).toBeNull();
  });
  it("fails closed on broad modes, another session, malformed or expanded scope", () => {
    const agentDir = root(); writeTranslationAuthorization(grant, agentDir);
    const p = authorizationPath("session-one", agentDir);
    for (const patch of [{ sessionId: "session-two" }, { contentTypes: ["thinking", "text"] }, { enabled: "yes" }, { owner: null }]) {
      writeFileSync(p, JSON.stringify({ ...grant, ...patch }));
      expect(readTranslationAuthorization("session-one", agentDir)).toBeNull();
    }
    writeFileSync(p, JSON.stringify(grant)); chmodSync(p, 0o644);
    expect(readTranslationAuthorization("session-one", agentDir)).toBeNull();
  });
  it("persists revocation tombstones and atomically rejects stale authorization revisions", () => {
    const agentDir = root();
    const absent = readTranslationRevision("session-one", agentDir);
    expect(absent).toBeNull();
    writeTranslationRevocation("session-one", owner, agentDir);
    expect(readTranslationAuthorization("session-one", agentDir)).toBeNull();
    const revoked = readTranslationRevision("session-one", agentDir);
    expect(revoked).not.toBeNull();
    expect(() => writeTranslationAuthorization(grant, agentDir, absent)).toThrow("authorization changed");
    expect(readTranslationAuthorization("session-one", agentDir)).toBeNull();
    writeTranslationAuthorization(grant, agentDir, revoked);
    const enabled = readTranslationRevision("session-one", agentDir);
    expect(enabled).not.toBe(revoked);
    writeTranslationRevocation("session-one", owner, agentDir);
    expect(() => writeTranslationAuthorization(grant, agentDir, enabled)).toThrow("authorization changed");
    expect(readTranslationAuthorization("session-one", agentDir)?.enabled).toBe(false);
  });
  it("binds provider/id, endpoint, API and headers without exposing values", () => {
    const a = translationModelFingerprint(model);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    for (const patch of [{ provider: "other" }, { id: "other" }, { baseUrl: "https://other.invalid" }, { api: "other" }, { headers: { "X-Route": "other" } }]) {
      expect(translationModelFingerprint({ ...model, ...patch })).not.toBe(a);
    }
    expect(translationModelFingerprint({ ...model, headers: { b: "2", a: "1" } })).toBe(translationModelFingerprint({ ...model, headers: { a: "1", b: "2" } }));
  });
});

describe("transient translation frame boundary", () => {
  const frame = { type: "thinking_translation", kind: "snapshot", sessionId: "session-one", runtimeId: "runtime-one", generation: 1, sequence: 1, turnId: "turn-one", expiresAt: Date.now() + 30_000, blocks: [{ messageId: "message-one", blockId: "0:0", original: "Visible thinking only.", translation: "仅可见思考。" }] };
  it("accepts only bounded known display frames", () => {
    expect(isThinkingTranslationFrame(frame)).toBe(true);
    expect(isThinkingTranslationFrame({ ...frame, kind: "status", state: "disabled", blocks: undefined })).toBe(true);
    expect(isThinkingTranslationFrame({ ...frame, kind: "clear", blocks: undefined })).toBe(true);
    for (const patch of [{ sequence: -1 }, { generation: Number.NaN }, { sessionId: "" }, { blocks: Array(65).fill(frame.blocks[0]) }, { blocks: [{ ...frame.blocks[0], translation: "x".repeat(25_000) }] }, { kind: "event_forward" }]) {
      expect(isThinkingTranslationFrame({ ...frame, ...patch })).toBe(false);
    }
  });
});
