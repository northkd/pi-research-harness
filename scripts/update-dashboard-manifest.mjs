import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import {execFileSync} from 'node:child_process';import {fileURLToPath} from 'node:url';import {isSafeOverlayPath} from './apply-dashboard-v020.mjs';
function walk(root,dir=''){
 return fs.readdirSync(path.join(root,dir),{withFileTypes:true}).flatMap(e=>{const rel=dir?`${dir}/${e.name}`:e.name;if(e.isSymbolicLink())throw Error(`symlink rejected: ${rel}`);if(e.isDirectory())return walk(root,rel);if(!e.isFile())throw Error(`non-file rejected: ${rel}`);return[rel];});
}
export function buildOverlayManifest(overlay,metadata,baseEntries){
 const root=fs.realpathSync(overlay),files={};for(const rel of walk(root).sort()){
  if(!isSafeOverlayPath(rel))throw Error(`invalid overlay path: ${rel}`);
  const base=baseEntries[rel];if(base&&base.mode!=='100644'&&base.mode!=='100755')throw Error(`upstream path is not a regular file: ${rel}`);
  files[rel]={sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(root,...rel.split('/')))).digest('hex'),baseBlob:base?.sha??null};
 }
 if(!Object.keys(files).length)throw Error('empty overlay');return{...metadata,files};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw Error('Usage: node scripts/update-dashboard-manifest.mjs FIXED_UPSTREAM_CHECKOUT');
 const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),checkout=path.resolve(process.argv[2]),file=path.join(repo,'config/dashboard-v020.json');
 const metadata=JSON.parse(fs.readFileSync(file,'utf8'));
 const head=execFileSync('git',['-C',checkout,'rev-parse','HEAD'],{encoding:'utf8'}).trim();if(head!==metadata.upstreamCommit)throw Error('Unexpected upstream checkout commit');
 const tree=execFileSync('git',['-C',checkout,'ls-tree','-r','-z',head],{encoding:'utf8',maxBuffer:16*1024*1024}),base={};
 for(const record of tree.split('\0').filter(Boolean)){const match=/^(\d+) blob ([a-f0-9]{40})\t([\s\S]+)$/.exec(record);if(match)base[match[3]]={mode:match[1],sha:match[2]};}
 const updated=buildOverlayManifest(path.join(repo,'patches/dashboard-v0.20/overlay'),metadata,base);fs.writeFileSync(file,JSON.stringify(updated,null,2)+'\n');console.log(`Updated ${Object.keys(updated.files).length} overlay hashes against ${head}.`);
}
