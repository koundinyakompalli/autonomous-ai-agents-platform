import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import {
  ERROR_DISPLAY_STATES,
  EXECUTING_STATES,
  QUEUED_STATES,
  TERMINAL_STATES,
  WAITING_STATES,
  normalizeDashboardStage,
} from "../shared/oneshotStateModel.js";
import type {
  OneShotDashboardRow,
  OneShotCostSource,
  OneShotProgressStage,
  OneShotRunTimelineResponse,
  OneShotStageDetail,
  OneShotTimelineEvent,
  OneShotTimelineEventTone,
  OneShotTimelineStageState,
} from "../types/oneshot.js";
import { getOneShotRowByDashboardId } from "./oneshot.js";
import {
  mergeCostSources,
  resolveArtifactCostContribution,
  type DashboardArtifactCostRow,
} from "./oneshotCosting.js";
import { parseDashboardId } from "./oneshotRowHelpers.js";

type JsonValue = Record<string, unknown> | string | null;

type TimelineEventRow = mysql.RowDataPacket & {
  id: number;
  oneshot_run_id: number;
  event_type: string;
  from_state: string | null;
  to_state: string | null;
  stage: string | null;
  metadata_json: JsonValue;
  occurred_at: Date | string;
};

type TimelineArtifactRow = mysql.RowDataPacket & {
  id: number;
  oneshot_run_id: number;
  stage: string;
  version: number;
  status: string;
  provider: string | null;
  model: string | null;
  metadata_json: JsonValue;
  started_at: Date | string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
};

const PIPELINE_STAGES: OneShotProgressStage[] = [
  "qualification",
  "planning",
  "review",
  "implementation",
  "code_review",
  "testing",
  "pr_complete",
];

function toIsoString(value: Date | string | null): string | null {
  if (!value) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function parseJsonObject(value: JsonValue): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return value;
}

function isSortMemoryError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : String(error ?? "");
  return /out of sort memory|sort buffer size/i.test(message);
}

function numberFromMetadata(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringFromMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isoFromMetadata(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  if (typeof value !== "string" || value.length === 0) return null;
  return toIsoString(value);
}

function normalizeArtifactStage(
  stage: string | null,
): OneShotProgressStage | null {
  if (stage === "test_result") return "testing";
  if (stage === "plan") return "planning";
  if (stage === "trace") return "planning";
  if (stage === "verify") return "planning";
  return normalizeDashboardStage(stage);
}

function artifactAttemptCountForStage(
  stage: OneShotProgressStage,
  artifacts: readonly TimelineArtifactRow[],
): number {
  if (stage !== "planning") return artifacts.length;

  const planVersions = new Set(
    artifacts
      .filter((artifact) => artifact.stage === "plan")
      .map((artifact) => artifact.version),
  );
  if (planVersions.size > 0) return planVersions.size;

  return new Set(artifacts.map((artifact) => artifact.version)).size;
}

function normalizeEventStage(
  row: TimelineEventRow,
): OneShotProgressStage | null {
  const normalized =
    normalizeDashboardStage(row.stage) ??
    normalizeDashboardStage(row.to_state) ??
    normalizeDashboardStage(row.from_state);
  if (normalized) return normalized;
  if (row.to_state === "pr_open" || row.to_state === "completed") {
    return "pr_complete";
  }
  return null;
}

interface StageCostAccumulator {
  tokens: number;
  hasTokens: boolean;
  usd: number;
  costSources: OneShotCostSource[];
}

function emptyStageCostAccumulator(): StageCostAccumulator {
  return {
    tokens: 0,
    hasTokens: false,
    usd: 0,
    costSources: [],
  };
}

function addStageCost(
  accumulators: Map<OneShotProgressStage, StageCostAccumulator>,
  stage: OneShotProgressStage,
  tokensUsed: number | null,
  contribution: { usd: number; source: "actual" | "estimated" } | null,
): void {
  const accumulator = accumulators.get(stage) ?? emptyStageCostAccumulator();
  if (tokensUsed !== null) {
    accumulator.tokens += tokensUsed;
    accumulator.hasTokens = true;
  }
  if (contribution) {
    accumulator.usd += contribution.usd;
    accumulator.costSources.push(contribution.source);
  }
  accumulators.set(stage, accumulator);
}

function hasCapturedCostMetric(metadata: Record<string, unknown>): boolean {
  return (
    (metadata.stage_cost_usd !== null &&
      metadata.stage_cost_usd !== undefined) ||
    (metadata.stage_tokens_used !== null &&
      metadata.stage_tokens_used !== undefined)
  );
}

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function buildCumulativeStageTotals(
  events: readonly OneShotTimelineEvent[],
  artifacts: readonly TimelineArtifactRow[],
): Map<
  OneShotProgressStage,
  {
    totalTokensUsed: number | null;
    totalCostUsd: number | null;
    totalCostSource: OneShotCostSource | null;
  }
> {
  const accumulators = new Map<OneShotProgressStage, StageCostAccumulator>();

  for (const artifact of artifacts) {
    const stage = normalizeArtifactStage(artifact.stage);
    if (!stage) continue;
    const metadata = parseJsonObject(artifact.metadata_json);
    const tokensUsed = numberFromMetadata(metadata, "stage_tokens_used");
    const contribution = hasCapturedCostMetric(metadata)
      ? resolveArtifactCostContribution({
          oneshot_run_id: artifact.oneshot_run_id,
          artifact_stage: artifact.stage,
          stage_cost_usd: numberFromMetadata(metadata, "stage_cost_usd"),
          stage_tokens_used: tokensUsed,
          provider: artifact.provider,
          model: artifact.model,
        } as DashboardArtifactCostRow)
      : null;
    addStageCost(accumulators, stage, tokensUsed, contribution);
  }

  for (const event of events) {
    if (event.eventType !== "stage_attempt_metrics" || !event.stage) continue;
    const tokensUsed = numberFromMetadata(event.metadata, "stage_tokens_used");
    const provider =
      typeof event.metadata.provider === "string"
        ? event.metadata.provider
        : null;
    const model =
      typeof event.metadata.model === "string" ? event.metadata.model : null;
    const contribution = hasCapturedCostMetric(event.metadata)
      ? resolveArtifactCostContribution({
          oneshot_run_id: 0,
          artifact_stage: event.stage,
          stage_cost_usd: numberFromMetadata(event.metadata, "stage_cost_usd"),
          stage_tokens_used: tokensUsed,
          provider,
          model,
        } as DashboardArtifactCostRow)
      : null;
    addStageCost(accumulators, event.stage, tokensUsed, contribution);
  }

  return new Map(
    Array.from(accumulators.entries()).map(([stage, accumulator]) => [
      stage,
      {
        totalTokensUsed: accumulator.hasTokens ? accumulator.tokens : null,
        totalCostUsd:
          accumulator.costSources.length > 0 ? roundUsd(accumulator.usd) : null,
        totalCostSource:
          accumulator.costSources.length > 0
            ? mergeCostSources(accumulator.costSources)
            : null,
      },
    ]),
  );
}

function stageIndex(stage: OneShotProgressStage): number {
  const idx = PIPELINE_STAGES.indexOf(stage);
  return idx >= 0 ? idx : 0;
}

function rowStageState(
  row: OneShotDashboardRow,
  stage: OneShotProgressStage,
): OneShotTimelineStageState {
  const currentIdx = stageIndex(row.progressStage);
  const idx = stageIndex(stage);

  if (idx < currentIdx) return "completed";
  if (idx > currentIdx) return "pending";

  if (row.displayState === "qualification_no_action") {
    return "skipped";
  }
  if ((EXECUTING_STATES as readonly string[]).includes(row.displayState)) {
    return "running";
  }
  if ((QUEUED_STATES as readonly string[]).includes(row.displayState)) {
    return "queued";
  }
  if (row.displayState === "pr_open") {
    return "completed";
  }
  if ((WAITING_STATES as readonly string[]).includes(row.displayState)) {
    return "waiting";
  }
  if ((ERROR_DISPLAY_STATES as readonly string[]).includes(row.displayState)) {
    return "failed";
  }
  if ((TERMINAL_STATES as readonly string[]).includes(row.displayState)) {
    return "completed";
  }
  return "pending";
}

function summarizeMetadata(metadata: Record<string, unknown>): string[] {
  const summary: string[] = [];

  const append = (label: string, value: unknown) => {
    if (value === null || value === undefined || value === "") return;
    summary.push(`${label}: ${String(value)}`);
  };
  const appendCount = (label: string, value: unknown) => {
    if (typeof value !== "number" || !Number.isFinite(value)) return;
    summary.push(`${label}: ${value}`);
  };

  const changedFiles = Array.isArray(metadata.changedFiles)
    ? metadata.changedFiles
    : null;
  const impactedFiles = Array.isArray(metadata.impactedFiles)
    ? metadata.impactedFiles
    : null;
  const executedCommands = Array.isArray(metadata.executedCommands)
    ? metadata.executedCommands
    : null;

  append("decision", metadata.decision);
  append("score", metadata.score);
  append("findings", metadata.findingsCount);
  append("revision", metadata.revision);
  append("implementation version", metadata.implementationVersion);
  append("plan version", metadata.plan_version);
  append("failure kind", metadata.failureKind);
  append("failure category", metadata.failureCategory);
  append("tokens", metadata.stage_tokens_used);
  append("cost", metadata.stage_cost_usd);
  append("model", metadata.model);
  append("tool calls", metadata.llm_tool_calls);
  append("grounding", metadata.grounding_confidence);
  append("candidate files", metadata.grounding_candidate_files);
  append("scout status", metadata.planner_scout_status);
  append("scout reports", metadata.planner_scout_reports);
  append("failed stage", metadata.failedStage);
  append("error", metadata.error);
  append("drift", metadata.driftStatus);
  append("previous base", metadata.previousBaseCommitSha);
  append("current head", metadata.currentHeadSha);
  append("drift files", metadata.changedFileCount);
  append("verify", metadata.recommendation);
  append("risk", metadata.riskLevel);
  appendCount("gaps", metadata.gapCount);
  appendCount("critical gaps", metadata.criticalGapCount);
  appendCount("high gaps", metadata.highGapCount);

  if (
    metadata.traceGuardrailResult &&
    typeof metadata.traceGuardrailResult === "object" &&
    !Array.isArray(metadata.traceGuardrailResult)
  ) {
    const traceGuardrails = metadata.traceGuardrailResult as Record<
      string,
      unknown
    >;
    if (typeof traceGuardrails.passed === "boolean") {
      summary.push(
        `TRACE guardrails: ${traceGuardrails.passed ? "passed" : "failed"}`,
      );
    }
  }
  if (
    metadata.verifyGuardrailResult &&
    typeof metadata.verifyGuardrailResult === "object" &&
    !Array.isArray(metadata.verifyGuardrailResult)
  ) {
    const verifyGuardrails = metadata.verifyGuardrailResult as Record<
      string,
      unknown
    >;
    if (typeof verifyGuardrails.passed === "boolean") {
      summary.push(
        `VERIFY guardrails: ${verifyGuardrails.passed ? "passed" : "failed"}`,
      );
    }
  }
  if (
    metadata.acceptanceCriteriaCoverage &&
    typeof metadata.acceptanceCriteriaCoverage === "object" &&
    !Array.isArray(metadata.acceptanceCriteriaCoverage)
  ) {
    const coverage = metadata.acceptanceCriteriaCoverage as Record<
      string,
      unknown
    >;
    const covered =
      typeof coverage.covered === "number" ? coverage.covered : null;
    const total = typeof coverage.total === "number" ? coverage.total : null;
    const percent =
      typeof coverage.coveragePercent === "number"
        ? coverage.coveragePercent
        : typeof coverage.percent === "number"
          ? coverage.percent
          : null;
    if (covered !== null && total !== null) {
      summary.push(
        `AC coverage: ${covered}/${total}${
          percent !== null ? ` (${percent}%)` : ""
        }`,
      );
    }
  }
  if (
    metadata.sectionCounts &&
    typeof metadata.sectionCounts === "object" &&
    !Array.isArray(metadata.sectionCounts)
  ) {
    const counts = metadata.sectionCounts as Record<string, unknown>;
    const a = typeof counts.A === "number" ? counts.A : null;
    const b = typeof counts.B === "number" ? counts.B : null;
    const c = typeof counts.C === "number" ? counts.C : null;
    if (a !== null || b !== null || c !== null) {
      summary.push(
        `TRACE sections: A=${a ?? "?"} B=${b ?? "?"} C=${c ?? "?"}`,
      );
    }
  }
  if (
    Array.isArray(metadata.sectionCTestCaseIds) &&
    metadata.sectionCTestCaseIds.length > 0
  ) {
    summary.push(`Section C tests: ${metadata.sectionCTestCaseIds.length}`);
  }
  if (Array.isArray(metadata.unverifiedClaims)) {
    summary.push(`unverified claims: ${metadata.unverifiedClaims.length}`);
  }
  if (Array.isArray(metadata.degradedModeDisclaimers)) {
    summary.push(`disclaimers: ${metadata.degradedModeDisclaimers.length}`);
  }

  if (changedFiles) {
    summary.push(
      `changed files: ${changedFiles.length}${
        changedFiles.length > 0
          ? ` (${changedFiles.slice(0, 3).join(", ")})`
          : ""
      }`,
    );
  }
  if (impactedFiles) {
    summary.push(
      `impacted files: ${impactedFiles.length}${
        impactedFiles.length > 0
          ? ` (${impactedFiles.slice(0, 3).join(", ")})`
          : ""
      }`,
    );
  }

  if (typeof metadata.passed === "boolean") {
    summary.push(metadata.passed ? "tests passed" : "tests failed");
  }
  append("pass count", metadata.passCount);
  append("fail count", metadata.failCount);
  append("skip count", metadata.skipCount);
  append("execution", metadata.executionKind);
  append("command source", metadata.commandSource);
  append("unverified", metadata.unverified);

  if (executedCommands) {
    summary.push(`commands: ${executedCommands.length}`);
  }
  if (Array.isArray(metadata.executedValidationChecks)) {
    summary.push(`validation checks: ${metadata.executedValidationChecks.length}`);
  }
  if (Array.isArray(metadata.skippedTestCommands) && metadata.skippedTestCommands.length > 0) {
    summary.push(`skipped test commands: ${metadata.skippedTestCommands.length}`);
  }

  return summary.slice(0, 10);
}

function publicMetadata(
  metadata: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const keys = [
    "reason",
    "version",
    "status",
    "started_at",
    "completed_at",
    "revision",
    "receiveCount",
    "maxAttempts",
    "failCount",
    "passCount",
    "skipCount",
    "prNumber",
    "prUrl",
    "failureKind",
    "failureCategory",
    "stage_tokens_used",
    "stage_cost_usd",
    "stage_duration_ms",
    "llm_tool_calls",
    "model",
    "provider",
    "grounding_confidence",
    "grounding_candidate_files",
    "planner_scout_status",
    "planner_scout_reports",
    "has_structured_output",
    "output_preview",
    "failedStage",
    "error",
    "stackPreview",
    "driftStatus",
    "previousBaseCommitSha",
    "currentHeadSha",
    "changedFileCount",
    "unverified",
    "exitCode",
    "payloadVersion",
    "currentVersion",
    "requestedRepublish",
    "traceS3Key",
    "traceCsvS3Key",
    "verifyS3Key",
    "recommendation",
    "riskLevel",
    "gapCount",
    "criticalGapCount",
    "highGapCount",
    "verifyRecommendation",
    "verifyRiskLevel",
    "verifyGapCount",
    "filename",
    "attachmentStatus",
    "commentStatus",
    "notificationId",
  ];
  const result: Record<string, string | number | boolean | null> = {};
  for (const key of keys) {
    const value = metadata[key];
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      result[key] = value;
    }
  }
  return result;
}

function eventTone(row: TimelineEventRow): OneShotTimelineEventTone {
  if (row.event_type === "artifact_generation_failed") return "error";
  if (row.event_type === "stage_attempt_metrics") return "warning";
  if (row.to_state === "pr_open") {
    const metadata = parseJsonObject(row.metadata_json);
    const readinessValue =
      metadata.readiness &&
      typeof metadata.readiness === "object" &&
      !Array.isArray(metadata.readiness)
        ? (metadata.readiness as Record<string, unknown>).readiness
        : null;
    return readinessValue === "ready" ? "success" : "warning";
  }
  if (
    row.to_state &&
    (WAITING_STATES as readonly string[]).includes(row.to_state)
  ) {
    return "warning";
  }
  if (
    row.to_state &&
    (ERROR_DISPLAY_STATES as readonly string[]).includes(row.to_state)
  ) {
    return "error";
  }
  if (row.to_state === "completed") return "success";
  if (
    row.event_type === "run_claimed" ||
    row.event_type === "artifact_stored" ||
    row.event_type === "base_refreshed"
  ) {
    return "info";
  }
  return "muted";
}

function eventLabel(
  row: TimelineEventRow,
  metadata: Record<string, unknown>,
): string {
  if (row.event_type === "state_transition") {
    const from = row.from_state ?? "unknown";
    const to = row.to_state ?? "unknown";
    const reason =
      typeof metadata.reason === "string" ? ` · ${metadata.reason}` : "";
    return `${from} → ${to}${reason}`;
  }
  if (row.event_type === "run_claimed") {
    return `Worker claimed ${row.stage ?? "run"}`;
  }
  if (row.event_type === "artifact_stored") {
    return `Artifact stored${row.stage ? ` for ${row.stage}` : ""}`;
  }
  if (row.event_type === "artifact_generation_failed") {
    return `Artifact generation failed${row.stage ? ` for ${row.stage}` : ""}`;
  }
  if (row.event_type === "stage_attempt_metrics") {
    const parsedTokens = numberFromMetadata(metadata, "stage_tokens_used");
    const tokens =
      parsedTokens !== null ? ` · ${parsedTokens} token(s)` : "";
    return `Stage attempt metrics${row.stage ? ` for ${row.stage}` : ""}${tokens}`;
  }
  if (row.event_type === "trace_generated") {
    return "TRACE test cases generated";
  }
  if (row.event_type === "verify_completed") {
    const recommendation =
      typeof metadata.recommendation === "string"
        ? ` · ${metadata.recommendation}`
        : "";
    const risk =
      typeof metadata.riskLevel === "string" ? ` · risk ${metadata.riskLevel}` : "";
    return `VERIFY completed${recommendation}${risk}`;
  }
  if (row.event_type === "trace_jira_attachment_skipped") {
    return "TRACE Jira attachment skipped";
  }
  if (row.event_type === "trace_jira_attachment_failed") {
    return "TRACE Jira attachment failed";
  }
  if (row.event_type === "trace_jira_comment_failed") {
    return "TRACE Jira comment failed";
  }
  if (row.event_type === "trace_jira_post_completed") {
    const attachment =
      typeof metadata.attachmentStatus === "string"
        ? ` · attachment ${metadata.attachmentStatus}`
        : "";
    const comment =
      typeof metadata.commentStatus === "string"
        ? ` · comment ${metadata.commentStatus}`
        : "";
    return `TRACE Jira post recorded${attachment}${comment}`;
  }
  if (row.event_type === "base_refreshed") {
    const count =
      typeof metadata.changedFileCount === "number"
        ? ` · ${metadata.changedFileCount} drift file(s)`
        : "";
    return `Base refreshed${row.stage ? ` for ${row.stage}` : ""}${count}`;
  }
  if (row.event_type === "ci_refresh_requested") {
    return "CI readiness refresh requested";
  }
  return row.event_type.replace(/_/g, " ");
}

function mapEvent(row: TimelineEventRow): OneShotTimelineEvent {
  const metadata = parseJsonObject(row.metadata_json);
  return {
    id: String(row.id),
    occurredAt: toIsoString(row.occurred_at)!,
    eventType: row.event_type,
    stage: normalizeEventStage(row),
    fromState: row.from_state,
    toState: row.to_state,
    tone: eventTone(row),
    label: eventLabel(row, metadata),
    metadata: publicMetadata(metadata),
  };
}

async function fetchRunEvents(runId: number): Promise<TimelineEventRow[]> {
  const [rows] = await getPool().query<TimelineEventRow[]>(
    `SELECT id, oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at
     FROM oneshot_run_events
     WHERE oneshot_run_id = ?
     ORDER BY occurred_at ASC, id ASC`,
    [runId],
  );
  return rows;
}

async function fetchRunArtifacts(
  runId: number,
): Promise<TimelineArtifactRow[]> {
  const [rows] = await getPool().query<TimelineArtifactRow[]>(
    `SELECT id, oneshot_run_id, stage, version, status, provider, model, metadata_json,
            started_at, completed_at, created_at
     FROM oneshot_artifacts
     WHERE oneshot_run_id = ?
     ORDER BY created_at ASC, version ASC, id ASC`,
    [runId],
  );
  return rows;
}

function buildStageDetails(
  row: OneShotDashboardRow,
  events: readonly OneShotTimelineEvent[],
  artifacts: readonly TimelineArtifactRow[],
): OneShotStageDetail[] {
  const eventsByStage = new Map<OneShotProgressStage, OneShotTimelineEvent[]>();
  const attemptsByStage = new Map<OneShotProgressStage, number>();
  const artifactsByStage = new Map<
    OneShotProgressStage,
    TimelineArtifactRow[]
  >();
  const attemptMetricsByStage = new Map<
    OneShotProgressStage,
    OneShotTimelineEvent[]
  >();
  const cumulativeTotals = buildCumulativeStageTotals(events, artifacts);

  for (const event of events) {
    if (!event.stage) continue;
    const stageEvents = eventsByStage.get(event.stage) ?? [];
    stageEvents.push(event);
    eventsByStage.set(event.stage, stageEvents);
    if (event.eventType === "run_claimed") {
      attemptsByStage.set(
        event.stage,
        (attemptsByStage.get(event.stage) ?? 0) + 1,
      );
    }
    if (event.eventType === "stage_attempt_metrics") {
      const metricEvents = attemptMetricsByStage.get(event.stage) ?? [];
      metricEvents.push(event);
      attemptMetricsByStage.set(event.stage, metricEvents);
    }
  }

  for (const artifact of artifacts) {
    const stage = normalizeArtifactStage(artifact.stage);
    if (!stage) continue;
    const stageArtifacts = artifactsByStage.get(stage) ?? [];
    stageArtifacts.push(artifact);
    artifactsByStage.set(stage, stageArtifacts);
  }

  return PIPELINE_STAGES.map((stage) => {
    const stageArtifacts = artifactsByStage.get(stage) ?? [];
    const latestArtifact =
      stageArtifacts
        .slice()
        .sort((a, b) => b.version - a.version || b.id - a.id)[0] ?? null;
    const metadata = latestArtifact
      ? parseJsonObject(latestArtifact.metadata_json)
      : {};
    const latestAttemptMetrics =
      (attemptMetricsByStage.get(stage) ?? []).slice(-1)[0] ?? null;
    const attemptMetadata = latestAttemptMetrics?.metadata ?? {};
    const state = rowStageState(row, stage);
    const preferAttemptMetrics =
      Boolean(latestAttemptMetrics) &&
      state !== "completed" &&
      state !== "skipped";
    const displayMetadata = preferAttemptMetrics
      ? attemptMetadata
      : latestArtifact
        ? metadata
        : attemptMetadata;
    const attemptStatus =
      stringFromMetadata(attemptMetadata, "status") ??
      (state === "failed"
        ? "failed attempt"
        : preferAttemptMetrics
          ? "attempt metrics"
          : null);
    const stageEvents = eventsByStage.get(stage) ?? [];
    const lastEvent = stageEvents[stageEvents.length - 1] ?? null;
    const artifactAttempts = artifactAttemptCountForStage(
      stage,
      stageArtifacts,
    );
    const claimAttempts = attemptsByStage.get(stage) ?? 0;
    const stageTotals = cumulativeTotals.get(stage) ?? {
      totalTokensUsed: null,
      totalCostUsd: null,
      totalCostSource: null,
    };

    return {
      stage,
      state,
      attempts: Math.max(claimAttempts, artifactAttempts),
      latestVersion: preferAttemptMetrics
        ? numberFromMetadata(attemptMetadata, "version")
        : latestArtifact?.version ?? null,
      artifactStatus: preferAttemptMetrics
        ? attemptStatus
        : latestArtifact?.status ?? null,
      startedAt: preferAttemptMetrics
        ? isoFromMetadata(attemptMetadata, "started_at")
        : toIsoString(latestArtifact?.started_at ?? null),
      completedAt: preferAttemptMetrics
        ? isoFromMetadata(attemptMetadata, "completed_at") ??
          (state === "failed" ? latestAttemptMetrics?.occurredAt ?? null : null)
        : toIsoString(latestArtifact?.completed_at ?? null),
      durationMs: numberFromMetadata(displayMetadata, "stage_duration_ms"),
      tokensUsed: numberFromMetadata(displayMetadata, "stage_tokens_used"),
      costUsd: numberFromMetadata(displayMetadata, "stage_cost_usd"),
      totalTokensUsed: stageTotals.totalTokensUsed,
      totalCostUsd: stageTotals.totalCostUsd,
      totalCostSource: stageTotals.totalCostSource,
      provider:
        (!preferAttemptMetrics ? latestArtifact?.provider : null) ??
        (typeof attemptMetadata.provider === "string"
          ? attemptMetadata.provider
          : null),
      model:
        (!preferAttemptMetrics ? latestArtifact?.model : null) ??
        (typeof attemptMetadata.model === "string"
          ? attemptMetadata.model
          : null),
      metadataSummary: summarizeMetadata(displayMetadata),
      eventCount: stageEvents.length,
      lastEventAt: lastEvent?.occurredAt ?? null,
    };
  });
}

export function buildFallbackTimeline(
  row: OneShotDashboardRow,
): OneShotRunTimelineResponse {
  const stages = PIPELINE_STAGES.map<OneShotStageDetail>((stage) => ({
    stage,
    state: rowStageState(row, stage),
    attempts: stage === row.progressStage && row.oneshotRunId ? 1 : 0,
    latestVersion: null,
    artifactStatus: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    tokensUsed: null,
    costUsd: null,
    totalTokensUsed: null,
    totalCostUsd: null,
    totalCostSource: null,
    provider: null,
    model: null,
    metadataSummary:
      stage === row.progressStage
        ? [
            `dashboard state: ${row.displayState}`,
            `progress: ${row.progressPercent}%`,
            row.qualificationSummary ?? row.lastErrorSummary ?? "",
          ].filter(Boolean)
        : [],
    eventCount: 0,
    lastEventAt: null,
  }));

  return {
    dashboardId: row.dashboardId,
    oneshotRunId: row.oneshotRunId,
    updatedAt: row.updatedAt,
    isFallback: true,
    completionStatus: row.completionStatus ?? null,
    readiness: row.readiness ?? null,
    readinessReasons: row.readinessReasons ?? [],
    stages,
    events: [],
  };
}

export async function getOneShotRunTimeline(
  dashboardId: string,
): Promise<OneShotRunTimelineResponse | null> {
  const row = await getOneShotRowByDashboardId(dashboardId);
  if (!row) return null;

  const lookup = parseDashboardId(dashboardId);
  if (!lookup || lookup.kind !== "run" || row.oneshotRunId == null) {
    return buildFallbackTimeline(row);
  }

  const [eventResult, artifactResult] = await Promise.allSettled([
    fetchRunEvents(lookup.id),
    fetchRunArtifacts(lookup.id),
  ]);
  const failedResults = [eventResult, artifactResult].filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  const nonSortFailure = failedResults.find(
    (result) => !isSortMemoryError(result.reason),
  );
  if (nonSortFailure) {
    throw nonSortFailure.reason;
  }
  if (
    eventResult.status !== "fulfilled" ||
    artifactResult.status !== "fulfilled"
  ) {
    return buildFallbackTimeline(row);
  }
  const eventRows = eventResult.value;
  const artifactRows = artifactResult.value;
  const events = eventRows.map(mapEvent);

  return {
    dashboardId: row.dashboardId,
    oneshotRunId: row.oneshotRunId,
    updatedAt: row.updatedAt,
    isFallback: false,
    completionStatus: row.completionStatus ?? null,
    readiness: row.readiness ?? null,
    readinessReasons: row.readinessReasons ?? [],
    stages: buildStageDetails(row, events, artifactRows),
    events,
  };
}
