import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withScienceGatewayFileWindow } from "../science-gateway-file-window.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeGuard extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  releasedIntact = true;
  releaseAcknowledged = true;
  kill = vi.fn(() => { this.stdout?.end(); this.emit("close", null, "SIGTERM"); return true; });
  constructor() {
    super();
    this.stdin.on("data", (chunk) => {
      if (String(chunk) !== "release\n") return;
      if (this.releaseAcknowledged) this.metadata({ event: "released", intact: this.releasedIntact });
      this.stdout.end();
      this.emit("close", 0, null);
    });
  }
  metadata(value: unknown) { this.stdout.write(`${JSON.stringify(value)}\n`); }
}

let directory: string;
let target: { configFile: string; device: string; inode: string };
let guard: FakeGuard;
const spawnMock = vi.mocked(spawn);

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), "science-file-window-fake-"));
  const configFile = path.join(directory, "fixture.yaml");
  await fs.writeFile(configFile, "fixture-private-data\n", { mode: 0o600 });
  const stat = await fs.stat(configFile, { bigint: true });
  target = { configFile, device: String(stat.dev), inode: String(stat.ino) };
  guard = new FakeGuard();
  spawnMock.mockReset().mockImplementation(() => {
    queueMicrotask(() => guard.metadata({ event: "ready" }));
    return guard as unknown as ChildProcess;
  });
});

afterEach(async () => { vi.restoreAllMocks(); await fs.rm(directory, { recursive: true, force: true }); });

describe("Science file window protocol (fake guard; kernel probe separate)", () => {
  it("passes only the owned open file description to a fixed isolated interpreter", async () => {
    await withScienceGatewayFileWindow(target, async (handle) => {
      const bytes = Buffer.alloc(7);
      await handle.read(bytes, 0, bytes.length, 0);
      expect(bytes.toString()).toBe("fixture");
      await handle.write(Buffer.from("FIXTURE"), 0, 7, 0);
      await handle.sync();
    });
    expect(await fs.readFile(target.configFile, "utf8")).toBe("FIXTURE-private-data\n");
    const [executable, args, options] = spawnMock.mock.calls[0];
    expect(executable).toBe("/usr/bin/python3");
    expect(args).toContain("-I");
    expect(args).toContain("-c");
    expect(JSON.stringify(args)).not.toContain(target.configFile);
    expect(JSON.stringify(args)).not.toContain("fixture-private-data");
    expect(options).toMatchObject({ env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore", expect.any(Number)] });
  });

  it("rejects mismatched inode before spawning anything", async () => {
    const operation = vi.fn();
    await expect(withScienceGatewayFileWindow({ ...target, inode: "0" }, operation)).rejects.toThrow("science-file-window-unsafe-target");
    expect(operation).not.toHaveBeenCalled(); expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects symlinks and insecure permissions before spawning", async () => {
    await fs.rename(target.configFile, `${target.configFile}.real`);
    await fs.symlink(`${target.configFile}.real`, target.configFile);
    await expect(withScienceGatewayFileWindow(target, async () => {})).rejects.toThrow("science-file-window-unsafe-target");
    await fs.unlink(target.configFile); await fs.rename(`${target.configFile}.real`, target.configFile);
    await fs.chmod(target.configFile, 0o666);
    await expect(withScienceGatewayFileWindow(target, async () => {})).rejects.toThrow("science-file-window-unsafe-target");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("does not execute when the kernel guard denies acquisition", async () => {
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => { guard.metadata({ event: "denied" }); guard.stdout.end(); guard.emit("close", 0, null); });
      return guard as unknown as ChildProcess;
    });
    const operation = vi.fn();
    await expect(withScienceGatewayFileWindow(target, operation)).rejects.toThrow("science-file-window-unavailable");
    expect(operation).not.toHaveBeenCalled();
  });

  it("makes a lease-break sticky and prevents subsequent writes", async () => {
    guard.releasedIntact = false;
    await expect(withScienceGatewayFileWindow(target, async (handle) => {
      await handle.write(Buffer.from("F"), 0, 1, 0);
      guard.metadata({ event: "break" });
      await handle.write(Buffer.from("BAD"), 0, 3, 0);
    })).rejects.toThrow("science-file-window-broken");
    expect(await fs.readFile(target.configFile, "utf8")).toBe("Fixture-private-data\n");
  });

  it("rejects final non-intact release even when no break metadata was seen", async () => {
    guard.releasedIntact = false;
    await expect(withScienceGatewayFileWindow(target, async () => {})).rejects.toThrow("science-file-window-broken");
  });

  it("rejects a break hidden by the operation's own catch", async () => {
    guard.releasedIntact = false;
    await expect(withScienceGatewayFileWindow(target, async (handle) => {
      guard.metadata({ event: "break" });
      await handle.sync().catch(() => {});
    })).rejects.toThrow("science-file-window-broken");
  });

  it("does not mistake guard exit during an operation for success", async () => {
    await expect(withScienceGatewayFileWindow(target, async (handle) => {
      guard.stdout.end(); guard.emit("close", 1, null);
      await handle.sync();
    })).rejects.toThrow("science-file-window-unconfirmed");
  });

  it("requires an acknowledged intact release before returning", async () => {
    guard.releaseAcknowledged = false;
    await expect(withScienceGatewayFileWindow(target, async () => {})).rejects.toThrow("science-file-window-unconfirmed");
  });

  it("redacts arbitrary operation exceptions and never writes source to logs", async () => {
    const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error")];
    for (const sink of sinks) sink.mockImplementation(() => {});
    try {
      await expect(withScienceGatewayFileWindow(target, async () => { throw new Error("fixture-private-operation-secret"); }))
        .rejects.toThrow("science-file-window-operation-failed");
      for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
    } finally { for (const sink of sinks) sink.mockRestore(); }
  });

  it("redacts unexpected child output instead of forwarding it", async () => {
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => guard.metadata({ event: "fixture-private-child-secret" }));
      return guard as unknown as ChildProcess;
    });
    await expect(withScienceGatewayFileWindow(target, async () => {})).rejects.toThrow("science-file-window-unavailable");
  });

  it("handles child spawn errors without exposing their messages", async () => {
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => { guard.emit("error", new Error("fixture-private-spawn-secret")); guard.stdout.end(); guard.emit("close", 1, null); });
      return guard as unknown as ChildProcess;
    });
    await expect(withScienceGatewayFileWindow(target, async () => {})).rejects.toThrow("science-file-window-unavailable");
  });

  it.each(["stdin", "stdout"])("confirms owned child termination when protocol initialization lacks %s", async (missing) => {
    Object.defineProperty(guard, missing, { value: null });
    let closed = false;
    guard.on("close", () => { closed = true; });
    guard.kill.mockImplementationOnce(() => {
      guard.emit("error", new Error("fixture-private-child-error"));
      guard.emit("close", null, "SIGKILL");
      return true;
    });
    spawnMock.mockImplementationOnce(() => guard as unknown as ChildProcess);
    const operation = vi.fn();
    await expect(withScienceGatewayFileWindow(target, operation)).rejects.toThrow("science-file-window-unavailable");
    expect(operation).not.toHaveBeenCalled();
    expect(guard.kill).toHaveBeenCalledTimes(1);
    expect(closed).toBe(true);
  });
});
