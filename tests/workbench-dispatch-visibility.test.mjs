import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createWorkbenchSyncCollector, digest } from '../extensions/research-loop/src/workbench-sync.mjs';

test('a freshly registered dispatch and its parent survive a full history projection', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-dispatch-'));
  const cwd = path.join(root, 'project');
  const adoptionRoot = path.join(root, 'adoptions');
  const histories = path.join(root, 'history');
  const stageMap = path.join(root, 'stages.json');
  const principalOwner = { iss: 'fixture', sub: 'owner' };
  const ownerKey = JSON.stringify([principalOwner.iss, principalOwner.sub]);
  const charter = { objective: 'Synthetic charter', successCriteria: ['Verified'] };
  const adoptionId = 'adopt-' + 'a'.repeat(24);
  const charterHash = 'sha256:' + digest(charter);
  const at = '2026-11-24T00:00:00.000Z';
  const write = (file, object) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(object) + '\n', { mode: 0o600 });
  };
  const stateDir = path.join(root, 'state');
  const adoption = path.join(adoptionRoot, digest(ownerKey), digest(cwd));
  write(path.join(cwd, '.pi/research-loop/state.json'), { charter });
  write(path.join(adoption, 'adopted.json'), { confirmed: true, id: adoptionId });
  write(path.join(adoption, adoptionId + '.json'), {
    schema: 'pi-res-workflow-operation.v1', cwd, ownerKey, adoption: { id: adoptionId, status: 'confirmed' },
  });
  write(stageMap, { stages: {} });
  fs.mkdirSync(histories);
  const row = id => ({
    id, cwd, principalOwner, sessionFile: path.join(histories, id + '.jsonl'),
    resWorkflow: { canonicalCwd: cwd, joinedAt: at, via: 'spawn' }, timestamp: at, status: 'ended',
  });

  const collector = createWorkbenchSyncCollector({ stateDir, adoptionRoot, historyRoots: [histories], stageMap });
  t.after(() => { collector.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await collector.tick();
  const binding = { cwd, adoptionId, charterHash };
  const parent = row('lead');
  const provenance = {
    schema: 'pi-research-session.v1', origin: 'research_session', relation: 'dispatch',
    workflowCwd: cwd, parentSessionId: parent.id, creatorSessionId: parent.id,
    spawnToken: 'fixture-dispatch-token', adoptionId, charterHash, stage: '3-review', role: 'fixture-reviewer', createdAt: at,
  };
  const child = { ...row('worker'), status: 'streaming', researchSession: provenance };
  const otherUser = { ...row('foreign'), principalOwner: { iss: 'fixture', sub: 'other' } };
  const history = Array.from({ length: 260 }, (_, i) => row('ended-' + i));
  const latest = collector.readForCaller(binding, [...history, parent, child, otherUser]);
  assert.equal(latest.executions.length, 256);
  assert.ok(latest.executions.some(execution => execution.sessionId === parent.id));
  assert.ok(!latest.executions.some(execution => execution.sessionId === otherUser.id));
  assert.equal(latest.executions.find(execution => execution.sessionId === child.id)?.status, 'streaming');
  assert.deepEqual(latest.relations, [{
    id: 'research-session:fixture-dispatch-token', fromExecutionId: 'session-lead', toExecutionId: 'session-worker',
    kind: 'dispatch', evidence: { source: 'explicit-record', eventId: 'fixture-dispatch-token' },
  }]);
  assert.deepEqual(collector.readForCaller(binding, [child]).relations, []);
  const { resWorkflow, ...legacyParent } = parent;
  assert.deepEqual(collector.readForCaller(binding, [child, legacyParent]).relations, latest.relations);
  assert.deepEqual(collector.readForCaller(binding, [child, { ...legacyParent, principalOwner: otherUser.principalOwner }]).relations, []);
  assert.ok(latest.coverage.reasons.includes('parent-projection-capacity'));
});
