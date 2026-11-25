const ACTION_CONTRIBUTION_KEY = "automation.action.flows";
const FLOW_ID_RE = /^[\w.-]+:[\w.-]+$/;
function normalizeInputs(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return void 0;
  const obj = raw;
  return Object.keys(obj).length > 0 ? obj : void 0;
}
function summarizeFlowResult(data) {
  const d = data;
  const summary = d?.lastResult?.result?.summary;
  return `flow ${d?.flowName ?? ""} ${d?.status ?? "finished"}${summary ? `: ${summary}` : ""}`.replace(/\s+/g, " ").trim();
}
function flowsActionContributions(flowsForCwd) {
  const hasFlows = (cwd) => flowsForCwd(cwd).length > 0;
  return [
    {
      id: "flows.run",
      source: "flows",
      label: "Run a flow",
      description: "Run a flow with a task.",
      available: hasFlows,
      unavailableReason: "no flows in this folder (no running session, or the session reports no flows)",
      payloadSchema: [
        { key: "flow", label: "Flow", type: "enum", options: flowsForCwd, help: "Flows reported by the running session for this folder" },
        { key: "task", label: "Task", type: "multiline", help: "Passed as the flow's initial task." }
      ],
      // Emit flow:run into the run session (the event pi-flows listens for),
      // not a slash-command prompt. A flows.run run produces NO agent turn in
      // the host session (pi-flows consumes flow:run headlessly), so it emits
      // no `agent_end`. Declare `completion` so the automation engine finalizes
      // it on the forwarded `flow_complete` event instead (the extension's
      // FLOW_EVENT_MAP forwards pi-flows' `flow:complete` → `flow_complete`).
      // All flows knowledge — the event name and the FlowResult shape — stays
      // here; the automation plugin stays generic.
      //
      // `payload` is already per-fire interpolated by the engine (the
      // `${{trigger}}` token in `payload.inputs` is resolved to the fired
      // value, type preserved). We forward `payload.inputs` as `data.inputs`,
      // which pi-flows consumes as `flowInput` → `${{flow.input.<name>}}`.
      // `task` stays optional and may coexist with `inputs`.
      // See change: finalize-event-dispatched-automation-runs, wire-flow-inputs-in-automation.
      emits: ["flow:run"],
      buildEvent: ({ payload }) => {
        const flow = String(payload.flow ?? "").trim();
        if (!FLOW_ID_RE.test(flow)) return null;
        const task = String(payload.task ?? "").trim();
        const inputs = normalizeInputs(payload.inputs);
        const data = { flowName: flow };
        if (task) data.task = task;
        if (inputs) data.inputs = inputs;
        return {
          eventType: "flow:run",
          data,
          completion: { eventType: "flow_complete", summarize: summarizeFlowResult }
        };
      }
    }
  ];
}
function provideFlowsActions(provide, log, flowsForCwd) {
  provide(ACTION_CONTRIBUTION_KEY, flowsActionContributions(flowsForCwd));
  log("[flows] published automation action: flows.run");
}
export {
  ACTION_CONTRIBUTION_KEY,
  flowsActionContributions,
  provideFlowsActions,
  summarizeFlowResult
};
