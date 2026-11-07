import { randomUuid } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { ResWorkflowAdoption as Adoption, ResWorkflowAgentGrant } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { useEffect, useRef, useState } from "react";
import { authorizeResWorkflowAgent } from "../../lib/api/res-workflow-api.js";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { t } from "../../lib/i18n/i18n.js";

const BUTTON = "focus-ring min-h-9 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11";
const selection = (job: Adoption) => JSON.stringify([...(job.historySelection ?? [])].sort());
const terminal = (job: Adoption) => ["cancelled", "confirmed", "failed"].includes(job.status) || ["cancelled", "proposal-ready"].includes(job.agentJob?.phase ?? "");

/** The legacy module path now owns model/material authorization only, with no quota editor. */
export default function ResWorkflowIntakeAuthorization({ cwd, job, grant, canAuthorize, onJob, onRefresh }: {
  cwd: string; job: Adoption; grant: ResWorkflowAgentGrant | null; canAuthorize: boolean;
  onJob: (next: Adoption) => void; onRefresh: () => void;
}) {
  const apiBase = useApiBase();
  const scope = JSON.stringify([apiBase, cwd, job.id, grant?.grantHash, grant?.materialPlanId, grant?.materialPlanHash, job.model, selection(job)]);
  const [consent, setConsent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false), attempted = useRef<string | null>(null), controller = useRef<AbortController | null>(null);
  const epoch = useRef(0), previousScope = useRef(scope), mounted = useRef(false);
  if (previousScope.current !== scope) { epoch.current++; previousScope.current = scope; }
  const current = useRef({ scope, job, canAuthorize });
  current.current = { scope, job, canAuthorize };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    setConsent(null); setBusy(false); setError(null); inFlight.current = false;
    return () => controller.current?.abort();
  }, [scope]);

  async function submit() {
    const live = current.current;
    if (!grant || inFlight.current || !mounted.current || live.scope !== scope || getApiBase() !== apiBase ||
      !live.canAuthorize || terminal(live.job) || consent !== scope || attempted.current === scope) return;
    const captured = job, token = epoch.current, abort = new AbortController(); controller.current = abort;
    inFlight.current = true; attempted.current = scope; setBusy(true); setError(null); setConsent(null);
    const fresh = () => mounted.current && !abort.signal.aborted && epoch.current === token && current.current.scope === scope && getApiBase() === apiBase;
    try {
      const next = await authorizeResWorkflowAgent(job.id, { cwd, requestId: randomUuid(), model: grant.model,
        consent: { analysisMode: "full-history-agent-v2", scope: "research-files-and-normal-messages", includeUnpublished: true,
          grantHash: grant.grantHash, policyId: grant.policy.id, unknownRetryMayBillAgain: true },
      }, abort.signal);
      if (!fresh()) return;
      if (next.id !== job.id || next.cwd !== cwd || next.agentJob?.mode !== "full-history-agent-v2" || !next.agentJob.authorized ||
        next.agentJob.grant?.grantHash !== grant.grantHash || next.model?.provider !== captured.model?.provider ||
        next.model?.id !== captured.model?.id || selection(next) !== selection(captured)) throw new Error("intake-authorization-response-scope");
      const observed = current.current.job, observedAgent = observed.agentJob!;
      // A delayed authorization reply must not replace newer progress seen through polling.
      if (!terminal(observed) && (observedAgent.budget.revision ?? 0) <= (next.agentJob.budget.revision ?? 0) &&
        next.agentJob.budget.usedRequests >= observedAgent.budget.usedRequests && next.agentJob.completedNodes >= observedAgent.completedNodes &&
        Date.parse(next.updatedAt) >= Date.parse(observed.updatedAt) &&
        (["completedHistories", "completedMessages", "completedBytes", "completedBatches"] as const).every(key => next.agentJob!.coverage[key] >= observedAgent.coverage[key])) onJob(next);
      onRefresh();
    } catch {
      if (!fresh()) return;
      setError(t("research.intakeAuthorizationUncertain", undefined, "The authorization result could not be confirmed. Refresh this task's status before taking any further action; the request may already have been accepted. It will not be sent again automatically."));
      onRefresh();
    } finally { if (fresh()) { inFlight.current = false; setBusy(false); } }
  }

  return <div className="space-y-3" data-testid="res-workflow-intake-authorization">
    {canAuthorize && <>
      <label className="flex items-start gap-3"><input type="checkbox" data-testid="res-workflow-intake-consent" checked={consent === scope} disabled={busy || attempted.current === scope} onChange={event => setConsent(event.target.checked ? scope : null)} />
        <span>{t("research.intakeConsent", undefined, "I authorize this model to process the selected research materials, which may include unpublished work, for this intake task and its recovery. Authorization lasts 24 hours; I will review the final draft. No experiments, session restoration or publication are authorized.")}</span>
      </label>
      <button type="button" className={BUTTON} data-testid="res-workflow-intake-authorize" disabled={busy || consent !== scope || attempted.current === scope} onClick={() => void submit()}>{t("research.intakeAuthorize", undefined, "Authorize this intake task once")}</button>
    </>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
