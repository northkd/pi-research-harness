import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { ESBUILD_PLATFORM_ROOTS, planEsbuildPlatformPruning, pruneEsbuildPlatforms } from '../scripts/prune-esbuild-platforms.mjs';

const platforms = [['darwin', 'arm64'], ['darwin', 'x64'], ['win32', 'x64'], ['linux', 'x64']];
const bytes = (filename) => fs.readFileSync(filename);
function write(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, typeof value === 'string' ? value : JSON.stringify(value));
}
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'esbuild pruning ')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const relative of ESBUILD_PLATFORM_ROOTS) {
    const modules = path.join(root, relative);
    write(path.join(modules, 'esbuild/package.json'), {
      name: 'esbuild', version: '0.28.2',
      optionalDependencies: Object.fromEntries(platforms.map(([platform, arch]) => [`@esbuild/${platform}-${arch}`, '0.28.2'])),
    });
    write(path.join(modules, 'esbuild/lib/main.js'), '/* parent module stays in place */');
    write(path.join(modules, 'esbuild/LICENSE.md'), 'Parent MIT license stays in place');
    for (const [platform, arch] of platforms) {
      const directory = path.join(modules, `@esbuild/${platform}-${arch}`);
      write(path.join(directory, 'package.json'), {
        name: `@esbuild/${platform}-${arch}`, version: '0.28.2', os: [platform], cpu: [arch],
      });
      write(path.join(directory, platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'), `binary for ${platform}/${arch}`);
      write(path.join(directory, 'README.md'), 'Platform package description');
    }
  }
  // Similar names elsewhere must never be candidates for removal.
  write(path.join(root, 'server/node_modules/@esbuild/unrelated/package.json'), { name: 'unrelated' });
  write(path.join(root, 'harness/node_modules/context-mode/node_modules/dev-only/keep.txt'), 'out of scope');
  write(path.join(root, 'licenses/DEPENDENCIES.txt'), 'All license notices stay in place');
  return root;
}

for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'x64']]) {
  test(`${platform}/${arch} retains its exact binary, parent module, licenses and other dependency trees`, t => {
    const root = fixture(t);
    const selected = `@esbuild/${platform}-${arch}`;
    const retainedFiles = ESBUILD_PLATFORM_ROOTS.flatMap((relative) => [
      `${relative}/esbuild/package.json`, `${relative}/esbuild/lib/main.js`, `${relative}/esbuild/LICENSE.md`,
      `${relative}/${selected}/package.json`, `${relative}/${selected}/${platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild'}`,
    ]).concat(['server/node_modules/@esbuild/unrelated/package.json',
      'harness/node_modules/context-mode/node_modules/dev-only/keep.txt', 'licenses/DEPENDENCIES.txt']);
    for (const relative of ESBUILD_PLATFORM_ROOTS) {
      const license = `${relative}/${selected}/LICENSE.txt`;
      write(path.join(root, license), 'Retained native package license');
      retainedFiles.push(license);
    }
    const before = retainedFiles.map((relative) => bytes(path.join(root, relative)));
    const plan = planEsbuildPlatformPruning(root, { platform, arch });
    assert.equal(plan.removedPackages, 6);
    assert.equal(plan.removedFiles, 18);
    const expectedBytes = plan.trees.flatMap((tree) => tree.removed).reduce((sum, pkg) => sum +
      fs.readdirSync(path.join(root, pkg.path), { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .reduce((size, entry) => size + fs.statSync(path.join(entry.parentPath, entry.name)).size, 0), 0);
    assert.equal(plan.removedBytes, expectedBytes);
    const result = pruneEsbuildPlatforms(root, { platform, arch });
    assert.equal(result.removedBytes, expectedBytes);
    assert.equal(result.changed, true);
    assert.deepEqual(retainedFiles.map((relative) => bytes(path.join(root, relative))), before);
    for (const tree of result.trees) {
      assert.equal(tree.retained.name, selected);
      assert.deepEqual(fs.readdirSync(path.join(root, tree.path)), [`${platform}-${arch}`]);
      for (const removed of tree.removed) assert.equal(fs.existsSync(path.join(root, removed.path)), false);
    }
    const again = pruneEsbuildPlatforms(root, { platform, arch });
    assert.equal(again.changed, false);
    assert.equal(again.removedPackages, 0);
    assert.equal(again.removedBytes, 0);
    assert.deepEqual(again.trees.map((tree) => tree.retained), result.trees.map((tree) => tree.retained));
  });
}

test('check mode reports exact candidates without deleting any file', t => {
  const root = fixture(t);
  const result = pruneEsbuildPlatforms(root, { platform: 'linux', arch: 'x64', check: true });
  assert.equal(result.applied, false);
  assert.equal(result.changed, false);
  assert.equal(result.removedPackages, 6);
  for (const tree of result.trees) for (const pkg of tree.removed) assert.equal(fs.existsSync(path.join(root, pkg.path)), true);
});

test('missing target, ambiguous metadata and version drift in the second tree reject before any deletion', t => {
  for (const change of ['missing-target', 'os', 'cpu', 'version', 'name']) {
    const root = fixture(t);
    const relative = ESBUILD_PLATFORM_ROOTS[1];
    const target = path.join(root, relative, '@esbuild/darwin-arm64');
    if (change === 'missing-target') fs.rmSync(target, { recursive: true });
    else {
      const filename = path.join(target, 'package.json');
      const pkg = JSON.parse(bytes(filename));
      if (change === 'os') pkg.os = ['darwin', 'linux'];
      if (change === 'cpu') delete pkg.cpu;
      if (change === 'version') pkg.version = '99.0.0';
      if (change === 'name') pkg.name = '@esbuild/not-the-same-package';
      write(filename, pkg);
    }
    assert.throws(() => pruneEsbuildPlatforms(root, { platform: 'darwin', arch: 'arm64' }), /exactly one|explicit|identity\/version/);
    assert.equal(fs.existsSync(path.join(root, ESBUILD_PLATFORM_ROOTS[0], '@esbuild/win32-x64/esbuild.exe')), true);
  }
});

test('the target binary must match the parent package hash before any pruning', t => {
  const root = fixture(t);
  const modules = path.join(root, ESBUILD_PLATFORM_ROOTS[1]);
  const filename = path.join(modules, 'esbuild/package.json');
  const pkg = JSON.parse(bytes(filename));
  pkg['esbuild.binaryHashes'] = { '@esbuild/linux-x64/bin/esbuild': createHash('sha256').update('different binary').digest('hex') };
  write(filename, pkg);
  assert.throws(() => pruneEsbuildPlatforms(root, { platform: 'linux', arch: 'x64' }), /binary hash/);
  assert.equal(fs.existsSync(path.join(root, ESBUILD_PLATFORM_ROOTS[0], '@esbuild/win32-x64/esbuild.exe')), true);
});

test('a foreign package containing license material is preserved and stops pruning for review', t => {
  const root = fixture(t);
  const license = path.join(root, ESBUILD_PLATFORM_ROOTS[1], '@esbuild/win32-x64/LICENSE.txt');
  write(license, 'Do not remove a license notice');
  assert.throws(() => pruneEsbuildPlatforms(root, { platform: 'darwin', arch: 'arm64' }), /license material/);
  assert.equal(fs.readFileSync(license, 'utf8'), 'Do not remove a license notice');
  assert.equal(fs.existsSync(path.join(root, ESBUILD_PLATFORM_ROOTS[0], '@esbuild/win32-x64/esbuild.exe')), true);
});

test('a linked platform scope cannot redirect pruning outside the resource bundle', t => {
  const root = fixture(t);
  const scope = path.join(root, ESBUILD_PLATFORM_ROOTS[1], '@esbuild');
  const elsewhere = path.join(root, 'outside-platforms');
  fs.renameSync(scope, elsewhere);
  try { fs.symlinkSync(elsewhere, scope, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) {
    if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) return t.skip('Runner does not permit directory links');
    throw error;
  }
  assert.throws(() => pruneEsbuildPlatforms(root, { platform: 'darwin', arch: 'arm64' }), /ordinary directory/);
  assert.equal(fs.existsSync(path.join(elsewhere, 'win32-x64/esbuild.exe')), true);
  assert.equal(fs.existsSync(path.join(root, ESBUILD_PLATFORM_ROOTS[0], '@esbuild/win32-x64/esbuild.exe')), true);
});
