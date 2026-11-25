import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as wait } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { assertLegacyHostStopped, readLocalHostConfig } from '../config.mjs';
import { sessionHeader } from '../session-host/files.mjs';
import { createGrantAuthority } from '../compat/grants/index.mjs';

function requireProof(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

const retryCauses = new Map([
  ['ECONNREFUSED', 'econnrefused'], ['ECONNRESET', 'econnreset'], ['EPIPE', 'epipe'],
  ['ETIMEDOUT', 'timeout'], ['ESOCKETTIMEDOUT', 'timeout'],
  ['UND_ERR_CONNECT_TIMEOUT', 'connect-timeout'], ['UND_ERR_SOCKET', 'socket-closed'],
  ['rollout-https-ca-not-ready', 'ca-not-ready'],
]);

function retryCause(error) {
  if (error?.name === 'TimeoutError') return 'timeout';
  return retryCauses.get(error?.cause?.code) ?? retryCauses.get(error?.code);
}

function safeFailure(error, prefix) {
  if (/^[a-z0-9-]{1,160}$/.test(error?.code ?? '')) return error;
  const known = new Map([
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'certificate-name-mismatch'], ['CERT_HAS_EXPIRED', 'certificate-expired'],
    ['CERT_NOT_YET_VALID', 'certificate-not-yet-valid'], ['DEPTH_ZERO_SELF_SIGNED_CERT', 'certificate-untrusted'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'certificate-untrusted'], ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'certificate-untrusted'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'certificate-untrusted'],
    ['ENOENT', 'configuration-missing'], ['EACCES', 'configuration-unreadable'], ['EPERM', 'configuration-unreadable'],
  ]);
  const reason = known.get(error?.code) ?? (['unsafe-research-host-file', 'invalid-research-host-config', 'invalid-research-host-token'].includes(error?.message)
    ? error.message : error instanceof SyntaxError ? 'response-invalid' : 'request-failed');
  return Object.assign(new Error(prefix + '-' + reason), { code: prefix + '-' + reason });
}

/** Retry connection establishment only; an identity, auth or certificate failure is final. */
export async function waitForOperationalReadiness(operation, { timeoutMs = 60_000, now = () => performance.now(), sleep = wait,
  code = 'rollout-host-startup' } = {}) {
  const deadline = now() + timeoutMs;
  let lastCause = 'not-ready';
  for (;;) {
    const remaining = Math.ceil(deadline - now());
    requireProof(remaining > 0, code + '-timeout-' + lastCause);
    try { return await operation(remaining); }
    catch (error) {
      const cause = retryCause(error);
      if (!cause) throw safeFailure(error, code);
      lastCause = cause;
    }
    const delay = Math.min(250, Math.max(0, deadline - now()));
    if (delay > 0) await sleep(delay);
  }
}

function localClient(port, token, { fetchFn = globalThis.fetch } = {}) {
  return async (route, expected = 200, timeoutMs = 8000) => {
    const result = await fetchFn('http://127.0.0.1:' + port + route, {
      headers: { 'x-pi-local-token': token }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    });
    requireProof(result.status === expected, 'rollout-operational-api-unconfirmed');
    try { return await result.json(); }
    catch (error) { if (error instanceof SyntaxError) requireProof(false, 'rollout-operational-response-invalid'); throw error; }
  };
}

function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
const query = (key, value) => '?' + new URLSearchParams({ [key]: value });
const identity = file => {
  const info = fs.statSync(file, { bigint: true });
  return [info.dev, info.ino, info.size, info.mtimeNs, info.ctimeNs].join(':');
};
const binding = value => ({
  adopted: value.adopted, adoptionId: value.adoptionId ?? null,
  status: value.status, boundCharterHash: value.boundCharterHash ?? null,
  currentCharterHash: value.currentCharterHash ?? null,
});

function nativeWriters(plan) {
  const agent = plan.configuration.agentDir;
  const legacy = path.join(plan.homeDir, '.pi/dashboard');
  const candidates = [];
  for (const name of fs.readdirSync('/proc').filter(name => /^[0-9]+$/.test(name))) {
    const directory = '/proc/' + name;
    try {
      if (fs.statSync(directory).uid !== process.getuid()) continue;
      const command = fs.readFileSync(path.join(directory, 'cmdline'), 'utf8').split('\0');
      const pi = command.some(value => /\/(?:pi-coding-agent\/dist\/bundle\/cli\.js|\.bin\/pi|bin\/pi-research)$/.test(value));
      const keeper = command.some(value => value === path.join(plan.hostRoot, 'session-host/keeper.mjs'));
      if (!pi && !keeper) continue;
      const environment = fs.readFileSync(path.join(directory, 'environ'), 'utf8').split('\0');
      if (environment.includes('PI_CODING_AGENT_DIR=' + agent) || environment.includes('PI_RESEARCH_HOST_DIR=' + plan.stateDir)
          || environment.some(row => row.startsWith('PI_DASHBOARD_SOCKET=' + legacy + '/'))) candidates.push(name);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
    }
  }
  return candidates;
}

function activePlanTasks(snapshot) {
  const active = new Set(['queued', 'pending', 'starting', 'spawning', 'running', 'assigned', 'registering', 'dispatching', 'retrying']);
  return (snapshot.plans ?? []).flatMap(plan => plan.tasks ?? []).filter(task => active.has(task.status ?? task.state));
}

/** Read the operational baseline before stopping any legacy service. */
export async function captureLiveBaseline(plan) {
  const legacyRoot = path.join(plan.homeDir, '.pi/dashboard');
  const config = json(plan.sources.legacyConfig);
  const legacyToken = fs.readFileSync(path.join(legacyRoot, 'local/token'), 'utf8').trim();
  const legacy = localClient(config.port, legacyToken);
  const listing = await legacy('/api/sessions');
  requireProof(Array.isArray(listing.data) && listing.data.every(row => row.status === 'ended'), 'rollout-live-legacy-sessions');
  requireProof(nativeWriters(plan).length === 0, 'rollout-live-native-writers');
  const scopes = [];
  for (const cwd of plan.configuration.knownCwds) {
    const search = query('cwd', cwd);
    const [connection, charter, collaboration] = await Promise.all([
      legacy('/api/res-workflow/connection' + search),
      legacy('/api/res-workflow/charter-binding' + search),
      legacy('/api/res-workflow/collaboration' + search),
    ]);
    requireProof(typeof connection.adopted === 'boolean' && Array.isArray(collaboration.plans), 'rollout-workbench-baseline-invalid');
    requireProof(activePlanTasks(collaboration).length === 0, 'rollout-legacy-dispatch-not-settled');
    scopes.push({ cwd, adopted: connection.adopted, charter: binding(charter), planCount: collaboration.plans.length });
  }
  requireProof(scopes.some(scope => scope.adopted), 'rollout-adopted-workbench-unavailable');
  const sessionsDir = plan.configuration.sessionsDir;
  const histories = listing.data.map(row => {
    const relative = typeof row.sessionFile === 'string' && path.relative(sessionsDir, row.sessionFile);
    requireProof(relative && relative !== '..' && !path.isAbsolute(relative) && !relative.startsWith('..' + path.sep), 'rollout-legacy-history-path-unconfirmed');
    const header = sessionHeader(row.sessionFile);
    return { id: row.id, nativeId: header.id, file: row.sessionFile, missingCwd: !fs.existsSync(header.cwd) };
  });
  const candidates = fs.readdirSync(sessionsDir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => {
      const file = path.join(entry.parentPath, entry.name);
      return { file, bytes: fs.statSync(file).size };
    }).sort((a, b) => b.bytes - a.bytes);
  let largest;
  for (const candidate of candidates) {
    try { largest = { ...candidate, ...sessionHeader(candidate.file), identity: identity(candidate.file) }; break; }
    catch { /* An invalid file is not a native session witness. */ }
  }
  requireProof(largest?.id && largest.bytes > 0, 'rollout-native-history-witness-unavailable');
  const grantStore = plan.configuration.accessGrantsFile;
  const grants = grantStore ? createGrantAuthority({ storeFile: grantStore, home: plan.homeDir }).list().length : 0;
  return { scopes, largest, grants, sessions: listing.data.length, histories };
}

async function liveClient(plan, dependencies = {}) {
  let config;
  try { config = (dependencies.readConfig ?? readLocalHostConfig)(plan.stateDir); }
  catch (error) { throw safeFailure(error, 'rollout-host'); }
  const api = localClient(config.port, config.token, dependencies);
  return waitForOperationalReadiness(async remaining => {
    const health = await api('/api/health', 200, Math.min(8000, remaining));
    requireProof(health.service === 'pi-research-host' && health.success === true, 'rollout-health-identity-mismatch');
    return api;
  }, { ...dependencies, timeoutMs: dependencies.startupTimeoutMs ?? 60_000 });
}

function publicChallenge(plan, remaining, dependencies) {
  const site = new URL(plan.publicAddress);
  let ca;
  try { ca = (dependencies.readCa ?? fs.readFileSync)(path.join(plan.tlsStorage.data, 'pki/authorities/local/root.crt')); }
  catch (error) {
    if (error.code === 'ENOENT') requireProof(false, 'rollout-https-ca-not-ready');
    throw safeFailure(error, 'rollout-https-ca');
  }
  return new Promise((resolve, reject) => {
    const request = (dependencies.httpsGet ?? https.get)({
      hostname: '127.0.0.1', servername: site.hostname, port: site.port,
      headers: { host: site.host }, path: '/api/health', ca, timeout: Math.min(6000, remaining),
    }, response => {
      response.resume();
      try {
        requireProof(response.statusCode === 401 && /^basic\b/i.test(response.headers['www-authenticate'] ?? ''), 'rollout-https-challenge-unconfirmed');
        resolve();
      } catch (error) { reject(error); }
    });
    request.on('timeout', () => request.destroy(Object.assign(new Error('rollout-https-timeout'), { code: 'ETIMEDOUT' })));
    request.on('error', reject);
  });
}

export function liveVerification(plan, baseline, dependencies = {}) {
  return {
    async assertNativeQuiescent() {
      assertLegacyHostStopped(plan.configuration.legacyHostPidFile);
      requireProof(nativeWriters(plan).length === 0, 'rollout-native-writer-still-running');
      return { ok: true, evidence: ['legacy PID and local native writer identities are absent'] };
    },
    async verifyHealth({ publicReady = false }) {
      await liveClient(plan, dependencies);
      if (publicReady) await waitForOperationalReadiness(remaining => publicChallenge(plan, remaining, dependencies), {
        ...dependencies, timeoutMs: dependencies.startupTimeoutMs ?? 60_000, code: 'rollout-https-startup',
      });
      return { ok: true, evidence: ['standalone loopback health authenticated',
        ...(publicReady ? ['same HTTPS certificate authority and anonymous Basic Auth challenge'] : [])] };
    },
    async verifyProofs() {
      const api = await liveClient(plan, dependencies);
      const { largest, scopes, histories } = baseline;
      const listing = (await api('/api/sessions')).data;
      requireProof(Array.isArray(listing) && listing.every(row => !row.live), 'rollout-new-session-list-unconfirmed');
      const indexed = new Map(listing.map(row => [row.id, row.sessionFile]));
      for (const history of histories) {
        if (!indexed.has(history.nativeId)) {
          const archived = (await api('/api/sessions/archived/' + history.nativeId)).data?.item;
          requireProof(archived?.id === history.nativeId && archived.sessionFile === history.file && archived.archived === true && !archived.live,
            'rollout-legacy-history-archive-unconfirmed');
        } else requireProof(indexed.get(history.nativeId) === history.file, 'rollout-legacy-history-index-incomplete');
        if (history.id !== history.nativeId) {
          const previousIdentity = (await api('/api/sessions/' + history.id)).data;
          requireProof(previousIdentity?.id === history.nativeId && previousIdentity.sessionFile === history.file, 'rollout-legacy-history-link-unverified');
        }
        if (history.missingCwd) {
          const archived = (await api('/api/sessions/' + history.nativeId + '/transcript?limit=1')).data;
          requireProof(archived?.entries?.length > 0, 'rollout-legacy-history-without-workspace-unavailable');
        }
      }
      const selected = (await api('/api/sessions/' + largest.id)).data;
      requireProof(selected?.id === largest.id && selected.sessionFile === largest.file && identity(largest.file) === largest.identity,
        'rollout-native-history-identity-changed');
      const page = (await api('/api/sessions/' + largest.id + '/transcript?limit=20')).data;
      requireProof(page?.entries?.length === 20 && typeof page.nextCursor === 'string', 'rollout-native-history-page-unverified');
      const next = (await api('/api/sessions/' + largest.id + '/transcript?limit=20&cursor=' + encodeURIComponent(page.nextCursor))).data;
      requireProof(next?.entries?.length > 0, 'rollout-native-history-cursor-unverified');
      for (const scope of scopes) {
        const search = query('cwd', scope.cwd);
        const [connection, charter, dispatch] = await Promise.all([
          api('/api/res-workflow/connection' + search), api('/api/res-workflow/charter-binding' + search),
          api('/api/res-workflow/collaboration' + search),
        ]);
        requireProof(connection.adopted === scope.adopted && JSON.stringify(binding(charter)) === JSON.stringify(scope.charter)
          && dispatch.plans?.length === scope.planCount && activePlanTasks(dispatch).length === 0, 'rollout-workbench-preservation-unconfirmed');
      }
      const grants = await api('/api/access/grants');
      const models = await api('/api/models');
      const auth = await api('/api/provider-auth/status');
      requireProof(grants.data?.pathGrants?.length === baseline.grants && models.data?.length > 0 && auth && typeof auth === 'object',
        'rollout-access-and-models-unverified');
      const cliScope = scopes.find(scope => scope.adopted);
      const invocation = { encoding: 'utf8', timeout: 9000, maxBuffer: 1_048_576, stdio: ['ignore', 'pipe', 'pipe'] };
      let cli;
      try {
        const version = execFileSync(plan.targets.launcher, ['--version'], invocation).trim();
        requireProof(/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version), 'rollout-native-cli-version-unverified');
        const output = execFileSync(plan.targets.launcher, ['host', 'status', '--cwd', cliScope.cwd, '--json'], invocation);
        cli = JSON.parse(output);
      } catch (error) { throw safeFailure(error, 'rollout-cli-status'); }
      requireProof(cli?.cwd === cliScope.cwd && cli.adopted === true, 'rollout-cli-status-unverified');
      return { ok: true, evidence: [
        histories.length + ' legacy session files and original history links verified, including the largest transcript cursor',
        scopes.length + ' workbench bindings and dispatch summaries retained',
        baseline.grants + ' directory grants, native model catalogue and CLI status verified',
      ] };
    },
    async verifyRestart({ adapter }) {
      const unit = 'pi-research-host.service';
      const before = await adapter.serviceState(unit);
      await adapter.stop(unit);
      await adapter.start(unit);
      const api = await liveClient(plan, dependencies), after = await adapter.serviceState(unit);
      const state = await api('/api/sessions/' + baseline.largest.id);
      requireProof(before.mainPid > 0 && after.mainPid > 0 && before.mainPid !== after.mainPid && state.data?.sessionFile === baseline.largest.file,
        'rollout-restart-unconfirmed');
      return { ok: true, evidence: ['new host process restarted and resolves the original session identity'] };
    },
    async quiesceNewSessions({ installed }) {
      if (installed && fs.existsSync(plan.targets.config) && fs.existsSync(plan.targets.token)) {
        const config = readLocalHostConfig(plan.stateDir);
        try {
          const sessions = await localClient(config.port, config.token)('/api/sessions');
          requireProof(sessions.data?.every(row => !row.live), 'rollout-rollback-live-sessions');
        } catch (error) {
          if (error.code || error.cause?.code !== 'ECONNREFUSED') throw error;
        }
      }
      requireProof(nativeWriters(plan).length === 0, 'rollout-rollback-native-writers');
      return { ok: true, evidence: ['no live replacement session or native writer to discard'] };
    },
  };
}
