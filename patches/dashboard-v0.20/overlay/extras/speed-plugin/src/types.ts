export interface TurnCostBreakdown {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  request?: number;
  total: number;
}

export interface BillingPeriod {
  month: string;
  timeZone: "Asia/Shanghai";
  startTime: number;
  endTime: number;
}

export interface ModelRateInfo {
  currency?: "CNY";
  unit?: "tokens" | "request";
  request?: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ModelUsageSummary {
  provider?: string;
  model: string;
  agentType: "main" | "subagent" | "mixed";
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  unpricedCalls: number;
  totalTokens: number;
  cost: number;
  rates?: ModelRateInfo;
}

export interface BillingSummary {
  currency: "CNY";
  complete: boolean;
  unpricedTurns: number;
  invalidRecords: number;
  sessionTotalCost: number;
  mainTotalCost: number;
  subagentTotalCost: number;
  totalInputCost: number;
  totalOutputCost: number;
  totalCacheCost: number;
  totalCacheWriteCost: number;
  totalRequestCost: number;
  totalCacheSavings: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalTokens: number;
  modelBreakdown: ModelUsageSummary[];
}

export interface BillingReportSession {
  key: string;
  id: string;
  name: string;
  cwd: string;
  turnCount: number;
  lastActivity: number | null;
  billing: BillingSummary;
}

export interface BillingReportDirectory {
  cwd: string;
  sessionCount: number;
  billing: BillingSummary;
}

export interface BillingReport {
  billingPeriod: BillingPeriod;
  availableMonths: string[];
  generatedAt: number;
  unavailableSessions: number;
  billing: BillingSummary;
  directories: BillingReportDirectory[];
  sessions: BillingReportSession[];
}

export interface SpeedRecord {
  provider?: string;
  costSource?: "configured" | "recorded" | "unpriced";
  rates?: ModelRateInfo;
  id?: string;
  timestamp: number;
  startTime?: number;
  /** Full request duration, separate from the first-output generation window. */
  durationSeconds: number | null;
  model: string;
  agentType?: "main" | "subagent";
  subagentRole?: string;
  /** Observed first-output-to-end throughput; never a legacy wall-clock estimate. */
  tps: number | null;
  /** Whole-request fallback, including time before the first output. */
  estimatedTps?: number | null;
  firstTokenSeconds?: number | null;
  generationSeconds?: number | null;
  timingSource?: "pi-stream" | "sdk-duration" | "legacy-timestamps" | "unavailable";
  firstOutputKind?: "text" | "thinking" | "toolcall" | null;
  speedStatus?: "measured" | "estimated" | "insufficient-output" | "too-short" | "missing-timing" | "invalid-timing" | "failed";
  speedCaveat?: "reasoning-not-observed";
  contentTokens: number;
  reasoningTokens: number;
  totalOutputTokens: number;
  inputTokens: number;
  cacheRead: number;
  cacheWrite?: number;
  totalTokens: number;
  cost?: TurnCostBreakdown;
}

export interface ActiveGeneration {
  sessionId: string;
  startTime: number;
  elapsedSeconds: number;
  model?: string;
}

export interface SpeedStatsResponse {
  sessionId?: string;
  status: "idle" | "streaming";
  active?: ActiveGeneration | null;
  latest: SpeedRecord | null;
  latestMain?: SpeedRecord | null;
  latestSubagent?: SpeedRecord | null;
  averageTps: number | null;
  averageEstimatedTps?: number | null;
  recentCount: number;
  estimatedCount?: number;
  averageScope?: { provider: string; model: string; agentType: "main" | "subagent" };
  history: SpeedRecord[];
  mainHistory?: SpeedRecord[];
  subagentHistory?: SpeedRecord[];
  subagentModels?: string[];
  billing?: BillingSummary;
  billingPeriod?: BillingPeriod;
  billingHistory?: SpeedRecord[];
  billingMainHistory?: SpeedRecord[];
  billingSubagentHistory?: SpeedRecord[];
}
