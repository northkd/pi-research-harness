// Native admission with in-memory registrations and fake spawn; no process/model starts.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as mirror from '../research-session-service.mjs';
import * as installed from '../research-session-service.mjs';

const charterHash = 'sha256:' + 'a'.repeat(64);
const adoptionId = 'adopt-' + 'b'.repeat(24);
function fixture(module, { history = 0, active = 0, otherActive = 0, completed = 0, memory = 4 * 1024 ** 3, ...options } = {}) {
  const parent = { id: 'parent', cwd: '/workspace/synthetic', status: 'idle' };
  const child = (index, status, parentSessionId = parent.id) => ({ id: 'child-' + index, status,
    researchSession: { parentSessionId, rootSessionId: parentSessionId, charterHash, adoptionId,
      workflowCwd: parent.cwd, spawnToken: 'token-' + index, depth: 1 } });
  const rows = [parent,
    ...Array.from({ length: history }, (_, i) => child('history-' + i, ['ended', 'archived', 'closed'][i % 3])),
    ...Array.from({ length: active }, (_, i) => child('active-' + i, 'idle')),
    ...Array.from({ length: otherActive }, (_, i) => child('other-' + i, 'idle', 'other-parent')),
    ...Array.from({ length: completed }, (_, i) => child('complete-' + i, 'idle', 'other-parent'))];
  let spawns = 0;
  const service = module.createResearchSessionService({
    getSession: id => rows.find(row => row.id === id), listSessions: () => rows,
    verifyParent: async () => ({ cwd: parent.cwd, charterHash, adoptionId }),
    prepareSpawn: async () => ({}),
    pendingPluginRefRegistry: { file: () => true, remove() {} },
    pendingPrincipalOwnerRegistry: { file: () => true, remove() {} },
    initialPrompts: { enqueue: () => true, remove() {} },
    spawn: async () => { spawns++; return { success: true }; },
    isLocalOperator: () => true, availableMemory: () => memory,
    isCompleted: token => token.startsWith('token-complete-'),
    ...options,
  });
  return { run: () => service.create({ body: { parentSessionId: parent.id, role: 'synthetic-worker',
    task: 'Synthetic admission fixture', stage: '2-experiment', requestId: 'request-synthetic' } }),
    spawns: () => spawns };
}

for (const [name, module] of [['active-mirror', mirror], ['installed-copy', installed]]) {
  test(`${name}: no cumulative historical limit is exported by default`, () => {
    assert.equal(Object.hasOwn(module.RESEARCH_SESSION_LIMITS, 'maxDescendants'), false);
  });
  for (const history of [24, 128]) test(`${name}: ${history} ended/archived/closed registrations permit one fresh fake launch`, async () => {
    const f = fixture(module, { history });
    assert.equal((await f.run()).status, 'spawned');
    assert.equal(f.spawns(), 1);
  });
  for (const [kind, options, code] of [
    ['per-parent concurrency', { active: 4 }, 'research-session-concurrency-limit'],
    ['global runnable capacity', { otherActive: 8 }, 'research-session-capacity-limit'],
    ['resident capacity', { completed: 32 }, 'research-session-resident-limit'],
    ['available memory', { memory: 512 * 1024 ** 2 }, 'research-session-memory-limit'],
  ]) test(`${name}: ${kind} protection remains enforced`, async () => {
    const f = fixture(module, options);
    await assert.rejects(f.run(), error => error.code === code);
    assert.equal(f.spawns(), 0);
  });
  test(`${name}: explicit injected quota remains an opt-in service contract`, async () => {
    const f = fixture(module, { history: 24, maxDescendants: 24 });
    await assert.rejects(f.run(), error => error.code === 'research-session-budget-limit');
    assert.equal(f.spawns(), 0);
  });
}
