import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import { buildOverlayManifest } from '../scripts/update-dashboard-manifest.mjs';
test('records source digests and exact upstream blob IDs for new and modified files',t=>{
 const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'overlay-manifest-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));fs.mkdirSync(path.join(d,'packages/a'),{recursive:true});fs.writeFileSync(path.join(d,'packages/a/one.ts'),'one');fs.writeFileSync(path.join(d,'packages/a/two.ts'),'two');
 const base={'packages/a/one.ts':{mode:'100644',sha:'a'.repeat(40)}};const result=buildOverlayManifest(d,{schema:'fixture',files:{}},base);assert.equal(result.files['packages/a/one.ts'].baseBlob,'a'.repeat(40));assert.equal(result.files['packages/a/two.ts'].baseBlob,null);assert.equal(result.files['packages/a/one.ts'].sha256,crypto.createHash('sha256').update('one').digest('hex'));
});
test('rejects symlinks and unexpected source locations',t=>{
 const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'overlay-manifest-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));fs.symlinkSync('/dev/null',path.join(d,'bad'));assert.throws(()=>buildOverlayManifest(d,{files:{}},{}),/symlink/);fs.unlinkSync(path.join(d,'bad'));fs.writeFileSync(path.join(d,'outside.txt'),'x');assert.throws(()=>buildOverlayManifest(d,{files:{}},{}),/path/);
});
