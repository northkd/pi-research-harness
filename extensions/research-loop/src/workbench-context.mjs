import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { readResearchBudget } from './research-budget.mjs';
import { buildDelegationGuidance, mergeDelegationRestrictions } from './delegation-policy.mjs';

export const WORKBENCH_CONTEXT_SECTION = 'res_workflow_records';
const STAGES = new Set(['1-idea', '2-experiment', '3-review', '4-summary', '5-writing']);
const HASH = /^sha256:[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ADOPTION_ID = /^adopt-[a-f0-9]{24}$/;
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = value => createHash('sha256').update(value).digest('hex');
const charterDigest = value => 'sha256:' + digest(JSON.stringify(value));

function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file) throw new Error('unsafe context path');
  return file;
}

/** Context metadata never follows symlinks, blocks on FIFOs or accepts torn records. */
function readJson(file, maximum = 128 * 1024) {
  canonical(file);
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum || before.nlink !== 1) throw new Error('unsafe context file');
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size > maximum) throw new Error('changed context file');
    const buffer = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < buffer.length) { const read = fs.readSync(fd, buffer, count, buffer.length - count, null); if (!read) break; count += read; }
    const bytes = buffer.subarray(0, count), raw = bytes.toString('utf8');
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    const stamp = stat => JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink]);
    if (count !== opened.size || count > maximum || !Buffer.from(raw).equals(bytes) || stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || fs.realpathSync(file) !== file) throw new Error('changed context file');
    const value = JSON.parse(raw);
    if (!object(value)) throw new Error('invalid context record');
    return value;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function sessionHeader(file) {
  canonical(file);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) throw new Error('unsafe session header');
    const buffer = Buffer.alloc(16 * 1024);
    const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.indexOf(10, 0);
    if (end < 0 || end >= read) throw new Error('incomplete session header');
    const header = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    const named = fs.lstatSync(file);
    if (named.isSymbolicLink() || named.ino !== info.ino || named.dev !== info.dev || !object(header) || header.type !== 'session') throw new Error('changed session header');
    return header;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function joined(value, cwd) {
  return object(value) && value.canonicalCwd === cwd && typeof value.joinedAt === 'string' && Number.isFinite(Date.parse(value.joinedAt)) && ['manual', 'adoption', 'spawn'].includes(value.via);
}

function confirmedOwnerAdoption(privateDir, cwd, ownerKey, hash) {
  try {
    const scope = path.join(privateDir, digest(ownerKey), digest(cwd));
    const adopted = readJson(path.join(scope, 'adopted.json'));
    if (adopted.confirmed !== true || !ADOPTION_ID.test(adopted.id ?? '') || !HASH.test(adopted.confirmationHash ?? '')) return null;
    const operation = readJson(path.join(scope, adopted.id + '.json'), 8 * 1024 * 1024);
    if (operation.schema !== 'pi-res-workflow-operation.v1' || operation.ownerKey !== ownerKey || operation.cwd !== cwd || operation.detachedAt || operation.adoption?.id !== adopted.id || operation.adoption.cwd !== cwd || operation.adoption.status !== 'confirmed') return null;
    const receipt = readJson(path.join(cwd, '.pi', 'research-loop', 'adoptions', adopted.id, 'confirmation.json'));
    if (receipt.schema !== 'pi-research-adoption-confirmation.v1' || receipt.adoptionId !== adopted.id || receipt.confirmationHash !== adopted.confirmationHash || receipt.charterHash !== hash || receipt.autoRun !== false) return null;
    return adopted.id;
  } catch { return null; }
}

/** The hook authorizes only this session's exact persisted membership and owner scope. */
export function readWorkbenchRecordContext(ctx, { privateDir = path.join(os.homedir(), '.pi', 'dashboard', 'res-workflow') } = {}) {
  const cwd = canonical(ctx?.cwd);
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  const sessionFile = ctx?.sessionManager?.getSessionFile?.();
  if (!ID.test(sessionId ?? '') || typeof sessionFile !== 'string' || !sessionFile.endsWith('.jsonl')) return null;
  const header = sessionHeader(sessionFile);
  if (header.id !== sessionId || header.cwd !== cwd) return null;
  const meta = readJson(sessionFile.slice(0, -6) + '.meta.json');
  if (meta.cwd !== undefined && meta.cwd !== cwd || meta.originDeviceId || meta.pluginHidden === true || meta.archiveOnEnd === true || meta.driver && meta.driver !== 'pi') return null;
  const persisted = meta.pluginRefs?.['res-workflow']?.resWorkflow;
  if (meta.resWorkflow !== undefined && !joined(meta.resWorkflow, cwd) || persisted !== undefined && !joined(persisted, cwd)) return null;
  if (!joined(persisted ?? meta.resWorkflow, cwd)) return null;
  if (persisted && meta.resWorkflow && JSON.stringify(persisted) !== JSON.stringify(meta.resWorkflow)) return null;
  const principal = meta.principalOwner;
  if (principal !== undefined && (!object(principal) || typeof principal.iss !== 'string' || !principal.iss || typeof principal.sub !== 'string' || !principal.sub)) return null;
  const state = readJson(path.join(cwd, '.pi', 'research-loop', 'state.json'), 256 * 1024);
  if (!object(state.charter) || !Number.isSafeInteger(state.charter.revision) || state.charter.revision < 1 || typeof state.charter.objective !== 'string' || !Array.isArray(state.charter.successCriteria) || !state.charter.successCriteria.length) return null;
  const hash = charterDigest(state.charter);
  // Unowned local Pi sessions can belong to either historical host-local realm.
  // Both require complete host-private proof; a named principal never falls back.
  const owners = principal ? [[principal.iss, principal.sub]] : [['host', 'inert-operator'], ['urn:pi-dashboard:local-operator', 'local-operator']];
  const root = canonical(privateDir);
  const candidates = owners.map(owner => confirmedOwnerAdoption(root, cwd, JSON.stringify(owner), hash)).filter(Boolean);
  if (candidates.length !== 1) return null;
  const adoptionId = candidates[0];
  let budget = null;
  try {
    const current = readResearchBudget({ cwd, charterHash: hash });
    budget = {
      limits: current.limits,
      used: current.usage,
      attemptsEnforced: current.enforcement.attempts === true,
      modelRequestsEnforced: current.enforcement.modelRequests === true,
      scope: 'native-research-workflow',
    };
  } catch { /* Unavailable budget is unknown, never fabricated as zero or unlimited. */ }

  let memory = {
    objective: state.charter?.objective,
    successCriteria: state.charter?.successCriteria ?? [],
    claimsCount: Array.isArray(state.claims) ? state.claims.length : 0,
    acceptedClaims: Array.isArray(state.claims) ? state.claims.filter(c => c.acceptance?.verdict === 'accepted').map(c => c.statement).slice(0, 3) : [],
    recentFindings: '',
  };
  try {
    const ledgerFile = path.join(cwd, 'ledger.jsonl');
    if (fs.existsSync(ledgerFile)) {
      const lines = fs.readFileSync(ledgerFile, 'utf8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-3).map(l => {
        try {
          const item = JSON.parse(l);
          return `- [${item.kind || '尝试'}] ${item.action || ''}: ${item.observed || item.lesson || ''} (信号: ${item.signal || '未知'})`;
        } catch { return ''; }
      }).filter(Boolean);
      memory.recentFindings = recent.join('\n');
    }
  } catch {}

  const researchSession = meta.researchSession ?? meta.pluginRefs?.['res-workflow']?.researchSession;
  const collaborator = object(researchSession) && researchSession.schema === 'pi-research-session.v1' && researchSession.workflowCwd === cwd && researchSession.charterHash === hash && researchSession.adoptionId === adoptionId && ID.test(researchSession.parentSessionId ?? '');
  return { ...(collaborator ? { researchSession: { parentSessionId: researchSession.parentSessionId, spawnToken: researchSession.spawnToken, depth: researchSession.depth, role: researchSession.role, declaredTasks: researchSession.tasks?.length ?? 0 } } : {}), sessionId, adoptionId, charterHash: hash, charterRevision: state.charter.revision, stage: STAGES.has(state.stage) ? state.stage : null, budget, memory };
}

export function buildWorkbenchRecordProtocol(context, memory = context?.memory ?? {}, options = {}) {
  const memSource = object(memory) ? memory : {};
  const mem = memSource.objective ? [
    '',
    '【科研工作流深度记忆与上下文注入 (Research Memory)】',
    `当前研究核心目标：${memSource.objective}`,
    memSource.successCriteria?.length ? `验收成功准则：\n${memSource.successCriteria.map(s => '  - ' + s).join('\n')}` : '',
    `当前阶段已沉淀主张：${memSource.claimsCount} 条${memSource.acceptedClaims?.length ? '（含已通过内部验收主张：' + memSource.acceptedClaims.join('；') + '）' : ''}`,
    memSource.recentFindings ? `最新尝试记录与观测证据：\n${memSource.recentFindings}` : '',
  ].filter(Boolean).join('\n') : '';
  const delegation = buildDelegationGuidance({
    selectedTools: options.selectedTools,
    restrictions: options.restrictions,
    env: options.env,
  });

  return [
    'This Pi session is joined to the confirmed res-workflow research workbench.',
    `Verified current record context: ${JSON.stringify(context)}`,
    mem,
    '',
    delegation,
    '',
    '【工作流五大阶段自动识别与推进】',
    '阶段推进准则：',
    '- 1-idea (探索与构思)：文献调研、方案发散、科研问题收窄；',
    '- 2-experiment (实验与验证)：可判定实验设计、数值模拟、DFT/AIMD 运行与原始数据产出；',
    '- 3-review (评审与自检)：跨模型族交叉对抗评审、假收敛排查、反例寻找；',
    '- 4-summary (主张与闭环)：主张与实验证据逐条核对、边界确认；',
    '- 5-writing (撰写与定稿)：论文撰写、引用真实性审计、产物打包。',
    '当您检测到对话与任务已进入对应阶段时，请及时调用 research_loop action="stage" 推进阶段状态。',
    '',
    'Keep the workbench synchronized through the existing research_loop tool while doing the user-authorized research. This section does not authorize starting or restarting research, replacing the charter, raising budgets, installing software, or publishing.',
    'Before completing a turn that actually finishes a meaningful research attempt, call research_loop action="log" with a stable attemptId, expectedCharterHash equal to this context charterHash, the actionText, kind, expected, observed, lesson, signal and project-relative evidence paths. Reuse the same attemptId only to retry the same already-completed attempt. Do not count every tool call, file read, status query or model response as a scientific attempt.',
    'Record an actual stage change with action="stage". Do not select a stage merely because the dashboard has a template for it. Use action="narrow" only for an explicit evidence-backed narrowing decision.',
    'When the evidence supports stating or revising a research claim, call action="claim" with a stable id, statement, evidence, limitations and the actual supported/partially_supported/refuted/undetermined/failed status. Check existing records first. Do not re-upsert an unchanged accepted claim or generate claims from a task-completed signal.',
    'After a real review, record review-round with its observed reviewer model and response, then review-gate with the actual author model. For each claim acceptance use claim-gate with the actual cross-family jury, completed counterexample evidence and unresolved obligations. Missing evidence means undetermined or blocked, never accepted. A tool success or native subagent completed status is not scientific acceptance.',
    'Only explicit user authorization permits action="publish". Internal acceptance does not authorize publication.',
    'Budget used counts are scoped to the native research workflow. Saved limits do not prove ordinary chat or direct subagent requests are physically intercepted. If the budget is unavailable or modelRequestsEnforced is false, report that fact; do not label the gate active or invent historical request reservations. Use the budgeted research_loop run path only when starting such a run is already authorized by the user.',
    'Use action="status" to inspect existing records when needed. Preserve existing research and return to the current task; do not restart a workflow to make an empty panel look populated.',
  ].join('\n');
}

const restrictionBySession = new Map();

/** Keep a user's opt-out/read-only/export limit across neutral follow-up turns. */
function restrictionsFor(event, ctx) {
  const sessionId = ctx?.sessionManager?.getSessionId?.();
  if (typeof sessionId !== 'string' || !sessionId) return undefined;
  if (event?.messageType === 'user' && typeof event?.prompt === 'string') {
    const restrictions = mergeDelegationRestrictions(restrictionBySession.get(sessionId), event.prompt);
    if (restrictionBySession.size >= 64) restrictionBySession.delete(restrictionBySession.keys().next().value);
    restrictionBySession.set(sessionId, restrictions);
    return restrictions;
  }
  return restrictionBySession.get(sessionId);
}

/** New sessions load the hook once; each turn revalidates live membership and metadata. */
export function registerWorkbenchContext(pi, options = {}) {
  pi.on('before_agent_start', (event, ctx) => {
    const opts = event?.systemPromptOptions;
    if (!object(opts)) return undefined;
    if (object(opts.sections)) delete opts.sections[WORKBENCH_CONTEXT_SECTION];
    if (opts.cwd !== undefined && opts.cwd !== ctx?.cwd) return undefined;
    try {
      const context = readWorkbenchRecordContext(ctx, options);
      if (!context) return undefined;
      const { memory, ...restContext } = context;
      if (!object(opts.sections)) opts.sections = {};
      opts.sections[WORKBENCH_CONTEXT_SECTION] = buildWorkbenchRecordProtocol(restContext, memory, {
        selectedTools: opts.selectedTools,
        restrictions: restrictionsFor(event, ctx),
        env: options.env,
      });
    } catch { /* Missing, revoked, changed or partially written records do not abort Pi. */ }
    return undefined;
  });
}
