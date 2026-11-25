import { randomUUID } from 'node:crypto';
import { UUID } from './runtime.mjs';

const rejected = code => ({ type: 'response', success: false, error: code });
const accepted = (command, data) => ({ type: 'response', command, success: true, ...(data !== undefined ? { data } : {}) });

/** Merge ACP into the native host interface without registering fake Pi history. */
export function createAcpSessionFacade({ native, acp, principal, onDiagnostic = () => {} }) {
  const isAcp = id => UUID.test(id ?? '') && !!acp.getSession(id, principal);
  const project = row => row ? { ...row, nativeRegistrationConfirmed: row.ready === true,
    status: row.live && row.agentRunning ? 'streaming' : row.status === 'starting' ? 'active' : row.status,
    currentTool: row.pendingUIRequests?.length ? 'ask_user' : row.currentTool,
    pendingUIRequests: (row.pendingUIRequests ?? []).map(request => ({ ...request, id: request.promptId,
      requestId: request.promptId, method: 'select', title: request.prompt?.question, options: request.prompt?.options })) } : undefined;
  const getSession = id => isAcp(id) ? project(acp.getSession(id, principal)) : native.getSession(id);
  const listSessions = () => {
    const rows = native.listSessions(), seen = new Set(rows.map(row => row.id));
    for (const row of acp.listSessions(principal)) {
      if (seen.has(row.id)) throw new Error('session-driver-identity-conflict');
      rows.push(project(row));
    }
    return rows;
  };
  async function deliverPrompt(id, options) {
    if (!isAcp(id)) return native.deliverPrompt(id, options);
    const promptId = options.promptId ?? randomUUID();
    let off, timer;
    const acknowledgement = new Promise((resolve, reject) => {
      off = acp.onEvent((sessionId, message) => {
        if (sessionId === id && message.type === 'prompt_received' && message.promptId === promptId) resolve({ accepted: true, disposition: 'accepted', promptId });
      });
      timer = setTimeout(() => reject(Object.assign(new Error('session-prompt-acceptance-unconfirmed'),
        { code: 'session-prompt-acceptance-unconfirmed', promptId, pending: true })), options.acceptanceTimeoutMs ?? 30_000);
    });
    // Attach a rejection handler immediately while the transport request is pending.
    acknowledgement.catch(() => {});
    try {
      const result = await acp.prompt(id, options.text, { ...options, promptId }, principal);
      if (result.status === 'accepted') return { accepted: true, disposition: 'accepted', promptId, duplicate: result.duplicate === true };
      if (!result.delivered && result.status !== 'unknown') return { accepted: false, rejected: true, reason: result.reason ?? 'acp-session-ended' };
      return await acknowledgement;
    } finally { clearTimeout(timer); off?.(); }
  }
  async function startAcp(input) {
    if (native.getSession(input.sessionId ?? '__acp_new__')) return { success: false, message: 'session-driver-identity-conflict' };
    let launchedId;
    try {
      if (input.sessionId && UUID.test(input.sessionId)) {
        const previous = acp.getSession(input.sessionId, principal);
        if (previous) {
          if (previous.cwd !== input.cwd || previous.acpAgentId !== (input.agent ?? input.agentId)
            || previous.spawnToken !== input.spawnToken) return { success: false, message: 'session-idempotency-conflict' };
          if (!previous.live) return { success: false, message: 'acp-ended-session-cannot-resume', sessionId: previous.id };
          if (!previous.ready || previous.initialPromptStatus === 'unknown') return { success: false, message: 'acp-session-launch-outcome-unknown', sessionId: previous.id };
          return { success: true, sessionId: previous.id, sessionFile: previous.sessionFile, pid: previous.pid,
            nativeRegistrationConfirmed: true, driver: 'acp', duplicate: true };
        }
      }
      const row = await acp.start(input, principal);
      launchedId = row.id;
      if (input.name !== undefined || input.metadata) {
        const patch = { ...(input.metadata ?? {}), ...(input.name !== undefined ? { name: input.name } : {}) };
        if (Object.keys(patch).length) await acp.updateSession(row.id, patch, principal);
      }
      // Automation's trusted plugin spawn used the initial-prompt registry for ACP too.
      if (typeof input.prompt === 'string' && input.prompt.length) {
        await acp.updateSession(row.id, { initialPromptStatus: 'unknown' }, principal);
        await deliverPrompt(row.id, { text: input.prompt, promptId: 'initial-' + row.id, delivery: 'steer' });
        await acp.updateSession(row.id, { initialPromptStatus: 'accepted' }, principal);
      }
      return { success: true, sessionId: row.id, sessionFile: row.sessionFile, pid: row.pid,
        nativeRegistrationConfirmed: true, driver: 'acp' };
    } catch (error) { return { success: false, code: error.code ?? 'acp-start-failed', message: error.message, ...((error.sessionId ?? launchedId) ? { sessionId: error.sessionId ?? launchedId } : {}) }; }
  }
  async function command(id, value) {
    if (!isAcp(id)) return native.command(id, value);
    if (!value || typeof value.type !== 'string') return rejected('acp-command-invalid');
    if (value.type === 'prompt') {
      const result = await deliverPrompt(id, { text: value.message ?? value.text, images: value.images,
        promptId: value.promptId, delivery: value.streamingBehavior ?? value.delivery ?? 'steer' });
      return result.accepted ? accepted(value.type, result) : rejected(result.reason);
    }
    if (value.type === 'get_state') {
      const row = getSession(id);
      return accepted(value.type, { ...row, sessionId: id, isStreaming: row.agentRunning === true,
        isCompacting: false, pendingMessageCount: row.followUp?.length ?? 0 });
    }
    if (value.type === 'get_available_models') return accepted(value.type, { models: getSession(id).models ?? [] });
    if (value.type === 'get_commands') return accepted(value.type, { commands: getSession(id).commands ?? [] });
    if (value.type === 'set_session_name') {
      await acp.updateSession(id, { name: value.name }, principal); return accepted(value.type);
    }
    const type = value.type === 'set_thinking_level' ? 'set_thinking_level' : value.type;
    const message = { ...value, type, sessionId: id };
    if (type === 'set_thinking_level') {
      if (typeof getSession(id).thinkingLevel !== 'string') return rejected('acp-thinking-level-unavailable');
      message.level = value.level ?? value.thinkingLevel;
    }
    if (type === 'set_model') {
      const row = getSession(id);
      const modelId = value.modelId ?? value.id;
      if (value.provider !== `acp:${row.acpAgentId}` || !row.models?.some(model => model.id === modelId)) return rejected('acp-model-unavailable');
      message.modelId = modelId;
    }
    if (!['abort', 'set_model', 'set_thinking_level', 'clear_followup_entries', 'edit_followup_entry',
      'remove_followup_entry', 'promote_followup_entry', 'request_state_sync', 'request_models', 'request_commands', 'prompt_resync_request'].includes(type)) return rejected('acp-command-unsupported');
    return await acp.send(id, message, principal) ? accepted(value.type) : rejected('acp-session-ended');
  }
  async function respondUI(id, response) {
    if (!isAcp(id)) return (native.respondUI ?? native.respondUi)(id, response);
    const ok = await acp.send(id, { type: 'prompt_response', sessionId: id, promptId: response.id,
      answer: response.value ?? response.answer, cancelled: response.cancelled }, principal);
    return { accepted: ok, success: ok };
  }
  async function terminate(id) {
    if (!isAcp(id)) return native.terminate(id);
    const row = await acp.stop(id, principal);
    return { stopped: row?.live === false, workerExited: row?.live === false, state: row?.live === false ? 'stopped' : 'stopping' };
  }
  function subscribeEvents(handler) {
    const stopNative = native.subscribeEvents?.(handler);
    const stopAcp = acp.onEvent(handler);
    for (const row of acp.listSessions(principal)) if (row.live && row.durable) acp.reconnect(row.id, principal).catch(error => onDiagnostic(error.code ?? error.message));
    return () => { stopNative?.(); stopAcp(); };
  }
  return { ...native, getSession, listSessions, startAcp, spawnAcp: startAcp, acpAgents: acp.agents, command, deliverPrompt,
    send: (id, message) => isAcp(id) ? acp.send(id, message, principal) : native.send?.(id, message),
    abort: id => isAcp(id) ? command(id, { type: 'abort' }) : native.abort(id), terminate, respondUI, respondUi: respondUI,
    readEvents: (id, query) => isAcp(id) ? acp.readEvents(id, query, principal) : native.readEvents(id, query),
    deleteArchivedSession: id => isAcp(id) ? acp.deleteArchivedSession(id, principal) : native.deleteArchivedSession(id),
    updateSession: (id, patch) => isAcp(id) ? acp.updateSession(id, patch, principal) : native.updateSession(id, patch),
    updateSessionMeta: (id, patch) => isAcp(id) ? acp.updateSession(id, patch, principal) : (native.updateSessionMeta ?? native.updateSession)(id, patch),
    notifyParent: async (id, text, promptId) => isAcp(id) ? (await deliverPrompt(id, { text, promptId })).accepted : native.notifyParent(id, text, promptId),
    subscribeEvents,
    subscribeReceiptAcks(handler) {
      const stopNative = native.subscribeReceiptAcks?.(handler);
      const stopAcp = acp.onEvent((id, message) => { if (message.type === 'prompt_received') handler(id, message.promptId); });
      return () => { stopNative?.(); stopAcp(); };
    },
  };
}
