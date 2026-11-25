/** Main-controlled actual-contract gate, not an authorization record. */
import { ScienceNativeDriverError } from "./science-native-driver.js";
import type { ScienceNativeDriverDeps, ScienceNativeRuntimeContext } from "./science-native-driver.js";

/** Frozen contract description from main's one controlled real P0 submission and
 * same-ID observation. This public object grants nothing and contains no IDs,
 * session material, model identity claim or authorization for another submit. */
export const SCIENCE_NATIVE_P0_CONTRACT = Object.freeze({
  contractId: "science-0.1.70-native-project-request-status-v1",
  scienceBinarySha256: "2139fa524389ec338ad86d50f66e7e7d0c4aa8bf9d7036a15fb196b5bde6a31b",
  origin: "http://127.0.0.1:18765",
  serviceUnit: "pi-claude-science.service",
  verifiedApiContracts: Object.freeze(["nonce-csrf", "project-create", "request-submit", "frame-status"] as const),
  activatedDriverActions: Object.freeze(["submit", "observe"] as const),
  taskIdMeaning: "same real root_frame_id anchor; no separate native task object",
  selectedScienceModel: "claude-pi-science-default",
  requestBodyPlanMode: true, // HTTP top-level plan_mode -> native Tos planMode -> dispatch.input_data.plan_mode.
  configuredRoleTargets: Object.freeze(["ark-sci-deepseek-v4.1-flash", "gpt-6.1-sol(max)", "gpt-6-astra(high)"] as const),
  unverifiedDriverActions: Object.freeze(["reconcile", "cancel", "artifacts"] as const),
  actualModelIdentity: "unknown", actualProvider: "unknown", actualEffort: "unknown", usageVerification: "unknown",
});
type ActivatedAction = "observe" | "submit";
export interface ScienceNativeP0ContractGateDeps {
  /** Code-owned verifier checks main's controlled receipt provenance, target
   * binary, exact operation and returned native schema, not project/receipt JSON claims. */
  assertControlledReceipt(action: ActivatedAction, expected: typeof SCIENCE_NATIVE_P0_CONTRACT): Promise<void>;
  /** Fresh daemon/listener/cgroup/build/profile proof. This is not a cached success flag. */
  assertCurrentRuntime(expected: typeof SCIENCE_NATIVE_P0_CONTRACT): Promise<void>;
  /** Fresh registry/user grant for these exact private IDs or durable intent/hash.
   * An existing P0 checkpoint cannot authorize another submission. */
  assertLiveScope(action: ActivatedAction, context: ScienceNativeRuntimeContext): Promise<void>;
}
function requireValue(value: unknown): asserts value { if (!value) throw new ScienceNativeDriverError("science-native-unavailable"); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key)); }
const PROJECT = /^proj_[0-9a-f]{12}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, HASH = /^[0-9a-f]{64}$/;

export function createScienceNativeP0ContractGate(deps: ScienceNativeP0ContractGateDeps): ScienceNativeDriverDeps["runtime"] {
  requireValue(typeof deps?.assertControlledReceipt === "function" && typeof deps.assertCurrentRuntime === "function" && typeof deps.assertLiveScope === "function");
  return Object.freeze({
    async assertCapability(action, raw) {
      try {
        requireValue(action === "submit" || action === "observe"); // Never infer remaining contracts from a successful POST.
        const context: unknown = structuredClone(raw);
        requireValue(object(context) && typeof context.projectId === "string" && PROJECT.test(context.projectId));
        if (action === "observe") {
          requireValue(exact(context, ["projectId", "binding"]) && object(context.binding) && exact(context.binding, ["projectId", "taskId", "rootFrameId", "frameId"]));
          const binding = context.binding;
          requireValue(binding.projectId === context.projectId && typeof binding.rootFrameId === "string" && UUID.test(binding.rootFrameId) && binding.taskId === binding.rootFrameId && binding.frameId === binding.rootFrameId);
        } else {
          requireValue(exact(context, ["projectId", "intentId", "requestHash", "selectedModelId", "permittedModelIds"]) && typeof context.intentId === "string" && UUID.test(context.intentId)
            && typeof context.requestHash === "string" && HASH.test(context.requestHash) && context.selectedModelId === SCIENCE_NATIVE_P0_CONTRACT.configuredRoleTargets[0]
            && Array.isArray(context.permittedModelIds) && context.permittedModelIds.length === 3 && new Set(context.permittedModelIds).size === 3
            && SCIENCE_NATIVE_P0_CONTRACT.configuredRoleTargets.every(model => (context.permittedModelIds as unknown[]).includes(model)));
        }
        const checked = context as unknown as ScienceNativeRuntimeContext;
        requireValue(await deps.assertLiveScope(action, structuredClone(checked)) === undefined);
        requireValue(await deps.assertControlledReceipt(action, SCIENCE_NATIVE_P0_CONTRACT) === undefined);
        requireValue(await deps.assertCurrentRuntime(SCIENCE_NATIVE_P0_CONTRACT) === undefined);
        requireValue(await deps.assertLiveScope(action, structuredClone(checked)) === undefined);
      } catch { throw new ScienceNativeDriverError("science-native-unavailable"); }
    },
  });
}
