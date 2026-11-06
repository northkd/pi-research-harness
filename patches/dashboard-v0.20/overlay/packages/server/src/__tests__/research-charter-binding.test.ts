import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createResWorkflowService, ResWorkflowError, type ResWorkflowAccess, type ResWorkflowService } from '../res-workflow/adoption-service.js';
import { registerResWorkflowRoutes } from '../routes/res-workflow-routes.js';
import { createDefaultResearchSessionVerifier } from '../routes/res-workflow-research-session-routes.js';

function harnessRoot() {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (fs.existsSync(path.join(cursor, 'extensions/research-loop/src/charter-binding.mjs'))) return cursor;
    const parent = path.dirname(cursor); if (parent === cursor) throw new Error('Native binding backend missing'); cursor = parent;
  }
}
const harness = harnessRoot(), researchLoopRoot = path.join(harness, 'extensions/research-loop');
const roots: string[] = [], apps: FastifyInstance[] = [], services: ResWorkflowService[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const service of services.splice(0)) service.dispose();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(options: Record<string, unknown> = {}) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'binding-platform-')); roots.push(root);
  const module = await import(pathToFileURL(path.join(harness, 'tests/fixtures/charter-binding.mjs')).href);
  const f = module.charterBindingFixture(undefined, { root, ...options });
  const [iss, sub] = JSON.parse(f.ownerKey);
  const row = { id: f.sessionId, cwd: f.cwd, sessionFile: f.sessionFile, status: 'ended', driver: 'pi', principalOwner: { iss, sub } };
  let rows = [row];
  const history = () => rows;
  const service = createResWorkflowService({ privateDir: f.privateDir, researchLoopRoot, history, historyRoots: () => [] }); services.push(service);
  const access: ResWorkflowAccess = { cwd: f.cwd, ownerKey: f.ownerKey, write: true, revalidate: vi.fn(async () => {}), canReadHistory: async () => true };
  const read = () => service.charterBinding(access, f.sessionId);
  const request = async (requestId = 'continue-reviewed-target') => {
    const binding = await read();
    return { cwd: f.cwd, adoptionId: binding.adoptionId!, expectedBindingRevision: binding.bindingRevision, expectedBoundCharterHash: binding.boundCharterHash!, expectedCharterHash: binding.currentCharterHash!, requestId };
  };
  return { ...f, row, history, replaceRows: (next: typeof rows) => { rows = next; }, service, access, read, request };
}

describe('target binding platform action', () => {
  it('reads real ended-session membership and continues the original adoption without changing its evidence', async () => {
    const f = await fixture();
    expect(await f.read()).toMatchObject({ status: 'stale', adoptionId: f.adoptionId, boundCharterRevision: null, currentCharterRevision: 2, session: { sessionId: f.sessionId, status: 'joined' } });
    const request = await f.request();
    expect(await f.service.updateCharterBinding(f.access, request)).toMatchObject({ status: 'current', adoptionId: f.adoptionId, bindingRevision: 1, boundCharterHash: request.expectedCharterHash });
    expect(await f.read()).toMatchObject({ status: 'current', session: { status: 'joined' } });
    for (const [file, bytes] of f.originalBytes) expect(fs.readFileSync(file)).toEqual(bytes);
    expect(await f.service.updateCharterBinding(f.access, request)).toMatchObject({ bindingRevision: 1 });
  });

  it('revalidates write identity immediately before persistence and never reads a foreign owner session', async () => {
    const f = await fixture(), request = await f.request();
    await expect(f.service.updateCharterBinding({ ...f.access, write: false }, request)).rejects.toMatchObject({ statusCode: 403 });
    let checks = 0;
    await expect(f.service.updateCharterBinding({ ...f.access, revalidate: async () => { if (++checks === 2) throw new ResWorkflowError(403, 'adoption-identity-expired'); } }, request)).rejects.toMatchObject({ statusCode: 403 });
    expect((await f.read()).status).toBe('stale');
    f.replaceRows([{ ...f.row, principalOwner: { iss: 'issuer', sub: 'other-owner' } }]);
    expect((await f.read()).session).toEqual({ sessionId: f.sessionId, status: 'not-joined', error: 'research-workbench-session-not-joined' });
    const other = { ...f.access, ownerKey: JSON.stringify(['issuer', 'other-owner']) };
    expect(await f.service.charterBinding(other)).toMatchObject({ status: 'not-adopted', adoptionId: null });
    await expect(f.service.updateCharterBinding(other, request)).rejects.toMatchObject({ code: 'research-charter-binding-not-confirmed' });
  });

  it('serializes competing continuations and makes the stale tab refresh instead of writing again', async () => {
    const f = await fixture(), request = await f.request();
    const results = await Promise.allSettled([f.service.updateCharterBinding(f.access, request), f.service.updateCharterBinding(f.access, { ...request, requestId: 'second-tab' })]);
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { bindingRevision: 1 } });
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'research-charter-binding-conflict', statusCode: 409 } });
  });

  it('default session verifier exposes stale target and child assignment separately and handles first-turn registered identity', async () => {
    const f = await fixture({ firstTurn: true }), parent = { ...f.row, status: 'idle' };
    const verify = createDefaultResearchSessionVerifier({ privateDir: f.privateDir, researchLoopRoot, sessionManager: { get: id => id === parent.id ? parent as any : undefined, listAll: () => [parent as any] } });
    await expect(verify({ parent, principal: parent.principalOwner })).rejects.toMatchObject({ statusCode: 409, code: 'research-workbench-charter-binding-stale' });
    const binding = await f.service.charterBinding(f.access);
    await f.service.updateCharterBinding(f.access, { cwd: f.cwd, adoptionId: binding.adoptionId!, expectedBindingRevision: binding.bindingRevision, expectedBoundCharterHash: binding.boundCharterHash!, expectedCharterHash: binding.currentCharterHash!, requestId: 'first-turn-continue' });
    expect(await verify({ parent, principal: parent.principalOwner })).toMatchObject({ cwd: f.cwd, charterHash: binding.currentCharterHash, adoptionId: f.adoptionId, ownerKey: f.ownerKey });
    const file = f.sessionFile.slice(0, -6) + '.meta.json', meta = JSON.parse(fs.readFileSync(file, 'utf8'));
    meta.researchSession = { schema: 'pi-research-session.v1', parentSessionId: 'old-lead', workflowCwd: f.cwd, adoptionId: f.adoptionId, charterHash: f.receipt.charterHash, readOnly: true };
    fs.writeFileSync(file, JSON.stringify(meta));
    await expect(verify({ parent, principal: parent.principalOwner })).rejects.toMatchObject({ statusCode: 409, code: 'research-workbench-assignment-stale' });
    await expect(verify({ parent, principal: { iss: 'issuer', sub: 'other-owner' } })).rejects.toMatchObject({ statusCode: 404, code: 'research-session-parent-not-found' });
  });

  it('serializes reconnect with continuation and detached workflow proof cannot be revived', async () => {
    const f = await fixture(), request = await f.request();
    await f.service.reconnect(f.access);
    await expect(f.service.updateCharterBinding(f.access, request)).rejects.toMatchObject({ code: 'research-charter-binding-not-confirmed' });
    expect((await f.service.charterBinding(f.access)).status).toBe('not-adopted');
  });
});

describe('authenticated target binding HTTP routes', () => {
  async function route() {
    const f = await fixture(), app = Fastify(); apps.push(app);
    const guard = vi.fn(async () => {});
    registerResWorkflowRoutes(app, { networkGuard: guard, privateDir: f.privateDir, researchLoopRoot, knownCwds: () => [f.cwd], history: f.history, historyRoots: () => [], isResolverActive: () => false, service: f.service });
    return { ...f, app, guard };
  }
  it('returns actionable stale state, accepts exact reviewed CAS and returns fresh joined state', async () => {
    const f = await route();
    const url = '/api/res-workflow/charter-binding?cwd=' + encodeURIComponent(f.cwd) + '&sessionId=' + f.sessionId;
    const before = await f.app.inject({ method: 'GET', url });
    expect(before.statusCode).toBe(200); expect(before.json()).toMatchObject({ status: 'stale', canRebind: true, session: { status: 'joined' }, currentCharter: { constraints: ['Read-only source data'], nonGoals: ['No publication'] } });
    const request = await f.request();
    const saved = await f.app.inject({ method: 'POST', url: '/api/res-workflow/charter-binding', payload: request });
    expect(saved.statusCode).toBe(200); expect(saved.json()).toMatchObject({ status: 'current', bindingRevision: 1 });
    const after = await f.app.inject({ method: 'GET', url });
    expect(after.json()).toMatchObject({ status: 'current', session: { status: 'joined' } });
    const conflict = await f.app.inject({ method: 'POST', url: '/api/res-workflow/charter-binding', payload: { ...request, requestId: 'stale-tab' } });
    expect(conflict.statusCode).toBe(409); expect(conflict.json().code).toBe('research-charter-binding-conflict');
    expect(f.guard).toHaveBeenCalledTimes(4);
  });
  it('rejects caller supplied owner or automatic-run fields before invoking a write', async () => {
    const f = await route(), request = await f.request();
    for (const extra of [{ ownerKey: f.ownerKey }, { autoRun: true }, { sessionId: f.sessionId }]) {
      const response = await f.app.inject({ method: 'POST', url: '/api/res-workflow/charter-binding', payload: { ...request, ...extra } });
      expect(response.statusCode).toBe(400); expect(response.json().code).toBe('research-charter-binding-invalid-request');
    }
    const badQuery = await f.app.inject({ method: 'GET', url: '/api/res-workflow/charter-binding?cwd=' + encodeURIComponent(f.cwd) + '&ownerKey=other' });
    expect(badQuery.statusCode).toBe(400);
    expect((await f.read()).status).toBe('stale');
  });
});
