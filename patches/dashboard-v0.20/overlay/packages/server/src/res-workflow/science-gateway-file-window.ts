import { type ChildProcess, spawn } from "node:child_process";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import path from "node:path";

type WindowCode = "science-file-window-unsafe-target" | "science-file-window-unavailable" | "science-file-window-broken"
  | "science-file-window-unconfirmed" | "science-file-window-operation-failed";

class WindowError extends Error {
  readonly code: WindowCode;
  constructor(code: WindowCode) { super(code); this.code = code; }
}

interface Target { configFile: string; device: string; inode: string }

// No filename, source, credential or inherited user environment enters argv.
// fd3 references the parent's existing open file description, so parent IO does
// not create a conflicting open. SIGIO stays sticky until an explicit release.
const program = String.raw`import fcntl,json,os,signal,sys
broken=False
held=False
def emit(event,**facts):
 os.write(1,(json.dumps({'event':event,**facts})+'\n').encode())
def interrupted(_signal,_frame):
 global broken
 broken=True
 emit('break')
signal.signal(signal.SIGIO,interrupted)
try:
 fcntl.fcntl(3,fcntl.F_SETOWN,os.getpid())
 fcntl.fcntl(3,fcntl.F_SETLEASE,fcntl.F_WRLCK)
 held=True
 if fcntl.fcntl(3,fcntl.F_GETLEASE)!=fcntl.F_WRLCK: raise RuntimeError()
 emit('ready')
 command=sys.stdin.readline().strip()
 if command!='release': raise RuntimeError()
 intact=fcntl.fcntl(3,fcntl.F_GETLEASE)==fcntl.F_WRLCK
 fcntl.fcntl(3,fcntl.F_SETLEASE,fcntl.F_UNLCK)
 held=False
 emit('released',intact=intact and not broken)
except BaseException:
 try: emit('denied')
 except BaseException: pass
finally:
 if held:
  try: fcntl.fcntl(3,fcntl.F_SETLEASE,fcntl.F_UNLCK)
  except BaseException: pass
`;

function deferred<T>() {
  let settle!: (value: T) => void;
  let done = false;
  const promise = new Promise<T>((resolve) => { settle = (value) => { if (!done) { done = true; resolve(value); } }; });
  return { promise, settle };
}

async function deadline<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new WindowError("science-file-window-unconfirmed")), 10000);
    })]);
  } finally { clearTimeout(timer); }
}

function validatedChannels(child: ChildProcess) {
  const input = child.stdin;
  const output = child.stdout;
  if (!input || !output) throw new WindowError("science-file-window-unavailable");
  return { input, output };
}

async function terminateOwnedChild(child: ChildProcess) {
  const closed = deferred<void>();
  child.on("error", () => {});
  child.once("close", () => closed.settle(undefined));
  child.kill("SIGKILL");
  await deadline(closed.promise);
}

function protocol(child: ChildProcess) {
  const { input, output } = validatedChannels(child);
  const ready = deferred<boolean>();
  const released = deferred<boolean>();
  const closed = deferred<boolean>();
  let held = false;
  let broken = false;
  let failed = false;
  let acknowledged = false;
  let finished = false;
  let buffer = "";

  function fail() { failed = true; held = false; ready.settle(false); released.settle(false); }
  function event(value: { event?: string; intact?: boolean }) {
    if (value.event === "ready" && !held && !acknowledged && !failed) { held = true; ready.settle(true); return; }
    if (value.event === "break") { broken = true; return; }
    if (value.event === "released" && typeof value.intact === "boolean") {
      held = false; acknowledged = true;
      if (!value.intact) broken = true;
      released.settle(value.intact);
      return;
    }
    fail();
  }
  function receive(chunk: Buffer) {
    if (failed) { buffer = ""; return; }
    buffer += chunk.toString("utf8");
    if (buffer.length > 4096) { buffer = ""; fail(); return; }
    for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try { event(JSON.parse(line)); } catch { fail(); }
    }
  }
  output.on("data", receive);
  output.on("end", () => { if (buffer.length) fail(); });
  input.on("error", fail);
  child.on("error", fail);
  // close, rather than exit, waits until stdout is fully drained. A late break
  // must not disappear behind a successful release acknowledgement.
  child.on("close", (code) => {
    finished = true;
    if (code !== 0 || !acknowledged) fail();
    ready.settle(false); released.settle(false); closed.settle(code === 0);
  });

  function assertHeld() {
    if (broken) throw new WindowError("science-file-window-broken");
    if (!held || failed || finished) throw new WindowError("science-file-window-unconfirmed");
  }
  async function release() {
    if (finished) throw new WindowError("science-file-window-unconfirmed");
    input.end("release\n");
    const intact = await deadline(released.promise);
    const exited = await deadline(closed.promise);
    if (broken) throw new WindowError("science-file-window-broken");
    if (!intact || !exited || failed) throw new WindowError("science-file-window-unconfirmed");
  }
  async function dispose() {
    if (finished) return;
    try { input.end("release\n"); await deadline(closed.promise); }
    catch { child.kill("SIGKILL"); await deadline(closed.promise).catch(() => {}); }
  }
  return { ready: ready.promise, assertHeld, release, dispose };
}

async function ancestors(filename: string) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename) throw new WindowError("science-file-window-unsafe-target");
  let current = path.parse(filename).root;
  for (const part of path.dirname(filename).slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WindowError("science-file-window-unsafe-target");
  }
}

async function verifyTarget(handle: fs.FileHandle, target: Target) {
  const opened = await handle.stat({ bigint: true });
  const named = await fs.lstat(target.configFile, { bigint: true });
  const mode = Number(opened.mode & 0o7777n);
  if (!opened.isFile() || opened.nlink !== 1n || opened.uid !== BigInt(process.getuid!()) || ![0o600, 0o644].includes(mode)
    || opened.size > 1024n * 1024n || named.isSymbolicLink() || String(opened.dev) !== target.device || String(opened.ino) !== target.inode
    || opened.dev !== named.dev || opened.ino !== named.ino) throw new WindowError("science-file-window-unsafe-target");
}

async function openTarget(target: Target) {
  if (process.platform !== "linux") throw new WindowError("science-file-window-unavailable");
  try {
    await ancestors(target.configFile);
    const handle = await fs.open(target.configFile, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try { await verifyTarget(handle, target); return handle; }
    catch { await handle.close(); throw new WindowError("science-file-window-unsafe-target"); }
  } catch { throw new WindowError("science-file-window-unsafe-target"); }
}

function guarded(handle: fs.FileHandle, assertHeld: () => void) {
  const methods = new Set(["read", "write", "stat", "chmod", "sync"]);
  return new Proxy(handle, {
    get(target, property) {
      const value = Reflect.get(target, property);
      if (typeof value !== "function") return value;
      if (!methods.has(String(property))) return () => { throw new WindowError("science-file-window-unconfirmed"); };
      return async (...args: unknown[]) => {
        assertHeld();
        const result = await Reflect.apply(value, target, args);
        assertHeld();
        return result;
      };
    },
  });
}

function fixedFailure(error: unknown) {
  return error instanceof WindowError ? error : new WindowError("science-file-window-operation-failed");
}

/** Host-only file-open exclusion, not authorization or a Docker lifecycle lock.
 * Parent must own the maintenance window and keep the exact container stopped.
 * SIGIO, denial, lost leases or unconfirmed release always fail closed. There
 * is no flock/unprotected-write fallback. No real file is touched on import. */
export async function withScienceGatewayFileWindow(target: Target, operation: (handle: fs.FileHandle) => Promise<void>): Promise<void> {
  const handle = await openTarget(target);
  let child: ChildProcess | undefined;
  let watcher: ReturnType<typeof protocol> | undefined;
  let failure: WindowError | undefined;
  try {
    child = spawn("/usr/bin/python3", ["-I", "-B", "-c", program], {
      env: { PATH: "/usr/bin:/bin" }, stdio: ["pipe", "pipe", "ignore", handle.fd],
    });
    child.on("error", () => {});
    watcher = protocol(child);
    if (!await deadline(watcher.ready)) throw new WindowError("science-file-window-unavailable");
    watcher.assertHeld();
    try { await operation(guarded(handle, watcher.assertHeld)); }
    catch (error) { failure = fixedFailure(error); }
    try { await verifyTarget(handle, target); await watcher.release(); }
    catch (error) { failure = fixedFailure(error); }
  } catch (error) { failure = fixedFailure(error); }
  finally {
    try {
      if (watcher) await watcher.dispose();
      else if (child) await terminateOwnedChild(child);
    } catch { failure = new WindowError("science-file-window-unconfirmed"); }
    try { await handle.close(); } catch { failure ??= new WindowError("science-file-window-unconfirmed"); }
  }
  if (failure) throw failure;
}
