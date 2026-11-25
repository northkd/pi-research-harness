export const THINKING_TRANSLATION_CHANNEL = "thinking-translator:snapshot";
export const THINKING_TRANSLATION_TTL_MS = 30_000;
export const THINKING_TRANSLATION_MAX_CHARS = 24_000;
export const THINKING_TRANSLATION_MIN_INTERVAL_MS = 200;

export interface ThinkingTranslationBlock {
  messageId: string;
  blockId: string;
  original: string;
  translation: string;
}

export interface TranslationFrameIdentity {
  type: "thinking_translation";
  sessionId: string;
  runtimeId: string;
  generation: number;
  sequence: number;
  turnId: string;
  expiresAt: number;
}

export type ThinkingTranslationFrame = TranslationFrameIdentity & (
  | { kind: "snapshot"; blocks: ThinkingTranslationBlock[] }
  | { kind: "clear" }
  | { kind: "status"; state: "disabled" | "ready" | "blocked" }
);

export interface TranslationModelRef { provider: string; id: string }
export interface TranslationOwner { iss: string; sub: string }
export interface TranslationAuthorization {
  version: 1;
  sessionId: string;
  enabled: boolean;
  model: TranslationModelRef;
  modelFingerprint: string;
  contentTypes: ["thinking"];
  targetLanguage: "Simplified Chinese";
  acceptedAt: string;
  owner: TranslationOwner;
  revision?: string;
}

const boundedId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 300 && !/[\x00-\x1f]/.test(v);

export function isThinkingTranslationFrame(value: unknown): value is ThinkingTranslationFrame {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.type !== "thinking_translation" || !boundedId(v.sessionId) || !boundedId(v.runtimeId) || !boundedId(v.turnId)) return false;
  if (!Number.isSafeInteger(v.generation) || (v.generation as number) < 0 || !Number.isSafeInteger(v.sequence) || (v.sequence as number) < 0 || typeof v.expiresAt !== "number" || !Number.isFinite(v.expiresAt)) return false;
  const allowed = new Set(["type", "kind", "sessionId", "runtimeId", "generation", "sequence", "turnId", "expiresAt", ...(v.kind === "snapshot" ? ["blocks"] : v.kind === "status" ? ["state"] : [])]);
  if (Object.entries(v).some(([key, item]) => item !== undefined && !allowed.has(key))) return false;
  if (v.kind === "clear") return true;
  if (v.kind === "status") return v.state === "disabled" || v.state === "ready" || v.state === "blocked";
  if (v.kind !== "snapshot" || !Array.isArray(v.blocks) || v.blocks.length === 0 || v.blocks.length > 32) return false;
  let chars = 0;
  return v.blocks.every((b: unknown) => {
    if (!b || typeof b !== "object") return false;
    const block = b as Record<string, unknown>;
    if (Object.keys(block).some((key) => !["messageId", "blockId", "original", "translation"].includes(key))) return false;
    if (!boundedId(block.messageId) || !boundedId(block.blockId) || typeof block.original !== "string" || typeof block.translation !== "string") return false;
    chars += block.original.length + block.translation.length;
    return chars <= THINKING_TRANSLATION_MAX_CHARS;
  });
}
