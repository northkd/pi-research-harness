import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as oldSafeFiles from "../res-workflow/safe-files.js";
import { serializeWrite as oldSerializeWrite } from "../lib/file-write-lock.js";
import {
  assertNoLinks,
  ensureProjectDirectory,
  inside,
  readBoundedRegular,
  ScienceWriteError,
  serializeWrite,
  writeSciencePrivateFile,
} from "../science-runtime.js";

vi.mock("node:fs/promises", async original => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open), rename: vi.fn(actual.rename) };
});
vi.mock("node:crypto", async original => {
  const actual = await original<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const roots: string[] = [];
const actualFs = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const actualCrypto = await vi.importActual<typeof import("node:crypto")>("node:crypto");
let root: string;
const body = "fake-private-science-record";

beforeEach(async () => {
  vi.mocked(fs.open).mockImplementation(actualFs.open);
  vi.mocked(fs.rename).mockImplementation(actualFs.rename);
  vi.mocked(randomUUID).mockImplementation(actualCrypto.randomUUID);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "science-runtime-"));
  roots.push(root);
});
afterEach(async () => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const dir of roots.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe("Science public runtime", () => {
  it("reuses the existing helpers without replacing their imports or lock state", () => {
    expect(serializeWrite).toBe(oldSerializeWrite);
    expect(inside).toBe(oldSafeFiles.inside);
    expect(assertNoLinks).toBe(oldSafeFiles.assertNoLinks);
    expect(ensureProjectDirectory).toBe(oldSafeFiles.ensureProjectDirectory);
    expect(readBoundedRegular).toBe(oldSafeFiles.readBoundedRegular);
  });

  it("resolves the public entry and preserves the package root and legacy deep imports", () => {
    const require = createRequire(import.meta.url);
    const serverRoot = fileURLToPath(new URL("../../", import.meta.url));
    expect(require.resolve("@blackbelt-technology/pi-dashboard-server/science-runtime")).toBe(path.join(serverRoot, "src/science-runtime.ts"));
    expect(require.resolve("@blackbelt-technology/pi-dashboard-server")).toBe(path.join(serverRoot, "src/cli.ts"));
    expect(require.resolve("@blackbelt-technology/pi-dashboard-server/package.json")).toBe(path.join(serverRoot, "package.json"));
    expect(require.resolve("@blackbelt-technology/pi-dashboard-server/src/lib/file-write-lock.ts")).toBe(path.join(serverRoot, "src/lib/file-write-lock.ts"));
    expect(require.resolve("@blackbelt-technology/pi-dashboard-server/bin/pi-dashboard.mjs")).toBe(path.join(serverRoot, "bin/pi-dashboard.mjs"));
  });
});

// platform-branch-ok: Science durable state requires Linux directory-fd paths.
describe.runIf(process.platform === "linux")("Science private durable file", () => {
  it("creates a private regular record and returns only after file and directory sync", async () => {
    const events: string[] = [];
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      const directory = (await handle.stat()).isDirectory();
      events.push(directory ? "open-directory" : "open-temp");
      if (!directory) {
        expect((args[1] as number) & constants.O_EXCL).toBe(constants.O_EXCL);
        expect((await handle.stat()).mode & 0o777).toBe(0o600);
      }
      const sync = handle.sync.bind(handle);
      vi.spyOn(handle, "sync").mockImplementation(async () => { events.push(directory ? "sync-directory" : "sync-file"); await sync(); });
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => { events.push(directory ? "close-directory" : "close-temp"); await close(); });
      return handle;
    });
    vi.mocked(fs.rename).mockImplementation(async (...args) => { events.push("rename"); await actualFs.rename(...args); });
    await writeSciencePrivateFile(root, "intent.json", body);
    expect(await fs.readFile(path.join(root, "intent.json"), "utf8")).toBe(body);
    expect((await fs.stat(path.join(root, "intent.json"))).mode & 0o777).toBe(0o600);
    expect(events).toEqual(["open-directory", "open-temp", "sync-file", "close-temp", "rename", "sync-directory", "close-directory"]);
    expect(await fs.readdir(root)).toEqual(["intent.json"]);
  });

  it("leaves the previous record readable during preparation and atomically replaces it", async () => {
    const target = path.join(root, "intent.json");
    await fs.writeFile(target, "previous", { mode: 0o600 });
    const before = await fs.stat(target);
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      expect(await fs.readFile(target, "utf8")).toBe("previous");
      expect(await fs.readFile(args[0], "utf8")).toBe(body);
      await actualFs.rename(...args);
    });
    await writeSciencePrivateFile(root, "intent.json", body);
    expect(await fs.readFile(target, "utf8")).toBe(body);
    expect((await fs.stat(target)).ino).not.toBe(before.ino);
  });

  it.each(["../escape", "/absolute", "nested/file", ".", "..", "", "bad\u0000name"])("rejects invalid leaf %j before opening anything", async name => {
    await expect(writeSciencePrivateFile(root, name, body)).rejects.toMatchObject({ code: "science-write-invalid-input", published: false });
    expect(fs.open).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("rejects oversized bytes before opening anything", async () => {
    await expect(writeSciencePrivateFile(root, "intent.json", Buffer.alloc(1024 * 1024 + 1))).rejects.toMatchObject({ code: "science-write-invalid-input", published: false });
    expect(fs.open).not.toHaveBeenCalled();
  });

  it("refuses a non-private root without chmodding it", async () => {
    await fs.chmod(root, 0o755);
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unsafe-directory", published: false });
    expect((await fs.stat(root)).mode & 0o777).toBe(0o755);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("refuses a symlinked root without following it", async () => {
    const link = path.join(root, "linked");
    const real = await fs.mkdtemp(path.join(os.tmpdir(), "science-runtime-outside-")); roots.push(real);
    await fs.symlink(real, link);
    await expect(writeSciencePrivateFile(link, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unsafe-directory", published: false });
    expect(await fs.readdir(real)).toEqual([]);
  });

  it.each(["symlink", "hardlink", "directory", "public"])("refuses unsafe existing %s targets", async kind => {
    const target = path.join(root, "intent.json");
    const other = path.join(root, "other");
    await fs.writeFile(other, "unrelated", { mode: 0o600 });
    if (kind === "symlink") await fs.symlink(other, target);
    else if (kind === "hardlink") await fs.link(other, target);
    else if (kind === "directory") await fs.mkdir(target);
    else await fs.writeFile(target, "unrelated", { mode: 0o644 });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unsafe-target", published: false });
    expect(await fs.readFile(other, "utf8")).toBe("unrelated");
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it("does not overwrite or remove a colliding temporary file", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    vi.mocked(randomUUID).mockReturnValue(id);
    const temp = path.join(root, `.intent.json.${id}.tmp`);
    await fs.writeFile(temp, "unrelated", { mode: 0o600 });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-failed", published: false });
    expect(await fs.readFile(temp, "utf8")).toBe("unrelated");
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it("refuses a temporary handle whose permissions no longer match the private contract", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (!(await handle.stat()).isDirectory()) await handle.chmod(0o644);
      return handle;
    });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unsafe-target", published: false });
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("pins the directory while a replaced root becomes a symlink, without exposing bytes outside it", async () => {
    const moved = `${root}.moved`; roots.push(moved);
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "science-runtime-outside-")); roots.push(outside);
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (!(await handle.stat()).isDirectory()) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => {
          await sync();
          await actualFs.rename(root, moved);
          await fs.symlink(outside, root);
        });
      }
      return handle;
    });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unsafe-directory", published: false });
    expect(await fs.readdir(outside)).toEqual([]);
    expect(await fs.readdir(moved)).toEqual([]);
    expect(fs.rename).not.toHaveBeenCalled();
  });

  it.each(["partial-write", "file-sync"])("keeps the old record after %s failure and leaks no source or raw exception", async stage => {
    const target = path.join(root, "intent.json");
    await fs.writeFile(target, "previous", { mode: 0o600 });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (!(await handle.stat()).isDirectory()) {
        if (stage === "partial-write") vi.spyOn(handle, "writeFile").mockImplementation(async () => { await handle.write("partial"); throw new Error(body); });
        if (stage === "file-sync") vi.spyOn(handle, "sync").mockRejectedValue(new Error(body));
      }
      return handle;
    });
    const result = await writeSciencePrivateFile(root, "intent.json", body).catch(err => err);
    expect(result).toBeInstanceOf(ScienceWriteError);
    expect(result).toMatchObject({ code: "science-write-failed", message: "science-write-failed", published: false });
    expect(JSON.stringify(result)).not.toContain(body);
    expect(result.cause).toBeUndefined();
    expect(await fs.readFile(target, "utf8")).toBe("previous");
    expect(await fs.readdir(root)).toEqual(["intent.json"]);
    expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(emit).not.toHaveBeenCalled();
  });

  it.each([false, true])("reports unknown after a rename rejection (actually published=%s), without retry", async actuallyPublished => {
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      if (actuallyPublished) await actualFs.rename(...args);
      throw new Error(body);
    });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unconfirmed", published: "unknown" });
    expect(fs.rename).toHaveBeenCalledTimes(1);
    if (actuallyPublished) expect(await fs.readFile(path.join(root, "intent.json"), "utf8")).toBe(body);
    else expect(await fs.readdir(root)).toEqual([]);
  });

  it("reports published but unconfirmed after directory sync failure without rolling back", async () => {
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if ((await handle.stat()).isDirectory()) vi.spyOn(handle, "sync").mockRejectedValue(new Error(body));
      return handle;
    });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unconfirmed", published: true });
    expect(await fs.readFile(path.join(root, "intent.json"), "utf8")).toBe(body);
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });

  it("does not claim a canonical publication if the root is moved during rename", async () => {
    const moved = `${root}.moved`; roots.push(moved);
    vi.mocked(fs.rename).mockImplementation(async (...args) => {
      await actualFs.rename(root, moved);
      await fs.mkdir(root, { mode: 0o700 });
      await actualFs.rename(...args);
    });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unconfirmed", published: true });
    expect(await fs.readdir(root)).toEqual([]);
    expect(await fs.readFile(path.join(moved, "intent.json"), "utf8")).toBe(body);
    expect(fs.rename).toHaveBeenCalledTimes(1);
  });

  it("refuses a target changed while the private file was being synced", async () => {
    const target = path.join(root, "intent.json");
    await fs.writeFile(target, "previous", { mode: 0o600 });
    vi.mocked(fs.open).mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (!(await handle.stat()).isDirectory()) {
        const sync = handle.sync.bind(handle);
        vi.spyOn(handle, "sync").mockImplementation(async () => { await sync(); await fs.writeFile(target, "external-change", { mode: 0o600 }); });
      }
      return handle;
    });
    await expect(writeSciencePrivateFile(root, "intent.json", body)).rejects.toMatchObject({ code: "science-write-unsafe-target", published: false });
    expect(await fs.readFile(target, "utf8")).toBe("external-change");
    expect(fs.rename).not.toHaveBeenCalled();
    expect(await fs.readdir(root)).toEqual(["intent.json"]);
  });
});
