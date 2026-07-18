import {
  BLOCKED_DISPLAY_STATES,
  ERROR_DISPLAY_STATES,
} from "../shared/oneshotStateModel.js";
import { clusterSignature, parseErrorSummary } from "../shared/errorParsing.js";
import {
  buildFailureClassificationMessage,
  classifyFailureForRow,
} from "./failureAttribution.js";
import type {
  OneShotAgentAnalyticsEntry,
  OneShotAnalyticsRange,
  OneShotAnalyticsWindow,
  OneShotDashboardCapabilities,
  OneShotDashboardAnalytics,
  OneShotArtifactRun,
  OneShotDashboardRow,
  OneShotDeploymentSummary,
  OneShotDeploymentLight,
  OneShotDeploymentStatus,
  OneShotDisplayState,
  OneShotProgressStage,
  OneShotRunsResponse,
  OneShotRunsStats,
  OneShotTicketType,
} from "../types/oneshot.js";
import { bucketForView } from "./oneshotRowHelpers.js";

type MockRunKind =
  | "running"
  | "queued"
  | "completed"
  | "failed"
  | "blocked"
  | "waiting";

export interface MockRunRequest {
  jiraKey: string;
  title: string;
  priority?: "High" | "Medium" | "Low";
}

// Deterministic prototype-style dataset used whenever the dashboard runs in
// local development without a real OneShot read model.
const SEED = 20260419;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const DEFAULT_ANALYTICS_RANGE: OneShotAnalyticsRange = "24h";
const RANGE_CONFIG: Record<
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
const REAL_AGENT_STAGES: Exclude<OneShotProgressStage, "pr_complete">[] = [
  "qualification",
  "planning",
  "review",
  "implementation",
  "code_review",
  "testing",
];
const MOCK_MODELS = [
  { model: "us.anthropic.claude-sonnet-4-6", provider: "anthropic" },
  { model: "openai/gpt-5.4", provider: "openai" },
  { model: "us.anthropic.claude-opus-4-1", provider: "anthropic" },
] as const;
const TITLES = [
  "Refactor auth middleware to use async context",
  "Fix race condition in webhook retry queue",
  "Add pagination to /v2/organizations endpoint",
  "Migrate feature flags from LaunchDarkly to internal",
  "Reduce cold start time on billing workers",
  "Support SAML SCIM user provisioning",
  "Redact PII from audit log exports",
  "Batch notification digest for enterprise tier",
  "Index user_events on (org_id, created_at)",
  "Expose rate limit headers on public API",
  "Dead-letter queue for failed Stripe events",
  "Handle empty payload on /metrics POST",
  "Upgrade Node 18 to 20 on edge runtime",
  "Add dark mode to settings > notifications",
  "Fix timezone drift in scheduled reports",
  "Graceful shutdown for realtime gateway",
  "Cache-warm org membership on login",
  "Retry logic for flaky S3 multipart uploads",
  "Normalize emoji in display names",
  "CSV export: stream instead of buffer",
  "Soft-delete cascade on workspace removal",
  "Fix N+1 on billing invoice list",
  "Support IPv6 egress for webhooks",
  "Backfill org_region column from shards",
  "Add structured logging to search service",
  "Fix duplicate email on invite resend",
  "Reduce p99 on /search by 200ms",
  "Validate JWT aud claim on admin routes",
  "Drop unused index on events_legacy",
  "Paginate GraphQL workspace.members",
];
const PROJECTS = ["PLAT", "BILL", "API", "WEB", "CORE", "INFRA"] as const;
const CUSTOMERS = [
  "Acme Corp",
  "Northstar Health",
  "Beta Labs",
  "Mercury Retail",
  "Maple Bank",
  "Zenith Cloud",
  "Harbor Freight",
  "Atlas Energy",
];
const REPO_BY_PROJECT: Record<(typeof PROJECTS)[number], string> = {
  PLAT: "product-factory",
  BILL: "billing-core",
  API: "public-api",
  WEB: "console-web",
  CORE: "core-app",
  INFRA: "platform-infra",
};
const MOCK_RUN_SEQUENCE: ReadonlyArray<MockRunKind> = [
  "running",
  "running",
  "running",
  "running",
  "queued",
  "queued",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "completed",
  "failed",
  "failed",
  "failed",
  "failed",
  "failed",
  "failed",
  "failed",
  "failed",
  "blocked",
  "blocked",
  "blocked",
  "blocked",
  "waiting",
  "waiting",
  "waiting",
  "waiting",
];

let nextMockRunId = 9000;
let mockRuns: OneShotDashboardRow[] = buildSeededMockRuns();

function mulberry32(seed: number) {
  return function rand(): number {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function deploymentSummary(
  eligible: boolean,
  active: boolean,
  light: OneShotDeploymentLight,
  status: OneShotDeploymentStatus,
  previewUrl: string | null = null,
  workflowUrl: string | null = null,
  deployedCommitSha: string | null = null,
): OneShotDeploymentSummary {
  return {
    eligible,
    ready: eligible && status === "ready",
    active,
    light,
    status,
    previewUrl,
    workflowUrl,
    imageUri: null,
    deployedCommitSha,
  };
}

function fakeSha(seed: string): string {
  const normalized = seed.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return `${normalized}${"abcdef1234567890".slice(0, 12)}`.slice(0, 12);
}

function projectForIndex(
  index: number,
  rand: () => number,
): (typeof PROJECTS)[number] {
  return PROJECTS[
    (index + Math.floor(rand() * PROJECTS.length)) % PROJECTS.length
  ]!;
}

function customerForIndex(index: number, rand: () => number): string {
  return CUSTOMERS[
    (index + Math.floor(rand() * CUSTOMERS.length)) % CUSTOMERS.length
  ]!;
}

function stageState(stage: Exclude<OneShotProgressStage, "pr_complete">): {
  executing: OneShotDisplayState;
  queued: OneShotDisplayState;
} {
  switch (stage) {
    case "qualification":
      return {
        executing: "qualification_pending",
        queued: "queued_for_planning",
      };
    case "planning":
      return { executing: "planning", queued: "queued_for_review" };
    case "review":
      return { executing: "reviewing", queued: "queued_for_implementation" };
    case "implementation":
      return { executing: "implementing", queued: "queued_for_code_review" };
    case "code_review":
      return { executing: "code_reviewing", queued: "queued_for_testing" };
    case "testing":
      return { executing: "testing", queued: "queued_for_testing" };
  }
}

function tokensFor(
  kind: MockRunKind,
  stageIndex: number,
  rand: () => number,
): number {
  const stageWeight = Math.max(1, stageIndex + 1);
  const variance = Math.round(rand() * 26000);
  let total = stageWeight * 7000 + variance;
  if (kind === "completed") total += 30000;
  if (kind === "waiting") total += 18000;
  if (kind === "failed" || kind === "blocked") total += 12000;
  return total;
}

function durationMsFor(
  kind: MockRunKind,
  stageIndex: number,
  rand: () => number,
): number {
  const variance = Math.round(rand() * 180000);
  switch (kind) {
    case "completed":
      return 240000 + stageIndex * 30000 + variance;
    case "waiting":
      return 300000 + stageIndex * 45000 + variance;
    case "failed":
    case "blocked":
      return 180000 + stageIndex * 40000 + variance;
    case "running":
      return 120000 + stageIndex * 35000 + variance;
    case "queued":
      return 90000 + stageIndex * 20000 + variance / 2;
  }
}

function ageMinutesFor(
  kind: MockRunKind,
  index: number,
  rand: () => number,
): number {
  switch (kind) {
    case "running":
      return 20 + index * 13 + Math.round(rand() * 18);
    case "queued":
      return 75 + index * 21 + Math.round(rand() * 30);
    case "waiting":
      return 320 + Math.max(0, index - 38) * 70 + Math.round(rand() * 30);
    case "failed":
    case "blocked":
      return 180 + index * 19 + Math.round(rand() * 40);
    case "completed":
      return 110 + index * 17 + Math.round(rand() * 55);
  }
}

function costUsd(tokens: number): number {
  return Math.round((tokens / 1000) * 0.008 * 100) / 100;
}

function costSourceForIndex(index: number): "actual" | "estimated" | "mixed" {
  if (index % 5 === 0) return "mixed";
  if (index % 3 === 0) return "estimated";
  return "actual";
}

function mergeCostSources(
  sources: ReadonlyArray<"actual" | "estimated" | "mixed">,
): "actual" | "estimated" | "mixed" {
  let sawActual = false;
  let sawEstimated = false;
  for (const source of sources) {
    if (source === "actual") sawActual = true;
    if (source === "estimated") sawEstimated = true;
    if (source === "mixed") {
      sawActual = true;
      sawEstimated = true;
    }
  }
  if (sawActual && sawEstimated) return "mixed";
  if (sawActual) return "actual";
  return "estimated";
}

function titleFor(kind: MockRunKind, title: string): string {
  if (kind === "blocked") return `Blocked: ${title}`;
  return title;
}

function mockTicketTypeForIndex(index: number): OneShotTicketType {
  const types: OneShotTicketType[] = [
    "story",
    "defect",
    "sonar",
    "security",
    "retrofit",
    "documentation",
    "other",
  ];
  return types[index % types.length] ?? "story";
}

function errorFor(
  kind: MockRunKind,
  stage: OneShotProgressStage,
  title: string,
): {
  lastError: string | null;
  lastErrorSummary: string | null;
} {
  if (kind === "failed") {
    const summary = `${stage} failed while processing ${title.toLowerCase()}.`;
    return {
      lastError: `${summary} Build failed due to a schema mismatch in generated code.`,
      lastErrorSummary: summary,
    };
  }
  if (kind === "blocked") {
    const summary = `Waiting on external approval before ${stage} can continue.`;
    return {
      lastError: `${summary} Security review is still pending for this ticket.`,
      lastErrorSummary: summary,
    };
  }
  return { lastError: null, lastErrorSummary: null };
}

function waitingStateFor(index: number): OneShotDisplayState {
  return index % 2 === 0 ? "approved" : "needs_revision";
}

function waitingStageFor(
  index: number,
): Exclude<OneShotProgressStage, "pr_complete"> {
  return index % 2 === 0 ? "implementation" : "review";
}

function buildRow(
  kind: MockRunKind,
  index: number,
  rand: () => number,
): OneShotDashboardRow {
  const project = projectForIndex(index, rand);
  const repoName = REPO_BY_PROJECT[project];
  const jiraNumber = 4200 + Math.floor(rand() * 5000);
  const jiraKey = `${project}-${jiraNumber}`;
  const stageIndex =
    kind === "completed"
      ? REAL_AGENT_STAGES.length - 1
      : kind === "waiting"
        ? REAL_AGENT_STAGES.indexOf(waitingStageFor(index))
        : kind === "queued"
          ? Math.min(REAL_AGENT_STAGES.length - 1, 1 + (index % 4))
          : Math.min(
              REAL_AGENT_STAGES.length - 1,
              index % REAL_AGENT_STAGES.length,
            );
  const progressStage =
    kind === "completed"
      ? "pr_complete"
      : kind === "waiting"
        ? waitingStageFor(index)
        : REAL_AGENT_STAGES[stageIndex]!;
  const stageStates =
    progressStage === "pr_complete"
      ? stageState("testing")
      : stageState(progressStage);
  let displayState: OneShotDisplayState;
  switch (kind) {
    case "running":
      displayState = stageStates.executing;
      break;
    case "queued":
      displayState = stageStates.queued;
      break;
    case "completed":
      displayState = "completed";
      break;
    case "failed":
      displayState =
        progressStage === "qualification" ? "qualification_failed" : "failed";
      break;
    case "blocked":
      displayState = "blocked";
      break;
    case "waiting":
      displayState = waitingStateFor(index);
      break;
  }

  const durationMs = durationMsFor(kind, stageIndex, rand);
  const ageMinutes = ageMinutesFor(kind, index, rand);
  const updatedAtMs = Date.now() - ageMinutes * 60_000;
  const createdAtMs = updatedAtMs - durationMs;
  const totalTokensUsed = tokensFor(kind, stageIndex, rand);
  const commitSeed = fakeSha(`${jiraKey}-${index}`);
  const deployable = kind === "completed" && index % 5 !== 0;
  const deployment =
    kind === "completed" && index % 7 === 0
      ? deploymentSummary(
          true,
          true,
          "green",
          "active",
          `https://preview.example.com/${jiraKey.toLowerCase()}`,
          null,
          commitSeed,
        )
      : deployable
        ? deploymentSummary(
            true,
            false,
            "grey",
            "ready",
            null,
            `https://github.com/example/${repoName}/actions/runs/${5100 + index}`,
          )
        : deploymentSummary(false, false, "grey", "not_eligible");
  const { lastError, lastErrorSummary } = errorFor(
    kind,
    progressStage,
    TITLES[index % TITLES.length]!,
  );
  const retry =
    displayState === "failed" &&
    progressStage !== "qualification" &&
    progressStage !== "pr_complete"
      ? {
          stage: progressStage,
          eligible: true,
          attemptsUsed: index % 2,
          attemptsRemaining: Math.max(0, 2 - (index % 2)),
          maxAttempts: 2,
          disabledReason: null,
        }
      : null;
  const qualificationFailureReason =
    displayState === "qualification_failed"
      ? "acceptance_criteria_missing: no explicit Acceptance Criteria section is present; unresolved open questions require product owner confirmation"
      : null;

  const row: OneShotDashboardRow = {
    dashboardId: `run-${1000 + index}`,
    jiraKey,
    title: titleFor(kind, TITLES[index % TITLES.length]!),
    jiraIssueType: index % 3 === 0 ? "Defect" : "Story",
    ticketType: mockTicketTypeForIndex(index),
    ticketTypeSource: "mock",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
    sourceTaskManagementId: 2000 + index,
    oneshotRunId: 1000 + index,
    customerName: customerForIndex(index, rand),
    displayState,
    progressStage,
    progressPercent:
      kind === "completed"
        ? 100
        : Math.min(
            96,
            Math.max(6, Math.round(((stageIndex + 0.55) / 7) * 100)),
          ),
    repoName,
    repoUrl: `https://github.com/example/${repoName}`,
    baseBranch: "main",
    baseCommitSha: fakeSha(`${repoName}-base-${index}`),
    implementationBranch:
      kind === "queued" && progressStage === "planning"
        ? null
        : `oneshot/${jiraKey.toLowerCase()}`,
    implementationCommitSha:
      kind === "completed" || kind === "waiting" ? commitSeed : null,
    workspace: null,
    reviewLoopCount:
      progressStage === "review" || progressStage === "code_review"
        ? (index % 3) + 1
        : index % 2,
    maxReviewLoops: 3,
    planReviewLoopCount:
      progressStage === "review" ? (index % 3) + 1 : index % 2,
    maxPlanReviewLoops: 3,
    verificationLoopCount:
      progressStage === "implementation" ||
      progressStage === "code_review" ||
      progressStage === "testing"
        ? index % 3
        : 0,
    maxVerificationLoops: 3,
    currentPrUrl:
      kind === "completed" ||
      progressStage === "code_review" ||
      progressStage === "testing"
        ? `https://github.com/example/${repoName}/pull/${4800 + index}`
        : null,
    qualificationSummary: qualificationFailureReason
      ? qualificationFailureReason
      : displayState === "qualification_pending"
        ? "QUALIFIER is still assessing the ticket."
        : null,
    qualifierOutcome: qualificationFailureReason
      ? {
          disposition: "not_qualified",
          reasonCode: "llm_rejected",
          reason: qualificationFailureReason,
          qualifierMode: "fresh",
          labels: ["PFOS-NOT-QUALIFIED"],
          latestRunState: null,
          acceptanceCriteriaPresent: false,
        }
      : null,
    lastError,
    lastErrorSummary,
    failureAttribution: null,
    retry,
    deployment,
    createdAt: new Date(createdAtMs).toISOString(),
    lastManualRestartAt: null,
    updatedAt: new Date(updatedAtMs).toISOString(),
    totalTokensUsed,
    estimatedCostUsd: costUsd(totalTokensUsed),
    costSource: costSourceForIndex(index),
  };
  return {
    ...row,
    failureAttribution: classifyFailureForRow(row),
  };
}

function buildSeededMockRuns(): OneShotDashboardRow[] {
  const rand = mulberry32(SEED);
  const runs = MOCK_RUN_SEQUENCE.map((kind, index) =>
    buildRow(kind, index, rand),
  );
  nextMockRunId = 1000 + runs.length + 1;
  return runs.sort(
    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
  );
}

function percentile(sortedAsc: ReadonlyArray<number>, p: number): number {
  if (sortedAsc.length === 0) return 0;
  const clamped = Math.min(Math.max(p, 0), 1);
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.floor(clamped * sortedAsc.length),
  );
  return sortedAsc[idx] ?? 0;
}

function trendDelta(currentValue: number, priorValue: number) {
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

function timestampMs(isoTimestamp: string): number {
  const value = new Date(isoTimestamp).getTime();
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

  const startMs = nowMs - RANGE_CONFIG[range].durationMs;
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

  const durationMs = RANGE_CONFIG[range].durationMs;
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
    const config = RANGE_CONFIG[range];
    return {
      window: {
        range,
        label: config.label,
        shortLabel: config.shortLabel,
        bucketLabel: config.bucketLabel,
        isAllTime: false,
      },
      startMs: nowMs - config.durationMs,
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

function isCompletedRow(row: OneShotDashboardRow): boolean {
  return row.displayState === "completed" || row.displayState === "pr_open";
}

function stageForRow(
  row: OneShotDashboardRow,
): Exclude<OneShotProgressStage, "pr_complete"> {
  return row.progressStage === "pr_complete" ? "testing" : row.progressStage;
}

function stageIndexForRow(row: OneShotDashboardRow): number {
  return REAL_AGENT_STAGES.indexOf(stageForRow(row));
}

function buildStats(
  runs: ReadonlyArray<OneShotDashboardRow>,
): OneShotRunsStats {
  const byView = { running: 0, queued: 0, waiting: 0, history: 0 };
  for (const row of runs) {
    const bucket = bucketForView(row.displayState);
    if (bucket === "running") byView.running += 1;
    if (bucket === "queued") byView.queued += 1;
    if (bucket === "waiting") byView.waiting += 1;
    if (bucket === "history") byView.history += 1;
  }

  return {
    inProgress: byView.running + byView.queued + byView.waiting,
    failed: runs.filter((row) =>
      (ERROR_DISPLAY_STATES as readonly string[]).includes(row.displayState),
    ).length,
    blocked: runs.filter((row) =>
      (BLOCKED_DISPLAY_STATES as readonly string[]).includes(row.displayState),
    ).length,
    deployReady: runs.filter((row) => row.deployment.ready).length,
    byView,
  };
}

function buildMockAnalytics(
  runs: ReadonlyArray<OneShotDashboardRow>,
  range: OneShotAnalyticsRange = DEFAULT_ANALYTICS_RANGE,
): OneShotDashboardAnalytics {
  const nowMs = Date.now();
  const stats = buildStats(runs);
  const overviewRows = currentItemsForRange(runs, "24h", nowMs, (row) =>
    timestampMs(row.createdAt),
  );
  const overviewStats = buildStats(overviewRows);
  const currentRows = currentItemsForRange(runs, range, nowMs, (row) =>
    timestampMs(row.createdAt),
  );
  const priorRows = priorItemsForRange(runs, range, nowMs, (row) =>
    timestampMs(row.createdAt),
  );
  const bucketPlan = createBucketPlan(
    range,
    currentRows.map((row) => timestampMs(row.createdAt)),
    nowMs,
  );
  const completed = overviewRows.filter(
    (row) => row.displayState === "completed" || row.displayState === "pr_open",
  ).length;
  const failed = overviewRows.filter(
    (row) =>
      row.displayState === "failed" ||
      row.displayState === "qualification_failed",
  ).length;
  const totalTokens = overviewRows.reduce(
    (sum, row) => sum + row.totalTokensUsed,
    0,
  );
  const passBase = completed + failed;
  const queue = {
    queued: stats.byView.queued,
    running: stats.byView.running,
    waiting: stats.byView.waiting,
    recentlyFinished: stats.byView.history,
    workerCapacity: REAL_AGENT_STAGES.length,
  };
  const agents: OneShotAgentAnalyticsEntry[] = REAL_AGENT_STAGES.map(
    (stage) => {
      const matching = runs.filter((row) => row.progressStage === stage);
      return {
        stage,
        runs: matching.length,
        avgLatencyMs: 0,
        failRate: 0,
        avgTokens:
          matching.length === 0
            ? 0
            : Math.round(
                matching.reduce((sum, row) => sum + row.totalTokensUsed, 0) /
                  matching.length,
              ),
        recentSamples: [],
      };
    },
  );
  const currentTotalTokens = currentRows.reduce(
    (sum, row) => sum + row.totalTokensUsed,
    0,
  );
  const currentTotalUsd = currentRows.reduce(
    (sum, row) => sum + row.estimatedCostUsd,
    0,
  );
  const priorTotalUsd = priorRows.reduce(
    (sum, row) => sum + row.estimatedCostUsd,
    0,
  );
  const nonZeroRows = overviewRows.filter((row) => row.estimatedCostUsd > 0);
  const nonZeroCurrentRows = currentRows.filter(
    (row) => row.estimatedCostUsd > 0,
  );
  const buckets = createBuckets(currentRows, bucketPlan, (row) =>
    timestampMs(row.createdAt),
  );

  const completedDurations = currentRows
    .filter(isCompletedRow)
    .map((row) =>
      Math.max(
        0,
        new Date(row.updatedAt).getTime() - new Date(row.createdAt).getTime(),
      ),
    )
    .sort((a, b) => a - b);

  const stageCompletion = REAL_AGENT_STAGES.map((stage, index) => {
    let attempts = 0;
    let completions = 0;
    let failures = 0;

    for (const row of currentRows) {
      const currentIndex = stageIndexForRow(row);
      if (currentIndex < index) continue;

      attempts += 1;

      const failedAtStage =
        (row.displayState === "failed" ||
          row.displayState === "qualification_failed") &&
        currentIndex === index;
      if (failedAtStage) {
        failures += 1;
        continue;
      }

      if (
        currentIndex > index ||
        row.displayState === "completed" ||
        row.displayState === "pr_open" ||
        row.displayState === "approved" ||
        row.displayState === "needs_revision" ||
        row.displayState === "escalated" ||
        row.displayState === "replan_required" ||
        row.displayState === "blocked"
      ) {
        completions += 1;
      }
    }

    return { stage, attempts, completions, failures };
  });

  const stageTokens = new Map<
    Exclude<OneShotProgressStage, "pr_complete">,
    number
  >();
  for (const row of currentRows) {
    const stage = stageForRow(row);
    stageTokens.set(stage, (stageTokens.get(stage) ?? 0) + row.totalTokensUsed);
  }
  const byStage = REAL_AGENT_STAGES.map((stage) => {
    const tokens = stageTokens.get(stage) ?? 0;
    const usd = costUsd(tokens);
    return {
      stage,
      tokens,
      usd,
      share: currentTotalUsd === 0 ? 0 : usd / currentTotalUsd,
    };
  });

  const modelTotals = new Map<
    string,
    { model: string; provider: string | null; tokens: number; usd: number }
  >();
  for (const row of currentRows) {
    const model =
      MOCK_MODELS[Math.abs(row.sourceTaskManagementId) % MOCK_MODELS.length]!;
    const modelKey = `${model.provider ?? "unknown"}:${model.model}`;
    const existing = modelTotals.get(modelKey);
    if (existing) {
      existing.tokens += row.totalTokensUsed;
      existing.usd += row.estimatedCostUsd;
    } else {
      modelTotals.set(modelKey, {
        model: model.model,
        provider: model.provider,
        tokens: row.totalTokensUsed,
        usd: row.estimatedCostUsd,
      });
    }
  }
  const byModel = Array.from(modelTotals.entries())
    .map(([, { model, provider, tokens, usd }]) => ({
      model,
      provider,
      tokens,
      usd: Math.round(usd * 100) / 100,
      share: currentTotalUsd === 0 ? 0 : usd / currentTotalUsd,
    }))
    .sort((a, b) => b.usd - a.usd);

  const topRuns = [...currentRows]
    .sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
    .slice(0, 5)
    .map((row) => ({
      dashboardId: row.dashboardId,
      jiraKey: row.jiraKey,
      title: row.title,
      totalTokensUsed: row.totalTokensUsed,
      estimatedCostUsd: row.estimatedCostUsd,
      costSource: row.costSource,
      progressStage: row.progressStage,
      displayState: row.displayState,
    }));

  const failedRows = currentItemsForRange(
    runs.filter(
      (row) =>
        row.displayState === "failed" ||
        row.displayState === "qualification_failed",
    ),
    range,
    nowMs,
    (row) => timestampMs(row.updatedAt),
  );
  const failureBucketPlan = createBucketPlan(
    range,
    failedRows.map((row) => timestampMs(row.updatedAt)),
    nowMs,
  );
  const clusteredFailures = new Map<
    string,
    {
      signature: string;
      code: string | null;
      headline: string;
      representativeRow: OneShotDashboardRow;
      representativeMs: number;
      rows: OneShotDashboardRow[];
    }
  >();
  for (const row of failedRows) {
    const summary = buildFailureClassificationMessage(row) || "Unknown error";
    const parsed = parseErrorSummary(summary);
    const signature = clusterSignature(parsed);
    const updatedMs = new Date(row.updatedAt).getTime();
    const existing = clusteredFailures.get(signature);
    if (existing) {
      existing.rows.push(row);
      if (updatedMs > existing.representativeMs) {
        existing.representativeRow = row;
        existing.representativeMs = updatedMs;
      }
    } else {
      clusteredFailures.set(signature, {
        signature,
        code: parsed.code,
        headline: parsed.heading,
        representativeRow: row,
        representativeMs: updatedMs,
        rows: [row],
      });
    }
  }
  const clusters = Array.from(clusteredFailures.values())
    .map((cluster) => {
      const stageCounts = REAL_AGENT_STAGES.map((stage) => ({
        stage,
        count: cluster.rows.filter((row) => stageForRow(row) === stage).length,
      })).filter((entry) => entry.count > 0);

      return {
        signature: cluster.signature,
        code: cluster.code,
        headline: cluster.headline,
        count: cluster.rows.length,
        representativeDashboardId: cluster.representativeRow.dashboardId,
        jiraKeys: cluster.rows.slice(0, 5).map((row) => row.jiraKey),
        stageCounts,
        buckets: createBuckets(cluster.rows, failureBucketPlan, (row) =>
          timestampMs(row.updatedAt),
        ),
        lastSeenMs: cluster.representativeMs,
      };
    })
    .sort((a, b) => b.lastSeenMs - a.lastSeenMs);

  return {
    overview24h: {
      runs24h: overviewRows.length,
      completed,
      failed,
      running: overviewStats.byView.running,
      queued: overviewStats.byView.queued,
      waiting: overviewStats.byView.waiting,
      passRate: passBase === 0 ? 0 : completed / passBase,
      avgTimeToPrMs: 0,
      medianTimeToPrMs: 0,
      totalTokens,
      estimatedCostUsd: overviewRows.reduce(
        (sum, row) => sum + row.estimatedCostUsd,
        0,
      ),
      costSource: mergeCostSources(nonZeroRows.map((row) => row.costSource)),
      throughputBuckets: Array.from({ length: 24 }, () => 0),
      attemptFailures24h: failed,
    },
    agents,
    queue,
    throughput: {
      window: bucketPlan.window,
      buckets,
      totalRuns: currentRows.length,
      trend:
        range === "all"
          ? null
          : trendDelta(currentRows.length, priorRows.length),
      p50TimeToPrMs: percentile(completedDurations, 0.5),
      p90TimeToPrMs: percentile(completedDurations, 0.9),
      stageCompletion,
    },
    costs: {
      window: bucketPlan.window,
      totalUsd: currentTotalUsd,
      totalTokens: currentTotalTokens,
      costSource: mergeCostSources(
        nonZeroCurrentRows.map((row) => row.costSource),
      ),
      trend:
        range === "all" ? null : trendDelta(currentTotalUsd, priorTotalUsd),
      byStage,
      byModel,
      topRuns,
    },
    failures: {
      window: failureBucketPlan.window,
      totalFailures: failedRows.length,
      clusters,
    },
  };
}

const MOCK_CAPABILITIES: OneShotDashboardCapabilities = {
  createRun: true,
  createRunMode: "mock",
  deployPreviewAvailable: false,
  deployPreview: false,
};

function buildMockArtifactRuns(): OneShotArtifactRun[] {
  const nowMs = Date.now();
  const timestamp = (hoursAgo: number) =>
    new Date(nowMs - hoursAgo * HOUR_MS).toISOString();

  return [
    {
      id: "mock-artifact-wiz",
      sourceKey: "ART-1001",
      sourceParentKey: null,
      mode: "wiz",
      status: "manual_review",
      title: "Cloud dependency scan batch",
      generatedCount: 6,
      generatedTickets: [
        {
          key: "ART-1101",
          title: "Patch vulnerable runtime package",
          kind: "remediation",
          status: "in_progress",
          jiraUrl: "https://example.atlassian.net/browse/ART-1101",
          oneshotRunDashboardId: "run-1000",
          oneshotRunState: "implementing",
          currentPrUrl: null,
        },
        {
          key: "ART-1102",
          title: "Remove unsupported archive package",
          kind: "manual_review",
          status: "held",
          jiraUrl: "https://example.atlassian.net/browse/ART-1102",
          oneshotRunDashboardId: null,
          oneshotRunState: null,
          currentPrUrl: null,
        },
      ],
      oneshotRunCount: 1,
      humanReviewRequired: true,
      humanReviewCount: 2,
      reviewItems: [
        "Confirm scan grouping before creating more remediation stories.",
        "Review held archive findings before routing to implementation.",
      ],
      evidence: {
        source: "scan export",
        findingsReviewed: 42,
        findingsGrouped: 6,
      },
      artifactRefs: null,
      jiraSummary:
        "Scan analysis grouped 42 findings into 6 candidate remediation stories; 2 items need human routing.",
      completedAt: timestamp(6),
      createdAt: timestamp(8),
      updatedAt: timestamp(6),
    },
    {
      id: "mock-artifact-sonar",
      sourceKey: "ART-1002",
      sourceParentKey: null,
      mode: "sonar",
      status: "in_progress",
      title: "Code quality remediation batch",
      generatedCount: 4,
      generatedTickets: [
        {
          key: "ART-1201",
          title: "Fix duplicated validation logic",
          kind: "remediation",
          status: "pr_open",
          jiraUrl: "https://example.atlassian.net/browse/ART-1201",
          oneshotRunDashboardId: "run-1007",
          oneshotRunState: "pr_open",
          currentPrUrl: "https://github.com/example/product-factory/pull/1201",
        },
        {
          key: "ART-1202",
          title: "Reduce service complexity",
          kind: "remediation",
          status: "queued",
          jiraUrl: "https://example.atlassian.net/browse/ART-1202",
          oneshotRunDashboardId: "run-1008",
          oneshotRunState: "queued_for_planning",
          currentPrUrl: null,
        },
      ],
      oneshotRunCount: 2,
      humanReviewRequired: false,
      humanReviewCount: 0,
      reviewItems: [],
      evidence: {
        source: "quality gate",
        issuesReviewed: 18,
        acceptedForAutomation: 4,
      },
      artifactRefs: null,
      jiraSummary:
        "SonarQube batch accepted 4 remediation tickets and linked 2 active OneShot runs.",
      completedAt: null,
      createdAt: timestamp(5),
      updatedAt: timestamp(1.5),
    },
    {
      id: "mock-artifact-docs",
      sourceKey: "ART-1003",
      sourceParentKey: "ART-1000",
      mode: "documentation",
      status: "review_required",
      title: "Documentation artifact set",
      generatedCount: 8,
      generatedTickets: [
        {
          key: "ART-1301",
          title: "Configuration instructions",
          kind: "DOC-TYPE-CONFIG",
          status: "dry_run_complete",
          jiraUrl: "https://example.atlassian.net/browse/ART-1301",
          oneshotRunDashboardId: null,
          oneshotRunState: null,
          currentPrUrl: null,
        },
        {
          key: "ART-1302",
          title: "Troubleshooting guide",
          kind: "DOC-TYPE-TROUBLESHOOTING",
          status: "ready_for_publish_review",
          jiraUrl: "https://example.atlassian.net/browse/ART-1302",
          oneshotRunDashboardId: null,
          oneshotRunState: null,
          currentPrUrl: null,
        },
      ],
      oneshotRunCount: 0,
      humanReviewRequired: true,
      humanReviewCount: 3,
      reviewItems: [
        "Confirm exact field values that must be configured.",
        "Confirm API request and response examples before publishing.",
        "Review release-note wording for client-facing scope.",
      ],
      evidence: {
        jiraIssuesReviewed: 31,
        extractedTextAttachments: 18,
      },
      artifactRefs: {
        markdownPath: "/tmp/oneshot-docs-dry-run/ART-1301-config.md",
        jiraSummaryPath: "/tmp/oneshot-docs-dry-run/ART-1301-jira-summary.md",
      },
      jiraSummary:
        "Documentation dry-run generated 8 artifacts; 3 confirmations are required before publish.",
      completedAt: timestamp(0.75),
      createdAt: timestamp(2.5),
      updatedAt: timestamp(0.75),
    },
  ];
}

function repoForJiraKey(jiraKey: string): string {
  const prefix = jiraKey
    .split("-")[0]
    ?.toUpperCase() as (typeof PROJECTS)[number];
  return REPO_BY_PROJECT[prefix] ?? "product-factory";
}

export function getMockData(
  range: OneShotAnalyticsRange = DEFAULT_ANALYTICS_RANGE,
): OneShotRunsResponse {
  return {
    runs: [...mockRuns],
    artifactRuns: buildMockArtifactRuns(),
    pagination: {
      total: mockRuns.length,
      offset: 0,
      limit: Math.max(100, mockRuns.length),
      hasMore: false,
    },
    stats: buildStats(mockRuns),
    capabilities: MOCK_CAPABILITIES,
    analytics: buildMockAnalytics(mockRuns, range),
  };
}

export function getMockRow(
  dashboardId: string,
): OneShotDashboardRow | undefined {
  return mockRuns.find((row) => row.dashboardId === dashboardId);
}

export function createMockRun(input: MockRunRequest): OneShotDashboardRow {
  const now = new Date().toISOString();
  const jiraKey = input.jiraKey.trim().toUpperCase();
  const repoName = repoForJiraKey(jiraKey);
  const runId = nextMockRunId++;
  const row: OneShotDashboardRow = {
    dashboardId: `run-${runId}`,
    jiraKey,
    title: input.title.trim(),
    jiraIssueType: "Story",
    ticketType: "story",
    ticketTypeSource: "mock",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
    sourceTaskManagementId: 3000 + runId,
    oneshotRunId: runId,
    customerName: customerForIndex(runId, mulberry32(runId)),
    displayState: "qualification_pending",
    progressStage: "qualification",
    progressPercent: 4,
    repoName,
    repoUrl: `https://github.com/example/${repoName}`,
    baseBranch: "main",
    baseCommitSha: fakeSha(`${repoName}-base-${runId}`),
    implementationBranch: null,
    implementationCommitSha: null,
    workspace: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    planReviewLoopCount: 0,
    maxPlanReviewLoops: 3,
    verificationLoopCount: 0,
    maxVerificationLoops: 3,
    currentPrUrl: null,
    qualificationSummary: "QUALIFIER is still assessing the ticket.",
    qualifierOutcome: null,
    lastError: null,
    lastErrorSummary: null,
    failureAttribution: null,
    retry: null,
    deployment: deploymentSummary(false, false, "grey", "not_eligible"),
    createdAt: now,
    lastManualRestartAt: null,
    updatedAt: now,
    totalTokensUsed: 0,
    estimatedCostUsd: 0,
    costSource: "estimated",
  };

  mockRuns = [row, ...mockRuns];
  return row;
}
