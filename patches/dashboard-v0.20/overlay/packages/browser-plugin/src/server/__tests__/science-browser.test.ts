// @vitest-environment node
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ScienceHostOpenResult } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScienceBrowserHost, type ScienceProjectBinding, type ScienceProjectPage } from "../science-browser.js";

const fake = vi.hoisted(() => ({ chrome: vi.fn(), proxy: vi.fn() }));
vi.mock("../science-chrome.js", () => ({ createScienceChrome: fake.chrome }));
vi.mock("../science-readonly-proxy.js", () => ({ startScienceReadonlyProxy: fake.proxy }));
const dirs: string[] = [];
const hosts: Array<ReturnType<typeof createScienceBrowserHost>> = [];
type Command = { id: number; method: string; params: Record<string, unknown>; sessionId?: string };
function deferred() { let resolve!: () => void, reject!: (error: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void promise.catch(() => {}); return { promise, resolve, reject }; }
function installFakes() {
  const messages = new Set<(message: unknown) => void>(), exits = new Set<() => void>();
  const commands: Command[] = [], events: string[] = [], activeContexts = new Set<string>();
  const proxies: Array<{ close: ReturnType<typeof vi.fn>; wsClose: ReturnType<typeof vi.fn>; gate?: ReturnType<typeof deferred>; closed: boolean }> = [];
  const emit = (message: unknown) => { for (const receive of [...messages]) receive(message); };
  const commandResult = (command: Command): Record<string, unknown> => {
    switch (command.method) {
      case "Target.createBrowserContext": { const id = `context-${++sequence}`; activeContexts.add(id); return { browserContextId: id }; }
      case "Target.createTarget": return { targetId: `target-${sequence}` };
      case "Target.attachToTarget": return { sessionId: `session-${sequence}` };
      default: return {};
    }
  };
  const disposeContext = async (command: Command) => {
    events.push("dispose-start");
    try { await rig.disposeGate?.promise; }
    catch { emit({ id: command.id, error: { code: -1, message: "fixture-dispose-failed" } }); return; }
    activeContexts.delete(command.params.browserContextId as string); events.push("dispose-end"); emit({ id: command.id, result: {} });
  };
  let sequence = 0;
  const rig = { commands, events, activeContexts, proxies, emit, disposeGate: undefined as ReturnType<typeof deferred> | undefined, failStart: false,
    chrome: {
      ensureRunning: vi.fn(async () => {}), stop: vi.fn(async () => {}),
      onMessage: (receive: (message: unknown) => void) => { messages.add(receive); return () => messages.delete(receive); },
      onExit: (receive: () => void) => { exits.add(receive); return () => exits.delete(receive); },
      send(command: Command) {
        commands.push(command);
        void (async () => {
          const result = commandResult(command);
          if (command.method === "Target.disposeBrowserContext") { await disposeContext(command); return; }
          if (command.method === "Page.startScreencast" && rig.failStart) { emit({ id: command.id, error: { code: -1, message: "fixture-capture-failed" } }); return; }
          emit({ id: command.id, result });
          if (command.method === "Page.navigate") {
            emit({ sessionId: command.sessionId, method: "Page.frameNavigated", params: { frame: { url: command.params.url } } });
            emit({ sessionId: command.sessionId, method: "Page.loadEventFired", params: {} });
          }
        })();
      },
    },
  };
  fake.chrome.mockReset().mockReturnValue(rig.chrome);
  fake.proxy.mockReset().mockImplementation(async () => {
    const proxy = { closed: false, gate: undefined as ReturnType<typeof deferred> | undefined, wsClose: vi.fn(), close: vi.fn(async () => {
      events.push("proxy-close-start"); proxy.wsClose(); await proxy.gate?.promise; proxy.closed = true; events.push("proxy-close-end");
    }) }; proxies.push(proxy);
    return { server: "http://127.0.0.1:12345", challenge: () => ({ response: "CancelAuth" }), close: proxy.close };
  });
  return rig;
}
let rig: ReturnType<typeof installFakes>;
beforeEach(() => { rig = installFakes(); });
afterEach(async () => {
  rig.disposeGate?.resolve(); for (const proxy of rig.proxies) proxy.gate?.resolve();
  await Promise.allSettled(hosts.splice(0).map(host => host.close()));
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});
function ready(result: ScienceHostOpenResult) { expect(result.availability).toBe("ready"); if (result.availability !== "ready") throw new Error("fixture-view-not-ready"); return result.view; }
const instance = (n = 1) => `si-11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
async function lifecycleFixture() {
  const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "science-browser-lifecycle-")); dirs.push(privateDir);
  const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd: privateDir };
  const native = { projectId: "fixture-project", taskId: "fixture-task", rootFrameId: "fixture-root", frameId: "fixture-frame" };
  const resolveBinding = vi.fn(async (selected: typeof partition, instanceId?: string) => ({ ...selected, projectId: native.projectId, instanceId, binding: native, revalidate: async () => {} }));
  const resolvePage = vi.fn(async (binding: ScienceProjectBinding) => {
    rig.events.push("resolve-page");
    const url = `http://127.0.0.1:18765/project/${binding.projectId}/frames/${native.frameId}`;
    return { projectId: native.projectId, entryUrl: url, verifiedProjectScope: true as const, resources: [{ method: "GET" as const, url }] };
  });
  const spawn = vi.fn(), host = createScienceBrowserHost({ privateDir, chrome: { resolveBinary: () => null, spawn }, resolveBinding, resolvePage, prepareSession: async () => true }); hosts.push(host);
  return { host, partition, native, resolveBinding, resolvePage, spawn };
}
function frame(sessionId = "session-1") { rig.emit({ method: "Page.screencastFrame", sessionId, params: { sessionId: 1, data: "Zml4dHVyZQ==", metadata: { deviceWidth: 800, deviceHeight: 600, timestamp: 1 } } }); }
describe("private browser host admission", () => {
  it("does not launch Chrome without registry, project page and private session evidence", async () => {
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "science-browser-unbound-")); dirs.push(privateDir);
    const spawn = vi.fn(); const host = createScienceBrowserHost({ privateDir, chrome: { resolveBinary: () => null, spawn } });
    expect(await host.openWorkspace({ ownerKey: JSON.stringify(["fixture", "owner"]), cwd: privateDir })).toEqual({ availability: "unavailable", reason: "binding-unavailable" }); expect(spawn).not.toHaveBeenCalled(); expect(rig.chrome.ensureRunning).not.toHaveBeenCalled(); await host.close();
  });
  it("rejects a global root page, owner spoof, missing project ID and nonce URL before browser launch", async () => {
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "science-browser-boundary-")); dirs.push(privateDir);
    const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd: privateDir };
    for (const url of ["http://127.0.0.1:18765/", "http://127.0.0.1:18765/project/other", "http://127.0.0.1:18765/project/fixture-project?nonce=must-not-send"]) {
      const spawn = vi.fn();
      const page: ScienceProjectPage = { projectId: "fixture-project", entryUrl: url, verifiedProjectScope: true, resources: [{ url, method: "GET" }] };
      const host = createScienceBrowserHost({ privateDir, chrome: { resolveBinary: () => null, spawn }, resolveBinding: async () => ({ ...partition, projectId: "fixture-project", revalidate: async () => {} }), resolvePage: async () => page, prepareSession: async () => true });
      expect(await host.openWorkspace(partition)).toEqual({ availability: "unavailable", reason: "binding-unavailable" }); expect(spawn).not.toHaveBeenCalled(); expect(rig.chrome.ensureRunning).not.toHaveBeenCalled(); await host.close();
    }
  });
  it("requires all four string native IDs for task viewing, never just a client instance ID", async () => {
    const privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "science-browser-task-")); dirs.push(privateDir);
    const partition = { ownerKey: JSON.stringify(["fixture", "owner"]), cwd: privateDir }, instanceId = "si-11111111-1111-4111-8111-111111111111";
    for (const native of [undefined, { projectId: "fixture-project", rootFrameId: "fixture-root" }, { projectId: "fixture-project", taskId: 7, rootFrameId: "fixture-root", frameId: "fixture-frame" }]) {
      const spawn = vi.fn(); const host = createScienceBrowserHost({ privateDir, chrome: { resolveBinary: () => null, spawn }, resolveBinding: async () => ({ ...partition, projectId: "fixture-project", instanceId, binding: native as never, revalidate: async () => {} }), resolvePage: async () => null, prepareSession: async () => true });
      expect(await host.openTask!(partition, instanceId)).toEqual({ availability: "unavailable", reason: "binding-unavailable" }); expect(spawn).not.toHaveBeenCalled(); expect(rig.chrome.ensureRunning).not.toHaveBeenCalled(); await host.close();
    }
  });
});

describe("private browser consumer lifetime", () => {
  it("keeps a shared view until its last consumer leaves, then releases its context, proxy and private WS", async () => {
    const { host, partition, spawn } = await lifecycleFixture(), view = ready(await host.openWorkspace(partition));
    const first = await view.subscribe(vi.fn()), receive = vi.fn(), second = await view.subscribe(receive);
    first.unsubscribe(); frame(); await vi.waitFor(() => expect(receive).toHaveBeenCalledOnce());
    expect(rig.activeContexts.size).toBe(1); expect(rig.proxies[0].close).not.toHaveBeenCalled();
    second.unsubscribe(); second.unsubscribe();
    await vi.waitFor(() => expect(rig.proxies[0].closed).toBe(true));
    expect(rig.activeContexts.size).toBe(0); expect(rig.proxies[0].close).toHaveBeenCalledOnce(); expect(rig.proxies[0].wsClose).toHaveBeenCalledOnce();
    expect(rig.chrome.stop).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    expect(rig.commands.every(command => /^(Target\.(createBrowserContext|createTarget|attachToTarget|setDiscoverTargets|disposeBrowserContext)|Browser\.setDownloadBehavior|Page\.(enable|navigate|bringToFront|startScreencast|screencastFrameAck)|Network\.(enable|setBypassServiceWorker)|Fetch\.enable)$/.test(command.method))).toBe(true);
  });
  it("removes throwing consumers without retiring another consumer, and retires when the last one throws", async () => {
    const { host, partition } = await lifecycleFixture(), view = ready(await host.openWorkspace(partition));
    const bad = vi.fn(() => { throw new Error("fixture-consumer"); }), survivor = vi.fn();
    await view.subscribe(bad); await view.subscribe(survivor); frame();
    await vi.waitFor(() => expect(survivor).toHaveBeenCalledOnce()); expect(rig.proxies[0].close).not.toHaveBeenCalled();
    survivor.mockImplementation(() => { throw new Error("fixture-last-consumer"); }); frame();
    await vi.waitFor(() => expect(rig.proxies[0].closed).toBe(true));
    frame(); expect(bad).toHaveBeenCalledOnce(); expect(survivor).toHaveBeenCalledTimes(2);
  });
  it("finishes old context and proxy teardown before resolving the next private page", async () => {
    const { host, partition, resolvePage } = await lifecycleFixture();
    const subscription = await ready(await host.openWorkspace(partition)).subscribe(vi.fn());
    const dispose = deferred(), proxy = deferred(); rig.disposeGate = dispose; rig.proxies[0].gate = proxy;
    subscription.unsubscribe();
    const next = host.openTask!(partition, instance());
    await vi.waitFor(() => expect(rig.events).toContain("dispose-start"));
    expect(resolvePage).toHaveBeenCalledOnce();
    dispose.resolve(); await vi.waitFor(() => expect(rig.events).toContain("proxy-close-start"));
    expect(resolvePage).toHaveBeenCalledOnce(); expect(rig.proxies[0].wsClose).toHaveBeenCalledOnce();
    proxy.resolve(); ready(await next);
    expect(rig.events.lastIndexOf("proxy-close-end")).toBeLessThan(rig.events.lastIndexOf("resolve-page"));
  });
  it("reopens a closed task handle through the same partition, instance and four native IDs", async () => {
    const { host, partition, native, resolveBinding, resolvePage } = await lifecycleFixture();
    const view = ready(await host.openTask!(partition, instance())), first = await view.subscribe(vi.fn()); first.unsubscribe();
    const second = await view.subscribe(vi.fn());
    expect(rig.commands.filter(command => command.method === "Target.createBrowserContext")).toHaveLength(2);
    expect(resolvePage).toHaveBeenCalledTimes(2);
    for (const [binding] of resolvePage.mock.calls) { expect(binding.binding).toEqual(native); expect(binding.instanceId).toBe(instance()); }
    for (const [selected, id] of resolveBinding.mock.calls) { expect(selected).toEqual(partition); expect(id).toBe(instance()); }
    expect(rig.chrome.stop).not.toHaveBeenCalled(); second.unsubscribe();
  });
  it("does not accumulate retired task rows against the eight-view limit", async () => {
    const { host, partition } = await lifecycleFixture();
    for (let n = 1; n <= 10; n++) { const subscription = await ready(await host.openTask!(partition, instance(n))).subscribe(vi.fn()); subscription.unsubscribe(); }
    await vi.waitFor(() => expect(rig.proxies.every(proxy => proxy.closed)).toBe(true));
    expect(rig.proxies).toHaveLength(10); expect(rig.activeContexts.size).toBe(0);
  });
  it("joins an already running retirement during host disposal without closing resources twice", async () => {
    const { host, partition } = await lifecycleFixture(), subscription = await ready(await host.openWorkspace(partition)).subscribe(vi.fn());
    const gate = deferred(); rig.disposeGate = gate; subscription.unsubscribe(); const closing = host.close();
    await vi.waitFor(() => expect(rig.events).toContain("dispose-start")); expect(rig.chrome.stop).not.toHaveBeenCalled();
    gate.resolve(); await closing;
    expect(rig.proxies[0].closed).toBe(true); expect(rig.proxies[0].close).toHaveBeenCalledOnce();
    expect(rig.commands.filter(command => command.method === "Target.disposeBrowserContext")).toHaveLength(1);
  });
  it.each(["context", "proxy"])("does not admit another page or leak a rejection after failed %s retirement", async (failure) => {
    const { host, partition, resolvePage } = await lifecycleFixture(), subscription = await ready(await host.openWorkspace(partition)).subscribe(vi.fn());
    const gate = deferred(); if (failure === "context") rig.disposeGate = gate; else rig.proxies[0].gate = gate;
    subscription.unsubscribe(); const next = host.openTask!(partition, instance()); gate.reject(new Error("fixture-teardown-failure"));
    expect(await next).toEqual({ availability: "unknown", reason: "view-unavailable" });
    expect(resolvePage).toHaveBeenCalledOnce(); expect(rig.proxies[0].close).toHaveBeenCalledOnce(); expect(rig.chrome.stop).not.toHaveBeenCalled();
  });
  it("retires the view when its first screencast subscription fails", async () => {
    const { host, partition } = await lifecycleFixture(), view = ready(await host.openWorkspace(partition)); rig.failStart = true;
    await expect(view.subscribe(vi.fn())).rejects.toThrow("science-view-unavailable");
    await vi.waitFor(() => expect(rig.proxies[0].closed).toBe(true)); expect(rig.activeContexts.size).toBe(0);
  });
});
