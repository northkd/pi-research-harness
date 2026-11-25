import { randomUUID } from "node:crypto";
const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
function labelOptions(raw) {
  const out = [];
  const seen = /* @__PURE__ */ new Set();
  for (const [i, o] of (Array.isArray(raw) ? raw : []).entries()) {
    if (!isRec(o) || typeof o.optionId !== "string") continue;
    let label = typeof o.name === "string" && o.name !== "" ? o.name : o.optionId;
    if (seen.has(label)) label = `${label} (${i + 1})`;
    seen.add(label);
    out.push({ optionId: o.optionId, label });
  }
  return out;
}
function questionOf(params) {
  if (typeof params.title === "string" && params.title !== "") return params.title;
  const tool = params.toolCall;
  if (isRec(tool) && typeof tool.title === "string" && tool.title !== "") return tool.title;
  return "The agent requests permission";
}
function createPermissionBridge(sessionId, send, hooks = {}) {
  const pending = /* @__PURE__ */ new Map();
  return {
    request(raw) {
      const params = isRec(raw) ? raw : {};
      const options = labelOptions(params.options);
      if (options.length === 0) return Promise.resolve({ outcome: "cancelled" });
      const promptId = randomUUID();
      const question = questionOf(params);
      const frame = {
        type: "prompt_request",
        sessionId,
        promptId,
        prompt: { question, type: "select", options: options.map((o) => o.label), defaultValue: void 0, pipeline: "command", metadata: { source: "acp" } },
        component: { type: "generic-dialog", props: { question, type: "select", options: options.map((o) => o.label), defaultValue: void 0 } },
        placement: "inline"
      };
      return new Promise((resolve) => {
        pending.set(promptId, { frame, options, resolve });
        send(frame);
      });
    },
    respond(promptId, answer, cancelled) {
      const p = pending.get(promptId);
      if (!p) return false;
      pending.delete(promptId);
      const chosen = cancelled ? void 0 : p.options.find((o) => o.label === answer);
      p.resolve(chosen ? { outcome: "selected", optionId: chosen.optionId } : { outcome: "cancelled" });
      hooks.onAnswered?.();
      return true;
    },
    cancelAll() {
      for (const [promptId, p] of pending) {
        p.resolve({ outcome: "cancelled" });
        send({ type: "prompt_cancel", sessionId, promptId });
      }
      pending.clear();
    },
    resend(resyncRequestId) {
      for (const p of pending.values()) send({ ...p.frame, ...resyncRequestId ? { __resyncRequestId: resyncRequestId } : {} });
    },
    hasPending: () => pending.size > 0
  };
}
export {
  createPermissionBridge
};
