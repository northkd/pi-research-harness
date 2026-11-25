import type { ResWorkflowSpawnChoiceState } from "../../hooks/useResWorkflowSpawnChoice.js";
import { t } from "../../lib/i18n/i18n.js";

const BUTTON = "focus-ring min-h-9 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-secondary)] px-3 py-2 text-xs font-semibold text-[var(--text-primary)] hover:bg-[var(--bg-hover)] max-sm:min-h-11";

export function ResWorkflowSpawnChoice({ choice, onChoose, onRetry, onCancel }: {
  choice: ResWorkflowSpawnChoiceState;
  onChoose: (join: boolean) => void;
  onRetry: () => void;
  onCancel: () => void;
}) {
  const title = t("research.spawnJoinQuestion", undefined, "Join this new session to res-workflow?");
  return (
    <section data-testid="res-workflow-spawn-choice" role="region" aria-label={title} className="min-w-0 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3 text-sm text-[var(--text-primary)]">
      <h2 className="font-semibold">{title}</h2>
      <p className="mt-1 break-all font-mono text-xs text-[var(--text-tertiary)]">{choice.cwd}</p>
      {choice.status === "checking" ? (
        <p role="status" className="mt-2 text-xs text-[var(--text-secondary)]">{t("research.spawnCheckingConnection", undefined, "Checking this directory's connection. No session has been created.")}</p>
      ) : choice.status === "error" ? (
        <p role="alert" className="mt-2 break-words text-xs text-[var(--text-secondary)]">{t("research.spawnConnectionFailed", undefined, "Could not check the directory connection. Retry, or explicitly create an ordinary session.")} {choice.error}</p>
      ) : (
        <p className="mt-2 text-xs text-[var(--text-secondary)]">{t("research.spawnJoinExplanation", undefined, "Joining only records membership. It does not import old messages, run research or authorize model sharing or translation.")}</p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {choice.status === "choice" && <button type="button" data-testid="res-workflow-spawn-join" className={BUTTON} onClick={() => onChoose(true)}>{t("research.spawnJoin", undefined, "Join res-workflow")}</button>}
        {choice.status === "error" && <button type="button" data-testid="res-workflow-spawn-retry" className={BUTTON} onClick={onRetry}>{t("research.spawnRetryConnection", undefined, "Retry connection check")}</button>}
        {choice.status !== "checking" && <button type="button" data-testid="res-workflow-spawn-ordinary" className={BUTTON} onClick={() => onChoose(false)}>{t("research.spawnOrdinary", undefined, "Ordinary session")}</button>}
        <button type="button" data-testid="res-workflow-spawn-cancel" className={BUTTON} onClick={onCancel}>{t("research.spawnCancel", undefined, "Cancel · keep draft")}</button>
      </div>
    </section>
  );
}
