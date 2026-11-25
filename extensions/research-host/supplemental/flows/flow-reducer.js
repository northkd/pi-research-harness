function stepTypeToNodeKind(stepType) {
  switch (stepType) {
    case "agent":
    case "agent-decision":
    case "code":
    case "code-decision":
    case "fork":
      return stepType;
    default:
      return void 0;
  }
}
function isCardableNonAgentKind(nodeKind) {
  return nodeKind === "code" || nodeKind === "code-decision";
}
function extractToolInputPreview(toolName, input) {
  if (!input || typeof input !== "object") return "";
  const inp = input;
  switch (toolName.toLowerCase()) {
    case "read":
    case "write":
    case "edit":
      return String(inp.file_path || inp.path || "").split("/").pop() || "";
    case "grep":
      return String(inp.pattern || "").slice(0, 20);
    case "bash":
      return String(inp.command || "").slice(0, 20);
    case "flow_write":
      return String(inp.name || "");
    default:
      return JSON.stringify(input).slice(0, 20);
  }
}
function findAgent(agents, nameOrStepId, stepId) {
  if (agents.has(nameOrStepId)) return [nameOrStepId, agents.get(nameOrStepId)];
  if (stepId && agents.has(stepId)) return [stepId, agents.get(stepId)];
  for (const [key, agent] of agents) {
    if (agent.agentName === nameOrStepId) return [key, agent];
  }
  for (const [key, agent] of agents) {
    if (agent.stepId === nameOrStepId) return [key, agent];
  }
  return [void 0, void 0];
}
function isFlowEvent(eventType) {
  return eventType.startsWith("flow_");
}
function reduceFlowEvent(flowState, event) {
  const data = event.data;
  switch (event.eventType) {
    case "flow_started": {
      const steps = data.steps;
      const agents = /* @__PURE__ */ new Map();
      if (steps) {
        for (const step of steps) {
          const nodeKind = stepTypeToNodeKind(step.stepType);
          if (step.agent || isCardableNonAgentKind(nodeKind)) {
            agents.set(step.id, {
              agentName: step.agent || step.id,
              stepId: step.id,
              stepType: step.stepType,
              nodeKind,
              status: "pending",
              blockedBy: step.blockedBy || [],
              recentTools: [],
              detailHistory: []
            });
          }
        }
      }
      const dagSteps = steps?.map((step) => ({
        id: step.id,
        stepType: step.stepType,
        agent: step.agent,
        blockedBy: step.blockedBy || [],
        branches: step.branches,
        onComplete: step.onComplete,
        onError: step.onError
      }));
      return {
        flowName: data.flowName,
        task: data.task || "",
        status: "running",
        autonomousMode: data.autonomousMode || false,
        flowSource: data.source || void 0,
        agents,
        dagSteps
      };
    }
    case "flow_agent_started": {
      if (!flowState) return null;
      const agentName = data.agentName;
      const stepId = data.stepId || agentName;
      const config = data.config;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, agentName, stepId);
      const mapKey = key || stepId;
      const isRerun = existing && (existing.status === "complete" || existing.status === "error" || existing.status === "blocked");
      agents.set(mapKey, {
        ...existing || {
          agentName,
          stepId,
          blockedBy: [],
          recentTools: [],
          detailHistory: []
        },
        ...isRerun ? { recentTools: [], detailHistory: [] } : {},
        status: "running",
        // nodeKind is decided ONCE here at started (surface-node-kind contract).
        // Fall back to the provisional kind from flow_started, else "agent".
        nodeKind: data.nodeKind ?? existing?.nodeKind ?? "agent",
        // Resolved handler target for code / code-decision nodes (started only).
        codeTarget: data.target ?? existing?.codeTarget,
        label: config?.card?.label,
        model: config?.model,
        resolvedModel: data.resolvedModel || void 0,
        cardRole: config?.card?.role,
        sourcePath: config?.sourcePath,
        runCount: isRerun ? (existing.runCount ?? 1) + 1 : existing?.runCount ?? 1
      });
      return { ...flowState, agents };
    }
    case "flow_agent_complete": {
      if (!flowState) return null;
      const agentName = data.agentName;
      const stepId = data.stepId;
      const result = data.result;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, agentName, stepId);
      if (key && existing) {
        const typedOutputs = result?.typedOutputs;
        const outcome = result?.outcome ?? data.outcome ?? (result?.success ? "success" : "soft");
        agents.set(key, {
          ...existing,
          status: result?.status === "blocked" ? "blocked" : result?.success ? "complete" : "error",
          tokens: result?.tokens,
          cost: result?.cost,
          duration: result?.duration,
          summary: result?.summary,
          files: result?.files,
          outcome,
          typedOutputs,
          // code-decision exposes the chosen branch via typedOutputs.branch.
          branch: typedOutputs?.branch ?? data.branch ?? existing.branch
        });
      }
      return { ...flowState, agents };
    }
    case "flow_tool_call": {
      if (!flowState) return null;
      const agentName = data.agentName;
      const stepId = data.stepId;
      const toolName = data.toolName;
      const input = data.input;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, agentName, stepId);
      if (key && existing) {
        const preview = extractToolInputPreview(toolName, input);
        const recentTools = [
          ...existing.recentTools,
          { toolName, inputPreview: preview }
        ].slice(-3);
        const detailHistory = [
          ...existing.detailHistory,
          { kind: "tool", toolName, input, isError: false }
        ];
        agents.set(key, { ...existing, recentTools, detailHistory });
      }
      return { ...flowState, agents };
    }
    case "flow_tool_result": {
      if (!flowState) return null;
      const agentName = data.agentName;
      const stepId = data.stepId;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, agentName, stepId);
      if (key && existing) {
        const detailHistory = [...existing.detailHistory];
        for (let i = detailHistory.length - 1; i >= 0; i--) {
          const entry = detailHistory[i];
          if (entry.kind === "tool" && entry.output === void 0) {
            detailHistory[i] = {
              ...entry,
              output: data.output,
              isError: data.isError || false
            };
            break;
          }
        }
        agents.set(key, { ...existing, detailHistory });
      }
      return { ...flowState, agents };
    }
    case "flow_assistant_text": {
      if (!flowState) return null;
      const agentName = data.agentName;
      const stepId = data.stepId;
      const text = data.text;
      if (!text) return flowState;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, agentName, stepId);
      if (key && existing) {
        const detailHistory = [
          ...existing.detailHistory,
          { kind: "text", text }
        ];
        agents.set(key, { ...existing, detailHistory });
      }
      return { ...flowState, agents };
    }
    case "flow_thinking_text": {
      if (!flowState) return null;
      const agentName = data.agentName;
      const stepId = data.stepId;
      const text = data.text;
      if (!text) return flowState;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, agentName, stepId);
      if (key && existing) {
        const detailHistory = [
          ...existing.detailHistory,
          { kind: "thinking", text }
        ];
        agents.set(key, { ...existing, detailHistory });
      }
      return { ...flowState, agents };
    }
    case "flow_agent_error": {
      if (!flowState) return null;
      const agentName = data.agentName;
      const stepId = data.stepId;
      const text = data.text;
      if (!text) return flowState;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, agentName, stepId);
      if (key && existing) {
        const detailHistory = [
          ...existing.detailHistory,
          { kind: "error", text }
        ];
        agents.set(key, { ...existing, detailHistory });
      }
      return { ...flowState, agents };
    }
    case "flow_loop_iteration": {
      if (!flowState) return null;
      const loopTarget = data.loopTarget;
      const iteration = data.iteration;
      const maxIterations = data.maxIterations;
      if (!loopTarget) return flowState;
      const agents = new Map(flowState.agents);
      const [key, existing] = findAgent(agents, loopTarget);
      if (key && existing) {
        agents.set(key, {
          ...existing,
          loopIteration: iteration,
          loopMax: maxIterations
        });
      }
      return { ...flowState, agents };
    }
    case "flow_auto_decision": {
      return flowState;
    }
    case "flow_complete": {
      if (!flowState) return null;
      if (data.status === "rejected") return flowState;
      const status = data.status || "success";
      let agents = flowState.agents;
      if (status !== "success") {
        agents = new Map(flowState.agents);
        for (const [k, a] of agents) {
          if (a.status === "running" || a.status === "pending") {
            agents.set(k, { ...a, status: "error", outcome: a.outcome ?? "hard" });
          }
        }
      }
      return {
        ...flowState,
        status,
        agents,
        flowResult: data
      };
    }
    case "flow_summary_ready": {
      if (!flowState) return null;
      return {
        ...flowState,
        nextStep: data.nextStep ?? null,
        summaryStats: data.stats
      };
    }
    case "flow_summary_dismissed": {
      return null;
    }
    case "flow_autonomous_changed": {
      if (!flowState) return null;
      return {
        ...flowState,
        autonomousMode: data.enabled ?? flowState.autonomousMode
      };
    }
    default:
      return flowState;
  }
}
export {
  isFlowEvent,
  reduceFlowEvent
};
