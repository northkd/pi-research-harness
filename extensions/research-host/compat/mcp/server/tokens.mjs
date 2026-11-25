import crypto from "node:crypto";
const TOKEN_BYTES = 32;
const TOKEN_PREFIX = "mcp_";
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}
function timingSafeEqualHex(a, b) {
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}
class McpTokenRegistry {
  /**
   * A flat array, not a `Map` keyed by hash, on purpose. A map lookup would
   * short-circuit on a miss and leak membership through timing; the linear scan
   * performs the same `timingSafeEqual` work whether or not a row matches
   * (X10).
   */
  rows = [];
  /** Number of live tokens. Test/observability surface. */
  get size() {
    return this.rows.length;
  }
  /**
   * Mint a token for `sessionId`, returning the plaintext exactly once.
   *
   * The caller is responsible for having proven the session's identity. The
   * only channel that can do so is the bridge WebSocket, where the sessionId is
   * the key the socket is stored under (design.md Decision 6) — never a field
   * read off the wire.
   *
   * REPLACES the session's existing row rather than appending: the bridge
   * re-mints on every (re)registration, and a stale row left behind would keep
   * the previous token valid until session end — failing "credential is revoked
   * → presenting it SHALL be refused" — while growing a registry whose
   * `resolve()` linear-scans (design.md D4).
   */
  mintForSession(sessionId) {
    const token = TOKEN_PREFIX + crypto.randomBytes(TOKEN_BYTES).toString("base64url");
    const row = { tokenHash: hashToken(token), sessionId, mintedAt: Date.now() };
    const existing = this.rows.findIndex((r) => r.sessionId === sessionId);
    if (existing >= 0) this.rows[existing] = row;
    else this.rows.push(row);
    return token;
  }
  /**
   * Resolve a presented token to its caller, or `null` when it authenticates
   * nothing. Tolerates arbitrary input — this runs on unauthenticated request
   * data, so it must never throw.
   */
  resolve(token) {
    if (typeof token !== "string" || token.length === 0) return null;
    const presented = hashToken(token);
    let found;
    for (const row of this.rows) {
      if (timingSafeEqualHex(presented, row.tokenHash)) found = row;
    }
    return found ? { kind: "session", sessionId: found.sessionId, tier: "control" } : null;
  }
  /** Revoke one token (explicit `mcp/revoke-token`). True when a row went. */
  revokeToken(token) {
    if (typeof token !== "string" || token.length === 0) return false;
    const presented = hashToken(token);
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => !timingSafeEqualHex(presented, row.tokenHash));
    return this.rows.length !== before;
  }
  /**
   * Revoke every token bound to a session — the primary path, driven by
   * `onSessionEnded` and the bridge's `onDisconnect` (Decision 8). Returns how
   * many rows went, so a caller can log the effect.
   */
  revokeSession(sessionId) {
    const before = this.rows.length;
    this.rows = this.rows.filter((row) => row.sessionId !== sessionId);
    return before - this.rows.length;
  }
  /**
   * Drop every token. Called when the plugin unloads so no credential outlives
   * the code that honours it (X8).
   */
  dispose() {
    this.rows = [];
  }
  /** Test-only view proving the plaintext is absent from stored state. */
  debugRows() {
    return this.rows.map((row) => ({ ...row }));
  }
  /** Test-only: rewrite a row's mint time to assert age is never an input. */
  debugBackdate(token, mintedAt) {
    const presented = hashToken(token);
    for (const row of this.rows) {
      if (timingSafeEqualHex(presented, row.tokenHash)) row.mintedAt = mintedAt;
    }
  }
}
export {
  McpTokenRegistry
};
