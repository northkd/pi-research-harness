import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ResearchCommunicationFeed,
  buildDisplayCommunications,
  cleanCommunicationSummary,
} from "../ResearchCommunicationFeed.js";
import { ResearchAgentCanvas, type CanvasSessionCluster } from "../ResearchAgentCanvas.js";
import type { CollaborationCommunicationItem } from "../use-research-collaboration.js";

const sampleItems: CollaborationCommunicationItem[] = [
  {
    id: "m-1",
    from: "child-sn",
    to: "main-1",
    kind: "request",
    edgeKind: "parent-child",
    summary: "Sn 产物完成，sha256:85ff189d543c84d6d07c6bd84aef209528a18ed04706ad3a4192c5bfe5b04dbe 校验冲突，请确认 research/tasks/fluoride/na4sn3f10/REPORT.md 写入方式",
    evidence: ["research/tasks/fluoride/na4sn3f10/REPORT.md"],
    resolved: false,
    peerSettled: false,
    createdAt: "2026-11-27T08:05:00.000Z",
  },
  {
    id: "m-2",
    from: "main-1",
    to: "child-sn",
    kind: "reply",
    edgeKind: "parent-child",
    summary: "保持冻结哈希不变，直接落盘结果。",
    evidence: [],
    resolved: false,
    peerSettled: false,
    replyTo: "m-1",
    createdAt: "2026-11-27T08:05:30.000Z",
  },
  {
    id: "m-3",
    from: "child-sn",
    to: "child-sb4",
    kind: "decision",
    edgeKind: "peer",
    broadcast: true,
    summary: "统一使用 30 ps 截断窗口计算首帧返回",
    evidence: [],
    resolved: false,
    peerSettled: false,
    createdAt: "2026-11-27T08:06:00.000Z",
  },
  {
    id: "m-4",
    from: "child-sn",
    to: "child-sb18",
    kind: "decision",
    edgeKind: "peer",
    broadcast: true,
    summary: "统一使用 30 ps 截断窗口计算首帧返回",
    evidence: [],
    resolved: false,
    peerSettled: false,
    createdAt: "2026-11-27T08:06:01.000Z",
  },
];

describe("ResearchCommunicationFeed", () => {
  it("cleans hashes and deep file paths into concise human-readable summaries", () => {
    const cleaned = cleanCommunicationSummary(sampleItems[0]!.summary, 64);
    expect(cleaned).not.toContain("85ff189d543c84d6");
    expect(cleaned).not.toContain("research/tasks/fluoride/na4sn3f10/");
    expect(cleaned).toContain("REPORT.md");
    expect(Array.from(cleaned).length).toBeLessThanOrEqual(64);
  });

  it("deduplicates simultaneous peer broadcasts into a single 全组 card and maps human titles", () => {
    const rows = buildDisplayCommunications(sampleItems, {
      mainSessionId: "main-1",
      sessionTitles: {
        "main-1": "08-氟化物msd迁移分析",
        "child-sn": "Na₄Sn₃F₁₀｜逐离子返回与配位补核",
        "child-sb4": "NaSbF₄｜元素运动",
      },
    });
    expect(rows).toHaveLength(3);
    expect(rows[0]!.fromLabel).toBe("Na₄Sn₃F₁₀");
    expect(rows[0]!.toLabel).toBe("主 Agent");
    expect(rows[0]!.tagLabel).toBe("求助 · 待回复");
    expect(rows[2]!.toLabel).toBe("全组");
    expect(rows[2]!.tagLabel).toBe("全组广播");
    expect(rows[2]!.highlightIds).toEqual(["child-sn", "child-sb4", "child-sb18"]);
  });

  it("filters between 全部 / 求助 / 同级 and expands evidence + locate/open actions on click", () => {
    const onHighlight = vi.fn();
    const onLocate = vi.fn();
    const onOpen = vi.fn();
    render(
      <ResearchCommunicationFeed
        items={sampleItems}
        mainSessionId="main-1"
        sessionTitles={{ "child-sn": "Na₄Sn₃F₁₀｜分析" }}
        onClose={vi.fn()}
        onHighlightSessions={onHighlight}
        onLocateSession={onLocate}
        onOpenSession={onOpen}
      />,
    );

    expect(screen.getByTestId("research-comm-pending-badge").textContent).toContain("1 待回复");
    expect(screen.getAllByTestId("research-comm-item")).toHaveLength(3);

    fireEvent.click(screen.getByRole("tab", { name: /同级/ }));
    expect(screen.getAllByTestId("research-comm-item")).toHaveLength(1);

    fireEvent.click(screen.getByRole("tab", { name: /全部/ }));
    const firstCardBtn = screen.getAllByTestId("research-comm-item")[0]!.querySelector("button")!;
    fireEvent.click(firstCardBtn);
    expect(screen.getByText(/证据：REPORT\.md/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /定位/ }));
    expect(onLocate).toHaveBeenCalledWith("child-sn");

    fireEvent.click(screen.getByRole("button", { name: /看会话/ }));
    expect(onOpen).toHaveBeenCalledWith("child-sn");
  });

  it("auto-expands in ResearchAgentCanvas when communications exist and stays collapsed when empty", () => {
    const clusters: CanvasSessionCluster[] = [
      {
        sessionExec: { id: "s-main", sessionId: "main-1", kind: "pi-session", status: "active", source: "workflow-record", evidence: [] },
        title: "主会话",
        roleObj: { name: "主 Agent", skills: [] },
        isCaptain: true,
        childSubs: [],
        childRoleGroups: [],
      },
      {
        sessionExec: { id: "s-sn", sessionId: "child-sn", kind: "pi-session", status: "active", source: "workflow-record", evidence: [] },
        title: "Na₄Sn₃F₁₀｜分析",
        roleObj: { name: "trajectory", skills: [] },
        isCaptain: false,
        childSubs: [],
        childRoleGroups: [],
      },
    ];

    const emptyView = render(
      <ResearchAgentCanvas
        clusters={clusters}
        communications={[]}
        mainSessionId="main-1"
        stale={false}
        onAgent={vi.fn()}
        statusLabel={s => s}
        roleLabel={r => r}
      />,
    );
    expect(screen.queryByTestId("research-comm-feed")).toBeNull();
    emptyView.unmount();

    render(
      <ResearchAgentCanvas
        clusters={clusters}
        communications={sampleItems}
        mainSessionId="main-1"
        stale={false}
        onAgent={vi.fn()}
        statusLabel={s => s}
        roleLabel={r => r}
      />,
    );
    expect(screen.getByTestId("research-comm-feed")).toBeTruthy();

    // Collapsing hides the sidebar; clicking the header toggle brings it back.
    fireEvent.click(screen.getByTestId("research-toggle-comm-feed"));
    expect(screen.queryByTestId("research-comm-feed")).toBeNull();
    fireEvent.click(screen.getByTestId("research-toggle-comm-feed"));
    expect(screen.getByTestId("research-comm-feed")).toBeTruthy();
  });
});
