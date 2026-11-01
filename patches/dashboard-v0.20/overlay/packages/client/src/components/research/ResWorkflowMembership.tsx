import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { getApiBase, useApiBase } from "../../lib/api/api-context.js";
import { joinResWorkflowSession } from "../../lib/api/res-workflow-api.js";
import { t } from "../../lib/i18n/i18n.js";

type Membership = DashboardSession["resWorkflow"];
type Target = Pick<DashboardSession, "id" | "cwd" | "resWorkflow">;

export function useResWorkflowMembership(target: Target, connectionGeneration = 0, onJoined?: (id: string, membership: NonNullable<Membership>) => void) {
  const apiBase = useApiBase();
  const { id, cwd } = target;
  const scope = JSON.stringify([apiBase, connectionGeneration, id, cwd]);
  const currentScope = useRef(scope);
  currentScope.current = scope;
  const action = useRef<{ scope: string; controller: AbortController } | null>(null);
  const [result, setResult] = useState<{ scope: string; membership?: Membership; joining?: boolean; error?: string } | null>(null);
  const local = result?.scope === scope ? result : null;

  useEffect(() => () => {
    if (action.current?.scope === scope) action.current.controller.abort();
  }, [scope]);

  const join = useCallback(async () => {
    if (target.resWorkflow || action.current?.scope === scope && !action.current.controller.signal.aborted) return;
    action.current?.controller.abort();
    const controller = new AbortController();
    action.current = { scope, controller };
    setResult({ scope, joining: true });
    const current = () => !controller.signal.aborted && currentScope.current === scope && getApiBase() === apiBase;
    try {
      const reply = await joinResWorkflowSession(cwd, id, controller.signal);
      if (current()) {
        setResult({ scope, membership: reply.resWorkflow });
        onJoined?.(id, reply.resWorkflow);
      }
    } catch (error) {
      if (current()) setResult({ scope, error: error instanceof Error ? error.message : t("research.joinSessionFailed", undefined, "Could not join res-workflow") });
    } finally {
      if (action.current?.controller === controller) action.current = null;
    }
  }, [target.resWorkflow, scope, cwd, id, apiBase, onJoined]);

  return { membership: target.resWorkflow ?? local?.membership, joining: local?.joining === true, error: local?.error, join };
}

export function ResWorkflowMemberBadge({ membership }: { membership: Membership }) {
  if (!membership) return null;
  return (
    <span
      data-testid="res-workflow-member"
      title={t("research.membershipOnly", undefined, "Association only: does not import history, send material or start research.")}
      className="inline-flex shrink-0 items-center rounded-md border border-[var(--border-secondary)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-[11px] text-[var(--text-secondary)]"
    >res-workflow</span>
  );
}

export function ResWorkflowJoinButton({ joining, onJoin }: { joining: boolean; onJoin: () => void }) {
  const label = t("research.joinResWorkflow", undefined, "Join res-workflow");
  return (
    <button
      type="button"
      data-testid="res-workflow-join-session"
      aria-label={label}
      title={t("research.membershipOnly", undefined, "Association only: does not import history, send material or start research.")}
      disabled={joining}
      onClick={event => { event.stopPropagation(); onJoin(); }}
      className="focus-ring min-h-[36px] max-sm:min-h-[44px] rounded-lg border border-[var(--border-secondary)] px-2 text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-hover)] disabled:opacity-50"
    >{joining ? t("research.joiningResWorkflow", undefined, "Joining res-workflow…") : label}</button>
  );
}

export function ResWorkflowMembershipError({ error }: { error?: string }) {
  if (!error) return null;
  return <p role="alert" data-testid="res-workflow-membership-error" className="mt-1 break-words text-xs text-[var(--severity-error-fg)]">{error}</p>;
}
