import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {pinnedPackages} from '../scripts/install-packages.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function json(file) {
  try {return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));}
  catch (error) {throw new Error('Cannot parse released lock metadata', {cause: error});}
}

test('all three dependency locks preserve exact roots, manifest versions and public integrity URLs', () => {
  const settings = json('config/settings.example.json');
  const pins = Object.fromEntries(pinnedPackages(settings).map(row => [row.name, row.version]));
  for (const component of ['extensions', 'pi', 'browser']) {
    const pkg = json(`config/locks/${component}/package.json`);
    const lock = json(`config/locks/${component}/package-lock.json`);
    assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
    assert.equal(lock.lockfileVersion, 3);
    if (component === 'extensions') assert.deepEqual(pkg.dependencies, pins);
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      assert.equal(lock.packages['node_modules/' + name].version, version);
    }
    for (const entry of Object.values(lock.packages)) {
      if (!entry.resolved) continue;
      const url = new URL(entry.resolved);
      assert.equal(url.protocol, 'https:');
      assert.equal(url.hostname, 'registry.npmjs.org');
      assert.equal(url.username + url.password + url.search + url.hash, '');
      assert.match(entry.integrity, /^sha512-/);
    }
  }
});
