/** Public primitives for the independent Science host; importing starts no service. */
import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import * as fs from "node:fs/promises";
import path from "node:path";
import { serializeWrite } from "./lib/file-write-lock.js";

export { assertNoLinks, ensureProjectDirectory, inside, readBoundedRegular } from "./res-workflow/safe-files.js";
export { assertNativeRuntime, createNativeRuntimeAssertion, NATIVE_RUNTIME_PATHS, NATIVE_SCIENCE_SHA256, type NativeRuntimeFacts, type NativeRuntimeIo, type NativeRuntimeStat, ScienceNativeRuntimeError } from "./res-workflow/science-native-runtime.js";
export { serializeWrite };

type ScienceWriteCode =
  | "science-write-invalid-input"
  | "science-write-unsafe-directory"
  | "science-write-unsafe-target"
  | "science-write-failed"
  | "science-write-unconfirmed";

/** No payload, path, raw filesystem exception or cause crosses this boundary. */
export class ScienceWriteError extends Error {
  readonly code: ScienceWriteCode;
  readonly published: boolean | "unknown";

  constructor(code: ScienceWriteCode, published: boolean | "unknown" = false) {
    super(code);
    this.name = "ScienceWriteError";
    this.code = code;
    this.published = published;
  }
}

type FileSnapshot = Stats;
const MAX_PRIVATE_BYTES = 1024 * 1024;

function privateOwned(entry: FileSnapshot, mode: number): boolean {
  return entry.uid === process.getuid?.() && (entry.mode & 0o7777) === mode;
}

function assertPrivateDirectory(entry: FileSnapshot): void {
  if (!entry.isDirectory() || !privateOwned(entry, 0o700)) throw new ScienceWriteError("science-write-unsafe-directory");
}

function assertSameDirectory(expected: FileSnapshot, actual: FileSnapshot): void {
  if (actual.dev !== expected.dev || actual.ino !== expected.ino) throw new ScienceWriteError("science-write-unsafe-directory");
}

function assertPrivateRegular(entry: FileSnapshot): void {
  if (!entry.isFile() || entry.nlink !== 1 || !privateOwned(entry, 0o600)) throw new ScienceWriteError("science-write-unsafe-target");
}

async function privateDirectory(root: string): Promise<FileSnapshot> {
  const entry = await fs.lstat(root);
  assertPrivateDirectory(entry);
  if ((await fs.realpath(root)) !== root) throw new ScienceWriteError("science-write-unsafe-directory");
  return entry;
}

async function privateTarget(target: string, expectAbsent = false): Promise<FileSnapshot | null> {
  let entry: FileSnapshot;
  try { entry = await fs.lstat(target); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  assertPrivateRegular(entry);
  if (expectAbsent) throw new ScienceWriteError("science-write-unsafe-target");
  return entry;
}

function sameFile(left: FileSnapshot | null, right: FileSnapshot | null): boolean {
  return left === null || right === null ? left === right :
    left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

interface PublicationState { ownsTemporary: boolean; published: boolean | "unknown" }
async function publishPrivateTarget(temporary: string, target: string, expectAbsent: boolean, state: PublicationState): Promise<void> {
  state.published = "unknown";
  if (expectAbsent) {
    try { await fs.link(temporary, target); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") { state.published = false; throw new ScienceWriteError("science-write-unsafe-target"); }
      throw error;
    }
    state.published = true;
    await fs.unlink(temporary);
  } else {
    await fs.rename(temporary, target);
    state.published = true;
  }
  state.ownsTemporary = false;
}

/**
 * Linux, host-owned single-writer state only. The root must already be private
 * and canonical. A pinned directory fd prevents parent swaps redirecting bytes.
 * This replaces Science records, never a Docker-bound gateway configuration.
 * Unknown publication requires read-only reconciliation by the host, not retry.
 */
export async function writeSciencePrivateFile(root: string, name: string, data: string | Uint8Array, options: { expectAbsent?: boolean } = {}): Promise<void> {
  if (process.platform !== "linux" || typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root ||
    typeof name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) ||
    (typeof data !== "string" && !(data instanceof Uint8Array)) ||
    (typeof data === "string" ? Buffer.byteLength(data) : data.byteLength) > MAX_PRIVATE_BYTES ||
    !options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "expectAbsent") ||
    (options.expectAbsent !== undefined && typeof options.expectAbsent !== "boolean")) {
    throw new ScienceWriteError("science-write-invalid-input");
  }
  const expectAbsent = options.expectAbsent === true;
  const bytes = Buffer.from(data);
  await serializeWrite(path.join(root, name), async () => {
    let directory: FileHandle | undefined;
    let temporary: FileHandle | undefined;
    let temporaryPath: string | undefined;
    const publication: PublicationState = { ownsTemporary: false, published: false };
    try {
      const before = await privateDirectory(root);
      directory = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const opened = await directory.stat();
      assertPrivateDirectory(opened);
      assertSameDirectory(before, opened);
      const anchoredRoot = `/proc/self/fd/${directory.fd}`;
      const target = path.join(anchoredRoot, name);
      const previous = await privateTarget(target, expectAbsent);
      temporaryPath = path.join(anchoredRoot, `.${name}.${randomUUID()}.tmp`);
      temporary = await fs.open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      publication.ownsTemporary = true;
      assertPrivateRegular(await temporary.stat());
      await temporary.writeFile(bytes);
      await temporary.sync();
      await temporary.close();
      temporary = undefined;
      assertSameDirectory(opened, await privateDirectory(root));
      if (!sameFile(previous, await privateTarget(target))) throw new ScienceWriteError("science-write-unsafe-target");
      await publishPrivateTarget(temporaryPath, target, expectAbsent, publication);
      await directory.sync();
      assertSameDirectory(opened, await privateDirectory(root));
    } catch (err) {
      if (publication.published !== false) throw new ScienceWriteError("science-write-unconfirmed", publication.published);
      if (err instanceof ScienceWriteError) throw err;
      throw new ScienceWriteError("science-write-failed");
    } finally {
      await temporary?.close().catch(() => {});
      if (publication.ownsTemporary && temporaryPath) await fs.unlink(temporaryPath).catch(() => {});
      await directory?.close().catch(() => {});
    }
  });
}
