import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createResWorkflowService } from '../index.mjs';
import { createWorkbench } from '../../workbench/index.mjs';

const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const researchLoopRoot = process.env.PI_RESEARCH_TEST_ROOT ? path.join(process.env.PI_RESEARCH_TEST_ROOT, 'research-loop') : fileURLToPath(new URL('../../../research-loop', import.meta.url));
const { configureResearch, charterHash } = await import(path.join(researchLoopRoot, 'src/adoption.mjs'));

test('independent adoption and workbench share one reentrant connection during manual join', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pi-adoption-workbench-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const privateDir = path.join(root, 'private');
  const histories = path.join(root, 'sessions');
  await fs.mkdir(cwd);
  await fs.mkdir(privateDir);
  await fs.mkdir(histories);
  configureResearch(cwd, { objective: 'Keep synthetic historical evidence', successCriteria: ['Keep the current charter'] });
  const principal = { iss: 'synthetic-owner', sub: 'one' };
  const parent = { id: 'synthetic-parent', cwd, sessionFile: path.join(histories, 'synthetic-parent.jsonl'), status: 'idle', principalOwner: principal };
  await fs.writeFile(parent.sessionFile, JSON.stringify({ type: 'session', id: parent.id, cwd, version: 3 }) + '\n', { mode: 0o600 });
  await fs.writeFile(parent.sessionFile.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ cwd, principalOwner: principal }) + '\n', { mode: 0o600 });
  const ownerKey = JSON.stringify([principal.iss, principal.sub]);
  const adoptionId = 'adopt-' + 'a'.repeat(24);
  const confirmationHash = 'sha256:' + 'b'.repeat(64);
  const scope = path.join(privateDir, digest(ownerKey), digest(cwd));
  await fs.mkdir(scope, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(scope, 'adopted.json'), JSON.stringify({ confirmed: true, id: adoptionId, confirmationHash }), { mode: 0o600 });
  await fs.writeFile(path.join(scope, 'current.json'), JSON.stringify({ id: adoptionId }), { mode: 0o600 });
  await fs.writeFile(path.join(scope, `${adoptionId}.json`), JSON.stringify({ schema: 'pi-res-workflow-operation.v1', ownerKey, cwd, requestId: 'synthetic-existing', creationHash: 'synthetic', adoption: { id: adoptionId, cwd, status: 'confirmed' } }), { mode: 0o600 });
  const receiptDir = path.join(cwd, '.pi/research-loop/adoptions', adoptionId);
  await fs.mkdir(receiptDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(receiptDir, 'confirmation.json'), JSON.stringify({ schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash: charterHash(cwd), autoRun: false }), { mode: 0o600 });
  const workbench = await createWorkbench({ researchLoopRoot, privateDir, getSession: id => id === parent.id ? parent : undefined, listSessions: () => [parent],
    updateSession: (_id, patch) => Object.assign(parent, patch), isResolverActive: () => true });
  const service = createResWorkflowService({ privateDir, researchLoopRoot, history: () => [parent], historyRoots: () => [histories], joinParticipant: workbench.join,
    resolveModel: async () => { throw new Error('Model execution forbidden'); } });
  t.after(() => service.dispose());
  workbench.setConnection(service.connection);
  workbench.setSnapshot(service.snapshot);
  const access = await workbench.accessFor(cwd, { principal, write: true });
  let timeout;
  const joined = await Promise.race([service.joinParticipant(access, parent.id), new Promise((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('same-scope adoption/workbench connection deadlocked')), 4000); })]).finally(() => clearTimeout(timeout));
  assert.equal(joined.sessionId, parent.id);
  assert.equal((await service.connection(access)).adopted, true);
  const verified = await workbench.verifyParent({ parent, principal });
  assert.equal(verified.adoptionId, adoptionId);
  assert.equal(verified.ownerKey, ownerKey);
  assert.equal(verified.charterHash, charterHash(cwd));
  await service.reconnect(access);
  assert.equal((await workbench.connection(access)).adopted, false);
  await assert.rejects(workbench.verifyParent({ parent, principal }), { code: 'research-workbench-proof-unavailable' });
});
