/** Main-owned production composition. Importing starts no process or service. */
import { realpath, stat } from "node:fs/promises";
import { createScienceBrowserHost, type ScienceBrowserHostDeps } from "@blackbelt-technology/pi-dashboard-browser-plugin/science-host";
import { createScienceHostDaemon } from "@blackbelt-technology/pi-dashboard-server/science-host-daemon";
import { createScienceInstancesHost, openScienceRegistry, type ScienceArtifactSource, type ScienceInstanceDetail, type ScienceObservation, type SciencePartition, type ScienceRegistry, type ScienceRegistryAction, type ScienceRegistryDriver, type ScienceRemoteBinding } from "@blackbelt-technology/pi-dashboard-server/science-registry";
import { type ScienceHostObserver, validHostPartition } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import type { ScienceInstancesHost } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";

export interface ScienceHostArtifactProvider {
  /** Independent code-owned output root; never a client/project JSON path. */
  rootFor(partition: SciencePartition, binding: ScienceRemoteBinding): Promise<string | null>;
  /** Sources for this already-imported task only. Registry verifies and copies their bytes. */
  sourcesFor(binding: ScienceRemoteBinding): Promise<ScienceArtifactSource[]>;
}
export interface ScienceProjectWorkspaceScope {
  partition: SciencePartition;
  projectId: string;
  /** Code-owned project association and fresh owner/canonical cwd authority. */
  revalidate(): Promise<void>;
}
export interface ScienceReadonlyHostDeps {
  registryRoot: string;
  chromePrivateDir: string;
  transportPrivateDir: string;
  /** Fresh owner/cwd/task authority; native availability is checked separately at IO. */
  scope: { partition: SciencePartition; binding: ScienceRemoteBinding; revalidate(): Promise<void> };
  /** Optional exact additional workspace; shares the existing writer/browser/IPC. */
  projectWorkspace?: ScienceProjectWorkspaceScope;
  /** Verified read contract for this already-existing native task. */
  observeBinding(binding: ScienceRemoteBinding): Promise<ScienceObservation>;
  chrome: ScienceBrowserHostDeps["chrome"];
  resolvePage: NonNullable<ScienceBrowserHostDeps["resolvePage"]>;
  prepareSession: NonNullable<ScienceBrowserHostDeps["prepareSession"]>;
  /** Native identity check for browser IO only; registry cache reads stay scope-authorized offline. */
  assertViewRuntime?(): Promise<void>;
  readWebSocket?: ScienceBrowserHostDeps["readWebSocket"];
  onReadUnavailable?: ScienceBrowserHostDeps["onReadUnavailable"];
  artifactProvider?: ScienceHostArtifactProvider;
  observe?: ScienceHostObserver;
}
export interface ScienceReadonlyHost {
  /** Opaque registry record for the existing task. No native IDs on Dashboard wire. */
  instanceId: string;
  observe(): Promise<ScienceInstanceDetail>;
  /** Host startup/operator only; no HTTP/IPC mutation road or automatic retry. */
  collectArtifacts(): Promise<ScienceInstanceDetail>;
  close(): Promise<void>;
}
const bindingKeys = ["projectId", "taskId", "rootFrameId", "frameId"] as const;
const statuses = new Set(["unknown", "running", "completed", "failed", "waiting-approval", "cancelled"]);
const failure = () => new Error("science-host-composition-unavailable");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function snapshotBinding(value: unknown): Readonly<ScienceRemoteBinding> {
  if (!object(value) || Object.keys(value).length !== bindingKeys.length || !bindingKeys.every(key => Object.hasOwn(value, key) && typeof value[key] === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value[key] as string))) throw failure();
  return Object.freeze({ projectId: value.projectId as string, taskId: value.taskId as string, rootFrameId: value.rootFrameId as string, frameId: value.frameId as string });
}
function sameBinding(value: unknown, expected: ScienceRemoteBinding): value is ScienceRemoteBinding {
  return object(value) && Object.keys(value).length === bindingKeys.length && bindingKeys.every(key => Object.hasOwn(value, key) && value[key] === expected[key]);
}
function observed(value: unknown, binding: ScienceRemoteBinding): ScienceObservation {
  if (!object(value)) throw failure();
  const { status, ...selected } = value;
  if (!sameBinding(selected, binding) || !statuses.has(status as string)) throw failure();
  return { ...binding, status: status as ScienceObservation["status"] };
}
function requireProviders(deps: ScienceReadonlyHostDeps) {
  if (typeof deps?.scope?.revalidate !== "function" || typeof deps.observeBinding !== "function" || typeof deps.resolvePage !== "function" || typeof deps.prepareSession !== "function" || typeof deps.chrome?.resolveBinary !== "function") throw failure();
  if (deps.assertViewRuntime !== undefined && typeof deps.assertViewRuntime !== "function") throw failure();
  if (deps.readWebSocket !== undefined && typeof deps.readWebSocket !== "function" || deps.onReadUnavailable !== undefined && typeof deps.onReadUnavailable !== "function") throw failure();
  if (deps.artifactProvider !== undefined && (typeof deps.artifactProvider?.rootFor !== "function" || typeof deps.artifactProvider?.sourcesFor !== "function")) throw failure();
  if (!validHostPartition(deps.scope.partition)) throw failure();
  if (deps.projectWorkspace !== undefined && (!validHostPartition(deps.projectWorkspace.partition) || typeof deps.projectWorkspace.revalidate !== "function" || typeof deps.projectWorkspace.projectId !== "string" || !/^proj_[0-9a-f]{12}$/.test(deps.projectWorkspace.projectId) || Object.hasOwn(deps.projectWorkspace, "binding"))) throw failure();
}
function readonlyDriver(binding: ScienceRemoteBinding, assertScope: () => Promise<void>, observeBinding: ScienceReadonlyHostDeps["observeBinding"], artifacts?: NonNullable<ScienceRegistryDriver["artifacts"]>): ScienceRegistryDriver {
  const unavailable = async (): Promise<never> => { throw failure(); };
  return {
    submit: unavailable, cancel: unavailable, reconcile: unavailable,
    ...(artifacts === undefined ? {} : { artifacts }),
    async observe(selected) {
      if (!sameBinding(selected, binding)) throw failure();
      await assertScope(); const result = observed(await observeBinding({ ...binding }), binding); await assertScope(); return result;
    },
  };
}
function scopedInstances(host: ScienceInstancesHost, instanceId: string): ScienceInstancesHost {
  const refused = () => ({ availability: "unavailable" as const, reason: "binding-unavailable" as const });
  return {
    async list(partition) { const result = await host.list(partition); return result.availability === "ready" ? { availability: "ready", instances: result.instances.filter(row => row.id === instanceId) } : result; },
    detail: (partition, id) => id === instanceId ? host.detail(partition, id) : Promise.resolve(refused()),
    readArtifact: (partition, id, artifactId) => id === instanceId ? host.readArtifact(partition, id, artifactId) : Promise.resolve(refused()),
  };
}

/** One writer, one bound native task, one private browser and one Unix listener. */
export async function createScienceReadonlyHost(deps: ScienceReadonlyHostDeps): Promise<ScienceReadonlyHost> {
  let registry: ScienceRegistry | undefined, browser: ReturnType<typeof createScienceBrowserHost> | undefined, daemon: ReturnType<typeof createScienceHostDaemon> | undefined;
  let closing: Promise<void> | undefined, closed = false;
  const close = () => {
    if (closing !== undefined) return closing;
    closed = true;
    closing = (async () => {
      let failed = false;
      for (const resource of [daemon, browser, registry]) { try { await resource?.close(); } catch { failed = true; } }
      if (failed) throw failure();
    })();
    return closing;
  };
  try {
    requireProviders(deps);
    const partition = Object.freeze({ ...deps.scope.partition }), binding = snapshotBinding(deps.scope.binding);
    const additional = deps.projectWorkspace;
    const projectPartition = additional === undefined ? undefined : Object.freeze({ ...additional.partition });
    const projectId = additional?.projectId, freshProject = additional?.revalidate.bind(additional);
    if (projectPartition && projectPartition.ownerKey === partition.ownerKey && projectPartition.cwd === partition.cwd) throw failure();
    const isProjectPartition = (selected: SciencePartition) => projectPartition !== undefined && selected.ownerKey === projectPartition.ownerKey && selected.cwd === projectPartition.cwd;
    let bindingProject = false;
    const freshGrant = deps.scope.revalidate.bind(deps.scope), observeBinding = deps.observeBinding;
    const rootFor = deps.artifactProvider?.rootFor.bind(deps.artifactProvider), sourcesFor = deps.artifactProvider?.sourcesFor.bind(deps.artifactProvider);
    let importedId: string | undefined;
    const assertViewRuntime = deps.assertViewRuntime?.bind(deps);
    const assertScope = async () => {
      if (closed || await realpath(partition.cwd) !== partition.cwd || !(await stat(partition.cwd)).isDirectory()) throw failure();
      const grant = await freshGrant(); if (grant !== undefined || closed) throw failure();
    };
    const assertProjectScope = async () => {
      if (closed || !projectPartition || !freshProject || await realpath(projectPartition.cwd) !== projectPartition.cwd || !(await stat(projectPartition.cwd)).isDirectory()) throw failure();
      if (await freshProject() !== undefined || closed) throw failure();
    };
    const assert = async (selected: SciencePartition, action: ScienceRegistryAction) => {
      if (isProjectPartition(selected)) {
        if (action.kind !== "view" && !(bindingProject && action.kind === "bind" && action.projectId === projectId && !Object.hasOwn(action, "binding"))) throw failure();
        await assertProjectScope(); return;
      }
      if (selected.ownerKey !== partition.ownerKey || selected.cwd !== partition.cwd) throw failure();
      const bind = action.kind === "bind" && action.projectId === binding.projectId && sameBinding(action.binding, binding);
      const collect = rootFor !== undefined && action.kind === "collect-artifacts" && importedId !== undefined && action.instanceId === importedId && sameBinding(action.binding, binding);
      if (action.kind !== "view" && !bind && !collect) throw failure();
      await assertScope();
    };
    const assertArtifactBinding = async (selected: ScienceRemoteBinding) => { if (importedId === undefined || !sameBinding(selected, binding)) throw failure(); await assertScope(); };
    const artifacts = sourcesFor === undefined ? undefined : async (selected: ScienceRemoteBinding) => {
      await assertArtifactBinding(selected); const result = await sourcesFor({ ...binding }); await assertScope(); return result;
    };
    const artifactRootFor = rootFor === undefined ? undefined : async (selected: SciencePartition, task: ScienceRemoteBinding) => {
      if (selected.ownerKey !== partition.ownerKey || selected.cwd !== partition.cwd) throw failure();
      await assertArtifactBinding(task); const result = await rootFor({ ...partition }, { ...binding }); await assertScope(); return result;
    };
    await assertScope();
    registry = await openScienceRegistry(deps.registryRoot, { authority: { assert }, driver: readonlyDriver(binding, assertScope, observeBinding, artifacts), ...(artifactRootFor === undefined ? {} : { artifactRootFor }) });
    const owned = registry, imported = await owned.bind(partition, binding), instanceId = imported.id;
    importedId = instanceId;
    if (projectPartition && projectId) {
      await assertProjectScope(); bindingProject = true;
      try { await owned.bindProject(projectPartition, projectId); } finally { bindingProject = false; }
      const current = await owned.resolveBinding(projectPartition);
      if (!current || current.projectId !== projectId || Object.hasOwn(current, "binding")) throw failure();
      await current.revalidate();
    }
    const resolveBinding: NonNullable<ScienceBrowserHostDeps["resolveBinding"]> = async (selected, id) => {
      if (isProjectPartition(selected)) {
        if (id !== undefined) return null;
        const current = await owned.resolveBinding(selected);
        if (!current || current.projectId !== projectId || Object.hasOwn(current, "binding")) return null;
        const revalidate = async () => { await current.revalidate(); if (assertViewRuntime !== undefined && await assertViewRuntime() !== undefined) throw failure(); await current.revalidate(); };
        return { ownerKey: current.ownerKey, cwd: current.cwd, projectId: current.projectId, revalidate };
      }
      if (id !== undefined && id !== instanceId) return null;
      const current = await owned.resolveBinding(selected, instanceId);
      if (!current || current.projectId !== binding.projectId || !("binding" in current) || !sameBinding(current.binding, binding)) return null;
      const revalidate = async () => { await current.revalidate(); if (assertViewRuntime !== undefined && await assertViewRuntime() !== undefined) throw failure(); await current.revalidate(); };
      return id === undefined ? { ownerKey: current.ownerKey, cwd: current.cwd, projectId: current.projectId, revalidate } : { ...current, revalidate };
    };
    const readWebSocket = deps.readWebSocket === undefined ? undefined : async (selected: Parameters<NonNullable<ScienceBrowserHostDeps["readWebSocket"]>>[0]) => isProjectPartition(selected) ? null : deps.readWebSocket!(selected);
    browser = createScienceBrowserHost({ privateDir: deps.chromePrivateDir, chrome: deps.chrome, resolveBinding, resolvePage: deps.resolvePage, prepareSession: deps.prepareSession, readWebSocket, onReadUnavailable: deps.onReadUnavailable, observe: deps.observe });
    const originalInstances = scopedInstances(createScienceInstancesHost(owned), instanceId);
    const instancesHost: ScienceInstancesHost = {
      async list(selected) { if (!isProjectPartition(selected)) return originalInstances.list(selected); return await owned.accessFor(selected) ? { availability: "ready", instances: [] } : { availability: "unavailable", reason: "binding-unavailable" }; },
      detail: (selected, id) => isProjectPartition(selected) ? Promise.resolve({ availability: "unavailable", reason: "binding-unavailable" }) : originalInstances.detail(selected, id),
      readArtifact: (selected, id, artifact) => isProjectPartition(selected) ? Promise.resolve({ availability: "unavailable", reason: "binding-unavailable" }) : originalInstances.readArtifact(selected, id, artifact),
    };
    daemon = createScienceHostDaemon({ privateDir: deps.transportPrivateDir, host: browser, instancesHost, accessFor: selected => owned.accessFor(selected), observe: deps.observe });
    await daemon.start(); await assertScope();
    return { instanceId, async observe() { try { await assertScope(); const result = await owned.observe(partition, instanceId); await assertScope(); return result; } catch { throw failure(); } },
      async collectArtifacts() { try { if (rootFor === undefined) throw failure(); await assertScope(); const result = await owned.collectArtifacts(partition, instanceId); await assertScope(); return result; } catch { throw failure(); } }, close };
  } catch { await close().catch(() => {}); throw failure(); }
}
