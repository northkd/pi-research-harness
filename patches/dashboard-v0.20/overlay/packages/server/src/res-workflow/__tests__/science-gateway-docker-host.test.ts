import type { ExecFileOptions } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScienceGatewayDockerHost } from "../science-gateway-docker-host.js";
import { createScienceGatewayMaintenance, type ScienceGatewayMaintenanceReview, type ScienceGatewayMaintenanceTarget } from "../science-gateway-maintenance.js";

type Callback = (error: Error | null, stdout: string, stderr: string) => void;
const { exec, window, read, open } = vi.hoisted(() => ({
  exec: vi.fn<(file: string, args: string[], options: ExecFileOptions, callback: Callback) => object>(),
  window: vi.fn<(...args: unknown[]) => Promise<void>>(),
  read: vi.fn<typeof fs.readFile>(),
  open: vi.fn<typeof fs.open>(),
}));
vi.mock("node:child_process", () => ({ execFile: exec }));
vi.mock("../science-gateway-file-window.js", () => ({ withScienceGatewayFileWindow: window }));
vi.mock("node:fs/promises", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), readFile: read, open,
}));

const image = "sha256:8e03771cd4846b3f3547ef8b2d60a58f64e80754fccd0f18850da5c649fba323";
const marker = "fixture-private-docker-error-and-environment";
let root: string;
let target: ScienceGatewayMaintenanceTarget;
let review: ScienceGatewayMaintenanceReview;
let running: boolean;
let changes: Record<string, unknown>;

function payload() {
  return {
    containerId: target.containerId, containerName: "/cli-proxy-api", imageId: image,
    running, restarting: false, paused: false, dead: false, status: running ? "running" : "exited", pid: running ? 7777 : 0,
    stopTimeout: null,
    mounts: [{ type: "bind", source: target.configFile, destination: target.containerConfig, readWrite: true }],
    unexpectedCredential: marker,
    ...changes,
  };
}

function commands(action: string) { return exec.mock.calls.filter((call) => call[1].includes(action)); }

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(tmpdir(), "science-docker-host-fake-"));
  const configFile = path.join(root, "config.yaml");
  await fs.writeFile(configFile, "fixture-configuration-body-not-consumed", { mode: 0o644 });
  await fs.chmod(configFile, 0o644);
  const stat = await fs.stat(configFile, { bigint: true });
  target = {
    containerId: "f".repeat(64), containerName: "cli-proxy-api", imageId: image,
    configFile, containerConfig: "/CLIProxyAPI/config.yaml", privateDirectory: path.join(root, "private"),
    device: String(stat.dev), inode: String(stat.ino), originalMode: 0o644,
  };
  review = createScienceGatewayMaintenance(target, { observe: vi.fn(), authorizations: new WeakMap() }).review();
  running = true;
  changes = {};
  read.mockReset().mockRejectedValue(new Error(marker));
  open.mockReset().mockRejectedValue(new Error(marker));
  exec.mockReset().mockImplementation((_file, args, _options, callback) => {
    if (args.includes("inspect")) callback(null, JSON.stringify(payload()), "");
    else {
      if (args.includes("stop")) running = false;
      if (args.includes("start")) running = true;
      callback(null, `${target.containerId}\n`, "");
    }
    return {};
  });
  window.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});

describe("Science gateway Docker host: fake commands only", () => {
  it("creates only lazy host capabilities and leaves approval with the caller", () => {
    const host = createScienceGatewayDockerHost(review);
    expect(exec).not.toHaveBeenCalled();
    expect(window).not.toHaveBeenCalled();
    expect(host.lease.review).toBe(review);
    expect(Object.isFrozen(host.lease)).toBe(true);
    expect(Object.keys(host).sort()).toEqual(["lease", "observe"]);
    expect(Object.keys(host.lease).sort()).toEqual(["observe", "review", "start", "stop", "withExclusiveConfigWindow"]);
  });

  it("returns only the exact inspected target and bound source metadata", async () => {
    const host = createScienceGatewayDockerHost(review);
    const observed = await host.observe();
    expect(observed).toEqual({
      containerId: target.containerId, containerName: target.containerName, imageId: image,
      running: true, restarting: false, pid: 7777,
      mounts: [{ type: "bind", source: target.configFile, destination: target.containerConfig, readWrite: true }],
      boundDevice: target.device, boundInode: target.inode,
    });
    expect(JSON.stringify(observed)).not.toContain(marker);
    expect(await fs.readdir(root)).toEqual(["config.yaml"]);
    expect(commands("stop")).toHaveLength(0);
    expect(commands("start")).toHaveLength(0);
  });

  it("pins the local daemon, bypasses user Docker configuration and sends no inherited secrets", async () => {
    vi.stubEnv("DOCKER_HOST", "tcp://fixture-remote.example:2375");
    vi.stubEnv("DOCKER_CONTEXT", "fixture-remote-context");
    vi.stubEnv("OPENAI_API_KEY", marker);
    await createScienceGatewayDockerHost(review).observe();
    const [file, args, options] = exec.mock.calls[0];
    expect(file).toBe("/usr/bin/docker");
    expect(args.slice(0, 4)).toEqual(["--host", "unix:///var/run/docker.sock", "--config", target.privateDirectory]);
    expect(args.slice(-1)).toEqual([target.containerId]);
    expect(options).toMatchObject({ encoding: "utf8", shell: false, maxBuffer: 65536, timeout: 15000 });
    expect(options.env).toEqual({ PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });
    const format = args[args.indexOf("--format") + 1];
    expect(format).toContain('{{json (index .Config "StopTimeout")}}');
    expect(format).not.toContain(".Config.StopTimeout");
    for (const forbidden of [".Env", ".State.Error", "json .Config}}", "json .State}}", "json .}}"] ) expect(format).not.toContain(forbidden);
    expect(JSON.stringify([args, options])).not.toContain(marker);
    expect(args).not.toContain("--shell");
  });

  it("refuses a user Docker config file without reading it or issuing a command", async () => {
    await fs.mkdir(target.privateDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(target.privateDirectory, "config.json"), marker, { mode: 0o600 });
    await expect(createScienceGatewayDockerHost(review).observe()).rejects.toMatchObject({ code: "science-docker-unsafe-client-config" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("does not read configuration contents or open its inode while observing", async () => {
    await expect(createScienceGatewayDockerHost(review).observe()).resolves.toMatchObject({ containerId: target.containerId });
    expect(read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  it("observes the same exact stopped container without controlling it", async () => {
    running = false;
    await expect(createScienceGatewayDockerHost(review).observe()).resolves.toMatchObject({ running: false, pid: 0 });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it.each([
    { containerId: "e".repeat(64) }, { containerName: "/other-container" }, { imageId: `sha256:${"0".repeat(64)}` },
    { mounts: [] }, { mounts: [{ type: "volume", source: "fixture-volume", destination: "/CLIProxyAPI/config.yaml", readWrite: true }] },
    { mounts: [{ type: "bind", source: "/other/config.yaml", destination: "/CLIProxyAPI/config.yaml", readWrite: true }] },
    { mounts: [{ type: "bind", source: "use-current", destination: "/CLIProxyAPI/config.yaml", readWrite: false }] },
  ])("refuses exact identity or bind drift %# before lifecycle commands", async patch => {
    changes = patch;
    if (Array.isArray(changes.mounts)) changes.mounts = changes.mounts.map(value => value.source === "use-current" ? { ...value, source: target.configFile } : value);
    await expect(createScienceGatewayDockerHost(review).lease.stop()).rejects.toMatchObject({ code: "science-docker-target-changed" });
    expect(commands("stop")).toHaveLength(0);
  });

  it("refuses duplicate target mount declarations", async () => {
    const mount = payload().mounts[0];
    changes = { mounts: [mount, mount] };
    await expect(createScienceGatewayDockerHost(review).observe()).rejects.toMatchObject({ code: "science-docker-target-changed" });
  });

  it.each([{ paused: true }, { dead: true }, { restarting: true }, { pid: 0 }, { running: "true" }, { status: "removing" }])("refuses uncertain runtime state %#", async patch => {
    changes = patch;
    await expect(createScienceGatewayDockerHost(review).lease.stop()).rejects.toMatchObject({ code: "science-docker-state-unavailable" });
    expect(commands("stop")).toHaveLength(0);
  });

  it.each([-1, 301, 1.5, "10"])("refuses unsupported StopTimeout %j before stop", async value => {
    changes = { stopTimeout: value };
    await expect(createScienceGatewayDockerHost(review).lease.stop()).rejects.toMatchObject({ code: "science-docker-stop-timeout-unsupported" });
    expect(commands("stop")).toHaveLength(0);
  });

  it("stops only the exact ID using Docker's default timeout and confirms its state", async () => {
    const host = createScienceGatewayDockerHost(review);
    await host.lease.stop();
    expect(commands("stop")).toHaveLength(1);
    const [, args, options] = commands("stop")[0];
    expect(args.slice(4)).toEqual(["stop", target.containerId]);
    expect(options.timeout).toBe(60000);
    expect(commands("inspect")).toHaveLength(2);
    expect(commands("start")).toHaveLength(0);
    expect((await fs.stat(target.configFile)).mode & 0o777).toBe(0o644);
  });

  it("waits the configured timeout plus a fixed client margin without overriding Docker flags", async () => {
    changes = { stopTimeout: 25 };
    await createScienceGatewayDockerHost(review).lease.stop();
    const [, args, options] = commands("stop")[0];
    expect(options.timeout).toBe(40000);
    expect(args).not.toContain("--time"); expect(args).not.toContain("--timeout");
  });

  it("never retries a failed or timed-out stop and exposes only a fixed error", async () => {
    exec.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("inspect")) callback(null, JSON.stringify(payload()), marker);
      else callback(new Error(marker), marker, marker);
      return {};
    });
    const result = await createScienceGatewayDockerHost(review).lease.stop().catch(error => error);
    expect(result).toMatchObject({ code: "science-docker-operation-unconfirmed", message: "science-docker-operation-unconfirmed" });
    expect(result.cause).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(marker);
    expect(commands("stop")).toHaveLength(1); expect(commands("start")).toHaveLength(0);
  });

  it("keeps a failed control result unknown across later lease calls", async () => {
    const host = createScienceGatewayDockerHost(review);
    exec.mockImplementation((_file, args, _options, callback) => {
      callback(args.includes("stop") ? new Error(marker) : null, args.includes("inspect") ? JSON.stringify(payload()) : marker, marker);
      return {};
    });
    await expect(host.lease.stop()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    const count = exec.mock.calls.length;
    await expect(host.lease.stop()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    await expect(host.lease.start()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    expect(exec).toHaveBeenCalledTimes(count);
  });

  it("keeps source metadata changes during control unconfirmed", async () => {
    exec.mockImplementation((_file, args, _options, callback) => {
      if (args.includes("inspect")) callback(null, JSON.stringify(payload()), "");
      else {
        running = false;
        void fs.chmod(target.configFile, 0o600).then(() => callback(null, `${target.containerId}\n`, ""), error => callback(error, "", marker));
      }
      return {};
    });
    const host = createScienceGatewayDockerHost(review);
    await expect(host.lease.stop()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    await expect(host.lease.start()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    expect(commands("stop")).toHaveLength(1); expect(commands("start")).toHaveLength(0);
  });

  it("refuses stopping a container already stopped", async () => {
    running = false;
    await expect(createScienceGatewayDockerHost(review).lease.stop()).rejects.toMatchObject({ code: "science-docker-state-unavailable" });
    expect(commands("stop")).toHaveLength(0);
  });

  it("starts only the same stopped container after mode becomes private", async () => {
    running = false;
    await fs.chmod(target.configFile, 0o600);
    await createScienceGatewayDockerHost(review).lease.start();
    expect(commands("start")).toHaveLength(1);
    expect(commands("start")[0][1].slice(4)).toEqual(["start", target.containerId]);
    expect(commands("inspect")).toHaveLength(2);
    expect(commands("stop")).toHaveLength(0);
  });

  it("refuses start while running or while configuration is still public", async () => {
    const host = createScienceGatewayDockerHost(review);
    await expect(host.lease.start()).rejects.toMatchObject({ code: "science-docker-state-unavailable" });
    running = false;
    await expect(host.lease.start()).rejects.toMatchObject({ code: "science-docker-target-changed" });
    expect(commands("start")).toHaveLength(0);
  });

  it("refuses a replaced inode even if bytes match", async () => {
    await fs.rename(target.configFile, `${target.configFile}.old`);
    await fs.writeFile(target.configFile, "fixture-configuration-body-not-consumed", { mode: 0o644 });
    await expect(createScienceGatewayDockerHost(review).lease.stop()).rejects.toMatchObject({ code: "science-docker-target-changed" });
    expect(commands("stop")).toHaveLength(0);
  });

  it.each(["symlink", "public-permissions"])("refuses unsafe source %s without control", async kind => {
    if (kind === "symlink") {
      await fs.rename(target.configFile, `${target.configFile}.real`);
      await fs.symlink(`${target.configFile}.real`, target.configFile);
    } else await fs.chmod(target.configFile, 0o666);
    await expect(createScienceGatewayDockerHost(review).lease.stop()).rejects.toMatchObject({ code: "science-docker-target-changed" });
    expect(commands("stop")).toHaveLength(0);
  });

  it.each(["hardlink", "oversized"])("bounds source metadata for %s without reading it", async kind => {
    if (kind === "hardlink") await fs.link(target.configFile, `${target.configFile}.link`);
    else await fs.truncate(target.configFile, 1024 * 1024 + 1);
    await expect(createScienceGatewayDockerHost(review).observe()).rejects.toMatchObject({ code: "science-docker-target-changed" });
    expect(exec).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(open).not.toHaveBeenCalled();
  });

  it("rejects malformed or oversized inspection output without echoing any data", async () => {
    for (const stdout of [marker, JSON.stringify([]), "x".repeat(65537)]) {
      exec.mockImplementation((_file, _args, _options, callback) => { callback(null, stdout, marker); return {}; });
      const result = await createScienceGatewayDockerHost(review).observe().catch(error => error);
      expect(result).toMatchObject({ code: "science-docker-inspection-unavailable" });
      expect(JSON.stringify(result)).not.toContain(marker);
      expect(result.cause).toBeUndefined();
    }
  });

  it("does not report command acknowledgement as confirmed state", async () => {
    exec.mockImplementation((_file, args, _options, callback) => {
      callback(null, args.includes("inspect") ? JSON.stringify(payload()) : `${target.containerId}\n`, "");
      return {};
    });
    await expect(createScienceGatewayDockerHost(review).lease.stop()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    expect(commands("stop")).toHaveLength(1);
  });

  it("delegates the guarded file window only while the exact target stays stopped", async () => {
    running = false;
    const host = createScienceGatewayDockerHost(review);
    await host.lease.withExclusiveConfigWindow(vi.fn());
    expect(window).toHaveBeenCalledOnce();
    expect(window.mock.calls[0][0]).toEqual({ configFile: target.configFile, device: target.device, inode: target.inode });
    expect(commands("start")).toHaveLength(0); expect(commands("stop")).toHaveLength(0);
    running = true;
    await expect(host.lease.withExclusiveConfigWindow(vi.fn())).rejects.toMatchObject({ code: "science-docker-state-unavailable" });
    expect(window).toHaveBeenCalledOnce();
  });

  it("rechecks the stopped target around the actual delegated callback", async () => {
    running = false;
    const handle = {} as fs.FileHandle;
    window.mockImplementation(async (_target, operation) => { await (operation as (file: fs.FileHandle) => Promise<void>)(handle); });
    const operation = vi.fn(async (file: fs.FileHandle) => { expect(file).toBe(handle); await fs.chmod(target.configFile, 0o600); });
    await createScienceGatewayDockerHost(review).lease.withExclusiveConfigWindow(operation);
    expect(operation).toHaveBeenCalledOnce(); expect(commands("inspect")).toHaveLength(4);
    expect(commands("stop")).toHaveLength(0); expect(commands("start")).toHaveLength(0);
  });

  it("sanitizes a file callback failure or observed restart without a lifecycle fallback", async () => {
    running = false;
    window.mockImplementation(async (_target, operation) => { await (operation as (file: fs.FileHandle) => Promise<void>)({} as fs.FileHandle); });
    const host = createScienceGatewayDockerHost(review);
    const error = await host.lease.withExclusiveConfigWindow(async () => { throw new Error(marker); }).catch(value => value);
    expect(error).toMatchObject({ code: "science-docker-operation-unconfirmed" });
    expect(error.cause).toBeUndefined(); expect(JSON.stringify(error)).not.toContain(marker);
    await expect(createScienceGatewayDockerHost(review).lease.withExclusiveConfigWindow(async () => { running = true; })).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    expect(commands("stop")).toHaveLength(0); expect(commands("start")).toHaveLength(0);
  });

  it("keeps a failed file window unknown while allowing read-only observation", async () => {
    running = false;
    window.mockRejectedValue(new Error(marker));
    const host = createScienceGatewayDockerHost(review);
    await expect(host.lease.withExclusiveConfigWindow(vi.fn())).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    const count = exec.mock.calls.length;
    await expect(host.lease.start()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    await expect(host.lease.stop()).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    await expect(host.lease.withExclusiveConfigWindow(vi.fn())).rejects.toMatchObject({ code: "science-docker-operation-unconfirmed" });
    expect(exec).toHaveBeenCalledTimes(count); expect(window).toHaveBeenCalledOnce();
    await expect(host.observe()).resolves.toMatchObject({ running: false, pid: 0 });
    expect(commands("stop")).toHaveLength(0); expect(commands("start")).toHaveLength(0);
  });

  it("requires the existing host review rather than a boolean or mutable request", () => {
    for (const value of [true, { ...review }, Object.freeze({ ...review, target: { ...target } })]) {
      expect(() => createScienceGatewayDockerHost(value as ScienceGatewayMaintenanceReview)).toThrow("science-docker-invalid-target");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects frozen accessors without evaluating a target getter", () => {
    const get = vi.fn(() => target.configFile);
    const input = Object.freeze({ ...review, target: Object.freeze({ ...target, get configFile() { return get(); } }) });
    expect(() => createScienceGatewayDockerHost(input)).toThrow("science-docker-invalid-target");
    expect(get).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
  });

  it("does not log arbitrary inspect or control exceptions", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const emitted = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    exec.mockImplementation(() => { throw new Error(marker); });
    await expect(createScienceGatewayDockerHost(review).observe()).rejects.toMatchObject({ code: "science-docker-inspection-unavailable" });
    expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(emitted).not.toHaveBeenCalled();
  });
});
