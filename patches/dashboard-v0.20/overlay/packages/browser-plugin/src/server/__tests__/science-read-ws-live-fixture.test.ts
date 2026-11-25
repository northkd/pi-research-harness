/** Real ws/http libraries against synthetic loopback servers only. */
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import WebSocket, { WebSocketServer } from "ws";
import { createScienceReadWsFilter } from "../../../../server/src/res-workflow/science-read-ws.js";
import { startScienceReadonlyProxy } from "../science-readonly-proxy.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
it("handshakes through the private proxy and isolates one root using actual WS framing", async () => {
  const binding = { projectId: "proj_111111111111", taskId: "11111111-1111-4111-8111-111111111111", rootFrameId: "11111111-1111-4111-8111-111111111111", frameId: "11111111-1111-4111-8111-111111111111" };
  const upstream = http.createServer(), wsServer = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  const nativeMessages: string[] = [], browserMessages: string[] = [], requests: http.IncomingMessage[] = []; let native: WebSocket | undefined, allowed = true;
  upstream.on("upgrade", (request, socket, head) => { requests.push(request); wsServer.handleUpgrade(request, socket, head, peer => { native = peer; peer.on("message", bytes => { nativeMessages.push(bytes.toString()); }); }); });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => { for (const peer of wsServer.clients) peer.terminate(); await new Promise<void>(resolve => wsServer.close(() => resolve())); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const address = upstream.address(); if (!address || typeof address === "string") throw new Error("fixture"); const origin = `http://127.0.0.1:${address.port}`;
  const revalidate = async () => { if (!allowed) throw new Error("synthetic scope revoked"); };
  const proxy = await startScienceReadonlyProxy({ origin, resources: [], revalidate, readWebSocket: {
    assertContract: async () => {}, privateSession: async () => ({ authCookie: "host-auth", csrfCookie: "host%2541" }),
    createFilter: () => createScienceReadWsFilter({ binding, revalidate }),
  } }); cleanups.push(() => proxy.close());
  const credentials = proxy.challenge("Proxy", proxy.server); if (credentials.response !== "ProvideCredentials") throw new Error("fixture");
  const agent = new http.Agent(), proxyUrl = new URL(proxy.server), target = `${origin}/api/ws?user_id=untrusted-browser`;
  // An HTTP proxy sends absolute-form targets. This fixture adapts Node's agent only.
  const mutable = agent as unknown as { addRequest(request: http.ClientRequest, options: http.RequestOptions): void }, addRequest = mutable.addRequest.bind(agent);
  mutable.addRequest = (request, options) => { request.path = target; addRequest(request, { ...options, hostname: proxyUrl.hostname, host: proxyUrl.hostname, port: Number(proxyUrl.port) }); };
  cleanups.push(async () => { agent.destroy(); });
  const browser = new WebSocket(target.replace("http:", "ws:"), ["operon-csrf.browser-csrf"], { agent, headers: { Origin: origin, Authorization: "Bearer-browser-untrusted", "Proxy-Authorization": `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}` } });
  browser.on("message", bytes => { browserMessages.push(bytes.toString()); }); cleanups.push(async () => { browser.terminate(); });
  await new Promise<void>((resolve, reject) => { browser.once("open", resolve); browser.once("error", reject); });
  await vi.waitFor(() => expect(nativeMessages).toEqual([JSON.stringify({ type: "subscribe", root_frame_id: binding.rootFrameId })]));
  expect(requests).toHaveLength(1); expect(requests[0].url).toBe("/api/ws?explicit_subscribe=1");
  expect(requests[0].headers.cookie).toBe("operon_auth=host-auth; operon_csrf=host%2541"); expect(requests[0].headers["sec-websocket-protocol"]).toBe("operon-csrf.host%41"); expect(requests[0].headers.authorization).toBeUndefined();
  const event = { type: "text_reset", root_frame_id: binding.rootFrameId, frame_id: binding.frameId };
  native!.send(JSON.stringify({ ...event, root_frame_id: "22222222-2222-4222-8222-222222222222" })); native!.send(JSON.stringify(event));
  browser.send(JSON.stringify({ type: "approve", root_frame_id: binding.rootFrameId })); browser.send('{"type":"ping"}');
  await vi.waitFor(() => expect(browserMessages).toEqual([JSON.stringify(event)])); await vi.waitFor(() => expect(nativeMessages).toHaveLength(2)); expect(nativeMessages[1]).toBe('{"type":"ping"}');
  allowed = false; native!.send('{"type":"pong"}'); await vi.waitFor(() => expect(browser.readyState).toBe(WebSocket.CLOSED)); expect(browserMessages).toEqual([JSON.stringify(event)]);
});
