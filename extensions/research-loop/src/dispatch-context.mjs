/** Model-facing dispatch receipts. Full records stay in the durable ledger. */
import { createHash } from 'node:crypto';
export const DISPATCH_CONTEXT_BYTES = 8 * 1024;
export const DISPATCH_DETAIL_BYTES = 16 * 1024;

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const bytes = value => Buffer.byteLength(JSON.stringify(value), 'utf8');
const text = value => typeof value === 'string' ? value : '';
const list = value => Array.isArray(value) ? value : [];

function clip(value, maximum) {
  const original = text(value);
  let output = '';
  for (const character of original) {
    if (Buffer.byteLength(JSON.stringify(output + character), 'utf8') > maximum) break;
    output += character;
  }
  return { text: output, truncated: output.length !== original.length };
}

const identifier = value => clip(value, 180).text;
const countsOf = tasks => {
  const counts = { total: tasks.length, completed: 0, failed: 0, blocked: 0, active: 0, queued: 0 };
  for (const task of tasks) {
    if (['completed', 'failed', 'blocked', 'queued'].includes(task?.status)) counts[task.status]++;
    else counts.active++;
  }
  return counts;
};

function selectedPlans(snapshot, params) {
  const plans = list(snapshot.plans);
  if (!params.planId) return plans;
  return plans.filter(plan => plan?.id === params.planId || plan?.clientPlanId === params.planId);
}

/** Explicit detail pages never silently truncate the authoritative record. */
function detailPage(snapshot, params) {
  const plans = selectedPlans(snapshot, params);
  let source, sourceKind;
  if (params.taskId === 'self' && !params.planId) {
    if (snapshot.brief || snapshot.assignment) source = { brief: snapshot.brief ?? null,
      assignment: snapshot.assignment ? { planId: snapshot.assignment.planId, taskId: snapshot.assignment.taskId,
        status: snapshot.assignment.status, error: snapshot.assignment.error,
        dependencyIds: list(snapshot.assignment.dependencies).map(row => row.id) } : null };
    sourceKind = 'own-assignment';
  } else if (params.taskId) {
    const matches = plans.flatMap(plan => list(plan.tasks).filter(task => task?.id === params.taskId)
      .map(task => ({ planId: plan.id, task })));
    const dependencies = !params.planId || params.planId === snapshot.assignment?.planId
      ? list(snapshot.assignment?.dependencies).filter(task => task?.id === params.taskId) : [];
    if (matches.length + dependencies.length === 1) {
      source = matches[0] ?? { dependency: dependencies[0] };
      sourceKind = matches.length ? 'task' : 'dependency';
    }
  } else if (params.planId && plans.length === 1) {
    source = plans[0]; sourceKind = 'plan';
  }
  if (!source) return { status: 'blocked', tool: 'research_dispatch', error: 'research-dispatch-detail-target-required', hint: 'Specify planId and taskId, a direct dependency taskId, or taskId:self for your original assignment.' };

  const serialized = JSON.stringify(source);
  const recordHash = createHash('sha256').update(serialized).digest('hex');
  const requested = params.offset ?? 0;
  if (!Number.isSafeInteger(requested) || requested < 0 || requested > serialized.length) {
    return { status: 'blocked', tool: 'research_dispatch', error: 'research-dispatch-detail-offset-invalid' };
  }
  if ((requested > 0 && params.recordHash !== recordHash) || (params.recordHash && params.recordHash !== recordHash)) {
    return { status: 'blocked', tool: 'research_dispatch', error: 'research-dispatch-detail-record-changed',
      hint: 'Do not concatenate pages from different records. Restart with offset:0 and no recordHash, then carry the returned recordHash on every continuation.' };
  }
  const page = { status: 'ok', tool: 'research_dispatch', view: 'detail', source: sourceKind,
    planId: params.planId ?? null, taskId: params.taskId ?? null, offset: requested,
    recordHash, totalCharacters: serialized.length, nextOffset: null, complete: false, content: '',
    hint: 'content is a page of the authoritative JSON record. Continue at nextOffset with the same recordHash when present; do not infer omitted evidence.' };
  let low = requested, high = serialized.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = { ...page, content: serialized.slice(requested, middle), nextOffset: middle };
    if (bytes(candidate) <= DISPATCH_DETAIL_BYTES - 16) low = middle;
    else high = middle - 1;
  }
  // Avoid splitting a UTF-16 surrogate pair between independently valid pages.
  if (low < serialized.length && low > requested && /[\uD800-\uDBFF]/.test(serialized[low - 1]) && /[\uDC00-\uDFFF]/.test(serialized[low])) low--;
  page.content = serialized.slice(requested, low);
  page.complete = low === serialized.length;
  page.nextOffset = page.complete ? null : low;
  return page;
}

/** Compact, bounded overview. Failure counts survive even when detail is omitted. */
export function projectDispatchContext(snapshot, params = {}) {
  if (!object(snapshot)) return { status: 'blocked', error: 'research-dispatch-invalid-response' };
  if (params.view === 'detail') return detailPage(snapshot, params);
  const plans = selectedPlans(snapshot, params);
  const allTasks = plans.flatMap(plan => list(plan.tasks));
  const projection = {
    status: snapshot.status, tool: 'research_dispatch', action: params.action ?? 'status', view: 'summary',
    collaborator: !!snapshot.collaborator, decisionRequired: !!snapshot.decisionRequired,
    childrenPending: !!snapshot.childrenPending, declaredTasks: snapshot.declaredTasks ?? 0,
    counts: countsOf(allTasks), planCount: plans.length, plans: [], omittedPlans: 0,
    hint: 'Execution details remain in child sessions and evidence files. Do not poll or repeat delegated work. For evidence use status with view:detail, planId/taskId and nextOffset; use taskId:self for the original assignment.'
  };
  if (snapshot.atomicReason) projection.atomicReason = clip(snapshot.atomicReason, 360).text;
  if (snapshot.assignment) {
    const assignment = snapshot.assignment;
    projection.assignment = { planId: identifier(assignment.planId), taskId: identifier(assignment.taskId),
      status: identifier(assignment.status), error: identifier(assignment.error),
      dependencyIds: list(assignment.dependencies).map(row => identifier(row?.id)),
      hasOriginalBrief: !!snapshot.brief };
  }
  const withRows = params.action === undefined || params.action === 'status';
  // Most recent plans first; terminal counts include every plan in scope.
  for (const plan of [...plans].reverse()) {
    const tasks = list(plan.tasks), row = { id: identifier(plan?.id), mode: plan?.mode === 'delegate' ? 'delegate' : 'tasks',
      status: identifier(plan?.status), error: identifier(plan?.error), counts: countsOf(tasks), tasks: [], omittedTasks: tasks.length };
    projection.plans.push(row);
    if (bytes(projection) > DISPATCH_CONTEXT_BYTES) { projection.plans.pop(); projection.omittedPlans++; continue; }
    if (!withRows) continue; // Mutations acknowledge once without echoing the whole plan.
    const ordered = [...tasks].sort((a, b) => Number(['failed', 'blocked'].includes(b?.status)) - Number(['failed', 'blocked'].includes(a?.status)));
    for (const task of ordered) {
      const receipt = { id: identifier(task?.id), status: identifier(task?.status), role: identifier(task?.role) };
      if (task?.error) receipt.error = identifier(task.error);
      const preview = clip(task?.summary, plan?.mode === 'delegate' ? 2400 : 600);
      if (preview.text) { receipt.summary = preview.text; receipt.summaryTruncated = preview.truncated; }
      const evidence = list(task?.evidence).filter(file => typeof file === 'string');
      receipt.evidence = evidence.filter(file => bytes(file) <= 300).slice(0, 3);
      receipt.omittedEvidence = evidence.length - receipt.evidence.length;
      row.tasks.push(receipt); row.omittedTasks--;
      if (bytes(projection) > DISPATCH_CONTEXT_BYTES) { row.tasks.pop(); row.omittedTasks++; }
    }
  }
  // Malformed upstream metadata is still unable to blow up the model result.
  if (bytes(projection) > DISPATCH_CONTEXT_BYTES) {
    return { status: 'blocked', tool: 'research_dispatch', error: 'research-dispatch-summary-metadata-too-large',
      counts: projection.counts, childrenPending: projection.childrenPending, hint: 'Inspect one named plan or task using a detail page.' };
  }
  return projection;
}

export function dispatchContextBytes(value) { return bytes(value); }
