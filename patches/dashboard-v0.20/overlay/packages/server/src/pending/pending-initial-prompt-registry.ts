/**
 * In-memory pending initial-prompt intents.
 *
 * Two correlation strategies share one store:
 *
 *  1. Legacy cwd FIFO (unchanged): browser `spawn_session { cwd, initialPrompt }`
 *     enqueues by cwd before the spawn await; the next `session_register` for
 *     that cwd consumes the head. This is what older callers use and it is kept
 *     byte-for-byte compatible. It can misdeliver when two sessions start in
 *     the same cwd concurrently, because cwd is not an identity.
 *
 *  2. Exact spawn-token binding (new): a trusted spawn road mints or reuses the
 *     spawn token it is already passing to `spawnPiSession`, files the prompt
 *     under that token BEFORE awaiting the spawn, and the `session_register`
 *     carrying the same `spawnToken` consumes it. Correlation is by the unique
 *     token, never by cwd, so concurrent same-cwd spawns cannot swap prompts.
 *     The token entry is single-use: `consumeForSpawn` deletes it, and a second
 *     register carrying the same token can neither consume it again nor fall
 *     through to the cwd FIFO (`wasSpawnConsumed` is true).
 *
 * Both paths share the 60 s TTL. The token map is additionally capped; the
 * legacy per-cwd FIFO keeps its original cap of 8. In-memory only, never
 * persisted across restarts.
 *
 * The documented integration point for non-WS callers is the optional third
 * argument: `enqueue(cwd, prompt, spawnToken?)`, `consume(cwd, spawnToken?)`,
 * `remove(cwd, spawnToken)`. Omit the token for the legacy cwd FIFO. The
 * explicit `enqueueForSpawn` / `consumeForSpawn` / `removeForSpawn` aliases are
 * equivalent. Rollback also tombstones the token so a late register cannot
 * steal a legacy same-cwd prompt.
 *
 * See change: project-init-skill-and-profiles (legacy cwd FIFO);
 * stage-session-spawn initial prompt (token binding).
 */
import { safeRealpathSync } from "../resolve-path.js";

interface PendingPrompt {
  prompt: string;
  enqueuedAt: number;
}

interface PendingTokenPrompt extends PendingPrompt {
  cwd: string;
}

export const PENDING_INITIAL_PROMPT_TTL_MS = 60_000;
export const PENDING_INITIAL_PROMPT_QUEUE_CAP = 8;
/** Upper bound for a token-bound first prompt. Keeps a spawn request bounded. */
export const PENDING_INITIAL_PROMPT_MAX_BYTES = 16 * 1024;
/** Token entries live at most 60 s, but a burst still needs a hard ceiling. */
export const PENDING_INITIAL_PROMPT_TOKEN_CAP = 64;

export interface PendingInitialPromptRegistry {
  /**
   * File an intent. With NO `spawnToken`, this is the legacy cwd FIFO and its
   * semantics are unchanged: returns false only when the prompt is empty or
   * the per-cwd queue is full.
   *
   * With a `spawnToken`, the intent is bound to that exact token. Exactly-once:
   * returns false for an empty/invalid token, an empty prompt, a prompt that
   * exceeds `PENDING_INITIAL_PROMPT_MAX_BYTES` / contains NUL, a duplicate
   * still-pending token, or a full token map. A token-scoped entry is NEVER
   * visible to a cwd-only call.
   */
  enqueue(cwd: string, prompt: string, spawnToken?: string): boolean;
  /**
   * Consume exactly one intent. With NO `spawnToken`, consumes the legacy cwd
   * FIFO head and never a token-scoped entry. With a `spawnToken`, consumes
   * only the entry bound to that exact token — never the cwd FIFO, and never a
   * mismatched token (returns null).
   */
  consume(cwd: string, spawnToken?: string): string | null;
  /**
   * Failed-spawn rollback. Token-scoped: delete only this token's entry and
   * record a tombstone so a late register with the same token cannot consume
   * an unrelated legacy cwd prompt. Called without a token it is a no-op (the
   * legacy FIFO has no remove primitive).
   */
  remove(cwd: string, spawnToken?: string): void;
  /** Pending legacy entries for a cwd (post-TTL sweep). */
  size(cwd: string): number;

  /** Alias of `enqueue(cwd, prompt, spawnToken)`; explicit token-first name. */
  enqueueForSpawn(spawnToken: string, cwd: string, prompt: string): boolean;
  /** Alias of `consume("", spawnToken)`; never consults cwd. */
  consumeForSpawn(spawnToken: string): string | null;
  /** Alias of `remove("", spawnToken)`. */
  removeForSpawn(spawnToken: string): void;
  /** True once `consume(..., token)` or `remove(..., token)` handled this token. */
  wasSpawnConsumed(spawnToken: string): boolean;
  /** Pending token entries (post-TTL sweep); tests/observability. */
  sizeForSpawn(): number;
}

export interface PendingInitialPromptRegistryOptions {
  now?: () => number;
  normalize?: (cwd: string) => string;
  warn?: (msg: string) => void;
}

function isBoundedPrompt(prompt: unknown): prompt is string {
  return (
    typeof prompt === "string" &&
    prompt.length > 0 &&
    !prompt.includes("\0") &&
    Buffer.byteLength(prompt, "utf8") <= PENDING_INITIAL_PROMPT_MAX_BYTES
  );
}

export function createPendingInitialPromptRegistry(
  opts: PendingInitialPromptRegistryOptions = {},
): PendingInitialPromptRegistry {
  const now = opts.now ?? (() => Date.now());
  const normalize = opts.normalize ?? ((cwd: string) => safeRealpathSync(stripTrailingSep(cwd)));
  const warn = opts.warn ?? ((m: string) => console.warn(m));

  /** Legacy per-cwd FIFO. */
  const store = new Map<string, PendingPrompt[]>();
  /** Exact spawn-token entries. */
  const byToken = new Map<string, PendingTokenPrompt>();
  /** Tokens already consumed/rolled back, retained for one TTL. */
  const consumedTokens = new Map<string, number>();

  function pruneStale(key: string): PendingPrompt[] {
    const queue = store.get(key);
    if (!queue) return [];
    const cutoff = now() - PENDING_INITIAL_PROMPT_TTL_MS;
    while (queue.length > 0 && queue[0]!.enqueuedAt < cutoff) {
      const stale = queue.shift()!;
      warn(
        `[pending-initial-prompt-registry] dropping stale intent: cwd=${key} ageMs=${now() - stale.enqueuedAt}`,
      );
    }
    if (queue.length === 0) {
      store.delete(key);
      return [];
    }
    return queue;
  }

  function sweepTokens(): void {
    const cutoff = now() - PENDING_INITIAL_PROMPT_TTL_MS;
    for (const [token, entry] of byToken) {
      if (entry.enqueuedAt < cutoff) {
        byToken.delete(token);
        // Tombstone an expired token too: its register may still arrive late,
        // and it must not fall through to an unrelated legacy cwd prompt.
        consumedTokens.set(token, now());
        warn(
          `[pending-initial-prompt-registry] dropping stale token intent: token=${token} cwd=${entry.cwd} ageMs=${now() - entry.enqueuedAt}`,
        );
      }
    }
    for (const [token, consumedAt] of consumedTokens) {
      if (consumedAt < cutoff) consumedTokens.delete(token);
    }
  }

  function enqueueLegacy(cwd: string, prompt: string): boolean {
    if (!prompt) return false;
    const key = normalize(cwd);
    const queue = pruneStale(key);
    if (queue.length >= PENDING_INITIAL_PROMPT_QUEUE_CAP) {
      warn(
        `[pending-initial-prompt-registry] queue cap reached (${PENDING_INITIAL_PROMPT_QUEUE_CAP}) for cwd=${key}; dropping`,
      );
      return false;
    }
    queue.push({ prompt, enqueuedAt: now() });
    store.set(key, queue);
    return true;
  }

  function consumeLegacy(cwd: string): string | null {
    const key = normalize(cwd);
    const queue = pruneStale(key);
    if (queue.length === 0) return null;
    const head = queue.shift()!;
    if (queue.length === 0) store.delete(key);
    return head.prompt;
  }

  function enqueueToken(spawnToken: string, cwd: string, prompt: string): boolean {
    if (typeof spawnToken !== "string" || spawnToken.length === 0) return false;
    if (!isBoundedPrompt(prompt)) {
      warn("[pending-initial-prompt-registry] rejecting invalid or oversized token-bound prompt");
      return false;
    }
    sweepTokens();
    if (byToken.has(spawnToken)) {
      warn(`[pending-initial-prompt-registry] duplicate pending token=${spawnToken}; dropping`);
      return false;
    }
    if (byToken.size >= PENDING_INITIAL_PROMPT_TOKEN_CAP) {
      warn(
        `[pending-initial-prompt-registry] token cap reached (${PENDING_INITIAL_PROMPT_TOKEN_CAP}); dropping token=${spawnToken}`,
      );
      return false;
    }
    byToken.set(spawnToken, { prompt, cwd, enqueuedAt: now() });
    // A reused token starts a new lifecycle; clear any old tombstone.
    consumedTokens.delete(spawnToken);
    return true;
  }

  function consumeToken(spawnToken: string): string | null {
    if (typeof spawnToken !== "string" || spawnToken.length === 0) return null;
    sweepTokens();
    const entry = byToken.get(spawnToken);
    if (!entry) return null;
    byToken.delete(spawnToken);
    consumedTokens.set(spawnToken, now());
    return entry.prompt;
  }

  function removeToken(spawnToken: string): void {
    if (typeof spawnToken !== "string" || spawnToken.length === 0) return;
    sweepTokens();
    byToken.delete(spawnToken);
    consumedTokens.set(spawnToken, now());
  }

  function wasTokenConsumed(spawnToken: string): boolean {
    if (typeof spawnToken !== "string" || spawnToken.length === 0) return false;
    sweepTokens();
    return consumedTokens.has(spawnToken);
  }

  return {
    enqueue(cwd: string, prompt: string, spawnToken?: string): boolean {
      if (typeof spawnToken === "string") return enqueueToken(spawnToken, cwd, prompt);
      return enqueueLegacy(cwd, prompt);
    },

    consume(cwd: string, spawnToken?: string): string | null {
      // An explicitly supplied token NEVER falls back to the cwd FIFO. A
      // cwd-only call NEVER sees a token-scoped entry.
      if (typeof spawnToken === "string") return consumeToken(spawnToken);
      return consumeLegacy(cwd);
    },

    remove(_cwd: string, spawnToken?: string): void {
      // The legacy cwd FIFO has no removal primitive; only token-scoped
      // intents have an exact identity to roll back.
      if (typeof spawnToken === "string") removeToken(spawnToken);
    },

    size(cwd: string): number {
      const key = normalize(cwd);
      return pruneStale(key).length;
    },

    enqueueForSpawn(spawnToken: string, cwd: string, prompt: string): boolean {
      return enqueueToken(spawnToken, cwd, prompt);
    },

    consumeForSpawn(spawnToken: string): string | null {
      return consumeToken(spawnToken);
    },

    removeForSpawn(spawnToken: string): void {
      removeToken(spawnToken);
    },

    wasSpawnConsumed(spawnToken: string): boolean {
      return wasTokenConsumed(spawnToken);
    },

    sizeForSpawn(): number {
      sweepTokens();
      return byToken.size;
    },
  };
}

function stripTrailingSep(p: string): string {
  if (p.length > 1 && (p.endsWith("/") || p.endsWith("\\"))) {
    return p.replace(/[/\\]+$/, "");
  }
  return p;
}
