import { useState } from "react";
import { mdiShieldCheckOutline, mdiFileDocumentOutline } from "@mdi/js";
import { Icon } from "@mdi/react";
import { claimEvidence, type Claim, type ResearchEvent } from "./research-projection.js";

/** One row per scientific claim; execution, acceptance and publication remain distinct. */
export function ResearchClaimPanels({ claims, reviews, onOpenArtifact }: {
  claims: Claim[];
  reviews: ResearchEvent[];
  onOpenArtifact?: (path: string) => void;
}) {
  const accepted = claims.filter(row => row.acceptance?.verdict === "accepted").length;
  const [showAllReviews, setShowAllReviews] = useState(false);
  const visibleReviews = (showAllReviews ? reviews : reviews.slice(-12)).slice().reverse();
  return <div className="research-claims-layout space-y-5">
    <section className="win11-card min-w-0 p-5 space-y-4" data-testid="research-claim-gates">
      <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--border-primary)] pb-4">
        <div className="flex items-start gap-3">
          <Icon path={mdiShieldCheckOutline} size={0.85} className="mt-0.5 text-[var(--accent-text)]" />
          <div><h2 className="text-base font-semibold text-[var(--text-primary)]">主张与逐条验收</h2><p className="mt-1 text-xs text-[var(--text-secondary)]">{accepted} / {claims.length} 条主张记录为内部验收通过；不代表整个课题完成或实际发表。</p></div>
        </div>
        <span className="research-status-label">{claims.length} 条主张</span>
      </header>
      <div data-testid="research-claims">
        {!claims.length && <p className="py-5 text-sm text-[var(--text-tertiary)]">暂无主张记录；执行结束不会自动生成验收结论。</p>}
        <ul className="space-y-3">
          {claims.map(claim => {
            const evidence = claimEvidence(claim);
            return <li key={claim.id} className="research-claim-row rounded-lg border border-[var(--border-primary)] p-4 text-xs" data-testid="research-claim-gate">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <strong className="font-mono text-[var(--text-primary)]">{claim.id}</strong>
                <div className="flex flex-wrap gap-2"><span className="research-status-label">主张状态：{claim.status}</span><span className="research-status-label">内部验收：{claim.acceptance?.verdict ?? "尚未验收"}</span><span className="research-status-label">发表授权：{claim.publication?.authorized ? "已授权（非实际发表）" : "未授权"}</span></div>
              </div>
              <p className="my-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-[var(--text-primary)]">{claim.statement}</p>
              <div className="flex flex-wrap items-center gap-2 text-[var(--text-secondary)]">
                <span>已记录证据：</span>
                {evidence.length ? evidence.map(path => <button key={path} type="button" disabled={!onOpenArtifact} onClick={() => onOpenArtifact?.(path)} className="win11-btn inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-[var(--accent-text)]"><Icon path={mdiFileDocumentOutline} size={0.55} />{path}</button>) : <span className="text-[var(--text-tertiary)]">暂无可打开的目录内证据引用。</span>}
              </div>
              <details className="mt-4 border-t border-[var(--border-primary)] pt-3" open={claim.acceptance?.verdict === "blocked" || undefined}>
                <summary className="cursor-pointer font-medium text-[var(--text-secondary)]">评审、反例与待解决事项</summary>
                <div className="mt-3 space-y-2 leading-relaxed text-[var(--text-secondary)]">
                  <p>评审记录：{claim.acceptance?.jury?.length ? claim.acceptance.jury.map(row => `${row.modelId ?? "未记录模型"}（${row.family ?? "未记录模型族"}）`).join("；") : "未记录评审模型与模型族"}</p>
                  <p>反例检查：{claim.acceptance?.counterexample?.status ?? "未记录"}</p>
                  {claim.acceptance?.scope && <p>验收范围：{claim.acceptance.scope}</p>}
                  {claim.acceptance?.decidedAt && <p>裁决时间：{claim.acceptance.decidedAt}</p>}
                  {!!claim.acceptance?.diagnostics?.length && <ul className="list-inside list-disc text-[var(--severity-warning-fg)]">{claim.acceptance.diagnostics.map((note, index) => <li key={index}>{note}</li>)}</ul>}
                  {!!claim.acceptance?.unresolvedObligations?.length && <div><p className="font-medium">待解决义务：</p><ul className="list-inside list-disc">{claim.acceptance.unresolvedObligations.map((note, index) => <li key={index}>{note}</li>)}</ul></div>}
                </div>
              </details>
            </li>;
          })}
        </ul>
      </div>
    </section>
    <section className="win11-card min-w-0 p-5 space-y-4" aria-label="流程评审记录">
      <header><h2 className="text-sm font-semibold text-[var(--text-primary)]">流程评审记录</h2><p className="mt-1 text-xs text-[var(--text-tertiary)]">过程评审保留原始裁决与诊断，不替代逐主张验收。</p></header>
      {!reviews.length && <p className="text-xs text-[var(--text-tertiary)]">暂无 review-round / review-gate 记录。</p>}
      <ul className="space-y-2 text-xs">{visibleReviews.map((event, index) => <li key={`${event.at ?? ""}:${index}`} className="rounded-lg border border-[var(--border-primary)] p-3 space-y-1.5">
        <div className="flex flex-wrap justify-between gap-2"><strong className="font-medium text-[var(--text-primary)]">{event.kind} · {String(event.detail?.verdict ?? "未记录裁决")}{typeof event.detail?.round === "number" ? ` · 第 ${event.detail.round} 轮` : ""}</strong>{event.at && <time className="text-[var(--text-tertiary)]">{event.at}</time>}</div>
        {typeof event.detail?.observedModel === "string" && <p className="text-[var(--text-secondary)]">观测模型：{event.detail.observedModel}</p>}
        {Array.isArray(event.detail?.diagnostics) && event.detail.diagnostics.filter((value): value is string => typeof value === "string").map((note, n) => <p key={n} className="text-[var(--severity-warning-fg)]">{note}</p>)}
      </li>)}</ul>
      {reviews.length > 12 && <button type="button" className="research-show-more" onClick={() => setShowAllReviews(value => !value)}>{showAllReviews ? "仅显示最近 12 条" : `查看全部 ${reviews.length} 条评审记录`}</button>}
    </section>
  </div>;
}
