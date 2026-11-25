import { provideFlowsActions } from "./automation-actions.js";
import { readFlowInputs } from "./flow-inputs.js";
import { registerFlowFileRoutes } from "./flow-files.js";
import { renderSessionFlowActions } from "./render-actions.js";
import { stateStore } from "./state-store.js";
const PLUGIN_ID = "flows";
function makeFlowsForCwd(sessionManager, store) {
  return (cwd) => {
    const sessions = sessionManager.listActive();
    const ids = /* @__PURE__ */ new Set();
    for (const s of sessions) {
      if (!s || typeof s.id !== "string" || s.cwd !== cwd) continue;
      const flows = store.getState(s.id)?.flows;
      if (!flows) continue;
      for (const f of flows) {
        if (f && typeof f.name === "string") ids.add(f.name);
      }
    }
    return [...ids].sort();
  };
}
async function registerPlugin(ctx) {
  const { logger, broadcastToSubscribers, registerBrowserHandler, emitEventToSession, sendToSession } = ctx;
  logger.info("flows-plugin server entry activated (server-driven intents)");
  const flowsForCwd = makeFlowsForCwd(ctx.sessionManager, stateStore);
  provideFlowsActions((name, value) => ctx.provide(name, value), (m) => logger.info(m), flowsForCwd);
  ctx.fastify.get("/api/plugins/flows/flow-inputs", async (req) => {
    const q = req.query ?? {};
    const cwd = typeof q.cwd === "string" ? q.cwd : process.cwd();
    const flow = typeof q.flow === "string" ? q.flow : "";
    return { inputs: flow ? readFlowInputs(cwd, flow) : [] };
  });
  await registerFlowFileRoutes({
    fastify: ctx.fastify,
    networkGuard: ctx.networkGuard,
    registerPiRequestHandler: ctx.registerPiRequestHandler,
    sessionManager: ctx.sessionManager,
    emitEventToSession
  });
  function publishSessionFlowActions(sessionId) {
    const state = stateStore.getState(sessionId);
    const intent = renderSessionFlowActions(state ?? { flows: [], commands: [] });
    broadcastToSubscribers({
      type: "plugin_intents",
      pluginId: PLUGIN_ID,
      sessionId,
      slot: "session-card-action-bar",
      intent
    });
  }
  registerBrowserHandler("plugin_action", (msg) => {
    const m = msg;
    if (m.pluginId !== PLUGIN_ID) return;
    if (!m.sessionId) {
      logger.warn(`flows ${m.action ?? "(no action)"}: missing sessionId`);
      return;
    }
    const payload = m.payload ?? {};
    switch (m.action) {
      case "flow.run": {
        const flowName = String(payload.flow ?? payload.flowName ?? "").trim();
        if (!flowName) {
          logger.warn(`flow.run from session=${m.sessionId}: missing flow name`);
          return;
        }
        const task = typeof payload.task === "string" ? payload.task.trim() : "";
        if (payload.inputs !== void 0 && (payload.inputs === null || typeof payload.inputs !== "object" || Array.isArray(payload.inputs))) {
          logger.warn(`flow.run session=${m.sessionId}: invalid inputs (expected object)`);
          return;
        }
        const inputs = payload.inputs;
        const data = { flowName };
        if (task) data.task = task;
        if (inputs) data.inputs = inputs;
        const delivered = emitEventToSession(m.sessionId, "flow:run", data);
        logger.info(`flow.run "${flowName}" session=${m.sessionId} delivered=${delivered}`);
        break;
      }
      case "flow.new": {
        const instruction = typeof payload.instruction === "string" ? payload.instruction.trim() : "";
        const command = instruction ? `/skill:manage-flows ${instruction}` : "/skill:manage-flows";
        const delivered = sendToSession(m.sessionId, command);
        logger.info(`flow.new session=${m.sessionId} delivered=${delivered}`);
        break;
      }
      default:
        logger.warn(`unknown flows action: ${m.action}`);
    }
  });
  logger.info("flows-plugin: server entry active. Event-stream subscription deferred to follow-up.");
  void publishSessionFlowActions;
}
var stdin_default = registerPlugin;
export {
  stdin_default as default,
  makeFlowsForCwd,
  registerPlugin
};
