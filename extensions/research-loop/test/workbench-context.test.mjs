import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { configureResearch, charterHash } from '../src/adoption.mjs';
import { updateResearchBudget, readResearchBudget } from '../src/research-budget.mjs';
import { registerWorkbenchContext, WORKBENCH_CONTEXT_SECTION } from '../src/workbench-context.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, JSON.stringify(value) + '\n', { mode: 0o600 }); };
function fixture(t, principalOwner) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'research-context-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const cwd = path.join(base, 'project'), privateDir = path.join(base, 'private');
  fs.mkdirSync(cwd);
  configureResearch(cwd, { objective: 'Synthetic research record protocol', successCriteria: ['Use actual evidence'] });
  const sessionId = 'fixture-parent', adoptionId = 'adopt-0123456789abcdef01234567';
  const sessionFile = path.join(base, 'sessions', 'parent.jsonl');
  write(sessionFile, { type: 'session', id: sessionId, cwd, version: 3 });
  const metaFile = sessionFile.replace(/\.jsonl$/, '.meta.json');
  const marker = { canonicalCwd: cwd, joinedAt: '2026-10-30T01:00:00.000Z', via: 'manual' };
  const metadata = { cwd, ...(principalOwner ? { principalOwner } : {}), pluginRefs: { 'res-workflow': { resWorkflow: marker } } };
  write(metaFile, metadata);
  const ownerKey = JSON.stringify(principalOwner ? [principalOwner.iss, principalOwner.sub] : ['host', 'inert-operator']);
  const scope = path.join(privateDir, digest(ownerKey), digest(cwd));
  const confirmationHash = 'sha256:' + 'a'.repeat(64);
  const pointerFile = path.join(scope, 'adopted.json');
  write(pointerFile, { confirmed: true, id: adoptionId, confirmationHash });
  const operationFile = path.join(scope, adoptionId + '.json');
  write(operationFile, { schema: 'pi-res-workflow-operation.v1', ownerKey, cwd, adoption: { id: adoptionId, cwd, status: 'confirmed' } });
  const receiptFile = path.join(cwd, '.pi/research-loop/adoptions', adoptionId, 'confirmation.json');
  write(receiptFile, { schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash: charterHash(cwd), autoRun: false });
  const hooks = new Map();
  const pi = { on(name, handler) { hooks.set(name, handler); }, events: { emit() { throw new Error('No model, prompt or RPC emission permitted'); } } };
  registerWorkbenchContext(pi, { privateDir });
  const ctx = { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile } };
  const event = { systemPrompt: 'Do not replace original prompt', systemPromptOptions: { cwd, sections: { unrelated: 'keep this section' } } };
  const invoke = () => hooks.get('before_agent_start')(event, ctx);
  return { base, cwd, ctx, event, invoke, metaFile, metadata, pointerFile, operationFile, receiptFile, sessionFile, privateDir, scope, ownerKey };
}

test('a joined adopted session receives a single scoped record protocol without replacing prompts or writing records', t => {
  const f = fixture(t);
  const state = fs.readFileSync(path.join(f.cwd, '.pi/research-loop/state.json'));
  const events = fs.readFileSync(path.join(f.cwd, '.pi/research-loop/events.jsonl'));
  f.invoke();
  const text = f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION];
  assert.equal(typeof text, 'string');
  assert.match(text, /research_loop/);
  assert.match(text, /claim-gate/);
  assert.match(text, /stable.*attemptId/i);
  assert.match(text, /explicit user authorization/i);
  assert.match(text, /not.*every tool/i);
  assert.equal(f.event.systemPrompt, 'Do not replace original prompt');
  assert.equal(f.event.systemPromptOptions.sections.unrelated, 'keep this section');
  f.invoke();
  assert.equal(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], text);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.pi/research-loop/state.json')), state);
  assert.deepEqual(fs.readFileSync(path.join(f.cwd, '.pi/research-loop/events.jsonl')), events);
  assert.equal(fs.existsSync(path.join(f.cwd, '.pi/research-loop/ledger.jsonl')), false);
  assert.equal(fs.existsSync(path.join(f.cwd, '.pi/research-loop/research-budget')), false);
});

test('historical policy stays host-private and stage context refreshes each turn', t => {
  const f = fixture(t);
  const saved = updateResearchBudget({ cwd: f.cwd, charterHash: charterHash(f.cwd), expectedRevision: null, requestId: 'context-policy-1', limits: { attempts: 100, modelRequests: 60 } });
  f.invoke();
  const text = f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION];
  assert.match(text, /Routine research_loop runs do not require a research budget/);
  assert.doesNotMatch(text, /"attempts":100|"modelRequests":60/);
  const currentBudget = readResearchBudget({ cwd: f.cwd, charterHash: charterHash(f.cwd) });
  assert.equal(currentBudget.revision, saved.revision);
  assert.deepEqual(currentBudget.limits, { attempts: null, modelRequests: null });
  assert.equal(currentBudget.enforcement.modelRequests, false);
  const stateFile = path.join(f.cwd, '.pi/research-loop/state.json');
  const state = JSON.parse(fs.readFileSync(stateFile));
  state.stage = '2-experiment';
  write(stateFile, state);
  f.invoke();
  assert.match(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], /"stage":"2-experiment"/);
});

test('adoption and membership revocation remove only this module context on the next turn', t => {
  const f = fixture(t);
  f.invoke();
  write(f.pointerFile, { confirmed: false });
  f.invoke();
  assert.equal(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
  assert.equal(f.event.systemPromptOptions.sections.unrelated, 'keep this section');
  const g = fixture(t);
  g.invoke();
  write(g.metaFile, { cwd: g.cwd });
  g.invoke();
  assert.equal(g.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
  const h = fixture(t);
  h.invoke();
  h.event.systemPromptOptions.cwd = '/different-project';
  h.invoke();
  assert.equal(h.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
});

test('foreign owner and revoked metadata remove authority while a stale binding gives explicit recovery guidance', t => {
  for (const [change, stale] of [
    [f => write(f.operationFile, { schema: 'pi-res-workflow-operation.v1', ownerKey: '["other","owner"]', cwd: f.cwd, adoption: { id: 'adopt-0123456789abcdef01234567', cwd: f.cwd, status: 'confirmed' } }), false],
    [f => write(f.receiptFile, { schema: 'pi-research-adoption-confirmation.v1', adoptionId: 'adopt-0123456789abcdef01234567', confirmationHash: 'sha256:' + 'a'.repeat(64), charterHash: 'sha256:' + 'b'.repeat(64), autoRun: false }), true],
    [f => { const op = JSON.parse(fs.readFileSync(f.operationFile)); op.detachedAt = '2026-10-30T02:00:00Z'; write(f.operationFile, op); }, false],
    [f => write(f.metaFile, { ...f.metadata, resWorkflow: { ...f.metadata.pluginRefs['res-workflow'].resWorkflow, canonicalCwd: '/different-project' } }), false],
  ]) {
    const f = fixture(t, { iss: 'synthetic', sub: 'owner' });
    change(f);
    f.invoke();
    const text = f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION];
    if (stale) {
      assert.match(text, /execution is blocked: research-workbench-charter-binding-stale/);
      assert.doesNotMatch(text, /Verified current record context:/);
    } else assert.equal(text, undefined);
  }
});

test('ordinary, remote, service, non-Pi and mismatched session contexts receive no protocol', t => {
  for (const mutate of [
    f => write(f.metaFile, { cwd: f.cwd }),
    f => write(f.metaFile, { ...f.metadata, originDeviceId: 'remote-device' }),
    f => write(f.metaFile, { ...f.metadata, pluginHidden: true }),
    f => write(f.metaFile, { ...f.metadata, archiveOnEnd: true }),
    f => write(f.metaFile, { ...f.metadata, driver: 'acp' }),
    f => { f.ctx.sessionManager.getSessionId = () => 'other-session'; },
    f => { f.event.systemPromptOptions.cwd = '/different-project'; },
    f => { f.ctx.sessionManager.getSessionFile = () => undefined; },
  ]) {
    const f = fixture(t);
    mutate(f);
    f.invoke();
    assert.equal(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
  }
});

test('unsafe, malformed and partially published metadata is ignored without aborting the turn', t => {
  const f = fixture(t);
  fs.unlinkSync(f.metaFile);
  fs.symlinkSync(f.receiptFile, f.metaFile);
  assert.doesNotThrow(f.invoke);
  assert.equal(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
  fs.unlinkSync(f.metaFile);
  fs.writeFileSync(f.metaFile, '{');
  assert.doesNotThrow(f.invoke);
  f.event.systemPromptOptions = undefined;
  assert.doesNotThrow(f.invoke);
});

function copyScope(f, owner, { move = false } = {}) {
  const ownerKey = JSON.stringify(owner), scope = path.join(f.privateDir, digest(ownerKey), digest(f.cwd));
  fs.mkdirSync(path.dirname(scope), { recursive: true, mode: 0o700 });
  if (move) fs.renameSync(f.scope, scope);
  else fs.cpSync(f.scope, scope, { recursive: true });
  const file = path.join(scope, path.basename(f.operationFile));
  const operation = JSON.parse(fs.readFileSync(file));
  operation.ownerKey = ownerKey;
  write(file, operation);
}

test('a unique proved LOCAL_OPERATOR realm supports unowned local Pi without guessing foreign namespaces', t => {
  const f = fixture(t);
  copyScope(f, ['urn:pi-dashboard:local-operator', 'local-operator'], { move: true });
  f.invoke();
  assert.equal(typeof f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], 'string');
  const g = fixture(t);
  copyScope(g, ['foreign-provider', 'foreign-user'], { move: true });
  g.invoke();
  assert.equal(g.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
});

test('two fully proved local realms are ambiguous and remove an earlier protocol instead of selecting first', t => {
  const f = fixture(t);
  f.invoke();
  assert.equal(typeof f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], 'string');
  copyScope(f, ['urn:pi-dashboard:local-operator', 'local-operator']);
  f.invoke();
  assert.equal(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
});

test('a named principal uses only its exact owner realm and never falls back to a local operator', t => {
  const f = fixture(t, { iss: 'synthetic-principal', sub: 'explicit-owner' });
  f.invoke();
  assert.equal(typeof f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], 'string');
  copyScope(f, ['host', 'inert-operator'], { move: true });
  f.invoke();
  assert.equal(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
});

test('metadata reads remain bounded if a file grows after open and fstat', t => {
  const f = fixture(t);
  const originalOpen = fs.openSync, originalStat = fs.fstatSync, originalRead = fs.readSync;
  let metadataFd, grew = false, requestedBytes = 0, originalSize;
  const handles = [
    mock.method(fs, 'openSync', (file, ...args) => { const fd = originalOpen(file, ...args); if (file === f.metaFile) metadataFd = fd; return fd; }),
    mock.method(fs, 'fstatSync', fd => { const value = originalStat(fd); if (fd === metadataFd && !grew) { grew = true; originalSize = value.size; fs.appendFileSync(f.metaFile, ' '.repeat(1024 * 1024)); } return value; }),
    mock.method(fs, 'readSync', (fd, ...args) => { if (fd === metadataFd) requestedBytes += args[2]; return originalRead(fd, ...args); }),
  ];
  t.after(() => handles.forEach(handle => handle.mock.restore()));
  assert.doesNotThrow(f.invoke);
  assert.equal(grew, true);
  assert(requestedBytes <= originalSize + 1);
  assert.equal(f.event.systemPromptOptions.sections[WORKBENCH_CONTEXT_SECTION], undefined);
});
