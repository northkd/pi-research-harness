import path from 'node:path';
import { createResearchSessionService, createResearchSessionStore, ResearchSessionError } from './research-session-service.mjs';
import { createResearchDispatchService, createResearchDispatchStore } from './research-dispatch-service.mjs';
import { createResearchCommunicationService, createResearchCommunicationStore } from './research-communication-service.mjs';
import { createResearchCollaborationService, createResearchCollaborationStore, ResearchCollaborationError } from './research-collaboration-service.mjs';

export * from './research-session-service.mjs';
export * from './research-dispatch-service.mjs';
export * from './research-communication-service.mjs';
export * from './research-collaboration-service.mjs';
export * from './research-dispatch-receipts.mjs';

/** Compose the persisted research services with an authenticated native host. */
export function createResearchServices(deps) {
  if (typeof deps.privateDir !== 'string' || !path.isAbsolute(deps.privateDir)) {
    throw new TypeError('research-services-private-directory-required');
  }
  for (const name of ['getSession', 'listSessions', 'principalForSession', 'verifyParent', 'prepareSpawn', 'spawn', 'beforeLaunch', 'notifyParent', 'isLocalOperator']) {
    if (typeof deps[name] !== 'function') throw new TypeError(`research-services-${name}-required`);
  }

  const managed = !!deps.connection && !!deps.joinParticipant && !!deps.detachParticipant;
  const principalForSession = deps.principalForSession;
  const verifyParent = deps.verifyParent;
  let dispatch;
  let communication;
  let collaboration;

  const sessions = createResearchSessionService({
    store: createResearchSessionStore(path.join(deps.privateDir, 'session-reservations')),
    getSession: deps.getSession,
    listSessions: deps.listSessions,
    verifyParent,
    principalForSession,
    prepareSpawn: deps.prepareSpawn,
    pendingPluginRefRegistry: deps.pendingPluginRefRegistry,
    pendingPrincipalOwnerRegistry: deps.pendingPrincipalOwnerRegistry,
    initialPrompts: deps.initialPrompts,
    spawn: async (cwd, options) => {
      const result = await deps.spawn(cwd, options);
      try { deps.onSpawnResult?.(cwd, result); } catch { /* The host retains its process watchdog. */ }
      return result;
    },
    beforeSpawn: deps.beforeLaunch,
    spawnStrategy: deps.spawnStrategy,
    isCompleted: token => (dispatch?.isCompleted(token) ?? false) || (communication?.isCompleted(token) ?? false),
    isWaitingCoordinator: id => dispatch?.isWaitingCoordinator(id) ?? false,
    isRecoveringSession: session => dispatch?.isRecoveringSession(session) ?? false,
    unregisteredReservations: () => dispatch?.unregisteredReservations() ?? [],
    ...(managed ? {
      getSchedulingPolicy: input => collaboration.getSchedulingPolicy(input),
      assertDispatchAllowed: input => collaboration.assertDispatchAllowed(input),
      acquireSchedulingReservation: input => collaboration.acquireSchedulingReservation(input),
      releaseSchedulingReservation: token => collaboration.releaseSchedulingReservation(token),
    } : {}),
    isLocalOperator: deps.isLocalOperator,
  });

  const authorizeRetainedReport = async input => {
    try { return await sessions.authorize(input); }
    catch (error) {
      if (!managed || !(error instanceof ResearchSessionError) || error.code !== 'research-session-parent-not-joined') throw error;
      const parent = deps.getSession(input.sessionId);
      if (!parent) throw error;
      const access = await deps.accessFor(parent.cwd, { principal: input.principal, expiresAt: input.expiresAt, write: false });
      if (!access.canReadHistory || !(await access.canReadHistory(parent))) throw error;
      await access.revalidate();
      const binding = collaboration.retainedBinding(parent);
      if (!binding) throw error;
      return { parent, ...binding };
    }
  };

  dispatch = createResearchDispatchService({
    store: createResearchDispatchStore(path.join(deps.privateDir, 'dispatch')),
    getSession: deps.getSession,
    listSessions: deps.listSessions,
    authorize: authorizeRetainedReport,
    createSession: sessions.create,
    releaseSession: sessions.release,
    notifyParent: deps.notifyParent,
    beforeLaunch: deps.beforeLaunch,
    ...(managed ? {
      getSchedulingPolicy: input => collaboration.getSchedulingPolicy(input),
      assertDispatchAllowed: input => collaboration.assertDispatchAllowed(input),
    } : {}),
    principalForSession,
  });

  communication = createResearchCommunicationService({
    store: createResearchCommunicationStore(path.join(deps.privateDir, 'communication')),
    getSession: deps.getSession,
    listSessions: deps.listSessions,
    authorize: sessions.authorize,
    releaseSession: sessions.release,
    activateSession: sessions.activate,
    authorizeRetainedReport,
    beforeResume: async ({ parent, verified, child, childVerified }) => {
      if (managed) {
        collaboration.assertDispatchAllowed({ parent, verified });
        collaboration.assertDispatchAllowed({ parent: child, verified: childVerified });
      }
      await deps.beforeLaunch({ parent: child });
    },
    reportAssignment: input => dispatch.handle(input),
    isAssignmentCompleted: token => dispatch.isCompleted(token),
    childrenPending: id => dispatch.isWaitingCoordinator(id),
    notifyParent: deps.notifyParent,
    principalForSession,
  });

  collaboration = createResearchCollaborationService({
    store: createResearchCollaborationStore(path.join(deps.privateDir, 'collaboration')),
    listSessions: deps.history ?? deps.listSessions,
    connection: access => deps.connection ? deps.connection(access) : Promise.reject(new ResearchCollaborationError(503, 'research-collaboration-unavailable')),
    verifySelected: (parent, actor) => verifyParent({ parent, principal: actor.principal, expiresAt: actor.expiresAt }),
    join: (access, sessionId) => deps.joinParticipant ? deps.joinParticipant(access, sessionId) : Promise.reject(new ResearchCollaborationError(503, 'research-collaboration-unavailable')),
    detach: (access, sessionId) => deps.detachParticipant ? deps.detachParticipant(access, sessionId) : Promise.reject(new ResearchCollaborationError(503, 'research-collaboration-unavailable')),
    listPlans: scope => dispatch.listForScope(scope),
    manageQueue: input => dispatch.manageQueue(input),
    suspendSessions: (ids, reason, tenureId) => dispatch.suspendSessions(ids, reason, tenureId),
    isSessionCompleted: token => dispatch.isCompleted(token) || communication.isCompleted(token),
    isRecoveringSession: session => dispatch.isRecoveringSession(session),
    onChanged: () => dispatch.tick(),
    sendMainTask: deps.notifyParent,
  });

  const unsubscribeReceipts = deps.subscribeReceiptAcks?.((sessionId, promptId) => {
    void dispatch.acknowledgeReceipt(sessionId, promptId).catch(() => {});
    void communication.acknowledgeReceipt(sessionId, promptId).catch(() => {});
  });
  let disposed = false;
  return {
    dispatch,
    communication,
    collaboration,
    sessions,
    tick: () => Promise.all([dispatch.tick(), communication.tick()]),
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribeReceipts?.();
      dispatch.dispose();
      communication.dispose();
    },
  };
}
