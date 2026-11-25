function mapStatus(status) {
  switch (status) {
    case "active":
      return "pursuing";
    case "paused":
      return "paused";
    case "done":
      return "achieved";
    case "cleared":
      return "cleared";
    default:
      return null;
  }
}
function createGoalStatusProjector(deps) {
  const { store, lookupSession } = deps;
  const warn = deps.warn ?? ((m, e) => console.warn(m, e));
  const perDriver = /* @__PURE__ */ new Map();
  function parse(msg) {
    const m = msg;
    if (!m.sessionId || !m.payload || typeof m.payload.status !== "string") return null;
    const turnsUsed = m.payload.turnsUsed;
    if (typeof turnsUsed !== "number" || !Number.isFinite(turnsUsed)) return null;
    const mapped = mapStatus(m.payload.status);
    if (mapped === null) return null;
    return { sessionId: m.sessionId, mapped, turnsUsed };
  }
  function handle(msg) {
    const parsed = parse(msg);
    if (!parsed) return;
    const { sessionId, mapped, turnsUsed } = parsed;
    const link = lookupSession(sessionId);
    if (!link?.goalId || !link.cwd) return;
    const prev = perDriver.get(sessionId);
    const prevTurns = prev?.turnsUsed ?? 0;
    const turnsDelta = Math.max(0, turnsUsed - prevTurns);
    const progressed = turnsUsed > prevTurns;
    const statusChanged = prev?.status !== mapped;
    const turnsChanged = !prev || turnsUsed !== prev.turnsUsed;
    perDriver.set(sessionId, { status: mapped, turnsUsed });
    if (!statusChanged && !turnsChanged) return;
    store.applyStatus(link.cwd, link.goalId, {
      status: mapped,
      lastKnownTurnsUsed: turnsUsed,
      turnsDelta,
      progressed
    }).catch((err) => {
      warn(`[goal-status-projector] failed to project status for goal ${link.goalId}:`, err);
    });
  }
  return { handle };
}
export {
  createGoalStatusProjector
};
