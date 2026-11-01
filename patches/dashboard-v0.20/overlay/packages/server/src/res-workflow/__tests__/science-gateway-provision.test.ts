import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseDocument } from "yaml";
import { createScienceGatewayProvisioner } from "../science-gateway-provision.js";
import type { ScienceGatewayTargetIdentity } from "../science-gateway-provision.js";

vi.mock("node:fs/promises", async (load) => {
  const actual = await load<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const oldKey = "fixture-old-client-key-0000000000000000";
const newKey = "fixture-new-client-key-0000000000000000";
const alias = "ark-sci-deepseek-v4.1-flash";
const ark = `claude-api-key:
  - api-key: fixture-upstream-secret
    base-url: https://ark.cn-beijing.volces.com/api/coding
    models:
      - name: deepseek-v4.1-flash
        alias: ${alias}
`;
const appendable = `${ark}api-keys:\n  - "${oldKey}"\n`;
const ordinary = `api-keys:\n  - "${oldKey}"\n${ark.replace(alias, "deepseek-v4.1-flash")}`;
const realOpen = vi.mocked(fs.open).getMockImplementation()!;

let directory: string;
let configFile: string;
let privateDirectory: string;
const generateKey = vi.fn(() => newKey);
const observeRuntime = async (target: ScienceGatewayTargetIdentity) => ({
  binarySha256: "163fe79fdd84e7b071520212382d798a2163edfe3b85183312a1d17bd7dcc4a7",
  boundDevice: target.device, boundInode: target.inode, watcherReady: true,
});
const inspectRuntime = vi.fn<(...args: Parameters<typeof observeRuntime>) => Promise<Awaited<ReturnType<typeof observeRuntime>> | null>>(observeRuntime);

function provisioner() {
  return createScienceGatewayProvisioner({ configFile, privateDirectory }, { generateKey, inspectRuntime });
}

async function configure(source = appendable) {
  await fs.writeFile(configFile, source, { mode: 0o600 });
  await fs.chmod(configFile, 0o600);
}

async function wrapConfigHandle(replace: (handle: fs.FileHandle) => fs.FileHandle) {
  vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
    const handle = await realOpen(...args);
    return args[0] === configFile && typeof args[1] === "number" && (args[1] & constants.O_RDWR) === constants.O_RDWR ? replace(handle) : handle;
  });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(tmpdir(), "science-gateway-provision-"));
  configFile = path.join(directory, "config.yaml");
  privateDirectory = path.join(directory, "science-private");
  generateKey.mockClear();
  inspectRuntime.mockReset().mockImplementation(observeRuntime);
  await configure();
});

afterEach(async () => {
  vi.mocked(fs.open).mockImplementation(realOpen);
  await fs.rm(directory, { recursive: true, force: true });
});

describe("Science gateway host-owned provisioning", () => {
  it("requires maintenance for ordinary two-insertion layouts before generating a credential", async () => {
    await configure(ordinary);
    const result = await provisioner().prepare();
    expect(result).toEqual({ status: "maintenance-required", reason: "non-append-update" });
    expect(generateKey).not.toHaveBeenCalled();
    expect(await fs.readFile(configFile, "utf8")).toBe(ordinary);
    await expect(fs.lstat(privateDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("requires a fresh host runtime proof before generating or staging a key", async () => {
    inspectRuntime.mockResolvedValue(null);
    expect(await provisioner().prepare()).toEqual({ status: "maintenance-required", reason: "runtime-not-verified" });
    expect(generateKey).not.toHaveBeenCalled();
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("defaults to denial when the host has not supplied a runtime verifier", async () => {
    const service = createScienceGatewayProvisioner({ configFile, privateDirectory }, { generateKey });
    expect(await service.prepare()).toMatchObject({ status: "maintenance-required", reason: "runtime-not-verified" });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it.each(["binary", "inode", "watcher"])("refuses mismatched fresh runtime observation: %s", async (mismatch) => {
    inspectRuntime.mockImplementationOnce(async (target) => ({
      ...await observeRuntime(target),
      ...(mismatch === "binary" ? { binarySha256: "fixture-unverified-binary" } : {}),
      ...(mismatch === "inode" ? { boundInode: "0" } : {}),
      ...(mismatch === "watcher" ? { watcherReady: false } : {}),
    }));
    expect(await provisioner().prepare()).toEqual({ status: "maintenance-required", reason: "runtime-not-verified" });
    expect(generateKey).not.toHaveBeenCalled();
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("durably stages private key, original, candidate and intent without writing the configuration", async () => {
    const result = await provisioner().prepare();
    expect(result).toEqual({ status: "prepared" });
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
    expect((await fs.stat(privateDirectory)).mode & 0o777).toBe(0o700);
    for (const name of ["client.key", "original.yaml", "candidate.yaml", "intent.json"]) {
      expect((await fs.stat(path.join(privateDirectory, name))).mode & 0o777).toBe(0o600);
    }
    expect(await fs.readFile(path.join(privateDirectory, "client.key"), "utf8")).toBe(newKey);
    expect(generateKey).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toContain(newKey);
  });

  it("reuses a prepared intent without generating another credential", async () => {
    const service = provisioner();
    expect(await service.prepare()).toEqual({ status: "prepared" });
    expect(await service.prepare()).toEqual({ status: "prepared" });
    expect(generateKey).toHaveBeenCalledTimes(1);
  });

  it("appends only after durable intent, preserves the inode and all previous bytes", async () => {
    const service = provisioner();
    expect(await service.prepare()).toEqual({ status: "prepared" });
    const before = await fs.stat(configFile);
    await wrapConfigHandle((handle) => new Proxy(handle, {
      get(target, property) {
        if (property === "write") return async (...args: Parameters<fs.FileHandle["write"]>) => {
          const intent = JSON.parse(await fs.readFile(path.join(privateDirectory, "intent.json"), "utf8"));
          expect(intent.stage).toBe("appending");
          expect(await fs.readFile(path.join(privateDirectory, "original.yaml"), "utf8")).toBe(appendable);
          return Reflect.apply(target.write, target, args);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    expect(await service.apply()).toEqual({ status: "applied" });
    expect((await fs.stat(configFile)).ino).toBe(before.ino);
    expect(await fs.readFile(configFile, "utf8")).toBe(`${appendable}  - "${newKey}"\n`);
    expect(await service.reconcile()).toEqual({ status: "applied" });
  });

  it("keeps old authentication and rejects partial new credentials at every short-write boundary", async () => {
    const service = provisioner();
    await service.prepare();
    const observations: unknown[] = [];
    await wrapConfigHandle((handle) => new Proxy(handle, {
      get(target, property) {
        if (property === "write") return async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await target.write(buffer, offset, Math.min(length, 1), position);
          const text = await fs.readFile(configFile, "utf8");
          expect(text.startsWith(appendable)).toBe(true);
          const doc = parseDocument(text, { logLevel: "silent" });
          if (!doc.errors.length && !doc.warnings.length) {
            const value = doc.toJS();
            observations.push(value["api-keys"]);
            expect(value["api-keys"].filter((key: unknown) => typeof key === "string" && key.trim())).toEqual(
              value["api-keys"].includes(newKey) ? [oldKey, newKey] : [oldKey],
            );
          }
          return result;
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    expect(await service.apply()).toEqual({ status: "applied" });
    expect(observations).toContainEqual([oldKey, null]);
    expect(observations).toContainEqual([oldKey, newKey]);
  });

  it("refuses whitespace-only old keys before planning a credential", async () => {
    await configure(appendable.replace(oldKey, "   "));
    expect(await provisioner().prepare()).toMatchObject({ status: "maintenance-required", reason: "unsafe-authentication-prefix" });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it("does not mutate configuration after a CAS conflict", async () => {
    const service = provisioner();
    await service.prepare();
    const replacement = `${appendable}# user-owned change\n`;
    await fs.writeFile(configFile, replacement);
    expect(await service.apply()).toMatchObject({ status: "conflict" });
    expect(await fs.readFile(configFile, "utf8")).toBe(replacement);
  });

  it("refuses a replaced inode even if the replacement has identical bytes", async () => {
    const service = provisioner();
    await service.prepare();
    await fs.rename(configFile, `${configFile}.old`);
    await configure();
    expect(await service.apply()).toMatchObject({ status: "conflict" });
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("leaves a partial append unknown and never retries it automatically", async () => {
    const service = provisioner();
    await service.prepare();
    let writes = 0;
    await wrapConfigHandle((handle) => new Proxy(handle, {
      get(target, property) {
        if (property === "write") return async (buffer: Buffer, offset: number, _length: number, position: number) => {
          writes++;
          if (writes > 1) throw new Error(`fixture-disk-error-${newKey}`);
          return target.write(buffer, offset, 5, position);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    expect(await service.apply()).toEqual({ status: "unknown", reason: "write-unconfirmed" });
    const partial = await fs.readFile(configFile, "utf8");
    expect(partial.startsWith(appendable)).toBe(true);
    expect(partial).not.toBe(appendable);
    expect(await service.apply()).toMatchObject({ status: "unknown" });
    expect(await service.reconcile()).toMatchObject({ status: "unknown" });
    expect(writes).toBe(2);
    expect(await fs.readFile(configFile, "utf8")).toBe(partial);
  });

  it("does not call an unchanged configuration safe to retry after a write error", async () => {
    const service = provisioner();
    await service.prepare();
    await wrapConfigHandle((handle) => new Proxy(handle, {
      get(target, property) {
        if (property === "write") return async () => { throw new Error("fixture-write-error"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    expect(await service.apply()).toMatchObject({ status: "unknown" });
    expect(await service.reconcile()).toMatchObject({ status: "unknown" });
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("keeps candidate bytes unknown when file fsync failed", async () => {
    const service = provisioner();
    await service.prepare();
    await wrapConfigHandle((handle) => new Proxy(handle, {
      get(target, property) {
        if (property === "sync") return async () => { throw new Error("fixture-fsync-error"); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    expect(await service.apply()).toEqual({ status: "unknown", reason: "write-unconfirmed" });
    expect(await fs.readFile(configFile, "utf8")).toContain(newKey);
    expect(await service.reconcile()).toEqual({ status: "unknown", reason: "write-unconfirmed" });
  });

  it("never writes configuration when a private-file fsync fails", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (!String(args[0]).endsWith("/client.key")) return handle;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "sync") return async () => { throw new Error(`fixture-secret-${newKey}`); };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    expect(await provisioner().prepare()).toMatchObject({ status: "unavailable", reason: "private-state-unavailable" });
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
    expect(await provisioner().apply()).not.toMatchObject({ status: "applied" });
  });

  it("rejects symlink configuration files and symlink ancestors", async () => {
    await fs.rename(configFile, `${configFile}.real`);
    await fs.symlink(`${configFile}.real`, configFile);
    expect(await provisioner().prepare()).toMatchObject({ status: "unavailable" });
    expect(generateKey).not.toHaveBeenCalled();
    await fs.unlink(configFile);
    const linkedDirectory = `${directory}-link`;
    await fs.symlink(directory, linkedDirectory);
    try {
      configFile = path.join(linkedDirectory, "config.yaml.real");
      expect(await provisioner().prepare()).toMatchObject({ status: "unavailable" });
    } finally { await fs.unlink(linkedDirectory); }
  });

  it("refuses insecure configuration permissions and private directory permissions", async () => {
    await fs.chmod(configFile, 0o666);
    expect(await provisioner().prepare()).toMatchObject({ status: "unavailable" });
    await fs.chmod(configFile, 0o600);
    await fs.mkdir(privateDirectory, { mode: 0o755 });
    expect(await provisioner().prepare()).toMatchObject({ status: "unavailable", reason: "private-state-unavailable" });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it("rechecks private directory permissions after fresh runtime inspection", async () => {
    const service = provisioner();
    await service.prepare();
    inspectRuntime.mockImplementationOnce(async (target) => {
      await fs.chmod(privateDirectory, 0o755);
      return observeRuntime(target);
    });
    expect(await service.apply()).toMatchObject({ status: "conflict" });
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("never removes an existing lock or treats a local lock as permission to overwrite", async () => {
    await fs.mkdir(privateDirectory, { mode: 0o700 });
    const lock = path.join(privateDirectory, "provision.lock");
    await fs.writeFile(lock, "fixture-owned-lock", { mode: 0o600 });
    expect(await provisioner().prepare()).toEqual({ status: "locked" });
    expect(await fs.readFile(lock, "utf8")).toBe("fixture-owned-lock");
    expect(generateKey).not.toHaveBeenCalled();
  });

  it("keeps orphaned private preparation unknown without generating a replacement key", async () => {
    await fs.mkdir(privateDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(privateDirectory, "client.key"), newKey, { mode: 0o600 });
    expect(await provisioner().prepare()).toMatchObject({ status: "unknown", reason: "incomplete-private-state" });
    expect(generateKey).not.toHaveBeenCalled();
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("keeps reconciliation read-only and redacts corrupt private state errors", async () => {
    const service = provisioner();
    await service.prepare();
    const intent = path.join(privateDirectory, "intent.json");
    await fs.writeFile(intent, `{invalid-${newKey}`);
    const before = await fs.readFile(intent, "utf8");
    const result = await service.reconcile();
    expect(result).toMatchObject({ status: "unavailable", reason: "private-state-unavailable" });
    expect(JSON.stringify(result)).not.toContain(newKey);
    expect(await fs.readFile(intent, "utf8")).toBe(before);
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("does not follow a private credential symlink on reconcile", async () => {
    const service = provisioner();
    await service.prepare();
    await fs.unlink(path.join(privateDirectory, "client.key"));
    await fs.symlink(configFile, path.join(privateDirectory, "client.key"));
    expect(await service.reconcile()).toMatchObject({ status: "unavailable" });
  });

  it("refuses malformed UTF-8 in recovered private snapshots", async () => {
    const service = provisioner();
    await service.prepare();
    const original = path.join(privateDirectory, "original.yaml");
    const before = await fs.readFile(original);
    await fs.writeFile(original, Buffer.concat([Buffer.from([0xff]), before.subarray(1)]));
    expect(await service.reconcile()).toMatchObject({ status: "unavailable", reason: "private-state-unavailable" });
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("pins private writes to the opened directory when an ancestor path is replaced", async () => {
    const moved = `${privateDirectory}-original`;
    let replaced = false;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      if (!replaced && String(args[0]).endsWith("/original.yaml")) {
        replaced = true;
        await fs.rename(privateDirectory, moved);
        await fs.mkdir(privateDirectory, { mode: 0o700 });
      }
      return realOpen(...args);
    });
    try {
      const result = await provisioner().prepare();
      expect(result.status).not.toBe("prepared");
      expect(await fs.readdir(privateDirectory)).toEqual([]);
      expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
      expect(await fs.readFile(path.join(moved, "client.key"), "utf8")).toBe(newKey);
    } finally { await fs.rm(moved, { recursive: true, force: true }); }
  });

  it("does not overwrite a noncooperating writer that appends after the final CAS", async () => {
    const service = provisioner();
    await service.prepare();
    const change = "# fixture-user-appended-after-CAS\n";
    await wrapConfigHandle((handle) => new Proxy(handle, {
      get(target, property) {
        if (property === "write") return async (...args: Parameters<fs.FileHandle["write"]>) => {
          await fs.appendFile(configFile, change);
          return Reflect.apply(target.write, target, args);
        };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    expect(await service.apply()).toMatchObject({ status: "conflict" });
    expect(await fs.readFile(configFile, "utf8")).toBe(`${appendable}${change}  - "${newKey}"\n`);
  });

  it("keeps a write unknown if the configuration handle fails to close", async () => {
    const service = provisioner();
    await service.prepare();
    await wrapConfigHandle((handle) => new Proxy(handle, {
      get(target, property) {
        if (property === "close") return async () => { await target.close(); throw new Error(`fixture-close-${newKey}`); };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }));
    expect(await service.apply()).toEqual({ status: "unknown", reason: "write-unconfirmed" });
    expect(await service.reconcile()).toEqual({ status: "unknown", reason: "write-unconfirmed" });
  });

  it("keeps completed bytes unknown if the private directory changes before acknowledgement", async () => {
    const service = provisioner();
    await service.prepare();
    const moved = `${privateDirectory}-completed`;
    const realRename = fs.rename;
    let updates = 0;
    const rename = vi.spyOn(fs, "rename").mockImplementation(async (...args) => {
      await realRename(...args);
      if (String(args[0]).endsWith("/intent.next") && ++updates === 2) {
        await realRename(privateDirectory, moved);
        await fs.mkdir(privateDirectory, { mode: 0o700 });
      }
    });
    try {
      expect(await service.apply()).toEqual({ status: "unknown", reason: "write-unconfirmed" });
      expect(await service.reconcile()).toEqual({ status: "unknown", reason: "write-unconfirmed" });
      expect(await fs.readFile(configFile, "utf8")).toBe(`${appendable}  - "${newKey}"\n`);
      expect(await fs.readdir(privateDirectory)).toEqual([]);
    } finally { rename.mockRestore(); await fs.rm(moved, { recursive: true, force: true }); }
  });

  it("does not expose a raw close error while rejecting an existing private lock", async () => {
    await fs.mkdir(privateDirectory, { mode: 0o700 });
    await fs.writeFile(path.join(privateDirectory, "provision.lock"), "fixture-owned-lock", { mode: 0o600 });
    let directories = 0;
    vi.mocked(fs.open).mockImplementation(async (...args: Parameters<typeof fs.open>) => {
      const handle = await realOpen(...args);
      if (String(args[0]).endsWith("/science-private") && typeof args[1] === "number"
        && (args[1] & constants.O_DIRECTORY) && ++directories === 2) {
        return new Proxy(handle, {
          get(target, property) {
            if (property === "close") return async () => { await target.close(); throw new Error(`fixture-private-close-${newKey}`); };
            const value = Reflect.get(target, property);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      return handle;
    });
    await expect(provisioner().prepare()).resolves.toEqual({ status: "locked" });
    expect(generateKey).not.toHaveBeenCalled();
    expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
  });

  it("rejects invalid UTF-8 instead of planning against decoded replacement characters", async () => {
    await fs.writeFile(configFile, Buffer.concat([Buffer.from("# "), Buffer.from([0xff]), Buffer.from(`\n${appendable}`)]));
    expect(await provisioner().prepare()).toMatchObject({ status: "maintenance-required", reason: "unsafe-authentication-prefix" });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it.each(["\\u0085", "\\u2007", "\\u202f", " "])("refuses Go-Unicode-whitespace-only auth keys %s", async (encoded) => {
    const whitespace = JSON.parse(`"${encoded}"`) as string;
    await configure(appendable.replace(oldKey, whitespace));
    expect(await provisioner().prepare()).toMatchObject({ status: "maintenance-required", reason: "unsafe-authentication-prefix" });
    expect(generateKey).not.toHaveBeenCalled();
  });

  it("does not log credentials, configuration fragments or arbitrary failures", async () => {
    const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(process, "emitWarning")];
    for (const sink of sinks) sink.mockImplementation(() => {});
    try {
      generateKey.mockImplementationOnce(() => { throw new Error(`fixture-generator-${newKey}`); });
      const result = await provisioner().prepare();
      expect(result).toMatchObject({ status: "unavailable" });
      expect(JSON.stringify(result)).not.toMatch(/fixture|api-keys|upstream-secret/);
      for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
      expect(await fs.readFile(configFile, "utf8")).toBe(appendable);
    } finally { for (const sink of sinks) sink.mockRestore(); }
  });
});
