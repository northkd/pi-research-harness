import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertResearchTaskDelegation, createResWorkflowTaskPermissionService, decideResearchTaskPath } from '../res-workflow/task-permission-service.js';
import type { ResWorkflowAccess } from '../res-workflow/adoption-service.js';
import { createResearchDispatchService, createResearchDispatchStore } from '../res-workflow/research-dispatch-service.mjs';
import { ResearchSessionError } from '../res-workflow/research-session-service.mjs';
import { handleResearchTaskPathRequest } from '../res-workflow/research-task-path-handler.js';

const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const json = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
function nativeRoot() {
  let cursor = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(cursor, 'extensions/research-loop');
    if (fs.existsSync(path.join(candidate, 'src/task-permissions.mjs'))) return candidate;
    const parent = path.dirname(cursor); if (parent === cursor) throw new Error('Native research-loop fixture backend missing'); cursor = parent;
  }
}
const researchLoopRoot = nativeRoot();
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'task-gate-integration-')); roots.push(root);
  const cwd = path.join(root, 'project'), storeDir = path.join(root, 'grants'), privateDir = path.join(root, 'adoptions'), data = path.join(root, 'data'), outside = path.join(root, 'outside');
  for (const dir of [cwd, data, outside]) fs.mkdirSync(dir);
  json(path.join(cwd, '.pi/research-loop/state.json'), { schema: 'pi-research-state.v1', charter: { revision: 1, objective: 'Synthetic scope', successCriteria: ['Return results'] } });
  const adoption = await import(pathToFileURL(path.join(researchLoopRoot, 'src/adoption.mjs')).href);
  const permissions = await import(pathToFileURL(path.join(researchLoopRoot, 'src/task-permissions.mjs')).href);
  const ownerKey = JSON.stringify(['host', 'inert-operator']), charterHash = adoption.charterHash(cwd);
  const b = { cwd, storeDir, charterHash, ownerKey };
  const request = { cwd, confirmed: true as const, action: 'authorize' as const, expectedRevision: null, requestId: 'synthetic-authorization-1', task: 'Run synthetic computations', durationHours: 24 as const, capabilities: { localExecution: true, delegation: true, publicResearch: true, projectDependencies: false }, additionalRoots: [data] };
  const adoptionId = 'adopt-' + hash(cwd).slice(0, 24), confirmationHash = 'sha256:' + hash('confirmation');
  const location = path.join(privateDir, hash(ownerKey), hash(cwd));
  json(path.join(location, 'adopted.json'), { confirmed: true, id: adoptionId, confirmationHash });
  json(path.join(location, adoptionId + '.json'), { schema: 'pi-res-workflow-operation.v1', ownerKey, cwd, adoption: { id: adoptionId, cwd, status: 'confirmed' } });
  json(path.join(cwd, '.pi/research-loop/adoptions', adoptionId, 'confirmation.json'), { schema: 'pi-research-adoption-confirmation.v1', adoptionId, confirmationHash, charterHash, autoRun: false });
  const join = (id: string) => {
    const sessionFile = path.join(root, id + '.jsonl');
    fs.writeFileSync(sessionFile, JSON.stringify({ type: 'session', id, cwd }) + '\n');
    json(sessionFile.slice(0, -6) + '.meta.json', { resWorkflow: { canonicalCwd: cwd, joinedAt: '2026-01-01T00:00:00.000Z', via: 'adoption' } });
    return { id, cwd, sessionFile, driver: 'pi' };
  };
  return { cwd, data, outside, b, request, permissions, join, adoptionId, options: { researchLoopRoot, contextOptions: { storeDir, privateDir } }, storeDir, ownerKey };
}

describe('real joined research authorization at the native path and queued-dispatch boundaries', () => {
  it('uses the real context verifier, canonical paths, scope and per-launch live revocation', async () => {
    const f = await fixture(), parent = f.join('parent'), child = f.join('child');
    const grant = f.permissions.updateTaskPermissions({ ...f.request, ...f.b });
    for (const session of [parent, child]) {
      expect(await decideResearchTaskPath(session, path.join(f.data, 'result.txt'), 'w', 'write', f.options)).toBe('auto-allow');
      expect((await assertResearchTaskDelegation(session, f.options))?.revision).toBe(grant.revision);
    }
    expect(await decideResearchTaskPath(child, path.join(f.outside, 'result.txt'), 'w', 'write', f.options)).toBe('task-blocked');
    const limited = f.permissions.updateTaskPermissions({ ...f.request, ...f.b, capabilities: { ...f.request.capabilities, localExecution: false, delegation: false }, requestId: 'limit-live-grant', expectedRevision: grant.revision });
    expect(await decideResearchTaskPath(child, path.join(f.data, 'input.txt'), 'r', 'read', f.options)).toBe('auto-allow');
    expect(await decideResearchTaskPath(child, path.join(f.data, 'result.txt'), 'w', 'write', f.options)).toBe('task-blocked');
    await expect(assertResearchTaskDelegation(parent, f.options)).rejects.toThrow('delegation-out-of-scope');
    f.permissions.updateTaskPermissions({ ...f.b, action: 'revoke', confirmed: true, requestId: 'revoke-live-grant', expectedRevision: limited.revision });
    expect(await decideResearchTaskPath(child, path.join(f.data, 'input.txt'), 'r', 'read', f.options)).toBe('task-blocked');
    await expect(assertResearchTaskDelegation(parent, f.options)).rejects.toThrow('authorization-revoked');
    expect(f.permissions.readTaskPermissions(f.b).blockers.some((b: { code: string }) => b.code === 'authorization-revoked')).toBe(true);
  });
  it('expires, rejects stale membership and does not give an unjoined session the task grant', async () => {
    const f = await fixture(), child = f.join('child');
    f.permissions.updateTaskPermissions({ ...f.b, ...f.request, now: Date.now() - 25 * 3600000 });
    expect(await decideResearchTaskPath(child, path.join(f.data, 'input.txt'), 'r', 'read', f.options)).toBe('task-blocked');
    await expect(assertResearchTaskDelegation(child, f.options)).rejects.toThrow('authorization-expired');
    json(child.sessionFile.slice(0, -6) + '.meta.json', {});
    expect(await decideResearchTaskPath(child, path.join(f.data, 'input.txt'), 'r', 'read', f.options)).toBeNull();
    await expect(assertResearchTaskDelegation(child, f.options)).rejects.toThrow('context-unavailable');
  });
  it('never converts a known task denial to legacy auto-allow when diagnostic persistence fails', async () => {
    for (const status of ['active', 'expired', 'revoked']) {
      const f = await fixture(), session = f.join('parent');
      const grant = f.permissions.updateTaskPermissions({ ...f.b, ...f.request, ...(status === 'expired' ? { now: Date.now() - 25 * 3600000 } : {}) });
      if (status === 'revoked') f.permissions.updateTaskPermissions({ ...f.b, action: 'revoke', confirmed: true, requestId: 'revoked-before-lock', expectedRevision: grant.revision });
      // A real live-owner lock permits reads but prevents diagnostic record writes.
      json(path.join(f.cwd, '.pi/research-loop/.charter-configure.lock'), { schema: 'pi-research-charter-lock.v1', pid: process.pid, nonce: 'held-by-independent-transaction' });
      expect(() => f.permissions.recordTaskPermissionBlock({ ...f.b, code: 'synthetic', tool: 'read' })).toThrow('busy');
      const target = path.join(status === 'active' ? f.outside : f.data, 'result.txt');
      expect(await decideResearchTaskPath(session, target, 'r', 'read', f.options)).toBe('task-blocked');
      const message = { type: 'path_yolo_request' as const, sessionId: session.id, requestId: 'known-denial', path: target, access: 'r' as const, tool: 'read' };
      const result = await handleResearchTaskPathRequest(session.id, message, session, {} as never, {
        refused: () => false,
        decideTaskPath: (...args) => decideResearchTaskPath(args[0], args[1], args[2], args[3], f.options),
      });
      expect(result.verdict).toBe('task-blocked');
    }
  });
  it('rechecks the real grant before a queued launch and does not retain a reservation for a known refusal', async () => {
    for (const status of ['revoked', 'delegation-disabled', 'expired']) {
      const f = await fixture(), parent = f.join('parent');
      const grant = f.permissions.updateTaskPermissions({ ...f.b, ...f.request });
      let admissionAttempts = 0;
      const store = createResearchDispatchStore(path.join(path.dirname(f.cwd), 'dispatch'));
      const dispatcher = createResearchDispatchService({
        store, getSession: id => id === parent.id ? parent : undefined, listSessions: () => [parent],
        authorize: async () => ({ parent, cwd: f.cwd, charterHash: f.b.charterHash, adoptionId: f.adoptionId, ownerKey: f.ownerKey }),
        beforeLaunch: async ({ parent }) => { await assertResearchTaskDelegation(parent, f.options); },
        // Hold the accepted plan at the ordinary capacity boundary without creating a process.
        createSession: async () => { admissionAttempts++; throw new ResearchSessionError(409, 'research-session-concurrency-limit'); },
      });
      try {
        const started = await dispatcher.handle({ body: { sessionId: parent.id, action: 'plan', planId: 'queued-grant-test', concurrency: 1, tasks: [{ id: 'leaf', role: 'researcher', task: 'Run the synthetic analysis', stage: '2-experiment' }, { id: 'review', role: 'critic', task: 'Review its reported result', stage: '3-review', dependsOn: ['leaf'] }] } });
        expect(started.plans[0].tasks[0].status).toBe('queued');
        expect(admissionAttempts).toBe(1);
        if (status === 'revoked') f.permissions.updateTaskPermissions({ ...f.b, action: 'revoke', confirmed: true, requestId: 'revoke-while-queued', expectedRevision: grant.revision });
        else f.permissions.updateTaskPermissions({ ...f.b, ...f.request, requestId: 'change-while-queued', expectedRevision: grant.revision,
          ...(status === 'expired' ? { now: Date.now() - 25 * 3600000 } : { capabilities: { ...f.request.capabilities, delegation: false } }) });
        await dispatcher.tick();
        const [result] = store.readAll();
        expect(result.status).toBe('blocked');
        expect(result.tasks[0].status).toBe('blocked');
        expect(result.tasks[0].error).toContain(status === 'delegation-disabled' ? 'delegation-out-of-scope' : `authorization-${status}`);
        expect(admissionAttempts, 'permission refusal happens before another session admission').toBe(1);
        expect(dispatcher.unregisteredReservations()).toEqual([]);
        expect(result.tasks[0].spawnToken).toBeUndefined();
        expect(result.tasks[0].processUnconfirmed).not.toBe(true);
      } finally { dispatcher.dispose(); }
    }
  });
  it('checks connection adoption and operator write admission on the service route', async () => {
    const f = await fixture(); let adopted = false;
    const service = createResWorkflowTaskPermissionService({ researchLoopRoot, storeDir: f.storeDir, connection: async () => ({ adopted, cwd: f.cwd }) as never });
    const access = { cwd: f.cwd, ownerKey: f.ownerKey, write: true, revalidate: async () => undefined } as ResWorkflowAccess;
    await expect(service.read(access)).rejects.toThrow('not-adopted');
    adopted = true;
    expect((await service.update(access, f.request)).status).toBe('active');
    await expect(service.update({ ...access, write: false }, f.request)).rejects.toThrow('write-required');
  });
  it('checks socket identity, protected locations and prior refusal before using a task grant', async () => {
    const f = await fixture(), session = f.join('parent');
    f.permissions.updateTaskPermissions({ ...f.b, ...f.request });
    const msg = { type: 'path_yolo_request' as const, sessionId: session.id, requestId: 'path-request', path: path.join(f.data, 'result.txt'), access: 'w' as const, tool: 'write' };
    let calls = 0;
    const test = { refused: () => false, decideTaskPath: async (...args: Parameters<typeof decideResearchTaskPath>) => { calls++; return decideResearchTaskPath(args[0], args[1], args[2], args[3], f.options); } };
    const deps = {} as never; // These outcomes must not reach the legacy YOLO fallback.
    expect((await handleResearchTaskPathRequest(session.id, msg, session, deps, test)).verdict).toBe('auto-allow');
    expect((await handleResearchTaskPathRequest(session.id, { ...msg, sessionId: 'different' }, session, deps, test)).verdict).toBe('decline');
    expect((await handleResearchTaskPathRequest(session.id, msg, session, deps, { ...test, refused: () => true })).verdict).toBe('refused');
    expect(calls).toBe(1);
    expect((await handleResearchTaskPathRequest(session.id, { ...msg, path: '/etc/passwd' }, session, deps, test)).verdict).toBe('decline');
    expect(calls).toBe(1);
  });
});
