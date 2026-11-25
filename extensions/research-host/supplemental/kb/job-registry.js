const MAX_ERROR_CHARS = 500;
function summarizeFailures(outcomes) {
  const failed = (outcomes ?? []).filter((o) => o.status === "error");
  if (failed.length === 0) return void 0;
  const text = `${failed.length} source(s) failed: ${failed.map((o) => `${o.ref}: ${o.error ?? "error"}`).join("; ")}`;
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS - 1)}\u2026` : text;
}
let jobSeq = 0;
class KbJobRegistry {
  jobs = /* @__PURE__ */ new Map();
  inflight = /* @__PURE__ */ new Map();
  ids = /* @__PURE__ */ new Map();
  /** True while a reindex walk for `cwd` is in progress. */
  isRunning(cwd) {
    return this.inflight.has(cwd);
  }
  /** The in-flight job id for `cwd`, when running. */
  jobId(cwd) {
    return this.ids.get(cwd);
  }
  /** Last/current job state for `cwd` (undefined = never run). */
  get(cwd) {
    return this.jobs.get(cwd);
  }
  /** Outcomes of the last settled walk for `cwd` (empty when none). */
  outcomesFor(cwd) {
    return this.jobs.get(cwd)?.outcomes ?? [];
  }
  /** Derive the client-facing job status for `cwd`. A completed job → idle;
   *  a *failed* last job → error (until a later success clears it). */
  statusFor(cwd) {
    if (this.inflight.has(cwd)) return "running";
    return this.jobs.get(cwd)?.status === "error" ? "error" : "idle";
  }
  /**
   * Start a reindex for `cwd`, or return the existing in-flight promise when
   * one is already running (coalesce). `running` is set SYNCHRONOUSLY before
   * returning, so a concurrent second call observes it and does not start a
   * second walk.
   */
  start(cwd, fn) {
    const existing = this.inflight.get(cwd);
    if (existing) return { coalesced: true, promise: existing };
    const priorOutcomes = this.jobs.get(cwd)?.outcomes;
    this.jobs.set(cwd, { status: "running", startedAt: Date.now(), ...priorOutcomes ? { outcomes: priorOutcomes } : {} });
    this.ids.set(cwd, `kb-${++jobSeq}`);
    const promise = Promise.resolve().then(fn).then(
      (r) => {
        const failure = summarizeFailures(r.outcomes);
        this.jobs.set(cwd, {
          status: failure ? "error" : "done",
          startedAt: this.jobs.get(cwd)?.startedAt ?? Date.now(),
          finishedAt: Date.now(),
          changed: r.changed,
          chunks: r.chunks,
          ...failure ? { error: failure } : {},
          ...r.outcomes ? { outcomes: r.outcomes } : {}
        });
        this.inflight.delete(cwd);
        this.ids.delete(cwd);
        return r;
      },
      (e) => {
        const prior = this.jobs.get(cwd)?.outcomes;
        this.jobs.set(cwd, { status: "error", startedAt: this.jobs.get(cwd)?.startedAt ?? Date.now(), finishedAt: Date.now(), error: e instanceof Error ? e.message : String(e), ...prior ? { outcomes: prior } : {} });
        this.inflight.delete(cwd);
        this.ids.delete(cwd);
        throw e;
      }
    );
    this.inflight.set(cwd, promise);
    return { coalesced: false, promise };
  }
}
export {
  KbJobRegistry
};
