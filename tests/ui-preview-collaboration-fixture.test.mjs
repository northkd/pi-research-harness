import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { seedCollaborationFixture } from '../scripts/ui-preview/collaboration-fixture.mjs';
import { createResearchCollaborationStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-collaboration-service.mjs';
import { createResearchDispatchStore } from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-dispatch-service.mjs';

test('rich UI fixture records real durable ancestry/queue without live sidecars or model execution', async t => {
  const previewHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'pi-ui-preview-'));
  t.after(() => fs.rmSync(previewHome, { recursive: true, force: true }));
  const project = path.join(previewHome, 'synthetic-demo'), transcriptDir = path.join(previewHome, '.pi/agent/sessions/demo');
  fs.mkdirSync(path.join(project, '.pi/research-loop'), { recursive: true });
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(project, '.pi/research-loop/state.json'), JSON.stringify({ charter: { objective: '【演示】fixture test' } }));
  const sessions = ['current', 'former-child', 'former'].map(name => {
    const id = randomUUID(), sessionFile = path.join(transcriptDir, `${id}.jsonl`);
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', version: 3, id, cwd: project }) + '\n');
    fs.writeFileSync(sessionFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ cwd: project, status: 'ended', name: `【演示】${name}` }));
    return { id, sessionFile, name: `【演示】${name}`, synthetic: true, status: 'ended' };
  });
  const checkpoint = path.join(previewHome, '.pi/dashboard/workbench-sync/state/synthetic-owner/synthetic-project/checkpoint.json');
  fs.mkdirSync(path.dirname(checkpoint), { recursive: true }); fs.writeFileSync(checkpoint, JSON.stringify({ parents: {}, native: {}, actions: [] }));
  const binding = { cwd: project, privateDir: path.join(previewHome, '.pi/dashboard/res-workflow'), ownerKey: '["host","inert-operator"]', adoptionId: 'adopt-' + 'a'.repeat(24) };
  const result = await seedCollaborationFixture({ previewHome, project, sessions, binding });
  assert.equal(result.realModelCalls, 0); assert.equal(sessions.length, 7);
  const state = createResearchCollaborationStore(path.join(binding.privateDir, 'collaboration')).readAll()[0];
  assert.equal(state.tenures.length, 2);
  assert.equal(state.tenures.filter(tenure => tenure.status === 'current').length, 1);
  assert.equal(state.tenures.find(tenure => tenure.id === result.currentTenureId).sessionIds.length, 5);
  for (const session of sessions) {
    const metadata = JSON.parse(fs.readFileSync(session.sessionFile.replace(/\.jsonl$/, '.meta.json'), 'utf8'));
    assert.equal(metadata.status, 'ended');
    if (result.childSessionIds.includes(session.id)) assert.equal(metadata.pluginRefs['res-workflow'].researchSession.parentSessionId, result.currentMainSessionId);
  }
  const plan = createResearchDispatchStore(path.join(binding.privateDir, 'dispatch')).readAll()[0];
  assert.equal(plan.tasks.filter(task => task.status === 'queued').length, 4);
  assert.deepEqual(plan.tasks.find(task => task.id === 'neb').dependsOn, ['counterexample']);
  assert.equal(state.nativeQueue.filter(item => item.status === 'released').length, 3);
  assert.equal(state.nativeQueue.filter(item => item.status === 'queued').length, 1);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(checkpoint, 'utf8')).native).length, 4);
});
