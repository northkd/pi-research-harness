const POISON_K = 2;
const BREAKER_COUNT = 3;
const BREAKER_WINDOW_MS = 5 * 6e4;
const RESPAWN_BACKOFF_MS = [5e3, 15e3, 45e3];
const TERMINAL = /* @__PURE__ */ new Set([
  "achieved",
  "cleared",
  "failed"
]);
function createGoalSupervisor(deps) {
  const { store } = deps;
  const now = deps.now ?? (() => Date.now());
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((t) => clearTimeout(t));
  const log = deps.log ?? (() => {
  });
  const headlessAvailable = deps.headlessAvailable ?? (() => true);
  const timers = /* @__PURE__ */ new Map();
  const chain = /* @__PURE__ */ new Map();
  const goalLocks = /* @__PURE__ */ new Map();
  function withGoalLock(goalId, fn) {
    const prev = goalLocks.get(goalId) ?? Promise.resolve();
    const next = prev.catch(() => {
    }).then(fn);
    goalLocks.set(goalId, next);
    void next.catch(() => {
    }).finally(() => {
      if (goalLocks.get(goalId) === next) goalLocks.delete(goalId);
    });
    return next;
  }
  function breakerCount(goal, includeCurrentNoProgress) {
    const epoch = goal.lastProgressAt ?? 0;
    const cutoff = now() - BREAKER_WINDOW_MS;
    let n = includeCurrentNoProgress ? 1 : 0;
    for (const r of goal.respawns ?? []) {
      if (!r.madeProgress && r.at > epoch && r.at >= cutoff) n++;
    }
    return n;
  }
  function consecutiveNoProgressResumes(goal) {
    let n = 0;
    const list = goal.respawns ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const r = list[i];
      if (r.madeProgress) break;
      if (r.reason !== "resume") break;
      n++;
    }
    return n;
  }
  function consecutiveNoProgress(goal) {
    let n = 0;
    const list = goal.respawns ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].madeProgress) break;
      n++;
    }
    return n;
  }
  function backoffFor(consecutive) {
    const idx = Math.min(Math.max(0, consecutive - 1), RESPAWN_BACKOFF_MS.length - 1);
    return RESPAWN_BACKOFF_MS[idx];
  }
  async function findCurrentDriverGoal(sessionId) {
    const all = await store.listAll();
    for (const g of all) {
      if (g.driverSessionId === sessionId) return g;
    }
    return null;
  }
  async function handleDeath(sessionId) {
    const found = await findCurrentDriverGoal(sessionId);
    if (!found) return;
    await withGoalLock(found.id, async () => {
      const goal = (await store.list(found.cwd)).find((g) => g.id === found.id);
      if (!goal || goal.driverSessionId !== sessionId) return;
      await classifyDeath(goal, sessionId);
    });
  }
  async function classifyDeath(goal, sessionId) {
    if (TERMINAL.has(goal.status) || goal.status === "paused") {
      return;
    }
    const baseline = goal.currentDriverBaselineTurns;
    const total = goal.totalTurnsUsed ?? 0;
    const known = baseline !== void 0;
    const madeProgress = known ? total > baseline : false;
    const countsAgainstBreaker = known && !madeProgress;
    if (!goal.autoRespawn) {
      await store.setStatus(goal.cwd, goal.id, "paused", "session ended");
      log("[goal-supervisor] driver ended; autoRespawn off \u2192 paused", { goalId: goal.id });
      return;
    }
    if (!headlessAvailable()) {
      await store.setStatus(goal.cwd, goal.id, "paused", "headless unavailable");
      log("[goal-supervisor] headless RPC unavailable \u2192 auto-respawn disabled", { goalId: goal.id });
      return;
    }
    if (breakerCount(goal, countsAgainstBreaker) >= BREAKER_COUNT) {
      await store.setStatus(goal.cwd, goal.id, "failed", "crash loop");
      log("[goal-supervisor] crash-loop breaker tripped \u2192 failed", {
        goalId: goal.id,
        deaths: breakerCount(goal, countsAgainstBreaker)
      });
      return;
    }
    const poisoned = consecutiveNoProgressResumes(goal) >= POISON_K;
    const sessionFile = poisoned ? void 0 : deps.resolveSessionFile(sessionId);
    const reason = poisoned || !sessionFile ? "fresh" : "resume";
    const respawn = { at: now(), sessionId, reason, madeProgress };
    await store.recordRespawn(goal.cwd, goal.id, respawn);
    await store.setStatus(goal.cwd, goal.id, "respawning");
    const updated = (await store.list(goal.cwd)).find((g) => g.id === goal.id) ?? goal;
    const backoff = madeProgress ? 0 : backoffFor(consecutiveNoProgress(updated));
    const generationAtSchedule = updated.generation ?? 0;
    log("[goal-supervisor] scheduling respawn", {
      goalId: goal.id,
      reason,
      madeProgress,
      backoffMs: backoff
    });
    const timer = setTimer(() => {
      timers.delete(goal.id);
      return withGoalLock(
        goal.id,
        () => performSpawn(goal.id, goal.cwd, reason, sessionFile, generationAtSchedule)
      ).catch((err) => log("[goal-supervisor] performSpawn failed", { goalId: goal.id, err: String(err) }));
    }, backoff);
    timers.set(goal.id, timer);
  }
  async function performSpawn(goalId, cwd, reason, sessionFile, generationAtSchedule) {
    const goal = (await store.list(cwd)).find((g) => g.id === goalId);
    if (!goal) return;
    if ((goal.generation ?? 0) !== generationAtSchedule) {
      log("[goal-supervisor] respawn cancelled (generation changed)", { goalId });
      return;
    }
    if (TERMINAL.has(goal.status) || goal.status === "paused") return;
    const spawnToken = deps.mintSpawnToken();
    await store.setInFlightSpawn(cwd, goalId, {
      spawnToken,
      generation: generationAtSchedule,
      startedAt: now()
    });
    const req = {
      cwd,
      goalId,
      reason,
      spawnToken,
      ...reason === "resume" && sessionFile ? { sessionFile } : {},
      ...reason === "fresh" ? { reprime: deps.buildReprime(goal) } : {}
    };
    let result;
    try {
      result = await deps.spawnDriver(req);
    } catch (err) {
      result = { success: false, message: err instanceof Error ? err.message : String(err) };
    }
    const after = (await store.list(cwd)).find((g) => g.id === goalId);
    if (!after || (after.generation ?? 0) !== generationAtSchedule) {
      log("[goal-supervisor] spawn completed under stale generation \u2192 killing", { goalId });
      await deps.killByToken(spawnToken);
      return;
    }
    if (!result.success) {
      await store.setInFlightSpawn(cwd, goalId, null);
      await store.setStatus(cwd, goalId, "paused", "restart failed");
      log("[goal-supervisor] respawn spawn failed \u2192 paused", { goalId, message: result.message });
      return;
    }
    log("[goal-supervisor] respawn spawned", { goalId, reason });
  }
  function abort(cwd, goalId, terminal) {
    return withGoalLock(goalId, () => abortLocked(cwd, goalId, terminal));
  }
  async function abortLocked(cwd, goalId, terminal) {
    const before = (await store.list(cwd)).find((g) => g.id === goalId);
    const finalized = await store.finalize(cwd, goalId, {
      status: terminal.status,
      ...terminal.reason !== void 0 ? { statusReason: terminal.reason } : {},
      clearInFlightSpawn: true
    });
    const t = timers.get(goalId);
    if (t) {
      clearTimer(t);
      timers.delete(goalId);
    }
    const token = before?.inFlightSpawn?.spawnToken;
    let killed = false;
    if (token) killed = await deps.killByToken(token);
    if (!killed && finalized.driverSessionId) {
      killed = await deps.killBySession(finalized.driverSessionId);
    }
    if (!killed && token) {
      log("[goal-supervisor] abort kill targeted nothing (in-flight token)", { goalId });
    }
    log("[goal-supervisor] aborted", { goalId, status: terminal.status });
  }
  async function reconcileOnBoot() {
    const all = await store.listAll();
    for (const goal of all) {
      if (goal.status !== "pursuing" && goal.status !== "respawning") continue;
      if (goal.driverSessionId && deps.isSessionLive(goal.driverSessionId)) continue;
      if (goal.inFlightSpawn) {
        log("[goal-supervisor] boot reconcile: in-flight spawn pending, skipping", { goalId: goal.id });
        continue;
      }
      if (goal.driverSessionId) {
        log("[goal-supervisor] boot reconcile: orphaned driver \u2192 classify", { goalId: goal.id });
        await handleDeath(goal.driverSessionId).catch(
          (err) => log("[goal-supervisor] boot reconcile classify failed", { goalId: goal.id, err: String(err) })
        );
      }
    }
  }
  function onDriverDeath(sessionId) {
    const prev = chain.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => {
    }).then(() => handleDeath(sessionId)).catch((err) => log("[goal-supervisor] death handling failed", { sessionId, err: String(err) }));
    chain.set(sessionId, next);
    void next.finally(() => {
      if (chain.get(sessionId) === next) chain.delete(sessionId);
    });
    return next;
  }
  return {
    onDriverDeath,
    abort,
    reconcileOnBoot,
    pendingTimers: () => timers.size,
    dispose() {
      for (const t of timers.values()) clearTimer(t);
      timers.clear();
      chain.clear();
      goalLocks.clear();
    }
  };
}
export {
  BREAKER_COUNT,
  BREAKER_WINDOW_MS,
  POISON_K,
  RESPAWN_BACKOFF_MS,
  createGoalSupervisor
};
