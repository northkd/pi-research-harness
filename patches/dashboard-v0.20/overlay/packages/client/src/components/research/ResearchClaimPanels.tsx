import { mdiShieldCheckOutline, mdiFileDocumentOutline, mdiCheckDecagram, mdiAlertCircleOutline } from "@mdi/js";
import { Icon } from "@mdi/react";
import { claimEvidence, type Claim, type ResearchEvent } from "./research-projection.js";

export function ResearchClaimPanels({
  claims,
  reviews,
  onOpenArtifact,
}: {
  claims: Claim[];
  reviews: ResearchEvent[];
  onOpenArtifact?: (path: string) => void;
}) {
  const accepted = claims.filter((row) => row.acceptance?.verdict === "accepted").length;

  return (
    <div className="win11-grid-cards">
      {/* Left Card: 验收关卡 · 逐主张记录 */}
      <section className="win11-card min-w-0 p-5 space-y-4" data-testid="research-claim-gates">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-[var(--accent-soft)] text-[var(--accent-text)]">
              <Icon path={mdiShieldCheckOutline} size={0.75} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">验收关卡 · 逐主张记录</h2>
              <p className="text-[11px] text-[var(--text-secondary)]">
                {accepted} / {claims.length} 条主张记录为内部验收通过；不代表所有关卡或整个课题已完成。
              </p>
            </div>
          </div>
          <span className="rounded-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2.5 py-0.5 font-mono text-xs font-semibold text-[var(--text-primary)]">
            {accepted} / {claims.length}
          </span>
        </div>

        {!claims.length && (
          <div className="win11-card-subtle p-4 text-xs text-[var(--text-secondary)]">
            暂无逐主张验收记录；不会从执行完成或聊天结论推断通过。
          </div>
        )}

        <ul className="space-y-3">
          {claims.map((claim) => {
            const isAccepted = claim.acceptance?.verdict === "accepted";
            return (
              <li
                key={claim.id}
                className="win11-card-subtle p-3.5 text-xs space-y-1.5"
                data-testid="research-claim-gate"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="font-semibold text-[var(--text-primary)] flex items-center gap-1.5">
                    <Icon
                      path={isAccepted ? mdiCheckDecagram : mdiAlertCircleOutline}
                      size={0.6}
                      className={isAccepted ? "text-[var(--accent-green)]" : "text-[var(--accent-orange)]"}
                    />
                    <span>{claim.id} · {claim.acceptance?.verdict ?? "尚未验收"}</span>
                  </p>
                </div>
                <p className="break-words text-[var(--text-secondary)]">
                  评审记录：
                  {claim.acceptance?.jury?.length
                    ? claim.acceptance.jury
                        .map((row) => `${row.modelId ?? "未记录模型"}（${row.family ?? "未记录模型族"}）`)
                        .join("；")
                    : "未记录评审模型与模型族"}
                </p>
                <p className="text-[var(--text-secondary)]">
                  反例检查：{claim.acceptance?.counterexample?.status ?? "未记录"}
                </p>
                <p className="text-[var(--text-secondary)]">
                  发表授权：{claim.publication?.authorized ? "已授权（非实际发表）" : "未授权"}
                </p>
                {!!claim.acceptance?.diagnostics?.length && (
                  <ul className="mt-2 list-inside list-disc text-[var(--severity-warning-fg)]">
                    {claim.acceptance.diagnostics.map((note, index) => (
                      <li key={index}>{note}</li>
                    ))}
                  </ul>
                )}
                {!!claim.acceptance?.unresolvedObligations?.length && (
                  <p className="mt-2 break-words text-[var(--text-secondary)]">
                    待解决义务：{claim.acceptance.unresolvedObligations.join("；")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>

        <div className="border-t border-[var(--border-primary)] pt-3 space-y-2">
          <h3 className="text-xs font-semibold text-[var(--text-primary)]">
            流程评审记录（不替代主张验收）
          </h3>
          {!reviews.length && (
            <p className="text-xs text-[var(--text-tertiary)]">暂无 review-round / review-gate 记录。</p>
          )}
          <ul className="space-y-2 text-xs">
            {reviews.slice(-12).reverse().map((event, index) => (
              <li key={index} className="win11-card-subtle break-words p-3 space-y-1">
                <div className="font-medium text-[var(--text-primary)]">
                  {event.kind} · {String(event.detail?.verdict ?? "未记录裁决")}
                  {typeof event.detail?.round === "number" ? ` · 第 ${event.detail.round} 轮` : ""}
                </div>
                {typeof event.detail?.observedModel === "string" && (
                  <p className="text-[var(--text-secondary)]">观测模型：{event.detail.observedModel}</p>
                )}
                {Array.isArray(event.detail?.diagnostics) &&
                  event.detail.diagnostics
                    .filter((value): value is string => typeof value === "string")
                    .map((note, n) => (
                      <p key={n} className="text-[var(--severity-warning-fg)]">{note}</p>
                    ))}
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* Right Card: 主张 (Claims) */}
      <section className="win11-card min-w-0 p-5 space-y-4" data-testid="research-claims">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-primary)] pb-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-[6px] bg-[var(--accent-soft)] text-[var(--accent-text)]">
              <Icon path={mdiFileDocumentOutline} size={0.75} />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-[var(--text-primary)]">主张</h2>
              <p className="text-[11px] text-[var(--text-secondary)]">
                课题已登记的科学主张及安全目录内的证据链映射
              </p>
            </div>
          </div>
          <span className="rounded-full bg-[var(--bg-secondary)] border border-[var(--border-primary)] px-2.5 py-0.5 font-mono text-xs font-semibold text-[var(--text-primary)]">
            {claims.length} 条
          </span>
        </div>

        {!claims.length && (
          <div className="win11-card-subtle p-4 text-xs text-[var(--text-tertiary)]">
            暂无主张记录。
          </div>
        )}

        <ul className="space-y-3">
          {claims.map((claim) => (
            <li key={claim.id} className="win11-card-subtle p-3.5 text-xs space-y-2">
              <p className="break-words font-semibold text-[var(--text-primary)]">
                {claim.id} · {claim.status}
                {claim.acceptance?.verdict ? ` · 内部验收：${claim.acceptance.verdict}` : ""}
              </p>
              <p className="whitespace-pre-wrap break-words leading-relaxed text-[var(--text-primary)]">
                {claim.statement}
              </p>
              {claim.publication?.authorized && (
                <p className="tint-action-green inline-block rounded px-2 py-0.5 text-[11px] font-medium">
                  发表已授权（非实际发表）
                </p>
              )}
              <div className="border-t border-[var(--border-primary)] pt-2">
                <p className="text-[11px] font-medium text-[var(--text-tertiary)]">已记录证据：</p>
                {claimEvidence(claim).length ? (
                  <ul className="mt-1.5 flex flex-wrap gap-1.5">
                    {claimEvidence(claim).map((path) => (
                      <li key={path}>
                        <button
                          type="button"
                          disabled={!onOpenArtifact}
                          onClick={() => onOpenArtifact?.(path)}
                          className="win11-btn px-2.5 py-1 font-mono text-[11px] text-[var(--accent-text)] underline disabled:no-underline"
                        >
                          {path}
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-1 text-[var(--text-tertiary)]">暂无可打开的目录内证据引用。</p>
                )}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
