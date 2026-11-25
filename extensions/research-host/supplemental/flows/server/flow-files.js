const rateLimit = async () => {
};
import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "../../vendor/yaml/browser/dist/index.js";
import { FLOW_FILES_REPORT, FLOW_FILES_REQUEST_EVENT } from "../flow-files-contract.js";
const YAML = /\.ya?ml$/i;
const MARKDOWN = /\.md$/i;
const HANDLER = /\.[cm]?[jt]s$/i;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_REPORT_ITEMS = 2e3;
const REPORT_REQUEST_COOLDOWN_MS = 2e3;
function isSmallFile(p) {
  try {
    const st = fs.statSync(p);
    return st.isFile() && st.size <= MAX_FILE_BYTES;
  } catch {
    return false;
  }
}
function canonical(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}
function sanitize(list, ext) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list.slice(0, MAX_REPORT_ITEMS)) {
    const name = item?.name;
    const source = item?.source;
    if (typeof name !== "string" || typeof source !== "string") continue;
    if (!path.isAbsolute(source) || !ext.test(source)) continue;
    out.push({ name, source });
  }
  return out;
}
function codeHandlerPaths(flowSource, cwd) {
  const out = /* @__PURE__ */ Object.create(null);
  if (!isSmallFile(flowSource)) return out;
  let doc;
  try {
    doc = parseYaml(fs.readFileSync(flowSource, "utf8"));
  } catch {
    return out;
  }
  const steps = doc?.steps;
  if (!Array.isArray(steps)) return out;
  for (const raw of steps) {
    const s = raw;
    if (!s || typeof s.id !== "string" || s.id === "__proto__") continue;
    if (s.type !== "code" && s.type !== "code-decision") continue;
    let file;
    if (s.target !== void 0 && s.target !== null && s.target !== "") {
      if (cwd) file = path.resolve(cwd, String(s.target));
    } else {
      file = path.join(path.dirname(flowSource), `${s.id}.ts`);
    }
    if (file && HANDLER.test(file)) out[s.id] = file;
  }
  return out;
}
class FlowFileRegistry {
  bySession = /* @__PURE__ */ new Map();
  /** Replace a session's report. `cwd` resolves explicit code `target:`s. */
  report(sessionId, report, cwd) {
    const flows = sanitize(report?.flows, YAML);
    const agents = sanitize(report?.agents, MARKDOWN);
    const allowed = /* @__PURE__ */ new Map();
    const allow = (file) => {
      const real = canonical(file);
      allowed.set(path.resolve(file), real);
      allowed.set(real, real);
    };
    const agentMap = /* @__PURE__ */ Object.create(null);
    const handlers = /* @__PURE__ */ Object.create(null);
    for (const f of flows) {
      allow(f.source);
      const h = codeHandlerPaths(f.source, cwd);
      handlers[f.name] = h;
      for (const file of Object.values(h)) allow(file);
    }
    for (const a of agents) {
      agentMap[a.name] = a.source;
      allow(a.source);
    }
    this.bySession.set(sessionId, { allowed, agents: agentMap, handlers });
  }
  has(sessionId) {
    return this.bySession.has(sessionId);
  }
  remove(sessionId) {
    this.bySession.delete(sessionId);
  }
  /**
   * The stored canonical path when `filePath` is exactly one of the session's
   * reported files, else null. Pure string lookup — the request path never
   * touches the filesystem; callers read only the returned stored path.
   */
  resolveAllowed(sessionId, filePath) {
    if (!path.isAbsolute(filePath)) return null;
    return this.bySession.get(sessionId)?.allowed.get(path.resolve(filePath)) ?? null;
  }
  /** True when `filePath` is exactly one of the session's reported files. */
  isAllowed(sessionId, filePath) {
    return this.resolveAllowed(sessionId, filePath) !== null;
  }
  /** Agent sources + per-flow code handler paths for one session. */
  files(sessionId) {
    const s = this.bySession.get(sessionId);
    return s ? { agents: { ...s.agents }, handlers: { ...s.handlers } } : null;
  }
  /** Drop sessions no longer live. */
  retainOnly(liveIds2) {
    for (const id of this.bySession.keys()) if (!liveIds2.has(id)) this.bySession.delete(id);
  }
}
const flowFileRegistry = new FlowFileRegistry();
function liveIds(sm) {
  const ids = /* @__PURE__ */ new Set();
  for (const s of sm.listActive()) {
    const r = s;
    if (r && typeof r.id === "string" && r.status !== "ended") ids.add(r.id);
  }
  return ids;
}
async function registerFlowFileRoutes(deps) {
  const registry = deps.registry ?? flowFileRegistry;
  const lastAsk = /* @__PURE__ */ new Map();
  const requestReport = (sessionId) => {
    const now = Date.now();
    if (now - (lastAsk.get(sessionId) ?? 0) < REPORT_REQUEST_COOLDOWN_MS) return;
    lastAsk.set(sessionId, now);
    try {
      deps.emitEventToSession(sessionId, FLOW_FILES_REQUEST_EVENT, {});
    } catch {
    }
  };
  const liveSession = (q) => {
    const id = q?.sessionId;
    if (typeof id !== "string" || !id) return null;
    const live = liveIds(deps.sessionManager);
    registry.retainOnly(live);
    for (const sid of lastAsk.keys()) if (!live.has(sid)) lastAsk.delete(sid);
    return live.has(id) ? id : null;
  };
  deps.registerPiRequestHandler?.(FLOW_FILES_REPORT, (payload, meta) => {
    const session = deps.sessionManager.getSession(meta.sessionId);
    const cwd = typeof session?.cwd === "string" ? session.cwd : void 0;
    registry.report(meta.sessionId, payload, cwd);
    return { ok: true };
  });
  await deps.fastify.register(async (scope) => {
    await scope.register(rateLimit, { global: true, max: 600, timeWindow: "1 minute", allowList: ["127.0.0.1", "::1"] });
    scope.get("/api/plugins/flows/files", { preHandler: deps.networkGuard }, async (req, reply) => {
      const sessionId = liveSession(req.query);
      if (!sessionId) return reply.code(404).send({ success: false, error: "session not found" });
      const files = registry.files(sessionId);
      if (!files) {
        requestReport(sessionId);
        return { success: true, data: { reported: false, agents: {}, handlers: {} } };
      }
      return { success: true, data: { reported: true, ...files } };
    });
    scope.get("/api/plugins/flows/file", { preHandler: deps.networkGuard }, async (req, reply) => {
      const sessionId = liveSession(req.query);
      const filePath = req.query?.path;
      if (!sessionId) return reply.code(404).send({ success: false, error: "session not found" });
      if (typeof filePath !== "string" || !filePath) {
        return reply.code(400).send({ success: false, error: "path parameter required" });
      }
      if (!registry.has(sessionId)) {
        requestReport(sessionId);
        return reply.code(409).send({ success: false, error: "not reported yet", retry: true });
      }
      const target = registry.resolveAllowed(sessionId, filePath);
      if (!target) {
        return reply.code(403).send({ success: false, error: "not a flow file of this session" });
      }
      if (!isSmallFile(target)) return reply.code(404).send({ success: false, error: "not found" });
      try {
        const content = await fs.promises.readFile(target, "utf8");
        return { success: true, data: { type: "file", content } };
      } catch {
        return reply.code(404).send({ success: false, error: "not found" });
      }
    });
  });
}
export {
  FlowFileRegistry,
  codeHandlerPaths,
  registerFlowFileRoutes
};
