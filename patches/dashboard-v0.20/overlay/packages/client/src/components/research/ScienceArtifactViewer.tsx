/** Collected artifact bytes use the Science registry, never the generic file API. */
import { usePluginSocket, useShellConnectionStatus } from "@blackbelt-technology/dashboard-plugin-runtime";
import { parseScienceArtifactTabPath, projectScienceDetailResponse, SCIENCE_RECORD_LIMITS, type ScienceArtifact } from "@blackbelt-technology/pi-dashboard-shared/science-instances.js";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useApiBase } from "../../lib/api/api-context.js";
import { fetchJsonResponse } from "../../lib/api/fetch-json.js";
import { useI18n } from "../../lib/i18n/i18n.js";
import { ImagePreview } from "../preview/ImagePreview.js";

const PdfPreview = lazy(() => import("../preview/PdfPreview.js"));
interface ArtifactState { scope: symbol; artifact: ScienceArtifact; url: string; text: string | null }
type Translate = ReturnType<typeof useI18n>["t"];

async function readBoundedBody(response: Response, bytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const data = new Uint8Array(bytes);
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) { if (bytes !== 0) throw new Error("science-artifact-unavailable"); return data; }
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      if (!(value instanceof Uint8Array) || size + value.byteLength > data.byteLength) throw new Error("science-artifact-unavailable");
      data.set(value, size); size += value.byteLength;
    }
  } finally {
    if (!complete) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (size !== bytes) throw new Error("science-artifact-unavailable");
  return data;
}
async function readArtifact(url: string, artifact: ScienceArtifact, signal: AbortSignal): Promise<{ blob: Blob; text: string | null }> {
  const response = await fetch(url, { signal, redirect: "error" });
  const refuseResponse = async (): Promise<never> => { await response.body?.cancel().catch(() => {}); throw new Error("science-artifact-unavailable"); };
  if (!response.ok || response.headers.get("content-type")?.split(";")[0].trim() !== artifact.mediaType) return refuseResponse();
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > SCIENCE_RECORD_LIMITS.artifactBytes)) return refuseResponse();
  const reportedHash = response.headers.get("x-science-artifact-sha256");
  if (reportedHash !== artifact.sha256) return refuseResponse();
  const data = await readBoundedBody(response, artifact.bytes);
  // The owner-scoped endpoint verifies bytes before returning this fixed hash.
  // WebCrypto adds a browser check where available; plain HTTP lacks subtle.
  if (globalThis.crypto?.subtle) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", data)), byte => byte.toString(16).padStart(2, "0")).join("");
    if (digest !== artifact.sha256) throw new Error("science-artifact-unavailable");
  }
  if (signal.aborted) throw new Error("science-artifact-unavailable");
  const text = artifact.mediaType.startsWith("text/") ? new TextDecoder("utf-8", { fatal: true }).decode(data) : null;
  return { blob: new Blob([data.buffer], { type: artifact.mediaType }), text };
}
async function loadArtifact(apiBase: string, cwd: string, target: { taskId: string; artifactId: string }, signal: AbortSignal) {
  const base = `${apiBase}/api/res-workflow/science/instances/${target.taskId}`;
  const query = `?cwd=${encodeURIComponent(cwd)}`;
  const { res, json } = await fetchJsonResponse<unknown>(`${base}${query}`, { signal, redirect: "error" });
  const detail = projectScienceDetailResponse(json);
  if (!res.ok || detail.availability !== "ready" || detail.instance.id !== target.taskId) throw new Error("science-artifact-unavailable");
  const artifact = detail.instance.artifacts.find(value => value.id === target.artifactId);
  if (!artifact) throw new Error("science-artifact-unavailable");
  return { artifact, ...await readArtifact(`${base}/artifacts/${target.artifactId}${query}`, artifact, signal) };
}
function describeArtifact(valid: boolean, failed: boolean, ready: boolean, t: Translate): string {
  if (!valid) return t("science.artifact.invalid", undefined, "Invalid Science artifact target");
  if (failed) return t("science.artifact.unavailable", undefined, "Science artifact unavailable; access or collection state is unknown.");
  if (ready) return t("science.artifact.ready", undefined, "Collected artifact · integrity verified");
  return t("science.artifact.loading", undefined, "Reading collected Science artifact…");
}

export function ScienceArtifactViewer({ cwd, path }: { cwd: string; path: string }) {
  const apiBase = useApiBase();
  const socket = usePluginSocket();
  const connection = useShellConnectionStatus();
  const { t } = useI18n();
  const [retry, setRetry] = useState(0);
  const scopeKey = JSON.stringify([apiBase, cwd, path, retry]);
  const scopeRef = useRef({ key: scopeKey, socket, connection, token: Symbol() });
  // Returning to an earlier directory or connection still requires fresh reads.
  // Invalidate during render so no old content appears before effect cleanup.
  if (scopeRef.current.key !== scopeKey || scopeRef.current.socket !== socket || scopeRef.current.connection !== connection) {
    scopeRef.current = { key: scopeKey, socket, connection, token: Symbol() };
  }
  const scope = scopeRef.current.token;
  const [state, setState] = useState<ArtifactState | null>(null);
  const [failed, setFailed] = useState<symbol | null>(null);
  const current = state?.scope === scope ? state : null;
  const valid = parseScienceArtifactTabPath(path) !== null && !!cwd;

  useEffect(() => {
    const target = parseScienceArtifactTabPath(path);
    if (!target || !cwd) return;
    const controller = new AbortController(); let disposed = false; let objectUrl: string | undefined;
    const timeout = setTimeout(() => controller.abort(), 15_000);
    void (async () => {
      try {
        const result = await loadArtifact(apiBase, cwd, target, controller.signal);
        if (disposed || scopeRef.current.token !== scope || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(result.blob);
        setState({ scope, artifact: result.artifact, url: objectUrl, text: result.text });
      } catch {
        controller.abort();
        if (!disposed && scopeRef.current.token === scope) setFailed(scope);
      } finally { clearTimeout(timeout); }
    })();
    return () => { disposed = true; controller.abort(); clearTimeout(timeout); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [apiBase, cwd, path, scope]);

  const status = describeArtifact(valid, failed === scope, current !== null, t);
  const target = { kind: "file" as const, cwd, path: current?.artifact.name ?? "" };
  return <section data-testid="science-artifact-viewer" className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-[var(--bg-primary)] text-[var(--text-primary)]">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--border-primary)] px-3 py-2">
      <h2 className="min-w-0 flex-1 break-words text-sm font-semibold">{current?.artifact.name ?? t("science.artifact.title", undefined, "Science artifact")}</h2>
      {current && <a className="focus-ring tap-target rounded-[var(--radius-control)] border border-[var(--border-primary)] px-3 py-1.5 text-xs" href={current.url} download={current.artifact.name}>{t("science.artifact.download", undefined, "Download")}</a>}
      <button type="button" className="focus-ring tap-target rounded-[var(--radius-control)] border border-[var(--border-primary)] px-3 py-1.5 text-xs disabled:opacity-50" disabled={!valid || !current && failed !== scope} onClick={() => setRetry(value => value + 1)}>{t("science.artifact.reload", undefined, "Reload artifact")}</button>
    </header>
    <p role="status" className="shrink-0 border-b border-[var(--border-primary)] px-3 py-2 text-xs text-[var(--text-secondary)]">{status}</p>
    <div className="min-h-0 min-w-0 flex-1 overflow-auto p-3">
      {current && (current.artifact.mediaType.startsWith("image/") ? <ImagePreview target={target} srcUrl={current.url} />
        : current.artifact.mediaType === "application/pdf" ? <Suspense fallback={<p>{t("science.artifact.loading", undefined, "Reading collected Science artifact…")}</p>}><PdfPreview target={target} srcUrl={current.url} /></Suspense>
          : <pre data-testid="science-artifact-text" className="whitespace-pre-wrap break-words font-mono text-xs">{current.text}</pre>)}
    </div>
  </section>;
}
