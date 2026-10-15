import crypto from 'node:crypto';
import path from 'node:path';

export const POLICY_VERSION = 2;
export const VERDICTS = ['ON_TRACK', 'DRIFT_RISK', 'OFF_TRACK', 'INSUFFICIENT_CONTEXT'];
export const SCIENCE_STATUS = ['NOT_ASSESSED', 'UNVERIFIED', 'PARTIAL', 'SUPPORTED', 'COUNTEREXAMPLE'];
const findingProperties = Object.fromEntries(['evidence', 'coreStep', 'relation', 'issue', 'correction'].map(k => [k, { type: 'string', maxLength: 4000 }]));
export const REVIEW_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['verdict', 'findings', 'coverage', 'unverified', 'science', 'restrictions'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    findings: { type: 'array', maxItems: 40, items: { type: 'object', additionalProperties: false, required: Object.keys(findingProperties), properties: findingProperties } },
    coverage: { type: 'string', maxLength: 8000 },
    unverified: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 4000 } },
    science: { type: 'object', additionalProperties: false, required: ['status', 'limitations'], properties: {
      status: { type: 'string', enum: SCIENCE_STATUS }, limitations: { type: 'array', maxItems: 40, items: { type: 'string', maxLength: 4000 } } } },
    restrictions: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: false,
      required: ['paths', 'eventIds', 'evidence', 'reason'], properties: {
        paths: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 512 } },
        eventIds: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', maxLength: 256 } },
        evidence: { type: 'string', maxLength: 4000 }, reason: { type: 'string', maxLength: 4000 } } } },
  },
};
const bounded = (s, n) => typeof s === 'string' && s.length <= n;
const strings = (v, n, cap) => Array.isArray(v) && v.length <= n && v.every(s => bounded(s, cap));
const keys = (v, expected) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join() === expected;
export function validReview(v) {
  const legacy = keys(v, 'coverage,findings,unverified,verdict');
  if (!legacy && !keys(v, 'coverage,findings,restrictions,science,unverified,verdict')) return false;
  if (!VERDICTS.includes(v.verdict) || !bounded(v.coverage, 8000) || !v.coverage.trim() ||
      !strings(v.unverified, 40, 4000) || !Array.isArray(v.findings) || v.findings.length > 40 ||
      !v.findings.every(f => keys(f, 'coreStep,correction,evidence,issue,relation') && Object.keys(f).every(k => bounded(f[k], 4000)))) return false;
  if (legacy) return v.verdict !== 'ON_TRACK' || (v.findings.length === 0 && v.unverified.length === 0);
  if (!keys(v.science, 'limitations,status') || !SCIENCE_STATUS.includes(v.science.status) || !strings(v.science.limitations, 40, 4000) ||
      !Array.isArray(v.restrictions) || v.restrictions.length > 16) return false;
  if (v.verdict !== 'OFF_TRACK' && v.restrictions.length) return false;
  return v.restrictions.every(r => keys(r, 'eventIds,evidence,paths,reason') && strings(r.paths, 16, 512) && r.paths.length &&
    strings(r.eventIds, 16, 256) && r.eventIds.length && bounded(r.evidence, 4000) && r.evidence.trim() && bounded(r.reason, 4000) && r.reason.trim());
}
export const digest = value => crypto.createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const sameReview = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function normalizePolicy(s) {
  if (s.policyVersion === undefined) {
    s.legacyGate = { blocked: s.blocked === true, verdict: s.lastVerdict ?? null, revision: s.revision,
      meaning: 'Historical v1 global gate preserved as a record, not an execution authorization or scoped restriction' };
    s.policyVersion = POLICY_VERSION;
  }
  if (s.policyVersion !== POLICY_VERSION) throw new Error('Unknown supervision policy version');
  s.branchRestrictions ??= [];
  s.operationGrants ??= [];
  if (!Array.isArray(s.branchRestrictions) || !Array.isArray(s.operationGrants)) throw new Error('Malformed scoped supervision state');
  s.blocked = activeRestrictions(s).length > 0;
  s.publicationPending = true; // Mainline direction never authorizes scientific publication or external release.
  s.lastScience ??= { status: 'NOT_ASSESSED', limitations: ['Mainline review is not scientific acceptance.'] };
  s.reviewHealth ??= { status: 'UNREVIEWED', reason: 'No v2 review health receipt yet' };
  return s;
}
export function pathOverlaps(a, b) {
  const aa = a.replace(/\/$/, ''), bb = b.replace(/\/$/, '');
  return aa === bb || (a.endsWith('/') && bb.startsWith(aa + '/')) || (b.endsWith('/') && aa.startsWith(bb + '/'));
}
export function activeRestrictions(s) { return (s.branchRestrictions ?? []).filter(r => r.active === true &&
  (r.coreDigest ? r.coreDigest === digest(s.coreText) : r.coreRevision === s.coreRevision)); }
export function referencesEvent(text, eventId) {
  const escaped = eventId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // IDs are exact reference tokens, not substrings (call-1 is not call-10).
  const prefix = /^\d+$/.test(eventId) ? '(?:revision|eventId|event|修订|事件ID|事件)\\s*[:=#]?\\s*' : '(?:^|[^A-Za-z0-9_.-])';
  return new RegExp(prefix + escaped + '(?![A-Za-z0-9_.-])', 'i').test(text);
}
export function groundedRestrictions(store, s, review, evidence, requestId, runId) {
  const accepted = [], rejected = [];
  for (const [i, r] of (review.restrictions ?? []).entries()) {
    let paths;
    try { paths = r.paths.map(p => store.scopePath(p)); }
    catch { rejected.push('Restriction has unsafe or noncanonical paths'); continue; }
    // A model cannot turn guessed/root/subtree paths or a read-only context read into a branch pause.
    const grounded = review.verdict === 'OFF_TRACK' &&
      paths.every(p => !p.endsWith('/') && store.approved(p, s) === p &&
        evidence.events.some(e => {
          const eventId = e.toolCallId ?? String(e.revision);
          return e.path === p && e.material === true && e.source === 'runtime-event' && r.eventIds.includes(eventId) &&
            review.findings.some(f => f.relation === 'UNRELATED' && referencesEvent(f.evidence, eventId));
        }));
    if (!grounded) { rejected.push('Restriction lacks an exact authorized material event/path link; retained as advisory only'); continue; }
    accepted.push({ id: `${requestId}:${i}`, paths: [...new Set(paths)], eventIds: r.eventIds, evidence: r.evidence, reason: r.reason,
      requestId, runId, coreRevision: s.coreRevision, coreDigest: digest(s.coreText), revision: evidence.revision, active: true, source: 'grounded-native-review' });
  }
  return { accepted, rejected };
}

const HUMAN = new Set(['ask_user', 'mainline_supervision']);
const READS = new Set(['read', 'grep', 'find', 'ls', 'bg_status', 'bg_logs', 'lens_diagnostics', 'project_report', 'module_report',
  'symbol_search', 'read_symbol', 'read_enclosing', 'effective_config', 'memory_read', 'memory_search', 'subagent_supervisor']);
const LOCAL_VIEWS = new Set(['canvas', 'scratchpad']);
const CONTROL_ACTIONS = new Set(['status', 'debug.run', 'children.list', 'guide', 'list', 'models', 'mission.show', 'mission.list', 'interrupt', 'stop']);
export function humanChannel(toolName) { return HUMAN.has(toolName); }
export function observationTool(name, input = {}) {
  if (name === 'subagent_supervisor') return ['list', 'pending', 'status'].includes(input.action);
  return HUMAN.has(name) || READS.has(name) || LOCAL_VIEWS.has(name) ||
    (name === 'subagent' && ['status', 'debug.run', 'children.list', 'guide', 'list', 'models', 'mission.show', 'mission.list'].includes(input.action));
}
export function operationLeaves(event, depth = 0) {
  const { toolName, input = {} } = event;
  if (toolName !== 'parallel' && toolName !== 'multi_tool_use.parallel') return [event];
  if (depth >= 4 || !Array.isArray(input.tool_uses) || !input.tool_uses.length || input.tool_uses.length > 64) throw new Error('Invalid/broad batch operation');
  const leaves = input.tool_uses.flatMap(item => {
    if (!item || typeof item.recipient_name !== 'string' || !item.parameters || typeof item.parameters !== 'object') throw new Error('Invalid batch item');
    return operationLeaves({ toolName: item.recipient_name.split('.').at(-1), input: item.parameters }, depth + 1);
  });
  if (leaves.length > 64) throw new Error('Batch operation budget exceeded');
  return leaves;
}
export function permissionSnapshot(store, state, event) {
  const files = {};
  for (const leaf of operationLeaves(event)) {
    const input = leaf.input ?? {};
    const candidates = [input.path ?? input.file_path ?? input.filePath, ...String(input.command ?? '').split(/\s+/)];
    for (const value of candidates) {
      const p = developmentPath(store, value);
      if (!p || p.endsWith('/')) continue;
      try { files[p] = digest(store.readLocal(path.join(store.cwd, p))); } catch { /* Not an identifiable local dependency; no sandbox claim. */ }
    }
  }
  return { inputDigest: digest(event.input ?? {}), coreRevision: state.coreRevision, coreDigest: digest(state.coreText ?? ''),
    scopeDigest: digest(state.authorizationScope ?? []), files };
}
export function needsResource(leaf) {
  return ['bash', 'bg_run', 'ctx_execute', 'ctx_execute_file', 'ctx_batch_execute'].includes(leaf.toolName) ||
    /^(?:fusion_|bg_delegate|bg_run_pi)/.test(leaf.toolName) || (leaf.toolName === 'subagent' && !CONTROL_ACTIONS.has(leaf.input?.action));
}
export function developmentPath(store, value) {
  if (typeof value !== 'string') return null;
  const relative = path.isAbsolute(value) ? path.relative(store.cwd, value) : value;
  try { return store.scopePath(relative); } catch { return null; }
}
function safeView(store, input) {
  const target = input.target;
  return !target || (target.kind === 'file' && developmentPath(store, target.path)) || target.kind === 'server';
}
export function operationDecision(store, state, event) {
  const name = event.toolName, input = event.input ?? {};
  if (name === 'parallel' || name === 'multi_tool_use.parallel') {
    let leaves;
    try { leaves = operationLeaves(event); } catch { return { allow: false, hard: true, reason: '组合调用格式/预算不安全；人工单项通道可用。' }; }
    const decisions = leaves.map(leaf => operationDecision(store, state, leaf));
    const refused = decisions.find(d => !d.allow && d.hard) ?? decisions.find(d => !d.allow && !d.confirmable) ?? decisions.find(d => !d.allow);
    if (refused) return { ...refused, reason: `组合调用中的相关动作仍遵守同一门禁：${refused.reason}` };
    return { allow: true, kind: 'each-batched-operation-checked' };
  }
  if (humanChannel(name) || READS.has(name) || (name === 'subagent' && CONTROL_ACTIONS.has(input.action))) return { allow: true, kind: 'control-or-observation' };
  if (!state.enabled) return { allow: true, kind: 'supervision-disabled; underlying task permissions still apply' };
  const limited = state.pendingChanges === true || state.blocked === true || state.captureFailure === true ||
    state.omittedEvents > 0 || state.migrationUnverifiedTail || state.lastVerdict && state.lastVerdict !== 'ON_TRACK' || state.reviewHealth?.status === 'BLIND_SPOT';
  if (LOCAL_VIEWS.has(name) && (name !== 'canvas' || safeView(store, input))) return { allow: true, kind: 'local-view-not-publication' };
  if (['write', 'edit'].includes(name)) {
    const p = developmentPath(store, input.path ?? input.file_path ?? input.filePath);
    if (!p || p.endsWith('/')) return { allow: false, hard: true, reason: '原数据/敏感、越界或不安全路径写入不由监督放行；先走人工权限渠道。' };
    const restrictions = activeRestrictions(state).filter(r => r.paths.some(rp => pathOverlaps(rp, p)));
    const repair = state.authorized === true && state.correctionCoreRevision === state.coreRevision &&
      (state.correctionPaths ?? []).includes(p) && store.approved(p, state) === p && !store.withheldCapturePaths(state).has(p);
    if (restrictions.length && !repair) return { allow: false, hard: false, restrictionIds: restrictions.map(r => r.id),
      reason: `有具体偏移证据的分支暂停，仅影响 ${p}；其他开发路径可继续。可登记限定纠偏或请求人工决定。` };
    return { allow: true, kind: repair ? 'bounded-repair' : 'development-pending-review' };
  }
  if (['bash', 'bg_run'].includes(name)) {
    const grant = (state.operationGrants ?? []).find(g => g.coreRevision === state.coreRevision && g.toolName === name &&
      g.inputDigest === digest(input) && g.paths.every(p => {
        try { return digest(store.readLocal(path.join(store.cwd, p))) === g.pathDigests[p]; } catch { return false; }
      }));
    if (!grant) {
      const command = String(input.command ?? '');
      if (['bg_run'].includes(name) || /^(?:python3?|pytest|node|\/usr\/bin\/(?:python3?|node))(?:\s|$)/.test(command))
        if (!store.resourceGate().ok) return { allow: false, hard: true, reason: '新计算/后台任务资源门槛未满足；观察与人工通道可用。' };
      if (activeRestrictions(state).some(r => r.paths.some(p => command.includes(p))))
        return { allow: false, hard: false, reason: '仅该命令直接依赖的偏离分支暂停；先登记限定repair短验证或由decision处置，其他分支可继续。' };
      if (/(?:\b(?:rm|dd|mkfs|shutdown|reboot|sudo)\b|\b(?:raw|trajectories|credentials|secrets)\/|(?:^|\s)git\s+(?:reset|clean)\b)/i.test(command))
        return { allow: false, hard: true, reason: '明确破坏性命令或原数据/凭据风险不由主线监督放行；使用独立安全授权流程。' };
      // Recognizable bounded local tests retain the current task's existing execution permissions.
      // Uncertainty adds no repeated permission question and no scientific-success prerequisite.
      try {
        const files = command.trim().split(/\s+/).slice(1).filter(t => !t.startsWith('-'));
        const visible = validateLocalOperation(store, name, input, files);
        if (!activeRestrictions(state).some(r => r.paths.some(rp => visible.paths.some(p => pathOverlaps(rp, p))))) {
          if (!store.resourceGate().ok) return { allow: false, hard: true, reason: '新短验证资源门槛未满足；人工通道可用。' };
          return { allow: true, kind: 'bounded-local-test; original task permission required, not scientific acceptance' };
        }
      } catch { /* Opaque/other execution keeps its independent permission channel. */ }
      if (!limited) return { allow: true, kind: 'no-supervision-restriction; existing execution permissions still apply' };
      return { allow: false, confirmable: true, reason: '需核对本地执行的已有授权、时长/资源与影响路径；这是权限确认，不要求测试已经成功，也不需要向监督证明科学结论。可用allow_operation一次登记短测试以免每轮询问。' };
    }
    if (!store.resourceGate().ok) return { allow: false, hard: true, reason: '启动新计算的资源门槛未满足；不取消已有作业，人工通道可用。' };
    const branch = activeRestrictions(state).some(r => r.paths.some(rp => grant.paths.some(p => pathOverlaps(rp, p))));
    if (branch && !grant.repair) return { allow: false, hard: false, reason: '仅该测试依赖的已证实偏离分支暂停；其他分支及经人工确认的限定repair验证不受影响。' };
    return { allow: true, kind: 'human-authorized-bounded-local-check', grantId: grant.id };
  }
  if (name === 'subagent' && !input.action) {
    if (!store.resourceGate().ok) return { allow: false, hard: true, reason: '新子任务资源门槛未满足，人工通道可用。' };
    const affected = activeRestrictions(state).filter(r => r.paths.some(p => String(input.task ?? '').includes(p)));
    if (affected.length) return { allow: false, hard: false, reason: '该子任务直接依赖已证实偏离分支；可先用decision明确限定纠偏，其他分支不要求整个项目ON_TRACK。' };
  }
  // Do not create a second global permissions system: native tool/task grants still apply.
  // Known egress/publication/remote changes need explicit human confirmation, not a direction verdict.
  if (limited && (/^(?:web_search|fetch_content|source_check|hf_|feynman_|ssh-|fusion_|bg_delegate|bg_run_pi|mcp|ctx_execute|ctx_batch_execute|ctx_fetch_and_index|pi_research_fusion)/.test(name) || name === 'subagent' && !CONTROL_ACTIONS.has(input.action)))
    return { allow: false, confirmable: true, reason: '外发/远程/模型权限独立于主线方向和科学验收；确认本次工具的目标与已有授权范围，不能发布未经支持的结论。' };
  return { allow: true, kind: 'no-scoped-supervision-restriction; original task permissions still apply' };
}
// This checks the visible invocation only, not arbitrary script behavior: it is NOT a sandbox.
export function validateLocalOperation(store, toolName, input, paths) {
  if (!['bash', 'bg_run'].includes(toolName) || !input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Only bounded local bash/bg_run checks may be registered');
  const allowed = toolName === 'bash' ? ['command', 'timeout'] : ['command', 'timeoutSeconds', 'name', 'isAgent', 'description'];
  if (Object.keys(input).some(k => !allowed.includes(k))) throw new Error('Unsupported local check input; no hidden scope or background options');
  const seconds = toolName === 'bash' ? input.timeout : input.timeoutSeconds;
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 120 || (toolName === 'bg_run' && input.isAgent !== false)) throw new Error('Local check must have <=120 second deadline and cannot launch an agent');
  const command = input.command;
  if (typeof command !== 'string' || command.length > 4000 || /[\n\r;&|<>`$]/.test(command) ||
      /(?:https?:\/\/|\b(?:curl|wget|ssh|scp|rsync|rm|sudo|chmod|chown|dd|mkfs|shutdown|reboot|sbatch|srun|qsub|npm|pip|git|docker)\b|(?:^|\s)-(?:c|e)(?:\s|$))/.test(command)) throw new Error('Remote/network/destructive/compound or opaque inline command is not a bounded local check');
  if (!/^(?:python3?|pytest|node|\/usr\/bin\/(?:python3?|node))(?:\s|$)/.test(command)) throw new Error('Only a visible local Python/Node test invocation is supported; other operations keep their original permission channel');
  if (!Array.isArray(paths) || !paths.length || paths.length > 16) throw new Error('Declare the exact local test/development files (1–16), not raw data or directories');
  const normalized = [...new Set(paths.map(p => store.scopePath(p)))];
  if (normalized.some(p => p.endsWith('/'))) throw new Error('Exact files required, not directory grants');
  const pathDigests = {}; let bytes = 0;
  for (const p of normalized) { const text = store.readLocal(path.join(store.cwd, p)); bytes += Buffer.byteLength(text); pathDigests[p] = digest(text); }
  if (bytes > 512 * 1024) throw new Error('Local check file budget exceeded');
  const args = command.trim().split(/\s+/).slice(1);
  if (args.some(t => t.startsWith('-') && !['--test', '-q', '-v', '--verbose'].includes(t))) throw new Error('Unsupported interpreter/test flags; no inline evaluation, preload, require, config or plugin arguments');
  const target = args.filter(t => !t.startsWith('-'));
  if (!target.length || target.some(t => !normalized.includes(t))) throw new Error('Every visible file argument must be declared exactly; no evaluation expressions or opaque arguments');
  return { toolName, input: structuredClone(input), inputDigest: digest(input), paths: normalized, pathDigests,
    seconds, boundary: 'Direct human authorization of this exact invocation and declared file versions only; not execution sandbox or scientific acceptance' };
}
