import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResWorkflowAdoption } from "../ResWorkflowAdoption.js";

vi.mock("../../../lib/api/res-workflow-api.js", () => ({
  getResWorkflowModels: vi.fn(async () => [{ provider: "proxy", id: "anthropic/nested", name: "QA proxy model", contextWindow: 500000 }]),
  getResWorkflowHistoryCandidates: vi.fn(async () => ({ candidates: [], partial: false, skipped: [] })), joinResWorkflowSession: vi.fn(),
  createResWorkflowAdoption: vi.fn(), analyzeResWorkflowAdoption: vi.fn(), confirmResWorkflowAdoption: vi.fn(), cancelResWorkflowAdoption: vi.fn(),
}));
afterEach(cleanup);

describe("adoption uses the real model selector", () => {
  it("keeps a named physical-model popup without an adoption modal or preauthorization", async () => {
    localStorage.clear();
    render(<ResWorkflowAdoption cwd="/isolated/picker" adopted={false} adoption={null} onRefresh={vi.fn()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("res-workflow-connect-next"));
    fireEvent.click(screen.getByTestId("res-workflow-files-only"));
    const trigger = await screen.findByRole("button", { name: "Select an explicit provider/model" });
    await waitFor(() => expect((trigger as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(trigger);
    const popup = screen.getByRole("dialog", { name: "Choose a model" });
    expect(screen.queryByTestId("res-workflow-connect-dialog")).toBeNull();
    expect(popup.getAttribute("aria-modal")).toBe("false");
    fireEvent.click(screen.getByText("QA proxy model"));
    expect(screen.getByTestId("res-workflow-recipient").textContent).toContain("proxy/anthropic/nested");
    expect((screen.getByTestId("res-workflow-consent") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByTestId("res-workflow-start") as HTMLButtonElement).disabled).toBe(true);
  });
});
