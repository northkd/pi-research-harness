const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isBlock = (v) => isRec(v) && isStr(v.type);
function optPatch(raw, key, guard) {
  if (!(key in raw) || raw[key] === void 0) return { ok: true, present: false, value: void 0 };
  const v = raw[key];
  if (v === null) return { ok: true, present: true, value: null };
  return guard(v) ? { ok: true, present: true, value: v } : { ok: false };
}
const isBlockArray = (v) => Array.isArray(v) && v.every(isBlock);
function parseMessage(kind, raw) {
  if (!isStr(raw.messageId)) return void 0;
  const content = optPatch(raw, "content", isBlockArray);
  if (!content.ok) return void 0;
  const out = { kind, messageId: raw.messageId };
  if (content.present) out.content = content.value;
  return out;
}
function parseChunk(kind, raw) {
  if (!isStr(raw.messageId) || !isBlock(raw.content)) return void 0;
  return { kind, messageId: raw.messageId, content: raw.content };
}
const TOOL_PATCH_FIELDS = [
  ["name", "name"],
  ["title", "title"],
  ["status", "status"],
  ["kind", "toolKind"]
];
function parseToolCall(raw) {
  if (!isStr(raw.toolCallId)) return void 0;
  const out = {
    kind: "tool_call_update",
    toolCallId: raw.toolCallId
  };
  for (const [wire, field] of TOOL_PATCH_FIELDS) {
    const p = optPatch(raw, wire, isStr);
    if (!p.ok) return void 0;
    if (p.present) out[field] = p.value;
  }
  const c = optPatch(raw, "content", (v) => Array.isArray(v) && v.every(isBlock));
  if (!c.ok) return void 0;
  if (c.present) out.content = c.value;
  if (raw.rawInput !== void 0) out.rawInput = raw.rawInput;
  if (raw.rawOutput !== void 0) out.rawOutput = raw.rawOutput;
  return out;
}
function parsePlanEntry(e) {
  if (!isRec(e) || !isStr(e.content)) return void 0;
  return {
    content: e.content,
    ...isStr(e.priority) ? { priority: e.priority } : {},
    ...isStr(e.status) ? { status: e.status } : {}
  };
}
function parsePlan(raw) {
  const plan = raw.plan;
  if (!isRec(plan) || !isStr(plan.type) || !isStr(plan.planId)) return void 0;
  if (plan.type !== "items") return { kind: "plan_update", planId: plan.planId, type: plan.type, content: plan };
  if (!Array.isArray(plan.entries)) return void 0;
  const entries = plan.entries.map(parsePlanEntry);
  if (entries.some((e) => e === void 0)) return void 0;
  return { kind: "plan_update", planId: plan.planId, type: "items", entries };
}
function flattenSelectOptions(options) {
  const flat = [];
  for (const item of options) {
    if (!isRec(item)) continue;
    const inner = Array.isArray(item.options) ? item.options : [item];
    for (const v of inner) {
      if (isRec(v) && isStr(v.value) && isStr(v.name)) flat.push({ value: v.value, name: v.name });
    }
  }
  return flat;
}
function parseConfigOption(o) {
  if (!isRec(o) || !isStr(o.configId) || !isStr(o.type)) return void 0;
  const opt = { configId: o.configId, type: o.type, currentValue: o.currentValue };
  if (isStr(o.name)) opt.name = o.name;
  if (isStr(o.category) || o.category === null) opt.category = o.category;
  if (Array.isArray(o.options)) opt.options = flattenSelectOptions(o.options);
  return opt;
}
function parseConfigOptions(raw) {
  if (!Array.isArray(raw.configOptions)) return void 0;
  const options = raw.configOptions.map(parseConfigOption);
  if (options.some((o) => o === void 0)) return void 0;
  return { kind: "config_option_update", options };
}
function parseState(raw) {
  const state = raw.state;
  if (state !== "running" && state !== "idle" && state !== "requires_action") return void 0;
  const out = { kind: "state_update", state };
  if (state !== "idle") return out;
  const stop = optPatch(raw, "stopReason", isStr);
  if (!stop.ok) return void 0;
  if (stop.present || "stopReason" in raw) out.stopReason = stop.value ?? null;
  if (raw.error !== void 0 && raw.error !== null) out.error = raw.error;
  return out;
}
function parseCommands(raw) {
  if (!Array.isArray(raw.availableCommands)) return void 0;
  const commands = [];
  for (const c of raw.availableCommands) {
    if (!isRec(c) || !isStr(c.name)) return void 0;
    commands.push({ name: c.name, ...isStr(c.description) ? { description: c.description } : {} });
  }
  return { kind: "available_commands_update", commands };
}
function parseCost(cost) {
  if (cost === null) return null;
  if (isRec(cost) && isNum(cost.amount) && isStr(cost.currency)) return { amount: cost.amount, currency: cost.currency };
  return void 0;
}
function parseUsage(raw) {
  if (!isNum(raw.used) || !isNum(raw.size)) return void 0;
  const out = { kind: "usage_update", used: raw.used, size: raw.size };
  const cost = parseCost(raw.cost);
  if (cost !== void 0) out.cost = cost;
  return out;
}
function parseSessionInfo(raw) {
  const title = optPatch(raw, "title", isStr);
  const updatedAt = optPatch(raw, "updatedAt", isStr);
  if (!title.ok || !updatedAt.ok) return void 0;
  const out = { kind: "session_info_update" };
  if (title.present) out.title = title.value;
  if (updatedAt.present) out.updatedAt = updatedAt.value;
  return out;
}
function parseExitStatus(v) {
  if (v === null) return null;
  if (!isRec(v)) return void 0;
  const out = {};
  if (isNum(v.exitCode) || v.exitCode === null) out.exitCode = v.exitCode;
  if (isStr(v.signal) || v.signal === null) out.signal = v.signal;
  return out;
}
function parseTerminalUpdate(raw) {
  if (!isStr(raw.terminalId)) return void 0;
  const out = { kind: "terminal_update", terminalId: raw.terminalId };
  for (const key of ["command", "cwd"]) {
    const p = optPatch(raw, key, isStr);
    if (!p.ok) return void 0;
    if (p.present) out[key] = p.value;
  }
  if (raw.output === null) out.output = null;
  else if (raw.output !== void 0) {
    if (!isRec(raw.output) || !isStr(raw.output.data)) return void 0;
    out.output = { data: raw.output.data };
  }
  if (raw.exitStatus !== void 0) {
    const exit = parseExitStatus(raw.exitStatus);
    if (exit === void 0) return void 0;
    out.exitStatus = exit;
  }
  return out;
}
const parseMessageUpdate = (kind) => (raw) => parseMessage(kind, raw);
const parseChunkUpdate = (kind) => (raw) => parseChunk(kind, raw);
const PARSERS = {
  user_message: parseMessageUpdate("user_message"),
  agent_message: parseMessageUpdate("agent_message"),
  agent_thought: parseMessageUpdate("agent_thought"),
  user_message_chunk: parseChunkUpdate("user_message_chunk"),
  agent_message_chunk: parseChunkUpdate("agent_message_chunk"),
  agent_thought_chunk: parseChunkUpdate("agent_thought_chunk"),
  tool_call_update: parseToolCall,
  tool_call_content_chunk: (raw) => isStr(raw.toolCallId) && isBlock(raw.content) ? { kind: "tool_call_content_chunk", toolCallId: raw.toolCallId, content: raw.content } : void 0,
  state_update: parseState,
  plan_update: parsePlan,
  config_option_update: parseConfigOptions,
  available_commands_update: parseCommands,
  usage_update: parseUsage,
  session_info_update: parseSessionInfo,
  terminal_update: parseTerminalUpdate,
  terminal_output_chunk: (raw) => isStr(raw.terminalId) && isStr(raw.data) ? { kind: "terminal_output_chunk", terminalId: raw.terminalId, data: raw.data } : void 0
};
function parseSessionUpdate(raw) {
  try {
    if (isRec(raw) && isStr(raw.sessionUpdate)) {
      const parsed = Object.hasOwn(PARSERS, raw.sessionUpdate) ? PARSERS[raw.sessionUpdate]?.(raw) : void 0;
      if (parsed) return parsed;
    }
  } catch {
  }
  return { kind: "unknown", raw };
}
function createAcpSessionState() {
  return {
    messages: /* @__PURE__ */ new Map(),
    toolCalls: /* @__PURE__ */ new Map(),
    terminals: /* @__PURE__ */ new Map(),
    plans: /* @__PURE__ */ new Map(),
    configOptions: /* @__PURE__ */ new Map(),
    commands: [],
    run: { state: "idle" }
  };
}
function decodeTerminalData(data) {
  try {
    const bin = atob(data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}
function withEntry(map, key, value) {
  const next = new Map(map);
  next.set(key, value);
  return next;
}
function upsertMessage(state, role, messageId, mutate) {
  const prev = state.messages.get(messageId);
  const next = { messageId, role: prev?.role ?? role, content: mutate(prev?.content ?? []) };
  return { ...state, messages: withEntry(state.messages, messageId, next) };
}
const MESSAGE_ROLE = {
  user_message: "user",
  user_message_chunk: "user",
  agent_message: "agent",
  agent_message_chunk: "agent",
  agent_thought: "thought",
  agent_thought_chunk: "thought"
};
const TOOL_STRING_FIELDS = ["name", "title", "toolKind", "status"];
function patchToolCall(prev, toolCallId, u) {
  const next = { ...prev ?? { toolCallId, content: [] } };
  for (const field of TOOL_STRING_FIELDS) {
    if (!(field in u)) continue;
    if (u[field] === null) delete next[field];
    else next[field] = u[field];
  }
  if ("content" in u) next.content = u.content ?? [];
  for (const key of ["rawInput", "rawOutput"]) {
    if (!(key in u)) continue;
    if (u[key] === null) delete next[key];
    else next[key] = u[key];
  }
  return next;
}
const applyMessage = (state, update) => {
  const role = MESSAGE_ROLE[update.kind];
  if (!("content" in update)) return upsertMessage(state, role, update.messageId, (p) => p);
  return upsertMessage(state, role, update.messageId, () => update.content ?? []);
};
const applyChunk = (state, update) => upsertMessage(state, MESSAGE_ROLE[update.kind], update.messageId, (p) => [...p, update.content]);
const applyToolCall = (state, update) => {
  const { kind: _k, toolCallId, ...patch } = update;
  const next = patchToolCall(state.toolCalls.get(toolCallId), toolCallId, patch);
  return { ...state, toolCalls: withEntry(state.toolCalls, toolCallId, next) };
};
const applyToolChunk = (state, update) => {
  const next = patchToolCall(state.toolCalls.get(update.toolCallId), update.toolCallId, {});
  next.content = [...next.content, update.content];
  return { ...state, toolCalls: withEntry(state.toolCalls, update.toolCallId, next) };
};
const applyRun = (state, update) => ({
  ...state,
  run: { state: update.state, ...update.stopReason !== void 0 ? { stopReason: update.stopReason } : {} }
});
const applyPlan = (state, update) => ({
  ...state,
  plans: withEntry(state.plans, update.planId, {
    planId: update.planId,
    type: update.type,
    entries: update.entries ?? [],
    ...update.content !== void 0 ? { content: update.content } : {}
  })
});
const applyConfig = (state, update) => {
  const next = new Map(state.configOptions);
  for (const o of update.options) next.set(o.configId, o);
  return { ...state, configOptions: next };
};
const applySessionInfo = (state, update) => {
  if (!("title" in update)) return state;
  const { title: _t, ...rest } = state;
  return update.title ? { ...rest, title: update.title } : rest;
};
function patchOptional(target, key, value) {
  if (value === null) delete target[key];
  else target[key] = value;
}
const applyTerminalUpdate = (state, update) => {
  const next = { ...state.terminals.get(update.terminalId) ?? { terminalId: update.terminalId, output: "" } };
  if ("command" in update) patchOptional(next, "command", update.command ?? null);
  if ("cwd" in update) patchOptional(next, "cwd", update.cwd ?? null);
  if ("exitStatus" in update) patchOptional(next, "exitStatus", update.exitStatus ?? null);
  if ("output" in update) next.output = update.output ? decodeTerminalData(update.output.data) : "";
  return { ...state, terminals: withEntry(state.terminals, update.terminalId, next) };
};
const applyTerminalChunk = (state, update) => {
  const prev = state.terminals.get(update.terminalId) ?? { terminalId: update.terminalId, output: "" };
  const next = { ...prev, output: prev.output + decodeTerminalData(update.data) };
  return { ...state, terminals: withEntry(state.terminals, update.terminalId, next) };
};
function applyUpdate(state, update) {
  switch (update.kind) {
    case "user_message":
    case "agent_message":
    case "agent_thought":
      return applyMessage(state, update);
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return applyChunk(state, update);
    case "tool_call_update":
      return applyToolCall(state, update);
    case "tool_call_content_chunk":
      return applyToolChunk(state, update);
    case "state_update":
      return applyRun(state, update);
    case "plan_update":
      return applyPlan(state, update);
    case "config_option_update":
      return applyConfig(state, update);
    case "available_commands_update":
      return { ...state, commands: update.commands };
    case "session_info_update":
      return applySessionInfo(state, update);
    case "terminal_update":
      return applyTerminalUpdate(state, update);
    case "terminal_output_chunk":
      return applyTerminalChunk(state, update);
    case "usage_update":
    case "unknown":
      return state;
  }
}
export {
  applyUpdate,
  createAcpSessionState,
  decodeTerminalData,
  parseSessionUpdate
};
