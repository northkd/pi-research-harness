import type { BillingSummary } from "./types.js";
import { useSessionStats, useSessionStatsSnapshots } from "./useSpeedStats.js";

/** The same CNY subtotal and completeness state in desktop and mobile headers. */
export function SessionCost({
  billing,
  loading = false,
}: {
  billing?: BillingSummary;
  loading?: boolean;
}) {
  if (!billing)
    return <span title={loading ? "费用加载中" : "暂无计费用量"}>—</span>;
  const partial = !billing.complete;
  if (partial && billing.sessionTotalCost === 0)
    return <span title="部分用量尚未定价或未能读取">待定价</span>;
  return (
    <span
      title={
        partial
          ? `已定价小计；${billing.unpricedTurns} 轮待定价，${billing.invalidRecords} 条用量未能读取`
          : "本月会话及所有子任务等价消耗（北京时间，每月1日归零）"
      }
    >
      {partial ? "≥" : ""}¥{billing.sessionTotalCost.toFixed(2)}
    </span>
  );
}

/** Compact prices use the same CNY snapshot as the session's top bar. */
export function SessionBillingCost({
  sessionId,
  status,
}: {
  sessionId: string;
  status?: string;
}) {
  const { stats, loading } = useSessionStats(sessionId, status);
  return <SessionCost billing={stats?.billing} loading={loading} />;
}

interface BillableSession {
  id: string;
  status?: string;
  sessionFile?: string;
  originDeviceId?: string;
}

export function folderBillingSessions(
  sessions: readonly BillableSession[],
): BillableSession[] {
  const unique = [
    ...new Map(sessions.map((session) => [session.id, session])).values(),
  ];
  const file = (session: BillableSession) =>
    session.sessionFile?.replace(/\\/g, "/");
  return unique.filter(
    (session) =>
      !unique.some((parent) => {
        const parentFile = file(parent);
        return (
          parent.id !== session.id &&
          parent.originDeviceId === session.originDeviceId &&
          parentFile?.endsWith(".jsonl") &&
          file(session)?.startsWith(`${parentFile.slice(0, -6)}/`)
        );
      }),
  );
}

/** Membership is supplied before search, hidden and ended filters. */
export function FolderBillingCost({
  sessions,
}: {
  sessions: readonly BillableSession[];
}) {
  const members = folderBillingSessions(sessions);
  const snapshots = useSessionStatsSnapshots(members);
  const total = snapshots.reduce(
    (sum, snapshot) => sum + (snapshot.stats?.billing?.sessionTotalCost ?? 0),
    0,
  );
  const pending = snapshots.filter(
    (snapshot) => !snapshot.stats?.billing,
  ).length;
  const incomplete = snapshots.filter(
    (snapshot) => snapshot.stats?.billing && !snapshot.stats.billing.complete,
  ).length;
  const partial = pending + incomplete > 0;
  return (
    <span
      title={`目录本月全部会话等价消耗（北京时间，每月1日归零；含已结束、隐藏会话及子任务）；${members.length} 个会话${partial ? `，${pending + incomplete} 个会话费用未完整计入` : ""}`}
    >
      {partial && total === 0
        ? snapshots.some((snapshot) => snapshot.loading)
          ? "加载中"
          : "待定价"
        : `${partial ? "≥" : ""}¥${total.toFixed(2)}`}
    </span>
  );
}
