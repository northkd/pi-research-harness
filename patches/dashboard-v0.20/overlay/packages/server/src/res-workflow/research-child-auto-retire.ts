/**
 * Automatic retirement of finished Multi-Agent (`research_session`) child
 * sessions so their Pi, RPC-keeper, and MCP child processes exit cleanly and
 * release memory once their assigned work is durably reported.
 *
 * Safety invariants:
 * - Only formal child sessions with `research_session` provenance
 *   (`parentSessionId !== session.id`, valid `spawnToken`, local non-remote).
 * - Never retires a current Main Agent (including a promoted former child).
 * - Requires durable terminal completion (`dispatch.isCompleted` or
 *   `communication.isCompleted`) with no active reactivation reservation.
 * - Requires the session to be settled (`idle` or `active` with no active tool,
 *   not compacting, empty pending queues, no unanswered UI/prompt asks).
 * - Requires no active descendants (own plans, live formal children, active or
 *   queued native subagents, unreleased child reservations) and no open
 *   unresolved communication requests.
 * - Preserves manually resumed post-completion follow-up chats while a browser
 *   subscriber is actively viewing them.
 * - Sends a graceful `{ type: "shutdown" }` hint first, waits briefly for Pi
 *   (and its MCP children / keeper) to exit cleanly, then resolves through the
 *   shared `sessionTerminator.terminate` ladder (preserving the one-terminator
 *   invariant). Never deletes or hides session history.
 */
import { signalZero as defaultSignalZero } from "@blackbelt-technology/pi-dashboard-shared/platform/process.js";
import type { DashboardSession } from "@blackbelt-technology/pi-dashboard-shared/types.js";
import type { Terminate } from "../spawn-process/session-terminator.js";

const DEFAULT_SETTLE_GRACE_MS = 8_000;
const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;
const DEFAULT_POLL_INTERVAL_MS = 150;
const DEFAULT_MAX_ATTEMPTS = 3;
/** Window after completion within which a fresh registration still counts as the original run. */
const MANUAL_RESUME_WINDOW_MS = 10_000;

interface ProvenanceLike {
  parentSessionId?: string;
  spawnToken?: string;
  role?: string;
}

function provenanceOf(session: DashboardSession | undefined): ProvenanceLike | undefined {
  if (!session) return undefined;
  const direct = session.researchSession as ProvenanceLike | undefined;
  if (direct?.parentSessionId) return direct;
  const nested = (session.pluginRefs?.["res-workflow"] as { researchSession?: ProvenanceLike } | undefined)
    ?.researchSession;
  return nested?.parentSessionId ? nested : undefined;
}

export interface ResearchChildAutoRetireDeps {
  listSessions(): readonly DashboardSession[];
  getSession(sessionId: string): DashboardSession | undefined;
  isSessionCompleted(spawnToken: string): boolean;
  completedAt?(spawnToken: string): number | null;
  isCurrentMainSession(sessionId: string): boolean;
  hasActiveChildren(sessionId: string): boolean;
  hasOpenRequests(sessionId: string): boolean;
  hasReactivatedReservation?(spawnToken: string): boolean;
  hasPendingUiRequest(sessionId: string): boolean;
  hasPendingPromptRequests(sessionId: string): boolean;
  hasSubscriber?(sessionId: string): boolean;
  sendShutdownHint(sessionId: string): boolean;
  terminate: Terminate;
  markManualClose?(sessionId: string): void;
  unregisterIfAlive?(sessionId: string): void;
  signalZero?: typeof defaultSignalZero;
  settleGraceMs?: number;
  shutdownGraceMs?: number;
  pollIntervalMs?: number;
  maxAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export interface ResearchChildAutoRetire {
  sweep(): Promise<void>;
  dispose(): void;
}

export function createResearchChildAutoRetire(
  deps: ResearchChildAutoRetireDeps,
): ResearchChildAutoRetire {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const signalZero = deps.signalZero ?? defaultSignalZero;
  const settleGraceMs = deps.settleGraceMs ?? DEFAULT_SETTLE_GRACE_MS;
  const shutdownGraceMs = deps.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const log = deps.log ?? ((m: string) => console.log(m));
  const warn = deps.warn ?? ((m: string) => console.warn(m));

  const eligibleSince = new Map<string, { since: number; key: string }>();
  const attempts = new Map<string, number>();
  const inFlight = new Set<string>();
  let disposed = false;

  const instanceKey = (session: DashboardSession): string =>
    `${session.id}:${session.pid ?? "nopid"}:${session.pidRecordedAt ?? 0}`;

  function hasLiveFormalChild(parentId: string, allSessions: readonly DashboardSession[]): boolean {
    for (const row of allSessions) {
      if (row.id === parentId || row.status === "ended") continue;
      const p = provenanceOf(row);
      if (p?.parentSessionId === parentId) return true;
    }
    return false;
  }

  function isManuallyResumedWithSubscriber(session: DashboardSession, spawnToken: string): boolean {
    if (!deps.hasSubscriber?.(session.id)) return false;
    const completedAt = deps.completedAt?.(spawnToken);
    if (completedAt == null || session.pidRecordedAt === undefined) return false;
    return session.pidRecordedAt > completedAt + MANUAL_RESUME_WINDOW_MS;
  }

  function isEligible(session: DashboardSession | undefined, allSessions: readonly DashboardSession[]): boolean {
    if (!session || session.originDeviceId) return false;
    if (session.status !== "idle" && session.status !== "active") return false;
    if (session.currentTool != null) return false;
    if (session.compacting === true) return false;
    if ((session.pendingQueues?.steering?.length ?? 0) > 0) return false;
    if ((session.pendingQueues?.followUp?.length ?? 0) > 0) return false;

    const p = provenanceOf(session);
    if (!p?.parentSessionId || p.parentSessionId === session.id) return false;
    if (typeof p.spawnToken !== "string" || p.spawnToken.length === 0) return false;

    if (deps.isCurrentMainSession(session.id)) return false;
    if (!deps.isSessionCompleted(p.spawnToken)) return false;
    if (deps.hasReactivatedReservation?.(p.spawnToken)) return false;

    if (deps.hasPendingUiRequest(session.id)) return false;
    if (deps.hasPendingPromptRequests(session.id)) return false;
    if (deps.hasActiveChildren(session.id)) return false;
    if (hasLiveFormalChild(session.id, allSessions)) return false;
    if (deps.hasOpenRequests(session.id)) return false;
    if (isManuallyResumedWithSubscriber(session, p.spawnToken)) return false;

    return true;
  }

  async function waitForGracefulExit(sessionId: string, pid: number | undefined): Promise<void> {
    if (shutdownGraceMs <= 0) return;
    const deadline = now() + shutdownGraceMs;
    while (!disposed && now() < deadline) {
      const current = deps.getSession(sessionId);
      const ended = !current || current.status === "ended";
      const pidGone = pid === undefined || signalZero(pid) === "esrch";
      if (ended && pidGone) return;
      await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
    }
  }

  async function retireSession(sessionId: string, key: string): Promise<void> {
    if (disposed || inFlight.has(sessionId)) return;
    inFlight.add(sessionId);
    try {
      const allSessions = deps.listSessions();
      const fresh = deps.getSession(sessionId);
      if (!isEligible(fresh, allSessions) || !fresh) {
        eligibleSince.delete(sessionId);
        return;
      }

      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);

      const role = provenanceOf(fresh)?.role ?? "worker";
      const pid = fresh.pid;

      deps.markManualClose?.(sessionId);
      const hinted = deps.sendShutdownHint(sessionId);
      if (hinted) {
        await waitForGracefulExit(sessionId, pid);
      }
      if (disposed) return;

      const result = await deps.terminate(sessionId, {
        graceMs: 0,
        verifyIdentity: true,
        stampManualClose: true,
      });

      if (result.terminated) {
        eligibleSince.delete(sessionId);
        attempts.delete(key);
        const after = deps.getSession(sessionId);
        if (after && after.status !== "ended") {
          deps.unregisterIfAlive?.(sessionId);
        }
        log(
          `[research-auto-retire] retired completed Multi-Agent ${sessionId} (role=${role}, pid=${result.pid ?? pid ?? "n/a"}, outcome=${result.outcome})`,
        );
      } else {
        warn(
          `[research-auto-retire] attempt ${attempt}/${maxAttempts} for ${sessionId} (role=${role}): outcome=${result.outcome}` +
            (result.pid !== undefined ? `, pid=${result.pid}` : ""),
        );
      }
    } catch (err) {
      warn(
        `[research-auto-retire] error retiring ${sessionId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      inFlight.delete(sessionId);
    }
  }

  async function sweep(): Promise<void> {
    if (disposed) return;
    const allSessions = deps.listSessions();
    const liveIds = new Set<string>();
    const activeKeys = new Set<string>();
    const launches: Array<Promise<void>> = [];
    const currentNow = now();

    for (const session of allSessions) {
      if (session.status === "ended") continue;
      liveIds.add(session.id);
      const key = instanceKey(session);
      activeKeys.add(key);

      if (inFlight.has(session.id)) continue;

      if (!isEligible(session, allSessions)) {
        eligibleSince.delete(session.id);
        continue;
      }

      if ((attempts.get(key) ?? 0) >= maxAttempts) continue;

      const tracked = eligibleSince.get(session.id);
      if (!tracked || tracked.key !== key) {
        eligibleSince.set(session.id, { since: currentNow, key });
        if (settleGraceMs > 0) continue;
      } else if (currentNow - tracked.since < settleGraceMs) {
        continue;
      }

      launches.push(retireSession(session.id, key));
    }

    for (const id of eligibleSince.keys()) {
      if (!liveIds.has(id)) eligibleSince.delete(id);
    }
    for (const key of attempts.keys()) {
      if (!activeKeys.has(key)) attempts.delete(key);
    }

    if (launches.length > 0) {
      await Promise.allSettled(launches);
    }
  }

  function dispose(): void {
    disposed = true;
    eligibleSince.clear();
    attempts.clear();
    inFlight.clear();
  }

  return { sweep, dispose };
}
