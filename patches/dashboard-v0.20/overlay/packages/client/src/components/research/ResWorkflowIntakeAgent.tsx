import { randomUuid } from "@blackbelt-technology/dashboard-plugin-runtime";
import type { ResWorkflowAdoption as Adoption, ResWorkflowAgentGrant, ResWorkflowAgentPhase } from "@blackbelt-technology/pi-dashboard-shared/res-workflow.js";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { resumeResWorkflowAgent } from "../../lib/api/res-workflow-api.js";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { t } from "../../lib/i18n/i18n.js";

const BUTTON = "focus-ring min-h-9 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 max-sm:min-h-11";
const count = (n: number) => Number.isSafeInteger(n) && n >= 0 ? String(n) : "?";
const sameModel = (a: Adoption["model"], b: Adoption["model"]) => !!a && !!b && a.provider === b.provider && a.id === b.id;
const sameSelection = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const terminal = (job: Adoption) => job.status === "cancelled" || job.status === "confirmed" || job.status === "failed" || job.agentJob?.phase === "cancelled" || job.agentJob?.phase === "proposal-ready";
const IntakeBudgetControls = lazy(() => import("./ResWorkflowIntakeBudgetControls.js"));
const continuable = (agent: NonNullable<Adoption["agentJob"]>) => !agent.needsUserAction ||
  ["budget-exhausted", "node-attempt-limit"].includes(agent.needsUserAction.reason) &&
  ["total-requests", "unlimited"].includes(agent.budget.policy ?? "") &&
  (agent.budget.effectiveMaxRequests === null || Number.isSafeInteger(agent.budget.effectiveMaxRequests) && agent.budget.effectiveMaxRequests! > agent.budget.usedRequests);

export function intakeAgentPhaseLabel(phase: ResWorkflowAgentPhase): string {
  switch (phase) {
    case "preparing": return t("research.intakePreparing", undefined, "Local preparation · no model request");
    case "awaiting-authorization": return t("research.intakeAwaiting", undefined, "One intake task · awaiting initial authorization");
    case "reviewing": return t("research.intakeReviewing", undefined, "Reading all selected normal messages in batches");
    case "repairing": return t("research.intakeRepairing", undefined, "Recovering this batch within the authorized budget");
    case "merging": return t("research.intakeMerging", undefined, "Combining completed batches");
    case "validating": return t("research.intakeValidating", undefined, "Checking coverage and source links");
    case "awaiting-user": return t("research.intakePaused", undefined, "Intake paused · action required");
    case "proposal-ready": return t("research.intakeReady", undefined, "Full review complete · draft awaits your review");
    case "cancelled": return t("research.intakeCancelled", undefined, "Intake cancelled · no automatic continuation");
  }
}

/** UI checks display/consent consistency; the service owns grant and attempt enforcement. */
function validGrant(job: Adoption): ResWorkflowAgentGrant | null {
  const agent = job.agentJob, g = agent?.grant, p = agent?.plan;
  if (!g || !p || g.analysisMode !== "full-history-agent-v2" || !g.grantHash || g.materialPlanId !== p.planId || g.materialPlanHash !== p.planHash ||
    !sameModel(g.model, job.model) || !sameModel(g.model, p.model) || !sameSelection(g.historySelection, job.historySelection ?? []) ||
    !Number.isSafeInteger(g.baseRequests) || g.baseRequests <= 0 || g.baseRequests > 128 || g.baseRequests !== p.batchCount + p.mergeCallCount ||
    g.retryReserve !== Math.min(16, Math.ceil(g.baseRequests * .2), 128 - g.baseRequests) || g.maxRequests !== g.baseRequests + g.retryReserve ||
    g.policy.id !== "bounded-intake-v2" || g.policy.maxNodeAttempts !== 3 || g.policy.maxJsonRepairsPerNode !== 1 || g.policy.maxUnknownRetriesPerNode !== 1 ||
    g.policy.maxLengthEscalationsPerNode !== 1 || g.policy.unknownRetryMayBillAgain !== true || g.policy.grantLifetimeMs !== 86400000 ||
    !Number.isSafeInteger(g.policy.initialOutputTokens) || g.policy.initialOutputTokens <= 0 || !Number.isSafeInteger(g.policy.maxOutputTokens) || g.policy.maxOutputTokens < g.policy.initialOutputTokens ||
    p.blockers.length > 0 || agent?.budget.maxRequests !== g.maxRequests || agent.budget.baseRequests !== g.baseRequests || agent.budget.retryReserve !== g.retryReserve) return null;
  return g;
}

function actionLabel(reason: NonNullable<NonNullable<Adoption["agentJob"]>["needsUserAction"]>["reason"]): string {
  switch (reason) {
    case "authorization-required": return t("research.intakeNeedsAuthorization", undefined, "Review the fixed scope and total budget below before starting.");
    case "authorization-expired": return t("research.intakeExpired", undefined, "The 24-hour authorization expired. Checkpoints and request counts are kept; continuation is paused.");
    case "budget-exhausted": return t("research.intakeBudgetExhausted", undefined, "The authorized request budget is exhausted. Completed batches are kept; no extra request is authorized.");
    case "node-attempt-limit": return t("research.intakeAttemptLimit", undefined, "This batch reached its attempt limit. Completed batches are kept; manual review is needed.");
    case "model-changed": return t("research.intakeModelChanged", undefined, "The physical model changed. Processing is paused; the existing authorization does not cover another model.");
    case "access-required": return t("research.intakeAccess", undefined, "Material access needs attention. No additional model request will be started until it is resolved.");
    case "material-invalid": return t("research.intakeMaterial", undefined, "Some selected material cannot be fully reviewed. Check the listed blockers; sampling will not replace full-history coverage.");
    case "storage-unavailable": return t("research.intakeStorage", undefined, "Checkpoint storage is unavailable. Processing is paused to protect completed work and request accounting.");
  }
}

export function ResWorkflowIntakeAgent({ cwd, job, onJob, onRefresh }: { cwd: string; job: Adoption; onJob: (next: Adoption) => void; onRefresh: () => void }) {
  const apiBase = useApiBase();
  const agent = job.agentJob!;
  const unlimited = agent.budget.unlimited === true;
  const grant = validGrant(job);
  const scope = `${apiBase}\0${cwd}\0${job.id}`;
  const grantKey = JSON.stringify([scope, grant?.grantHash, grant?.materialPlanId, grant?.materialPlanHash, grant?.model, grant?.historySelection, grant?.baseRequests, grant?.retryReserve, grant?.maxRequests, grant?.policy]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resumeEdge = useRef<string | null>(null);
  const resumePending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const current = useRef({ scope, grantKey, job });
  current.current = { scope, grantKey, job };
  const expiry = Date.parse(agent.expiresAt ?? "");
  const expired = agent.authorized && (!Number.isFinite(expiry) || expiry <= Date.now());
  const canAuthorize = !terminal(job) && !agent.authorized && agent.phase === "awaiting-authorization" && !!grant &&
    (!agent.needsUserAction || agent.needsUserAction.reason === "authorization-required");
  const localResume = !agent.authorized && !agent.plan && !agent.grant && agent.phase === "preparing";
  const paidResume = agent.authorized && !!grant && !expired && continuable(agent);
  const resumeEligible = !terminal(job) && !agent.workerActive && agent.resumeRequired && (localResume || paidResume);

  useEffect(() => {
    setError(null); setBusy(false);
    return () => controller.current?.abort();
  }, [grantKey]);

  const accept = (next: Adoption, abort: AbortController, expectedGrant: string | undefined) => {
    if (abort.signal.aborted || current.current.scope !== scope || current.current.grantKey !== grantKey || getApiBase() !== apiBase || terminal(current.current.job)) return;
    if (next.id !== job.id || next.cwd !== cwd || next.agentJob?.mode !== "full-history-agent-v2" ||
      !sameModel(next.model, job.model) || !sameSelection(next.historySelection ?? [], job.historySelection ?? []) ||
      expectedGrant !== undefined && next.agentJob.grant?.grantHash !== expectedGrant) throw new Error("intake-response-scope-mismatch");
    const observed = current.current.job;
    if ((next.agentJob.budget.revision ?? 0) < (observed.agentJob?.budget.revision ?? 0) || next.agentJob.budget.usedRequests < (observed.agentJob?.budget.usedRequests ?? 0) ||
      Date.parse(next.updatedAt) < Date.parse(observed.updatedAt)) { onRefresh(); return; }
    onJob(next); onRefresh();
  };

  useEffect(() => {
    if (!resumeEligible || !localResume) { resumeEdge.current = null; return; }
    const edge = `${grantKey}\0local`;
    if (resumeEdge.current === edge) return;
    const abort = new AbortController();
    // A discarded StrictMode mount must not send then abort a continuation.
    const timer = setTimeout(() => {
      const live = current.current.job.agentJob;
      if (abort.signal.aborted || current.current.scope !== scope || current.current.grantKey !== grantKey || getApiBase() !== apiBase || terminal(current.current.job) ||
        !live || live.authorized || live.plan || live.grant || live.phase !== "preparing" || live.workerActive || !live.resumeRequired || live.needsUserAction) return;
      resumeEdge.current = edge; controller.current = abort;
      void resumeResWorkflowAgent(job.id, { cwd, requestId: randomUuid() }, abort.signal)
        .then(next => accept(next, abort, undefined))
        .catch(() => { if (!abort.signal.aborted && current.current.scope === scope) { setError(t("research.intakeResumeUncertain", undefined, "Continuation could not be confirmed. Check this task's status; completed batches and the existing budget remain in place. No new authorization was sent.")); onRefresh(); } });
    }, 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [resumeEligible, grantKey, localResume]);

  const resume = async () => {
    const live = current.current.job.agentJob;
    if (!resumeEligible || localResume || !grant || busy || resumePending.current || current.current.scope !== scope || current.current.grantKey !== grantKey || getApiBase() !== apiBase ||
      terminal(current.current.job) || !live?.authorized || live.workerActive || !live.resumeRequired || !continuable(live) || Date.parse(live.expiresAt ?? "") <= Date.now()) return;
    resumePending.current = true; setBusy(true); setError(null);
    const abort = new AbortController(); controller.current = abort;
    try {
      const next = await resumeResWorkflowAgent(job.id, { cwd, requestId: randomUuid(), grantHash: grant.grantHash }, abort.signal);
      accept(next, abort, grant.grantHash);
    } catch {
      if (!abort.signal.aborted && current.current.scope === scope) {
        setError(t("research.intakeResumeUncertain", undefined, "Continuation could not be confirmed. Check this task's status; completed batches and the existing budget remain in place. No new authorization was sent.")); onRefresh();
      }
    } finally { resumePending.current = false; if (!abort.signal.aborted && current.current.scope === scope) setBusy(false); }
  };

  return <div data-testid="res-workflow-intake-agent" className="space-y-3 rounded border border-[var(--border-primary)] p-3">
    <h3 className="font-semibold">{intakeAgentPhaseLabel(agent.phase)}</h3>
    <p className="break-all">{job.model?.provider}/{job.model?.id}</p>
    {agent.preparation && <p data-testid="res-workflow-intake-preparation">{t("research.intakePreparationCounts", { done: count(agent.preparation.historiesScanned), total: count(agent.preparation.historiesTotal), messages: count(agent.preparation.normalMessages), bytes: count(agent.preparation.normalBytes), batches: count(agent.preparation.packedBatches) }, "Local preparation: histories scanned {done} / {total} · normal messages {messages} · {bytes} bytes · packed batches {batches}")}</p>}
    <p>{t("research.intakeScope", undefined, "All normal text in the selected histories is reviewed; there is no sampling fallback. Thinking, tool arguments and credentials are excluded. Directory files use the frozen bounded snapshot; artifact metadata is identified separately. No experiments or old-session restore.")}</p>
    <ul>{job.selectedHistories?.map(history => <li key={history.id} className="break-words">{history.name || `Pi ${history.sessionId}`}</li>)}</ul>
    {agent.plan && <>
      <p>{t("research.intakePlanCounts", { batches: count(agent.plan.batchCount), merges: count(agent.plan.mergeCallCount), messages: count(agent.plan.eligibleMessages), bytes: count(agent.plan.eligibleBytes) }, "Material plan: {batches} reading batches + {merges} merge/final requests · selected histories {messages} normal messages / {bytes} bytes")}</p>
      {agent.plan.directorySnapshot && <p>{t("research.historyDirectoryCounts", { files: agent.plan.directorySnapshot.sourceCount, bytes: agent.plan.directorySnapshot.bytes, batches: agent.plan.directorySnapshot.batchCount, artifacts: agent.plan.directorySnapshot.metadataOnlyArtifacts }, "Bounded directory snapshot: {files} sources / {bytes} bytes / {batches} batches; {artifacts} artifacts contribute metadata only.")}</p>}
      {agent.plan.blockers.length > 0 && <p role="alert">{t("research.intakeBlocked", undefined, "Local preparation is blocked. Selected histories will not be replaced by samples.")} {agent.plan.blockers.join(" · ")}</p>}
    </>}
    <p data-testid="res-workflow-intake-budget">{unlimited
      ? t("research.intakeUnlimitedBudget", { base: count(agent.budget.baseRequests), used: count(agent.budget.usedRequests), first: count(agent.budget.baseUsed), recovery: count(agent.budget.recoveryUsed), inflight: count(agent.budget.inFlightRequests), unknown: count(agent.budget.unknownRequests) }, "This task: unlimited calls and recovery attempts · planned base workload {base} · total calls {used} · first attempts {first}, recovery attempts {recovery}, in flight {inflight}, result unknown {unknown}")
      : t("research.intakeEffectiveBudget", { cap: count(agent.budget.effectiveMaxRequests ?? agent.budget.maxRequests), used: count(agent.budget.usedRequests), remaining: count(agent.budget.remainingRequests), first: count(agent.budget.baseUsed), recovery: count(agent.budget.recoveryUsed), inflight: count(agent.budget.inFlightRequests), unknown: count(agent.budget.unknownRequests) }, "This intake task: total physical request cap {cap} · used {used}, remaining {remaining} · first attempts {first}, recovery attempts {recovery}, in flight {inflight}, result unknown {unknown}")}</p>
    <p data-testid="res-workflow-intake-checkpoints">{t("research.intakeCheckpoints", { done: count(agent.completedNodes), reused: count(agent.reusedCheckpoints) }, "Validated checkpoints {done} · reused {reused}. Completed batches stay in this task and are not sent again for local recovery.")}</p>
    <p data-testid="res-workflow-intake-coverage">{t("research.intakeCoverage", { done: count(agent.coverage.completedHistories), total: count(agent.coverage.selectedHistories), messages: count(agent.coverage.completedMessages), totalMessages: count(agent.coverage.eligibleMessages), bytes: count(agent.coverage.completedBytes), totalBytes: count(agent.coverage.eligibleBytes), batches: count(agent.coverage.completedBatches), totalBatches: count(agent.coverage.totalBatches) }, "Full-history coverage: {done} / {total} histories · {messages} / {totalMessages} normal messages · {bytes} / {totalBytes} bytes · {batches} / {totalBatches} batches. Confirmation stays unavailable until full coverage is validated.")}</p>
    {(unlimited || agent.budget.policy === "total-requests") && <>
      <p data-testid="res-workflow-intake-unlimited-policy">{unlimited ? t("research.intakeUnlimitedPolicy", undefined, "For this task, supplemental authorization removes the total call and retry-count limits. The materials, model and original 24-hour expiry are unchanged. You can cancel at any time; an unknown-result retry may incur another charge.") : t("research.intakeTotalPolicy", undefined, "This task uses one total physical request cap for first attempts and recovery. The original per-node attempt and recovery-reserve limits are superseded. Unknown-result retries may incur another charge.")}</p>
      <p data-testid="res-workflow-intake-original-grant">{t("research.intakeOriginalBudgetRecord", { base: count(agent.budget.baseRequests), reserve: count(agent.budget.retryReserve), cap: count(agent.budget.maxRequests) }, "Original plan record: base {base} + recovery reserve {reserve} = {cap} calls. The current task budget is shown above.")}</p>
      {agent.budget.authorization && <p>{t("research.intakeSupplementalAt", { time: agent.budget.authorization.authorizedAt, end: agent.budget.authorization.expiresAt }, "Supplemental authorization for this task recorded {time} · original expiry {end}")}</p>}
    </>}
    {grant && !unlimited && agent.budget.policy !== "total-requests" && <>
      <p>{t("research.intakePolicy", { initial: grant.policy.initialOutputTokens, max: grant.policy.maxOutputTokens }, "Automatic recovery is bounded: at most 3 attempts per node; at most one JSON repair, one length escalation and one retry after an unknown result, all sharing the reserve. Output limit starts at {initial} and may increase to {max} tokens. An unknown-result retry may incur another charge.")}</p>
      <p>{t("research.intakeLifetime", undefined, "Authorization lasts 24 hours. Reopening the page or continuing the same task does not renew it or increase the budget.")}</p>
    </>}
    {agent.authorized && <p data-testid="res-workflow-intake-expiry">{t("research.intakeAuthorizedUntil", { start: agent.authorizedAt ?? "?", end: agent.expiresAt ?? "?" }, "Authorized {start} · expires {end}")}</p>}
    {(agent.needsUserAction || expired) && <p role="status" data-testid="res-workflow-intake-action">{!expired && resumeEligible && !localResume ? t("research.intakeReadyToContinue", undefined, "The current budget allows continuation. Completed batches are retained. Click Continue to resume this same task; nothing resumes automatically.") : actionLabel(expired ? "authorization-expired" : agent.needsUserAction!.reason)}</p>}
    <Suspense fallback={null}><IntakeBudgetControls key={scope} cwd={cwd} job={job} grant={grant} canAuthorize={canAuthorize} onJob={onJob} onRefresh={onRefresh} /></Suspense>
    {resumeEligible && !localResume && <button type="button" className={BUTTON} data-testid="res-workflow-intake-resume" disabled={busy} onClick={() => void resume()}>{t("research.intakeResumeExplicit", undefined, "Continue this intake task with its current budget (may incur charges)")}</button>}
    {!grant && agent.phase === "awaiting-authorization" && <p role="alert">{t("research.intakeInvalidPlan", undefined, "The displayed plan and authorization budget do not match. Refresh the task before authorizing; no model request has been started from this page.")}</p>}
    {error && <p role="alert">{error}</p>}
    <p className="text-[var(--text-secondary)]">{t("research.agentUpdatedAt", { time: Number.isFinite(Date.parse(job.updatedAt)) ? new Date(job.updatedAt).toLocaleString() : "?" }, "Progress updated {time}")}</p>
  </div>;
}
