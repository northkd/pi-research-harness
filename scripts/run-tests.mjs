import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
// On macOS the default temporary path may contain /var -> /private/var. Resolve
// it once so the existing anti-symlink checks can validate test fixtures.
const env={...process.env,TMPDIR:fs.realpathSync(os.tmpdir())};
const tests=['integration/test','tests'].flatMap(dir=>fs.readdirSync(path.join(root,dir)).filter(name=>name.endsWith('.test.mjs')).sort().map(name=>path.join(root,dir,name)));
for (const args of [['--test',...tests],[path.join(root,'extensions/mainline-supervision/scripts/run-checks.mjs'),'offline']]) {
 const result=spawnSync(process.execPath,args,{cwd:root,env,stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status??1);
}
