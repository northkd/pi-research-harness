#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { attachSession } from './attach.mjs';
import { CliError, createHostClient, loadHostAuth } from './client.mjs';

const BOOLEAN_OPTIONS = new Set(['json', 'yes', 'once', 'all', 'help', 'agent', 'attach']);
const VALUE_OPTIONS = new Set(['cwd', 'body', 'interval', 'session', 'session-id', 'session-file', 'model', 'name', 'message', 'request-id', 'plan', 'task', 'history', 'after', 'multi', 'subagents', 'month', 'reason', 'source', 'q', 'limit', 'doc-type', 'ref', 'hash']);
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const OBJECT = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const ROOT = '/api/res-workflow';

export const HELP = `用法 pi-research host <命令> [选项]

status                          查看当前目录的科研状态
watch                           持续查看科研状态
sessions list|start              查看或创建常驻会话
sessions attach|send|rpc <ID>    连接会话、发送消息或 native RPC
sessions abort|stop <ID>         中断本轮或停止会话
sessions resume|fork <ID>        恢复原会话或新建对话分支
sessions archive|unarchive <ID>  归档或恢复会话显示
participants list|join|detach|main [ID]
target show|bind                 查看或确认目标绑定
limits --multi N --subagents N   更新协作并发
queue show|plan|pause|resume|cancel|reorder|start --session ID
history                         查看可选历史，默认全不选
models                          查看接入分析模型
adoption create|agent-create|show|prepare|analyze|authorize|confirm|cancel|reconnect [ID]
adoption agent-resume|agent-budget|source [ID]
billing|speed                    查看原计费和用量统计
goals list|create|update|delete|link|unlink|spawn [ID]
goals set|subgoal|pause|resume|done|clear --session ID
kb stats|config|sources|search|index|trust|untrust
api METHOD /api/path             调用本机宿主接口

通用选项
  --cwd DIR       课题目录，默认当前目录
  --body FILE     从 JSON 文件读取操作参数，- 从标准输入读取
  --json          输出可供程序读取的 JSON
  --yes           确认已展示的操作参数，用于明确授权的脚本
  --request-id ID  保存并复用有结果待核对的请求 ID
  --once          watch 或 attach 读取当前结果后退出
  --help          显示帮助

示例
  pi-research host sessions start --name 研究 --model provider/model
  pi-research host sessions attach SESSION_ID
  pi-research host participants join SESSION_ID
  pi-research host queue show --session SESSION_ID
  pi-research host adoption create --history HISTORY_ID
  pi-research host adoption analyze ADOPTION_ID --body approved-analysis.json
`;

export function parseArguments(argv) {
  const words = [];
  const options = {};
  let literal = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { literal = true; continue; }
    if (literal || !arg.startsWith('--')) { words.push(arg); continue; }
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals === -1 ? undefined : equals);
    if (BOOLEAN_OPTIONS.has(key)) {
      if (equals !== -1) throw new CliError(`选项 --${key} 不接收值。`, 'cli-option-invalid');
      options[key] = true;
      continue;
    }
    if (!VALUE_OPTIONS.has(key)) throw new CliError(`未知选项 --${key}。`, 'cli-option-unknown');
    const value = equals === -1 ? argv[++index] : arg.slice(equals + 1);
    if (value === undefined || value === '' || (equals === -1 && value.startsWith('--'))) throw new CliError(`选项 --${key} 需要值。`, 'cli-option-value-required');
    if (key === 'history') (options.history ??= []).push(value);
    else if (Object.hasOwn(options, key)) throw new CliError(`选项 --${key} 重复。`, 'cli-option-duplicate');
    else options[key] = value;
  }
  return { words, options };
}

function identifier(value, label = 'ID') {
  if (!ID.test(value ?? '')) throw new CliError(`需要有效的 ${label}。`, 'cli-id-required');
  return value;
}

function integer(value, defaultValue, minimum, maximum, label) {
  const number = value === undefined ? defaultValue : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) throw new CliError(`${label} 必须为 ${minimum} 到 ${maximum} 之间的整数。`, 'cli-number-invalid');
  return number;
}

export function modelReference(value) {
  const separator = value?.indexOf('/') ?? -1;
  if (separator <= 0 || separator === value.length - 1) throw new CliError('模型请写为 provider/model。', 'cli-model-invalid');
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) };
}

async function readInput(input, maximum) {
  let bytes = 0;
  const pieces = [];
  for await (const piece of input) {
    const buffer = Buffer.isBuffer(piece) ? piece : Buffer.from(piece);
    bytes += buffer.length;
    if (bytes > maximum) throw new CliError('JSON 参数超过 1 MiB。', 'cli-body-oversized');
    pieces.push(buffer);
  }
  return Buffer.concat(pieces).toString('utf8');
}

async function readBody(file, input) {
  if (!file) return {};
  let text;
  if (file === '-') text = await readInput(input, 1024 * 1024);
  else {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new CliError('JSON 参数文件无效或超过 1 MiB。', 'cli-body-invalid');
    text = fs.readFileSync(file, 'utf8');
  }
  let body;
  try { body = JSON.parse(text); }
  catch { throw new CliError('参数文件必须为 JSON 对象。', 'cli-body-invalid'); }
  if (!OBJECT(body)) throw new CliError('参数文件必须为 JSON 对象。', 'cli-body-invalid');
  return body;
}

function scopedBody(body, cwd) {
  if (body.cwd !== undefined && body.cwd !== cwd) throw new CliError('JSON 文件中的 cwd 与 --cwd 不一致。', 'cli-cwd-conflict');
  return { ...body, cwd };
}

function writeResult(value, output, json, kind = '') {
  if (json) { output.write(JSON.stringify(value) + '\n'); return; }
  const rows = Array.isArray(value) ? value : kind === 'sessions' ? value?.sessions : kind === 'history' ? value?.candidates : undefined;
  if (Array.isArray(rows)) {
    if (!rows.length) { output.write('暂无记录。\n'); return; }
    for (const row of rows) {
      const model = typeof row.model === 'string' ? row.model : row.model?.id;
      output.write([row.id ?? row.sessionId, row.status ?? row.state ?? row.kind, row.name ?? row.title, model, row.cwd].filter(Boolean).join('  ') + '\n');
    }
    if (value?.partial) output.write('本次清单包含未完整读取的来源。\n');
    return;
  }
  if (kind === 'status' && value?.research) {
    output.write(`目录 ${value.cwd}\n接入 ${value.adopted ? '已确认' : '尚未确认'}\n`);
    let state;
    try { state = JSON.parse(value.research['state.json']); } catch { /* Display the other available fields. */ }
    if (state?.charter) {
      output.write(`目标 ${state.charter.objective}\n`);
      for (const item of state.charter.successCriteria ?? []) output.write(`  - ${item}\n`);
      output.write(`阶段 ${state.stage ?? state.phase ?? '未登记'}\n`);
    }
    if (value.adoption) output.write(`接入记录 ${value.adoption.id}  ${value.adoption.status}\n`);
    if (value.observation) output.write(JSON.stringify(value.observation, null, 2) + '\n');
    return;
  }
  output.write(JSON.stringify(value, null, 2) + '\n');
}

async function terminalConfirmation(message, { stdin, stdout, confirm }) {
  if (confirm) return confirm(message);
  if (!stdin.isTTY) throw new CliError('该操作需要终端确认，或在已核对参数后显式使用 --yes。', 'cli-confirmation-required');
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try { return /^(y|yes|是|确认)$/i.test((await terminal.question(`${message}\n[y/N] `)).trim()); }
  finally { terminal.close(); }
}

export async function runCli(argv, dependencies = {}) {
  const { words, options } = parseArguments(argv);
  const stdin = dependencies.stdin ?? process.stdin;
  const stdout = dependencies.stdout ?? process.stdout;
  const stderr = dependencies.stderr ?? process.stderr;
  if (options.help || !words.length || words[0] === 'help') { stdout.write(HELP); return 0; }
  const cwd = fs.realpathSync(path.resolve(options.cwd ?? dependencies.cwd ?? process.cwd()));
  const body = await readBody(options.body, stdin);
  const json = options.json === true;
  const request = dependencies.request ?? createHostClient({
    auth: dependencies.auth ?? loadHostAuth({ env: dependencies.env ?? process.env, home: dependencies.home }),
    fetchImpl: dependencies.fetchImpl,
  });
  const requestId = () => identifier(options['request-id'] ?? body.requestId ?? randomUUID(), '请求 ID');
  const scopedQuery = suffix => `${ROOT}${suffix}?cwd=${encodeURIComponent(cwd)}`;
  const result = (value, kind) => writeResult(value, stdout, json, kind);
  const approve = async (message, preview) => {
    if (preview !== undefined && !json) stdout.write(JSON.stringify(preview, null, 2) + '\n');
    if (options.yes) return;
    if (!await terminalConfirmation(message, { stdin, stdout, confirm: dependencies.confirm })) throw new CliError('操作已取消。', 'cli-cancelled');
  };
  const post = (route, value) => request('POST', route, value, { signal: dependencies.signal });
  const get = route => request('GET', route, undefined, { signal: dependencies.signal });
  const collaboration = () => get(scopedQuery('/collaboration'));
  const mutateCollaboration = async value => {
    const current = await collaboration();
    return post(ROOT + '/collaboration', { ...value, cwd, expectedRevision: current.revision });
  };
  const command = words[0];

  if (command === 'status' || command === 'watch') {
    let previous;
    do {
      const snapshot = await get(scopedQuery(''));
      const signature = JSON.stringify(snapshot);
      if (signature !== previous) { result(snapshot, 'status'); previous = signature; }
      if (command !== 'watch' || options.once || dependencies.signal?.aborted) break;
      await delay(integer(options.interval, 2000, 250, 60_000, '刷新间隔'), undefined, { signal: dependencies.signal });
    } while (!dependencies.signal?.aborted);
    return 0;
  }
  if (command === 'history' || command === 'models') {
    result(await get(scopedQuery(command === 'history' ? '/history-candidates' : '/models')), command);
    return 0;
  }
  if (command === 'sessions' || command === 'session') {
    const action = words[1] ?? 'list';
    const id = () => identifier(words[2] ?? options.session, '会话 ID');
    if (action === 'list') {
      const reply = await get('/api/sessions');
      const rows = Array.isArray(reply) ? reply : reply?.sessions ?? [];
      result(options.all ? rows : rows.filter(row => row.cwd === cwd), 'sessions');
    } else if (action === 'start') {
      const input = scopedBody(body, cwd);
      for (const [flag, field] of [['session-id', 'sessionId'], ['session-file', 'sessionFile'], ['model', 'model'], ['name', 'name'], ['message', 'prompt']]) {
        if (options[flag] !== undefined) input[field] = options[flag];
      }
      if (input.prompt) await approve('创建会话并提交以上任务？', input);
      const started = await post('/api/sessions', input);
      result(started);
      if (options.attach) {
        const sessionId = identifier(started.sessionId ?? started.id, '宿主返回的会话 ID');
        await attachSession({ id: sessionId, request, stdin, stdout, stderr, json, signal: dependencies.signal });
      }
    } else if (action === 'attach') {
      await attachSession({ id: id(), request, stdin, stdout, stderr, json, signal: dependencies.signal,
        after: integer(options.after, 0, 0, Number.MAX_SAFE_INTEGER, '事件游标'), once: options.once,
        intervalMs: integer(options.interval, 500, 100, 60_000, '刷新间隔') });
    } else if (action === 'send' || action === 'rpc') {
      const input = action === 'rpc' ? body : { type: 'prompt', message: options.message ?? words.slice(3).join(' '), streamingBehavior: 'steer' };
      if (action === 'rpc' && typeof input.type !== 'string' || action === 'send' && !input.message) throw new CliError('需要消息文本或含 type 的 native RPC JSON。', 'cli-session-message-required');
      result(await post(`/api/sessions/${id()}/command`, input));
    } else if (action === 'stop' || action === 'abort') {
      if (action === 'stop') await approve(`停止会话 ${id()} 的进程？`);
      result(await post(`/api/sessions/${id()}/${action}`, {}));
    } else if (action === 'resume' || action === 'fork') {
      result(await post(`/api/session/${id()}/resume`, { mode: action === 'fork' ? 'fork' : 'continue' }));
    } else if (action === 'archive' || action === 'unarchive') {
      if (action === 'archive') await approve(`归档会话 ${id()}，并结束它的空闲进程？`);
      result(await post(`/api/session/${id()}/${action}`, {}));
    } else throw new CliError('未知会话操作。', 'cli-command-unknown');
    return 0;
  }
  if (command === 'participants') {
    const action = words[1] ?? 'list';
    if (action === 'list') result(await collaboration());
    else {
      const sessionId = identifier(words[2] ?? options.session, '会话 ID');
      if (action === 'join') result(await post(ROOT + '/participants', { cwd, sessionId }));
      else if (action === 'detach' || action === 'main') {
        await approve(action === 'detach' ? `移出会话 ${sessionId} 及其关联分支？` : `将会话 ${sessionId} 设为当前研究主会话？`);
        result(await mutateCollaboration({ action: action === 'main' ? 'select-main' : 'detach', sessionId }));
      } else throw new CliError('未知会话归属操作。', 'cli-command-unknown');
    }
    return 0;
  }
  if (command === 'limits') {
    const current = await collaboration();
    if (!options.multi && !options.subagents) { result(current.limits); return 0; }
    const input = { cwd, action: 'limits', expectedRevision: current.revision,
      maxMultiAgents: integer(options.multi, current.limits.maxMultiAgents, 1, current.limitMaximums?.maxMultiAgents ?? 64, '协作者并发'),
      maxSubagents: integer(options.subagents, current.limits.maxSubagents, 1, current.limitMaximums?.maxSubagents ?? 32, '子 Agent 并发') };
    await approve('更新以上并发限制？', input);
    result(await post(ROOT + '/collaboration', input));
    return 0;
  }
  if (command === 'target') {
    const current = await get(scopedQuery('/charter-binding'));
    if ((words[1] ?? 'show') === 'show') result(current);
    else if (words[1] === 'bind') {
      if (!current.canRebind) { result(current); return 0; }
      const input = { cwd, adoptionId: current.adoptionId, expectedBindingRevision: current.bindingRevision,
        expectedBoundCharterHash: current.boundCharterHash, expectedCharterHash: current.currentCharterHash, requestId: requestId() };
      await approve('确认当前目标版本，并让此课题的后续安排使用该版本？', current.currentCharter);
      result(await post(ROOT + '/charter-binding', input));
    } else throw new CliError('未知目标操作。', 'cli-command-unknown');
    return 0;
  }
  if (command === 'queue') {
    const action = words[1] ?? 'show';
    if (action === 'show' && !options.session && !body.sessionId) { result(await collaboration()); return 0; }
    const sessionId = identifier(options.session ?? body.sessionId, '主会话 ID');
    if (action === 'reorder' || action === 'start') {
      const snapshot = await collaboration();
      const planId = identifier(options.plan ?? body.planId, '计划 ID');
      const plan = (snapshot.plans ?? []).find(row => row.id === planId || row.clientPlanId === planId);
      if (!plan) throw new CliError('找不到计划。', 'cli-plan-not-found');
      const input = { cwd, action, expectedRevision: snapshot.revision, sessionId, planId, queueRevision: plan.revision,
        ...(action === 'reorder' ? { taskIds: body.taskIds } : { taskId: identifier(options.task ?? body.taskId, '任务 ID') }) };
      result(await post(ROOT + '/collaboration', input));
    } else if (['show', 'plan', 'pause', 'resume', 'cancel'].includes(action)) {
      const input = { ...body, sessionId, action: action === 'show' ? 'status' : action };
      if (options.plan) input.planId = identifier(options.plan, '计划 ID');
      if (options.reason) input.reason = options.reason;
      if (action === 'plan') {
        input.planId ??= requestId();
        await approve('确认以上冻结目标的研究分工，并授权在原有权限和资源范围内执行？', input);
      }
      result(await post(ROOT + '/dispatch', input));
    } else throw new CliError('未知队列操作。', 'cli-command-unknown');
    return 0;
  }
  if (command === 'adoption') {
    const action = words[1];
    const input = scopedBody(body, cwd);
    const adoptionId = () => identifier(words[2], '接入记录 ID');
    if (action === 'create' || action === 'agent-create') {
      input.requestId = requestId();
      input.historySelection = options.history ?? input.historySelection ?? [];
      if (options.model) input.model = modelReference(options.model);
      if (input.consent) await approve('确认以上材料范围和模型。所选内容将发送给模型服务商。', input);
      result(await post(ROOT + '/adoptions' + (action === 'agent-create' ? '/agent' : ''), input));
    } else if (action === 'show') result(await get(scopedQuery(`/adoptions/${adoptionId()}`)));
    else if (action === 'reconnect') {
      await approve('重新接入此目录，并归档现有接入关联？');
      result(await post(ROOT + '/reconnect', { cwd }));
    } else if (action === 'source') {
      const source = identifier(options.source ?? words[3], '来源 ID');
      result(await get(scopedQuery(`/adoptions/${adoptionId()}/sources/${source}`)));
    } else {
      const suffix = { prepare: '/history-review/prepare', analyze: '/analyze', 'history-analyze': '/history-review/analyze', authorize: '/agent/authorize', 'agent-resume': '/agent/resume', 'agent-budget': '/agent/budget', confirm: '/confirm', cancel: '/cancel' }[action];
      if (!suffix) throw new CliError('未知接入操作。', 'cli-command-unknown');
      if (!['confirm', 'cancel'].includes(action)) input.requestId = requestId();
      if (options.model) input.model = modelReference(options.model);
      if (['analyze', 'history-analyze', 'authorize', 'agent-resume', 'agent-budget'].includes(action)) {
        const record = await get(scopedQuery(`/adoptions/${adoptionId()}`));
        await approve('确认以上材料范围、模型和请求授权。执行后，所选内容将发送给模型服务商。', { request: input, adoption: record.adoption ?? record });
      }
      if (action === 'confirm') await approve('将以上目标和验收标准登记为此课题的确认接入结果？', input);
      if (action === 'cancel') await approve(`取消接入任务 ${adoptionId()}？`);
      result(await post(`${ROOT}/adoptions/${adoptionId()}${suffix}`, input));
    }
    return 0;
  }
  if (command === 'billing' || command === 'speed') {
    const query = new URLSearchParams();
    if (options.month) {
      if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(options.month)) throw new CliError('月份请写为 YYYY-MM。', 'cli-month-invalid');
      query.set('month', options.month);
    }
    if (options.session && command === 'speed') query.set('sessionId', identifier(options.session, '会话 ID'));
    result(await get(`/api/speed-monitor/${command === 'billing' ? 'billing' : 'stats'}${query.size ? '?' + query : ''}`));
    return 0;
  }
  if (command === 'goals') {
    const action = words[1] ?? 'list';
    const goal = () => identifier(words[2], '目标 ID');
    const base = '/api/folders/goals';
    const query = `?cwd=${encodeURIComponent(cwd)}`;
    if (['set', 'subgoal', 'pause', 'resume', 'done', 'clear'].includes(action)) {
      const sessionId = identifier(options.session ?? body.sessionId, '会话 ID');
      const input = { sessionId, action };
      if (action === 'set' || action === 'subgoal') {
        const goalText = options.message ?? body.payload?.goal;
        if (typeof goalText !== 'string' || !goalText.trim()) throw new CliError('需要 --message 或 JSON 中的 payload.goal。', 'cli-goal-required');
        input.payload = { goal: goalText };
      }
      await approve(`对会话 ${sessionId} 执行目标操作 ${action}？`, input);
      result(await post('/api/plugins/goal/control', input));
    } else if (action === 'list') result(await get(base + query));
    else if (action === 'create') result(await post(base + query, body));
    else if (action === 'update') result(await request('PATCH', `${base}/${goal()}${query}`, body));
    else if (action === 'delete') {
      await approve(`删除目标 ${goal()}？`);
      result(await request('DELETE', `${base}/${goal()}${query}`));
    } else if (action === 'link' || action === 'spawn') {
      const input = action === 'spawn' ? { spawn: true, ...(options.model ? { model: options.model } : {}) } : { sessionId: identifier(options.session ?? body.sessionId, '会话 ID') };
      if (action === 'spawn') await approve(`为目标 ${goal()} 启动执行会话？`, input);
      result(await post(`${base}/${goal()}/sessions${query}`, input));
    } else if (action === 'unlink') result(await request('DELETE', `${base}/${goal()}/sessions/${identifier(options.session ?? body.sessionId, '会话 ID')}${query}`));
    else throw new CliError('未知目标管理操作。', 'cli-command-unknown');
    return 0;
  }
  if (command === 'kb') {
    const action = words[1] ?? 'stats';
    const query = new URLSearchParams({ cwd });
    if (['stats', 'config', 'sources', 'search'].includes(action) && !(action === 'config' && words[2] === 'set')) {
      if (action === 'search') {
        const text = options.q ?? words.slice(2).join(' ');
        if (!text) throw new CliError('需要搜索词。', 'cli-search-required');
        query.set('q', text);
        if (options.limit) query.set('limit', String(integer(options.limit, 20, 1, 200, '结果数量')));
        if (options['doc-type']) query.set('docType', options['doc-type']);
      }
      result(await get(`/api/kb/${action}?${query}`));
    } else if (action === 'index' || action === 'reindex') result(await post(`/api/kb/reindex?${query}`, {}));
    else if (action === 'config' && words[2] === 'set') {
      await approve('更新以上知识库配置？', body);
      result(await request('PUT', `/api/kb/config?${query}`, body));
    } else if (action === 'trust') {
      const input = { ref: options.ref ?? body.ref };
      if (typeof input.ref !== 'string' || !input.ref) throw new CliError('需要 --ref 或 JSON 中的 ref。', 'cli-kb-reference-required');
      await approve('信任以上知识库来源？', input);
      result(await post(`/api/kb/source-trust?${query}`, input));
    } else if (action === 'untrust') {
      const input = { hash: options.hash ?? body.hash };
      if (typeof input.hash !== 'string' || !input.hash) throw new CliError('需要 --hash 或 JSON 中的 hash。', 'cli-kb-hash-required');
      result(await request('DELETE', `/api/kb/source-trust?${query}`, input));
    } else throw new CliError('未知知识库操作。', 'cli-command-unknown');
    return 0;
  }
  if (command === 'api') {
    const method = words[1]?.toUpperCase();
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(method) || !words[2]) throw new CliError('需要 METHOD 和 /api/path。', 'cli-api-invalid');
    if (method !== 'GET') await approve(`执行 ${method} ${words[2]}？`, body);
    result(await request(method, words[2], method === 'GET' ? undefined : body));
    return 0;
  }
  if (dependencies.extraCommand) {
    const handled = await dependencies.extraCommand({ words, options, body, cwd, request, result, approve });
    if (handled) return 0;
  }
  throw new CliError(`未知命令 ${command}。运行 pi-research host --help 查看用法。`, 'cli-command-unknown');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const signal = new AbortController();
  const abort = () => signal.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  runCli(process.argv.slice(2), { signal: signal.signal }).then(code => { process.exitCode = code; }).catch(error => {
    if (signal.signal.aborted) { process.exitCode = 130; return; }
    if (process.argv.includes('--json')) process.stderr.write(JSON.stringify({ success: false, error: error.message, code: error.code ?? 'cli-error' }) + '\n');
    else process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }).finally(() => {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
  });
}
