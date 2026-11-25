import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function applySubagentsPatch(agentDir, {checkOnly = false, metadata, patchFile, run = spawnSync} = {}) {
  if (!path.isAbsolute(agentDir)) throw new Error('Use an absolute isolated agent directory');
  if (!metadata) {
    try {
      metadata = JSON.parse(fs.readFileSync(path.join(repo, 'config/subagents-patch.json'), 'utf8'));
    } catch (error) {
      throw new Error('Cannot load released patch metadata', {cause: error});
    }
  }
  const packageRoot = path.join(agentDir, 'npm/node_modules', metadata.package);
  const source = path.join(packageRoot, metadata.path);
  const realRoot = fs.realpathSync(packageRoot);
  if (realRoot !== path.resolve(packageRoot) || fs.realpathSync(source) !== path.resolve(source)) {
    throw new Error('Refuse managed package symlinks');
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
  } catch (error) {
    throw new Error('Cannot load isolated package manifest', {cause: error});
  }
  if (manifest.name !== metadata.package || manifest.version !== metadata.version) throw new Error('Patch package/version mismatch');
  const current = sha256(fs.readFileSync(source));
  if (current === metadata.afterSha256) return {patched: true, appliedNow: false};
  if (checkOnly) throw new Error('Required released source patch is absent');
  if (current !== metadata.beforeSha256) throw new Error('Refuse to patch unknown source bytes');
  patchFile ??= path.join(repo, metadata.patch);
  for (const extra of [['--check'], []]) {
    const result = run('git', ['-C', packageRoot, 'apply', ...extra, patchFile], {stdio: 'inherit', shell: false});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error('Managed source patch command failed');
  }
  if (sha256(fs.readFileSync(source)) !== metadata.afterSha256) throw new Error('Patched source hash mismatch');
  return {patched: true, appliedNow: true};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2 || (args[1] && args[1] !== '--check-only')) throw new Error('Usage: node scripts/apply-subagents-patch.mjs /absolute/agent-dir [--check-only]');
  console.log(JSON.stringify(applySubagentsPatch(args[0], {checkOnly: args[1] === '--check-only'}), null, 2));
}
