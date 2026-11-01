import fs from 'node:fs';import zlib from 'node:zlib';import path from 'node:path';import {fileURLToPath} from 'node:url';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const marker='<script src="/res-workflow-demo-simulator.js"></script>';
export function installDemoEntry(dist){
 const root=fs.realpathSync(dist),index=path.join(root,'index.html');
 if(fs.lstatSync(index).isSymbolicLink())throw Error('symlink entry rejected');
 let html=fs.readFileSync(index,'utf8');
 if(!html.includes(marker)){if(!/<script\s+type="module"/.test(html))throw Error('Dashboard module entry not found');html=html.replace(/<script\s+type="module"/,marker+'\n<script type="module"');}
 const simulator=fs.readFileSync(path.join(repo,'scripts/demo-simulator.cjs'));
 fs.writeFileSync(path.join(root,'res-workflow-demo-simulator.js'),simulator);fs.writeFileSync(index,html);fs.writeFileSync(path.join(root,'res-workflow-demo.html'),html);
 if(fs.existsSync(index+'.gz')){const compressed=zlib.gzipSync(html);fs.writeFileSync(index+'.gz',compressed);fs.writeFileSync(path.join(root,'res-workflow-demo.html.gz'),compressed);}
 return{installed:true};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.length!==3)throw Error('Usage: node scripts/install-demo-entry.mjs DASHBOARD_DIST');
 console.log(JSON.stringify(installDemoEntry(path.resolve(process.argv[2]))));
}
