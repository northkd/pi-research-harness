import { supplementalHomeDir } from "../../runtime-home.mjs";
import path from "node:path";
import { BUILTIN_ACTION_ALIASES } from "../shared/automation-types.js";
const FALLBACK_KINDS = /* @__PURE__ */ new Set(["schedule"]);
function scopeBaseFor(scope, cwd) {
  return scope === "global" ? supplementalHomeDir() : cwd ?? process.cwd();
}
const BUILTIN_ACTION_KINDS = new Set(Object.keys(BUILTIN_ACTION_ALIASES));
function unknownActionKind(config, ids) {
  const acceptable = (kind2) => typeof kind2 === "string" && kind2.length > 0 && (BUILTIN_ACTION_KINDS.has(kind2) || !!ids?.has(kind2));
  if (Array.isArray(config?.actions)) {
    for (let i = 0; i < config.actions.length; i++) {
      const kind2 = config.actions[i]?.kind;
      if (typeof kind2 !== "string" || kind2.length === 0) continue;
      if (!acceptable(kind2)) return `actions[${i}]: ${kind2}`;
    }
    return void 0;
  }
  const kind = config?.action?.kind;
  if (typeof kind !== "string" || kind.length === 0) return void 0;
  if (acceptable(kind)) return void 0;
  return kind;
}
function mountAutomationRoutes(fastify, hooks = {}) {
  fastify.post("/api/plugins/automation/run", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.name) {
      reply.code(400);
      return { error: "name required" };
    }
    if (!hooks.runNow) {
      reply.code(503);
      return { error: "automation engine not ready" };
    }
    const res = await hooks.runNow({
      scope: body.scope ?? "folder",
      ...body.cwd ? { cwd: body.cwd } : {},
      name: body.name
    });
    if (!res.ok) {
      reply.code(400);
      return { error: res.error ?? "run failed" };
    }
    return { ok: true, ...res.runId ? { runId: res.runId } : {} };
  });
  fastify.post("/api/plugins/automation/stop", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.runId) {
      reply.code(400);
      return { error: "runId required" };
    }
    if (!hooks.stopRun) {
      reply.code(503);
      return { error: "automation engine not ready" };
    }
    const res = await hooks.stopRun({
      scope: body.scope ?? "folder",
      ...body.cwd ? { cwd: body.cwd } : {},
      runId: body.runId
    });
    if (!res.ok) {
      reply.code(400);
      return { error: res.error ?? "stop failed" };
    }
    return { ok: true };
  });
  fastify.get("/api/plugins/automation/actions", async (req) => {
    const q = req.query ?? {};
    if (!hooks.listActions) return { actions: [] };
    return { actions: hooks.listActions(q.cwd) };
  });
  fastify.get("/api/plugins/automation/trigger-kinds", async () => {
    const { TriggerRegistry, deriveTriggerTaxonomy } = await import("./trigger-registry.js");
    const { scheduleTrigger } = await import("./schedule-trigger.js");
    const registry = new TriggerRegistry();
    registry.register(scheduleTrigger);
    return { categories: deriveTriggerTaxonomy(registry) };
  });
  fastify.get("/api/plugins/automation/git-capable", async (req) => {
    const q = req.query ?? {};
    if (!q.cwd) return { gitCapable: false };
    const { execFileSync } = await import("../../shared/platform/exec.js");
    try {
      const out = execFileSync("git", ["-C", q.cwd, "rev-parse", "--is-inside-work-tree"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"]
      });
      return { gitCapable: out.trim() === "true" };
    } catch {
      return { gitCapable: false };
    }
  });
  fastify.get("/api/plugins/automation/list", async (req) => {
    const q = req.query ?? {};
    const { scanAutomations } = await import("./scanner.js");
    const homeDir = supplementalHomeDir();
    const globalOn = hooks.scanGlobalScope?.() ?? true;
    const scanFolder = !!q.cwd && !(globalOn && path.resolve(q.cwd) === path.resolve(homeDir));
    const automations = scanAutomations(
      { repoRoot: q.cwd, homeDir, scanFolder, scanGlobal: true },
      hooks.triggerKinds?.() ?? FALLBACK_KINDS,
      hooks.actionIds?.(),
      hooks.workSourceIds?.()
    );
    return { automations };
  });
  fastify.get("/api/plugins/automation/runs", async (req) => {
    const q = req.query ?? {};
    const { listRuns, readChildRuns } = await import("./run-store.js");
    const base = scopeBaseFor(q.scope ?? "folder", q.cwd);
    const runs = listRuns(base, q.name).map(
      (rec) => rec.children ? { ...rec, childRuns: readChildRuns(base, rec) } : rec
    );
    return { runs };
  });
  fastify.get("/api/plugins/automation/result", async (req, reply) => {
    const q = req.query ?? {};
    const fs = await import("node:fs");
    const path2 = await import("node:path");
    const { findRunBySessionId, resolveRunDir } = await import("./run-store.js");
    if (!q.runId && q.sessionId) {
      const scopes = q.scope ? [q.scope] : ["folder", "global"];
      for (const scope of scopes) {
        const base2 = scopeBaseFor(scope, q.cwd);
        const rec = findRunBySessionId(base2, q.sessionId);
        if (!rec) continue;
        const dir2 = resolveRunDir(base2, rec.runId);
        let result;
        try {
          if (dir2) result = fs.readFileSync(path2.join(dir2, "result.md"), "utf-8");
        } catch {
        }
        return { status: rec.status, runId: rec.runId, name: rec.name, ...result !== void 0 ? { result } : {} };
      }
      reply.code(404);
      return { error: "run not found" };
    }
    if (!q.runId) {
      reply.code(400);
      return { error: "runId or sessionId required" };
    }
    const base = scopeBaseFor(q.scope ?? "folder", q.cwd);
    const dir = resolveRunDir(base, q.runId);
    if (!dir) {
      reply.code(404);
      return { error: "result not found" };
    }
    try {
      return { result: fs.readFileSync(path2.join(dir, "result.md"), "utf-8") };
    } catch {
      reply.code(404);
      return { error: "result not found" };
    }
  });
  fastify.post("/api/plugins/automation/create", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.name || !body.config) {
      reply.code(400);
      return { error: "name and config required" };
    }
    const { writeAutomation, isValidAutomationName } = await import("./automation-writer.js");
    if (!isValidAutomationName(body.name)) {
      reply.code(400);
      return { error: `invalid automation name: "${body.name}"` };
    }
    const badKind = unknownActionKind(body.config, hooks.actionIds?.());
    if (badKind) {
      reply.code(400);
      return { error: `unknown action kind: "${badKind}"` };
    }
    const scope = body.scope ?? "folder";
    const base = scopeBaseFor(scope, body.cwd);
    try {
      const result = writeAutomation({
        scopeBase: base,
        name: body.name,
        config: body.config,
        ...body.promptBody !== void 0 ? { promptBody: body.promptBody } : {}
      });
      return { ok: true, scope, dir: result.dir };
    } catch (e) {
      reply.code(400);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
  fastify.post("/api/plugins/automation/update", async (req, reply) => {
    const body = req.body ?? {};
    if (!body.name || !body.config) {
      reply.code(400);
      return { error: "name and config required" };
    }
    const { writeAutomation, isValidAutomationName } = await import("./automation-writer.js");
    if (!isValidAutomationName(body.name)) {
      reply.code(400);
      return { error: `invalid automation name: "${body.name}"` };
    }
    const badKind = unknownActionKind(body.config, hooks.actionIds?.());
    if (badKind) {
      reply.code(400);
      return { error: `unknown action kind: "${badKind}"` };
    }
    const scope = body.scope ?? "folder";
    const base = scopeBaseFor(scope, body.cwd);
    try {
      const result = writeAutomation({
        scopeBase: base,
        name: body.name,
        config: body.config,
        intent: "update",
        ...body.promptBody !== void 0 ? { promptBody: body.promptBody } : {}
      });
      return { ok: true, scope, dir: result.dir };
    } catch (e) {
      reply.code(400);
      return { error: e instanceof Error ? e.message : String(e) };
    }
  });
  fastify.get("/api/plugins/automation/definition", async (req, reply) => {
    const q = req.query ?? {};
    if (!q.name) {
      reply.code(400);
      return { error: "name required" };
    }
    const { isValidAutomationName } = await import("./automation-writer.js");
    if (!isValidAutomationName(q.name)) {
      reply.code(400);
      return { error: `invalid automation name: "${q.name}"` };
    }
    const fs = await import("node:fs");
    const path2 = await import("node:path");
    const { parseAutomationYaml } = await import("./automation-schema.js");
    const base = scopeBaseFor(q.scope ?? "folder", q.cwd);
    const dir = path2.join(base, ".pi", "automation", q.name);
    let rawText;
    try {
      rawText = fs.readFileSync(path2.join(dir, "automation.yaml"), "utf-8");
    } catch {
      reply.code(404);
      return { error: "automation not found" };
    }
    const { config, error } = parseAutomationYaml(
      rawText,
      hooks.triggerKinds?.() ?? FALLBACK_KINDS,
      hooks.actionIds?.(),
      hooks.workSourceIds?.()
    );
    if (!config) {
      reply.code(422);
      return { error: error ?? "invalid automation.yaml" };
    }
    let promptBody;
    if (config.action?.kind === "prompt") {
      try {
        promptBody = fs.readFileSync(path2.join(dir, "prompt.md"), "utf-8");
      } catch {
        promptBody = "";
      }
    }
    return { config, ...promptBody !== void 0 ? { promptBody } : {} };
  });
  fastify.delete("/api/plugins/automation", async (req, reply) => {
    const q = req.query ?? {};
    if (!q.name) {
      reply.code(400);
      return { error: "name required" };
    }
    const { deleteAutomation } = await import("./automation-writer.js");
    const base = scopeBaseFor(q.scope ?? "folder", q.cwd);
    return { ok: deleteAutomation(base, q.name) };
  });
}
export {
  mountAutomationRoutes,
  unknownActionKind
};
