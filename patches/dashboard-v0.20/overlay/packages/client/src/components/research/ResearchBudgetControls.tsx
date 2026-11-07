import type { ResearchWorkbenchObservation } from "@blackbelt-technology/pi-dashboard-shared/research-workbench.js";

const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Compatibility export for older hosts: observed usage only, without budget reads or writes. */
export function ResearchBudgetControls({ cwd, observation, observationStale = false }: {
  cwd: string;
  connectionGeneration?: number;
  onRefresh?: () => void;
  observation?: ResearchWorkbenchObservation | null;
  observationStale?: boolean;
}) {
  const observed = observation?.schema === "res-workflow.workbench-observation.v1" && observation.cwd === cwd
    && observation.observedUsage?.metric === "observed-assistant-responses"
    && [observation.observedUsage.responses, observation.observedUsage.inputTokens, observation.observedUsage.outputTokens, observation.observedUsage.inheritedExcluded].every(integer)
    ? observation : null;

  return <section data-testid="research-usage" className="win11-card-subtle space-y-3 p-4 text-xs">
    <h2 className="text-sm font-semibold text-[var(--text-primary)]">研究用量</h2>
    <div data-testid="research-budget-observed-usage" className="space-y-1.5">
      <p className="font-semibold text-[var(--text-primary)]">加入工作台后的会话与子代理观测用量</p>
      {observed ? <>
        <p data-testid="research-budget-observed-responses">已观测模型响应至少 {observed.observedUsage.responses} 次 · 输入 {observed.observedUsage.inputTokens} tokens · 输出 {observed.observedUsage.outputTokens} tokens</p>
        {observed.observedUsage.inheritedExcluded > 0 && <p>已排除 {observed.observedUsage.inheritedExcluded} 条继承的历史响应，避免重复计数。</p>}
        {observationStale && <p role="status">观测记录已过期，当前显示上次取得的用量。</p>}
        {observed.coverage.partial && <p role="status">正在补齐已接入会话记录，当前观测尚不完整。</p>}
      </> : <p>尚无可核验的会话用量观测，实际调用次数仍未知。</p>}
      <p className="text-[var(--text-secondary)]">用量来自已保存的模型响应，未保存的失败和重试可能未计入，不包含接入助手或外部 agy。费用请在计费明细中核对。</p>
    </div>
  </section>;
}
