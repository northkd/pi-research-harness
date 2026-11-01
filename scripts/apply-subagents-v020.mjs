import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function noLinks(root, relative){
 let p=root;for(const piece of relative.split('/')){if(!piece||piece==='.'||piece==='..'||piece.includes('\\'))throw Error('invalid patch path');p=path.join(p,piece);if(fs.lstatSync(p).isSymbolicLink())throw Error('symlink rejected');}return p;
}
export function applySubagentsV020(agentDir,{metadata,patchPath,checkOnly=false,run=spawnSync}={}){
 if(!path.isAbsolute(agentDir))throw Error('absolute agent directory required');
 metadata??=JSON.parse(fs.readFileSync(path.join(repo,'config/subagents-v020.json'),'utf8'));
 if(metadata.package!=='pi-subagents'||metadata.version!=='0.79.2')throw Error('package/version mismatch');
 const root=fs.realpathSync(agentDir);const pkg=noLinks(root,'npm/node_modules/pi-subagents');
 const m=JSON.parse(fs.readFileSync(noLinks(pkg,'package.json'),'utf8'));if(m.name!==metadata.package||m.version!==metadata.version)throw Error('package/version mismatch');
 const files=Object.entries(metadata.files??{});if(!files.length)throw Error('empty patch inventory');
 const states=files.map(([name,spec])=>{const current=sha(fs.readFileSync(noLinks(pkg,name)));return current===spec.beforeSha256?'before':current===spec.afterSha256?'after':'unknown';});
 if(states.every(s=>s==='after'))return{patched:true,appliedNow:false};
 if(checkOnly)throw Error('required patch absent');
 if(!states.every(s=>s==='before'))throw Error('partial or unknown package source');
 patchPath??=path.join(repo,metadata.patch);if(sha(fs.readFileSync(patchPath))!==metadata.patchSha256)throw Error('patch digest mismatch');
 for(const args of [['--check'],[]]){const result=run('git',['-C',pkg,'apply',...args,patchPath],{stdio:'pipe',shell:false});if(result.error||result.status!==0)throw Error('patch command failed');}
 for(const [name,spec] of files)if(sha(fs.readFileSync(noLinks(pkg,name)))!==spec.afterSha256)throw Error('patched source digest mismatch');
 return{patched:true,appliedNow:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);if(!args[0]||args.length>2||args[1]&&args[1]!=='--check-only')throw Error('Usage: node scripts/apply-subagents-v020.mjs AGENT_DIR [--check-only]');
 console.log(JSON.stringify(applySubagentsV020(path.resolve(args[0]),{checkOnly:args[1]==='--check-only'})));
}
