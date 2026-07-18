import { createHash } from "node:crypto";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { jsonrepair } from "jsonrepair";
import type mysql from "mysql2/promise";
import { z } from "zod";
import { getPool } from "../db.js";
import { clusterSignature, parseErrorSummary } from "../shared/errorParsing.js";
import {
  isWeakTicketTier,
  publicReadinessRubric,
  READINESS_RUBRIC,
  scoreTicketReadiness,
  SIGNAL_LABELS,
  TEMPLATE_FIT_LABELS,
  TICKET_READINESS_SIGNALS,
  TICKET_READINESS_TIERS,
  TICKET_TEMPLATE_FITS,
  TIER_LABELS,
} from "../shared/ticketReadiness.js";
import type {
  OneShotAnalyticsRange,
  OneShotAnalyticsWindow,
  OneShotDashboardRow,
  OneShotFailureAttributionLabel,
  OneShotFailureAttributionSummary,
  OneShotFailureErrorCategory,
  OneShotFaultAttribution,
  OneShotProgressStage,
  OneShotMissingSignalImpact,
  OneShotOperationalBottleneckFailureAttribution,
  OneShotOperationalBottleneckRow,
  OneShotOperationalBottleneckSeverity,
  OneShotOperationalBottleneckSummary,
  OneShotReadinessStratum,
  OneShotRepoStatusFailureAttribution,
  OneShotRepoStatusRow,
  OneShotRepoStatusStageIssue,
  OneShotRepoStatusSummary,
  OneShotStatisticsJiraExample,
  OneShotStatisticsAction,
  OneShotStatisticsBucket,
  OneShotStatisticsBucketKind,
  OneShotStatisticsBusinessMetric,
  OneShotStatisticsDelta,
  OneShotStatisticsInsight,
  OneShotStatisticsResponse,
  OneShotStatisticsScorecard,
  OneShotTicketQualityAnalysis,
  OneShotTicketQualityCohort,
  OneShotTicketQualityDistributionBucket,
  OneShotTicketReadinessScore,
  OneShotTicketReadinessSignal,
  OneShotTicketReadinessTier,
  OneShotTicketTemplateFit,
  OneShotWilsonInterval,
} from "../types/oneshot.js";
import { getOneShotDashboardRows } from "./oneshot.js";
import {
  buildFailureClassificationMessage,
  classifyFailure,
  FAILURE_ATTRIBUTION_VERSION,
  summarizeFailureAttribution,
} from "./failureAttribution.js";
import {
  redactBucketForLlm,
  redactFailureAttributionForLlm,
  redactOperationalBottlenecksForLlm,
  redactRepoStatusForLlm,
  redactTicketQualityForLlm,
} from "./llmInputRedaction.js";
import {
  buildOneShotSelfFixCandidates,
  getOneShotSelfFixConfig,
  selfFixMinSampleSize,
} from "./oneshotSelfFixCandidates.js";
import { enrichSelfFixCandidatesWithTicketStatus } from "./oneshotSelfFixTicketStore.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_MIN_SAMPLE_SIZE = 5;
const REFRESH_LEASE_SECONDS = 10 * 60;
const INVALID_RETRY_SECONDS = 10 * 60;
const FAILED_RETRY_SECONDS = 5 * 60;
const DEFAULT_STATISTICS_LLM_MAX_TOKENS = 3200;
const LLM_OUTPUT_SAMPLE_CHARS = 4000;
const AI_REFRESH_FAILURE_MESSAGE =
  "AI summary refresh failed; showing deterministic statistics. Retrying automatically.";
const MAX_LLM_BUCKETS = 36;
const MAX_EXAMPLES_PER_BUCKET = 4;
const REPO_STATUS_VERSION = 1 as const;
const OPERATIONAL_BOTTLENECK_VERSION = 1 as const;
const MAX_OPERATIONAL_BOTTLENECKS = 5;
const COST_WASTE_USD_THRESHOLD = 25;
const COST_WASTE_TOKEN_THRESHOLD = 1_000_000;
const COST_WASTE_HIGH_USD_THRESHOLD = 100;
const COST_WASTE_HIGH_TOKEN_THRESHOLD = 5_000_000;
const REPO_STATUS_MIN_TERMINAL = 3;
const REPO_STATUS_HEALTHY_PASS_RATE = 0.8;
const REPO_STATUS_BLOCKED_PASS_RATE = 0.4;
const REPO_STATUS_STAGE_CLUSTER_MIN_ISSUES = 2;
const REPO_STATUS_STAGE_CLUSTER_SHARE = 0.5;

const RANGE_CONFIG: Record<
  Exclude<OneShotAnalyticsRange, "all">,
  {
    label: string;
    shortLabel: string;
    durationMs: number;
    bucketCount: number;
    bucketLabel: string;
    defaultRefreshMs: number;
  }
> = {
  "24h": {
    label: "Last 24h",
    shortLabel: "24h",
    durationMs: DAY_MS,
    bucketCount: 48,
    bucketLabel: "48 x 30-min buckets",
    defaultRefreshMs: 30 * 60 * 1000,
  },
  "7d": {
    label: "Last 7d",
    shortLabel: "7d",
    durationMs: 7 * DAY_MS,
    bucketCount: 28,
    bucketLabel: "28 x 6-hour buckets",
    defaultRefreshMs: 60 * 60 * 1000,
  },
  "30d": {
    label: "Last 30d",
    shortLabel: "30d",
    durationMs: 30 * DAY_MS,
    bucketCount: 30,
    bucketLabel: "30 x daily buckets",
    defaultRefreshMs: 2 * 60 * 60 * 1000,
  },
};

const AGENT_STAGES: Array<Exclude<OneShotProgressStage, "pr_complete">> = [
  "qualification",
  "planning",
  "review",
  "implementation",
  "code_review",
  "testing",
];

const STAGE_LABELS: Record<
  Exclude<OneShotProgressStage, "pr_complete">,
  string
> = {
  qualification: "Qualification",
  planning: "Planning",
  review: "Review",
  implementation: "Implementation",
  code_review: "Code Review",
  testing: "Testing",
};

type SnapshotStatus = "ready" | "invalid" | "failed";

type SnapshotRow = mysql.RowDataPacket & {
  id: number;
  range_key: OneShotAnalyticsRange;
  data_fingerprint: string;
  status: SnapshotStatus;
  snapshot_json: unknown;
  provider: string | null;
  model: string | null;
  generated_at: Date | string;
  expires_at: Date | string | null;
  error_message: string | null;
};

type RefreshStateRow = mysql.RowDataPacket & {
  range_key: OneShotAnalyticsRange;
  latest_snapshot_id: number | null;
  refresh_started_at: Date | string | null;
  refresh_lease_expires_at: Date | string | null;
  next_retry_at: Date | string | null;
  last_error: string | null;
};

type TaskTextRow = mysql.RowDataPacket & {
  task_management_id: number;
  task_description: string | null;
  metrics_json: unknown;
};

type TaskTextSnapshot = {
  taskDescription: string;
  qualifierOutcome: { acceptanceCriteriaPresent?: boolean } | null;
};

type StatisticsRowContext = {
  row: OneShotDashboardRow;
  taskText: string;
  timestampMs: number;
  readiness: OneShotTicketReadinessScore;
};

type BucketAccumulator = {
  id: string;
  label: string;
  kind: OneShotStatisticsBucketKind;
  rows: StatisticsRowContext[];
};

type ScorecardInput = {
  rows: StatisticsRowContext[];
};

type LlmStatisticsOutput = z.infer<typeof LlmStatisticsSchema>;

const LlmInsightSchema = z
  .object({
    bucketId: z.string().min(1),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(900),
    reason: z.string().min(1).max(900),
    confidence: z.number().min(0).max(1),
  })
  .strict();

const LlmBusinessMetricSchema = z
  .object({
    id: z.string().min(1).max(80),
    title: z.string().min(1).max(140),
    summary: z.string().min(1).max(700),
  })
  .strict();

const LlmActionSchema = z
  .object({
    id: z.string().min(1).max(80),
    priority: z.enum(["high", "medium", "low"]),
    title: z.string().min(1).max(160),
    summary: z.string().min(1).max(900),
    bucketId: z.string().min(1).nullable(),
  })
  .strict();

const LlmFailureAttributionNarrativeSchema = z
  .object({
    summary: z.string().min(1).max(900),
    oneshotPatterns: z.array(z.string().min(1).max(300)).max(5),
    ticketPatterns: z.array(z.string().min(1).max(300)).max(5),
  })
  .strict();

const LlmStatisticsSchema = z
  .object({
    summary: z.string().min(1).max(1200),
    workingWell: z.array(LlmInsightSchema).max(5),
    needsImprovement: z.array(LlmInsightSchema).max(5),
    businessMetrics: z.array(LlmBusinessMetricSchema).max(8),
    recommendedActions: z.array(LlmActionSchema).max(6),
    failureAttributionNarrative:
      LlmFailureAttributionNarrativeSchema.optional(),
    templateFitNarrative: z.string().min(1).max(900).optional(),
  })
  .strict();

export const STATISTICS_PROMPT_VERSION = 1 as const;

export function getStatisticsWindow(
  range: OneShotAnalyticsRange,
): OneShotAnalyticsWindow {
  if (range === "all") {
    return {
      range,
      label: "All time",
      shortLabel: "All",
      bucketLabel: "All intake",
      isAllTime: true,
    };
  }

  const config = RANGE_CONFIG[range];
  return {
    range,
    label: config.label,
    shortLabel: config.shortLabel,
    bucketLabel: config.bucketLabel,
    isAllTime: false,
  };
}

function finiteNumber(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseDateMs(value: string): number {
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function configuredNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function refreshIntervalMs(range: OneShotAnalyticsRange): number {
  if (range === "all") {
    return configuredNumber(
      "ONESHOT_STATISTICS_REFRESH_INTERVAL_MS_ALL",
      6 * 60 * 60 * 1000,
    );
  }

  const envName = `ONESHOT_STATISTICS_REFRESH_INTERVAL_MS_${range.toUpperCase().replace(/\W/g, "_")}`;
  return configuredNumber(envName, RANGE_CONFIG[range].defaultRefreshMs);
}

function minSampleSize(): number {
  return configuredNumber(
    "ONESHOT_STATISTICS_MIN_SAMPLE_SIZE",
    DEFAULT_MIN_SAMPLE_SIZE,
  );
}

function claimMinSampleSize(): number {
  return Math.max(minSampleSize(), READINESS_RUBRIC.thresholds.bucketClaimMinN);
}

function buildJiraUrl(jiraKey: string): string | null {
  const base = process.env.JIRA_BASE_URL?.trim().replace(/\/$/, "");
  return base ? `${base}/browse/${encodeURIComponent(jiraKey)}` : null;
}

function exampleForRow(row: OneShotDashboardRow): OneShotStatisticsJiraExample {
  return {
    jiraKey: row.jiraKey,
    dashboardId: row.dashboardId,
    title: row.title,
    jiraUrl: buildJiraUrl(row.jiraKey),
  };
}

function isCompleted(row: OneShotDashboardRow): boolean {
  return row.displayState === "completed" || row.displayState === "pr_open";
}

function isFailed(row: OneShotDashboardRow): boolean {
  return (
    row.displayState === "failed" || row.displayState === "qualification_failed"
  );
}

function isNoAction(row: OneShotDashboardRow): boolean {
  return row.displayState === "qualification_no_action";
}

function timeToPrMs(row: OneShotDashboardRow): number | null {
  if (!isCompleted(row)) return null;
  const duration = parseDateMs(row.updatedAt) - parseDateMs(row.createdAt);
  return duration >= 0 ? duration : null;
}

function percentile(sortedAsc: readonly number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const index = Math.min(
    sortedAsc.length - 1,
    Math.floor(Math.max(0, Math.min(1, p)) * sortedAsc.length),
  );
  return sortedAsc[index] ?? 0;
}

function delta(
  currentValue: number,
  priorValue: number,
): OneShotStatisticsDelta {
  return {
    currentValue,
    priorValue,
    delta: currentValue - priorValue,
    pctChange:
      priorValue === 0
        ? currentValue === 0
          ? 0
          : null
        : Number((((currentValue - priorValue) / priorValue) * 100).toFixed(1)),
  };
}

function currentContextsForRange(
  contexts: readonly StatisticsRowContext[],
  range: OneShotAnalyticsRange,
  nowMs: number,
): StatisticsRowContext[] {
  if (range === "all") {
    return contexts.filter((ctx) => ctx.timestampMs <= nowMs);
  }
  const startMs = nowMs - RANGE_CONFIG[range].durationMs;
  return contexts.filter(
    (ctx) => ctx.timestampMs >= startMs && ctx.timestampMs <= nowMs,
  );
}

function priorContextsForRange(
  contexts: readonly StatisticsRowContext[],
  range: OneShotAnalyticsRange,
  nowMs: number,
): StatisticsRowContext[] {
  if (range === "all") return [];
  const durationMs = RANGE_CONFIG[range].durationMs;
  const startMs = nowMs - durationMs * 2;
  const endMs = nowMs - durationMs;
  return contexts.filter(
    (ctx) => ctx.timestampMs >= startMs && ctx.timestampMs < endMs,
  );
}

function createScorecard(input: ScorecardInput): OneShotStatisticsScorecard {
  const rows = input.rows.map((ctx) => ctx.row);
  const completedRows = rows.filter(isCompleted);
  const failedRows = rows.filter(isFailed);
  const noActionRows = rows.filter(isNoAction);
  const durations = rows
    .map(timeToPrMs)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const completedAndFailed = completedRows.length + failedRows.length;

  return {
    intake: rows.length,
    qualifiedRuns: rows.filter((row) => row.oneshotRunId !== null).length,
    completed: completedRows.length,
    failed: failedRows.length,
    noAction: noActionRows.length,
    passRate:
      completedAndFailed === 0 ? 0 : completedRows.length / completedAndFailed,
    totalTokens: rows.reduce(
      (sum, row) => sum + finiteNumber(row.totalTokensUsed),
      0,
    ),
    totalUsd: Number(
      rows
        .reduce((sum, row) => sum + finiteNumber(row.estimatedCostUsd), 0)
        .toFixed(6),
    ),
    p50TimeToPrMs: percentile(durations, 0.5),
    p90TimeToPrMs: percentile(durations, 0.9),
    deltas: {
      intake: null,
      passRate: null,
      completed: null,
      failed: null,
      totalUsd: null,
      totalTokens: null,
      p50TimeToPrMs: null,
    },
  };
}

function scorecardWithDeltas(
  current: OneShotStatisticsScorecard,
  prior: OneShotStatisticsScorecard | null,
): OneShotStatisticsScorecard {
  if (!prior) return current;
  return {
    ...current,
    deltas: {
      intake: delta(current.intake, prior.intake),
      passRate: {
        currentValue: current.passRate,
        priorValue: prior.passRate,
        delta: Number(((current.passRate - prior.passRate) * 100).toFixed(1)),
        pctChange:
          prior.passRate === 0
            ? current.passRate === 0
              ? 0
              : null
            : Number(
                (
                  ((current.passRate - prior.passRate) / prior.passRate) *
                  100
                ).toFixed(1),
              ),
      },
      completed: delta(current.completed, prior.completed),
      failed: delta(current.failed, prior.failed),
      totalUsd: delta(current.totalUsd, prior.totalUsd),
      totalTokens: delta(current.totalTokens, prior.totalTokens),
      p50TimeToPrMs: delta(current.p50TimeToPrMs, prior.p50TimeToPrMs),
    },
  };
}

function wilsonInterval(
  successes: number,
  total: number,
): OneShotWilsonInterval | null {
  if (total <= 0) return null;
  const z = 1.96;
  const p = successes / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const center = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return {
    low: Math.max(0, (center - margin) / denominator),
    high: Math.min(1, (center + margin) / denominator),
  };
}

function createTicketQualityCohort(
  contexts: readonly StatisticsRowContext[],
): OneShotTicketQualityCohort {
  const rows = contexts.map((ctx) => ctx.row);
  const completed = rows.filter(isCompleted).length;
  const failed = rows.filter(isFailed).length;
  const noAction = rows.filter(isNoAction).length;
  const terminalCount = completed + failed;
  return {
    sampleSize: contexts.length,
    terminalCount,
    completed,
    failed,
    noAction,
    passRate: terminalCount === 0 ? 0 : completed / terminalCount,
    wilson95: wilsonInterval(completed, terminalCount),
  };
}

function averageReadinessScore(
  contexts: readonly StatisticsRowContext[],
): number {
  if (contexts.length === 0) return 0;
  return Number(
    (
      contexts.reduce((sum, ctx) => sum + ctx.readiness.score, 0) /
      contexts.length
    ).toFixed(1),
  );
}

function scoreDelta(
  current: readonly StatisticsRowContext[],
  prior: readonly StatisticsRowContext[] | null,
): OneShotStatisticsDelta | null {
  if (!prior) return null;
  return delta(averageReadinessScore(current), averageReadinessScore(prior));
}

function examplesForContexts(
  contexts: readonly StatisticsRowContext[],
  limit = MAX_EXAMPLES_PER_BUCKET,
): OneShotStatisticsJiraExample[] {
  return contexts.slice(0, limit).map((ctx) => exampleForRow(ctx.row));
}

function distributionBucket<
  T extends OneShotTicketReadinessTier | OneShotTicketTemplateFit,
>(
  id: T,
  label: string,
  contexts: readonly StatisticsRowContext[],
  total: number,
): OneShotTicketQualityDistributionBucket {
  return {
    id,
    label,
    sampleSize: contexts.length,
    share: total === 0 ? 0 : contexts.length / total,
    cohort: createTicketQualityCohort(contexts),
    averageScore: averageReadinessScore(contexts),
    examples: examplesForContexts(contexts),
  };
}

function intervalsDoNotOverlap(
  better: OneShotWilsonInterval | null,
  weaker: OneShotWilsonInterval | null,
): boolean {
  return Boolean(better && weaker && better.low > weaker.high);
}

type SignalRowDraft = {
  signal: OneShotTicketReadinessSignal;
  label: string;
  missingDashboardIds: Set<string>;
  presentDashboardIds: Set<string>;
  missingContexts: StatisticsRowContext[];
  presentContexts: StatisticsRowContext[];
  impact: OneShotMissingSignalImpact;
};

const COLLAPSE_JACCARD_THRESHOLD = 0.9;

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const value of smaller) {
    if (larger.has(value)) intersection += 1;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function collapseCoOccurringSignalRows(
  drafts: readonly SignalRowDraft[],
): OneShotMissingSignalImpact[] {
  const remaining = drafts.slice();
  const out: OneShotMissingSignalImpact[] = [];
  while (remaining.length > 0) {
    const head = remaining.shift()!;
    const cluster: SignalRowDraft[] = [head];
    for (let i = remaining.length - 1; i >= 0; i -= 1) {
      const candidate = remaining[i];
      const missingOverlap = jaccard(
        head.missingDashboardIds,
        candidate.missingDashboardIds,
      );
      const presentOverlap = jaccard(
        head.presentDashboardIds,
        candidate.presentDashboardIds,
      );
      if (
        missingOverlap >= COLLAPSE_JACCARD_THRESHOLD &&
        presentOverlap >= COLLAPSE_JACCARD_THRESHOLD
      ) {
        cluster.push(candidate);
        remaining.splice(i, 1);
      }
    }
    if (cluster.length === 1) {
      out.push(head.impact);
      continue;
    }
    const orderedSignals = cluster
      .map((draft) => draft.signal)
      .sort((a, b) => a.localeCompare(b));
    const orderedLabels = cluster
      .map((draft) => draft.label)
      .sort((a, b) => a.localeCompare(b));
    const compositeId = `co:${orderedSignals.join("+")}`;
    const baseImpact = head.impact;
    out.push({
      ...baseImpact,
      signal: compositeId,
      label: orderedLabels.join(" + "),
      signals: orderedSignals,
    });
  }
  return out;
}

function missingSignalImpacts(
  contexts: readonly StatisticsRowContext[],
): OneShotMissingSignalImpact[] {
  const minN = READINESS_RUBRIC.thresholds.missingSignalCohortMinN;
  const drafts: SignalRowDraft[] = TICKET_READINESS_SIGNALS.map((signal) => {
    const missingContexts = contexts.filter(
      (ctx) => !ctx.readiness.signals[signal],
    );
    const presentContexts = contexts.filter(
      (ctx) => ctx.readiness.signals[signal],
    );
    const missing = createTicketQualityCohort(missingContexts);
    const present = createTicketQualityCohort(presentContexts);
    const significant =
      missing.sampleSize >= minN &&
      present.sampleSize >= minN &&
      intervalsDoNotOverlap(present.wilson95, missing.wilson95);
    const impact: OneShotMissingSignalImpact = {
      signal,
      label: SIGNAL_LABELS[signal],
      missing,
      present,
      deltaPassRate: Number(
        ((present.passRate - missing.passRate) * 100).toFixed(1),
      ),
      significant,
      examples: {
        missingFailedOrNoAction: examplesForContexts(
          missingContexts.filter(
            (ctx) => isFailed(ctx.row) || isNoAction(ctx.row),
          ),
          5,
        ),
        presentPassed: examplesForContexts(
          presentContexts.filter((ctx) => isCompleted(ctx.row)),
          2,
        ),
      },
    };
    return {
      signal,
      label: SIGNAL_LABELS[signal],
      missingDashboardIds: new Set(
        missingContexts.map((ctx) => ctx.row.dashboardId),
      ),
      presentDashboardIds: new Set(
        presentContexts.map((ctx) => ctx.row.dashboardId),
      ),
      missingContexts,
      presentContexts,
      impact,
    };
  });

  const eligible = drafts.filter(
    (draft) =>
      draft.impact.missing.sampleSize >= minN &&
      draft.impact.present.sampleSize >= minN,
  );

  return collapseCoOccurringSignalRows(eligible).sort(
    (a, b) =>
      Number(b.significant) - Number(a.significant) ||
      b.deltaPassRate - a.deltaPassRate ||
      b.missing.sampleSize - a.missing.sampleSize,
  );
}

function groupContexts(
  contexts: readonly StatisticsRowContext[],
  kind: "repo" | "stage",
): Map<string, StatisticsRowContext[]> {
  const groups = new Map<string, StatisticsRowContext[]>();
  for (const ctx of contexts) {
    const label =
      kind === "repo"
        ? ctx.row.repoName || "Unresolved repository"
        : ctx.row.progressStage === "pr_complete"
          ? "PR complete"
          : STAGE_LABELS[ctx.row.progressStage];
    const existing = groups.get(label);
    if (existing) {
      existing.push(ctx);
    } else {
      groups.set(label, [ctx]);
    }
  }
  return groups;
}

function buildReadinessStratification(
  contexts: readonly StatisticsRowContext[],
): OneShotTicketQualityAnalysis["stratifiedReadinessGap"] {
  const weakContexts = contexts.filter((ctx) =>
    isWeakTicketTier(ctx.readiness.tier),
  );
  const nonWeakContexts = contexts.filter(
    (ctx) => !isWeakTicketTier(ctx.readiness.tier),
  );
  const weak = createTicketQualityCohort(weakContexts);
  const nonWeak = createTicketQualityCohort(nonWeakContexts);
  const significantOverall = intervalsDoNotOverlap(
    nonWeak.wilson95,
    weak.wilson95,
  );
  const weakIds = new Set(weakContexts.map((ctx) => ctx.row.dashboardId));
  const eligibleWeakIds = new Set<string>();
  const significantWeakIds = new Set<string>();
  const strata: OneShotReadinessStratum[] = [];
  const minN = READINESS_RUBRIC.thresholds.bucketClaimMinN;

  for (const kind of ["repo", "stage"] as const) {
    for (const [label, group] of groupContexts(contexts, kind)) {
      const groupWeakContexts = group.filter((ctx) =>
        isWeakTicketTier(ctx.readiness.tier),
      );
      const groupNonWeakContexts = group.filter(
        (ctx) => !isWeakTicketTier(ctx.readiness.tier),
      );
      const groupWeak = createTicketQualityCohort(groupWeakContexts);
      const groupNonWeak = createTicketQualityCohort(groupNonWeakContexts);
      if (groupWeak.sampleSize < minN || groupNonWeak.sampleSize < minN) {
        continue;
      }
      groupWeakContexts.forEach((ctx) =>
        eligibleWeakIds.add(ctx.row.dashboardId),
      );
      const significantSameDirection = intervalsDoNotOverlap(
        groupNonWeak.wilson95,
        groupWeak.wilson95,
      );
      if (significantSameDirection) {
        groupWeakContexts.forEach((ctx) =>
          significantWeakIds.add(ctx.row.dashboardId),
        );
      }
      strata.push({
        kind,
        label,
        weak: groupWeak,
        nonWeak: groupNonWeak,
        significantSameDirection,
      });
    }
  }

  const eligibleWeakCoverageShare =
    weakIds.size === 0 ? 0 : eligibleWeakIds.size / weakIds.size;
  const significantWeakCoverageShare =
    weakIds.size === 0 ? 0 : significantWeakIds.size / weakIds.size;
  const weakShare =
    contexts.length === 0 ? 0 : weak.sampleSize / contexts.length;
  const dominantStrata = strata
    .filter((stratum) => stratum.significantSameDirection)
    .sort((a, b) => b.weak.sampleSize - a.weak.sampleSize)
    .slice(0, 4);
  const qualifiesForRecommendation =
    significantOverall &&
    weakShare >= READINESS_RUBRIC.thresholds.weakRecommendationMinShare &&
    significantWeakCoverageShare >=
      READINESS_RUBRIC.thresholds.stratifiedCoverageMinShare;

  return {
    weak,
    nonWeak,
    significantOverall,
    eligibleWeakCoverageShare,
    significantWeakCoverageShare,
    qualifiesForRecommendation,
    dominantStrata,
    recommendationSummary: qualifiesForRecommendation
      ? `Tickets matching the template or clear free-form expectations show higher pass rates in ${dominantStrata.map((stratum) => stratum.label).join(", ")}; investigate whether template adherence would help.`
      : null,
  };
}

function buildTicketQualityAnalysis(
  current: readonly StatisticsRowContext[],
): OneShotTicketQualityAnalysis {
  const total = current.length;
  const missingDescription = current.filter(
    (ctx) => ctx.readiness.tier === "missing_description",
  );
  const missingDescriptionShare =
    total === 0 ? 0 : missingDescription.length / total;
  const dataHygieneCallout =
    total >= READINESS_RUBRIC.thresholds.dataHygieneMinN &&
    missingDescriptionShare >=
      READINESS_RUBRIC.thresholds.dataHygieneMissingDescriptionMinShare
      ? {
          title: "Missing captured descriptions",
          summary: `${missingDescription.length} of ${total} intake items have missing or title-only descriptions. Check whether the upstream collector is preserving Jira description text at intake.`,
          missingDescriptionCount: missingDescription.length,
          missingDescriptionShare,
          examples: examplesForContexts(missingDescription, 5),
        }
      : null;

  return {
    rubric: publicReadinessRubric(),
    disclaimer:
      "Score reflects ticket text captured at OneShot intake, not current Jira text.",
    totalIntake: total,
    averageScore: averageReadinessScore(current),
    readinessDistribution: TICKET_READINESS_TIERS.map((tier) =>
      distributionBucket(
        tier,
        TIER_LABELS[tier],
        current.filter((ctx) => ctx.readiness.tier === tier),
        total,
      ),
    ),
    passRateByTier: TICKET_READINESS_TIERS.map((tier) =>
      distributionBucket(
        tier,
        TIER_LABELS[tier],
        current.filter((ctx) => ctx.readiness.tier === tier),
        total,
      ),
    ),
    templateFit: TICKET_TEMPLATE_FITS.map((fit) =>
      distributionBucket(
        fit,
        TEMPLATE_FIT_LABELS[fit],
        current.filter((ctx) => ctx.readiness.templateFit === fit),
        total,
      ),
    ),
    missingSignalImpact: missingSignalImpacts(current),
    dataHygieneCallout,
    stratifiedReadinessGap: buildReadinessStratification(current),
  };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56) || "unknown"
  );
}

function repoStatusLabelForFailure(
  row: OneShotDashboardRow,
  attribution: OneShotFaultAttribution,
): OneShotFailureAttributionLabel {
  switch (attribution) {
    case "ticket":
      return "Ticket Not Ready";
    case "mixed":
      return "Mixed Issue";
    case "unknown":
      return "Needs Triage";
    case "oneshot":
      if (
        row.displayState === "qualification_failed" ||
        row.progressStage === "qualification"
      ) {
        return "Qualifier Error";
      }
      switch (row.progressStage) {
        case "planning":
          return "Planning Error";
        case "review":
          return "Review Error";
        case "implementation":
          return "Implementation Error";
        case "code_review":
          return "Code Review Error";
        case "testing":
          return "Testing Error";
        case "pr_complete":
          return "Run Failed";
      }
  }
}

function repoStageLabel(
  stage: Exclude<OneShotProgressStage, "pr_complete">,
): string {
  return STAGE_LABELS[stage];
}

function topRepoStageIssue(
  contexts: readonly StatisticsRowContext[],
): OneShotRepoStatusStageIssue | null {
  const issueContexts = contexts.filter(
    (ctx) =>
      (isFailed(ctx.row) || isNoAction(ctx.row)) &&
      ctx.row.progressStage !== "pr_complete",
  );
  if (issueContexts.length === 0) return null;
  const byStage = new Map<
    Exclude<OneShotProgressStage, "pr_complete">,
    { failed: number; noAction: number }
  >();
  for (const ctx of issueContexts) {
    const stage = ctx.row.progressStage;
    if (stage === "pr_complete") continue;
    const existing = byStage.get(stage) ?? { failed: 0, noAction: 0 };
    if (isFailed(ctx.row)) existing.failed += 1;
    if (isNoAction(ctx.row)) existing.noAction += 1;
    byStage.set(stage, existing);
  }
  const totalIssues = issueContexts.length;
  const [stage, counts] =
    Array.from(byStage.entries()).sort((a, b) => {
      const affectedA = a[1].failed + a[1].noAction;
      const affectedB = b[1].failed + b[1].noAction;
      return affectedB - affectedA || a[0].localeCompare(b[0]);
    })[0] ?? [];
  if (!stage || !counts) return null;
  const affected = counts.failed + counts.noAction;
  const shareOfRepoIssues = totalIssues === 0 ? 0 : affected / totalIssues;
  if (
    affected < REPO_STATUS_STAGE_CLUSTER_MIN_ISSUES ||
    shareOfRepoIssues < REPO_STATUS_STAGE_CLUSTER_SHARE
  ) {
    return null;
  }
  return {
    stage,
    label: repoStageLabel(stage),
    failed: counts.failed,
    noAction: counts.noAction,
    affected,
    shareOfRepoIssues,
  };
}

function topRepoFailureAttribution(
  contexts: readonly StatisticsRowContext[],
): OneShotRepoStatusFailureAttribution | null {
  const byAttribution = new Map<
    string,
    {
      attribution: OneShotFaultAttribution;
      errorCategory: OneShotFailureErrorCategory;
      label: OneShotFailureAttributionLabel;
      sampleSize: number;
    }
  >();
  for (const ctx of contexts) {
    if (!isFailed(ctx.row)) continue;
    const classification = classifyFailure({
      row: ctx.row,
      readinessTier: ctx.readiness.tier,
    });
    const label = repoStatusLabelForFailure(
      ctx.row,
      classification.attribution,
    );
    const key = `${classification.errorCategory}:${classification.attribution}:${label}`;
    const existing = byAttribution.get(key);
    if (existing) {
      existing.sampleSize += 1;
    } else {
      byAttribution.set(key, {
        attribution: classification.attribution,
        errorCategory: classification.errorCategory,
        label,
        sampleSize: 1,
      });
    }
  }
  return (
    Array.from(byAttribution.values()).sort(
      (a, b) => b.sampleSize - a.sampleSize || a.label.localeCompare(b.label),
    )[0] ?? null
  );
}

function repoStatusReason(input: {
  row: Pick<
    OneShotRepoStatusRow,
    | "status"
    | "isUnresolved"
    | "sampleSize"
    | "terminalCount"
    | "completed"
    | "failed"
    | "noAction"
    | "passRate"
    | "topStageIssue"
  >;
}): string {
  const { row } = input;
  if (row.isUnresolved) {
    return `${row.sampleSize} intake item${row.sampleSize === 1 ? "" : "s"} could not be tied to a repository; review the examples and qualifier reasons.`;
  }
  if (row.status === "insufficient_data") {
    return `${row.sampleSize} intake item${row.sampleSize === 1 ? "" : "s"} in this range; not enough terminal history for a repo-level claim.`;
  }
  if (row.topStageIssue) {
    return `${row.completed}/${row.terminalCount} completed; ${row.topStageIssue.affected} issue${row.topStageIssue.affected === 1 ? "" : "s"} concentrated in ${row.topStageIssue.label}.`;
  }
  if (row.status === "blocked") {
    return `${row.failed} failed out of ${row.terminalCount} terminal ticket${row.terminalCount === 1 ? "" : "s"} (${(row.passRate * 100).toFixed(1)}% pass).`;
  }
  if (row.status === "watch") {
    return `${row.completed}/${row.terminalCount} completed; pass rate is ${(row.passRate * 100).toFixed(1)}% and needs monitoring.`;
  }
  return `${row.completed}/${row.terminalCount} completed with no meaningful stage cluster.`;
}

function buildRepoStatus(input: {
  current: readonly StatisticsRowContext[];
  range: OneShotAnalyticsRange;
  generatedAt: string;
}): OneShotRepoStatusSummary {
  const groups = new Map<string, StatisticsRowContext[]>();
  for (const ctx of input.current) {
    const label = ctx.row.repoName?.trim() || "Unresolved repository";
    const key = ctx.row.repoName?.trim()
      ? `repo:${slug(label)}`
      : "repo:unresolved";
    const existing = groups.get(key);
    if (existing) {
      existing.push(ctx);
    } else {
      groups.set(key, [ctx]);
    }
  }

  const statusRows = Array.from(groups.entries()).map(([repoKey, contexts]) => {
    const label = contexts[0]?.row.repoName?.trim() || "Unresolved repository";
    const isUnresolved = !contexts[0]?.row.repoName?.trim();
    const rows = contexts.map((ctx) => ctx.row);
    const cohort = createTicketQualityCohort(contexts);
    const topStageIssue = topRepoStageIssue(contexts);
    const topFailureAttribution = topRepoFailureAttribution(contexts);
    const avgTokens =
      rows.length === 0
        ? 0
        : Math.round(
            rows.reduce(
              (sum, row) => sum + finiteNumber(row.totalTokensUsed),
              0,
            ) / rows.length,
          );
    const avgUsd =
      rows.length === 0
        ? 0
        : Number(
            (
              rows.reduce(
                (sum, row) => sum + finiteNumber(row.estimatedCostUsd),
                0,
              ) / rows.length
            ).toFixed(6),
          );
    const minStatusSampleSize = minSampleSize();
    let status: OneShotRepoStatusRow["status"];
    if (isUnresolved && contexts.length > 0) {
      status = "blocked";
    } else if (
      contexts.length < minStatusSampleSize ||
      cohort.terminalCount < REPO_STATUS_MIN_TERMINAL
    ) {
      status = "insufficient_data";
    } else if (cohort.passRate < REPO_STATUS_BLOCKED_PASS_RATE) {
      status = "blocked";
    } else if (topStageIssue || cohort.passRate < REPO_STATUS_HEALTHY_PASS_RATE) {
      status = "watch";
    } else {
      status = "healthy";
    }
    const rowWithoutReason = {
      repoKey,
      repoLabel: label,
      status,
      statusReason: "",
      isUnresolved,
      sampleSize: cohort.sampleSize,
      terminalCount: cohort.terminalCount,
      completed: cohort.completed,
      failed: cohort.failed,
      noAction: cohort.noAction,
      passRate: cohort.passRate,
      wilson95: cohort.wilson95,
      avgTokens,
      avgUsd,
      topStageIssue,
      topFailureAttribution,
      examples: examplesForContexts(contexts, 5),
    } satisfies OneShotRepoStatusRow;
    return {
      ...rowWithoutReason,
      statusReason: repoStatusReason({ row: rowWithoutReason }),
    };
  });

  const statusOrder: Record<OneShotRepoStatusRow["status"], number> = {
    blocked: 0,
    watch: 1,
    healthy: 2,
    insufficient_data: 3,
  };
  statusRows.sort(
    (a, b) =>
      Number(b.isUnresolved) - Number(a.isUnresolved) ||
      statusOrder[a.status] - statusOrder[b.status] ||
      b.sampleSize - a.sampleSize ||
      a.repoLabel.localeCompare(b.repoLabel),
  );

  return {
    range: input.range,
    generatedAt: input.generatedAt,
    statusVersion: REPO_STATUS_VERSION,
    rows: statusRows,
  };
}

function repoIdentityForContext(ctx: StatisticsRowContext): {
  repoKey: string;
  repoLabel: string;
  isUnresolved: boolean;
} {
  const label = ctx.row.repoName?.trim() || "Unresolved repository";
  return {
    repoKey: ctx.row.repoName?.trim() ? `repo:${slug(label)}` : "repo:unresolved",
    repoLabel: label,
    isUnresolved: !ctx.row.repoName?.trim(),
  };
}

function issueContexts(
  contexts: readonly StatisticsRowContext[],
): StatisticsRowContext[] {
  return contexts.filter((ctx) => isFailed(ctx.row) || isNoAction(ctx.row));
}

function costAndTokensForContexts(contexts: readonly StatisticsRowContext[]): {
  costUsd: number;
  tokens: number;
} {
  return {
    costUsd: Number(
      contexts
        .reduce((sum, ctx) => sum + finiteNumber(ctx.row.estimatedCostUsd), 0)
        .toFixed(6),
    ),
    tokens: contexts.reduce(
      (sum, ctx) => sum + finiteNumber(ctx.row.totalTokensUsed),
      0,
    ),
  };
}

function failureCategoryLabel(
  failure: OneShotOperationalBottleneckFailureAttribution,
): string {
  if (failure.attribution === "ticket" || failure.errorCategory === "ticket_quality") {
    return "Ticket Not Ready";
  }
  const labels: Record<OneShotFailureErrorCategory, string> = {
    git_operation: "Git Operation",
    llm_provider: "LLM Provider",
    llm_output: "LLM Output",
    s3_storage: "S3 Storage",
    db_operation: "Database Operation",
    workspace: "Workspace",
    github_api: "GitHub API",
    ticket_quality: "Ticket Quality",
    plan_validation: "Plan Validation",
    budget: "Budget",
    agent_logic: "Agent Logic",
    test_runner_skipped: "Test Runner",
    ci_failure: "CI Failure",
    unknown: "Needs Triage",
  };
  return labels[failure.errorCategory];
}

function failureCategoryNextStep(
  failure: OneShotOperationalBottleneckFailureAttribution,
): string {
  if (failure.attribution === "ticket") {
    return "Review the linked tickets for readiness gaps before rerunning.";
  }
  if (failure.attribution === "oneshot") {
    return "Inspect stage logs and provider, storage, or build evidence for these runs.";
  }
  return "Triage examples to separate ticket gaps from OneShot execution issues.";
}

function contextsForFailureCategory(
  contexts: readonly StatisticsRowContext[],
  failure: OneShotOperationalBottleneckFailureAttribution,
): StatisticsRowContext[] {
  return contexts.filter((ctx) => {
    if (!isFailed(ctx.row)) return false;
    const classification = classifyFailure({
      row: ctx.row,
      readinessTier: ctx.readiness.tier,
    });
    return (
      classification.attribution === failure.attribution &&
      classification.errorCategory === failure.errorCategory &&
      !classification.excludedFromDenominator
    );
  });
}

function stageBottleneckSeverity(
  affected: number,
): OneShotOperationalBottleneckSeverity {
  return affected >= minSampleSize() * 2 ? "high" : "medium";
}

function buildOperationalBottlenecks(input: {
  current: readonly StatisticsRowContext[];
  range: OneShotAnalyticsRange;
  generatedAt: string;
  repoStatus: OneShotRepoStatusSummary;
  failureAttribution: OneShotFailureAttributionSummary;
}): OneShotOperationalBottleneckSummary {
  const minN = minSampleSize();
  const claimMinN = claimMinSampleSize();
  const bottlenecks: OneShotOperationalBottleneckRow[] = [];
  const issues = issueContexts(input.current);
  const resolvedIssues = issues.filter((ctx) => ctx.row.repoName?.trim());
  const unresolvedRepo = input.repoStatus.rows.find((row) => row.isUnresolved);

  if (
    unresolvedRepo &&
    (unresolvedRepo.sampleSize >= minN ||
      unresolvedRepo.failed + unresolvedRepo.noAction > 0)
  ) {
    const unresolvedContexts = input.current.filter(
      (ctx) => !ctx.row.repoName?.trim(),
    );
    const { costUsd, tokens } = costAndTokensForContexts(unresolvedContexts);
    bottlenecks.push({
      id: "repo_resolution:unresolved",
      kind: "repo_resolution",
      severity: "high",
      title: "Unresolved repository routing",
      summary: `${unresolvedRepo.sampleSize} intake item${unresolvedRepo.sampleSize === 1 ? "" : "s"} could not be tied to a repository in this range.`,
      nextStep:
        "Review repo routing evidence for these tickets before guessing a target repository.",
      affected: unresolvedRepo.sampleSize,
      failed: unresolvedRepo.failed,
      noAction: unresolvedRepo.noAction,
      passRate: unresolvedRepo.passRate,
      wilson95: unresolvedRepo.wilson95,
      repoKey: unresolvedRepo.repoKey,
      repoLabel: unresolvedRepo.repoLabel,
      stage: unresolvedRepo.topStageIssue?.stage ?? null,
      stageLabel: unresolvedRepo.topStageIssue?.label ?? null,
      failureAttribution: unresolvedRepo.topFailureAttribution
        ? {
            attribution: unresolvedRepo.topFailureAttribution.attribution,
            errorCategory: unresolvedRepo.topFailureAttribution.errorCategory,
            label: unresolvedRepo.topFailureAttribution.label,
          }
        : null,
      costUsd,
      tokens,
      examples: unresolvedRepo.examples,
    });
  }

  const stageGroups = new Map<
    string,
    {
      stage: Exclude<OneShotProgressStage, "pr_complete">;
      repoKey: string | null;
      repoLabel: string | null;
      contexts: StatisticsRowContext[];
      repoIssueCount: number;
    }
  >();

  for (const ctx of issues) {
    const stage = ctx.row.progressStage;
    if (stage === "pr_complete") continue;
    const globalKey = `stage:${stage}`;
    const global = stageGroups.get(globalKey) ?? {
      stage,
      repoKey: null,
      repoLabel: null,
      contexts: [],
      repoIssueCount: issues.length,
    };
    global.contexts.push(ctx);
    stageGroups.set(globalKey, global);

    if (ctx.row.repoName?.trim()) {
      const repo = repoIdentityForContext(ctx);
      const repoIssues = resolvedIssues.filter(
        (other) => repoIdentityForContext(other).repoKey === repo.repoKey,
      );
      const repoKey = `${repo.repoKey}:stage:${stage}`;
      const scoped = stageGroups.get(repoKey) ?? {
        stage,
        repoKey: repo.repoKey,
        repoLabel: repo.repoLabel,
        contexts: [],
        repoIssueCount: repoIssues.length,
      };
      scoped.contexts.push(ctx);
      stageGroups.set(repoKey, scoped);
    }
  }

  for (const group of stageGroups.values()) {
    const affected = group.contexts.length;
    const shareOfRepoIssues =
      group.repoIssueCount === 0 ? 0 : affected / group.repoIssueCount;
    const isScoped = group.repoKey !== null;
    const qualifies =
      affected >= minN ||
      (isScoped &&
        affected >= REPO_STATUS_STAGE_CLUSTER_MIN_ISSUES &&
        shareOfRepoIssues >= REPO_STATUS_STAGE_CLUSTER_SHARE);
    if (!qualifies) continue;
    const cohort = createTicketQualityCohort(group.contexts);
    const { costUsd, tokens } = costAndTokensForContexts(group.contexts);
    const stageLabel = repoStageLabel(group.stage);
    const title = group.repoLabel
      ? `${stageLabel} cluster in ${group.repoLabel}`
      : `${stageLabel} stage cluster`;
    bottlenecks.push({
      id: group.repoKey
        ? `${group.repoKey}:stage_cluster:${group.stage}`
        : `stage_cluster:${group.stage}`,
      kind: "stage_cluster",
      severity: stageBottleneckSeverity(affected),
      title,
      summary: `${affected} failed or no-action item${affected === 1 ? "" : "s"} are concentrated in ${stageLabel}${group.repoLabel ? ` for ${group.repoLabel}` : ""}.`,
      nextStep: `Review ${stageLabel.toLowerCase()} evidence for the linked examples and compare with the repo status row.`,
      affected,
      failed: cohort.failed,
      noAction: cohort.noAction,
      passRate: cohort.passRate,
      wilson95: cohort.wilson95,
      repoKey: group.repoKey,
      repoLabel: group.repoLabel,
      stage: group.stage,
      stageLabel,
      failureAttribution: null,
      costUsd,
      tokens,
      examples: examplesForContexts(group.contexts, 5),
    });
  }

  for (const row of input.failureAttribution.byCategory) {
    if (!row.significant || row.sampleSize < claimMinN) continue;
    const failure = {
      attribution: row.attribution,
      errorCategory: row.errorCategory,
      label: failureCategoryLabel({
        attribution: row.attribution,
        errorCategory: row.errorCategory,
        label: "",
      }),
    };
    const contexts = contextsForFailureCategory(input.current, failure);
    const { costUsd, tokens } = costAndTokensForContexts(contexts);
    bottlenecks.push({
      id: `failure_category:${row.errorCategory}:${row.attribution}`,
      kind: "failure_category",
      severity: row.sampleSize >= claimMinN * 2 ? "high" : "medium",
      title: `${failure.label} failures`,
      summary: `${row.sampleSize} failed run${row.sampleSize === 1 ? "" : "s"} are associated with ${failure.label.toLowerCase()} in this range.`,
      nextStep: failureCategoryNextStep(failure),
      affected: row.sampleSize,
      failed: row.sampleSize,
      noAction: 0,
      passRate: row.passRateInCohort,
      wilson95: row.wilson95,
      repoKey: null,
      repoLabel: null,
      stage: null,
      stageLabel: null,
      failureAttribution: failure,
      costUsd,
      tokens,
      examples: row.examples,
    });
  }

  const wasteContexts = input.current.filter(
    (ctx) => isFailed(ctx.row) || isNoAction(ctx.row) || !ctx.row.repoName?.trim(),
  );
  const waste = costAndTokensForContexts(wasteContexts);
  if (
    wasteContexts.length >= minN &&
    (waste.costUsd >= COST_WASTE_USD_THRESHOLD ||
      waste.tokens >= COST_WASTE_TOKEN_THRESHOLD)
  ) {
    const cohort = createTicketQualityCohort(wasteContexts);
    const highWaste =
      waste.costUsd >= COST_WASTE_HIGH_USD_THRESHOLD ||
      waste.tokens >= COST_WASTE_HIGH_TOKEN_THRESHOLD;
    const rankedExamples = [...wasteContexts].sort(
      (a, b) =>
        finiteNumber(b.row.estimatedCostUsd) -
          finiteNumber(a.row.estimatedCostUsd) ||
        finiteNumber(b.row.totalTokensUsed) - finiteNumber(a.row.totalTokensUsed),
    );
    bottlenecks.push({
      id: "cost_waste:unsuccessful_intake",
      kind: "cost_waste",
      severity: highWaste ? "medium" : "low",
      title: "Spend on unsuccessful intake",
      summary: `${wasteContexts.length} failed, no-action, or unresolved intake item${wasteContexts.length === 1 ? "" : "s"} used ${waste.tokens.toLocaleString("en-US")} tokens and $${waste.costUsd.toFixed(2)}.`,
      nextStep:
        "Review high-spend examples before widening reruns or refreshing stale tickets.",
      affected: wasteContexts.length,
      failed: cohort.failed,
      noAction: cohort.noAction,
      passRate: cohort.passRate,
      wilson95: cohort.wilson95,
      repoKey: null,
      repoLabel: null,
      stage: null,
      stageLabel: null,
      failureAttribution: null,
      costUsd: waste.costUsd,
      tokens: waste.tokens,
      examples: examplesForContexts(rankedExamples, 5),
    });
  }

  const severityOrder: Record<OneShotOperationalBottleneckSeverity, number> = {
    high: 0,
    medium: 1,
    low: 2,
  };
  const deduped = new Map<string, OneShotOperationalBottleneckRow>();
  for (const row of bottlenecks) {
    const existing = deduped.get(row.id);
    if (!existing || row.affected > existing.affected) deduped.set(row.id, row);
  }
  const rows = Array.from(deduped.values())
    .sort(
      (a, b) =>
        Number(b.kind === "repo_resolution") -
          Number(a.kind === "repo_resolution") ||
        severityOrder[a.severity] - severityOrder[b.severity] ||
        b.affected - a.affected ||
        b.failed + b.noAction - (a.failed + a.noAction) ||
        b.costUsd - a.costUsd ||
        a.title.localeCompare(b.title),
    )
    .slice(0, MAX_OPERATIONAL_BOTTLENECKS);

  return {
    range: input.range,
    generatedAt: input.generatedAt,
    bottleneckVersion: OPERATIONAL_BOTTLENECK_VERSION,
    rows,
  };
}

function addBucket(
  map: Map<string, BucketAccumulator>,
  kind: OneShotStatisticsBucketKind,
  label: string,
  ctx: StatisticsRowContext,
  explicitKey = label,
): void {
  const id = `${kind}:${slug(explicitKey)}`;
  const existing = map.get(id);
  if (existing) {
    existing.rows.push(ctx);
    return;
  }
  map.set(id, { id, label, kind, rows: [ctx] });
}

function ticketFamily(ctx: StatisticsRowContext): string {
  const text = `${ctx.row.title}\n${ctx.taskText}`.toLowerCase();
  if (/(auth|login|saml|oauth|jwt|permission|security|role)/.test(text)) {
    return "Authentication and access control";
  }
  if (
    /(api|endpoint|rest|graphql|webhook|fhir|interop|integration)/.test(text)
  ) {
    return "API and integration changes";
  }
  if (/(dashboard|ui|screen|modal|button|page|frontend|css)/.test(text)) {
    return "Dashboard and UI changes";
  }
  if (/(sql|database|query|table|report|etl|analytics|data)/.test(text)) {
    return "Data, reporting, and SQL work";
  }
  if (/(queue|worker|batch|job|scheduler|workflow|pipeline)/.test(text)) {
    return "Workflow and worker automation";
  }
  if (/(deploy|terraform|config|environment|secret|helm|ecs)/.test(text)) {
    return "Configuration and deployment changes";
  }
  return "General product changes";
}

function buildBuckets(contexts: readonly StatisticsRowContext[]): {
  buckets: OneShotStatisticsBucket[];
  contextsByBucketId: Map<string, readonly StatisticsRowContext[]>;
} {
  const map = new Map<string, BucketAccumulator>();
  for (const ctx of contexts) {
    addBucket(map, "repo", ctx.row.repoName || "Unresolved repository", ctx);
    if (ctx.row.progressStage !== "pr_complete") {
      addBucket(
        map,
        "stage",
        STAGE_LABELS[ctx.row.progressStage],
        ctx,
        ctx.row.progressStage,
      );
    }
    addBucket(map, "ticket_family", ticketFamily(ctx), ctx);
    addBucket(
      map,
      "ticket_readiness",
      TIER_LABELS[ctx.readiness.tier],
      ctx,
      ctx.readiness.tier,
    );
    addBucket(
      map,
      "template_fit",
      TEMPLATE_FIT_LABELS[ctx.readiness.templateFit],
      ctx,
      ctx.readiness.templateFit,
    );
    for (const signal of ctx.readiness.missingSignals) {
      addBucket(
        map,
        "missing_signal",
        `Missing ${SIGNAL_LABELS[signal].toLowerCase()}`,
        ctx,
        signal,
      );
    }
    if (isFailed(ctx.row)) {
      const parsed = parseErrorSummary(
        buildFailureClassificationMessage(ctx.row) || "Unknown error",
      );
      addBucket(
        map,
        "error_class",
        parsed.heading,
        ctx,
        clusterSignature(parsed),
      );
    }
  }

  const contextsByBucketId = new Map<string, readonly StatisticsRowContext[]>();
  const buckets = Array.from(map.values())
    .map((bucket) => {
      const rows = bucket.rows.map((ctx) => ctx.row);
      const completed = rows.filter(isCompleted).length;
      const failed = rows.filter(isFailed).length;
      const noAction = rows.filter(isNoAction).length;
      const completedAndFailed = completed + failed;
      contextsByBucketId.set(bucket.id, bucket.rows.slice());
      return {
        id: bucket.id,
        label: bucket.label,
        kind: bucket.kind,
        sampleSize: rows.length,
        completed,
        failed,
        noAction,
        passRate: completedAndFailed === 0 ? 0 : completed / completedAndFailed,
        avgTokens:
          rows.length === 0
            ? 0
            : Math.round(
                rows.reduce(
                  (sum, row) => sum + finiteNumber(row.totalTokensUsed),
                  0,
                ) / rows.length,
              ),
        avgUsd:
          rows.length === 0
            ? 0
            : Number(
                (
                  rows.reduce(
                    (sum, row) => sum + finiteNumber(row.estimatedCostUsd),
                    0,
                  ) / rows.length
                ).toFixed(6),
              ),
        examples: rows.slice(0, MAX_EXAMPLES_PER_BUCKET).map(exampleForRow),
      };
    })
    .sort((a, b) => b.sampleSize - a.sampleSize || a.id.localeCompare(b.id));
  return { buckets, contextsByBucketId };
}

const STRATIFY_BUCKET_KINDS: ReadonlySet<OneShotStatisticsBucketKind> = new Set(
  [
    "ticket_family",
    "ticket_readiness",
    "template_fit",
    "missing_signal",
    "error_class",
  ],
);
const STRATIFY_MIN_GROUPS = 2;
const STRATIFY_MIN_TERMINAL = 4;
const INSIGHT_CAP = 3;

function wilsonLower(passRate: number, terminal: number): number {
  if (terminal <= 0) return 0;
  const successes = Math.round(passRate * terminal);
  return wilsonInterval(successes, terminal)?.low ?? 0;
}

function wilsonUpper(passRate: number, terminal: number): number {
  if (terminal <= 0) return 1;
  const successes = Math.round(passRate * terminal);
  return wilsonInterval(successes, terminal)?.high ?? 1;
}

function passRateOf(rows: readonly OneShotDashboardRow[]): {
  passRate: number;
  terminal: number;
} {
  const completed = rows.filter(isCompleted).length;
  const failed = rows.filter(isFailed).length;
  const terminal = completed + failed;
  return {
    passRate: terminal === 0 ? 0 : completed / terminal,
    terminal,
  };
}

function survivesStratification(args: {
  contexts: readonly StatisticsRowContext[];
  direction: "above" | "below";
  overallPassRate: number;
}): boolean {
  const { contexts, direction, overallPassRate } = args;
  const groups = new Map<string, StatisticsRowContext[]>();
  for (const ctx of contexts) {
    const repo = ctx.row.repoName || "unresolved";
    const stage = ctx.row.progressStage;
    const key = `${repo}::${stage}`;
    const list = groups.get(key) ?? [];
    list.push(ctx);
    groups.set(key, list);
  }
  if (groups.size < STRATIFY_MIN_GROUPS) {
    return true;
  }
  const dominant = Array.from(groups.values()).reduce(
    (best, group) => (group.length > best.length ? group : best),
    [] as StatisticsRowContext[],
  );
  const { passRate, terminal } = passRateOf(dominant.map((ctx) => ctx.row));
  if (terminal < STRATIFY_MIN_TERMINAL) {
    return true;
  }
  return direction === "above"
    ? wilsonLower(passRate, terminal) > overallPassRate
    : wilsonUpper(passRate, terminal) < overallPassRate;
}

function deterministicInsights(
  buckets: readonly OneShotStatisticsBucket[],
  contextsByBucketId: ReadonlyMap<string, readonly StatisticsRowContext[]>,
  overallPassRate: number,
  requiredSampleSize: number,
): {
  workingWell: OneShotStatisticsInsight[];
  needsImprovement: OneShotStatisticsInsight[];
} {
  const eligible = buckets.filter(
    (bucket) => bucket.sampleSize >= requiredSampleSize,
  );

  const promote = (direction: "above" | "below"): OneShotStatisticsBucket[] => {
    return eligible.filter((bucket) => {
      const terminal = bucket.completed + bucket.failed;
      if (terminal < STRATIFY_MIN_TERMINAL) return false;
      if (direction === "above" && bucket.completed === 0) return false;
      if (direction === "below" && bucket.failed === 0) return false;
      const wilsonPasses =
        direction === "above"
          ? wilsonLower(bucket.passRate, terminal) > overallPassRate
          : wilsonUpper(bucket.passRate, terminal) < overallPassRate;
      if (!wilsonPasses) return false;
      if (!STRATIFY_BUCKET_KINDS.has(bucket.kind)) return true;
      const contexts = contextsByBucketId.get(bucket.id) ?? [];
      return survivesStratification({
        contexts,
        direction,
        overallPassRate,
      });
    });
  };

  const workingWell = promote("above")
    .sort((a, b) => {
      const aLow = wilsonLower(a.passRate, a.completed + a.failed);
      const bLow = wilsonLower(b.passRate, b.completed + b.failed);
      return bLow - aLow || b.sampleSize - a.sampleSize;
    })
    .slice(0, INSIGHT_CAP)
    .map((bucket) => {
      const terminal = bucket.completed + bucket.failed;
      const low = wilsonLower(bucket.passRate, terminal);
      return {
        id: `working:${bucket.id}`,
        bucketId: bucket.id,
        title: `${bucket.label} is performing well`,
        summary: `${bucket.completed} completed out of ${terminal} terminal tickets.`,
        reason:
          "Pass-rate gap remains above the selected-window baseline after sample-size and repo/stage checks.",
        sampleSize: bucket.sampleSize,
        passRate: bucket.passRate,
        confidence: Math.min(0.95, 0.6 + low * 0.4),
        examples: bucket.examples,
      };
    });

  const needsImprovement = promote("below")
    .sort((a, b) => {
      const aHigh = wilsonUpper(a.passRate, a.completed + a.failed);
      const bHigh = wilsonUpper(b.passRate, b.completed + b.failed);
      return aHigh - bHigh || b.failed - a.failed;
    })
    .slice(0, INSIGHT_CAP)
    .map((bucket) => {
      const terminal = bucket.completed + bucket.failed;
      const high = wilsonUpper(bucket.passRate, terminal);
      return {
        id: `needs:${bucket.id}`,
        bucketId: bucket.id,
        title: `${bucket.label} needs attention`,
        summary: `${bucket.failed} failed out of ${terminal} terminal tickets.`,
        reason:
          "Pass-rate gap remains below the selected-window baseline after sample-size and repo/stage checks.",
        sampleSize: bucket.sampleSize,
        passRate: bucket.passRate,
        confidence: Math.min(0.95, 0.6 + (1 - high) * 0.4),
        examples: bucket.examples,
      };
    });

  return { workingWell, needsImprovement };
}

function buildFailureAttribution(
  current: readonly StatisticsRowContext[],
  overallPassRate: number,
  minSignificantSize: number,
): OneShotFailureAttributionSummary {
  const classifications = current
    .filter((ctx) => isFailed(ctx.row))
    .map((ctx) => ({
      classification: classifyFailure({
        row: ctx.row,
        readinessTier: ctx.readiness.tier,
      }),
      row: ctx.row,
      example: exampleForRow(ctx.row),
    }));
  return summarizeFailureAttribution({
    classifications,
    overallPassRate,
    minSignificantSize,
    wilsonInterval,
  });
}

function deterministicBusinessMetrics(
  scorecard: OneShotStatisticsScorecard,
  current: readonly StatisticsRowContext[],
  prior: readonly StatisticsRowContext[] | null,
): OneShotStatisticsBusinessMetric[] {
  const p50Hours = scorecard.p50TimeToPrMs / HOUR_MS;
  return [
    {
      id: "pass-rate",
      title: "Pass rate",
      summary: `${(scorecard.passRate * 100).toFixed(1)}% of terminal tickets completed successfully.`,
      delta: scorecard.deltas.passRate,
    },
    {
      id: "completed",
      title: "Completions",
      summary: `${scorecard.completed} ticket${scorecard.completed === 1 ? "" : "s"} reached PR-open or completed state.`,
      delta: scorecard.deltas.completed,
    },
    {
      id: "failed",
      title: "Failures",
      summary: `${scorecard.failed} ticket${scorecard.failed === 1 ? "" : "s"} ended in a failed terminal state.`,
      delta: scorecard.deltas.failed,
    },
    {
      id: "time-to-pr",
      title: "Time to PR",
      summary:
        scorecard.p50TimeToPrMs === 0
          ? "No completed ticket has a measurable PR duration yet."
          : `Median time to PR is ${p50Hours.toFixed(p50Hours < 10 ? 1 : 0)} hours.`,
      delta: scorecard.deltas.p50TimeToPrMs,
    },
    {
      id: "intake",
      title: "Intake volume",
      summary: `${scorecard.intake} tickets entered the OneShot funnel in this window.`,
      delta: scorecard.deltas.intake,
    },
    {
      id: "cost",
      title: "LLM spend",
      summary: `$${scorecard.totalUsd.toFixed(2)} estimated spend across ${scorecard.totalTokens.toLocaleString()} tokens.`,
      delta: scorecard.deltas.totalUsd,
    },
    {
      id: "tokens",
      title: "Token volume",
      summary: `${scorecard.totalTokens.toLocaleString()} tokens were recorded for this window.`,
      delta: scorecard.deltas.totalTokens,
    },
    {
      id: "ticket-readiness",
      title: "Ticket readiness",
      summary: `Average intake readiness score is ${averageReadinessScore(current).toFixed(1)} on the v1.0 rubric.`,
      delta: scoreDelta(current, prior),
    },
  ];
}

function deterministicActions(
  needsImprovement: readonly OneShotStatisticsInsight[],
  ticketQuality: OneShotTicketQualityAnalysis,
): OneShotStatisticsAction[] {
  const qualityAction = ticketQuality.stratifiedReadinessGap
    .qualifiesForRecommendation
    ? [
        {
          id: "ticket-quality-template-investigation",
          priority: "medium" as const,
          title: "Investigate ticket readiness patterns",
          summary:
            ticketQuality.stratifiedReadinessGap.recommendationSummary ??
            "Weak ticket descriptions are associated with lower pass rates after stratification; review template adherence in the dominant repos or stages.",
          bucketId: null,
          examples:
            ticketQuality.stratifiedReadinessGap.weak.sampleSize > 0
              ? (ticketQuality.readinessDistribution.find(
                  (bucket) => bucket.id === "weak",
                )?.examples ?? [])
              : [],
        },
      ]
    : [];

  if (needsImprovement.length === 0) {
    return [
      ...qualityAction,
      {
        id: "monitor-volume",
        priority: "low",
        title: "Keep monitoring ticket mix",
        summary:
          "No high-sample weak bucket is visible in this window; keep the Statistics tab refreshed as intake grows.",
        bucketId: null,
        examples: [],
      },
    ];
  }

  return [
    ...qualityAction,
    ...needsImprovement.slice(0, 4).map((insight, index) => ({
      id: `action:${insight.bucketId}`,
      priority: index === 0 ? ("high" as const) : ("medium" as const),
      title: `Improve ${insight.title.replace(/ needs attention$/i, "")}`,
      summary: `Review the representative tickets and stage/error evidence for ${insight.title.toLowerCase()}.`,
      bucketId: insight.bucketId,
      examples: insight.examples,
    })),
  ];
}

function applyLlmOutput(
  deterministic: OneShotStatisticsResponse,
  llm: LlmStatisticsOutput,
): OneShotStatisticsResponse {
  const bucketsById = new Map(
    deterministic.buckets.map((bucket) => [bucket.id, bucket]),
  );
  const decorateInsight = (
    item: z.infer<typeof LlmInsightSchema>,
    prefix: "working" | "needs",
  ): OneShotStatisticsInsight | null => {
    const bucket = bucketsById.get(item.bucketId);
    if (!bucket || bucket.sampleSize < deterministic.minSampleSize) {
      return null;
    }
    return {
      id: `${prefix}:${bucket.id}`,
      bucketId: bucket.id,
      title: item.title,
      summary: item.summary,
      reason: item.reason,
      sampleSize: bucket.sampleSize,
      passRate: bucket.passRate,
      confidence: item.confidence,
      examples: bucket.examples,
    };
  };

  const workingWell = llm.workingWell
    .map((item) => decorateInsight(item, "working"))
    .filter((item): item is OneShotStatisticsInsight => item !== null);
  const needsImprovement = llm.needsImprovement
    .map((item) => decorateInsight(item, "needs"))
    .filter((item): item is OneShotStatisticsInsight => item !== null);
  const llmMetricsById = new Map(
    llm.businessMetrics.map((metric) => [metric.id, metric]),
  );

  return {
    ...deterministic,
    summary: llm.summary,
    workingWell:
      workingWell.length > 0 ? workingWell : deterministic.workingWell,
    needsImprovement:
      needsImprovement.length > 0
        ? needsImprovement
        : deterministic.needsImprovement,
    businessMetrics:
      llm.businessMetrics.length > 0
        ? deterministic.businessMetrics.map((metric) => {
            const llmMetric = llmMetricsById.get(metric.id);
            return llmMetric
              ? {
                  ...metric,
                  title: llmMetric.title,
                  summary: llmMetric.summary,
                }
              : metric;
          })
        : deterministic.businessMetrics,
    recommendedActions:
      llm.recommendedActions.length > 0
        ? llm.recommendedActions.map((action) => {
            const bucket = action.bucketId
              ? bucketsById.get(action.bucketId)
              : null;
            return {
              id: action.id,
              priority: action.priority,
              title: action.title,
              summary: action.summary,
              bucketId: bucket?.id ?? null,
              examples: bucket?.examples ?? [],
            };
          })
        : deterministic.recommendedActions,
    failureAttributionNarrative:
      llm.failureAttributionNarrative ??
      deterministic.failureAttributionNarrative,
    templateFitNarrative:
      llm.templateFitNarrative ?? deterministic.templateFitNarrative,
  };
}

export function buildDeterministicStatisticsResponse(input: {
  rows: readonly OneShotDashboardRow[];
  taskTextByTaskId?: ReadonlyMap<number, TaskTextSnapshot>;
  range: OneShotAnalyticsRange;
  now?: Date;
  priorAllTimeScorecard?: OneShotStatisticsScorecard | null;
  status?: OneShotStatisticsResponse["status"];
  refreshing?: boolean;
  lastError?: string | null;
  dataFingerprint?: string;
}): OneShotStatisticsResponse {
  const now = input.now ?? new Date();
  const nowMs = now.getTime();
  const contexts = input.rows.map((row) => {
    const snapshot = input.taskTextByTaskId?.get(row.sourceTaskManagementId);
    const taskText = snapshot?.taskDescription ?? row.title;
    const qualifierOutcome =
      row.qualifierOutcome ?? snapshot?.qualifierOutcome ?? null;
    return {
      row,
      taskText,
      timestampMs: parseDateMs(row.createdAt),
      readiness: scoreTicketReadiness({
        title: row.title,
        taskDescription: taskText,
        qualifierOutcome,
      }),
    };
  });
  const current = currentContextsForRange(contexts, input.range, nowMs);
  const prior =
    input.range === "all"
      ? null
      : priorContextsForRange(contexts, input.range, nowMs);
  const currentScorecard = createScorecard({ rows: current });
  const priorScorecard =
    input.range === "all"
      ? (input.priorAllTimeScorecard ?? null)
      : createScorecard({ rows: prior ?? [] });
  const scorecard = scorecardWithDeltas(currentScorecard, priorScorecard);
  const { buckets, contextsByBucketId } = buildBuckets(current);
  const ticketQuality = buildTicketQualityAnalysis(current);
  const repoStatus = buildRepoStatus({
    current,
    range: input.range,
    generatedAt: now.toISOString(),
  });
  const sampleSize = claimMinSampleSize();
  const selfFixSampleSize = selfFixMinSampleSize();
  const { workingWell, needsImprovement } = deterministicInsights(
    buckets,
    contextsByBucketId,
    scorecard.passRate,
    sampleSize,
  );
  const failureAttribution = buildFailureAttribution(
    current,
    scorecard.passRate,
    selfFixSampleSize,
  );
  const selfFixCandidates = buildOneShotSelfFixCandidates({
    range: input.range,
    failureAttribution,
    passRateBaseline: scorecard.passRate,
  });
  const operationalBottlenecks = buildOperationalBottlenecks({
    current,
    range: input.range,
    generatedAt: now.toISOString(),
    repoStatus,
    failureAttribution,
  });
  const fingerprint =
    input.dataFingerprint ??
    fingerprintStatisticsInput({
      range: input.range,
      scorecard:
        input.range === "all"
          ? {
              ...scorecard,
              deltas: {
                intake: null,
                passRate: null,
                completed: null,
                failed: null,
                totalUsd: null,
                totalTokens: null,
                p50TimeToPrMs: null,
              },
            }
          : scorecard,
      buckets,
      ticketQualitySeed: {
        rubricVersion: READINESS_RUBRIC.rubricVersion,
        detectionPatternsVersion: READINESS_RUBRIC.detectionPatternsVersion,
        scores: current.map((ctx) => ({
          dashboardId: ctx.row.dashboardId,
          score: ctx.readiness.score,
          tier: ctx.readiness.tier,
          templateFit: ctx.readiness.templateFit,
          sourceTextSha: ctx.readiness.sourceTextSha,
        })),
      },
      versions: {
        promptVersion: STATISTICS_PROMPT_VERSION,
        attributionVersion: FAILURE_ATTRIBUTION_VERSION,
        repoStatusVersion: REPO_STATUS_VERSION,
        operationalBottleneckVersion: OPERATIONAL_BOTTLENECK_VERSION,
      },
      repoStatusSeed: {
        statusVersion: repoStatus.statusVersion,
        rows: repoStatus.rows.map((row) => ({
          repoKey: row.repoKey,
          status: row.status,
          sampleSize: row.sampleSize,
          completed: row.completed,
          failed: row.failed,
          noAction: row.noAction,
          passRate: row.passRate,
          topStageIssue: row.topStageIssue
            ? {
                stage: row.topStageIssue.stage,
                affected: row.topStageIssue.affected,
              }
            : null,
          topFailureAttribution: row.topFailureAttribution
            ? {
                attribution: row.topFailureAttribution.attribution,
                errorCategory: row.topFailureAttribution.errorCategory,
                sampleSize: row.topFailureAttribution.sampleSize,
              }
            : null,
        })),
      },
      operationalBottleneckSeed: {
        bottleneckVersion: operationalBottlenecks.bottleneckVersion,
        rows: operationalBottlenecks.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          severity: row.severity,
          affected: row.affected,
          failed: row.failed,
          noAction: row.noAction,
          passRate: row.passRate,
          repoKey: row.repoKey,
          stage: row.stage,
          failureAttribution: row.failureAttribution
            ? {
                attribution: row.failureAttribution.attribution,
                errorCategory: row.failureAttribution.errorCategory,
              }
            : null,
          costUsd: row.costUsd,
          tokens: row.tokens,
        })),
      },
      selfFixSeed: {
        minSampleSize: selfFixSampleSize,
        candidates: selfFixCandidates.map((candidate) => ({
          id: candidate.id,
          category: candidate.category,
          sampleSize: candidate.sampleSize,
          significant: candidate.significant,
        })),
      },
      rowVersions: current.map((ctx) => ({
        dashboardId: ctx.row.dashboardId,
        updatedAt: ctx.row.updatedAt,
      })),
    });

  return {
    status: input.status ?? "deterministic_only",
    range: input.range,
    window: getStatisticsWindow(input.range),
    summary:
      current.length === 0
        ? "No OneShot intake is present in this window yet."
        : `OneShot processed ${scorecard.intake} intake item${scorecard.intake === 1 ? "" : "s"} with a ${(scorecard.passRate * 100).toFixed(1)}% terminal pass rate.`,
    scorecard,
    buckets,
    workingWell,
    needsImprovement,
    businessMetrics: deterministicBusinessMetrics(scorecard, current, prior),
    ticketQuality,
    repoStatus,
    operationalBottlenecks,
    recommendedActions: deterministicActions(needsImprovement, ticketQuality),
    failureAttribution,
    selfFixCandidates,
    selfFixConfig: getOneShotSelfFixConfig(),
    minSampleSize: sampleSize,
    modelInfo: {
      provider: null,
      model: null,
      generatedAt: null,
      expiresAt: null,
      nextRefreshAt: null,
      dataFingerprint: fingerprint,
      refreshing: input.refreshing ?? false,
      lastError: publicStatisticsLastError(input.lastError),
      promptVersion: 0,
    },
  };
}

export function fingerprintStatisticsInput(value: unknown): string {
  return createHash("sha1").update(JSON.stringify(value)).digest("hex");
}

function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("LLM response did not contain a JSON object");
  }
  return trimmed.slice(start, end + 1);
}

function parseLlmStatisticsJson(text: string): unknown {
  let candidate: string;
  try {
    candidate = extractJsonObject(text);
  } catch (extractError) {
    const message =
      extractError instanceof Error ? extractError.message : String(extractError);
    throw new Error(`LLM statistics JSON could not be parsed: ${message}`);
  }
  try {
    return JSON.parse(candidate) as unknown;
  } catch (directError) {
    try {
      return JSON.parse(jsonrepair(candidate)) as unknown;
    } catch {
      const message =
        directError instanceof Error ? directError.message : String(directError);
      throw new Error(`LLM statistics JSON could not be parsed: ${message}`);
    }
  }
}

function outputSample(text: string): string {
  return text.slice(0, LLM_OUTPUT_SAMPLE_CHARS);
}

function publicStatisticsLastError(
  error: string | null | undefined,
): string | null {
  if (!error) return null;
  if (
    /LLM statistics JSON (?:could not be parsed|failed schema validation)/i.test(
      error,
    ) ||
    /LLM statistics response was truncated/i.test(error)
  ) {
    return AI_REFRESH_FAILURE_MESSAGE;
  }
  return error;
}

function statisticsLlmConfig(): {
  provider: string;
  model: string;
  region: string;
} {
  return {
    provider: "bedrock_runtime",
    model:
      process.env.ONESHOT_STATISTICS_LLM_MODEL_ID?.trim() ||
      process.env.ANTHROPIC_MODEL?.trim() ||
      process.env.BEDROCK_MODEL?.trim() ||
      process.env.BEDROCK_MODEL_ID?.trim() ||
      "us.anthropic.claude-sonnet-4-6",
    region: process.env.AWS_REGION?.trim() || "us-east-2",
  };
}

async function runStatisticsLlm(
  deterministic: OneShotStatisticsResponse,
): Promise<{ output: LlmStatisticsOutput; provider: string; model: string }> {
  const config = statisticsLlmConfig();
  // PHI-safety: redactBucketForLlm strips example.title and any other free
  // text. The LLM sees Jira keys + numeric metrics only.
  const buckets = deterministic.buckets
    .filter((bucket) => bucket.sampleSize >= deterministic.minSampleSize)
    .sort((a, b) => b.sampleSize - a.sampleSize)
    .slice(0, MAX_LLM_BUCKETS)
    .map(redactBucketForLlm);
  const redactedTicketQuality = redactTicketQualityForLlm(
    deterministic.ticketQuality,
  );
  const redactedRepoStatus = redactRepoStatusForLlm(deterministic.repoStatus);
  const redactedOperationalBottlenecks =
    redactOperationalBottlenecksForLlm(deterministic.operationalBottlenecks);
  const redactedFailureAttribution = deterministic.failureAttribution
    ? redactFailureAttributionForLlm(deterministic.failureAttribution)
    : undefined;
  const body = {
    anthropic_version: "bedrock-2023-05-31",
    max_tokens: configuredNumber(
      "ONESHOT_STATISTICS_LLM_MAX_TOKENS",
      DEFAULT_STATISTICS_LLM_MAX_TOKENS,
    ),
    temperature: 0,
    system: [
      "You analyze OneShot delivery statistics for operators.",
      "Return one JSON object only. No markdown.",
      "Use only the supplied deterministic bucket ids. Do not invent bucket ids or category labels.",
      "Describe ticket-quality relationships as associated with outcomes, never as causes or drivers.",
      "Do not use the words causes, caused, causal, drives, or driven.",
      "Do not make directive recommendations about human ticket-writing behavior. If the deterministic stratified check qualifies, phrase it as an investigation.",
      `Only make working-well or needs-improvement claims for buckets with sampleSize >= ${deterministic.minSampleSize}.`,
      "When discussing failures, attribute using only the supplied failureAttribution.byCategory[*].attribution field. Do not re-classify any failure.",
      "Do not mention any bucket or signal whose significant flag is false.",
      "failureAttributionNarrative is optional prose only. It must never include numbers; the numbers belong to the deterministic failureAttribution payload.",
      "templateFitNarrative is optional prose only and must mirror the supplied templateFit shares without proposing template changes.",
      "repoStatus is deterministic evidence from previous stored runs in the selected range. You may summarize it as observed repo-level status, but do not invent repository labels.",
      "operationalBottlenecks is deterministic evidence from previous stored runs in the selected range. You may summarize only supplied bottleneck IDs, labels, and next steps; do not invent root causes, repo labels, or causal recommendations.",
      "You see Jira keys, controlled-vocabulary labels, and numeric metrics only — no ticket titles, error summaries, or free-text reasons. If you reference a ticket, use only its Jira key.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: JSON.stringify({
              range: deterministic.range,
              scorecard: deterministic.scorecard,
              buckets,
              ticketQuality: redactedTicketQuality,
              repoStatus: redactedRepoStatus,
              operationalBottlenecks: redactedOperationalBottlenecks,
              failureAttribution: redactedFailureAttribution,
              requiredShape: {
                summary: "string",
                workingWell:
                  "array of {bucketId,title,summary,reason,confidence}",
                needsImprovement:
                  "array of {bucketId,title,summary,reason,confidence}",
                businessMetrics: "array of {id,title,summary}",
                recommendedActions:
                  "array of {id,priority,title,summary,bucketId|null}",
                failureAttributionNarrative:
                  "optional {summary,oneshotPatterns:[],ticketPatterns:[]}",
                templateFitNarrative: "optional string",
              },
            }),
          },
        ],
      },
    ],
  };

  const client = new BedrockRuntimeClient({ region: config.region });
  const response = await client.send(
    new InvokeModelCommand({
      modelId: config.model,
      contentType: "application/json",
      accept: "application/json",
      body: Buffer.from(JSON.stringify(body)),
    }),
  );
  const payload = JSON.parse(new TextDecoder().decode(response.body)) as {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string | null;
  };
  const text = (payload.content || [])
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (payload.stop_reason === "max_tokens") {
    const truncated = new Error(
      "LLM statistics response was truncated before valid JSON was returned (stop_reason=max_tokens).",
    );
    (truncated as Error & { outputSample?: string }).outputSample =
      outputSample(text) || "[empty max_tokens response]";
    throw truncated;
  }
  let parsed: unknown;
  try {
    parsed = parseLlmStatisticsJson(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const invalid = new Error(message);
    (invalid as Error & { outputSample?: string }).outputSample =
      outputSample(text);
    throw invalid;
  }
  const result = LlmStatisticsSchema.safeParse(parsed);
  if (!result.success) {
    const error = new Error(
      `LLM statistics JSON failed schema validation: ${result.error.message}`,
    );
    (error as Error & { outputSample?: string }).outputSample =
      outputSample(text);
    throw error;
  }
  return {
    output: result.data,
    provider: config.provider,
    model: config.model,
  };
}

/**
 * Dev-only: invoke Bedrock against an already-built deterministic response,
 * merge the LLM narrative back in, and return a ready-to-render response.
 *
 * Bypasses the snapshot table, lease state, and refresh-state writes entirely.
 * Intended for local visual inspection of the AI layer when running with
 * ONESHOT_DASHBOARD_USE_DEV_MOCK=1; never call this on prod paths.
 */
export async function runStatisticsLlmOverDeterministic(
  deterministic: OneShotStatisticsResponse,
): Promise<OneShotStatisticsResponse> {
  const llm = await runStatisticsLlm(deterministic);
  const generatedAt = new Date().toISOString();
  return {
    ...applyLlmOutput(deterministic, llm.output),
    status: "ready",
    modelInfo: {
      provider: llm.provider,
      model: llm.model,
      generatedAt,
      expiresAt: null,
      nextRefreshAt: null,
      dataFingerprint: deterministic.modelInfo.dataFingerprint,
      refreshing: false,
      lastError: null,
      promptVersion: STATISTICS_PROMPT_VERSION,
    },
  };
}

function parseTaskQualifierOutcome(
  value: unknown,
): { acceptanceCriteriaPresent?: boolean } | null {
  const raw =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const outcome =
    record.qualifierOutcome &&
    typeof record.qualifierOutcome === "object" &&
    !Array.isArray(record.qualifierOutcome)
      ? (record.qualifierOutcome as Record<string, unknown>)
      : record;
  return typeof outcome.acceptanceCriteriaPresent === "boolean"
    ? { acceptanceCriteriaPresent: outcome.acceptanceCriteriaPresent }
    : null;
}

async function fetchTaskTextByTaskId(
  rows: readonly OneShotDashboardRow[],
): Promise<Map<number, TaskTextSnapshot>> {
  const ids = Array.from(
    new Set(
      rows.map((row) => row.sourceTaskManagementId).filter((id) => id > 0),
    ),
  );
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const [taskRows] = await getPool().query<TaskTextRow[]>(
    `SELECT tm.id AS task_management_id, t.task_description, t.metrics_json
     FROM task_management tm
     LEFT JOIN tasks t
       ON t.id = tm.task_id
     WHERE tm.id IN (${placeholders})`,
    ids,
  );
  return new Map(
    taskRows.map((row) => [
      Number(row.task_management_id),
      {
        taskDescription: row.task_description ?? "",
        qualifierOutcome: parseTaskQualifierOutcome(row.metrics_json),
      },
    ]),
  );
}

async function latestReadySnapshots(
  range: OneShotAnalyticsRange,
  limit = 2,
): Promise<SnapshotRow[]> {
  const [rows] = await getPool().query<SnapshotRow[]>(
    `SELECT id, range_key, data_fingerprint, status, snapshot_json, provider, model,
            generated_at, expires_at, error_message
     FROM oneshot_statistics_snapshots
     WHERE range_key = ?
       AND status = 'ready'
     ORDER BY generated_at DESC, id DESC
     LIMIT ?`,
    [range, limit],
  );
  return rows;
}

async function latestRefreshState(
  range: OneShotAnalyticsRange,
): Promise<RefreshStateRow | null> {
  const [rows] = await getPool().query<RefreshStateRow[]>(
    `SELECT range_key, latest_snapshot_id, refresh_started_at, refresh_lease_expires_at,
            next_retry_at, last_error
     FROM oneshot_statistics_refresh_state
     WHERE range_key = ?
     LIMIT 1`,
    [range],
  );
  return rows[0] ?? null;
}

async function ensureRefreshState(range: OneShotAnalyticsRange): Promise<void> {
  await getPool().execute(
    `INSERT IGNORE INTO oneshot_statistics_refresh_state (range_key)
     VALUES (?)`,
    [range],
  );
}

export async function claimStatisticsRefreshLease(
  range: OneShotAnalyticsRange,
): Promise<boolean> {
  await ensureRefreshState(range);
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `UPDATE oneshot_statistics_refresh_state
     SET refresh_started_at = NOW(3),
         refresh_lease_expires_at = DATE_ADD(NOW(3), INTERVAL ? SECOND),
         attempt_count = attempt_count + 1,
         last_attempt_at = NOW(3),
         last_error = NULL
     WHERE range_key = ?
       AND (refresh_lease_expires_at IS NULL OR refresh_lease_expires_at < NOW(3))
       AND (next_retry_at IS NULL OR next_retry_at <= NOW(3))`,
    [REFRESH_LEASE_SECONDS, range],
  );
  return result.affectedRows === 1;
}

async function insertSnapshot(input: {
  range: OneShotAnalyticsRange;
  status: SnapshotStatus;
  response: OneShotStatisticsResponse | null;
  fingerprint: string;
  provider: string | null;
  model: string | null;
  expiresAt: Date | null;
  errorMessage?: string | null;
  invalidOutputSample?: string | null;
}): Promise<number> {
  const [result] = await getPool().execute<mysql.ResultSetHeader>(
    `INSERT INTO oneshot_statistics_snapshots
       (range_key, data_fingerprint, status, snapshot_json, provider, model,
        expires_at, error_message, invalid_output_sample)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.range,
      input.fingerprint,
      input.status,
      input.response ? JSON.stringify(input.response) : null,
      input.provider,
      input.model,
      input.expiresAt,
      input.errorMessage ?? null,
      input.invalidOutputSample ?? null,
    ],
  );
  return Number(result.insertId);
}

async function completeRefresh(input: {
  range: OneShotAnalyticsRange;
  latestSnapshotId: number | null;
  nextRetrySeconds: number | null;
  errorMessage: string | null;
}): Promise<void> {
  await getPool().execute(
    `UPDATE oneshot_statistics_refresh_state
     SET latest_snapshot_id = COALESCE(?, latest_snapshot_id),
         refresh_started_at = NULL,
         refresh_lease_expires_at = NULL,
         next_retry_at = CASE
           WHEN ? IS NULL THEN NULL
           ELSE DATE_ADD(NOW(3), INTERVAL ? SECOND)
         END,
         last_error = ?
     WHERE range_key = ?`,
    [
      input.latestSnapshotId,
      input.nextRetrySeconds,
      input.nextRetrySeconds,
      input.errorMessage,
      input.range,
    ],
  );
}

function parseSnapshotResponse(
  row: SnapshotRow,
): OneShotStatisticsResponse | null {
  const raw =
    typeof row.snapshot_json === "string"
      ? JSON.parse(row.snapshot_json)
      : row.snapshot_json;
  if (!raw || typeof raw !== "object") return null;
  return raw as OneShotStatisticsResponse;
}

function hasActiveRefreshLease(row: RefreshStateRow | null): boolean {
  if (!row?.refresh_lease_expires_at) return false;
  const expiresMs = new Date(row.refresh_lease_expires_at).getTime();
  return Number.isFinite(expiresMs) && expiresMs > Date.now();
}

function responseFromSnapshot(
  row: SnapshotRow,
  options: {
    refreshing: boolean;
    status?: OneShotStatisticsResponse["status"];
    lastError?: string | null;
    currentFingerprint?: string;
    freshTicketQuality?: OneShotTicketQualityAnalysis;
    freshRepoStatus?: OneShotRepoStatusSummary;
    freshOperationalBottlenecks?: OneShotOperationalBottleneckSummary;
    freshBusinessMetrics?: OneShotStatisticsBusinessMetric[];
    freshFailureAttribution?: OneShotFailureAttributionSummary;
    freshSelfFixCandidates?: OneShotStatisticsResponse["selfFixCandidates"];
    freshSelfFixConfig?: OneShotStatisticsResponse["selfFixConfig"];
  },
): OneShotStatisticsResponse | null {
  const response = parseSnapshotResponse(row);
  if (!response) return null;
  const freshTicketMetric = options.freshBusinessMetrics?.find(
    (metric) => metric.id === "ticket-readiness",
  );
  const businessMetrics = freshTicketMetric
    ? [
        ...response.businessMetrics.filter(
          (metric) => metric.id !== "ticket-readiness",
        ),
        freshTicketMetric,
      ]
    : response.businessMetrics;
  return {
    ...response,
    status: options.status ?? response.status,
    businessMetrics,
    ticketQuality: options.freshTicketQuality ?? response.ticketQuality,
    repoStatus: options.freshRepoStatus ?? response.repoStatus,
    operationalBottlenecks:
      options.freshOperationalBottlenecks ?? response.operationalBottlenecks,
    failureAttribution:
      options.freshFailureAttribution ?? response.failureAttribution,
    selfFixCandidates:
      options.freshSelfFixCandidates ?? response.selfFixCandidates ?? [],
    selfFixConfig:
      options.freshSelfFixConfig ??
      response.selfFixConfig ??
      getOneShotSelfFixConfig(),
    modelInfo: {
      ...response.modelInfo,
      provider: row.provider ?? response.modelInfo.provider,
      model: row.model ?? response.modelInfo.model,
      generatedAt: iso(row.generated_at),
      expiresAt: iso(row.expires_at),
      dataFingerprint:
        options.currentFingerprint ?? response.modelInfo.dataFingerprint,
      refreshing: options.refreshing,
      lastError: publicStatisticsLastError(
        options.lastError ?? row.error_message ?? response.modelInfo.lastError,
      ),
      promptVersion: response.modelInfo.promptVersion ?? 0,
    },
  };
}

async function refreshStatisticsSnapshot(input: {
  range: OneShotAnalyticsRange;
  deterministic: OneShotStatisticsResponse;
  fingerprint: string;
}): Promise<void> {
  const expiresAt = new Date(Date.now() + refreshIntervalMs(input.range));
  try {
    const llm = await runStatisticsLlm(input.deterministic);
    const response: OneShotStatisticsResponse = {
      ...applyLlmOutput(input.deterministic, llm.output),
      status: "ready",
      modelInfo: {
        provider: llm.provider,
        model: llm.model,
        generatedAt: new Date().toISOString(),
        expiresAt: expiresAt.toISOString(),
        nextRefreshAt: expiresAt.toISOString(),
        dataFingerprint: input.fingerprint,
        refreshing: false,
        lastError: null,
        promptVersion: STATISTICS_PROMPT_VERSION,
      },
    };
    const id = await insertSnapshot({
      range: input.range,
      status: "ready",
      response,
      fingerprint: input.fingerprint,
      provider: llm.provider,
      model: llm.model,
      expiresAt,
    });
    await completeRefresh({
      range: input.range,
      latestSnapshotId: id,
      nextRetrySeconds: null,
      errorMessage: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outputSample =
      (error as { outputSample?: string }).outputSample ?? null;
    const status: SnapshotStatus = outputSample ? "invalid" : "failed";
    await insertSnapshot({
      range: input.range,
      status,
      response: {
        ...input.deterministic,
        status,
        modelInfo: {
          ...input.deterministic.modelInfo,
          lastError: message,
        },
      },
      fingerprint: input.fingerprint,
      provider: statisticsLlmConfig().provider,
      model: statisticsLlmConfig().model,
      expiresAt: null,
      errorMessage: message,
      invalidOutputSample: outputSample,
    });
    await completeRefresh({
      range: input.range,
      latestSnapshotId: null,
      nextRetrySeconds:
        status === "invalid" ? INVALID_RETRY_SECONDS : FAILED_RETRY_SECONDS,
      errorMessage: message,
    });
  }
}

export async function getOneShotStatistics(
  range: OneShotAnalyticsRange,
): Promise<OneShotStatisticsResponse> {
  const rows = await getOneShotDashboardRows();
  const taskTextByTaskId = await fetchTaskTextByTaskId(rows);
  const [latestReady] = await latestReadySnapshots(range, 1);
  const priorAllTimeScorecard =
    range === "all" && latestReady
      ? (parseSnapshotResponse(latestReady)?.scorecard ?? null)
      : null;
  const deterministic = buildDeterministicStatisticsResponse({
    rows,
    taskTextByTaskId,
    range,
    priorAllTimeScorecard,
  });
  const fingerprint = deterministic.modelInfo.dataFingerprint;
  const initialState = await latestRefreshState(range);
  const latestResponse = latestReady
    ? responseFromSnapshot(latestReady, {
        refreshing: false,
        currentFingerprint: fingerprint,
        freshTicketQuality: deterministic.ticketQuality,
        freshRepoStatus: deterministic.repoStatus,
        freshOperationalBottlenecks: deterministic.operationalBottlenecks,
        freshBusinessMetrics: deterministic.businessMetrics,
        freshFailureAttribution: deterministic.failureAttribution,
        freshSelfFixCandidates: deterministic.selfFixCandidates,
        freshSelfFixConfig: deterministic.selfFixConfig,
      })
    : null;
  const latestExpiresAt = latestReady?.expires_at
    ? new Date(latestReady.expires_at).getTime()
    : 0;
  const stale =
    !latestReady ||
    latestReady.data_fingerprint !== fingerprint ||
    !Number.isFinite(latestExpiresAt) ||
    latestExpiresAt <= Date.now();

  if (!stale && latestResponse) {
    return enrichSelfFixCandidatesWithTicketStatus(latestResponse);
  }

  const wonLease = await claimStatisticsRefreshLease(range);
  const state = wonLease ? initialState : await latestRefreshState(range);
  const refreshing = wonLease || hasActiveRefreshLease(state);
  if (wonLease) {
    void refreshStatisticsSnapshot({ range, deterministic, fingerprint }).catch(
      (error) => {
        console.warn("[oneshot-statistics] background refresh failed", error);
      },
    );
  }

  if (latestReady && latestResponse) {
    const response =
      responseFromSnapshot(latestReady, {
        refreshing,
        status: "stale",
        lastError: state?.last_error ?? null,
        currentFingerprint: fingerprint,
        freshTicketQuality: deterministic.ticketQuality,
        freshRepoStatus: deterministic.repoStatus,
        freshOperationalBottlenecks: deterministic.operationalBottlenecks,
        freshBusinessMetrics: deterministic.businessMetrics,
        freshFailureAttribution: deterministic.failureAttribution,
        freshSelfFixCandidates: deterministic.selfFixCandidates,
        freshSelfFixConfig: deterministic.selfFixConfig,
      }) ?? latestResponse;
    return enrichSelfFixCandidatesWithTicketStatus(response);
  }

  return enrichSelfFixCandidatesWithTicketStatus({
    ...deterministic,
    status: wonLease ? "generating" : "deterministic_only",
    modelInfo: {
      ...deterministic.modelInfo,
      refreshing,
      lastError: publicStatisticsLastError(state?.last_error),
    },
  });
}

export function buildMockOneShotStatistics(
  rows: readonly OneShotDashboardRow[],
  range: OneShotAnalyticsRange,
): OneShotStatisticsResponse {
  const taskTextByTaskId = new Map(
    rows.map((row, index) => {
      const hasStrongTemplate = index % 3 !== 0;
      const taskDescription = hasStrongTemplate
        ? [
            `Summary: ${row.title}.`,
            `Overview: OneShot should update ${row.repoName || "the target repository"} so operators can complete the requested workflow with less manual cleanup.`,
            "Acceptance Criteria:",
            "- Given the requested workflow, when OneShot finishes, then the relevant state is visible and verified.",
            `Technical Details: Update ${row.repoName || "dashboard"} service and component code paths referenced by the ticket.`,
            "Testing Notes: Add unit coverage and run the focused dashboard or service tests.",
            "Out of Scope: Do not change unrelated workflow behavior.",
          ].join("\n")
        : [
            `${row.title} needs an update in ${row.repoName || "the target repo"}.`,
            "The expected behavior is described, but acceptance criteria and tests are not fully captured in the ticket text.",
          ].join(" ");
      return [
        row.sourceTaskManagementId,
        {
          taskDescription,
          qualifierOutcome: { acceptanceCriteriaPresent: hasStrongTemplate },
        },
      ];
    }),
  );
  return buildDeterministicStatisticsResponse({
    rows,
    taskTextByTaskId,
    range,
    status: "ready",
    refreshing: false,
  });
}
