import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScienceRegistryDeps } from "@blackbelt-technology/pi-dashboard-server/science-registry";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScienceReadonlyHost, type ScienceReadonlyHostDeps } from "../../../../claude-science/host/science-host-composition.js";
import { createScienceHostClient } from "../res-workflow/science-host-client.js";

const traced = vi.hoisted(() => ({ events: [] as string[], registryDeps: [] as ScienceRegistryDeps[], browserDeps: [] as any[], failStart: false }));
vi.mock("@blackbelt-technology/pi-dashboard-server/science-registry", async importOriginal => {
  const actual = await importOriginal<typeof import("@blackbelt-technology/pi-dashboard-server/science-registry")>();
  return { ...actual, openScienceRegistry: vi.fn(async (...args: Parameters<typeof actual.openScienceRegistry>) => {
    traced.registryDeps.push(args[1]); const registry = await actual.openScienceRegistry(...args);
    return { ...registry, close: async () => { traced.events.push("registry"); await registry.close(); } };
  }) };
});
vi.mock("@blackbelt-technology/pi-dashboard-server/science-host-daemon", async importOriginal => {
  const actual = await importOriginal<typeof import("@blackbelt-technology/pi-dashboard-server/science-host-daemon")>();
  return { ...actual, createScienceHostDaemon: (...args: Parameters<typeof actual.createScienceHostDaemon>) => {
    const daemon = actual.createScienceHostDaemon(...args);
    return { start: async () => { await daemon.start(); if (traced.failStart) throw new Error("synthetic start failure"); }, close: async () => { traced.events.push("daemon"); await daemon.close(); } };
  } };
});
vi.mock("@blackbelt-technology/pi-dashboard-browser-plugin/science-host", () => ({ createScienceBrowserHost: (deps: unknown) => {
  traced.browserDeps.push(deps);
  const view = { subscribe: async () => ({ input: async () => {}, unsubscribe() {} }) };
  return { openWorkspace: async () => ({ availability: "ready", view }), openTask: async () => ({ availability: "ready", view }), close: async () => { traced.events.push("browser"); } };
} }));

const cleanups: Array<() => Promise<unknown> | void> = [];
beforeEach(() => { traced.events.length = 0; traced.registryDeps.length = 0; traced.browserDeps.length = 0; traced.failStart = false; });
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "science-composition-")); cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), registryRoot = path.join(root, "records"), chromePrivateDir = path.join(root, "chrome"), transportPrivateDir = path.join(root, "ipc");
  for (const dir of [cwd, registryRoot, chromePrivateDir, transportPrivateDir]) await fs.mkdir(dir, { mode: 0o700 });
  await fs.writeFile(path.join(transportPrivateDir, "viewer.secret"), randomBytes(32), { mode: 0o600 });
  const partition = { cwd, ownerKey: JSON.stringify(["fixture", "owner"]) }, binding = { projectId: "proj_fixture", taskId: "frame_fixture", rootFrameId: "frame_fixture", frameId: "frame_child" };
  let allowed = true, returnValue: unknown;
  const revalidate = vi.fn(async () => { if (!allowed) throw new Error("private-grant-error"); return returnValue as void; });
  const observeBinding = vi.fn<ScienceReadonlyHostDeps["observeBinding"]>(async selected => ({ ...selected, status: "running" }));
  const resolvePage = vi.fn(async () => ({ projectId: binding.projectId, entryUrl: `http://127.0.0.1:18765/projects/${binding.projectId}`, resources: [], verifiedProjectScope: true as const }));
  const prepareSession = vi.fn(async () => true);
  const deps = { registryRoot, chromePrivateDir, transportPrivateDir, scope: { partition, binding, revalidate }, observeBinding, resolvePage, prepareSession, chrome: { resolveBinary: () => "/fixture/chrome" } };
  const start = async () => { const host = await createScienceReadonlyHost(deps); cleanups.push(() => host.close()); return host; };
  const client = createScienceHostClient({ privateDir: transportPrivateDir }); cleanups.push(() => client.dispose());
  return { deps, partition, binding, start, client, observeBinding, resolvePage, prepareSession, revoke: () => { allowed = false; }, returnGrant: (value: unknown) => { returnValue = value; } };
}

describe("independent readonly host production composition", () => {
  it("imports the existing binding once, exposes its opaque record and supplies concrete native providers", async () => {
    const f = await fixture(), host = await f.start();
    expect(traced.registryDeps).toHaveLength(1); expect(f.observeBinding).not.toHaveBeenCalled();
    const listed = await f.client.list(f.partition); expect(listed.availability).toBe("ready");
    if (listed.availability !== "ready") throw new Error("fixture unavailable");
    expect(listed.instances.map(row => row.id)).toEqual([host.instanceId]); expect(host.instanceId).toMatch(/^si-/);
    expect((await host.observe()).status).toBe("running"); expect(f.observeBinding).toHaveBeenCalledTimes(1); expect(f.observeBinding).toHaveBeenCalledWith(f.binding);
    expect(traced.browserDeps[0].resolvePage).toBe(f.resolvePage); expect(traced.browserDeps[0].prepareSession).toBe(f.prepareSession);
    const workspace = await traced.browserDeps[0].resolveBinding(f.partition);
    expect(workspace.projectId).toBe(f.binding.projectId); expect(workspace).not.toHaveProperty("binding");
    const task = await traced.browserDeps[0].resolveBinding(f.partition, host.instanceId);
    expect(task.binding).toEqual(f.binding); expect(await traced.browserDeps[0].resolveBinding(f.partition, "si-11111111-1111-4111-8111-111111111111")).toBeNull();
  });
  it("limits authority to exact four IDs and hard-denies every mutation driver", async () => {
    const f = await fixture(); await f.start(); const deps = traced.registryDeps[0];
    await expect(deps.authority.assert(f.partition, { kind: "bind", projectId: f.binding.projectId, binding: { ...f.binding, frameId: "other" } })).rejects.toThrow();
    await expect(deps.authority.assert(f.partition, { kind: "bind", projectId: f.binding.projectId })).rejects.toThrow();
    for (const action of [{ kind: "submit" }, { kind: "cancel" }, { kind: "collect-artifacts" }]) await expect(deps.authority.assert(f.partition, action as never)).rejects.toThrow();
    await expect(deps.driver.submit({} as never)).rejects.toThrow(); await expect(deps.driver.cancel(f.binding)).rejects.toThrow(); await expect(deps.driver.reconcile({} as never)).rejects.toThrow();
    await expect(deps.driver.observe({ ...f.binding, taskId: "other" })).rejects.toThrow(); expect(f.observeBinding).not.toHaveBeenCalled();
  });
  it("requires strict-void fresh authority rather than truthy or serialized grants", async () => {
    const f = await fixture();
    for (const value of [true, { allowed: true }, null, "authorized"]) { f.returnGrant(value); await expect(f.start()).rejects.toThrow("science-host-composition-unavailable"); }
    expect(traced.registryDeps).toHaveLength(0);
  });
  it("rejects inherited native IDs in both initial scope and later bind assertions", async () => {
    const f = await fixture(), inherited = Object.assign(Object.create(f.binding), { a: 1, b: 1, c: 1, d: 1 });
    await expect(createScienceReadonlyHost({ ...f.deps, scope: { ...f.deps.scope, binding: inherited } })).rejects.toThrow("science-host-composition-unavailable");
    expect(traced.registryDeps).toHaveLength(0); await f.start();
    await expect(traced.registryDeps[0].authority.assert(f.partition, { kind: "bind", projectId: f.binding.projectId, binding: inherited })).rejects.toThrow();
  });
  it("revokes live record reads, page bindings and same-task observations", async () => {
    const f = await fixture(), host = await f.start(); f.revoke();
    expect(await f.client.list(f.partition)).toEqual({ availability: "unavailable", reason: "binding-unavailable" });
    expect(await traced.browserDeps[0].resolveBinding(f.partition, host.instanceId)).toBeNull();
    await expect(host.observe()).rejects.toThrow("science-host-composition-unavailable"); expect(f.observeBinding).not.toHaveBeenCalled();
  });
  it("keeps invalid observation identities/status private and stale", async () => {
    const f = await fixture(), host = await f.start();
    for (const change of [{ frameId: "other" }, { status: "invented" }, { privateBody: "must-not-escape" }]) {
      f.observeBinding.mockImplementation(async selected => ({ ...selected, status: "running", ...change } as never));
      const result = await host.observe(); expect(result.status).toBe("unknown"); expect(result.stale).toBe(true); expect(JSON.stringify(result)).not.toMatch(/privateBody|must-not-escape|other|invented/);
    }
  });
  it("discards a same-task observation when live scope is revoked during its read", async () => {
    const f = await fixture(), host = await f.start();
    f.observeBinding.mockImplementation(async selected => { f.revoke(); return { ...selected, status: "completed" }; });
    await expect(host.observe()).rejects.toThrow("science-host-composition-unavailable"); expect(f.observeBinding).toHaveBeenCalledTimes(1);
  });
  it("keeps the imported four-ID snapshot when the caller changes its original object", async () => {
    const f = await fixture(), expected = { ...f.binding }, host = await f.start(); f.binding.frameId = "spoofed";
    const task = await traced.browserDeps[0].resolveBinding(f.partition, host.instanceId); expect(task.binding).toEqual(expected);
    await host.observe(); expect(f.observeBinding).toHaveBeenCalledWith(expected);
  });
  it("releases partial startup resources and closes daemon/browser/registry in order", async () => {
    const f = await fixture(); traced.failStart = true;
    await expect(f.start()).rejects.toThrow("science-host-composition-unavailable"); expect(traced.events).toEqual(["daemon", "browser", "registry"]);
    traced.failStart = false; traced.events.length = 0; const host = await f.start(); await host.close(); await host.close();
    expect(traced.events).toEqual(["daemon", "browser", "registry"]); expect(f.observeBinding).not.toHaveBeenCalled();
  });
  it("requires real provider functions before opening a writer", async () => {
    const f = await fixture();
    for (const name of ["resolvePage", "prepareSession", "observeBinding"] as const) await expect(createScienceReadonlyHost({ ...f.deps, [name]: undefined } as never)).rejects.toThrow("science-host-composition-unavailable");
    expect(traced.registryDeps).toHaveLength(0);
  });
});
