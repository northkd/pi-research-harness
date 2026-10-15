import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { applyLayout, overlayPath, foldingPath } from '../scripts/apply-dashboard-layout.mjs';
const html = '<!doctype html><html><head><script type="module" src="/assets/existing.js"></script></head><body><div id="root"></div></body></html>';

test('layout dry-run does not change files or start services', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-dry-'));
  try {
    fs.writeFileSync(path.join(root, 'index.html'), html);
    const result = applyLayout(root);
    assert.equal(result.result, 'DRY_RUN'); assert.equal(result.changed, true);
    assert.equal(fs.readFileSync(path.join(root, 'index.html'), 'utf8'), html);
    assert.deepEqual(fs.readdirSync(root), ['index.html']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('layout overlay preserves JavaScript, keeps compressed files consistent and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-apply-'));
  try {
    fs.mkdirSync(path.join(root, 'assets'));
    fs.writeFileSync(path.join(root, 'assets/existing.js'), 'original JavaScript');
    fs.writeFileSync(path.join(root, 'index.html'), html);
    const result = applyLayout(root, { apply: true });
    const index = fs.readFileSync(path.join(root, 'index.html'));
    assert.equal(result.result, 'APPLIED'); assert.equal(result.serviceRestarted, false);
    assert.equal(fs.readFileSync(path.join(root, 'assets/existing.js'), 'utf8'), 'original JavaScript');
    assert.equal([...index.toString().matchAll(/data-research-text-containment/g)].length, 1);
    assert.match(index.toString(), /existing\.js/);
    assert.equal(result.existingScriptsUnchanged, true);
    assert.match(index.toString(), /data-research-content-folding/);
    assert.deepEqual(fs.readFileSync(path.join(root, result.foldingAsset.replace(/^\//, ''))), fs.readFileSync(foldingPath));
    assert.deepEqual(zlib.gunzipSync(fs.readFileSync(path.join(root, 'index.html.gz'))), index);
    assert.deepEqual(zlib.brotliDecompressSync(fs.readFileSync(path.join(root, 'index.html.br'))), index);
    assert.deepEqual(fs.readFileSync(path.join(root, result.asset.replace(/^\//, ''))), fs.readFileSync(overlayPath));
    assert.equal(applyLayout(root, { apply: true }).changed, false);
    assert.deepEqual(fs.readFileSync(path.join(root, 'index.html')), index);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('layout installation rejects symlink index and malformed HTML', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'layout-reject-'));
  try {
    fs.writeFileSync(path.join(root, 'other'), html);
    fs.symlinkSync(path.join(root, 'other'), path.join(root, 'index.html'));
    assert.throws(() => applyLayout(root, { apply: true }), /Regular bounded/);
    fs.unlinkSync(path.join(root, 'index.html')); fs.writeFileSync(path.join(root, 'index.html'), 'not a dashboard');
    assert.throws(() => applyLayout(root, { apply: true }), /Recognized dashboard/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
