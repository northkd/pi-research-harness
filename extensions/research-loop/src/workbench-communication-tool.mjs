import { requireWorkbenchRecordContext } from './workbench-context.mjs';
import { readBoundedJson, readDashboardLocalAuth } from './workbench-session-tool.mjs';
import { checkResearchRetirement } from './retirement-check.mjs';
import { createLocalRetirementProbe } from './retirement-probe.mjs';

const ACTIONS = ['send', 'pending', 'ack', 'reply', 'report', 'status'];
const FIELDS = ['action', 'requestId', 'to', 'kind', 'summary', 'evidence', 'messageId', 'status', 'cursor'];
const PEER_ERRORS = {
  'research-communication-peer-queued': { nextAction: 'send-async-memo-or-contact-parent', message: 'Peer is queued. Send progress or decision to its taskId for deferred delivery, or ask parent for an urgent decision. Queue order remains in force.' },
  'research-communication-peer-ended': { nextAction: 'contact-parent', message: 'Peer has ended. Escalate to parent using the existing scope and a new requestId.' },
  'research-communication-peer-loop-limit': { nextAction: 'contact-parent', message: 'This pair reached 8 direct peer messages (4 rounds) in this plan. Escalate the remaining question to parent.' },
  'research-communication-peer-settled': { nextAction: 'contact-parent', message: 'This peer request is settled because one assignment or session ended. Escalate unresolved work to parent.' },
};
const result = (value, error = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(error ? { isError: true } : {}) });

export function createResearchCommunicationClient(options = {}) {
  return async (ctx, params, signal) => {
    const joined = await (options.readContext ?? requireWorkbenchRecordContext)(ctx);
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    if (!joined || joined.sessionId !== sessionId) throw new Error('research-communication-session-not-joined');
    if (Object.keys(params).some(key => !FIELDS.includes(key))) throw new Error('research-communication-unknown-field');
    const auth = await (options.resolveAuth ?? (() => readDashboardLocalAuth(options.authOptions)))();
    const url = new URL('/api/res-workflow/communication', auth.baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) throw new Error('research-communication-destination-not-loopback');
    const response = await (options.fetchImpl ?? globalThis.fetch)(url, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-pi-local-token': auth.token },
      body: JSON.stringify({ ...params, sessionId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    });
    const value = await readBoundedJson(response, 24 * 1024);
    if (!response.ok || value?.status !== 'ok') throw new Error(value?.code ?? 'research-communication-unavailable');
    return value;
  };
}

export function registerWorkbenchCommunicationTool(pi, options = {}) {
  const request = options.request ?? createResearchCommunicationClient(options);
  const recovery = new Map();
  const retirements = new Map();
  const tool = {
    name: 'research_communication', label: 'Research communication',
    description: 'Durable communication between verified direct parents/children and same-plan peers in this research workbench. Send a request/progress/decision, reply to an exact request, explicitly ack handled messages, or report your own result to parent. Peer addressing accepts sessionId or taskId; queued tasks accept deferred progress/decision by taskId. Send progress/decision to peers for a team broadcast. This works for formal research_session collaborators; contact_supervisor belongs to ordinary subagents. The server verifies scope and lineage and retains messages across restarts. Delivery acknowledgements do not mean processing. Messages preserve existing assignment and permission boundaries.',
    promptSnippet: 'Handle parent/child and same-plan peer messages through a durable native channel; use dispatch status peers for discovery and report results to parent.',
    promptGuidelines: [
      'For formal parent-child help, send kind=request to parent; its reply resolves the exact request. Escalate only what exceeds your existing authority.',
      'Use research_dispatch status peers to discover only your own plan teammates. Same-plan peers must share dispatchId, direct parent, tenure and verified workbench scope. Send/reply to in_progress peers by sessionId or taskId. Reports always go to parent.',
      'queued peers accept only progress/decision addressed by taskId as deferred notes. They appear at scheduled startup without waking the task or changing the queue. Requests to queued peers and messages to ended peers are refused; ask parent for urgent or unresolved work.',
      'Broadcast with action=send, to=peers and kind=progress or decision. Each teammate receives an independently acknowledged message; ended teammates are skipped. Request broadcasts, reply broadcasts and report broadcasts are refused.',
      'A same-plan pair may exchange at most 8 direct peer messages (4 rounds); broadcast copies are excluded. At research-communication-peer-loop-limit escalate to parent. Peer messages grant no new assignment, scope, readOnly/noExport exception or permission.',
      'An unresolved peer request becomes peerSettled when either assignment or session ends. It stays visible for escalation to parent and stops holding retirement. Treat research-communication-peer-settled and research-communication-peer-ended as terminal for that peer exchange.',
      'Keep a stable requestId on retries. Changed content requires a new ID. Do not copy raw transcripts or thinking; send a concise summary and relative evidence references.',
      'Routine progress and partial checkpoints are saved silently; status includes them. Use request for help or a decision requiring action, and report completed/blocked/failed for a result. These actionable messages notify the recipient automatically.',
      'pending lists actionable unprocessed messages and unanswered requests. Read and act, then reply to requests or ack other messages. An ack alone does not resolve a request. Wait for native notifications instead of repeatedly polling inboxes, dispatch status or resources.',
      'Direct formal collaborators report completed/partial/blocked/failed here, with actual findings. Assigned dispatcher results are forwarded to their real dispatcher assignment.',
      'A settled dispatcher assignment cannot be reopened by request, reply or decision. On research-communication-assignment-settled, no work was started: create a new supplementary dispatcher task with new planId/taskId within the approved scope; do not retry resuming the old assignment. Unassigned direct collaborators may resume only after current shared-capacity admission.',
      'Each branch decides its own later decomposition within the approved scope. The lead coordinates cross-branch questions and user decisions; later child tasks do not require repeated user approval.',
      'Preserve user stop/no-delegate, read-only, egress, resource and publication boundaries. Do not treat a reply as a grant or a reason to bypass a denied operation.',
    ],
    parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
      action: { type: 'string', enum: ACTIONS, description: 'send targets parent, a direct child or same-plan peer; peers broadcast supports send only. reply uses an exact received request; report targets parent only.' },
      requestId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'Stable intent ID required for send/reply/report.' },
      to: { type: 'string', description: 'parent (default), parent sessionId, direct child sessionId, or same-plan peer sessionId/taskId. A queued peer requires taskId and progress/decision. peers broadcasts progress/decision on send only. Ended peers are refused; report requires parent.' },
      kind: { type: 'string', enum: ['progress', 'request', 'decision'] },
      summary: { type: 'string', minLength: 1, maxLength: 4000 },
      evidence: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 1024 } },
      messageId: { type: 'string', description: 'Exact received message for ack/reply.' },
      cursor: { type: 'string', description: 'For pending/status pagination, reuse nextCursor to see messages beyond a bounded page.' },
      status: { type: 'string', enum: ['completed', 'partial', 'blocked', 'failed'] },
    } },
    async execute(_id, params, signal, _update, ctx) {
      try {
        const value = await request(ctx, params, signal);
        if (params.action === 'report' && value.reportReceipt && params.status !== 'partial') retirements.set(ctx.sessionManager.getSessionId(), value.reportReceipt);
        return result(value);
      }
      catch (error) {
        const code = /^[a-z0-9-]+$/.test(error?.message ?? '') ? error.message : 'research-communication-unavailable';
        return result({ status: 'blocked', tool: 'research_communication', error: code,
          ...(PEER_ERRORS[code] ? { retryable: false, ...PEER_ERRORS[code] } : {}),
          ...(code === 'research-communication-assignment-settled' ? {
            started: false, retryable: false, nextAction: 'create-new-dispatch-task',
            message: '未启动：该子会话的派发任务已结算。请在原有授权范围内使用新的 planId / taskId 建立补充任务，不要重试恢复旧 assignment。',
          } : {}),
        }, true);
      }
    },
  };
  pi.registerTool(tool);
  if (typeof pi.on === 'function') pi.on('agent_settled', async (_event, ctx) => {
    const id = ctx?.sessionManager?.getSessionId?.(), report = retirements.get(id);
    if (!report || typeof ctx.shutdown !== 'function') return;
    try {
      const binding = await (options.readContext ?? requireWorkbenchRecordContext)(ctx);
      const checked = await checkResearchRetirement(ctx, { settled: true, binding, report,
        probe: options.retirementProbe ?? createLocalRetirementProbe({ request: body => request(ctx, body), reportId: report.id }) });
      if (checked.ready) { retirements.delete(id); ctx.shutdown(); }
      else ctx.ui?.setStatus?.('research-retirement', '交付已保存；等待回收核验：' + checked.reasons.join(', '));
    } catch { ctx.ui?.setStatus?.('research-retirement', '交付已保存；回收状态尚未核实'); }
  });
  if (typeof pi.on === 'function' && typeof pi.sendUserMessage === 'function') {
    const recover = async (event, ctx) => {
      const final = event?.messages?.findLast?.(message => message.role === 'assistant');
      if (['aborted', 'error'].includes(final?.stopReason) || event?.aborted === true || event?.willRetry === true) return;
      if (ctx?.hasPendingMessages?.()) return;
      try {
        const inbox = await request(ctx, { action: 'pending' });
        const pending = (inbox.messages ?? []).filter(message => !message.peerSettled && message.kind !== 'progress'
          && !(message.kind === 'result' && message.status === 'partial')
          && (!message.processed || message.kind === 'request' && !message.resolved));
        if (!pending.length) { recovery.delete(inbox.sessionId); return; }
        const signature = pending.map(message => message.id).join(',');
        const state = recovery.get(inbox.sessionId);
        if (state?.signature === signature && state.reminders >= 2) return;
        if (recovery.size >= 128) recovery.delete(recovery.keys().next().value);
        recovery.set(inbox.sessionId, { signature, reminders: state?.signature === signature ? state.reminders + 1 : 1 });
        pi.sendUserMessage('[research_communication recovery] Durable research messages remain unprocessed. Call research_communication pending; handle live requests, escalate peerSettled questions to parent and ack handled messages. Respect the latest user stop, assignment and scope instructions.', { deliverAs: 'followUp' });
      } catch { /* No verified membership or disconnected host: retain the server inbox. */ }
    };
    pi.on('session_start', recover);
    pi.on('agent_end', recover);
  }
  return tool;
}
