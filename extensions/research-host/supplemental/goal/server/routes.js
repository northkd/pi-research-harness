import { decorateGoalsWithSpend } from "./decorate-goals-spend.js";
import { GoalNotFoundError } from "./goal-store.js";
const TERMINAL_OR_PAUSED = /* @__PURE__ */ new Set(["paused", "cleared", "achieved", "failed"]);
const ABORT_REASON = {
  paused: "paused by user",
  cleared: "cleared by user",
  achieved: "achieved",
  failed: "failed by user"
};
const VALID_STATUS = /* @__PURE__ */ new Set(["pursuing", "paused", "achieved", "cleared"]);
function registerGoalRoutes(fastify, deps) {
  const { sessionManager, knownFolderCwds, networkGuard, store, applyGoalIdToSession, primeGoalSession, spawnGoalSession, abortGoalSupervision } = deps;
  const spendLookup = { get: (id) => sessionManager.getSession(id) };
  const withSpend = (record) => decorateGoalsWithSpend([record], spendLookup)[0];
  function rejectInvalidCwd(reply, cwd) {
    if (!cwd) {
      reply.code(400);
      reply.send({ success: false, error: "Missing cwd" });
      return true;
    }
    const known = new Set(knownFolderCwds());
    if (!known.has(cwd)) {
      reply.code(403);
      reply.send({
        success: false,
        error: "cwd not allowed",
        reason: "cwd is not a known session or pinned directory.",
        hint: "Pin this directory to allow it, or open a session rooted in it."
      });
      return true;
    }
    return false;
  }
  function handleError(reply, err) {
    if (err instanceof GoalNotFoundError) {
      reply.code(404);
      return { success: false, error: "Goal not found" };
    }
    console.error("[goal-routes] internal error:", err);
    reply.code(500);
    return { success: false, error: "internal error" };
  }
  function isAcpSession(sessionId) {
    return sessionManager.listAll().some((s) => {
      const session = s;
      return session.id === sessionId && session.driver === "acp";
    });
  }
  function sessionInCwd(sessionId, cwd) {
    return sessionManager.listAll().some((s) => {
      const session = s;
      return session.id === sessionId && session.cwd === cwd;
    });
  }
  function parseCriteria(raw) {
    if (raw === void 0) return void 0;
    if (!Array.isArray(raw)) return null;
    const out = [];
    for (const c of raw) {
      if (typeof c !== "object" || c === null) return null;
      const text = c.text;
      if (typeof text !== "string" || text.trim().length === 0) return null;
      out.push({ text, done: !!c.done });
    }
    return out;
  }
  function parseBudget(raw) {
    if (raw === void 0) return void 0;
    if (typeof raw !== "object" || raw === null) return null;
    const b = raw;
    const budget = {};
    if (b.maxTurns !== void 0) {
      if (typeof b.maxTurns !== "number" || !Number.isFinite(b.maxTurns)) return null;
      budget.maxTurns = b.maxTurns;
    }
    if (b.maxSpendUsd !== void 0) {
      if (typeof b.maxSpendUsd !== "number" || !Number.isFinite(b.maxSpendUsd)) return null;
      budget.maxSpendUsd = b.maxSpendUsd;
    }
    return budget;
  }
  function parseJudge(raw) {
    if (raw === void 0) return void 0;
    if (typeof raw !== "object" || raw === null) return null;
    const j = raw;
    if (typeof j.provider !== "string" || j.provider.trim().length === 0) return null;
    if (typeof j.modelId !== "string" || j.modelId.trim().length === 0) return null;
    if (j.sameModel !== void 0 && typeof j.sameModel !== "boolean") return null;
    const judge = { provider: j.provider.trim(), modelId: j.modelId.trim() };
    if (j.sameModel !== void 0) judge.sameModel = j.sameModel;
    return judge;
  }
  fastify.get(
    "/api/folders/goals",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { cwd } = request.query;
      if (rejectInvalidCwd(reply, cwd)) return;
      try {
        const data = decorateGoalsWithSpend(await store.list(cwd), spendLookup);
        return { success: true, data };
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );
  fastify.post(
    "/api/folders/goals",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { cwd } = request.query;
      if (rejectInvalidCwd(reply, cwd)) return;
      const body = request.body ?? {};
      const objective = typeof body.objective === "string" ? body.objective.trim() : "";
      if (!objective) {
        reply.code(400);
        return { success: false, error: "objective is required" };
      }
      const criteria = parseCriteria(body.criteria);
      if (criteria === null) {
        reply.code(400);
        return { success: false, error: "criteria must be an array of { text, done? }" };
      }
      const budget = parseBudget(body.budget);
      if (budget === null) {
        reply.code(400);
        return { success: false, error: "budget must be { maxTurns?, maxSpendUsd? } numbers" };
      }
      const judge = parseJudge(body.judge);
      if (judge === null) {
        reply.code(400);
        return { success: false, error: "judge must be { provider, modelId, sameModel? }" };
      }
      if (body.autoRespawn !== void 0 && typeof body.autoRespawn !== "boolean") {
        reply.code(400);
        return { success: false, error: "autoRespawn must be a boolean" };
      }
      try {
        const created = await store.create(cwd, {
          objective,
          ...criteria !== void 0 ? { criteria } : {},
          ...budget !== void 0 ? { budget } : {},
          ...judge !== void 0 ? { judge } : {},
          ...body.autoRespawn !== void 0 ? { autoRespawn: body.autoRespawn } : {}
        });
        reply.code(201);
        return { success: true, data: withSpend(created) };
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );
  fastify.patch(
    "/api/folders/goals/:id",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { cwd } = request.query;
      if (rejectInvalidCwd(reply, cwd)) return;
      const { id } = request.params;
      const body = request.body ?? {};
      const update = {};
      if (body.autoRespawn !== void 0) {
        if (typeof body.autoRespawn !== "boolean") {
          reply.code(400);
          return { success: false, error: "autoRespawn must be a boolean" };
        }
        update.autoRespawn = body.autoRespawn;
      }
      if (body.objective !== void 0) {
        if (typeof body.objective !== "string") {
          reply.code(400);
          return { success: false, error: "objective must be a string" };
        }
        update.objective = body.objective;
      }
      if (body.status !== void 0) {
        if (typeof body.status !== "string" || !VALID_STATUS.has(body.status)) {
          reply.code(400);
          return { success: false, error: "invalid status" };
        }
        update.status = body.status;
      }
      const criteria = parseCriteria(body.criteria);
      if (criteria === null) {
        reply.code(400);
        return { success: false, error: "criteria must be an array of { text, done? }" };
      }
      if (criteria !== void 0) update.criteria = criteria;
      const budget = parseBudget(body.budget);
      if (budget === null) {
        reply.code(400);
        return { success: false, error: "budget must be { maxTurns?, maxSpendUsd? } numbers" };
      }
      if (budget !== void 0) update.budget = budget;
      const judge = parseJudge(body.judge);
      if (judge === null) {
        reply.code(400);
        return { success: false, error: "judge must be { provider, modelId, sameModel? }" };
      }
      if (judge !== void 0) update.judge = judge;
      try {
        if (update.status !== void 0 && TERMINAL_OR_PAUSED.has(update.status) && abortGoalSupervision) {
          await abortGoalSupervision(cwd, id, {
            status: update.status,
            reason: ABORT_REASON[update.status] ?? "stopped by user"
          });
          const { status: _omit, ...rest } = update;
          if (Object.keys(rest).length > 0) {
            const updated3 = await store.update(cwd, id, rest);
            return { success: true, data: withSpend(updated3) };
          }
          const updated2 = (await store.list(cwd)).find((g) => g.id === id);
          if (!updated2) throw new GoalNotFoundError(id);
          return { success: true, data: withSpend(updated2) };
        }
        const updated = await store.update(cwd, id, update);
        return { success: true, data: withSpend(updated) };
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );
  fastify.delete(
    "/api/folders/goals/:id",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { cwd } = request.query;
      if (rejectInvalidCwd(reply, cwd)) return;
      const { id } = request.params;
      try {
        if (abortGoalSupervision) {
          await abortGoalSupervision(cwd, id, { status: "cleared", reason: "deleted" }).catch(
            (err) => console.warn(`[goal-routes] abort before delete failed for ${id}:`, err)
          );
        }
        const formerSessionIds = await store.delete(cwd, id);
        for (const sid of formerSessionIds) applyGoalIdToSession(sid, null);
        return { success: true };
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );
  fastify.post(
    "/api/folders/goals/:id/sessions",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { cwd } = request.query;
      if (rejectInvalidCwd(reply, cwd)) return;
      const { id } = request.params;
      const body = request.body ?? {};
      if (body.spawn === true) {
        if (!spawnGoalSession) {
          reply.code(501);
          return { success: false, error: "starting sessions is not supported" };
        }
        try {
          const goals = await store.list(cwd);
          if (!goals.some((g) => g.id === id)) throw new GoalNotFoundError(id);
          const model = typeof body.model === "string" ? body.model : void 0;
          const res = await spawnGoalSession(cwd, id, model ? { model } : void 0);
          if (!res.success) {
            reply.code(500);
            return { success: false, error: res.message ?? "session start failed" };
          }
          return { success: true };
        } catch (err) {
          return handleError(reply, err);
        }
      }
      const sessionId = typeof body.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        reply.code(400);
        return { success: false, error: "sessionId or spawn:true required" };
      }
      if (!sessionInCwd(sessionId, cwd)) {
        reply.code(400);
        return { success: false, error: "sessionId is not a known session in this folder" };
      }
      if (isAcpSession(sessionId)) {
        reply.code(400);
        return {
          success: false,
          error: "Goals need a pi session; ACP agents can't pursue goals.",
          code: "unsupported_for_acp"
        };
      }
      try {
        const updated = await store.linkSession(cwd, id, sessionId);
        applyGoalIdToSession(sessionId, id);
        primeGoalSession?.(sessionId, updated);
        return { success: true, data: withSpend(updated) };
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );
  fastify.delete(
    "/api/folders/goals/:id/sessions/:sid",
    { preHandler: networkGuard },
    async (request, reply) => {
      const { cwd } = request.query;
      if (rejectInvalidCwd(reply, cwd)) return;
      const { id, sid } = request.params;
      try {
        const updated = await store.unlinkSession(cwd, id, sid);
        applyGoalIdToSession(sid, null);
        return { success: true, data: withSpend(updated) };
      } catch (err) {
        return handleError(reply, err);
      }
    }
  );
}
export {
  registerGoalRoutes
};
