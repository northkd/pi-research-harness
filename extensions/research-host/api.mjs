import { fail, reply } from './http.mjs';

const IDENTIFIER = /^[a-zA-Z0-9_-]{1,128}$/;
const COLLABORATION_FIELDS = ['cwd', 'action', 'expectedRevision', 'sessionId', 'tenureId', 'maxMultiAgents', 'maxSubagents', 'planId', 'taskId', 'taskIds', 'queueRevision', 'text', 'requestId'];
const ADOPTION_MUTATIONS = new Map([
  ['', ['create', ['requestId', 'historySelection', 'model', 'consent'], 202]],
  ['agent', ['createAgent', ['requestId', 'historySelection', 'model'], 202]],
  ['agent/authorize', ['authorizeAgent', ['requestId', 'model', 'consent', 'budget'], 202]],
  ['agent/budget', ['updateAgentBudget', ['requestId', 'grantHash', 'expectedRevision', 'maxRequests', 'consent'], 200]],
  ['agent/resume', ['resumeAgent', ['requestId', 'grantHash'], 202]],
  ['analyze', ['analyze', ['requestId', 'model', 'consent'], 202]],
  ['history-review/prepare', ['prepareHistoryReview', ['requestId', 'model', 'recovery'], 200]],
  ['history-review/analyze', ['analyzeHistoryReview', ['requestId', 'model', 'consent'], 202]],
  ['confirm', ['confirm', ['proposalHash', 'objective', 'successCriteria'], 200]],
  ['cancel', ['cancel', [], 200]],
]);

function shape(value, fields) {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(key => fields.includes(key));
}

function only(value, fields, code = 'invalid-research-host-request') {
  if (!shape(value, fields)) fail(400, code);
  return value;
}

function validId(value, code = 'invalid-session-id') {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) fail(400, code);
  return value;
}

function query(url, allowed) {
  const params = Object.fromEntries(url.searchParams);
  if (Object.keys(params).some(key => !allowed.includes(key) || url.searchParams.getAll(key).length !== 1)) {
    fail(400, 'invalid-query');
  }
  return params;
}

function adoptionInput(body, fields) {
  only(body, ['cwd', ...fields], 'invalid-adoption-request');
  const { model, consent, recovery, budget } = body;
  let consentKeys = ['scope', 'includeUnpublished', 'analysisMode', 'planId', 'planHash', 'maxRequests'];
  if (body.expectedRevision !== undefined) consentKeys = ['scope', 'budgetMayIncreaseCharges', 'unknownRetryMayBillAgain'];
  else if (consent?.analysisMode === 'full-history-agent-v2') consentKeys = ['scope', 'includeUnpublished', 'analysisMode', 'grantHash', 'maxRequests', 'policyId', 'unknownRetryMayBillAgain'];
  if ((model !== undefined && !shape(model, ['provider', 'id'])) ||
      (consent !== undefined && !shape(consent, consentKeys)) ||
      (recovery !== undefined && !shape(recovery, ['mode', 'previousPlanId', 'previousPlanHash'])) ||
      (budget !== undefined && (!shape(budget, ['maxRequests', 'consent']) ||
        !shape(budget.consent, ['scope', 'budgetMayIncreaseCharges', 'unknownRetryMayBillAgain'])))) {
    fail(400, 'invalid-adoption-request');
  }
}

export function createResearchApi(options) {
  const { workbench, services, sessions, adoption, policy, observation, supplemental, transcript, transcriptEntry, validateCharterBinding, localOperatorPrincipal, sessionCompatibility, mintRealtimeTicket, mintMcpToken, science, files, accessRoutes, modelConfig, questions, respondToUi, hostInstanceId } = options;
  const operator = { principal: localOperatorPrincipal };
  const accessFor = (cwd, write = false) => workbench.accessFor(cwd, { ...operator, write });
  const get = sessionId => {
    const row = sessions.getSession(validId(sessionId));
    if (!row) fail(404, 'session-not-found');
    return row;
  };

  async function adoptions(method, suffix, url, body) {
    const parts = suffix ? suffix.split('/') : [];
    if (method === 'GET' && parts.length === 1) {
      const access = await accessFor(query(url, ['cwd']).cwd);
      return reply({ adoption: await adoption.get(access, validId(parts[0], 'invalid-adoption-id')) });
    }
    if (method === 'GET' && parts.length === 3 && parts[1] === 'sources') {
      const access = await accessFor(query(url, ['cwd']).cwd);
      return reply(await adoption.source(access, validId(parts[0], 'invalid-adoption-id'), validId(parts[2], 'invalid-source-id')));
    }
    if (method !== 'POST') return null;
    const creates = suffix === '' || suffix === 'agent';
    const action = creates ? suffix : parts.slice(1).join('/');
    const route = ADOPTION_MUTATIONS.get(action);
    if (!route || (!creates && (action === '' || action === 'agent'))) return null;
    const [name, fields, status] = route;
    adoptionInput(body, fields);
    const access = await accessFor(body.cwd, true);
    const value = { ...body, cwd: access.cwd };
    const result = creates
      ? await adoption[name](access, value)
      : await adoption[name](access, validId(parts[0], 'invalid-adoption-id'), value);
    return reply({ adoption: result }, status);
  }

  async function workbenchRoute(method, suffix, url, body) {
    if (method === 'POST' && suffix === '/dispatch') return reply(await services.dispatch.handle({ body, ...operator }));
    if (method === 'POST' && suffix === '/communication') return reply(await services.communication.handle({ body, ...operator }));
    if (method === 'POST' && suffix === '/participants/spawn') return reply(await services.sessions.create({ body, ...operator }));
    if (method === 'POST' && suffix === '/collaboration/native') {
      only(body, ['sessionId', 'action', 'requestId', 'attemptId', 'role', 'model', 'task', 'leaseToken', 'phase', 'childSessionId'], 'research-native-request-invalid');
      const parent = get(body.sessionId);
      if (parent.originDeviceId) fail(404, 'research-collaboration-session-not-found');
      const access = await accessFor(parent.cwd, true);
      return reply(await services.collaboration.native(access, body, operator));
    }
    if (method === 'GET') {
      const params = query(url, suffix === '/charter-binding' ? ['cwd', 'sessionId'] : ['cwd']);
      const access = await accessFor(params.cwd);
      if (suffix === '') return reply(await workbench.snapshot(access));
      if (suffix === '/connection') return reply(await workbench.connection(access));
      if (suffix === '/charter-binding') {
        if (params.sessionId !== undefined) validId(params.sessionId);
        return reply(await workbench.charterBinding(access, params.sessionId));
      }
      if (suffix === '/collaboration') return reply(await services.collaboration.snapshot(access));
      if (suffix === '/history-candidates') return reply(await adoption.historyCandidates(access));
      if (suffix === '/models') return reply({ models: await adoption.models(access) });
      if (suffix === '/workbench-sync' && observation) return reply(await observation(access));
      if (policy?.has(suffix)) return reply(await policy.read(suffix, access));
      return null;
    }
    if (method !== 'POST') return null;
    if (suffix === '/charter-binding') {
      if (!validateCharterBinding(body)) fail(400, 'research-charter-binding-invalid-request');
      const access = await accessFor(body.cwd, true);
      return reply(await workbench.updateCharterBinding(access, { ...body, cwd: access.cwd }));
    }
    if (suffix === '/collaboration') {
      only(body, COLLABORATION_FIELDS, 'research-collaboration-request-invalid');
      const access = await accessFor(body.cwd, true);
      return reply(await services.collaboration.mutate(access, body, operator));
    }
    if (suffix === '/participants') {
      only(body, ['cwd', 'sessionId']);
      return reply(await workbench.join(await accessFor(body.cwd, true), validId(body.sessionId)));
    }
    if (suffix === '/reconnect') {
      only(body, ['cwd']);
      return reply(await adoption.reconnect(await accessFor(body.cwd, true)));
    }
    if (policy?.has(suffix)) {
      const access = await accessFor(body.cwd, true);
      return reply(await policy.update(suffix, access, body));
    }
    return null;
  }

  async function sessionRoute(method, suffix, url, body) {
    if (suffix === '' && method === 'GET') return reply({ success: true, data: sessions.listSessions() });
    if (suffix === '' && method === 'POST') {
      only(body, ['cwd', 'sessionId', 'sessionFile', 'model', 'name', 'prompt', 'resume']);
      const access = await accessFor(body.cwd, true);
      if (body.sessionId !== undefined) validId(body.sessionId);
      const result = await sessions.createSession({ ...body, cwd: access.cwd, initialPrompt: body.prompt });
      if (!result.success) fail(409, result.code ?? result.error ?? 'session-start-unconfirmed');
      return reply({ success: true, data: result }, result.duplicate ? 200 : 201);
    }
    const [sessionId, action, ...extra] = suffix.slice(1).split('/');
    if (!IDENTIFIER.test(sessionId)) return null;
    const row = get(sessionId);
    if (method === 'GET' && action === 'models' && extra.length === 0 && modelConfig) {
      const result = await modelConfig.sessionModels(row.id, localOperatorPrincipal);
      return reply({ success: true, data: result.models });
    }
    if (method === 'GET' && action === 'entry' && extra.length === 1 && transcriptEntry) {
      const args = query(url, ['cursor', 'limit']);
      if (args.limit !== undefined) args.limit = Number(args.limit);
      const result = await transcriptEntry(row, validId(extra[0], 'invalid-transcript-entry-id'), args);
      if (result.complete && result.entry?.type === 'custom') {
        return reply({ success: true, data: { customType: result.entry.customType, payload: result.entry.data } });
      }
      return reply({ success: true, data: result }, result.status === 'searching' ? 202 : 200);
    }
    if (extra.length) return null;
    if (method === 'GET' && action === undefined) return reply({ success: true, data: row });
    if (method === 'GET' && action === 'events') {
      const args = query(url, ['after', 'limit']);
      const after = Number(args.after ?? 0), limit = Number(args.limit ?? 200);
      if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) fail(400, 'invalid-event-cursor');
      return reply({ success: true, data: await sessions.readEvents(sessionId, { after, limit }) });
    }
    if (method === 'GET' && action === 'transcript' && transcript) {
      const args = query(url, ['cursor', 'limit']);
      if (args.limit !== undefined) args.limit = Number(args.limit);
      return reply({ success: true, data: await transcript(row, args) });
    }
    if (method !== 'POST') return null;
    if (action === 'command') {
      const type = body.type;
      if (typeof type !== 'string' || !/^[a-z][a-z0-9_]{1,63}$/.test(type)) fail(400, 'native-command-invalid');
      // A new native session under an existing workbench process would lose
      // its durable assignment identity. Direct transcript reads use paging.
      if (['new_session', 'switch_session', 'fork', 'clone', 'get_messages', 'get_entries', 'get_tree'].includes(type)) fail(409, 'native-command-requires-dedicated-route');
      if (row.researchSession?.readOnly === true && ['bash', 'abort_bash'].includes(type)) fail(403, 'research-session-read-only');
      const result = await sessions.command(sessionId, body);
      if (result?.success !== true) fail(409, 'native-command-rejected');
      return reply({ success: true, data: result });
    }
    if (action === 'ui') {
      if (body.type !== 'extension_ui_response' || typeof body.id !== 'string') fail(400, 'native-ui-response-invalid');
      return reply({ success: true, data: await (respondToUi ?? sessions.respondUi)(sessionId, body) });
    }
    if (action === 'abort' || action === 'stop') {
      only(body, []);
      const result = await (action === 'abort' ? sessions.abort(sessionId) : sessions.terminate(sessionId));
      if (result === false || result?.success === false) fail(409, 'native-session-action-unconfirmed');
      return reply({ success: true, data: result ?? null }, result?.state === 'stopping' ? 202 : 200);
    }
    return null;
  }

  return async function handle({ method, pathname, url, body, request }) {
    if (method === 'GET' && pathname === '/api/health') return reply({ success: true, service: 'pi-research-host', apiVersion: 1 });
    if (method === 'GET' && pathname === '/api/acp/agents') return reply({ success: true, data: sessions.acpAgents?.() ?? [] });
    if (method === 'POST' && pathname === '/api/ws-ticket' && mintRealtimeTicket) return reply(await mintRealtimeTicket(request, body));
    if (pathname.startsWith('/api/res-workflow/science/') && science) {
      return science.handle({ method, url, body, rawRequest: request, ...operator });
    }
    const accessResult = accessRoutes && await accessRoutes({ method, pathname, url, body, request });
    if (accessResult) return accessResult;
    const questionResult = questions && await questions.handle({ method, pathname, body, context: operator });
    if (questionResult) return questionResult;
    if (modelConfig && pathname === '/api/model-defaults') {
      if (method === 'GET') return reply({ success: true, data: modelConfig.getDefaults() });
      if (method !== 'PUT') fail(405, 'method-not-allowed');
      const result = await modelConfig.setDefaults(body);
      return reply(result, result.piMirror?.ok === true ? 200 : 503);
    }
    const modelResult = modelConfig && await modelConfig.handle({ method, url, body, ...operator });
    if (modelResult) return modelResult;
    const fileResult = files && await files({ method, pathname, url, body, request, context: operator });
    if (fileResult) return fileResult;
    const sessionResult = sessionCompatibility && await sessionCompatibility({ method, pathname, url, body });
    if (sessionResult) return sessionResult;
    if (pathname === '/api/res-workflow/adoptions' || pathname.startsWith('/api/res-workflow/adoptions/')) {
      return adoptions(method, pathname.slice('/api/res-workflow/adoptions'.length + 1), url, body);
    }
    if (pathname === '/api/res-workflow' || pathname.startsWith('/api/res-workflow/')) {
      return workbenchRoute(method, pathname.slice('/api/res-workflow'.length), url, body);
    }
    if (pathname === '/api/sessions' || pathname.startsWith('/api/sessions/')) {
      return sessionRoute(method, pathname.slice('/api/sessions'.length), url, body);
    }
    if (method === 'POST' && pathname === '/internal/native/register') {
      only(body, ['sessionId', 'cwd', 'sessionFile', 'status', 'header', 'process']);
      if (!['idle', 'streaming', 'ended'].includes(body.status)) fail(400, 'native-session-status-invalid');
      const row = sessions.registerExternalSession({ ...body, sessionId: validId(body.sessionId) });
      return reply({ success: true, data: { sessionId: row.id, hostInstanceId, prompts: sessions.externalInbox(row.id), events: sessions.eventInbox(row.id) } });
    }
    if (method === 'POST' && pathname === '/internal/native/inbox') {
      only(body, ['sessionId', 'cwd', 'sessionFile']);
      const row = get(body.sessionId);
      if (row.cwd !== body.cwd || row.sessionFile !== body.sessionFile) fail(409, 'native-inbox-session-mismatch');
      return reply({ success: true, data: { sessionId: row.id, hostInstanceId, events: sessions.eventInbox(row.id) } });
    }
    if (method === 'POST' && pathname === '/internal/native/mcp-token' && mintMcpToken) {
      only(body, ['sessionId', 'cwd', 'sessionFile']);
      const row = get(body.sessionId);
      if (!row.live || row.cwd !== body.cwd || row.sessionFile !== body.sessionFile) fail(409, 'native-mcp-session-mismatch');
      return reply({ success: true, data: mintMcpToken(row.id) });
    }
    if (method === 'POST' && pathname === '/internal/native/acknowledge') {
      only(body, ['sessionId', 'promptId']);
      await sessions.acknowledgeExternal(validId(body.sessionId), validId(body.promptId, 'invalid-prompt-id'));
      return reply({ success: true });
    }
    if (method === 'POST' && pathname === '/internal/native/event') {
      only(body, ['sessionId', 'event']);
      const row = get(body.sessionId);
      const event = body.event;
      if (!event || typeof event !== 'object' || Array.isArray(event)) fail(400, 'native-event-invalid');
      const raw = ['session_end', 'agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_end', 'turn_end',
        'research_host_control_result', 'tool_execution_start', 'tool_execution_end'].includes(event.type);
      const question = event.type === 'pi-research-question-context';
      const plugin = ['flows_list', 'commands_list'].includes(event.type) || (
        typeof event.eventType === 'string' && /^(?:flow(?:s)?[-_:][a-zA-Z0-9_:-]+|automation[-_:][a-zA-Z0-9_:-]+)$/.test(event.eventType));
      if (!raw && !plugin && !question || raw && !row.external) fail(400, 'native-event-invalid');
      if (row.external) sessions.recordExternalEvent(row.id, event);
      else if (question) {
        if (!row.live) fail(409, 'native-question-session-inactive');
        await questions?.onNativeEvent(row.id, event);
      }
      else supplemental?.onPiEvent(row.id, event);
      return reply({ success: true });
    }
    if (method === 'POST' && pathname === '/internal/native/event-acknowledge') {
      only(body, ['sessionId', 'eventId']);
      const row = get(body.sessionId);
      return reply({ success: true, data: sessions.acknowledgeEvent(row.id, validId(body.eventId, 'invalid-event-id')) });
    }
    if (method === 'POST' && pathname === '/internal/native/event-reject') {
      only(body, ['sessionId', 'eventId', 'reason']);
      const row = get(body.sessionId);
      if (typeof body.reason !== 'string' || !/^[a-z0-9-]{1,96}$/.test(body.reason)) fail(400, 'invalid-native-event-reason');
      return reply({ success: true, data: sessions.rejectEvent(row.id, validId(body.eventId, 'invalid-event-id'), body.reason) });
    }
    if (method === 'POST' && pathname === '/internal/native/plugin' && supplemental) {
      only(body, ['sessionId', 'pluginId', 'name', 'payload']);
      const row = get(body.sessionId);
      if (!row.live) fail(409, 'native-plugin-session-inactive');
      const result = await supplemental.requestPlugin(validId(body.pluginId, 'invalid-plugin-id'), body.name, body.payload, row.id);
      return reply({ success: true, data: result ?? null });
    }
    return supplemental?.handle({ method, pathname, url, body, context: operator }) ?? null;
  };
}
