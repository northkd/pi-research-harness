import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashboard = path.resolve(
  process.env.PI_RESEARCH_DASHBOARD_SOURCE || path.join(ROOT, '.runtime/dashboard-source'),
);
const required = [
  'packages/shared/src/platform/native-ts-register.mjs',
  'packages/server/src/session/session-api.ts',
  'packages/server/src/pending/pending-initial-prompt-registry.ts',
  'packages/server/src/event-wiring.ts',
];
const missing = required.filter((rel) => !fs.existsSync(path.join(dashboard, rel)));
if (missing.length > 0) {
  test('stage session spawn (skipped: prepared dashboard source required)', { skip: `missing under ${dashboard}: ${missing.join(', ')}` }, () => {});
} else {
  await run();
}

async function run() {
    const dashUrl = (rel) => pathToFileURL(path.join(dashboard, rel)).href;
  const data = (code) => 'data:text/javascript,' + encodeURIComponent(code);

  globalThis.__stageMocks = {
    spawnPiSession: async () => ({ success: true, message: 'spawned' }),
    spawnAcpSession: async () => ({ success: true, message: 'acp-spawned' }),
    acp: { ok: true, agent: { id: 'acp-test', name: 'ACP', command: 'node' } },
    config: { spawnStrategy: 'headless', spawnRegisterTimeoutMs: 5000, acpAgents: [] },
  };

  const pm = `export const spawnPiSession=(...a)=>globalThis.__stageMocks.spawnPiSession(...a);
  export const getKeeperManager=()=>({});
  export const setCwdPolicyRegistry=()=>{};
  export const setResolver=()=>{};
  export const resetResolver=()=>{};
  export const setKeeperManager=()=>{};
  export const buildSpawnEnv=(e)=>e;
  export const buildTmuxCommand=()=>[];
  export const setSpawnDashboardPiPort=()=>{};
  export const setSpawnGatewayTransport=()=>{};
  export const _resetWslTmuxCacheForTests=()=>{};`;
  const wd = `export const armSpawnWatchdog=()=>undefined;
  export const getSpawnRegisterWatchdog=()=>({arm(){}});
  export const normalizeCwdKey=(c)=>c;
  export class SpawnRegisterWatchdog{}
  export const _setSpawnRegisterWatchdogForTests=()=>{};`;
  const acp = `export const validateAcpAgent=(id)=>globalThis.__stageMocks.acp;
  export const preflightAcpSpawn=()=>({ok:true,reasons:[]});
  export const spawnAcpSession=(...a)=>globalThis.__stageMocks.spawnAcpSession(...a);
  export const acpAgentsForClient=()=>[];
  export const setLocalAcpHost=()=>{};
  export const validatePluginAcpSpawn=()=>undefined;`;
  const configUrl = dashUrl('packages/shared/src/config.ts');
  const cfg = `import * as real from ${JSON.stringify(configUrl)};
  export * from ${JSON.stringify(configUrl)};
  export const loadConfig=()=>globalThis.__stageMocks.config;`;

  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.endsWith('/spawn-process/process-manager.js')) return { url: data(pm), shortCircuit: true };
      if (specifier.endsWith('/spawn-process/spawn-register-watchdog.js')) return { url: data(wd), shortCircuit: true };
      if (specifier.endsWith('/spawn-process/acp-spawn.js')) return { url: data(acp), shortCircuit: true };
      if (specifier.endsWith('/pi-dashboard-shared/config.js')) return { url: data(cfg), shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });

  await import(pathToFileURL(path.join(dashboard, 'packages/shared/src/platform/native-ts-register.mjs')).href);

  const { registerSessionApi } = await import(dashUrl('packages/server/src/session/session-api.ts'));
  const { createPendingInitialPromptRegistry } = await import(dashUrl('packages/server/src/pending/pending-initial-prompt-registry.ts'));
  const { createPendingPluginRefRegistry } = await import(dashUrl('packages/server/src/pending/pending-plugin-ref-registry.ts'));

  function rig() {
    const routes = {};
    const fastify = { post(route, ...args) { routes[route] = args.at(-1); } };
    const registry = createPendingInitialPromptRegistry({ normalize: (c) => c, warn: () => {} });
    const spawns = [];
    const acpSpawns = [];
    const ownerFiles = [];
    const ownerRemoves = [];
    globalThis.__stageMocks.spawnPiSession = async (cwd, opts = {}) => {
      spawns.push({ cwd, opts });
      return { success: true, message: 'spawned', ...(opts.spawnToken ? { spawnToken: opts.spawnToken } : {}) };
    };
    globalThis.__stageMocks.spawnAcpSession = async (cwd, opts = {}) => {
      acpSpawns.push({ cwd, opts });
      return { success: true, message: 'acp-spawned', ...(opts.spawnToken ? { spawnToken: opts.spawnToken } : {}) };
    };
    const deps = {
      sessionManager: {},
      piGateway: {},
      browserGateway: { headlessPidRegistry: { register() {} } },
      pendingDashboardSpawns: new Map(),
      pendingInitialPromptRegistry: registry,
      pendingPrincipalOwnerRegistry: {
        file(token, owner) { ownerFiles.push({ token, owner }); return true; },
        remove(token) { ownerRemoves.push(token); },
        resolve() { return null; },
        size() { return ownerFiles.length; },
      },
    };
    registerSessionApi(fastify, deps);
    const handler = routes['/api/session/spawn'];
    const reply = { statusCode: 200, code(c) { this.statusCode = c; return this; } };
    return { handler, reply, registry, spawns, acpSpawns, ownerFiles, ownerRemoves, deps };
  }

  const workflowRefFixture = {
    resWorkflow: { canonicalCwd: '/proj', joinedAt: '2026-10-24T00:00:00Z', via: 'spawn' },
    resWorkflowBinding: {
      ownerKey: 'fixture-owner',
      resolverActive: true,
      identity: { write: true, principal: { iss: 'iss', sub: 'sub' }, expiresAt: 9_999_999_999_999 },
    },
  };
  function joinSupport() {
    const refs = createPendingPluginRefRegistry({ now: () => 0, warn: () => {} });
    const calls = [];
    const prepare = async (cwd, identity) => {
      calls.push({ cwd, identity });
      return workflowRefFixture;
    };
    return { refs, calls, prepare, support: { prepare, registry: refs } };
  }

  test('REST spawn files prompt under exact token before spawn and fast register consumes it once', async () => {
    const r = rig();
    let during = null;
    globalThis.__stageMocks.spawnPiSession = async (cwd, opts = {}) => {
      r.spawns.push({ cwd, opts });
      during = r.registry.consume(cwd, opts.spawnToken);
      return { success: true, message: 'spawned', spawnToken: opts.spawnToken };
    };
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: 'editable prompt' } }, r.reply);
    assert.equal(r.reply.statusCode, 200);
    assert.equal(res.success, true);
    assert.equal(r.spawns.length, 1);
    assert.match(r.spawns[0].opts.spawnToken, /^[0-9a-f-]{36}$/);
    assert.equal(during, 'editable prompt');
    assert.equal(r.registry.consume('/proj', r.spawns[0].opts.spawnToken), null);
    assert.equal(r.registry.wasSpawnConsumed(r.spawns[0].opts.spawnToken), true);
  });

  test('no prompt preserves legacy spawn shape (no server-minted token)', async () => {
    const r = rig();
    // No join requested: the support resolver must not even be consulted.
    r.deps.resWorkflowSpawnSupport = () => { throw new Error('support must not be resolved'); };
    const res = await r.handler({ body: { cwd: '/proj' } }, r.reply);
    assert.equal(res.success, true);
    assert.deepEqual(r.spawns[0].opts, { strategy: 'headless' });
    assert.equal(r.registry.sizeForSpawn(), 0);
  });

  test('empty prompt is treated as absent', async () => {
    const r = rig();
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: '' } }, r.reply);
    assert.equal(res.success, true);
    assert.deepEqual(r.spawns[0].opts, { strategy: 'headless' });
  });

  test('invalid and oversized prompts are rejected before spawning', async () => {
    for (const initialPrompt of [42, 'x'.repeat(16 * 1024 + 1), 'a\0b']) {
      const r = rig();
      const res = await r.handler({ body: { cwd: '/proj', initialPrompt } }, r.reply);
      assert.equal(r.reply.statusCode, 400, String(initialPrompt).slice(0, 20));
      assert.equal(res.success, false);
      assert.equal(r.spawns.length, 0);
    }
  });

  test('ACP + prompt is rejected before preflight/spawn', async () => {
    const r = rig();
    globalThis.__stageMocks.acp = { ok: true, agent: { id: 'acp-test', name: 'ACP', command: 'node' } };
    const res = await r.handler({ body: { cwd: '/proj', agent: 'acp-test', initialPrompt: 'p' } }, r.reply);
    assert.equal(r.reply.statusCode, 400);
    assert.equal(res.code, 'INITIAL_PROMPT_UNSUPPORTED_ACP');
    assert.equal(r.spawns.length, 0);
    assert.equal(r.acpSpawns.length, 0);
  });

  test('missing delivery registry rejects prompt before spawning', async () => {
    const r = rig();
    r.deps.pendingInitialPromptRegistry = undefined;
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: 'p' } }, r.reply);
    assert.equal(r.reply.statusCode, 501);
    assert.equal(res.code, 'INITIAL_PROMPT_UNAVAILABLE');
    assert.equal(r.spawns.length, 0);
  });

  test('owner pre-minted token is reused for prompt binding', async () => {
    const r = rig();
    r.deps.isResolverActive = () => true;
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: 'owned prompt' }, principal: { iss: 'iss', sub: 'sub' } }, r.reply);
    assert.equal(res.success, true);
    assert.equal(r.ownerFiles.length, 1);
    assert.equal(r.spawns[0].opts.spawnToken, r.ownerFiles[0].token);
    assert.equal(r.registry.consume('/proj', r.ownerFiles[0].token), 'owned prompt');
  });

  test('failed spawn removes the pending prompt and tombstones the token', async () => {
    const r = rig();
    globalThis.__stageMocks.spawnPiSession = async (cwd, opts = {}) => ({ success: false, message: 'boom', spawnToken: opts.spawnToken });
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: 'p' } }, r.reply);
    assert.equal(r.reply.statusCode, 500);
    assert.equal(res.error, 'boom');
    // Find the token by the tombstone: no pending entry, and cwd fallback is suppressed.
    assert.equal(r.registry.sizeForSpawn(), 0);
    assert.equal(r.registry.consume('/proj'), null);
  });

  test('thrown spawn removes the pending prompt', async () => {
    const r = rig();
    globalThis.__stageMocks.spawnPiSession = async () => { throw new Error('kaput'); };
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: 'p' } }, r.reply);
    assert.equal(r.reply.statusCode, 500);
    assert.equal(res.error, 'kaput');
    assert.equal(r.registry.sizeForSpawn(), 0);
  });

  test('joinResWorkflow without configured support is refused before spawning', async () => {
    for (const support of [undefined, () => undefined]) {
      const r = rig();
      r.deps.resWorkflowSpawnSupport = support;
      const res = await r.handler({ body: { cwd: '/proj', joinResWorkflow: true } }, r.reply);
      assert.equal(r.reply.statusCode, 503);
      assert.equal(res.code, 'res-workflow-unavailable');
      assert.equal(r.spawns.length, 0);
    }
  });

  test('joinResWorkflow:false is a malformed request, not a silent ordinary spawn', async () => {
    const r = rig();
    r.deps.resWorkflowSpawnSupport = joinSupport().support;
    const res = await r.handler({ body: { cwd: '/proj', joinResWorkflow: false } }, r.reply);
    assert.equal(r.reply.statusCode, 400);
    assert.equal(res.code, 'invalid-join-res-workflow');
    assert.equal(r.spawns.length, 0);
  });

  test('join prepare failure (expired identity / not adopted) passes through before spawn', async () => {
    const r = rig();
    const prepare = async () => {
      throw Object.assign(new Error('expired'), { statusCode: 403, code: 'adoption-identity-expired' });
    };
    r.deps.resWorkflowSpawnSupport = { prepare, registry: createPendingPluginRefRegistry({ now: () => 0, warn: () => {} }) };
    const res = await r.handler(
      { body: { cwd: '/proj', joinResWorkflow: true }, principal: { iss: 'iss', sub: 'sub' }, principalExpiresAt: 1 },
      r.reply,
    );
    assert.equal(r.reply.statusCode, 403);
    assert.equal(res.code, 'adoption-identity-expired');
    assert.equal(r.spawns.length, 0);

    const notConnected = rig();
    notConnected.deps.resWorkflowSpawnSupport = {
      prepare: async () => { throw Object.assign(new Error('not connected'), { statusCode: 409, code: 'res-workflow-not-connected' }); },
      registry: createPendingPluginRefRegistry({ now: () => 0, warn: () => {} }),
    };
    const rejected = await notConnected.handler(
      { body: { cwd: '/proj', joinResWorkflow: true }, principal: { iss: 'iss', sub: 'sub' } },
      notConnected.reply,
    );
    assert.equal(notConnected.reply.statusCode, 409);
    assert.equal(rejected.code, 'res-workflow-not-connected');
    assert.equal(notConnected.spawns.length, 0);
  });

  test('join + prompt share one token; ref and prompt are present for a fast register during the await', async () => {
    const r = rig();
    r.deps.isResolverActive = () => true;
    const join = joinSupport();
    let supportResolutions = 0;
    // Thunk form: server.ts creates the participants service AFTER these
    // routes are registered, so the route must resolve support per request.
    r.deps.resWorkflowSpawnSupport = () => { supportResolutions++; return join.support; };
    let token;
    let duringPrompt = null;
    let duringRef = null;
    globalThis.__stageMocks.spawnPiSession = async (cwd, opts = {}) => {
      token = opts.spawnToken;
      r.spawns.push({ cwd, opts });
      // Simulate the registration that arrives DURING the spawn await, using
      // the exact token the server filed both intents under.
      assert.equal(join.refs.has(token, 'res-workflow'), true);
      const resolved = join.refs.resolve(token);
      duringRef = resolved?.ref;
      assert.equal(resolved?.ownerId, 'res-workflow');
      duringPrompt = r.registry.consume(cwd, token);
      return { success: true, message: 'spawned', spawnToken: token };
    };
    const res = await r.handler(
      {
        body: { cwd: '/proj', joinResWorkflow: true, initialPrompt: 'stage prompt' },
        principal: { iss: 'iss', sub: 'sub' },
        principalExpiresAt: 9_999_999_999_999,
      },
      r.reply,
    );
    assert.equal(r.reply.statusCode, 200);
    assert.equal(res.success, true);
    assert.equal(supportResolutions, 1);
    assert.equal(join.calls.length, 1);
    assert.equal(join.calls[0].cwd, '/proj');
    assert.deepEqual(join.calls[0].identity, {
      principal: { iss: 'iss', sub: 'sub' },
      expiresAt: 9_999_999_999_999,
      write: true,
    });
    assert.equal(r.ownerFiles.length, 1);
    assert.equal(r.ownerFiles[0].token, token);
    assert.equal(r.spawns[0].opts.spawnToken, token);
    assert.equal(duringRef.resWorkflow.canonicalCwd, '/proj');
    assert.equal(duringPrompt, 'stage prompt');
    assert.equal(join.refs.has(token, 'res-workflow'), false);
    assert.equal(r.registry.consume('/proj', token), null);
  });

  test('join + prompt failure cleanup removes owner, participant ref, and prompt by exact token', async () => {
    const r = rig();
    r.deps.isResolverActive = () => true;
    const join = joinSupport();
    r.deps.resWorkflowSpawnSupport = join.support;
    let token;
    globalThis.__stageMocks.spawnPiSession = async (_cwd, opts = {}) => {
      token = opts.spawnToken;
      return { success: false, message: 'boom', spawnToken: token };
    };
    const res = await r.handler(
      {
        body: { cwd: '/proj', joinResWorkflow: true, initialPrompt: 'stage prompt' },
        principal: { iss: 'iss', sub: 'sub' },
        principalExpiresAt: 9_999_999_999_999,
      },
      r.reply,
    );
    assert.equal(r.reply.statusCode, 500);
    assert.equal(res.error, 'boom');
    assert.equal(join.refs.has(token, 'res-workflow'), false);
    assert.equal(r.registry.sizeForSpawn(), 0);
    assert.equal(r.registry.wasSpawnConsumed(token), true);
    assert.deepEqual(r.ownerRemoves, [token]);
  });

  // ── event-wiring consumption flow ──────────────────────────────────────────
  const { wireEvents } = await import(dashUrl('packages/server/src/event-wiring.ts'));
  const { createMemorySessionManager } = await import(dashUrl('packages/server/src/session/memory-session-manager.ts'));
  const { createMemoryEventStore } = await import(dashUrl('packages/server/src/persistence/memory-event-store.ts'));
  const { createBrowserGateway } = await import(dashUrl('packages/server/src/pairing/browser-gateway.ts'));
  const { createPendingForkRegistry } = await import(dashUrl('packages/server/src/pending/pending-fork-registry.ts'));

  function wiringRig(options = {}) {
    const registry = createPendingInitialPromptRegistry({ normalize: (c) => c, warn: () => {} });
    const sessionManager = createMemorySessionManager();
    const eventStore = createMemoryEventStore(() => false);
    const sent = [];
    const sequence = [];
    const piGateway = {
      start() {}, stop() {},
      sendToSession(...args) {
        sent.push(args);
        if (args[1]?.type === 'send_prompt') sequence.push('prompt');
        if (args[1]?.type === 'send_prompt') options.onPrompt?.(args[1]);
        return true;
      },
      getConnectedSessionIds() { return []; },
      isSessionConnected() { return true; },
      onEvent: undefined,
      clearHostPressure() {},
    };
    const browserGateway = createBrowserGateway(sessionManager, eventStore, piGateway);
    wireEvents({
      sessionManager, eventStore, piGateway, browserGateway,
      sessionOrderManager: { insert() {}, remove() {}, getOrder() { return []; }, reorder() {}, getAllOrders() { return {}; }, moveToFront() {}, rekey() {} },
      preferencesStore: { getPinnedDirectories() { return []; }, getAutoNameSessions() { return false; } },
      pendingForkRegistry: createPendingForkRegistry(),
      directoryService: { refreshFolderHeadsForEnteringKeys() {}, cancelLoad() {}, async onDirectoryAdded() { return { sessions: [], openspecData: null }; }, getOpenSpecData() { return null; }, notifyPiResourcesInvalidated() {} },
      knownSessionIds: new Set(),
      pendingDashboardSpawns: new Map(),
      pendingInitialPromptRegistry: registry,
      ...(options.pendingPluginRefRegistry ? { pendingPluginRefRegistry: options.pendingPluginRefRegistry } : {}),
      ...(options.registerResWorkflowParticipant
        ? {
            registerResWorkflowParticipant: (id, registration, ref) => {
              sequence.push('participant');
              return options.registerResWorkflowParticipant(id, registration, ref);
            },
          }
        : {}),
    });
    const register = (id, token, cwd = '/proj', extra = {}) => {
      sessionManager.register({ id, cwd, source: 'cli', startedAt: 1 });
      piGateway.onEvent(id, { type: 'session_register', sessionId: id, cwd, source: 'cli', ...(token ? { spawnToken: token } : {}), ...extra });
    };
    const promptTexts = () => sent.filter(([, m]) => m?.type === 'send_prompt').map(([, m]) => m.text);
    return { registry, sent, sequence, register, promptTexts, browserGateway, unregister: id => sessionManager.unregister(id) };
  }

  test('event-wiring delivers token-bound prompt to the exact session, not same-cwd sibling', () => {
    const r = wiringRig();
    r.registry.enqueue('/proj', 'prompt-A', 'tok-A');
    r.registry.enqueue('/proj', 'prompt-B', 'tok-B');
    r.register('sess-B', 'tok-B');
    assert.deepEqual(r.promptTexts(), ['prompt-B']);
    r.register('sess-A', 'tok-A');
    assert.deepEqual(r.promptTexts(), ['prompt-B', 'prompt-A']);
    r.register('sess-A2', 'tok-A'); // duplicate token register
    assert.deepEqual(r.promptTexts(), ['prompt-B', 'prompt-A']);
    r.browserGateway.wss.close();
  });

  test('event-wiring preserves legacy cwd FIFO when register has no token', () => {
    const r = wiringRig();
    r.registry.enqueue('/proj', 'legacy');
    r.register('sess-legacy');
    assert.deepEqual(r.promptTexts(), ['legacy']);
    r.browserGateway.wss.close();
  });

  test('event-wiring retires a token after legacy cwd fallback so a duplicate cannot drain more', () => {
    const r = wiringRig();
    r.registry.enqueue('/proj', 'legacy A');
    r.registry.enqueue('/proj', 'legacy B');
    r.register('sess-legacy-token', 'tok-legacy');
    assert.deepEqual(r.promptTexts(), ['legacy A']);
    r.register('sess-legacy-token-dup', 'tok-legacy');
    assert.deepEqual(r.promptTexts(), ['legacy A']);
    r.register('sess-legacy-next');
    assert.deepEqual(r.promptTexts(), ['legacy A', 'legacy B']);
    r.browserGateway.wss.close();
  });

  test('an empty first registration retires its token before any future legacy prompt exists', () => {
    const r = wiringRig();
    r.register('sess-empty', 'tok-empty');
    assert.deepEqual(r.promptTexts(), []);
    assert.equal(r.registry.wasSpawnConsumed('tok-empty'), true);
    r.registry.enqueue('/proj', 'future legacy prompt');
    r.register('sess-empty-duplicate', 'tok-empty');
    assert.deepEqual(r.promptTexts(), []);
    r.register('sess-future');
    assert.deepEqual(r.promptTexts(), ['future legacy prompt']);
    r.browserGateway.wss.close();
  });

  test('REST owner-token spawn without a first prompt never drains the legacy cwd FIFO', async () => {
    const r = rig();
    const w = wiringRig();
    r.deps.pendingInitialPromptRegistry = w.registry;
    r.deps.isResolverActive = () => true;
    w.registry.enqueue('/proj', 'another session legacy prompt');
    globalThis.__stageMocks.spawnPiSession = async (cwd, opts) => {
      w.register('blank-rest-session', opts.spawnToken, cwd);
      return { success: true, message: 'spawned' };
    };
    assert.equal((await r.handler({ body: { cwd: '/proj' }, principal: { iss: 'iss', sub: 'sub' } }, r.reply)).success, true);
    assert.deepEqual(w.promptTexts(), []);
    assert.equal(w.registry.size('/proj'), 1);
    w.browserGateway.wss.close();
  });

  test('ACP with requested workflow association is refused before starting an unjoined process', async () => {
    const r = rig();
    r.deps.resWorkflowSpawnSupport = joinSupport().support;
    globalThis.__stageMocks.acp = { ok: true, agent: { id: 'acp-test', name: 'ACP', command: 'node' } };
    const res = await r.handler({ body: { cwd: '/proj', agent: 'acp-test', joinResWorkflow: true } }, r.reply);
    assert.equal(r.reply.statusCode, 400);
    assert.equal(res.code, 'JOIN_RES_WORKFLOW_UNSUPPORTED_ACP');
    assert.equal(r.spawns.length + r.acpSpawns.length, 0);
  });

  test('event-wiring duplicate consumed token cannot steal a legacy cwd prompt', () => {
    const r = wiringRig();
    r.registry.enqueue('/proj', 'token prompt', 'tok-X');
    r.registry.enqueue('/proj', 'legacy prompt');
    r.register('sess-X', 'tok-X');
    assert.deepEqual(r.promptTexts(), ['token prompt']);
    r.register('sess-X-dup', 'tok-X');
    assert.deepEqual(r.promptTexts(), ['token prompt']);
    r.register('sess-legacy');
    assert.deepEqual(r.promptTexts(), ['token prompt', 'legacy prompt']);
    r.browserGateway.wss.close();
  });

  test('event-wiring waits for completed membership before consuming the first research prompt', async () => {
    const refs = createPendingPluginRefRegistry({ now: () => 0, warn: () => {} });
    const calls = [];
    let release, received;
    const admission = new Promise(resolve => { release = resolve; });
    const delivered = new Promise(resolve => { received = resolve; });
    const w = wiringRig({
      pendingPluginRefRegistry: refs,
      onPrompt: received,
      registerResWorkflowParticipant: async (id, registration, ref) => {
        calls.push({ id, registration, ref });
        await admission;
      },
    });
    assert.equal(refs.file('tok-join', workflowRefFixture, 'res-workflow'), true);
    w.registry.enqueue('/proj', 'stage prompt', 'tok-join');
    w.register('join-session', 'tok-join');
    await Promise.resolve();
    assert.deepEqual(w.sequence, ['participant']);
    assert.equal(w.registry.sizeForSpawn(), 1);
    w.register('join-session', 'tok-join');
    assert.deepEqual(w.promptTexts(), []);
    release(); await delivered;
    assert.deepEqual(w.sequence, ['participant', 'prompt']);
    assert.deepEqual(w.promptTexts(), ['stage prompt']);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'join-session');
    assert.equal(calls[0].ref.resWorkflow.canonicalCwd, '/proj');
    w.browserGateway.wss.close();
  });

  test('event-wiring provisional research registration cannot consume the eventual task', async () => {
    const refs = createPendingPluginRefRegistry({ now: () => 0, warn: () => {} });
    let received;
    const delivered = new Promise(resolve => { received = resolve; });
    const w = wiringRig({ pendingPluginRefRegistry: refs, registerResWorkflowParticipant: async () => {}, onPrompt: received });
    refs.file('tok-provisional', workflowRefFixture, 'res-workflow');
    w.registry.enqueue('/proj', 'trusted task', 'tok-provisional');
    w.register('provisional-session', 'tok-provisional', '/proj', { provisional: true });
    await new Promise(setImmediate);
    assert.deepEqual(w.sequence, []);
    assert.equal(w.registry.sizeForSpawn(), 1);
    w.register('provisional-session', 'tok-provisional');
    await delivered;
    assert.deepEqual(w.sequence, ['participant', 'prompt']);
    w.browserGateway.wss.close();
  });

  test('failed or unavailable research association stays closed across unregister and re-register', async () => {
    for (const missing of [false, true]) {
      const refs = createPendingPluginRefRegistry({ now: () => 0, warn: () => {} });
      const w = wiringRig({ pendingPluginRefRegistry: refs,
        ...(missing ? {} : { registerResWorkflowParticipant: async () => { throw new Error('admission refused'); } }) });
      refs.file('tok-failed', workflowRefFixture, 'res-workflow');
      w.registry.enqueue('/proj', 'must not execute', 'tok-failed');
      w.register('failed-session', 'tok-failed');
      await new Promise(setImmediate);
      assert.deepEqual(w.promptTexts(), []);
      w.unregister('failed-session');
      w.register('failed-session', 'tok-failed');
      await new Promise(setImmediate);
      assert.deepEqual(w.promptTexts(), []);
      assert.equal(w.registry.sizeForSpawn(), 1);
      w.browserGateway.wss.close();
    }
  });

  test('registry: token entries are invisible to cwd-only consume and mismatched tokens', () => {
    const reg = createPendingInitialPromptRegistry({ normalize: (c) => c, warn: () => {} });
    reg.enqueue('/proj', 'token prompt', 'tok-1');
    reg.enqueue('/proj', 'legacy prompt');
    assert.equal(reg.consume('/proj'), 'legacy prompt');
    assert.equal(reg.consume('/proj', 'tok-2'), null);
    assert.equal(reg.consume('/proj'), null);
    assert.equal(reg.consume('/proj', 'tok-1'), 'token prompt');
    assert.equal(reg.consume('/proj', 'tok-1'), null);
  });

  test('registry: rollback removes only the exact token and tombstones cwd fallback', () => {
    const reg = createPendingInitialPromptRegistry({ normalize: (c) => c, warn: () => {} });
    reg.enqueue('/proj', 'token prompt', 'tok-r');
    reg.enqueue('/proj', 'legacy prompt');
    reg.remove('/proj', 'tok-r');
    assert.equal(reg.sizeForSpawn(), 0);
    assert.equal(reg.wasSpawnConsumed('tok-r'), true);
    assert.equal(reg.consume('/proj', 'tok-r'), null);
    assert.equal(reg.consume('/proj'), 'legacy prompt');
  });

  test('registry: expired token is tombstoned and never falls through to cwd', () => {
    let now = 0;
    const reg = createPendingInitialPromptRegistry({ normalize: (c) => c, warn: () => {}, now: () => now });
    reg.enqueue('/proj', 'token prompt', 'tok-t');
    now = 61_000;
    // Fresh legacy intent at the later clock; the token entry is expired.
    reg.enqueue('/proj', 'legacy prompt');
    assert.equal(reg.consume('/proj', 'tok-t'), null);
    assert.equal(reg.wasSpawnConsumed('tok-t'), true);
    assert.equal(reg.consume('/proj'), 'legacy prompt');
  });

  test('registry: legacy cwd FIFO cap and TTL are unchanged', () => {
    let now = 0;
    const reg = createPendingInitialPromptRegistry({ normalize: (c) => c, warn: () => {}, now: () => now });
    for (let i = 0; i < 11; i++) reg.enqueue('/proj', `p${i}`);
    assert.equal(reg.size('/proj'), 8);
    assert.equal(reg.consume('/proj'), 'p0');
    now = 61_000;
    assert.equal(reg.consume('/proj'), null);
  });

  test('registry: duplicate token and oversized token-bound prompt are refused', () => {
    const reg = createPendingInitialPromptRegistry({ normalize: (c) => c, warn: () => {} });
    assert.equal(reg.enqueue('/proj', 'first', 'tok-d'), true);
    assert.equal(reg.enqueue('/proj', 'second', 'tok-d'), false);
    assert.equal(reg.enqueue('/proj', 'x'.repeat(16 * 1024 + 1), 'tok-big'), false);
    assert.equal(reg.consume('/proj', 'tok-d'), 'first');
    assert.equal(reg.consume('/proj', 'tok-big'), null);
  });

  test('REST spawn + fast session_register DURING the spawn await consumes the prompt exactly once', async () => {
    const w = wiringRig();
    const r = rig();
    // The route closure reads deps at request time; point it at the wiring registry.
    r.deps.pendingInitialPromptRegistry = w.registry;
    let token;
    globalThis.__stageMocks.spawnPiSession = async (cwd, opts = {}) => {
      token = opts.spawnToken;
      r.spawns.push({ cwd, opts });
      // Simulate a bridge registering before spawnPiSession resolves.
      w.register('fast-session', opts.spawnToken, cwd);
      return { success: true, message: 'spawned', spawnToken: opts.spawnToken };
    };
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: 'fast prompt' } }, r.reply);
    assert.equal(r.reply.statusCode, 200);
    assert.equal(res.success, true);
    assert.deepEqual(w.promptTexts(), ['fast prompt']);
    assert.equal(w.registry.consume('/proj', token), null);
    // A duplicate register with the already-consumed token must not re-deliver.
    w.register('fast-session-dup', token, '/proj');
    assert.deepEqual(w.promptTexts(), ['fast prompt']);
    w.browserGateway.wss.close();
  });

  test('failed REST spawn tombstone prevents a late register from stealing a legacy cwd prompt', async () => {
    const w = wiringRig();
    const r = rig();
    r.deps.pendingInitialPromptRegistry = w.registry;
    let token;
    globalThis.__stageMocks.spawnPiSession = async (cwd, opts = {}) => {
      token = opts.spawnToken;
      r.spawns.push({ cwd, opts });
      return { success: false, message: 'boom', spawnToken: opts.spawnToken };
    };
    w.registry.enqueue('/proj', 'legacy prompt');
    const res = await r.handler({ body: { cwd: '/proj', initialPrompt: 'doomed prompt' } }, r.reply);
    assert.equal(r.reply.statusCode, 500);
    assert.equal(res.success, false);
    // The rolled-back token must not fall through to the same-cwd legacy FIFO.
    w.register('late-session', token, '/proj');
    assert.deepEqual(w.promptTexts(), []);
    w.register('legacy-session', undefined, '/proj');
    assert.deepEqual(w.promptTexts(), ['legacy prompt']);
    w.browserGateway.wss.close();
  });
}
