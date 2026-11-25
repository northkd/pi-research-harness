import fs from 'node:fs';
const argv = process.argv.slice(2);
const sessionFile = argv[argv.indexOf('--session') + 1];
const sessionId = JSON.parse(fs.readFileSync(sessionFile, 'utf8').split('\n', 1)[0]).id;
let input = '', streaming = false, compacting = false, pendingMessageCount = 0, stateDelayMs = 0;
const messages = [];
const emit = event => process.stdout.write(JSON.stringify(event) + '\n');
process.stdin.on('data', chunk => {
  input += chunk.toString();
  let newline;
  while ((newline = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newline); input = input.slice(newline + 1);
    const command = JSON.parse(line);
    const response = data => emit({ id: command.id, type: 'response', command: command.type, success: true, data });
    if (command.type === 'get_state') {
      const state = { sessionId, sessionFile, isStreaming: streaming, isCompacting: compacting, pendingMessageCount };
      if (stateDelayMs) setTimeout(() => response(state), stateDelayMs);
      else response(state);
    }
    else if (command.type === 'fake_control') {
      if (command.streaming !== undefined) streaming = command.streaming;
      if (command.compacting !== undefined) compacting = command.compacting;
      if (command.pendingMessageCount !== undefined) pendingMessageCount = command.pendingMessageCount;
      if (command.stateDelayMs !== undefined) stateDelayMs = command.stateDelayMs;
      response({});
    }
    else if (command.type === 'fake_event') { emit(command.event); response({}); }
    else if (command.type === 'get_messages') response({ messages });
    else if (command.type === 'prompt') {
      messages.push({ role: 'user', content: command.message, streamingBehavior: command.streamingBehavior, images: command.images });
      fs.appendFileSync(sessionFile, JSON.stringify({ type: 'message', message: messages.at(-1) }) + '\n');
      streaming = true; emit({ type: 'agent_start' });
      response({ disposition: 'started' });
      if (command.message === 'ask-ui') emit({ type: 'extension_ui_request', method: 'confirm', id: 'fake-dialog', title: 'Synthetic confirmation' });
      else if (command.message !== 'hold-stream') setTimeout(() => { streaming = false; emit({ type: 'agent_settled', reason: 'complete' }); }, 20);
    } else if (command.type === 'extension_ui_response') {
      streaming = false; emit({ type: 'agent_settled', reason: command.confirmed ? 'complete' : 'aborted' });
    } else if (command.type === 'abort') { streaming = false; response({}); emit({ type: 'agent_settled', reason: 'aborted' }); }
    else response({});
  }
});
