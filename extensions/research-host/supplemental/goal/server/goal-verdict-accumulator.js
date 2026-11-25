function verdictKind(status) {
  if (status === "paused") return "paused";
  if (status === "done") return "satisfied";
  return "continue";
}
function createGoalVerdictAccumulator(deps) {
  const { store, lookupSession } = deps;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? ((m, e) => console.warn(m, e));
  const lastSeen = /* @__PURE__ */ new Map();
  function handle(msg) {
    const m = msg;
    if (!m.sessionId || !m.payload || typeof m.payload.status !== "string") return;
    if (typeof m.payload.turnsUsed !== "number" || !Number.isFinite(m.payload.turnsUsed)) return;
    const { sessionId, payload } = m;
    if (payload.status === "cleared") {
      lastSeen.delete(sessionId);
      return;
    }
    const link = lookupSession(sessionId);
    if (!link?.goalId || !link.cwd) return;
    const prev = lastSeen.get(sessionId);
    const advanced = !prev || payload.turnsUsed > prev.turnsUsed || payload.lastVerdict !== prev.lastVerdict;
    if (!advanced) return;
    lastSeen.set(sessionId, { turnsUsed: payload.turnsUsed, lastVerdict: payload.lastVerdict });
    const verdict = {
      turn: payload.turnsUsed,
      at: now(),
      verdict: verdictKind(payload.status),
      ...payload.lastVerdict ? { note: payload.lastVerdict } : payload.lastReason ? { note: payload.lastReason } : {}
    };
    store.appendVerdict(link.cwd, link.goalId, verdict).catch((err) => {
      warn(`[goal-verdict-accumulator] failed to append verdict for goal ${link.goalId}:`, err);
    });
  }
  return { handle };
}
export {
  createGoalVerdictAccumulator
};
