import {
  applyUpdate,
  createAcpSessionState
} from "./update-model.mjs";
const STOP_MAP = {
  end_turn: { stopReason: "stop" },
  cancelled: { stopReason: "aborted" },
  max_tokens: { stopReason: "length" },
  max_turn_requests: { stopReason: "length" },
  refusal: { stopReason: "error", errorMessage: "Agent refused" }
};
function errorText(error) {
  const msg = error?.message;
  return typeof msg === "string" ? msg : "Agent error";
}
function mapStopReason(stopReason, error) {
  if (stopReason === void 0 || stopReason === null) return { stopReason: "stop" };
  if (stopReason === "error") return { stopReason: "error", errorMessage: errorText(error) };
  const known = Object.hasOwn(STOP_MAP, stopReason) ? STOP_MAP[stopReason] : void 0;
  return known ?? { stopReason: "stop", acpStopReason: stopReason };
}
function toPiBlock(b) {
  if (b.type === "text" && typeof b.text === "string") return { type: "text", text: b.text };
  if (b.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
    return { type: "image", data: b.data, mimeType: b.mimeType };
  }
  if (b.type !== "resource_link") return void 0;
  const label = typeof b.name === "string" ? b.name : typeof b.uri === "string" ? b.uri : "resource";
  return { type: "text", text: typeof b.uri === "string" ? `[${label}](${b.uri})` : label };
}
function toPiUserContent(blocks) {
  const out = [];
  for (const block of blocks) {
    const b = toPiBlock(block);
    const last = out.at(-1);
    if (b?.type === "text" && last?.type === "text") last.text = `${last.text}${b.text}`;
    else if (b) out.push(b);
  }
  return out;
}
function userMessageEvents(content, timestamp) {
  const blocks = typeof content === "string" ? [{ type: "text", text: content }] : toPiUserContent(content);
  const message = { role: "user", content: blocks, timestamp };
  return [
    { eventType: "message_start", timestamp, data: { message } },
    { eventType: "message_end", timestamp, data: { message } }
  ];
}
const textOf = (blocks) => blocks.map((b) => b.type === "text" && typeof b.text === "string" ? b.text : "").join("");
function stringify(v) {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v, null, 2) ?? "";
  } catch {
    return String(v);
  }
}
function diffText(c) {
  if (typeof c.path === "string") return [`diff: ${c.path}`];
  if (!Array.isArray(c.changes)) return [];
  return c.changes.filter((ch) => typeof ch?.operation === "string" && typeof ch.path === "string").map((ch) => `${ch.operation} ${ch.path}`);
}
function contentItemText(c, state) {
  if (c.type === "diff") return diffText(c);
  if (c.type === "terminal") {
    const out = typeof c.terminalId === "string" ? state.terminals.get(c.terminalId)?.output : void 0;
    return out ? [out] : [];
  }
  if (c.type !== "content" || typeof c.content !== "object" || c.content === null) return [];
  const b = c.content;
  if (b.type === "text" && typeof b.text === "string") return [b.text];
  return b.type === "image" ? ["[image]"] : [];
}
function toolText(tc, state) {
  const parts = tc.content.flatMap((c) => contentItemText(c, state));
  if (parts.length === 0 && tc.rawOutput !== void 0) parts.push(stringify(tc.rawOutput));
  return parts.join("\n");
}
function toolImages(tc) {
  const out = [];
  for (const c of tc.content) {
    const b = c.type === "content" ? c.content : void 0;
    if (b?.type === "image" && typeof b.data === "string" && typeof b.mimeType === "string") {
      out.push({ data: b.data, mimeType: b.mimeType });
    }
  }
  return out;
}
const referencedTerminalIds = (tc) => tc.content.flatMap((c) => c.type === "terminal" && typeof c.terminalId === "string" ? [c.terminalId] : []);
const TERMINAL_STATUSES = /* @__PURE__ */ new Set(["completed", "failed", "cancelled"]);
const toolNameOf = (tc) => tc.name ?? tc.title ?? tc.toolKind ?? "tool";
function toolArgs(raw) {
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) return raw;
  return raw === void 0 ? {} : { input: raw };
}
function createDashboardEventAdapter(opts) {
  const now = opts.now ?? Date.now;
  let state = createAcpSessionState();
  const counters = {
    usage: 0,
    commands: 0,
    sessionInfo: 0,
    unreferencedTerminal: 0,
    configOther: 0,
    unknown: 0
  };
  const suppressed = /* @__PURE__ */ new Set();
  const emittedUser = /* @__PURE__ */ new Set();
  let userBuf;
  let parts = [];
  let segmentStarted = false;
  let openThinking = -1;
  let inTurn = false;
  let prompting = false;
  let turnMessages = [];
  const tools = /* @__PURE__ */ new Map();
  const lastConfig = /* @__PURE__ */ new Map();
  const lastPlan = /* @__PURE__ */ new Map();
  const ev = (eventType, data) => ({
    eventType,
    timestamp: now(),
    data
  });
  const snapshot = () => ({
    role: "assistant",
    content: parts.map((p) => p.kind === "text" ? { type: "text", text: p.text } : { type: "thinking", thinking: p.text }),
    timestamp: now()
  });
  const update = (out, assistantMessageEvent) => out.push(ev("message_update", { message: snapshot(), ...assistantMessageEvent ? { assistantMessageEvent } : {} }));
  function closeThinking(out) {
    if (openThinking < 0) return;
    const idx = openThinking;
    openThinking = -1;
    update(out, { type: "thinking_end", contentIndex: idx, content: parts[idx]?.text ?? "" });
  }
  function closeSegment(out, reason, errorMessage) {
    if (!segmentStarted) return null;
    closeThinking(out);
    const message = { ...snapshot(), stopReason: reason, ...errorMessage ? { errorMessage } : {} };
    out.push(ev("message_end", { message }));
    turnMessages.push(message);
    parts = [];
    segmentStarted = false;
    return message;
  }
  function startTurn(out) {
    if (inTurn) return;
    inTurn = true;
    turnMessages = [];
    out.push(ev("agent_start", {}));
  }
  function endPrompt(out) {
    if (!prompting) return;
    prompting = false;
    out.push(ev("ui_prompt_end", { source: "acp" }));
  }
  function emitUser(out, id) {
    if (suppressed.has(id) || emittedUser.has(id)) return;
    const msg = state.messages.get(id);
    if (!msg || msg.content.length === 0) return;
    emittedUser.add(id);
    closeSegment(out, "stop");
    out.push(...userMessageEvents(msg.content, now()));
  }
  function flushUser(out) {
    if (userBuf === void 0) return;
    const id = userBuf;
    userBuf = void 0;
    emitUser(out, id);
  }
  function openSegment(out) {
    if (segmentStarted) return;
    segmentStarted = true;
    out.push(ev("message_start", { message: { role: "assistant", content: [], timestamp: now() } }));
  }
  function targetPart(out, messageId, kind) {
    let idx = parts.findIndex((p) => p.messageId === messageId && p.kind === kind);
    if (openThinking >= 0 && openThinking !== idx) closeThinking(out);
    if (idx < 0) {
      parts.push({ messageId, kind, text: "" });
      idx = parts.length - 1;
    }
    if (kind === "thinking" && openThinking !== idx) {
      openThinking = idx;
      update(out, { type: "thinking_start", contentIndex: idx });
    }
    return idx;
  }
  function agentContent(out, messageId, kind) {
    const msg = state.messages.get(messageId);
    const full = msg ? textOf(msg.content) : "";
    const existing = parts.find((p) => p.messageId === messageId && p.kind === kind);
    if (full === (existing?.text ?? "")) return;
    openSegment(out);
    const idx = targetPart(out, messageId, kind);
    const part = parts[idx];
    const delta = full.startsWith(part.text) ? full.slice(part.text.length) : null;
    part.text = full;
    if (delta === null) update(out);
    else update(out, { type: kind === "thinking" ? "thinking_delta" : "text_delta", contentIndex: idx, delta });
  }
  function startTool(out, tc) {
    closeSegment(out, "toolUse");
    startTurn(out);
    const track = { ended: false, lastText: "" };
    tools.set(tc.toolCallId, track);
    out.push(
      ev("tool_execution_start", { toolCallId: tc.toolCallId, toolName: toolNameOf(tc), args: toolArgs(tc.rawInput) })
    );
    return track;
  }
  function finishTool(out, tc, text, forcedError) {
    const track = tools.get(tc.toolCallId);
    if (!track || track.ended) return;
    track.ended = true;
    const isError = forcedError ?? (tc.status === "failed" || tc.status === "cancelled");
    const images = toolImages(tc);
    out.push(
      ev("tool_execution_end", {
        toolCallId: tc.toolCallId,
        toolName: toolNameOf(tc),
        result: text,
        isError,
        ...images.length > 0 ? { images } : {}
      })
    );
  }
  function toolActivity(out, toolCallId) {
    const tc = state.toolCalls.get(toolCallId);
    if (!tc) return;
    const track = tools.get(toolCallId) ?? startTool(out, tc);
    if (track.ended) return;
    const text = toolText(tc, state);
    if (tc.status && TERMINAL_STATUSES.has(tc.status)) {
      finishTool(out, tc, text);
    } else if (text !== "" && text !== track.lastText) {
      track.lastText = text;
      out.push(
        ev("tool_execution_update", {
          toolCallId,
          toolName: toolNameOf(tc),
          partialResult: { content: [{ type: "text", text }] }
        })
      );
    }
  }
  function terminalActivity(out, terminalId) {
    let folded = false;
    for (const [id, track] of tools) {
      const tc = track.ended ? void 0 : state.toolCalls.get(id);
      if (tc && referencedTerminalIds(tc).includes(terminalId)) {
        folded = true;
        toolActivity(out, id);
      }
    }
    if (!folded) counters.unreferencedTerminal += 1;
  }
  function closeOpenTools(out, cancelled) {
    for (const [id, track] of tools) {
      const tc = track.ended ? void 0 : state.toolCalls.get(id);
      if (tc) finishTool(out, tc, toolText(tc, state) || (cancelled ? "Cancelled" : ""), cancelled);
    }
  }
  function finishTurn(out, stopReason, error) {
    const mapped = mapStopReason(stopReason, error);
    closeOpenTools(out, stopReason === "cancelled");
    let final = closeSegment(out, mapped.stopReason, mapped.errorMessage);
    if (!final) {
      final = {
        role: "assistant",
        content: [],
        timestamp: now(),
        stopReason: mapped.stopReason,
        ...mapped.errorMessage ? { errorMessage: mapped.errorMessage } : {}
      };
      turnMessages.push(final);
    }
    const extra = mapped.acpStopReason ? { acpStopReason: mapped.acpStopReason } : {};
    out.push(ev("turn_end", { message: final, ...extra }));
    out.push(ev("agent_end", { messages: turnMessages, ...extra }));
    out.push(ev("agent_settled", {}));
    inTurn = false;
    turnMessages = [];
    state = { ...state, messages: /* @__PURE__ */ new Map(), toolCalls: /* @__PURE__ */ new Map(), terminals: /* @__PURE__ */ new Map() };
  }
  function onState(out, u) {
    if (u.state === "running") {
      endPrompt(out);
      startTurn(out);
    } else if (u.state === "requires_action") {
      startTurn(out);
      closeSegment(out, "toolUse");
      if (!prompting) out.push(ev("ui_prompt_start", { source: "acp" }));
      prompting = true;
    } else {
      endPrompt(out);
      if (inTurn) finishTurn(out, u.stopReason, u.error);
      else closeSegment(out, "stop");
    }
  }
  function configEvent(o) {
    if (o.category === "model") {
      return ev("model_select", { model: { provider: `acp:${opts.agentId}`, id: String(o.currentValue) } });
    }
    if (o.category === "thought_level") return ev("model_select", { thinkingLevel: String(o.currentValue) });
    counters.configOther += 1;
    return void 0;
  }
  function onConfig(out, options) {
    for (const o of options) {
      if (lastConfig.has(o.configId) && lastConfig.get(o.configId) === o.currentValue) continue;
      lastConfig.set(o.configId, o.currentValue);
      const e = configEvent(o);
      if (e) out.push(e);
    }
  }
  function onPlan(out, u) {
    const sig = JSON.stringify([u.type, u.entries ?? u.content]);
    if (lastPlan.get(u.planId) === sig) return;
    lastPlan.set(u.planId, sig);
    out.push(ev("acp_plan_update", { planId: u.planId, type: u.type, entries: u.entries ?? [] }));
  }
  function dispatch(out, u) {
    switch (u.kind) {
      case "user_message":
        return emitUser(out, u.messageId);
      case "user_message_chunk":
        userBuf = suppressed.has(u.messageId) ? userBuf : u.messageId;
        return;
      case "agent_message":
      case "agent_message_chunk":
        return agentContent(out, u.messageId, "text");
      case "agent_thought":
      case "agent_thought_chunk":
        return agentContent(out, u.messageId, "thinking");
      case "tool_call_update":
      case "tool_call_content_chunk":
        return toolActivity(out, u.toolCallId);
      case "terminal_update":
      case "terminal_output_chunk":
        return terminalActivity(out, u.terminalId);
      case "state_update":
        return onState(out, u);
      case "config_option_update":
        return onConfig(out, u.options);
      case "plan_update":
        return onPlan(out, u);
      case "usage_update":
        counters.usage += 1;
        return;
      case "available_commands_update":
        counters.commands += 1;
        return;
      case "session_info_update":
        counters.sessionInfo += 1;
        return;
      case "unknown":
        counters.unknown += 1;
        return;
    }
  }
  function push(u) {
    const out = [];
    if (userBuf !== void 0 && !(u.kind === "user_message_chunk" && u.messageId === userBuf)) flushUser(out);
    state = applyUpdate(state, u);
    dispatch(out, u);
    return out;
  }
  return {
    push,
    suppressUserMessage: (id) => {
      suppressed.add(id);
      if (userBuf === id) userBuf = void 0;
    },
    flush() {
      const out = [];
      flushUser(out);
      return out;
    },
    getState: () => state,
    counters: () => ({ ...counters })
  };
}
export {
  createDashboardEventAdapter,
  mapStopReason,
  toPiUserContent,
  userMessageEvents
};
