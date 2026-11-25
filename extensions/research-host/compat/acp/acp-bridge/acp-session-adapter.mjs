import { randomUUID } from "node:crypto";
import { createV1Normalizer } from "../shared/acp/normalize-v1.mjs";
import {
  createDashboardEventAdapter,
  userMessageEvents
} from "../shared/acp/to-dashboard-events.mjs";
import { parseSessionUpdate } from "../shared/acp/update-model.mjs";
import { createAcpConnection } from "./acp-connection.mjs";
import { launchAgentProcess } from "./child-env.mjs";
import { currentModel, findOption, modelInfos } from "./models.mjs";
import { createPermissionBridge } from "./permission-bridge.mjs";
import { handleServerMessage } from "./server-requests.mjs";
import { EchoGuard, PromptQueue } from "./session-state.mjs";
const HEARTBEAT_MS = 15e3;
const COUNTER_REPORT_MS = 6e4;
const KILL_ESCALATE_MS = 3e3;
const CLIENT_INFO = { name: "pi-dashboard", title: "Pi Dashboard" };
const isRec = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (e) => e instanceof Error ? e.message : String(e);
function createAcpSessionAdapter(opts) {
  const { agent, settings, sessionId } = opts;
  const now = opts.now ?? Date.now;
  const dash = createDashboardEventAdapter({ agentId: agent.id, now });
  const v1 = createV1Normalizer();
  const echo = new EchoGuard();
  const queue = new PromptQueue();
  let proc;
  let conn;
  let acpSessionId = "";
  let protocol = 1;
  let ready = false;
  let finished = false;
  let connected = true;
  let turnActive = false;
  let replaying = false;
  let heldWhileReplaying = [];
  let heartbeat;
  let counterTimer;
  let lastCounterSig = "";
  let startTimer;
  const send = (m) => {
    if (finished && m.type !== "session_unregister") return;
    if (replaying) heldWhileReplaying.push(m);
    else opts.send(m);
  };
  const emit = (events) => {
    for (const event of events) {
      opts.eventLog?.append(event);
      if (connected) send({ type: "event_forward", sessionId, event });
    }
  };
  const notify = (message) => send({ type: "notify", sessionId, notifyId: randomUUID(), message, level: "error", ts: now() });
  const diagnostic = (detail) => {
    opts.log(`[acp:${agent.id}] ${detail}`);
    send({ type: "bridge_diagnostic", sessionId, event: "acp", detail });
  };
  const registerMessage = (reason) => ({
    type: "session_register",
    sessionId,
    cwd: opts.cwd,
    source: "dashboard",
    ...opts.reportPid !== void 0 ? { pid: opts.reportPid } : {},
    hasUI: false,
    dashboardSpawned: true,
    ...opts.spawnToken ? { spawnToken: opts.spawnToken } : {},
    registerReason: reason,
    ...reason === "spawn" ? { isNew: true } : {},
    driver: "acp",
    acpAgentId: agent.id,
    ...opts.sessionFile ? { sessionFile: opts.sessionFile } : {}
  });
  const options = () => dash.getState().configOptions.values();
  const publishModels = () => send({ type: "models_list", sessionId, models: modelInfos(options(), agent.id) });
  const publishCommands = () => send({
    type: "commands_list",
    sessionId,
    commands: dash.getState().commands.map((c) => ({ name: c.name, description: c.description, source: "acp" }))
  });
  const publishQueue = () => send({ type: "queue_update", sessionId, steering: [], followUp: queue.view() });
  const publishModelState = () => {
    const model = currentModel(options(), agent.id);
    const level = findOption(options(), "thought_level")?.currentValue;
    if (model) send({ type: "model_update", sessionId, model, ...typeof level === "string" ? { thinkingLevel: level } : {} });
  };
  const permissions = createPermissionBridge(sessionId, send, {
    onAnswered: () => {
      if (protocol === 1) ingest(v1.permissionAnswered());
    }
  });
  function sideEffects(u) {
    switch (u.kind) {
      case "available_commands_update":
        return publishCommands();
      case "session_info_update":
        if (u.title) send({ type: "session_name_update", sessionId, name: u.title, nameSource: "auto" });
        return;
      case "config_option_update":
        publishModels();
        return publishModelState();
      case "state_update":
        if (u.state === "running") turnActive = true;
        if (u.state === "idle") turnActive = false;
        return;
      default:
    }
  }
  function admitUser(u) {
    const route = echo.route(u);
    if (route === "suppress") dash.suppressUserMessage(u.messageId);
    return route !== "hold";
  }
  function ingest(updates) {
    let idle = false;
    for (const u of updates) {
      if ((u.kind === "user_message" || u.kind === "user_message_chunk") && !admitUser(u)) continue;
      emit(dash.push(u));
      sideEffects(u);
      idle ||= u.kind === "state_update" && u.state === "idle";
    }
    if (idle) drainQueue();
  }
  function onSessionUpdate(params) {
    const raw = isRec(params) ? params.update : void 0;
    ingest(protocol === 1 ? v1.update(raw) : [parseSessionUpdate(raw)]);
  }
  const promptBlocks = (p) => [
    { type: "text", text: p.text },
    ...(p.images ?? []).map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))
  ];
  const str = (v) => typeof v === "string" ? v : void 0;
  function onPromptResult(result, promptId, ack) {
    const res = isRec(result) ? result : {};
    if (protocol === 1) {
      ingest(echo.resolved());
      ingest(v1.promptResolved(str(res.stopReason) ?? null));
      return;
    }
    ingest(echo.accepted(str(res.messageId)));
    if (ack) send({ type: "prompt_received", sessionId, fresh: true, ...promptId ? { promptId } : {} });
  }
  function onPromptRejected(err) {
    ingest(echo.resolved());
    const message = errText(err);
    if (protocol === 1) {
      ingest([{ kind: "state_update", state: "idle", stopReason: "error", error: { message } }]);
    } else {
      ingest([
        { kind: "state_update", state: "running" },
        { kind: "state_update", state: "idle", stopReason: "error", error: { message } }
      ]);
    }
  }
  function dispatchPrompt(p, ack) {
    if (!conn) return;
    turnActive = true;
    emit(userMessageEvents(p.images?.length ? [{ type: "text", text: p.text }, ...p.images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }))] : p.text, now()));
    echo.begin(protocol);
    if (protocol === 1) {
      ingest(v1.promptDispatched());
      if (ack) send({ type: "prompt_received", sessionId, fresh: true, ...p.promptId ? { promptId: p.promptId } : {} });
    }
    conn.request("session/prompt", { sessionId: acpSessionId, prompt: promptBlocks(p) }, 0).then((r) => onPromptResult(r, p.promptId, ack)).catch(onPromptRejected);
  }
  function drainQueue() {
    if (!ready || finished || turnActive || queue.length === 0) return;
    const next = queue.shift();
    publishQueue();
    if (next) dispatchPrompt(next, false);
  }
  function sendPrompt(m) {
    const p = { text: m.text, images: m.images, promptId: m.promptId };
    if (!ready || turnActive) {
      queue.enqueue(p);
      send({ type: "prompt_received", sessionId, fresh: false, ...m.promptId ? { promptId: m.promptId } : {} });
      publishQueue();
      return;
    }
    dispatchPrompt(p, true);
  }
  function abort() {
    conn?.notify("session/cancel", { sessionId: acpSessionId });
    permissions.cancelAll();
  }
  function setConfig(category, value, label) {
    const opt = findOption(options(), category);
    if (!opt || !conn) return notify(`This agent does not expose ${label} selection`);
    conn.request("session/set_config_option", { sessionId: acpSessionId, configId: opt.configId, value }).then((res) => {
      if (isRec(res) && Array.isArray(res.configOptions)) ingest([parseSessionUpdate({ sessionUpdate: "config_option_update", configOptions: res.configOptions })]);
    }).catch((err) => notify(`Could not change ${label}: ${errText(err)}`));
  }
  function killAgent() {
    const p = proc;
    if (!p) return;
    try {
      p.kill("SIGTERM");
    } catch {
    }
    const t = setTimeout(() => {
      try {
        p.kill("SIGKILL");
      } catch {
      }
    }, KILL_ESCALATE_MS);
    t.unref?.();
  }
  function finish(code) {
    if (finished) return;
    finished = true;
    if (heartbeat) clearInterval(heartbeat);
    if (counterTimer) clearInterval(counterTimer);
    if (startTimer) clearTimeout(startTimer);
    conn?.close(new Error("ACP session ended"));
    killAgent();
    Promise.resolve(opts.eventLog?.flush()).catch(() => {
    }).finally(() => opts.onExit(code));
  }
  function fail(cause, code = 1) {
    if (finished) return;
    permissions.cancelAll();
    queue.clearAll();
    ingest([
      { kind: "state_update", state: "running" },
      { kind: "state_update", state: "idle", stopReason: "error", error: { message: cause } }
    ]);
    diagnostic(`failed: ${cause}`);
    send({ type: "session_unregister", sessionId });
    finish(code);
  }
  function wireAgent(handle) {
    proc = handle;
    handle.on("error", (err) => fail(`ACP agent failed to start: ${errText(err)}`));
    handle.on("exit", (code, signal) => fail(`ACP agent exited (${signal ? `signal ${signal}` : `code ${code}`})`));
    handle.stdin.on("error", (err) => opts.log(`[acp:${agent.id}] agent stdin error: ${errText(err)}`));
    handle.stdout.on("error", (err) => opts.log(`[acp:${agent.id}] agent stdout error: ${errText(err)}`));
    let stderrLines = 0;
    handle.stderr?.on("data", (c) => {
      if (stderrLines++ < 200) opts.log(`[acp:${agent.id}] stderr: ${c.toString("utf8").slice(0, 2e3).trimEnd()}`);
    });
    conn = createAcpConnection({
      input: handle.stdout,
      output: handle.stdin,
      maxLineBytes: settings.maxLineBytes,
      requestTimeoutMs: settings.requestTimeoutMs,
      requestHandlers: { "session/request_permission": handlePermission },
      onNotification: (method, params) => {
        if (method === "session/update") onSessionUpdate(params);
      },
      onClose: () => fail("ACP agent closed its output")
    });
  }
  function handlePermission(params) {
    if (protocol === 1) ingest(v1.permissionRequested());
    return permissions.request(params).then((outcome) => ({ outcome }));
  }
  async function handshake() {
    const connection = conn;
    const requested = settings.protocolV2 ? 2 : 1;
    const init = await connection.request(
      "initialize",
      {
        protocolVersion: requested,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: CLIENT_INFO
      },
      0
    );
    const version = isRec(init) ? init.protocolVersion : void 0;
    if (version !== 1 && !(version === 2 && requested === 2)) {
      throw new Error(`unsupported ACP protocol version ${String(version)}`);
    }
    protocol = version;
    const created = await connection.request("session/new", { cwd: opts.cwd, mcpServers: [] }, 0);
    if (!isRec(created) || typeof created.sessionId !== "string") throw new Error("session/new returned no sessionId");
    acpSessionId = created.sessionId;
    if (Array.isArray(created.configOptions)) {
      ingest([parseSessionUpdate({ sessionUpdate: "config_option_update", configOptions: created.configOptions })]);
    }
  }
  function startWatchdogs() {
    heartbeat = setInterval(() => {
      if (connected) send({ type: "session_heartbeat", sessionId, agentRunning: turnActive });
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    counterTimer = setInterval(reportCounters, COUNTER_REPORT_MS);
    counterTimer.unref?.();
  }
  function reportCounters() {
    const c = { ...conn?.counters(), ...dash.counters() };
    const sig = JSON.stringify(c);
    if (sig === lastCounterSig) return;
    lastCounterSig = sig;
    const nonZero = Object.entries(c).filter(([, v]) => v > 0);
    if (nonZero.length > 0) diagnostic(`counters ${nonZero.map(([k, v]) => `${k}=${v}`).join(" ")}`);
  }
  async function start() {
    send(registerMessage("spawn"));
    send({ type: "replay_complete", sessionId });
    startWatchdogs();
    const timedOut = new Promise((_, reject) => {
      startTimer = setTimeout(
        () => reject(new Error(`timeout: ACP agent did not become ready within ${settings.spawnTimeoutMs} ms`)),
        settings.spawnTimeoutMs
      );
    });
    try {
      wireAgent(
        (opts.launchAgent ?? ((cwd) => launchAgentProcess({ agent, cwd, warn: (w) => opts.log(`[acp:${agent.id}] ${w}`) })))(opts.cwd)
      );
      await Promise.race([handshake(), timedOut]);
    } catch (err) {
      fail(errText(err));
      return;
    }
    if (finished) return;
    if (startTimer) clearTimeout(startTimer);
    ready = true;
    diagnostic(`agent=${agent.id} protocol=v${protocol} started`);
    publishModels();
    publishCommands();
    drainQueue();
  }
  async function reconnected() {
    if (finished) return;
    replaying = true;
    heldWhileReplaying = [];
    connected = true;
    opts.send(registerMessage("reattach"));
    publishModelsRaw();
    const snapshot = opts.eventLog ? (await opts.eventLog.flush(), opts.eventLog.size()) : 0;
    if (opts.eventLog) {
      await opts.eventLog.replay((event) => opts.send({ type: "event_forward", sessionId, event, replay: true }), snapshot);
    }
    opts.send({ type: "replay_complete", sessionId });
    replaying = false;
    for (const m of heldWhileReplaying) opts.send(m);
    heldWhileReplaying = [];
    permissions.resend();
    if (queue.length > 0) publishQueue();
  }
  function publishModelsRaw() {
    opts.send({ type: "models_list", sessionId, models: modelInfos(options(), agent.id) });
    opts.send({
      type: "commands_list",
      sessionId,
      commands: dash.getState().commands.map((c) => ({ name: c.name, description: c.description, source: "acp" }))
    });
    const model = currentModel(options(), agent.id);
    const level = findOption(options(), "thought_level")?.currentValue;
    if (model) opts.send({ type: "model_update", sessionId, model, ...typeof level === "string" ? { thinkingLevel: level } : {} });
  }
  async function stop() {
    if (finished) return;
    permissions.cancelAll();
    queue.clearAll();
    send({ type: "session_unregister", sessionId });
    finish(0);
  }
  return {
    start,
    handle: (m) => handleServerMessage(m, {
      sessionId,
      send,
      sendPrompt,
      abort,
      setModel: (_provider, modelId) => setConfig("model", modelId, "model"),
      setThinkingLevel: (level) => setConfig("thought_level", level, "thinking level"),
      promptResponse: (r) => {
        permissions.respond(r.promptId, r.answer, r.cancelled);
      },
      clearFollowups: (i) => {
        queue.clear(i);
        publishQueue();
      },
      editFollowup: (i, text) => {
        if (queue.edit(i, text)) publishQueue();
      },
      removeFollowup: (i) => {
        if (queue.remove(i)) publishQueue();
      },
      promoteFollowup: (i) => {
        if (queue.promote(i)) publishQueue();
      },
      resyncState: () => {
        send(registerMessage("reattach"));
        publishModels();
        publishCommands();
        publishModelState();
        if (queue.length > 0) publishQueue();
      },
      publishModels,
      publishCommands,
      resyncPrompts: (id) => permissions.resend(id),
      stop: (reason, code) => {
        opts.log(`[acp:${agent.id}] stopping: ${reason}`);
        if (code === 0) stop().catch(() => {
        });
        else fail(reason, code);
      },
      ignored: () => {
      }
    }),
    disconnected: () => {
      connected = false;
    },
    reconnected,
    stop
  };
}
export {
  createAcpSessionAdapter
};
