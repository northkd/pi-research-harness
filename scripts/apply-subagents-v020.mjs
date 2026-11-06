import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function noLinks(root, relative, {allowMissingLeaf = false} = {}) {
  let current = root;
  const pieces = relative.split('/');
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i];
    if (!piece || piece === '.' || piece === '..' || piece.includes('\\')) throw Error('invalid patch path');
    current = path.join(current, piece);
    let stat;
    try { stat = fs.lstatSync(current); }
    catch (error) {
      if (allowMissingLeaf && i === pieces.length - 1 && error.code === 'ENOENT') return current;
      throw error;
    }
    if (stat.isSymbolicLink()) throw Error('symlink rejected');
  }
  return current;
}

function sourceHash(root, relative) {
  const file = noLinks(root, relative, {allowMissingLeaf: true});
  try { return sha(fs.readFileSync(file)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

/** Accept only a complete pinned upstream, complete previous release, or final release. */
export function applySubagentsV020(agentDir, {metadata, patchPath, checkOnly = false, run = spawnSync} = {}) {
  if (!path.isAbsolute(agentDir)) throw Error('absolute agent directory required');
  metadata ??= JSON.parse(fs.readFileSync(path.join(repo, 'config/subagents-v020.json'), 'utf8'));
  if (metadata.package !== 'pi-subagents' || metadata.version !== '0.79.2') throw Error('package/version mismatch');
  const root = fs.realpathSync(agentDir);
  const pkg = noLinks(root, 'npm/node_modules/pi-subagents');
  const manifest = JSON.parse(fs.readFileSync(noLinks(pkg, 'package.json'), 'utf8'));
  if (manifest.name !== metadata.package || manifest.version !== metadata.version) throw Error('package/version mismatch');
  const files = Object.entries(metadata.files ?? {});
  if (!files.length) throw Error('empty patch inventory');
  const current = new Map(files.map(([name]) => [name, sourceHash(pkg, name)]));
  if (files.every(([name, spec]) => current.get(name) === spec.afterSha256)) return {patched: true, appliedNow: false};
  if (checkOnly) throw Error('required patch absent');
  let selected = metadata;
  if (!files.every(([name, spec]) => current.get(name) === spec.beforeSha256)) {
    selected = (metadata.upgrades ?? []).find(upgrade => {
      const inventory = upgrade.files;
      return inventory && Object.keys(inventory).length === files.length
        && files.every(([name]) => Object.hasOwn(inventory, name) && current.get(name) === inventory[name]);
    });
    if (!selected) throw Error('partial or unknown package source');
  }
  const authenticatedPatch = patchPath ?? path.join(repo, selected.patch);
  if (sha(fs.readFileSync(authenticatedPatch)) !== selected.patchSha256) throw Error('patch digest mismatch');
  for (const args of [['--check'], []]) {
    const result = run('git', ['-C', pkg, 'apply', ...args, authenticatedPatch], {stdio: 'pipe', shell: false});
    if (result.error || result.status !== 0) throw Error('patch command failed');
  }
  for (const [name, spec] of files) {
    if (sourceHash(pkg, name) !== spec.afterSha256) throw Error('patched source digest mismatch');
  }
  return {patched: true, appliedNow: true};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (!args[0] || args.length > 2 || args[1] && args[1] !== '--check-only') throw Error('Usage: node scripts/apply-subagents-v020.mjs AGENT_DIR [--check-only]');
  console.log(JSON.stringify(applySubagentsV020(path.resolve(args[0]), {checkOnly: args[1] === '--check-only'})));
}
