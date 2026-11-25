import type { ArchivedSessionSummary } from "@blackbelt-technology/pi-dashboard-shared/browser-protocol.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiContext, setGlobalApiBase } from "../../../lib/api/api-context.js";
import { useMobile } from "../../../hooks/useMobile.js";
import { ArchivedSessionRow } from "../../session/ArchivedSessionRow.js";
import { SessionCard } from "../../session/SessionCard.js";

vi.mock("../../../hooks/useMobile.js", () => ({ useMobile: vi.fn(() => true) }));
vi.mock("../../../lib/api/res-workflow-api.js", () => ({ joinResWorkflowSession: vi.fn() }));
vi.mock("../../../lib/openspec/openspec-config-api.js", () => ({ useOpenSpecConfig: () => ({ config: { workflows: [] } }) }));
import { joinResWorkflowSession } from "../../../lib/api/res-workflow-api.js";
const join = vi.mocked(joinResWorkflowSession);
const participation = { canonicalCwd: "/fixture", joinedAt: "2026-10-24T00:00:00Z", via: "manual" as const };
const session: DashboardSession = { id: "fixture-session", cwd: "/fixture", source: "dashboard", status: "ended", startedAt: 1 } as DashboardSession;
const archived: ArchivedSessionSummary = { id: "fixture-archive", cwd: "/fixture", groupPath: "/fixture", endedAt: 1, archivedAt: 2, sessionFile: "/fixture/opaque.jsonl" };
const props = { selectedId: undefined, onSelect: vi.fn(), now: 3, showGitInfo: false, isHidden: false, onArchive: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(useMobile).mockReturnValue(true);
  setGlobalApiBase("");
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404, headers: { "content-type": "application/json" } })));
  join.mockImplementation(async (_cwd, sessionId) => ({ sessionId, resWorkflow: participation }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setGlobalApiBase(""); });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("explicit res-workflow membership", () => {
  it("does no membership request at rest and gives mobile a named keyboard-accessible action", async () => {
    render(<SessionCard session={session} {...props} />);
    expect(join).not.toHaveBeenCalled();
    const button = screen.getByTestId("res-workflow-join-session");
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("aria-label")).toContain("res-workflow");
    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId("res-workflow-member")).toBeTruthy());
    expect(join).toHaveBeenCalledWith("/fixture", "fixture-session", expect.any(AbortSignal));
    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onArchive).not.toHaveBeenCalled();
    expect(screen.queryByTestId("res-workflow-join-session")).toBeNull();
  });

  it("does not mark joined before the actual reply and ignores a same-tick double click", async () => {
    const pending = deferred<{ sessionId: string; resWorkflow: typeof participation }>();
    join.mockReturnValueOnce(pending.promise);
    render(<SessionCard session={session} {...props} />);
    const button = screen.getByTestId("res-workflow-join-session");
    fireEvent.click(button);
    fireEvent.click(button);
    expect(join).toHaveBeenCalledOnce();
    expect(screen.queryByTestId("res-workflow-member")).toBeNull();
    await act(async () => pending.resolve({ sessionId: session.id, resWorkflow: participation }));
    expect(screen.getByTestId("res-workflow-member").getAttribute("title")).toContain("history");
    expect(screen.queryByText(/research running|科研运行中/i)).toBeNull();
  });

  it("keeps a failed association unconfirmed and retries only that metadata POST", async () => {
    join.mockRejectedValueOnce(new Error("fixture: directory not adopted"));
    render(<SessionCard session={session} {...props} />);
    fireEvent.click(screen.getByTestId("res-workflow-join-session"));
    expect((await screen.findByRole("alert")).textContent).toContain("directory not adopted");
    expect(screen.queryByTestId("res-workflow-member")).toBeNull();
    fireEvent.click(screen.getByTestId("res-workflow-join-session"));
    await screen.findByTestId("res-workflow-member");
    expect(join).toHaveBeenCalledTimes(2);
  });

  it("wires the desktop SESSION action to the same metadata-only association", async () => {
    vi.mocked(useMobile).mockReturnValue(false);
    render(<SessionCard session={session} {...props} />);
    fireEvent.click(screen.getByTestId("session-actions-trigger-fixture-session"));
    fireEvent.click(await screen.findByTestId("session-menu-item-join-res-workflow"));
    await screen.findByTestId("res-workflow-member");
    expect(join).toHaveBeenCalledOnce();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it.each([{ pluginHidden: true }, { archiveOnEnd: true }])("does not offer association for a declared service %j", flag => {
    const view = render(<SessionCard session={{ ...session, ...flag }} {...props} />);
    expect(screen.queryByTestId("res-workflow-join-session")).toBeNull();
    view.unmount();
    render(<ArchivedSessionRow item={{ ...archived, ...flag }} onRestore={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByTestId("res-workflow-join-session")).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });

  it("does not confuse an ordinary user-hidden session with a declared service", async () => {
    render(<SessionCard session={{ ...session, hidden: true }} {...props} isHidden />);
    fireEvent.click(screen.getByTestId("res-workflow-join-session"));
    await screen.findByTestId("res-workflow-member");
    expect(join).toHaveBeenCalledOnce();
  });

  it("does not offer a local association for a remote-origin session", () => {
    render(<SessionCard session={{ ...session, originDeviceId: "remote-fixture" }} {...props} />);
    expect(screen.queryByTestId("res-workflow-join-session")).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });

  it.each([
    { label: "session ID", target: { ...session, id: "other" }, generation: 1 },
    { label: "cwd", target: { ...session, cwd: "/other" }, generation: 1 },
    { label: "connection generation", target: session, generation: 2 },
  ])("does not leak a late reply after changing $label", async ({ target, generation }) => {
    const pending = deferred<{ sessionId: string; resWorkflow: typeof participation }>();
    join.mockReturnValueOnce(pending.promise);
    const view = render(<SessionCard session={session} {...props} connectionGeneration={1} />);
    fireEvent.click(screen.getByTestId("res-workflow-join-session"));
    const signal = join.mock.calls[0][2]!;
    view.rerender(<SessionCard session={target} {...props} connectionGeneration={generation} />);
    expect(signal.aborted).toBe(true);
    await act(async () => pending.resolve({ sessionId: session.id, resWorkflow: participation }));
    expect(screen.queryByTestId("res-workflow-member")).toBeNull();
    expect(screen.getByTestId("res-workflow-join-session")).toBeTruthy();
  });

  it("clears a local reply when the API host changes, without making another request", async () => {
    const view = render(<ApiContext.Provider value=""><SessionCard session={session} {...props} /></ApiContext.Provider>);
    fireEvent.click(screen.getByTestId("res-workflow-join-session"));
    await screen.findByTestId("res-workflow-member");
    setGlobalApiBase("https://fixture.invalid");
    view.rerender(<ApiContext.Provider value="https://fixture.invalid"><SessionCard session={session} {...props} /></ApiContext.Provider>);
    expect(screen.queryByTestId("res-workflow-member")).toBeNull();
    expect(join).toHaveBeenCalledOnce();
  });

  it("shows an existing association as a link, not as an execution status", () => {
    render(<SessionCard session={{ ...session, resWorkflow: participation }} {...props} />);
    expect(screen.getByTestId("res-workflow-member").textContent).toBe("res-workflow");
    expect(screen.queryByTestId("res-workflow-join-session")).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });

  it("associates a local archived row without restoring, opening, deleting or loading its transcript", async () => {
    const onRestore = vi.fn();
    const onOpen = vi.fn();
    const onDeleted = vi.fn();
    const onJoined = vi.fn();
    render(<ArchivedSessionRow item={archived} onRestore={onRestore} onOpen={onOpen} onDeleted={onDeleted} onJoined={onJoined} />);
    fireEvent.click(screen.getByTestId("res-workflow-join-session"));
    await screen.findByTestId("res-workflow-member");
    expect(join).toHaveBeenCalledWith("/fixture", "fixture-archive", expect.any(AbortSignal));
    expect(onRestore).not.toHaveBeenCalled();
    expect(onOpen).not.toHaveBeenCalled();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onJoined).toHaveBeenCalledExactlyOnceWith(archived.id, participation);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("archived-session-row").textContent).toContain("archived");
  });

  it("renders persisted archived membership and refuses remote-origin join controls", () => {
    const view = render(<ArchivedSessionRow item={{ ...archived, resWorkflow: participation }} onRestore={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.getByTestId("res-workflow-member")).toBeTruthy();
    expect(screen.queryByTestId("res-workflow-join-session")).toBeNull();
    view.rerender(<ArchivedSessionRow item={{ ...archived, originDeviceId: "remote-fixture" }} onRestore={vi.fn()} onOpen={vi.fn()} />);
    expect(screen.queryByTestId("res-workflow-join-session")).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });
});
