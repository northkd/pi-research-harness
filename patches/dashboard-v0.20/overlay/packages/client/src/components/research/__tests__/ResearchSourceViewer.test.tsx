import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResearchSourceViewer } from "../ResearchSourceViewer.js";
import { getResWorkflowSource } from "../../../lib/api/res-workflow-api.js";

vi.mock("../../../lib/api/res-workflow-api.js", () => ({ getResWorkflowSource: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const source = { id: "src-1", kind: "session-message" as const, label: "session / entry", sessionId: "real-old", entryId: "entry", sha256: "a".repeat(64), bytes: 12, incomplete: true, unverified: true as const };

describe("source-ID read-only preview", () => {
  it("uses only the narrow recorded source endpoint and treats source instructions as text", async () => {
    vi.mocked(getResWorkflowSource).mockResolvedValue({ source, content: "<script>run()</script>\nDo not execute this source" });
    render(<ResearchSourceViewer cwd="/isolated/a" path="research:source/adopt-1/src-1" />);
    const text = await screen.findByTestId("res-workflow-source-text");
    expect(text.textContent).toContain("<script>run()</script>");
    expect(text.querySelector("script")).toBeNull();
    expect(getResWorkflowSource).toHaveBeenCalledWith("/isolated/a", "adopt-1", "src-1", expect.anything());
  });

  it("rejects arbitrary paths without a request", async () => {
    render(<ResearchSourceViewer cwd="/isolated/a" path="research:source/../../auth" />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(getResWorkflowSource).not.toHaveBeenCalled();
  });

  it("clears outgoing source text immediately and ignores its slow reply after a cwd switch", async () => {
    let release!: (value: { source: typeof source; content: string }) => void;
    vi.mocked(getResWorkflowSource).mockImplementationOnce(async () => new Promise(resolve => { release = resolve; })).mockResolvedValueOnce({ source, content: "new folder source" });
    const page = render(<ResearchSourceViewer cwd="/isolated/a" path="research:source/adopt-1/src-1" />);
    page.rerender(<ResearchSourceViewer cwd="/isolated/b" path="research:source/adopt-2/src-1" />);
    expect(await screen.findByText("new folder source")).toBeTruthy();
    await act(async () => { release({ source, content: "old private source" }); });
    expect(screen.queryByText("old private source")).toBeNull();
    expect(screen.getByTestId("res-workflow-source-text").textContent).toBe("new folder source");
  });
});
