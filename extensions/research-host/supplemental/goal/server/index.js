import {
  GOAL_PLUGIN_ID,
  GOAL_STATUS_MESSAGE,
  GOAL_STATUS_EVENT_TYPE
} from "../shared/goal-types.js";
import {
  probeGoalCommandSurface,
  goalConfigCommand
} from "./probe.js";
import { createGoalStore } from "./goal-store.js";
import { createGoalSupervisor } from "./goal-supervisor.js";
import { createGoalVerdictAccumulator } from "./goal-verdict-accumulator.js";
import { createGoalStatusProjector } from "./goal-status-projector.js";
import { decorateGoalsWithSpend } from "./decorate-goals-spend.js";
import { buildGoalReprime, primeGoalSession } from "./goal-session-primer.js";
import { registerGoalRoutes } from "./routes.js";
function detectGoalCommandSurface() {
  return { acceptsSubgoal: true };
}
function goalCommandFor(action, payload, tier = "intent-only") {
  switch (action) {
    case "set": {
      const goal = typeof payload?.goal === "string" ? payload.goal.trim() : "";
      return goal ? `/goal ${goal}` : null;
    }
    case "subgoal": {
      const goal = typeof payload?.goal === "string" ? payload.goal.trim() : "";
      return goal ? `/subgoal ${goal}` : null;
    }
    case "pause":
    case "resume":
    case "done":
    case "clear":
      return `/goal ${action}`;
    case "config": {
      return goalConfigCommand(tier, {
        judge: payload?.judge
      });
    }
    default:
      return null;
  }
}
const GOAL_BOOT_RECONCILE_DELAY_MS = 3e4;
const GOAL_DRIVER_SCOPE = {
  extensionConfig: { "pi-dashboard": { askUserPromptTimeoutSeconds: "0" } }
};
async function registerPlugin(ctx) {
  const { logger, broadcastToSubscribers, registerPiHandler, registerBrowserHandler, sendToSession } = ctx;
  const commandTier = probeGoalCommandSurface(detectGoalCommandSurface());
  logger.info(`goal-plugin server entry activated (command tier: ${commandTier})`);
  const getSession = (id) => ctx.sessionManager.getSession(id);
  const store = createGoalStore({ dataDir: ctx.goalDataDir });
  const spendLookup = { get: (id) => getSession(id) };
  store.subscribe((cwd, payload) => {
    broadcastToSubscribers({ type: "goals_update", cwd, goals: decorateGoalsWithSpend(payload.goals, spendLookup) });
  });
  const lookupSession = (sessionId) => {
    const s = getSession(sessionId);
    return s ? { goalId: s.goalId, cwd: s.cwd } : null;
  };
  const accumulator = createGoalVerdictAccumulator({ store, lookupSession });
  registerPiHandler(GOAL_STATUS_MESSAGE, (msg) => accumulator.handle(msg));
  const statusProjector = createGoalStatusProjector({ store, lookupSession });
  registerPiHandler(GOAL_STATUS_MESSAGE, (msg) => statusProjector.handle(msg));
  const primeGoalSessionImpl = (sessionId, goal) => {
    primeGoalSession(
      {
        sendPrompt: (sid, text) => void sendToSession(sid, text),
        renameSession: (sid, name) => {
          ctx.renameSession(sid, name);
        }
      },
      sessionId,
      goal
    );
  };
  let goalSupervisor;
  registerGoalRoutes(ctx.fastify, {
    sessionManager: ctx.sessionManager,
    knownFolderCwds: ctx.consume("host.knownFolderCwds") ?? (() => []),
    networkGuard: ctx.networkGuard,
    store,
    // Stamp/clear goalId on a session: in-memory + .meta.json + broadcast —
    // the host capability with default persist (byte-identical to core's
    // inline block). See change: relocate-goal-product-to-plugin (D1-#5).
    applyGoalIdToSession: (sessionId, goalId) => {
      ctx.assignSessionRef(sessionId, { goalId: goalId ?? void 0 });
    },
    primeGoalSession: primeGoalSessionImpl,
    // Route clear/pause/delete through the supervisor (assigned just below,
    // before the server listens). See change: add-goal-session-supervisor.
    abortGoalSupervision: (cwd, goalId, terminal) => goalSupervisor ? goalSupervisor.abort(cwd, goalId, terminal) : Promise.resolve(),
    // Spawn a headless driver: the host hook files the `{ goalId }` ref
    // against the token under THIS plugin's id (`"goal"` — the same owner id
    // core used) and handles the pre-minted-token/initial-prompt/resume
    // mapping. See change: detach-automation-goal-from-core,
    // relocate-goal-product-to-plugin (D3).
    spawnGoalSession: async (cwd, goalId, opts) => {
      const result = await ctx.spawnSession({
        cwd,
        pluginRef: { goalId },
        lifecycle: { recover: false },
        scope: GOAL_DRIVER_SCOPE,
        ...opts?.model ? { model: opts.model } : {}
      });
      return { success: result.success, ...result.message ? { message: result.message } : {} };
    }
  });
  const spawnDriver = async (req) => {
    const result = await ctx.spawnSession({
      cwd: req.cwd,
      spawnToken: req.spawnToken,
      pluginRef: { goalId: req.goalId },
      lifecycle: { recover: false },
      scope: GOAL_DRIVER_SCOPE,
      ...req.reason === "resume" && req.sessionFile ? { resume: { sessionFile: req.sessionFile } } : {},
      ...req.reason === "fresh" && req.reprime ? { initialPrompt: req.reprime } : {}
    });
    return { success: result.success, ...result.message ? { message: result.message } : {} };
  };
  goalSupervisor = createGoalSupervisor({
    store,
    mintSpawnToken: () => ctx.mintSpawnToken(),
    isSessionLive: (sessionId) => {
      const s = getSession(sessionId);
      return !!s && s.status !== "ended";
    },
    resolveSessionFile: (sessionId) => getSession(sessionId)?.sessionFile,
    spawnDriver,
    // Token-first kill order preserved: killByToken then killBySession.
    // See change: relocate-goal-product-to-plugin (D1 supervisor deps map).
    killByToken: (token) => ctx.abortSpawnedRun({ spawnToken: token }),
    killBySession: (sessionId) => ctx.abortSpawnedRun({ sessionId }),
    buildReprime: (goal) => buildGoalReprime(goal),
    // Respawn spawns force strategy:"headless" (spawnDriver); the dashboard
    // always spawns headless, so RPC control is available. See change:
    // add-goal-session-supervisor (C2j).
    headlessAvailable: () => true,
    log: (msg, meta) => console.error(msg, meta ?? "")
  });
  const bootReconcileTimer = setTimeout(() => {
    goalSupervisor?.reconcileOnBoot().catch((err) => console.error("[goal-supervisor] boot reconcile failed", err));
  }, GOAL_BOOT_RECONCILE_DELAY_MS);
  bootReconcileTimer.unref?.();
  ctx.onSessionEnded((sessionId) => {
    void goalSupervisor?.onDriverDeath(sessionId);
  });
  ctx.onSessionResolved((sessionId, pluginRef) => {
    const goalId = pluginRef.goalId;
    if (typeof goalId !== "string" || !goalId) return;
    const session = getSession(sessionId);
    const cwd = session?.cwd;
    if (!cwd) return;
    store.list(cwd).then((goals) => {
      const goal = goals.find((g) => g.id === goalId);
      if (!goal) return;
      if (goal.driverSessionId === sessionId) return;
      const prevDriver = goal.driverSessionId;
      if (prevDriver && prevDriver !== sessionId) {
        ctx.assignSessionRef(prevDriver, { goalId: void 0 }, { persist: false });
      }
      return store.replaceDriver(cwd, goalId, sessionId);
    }).then((updated) => {
      if (!updated) return;
      if (updated.inFlightSpawn) {
        store.setInFlightSpawn(cwd, goalId, null).catch((err) => {
          logger.warn(`[goal-link] in-flight clear lost for ${goalId}:`, err);
        });
      }
      ctx.assignSessionRef(sessionId, { goalId });
      primeGoalSessionImpl(sessionId, updated);
    }).catch((err) => {
      logger.warn(`[goal-link] failed to link session ${sessionId} to goal ${goalId}:`, err);
    });
  });
  ctx.onShutdown(() => {
    clearTimeout(bootReconcileTimer);
    goalSupervisor?.dispose();
    store.dispose();
  });
  const snapshots = /* @__PURE__ */ new Map();
  function broadcastSnapshot(sessionId, snapshot) {
    broadcastToSubscribers({
      type: "plugin_event",
      pluginId: GOAL_PLUGIN_ID,
      sessionId,
      event: {
        eventType: GOAL_STATUS_EVENT_TYPE,
        timestamp: Date.now(),
        data: snapshot
      }
    });
  }
  registerPiHandler(GOAL_STATUS_MESSAGE, (msg) => {
    const m = msg;
    if (!m.sessionId || !m.payload || typeof m.payload.status !== "string") return;
    if (m.payload.status === "cleared") {
      snapshots.delete(m.sessionId);
    } else {
      snapshots.set(m.sessionId, m.payload);
    }
    broadcastSnapshot(m.sessionId, m.payload);
  });
  registerBrowserHandler("plugin_action", (msg) => {
    const m = msg;
    if (m.pluginId !== GOAL_PLUGIN_ID || !m.sessionId) return;
    if (commandTier === "intent-only") {
      logger.info(`goal action "${m.action}" suppressed (tier: intent-only)`);
      return;
    }
    const command = m.action ? goalCommandFor(m.action, m.payload, commandTier) : null;
    if (!command) {
      logger.warn(`unknown or malformed goal action: ${m.action}`);
      return;
    }
    const delivered = sendToSession(m.sessionId, command);
    logger.info(`goal action "${m.action}" \u2192 "${command}" session=${m.sessionId} delivered=${delivered}`);
  });
}
var stdin_default = registerPlugin;
export {
  stdin_default as default,
  goalCommandFor,
  registerPlugin
};
