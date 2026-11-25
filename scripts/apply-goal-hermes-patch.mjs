import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

// Explicit package-only operation. Does not alter settings, reload Pi or resume work.
export function applyGoalHermesPatch(agentDir, {apply = false, checkOnly = false, metadata, patchFile} = {}) {
  if (!path.isAbsolute(agentDir)) throw new Error('Use an absolute isolated agent directory');
  metadata ??= JSON.parse(fs.readFileSync(path.join(repo, 'config/goal-hermes-patch.json'), 'utf8'));
  const packageRoot = path.join(agentDir, 'npm/node_modules', metadata.package);
  if (fs.realpathSync(packageRoot) !== packageRoot) throw new Error('Refuse managed package symlinks');
  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  if (manifest.name !== metadata.package || manifest.version !== metadata.version) throw new Error('Patch package/version mismatch');
  const records = Object.entries(metadata.files);
  if (!records.length) throw new Error('Patch file inventory is empty');
  const current = records.map(([name]) => {
    const source = path.resolve(packageRoot, name);
    if (!source.startsWith(packageRoot + path.sep) || fs.realpathSync(source) !== source) throw new Error('Refuse unsafe patch source path');
    return sha256(fs.readFileSync(source));
  });
  if (records.every(([, hashes], i) => current[i] === hashes.afterSha256)) return {patched: true, appliedNow: false};
  if (checkOnly) throw new Error('Required released Goal patch is absent');
  let selected = metadata;
  if (!records.every(([, hashes], i) => current[i] === hashes.beforeSha256)) {
    selected = (metadata.upgrades ?? []).find(upgrade =>
      upgrade.files && Object.keys(upgrade.files).length === records.length &&
      records.every(([name], index) => Object.hasOwn(upgrade.files, name) && current[index] === upgrade.files[name]));
    if (!selected) throw new Error('Refuse unknown or partially patched Goal source');
  }
  patchFile ??= path.join(repo, selected.patch);
  if (sha256(fs.readFileSync(patchFile)) !== selected.patchSha256) throw new Error('Goal patch checksum mismatch');
  const run = extra => {
    const result = spawnSync('git', ['apply', ...extra, patchFile], {
      cwd: packageRoot, shell: false, encoding: 'utf8',
      env: {...process.env, GIT_CEILING_DIRECTORIES: path.dirname(packageRoot)},
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Goal patch command failed: ' + result.stderr.trim());
  };
  run(['--check']);
  if (!apply) return {patched: false, wouldApply: true, files: records.length};
  run([]);
  for (const [name, hashes] of records) {
    if (sha256(fs.readFileSync(path.join(packageRoot, name))) !== hashes.afterSha256) throw new Error('Patched Goal source hash mismatch: ' + name);
  }
  return {patched: true, appliedNow: true, files: records.length};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [agentDir, flag] = process.argv.slice(2);
  if (!agentDir || process.argv.length > 4 || (flag && !['--apply', '--dry-run', '--check-only'].includes(flag))) {
    throw new Error('Usage: node scripts/apply-goal-hermes-patch.mjs /absolute/agent-dir [--dry-run|--apply|--check-only]');
  }
  console.log(JSON.stringify(applyGoalHermesPatch(agentDir, {apply: flag === '--apply', checkOnly: flag === '--check-only'}), null, 2));
}
