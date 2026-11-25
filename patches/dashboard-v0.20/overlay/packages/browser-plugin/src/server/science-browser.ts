/** Private project-bound Chrome views. No generic relay/CDP client registration. */
import { realpath } from "node:fs/promises";
import { URL } from "node:url";
import { spawn as realSpawn } from "@blackbelt-technology/pi-dashboard-shared/platform/exec.js";
import { hostFrame, hostRequestId, observeHost, type ScienceHostObserver, type ScienceHostPartitionAccess, validHostInstanceId } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import { isScienceViewInput, type ScienceHostOpenResult, type ScienceHostView, type ScienceViewFrame, type ScienceViewHost, type ScienceViewPartition, type ScienceViewSubscription } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { pipeCall } from "./dedicated/pipe-call.js";
import { buildViewerInputCommands } from "./relay/viewer-input.js";
import { createScienceChrome, type DedicatedChromeDeps } from "./science-chrome.js";
import type { ScienceReadUnavailable, ScienceReadWsAccess } from "./science-read-ws-bridge.js";
import { type ScienceReadResource, startScienceReadonlyProxy } from "./science-readonly-proxy.js";

export interface ScienceProjectBinding extends ScienceHostPartitionAccess { projectId: string; instanceId?: string; binding?: { projectId: string; taskId: string; rootFrameId: string; frameId: string } }
export interface ScienceProjectPage {
  projectId: string;
  entryUrl: string;
  resources: readonly ScienceReadResource[];
  /** Supplied by verified host driver code, never project/client JSON. */
  verifiedProjectScope: true;
  /** In-memory capability from the verified page provider; plain data grants no reads. */
  allowsRead?(method: "GET" | "HEAD", url: string): boolean;
}
export interface SciencePrivateCookie { name: string; value: string; httpOnly?: boolean; secure?: boolean; sameSite?: "Strict" | "Lax" | "None"; expires?: number }
export interface ScienceBrowserHostDeps {
  privateDir: string;
  chrome: Omit<DedicatedChromeDeps, "getDashboardConfigDir">;
  resolveBinding?(partition: ScienceViewPartition, instanceId?: string): Promise<ScienceProjectBinding | null>;
  resolvePage?(binding: ScienceProjectBinding): Promise<ScienceProjectPage | null>;
  /** Private cookie bootstrap completes before navigation/capture. No nonce URL is accepted. */
  prepareSession?(binding: ScienceProjectBinding, session: { setCookies(cookies: readonly SciencePrivateCookie[]): Promise<void> }): Promise<boolean>;
  /** Optional pinned read-stream contract; absent means all native upgrades remain denied. */
  readWebSocket?(binding: ScienceProjectBinding): Promise<ScienceReadWsAccess | null>;
  onReadUnavailable?(reason: ScienceReadUnavailable): void;
  observe?: ScienceHostObserver;
}
interface ContextView {
  contextId: string; targetId: string; sessionId: string; binding: ScienceProjectBinding; entryUrl: string; closed: boolean;
  proxy: Awaited<ReturnType<typeof startScienceReadonlyProxy>>;
  consumers: Set<(frame: ScienceViewFrame) => void>;
  unavailable: Map<(frame: ScienceViewFrame) => void, () => void>;
  latest?: ScienceViewFrame; draining: boolean; geometry?: { deviceWidth: number; deviceHeight: number }; retirement?: Promise<void>;
  revalidate(): Promise<void>;
}
interface AdmittedPage {
  binding: ScienceProjectBinding; pageBinding: ScienceProjectBinding; page: ScienceProjectPage; entry: URL;
  revalidate(): Promise<void>;
}
interface BuildResources { contextId?: string; proxy?: ContextView["proxy"]; row?: ContextView; unavailable?: boolean }
function nativeBinding(value: unknown): ScienceProjectBinding["binding"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>, keys = ["projectId", "taskId", "rootFrameId", "frameId"];
  if (Object.keys(row).length !== keys.length || !keys.every(key => typeof row[key] === "string" && (row[key] as string).length > 0 && (row[key] as string).length <= 512 && !/[\0-\x20\x7f]/.test(row[key] as string))) return null;
  return Object.freeze({ projectId: row.projectId as string, taskId: row.taskId as string, rootFrameId: row.rootFrameId as string, frameId: row.frameId as string });
}
function samePartition(binding: ScienceProjectBinding | null, partition: ScienceViewPartition): binding is ScienceProjectBinding {
  return !!binding && binding.ownerKey === partition.ownerKey && binding.cwd === partition.cwd;
}
function sameBoundTask(current: ScienceProjectBinding, instanceId: string | undefined, snapshot: ScienceProjectBinding["binding"] | null) {
  return !instanceId || current.instanceId === instanceId && JSON.stringify(nativeBinding(current.binding)) === JSON.stringify(snapshot);
}
function validInitialTask(binding: ScienceProjectBinding, instanceId: string | undefined, snapshot: ScienceProjectBinding["binding"] | null) {
  return !instanceId || binding.instanceId === instanceId && !!snapshot && snapshot.projectId === binding.projectId;
}
async function validInitialBinding(binding: ScienceProjectBinding | null, partition: ScienceViewPartition): Promise<boolean> {
  return samePartition(binding, partition) && await realpath(binding.cwd) === binding.cwd && /^[A-Za-z0-9_-]{1,128}$/.test(binding.projectId);
}
function boundPageSnapshot(binding: ScienceProjectBinding, snapshot: ScienceProjectBinding["binding"] | null): ScienceProjectBinding {
  return { ...binding, revalidate: () => binding.revalidate(), ...(snapshot ? { binding: snapshot } : {}) };
}
function pageInScope(page: ScienceProjectPage | null, binding: ScienceProjectBinding): page is ScienceProjectPage {
  return page?.verifiedProjectScope === true && page.projectId === binding.projectId;
}
function pageEntry(page: ScienceProjectPage, binding: ScienceProjectBinding, snapshot: ScienceProjectBinding["binding"] | null, instanceId?: string): URL | null {
  const entry = new URL(page.entryUrl), segments = entry.pathname.split("/");
  if (entry.pathname === "/" || entry.username || entry.password || entry.hash || !segments.includes(binding.projectId)) return null;
  if ([...entry.searchParams.keys()].some(name => /nonce|token|secret|api.?key|authorization/i.test(name))) return null;
  if (!page.resources.some(resource => resource.method === "GET" && resource.url === entry.href)) return null;
  if (instanceId && ![snapshot!.rootFrameId, snapshot!.frameId].some(frameId => segments.includes(frameId))) return null;
  return entry;
}
function checkedCookies(cookies: readonly SciencePrivateCookie[], origin: string) {
  if (cookies.length > 32 || cookies.some(cookie => !cookie.name || cookie.name.length > 128 || cookie.value.length > 4096 || /[\0\r\n]/.test(cookie.name + cookie.value))) throw new Error("science-private-session-unavailable");
  return cookies.map(cookie => ({ name: cookie.name, value: cookie.value, httpOnly: cookie.httpOnly, secure: cookie.secure, sameSite: cookie.sameSite, expires: cookie.expires, url: origin, path: "/" }));
}

export function createScienceBrowserHost(deps: ScienceBrowserHostDeps): ScienceViewHost & { close(): Promise<void> } {
  const spawn = deps.chrome.spawn ?? realSpawn;
  const chrome = createScienceChrome(deps.privateDir, { ...deps.chrome, spawn: (command, args, options) => spawn(command, [...args, "--disable-background-networking", "--disable-component-update", "--disable-default-apps"], options) });
  const views = new Map<string, ContextView>();
  const sessions = new Map<string, ContextView>();
  const opening = new Map<string, Promise<ScienceHostOpenResult>>();
  const retiring = new Set<Promise<void>>();
  let disposed = false, retirementFailed = false;
  const call = async (method: string, params: object, sessionId?: string) => pipeCall(chrome, method, params, { sessionId, timeoutMs: 10000 }) as Promise<Record<string, unknown>>;
  const retireResources = (contextId?: string, proxy?: ContextView["proxy"]) => {
    const retirement = Promise.resolve().then(async () => {
      try { if (contextId) await call("Target.disposeBrowserContext", { browserContextId: contextId }); }
      finally { await proxy?.close(); }
    }).catch(() => { retirementFailed = true; });
    retiring.add(retirement); void retirement.then(() => retiring.delete(retirement));
    return retirement;
  };
  const awaitRetirements = async () => {
    while (retiring.size) await Promise.all([...retiring]);
    if (retirementFailed) throw new Error("science-view-unavailable");
  };
  const closeView = (view: ContextView): Promise<void> => {
    if (view.retirement !== undefined) return view.retirement;
    view.closed = true; view.consumers.clear(); view.latest = undefined; sessions.delete(view.sessionId);
    for (const [key, current] of views) if (current === view) views.delete(key);
    view.retirement = retireResources(view.contextId, view.proxy);
    for (const callback of view.unavailable.values()) { try { callback(); } catch { /* Consumer boundary. */ } } view.unavailable.clear();
    return view.retirement;
  };
  const retireEmptyView = (view: ContextView) => { if (!view.consumers.size) void closeView(view); };
  const removeConsumer = (view: ContextView, consumer: (frame: ScienceViewFrame) => void) => { view.consumers.delete(consumer); view.unavailable.delete(consumer); };
  const deliverFrame = (view: ContextView, frame: ScienceViewFrame) => {
    for (const consumer of [...view.consumers]) {
      try { consumer(frame); } catch { removeConsumer(view, consumer); retireEmptyView(view); }
    }
  };
  async function flush(view: ContextView) {
    if (view.draining) return;
    view.draining = true;
    try {
      while (!view.closed && view.latest && view.consumers.size) {
        const frame = view.latest; view.latest = undefined; await view.revalidate();
        if (!view.closed) deliverFrame(view, frame);
      }
    } catch { await closeView(view); } finally { view.draining = false; }
  }
  const closePopup = (params: Record<string, unknown> | undefined) => {
    const info = params?.targetInfo as { targetId?: string; openerId?: string } | undefined;
    if (info?.targetId && info.openerId && [...views.values()].some(row => row.targetId === info.openerId)) void call("Target.closeTarget", { targetId: info.targetId }).catch(() => {});
  };
  const proxyAuthentication = (view: ContextView, params: Record<string, unknown>) => {
    const challenge = params.authChallenge as { source?: string; origin?: string } | undefined;
    void call("Fetch.continueWithAuth", { requestId: params.requestId, authChallengeResponse: view.proxy.challenge(challenge?.source ?? "", challenge?.origin ?? "") }, view.sessionId).catch(() => closeView(view));
  };
  const receiveFrame = (view: ContextView, params: Record<string, unknown>) => {
    void call("Page.screencastFrameAck", { sessionId: params.sessionId }, view.sessionId).catch(() => {});
    const frame = hostFrame({ jpegBase64: params.data, metadata: params.metadata });
    if (frame && view.consumers.size) { view.geometry = frame.metadata; view.latest = frame; void flush(view); }
  };
  const unsubscribeMessage = chrome.onMessage(value => {
    const message = value as { method?: string; sessionId?: string; params?: Record<string, unknown> };
    if (message.method === "Target.targetCreated") { closePopup(message.params); return; }
    const view = message.sessionId ? sessions.get(message.sessionId) : undefined;
    if (!view || view.closed || !message.params) return;
    switch (message.method) {
      case "Fetch.requestPaused": void call("Fetch.continueRequest", { requestId: message.params.requestId }, view.sessionId).catch(() => closeView(view)); return;
      case "Fetch.authRequired": proxyAuthentication(view, message.params); return;
      case "Page.screencastFrame": receiveFrame(view, message.params); return;
    }
  });
  const unsubscribeExit = chrome.onExit(() => { for (const view of [...views.values()]) void closeView(view); views.clear(); sessions.clear(); });
  const bindingRevalidator = (binding: ScienceProjectBinding, partition: ScienceViewPartition, snapshot: ScienceProjectBinding["binding"] | null, instanceId?: string) => async () => {
    if (disposed || await realpath(binding.cwd) !== binding.cwd) throw new Error("science-binding-unavailable");
    if (await binding.revalidate() !== undefined) throw new Error("science-binding-unavailable");
    const current = await deps.resolveBinding!({ ...partition }, instanceId);
    if (!samePartition(current, partition) || current.projectId !== binding.projectId || !sameBoundTask(current, instanceId, snapshot)) throw new Error("science-binding-unavailable");
    if (await current.revalidate() !== undefined) throw new Error("science-binding-unavailable");
  };
  const admitPage = async (partition: ScienceViewPartition, instanceId?: string): Promise<AdmittedPage | null> => {
    if (disposed || !deps.resolveBinding || !deps.resolvePage || !deps.prepareSession) return null;
    const binding = await deps.resolveBinding({ ...partition }, instanceId);
    if (!await validInitialBinding(binding, partition)) return null;
    const selected = binding!;
    const snapshot = instanceId ? nativeBinding(selected.binding) : null;
    if (!validInitialTask(selected, instanceId, snapshot)) return null;
    const pageBinding = boundPageSnapshot(selected, snapshot);
    if (await selected.revalidate() !== undefined) return null;
    const page = await deps.resolvePage(pageBinding);
    if (!pageInScope(page, selected)) return null;
    const entry = pageEntry(page, selected, snapshot, instanceId);
    if (!entry) return null;
    return { binding: selected, pageBinding, page, entry, revalidate: bindingRevalidator(selected, partition, snapshot, instanceId) };
  };
  const createContext = async (resources: BuildResources, admitted: AdmittedPage, key: string) => {
    const { binding, page, entry, revalidate } = admitted;
    await revalidate(); await chrome.ensureRunning();
    const readWebSocket = typeof deps.readWebSocket === "function" ? await deps.readWebSocket(admitted.pageBinding) : null;
    if (readWebSocket && entry.origin !== "http://127.0.0.1:18765") throw new Error("science-binding-unavailable");
    await revalidate();
    const proxy = await startScienceReadonlyProxy({ origin: entry.origin, resources: page.resources, revalidate,
      allowsRead: typeof page.allowsRead === "function" ? page.allowsRead.bind(page) : undefined,
      readWebSocket: readWebSocket ?? undefined,
      onUnavailable: reason => { resources.unavailable = true; try { deps.onReadUnavailable?.(reason); } finally { if (resources.row) void closeView(resources.row); } },
    }); resources.proxy = proxy;
    const created = await call("Target.createBrowserContext", { disposeOnDetach: true, proxyServer: proxy.server, proxyBypassList: "<-loopback>" });
    const contextId = created.browserContextId as string; resources.contextId = contextId;
    if (!contextId) throw new Error("science-view-unavailable");
    await call("Browser.setDownloadBehavior", { behavior: "deny", browserContextId: contextId });
    const target = await call("Target.createTarget", { url: "about:blank", browserContextId: contextId }); const targetId = target.targetId as string;
    const attached = await call("Target.attachToTarget", { targetId, flatten: true }); const sessionId = attached.sessionId as string;
    if (!targetId || !sessionId) throw new Error("science-view-unavailable");
    const row: ContextView = { contextId, targetId, sessionId, proxy, binding, entryUrl: entry.href, closed: false, consumers: new Set(), unavailable: new Map(), draining: false, revalidate };
    resources.row = row; sessions.set(sessionId, row); views.set(key, row); return row;
  };
  const prepareContext = async (row: ContextView, admitted: AdmittedPage) => {
    const { sessionId, contextId } = row;
    await call("Target.setDiscoverTargets", { discover: true });
    await call("Page.enable", {}, sessionId); await call("Network.enable", {}, sessionId);
    await call("Network.setBypassServiceWorker", { bypass: true }, sessionId);
    await call("Fetch.enable", { patterns: [{ urlPattern: "*", requestStage: "Request" }], handleAuthRequests: true }, sessionId);
    const prepared = await deps.prepareSession!(admitted.pageBinding, { setCookies: async cookies => {
      await call("Storage.setCookies", { browserContextId: contextId, cookies: checkedCookies(cookies, admitted.entry.origin) });
    } });
    if (!prepared) throw new Error("science-private-session-unavailable");
    await admitted.revalidate();
  };
  const navigateContext = async (row: ContextView, entry: URL) => {
    const sessionId = row.sessionId;
    let removeLoaded = () => {}, loadedTimer: ReturnType<typeof setTimeout> | undefined;
    const loaded = new Promise<void>((resolve, reject) => {
      let navigated = false;
      removeLoaded = chrome.onMessage(raw => {
        const message = raw as { sessionId?: string; method?: string; params?: { frame?: { parentId?: string; url?: string } } };
        if (message.sessionId !== sessionId) return;
        if (message.method === "Page.frameNavigated" && !message.params?.frame?.parentId && message.params?.frame?.url === entry.href) navigated = true;
        if (navigated && message.method === "Page.loadEventFired") resolve();
      });
      loadedTimer = setTimeout(() => reject(new Error("science-page-load-unavailable")), 10000); loadedTimer.unref();
    });
    try {
      await Promise.all([loaded, call("Page.navigate", { url: entry.href }, sessionId).then(navigation => { if (navigation.errorText) throw new Error("science-view-unavailable"); })]);
    } finally { removeLoaded(); if (loadedTimer) clearTimeout(loadedTimer); }
  };
  const closeIncompleteContext = async (resources: BuildResources) => {
    if (resources.row) await closeView(resources.row);
    else await retireResources(resources.contextId, resources.proxy);
  };
  async function build(partition: ScienceViewPartition, key: string, instanceId?: string): Promise<ScienceHostOpenResult> {
    const started = Date.now(), requestId = hostRequestId();
    const resources: BuildResources = {};
    try {
      await awaitRetirements();
      const admitted = await admitPage(partition, instanceId);
      if (!admitted) return { availability: "unavailable", reason: "binding-unavailable" };
      const { binding, entry, revalidate } = admitted;
      const existing = views.get(key);
      if (existing && !existing.closed && existing.binding.projectId === binding.projectId && existing.entryUrl === entry.href) return { availability: "ready", view: asHostView(existing, partition, instanceId) };
      if (existing) await closeView(existing);
      await awaitRetirements();
      if (views.size >= 8) return { availability: "unavailable", reason: "busy" };
      const row = await createContext(resources, admitted, key);
      await prepareContext(row, admitted); await navigateContext(row, entry);
      await revalidate();
      if (resources.unavailable || row.closed) throw new Error("science-view-unavailable");
      observeHost(deps.observe, "daemon", requestId, "open", "ok", "none", started);
      return { availability: "ready", view: asHostView(row, partition, instanceId) };
    } catch {
      await closeIncompleteContext(resources);
      observeHost(deps.observe, "daemon", requestId, "open", "unknown", "transport", started);
      return { availability: "unknown", reason: "view-unavailable" };
    }
  }
  const startConsumer = async (view: ContextView, consumer: (frame: ScienceViewFrame) => void, unavailable?: () => void) => {
    const started = Date.now(), requestId = hostRequestId();
    await view.revalidate(); if (view.closed) throw new Error("science-view-unavailable"); view.consumers.add(consumer);
    if (unavailable) view.unavailable.set(consumer, unavailable);
    if (view.consumers.size === 1) {
      try { await call("Page.bringToFront", {}, view.sessionId); await call("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 }, view.sessionId); if (view.closed) throw new Error("science-view-unavailable"); }
      catch { removeConsumer(view, consumer); retireEmptyView(view); observeHost(deps.observe, "daemon", requestId, "subscribe", "unknown", "protocol", started); throw new Error("science-view-unavailable"); }
    }
    observeHost(deps.observe, "daemon", requestId, "subscribe", "ok", "none", started);
  };
  const consumerStream = (view: ContextView, consumer: (frame: ScienceViewFrame) => void): ScienceViewSubscription => {
    let active = true;
    const assertActive = () => { if (!active || view.closed) throw new Error("science-view-unavailable"); };
    return {
      async input(input) {
        assertActive();
        if (!isScienceViewInput(input)) throw new Error("science-view-unavailable");
        const built = buildViewerInputCommands(input, view.geometry);
        if (!built.ok) throw new Error("science-view-input-unavailable");
        for (const command of built.commands) { await view.revalidate(); assertActive(); await call(command.method, command.params, view.sessionId); }
      },
      unsubscribe() { if (!active) return; active = false; removeConsumer(view, consumer); if (!view.closed) retireEmptyView(view); },
    };
  };
  function asHostView(view: ContextView, partition: ScienceViewPartition, instanceId?: string): ScienceHostView {
    return { async subscribe(consumer, unavailable) {
      if (view.closed) {
        const replacement = await openView(partition, instanceId);
        if (replacement.availability !== "ready") throw new Error("science-view-unavailable");
        return replacement.view.subscribe(consumer, unavailable);
      }
      await startConsumer(view, consumer, unavailable);
      return consumerStream(view, consumer);
    } };
  }
  async function openView(partition: ScienceViewPartition, instanceId?: string): Promise<ScienceHostOpenResult> {
    if (instanceId !== undefined && !validHostInstanceId(instanceId)) return { availability: "unavailable", reason: "binding-unavailable" };
    const key = JSON.stringify([partition.ownerKey, partition.cwd, instanceId ?? "workspace"]);
    let pending = opening.get(key);
    if (!pending) { pending = build(partition, key, instanceId); opening.set(key, pending); void pending.finally(() => opening.delete(key)).catch(() => {}); }
    return pending;
  }
  return { openWorkspace: partition => openView(partition), openTask: (partition, instanceId) => openView(partition, instanceId), async close() { disposed = true; await Promise.allSettled([...opening.values()]); await Promise.all([...views.values()].map(closeView)); await Promise.all([...retiring]); views.clear(); unsubscribeMessage(); unsubscribeExit(); await chrome.stop(); } };
}
