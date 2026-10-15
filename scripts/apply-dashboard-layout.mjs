#!/usr/bin/env node
// Idempotent additive CSS + optional-content toggle. No build, services, model calls or session access.
// New files are published first; index.html is replaced last. Old assets remain for open tabs/rollback.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const overlayPath = path.join(repo, 'patches/dashboard/text-containment.css');
export const foldingPath = path.join(repo, 'patches/dashboard/content-folding.mjs');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export function applyLayout(dist, { apply = false } = {}) {
  if (!dist || !path.isAbsolute(dist)) throw new Error('Use an absolute existing dashboard dist path');
  const resolved = fs.realpathSync(dist), file = path.join(resolved, 'index.html');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) throw new Error('Regular bounded static index required');
  const css = fs.readFileSync(overlayPath), digest = sha(css), asset = `research-text-containment-${digest.slice(0, 16)}.css`;
  const folding = fs.readFileSync(foldingPath), foldingDigest = sha(folding), foldingAsset = `research-content-folding-${foldingDigest.slice(0, 16)}.mjs`;
  const before = fs.readFileSync(file), text = before.toString('utf8');
  if (!text.includes('</head>') || !text.includes('<html')) throw new Error('Recognized dashboard HTML required');
  const link = `<link rel="stylesheet" href="/assets/${asset}" data-research-text-containment="${digest}">`;
  const script = `<script type="module" src="/assets/${foldingAsset}" data-research-content-folding="${foldingDigest}"></script>`;
  const next = text.replace(/\s*<link\b[^>]*data-research-text-containment="[^"]*"[^>]*>/g, '')
    .replace(/\s*<script\b[^>]*data-research-content-folding="[^"]*"[^>]*><\/script>/g, '')
    .replace('</head>', `  ${link}\n    ${script}\n  </head>`);
  const changed = !text.includes(link) || !text.includes(script);
  const report = { result: apply ? 'APPLIED' : 'DRY_RUN', changed, asset: '/assets/' + asset, cssSha256: digest,
    foldingAsset: '/assets/' + foldingAsset, foldingSha256: foldingDigest,
    beforeIndexSha256: sha(before), afterIndexSha256: changed ? sha(next) : sha(before),
    existingScriptsUnchanged: true, oldAssetsPreserved: true, serviceRestarted: false, sessionsModified: false };
  if (!apply) return report;
  const writeAtomic = (target, bytes) => {
    if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Symlink static target rejected');
    const temp = target + '.' + crypto.randomUUID() + '.tmp';
    try { fs.writeFileSync(temp, bytes, { flag: 'wx', mode: 0o644 }); fs.renameSync(temp, target); }
    finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
  };
  fs.mkdirSync(path.join(resolved, 'assets'), { recursive: true });
  if (fs.lstatSync(path.join(resolved, 'assets')).isSymbolicLink()) throw new Error('Symlink asset directory rejected');
  const assetFile = path.join(resolved, 'assets', asset);
  writeAtomic(assetFile, css); writeAtomic(assetFile + '.gz', zlib.gzipSync(css)); writeAtomic(assetFile + '.br', zlib.brotliCompressSync(css));
  const foldingFile = path.join(resolved, 'assets', foldingAsset);
  writeAtomic(foldingFile, folding); writeAtomic(foldingFile + '.gz', zlib.gzipSync(folding)); writeAtomic(foldingFile + '.br', zlib.brotliCompressSync(folding));
  if (changed) {
    if (!fs.readFileSync(file).equals(before)) throw new Error('Static index changed during preparation; refusing to replace it');
    // Keep precompressed representations consistent with the new last-write index.
    writeAtomic(file + '.gz', zlib.gzipSync(next)); writeAtomic(file + '.br', zlib.brotliCompressSync(next));
    writeAtomic(file, next);
  }
  return report;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2), dist = args.find(arg => !arg.startsWith('--'));
  if (args.some(arg => arg.startsWith('--') && !['--apply', '--dry-run'].includes(arg))) throw new Error('Usage: apply-dashboard-layout.mjs /absolute/dist [--apply|--dry-run]');
  console.log(JSON.stringify(applyLayout(dist, { apply: args.includes('--apply') }), null, 2));
}
