/**
 * Dynamic delegation policy for research workbench and standalone sessions.
 *
 * Capabilities are derived only from the tools Pi reports as active for the
 * current prompt (event.systemPromptOptions.selectedTools). The module never
 * assumes a package or an agent name is installed. It only adds prompt guidance
 * and a bounded context nudge; it never blocks a direct tool.
 */

import { readFileSync } from 'node:fs';

export const DELEGATION_NUDGE_TYPE = 'research-delegation-nudge';
export const DEFAULT_BULK_THRESHOLD = 6;

// Load the release policy once so prompt turns share its exact priority chains.
const MODEL_POLICY = JSON.parse(readFileSync(new URL('../model-policy.json', import.meta.url), 'utf8'));
const MODEL_ORDERS = Object.fromEntries(['worker', 'commander', 'intelligence'].map(tier => [
  tier,
  [...MODEL_POLICY.tiers[tier].models, ...(MODEL_POLICY.tiers[tier].fallbackChain ?? [])].join(' -> '),
]));

/** Read/search tools whose repeated use in the lead context should trigger a nudge. */
const BULK_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'bash', 'web_search', 'fetch_content']);

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);

function selectedToolList(selectedTools) {
  if (!Array.isArray(selectedTools)) return null;
  return selectedTools
    .filter(name => typeof name === 'string' && name.trim())
    .map(name => name.trim());
}

/**
 * Detect the delegation families actually present in the active tool loadout.
 * Unknown or absent metadata is reported as unknown rather than guessed.
 */
export function detectDelegationTools(selectedTools) {
  const names = selectedToolList(selectedTools);
  if (!names) {
    return {
      known: false, available: false, families: [], selectedTools: [],
      piSubagents: false, tintinAgent: false, tintinWorkflow: false,
      enableOnly: false, researchSession: false, researchDispatch: false,
    };
  }
  const has = name => names.includes(name);
  const piSubagents = has('subagent');
  const tintinAgent = has('Agent');
  const tintinWorkflow = has('SubagentWorkflow');
  const researchSession = has('research_session');
  const researchDispatch = has('research_dispatch');
  const families = [];
  if (piSubagents) families.push('pi-subagents');
  if (tintinAgent) families.push('tintinweb-agent');
  if (tintinWorkflow) families.push('tintinweb-workflow');
  if (researchSession) families.push('research-session');
  if (researchDispatch) families.push('research-dispatch');
  const enableOnly = families.length === 0 && has('subagents_enable');
  return {
    known: true,
    available: piSubagents || tintinAgent || tintinWorkflow || researchSession || researchDispatch,
    families,
    selectedTools: names,
    piSubagents,
    tintinAgent,
    tintinWorkflow,
    enableOnly,
    researchSession,
    researchDispatch,
  };
}

function restrictionState(noDelegate, readOnly, exportLimited) {
  // Read-only is a delegation constraint, not a delegation prohibition.
  return { noDelegate, readOnly, exportLimited, blocked: noDelegate || exportLimited };
}

function normalizeRestrictions(value) {
  if (typeof value === 'string') return detectDelegationRestrictions(value);
  if (!object(value)) return restrictionState(false, false, false);
  return restrictionState(value.noDelegate === true, value.readOnly === true, value.exportLimited === true);
}

/** Quoted examples, fenced diagnostics and field values are not permission instructions. */
function instructionClauses(text) {
  const value = typeof text === 'string' ? text : '';
  return value
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)|~~~[^\n]*\n[\s\S]*?(?:~~~|$)/g, '\n')
    .replace(/^\s*>.*$/gm, '')
    .replace(/`[^`\n]*`|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?<![\p{L}\p{N}])'[^'\n]*'/gu, ' OBJECT ')
    .replace(/^\s*(?:[-*+]\s+|\d+[.)、]\s+)/gm, '')
    .split(/[\n。！!；;，,]+|\.(?=\s|$)/)
    .map(clause => clause.trim().replace(/^(?:constraints?|restrictions?|permissions?|mode|要求|约束|限制|权限|模式)\s*[:：]\s*/i, '').replace(/^please\s+/i, ''))
    .filter(clause => clause && !/^(?:readOnly|noDelegate|exportLimited)\s*[:=]/i.test(clause));
}

/** Object-specific preservation must not become an assignment-wide shell ban. */
function taskReadOnly(text) {
  return instructionClauses(text).some(clause => {
    if (/^(?:read[- ]?only|review[- ]?only)(?:$|[:：]|\s+(?:mode|task|assignment|session|analysis|review|inspection)\b)|^plan mode\b/i.test(clause)
      || /^(?:(?:this|the|entire|whole|current)\s+)*(?:task|assignment|session|work|project)\s+(?:is|remains?|stays?|(?:must|should|shall)\s+(?:be|remain))\s+(?:strictly\s+)?(?:read[- ]?only|review[- ]?only)\b/i.test(clause)
      || /^(?:this is (?:a|an)\s+|(?:you (?:must|should) )?keep (?:this|the) (?:task|assignment|session)\s+)(?:read[- ]?only|review[- ]?only)\b/i.test(clause)
      || /^(?:(?:you|we)\s+(?:must|should|may|can)\s+)?only\s+(?:review|analy[sz]e|inspect|read)\b/i.test(clause)
      || /^no\s+(?:writes?|edits?|modifications?|changes?)(?:$|\s+(?:allowed|permitted)\b)/i.test(clause)) return true;
    const english = clause.match(/^(?:(?:you|we)\s+)?(?:do not|don't|must not|should not|never|are not allowed to)\s+(?:modify|edit|write|change)(?:\s+or\s+(?:modify|edit|write|change))*\b\s*(.*)$/i);
    // Split only a following action, not an object list such as files or folders in data/.
    const englishTarget = english?.[1].split(/\s+(?:and|or|nor)\s+(?:(?:do not|don't|must not|should not|never)\s+)?(?=(?:run|execute|modify|edit|write|change)\b)/i, 1)[0];
    if (english && /^(?:to\s+)?(?:(?:any|all|the|project|workspace|existing|source)\s+)*(?:files?|anything|everything|project|repository|workspace|code)?(?:\s+at all)?$/i.test(englishTarget)) return true;
    const chinese = clause.replace(/^(?:(?:本|当前|整个|全部)(?:任务|会话|工作|项目)\s*)(?:(?:必须|应当|应|需|须)\s*)?(?:(?:保持|为|是|设为|采用)\s*)?/, '')
      .split(/(?:、|并且|并|且|或者|或|以及)\s*(?:(?:不要|不得|禁止|不允许|不能|不可|严禁)\s*)?(?=(?:运行|执行|修改|编辑|写入|写文件|改动|更改|进行))/, 1)[0].trim();
    return /^(?:(?:只读|仅读)(?:$|[:：]|模式|分析|审查|评审|查看)|只做分析|仅做分析|只审查|仅审查|只评审|仅评审|只查看|仅查看|只分析|仅分析)/.test(chinese)
      || /^(?:不要|不得|禁止|不允许|不能|不可|严禁)\s*(?:修改|编辑|写入|写文件|改动|更改)\s*(?:(?:任何|所有|全部)?(?:项目|工作区)?(?:文件|内容|代码)|任何东西)?$/.test(chinese)
      || /^(?:不要|不得|禁止|不允许|不能|不可|严禁)(?:进行)?(?:任何|所有|全部)?(?:修改|编辑|写入|改动|更改)$/.test(chinese);
  });
}

/**
 * Detect explicit user restrictions in the current prompt. Only task-wide
 * read-only instructions constrain all tools; object protection stays scoped.
 * No-delegate and forbidden export detection intentionally remain unchanged.
 */
export function detectDelegationRestrictions(text) {
  const value = typeof text === 'string' ? text : '';
  const noDelegate = /\b(?:do not|don't|must not|should not|never)\s+(?:(?:use|call|spawn|dispatch|continue|resume|restart|enable)\s+)?(?:(?:a|an|the)\s+)?(?:sub-?agents?|agents?|delegat(?:e|ion|ing)|dispatch(?:ing)?)\b/i.test(value)
    || /\bno\s+(?:sub-?agents?|delegation|delegating|dispatch(?:ing)?)\b/i.test(value)
    || /(?:不要|不得|禁止|别|无需|不需要)\s*(?:(?:再|又|去|继续|恢复|马上|立刻|使用|调用|派发|委派|启用)\s*)*(?:子代理|子智能体|subagent|多智能体|多\s*agent|代理|委派|派发)/i.test(value)
    || /(?:只|仅)(?:能|需|用)?\s*(?:直接|自己)\s*(?:执行|处理|做)/i.test(value);
  const readOnly = taskReadOnly(value);
  const exportLimited = /\b(?:do not|don't|must not|never)\s+(?:send|share|export|upload|forward)\b[^.\n]{0,80}\b(?:external|third[- ]party|outside|model|provider)\b/i.test(value)
    || /\b(?:do not|don't|must not|never)\s+(?:export|share|upload)\s+(?:the\s+)?(?:data|results?|files?|materials?)\b/i.test(value)
    || /\bno\s+(?:external|third[- ]party)\s+(?:model|data|export|sharing)\b/i.test(value)
    || /(?:不要|不得|禁止|不允许|不能|不可)\s*(?:将|把)?[^。\n]{0,30}(?:外发|外传|上传|发送|共享|导出|交给)[^。\n]{0,30}(?:外部|第三方|云端|服务商|模型)/i.test(value)
    || /(?:不要|不得|禁止|不允许|不能|不可)\s*(?:调用|使用)?\s*(?:外部|第三方)\s*(?:模型|服务|API)/i.test(value)
    || /(?:数据|内容|材料)\s*(?:不得|不能|禁止|不可)\s*(?:外发|外传|上传|共享|出境)/i.test(value)
    || /(?:不要|不得|禁止|不允许|不能|不可)\s*(?:外发|外传|上传|导出|共享)/i.test(value);
  return restrictionState(noDelegate, readOnly, exportLimited);
}

/** Explicit permission to resume delegation, editing or external-model export. */
function detectDelegationResume(text, current) {
  // A diagnostic quotation, false field or negated permission never grants access.
  const value = instructionClauses(text)
    .map(clause => clause.replace(/^(?:本|当前|整个|全部)(?:任务|会话|工作|项目)\s*/, ''))
    .filter(clause =>
    /^(?:you (?:may|can)\b|ok(?:ay)? to\b|go ahead and\b|feel free to\b|(?:delegation|sub-?agents?|external|third[- ]party)\b|(?:resume|restart|continue|enable)\s+delegation\b|delegate\s+again\b|(?:use|call|spawn|dispatch)\s+(?:(?:a|the)\s+)?sub-?agents?\b|read[- ]?write\b|可以|允许|同意|恢复|继续|尽管|使用子代理|调用子代理|派发子代理|委派子代理|启用子代理)/i.test(clause)
    && !/\b(?:not|never|cannot|can't|no|if|unless|example|diagnostic)\b|[?？()（）]|不(?:允许|得|能|可|要)|禁止|严禁|吗|示例|诊断/i.test(clause)
  ).join('\n');
  const delegation = !current.noDelegate && (
    /\b(?:you may|you can|ok(?:ay)? to|go ahead and|feel free to)\s+(?:now\s+)?(?:delegate|use\s+(?:a\s+)?sub-?agents?|spawn\s+(?:a\s+)?sub-?agents?)\b/i.test(value)
    || /\b(?:delegation|sub-?agents?)\s+(?:is|are)\s+(?:allowed|enabled|permitted|ok(?:ay)?)\b/i.test(value)
    || /\b(?:resume|restart|continue|enable)\s+delegation\b/i.test(value)
    || /\bdelegate\s+again\b/i.test(value)
    || /\b(?:use|call|spawn|dispatch)\s+(?:a\s+|the\s+)?sub-?agents?\b/i.test(value)
    || /(?:可以|允许|同意|恢复|继续|尽管)\s*(?:使用|调用|派发|委派|启用)?\s*(?:子代理|子智能体|subagent|多智能体|多\s*agent|委派|派发)/i.test(value)
    || /(?:使用|调用|派发|委派|启用)\s*(?:子代理|子智能体|subagent|多智能体|多\s*agent)/i.test(value)
  );
  const readOnly = !current.readOnly && (
    /\b(?:you may|you can|ok(?:ay)? to|go ahead and|feel free to)\s+(?:now\s+)?(?:modify|edit|write|change)\b/i.test(value)
    || /\bread[- ]?write\s+(?:is\s+)?(?:allowed|enabled|ok)\b/i.test(value)
    || /(?:可以|允许|同意|恢复|继续)\s*(?:修改|编辑|写入|写文件|改动)/i.test(value)
  );
  const exportAllowed = !current.exportLimited && (
    /\b(?:you may|you can|ok(?:ay)? to|go ahead and|feel free to)\s+(?:now\s+)?(?:send|share|export|upload)\b[^.\n]{0,40}\b(?:external|third[- ]party|model|provider)\b/i.test(value)
    || /\b(?:external|third[- ]party)\s+(?:model|data|export|sharing)\s+(?:is|are)\s+(?:allowed|enabled|permitted|ok)\b/i.test(value)
    || /(?:可以|允许|同意|恢复|继续|尽管)\s*(?:外发|外传|调用外部模型|使用外部模型)/i.test(value)
    || /(?:可以|允许|同意|恢复|继续|尽管)\s*(?:将|把)?[^。\n]{0,30}(?:上传|发送|共享|导出)[^。\n]{0,30}(?:外部|第三方|云端|模型)/i.test(value)
  );
  return { delegation, readOnly, export: exportAllowed };
}

/**
 * Shared restriction update: neutral follow-ups preserve previous restrictions.
 * Only an explicit user permission clears the corresponding flag.
 */
export function mergeDelegationRestrictions(previous, text, { allowResume = true } = {}) {
  const prior = normalizeRestrictions(previous);
  const current = detectDelegationRestrictions(text);
  const resume = allowResume ? detectDelegationResume(text, current) : {};
  return restrictionState(
    resume.delegation ? false : prior.noDelegate || current.noDelegate,
    resume.readOnly ? false : prior.readOnly || current.readOnly,
    resume.export ? false : prior.exportLimited || current.exportLimited,
  );
}

/** Startup/sendUserMessage prompts can tighten, never impersonate a human permission update. */
export function mergeDelegationEventRestrictions(previous, event, input = false) {
  if (!input && event?.messageType === 'custom') return normalizeRestrictions(previous);
  const text = input ? event?.text : event?.prompt;
  if (typeof text !== 'string') return normalizeRestrictions(previous);
  // This exact generated envelope may arrive through the ordinary RPC input path.
  // Recognizing it can only withhold a permission relaxation, never remove a limit.
  const startup = text.startsWith('You are a research collaborator in a fresh Pi session joined to the confirmed research workbench.');
  return mergeDelegationRestrictions(previous, text, {
    // RPC identifies a transport, not a human; absent separate proof it only tightens.
    allowResume: input && !startup && event?.source === 'interactive',
  });
}

/** Explicit opt-outs disable advice; child status alone is not an opt-out. */
export function delegationPolicyDisabled(env = process.env) {
  const value = env ?? {};
  if (value.PI_RESEARCH_DISABLE_DELEGATION === '1') return true;
  return /^(?:0|off|false|no|disabled)$/i.test(String(value.PI_RESEARCH_DELEGATION_POLICY ?? ''));
}

function familySummary(caps) {
  const labels = [];
  if (caps.piSubagents) labels.push('pi-subagents `subagent`');
  if (caps.tintinAgent) labels.push('@tintinweb `Agent`');
  if (caps.tintinWorkflow) labels.push('@tintinweb `SubagentWorkflow`');
  if (caps.researchSession) labels.push('`research_session`');
  if (caps.researchDispatch) labels.push('`research_dispatch`');
  return labels.join(', ');
}

function routingGuidance(caps) {
  const research = caps.researchSession || caps.researchDispatch;
  const lines = research ? [
    'Joined res-workflow routing: use the full catalog of research-* roles, utility pi-subagents and agy-advisor according to the available tools.',
    '- Reserve research-* roles and formal Multi-Agent work for scientific hypotheses, theory, literature synthesis and critic work. Use research_dispatch action=plan when available for the confirmed scientific task graph.',
    '- Offload engineering, repository search, logs, diff review and verification to utility pi-subagents in subordinate capacity slots. Respect the installed concurrency limit, normally three child slots per collaborator.',
  ] : [
    'Standalone / non-research routing: primarily choose the seven utility pi-subagents scout, researcher, reviewer, evidence-auditor, worker, oracle and delegate. Use agy-advisor on demand. Use research-* scientific roles only when explicitly requested.',
  ];
  if (caps.piSubagents) lines.push(
    '- Judge scope before reading: unknown multi-directory or log searches go to parallel scout tasks, post-edit diff/compliance checks to reviewer, isolated build/fix work to worker, external lookup to researcher, difficult evidence verification to evidence-auditor, plan consistency to oracle and bounded general work to delegate. Read or grep one known file directly.',
    '- The parent must pass an explicit top-level model dynamically for every utility role, selected by work form and remaining tier quota. Keep utility roles free of fixed model pins.',
    `- Worker order: ${MODEL_ORDERS.worker}. Exhaust the Flash pool before Terra, then use the policy fallback chain.`,
    `- Commander order: ${MODEL_ORDERS.commander}. When quota is exhausted, switch directly to the next model in this order.`,
    `- Intelligence order: ${MODEL_ORDERS.intelligence}. Escalate to the next reasoning level when unsolved or higher reasoning is required. Routine scout/researcher/worker/delegate work uses worker quota, review/oracle work uses commander quota, and difficult evidence/root-cause work uses intelligence quota.`,
    '- agy-advisor discovers live agy models and effort levels, then obtains user confirmation of the exact model + effort before executing agy or agy-subagent. A child routes that question through contact_supervisor to the parent ask_user UI. Retain workspace read-only and export restrictions.',
  );
  return lines;
}

/**
 * Build compact, schema-accurate guidance for the active delegation tools.
 * Returns '' when no delegation tool is active or the user restricted it.
 */
export function buildDelegationGuidance({ selectedTools, restrictions, env } = {}) {
  if (delegationPolicyDisabled(env)) return '';
  const restriction = normalizeRestrictions(restrictions);
  if (restriction.blocked) return '';
  const caps = detectDelegationTools(selectedTools);
  if (!caps.known) return '';
  if (!caps.available) {
    if (!caps.enableOnly) return '';
    return [
      '【Dynamic delegation policy】',
      '`subagents_enable` is active, so pi-subagents is installed but the `subagent` tool is not in the current tool list.',
      'If the user authorizes delegation, call `subagents_enable`, then use the `subagent` schema shown in the next prompt. Until then, do the work with direct tools.',
    ].join('\n');
  }

  const lines = [
    '【Dynamic delegation policy (verified against the active tool loadout)】',
    `Active delegation tools: ${familySummary(caps)}.`,
    'Be proactive: when the routing rule below matches, delegate without waiting for a separate instruction.',
    'Route work deliberately:',
    '- Delegate bulk or independent work: broad multi-file exploration, long logs or papers, independent batch analysis, multiple source comparisons, or a second independent check.',
    `- Do the work directly: one known file, one lookup, one trivial check,${restriction.readOnly ? ' or a small read-only inspection.' : ' or a small edit.'}`,
    ...routingGuidance(caps),
    'Verified call shapes (use only the tools listed above; omit examples for absent families):',
  ];
  if (restriction.readOnly) {
    lines.push('READ-ONLY MODE: delegate only read-only analysis. Tell each child: do not edit or write files, do not mutate state, do not install packages, and do not run state-changing commands. Return findings and evidence paths only.');
  }
  if (caps.piSubagents) {
    lines.push(`  subagent({ agent: "scout", task: "Answer <bounded question>. Return a short conclusion and evidence paths only.", model: ${JSON.stringify(MODEL_POLICY.tiers.worker.models[0])}, async: true, options: { context: "fresh" } })`);
  }
  if (caps.tintinAgent) {
    lines.push('  Agent({ subagent_type: "Explore", prompt: "Answer <bounded question>. Return a short conclusion and evidence paths only.", description: "Explore <area>", run_in_background: true })');
  }
  if (caps.tintinWorkflow) {
    lines.push('  SubagentWorkflow({ scriptPath: "<existing-workflow>.js", args: { target: "<path>" } })');
  }
  lines.push(
    'Guidelines:',
    '- For pi-subagents, put `agent`, `task` and `model` at the top level and other controls under `options`; do not use the old `subagent(agentName, prompt)` form. Check the actual agent/workflow list before naming one.',
    '- Give each child a bounded question, expected output, and evidence paths. Never ask a child to run model training/serving or other unauthorized model work.',
    '- Keep the lead context small: request a short conclusion plus file paths, then verify key claims yourself; do not import full child transcripts or dumps.',
    '- Collaborators may recursively delegate separable work inside the same owner, workspace, charter and permission scope. Respect installed depth, role and concurrency limits; SSH, agy and supervisor roles remain leaves.',
    `- Use read/grep/find/ls for planning and verification. Managed collaborators must declare a plan or an indivisible-task reason before bulk work; coordinators wait for child receipts before completion.${restriction.readOnly ? ' In read-only mode, use only read-only commands and do not modify files.' : ''}`,
  );
  if (caps.researchSession) {
    lines.push('- `research_session` is active for independent Pi processes with real parent links. Supply tasks when a collaborator receives several jobs; the server automatically dispatches that structured list.');
  }
  if (caps.researchDispatch) lines.push(
    '- The lead decomposes the initial scope and obtains user confirmation, then submits `research_dispatch` action=plan. Branch owners autonomously plan their subsequent children inside the approved scope. A separate coordinator is optional, never mandatory.',
    '- `research_dispatch` action=plan executes an already decomposed DAG, enforces dependencies and concurrency, and records child reports. Use stable planId on retries. For indivisible work record atomic with a reason; never substitute prose for an execution receipt.',
    '- Default dispatch replies are bounded summaries. Read selected evidence with status view=detail and planId/taskId; follow nextOffset for additional pages. Detailed child logs stay in child sessions/files. Wait for completion notifications; do not poll or re-run delegated work in the lead context.',
    '- Formal parent/child messages and direct-session reports use `research_communication`. Reply to exact request IDs; ack handled non-request messages. Keep only short findings and evidence references in parent contexts. Do not implement ad-hoc shell forwarding or file watchers.',
  );
  return lines.join('\n');
}

/** Short mid-turn escalation, inserted only after repeated bulk reads. */
export function buildDelegationNudge(count, { threshold = DEFAULT_BULK_THRESHOLD, selectedTools, restrictions } = {}) {
  const restriction = normalizeRestrictions(restrictions);
  if (restriction.blocked) return '';
  const caps = detectDelegationTools(selectedTools);
  if (!caps.available || !Number.isSafeInteger(count) || count < threshold) return '';
  const lines = [
    `[Delegation nudge] ${count} broad read/search operations have run in this lead context while delegation is available.`,
    'If the remaining work is still broad or parallel, stop bulk-reading here and dispatch a bounded specialist using the active tool shape; ask for a short conclusion plus evidence paths.',
    'If this is one known file or a trivial check, continue directly.',
    caps.researchSession || caps.researchDispatch
      ? 'Use utility subagents for engineering/search/diff chores within subordinate slots, reserving research-* and formal plans for scientific work.'
      : 'Prefer scout for unknown multi-directory/log exploration, reviewer for post-edit checks and worker for an isolated build/fix. Choose utility-role models dynamically by the three-tier quota order in the routing guidance.',
  ];
  if (restriction.readOnly) {
    lines.push('Read-only mode: the specialist must not edit or write files, mutate state, install packages, or run state-changing commands; ask for findings and evidence paths only.');
  }
  return lines.join(' ');
}

/**
 * Register the per-turn bulk-work counter and context nudge.
 * Parent wiring: call once from the research-loop extension entry point.
 * Returns a disposer. It never blocks tools and never spawns work itself.
 */
export function registerDelegationPolicy(pi, options = {}) {
  if (!pi || typeof pi.on !== 'function') return () => {};
  const threshold = Number.isSafeInteger(options.bulkThreshold) && options.bulkThreshold > 0
    ? options.bulkThreshold
    : DEFAULT_BULK_THRESHOLD;
  const env = options.env ?? process.env;
  const isJoinedPredicate = typeof options.isJoined === 'function' ? options.isJoined : null;
  const selectedToolsFor = options.getSelectedTools ?? (event => event?.systemPromptOptions?.selectedTools);
  const states = new Map();

  // Fail closed: a globally installed extension must not nudge unrelated sessions.
  const isJoined = ctx => {
    if (!isJoinedPredicate) return false;
    try { return Boolean(isJoinedPredicate(ctx)); } catch { return false; }
  };

  const sessionKey = ctx => {
    const id = ctx?.sessionManager?.getSessionId?.();
    return typeof id === 'string' && id ? id : 'default';
  };
  const stateFor = ctx => {
    const key = sessionKey(ctx);
    let state = states.get(key);
    if (!state) {
      if (states.size >= 64) states.delete(states.keys().next().value);
      state = {
        joined: false,
        bulk: 0,
        nudged: false,
        nudgePending: false,
        caps: detectDelegationTools(null),
        restrictions: restrictionState(false, false, false),
      };
      states.set(key, state);
    }
    return state;
  };
  const disabled = () => delegationPolicyDisabled(env);

  const disposers = [];
  disposers.push(pi.on('before_agent_start', (event, ctx) => {
    const state = stateFor(ctx);
    // Revalidate membership once per run; counting/nudging below use this flag.
    state.joined = isJoined(ctx);
    state.bulk = 0;
    state.nudged = false;
    state.nudgePending = false;
    state.caps = detectDelegationTools(selectedToolsFor(event, ctx));
    if (!state.joined) return undefined;
    if (event?.messageType === 'user' && typeof event.prompt === 'string') {
      state.restrictions = mergeDelegationEventRestrictions(state.restrictions, event);
    }
    return undefined;
  }));
  disposers.push(pi.on('input', (event, ctx) => {
    const state = stateFor(ctx);
    state.joined = isJoined(ctx);
    if (!state.joined) return undefined;
    if (typeof event?.text === 'string') {
      state.restrictions = mergeDelegationEventRestrictions(state.restrictions, event, true);
    }
    return undefined;
  }));
  disposers.push(pi.on('tool_execution_end', (event, ctx) => {
    const state = stateFor(ctx);
    if (!state.joined || disabled() || event?.parentToolCallId || event?.isError) return;
    if (!BULK_TOOLS.has(event?.toolName)) return;
    state.bulk += 1;
    if (state.bulk >= threshold) state.nudgePending = true;
  }));
  disposers.push(pi.on('context', (event, ctx) => {
    const state = stateFor(ctx);
    if (!state.joined || disabled()) return undefined;
    if (!state.nudgePending || state.nudged) return undefined;
    if (!state.caps?.available || state.restrictions?.blocked) return undefined;
    if (!Array.isArray(event?.messages)) return undefined;
    const content = buildDelegationNudge(state.bulk, {
      threshold,
      selectedTools: state.caps.selectedTools,
      restrictions: state.restrictions,
    });
    if (!content) return undefined;
    state.nudged = true;
    state.nudgePending = false;
    return {
      messages: [
        ...event.messages,
        { role: 'custom', customType: DELEGATION_NUDGE_TYPE, content, display: false, timestamp: Date.now() },
      ],
    };
  }));

  return () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch { /* Disposal must not break session shutdown. */ }
    }
    states.clear();
  };
}
