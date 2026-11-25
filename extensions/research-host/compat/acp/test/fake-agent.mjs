// Deterministic local ACP protocol peer. It never accesses a model or network.
import fs from 'node:fs';
import readline from 'node:readline';
const version = Number(process.argv[2] ?? 1);
const log = value => { if (process.env.ACP_FAKE_LOG) fs.appendFileSync(process.env.ACP_FAKE_LOG, JSON.stringify(value) + '\n'); };
const write = value => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
const reply = (id, result) => write({ id, result });
const update = content => write({ method: 'session/update', params: { sessionId: 'opaque-agent-session', update: content } });
let turn = 0, holding, permission, permissionId = 1000;
const model = value => ({ configId: 'model', category: 'model', name: 'Model', type: 'select', currentValue: value,
  options: [{ value: 'fake-model', name: 'Fake Model' }, { value: 'other-model', name: 'Other Model' }] });

function complete(message, text, stopReason = 'end_turn') {
  const number = ++turn;
  if (version === 2) update({ sessionUpdate: 'state_update', state: 'running' });
  update({ sessionUpdate: 'user_message_chunk', messageId: `user-${number}`, content: { type: 'text', text: message.params.prompt[0].text } });
  update({ sessionUpdate: 'tool_call', toolCallId: `tool-${number}`, name: 'write_result', title: 'Write result', status: 'in_progress', rawInput: { file: 'result.txt' } });
  update({ sessionUpdate: 'tool_call_update', toolCallId: `tool-${number}`, name: 'write_result', status: 'completed',
    content: [{ type: 'content', content: { type: 'text', text: 'artifact: result.txt' } }], rawOutput: { artifact: 'result.txt' } });
  update({ sessionUpdate: 'agent_message_chunk', messageId: `assistant-${number}`, content: { type: 'text', text } });
  reply(message.id, version === 2 ? { messageId: `user-${number}` } : { stopReason });
  if (version === 2) setTimeout(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason }), 5);
}

for await (const line of readline.createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const message = JSON.parse(line); log(message);
  if (message.method === 'initialize') {
    if (process.env.ACP_FAKE_START === 'hang') continue;
    reply(message.id, { protocolVersion: process.env.ACP_FAKE_START === 'invalid' ? 99 : version, agentCapabilities: {} });
  } else if (message.method === 'session/new') {
    reply(message.id, { sessionId: 'opaque-agent-session', configOptions: [model('fake-model')] });
    update({ sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'inspect', description: 'Inspect local fixture' }] });
    update({ sessionUpdate: 'session_info_update', title: 'Synthetic ACP session' });
  } else if (message.method === 'session/set_config_option') reply(message.id, { configOptions: [model(message.params.value)] });
  else if (message.method === 'session/prompt') {
    const text = message.params.prompt[0].text;
    if (text === 'hold') { holding = message; continue; }
    if (text === 'crash') process.exit(7);
    if (text === 'permission') {
      permission = message;
      write({ id: ++permissionId, method: 'session/request_permission', params: { sessionId: 'opaque-agent-session', toolCall: { title: 'Allow local fixture?' },
        options: [{ optionId: 'allow', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }] } });
      continue;
    }
    complete(message, 'reply:' + text);
  } else if (message.method === 'session/cancel') {
    if (holding) { const current = holding; holding = undefined; complete(current, 'cancelled', 'cancelled'); }
  } else if (message.id === permissionId && permission && message.result) {
    const current = permission; permission = undefined;
    complete(current, 'permission:' + JSON.stringify(message.result.outcome));
  }
}
