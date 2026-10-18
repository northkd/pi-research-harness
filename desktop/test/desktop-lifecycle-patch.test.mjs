import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {EventEmitter} from 'node:events';
import {stripTypeScriptTypes} from 'node:module';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {lifecycleTransforms, patchDesktopLifecycle, transformLifecycleSource} from '../scripts/patch-desktop-lifecycle.mjs';

const registrySpec = lifecycleTransforms[0];
const registryFixture = `interface HeadlessPidRegistry {
  killAll(): void;
}
export function createHeadlessPidRegistry(options?: HeadlessPidRegistryOptions): HeadlessPidRegistry {
  const entries = new Map<number, HeadlessEntry>();
  let keeperWriter: KeeperWriter | null = options?.keeperManager ?? null;
  function persist() {}
  return {
    register(pid, cwd, proc) {
      const entry = {pid, cwd, process: proc};
      entries.set(pid, entry);
      proc.on("exit", () => {
        entries.delete(pid);
        persist();
      });
      persist();
    },
    killAll() {
      if (isUnsafeTestHomeScan()) {
        return;
      }
      for (const [pid] of entries) killPidWithGroup(pid, "SIGTERM");
      entries.clear();
    },
    size() { return entries.size; }
  };
}
`;

function registryHarness({platform = 'linux', enabled = true, stubborn = false} = {}) {
  const calls = [];
  const alive = new Set();
  let clock = 0;
  const runtimeProcess = {
    platform,
    env: enabled ? {PI_RESEARCH_DASHBOARD_DIR: '/isolated/dashboard'} : {},
    kill(target, signal) {
      if (signal === 0 && alive.has(Math.abs(target))) return;
      throw Object.assign(new Error('No such process'), {code: 'ESRCH'});
    },
  };
  const source = stripTypeScriptTypes(transformLifecycleSource(registryFixture, registrySpec)).replace(/\bexport\s+/g, '');
  const exports = vm.runInNewContext(`${source}\n;({createHeadlessPidRegistry, stopResearchOwnedProcess});`, {
    process: runtimeProcess,
    isUnsafeTestHomeScan: () => false,
    isProcessAlive: pid => alive.has(pid),
    killPidWithGroup(pid, signal) {
      calls.push({kind: 'group', pid, signal});
      if (!stubborn || signal === 'SIGKILL') alive.delete(pid);
    },
    async killProcess(pid) { calls.push({kind: 'tree', pid}); alive.delete(pid); return {ok: true}; },
    setTimeout: fn => queueMicrotask(fn),
    Date: {now: () => clock += 500},
    console,
  });
  const registry = exports.createHeadlessPidRegistry();
  const register = (pid, owned = true) => {
    alive.add(pid);
    const handle = new EventEmitter();
    if (owned) Object.assign(handle, {pid, exitCode: null, signalCode: null});
    registry.register(pid, '/work', handle);
    return handle;
  };
  return {registry, register, calls, runtimeProcess, ...exports};
}

test('desktop Windows shutdown tree-kills only current owned process handles', async () => {
  const h = registryHarness({platform: 'win32'});
  h.register(42001);
  h.register(42002);
  h.register(99999, false); // Simulate a recovered PID-file record, without a child handle.
  await h.registry.killAll('desktop-user-quit');
  assert.deepEqual(h.calls, [{kind: 'tree', pid: 42001}, {kind: 'tree', pid: 42002}]);
  assert.equal(h.registry.size(), 1);
});

test('desktop POSIX shutdown targets owned groups and escalates a stubborn group', async () => {
  const h = registryHarness({stubborn: true});
  h.register(42003);
  await h.registry.killAll('desktop-user-quit');
  assert.deepEqual(h.calls, [
    {kind: 'group', pid: 42003, signal: 'SIGTERM'},
    {kind: 'group', pid: 42003, signal: 'SIGKILL'},
  ]);
});

test('ordinary upstream shutdown semantics remain unchanged', async () => {
  const h = registryHarness();
  h.register(42004);
  assert.equal(h.registry.killAll(), undefined);
  assert.deepEqual(h.calls, [{kind: 'group', pid: 42004, signal: 'SIGTERM'}]);
  const standalone = registryHarness({enabled: false});
  standalone.register(42005);
  assert.equal(standalone.registry.killAll('desktop-user-quit'), undefined);
  assert.deepEqual(standalone.calls, [{kind: 'group', pid: 42005, signal: 'SIGTERM'}]);
});

test('late registration after desktop shutdown is immediately reclaimed', async () => {
  const h = registryHarness({platform: 'win32'});
  await h.registry.killAll('desktop-user-quit');
  h.register(42006);
  await h.registry.killAll('desktop-user-quit');
  assert.ok(h.calls.some(call => call.kind === 'tree' && call.pid === 42006));
  assert.equal(h.registry.size(), 0);
});

test('explicit userQuit and isolated profile are both required by the shutdown route', async () => {
  const injection = lifecycleTransforms[2].changes[1][2];
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('process', 'request', 'browserGateway', 'announceRestart', 'SHUTDOWN_QUIESCE_MS', injection);
  let cleaned = 0;
  const gateway = {async shutdownHeadlessProcesses(mode) { assert.equal(mode, 'desktop-user-quit'); cleaned++; }};
  await run({env: {}}, {body: {userQuit: true}}, gateway, () => {}, 60000);
  await run({env: {PI_RESEARCH_DASHBOARD_DIR: '/isolated'}}, {body: {}}, gateway, () => {}, 60000);
  assert.equal(cleaned, 0);
  const processFixture = {env: {PI_RESEARCH_DASHBOARD_DIR: '/isolated'}};
  await run(processFixture, {body: {userQuit: true}}, gateway, () => {}, 60000);
  assert.equal(cleaned, 1);
  assert.equal(processFixture.env.PI_RESEARCH_DESKTOP_SHUTTING_DOWN, '1');
});

test('new spawns are rejected and an in-flight spawn is cancelled before publication', async () => {
  const spec = lifecycleTransforms[3];
  const fixture = `import { mintSpawnToken } from "../auth/spawn-token.js";
export async function spawnPiSession(cwd, options): Promise<SpawnResult> {
  if (!existsSync(cwd)) { return {success:false}; }
  const spawnToken = "fixture";
  const result = await spawnMock();
  return { ...result, spawnToken };
}
`;
  const transformed = stripTypeScriptTypes(transformLifecycleSource(fixture, spec)).replace(/^import .*;\n/gm, '').replace(/\bexport\s+/g, '');
  const state = {env: {PI_RESEARCH_DASHBOARD_DIR: '/isolated', PI_RESEARCH_DESKTOP_SHUTTING_DOWN: '1'}};
  const kills = [];
  let spawned = 0;
  let finishSpawn;
  const spawnPiSession = vm.runInNewContext(`${transformed}; spawnPiSession`, {
    process: state, existsSync: () => true,
    spawnMock: () => { spawned++; return new Promise(resolve => { finishSpawn = resolve; }); },
    stopResearchOwnedProcess: async (pid, handle, force) => kills.push({pid, handlePid: handle.pid, force}),
  });
  assert.equal((await spawnPiSession('/work')).success, false);
  assert.equal(spawned, 0);
  delete state.env.PI_RESEARCH_DESKTOP_SHUTTING_DOWN;
  const pending = spawnPiSession('/work');
  state.env.PI_RESEARCH_DESKTOP_SHUTTING_DOWN = '1';
  finishSpawn({success: true, pid: 42007, process: {pid: 42007}});
  assert.equal((await pending).success, false);
  assert.deepEqual(kills, [{pid: 42007, handlePid: 42007, force: true}]);
});

test('source transforms are idempotent and reject ambiguous/changed anchors', () => {
  for (const spec of lifecycleTransforms) {
    const fixture = spec === registrySpec ? registryFixture : spec.changes.map(change => change[1]).join('\n\n');
    const once = transformLifecycleSource(fixture, spec);
    assert.equal(transformLifecycleSource(once, spec), once);
    assert.throws(() => transformLifecycleSource(fixture + '\n' + spec.changes[0][1], spec), /one exact lifecycle anchor|Ambiguous/);
    assert.throws(() => transformLifecycleSource(fixture.replace(spec.changes[0][1], 'changed by upstream'), spec), /one exact lifecycle anchor/);
  }
});

test('patch planning validates every file before any source mutation and records hashes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-lifecycle-source-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  for (const spec of lifecycleTransforms) {
    const file = path.join(root, spec.path);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, spec === registrySpec ? registryFixture : spec.changes.map(change => change[1]).join('\n\n'));
  }
  const preview = patchDesktopLifecycle(root, {write: false});
  assert.equal(preview.applied, false);
  assert.equal(preview.files.length, 4);
  assert.ok(preview.files.every(item => item.beforeSha256.length === 64 && item.afterSha256.length === 64 && item.changed));
  const lastFile = path.join(root, lifecycleTransforms.at(-1).path);
  const lastBefore = fs.readFileSync(lastFile);
  const firstFile = path.join(root, registrySpec.path);
  const firstBefore = fs.readFileSync(firstFile);
  fs.writeFileSync(lastFile, 'unexpected upstream code');
  assert.throws(() => patchDesktopLifecycle(root), /one exact lifecycle anchor/);
  assert.deepEqual(fs.readFileSync(firstFile), firstBefore);
  fs.writeFileSync(lastFile, lastBefore);
  const applied = patchDesktopLifecycle(root);
  assert.equal(applied.applied, true);
  assert.equal(patchDesktopLifecycle(root).files.every(item => item.changed === false), true);
});

const actualRoot = process.env.PI_RESEARCH_TEST_DASHBOARD || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../dashboard-upstream');
test('all anchors match the available real dashboard source without modifying it', {skip: !fs.existsSync(path.join(actualRoot, registrySpec.path))}, () => {
  const files = lifecycleTransforms.map(spec => path.join(actualRoot, spec.path));
  const before = files.map(file => fs.readFileSync(file));
  const report = patchDesktopLifecycle(actualRoot, {write: false});
  assert.equal(report.files.length, 4);
  assert.deepEqual(files.map(file => fs.readFileSync(file)), before);
});
