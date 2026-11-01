import { randomBytes } from "node:crypto";
import { validHostInstanceId } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import { isScienceViewInput, type ScienceHostView, type ScienceViewHost, type ScienceViewSubscription, type ScienceViewFrame, type ScienceViewResponse, type ScienceViewTarget } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { ResWorkflowError, type ResWorkflowAccess } from "./adoption-service.js";

const LEASE_MS = 5 * 60_000;
const MAX_LEASES = 256;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 8;
const MAX_PENDING_MESSAGES = 64;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const LEASE_ID = /^sv-[a-f0-9]{48}$/;
const REASONS = new Set(["host-unconfigured", "host-offline", "binding-unavailable", "view-unavailable", "lease-expired", "access-revoked", "invalid-host-response", "busy"]);

export interface ScienceViewerSocket {
  principal?: { iss: string; sub: string };
  principalExpiresAt?: number;
  /** Live passkey/session tier installed by the existing browser upgrade gate. */
  sessionTier?: () => "observe" | "control" | "operate" | null;
  readyState: number;
  bufferedAmount?: number;
  send(value: string): unknown;
}
interface Lease { id: string; access: ResWorkflowAccess; targetKey: string; expiresAt: number; view: ScienceHostView }
interface Subscription {
  active: boolean; lease: Lease; access: ResWorkflowAccess; socket: ScienceViewerSocket;
  generation: number;
  stream?: ScienceViewSubscription; timer: ReturnType<typeof setTimeout>; latest?: ScienceViewFrame; draining: boolean;
}
export interface ScienceViewerDeps {
  host?: ScienceViewHost;
  socketAccess(socket: ScienceViewerSocket, cwd: unknown, write: boolean): Promise<ResWorkflowAccess>;
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function shape(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)); }
function frameOf(value: unknown): ScienceViewFrame | null {
  if (!object(value) || !object(value.metadata) || typeof value.jpegBase64 !== "string" || value.jpegBase64.length > MAX_FRAME_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.jpegBase64)) return null;
  const { deviceWidth, deviceHeight, timestamp } = value.metadata;
  if (![deviceWidth, deviceHeight, timestamp].every(n => typeof n === "number" && Number.isFinite(n)) || !Number.isInteger(deviceWidth) || !Number.isInteger(deviceHeight) || (deviceWidth as number) < 1 || (deviceWidth as number) > 16384 || (deviceHeight as number) < 1 || (deviceHeight as number) > 16384 || (timestamp as number) < 0) return null;
  return { jpegBase64: value.jpegBase64, metadata: { deviceWidth: deviceWidth as number, deviceHeight: deviceHeight as number, timestamp: timestamp as number } };
}

/** Ephemeral viewing leases only. No registry writer, task submission or service lifecycle. */
export function createScienceViewer(deps: ScienceViewerDeps) {
  const leases = new Map<string, Lease>();
  const openings = new Map<string, Promise<ScienceViewResponse>>();
  const subscriptions = new Map<ScienceViewerSocket, Map<string, Subscription>>();
  const queues = new WeakMap<ScienceViewerSocket, { tail: Promise<void>; pending: number }>();
  const generations = new WeakMap<ScienceViewerSocket, Map<string, number>>();
  const disconnected = new WeakSet<ScienceViewerSocket>();
  let disposed = false;

  const send = (socket: ScienceViewerSocket, message: object) => {
    if (socket.sessionTier && socket.sessionTier() === null) { disconnect(socket); return; }
    if (socket.readyState !== 1 || (socket.bufferedAmount ?? 0) > MAX_FRAME_BYTES) return;
    try { socket.send(JSON.stringify(message)); } catch { disconnect(socket); }
  };
  function end(sub: Subscription) {
    if (!sub.active) return;
    sub.active = false; sub.latest = undefined; clearTimeout(sub.timer);
    if (subscriptions.get(sub.socket)?.get(sub.lease.id) === sub) subscriptions.get(sub.socket)?.delete(sub.lease.id);
    if (subscriptions.get(sub.socket)?.size === 0) subscriptions.delete(sub.socket);
    try { sub.stream?.unsubscribe(); } catch { /* Detach failure never changes upstream lifecycle. */ }
  }
  function disconnect(socket: ScienceViewerSocket) {
    disconnected.add(socket);
    for (const sub of [...subscriptions.get(socket)?.values() ?? []]) end(sub);
  }
  async function check(lease: Lease, access: ResWorkflowAccess) {
    if (disposed || lease.access.ownerKey !== access.ownerKey || lease.access.cwd !== access.cwd) throw new ResWorkflowError(404, "science-view-not-found");
    if (Date.now() >= lease.expiresAt) throw new ResWorkflowError(403, "science-view-expired");
    await lease.access.revalidate(); await access.revalidate();
    if (Date.now() >= lease.expiresAt || disposed) throw new ResWorkflowError(403, "science-view-expired");
  }
  async function flush(sub: Subscription) {
    if (sub.draining || !sub.stream) return;
    sub.draining = true;
    try {
      while (sub.active && sub.latest) {
        const frame = sub.latest; sub.latest = undefined;
        await check(sub.lease, sub.access);
        if (sub.active && !disconnected.has(sub.socket) && generation(sub.socket, sub.lease.id) === sub.generation) send(sub.socket, { type: "science_view_frame", leaseId: sub.lease.id, ...frame });
      }
    } catch {
      const current = sub.active && generation(sub.socket, sub.lease.id) === sub.generation;
      end(sub);
      if (current) send(sub.socket, { type: "science_view_status", leaseId: sub.lease.id, state: "expired", reason: "access-revoked" });
    } finally { sub.draining = false; }
  }
  function sweep() {
    for (const [id, lease] of leases) if (Date.now() >= lease.expiresAt) {
      leases.delete(id);
      for (const rows of subscriptions.values()) { const sub = rows.get(id); if (sub) end(sub); }
    }
  }
  async function open(access: ResWorkflowAccess, target: ScienceViewTarget): Promise<ScienceViewResponse> {
    await access.revalidate();
    if (disposed) return { availability: "unavailable", reason: "view-unavailable" };
    if (target.kind === "task" && (!validHostInstanceId(target.taskId) || !deps.host?.openTask)) return { availability: "unavailable", reason: "binding-unavailable" };
    if (!deps.host) return { availability: "unavailable", reason: "host-unconfigured" };
    const targetKey = target.kind === "task" ? `task:${target.taskId}` : "workspace";
    sweep();
    for (const lease of leases.values()) if (lease.access.ownerKey === access.ownerKey && lease.access.cwd === access.cwd && lease.targetKey === targetKey) {
      try {
        await check(lease, access);
        return { availability: "ready", leaseId: lease.id, expiresAt: lease.expiresAt };
      } catch {
        leases.delete(lease.id);
        for (const rows of subscriptions.values()) { const sub = rows.get(lease.id); if (sub) end(sub); }
        await access.revalidate();
      }
    }
    const key = JSON.stringify([access.ownerKey, access.cwd, targetKey]);
    let pending = openings.get(key);
    if (!pending) {
      if (leases.size + openings.size >= MAX_LEASES) return { availability: "unavailable", reason: "busy" };
      pending = (async (): Promise<ScienceViewResponse> => {
        let result;
        try { const partition = { ownerKey: access.ownerKey, cwd: access.cwd }; result = target.kind === "task" ? await deps.host!.openTask!(partition, target.taskId) : await deps.host!.openWorkspace(partition); }
        catch { return { availability: "unknown", reason: "host-offline" }; }
        await access.revalidate();
        if (disposed) return { availability: "unavailable", reason: "view-unavailable" };
        if (result?.availability !== "ready") {
          return result && ["unavailable", "unknown"].includes(result.availability) && REASONS.has(result.reason) ? { availability: result.availability, reason: result.reason } : { availability: "unknown", reason: "invalid-host-response" };
        }
        if (!result.view || typeof result.view.subscribe !== "function") return { availability: "unknown", reason: "invalid-host-response" };
        const lease: Lease = { id: `sv-${randomBytes(24).toString("hex")}`, access, targetKey, expiresAt: Date.now() + LEASE_MS, view: result.view };
        leases.set(lease.id, lease);
        return { availability: "ready", leaseId: lease.id, expiresAt: lease.expiresAt };
      })();
      openings.set(key, pending);
      void pending.finally(() => { if (openings.get(key) === pending) openings.delete(key); }).catch(() => {});
    }
    const result = await pending;
    await access.revalidate();
    return result;
  }
  function generation(socket: ScienceViewerSocket, id: string): number { return generations.get(socket)?.get(id) ?? 0; }
  async function handle(message: unknown, socket: ScienceViewerSocket, expectedGeneration: number) {
    if (disposed || disconnected.has(socket) || !object(message) || typeof message.type !== "string" || typeof message.leaseId !== "string" || !LEASE_ID.test(message.leaseId)) return;
    const id = message.leaseId;
    const isInput = message.type === "science_view_input";
    if (!["science_view_subscribe", "science_view_unsubscribe", "science_view_input"].includes(message.type) || !shape(message, ["type", "cwd", "leaseId", ...(isInput ? ["input"] : [])]) || isInput && !isScienceViewInput(message.input)) return;
    const access = await deps.socketAccess(socket, message.cwd, isInput);
    const lease = leases.get(id);
    if (!lease) throw new ResWorkflowError(404, "science-view-not-found");
    await check(lease, access);
    if (disconnected.has(socket)) return;
    const previous = subscriptions.get(socket)?.get(id);
    if (message.type === "science_view_unsubscribe") { if (previous && previous.generation < expectedGeneration) end(previous); return; }
    if (isInput) {
      if (generation(socket, id) !== expectedGeneration) return;
      if (previous?.active && previous.stream) {
        await check(lease, previous.access);
        await check(lease, access); // The current write grant is the final asynchronous check.
        if (socket.sessionTier && socket.sessionTier() !== "operate") throw new ResWorkflowError(403, "science-input-forbidden");
        if (previous.active && generation(socket, id) === previous.generation) await previous.stream.input(message.input as Parameters<ScienceViewSubscription["input"]>[0]);
      }
      return;
    }
    if (previous?.active) return;
    if (generation(socket, id) !== expectedGeneration) return;
    let rows = subscriptions.get(socket);
    if (rows && rows.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) return;
    if (!rows) { rows = new Map(); subscriptions.set(socket, rows); }
    const sub: Subscription = { active: true, lease, access, socket, generation: expectedGeneration, draining: false, timer: setTimeout(() => {
      end(sub); send(socket, { type: "science_view_status", leaseId: id, state: "expired", reason: "lease-expired" });
    }, Math.max(1, lease.expiresAt - Date.now())) };
    sub.timer.unref?.(); rows.set(id, sub);
    try {
      const stream = await lease.view.subscribe(value => {
        if (!sub.active) return;
        const frame = frameOf(value);
        if (frame) { sub.latest = frame; void flush(sub); }
      }, () => {
        if (!sub.active || generation(socket, id) !== expectedGeneration) return;
        end(sub); send(socket, { type: "science_view_status", leaseId: id, state: "unavailable", reason: "view-unavailable" });
      });
      if (!stream || typeof stream.unsubscribe !== "function" || typeof stream.input !== "function") throw new Error("invalid-host-stream");
      if (!sub.active) { stream.unsubscribe(); return; }
      sub.stream = stream;
      await check(lease, access);
      if (generation(socket, id) !== expectedGeneration) end(sub);
      if (!sub.active || disconnected.has(socket)) return;
      send(socket, { type: "science_view_status", leaseId: id, state: "streaming" });
      void flush(sub);
    } catch { end(sub); throw new ResWorkflowError(503, "science-view-unavailable"); }
  }
  function handleMessage(message: unknown, socket: ScienceViewerSocket): Promise<void> {
    if (disposed || disconnected.has(socket) || !object(message) || typeof message.type !== "string" || !["science_view_subscribe", "science_view_unsubscribe", "science_view_input"].includes(message.type) || typeof message.cwd !== "string" || message.cwd.length > 4096 || message.cwd.includes("\0") || typeof message.leaseId !== "string" || !LEASE_ID.test(message.leaseId)) return Promise.resolve();
    const isInput = message.type === "science_view_input";
    if (!shape(message, ["type", "cwd", "leaseId", ...(isInput ? ["input"] : [])]) || isInput && !isScienceViewInput(message.input)) return Promise.resolve();
    const id = object(message) && typeof message.leaseId === "string" && LEASE_ID.test(message.leaseId) ? message.leaseId : undefined;
    const failure = () => {
      const sub = id ? subscriptions.get(socket)?.get(id) : undefined;
      if (sub) end(sub);
      if (id) send(socket, { type: "science_view_status", leaseId: id, state: "unavailable", reason: "view-unavailable" });
    };
    if (id && message.type === "science_view_unsubscribe" && leases.has(id)) {
      // Retiring this socket's consumer cannot grant access. Cancel only the
      // old consumer immediately; revalidation still uses the bounded queue.
      let rows = generations.get(socket);
      if (!rows) { rows = new Map(); generations.set(socket, rows); }
      for (const previousId of rows.keys()) if (!leases.has(previousId)) rows.delete(previousId);
      rows.set(id, generation(socket, id) + 1);
      const previous = subscriptions.get(socket)?.get(id);
      if (previous) end(previous);
    }
    const expectedGeneration = id ? generation(socket, id) : 0;
    let queue = queues.get(socket);
    if (!queue) { queue = { tail: Promise.resolve(), pending: 0 }; queues.set(socket, queue); }
    if (queue.pending >= MAX_PENDING_MESSAGES) return Promise.resolve();
    queue.pending++;
    queue.tail = queue.tail.then(() => handle(message, socket, expectedGeneration)).catch(failure).finally(() => { queue!.pending--; });
    return queue.tail;
  }
  return {
    open, handleMessage, disconnect,
    dispose() { disposed = true; for (const socket of [...subscriptions.keys()]) disconnect(socket); leases.clear(); },
  };
}
