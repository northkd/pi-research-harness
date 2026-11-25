import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createScienceGatewayMaintenance,
  type ScienceGatewayMaintenanceLease,
  type ScienceGatewayMaintenanceObservation,
  type ScienceGatewayMaintenanceTarget,
} from "../science-gateway-maintenance.js";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const oldKey = "fixture-old-maintenance-client-00000000000000";
const newKey = "fixture-new-maintenance-client-00000000000000";
const source = `# fake credentials only
api-keys:
  - "${oldKey}"
claude-api-key:
  - api-key: fixture-upstream-secret
    base-url: https://ark.cn-beijing.volces.com/api/coding
    models:
      - name: deepseek-v4.1-flash
        alias: deepseek-v4.1-flash
routing:
  strategy: round-robin
`;
const imageId = "sha256:8e03771cd4846b3f3547ef8b2d60a58f64e80754fccd0f18850da5c649fba323";
const realOpen = vi.mocked(fs.open).getMockImplementation()!;
let directory: string;
let target: ScienceGatewayMaintenanceTarget;
let running: boolean;
let observationChanges: Partial<ScienceGatewayMaintenanceObservation>;
let authorizations: WeakMap<object, ScienceGatewayMaintenanceLease>;
let exclusive = false;
const generateKey = vi.fn(() => newKey);
const stop = vi.fn(async () => { running = false; });
const start = vi.fn(async () => { running = true; });

async function observe(): Promise<ScienceGatewayMaintenanceObservation> {
  return {
    containerId: target.containerId, containerName: target.containerName, imageId: target.imageId,
    running, restarting: false, pid: running ? 3333 : 0,
    mounts: [{ type: "bind", source: target.configFile, destination: target.containerConfig, readWrite: true }],
    boundDevice: target.device, boundInode: target.inode,
    ...observationChanges,
  };
}

function service() {
  return createScienceGatewayMaintenance(target, { observe, authorizations, generateKey });
}

function approve(controller: ReturnType<typeof service>) {
  const receipt = Object.freeze({});
  authorizations.set(receipt, {
    review: controller.review(), observe, stop, start,
    withExclusiveConfigWindow: async (operation) => {
      const handle = await fs.open(target.configFile, constants.O_RDWR | constants.O_NOFOLLOW);
      exclusive = true;
      try { return await operation(handle); }
      finally { exclusive = false; await handle.close(); }
    },
  });
  return receipt;
}

async function interceptOpen(replace: (handle: fs.FileHandle, filename: string, flags: unknown) => fs.FileHandle) {
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    return replace(handle, String(args[0]), args[1]);
  });
}

function proxy(handle: fs.FileHandle, overrides: Record<string, unknown>) {
  return new Proxy(handle, {
    get(object, property) {
      if (typeof property === "string" && property in overrides) return overrides[property];
      const value = Reflect.get(object, property);
      return typeof value === "function" ? value.bind(object) : value;
    },
  });
}

async function atDurablePhase(expected: string, action: () => Promise<void>) {
  await interceptOpen((handle, filename) => {
    if (!filename.endsWith("/intent.next")) return handle;
    let phase = "";
    return proxy(handle, {
      writeFile: async (...args: Parameters<fs.FileHandle["writeFile"]>) => {
        phase = JSON.parse(String(args[0])).phase;
        return Reflect.apply(handle.writeFile, handle, args);
      },
      sync: async () => { await handle.sync(); if (phase === expected) await action(); },
    });
  });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), "science-maintenance-fake-"));
  const configFile = path.join(directory, "config.yaml");
  await fs.writeFile(configFile, source, { mode: 0o644 });
  await fs.chmod(configFile, 0o644);
  const stat = await fs.stat(configFile, { bigint: true });
  target = {
    containerId: "f".repeat(64), containerName: "cli-proxy-api", imageId,
    configFile, containerConfig: "/CLIProxyAPI/config.yaml", privateDirectory: path.join(directory, "private"),
    device: String(stat.dev), inode: String(stat.ino), originalMode: 0o644,
  };
  running = true;
  observationChanges = {};
  authorizations = new WeakMap();
  exclusive = false;
  generateKey.mockClear();
  stop.mockReset().mockImplementation(async () => { running = false; });
  start.mockReset().mockImplementation(async () => { running = true; });
});

afterEach(async () => {
  vi.mocked(fs.open).mockImplementation(realOpen);
  vi.restoreAllMocks();
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Science gateway maintenance: fake host only", () => {
  it("makes review and default apply genuinely read-only", async () => {
    const controller = service();
    const review = controller.review();
    expect(Object.isFrozen(review)).toBe(true);
    expect(review.actions).toEqual(["stop-exact-container", "chmod-config-0644-to-0600", "write-approved-key-and-alias", "verify-and-start-exact-container"]);
    expect(await controller.apply()).toEqual({ status: "approval-required" });
    expect(await fs.readdir(directory)).toEqual(["config.yaml"]);
    expect(generateKey).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect((await fs.stat(target.configFile)).mode & 0o777).toBe(0o644);
  });

  it("whitelists review fields instead of copying arbitrary host input", () => {
    const extra = { ...target, fixtureSecret: "fake-field" };
    const controller = createScienceGatewayMaintenance(extra, { observe, authorizations, generateKey });
    expect(JSON.stringify(controller.review())).not.toContain("fake-field");
  });

  it.each([true, false, "approved", { approved: true, scope: "maintenance" }, {}])("rejects forged approval %# by runtime object identity", async (receipt) => {
    const controller = service();
    await controller.prepare();
    expect(await controller.apply(receipt)).toEqual({ status: "approval-required" });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
  });

  it("rejects a lease bound to a different controller review", async () => {
    const first = service();
    const second = service();
    await first.prepare();
    expect(await second.apply(approve(first))).toEqual({ status: "approval-required" });
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects a serialized copy of the review even when its fields match", async () => {
    const controller = service(); await controller.prepare();
    const receipt = approve(controller);
    const lease = authorizations.get(receipt)!;
    authorizations.set(receipt, { ...lease, review: JSON.parse(JSON.stringify(lease.review)) });
    expect(await controller.apply(receipt)).toEqual({ status: "approval-required" });
    expect(stop).not.toHaveBeenCalled();
  });

  it.each([undefined, true])("refuses an incomplete exclusive-window capability before stopping: %s", async (window) => {
    const controller = service(); await controller.prepare();
    const receipt = approve(controller);
    const lease = authorizations.get(receipt)!;
    authorizations.set(receipt, { ...lease, withExclusiveConfigWindow: window } as unknown as ScienceGatewayMaintenanceLease);
    expect(await controller.apply(receipt)).toEqual({ status: "approval-required" });
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect((await fs.stat(target.configFile)).mode & 0o777).toBe(0o644);
  });

  it("prepares one private key and exact backup/candidate/intent without changing mode or stopping", async () => {
    const controller = service();
    expect(await controller.prepare()).toEqual({ status: "prepared" });
    expect(await controller.prepare()).toEqual({ status: "prepared" });
    expect(generateKey).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
    expect((await fs.stat(target.configFile)).mode & 0o777).toBe(0o644);
    expect((await fs.stat(target.privateDirectory)).mode & 0o777).toBe(0o700);
    for (const name of ["client.key", "original.yaml", "candidate.yaml", "intent.json"]) {
      expect((await fs.stat(path.join(target.privateDirectory, name))).mode & 0o777).toBe(0o600);
    }
    expect(await fs.readFile(path.join(target.privateDirectory, "client.key"), "utf8")).toBe(newKey);
    expect(await fs.readFile(path.join(target.privateDirectory, "original.yaml"), "utf8")).toBe(source);
  });

  it("only mutates inside the stopped exclusive window, then starts the same verified container", async () => {
    const controller = service();
    await controller.prepare();
    const expected = await fs.readFile(path.join(target.privateDirectory, "candidate.yaml"), "utf8");
    const order: string[] = [];
    stop.mockImplementationOnce(async () => { order.push("stop"); running = false; });
    start.mockImplementationOnce(async () => {
      order.push("start");
      expect(await fs.readFile(target.configFile, "utf8")).toBe(expected);
      expect((await fs.stat(target.configFile)).mode & 0o777).toBe(0o600);
      running = true;
    });
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, {
        chmod: async (mode: number) => {
          expect(exclusive).toBe(true); expect(running).toBe(false);
          expect(JSON.parse(await fs.readFile(path.join(target.privateDirectory, "intent.json"), "utf8"))).toMatchObject({ phase: "writing", originalMode: 0o644 });
          order.push("chmod"); return handle.chmod(mode);
        },
        write: async (...args: Parameters<fs.FileHandle["write"]>) => {
          expect(exclusive).toBe(true); expect(running).toBe(false);
          order.push("write"); return Reflect.apply(handle.write, handle, args);
        },
      }) : handle);
    expect(await controller.apply(approve(controller))).toEqual({ status: "gateway-started", reason: "post-start-validation-required" });
    expect(order).toEqual(["stop", "chmod", "write", "start"]);
    expect(String((await fs.stat(target.configFile, { bigint: true })).ino)).toBe(target.inode);
    expect(await fs.readFile(target.configFile, "utf8")).toBe(expected);
  });

  it.each(["container", "image", "bind", "inode", "duplicate-bind"])("rejects changed %s before touching the service", async (mismatch) => {
    const controller = service();
    await controller.prepare();
    if (mismatch === "container") observationChanges.containerId = "e".repeat(64);
    if (mismatch === "image") observationChanges.imageId = `sha256:${"a".repeat(64)}`;
    if (mismatch === "inode") observationChanges.boundInode = "1";
    if (mismatch === "bind") observationChanges.mounts = [{ type: "bind", source: "/fixture-other", destination: target.containerConfig, readWrite: true }];
    if (mismatch === "duplicate-bind") observationChanges.mounts = [
      { type: "bind", source: target.configFile, destination: target.containerConfig, readWrite: true },
      { type: "bind", source: target.configFile, destination: target.containerConfig, readWrite: true },
    ];
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "conflict" });
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
  });

  it("does not take ownership of a container that was already stopped", async () => {
    const controller = service();
    await controller.prepare();
    running = false;
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "conflict" });
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it.each(["running", "restarting", "pid"])("requires an exact stopped observation after stop: %s", async (mismatch) => {
    const controller = service();
    await controller.prepare();
    stop.mockImplementationOnce(async () => {
      running = false;
      if (mismatch === "running") running = true;
      if (mismatch === "restarting") observationChanges.restarting = true;
      if (mismatch === "pid") observationChanges.pid = 99;
    });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
    expect((await fs.stat(target.configFile)).mode & 0o777).toBe(0o644);
    expect(start).not.toHaveBeenCalled();
  });

  it("checks whole-source CAS after stopping and preserves another writer's change", async () => {
    const controller = service();
    await controller.prepare();
    const changed = `${source}# fixture-user-edit\n`;
    stop.mockImplementationOnce(async () => { running = false; await fs.writeFile(target.configFile, changed); });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(await fs.readFile(target.configFile, "utf8")).toBe(changed);
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses changed source before the first stop", async () => {
    const controller = service(); await controller.prepare();
    const changed = `${source}# fixture-user-edit-before-stop\n`;
    await fs.writeFile(target.configFile, changed);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "conflict" });
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toBe(changed);
  });

  it("rechecks source after the stopping journal fsync before issuing stop", async () => {
    const controller = service(); await controller.prepare();
    const changed = `${source}# fixture-edit-during-stop-intent\n`;
    await atDurablePhase("stopping", async () => { await fs.writeFile(target.configFile, changed); });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toBe(changed);
  });

  it("handles short writes while revalidating exact stopped state", async () => {
    const controller = service();
    await controller.prepare();
    const expected = await fs.readFile(path.join(target.privateDirectory, "candidate.yaml"), "utf8");
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, { write: async (buffer: Buffer, offset: number, length: number, position: number) => {
        expect(running).toBe(false); return handle.write(buffer, offset, Math.min(length, 31), position);
      } }) : handle);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "gateway-started" });
    expect(await fs.readFile(target.configFile, "utf8")).toBe(expected);
  });

  it("uses its inherited file description without opening another reader during the lease", async () => {
    const controller = service(); await controller.prepare();
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (exclusive && args[0] === target.configFile) throw new Error("fixture-conflicting-new-open");
      return realOpen(...args);
    });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "gateway-started" });
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("leaves a partial write unknown with no start, rollback, retry or regenerated key", async () => {
    const controller = service();
    await controller.prepare();
    let writes = 0;
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, { write: async (buffer: Buffer, offset: number, _length: number, position: number) => {
        if (++writes > 1) throw new Error(`fixture-disk-${newKey}`);
        return handle.write(buffer, offset, source.indexOf("claude-api-key:") + 5, position);
      } }) : handle);
    const receipt = approve(controller);
    expect(await controller.apply(receipt)).toMatchObject({ status: "unknown" });
    const partial = await fs.readFile(target.configFile);
    expect(partial.equals(Buffer.from(source))).toBe(false);
    expect(await controller.apply(receipt)).toMatchObject({ status: "unknown" });
    const recreated = service();
    expect(await recreated.apply(approve(recreated))).toMatchObject({ status: "unknown" });
    expect(await controller.prepare()).toMatchObject({ status: "unknown" });
    expect(await controller.reconcile()).toMatchObject({ status: "unknown", observed: { config: "other", service: "stopped" } });
    expect(await fs.readFile(target.configFile)).toEqual(partial);
    expect(writes).toBe(2); expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it("does not treat a chmod-only failure as unchanged and never restarts", async () => {
    const controller = service();
    await controller.prepare();
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, { chmod: async (mode: number) => { await handle.chmod(mode); throw new Error("fixture-chmod-ack-failed"); } }) : handle);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect((await fs.stat(target.configFile)).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
    expect(start).not.toHaveBeenCalled();
  });

  it("never starts after complete bytes when file fsync failed", async () => {
    const controller = service();
    await controller.prepare();
    let synchronizations = 0;
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, { sync: async () => { if (++synchronizations === 2) throw new Error("fixture-file-fsync"); await handle.sync(); } }) : handle);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(await controller.reconcile()).toMatchObject({ status: "unknown", observed: { config: "candidate", service: "stopped" } });
    expect(start).not.toHaveBeenCalled();
  });

  it("never starts if the host cannot confirm closing the exclusive file window", async () => {
    const controller = service(); await controller.prepare();
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, { close: async () => { await handle.close(); throw new Error("fixture-window-close-error"); } }) : handle);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled();
    const recreated = service();
    expect(await recreated.apply(approve(recreated))).toMatchObject({ status: "unknown" });
  });

  it("does not generate another credential after private key fsync fails", async () => {
    await interceptOpen((handle, filename) => filename.endsWith("/client.key")
      ? proxy(handle, { sync: async () => { throw new Error(`fixture-private-fsync-${newKey}`); } }) : handle);
    expect(await service().prepare()).toMatchObject({ status: "unknown" });
    expect(await service().prepare()).toMatchObject({ status: "unknown" });
    expect(generateKey).toHaveBeenCalledTimes(1); expect(stop).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
  });

  it("keeps private directory fsync errors unknown before any stop", async () => {
    await interceptOpen((handle, filename, flags) => filename.endsWith("/private") && typeof flags === "number" && (flags & constants.O_DIRECTORY)
      ? proxy(handle, { sync: async () => { throw new Error("fixture-directory-fsync"); } }) : handle);
    expect(await service().prepare()).toMatchObject({ status: "unknown" });
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
  });

  it("detects service reappearance during short writes and never starts it again", async () => {
    const controller = service();
    await controller.prepare();
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, { write: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await handle.write(buffer, offset, Math.min(length, 17), position); running = true; return result;
      } }) : handle);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
  });

  it("detects an intervening writer before the next short write without overwriting its new bytes", async () => {
    const controller = service();
    await controller.prepare();
    const marker = "# fixture-concurrent-writer\n";
    await interceptOpen((handle, filename, flags) => filename === target.configFile && typeof flags === "number" && (flags & constants.O_RDWR)
      ? proxy(handle, { write: async (buffer: Buffer, offset: number, length: number, position: number) => {
        const result = await handle.write(buffer, offset, Math.min(length, 19), position); await fs.appendFile(target.configFile, marker); return result;
      } }) : handle);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(await fs.readFile(target.configFile, "utf8")).toContain(marker);
    expect(start).not.toHaveBeenCalled();
  });

  it("never retries an uncertain stop", async () => {
    const controller = service(); await controller.prepare();
    stop.mockImplementationOnce(async () => { running = false; throw new Error("fixture-stop-ack-failed"); });
    const receipt = approve(controller);
    expect(await controller.apply(receipt)).toMatchObject({ status: "unknown" });
    expect(await controller.apply(receipt)).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled(); expect(stop).toHaveBeenCalledTimes(1);
    expect(await fs.readFile(target.configFile, "utf8")).toBe(source);
  });

  it.each([null, undefined, "fixture-private-rejection"])("normalizes arbitrary host rejection %#", async (failure) => {
    const controller = service(); await controller.prepare();
    stop.mockRejectedValueOnce(failure);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled();
  });

  it("never retries an uncertain start even when complete candidate bytes exist", async () => {
    const controller = service(); await controller.prepare();
    start.mockImplementationOnce(async () => { running = true; throw new Error("fixture-start-ack-failed"); });
    const receipt = approve(controller);
    expect(await controller.apply(receipt)).toMatchObject({ status: "unknown" });
    expect(await controller.apply(receipt)).toMatchObject({ status: "unknown" });
    expect(await controller.reconcile()).toMatchObject({ status: "unknown", observed: { config: "candidate", service: "running" } });
    expect(start).toHaveBeenCalledTimes(1); expect(stop).toHaveBeenCalledTimes(1);
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it.each(["written", "starting"])("never starts when %s private intent fsync is uncertain", async (phase) => {
    const controller = service(); await controller.prepare();
    await atDurablePhase(phase, async () => { throw new Error("fixture-intent-fsync-ack-error"); });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled();
    const recreated = service();
    expect(await recreated.apply(approve(recreated))).toMatchObject({ status: "unknown" });
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it.each(["written", "starting"])("never starts when the %s intent directory fsync fails", async (phase) => {
    const controller = service(); await controller.prepare();
    await interceptOpen((handle, filename, flags) => filename.endsWith("/private") && typeof flags === "number" && (flags & constants.O_DIRECTORY)
      ? proxy(handle, { sync: async () => {
        const intent = JSON.parse(await fs.readFile(path.join(target.privateDirectory, "intent.json"), "utf8"));
        if (intent.phase === phase) throw new Error("fixture-intent-dir-fsync");
        await handle.sync();
      } }) : handle);
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled();
    const recreated = service();
    expect(await recreated.apply(approve(recreated))).toMatchObject({ status: "unknown" });
  });

  it("rechecks candidate bytes after the starting journal fsync before issuing start", async () => {
    const controller = service(); await controller.prepare();
    const marker = "# fixture-edit-during-start-intent\n";
    await atDurablePhase("starting", async () => { await fs.appendFile(target.configFile, marker); });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled();
    expect(await fs.readFile(target.configFile, "utf8")).toContain(marker);
  });

  it("rechecks stopped state after the starting journal fsync before issuing start", async () => {
    const controller = service(); await controller.prepare();
    await atDurablePhase("starting", async () => { running = true; });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).not.toHaveBeenCalled();
  });

  it("does not acknowledge success when another writer changes bytes during start", async () => {
    const controller = service(); await controller.prepare();
    start.mockImplementationOnce(async () => { running = true; await fs.appendFile(target.configFile, "# fixture-after-start-edit\n"); });
    expect(await controller.apply(approve(controller))).toMatchObject({ status: "unknown" });
    expect(start).toHaveBeenCalledTimes(1);
    expect(await controller.reconcile()).toMatchObject({ status: "unknown", observed: { config: "other", service: "running" } });
  });

  it("pins secret preparation to the original private directory when its path is replaced", async () => {
    const moved = path.join(directory, "private-original");
    let replaced = false;
    await interceptOpen((handle, filename) => {
      if (!replaced && filename.endsWith("/original.yaml")) {
        replaced = true;
        return proxy(handle, { writeFile: async (...args: Parameters<fs.FileHandle["writeFile"]>) => {
          await fs.rename(target.privateDirectory, moved); await fs.mkdir(target.privateDirectory, { mode: 0o700 });
          return Reflect.apply(handle.writeFile, handle, args);
        } });
      }
      return handle;
    });
    expect(await service().prepare()).toMatchObject({ status: "unknown" });
    expect(await fs.readdir(target.privateDirectory)).toEqual([]);
    expect(await fs.readFile(path.join(moved, "client.key"), "utf8")).toBe(newKey);
    expect(stop).not.toHaveBeenCalled();
  });

  it("rejects symlink configuration, wrong original mode and invalid UTF-8 before generating a key", async () => {
    await fs.rename(target.configFile, `${target.configFile}.real`); await fs.symlink(`${target.configFile}.real`, target.configFile);
    expect(await service().prepare()).toMatchObject({ status: "conflict" });
    await fs.unlink(target.configFile); await fs.rename(`${target.configFile}.real`, target.configFile);
    await fs.chmod(target.configFile, 0o666);
    expect(await service().prepare()).toMatchObject({ status: "conflict" });
    await fs.chmod(target.configFile, 0o644); await fs.writeFile(target.configFile, Buffer.concat([Buffer.from([0xff]), Buffer.from(source)]));
    expect(await service().prepare()).toMatchObject({ status: "conflict" });
    expect(generateKey).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled();
  });

  it.each(["source", "candidate"])("rejects an oversized %s before key generation or stopping", async (oversized) => {
    const maximum = 1024 * 1024;
    const size = oversized === "source" ? maximum + 1 : maximum - 16;
    const padded = `${source}# ${"x".repeat(size - Buffer.byteLength(source) - 2)}`;
    await fs.writeFile(target.configFile, padded);
    expect(await service().prepare()).toMatchObject({ status: "conflict" });
    expect(generateKey).not.toHaveBeenCalled(); expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it("reconciles read-only and never treats receipt-file claims as authority", async () => {
    const controller = service(); await controller.prepare();
    const intentFile = path.join(target.privateDirectory, "intent.json");
    const intent = JSON.parse(await fs.readFile(intentFile, "utf8"));
    await fs.writeFile(intentFile, JSON.stringify({ ...intent, approved: true, scope: "maintenance", receipt: { approved: true } }));
    const before = await fs.readFile(intentFile, "utf8");
    expect(await controller.apply({ approved: true })).toEqual({ status: "approval-required" });
    expect(await controller.reconcile()).toMatchObject({ status: "prepared", observed: { config: "original", service: "running" } });
    expect(await fs.readFile(intentFile, "utf8")).toBe(before);
    expect(stop).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
  });

  it("does not expose source, keys or arbitrary exceptions through receipts or log sinks", async () => {
    const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(process, "emitWarning")];
    for (const sink of sinks) sink.mockImplementation(() => {});
    try {
      const controller = service(); await controller.prepare();
      stop.mockRejectedValueOnce(new Error(`fixture-private-${newKey}`));
      const result = await controller.apply(approve(controller));
      expect(result).toMatchObject({ status: "unknown" });
      expect(JSON.stringify(result)).not.toMatch(/fixture|api-keys|upstream-secret/);
      for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
    } finally { for (const sink of sinks) sink.mockRestore(); }
  });
});
