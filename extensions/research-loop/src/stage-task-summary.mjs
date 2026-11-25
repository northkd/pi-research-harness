import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { withScientificRecordLock } from './adoption.mjs';
import { sha256 } from './ledger.mjs';

/**
 * Deterministic, bounded recent-task summaries for a joined research project.
 *
 * This is deliberately not a transcript miner or a model summarizer. It accepts
 * only the current user prompt (never the injected system prompt, assistant text
 * or tool results), extracts one short actionable sentence, redacts obvious
 * personal data and writes at most a few summaries to a private project file.
 * It never exports anything by itself and never authorizes a model call.
 */
export const STAGE_TASK_SUMMARY_SCHEMA = 'pi-research.stage-task-summary.v1';
export const STAGE_TASK_SUMMARY_RELATIVE_PATH = '.pi/research-loop/stage-task-summary.json';
export const MAX_TASKS = 4;
export const MAX_SUMMARY_CHARS = 240;
export const MAX_SUMMARY_BYTES = 8 * 1024;
export const MAX_PROMPT_SCAN = 12_000;
// The daemon never forwards more than this from a generated summary file.
export const MAX_PACKET_SUMMARY_CHARS = 1200;

const HASH = /^sha256:[a-f0-9]{64}$/;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|secret|credential|cookie)\s*["']?\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const PHONE = /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?:[\s.-]?\d{2,4})?(?!\d)/g;
const FILE_URL = /file:\/\/\/[^\s，。；;!)）]+/gi;
const WINDOWS_PATH = /\b[A-Za-z]:\\[^\s，。；;!)）]+/g;
const POSIX_PATH = /(^|[\s("'`（])\/(?:[^\s"'`()（）,，。；;!?！？]+\/)*[^\s"'`()（）,，。；;!?！？]+/g;
const ABSOLUTE_PATH = /(?:file:\/\/\/|\b[A-Za-z]:\\|(?:^|[\s("'`（])\/)/i;
const SENTENCE = /(?<=[。！？；;])\s*|(?<=[.!?])\s+|\n+/;
const ACK = /^(?:ok(?:ay)?|thanks?(?:\s+you)?|thx|great|sure|cool|yes|no|好的?|谢谢|收到|明白|了解|可以|行|嗯)[\s.!。！,，]*$/i;
const FUTURE = /(?:以后|之后|稍后|下一步|接下来|明天|将来|未来|计划|打算|准备(?:要|去|做|写|跑|进行|开始)|即将|将要|待会|回头|再(?:做|写|跑|进行|去)|later\b|next\s+(?:step|time|week)|tomorrow|will\b|plan(?:ning)?\s+to|going\s+to|someday)/i;
const NEGATION = /(?:不要|不用|不必|无需|不需要|别(?:再|去|急)?|尚未|还没|没有|并不|并非|不是|避免|暂不|先不|不再|取消|停止|放弃|拒绝|not\b|don['’]t|do not|without|no need|never|skip)/i;
const QUESTION = /(?:是否|要不要|需不需要|该不该|能不能|可不可以|吗\s*[?？]?\s*$)/i;
const REQUEST = /(?:请|帮我|帮忙|麻烦|需要|希望|实现|修复|添加|更新|审查|检查|运行|执行|写|创建|生成|调研|搜索|查找|分析|总结|比较|完成|继续|优化|重构|测试|部署|提交|解释|说明|列出|看看|看一下|处理|整理|跑|做|改|弄|查|读|找|用|把|将|please|implement|add|fix|update|review|check|run|write|create|generate|analy[sz]e|summari[sz]e|compare|refactor|test|deploy|explain|list|investigate|research|find|search|read|open|remove|delete|rename|move|build|install|configure|set\s+up|help\s+me|i\s+need|i\s+want|let'?s|make\s+sure|ensure)/i;

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const iso = value => {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined;
};

export function hasSecretPayload(value) {
  return typeof value === 'string' && SECRET.test(value);
}

/** True when text still looks like it carries an address, phone or absolute path. */
export function hasPrivateData(value) {
  if (typeof value !== 'string') return false;
  EMAIL.lastIndex = 0;
  PHONE.lastIndex = 0;
  if (EMAIL.test(value) || ABSOLUTE_PATH.test(value)) return true;
  return (value.match(PHONE) ?? []).some(match => match.replace(/\D/g, '').length >= 7);
}

function redactPrivateData(text, cwd) {
  let out = String(text);
  out = out.replace(EMAIL, '[email]');
  out = out.replace(PHONE, match => (match.replace(/\D/g, '').length >= 7 ? '[phone]' : match));
  out = out.replace(FILE_URL, '[path]');
  out = out.replace(WINDOWS_PATH, '[path]');
  out = out.replace(POSIX_PATH, (_match, lead) => lead + '[path]');
  out = out.replace(/~\/[^\s，。；;!)）]+/g, '[path]');
  if (cwd && out.includes(cwd)) out = out.split(cwd).join('[path]');
  return out;
}

function stripNonTask(text) {
  return text
    .replace(/```[\s\S]*?```/g, '\n')
    .replace(/~~~[\s\S]*?~~~/g, '\n')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/<(?:tool_result|result|attachment|file|system)[^>]*>[\s\S]*?<\/(?:tool_result|result|attachment|file|system)>/gi, ' ')
    .split('\n')
    .map(line => line.trim())
    .filter(line => {
      if (!line || line.startsWith('>')) return false;
      // Markdown tables and separators are presentation, not task intent.
      if (/^\|/.test(line) || (line.match(/\|/g)?.length ?? 0) >= 2) return false;
      if (/^\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?$/.test(line)) return false;
      if (/^\[(?:attachment|file|image|result)[^\]]*\]$/i.test(line)) return false;
      // Role-prefixed transcript lines are not the current user's instruction.
      if (/^(?:system|assistant|developer|tool)\s*:/i.test(line)) return false;
      return true;
    })
    .map(line => line.replace(/^#{1,6}\s*/, '').replace(/^(?:user|human)\s*:\s*/i, ''))
    .join('\n');
}

function firstActionableSentence(text) {
  for (const raw of text.split(SENTENCE)) {
    const sentence = raw
      .replace(/^(?:[-*•>]+|\d+[.)、])\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!sentence || ACK.test(sentence)) continue;
    if (!/[A-Za-z㐀-鿿]/.test(sentence)) continue;
    if (FUTURE.test(sentence) || QUESTION.test(sentence) || NEGATION.test(sentence)) continue;
    if (!REQUEST.test(sentence)) continue;
    return sentence;
  }
  return undefined;
}

/** Extract one bounded, redacted task intent from the actual current user prompt. */
export function extractTaskSummary(prompt, cwd) {
  if (typeof prompt !== 'string' || !prompt.trim()) return undefined;
  if (hasSecretPayload(prompt.slice(0, 64 * 1024))) return undefined;
  const cleaned = stripNonTask(prompt.slice(0, MAX_PROMPT_SCAN).replace(/\r\n/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' '));
  const sentence = firstActionableSentence(cleaned);
  if (!sentence) return undefined;
  const redacted = redactPrivateData(sentence, cwd).replace(/\s+/g, ' ').trim();
  if (!redacted || hasPrivateData(redacted)) return undefined;
  return redacted.length > MAX_SUMMARY_CHARS ? redacted.slice(0, MAX_SUMMARY_CHARS - 1) + '…' : redacted;
}

function canonicalCwd(cwd) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd) || path.resolve(cwd) !== cwd || cwd.includes('\0')) return undefined;
  try { return fs.realpathSync(cwd) === cwd ? cwd : undefined; } catch { return undefined; }
}

function validContext(context) {
  return object(context)
    && SESSION.test(context.sessionId ?? '')
    && HASH.test(context.charterHash ?? '')
    && Number.isSafeInteger(context.charterRevision)
    && context.charterRevision >= 1;
}

function readJsonSafe(file, maximum) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw Object.assign(Error('unsafe-record'), { code: 'unsafe-path' });
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size > maximum) throw Object.assign(Error('unsafe-record'), { code: 'unsafe-path' });
    const bytes = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < bytes.length) { const read = fs.readSync(fd, bytes, count, bytes.length - count, null); if (!read) break; count += read; }
    const after = fs.fstatSync(fd), named = fs.lstatSync(file);
    const stamp = value => JSON.stringify([value.dev, value.ino, value.size, value.mtimeMs, value.ctimeMs, value.mode, value.nlink]);
    if (count !== opened.size || stamp(before) !== stamp(after) || stamp(after) !== stamp(named) || named.isSymbolicLink() || fs.realpathSync(file) !== file) throw Object.assign(Error('unsafe-record'), { code: 'unsafe-path' });
    return JSON.parse(bytes.subarray(0, count).toString('utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    if (error.code === 'unsafe-path') throw error;
    throw Object.assign(Error('invalid-record'), { code: 'invalid-record' });
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

function writeAtomic(file, text) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  const dirFd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
}

function safeTasks(record, charterHash, revision) {
  if (!object(record) || record.schema !== STAGE_TASK_SUMMARY_SCHEMA) return [];
  if (record.charterHash !== charterHash || record.charterRevision !== revision) return [];
  if (!Array.isArray(record.tasks)) return [];
  return record.tasks.slice(-MAX_TASKS).flatMap(task => {
    if (!object(task) || typeof task.summary !== 'string') return [];
    if (Object.keys(task).some(key => !['summary', 'at'].includes(key))) return [];
    const summary = task.summary.trim();
    if (!summary || summary.length > MAX_SUMMARY_CHARS || hasSecretPayload(summary) || hasPrivateData(summary)) return [];
    const at = iso(task.at);
    return [{ summary, ...(at ? { at } : {}) }];
  });
}

function charterFor(cwd, context) {
  const file = path.join(cwd, '.pi', 'research-loop', 'state.json');
  const state = readJsonSafe(file, 256 * 1024);
  if (!object(state) || !object(state.charter) || typeof state.charter.objective !== 'string' || !Number.isSafeInteger(state.charter.revision) || state.charter.revision < 1) {
    return { reason: 'charter-unavailable' };
  }
  if (sha256(state.charter) !== context.charterHash || state.charter.revision !== context.charterRevision) return { reason: 'charter-changed' };
  return { state };
}

/**
 * Consumer-side guard. A generated summary file is accepted only when its
 * schema, charter binding, task count, per-task length and content all hold.
 * Unknown fields are ignored at the top level, but every task object must be
 * exactly a bounded summary (plus optional timestamp). Returns null otherwise.
 */
export function validateStageTaskSummaryForPacket(value, { charterHash, maxTasks = MAX_TASKS, maxChars = MAX_PACKET_SUMMARY_CHARS } = {}) {
  if (!HASH.test(charterHash ?? '') || !object(value)) return null;
  if (value.schema !== STAGE_TASK_SUMMARY_SCHEMA || value.charterHash !== charterHash) return null;
  if (!Number.isSafeInteger(value.charterRevision) || value.charterRevision < 1) return null;
  if (!Array.isArray(value.tasks) || value.tasks.length === 0 || value.tasks.length > Math.min(maxTasks, MAX_TASKS)) return null;
  const tasks = [];
  for (const task of value.tasks) {
    if (!object(task)) return null;
    if (Object.keys(task).some(key => !['summary', 'at'].includes(key))) return null;
    if (typeof task.summary !== 'string') return null;
    const summary = task.summary.trim();
    if (!summary || summary.length > MAX_SUMMARY_CHARS) return null;
    if (hasSecretPayload(summary) || hasPrivateData(summary)) return null;
    const at = iso(task.at);
    tasks.push({ summary, ...(at ? { at } : {}) });
  }
  const limit = Math.max(1, Math.min(maxChars, MAX_PACKET_SUMMARY_CHARS));
  const text = tasks.map(task => '- ' + task.summary).join('\n').slice(0, limit);
  return text ? { tasks, text } : null;
}

/**
 * Record one current user-task summary. Call this only after
 * `readWorkbenchRecordContext` verified the joined session and current charter.
 * The charter is re-verified under the shared scientific-record lock; a stale
 * context writes nothing. Failures return an observable result and never throw.
 */
export function recordStageTaskSummary(cwd, verifiedContext, prompt, clock = Date.now) {
  let now;
  try { now = typeof clock === 'function' ? clock() : clock; } catch { now = undefined; }
  const at = iso(now) ?? new Date().toISOString();
  const canonical = canonicalCwd(cwd);
  if (!canonical) return { recorded: false, reason: 'invalid-cwd' };
  if (!validContext(verifiedContext)) return { recorded: false, reason: 'invalid-context' };
  if (typeof prompt !== 'string' || !prompt.trim()) return { recorded: false, reason: 'prompt-unavailable' };
  if (hasSecretPayload(prompt.slice(0, 64 * 1024))) return { recorded: false, reason: 'secret-payload' };
  const summary = extractTaskSummary(prompt, canonical);
  if (!summary) return { recorded: false, reason: 'no-task-intent' };
  const relative = STAGE_TASK_SUMMARY_RELATIVE_PATH;
  const file = path.join(canonical, relative);
  try {
    return withScientificRecordLock(canonical, () => {
      const checked = charterFor(canonical, verifiedContext);
      if (checked.reason) return { recorded: false, reason: checked.reason };
      let existing = [];
      try { existing = safeTasks(readJsonSafe(file, MAX_SUMMARY_BYTES), verifiedContext.charterHash, verifiedContext.charterRevision); }
      catch (error) {
        // A symlinked/foreign summary file is never followed or overwritten.
        if (error.code === 'unsafe-path') return { recorded: false, reason: 'unsafe-path' };
        existing = [];
      }
      const added = !existing.some(task => task.summary === summary);
      const tasks = existing.filter(task => task.summary !== summary);
      tasks.push({ summary, at });
      while (tasks.length > MAX_TASKS) tasks.shift();
      const record = { schema: STAGE_TASK_SUMMARY_SCHEMA, charterHash: verifiedContext.charterHash, charterRevision: verifiedContext.charterRevision, tasks, updatedAt: at };
      const text = JSON.stringify(record);
      if (Buffer.byteLength(text) > MAX_SUMMARY_BYTES) return { recorded: false, reason: 'summary-too-large' };
      writeAtomic(file, text);
      return { recorded: true, tasks: tasks.length, added, path: relative };
    });
  } catch (error) {
    const reason = error?.message === 'Research charter is busy' ? 'research-busy'
      : /symlink|noncanonical research directory/i.test(error?.message ?? '') ? 'unsafe-path'
        : error?.code === 'unsafe-path' ? 'unsafe-path'
          : 'write-failed';
    return { recorded: false, reason };
  }
}
