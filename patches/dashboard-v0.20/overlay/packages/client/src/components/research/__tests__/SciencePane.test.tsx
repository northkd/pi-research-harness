import { PluginContextProvider } from "@blackbelt-technology/dashboard-plugin-runtime";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Suspense } from "react";
import { FolderSplitProvider } from "../../folder/FolderSplitProvider.js";
import { EditorPane } from "../../editor-pane/EditorPane.js";
import { useSplitWorkspace } from "../../split/SplitWorkspaceContext.js";

vi.mock("../../../hooks/useMobile.js", () => ({ useMobile: () => false }));
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const fetchMock = vi.fn<typeof fetch>();

function Pane() {
  const split = useSplitWorkspace();
  return <>
    <button type="button" data-testid="open-research" onClick={() => split.openResearch()}>Research</button>
    <button type="button" data-testid="open-science-workspace" onClick={() => split.openScience()}>Open</button>
    <button type="button" data-testid="open-science-task" onClick={() => split.openScience({ kind: "task", taskId: "task-1" })}>Task</button>
    <Suspense fallback="Loading"><EditorPane /></Suspense>
  </>;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })));
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input) => String(input).includes("/science/view")
    ? json({ availability: "unavailable", reason: "host-unconfigured" })
    : json({ adopted: false, adoption: null, research: { "state.json": null, "ledger.jsonl": null, "events.jsonl": null, "auto-run.json": null } }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("sessionless Science pane", () => {
  it("opens through the real folder provider and lazy pseudo registry without reading virtual paths as files", async () => {
    const ws = new EventTarget() as WebSocket;
    const send = vi.fn();
    render(<PluginContextProvider ws={ws} send={send} connectionStatus="connected"><FolderSplitProvider cwd="/isolated/no-session"><Pane /></FolderSplitProvider></PluginContextProvider>);
    fireEvent.click(screen.getByTestId("open-research"));
    await waitFor(() => expect(screen.getByTestId("research-open-science")).toBeTruthy());
    fireEvent.click(screen.getByTestId("research-open-science"));
    await waitFor(() => expect(screen.getByTestId("science-view-status").textContent).toContain("not configured"));
    fireEvent.click(screen.getByTestId("open-science-workspace"));
    expect(screen.getAllByTestId("editor-tab")).toHaveLength(2);
    expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/science/view"))).toHaveLength(1);
    expect(fetchMock.mock.calls.some(([input]) => /[?&]path=science/.test(String(input)))).toBe(false);
    fireEvent.click(screen.getByTestId("open-science-task"));
    await waitFor(() => expect(screen.getAllByTestId("editor-tab")).toHaveLength(3));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([input]) => String(input).includes("/science/view"))).toHaveLength(2));
    expect(screen.getAllByTestId("editor-tab")[2]?.textContent).toContain("Science task");
    expect(send.mock.calls.some(([message]) => /spawn|submit|cancel|stop/.test(message.type))).toBe(false);
  });
});
