/**
 * Dynamic delegation policy for joined research workbench sessions.
 *
 * Capabilities are derived only from the tools Pi reports as active for the
 * current prompt (event.systemPromptOptions.selectedTools). The module never
 * assumes a package or an agent name is installed. It only adds prompt guidance
 * and a bounded context nudge; it never blocks a direct tool.
 */

export const DELEGATION_NUDGE_TYPE = 'research-delegation-nudge';
export const DEFAULT_BULK_THRESHOLD = 6;

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

/**
 * Detect explicit user restrictions in the current prompt. Read-only/review
 * phrases constrain specialists to no-write work but do not forbid delegation.
 * Only explicit no-delegate and forbidden data/model export suppress it.
 */
export function detectDelegationRestrictions(text) {
  const value = typeof text === 'string' ? text : '';
  const noDelegate = /\b(?:do not|don't|must not|should not|never)\s+(?:(?:use|call|spawn|dispatch|continue|resume|restart|enable)\s+)?(?:(?:a|an|the)\s+)?(?:sub-?agents?|agents?|delegat(?:e|ion|ing)|dispatch(?:ing)?)\b/i.test(value)
    || /\bno\s+(?:sub-?agents?|delegation|delegating|dispatch(?:ing)?)\b/i.test(value)
    || /(?:不要|不得|禁止|别|无需|不需要)\s*(?:(?:再|又|去|继续|恢复|马上|立刻|使用|调用|派发|委派|启用)\s*)*(?:子代理|子智能体|subagent|多智能体|多\s*agent|代理|委派|派发)/i.test(value)
    || /(?:只|仅)(?:能|需|用)?\s*(?:直接|自己)\s*(?:执行|处理|做)/i.test(value);
  const readOnly = /\bread[- ]?only\b|\breview[- ]?only\b|\bonly\s+(?:review|analy[sz]e|inspect)\b|\bplan mode\b|\b(?:do not|don't|must not|should not)\s+(?:modify|edit|write|change)\b|只读|仅读|只做分析|只审查|仅审查|只评审|仅评审|只查看|不要修改|不得修改|禁止修改/i.test(value);
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
  const value = typeof text === 'string' ? text : '';
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
    || /\b(?:not\s+read[- ]?only|read[- ]?write\s+(?:is\s+)?(?:allowed|enabled|ok))\b/i.test(value)
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
export function mergeDelegationRestrictions(previous, text) {
  const prior = normalizeRestrictions(previous);
  const current = detectDelegationRestrictions(text);
  const resume = detectDelegationResume(text, current);
  return restrictionState(
    resume.delegation ? false : prior.noDelegate || current.noDelegate,
    resume.readOnly ? false : prior.readOnly || current.readOnly,
    resume.export ? false : prior.exportLimited || current.exportLimited,
  );
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
    'Verified call shapes (use only the tools listed above; omit examples for absent families):',
  ];
  if (restriction.readOnly) {
    lines.push('READ-ONLY MODE: delegate only read-only analysis. Tell each child: do not edit or write files, do not mutate state, do not install packages, and do not run state-changing commands. Return findings and evidence paths only.');
  }
  if (caps.piSubagents) {
    lines.push('  subagent({ agent: "research-literature", task: "Answer <bounded question>. Return a short conclusion and evidence paths only.", async: true, options: { context: "fresh" } })');
  }
  if (caps.tintinAgent) {
    lines.push('  Agent({ subagent_type: "Explore", prompt: "Answer <bounded question>. Return a short conclusion and evidence paths only.", description: "Explore <area>", run_in_background: true })');
  }
  if (caps.tintinWorkflow) {
    lines.push('  SubagentWorkflow({ scriptPath: "<existing-workflow>.js", args: { target: "<path>" } })');
  }
  lines.push(
    'Guidelines:',
    '- For pi-subagents, put `agent` and `task` at the top level and other controls under `options`; do not use the old `subagent(agentName, prompt)` form. Check the actual agent/workflow list before naming one.',
    '- Give each child a bounded question, expected output, and evidence paths. Never ask a child to run model training/serving or other unauthorized model work.',
    '- Keep the lead context small: request a short conclusion plus file paths, then verify key claims yourself; do not import full child transcripts or dumps.',
    '- Collaborators may recursively delegate separable work inside the same owner, workspace, charter and permission scope. Respect installed depth, role and concurrency limits; SSH, agy and supervisor roles remain leaves.',
    `- Use read/grep/find/ls for planning and verification. Managed collaborators must declare a plan or an indivisible-task reason before bulk work; coordinators wait for child receipts before completion.${restriction.readOnly ? ' In read-only mode, use only read-only commands and do not modify files.' : ''}`,
  );
  if (caps.researchSession) {
    lines.push('- `research_session` is active for independent Pi processes with real parent links. Supply tasks when a collaborator receives several jobs; the server automatically dispatches that structured list.');
  }
  if (caps.researchDispatch) lines.push(
    '- For a broad goal, prefer `research_dispatch` action=delegate with stable planId, task (goal, mandatory constraints, acceptance criteria and file references) and stage. A separate execution coordinator does the detailed decomposition, dispatch, debugging, evidence review and aggregation. The lead keeps scope, key decisions and the final conclusion; do not bulk-read the project before handing off.',
    '- `research_dispatch` action=plan executes an already decomposed DAG, enforces dependencies and concurrency, and records child reports. Use stable planId on retries. For indivisible work record atomic with a reason; never substitute prose for an execution receipt.',
    '- Default dispatch replies are bounded summaries. Read selected evidence with status view=detail and planId/taskId; follow nextOffset for additional pages. Detailed child logs stay in child sessions/files. Wait for completion notifications; do not poll or re-run delegated work in the lead context.',
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
    state.caps = detectDelegationTools(event?.systemPromptOptions?.selectedTools);
    if (!state.joined) return undefined;
    if (event?.messageType === 'user' && typeof event.prompt === 'string') {
      state.restrictions = mergeDelegationRestrictions(state.restrictions, event.prompt);
    }
    return undefined;
  }));
  disposers.push(pi.on('input', (event, ctx) => {
    const state = stateFor(ctx);
    if (!state.joined) return undefined;
    if (typeof event?.text === 'string') {
      state.restrictions = mergeDelegationRestrictions(state.restrictions, event.text);
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
