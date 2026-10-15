import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('browser layout regression uses real components, synthetic input and local-only traffic', async () => {
  const fixture = await fs.readFile(path.join(root, 'tests/dashboard-layout/fixture.tsx'), 'utf8');
  const runner = await fs.readFile(path.join(root, 'scripts/test-dashboard-layout.mjs'), 'utf8');
  assert.match(fixture, /ChatView.*@dashboard\/components\/chat/);
  assert.match(fixture, /NativeSubagents.*@dashboard\/components\/split/);
  assert.match(fixture, /@dashboard\/index\.css/);
  assert.match(runner, /\[360, 768, 1440\]/);
  assert.match(runner, /requestUrl\.origin === url/);
  assert.match(runner, /route\.abort\(\)/);
  assert.match(runner, /scrollWidth >.*clientWidth/);
  assert.match(runner, /clippedProse/);
  assert.match(runner, /Full Tailwind component utility classes must be present/);
  const css = await fs.readFile(path.join(root, 'patches/dashboard/text-containment.css'), 'utf8');
  assert.match(css, /overflow-wrap: anywhere/);
  assert.match(css, /white-space: pre-wrap/);
  assert.match(css, /overflow-x: auto/);
  assert.doesNotMatch(css, /overflow(?:-x)?:\s*hidden/);
  assert.match(css, /data-research-fold="collapsed"/);
  const folding = await fs.readFile(path.join(root, 'patches/dashboard/content-folding.mjs'), 'utf8');
  assert.match(folding, /展开全文/);
  assert.match(folding, /aria-expanded/);
  assert.match(folding, /ResizeObserver/);
  assert.match(folding, /setAttribute\('data-label', label\)/);
  assert.doesNotMatch(folding, /button\.textContent\s*=/);
  assert.doesNotMatch(folding, /fetch\(|localStorage|innerHTML\s*=/);
});

test('layout source manifest binds released CSS and folding module', async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'config/dashboard-layout-source.json'), 'utf8'));
  for (const [file, digest] of Object.entries(manifest.files)) {
    const bytes = await fs.readFile(path.join(root, file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), digest, file);
  }
});
