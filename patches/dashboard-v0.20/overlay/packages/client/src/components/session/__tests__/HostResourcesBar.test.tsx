import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostResourcesBar } from "../HostResourcesBar.js";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HostResourcesBar", () => {
  beforeEach(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("does not poll when disabled", () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<HostResourcesBar enabled={false} />);
    expect(screen.getByTestId("sidebar-host-resources")).toBeTruthy();
    expect(screen.getByTestId("sidebar-host-cpu").textContent).toBe("—");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("renders host CPU percentage and GiB memory usage from /api/host/resources", async () => {
    const gib = 1024 ** 3;
    const fetcher = vi.fn(async () =>
      jsonResponse({
        success: true,
        data: {
          cpuCount: 8,
          cpuUsedPercent: 34,
          loadAvg1m: 1.45,
          memoryTotal: 32 * gib,
          memoryAvailable: 20 * gib,
          memoryUsed: 12 * gib,
          memoryUsedPercent: 38,
        },
      }),
    );
    vi.stubGlobal("fetch", fetcher);

    render(<HostResourcesBar enabled />);
    await waitFor(() => expect(screen.getByTestId("sidebar-host-cpu").textContent).toBe("34%"));
    expect(screen.getByTestId("sidebar-host-mem").textContent).toBe("12.0/32G · 38%");
  });

  it("pauses polling while the document is hidden", () => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    render(<HostResourcesBar enabled />);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("falls back to /api/health when /api/host/resources returns 404", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/api/host/resources")) return jsonResponse({ success: false }, 404);
      return jsonResponse({
        ok: true,
        server: { rss: 512 * 1024 * 1024 },
        agents: [{ loadAvg1m: 2.15 }],
      });
    });
    vi.stubGlobal("fetch", fetcher);

    render(<HostResourcesBar enabled />);
    await waitFor(() => expect(screen.getByTestId("sidebar-host-cpu").textContent).toBe("2.15"));
    expect(screen.getByTestId("sidebar-host-mem").textContent).toBe("RSS 512M");
  });
});
