import { randomUuid } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { ResWorkflowAdoption as Adoption, ResWorkflowAgentBudgetConsent, ResWorkflowAgentGrant } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { useEffect, useRef, useState } from "react";
import { authorizeResWorkflowAgent, ResWorkflowIntakeBudgetApiError, updateResWorkflowAgentBudget } from "../../lib/api/res-workflow-api.js";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { t } from "../../lib/i18n/i18n.js";

const BUTTON = "focus-ring min-h-9 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11";
const CONSENT: ResWorkflowAgentBudgetConsent = { scope: "this-job", budgetMayIncreaseCharges: true, unknownRetryMayBillAgain: true };
type Draft = { scope: string; revision: number; limit: string; unlimited: boolean; changed: boolean };
const selection = (job: Adoption) => JSON.stringify([...(job.historySelection ?? [])].sort());

/** This editor owns fresh consent; polling can update accounting without replacing its draft. */
export default function ResWorkflowIntakeBudgetControls({ cwd, job, grant, canAuthorize, onJob, onRefresh }: {
  cwd: string; job: Adoption; grant: ResWorkflowAgentGrant | null; canAuthorize: boolean;
  onJob: (next: Adoption) => void; onRefresh: () => void;
}) {
  const apiBase = useApiBase(), agent = job.agentJob!, budget = agent.budget;
  const scope = JSON.stringify([apiBase, cwd, job.id, grant?.grantHash, grant?.materialPlanId, grant?.materialPlanHash, job.model, selection(job)]);
  const revision = budget.revision ?? 0;
  const effective = budget.effectiveMaxRequests === undefined ? budget.unlimited ? null : budget.maxRequests : budget.effectiveMaxRequests;
  const snapshot = (): Draft => ({ scope, revision, limit: String(effective ?? budget.maxRequests), unlimited: effective === null, changed: false });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [consent, setConsent] = useState<string | null>(null);
  const [saveConsent, setSaveConsent] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadRequired, setReloadRequired] = useState(false);
  const [saved, setSaved] = useState(false);
  const inFlight = useRef(false), attempted = useRef<string | null>(null), controller = useRef<AbortController | null>(null);
  const epoch = useRef(0), previousScope = useRef(scope), mounted = useRef(false);
  if (previousScope.current !== scope) { epoch.current++; previousScope.current = scope; }
  const editor = draft?.scope === scope ? draft : null;
  const parsed = editor?.unlimited ? null : editor && /^\d+$/.test(editor.limit) && Number.isSafeInteger(Number(editor.limit)) ? Number(editor.limit) : undefined;
  const valid = parsed === null || parsed !== undefined && parsed >= 0;
  const custom = !!editor?.changed;
  const binding = JSON.stringify([scope, revision, custom, custom ? editor?.unlimited : false, custom ? editor?.limit : null]);
  const choiceKey = JSON.stringify([binding, editor?.revision, editor?.unlimited, editor?.limit]);
  const conflict = !!editor && editor.revision !== revision;
  const expired = agent.authorized && (!Number.isFinite(Date.parse(agent.expiresAt ?? "")) || Date.parse(agent.expiresAt!) <= Date.now());
  const terminal = ["cancelled", "confirmed", "failed"].includes(job.status) || ["cancelled", "proposal-ready"].includes(agent.phase);
  const editable = !terminal && !!grant && (canAuthorize || agent.authorized && budget.editable === true && !expired);
  const current = useRef({ scope, binding, job, editable, canAuthorize });
  current.current = { scope, binding, job, editable, canAuthorize };

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; controller.current?.abort(); }; }, []);
  useEffect(() => {
    setDraft(null); setConsent(null); setSaveConsent(null); setBusy(false); setError(null); setReloadRequired(false); setSaved(false); inFlight.current = false;
    return () => controller.current?.abort();
  }, [scope]);
  useEffect(() => { setConsent(null); setSaveConsent(null); }, [binding]);

  function change(next: Draft) { setDraft({ ...next, changed: true }); setConsent(null); setSaveConsent(null); setError(null); setSaved(false); }
  function reload() { setDraft(snapshot()); setConsent(null); setSaveConsent(null); setError(null); setReloadRequired(false); setSaved(false); onRefresh(); }
  async function submit(initial: boolean) {
    const live = current.current;
    if (inFlight.current || !mounted.current || live.scope !== scope || live.binding !== binding || getApiBase() !== apiBase || !live.editable ||
      initial && (!live.canAuthorize || consent !== binding || attempted.current === scope || custom && (!valid || conflict || reloadRequired)) ||
      !initial && (!editor || !custom || !valid || conflict || reloadRequired || saveConsent !== choiceKey)) return;
    const captured = job, token = epoch.current, abort = new AbortController(); controller.current = abort;
    inFlight.current = true; setBusy(true); setError(null); setSaved(false); setConsent(null); setSaveConsent(null);
    if (initial) attempted.current = scope;
    const fresh = () => mounted.current && !abort.signal.aborted && epoch.current === token && current.current.scope === scope && getApiBase() === apiBase;
    try {
      const next = initial ? await authorizeResWorkflowAgent(job.id, { cwd, requestId: randomUuid(), model: grant!.model,
        ...(custom ? { budget: { maxRequests: parsed!, consent: CONSENT } } : {}),
        consent: { analysisMode: "full-history-agent-v2", scope: "research-files-and-normal-messages", includeUnpublished: true, grantHash: grant!.grantHash, maxRequests: grant!.maxRequests, policyId: grant!.policy.id, unknownRetryMayBillAgain: true },
      }, abort.signal) : await updateResWorkflowAgentBudget(job.id, { cwd, requestId: randomUuid(), grantHash: grant!.grantHash, expectedRevision: editor!.revision, maxRequests: parsed!, consent: CONSENT }, abort.signal);
      if (!fresh()) return;
      if (next.id !== job.id || next.cwd !== cwd || next.agentJob?.mode !== "full-history-agent-v2" || next.agentJob.grant?.grantHash !== grant!.grantHash ||
        next.model?.provider !== captured.model?.provider || next.model?.id !== captured.model?.id || selection(next) !== selection(captured) ||
        initial && custom && (next.agentJob.budget.effectiveMaxRequests !== parsed || (next.agentJob.budget.revision ?? 0) < 1 || next.agentJob.budget.policy !== (parsed === null ? "unlimited" : "total-requests")) ||
        !initial && (next.agentJob.expiresAt !== captured.agentJob!.expiresAt || next.agentJob.authorizedAt !== captured.agentJob!.authorizedAt || next.agentJob.budget.usedRequests < captured.agentJob!.budget.usedRequests)) throw new Error("intake-budget-response-scope");
      const observed = current.current.job, observedAgent = observed.agentJob!;
      const liveRevision = observedAgent.budget.revision ?? 0;
      // A slow save reply must not roll back progress already seen by polling.
      if (liveRevision <= (next.agentJob.budget.revision ?? 0) && !["cancelled", "confirmed", "failed"].includes(observed.status) &&
        !["cancelled", "proposal-ready"].includes(observedAgent.phase) && next.agentJob.budget.usedRequests >= observedAgent.budget.usedRequests &&
        next.agentJob.completedNodes >= observedAgent.completedNodes && Date.parse(next.updatedAt) >= Date.parse(observed.updatedAt) &&
        (["completedHistories", "completedMessages", "completedBytes", "completedBatches"] as const).every(key => next.agentJob!.coverage[key] >= observedAgent.coverage[key])) onJob(next);
      setDraft(null); setSaved(!initial); onRefresh();
    } catch (caught) {
      if (!fresh()) return;
      setReloadRequired(!initial);
      setError(initial ? t("research.intakeAuthorizationUncertain", undefined, "The authorization result could not be confirmed. Refresh this task's status before taking any further action; the request may already have been accepted. It will not be sent again automatically.")
        : caught instanceof ResWorkflowIntakeBudgetApiError && caught.status === 409
          ? t("research.intakeBudgetConflict", undefined, "The budget changed elsewhere. Your draft is kept. Reload the current version before authorizing another save.")
          : t("research.intakeBudgetUncertain", undefined, "The save result could not be confirmed. Your draft is kept; refresh this task and reload the current budget before trying again. Nothing was resumed automatically."));
      onRefresh();
    } finally { if (fresh()) { inFlight.current = false; setBusy(false); } }
  }

  return <div className="space-y-3" data-testid="res-workflow-intake-budget-controls">
    {editable && !editor && <button type="button" className={BUTTON} data-testid="res-workflow-intake-budget-edit" disabled={busy} onClick={() => { setDraft(snapshot()); setSaved(false); }}>{t("research.intakeBudgetEdit", undefined, "Modify intake budget")}</button>}
    {editor && <fieldset disabled={busy || !editable} className="space-y-3 rounded border border-[var(--border-primary)] p-3">
      <legend className="font-semibold">{t("research.intakeBudgetEdit", undefined, "Modify intake budget")}</legend>
      <label className="flex flex-wrap items-center gap-2">{t("research.intakeBudgetLimit", undefined, "Total physical request cap")}
        <input data-testid="res-workflow-intake-budget-limit" type="number" min="0" step="1" inputMode="numeric" className="focus-ring min-h-11 w-32 rounded border border-[var(--border-primary)] bg-[var(--bg-primary)] px-2" disabled={editor.unlimited} value={editor.limit} onChange={event => change({ ...editor, limit: event.target.value })} />
      </label>
      <label className="flex min-h-11 items-center gap-3"><input type="checkbox" data-testid="res-workflow-intake-budget-unlimited" checked={editor.unlimited} onChange={event => change({ ...editor, unlimited: event.target.checked })} />{t("research.intakeBudgetNoLimit", undefined, "Unlimited requests for this intake task")}</label>
      <p>{t("research.intakeBudgetRules", undefined, "This total includes first attempts, recovery and unknown-result requests. A custom total replaces the original per-node and reserve limits. Unknown results still consume budget and retrying may incur another charge. Completed work, used calls, materials, model and original expiry stay unchanged.")}</p>
      <p>{t("research.intakeBudgetNextRequest", undefined, "Saving keeps the current request running; the next request uses the new cap. A cap of 0 or below the used count prevents further requests. Saving never continues a paused task; use its separate Continue button.")}</p>
      {!valid && <p role="alert">{t("research.intakeBudgetInvalid", undefined, "Enter a non-negative whole number within the safe integer range, or choose unlimited.")}</p>}
      {(conflict || reloadRequired) && <p role="alert">{t("research.intakeBudgetConflict", undefined, "The budget changed elsewhere. Your draft is kept. Reload the current version before authorizing another save.")}</p>}
      {(conflict || reloadRequired) && <button type="button" className={BUTTON} data-testid="res-workflow-intake-budget-reload" onClick={reload}>{t("research.intakeBudgetReload", undefined, "Reload current budget (discard draft)")}</button>}
      {agent.authorized && <>
        <label className="flex items-start gap-3"><input type="checkbox" data-testid="res-workflow-intake-budget-save-consent" checked={saveConsent === choiceKey && !conflict && !reloadRequired} disabled={!custom || !valid || conflict || reloadRequired} onChange={event => setSaveConsent(event.target.checked ? choiceKey : null)} /><span>{t("research.intakeBudgetSaveConsent", { cap: editor.unlimited ? t("research.intakeBudgetUnlimitedValue", undefined, "unlimited") : editor.limit }, "I authorize this intake task's total physical request budget to become {cap}. This can increase charges, including another charge after an unknown result. The original expiry does not change.")}</span></label>
        <button type="button" className={BUTTON} data-testid="res-workflow-intake-budget-save" disabled={!custom || !valid || conflict || reloadRequired || saveConsent !== choiceKey} onClick={() => void submit(false)}>{t("research.intakeBudgetSave", undefined, "Save intake budget")}</button>
      </>}
      <button type="button" className={BUTTON} onClick={() => { setDraft(null); setConsent(null); setSaveConsent(null); setError(null); setReloadRequired(false); }}>{t("research.intakeBudgetDiscard", undefined, "Discard budget draft")}</button>
    </fieldset>}
    {canAuthorize && <>
      <label className="flex items-start gap-3"><input type="checkbox" data-testid="res-workflow-intake-consent" checked={consent === binding} disabled={busy || attempted.current === scope || custom && (!valid || conflict || reloadRequired)} onChange={event => setConsent(event.target.checked ? binding : null)} />
        <span>{custom ? t("research.intakeCustomConsent", { cap: editor?.unlimited ? t("research.intakeBudgetUnlimitedValue", undefined, "unlimited") : editor?.limit ?? "?" }, "I authorize this exact model and selected materials, which may include unpublished research, for this intake task with a total physical request budget of {cap}, including recovery. A custom total replaces the original per-node and reserve limits; unknown-result retries may incur another charge. Authorization lasts 24 hours. I will review the draft. Experiments, session restoration and publication are not authorized.") : t("research.intakeConsent", { cap: grant!.maxRequests }, "I authorize this model to receive the selected research materials, which may include unpublished work, for this one intake task: up to {cap} total chargeable requests including automatic recovery. Unknown-result retries may be charged again. The grant lasts 24 hours; I will review the final draft. No experiments, session restore or publication are authorized.")}</span>
      </label>
      <button type="button" className={BUTTON} data-testid="res-workflow-intake-authorize" disabled={busy || consent !== binding || attempted.current === scope || custom && (!valid || conflict || reloadRequired)} onClick={() => void submit(true)}>{t("research.intakeAuthorize", undefined, "Authorize this intake task once")}</button>
    </>}
    {saved && <p role="status">{t("research.intakeBudgetSaved", undefined, "Intake budget saved. A paused task still needs an explicit Continue action.")}</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
