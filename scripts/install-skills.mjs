import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

export function installSkills(destination, {dryRun = false, manifest, root = repo} = {}) {
  if (!path.isAbsolute(destination)) throw new Error('Use an absolute canonical skills directory');
  if (!manifest) {
    try {manifest = JSON.parse(fs.readFileSync(path.join(root, 'config/skill-provenance.json'), 'utf8'));}
    catch (error) {throw new Error('Cannot read released skill manifest', {cause: error});}
  }
  const chosen = new Map();
  const modes = new Map();
  for (const file of manifest.files) {
    const prefix = file.path.startsWith('vendor/skills/aris/') ? 'vendor/skills/aris/' : file.path.startsWith('vendor/skills/licensed/') ? 'vendor/skills/licensed/' : null;
    const support = file.path.startsWith('vendor/skills/tools/') || file.path.startsWith('vendor/skills/templates/');
    if (!prefix && !support) continue;
    // Keep optional helper sources with the snapshot, but do not install hooks
    // or write outside the requested skills directory.
    const relative = prefix ? file.path.slice(prefix.length) : file.path.slice('vendor/skills/'.length);
    if (path.isAbsolute(relative) || relative.split('/').includes('..')) throw new Error('Unsafe skill path');
    const source = path.join(root, file.path);
    if (fs.realpathSync(source) !== path.resolve(source)) throw new Error('Refuse skill source symlinks');
    const bytes = fs.readFileSync(source);
    if (sha256(bytes) !== file.sha256) throw new Error('Skill source hash mismatch: ' + file.path);
    if (chosen.has(relative)) throw new Error('Conflicting canonical skill file');
    chosen.set(relative, bytes);
    modes.set(relative, file.executable ? 0o700 : 0o600);
  }
  for (const license of [
    ['vendor/licenses/aris.MIT.txt', 'LICENSE.aris.MIT.txt'],
    ['vendor/licenses/html-ppt.MIT.txt', 'LICENSE.html-ppt.MIT.txt'],
    ['vendor/licenses/mineru.MIT.txt', 'LICENSE.mineru.MIT.txt'],
    ['vendor/licenses/pdf.Apache-2.0.txt', 'LICENSE.pdf.Apache-2.0.txt'],
    ['vendor/licenses/playwright.Apache-2.0.txt', 'LICENSE.playwright.Apache-2.0.txt'],
    ['vendor/licenses/skill-creator.Apache-2.0.txt', 'LICENSE.skill-creator.Apache-2.0.txt'],
  ]) chosen.set(license[1], fs.readFileSync(path.join(root, license[0])));
  if (!chosen.size) throw new Error('No checked skills available');
  if (fs.existsSync(destination) && fs.readdirSync(destination).length) throw new Error('Refuse nonempty canonical skills directory; review and merge manually');
  let ancestor = destination;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== path.resolve(ancestor)) throw new Error('Refuse symlink destination ancestor');
  if (!dryRun) {
    fs.mkdirSync(destination, {recursive: true, mode: 0o700});
    for (const [relative, bytes] of chosen) {
      const target = path.join(destination, relative);
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
      fs.writeFileSync(target, bytes, {flag: 'wx', mode: modes.get(relative) ?? 0o600});
    }
    for (const [relative, bytes] of chosen) {
      if (!fs.readFileSync(path.join(destination, relative)).equals(bytes)) throw new Error('Skill copy verification failed');
    }
  }
  return {destination, files: chosen.size, dryRun};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter(arg => arg.startsWith('--')));
  const target = args.find(arg => !arg.startsWith('--'));
  if (args.length > 2 || [...flags].some(flag => flag !== '--dry-run')) throw new Error('Usage: node scripts/install-skills.mjs [/absolute/skills-dir] [--dry-run]');
  console.log(JSON.stringify(installSkills(target || path.join(os.homedir(), '.agents/skills'), {dryRun: flags.has('--dry-run')}), null, 2));
}
