import { usePluginSocket, useShellConnectionStatus } from "@blackbelt-technology/dashboard-plugin-runtime";
import { isResearchWorkbenchObservation, type ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";
import type { ResWorkflowAdoption } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { ApiHttpError, fetchJsonResponse } from "../../lib/api/fetch-json.js";

export type ObservationStatus = "loading" | "current" | "stale" | "unavailable";
interface RecordState { scope: symbol; value: ResearchWorkbenchObservation | null; failed: boolean; error: string | null }
export function useResearchWorkbenchLive({ cwd, adoption, adopted, charter, connectionGeneration = 0, refreshSignal }: {
  cwd: string; adoption: ResWorkflowAdoption | null; adopted: boolean; charter?: object; connectionGeneration?: number; refreshSignal?: string;
}) {
  const apiBase = useApiBase(), socket = usePluginSocket(), authRequired = useShellConnectionStatus() === "auth_required";
  const charterText = charter ? JSON.stringify(charter) : null;
  const key = JSON.stringify([apiBase, cwd, connectionGeneration, authRequired, adopted, adoption?.id, adoption?.cwd, charterText]);
  const current = useRef({ key, socket, token: Symbol() });
  if (current.current.key !== key || socket !== null && current.current.socket !== socket) current.current = { key, socket, token: Symbol() };
  const scope = current.current.token;
  const [record, setRecord] = useState<RecordState | null>(null);
  const [manual, setManual] = useState(0);
  const enabled = adopted && !!adoption && !!charterText && !authRequired;
  useEffect(() => {
    if (!enabled || !adoption || !charterText) return;
    let disposed = false, pending = false;
    let charterHash: string | null = null;
    let controller: AbortController | null = null, timeout: ReturnType<typeof setTimeout> | undefined;
    const valid = () => !disposed && current.current.token === scope && getApiBase() === apiBase;
    async function load() {
      if (!valid() || pending || document.hidden) return;
      pending = true; const abort = new AbortController(); controller = abort;
      try {
        const deadline = new Promise<never>((_, reject) => { timeout = setTimeout(() => { abort.abort(); reject(new Error("timeout")); }, 9_000); });
        const read = async () => {
          if (!charterHash) {
            if (!globalThis.crypto?.subtle) throw new Error("charter-proof-unavailable");
            const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(charterText!));
            if (!valid() || abort.signal.aborted) throw new DOMException("Aborted", "AbortError");
            charterHash = `sha256:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, "0")).join("")}`;
          }
          return fetchJsonResponse<unknown>(`${apiBase}/api/res-workflow/workbench-sync?cwd=${encodeURIComponent(adoption!.cwd)}`, { signal: abort.signal });
        };
        const { res, json } = await Promise.race([read(), deadline]);
        if (!valid() || abort.signal.aborted) return;
        if (!res.ok) throw new ApiHttpError({ status: res.status, statusText: "", contentType: "application/json", bodySnippet: "", message: "workbench-read-failed" });
        if (!isResearchWorkbenchObservation(json) || json.cwd !== adoption!.cwd || json.adoptionId !== adoption!.id || json.charterHash !== charterHash) throw new Error("workbench-scope-invalid");
        setRecord({ scope, value: json, failed: false, error: null });
      } catch (error) {
        if (!valid()) return;
        const refused = error instanceof ApiHttpError && [401, 403, 404].includes(error.status);
        setRecord(previous => ({ scope, value: refused ? null : previous?.scope === scope ? previous.value : null, failed: true,
          error: "研究执行观测暂不可用；正式科研记录仍保留，观测状态待同步。" }));
      } finally { clearTimeout(timeout); pending = false; }
    }
    void load();
    const poll = setInterval(() => void load(), 5_000);
    const visible = () => { if (!document.hidden) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { disposed = true; controller?.abort(); clearTimeout(timeout); clearInterval(poll); document.removeEventListener("visibilitychange", visible); };
  }, [scope, enabled, apiBase, cwd, adoption, charterText, refreshSignal, manual]);
  const visible = enabled && record?.scope === scope && getApiBase() === apiBase ? record : null;
  const value = visible?.value ?? null;
  const oldHeartbeat = value ? Date.now() - Date.parse(value.heartbeatAt) > 15_000 || Date.parse(value.heartbeatAt) - Date.now() > 60_000 : false;
  const status: ObservationStatus = !enabled ? "unavailable" : !visible ? "loading" : !value ? "unavailable" : visible.failed || oldHeartbeat ? "stale" : "current";
  const refreshObservation = useCallback(() => setManual(value => value + 1), []);
  return { workbench: value, observationStatus: status, observationError: visible?.error ?? (oldHeartbeat ? "观测服务心跳已过期；以下仅为上次观测，当前执行状态未知。" : null), refreshObservation };
}
