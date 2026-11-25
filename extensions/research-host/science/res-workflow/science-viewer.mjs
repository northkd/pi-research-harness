import { randomBytes } from "node:crypto";
import { validHostInstanceId } from "../shared/science-host-transport.mjs";
import { isScienceViewInput } from "../shared/science-viewer.mjs";
import { ResWorkflowError } from "../../workbench/errors.mjs";
const LEASE_MS = 5 * 6e4;
const MAX_LEASES = 256;
const MAX_SUBSCRIPTIONS_PER_SOCKET = 8;
const MAX_PENDING_MESSAGES = 64;
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const LEASE_ID = /^sv-[a-f0-9]{48}$/;
const REASONS = /* @__PURE__ */ new Set(["host-unconfigured", "host-offline", "binding-unavailable", "view-unavailable", "lease-expired", "access-revoked", "invalid-host-response", "busy"]);
function object(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function shape(value, keys) {
  return Object.keys(value).every((key) => keys.includes(key));
}
function frameOf(value) {
  if (!object(value) || !object(value.metadata) || typeof value.jpegBase64 !== "string" || value.jpegBase64.length > MAX_FRAME_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.jpegBase64)) return null;
  const { deviceWidth, deviceHeight, timestamp } = value.metadata;
  if (![deviceWidth, deviceHeight, timestamp].every((n) => typeof n === "number" && Number.isFinite(n)) || !Number.isInteger(deviceWidth) || !Number.isInteger(deviceHeight) || deviceWidth < 1 || deviceWidth > 16384 || deviceHeight < 1 || deviceHeight > 16384 || timestamp < 0) return null;
  return { jpegBase64: value.jpegBase64, metadata: { deviceWidth, deviceHeight, timestamp } };
}
function createScienceViewer(deps) {
  const leases = /* @__PURE__ */ new Map();
  const openings = /* @__PURE__ */ new Map();
  const subscriptions = /* @__PURE__ */ new Map();
  const queues = /* @__PURE__ */ new WeakMap();
  const generations = /* @__PURE__ */ new WeakMap();
  const disconnected = /* @__PURE__ */ new WeakSet();
  let disposed = false;
  const send = (socket, message) => {
    if (socket.sessionTier && socket.sessionTier() === null) {
      disconnect(socket);
      return;
    }
    if (socket.readyState !== 1 || (socket.bufferedAmount ?? 0) > MAX_FRAME_BYTES) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      disconnect(socket);
    }
  };
  function end(sub) {
    if (!sub.active) return;
    sub.active = false;
    sub.latest = void 0;
    clearTimeout(sub.timer);
    if (subscriptions.get(sub.socket)?.get(sub.lease.id) === sub) subscriptions.get(sub.socket)?.delete(sub.lease.id);
    if (subscriptions.get(sub.socket)?.size === 0) subscriptions.delete(sub.socket);
    try {
      sub.stream?.unsubscribe();
    } catch {
    }
  }
  function disconnect(socket) {
    disconnected.add(socket);
    for (const sub of [...subscriptions.get(socket)?.values() ?? []]) end(sub);
  }
  async function check(lease, access) {
    if (disposed || lease.access.ownerKey !== access.ownerKey || lease.access.cwd !== access.cwd) throw new ResWorkflowError(404, "science-view-not-found");
    if (Date.now() >= lease.expiresAt) throw new ResWorkflowError(403, "science-view-expired");
    await lease.access.revalidate();
    await access.revalidate();
    if (Date.now() >= lease.expiresAt || disposed) throw new ResWorkflowError(403, "science-view-expired");
  }
  async function flush(sub) {
    if (sub.draining || !sub.stream) return;
    sub.draining = true;
    try {
      while (sub.active && sub.latest) {
        const frame = sub.latest;
        sub.latest = void 0;
        await check(sub.lease, sub.access);
        if (sub.active && !disconnected.has(sub.socket) && generation(sub.socket, sub.lease.id) === sub.generation) send(sub.socket, { type: "science_view_frame", leaseId: sub.lease.id, ...frame });
      }
    } catch {
      const current = sub.active && generation(sub.socket, sub.lease.id) === sub.generation;
      end(sub);
      if (current) send(sub.socket, { type: "science_view_status", leaseId: sub.lease.id, state: "expired", reason: "access-revoked" });
    } finally {
      sub.draining = false;
    }
  }
  function sweep() {
    for (const [id, lease] of leases) if (Date.now() >= lease.expiresAt) {
      leases.delete(id);
      for (const rows of subscriptions.values()) {
        const sub = rows.get(id);
        if (sub) end(sub);
      }
    }
  }
  async function open(access, target) {
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
        for (const rows of subscriptions.values()) {
          const sub = rows.get(lease.id);
          if (sub) end(sub);
        }
        await access.revalidate();
      }
    }
    const key = JSON.stringify([access.ownerKey, access.cwd, targetKey]);
    let pending = openings.get(key);
    if (!pending) {
      if (leases.size + openings.size >= MAX_LEASES) return { availability: "unavailable", reason: "busy" };
      pending = (async () => {
        let result2;
        try {
          const partition = { ownerKey: access.ownerKey, cwd: access.cwd };
          result2 = target.kind === "task" ? await deps.host.openTask(partition, target.taskId) : await deps.host.openWorkspace(partition);
        } catch {
          return { availability: "unknown", reason: "host-offline" };
        }
        await access.revalidate();
        if (disposed) return { availability: "unavailable", reason: "view-unavailable" };
        if (result2?.availability !== "ready") {
          return result2 && ["unavailable", "unknown"].includes(result2.availability) && REASONS.has(result2.reason) ? { availability: result2.availability, reason: result2.reason } : { availability: "unknown", reason: "invalid-host-response" };
        }
        if (!result2.view || typeof result2.view.subscribe !== "function") return { availability: "unknown", reason: "invalid-host-response" };
        const lease = { id: `sv-${randomBytes(24).toString("hex")}`, access, targetKey, expiresAt: Date.now() + LEASE_MS, view: result2.view };
        leases.set(lease.id, lease);
        return { availability: "ready", leaseId: lease.id, expiresAt: lease.expiresAt };
      })();
      openings.set(key, pending);
      void pending.finally(() => {
        if (openings.get(key) === pending) openings.delete(key);
      }).catch(() => {
      });
    }
    const result = await pending;
    await access.revalidate();
    return result;
  }
  function generation(socket, id) {
    return generations.get(socket)?.get(id) ?? 0;
  }
  async function handle(message, socket, expectedGeneration) {
    if (disposed || disconnected.has(socket) || !object(message) || typeof message.type !== "string" || typeof message.leaseId !== "string" || !LEASE_ID.test(message.leaseId)) return;
    const id = message.leaseId;
    const isInput = message.type === "science_view_input";
    if (!["science_view_subscribe", "science_view_unsubscribe", "science_view_input"].includes(message.type) || !shape(message, ["type", "cwd", "leaseId", ...isInput ? ["input"] : []]) || isInput && !isScienceViewInput(message.input)) return;
    const access = await deps.socketAccess(socket, message.cwd, isInput);
    const lease = leases.get(id);
    if (!lease) throw new ResWorkflowError(404, "science-view-not-found");
    await check(lease, access);
    if (disconnected.has(socket)) return;
    const previous = subscriptions.get(socket)?.get(id);
    if (message.type === "science_view_unsubscribe") {
      if (previous && previous.generation < expectedGeneration) end(previous);
      return;
    }
    if (isInput) {
      if (generation(socket, id) !== expectedGeneration) return;
      if (previous?.active && previous.stream) {
        await check(lease, previous.access);
        await check(lease, access);
        if (socket.sessionTier && socket.sessionTier() !== "operate") throw new ResWorkflowError(403, "science-input-forbidden");
        if (previous.active && generation(socket, id) === previous.generation) await previous.stream.input(message.input);
      }
      return;
    }
    if (previous?.active) return;
    if (generation(socket, id) !== expectedGeneration) return;
    let rows = subscriptions.get(socket);
    if (rows && rows.size >= MAX_SUBSCRIPTIONS_PER_SOCKET) return;
    if (!rows) {
      rows = /* @__PURE__ */ new Map();
      subscriptions.set(socket, rows);
    }
    const sub = { active: true, lease, access, socket, generation: expectedGeneration, draining: false, timer: setTimeout(() => {
      end(sub);
      send(socket, { type: "science_view_status", leaseId: id, state: "expired", reason: "lease-expired" });
    }, Math.max(1, lease.expiresAt - Date.now())) };
    sub.timer.unref?.();
    rows.set(id, sub);
    try {
      const stream = await lease.view.subscribe((value) => {
        if (!sub.active) return;
        const frame = frameOf(value);
        if (frame) {
          sub.latest = frame;
          void flush(sub);
        }
      }, () => {
        if (!sub.active || generation(socket, id) !== expectedGeneration) return;
        end(sub);
        send(socket, { type: "science_view_status", leaseId: id, state: "unavailable", reason: "view-unavailable" });
      });
      if (!stream || typeof stream.unsubscribe !== "function" || typeof stream.input !== "function") throw new Error("invalid-host-stream");
      if (!sub.active) {
        stream.unsubscribe();
        return;
      }
      sub.stream = stream;
      await check(lease, access);
      if (generation(socket, id) !== expectedGeneration) end(sub);
      if (!sub.active || disconnected.has(socket)) return;
      send(socket, { type: "science_view_status", leaseId: id, state: "streaming" });
      void flush(sub);
    } catch {
      end(sub);
      throw new ResWorkflowError(503, "science-view-unavailable");
    }
  }
  function handleMessage(message, socket) {
    if (disposed || disconnected.has(socket) || !object(message) || typeof message.type !== "string" || !["science_view_subscribe", "science_view_unsubscribe", "science_view_input"].includes(message.type) || typeof message.cwd !== "string" || message.cwd.length > 4096 || message.cwd.includes("\0") || typeof message.leaseId !== "string" || !LEASE_ID.test(message.leaseId)) return Promise.resolve();
    const isInput = message.type === "science_view_input";
    if (!shape(message, ["type", "cwd", "leaseId", ...isInput ? ["input"] : []]) || isInput && !isScienceViewInput(message.input)) return Promise.resolve();
    const id = object(message) && typeof message.leaseId === "string" && LEASE_ID.test(message.leaseId) ? message.leaseId : void 0;
    const failure = () => {
      const sub = id ? subscriptions.get(socket)?.get(id) : void 0;
      if (sub) end(sub);
      if (id) send(socket, { type: "science_view_status", leaseId: id, state: "unavailable", reason: "view-unavailable" });
    };
    if (id && message.type === "science_view_unsubscribe" && leases.has(id)) {
      let rows = generations.get(socket);
      if (!rows) {
        rows = /* @__PURE__ */ new Map();
        generations.set(socket, rows);
      }
      for (const previousId of rows.keys()) if (!leases.has(previousId)) rows.delete(previousId);
      rows.set(id, generation(socket, id) + 1);
      const previous = subscriptions.get(socket)?.get(id);
      if (previous) end(previous);
    }
    const expectedGeneration = id ? generation(socket, id) : 0;
    let queue = queues.get(socket);
    if (!queue) {
      queue = { tail: Promise.resolve(), pending: 0 };
      queues.set(socket, queue);
    }
    if (queue.pending >= MAX_PENDING_MESSAGES) return Promise.resolve();
    queue.pending++;
    queue.tail = queue.tail.then(() => handle(message, socket, expectedGeneration)).catch(failure).finally(() => {
      queue.pending--;
    });
    return queue.tail;
  }
  return {
    open,
    handleMessage,
    disconnect,
    dispose() {
      disposed = true;
      for (const socket of [...subscriptions.keys()]) disconnect(socket);
      leases.clear();
    }
  };
}
export {
  createScienceViewer
};
