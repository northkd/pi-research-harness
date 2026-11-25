import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// On macOS the default temporary path may contain /var -> /private/var. Resolve
// it once so the existing anti-symlink checks can validate test fixtures.
const env={...process.env,TMPDIR:fs.realpathSync(os.tmpdir())};
function testsUnder(directory) {
 const tests=[];
 for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
  const file=path.join(directory,entry.name);
  if (entry.isDirectory() && !['node_modules','vendor'].includes(entry.name)) tests.push(...testsUnder(file));
  else if (entry.isFile() && entry.name.endsWith('.test.mjs')) tests.push(file);
 }
 return tests.sort();
}
const runtime=path.join(root,'.runtime/pi');
const pi=path.join(runtime,'node_modules/.bin/pi');
const hostReady=fs.existsSync(path.join(runtime,'current-version'))&&fs.existsSync(pi);
const directories=['integration/test','tests','extensions/research-loop/test'];
if (hostReady) {
 env.PI_MANAGED_INSTALL_ROOT ??= runtime;
 env.PI_RESEARCH_TEST_LAUNCHER ??= pi;
 env.PI_RESEARCH_REAL_PI ??= pi;
 directories.push('extensions/research-host');
} else console.log('Standalone host tests are enabled after scripts/install.sh.');
const tests=directories.flatMap(dir=>testsUnder(path.join(root,dir)));
for (const args of [['--test','--test-concurrency=3',...tests],[path.join(root,'extensions/mainline-supervision/scripts/run-checks.mjs'),'offline']]) {
 const result=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
