import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { registerDashboardExtras } from '../scripts/register-dashboard-extras.mjs';

function checkout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-extras-'));
  fs.mkdirSync(path.join(root, 'extras/speed-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'packages/server'), { recursive: true });
  fs.writeFileSync(path.join(root, 'packages/server/package.json'), '{}');
  fs.writeFileSync(path.join(root, 'extras/speed-plugin/package.json'), JSON.stringify({
    name: '@blackbelt-technology/pi-dashboard-speed-plugin', 'pi-dashboard-plugin': { id: 'speed-monitor' },
  }));
  return root;
}

test('registers a discoverable runtime plugin without changing the package workspace', () => {
  const root = checkout();
  try {
    assert.deepEqual(registerDashboardExtras(root), { registered: true, changed: true });
    assert.equal(fs.realpathSync(path.join(root, 'resources/plugins/speed-monitor')), path.join(root, 'extras/speed-plugin'));
    assert.deepEqual(registerDashboardExtras(root), { registered: true, changed: false });
    assert.equal(fs.existsSync(path.join(root, 'packages/speed-plugin')), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('never overwrites another plugin or follows a symlink parent', () => {
  for (const mode of ['occupied', 'parent']) {
    const root = checkout();
    try {
      if (mode === 'occupied') {
        fs.mkdirSync(path.join(root, 'resources/plugins/speed-monitor'), { recursive: true });
        fs.writeFileSync(path.join(root, 'resources/plugins/speed-monitor/keep.txt'), 'existing plugin');
      } else fs.symlinkSync(path.join(root, 'extras'), path.join(root, 'resources'), 'dir');
      assert.throws(() => registerDashboardExtras(root), /Refusing/);
      if (mode === 'occupied') assert.equal(fs.readFileSync(path.join(root, 'resources/plugins/speed-monitor/keep.txt'), 'utf8'), 'existing plugin');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
