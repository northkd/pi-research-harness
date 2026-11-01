/** Directory-scoped records from the independent host; this component never submits work. */
import { usePluginSocket, useShellConnectionStatus } from "@blackbelt-technology/dashboard-plugin-runtime";
import { projectScienceDetailResponse, projectScienceListResponse, type ScienceInstanceDetail, type ScienceInstanceStatus, type ScienceInstanceSummary, type ScienceReadReason } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import { useEffect, useRef, useState } from "react";
import { useApiBase } from "../../lib/api/api-context.js";
import { fetchJsonResponse } from "../../lib/api/fetch-json.js";
import { useI18n } from "../../lib/i18n/i18n.js";

interface RecordState {
  scope: symbol;
  instances: ScienceInstanceSummary[];
  loading: boolean;
  failed: boolean;
  reason?: ScienceReadReason;
}
interface DetailState { scope: symbol; taskId: string; instance: ScienceInstanceDetail | null; loading: boolean }
class AccessRefused extends Error {}
const control = "win11-btn focus-ring px-3 py-1.5 text-xs text-[var(--text-primary)] disabled:opacity-50";
type Translate = ReturnType<typeof useI18n>["t"];
const observedTime = (value: number | null, language: string, t: Translate) => value === null ? t("science.records.unknown", undefined, "Unknown") : new Date(value).toLocaleString(language);

function describeRecords(current: RecordState | null, t: Translate, authRequired: boolean): string {
  if (authRequired) return t("science.records.unavailable", undefined, "Science records are unavailable; current state is unknown.");
  if (!current || current.loading) return t("science.records.loading", undefined, "Checking Science records…");
  if (!current.failed) return current.instances.length ? t("science.records.observed", undefined, "Bound instances · latest host observations") : t("science.records.empty", undefined, "No Science instances are bound to this directory.");
  if (current.instances.length) return t("science.records.staleNotice", undefined, "Connection unavailable; showing the last observation.");
  if (current.reason === "host-unconfigured") return t("science.records.unconfigured", undefined, "Science records are not configured.");
  return t("science.records.unavailable", undefined, "Science records are unavailable; current state is unknown.");
}
async function readDetail(url: string, taskId: string, signal: AbortSignal): Promise<ScienceInstanceDetail | null> {
  const { res, json } = await fetchJsonResponse<unknown>(url, { signal });
  if ([401, 403, 404].includes(res.status)) throw new AccessRefused();
  const response = projectScienceDetailResponse(json);
  return res.ok && response.availability === "ready" && response.instance.id === taskId ? response.instance : null;
}
function InstanceDetails({ state, language, t, taskId, onOpenArtifact }: { state: DetailState | null; language: string; t: Translate; taskId: string; onOpenArtifact?: (taskId: string, artifactId: string) => void }) {
  if (state?.loading) return <p className="text-xs">{t("science.records.loading", undefined, "Checking Science records…")}</p>;
  const instance = state?.instance;
  if (!instance) return <p className="text-xs text-[var(--text-secondary)]">{t("science.records.unavailable", undefined, "Science records are unavailable; current state is unknown.")}</p>;
  return <>
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      <dt>{t("science.records.created", undefined, "Recorded")}</dt><dd>{observedTime(instance.createdAt, language, t)}</dd>
      <dt>{t("science.records.models", undefined, "Requested models")}</dt><dd className="break-words">{instance.modelIds.length ? instance.modelIds.join(", ") : t("science.records.unknown", undefined, "Unknown")}</dd>
      <dt>{t("science.records.usage", undefined, "Usage")}</dt><dd>{t("science.records.unknown", undefined, "Unknown")}</dd>
      <dt>{t("science.records.cost", undefined, "Cost")}</dt><dd>{t("science.records.unknown", undefined, "Unknown")}</dd>
    </dl>
    <h3 className="mt-3 text-xs font-semibold">{t("science.records.artifacts", undefined, "Collected artifacts")}</h3>
    {instance.artifacts.length === 0 ? <p className="mt-1 text-xs text-[var(--text-secondary)]">{t("science.records.noArtifacts", undefined, "No artifacts have been collected.")}</p>
      : <ul className="mt-2 space-y-2">{instance.artifacts.map(artifact => <li key={artifact.id} className="flex min-w-0 flex-wrap items-center gap-2 text-xs">
        <span className="min-w-0 flex-1 break-words">{artifact.name}</span><span className="text-[var(--text-tertiary)]">{artifact.bytes} B</span>
        <button type="button" className={control} disabled={!onOpenArtifact} onClick={() => onOpenArtifact?.(taskId, artifact.id)}>{t("science.records.preview", undefined, "Preview")}</button>
      </li>)}</ul>}
  </>;
}

export function ScienceInstances({ cwd, refreshSignal, connectionGeneration = 0, onOpenTask, onOpenArtifact }: {
  cwd: string;
  refreshSignal?: string;
  connectionGeneration?: number;
  onOpenTask?: (taskId: string) => void;
  onOpenArtifact?: (taskId: string, artifactId: string) => void;
}) {
  const { t, language } = useI18n();
  const apiBase = useApiBase();
  const socket = usePluginSocket();
  const authRequired = useShellConnectionStatus() === "auth_required";
  const scopeKey = JSON.stringify([apiBase, cwd, connectionGeneration]);
  const scopeRef = useRef({ key: scopeKey, socket, authRequired, token: Symbol() });
  // A disconnect keeps this owner's last observations. A new socket or auth
  // boundary must hide them during render, including when an old scope returns.
  if (scopeRef.current.key !== scopeKey || socket !== null && scopeRef.current.socket !== socket || scopeRef.current.authRequired !== authRequired) {
    scopeRef.current = { key: scopeKey, socket, authRequired, token: Symbol() };
  } else { scopeRef.current.socket = socket; }
  const scope = scopeRef.current.token;
  const [refresh, setRefresh] = useState(0);
  const requestKey = JSON.stringify([refresh, refreshSignal]);
  const requestRef = useRef({ scope, key: requestKey });
  if (requestRef.current.scope !== scope || requestRef.current.key !== requestKey) requestRef.current = { scope, key: requestKey };
  const request = requestRef.current;
  const [records, setRecords] = useState<RecordState | null>(null);
  const [selected, setSelected] = useState<{ scope: symbol; taskId: string } | null>(null);
  const [details, setDetails] = useState<DetailState | null>(null);
  const current = !authRequired && records?.scope === scope ? records : null;
  const taskId = selected?.scope === scope && current?.instances.some(row => row.id === selected.taskId) ? selected.taskId : null;
  const currentDetail = details?.scope === scope && details.taskId === taskId ? details : null;
  const endpoint = `${apiBase}/api/res-workflow/science/instances`;

  useEffect(() => {
    if (authRequired) { setRecords(null); setSelected(null); setDetails(null); return; }
    const controller = new AbortController(); let disposed = false;
    const update = (change: (previous: RecordState | null) => RecordState) => {
      if (!disposed && scopeRef.current.token === scope && requestRef.current === request) setRecords(previous => change(previous?.scope === scope ? previous : null));
    };
    update(previous => ({ scope, instances: previous?.instances ?? [], loading: true, failed: previous?.failed ?? false }));
    void (async () => {
      try {
        const { res, json } = await fetchJsonResponse<unknown>(`${endpoint}?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal });
        if ([401, 403, 404].includes(res.status)) throw new AccessRefused();
        const response = res.ok ? projectScienceListResponse(json) : { availability: "unknown" as const, reason: "host-offline" as const };
        if (response.availability === "ready") update(() => ({ scope, instances: response.instances, loading: false, failed: false }));
        else update(previous => ({ scope, instances: previous?.instances ?? [], loading: false, failed: true, reason: response.reason }));
      } catch (error) {
        if (!controller.signal.aborted) update(previous => ({ scope, instances: error instanceof AccessRefused ? [] : previous?.instances ?? [], loading: false, failed: true }));
      }
    })();
    return () => { disposed = true; controller.abort(); };
  }, [cwd, scope, endpoint, request, authRequired]);

  useEffect(() => {
    const timer = setInterval(() => { if (document.visibilityState === "visible") setRefresh(value => value + 1); }, 15_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!taskId) return;
    const controller = new AbortController(); let disposed = false;
    setDetails({ scope, taskId, instance: null, loading: true });
    void readDetail(`${endpoint}/${taskId}?cwd=${encodeURIComponent(cwd)}`, taskId, controller.signal).then(instance => {
      if (!disposed && scopeRef.current.token === scope && requestRef.current === request) setDetails({ scope, taskId, instance, loading: false });
    }, error => {
      if (disposed || scopeRef.current.token !== scope || requestRef.current !== request) return;
      if (error instanceof AccessRefused) setRecords({ scope, instances: [], loading: false, failed: true });
      setDetails({ scope, taskId, instance: null, loading: false });
    });
    return () => { disposed = true; controller.abort(); };
  }, [cwd, endpoint, scope, taskId, request]);

  const status = (value: ScienceInstanceStatus): string => {
    switch (value) {
      case "running": return t("science.records.running", undefined, "Running");
      case "completed": return t("science.records.completed", undefined, "Execution completed");
      case "failed": return t("science.records.failed", undefined, "Failed");
      case "waiting-approval": return t("science.records.waitingApproval", undefined, "Waiting for approval");
      case "cancelled": return t("science.records.cancelled", undefined, "Cancellation confirmed");
      default: return t("science.records.unknown", undefined, "Unknown");
    }
  };
  const stale = current?.failed ?? false;
  const statusText = describeRecords(current, t, authRequired);

  return <section data-testid="science-instances" className="win11-card min-w-0 p-4" aria-label={t("science.records.title", undefined, "Science instances")}>
    <div className="flex flex-wrap items-center gap-2">
      <h2 className="min-w-0 flex-1 text-sm font-semibold text-[var(--text-primary)]">{t("science.records.title", undefined, "Science instances")}</h2>
      <button type="button" className={control} disabled={authRequired || (current?.loading ?? true)} onClick={() => setRefresh(value => value + 1)}>{t("science.records.refresh", undefined, "Refresh Science records")}</button>
    </div>
    <p role="status" className="mt-2 text-xs text-[var(--text-secondary)]">{statusText}</p>
    <ul className="mt-3 space-y-2.5">
      {current?.instances.map(row => <li key={row.id} data-testid="science-instance" className="win11-card-subtle min-w-0 p-3.5">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-semibold">{status(row.status)}</span>
          {(stale || row.stale) && <span className="text-[var(--accent-orange-text)]">{t("science.records.stale", undefined, "Stale")}</span>}
        </div>
        <p className="mt-1 break-all font-mono text-[11px] text-[var(--text-secondary)]">{row.id}</p>
        <p className="mt-1 text-xs text-[var(--text-tertiary)]">{t("science.records.lastObserved", undefined, "Last observed")}: {observedTime(row.lastObservedAt, language, t)}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className={control} disabled={!onOpenTask} onClick={() => onOpenTask?.(row.id)}>{t("science.records.openTask", undefined, "Open task")}</button>
          <button type="button" className={control} aria-expanded={taskId === row.id} onClick={() => setSelected(previous => previous?.scope === scope && previous.taskId === row.id ? null : { scope, taskId: row.id })}>{t("science.records.details", undefined, "Details")}</button>
        </div>
        {taskId === row.id && <div className="mt-3 min-w-0 border-t border-[var(--border-primary)] pt-3">
          <InstanceDetails state={currentDetail} language={language} t={t} taskId={row.id} onOpenArtifact={onOpenArtifact} />
        </div>}
      </li>)}
    </ul>
    <p className="mt-3 text-[11px] text-[var(--text-tertiary)]">{t("science.records.boundary", undefined, "Execution status does not establish scientific acceptance or permission to publish. Viewing records does not submit or rerun work.")}</p>
  </section>;
}
