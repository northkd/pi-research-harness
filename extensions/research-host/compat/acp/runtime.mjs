import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createAcpSessionAdapter } from './acp-bridge/acp-session-adapter.mjs';
import { launchAgentProcess } from './acp-bridge/child-env.mjs';
import { createEventLog } from './acp-bridge/event-log.mjs';
import { atomicJson, maybeJson, processIdentity, sameProcess, fail } from '../../session-host/files.mjs';
import { createSessionJournal, readSessionJournal } from '../../session-host/journal.mjs';

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function sessionId(value) { if (!UUID.test(value ?? '')) fail('acp-session-id-invalid'); return value; }
export const supportedMessages = new Set(['send_prompt', 'abort', 'set_model', 'set_thinking_level', 'prompt_response',
  'clear_followup_entries', 'edit_followup_entry', 'remove_followup_entry', 'promote_followup_entry',
  'request_state_sync', 'request_models', 'request_commands', 'prompt_resync_request', 'shutdown', 'register_rejected',
  'transcript_request', 'list_files', 'request_providers', 'git_commit_draft']);
const clone = value => structuredClone(value);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
export function validateMetadataPatch(patch) {
  const immutable = new Set(['id', 'cwd', 'sessionFile', 'driver', 'acpAgentId', 'durable', 'status', 'live', 'ready',
    'pid', 'process', 'workerPid', 'registered', 'nativeRegistrationConfirmed', 'agentRunning', 'exitCode', 'hostError',
    'pendingUIRequests', 'models', 'commands', 'model', 'thinkingLevel', 'eventCursor', 'currentTool', 'followUp', 'steering', '__proto__', 'constructor', 'prototype']);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => immutable.has(key))) fail('acp-metadata-patch-invalid');
}

export function pathsFor(directory, id) {
  sessionId(id);
  return { meta: path.join(directory, `${id}.meta.json`), session: path.join(directory, `${id}.jsonl`),
    events: path.join(directory, `${id}.events.jsonl`), receipts: path.join(directory, `${id}.receipts.json`),
    launch: path.join(directory, `${id}.launch.json`), status: path.join(directory, `${id}.runtime.json`),
    deleted: path.join(directory, `${id}.deleted.json`) };
}

/** Only original bridge observations change displayed state; no inferred outputs. */
export function applyMessage(row, message) {
  if (message.type === 'session_register') Object.assign(row, { registered: true });
  if (message.type === 'session_unregister') Object.assign(row, { status: 'ended', live: false, agentRunning: false, endedAt: Date.now(), pendingUIRequests: [] });
  if (message.type === 'session_heartbeat') row.agentRunning = message.agentRunning;
  if (message.type === 'models_list') row.models = message.models;
  if (message.type === 'commands_list') row.commands = message.commands;
  if (message.type === 'model_update') { row.model = message.model; if ('thinkingLevel' in message) row.thinkingLevel = message.thinkingLevel; }
  if (message.type === 'session_name_update') row.name = message.name;
  if (message.type === 'queue_update') { row.steering = message.steering; row.followUp = message.followUp; }
  if (message.type === 'prompt_request') {
    row.pendingUIRequests = [...(row.pendingUIRequests ?? []).filter(item => item.promptId !== message.promptId), message];
    row.status = 'waiting';
  }
  if (message.type === 'prompt_cancel') row.pendingUIRequests = (row.pendingUIRequests ?? []).filter(item => item.promptId !== message.promptId);
  if (message.type === 'bridge_diagnostic') {
    if (/protocol=v[12] started$/.test(message.detail)) Object.assign(row, { ready: true, status: row.agentRunning ? 'running' : 'idle' });
    if (message.detail.startsWith('failed: ')) row.hostError = message.detail.slice(8);
  }
  if (message.type === 'event_forward' && !message.replay) {
    row.lastActivityAt = message.event.timestamp ?? Date.now();
    if (message.event.eventType === 'agent_start') Object.assign(row, { status: 'running', agentRunning: true });
    if (message.event.eventType === 'agent_settled') Object.assign(row, { status: 'idle', agentRunning: false, currentTool: null });
    if (message.event.eventType === 'tool_execution_start') row.currentTool = message.event.data?.toolName ?? null;
    if (message.event.eventType === 'tool_execution_end') row.currentTool = null;
  }
  return row;
}

export function promptMessage(id, text, options = {}) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 16 * 1024 * 1024) fail('acp-prompt-invalid');
  const promptId = options.promptId ?? randomUUID();
  if (typeof promptId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(promptId)) fail('acp-prompt-id-invalid');
  if (options.images !== undefined && (!Array.isArray(options.images) || options.images.some(image => !image
    || typeof image.data !== 'string' || typeof image.mimeType !== 'string'))) fail('acp-prompt-images-invalid');
  return { type: 'send_prompt', sessionId: id, text, promptId,
    ...(options.images ? { images: clone(options.images) } : {}), ...(options.delivery ? { delivery: options.delivery } : {}) };
}

/** The original adapter owns JSONRPC, normalization, permission and queue behavior. */
export function createRuntime(options) {
  const { agent, settings, cwd, id, directory } = options;
  const files = pathsFor(directory, id);
  const receipts = maybeJson(files.receipts)?.receipts ?? {};
  const journalDirectory = path.join(directory, `${id}.journal`);
  const journal = createSessionJournal(journalDirectory);
  const row = { id, cwd, driver: 'acp', acpAgentId: agent.id, sessionFile: files.session, startedAt: Date.now(),
    durable: agent.durable, status: 'starting', live: true, ready: false, agentRunning: false, pendingUIRequests: [],
    models: [], commands: [], followUp: [], steering: [], currentTool: null,
    ...(options.spawnToken ? { spawnToken: options.spawnToken } : {}) };
  let child, exited = false, closing, resolveExit;
  const exit = new Promise(resolve => { resolveExit = resolve; });
  const persist = () => {
    atomicJson(files.meta, { ...row, live: row.live, schema: 'pi-research-acp-session.v1' });
    if (agent.durable) atomicJson(files.status, { schema: 'pi-research-acp-runtime.v1', worker: processIdentity(process.pid), row });
  };
  const send = message => {
    if (message.type === 'prompt_received' && receipts[message.promptId]) {
      Object.assign(receipts[message.promptId], { status: 'accepted', fresh: message.fresh });
      atomicJson(files.receipts, { schema: 'pi-research-acp-receipts.v1', receipts });
    }
    applyMessage(row, message);
    if (!message.replay) row.eventCursor = journal.append(message, message.type !== 'event_forward').sequence;
    persist();
    options.onMessage?.(message);
  };
  const eventLog = createEventLog({ file: files.events, maxBytes: settings.eventLogMaxBytes });
  const adapter = createAcpSessionAdapter({ agent, settings, cwd, sessionId: id, spawnToken: options.spawnToken,
    sessionFile: files.session, ...(agent.durable ? { reportPid: process.pid } : {}), eventLog,
    send, log: line => options.onDiagnostic?.(line),
    launchAgent: () => {
      child = launchAgentProcess({ agent, cwd, warn: options.onDiagnostic });
      row.pid = child.pid;
      row.process = processIdentity(child.pid);
      child.once('exit', () => { exited = true; });
      child.once('error', () => { exited = true; });
      persist();
      return child;
    },
    onExit: code => {
      Object.assign(row, { status: 'ended', live: false, agentRunning: false, exitCode: code, endedAt: Date.now(), pendingUIRequests: [] });
      persist();
      resolveExit(code);
      options.onExit?.(code);
    },
  });
  persist();

  function receive(message) {
    if (!row.live) return { delivered: false, reason: 'acp-session-ended' };
    if (!message || message.sessionId !== id || !supportedMessages.has(message.type)) fail('acp-message-unsupported');
    if (message.type === 'send_prompt') {
      message = promptMessage(id, message.text, message);
      const digest = createHash('sha256').update(JSON.stringify([message.text, message.images ?? [], message.delivery ?? 'steer'])).digest('hex');
      const previous = receipts[message.promptId];
      if (previous) {
        if (previous.sha256 !== digest) fail('acp-prompt-id-conflict');
        return { delivered: previous.status === 'accepted', duplicate: true, promptId: message.promptId, status: previous.status };
      }
      receipts[message.promptId] = { sha256: digest, status: 'unknown', timestamp: Date.now() };
      atomicJson(files.receipts, { schema: 'pi-research-acp-receipts.v1', receipts });
      adapter.handle(message);
      return { delivered: true, promptId: message.promptId, status: receipts[message.promptId].status };
    }
    if (message.type === 'prompt_response') {
      const pending = row.pendingUIRequests.find(item => item.promptId === message.promptId);
      if (!pending) return { delivered: false, reason: 'acp-permission-prompt-missing' };
      row.pendingUIRequests = row.pendingUIRequests.filter(item => item.promptId !== message.promptId);
      if (row.live) row.status = row.agentRunning ? 'running' : 'idle';
    }
    adapter.handle(message);
    persist();
    return { delivered: true };
  }

  async function stop() {
    closing ??= (async () => {
      await adapter.stop();
      await exit;
      for (let attempts = 0; child && !exited && attempts < 70; attempts++) await pause(50);
      if (child && !exited && sameProcess(row.process)) child.kill('SIGKILL');
      for (let attempts = 0; child && !exited && attempts < 20; attempts++) await pause(50);
      if (child && !exited && sameProcess(row.process)) fail('acp-agent-stop-unconfirmed');
      await eventLog.flush();
      journal.close();
      return clone(row);
    })();
    return closing;
  }
  function updateSession(patch) {
    validateMetadataPatch(patch);
    for (const [key, value] of Object.entries(patch)) { if (value === undefined) delete row[key]; else row[key] = clone(value); }
    persist(); return clone(row);
  }
  return { start: async () => { await adapter.start(); return clone(row); }, getSession: () => clone(row), receive, stop, updateSession,
    readEvents: options => readSessionJournal(journalDirectory, options),
    disconnected: adapter.disconnected, reconnected: adapter.reconnected, eventLog, exit };
}
