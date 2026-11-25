import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { applyDashboardOverlay } from '../scripts/apply-dashboard-v020.mjs';
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const gitHash = s => crypto.createHash('sha1').update(`blob ${Buffer.byteLength(s)}\0`).update(s).digest('hex');
function fixture(t){
 const d=fs.mkdtempSync(path.join(os.tmpdir(),'overlay-test-')); t.after(()=>fs.rmSync(d,{recursive:true,force:true}));
 const src=path.join(d,'overlay'), dst=path.join(d,'base');fs.mkdirSync(path.join(src,'packages/a'),{recursive:true});fs.mkdirSync(path.join(dst,'packages/a'),{recursive:true});
 fs.writeFileSync(path.join(src,'packages/a/existing.ts'),'new');fs.writeFileSync(path.join(src,'packages/a/added.ts'),'added');fs.writeFileSync(path.join(dst,'packages/a/existing.ts'),'old');
 const manifest={files:{'packages/a/existing.ts':{sha256:hash('new'),baseBlob:gitHash('old')},'packages/a/added.ts':{sha256:hash('added'),baseBlob:null}}};return{src,dst,manifest};
}
test('applies checked files and repeated application is idempotent',t=>{const {src,dst,manifest}=fixture(t);applyDashboardOverlay(src,dst,manifest);assert.equal(fs.readFileSync(path.join(dst,'packages/a/existing.ts'),'utf8'),'new');assert.equal(fs.readFileSync(path.join(dst,'packages/a/added.ts'),'utf8'),'added');applyDashboardOverlay(src,dst,manifest);});
test('unknown base, modified overlay and path escapes are refused before any writes',t=>{const {src,dst,manifest}=fixture(t);fs.writeFileSync(path.join(dst,'packages/a/existing.ts'),'local edits');assert.throws(()=>applyDashboardOverlay(src,dst,manifest),/base/);assert.equal(fs.existsSync(path.join(dst,'packages/a/added.ts')),false);fs.writeFileSync(path.join(dst,'packages/a/existing.ts'),'old');fs.writeFileSync(path.join(src,'packages/a/added.ts'),'tampered');assert.throws(()=>applyDashboardOverlay(src,dst,manifest),/digest/);assert.equal(fs.readFileSync(path.join(dst,'packages/a/existing.ts'),'utf8'),'old');assert.throws(()=>applyDashboardOverlay(src,dst,{files:{'../outside':{sha256:hash('x'),baseBlob:null}}}),/path/);});
test('symlink destinations are refused',t=>{const {src,dst,manifest}=fixture(t);fs.unlinkSync(path.join(dst,'packages/a/existing.ts'));fs.symlinkSync('/dev/null',path.join(dst,'packages/a/existing.ts'));assert.throws(()=>applyDashboardOverlay(src,dst,manifest),/symlink/);});
