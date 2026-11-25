// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/access-mode-service.ts
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/research-access-mode.ts
var object = (value) => !!value && typeof value === "object" && !Array.isArray(value);
var mode = (value) => value === "default" || value === "full-access";
var revision = (value) => value === null || typeof value === "string" && /^[a-f0-9-]{36}$/.test(value);
var cwd = (value) => typeof value === "string" && !!value && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
function isResearchAccessModeUpdate(value) {
  return object(value) && Object.keys(value).every((key) => ["cwd", "mode", "expectedRevision", "requestId"].includes(key)) && cwd(value.cwd) && mode(value.mode) && revision(value.expectedRevision) && typeof value.requestId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.requestId);
}
function isResearchAccessMode(value) {
  return object(value) && cwd(value.cwd) && mode(value.mode) && revision(value.revision) && (value.updatedAt === null || typeof value.updatedAt === "string" && Number.isFinite(Date.parse(value.updatedAt))) && value.inheritance === "workspace-sessions";
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/access-mode-service.ts
import { ResWorkflowError, resolveInstalledResearchLoopRoot } from "../errors.mjs";
var sharedBackend;
async function loadBackend(root) {
  const installed = root ?? await resolveInstalledResearchLoopRoot();
  return import(pathToFileURL(path.join(installed, "src", "access-mode.mjs")).href);
}
var backend = (root) => root ? loadBackend(root) : sharedBackend ??= loadBackend().catch((error) => {
  sharedBackend = void 0;
  throw error;
});
function failure(error) {
  if (error instanceof ResWorkflowError) return error;
  const code = error?.code;
  if (typeof code === "string" && /^access-mode-[a-z-]+$/.test(code)) return new ResWorkflowError(code.includes("invalid") ? 400 : code === "access-mode-unavailable" ? 503 : 409, code);
  return new ResWorkflowError(503, "access-mode-unavailable");
}
function createResWorkflowAccessModeService(deps = {}) {
  const execute = async (access, request) => {
    try {
      if (request && (!access.write || !isResearchAccessModeUpdate(request) || request.cwd !== access.cwd)) throw new ResWorkflowError(403, "access-mode-write-required");
      await access.revalidate();
      const native = await backend(deps.researchLoopRoot);
      await access.revalidate();
      const input = { ...request, cwd: access.cwd, ownerKey: access.ownerKey, ...deps.storeDir ? { storeDir: deps.storeDir } : {} };
      const result = request ? native.updateResearchAccessMode(input) : native.readResearchAccessMode(input);
      if (!isResearchAccessMode(result) || result.cwd !== access.cwd) throw new Error("invalid access mode projection");
      return result;
    } catch (error) {
      throw failure(error);
    }
  };
  return { read: (access) => execute(access), update: (access, request) => execute(access, request) };
}
async function readSessionResearchAccessMode(session, options = {}) {
  if (!session?.id || session.originDeviceId || session.driver && session.driver !== "pi") return null;
  try {
    const native = await backend(options.researchLoopRoot);
    const cwd2 = fs.realpathSync(session.cwd);
    const result = native.readResearchAccessMode({ cwd: cwd2, ownerKey: native.researchAccessOwnerKey(session.principalOwner), ...options.storeDir ? { storeDir: options.storeDir } : {} });
    if (!isResearchAccessMode(result) || result.cwd !== cwd2) throw new Error("invalid access mode projection");
    return result;
  } catch (error) {
    throw failure(error);
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/task-permission-service.ts
import path2 from "node:path";
import { pathToFileURL as pathToFileURL2 } from "node:url";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/research-task-permissions.ts
var object2 = (v) => !!v && typeof v === "object" && !Array.isArray(v);
var caps = (v) => object2(v) && Object.keys(v).length === 4 && ["localExecution", "delegation", "publicResearch", "projectDependencies"].every((k) => typeof v[k] === "boolean");
var revision2 = (v) => v === null || typeof v === "string" && /^[a-f0-9-]{36}$/.test(v);
function isResearchTaskPermissionUpdate(v) {
  if (!object2(v) || Object.keys(v).some((k) => !["cwd", "expectedRevision", "requestId", "action", "confirmed", "task", "durationHours", "capabilities", "additionalRoots"].includes(k)) || typeof v.cwd !== "string" || !v.cwd || v.cwd.length > 4096 || !revision2(v.expectedRevision) || typeof v.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(v.requestId) || v.confirmed !== true) return false;
  return v.action === "revoke" || v.action === "authorize" && typeof v.task === "string" && !!v.task.trim() && v.task.length <= 4e3 && [12, 24, 48, 72].includes(v.durationHours) && caps(v.capabilities) && Array.isArray(v.additionalRoots) && v.additionalRoots.length <= 16 && v.additionalRoots.every((r) => typeof r === "string" && !!r && r.length <= 4096);
}
function isResearchTaskPermissions(v) {
  return object2(v) && typeof v.cwd === "string" && typeof v.charterHash === "string" && /^sha256:[a-f0-9]{64}$/.test(v.charterHash) && revision2(v.revision) && ["unconfigured", "active", "expired", "revoked", "scope-changed"].includes(v.status) && typeof v.task === "string" && caps(v.capabilities) && Array.isArray(v.additionalRoots) && v.additionalRoots.every((p) => typeof p === "string") && [12, 24, 48, 72].includes(v.durationHours) && (v.authorizedAt === null || typeof v.authorizedAt === "string") && (v.expiresAt === null || typeof v.expiresAt === "string") && v.inheritance === "joined-workbench-descendants" && Array.isArray(v.blockers) && v.blockers.length <= 20;
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/task-permission-service.ts
import { ResWorkflowError as ResWorkflowError2, resolveInstalledResearchLoopRoot as resolveInstalledResearchLoopRoot2 } from "../errors.mjs";
var sharedBackend2;
async function loadBackend2(root) {
  const installed = root ?? await resolveInstalledResearchLoopRoot2();
  const load = (file) => import(pathToFileURL2(path2.join(installed, "src", file)).href);
  const [adoption, permissions, context] = await Promise.all([load("adoption.mjs"), load("task-permissions.mjs"), load("task-permission-context.mjs")]);
  return { ...permissions, charterHash: adoption.charterHash, readTaskPermissionContext: context.readTaskPermissionContext };
}
var backend2 = (root) => root ? loadBackend2(root) : sharedBackend2 ??= loadBackend2().catch((error) => {
  sharedBackend2 = void 0;
  throw error;
});
function failure2(error) {
  if (error instanceof ResWorkflowError2) return error;
  const code = error?.code;
  if (typeof code === "string" && /^task-permissions-[a-z-]+$/.test(code)) return new ResWorkflowError2(code.includes("invalid") ? 400 : code.includes("owner") ? 403 : 409, code);
  return new ResWorkflowError2(503, "task-permissions-unavailable");
}
function createResWorkflowTaskPermissionService(deps) {
  const execute = async (access, request) => {
    try {
      if (request && (!access.write || !isResearchTaskPermissionUpdate(request) || request.cwd !== access.cwd)) throw new ResWorkflowError2(403, "task-permissions-write-required");
      await access.revalidate();
      const connection = await deps.connection(access);
      if (!connection.adopted || connection.cwd !== access.cwd) throw new ResWorkflowError2(409, "task-permissions-not-adopted");
      const native = await backend2(deps.researchLoopRoot), charterHash = native.charterHash(access.cwd);
      await access.revalidate();
      const input = { ...request, cwd: access.cwd, charterHash, ownerKey: access.ownerKey, ...deps.storeDir ? { storeDir: deps.storeDir } : {} };
      const result = request ? native.updateTaskPermissions(input) : native.readTaskPermissions(input);
      await access.revalidate();
      if (native.charterHash(access.cwd) !== charterHash) throw new ResWorkflowError2(409, "task-permissions-scope-mismatch");
      if (!isResearchTaskPermissions(result) || result.cwd !== access.cwd) throw new Error("invalid permission projection");
      return result;
    } catch (error) {
      throw failure2(error);
    }
  };
  return { read: (access) => execute(access), update: (access, request) => execute(access, request) };
}
async function decideResearchTaskPath(session, target, access, tool, options = {}) {
  let configuredTask = false;
  try {
    if (!session?.sessionFile || session.originDeviceId || session.driver && session.driver !== "pi") return null;
    const native = await backend2(options.researchLoopRoot);
    const context = native.readTaskPermissionContext({ cwd: session.cwd, sessionManager: { getSessionId: () => session.id, getSessionFile: () => session.sessionFile } }, options.contextOptions);
    if (!context) return null;
    if (context.unavailable) return "task-blocked";
    const profile = context.profile;
    if (!profile || profile.status === "unconfigured") return null;
    configuredTask = true;
    const decision = native.taskPermissionPathDecision(profile, target, access);
    if (decision === "allow") return "auto-allow";
    if (context.binding) {
      try {
        native.recordTaskPermissionBlock({ ...context.binding, code: profile.status === "active" ? "file-access-out-of-scope" : `authorization-${profile.status}`, tool, target });
      } catch {
      }
    }
    return "task-blocked";
  } catch {
    return configuredTask ? "task-blocked" : null;
  }
}
async function assertResearchTaskDelegation(session, options = {}) {
  try {
    if (!session?.sessionFile || session.originDeviceId || session.driver && session.driver !== "pi") throw new ResWorkflowError2(409, "task-permissions-context-unavailable");
    const native = await backend2(options.researchLoopRoot);
    const context = native.readTaskPermissionContext({ cwd: session.cwd, sessionManager: { getSessionId: () => session.id, getSessionFile: () => session.sessionFile } }, options.contextOptions);
    if (!context || context.unavailable || !context.profile) throw new ResWorkflowError2(409, "task-permissions-context-unavailable");
    const profile = context.profile;
    if (profile.status === "unconfigured") return null;
    if (profile.status === "active" && profile.capabilities.delegation) return profile;
    const code = profile.status === "active" ? "delegation-out-of-scope" : `authorization-${profile.status}`;
    if (context.binding) {
      try {
        native.recordTaskPermissionBlock({ ...context.binding, code, tool: "research_dispatch" });
      } catch {
      }
    }
    throw new ResWorkflowError2(409, `task-permissions-${code}`);
  } catch (error) {
    throw failure2(error);
  }
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/research-budget-service.ts
import path3 from "node:path";
import { pathToFileURL as pathToFileURL3 } from "node:url";

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-shared/src/research-budget.ts
var RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES = [
  "research-budget-invalid",
  "research-budget-not-adopted",
  "research-budget-not-configured",
  "research-budget-revision-conflict",
  "research-budget-request-conflict",
  "research-budget-attempts-exhausted",
  "research-budget-model-requests-exhausted",
  "research-budget-scope-mismatch",
  "research-budget-unavailable"
];
function object3(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function exact(value, keys) {
  return object3(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
var count = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
var revision3 = (value) => value === null || typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(value);
function isResWorkflowResearchBudgetUpdateRequest(value) {
  return exact(value, ["cwd", "expectedRevision", "requestId", "limits"]) && typeof value.cwd === "string" && !!value.cwd && value.cwd.length <= 4096 && !value.cwd.includes("\0") && revision3(value.expectedRevision) && typeof value.requestId === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value.requestId) && exact(value.limits, ["attempts", "modelRequests"]) && count(value.limits.attempts) && count(value.limits.modelRequests);
}
function isResWorkflowResearchBudget(value) {
  return object3(value) && typeof value.cwd === "string" && !!value.cwd && value.cwd.length <= 4096 && !value.cwd.includes("\0") && revision3(value.revision) && (value.updatedAt === null || typeof value.updatedAt === "string" && value.updatedAt.length <= 64 && Number.isFinite(Date.parse(value.updatedAt))) && object3(value.limits) && (value.limits.attempts === null || count(value.limits.attempts)) && (value.limits.modelRequests === null || count(value.limits.modelRequests)) && object3(value.usage) && count(value.usage.attempts) && count(value.usage.modelRequests) && count(value.usage.inFlight) && count(value.usage.unknown) && object3(value.enforcement) && typeof value.enforcement.attempts === "boolean" && typeof value.enforcement.modelRequests === "boolean" && value.enforcement.scope === "native-research-workflow" && value.enforcement.physicalTransport === "sse-http";
}

// dashboard/node_modules/@blackbelt-technology/pi-dashboard-server/src/res-workflow/research-budget-service.ts
import { ResWorkflowError as ResWorkflowError3, resolveInstalledResearchLoopRoot as resolveInstalledResearchLoopRoot3 } from "../errors.mjs";
function createResWorkflowResearchBudgetService(deps) {
  let backendPromise;
  const backend3 = () => backendPromise ??= (async () => {
    const root = deps.researchLoopRoot ?? await resolveInstalledResearchLoopRoot3();
    const adoption = await import(pathToFileURL3(path3.join(root, "src", "adoption.mjs")).href);
    const budget = await import(pathToFileURL3(path3.join(root, "src", "research-budget.mjs")).href);
    if (typeof adoption.charterHash !== "function" || typeof budget.readResearchBudget !== "function" || typeof budget.updateResearchBudget !== "function" || typeof budget.ResearchBudgetError !== "function") throw new Error("invalid-native-budget-module");
    return { ...budget, charterHash: adoption.charterHash };
  })();
  async function scope(access, native, expected) {
    await access.revalidate();
    const connection = await deps.connection(access);
    await access.revalidate();
    if (!connection.adopted || connection.cwd !== access.cwd) throw new ResWorkflowError3(409, "research-budget-not-adopted");
    const charter = native.charterHash(access.cwd);
    if (!/^sha256:[a-f0-9]{64}$/.test(charter)) throw new ResWorkflowError3(503, "research-budget-unavailable");
    if (expected !== void 0 && charter !== expected) throw new ResWorkflowError3(409, "research-budget-scope-mismatch");
    return charter;
  }
  async function execute(access, request) {
    let native;
    try {
      if (request && access.write !== true) throw new ResWorkflowError3(403, "res-workflow-write-required");
      if (request && (!isResWorkflowResearchBudgetUpdateRequest(request) || request.cwd !== access.cwd)) throw new ResWorkflowError3(400, "research-budget-invalid");
      await access.revalidate();
      native = await backend3();
      const charterHash = await scope(access, native);
      const result = await (request ? native.updateResearchBudget({ ...request, cwd: access.cwd, charterHash }) : native.readResearchBudget({ cwd: access.cwd, charterHash }));
      await scope(access, native, charterHash);
      if (!isResWorkflowResearchBudget(result) || result.cwd !== access.cwd) throw new ResWorkflowError3(503, "research-budget-unavailable");
      return {
        cwd: result.cwd,
        revision: result.revision,
        limits: { attempts: null, modelRequests: null },
        usage: { attempts: result.usage.attempts, modelRequests: result.usage.modelRequests, inFlight: result.usage.inFlight, unknown: result.usage.unknown },
        updatedAt: result.updatedAt,
        enforcement: { attempts: false, modelRequests: false, scope: "native-research-workflow", physicalTransport: "sse-http" }
      };
    } catch (error) {
      if (error instanceof ResWorkflowError3) throw error;
      if (native && error instanceof native.ResearchBudgetError && RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES.includes(error.code)) {
        throw new ResWorkflowError3(error.code === "research-budget-invalid" ? 400 : 409, error.code);
      }
      throw new ResWorkflowError3(503, "research-budget-unavailable");
    }
  }
  return {
    read: (access) => execute(access),
    update: (access, request) => execute(access, request)
  };
}
export {
  RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES,
  assertResearchTaskDelegation,
  createResWorkflowAccessModeService,
  createResWorkflowResearchBudgetService,
  createResWorkflowTaskPermissionService,
  decideResearchTaskPath,
  isResWorkflowResearchBudget,
  isResWorkflowResearchBudgetUpdateRequest,
  isResearchAccessMode,
  isResearchAccessModeUpdate,
  isResearchTaskPermissionUpdate,
  isResearchTaskPermissions,
  readSessionResearchAccessMode
};
