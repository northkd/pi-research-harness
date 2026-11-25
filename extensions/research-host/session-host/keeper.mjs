import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { atomicJson, readJson, maybeJson, processIdentity, privateDir, sameProcess, nativeHistoryHasPrompt, fail } from './files.mjs';
import { createSessionJournal } from './journal.mjs';
import { extractNativeSessionUpdates, updateActiveToolCalls, observedToolName } from './event-status.mjs';

const MAX_RECORD = 64 * 1024 * 1024;
const dialogMethods = new Set(['confirm', 'select', 'input', 'editor']);

export async function runKeeper(configFile) {
  const config = readJson(configFile, 2 * 1024 * 1024);
  privateDir(config.directory);
  const lock = path.join(config.directory, 'keeper.lock');
  try { fs.mkdirSync(lock, { mode: 0o700 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const previous = maybeJson(path.join(lock, 'owner.json'));
    if (previous && sameProcess(previous)) fail('session-keeper-already-running');
    // A missing owner file can belong to a keeper between mkdir and write.
    if (!previous) fail('session-keeper-lock-unknown');
    fs.rmSync(path.join(lock, 'owner.json'));
    fs.rmdirSync(lock);
    fs.mkdirSync(lock, { mode: 0o700 });
  }
  const identity = processIdentity(process.pid);
  atomicJson(path.join(lock, 'owner.json'), identity);
  const statusFile = path.join(config.directory, 'status.json');
  const receiptsFile = path.join(config.directory, 'receipts.json');
  const previous = maybeJson(statusFile);
  if (previous?.worker && sameProcess(previous.worker)) fail('session-keeper-worker-outcome-unknown');
  const receipts = maybeJson(receiptsFile, 4 * 1024 * 1024)?.receipts ?? {};
  const requests = new Map(), dialogs = new Map(), activeToolCalls = new Map();
  let adoptionTail = Promise.resolve(), retirementCommitted = false, retirementResponseSent = false;
  let journalDirty = false;
  const journal = createSessionJournal(config.directory);
  let sequence = journal.sequence, input = '', closed = false, ready = false;
  const status = { schema: 'pi-research-session-keeper.v1', sessionId: config.sessionId, cwd: config.cwd, sessionFile: config.sessionFile,
    launchId: config.launchId,
    keeper: identity, worker: undefined, phase: 'starting', status: 'starting', pendingUIRequests: [], lastSequence: sequence,
    initialPromptStatus: config.initialPrompt ? 'pending' : 'absent', startedAt: new Date().toISOString() };
  const persist = () => atomicJson(statusFile, { ...status, pendingUIRequests: [...dialogs.values()], activeToolCalls: [...activeToolCalls.values()],
    lastSequence: sequence, updatedAt: new Date().toISOString() });
  const record = event => {
    const durable = !['message_update', 'tool_execution_update', 'bash_execution_update'].includes(event.type);
    sequence = journal.append(event, durable).sequence;
    journalDirty = true;
    if (durable) {
      // Accepted prompts, dialogs and lifecycle state are durable before handoff.
      journalDirty = false; persist();
    }
  };
  const journalFlush = setInterval(() => {
    if (journalDirty) { journal.flush(); journalDirty = false; persist(); }
  }, 500);
  journalFlush.unref();
  const saveReceipts = () => atomicJson(receiptsFile, { schema: 'pi-research-session-receipts.v1', receipts });
  const write = command => new Promise((resolve, reject) => {
    if (closed || !worker.stdin.writable) { reject(new Error('session-worker-unavailable')); return; }
    worker.stdin.write(JSON.stringify(command) + '\n', error => error ? reject(error) : resolve());
  });
  const rpc = (command, timeoutMs = 30_000) => new Promise((resolve, reject) => {
    const id = 'host-' + randomUUID();
    const timer = setTimeout(() => { requests.delete(id); reject(new Error('session-worker-command-outcome-unknown')); }, timeoutMs);
    requests.set(id, { resolve, reject, timer });
    write({ ...command, id }).catch(error => { clearTimeout(timer); requests.delete(id); reject(error); });
  });
  const serializeAdoption = operation => {
    const pending = adoptionTail.then(async () => {
      if (retirementCommitted) fail('session-retirement-committed');
      return operation();
    });
    adoptionTail = pending.catch(() => {});
    return pending;
  };
  const deliver = async (text, promptId, images, delivery = 'steer') => {
    if (typeof text !== 'string' || text.length > 128 * 1024 || !/^[A-Za-z0-9_-]{1,160}$/.test(promptId ?? '')) fail('session-prompt-invalid');
    if (images !== undefined && (!Array.isArray(images) || images.some(image => image?.type !== 'image' || typeof image.data !== 'string' || typeof image.mimeType !== 'string'))) fail('session-prompt-images-invalid');
    if (!['steer', 'followUp'].includes(delivery)) fail('session-prompt-delivery-invalid');
    const hash = createHash('sha256').update(images?.length || delivery !== 'steer' ? JSON.stringify([text, images ?? [], delivery]) : text).digest('hex');
    const old = receipts[promptId];
    if (!old && Object.keys(receipts).length >= 16_384) fail('session-prompt-receipt-capacity');
    if (old && old.hash !== hash) fail('session-prompt-idempotency-conflict');
    if (old?.phase === 'accepted') {
      record({ type: 'prompt_received', sessionId: config.sessionId, promptId, fresh: false });
      return { accepted: true, duplicate: true };
    }
    if (old?.phase === 'sending') {
      // A timed-out RPC must be reconciled against native history before any replay.
      if (!nativeHistoryHasPrompt(config.sessionFile, text, images)) fail('session-prompt-outcome-unknown');
      receipts[promptId] = { hash, phase: 'accepted', at: new Date().toISOString() }; saveReceipts();
      record({ type: 'prompt_received', sessionId: config.sessionId, promptId, fresh: false });
      return { accepted: true, duplicate: true };
    }
    receipts[promptId] = { hash, phase: 'sending', at: new Date().toISOString() }; saveReceipts();
    const response = await rpc({ type: 'prompt', message: text, ...(images ? { images } : {}), streamingBehavior: delivery });
    if (response.success !== true) {
      delete receipts[promptId]; saveReceipts();
      fail('session-prompt-refused');
    }
    receipts[promptId] = { hash, phase: 'accepted', at: new Date().toISOString() }; saveReceipts();
    record({ type: 'prompt_received', sessionId: config.sessionId, promptId, fresh: true });
    return { accepted: true, disposition: response.data?.disposition };
  };
  const retireIfIdle = async ({ pid, reportId }) => {
    const retained = reason => ({ retired: false, committed: false, state: 'retained', reason, reportId });
    if (!Number.isSafeInteger(pid) || !/^[A-Za-z0-9_.:-]{1,200}$/.test(reportId ?? '')) fail('session-retirement-request-invalid');
    if (pid !== status.worker?.pid || !sameProcess(status.worker)) return retained('session-retirement-identity-mismatch');
    if (!ready || closed || status.initialPromptStatus === 'pending' || status.initialPromptStatus === 'sending') return retained('session-retirement-unready');
    const native = await rpc({ type: 'get_state' }, 5000);
    const state = native.data;
    if (native.success !== true || state?.sessionId !== config.sessionId || state?.sessionFile !== config.sessionFile
      || typeof state.isStreaming !== 'boolean' || typeof state.isCompacting !== 'boolean'
      || !Number.isSafeInteger(state.pendingMessageCount) || state.pendingMessageCount < 0) return retained('session-retirement-unready');
    if (state.isStreaming) return retained('session-retirement-busy');
    if (state.pendingMessageCount) return retained('session-retirement-pending');
    if (state.isCompacting) return retained('session-retirement-compacting');
    if (dialogs.size || status.currentTool === 'ask_user') return retained('session-retirement-ui-pending');
    if (activeToolCalls.size) return retained('session-retirement-tools-unresolved');
    if (pid !== status.worker?.pid || !sameProcess(status.worker) || !worker.stdin.writable) return retained('session-retirement-identity-mismatch');
    // The same queue owns prompt adoption and this final commit. Once committed,
    // late commands cannot enqueue a prompt behind the native idle snapshot.
    retirementCommitted = true; ready = false;
    status.retirement = { committed: true, reportId, pid, at: new Date().toISOString() };
    status.phase = 'retiring'; record({ type: 'session_retirement_committed', sessionId: config.sessionId, reportId, pid });
    worker.stdin.end();
    const deadline = Date.now() + 5000;
    while (!closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    return { retired: closed, committed: true, state: closed ? 'retired' : 'retiring', workerExited: closed, reportId };
  };
  const args = [...config.piArgs];
  if (config.extensionPath) args.push('-e', config.extensionPath);
  args.push('--mode', 'rpc', '--session', config.sessionFile);
  if (config.model) args.push('--model', config.model);
  if (config.name) args.push('--name', config.name);
  const errorFd = fs.openSync(path.join(config.directory, 'worker.stderr.log'), 'a', 0o600);
  const worker = spawn(config.piCommand, args, { cwd: config.cwd, env: { ...process.env, ...config.env, PI_RESEARCH_HOST_SESSION_ID: config.sessionId }, stdio: ['pipe', 'pipe', errorFd] });
  fs.closeSync(errorFd);
  status.worker = processIdentity(worker.pid); persist();
  const decoder = new StringDecoder('utf8');
  worker.stdout.on('data', chunk => {
    input += decoder.write(chunk);
    if (input.length > MAX_RECORD) { status.error = 'session-worker-record-too-large'; persist(); worker.kill('SIGTERM'); return; }
    let newline;
    while ((newline = input.indexOf('\n')) >= 0) {
      const line = input.slice(0, newline).replace(/\r$/, ''); input = input.slice(newline + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { status.error = 'session-worker-protocol-invalid'; persist(); continue; }
      if (event.type === 'response' && requests.has(event.id)) {
        const request = requests.get(event.id); clearTimeout(request.timer); requests.delete(event.id); request.resolve(event);
      }
      const updates = extractNativeSessionUpdates(event, dialogs.size > 0);
      if (updates && ['tool_execution_start', 'tool_execution_end'].includes(event.type)) delete updates.currentTool;
      if (updates) Object.assign(status, updates);
      if (updateActiveToolCalls(activeToolCalls, event) && !dialogs.size) status.currentTool = observedToolName(activeToolCalls);
      if (event.type === 'extension_ui_request' && dialogMethods.has(event.method)) {
        const request = { ...event, receivedAt: new Date().toISOString() }; dialogs.set(event.id, request);
        status.currentTool = 'ask_user';
        if (Number.isFinite(event.timeout) && event.timeout > 0) setTimeout(() => {
          if (dialogs.delete(event.id)) {
            status.currentTool = dialogs.size ? 'ask_user' : null;
            record({ type: 'extension_ui_resolved', id: event.id, reason: 'timeout' });
          }
        }, event.timeout).unref();
      }
      record(event);
    }
  });
  worker.once('error', error => { status.error = error.code ?? 'session-worker-launch-failed'; persist(); });
  worker.once('exit', (code, signal) => {
    closed = true; status.phase = 'ended'; status.status = 'ended'; status.exitCode = code; status.signal = signal; status.endedAt = new Date().toISOString();
    for (const request of requests.values()) { clearTimeout(request.timer); request.reject(new Error('session-worker-exited')); }
    requests.clear(); dialogs.clear(); record({ type: 'session_host_ended', sessionId: config.sessionId, code, signal });
    if (retirementCommitted && retirementResponseSent) setImmediate(shutdown);
  });
  const server = net.createServer(socket => {
    let bytes = ''; const decoder = new StringDecoder('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
      bytes += decoder.write(chunk);
      if (bytes.length > MAX_RECORD) { socket.destroy(); return; }
      const newline = bytes.indexOf('\n');
      if (newline < 0) return;
      const line = bytes.slice(0, newline); bytes = '';
      void (async () => {
        let request;
        try {
          request = JSON.parse(line);
          if (request.key !== config.key) fail('session-keeper-unauthorized');
          let value;
          if (request.action === 'inspect') value = { ...status, pendingUIRequests: [...dialogs.values()], ready };
          else if (request.action === 'command') {
            value = await serializeAdoption(() => {
              if (!ready) fail('session-worker-not-ready');
              return rpc(request.command, Math.min(Math.max(Number(request.timeoutMs) || 30_000, 1000), 300_000));
            });
          } else if (request.action === 'deliver') {
            value = await serializeAdoption(() => {
              if (!ready) fail('session-worker-not-ready');
              return deliver(request.text, request.promptId, request.images, request.delivery);
            });
          } else if (request.action === 'retire') {
            if (retirementCommitted) {
              if (status.retirement.reportId !== request.reportId || status.retirement.pid !== request.pid) fail('session-retirement-idempotency-conflict');
              value = { retired: closed, committed: true, state: closed ? 'retired' : 'retiring', workerExited: closed, reportId: request.reportId };
            } else value = await serializeAdoption(() => retireIfIdle(request));
          } else if (request.action === 'ui') {
            if (retirementCommitted) fail('session-retirement-committed');
            const response = request.response;
            if (response?.type !== 'extension_ui_response' || !dialogs.has(response.id)) fail('session-ui-request-not-pending');
            await write(response); dialogs.delete(response.id); status.currentTool = dialogs.size ? 'ask_user' : null;
            record({ type: 'extension_ui_resolved', id: response.id }); value = { accepted: true };
          } else if (request.action === 'terminate') {
            if (!closed && !sameProcess(status.worker)) fail('session-worker-identity-changed');
            if (!closed) {
              worker.kill('SIGTERM');
              const deadline = Date.now() + 5000;
              while (!closed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
              if (!closed && sameProcess(status.worker)) worker.kill('SIGKILL');
              const finalDeadline = Date.now() + 2000;
              while (!closed && Date.now() < finalDeadline) await new Promise(resolve => setTimeout(resolve, 25));
              if (!closed) fail('session-worker-stop-unconfirmed');
            }
            value = { stopped: true, workerExited: true, state: 'stopped' };
          } else fail('session-keeper-action-invalid');
          socket.end(JSON.stringify({ requestId: request.requestId, success: true, value }) + '\n', () => {
            if (request.action === 'terminate') shutdown();
            if (request.action === 'retire' && value.committed) {
              retirementResponseSent = true;
              if (closed) shutdown();
            }
          });
        } catch (error) { socket.end(JSON.stringify({ requestId: request?.requestId, success: false, error: error.code ?? error.message }) + '\n'); }
      })();
    });
  });
  if (fs.existsSync(config.socketPath)) fail('session-keeper-socket-already-exists');
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socketPath, resolve); });
  fs.chmodSync(config.socketPath, 0o600);
  try {
    const response = await rpc({ type: 'get_state' }, config.startupTimeoutMs ?? 30_000);
    if (response.success !== true || response.data?.sessionId !== config.sessionId || response.data?.sessionFile !== config.sessionFile) fail('session-worker-identity-mismatch');
    ready = true; status.phase = 'ready'; status.nativeRegistrationConfirmed = true;
    status.status = response.data.isStreaming ? 'streaming' : 'idle';
    status.compacting = response.data.isCompacting === true;
    if (response.data.model?.provider && response.data.model?.id) status.model = response.data.model.provider + '/' + response.data.model.id;
    if (response.data.thinkingLevel !== undefined) status.thinkingLevel = response.data.thinkingLevel;
    persist();
    record({ type: 'session_host_ready', sessionId: config.sessionId });
    if (config.initialPrompt) {
      status.initialPromptStatus = 'sending'; persist();
      await serializeAdoption(() => deliver(config.initialPrompt, 'initial-' + config.sessionId));
      status.initialPromptStatus = 'accepted'; persist();
    }
  } catch (error) { status.error = error.code ?? error.message; persist(); }
  function shutdown() {
    if (sameProcess(status.worker)) worker.kill('SIGTERM');
    server.close();
    clearInterval(journalFlush);
    if (journalDirty) { journal.flush(); journalDirty = false; persist(); }
    try { fs.unlinkSync(config.socketPath); } catch { /* already removed */ }
    try { fs.rmSync(path.join(lock, 'owner.json')); fs.rmdirSync(lock); } catch { /* retain uncertain lock */ }
    journal.close(); process.exit(0);
  }
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
  return { server, worker };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runKeeper(process.argv[2]).catch(error => { process.stderr.write((error.code ?? error.message) + '\n'); process.exitCode = 1; });
}
