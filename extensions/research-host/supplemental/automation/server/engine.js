import { supplementalHomeDir } from "../../runtime-home.mjs";
import fs from "node:fs";
import path from "node:path";
import { isReservedEventType } from "../../shared/protocol.js";
import {
  createActionRegistryWithBuiltins,
  normalizeActionKind
} from "./action-registry.js";
import { fileTrigger } from "./file-trigger.js";
import { interpolate } from "./interpolate.js";
import { resolveModel } from "./model-resolver.js";
import {
  DEFAULT_MAX_CONCURRENT_SPAWNS,
  effectiveBound,
  resolveChildren
} from "./resolve-children.js";
import {
  listRuns as storeListRuns,
  listStaleRunningRuns,
  readChildRuns as storeReadChildRuns,
  finishParentRun as storeFinishParentRun,
  finishRun as storeFinishRun,
  setSessionId as storeSetSessionId,
  startChildRun as storeStartChildRun,
  startParentRun as storeStartParentRun
} from "./run-store.js";
import { createRunner } from "./runner.js";
import { scanAutomations } from "./scanner.js";
import { scheduleBatchTrigger } from "./schedule-batch-trigger.js";
import { scheduleTrigger } from "./schedule-trigger.js";
import { automationKey, createScheduler } from "./scheduler.js";
import { TriggerRegistry } from "./trigger-registry.js";
import { WorkSourceRegistry } from "./work-source-registry.js";
function buildRunPrompt(automation, actionRegistry, resolvedPayload) {
  const action = automation.config?.action;
  if (!action) return "";
  const payload = resolvedPayload ?? action.payload ?? {};
  const reg = actionRegistry?.get(normalizeActionKind(action.kind));
  if (reg) {
    return reg.buildPrompt ? reg.buildPrompt({ payload, automation }).trim() : "";
  }
  if (action.kind === "skill") {
    return action.skill.startsWith("$") ? action.skill : `$${action.skill}`;
  }
  if (action.prompt) {
    const promptPath = path.isAbsolute(action.prompt) ? action.prompt : path.join(automation.dir, action.prompt);
    try {
      return fs.readFileSync(promptPath, "utf-8").trim();
    } catch {
      return "";
    }
  }
  return "";
}
function buildRunDispatch(automation, actionRegistry, ctx) {
  const action = automation.config?.action;
  if (!action) return { kind: "prompt", text: "" };
  const payload = interpolate(action.payload ?? {}, ctx?.value);
  const reg = actionRegistry?.get(normalizeActionKind(action.kind));
  if (reg?.buildEvent) {
    const ev = reg.buildEvent({ payload, automation });
    if (ev && typeof ev.eventType === "string" && ev.eventType.length > 0) {
      if (isReservedEventType(ev.eventType) || !reg.emits?.includes(ev.eventType)) {
        return {
          kind: "refused",
          reason: `action "${reg.id}" tried to emit undeclared or reserved event "${ev.eventType}"`
        };
      }
      return {
        kind: "event",
        eventType: ev.eventType,
        ...ev.data ? { data: ev.data } : {},
        ...ev.completion ? { completion: ev.completion } : {}
      };
    }
    return { kind: "prompt", text: "" };
  }
  return { kind: "prompt", text: buildRunPrompt(automation, actionRegistry, payload) };
}
function effectiveVisibility(automation, settingsDefault) {
  return automation.config.visibility ?? settingsDefault;
}
function normalize(p) {
  return p.replace(/[/\\]+$/, "");
}
function createEngine(deps) {
  const log = deps.log ?? (() => {
  });
  const warn = deps.warn ?? ((m) => console.warn(m));
  const homeDir = deps.homeDir ?? supplementalHomeDir();
  const registry = new TriggerRegistry();
  registry.register(scheduleTrigger);
  registry.register(scheduleBatchTrigger);
  registry.register(fileTrigger);
  const workSources = deps.workSources ?? new WorkSourceRegistry();
  const resolveRegistry = deps.resolveRegistry ?? (() => createActionRegistryWithBuiltins({ warn }));
  const pending = /* @__PURE__ */ new Map();
  const parents = /* @__PURE__ */ new Map();
  function enqueuePending(ctx) {
    const q = pending.get(ctx.cwd) ?? [];
    q.push(ctx);
    pending.set(ctx.cwd, q);
  }
  function removePending(ctx) {
    const q = pending.get(ctx.cwd);
    if (!q) return;
    const i = q.indexOf(ctx);
    if (i >= 0) q.splice(i, 1);
    if (q.length === 0) pending.delete(ctx.cwd);
  }
  function firstUndeliveredForCwd(cwd) {
    return (pending.get(normalize(cwd)) ?? []).find((c) => !c.delivered);
  }
  function firstUndeliveredForRunId(runId) {
    for (const q of pending.values()) {
      const hit = q.find((c) => c.runId === runId && !c.delivered);
      if (hit) return hit;
    }
    return void 0;
  }
  function findBySession(sessionId) {
    for (const q of pending.values()) {
      const hit = q.find((c) => c.sessionId === sessionId);
      if (hit) return hit;
    }
    return void 0;
  }
  function findByRunId(runId) {
    for (const q of pending.values()) {
      const hit = q.find((c) => c.runId === runId);
      if (hit) return hit;
    }
    return void 0;
  }
  function reapStaleRuns() {
    const cfg = deps.config();
    const maxAgeMs = cfg.maxRunAgeMs;
    if (!maxAgeMs || maxAgeMs <= 0) return;
    const now = deps.now?.() ?? Date.now();
    const seenBases = /* @__PURE__ */ new Set();
    for (const s of deps.listScopes()) {
      if (seenBases.has(s.base)) continue;
      seenBases.add(s.base);
      let stale;
      try {
        stale = listStaleRunningRuns(s.base, maxAgeMs, now);
      } catch {
        continue;
      }
      for (const rec of stale) {
        const ctx = findByRunId(rec.runId);
        if (ctx) {
          finalizeChild(ctx, {
            status: "error",
            error: "run exceeded max age",
            result: "_(run exceeded max age)_"
          });
          if ((ctx.sessionId || ctx.spawnToken) && deps.abortSpawnedRun) {
            const warnAbort = (e) => warn(`[engine] reaper abort failed for ${rec.runId}: ${e instanceof Error ? e.message : String(e)}`);
            try {
              void Promise.resolve(
                deps.abortSpawnedRun({
                  ...ctx.sessionId ? { sessionId: ctx.sessionId } : {},
                  ...ctx.spawnToken ? { spawnToken: ctx.spawnToken } : {}
                })
              ).catch(warnAbort);
            } catch (e) {
              warnAbort(e);
            }
          }
        } else {
          storeFinishRun(s.base, rec.runId, {
            status: "error",
            error: "run exceeded max age",
            result: "_(run exceeded max age)_",
            retention: cfg.retention
          });
        }
        warn(`[finalize] path=reaper run ${rec.runId} (running > ${maxAgeMs}ms)`);
      }
      let records;
      try {
        records = storeListRuns(s.base);
      } catch {
        continue;
      }
      for (const rec of records) {
        if (!rec.children || rec.status !== "running" || parents.has(rec.runId)) continue;
        if (now - rec.startedAt <= maxAgeMs) continue;
        const kids = storeReadChildRuns(s.base, rec);
        if (kids.some((k) => k.status === "running")) continue;
        storeFinishParentRun(s.base, rec.runId, {
          status: aggregateStatus(kids.map((k) => k.status)),
          findings: kids.reduce((n, k) => n + (k.findings ?? 0), 0),
          retention: cfg.retention
        });
        warn(`[finalize] path=reaper orphan parent ${rec.runId} (no live state)`);
      }
    }
  }
  function aggregateStatus(statuses) {
    if (statuses.some((s) => s === "error")) return "error";
    if (statuses.length > 0 && statuses.every((s) => s === "stopped")) return "stopped";
    return "done";
  }
  function finalizeParent(parent) {
    if (parent.finalized) return;
    parent.finalized = true;
    const cfg = deps.config();
    storeFinishParentRun(parent.scopeBase, parent.parentRunId, {
      status: aggregateStatus(parent.statuses),
      findings: parent.findings,
      ...parent.warning ? { warning: parent.warning } : {},
      retention: cfg.retention
    });
    parents.delete(parent.parentRunId);
    if (parent.runnerManaged !== false) runner.completeRun(parent.key);
    log(`[engine] parent run ${parent.parentRunId} finalized (${parent.key})`);
  }
  function finalizeChild(ctx, fin) {
    if (ctx.finalized) return;
    ctx.finalized = true;
    const cfg = deps.config();
    const rec = storeFinishRun(ctx.scopeBase, ctx.runId, {
      status: fin.status,
      ...fin.result !== void 0 ? { result: fin.result } : {},
      ...fin.error ? { error: fin.error } : {},
      retention: cfg.retention
    });
    removePending(ctx);
    if (ctx.lease) {
      try {
        if (fin.status === "done") ctx.lease.source.ack(ctx.lease.token);
        else ctx.lease.source.nack(ctx.lease.token);
      } catch (e) {
        warn(`[engine] lease release failed for ${ctx.runId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const findings = rec?.findings ?? 0;
    const parent = parents.get(ctx.parentRunId);
    if (parent) {
      parent.remaining -= 1;
      parent.statuses.push(fin.status);
      parent.findings += findings;
      if (parent.remaining <= 0) finalizeParent(parent);
    } else {
      runner.completeRun(ctx.key);
    }
  }
  async function stopChild(ctx) {
    if (ctx.finalized) return;
    if (ctx.sessionId || ctx.spawnToken) {
      if (deps.abortSpawnedRun) {
        try {
          await deps.abortSpawnedRun({
            ...ctx.sessionId ? { sessionId: ctx.sessionId } : {},
            ...ctx.spawnToken ? { spawnToken: ctx.spawnToken } : {}
          });
        } catch (e) {
          warn(`[engine] abort failed for ${ctx.runId}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      finalizeChild(ctx, { status: "stopped", result: "_(stopped by user)_", error: "stopped by user" });
      return;
    }
    ctx.stopRequested = true;
  }
  function scopeBaseFor(a) {
    const marker = path.join(".pi", "automation");
    const idx = a.dir.indexOf(marker);
    if (idx >= 0) return a.dir.slice(0, idx).replace(/[/\\]+$/, "");
    return a.scope === "global" ? homeDir : a.dir;
  }
  const runner = createRunner({
    startRun: (automation, ctx) => {
      const r = startRunFor(automation, ctx);
      return r ? { runId: r.runId } : null;
    },
    log,
    warn
  });
  const scheduler = createScheduler({
    registry,
    onFire: (automation, ctx) => runner.fire(automation, ctx),
    now: deps.now,
    log,
    warn
  });
  const REAP_INTERVAL_MS = 6e4;
  let reapTimer = null;
  function spawnChild(parent, childAutomation, actionLabel, runCwd, resolved, vis, fireCtx, extra) {
    let ctx;
    try {
      const dispatch = buildRunDispatch(childAutomation, resolveRegistry(), fireCtx);
      const promptText = dispatch.kind === "prompt" ? dispatch.text : "";
      const childRec = storeStartChildRun(parent.scopeBase, parent.parentRunId, parent.name, {
        actionLabel
      });
      if (dispatch.kind === "refused") {
        const refusedCtx = {
          key: parent.key,
          runId: childRec.runId,
          parentRunId: parent.parentRunId,
          actionLabel,
          scopeBase: parent.scopeBase,
          automation: childAutomation,
          cwd: normalize(runCwd),
          promptText: "",
          ...extra?.lease ? { lease: extra.lease } : {},
          ...extra?.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {},
          delivered: false
        };
        ctx = refusedCtx;
        throw new Error(dispatch.reason);
      }
      ctx = {
        key: parent.key,
        runId: childRec.runId,
        parentRunId: parent.parentRunId,
        actionLabel,
        scopeBase: parent.scopeBase,
        automation: childAutomation,
        cwd: normalize(runCwd),
        promptText,
        ...extra?.lease ? { lease: extra.lease } : {},
        ...extra?.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {},
        ...dispatch.kind === "event" ? {
          emitEvent: {
            eventType: dispatch.eventType,
            ...dispatch.data ? { data: dispatch.data } : {},
            ...dispatch.completion ? { completion: dispatch.completion } : {}
          }
        } : {},
        ...resolved.error ? { modelError: resolved.error } : {},
        delivered: false
      };
      const c = ctx;
      enqueuePending(c);
      void deps.spawnSession({
        cwd: runCwd,
        // An ACP agent owns its model: never pass one alongside `agent`.
        ...childAutomation.config.agent ? { agent: childAutomation.config.agent } : resolved.model ? { model: resolved.model } : {},
        mode: childAutomation.config.mode,
        sandbox: childAutomation.config.sandbox,
        // `name` → `--name` (core-reserved ref key, travels as a top-level opt).
        name: parent.name,
        // Automation identity lives only inside its own ref now; the host merges
        // `kind`/`automationRun`/`lifecyclePolicy` onto the session verbatim.
        // `lifecyclePolicy:"ephemeral"` keeps the reaper/caps producers real
        // (was stamped by the removed host automation arm). See change:
        // detach-automation-goal-from-core.
        pluginRef: {
          kind: "automation",
          automationRun: {
            name: parent.name,
            runId: childRec.runId,
            visibility: vis,
            ...extra?.idempotencyKey ? { idempotencyKey: extra.idempotencyKey } : {}
          },
          lifecyclePolicy: "ephemeral"
        },
        // Machine-fronted, one-shot: opt out of recovery + finalize on WS close
        // (replaces core's former `kind==="automation"` lifecycle branches).
        // `archiveOnEnd`: disposable once ended, hidden or shown — the run's
        // durable output is its run record + result.md, which the Automation
        // view reads. See change: archive-service-sessions-on-end.
        lifecycle: { recover: false, finalizeOnSocketClose: true, archiveOnEnd: true },
        // Unattended: a run's ask_user question must not silently expire at the
        // global timeout; it stays answerable until answered, stopped or reaped.
        // See change: add-pending-question-stack (D11).
        scope: { extensionConfig: { "pi-dashboard": { askUserPromptTimeoutSeconds: "0" } } }
      }).then((res) => {
        if (!res.success) {
          warn(`[engine] spawn failed for ${c.key}/${c.runId}: ${res.message ?? "unknown"}`);
          finalizeChild(c, { status: "error", error: res.message ?? "session start failed" });
          return;
        }
        if (res.spawnToken) c.spawnToken = res.spawnToken;
        if (c.stopRequested && !c.finalized) {
          if (deps.abortSpawnedRun) {
            void deps.abortSpawnedRun({
              ...c.sessionId ? { sessionId: c.sessionId } : {},
              ...res.spawnToken ? { spawnToken: res.spawnToken } : {}
            }).catch(
              (e) => warn(
                `[engine] spawn-window abort failed for ${c.runId}: ${e instanceof Error ? e.message : String(e)}`
              )
            );
          }
          finalizeChild(c, {
            status: "stopped",
            result: "_(stopped by user)_",
            error: "stopped by user"
          });
        }
      }).catch((e) => {
        warn(`[engine] spawn threw for ${c.key}/${c.runId}: ${e instanceof Error ? e.message : String(e)}`);
        finalizeChild(c, { status: "error", error: e instanceof Error ? e.message : String(e) });
      });
      log(`[engine] started child run ${childRec.runId} (${c.key}) model=${resolved.model || "(default)"}`);
    } catch (e) {
      warn(`[engine] child setup failed for ${parent.key}: ${e instanceof Error ? e.message : String(e)}`);
      const failed = ctx;
      const err = e instanceof Error ? e.message : String(e);
      queueMicrotask(() => {
        if (failed) {
          finalizeChild(failed, { status: "error", error: err });
          return;
        }
        if (extra?.lease) {
          try {
            extra.lease.source.nack(extra.lease.token);
          } catch {
          }
        }
        parent.remaining -= 1;
        parent.statuses.push("error");
        if (parent.remaining <= 0) finalizeParent(parent);
      });
    }
  }
  function startWorkSourceFire(automation, sourceId, env) {
    const { cfg, scopeBase, runCwd, vis, resolved, bound } = env;
    const settleParent = (status) => {
      const rec = storeStartParentRun(scopeBase, automation.name, {});
      storeFinishParentRun(scopeBase, rec.runId, { status, findings: 0, retention: cfg.retention });
    };
    const source = workSources.get(sourceId);
    if (!source) {
      warn(`[engine] work source "${sourceId}" not registered for ${automation.name}`);
      settleParent("error");
      return null;
    }
    let handles;
    try {
      handles = source.next(bound);
    } catch (e) {
      warn(
        `[engine] work source "${sourceId}" next() failed for ${automation.name}: ${e instanceof Error ? e.message : String(e)}`
      );
      settleParent("error");
      return null;
    }
    if (handles.length === 0) {
      settleParent("done");
      log(`[engine] work-source fire ${automation.name} vended 0 items (no-op)`);
      return null;
    }
    const base = resolveChildren(automation, 1).specs[0];
    if (!base) {
      for (const h of handles) source.nack(h.leaseToken);
      settleParent("error");
      return null;
    }
    const parentRec = storeStartParentRun(scopeBase, automation.name, {});
    const parent = {
      parentRunId: parentRec.runId,
      key: automationKey(automation),
      scopeBase,
      name: automation.name,
      remaining: handles.length,
      statuses: [],
      findings: 0,
      finalized: false
    };
    parents.set(parent.parentRunId, parent);
    const firedAt = env.firedAt ?? (deps.now?.() ?? Date.now());
    for (const handle of handles) {
      const childAutomation = {
        ...automation,
        config: { ...automation.config, action: base.action, actions: void 0 }
      };
      const childCtx = { firedAt, value: handle.item };
      spawnChild(parent, childAutomation, base.actionLabel, runCwd, resolved, vis, childCtx, {
        lease: { source, token: handle.leaseToken },
        idempotencyKey: handle.idempotencyKey
      });
    }
    log(
      `[engine] started parent run ${parentRec.runId} (${parent.key}) work-source children=${handles.length}`
    );
    return { runId: parentRec.runId };
  }
  async function runWorkItem(automation, key) {
    if (!automation.valid || !automation.config) return { ok: false, error: "automation invalid" };
    const on = automation.config.on;
    const sourceId = on.kind === "schedule.batch" && typeof on.source === "string" ? on.source : void 0;
    if (!sourceId) return { ok: false, reason: "unsupported", error: "automation has no work source" };
    const source = workSources.get(sourceId);
    if (!source) return { ok: false, error: `work source "${sourceId}" not registered` };
    if (typeof source.take !== "function") {
      return { ok: false, reason: "unsupported", error: `work source "${sourceId}" cannot address items by key` };
    }
    const cfg = deps.config();
    const scopeBase = scopeBaseFor(automation);
    const wsCtx = { cwd: scopeBase };
    let handle;
    try {
      handle = await source.take(key, wsCtx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`[engine] work source "${sourceId}" take(${key}) failed: ${msg}`);
      return { ok: false, error: msg };
    }
    if (!handle) {
      log(`[engine] work item ${key}: unavailable (leased or gone); refusing`);
      return { ok: false, reason: "in_flight" };
    }
    const base = resolveChildren(automation, 1).specs[0];
    if (!base) {
      try {
        source.nack(handle.leaseToken);
      } catch {
      }
      return { ok: false, error: "automation resolves no action" };
    }
    try {
      const vis = effectiveVisibility(automation, cfg.defaultVisibility);
      const resolved = resolveModel(automation.config.model, {
        defaultModel: cfg.defaultModel,
        ...deps.readRoles ? { readRoles: deps.readRoles } : {}
      });
      const parentRec = storeStartParentRun(scopeBase, automation.name, {});
      const parent = {
        parentRunId: parentRec.runId,
        key: automationKey(automation),
        scopeBase,
        name: automation.name,
        remaining: 1,
        statuses: [],
        findings: 0,
        finalized: false,
        // Targeted run: bypasses the runner, so its finalize must not release a
        // runner slot it never acquired. See change: work-source-seam.
        runnerManaged: false
      };
      parents.set(parent.parentRunId, parent);
      const childAutomation = {
        ...automation,
        config: { ...automation.config, action: base.action, actions: void 0 }
      };
      const childCtx = { firedAt: deps.now?.() ?? Date.now(), value: handle.item };
      spawnChild(parent, childAutomation, base.actionLabel, scopeBase, resolved, vis, childCtx, {
        lease: { source, token: handle.leaseToken },
        idempotencyKey: handle.idempotencyKey
      });
      return { ok: true, runId: parent.parentRunId };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      warn(`[engine] work item ${key}: setup failed after lease, releasing: ${msg}`);
      try {
        source.nack(handle.leaseToken);
      } catch {
      }
      return { ok: false, error: msg };
    }
  }
  function startRunFor(automation, fireCtx) {
    if (!automation.valid || !automation.config) return null;
    const cfg = deps.config();
    const scopeBase = scopeBaseFor(automation);
    const runCwd = scopeBase;
    const vis = effectiveVisibility(automation, cfg.defaultVisibility);
    const resolved = resolveModel(automation.config.model, {
      defaultModel: cfg.defaultModel,
      ...deps.readRoles ? { readRoles: deps.readRoles } : {}
    });
    const bound = effectiveBound(
      automation,
      cfg.maxConcurrentSpawns ?? DEFAULT_MAX_CONCURRENT_SPAWNS
    );
    const workSourceId = automation.config.on.kind === "schedule.batch" && typeof automation.config.on.source === "string" ? automation.config.on.source : void 0;
    if (workSourceId) {
      return startWorkSourceFire(automation, workSourceId, {
        cfg,
        scopeBase,
        runCwd,
        vis,
        resolved,
        bound,
        firedAt: fireCtx?.firedAt
      });
    }
    const { specs, truncated } = resolveChildren(automation, bound);
    if (specs.length === 0) return null;
    const warning = truncated > 0 ? `bounded to ${bound} concurrent session(s); ${truncated} child(ren) not started` : void 0;
    const parentRec = storeStartParentRun(scopeBase, automation.name, {
      ...warning ? { warning } : {}
    });
    const parent = {
      parentRunId: parentRec.runId,
      key: automationKey(automation),
      scopeBase,
      name: automation.name,
      remaining: specs.length,
      statuses: [],
      findings: 0,
      ...warning ? { warning } : {},
      finalized: false
    };
    parents.set(parent.parentRunId, parent);
    for (const spec of specs) {
      const childAutomation = {
        ...automation,
        config: { ...automation.config, action: spec.action, actions: void 0 }
      };
      spawnChild(parent, childAutomation, spec.actionLabel, runCwd, resolved, vis, fireCtx);
    }
    log(`[engine] started parent run ${parentRec.runId} (${parent.key}) children=${specs.length}`);
    return { runId: parentRec.runId };
  }
  return {
    scheduler,
    runner,
    registry,
    workSources,
    runWorkItem,
    get actionRegistry() {
      return resolveRegistry();
    },
    start() {
      this.refresh();
      if (!reapTimer) {
        reapTimer = setInterval(() => reapStaleRuns(), REAP_INTERVAL_MS);
        if (typeof reapTimer.unref === "function") reapTimer.unref();
      }
    },
    reapStaleRuns,
    refresh() {
      const scopes = deps.listScopes();
      const all = [];
      for (const s of scopes) {
        all.push(
          ...scanAutomations(
            {
              ...s.scope === "folder" ? { repoRoot: s.base, scanFolder: true, scanGlobal: false } : {},
              ...s.scope === "global" ? { homeDir: s.base, scanGlobal: true, scanFolder: false } : {}
            },
            registry.kinds(),
            resolveRegistry().ids(),
            workSources.ids()
          )
        );
      }
      scheduler.armAll(all);
      log(`[engine] armed ${scheduler.armedKeys().length} automation(s) across ${scopes.length} scope(s)`);
    },
    startRunFor,
    pendingForCwd(cwd) {
      return firstUndeliveredForCwd(cwd);
    },
    pendingForRunId(runId) {
      return firstUndeliveredForRunId(runId);
    },
    onSessionRegistered(sessionId, cwd) {
      const ctx = firstUndeliveredForCwd(cwd);
      if (!ctx) return;
      ctx.sessionId = sessionId;
      ctx.delivered = true;
      storeSetSessionId(ctx.scopeBase, ctx.runId, sessionId);
      log(`[engine] delivering action to run ${ctx.runId} (session ${sessionId})`);
    },
    onSessionRegisteredForRun(sessionId, runId) {
      const ctx = firstUndeliveredForRunId(runId);
      if (!ctx) return;
      ctx.sessionId = sessionId;
      ctx.delivered = true;
      storeSetSessionId(ctx.scopeBase, ctx.runId, sessionId);
      log(`[engine] delivering action to run ${ctx.runId} (session ${sessionId})`);
    },
    async stopRun(runId) {
      const parent = parents.get(runId);
      if (parent) {
        const children = [...pending.values()].flat().filter((c) => c.parentRunId === runId && !c.finalized);
        if (children.length === 0) return false;
        await Promise.all(children.map((c) => stopChild(c)));
        log(`[engine] parent run ${runId} stop cascaded to ${children.length} child(ren)`);
        return true;
      }
      const ctx = findByRunId(runId);
      if (!ctx || ctx.finalized) return false;
      await stopChild(ctx);
      log(`[engine] run ${ctx.runId} stopped (${ctx.key})`);
      return true;
    },
    onSessionEnded(sessionId, result) {
      const found = findBySession(sessionId);
      if (!found || found.finalized) return;
      const spawnToken = found.spawnToken;
      finalizeChild(found, {
        status: found.modelError ? "error" : "done",
        result,
        ...found.modelError ? { error: found.modelError } : {}
      });
      if (deps.abortSpawnedRun) {
        void deps.abortSpawnedRun({
          sessionId,
          ...spawnToken ? { spawnToken } : {},
          graceful: true
        });
      }
      log(`[engine] run ${found.runId} ended (${found.key})`);
    },
    onSessionDeath(sessionId, result) {
      const found = findBySession(sessionId);
      if (!found || found.finalized) return;
      const spawnToken = found.spawnToken;
      const buffered = (result ?? "").trim();
      if (buffered.length > 0) {
        finalizeChild(found, {
          status: found.modelError ? "error" : "done",
          result: buffered,
          ...found.modelError ? { error: found.modelError } : {}
        });
      } else {
        finalizeChild(found, {
          status: "error",
          error: found.modelError ?? "session ended before completion",
          result: "_(session ended before completion)_"
        });
      }
      if (deps.abortSpawnedRun) {
        void deps.abortSpawnedRun({ sessionId, ...spawnToken ? { spawnToken } : {} });
      }
      log(`[engine] run ${found.runId} finalized on session death (${found.key})`);
    },
    dispose() {
      scheduler.disposeAll();
      if (reapTimer) {
        clearInterval(reapTimer);
        reapTimer = null;
      }
      pending.clear();
      parents.clear();
    }
  };
}
export {
  buildRunDispatch,
  buildRunPrompt,
  createEngine,
  effectiveVisibility
};
