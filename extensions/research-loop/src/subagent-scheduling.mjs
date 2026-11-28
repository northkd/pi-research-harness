/**
 * Native pi-subagents admission. The configured Dashboard owns slots; this
 * adapter owns only an exact native launch attempt and its confirmed disposal.
 * Waiting never creates a model session and never caches a concurrency limit.
 */
import { createHash, randomUUID } from 'node:crypto';
import { readBoundedJson, readDashboardLocalAuth } from './workbench-session-tool.mjs';

const ENDPOINT = '/api/res-workflow/collaboration/native';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ERROR = /^[a-z0-9-]{1,120}$/;
const MAX_RESPONSE_BYTES = 32 * 1024;
const clean = (value, maximum) => typeof value === 'string'
  ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, maximum) : undefined;
const fail = code => { const error = new Error(code); error.code = code; throw error; };
const cancelled = signal => { if (signal?.aborted) fail('research-subagent-launch-cancelled'); };

function wait(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('research-subagent-launch-cancelled')); return; }
    const done = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, milliseconds);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new Error('research-subagent-launch-cancelled')); };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** Test seams are host call options, never accepted from model/tool arguments. */
export async function scheduleResearchSubagent(launch, create, metadata = {}, options = {}) {
  cancelled(launch?.signal);
  const sessionId = launch?.runtime?.parentSessionId;
  if (!ID.test(sessionId ?? '') || typeof launch?.cwd !== 'string' || !launch.cwd) return create();
  const attemptId = (options.randomUUID ?? randomUUID)();
  if (!ID.test(attemptId)) return create();
  // A retry of the HTTP request reuses both IDs. A restarted process receives a
  // new attempt ID and cannot claim an earlier, potentially still live launch.
  const runId = launch?.runtime?.runId;
  const requestId = 'native-' + createHash('sha256').update(JSON.stringify([
    sessionId, launch.cwd, runId || attemptId, launch?.runtime?.childIndex ?? 0,
  ])).digest('hex').slice(0, 48);
  const base = {
    sessionId, requestId, attemptId,
    role: clean(launch.runtime.agent, 128) || 'subagent',
    ...(clean(launch.model, 256) ? { model: clean(launch.model, 256) } : {}),
    ...(clean(metadata.task, 4000) ? { task: clean(metadata.task, 4000) } : {}),
  };
  const resolveAuth = options.resolveAuth ?? readDashboardLocalAuth;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const delay = options.wait ?? wait;
  const timeoutMs = options.timeoutMs ?? 5000;
  const report = code => launch.onExtensionError?.({ extensionPath: '<research-subagent-scheduler>', event: 'admission', error: new Error(code) });
  let token, acquired = false, released = false, launching = false;
  let heartbeatTimer, heartbeatPending = false;

  async function request(action, extra = {}, signal) {
    let auth;
    try { auth = resolveAuth(); } catch { fail('research-subagent-dashboard-unavailable'); }
    const deadline = AbortSignal.timeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(auth.baseUrl + ENDPOINT, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-pi-local-token': auth.token },
        body: JSON.stringify({ ...base, action, ...(token ? { leaseToken: token } : {}), ...extra }),
        signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
      });
    } catch { fail(signal?.aborted ? 'research-subagent-launch-cancelled' : 'research-subagent-admission-unconfirmed'); }
    let result;
    try { result = await readBoundedJson(response, MAX_RESPONSE_BYTES); } catch { fail('research-subagent-admission-invalid-response'); }
    if (!response.ok) fail(ERROR.test(result?.error ?? result?.code ?? '') ? (result.error ?? result.code) : 'research-subagent-admission-refused');
    if (!result || typeof result !== 'object') fail('research-subagent-admission-invalid-response');
    return result;
  }

  function remember(result) {
    if (result.status !== 'acquired') return false;
    if (typeof result.leaseToken !== 'string' || !result.leaseToken || result.leaseToken.length > 256) fail('research-subagent-admission-invalid-response');
    token = result.leaseToken; acquired = true;
    return true;
  }

  async function release() {
    if (released) return;
    if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
    const result = await request('subagent-release');
    if (result.status !== 'released') fail('research-subagent-release-unconfirmed');
    released = true;
  }

  async function cleanupBeforeLaunch() {
    // Cancellation can race a successful acquire whose response never arrived.
    // Recover that SAME attempt's token, never a new lease, then release it.
    try {
      if (!acquired) {
        try { await release(); return; } catch { /* A reserved slot requires its token. */ }
        const result = await request('subagent-acquire');
        if (!remember(result)) { await release(); return; }
      }
      await release();
    } catch { report('research-subagent-release-unconfirmed'); }
  }

  try {
    cancelled(launch.signal);
    const result = await request('subagent-acquire', {}, launch.signal);
    if (result.status === 'unmanaged') {
      cancelled(launch.signal);
      return create(); // Only the server can establish never-joined status.
    }
    if (!remember(result)) {
      // Never gate or queue subagent launches on harness concurrency caps:
      // cancel any queued reservation and launch directly.
      fail(result.status === 'queued' ? 'research-subagent-admission-passthrough' : 'research-subagent-admission-invalid-response');
    }
    cancelled(launch.signal);
    // Recheck current tenure/detachment at the last host boundary before create.
    const confirmation = await request('subagent-heartbeat', { phase: 'launching' }, launch.signal);
    if (confirmation.status !== 'acquired') fail('research-subagent-admission-refused');
    cancelled(launch.signal);
    launching = true;
  } catch (error) {
    await cleanupBeforeLaunch();
    if (launch.signal?.aborted || error?.code === 'research-subagent-launch-cancelled') throw error;
    // Harness admission/availability must never block subagent execution:
    // fall back to direct unmanaged launch whenever dashboard admission refuses, queues, or is unavailable.
    report(error?.code ?? 'research-subagent-admission-passthrough');
    return create();
  }

  let child;
  try { child = await create(); }
  catch (error) {
    // Native factories reject before a usable child is returned. No prompt has
    // been sent by this adapter; a known rejected create can release its slot.
    if (launch.machine) report('research-subagent-launch-outcome-unknown');
    else await cleanupBeforeLaunch();
    throw error;
  }
  if (!child || typeof child.dispose !== 'function') {
    // An invalid factory result is not evidence that no worker exists.
    report('research-subagent-launch-outcome-unknown');
    fail('research-subagent-launch-outcome-unknown');
  }
  let disposal;
  const dispose = child.dispose.bind(child);
  child.dispose = () => {
    disposal ??= (async () => {
      if (heartbeatTimer !== undefined) clearInterval(heartbeatTimer);
      await dispose(); // A failed/unknown disposal must NOT free capacity.
      await release();
    })();
    return disposal;
  };
  try {
    cancelled(launch.signal);
    const result = await request('subagent-heartbeat', {
      phase: 'running', ...(ID.test(child.sessionId ?? '') ? { childSessionId: child.sessionId } : {}),
      ...(clean(child.modelId, 256) ? { model: clean(child.modelId, 256) } : {}),
    }, launch.signal);
    if (result.status !== 'acquired') fail('research-subagent-admission-refused');
  } catch (error) {
    if (launch.signal?.aborted || error?.code === 'research-subagent-launch-cancelled') {
      try { await child.dispose(); } catch { report('research-subagent-release-unconfirmed'); }
      throw error;
    }
    // Post-launch admission/heartbeat failures must never kill or restrict an active subagent.
    report(error?.code ?? 'research-subagent-heartbeat-unconfirmed');
  }
  const heartbeat = async () => {
    if (!launching || released || heartbeatPending) return;
    heartbeatPending = true;
    try { await request('subagent-heartbeat', { phase: 'running', ...(ID.test(child.sessionId ?? '') ? { childSessionId: child.sessionId } : {}) }); }
    catch { report('research-subagent-heartbeat-unconfirmed'); }
    finally { heartbeatPending = false; }
  };
  if (options.heartbeatMs !== 0) {
    heartbeatTimer = setInterval(() => { void heartbeat(); }, options.heartbeatMs ?? 10_000);
    heartbeatTimer.unref?.();
  }
  return child;
}
