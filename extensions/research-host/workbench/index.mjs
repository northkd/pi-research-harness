import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createResWorkflowParticipants, createPendingPluginRefRegistry, resWorkflowAccess } from './core.mjs';
import { ResWorkflowError } from './errors.mjs';
import { ResearchSessionError } from '../services/research-session-service.mjs';

export { ResWorkflowError } from './errors.mjs';

const LOCAL_OWNERS = [JSON.stringify(['host', 'inert-operator']), JSON.stringify(['urn:pi-dashboard:local-operator', 'local-operator'])];
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
const sameOwner = (left, right) => left?.iss === right?.iss && left?.sub === right?.sub;
const validPrincipal = value => object(value) && ['iss', 'sub'].every(key => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 4096);

function rootDirectory(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value || fs.realpathSync(value) !== value || !fs.lstatSync(value).isDirectory()) throw new ResWorkflowError(503, 'research-workbench-directory-unavailable');
  return value;
}

function boundedRead(file, maximum = 256 * 1024) {
  if (fs.realpathSync(file) !== file) throw new ResWorkflowError(503, 'research-workbench-proof-unavailable');
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || before.nlink !== 1 || before.size > maximum) throw new ResWorkflowError(503, 'research-workbench-proof-unavailable');
    const buffer = Buffer.alloc(before.size + 1);
    const bytes = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(descriptor), named = fs.lstatSync(file);
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || named.isSymbolicLink() || named.ino !== before.ino || named.dev !== before.dev) throw new ResWorkflowError(503, 'research-workbench-proof-unavailable');
    const text = buffer.subarray(0, bytes).toString('utf8');
    if (!Buffer.from(text).equals(buffer.subarray(0, bytes))) throw new ResWorkflowError(503, 'research-workbench-proof-unavailable');
    return text;
  } finally { fs.closeSync(descriptor); }
}

/** Preserve confirmed workbench proofs and native session identities across hosts. */
export async function createWorkbench(options) {
  const researchLoopRoot = rootDirectory(options.researchLoopRoot);
  const privateDir = rootDirectory(options.privateDir);
  if (typeof options.getSession !== 'function' || typeof options.listSessions !== 'function') throw new TypeError('workbench session provider required');
  const isLocalOperator = options.isLocalOperator ?? (() => false);
  const isResolverActive = options.isResolverActive ?? (() => true);
  const getSession = options.getSession;
  const listSessions = options.listSessions;
  const updateSession = options.updateSession ?? options.updateSessionMeta;
  if (typeof updateSession !== 'function') throw new TypeError('workbench session update provider required');
  const contextModule = await import(pathToFileURL(path.join(researchLoopRoot, 'src/workbench-context.mjs')).href);
  const charterModule = await import(pathToFileURL(path.join(researchLoopRoot, 'src/charter-binding.mjs')).href);
  if (typeof contextModule.inspectWorkbenchRecordContext !== 'function' || typeof charterModule.readResearchCharterBinding !== 'function') throw new TypeError('workbench native proof verifier unavailable');
  const registry = options.registry ?? createPendingPluginRefRegistry();
  registry.claimPersisted?.(listSessions());
  let connectionProvider = options.connection;
  let snapshotProvider = options.snapshot;
  let participationGuard = options.assertParticipationAllowed;

  const knownCwds = () => [...new Set([
    ...listSessions().filter(row => !row.originDeviceId).map(row => row.cwd),
    ...(options.knownCwds?.() ?? []),
  ].filter(value => typeof value === 'string'))];
  const bindingFor = (cwd, ownerKey) => charterModule.readResearchCharterBinding({ cwd, ownerKey, privateDir });

  async function accessFor(cwd, identity = {}) {
    if (identity.principal != null && !validPrincipal(identity.principal)) throw new ResWorkflowError(404, 'workspace-not-found');
    if (identity.principal?.iss === 'urn:pi-dashboard:local-operator' && !isLocalOperator(identity.principal)) throw new ResWorkflowError(404, 'workspace-not-found');
    const access = await resWorkflowAccess({
      knownCwds, history: listSessions, isResolverActive, isLocalOperator,
      hostPolicy: options.hostPolicy, admitOptions: options.admitOptions,
    }, identity, cwd);
    // Host-local histories used either realm. A named owner keeps its exact realm.
    if (isLocalOperator(identity.principal) && LOCAL_OWNERS.includes(access.ownerKey)) {
      const selected = bindingFor(access.cwd, access.ownerKey);
      if (selected.status === 'not-adopted') {
        const candidates = LOCAL_OWNERS.filter(owner => owner !== access.ownerKey).filter(owner => ['current', 'stale'].includes(bindingFor(access.cwd, owner).status));
        if (candidates.length === 1) return { ...access, ownerKey: candidates[0] };
      }
    }
    return access;
  }

  async function connection(access) {
    await access.revalidate();
    if (connectionProvider) return connectionProvider(access);
    const binding = bindingFor(access.cwd, access.ownerKey);
    if (binding.status === 'unavailable') throw new ResWorkflowError(503, 'research-workbench-proof-unavailable');
    return { cwd: access.cwd, adopted: binding.adopted, ...(binding.adopted ? { adoption: { id: binding.adoptionId, status: 'confirmed', cwd: access.cwd } } : {}) };
  }

  async function snapshot(access) {
    await access.revalidate();
    if (snapshotProvider) return snapshotProvider(access);
    const result = await connection(access);
    const binding = bindingFor(access.cwd, access.ownerKey);
    const research = {};
    if (binding.adopted) research['state.json'] = boundedRead(path.join(access.cwd, '.pi/research-loop/state.json'));
    const participants = [];
    for (const row of listSessions()) {
      const ref = row.pluginRefs?.['res-workflow']?.resWorkflow ?? row.resWorkflow;
      if (row.cwd !== access.cwd || row.originDeviceId || ref?.canonicalCwd !== access.cwd || !await access.canReadHistory(row)) continue;
      participants.push({ sessionId: row.id, status: row.status, joinedAt: ref.joinedAt });
    }
    await access.revalidate();
    return { ...result, binding, research, participants };
  }

  const sessionManager = { get: getSession, update: updateSession };
  const participants = createResWorkflowParticipants({
    sessionManager,
    sessionArchive: {
      getById: id => listSessions().find(row => row.id === id),
      updatePluginRefs: (id, pluginRefs) => updateSession(id, { pluginRefs }),
    },
    metaPersistence: { flush: file => options.flushSessionMeta?.(file) },
    registry, isResolverActive, isLocalOperator, accessFor, connection,
    broadcast: (id, patch) => options.onSessionUpdated?.(id, patch),
    assertParticipationAllowed: input => participationGuard?.(input),
  });

  function assertRetainedReadOnly(sessionId, raw) {
    const row = getSession(sessionId) ?? listSessions().find(item => item.id === sessionId);
    const retained = [row?.researchSession, row?.pluginRefs?.['res-workflow']?.researchSession];
    if (typeof row?.sessionFile === 'string') {
      try {
        const meta = JSON.parse(boundedRead(row.sessionFile.replace(/\.jsonl$/, '.meta.json'), 128 * 1024));
        retained.push(meta.researchSession, meta.pluginRefs?.['res-workflow']?.researchSession);
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (retained.some(value => value?.readOnly === true) && raw?.researchSession && raw.researchSession.readOnly !== true) throw new ResWorkflowError(409, 'research-session-readonly-cannot-relax');
  }

  async function join(access, sessionId, via = 'manual', spawn) {
    if (access.write !== true) throw new ResWorkflowError(403, 'res-workflow-write-required');
    if (spawn) assertRetainedReadOnly(sessionId, spawn);
    return participants.join(access, sessionId, via, spawn);
  }

  async function registerSpawn(sessionId, registration, raw) {
    assertRetainedReadOnly(sessionId, raw);
    // Only the host-private pending-token registry calls this method. Its marker
    // restores the host sentinel after a durable JSON round trip.
    if (raw?.resWorkflowBinding?.hostLocalOperator === true) {
      if (!options.localOperatorPrincipal || !isLocalOperator(options.localOperatorPrincipal) || raw.resWorkflowBinding.identity?.principal?.iss !== 'urn:pi-dashboard:local-operator' || raw.resWorkflowBinding.identity.principal.sub !== 'local-operator') throw new ResWorkflowError(403, 'adoption-identity-expired');
      raw = { ...raw, resWorkflowBinding: { ...raw.resWorkflowBinding, identity: { ...raw.resWorkflowBinding.identity, principal: options.localOperatorPrincipal } } };
    }
    return participants.registerSpawn(sessionId, registration, raw);
  }

  async function prepareSpawn(cwd, identity, verified) {
    const ref = await participants.prepareSpawn(cwd, identity, verified);
    if (isLocalOperator(identity.principal)) {
      if (!isLocalOperator(options.localOperatorPrincipal)) throw new ResWorkflowError(503, 'research-workbench-local-identity-unavailable');
      ref.resWorkflowBinding.hostLocalOperator = true;
    }
    return ref;
  }

  async function verifyParent({ parent, principal, expiresAt }) {
    if (typeof expiresAt === 'number' && Date.now() >= expiresAt) throw new ResearchSessionError(403, 'adoption-identity-expired');
    if (!parent || typeof parent.id !== 'string' || typeof parent.cwd !== 'string' || typeof parent.sessionFile !== 'string') throw new ResearchSessionError(404, 'research-session-parent-not-found');
    let cwd;
    try { cwd = fs.realpathSync(parent.cwd); } catch { throw new ResearchSessionError(404, 'research-session-parent-not-found'); }
    if (cwd !== parent.cwd) throw new ResearchSessionError(404, 'research-session-parent-not-joined');
    if (principal && !isLocalOperator(principal)) {
      if (!sameOwner(parent.principalOwner, principal)) throw new ResearchSessionError(404, 'research-session-parent-not-found');
    } else if (!principal && parent.principalOwner) throw new ResearchSessionError(404, 'research-session-parent-not-found');
    const live = getSession(parent.id);
    const registered = live === parent && ['active', 'idle', 'streaming'].includes(parent.status);
    let inspection;
    try {
      inspection = contextModule.inspectWorkbenchRecordContext({
        cwd,
        sessionManager: {
          getSessionId: () => parent.id,
          getSessionFile: () => parent.sessionFile,
          ...(registered ? { getHeader: () => ({ type: 'session', id: parent.id, cwd }) } : {}),
        },
      }, { privateDir, ...(parent.principalOwner ? { expectedOwnerKey: JSON.stringify([parent.principalOwner.iss, parent.principalOwner.sub]) } : {}) });
    } catch { throw new ResearchSessionError(503, 'research-workbench-proof-unavailable'); }
    if (inspection.status !== 'ready') {
      if (inspection.status === 'not-joined') throw new ResearchSessionError(404, 'research-session-parent-not-joined');
      const code = /^research-workbench-[a-z-]+$/.test(inspection.error ?? '') ? inspection.error : 'research-workbench-proof-unavailable';
      throw new ResearchSessionError(inspection.status === 'unavailable' ? 503 : 409, code);
    }
    const context = inspection.context;
    if (!context || context.sessionId !== parent.id) throw new ResearchSessionError(404, 'research-session-parent-not-joined');
    return { cwd, charterHash: context.charterHash, adoptionId: context.adoptionId, ownerKey: inspection.ownerKey };
  }

  async function charterBinding(access) {
    await access.revalidate();
    return bindingFor(access.cwd, access.ownerKey);
  }

  async function updateCharterBinding(access, request) {
    if (access.write !== true) throw new ResWorkflowError(403, 'res-workflow-write-required');
    await access.revalidate();
    return charterModule.updateResearchCharterBinding({ ...request, cwd: access.cwd, ownerKey: access.ownerKey, privateDir, write: true });
  }

  return {
    accessFor, connection, snapshot, verifyParent, join, detach: participants.detach,
    prepareSpawn, registerSpawn, charterBinding, updateCharterBinding,
    setConnection(provider) { if (typeof provider !== 'function') throw new TypeError('connection provider required'); connectionProvider = provider; },
    setSnapshot(provider) { if (typeof provider !== 'function') throw new TypeError('snapshot provider required'); snapshotProvider = provider; },
    setParticipationGuard(guard) { if (typeof guard !== 'function') throw new TypeError('participation guard required'); participationGuard = guard; },
  };
}
