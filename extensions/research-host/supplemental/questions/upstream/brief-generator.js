import { redactSecrets } from "./redaction.js";
import { buildBriefPrompt } from "./brief-prompt.js";
const BRIEF_TIMEOUT_MS = 2e4;
const BRIEF_MAX_CONCURRENT = 2;
const BRIEF_MAX_CHARS = 2e3;
const UNSAFE_CHARS_RE = /[\u0000-\u0008\u000B-\u001F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
function createBriefGenerator(deps) {
  const timeoutMs = deps.timeoutMs ?? BRIEF_TIMEOUT_MS;
  const maxConcurrent = deps.maxConcurrent ?? BRIEF_MAX_CONCURRENT;
  const now = deps.now ?? Date.now;
  const counts = { ready: 0, failed: 0, unavailable: 0 };
  const queue = [];
  let inFlight = 0;
  function release() {
    inFlight--;
    const next = queue.shift();
    if (next) next();
  }
  function acquire() {
    if (inFlight < maxConcurrent) {
      inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      queue.push(() => {
        inFlight++;
        resolve();
      });
    });
  }
  async function run(req) {
    const resolved = await deps.resolveModel();
    if (!resolved.ok) return { kind: "unavailable", reason: resolved.reason };
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error(`generation timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
    });
    try {
      const text = await Promise.race([deps.complete(resolved.model, buildBriefPrompt(req), controller.signal), timeout]);
      const cleaned = typeof text === "string" ? redactSecrets(text.replace(UNSAFE_CHARS_RE, "")).trim() : "";
      if (!cleaned) return { kind: "failed", reason: "empty completion" };
      return { text: cleaned.slice(0, BRIEF_MAX_CHARS) };
    } catch (err) {
      return { kind: "failed", reason: err?.message ?? String(err) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return {
    async generate(req) {
      await acquire();
      const started = now();
      try {
        const res = await run(req);
        const latencyMs = Math.max(0, now() - started);
        if ("text" in res) {
          counts.ready++;
          console.log(`[questions] brief outcome=ready latencyMs=${latencyMs}`);
          return { ok: true, text: res.text, label: req.snapshot.assistantText ? "generated" : "generated-limited", latencyMs };
        }
        counts[res.kind]++;
        console.log(`[questions] brief outcome=${res.kind} latencyMs=${latencyMs} reason=${JSON.stringify(res.reason.slice(0, 120))}`);
        return { ok: false, kind: res.kind, reason: res.reason, latencyMs };
      } finally {
        release();
      }
    },
    stats() {
      return { ...counts, fallbacks: counts.failed + counts.unavailable, queued: queue.length, inFlight };
    }
  };
}
export {
  createBriefGenerator
};
