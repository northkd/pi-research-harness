import { beforeEach, expect, it, vi } from "vitest";
import { createHeadlessPidRegistry } from "../spawn-process/headless-pid-registry.js";
const fake = vi.hoisted(() => ({ entries: [] as any[], alive: new Set<number>(), kill: vi.fn(), groupKill: vi.fn(), writes: [] as any[] }));
vi.mock("@blackbelt-technology/pi-dashboard-shared/platform/process.js", () => ({ isProcessAlive: (pid: number) => fake.alive.has(pid), killProcess: fake.kill, killPidWithGroup: fake.groupKill }));
vi.mock("../auth/test-env-guard.js", () => ({ isUnsafeTestHomeScan: () => false }));
vi.mock("../persistence/json-store.js", () => ({ readJsonFile: () => ({ entries: fake.entries }), writeJsonFile: (_path: string, data: unknown) => { fake.writes.push(data); } }));
beforeEach(() => { fake.entries = []; fake.alive.clear(); fake.kill.mockReset(); fake.groupKill.mockReset(); fake.writes = []; });
it("retains a live research keeper older than seven days with all matching fields", async () => {
  fake.entries = [{ pid: 301, cwd: "/synthetic", spawnedAt: new Date(Date.now() - 8 * 86400000).toISOString(), spawnToken: "synthetic-token", keeperPid: 301, piPid: 302, keeperSockPath: "/synthetic/transport" }]; fake.alive.add(301);
  const registry = createHeadlessPidRegistry({ pidFilePath: "/synthetic/registry.json" }); await registry.cleanupOrphans();
  expect(fake.kill).not.toHaveBeenCalled(); expect(fake.groupKill).not.toHaveBeenCalled(); expect(registry.size()).toBe(1);
  expect(registry.linkByToken("synthetic-token", "synthetic-session", 302)).toBe(true); expect(registry.getPid("synthetic-session")).toBe(302);
});
it("still drops a dead old entry without sending any signal", async () => {
  fake.entries = [{ pid: 301, cwd: "/synthetic", spawnedAt: new Date(0).toISOString() }];
  const registry = createHeadlessPidRegistry({ pidFilePath: "/synthetic/registry.json" }); await registry.cleanupOrphans();
  expect(registry.size()).toBe(0); expect(fake.kill).not.toHaveBeenCalled(); expect(fake.groupKill).not.toHaveBeenCalled();
});
