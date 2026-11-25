import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import registerResearchLoop from '../src/index.ts';
import { configureResearch, charterHash, withScientificRecordLock } from '../src/adoption.mjs';
import { loadState, readLedger, readJSONL } from '../src/ledger.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'research-record-transaction-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  configureResearch(cwd, { objective: 'Synthetic transaction verification', successCriteria: ['No duplicate evidence or lost claims'] });
  let tool;
  registerResearchLoop({ on() {}, registerTool(value) { tool = value; }, registerCommand() {}, events: { emit() { throw new Error('No model or native RPC in these tests'); } } });
  const ctx = { cwd, hasUI: false };
  return { cwd, tool, ctx, call: (params, id = 'synthetic-tool-call') => tool.execute(id, params, undefined, undefined, ctx) };
}
const attempt = { action: 'log', attemptId: 'synthetic-attempt-one', actionText: 'Compute a synthetic sum', kind: 'analysis', signal: 'positive', expected: 'Sum six', observed: 'Sum six', lesson: 'Synthetic check passes', evidence: ['synthetic.csv'] };
const claim = id => ({ action: 'claim', id, statement: 'A synthetic claim', status: 'partially_supported', evidence: ['synthetic.csv'] });

async function acceptedClaim(f, id = 'publish-claim', statement = 'The synthetic claim shown to the user') {
  await f.call({ ...claim(id), statement });
  const gate = await f.call({ action: 'claim-gate', claimId: id, jury: [{ modelId: 'synthetic-a', family: 'one' }, { modelId: 'synthetic-b', family: 'two' }], counterexample: { status: 'completed', evidence: ['counter.csv'] }, unresolvedObligations: [] });
  assert.equal(gate.details.acceptance.verdict, 'accepted');
}

test('publication confirmation cannot authorize a replacement claim written while the dialog is open', async t => {
  const f = fixture(t);
  await acceptedClaim(f);
  const result = await f.tool.execute('publish-cas-claim', { action: 'publish', claimId: 'publish-claim' }, undefined, undefined, {
    cwd: f.cwd, hasUI: true, ui: { confirm: async () => {
      await acceptedClaim(f, 'publish-claim', 'A replacement claim not shown for confirmation');
      return true;
    } },
  });
  assert.equal(result.isError, true);
  assert.match(result.details.error, /changed.*confirm|confirm.*again/i);
  assert.equal(loadState(f.cwd).claims[0].publication, undefined);
});

test('publication confirmation is invalidated by charter replacement during the dialog', async t => {
  const f = fixture(t);
  await acceptedClaim(f);
  const result = await f.tool.execute('publish-cas-charter', { action: 'publish', claimId: 'publish-claim' }, undefined, undefined, {
    cwd: f.cwd, hasUI: true, ui: { confirm: async () => {
      configureResearch(f.cwd, { objective: 'A different synthetic charter', successCriteria: ['Needs its own publication confirmation'] });
      return true;
    } },
  });
  assert.equal(result.isError, true);
  assert.match(result.details.error, /changed.*confirm|confirm.*again/i);
  assert.equal(loadState(f.cwd).claims[0].publication, undefined);
});

test('unrelated claim updates do not invalidate confirmation of an unchanged claim', async t => {
  const f = fixture(t);
  await acceptedClaim(f);
  let shown = '';
  const result = await f.tool.execute('publish-cas-unrelated', { action: 'publish', claimId: 'publish-claim' }, undefined, undefined, {
    cwd: f.cwd, hasUI: true, ui: { confirm: async (_title, body) => {
      shown = body;
      await f.call(claim('unrelated-claim'));
      return true;
    } },
  });
  assert.equal(result.isError, undefined);
  assert.match(shown, /publish-claim/);
  assert.match(shown, /The synthetic claim shown to the user/);
  assert.equal(loadState(f.cwd).claims.find(value => value.id === 'publish-claim').publication.authorized, true);
  assert.equal(loadState(f.cwd).claims.length, 2);
});

test('an explicit stage action records current-charter evidence even when the same stage field survived replacement', async t => {
  const f = fixture(t);
  await f.call({ action: 'stage', stage: '2-experiment' });
  configureResearch(f.cwd, { objective: 'A replacement charter entering the same stage', successCriteria: ['Record the new stage transition'] });
  const revision = loadState(f.cwd).charter.revision;
  assert.equal(loadState(f.cwd).stage, '2-experiment');
  const result = await f.call({ action: 'stage', stage: '2-experiment' });
  assert.equal(result.isError, undefined);
  const events = readJSONL(path.join(f.cwd, '.pi/research-loop/events.jsonl')).filter(value => value.kind === 'stage-enter');
  assert.equal(events.length, 2);
  assert.equal(events.at(-1).detail.charterRevision, revision);
  assert.equal(events.at(-1).detail.stage, '2-experiment');
});

test('real research_loop log tool replays the same durable record and preserves concurrent scientific state', async t => {
  const f = fixture(t);
  const expectedCharterHash = charterHash(f.cwd);
  const first = await f.call({ ...attempt, expectedCharterHash });
  assert.equal(first.isError, undefined);
  await f.call(claim('claim-interleaved'));
  const stateFile = path.join(f.cwd, '.pi/research-loop/state.json');
  const before = fs.readFileSync(stateFile);
  const replay = await f.call({ ...attempt, expectedCharterHash }, 'different-native-tool-call-id');
  assert.deepEqual(replay.details.logged, JSON.parse(JSON.stringify(first.details.logged)));
  assert.equal(readLedger(f.cwd).length, 1);
  assert.deepEqual(fs.readFileSync(stateFile), before);
  assert.equal(loadState(f.cwd).claims[0].id, 'claim-interleaved');
  const conflict = await f.call({ ...attempt, observed: 'A different result', expectedCharterHash });
  assert.equal(conflict.isError, true);
  assert.match(conflict.details.error, /attemptId.*conflict/i);
  assert.equal(readLedger(f.cwd).length, 1);
});

test('expected charter changes reject all scientific state mutations without rewriting claims or stages', async t => {
  const f = fixture(t), stale = charterHash(f.cwd);
  configureResearch(f.cwd, { objective: 'A replacement synthetic target', successCriteria: ['Protect the new target'] });
  const before = fs.readFileSync(path.join(f.cwd, '.pi/research-loop/state.json'));
  for (const value of [attempt, claim('stale-claim'), { action: 'stage', stage: '2-experiment' }]) {
    const result = await f.call({ ...value, expectedCharterHash: stale });
    assert.equal(result.isError, true);
    assert.match(result.details.error, /charter changed/i);
  }
  assert.equal(readLedger(f.cwd).length, 0);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.pi/research-loop/state.json')), before);
});

test('the synchronous record lock is reentrant, rejects async callbacks and releases after exceptions', t => {
  const f = fixture(t), lock = path.join(f.cwd, '.pi/research-loop/.charter-configure.lock');
  const nested = withScientificRecordLock(f.cwd, () => withScientificRecordLock(f.cwd, () => {
    assert.equal(fs.existsSync(lock), true);
    return 'nested-value';
  }));
  assert.equal(nested, 'nested-value');
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => withScientificRecordLock(f.cwd, () => { throw new Error('Synthetic failure'); }), /Synthetic failure/);
  assert.equal(fs.existsSync(lock), false);
  assert.throws(() => withScientificRecordLock(f.cwd, () => Promise.resolve()), /must be synchronous/);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(withScientificRecordLock(f.cwd, () => 'released'), 'released');
});

test('two independent Pi tool hosts retain both claims while one stable attempt consumes exactly one slot', async t => {
  const f = fixture(t), gate = path.join(f.cwd, 'go');
  const index = path.resolve(here, '../src/index.ts');
  const adoption = path.resolve(here, '../src/adoption.mjs');
  const program = `
    import fs from 'node:fs';
    import register from ${JSON.stringify(index)};
    import {withScientificRecordLock} from ${JSON.stringify(adoption)};
    const [cwd, gate, id, output] = process.argv.slice(1);
    let tool;
    register({on(){},registerTool(value){tool=value},registerCommand(){},events:{emit(){throw new Error('No RPC')}}});
    const wait = () => new Promise(resolve=>setTimeout(resolve,5));
    while(!fs.existsSync(gate)) await wait();
    async function call(params){for(let i=0;i<100;i++){const result=await tool.execute('synthetic-'+id,params,undefined,undefined,{cwd,hasUI:false});if(result.isError&&/busy/.test(result.details.error)){await wait();continue}if(result.isError)throw new Error(result.details.error);return result.details}throw new Error('Synthetic lock retry exceeded');}
    await call({action:'claim',id,statement:'Synthetic claim '+id,status:'partially_supported',evidence:['synthetic.csv']});
    const result=await call(${JSON.stringify(attempt)});
    fs.writeFileSync(output,JSON.stringify({seq:result.logged.seq}));
  `;
  const run = id => new Promise((resolve, reject) => {
    const output = path.join(f.cwd, id + '.json');
    const child = spawn(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', program, f.cwd, gate, id, output], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', value => { errors += value; });
    child.on('error', reject);
    child.on('close', code => {
      if (code) return reject(new Error(errors));
      try { resolve(JSON.parse(fs.readFileSync(output))); } catch (error) { reject(error); }
    });
  });
  const first = run('claim-one'), second = run('claim-two');
  fs.writeFileSync(gate, 'go');
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(value => value.seq), [1, 1]);
  assert.deepEqual(loadState(f.cwd).claims.map(value => value.id).sort(), ['claim-one', 'claim-two']);
  assert.equal(loadState(f.cwd).attempts, 1);
  assert.equal(readLedger(f.cwd).length, 1);
});

test('an active record transaction excludes charter replacement in another process', async t => {
  const f = fixture(t), ready = path.join(f.cwd, 'ready'), release = path.join(f.cwd, 'release');
  const adoption = path.resolve(here, '../src/adoption.mjs');
  const program = `import fs from 'node:fs';import {withScientificRecordLock} from ${JSON.stringify(adoption)};const [cwd,ready,release]=process.argv.slice(1);withScientificRecordLock(cwd,()=>{fs.writeFileSync(ready,'held');while(!fs.existsSync(release))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);});`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.cwd, ready, release], { stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = '';
  child.stderr.on('data', value => { errors += value; });
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code ? reject(new Error(errors)) : resolve()); });
  try {
    for (let i = 0; !fs.existsSync(ready) && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(fs.existsSync(ready), true, 'Synthetic holder acquired its lock');
    assert.throws(() => configureResearch(f.cwd, { objective: 'Concurrent replacement', successCriteria: ['Must wait'] }), /busy/);
    assert.equal(loadState(f.cwd).charter.objective, 'Synthetic transaction verification');
  } finally { fs.writeFileSync(release, 'release'); }
  await exited;
  configureResearch(f.cwd, { objective: 'Replacement after release', successCriteria: ['Allowed after commit'] });
  assert.equal(loadState(f.cwd).charter.objective, 'Replacement after release');
});

test('two stale-lock recoverers cannot unlink the live replacement or enter overlapping transactions', async t => {
  const f = fixture(t), lock = path.join(f.cwd, '.pi/research-loop/.charter-configure.lock');
  fs.writeFileSync(lock, JSON.stringify({ schema: 'pi-research-charter-lock.v1', pid: 99999999, nonce: 'synthetic-dead-owner' }), { mode: 0o600 });
  const module = path.resolve(here, '../src/adoption.mjs');
  const program = `
    import fs from 'node:fs';import path from 'node:path';import {withScientificRecordLock} from ${JSON.stringify(module)};
    const [cwd,id]=process.argv.slice(1),lock=path.join(cwd,'.pi/research-loop/.charter-configure.lock'),guard=lock+'.takeover';
    const wait=file=>{const start=Date.now();while(!fs.existsSync(file)){if(Date.now()-start>5000)throw new Error('Synthetic barrier timeout');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}};
    const mkdir=fs.mkdirSync;
    fs.mkdirSync=function(file,...rest){if(file===guard){fs.writeFileSync(path.join(cwd,'ready-'+id),'ready');wait(path.join(cwd,'go'));if(id==='second')wait(path.join(cwd,'inside-first'));}return mkdir.call(this,file,...rest);};
    try{withScientificRecordLock(cwd,()=>{fs.writeFileSync(path.join(cwd,'inside-'+id),'inside');if(id==='first')wait(path.join(cwd,'result-second'));});fs.writeFileSync(path.join(cwd,'result-'+id),'passed');}
    catch(error){fs.writeFileSync(path.join(cwd,'result-'+id),error.message);}
  `;
  const run = id => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', program, f.cwd, id], { stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.on('data', value => { errors += value; });
    child.on('error', reject);
    child.on('close', code => code ? reject(new Error(errors)) : resolve());
  });
  const first = run('first'), second = run('second');
  for (let i = 0; (!fs.existsSync(path.join(f.cwd, 'ready-first')) || !fs.existsSync(path.join(f.cwd, 'ready-second'))) && i < 400; i++) await new Promise(resolve => setTimeout(resolve, 5));
  fs.writeFileSync(path.join(f.cwd, 'go'), 'go');
  await Promise.all([first, second]);
  assert.equal(fs.readFileSync(path.join(f.cwd, 'result-first'), 'utf8'), 'passed');
  assert.match(fs.readFileSync(path.join(f.cwd, 'result-second'), 'utf8'), /busy/);
  assert.equal(fs.existsSync(path.join(f.cwd, 'inside-second')), false);
  assert.equal(fs.existsSync(lock), false);
  assert.equal(fs.existsSync(lock + '.takeover'), false);
});
