import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createResearchApi } from './api.mjs';
import { assertLegacyHostStopped, initializeLocalHost, hostStateDir, privateDirectory, readLocalHostConfig, ROLLOUT_PAUSE_FILE } from './config.mjs';
import { authenticateRequest, createHostHttpServer, fail } from './http.mjs';
import { createSessionHost } from './session-host/index.mjs';
import { createWorkbench } from './workbench/index.mjs';
import { createWorkbenchSyncProcess } from './workbench/sync-process.mjs';
import { createWorkbenchPolicies } from './workbench/policies/index.mjs';
import { createResWorkflowService, isResearchCharterBindingUpdate } from './adoption/index.mjs';
import { createResearchServices, ResearchSessionError } from './services/index.mjs';
import { createResearchRetirementService } from './services/retirement.mjs';
import { createSupplementalRuntime } from './supplemental/index.mjs';
import { createAutomationSpawner, supplementalSessionId } from './supplemental/automation-spawn.mjs';
import { createScienceApi } from './science/index.mjs';
import { createSessionCompatibility } from './compat/session.mjs';
import { createRealtimeAdapter } from './compat/realtime/index.mjs';
import { createLocalSessionMcp } from './compat/mcp-host.mjs';
import { createFileCompatibility } from './compat/files/index.mjs';
import { createAcpHost, createAcpSessionFacade } from './compat/acp/index.mjs';
import { createGrantAuthority, createNativeGrantTransport } from './compat/grants/index.mjs';
import { createBrowserGrantRoutes } from './compat/grants/browser.mjs';
import { createWorkspaceDirectories } from './compat/workspaces.mjs';
import { createModelConfigApi } from './compat/model-config.mjs';
import { createNativeControlClient } from './compat/native-control-client.mjs';
import { atomicJson, maybeJson, sameProcess } from './session-host/files.mjs';
import { createPiTrustMirror, readWorktreeTrust } from './compat/pi-trust/index.mjs';
import { createQuestionRuntime } from './supplemental/questions/index.mjs';
import { createThinkingTranslationApi } from './compat/thinking-translation.mjs';
import { createSettingsReload } from './compat/settings-reload.mjs';
import { createHistoryCompatibility, isDetachedNativeHistory } from './compat/history.mjs';
import { createProviderApi } from './compat/providers/index.mjs';
import { createProviderAuthApi } from './compat/provider-auth/index.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LOCAL_OPERATOR = Object.freeze({ iss: 'urn:pi-dashboard:local-operator', sub: 'local-operator' });

function defaultNativeRoots() {
  return fs.readdirSync(os.tmpdir(), { withFileTypes: true }).flatMap(entry => {
    if (!entry.isDirectory() || !entry.name.startsWith('pi-subagents-')) return [];
    const directory = path.join(os.tmpdir(), entry.name);
    try {
      return fs.lstatSync(directory).uid === process.getuid() ? [path.join(directory, 'async-subagent-runs')] : [];
    } catch { return []; }
  }).slice(0, 32);
}

export async function createResearchHost(config, options = {}) {
  assertLegacyHostStopped(config.legacyHostPidFile);
  const pauseFile = path.join(config.stateDir, ROLLOUT_PAUSE_FILE);
  const rolloutPaused = () => fs.existsSync(pauseFile);
  const researchLoopRoot = config.researchLoopRoot ?? path.resolve(HERE, '../research-loop');
  const privateDir = privateDirectory(config.workbenchDir ?? path.join(config.stateDir, 'res-workflow'));
  const accessModeStoreDir = config.accessModeStoreDir ?? path.join(config.stateDir, 'research-access-modes');
  const taskPermissionStoreDir = config.taskPermissionStoreDir ?? path.join(config.stateDir, 'research-task-permissions');
  const agentDir = config.agentDir ?? path.join(os.homedir(), '.pi/agent');
  const home = options.workerEnv?.HOME ?? os.homedir();
  const onDiagnostic = options.onDiagnostic ?? (() => {});
  const isLocalOperator = principal => principal === LOCAL_OPERATOR;
  let workbench;
  const native = createSessionHost({
    stateDir: path.join(config.stateDir, 'session-host'),
    sessionsDir: config.sessionsDir,
    piCommand: config.piCommand,
    piArgs: config.piArgs,
    extensionPath: path.join(HERE, 'native-extension.mjs'),
    onDiagnostic,
    env: {
      ...options.workerEnv,
      PI_CODING_AGENT_DIR: agentDir,
      PI_RESEARCH_LOOP_ROOT: researchLoopRoot,
      PI_RESEARCH_HOST_DIR: config.stateDir,
      PI_RESEARCH_WORKBENCH_DIR: privateDir,
      PI_RESEARCH_ACCESS_MODE_STORE_DIR: accessModeStoreDir,
      PI_RESEARCH_TASK_PERMISSION_STORE_DIR: taskPermissionStoreDir,
      PI_RESEARCH_HOST_MANAGED: '1',
      PI_RESEARCH_HOST_TRUST_ACTIVATION: '1',
      ...(config.enableMcp === true ? { PI_RESEARCH_HOST_MCP: '1' } : {}),
      NODE_OPTIONS: ((options.workerEnv?.NODE_OPTIONS ?? process.env.NODE_OPTIONS ?? '') + ' --max-old-space-size=1536 --max-semi-space-size=8').trim(),
      PI_SKIP_VERSION_CHECK: '1',
      PI_TELEMETRY: '0',
    },
    onRegistered: (id, registration, rawRef) => workbench.registerSpawn(id, registration, rawRef),
    ...options.sessionHost,
  });
  const acp = config.acpAgents?.length ? createAcpHost({
    stateDir: path.join(config.stateDir, 'acp'), agents: config.acpAgents, settings: config.acp,
    authorize: (_action, _resource, principal) => principal === LOCAL_OPERATOR,
    onDiagnostic,
    ...options.acp,
  }) : undefined;
  const sessions = acp ? createAcpSessionFacade({ native, acp, principal: LOCAL_OPERATOR, onDiagnostic }) : native;
  let trust, workspaceDirectories;
  const grants = createGrantAuthority({
    storeFile: config.accessGrantsFile ?? path.join(config.stateDir, 'access-grants.json'), home,
    onChanged() {
      try { trust?.refresh(); }
      catch { onDiagnostic('pi-trust-state-write-unavailable'); }
    },
  });
  if (config.piTrustMirror) {
    trust = createPiTrustMirror({
      home, getConfig: () => config.piTrustMirror,
      snapshotFile: config.piTrustMirrorSnapshotFile ?? path.join(config.stateDir, 'legacy/pi-trust-mirror.json'),
      overridesFile: config.piTrustMirrorOverridesFile ?? path.join(config.stateDir, 'legacy/pi-trust-overrides.json'),
      listPinned: () => workspaceDirectories.pinned(), listWorkspaceFolders: () => [],
      listWorktreeTrust: () => readWorktreeTrust(path.join(agentDir, 'worktree-init-trust.json')),
      listPersistedGrants: () => grants.list().filter(entry => entry.scope === 'project'),
      warn: () => onDiagnostic('pi-trust-state-unavailable'),
    });
  }
  workspaceDirectories = createWorkspaceDirectories({
    stateDir: config.stateDir, home, pinnedDirectories: config.knownCwds, listSessions: sessions.listSessions,
    grantSubjects: () => grants.subjects({ persistedOnly: true }),
    trust,
  });
  const knownCwds = () => [...new Set([...workspaceDirectories.known(), ...sessions.listSessions().map(row => row.cwd)])];
  const beforeLaunch = options.beforeLaunch ?? (async ({ parent }) => {
    const file = config.mainlineCore ?? path.resolve(HERE, '../mainline-supervision/src/core.mjs');
    const { MainlineStore } = await import(pathToFileURL(file).href);
    if (!(new MainlineStore(parent.cwd)).resourceGate().ok) throw new ResearchSessionError(409, 'research-session-resource-budget-unavailable');
  });
  workbench = await createWorkbench({
    ...sessions, researchLoopRoot, privateDir, isLocalOperator, localOperatorPrincipal: LOCAL_OPERATOR,
    knownCwds: workspaceDirectories.known,
    sessionRoots: [config.sessionsDir],
  });
  const adoption = createResWorkflowService({
    ...options.adoption,
    privateDir, researchLoopRoot, history: sessions.listSessions, historyRoots: () => [config.sessionsDir],
    joinParticipant: workbench.join,
  });
  workbench.setConnection(adoption.connection);
  workbench.setSnapshot(adoption.snapshot);
  const principalForSession = session => session?.principalOwner ?? LOCAL_OPERATOR;
  const services = createResearchServices({
    ...sessions, ...workbench,
    privateDir, isLocalOperator,
    principalForSession,
    spawnStrategy: () => 'headless',
    beforeLaunch,
    joinParticipant: workbench.join,
    detachParticipant: workbench.detach,
  });
  workbench.setParticipationGuard(services.collaboration.assertParticipationAllowed);
  const retirement = createResearchRetirementService({
    privateDir, sessions, communication: services.communication, principalForSession,
    readBinding: row => workbench.verifyParent({ parent: row, principal: principalForSession(row) }),
    requestShutdown: ({ sessionId, pid, reportId }) => {
      if (sessions.getSession(sessionId)?.pid !== pid) fail(409, 'research-retirement-session-changed');
      if (typeof sessions.retireIfIdle !== 'function') fail(409, 'research-retirement-native-guard-unavailable');
      return sessions.retireIfIdle(sessionId, { pid, reportId });
    },
    onDiagnostic,
    ...options.retirement,
  });
  const controls = createWorkbenchPolicies({
    researchLoopRoot, privateDir, connection: adoption.connection,
    accessModeStoreDir,
    taskPermissionStoreDir,
  });
  const policy = {
    has: suffix => Object.hasOwn(controls, suffix.slice(1)) && !!controls[suffix.slice(1)]?.read,
    read: (suffix, access) => controls[suffix.slice(1)].read(access),
    update(suffix, access, body) {
      const entry = controls[suffix.slice(1)];
      if (!entry.validate(body)) fail(400, 'invalid-workbench-control-request');
      return entry.update(access, { ...body, cwd: access.cwd });
    },
  };

  const collectorModule = path.join(researchLoopRoot, 'src/workbench-sync.mjs');
  const { readWorkbenchSyncCheckpoint } = await import(pathToFileURL(collectorModule).href);
  const collectionDir = privateDirectory(path.join(privateDirectory(path.join(config.stateDir, 'workbench-sync')), 'state'));
  const collection = {
    adoptionRoot: privateDir,
    stateDir: collectionDir,
    historyRoots: [config.sessionsDir],
    nativeRoots: config.nativeRoots ?? defaultNativeRoots(),
    agentRoots: [agentDir],
    stageMap: path.join(researchLoopRoot, 'stage-role-skill.json'),
  };
  const collector = createWorkbenchSyncProcess({
    moduleFile: collectorModule, options: collection,
    refreshNativeRoots: config.nativeRoots ? undefined : defaultNativeRoots, onDiagnostic,
  });
  async function observation(access) {
    const connection = await adoption.connection(access);
    if (!connection.adopted) fail(409, 'res-workflow-not-connected');
    const binding = await workbench.charterBinding(access);
    if (binding.status !== 'current' || !binding.adoptionId) fail(409, 'research-workbench-charter-binding-stale');
    const visible = [];
    for (const row of sessions.listSessions()) if (row.cwd === access.cwd && await access.canReadHistory(row)) visible.push(row);
    await access.revalidate();
    const scope = { cwd: access.cwd, adoptionId: binding.adoptionId, charterHash: binding.charterHash ?? binding.currentCharterHash };
    return readWorkbenchSyncCheckpoint({ ...collection, heartbeatAt: collector.heartbeat(scope) }, scope, visible);
  }

  let supplemental, translation;
  const spawnAutomation = createAutomationSpawner({
    createSession: sessions.createSession, importSession: sessions.importSession,
    authorizeCwd: async cwd => !!await workbench.accessFor(cwd, { principal: LOCAL_OPERATOR, write: true }),
    onDiagnostic: () => onDiagnostic('automation-legacy-scope'),
    ...(sessions.startAcp ? { spawnAcp: sessions.startAcp } : {}),
    ...options.automationSpawn,
  });
  async function spawnSupplemental(input) {
    const result = await spawnAutomation(input);
    if (result?.success && !result.duplicate) supplemental.onSessionResolved(result.sessionId, input.pluginRef);
    return result;
  }
  async function emitNativeEvent(id, eventType, data) {
    const event = { eventId: randomUUID(), eventType, data };
    for (let attempt = 0; attempt < 32; attempt++) {
      const result = sessions.emitEventToSession(id, event);
      if (result?.accepted === true) return true;
      if (result?.rejected === true) return false;
      await wait(150);
    }
    return false;
  }
  supplemental = await createSupplementalRuntime({
    dataDir: config.stateDir, getSession: sessions.getSession, listSessions: sessions.listSessions, knownCwds,
    homeDir: home,
    plugins: config.plugins,
    deferBackground: rolloutPaused(),
    authorizeCwd: async (cwd, identity, write) => !!await workbench.accessFor(cwd, { ...identity, write }),
    assignSessionRef: (id, refs) => sessions.updateSession(id, refs),
    async renameSession(id, name) {
      const result = await sessions.command(id, { type: 'set_session_name', name });
      if (result?.success) sessions.updateSession(id, { name });
      return result?.success === true;
    },
    async sendToSession(id, text) {
      if (sessions.getSession(id)?.external) return sessions.notifyParent(id, text, 'request-' + randomUUID());
      const result = await sessions.command(id, { type: 'prompt', message: text, streamingBehavior: 'steer' });
      return result?.success === true;
    },
    emitEventToSession: emitNativeEvent,
    abortSpawnedRun: ({ sessionId, spawnToken }) => {
      const id = sessionId ?? (spawnToken && (sessions.listSessions().find(row => row.spawnToken === spawnToken)?.id ?? supplementalSessionId(spawnToken)));
      const row = id && sessions.getSession(id);
      return row ? sessions.terminate(id) : false;
    },
    spawnSession: spawnSupplemental,
  });
  const questions = createQuestionRuntime({
    dataDir: config.stateDir,
    async authorizeSession(id, _context, write) {
      const row = sessions.getSession(id);
      return row?.live === true && !row.originDeviceId && await authorizeSession(row, write);
    },
    async deliverUiResponse(id, response, meta) {
      if (!['external-native', 'question-native'].includes(meta?.transport)) return sessions.respondUI(id, response);
      const row = sessions.getSession(id);
      if (!row?.live || meta.transport === 'external-native' && !row.external) fail(409, 'native-question-session-changed');
      return { accepted: await emitNativeEvent(id, 'research-host:question-response', { sessionId: id, response }) };
    },
    getConfig: () => config,
    describeSession: id => ({ label: sessions.getSession(id)?.name ?? id }),
    ...options.questions,
  });
  async function respondToUi(id, response) {
    const pending = sessions.getSession(id)?.pendingUIRequests ?? [];
    if (!pending.some(request => request.id === response.id)) fail(409, 'session-ui-request-not-pending');
    questions.reconcile(id, pending);
    const result = await questions.respondNative(id, response, { principal: LOCAL_OPERATOR });
    if (result.statusCode !== 200 || result.body?.data?.transmitted !== true) {
      const code = result.body?.error;
      fail(result.statusCode, /^[a-z0-9-]{1,120}$/.test(code ?? '') ? code : 'session-ui-response-unconfirmed');
    }
    return { accepted: true };
  }
  const browserSessions = {
    ...sessions, respondUI: respondToUi, respondUi: respondToUi,
    async command(id, rpc) {
      const row = sessions.getSession(id);
      if (!row?.external) return sessions.command(id, rpc);
      if (rpc.type === 'set_model') {
        const receipt = await nativeModelControls.apply(row, 'set-model', { provider: rpc.provider, modelId: rpc.modelId });
        return { success: true, data: { provider: receipt.provider, modelId: receipt.modelId, thinkingLevel: receipt.thinkingLevel } };
      }
      if (rpc.type === 'set_thinking_level') {
        const receipt = await nativeModelControls.apply(row, 'set-thinking-level', { level: rpc.level });
        return { success: true, data: { level: receipt.level, requestedLevel: receipt.requestedLevel, clamped: receipt.clamped } };
      }
      if (rpc.type === 'get_commands') {
        const receipt = await nativeModelControls.apply(row, 'list-commands');
        return { success: true, data: { commands: receipt.commands } };
      }
      return sessions.command(id, rpc);
    },
    async abort(id) {
      const row = sessions.getSession(id);
      if (!row?.external) return sessions.abort(id);
      const receipt = await nativeModelControls.apply(row, 'abort');
      return { success: receipt.idle === true, idle: receipt.idle, hasPendingMessages: receipt.hasPendingMessages };
    },
    async terminate(id) {
      const row = sessions.getSession(id);
      if (!row?.external) return sessions.terminate(id);
      const process = row.nativeExternalProcess;
      if (process && !sameProcess(process)) return { stopped: true, workerExited: true, state: 'stopped' };
      const receipt = await nativeModelControls.apply(row, 'shutdown');
      if (receipt.state !== 'shutdown-requested') fail(503, 'external-session-shutdown-unconfirmed');
      if (process) {
        const deadline = Date.now() + 3000;
        while (sameProcess(process) && Date.now() < deadline) await wait(25);
        if (!sameProcess(process)) return { stopped: true, workerExited: true, state: 'stopped' };
      }
      return { requested: true, stopped: false, state: 'stopping' };
    },
  };
  const unsubscribe = sessions.subscribeEvents((sessionId, event) => {
    retirement.onEvent(sessionId, event);
    supplemental.onPiEvent(sessionId, event);
    void questions.onNativeEvent(sessionId, event).catch(() => onDiagnostic('native-question-event-unavailable'));
    if (event.type === 'session_end' || event.type === 'session_ended') {
      supplemental.onSessionEnded(sessionId);
      questions.onSessionEnded(sessionId);
      translation?.forget(sessionId);
    }
  });

  const { readTranscriptEntry, readTranscriptPage } = await import('./transcript.mjs');
  const science = createScienceApi({
    accessFor: (cwd, identity) => workbench.accessFor(cwd, { ...identity, principal: identity?.principal ?? LOCAL_OPERATOR }),
    ...options.science,
  });
  let realtime, mcp;
  const sessionCompatibility = createSessionCompatibility({
    sessions: {
      ...browserSessions,
      async flowControl(sessionId, action) {
        const response = await supplemental.handle({
          method: 'POST', pathname: '/api/plugins/flows/control',
          body: { sessionId, action }, context: { principal: LOCAL_OPERATOR },
        });
        if (response?.body?.success !== true) {
          fail(response?.statusCode ?? 503, response?.body?.error ?? 'flow-effect-unconfirmed');
        }
        return response.body;
      },
    },
    workbench, beforeLaunch, localOperatorPrincipal: LOCAL_OPERATOR,
  });
  const files = createFileCompatibility({
    sessions, workbench, localOperatorPrincipal: LOCAL_OPERATOR, sessionsDir: config.sessionsDir,
    home,
    legacyAttachmentRoots: config.legacyAttachmentRoots ?? [],
    getPinnedDirectories: workspaceDirectories.pinned,
    workspaceDirectories, grants,
  });
  const authenticate = request => authenticateRequest(request, config.token);
  const accessRoutes = createBrowserGrantRoutes({
    grants, workspaceDirectories, authenticate, trust, mirrorConfig: config.piTrustMirror, agentDir,
  });
  async function authorizeSession(row, write) {
    if (!write && isDetachedNativeHistory(row)) return true;
    const access = await workbench.accessFor(row.cwd, { principal: LOCAL_OPERATOR, write });
    await access.revalidate();
    return access.canReadHistory(row);
  }
  const modelDefaultsFile = path.join(config.stateDir, 'model-defaults.json');
  const readModelDefaults = () => ({
    defaultModel: config.defaultModel, defaultThinkingLevel: config.defaultThinkingLevel,
    ...maybeJson(modelDefaultsFile),
  });
  const nativeModelControls = createNativeControlClient({ sessions });
  const managedInstallRoot = config.managedInstallRoot ?? process.env.PI_MANAGED_INSTALL_ROOT ?? path.join(os.homedir(), '.pi/agent/install');
  let providerAuth, modelConfig;
  const invalidateModels = () => {
    modelConfig?.invalidateRuntime();
    providerAuth?.invalidateRuntime();
  };
  async function refreshConnectedModels() {
    invalidateModels();
    const rows = sessions.listSessions().filter(row => row.live && row.status === 'idle'
      && (!row.driver || row.driver === 'pi') && !row.originDeviceId);
    for (const row of rows) await nativeModelControls.apply(row, 'refresh-models');
  }
  const providers = createProviderApi({
    agentDir, port: config.port, origins: config.publicBaseUrls ?? [], onDiagnostic,
    authorize: input => !!input.request && authenticate(input.request),
    invalidateRegistry: invalidateModels, notifySessions: refreshConnectedModels,
    ...options.providers,
  });
  providerAuth = await createProviderAuthApi({
    agentDir, managedInstallRoot, authenticate: request => !!request && authenticate(request),
    readProviders: providers.readProviders, onCredentialsChanged: refreshConnectedModels,
    ...options.providerAuth,
  });
  const settingsReload = createSettingsReload({
    stateDir: config.stateDir, sessions, controls: nativeModelControls, onDiagnostic,
    hasQuestion: id => questions.store.listRows().some(row => row.sessionId === id),
    readRevision: () => modelConfig.settingsRevision(),
  });
  modelConfig = createModelConfigApi({
    agentDir, managedInstallRoot, getSession: sessions.getSession, command: sessions.command,
    authorizeSession: row => authorizeSession(row, false),
    refreshSessionModelRegistry: row => nativeModelControls.apply(row, 'refresh-models', { includeModels: row.external === true }),
    readDefaults: readModelDefaults,
    writeDefaults: partial => atomicJson(modelDefaultsFile, { ...readModelDefaults(), ...partial }),
    reloadConnectedSessions: settingsReload.schedule, getReload: settingsReload.status,
    projectProviderConfigs: providers.nativeConfigs, getDiscoveredModels: providers.getDiscoveredModels,
    ...options.modelConfig,
  });
  translation = createThinkingTranslationApi({
    agentDir, sessions, authorizeSession, authenticate, resolveModel: modelConfig.resolvePhysicalModel,
    broadcast: (id, frame, current) => realtime?.publishTransient(id, frame, current),
  });
  const nativeGrants = createNativeGrantTransport({
    grants, sessions, sessionsDir: config.sessionsDir, home, authenticate,
    authorizeSession: row => authorizeSession(row, true),
    readSessionAccessMode: controls.readSessionAccessMode,
    getConfig: () => config.agentPathGate,
  });
  const route = createResearchApi({
    workbench: { ...workbench, charterBinding: adoption.charterBinding, updateCharterBinding: adoption.updateCharterBinding },
    services, sessions: browserSessions, adoption, policy, observation, supplemental, science, files, accessRoutes, modelConfig,
    sessionCompatibility, questions, respondToUi, hostInstanceId: randomUUID(),
    transcript: (row, args) => readTranscriptPage(row, args, { sessionsDir: config.sessionsDir }),
    transcriptEntry: (row, entryId, args) => readTranscriptEntry(row, entryId, args, { sessionsDir: config.sessionsDir }),
    mintRealtimeTicket: (request, body) => realtime.mintTicket(request, body),
    mintMcpToken: config.enableMcp === true ? id => mcp.mintForSession(id) : undefined,
    validateCharterBinding: isResearchCharterBindingUpdate, localOperatorPrincipal: LOCAL_OPERATOR,
  });
  const history = createHistoryCompatibility({ sessions, sessionsDir: config.sessionsDir, workbench, localOperatorPrincipal: LOCAL_OPERATOR,
    retentionDir: config.legacyRetentionDir,
    isToolInFlight: (id, toolCallId) => {
      const row = sessions.getSession(id);
      return row?.live === true && row.activeToolCalls?.some(call => call.toolCallId === toolCallId && call.phase === 'active');
    },
  });
  const handle = async input => {
    if (input.method !== 'GET' && input.method !== 'HEAD' && rolloutPaused()) fail(503, 'research-host-rollout-paused');
    return await nativeGrants.handle(input) ?? await translation.handle(input)
      ?? await providerAuth.handle(input) ?? await providers.handle(input) ?? await history(input) ?? route(input);
  };
  mcp = createLocalSessionMcp({ sessions, invokeRoute: handle, onDiagnostic });
  const server = createHostHttpServer({ token: config.token, handle, handleMcp: mcp.handle, onError: onDiagnostic });
  realtime = createRealtimeAdapter({
    server, sessions: browserSessions,
    authenticate,
    authorizeSession: (_request, row, write) => authorizeSession(row, write),
    async getMessages(sessionId) {
      const page = await readTranscriptPage(sessions.getSession(sessionId), { limit: 40 }, { sessionsDir: config.sessionsDir });
      return page.entries.flatMap(entry => entry.type === 'message' && entry.message ? [entry.message] : []);
    },
    async handleExtraMessage(message, client) {
      if (message.type.startsWith('science_view_')) return science.handleMessage(message, client.socket);
      if (message.type === 'request_models') {
        client.send(await modelConfig.sessionModels(message.sessionId, LOCAL_OPERATOR));
        return true;
      }
      return supplemental.handleBrowserMessage?.(message, client.socket) ?? false;
    },
    extraMessageTypes: ['science_view_subscribe', 'science_view_unsubscribe', 'science_view_input', 'request_models'],
    onDisconnect: client => science.disconnect(client.socket),
    onError: onDiagnostic,
  });
  let timer;
  let inFlight;
  function tick() {
    if (rolloutPaused()) return;
    supplemental.startBackground();
    void settingsReload.tick();
    collector.tick();
    if (inFlight) return inFlight;
    inFlight = Promise.allSettled([services.tick(), retirement.tick()]).then(results => {
      for (const result of results) if (result.status === 'rejected') onDiagnostic('research-host-tick-unavailable');
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  }

  return {
    server, services, sessions, workbench, adoption, mcp, tick,
    async listen() {
      await tick();
      for (const row of sessions.listSessions()) {
        if (row.live && !row.external) questions.reconcile(row.id, row.pendingUIRequests ?? []);
      }
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(config.port, config.bindHost, () => { server.off('error', reject); resolve(); });
      });
      timer = setInterval(() => void tick(), config.pollMs ?? 2000);
      timer.unref();
      return server.address();
    },
    async close() {
      clearInterval(timer);
      await settingsReload.settle();
      providerAuth.dispose();
      await providers.dispose();
      realtime.dispose();
      mcp.dispose();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      if (inFlight) await inFlight;
      unsubscribe();
      sessionCompatibility.dispose?.();
      nativeGrants.dispose();
      questions.dispose();
      science.dispose();
      supplemental.dispose();
      adoption.dispose();
      retirement.dispose();
      services.dispose();
      await acp?.dispose();
      sessions.close();
      await collector.close();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stateDir = hostStateDir();
  if (process.argv.length === 3 && process.argv[2] === '--init') {
    initializeLocalHost(stateDir);
    console.log('Initialized ' + stateDir);
  } else if (process.argv.length === 2) {
    const config = readLocalHostConfig(stateDir);
    const host = await createResearchHost(config, {
      onDiagnostic: code => {
        if (/^[a-z0-9-]{1,120}$/.test(code)) process.stderr.write('[pi-research-host] ' + code + '\n');
      },
    });
    const address = await host.listen();
    console.log('pi-research-host ready on ' + address.address + ':' + address.port);
    const close = () => { void host.close().catch(() => { process.exitCode = 1; }); };
    process.once('SIGINT', close);
    process.once('SIGTERM', close);
  } else {
    console.error('Usage: node research-host/server.mjs [--init]');
    process.exitCode = 2;
  }
}
