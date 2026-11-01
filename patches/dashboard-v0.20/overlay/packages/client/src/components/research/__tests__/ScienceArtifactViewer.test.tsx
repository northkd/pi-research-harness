import { createHash, webcrypto } from "node:crypto";
import { PluginContextProvider } from "@blackbelt-technology/dashboard-plugin-runtime";
import { scienceArtifactTabPath } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScienceArtifactViewer } from "../ScienceArtifactViewer.js";

const TASK = "si-00000000-0000-4000-8000-000000000001";
const ARTIFACT = "sa-00000000-0000-4000-8000-000000000002";
const path = scienceArtifactTabPath(TASK, ARTIFACT);
const content = "value\n1\n2\n3\n<script>unsafe()</script>";
const artifact = { id: ARTIFACT, name: "values.csv", mediaType: "text/csv", bytes: Buffer.byteLength(content), sha256: createHash("sha256").update(content).digest("hex") };
const detail = { availability: "ready", instance: { id: TASK, status: "completed", createdAt: 1000, lastObservedAt: 2000, stale: false, modelIds: [], usage: null, cost: null, artifacts: [artifact] } };
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
// Node's Response(string) yields Node-realm chunks under jsdom. Real browser
// fetch chunks share Uint8Array's realm; construct that exact fixture contract.
const raw = (data = content, meta = artifact) => new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(Buffer.from(data))); controller.close(); } }), { headers: { "content-type": meta.mediaType, "content-length": String(Buffer.byteLength(data)), "x-science-artifact-sha256": meta.sha256 } });
const fetchMock = vi.fn<typeof fetch>();
const createUrl = vi.fn(() => "blob:fixture-private-artifact");
const revokeUrl = vi.fn();
beforeEach(() => {
  localStorage.clear(); fetchMock.mockReset(); createUrl.mockClear(); revokeUrl.mockClear();
  vi.stubGlobal("fetch", fetchMock); vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("URL", class extends URL { static createObjectURL = createUrl; static revokeObjectURL = revokeUrl; });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

type ConnectionStatus = "connected" | "disconnected";
const fakeSocket = () => new EventTarget() as unknown as WebSocket;
function Preview({ cwd = "/fixture", socket, status = "connected", commit }: { cwd?: string; socket: WebSocket; status?: ConnectionStatus; commit?: (visible: boolean) => void }) {
  // Observe committed DOM before passive effects can hide an unsafe frame.
  useLayoutEffect(() => { commit?.(screen.queryByTestId("science-artifact-text") !== null); });
  return <PluginContextProvider ws={socket} connectionStatus={status}><ScienceArtifactViewer cwd={cwd} path={path} /></PluginContextProvider>;
}

describe("registry-scoped Science artifact preview", () => {
  it("does not resurrect bytes when scope returns A to B to A before fresh authorization", async () => {
    const socket = fakeSocket(); const commits: boolean[] = [];
    const commit = (visible: boolean) => { commits.push(visible); };
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(raw());
    const r = render(<Preview socket={socket} commit={commit} />);
    await screen.findByTestId("science-artifact-text");
    fetchMock.mockImplementation(() => new Promise(() => {}));
    r.rerender(<Preview cwd="/other" socket={socket} commit={commit} />);
    expect(screen.queryByTestId("science-artifact-text")).toBeNull();
    expect(revokeUrl).toHaveBeenCalledWith("blob:fixture-private-artifact");
    r.rerender(<Preview socket={socket} commit={commit} />);
    expect(commits.slice(-2)).toEqual([false, false]);
    expect(screen.queryByTestId("science-artifact-text")).toBeNull();
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it("does not resurrect a failure state when scope returns A to B to A", async () => {
    fetchMock.mockResolvedValueOnce(json({ availability: "unavailable", reason: "binding-unavailable" }));
    const r = render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    fetchMock.mockImplementation(() => new Promise(() => {}));
    r.rerender(<ScienceArtifactViewer cwd="/other" path={path} />);
    r.rerender(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    expect(screen.getByRole("status").textContent).toContain("Reading");
    expect((screen.getByRole("button", { name: "Reload artifact" }) as HTMLButtonElement).disabled).toBe(true);
  });
  it.each(["socket", "status"] as const)("clears blobs when connection identity changes through %s and does not reuse them on return", async change => {
    const socket = fakeSocket(); const other = fakeSocket(); const commits: boolean[] = [];
    const commit = (visible: boolean) => { commits.push(visible); };
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(raw());
    const r = render(<Preview socket={socket} commit={commit} />);
    await screen.findByTestId("science-artifact-text");
    fetchMock.mockImplementation(() => new Promise(() => {}));
    r.rerender(<Preview socket={change === "socket" ? other : socket} status={change === "status" ? "disconnected" : "connected"} commit={commit} />);
    expect(screen.queryByTestId("science-artifact-text")).toBeNull();
    expect(revokeUrl).toHaveBeenCalledOnce();
    r.rerender(<Preview socket={socket} commit={commit} />);
    expect(commits.slice(-2)).toEqual([false, false]);
    expect(screen.queryByRole("link", { name: "Download" })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
  it.each(["bytes", "error"] as const)("ignores a late response containing %s from a replaced connection", async outcome => {
    const socket = fakeSocket(); let finish!: (response: Response) => void; let fail!: (error: Error) => void;
    fetchMock.mockResolvedValueOnce(json(detail)).mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const r = render(<Preview socket={socket} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const oldSignal = fetchMock.mock.calls[1][1]?.signal;
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(raw());
    r.rerender(<Preview socket={fakeSocket()} />);
    await screen.findByTestId("science-artifact-text");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => { if (outcome === "bytes") finish(raw()); else fail(new Error("private fixture detail")); });
    expect(createUrl).toHaveBeenCalledOnce(); expect(revokeUrl).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("verified");
    expect(screen.getByTestId("science-artifact-text").textContent).toBe(content);
    expect(document.body.textContent).not.toContain("private fixture detail");
    r.unmount(); expect(revokeUrl).toHaveBeenCalledOnce();
  });
  it("retains a verified blob without another request while scope and connection are unchanged", async () => {
    const socket = fakeSocket();
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(raw());
    const r = render(<Preview socket={socket} />);
    await screen.findByTestId("science-artifact-text");
    r.rerender(<Preview socket={socket} />);
    expect(fetchMock).toHaveBeenCalledTimes(2); expect(createUrl).toHaveBeenCalledOnce(); expect(revokeUrl).not.toHaveBeenCalled();
  });
  it("uses fixture binary primitives from a compatible realm", async () => {
    const response = raw();
    const chunk = (await response.body!.getReader().read()).value!;
    expect(chunk instanceof Uint8Array).toBe(true);
    expect(globalThis.crypto.subtle).toBeTruthy();
    await expect(crypto.subtle.digest("SHA-256", new Uint8Array(artifact.bytes))).resolves.toBeDefined();
  });
  it("rejects malformed targets before any HTTP request", () => {
    render(<ScienceArtifactViewer cwd="/fixture" path="science:artifact:../../private" />);
    expect(screen.getByRole("status").textContent).toContain("Invalid"); expect(fetchMock).not.toHaveBeenCalled();
  });
  it("reads only bound metadata and bytes, renders text inertly, and releases its blob on close", async () => {
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(raw());
    const r = render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await screen.findByTestId("science-artifact-text");
    expect(screen.getByTestId("science-artifact-text").textContent).toBe(content);
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByRole("link", { name: "Download" }).getAttribute("href")).toBe("blob:fixture-private-artifact");
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      `/api/res-workflow/science/instances/${TASK}?cwd=%2Ffixture`,
      `/api/res-workflow/science/instances/${TASK}/artifacts/${ARTIFACT}?cwd=%2Ffixture`,
    ]);
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === "GET")).toBe(true);
    r.unmount(); expect(revokeUrl).toHaveBeenCalledWith("blob:fixture-private-artifact");
  });
  it("never exposes a blob or raw error for mismatched content, type or hash", async () => {
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(raw("different"));
    render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    expect(createUrl).not.toHaveBeenCalled(); expect(screen.queryByRole("link")).toBeNull();
  });
  it("uses the server-verified hash and bounded body when WebCrypto is unavailable on plain HTTP", async () => {
    vi.stubGlobal("crypto", {});
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(raw());
    render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await screen.findByTestId("science-artifact-text"); expect(createUrl).toHaveBeenCalledOnce();
  });
  it.each(["missing-hash", "wrong-hash", "wrong-type", "wrong-length"])("rejects %s even without WebCrypto", async kind => {
    vi.stubGlobal("crypto", {});
    const response = kind === "wrong-length" ? raw("short") : raw();
    if (kind === "missing-hash") response.headers.delete("x-science-artifact-sha256");
    if (kind === "wrong-hash") response.headers.set("x-science-artifact-sha256", "b".repeat(64));
    if (kind === "wrong-type") response.headers.set("content-type", "text/html");
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(response);
    render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable")); expect(createUrl).not.toHaveBeenCalled();
  });
  it("cancels rejected or oversized bodies instead of retaining an open response stream", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(artifact.bytes + 1)); }, cancel }), { headers: { "content-type": "text/csv", "x-science-artifact-sha256": artifact.sha256 } });
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(response);
    render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    expect(cancel).toHaveBeenCalledOnce(); expect(createUrl).not.toHaveBeenCalled();
  });
  it("cancels a body rejected by its response metadata before attempting to read bytes", async () => {
    const cancel = vi.fn();
    const response = new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/html" } });
    fetchMock.mockResolvedValueOnce(json(detail)).mockResolvedValueOnce(response);
    render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    expect(cancel).toHaveBeenCalledOnce(); expect(createUrl).not.toHaveBeenCalled();
  });
  it("drops old bytes on cwd change and ignores an in-flight response from the old partition", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(json(detail)).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const r = render(<ScienceArtifactViewer cwd="/fixture" path={path} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fetchMock.mockResolvedValueOnce(json({ availability: "unavailable", reason: "binding-unavailable" }));
    r.rerender(<ScienceArtifactViewer cwd="/other" path={path} />);
    await act(async () => finish(raw()));
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("unavailable"));
    expect(createUrl).not.toHaveBeenCalled(); expect(screen.queryByTestId("science-artifact-text")).toBeNull();
  });
});
