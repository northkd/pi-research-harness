// Only remove foreign platform binaries from the two pinned Pi dependency trees.
// Runtime modules, target binaries, package resolution paths, and licenses stay put.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const ESBUILD_PLATFORM_ROOTS = Object.freeze(['server', 'harness'].map((tree) =>
  `${tree}/node_modules/@earendil-works/pi-coding-agent/node_modules`));

const sha256 = (filename) => createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
const readJson = (filename) => JSON.parse(fs.readFileSync(filename, 'utf8'));
const licenseName = /(?:^|[-_.])(?:licen[cs]e|copying|notice)(?:$|[-_.])/i;

function directory(root, relative) {
  let current = root;
  for (const part of relative.split('/')) {
    if (!part || part === '.' || part === '..') throw new Error(`Unsafe resource path: ${relative}`);
    current = path.join(current, part);
    const info = fs.lstatSync(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error(`Expected an ordinary directory, not a link: ${relative}`);
    }
  }
  return current;
}

function regularFile(filename) {
  const info = fs.lstatSync(filename);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Expected an ordinary file: ${filename}`);
  return info;
}

function packageContents(packageRoot) {
  const result = { bytes: 0, files: 0, licenses: [] };
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const filename = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Platform package contains a link: ${filename}`);
      if (entry.isDirectory()) visit(filename);
      else {
        const info = regularFile(filename);
        result.bytes += info.size;
        result.files++;
        if (licenseName.test(entry.name)) result.licenses.push(path.relative(packageRoot, filename));
      }
    }
  }
  visit(packageRoot);
  return result;
}

function explicitPlatform(value, label, name) {
  if (!Array.isArray(value) || value.length !== 1 || typeof value[0] !== 'string' || !/^[a-z0-9]+$/.test(value[0])) {
    throw new Error(`${name} must declare one explicit ${label}; refusing to infer a platform`);
  }
  return value[0];
}

// Plan both trees before modifying either one. Missing targets, unknown package
// identities, version drift, or ambiguous os/cpu declarations stop the build.
export function planEsbuildPlatformPruning(resourcesDirectory, { platform = process.platform, arch = process.arch } = {}) {
  if (!/^[a-z0-9]+$/.test(platform) || !/^[a-z0-9]+$/.test(arch)) throw new Error('Invalid esbuild target platform or architecture');
  const resources = fs.realpathSync(resourcesDirectory);
  const trees = ESBUILD_PLATFORM_ROOTS.map((relative) => {
    const modules = directory(resources, relative);
    const esbuildDirectory = directory(modules, 'esbuild');
    const esbuildManifest = path.join(esbuildDirectory, 'package.json');
    regularFile(esbuildManifest);
    const esbuild = readJson(esbuildManifest);
    if (esbuild.name !== 'esbuild' || typeof esbuild.version !== 'string' || !esbuild.optionalDependencies) {
      throw new Error(`Unexpected esbuild package manifest: ${relative}/esbuild`);
    }
    const scope = directory(modules, '@esbuild');
    const packages = fs.readdirSync(scope, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map((entry) => {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Unexpected entry in ${relative}/@esbuild: ${entry.name}`);
      const packageDirectory = directory(scope, entry.name);
      const manifestFile = path.join(packageDirectory, 'package.json');
      regularFile(manifestFile);
      const pkg = readJson(manifestFile);
      const name = `@esbuild/${entry.name}`;
      if (pkg.name !== name || pkg.version !== esbuild.version || esbuild.optionalDependencies[name] !== esbuild.version) {
        throw new Error(`Platform package identity/version differs from parent esbuild: ${name}`);
      }
      const packagePlatform = explicitPlatform(pkg.os, 'os', name);
      const packageArch = explicitPlatform(pkg.cpu, 'cpu', name);
      if (entry.name !== `${packagePlatform}-${packageArch}`) throw new Error(`Platform package name disagrees with os/cpu: ${name}`);
      const contents = packageContents(packageDirectory);
      const keep = packagePlatform === platform && packageArch === arch;
      if (!keep && contents.licenses.length) {
        throw new Error(`Refusing to delete license material in ${name}: ${contents.licenses.join(', ')}`);
      }
      return {
        name, version: pkg.version, os: packagePlatform, cpu: packageArch,
        path: `${relative}/${name}`, bytes: contents.bytes, files: contents.files, keep,
      };
    });
    const retained = packages.filter((pkg) => pkg.keep);
    if (retained.length !== 1) throw new Error(`Expected exactly one esbuild package for ${platform}/${arch} in ${relative}; found ${retained.length}`);
    const selected = retained[0];
    const binaryRelative = platform === 'win32' ? 'esbuild.exe' : 'bin/esbuild';
    const binary = path.join(resources, selected.path, binaryRelative);
    regularFile(binary);
    const binarySha256 = sha256(binary);
    const upstreamHash = esbuild['esbuild.binaryHashes']?.[`${selected.name}/${binaryRelative}`];
    if (upstreamHash && upstreamHash !== binarySha256) throw new Error(`Target esbuild binary hash differs from its package manifest: ${selected.name}`);
    return {
      tree: relative.split('/')[0], path: `${relative}/@esbuild`, esbuildVersion: esbuild.version,
      retained: { ...selected, binary: `${selected.path}/${binaryRelative}`, binarySha256 },
      removed: packages.filter((pkg) => !pkg.keep),
    };
  });
  const removed = trees.flatMap((tree) => tree.removed);
  return {
    schema: 'pi-research-desktop.esbuild-platform-pruning.v1', platform, arch,
    removedPackages: removed.length,
    removedBytes: removed.reduce((sum, pkg) => sum + pkg.bytes, 0),
    removedFiles: removed.reduce((sum, pkg) => sum + pkg.files, 0),
    trees,
  };
}

export function pruneEsbuildPlatforms(resourcesDirectory, options = {}) {
  const plan = planEsbuildPlatformPruning(resourcesDirectory, options);
  if (!options.check) {
    const resources = fs.realpathSync(resourcesDirectory);
    for (const tree of plan.trees) for (const pkg of tree.removed) {
      const target = directory(resources, pkg.path);
      fs.rmSync(target, { recursive: true, maxRetries: 3, retryDelay: 100 });
    }
  }
  return { ...plan, applied: !options.check, changed: !options.check && plan.removedPackages > 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const resources = args.shift();
    const options = {};
    if (!resources || resources.startsWith('--')) throw new Error('Usage: prune-esbuild-platforms.mjs <resources-directory> [--platform name] [--arch name] [--check]');
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--check') options.check = true;
      else if (['--platform', '--arch'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) {
        const key = args[i].slice(2);
        options[key] = args[++i];
      }
      else throw new Error(`Unknown or incomplete pruning argument: ${args[i]}`);
    }
    const result = pruneEsbuildPlatforms(resources, options);
    console.log(JSON.stringify(result, null, 2));
    if (options.check && result.removedPackages) process.exitCode = 1;
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 2;
  }
}
