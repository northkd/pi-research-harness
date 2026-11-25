import net from "node:net";
import { readScienceHostSecret, scienceHostPaths, verifyScienceHostSocket } from "../shared/science-host-files.mjs";
import { hostArtifactRead, hostDetailResult, hostListResult, invalidHostRead } from "../shared/science-host-records.mjs";
import { encodeHostPacket, hostFrame, hostProof, hostRequestId, observeHost, SCIENCE_HOST_AUTH_LIMIT, SCIENCE_HOST_MAX_PACKET, ScienceHostDecoder, serverPacket, validHostInstanceId, validHostPartition, verifyHostProof } from "../shared/science-host-transport.mjs";
import { isScienceArtifactId, isScienceInstanceId } from "../shared/science-instances.mjs";
const DEADLINE_MS = 5e3;
const SCIENCE_HOST_OPEN_DEADLINE_MS = 6e4;
const failure = () => new Error("science-host-transport-unavailable");
const validSelection = (partition, instanceId) => validHostPartition(partition) && (instanceId === void 0 || validHostInstanceId(instanceId));
function validReadSelection(partition, type, instanceId, artifactId) {
  if (!validHostPartition(partition)) return false;
  if (type !== "instances-list" && !isScienceInstanceId(instanceId)) return false;
  return type !== "artifact-read" || isScienceArtifactId(artifactId);
}
async function connect(privateDir, observer, signal) {
  let secret = Buffer.alloc(0);
  const requestId = hostRequestId(), started = Date.now();
  let phase = "validate";
  let socket;
  try {
    secret = await readScienceHostSecret(privateDir);
    const before = await verifyScienceHostSocket(privateDir);
    signal.throwIfAborted();
    phase = "connect";
    socket = net.createConnection({ path: scienceHostPaths(privateDir).socket, signal });
    socket.pause();
    const activeSocket = socket;
    let sequence = 0, ready = false, challenged = false;
    const frames = /* @__PURE__ */ new Map();
    const unavailable = /* @__PURE__ */ new Map();
    const pending = /* @__PURE__ */ new Map();
    let readyResolve, readyReject;
    const authenticated = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const timer = setTimeout(() => activeSocket.destroy(failure()), DEADLINE_MS);
    timer.unref();
    const send = (packet) => {
      if (connection.closed || activeSocket.writableLength > SCIENCE_HOST_MAX_PACKET) throw failure();
      activeSocket.write(encodeHostPacket(packet));
    };
    const connection = {
      socket: activeSocket,
      closed: false,
      frames,
      unavailable,
      request(packet, kind) {
        if (!ready || connection.closed || pending.size >= 32) return Promise.reject(failure());
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            activeSocket.destroy(failure());
          }, kind === "open" ? SCIENCE_HOST_OPEN_DEADLINE_MS : DEADLINE_MS);
          timeout.unref();
          pending.set(id, { resolve, reject, timer: timeout });
          try {
            send(packet(id));
          } catch {
            activeSocket.destroy();
          }
        });
      },
      unsubscribe(viewId) {
        frames.delete(viewId);
        unavailable.delete(viewId);
        if (!connection.closed) {
          try {
            send({ type: "unsubscribe", viewId });
          } catch {
            activeSocket.destroy();
          }
        }
      }
    };
    const authenticate = (value) => {
      if (!challenged && value.type === "challenge" && verifyHostProof(secret, "host", value.nonce, value.proof)) {
        challenged = true;
        send({ type: "auth", proof: hostProof(secret, "client", value.nonce) });
        secret.fill(0);
        return;
      }
      if (challenged && value.type === "authenticated") {
        ready = true;
        clearTimeout(timer);
        decoder.limit = SCIENCE_HOST_MAX_PACKET;
        observeHost(observer, "client", requestId, "auth", "ok", "none", started);
        readyResolve();
        return;
      }
      throw failure();
    };
    const deliverFrame = (value) => {
      const frame = hostFrame(value.frame);
      if (frame) {
        try {
          frames.get(value.viewId)?.(frame);
        } catch {
          connection.unsubscribe(value.viewId);
        }
      }
    };
    const deliverUnavailable = (value) => {
      const callback = unavailable.get(value.viewId);
      connection.unsubscribe(value.viewId);
      try {
        callback?.();
      } catch {
      }
    };
    const resolveReply = (value) => {
      const waiting = pending.get(value.id);
      if (!waiting) throw failure();
      pending.delete(value.id);
      clearTimeout(waiting.timer);
      waiting.resolve(value);
    };
    const decoder = new ScienceHostDecoder(SCIENCE_HOST_AUTH_LIMIT, (value) => {
      if (!serverPacket(value)) throw failure();
      if (!ready) {
        authenticate(value);
        return;
      }
      switch (value.type) {
        case "frame":
          deliverFrame(value);
          return;
        case "unavailable":
          deliverUnavailable(value);
          return;
        case "view":
        case "ack":
        case "instances":
        case "instance":
        case "artifact":
          resolveReply(value);
          return;
        default:
          throw failure();
      }
    });
    const close = () => {
      if (connection.closed) return;
      observeHost(observer, "client", requestId, ready ? "close" : phase, "unknown", ready ? "transport" : "auth", started);
      connection.closed = true;
      ready = false;
      secret.fill(0);
      clearTimeout(timer);
      frames.clear();
      readyReject(failure());
      for (const callback of unavailable.values()) {
        try {
          callback();
        } catch {
        }
      }
      unavailable.clear();
      for (const item of pending.values()) {
        clearTimeout(item.timer);
        item.reject(failure());
      }
      pending.clear();
    };
    activeSocket.on("error", close);
    activeSocket.on("close", close);
    activeSocket.on("data", (data) => {
      try {
        if (!Buffer.isBuffer(data)) throw failure();
        decoder.push(data);
      } catch {
        activeSocket.destroy();
      }
    });
    activeSocket.once("connect", () => {
      void verifyScienceHostSocket(privateDir).then((after) => {
        if (before.ino !== after.ino || before.dev !== after.dev) throw failure();
        phase = "auth";
        activeSocket.resume();
      }).catch(() => activeSocket.destroy());
    });
    await authenticated;
    return connection;
  } catch {
    const errors = { validate: "private-files", auth: "auth" };
    observeHost(observer, "client", requestId, phase, "unknown", errors[phase] ?? "transport", started);
    secret.fill(0);
    socket?.destroy();
    throw failure();
  }
}
async function acknowledged(conn, packet, phase, observe) {
  const started = Date.now(), requestId = hostRequestId();
  let reply;
  try {
    reply = await conn.request(packet);
  } catch {
    observeHost(observe, "client", requestId, phase, "unknown", "transport", started);
    throw failure();
  }
  const ok = reply.type === "ack" && reply.ok;
  observeHost(observe, "client", requestId, phase, ok ? "ok" : phase === "subscribe" ? "unavailable" : "denied", ok ? "none" : "binding", started);
  if (!ok) throw failure();
}
function subscribedStream(conn, viewId, frame, onUnavailable, observe) {
  let active = true;
  conn.frames.set(viewId, (value) => {
    if (active) frame(value);
  });
  if (onUnavailable) conn.unavailable.set(viewId, () => {
    if (active) {
      active = false;
      onUnavailable();
    }
  });
  const stream = {
    async input(input) {
      if (!active || conn.closed) throw failure();
      await acknowledged(conn, (id) => ({ type: "input", id, viewId, input }), "input", observe);
    },
    unsubscribe() {
      if (active) {
        active = false;
        conn.unsubscribe(viewId);
      }
    }
  };
  return stream;
}
function hostView(conn, firstViewId, request, reopen, observe) {
  let unusedViewId = firstViewId;
  return { async subscribe(frame, onUnavailable) {
    if (conn.closed) {
      const replacement = await reopen();
      if (replacement.availability !== "ready") throw failure();
      return replacement.view.subscribe(frame, onUnavailable);
    }
    const selected = unusedViewId ? { type: "view", availability: "ready", viewId: unusedViewId } : await conn.request(request, "open");
    unusedViewId = void 0;
    if (selected.type !== "view" || selected.availability !== "ready") throw failure();
    const viewId = selected.viewId, stream = subscribedStream(conn, viewId, frame, onUnavailable, observe);
    try {
      await acknowledged(conn, (id) => ({ type: "subscribe", id, viewId }), "subscribe", observe);
    } catch {
      conn.unsubscribe(viewId);
      throw failure();
    }
    return stream;
  } };
}
function createScienceHostClient({ privateDir, observe }) {
  scienceHostPaths(privateDir);
  const lifecycle = new AbortController();
  let connection, connecting, disposed = false;
  const current = async () => {
    if (disposed) throw failure();
    if (connection && !connection.closed) return connection;
    if (!connecting) connecting = connect(privateDir, observe, lifecycle.signal).then((value) => {
      connection = value;
      return value;
    }).finally(() => {
      connecting = void 0;
    });
    return connecting;
  };
  const readRecords = async (partition, type, expected, instanceId, artifactId) => {
    if (!validReadSelection(partition, type, instanceId, artifactId)) return { availability: "unavailable", reason: "binding-unavailable" };
    const selected = { ownerKey: partition.ownerKey, cwd: partition.cwd }, started = Date.now(), requestId = hostRequestId();
    try {
      const conn = await current();
      if (disposed) throw failure();
      const result = await conn.request((id) => recordRequest(type, id, selected, instanceId, artifactId));
      if (result.type !== expected) return invalidHostRead();
      const reply = result;
      observeHost(observe, "client", requestId, type, reply.result.availability === "ready" ? "ok" : reply.result.availability, reply.result.availability === "ready" ? "none" : "binding", started);
      return reply;
    } catch {
      observeHost(observe, "client", requestId, type, "unknown", "transport", started);
      return { availability: "unknown", reason: "host-offline" };
    }
  };
  async function open(partition, instanceId) {
    const started = Date.now(), requestId = hostRequestId();
    if (!validSelection(partition, instanceId)) return { availability: "unavailable", reason: "binding-unavailable" };
    try {
      const conn = await current();
      if (disposed) throw failure();
      const request = (id) => ({ type: "open", id, partition: { cwd: partition.cwd, ownerKey: partition.ownerKey }, ...instanceId ? { instanceId } : {} });
      const result = await conn.request(request, "open");
      if (result.type !== "view") throw failure();
      observeHost(observe, "client", requestId, "open", result.availability === "ready" ? "ok" : result.availability, result.availability === "ready" ? "none" : "binding", started);
      if (result.availability !== "ready") return { availability: result.availability, reason: result.reason };
      const view = hostView(conn, result.viewId, request, () => open(partition, instanceId), observe);
      return { availability: "ready", view };
    } catch {
      observeHost(observe, "client", requestId, "open", "unknown", "transport", started);
      return { availability: "unknown", reason: "host-offline" };
    }
  }
  return {
    openWorkspace: (partition) => open(partition),
    openTask: (partition, instanceId) => open(partition, instanceId),
    async list(partition) {
      const reply = await readRecords(partition, "instances-list", "instances");
      return "type" in reply && reply.type === "instances" ? hostListResult(reply.result) : readUnavailable(reply);
    },
    async detail(partition, instanceId) {
      const reply = await readRecords(partition, "instance-detail", "instance", instanceId);
      return "type" in reply && reply.type === "instance" ? hostDetailResult(reply.result, instanceId) : readUnavailable(reply);
    },
    async readArtifact(partition, instanceId, artifactId) {
      const reply = await readRecords(partition, "artifact-read", "artifact", instanceId, artifactId);
      return "type" in reply && reply.type === "artifact" ? hostArtifactRead(reply.result, artifactId) : readUnavailable(reply);
    },
    dispose() {
      disposed = true;
      lifecycle.abort();
      connection?.socket.destroy();
      void connecting?.then((value) => value.socket.destroy(), () => {
      });
    }
  };
}
function readUnavailable(reply) {
  return "type" in reply ? invalidHostRead() : reply;
}
function recordRequest(type, id, partition, instanceId, artifactId) {
  switch (type) {
    case "instances-list":
      return { type, id, partition };
    case "instance-detail":
      return { type, id, partition, instanceId };
    case "artifact-read":
      return { type, id, partition, instanceId, artifactId };
  }
}
export {
  SCIENCE_HOST_OPEN_DEADLINE_MS,
  createScienceHostClient
};
