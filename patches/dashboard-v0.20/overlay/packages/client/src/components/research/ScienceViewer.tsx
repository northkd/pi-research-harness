/** Sessionless Science page. Only host-issued view leases reach the authenticated socket. */
import { usePluginMessage, usePluginSend, usePluginSocket, useShellConnectionStatus } from "@blackbelt-technology/dashboard-plugin-runtime";
import { BrowserFrameSurface, type BrowserFrameInput } from "@blackbelt-technology/pi-dashboard-browser-plugin/viewer";
import { isScienceViewInput, parseScienceTabPath, type ScienceViewFrameMessage, type ScienceViewReason, type ScienceViewResponse, type ScienceViewStatusMessage, type ScienceViewTarget } from "@blackbelt-technology/pi-dashboard-shared/science-viewer.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { useApiBase } from "../../lib/api/api-context.js";
import { fetchJsonResponse } from "../../lib/api/fetch-json.js";
import { useI18n } from "../../lib/i18n/i18n.js";
import "./ScienceSurfaces.css";

type ViewStatus = "loading" | "waiting" | "streaming" | "unavailable" | "unknown" | "expired";
interface ViewState {
  scope: string;
  socket: WebSocket | null;
  status: ViewStatus;
  reason?: ScienceViewReason;
  jpeg: string | null;
}
interface ViewLease {
  scope: string;
  socket: WebSocket;
  leaseId: string;
  expiresAt: number;
  release: () => void;
}

function readyLease(value: Record<string, unknown>): value is Record<string, unknown> & { leaseId: string; expiresAt: number } {
  return typeof value.leaseId === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value.leaseId)
    && typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt) && value.expiresAt > Date.now();
}

async function requestView(apiBase: string, cwd: string, target: ScienceViewTarget, signal: AbortSignal): Promise<ScienceViewResponse> {
  const { res, json } = await fetchJsonResponse<Record<string, unknown>>(`${apiBase}/api/res-workflow/science/view`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cwd, target }), signal,
  });
  if (!res.ok || !json || typeof json !== "object") return { availability: "unknown", reason: "invalid-host-response" };
  if (json.availability === "ready") {
    if (!readyLease(json)) return { availability: "unknown", reason: "invalid-host-response" };
    return { availability: "ready", leaseId: json.leaseId, expiresAt: json.expiresAt };
  }
  // Page metadata and raw errors never enter UI state; known reasons use local text.
  return { availability: json.availability === "unavailable" ? "unavailable" : "unknown", reason: json.reason === "host-unconfigured" ? "host-unconfigured" : "view-unavailable" };
}

function describeView(status: ViewStatus, reason: ScienceViewReason | undefined, valid: boolean, t: ReturnType<typeof useI18n>["t"]): string {
  if (!valid) return t("science.invalidTarget", undefined, "Invalid Science view target");
  if (reason === "host-unconfigured") return t("science.unconfigured", undefined, "Science viewer is not configured");
  switch (status) {
    case "loading": return t("science.connecting", undefined, "Checking Science viewer…");
    case "waiting": return t("science.waiting", undefined, "Waiting for a Science frame…");
    case "streaming": return t("science.streaming", undefined, "Receiving Science frames");
    case "expired": return t("science.expired", undefined, "Science view expired. Reopen to reconnect.");
    default: return t("science.unavailable", undefined, "Science view unavailable; connection state is unknown");
  }
}

function viewStatus(valid: boolean, connected: boolean, state: ViewState | null): ViewStatus {
  if (!valid) return "unavailable";
  if (!connected) return "unknown";
  return state?.status ?? "loading";
}

function validFrame(message: ScienceViewFrameMessage): boolean {
  const meta = message.metadata;
  return typeof message.jpegBase64 === "string" && message.jpegBase64.length > 0 && message.jpegBase64.length <= 8 * 1024 * 1024
    && message.jpegBase64.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(message.jpegBase64)
    && !!meta && Number.isInteger(meta.deviceWidth) && meta.deviceWidth > 0 && meta.deviceWidth <= 8192
    && Number.isInteger(meta.deviceHeight) && meta.deviceHeight > 0 && meta.deviceHeight <= 8192
    && Number.isFinite(meta.timestamp) && meta.timestamp >= 0;
}

export function ScienceViewer({ cwd, path }: { cwd: string; path: string }) {
  const { t } = useI18n();
  const apiBase = useApiBase();
  const socket = usePluginSocket();
  const connection = useShellConnectionStatus();
  const send = usePluginSend();
  const target = parseScienceTabPath(path);
  const [retry, setRetry] = useState(0);
  const scope = JSON.stringify([apiBase, cwd, path, retry]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const leaseRef = useRef<ViewLease | null>(null);
  const [state, setState] = useState<ViewState | null>(null);
  const [inputOn, setInputOn] = useState(false);
  const [fit, setFit] = useState(true);
  const connected = connection === "connected" && socket !== null;
  const currentState = state?.scope === scope && state.socket === socket ? state : null;
  const valid = !!target && !!cwd;
  const status = viewStatus(valid, connected, currentState);
  const jpeg = connected && status === "streaming" ? currentState?.jpeg ?? null : null;
  const hasFrame = jpeg !== null;

  useEffect(() => {
    const selectedTarget = parseScienceTabPath(path);
    if (!selectedTarget || !cwd || !connected || !socket) return;
    const controller = new AbortController();
    let disposed = false;
    let acquired: ViewLease | null = null;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    const update = (nextStatus: ViewStatus, reason?: ScienceViewReason) => {
      if (!disposed && scopeRef.current === scope) setState({ scope, socket, status: nextStatus, reason, jpeg: null });
    };
    update("loading");
    setInputOn(false);
    const release = () => {
      const lease = acquired;
      if (!lease) return;
      acquired = null;
      if (leaseRef.current === lease) leaseRef.current = null;
      if (expiry !== undefined) clearTimeout(expiry);
      // A view owns a subscription only. This path never stops or cancels a task.
      try { void Promise.resolve(send({ type: "science_view_unsubscribe", cwd, leaseId: lease.leaseId })).catch(() => {}); } catch { /* disconnected */ }
    };
    void (async () => {
      try {
        const view = await requestView(apiBase, cwd, selectedTarget, controller.signal);
        if (view.availability !== "ready") {
          update(view.availability, view.reason);
          return;
        }
        acquired = { scope, socket, leaseId: view.leaseId, expiresAt: view.expiresAt, release };
        if (disposed || scopeRef.current !== scope) { release(); return; }
        leaseRef.current = acquired;
        update("waiting");
        expiry = setTimeout(() => { update("expired"); release(); }, Math.min(view.expiresAt - Date.now(), 2_147_483_647));
        await send({ type: "science_view_subscribe", cwd, leaseId: acquired.leaseId });
      } catch {
        if (!controller.signal.aborted) { update("unknown"); release(); }
      }
    })();
    return () => { disposed = true; controller.abort(); release(); };
  }, [apiBase, cwd, path, scope, socket, connected, send]);

  const currentLease = () => {
    const lease = leaseRef.current;
    return connected && lease?.scope === scope && lease.socket === socket && lease.expiresAt > Date.now() ? lease : null;
  };
  usePluginMessage<ScienceViewFrameMessage>("science_view_frame", (message) => {
    const lease = currentLease();
    if (!lease || message.leaseId !== lease.leaseId || !validFrame(message)) return;
    setState({ scope, socket, status: "streaming", jpeg: message.jpegBase64 });
  });
  usePluginMessage<ScienceViewStatusMessage>("science_view_status", (message) => {
    const lease = currentLease();
    if (!lease || message.leaseId !== lease.leaseId || !["unavailable", "expired"].includes(message.state)) return;
    setState({ scope, socket, status: message.state === "expired" ? "expired" : "unavailable", jpeg: null });
    lease.release();
  });

  const sendInput = useCallback((input: BrowserFrameInput) => {
    const lease = leaseRef.current;
    if (!inputOn || !hasFrame || !connected || socket?.readyState !== WebSocket.OPEN || !lease || lease.scope !== scope || lease.socket !== socket || lease.expiresAt <= Date.now() || !isScienceViewInput(input)) return;
    try { void Promise.resolve(send({ type: "science_view_input", cwd, leaseId: lease.leaseId, input })).catch(() => {}); } catch { /* disconnected */ }
  }, [inputOn, hasFrame, connected, scope, socket, send, cwd]);

  const statusText = describeView(status, currentState?.reason, valid, t);
  const control = "science-control focus-ring";

  return (
    <section data-testid="science-viewer" className="science-surface flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]" aria-label={t("science.title", undefined, "Science")}>
      <header className="science-surface-header">
        <h2 className="science-surface-title min-w-0 flex-1">{target?.kind === "task" ? t("science.task", undefined, "Science task") : t("science.workspace", undefined, "Science workspace")}</h2>
        <div className="science-surface-actions">
        <button type="button" className={`${control} science-input-control`} data-enabled={inputOn} data-testid="science-view-input-toggle" aria-pressed={inputOn} disabled={!jpeg} onClick={() => setInputOn(value => !value)}>{inputOn ? t("science.inputOn", undefined, "Input: on") : t("science.inputOff", undefined, "Input: off")}</button>
        <button type="button" className={control} aria-pressed={fit} onClick={() => setFit(value => !value)}>{fit ? t("science.fit", undefined, "Fit") : t("science.oneToOne", undefined, "1:1")}</button>
        <button type="button" className={control} data-testid="science-view-retry" disabled={!target || !connected || status === "loading"} onClick={() => setRetry(value => value + 1)}>{t("science.reconnect", undefined, "Reconnect view")}</button>
        </div>
      </header>
      <p role="status" data-testid="science-view-status" className="science-surface-status" data-state={status}><span className="science-status-dot" aria-hidden="true" />{statusText}</p>
      <BrowserFrameSurface jpeg={jpeg} canInput={inputOn && !!jpeg} fit={fit} resizeEnabled={inputOn && !!jpeg} onInput={sendInput}
        testIdPrefix="science-view" frameAlt={t("science.frameAlt", undefined, "Live Science frame")} textBridgeLabel={t("science.textBridge", undefined, "Type into Science")}
        empty={<p className="science-empty-message">{statusText}</p>} />
      <p className="science-surface-note">{t("science.closeNote", undefined, "Read-only view. Closing this view does not stop a Science task.")}</p>
    </section>
  );
}
