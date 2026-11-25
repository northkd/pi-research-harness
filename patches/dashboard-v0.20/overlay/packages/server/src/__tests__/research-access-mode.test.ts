import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import { createResWorkflowAccessModeService, readSessionResearchAccessMode, type ResearchAccessSession } from '../res-workflow/access-mode-service.js';
import { handleResearchTaskPathRequest } from '../res-workflow/research-task-path-handler.js';
import { ResWorkflowError, type ResWorkflowAccess, type ResWorkflowService } from '../res-workflow/adoption-service.js';
import { registerResWorkflowRoutes } from '../routes/res-workflow-routes.js';

function nativeRoot() {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(cursor, 'extensions/research-loop');
    if (fs.existsSync(path.join(candidate, 'src/access-mode.mjs'))) return candidate;
    const parent = path.dirname(cursor); if (parent === cursor) throw new Error('Native access-mode backend missing'); cursor = parent;
  }
}
const researchLoopRoot = nativeRoot();
const roots: string[] = [], apps: FastifyInstance[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'access-mode-integration-')); roots.push(root);
  const cwd = path.join(root, 'project'), outside = path.join(root, 'outside');
  fs.mkdirSync(cwd); fs.mkdirSync(outside);
  const ownerKey = JSON.stringify(['host', 'inert-operator']), storeDir = path.join(root, 'modes');
  const access = { cwd, ownerKey, write: true, revalidate: vi.fn(async () => undefined) } as unknown as ResWorkflowAccess;
  const options = { researchLoopRoot, storeDir };
  const service = createResWorkflowAccessModeService(options);
  const session = { id: 'parent', cwd, driver: 'pi' };
  const msg = { type: 'path_yolo_request' as const, sessionId: session.id, requestId: 'path-request', path: path.join(outside, 'result.txt'), access: 'w' as const, tool: 'write' };
  const readAccessMode = (row: ResearchAccessSession | undefined) => readSessionResearchAccessMode(row, options);
  const legacy = vi.fn(() => 'auto-allow' as const);
  const deps = { decideAgentPath: legacy, log: () => {} } as never;
  return { root, cwd, outside, storeDir, ownerKey, access, options, service, session, msg, readAccessMode, legacy, deps };
}

describe('persistent operator workspace access mode at native execution boundaries', () => {
  it('needs no adoption, task form or budget and persists across service recreation', async () => {
    const f = fixture();
    expect(await f.service.read(f.access)).toMatchObject({ mode: 'default', revision: null });
    const request = { cwd: f.cwd, mode: 'full-access' as const, expectedRevision: null, requestId: 'select-full-access' };
    const full = await f.service.update(f.access, request);
    expect(full).toMatchObject({ cwd: f.cwd, mode: 'full-access', inheritance: 'workspace-sessions' });
    expect(await createResWorkflowAccessModeService(f.options).read(f.access)).toEqual(full);
    expect(await f.service.update(f.access, request)).toEqual(full);
    await expect(f.service.update(f.access, { ...request, requestId: 'stale-default', mode: 'default' })).rejects.toMatchObject({ statusCode: 409 });
    const normal = await f.service.update(f.access, { ...request, mode: 'default', expectedRevision: full.revision, requestId: 'select-default-mode' });
    expect(normal.mode).toBe('default'); expect(normal.revision).not.toBe(full.revision);
    expect(fs.readdirSync(f.cwd)).toEqual([]);
  });

  it('requires operator write admission and revalidates identity before persistence', async () => {
    const f = fixture(), request = { cwd: f.cwd, mode: 'full-access' as const, expectedRevision: null, requestId: 'operator-only-choice' };
    await expect(f.service.update({ ...f.access, write: false }, request)).rejects.toMatchObject({ statusCode: 403 });
    let checks = 0;
    await expect(f.service.update({ ...f.access, revalidate: async () => { if (++checks === 2) throw new ResWorkflowError(403, 'adoption-identity-expired'); } }, request)).rejects.toMatchObject({ statusCode: 403 });
    expect((await f.service.read(f.access)).mode).toBe('default');
    const alice = { ...f.access, ownerKey: JSON.stringify(['issuer', 'alice']) };
    await f.service.update(alice, request);
    expect((await f.service.read(f.access)).mode).toBe('default');
    expect((await f.service.read({ ...f.access, ownerKey: JSON.stringify(['issuer', 'bob']) })).mode).toBe('default');
  });

  it('parent and freshly registered child use trusted in-memory owner before any JSONL or sidecar exists', async () => {
    const f = fixture(), principalOwner = { iss: 'issuer', sub: 'alice' };
    const full = await f.service.update({ ...f.access, ownerKey: JSON.stringify(['issuer', 'alice']) }, { cwd: f.cwd, mode: 'full-access', expectedRevision: null, requestId: 'inherit-mode-before-file' });
    for (const id of ['main', 'collaborator', 'dispatched-child']) {
      const row = { ...f.session, id, principalOwner };
      expect(await f.readAccessMode(row)).toEqual(full);
      expect((await handleResearchTaskPathRequest(id, { ...f.msg, sessionId: id }, row, f.deps, { readAccessMode: f.readAccessMode })).verdict).toBe('auto-allow');
    }
    expect(fs.readdirSync(f.cwd)).toEqual([]);
    const alias = path.join(f.root, 'session-cwd-alias'); fs.symlinkSync(f.cwd, alias);
    expect(await f.readAccessMode({ ...f.session, cwd: alias, principalOwner })).toEqual(full);
    expect((await f.readAccessMode({ ...f.session, principalOwner: { iss: 'issuer', sub: 'bob' } }))?.mode).toBe('default');
    expect(await f.readAccessMode({ ...f.session, principalOwner, originDeviceId: 'other-host' })).toBeNull();
    expect(await f.readAccessMode({ ...f.session, principalOwner, driver: 'claude' })).toBeNull();
    await f.service.update({ ...f.access, ownerKey: JSON.stringify(['issuer', 'alice']) }, { cwd: f.cwd, mode: 'default', expectedRevision: full.revision, requestId: 'restore-default-everywhere' });
    expect((await f.readAccessMode({ ...f.session, principalOwner }))?.mode).toBe('default');
  });

  it('actual full mode covers file read/write/edit and prior refusal; default restores native gate decisions', async () => {
    const f = fixture();
    const full = await f.service.update(f.access, { cwd: f.cwd, mode: 'full-access', expectedRevision: null, requestId: 'full-path-coverage' });
    const test = { readAccessMode: f.readAccessMode, refused: () => true };
    for (const tool of ['read', 'write', 'edit']) {
      for (const target of [f.msg.path, '/etc/passwd', path.join(os.homedir(), '.ssh/config')]) {
        const message = { ...f.msg, tool, path: target, access: tool === 'read' ? 'r' as const : 'w' as const };
        expect((await handleResearchTaskPathRequest(f.session.id, message, f.session, f.deps, test)).verdict).toBe('auto-allow');
      }
    }
    expect(f.legacy).not.toHaveBeenCalled();
    await f.service.update(f.access, { cwd: f.cwd, mode: 'default', expectedRevision: full.revision, requestId: 'restore-native-file-gate' });
    expect((await handleResearchTaskPathRequest(f.session.id, f.msg, f.session, f.deps, test)).verdict).toBe('refused');
    expect((await handleResearchTaskPathRequest(f.session.id, f.msg, f.session, f.deps, { ...test, refused: () => false })).verdict).toBe('decline');
    expect((await handleResearchTaskPathRequest(f.session.id, { ...f.msg, path: '/etc/passwd' }, f.session, f.deps, test)).verdict).toBe('decline');
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it('never grants a malformed or different-session request, or uses a stale grant on storage failure', async () => {
    const f = fixture();
    await f.service.update(f.access, { cwd: f.cwd, mode: 'full-access', expectedRevision: null, requestId: 'bound-full-access' });
    const readAccessMode = vi.fn(f.readAccessMode);
    for (const change of [{ sessionId: 'foreign' }, { path: 'relative' }, { tool: 'bash' }, { access: 'r' as const }]) {
      expect((await handleResearchTaskPathRequest(f.session.id, { ...f.msg, ...change }, f.session, f.deps, { readAccessMode })).verdict).toBe('decline');
    }
    expect((await handleResearchTaskPathRequest(f.session.id, f.msg, undefined, f.deps, { readAccessMode })).verdict).toBe('decline');
    expect(readAccessMode).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(f.storeDir, fs.readdirSync(f.storeDir).find(name => name.endsWith('.json'))!), '{bad');
    expect((await handleResearchTaskPathRequest(f.session.id, f.msg, f.session, f.deps, { readAccessMode })).verdict).toBe('decline');
    expect(f.legacy).not.toHaveBeenCalled();
  });

  it('retired revoked/expired task records do not gate either mode', async () => {
    const f = fixture();
    const legacy = await import(pathToFileURL(path.join(researchLoopRoot, 'src/task-permissions.mjs')).href);
    fs.mkdirSync(path.join(f.cwd, '.pi/research-loop'), { recursive: true });
    fs.writeFileSync(path.join(f.cwd, '.pi/research-loop/state.json'), JSON.stringify({ schema: 'pi-research-state.v1', charter: { revision: 1, objective: 'Old task', successCriteria: ['Old result'] } }));
    const adoption = await import(pathToFileURL(path.join(researchLoopRoot, 'src/adoption.mjs')).href);
    const binding = { cwd: f.cwd, ownerKey: f.ownerKey, charterHash: adoption.charterHash(f.cwd) };
    const old = legacy.updateTaskPermissions({ ...binding, confirmed: true, action: 'authorize', expectedRevision: null, requestId: 'old-task-grant-expired', task: 'Old task that has now ended', durationHours: 24, now: Date.now() - 25 * 3600000, additionalRoots: [], capabilities: { localExecution: false, delegation: false, publicResearch: false, projectDependencies: false } });
    expect(legacy.readTaskPermissions(binding).status).toBe('expired');
    legacy.updateTaskPermissions({ ...binding, confirmed: true, action: 'revoke', expectedRevision: old.revision, requestId: 'old-task-grant-revoked' });
    const full = await f.service.update(f.access, { cwd: f.cwd, mode: 'full-access', expectedRevision: null, requestId: 'full-with-old-grant' });
    const test = { readAccessMode: f.readAccessMode, refused: () => false };
    expect((await handleResearchTaskPathRequest(f.session.id, f.msg, f.session, f.deps, test)).verdict).toBe('auto-allow');
    await f.service.update(f.access, { cwd: f.cwd, mode: 'default', expectedRevision: full.revision, requestId: 'default-with-old-grant' });
    expect((await handleResearchTaskPathRequest(f.session.id, f.msg, f.session, f.deps, test)).verdict).toBe('decline');
    expect(legacy.readTaskPermissions(binding).status).toBe('revoked');
  });
});

describe('authenticated access-mode route', () => {
  async function route(options: { principal?: { iss: string; sub: string }; owner?: { iss: string; sub: string }; active?: boolean } = {}) {
    const f = fixture(), app = Fastify(); apps.push(app);
    if (options.principal) app.addHook('onRequest', async request => { (request as any).principal = options.principal; });
    const connection = vi.fn(() => { throw new Error('Research adoption must not be consulted'); });
    const service = { connection, dispose: () => {} } as unknown as ResWorkflowService;
    const guard = vi.fn(async () => {});
    registerResWorkflowRoutes(app, { networkGuard: guard, knownCwds: () => [f.cwd], history: () => options.owner ? [{ id: 'owned-session', cwd: f.cwd, principalOwner: options.owner }] : [], historyRoots: () => [], researchLoopRoot, isResolverActive: () => options.active ?? false, service });
    return { ...f, app, guard, connection };
  }
  it('canonicalizes a symlink input for both read and update without research setup', async () => {
    const f = await route(), alias = path.join(f.root, 'project-alias'); fs.symlinkSync(f.cwd, alias);
    const read = await f.app.inject({ method: 'GET', url: '/api/res-workflow/access-mode?cwd=' + encodeURIComponent(alias) });
    expect(read.statusCode).toBe(200); expect(read.json()).toMatchObject({ cwd: f.cwd, mode: 'default' });
    const updated = await f.app.inject({ method: 'POST', url: '/api/res-workflow/access-mode', payload: { cwd: alias, mode: 'full-access', expectedRevision: null, requestId: 'alias-operator-full' } });
    expect(updated.statusCode).toBe(200); expect(updated.json()).toMatchObject({ cwd: f.cwd, mode: 'full-access' });
    const canonical = await f.app.inject({ method: 'GET', url: '/api/res-workflow/access-mode?cwd=' + encodeURIComponent(f.cwd) });
    expect(canonical.json()).toEqual(updated.json());
    expect(f.guard).toHaveBeenCalledTimes(3); expect(f.connection).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.cwd)).toEqual([]);
  });
  it('retains authentication and workspace ownership admission and rejects owner or scope riders', async () => {
    const f = await route({ active: true, principal: { iss: 'issuer', sub: 'alice' }, owner: { iss: 'issuer', sub: 'bob' } });
    expect((await f.app.inject({ method: 'GET', url: '/api/res-workflow/access-mode?cwd=' + encodeURIComponent(f.cwd) })).statusCode).toBe(404);
    expect((await f.app.inject({ method: 'POST', url: '/api/res-workflow/access-mode', payload: { cwd: f.cwd, mode: 'full-access', expectedRevision: null, requestId: 'foreign-owner-request' } })).statusCode).toBe(404);
    const local = await route();
    expect((await local.app.inject({ method: 'POST', url: '/api/res-workflow/access-mode', payload: { cwd: local.cwd, mode: 'full-access', expectedRevision: null, requestId: 'owner-rider-request', ownerKey: 'alice' } })).statusCode).toBe(400);
    expect((await local.app.inject({ method: 'GET', url: '/api/res-workflow/access-mode?cwd=' + encodeURIComponent(local.cwd) + '&path=/other' })).statusCode).toBe(400);
  });
});
