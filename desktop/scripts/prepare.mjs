// Build only in disposable directories; never install into a user's Pi profile.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { adaptDashboardDirectory } from './adapt-dashboard.mjs';
import { pruneEsbuildPlatforms } from './prune-esbuild-platforms.mjs';

const desktop = fileURLToPath(new URL('..', import.meta.url));
const root = path.dirname(desktop);
const resources = path.join(desktop, 'resources');
const locks = path.join(desktop, 'locks');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'config/snapshot.json'), 'utf8'));
const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const args = process.argv.slice(2);
const refresh = args.includes('--refresh-locks');
const sourceIndex = args.indexOf('--source-dir');
const suppliedSource = sourceIndex >= 0 ? args[sourceIndex + 1] : undefined;
if (sourceIndex >= 0 && !suppliedSource) throw new Error('--source-dir needs a path');
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--source-dir') { i++; continue; }
  if (args[i] !== '--refresh-locks') throw new Error(`Unknown build argument: ${args[i]}`);
}
const source = suppliedSource ? path.resolve(suppliedSource) : path.join(desktop, '.build/dashboard');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
const writeJson = (file, object) => fs.writeFileSync(file, `${JSON.stringify(object, null, 2)}\n`);

function run(command, commandArgs, cwd = root, extra = {}) {
  console.log(`> ${path.basename(command)} ${commandArgs.join(' ')}`);
  const result = spawnSync(command, commandArgs, { cwd, env: process.env, stdio: 'inherit', shell: false, ...extra });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit ${result.status}`);
}

function findNpmCli() {
  const candidates = [process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'),
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')];
  const pathValue = process.env.PATH || process.env.Path || '';
  for (const directory of pathValue.split(path.delimiter)) {
    const binary = path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm');
    if (!fs.existsSync(binary)) continue;
    const real = fs.realpathSync(binary);
    if (real.endsWith('.js')) candidates.push(real);
    candidates.push(path.join(directory, 'node_modules/npm/bin/npm-cli.js'));
  }
  const result = candidates.find((file) => file && fs.existsSync(file));
  if (!result) throw new Error('npm CLI could not be found next to Node.js');
  return result;
}
const npmCli = findNpmCli();
const npm = (commandArgs, cwd) => run(process.execPath, [npmCli, ...commandArgs], cwd);
function copyTree(from, to, filter = () => true) {
  fs.cpSync(from, to, { recursive: true, dereference: false, verbatimSymlinks: true, filter });
}
const noDependencyTrees = (file) => !file.split(/[\\/]/).some((part) => part === 'node_modules' || part === '.git');

fs.mkdirSync(locks, { recursive: true });
fs.mkdirSync(resources, { recursive: true });
if (!suppliedSource) {
  if (fs.existsSync(source)) throw new Error(`Build checkout already exists: ${source}. Remove only this disposable .build/dashboard directory before rebuilding.`);
  fs.mkdirSync(source, { recursive: true });
  run('git', ['init'], source);
  // Snapshot hashes describe LF source bytes, including on Windows hosts.
  run('git', ['config', 'core.autocrlf', 'false'], source);
  run('git', ['remote', 'add', 'origin', snapshot.upstream.url], source);
  run('git', ['fetch', '--depth', '1', 'origin', snapshot.upstream.commit], source);
  run('git', ['checkout', '--detach', 'FETCH_HEAD'], source);
  for (const patch of snapshot.dashboardPatchOrder) {
    run('git', ['apply', '--check', path.join(root, patch)], source);
    run('git', ['apply', '--whitespace=nowarn', path.join(root, patch)], source);
  }
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' });
if (head.status || head.stdout.trim() !== snapshot.upstream.commit) throw new Error('Dashboard checkout is not the pinned upstream commit');
run(process.execPath, [path.join(root, 'scripts/verify-dashboard.mjs'), source]);

// Build the UI and run the backend against the same Pi major as the harness.
const workspacePath = path.join(source, 'pnpm-workspace.yaml');
let workspace = fs.readFileSync(workspacePath, 'utf8');
const oldOverride = '  "@earendil-works/pi-coding-agent": 0.84.1';
if (!workspace.includes(oldOverride)) throw new Error('Pinned Pi override anchor changed');
workspace = workspace.replace(oldOverride,
  '  "@earendil-works/pi-coding-agent": 1.0.0\n  "@earendil-works/pi-ai": 1.0.0\n  "@earendil-works/pi-tui": 1.0.0');
fs.writeFileSync(workspacePath, workspace);
const serverPackagePath = path.join(source, 'packages/server/package.json');
const serverPackage = readJson(serverPackagePath);
serverPackage.dependencies['@earendil-works/pi-coding-agent'] = '1.0.0';
writeJson(serverPackagePath, serverPackage);
const isolation = await adaptDashboardDirectory(source);
writeJson(path.join(resources, 'path-adaptations.json'), isolation);
console.log(`Applied ${isolation.changeCount} explicit runtime path adaptations.`);
const lifecyclePatchPath = path.join(desktop, 'scripts/patch-desktop-lifecycle.mjs');
run(process.execPath, [lifecyclePatchPath, source]);

// pnpm is installed locally with an exact version; no global package-manager mutation.
const toolsDir = path.join(desktop, '.build/tools');
fs.mkdirSync(toolsDir, { recursive: true });
writeJson(path.join(toolsDir, 'package.json'), { name: 'research-build-tools', private: true, dependencies: { pnpm: '11.15.1' } });
npm(['install', '--no-audit', '--no-fund'], toolsDir);
const pnpmCli = path.join(toolsDir, 'node_modules/pnpm/bin/pnpm.cjs');
const pnpm = (commandArgs) => run(process.execPath, [pnpmCli, ...commandArgs], source);
const dashboardLock = path.join(locks, 'dashboard-pnpm-lock.yaml');
if (refresh) {
  pnpm(['install', '--lockfile-only', '--ignore-scripts']);
  fs.copyFileSync(path.join(source, 'pnpm-lock.yaml'), dashboardLock);
} else {
  if (!fs.existsSync(dashboardLock)) throw new Error('Desktop dashboard lock is missing; maintainer must generate it with --refresh-locks');
  fs.copyFileSync(dashboardLock, path.join(source, 'pnpm-lock.yaml'));
}
pnpm(['install', '--frozen-lockfile']);
pnpm(['run', 'build']);
const clientDirectory = ['packages/dist', 'packages/client/dist', 'dist/client']
  .map((relative) => path.join(source, relative)).find((directory) => fs.existsSync(path.join(directory, 'index.html')));
if (!clientDirectory) throw new Error('The real dashboard client was not built');
run(process.execPath, [path.join(root, 'scripts/apply-dashboard-layout.mjs'), clientDirectory, '--apply']);
run(process.execPath, [path.join(source, 'packages/electron/scripts/bundle-server.mjs'), '--source-only'], source);

// Reuse upstream's source layout, but install from our committed lock with errors fatal.
const serverRoot = path.join(resources, 'server');
fs.rmSync(serverRoot, { recursive: true, force: true });
copyTree(path.join(source, 'packages/electron/resources/server'), serverRoot);
const corePins = {
  '@earendil-works/pi-coding-agent': '1.0.0', '@earendil-works/pi-ai': '1.0.0',
  '@earendil-works/pi-tui': '1.0.0', '@earendil-works/pi-agent-core': '1.0.0', typebox: '1.3.27'
};
const bundlePackage = readJson(path.join(serverRoot, 'package.json'));
bundlePackage.dependencies = { ...corePins };
bundlePackage.overrides = { ...corePins, 'bonjour-service': '1.4.2' };
const plugins = [];
for (const entry of fs.readdirSync(path.join(source, 'packages'), { withFileTypes: true })) {
  const directory = path.join(source, 'packages', entry.name);
  if (!entry.isDirectory() || !fs.existsSync(path.join(directory, 'package.json'))) continue;
  const pkg = readJson(path.join(directory, 'package.json'));
  const plugin = pkg['pi-dashboard-plugin'];
  if (!plugin || plugin.fixture === true) continue;
  const destination = path.join(serverRoot, 'resources/plugins', entry.name);
  copyTree(directory, destination, noDependencyTrees);
  for (const [name, range] of Object.entries(pkg.dependencies || {})) {
    if (!(name in bundlePackage.dependencies)) bundlePackage.dependencies[name] = range;
  }
  plugins.push({ id: plugin.id, directory: entry.name, name: pkg.name, version: pkg.version, bridge: plugin.bridge });
}
writeJson(path.join(serverRoot, 'package.json'), bundlePackage);
function lockedInstall(directory, lockName, { legacy = false, seed } = {}) {
  const lockPath = path.join(locks, lockName);
  const localLock = path.join(directory, 'package-lock.json');
  const peerFlag = legacy ? ['--legacy-peer-deps'] : [];
  if (refresh) {
    if (seed) fs.copyFileSync(seed, localLock);
    npm(['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund', ...peerFlag], directory);
    fs.copyFileSync(localLock, lockPath);
  } else {
    if (!fs.existsSync(lockPath)) throw new Error(`Missing desktop dependency lock: ${lockName}`);
    fs.copyFileSync(lockPath, localLock);
  }
  npm(['ci', '--no-audit', '--no-fund', ...peerFlag], directory);
}
lockedInstall(serverRoot, 'server-package-lock.json', { legacy: true });

// Materialize only workspace links. Preserve licenses, skills and runtime data files.
const vendorNamespace = path.join(serverRoot, 'node_modules/@blackbelt-technology');
for (const name of fs.readdirSync(vendorNamespace)) {
  const link = path.join(vendorNamespace, name);
  if (!fs.lstatSync(link).isSymbolicLink()) continue;
  const target = fs.realpathSync(link);
  if (!target.startsWith(`${serverRoot}${path.sep}`)) throw new Error(`Workspace dependency escapes the runtime: ${name}`);
  fs.unlinkSync(link);
  fs.cpSync(target, link, { recursive: true, dereference: true, filter: noDependencyTrees });
}
const webPackage = path.join(vendorNamespace, 'pi-dashboard-web');
fs.mkdirSync(webPackage, { recursive: true });
writeJson(path.join(webPackage, 'package.json'), { name: '@blackbelt-technology/pi-dashboard-web', version: snapshot.upstream.packageVersion, private: true });
copyTree(clientDirectory, path.join(webPackage, 'dist'));

// Research source and fixed extensions are installed at build time, never on first run.
const harnessRoot = path.join(resources, 'harness');
fs.rmSync(harnessRoot, { recursive: true, force: true });
fs.mkdirSync(harnessRoot, { recursive: true });
for (const name of ['agents', 'config', 'extensions', 'integration', 'skills', 'vendor', 'LICENSE', 'NOTICE', 'README.md']) {
  copyTree(path.join(root, name), path.join(harnessRoot, name), noDependencyTrees);
}
const extensions = readJson(path.join(root, 'config/locks/extensions/package.json')).dependencies;
const harnessPackage = readJson(path.join(root, 'package.json'));
delete harnessPackage.scripts;
harnessPackage.dependencies = { ...extensions, ...corePins };
harnessPackage.overrides = corePins;
writeJson(path.join(harnessRoot, 'package.json'), harnessPackage);
lockedInstall(harnessRoot, 'harness-package-lock.json', { legacy: true, seed: path.join(root, 'config/locks/extensions/package-lock.json') });
const subagentPatch = readJson(path.join(root, 'config/subagents-patch.json'));
const subagentDirectory = path.join(harnessRoot, 'node_modules', subagentPatch.package);
const patchedFile = path.join(subagentDirectory, subagentPatch.path);
if (sha256(patchedFile) !== subagentPatch.beforeSha256) throw new Error('Research subagent patch source hash mismatch');
run('git', ['-c', 'core.autocrlf=false', 'apply', '--check', path.join(root, subagentPatch.patch)], subagentDirectory);
run('git', ['-c', 'core.autocrlf=false', 'apply', path.join(root, subagentPatch.patch)], subagentDirectory);
if (sha256(patchedFile) !== subagentPatch.afterSha256) throw new Error('Research subagent patch result hash mismatch');

const esbuildPlatformPruning = pruneEsbuildPlatforms(resources);
console.log(`Removed ${esbuildPlatformPruning.removedPackages} non-target esbuild platform packages (${esbuildPlatformPruning.removedBytes} bytes) for ${process.platform}/${process.arch}.`);

const gitRoot = path.join(resources, 'git');
fs.mkdirSync(gitRoot, { recursive: true });
if (process.platform === 'win32') {
  run(process.execPath, [path.join(source, 'packages/electron/scripts/download-git-windows.mjs')], source);
  copyTree(path.join(source, 'packages/electron/resources/git'), gitRoot);
  // dugite ships GNU Bash as sh.exe; Pi's shell discovery requires bash.exe.
  fs.copyFileSync(path.join(gitRoot, 'usr/bin/sh.exe'), path.join(gitRoot, 'usr/bin/bash.exe'));
} else fs.writeFileSync(path.join(gitRoot, 'README.txt'), 'Windows Git runtime is bundled only on Windows.\n');
const icons = path.join(resources, 'icons');
fs.mkdirSync(icons, { recursive: true });
for (const name of ['icon.png', 'icon.ico', 'icon.icns']) fs.copyFileSync(path.join(source, 'packages/electron/resources', name), path.join(icons, name));
const licenses = path.join(resources, 'licenses');
fs.mkdirSync(licenses, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(licenses, 'Pi-Research-Harness-Apache-2.0.txt'));
fs.copyFileSync(path.join(root, 'NOTICE'), path.join(licenses, 'NOTICE.txt'));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(licenses, 'Pi-Dashboard-MIT.txt'));
copyTree(path.join(root, 'vendor/licenses'), path.join(licenses, 'research-upstreams'));
fs.writeFileSync(path.join(licenses, 'DEPENDENCIES.txt'),
  'Additional third-party licenses remain in server/node_modules, harness/node_modules, node/LICENSE, and git/THIRD-PARTY-LICENSE.txt (Windows).\n');
const manifest = {
  schema: 'pi-research-desktop.bundle.v1', version,
  harnessPath: 'harness', bridgePath: 'server/node_modules/@blackbelt-technology/pi-dashboard-extension',
  sourceCommit: process.env.GITHUB_SHA || spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  upstream: snapshot.upstream, piVersion: '1.0.0',
  packages: Object.entries(extensions).map(([name, version]) => ({ name, version, path: `harness/node_modules/${name}` })),
  plugins: plugins.map(({ bridge, ...plugin }) => plugin),
  pluginBridges: Object.fromEntries(plugins.filter((plugin) => plugin.bridge).map((plugin) => [
    plugin.id, path.posix.join('server/resources/plugins', plugin.directory, plugin.bridge)
  ])),
  build: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
  dependencyLocks: Object.fromEntries(['dashboard-pnpm-lock.yaml', 'server-package-lock.json', 'harness-package-lock.json'].map((name) => [name, sha256(path.join(locks, name))])),
  sourceHashesVerified: Object.keys(snapshot.sourceHashes).length,
  runtimePathAdaptations: isolation.changeCount,
  esbuildPlatformPruning
};
writeJson(path.join(resources, 'research-bundle.json'), manifest);
console.log(`Prepared ${plugins.length} Dashboard plugins and ${manifest.packages.length} research extensions for ${process.platform}/${process.arch}.`);
