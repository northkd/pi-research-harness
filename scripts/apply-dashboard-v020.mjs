import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const gitBlob = bytes => crypto.createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
function regularFile(root, relative, { optional = false } = {}) {
  let current = root;
  const parts = relative.split('/');
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (e) { if (optional && e.code === 'ENOENT') return null; throw e; }
    if (stat.isSymbolicLink()) throw Error(`symlink rejected: ${relative}`);
  }
  const stat = fs.lstatSync(current);
  if (!stat.isFile()) throw Error(`not a regular file: ${relative}`);
  return fs.readFileSync(current);
}
function entries(root, prefix = '') {
  return fs.readdirSync(path.join(root,prefix),{withFileTypes:true}).flatMap(entry=>{
    const rel=prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw Error(`symlink rejected: ${rel}`);
    if (entry.isDirectory()) return entries(root,rel);
    if (!entry.isFile()) throw Error(`not a regular file: ${rel}`);
    return [rel];
  });
}
export function isSafeOverlayPath(rel) {
  return typeof rel === 'string' && (['tsconfig.json','tsconfig.base.json'].includes(rel) || rel.startsWith('packages/') || rel.startsWith('claude-science/host/') || rel.startsWith('claude-science/worker/') || rel.startsWith('extras/speed-plugin/')) && !rel.split('/').some(p=>!p || p==='.' || p==='..') && !rel.includes('\\');
}
export function applyDashboardOverlay(source, destination, manifest, {verifyOnly = false} = {}) {
  const src=fs.realpathSync(source),dst=fs.realpathSync(destination);
  if (!manifest || !manifest.files || typeof manifest.files !== 'object') throw Error('overlay manifest required');
  const expected=Object.keys(manifest.files).sort();
  if (!expected.length) throw Error('empty overlay manifest');
  for (const rel of expected) {
    if (!isSafeOverlayPath(rel)) throw Error('invalid overlay path');
  }
  const actual=entries(src).sort();
  if (JSON.stringify(expected)!==JSON.stringify(actual)) throw Error('overlay manifest file inventory mismatch');
  const pending=[];
  for (const rel of expected) {
    const spec=manifest.files[rel];
    if (!spec || !/^[a-f0-9]{64}$/.test(spec.sha256) || !(spec.baseBlob===null || /^[a-f0-9]{40}$/.test(spec.baseBlob))) throw Error('invalid overlay digest');
    const input=regularFile(src,rel);
    if (sha256(input)!==spec.sha256) throw Error(`overlay digest mismatch: ${rel}`);
    const current=regularFile(dst,rel,{optional:true});
    if (current && sha256(current)===spec.sha256) continue;
    if (verifyOnly) throw Error(`overlay destination mismatch: ${rel}`);
    if (spec.baseBlob===null ? current!==null : !current || gitBlob(current)!==spec.baseBlob) throw Error(`overlay base mismatch: ${rel}`);
    pending.push({rel,input});
  }
  for (const {rel,input} of pending) {
    const target=path.join(dst,...rel.split('/'));
    fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,input);
  }
  return {files:expected.length,changed:pending.length};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);if(args.length<1||args.length>2||args[1]&&args[1]!=='--verify')throw Error('Usage: node scripts/apply-dashboard-v020.mjs CHECKOUT [--verify]');
  const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
  const manifest=JSON.parse(fs.readFileSync(path.join(repo,'config/dashboard-v020.json'),'utf8'));
  console.log(JSON.stringify(applyDashboardOverlay(path.join(repo,'patches/dashboard-v0.20/overlay'),path.resolve(args[0]),manifest,{verifyOnly:args[1]==='--verify'})));
}
