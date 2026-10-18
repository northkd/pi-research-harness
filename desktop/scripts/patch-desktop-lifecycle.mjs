import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export const LIFECYCLE_PATCH_ID = 'pi-research-desktop-owned-shutdown-v1';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

const ownedCleanup = `/** Research desktop: terminate only a process handle created by this server. */
export async function stopResearchOwnedProcess(
  pid: number,
  handle: ChildProcess,
  force = false,
): Promise<void> {
  // Reclaimed PID-file entries use dummy EventEmitters. Never grant them
  // ownership of an arbitrary live PID during a desktop shutdown.
  if (!Number.isInteger(pid) || pid <= 0 || handle.pid !== pid || handle.exitCode !== null || handle.signalCode) return;
  if (process.platform === "win32") {
    // Node's Windows SIGTERM kills only the parent; taskkill /T includes pi.
    const result = await killProcess(pid, { timeoutMs: 1000 });
    if (!result.ok && isProcessAlive(pid)) throw new Error("Could not stop an owned research process tree");
    return;
  }
  // spawnHeadlessViaKeeper uses detached:true, so its PID identifies its
  // own group. Never use the Electron/server process group or a port scan.
  const signalGroup = (signal: NodeJS.Signals): boolean => {
    try { killPidWithGroup(pid, signal); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  if (!signalGroup(force ? "SIGKILL" : "SIGTERM") || force) return;
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    try { process.kill(-pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }
  signalGroup("SIGKILL");
}

`;

const registryShutdownState = `
  // Set only for the isolated desktop's explicit user-quit path.
  let researchShutdownStarted = false;
  const researchClosing = new Set<Promise<void>>();
  const stopResearchEntry = (entry: HeadlessEntry): Promise<void> => {
    if (entry.process.pid !== entry.pid) return Promise.resolve();
    let closing: Promise<void>;
    closing = stopResearchOwnedProcess(entry.pid, entry.process).then(() => {
      if (entries.get(entry.pid) === entry) entries.delete(entry.pid);
      persist();
    }).finally(() => {
      researchClosing.delete(closing);
    });
    researchClosing.add(closing);
    return closing;
  };
`;

export const lifecycleTransforms = [
  {
    path: 'packages/server/src/spawn-process/headless-pid-registry.ts',
    changes: [
      ['registry cleanup helper', 'export function createHeadlessPidRegistry(options?: HeadlessPidRegistryOptions): HeadlessPidRegistry {', ownedCleanup + 'export function createHeadlessPidRegistry(options?: HeadlessPidRegistryOptions): HeadlessPidRegistry {'],
      ['registry signature', '  killAll(): void;', '  killAll(mode?: "desktop-user-quit"): void | Promise<void>;'],
      ['registry shutdown state', '  let keeperWriter: KeeperWriter | null = options?.keeperManager ?? null;\n', '  let keeperWriter: KeeperWriter | null = options?.keeperManager ?? null;\n' + registryShutdownState],
      ['late registration cleanup', '      proc.on("exit", () => {\n        entries.delete(pid);\n        persist();\n      });\n      persist();', '      proc.on("exit", () => {\n        entries.delete(pid);\n        persist();\n      });\n      persist();\n      if (researchShutdownStarted) void stopResearchEntry(entry).catch(error => console.error("[research-desktop] late child cleanup failed", error));'],
      ['registry desktop kill mode', '    killAll() {\n      if (isUnsafeTestHomeScan()) {', '    killAll(mode?: "desktop-user-quit") {\n      if (mode === "desktop-user-quit" && process.env.PI_RESEARCH_DASHBOARD_DIR) {\n        if (isUnsafeTestHomeScan()) throw new Error("Research desktop cleanup refused an unsafe test HOME");\n        researchShutdownStarted = true;\n        for (const entry of [...entries.values()]) void stopResearchEntry(entry);\n        return (async () => {\n          while (researchClosing.size > 0) await Promise.all([...researchClosing]);\n        })();\n      }\n      if (isUnsafeTestHomeScan()) {'],
    ],
  },
  {
    path: 'packages/server/src/pairing/browser-gateway.ts',
    changes: [
      ['gateway signature', '  shutdownHeadlessProcesses(): void;', '  shutdownHeadlessProcesses(mode?: "desktop-user-quit"): void | Promise<void>;'],
      ['gateway delegation', '    shutdownHeadlessProcesses() {\n      headlessPidRegistry.killAll();\n    },', '    shutdownHeadlessProcesses(mode?: "desktop-user-quit") {\n      return headlessPidRegistry.killAll(mode);\n    },'],
    ],
  },
  {
    path: 'packages/server/src/routes/system-routes.ts',
    changes: [
      ['shutdown dependency signature', '      broadcastToAll: (msg: ServerToBrowserMessage) => void;', '      broadcastToAll: (msg: ServerToBrowserMessage) => void;\n      shutdownHeadlessProcesses?: (mode?: "desktop-user-quit") => void | Promise<void>;'],
      ['explicit desktop user-quit cleanup', '      announceRestart("shutdown", SHUTDOWN_QUIESCE_MS);', '      announceRestart("shutdown", SHUTDOWN_QUIESCE_MS);\n      if (process.env.PI_RESEARCH_DASHBOARD_DIR && request.body?.userQuit === true) {\n        process.env.PI_RESEARCH_DESKTOP_SHUTTING_DOWN = "1";\n        if (!browserGateway?.shutdownHeadlessProcesses) throw new Error("Research desktop shutdown handler is unavailable");\n        await browserGateway.shutdownHeadlessProcesses("desktop-user-quit");\n      }'],
    ],
  },
  {
    path: 'packages/server/src/spawn-process/process-manager.ts',
    changes: [
      ['owned process cleanup import', 'import { mintSpawnToken } from "../auth/spawn-token.js";', 'import { mintSpawnToken } from "../auth/spawn-token.js";\nimport { stopResearchOwnedProcess } from "./headless-pid-registry.js";'],
      ['reject new desktop spawns', '): Promise<SpawnResult> {\n  if (!existsSync(cwd)) {', '): Promise<SpawnResult> {\n  if (process.env.PI_RESEARCH_DASHBOARD_DIR && process.env.PI_RESEARCH_DESKTOP_SHUTTING_DOWN === "1") {\n    return { success: false, code: "SPAWN_ERRNO", message: "Research desktop is shutting down" };\n  }\n  if (!existsSync(cwd)) {'],
      ['cancel in-flight desktop spawns', '  return { ...result, spawnToken };', '  if (process.env.PI_RESEARCH_DASHBOARD_DIR && process.env.PI_RESEARCH_DESKTOP_SHUTTING_DOWN === "1") {\n    if (result.process && typeof result.pid === "number") await stopResearchOwnedProcess(result.pid, result.process, true);\n    return { success: false, code: "SPAWN_ERRNO", message: "Research desktop is shutting down", spawnToken };\n  }\n  return { ...result, spawnToken };'],
    ],
  },
];

/** Exact, unique anchors tolerate unrelated packaging path overrides but never guess. */
export function transformLifecycleSource(source, specification) {
  let text = source;
  for (const [label, before, after] of specification.changes) {
    const afterCount = text.split(after).length - 1;
    // Many replacements contain the original anchor as a prefix.
    if (afterCount === 1) {
      const withoutPatchedBlock = text.replace(after, '');
      if (withoutPatchedBlock.includes(before)) throw new Error(`Ambiguous already-patched ${specification.path}: ${label}`);
      continue;
    }
    if (afterCount > 1 || text.split(before).length - 1 !== 1) {
      throw new Error(`Expected one exact lifecycle anchor in ${specification.path}: ${label}`);
    }
    text = text.replace(before, after);
  }
  return text;
}

/** Validate all inputs before any source file changes. Return auditable byte hashes. */
export function patchDesktopLifecycle(root, {write = true} = {}) {
  if (!path.isAbsolute(root)) throw new Error('Use an absolute dashboard source root');
  const plan = lifecycleTransforms.map(specification => {
    const file = path.join(root, specification.path);
    const before = fs.readFileSync(file, 'utf8');
    const after = transformLifecycleSource(before, specification);
    return {file, path: specification.path, before, after};
  });
  if (write) for (const change of plan) if (change.before !== change.after) fs.writeFileSync(change.file, change.after);
  return {
    patch: LIFECYCLE_PATCH_ID,
    applied: write,
    files: plan.map(change => ({path: change.path, changed: change.before !== change.after, beforeSha256: digest(change.before), afterSha256: digest(change.after)})),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2 || (args[1] && args[1] !== '--check-only')) throw new Error('Usage: node patch-desktop-lifecycle.mjs /absolute/dashboard-root [--check-only]');
  console.log(JSON.stringify(patchDesktopLifecycle(path.resolve(args[0]), {write: args[1] !== '--check-only'}), null, 2));
}
