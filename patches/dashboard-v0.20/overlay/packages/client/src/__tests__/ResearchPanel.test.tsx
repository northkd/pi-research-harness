/**
 * Research workbench embedded in the right-hand split pane.
 *
 * Regressions pinned here:
 * - the entry belongs to the sidebar folder card, not the session header;
 * - the retained `research:` tab shares the pane state with files;
 * - leaving for a file/url hides the workbench without discarding its state;
 * - the default workflow has five tabs, and the complete view still exposes
 *   collaboration, budget, claims/acceptance and audit records;
 * - a narrow workspace keeps the overview closed until explicitly requested;
 * - a folder pane id is never presented as an actual Pi session;
 * - the legacy `/folder/:cwd/research` deep link still resolves to the
 *   research renderer (App then mounts the folder split + panel);
 * - a session-scoped open request opens the tab in the CURRENT session pane.
 *
 * See change: research-panel-in-split.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

vi.mock("../lib/api/api-context.js", () => ({ getApiBase: () => "", useApiBase: () => "" }));
vi.mock("../hooks/useMobile.js", () => ({ useMobile: () => false }));

import { DirectoryHomeView } from "../components/folder/DirectoryHomeView.js";
import { FolderSplitProvider } from "../components/folder/FolderSplitProvider.js";
import { ShellContent, type ShellContentRenderers } from "../components/shell/ShellContent.js";
import { ResearchOpenSync } from "../components/split/SessionSplitView.js";
import { useSplitWorkspace } from "../components/split/SplitWorkspaceContext.js";
import { encodeFolderPath } from "../lib/util/folder-encoding.js";

const CWD = "/proj";
const OBJECTIVE = "验证研究工作台嵌入右侧面板";
const STATE = JSON.stringify({
  schema: "pi-research-loop.v1",
  charter: { objective: OBJECTIVE, successCriteria: ["回归用例通过"] },
  phase: 2,
  attempts: 0,
  claims: [
    {
      id: "c1",
      statement: "研究工作台保留全部内容",
      status: "supported",
      acceptance: { verdict: "accepted" },
      publication: { authorized: true },
    },
  ],
  budget: { maxAttempts: 60 },
});

const EVENTS = JSON.stringify({
  at: "2026-10-22T00:00:00.000Z",
  kind: "stage-enter",
  detail: { stage: "2-experiment" },
});

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

const originalFetch = globalThis.fetch;

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
  globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.searchParams.get("path") ?? "";
    if (url.pathname === "/api/res-workflow") return json({ cwd: url.searchParams.get("cwd") ?? CWD, adopted: true, adoption: null, research: { "state.json": STATE, "ledger.jsonl": "", "events.jsonl": EVENTS, "auto-run.json": null } });
    if (url.pathname.endsWith("/api/file")) {
      if (path.endsWith("state.json")) return json({ success: true, data: { type: "file", content: STATE } });
      if (path.endsWith("ledger.jsonl") || path.endsWith("events.jsonl")) {
        return json({ success: true, data: { type: "file", content: path.endsWith("events.jsonl") ? EVENTS : "" } });
      }
      if (path.endsWith("auto-run.json")) return { ok: false, status: 404, json: async () => ({ success: false, error: "not found" }) } as Response;
      return json({ success: true, data: { type: "directory", entries: [] } });
    }
    return json({ success: false });
  }) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function Wrap({ path = "/", children }: { path?: string; children: React.ReactNode }) {
  const { hook } = memoryLocation({ path, static: true });
  return <Router hook={hook}>{children}</Router>;
}

function UrlProbe() {
  const { openUrlTarget, paneState } = useSplitWorkspace();
  return (
    <>
      <button type="button" data-testid="probe-url" onClick={() => openUrlTarget("https://example.com")}>
        url
      </button>
      <output data-testid="probe-open-paths">{JSON.stringify(paneState.openFiles.map(file => file.path))}</output>
    </>
  );
}

function renderFolder(overrides: { researchOpen?: boolean } = {}) {
  return render(
    <Wrap>
      <FolderSplitProvider cwd={CWD}>
        <UrlProbe />
        <DirectoryHomeView cwd={CWD} onSpawnSession={vi.fn()} {...overrides} />
      </FolderSplitProvider>
    </Wrap>,
  );
}

const researchTab = () =>
  screen.getAllByTestId("editor-tab").find((el) => el.getAttribute("data-tab-path") === "research:");
const panePaths = () => JSON.parse(screen.getByTestId("probe-open-paths").textContent ?? "[]") as string[];

async function expectResearchContent() {
  expect(await screen.findByRole("heading", { name: OBJECTIVE })).toBeTruthy();
  expect(screen.getByRole("heading", { name: "研究工作台" })).toBeTruthy();
  expect(panePaths()).toContain("research:");
  expect(screen.getByTestId("workspace-view-workbench").getAttribute("aria-selected")).toBe("true");
  expect(within(screen.getByRole("tablist", { name: "科研工作流导航标签" })).getAllByRole("tab")).toHaveLength(5);
  expect(screen.getByTestId("research-run-status")).toBeTruthy();
}

describe("research panel in the folder split", () => {
  it("keeps the directory home clean; the shared entry lives on the sidebar folder card", () => {
    renderFolder();
    expect(screen.queryByTestId("directory-home-research")).toBeNull();
  });

  it("opens from the legacy research-open request (deep link underlay)", async () => {
    renderFolder({ researchOpen: true });
    await expectResearchContent();
    expect(screen.getByTestId("research-tab-workflow").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("research-stage-2-experiment").getAttribute("aria-current")).toBe("step");

    // The old deep link reaches the new default. Complete aggregation is one
    // explicit tab away, rather than forcing every section into the first view.
    fireEvent.click(screen.getByTestId("research-tab-all"));
    for (const id of ["research-agent-topology", "research-run-status", "research-overview-and-budget", "research-claim-gates", "research-attempts-ledger", "research-role-configuration"]) {
      expect(screen.getByTestId(id)).toBeTruthy();
    }
    expect(screen.getByTestId("schematic-notice").textContent).toContain("正式科研记录与执行观测分别同步");
    expect(screen.getByText("研究工作台保留全部内容")).toBeTruthy();
    expect(screen.getByText("内部验收：accepted")).toBeTruthy();
    expect(screen.getByText("发表授权：已授权（非实际发表）")).toBeTruthy();
    expect(screen.getByTestId("research-tab-overview").textContent).toContain("60 次");
  });

  it("opens research after switching cwd without losing either directory's saved tabs", async () => {
    const view = renderFolder({ researchOpen: true });
    await expectResearchContent();
    fireEvent.click(screen.getByTestId("probe-url"));
    expect(await screen.findByTestId("canvas-url-viewer")).toBeTruthy();
    expect(screen.getAllByTestId("editor-tab")).toHaveLength(2);

    const folder = (cwd: string) => (
      <Wrap>
        <FolderSplitProvider cwd={cwd}>
          <UrlProbe />
          <DirectoryHomeView cwd={cwd} onSpawnSession={vi.fn()} researchOpen />
        </FolderSplitProvider>
      </Wrap>
    );
    view.rerender(folder("/another-project"));
    await expectResearchContent();
    expect(panePaths()).toEqual(["research:"]);
    expect(screen.getByTestId("research-pipeline")).toBeTruthy();
    expect(screen.queryByTestId("canvas-url-viewer")).toBeNull();

    view.rerender(folder(CWD));
    await expectResearchContent();
    expect(panePaths()).toHaveLength(2);
    expect(panePaths()).toContain("url:https://example.com");
  });

  it("switches to another editor tab and back to the research tab", async () => {
    renderFolder({ researchOpen: true });
    await expectResearchContent();
    const workbench = screen.getByTestId("research-pipeline");
    fireEvent.click(screen.getByTestId("research-stage-3-review"));

    fireEvent.click(screen.getByTestId("probe-url"));
    expect(await screen.findByTestId("canvas-url-viewer")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "研究工作台" })).toBeNull();
    expect(screen.getByTestId("research-pipeline")).toBe(workbench);
    expect(workbench.closest("[hidden]")).toBeTruthy();
    fireEvent.click(screen.getByTestId("tree-toggle"));
    expect(screen.getByTestId("tree-toggle").getAttribute("aria-pressed")).toBe("true");

    const tab = researchTab();
    expect(tab).toBeTruthy();
    fireEvent.click(tab!);
    await expectResearchContent();
    expect(screen.getByTestId("research-pipeline")).toBe(workbench);
    expect(workbench.closest("[hidden]")).toBeNull();
    expect(screen.getByTestId("research-stage-3-review").getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(screen.getByTestId("tree-toggle").getAttribute("aria-pressed")).toBe("false"));
  });

  it("keeps a narrow pane compact and opens the overview only when requested", async () => {
    const measure = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this.dataset.testid !== "research-pipeline") return measure.call(this);
      return { width: 360, height: 800, top: 0, left: 0, right: 360, bottom: 800, x: 0, y: 0, toJSON: () => ({}) };
    });
    renderFolder({ researchOpen: true });
    await expectResearchContent();

    const root = screen.getByTestId("research-pipeline");
    expect(root.className).toContain("@container");
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("overflow-hidden");
    expect(screen.getAllByRole("button", { name: /^查看阶段：/ })).toHaveLength(5);
    expect(screen.queryByRole("complementary", { name: "任务概览" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "任务概览" }));
    const overview = screen.getByRole("complementary", { name: "任务概览" });
    // FolderSplitProvider has a synthetic folder: id, not a sendable Pi session.
    expect(within(overview).getByText("尚未选择会话")).toBeTruthy();
    expect(overview.textContent).not.toContain(`folder:${CWD}`);
    expect(screen.queryByText("将当前对话设为界面交互入口？")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "收起任务概览" }));
    expect(screen.queryByRole("complementary", { name: "任务概览" })).toBeNull();
  });
});

describe("legacy /research deep link", () => {
  it("resolves to the research renderer with the decoded cwd", () => {
    const renderResearch = vi.fn(() => <div data-testid="research-route" />);
    const noop = () => null;
    const renderers: ShellContentRenderers = {
      renderOpenSpecBoard: noop,
      renderArchive: noop,
      renderSpecs: noop,
      renderDiff: noop,
      renderPiResourceFile: noop,
      renderPiResourcesRedirect: noop,
      renderFolderSettings: noop,
      renderOpenSpecPreview: noop,
      renderFilePreview: noop,
      renderUrlPreview: noop,
      renderFolderEditor: noop,
      renderFolderHome: noop,
      renderResearch,
      renderSession: noop,
      renderLanding: noop,
    };
    render(
      <Wrap path={`/folder/${encodeFolderPath(CWD)}/research`}>
        <ShellContent variant="desktop" {...renderers} />
      </Wrap>,
    );
    expect(renderResearch).toHaveBeenCalledWith(CWD);
    expect(screen.getByTestId("research-route")).toBeTruthy();
  });
});

describe("session-scoped research request", () => {
  it("opens the research tab in the current session pane instead of navigating", async () => {
    const ActivePathProbe = () => {
      const { paneState } = useSplitWorkspace();
      const active = paneState.openFiles[paneState.activeIndex]?.path ?? "none";
      return <div data-testid="active-tab">{active}</div>;
    };
    render(
      <Wrap>
        <FolderSplitProvider cwd={CWD}>
          <ResearchOpenSync request={{ sessionId: `folder:${CWD}`, cwd: CWD, nonce: 1 }} />
          <ActivePathProbe />
        </FolderSplitProvider>
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByTestId("active-tab").textContent).toBe("research:"));
  });
});
