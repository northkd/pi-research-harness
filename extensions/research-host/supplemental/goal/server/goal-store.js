import { supplementalHomeDir } from "../../runtime-home.mjs";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  GOAL_RESPAWNS_CAP,
  GOAL_VERDICTS_CAP,
  GOALS_SCHEMA_VERSION
} from "../shared/store-constants.js";
class GoalNotFoundError extends Error {
  id;
  constructor(id) {
    super(`Goal not found: ${id}`);
    this.name = "GoalNotFoundError";
    this.id = id;
  }
}
const DEFAULT_DEBOUNCE_MS = 100;
function folderHash(cwd) {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 12);
}
function emptyFile() {
  return { schemaVersion: GOALS_SCHEMA_VERSION, goals: [] };
}
function createGoalStore(opts = {}) {
  const dataDir = opts.dataDir ?? path.join(supplementalHomeDir(), ".pi", "dashboard", "goals");
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const cache = /* @__PURE__ */ new Map();
  const writeMutex = /* @__PURE__ */ new Map();
  const debounceTimers = /* @__PURE__ */ new Map();
  const subscribers = /* @__PURE__ */ new Set();
  function fileFor(cwd) {
    return path.join(dataDir, `${folderHash(cwd)}.json`);
  }
  async function read(cwd) {
    const cached = cache.get(cwd);
    if (cached) return cached;
    let data;
    try {
      const raw = await fs.readFile(fileFor(cwd), "utf-8");
      const parsed = JSON.parse(raw);
      data = parsed && Array.isArray(parsed.goals) ? parsed : emptyFile();
    } catch (err) {
      if (err?.code && err.code !== "ENOENT") throw err;
      data = emptyFile();
    }
    cache.set(cwd, data);
    return data;
  }
  async function mutate(cwd, mutator) {
    const prev = writeMutex.get(cwd) ?? Promise.resolve();
    let release;
    const slot = new Promise((resolve) => {
      release = resolve;
    });
    writeMutex.set(cwd, prev.then(() => slot));
    try {
      await prev;
      const current = await read(cwd);
      const { next, result } = mutator(current);
      const filePath = fileFor(cwd);
      await fs.mkdir(dataDir, { recursive: true });
      const tmpPath = filePath + ".tmp";
      await fs.writeFile(tmpPath, JSON.stringify(next, null, 2) + "\n");
      await fs.rename(tmpPath, filePath);
      cache.set(cwd, next);
      scheduleBroadcast(cwd, next);
      return result;
    } finally {
      release();
    }
  }
  function scheduleBroadcast(cwd, file) {
    if (subscribers.size === 0) return;
    const existing = debounceTimers.get(cwd);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      debounceTimers.delete(cwd);
      const latest = cache.get(cwd) ?? file;
      const goals = latest.goals.map((g) => ({ ...g }));
      for (const cb of subscribers) {
        try {
          cb(cwd, { goals });
        } catch {
        }
      }
    }, debounceMs);
    debounceTimers.set(cwd, timer);
  }
  function findOrThrow(file, id) {
    const g = file.goals.find((x) => x.id === id);
    if (!g) throw new GoalNotFoundError(id);
    return g;
  }
  async function list(cwd) {
    return (await read(cwd)).goals.map((g) => ({ ...g }));
  }
  async function create(cwd, body) {
    return mutate(cwd, (current) => {
      const now = Date.now();
      const record = {
        id: randomUUID(),
        cwd,
        objective: body.objective,
        criteria: body.criteria ?? [],
        status: "pursuing",
        ...body.budget !== void 0 ? { budget: body.budget } : {},
        ...body.judge !== void 0 ? { judge: body.judge } : {},
        ...body.autoRespawn ? { autoRespawn: true } : {},
        sessionIds: [],
        createdAt: now,
        updatedAt: now
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: [...current.goals, record]
      };
      return { next, result: record };
    });
  }
  async function update(cwd, id, body) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const updated = {
        ...target,
        ...body.objective !== void 0 ? { objective: body.objective } : {},
        ...body.criteria !== void 0 ? { criteria: body.criteria } : {},
        ...body.status !== void 0 ? { status: body.status } : {},
        ...body.budget !== void 0 ? { budget: body.budget } : {},
        ...body.judge !== void 0 ? { judge: body.judge } : {},
        ...body.driverSessionId !== void 0 ? { driverSessionId: body.driverSessionId } : {},
        ...body.autoRespawn !== void 0 ? { autoRespawn: body.autoRespawn } : {},
        updatedAt: Date.now()
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function del(cwd, id) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.filter((g) => g.id !== id)
      };
      return { next, result: [...target.sessionIds] };
    });
  }
  async function linkSession(cwd, id, sessionId) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const sessionIds = target.sessionIds.includes(sessionId) ? target.sessionIds : [...target.sessionIds, sessionId];
      const updated = {
        ...target,
        sessionIds,
        driverSessionId: target.driverSessionId ?? sessionId,
        updatedAt: Date.now()
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function unlinkSession(cwd, id, sessionId) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const updated = {
        ...target,
        sessionIds: target.sessionIds.filter((s) => s !== sessionId),
        ...target.driverSessionId === sessionId ? { driverSessionId: void 0 } : {},
        updatedAt: Date.now()
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function appendVerdict(cwd, id, verdict) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const verdicts = [...target.verdicts ?? [], verdict].slice(-GOAL_VERDICTS_CAP);
      const updated = { ...target, verdicts, updatedAt: Date.now() };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function listAll() {
    let files;
    try {
      files = (await fs.readdir(dataDir)).filter((f) => f.endsWith(".json") && !f.endsWith(".tmp"));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    const out = [];
    for (const f of files) {
      try {
        const raw = await fs.readFile(path.join(dataDir, f), "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.goals)) {
          for (const g of parsed.goals) out.push({ ...g });
        }
      } catch {
      }
    }
    return out;
  }
  async function replaceDriver(cwd, id, newSessionId) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const sessionIds = target.sessionIds.includes(newSessionId) ? target.sessionIds : [...target.sessionIds, newSessionId];
      const updated = {
        ...target,
        sessionIds,
        driverSessionId: newSessionId,
        // Capture the progress baseline for the incoming driver so the
        // supervisor can classify its eventual death as progress vs not.
        currentDriverBaselineTurns: target.totalTurnsUsed ?? 0,
        updatedAt: Date.now()
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function recordRespawn(cwd, id, respawn) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const respawns = [...target.respawns ?? [], respawn].slice(-GOAL_RESPAWNS_CAP);
      const updated = { ...target, respawns, updatedAt: Date.now() };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function setStatus(cwd, id, status, reason) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const updated = {
        ...target,
        status,
        ...reason !== void 0 ? { statusReason: reason } : {},
        updatedAt: Date.now()
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function finalize(cwd, id, body) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const updated = {
        ...target,
        status: body.status,
        ...body.statusReason !== void 0 ? { statusReason: body.statusReason } : {},
        generation: (target.generation ?? 0) + 1,
        ...body.clearInFlightSpawn ? { inFlightSpawn: void 0 } : {},
        updatedAt: Date.now()
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function setInFlightSpawn(cwd, id, spawn) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const updated = {
        ...target,
        inFlightSpawn: spawn ?? void 0,
        updatedAt: Date.now()
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  async function applyStatus(cwd, id, projection) {
    return mutate(cwd, (current) => {
      const target = findOrThrow(current, id);
      const now = Date.now();
      const totalTurnsUsed = (target.totalTurnsUsed ?? 0) + Math.max(0, projection.turnsDelta);
      const updated = {
        ...target,
        status: projection.status,
        lastKnownTurnsUsed: projection.lastKnownTurnsUsed,
        totalTurnsUsed,
        ...projection.progressed ? { lastProgressAt: now } : {},
        updatedAt: now
      };
      const next = {
        schemaVersion: GOALS_SCHEMA_VERSION,
        goals: current.goals.map((g) => g.id === id ? updated : g)
      };
      return { next, result: updated };
    });
  }
  function subscribe(cb) {
    subscribers.add(cb);
    return () => subscribers.delete(cb);
  }
  function dispose() {
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    subscribers.clear();
    cache.clear();
    writeMutex.clear();
  }
  return {
    list,
    create,
    update,
    delete: del,
    linkSession,
    unlinkSession,
    appendVerdict,
    listAll,
    replaceDriver,
    recordRespawn,
    setStatus,
    finalize,
    setInFlightSpawn,
    applyStatus,
    subscribe,
    dispose
  };
}
export {
  GoalNotFoundError,
  createGoalStore
};
