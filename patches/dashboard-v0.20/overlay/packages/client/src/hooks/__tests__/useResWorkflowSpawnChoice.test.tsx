import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getResWorkflowConnection } from "../../lib/api/res-workflow-api.js";
import { setGlobalApiBase } from "../../lib/api/api-context.js";
import { useResWorkflowSpawnChoice } from "../useResWorkflowSpawnChoice.js";

vi.mock("../../lib/api/res-workflow-api.js", () => ({ getResWorkflowConnection: vi.fn() }));
const connection = vi.mocked(getResWorkflowConnection);
const folder = "/folder/L3A";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function setup() {
  const onSpawnSession = vi.fn(() => "exact-request");
  const onOpenFolder = vi.fn();
  const onDispatchError = vi.fn();
  const initialProps = { apiBase: "", connectionKey: "owner-socket-1", viewKey: "/session/source" };
  const hook = renderHook(props => useResWorkflowSpawnChoice({ ...props, onSpawnSession, onOpenFolder, onDispatchError }), { initialProps });
  return { ...hook, onSpawnSession, onOpenFolder, onDispatchError, initialProps };
}

beforeEach(() => { setGlobalApiBase(""); connection.mockReset(); });
afterEach(() => { cleanup(); setGlobalApiBase(""); });

describe("manual new-session res-workflow choice", () => {
  it("does no background metadata read or spawn", () => {
    const { result, onSpawnSession } = setup();
    expect(result.current.choice).toBeNull();
    expect(connection).not.toHaveBeenCalled();
    expect(onSpawnSession).not.toHaveBeenCalled();
  });

  it("preserves ordinary cwd-only calls and actual requestId when the directory is not connected", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: false });
    const { result, onSpawnSession, onOpenFolder } = setup();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p"); });
    expect(await pending).toBe("exact-request");
    expect(onSpawnSession).toHaveBeenCalledExactlyOnceWith("/p");
    expect(onOpenFolder).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.choice).toBeNull());
  });

  it("waits for explicit join, preserving prompt/model/thinking/agent/proposal/focus with one spawn", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: true });
    const { result, onSpawnSession, onOpenFolder, rerender, initialProps } = setup();
    const opts = { initialPrompt: "private draft", model: "physical/id", thinkingLevel: "high", agent: "fixture-agent", focus: false };
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p", "proposal", opts); });
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    expect(onSpawnSession).not.toHaveBeenCalled();
    expect(onOpenFolder).toHaveBeenCalledExactlyOnceWith("/p");
    rerender({ ...initialProps, viewKey: folder });
    act(() => { result.current.choose(true); result.current.choose(true); });
    expect(await pending).toBe("exact-request");
    expect(onSpawnSession).toHaveBeenCalledExactlyOnceWith("/p", "proposal", { ...opts, joinResWorkflow: true });
    expect(result.current.choice).toBeNull();
  });

  it("keeps an existing research creation pane instead of remounting the mobile composer", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: true });
    const { result, rerender, initialProps, onOpenFolder, onSpawnSession } = setup();
    rerender({ ...initialProps, viewKey: `${folder}/research` });
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p", undefined, { initialPrompt: "mobile draft", model: "physical/id" }); });
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    expect(onOpenFolder).not.toHaveBeenCalled();
    act(() => { result.current.cancel(); });
    expect(await pending).toBeUndefined();
    expect(onSpawnSession).not.toHaveBeenCalled();
  });

  it("ordinary selection carries no membership flag", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: true });
    const { result, onSpawnSession } = setup();
    const opts = { model: "physical/id", initialPrompt: "keep" };
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p", undefined, opts); });
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    act(() => { result.current.choose(false); });
    expect(await pending).toBe("exact-request");
    expect(onSpawnSession).toHaveBeenCalledExactlyOnceWith("/p", undefined, opts);
  });

  it("cancel resolves the pending composer without spawning and reentry reads fresh metadata", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: true });
    const { result, onSpawnSession } = setup();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p"); });
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    act(() => { result.current.cancel(); });
    expect(await pending).toBeUndefined();
    expect(onSpawnSession).not.toHaveBeenCalled();
    act(() => { pending = result.current.requestNewSession("/p"); });
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    expect(connection).toHaveBeenCalledTimes(2);
    act(() => { result.current.cancel(); });
    await pending;
  });

  it("deduplicates same-cwd clicks while metadata is pending", async () => {
    const read = deferred<{ cwd: string; adopted: boolean }>();
    connection.mockReturnValue(read.promise);
    const { result, onSpawnSession } = setup();
    let one!: Promise<string | undefined>, two!: Promise<string | undefined>;
    act(() => { one = result.current.requestNewSession("/p"); two = result.current.requestNewSession("/p"); });
    expect(one).toBe(two);
    expect(connection).toHaveBeenCalledTimes(1);
    await act(async () => { read.resolve({ cwd: "/p", adopted: false }); await one; });
    expect(onSpawnSession).toHaveBeenCalledTimes(1);
  });

  it("keeps failed metadata explicit, refuses join and permits an explicit ordinary escape", async () => {
    connection.mockRejectedValue(new Error("metadata unavailable"));
    const { result, onSpawnSession, onOpenFolder } = setup();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p"); });
    await waitFor(() => expect(result.current.choice).toMatchObject({ status: "error", error: "metadata unavailable" }));
    expect(onOpenFolder).toHaveBeenCalledWith("/p");
    act(() => { result.current.choose(true); });
    expect(onSpawnSession).not.toHaveBeenCalled();
    act(() => { result.current.choose(false); });
    expect(await pending).toBe("exact-request");
    expect(onSpawnSession).toHaveBeenCalledExactlyOnceWith("/p");
  });

  it("retry only rereads connection metadata, never creates a second request or an automatic join", async () => {
    connection.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ cwd: "/p", adopted: true });
    const { result, onSpawnSession } = setup();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p"); });
    await waitFor(() => expect(result.current.choice?.status).toBe("error"));
    act(() => { result.current.retry(); result.current.retry(); });
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    expect(connection).toHaveBeenCalledTimes(2);
    expect(onSpawnSession).not.toHaveBeenCalled();
    act(() => { result.current.cancel(); });
    expect(await pending).toBeUndefined();
  });

  it("abandons a pending different-cwd intent and ignores its late result", async () => {
    const old = deferred<{ cwd: string; adopted: boolean }>();
    connection.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ cwd: "/other", adopted: true });
    const { result, onSpawnSession, onOpenFolder } = setup();
    let one!: Promise<string | undefined>, two!: Promise<string | undefined>;
    act(() => { one = result.current.requestNewSession("/p"); two = result.current.requestNewSession("/other"); });
    expect(await one).toBeUndefined();
    await waitFor(() => expect(result.current.choice).toMatchObject({ cwd: "/other", status: "choice" }));
    await act(async () => { old.resolve({ cwd: "/p", adopted: false }); await old.promise; });
    expect(onSpawnSession).not.toHaveBeenCalled();
    expect(onOpenFolder).toHaveBeenCalledExactlyOnceWith("/other");
    act(() => { result.current.cancel(); });
    await two;
  });

  it.each(["api", "connection", "view"])("fences late metadata after a %s identity switch", async kind => {
    const read = deferred<{ cwd: string; adopted: boolean }>();
    connection.mockReturnValue(read.promise);
    const { result, rerender, initialProps, onSpawnSession, onOpenFolder } = setup();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p"); });
    const signal = connection.mock.calls[0]?.[1];
    const props = { ...initialProps, ...(kind === "api" ? { apiBase: "https://other.invalid" } : kind === "connection" ? { connectionKey: "owner-socket-2" } : { viewKey: "/folder/other" }) };
    if (kind === "api") setGlobalApiBase(props.apiBase);
    rerender(props);
    expect(await pending).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    await act(async () => { read.resolve({ cwd: "/p", adopted: false }); await read.promise; });
    expect(result.current.choice).toBeNull();
    expect(onSpawnSession).not.toHaveBeenCalled();
    expect(onOpenFolder).not.toHaveBeenCalled();
  });

  it("locks the view fence after its own navigation, so returning to the old session cancels the choice", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: true });
    const { result, rerender, initialProps, onSpawnSession } = setup();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p"); });
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    rerender({ ...initialProps, viewKey: folder });
    expect(result.current.choice?.status).toBe("choice");
    rerender(initialProps);
    expect(await pending).toBeUndefined();
    act(() => { result.current.choose(true); });
    expect(result.current.choice).toBeNull();
    expect(onSpawnSession).not.toHaveBeenCalled();
  });

  it("freezes the click's choices and never accepts a caller-supplied join flag as authorization", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: true });
    const { result, onSpawnSession } = setup();
    const opts = { initialPrompt: "original", model: "physical/one", joinResWorkflow: true as const };
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p", undefined, opts); });
    opts.initialPrompt = "later mutation";
    await waitFor(() => expect(result.current.choice?.status).toBe("choice"));
    expect(onSpawnSession).not.toHaveBeenCalled();
    act(() => { result.current.choose(false); });
    expect(await pending).toBe("exact-request");
    expect(onSpawnSession).toHaveBeenCalledExactlyOnceWith("/p", undefined, { initialPrompt: "original", model: "physical/one" });
  });

  it("settles an unexpected dispatch exception without retrying or losing the pending composer", async () => {
    connection.mockResolvedValue({ cwd: "/p", adopted: false });
    const { result, onSpawnSession, onDispatchError } = setup();
    onSpawnSession.mockImplementation(() => { throw new Error("dispatch failed"); });
    let pending!: Promise<string | undefined>;
    await act(async () => { pending = result.current.requestNewSession("/p"); await pending; });
    expect(await pending).toBeUndefined();
    expect(onDispatchError).toHaveBeenCalledOnce();
    expect(onSpawnSession).toHaveBeenCalledTimes(1);
    expect(result.current.choice).toBeNull();
  });

  it("unmount aborts pending metadata and resolves cancellation without a spawn", async () => {
    const read = deferred<{ cwd: string; adopted: boolean }>();
    connection.mockReturnValue(read.promise);
    const { result, unmount, onSpawnSession } = setup();
    let pending!: Promise<string | undefined>;
    act(() => { pending = result.current.requestNewSession("/p"); });
    const signal = connection.mock.calls[0]?.[1];
    unmount();
    expect(await pending).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    read.resolve({ cwd: "/p", adopted: false });
    expect(onSpawnSession).not.toHaveBeenCalled();
  });
});
