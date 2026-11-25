import { supplementalHomeDir } from "../../runtime-home.mjs";
const ENGINE_INIT_DELAY_MS = 1e3;
const RESCAN_DEBOUNCE_MS = 15e3;
import path from "node:path";
import {
  ACTION_CONTRIBUTION_PREFIX,
  collectActionRegistry,
  coreActionContributions
} from "./action-registry.js";
import { collectFolderScopeBases, FOLDER_SCOPE_CONTRIBUTION_PREFIX } from "./folder-scope-contributions.js";
import { settingsDefaultBound } from "./resolve-children.js";
import { automationRoleUsage } from "./role-usage.js";
import { mountAutomationRoutes, unknownActionKind } from "./routes.js";
import { scanAutomations } from "./scanner.js";
const PLUGIN_ID = "automation";
const CORE_ACTION_KEY = "automation.action.core";
let engineRef = null;
let collectRegistry = null;
async function registerPlugin(ctx) {
  ctx.logger.info("automation-plugin server entry activated");
  ctx.provide(CORE_ACTION_KEY, coreActionContributions());
  collectRegistry = () => collectActionRegistry(ctx.consumeAll(ACTION_CONTRIBUTION_PREFIX), { warn: (m) => ctx.logger.warn(m) });
  const actionRegistry = { descriptorsForCwd: (cwd) => collectRegistry().descriptorsForCwd(cwd) };
  const descriptorCache = /* @__PURE__ */ new Map();
  const DESCRIPTOR_TTL_MS = 3e3;
  function descriptorsForCwdCached(cwd) {
    const hit = descriptorCache.get(cwd);
    const now = Date.now();
    if (hit && now - hit.ts < DESCRIPTOR_TTL_MS) return hit.value;
    const value = actionRegistry.descriptorsForCwd(cwd);
    descriptorCache.set(cwd, { ts: now, value });
    return value;
  }
  mountAutomationRoutes(ctx.fastify, {
    runNow: ({ scope, cwd, name }) => runNowViaEngine(scope, cwd, name),
    stopRun: ({ runId }) => stopRunViaEngine(runId),
    listActions: (cwd) => descriptorsForCwdCached(cwd ?? process.cwd()),
    actionIds: () => collectRegistry().ids(),
    // Live registries, so /list + /definition agree with what the scheduler will
    // actually arm. See the FALLBACK_KINDS note in routes.ts.
    triggerKinds: () => engineRef?.registry.kinds() ?? /* @__PURE__ */ new Set(["schedule"]),
    workSourceIds: () => engineRef?.workSources.ids() ?? /* @__PURE__ */ new Set(),
    scanGlobalScope: () => ctx.getPluginConfig()?.scanGlobalScope !== false
  });
  ctx.registerBrowserHandler("plugin_action", (msg) => {
    const m = msg;
    if (m.pluginId !== PLUGIN_ID) return;
    const p = m.payload ?? {};
    const scope = p.scope === "global" ? "global" : "folder";
    const cwd = typeof p.cwd === "string" ? p.cwd : void 0;
    void (async () => {
      try {
        switch (m.action) {
          case "run": {
            const name = typeof p.name === "string" ? p.name : "";
            if (!name) return ctx.logger.warn("automation run: name required");
            const r = await runNowViaEngine(scope, cwd, name);
            ctx.logger.info(`automation run "${name}" scope=${scope} ok=${r.ok}${r.runId ? ` runId=${r.runId}` : ""}${r.error ? ` error=${r.error}` : ""}`);
            break;
          }
          case "stop": {
            const runId = typeof p.runId === "string" ? p.runId : "";
            if (!runId) return ctx.logger.warn("automation stop: runId required");
            const r = await stopRunViaEngine(runId);
            ctx.logger.info(`automation stop runId=${runId} ok=${r.ok}${r.error ? ` error=${r.error}` : ""}`);
            break;
          }
          case "create": {
            const name = typeof p.name === "string" ? p.name : "";
            const config = p.config;
            if (!name || !config) return ctx.logger.warn("automation create: name and config required");
            const { writeAutomation, isValidAutomationName } = await import("./automation-writer.js");
            if (!isValidAutomationName(name)) return ctx.logger.warn(`automation create: invalid name "${name}"`);
            const badKind = unknownActionKind(config, collectRegistry?.().ids());
            if (badKind) return ctx.logger.warn(`automation create: unknown action kind "${badKind}"`);
            const base = scope === "global" ? supplementalHomeDir() : cwd ? path.resolve(cwd) : process.cwd();
            const result = writeAutomation({
              scopeBase: base,
              name,
              config,
              ...typeof p.promptBody === "string" ? { promptBody: p.promptBody } : {}
            });
            ctx.logger.info(`automation create "${name}" scope=${scope} dir=${result.dir}`);
            break;
          }
          default:
            ctx.logger.warn(`unknown automation action: ${m.action}`);
        }
      } catch (err) {
        ctx.logger.error(`automation ${m.action ?? "(no action)"} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    })();
  });
  await initEngine(ctx);
}
async function initEngine(ctx) {
  const { createEngine } = await import("./engine.js");
  const { createAutomationWatcher, reconcileWatchers } = await import("./automation-watcher.js");
  const { logger } = ctx;
  const homeDir = supplementalHomeDir();
  function pluginConfig() {
    const cfg = ctx.getPluginConfig() ?? {};
    return {
      defaultVisibility: cfg.defaultVisibility ?? "hidden",
      retention: cfg.retentionPerAutomation ?? 100,
      ...cfg.defaultModel ? { defaultModel: cfg.defaultModel } : {},
      scanFolder: cfg.scanFolderScope !== false,
      scanGlobal: cfg.scanGlobalScope !== false,
      maxRunAgeMs: cfg.maxRunAgeMs ?? 30 * 60 * 1e3,
      maxConcurrentSpawns: settingsDefaultBound(
        cfg.maxConcurrentSpawns,
        process.env.PI_AUTOMATION_MAX_CONCURRENT_SPAWNS
      )
    };
  }
  const { WorkSourceRegistry } = await import("./work-source-registry.js");
  const { createFolderWorkSource } = await import("./folder-work-source.js");
  const workSources = new WorkSourceRegistry();
  const rawSources = ctx.getPluginConfig()?.workSources;
  const seenDirs = /* @__PURE__ */ new Set();
  for (const ws of Array.isArray(rawSources) ? rawSources : []) {
    const label = typeof ws?.id === "string" && ws.id.trim() ? ws.id : "<unnamed>";
    if (typeof ws?.id !== "string" || !ws.id.trim()) {
      ctx.logger.warn(`automation work-source: entry ignored \u2014 missing/empty id`);
      continue;
    }
    if (typeof ws?.dir !== "string" || !ws.dir.trim()) {
      ctx.logger.warn(`automation work-source "${label}": ignored \u2014 missing/empty dir`);
      continue;
    }
    if (ws.visibilityTimeoutMs !== void 0 && (!Number.isFinite(ws.visibilityTimeoutMs) || ws.visibilityTimeoutMs <= 0)) {
      ctx.logger.warn(`automation work-source "${label}": ignored \u2014 visibilityTimeoutMs must be a positive finite number`);
      continue;
    }
    const resolvedDir = path.resolve(ws.dir);
    if (seenDirs.has(resolvedDir)) {
      ctx.logger.warn(`automation work-source "${label}": ignored \u2014 duplicate dir "${resolvedDir}" (one live source per dir)`);
      continue;
    }
    seenDirs.add(resolvedDir);
    try {
      workSources.register(
        ws.id,
        createFolderWorkSource({
          dir: ws.dir,
          ...typeof ws.visibilityTimeoutMs === "number" ? { visibilityTimeoutMs: ws.visibilityTimeoutMs } : {}
        })
      );
    } catch (e) {
      ctx.logger.warn(
        `automation work-source "${label}": failed to initialize dir "${resolvedDir}": ${e instanceof Error ? e.message : String(e)}`
      );
    }
  }
  const { collectWorkSourceContributions, WORK_SOURCE_CONTRIBUTION_PREFIX } = await import("./work-source-contributions.js");
  const contributedSources = () => collectWorkSourceContributions(ctx.consumeAll(WORK_SOURCE_CONTRIBUTION_PREFIX), {
    warn: (m) => ctx.logger.warn(m)
  });
  workSources.addProvider({
    ids: () => contributedSources().map((c) => c.id),
    get: (id) => contributedSources().find((c) => c.id === id)?.source
  });
  const folderScopeWarnedKeys = /* @__PURE__ */ new Set();
  function folderScopeBases() {
    const bases = /* @__PURE__ */ new Set();
    try {
      const sessions = ctx.sessionManager.listAll();
      for (const s of sessions) {
        if (typeof s.cwd === "string" && s.cwd.length > 0) bases.add(path.resolve(s.cwd));
      }
    } catch {
    }
    for (const base of collectFolderScopeBases(ctx.consumeAll(FOLDER_SCOPE_CONTRIBUTION_PREFIX), {
      warn: (m) => ctx.logger.warn(m),
      homeDir,
      warnedKeys: folderScopeWarnedKeys
    })) {
      bases.add(base);
    }
    return [...bases];
  }
  function listScopes() {
    const cfg = pluginConfig();
    const scopes = [];
    if (cfg.scanGlobal) scopes.push({ base: homeDir, scope: "global" });
    if (cfg.scanFolder) {
      const resolvedHome = path.resolve(homeDir);
      for (const base of folderScopeBases()) {
        if (cfg.scanGlobal && base === resolvedHome) continue;
        scopes.push({ base, scope: "folder" });
      }
    }
    return scopes;
  }
  const engine = createEngine({
    spawnSession: (opts) => ctx.spawnSession(opts),
    abortSpawnedRun: (args) => ctx.abortSpawnedRun(args),
    resolveRegistry: () => collectActionRegistry(ctx.consumeAll(ACTION_CONTRIBUTION_PREFIX), { warn: (m) => ctx.logger.warn(m) }),
    listScopes,
    workSources,
    config: pluginConfig,
    homeDir,
    log: (m) => logger.info(m),
    warn: (m) => logger.warn(m)
  });
  engineRef = engine;
  ctx.provide(
    "automation:runWorkItem",
    async (cwd, key, name) => runWorkItemViaEngine(cwd, key, name)
  );
  const watcher = createAutomationWatcher({
    onChange: () => engine.refresh(),
    logger: (m) => logger.warn(m)
  });
  function attachWatchers() {
    reconcileWatchers(watcher, listScopes().map((s) => s.base));
  }
  let started = false;
  ctx.onBackgroundStart(() => {
    engine.start();
    attachWatchers();
    started = true;
  });
  ctx.onShutdown(() => {
    watcher.detachAll();
    engine.dispose();
    engineRef = null;
  });
  const registerRolesUsage = () => {
    const roles = ctx.consume("roles.bindings");
    if (!roles) return;
    const dispose = roles.registerUsage("automation", () => {
      const discovered = listScopes().flatMap(
        (s) => scanAutomations(
          {
            ...s.scope === "folder" ? { repoRoot: s.base, scanFolder: true, scanGlobal: false } : {},
            ...s.scope === "global" ? { homeDir: s.base, scanGlobal: true, scanFolder: false } : {}
          },
          engine.registry.kinds(),
          engine.actionRegistry.ids(),
          engine.workSources.ids()
        )
      );
      return automationRoleUsage(discovered);
    });
    ctx.onShutdown(dispose);
  };
  try {
    ctx.fastify.addHook("onReady", async () => registerRolesUsage());
  } catch {
    registerRolesUsage();
  }
  const deliveryInFlight = /* @__PURE__ */ new Set();
  const runText = /* @__PURE__ */ new Map();
  const runPrompt = /* @__PURE__ */ new Map();
  const runCompletion = /* @__PURE__ */ new Map();
  let rescanTimer = null;
  ctx.onEvent(async (sessionId, rawEvent) => {
    const event = rawEvent;
    const session = ctx.sessionManager.getSession(sessionId);
    const stampedRunId = session?.automationRun?.runId;
    if (stampedRunId) {
      const pendingRun = engine.pendingForRunId(stampedRunId);
      if (pendingRun && !pendingRun.delivered && !deliveryInFlight.has(stampedRunId)) {
        deliveryInFlight.add(stampedRunId);
        runText.set(sessionId, []);
        if (pendingRun.emitEvent?.completion) runCompletion.set(sessionId, pendingRun.emitEvent.completion);
        if (pendingRun.promptText) runPrompt.set(sessionId, pendingRun.promptText);
        try {
          engine.onSessionRegisteredForRun(sessionId, stampedRunId);
          const delivered = pendingRun.emitEvent ? await ctx.emitEventToSession(sessionId, pendingRun.emitEvent.eventType, pendingRun.emitEvent.data) : pendingRun.promptText ? await ctx.sendToSession(sessionId, pendingRun.promptText) : false;
          if (delivered !== true) throw new Error("automation-action-delivery-unconfirmed");
        } catch (err) {
          runPrompt.delete(sessionId);
          runText.delete(sessionId);
          runCompletion.delete(sessionId);
          engine.onSessionDeath(sessionId);
          logger.warn("automation action delivery failed for runId=" + stampedRunId + ": " + (err instanceof Error ? err.message : String(err)));
        } finally {
          deliveryInFlight.delete(stampedRunId);
        }
      }
    }
    if (runText.has(sessionId)) {
      const text = extractAssistantText(event, runPrompt.get(sessionId));
      if (text) runText.get(sessionId).push(text);
      const completion = runCompletion.get(sessionId);
      if (completion && event?.eventType === completion.eventType) {
        const buffered = (runText.get(sessionId) ?? []).join("\n\n").trim();
        runText.delete(sessionId);
        runCompletion.delete(sessionId);
        logger.info(`[finalize] path=completion-event (${completion.eventType}) session=${sessionId}`);
        engine.onSessionEnded(sessionId, buffered || (completion.summarize?.(event?.data) ?? ""));
      } else if (event?.eventType === "agent_end") {
        logger.info(`[finalize] path=agent_end session=${sessionId}`);
        const result = (runText.get(sessionId) ?? []).join("\n\n").trim();
        runText.delete(sessionId);
        runPrompt.delete(sessionId);
        runCompletion.delete(sessionId);
        engine.onSessionEnded(sessionId, result);
      }
    }
    if (started && !rescanTimer) {
      rescanTimer = setTimeout(() => {
        rescanTimer = null;
        engine.refresh();
        attachWatchers();
      }, RESCAN_DEBOUNCE_MS);
      if (typeof rescanTimer.unref === "function") rescanTimer.unref();
    }
  });
  ctx.onSessionEnded((sessionId) => {
    if (runText.has(sessionId)) logger.info(`[finalize] path=session-death session=${sessionId}`);
    const buffered = (runText.get(sessionId) ?? []).join("\n\n").trim();
    runText.delete(sessionId);
    runPrompt.delete(sessionId);
    runCompletion.delete(sessionId);
    engine.onSessionDeath(sessionId, buffered);
  });
  ctx.onShutdown(() => {
    if (rescanTimer) clearTimeout(rescanTimer);
  });
  void PLUGIN_ID;
}
function extractAssistantText(event, promptText) {
  if (!event?.data) return null;
  if (event.eventType !== "turn_end") return null;
  const d = event.data;
  const message = d.message;
  const role = message?.role ?? d.role;
  if (role !== "assistant") return null;
  const trimmed = concatText(message?.content ?? d.content ?? d.text).trim();
  if (trimmed.length === 0) return null;
  if (promptText && trimmed === promptText.trim()) return null;
  return trimmed;
}
function concatText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => !!b && typeof b === "object").filter((b) => b.type === "text" && typeof b.text === "string").map((b) => b.text).join("");
}
async function runNowViaEngine(scope, cwd, name) {
  const eng = engineRef;
  if (!eng) return { ok: false, error: "engine not ready" };
  const base = scope === "global" ? supplementalHomeDir() : cwd ? path.resolve(cwd) : process.cwd();
  const { scanAutomations: scanAutomations2 } = await import("./scanner.js");
  const found = scanAutomations2(
    scope === "global" ? { homeDir: base, scanGlobal: true, scanFolder: false } : { repoRoot: base, scanFolder: true, scanGlobal: false },
    eng.registry.kinds(),
    eng.actionRegistry.ids(),
    eng.workSources.ids()
  ).find((a) => a.name === name && a.scope === scope && a.valid);
  if (!found) return { ok: false, error: `automation "${name}" not found or invalid in ${scope} scope` };
  const r = eng.startRunFor(found);
  return r ? { ok: true, runId: r.runId } : { ok: false, error: "run not started" };
}
async function runWorkItemViaEngine(cwd, key, name) {
  const eng = engineRef;
  if (!eng) return { ok: false, error: "engine not ready" };
  const base = path.resolve(cwd);
  const { scanAutomations: scanAutomations2 } = await import("./scanner.js");
  const batch = scanAutomations2(
    { repoRoot: base, scanFolder: true, scanGlobal: false },
    eng.registry.kinds(),
    eng.actionRegistry.ids(),
    eng.workSources.ids()
  ).filter((a) => a.valid && a.config?.on.kind === "schedule.batch");
  if (name) {
    const byName = batch.find((a) => a.name === name);
    if (!byName) return { ok: false, error: `no schedule.batch automation "${name}" for workspace` };
    return eng.runWorkItem(byName, key);
  }
  if (batch.length === 0) return { ok: false, error: "no work-source automation for workspace" };
  if (batch.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      error: `${batch.length} schedule.batch automations in workspace; specify a name`
    };
  }
  return eng.runWorkItem(batch[0], key);
}
async function stopRunViaEngine(runId) {
  const eng = engineRef;
  if (!eng) return { ok: false, error: "engine not ready" };
  return await eng.stopRun(runId) ? { ok: true } : { ok: false, error: `run "${runId}" not running or already finished` };
}
var stdin_default = registerPlugin;
export {
  CORE_ACTION_KEY,
  stdin_default as default,
  extractAssistantText,
  registerPlugin
};
