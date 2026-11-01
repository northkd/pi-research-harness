import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
test('installer dry-run works with macOS system Bash with and without optional flags',()=>{
 for(const args of [['scripts/install.sh','--dry-run'],['scripts/install.sh','--dry-run','--with-dashboard']]){
  const result=spawnSync('/bin/bash',args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/Pi 1\.3\.0/);
 }
});
