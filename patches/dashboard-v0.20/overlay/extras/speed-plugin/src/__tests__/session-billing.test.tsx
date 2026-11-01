// @vitest-environment jsdom
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FolderBillingCost,
  SessionBillingCost,
  folderBillingSessions,
} from "../SessionCost.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function mockBills(costs: Record<string, number | undefined>) {
  const fetch = vi.fn(async (url: string) => {
    const id = new URL(url, "http://localhost").searchParams.get("sessionId")!;
    return {
      ok: true,
      json: async () => ({
        sessionId: id,
        active: null,
        billing:
          costs[id] === undefined
            ? undefined
            : {
                currency: "CNY",
                complete: true,
                sessionTotalCost: costs[id],
                unpricedTurns: 0,
                invalidRecords: 0,
              },
      }),
    };
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

describe("shared session and directory billing", () => {
  it("sums all members once and shares the root request with its compact price", async () => {
    const fetch = mockBills({ root: 1, ended: 2, hidden: 3, child: 99 });
    render(
      <>
        <SessionBillingCost sessionId="root" status="idle" />
        <FolderBillingCost
          sessions={[
            { id: "root", status: "idle", sessionFile: "/logs/root.jsonl" },
            { id: "root", status: "idle", sessionFile: "/logs/root.jsonl" },
            { id: "ended", status: "ended" },
            { id: "hidden", status: "idle" },
            { id: "child", sessionFile: "/logs/root/run-1/child.jsonl" },
          ]}
        />
      </>,
    );
    await screen.findByText("¥6.00");
    expect(screen.getByText("¥1.00")).toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(screen.getByText("¥6.00").title).toContain("3 个会话");
  });
  it("marks a subtotal when a session has no CNY price", async () => {
    mockBills({ priced: 2, missing: undefined });
    render(
      <FolderBillingCost sessions={[{ id: "priced" }, { id: "missing" }]} />,
    );
    await waitFor(() =>
      expect(screen.getByText("≥¥2.00").title).toContain(
        "1 个会话费用未完整计入",
      ),
    );
  });
  it("shows pending rather than zero when no member can be priced", async () => {
    mockBills({ unknown: undefined });
    render(<FolderBillingCost sessions={[{ id: "unknown" }]} />);
    await screen.findByText("待定价");
  });
  it("renders an empty directory as zero without requesting an unrelated session", () => {
    const fetch = mockBills({});
    render(<FolderBillingCost sessions={[]} />);
    expect(screen.getByText("¥0.00")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
  });
  it("excludes only physical descendants on the same device", () => {
    const members = folderBillingSessions([
      { id: "root", sessionFile: "/logs/root.jsonl" },
      { id: "nested", sessionFile: "/logs/root/run-1/child.jsonl" },
      { id: "sibling", sessionFile: "/logs/root-extra/child.jsonl" },
      {
        id: "remote",
        originDeviceId: "another",
        sessionFile: "/logs/root/run-1/remote.jsonl",
      },
    ]);
    expect(members.map((member) => member.id)).toEqual([
      "root",
      "sibling",
      "remote",
    ]);
  });
});
