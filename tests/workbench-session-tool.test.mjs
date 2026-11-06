import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import {
  createResearchSessionTool,
  readDashboardLocalAuth,
  registerWorkbenchSessionTool,
} from '../extensions/research-loop/src/workbench-session-tool.mjs';
import {
  createResearchSessionService,
  ResearchSessionError,
} from '../patches/dashboard-v0.20/overlay/packages/server/src/res-workflow/research-session-service.mjs';

const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const sharedModule = path.join(repo, 'patches/dashboard-v0.20/overlay/packages/shared/src/research-session.ts');
const CHARTER = 'sha256:' + 'a'.repeat(64);
const ADOPTION = 'adopt-' + 'b'.repeat(24);
const cleanups = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function context(sessionId = 'parent-1', cwd = '/workspace') {
  return { cwd, sessionManager: { getSessionId: () => sessionId, getSessionFile: () => '/sessions/parent-1.jsonl' } };
}

function response(body, ok = true, status = 200) {
  const text = JSON.stringify(body);
  return {
    ok, status,
    headers: { get: () => String(Buffer.byteLength(text, 'utf8')) },
    text: async () => text,
  };
}

function streamingResponse(chunks, declared = null) {
  let index = 0;
  return {
    ok: true, status: 200,
    headers: { get: name => name === 'content-length' ? declared : null },
    body: {
      getReader: () => ({
        read: async () => index < chunks.length ? { done: false, value: Buffer.from(chunks[index++]) } : { done: true },
        cancel: async () => {},
        releaseLock: () => {},
      }),
    },
  };
}

function captureTool(options) {
  let tool;
  registerWorkbenchSessionTool({ registerTool: value => { tool = value; } }, options);
  assert.ok(tool);
  return tool;
}

function fakeEndpoint(overrides = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body) });
    return response({
      status: 'spawned', spawnToken: 'spawn-token-1', role: 'literature', stage: '1-idea',
      workflowCwd: '/workspace', registration: 'pending', initialPromptQueued: true,
      provenance: { schema: 'pi-research-session.v1' },
      ...overrides.reply,
    });
  };
  return { calls, fetchImpl };
}

describe('native research_session tool', () => {
  it('registers a real tool and sends only context-derived parent routing', async () => {
    const endpoint = fakeEndpoint();
    const tool = captureTool({
      readContext: async () => ({ sessionId: 'parent-1', charterHash: CHARTER }),
      resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }),
      fetchImpl: endpoint.fetchImpl,
      requestId: () => 'request-12345678',
    });
    assert.equal(tool.name, 'research_session');
    assert.match(tool.description, /top-level/i);
    assert.match(tool.description, /subagent tool/i);
    const result = await tool.execute('call-1', {
      role: 'literature', task: 'Survey recent evidence', stage: '1-idea',
      // Even if a caller slips these in, the tool never forwards them.
      sessionId: 'attacker', cwd: '/other', url: 'http://evil.example', model: 'bad/model',
    }, undefined, undefined, context());
    assert.equal(result.details.status, 'spawned');
    assert.equal(endpoint.calls.length, 1);
    assert.equal(endpoint.calls[0].url, 'http://127.0.0.1:8000/api/res-workflow/participants/spawn');
    assert.equal(endpoint.calls[0].init.redirect, 'error');
    assert.ok(endpoint.calls[0].init.signal);
    assert.deepEqual(endpoint.calls[0].body, {
      parentSessionId: 'parent-1', role: 'literature', task: 'Survey recent evidence',
      stage: '1-idea', requestId: 'request-12345678',
    });
    assert.equal('cwd' in endpoint.calls[0].body, false);
    assert.equal('model' in endpoint.calls[0].body, false);
    assert.equal(JSON.stringify(result).includes('secret-token'), false);
    assert.equal(result.details.role, 'literature');
    assert.equal(result.details.initialPromptQueued, true);
  });

  it('refuses an unjoined or mismatched parent before any network call', async () => {
    const endpoint = fakeEndpoint();
    const tool = captureTool({
      readContext: async ctx => ctx.sessionManager.getSessionId() === 'parent-1' ? null : { sessionId: 'other', charterHash: CHARTER },
      resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }),
      fetchImpl: endpoint.fetchImpl,
    });
    const unjoined = await tool.execute('call-1', { role: 'literature', task: 'Task', stage: '1-idea' }, undefined, undefined, context());
    assert.equal(unjoined.details.error, 'research-session-parent-not-joined');
    assert.equal(endpoint.calls.length, 0);
    const mismatch = await tool.execute('call-2', { role: 'literature', task: 'Task', stage: '1-idea' }, undefined, undefined, context('other-parent'));
    assert.equal(mismatch.details.error, 'research-session-parent-not-joined');
    assert.equal(endpoint.calls.length, 0);
  });

  it('rejects a missing or malformed charter proof before reading credentials or sending a request', async () => {
    const endpoint = fakeEndpoint();
    let authReads = 0;
    for (const charterHash of [undefined, '', 'not-a-hash', 1]) {
      const tool = captureTool({
        readContext: async () => ({ sessionId: 'parent-1', charterHash }),
        resolveAuth: async () => { authReads++; return { baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }; },
        fetchImpl: endpoint.fetchImpl,
      });
      assert.equal((await tool.execute('call', { role: 'literature', task: 'Task', stage: '1-idea' }, undefined, undefined, context())).details.error, 'research-session-parent-not-joined');
    }
    assert.equal(authReads, 0);
    assert.equal(endpoint.calls.length, 0);
  });

  it('propagates a backend membership refusal and bounds concurrent tool calls', async () => {
    const refusal = captureTool({
      readContext: async () => ({ sessionId: 'parent-1', charterHash: CHARTER }),
      resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }),
      fetchImpl: async () => response({ success: false, code: 'research-session-parent-not-joined' }, false, 404),
    });
    const refused = await refusal.execute('call-1', { role: 'literature', task: 'Task', stage: '1-idea' }, undefined, undefined, context());
    assert.equal(refused.isError, true);
    assert.equal(refused.details.error, 'research-session-parent-not-joined');

    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const endpoint = fakeEndpoint();
    const bounded = captureTool({
      maxPerParent: 1,
      readContext: async () => ({ sessionId: 'parent-1', charterHash: CHARTER }),
      resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }),
      fetchImpl: async (url, init) => { endpoint.calls.push({ url: String(url), init }); await gate; return endpoint.fetchImpl(url, init); },
    });
    const first = bounded.execute('call-1', { role: 'literature', task: 'One', stage: '1-idea' }, undefined, undefined, context());
    const second = await bounded.execute('call-2', { role: 'literature', task: 'Two', stage: '1-idea' }, undefined, undefined, context());
    assert.equal(second.details.error, 'research-session-concurrency-limit');
    release();
    assert.equal((await first).details.status, 'spawned');
  });

  it('honors caller cancellation and bounds the response body', async () => {
    const cancelled = captureTool({
      readContext: async () => ({ sessionId: 'parent-1', charterHash: CHARTER }),
      resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }),
      fetchImpl: async () => { throw new Error('must not fetch after abort'); },
    });
    const controller = new AbortController();
    controller.abort();
    const stopped = await cancelled.execute('call-1', { role: 'literature', task: 'Task', stage: '1-idea' }, controller.signal, undefined, context());
    assert.equal(stopped.details.error, 'research-session-cancelled');

    const oversized = captureTool({
      readContext: async () => ({ sessionId: 'parent-1', charterHash: CHARTER }),
      resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }),
      fetchImpl: async () => streamingResponse(['x'.repeat(40_000), 'y'.repeat(40_000)]),
    });
    const bound = await oversized.execute('call-1', { role: 'literature', task: 'Task', stage: '1-idea' }, undefined, undefined, context());
    assert.equal(bound.details.error, 'research-session-response-too-large');

    const declared = captureTool({
      readContext: async () => ({ sessionId: 'parent-1', charterHash: CHARTER }),
      resolveAuth: async () => ({ baseUrl: 'http://127.0.0.1:8000', token: 'secret-token' }),
      fetchImpl: async () => streamingResponse([], '100000'),
    });
    const rejected = await declared.execute('call-1', { role: 'literature', task: 'Task', stage: '1-idea' }, undefined, undefined, context());
    assert.equal(rejected.details.error, 'research-session-response-too-large');
  });

  it('reads only secure fixed local auth paths', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'research-auth-'));
    cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
    fs.mkdirSync(path.join(home, '.pi', 'dashboard', 'local'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(home, '.pi', 'dashboard', 'config.json'), JSON.stringify({ port: 8000, bindHost: '127.0.0.1' }));
    fs.writeFileSync(path.join(home, '.pi', 'dashboard', 'local', 'token'), 'local-token-value', { mode: 0o600 });
    assert.deepEqual(readDashboardLocalAuth({ home }), { baseUrl: 'http://127.0.0.1:8000', token: 'local-token-value' });
    fs.chmodSync(path.join(home, '.pi', 'dashboard', 'local', 'token'), 0o644);
    assert.throws(() => readDashboardLocalAuth({ home }), /unsafe-dashboard-token/);

    const linkedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'research-auth-link-'));
    const targetHome = fs.mkdtempSync(path.join(os.tmpdir(), 'research-auth-target-'));
    cleanups.push(() => fs.rmSync(linkedHome, { recursive: true, force: true }));
    cleanups.push(() => fs.rmSync(targetHome, { recursive: true, force: true }));
    const targetLocal = path.join(targetHome, '.pi', 'dashboard', 'local');
    fs.mkdirSync(targetLocal, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(targetHome, '.pi', 'dashboard', 'config.json'), JSON.stringify({ port: 8000 }));
    fs.writeFileSync(path.join(targetLocal, 'token'), 'local-token-value', { mode: 0o600 });
    fs.symlinkSync(path.join(targetHome, '.pi'), path.join(linkedHome, '.pi'), 'dir');
    assert.throws(() => readDashboardLocalAuth({ home: linkedHome }), /unsafe-dashboard-auth-path/);
  });
});

const LOCAL_OPERATOR = Object.freeze({ iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' });

function serviceFixture(overrides = {}) {
  const calls = { prepare: [], enqueue: [], spawn: [], refs: [], owners: [] };
  const parent = overrides.parent ?? {
    id: 'parent-1', cwd: '/workspace', principalOwner: { iss: 'issuer', sub: 'owner' },
    sessionFile: '/sessions/parent-1.jsonl',
  };
  const deps = {
    getSession: id => id === parent.id ? parent : undefined,
    listSessions: () => overrides.sessions ?? [],
    verifyParent: async input => {
      if (overrides.verifyError) throw new ResearchSessionError(404, overrides.verifyError);
      return { cwd: parent.cwd, charterHash: CHARTER, adoptionId: ADOPTION, ownerKey: overrides.ownerKey ?? JSON.stringify(['issuer', 'owner']) };
    },
    prepareSpawn: async (cwd, identity, verified) => {
      calls.prepare.push({ cwd, identity, verified });
      return {
        resWorkflow: { canonicalCwd: cwd, joinedAt: '2026-11-04T00:00:00.000Z', via: 'spawn' },
        resWorkflowBinding: { ownerKey: verified.ownerKey ?? 'owner-key', identity, resolverActive: true },
      };
    },
    pendingPluginRefRegistry: {
      file: (token, ref, owner) => { calls.refs.push({ token, ref, owner }); return overrides.refFile !== false; },
      remove: token => { calls.refs.push({ removed: token }); },
    },
    pendingPrincipalOwnerRegistry: {
      file: (token, owner) => { calls.owners.push({ token, owner }); return overrides.ownerFile !== false; },
      remove: token => { calls.owners.push({ removed: token }); },
    },
    initialPrompts: {
      enqueue: (cwd, prompt, token) => { calls.enqueue.push({ cwd, prompt, token }); return overrides.enqueue !== false; },
      remove: (cwd, token) => { calls.enqueue.push({ removed: token, cwd }); return true; },
    },
    spawn: async (cwd, options) => {
      calls.spawn.push({ cwd, options });
      return overrides.spawnResult ?? { success: true };
    },
    spawnStrategy: () => 'headless',
    // Same reference-only semantics as identity/session-access.ts: a wire
    // principal carrying the reserved issuer is NOT the break-glass operator.
    isLocalOperator: principal => principal === LOCAL_OPERATOR,
    now: () => new Date('2026-11-04T00:00:00.000Z'),
    mintToken: () => 'spawn-token-1234',
    ...overrides.deps,
  };
  return { deps, calls, parent, service: createResearchSessionService(deps) };
}

const request = (overrides = {}) => ({
  body: { parentSessionId: 'parent-1', role: 'experiment', task: 'Run the bounded pilot', stage: '2-experiment', requestId: 'request-12345678', ...overrides.body },
  principal: overrides.principal === undefined ? { iss: 'issuer', sub: 'owner' } : overrides.principal,
});

describe('research-session backend', () => {
  it('creates a top-level joined session with persisted provenance and one token-bound prompt', async () => {
    const f = serviceFixture();
    const result = await f.service.create(request());
    assert.equal(result.status, 'spawned');
    assert.equal(result.registration, 'pending');
    assert.equal(result.spawnToken, 'spawn-token-1234');
    assert.equal(result.role, 'experiment');
    assert.equal(result.stage, '2-experiment');
    assert.equal(f.calls.prepare.length, 1);
    assert.equal(f.calls.prepare[0].cwd, '/workspace');
    assert.equal(f.calls.prepare[0].verified.ownerKey, JSON.stringify(['issuer', 'owner']));
    assert.equal(f.calls.prepare[0].verified.researchSession.parentSessionId, 'parent-1');
    assert.equal(f.calls.prepare[0].verified.researchSession.task, 'Run the bounded pilot');
    assert.equal(f.calls.refs[0].owner, 'res-workflow');
    assert.equal(f.calls.refs[0].ref.researchSession.creatorAgent, 'research_session');
    assert.deepEqual(f.calls.owners[0].owner, { iss: 'issuer', sub: 'owner' });
    assert.equal(f.calls.enqueue.length, 1);
    assert.equal(f.calls.enqueue[0].token, 'spawn-token-1234');
    assert.match(f.calls.enqueue[0].prompt, /Role: experiment/);
    assert.match(f.calls.enqueue[0].prompt, /Run the bounded pilot/);
    assert.equal(f.calls.spawn[0].options.spawnToken, 'spawn-token-1234');
    assert.equal(f.calls.spawn[0].cwd, '/workspace');
  });

  it('refuses an unjoined parent without mutating registries, prompts or spawning', async () => {
    const f = serviceFixture({ verifyError: 'research-session-parent-not-joined' });
    await assert.rejects(f.service.create(request()), error => error.code === 'research-session-parent-not-joined');
    assert.deepEqual(f.calls.prepare, []);
    assert.deepEqual(f.calls.refs, []);
    assert.deepEqual(f.calls.owners, []);
    assert.deepEqual(f.calls.enqueue, []);
    assert.deepEqual(f.calls.spawn, []);
  });

  it('refuses a different owner or a changed charter without side effects', async () => {
    const wrongOwner = serviceFixture();
    await assert.rejects(
      wrongOwner.service.create(request({ principal: { iss: 'issuer', sub: 'other' } })),
      error => error.code === 'research-session-parent-not-found',
    );
    assert.deepEqual(wrongOwner.calls.prepare, []);
    assert.deepEqual(wrongOwner.calls.spawn, []);

    const changed = serviceFixture({
      deps: { verifyParent: async () => { throw new ResearchSessionError(409, 'research-session-charter-changed'); } },
    });
    await assert.rejects(changed.service.create(request()), error => error.code === 'research-session-charter-changed');
    assert.deepEqual(changed.calls.prepare, []);
    assert.deepEqual(changed.calls.spawn, []);
  });

  it('does not let a lookalike local-operator principal inherit another owner\'s parent', async () => {
    // A remote principal can send any JSON, including the reserved issuer name.
    // Only the in-process LOCAL_OPERATOR reference passes isLocalOperator().
    const spoofed = serviceFixture();
    await assert.rejects(
      spoofed.service.create(request({ principal: { iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' } })),
      error => error.code === 'research-session-parent-not-found',
    );
    assert.deepEqual(spoofed.calls.prepare, []);
    assert.deepEqual(spoofed.calls.spawn, []);
  });

  it('rejects caller-supplied project/model/url fields and bounds concurrency', async () => {
    const invalid = serviceFixture();
    await assert.rejects(
      invalid.service.create({ body: { ...request().body, cwd: '/etc' }, principal: request().principal }),
      error => error.statusCode === 400 && error.code === 'research-session-unknown-field',
    );
    assert.deepEqual(invalid.calls.prepare, []);
    assert.deepEqual(invalid.calls.enqueue, []);
    assert.deepEqual(invalid.calls.spawn, []);

    const active = serviceFixture({
      sessions: Array.from({ length: 4 }, (_, index) => ({
        id: `child-${index}`, status: 'active', researchSession: { parentSessionId: 'parent-1' },
      })),
    });
    await assert.rejects(active.service.create(request()), error => error.code === 'research-session-concurrency-limit');
    assert.deepEqual(active.calls.prepare, []);

    const capacity = serviceFixture({
      sessions: Array.from({ length: 8 }, (_, index) => ({
        id: `child-${index}`, status: 'active', researchSession: { parentSessionId: `other-${index}` },
      })),
    });
    await assert.rejects(capacity.service.create(request()), error => error.code === 'research-session-capacity-limit');
    assert.deepEqual(capacity.calls.prepare, []);
  });

  it('counts a registered child once instead of both active and in-flight', async () => {
    const rows = [];
    let number = 0;
    const f = serviceFixture({ sessions: rows, deps: {
      maxPerParent: 2, maxTotal: 2, availableMemory: () => 8 * 1024 ** 3,
      mintToken: () => 'spawn-token-' + (++number),
      spawn: async (_cwd, options) => {
        rows.push({ id: 'child-' + number, status: 'idle', researchSession: { parentSessionId: 'parent-1', spawnToken: options.spawnToken } });
        return { success: true };
      },
    } });
    assert.equal((await f.service.create(request({ body: { requestId: 'registered-one' } }))).status, 'spawned');
    assert.equal((await f.service.create(request({ body: { requestId: 'registered-two' } }))).status, 'spawned');
    await assert.rejects(f.service.create(request({ body: { requestId: 'registered-three' } })), error => error.code === 'research-session-concurrency-limit');
    assert.equal(rows.length, 2);
  });

  it('replays a stable request without launching a duplicate and rejects a changed payload', async () => {
    const f = serviceFixture();
    const first = await f.service.create(request());
    const replay = await f.service.create(request());
    assert.deepEqual(replay, first);
    assert.equal(f.calls.spawn.length, 1);
    await assert.rejects(f.service.create(request({ body: { task: 'A different assignment under the same key' } })), error => error.code === 'research-session-idempotency-conflict');
    assert.equal(f.calls.spawn.length, 1);
  });

  it('rechecks permissions immediately before spawn and cleans a known preflight refusal', async () => {
    let allowed = false, attempts = 0;
    const f = serviceFixture({ deps: {
      maxPerParent: 1, maxTotal: 1,
      beforeSpawn: async ({ parent, body }) => {
        attempts++;
        assert.equal(parent.id, 'parent-1');
        assert.equal(body.role, 'experiment');
        if (!allowed) throw Object.assign(new Error('revoked'), { code: 'task-permissions-authorization-revoked' });
      },
    } });
    await assert.rejects(f.service.create(request()), error => error instanceof ResearchSessionError && error.code === 'task-permissions-authorization-revoked');
    assert.equal(f.calls.spawn.length, 0);
    assert.equal(f.calls.enqueue.at(-1).removed, 'spawn-token-1234');
    assert.equal(f.calls.refs.at(-1).removed, 'spawn-token-1234');
    allowed = true;
    assert.equal((await f.service.create(request())).status, 'spawned');
    assert.equal(attempts, 2);
    assert.equal(f.calls.spawn.length, 1);
  });

  it('cleans up its own token-bound prompt and refs when the launch fails', async () => {
    const f = serviceFixture({ spawnResult: { success: false, code: 'SPAWN_ERRNO' } });
    await assert.rejects(f.service.create(request()), error => error.code === 'research-session-spawn-failed');
    assert.equal(f.calls.enqueue.at(-1).removed, 'spawn-token-1234');
    assert.equal(f.calls.refs.at(-1).removed, 'spawn-token-1234');
    assert.equal(f.calls.owners.at(-1).removed, 'spawn-token-1234');
  });
});

describe('shared research-session metadata projection', () => {
  it('derives a relation only from real persisted ids and never fabricates executions', async () => {
    const shared = await import(sharedModule);
    const provenance = {
      schema: 'pi-research-session.v1', parentSessionId: 'parent-1', creatorSessionId: 'parent-1',
      creatorAgent: 'research_session', role: 'review', task: 'Check claims', stage: '3-review',
      charterHash: CHARTER, adoptionId: ADOPTION, workflowCwd: '/workspace',
      spawnToken: 'spawn-token-1234', createdAt: '2026-11-04T00:00:00.000Z',
      origin: 'research_session', relation: 'dispatch',
    };
    assert.equal(shared.isResearchSessionProvenance(provenance), true);
    const relation = shared.researchSessionRelation(provenance, {
      parentExecutionId: 'session-parent-1', childExecutionId: 'session-child-1',
    });
    assert.deepEqual(relation, {
      id: 'research-session:spawn-token-1234', fromExecutionId: 'session-parent-1', toExecutionId: 'session-child-1',
      kind: 'dispatch', evidence: { source: 'explicit-record', eventId: 'spawn-token-1234' },
    });
    const projected = shared.projectResearchSession({ id: 'child-1', pluginRefs: { 'res-workflow': { researchSession: provenance } } });
    assert.equal(projected.provenance.task, 'Check claims');
    assert.equal(
      shared.projectResearchSession({ id: 'child-1', pluginRefs: { 'research-session': { researchSession: provenance } } }).provenance.role,
      'review',
    );
    assert.deepEqual(
      shared.deriveResearchSessionRelations(
        [{ id: 'session-parent-1', sessionId: 'parent-1' }, { id: 'session-child-1', sessionId: 'child-1' }],
        [{ id: 'child-1', researchSession: provenance }],
      ),
      [relation],
      'raw session ids are mapped to the actual workbench execution ids',
    );
    assert.deepEqual(
      shared.deriveResearchSessionRelations(
        [{ id: 'session-parent-1', sessionId: 'parent-1' }],
        [{ id: 'child-1', researchSession: provenance }],
      ),
      [],
      'a relation is not emitted when the child execution is missing',
    );
    assert.match(shared.buildResearchSessionInitialPrompt(provenance), /Task:\nCheck claims/);
  });
});
