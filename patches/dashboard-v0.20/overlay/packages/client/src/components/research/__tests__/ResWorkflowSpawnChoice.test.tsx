import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ResWorkflowSpawnChoice } from "../ResWorkflowSpawnChoice.js";

afterEach(cleanup);

const callbacks = () => ({ onChoose: vi.fn(), onRetry: vi.fn(), onCancel: vi.fn() });

describe("inline new-session membership choice", () => {
  it("is an inline labelled region, not a dialog, with no preselected join", () => {
    const cb = callbacks();
    render(<ResWorkflowSpawnChoice choice={{ cwd: "/p", status: "choice" }} {...cb} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByTestId("res-workflow-spawn-choice").getAttribute("role")).toBe("region");
    expect(screen.getByTestId("res-workflow-spawn-join")).toBeTruthy();
    expect(screen.getByTestId("res-workflow-spawn-ordinary")).toBeTruthy();
    expect(cb.onChoose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("res-workflow-spawn-join"));
    expect(cb.onChoose).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("separates ordinary and cancel from joining", () => {
    const cb = callbacks();
    render(<ResWorkflowSpawnChoice choice={{ cwd: "/p", status: "choice" }} {...cb} />);
    fireEvent.click(screen.getByTestId("res-workflow-spawn-ordinary"));
    expect(cb.onChoose).toHaveBeenCalledExactlyOnceWith(false);
    fireEvent.click(screen.getByTestId("res-workflow-spawn-cancel"));
    expect(cb.onCancel).toHaveBeenCalledOnce();
  });

  it("checking is real metadata work, not a running session, and can be cancelled", () => {
    const cb = callbacks();
    render(<ResWorkflowSpawnChoice choice={{ cwd: "/p", status: "checking" }} {...cb} />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.queryByTestId("res-workflow-spawn-join")).toBeNull();
    expect(screen.queryByTestId("res-workflow-spawn-ordinary")).toBeNull();
    fireEvent.click(screen.getByTestId("res-workflow-spawn-cancel"));
    expect(cb.onCancel).toHaveBeenCalledOnce();
    expect(cb.onChoose).not.toHaveBeenCalled();
  });

  it("failed status offers only retry, ordinary or cancel, never a join action", () => {
    const cb = callbacks();
    render(<ResWorkflowSpawnChoice choice={{ cwd: "/p", status: "error", error: "metadata unavailable" }} {...cb} />);
    expect(screen.getByRole("alert").textContent).toContain("metadata unavailable");
    expect(screen.queryByTestId("res-workflow-spawn-join")).toBeNull();
    fireEvent.click(screen.getByTestId("res-workflow-spawn-retry"));
    expect(cb.onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByTestId("res-workflow-spawn-ordinary"));
    expect(cb.onChoose).toHaveBeenCalledExactlyOnceWith(false);
  });
});
