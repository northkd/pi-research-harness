import { useEffect, useRef, useState } from "react";
import { useApiBase } from "../../lib/api/api-context.js";

export interface HostResourcesSnapshot {
  sampledAt?: string;
  cpuCount: number;
  cpuUsedPercent: number | null;
  loadAvg1m?: number | null;
  memoryTotal: number;
  memoryAvailable: number;
  memoryUsed: number;
  memoryUsedPercent: number;
}

interface FallbackHealthStats {
  loadAvg1m: number | null;
  rssBytes: number;
}

const POLL_INTERVAL_MS = 3000;
const FALLBACK_PROBE_MS = 15000;

function formatGiB(bytes: number, trimWhole = false): string {
  const gib = bytes / (1024 ** 3);
  if (trimWhole) {
    const rounded = Number(gib.toFixed(1));
    return `${rounded}G`;
  }
  return gib.toFixed(1);
}

function formatCompactBytes(bytes: number): string {
  const gib = bytes / (1024 ** 3);
  if (gib >= 1) return `${gib.toFixed(1)}G`;
  return `${Math.round(bytes / (1024 ** 2))}M`;
}

function toneForPercent(percent: number | null, normalToken: string): string {
  if (percent === null) return normalToken;
  if (percent >= 90) return "var(--accent-red)";
  if (percent >= 75) return "var(--accent-orange)";
  return normalToken;
}

export function HostResourcesBar({ enabled = false }: { enabled?: boolean }) {
  const apiBase = useApiBase();
  const [resources, setResources] = useState<HostResourcesSnapshot | null>(null);
  const [fallback, setFallback] = useState<FallbackHealthStats | null>(null);
  const notFoundAtRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let activeAbort: AbortController | null = null;
    let followUpTimer: number | undefined;

    const sampleOnce = async (allowCpuRetry: boolean) => {
      if (cancelled || document.hidden) return;
      activeAbort?.abort();
      const controller = new AbortController();
      activeAbort = controller;

      const now = Date.now();
      const probingFallback = notFoundAtRef.current > 0 && now - notFoundAtRef.current < FALLBACK_PROBE_MS;

      if (!probingFallback) {
        try {
          const response = await fetch(`${apiBase}/api/host/resources`, { signal: controller.signal });
          if (response.ok) {
            const json = await response.json().catch(() => null);
            const raw = (json && typeof json === "object" && "data" in json ? json.data : json) as Partial<HostResourcesSnapshot> | null;
            if (!cancelled && raw && typeof raw.memoryTotal === "number" && typeof raw.memoryAvailable === "number") {
              notFoundAtRef.current = 0;
              const memoryUsed = typeof raw.memoryUsed === "number"
                ? raw.memoryUsed
                : Math.max(0, raw.memoryTotal - raw.memoryAvailable);
              const memoryUsedPercent = typeof raw.memoryUsedPercent === "number"
                ? raw.memoryUsedPercent
                : raw.memoryTotal > 0 ? Math.round((memoryUsed / raw.memoryTotal) * 100) : 0;
              const cpuUsedPercent = typeof raw.cpuUsedPercent === "number" ? raw.cpuUsedPercent : null;
              setFallback(null);
              setResources({
                sampledAt: raw.sampledAt,
                cpuCount: typeof raw.cpuCount === "number" ? raw.cpuCount : 1,
                cpuUsedPercent,
                loadAvg1m: typeof raw.loadAvg1m === "number" ? raw.loadAvg1m : null,
                memoryTotal: raw.memoryTotal,
                memoryAvailable: raw.memoryAvailable,
                memoryUsed,
                memoryUsedPercent,
              });
              if (allowCpuRetry && cpuUsedPercent === null) {
                window.clearTimeout(followUpTimer);
                followUpTimer = window.setTimeout(() => { void sampleOnce(false); }, 1000);
              }
              return;
            }
          }
          if (response.status === 404) {
            notFoundAtRef.current = Date.now();
          } else {
            return;
          }
        } catch {
          return;
        }
      }

      // Route returned 404 (server not restarted yet): fall back to /api/health
      try {
        const healthResponse = await fetch(`${apiBase}/api/health`, { signal: controller.signal });
        if (!healthResponse.ok) return;
        const health = await healthResponse.json().catch(() => null) as {
          server?: { rss?: number };
          agents?: Array<{ loadAvg1m?: number }>;
        } | null;
        if (cancelled || !health) return;
        const rssBytes = typeof health.server?.rss === "number" ? health.server.rss : 0;
        const loadAvg1m = typeof health.agents?.[0]?.loadAvg1m === "number" ? health.agents[0].loadAvg1m : null;
        if (rssBytes > 0 || loadAvg1m !== null) {
          setFallback({ loadAvg1m, rssBytes });
        }
      } catch {
        /* Keep UI quiet offline or on abort. */
      }
    };

    void sampleOnce(true);
    const interval = window.setInterval(() => {
      if (!document.hidden) void sampleOnce(false);
    }, POLL_INTERVAL_MS);
    const onVisibility = () => {
      if (!document.hidden) void sampleOnce(false);
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      window.clearTimeout(followUpTimer);
      activeAbort?.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [apiBase, enabled]);

  const cpuPct = resources?.cpuUsedPercent ?? null;
  const memPct = resources?.memoryUsedPercent ?? null;
  const cpuTitle = resources
    ? `${resources.cpuCount} cores${resources.loadAvg1m != null ? ` · load ${resources.loadAvg1m}` : ""}`
    : fallback
      ? "重启 dashboard 服务后显示完整宿主机 CPU/内存"
      : "宿主机 CPU 使用率";
  const memTitle = resources
    ? `已用 ${formatGiB(resources.memoryUsed)} GiB · 可用 ${formatGiB(resources.memoryAvailable)} GiB / 总计 ${formatGiB(resources.memoryTotal)} GiB`
    : fallback
      ? "重启 dashboard 服务后显示完整宿主机 CPU/内存"
      : "宿主机内存使用情况";

  const cpuWidth = cpuPct !== null ? `${Math.max(2, Math.min(100, cpuPct))}%` : "0%";
  const memWidth = memPct !== null ? `${Math.max(2, Math.min(100, memPct))}%` : "0%";

  return (
    <div
      className="session-nav-host-resources border-t border-[var(--border-primary)] px-3 py-2"
      data-testid="sidebar-host-resources"
      aria-label="Host CPU and memory usage"
    >
      <div className="space-y-1.5">
        <div className="space-y-0.5" title={cpuTitle}>
          <div className="flex items-center justify-between gap-2 text-[10.5px] leading-tight">
            <span className="font-medium tracking-wide text-[var(--text-secondary)]">
              {resources ? "CPU" : fallback ? "LOAD" : "CPU"}
            </span>
            <span className="font-mono tabular-nums text-[var(--text-primary)]" data-testid="sidebar-host-cpu">
              {resources
                ? (cpuPct !== null ? `${cpuPct}%` : "—")
                : fallback
                  ? (fallback.loadAvg1m !== null ? `${fallback.loadAvg1m}` : "—")
                  : "—"}
            </span>
          </div>
          <div className="session-nav-resource-track">
            <div
              className="session-nav-resource-fill"
              style={{ width: cpuWidth, backgroundColor: toneForPercent(cpuPct, "var(--accent-blue)") }}
            />
          </div>
        </div>

        <div className="space-y-0.5" title={memTitle}>
          <div className="flex items-center justify-between gap-2 text-[10.5px] leading-tight">
            <span className="font-medium tracking-wide text-[var(--text-secondary)]">MEM</span>
            <span className="font-mono tabular-nums text-[var(--text-primary)]" data-testid="sidebar-host-mem">
              {resources
                ? `${formatGiB(resources.memoryUsed)}/${formatGiB(resources.memoryTotal, true)} · ${resources.memoryUsedPercent}%`
                : fallback && fallback.rssBytes > 0
                  ? `RSS ${formatCompactBytes(fallback.rssBytes)}`
                  : "—"}
            </span>
          </div>
          <div className="session-nav-resource-track">
            <div
              className="session-nav-resource-fill"
              style={{ width: memWidth, backgroundColor: toneForPercent(memPct, "var(--accent-green)") }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
