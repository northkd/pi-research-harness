import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, loadState, rootDir, saveState, sha256 } from './ledger.mjs';
import { withScientificRecordLock } from './adoption.mjs';
import { readEventsTolerant } from './workflow-progress.mjs';

/**
 * Evidence-based stage observation for joined research sessions.
 *
 * A stage-enter observation says "this session appears to be doing this stage
 * now". It is never a scientific pass, a completed stage or a claim. The only
 * authority for the active stage is the last stage-enter event in events.jsonl.
 */
export const OBSERVED_STAGES = Object.freeze(['1-idea', '2-experiment', '3-review', '4-summary', '5-writing']);
const STAGE_SET = new Set(OBSERVED_STAGES);
const SOURCE = /^[a-z][a-z0-9-]{0,63}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const MAX_EVIDENCE = 20;
const MAX_EVIDENCE_CHARS = 512;

function evidenceList(value) {
  if (value === undefined || value === null) return [];
  let rows;
  if (Array.isArray(value)) rows = value.filter(item => typeof item === 'string');
  else if (typeof value === 'object') rows = Object.entries(value).map(([key, item]) => `${key}=${typeof item === 'object' ? JSON.stringify(item) : String(item)}`);
  else throw new Error('evidence must be an array or object');
  return rows
    .map(item => item.replace(/\0/g, ' ').trim().slice(0, MAX_EVIDENCE_CHARS))
    .filter(Boolean)
    .slice(0, MAX_EVIDENCE);
}

function observedAt(value) {
  if (value === undefined) return new Date().toISOString();
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  if (!Number.isFinite(time)) throw new Error('at must be a valid ISO timestamp');
  return new Date(time).toISOString();
}

function instant(value) {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? time : -Infinity;
}

function lastStageEvent(cwd, revision) {
  const events = readEventsTolerant(path.join(rootDir(cwd), 'events.jsonl'));
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== 'stage-enter' || !STAGE_SET.has(event?.detail?.stage)) continue;
    const eventRevision = event.detail.charterRevision;
    // Events written under an older charter cannot dedupe, order or stale-block
    // an observation made against the current charter.
    if (revision !== undefined && eventRevision !== revision) continue;
    return event;
  }
  return null;
}

/**
 * Record one observed stage entry. Callers that can verify a joined workbench
 * session should pass its charter hash so a changed charter rejects the write.
 * The lock is held only for local synchronous file I/O.
 */
export function recordObservedStage(cwd, input = {}) {
  const stage = input?.stage;
  if (!STAGE_SET.has(stage)) return { changed: false, stage: null, reason: 'unsupported stage' };
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return { changed: false, stage: null, reason: 'cwd must be absolute' };
  const source = typeof input?.source === 'string' && SOURCE.test(input.source) ? input.source : null;
  if (!source) return { changed: false, stage: null, reason: 'source must be a bounded label' };
  let evidence;
  try { evidence = evidenceList(input?.evidence); }
  catch (error) { return { changed: false, stage: null, reason: error.message }; }
  const expected = input?.expectedCharterHash;
  if (expected !== undefined && (typeof expected !== 'string' || !HASH.test(expected))) {
    return { changed: false, stage: null, reason: 'invalid expectedCharterHash' };
  }
  // The daemon must prove it classified against the charter it verified.
  if (source === 'daemon' && expected === undefined) {
    return { changed: false, stage: null, reason: 'daemon source requires expectedCharterHash' };
  }
  const sessionId = typeof input?.sessionId === 'string' && SESSION.test(input.sessionId) ? input.sessionId : undefined;
  let at;
  try { at = observedAt(input?.at); }
  catch (error) { return { changed: false, stage: null, reason: error.message }; }
  // Do not create a research directory for a project that has no record.
  if (!fs.existsSync(path.join(rootDir(cwd), 'state.json'))) {
    return { changed: false, stage: null, reason: 'no research charter' };
  }

  return withScientificRecordLock(cwd, () => {
    const state = loadState(cwd);
    if (!state || !state.charter || typeof state.charter.objective !== 'string') {
      return { changed: false, stage: null, reason: 'no research charter' };
    }
    const revision = state.charter.revision;
    // A stage preserved from an older charter is not an entry into this one.
    const current = state.stageCharterRevision === revision && STAGE_SET.has(state.stage) ? state.stage : null;
    if (expected !== undefined && sha256(state.charter) !== expected) {
      return { changed: false, stage: current, reason: 'charter changed' };
    }
    const last = lastStageEvent(cwd, revision);
    const lastStage = last ? last.detail.stage : null;
    // A repeated observation must not spam events, but a stage recorded without
    // a visible event is healed instead of silently assumed to be entered.
    if (lastStage === stage && current === stage) {
      return { changed: false, stage, reason: 'already current' };
    }
    const newest = Math.max(
      instant(last?.detail?.observedAt),
      instant(last?.detail?.selectedAt),
      instant(last?.at),
      state.stageCharterRevision === revision ? instant(state.stageObservedAt) : -Infinity,
    );
    if (instant(at) < newest) {
      return { changed: false, stage: current, reason: 'stale observation' };
    }
    if (stage !== current && evidence.length === 0) {
      return { changed: false, stage: current, reason: 'stage change requires evidence' };
    }
    if (lastStage === stage && current !== stage) {
      state.stage = stage;
      state.stageSource = source;
      state.stageObservedAt = at;
      state.stageCharterRevision = revision;
      state.updatedAt = new Date().toISOString();
      saveState(cwd, state);
      return { changed: true, stage };
    }
    appendEvent(cwd, 'stage-enter', {
      stage,
      phase: state.phase ?? 1,
      charterRevision: state.charter.revision,
      source,
      evidence,
      observed: true,
      observedAt: at,
      ...(sessionId ? { sessionId } : {}),
      eventId: `stage-observation:${source}:${stage}:${at}`,
    });
    state.stage = stage;
    state.stageSource = source;
    state.stageObservedAt = at;
    state.stageCharterRevision = revision;
    state.updatedAt = new Date().toISOString();
    saveState(cwd, state);
    return { changed: true, stage };
  });
}

/**
 * Hook-facing entry: verify the caller handed us a joined-session context,
 * classify only bounded prompt/tool evidence, then write under the same charter
 * CAS and record lock. An unverified context writes nothing.
 */
export function observeStageTurn(cwd, context, { userText = '', tools = [], at } = {}) {
  if (!context || typeof context.charterHash !== 'string' || !HASH.test(context.charterHash)) return null;
  if (typeof context.sessionId !== 'string' || !SESSION.test(context.sessionId)) return null;
  // recordObservedStage dedupes against the current charter. Passing a possibly
  // stale context.stage here would suppress a same-stage entry for a new charter.
  const candidate = classifyObservedStage({ userText, tools });
  if (!candidate) return null;
  return recordObservedStage(cwd, {
    stage: candidate.stage,
    source: candidate.source,
    evidence: candidate.evidence,
    expectedCharterHash: context.charterHash,
    sessionId: context.sessionId,
    at,
  });
}

// ---------------------------------------------------------------------------
// Conservative text/tool classification used by the Pi hook. The hook feeds
// only the user's own prompt and bounded tool intent/result summaries here;
// the injected system prompt is never an input.

const PROTOCOL_LINE = /(?:当您检测到|阶段推进准则|工作流五大阶段|调用\s*research_loop|research_loop\s+action|This Pi session is joined|Verified current record context|Research Memory|Context Management)/i;
const NEGATION = /(?:不要|不用|不必|无需|不需要|别(?:再|去|急)?|尚未|还没|没有|并不|并非|不是|避免|暂不|先不|不再|取消|停止|放弃|拒绝|not\b|don['’]t|do not|without|no need|never|skip)/i;
const FUTURE = /(?:以后|之后|稍后|下一步|接下来|明天|将来|未来|计划|打算|准备(?:要|去|做|写|跑|进行|开始)|即将|将要|待会|回头|再(?:做|写|跑|进行|去)|later\b|next\s+(?:step|time|week)|tomorrow|will\b|plan(?:ning)?\s+to|going\s+to|someday)/i;
const QUESTION = /(?:是否|要不要|需不需要|该不该|能不能|可不可以|吗\s*[?？]?\s*$)/i;
const BOUNDARY = /[。；;！!?？\n]/;

const STAGE_PATTERNS = {
  '1-idea': [
    /(?:文献|论文)(?:调研|检索|综述|梳理|阅读)/i,
    /(?:调研|梳理|检索)(?:文献|资料)/i,
    /(?:idea|构思|选题|查新|探索(?:方向|阶段)?|literature\s+(?:review|survey|search)|brainstorm|novelty\s+check)/i,
  ],
  '2-experiment': [
    /(?:做|跑|进行|设计|复现)(?:实验|仿真|模拟|基准|测试)/i,
    /(?:实验|数值|仿真|复现)(?:设计|验证|运行|结果)/i,
    /(?:数据集|训练模型|基准测试)/i,
    /(?:run|running|launch|perform|conduct)\s+(?:an?\s+)?experiment/i,
    /(?:experiment(?:s|al)?\s+(?:run|design|validation)|benchmark|simulation|training\s+run)/i,
  ],
  '3-review': [
    /(?:对抗|交叉|多模型族).{0,8}评审/i,
    /(?:评审|自检)(?:阶段)?/i,
    /(?:反例|假收敛|kill\s+argument|cross[- ]model\s+review|peer\s+review|adversarial\s+review|research-critic)/i,
  ],
  '4-summary': [
    /(?:主张|结论)(?:与|和|及)?(?:实验)?证据/i,
    /(?:结果到主张|证据核对|闭环|总结(?:阶段|结论)|claim\s+(?:gate|ledger)|result[- ]to[- ]claim|acceptance)/i,
  ],
  '5-writing': [
    /(?:写|撰写|起草|完成)(?:论文|正文|稿件|稿子)/i,
    /(?:论文|稿件)(?:写作|撰写|起草|定稿)/i,
    /(?:投稿|manuscript|paper\s+(?:writing|draft)|draft(?:ing)?\s+(?:the\s+)?paper|latex|citation\s+audit|引用(?:真实性)?审计)/i,
  ],
};

const START = /(?:开始|启动|着手|开展|进行|做|搞|来)(?:一个|一项|这个|这项|新的?)?(?:研究|课题|调研|实验|论文|探索)|(?:让我们|帮我|我想|我要)(?:研究|探索|调研|做实验|写论文)|(?:research|study|explore|investigate)\s+(?:this|the|a|into)\b/i;

function clauseAt(text, index) {
  let start = 0;
  let end = text.length;
  for (let i = index; i >= 0; i -= 1) if (BOUNDARY.test(text[i])) { start = i + 1; break; }
  for (let i = index; i < text.length; i += 1) if (BOUNDARY.test(text[i])) { end = i; break; }
  return text.slice(start, end);
}

function actionable(clause) {
  if (NEGATION.test(clause) || FUTURE.test(clause) || QUESTION.test(clause)) return false;
  return true;
}

/** Strip quoted protocol, block quotes and fenced/inline code before reading intent. */
export function stripNonIntent(text) {
  if (typeof text !== 'string') return '';
  return text
    .slice(0, 8000)
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    // Quoted text is someone else's words, not this session's action.
    .replace(/「[^」\n]{0,200}」|『[^』\n]{0,200}』|“[^”\n]{0,200}”|"[^"\n]{0,200}"/g, ' ')
    .split('\n')
    .filter(line => {
      const value = line.trim();
      if (!value || value.startsWith('>')) return false;
      if (PROTOCOL_LINE.test(value)) return false;
      if (/^[-*]\s*\d-[a-z]+\s*(?:[（(]|[:：])/.test(value)) return false;
      return true;
    })
    .join('\n')
    .slice(0, 4000);
}

function textCandidate(text) {
  let best = null;
  for (const [stage, patterns] of Object.entries(STAGE_PATTERNS)) {
    for (const pattern of patterns) {
      const re = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g');
      let match;
      while ((match = re.exec(text)) !== null) {
        if (!actionable(clauseAt(text, match.index))) continue;
        if (!best || match.index >= best.index) best = { stage, index: match.index, evidence: `prompt:${match[0].slice(0, 160)}` };
      }
    }
  }
  return best;
}

function summarizeInput(input) {
  if (typeof input === 'string') return input.slice(0, 400);
  if (!input || typeof input !== 'object') return '';
  const fields = ['path', 'file_path', 'command', 'cmd', 'action', 'agentName', 'agent', 'name', 'topic', 'skill', 'pattern'];
  return fields
    .map(field => typeof input[field] === 'string' && input[field].trim() ? `${field}=${input[field].replace(/\s+/g, ' ').trim().slice(0, 160)}` : '')
    .filter(Boolean)
    .join(' ')
    .slice(0, 400);
}

function toolCandidate(item) {
  if (!item || item.ok === false) return null;
  const name = typeof item.name === 'string' ? item.name.slice(0, 64) : '';
  const input = summarizeInput(item.input);
  const text = `${name} ${input}`;
  let stage = null;
  if (/research_loop/.test(name)) {
    if (/\baction=(?:review-round|review-gate)\b|"action"\s*:\s*"(?:review-round|review-gate)"/.test(input)) stage = '3-review';
    else if (/\baction=(?:claim|claim-gate)\b|"action"\s*:\s*"(?:claim|claim-gate)"/.test(input)) stage = '4-summary';
    else if (/\baction=(?:run)\b|"action"\s*:\s*"run"/.test(input)) stage = '2-experiment';
    else if (/\baction=log\b|"action"\s*:\s*"log"/.test(input)) stage = '2-experiment';
  } else if (/(?:write|edit|apply_patch|patch|create)/i.test(name) && /(?:^|[/\\])(?:paper|manuscript|draft|sections?)(?:[/\\]|\.|$)|\.(?:tex|bib)\b/i.test(input)) {
    stage = '5-writing';
  } else if (/(?:write|edit|apply_patch|patch|create)/i.test(name) && /review/i.test(input) && /\.(?:md|json)\b/i.test(input)) {
    stage = '3-review';
  } else if (/bash|shell|exec/i.test(name) && /(?:python|python3|node|rscript|julia|pytest|make).{0,120}(?:train|run|experiment|simulate|benchmark|evaluate|test)/i.test(input)) {
    stage = '2-experiment';
  } else if (/(?:subagent|agent)/i.test(name)) {
    if (/research-critic|reviewer/i.test(input)) stage = '3-review';
    else if (/research-literature|literature/i.test(input)) stage = '1-idea';
    else if (/research-numerics|experiment/i.test(input)) stage = '2-experiment';
  } else if (/research-lit|idea-discovery|novelty-check|openalex|arxiv|literature/i.test(text)) {
    stage = '1-idea';
  } else if (/paper-writing|paper-write|citation-audit|latex/i.test(text)) {
    stage = '5-writing';
  }
  return stage ? { stage, evidence: [`tool:${name}:${input.slice(0, 160)}`] } : null;
}

/**
 * Pick at most one stage from bounded recent user text and observed tools.
 * Actual tool actions outrank prose; quoted protocol, planning, future-only and
 * negated mentions are ignored. Returns null when evidence is absent/ambiguous.
 */
export function classifyObservedStage({ userText = '', tools = [], currentStage = null } = {}) {
  const clean = stripNonIntent(userText);
  const candidates = [];
  for (const item of Array.isArray(tools) ? tools.slice(-16) : []) {
    const candidate = toolCandidate(item);
    if (candidate) candidates.push(candidate);
  }
  if (candidates.length) {
    // Use the most recent observed action, not the first one in the window.
    return { ...candidates[candidates.length - 1], source: 'tool-observed' };
  }
  const candidate = textCandidate(clean);
  if (candidate && candidate.stage !== currentStage) {
    return { stage: candidate.stage, evidence: [candidate.evidence], source: 'conversation' };
  }
  if (START.test(clean) && actionable(clean)) {
    return { stage: '1-idea', evidence: ['prompt:research-start'], source: 'conversation' };
  }
  return null;
}
