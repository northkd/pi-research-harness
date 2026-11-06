import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as context from '../extensions/research-loop/src/workbench-context.mjs';
import { readResearchCharterBinding, updateResearchCharterBinding } from '../extensions/research-loop/src/charter-binding.mjs';
import { configureResearch, sha256 } from '../extensions/research-loop/src/adoption.mjs';
import { createResearchDispatchClient, registerWorkbenchDispatchTool } from '../extensions/research-loop/src/workbench-dispatch-tool.mjs';
import { createResearchSessionTool } from '../extensions/research-loop/src/workbench-session-tool.mjs';
import { createResearchDispatchService, createResearchDispatchStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';
import { ResearchSessionError } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';
import { charterBindingFixture } from './fixtures/charter-binding.mjs';

const input = f => ({ cwd: f.cwd, ownerKey: f.ownerKey, privateDir: f.privateDir });
const request = (f, requestId = 'continue-current-target') => {
  const current = readResearchCharterBinding(input(f));
  return { ...input(f), write: true, adoptionId: current.adoptionId, expectedBindingRevision: current.bindingRevision,
    expectedBoundCharterHash: current.boundCharterHash, expectedCharterHash: current.currentCharterHash, requestId };
};
function writeChild(f) {
  const file = f.sessionFile.slice(0, -6) + '.meta.json', meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.researchSession = { schema: 'pi-research-session.v1', workflowCwd: f.cwd, charterHash: f.receipt.charterHash, adoptionId: f.adoptionId, parentSessionId: 'old-lead', readOnly: true, role: 'reviewer' };
  fs.writeFileSync(file, JSON.stringify(meta));
}

test('a joined session with an old confirmed target is diagnosed as stale, not missing membership', t => {
  const fixture = charterBindingFixture(t);
  assert.equal(typeof context.inspectWorkbenchRecordContext, 'function', 'native callers need a diagnostic reader instead of collapsing valid stale membership to null');
  const result = context.inspectWorkbenchRecordContext(fixture.ctx, { privateDir: fixture.privateDir });
  assert.equal(result.status, 'charter-stale');
  assert.equal(result.error, 'research-workbench-charter-binding-stale');
  assert.equal(result.binding.adoptionId, fixture.adoptionId);
  assert.equal(result.binding.boundCharterHash, fixture.receipt.charterHash);
  assert.equal(result.binding.boundCharterRevision, null, 'legacy confirmations do not prove a historical revision number');
  assert.equal(result.binding.currentCharterRevision, 2);
});

test('an old child assignment cannot silently turn into a lead context', t => {
  const fixture = charterBindingFixture(t, { revise: false });
  const file = fixture.sessionFile.slice(0, -6) + '.meta.json';
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  meta.researchSession = { schema: 'pi-research-session.v1', workflowCwd: fixture.cwd, charterHash: 'sha256:' + 'f'.repeat(64), adoptionId: fixture.adoptionId, parentSessionId: 'other-lead', readOnly: true };
  fs.writeFileSync(file, JSON.stringify(meta));
  assert.equal(context.readWorkbenchRecordContext(fixture.ctx, { privateDir: fixture.privateDir }), null, 'old child authority must not be promoted to lead authority');
});

test('explicit CAS binding continuation preserves original scientific and adoption bytes and restores a lead', t => {
  const f = charterBindingFixture(t), update = request(f);
  const before = readResearchCharterBinding(input(f));
  assert.deepEqual(before.currentCharter.constraints, ['Read-only source data']);
  assert.deepEqual(before.currentCharter.nonGoals, ['No publication']);
  const result = updateResearchCharterBinding(update);
  assert.equal(result.status, 'current');
  assert.equal(result.adoptionId, f.adoptionId);
  assert.equal(result.bindingRevision, 1);
  assert.equal(result.boundCharterRevision, 2);
  assert.equal(result.boundCharterHash, update.expectedCharterHash);
  assert.equal(result.canRebind, false);
  for (const [file, bytes] of f.originalBytes) assert.deepEqual(fs.readFileSync(file), bytes, `repair changed ${file}`);
  const restored = context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir });
  assert.equal(restored.status, 'ready');
  assert.equal(restored.context.charterHash, update.expectedCharterHash);
  assert.deepEqual(restored.context.memory.constraints, ['Read-only source data']);
  const historyFile = path.join(f.privateScope, f.adoptionId + '.charter-bindings.json');
  const bytes = fs.readFileSync(historyFile);
  const history = JSON.parse(bytes);
  assert.equal(history.entries[0].fromCharterHash, f.receipt.charterHash);
  assert.equal(history.entries[0].fromCharterRevision, null);
  assert.equal(history.entries[0].toCharterHash, sha256(history.entries[0].toCharter));
  assert.deepEqual(updateResearchCharterBinding(update), result, 'same request replays without a second audit transition');
  assert.deepEqual(fs.readFileSync(historyFile), bytes);
  assert.throws(() => updateResearchCharterBinding({ ...update, requestId: 'competing-tab' }), { code: 'research-charter-binding-conflict' });
});

test('target changes and competing writes invalidate read-time CAS instead of rebinding a different goal', t => {
  const f = charterBindingFixture(t), update = request(f);
  configureResearch(f.cwd, { objective: 'A third target', successCriteria: ['Explicit third target result'], autoRun: false }, { expectedCharterHash: update.expectedCharterHash });
  assert.throws(() => updateResearchCharterBinding(update), { code: 'research-charter-binding-conflict' });
  assert.equal(fs.existsSync(path.join(f.privateScope, f.adoptionId + '.charter-bindings.json')), false);
  const revised = request(f, 'continue-third-target');
  assert.equal(updateResearchCharterBinding(revised).boundCharterRevision, 3);
  assert.throws(() => updateResearchCharterBinding({ ...revised, expectedBoundCharterHash: update.expectedCharterHash }), { code: 'research-charter-binding-conflict' });
});

test('binding chains continue without rewriting their previous entries, and older requests cannot roll back a new binding', t => {
  const f = charterBindingFixture(t), first = request(f);
  updateResearchCharterBinding(first);
  const historyFile = path.join(f.privateScope, f.adoptionId + '.charter-bindings.json');
  const firstEntry = JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries[0];
  configureResearch(f.cwd, { objective: 'A third target', successCriteria: ['New result'], autoRun: false });
  const second = updateResearchCharterBinding(request(f, 'next-target'));
  assert.equal(second.bindingRevision, 2);
  const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'));
  assert.deepEqual(history.entries[0], firstEntry);
  assert.equal(history.entries[1].previousEntryHash, firstEntry.entryHash);
  assert.equal(history.entries[1].fromCharterRevision, 2);
  assert.throws(() => updateResearchCharterBinding(first), { code: 'research-charter-binding-conflict' });
});

test('restored older or same-revision targets cannot corrupt a valid binding chain before normal configuration resumes', t => {
  const f = charterBindingFixture(t, { revise: false });
  const originalState = fs.readFileSync(f.currentStatePath);
  configureResearch(f.cwd, { objective: 'Second target', successCriteria: ['Second result'], autoRun: false });
  assert.equal(updateResearchCharterBinding(request(f, 'bind-second')).boundCharterRevision, 2);
  const historyFile = path.join(f.privateScope, f.adoptionId + '.charter-bindings.json');
  const historyBytes = fs.readFileSync(historyFile);
  fs.writeFileSync(f.currentStatePath, originalState); // Simulate restoring a project backup.
  assert.equal(readResearchCharterBinding(input(f)).currentCharterRevision, 1);
  assert.throws(() => updateResearchCharterBinding(request(f, 'refuse-older-target')), { code: 'research-charter-binding-conflict' });
  assert.deepEqual(fs.readFileSync(historyFile), historyBytes, 'failed continuation must not poison the existing chain');
  configureResearch(f.cwd, { objective: 'Restored target adjusted', successCriteria: ['Different second result'], autoRun: false });
  assert.equal(readResearchCharterBinding(input(f)).currentCharterRevision, 2);
  assert.throws(() => updateResearchCharterBinding(request(f, 'refuse-same-revision')), { code: 'research-charter-binding-conflict' });
  assert.deepEqual(fs.readFileSync(historyFile), historyBytes, 'same revision with a different hash is also rejected before persistence');
  configureResearch(f.cwd, { objective: 'Recovered third target', successCriteria: ['Recovered third result'], autoRun: false });
  const continued = updateResearchCharterBinding(request(f, 'bind-recovered-third'));
  assert.equal(continued.status, 'current');
  assert.equal(continued.boundCharterRevision, 3);
  assert.equal(continued.bindingRevision, 2);
  assert.deepEqual(JSON.parse(fs.readFileSync(historyFile, 'utf8')).entries[0], JSON.parse(historyBytes).entries[0]);
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'ready');
});

test('owner isolation, missing proof, detachment and unsafe proof files cannot authorize continuation', t => {
  const f = charterBindingFixture(t), update = request(f);
  const other = { ...input(f), ownerKey: JSON.stringify(['issuer', 'other']) };
  assert.equal(readResearchCharterBinding(other).status, 'not-adopted');
  assert.equal(readResearchCharterBinding(other).adoptionId, null);
  assert.throws(() => updateResearchCharterBinding({ ...update, ...other }), { code: 'research-charter-binding-not-confirmed' });
  assert.throws(() => updateResearchCharterBinding({ ...update, write: false }), { code: 'research-charter-binding-write-required' });
  const operation = fs.readFileSync(f.privateOperationPath);
  const detached = JSON.parse(operation); detached.detachedAt = new Date().toISOString();
  fs.writeFileSync(f.privateOperationPath, JSON.stringify(detached));
  assert.equal(readResearchCharterBinding(input(f)).status, 'not-adopted');
  assert.throws(() => updateResearchCharterBinding(update), { code: 'research-charter-binding-not-confirmed' });
  fs.writeFileSync(f.privateOperationPath, operation);
  const original = fs.readFileSync(f.originalReceiptPath), backup = f.originalReceiptPath + '.original';
  fs.renameSync(f.originalReceiptPath, backup);
  fs.symlinkSync(backup, f.originalReceiptPath);
  assert.equal(readResearchCharterBinding(input(f)).status, 'unavailable');
  assert.throws(() => updateResearchCharterBinding(update), { code: 'research-charter-binding-proof-unavailable' });
  fs.unlinkSync(f.originalReceiptPath);
  fs.linkSync(backup, f.originalReceiptPath);
  assert.equal(readResearchCharterBinding(input(f)).status, 'unavailable');
  fs.unlinkSync(f.originalReceiptPath);
  fs.writeFileSync(f.originalReceiptPath, original);
  assert.equal(readResearchCharterBinding(input(f)).status, 'stale');
  fs.writeFileSync(f.originalReceiptPath, '{truncated');
  assert.equal(readResearchCharterBinding(input(f)).status, 'unavailable');
  fs.writeFileSync(f.adoptedPointerPath, JSON.stringify({ confirmed: false }));
  assert.equal(readResearchCharterBinding(input(f)).status, 'unavailable', 'an arbitrary damaged pointer is not a reconnect tombstone');
  fs.writeFileSync(f.adoptedPointerPath, JSON.stringify({ confirmed: false, reconnectedAt: new Date().toISOString() }));
  assert.equal(readResearchCharterBinding(input(f)).status, 'not-adopted');
  assert.throws(() => updateResearchCharterBinding(update), { code: 'research-charter-binding-not-confirmed' });
});

test('tampered continuation and replaced original confirmation are not accepted as proof', t => {
  const f = charterBindingFixture(t);
  updateResearchCharterBinding(request(f));
  const historyFile = path.join(f.privateScope, f.adoptionId + '.charter-bindings.json');
  const historyBytes = fs.readFileSync(historyFile), history = JSON.parse(historyBytes);
  history.entries[0].toCharter.constraints = [];
  fs.writeFileSync(historyFile, JSON.stringify(history));
  assert.equal(readResearchCharterBinding(input(f)).status, 'unavailable');
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'unavailable');
  fs.writeFileSync(historyFile, historyBytes);
  fs.appendFileSync(f.originalReceiptPath, '\n');
  assert.equal(readResearchCharterBinding(input(f)).status, 'unavailable', 'continuation roots in the original immutable receipt bytes');
});

test('continuing workspace binding does not revive an old child assignment or remove its read-only constraint', async t => {
  const f = charterBindingFixture(t); writeChild(f);
  const before = fs.readFileSync(f.sessionFile.slice(0, -6) + '.meta.json');
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'assignment-stale');
  updateResearchCharterBinding(request(f));
  assert.deepEqual(fs.readFileSync(f.sessionFile.slice(0, -6) + '.meta.json'), before);
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'assignment-stale');
  assert.equal(context.readWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }), null);
  const handlers = new Map();
  registerWorkbenchDispatchTool({ registerTool() {}, on: (event, fn) => handlers.set(event, fn) }, { contextOptions: { privateDir: f.privateDir }, request: () => assert.fail('old assignment must not dispatch') });
  const blocked = await handlers.get('tool_call')({ toolName: 'write', input: { path: 'data.csv', content: 'new' } }, f.ctx);
  assert.equal(blocked.block, true); assert.match(blocked.reason, /research-workbench-assignment-stale/);
});

test('SDK first-turn header works without JSONL while missing membership and corrupted existing JSONL fail closed', t => {
  const f = charterBindingFixture(t, { firstTurn: true });
  const historyOnly = { cwd: f.cwd, sessionManager: { getSessionId: () => f.sessionId, getSessionFile: () => f.sessionFile } };
  assert.equal(context.inspectWorkbenchRecordContext(historyOnly, { privateDir: f.privateDir }).status, 'unavailable', 'history without a flushed JSONL cannot claim either joined or not joined');
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'charter-stale');
  updateResearchCharterBinding(request(f));
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'ready');
  fs.writeFileSync(f.sessionFile, '{truncated');
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'unavailable', 'getHeader cannot mask existing corrupt evidence');
  fs.unlinkSync(f.sessionFile);
  const file = f.sessionFile.slice(0, -6) + '.meta.json', meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  delete meta.resWorkflow; fs.writeFileSync(file, JSON.stringify(meta));
  assert.equal(context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir }).status, 'not-joined');
});

test('installed Pi SessionManager proves a new persistent session before its first assistant response', async t => {
  const candidates = [
    new URL('../node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js', import.meta.url),
    new URL('../.runtime/dashboard-source/node_modules/@earendil-works/pi-coding-agent/dist/core/session-manager.js', import.meta.url),
  ];
  const entry = candidates.find(candidate => fs.existsSync(fileURLToPath(candidate)));
  if (!entry) { t.skip('Pi SDK is optional for the standalone harness tests'); return; }
  const { SessionManager } = await import(entry.href);
  const f = charterBindingFixture(t, { revise: false });
  const manager = SessionManager.create(f.cwd, path.join(f.root, 'sdk-sessions'));
  assert.equal(fs.existsSync(manager.getSessionFile()), false, 'SDK deliberately has not flushed JSONL yet');
  assert.equal(manager.getHeader().type, 'session');
  const meta = fs.readFileSync(f.sessionFile.slice(0, -6) + '.meta.json');
  fs.writeFileSync(manager.getSessionFile().slice(0, -6) + '.meta.json', meta);
  const inspected = context.inspectWorkbenchRecordContext({ cwd: f.cwd, sessionManager: manager }, { privateDir: f.privateDir });
  assert.equal(inspected.status, 'ready');
  assert.equal(inspected.context.sessionId, manager.getSessionId());
});

test('native dispatch and session tools report target binding failure without making any request', async t => {
  const f = charterBindingFixture(t);
  const options = { contextOptions: { privateDir: f.privateDir }, resolveAuth: () => assert.fail('no auth read when proof is stale'), fetchImpl: () => assert.fail('no request') };
  await assert.rejects(createResearchDispatchClient(options)(f.ctx, { action: 'status' }), { message: 'research-workbench-charter-binding-stale' });
  const sessionTool = createResearchSessionTool({}, options);
  const result = await sessionTool.execute('id', { role: 'reviewer', task: 'Review the target', stage: '3-review' }, undefined, undefined, f.ctx);
  assert.equal(result.details.error, 'research-workbench-charter-binding-stale');
});

test('queued old-target plans remain recorded under their original scope and cannot start after binding continuation', async t => {
  const f = charterBindingFixture(t, { revise: false });
  const parent = { id: f.sessionId, cwd: f.cwd, status: 'idle', principalOwner: { iss: 'host', sub: 'inert-operator' } };
  const store = createResearchDispatchStore(path.join(f.root, 'dispatch'));
  let attempts = 0;
  const dispatcher = createResearchDispatchService({
    store, getSession: id => id === parent.id ? parent : undefined, listSessions: () => [parent],
    authorize: async () => {
      const inspected = context.inspectWorkbenchRecordContext(f.ctx, { privateDir: f.privateDir });
      if (inspected.status !== 'ready') throw new ResearchSessionError(409, inspected.error);
      return { parent, cwd: f.cwd, ownerKey: inspected.ownerKey, adoptionId: inspected.context.adoptionId, charterHash: inspected.context.charterHash };
    },
    createSession: async () => { attempts++; throw new ResearchSessionError(409, 'research-session-capacity-limit'); },
  });
  t.after(() => dispatcher.dispose());
  await dispatcher.handle({ principal: parent.principalOwner, body: { sessionId: parent.id, action: 'plan', planId: 'old-target-plan', concurrency: 1, readOnly: true,
    tasks: [{ id: 'first', role: 'reviewer', task: 'Inspect the original target', stage: '3-review' }, { id: 'second', role: 'reviewer', task: 'Check original evidence', stage: '3-review', dependsOn: ['first'] }] } });
  const [old] = store.readAll();
  assert.equal(old.tasks[0].status, 'queued');
  const before = attempts;
  configureResearch(f.cwd, { objective: 'A different research target', successCriteria: ['Different criteria'], autoRun: false });
  updateResearchCharterBinding(request(f));
  await dispatcher.tick();
  const [retained] = store.readAll();
  assert.equal(attempts, before, 'no old queued task can cross the new target boundary');
  assert.equal(retained.id, old.id);
  assert.equal(retained.charterHash, old.charterHash);
  assert.equal(retained.readOnly, true);
  assert.equal(retained.status, 'blocked');
  assert.equal(retained.error, 'research-dispatch-scope-changed');
  assert.ok(retained.tasks.every(task => task.status === 'blocked'));
});
