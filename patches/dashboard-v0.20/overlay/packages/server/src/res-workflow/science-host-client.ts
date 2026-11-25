import net, { type Socket } from "node:net";
import { readScienceHostSecret, scienceHostPaths, verifyScienceHostSocket } from "@blackbelt-technology/pi-dashboard-shared/science-host-files.js";
import { hostArtifactRead, hostDetailResult, hostListResult, invalidHostRead, type ScienceHostRecordsReply } from "@blackbelt-technology/pi-dashboard-shared/science-host-records.js";
import { encodeHostPacket, hostFrame, hostProof, hostRequestId, observeHost, SCIENCE_HOST_AUTH_LIMIT, SCIENCE_HOST_MAX_PACKET, type ScienceHostClientPacket, ScienceHostDecoder, type ScienceHostObservation, type ScienceHostObserver, type ScienceHostServerPacket, serverPacket, validHostInstanceId, validHostPartition, verifyHostProof } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import { isScienceArtifactId, isScienceInstanceId, type ScienceInstancesHost, type ScienceReadUnavailable } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import type { ScienceHostOpenResult, ScienceHostView, ScienceViewFrame, ScienceViewHost, ScienceViewPartition, ScienceViewSubscription } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";

type Reply = Extract<ScienceHostServerPacket, { type: "view" | "ack" }> | ScienceHostRecordsReply;
type RecordsRequest = Extract<ScienceHostClientPacket, { type: "instances-list" | "instance-detail" | "artifact-read" }>;
const DEADLINE_MS = 5000;
// Cold open may include a 15s observer, 15s Chrome launch and 10s navigation.
// This host-only bound leaves setup margin without extending ordinary reads.
export const SCIENCE_HOST_OPEN_DEADLINE_MS = 60_000;
const failure = () => new Error("science-host-transport-unavailable");
const validSelection = (partition: ScienceViewPartition, instanceId?: string) => validHostPartition(partition) && (instanceId === undefined || validHostInstanceId(instanceId));
function validReadSelection(partition: ScienceViewPartition, type: RecordsRequest["type"], instanceId?: string, artifactId?: string) {
  if (!validHostPartition(partition)) return false;
  if (type !== "instances-list" && !isScienceInstanceId(instanceId)) return false;
  return type !== "artifact-read" || isScienceArtifactId(artifactId);
}
interface Connection {
  socket: Socket; closed: boolean;
  request(packet: (id: number) => ScienceHostClientPacket, kind?: "open"): Promise<Reply>;
  unsubscribe(viewId: string): void;
  frames: Map<string, (frame: ScienceViewFrame) => void>;
  unavailable: Map<string, () => void>;
}
async function connect(privateDir: string, observer: ScienceHostObserver | undefined, signal: AbortSignal): Promise<Connection> {
  let secret: Buffer = Buffer.alloc(0);
  const requestId = hostRequestId(), started = Date.now(); let phase: ScienceHostObservation["phase"] = "validate";
  let socket: Socket | undefined;
  try {
    secret = await readScienceHostSecret(privateDir);
    const before = await verifyScienceHostSocket(privateDir);
    signal.throwIfAborted();
    phase = "connect";
    socket = net.createConnection({ path: scienceHostPaths(privateDir).socket, signal });
    socket.pause();
    const activeSocket = socket;
    let sequence = 0, ready = false, challenged = false;
    const frames = new Map<string, (frame: ScienceViewFrame) => void>();
    const unavailable = new Map<string, () => void>();
    const pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
    let readyResolve!: () => void, readyReject!: (error: Error) => void;
    const authenticated = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const timer = setTimeout(() => activeSocket.destroy(failure()), DEADLINE_MS); timer.unref();
    const send = (packet: ScienceHostClientPacket) => {
      if (connection.closed || activeSocket.writableLength > SCIENCE_HOST_MAX_PACKET) throw failure();
      activeSocket.write(encodeHostPacket(packet));
    };
    const connection: Connection = {
      socket: activeSocket, closed: false, frames, unavailable,
      request(packet, kind) {
        if (!ready || connection.closed || pending.size >= 32) return Promise.reject(failure());
        const id = ++sequence;
        return new Promise<Reply>((resolve, reject) => {
          const timeout = setTimeout(() => { activeSocket.destroy(failure()); }, kind === "open" ? SCIENCE_HOST_OPEN_DEADLINE_MS : DEADLINE_MS); timeout.unref();
          pending.set(id, { resolve, reject, timer: timeout });
          try { send(packet(id)); } catch { activeSocket.destroy(); }
        });
      },
      unsubscribe(viewId) { frames.delete(viewId); unavailable.delete(viewId); if (!connection.closed) { try { send({ type: "unsubscribe", viewId }); } catch { activeSocket.destroy(); } } },
    };
    const authenticate = (value: ScienceHostServerPacket) => {
      if (!challenged && value.type === "challenge" && verifyHostProof(secret, "host", value.nonce, value.proof)) {
        challenged = true; send({ type: "auth", proof: hostProof(secret, "client", value.nonce) }); secret.fill(0); return;
      }
      if (challenged && value.type === "authenticated") { ready = true; clearTimeout(timer); decoder.limit = SCIENCE_HOST_MAX_PACKET; observeHost(observer, "client", requestId, "auth", "ok", "none", started); readyResolve(); return; }
      throw failure();
    };
    const deliverFrame = (value: Extract<ScienceHostServerPacket, { type: "frame" }>) => {
      const frame = hostFrame(value.frame);
      if (frame) { try { frames.get(value.viewId)?.(frame); } catch { connection.unsubscribe(value.viewId); } }
    };
    const deliverUnavailable = (value: Extract<ScienceHostServerPacket, { type: "unavailable" }>) => {
      const callback = unavailable.get(value.viewId); connection.unsubscribe(value.viewId); try { callback?.(); } catch { /* Consumer boundary. */ }
    };
    const resolveReply = (value: Reply) => {
      const waiting = pending.get(value.id);
      if (!waiting) throw failure();
      pending.delete(value.id); clearTimeout(waiting.timer); waiting.resolve(value);
    };
    const decoder = new ScienceHostDecoder(SCIENCE_HOST_AUTH_LIMIT, value => {
      if (!serverPacket(value)) throw failure();
      if (!ready) { authenticate(value); return; }
      switch (value.type) {
        case "frame": deliverFrame(value); return;
        case "unavailable": deliverUnavailable(value); return;
        case "view": case "ack": case "instances": case "instance": case "artifact": resolveReply(value); return;
        default: throw failure();
      }
    });
    const close = () => {
      if (connection.closed) return;
      observeHost(observer, "client", requestId, ready ? "close" : phase, "unknown", ready ? "transport" : "auth", started);
      connection.closed = true; ready = false; secret.fill(0); clearTimeout(timer); frames.clear(); readyReject(failure());
      for (const callback of unavailable.values()) { try { callback(); } catch { /* Consumer boundary. */ } } unavailable.clear();
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(failure()); }
      pending.clear();
    };
    activeSocket.on("error", close); activeSocket.on("close", close);
    activeSocket.on("data", data => { try { if (!Buffer.isBuffer(data)) throw failure(); decoder.push(data); } catch { activeSocket.destroy(); } });
    activeSocket.once("connect", () => { void verifyScienceHostSocket(privateDir).then(after => {
      if (before.ino !== after.ino || before.dev !== after.dev) throw failure();
      phase = "auth";
      activeSocket.resume();
    }).catch(() => activeSocket.destroy()); });
    await authenticated;
    return connection;
  } catch {
    const errors: Partial<Record<ScienceHostObservation["phase"], ScienceHostObservation["error"]>> = { validate: "private-files", auth: "auth" };
    observeHost(observer, "client", requestId, phase, "unknown", errors[phase] ?? "transport", started); secret.fill(0); socket?.destroy(); throw failure();
  }
}

async function acknowledged(conn: Connection, packet: (id: number) => ScienceHostClientPacket, phase: "subscribe" | "input", observe?: ScienceHostObserver): Promise<void> {
  const started = Date.now(), requestId = hostRequestId();
  let reply: Reply;
  try { reply = await conn.request(packet); }
  catch { observeHost(observe, "client", requestId, phase, "unknown", "transport", started); throw failure(); }
  const ok = reply.type === "ack" && reply.ok;
  observeHost(observe, "client", requestId, phase, ok ? "ok" : phase === "subscribe" ? "unavailable" : "denied", ok ? "none" : "binding", started);
  if (!ok) throw failure();
}
function subscribedStream(conn: Connection, viewId: string, frame: (value: ScienceViewFrame) => void, onUnavailable: (() => void) | undefined, observe?: ScienceHostObserver) {
  let active = true;
  conn.frames.set(viewId, value => { if (active) frame(value); });
  if (onUnavailable) conn.unavailable.set(viewId, () => { if (active) { active = false; onUnavailable(); } });
  const stream: ScienceViewSubscription = {
    async input(input) {
      if (!active || conn.closed) throw failure();
      await acknowledged(conn, id => ({ type: "input", id, viewId, input }), "input", observe);
    },
    unsubscribe() { if (active) { active = false; conn.unsubscribe(viewId); } },
  };
  return stream;
}
function hostView(conn: Connection, firstViewId: string, request: (id: number) => ScienceHostClientPacket, reopen: () => Promise<ScienceHostOpenResult>, observe?: ScienceHostObserver): ScienceHostView {
  let unusedViewId: string | undefined = firstViewId;
  return { async subscribe(frame, onUnavailable) {
    if (conn.closed) {
      const replacement = await reopen();
      if (replacement.availability !== "ready") throw failure();
      return replacement.view.subscribe(frame, onUnavailable);
    }
    const selected = unusedViewId ? { type: "view" as const, availability: "ready" as const, viewId: unusedViewId } : await conn.request(request, "open");
    unusedViewId = undefined;
    if (selected.type !== "view" || selected.availability !== "ready") throw failure();
    const viewId = selected.viewId, stream = subscribedStream(conn, viewId, frame, onUnavailable, observe);
    try { await acknowledged(conn, id => ({ type: "subscribe", id, viewId }), "subscribe", observe); }
    catch { conn.unsubscribe(viewId); throw failure(); }
    return stream;
  } };
}

/** Lazy fixed private socket. No browser URL, token or arbitrary RPC on this API. */
export function createScienceHostClient({ privateDir, observe }: { privateDir: string; observe?: ScienceHostObserver }): ScienceViewHost & ScienceInstancesHost & { dispose(): void } {
  scienceHostPaths(privateDir);
  const lifecycle = new AbortController();
  let connection: Connection | undefined, connecting: Promise<Connection> | undefined, disposed = false;
  const current = async () => {
    if (disposed) throw failure();
    if (connection && !connection.closed) return connection;
    if (!connecting) connecting = connect(privateDir, observe, lifecycle.signal).then(value => { connection = value; return value; }).finally(() => { connecting = undefined; });
    return connecting;
  };
  const readRecords = async (partition: ScienceViewPartition, type: RecordsRequest["type"], expected: ScienceHostRecordsReply["type"], instanceId?: string, artifactId?: string): Promise<ScienceHostRecordsReply | ScienceReadUnavailable> => {
    if (!validReadSelection(partition, type, instanceId, artifactId)) return { availability: "unavailable", reason: "binding-unavailable" };
    const selected = { ownerKey: partition.ownerKey, cwd: partition.cwd }, started = Date.now(), requestId = hostRequestId();
    try {
      const conn = await current(); if (disposed) throw failure();
      const result = await conn.request(id => recordRequest(type, id, selected, instanceId, artifactId));
      if (result.type !== expected) return invalidHostRead();
      const reply = result as ScienceHostRecordsReply;
      observeHost(observe, "client", requestId, type, reply.result.availability === "ready" ? "ok" : reply.result.availability, reply.result.availability === "ready" ? "none" : "binding", started);
      return reply;
    } catch { observeHost(observe, "client", requestId, type, "unknown", "transport", started); return { availability: "unknown", reason: "host-offline" }; }
  };
  async function open(partition: ScienceViewPartition, instanceId?: string): Promise<ScienceHostOpenResult> {
    const started = Date.now(), requestId = hostRequestId();
    if (!validSelection(partition, instanceId)) return { availability: "unavailable", reason: "binding-unavailable" };
    try {
      const conn = await current(); if (disposed) throw failure();
      const request = (id: number) => ({ type: "open" as const, id, partition: { cwd: partition.cwd, ownerKey: partition.ownerKey }, ...(instanceId ? { instanceId } : {}) });
      const result = await conn.request(request, "open");
      if (result.type !== "view") throw failure();
      observeHost(observe, "client", requestId, "open", result.availability === "ready" ? "ok" : result.availability, result.availability === "ready" ? "none" : "binding", started);
      if (result.availability !== "ready") return { availability: result.availability, reason: result.reason };
      const view = hostView(conn, result.viewId, request, () => open(partition, instanceId), observe);
      return { availability: "ready", view };
    } catch { observeHost(observe, "client", requestId, "open", "unknown", "transport", started); return { availability: "unknown", reason: "host-offline" }; }
  }
  return {
    openWorkspace: partition => open(partition), openTask: (partition, instanceId) => open(partition, instanceId),
    async list(partition) { const reply = await readRecords(partition, "instances-list", "instances"); return "type" in reply && reply.type === "instances" ? hostListResult(reply.result) : readUnavailable(reply); },
    async detail(partition, instanceId) { const reply = await readRecords(partition, "instance-detail", "instance", instanceId); return "type" in reply && reply.type === "instance" ? hostDetailResult(reply.result, instanceId) : readUnavailable(reply); },
    async readArtifact(partition, instanceId, artifactId) { const reply = await readRecords(partition, "artifact-read", "artifact", instanceId, artifactId); return "type" in reply && reply.type === "artifact" ? hostArtifactRead(reply.result, artifactId) : readUnavailable(reply); },
    dispose() { disposed = true; lifecycle.abort(); connection?.socket.destroy(); void connecting?.then(value => value.socket.destroy(), () => {}); },
  };
}
function readUnavailable(reply: ScienceHostRecordsReply | ScienceReadUnavailable): ScienceReadUnavailable { return "type" in reply ? invalidHostRead() : reply; }
function recordRequest(type: RecordsRequest["type"], id: number, partition: ScienceViewPartition, instanceId?: string, artifactId?: string): RecordsRequest {
  switch (type) {
    case "instances-list": return { type, id, partition };
    case "instance-detail": return { type, id, partition, instanceId: instanceId! };
    case "artifact-read": return { type, id, partition, instanceId: instanceId!, artifactId: artifactId! };
  }
}
