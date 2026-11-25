import { describe, expect, it } from "vitest";
import { MANAGED_RELEASE_CGROUP, MANAGED_RELEASE_UNIT, type ManagedReleaseLaunchIo, type ManagedReleaseMarker, suppressManagedDashboardLaunch } from "../lifecycle/managed-release-launch.js";
const marker: ManagedReleaseMarker = { schemaVersion: 1, releaseId: "1".repeat(32), unit: MANAGED_RELEASE_UNIT, cgroup: MANAGED_RELEASE_CGROUP, invocationId: "2".repeat(32), oldMainPid: 101, oldMainStartTicks: "1000", oldServerPid: 102, oldServerStartTicks: "1001", createdAtMs: 10000, expiresAtMs: 90000 };
function io(overrides: Partial<ManagedReleaseLaunchIo> = {}): ManagedReleaseLaunchIo {
  return { invocationId: () => marker.invocationId, pid: () => 103, cgroup: () => `0::${MANAGED_RELEASE_CGROUP}`, readRootMarker: () => ({ ...marker }), startTicks: selected => selected === 103 ? "1002" : null, now: () => 20000, ...overrides };
}
describe("old unit replacement launch suppression", () => {
  it("suppresses only an exact old invocation in the pinned cgroup", () => { expect(suppressManagedDashboardLaunch(io())).toBe(true); });
  it("lets the original unit start with its fresh invocation", () => { expect(suppressManagedDashboardLaunch(io({ invocationId: () => "3".repeat(32) }))).toBe(false); });
  it("keeps ordinary shell/other-unit/no-marker starts unchanged", () => {
    const unread = () => { throw new Error("must not read marker"); };
    expect(suppressManagedDashboardLaunch(io({ invocationId: () => undefined, readRootMarker: unread }))).toBe(false);
    expect(suppressManagedDashboardLaunch(io({ cgroup: () => "0::/unrelated", readRootMarker: unread }))).toBe(false);
    expect(suppressManagedDashboardLaunch(io({ readRootMarker: () => null }))).toBe(false);
  });
  it.each([true, false, { ...marker, grant: true }, { ...marker, unit: "other.service" }, { ...marker, oldServerPid: 101 }, { ...marker, expiresAtMs: 200001 }])("refuses malformed data, never restoring a grant (%j)", value => { expect(() => suppressManagedDashboardLaunch(io({ readRootMarker: () => value }))).toThrow("managed-dashboard-launch-refused"); });
  it.each([9999, 90000, 90001, Number.NaN])("fails closed at expiry or invalid time (%s)", now => { expect(() => suppressManagedDashboardLaunch(io({ now: () => now }))).toThrow(); });
  it("rejects PID reuse and an old/self identity", () => {
    expect(() => suppressManagedDashboardLaunch(io({ startTicks: selected => selected === 103 ? "1002" : "9999" }))).toThrow();
    expect(() => suppressManagedDashboardLaunch(io({ pid: () => 102 }))).toThrow();
    expect(() => suppressManagedDashboardLaunch(io({ startTicks: () => "900" }))).toThrow();
  });
  it("accepts still-live old identities only with their exact start ticks", () => { expect(suppressManagedDashboardLaunch(io({ startTicks: selected => selected === 101 ? "1000" : selected === 102 ? "1001" : "1002" }))).toBe(true); });
});
