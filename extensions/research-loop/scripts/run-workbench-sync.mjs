#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkbenchSyncCollector,readVerified } from '../src/workbench-sync.mjs';
import { createWorkbenchSyncServer } from '../src/workbench-sync-server.mjs';

const args=process.argv.slice(2);
if(args.length!==2||args[0]!=='--config'||!path.isAbsolute(args[1]))throw Error('usage: run-workbench-sync.mjs --config ABSOLUTE_PATH');
const stat=fs.lstatSync(args[1]);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0||stat.uid!==process.getuid())throw Error('private-config-required');
let config;try{config=JSON.parse(readVerified(args[1],64*1024));}catch{throw Error('private-config-invalid');}
if(config.bindHost!=='127.0.0.1'||!Number.isInteger(config.port)||config.port<1024||config.port>65535)throw Error('fixed-loopback-listener-required');
for(const key of ['privateDir','adoptionDir','configurationFile','agentDir'])if(typeof config[key]!=='string'||!path.isAbsolute(config[key]))throw Error('absolute-config-path-required');
if(!Array.isArray(config.sessionRoots)||config.sessionRoots.length>8||!config.sessionRoots.every(p=>typeof p==='string'&&path.isAbsolute(p)))throw Error('session-roots-required');
const nativeRootsFromTmp=()=>fs.readdirSync(os.tmpdir(),{withFileTypes:true}).flatMap(d=>{try{return d.isDirectory()&&d.name.startsWith('pi-subagents-')&&fs.statSync(path.join(os.tmpdir(),d.name)).uid===process.getuid()?[path.join(os.tmpdir(),d.name,'async-subagent-runs')]:[];}catch{return[];}}).slice(0,32);
const nativeRoots=config.nativeRoots??nativeRootsFromTmp();
if(!Array.isArray(nativeRoots)||nativeRoots.length>32||!nativeRoots.every(p=>typeof p==='string'&&path.isAbsolute(p)))throw Error('native-roots-invalid');
const collector=createWorkbenchSyncCollector({stateDir:config.privateDir,adoptionRoot:config.adoptionDir,historyRoots:config.sessionRoots,nativeRoots,refreshNativeRoots:config.nativeRoots?undefined:nativeRootsFromTmp,stageMap:config.configurationFile,agentRoots:[config.agentDir],maxStateBytes:config.maxStateBytes,maxInactivePartitions:config.maxInactivePartitions,onError:code=>process.stderr.write('[workbench-sync] '+code+'\n')});
await collector.tick();
const server=createWorkbenchSyncServer({collector,dashboardOrigin:config.dashboardOrigin,proxyToken:config.proxyToken});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bindHost,resolve);});
const timer=setInterval(()=>{void collector.tick().catch(()=>process.stderr.write('[workbench-sync] tick-unavailable\n'));},Math.max(500,Math.min(Number(config.pollMs)||2000,30000)));
let closing=false;
const close=()=>{if(closing)return;closing=true;clearInterval(timer);server.close(()=>{collector.close();process.exit(0);});setTimeout(()=>{collector.close();process.exit(0);},3000).unref();};
process.on('SIGTERM',close);process.on('SIGINT',close);
process.stdout.write('workbench-sync ready on 127.0.0.1:'+config.port+'\n');
