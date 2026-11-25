const MAX_AUTH_FAILURES = 10;
const MAX_IP_AUTH_FAILURES = 100;
const AUTH_FAILURE_WINDOW_MS = 6e4;
const AUTH_LOCKOUT_MS = 6e4;
const MAX_TRACKED_SOURCES = 1e4;
function credentialKey(ip, fingerprint) {
  return `${ip}\0${fingerprint}`;
}
class AuthFailureThrottle {
  maxFailures;
  windowMs;
  lockoutMs;
  maxSources;
  maxIpFailures;
  /**
   * Per-`(ip, fingerprint)` buckets. Keyed by `ip + NUL + fingerprint` — the
   * fingerprint is a hex SHA-256 digest, but the separator keeps an ip and a
   * fingerprint from bleeding into each other.
   */
  perCredential = /* @__PURE__ */ new Map();
  /** Coarse per-ip ceiling buckets. Keyed by ip alone. */
  perIp = /* @__PURE__ */ new Map();
  constructor(maxFailures = MAX_AUTH_FAILURES, windowMs = AUTH_FAILURE_WINDOW_MS, lockoutMs = AUTH_LOCKOUT_MS, maxSources = MAX_TRACKED_SOURCES, maxIpFailures = MAX_IP_AUTH_FAILURES) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
    this.lockoutMs = lockoutMs;
    this.maxSources = maxSources;
    this.maxIpFailures = maxIpFailures;
  }
  /** Tracked per-credential bucket count. Asserted by tests as the memory-bound canary. */
  get size() {
    return this.perCredential.size;
  }
  /** Tracked per-ip bucket count. P3 asserts fingerprint churn leaves it intact. */
  get ipSources() {
    return this.perIp.size;
  }
  /** Whether `(ip, fingerprint)` may attempt authentication now. */
  check(ip, fingerprint, now = Date.now()) {
    const credential = this.perCredential.get(credentialKey(ip, fingerprint));
    const ceiling = this.perIp.get(ip);
    const blocked = [credential, ceiling].find(
      (record) => record !== void 0 && record.lockedUntil > now
    );
    if (blocked !== void 0) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil((blocked.lockedUntil - now) / 1e3)
      };
    }
    for (const [map, key, record] of [
      [this.perCredential, credentialKey(ip, fingerprint), credential],
      [this.perIp, ip, ceiling]
    ]) {
      if (record !== void 0 && record.lockedUntil !== 0) map.delete(key);
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }
  /** Record a failed authentication against both buckets. */
  recordFailure(ip, fingerprint, now = Date.now()) {
    this.bump(this.perCredential, credentialKey(ip, fingerprint), this.maxFailures, this.maxSources, now);
    this.bump(this.perIp, ip, this.maxIpFailures, this.maxSources, now);
  }
  /** Record a success, clearing any accumulated failures for both buckets. */
  recordSuccess(ip, fingerprint) {
    this.perCredential.delete(credentialKey(ip, fingerprint));
    this.perIp.delete(ip);
  }
  /**
   * Advance one bucket's window/lockout state, evicting the oldest entry when
   * at capacity (shared by both maps — each is bounded independently).
   *
   * `Map` preserves insertion order, so the first key is the oldest tracked
   * source. Evicting it can drop an active lockout, which is the accepted
   * trade: bounding memory matters more than perfectly retaining one
   * attacker's penalty, and reaching this cap already means the source space is
   * being rotated (so per-source lockout is not the effective control anyway).
   */
  bump(map, key, threshold, maxEntries, now) {
    const existing = map.get(key);
    if (!existing) {
      if (map.size >= maxEntries) {
        const oldest = map.keys().next();
        if (!oldest.done) map.delete(oldest.value);
      }
      map.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    if (now - existing.windowStart >= this.windowMs) {
      existing.count = 1;
      existing.windowStart = now;
      existing.lockedUntil = 0;
      return;
    }
    existing.count += 1;
    if (existing.count >= threshold) {
      existing.lockedUntil = now + this.lockoutMs;
    }
  }
  /** Drop all state (plugin unload). */
  clear() {
    this.perCredential.clear();
    this.perIp.clear();
  }
}
export {
  AUTH_FAILURE_WINDOW_MS,
  AUTH_LOCKOUT_MS,
  AuthFailureThrottle,
  MAX_AUTH_FAILURES,
  MAX_IP_AUTH_FAILURES,
  MAX_TRACKED_SOURCES
};
