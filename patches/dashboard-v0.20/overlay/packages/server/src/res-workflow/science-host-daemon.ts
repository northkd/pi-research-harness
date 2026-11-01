import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, type FileHandle, link, lstat, open, realpath, unlink } from "node:fs/promises";
import net, { type Socket } from "node:net";
import { readScienceHostSecret, scienceHostPaths, sciencePrivateDirectory } from "@blackbelt-technology/pi-dashboard-shared/science-host-files.js";
import { hostArtifactResult, hostDetailResult, hostListResult } from "@blackbelt-technology/pi-dashboard-shared/science-host-records.js";
import { clientPacket, encodeHostPacket, hostChallenge, hostFrame, hostRequestId, observeHost, SCIENCE_HOST_AUTH_LIMIT, SCIENCE_HOST_MAX_PACKET, SCIENCE_HOST_MAX_REQUEST, type ScienceHostClientPacket, ScienceHostDecoder, type ScienceHostObserver, type ScienceHostPartitionAccess, type ScienceHostServerPacket, serverPacket, verifyHostProof } from "@blackbelt-technology/pi-dashboard-shared/science-host-transport.js";
import type { ScienceInstancesHost, ScienceReadUnavailable } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import type { ScienceHostView, ScienceViewFrame, ScienceViewHost, ScienceViewPartition, ScienceViewSubscription } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";

interface View {
  access: ScienceHostPartitionAccess; view: ScienceHostView; active: boolean; generation: number; expiresAt: number;
  stream?: ScienceViewSubscription; latest?: ScienceViewFrame; draining: boolean;
}
type ViewPacket = Extract<ScienceHostClientPacket, { type: "subscribe" | "input" }>;
type OpenPacket = Extract<ScienceHostClientPacket, { type: "open" }>;
type RequestPacket = Exclude<ScienceHostClientPacket, { type: "auth" }>;
type RecordsPacket = Extract<RequestPacket, { type: "instances-list" | "instance-detail" | "artifact-read" }>;
export interface ScienceHostDaemonDeps {
  privateDir: string;
  host?: ScienceViewHost;
  /** Reads from the same host-owned registry. No second writer or task driver. */
  instancesHost?: ScienceInstancesHost;
  observe?: ScienceHostObserver;
  /** Authority callback, supplied by the host's registry. Client owner/cwd are selectors only. */
  accessFor?(partition: ScienceViewPartition): Promise<ScienceHostPartitionAccess | null>;
}
/** Independent listener; neither disconnect nor close invokes Science stop/cancel. */
export function createScienceHostDaemon(deps: ScienceHostDaemonDeps) {
  scienceHostPaths(deps.privateDir);
  const sockets = new Set<Socket>();
  let server: net.Server | undefined, secret: Buffer | undefined, ownedSocket: { ino: number; dev: number } | undefined, directory: FileHandle | undefined;
  const same = (a: { ino: number; dev: number }, b: { ino: number; dev: number }) => a.ino === b.ino && a.dev === b.dev;
  const check = async (access: ScienceHostPartitionAccess) => {
    if (await realpath(access.cwd) !== access.cwd || !(await lstat(access.cwd)).isDirectory()) throw new Error("science-binding-unavailable");
    await access.revalidate();
  };
  const noExistingSocket = async (path: string) => {
    const existing = await lstat(path).catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (existing) throw new Error("science-host-socket-exists");
  };
  const bindSocket = async (path: string) => {
    server = net.createServer(accept);
    await new Promise<void>((resolve, reject) => { server!.once("error", reject); server!.listen(path, () => { server!.off("error", reject); resolve(); }); });
    const bound = await lstat(path);
    if (!bound.isSocket() || bound.uid !== process.getuid?.()) throw new Error("science-host-private-socket");
    await chmod(path, 0o600);
    const current = await lstat(path);
    if (!current.isSocket() || !same(bound, current) || current.uid !== process.getuid?.() || (current.mode & 0o777) !== 0o600) throw new Error("science-host-private-socket");
    return current;
  };
  const stopListener = async () => {
    const instance = server; server = undefined;
    if (instance) await new Promise<void>(resolve => instance.close(() => resolve()));
  };
  function accept(socket: Socket) {
    if (!secret || sockets.size >= 8) { socket.destroy(); return; }
    sockets.add(socket);
    const challenge = hostChallenge(secret); let authenticated = false, lastId = 0, pending = 0, closed = false;
    const connectionId = hostRequestId(), started = Date.now();
    let tail = Promise.resolve();
    const views = new Map<string, View>();
    const timer = setTimeout(() => socket.destroy(), 5000); timer.unref();
    const send = (packet: ScienceHostServerPacket) => {
      if (!serverPacket(packet)) { socket.destroy(); return; }
      if (closed || socket.destroyed) return;
      if (socket.writableLength > SCIENCE_HOST_MAX_PACKET) { if (packet.type !== "frame") socket.destroy(); return; }
      socket.write(encodeHostPacket(packet));
    };
    const end = (view: View) => { view.active = false; view.latest = undefined; const stream = view.stream; view.stream = undefined; try { stream?.unsubscribe(); } catch { /* Local detach only. */ } };
    const currentGeneration = (view: View, generation: number | undefined) => view.active && view.generation === generation;
    const assertUnexpired = (view: View) => {
      if (Date.now() >= view.expiresAt) { end(view); throw new Error("science-binding-expired"); }
    };
    const framePending = (view: View, generation: number) => !closed && currentGeneration(view, generation) && !!view.latest;
    const sendCheckedFrame = (viewId: string, view: View, generation: number, frame: ScienceViewFrame) => {
      if (currentGeneration(view, generation) && Date.now() < view.expiresAt) send({ type: "frame", viewId, frame });
    };
    const flush = async (viewId: string, view: View, generation: number) => {
      if (view.draining || !view.stream) return;
      view.draining = true;
      try {
        while (framePending(view, generation)) {
          const frame = view.latest!; view.latest = undefined; await check(view.access);
          sendCheckedFrame(viewId, view, generation, frame);
        }
      } catch { end(view); } finally { view.draining = false; }
    };
    const selectedAccess = async (selected: ScienceViewPartition) => {
      const access = await deps.accessFor!({ ownerKey: selected.ownerKey, cwd: selected.cwd });
      if (!access || access.ownerKey !== selected.ownerKey || access.cwd !== selected.cwd) throw new Error("science-binding-unavailable");
      await check(access); return access;
    };
    const unavailableRecords = (packet: RecordsPacket, result: ScienceReadUnavailable) => {
      switch (packet.type) {
        case "instances-list": send({ type: "instances", id: packet.id, result }); return;
        case "instance-detail": send({ type: "instance", id: packet.id, result }); return;
        case "artifact-read": send({ type: "artifact", id: packet.id, result }); return;
      }
    };
    const readRecords = async (packet: RecordsPacket, partition: ScienceViewPartition): Promise<ScienceHostServerPacket> => {
      const host = deps.instancesHost!;
      switch (packet.type) {
        case "instances-list": return { type: "instances", id: packet.id, result: hostListResult(await host.list(partition)) };
        case "instance-detail": return { type: "instance", id: packet.id, result: hostDetailResult(await host.detail(partition, packet.instanceId), packet.instanceId) };
        case "artifact-read": return { type: "artifact", id: packet.id, result: hostArtifactResult(await host.readArtifact(partition, packet.instanceId, packet.artifactId), packet.artifactId) };
      }
    };
    const handleRecords = async (packet: RecordsPacket) => {
      if (!deps.accessFor) { unavailableRecords(packet, { availability: "unavailable", reason: "binding-unavailable" }); return; }
      if (!deps.instancesHost) { unavailableRecords(packet, { availability: "unavailable", reason: "host-unconfigured" }); return; }
      const access = await selectedAccess(packet.partition);
      const result = await readRecords(packet, { ownerKey: access.ownerKey, cwd: access.cwd });
      await check(access); send(result);
    };
    const expireViews = () => {
      for (const [viewId, view] of views) if (Date.now() >= view.expiresAt) { end(view); views.delete(viewId); }
    };
    const openUnavailable = () => {
      if (!deps.accessFor) return "binding-unavailable" as const;
      if (!deps.host) return "host-unconfigured" as const;
      if (views.size >= 32) return "busy" as const;
      return null;
    };
    const openBoundHost = (packet: OpenPacket, access: ScienceHostPartitionAccess) => {
      const partition = { ownerKey: access.ownerKey, cwd: access.cwd };
      return packet.instanceId ? deps.host!.openTask!(partition, packet.instanceId) : deps.host!.openWorkspace(partition);
    };
    const openView = async (packet: OpenPacket) => {
      expireViews(); const reason = openUnavailable();
      if (reason) { send({ type: "view", id: packet.id, availability: "unavailable", reason }); return; }
      const access = await selectedAccess(packet.partition);
      if (packet.instanceId && !deps.host!.openTask) { send({ type: "view", id: packet.id, availability: "unavailable", reason: "binding-unavailable" }); return; }
      const result = await openBoundHost(packet, access);
      await check(access);
      if (closed) return;
      if (result.availability !== "ready") { send({ type: "view", id: packet.id, availability: result.availability, reason: result.reason }); return; }
      const viewId = `hv-${randomBytes(24).toString("hex")}`;
      views.set(viewId, { access, view: result.view, active: false, generation: 0, expiresAt: Date.now() + 5 * 60_000, draining: false });
      send({ type: "view", id: packet.id, availability: "ready", viewId });
    };
    const inputView = async (packet: Extract<ViewPacket, { type: "input" }>, view: View, arrivalGeneration?: number) => {
      if (!view.active || !view.stream) throw new Error("science-binding-unavailable");
      await check(view.access); assertUnexpired(view);
      if (currentGeneration(view, arrivalGeneration)) { await view.stream!.input(packet.input); send({ type: "ack", id: packet.id, ok: true }); }
      else send({ type: "ack", id: packet.id, ok: false });
    };
    const receiveFrame = (viewId: string, view: View, generation: number, value: ScienceViewFrame) => {
      const frame = hostFrame(value);
      if (frame && currentGeneration(view, generation)) { view.latest = frame; void flush(viewId, view, generation); }
    };
    const lostView = (viewId: string, view: View, generation: number) => {
      if (!currentGeneration(view, generation)) return;
      end(view); send({ type: "unavailable", viewId });
    };
    const subscriptionStale = (view: View, generation: number) => !currentGeneration(view, generation) || closed;
    const subscribeView = async (packet: Extract<ViewPacket, { type: "subscribe" }>, view: View, arrivalGeneration?: number) => {
      if (closed) return;
      assertUnexpired(view);
      if (arrivalGeneration !== view.generation) { send({ type: "ack", id: packet.id, ok: false }); return; }
      if (view.active) { send({ type: "ack", id: packet.id, ok: true }); return; }
      view.active = true; const generation = view.generation;
      const stream = await view.view.subscribe(value => receiveFrame(packet.viewId, view, generation, value), () => lostView(packet.viewId, view, generation));
      if (subscriptionStale(view, generation)) { stream.unsubscribe(); send({ type: "ack", id: packet.id, ok: false }); return; }
      view.stream = stream; await check(view.access); assertUnexpired(view);
      if (subscriptionStale(view, generation)) { end(view); send({ type: "ack", id: packet.id, ok: false }); return; }
      send({ type: "ack", id: packet.id, ok: true }); void flush(packet.viewId, view, generation);
    };
    const presentView = (viewId: string) => {
      const view = views.get(viewId);
      if (!view || Date.now() >= view.expiresAt) throw new Error("science-binding-unavailable");
      return view;
    };
    const unsubscribeView = async (packet: Extract<RequestPacket, { type: "unsubscribe" }>) => {
      const view = presentView(packet.viewId);
      try { await check(view.access); } finally { if (views.get(packet.viewId) === view) views.delete(packet.viewId); }
    };
    const checkedView = async (packet: ViewPacket, arrivalGeneration?: number) => {
      const view = presentView(packet.viewId);
      await check(view.access); assertUnexpired(view);
      if (closed) return null;
      if (arrivalGeneration !== view.generation) { send({ type: "ack", id: packet.id, ok: false }); return null; }
      return view;
    };
    const handleView = async (packet: ViewPacket, arrivalGeneration?: number) => {
      const view = await checkedView(packet, arrivalGeneration);
      if (!view) return;
      if (packet.type === "input") await inputView(packet, view, arrivalGeneration);
      else await subscribeView(packet, view, arrivalGeneration);
    };
    const handle = async (packet: RequestPacket, arrivalGeneration?: number) => {
      if (closed) return;
      switch (packet.type) {
        case "open": await openView(packet); return;
        case "unsubscribe": await unsubscribeView(packet); return;
        case "input": case "subscribe": await handleView(packet, arrivalGeneration); return;
        case "instances-list": case "instance-detail": case "artifact-read": await handleRecords(packet); return;
      }
    };
    const failedRequest = (value: RequestPacket, requestId: string, callStarted: number) => {
      observeHost(deps.observe, "daemon", requestId, value.type, "denied", "binding", callStarted);
      if (value.type === "open") send({ type: "view", id: value.id, availability: "unavailable", reason: "binding-unavailable" });
      else if ("partition" in value) unavailableRecords(value, { availability: "unavailable", reason: "binding-unavailable" });
      else if (value.type !== "unsubscribe") { const view = views.get(value.viewId); if (view) end(view); send({ type: "ack", id: value.id, ok: false }); }
    };
    const enqueue = (value: RequestPacket, generation?: number) => {
      if (pending >= 64) { socket.destroy(); return; }
      pending++;
      const callStarted = Date.now(), requestId = `${connectionId}-${"id" in value ? value.id : 0}`;
      tail = tail.then(() => handle(value, generation)).then(() => { observeHost(deps.observe, "daemon", requestId, value.type, closed ? "unknown" : "ok", closed ? "transport" : "none", callStarted); }).catch(() => failedRequest(value, requestId, callStarted)).finally(() => { pending--; });
    };
    const admitRequest = (value: RequestPacket) => {
      if ("id" in value) { if (value.id <= lastId) throw new Error("science-host-replayed-request"); lastId = value.id; }
      if (!("viewId" in value)) { enqueue(value); return; }
      const view = views.get(value.viewId);
      if (value.type === "unsubscribe" && view) { end(view); view.generation++; }
      enqueue(value, view?.generation);
    };
    const authenticate = (value: ScienceHostClientPacket) => {
      if (value.type !== "auth" || !secret || !verifyHostProof(secret, "client", challenge.nonce, value.proof)) throw new Error("science-host-authentication");
      authenticated = true; clearTimeout(timer); decoder.limit = SCIENCE_HOST_MAX_REQUEST; observeHost(deps.observe, "daemon", connectionId, "auth", "ok", "none", started); send({ type: "authenticated" });
    };
    const decoder = new ScienceHostDecoder(SCIENCE_HOST_AUTH_LIMIT, value => {
      if (!clientPacket(value)) throw new Error("science-host-invalid-packet");
      if (!authenticated) { authenticate(value); return; }
      if (value.type === "auth") throw new Error("science-host-invalid-packet");
      admitRequest(value);
    });
    socket.on("data", data => { try { if (!Buffer.isBuffer(data)) throw new Error("science-host-invalid-packet"); decoder.push(data); } catch { socket.destroy(); } });
    const close = () => { if (closed) return; closed = true; observeHost(deps.observe, "daemon", connectionId, authenticated ? "close" : "auth", authenticated ? "ok" : "denied", authenticated ? "none" : "auth", started); clearTimeout(timer); sockets.delete(socket); for (const view of views.values()) end(view); views.clear(); };
    socket.on("close", close); socket.on("error", close); send(challenge);
  }
  return {
    async start() {
      if (server) throw new Error("science-host-already-started");
      try {
        const before = await sciencePrivateDirectory(deps.privateDir);
        directory = await open(deps.privateDir, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        if (!same(before, await directory.stat())) throw new Error("science-host-private-directory");
        secret = await readScienceHostSecret(deps.privateDir);
        if (!same(before, await sciencePrivateDirectory(deps.privateDir))) throw new Error("science-host-private-directory");
        const anchored = `/proc/self/fd/${directory.fd}`;
        const finalPath = `${anchored}/viewer.sock`;
        await noExistingSocket(finalPath);
        // Bind an exclusive private name; Node/libuv closes that name only.
        // Publish with link()'s no-overwrite semantics, leaving existing files intact.
        const internalPath = `${anchored}/.viewer-${randomBytes(12).toString("hex")}.sock`;
        const current = await bindSocket(internalPath);
        if (!same(before, await directory.stat())) throw new Error("science-host-private-socket");
        await link(internalPath, finalPath);
        ownedSocket = current;
      } catch (error) {
        await stopListener();
        secret?.fill(0); secret = undefined; await directory?.close(); directory = undefined;
        throw error;
      }
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await stopListener();
      const finalPath = directory ? `/proc/self/fd/${directory.fd}/viewer.sock` : undefined;
      const current = finalPath ? await lstat(finalPath).catch(() => null) : null;
      if (current?.isSocket() && current.uid === process.getuid?.() && ownedSocket && same(current, ownedSocket)) await unlink(finalPath!);
      await directory?.close(); directory = undefined; ownedSocket = undefined;
      secret?.fill(0); secret = undefined;
    },
  };
}
