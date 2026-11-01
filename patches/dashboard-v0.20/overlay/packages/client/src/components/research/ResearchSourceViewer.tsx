import { useEffect, useState } from "react";
import type { ResWorkflowSourceResponse } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { getResWorkflowSource } from "../../lib/api/res-workflow-api.js";
import { t } from "../../lib/i18n/i18n.js";

/** Only a recorded adoption/source ID, never an arbitrary path or session restore. */
export function ResearchSourceViewer({ cwd, path }: { cwd: string; path: string }) {
  const scope = `${cwd}\n${path}`;
  const [result, setResult] = useState<{ scope: string; data?: ResWorkflowSourceResponse; error?: string } | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const ids = /^research:source\/([\w-]{1,128})\/([\w-]{1,128})$/.exec(path);
    if (!ids) {
      setResult({ scope, error: t("research.invalidSource", undefined, "Invalid source reference") });
      return;
    }
    void getResWorkflowSource(cwd, ids[1], ids[2], abort.signal).then(data => {
      if (!abort.signal.aborted) setResult({ scope, data });
    }).catch(err => {
      if (!abort.signal.aborted) setResult({ scope, error: err instanceof Error ? err.message : String(err) });
    });
    return () => abort.abort();
  }, [cwd, path, scope]);
  const current = result?.scope === scope ? result : null;
  return <section data-testid="res-workflow-source-preview" className="flex h-full min-h-0 min-w-0 flex-col text-[var(--text-primary)]">
    <header className="shrink-0 space-y-2 border-b border-[var(--border-primary)] p-3 text-xs">
      <h2 className="break-all font-semibold">{current?.data?.source.label ?? t("research.sources", undefined, "Sources · unverified")}</h2>
      <p className="text-[var(--text-secondary)]">{t("research.sourceSnapshot", undefined, "Read-only bounded snapshot, not the complete original or verified evidence. Opening it does not resume a Pi session.")}</p>
      {current?.data && <p className="break-all text-[var(--text-secondary)]">SHA-256 · {current.data.source.sha256}{current.data.source.incomplete ? ` · ${t("research.incomplete", undefined, "incomplete")}` : ""}</p>}
    </header>
    {current?.error ? <p role="alert" className="break-words p-3 text-sm text-[var(--severity-error-fg)]">{current.error}</p> : current?.data ?
      <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words p-4 text-xs leading-relaxed" data-testid="res-workflow-source-text">{current.data.content}</pre> :
      <p role="status" className="p-3 text-xs text-[var(--text-secondary)]">{t("research.loadingSource", undefined, "Loading source snapshot…")}</p>}
  </section>;
}
