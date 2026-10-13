import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const checkout=process.argv[2];
if(!checkout)throw Error('Usage: node scripts/verify-dashboard.mjs /path/to/patched-checkout');
const manifest=JSON.parse(await fs.readFile(path.join(repo,'config/snapshot.json'),'utf8'));
const expected={...manifest.frontendHashes,...manifest.bridgeHashes,...manifest.backendHashes};
for(const [name,digest] of Object.entries(expected)){
 const bytes=await fs.readFile(path.join(checkout,name));
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==digest)throw Error('Snapshot mismatch: '+name);
}
console.log(`Patched dashboard source matches ${Object.keys(expected).length} released file hashes.`);
