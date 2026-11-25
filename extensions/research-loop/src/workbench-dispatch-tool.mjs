/** Native bounded DAG execution and the collaborator plan-first runtime gate. */
import { inspectWorkbenchRecordContext, requireWorkbenchRecordContext } from './workbench-context.mjs';
import { readBoundedJson, readDashboardLocalAuth, RESEARCH_DISPATCH_TASK_SCHEMA, RESEARCH_SESSION_STAGES } from './workbench-session-tool.mjs';
import { mergeDelegationEventRestrictions } from './delegation-policy.mjs';
import { projectDispatchContext } from './dispatch-context.mjs';

const SAFE_READS = new Set(['read', 'grep', 'find', 'ls', 'web_search', 'fetch_content']);
const COORDINATION = new Set(['ask_user', 'ask_user_question', 'research_communication']);
const LOOP_COORDINATION = new Set(['status', 'log', 'report']);
// Status contains bounded per-plan tasks plus one prerequisite receipt set.
// Keep a finite cap that includes worst-case JSON escaping as well as UTF-8.
export const RESEARCH_DISPATCH_RESPONSE_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(['completed', 'failed', 'blocked']);
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const result = (value, error = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(error ? { isError: true } : {}) });
const blocked = code => result({ status: 'blocked', tool: 'research_dispatch', error: code }, true);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const APPROVAL_ENTRY = 'research-dispatch-scope-approval';
const approvalScope = (ctx, joined) => JSON.stringify([
  ctx?.cwd ?? joined.cwd ?? null, joined.ownerKey ?? null, joined.sessionId, joined.adoptionId, joined.charterHash,
]);
function nativeEntries(ctx) {
  try { return ctx?.sessionManager?.getEntries?.() ?? []; } catch { return []; }
}
function savedScopeApproval(ctx, scope) {
  return nativeEntries(ctx).some(entry => entry.type === 'custom' && entry.customType === APPROVAL_ENTRY
    && entry.data?.schema === 'pi-research-dispatch-scope-approval.v1' && entry.data.scope === scope
    && entry.data.approved === true && ['native-ui', 'prior-native-plan'].includes(entry.data.source));
}
function successfulNativePlans(ctx) {
  const calls = new Map(), plans = new Set();
  for (const entry of nativeEntries(ctx)) {
    if (entry.type !== 'message') continue;
    const message = entry.message;
    if (message?.role === 'assistant' && Array.isArray(message.content)) {
      for (const call of message.content) if (call.type === 'toolCall' && call.name === 'research_dispatch'
          && ['plan', 'delegate'].includes(call.arguments?.action) && ID.test(call.arguments?.planId ?? '')) {
        calls.set(call.id, { planId: call.arguments.planId, action: call.arguments.action });
      }
    } else if (message?.role === 'toolResult' && message.toolName === 'research_dispatch' && message.isError !== true) {
      const call = calls.get(message.toolCallId);
      if (call && message.details?.status === 'ok' && message.details.action === call.action) plans.add(call.planId);
    }
  }
  return plans;
}
const DIRECT_HANDOFF_HINT = 'This verified direct research_session has no dispatcher assignment. Use research_communication report for the durable parent receipt, with authorized HANDOFF/evidence references as artifacts. Preserve failed or partial work. Delivery, scientific acceptance and native process exit are separate. Do not retry dispatcher report or invent an assignment.';

function hasDirectHandoff(joined, snapshot, sessionId) {
  return joined?.sessionId === sessionId && ID.test(sessionId ?? '')
    && joined.researchSession?.origin === 'research_session'
    && joined.researchSession?.dispatcherManaged === false
    && snapshot?.status === 'ok' && snapshot.sessionId === sessionId
    && snapshot.collaborator === true && snapshot.assignment === null;
}

/** A verified direct assignment may decompose its own approved branch. */
export function isDirectResearchWorker(joined, snapshot, sessionId = joined?.sessionId) {
  const worker = joined?.researchSession;
  return object(worker) && ID.test(joined?.sessionId ?? '') && joined.sessionId === sessionId
    && worker.origin === 'research_session' && Number.isInteger(worker.depth) && worker.depth >= 1 && worker.depth <= 3 && worker.readOnly !== true
    && ID.test(worker.parentSessionId ?? '') && ID.test(worker.rootSessionId ?? '')
    && worker.parentSessionId !== joined.sessionId && worker.dispatcherManaged === false && worker.declaredTasks === 0
    && snapshot?.status === 'ok' && snapshot.sessionId === joined.sessionId && snapshot.collaborator === true
    && snapshot.assignment === null && snapshot.declaredTasks === 0 && snapshot.childrenPending === false
    && Array.isArray(snapshot.plans) && snapshot.plans.length === 0 && snapshot.atomicReason == null;
}

export function createResearchDispatchClient(options = {}) {
  const readContext = options.readContext ?? (ctx => requireWorkbenchRecordContext(ctx, options.contextOptions, 'research-dispatch-session-not-joined'));
  return async (ctx, params, signal) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const joined = await readContext(ctx);
    if (!joined || joined.sessionId !== sessionId || ctx?.sessionManager?.getSessionId?.() !== sessionId) throw new Error('research-dispatch-session-not-joined');
    const { ownerKey, cwd, adoptionId, charterHash } = joined;
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
    const current = await readContext(ctx);
    if (reply.sessionId !== sessionId || ctx?.sessionManager?.getSessionId?.() !== sessionId || current?.sessionId !== sessionId
        || current.ownerKey !== ownerKey || current.cwd !== cwd
        || current.adoptionId !== adoptionId || current.charterHash !== charterHash) {
      throw new Error('research-dispatch-response-scope-changed');
    }
    if (['plan', 'delegate'].includes(params.action)
        && !reply.plans?.some(plan => plan?.clientPlanId === params.planId)) {
      throw new Error('research-dispatch-plan-effect-unconfirmed');
    }
    return reply;
  };
}

export function registerWorkbenchDispatchTool(pi, options = {}) {
  const request = options.request ?? createResearchDispatchClient(options);
  const readContext = options.readContext ?? (ctx => requireWorkbenchRecordContext(ctx, options.contextOptions, 'research-dispatch-session-not-joined'));
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
    description: 'Schedule an explicit approved research task plan. The lead decomposes the initial scope and obtains user confirmation; branch owners autonomously plan their later children within that scope. plan schedules a dependency graph of 1-64 tasks. delegate optionally introduces a coordinator when useful. pause stops new launches while in-flight work finishes; resume restarts that queue. Reports, scientific acceptance and process exit stay separate.',
    promptSnippet: 'The lead confirms the initial plan once; branch owners schedule later work and use research_communication for durable help and results.',
    promptGuidelines: [
      'The lead is the user-facing research owner. Decompose the initial work, present it for confirmation, then submit plan. Do not insert a mandatory coordinator between the lead and branches.',
      'Submit the initial plan directly: this tool owns the one native confirmation for the frozen goal. Do not ask_user to confirm the same plan beforehand. Later in-scope plans, replacements and branch decomposition reuse that goal approval, including after reload.',
      'Branch owners choose subsequent decomposition and roles within their inherited task and permissions; do not send each ordinary child launch back to the user or lead for approval.',
      'The initial decomposition names branch responsibilities and outputs. Leave later in-scope decomposition to each branch; reserve no-nesting instructions for genuinely indivisible leaves instead of applying them to every branch.',
      'For a collaborator with several separable jobs, call plan before bulk implementation. Use stable planId for retries.',
      'Prepare every task and dependency before submitting the plan, including work beyond current concurrency. The server persists the full queue first, launches only eligible tasks within live Main/Multi limits, and advances it without another model turn. Do not issue a burst of direct research_session calls: refused direct calls are not queued.',
      'For one indivisible assignment, call atomic with a concrete reason; do not create artificial empty subtasks.',
      'Call status before work. Detailed task/receipt data is paged: use view:detail with planId and taskId, a direct dependency taskId, or taskId:self for the original assignment; continue at nextOffset with the same recordHash until complete when the full brief is required.',
      'Dispatch runs autonomously. Wait for task/plan completion or actionable exception notifications instead of repeated status/resource polling or duplicate exploration. Verify the referenced evidence before scientific acceptance. The lead decides scope and unresolved questions; branch owners handle their detailed execution and evidence review.',
      'Default replies contain bounded summaries and evidence references, never whole child transcripts. Unchanged status is acknowledged briefly; refresh:true returns the current summary after compaction if needed.',
      'Report completed/failed/blocked only for your own assignment with an accurate summary and relative evidence paths. Child failures cannot be hidden behind completed.',
      'Respect the original user scope, explicit no-delegate/no-export restrictions and inherited permissions.',
    ],
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['delegate', 'plan', 'status', 'atomic', 'report', 'cancel', 'pause', 'resume'] },
        planId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'Stable client plan key; reuse exactly on a retry.' },
        task: { type: 'string', minLength: 1, maxLength: 4000, description: 'For delegate: the goal, mandatory constraints, acceptance criteria and relevant file references. Do not copy the whole conversation.' },
        stage: { type: 'string', enum: RESEARCH_SESSION_STAGES },
        tasks: { type: 'array', minItems: 1, maxItems: 64, items: RESEARCH_DISPATCH_TASK_SCHEMA },
        concurrency: { type: 'integer', minimum: 1, maximum: 64, description: 'Legacy fallback concurrency (default 2). A managed workbench uses its current live Main/Multi concurrency settings; this field cannot override them.' },
        reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'For atomic: why the assignment is indivisible. For cancel: why to stop scheduling the named plan; running processes are not killed.' },
        status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        evidence: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 1024 }, description: 'Relative files containing the evidence; no absolute paths or parent traversal.' },
        view: { type: 'string', enum: ['summary', 'detail'], description: 'Default summary is at most 8 KiB; explicit detail is paged at most 16 KiB per reply.' },
        taskId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'Detail target within planId, a direct prerequisite task ID, or self for your original assignment.' },
        offset: { type: 'integer', minimum: 0, description: 'For detail: use the preceding page nextOffset. UTF-16 character offset in the serialized record.' },
        recordHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'For continuation: copy the preceding detail page recordHash. A changed record is rejected rather than mixing evidence pages.' },
        refresh: { type: 'boolean', description: 'Return the current summary even if unchanged, for example after context compaction.' },
      },
    },
    executionMode: 'sequential', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      if (['plan', 'delegate', 'resume'].includes(params?.action) && state(ctx)?.restrictions?.blocked) return blocked('research-dispatch-user-restricted');
      // Only schema fields are forwarded; runtime identity always wins.
      const body = {};
      const fields = params?.action === 'delegate' ? ['action', 'planId', 'task', 'stage']
        : ['action', 'planId', 'tasks', 'concurrency', 'reason', 'status', 'summary', 'evidence'];
      for (const key of fields) if (params?.[key] !== undefined) body[key] = params[key];
      try {
        if (['plan', 'delegate'].includes(params.action)) {
          const joined = await readContext(ctx), local = state(ctx);
          if (!ID.test(joined.researchSession?.parentSessionId ?? '')) {
            const approvingSession = ctx?.sessionManager?.getSessionId?.();
            const identity = approvalScope(ctx, joined);
            local.approvedScopes ??= new Set();
            if (joined.sessionId !== approvingSession) return blocked('research-dispatch-approval-scope-changed');
            if (!local.approvedScopes.has(identity)) {
              let source = savedScopeApproval(ctx, identity) ? 'saved' : undefined;
              if (!source) {
                const previous = successfulNativePlans(ctx);
                if (previous.size) {
                  // A native success proves approval only when the host still lists that exact plan in this verified scope.
                  const current = await request(ctx, { action: 'status' }, signal);
                  if (current.status === 'ok' && current.sessionId === joined.sessionId
                      && current.plans?.some(plan => previous.has(plan.clientPlanId))) source = 'prior-native-plan';
                }
              }
              if (!source) {
                const preview = JSON.stringify(body, null, 2);
                if (preview.length > 65536) return blocked('research-dispatch-plan-preview-too-large');
                const confirm = options.confirmInitialPlan ?? (ctx?.hasUI && typeof ctx.ui?.confirm === 'function'
                  ? (text => ctx.ui.confirm('确认首次科研分工', text)) : null);
                if (!confirm) return blocked('research-dispatch-initial-plan-confirmation-required');
                if (!await confirm(`确认当前已冻结科研目标的分工授权。以下为首批任务；确认后，主agent及各分支在同一目标、权限和资源范围内安排后续任务、滚动补位，无需逐批重复确认。新增范围、外发或远程操作仍单独确认。\n目标版本：${joined.charterHash}\n\n${preview}`)) return blocked('research-dispatch-initial-plan-declined');
                source = 'native-ui';
              }
              const rechecked = await readContext(ctx);
              if (rechecked.sessionId !== joined.sessionId || ctx?.sessionManager?.getSessionId?.() !== approvingSession
                  || approvalScope(ctx, rechecked) !== identity) return blocked('research-dispatch-approval-scope-changed');
              if (local.restrictions?.blocked) return blocked('research-dispatch-user-restricted');
              if (source !== 'saved' && typeof pi.appendEntry === 'function') pi.appendEntry(APPROVAL_ENTRY, {
                schema: 'pi-research-dispatch-scope-approval.v1', scope: identity, approved: true,
                source, at: new Date().toISOString(),
              });
              if (local.approvedScopes.size >= 64) local.approvedScopes.delete(local.approvedScopes.values().next().value);
              local.approvedScopes.add(identity);
            }
          }
        }
        if (params.action === 'report') {
          const joined = await readContext(ctx);
          const snapshot = await request(ctx, { action: 'status' }, signal);
          if (hasDirectHandoff(joined, snapshot, ctx?.sessionManager?.getSessionId?.())) return result({
            status: 'blocked', tool: 'research_dispatch', error: 'research-dispatch-assignment-not-found',
            reportMode: 'parent-handoff', reportSubmitted: false, hint: DIRECT_HANDOFF_HINT,
          }, true);
        }
        if (['plan', 'delegate'].includes(params.action)) {
          const joined = await readContext(ctx);
          if (state(ctx)?.restrictions?.readOnly || joined?.researchSession?.readOnly === true) body.readOnly = true;
        }
        const snapshot = await request(ctx, body, signal), local = state(ctx);
        if (local) { local.joinedOnce = true; local.managed = snapshot.collaborator || snapshot.plans?.length > 0; if (params.action === 'report') local.reportReminders = 0; }
        const projection = projectDispatchContext(snapshot, params);
        if (params.action === 'status' && params.view !== 'detail' && !local?.restrictions?.readOnly
            && isDirectResearchWorker(await readContext(ctx), snapshot, ctx?.sessionManager?.getSessionId?.())) {
          projection.executionMode = 'direct-worker';
          projection.reportMode = 'parent-handoff';
          projection.dispatcherDecisionRequired = projection.decisionRequired;
          projection.decisionRequired = false;
          projection.hint = DIRECT_HANDOFF_HINT + ' Execute only the original bounded task. Identity, read-only, resource and publication controls still apply.';
        }
        if (params.action === 'status' && params.view !== 'detail' && local) {
          const signature = JSON.stringify(projection);
          if (signature === local.lastSummary && params.refresh !== true) return result({ status: projection.status, tool: 'research_dispatch', sessionId: projection.sessionId, unchanged: true,
            error: projection.error, assignment: projection.assignment, decisionRequired: projection.decisionRequired,
            childrenPending: projection.childrenPending, counts: projection.counts,
            executionMode: projection.executionMode, dispatcherDecisionRequired: projection.dispatcherDecisionRequired,
            reportMode: projection.reportMode,
            hint: projection.executionMode === 'direct-worker' ? projection.hint : 'No new receipt. Existing failed/blocked assignments remain failed/blocked. Wait for the completion notification; use refresh:true if the previous summary is no longer in context.' }, projection.status === 'blocked');
          local.lastSummary = signature;
        }
        return result(projection, projection.status === 'blocked');
      }
      catch (error) { return blocked(/^[a-z0-9-]{1,100}$/.test(error?.message ?? '') ? error.message : 'research-dispatch-unavailable'); }
    },
  };
  pi.registerTool(tool);
  if (typeof pi.on !== 'function') return tool;
  pi.on('before_agent_start', (event, ctx) => {
    const local = state(ctx);
    if (local) { local.reads = 0; local.lastSummary = undefined; local.restrictions = mergeDelegationEventRestrictions(local.restrictions, event); }
  });
  pi.on('input', async (event, ctx) => {
    const local = state(ctx);
    if (!local) return;
    const previouslyBlocked = local.restrictions?.blocked === true;
    local.restrictions = mergeDelegationEventRestrictions(local.restrictions, event, true);
    if (!previouslyBlocked && local.restrictions?.blocked) {
      try { await request(ctx, { action: 'pause' }); } catch { /* No active verified plan; preserve the textual stop. */ }
    } else if (previouslyBlocked && !local.restrictions?.blocked) {
      try { await request(ctx, { action: 'resume' }); } catch { /* Restore only existing own plans, never a new task. */ }
    }
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!event?.toolName || event.toolName === 'research_dispatch' || event.toolName === 'research_communication') return;
    if (!options.readContext) {
      const inspection = inspectWorkbenchRecordContext(ctx, options.contextOptions);
      if (inspection.membership === true && inspection.status !== 'ready' && !SAFE_READS.has(event.toolName) && !COORDINATION.has(event.toolName) && !(event.toolName === 'research_loop' && event.input?.action === 'status')) {
        return { block: true, reason: `${inspection.error}: preserve this session's existing assignment and records. Resolve the target binding in the workbench, or create a fresh assignment for an old child, before research execution.` };
      }
    }
    const local = state(ctx);
    if (!local) return;
    let joined;
    try { joined = await readContext(ctx); } catch { /* Known scope loss is handled below. */ }
    if (!joined) {
      if (local.joinedOnce && !COORDINATION.has(event.toolName)) return { block: true, reason: 'The previously verified research membership is currently unavailable. Restore its scope before further work; do not bypass inherited read-only or delegation controls.' };
      return;
    }
    local.joinedOnce = true;
    if (joined.researchSession) local.managed = true;
    if (local.restrictions?.blocked && ['research_session', 'subagent', 'Agent', 'SubagentWorkflow'].includes(event.toolName)) {
      return { block: true, reason: 'The user explicitly restricted delegation or external export. Work within that restriction.' };
    }
    if (local.restrictions?.readOnly || joined.researchSession?.readOnly === true) {
      const readOnlyCoordination = COORDINATION.has(event.toolName) || event.toolName === 'research_session'
        || (event.toolName === 'research_loop' && ['status', 'report'].includes(event.input?.action));
      if (!SAFE_READS.has(event.toolName) && !readOnlyCoordination) return { block: true,
        reason: 'This assignment inherits a read-only constraint. Use read-only tools or linked research_session/research_dispatch children, which inherit the same constraint. Do not write project files, execute shell commands or use an unverified delegation path.' };
    }
    // Only true read tools get a small planning window. A shell cannot masquerade
    // as a safe read; simple one-item work uses a recorded atomic decision.
    if (SAFE_READS.has(event.toolName) && ++local.reads <= 3) return;
    let snapshot;
    try { snapshot = await request(ctx, { action: 'status' }); }
    catch {
      return { block: true, reason: 'research_dispatch status is unavailable. Restore the dispatcher before bulk work in this joined workspace; do not silently take over delegated work or duplicate a child.' };
    }
    local.managed = snapshot.collaborator || snapshot.plans?.length > 0;
    const safeRead = SAFE_READS.has(event.toolName);
    const coordination = COORDINATION.has(event.toolName) || (event.toolName === 'research_loop' && LOOP_COORDINATION.has(event.input?.action));
    if (TERMINAL.has(snapshot.assignment?.status) && !safeRead && !coordination) {
      return { block: true, reason: 'This dispatcher assignment is already terminal. Inspect its receipt or return the conclusion; do not restart or duplicate its work.' };
    }
    if (snapshot.childrenPending && event.toolName === 'research_loop' && event.input?.action === 'publish') {
      return { block: true, reason: 'Required child work remains pending. Collect its actual evidence before publication.' };
    }
    if (!coordination && !isDirectResearchWorker(joined, snapshot, ctx?.sessionManager?.getSessionId?.())
        && ((snapshot.declaredTasks > 0 && !snapshot.plans?.length) || snapshot.decisionRequired)) {
      return { block: true, reason: 'Before bulk work, hand off the goal with research_dispatch delegate or submit an already decomposed plan. For one genuinely indivisible assignment, call atomic with a concrete reason. A supplied structured task list cannot be replaced by atomic execution.' };
    }

  });
  // Natural-language final answers do not satisfy the execution contract.
  // Two bounded continuations ask for the explicit receipt; a third unreported
  // ending records blocked, never an invented success. Coordinators waiting on
  // children sleep until the server's durable receipt wakes them.
  pi.on('agent_end', async (event, ctx) => {
    const final = event?.messages?.findLast?.(message => message.role === 'assistant');
    // Error-time follow-ups can survive a retry and arrive after a successful report.
    if (event?.aborted === true || event?.willRetry === true || ['error', 'aborted'].includes(final?.stopReason)) return;
    const local = state(ctx);
    if (!local || local.finishing) return;
    local.finishing = true;
    try {
      const sessionId = ctx?.sessionManager?.getSessionId?.(), joined = await readContext(ctx);
      if (joined.sessionId !== sessionId) return;
      const identity = approvalScope(ctx, joined);
      const snapshot = await request(ctx, { action: 'status' });
      const rechecked = await readContext(ctx);
      if (snapshot.status !== 'ok' || snapshot.sessionId !== sessionId || ctx?.sessionManager?.getSessionId?.() !== sessionId
          || approvalScope(ctx, rechecked) !== identity) return;
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
