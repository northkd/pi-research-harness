import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MANAGED_RELEASE_CGROUP, MANAGED_RELEASE_MARKER, MANAGED_RELEASE_UNIT, suppressManagedDashboardLaunch } from "../lifecycle/managed-release-launch.js";
const fake = vi.hoisted(() => ({ mode: 0o444, uid: 0, parentMode: 0o755, parentLink: false, markerLink: false, replaced: false, replaceOnOpen: false, body: "", opens: new Map<number, string>(), nextFd: 10, closes: vi.fn(), stats: 0 }));
vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const stat = (dir: boolean) => ({ dev: 1, ino: fake.replaced && !dir ? 3 : 2, size: dir ? 0 : Buffer.byteLength(fake.body), mtimeMs: 1, ctimeMs: 1, mode: dir ? fake.parentMode : fake.mode, uid: dir ? 0 : fake.uid, gid: 0, nlink: 1, isDirectory: () => dir, isFile: () => !dir, isSymbolicLink: () => dir ? fake.parentLink : fake.markerLink });
  function bytes(path: string) {
    if (path.endsWith("/cgroup")) return Buffer.from(`0::${MANAGED_RELEASE_CGROUP}\n`);
    if (path.endsWith("/stat")) { const pid = Number(path.split("/")[2]); if (pid === 101 || pid === 102) throw Object.assign(new Error("gone"), { code: "ENOENT" }); const fields = ["S", ...Array(18).fill("0"), "1002"]; return Buffer.from(`${pid} (synthetic) ${fields.join(" ")}`); }
    return Buffer.from(fake.body);
  }
  return { ...actual,
    lstatSync: (path: string) => { fake.stats++; return stat(path !== "/run/pi-research-dashboard-release/restart.json"); },
    openSync: (path: string) => { if (path.endsWith("/stat")) bytes(path); if (path.endsWith("restart.json") && fake.replaceOnOpen) fake.replaced=true; const fd = fake.nextFd++; fake.opens.set(fd, path); return fd; },
    readSync: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => { const value = bytes(fake.opens.get(fd)!); return value.copy(buffer, offset, position, Math.min(value.length, position + length)); },
    fstatSync: () => stat(false),
    closeSync: (fd: number) => { fake.closes(fd); fake.opens.delete(fd); },
  };
});
beforeEach(() => {
  fake.mode=0o444; fake.uid=0; fake.parentMode=0o755; fake.parentLink=false; fake.markerLink=false; fake.replaced=false; fake.replaceOnOpen=false; fake.stats=0; fake.closes.mockClear(); fake.opens.clear();
  vi.stubEnv("INVOCATION_ID", "2".repeat(32));
  const now=Date.now(); fake.body=JSON.stringify({ schemaVersion:1, releaseId:"1".repeat(32), unit:MANAGED_RELEASE_UNIT, cgroup:MANAGED_RELEASE_CGROUP, invocationId:"2".repeat(32), oldMainPid:101,oldMainStartTicks:"1000",oldServerPid:102,oldServerStartTicks:"1001",createdAtMs:now-1,expiresAtMs:now+60000 });
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
it("uses only the fixed root marker and fake bounded kernel metadata", () => { expect(suppressManagedDashboardLaunch()).toBe(true); expect(fake.opens.size).toBe(0); expect(fake.closes).toHaveBeenCalled(); expect(MANAGED_RELEASE_MARKER).toBe('/run/pi-research-dashboard-release/restart.json'); });
it.each(['owner','mode','parent-write','parent-link','marker-link'])('refuses unsafe %s before allowing a replacement launch', field => {
  if(field==='owner')fake.uid=1000; if(field==='mode')fake.mode=0o644; if(field==='parent-write')fake.parentMode=0o777; if(field==='parent-link')fake.parentLink=true; if(field==='marker-link')fake.markerLink=true;
  expect(()=>suppressManagedDashboardLaunch()).toThrow('managed-dashboard-launch-refused');
});
it("rejects a marker changed between lstat and open and closes the descriptor", () => {
  // The opened inode differs from the pathname's first observation.
  fake.replaceOnOpen=true; expect(()=>suppressManagedDashboardLaunch()).toThrow(); expect(fake.opens.size).toBe(0);
});
it("refuses an oversized marker before parsing data", () => { fake.body='x'.repeat(8193); expect(()=>suppressManagedDashboardLaunch()).toThrow(); expect(fake.opens.size).toBe(0); });
