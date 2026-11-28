/** Durable parent/child and same-plan peer messages. Transport receipt, processing and reply are independent. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { ResearchSessionError, researchProvenanceOf } from './research-session-service.mjs';

const SCHEMA = 'pi-research-communication.v1';
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const ENDED = new Set(['ended', 'closed', 'archived']);
const TERMINAL = new Set(['completed', 'blocked', 'failed']);
const MAX_MESSAGE_BYTES = 16 * 1024;
const INBOX_BYTES = 24 * 1024;
const fail = (status, code) => { throw new ResearchSessionError(status, 'research-communication-' + code); };
const hash = value => createHash('sha256').update(value).digest('hex');
const sameScope = (a, b) => ['cwd', 'ownerKey', 'charterHash', 'adoptionId'].every(key => a[key] === b[key]);
const text = (value, maximum) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value);

export function createResearchCommunicationStore(directory) {
  directory = path.resolve(directory);
  function ensureDirectory() {
    let cursor = path.parse(directory).root;
    for (const part of directory.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try { fs.mkdirSync(cursor, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = fs.lstatSync(cursor);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail(503, 'store-unsafe');
    }
  }
  return {
    directory,
    readAll() {
      ensureDirectory();
      return fs.readdirSync(directory).filter(name => /^[a-f0-9]{64}\.json$/.test(name)).map(name => {
        const file = path.join(directory, name), fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_MESSAGE_BYTES) fail(503, 'store-unsafe');
          const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
          if (value.schema !== SCHEMA || !ID.test(value.id) || !ID.test(value.from) || !ID.test(value.to)
              || typeof value.fingerprint !== 'string' || hash(value.id) + '.json' !== name) fail(503, 'store-invalid');
          return value;
        } finally { fs.closeSync(fd); }
      });
    },
    write(value) {
      ensureDirectory();
      const file = path.join(directory, hash(value.id) + '.json');
      if (fs.existsSync(file) && (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())) fail(503, 'store-unsafe');
      const serialized = JSON.stringify(value);
      if (Buffer.byteLength(serialized) > MAX_MESSAGE_BYTES) fail(400, 'message-too-large');
      const temporary = file + '.' + randomUUID() + '.tmp';
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try { fs.writeFileSync(fd, serialized); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      try { fs.renameSync(temporary, file); } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      const dir = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    },
  };
}

export function createResearchCommunicationService(deps) {
  const messages = new Map((deps.store?.readAll() ?? []).map(row => [row.id, structuredClone(row)]));
  const now = deps.now ?? (() => new Date());
  let tail = Promise.resolve(), disposed = false;
  const assertOpen = () => { if (disposed) fail(503, 'service-closed'); };
  const serial = fn => { const next = tail.then(fn); tail = next.catch(() => {}); return next; };
  const persist = row => {
    assertOpen(); const copy = structuredClone(row);
    if (!messages.has(copy.id) && Buffer.byteLength(JSON.stringify(copy)) > MAX_MESSAGE_BYTES - 1024) fail(400, 'message-too-large');
    deps.store?.write(copy); messages.set(copy.id, copy); return copy;
  };
  const scopeOf = row => ({ cwd: row.cwd, ownerKey: row.ownerKey, charterHash: row.charterHash, adoptionId: row.adoptionId });
  const projection = row => ({ id: row.id, from: row.from, to: row.to, kind: row.kind, summary: row.summary,
    evidence: row.evidence, status: row.status, replyTo: row.replyTo, createdAt: row.createdAt,
    delivered: !!row.deliveredAt, processed: !!row.processedAt, resolved: !!row.resolvedBy,
    notificationId: row.notificationId, processExitVerified: false,
    ...(row.edgeKind === 'peer' ? { edgeKind: 'peer', sourceTaskId: row.sourceTaskId, sourceRole: row.sourceRole,
      targetPlanId: row.targetPlanId, targetTaskId: row.targetTaskId, deferredToQueued: !!row.deferredToQueued,
      deferred: !row.boundAt && !row.expiredAt, peerSettled: peerSettled(row),
      ...(row.expiredAt ? { expired: true } : {}),
      ...(peerSettled(row) ? { notice: 'Peer assignment ended. Escalate unresolved work to parent.' } : {}) } : {}) });

  function peerContext(verified) {
    const p = researchProvenanceOf(verified.parent);
    const context = deps.getPeerContext?.(verified.parent.id);
    if (!context || !ID.test(p?.dispatchId ?? '') || !ID.test(p?.taskId ?? '')
        || context.plan.id !== p.dispatchId || context.task.taskId !== p.taskId
        || context.plan.parentSessionId !== p.parentSessionId
        || (context.plan.tenureId ?? null) !== (p.tenureId ?? null)) fail(403, 'relationship-invalid');
    if (!sameScope(context.plan, verified)) fail(409, 'scope-mismatch');
    return context;
  }
  const peerTask = (planId, taskId) => deps.getPeerTask?.({ planId, taskId });
  function receivedBy(row, verified) {
    const p = researchProvenanceOf(verified.parent);
    return row.to === verified.parent.id && (row.edgeKind !== 'peer'
      || row.boundAt && row.targetPlanId === p?.dispatchId && row.targetTaskId === p?.taskId
      && row.senderParentId === p?.parentSessionId && (row.tenureId ?? null) === (p?.tenureId ?? null));
  }
  function peerSettled(row) {
    if (row.edgeKind !== 'peer' || row.kind !== 'request' || row.resolvedBy) return false;
    return row.peerSettled === true || [
      [row.sourceTaskId, row.from], [row.targetTaskId, row.boundAt ? row.to : null],
    ].some(([taskId, sessionId]) => {
      const task = peerTask(row.targetPlanId, taskId);
      return task?.state === 'ended' || !!sessionId && ENDED.has(deps.getSession(sessionId)?.status);
    });
  }
  function refreshPeerMessages() {
    for (let row of messages.values()) {
      if (row.edgeKind !== 'peer') continue;
      // Repair the second half of an interrupted durable reply before notifying
      // either endpoint or evaluating retirement.
      const original = row.kind === 'reply' ? messages.get(row.replyTo) : null;
      if (original?.edgeKind === 'peer' && original.kind === 'request' && !original.resolvedBy
          && original.from === row.to && original.to === row.from && sameScope(original, row)
          && original.targetPlanId === row.targetPlanId && original.sourceTaskId === row.targetTaskId
          && original.targetTaskId === row.sourceTaskId) {
        persist({ ...original, resolvedBy: row.id, processedAt: original.processedAt ?? now().toISOString() });
      }
      const target = row.boundAt || row.expiredAt ? null : peerTask(row.targetPlanId, row.targetTaskId);
      if (target?.state === 'ended') {
        row = persist({ ...row, expiredAt: now().toISOString(), processedAt: row.processedAt ?? now().toISOString() });
      } else if (target?.state === 'in_progress' && target.sessionId) {
        const session = deps.getSession(target.sessionId), p = researchProvenanceOf(session);
        if (p?.dispatchId === row.targetPlanId && p.taskId === row.targetTaskId
            && p.parentSessionId === row.senderParentId && (p.tenureId ?? null) === (row.tenureId ?? null)) {
          row = persist({ ...row, to: target.sessionId, boundAt: now().toISOString() });
        }
      }
      if (peerSettled(row) && !row.peerSettled) persist({ ...row, peerSettled: true });
    }
  }
  async function peerReceiver(input, verified, target, exactTaskId) {
    const context = peerContext(verified);
    const byTask = context.peers.find(row => row.taskId === (exactTaskId ?? target));
    const bySession = context.peers.find(row => row.sessionId === target);
    if (!exactTaskId && byTask && deps.getSession(target) && byTask.sessionId !== target) fail(403, 'relationship-invalid');
    const peer = exactTaskId ? byTask : byTask ?? bySession;
    if (!peer || peer.taskId === context.task.taskId || peer.sessionId === verified.parent.id) fail(403, 'relationship-invalid');
    if (context.state === 'ended' || peer.state === 'ended') fail(409, 'peer-ended');
    if (peer.sessionId) {
      let checked;
      try { checked = await deps.authorize({ sessionId: peer.sessionId, principal: input.principal, expiresAt: input.expiresAt }); }
      catch { fail(404, 'recipient-not-found'); }
      assertOpen();
      if (!sameScope(checked, verified)) fail(409, 'scope-mismatch');
      const p = researchProvenanceOf(checked.parent);
      if (p?.dispatchId !== context.plan.id || p.taskId !== peer.taskId
          || p.parentSessionId !== context.plan.parentSessionId
          || (p.tenureId ?? null) !== (context.plan.tenureId ?? null)) fail(403, 'relationship-invalid');
    }
    const fresh = peerContext(verified), current = fresh.peers.find(row => row.taskId === peer.taskId);
    if (fresh.state === 'ended' || current?.state === 'ended') fail(409, 'peer-ended');
    if (!current || current.sessionId !== peer.sessionId) fail(403, 'relationship-invalid');
    return { context: fresh, peer: current };
  }
  async function sendPeer(input, verified, target, kind, evidence, original, broadcast = false) {
    const { context, peer } = await peerReceiver(input, verified, target, original?.sourceTaskId ?? (broadcast ? target : undefined));
    if (original && peer.sessionId !== original.from) fail(403, 'relationship-invalid');
    if (peer.state === 'queued' && (kind === 'request' || kind === 'reply')) fail(409, 'peer-queued');
    if (original && peerSettled(original)) fail(409, 'peer-settled');
    const body = input.body;
    // Eight unicast messages (four request/reply rounds) per unordered task pair.
    // Broadcast fanouts carry no request and do not consume this pair budget.
    const pair = [context.task.taskId, peer.taskId].sort();
    const id = 'message-' + hash(JSON.stringify([scopeOf(verified), verified.parent.id, body.requestId,
      ...(broadcast ? ['peers', peer.taskId] : [])])).slice(0, 48);
    const fingerprint = hash(JSON.stringify([scopeOf(verified), verified.parent.id, context.plan.id, peer.taskId,
      kind, body.summary, evidence, original?.id ?? null, broadcast]));
    let saved = messages.get(id);
    if (saved && saved.fingerprint !== fingerprint) fail(409, 'request-conflict');
    if (original?.resolvedBy && original.resolvedBy !== id) fail(409, 'reply-conflict');
    if (!saved && !broadcast && [...messages.values()].filter(row => row.edgeKind === 'peer' && !row.broadcast
        && row.targetPlanId === context.plan.id && JSON.stringify(row.peerPair) === JSON.stringify(pair)).length >= 8) fail(409, 'peer-loop-limit');
    saved ??= persist({ schema: SCHEMA, id, ...scopeOf(verified), from: verified.parent.id,
      to: peer.sessionId ?? peer.taskId, senderParentId: context.plan.parentSessionId, edgeKind: 'peer',
      sourceTaskId: context.task.taskId, sourceRole: context.task.role, targetPlanId: context.plan.id,
      targetTaskId: peer.taskId, tenureId: context.plan.tenureId ?? null, peerPair: pair,
      ...(broadcast ? { broadcast: true } : {}), ...(peer.state === 'queued' ? { deferredToQueued: true } : {}),
      ...(peer.sessionId ? { boundAt: now().toISOString() } : {}),
      kind, summary: body.summary, evidence, ...(original ? { replyTo: original.id } : {}),
      fingerprint, notificationId: 'research-message-' + id, createdAt: now().toISOString() });
    if (original && !original.resolvedBy) persist({ ...original, resolvedBy: saved.id, processedAt: now().toISOString() });
    return { status: 'ok', tool: 'research_communication', message: projection(saved), persisted: true,
      deferred: !saved.boundAt, targetState: peer.state };
  }
  async function broadcastPeers(input, verified, kind, evidence) {
    if (!['progress', 'decision'].includes(kind)) fail(400, 'kind-invalid');
    const context = peerContext(verified);
    if (context.state === 'ended') fail(409, 'peer-ended');
    const recipients = context.peers.filter(peer => peer.state !== 'ended');
    // Validate the whole audience before writing any fanout. Retried partial disk
    // failures reuse each recipient's deterministic message identity.
    for (const peer of recipients) await peerReceiver(input, verified, peer.taskId, peer.taskId);
    const sent = [];
    for (const peer of recipients) sent.push(await sendPeer(input, verified, peer.taskId, kind, evidence, undefined, true));
    await deliver();
    const activeCount = recipients.filter(peer => peer.state === 'in_progress').length;
    return { status: 'ok', tool: 'research_communication', persisted: true,
      // Count accepted live wakeups separately from persisted active recipients.
      deliveredCount: sent.filter(result => {
        const saved = messages.get(result.message.id);
        return !!(saved?.lastSentAt || saved?.deliveredAt);
      }).length, activeCount,
      queuedCount: recipients.filter(peer => peer.state === 'queued').length,
      skippedEnded: context.peers.length - recipients.length, messages: sent.map(result => ({ id: result.message.id, targetTaskId: result.message.targetTaskId, deferred: result.deferred })) };
  }

  async function authorize(input, retainedReport = false) {
    try { return await deps.authorize(input); }
    catch (error) {
      if (!retainedReport || !deps.authorizeRetainedReport) throw error;
      return deps.authorizeRetainedReport(input);
    }
  }
  async function actor(input) {
    assertOpen();
    if (!input.body || !ID.test(input.body.sessionId ?? '')) fail(400, 'session-invalid');
    const checked = await authorize({ sessionId: input.body.sessionId, principal: input.principal, expiresAt: input.expiresAt }, input.body.action === 'report');
    assertOpen(); return checked;
  }
  async function receiver(input, verified, target, retainedReport = false, allowInactiveChild = false) {
    let other = deps.getSession(target);
    let fromHistory = false;
    if ((!other || ENDED.has(other.status)) && allowInactiveChild) {
      const historic = (deps.history?.() ?? []).find(row => row.id === target);
      if (historic) { other = historic; fromHistory = true; }
    }
    if (!other) fail(404, 'recipient-not-found');
    let checked;
    try {
      if (fromHistory || (allowInactiveChild && ENDED.has(other.status))) {
        checked = deps.verifyHistoricalChild
          ? await deps.verifyHistoricalChild({ parent: other, principal: input.principal, expiresAt: input.expiresAt })
          : await authorize({ sessionId: target, principal: input.principal, expiresAt: input.expiresAt }, true);
      } else {
        checked = await authorize({ sessionId: target, principal: input.principal, expiresAt: input.expiresAt }, retainedReport);
      }
    } catch { fail(404, 'recipient-not-found'); }
    assertOpen();
    if (!sameScope(checked, verified)) fail(409, 'scope-mismatch');
    const from = verified.parent, a = researchProvenanceOf(from), b = researchProvenanceOf(other);
    const parentEdge = a?.parentSessionId === other.id && a.workflowCwd === verified.cwd
      && a.charterHash === verified.charterHash && a.adoptionId === verified.adoptionId;
    const childEdge = b?.parentSessionId === from.id && b.workflowCwd === verified.cwd
      && b.charterHash === verified.charterHash && b.adoptionId === verified.adoptionId;
    if (from.id === other.id || !(parentEdge || childEdge)) fail(403, 'relationship-invalid');
    return checked;
  }
  const hasReport = (token, status = 'completed') => [...messages.values()].some(row => row.kind === 'result' && row.spawnToken === token && row.status === status && !row.resumedBy);
  function childrenPending(verified) {
    return (deps.listSessions?.() ?? []).some(child => {
      const p = researchProvenanceOf(child);
      return p?.parentSessionId === verified.parent.id && p.charterHash === verified.charterHash
        && p.adoptionId === verified.adoptionId
        && !hasReport(p.spawnToken) && !deps.isAssignmentCompleted?.(p.spawnToken);
    }) || deps.childrenPending?.(verified.parent.id) === true;
  }
  function childrenRunning(verified) {
    return (deps.listSessions?.() ?? []).some(child => {
      const p = researchProvenanceOf(child);
      return p?.parentSessionId === verified.parent.id && p.charterHash === verified.charterHash && p.adoptionId === verified.adoptionId
        && (!ENDED.has(child.status) || (child.dataUnavailable && child.live !== false)) && !deps.isAssignmentCompleted?.(p.spawnToken)
        && ![...messages.values()].some(row => row.spawnToken === p.spawnToken && TERMINAL.has(row.status) && !row.resumedBy);
    }) || deps.childrenPending?.(verified.parent.id) === true;
  }
  async function settleResultRelease(saved) {
    if (saved.kind !== 'result' || saved.capacityReleased !== true || saved.resumedBy || saved.capacityReleaseAppliedAt) return saved;
    await deps.releaseSession?.(saved.spawnToken);
    assertOpen();
    return persist({ ...saved, capacityReleasePending: false, capacityReleaseAppliedAt: now().toISOString() });
  }
  const settledAssignmentCommand = () => false;
  function hasOpenParentRequest(sessionId) {
    const session = deps.getSession(sessionId);
    const parentId = researchProvenanceOf(session)?.parentSessionId;
    return [...messages.values()].some(row =>
      row.edgeKind !== 'peer' && row.from === sessionId && row.kind === 'request' && !row.resolvedBy
      && (!parentId || row.to === parentId),
    );
  }
  function clearTerminalReport(spawnToken, reopenedById) {
    if (!spawnToken) return;
    for (const row of messages.values()) {
      if (row.kind === 'result' && row.spawnToken === spawnToken && !row.resumedBy) {
        persist({ ...row, resumedBy: reopenedById });
      }
    }
  }
  async function allowDownwardMessage(verified, checked, kind, body = undefined, triggerReopen = false) {
    const p = researchProvenanceOf(checked.parent);
    if (['request', 'reply', 'decision'].includes(kind) && p?.parentSessionId === verified.parent.id) {
      const childEnded = ENDED.has(checked.parent.status);
      const assignmentNonActive = !!p.spawnToken && (deps.isAssignmentNonActive?.(p.spawnToken) === true || deps.isAssignmentCompleted?.(p.spawnToken) === true);
      const resultReleased = [...messages.values()].some(
        row => row.from === checked.parent.id && row.kind === 'result' && row.capacityReleased === true && !row.resumedBy,
      );
      const resuming = childEnded || assignmentNonActive || resultReleased;
      await deps.beforeResume?.({ parent: verified.parent, verified, child: checked.parent, childVerified: checked, kind, resuming });
      assertOpen();
      if (triggerReopen && p.spawnToken) {
        if (assignmentNonActive || (p.dispatchId && p.taskId && childEnded)) {
          await deps.reopenAssignment?.({
            spawnToken: p.spawnToken,
            childSessionId: checked.parent.id,
            reason: body?.summary,
            verified,
            fromCommunication: true,
          });
          assertOpen();
        } else if (childEnded && checked.parent.sessionFile && deps.resumeSession) {
          await deps.activateSession?.(p.spawnToken, { allowExited: true, session: checked.parent });
          assertOpen();
          const resumed = await deps.resumeSession(checked.parent, { spawnToken: p.spawnToken });
          if (!resumed || resumed.success === false) fail(502, 'resume-failed');
          assertOpen();
        }
      }
    }
  }
  async function deliver() {
    if (disposed) return;
    refreshPeerMessages();
    for (let saved of messages.values()) {
      if (disposed) return;
      // Releasing an already authenticated exact-token result is cleanup, not
      // renewed participation. Repair it even if the former parent was removed
      // or no notification transport is available.
      try { saved = await settleResultRelease(saved); } catch { continue; }
      if (!deps.notifyParent) continue;
      // Checkpoints stay durable for status views without starting a model turn.
      if (saved.kind === 'progress' && saved.edgeKind !== 'peer' || saved.kind === 'result' && saved.status === 'partial' || saved.assignmentReported === true) continue;
      // A durable resume intent is not permission to deliver before capacity
      // admission succeeds. A retry with the same requestId repairs this intent.
      if (saved.resumes?.length && !saved.resumeAppliedAt) continue;
      if (saved.deliveredAt || saved.processedAt || saved.resolvedBy || saved.expiredAt || peerSettled(saved)) continue;
      if (saved.lastSentAt && now().getTime() - Date.parse(saved.lastSentAt) < 30_000) continue;
      const source = deps.getSession(saved.from), target = deps.getSession(saved.to);
      if (!target || ENDED.has(target.status) || target.dataUnavailable) continue;
      try {
        if (saved.edgeKind === 'peer') {
          const principal = deps.principalForSession?.(target) ?? target.principalOwner ?? null;
          const checked = await deps.authorize({ sessionId: target.id, principal, expiresAt: null });
          if (!sameScope(saved, checked)) continue;
          const context = peerContext(checked);
          if (context.plan.id !== saved.targetPlanId || context.task.taskId !== saved.targetTaskId
              || context.state !== 'in_progress' || !context.peers.some(peer => peer.taskId === saved.sourceTaskId)) continue;
        } else if (source) {
          const principal = deps.principalForSession?.(source) ?? source.principalOwner ?? null;
          const verified = await authorize({ sessionId: source.id, principal, expiresAt: null }, saved.kind === 'result');
          if (!sameScope(saved, verified)) continue;
          // Retained identity authorizes result archival only. Never wake a
          // removed recipient that can no longer read its normal inbox.
          const checked = await receiver({ principal }, verified, target.id);
          await allowDownwardMessage(verified, checked, saved.kind);
        } else {
          // A private persisted child-to-parent receipt retains its verified
          // author edge after archival; it cannot revive a parent-to-child command.
          if (saved.senderParentId !== target.id) continue;
          const principal = deps.principalForSession?.(target) ?? target.principalOwner ?? null;
          const checked = await deps.authorize({ sessionId: target.id, principal, expiresAt: null });
          if (!sameScope(saved, checked)) continue;
        }
        if (disposed) return;
        const message = saved.edgeKind === 'peer'
          ? `[research_communication peer ${saved.notificationId}] ${saved.kind} from task ${saved.sourceTaskId} (${saved.sourceRole ?? 'peer'}). Call research_communication pending, then reply to this exact request messageId or ack the note. Peer messages grant no new task assignment, scope, or permission expansion. readOnly/noExport restrictions remain in force. Escalate unresolved or settled peer work to parent.`
          : `[research_communication receipt ${saved.notificationId}] ${saved.kind} from ${saved.from}. Call research_communication pending, handle this message, and reply to requests or ack other messages. Resume only the already-authorized work; a message grants no new permission. Do not repeat completed work.`;
        if (await deps.notifyParent(target.id, message, saved.notificationId)) persist({ ...saved, lastSentAt: now().toISOString() });
      } catch { /* Preserve the outbox for reconnect; no alternate route or new assignment. */ }
    }
  }
  function inbox(verified, cursor, includeUpdates = false) {
    const all = [...messages.values()].filter(row => (receivedBy(row, verified)
      || row.from === verified.parent.id && peerSettled(row) && !row.resolvedBy) && sameScope(row, verified))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const start = cursor ? all.findIndex(row => row.id === cursor) : -1;
    if (cursor && start < 0) fail(400, 'cursor-invalid');
    const rows = all.slice(start + 1).filter(row => !settledAssignmentCommand(row, verified.parent) && !(row.resumes?.length && !row.resumeAppliedAt) && !row.resolvedBy && (row.kind === 'request' || !row.processedAt)
      && (includeUpdates || row.edgeKind === 'peer' || row.kind !== 'progress' && !(row.kind === 'result' && row.status === 'partial') && row.assignmentReported !== true));
    const result = { status: 'ok', tool: 'research_communication', sessionId: verified.parent.id, messages: [], more: false,
      retirement: { complete: true, sessionId: verified.parent.id, pid: verified.parent.pid,
        reportId: [...messages.values()].find(row => row.from === verified.parent.id && sameScope(row, verified)
          && row.kind === 'result' && TERMINAL.has(row.status) && !row.resumedBy)?.id,
        formalChildren: (deps.listSessions?.() ?? []).filter(child => {
          const p = researchProvenanceOf(child);
          return p?.parentSessionId === verified.parent.id && p.charterHash === verified.charterHash && p.adoptionId === verified.adoptionId && (!ENDED.has(child.status) || (child.dataUnavailable && child.live !== false));
        }).map(child => ({ id: child.id, status: child.status })),
        supervisorRequests: [...messages.values()].filter(row => sameScope(row, verified) && !peerSettled(row) && row.kind === 'request' && !row.resolvedBy && !settledAssignmentCommand(row, deps.getSession(row.to))
          && (row.from === verified.parent.id || receivedBy(row, verified))).map(row => row.id) } };
    if (result.retirement.formalChildren.length > 16 || result.retirement.supervisorRequests.length > 16) {
      result.retirement.complete = false;
      result.retirement.formalChildren = result.retirement.formalChildren.slice(0, 16);
      result.retirement.supervisorRequests = result.retirement.supervisorRequests.slice(0, 16);
    }
    for (const row of rows) {
      result.messages.push(projection(row));
      if (Buffer.byteLength(JSON.stringify(result)) > INBOX_BYTES - 256) {
        result.messages.pop(); result.more = true;
        result.nextCursor = result.messages.at(-1)?.id;
        break;
      }
    }
    return result;
  }
  async function handle(input) {
    const verified = await actor(input), body = input.body;
    refreshPeerMessages();
    const allowed = new Set(['sessionId', 'action', 'requestId', 'to', 'kind', 'summary', 'evidence', 'messageId', 'status', 'cursor']);
    if (Object.keys(body).some(key => !allowed.has(key))) fail(400, 'unknown-field');
    if (['pending', 'status'].includes(body.action)) return inbox(verified, body.cursor, body.action === 'status');
    if (body.action === 'ack') {
      const saved = messages.get(body.messageId);
      if (!saved || !receivedBy(saved, verified) || !sameScope(saved, verified)) fail(404, 'message-not-found');
      persist({ ...saved, processedAt: saved.processedAt ?? now().toISOString() });
      return { status: 'ok', tool: 'research_communication', acknowledged: saved.id, replyRequired: saved.kind === 'request' && !saved.resolvedBy && !peerSettled(saved) };
    }
    if (!['send', 'reply', 'report'].includes(body.action) || !ID.test(body.requestId ?? '') || !text(body.summary, 4000)) fail(400, 'message-invalid');
    const evidence = body.evidence ?? [];
    if (!Array.isArray(evidence) || evidence.length > 16 || evidence.some(file => !text(file, 1024)
        || path.isAbsolute(file) || file.startsWith('\\') || file.split(/[\\/]/).includes('..'))) fail(400, 'evidence-invalid');
    let original;
    if (body.action === 'reply') {
      original = messages.get(body.messageId);
      if (!original || original.kind !== 'request' || !receivedBy(original, verified) || !sameScope(original, verified)) fail(404, 'request-not-found');
    }
    if (body.to === 'peers' && body.action === 'reply') fail(403, 'relationship-invalid');
    const p = researchProvenanceOf(verified.parent);
    if (body.action === 'report' && (!p?.parentSessionId || !ID.test(p.spawnToken ?? ''))) fail(400, 'parent-required');
    if (body.action === 'report' && body.to !== undefined && body.to !== 'parent' && body.to !== p.parentSessionId) fail(403, 'report-parent-required');
    const kind = body.action === 'report' ? 'result' : body.action === 'reply' ? 'reply' : body.kind ?? 'progress';
    if (!['progress', 'request', 'decision', 'reply', 'result'].includes(kind)
        || body.action === 'send' && ['reply', 'result'].includes(kind)) fail(400, 'kind-invalid');
    if (body.action === 'send' && body.to === 'peers') return broadcastPeers(input, verified, kind, evidence);
    const target = original?.from ?? (body.to && body.to !== 'parent' ? body.to : p?.parentSessionId);
    if (!target) fail(400, 'parent-required');
    const targetSession = deps.getSession(target) ?? (deps.history?.() ?? []).find(row => row.id === target), targetProvenance = researchProvenanceOf(targetSession);
    const parentAddressed = !original && (body.to === undefined || body.to === 'parent');
    const taskAddressed = !original && !parentAddressed && deps.getPeerContext?.(verified.parent.id)?.peers.some(peer => peer.taskId === target);
    const directEdge = parentAddressed || !taskAddressed && (target === p?.parentSessionId || targetProvenance?.parentSessionId === verified.parent.id);
    if (body.action !== 'report' && (original?.edgeKind === 'peer' || !directEdge && deps.getPeerContext?.(verified.parent.id))) {
      const result = await sendPeer(input, verified, target, kind, evidence, original);
      await deliver();
      return result;
    }
    const allowInactiveChild = body.action === 'send' || body.action === 'reply';
    const checked = await receiver(input, verified, target, body.action === 'report', allowInactiveChild);
    if (body.action === 'report' && !['completed', 'partial', 'blocked', 'failed'].includes(body.status)) fail(400, 'report-invalid');
    if (body.action === 'report' && body.status === 'blocked' && hasOpenParentRequest(verified.parent.id)) fail(409, 'awaiting-parent-reply');
    const resumes = ['request', 'reply', 'decision'].includes(kind) && researchProvenanceOf(checked.parent)?.parentSessionId === verified.parent.id
      ? [...messages.values()].filter(row => row.from === target && row.kind === 'result' && !row.resumedBy).map(row => row.id) : [];
    await allowDownwardMessage(verified, checked, kind, body, true);
    const fingerprint = hash(JSON.stringify([scopeOf(verified), verified.parent.id, target, kind, body.summary, evidence, body.status ?? null, original?.id ?? null]));
    const id = 'message-' + hash(JSON.stringify([scopeOf(verified), verified.parent.id, body.requestId])).slice(0, 48);
    let existing = messages.get(id);
    if (existing && existing.fingerprint !== fingerprint) fail(409, 'request-conflict');
    if (original?.resolvedBy && original.resolvedBy !== id) fail(409, 'reply-conflict');
    if (kind === 'result' && !existing) {
      const terminal = [...messages.values()].find(row => row.kind === 'result' && row.spawnToken === p.spawnToken && TERMINAL.has(row.status) && !row.resumedBy);
      if (terminal && terminal.fingerprint !== fingerprint) fail(409, 'terminal-report-conflict');
      existing ??= terminal;
    }
    if (!existing && body.action === 'report' && body.status === 'completed' && childrenPending(verified)) fail(409, 'children-pending');
    const assignmentReported = body.action === 'report' && p?.dispatchId && p?.taskId && TERMINAL.has(body.status);
    if (assignmentReported) {
      if (!deps.reportAssignment) fail(503, 'dispatcher-unavailable');
      await deps.reportAssignment({ ...input, body: { sessionId: verified.parent.id, action: 'report', status: body.status, summary: body.summary, evidence } });
      assertOpen();
    }
    const releasesCapacity = kind === 'result' && TERMINAL.has(body.status) && !childrenRunning(verified);
    let saved = existing ?? persist({ schema: SCHEMA, id, ...scopeOf(verified), from: verified.parent.id, to: target, senderParentId: p?.parentSessionId,
      kind, summary: body.summary, evidence, ...(body.status ? { status: body.status } : {}),
      ...(assignmentReported ? { assignmentReported: true } : {}),
      ...(original ? { replyTo: original.id } : {}), ...(kind === 'result' ? { spawnToken: p.spawnToken, capacityReleased: releasesCapacity, ...(releasesCapacity ? { capacityReleasePending: true } : {}) } : {}),
      ...(resumes.length ? { resumes } : {}),
      fingerprint, notificationId: 'research-message-' + id, createdAt: now().toISOString() });
    if (assignmentReported && saved.assignmentReported !== true) saved = persist({ ...saved, assignmentReported: true });
    if (saved.resumes?.length && !saved.resumeAppliedAt) {
      const token = researchProvenanceOf(checked.parent)?.spawnToken;
      if (token && saved.resumes.some(reportId => messages.get(reportId)?.capacityReleased === true)) {
        await deps.activateSession?.(token, { allowExited: ENDED.has(checked.parent.status), session: checked.parent });
      }
      assertOpen();
      for (const reportId of saved.resumes) {
        const record = messages.get(reportId);
        if (record && !record.resumedBy) persist({ ...record, resumedBy: saved.id });
      }
      saved = persist({ ...messages.get(saved.id), resumeAppliedAt: now().toISOString() });
    }
    if (original && !original.resolvedBy) persist({ ...original, resolvedBy: id, processedAt: now().toISOString() });
    saved = await settleResultRelease(saved);
    await deliver();
    return { status: 'ok', tool: 'research_communication', message: projection(messages.get(saved.id)), persisted: true,
      ...(kind === 'result' ? { reportReceipt: { id: saved.id, sessionId: saved.from, parentSessionId: saved.to,
        adoptionId: saved.adoptionId, charterHash: saved.charterHash, status: saved.status, persisted: true } } : {}) };
  }
  return {
    handle: input => serial(() => handle(input)), tick: () => serial(deliver),
    bindDeferredPeerMessages: ({ planId, taskId, sessionId }) => serial(async () => {
      const task = peerTask(planId, taskId);
      if (task?.sessionId !== sessionId || task.state !== 'in_progress') return;
      await deliver();
    }),
    expireDeferredPeerMessages: ({ planId, taskId }) => serial(async () => {
      if (peerTask(planId, taskId)?.state !== 'ended') return;
      refreshPeerMessages();
    }),
    acknowledgeReceipt: (sessionId, promptId) => serial(async () => {
      const saved = [...messages.values()].find(row => row.to === sessionId && (row.edgeKind !== 'peer' || row.boundAt) && row.notificationId === promptId);
      if (saved && !saved.deliveredAt) persist({ ...saved, deliveredAt: now().toISOString() });
    }),
    isCompleted: token => [...messages.values()].some(row => row.kind === 'result' && row.spawnToken === token && row.capacityReleased === true && row.capacityReleasePending !== true && !row.resumedBy),
    completedAt: token => {
      let latest = null;
      for (const row of messages.values()) {
        if (row.kind !== 'result' || row.spawnToken !== token || row.capacityReleased !== true || row.capacityReleasePending === true || row.resumedBy) continue;
        const ts = Date.parse(row.capacityReleaseAppliedAt ?? row.createdAt ?? '');
        if (Number.isFinite(ts) && (latest === null || ts > latest)) latest = ts;
      }
      return latest;
    },
    hasOpenRequests: sessionId => [...messages.values()].some(row => row.kind === 'request' && !row.resolvedBy && !row.expiredAt && !peerSettled(row) && (row.from === sessionId || row.to === sessionId) && !settledAssignmentCommand(row, deps.getSession(row.to))),
    hasOpenParentRequest,
    clearTerminalReport: (spawnToken, reopenedById) => clearTerminalReport(spawnToken, reopenedById),
    listForScope: ({ cwd, ownerKey, limit = 60 }) => [...messages.values()]
      .filter(row => row.cwd === cwd && row.ownerKey === ownerKey)
      .sort((a, b) => Date.parse(a.createdAt ?? 0) - Date.parse(b.createdAt ?? 0))
      .slice(-Math.max(1, Math.min(200, Number(limit) || 60)))
      .map(row => ({
        id: row.id,
        from: row.from,
        to: row.to,
        kind: row.kind,
        ...(row.status ? { status: row.status } : {}),
        edgeKind: row.edgeKind === 'peer' ? 'peer' : 'parent-child',
        ...(row.broadcast === true ? { broadcast: true } : {}),
        ...(row.sourceTaskId ? { sourceTaskId: row.sourceTaskId } : {}),
        ...(row.targetTaskId ? { targetTaskId: row.targetTaskId } : {}),
        ...(row.sourceRole ? { sourceRole: row.sourceRole } : {}),
        ...(row.targetPlanId ? { targetPlanId: row.targetPlanId } : {}),
        summary: row.summary,
        evidence: Array.isArray(row.evidence) ? row.evidence.slice(0, 8) : [],
        resolved: !!row.resolvedBy,
        peerSettled: peerSettled(row),
        ...(row.replyTo ? { replyTo: row.replyTo } : {}),
        createdAt: row.createdAt,
      })),
    dispose: () => { disposed = true; },
  };
}
