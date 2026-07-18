import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import {
  estimateCostUsdFromModelUsage,
  isDeterministicGuardrailRow,
  mergeCostSources,
  resolveArtifactCostContribution,
  resolveModelPricingMetadata,
  type DashboardArtifactCostRow,
} from "./oneshotCosting.js";
import {
  EXECUTING_STATES,
  normalizeDashboardStage,
  QUEUED_STATES,
  TERMINAL_STATES,
  WAITING_STATES,
} from "../shared/oneshotStateModel.js";
import type {
  OneShotAgentAnalyticsEntry,
  OneShotAgentSample,
  OneShotAnalyticsRange,
  OneShotAnalyticsWindow,
  OneShotCostSource,
  OneShotCostsAnalytics,
  OneShotDashboardAnalytics,
  OneShotDashboardRow,
  OneShotFailureCluster,
  OneShotFailuresAnalytics,
  OneShotModelCost,
  OneShotOverviewAnalytics,
  OneShotProgressStage,
  OneShotQueueAnalytics,
  OneShotStageCost,
  OneShotThroughputAnalytics,
  OneShotTopCostRun,
  OneShotTrendDelta,
} from "../types/oneshot.js";
import { clusterSignature, parseErrorSummary } from "../shared/errorParsing.js";
import { buildFailureClassificationMessage } from "./failureAttribution.js";

const QUALIFICATION_STAGE = "qualification";
const AGENT_STAGES: Array<Exclude<OneShotProgressStage, "pr_complete">> = [
  "qualification",
  "planning",
  "review",
  "implementation",
  "code_review",
  "testing",
];
const WORKER_CAPACITY_ENV_VARS = [
  "QUALIFIER_DESIRED_COUNT",
  "ONESHOT_PLANNER_DESIRED_COUNT",
  "ONESHOT_REVIEWER_DESIRED_COUNT",
  "ONESHOT_IMPLEMENTER_DESIRED_COUNT",
  "ONESHOT_CODE_REVIEWER_DESIRED_COUNT",
  "ONESHOT_TESTER_DESIRED_COUNT",
] as const;
const WORKER_CAPACITY_AGENT_NAMES = [
  "QUALIFIER",
  "PLANNER",
  "REVIEWER",
  "IMPLEMENTER",
  "CODE_REVIEWER",
  "TESTER",
] as const;
let workerCapacitySourceLogged = false;

export const DEFAULT_ONESHOT_ANALYTICS_RANGE: OneShotAnalyticsRange = "24h";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const ANALYTICS_RANGE_CONFIG: Record<
  Exclude<OneShotAnalyticsRange, "all">,
  {
    label: string;
    shortLabel: string;
    durationMs: number;
    bucketCount: number;
    bucketLabel: string;
  }
> = {
  "24h": {
    label: "Last 24h",
    shortLabel: "24h",
    durationMs: DAY_MS,
    bucketCount: 48,
    bucketLabel: "48 x 30-min buckets",
  },
  "7d": {
    label: "Last 7d",
    shortLabel: "7d",
    durationMs: 7 * DAY_MS,
    bucketCount: 28,
    bucketLabel: "28 x 6-hour buckets",
  },
  "30d": {
    label: "Last 30d",
    shortLabel: "30d",
    durationMs: 30 * DAY_MS,
    bucketCount: 30,
    bucketLabel: "30 x daily buckets",
  },
};

const VALID_ANALYTICS_RANGES = new Set<OneShotAnalyticsRange>([
  "24h",
  "7d",
  "30d",
  "all",
]);

export function normalizeOneShotAnalyticsRange(
  value: unknown,
): OneShotAnalyticsRange {
  return typeof value === "string" &&
    VALID_ANALYTICS_RANGES.has(value as OneShotAnalyticsRange)
    ? (value as OneShotAnalyticsRange)
    : DEFAULT_ONESHOT_ANALYTICS_RANGE;
}

type ArtifactMetricRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  artifact_stage: string;
  recorded_at: Date | string | null;
  stage_duration_ms: number | string | null;
  stage_cost_usd: number | string | null;
  stage_tokens_used: number | string | null;
  tokens_used?: unknown;
  /** LLM model id as stored on the artifact (e.g. `us.anthropic.claude-sonnet-4-6`). */
  model: string | null;
  /** Vendor label (e.g. `anthropic`, `openai`). Nullable — column added later. */
  provider: string | null;
  model_usage?: unknown;
};

type OutcomeTransitionRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  to_state: "pr_open" | "failed" | "qualification_failed" | null;
  occurred_at: Date | string | null;
};

interface OutcomeTransitionTimes {
  prOpenedAtMs?: number;
  failedAtMs?: number;
  qualificationFailedAtMs?: number;
}

type ArtifactModelUsage = Record<string, { input: number; output: number }>;
type ArtifactTokenUsage = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
  cachedInput?: number;
};

type RawModelBucket = {
  model: string;
  provider: string | null;
  tokens: number;
  usd: number;
  rawModelIds?: string[];
};

type CanonicalModelBucket = RawModelBucket & {
  key: string;
  rawModelIds: string[];
};

function coerceFiniteNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function metricTokens(metric: ArtifactMetricRow): number {
  const usage = parseTokenUsage(metric.tokens_used);
  if (usage) {
    return usage.input + usage.output;
  }
  return coerceFiniteNumber(metric.stage_tokens_used) ?? 0;
}

function metricDurationMs(metric: ArtifactMetricRow): number {
  return coerceFiniteNumber(metric.stage_duration_ms) ?? 0;
}

function rowTokens(row: Pick<OneShotDashboardRow, "totalTokensUsed">): number {
  return coerceFiniteNumber(row.totalTokensUsed) ?? 0;
}

function rowCostUsd(row: Pick<OneShotDashboardRow, "estimatedCostUsd">): number {
  return coerceFiniteNumber(row.estimatedCostUsd) ?? 0;
}

function dashboardCostRow(metric: ArtifactMetricRow): DashboardArtifactCostRow {
  return {
    ...metric,
    stage_cost_usd: coerceFiniteNumber(metric.stage_cost_usd),
    stage_tokens_used: metricTokens(metric),
  } as DashboardArtifactCostRow;
}

function parseModelUsage(value: unknown): ArtifactModelUsage | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return null;
    }
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }

  const parsed: ArtifactModelUsage = {};
  for (const [model, usage] of Object.entries(raw)) {
    if (!usage || typeof usage !== "object" || Array.isArray(usage)) {
      continue;
    }
    const input = coerceFiniteNumber(
      (usage as { input?: unknown; input_tokens?: unknown }).input ??
        (usage as { input_tokens?: unknown }).input_tokens,
    );
    const output = coerceFiniteNumber(
      (usage as { output?: unknown; output_tokens?: unknown }).output ??
        (usage as { output_tokens?: unknown }).output_tokens,
    );
    if ((input ?? 0) + (output ?? 0) > 0) {
      parsed[model] = { input: input ?? 0, output: output ?? 0 };
    }
  }

  return Object.keys(parsed).length > 0 ? parsed : null;
}

function parseTokenUsage(value: unknown): ArtifactTokenUsage | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  let candidate = value;
  if (typeof candidate === "string") {
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }
  const usageCandidate = candidate as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cachedInput?: unknown;
  };
  const input = coerceFiniteNumber(usageCandidate.input);
  const output = coerceFiniteNumber(usageCandidate.output);
  if (input === null && output === null) {
    return null;
  }
  const usage: ArtifactTokenUsage = {
    input: Math.max(input ?? 0, 0),
    output: Math.max(output ?? 0, 0),
  };
  const cacheRead = coerceFiniteNumber(usageCandidate.cacheRead);
  const cacheWrite = coerceFiniteNumber(usageCandidate.cacheWrite);
  const cachedInput = coerceFiniteNumber(usageCandidate.cachedInput);
  if (cacheRead !== null) usage.cacheRead = Math.max(cacheRead, 0);
  if (cacheWrite !== null) usage.cacheWrite = Math.max(cacheWrite, 0);
  if (cachedInput !== null) usage.cachedInput = Math.max(cachedInput, 0);
  return usage;
}

function pricingModelForModelUsage(
  metric: ArtifactMetricRow,
  model: string,
): string {
  if (!model.startsWith("claude-")) {
    return model;
  }

  const primaryModel = metric.model?.trim().toLowerCase() ?? "";
  const bedrockPrefix = primaryModel.match(
    /^(us|eu|au|jp|global)\.anthropic\./,
  )?.[1];
  return bedrockPrefix ? `${bedrockPrefix}.anthropic.${model}` : model;
}

function canonicalizeModelBucket(bucket: RawModelBucket): CanonicalModelBucket | null {
  const rawProvider = bucket.provider?.trim().toLowerCase() ?? null;
  const rawModel = bucket.model?.trim() || "unknown";
  const normalizedModel = rawModel.toLowerCase();
  const rawModelIds =
    bucket.rawModelIds && bucket.rawModelIds.length > 0
      ? bucket.rawModelIds
      : normalizedModel === "unknown"
        ? []
        : [rawModel];

  if (rawProvider === "config" && normalizedModel === "disabled") {
    return null;
  }
  if (rawProvider === "soft_gate" && normalizedModel === "advisory") {
    return null;
  }
  // Deterministic plan-contract guardrail rows never belong in the by-model ladder.
  if (isDeterministicGuardrailRow(rawProvider, normalizedModel)) {
    return null;
  }
  if (
    (normalizedModel === "unknown" || normalizedModel === "") &&
    bucket.tokens <= 0 &&
    bucket.usd <= 0
  ) {
    return null;
  }

  const claudeMatch = normalizedModel.match(
    /claude-(haiku|sonnet|opus)-(\d+)(?:-(\d+))?/,
  );
  if (claudeMatch) {
    const minorVersion =
      claudeMatch[3] && claudeMatch[3].length <= 2
        ? `-${claudeMatch[3]}`
        : "";
    const model = `claude-${claudeMatch[1]}-${claudeMatch[2]}${minorVersion}`;
    return {
      ...bucket,
      key: `anthropic:${model}`,
      model,
      provider: "anthropic",
      rawModelIds,
    };
  }

  const gptMatch = normalizedModel.match(/(?:^|[/.-])gpt[-.]?(\d+(?:[.-]\d+)?)/);
  if (gptMatch) {
    const model = `gpt-${gptMatch[1].replace("-", ".")}`;
    return {
      ...bucket,
      key: `openai:${model}`,
      model,
      provider: "openai",
      rawModelIds,
    };
  }

  return {
    ...bucket,
    key: "unattributed:llm",
    model: "Unattributed LLM",
    provider: null,
    rawModelIds,
  };
}

function pricingForModelBucket(
  provider: string | null,
  model: string,
  rawModelTokenTotals: ReadonlyMap<string, number>,
): OneShotModelCost["pricing"] {
  const sortedRawModelIds = Array.from(rawModelTokenTotals.entries())
    .filter(([rawModelId]) => rawModelId.trim().length > 0)
    .sort(([left, leftTokens], [right, rightTokens]) => {
      const priority = (value: string) => {
        const normalized = value.toLowerCase();
        if (normalized.startsWith("global.anthropic.")) return 0;
        if (/^(us|eu|au|jp)\.anthropic\./.test(normalized)) return 1;
        if (normalized.startsWith("anthropic.")) return 1;
        return 2;
      };
      return (
        rightTokens - leftTokens ||
        priority(left) - priority(right) ||
        left.localeCompare(right)
      );
    })
    .map(([rawModelId]) => rawModelId);

  for (const rawModelId of sortedRawModelIds) {
    const pricing = resolveModelPricingMetadata(provider, rawModelId);
    if (pricing) return pricing;
  }
  return resolveModelPricingMetadata(provider, model);
}

function addRawModelTokenTotal(
  rawModelTokenTotals: Map<string, number>,
  rawModelId: string,
  tokens: number,
): void {
  rawModelTokenTotals.set(
    rawModelId,
    (rawModelTokenTotals.get(rawModelId) ?? 0) + Math.max(tokens, 0),
  );
}

function hasCapturedCostMetric(metric: ArtifactMetricRow): boolean {
  return (
    coerceFiniteNumber(metric.stage_cost_usd) !== null ||
    parseTokenUsage(metric.tokens_used) !== null ||
    coerceFiniteNumber(metric.stage_tokens_used) !== null
  );
}

type StageCountRow = mysql.RowDataPacket & {
  stage: string | null;
  stage_count: number;
};

type WorkerCapacityRow = mysql.RowDataPacket & {
  worker_count: number;
};

interface TimedAgentSample extends OneShotAgentSample {
  recordedAtMs: number;
}

function median(values: ReadonlyArray<number>): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }
  return sorted[middle] ?? 0;
}

function withinLast24h(
  timestamp: Date | string | null | undefined,
  nowMs: number,
): boolean {
  const value = timestampMs(timestamp);
  return value >= nowMs - DAY_MS && value <= nowMs;
}

function withinLast24hMs(timestampMsValue: number, nowMs: number): boolean {
  return timestampMsValue >= nowMs - DAY_MS && timestampMsValue <= nowMs;
}

function isPrPassRow(row: OneShotDashboardRow): boolean {
  return row.displayState === "completed" || row.displayState === "pr_open";
}

function isPrFailRow(row: OneShotDashboardRow): boolean {
  return (
    row.displayState === "failed" ||
    row.displayState === "qualification_failed"
  );
}

function hasState(
  states: readonly string[],
  state: OneShotDashboardRow["displayState"],
): boolean {
  return states.includes(state);
}

function setEarliest(existing: number | undefined, next: number): number {
  if (!Number.isFinite(next) || next <= 0) return existing ?? 0;
  return existing == null || existing <= 0 ? next : Math.min(existing, next);
}

function setLatest(existing: number | undefined, next: number): number {
  if (!Number.isFinite(next) || next <= 0) return existing ?? 0;
  return existing == null || existing <= 0 ? next : Math.max(existing, next);
}

function prOpenedAtMs(
  row: OneShotDashboardRow,
  outcomeTransitionTimes: ReadonlyMap<number, OutcomeTransitionTimes>,
): number {
  if (typeof row.oneshotRunId === "number") {
    const eventTime = outcomeTransitionTimes.get(row.oneshotRunId)?.prOpenedAtMs;
    if (eventTime != null && eventTime > 0) {
      return eventTime;
    }
  }
  return timestampMs(row.updatedAt);
}

function failedOutcomeAtMs(
  row: OneShotDashboardRow,
  outcomeTransitionTimes: ReadonlyMap<number, OutcomeTransitionTimes>,
): number {
  if (typeof row.oneshotRunId === "number") {
    const eventTimes = outcomeTransitionTimes.get(row.oneshotRunId);
    const eventTime =
      row.displayState === "qualification_failed"
        ? (eventTimes?.qualificationFailedAtMs ?? eventTimes?.failedAtMs)
        : (eventTimes?.failedAtMs ?? eventTimes?.qualificationFailedAtMs);
    if (eventTime != null && eventTime > 0) {
      return eventTime;
    }
  }
  return timestampMs(row.updatedAt);
}

/**
 * Aggregates 24h overview tokens from artifact stage metrics (mirroring
 * createCostsAnalytics' token attribution), while using the row-level
 * Costs top-line for USD so Overview and Costs agree.
 */
function aggregate24hSpend(
  recentRows: readonly OneShotDashboardRow[],
  artifactMetrics24h: readonly ArtifactMetricRow[],
): { totalTokens: number; estimatedCostUsd: number; costSource: OneShotCostSource } {
  const attributedTokensByRun = new Map<number, number>();
  let attributedTokens = 0;

  for (const metric of artifactMetrics24h) {
    const mapped = normalizeDashboardStage(metric.artifact_stage);
    if (!mapped) continue;
    if (
      parseTokenUsage(metric.tokens_used) !== null ||
      coerceFiniteNumber(metric.stage_tokens_used) !== null
    ) {
      const tokens = metricTokens(metric);
      attributedTokens += tokens;
      if (metric.oneshot_run_id > 0) {
        attributedTokensByRun.set(
          metric.oneshot_run_id,
          (attributedTokensByRun.get(metric.oneshot_run_id) ?? 0) + tokens,
        );
      }
    }
  }

  const unattributedRunTokens = recentRows.reduce((sum, row) => {
    if (row.oneshotRunId === null) {
      return sum;
    }
    return attributedTokensByRun.has(row.oneshotRunId)
      ? sum
      : sum + rowTokens(row);
  }, 0);
  const costSourceRows = recentRows.filter((row) => rowCostUsd(row) > 0);

  const totalTokens = attributedTokens + unattributedRunTokens;
  const estimatedCostUsd = Number(
    recentRows.reduce((sum, row) => sum + rowCostUsd(row), 0).toFixed(6),
  );
  const costSource = mergeCostSources(
    costSourceRows.map((row) => row.costSource),
  );

  return { totalTokens, estimatedCostUsd, costSource };
}

function createOverviewAnalytics(
  rows: readonly OneShotDashboardRow[],
  nowMs: number,
  failureCounts24h: ReadonlyMap<string, number>,
  artifactMetrics24h: readonly ArtifactMetricRow[],
  outcomeTransitionTimes: ReadonlyMap<number, OutcomeTransitionTimes>,
): OneShotOverviewAnalytics {
  // "Starts" window: rows created in the last 24h. Used ONLY for runs24h,
  // throughput buckets, and 24h spend/tokens attribution — NOT for live counts.
  const recentRows = rows.filter((row) => withinLast24h(row.createdAt, nowMs));

  // Open workload counts span ALL ages (mirror createQueueAnalytics) so the
  // Overview counts match the Queue view regardless of how old a run is.
  const running = rows.filter((row) =>
    hasState(EXECUTING_STATES, row.displayState),
  ).length;
  const queued = rows.filter((row) =>
    hasState(QUEUED_STATES, row.displayState),
  ).length;
  const waiting = rows.filter((row) =>
    hasState(WAITING_STATES, row.displayState),
  ).length;

  // PR pass rate / time-to-PR: 24h terminal-outcome rows by the outcome event
  // timestamp. pr_open + completed count as pass; failed +
  // qualification_failed count as fail; qualification_no_action is excluded
  // from the denominator entirely. Readiness is intentionally NOT consulted.
  const passRows = rows
    .filter(isPrPassRow)
    .filter((row) =>
      withinLast24hMs(prOpenedAtMs(row, outcomeTransitionTimes), nowMs),
    );
  const failRows = rows
    .filter(isPrFailRow)
    .filter((row) => row.failureAttribution?.excludedFromDenominator !== true)
    .filter((row) =>
      withinLast24hMs(failedOutcomeAtMs(row, outcomeTransitionTimes), nowMs),
    );
  const passAndFail = passRows.length + failRows.length;
  const passRate = passAndFail === 0 ? 0 : passRows.length / passAndFail;

  // Time-to-PR durations only come from pass outcome rows, so zero pass rows
  // yields an explicit 0/0 signal the frontend can render as an empty state.
  const timeToPrDurations = passRows.map((row) =>
    Math.max(
      0,
      prOpenedAtMs(row, outcomeTransitionTimes) -
        timestampMs(row.lastManualRestartAt ?? row.createdAt),
    ),
  );
  const avgTimeToPrMs =
    timeToPrDurations.length === 0
      ? 0
      : Math.round(
          timeToPrDurations.reduce((sum, value) => sum + value, 0) /
            timeToPrDurations.length,
        );

  const { totalTokens, estimatedCostUsd, costSource } = aggregate24hSpend(
    recentRows,
    artifactMetrics24h,
  );

  const throughputBuckets = Array.from({ length: 24 }, () => 0);
  for (const row of recentRows) {
    const ageHours = Math.floor(
      (nowMs - new Date(row.createdAt).getTime()) / (60 * 60 * 1000),
    );
    if (ageHours < 0 || ageHours >= 24) {
      continue;
    }
    throughputBuckets[23 - ageHours] += 1;
  }

  return {
    runs24h: recentRows.length,
    // completed = 24h PR-outcome pass count (pr_open|completed); NOT a
    // readiness-gated count. See OneShotOverviewAnalytics for field semantics.
    completed: passRows.length,
    // failed = 24h PR-outcome fail count (failed|qualification_failed);
    // qualification_no_action is excluded from both completed and failed.
    failed: failRows.length,
    running,
    queued,
    waiting,
    passRate,
    avgTimeToPrMs,
    medianTimeToPrMs: median(timeToPrDurations),
    totalTokens,
    estimatedCostUsd,
    costSource,
    throughputBuckets,
    attemptFailures24h: Array.from(failureCounts24h.values()).reduce(
      (sum, value) => sum + value,
      0,
    ),
  };
}

function finiteRangeStartDate(
  range: OneShotAnalyticsRange,
  nowMs: number,
): Date | null {
  if (range === "all") {
    return null;
  }
  return new Date(nowMs - ANALYTICS_RANGE_CONFIG[range].durationMs);
}

async function fetchArtifactMetricsForRange(
  range: OneShotAnalyticsRange,
  nowMs: number,
): Promise<ArtifactMetricRow[]> {
  const startDate = finiteRangeStartDate(range, nowMs);
  const timePredicate = startDate
    ? ` AND COALESCE(a.completed_at, a.created_at) >= ?`
    : "";
  const eventTimePredicate = startDate ? ` AND e.occurred_at >= ?` : "";
  const params = startDate ? [startDate, startDate, startDate] : [];
  const [rows] = await getPool().query<ArtifactMetricRow[]>(
    `SELECT
       a.oneshot_run_id,
       CAST(a.stage AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS artifact_stage,
       COALESCE(a.completed_at, a.created_at) AS recorded_at,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_duration_ms')) AS UNSIGNED) AS stage_duration_ms,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS stage_cost_usd,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS stage_tokens_used,
       JSON_EXTRACT(a.metadata_json, '$.tokens_used') AS tokens_used,
       CAST(a.model AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS model,
       CAST(a.provider AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS provider,
       JSON_EXTRACT(a.metadata_json, '$.model_usage') AS model_usage
     FROM oneshot_artifacts a
     WHERE a.stage IN ('qualification', 'plan', 'trace', 'verify', 'review', 'implementation', 'code_review', 'test_result')
       ${timePredicate}
     UNION ALL
     SELECT
       e.oneshot_run_id,
       CAST(e.stage AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS artifact_stage,
       e.occurred_at AS recorded_at,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_duration_ms')) AS UNSIGNED) AS stage_duration_ms,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS stage_cost_usd,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS stage_tokens_used,
       JSON_EXTRACT(e.metadata_json, '$.tokens_used') AS tokens_used,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.model')) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS model,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.provider')) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS provider,
       JSON_EXTRACT(e.metadata_json, '$.model_usage') AS model_usage
     FROM oneshot_run_events e
     WHERE e.event_type = 'stage_attempt_metrics'
       ${eventTimePredicate}
     UNION ALL
     SELECT
       0 AS oneshot_run_id,
       CAST('qualification' AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS artifact_stage,
       tm.updated_at AS recorded_at,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.durationMs')) AS UNSIGNED) AS stage_duration_ms,
       COALESCE(
         CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.costUsd')) AS DOUBLE),
         CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.cost')) AS DOUBLE)
       ) AS stage_cost_usd,
       (
         COALESCE(
           CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.totalTokens.input')) AS UNSIGNED),
           CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.tokensUsed.input')) AS UNSIGNED),
           0
         ) +
         COALESCE(
           CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.totalTokens.output')) AS UNSIGNED),
           CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.tokensUsed.output')) AS UNSIGNED),
           0
         )
       ) AS stage_tokens_used,
       COALESCE(
         JSON_EXTRACT(t.metrics_json, '$.tokens_used'),
         JSON_EXTRACT(t.metrics_json, '$.tokensUsed'),
         JSON_EXTRACT(t.metrics_json, '$.totalTokens')
       ) AS tokens_used,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.modelUsed')) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS model,
       CAST(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(t.metrics_json, '$.provider')), 'anthropic') AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS provider,
       COALESCE(
         JSON_EXTRACT(t.metrics_json, '$.model_usage'),
         JSON_EXTRACT(t.metrics_json, '$.modelUsage')
       ) AS model_usage
     FROM task_management tm
     JOIN agents ag
       ON ag.id = tm.agent_id
      AND ag.name = 'QUALIFIER'
     LEFT JOIN tasks t
       ON t.id = tm.task_id
     WHERE t.metrics_json IS NOT NULL
       ${startDate ? " AND tm.updated_at >= ?" : ""}
       AND NOT EXISTS (
         SELECT 1
         FROM oneshot_runs r
         JOIN oneshot_artifacts qa
           ON qa.oneshot_run_id = r.id
          AND qa.stage = 'qualification'
         WHERE r.source_task_management_id = tm.id
       )`,
    params,
  );

  return rows;
}

async function fetchRunClaimCountsForRange(
  range: OneShotAnalyticsRange,
  nowMs: number,
): Promise<Map<string, number>> {
  const startDate = finiteRangeStartDate(range, nowMs);
  const timePredicate = startDate ? "AND occurred_at >= ?" : "";
  const params = startDate ? [startDate] : [];
  const [rows] = await getPool().query<StageCountRow[]>(
    `SELECT stage, COUNT(*) AS stage_count
     FROM oneshot_run_events
     WHERE event_type = 'run_claimed'
       ${timePredicate}
       AND stage IS NOT NULL
     GROUP BY stage`,
    params,
  );

  return new Map(
    rows
      .map(
        (row) => [normalizeDashboardStage(row.stage), row.stage_count] as const,
      )
      .filter(
        (
          entry,
        ): entry is readonly [
          Exclude<OneShotProgressStage, "pr_complete">,
          number,
        ] => entry[0] !== null,
      ),
  );
}

async function fetchFailureCountsForRange(
  range: OneShotAnalyticsRange,
  nowMs: number,
): Promise<Map<string, number>> {
  const startDate = finiteRangeStartDate(range, nowMs);
  const timePredicate = startDate ? "AND occurred_at >= ?" : "";
  const params = startDate ? [startDate] : [];
  const [rows] = await getPool().query<StageCountRow[]>(
    `SELECT stage, COUNT(*) AS stage_count
     FROM oneshot_run_events
     WHERE event_type = 'state_transition'
       AND to_state = 'failed'
       ${timePredicate}
       AND stage IS NOT NULL
     GROUP BY stage`,
    params,
  );

  return new Map(
    rows
      .map(
        (row) => [normalizeDashboardStage(row.stage), row.stage_count] as const,
      )
      .filter(
        (
          entry,
        ): entry is readonly [
          Exclude<OneShotProgressStage, "pr_complete">,
          number,
        ] => entry[0] !== null,
      ),
  );
}

async function fetchOutcomeTransitionTimes(
  rows: readonly OneShotDashboardRow[],
): Promise<Map<number, OutcomeTransitionTimes>> {
  const runIds = Array.from(
    new Set(
      rows
        .map((row) => row.oneshotRunId)
        .filter((id): id is number => typeof id === "number" && id > 0),
    ),
  );
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = runIds.map(() => "?").join(", ");
  const [eventRows] = await getPool().query<OutcomeTransitionRow[]>(
    `SELECT oneshot_run_id, to_state, occurred_at
     FROM oneshot_run_events
     WHERE oneshot_run_id IN (${placeholders})
       AND event_type = 'state_transition'
       AND to_state IN ('pr_open', 'failed', 'qualification_failed')`,
    runIds,
  );

  const outcomeTimes = new Map<number, OutcomeTransitionTimes>();
  for (const event of eventRows) {
    if (!event.to_state) continue;
    const occurredAtMs = timestampMs(event.occurred_at);
    if (occurredAtMs <= 0) continue;

    const existing = outcomeTimes.get(event.oneshot_run_id) ?? {};
    if (event.to_state === "pr_open") {
      existing.prOpenedAtMs = setEarliest(
        existing.prOpenedAtMs,
        occurredAtMs,
      );
    } else if (event.to_state === "failed") {
      existing.failedAtMs = setLatest(existing.failedAtMs, occurredAtMs);
    } else {
      existing.qualificationFailedAtMs = setLatest(
        existing.qualificationFailedAtMs,
        occurredAtMs,
      );
    }
    outcomeTimes.set(event.oneshot_run_id, existing);
  }

  return outcomeTimes;
}

async function resolveWorkerCapacity(): Promise<number> {
  const envCounts = WORKER_CAPACITY_ENV_VARS.map((envName) =>
    Number.parseInt(process.env[envName] ?? "", 10),
  ).filter((value) => Number.isFinite(value) && value >= 0);

  if (envCounts.length > 0) {
    const total = envCounts.reduce((sum, value) => sum + value, 0);
    if (!workerCapacitySourceLogged) {
      workerCapacitySourceLogged = true;
      console.info(
        "[workerCapacity] source=env values=%j total=%d",
        envCounts,
        total,
      );
    }
    return total;
  }

  const placeholders = WORKER_CAPACITY_AGENT_NAMES.map(() => "?").join(", ");
  const [rows] = await getPool().query<WorkerCapacityRow[]>(
    `SELECT COUNT(*) AS worker_count
     FROM agents
     WHERE is_active = TRUE
       AND name IN (${placeholders})`,
    [...WORKER_CAPACITY_AGENT_NAMES],
  );

  const total = rows[0]?.worker_count ?? 0;
  if (!workerCapacitySourceLogged) {
    workerCapacitySourceLogged = true;
    console.info("[workerCapacity] source=db total=%d", total);
  }
  return total;
}

function buildQualificationAnalytics(
  rows: readonly OneShotDashboardRow[],
  nowMs: number,
  artifactMetrics: readonly ArtifactMetricRow[],
): OneShotAgentAnalyticsEntry {
  const stageArtifactRows = artifactMetrics
    .map((row) => ({
      dashboardStage: normalizeDashboardStage(row.artifact_stage),
      row,
    }))
    .filter(
      (
        entry,
      ): entry is {
        dashboardStage: typeof QUALIFICATION_STAGE;
        row: ArtifactMetricRow;
      } => entry.dashboardStage === QUALIFICATION_STAGE,
    );
  const artifactRunIds = new Set(
    stageArtifactRows
      .map((entry) => entry.row.oneshot_run_id)
      .filter((id) => id > 0),
  );
  const rowByRunId = new Map(
    rows
      .filter((row): row is OneShotDashboardRow & { oneshotRunId: number } =>
        typeof row.oneshotRunId === "number"
      )
      .map((row) => [row.oneshotRunId, row]),
  );
  const qualificationRows = rows.filter(
    (row) =>
      row.progressStage === QUALIFICATION_STAGE &&
      withinLast24h(row.createdAt, nowMs),
  );
  const fallbackRows = qualificationRows.filter(
    (row) =>
      row.displayState !== "qualification_no_action" &&
      row.failureAttribution?.excludedFromDenominator !== true &&
      (row.oneshotRunId === null || !artifactRunIds.has(row.oneshotRunId)),
  );
  const durations = [
    ...stageArtifactRows
      .map((entry) => metricDurationMs(entry.row))
      .filter((value) => value > 0),
    ...fallbackRows.map((row) =>
      Math.max(
        0,
        timestampMs(row.updatedAt) - timestampMs(row.createdAt),
      ),
    ),
  ];
  const tokens = [
    ...stageArtifactRows
      .map((entry) => metricTokens(entry.row))
      .filter((value) => value > 0),
    ...fallbackRows.map((row) => rowTokens(row)).filter((value) => value > 0),
  ];
  const sampledRows = [
    ...stageArtifactRows
      .map((entry) => rowByRunId.get(entry.row.oneshot_run_id))
      .filter(
        (row): row is OneShotDashboardRow & { oneshotRunId: number } =>
          row != null,
      ),
    ...fallbackRows,
  ];
  const failed = sampledRows.filter(
    (row) =>
      row.displayState === "qualification_failed" &&
      row.failureAttribution?.excludedFromDenominator !== true &&
      row.failureAttribution?.attribution !== "ticket",
  ).length;
  const noActionRows = sampledRows.filter(
    (row) => row.displayState === "qualification_no_action",
  ).length;
  const excludedRows = sampledRows.filter(
    (row) => row.failureAttribution?.excludedFromDenominator === true,
  ).length;
  const runs = stageArtifactRows.length + fallbackRows.length;
  const rateRows = Math.max(0, runs - noActionRows - excludedRows);
  const artifactSamples: TimedAgentSample[] = stageArtifactRows
    .slice()
    .sort(
      (a, b) =>
        timestampMs(b.row.recorded_at) - timestampMs(a.row.recorded_at),
    )
    .slice(0, 10)
    .map((entry, idx) => {
      const linkedRow = rowByRunId.get(entry.row.oneshot_run_id);
      return {
        dashboardId:
          entry.row.oneshot_run_id > 0
            ? `run-${entry.row.oneshot_run_id}`
            : `qualification-artifact-${idx}`,
        durationMs: metricDurationMs(entry.row),
        tone:
          linkedRow?.displayState === "qualification_failed"
            ? linkedRow.failureAttribution?.attribution === "ticket"
              ? "warning"
              : "failed"
            : linkedRow?.displayState === "qualification_no_action"
              ? "no_action"
              : "success",
        recordedAtMs: timestampMs(entry.row.recorded_at),
      };
    });
  const fallbackSamples: TimedAgentSample[] = fallbackRows
    .slice()
    .sort((a, b) => timestampMs(b.updatedAt) - timestampMs(a.updatedAt))
    .slice(0, 10)
    .map((row) => ({
      dashboardId: row.dashboardId,
      durationMs: Math.max(
        0,
        timestampMs(row.updatedAt) - timestampMs(row.createdAt),
      ),
      tone:
        row.displayState === "qualification_failed"
          ? row.failureAttribution?.attribution === "ticket"
            ? "warning"
            : "failed"
          : row.displayState === "qualification_no_action"
            ? "no_action"
            : row.displayState === "qualification_pending"
              ? "running"
              : "success",
      recordedAtMs: timestampMs(row.updatedAt),
    }));
  const recentSamples = [...artifactSamples, ...fallbackSamples]
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs)
    .slice(0, 10)
    .map(({ recordedAtMs: _ignored, ...sample }) => sample);

  return {
    stage: "qualification",
    runs,
    avgLatencyMs:
      durations.length === 0
        ? 0
        : Math.round(
            durations.reduce((sum, value) => sum + value, 0) / durations.length,
          ),
    failRate: rateRows === 0 ? 0 : failed / rateRows,
    avgTokens:
      tokens.length === 0
        ? 0
        : Math.round(
            tokens.reduce((sum, value) => sum + value, 0) / tokens.length,
          ),
    recentSamples,
  };
}

function buildNonQualificationAnalytics(
  stage: Exclude<OneShotProgressStage, "pr_complete" | "qualification">,
  rows: readonly OneShotDashboardRow[],
  artifactMetrics: readonly ArtifactMetricRow[],
  claimCounts: ReadonlyMap<string, number>,
  failureCounts: ReadonlyMap<string, number>,
  nowMs: number,
): OneShotAgentAnalyticsEntry {
  const stageArtifactRows = artifactMetrics
    .map((row) => ({
      dashboardStage: normalizeDashboardStage(row.artifact_stage),
      row,
    }))
    .filter(
      (
        entry,
      ): entry is {
        dashboardStage: Exclude<OneShotProgressStage, "pr_complete">;
        row: ArtifactMetricRow;
      } => entry.dashboardStage !== null,
    )
    .filter((entry) => entry.dashboardStage === stage);

  const durations = stageArtifactRows
    .map((entry) => metricDurationMs(entry.row))
    .filter((value) => value > 0);
  const tokens = stageArtifactRows
    .map((entry) => metricTokens(entry.row))
    .filter((value) => value > 0);
  const durationByDashboardId = new Map(
    stageArtifactRows.map((entry) => [
      `run-${entry.row.oneshot_run_id}`,
      metricDurationMs(entry.row),
    ]),
  );
  const rowByRunId = new Map(
    rows
      .filter((row): row is OneShotDashboardRow & { oneshotRunId: number } =>
        typeof row.oneshotRunId === "number"
      )
      .map((row) => [row.oneshotRunId, row]),
  );

  const successSamples: TimedAgentSample[] = stageArtifactRows
    .slice()
    .sort(
      (a, b) =>
        Date.parse(String(b.row.recorded_at ?? 0)) -
        Date.parse(String(a.row.recorded_at ?? 0)),
    )
    .slice(0, 10)
    .map((entry) => ({
      dashboardId: `run-${entry.row.oneshot_run_id}`,
      durationMs: metricDurationMs(entry.row),
      tone:
        rowByRunId.get(entry.row.oneshot_run_id)?.displayState === "failed" ||
        rowByRunId.get(entry.row.oneshot_run_id)?.displayState === "qualification_failed"
          ? "warning"
          : "success",
      recordedAtMs: entry.row.recorded_at
        ? new Date(entry.row.recorded_at).getTime()
        : 0,
    }));

  const runningSamples: TimedAgentSample[] = rows
    .filter(
      (row) =>
        row.progressStage === stage &&
        hasState(EXECUTING_STATES, row.displayState),
    )
    .map((row) => ({
      dashboardId: row.dashboardId,
      durationMs: Math.max(0, nowMs - new Date(row.updatedAt).getTime()),
      tone: "running" as const,
      recordedAtMs: new Date(row.updatedAt).getTime(),
    }));

  const failedSamples: TimedAgentSample[] = rows
    .filter(
      (row) => row.progressStage === stage && row.displayState === "failed",
    )
    .map((row) => ({
      dashboardId: row.dashboardId,
      durationMs:
        durationByDashboardId.get(row.dashboardId) ??
        Math.max(
          0,
          new Date(row.updatedAt).getTime() - new Date(row.createdAt).getTime(),
        ),
      tone: "failed" as const,
      recordedAtMs: new Date(row.updatedAt).getTime(),
    }));

  const recentSamples = [...runningSamples, ...failedSamples, ...successSamples]
    .sort((a, b) => b.recordedAtMs - a.recordedAtMs)
    .slice(0, 10)
    .map(({ recordedAtMs: _ignored, ...sample }) => sample);

  const attempts = claimCounts.get(stage) ?? stageArtifactRows.length;
  const failures = failureCounts.get(stage) ?? 0;

  return {
    stage,
    runs: attempts,
    avgLatencyMs:
      durations.length === 0
        ? 0
        : Math.round(
            durations.reduce((sum, value) => sum + value, 0) / durations.length,
          ),
    failRate: attempts === 0 ? 0 : failures / attempts,
    avgTokens:
      tokens.length === 0
        ? 0
        : Math.round(
            tokens.reduce((sum, value) => sum + value, 0) / tokens.length,
          ),
    recentSamples,
  };
}

function createAgentAnalyticsFromSources(
  rows: readonly OneShotDashboardRow[],
  nowMs: number,
  artifactMetrics: readonly ArtifactMetricRow[],
  claimCounts: ReadonlyMap<string, number>,
  failureCounts: ReadonlyMap<string, number>,
): OneShotAgentAnalyticsEntry[] {
  return AGENT_STAGES.map((stage) => {
    if (stage === "qualification") {
      return buildQualificationAnalytics(rows, nowMs, artifactMetrics);
    }

    return buildNonQualificationAnalytics(
      stage,
      rows,
      artifactMetrics,
      claimCounts,
      failureCounts,
      nowMs,
    );
  });
}

async function createQueueAnalytics(
  rows: readonly OneShotDashboardRow[],
): Promise<OneShotQueueAnalytics> {
  const queued = rows.filter((row) =>
    hasState(QUEUED_STATES, row.displayState),
  ).length;
  const running = rows.filter((row) =>
    hasState(EXECUTING_STATES, row.displayState),
  ).length;
  const waiting = rows.filter((row) =>
    hasState(WAITING_STATES, row.displayState),
  ).length;
  const recentlyFinished = rows.filter((row) =>
    hasState(TERMINAL_STATES, row.displayState),
  ).length;

  return {
    queued,
    running,
    waiting,
    recentlyFinished,
    workerCapacity: await resolveWorkerCapacity(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Throughput / Costs / Failures tab analytics (selected finite range or all-time)
//
// Overview and Agents stay on the 24h pulse; these analytics use the selected
// range for row filtering plus matching artifact/event query windows.
// ─────────────────────────────────────────────────────────────────────────────

function timestampMs(timestamp: Date | string | null | undefined): number {
  if (timestamp == null) {
    return 0;
  }
  const value =
    timestamp instanceof Date
      ? timestamp.getTime()
      : new Date(timestamp).getTime();
  return Number.isFinite(value) ? value : 0;
}

function currentItemsForRange<T>(
  items: readonly T[],
  range: OneShotAnalyticsRange,
  nowMs: number,
  getTimestampMs: (item: T) => number,
): T[] {
  if (range === "all") {
    return items.filter((item) => getTimestampMs(item) <= nowMs);
  }

  const durationMs = ANALYTICS_RANGE_CONFIG[range].durationMs;
  const startMs = nowMs - durationMs;
  return items.filter((item) => {
    const value = getTimestampMs(item);
    return value >= startMs && value <= nowMs;
  });
}

function priorItemsForRange<T>(
  items: readonly T[],
  range: OneShotAnalyticsRange,
  nowMs: number,
  getTimestampMs: (item: T) => number,
): T[] {
  if (range === "all") {
    return [];
  }

  const durationMs = ANALYTICS_RANGE_CONFIG[range].durationMs;
  const startMs = nowMs - durationMs * 2;
  const endMs = nowMs - durationMs;
  return items.filter((item) => {
    const value = getTimestampMs(item);
    return value >= startMs && value < endMs;
  });
}

interface BucketPlan {
  window: OneShotAnalyticsWindow;
  startMs: number;
  endMs: number;
  bucketCount: number;
  bucketSizeMs: number;
}

function createBucketPlan(
  range: OneShotAnalyticsRange,
  timestamps: readonly number[],
  nowMs: number,
): BucketPlan {
  if (range !== "all") {
    const config = ANALYTICS_RANGE_CONFIG[range];
    const startMs = nowMs - config.durationMs;
    return {
      window: {
        range,
        label: config.label,
        shortLabel: config.shortLabel,
        bucketLabel: config.bucketLabel,
        isAllTime: false,
      },
      startMs,
      endMs: nowMs,
      bucketCount: config.bucketCount,
      bucketSizeMs: config.durationMs / config.bucketCount,
    };
  }

  const validTimestamps = timestamps.filter(
    (value) => Number.isFinite(value) && value > 0 && value <= nowMs,
  );
  const earliest =
    validTimestamps.length === 0 ? nowMs : Math.min(...validTimestamps);
  const spanMs = Math.max(1, nowMs - earliest);
  const bucketCount = Math.max(1, Math.min(36, Math.ceil(spanMs / DAY_MS)));

  return {
    window: {
      range: "all",
      label: "All time",
      shortLabel: "All",
      bucketLabel:
        bucketCount === 1
          ? "1 all-time bucket"
          : `${bucketCount} equal all-time buckets`,
      isAllTime: true,
    },
    startMs: earliest,
    endMs: nowMs,
    bucketCount,
    bucketSizeMs: Math.max(1, spanMs / bucketCount),
  };
}

function createBuckets<T>(
  items: readonly T[],
  plan: BucketPlan,
  getTimestampMs: (item: T) => number,
): number[] {
  const buckets = Array.from({ length: plan.bucketCount }, () => 0);
  for (const item of items) {
    const value = getTimestampMs(item);
    if (value < plan.startMs || value > plan.endMs) {
      continue;
    }
    const rawIndex = Math.floor((value - plan.startMs) / plan.bucketSizeMs);
    const index = Math.max(0, Math.min(plan.bucketCount - 1, rawIndex));
    buckets[index] += 1;
  }
  return buckets;
}

function trendDelta(
  currentValue: number,
  priorValue: number,
): OneShotTrendDelta {
  if (priorValue === 0) {
    return {
      priorValue,
      pctChange: currentValue === 0 ? 0 : null,
    };
  }
  const pct = ((currentValue - priorValue) / priorValue) * 100;
  return {
    priorValue,
    pctChange: Math.round(pct * 10) / 10,
  };
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const clamped = Math.min(Math.max(p, 0), 1);
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor(clamped * sortedAsc.length),
  );
  return sortedAsc[idx] ?? 0;
}

function createThroughputAnalytics(
  rows: readonly OneShotDashboardRow[],
  claimCounts: ReadonlyMap<string, number>,
  failureCounts: ReadonlyMap<string, number>,
  range: OneShotAnalyticsRange,
  nowMs: number,
): OneShotThroughputAnalytics {
  const current = currentItemsForRange(rows, range, nowMs, (row) =>
    timestampMs(row.createdAt),
  );
  const prior = priorItemsForRange(rows, range, nowMs, (row) =>
    timestampMs(row.createdAt),
  );

  const bucketPlan = createBucketPlan(
    range,
    current.map((row) => timestampMs(row.createdAt)),
    nowMs,
  );
  const buckets = createBuckets(current, bucketPlan, (row) =>
    timestampMs(row.createdAt),
  );

  const completedDurations = current
    .filter(
      (row) =>
        row.displayState === "completed" || row.displayState === "pr_open",
    )
    .map((row) =>
      Math.max(
        0,
        new Date(row.updatedAt).getTime() - new Date(row.createdAt).getTime(),
      ),
    )
    .sort((a, b) => a - b);

  const stageCompletion = AGENT_STAGES.map((stage) => {
    const attempts = claimCounts.get(stage) ?? 0;
    const failures = failureCounts.get(stage) ?? 0;
    const completions = Math.max(0, attempts - failures);
    return { stage, attempts, completions, failures };
  });

  return {
    window: bucketPlan.window,
    buckets,
    totalRuns: current.length,
    trend: range === "all" ? null : trendDelta(current.length, prior.length),
    p50TimeToPrMs: percentile(completedDurations, 0.5),
    p90TimeToPrMs: percentile(completedDurations, 0.9),
    stageCompletion,
  };
}

function createCostsAnalytics(
  rows: readonly OneShotDashboardRow[],
  artifactMetrics: readonly ArtifactMetricRow[],
  range: OneShotAnalyticsRange,
  nowMs: number,
): OneShotCostsAnalytics {
  const currentRows = currentItemsForRange(rows, range, nowMs, (row) =>
    timestampMs(row.createdAt),
  );
  const priorRows = priorItemsForRange(rows, range, nowMs, (row) =>
    timestampMs(row.createdAt),
  );
  const bucketPlan = createBucketPlan(
    range,
    currentRows.map((row) => timestampMs(row.createdAt)),
    nowMs,
  );

  const totalUsd = Number(
    currentRows
      .reduce((sum, row) => sum + rowCostUsd(row), 0)
      .toFixed(6),
  );
  const priorUsd = Number(
    priorRows
      .reduce((sum, row) => sum + rowCostUsd(row), 0)
      .toFixed(6),
  );
  const costSourceRows = currentRows.filter((row) => rowCostUsd(row) > 0);

  // Per-stage ladder
  const stageTokens = new Map<string, number>();
  const stageUsd = new Map<string, number>();
  const attributedTokensByRun = new Map<number, number>();
  const attributedUsdByRun = new Map<number, number>();
  for (const metric of artifactMetrics) {
    const mapped = normalizeDashboardStage(metric.artifact_stage);
    if (!mapped) continue;
    if (
      parseTokenUsage(metric.tokens_used) !== null ||
      coerceFiniteNumber(metric.stage_tokens_used) !== null
    ) {
      const tokens = metricTokens(metric);
      stageTokens.set(mapped, (stageTokens.get(mapped) ?? 0) + tokens);
      if (metric.oneshot_run_id > 0) {
        attributedTokensByRun.set(
          metric.oneshot_run_id,
          (attributedTokensByRun.get(metric.oneshot_run_id) ?? 0) + tokens,
        );
      }
    }
    const contribution = hasCapturedCostMetric(metric)
      ? resolveArtifactCostContribution(dashboardCostRow(metric))
      : null;
    if (contribution) {
      stageUsd.set(mapped, (stageUsd.get(mapped) ?? 0) + contribution.usd);
      if (metric.oneshot_run_id > 0) {
        attributedUsdByRun.set(
          metric.oneshot_run_id,
          (attributedUsdByRun.get(metric.oneshot_run_id) ?? 0) +
            contribution.usd,
        );
      }
    }
  }
  const unattributedRunTokens = currentRows.reduce((sum, row) => {
    if (row.oneshotRunId === null) {
      return sum;
    }
    return attributedTokensByRun.has(row.oneshotRunId)
      ? sum
      : sum + rowTokens(row);
  }, 0);
  const unattributedRunUsd = Number(
    currentRows
      .reduce((sum, row) => {
        if (row.oneshotRunId === null) {
          return sum;
        }
        return attributedUsdByRun.has(row.oneshotRunId)
          ? sum
          : sum + rowCostUsd(row);
      }, 0)
      .toFixed(6),
  );
  const byStage: OneShotStageCost[] = AGENT_STAGES.map((stage) => {
    if (
      stage === "qualification" &&
      !stageTokens.has(stage) &&
      !stageUsd.has(stage)
    ) {
      return { stage, tokens: null, usd: null, share: null };
    }
    const tokens = stageTokens.get(stage) ?? 0;
    const usd = Number((stageUsd.get(stage) ?? 0).toFixed(6));
    const share = totalUsd === 0 ? 0 : usd / totalUsd;
    return { stage, tokens, usd, share };
  });
  const totalTokens =
    byStage.reduce((sum, row) => sum + (row.tokens ?? 0), 0) +
    unattributedRunTokens;

  // Per-model ladder
  const modelTokens = new Map<
    string,
    {
      model: string;
      provider: string | null;
      tokens: number;
      usd: number;
      rawModelIds: Set<string>;
      rawModelTokenTotals: Map<string, number>;
    }
  >();
  for (const metric of artifactMetrics) {
    const provider = metric.provider ?? null;
    const modelUsage = parseModelUsage(metric.model_usage);
    if (!modelUsage && !hasCapturedCostMetric(metric)) continue;
    if (modelUsage) {
      for (const [model, usage] of Object.entries(modelUsage)) {
        const tokens = usage.input + usage.output;
        const pricingModel = pricingModelForModelUsage(metric, model);
        const usd =
          estimateCostUsdFromModelUsage(provider, pricingModel, usage) ??
          resolveArtifactCostContribution({
            ...dashboardCostRow(metric),
            model: pricingModel,
            stage_cost_usd: null,
            stage_tokens_used: tokens,
          })?.usd ??
          0;
        const modelKey = `${provider ?? "unknown"}:${model}`;
        const existing = modelTokens.get(modelKey);
        if (existing) {
          existing.tokens += tokens;
          existing.usd += usd;
          existing.rawModelIds.add(pricingModel);
          addRawModelTokenTotal(
            existing.rawModelTokenTotals,
            pricingModel,
            tokens,
          );
        } else {
          const rawModelTokenTotals = new Map<string, number>();
          addRawModelTokenTotal(rawModelTokenTotals, pricingModel, tokens);
          modelTokens.set(modelKey, {
            model,
            provider,
            tokens,
            usd,
            rawModelIds: new Set([pricingModel]),
            rawModelTokenTotals,
          });
        }
      }
      continue;
    }

    const model = metric.model ?? "unknown";
    const modelKey = `${provider ?? "unknown"}:${model}`;
    const tokens = metricTokens(metric);
    const contribution = resolveArtifactCostContribution(dashboardCostRow(metric));
    const existing = modelTokens.get(modelKey);
    if (existing) {
      existing.tokens += tokens;
      existing.usd += contribution?.usd ?? 0;
      existing.rawModelIds.add(model);
      addRawModelTokenTotal(existing.rawModelTokenTotals, model, tokens);
    } else {
      const rawModelTokenTotals = new Map<string, number>();
      addRawModelTokenTotal(rawModelTokenTotals, model, tokens);
      modelTokens.set(modelKey, {
        model,
        provider,
        tokens,
        usd: contribution?.usd ?? 0,
        rawModelIds: new Set([model]),
        rawModelTokenTotals,
      });
    }
  }
  if (unattributedRunTokens > 0 || unattributedRunUsd > 0) {
    modelTokens.set("unattributed:row-fallback", {
      model: "Unattributed LLM",
      provider: null,
      tokens: unattributedRunTokens,
      usd: unattributedRunUsd,
      rawModelIds: new Set(),
      rawModelTokenTotals: new Map(),
    });
  }
  const canonicalModelTokens = new Map<
    string,
    {
      model: string;
      provider: string | null;
      tokens: number;
      usd: number;
      rawModelIds: Set<string>;
      rawModelTokenTotals: Map<string, number>;
    }
  >();
  for (const bucket of modelTokens.values()) {
    const canonical = canonicalizeModelBucket({
      ...bucket,
      rawModelIds: Array.from(bucket.rawModelIds),
    });
    if (!canonical) continue;
    const existing = canonicalModelTokens.get(canonical.key);
    if (existing) {
      existing.tokens += canonical.tokens;
      existing.usd += canonical.usd;
      for (const rawModelId of canonical.rawModelIds) {
        existing.rawModelIds.add(rawModelId);
      }
      for (const [rawModelId, rawTokens] of bucket.rawModelTokenTotals) {
        addRawModelTokenTotal(
          existing.rawModelTokenTotals,
          rawModelId,
          rawTokens,
        );
      }
    } else {
      canonicalModelTokens.set(canonical.key, {
        model: canonical.model,
        provider: canonical.provider,
        tokens: canonical.tokens,
        usd: canonical.usd,
        rawModelIds: new Set(canonical.rawModelIds),
        rawModelTokenTotals: new Map(bucket.rawModelTokenTotals),
      });
    }
  }
  const byModel: OneShotModelCost[] = Array.from(canonicalModelTokens.values())
    .map(({ model, provider, tokens, usd, rawModelIds, rawModelTokenTotals }) => {
      const share = totalUsd === 0 ? 0 : usd / totalUsd;
      return {
        model,
        provider,
        rawModelIds: Array.from(rawModelIds).sort(),
        pricing: pricingForModelBucket(provider, model, rawModelTokenTotals),
        tokens,
        usd: Number(usd.toFixed(6)),
        share,
      };
    })
    .sort((a, b) => b.usd - a.usd);

  // Top 5 most expensive runs
  const topRuns: OneShotTopCostRun[] = [...currentRows]
    .sort((a, b) => rowCostUsd(b) - rowCostUsd(a))
    .slice(0, 5)
    .map((row) => ({
      dashboardId: row.dashboardId,
      jiraKey: row.jiraKey,
      title: row.title,
      totalTokensUsed:
        row.oneshotRunId === null
          ? rowTokens(row)
          : (attributedTokensByRun.get(row.oneshotRunId) ?? rowTokens(row)),
      estimatedCostUsd: rowCostUsd(row),
      costSource: row.costSource,
      progressStage: row.progressStage,
      displayState: row.displayState,
    }));

  return {
    window: bucketPlan.window,
    totalUsd,
    totalTokens,
    costSource: mergeCostSources(costSourceRows.map((row) => row.costSource)),
    trend: range === "all" ? null : trendDelta(totalUsd, priorUsd),
    byStage,
    byModel,
    topRuns,
  };
}

function createFailuresAnalytics(
  rows: readonly OneShotDashboardRow[],
  range: OneShotAnalyticsRange,
  nowMs: number,
): OneShotFailuresAnalytics {
  // Use `updatedAt` as the failure timestamp — a run may have started yesterday
  // and failed within the current range; we want that in the failures window.
  const failedRows = currentItemsForRange(
    rows.filter(
      (row) =>
        row.displayState === "failed" ||
        row.displayState === "qualification_failed",
    ),
    range,
    nowMs,
    (row) => timestampMs(row.updatedAt),
  );
  const bucketPlan = createBucketPlan(
    range,
    failedRows.map((row) => timestampMs(row.updatedAt)),
    nowMs,
  );

  interface ClusterAccumulator {
    signature: string;
    code: string | null;
    headline: string;
    representativeRow: OneShotDashboardRow;
    representativeMs: number;
    rows: OneShotDashboardRow[];
  }

  const clusters = new Map<string, ClusterAccumulator>();
  for (const row of failedRows) {
    const summary = buildFailureClassificationMessage(row) || "Unknown error";
    const parsed = parseErrorSummary(summary);
    const signature = clusterSignature(parsed);
    const updatedMs = new Date(row.updatedAt).getTime();
    const existing = clusters.get(signature);
    if (existing) {
      existing.rows.push(row);
      if (updatedMs > existing.representativeMs) {
        existing.representativeRow = row;
        existing.representativeMs = updatedMs;
      }
    } else {
      clusters.set(signature, {
        signature,
        code: parsed.code,
        headline: parsed.heading,
        representativeRow: row,
        representativeMs: updatedMs,
        rows: [row],
      });
    }
  }

  const RECENCY_HALF_LIFE_MS = 6 * 60 * 60 * 1000;

  const result: OneShotFailureCluster[] = Array.from(clusters.values())
    .map((acc) => {
      const stageCountMap = new Map<
        Exclude<OneShotProgressStage, "pr_complete">,
        number
      >();
      const jiraKeys: string[] = [];

      for (const row of acc.rows) {
        // stageCounts keyed by row.progressStage (excluding pr_complete)
        if (row.progressStage !== "pr_complete") {
          stageCountMap.set(
            row.progressStage,
            (stageCountMap.get(row.progressStage) ?? 0) + 1,
          );
        }
        if (jiraKeys.length < 5 && !jiraKeys.includes(row.jiraKey)) {
          jiraKeys.push(row.jiraKey);
        }
      }

      const stageCounts = AGENT_STAGES.map((stage) => ({
        stage,
        count: stageCountMap.get(stage) ?? 0,
      })).filter((entry) => entry.count > 0);

      return {
        signature: acc.signature,
        code: acc.code,
        headline: acc.headline,
        count: acc.rows.length,
        representativeDashboardId: acc.representativeRow.dashboardId,
        jiraKeys,
        stageCounts,
        buckets: createBuckets(acc.rows, bucketPlan, (row) =>
          timestampMs(row.updatedAt),
        ),
        lastSeenMs: acc.representativeMs,
      };
    })
    .sort((a, b) => {
      // recency-weighted count: count × 2^(-ageHours / 6h)
      const ageHoursA = Math.max(0, (nowMs - a.lastSeenMs) / (60 * 60 * 1000));
      const ageHoursB = Math.max(0, (nowMs - b.lastSeenMs) / (60 * 60 * 1000));
      const scoreA =
        a.count * Math.pow(2, -ageHoursA / (RECENCY_HALF_LIFE_MS / 3600000));
      const scoreB =
        b.count * Math.pow(2, -ageHoursB / (RECENCY_HALF_LIFE_MS / 3600000));
      return scoreB - scoreA;
    });

  return {
    window: bucketPlan.window,
    totalFailures: failedRows.length,
    clusters: result,
  };
}

export async function buildOneShotDashboardAnalytics(
  rows: readonly OneShotDashboardRow[],
  requestedRange: OneShotAnalyticsRange = DEFAULT_ONESHOT_ANALYTICS_RANGE,
): Promise<OneShotDashboardAnalytics> {
  const nowMs = Date.now();
  const range = normalizeOneShotAnalyticsRange(requestedRange);
  const artifactMetrics24hPromise = fetchArtifactMetricsForRange("24h", nowMs);
  const claimCounts24hPromise = fetchRunClaimCountsForRange("24h", nowMs);
  const failureCounts24hPromise = fetchFailureCountsForRange("24h", nowMs);
  const outcomeTransitionTimesPromise = fetchOutcomeTransitionTimes(rows);
  const selectedArtifactMetricsPromise =
    range === "24h"
      ? artifactMetrics24hPromise
      : fetchArtifactMetricsForRange(range, nowMs);
  const selectedClaimCountsPromise =
    range === "24h"
      ? claimCounts24hPromise
      : fetchRunClaimCountsForRange(range, nowMs);
  const selectedFailureCountsPromise =
    range === "24h"
      ? failureCounts24hPromise
      : fetchFailureCountsForRange(range, nowMs);

  const [
    artifactMetrics24h,
    claimCounts24h,
    failureCounts24h,
    selectedArtifactMetrics,
    selectedClaimCounts,
    selectedFailureCounts,
    queue,
    outcomeTransitionTimes,
  ] = await Promise.all([
    artifactMetrics24hPromise,
    claimCounts24hPromise,
    failureCounts24hPromise,
    selectedArtifactMetricsPromise,
    selectedClaimCountsPromise,
    selectedFailureCountsPromise,
    createQueueAnalytics(rows),
    outcomeTransitionTimesPromise,
  ]);

  const agents = createAgentAnalyticsFromSources(
    rows,
    nowMs,
    artifactMetrics24h,
    claimCounts24h,
    failureCounts24h,
  );

  return {
    overview24h: createOverviewAnalytics(
      rows,
      nowMs,
      failureCounts24h,
      artifactMetrics24h,
      outcomeTransitionTimes,
    ),
    agents,
    queue,
    throughput: createThroughputAnalytics(
      rows,
      selectedClaimCounts,
      selectedFailureCounts,
      range,
      nowMs,
    ),
    costs: createCostsAnalytics(rows, selectedArtifactMetrics, range, nowMs),
    failures: createFailuresAnalytics(rows, range, nowMs),
  };
}
