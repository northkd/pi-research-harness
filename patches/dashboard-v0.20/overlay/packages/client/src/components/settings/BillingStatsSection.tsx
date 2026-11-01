import {
  type BillingReport,
  type BillingSummary,
  billingPeriod,
} from "@blackbelt-technology/pi-dashboard-speed-plugin";
import { useEffect, useId, useState } from "react";
import { useApiBase } from "../../lib/api/api-context.js";
import { useI18n } from "../../lib/i18n/i18n.js";

type View = "directories" | "sessions" | "models";
const controlSurfaceClass =
  "min-h-9 rounded-md border border-[var(--border-secondary)] bg-[var(--bg-secondary)] text-[var(--text-primary)]";
const controlClass = `${controlSurfaceClass} px-2 text-sm`;
const detailControlClass = `${controlSurfaceClass} min-w-0 px-1.5 text-xs sm:px-2 sm:text-sm`;

/** Historical reports have their own requests; selecting a month never changes live prices. */
export function BillingStatsSection() {
  const { t } = useI18n();
  const apiBase = useApiBase();
  const id = useId();
  const [currentMonth, setCurrentMonth] = useState(() => billingPeriod().month);
  const [selectedMonth, setSelectedMonth] = useState<string | null>(null);
  const month = selectedMonth ?? currentMonth;
  const [months, setMonths] = useState<string[]>([currentMonth]);
  const [folder, setFolder] = useState("*");
  const [view, setView] = useState<View>("directories");
  const [modelOrder, setModelOrder] = useState<"desc" | "asc">("desc");
  const [report, setReport] = useState<BillingReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const syncMonth = () => {
      clearTimeout(timer);
      const period = billingPeriod();
      setCurrentMonth(period.month);
      timer = setTimeout(
        syncMonth,
        Math.max(1, Math.min(86400000, period.endTime - Date.now())),
      );
    };
    syncMonth();
    window.addEventListener("focus", syncMonth);
    document.addEventListener("visibilitychange", syncMonth);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", syncMonth);
      document.removeEventListener("visibilitychange", syncMonth);
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setReport(null);
    void (async () => {
      try {
        const response = await fetch(
          `${apiBase}/api/speed-monitor/billing?month=${encodeURIComponent(month)}`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: BillingReport = await response.json();
        if (controller.signal.aborted) return;
        if (
          data.billingPeriod?.month !== month ||
          data.billing?.currency !== "CNY" ||
          !Array.isArray(data.availableMonths) ||
          !Array.isArray(data.sessions) ||
          !Array.isArray(data.directories)
        )
          throw new Error("Invalid billing report");
        setReport(data);
        setMonths(data.availableMonths);
        setFolder((previous) =>
          previous === "*" ||
          data.directories.some((directory) => directory.cwd === previous)
            ? previous
            : "*",
        );
      } catch (failure) {
        if (!controller.signal.aborted)
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [apiBase, month, revision]);

  // Do not render last month's values during the commit before its effect cleans up.
  const data = report?.billingPeriod.month === month ? report : null;
  const directory =
    folder === "*"
      ? null
      : data?.directories.find((entry) => entry.cwd === folder);
  const billing = directory?.billing ?? data?.billing;
  const models = [...(billing?.modelBreakdown ?? [])].sort(
    (a, b) =>
      (modelOrder === "desc" ? b.cost - a.cost : a.cost - b.cost) ||
      `${a.provider}/${a.model}`.localeCompare(`${b.provider}/${b.model}`),
  );
  const complete = !!billing?.complete && !data?.unavailableSessions;
  const sessions =
    data?.sessions.filter(
      (session) => folder === "*" || session.cwd === folder,
    ) ?? [];
  const monthOptions = [...new Set([...months, currentMonth, month])]
    .sort()
    .reverse();
  const directoryName = (cwd: string) =>
    cwd || t("billing.unknownDirectory", undefined, "Directory not recorded");
  const money = (value: number, known: boolean, digits = 2) =>
    !known && value === 0
      ? t("billing.unpriced", undefined, "Pending pricing")
      : `${known ? "" : "≥"}¥${value.toFixed(digits)}`;
  const amount = (
    key: "sessionTotalCost" | "mainTotalCost" | "subagentTotalCost",
  ) => (billing ? money(billing[key], complete) : "—");
  const count = (value: number) => value.toLocaleString();
  const totalTurns = sessions.reduce(
    (sum, session) => sum + session.turnCount,
    0,
  );
  const rowCost = (summary: BillingSummary) =>
    money(summary.sessionTotalCost, summary.complete, 4);

  return (
    <section
      data-testid="billing-statistics"
      aria-busy={loading}
      className="min-w-0 space-y-4"
    >
      <div>
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">
          {t("settings.billing", undefined, "Billing statistics")}
        </h2>
        <p className="mt-1 text-xs leading-relaxed text-[var(--text-tertiary)]">
          {t(
            "billing.description",
            undefined,
            "View monthly equivalent usage across saved sessions and their subagents. Months follow Beijing time; past records are preserved.",
          )}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label
          htmlFor={`${id}-month`}
          className="flex flex-col gap-1 text-xs text-[var(--text-secondary)]"
        >
          {t("billing.month", undefined, "Month")}
          <input
            type="month"
            id={`${id}-month`}
            data-testid="billing-month"
            className={controlClass}
            value={month}
            list={`${id}-months`}
            onChange={(event) => {
              const value = event.target.value;
              if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value))
                setSelectedMonth(value === currentMonth ? null : value);
            }}
          />
        </label>
        <datalist id={`${id}-months`}>
          {monthOptions.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </datalist>
        <button
          type="button"
          className={controlClass}
          onClick={() => setSelectedMonth(null)}
        >
          {t("billing.thisMonth", undefined, "This month")}
        </button>
        <button
          type="button"
          className={controlClass}
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          {t("common.refresh", undefined, "Refresh")}
        </button>
        <label
          htmlFor={`${id}-folder`}
          className="flex min-w-0 flex-1 basis-48 flex-col gap-1 text-xs text-[var(--text-secondary)]"
        >
          {t("billing.directory", undefined, "Directory")}
          <select
            id={`${id}-folder`}
            data-testid="billing-directory"
            className={`${controlClass} w-full min-w-0`}
            value={folder}
            onChange={(event) => setFolder(event.target.value)}
          >
            <option value="*">
              {t("billing.allDirectories", undefined, "All directories")}
            </option>
            {!data && folder !== "*" && (
              <option value={folder}>{directoryName(folder)}</option>
            )}
            {data?.directories.map((entry) => (
              <option key={entry.cwd} value={entry.cwd}>
                {directoryName(entry.cwd)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p className="text-xs text-[var(--text-muted)]">
        {month} · {t("billing.timeZone", undefined, "Beijing time (UTC+8)")}
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {(
          [
            [
              "sessionTotalCost",
              t("billing.total", undefined, "Equivalent usage"),
            ],
            ["mainTotalCost", t("billing.main", undefined, "Main agents")],
            [
              "subagentTotalCost",
              t("billing.subagents", undefined, "Subagents"),
            ],
          ] as const
        ).map(([key, label]) => (
          <div
            key={key}
            className="min-w-0 rounded-lg border border-[var(--border-primary)] bg-[var(--bg-secondary)] p-3"
          >
            <div className="text-xs text-[var(--text-tertiary)]">{label}</div>
            <div
              data-testid={`billing-${key}`}
              className="mt-1 break-all font-mono text-xl font-semibold text-[var(--accent-green-text)]"
            >
              {amount(key)}
            </div>
          </div>
        ))}
      </div>

      {loading && (
        <p role="status" className="text-sm text-[var(--text-tertiary)]">
          {t("billing.loading", undefined, "Loading billing records…")}
        </p>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-md border border-[var(--severity-error-border)] bg-[var(--severity-error-bg)] p-3 text-sm text-[var(--severity-error-fg)]"
        >
          {t(
            "billing.loadFailed",
            undefined,
            "Could not load billing statistics.",
          )}{" "}
          <span className="text-xs">{error}</span>
          <button
            type="button"
            className="ml-2 underline"
            onClick={() => setRevision((value) => value + 1)}
          >
            {t("common.retry", undefined, "Retry")}
          </button>
        </div>
      )}
      {data && billing && (
        <>
          {!complete && (
            <p
              role="status"
              className="rounded-md border border-[var(--severity-warning-border)] bg-[var(--severity-warning-bg)] p-3 text-xs text-[var(--severity-warning-fg)]"
            >
              {t(
                "billing.incomplete",
                {
                  unpriced: billing.unpricedTurns,
                  invalid: billing.invalidRecords,
                  unavailable: data.unavailableSessions,
                },
                "Partial total: {unpriced} unpriced turns, {invalid} unreadable records, {unavailable} unavailable sessions.",
              )}
            </p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--text-tertiary)]">
            <span>
              {t(
                "billing.counts",
                { sessions: sessions.length, turns: totalTurns },
                "{sessions} sessions · {turns} turns",
              )}
            </span>
            <span>
              {t("billing.tokens", undefined, "Tokens")}:{" "}
              {count(billing.totalTokens)}
            </span>
            <span>
              {t("billing.cacheSavings", undefined, "Cache savings")}: ¥
              {billing.totalCacheSavings.toFixed(2)}
            </span>
          </div>
          <div className="flex min-w-0 items-center justify-between gap-2 border-b border-[var(--border-primary)] pb-2">
            <div
              role="tablist"
              aria-label={t("billing.details", undefined, "Billing details")}
              className="flex min-w-0 gap-1"
            >
              {(
                [
                  [
                    "directories",
                    t("billing.directories", undefined, "Directories"),
                  ],
                  ["sessions", t("billing.sessions", undefined, "Sessions")],
                  ["models", t("billing.models", undefined, "Models")],
                ] as const
              ).map(([value, label]) => (
                <button
                  type="button"
                  key={value}
                  role="tab"
                  id={`${id}-${value}`}
                  aria-controls={`${id}-details`}
                  aria-selected={view === value}
                  className={`${detailControlClass} truncate ${view === value ? "font-semibold ring-1 ring-[var(--accent-blue)]" : ""}`}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {view === "models" && (
              <button
                type="button"
                data-testid="billing-model-sort"
                className={`${detailControlClass} shrink-0`}
                onClick={() =>
                  setModelOrder((previous) =>
                    previous === "desc" ? "asc" : "desc",
                  )
                }
              >
                {modelOrder === "desc"
                  ? t(
                      "billing.costDescending",
                      undefined,
                      "Usage: high to low ↓",
                    )
                  : t(
                      "billing.costAscending",
                      undefined,
                      "Usage: low to high ↑",
                    )}
              </button>
            )}
          </div>
          <div
            role="tabpanel"
            id={`${id}-details`}
            aria-labelledby={`${id}-${view}`}
            className="min-w-0"
          >
            {view === "directories" && (
              <div className="space-y-2">
                {(folder === "*"
                  ? data.directories
                  : data.directories.filter((entry) => entry.cwd === folder)
                ).map((entry) => (
                  <div
                    key={entry.cwd}
                    data-testid="billing-directory-row"
                    className="flex min-w-0 items-center gap-3 rounded-md border border-[var(--border-primary)] p-3"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="break-all text-sm text-[var(--text-primary)]">
                        {directoryName(entry.cwd)}
                      </div>
                      <div className="mt-1 text-xs text-[var(--text-muted)]">
                        {t(
                          "billing.sessionCount",
                          { count: entry.sessionCount },
                          "{count} sessions",
                        )}
                      </div>
                    </div>
                    <div className="shrink-0 text-right">
                      <div className="font-mono text-sm">
                        {rowCost(entry.billing)}
                      </div>
                      <button
                        type="button"
                        className="mt-1 text-xs text-[var(--accent-blue)]"
                        onClick={() => {
                          setFolder(entry.cwd);
                          setView("sessions");
                        }}
                      >
                        {t("billing.viewSessions", undefined, "View sessions")}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {view === "sessions" && (
              <div className="space-y-2">
                {sessions.map((session) => (
                  <div
                    key={session.key}
                    data-testid="billing-session-row"
                    className="min-w-0 rounded-md border border-[var(--border-primary)] p-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div
                          className="break-words text-sm font-medium"
                          title={session.id}
                        >
                          {session.name}
                        </div>
                        <div className="mt-1 break-all text-[11px] text-[var(--text-muted)]">
                          {directoryName(session.cwd)}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-sm">
                        {rowCost(session.billing)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-tertiary)]">
                      <span>
                        {t(
                          "billing.turnCount",
                          { count: session.turnCount },
                          "{count} turns",
                        )}
                      </span>
                      <span>
                        {t("billing.main", undefined, "Main agents")}:{" "}
                        {money(
                          session.billing.mainTotalCost,
                          session.billing.complete,
                          4,
                        )}
                      </span>
                      <span>
                        {t("billing.subagents", undefined, "Subagents")}:{" "}
                        {money(
                          session.billing.subagentTotalCost,
                          session.billing.complete,
                          4,
                        )}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {view === "models" && (
              <div className="space-y-2">
                {models.map((model) => (
                  <div
                    key={`${model.provider}/${model.model}`}
                    data-testid="billing-model-row"
                    className="min-w-0 rounded-md border border-[var(--border-primary)] p-3"
                  >
                    <div className="flex min-w-0 items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="break-all text-sm font-medium">
                          {model.model}
                        </div>
                        <div className="text-xs text-[var(--text-muted)]">
                          {model.provider} ·{" "}
                          {t(
                            "billing.turnCount",
                            { count: model.callCount },
                            "{count} turns",
                          )}
                        </div>
                      </div>
                      <span className="shrink-0 font-mono text-sm">
                        {money(model.cost, model.unpricedCalls === 0, 4)}
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-[var(--text-tertiary)]">
                      <span>
                        {t("billing.input", undefined, "Input")}:{" "}
                        {count(model.inputTokens)}
                      </span>
                      <span>
                        {t("billing.output", undefined, "Output / reasoning")}:{" "}
                        {count(model.outputTokens)}
                      </span>
                      <span>
                        {t("billing.cache", undefined, "Cache read / write")}:{" "}
                        {count(model.cacheRead)} / {count(model.cacheWrite)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {!totalTurns && complete && (
              <p className="py-6 text-center text-sm text-[var(--text-muted)]">
                {t(
                  "billing.empty",
                  undefined,
                  "No usage recorded for this month and directory.",
                )}
              </p>
            )}
          </div>
          <p className="text-[11px] text-[var(--text-muted)]">
            {t("billing.updatedAt", undefined, "Updated")}:{" "}
            {new Date(data.generatedAt).toLocaleString(undefined, {
              timeZone: "Asia/Shanghai",
            })}
          </p>
        </>
      )}
    </section>
  );
}
