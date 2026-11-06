/** Native bounded DAG execution and the collaborator plan-first runtime gate. */
import { readWorkbenchRecordContext } from './workbench-context.mjs';
import { readBoundedJson, readDashboardLocalAuth, RESEARCH_DISPATCH_TASK_SCHEMA } from './workbench-session-tool.mjs';
import { mergeDelegationRestrictions } from './delegation-policy.mjs';

const SAFE_READS = new Set(['read', 'grep', 'find', 'ls', 'web_search', 'fetch_content']);
const COORDINATION = new Set(['ask_user', 'ask_user_question']);
const LOOP_COORDINATION = new Set(['status', 'log', 'report']);
// Status contains up to 24 scoped tasks plus one prerequisite receipt set.
// Keep a finite cap that includes worst-case JSON escaping as well as UTF-8.
export const RESEARCH_DISPATCH_RESPONSE_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const result = (value, error = false) => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], details: value, ...(error ? { isError: true } : {}) });
const blocked = code => result({ status: 'blocked', tool: 'research_dispatch', error: code }, true);

export function createResearchDispatchClient(options = {}) {
  const readContext = options.readContext ?? readWorkbenchRecordContext;
  return async (ctx, params, signal) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const joined = await readContext(ctx);
    if (!joined || joined.sessionId !== sessionId) throw new Error('research-dispatch-session-not-joined');
    const auth = await (options.resolveAuth ?? (() => readDashboardLocalAuth(options.authOptions)))();
    const target = new URL('/api/res-workflow/dispatch', auth.baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname)) throw new Error('research-dispatch-destination-not-loopback');
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
    const response = await (options.fetchImpl ?? globalThis.fetch)(target, {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/json', 'x-pi-local-token': auth.token },
      body: JSON.stringify({ ...params, sessionId }),
      signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout,
    });
    const reply = await readBoundedJson(response, RESEARCH_DISPATCH_RESPONSE_BYTES);
    if (!response.ok || !object(reply) || reply.status !== 'ok') {
      throw new Error(typeof reply?.code === 'string' && /^[a-z0-9-]{1,100}$/.test(reply.code) ? reply.code : 'research-dispatch-unavailable');
    }
    return reply;
  };
}

export function registerWorkbenchDispatchTool(pi, options = {}) {
  const request = options.request ?? createResearchDispatchClient(options);
  const readContext = options.readContext ?? readWorkbenchRecordContext;
  const states = new Map();
  function state(ctx) {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (!id) return null;
    if (!states.has(id)) {
      if (states.size >= 128) states.delete(states.keys().next().value);
      states.set(id, { reads: 0, restrictions: undefined });
    }
    return states.get(id);
  }
  const tool = {
    name: 'research_dispatch', label: 'Research task executor',
    description: 'Execute a bounded task DAG using real child Pi sessions. plan validates and immediately schedules 2-12 tasks with dependencies and bounded concurrency; status reads persisted receipts; atomic records why one task is indivisible; report submits this child assignment result and rejects completion while its own children are pending. Declared research_session.tasks are automatically dispatched by the server after registration. The model chooses the semantic decomposition; scheduling and completion enforcement are deterministic.',
    promptSnippet: 'Use a task DAG for separable work; the executor creates children, enforces dependencies and requires their reports.',
    promptGuidelines: [
      'For a collaborator with several separable jobs, call plan before bulk implementation. Use stable planId for retries.',
      'For one indivisible assignment, call atomic with a concrete reason; do not create artificial empty subtasks.',
      'Call status before work to read dependency result receipts. Coordinate while children are running; the server notifies this session when their plan terminates.',
      'Report completed/failed/blocked only for your own assignment with an accurate summary and relative evidence paths. Child failures cannot be hidden behind completed.',
      'Respect the original user scope, explicit no-delegate/no-export restrictions, shared budget and inherited permissions.',
    ],
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['plan', 'status', 'atomic', 'report', 'cancel'] },
        planId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'Stable client plan key; reuse exactly on a retry.' },
        tasks: { type: 'array', minItems: 2, maxItems: 12, items: RESEARCH_DISPATCH_TASK_SCHEMA },
        concurrency: { type: 'integer', minimum: 1, maximum: 3, description: 'Maximum runnable children in this plan; default 2.' },
        reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'For atomic: why the assignment is indivisible. For cancel: why to stop scheduling the named plan; running processes are not killed.' },
        status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        evidence: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 1024 }, description: 'Relative files containing the evidence; no absolute paths or parent traversal.' },
      },
    },
    executionMode: 'sequential', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      if (params?.action === 'plan' && state(ctx)?.restrictions?.blocked) return blocked('research-dispatch-user-restricted');
      // Only schema fields are forwarded; runtime identity always wins.
      const body = {};
      for (const key of ['action', 'planId', 'tasks', 'concurrency', 'reason', 'status', 'summary', 'evidence']) if (params?.[key] !== undefined) body[key] = params[key];
      try {
        const snapshot = await request(ctx, body, signal), local = state(ctx);
        if (local) { local.managed = snapshot.collaborator || snapshot.plans?.length > 0; if (params.action === 'report') local.reportReminders = 0; }
        return result(snapshot);
      }
      catch (error) { return blocked(/^[a-z0-9-]{1,100}$/.test(error?.message ?? '') ? error.message : 'research-dispatch-unavailable'); }
    },
  };
  pi.registerTool(tool);
  if (typeof pi.on !== 'function') return tool;
  pi.on('before_agent_start', (event, ctx) => {
    const local = state(ctx);
    if (local) { local.reads = 0; local.restrictions = mergeDelegationRestrictions(local.restrictions, event?.prompt ?? ''); }
  });
  pi.on('input', (event, ctx) => {
    if (event?.source !== 'user') return;
    const local = state(ctx);
    if (local) local.restrictions = mergeDelegationRestrictions(local.restrictions, event?.text ?? '');
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!event?.toolName || event.toolName === 'research_dispatch') return;
    const local = state(ctx);
    if (!local) return;
    let joined;
    try { joined = await readContext(ctx); } catch { return; }
    if (!joined) return;
    if (joined.researchSession) local.managed = true;
    if (local.restrictions?.blocked && ['research_session', 'subagent', 'Agent', 'SubagentWorkflow'].includes(event.toolName)) {
      return { block: true, reason: 'The user explicitly restricted delegation or external export. Work within that restriction.' };
    }
    // Only true read tools get a small planning window. A shell cannot masquerade
    // as a safe read; simple one-item work uses a recorded atomic decision.
    if (SAFE_READS.has(event.toolName) && ++local.reads <= 3) return;
    let snapshot;
    try { snapshot = await request(ctx, { action: 'status' }); }
    catch {
      // Joined lead sessions retain their existing workflow when this optional
      // service is absent. A known dispatcher child fails closed on loss.
      if (local.managed) return { block: true, reason: 'research_dispatch status is unavailable. Restore the dispatcher before executing this managed assignment; no child will be duplicated.' };
      return;
    }
    local.managed = snapshot.collaborator || snapshot.plans?.length > 0;
    const safeRead = SAFE_READS.has(event.toolName);
    const coordination = COORDINATION.has(event.toolName) || (event.toolName === 'research_loop' && LOOP_COORDINATION.has(event.input?.action));
    if (TERMINAL.has(snapshot.assignment?.status) && !safeRead && !coordination) {
      return { block: true, reason: 'This dispatcher assignment is already terminal. Inspect its receipt or return the conclusion; do not restart or duplicate its work.' };
    }
    if (snapshot.childrenPending && !safeRead && !coordination) {
      return { block: true, reason: 'The executor has dispatched this work. Coordinate or inspect its child receipts; bulk implementation, research_loop run/configure/stage/claim/publish and completion are gated until the children report. Use research_dispatch status for the dependencies and results.' };
    }
    if (!coordination && ((snapshot.declaredTasks > 0 && !snapshot.plans?.length) || snapshot.decisionRequired)) {
      return { block: true, reason: 'Before bulk work, declare separable jobs with research_dispatch plan. For one indivisible assignment, call research_dispatch atomic with a concrete reason. A supplied structured task list cannot be replaced by atomic execution.' };
    }

  });
  // Natural-language final answers do not satisfy the execution contract.
  // Two bounded continuations ask for the explicit receipt; a third unreported
  // ending records blocked, never an invented success. Coordinators waiting on
  // children sleep until the server's durable receipt wakes them.
  pi.on('agent_end', async (_event, ctx) => {
    const local = state(ctx);
    if (!local || local.finishing) return;
    local.finishing = true;
    try {
      const snapshot = await request(ctx, { action: 'status' });
      if (!snapshot.assignment || TERMINAL.has(snapshot.assignment.status) || snapshot.childrenPending) return;
      if ((local.reportReminders ?? 0) < 2 && typeof pi.sendUserMessage === 'function') {
        local.reportReminders = (local.reportReminders ?? 0) + 1;
        pi.sendUserMessage('[research_dispatch completion contract] This assignment has no authenticated result receipt yet. If separable work remains, declare its plan; otherwise report completed, failed or blocked with the actual findings and relative evidence paths. Natural-language final text alone does not complete the task.', { deliverAs: 'followUp' });
      } else {
        await request(ctx, { action: 'report', status: 'blocked', summary: 'The child ended without a structured result receipt after the bounded completion reminders. Review its transcript; no successful outcome has been inferred.', evidence: [] });
      }
    } catch { /* Host ledger retains the unresolved assignment; never auto-success. */ }
    finally { local.finishing = false; }
  });
  return tool;
}
