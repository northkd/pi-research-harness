const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Arch } = require('builder-util');

function nativeTarget(context, host = process) {
  const platform = context.electronPlatformName;
  const arch = typeof context.arch === 'number' ? Arch[context.arch] : context.arch;
  const supported = { darwin: ['arm64', 'x64'], win32: ['x64'], linux: ['arm64', 'x64'] };
  if (!supported[platform]?.includes(arch)) throw new Error(`Unsupported desktop target: ${platform}/${arch}`);
  if (platform !== host.platform || arch !== host.arch) {
    throw new Error(`Build ${platform}/${arch} on a matching native host; this host is ${host.platform}/${host.arch}`);
  }
  return { platform, arch };
}

// The dashboard runs these addons under the shipped Node executable. Requiring
// them in Electron would test a different ABI. A real short-lived PTY child also
// checks spawn-helper permissions and Windows ConPTY support before packaging.
const nativeProbe = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = process.argv[1];
// A build-machine override must not substitute a binary outside this bundle.
delete process.env.ESBUILD_BINARY_PATH;
const esbuildTransforms = [];
for (const tree of ['server', 'harness']) {
  const modules = path.join(root, '..', tree, 'node_modules', '@earendil-works', 'pi-coding-agent', 'node_modules');
  const esbuildRequire = createRequire(path.join(modules, 'esbuild', 'package.json'));
  const platformPackage = '@esbuild/' + process.platform + '-' + process.arch;
  const selected = esbuildRequire.resolve(platformPackage + '/package.json');
  if (fs.realpathSync(path.dirname(selected)) !== fs.realpathSync(path.join(modules, platformPackage))) {
    throw new Error('Native esbuild resolved outside its retained platform package: ' + tree);
  }
  const esbuild = esbuildRequire('./lib/main.js');
  const transformed = esbuild.transformSync('const answer: number = 6 * 7;', { loader: 'ts', target: 'es2022' });
  if (vm.runInNewContext(transformed.code + '\nanswer;', {}, { timeout: 1000 }) !== 42) {
    throw new Error('Bundled esbuild failed its actual TypeScript transform: ' + tree);
  }
  esbuildTransforms.push({ tree, version: esbuild.version, platformPackage, transformed: true });
}
const runtimeRequire = createRequire(path.join(root, 'package.json'));
const pty = runtimeRequire('node-pty');
if (process.platform === 'win32') runtimeRequire('koffi');
const harnessRequire = createRequire(path.join(root, '..', 'harness', 'package.json'));
const Database = harnessRequire('better-sqlite3');
const database = new Database(':memory:');
try {
  if (database.prepare('SELECT 1 AS value').get().value !== 1) throw new Error('Bundled SQLite returned an unexpected result');
} finally { database.close(); }
const marker = 'pi-research-native-runtime-ok';
const terminal = pty.spawn(process.execPath, ['-e', 'process.stdout.write("' + marker + '\\n")'], {
  name: 'xterm', cols: 80, rows: 24, cwd: root, env: process.env,
});
let output = '';
let exitCode;
let finished = false;
const timer = setTimeout(() => {
  try { terminal.kill(); } catch {}
  console.error('Bundled node-pty did not complete its native runtime probe');
  process.exit(1);
}, 15000);
function finish() {
  if (finished || exitCode !== 0 || !output.includes(marker)) return;
  finished = true;
  clearTimeout(timer);
  // Windows ConPTY retains a worker even after its child exits. All native
  // checks are complete here; flush the report before terminating this probe.
  process.stdout.write(JSON.stringify({
    platform: process.platform, arch: process.arch, version: process.version,
    modules: process.versions.modules, pty: true, sqlite: true, koffi: process.platform === 'win32',
    esbuild: esbuildTransforms,
  }) + '\n', () => process.exit(0));
}
terminal.onData((data) => { output += data; finish(); });
terminal.onExit((event) => {
  exitCode = event.exitCode;
  if (exitCode !== 0) {
    clearTimeout(timer);
    console.error('Bundled PTY child exited with code ' + exitCode);
    process.exit(1);
  }
  finish();
});
`;

module.exports = async function verifyResources(context) {
  const { platform, arch } = nativeTarget(context);
  const resources = fs.realpathSync(context.researchResourcesDirectory || path.resolve(__dirname, '../resources'));
  function resourceFile(relative) {
    const file = path.resolve(resources, relative);
    const within = (target) => target.startsWith(`${resources}${path.sep}`);
    if (!within(file) || !fs.existsSync(file)) throw new Error(`Incomplete desktop bundle: ${relative}`);
    if (!within(fs.realpathSync(file))) throw new Error(`Bundled resource points outside the application: ${relative}`);
    return file;
  }
  const readJson = (relative) => JSON.parse(fs.readFileSync(resourceFile(relative), 'utf8'));
  const required = ['research-bundle.json', 'server/node_modules/@blackbelt-technology/pi-dashboard-server/src/cli.ts',
    'server/node_modules/@blackbelt-technology/pi-dashboard-web/dist/index.html',
    'server/node_modules/jiti/lib/jiti-register.mjs', 'server/packages/extension/src/bridge.ts',
    'harness/integration/index.mjs', 'licenses/Pi-Dashboard-MIT.txt', 'node/LICENSE'];
  const nodeRelative = platform === 'win32' ? 'node/node.exe' : 'node/bin/node';
  const npmRelative = platform === 'win32' ? 'node/node_modules/npm/bin/npm-cli.js' : 'node/lib/node_modules/npm/bin/npm-cli.js';
  for (const file of [...required, nodeRelative, npmRelative]) resourceFile(file);

  const manifest = readJson('research-bundle.json');
  if (manifest.schema !== 'pi-research-desktop.bundle.v1' || manifest.build?.platform !== platform || manifest.build?.arch !== arch) {
    throw new Error('Prepared resource bundle differs from the native build target');
  }
  const extensionPins = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../config/locks/extensions/package.json'), 'utf8')).dependencies;
  if (manifest.packages?.length !== 13 || new Set(manifest.packages.map((pkg) => pkg.name)).size !== 13) {
    throw new Error('The complete set of 13 research extensions is required');
  }
  for (const pkg of manifest.packages) {
    if (pkg.version !== extensionPins[pkg.name] || pkg.path !== `harness/node_modules/${pkg.name}`) {
      throw new Error(`Research extension does not match its fixed dependency: ${pkg.name}`);
    }
    const installed = readJson(`${pkg.path}/package.json`);
    if (installed.name !== pkg.name || installed.version !== pkg.version) throw new Error(`Wrong bundled research extension: ${pkg.name}`);
  }
  if (!Array.isArray(manifest.plugins) || !manifest.plugins.some((plugin) => plugin.id === 'speed-monitor')) {
    throw new Error('Customized speed/billing dashboard plugin is missing');
  }
  for (const plugin of manifest.plugins) {
    const relative = `server/resources/plugins/${plugin.directory}`;
    const installed = readJson(`${relative}/package.json`);
    if (installed.name !== plugin.name || installed.version !== plugin.version || installed['pi-dashboard-plugin']?.id !== plugin.id) {
      throw new Error(`Bundled dashboard plugin differs from its manifest: ${plugin.id}`);
    }
    for (const entry of ['server', 'bridge']) {
      const entryPath = installed['pi-dashboard-plugin'][entry];
      if (entryPath) resourceFile(path.join(relative, entryPath));
    }
  }
  for (const name of ['pi-dashboard-server', 'pi-dashboard-shared', 'pi-dashboard-extension', 'dashboard-plugin-runtime']) {
    const directory = resourceFile(`server/node_modules/@blackbelt-technology/${name}`);
    if (fs.lstatSync(directory).isSymbolicLink()) throw new Error(`Workspace dependency must be materialized before packaging: ${name}`);
  }
  for (const tree of ['server', 'harness']) for (const name of ['pi-coding-agent', 'pi-ai', 'pi-tui', 'pi-agent-core']) {
    const pkg = readJson(`${tree}/node_modules/@earendil-works/${name}/package.json`);
    if (pkg.version !== '1.0.0') throw new Error(`Unexpected ${name} version in ${tree}: ${pkg.version}`);
  }
  const { planEsbuildPlatformPruning } = await import('./prune-esbuild-platforms.mjs');
  const esbuildPlan = planEsbuildPlatformPruning(resources, { platform, arch });
  if (esbuildPlan.removedPackages !== 0) throw new Error('Foreign esbuild platform packages remain in the prepared runtime');
  if (platform === 'win32') {
    for (const file of ['git/cmd/git.exe', 'git/usr/bin/sh.exe', 'git/usr/bin/bash.exe', 'git/THIRD-PARTY-LICENSE.txt']) resourceFile(file);
    resourceFile('git/mingw64');
    const bash = spawnSync(resourceFile('git/usr/bin/bash.exe'), ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (bash.error || bash.status !== 0 || !bash.stdout.includes('GNU bash')) throw new Error('Bundled Windows Bash cannot execute');
  }

  const probe = spawnSync(resourceFile(nodeRelative), ['-e', nativeProbe, path.join(resources, 'server')], {
    cwd: resources, encoding: 'utf8', windowsHide: true, timeout: 25000,
  });
  if (probe.error || probe.status !== 0) {
    throw new Error(`Bundled native runtime failed:\n${[
      `error: ${probe.error?.message || '(none)'}`,
      `status: ${probe.status}; signal: ${probe.signal || '(none)'}`,
      `stdout: ${probe.stdout?.trim() || '(empty)'}`,
      `stderr: ${probe.stderr?.trim() || '(empty)'}`,
    ].join('\n')}`);
  }
  const identity = JSON.parse(probe.stdout.trim().split(/\r?\n/).at(-1));
  if (identity.platform !== platform || identity.arch !== arch || identity.version !== 'v24.15.0' || identity.modules !== process.versions.modules) {
    throw new Error('Bundled Node platform, architecture, version, or native ABI differs from the native build target');
  }
  if (identity.esbuild?.length !== 2 || esbuildPlan.trees.some((tree) => !identity.esbuild.some((result) =>
    result.tree === tree.tree && result.version === tree.esbuildVersion && result.platformPackage === tree.retained.name && result.transformed === true))) {
    throw new Error('Both retained esbuild binaries must pass an actual TypeScript transform');
  }
  console.log(`Verified native research bundle ${platform}/${arch}, Node ${identity.version}, ABI ${identity.modules}, PTY, SQLite${platform === 'win32' ? ', koffi' : ''}, and both esbuild transforms.`);
};

module.exports.nativeTarget = nativeTarget;
