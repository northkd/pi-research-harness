import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Register the bundled runtime-only meter without adding a pnpm workspace.
 * Its frontend is already resolved by the checked-in Vite alias. The native
 * loader discovers resources/plugins; no user config or service is changed. */
export function registerDashboardExtras(destination) {
  const root = fs.realpathSync(destination);
  const plugin = path.join(root, 'extras/speed-plugin');
  const pkg = JSON.parse(fs.readFileSync(path.join(plugin, 'package.json'), 'utf8'));
  if (pkg.name !== '@blackbelt-technology/pi-dashboard-speed-plugin'
    || pkg['pi-dashboard-plugin']?.id !== 'speed-monitor'
    || !fs.existsSync(path.join(root, 'packages/server/package.json'))) {
    throw new Error('Expected the verified Dashboard checkout and its bundled speed-monitor plugin.');
  }
  for (const relative of ['resources', 'resources/plugins']) {
    const directory = path.join(root, relative);
    if (fs.existsSync(directory)) {
      const entry = fs.lstatSync(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Refusing non-directory plugin parent: ${relative}`);
    } else fs.mkdirSync(directory);
  }
  const link = path.join(root, 'resources/plugins/speed-monitor');
  let existing;
  try { existing = fs.lstatSync(link); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    if (existing.isSymbolicLink() && fs.realpathSync(link) === fs.realpathSync(plugin)) return { registered: true, changed: false };
    throw new Error('Refusing to overwrite the existing speed-monitor plugin registration.');
  }
  fs.symlinkSync('../../extras/speed-plugin', link, 'dir');
  return { registered: true, changed: true };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/register-dashboard-extras.mjs DASHBOARD_CHECKOUT');
  console.log(JSON.stringify(registerDashboardExtras(path.resolve(process.argv[2]))));
}
