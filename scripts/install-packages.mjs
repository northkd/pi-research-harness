import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

export function pinnedPackages(settings) {
  const packages = [];
  const names = new Set();
  for (const entry of settings.packages ?? []) {
    const source = typeof entry === 'string' ? entry : entry.source;
    if (typeof source !== 'string' || !source.startsWith('npm:')) continue;
    const match = /^npm:((?:@[^/\s]+\/)?[^@\s]+)@(\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?)$/.exec(source);
    if (!match) throw new Error(`Require an exact npm version: ${source}`);
    const [, name, version] = match;
    if (names.has(name)) throw new Error(`Duplicate npm package: ${name}`);
    names.add(name);
    packages.push({name, version, spec: `${name}@${version}`});
  }
  if (!packages.length) throw new Error('No pinned npm packages in the isolated settings');
  return packages;
}

export function packageMismatches(agentDir, packages) {
  return packages.filter(({name, version}) => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(agentDir, 'npm/node_modules', name, 'package.json'), 'utf8'));
      return manifest.name !== name || manifest.version !== version;
    } catch {
      return true;
    }
  }).map(({name, version}) => `${name}@${version}`);
}

export function installPackages(agentDir, {checkOnly = false, run = spawnSync} = {}) {
  if (!path.isAbsolute(agentDir)) throw new Error('Use an absolute isolated agent directory');
  const settingsPath = path.join(agentDir, 'settings.json');
  let settingsBefore;
  let settings;
  try {
    settingsBefore = fs.readFileSync(settingsPath);
    settings = JSON.parse(settingsBefore.toString('utf8'));
  } catch (error) {
    throw new Error('Cannot read valid isolated settings', {cause: error});
  }
  const packages = pinnedPackages(settings);
  const missing = packageMismatches(agentDir, packages);
  if (checkOnly && missing.length) throw new Error(`Missing or mismatched packages: ${missing.join(', ')}`);
  if (missing.length) {
    const installRoot = path.join(agentDir, 'npm');
    fs.mkdirSync(installRoot, {recursive: true, mode: 0o700});
    const manifestPath = path.join(installRoot, 'package.json');
    if (!fs.existsSync(manifestPath)) {
      fs.writeFileSync(manifestPath, '{"private":true}\n', {flag: 'wx', mode: 0o600});
    }
    // This is Pi 1.0.0's managed npm directory and peer-resolution policy.
    // A pinned `pi update --extensions` skips packages, even on a fresh install.
    const result = run('npm', ['install', ...packages.map(p => p.spec), '--prefix', installRoot,
      '--legacy-peer-deps', '--no-audit', '--no-fund'], {stdio: 'inherit', shell: false});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Pinned package installation failed: exit ${result.status}, signal ${result.signal ?? 'none'}`);
  }
  if (!fs.readFileSync(settingsPath).equals(settingsBefore)) throw new Error('Installation changed the isolated resource filters');
  const remaining = packageMismatches(agentDir, packages);
  if (remaining.length) throw new Error(`Installation incomplete: ${remaining.join(', ')}`);
  return {verifiedPackages: packages.length, installedNow: missing.length > 0};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2 || (args[1] && args[1] !== '--check-only')) {
    throw new Error('Usage: node scripts/install-packages.mjs /absolute/agent-dir [--check-only]');
  }
  console.log(JSON.stringify(installPackages(args[0], {checkOnly: args[1] === '--check-only'}), null, 2));
}
