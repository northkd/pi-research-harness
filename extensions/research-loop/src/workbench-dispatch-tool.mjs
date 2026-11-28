/** Native bounded DAG execution and the collaborator plan-first runtime gate. */
import { inspectWorkbenchRecordContext, requireWorkbenchRecordContext } from './workbench-context.mjs';
import { readBoundedJson, readDashboardLocalAuth, RESEARCH_DISPATCH_TASK_SCHEMA, RESEARCH_SESSION_STAGES } from './workbench-session-tool.mjs';
import { mergeDelegationEventRestrictions } from './delegation-policy.mjs';
import { projectDispatchContext } from './dispatch-context.mjs';

const SAFE_READS = new Set(['read', 'grep', 'find', 'ls', 'web_search', 'fetch_content']);
const COORDINATION = new Set(['ask_user', 'ask_user_question', 'research_communication']);
const SUBAGENT_TOOLS = new Set(['subagent', 'subagent_supervisor', 'subagents_enable', 'Agent', 'SubagentWorkflow']);
const LOOP_COORDINATION = new Set(['status', 'log', 'report']);
// Status contains bounded task lists plus one prerequisite receipt set.
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

function previewText(value, limit) {
  const line = typeof value === 'string' ? value.replace(/[\s\x00-\x1f\x7f]+/gu, ' ').trim() : '';
  if (!line) return '未填写';
  if (line.length <= limit) return line;
  return line.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, '') + '…';
}

function formatDispatchConfirmationPreview(body, charterHash) {
  const delegate = body.action === 'delegate';
  const lines = [delegate ? '委派协调员统筹 delegate' : '并行任务分工 plan'];
  if (body.planId) lines.push(`• 计划 ID：${body.planId}`);
  lines.push(`• 目标版本：${charterHash}`);
  if (delegate) {
    lines.push(`• 阶段：${body.stage ?? '未填写'}`, '• 角色：research-coordinator', `• 目标：${previewText(body.task, 4000)}`);
  } else {
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    if (tasks.length > 64) throw new Error('research-dispatch-plan-preview-too-large');
    lines.push(`• 任务数：${tasks.length}`);
    if (body.concurrency !== undefined) lines.push(`• 并发上限：${body.concurrency}`);
    const numbers = new Map(tasks.map((task, index) => [task?.id, index + 1]));
    for (const [index, task] of tasks.entries()) {
      const dependencies = Array.isArray(task?.dependsOn) ? task.dependsOn : [];
      let prerequisites = dependencies.join('、');
      if (prerequisites.length > 128) {
        prerequisites = dependencies.map(id => numbers.has(id) ? `第${numbers.get(id)}项` : id).join('、');
      }
      lines.push('', `${index + 1}. [${task?.id ?? '未填写'}] ${task?.role ?? '未填写'} · ${task?.stage ?? '未填写'}`,
        `   前置依赖：${prerequisites || '无'}`, `   ${previewText(task?.task, 144)}`);
    }
  }
  lines.push('', '确认后，同一目标和权限范围内的后续批次、滚动补位和分支拆分会自动执行，不再弹窗。新增范围、外发或远程操作仍需单独确认。拒绝后可提出修改意见，再确认新的分工。');
  const message = lines.join('\n');
  if (message.length > 32768 || Buffer.byteLength(message) > 65536) throw new Error('research-dispatch-plan-preview-too-large');
  return message;
}
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

const TRANSIENT_RETRY_DELAYS_MS = [400, 1200];
const sleepMs = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(new Error('research-dispatch-aborted')); return; }
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); reject(new Error('research-dispatch-aborted')); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

function turnAskedUser(messages) {
  if (!Array.isArray(messages)) return false;
  return messages.some(msg => msg?.role === 'assistant' && Array.isArray(msg.content)
    && msg.content.some(part => part?.type === 'toolCall' && (part.name === 'ask_user' || part.name === 'ask_user_question')));
}

function userExplicitlyAcceptedStop(text) {
  if (typeof text !== 'string') return false;
  return /(?:不用|无需|不必|不要|别再?)\s*(?:继续|重派|补派|补跑|重试|再跑)|(?:到此为止|先停下|先这样|就按现有|接受部分|保持现状)|\b(?:stop here|do not retry|don't retry|keep as is|accept partial)\b/i.test(text);
}

function latestUnresolvedPlan(plans) {
  if (!Array.isArray(plans) || !plans.length) return null;
  const sorted = [...plans].sort((a, b) => Date.parse(b?.updatedAt ?? b?.createdAt ?? 0) - Date.parse(a?.updatedAt ?? a?.createdAt ?? 0));
  const latest = sorted[0];
  if (!latest || !['blocked', 'failed'].includes(latest.status)) return null;
  const incomplete = (latest.tasks ?? []).filter(task => task?.status === 'blocked' || task?.status === 'failed');
  return incomplete.length > 0 ? { plan: latest, incomplete } : null;
}

export function createResearchDispatchClient(options = {}) {
  const readContext = options.readContext ?? (ctx => requireWorkbenchRecordContext(ctx, options.contextOptions, 'research-dispatch-session-not-joined'));
  const maxRetries = Number.isInteger(options.maxTransientRetries) && options.maxTransientRetries >= 0 ? options.maxTransientRetries : TRANSIENT_RETRY_DELAYS_MS.length;
  const retryDelays = Array.isArray(options.retryDelaysMs) ? options.retryDelaysMs : TRANSIENT_RETRY_DELAYS_MS;
  const wait = options.sleep ?? sleepMs;
  return async (ctx, params, signal, expectedScope) => {
    const sessionId = ctx?.sessionManager?.getSessionId?.();
    const joined = await readContext(ctx);
    if (!joined || !sessionId || joined.sessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId) throw new Error('research-dispatch-session-not-joined');
    const scope = approvalScope(ctx, joined), cwd = joined.cwd;
    if (expectedScope !== undefined && scope !== expectedScope) throw new Error('research-dispatch-scope-changed');
    const auth = await (options.resolveAuth ?? (() => readDashboardLocalAuth(options.authOptions)))();
    const target = new URL('/api/res-workflow/dispatch', auth.baseUrl);
    if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(target.hostname)) throw new Error('research-dispatch-destination-not-loopback');
    let reply;
    for (let attempt = 0; ; attempt += 1) {
      const timeout = AbortSignal.timeout(options.timeoutMs ?? 30_000);
      let response;
      try {
        response = await (options.fetchImpl ?? globalThis.fetch)(target, {
          method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', 'x-pi-local-token': auth.token },
          body: JSON.stringify({ ...params, sessionId }),
          signal: signal && AbortSignal.any ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (error) {
        if (!signal?.aborted && attempt < maxRetries) {
          await wait(retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 400, signal);
          continue;
        }
        throw error;
      }
      reply = await readBoundedJson(response, RESEARCH_DISPATCH_RESPONSE_BYTES);
      if (response.ok && object(reply) && reply.status === 'ok') break;
      const code = typeof reply?.code === 'string' && /^[a-z0-9-]{1,100}$/.test(reply.code) ? reply.code : 'research-dispatch-unavailable';
      const transient = (response.status >= 500 || response.status === 429) && code === 'research-dispatch-unavailable';
      if (transient && !signal?.aborted && attempt < maxRetries) {
        await wait(retryDelays[Math.min(attempt, retryDelays.length - 1)] ?? 400, signal);
        continue;
      }
      throw new Error(code);
    }
    const current = await readContext(ctx);
    if (reply.sessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId || !current
        || current.cwd !== cwd || approvalScope(ctx, current) !== scope) throw new Error('research-dispatch-response-scope-changed');
    if (['plan', 'delegate'].includes(params.action) && !reply.plans?.some(plan => plan?.clientPlanId === params.planId)) {
      throw new Error('research-dispatch-plan-effect-unconfirmed');
    }
    return reply;
  };
}

export function registerWorkbenchDispatchTool(pi, options = {}) {
  const request = options.request ?? createResearchDispatchClient(options);
  const readContext = options.readContext ?? (ctx => requireWorkbenchRecordContext(ctx, options.contextOptions, 'research-dispatch-session-not-joined'));
  const states = new Map();
  const pendingApprovals = new Map();
  function state(ctx) {
    const id = ctx?.sessionManager?.getSessionId?.();
    if (!id) return null;
    if (!states.has(id)) {
      if (states.size >= 128) states.delete(states.keys().next().value);
      states.set(id, { reads: 0, restrictions: undefined });
    }
    return states.get(id);
  }
  async function confirmScope(ctx, joined, scope, body, signal, local) {
    const cwd = joined.cwd;
    let source = savedScopeApproval(ctx, scope) ? 'saved' : undefined;
    if (!source) {
      const previous = successfulNativePlans(ctx);
      if (previous.size) {
        // Recover a native success only if its plan still belongs to this scope.
        const current = await request(ctx, { action: 'status' }, signal, scope);
        if (current.status === 'ok' && current.sessionId === joined.sessionId
            && current.plans?.some(plan => previous.has(plan.clientPlanId))) source = 'prior-native-plan';
      }
    }
    if (!source) {
      const confirm = options.confirmInitialPlan ?? (ctx?.hasUI && typeof ctx.ui?.confirm === 'function'
        ? (text => ctx.ui.confirm('确认首次科研分工', text)) : null);
      if (!confirm) return blocked('research-dispatch-initial-plan-confirmation-required');
      if (await confirm(formatDispatchConfirmationPreview(body, joined.charterHash)) !== true) {
        return result({ status: 'blocked', tool: 'research_dispatch', error: 'research-dispatch-initial-plan-declined',
          hint: '本次分工未提交。请根据用户反馈修改分工，再用 plan 或 delegate 重新提交确认。如果还没有具体意见，先询问用户希望调整哪些任务。' }, true);
      }
      source = 'native-ui';
    }
    const rechecked = await readContext(ctx);
    if (!rechecked || rechecked.cwd !== cwd || ctx.sessionManager.getSessionId() !== rechecked.sessionId || approvalScope(ctx, rechecked) !== scope) {
      return blocked('research-dispatch-approval-scope-changed');
    }
    if (local.restrictions?.blocked) return blocked('research-dispatch-user-restricted');
    if (source !== 'saved') pi.appendEntry?.(APPROVAL_ENTRY, {
      schema: 'pi-research-dispatch-scope-approval.v1', scope, approved: true, source, at: new Date().toISOString(),
    });
    if (local.approvedScopes.size >= 64) local.approvedScopes.delete(local.approvedScopes.values().next().value);
    local.approvedScopes.add(scope);
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
      'For one indivisible assignment, call atomic with a concrete reason; do not create artificial empty subtasks.',
      'Call status before work. Detailed task/receipt data is paged: use view:detail with planId and taskId, a direct dependency taskId, or taskId:self for the original assignment; continue at nextOffset with the same recordHash until complete when the full brief is required.',
      'Dispatch runs autonomously. Wait for task/plan completion or actionable exception notifications instead of repeated status/resource polling or duplicate exploration. Verify the referenced evidence before scientific acceptance. The lead decides scope and unresolved questions; branch owners handle their detailed execution and evidence review.',
      'Default replies contain bounded summaries and evidence references, never whole child transcripts. Unchanged status is acknowledged briefly; refresh:true returns the current summary after compaction if needed.',
      'Report completed/failed/blocked only for your own assignment with an accurate summary and relative evidence paths. Child failures cannot be hidden behind completed. HARD RULE: when blocked by missing permissions, coordination questions, or temporary/recoverable resource issues, send research_communication (action="send", kind="request", to="parent") and wait in active state for parent reply — do NOT prematurely submit report(status="blocked").',
      'To resume or supplement any non-active task (blocked, failed, completed, or recovery-required) inside the original child session instead of creating a new agent, call research_dispatch action="reopen" with planId and taskId (or send a downward request/reply/decision to that child via research_communication). You may still set concurrency:1 when conserving memory.',
      'Respect the original user scope, explicit no-delegate/no-export restrictions and inherited permissions.',
    ],
    parameters: {
      type: 'object', additionalProperties: false, required: ['action'],
      properties: {
        action: { type: 'string', enum: ['delegate', 'plan', 'status', 'atomic', 'report', 'cancel', 'pause', 'resume', 'reopen'] },
        planId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'Stable client plan key; reuse exactly on a retry.' },
        task: { type: 'string', minLength: 1, maxLength: 4000, description: 'For delegate: the goal, mandatory constraints, acceptance criteria and relevant file references. Do not copy the whole conversation.' },
        stage: { type: 'string', enum: RESEARCH_SESSION_STAGES },
        tasks: { type: 'array', minItems: 1, maxItems: 64, items: RESEARCH_DISPATCH_TASK_SCHEMA },
        concurrency: { type: 'integer', minimum: 1, maximum: process.env.PI_RESEARCH_HOST_DIR ? 64 : 4, description: 'Requested concurrency (default 2). Managed host scheduling and capacity limits govern admission.' },
        reason: { type: 'string', minLength: 1, maxLength: 1000, description: 'For atomic: why the assignment is indivisible. For cancel: why to stop scheduling the named plan. For reopen: follow-up instruction or reason to resume the non-active task in its original session.' },
        status: { type: 'string', enum: ['completed', 'failed', 'blocked'] },
        summary: { type: 'string', minLength: 1, maxLength: 4000 },
        evidence: { type: 'array', maxItems: 16, items: { type: 'string', minLength: 1, maxLength: 1024 }, description: 'Relative files containing the evidence; no absolute paths or parent traversal.' },
        view: { type: 'string', enum: ['summary', 'detail'], description: 'Default summary is at most 8 KiB; explicit detail is paged at most 16 KiB per reply.' },
        taskId: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]+$', description: 'Target task ID for status detail (or self), or the non-active task ID to reopen within planId.' },
        offset: { type: 'integer', minimum: 0, description: 'For detail: use the preceding page nextOffset. UTF-16 character offset in the serialized record.' },
        recordHash: { type: 'string', pattern: '^[a-f0-9]{64}$', description: 'For continuation: copy the preceding detail page recordHash. A changed record is rejected rather than mixing evidence pages.' },
        refresh: { type: 'boolean', description: 'Return the current summary even if unchanged, for example after context compaction.' },
      },
    },
    executionMode: 'sequential', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params, signal, _update, ctx) {
      if (['plan', 'delegate', 'resume', 'reopen'].includes(params?.action) && state(ctx)?.restrictions?.blocked) return blocked('research-dispatch-user-restricted');
      // Only schema fields are forwarded; runtime identity always wins.
      const body = {};
      const fields = params?.action === 'delegate' ? ['action', 'planId', 'task', 'stage']
        : params?.action === 'reopen' ? ['action', 'planId', 'taskId', 'reason', 'summary']
        : ['action', 'planId', 'tasks', 'concurrency', 'reason', 'status', 'summary', 'evidence'];
      for (const key of fields) if (params?.[key] !== undefined) body[key] = params[key];
      try {
        let expectedScope;
        if (['plan', 'delegate'].includes(params.action)) {
          const sessionId = ctx?.sessionManager?.getSessionId?.();
          const joined = await readContext(ctx), local = state(ctx);
          if (!sessionId || joined?.sessionId !== sessionId || ctx.sessionManager.getSessionId() !== sessionId) {
            return blocked('research-dispatch-session-not-joined');
          }
          expectedScope = approvalScope(ctx, joined);
          if (!ID.test(joined.researchSession?.parentSessionId ?? '')) {
            local.approvedScopes ??= new Set();
            if (!local.approvedScopes.has(expectedScope)) {
              let pending = pendingApprovals.get(expectedScope);
              if (!pending) {
                pending = confirmScope(ctx, joined, expectedScope, body, signal, local)
                  .finally(() => pendingApprovals.delete(expectedScope));
                pendingApprovals.set(expectedScope, pending);
              }
              const refusal = await pending;
              if (refusal) return refusal;
            }
          }
          if (local.restrictions?.blocked) return blocked('research-dispatch-user-restricted');
          if (local.restrictions?.readOnly || joined.researchSession?.readOnly === true) body.readOnly = true;
        }
        if (params.action === 'report') {
          const joined = await readContext(ctx);
          const snapshot = await request(ctx, { action: 'status' }, signal);
          if (hasDirectHandoff(joined, snapshot, ctx?.sessionManager?.getSessionId?.())) return result({
            status: 'blocked', tool: 'research_dispatch', error: 'research-dispatch-assignment-not-found',
            reportMode: 'parent-handoff', reportSubmitted: false, hint: DIRECT_HANDOFF_HINT,
          }, true);
        }
        const snapshot = await request(ctx, body, signal, expectedScope), local = state(ctx);
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
    if (event?.source === 'interactive' && userExplicitlyAcceptedStop(event?.text)) {
      local.userAcceptedStopAt = Date.now();
    }
    const previouslyBlocked = local.restrictions?.blocked === true;
    local.restrictions = mergeDelegationEventRestrictions(local.restrictions, event, true);
    if (!previouslyBlocked && local.restrictions?.blocked) {
      try { await request(ctx, { action: 'pause' }); } catch { /* No active verified plan; preserve the textual stop. */ }
    } else if (previouslyBlocked && !local.restrictions?.blocked) {
      try { await request(ctx, { action: 'resume' }); } catch { /* Restore only existing own plans, never a new task. */ }
    }
  });
  pi.on('tool_call', async (event, ctx) => {
    if (!event?.toolName || event.toolName === 'research_dispatch' || event.toolName === 'research_communication' || SUBAGENT_TOOLS.has(event.toolName)) return;
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
    if (local.restrictions?.blocked && event.toolName === 'research_session') {
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
      if (!snapshot.assignment) {
        // Lead completion guard: prevent the Main Agent from unilaterally giving
        // up in plain prose when its latest dispatched plan still has blocked or
        // failed tasks, unless the user explicitly asked it to stop or the lead
        // already asked the user for a decision via ask_user.
        if (snapshot.collaborator || snapshot.childrenPending || local.restrictions?.blocked || ctx?.hasPendingMessages?.()) return;
        const unresolved = latestUnresolvedPlan(snapshot.plans);
        if (!unresolved) return;
        if (turnAskedUser(event?.messages)) return;
        const planTs = Date.parse(unresolved.plan.updatedAt ?? unresolved.plan.createdAt ?? '') || 0;
        if (local.userAcceptedStopAt && local.userAcceptedStopAt >= planTs) return;
        const sig = `${unresolved.plan.id}:${unresolved.plan.updatedAt ?? unresolved.plan.status}:${unresolved.incomplete.map(t => `${t.id}=${t.status}`).join(',')}`;
        const prev = local.leadGuard;
        const count = prev?.sig === sig ? prev.count : 0;
        if (count >= 2 || typeof pi.sendUserMessage !== 'function') return;
        local.leadGuard = { sig, count: count + 1 };
        const names = unresolved.incomplete.map(t => `${t.id}(${t.status}${t.error ? ':' + t.error : ''})`).join('、');
        pi.sendUserMessage(`[research_dispatch lead-completion-guard] 派发计划 "${unresolved.plan.clientPlanId || unresolved.plan.id}" 仍有 ${unresolved.incomplete.length}/${(unresolved.plan.tasks ?? []).length} 项任务处于受阻/失败未完成状态（${names}）。禁止主 Agent 擅自决定放弃未完成目标并停下。请立即履行主控职责：(1) 逐项核查受阻原因（内存/资源门禁、权限缺失或调度异常）；(2) 若属临时资源或调度受阻且现已恢复，或可在已有授权内解决，优先使用 research_dispatch action="reopen"（或向原孩子发送 research_communication 指令）在原 Agent 中重开并续完未完成任务，不得直接以“不再重派”收口；(3) 若确需人工授予权限、调整范围或确认是否放弃剩余项，必须调用 ask_user 向用户请示。`, { deliverAs: 'followUp' });
        return;
      }
      if (TERMINAL.has(snapshot.assignment.status) || snapshot.childrenPending || snapshot.awaitingParentReply) return;
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
