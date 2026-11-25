import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import registerGoalPlugin, { goalCommandFor } from './goal/server/index.js';
import { detailsToSnapshot } from './goal/shared/goal-types.js';
import { getBillingReport, getSpeedStats, markGenerationEnd, markGenerationStart } from './billing/server/stats.js';
import { mountKbRoutes } from './kb/kb-routes.js';
import { KbJobRegistry } from './kb/job-registry.js';
import registerAutomationPlugin from './automation/server/index.js';
import registerFlowsPlugin from './flows/server/index.js';
import { stateStore as flowsState } from './flows/server/state-store.js';
import { isReservedEventType } from './shared/protocol.js';
import { withSupplementalEnvironment } from './runtime-home.mjs';

export { createGoalStore, GoalNotFoundError } from './goal/server/goal-store.js';
export { createGoalSupervisor } from './goal/server/goal-supervisor.js';
export { getBillingReport, getSpeedStats } from './billing/server/stats.js';
export * as knowledgeBase from './kb-engine/dist/index.js';

function routeMatcher(pattern) {
  const names = [];
  const expression = pattern.split('/').map(part => {
    if (!part.startsWith(':')) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(part.slice(1));
    return '([^/]+)';
  }).join('/');
  const regex = new RegExp('^' + expression + '$');
  return pathname => {
    const match = regex.exec(pathname);
    if (!match) return null;
    return Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1])]));
  };
}

function requireHost(deps, key) {
  if (typeof deps[key] !== 'function') throw new Error('supplemental-host-capability-required-' + key);
  return deps[key];
}

/** All HTTP requests must arrive through the host's authenticated local router. */
export async function createSupplementalRuntime(deps) {
  const getSession = requireHost(deps, 'getSession');
  const listSessions = requireHost(deps, 'listSessions');
  const knownCwds = requireHost(deps, 'knownCwds');
  const hostDirectory = deps.dataDir || process.env.PI_RESEARCH_HOST_DIR || path.join(os.homedir(), '.pi', 'research-host');
  const environment = { homeDir: deps.homeDir || os.homedir(), hostDir: hostDirectory };
  const withinHome = operation => withSupplementalEnvironment(environment, operation);
  const logger = deps.logger || { info() {}, warn: console.error, error: console.error };
  const routes = [];
  const piHandlers = new Map();
  const pluginRequests = new Map();
  const browserHandlers = [];
  const eventHandlers = [];
  const published = new Map();
  const anthropicPeers = new Map();
  const flowRuntime = new Map();
  const endedHandlers = [];
  const resolvedHandlers = [];
  const backgroundStarts = [];
  const shutdownHandlers = [];
  const registry = new KbJobRegistry();
  const fastify = { log: logger };
  for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
    fastify[method] = (pattern, options, handler) => {
      routes.push({ method: method.toUpperCase(), match: routeMatcher(pattern), handler: handler || options });
    };
  }
  // The host accepts authenticated loopback traffic. The original flow-file
  // limiter explicitly allows loopback callers, so the child route scope has
  // the same effect through this in-process registrar.
  fastify.register = async (plugin, options) => plugin(fastify, options);
  fastify.addHook = (_name, handler) => handler();
  const contextFor = pluginId => ({
    goalDataDir: path.join(hostDirectory, 'goals'), fastify, logger,
    networkGuard() {},
    sessionManager: { getSession, listAll: listSessions, listActive: deps.listActiveSessions || (() => listSessions().filter(session => ['idle', 'streaming', 'running', 'busy', 'waiting', 'starting'].includes(session.status))) },
    consume: name => name === 'host.knownFolderCwds' ? knownCwds : published.get(name) ?? deps.consume?.(name),
    consumeAll: prefix => [...published].filter(([name]) => name.startsWith(prefix)).map(([key, value]) => ({ key, value })).concat(deps.consumeAll?.(prefix) || []),
    provide: (name, value) => published.set(name, value),
    getPluginConfig: () => deps.getPluginConfig?.(pluginId) ?? deps.plugins?.[pluginId] ?? {},
    registerPiHandler: (name, handler) => {
      if (!piHandlers.has(name)) piHandlers.set(name, []);
      piHandlers.get(name).push(handler);
    },
    registerPiRequestHandler: (name, handler) => pluginRequests.set(pluginId + ':' + name, handler),
    registerBrowserHandler: (_name, handler) => browserHandlers.push(handler),
    onEvent: handler => eventHandlers.push(handler),
    broadcastToSubscribers: event => deps.onChanged?.(event),
    sendToSession: (id, text) => requireHost(deps, 'sendToSession')(id, text),
    emitEventToSession: (id, type, data) => requireHost(deps, 'emitEventToSession')(id, type, data),
    renameSession: (id, name) => requireHost(deps, 'renameSession')(id, name),
    assignSessionRef: (...args) => requireHost(deps, 'assignSessionRef')(...args),
    spawnSession: input => requireHost(deps, 'spawnSession')(input),
    mintSpawnToken: () => randomUUID(),
    abortSpawnedRun: input => requireHost(deps, 'abortSpawnedRun')(input),
    onSessionEnded: handler => endedHandlers.push(handler),
    onSessionResolved: handler => resolvedHandlers.push(handler),
    onBackgroundStart: handler => backgroundStarts.push(handler),
    onShutdown: handler => shutdownHandlers.push(handler),
  });
  await withinHome(() => registerGoalPlugin(contextFor('goal')));
  await withinHome(() => registerFlowsPlugin(contextFor('flows')));
  await withinHome(() => registerAutomationPlugin(contextFor('automation')));
  mountKbRoutes(fastify, { knownCwds, registry });
  function startBackground() {
    if (backgroundStarts.length) withinHome(() => { for (const start of backgroundStarts.splice(0)) start(); });
  }
  if (!deps.deferBackground) startBackground();

  async function authorized(cwd, context, write) {
    if (typeof deps.authorizeCwd === 'function') return (await deps.authorizeCwd(cwd, context, write)) !== false;
    return typeof cwd === 'string' && knownCwds().includes(cwd);
  }

  async function handle({ method, pathname, url, body, context }) {
    const target = url instanceof URL ? url : new URL(url || pathname, 'http://127.0.0.1');
    const routePath = pathname || target.pathname;
    const verb = String(method || 'GET').toUpperCase();
    const query = Object.fromEntries(target.searchParams);
    if (routePath === '/api/flows-anthropic-bridge/status') {
      if (verb !== 'GET') return { statusCode: 405, body: { error: 'method-not-allowed' } };
      return { statusCode: 200, body: { ok: true, pluginId: 'flows-anthropic-bridge', sessions: [...anthropicPeers.values()] } };
    }
    if (routePath === '/api/plugins/flows/control') {
      if (verb !== 'POST') return { statusCode: 405, body: { error: 'method-not-allowed' } };
      const session = typeof body?.sessionId === 'string' && getSession(body.sessionId);
      if (!session || !await authorized(session.cwd, context, true)) return { statusCode: 403, body: { error: 'flow-session-not-allowed' } };
      const action = body.action;
      if (action === 'dismiss_summary') {
        flowsState.applyEvent(session.id, { eventType: 'flow_summary_dismissed', data: {}, timestamp: Date.now() });
        return { statusCode: 200, body: { success: true, applied: 'flow_summary_dismissed' } };
      }
      if (flowRuntime.get(session.id)?.available === false) return { statusCode: 409, body: { success: false, error: 'flow-runtime-unavailable' } };
      const events = { abort: 'flow:abort', toggle_autonomous: 'flow:toggle-autonomous', dismiss_summary: 'flow:summary-dismissed', 'set-edit-mode': 'flow:set-edit-mode', delete: 'flow:delete-request' };
      const type = action === 'run' ? 'flow:run' : events[action];
      if (!type) return { statusCode: 400, body: { error: 'flow-action-invalid' } };
      const payload = body.payload || {};
      if (action === 'run' && (typeof payload.flowName !== 'string' || !payload.flowName.trim())) return { statusCode: 400, body: { error: 'flow-name-required' } };
      if (action === 'run' && payload.inputs !== undefined && (!payload.inputs || typeof payload.inputs !== 'object' || Array.isArray(payload.inputs))) return { statusCode: 400, body: { error: 'flow-inputs-invalid' } };
      if (action === 'set-edit-mode' && typeof payload.enabled !== 'boolean') return { statusCode: 400, body: { error: 'flow-edit-mode-required' } };
      if (action === 'delete' && (typeof payload.flowName !== 'string' || !payload.flowName.trim())) return { statusCode: 400, body: { error: 'flow-name-required' } };
      if (isReservedEventType(type)) return { statusCode: 400, body: { error: 'flow-event-refused' } };
      const delivered = await requireHost(deps, 'emitEventToSession')(session.id, type, payload);
      const accepted = delivered === true || delivered?.accepted === true;
      return { statusCode: accepted ? 200 : 503, body: { success: accepted, ...(!accepted ? { error: delivered?.reason || 'flow-effect-unconfirmed' } : {}) } };
    }
    if (routePath === '/api/plugins/flows/state') {
      if (verb !== 'GET') return { statusCode: 405, body: { error: 'method-not-allowed' } };
      const session = query.sessionId && getSession(query.sessionId);
      if (!session || !await authorized(session.cwd, context, false)) return { statusCode: 403, body: { error: 'flow-session-not-allowed' } };
      return { statusCode: 200, body: { ...(flowsState.getState(session.id) || { flows: [], commands: [] }), runtime: flowRuntime.get(session.id) || { available: null } } };
    }
    if (routePath === '/api/plugins/goal/control') {
      if (verb !== 'POST') return { statusCode: 405, body: { error: 'method-not-allowed' } };
      const session = typeof body?.sessionId === 'string' && getSession(body.sessionId);
      if (!session || !await authorized(session.cwd, context, true)) return { statusCode: 403, body: { error: 'goal-session-not-allowed' } };
      const command = goalCommandFor(body.action, body.payload, 'criteria-dashboard-budget');
      if (!command) return { statusCode: 400, body: { error: 'goal-control-invalid' } };
      const delivered = await requireHost(deps, 'sendToSession')(session.id, command);
      const accepted = delivered === true || delivered?.accepted === true;
      return { statusCode: accepted ? 200 : 503, body: { success: accepted } };
    }
    if (routePath.startsWith('/api/speed-monitor/')) {
      if (verb !== 'GET') return { statusCode: 405, body: { error: 'method-not-allowed' } };
      if (query.month !== undefined && !/^\d{4}-(0[1-9]|1[0-2])$/.test(query.month)) return { statusCode: 400, body: { error: 'invalid-billing-month' } };
      if (routePath === '/api/speed-monitor/billing') {
        return { statusCode: 200, body: await getBillingReport(query.month, listSessions()) };
      }
      if (routePath === '/api/speed-monitor/stats') {
        const session = query.sessionId ? getSession(query.sessionId) : undefined;
        if (session && !await authorized(session.cwd, context, false)) return { statusCode: 403, body: { error: 'cwd-not-allowed' } };
        const file = session?.originDeviceId ? undefined : session?.sessionFile;
        return { statusCode: 200, body: await getSpeedStats(query.sessionId, file, query.month) };
      }
      return null;
    }
    const route = routes.find(candidate => candidate.method === verb && candidate.match(routePath));
    if (!route) return null;
    const operationCwd = query.cwd ?? body?.cwd;
    if (operationCwd !== undefined && !await authorized(operationCwd, context, verb !== 'GET')) return { statusCode: 403, body: { error: 'cwd-not-allowed' } };
    if (query.sessionId) {
      const session = getSession(query.sessionId);
      if (!session || !await authorized(session.cwd, context, verb !== 'GET')) return { statusCode: 403, body: { error: 'session-not-allowed' } };
    }
    let statusCode = 200;
    let responseBody;
    let sent = false;
    const raw = new EventEmitter();
    const reply = {
      raw,
      code(value) { statusCode = value; return this; },
      status(value) { statusCode = value; return this; },
      send(value) { responseBody = value; sent = true; return this; },
    };
    try {
      const result = await route.handler({ query, params: route.match(routePath), body, log: logger }, reply);
      if (verb !== 'GET' && routePath.startsWith('/api/plugins/automation')) {
        // The existing filesystem watcher debounces edits. Reconciliation is
        // also scheduled explicitly so a newly created first directory is armed.
        for (const handler of eventHandlers) handler('', { eventType: 'automation-definition-changed', data: {} });
      }
      return { statusCode, body: sent ? responseBody : result };
    } finally { raw.emit('close'); }
  }

  function onPiEvent(sessionId, event) {
    const type = event?.eventType || event?.type;
    const data = event?.data || event;
    if (type === 'flows-anthropic-bridge:status' && Number.isSafeInteger(data?.pid)) anthropicPeers.set(data.pid, data);
    if (event?.replay) { markGenerationEnd(sessionId); return; }
    if (type === 'message_start' && data.message?.role === 'assistant') markGenerationStart(sessionId, data.message.model);
    if ((type === 'message_end' && data.message?.role === 'assistant') || ['agent_settled', 'agent_end'].includes(type)) markGenerationEnd(sessionId);
    let snapshot;
    if (type === 'message_end' && data.message?.customType === 'pi-goal-hermes:event' && typeof data.message.details?.eventType === 'string') snapshot = detailsToSnapshot(data.message.details);
    if (event?.messageType === 'goal_status') snapshot = event.payload;
    if (snapshot) for (const handler of piHandlers.get('goal_status') || []) handler({ sessionId, payload: snapshot });
    if (type === 'flows_list' && Array.isArray(data.flows)) {
      flowsState.setFlows(sessionId, data.flows);
      if (typeof data.runtimeAvailable === 'boolean') flowRuntime.set(sessionId, { available: data.runtimeAvailable, observedAt: Date.now() });
    }
    if (type === 'commands_list' && Array.isArray(data.commands)) flowsState.setCommands(sessionId, data.commands);
    if (typeof type === 'string') flowsState.applyEvent(sessionId, { eventType: type, data, timestamp: Date.now() });
    for (const handler of eventHandlers) handler(sessionId, { eventType: type, data });
  }

  return {
    handle: input => withinHome(() => handle(input)), registry, startBackground,
    onPiEvent: (sessionId, event) => withinHome(() => onPiEvent(sessionId, event)),
    requestPlugin(pluginId, name, payload, sessionId) {
      if (!getSession(sessionId)) throw new Error('plugin-session-not-found');
      const handler = pluginRequests.get(pluginId + ':' + name);
      if (!handler) throw new Error('plugin-request-unknown');
      return withinHome(() => handler(payload, { sessionId }));
    },
    consume(name) { return published.get(name); },
    onSessionEnded(sessionId) { return withinHome(() => { markGenerationEnd(sessionId); flowsState.clearSession(sessionId); for (const handler of endedHandlers) handler(sessionId); }); },
    onSessionResolved(sessionId, refs) { return withinHome(() => { for (const handler of resolvedHandlers) handler(sessionId, refs || {}); }); },
    dispose() { return withinHome(() => { for (const handler of shutdownHandlers.splice(0)) handler(); }); },
  };
}
