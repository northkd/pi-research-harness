import { parseSessionUpdate } from "./update-model.mjs";
const CHUNK_KIND = {
  user_message_chunk: "user",
  agent_message_chunk: "agent",
  agent_thought_chunk: "thought"
};
const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function createV1Normalizer() {
  let runKind = null;
  let runSeq = 0;
  let runId = "";
  const state = (s) => {
    runKind = null;
    return [{ kind: "state_update", state: s }];
  };
  const chunk = (raw, kind) => {
    let messageId = typeof raw.messageId === "string" ? raw.messageId : void 0;
    if (messageId === void 0) {
      if (runKind !== kind) {
        runSeq += 1;
        runId = `acp-v1-${kind}-${runSeq}`;
      }
      messageId = runId;
    }
    runKind = kind;
    return [parseSessionUpdate({ ...raw, messageId })];
  };
  const toolCall = (raw) => {
    runKind = null;
    return [parseSessionUpdate({ ...raw, sessionUpdate: "tool_call_update" })];
  };
  return {
    update(raw) {
      if (!isRec(raw) || typeof raw.sessionUpdate !== "string") return [parseSessionUpdate(raw)];
      const tag = raw.sessionUpdate;
      const chunkKind = CHUNK_KIND[tag];
      if (chunkKind) return chunk(raw, chunkKind);
      if (tag === "tool_call" || tag === "tool_call_update") return toolCall(raw);
      if (tag === "plan") return [parseSessionUpdate({ sessionUpdate: "plan_update", plan: { type: "items", planId: "default", entries: raw.entries } })];
      if (tag === "current_mode_update") return [parseSessionUpdate(modeAsConfigOption(raw.currentModeId))];
      return [parseSessionUpdate(raw)];
    },
    promptDispatched: () => state("running"),
    permissionRequested: () => state("requires_action"),
    permissionAnswered: () => state("running"),
    promptResolved(stopReason) {
      runKind = null;
      return [{ kind: "state_update", state: "idle", stopReason: stopReason ?? null }];
    }
  };
}
const modeAsConfigOption = (currentModeId) => ({
  sessionUpdate: "config_option_update",
  configOptions: [{ configId: "mode", name: "Mode", category: "mode", type: "select", currentValue: currentModeId }]
});
export {
  createV1Normalizer
};
