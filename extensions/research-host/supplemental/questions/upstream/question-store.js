import { randomBytes } from "node:crypto";
import {
  QUESTION_PREVIEW_MAX
} from "./question-types.js";
import { contextMessageOf, decideBriefPolicy } from "./brief-policy.js";
import { buildQuestionSnapshot } from "./question-snapshot.js";
const TRANSMITTED_WINDOW_MS = 10 * 6e4;
const FILE_ACCESS_KINDS = ["agent-path-gate", "agent-path-gate-confirm"];
const keyOf = (sessionId, promptId) => `${sessionId}\0${promptId}`;
function createQuestionStore(deps) {
  const now = deps.now ?? Date.now;
  const mint = deps.mintId ?? (() => randomBytes(16).toString("base64url"));
  const byKey = /* @__PURE__ */ new Map();
  const byId = /* @__PURE__ */ new Map();
  const persisted = /* @__PURE__ */ new Map();
  const tombstones = /* @__PURE__ */ new Map();
  const listeners = /* @__PURE__ */ new Set();
  function emit(change) {
    for (const l of [...listeners]) {
      try {
        l(change);
      } catch (err) {
        console.error("[questions] change listener failed:", err.message);
      }
    }
  }
  function sweepTombstones() {
    const cutoff = now() - TRANSMITTED_WINDOW_MS;
    for (const [id, t] of tombstones) if (t.at <= cutoff) tombstones.delete(id);
  }
  const answeredRecently = (id) => {
    sweepTombstones();
    return tombstones.get(id);
  };
  function newId() {
    for (; ; ) {
      const id = mint();
      if (!byId.has(id) && !tombstones.has(id) && ![...persisted.values()].some((f) => f.id === id)) return id;
    }
  }
  function persist(rec) {
    const file = {
      version: 1,
      id: rec.id,
      sessionId: rec.sessionId,
      promptId: rec.promptId,
      askedAt: rec.askedAt,
      snapshot: rec.snapshot,
      briefStatus: rec.briefStatus,
      ...rec.brief !== void 0 ? { brief: rec.brief } : {},
      ...rec.briefLabel ? { briefLabel: rec.briefLabel } : {}
    };
    try {
      deps.files.write(file);
    } catch (err) {
      console.error(`[questions] cannot persist question ${rec.id}:`, err.message);
    }
  }
  function originOf(msg, session) {
    const meta = msg.prompt?.metadata;
    if (typeof meta?.kind === "string" && FILE_ACCESS_KINDS.includes(meta.kind)) return "file";
    if (session?.chatGateway) return "chat-gateway";
    if (msg.placement === "widget-bar") return "widget-bar";
    return void 0;
  }
  function dropRecord(rec, more = false) {
    byKey.delete(keyOf(rec.sessionId, rec.promptId));
    byId.delete(rec.id);
    deps.files.remove(rec.id);
    emit({ kind: "removed", id: rec.id, sessionId: rec.sessionId, ...more ? { more: true } : {} });
  }
  function dropAll(recs) {
    recs.forEach((rec, i) => dropRecord(rec, i < recs.length - 1));
  }
  function dropPersisted(key) {
    const file = persisted.get(key);
    if (!file) return;
    persisted.delete(key);
    deps.files.remove(file.id);
  }
  function requestOf(rec) {
    return {
      question: rec.question,
      type: rec.type,
      ...rec.options ? { options: rec.options } : {},
      ...rec.questions ? { subQuestions: rec.questions } : {},
      ...rec.message !== void 0 ? { message: rec.message } : {},
      snapshot: rec.snapshot
    };
  }
  const isLive = (rec) => byId.get(rec.id) === rec;
  function runGeneration(rec, mode) {
    if (rec.inflight !== void 0) return rec.inflight;
    const p = deps.briefs.generate(requestOf(rec)).catch((err) => ({ ok: false, kind: "failed", reason: err?.message ?? String(err), latencyMs: 0 })).then((outcome) => {
      rec.inflight = void 0;
      if (!isLive(rec)) return outcome;
      if (outcome.ok) {
        rec.brief = outcome.text;
        rec.briefLabel = outcome.label;
        rec.briefStatus = "ready";
      } else if (mode === "auto") {
        rec.briefStatus = outcome.kind;
      } else {
        return outcome;
      }
      persist(rec);
      emit({ kind: "brief", id: rec.id, sessionId: rec.sessionId });
      return outcome;
    });
    rec.inflight = p;
    return p;
  }
  function rowOf(rec) {
    const session = deps.describeSession(rec.sessionId);
    return {
      id: rec.id,
      sessionId: rec.sessionId,
      sessionLabel: session?.label ?? rec.sessionId,
      ...session?.changeName ? { changeName: session.changeName } : {},
      preview: rec.question.slice(0, QUESTION_PREVIEW_MAX),
      type: rec.type,
      ...rec.origin ? { origin: rec.origin } : {},
      askedAt: rec.askedAt,
      briefStatus: rec.briefStatus
    };
  }
  function detailOf(rec) {
    return {
      ...rowOf(rec),
      question: rec.question,
      ...rec.options ? { options: rec.options } : {},
      ...rec.allowOther ? { allowOther: true } : {},
      ...rec.brief !== void 0 ? { brief: rec.brief } : {},
      ...rec.briefLabel ? { briefLabel: rec.briefLabel } : {},
      snapshot: rec.snapshot,
      answerable: rec.origin !== "file" && rec.claim === void 0,
      ...rec.questions ? { questions: rec.questions } : {}
    };
  }
  function claim(id) {
    const rec = byId.get(id);
    if (rec) {
      if (rec.claim) return { status: "answered" };
      rec.claim = "claimed";
      return { status: "claimed", id };
    }
    return answeredRecently(id) ? { status: "answered" } : { status: "unknown" };
  }
  const batchQuestionsOf = (raw) => raw.filter((q) => !!q && typeof q === "object" && !Array.isArray(q));
  return {
    onTracked(sessionId, msg) {
      const promptId = msg.promptId;
      if (typeof promptId !== "string" || !promptId) return void 0;
      const key = keyOf(sessionId, promptId);
      const existing = byKey.get(key);
      if (existing) {
        if (existing.claim === "transmitted") {
          existing.claim = void 0;
          existing.transmittedAt = void 0;
          tombstones.delete(existing.id);
          emit({ kind: "added", id: existing.id, sessionId });
        }
        return existing;
      }
      const prompt = msg.prompt ?? {};
      const metadata = prompt.metadata && typeof prompt.metadata === "object" ? prompt.metadata : void 0;
      const message = contextMessageOf(metadata?.message);
      const session = deps.describeSession(sessionId);
      const base = {
        sessionId,
        promptId,
        type: typeof prompt.type === "string" ? prompt.type : "unknown",
        question: typeof prompt.question === "string" ? prompt.question : "",
        ...Array.isArray(prompt.options) ? { options: prompt.options.filter((o) => typeof o === "string") } : {},
        ...metadata?.allowOther === true ? { allowOther: true } : {},
        ...Array.isArray(metadata?.questions) ? { questions: batchQuestionsOf(metadata.questions) } : {},
        ...originOf(msg, session) ? { origin: originOf(msg, session) } : {},
        ...message !== void 0 ? { message } : {}
      };
      const file = persisted.get(key);
      let rec;
      let needsGeneration = false;
      if (file) {
        persisted.delete(key);
        rec = {
          ...base,
          id: file.id,
          askedAt: file.askedAt,
          snapshot: file.snapshot,
          briefStatus: file.briefStatus === "pending" ? "failed" : file.briefStatus,
          // interrupted attempt = the one attempt
          ...file.brief !== void 0 ? { brief: file.brief } : {},
          ...file.briefLabel ? { briefLabel: file.briefLabel } : {}
        };
        if (file.briefStatus === "pending") persist(rec);
      } else {
        const snapshot = buildQuestionSnapshot({ eventStore: deps.eventStore, sessionId, ...metadata ? { metadata } : {} });
        const decision = decideBriefPolicy({ message: metadata?.message, ...deps.config() });
        rec = { ...base, id: newId(), askedAt: now(), snapshot, briefStatus: "pending" };
        if (decision.kind === "provided") {
          rec.briefStatus = "provided";
          rec.brief = decision.brief;
          rec.briefLabel = "provided";
        } else if (decision.kind === "disabled") {
          rec.briefStatus = "unavailable";
        } else if (rec.origin === "file") {
          rec.briefStatus = "unavailable";
        } else {
          needsGeneration = true;
        }
        persist(rec);
      }
      byKey.set(key, rec);
      byId.set(rec.id, rec);
      emit({ kind: "added", id: rec.id, sessionId });
      if (needsGeneration) {
        runGeneration(rec, "auto").catch((err) => console.warn(`[questions] auto brief generation failed for ${rec.id}:`, err?.message ?? err));
      }
      return rec;
    },
    removeQuestion(sessionId, promptId, _reason) {
      const key = keyOf(sessionId, promptId);
      dropPersisted(key);
      const rec = byKey.get(key);
      if (!rec) return false;
      dropRecord(rec);
      return true;
    },
    reconcileSession(sessionId, keepPromptIds) {
      const keep = new Set(keepPromptIds);
      dropAll([...byKey.values()].filter((rec) => rec.sessionId === sessionId && !keep.has(rec.promptId)));
      for (const [key, file] of [...persisted]) {
        if (file.sessionId === sessionId && !keep.has(file.promptId)) dropPersisted(key);
      }
    },
    removeQuestionsForSession(sessionId, _reason) {
      dropAll([...byKey.values()].filter((rec) => rec.sessionId === sessionId));
      for (const [key, file] of [...persisted]) if (file.sessionId === sessionId) dropPersisted(key);
    },
    get: (id) => byId.get(id),
    getDetail(id) {
      const rec = byId.get(id);
      return rec ? detailOf(rec) : void 0;
    },
    listRows(isVisible) {
      return [...byId.values()].filter((r) => r.claim !== "transmitted" && (!isVisible || isVisible(r.sessionId))).sort((a, b) => b.askedAt - a.askedAt).map(rowOf);
    },
    lookup(id) {
      const rec = byId.get(id);
      if (rec) {
        if (rec.claim !== "transmitted") return { state: "open", record: rec };
        return now() - (rec.transmittedAt ?? 0) < TRANSMITTED_WINDOW_MS ? { state: "answered", sessionId: rec.sessionId } : { state: "unknown" };
      }
      const t = answeredRecently(id);
      return t ? { state: "answered", sessionId: t.sessionId } : { state: "unknown" };
    },
    claim,
    claimPrompt(sessionId, promptId) {
      const rec = byKey.get(keyOf(sessionId, promptId));
      return rec && rec.origin !== "file" ? claim(rec.id) : { status: "unknown" };
    },
    releaseClaim(id) {
      const rec = byId.get(id);
      if (rec?.claim === "claimed") rec.claim = void 0;
    },
    markTransmitted(id) {
      const rec = byId.get(id);
      if (!rec) return;
      rec.claim = "transmitted";
      rec.transmittedAt = now();
      sweepTombstones();
      tombstones.set(id, { at: rec.transmittedAt, sessionId: rec.sessionId });
      emit({ kind: "hidden", id, sessionId: rec.sessionId });
    },
    async summarize(id) {
      const rec = byId.get(id);
      if (!rec) return { ok: false, reason: "not-found", error: "question not found" };
      if (rec.origin === "file") return { ok: false, reason: "unavailable", error: "file-access prompts are not summarised" };
      if (rec.briefStatus === "ready" && rec.briefLabel !== "provided") {
        return { ok: false, reason: "already-generated", error: "brief is already generated" };
      }
      const outcome = await runGeneration(rec, "on-demand");
      if (outcome.ok) return { ok: true, detail: detailOf(rec) };
      return { ok: false, reason: outcome.kind, error: outcome.reason };
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loadPersisted() {
      for (const file of deps.files.loadAll()) persisted.set(keyOf(file.sessionId, file.promptId), file);
    },
    sweepAtBoot(presence) {
      const deleted = deps.files.sweep(presence);
      const gone = new Set(deleted);
      for (const [key, file] of [...persisted]) if (gone.has(file.id)) persisted.delete(key);
      return deleted;
    },
    getStats() {
      sweepTombstones();
      return {
        open: [...byId.values()].filter((r) => r.claim !== "transmitted").length,
        hidden: [...byId.values()].filter((r) => r.claim === "transmitted").length,
        persistedUnbound: persisted.size,
        transmittedWindow: tombstones.size,
        briefs: deps.briefs.stats()
      };
    }
  };
}
export {
  TRANSMITTED_WINDOW_MS,
  createQuestionStore
};
