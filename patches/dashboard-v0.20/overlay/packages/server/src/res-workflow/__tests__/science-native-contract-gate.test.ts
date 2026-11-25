import { describe, expect, it, vi } from "vitest";
import { createScienceNativeP0ContractGate, SCIENCE_NATIVE_P0_CONTRACT } from "../science-native-contract-gate.js";
import { ScienceNativeDriverError } from "../science-native-driver.js";

const PID = "proj_0123456789ab", FRAME = "11111111-1111-4111-8111-111111111111";
const observe = { projectId: PID, binding: { projectId: PID, taskId: FRAME, rootFrameId: FRAME, frameId: FRAME } };
const submit = { projectId: PID, intentId: FRAME, requestHash: "a".repeat(64), selectedModelId: "ark-sci-deepseek-v4.1-flash", permittedModelIds: ["ark-sci-deepseek-v4.1-flash", "gpt-6.1-sol(max)", "gpt-6-astra(high)"] };
function fixture() {
  const deps = { assertControlledReceipt: vi.fn(async (_action: string, _contract: unknown) => {}), assertCurrentRuntime: vi.fn(async (_contract: unknown) => {}), assertLiveScope: vi.fn(async (_action: string, _context: unknown) => {}) };
  return { deps, gate: createScienceNativeP0ContractGate(deps) };
}
describe("actual P0 contract activation remains separate from task authority", () => {
  it("accepts no serialized capability flags or receipt JSON instead of host verifiers", () => {
    expect(() => createScienceNativeP0ContractGate({ observe: true, submit: true, receipt: SCIENCE_NATIVE_P0_CONTRACT } as never)).toThrow(ScienceNativeDriverError);
  });
  it("enables only observed submit/status contracts after current runtime and live scope verification", async () => {
    const { gate, deps } = fixture();
    await gate.assertCapability("observe", observe); await gate.assertCapability("submit", submit);
    expect(deps.assertControlledReceipt).toHaveBeenCalledWith("observe", SCIENCE_NATIVE_P0_CONTRACT);
    expect(deps.assertCurrentRuntime).toHaveBeenCalledWith(SCIENCE_NATIVE_P0_CONTRACT);
    expect(deps.assertLiveScope).toHaveBeenCalledWith("submit", submit);
    expect(SCIENCE_NATIVE_P0_CONTRACT.scienceBinarySha256).toBe("2139fa524389ec338ad86d50f66e7e7d0c4aa8bf9d7036a15fb196b5bde6a31b");
  });
  it("never promotes reconcile, cancellation or artifact operations based on successful submission", async () => {
    for (const action of ["reconcile", "cancel", "artifacts"] as const) {
      const { gate, deps } = fixture(); await expect(gate.assertCapability(action, observe)).rejects.toBeInstanceOf(ScienceNativeDriverError);
      expect(deps.assertControlledReceipt).not.toHaveBeenCalled(); expect(deps.assertLiveScope).not.toHaveBeenCalled();
    }
  });
  it("requires an explicit default selection and authorization for every configured role target", async () => {
    for (const context of [{ ...submit, selectedModelId: undefined }, { ...submit, selectedModelId: "gpt-6.1-sol(max)" }, { ...submit, permittedModelIds: [submit.selectedModelId] }]) {
      const { gate, deps } = fixture(); await expect(gate.assertCapability("submit", context)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(deps.assertControlledReceipt).not.toHaveBeenCalled();
    }
  });
  it("rejects booleans and raw verifier errors without allowing them to install authority", async () => {
    for (const callback of ["assertControlledReceipt", "assertCurrentRuntime", "assertLiveScope"] as const) {
      const { gate, deps } = fixture(); deps[callback].mockResolvedValue(true as never);
      await expect(gate.assertCapability("observe", observe)).rejects.toMatchObject({ code: "science-native-unavailable" });
    }
    const { gate, deps } = fixture(); deps.assertCurrentRuntime.mockRejectedValue(new Error("fake-private-value-never-export"));
    const error = await gate.assertCapability("observe", observe).catch(value => value); expect(String(error)).not.toContain("fake-private-value");
  });
  it("rechecks the live action scope after asynchronous runtime receipt checks", async () => {
    let active = true; const { gate, deps } = fixture();
    deps.assertLiveScope.mockImplementation(async () => { if (!active) throw new Error("revoked"); });
    deps.assertCurrentRuntime.mockImplementation(async () => { active = false; });
    await expect(gate.assertCapability("observe", observe)).rejects.toMatchObject({ code: "science-native-unavailable" }); expect(deps.assertLiveScope).toHaveBeenCalledTimes(2);
  });
  it("does not accept caller URLs, owner assertions or a frame belonging to another bound project", async () => {
    for (const context of [{ ...observe, ownerKey: "client-claim" }, { ...observe, origin: "http://127.0.0.1:8317" }, { ...observe, binding: { ...observe.binding, projectId: "proj_ffffffffffff" } }]) {
      const { gate, deps } = fixture(); await expect(gate.assertCapability("observe", context)).rejects.toBeInstanceOf(ScienceNativeDriverError); expect(deps.assertLiveScope).not.toHaveBeenCalled();
    }
  });
});
