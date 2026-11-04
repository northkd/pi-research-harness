import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { discoverWorkbenchScopes, digest, readVerified } from './workbench-sync.mjs';
import { validateStageTaskSummaryForPacket } from './stage-task-summary.mjs';

/**
 * Permanent, silent, idle-only stage classifier.
 *
 * This module is deliberately narrow: it asks a model to pick one of the five
 * workflow stage ids from a minimal packet. It never reviews science, accepts
 * claims, publishes, rewrites research or creates chat sessions/cards.
 */

export const IDLE_STAGE_REVIEW_SCHEMA = 'pi-research.idle-stage-review.v1';
export const PACKET_SCHEMA = 'pi-research.idle-stage-review.packet.v1';
export const STAGES = Object.freeze(['1-idea', '2-experiment', '3-review', '4-summary', '5-writing']);
const STAGE_SET = new Set(STAGES);
const BUSY_SESSION = new Set(['active', 'streaming']);
const BUSY_EXECUTION = new Set(['registered', 'queued', 'started', 'running', 'active', 'streaming', 'waiting', 'pending', 'partial', 'stopping', 'paused', 'blocked']);
const TERMINAL_EXECUTION = new Set(['complete', 'completed', 'failed', 'stopped', 'cancelled', 'rejected', 'ended']);
const IDLE_EXECUTION = new Set(['idle']);
const SECRET = /(?:-----BEGIN [A-Z ]*PRIVATE KEY|(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|authorization|secret|credential|cookie)\s*["']?\s*[:=]\s*\S+|\bBearer\s+\S+|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:sk|ghp|github_pat)[_-][A-Za-z0-9_-]{12,})/i;
const SECRET_GLOBAL = new RegExp(SECRET.source, 'gi');
const SYSTEM_PROMPT = [
  'You are a narrow workflow-stage classifier. You do not review scientific quality,',
  'accept claims, recommend publication, or rewrite research.',
  'Given the JSON packet, return exactly one JSON object with one of these stage ids:',
  STAGES.join(', ') + '.',
  'If the packet is metadata-only and cannot support a stage choice, return',
  '{"stage":null,"insufficient":true}. Do not invent content.',
].join(' ');

const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const iso = value => (typeof value === 'string' || typeof value === 'number') && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : undefined;
const token = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max && !['__proto__', 'constructor', 'prototype'].includes(value) ? value : undefined;
const safeAbsolute = value => typeof value === 'string' && value.length <= 4096 && !value.includes('\0') && path.isAbsolute(value) && path.resolve(value) === value ? value : undefined;
const number = (value, min, max, fallback) => Number.isFinite(value) && value >= min && value <= max ? Number(value) : fallback;
const nonNegative = (value, fallback) => Number.isFinite(value) && value >= 0 ? Number(value) : fallback;

function loopbackUrl(value, { originOnly = false } = {}) {
  if (typeof value !== 'string' || !value || value.includes('\0')) throw Error('loopback-url-required');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw Error('loopback-url-required');
  if (!['127.0.0.1', '[::1]', '::1'].includes(url.hostname)) throw Error('loopback-url-required');
  if (!url.port || url.username || url.password || url.search || url.hash) throw Error('loopback-url-required');
  if (originOnly && url.pathname !== '/') throw Error('loopback-origin-required');
  return originOnly ? url.origin : url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
}

function privatePath(value, label) {
  const safe = safeAbsolute(value);
  if (!safe) throw Error(label + '-absolute-path-required');
  return safe;
}

function readPrivateJson(file, max = 64 * 1024) {
  const text = readVerified(file, max);
  return JSON.parse(text);
}

function ensurePrivateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('private-directory-required');
  fs.chmodSync(dir, 0o700);
}

function writePrivateJson(file, value) {
  ensurePrivateDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + randomUUID() + '.tmp');
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > 16 * 1024 * 1024) throw Error('private-record-too-large');
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function appendAudit(file, entry) {
  ensurePrivateDir(path.dirname(file));
  try {
    const stat = fs.lstatSync(file);
    if (stat.size > 8 * 1024 * 1024) fs.renameSync(file, file + '.1');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const fd = fs.openSync(file, 'a', 0o600);
  try {
    fs.writeSync(fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function redact(value) {
  return String(value).replace(SECRET_GLOBAL, '[redacted]');
}

function errorCode(error, fallback = 'error') {
  return typeof error?.code === 'string' && /^[a-z0-9-]{1,64}$/.test(error.code) ? error.code : fallback;
}

/** Structural validation. Missing provider/auth is allowed and reported as a skip. */
export function validateConfig(input) {
  if (!object(input)) throw Error('config-object-required');
  const config = {
    enabled: input.enabled === true,
    stateDir: privatePath(input.stateDir, 'state-dir'),
    adoptionRoot: input.adoptionRoot === undefined ? undefined : privatePath(input.adoptionRoot, 'adoption-root'),
    projectAllowlist: Array.isArray(input.projectAllowlist) ? input.projectAllowlist.map((p, i) => privatePath(p, 'project-' + i)) : undefined,
    dashboardOrigin: input.dashboardOrigin === undefined ? undefined : loopbackUrl(input.dashboardOrigin, { originOnly: true }),
    dashboardAuthFile: input.dashboardAuthFile === undefined ? undefined : privatePath(input.dashboardAuthFile, 'dashboard-auth-file'),
    workbench: undefined,
    provider: token(input.provider, 128),
    model: token(input.model, 256),
    modelBaseUrl: input.modelBaseUrl === undefined ? undefined : loopbackUrl(input.modelBaseUrl),
    // The proxy base URL is loopback, so it cannot prove where the request is
    // actually exported. This exact host must match the user's authorization.
    modelUpstreamHost: input.modelUpstreamHost === undefined ? undefined : token(input.modelUpstreamHost, 253),
    modelEndpoint: token(input.modelEndpoint ?? '/chat/completions', 512),
    apiKeyFile: input.apiKeyFile === undefined ? undefined : privatePath(input.apiKeyFile, 'api-key-file'),
    apiKeyEnv: input.apiKeyEnv === undefined ? undefined : token(input.apiKeyEnv, 128),
    authorization: object(input.authorization) ? input.authorization : undefined,
    packet: undefined,
    idleAfterMs: number(input.idleAfterMs, 0, 7 * 24 * 60 * 60 * 1000, 5 * 60 * 1000),
    cooldownMs: number(input.cooldownMs, 0, 7 * 24 * 60 * 60 * 1000, 60 * 60 * 1000),
    maxRequestsPerProjectPerDay: number(input.maxRequestsPerProjectPerDay, 1, 100, 8),
    requestTimeoutMs: number(input.requestTimeoutMs, 1000, 10 * 60 * 1000, 60 * 1000),
    dashboardTimeoutMs: number(input.dashboardTimeoutMs, 1000, 60 * 1000, 8000),
    tickIntervalMs: number(input.tickIntervalMs, 1000, 60 * 60 * 1000, 30 * 1000),
    backoffMs: number(input.backoffMs, 1000, 60 * 60 * 1000, 60 * 1000),
    maxBackoffMs: number(input.maxBackoffMs, 1000, 24 * 60 * 60 * 1000, 60 * 60 * 1000),
    maxPromptChars: number(input.maxPromptChars, 256, 100_000, 12_000),
    maxPacketChars: number(input.maxPacketChars, 256, 100_000, 8_000),
    maxResponseBytes: number(input.maxResponseBytes, 1024, 4 * 1024 * 1024, 256 * 1024),
    maxResponseChars: number(input.maxResponseChars, 64, 100_000, 4000),
    skipAuditIntervalMs: number(input.skipAuditIntervalMs, 0, 24 * 60 * 60 * 1000, 10 * 60 * 1000),
  };
  if (config.modelEndpoint && (!config.modelEndpoint.startsWith('/') || config.modelEndpoint.includes('..') || /[?#]/.test(config.modelEndpoint))) throw Error('model-endpoint-invalid');
  if (config.modelUpstreamHost !== undefined && !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(config.modelUpstreamHost)) throw Error('model-upstream-host-invalid');
  if (config.apiKeyEnv && !/^[A-Z_][A-Z0-9_]{0,127}$/.test(config.apiKeyEnv)) throw Error('api-key-env-invalid');
  if (object(input.workbench)) {
    const workbench = input.workbench;
    if (workbench.syncOrigin !== undefined) {
      config.workbench = {
        syncOrigin: loopbackUrl(workbench.syncOrigin, { originOnly: true }),
        tokenFile: workbench.tokenFile === undefined ? undefined : privatePath(workbench.tokenFile, 'workbench-token-file'),
        heartbeatMaxAgeMs: number(workbench.heartbeatMaxAgeMs, 1000, 24 * 60 * 60 * 1000, 120 * 1000),
        requestTimeoutMs: number(workbench.requestTimeoutMs, 1000, 60 * 1000, 8000),
      };
    }
  }
  const packetInput = object(input.packet) ? input.packet : {};
  const mode = packetInput.mode === 'approved-extracts' ? 'approved-extracts' : 'metadata';
  const extractFiles = Array.isArray(packetInput.extractFiles) ? packetInput.extractFiles.map((entry, index) => {
    if (!object(entry)) throw Error('extract-entry-invalid');
    const label = token(entry.label, 64);
    if (!label) throw Error('extract-label-invalid');
    // Legacy operator-written extracts stay explicit. A generated task summary
    // must be opted into with kind, and is still subject to materialPaths.
    const kind = entry.kind === undefined ? 'operator-extract' : entry.kind;
    if (!['operator-extract', 'stage-task-summary'].includes(kind)) throw Error('extract-kind-invalid');
    return { label, kind, file: privatePath(entry.file, 'extract-file-' + index), maxChars: number(entry.maxChars, 1, 20_000, 2000) };
  }) : [];
  if (mode === 'approved-extracts' && extractFiles.length === 0) throw Error('approved-extract-required');
  if (extractFiles.length > 16) throw Error('too-many-extracts');
  config.packet = { mode, extractFiles };
  if (config.enabled && !config.adoptionRoot) throw Error('adoption-root-required');
  if (config.enabled && !config.dashboardOrigin) throw Error('dashboard-origin-required');
  if (config.enabled && !config.workbench) throw Error('workbench-sync-required');
  // Never default to "every adoption". Review scope must be written down even
  // before authorization is present.
  if (config.enabled && (!config.projectAllowlist || config.projectAllowlist.length === 0)) throw Error('project-allowlist-required');
  return config;
}

function authorizationIssue(config) {
  if (!config.provider || !config.model) return 'provider-model-required';
  if (config.provider !== 'openai-compatible') return 'provider-unsupported';
  if (!config.modelBaseUrl) return 'model-base-url-required';
  const auth = config.authorization;
  if (!object(auth) || auth.approved !== true) return 'authorization-missing';
  if (auth.provider !== config.provider || auth.model !== config.model) return 'authorization-model-mismatch';
  if (auth.purpose !== 'stage-classification') return 'authorization-purpose-mismatch';
  if (auth.materialMode !== config.packet.mode) return 'authorization-material-mismatch';
  if (!token(auth.approvedBy, 256) || !iso(auth.approvedAt)) return 'authorization-incomplete';
  // The loopback proxy's base URL says nothing about the real upstream. The
  // config and the written authorization must name the same external host.
  const upstream = token(auth.upstreamHost, 253);
  if (!upstream) return 'authorization-upstream-required';
  if (!config.modelUpstreamHost) return 'model-upstream-host-required';
  if (auth.upstreamHost !== config.modelUpstreamHost) return 'authorization-upstream-mismatch';
  // Authorization is for one named project; a list of adoptions cannot inherit it.
  if (!Array.isArray(config.projectAllowlist) || config.projectAllowlist.length !== 1) return 'authorization-project-scope-required';
  let project;
  try { project = privatePath(auth.project, 'authorization-project'); }
  catch { return 'authorization-project-invalid'; }
  if (project !== config.projectAllowlist[0]) return 'authorization-project-mismatch';
  // Approved extracts must name the exact files that were approved. A bare
  // approved:true never turns "some file" into export permission.
  if (config.packet.mode === 'approved-extracts') {
    if (!Array.isArray(auth.materialPaths) || auth.materialPaths.length === 0) return 'authorization-material-paths-required';
    let approvedPaths;
    try { approvedPaths = auth.materialPaths.map((file, index) => privatePath(file, 'authorization-material-' + index)); }
    catch { return 'authorization-material-paths-invalid'; }
    const approvedSet = new Set(approvedPaths);
    const configuredSet = new Set(config.packet.extractFiles.map(entry => entry.file));
    if (approvedSet.size !== configuredSet.size || [...configuredSet].some(file => !approvedSet.has(file))) return 'authorization-material-path-mismatch';
  }
  if (Number.isSafeInteger(auth.maxCallsPerDay) && config.maxRequestsPerProjectPerDay > auth.maxCallsPerDay) return 'authorization-daily-limit-exceeded';
  return undefined;
}

function resolveApiKey(config, env) {
  if (config.apiKeyEnv && typeof env?.[config.apiKeyEnv] === 'string' && env[config.apiKeyEnv].trim()) {
    const value = env[config.apiKeyEnv].trim();
    return value.length <= 8192 && !/[\x00-\x1f]/.test(value) ? value : undefined;
  }
  if (!config.apiKeyFile) return undefined;
  try {
    const value = readVerified(config.apiKeyFile, 8192).trim();
    return value && value.length <= 8192 && !/[\x00-\x1f]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function dashboardHeaders(config) {
  if (!config.dashboardAuthFile) return undefined;
  let raw;
  try {
    raw = readPrivateJson(config.dashboardAuthFile, 16 * 1024);
  } catch {
    return undefined;
  }
  const headers = {};
  const source = object(raw.headers) ? raw.headers : raw;
  for (const key of ['cookie', 'authorization', 'x-pi-local-token']) {
    if (typeof source?.[key] === 'string' && source[key].length > 0 && source[key].length <= 8192 && !/[\x00-\r\n]/.test(source[key])) headers[key] = source[key];
  }
  if (typeof source?.localToken === 'string' && source.localToken.length > 0 && source.localToken.length <= 8192 && !/[\x00-\r\n]/.test(source.localToken)) headers['x-pi-local-token'] = source.localToken;
  return Object.keys(headers).length ? headers : undefined;
}

function workbenchToken(config) {
  if (!config.workbench?.tokenFile) return undefined;
  try {
    const value = readVerified(config.workbench.tokenFile, 8192).trim();
    return value && value.length <= 8192 && !/[\x00-\r\n]/.test(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

async function boundedJson(url, { headers, fetcher, timeoutMs, maxBytes }) {
  const response = await fetcher(url, { method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
  if (!response || response.status !== 200 || !response.body) throw Error('upstream-refused');
  const reader = response.body.getReader();
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw Error('upstream-response-too-large');
      parts.push(Buffer.from(next.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}

function participation(row) {
  const ref = row?.resWorkflow ?? row?.pluginRefs?.['res-workflow']?.resWorkflow;
  return object(ref) && typeof ref.canonicalCwd === 'string' && iso(ref.joinedAt) && ['manual', 'adoption', 'spawn'].includes(ref.via) ? ref : undefined;
}

function ownerAllows(ownerKey, row) {
  let owner;
  try { owner = JSON.parse(ownerKey); } catch { return false; }
  if (!Array.isArray(owner) || owner.length !== 2) return false;
  if (owner[0] === 'urn:pi-dashboard:local-operator') return true;
  if (owner[0] === 'host' && owner[1] === 'inert-operator') return !row.principalOwner;
  return row.principalOwner?.iss === owner[0] && row.principalOwner?.sub === owner[1];
}

function joinedRow(row, scope) {
  const ref = participation(row);
  if (!ref || ref.canonicalCwd !== scope.cwd) return false;
  if (!token(row.id, 128) || row.originDeviceId || row.pluginHidden || row.archiveOnEnd) return false;
  return ownerAllows(scope.ownerKey, row);
}

function rowCwd(row, scope) {
  if (participation(row)?.canonicalCwd === scope.cwd) return scope.cwd;
  if (!safeAbsolute(row?.cwd)) return undefined;
  try { return fs.realpathSync(row.cwd) === scope.cwd ? scope.cwd : undefined; } catch { return undefined; }
}

function sessionPressure(row) {
  const pressure = row?.hostPressure;
  if (pressure === null || pressure === undefined) return undefined;
  if (!object(pressure)) return 'host-pressure-unknown';
  const state = pressure.state ?? pressure.status;
  if (state === 'degraded' || state === 'unresponsive') return 'host-pressure-' + state;
  return undefined;
}

function executionPressure(execution) {
  if (!token(execution?.id, 128)) return { unknown: 'execution-identity-unknown' };
  const status = execution.status;
  if (execution.currentTool) return { busy: 'execution-tool-active' };
  if (status === 'waiting-for-user') return { busy: 'execution-waiting-for-user' };
  if (TERMINAL_EXECUTION.has(status) || IDLE_EXECUTION.has(status)) return { idle: true };
  if (BUSY_EXECUTION.has(status)) return { busy: 'execution-' + status };
  return { unknown: 'execution-status-unknown' };
}

/** Fail-closed idle probe. It never treats transcript mtime as proof of idle. */
function probeProjectIdle(scope, { sessions, observation, now, workbenchMaxAgeMs }) {
  const busy = [];
  const unknown = [];
  const joined = sessions.filter(row => joinedRow(row, scope));
  const ids = new Set(joined.map(row => row.id));
  const scopeRows = sessions.filter(row => rowCwd(row, scope) === scope.cwd);
  const evidenceRows = [];

  for (const row of scopeRows) {
    const record = {
      id: row.id,
      joined: ids.has(row.id),
      status: row.status,
      currentTool: row.currentTool ?? null,
      awaitingFileAccess: row.awaitingFileAccess === true,
      hostPressure: row.hostPressure ?? null,
      compacting: row.compacting === true,
      endedAt: iso(row.endedAt),
      lastSettledAt: iso(row.lastSettledAt),
      lastRunStartedAt: iso(row.lastRunStartedAt),
    };
    evidenceRows.push(record);
    const pressure = sessionPressure(row);
    if (pressure) { busy.push(pressure); continue; }
    if (row.currentTool) { busy.push('tool-active'); continue; }
    if (row.awaitingFileAccess === true) { busy.push('permission-wait'); continue; }
    if (row.compacting === true) { busy.push('compacting'); continue; }
    if (row.lastRunStartedAt && (!row.lastSettledAt || new Date(row.lastRunStartedAt).getTime() > new Date(row.lastSettledAt).getTime())) { busy.push('run-not-settled'); continue; }
    if (BUSY_SESSION.has(row.status)) { busy.push('session-' + row.status); continue; }
    if (row.status === 'idle' || row.status === 'ended') continue;
    unknown.push('session-status-unknown');
  }
  if (unknown.length) return { state: 'unknown', reasons: [...new Set(unknown)].slice(0, 16), evidence: { sessions: evidenceRows } };
  if (busy.length) return { state: 'busy', reasons: [...new Set(busy)].slice(0, 16), evidence: { sessions: evidenceRows } };

  if (!observation) return { state: 'unknown', reasons: ['workbench-observation-unavailable'], evidence: { sessions: evidenceRows } };
  if (observation.cwd !== scope.cwd || observation.adoptionId !== scope.adoptionId || observation.charterHash !== scope.charterHash) {
    return { state: 'unknown', reasons: ['workbench-scope-mismatch'], evidence: { sessions: evidenceRows } };
  }
  const heartbeat = iso(observation.heartbeatAt);
  if (!heartbeat || now - new Date(heartbeat).getTime() > workbenchMaxAgeMs) return { state: 'unknown', reasons: ['workbench-heartbeat-stale'], evidence: { sessions: evidenceRows } };
  if (observation.coverage?.partial !== false || !Array.isArray(observation.coverage?.reasons) || observation.coverage.reasons.length) {
    return { state: 'unknown', reasons: ['workbench-coverage-partial'].concat(Array.isArray(observation.coverage?.reasons) ? observation.coverage.reasons.slice(0, 8) : []), evidence: { sessions: evidenceRows } };
  }
  if (observation.coverage.parentSessions !== joined.length) {
    return { state: 'unknown', reasons: ['workbench-membership-mismatch'], evidence: { sessions: evidenceRows } };
  }
  if (!Array.isArray(observation.executions)) return { state: 'unknown', reasons: ['workbench-executions-missing'], evidence: { sessions: evidenceRows } };
  const executions = [];
  for (const execution of observation.executions) {
    const pressure = executionPressure(execution);
    if (pressure.busy) { busy.push(pressure.busy); continue; }
    if (pressure.unknown) { unknown.push(pressure.unknown); continue; }
    executions.push({
      id: execution.id,
      kind: execution.kind ?? null,
      status: execution.status,
      currentTool: execution.currentTool ?? null,
      lastActivityAt: iso(execution.lastActivityAt),
    });
  }
  if (unknown.length) return { state: 'unknown', reasons: [...new Set(unknown)].slice(0, 16), evidence: { sessions: evidenceRows, executions } };
  if (busy.length) return { state: 'busy', reasons: [...new Set(busy)].slice(0, 16), evidence: { sessions: evidenceRows, executions } };
  return {
    state: 'idle',
    reasons: [],
    evidence: {
      sessions: evidenceRows.sort((a, b) => String(a.id).localeCompare(String(b.id))),
      executions: executions.sort((a, b) => String(a.id).localeCompare(String(b.id))),
      coverage: { parentSessions: observation.coverage.parentSessions, nativeRuns: observation.coverage.nativeRuns },
      observationUpdatedAt: iso(observation.updatedAt),
    },
  };
}

function cleanExtract(text, maxChars) {
  const redacted = redact(String(text).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')).replace(/\r\n/g, '\n').trim();
  return redacted.slice(0, maxChars);
}

function buildPacket(scope, probe, idleSince, maxPacketChars = Infinity) {
  const packet = {
    schema: PACKET_SCHEMA,
    mode: scope.packetMode,
    projectRef: digest(scope.cwd).slice(0, 24),
    charterHash: scope.charterHash,
    currentStage: STAGE_SET.has(scope.stage) ? scope.stage : null,
    idleSince,
    observed: {
      joinedSessions: probe.evidence.sessions.filter(row => row.joined).length,
      idleSessions: probe.evidence.sessions.filter(row => row.status === 'idle').length,
      endedSessions: probe.evidence.sessions.filter(row => row.status === 'ended').length,
      executions: probe.evidence.executions?.length ?? 0,
      lastSettledAt: probe.evidence.sessions.map(row => row.lastSettledAt).filter(Boolean).sort().at(-1),
      lastActivityAt: probe.evidence.executions?.map(row => row.lastActivityAt).filter(Boolean).sort().at(-1),
    },
  };
  if (scope.packetMode === 'approved-extracts') {
    const extracts = [];
    for (const entry of scope.extractFiles) {
      if (entry.kind === 'stage-task-summary') {
        // The file is regenerated automatically. Validate its schema, exact
        // charter binding, task count and bounds; forward only reconstructed
        // summaries, never arbitrary fields or raw file text.
        let value;
        try { value = JSON.parse(readVerified(entry.file, 64 * 1024)); }
        catch { throw Object.assign(Error('stage-task-summary-unreadable'), { code: 'stage-task-summary-unreadable' }); }
        const guarded = validateStageTaskSummaryForPacket(value, { charterHash: scope.charterHash, maxChars: entry.maxChars });
        if (!guarded) throw Object.assign(Error('stage-task-summary-invalid'), { code: 'stage-task-summary-invalid' });
        extracts.push({ label: entry.label, text: guarded.text });
        continue;
      }
      let text;
      try { text = readVerified(entry.file, 1 * 1024 * 1024); } catch { throw Error('approved-extract-unreadable'); }
      const cleaned = cleanExtract(text, entry.maxChars);
      if (cleaned) extracts.push({ label: entry.label, text: cleaned });
    }
    packet.extracts = extracts;
  }
  if (Buffer.byteLength(JSON.stringify(packet)) > maxPacketChars) {
    throw Object.assign(Error('packet-too-large'), { code: 'packet-too-large' });
  }
  return packet;
}

function packetFingerprint(scope, probe, packet) {
  return 'sha256:' + digest(JSON.stringify({
    charterHash: scope.charterHash,
    stage: scope.stage ?? null,
    idleSince: packet.idleSince,
    packet,
    evidence: { sessions: probe.evidence.sessions, executions: probe.evidence.executions, coverage: probe.evidence.coverage },
  }));
}

function parseModelContent(body, maxChars) {
  if (!object(body) || !Array.isArray(body.choices) || !body.choices[0]) throw Object.assign(Error('model-response-invalid'), { code: 'model-response-invalid' });
  const content = body.choices[0].message?.content;
  let text;
  if (typeof content === 'string') text = content;
  else if (Array.isArray(content)) text = content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
  if (typeof text !== 'string' || !text.trim()) throw Object.assign(Error('model-response-empty'), { code: 'model-response-empty' });
  if (text.length > maxChars) throw Object.assign(Error('model-response-too-large'), { code: 'model-response-too-large' });
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  let value;
  try { value = JSON.parse(cleaned); } catch { throw Object.assign(Error('model-json-invalid'), { code: 'model-json-invalid' }); }
  if (!object(value)) throw Object.assign(Error('model-json-invalid'), { code: 'model-json-invalid' });
  if (value.stage === null && value.insufficient === true) return { stage: null, insufficient: true, usage: usageOf(body.usage) };
  if (!STAGE_SET.has(value.stage)) throw Object.assign(Error('model-stage-invalid'), { code: 'model-stage-invalid' });
  return { stage: value.stage, insufficient: false, usage: usageOf(body.usage) };
}

function usageOf(raw) {
  if (!object(raw)) return {};
  const usage = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens']) if (Number.isSafeInteger(raw[key]) && raw[key] >= 0) usage[key] = raw[key];
  return usage;
}

async function requestStage({ config, packet, apiKey, fetcher }) {
  const payload = {
    model: config.model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: JSON.stringify(packet) },
    ],
    temperature: 0,
    max_tokens: 64,
  };
  const body = JSON.stringify(payload);
  if (body.length > config.maxPromptChars) throw Object.assign(Error('packet-too-large'), { code: 'packet-too-large' });
  const endpoint = config.modelBaseUrl + config.modelEndpoint;
  const response = await fetcher(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey },
    body,
    redirect: 'error',
    signal: AbortSignal.timeout(config.requestTimeoutMs),
  });
  if (!response || response.status !== 200 || !response.body) {
    const error = Error('model-request-refused');
    error.code = response?.status === 401 || response?.status === 403 ? 'model-auth-rejected' : 'model-request-refused';
    throw error;
  }
  const reader = response.body.getReader();
  const parts = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > config.maxResponseBytes) throw Object.assign(Error('model-response-too-large'), { code: 'model-response-too-large' });
      parts.push(Buffer.from(next.value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { throw Object.assign(Error('model-json-invalid'), { code: 'model-json-invalid' }); }
  const result = parseModelContent(parsed, config.maxResponseChars);
  result.responseModel = token(parsed.model, 256);
  return result;
}

function projectStateFile(stateDir, scope) {
  // Quota belongs to the project, not a replaceable charter/adoption/owner realm.
  return path.join(stateDir, 'projects', digest(scope.cwd) + '.json');
}

function loadProjectState(file, scope) {
  try {
    const value = readPrivateJson(file, 256 * 1024);
    if (value.schema === IDLE_STAGE_REVIEW_SCHEMA && value.cwd === scope.cwd) {
      const sameScope = value.ownerKey === scope.ownerKey && value.adoptionId === scope.adoptionId && value.charterHash === scope.charterHash;
      return { ...value, ownerKey: scope.ownerKey, adoptionId: scope.adoptionId, charterHash: scope.charterHash,
        ...(!sameScope ? { idleSince: null, lastFingerprint: undefined, lastStage: undefined } : {}) };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return {
    schema: IDLE_STAGE_REVIEW_SCHEMA,
    cwd: scope.cwd,
    ownerKey: scope.ownerKey,
    adoptionId: scope.adoptionId,
    charterHash: scope.charterHash,
    idleSince: null,
    lastFingerprint: undefined,
    lastStage: undefined,
    lastRequestAt: undefined,
    day: undefined,
    dayCount: 0,
    failures: 0,
    backoffUntil: undefined,
    lastSkipReason: undefined,
    lastSkipAt: undefined,
    updatedAt: new Date(0).toISOString(),
  };
}

function acquireSingleton(stateDir) {
  ensurePrivateDir(stateDir);
  const file = path.join(stateDir, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      const nonce = randomUUID();
      fs.writeFileSync(fd, JSON.stringify({ schema: IDLE_STAGE_REVIEW_SCHEMA, pid: process.pid, nonce }));
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      const owned = fs.lstatSync(file);
      return {
        release() {
          try {
            const current = fs.lstatSync(file);
            if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(file);
          } catch { /* already gone */ }
        },
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let prior;
      try { prior = readPrivateJson(file, 1024); } catch { throw Error('idle-stage-review-lock-invalid'); }
      if (!Number.isSafeInteger(prior.pid) || prior.pid < 1) throw Error('idle-stage-review-lock-invalid');
      try { process.kill(prior.pid, 0); throw Error('idle-stage-review-already-running'); }
      catch (probe) { if (probe.code !== 'ESRCH') throw Error('idle-stage-review-already-running'); }
      fs.unlinkSync(file);
    }
  }
  throw Error('idle-stage-review-already-running');
}

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

export function createIdleStageReviewer(options = {}) {
  const config = options.config;
  if (!object(config) || typeof config.enabled !== 'boolean') throw Error('validated-config-required');
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const env = options.env ?? process.env;
  const onEvent = options.onEvent;
  const lock = acquireSingleton(config.stateDir);
  const auditFile = path.join(config.stateDir, 'audit.jsonl');
  let closed = false;
  let ticking = false;
  let disabledAudited = false;
  let recorderPromise;

  function getRecorder() {
    if (typeof options.recordStage === 'function') return Promise.resolve(options.recordStage);
    recorderPromise ??= import('./stage-observer.mjs')
      .then(module => {
        if (typeof module.recordObservedStage !== 'function') throw Object.assign(Error('stage-contract-unavailable'), { code: 'stage-contract-unavailable' });
        return module.recordObservedStage;
      })
      .catch(() => { throw Object.assign(Error('stage-contract-unavailable'), { code: 'stage-contract-unavailable' }); });
    return recorderPromise;
  }

  function audit(scope, entry, timestamp = now()) {
    const record = {
      at: new Date(timestamp).toISOString(),
      schema: IDLE_STAGE_REVIEW_SCHEMA,
      ...(scope ? { cwd: scope.cwd, adoptionId: scope.adoptionId, charterHash: scope.charterHash, projectRef: digest(scope.cwd).slice(0, 24) } : {}),
      ...entry,
    };
    try { appendAudit(auditFile, record); } catch { /* audit must not crash the daemon */ }
    try { onEvent?.(record); } catch { /* observer only */ }
  }

  function save(file, state) {
    state.updatedAt = new Date(now()).toISOString();
    writePrivateJson(file, state);
  }

  function skip(scope, state, file, reason, extra = {}) {
    const timestamp = now();
    const changed = state.lastSkipReason !== reason;
    const due = !state.lastSkipAt || timestamp - state.lastSkipAt >= config.skipAuditIntervalMs;
    if (changed || due) audit(scope, { event: 'skipped', reason, ...extra }, timestamp);
    state.lastSkipReason = reason;
    state.lastSkipAt = timestamp;
    save(file, state);
    return { status: 'skipped', reason, cwd: scope?.cwd, ...extra };
  }

  async function readSessions() {
    if (!config.dashboardOrigin) return { ok: false, code: 'dashboard-unconfigured' };
    const headers = dashboardHeaders(config);
    if (!headers) return { ok: false, code: 'dashboard-auth-missing' };
    try {
      const value = await boundedJson(config.dashboardOrigin + '/api/sessions', { headers, fetcher, timeoutMs: config.dashboardTimeoutMs, maxBytes: 16 * 1024 * 1024 });
      if (!object(value) || value.success !== true || !Array.isArray(value.data)) return { ok: false, code: 'dashboard-sessions-invalid' };
      return { ok: true, sessions: value.data };
    } catch (error) {
      return { ok: false, code: errorCode(error, 'dashboard-unavailable') };
    }
  }

  async function readObservation(scope) {
    if (!config.workbench?.syncOrigin) return { ok: false, code: 'workbench-unconfigured' };
    const tokenValue = workbenchToken(config);
    if (!tokenValue) return { ok: false, code: 'workbench-auth-missing' };
    try {
      const url = config.workbench.syncOrigin + '/api/res-workflow/workbench-sync?cwd=' + encodeURIComponent(scope.cwd);
      const value = await boundedJson(url, { headers: { 'x-pi-local-token': tokenValue, 'x-pi-caller-local': '1' }, fetcher, timeoutMs: config.workbench.requestTimeoutMs, maxBytes: 2 * 1024 * 1024 });
      return { ok: true, observation: value };
    } catch (error) {
      return { ok: false, code: errorCode(error, 'workbench-unavailable') };
    }
  }

  async function processScope(scope) {
    const file = projectStateFile(config.stateDir, scope);
    const state = loadProjectState(file, scope);
    const timestamp = now();

    const sessionsResult = await readSessions();
    if (!sessionsResult.ok) { state.idleSince = null; return skip(scope, state, file, sessionsResult.code); }

    const observationResult = await readObservation(scope);
    let observation;
    if (observationResult.ok) observation = observationResult.observation;
    else if (observationResult.code !== 'workbench-unconfigured') { state.idleSince = null; return skip(scope, state, file, observationResult.code); }

    const probe = probeProjectIdle(scope, {
      sessions: sessionsResult.sessions,
      observation,
      now: timestamp,
      workbenchMaxAgeMs: config.workbench?.heartbeatMaxAgeMs ?? 120_000,
    });
    if (probe.state === 'busy') {
      state.idleSince = null;
      return skip(scope, state, file, 'project-busy', { reasons: probe.reasons });
    }
    if (probe.state === 'unknown') {
      state.idleSince = null;
      return skip(scope, state, file, 'coverage-unknown', { reasons: probe.reasons });
    }
    if (!state.idleSince) {
      state.idleSince = new Date(timestamp).toISOString();
      return skip(scope, state, file, 'idle-threshold-pending');
    }
    if (timestamp - new Date(state.idleSince).getTime() < config.idleAfterMs) return skip(scope, state, file, 'idle-threshold');

    const authIssue = authorizationIssue(config);
    if (authIssue) return skip(scope, state, file, authIssue);
    const apiKey = resolveApiKey(config, env);
    if (!apiKey) return skip(scope, state, file, 'model-auth-missing');

    let recorder;
    try { recorder = await getRecorder(); } catch (error) { return skip(scope, state, file, errorCode(error, 'stage-contract-unavailable')); }

    scope = { ...scope, packetMode: config.packet.mode, extractFiles: config.packet.extractFiles };
    let packet;
    try { packet = buildPacket(scope, probe, state.idleSince, config.maxPacketChars); } catch (error) { return skip(scope, state, file, errorCode(error, 'packet-unavailable')); }
    const fingerprint = packetFingerprint(scope, probe, packet);
    if (state.lastFingerprint === fingerprint) return skip(scope, state, file, 'unchanged');

    if (state.backoffUntil && timestamp < state.backoffUntil) return skip(scope, state, file, 'backoff');
    if (state.lastRequestAt && timestamp - state.lastRequestAt < config.cooldownMs) return skip(scope, state, file, 'cooldown');
    const day = utcDay(timestamp);
    if (state.day !== day) { state.day = day; state.dayCount = 0; }
    if (state.dayCount >= config.maxRequestsPerProjectPerDay) return skip(scope, state, file, 'daily-limit');

    const requestId = randomUUID();
    const startedAt = now();
    state.dayCount += 1;
    state.lastRequestAt = startedAt;
    state.lastSkipReason = undefined;
    save(file, state);
    audit(scope, { event: 'requested', requestId, model: config.model, provider: config.provider, upstreamHost: config.modelUpstreamHost, packetFingerprint: fingerprint, materialMode: config.packet.mode }, startedAt);

    let result;
    try {
      result = await requestStage({ config, packet, apiKey, fetcher });
    } catch (error) {
      state.failures = Math.min(state.failures + 1, 16);
      const delay = Math.min(config.backoffMs * 2 ** Math.max(0, state.failures - 1), config.maxBackoffMs);
      state.backoffUntil = now() + delay;
      save(file, state);
      audit(scope, { event: 'error', requestId, code: errorCode(error, 'model-error'), message: redact(error.message).slice(0, 200), durationMs: now() - startedAt, model: config.model, provider: config.provider });
      return { status: 'error', reason: errorCode(error, 'model-error'), cwd: scope.cwd, requestId };
    }

    if (result.insufficient) {
      state.lastFingerprint = fingerprint;
      state.failures = 0;
      state.backoffUntil = undefined;
      save(file, state);
      audit(scope, { event: 'insufficient', requestId, model: config.model, provider: config.provider, packetFingerprint: fingerprint, usage: result.usage ?? {}, durationMs: now() - startedAt });
      return { status: 'skipped', reason: 'model-insufficient', cwd: scope.cwd, requestId };
    }

    // Recheck awaited telemetry before rereading the local scope; the final
    // scope/packet checks and synchronous record write must have no intervening await.
    const freshSessions = await readSessions();
    const freshObservation = await readObservation(scope);
    if (!freshSessions.ok || !freshObservation.ok) {
      state.lastFingerprint = undefined;
      state.idleSince = null;
      save(file, state);
      audit(scope, { event: 'aborted', reason: 'coverage-lost-during-review', requestId, model: config.model, provider: config.provider });
      return { status: 'aborted', reason: 'coverage-lost-during-review', cwd: scope.cwd, requestId };
    }
    const freshScopes = discoverWorkbenchScopes({ adoptionRoot: config.adoptionRoot });
    const exact = freshScopes.find(candidate => candidate.cwd === scope.cwd && candidate.adoptionId === scope.adoptionId && candidate.charterHash === scope.charterHash);
    if (!exact) {
      state.lastFingerprint = undefined;
      state.idleSince = null;
      state.failures = 0;
      state.backoffUntil = undefined;
      save(file, state);
      audit(scope, { event: 'aborted', reason: 'charter-or-scope-changed', requestId, model: config.model, provider: config.provider });
      return { status: 'aborted', reason: 'charter-or-scope-changed', cwd: scope.cwd, requestId };
    }
    const freshProbe = probeProjectIdle(exact, {
      sessions: freshSessions.sessions,
      observation: freshObservation.observation,
      now: now(),
      workbenchMaxAgeMs: config.workbench?.heartbeatMaxAgeMs ?? 120_000,
    });
    let freshPacket;
    try { freshPacket = buildPacket({ ...exact, packetMode: config.packet.mode, extractFiles: config.packet.extractFiles }, freshProbe, state.idleSince, config.maxPacketChars); }
    catch {
      state.lastFingerprint = undefined;
      state.idleSince = null;
      save(file, state);
      audit(scope, { event: 'aborted', reason: 'packet-unavailable-during-review', requestId, model: config.model, provider: config.provider });
      return { status: 'aborted', reason: 'packet-unavailable-during-review', cwd: scope.cwd, requestId };
    }
    const freshFingerprint = packetFingerprint(exact, freshProbe, freshPacket);
    if (freshProbe.state !== 'idle' || freshFingerprint !== fingerprint) {
      state.lastFingerprint = undefined;
      state.idleSince = null;
      save(file, state);
      audit(scope, { event: 'aborted', reason: 'project-became-dirty', requestId, model: config.model, provider: config.provider });
      return { status: 'aborted', reason: 'project-became-dirty', cwd: scope.cwd, requestId };
    }

    if (closed) {
      state.lastFingerprint = undefined;
      state.idleSince = null;
      save(file, state);
      audit(scope, { event: 'aborted', reason: 'daemon-closed', requestId, model: config.model, provider: config.provider });
      return { status: 'aborted', reason: 'daemon-closed', cwd: scope.cwd, requestId };
    }

    const at = new Date(startedAt).toISOString();
    let recorded;
    try {
      recorded = recorder(exact.cwd, {
        stage: result.stage,
        source: 'idle-stage-review',
        // stage-observer deliberately accepts bounded strings, not free-form
        // objects. These references identify the deterministic idle probe and
        // contain no prompt, response or research extract.
        evidence: [
          'idle-stage-review:request:' + requestId,
          'packet-fingerprint:' + fingerprint,
          'material-mode:' + config.packet.mode,
          'model:' + config.provider + '/' + config.model,
          'joined-sessions:' + freshProbe.evidence.sessions.filter(row => row.joined).length,
          'executions:' + (freshProbe.evidence.executions?.length ?? 0),
          'idle-since:' + state.idleSince,
        ],
        expectedCharterHash: exact.charterHash,
        at,
      });
    } catch (error) {
      state.lastFingerprint = fingerprint;
      state.lastStage = result.stage;
      state.failures = Math.min(state.failures + 1, 16);
      const delay = Math.min(config.backoffMs * 2 ** Math.max(0, state.failures - 1), config.maxBackoffMs);
      state.backoffUntil = now() + delay;
      save(file, state);
      audit(scope, { event: 'stage-record-error', requestId, code: errorCode(error, 'stage-record-error'), message: redact(error.message).slice(0, 200), model: config.model, provider: config.provider, stage: result.stage });
      return { status: 'error', reason: 'stage-record-error', cwd: scope.cwd, requestId };
    }

    state.lastFingerprint = fingerprint;
    state.lastStage = result.stage;
    state.failures = 0;
    state.backoffUntil = undefined;
    save(file, state);
    audit(scope, {
      event: 'classified',
      requestId,
      stage: result.stage,
      changed: recorded?.changed === true,
      recordReason: token(recorded?.reason, 128),
      model: config.model,
      provider: config.provider,
      upstreamHost: config.modelUpstreamHost,
      responseModel: result.responseModel,
      usage: result.usage ?? {},
      packetFingerprint: fingerprint,
      materialMode: config.packet.mode,
      durationMs: now() - startedAt,
    });
    return { status: 'reviewed', stage: result.stage, changed: recorded?.changed === true, cwd: scope.cwd, requestId };
  }

  async function tick() {
    if (closed) return { ok: false, reason: 'closed', results: [] };
    if (ticking) return { ok: false, reason: 'already-ticking', results: [] };
    ticking = true;
    try {
      if (!config.enabled) {
        if (!disabledAudited) {
          disabledAudited = true;
          audit(undefined, { event: 'skipped', reason: 'disabled' });
        }
        return { ok: true, results: [{ status: 'skipped', reason: 'disabled' }] };
      }
      let scopes;
      try { scopes = discoverWorkbenchScopes({ adoptionRoot: config.adoptionRoot }); }
      catch (error) {
        audit(undefined, { event: 'error', code: errorCode(error, 'discovery-failed') });
        return { ok: false, reason: 'discovery-failed', results: [] };
      }
      if (config.projectAllowlist) {
        const allowed = new Set(config.projectAllowlist);
        scopes = scopes.filter(scope => allowed.has(scope.cwd));
      }
      const results = [];
      for (const scope of scopes) {
        if (closed) break;
        try { results.push(await processScope(scope)); }
        catch (error) {
          audit(scope, { event: 'error', code: errorCode(error, 'project-review-failed'), message: redact(error.message).slice(0, 200) });
          results.push({ status: 'error', reason: errorCode(error, 'project-review-failed'), cwd: scope.cwd });
        }
      }
      return { ok: true, results };
    } finally {
      ticking = false;
    }
  }

  function close() {
    if (closed) return;
    closed = true;
    lock.release();
  }

  return { tick, close, config };
}
