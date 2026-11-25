import readline from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { CliError } from './client.mjs';

const DIALOGS = new Set(['confirm', 'select', 'input', 'editor']);
const sessionEndpoint = id => `/api/sessions/${encodeURIComponent(id)}`;
const plainText = value => typeof value === 'string' ? value : '';

export function renderNativeEvent(event, output) {
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent;
    if (delta?.type === 'text_delta' || delta?.type === 'thinking_delta') output.write(plainText(delta.delta));
    return;
  }
  if (event.type === 'message_end' && event.message?.role === 'assistant') {
    output.write('\n');
    if (event.message.errorMessage) output.write(`错误 ${event.message.errorMessage}\n`);
    return;
  }
  if (event.type === 'tool_execution_start') output.write(`\n[${event.toolName ?? 'tool'}]\n`);
  if (event.type === 'agent_settled') output.write('\n[本轮完成]\n');
  if (event.type === 'extension_ui_request') {
    if (event.method === 'notify') output.write(`\n${plainText(event.message)}\n`);
    if (event.method === 'setStatus' && event.statusText) output.write(`\n${event.statusText}\n`);
    if (event.method === 'setWidget' && Array.isArray(event.widgetLines)) output.write(`\n${event.widgetLines.join('\n')}\n`);
  }
  if (event.type === 'error' || event.type === 'session_error') output.write(`\n错误 ${event.error ?? event.message ?? 'session-error'}\n`);
  if (event.type === 'session_exit' || event.type === 'keeper_exit' || event.type === 'session_host_ended') output.write(`\n[会话进程已退出 ${event.code ?? ''}]\n`);
}

/** Attach never owns the worker lifetime. EOF, Ctrl-C and /detach close this client. */
export async function attachSession({ id, request, stdin, stdout, stderr, json = false, signal, after = 0, once = false, intervalMs = 500 }) {
  const endpoint = sessionEndpoint(id);
  let cursor = after;
  let detached = false;
  let ready = false;
  let input;
  let inputTail = Promise.resolve();
  let initialReplay = true;
  const dialogs = [];
  const seenDialogs = new Set();
  const resolvedDialogs = new Set();
  const editorLines = new Map();
  const sessionsReply = await request('GET', '/api/sessions', undefined, { signal });
  const sessions = Array.isArray(sessionsReply) ? sessionsReply : sessionsReply?.sessions ?? [];
  const current = sessions.find(row => row.id === id || row.sessionId === id);
  if (!current) throw new CliError('会话不存在。', 'session-not-found');
  const initialCursor = Number.isSafeInteger(current.eventCursor) ? current.eventCursor : Number.MAX_SAFE_INTEGER;
  const initiallyPending = new Set((current.pendingUIRequests ?? []).map(row => row.id));
  const printPrompt = () => { if (!json && stdin.isTTY && !detached) stdout.write('> '); };

  function showDialog(dialog) {
    if (json) return;
    stdout.write(`\n${dialog.title ?? '需要确认'}\n`);
    if (dialog.message) stdout.write(`${dialog.message}\n`);
    if (dialog.method === 'confirm') stdout.write('[y/N] ');
    if (dialog.method === 'select') {
      (dialog.options ?? []).forEach((option, index) => stdout.write(`${index + 1}. ${option}\n`));
      stdout.write('输入编号或 /cancel\n> ');
    }
    if (dialog.method === 'input') stdout.write(`${dialog.placeholder ?? ''}\n> `);
    if (dialog.method === 'editor') {
      stdout.write('输入多行内容，以单独一行 . 提交，/cancel 取消。\n');
      if (dialog.prefill) stdout.write(`原内容\n${dialog.prefill}\n`);
      stdout.write('> ');
      editorLines.set(dialog.id, []);
    }
  }

  function queueDialog(dialog, sequence = 0) {
    if (!DIALOGS.has(dialog.method) || seenDialogs.has(dialog.id) || resolvedDialogs.has(dialog.id)) return;
    if (initialReplay && sequence <= initialCursor && !initiallyPending.has(dialog.id)) return;
    seenDialogs.add(dialog.id);
    dialogs.push(dialog);
    if (dialogs.length === 1) showDialog(dialog);
  }

  async function answerDialog(line) {
    const dialog = dialogs[0];
    const response = { type: 'extension_ui_response', id: dialog.id };
    if (line === '/cancel') response.cancelled = true;
    else if (dialog.method === 'confirm') response.confirmed = /^(y|yes|是|确认)$/i.test(line.trim());
    else if (dialog.method === 'select') {
      const number = Number(line);
      const selected = (dialog.options ?? [])[number - 1];
      if (!Number.isInteger(number) || selected === undefined) {
        stderr.write('请输入有效编号，或输入 /cancel。\n');
        return;
      }
      response.value = selected;
    } else if (dialog.method === 'editor') {
      if (line !== '.') {
        editorLines.get(dialog.id).push(line);
        return;
      }
      response.value = editorLines.get(dialog.id).join('\n');
    } else response.value = line;
    await request('POST', endpoint + '/ui', response, { signal });
    resolvedDialogs.add(dialog.id);
    editorLines.delete(dialog.id);
    dialogs.shift();
    if (dialogs.length) showDialog(dialogs[0]);
    else printPrompt();
  }

  async function handleLine(line) {
    if (!ready) return;
    if (line === '/detach') { detached = true; return; }
    if (json) {
      const command = JSON.parse(line);
      const action = command.type === 'extension_ui_response' ? '/ui' : '/command';
      stdout.write(JSON.stringify(await request('POST', endpoint + action, command, { signal })) + '\n');
      return;
    }
    if (dialogs.length) { await answerDialog(line); return; }
    if (line === '/abort') await request('POST', endpoint + '/abort', {}, { signal });
    else if (line === '/stop') {
      stdout.write('停止当前会话进程，请输入 /confirm-stop。\n');
      dialogs.push({ id: 'local-stop-confirmation', method: 'local-stop' });
      return;
    } else if (line.trim()) {
      await request('POST', endpoint + '/command', { type: 'prompt', message: line, streamingBehavior: 'steer' }, { signal });
    }
    printPrompt();
  }

  function startInput() {
    if (once || input) return;
    input = readline.createInterface({ input: stdin, crlfDelay: Infinity, terminal: false });
    input.on('line', line => {
      inputTail = inputTail.then(async () => {
        if (dialogs[0]?.method === 'local-stop') {
          dialogs.shift();
          if (line === '/confirm-stop') { await request('POST', endpoint + '/stop', {}, { signal }); detached = true; }
          else printPrompt();
        } else await handleLine(line);
      }).catch(error => stderr.write(`${error.message}\n`));
    });
    input.on('close', () => { detached = true; });
  }
  const onInterrupt = () => { detached = true; };
  process.on('SIGINT', onInterrupt);
  process.on('SIGTERM', onInterrupt);
  try {
    if (!json) stdout.write(`会话 ${id}\n/detach 断开连接，/abort 中断本轮，/stop 停止会话。\n`);
    while (!detached && !signal?.aborted) {
      const result = await request('GET', `${endpoint}/events?after=${cursor}&limit=200`, undefined, { signal });
      if (!Array.isArray(result?.events) || !Number.isSafeInteger(result.nextCursor) || result.nextCursor < cursor) {
        throw new CliError('宿主会话事件响应无效。', 'session-events-invalid');
      }
      for (const record of result.events) {
        if (!Number.isSafeInteger(record.sequence) || record.sequence <= cursor || !record.event?.type) continue;
        cursor = record.sequence;
        const event = record.event;
        if (json) stdout.write(JSON.stringify(record) + '\n');
        else renderNativeEvent(event, stdout);
        if (event.type === 'extension_ui_resolved') {
          resolvedDialogs.add(event.id);
          const index = dialogs.findIndex(row => row.id === event.id);
          if (index >= 0) {
            const wasCurrent = index === 0;
            dialogs.splice(index, 1);
            if (wasCurrent && dialogs.length) showDialog(dialogs[0]);
          }
        } else if (event.type === 'extension_ui_request') queueDialog(event, record.sequence);
      }
      cursor = Math.max(cursor, result.nextCursor);
      if (result.events.length >= 200) continue;
      if (initialReplay) {
        for (const dialog of current.pendingUIRequests ?? []) queueDialog(dialog);
        initialReplay = false;
        ready = true;
        startInput();
        if (!dialogs.length) printPrompt();
      }
      if (once) break;
      await delay(intervalMs, undefined, { signal }).catch(error => { if (!signal?.aborted) throw error; });
    }
    await inputTail;
    return { sessionId: id, nextCursor: cursor, detached: !once };
  } finally {
    input?.close();
    process.off('SIGINT', onInterrupt);
    process.off('SIGTERM', onInterrupt);
  }
}
