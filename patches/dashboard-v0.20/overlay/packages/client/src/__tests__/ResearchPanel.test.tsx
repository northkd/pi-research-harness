/**
 * Research workbench embedded in the right-hand split pane.
 *
 * Regressions pinned here:
 * - the entry belongs to the sidebar folder card, not the session header;
 * - a `research:` TAB sits beside files without replacing the chat;
 * - the tab can be left for a file/url tab and re-activated;
 * - every research section (stage, goal, signal, roles/skills, gates, claims,
 *   attempts) is present inside the pane;
 * - the pane root and its scrollers are narrow-width safe (container queries,
 *   min-w-0, horizontal scroll confined to the diagram);
 * - the legacy `/folder/:cwd/research` deep link still resolves to the
 *   research renderer (App then mounts the folder split + panel);
 * - a session-scoped open request opens the tab in the CURRENT session pane.
 *
 * See change: research-panel-in-split.
 */

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const STATE = JSON.stringify({
  schema: "pi-research-loop.v1",
  charter: { objective: "验证研究工作台嵌入右侧面板", successCriteria: ["回归用例通过"] },
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
  const { openUrlTarget } = useSplitWorkspace();
  return (
    <button type="button" data-testid="probe-url" onClick={() => openUrlTarget("https://example.com")}>
      url
    </button>
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

async function expectResearchContent() {
  expect(await screen.findByText("流程示意 / 阶段配置，非实时运行")).toBeTruthy();
  expect(researchTab()?.textContent).toContain("res-workflow");
  expect(screen.getByText("研究目标：")).toBeTruthy();
  expect(screen.getByText("最新信号")).toBeTruthy();
  expect(screen.getByText("Agent 协作关系")).toBeTruthy();
  expect(screen.getByText("本阶段协作的 Agent（配置）")).toBeTruthy();
  expect(screen.getByText("验收关卡")).toBeTruthy();
  expect(screen.getAllByText("主张").length).toBeGreaterThan(0);
  expect(screen.getByText("尝试记录")).toBeTruthy();
}

describe("research panel in the folder split", () => {
  it("keeps the directory home clean; the shared entry lives on the sidebar folder card", () => {
    renderFolder();
    expect(screen.queryByTestId("directory-home-research")).toBeNull();
  });

  it("opens from the legacy research-open request (deep link underlay)", async () => {
    renderFolder({ researchOpen: true });
    expect(await screen.findByText("流程示意 / 阶段配置，非实时运行")).toBeTruthy();
    expect(researchTab()).toBeTruthy();
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
    await waitFor(() => expect(researchTab()).toBeTruthy());
    expect(screen.getAllByTestId("editor-tab")).toHaveLength(1);
    expect(screen.getByTestId("research-pipeline")).toBeTruthy();
    expect(screen.queryByTestId("canvas-url-viewer")).toBeNull();

    view.rerender(folder(CWD));
    await expectResearchContent();
    expect(screen.getAllByTestId("editor-tab")).toHaveLength(2);
  });

  it("switches to another editor tab and back to the research tab", async () => {
    renderFolder({ researchOpen: true });
    await expectResearchContent();

    fireEvent.click(screen.getByTestId("tree-toggle"));
    expect(screen.getByTestId("tree-toggle").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("probe-url"));
    expect(await screen.findByTestId("canvas-url-viewer")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText("流程示意 / 阶段配置，非实时运行")).toBeNull());

    const tab = researchTab();
    expect(tab).toBeTruthy();
    fireEvent.click(tab!);
    await expectResearchContent();
    await waitFor(() => expect(screen.getByTestId("tree-toggle").getAttribute("aria-pressed")).toBe("false"));
  });

  it("keeps the pane narrow-width safe", async () => {
    renderFolder({ researchOpen: true });
    await expectResearchContent();

    const root = screen.getByTestId("research-pipeline");
    expect(root.className).toContain("@container");
    expect(root.className).toContain("min-w-0");
    expect(root.className).toContain("overflow-x-hidden");
    expect(screen.getByTestId("research-stats").className).toContain("grid-cols-2");
    const scroller = screen.getByTestId("agent-flow-scroll");
    expect(scroller.className).toContain("overflow-x-auto");
    expect(scroller.className).toContain("min-w-0");
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
          <ResearchOpenSync request={{ cwd: CWD, nonce: 1 }} />
          <ActivePathProbe />
        </FolderSplitProvider>
      </Wrap>,
    );
    await waitFor(() => expect(screen.getByTestId("active-tab").textContent).toBe("research:"));
  });
});
