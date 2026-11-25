/** Main supplies pinned native adapters and fresh authority. Importing starts nothing. */
import type { ScienceBrowserHostDeps, ScienceProjectBinding, ScienceReadWsAccess } from "@blackbelt-technology/pi-dashboard-browser-plugin/science-host";
import { createScienceNativeP0ContractGate, createScienceNativeRegistryDriver, createScienceNativeSessionProvider, createScienceReadWsFilter, type SCIENCE_NATIVE_P0_CONTRACT, SCIENCE_READ_WS_SOURCE_PINS, type ScienceNativeRuntimeContext, type ScienceNativeSessionLease, type ScienceNativeSessionProvider, type ScienceSessionSelection } from "@blackbelt-technology/pi-dashboard-server/science-registry";
import { createScienceReadonlyHost, type ScienceReadonlyHost, type ScienceReadonlyHostDeps, type ScienceProjectWorkspaceScope } from "./science-host-composition.js";

interface PrivateObservation { materialFor(binding: ScienceProjectBinding): unknown | null }
type SessionMaterial = Awaited<ReturnType<ScienceNativeSessionLease["getPrivateSession"]>>;
export interface ScienceNativePageAdapters {
  loadPinnedAssets(): unknown;
  createNativePageResolver(deps: { assets: unknown; getObservation(binding: ScienceProjectBinding): Promise<unknown | null> }): NonNullable<ScienceBrowserHostDeps["resolvePage"]>;
  createPrivateSessionPreparer(deps: { getPrivateSession(binding: ScienceProjectBinding): Promise<SessionMaterial> }): NonNullable<ScienceBrowserHostDeps["prepareSession"]>;
  observeNativeProject(deps: { binding: ScienceProjectBinding; cookies: SessionMaterial["cookies"]; expectedVisibleProjectName: string; assertBoundary(): Promise<boolean> }): Promise<{ observation: PrivateObservation | null }>;
}
export interface ScienceNativeReadonlyHostDeps extends Omit<ScienceReadonlyHostDeps, "observeBinding" | "resolvePage" | "prepareSession" | "assertViewRuntime" | "readWebSocket" | "onReadUnavailable"> {
  projectWorkspace?: ScienceProjectWorkspaceScope & { expectedVisibleProjectName: string };
  /** Used at native IO boundaries; offline failure does not revoke registry cache access. */
  assertCurrentRuntime(): Promise<void>;
  assertObserveContract(expected: typeof SCIENCE_NATIVE_P0_CONTRACT): Promise<void>;
  /** Explicit main-owned proof for the pinned native read stream. Missing keeps WS denied. */
  assertReadWsContract?(expected: typeof SCIENCE_READ_WS_SOURCE_PINS): Promise<void>;
  /** Main's existing synthetic P0 label, used only inside the private observer. */
  expectedVisibleProjectName: string;
  nativePage: ScienceNativePageAdapters;
}
const failure = () => new Error("science-native-orchestration-unavailable");
const keys = ["projectId", "taskId", "rootFrameId", "frameId"] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function sameTask(value: unknown, binding: ScienceReadonlyHostDeps["scope"]["binding"]): boolean {
  return object(value) && Object.keys(value).length === 4 && keys.every(key => Object.hasOwn(value, key) && value[key] === binding[key]);
}
function requireAdapters(deps: ScienceNativeReadonlyHostDeps) {
  if (typeof deps?.scope?.revalidate !== "function" || typeof deps.assertCurrentRuntime !== "function" || typeof deps.assertObserveContract !== "function") throw failure();
  if (deps.assertReadWsContract !== undefined && typeof deps.assertReadWsContract !== "function") throw failure();
  if (deps.artifactProvider !== undefined && (typeof deps.artifactProvider?.rootFor !== "function" || typeof deps.artifactProvider?.sourcesFor !== "function")) throw failure();
  if (!deps.nativePage || !["loadPinnedAssets", "createNativePageResolver", "createPrivateSessionPreparer", "observeNativeProject"].every(key => typeof deps.nativePage[key as keyof ScienceNativePageAdapters] === "function")) throw failure();
  if (typeof deps.expectedVisibleProjectName !== "string" || deps.expectedVisibleProjectName.length < 8 || deps.expectedVisibleProjectName.length > 160 || /[\0\r\n]/.test(deps.expectedVisibleProjectName)) throw failure();
  if (!sameTask(deps.scope.binding, deps.scope.binding)) throw failure();
  if (deps.projectWorkspace !== undefined && (typeof deps.projectWorkspace.revalidate !== "function" || Object.hasOwn(deps.projectWorkspace, "binding") || typeof deps.projectWorkspace.expectedVisibleProjectName !== "string" || deps.projectWorkspace.expectedVisibleProjectName.length < 1 || deps.projectWorkspace.expectedVisibleProjectName.length > 160 || /[\0\r\n]/.test(deps.projectWorkspace.expectedVisibleProjectName))) throw failure();
}
function readStreamAccess(binding: ScienceReadonlyHostDeps["scope"]["binding"], guard: () => Promise<void>, contract: NonNullable<ScienceNativeReadonlyHostDeps["assertReadWsContract"]>, lease: ScienceNativeSessionLease): ScienceReadWsAccess {
  const assertContract = async () => { await guard(); if (await contract(SCIENCE_READ_WS_SOURCE_PINS) !== undefined) throw failure(); await guard(); };
  return {
    assertContract,
    async privateSession() { await assertContract(); const session = await lease.privateSession(); await assertContract(); return session; },
    // Root/bound frame only. No descendant callback until send-time membership expiry is proven.
    createFilter: () => createScienceReadWsFilter({ binding, revalidate: assertContract }),
  };
}

/** Sessions are retained separately for driver reads and private browser proof/bootstrap. */
export async function createScienceNativeReadonlyHost(deps: ScienceNativeReadonlyHostDeps): Promise<ScienceReadonlyHost> {
  let provider: ScienceNativeSessionProvider | undefined, projectProvider: ScienceNativeSessionProvider | undefined, driverLease: ScienceNativeSessionLease | undefined, browserLease: ScienceNativeSessionLease | undefined, projectLease: ScienceNativeSessionLease | undefined, host: ScienceReadonlyHost | undefined;
  let closed = false, epoch = 0, closing: Promise<void> | undefined;
  type Key = "workspace" | "task" | "project-workspace";
  const cached = new Map<Key, { observation: PrivateObservation; until: number; epoch: number }>();
  const flights = new Map<Key, { generation: number; promise: Promise<unknown | null> }>();
  const invalidate = () => { epoch++; cached.clear(); provider?.invalidate(); projectProvider?.invalidate(); };
  const assertGeneration = (generation: number) => { if (closed || epoch !== generation) throw failure(); };
  const releaseSessions = () => {
    let failed = false;
    for (const lease of [driverLease, browserLease, projectLease]) { try { lease?.release(); } catch { failed = true; } }
    for (const owned of [provider, projectProvider]) { try { owned?.close(); } catch { failed = true; } }
    return failed;
  };
  const close = () => {
    if (closing !== undefined) return closing;
    closed = true; epoch++; cached.clear(); const pending = [...flights.values()].map(flight => flight.promise);
    closing = (async () => {
      let failed = false;
      try { await host?.close(); } catch { failed = true; }
      if (releaseSessions()) failed = true;
      await Promise.allSettled(pending);
      if (failed) throw failure();
    })(); return closing;
  };
  try {
    requireAdapters(deps);
    const partition = Object.freeze({ ...deps.scope.partition }), binding = Object.freeze({ ...deps.scope.binding });
    const additional = deps.projectWorkspace;
    const projectPartition = additional === undefined ? undefined : Object.freeze({ ...additional.partition });
    const projectId = additional?.projectId, projectName = additional?.expectedVisibleProjectName, freshProject = additional?.revalidate.bind(additional);
    if (projectPartition && projectPartition.ownerKey === partition.ownerKey && projectPartition.cwd === partition.cwd) throw failure();
    const isProjectSelection = (selected: ScienceSessionSelection) => projectPartition !== undefined && selected.ownerKey === projectPartition.ownerKey && selected.cwd === projectPartition.cwd;
    const freshScope = deps.scope.revalidate.bind(deps.scope), freshRuntime = deps.assertCurrentRuntime.bind(deps), contract = deps.assertObserveContract.bind(deps), readContract = deps.assertReadWsContract?.bind(deps);
    const artifactProvider = deps.artifactProvider === undefined ? undefined : Object.freeze({ rootFor: deps.artifactProvider.rootFor.bind(deps.artifactProvider), sourcesFor: deps.artifactProvider.sourcesFor.bind(deps.artifactProvider) });
    const page = deps.nativePage, visibleName = deps.expectedVisibleProjectName;
    const guardScope = async () => {
      try { if (closed || await freshScope() !== undefined || closed) throw failure(); }
      catch { invalidate(); throw failure(); }
    };
    const guard = async () => {
      try { await guardScope(); if (await freshRuntime() !== undefined || closed) throw failure(); await guardScope(); }
      catch { invalidate(); throw failure(); }
    };
    const guardProjectScope = async () => {
      try { if (closed || !freshProject || await freshProject() !== undefined || closed) throw failure(); }
      catch { invalidate(); throw failure(); }
    };
    const guardProject = async () => {
      try { await guardProjectScope(); if (await freshRuntime() !== undefined || closed) throw failure(); await guardProjectScope(); }
      catch { invalidate(); throw failure(); }
    };
    const guardViewRuntime = async () => {
      try { if (closed || await freshRuntime() !== undefined || closed) throw failure(); }
      catch { invalidate(); throw failure(); }
    };
    const checkSelection = (selected: ScienceSessionSelection) => {
      if (selected && isProjectSelection(selected)) {
        if (selected.projectId !== projectId || selected.binding !== undefined) throw failure();
        return;
      }
      if (!selected || selected.ownerKey !== partition.ownerKey || selected.cwd !== partition.cwd || selected.projectId !== binding.projectId || selected.binding !== undefined && !sameTask(selected.binding, binding)) throw failure();
    };
    const guardSelection = async (selected: ScienceProjectBinding) => {
      try { checkSelection(selected); const currentGuard = isProjectSelection(selected) ? guardProject : guard; await currentGuard(); if (typeof selected.revalidate !== "function" || await selected.revalidate() !== undefined) throw failure(); await currentGuard(); checkSelection(selected); }
      catch { invalidate(); throw failure(); }
    };
    const snapshotSelection = (selected: ScienceProjectBinding): ScienceProjectBinding => isProjectSelection(selected)
      ? Object.freeze({ ...projectPartition!, projectId: projectId!, revalidate: selected.revalidate.bind(selected) })
      : Object.freeze({ ...partition, projectId: binding.projectId, ...(selected.binding === undefined ? {} : { binding }), revalidate: selected.revalidate.bind(selected) });
    const scope = { partition, binding, revalidate: guardScope };
    await guardScope();
    provider = createScienceNativeSessionProvider({ scope, assertCurrentRuntime: guard, assertScope: async selected => { checkSelection(selected); await guardScope(); } });
    driverLease = provider.retain(); browserLease = provider.retain();
    const projectWorkspace = projectPartition === undefined ? undefined : { partition: projectPartition, projectId: projectId!, revalidate: guardProjectScope };
    if (projectWorkspace) {
      await guardProjectScope();
      projectProvider = createScienceNativeSessionProvider({ scope: projectWorkspace, assertCurrentRuntime: guardProject, assertScope: async selected => { checkSelection(selected); if (!isProjectSelection(selected)) throw failure(); await guardProjectScope(); } });
      projectLease = projectProvider.retain();
    }
    const gate = createScienceNativeP0ContractGate({
      assertControlledReceipt: async (action, expected) => { if (action !== "observe" || await contract(expected) !== undefined) throw failure(); },
      assertCurrentRuntime: guard,
      assertLiveScope: async (action, context) => { if (action !== "observe" || context.projectId !== binding.projectId || !sameTask(context.binding, binding)) throw failure(); await guard(); },
    });
    const assertObserve = async (action: string, context: ScienceNativeRuntimeContext) => {
      if (action !== "observe" || context.projectId !== binding.projectId || !sameTask(context.binding, binding)) throw failure();
      await gate.assertCapability("observe", context);
    };
    const driver = createScienceNativeRegistryDriver({ runtime: { assertCapability: assertObserve }, privateSession: () => driverLease!.privateSession() });
    const getPrivateSession = async (selected: ScienceProjectBinding) => {
      try { await guardSelection(selected); const lease = isProjectSelection(selected) ? projectLease! : browserLease!; const material = await lease.getPrivateSession(snapshotSelection(selected)); await guardSelection(selected); return material; }
      catch { invalidate(); throw failure(); }
    };
    const observerBoundary = async (selected: ScienceProjectBinding, generation: number) => {
      try { await guardSelection(selected); return !closed && epoch === generation; } catch { return false; }
    };
    const observePage = async (selected: ScienceProjectBinding, key: Key, generation: number) => {
      const session = await getPrivateSession(selected);
      const result = await page.observeNativeProject({ binding: selected, cookies: session.cookies, expectedVisibleProjectName: isProjectSelection(selected) ? projectName! : visibleName, assertBoundary: () => observerBoundary(selected, generation) });
      const observation = result?.observation;
      if (!observation || typeof observation.materialFor !== "function" || !await observerBoundary(selected, generation)) throw failure();
      const material = observation.materialFor(selected);
      if (!material) throw failure();
      await guardSelection(selected); assertGeneration(generation);
      cached.set(key, { observation, until: performance.now() + 60_000, epoch: generation }); return material;
    };
    const getObservation = async (selected: ScienceProjectBinding) => {
      await guardSelection(selected); const key: Key = isProjectSelection(selected) ? "project-workspace" : selected.binding === undefined ? "workspace" : "task", generation = epoch;
      const previous = cached.get(key);
      if (previous && previous.epoch === generation && performance.now() < previous.until) {
        const material = previous.observation.materialFor(selected); if (!material) throw failure(); await guardSelection(selected); assertGeneration(generation); return material;
      }
      cached.delete(key);
      const running = flights.get(key); if (running !== undefined) { assertGeneration(running.generation); return running.promise; }
      const pending = observePage(snapshotSelection(selected), key, generation).catch(() => { invalidate(); throw failure(); }); flights.set(key, { generation, promise: pending });
      void pending.finally(() => { if (flights.get(key)?.promise === pending) flights.delete(key); }).catch(() => {}); return pending;
    };
    const assets = page.loadPinnedAssets();
    const resolve = page.createNativePageResolver({ assets, getObservation }), prepare = page.createPrivateSessionPreparer({ getPrivateSession });
    if (typeof resolve !== "function" || typeof prepare !== "function") throw failure();
    const readWebSocket = readContract === undefined ? undefined : async (selected: ScienceProjectBinding) => {
      if (isProjectSelection(selected)) return null;
      await guardSelection(selected); const generation = epoch, snapshot = snapshotSelection(selected);
      const revalidate = async () => { await guardSelection(snapshot); assertGeneration(generation); };
      return readStreamAccess(binding, revalidate, readContract, browserLease!);
    };
    host = await createScienceReadonlyHost({ registryRoot: deps.registryRoot, chromePrivateDir: deps.chromePrivateDir, transportPrivateDir: deps.transportPrivateDir, chrome: deps.chrome, observe: deps.observe, scope, projectWorkspace, assertViewRuntime: guardViewRuntime, readWebSocket, onReadUnavailable: invalidate, artifactProvider,
      observeBinding: async selected => { try { await guard(); const generation = epoch, result = await driver.observe(selected); await guard(); assertGeneration(generation); return result; } catch { invalidate(); throw failure(); } },
      resolvePage: async selected => { try { await guardSelection(selected); const generation = epoch, result = await resolve(selected); await guardSelection(selected); assertGeneration(generation); if (!result) throw failure(); return result; } catch { invalidate(); return null; } },
      prepareSession: async (selected, session) => { try { await guardSelection(selected); const generation = epoch, result = await prepare(selected, session); await guardSelection(selected); assertGeneration(generation); if (result !== true) throw failure(); return true; } catch { invalidate(); return false; } },
    });
    await guardScope();
    const owned = host;
    return { instanceId: owned.instanceId, async observe() { try { await guardScope(); const result = await owned.observe(); await guardScope(); return result; } catch { invalidate(); throw failure(); } },
      async collectArtifacts() { try { await guardScope(); const result = await owned.collectArtifacts(); await guardScope(); return result; } catch { throw failure(); } }, close };
  } catch { await close().catch(() => {}); throw failure(); }
}
