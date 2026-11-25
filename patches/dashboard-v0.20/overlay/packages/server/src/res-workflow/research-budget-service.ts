import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  isResWorkflowResearchBudget, isResWorkflowResearchBudgetUpdateRequest,
  RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES,
  type ResWorkflowResearchBudget, type ResWorkflowResearchBudgetUpdateRequest,
} from "@blackbelt-technology/pi-dashboard-shared/research-budget.js";
import { ResWorkflowError, resolveInstalledResearchLoopRoot, type ResWorkflowAccess, type ResWorkflowService } from "./adoption-service.js";

interface ResearchBudgetBackend {
  charterHash(cwd: string): string;
  ResearchBudgetError: new (...args: unknown[]) => Error & { code: string; statusCode: number };
  readResearchBudget(input: { cwd: string; charterHash: string }): unknown | Promise<unknown>;
  updateResearchBudget(input: ResWorkflowResearchBudgetUpdateRequest & { charterHash: string }): unknown | Promise<unknown>;
}

export interface ResWorkflowResearchBudgetServiceDeps {
  /** Host-installed extension root; never accepted from HTTP or the project. */
  researchLoopRoot?: string;
  connection: ResWorkflowService["connection"];
}

/** Admission and projection only. The native module owns all budget persistence and CAS. */
export function createResWorkflowResearchBudgetService(deps: ResWorkflowResearchBudgetServiceDeps) {
  let backendPromise: Promise<ResearchBudgetBackend> | undefined;
  const backend = () => backendPromise ??= (async () => {
    const root = deps.researchLoopRoot ?? await resolveInstalledResearchLoopRoot();
    const adoption = await import(pathToFileURL(path.join(root, "src", "adoption.mjs")).href);
    const budget = await import(pathToFileURL(path.join(root, "src", "research-budget.mjs")).href);
    if (typeof adoption.charterHash !== "function" || typeof budget.readResearchBudget !== "function" || typeof budget.updateResearchBudget !== "function" || typeof budget.ResearchBudgetError !== "function") throw new Error("invalid-native-budget-module");
    return { ...budget, charterHash: adoption.charterHash } as ResearchBudgetBackend;
  })();

  async function scope(access: ResWorkflowAccess, native: ResearchBudgetBackend, expected?: string): Promise<string> {
    await access.revalidate();
    const connection = await deps.connection(access);
    await access.revalidate();
    if (!connection.adopted || connection.cwd !== access.cwd) throw new ResWorkflowError(409, "research-budget-not-adopted");
    const charter = native.charterHash(access.cwd);
    if (!/^sha256:[a-f0-9]{64}$/.test(charter)) throw new ResWorkflowError(503, "research-budget-unavailable");
    if (expected !== undefined && charter !== expected) throw new ResWorkflowError(409, "research-budget-scope-mismatch");
    return charter;
  }

  async function execute(access: ResWorkflowAccess, request?: ResWorkflowResearchBudgetUpdateRequest): Promise<ResWorkflowResearchBudget> {
    let native: ResearchBudgetBackend | undefined;
    try {
      if (request && access.write !== true) throw new ResWorkflowError(403, "res-workflow-write-required");
      if (request && (!isResWorkflowResearchBudgetUpdateRequest(request) || request.cwd !== access.cwd)) throw new ResWorkflowError(400, "research-budget-invalid");
      await access.revalidate();
      native = await backend();
      const charterHash = await scope(access, native);
      const result = await (request ? native.updateResearchBudget({ ...request, cwd: access.cwd, charterHash }) : native.readResearchBudget({ cwd: access.cwd, charterHash }));
      await scope(access, native, charterHash);
      if (!isResWorkflowResearchBudget(result) || result.cwd !== access.cwd) throw new ResWorkflowError(503, "research-budget-unavailable");
      // Only contract fields leave the trusted native boundary.
      return {
        cwd: result.cwd, revision: result.revision,
        limits: { attempts: null, modelRequests: null },
        usage: { attempts: result.usage.attempts, modelRequests: result.usage.modelRequests, inFlight: result.usage.inFlight, unknown: result.usage.unknown },
        updatedAt: result.updatedAt,
        enforcement: { attempts: false, modelRequests: false, scope: "native-research-workflow", physicalTransport: "sse-http" },
      };
    } catch (error) {
      if (error instanceof ResWorkflowError) throw error;
      if (native && error instanceof native.ResearchBudgetError && RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES.includes(error.code as typeof RES_WORKFLOW_RESEARCH_BUDGET_ERROR_CODES[number])) {
        throw new ResWorkflowError(error.code === "research-budget-invalid" ? 400 : 409, error.code);
      }
      throw new ResWorkflowError(503, "research-budget-unavailable");
    }
  }

  return {
    read: (access: ResWorkflowAccess) => execute(access),
    update: (access: ResWorkflowAccess, request: ResWorkflowResearchBudgetUpdateRequest) => execute(access, request),
  };
}
export type ResWorkflowResearchBudgetService = ReturnType<typeof createResWorkflowResearchBudgetService>;
