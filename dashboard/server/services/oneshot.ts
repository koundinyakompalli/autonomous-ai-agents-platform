import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import {
  buildDeploymentSummaryFromRecord,
  getLatestDeploymentsByRunIds,
} from "./oneshotDeployments.js";
import { buildOneShotDashboardAnalytics } from "./oneshotAnalytics.js";
import { classifyFailureForRow } from "./failureAttribution.js";
import { QUEUED_STATES, TERMINAL_STATES } from "../shared/oneshotStateModel.js";
import { ROUTER_SHIP_ISO } from "../shared/routerVersion.js";
import {
  aggregateArtifactCostsByRun,
  buildDisplayCostSummary,
  type DashboardArtifactCostRow,
} from "./oneshotCosting.js";
import {
  EXECUTING_STATES,
  bucketForView,
  inferBlockedOrEscalatedStage,
  inferFailedStage,
  inferReplanRequiredStage,
  mapTransientRetryMetadata,
  parseDashboardId,
  progressForFailedStage,
  progressForPausedStage,
  type FailedProgressStage,
  type PausedProgressStage,
  type RetryEtaData,
} from "./oneshotRowHelpers.js";
import { normalizeOneShotTicketType } from "../shared/ticketType.js";
import type {
  OneShotDashboardCapabilities,
  OneShotArtifactRun,
  OneShotArtifactRunMode,
  OneShotArtifactRunTicket,
  OneShotDashboardRow,
  OneShotCostSource,
  OneShotDisplayState,
  OneShotProgressStage,
  OneShotRetryCapability,
  OneShotTicketType,
  OneShotRunsQuery,
  OneShotRunsResponse,
  OneShotRunsStats,
  QualifierOutcome,
} from "../types/oneshot.js";
import type { OneShotDeploymentRecord } from "../types/oneshotDeployments.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const DEFAULT_CAPABILITIES: OneShotDashboardCapabilities = {
  createRun: false,
  createRunMode: "request",
  deployPreviewAvailable: false,
  deployPreview: false,
};

// ── Error summarizer ──────────────────────────────────────────────────────────
// Converts raw lastError strings (Zod JSON arrays, timeout strings, plain
// text) into a one-line human-readable summary. The full raw value is still
// sent on the row for the modal's expandable details section.

function summarizeRunError(raw: string | null): string | null {
  if (!raw) return null;

  // Zod validation-error array: [{expected,code,path,message},…]
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (Array.isArray(parsed) && parsed.length > 0) {
    const fields = parsed
      .map((e) => {
        if (
          e &&
          typeof e === "object" &&
          "path" in e &&
          Array.isArray((e as { path: unknown[] }).path)
        ) {
          return (e as { path: unknown[] }).path.join(".");
        }
        return null;
      })
      .filter((f): f is string => Boolean(f));

    if (fields.length > 0) {
      const shown = fields.slice(0, 3).join(", ");
      const extra = fields.length > 3 ? ` +${fields.length - 3} more` : "";
      return `Validation failed — missing fields: ${shown}${extra}`;
    }
    return `Validation failed — ${parsed.length} error${parsed.length !== 1 ? "s" : ""}`;
  }

  // SDK / generic timeout
  if (/planner_no_progress/i.test(raw)) {
    return "Planner made no repository-tool progress before timeout";
  }

  if (/sdk timeout/i.test(raw)) {
    const ms = raw.match(/(\d+)\s*ms/i);
    return ms
      ? `SDK timeout after ${Math.round(Number(ms[1]) / 60000)}m`
      : "SDK timeout";
  }

  // Plain string — just truncate
  return truncate(raw, 120);
}
const DEFAULT_QUALIFICATION_FAILURES = 10;
const DEFAULT_MAX_REVIEW_LOOPS = 3;
const MANUAL_STAGE_RETRY_MAX = 2;

export class OneShotTicketTypeUpdateError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "OneShotTicketTypeUpdateError";
  }
}

function normalizeDashboardWorkspaceMode(_value: unknown): "v2" {
  return "v2";
}

type JsonValue = unknown;
type RetryableRunStage = Exclude<
  OneShotProgressStage,
  "qualification" | "pr_complete"
>;

type OneShotRunRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  jira_key: string;
  jira_issue_type: string | null;
  ticket_type: string | null;
  ticket_type_source: string | null;
  ticket_type_updated_by: string | null;
  ticket_type_updated_at: Date | string | null;
  source_task_management_id: number;
  customer_name: string | null;
  workspace_mode: "v2" | string | null;
  state: Exclude<
    OneShotDisplayState,
    "qualification_pending" | "qualification_failed" | "qualification_no_action"
  >;
  review_loop_count: number;
  max_review_loops: number;
  verification_loop_count: number;
  max_verification_loops: number;
  current_pr_url: string | null;
  current_plan_version: number | null;
  current_review_version: number | null;
  current_implementation_version: number | null;
  current_code_review_version: number | null;
  current_test_version: number | null;
  final_disposition: string | null;
  last_error: string | null;
  repo_name: string | null;
  repo_url: string | null;
  branch_name: string | null;
  base_commit_sha: string | null;
  run_branch_name: string | null;
  run_branch_base_sha: string | null;
  run_branch_created_at: Date | string | null;
  task_description: string | null;
  implementation_metadata_json: JsonValue;
  workspace_phase: string | null;
  workspace_head_sha: string | null;
  current_candidate_version: number | null;
  current_candidate_sha: string | null;
  last_repo_fetch_at: Date | string | null;
  last_remote_head_sha: string | null;
  total_tokens_used: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  run_group_id: number | null;
  run_group_metadata_json: JsonValue;
};

type OneShotRunIdRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
};

type OneShotTicketTypeRow = mysql.RowDataPacket & {
  id: number;
  ticket_type: string | null;
  ticket_type_source: string | null;
  state: string;
};

type LatestTransitionStageRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  to_state: "failed" | "blocked" | "escalated" | "replan_required";
  transition_stage: string | null;
};

type LatestArtifactStageRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  latest_artifact_stage: string | null;
};

type ManualRetryCountRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  retry_stage: string | null;
  retry_count: number;
};

type ManualStageRestartRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  occurred_at: Date | string;
};

type ReadinessEventRow = mysql.RowDataPacket & {
  id: number;
  oneshot_run_id: number;
  event_type: string;
  metadata_json: JsonValue;
};

interface RunReadinessEvidence {
  completionStatus: OneShotDashboardRow["completionStatus"] | null;
  readiness: OneShotDashboardRow["readiness"] | null;
  readinessReasons: string[];
  riskAssessment: Record<string, unknown> | null;
  externalSpecEvidence: Record<string, unknown> | null;
  ciStatus: Record<string, unknown> | null;
  unverifiedTests: string[];
  plannerAttemptDiagnostics: Record<string, unknown> | null;
  sdkLifecycleSummary: Record<string, unknown> | null;
}

type QualifierTaskRow = mysql.RowDataPacket & {
  task_management_id: number;
  jira_number: string;
  task_status:
    | "assigned"
    | "in_progress"
    | "waiting_repo_confirmation"
    | "posting_to_jira"
    | "completed"
    | "posted_to_jira"
    | "failed";
  customer_name: string | null;
  task_description: string | null;
  error_message: string | null;
  metrics_json: JsonValue;
  created_at: Date | string;
  updated_at: Date | string;
};

type ArtifactRunRow = mysql.RowDataPacket & {
  id: number;
  source_key: string;
  source_parent_key: string | null;
  mode: OneShotArtifactRunMode;
  status: string;
  title: string;
  generated_count: number;
  generated_tickets_json: JsonValue;
  human_review_required: number | boolean;
  human_review_count: number;
  review_items_json: JsonValue;
  evidence_json: JsonValue;
  artifact_refs_json: JsonValue;
  jira_summary: string | null;
  completed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

interface RunNormalizationContext {
  deploymentByRunId: Map<number, OneShotDeploymentRecord>;
  transitionStageByRunState: Map<string, string | null>;
  latestArtifactStageByRunId: Map<number, string | null>;
  manualRetryCountByRunStage: Map<string, number>;
  latestManualRestartAtByRunId: Map<number, Date | string>;
  costSummaryByRunId: Map<
    number,
    { estimatedCostUsd: number; costSource: OneShotCostSource }
  >;
  readinessEvidenceByRunId: Map<number, RunReadinessEvidence>;
  retryEtaByRunState: Map<string, RetryEtaData>;
}

function makeTransitionStageKey(
  runId: number,
  state: "failed" | "blocked" | "escalated" | "replan_required",
): string {
  return `${runId}:${state}`;
}

function makeManualRetryStageKey(
  runId: number,
  stage: RetryableRunStage,
): string {
  return `${runId}:${stage}`;
}

function makeRetryEtaStateKey(runId: number, state: string): string {
  return `${runId}:${state}`;
}

function normalizeRetryableStage(
  stage: string | null | undefined,
): RetryableRunStage | null {
  switch (stage) {
    case "planning":
    case "review":
    case "implementation":
    case "code_review":
    case "testing":
      return stage;
    default:
      return null;
  }
}

function parseJsonObject(value: JsonValue): Record<string, unknown> | null {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  return asRecord(value);
}

function parseJsonArray(value: JsonValue): unknown[] {
  if (!value) {
    return [];
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? value : [];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function normalizeDiagnosticArtifactKeys(
  value: unknown,
): Record<string, string> | null {
  const record = asRecord(value);
  if (record) {
    const normalized = Object.entries(record).reduce<Record<string, string>>(
      (acc, [key, artifactKey]) => {
        if (typeof artifactKey === "string" && artifactKey.length > 0) {
          acc[key] = artifactKey;
        }
        return acc;
      },
      {},
    );
    return Object.keys(normalized).length > 0 ? normalized : null;
  }

  const keys = stringArray(value);
  if (keys.length === 0) return null;

  const normalized: Record<string, string> = {};
  keys.forEach((artifactKey, index) => {
    if (artifactKey.includes("sdk-lifecycle")) {
      normalized.sdkLifecycle = artifactKey;
    } else if (artifactKey.includes("sdk-message-summary")) {
      normalized.sdkMessageSummary = artifactKey;
    } else if (artifactKey.includes("tool-call-profile")) {
      normalized.toolCallProfiles = artifactKey;
    } else if (artifactKey.includes("sdk-raw-trace")) {
      normalized.rawTrace = artifactKey;
    } else if (artifactKey.includes("planner-failed-output")) {
      normalized.failedOutput = artifactKey;
    } else if (artifactKey.includes("planner-failed-draft-plan")) {
      normalized.draftPlan = artifactKey;
    } else if (artifactKey.includes("planner-grounding-diagnostics")) {
      normalized.groundingDiagnostics = artifactKey;
    } else {
      normalized[`artifact${index + 1}`] = artifactKey;
    }
  });
  return normalized;
}

function parseCompletionStatus(
  value: unknown,
): OneShotDashboardRow["completionStatus"] | null {
  switch (value) {
    case "completed_ready":
    case "completed_draft":
    case "completed_needs_review":
    case "completed_with_risks":
      return value;
    case "completed_no_action":
      return value;
    default:
      return null;
  }
}

function parseReadiness(
  value: unknown,
): OneShotDashboardRow["readiness"] | null {
  switch (value) {
    case "ready":
    case "draft":
    case "needs_review":
    case "with_risks":
      return value;
    case "no_action":
      return value;
    default:
      return null;
  }
}

function extractReadinessEvidence(
  events: ReadinessEventRow[],
): RunReadinessEvidence {
  const latestReadiness =
    [...events]
      .reverse()
      .map((event) => parseJsonObject(event.metadata_json))
      .find((metadata) => asRecord(metadata?.readiness)) ?? null;
  const latestRisk =
    [...events]
      .reverse()
      .map((event) => parseJsonObject(event.metadata_json))
      .find(
        (metadata) =>
          asRecord(metadata?.riskAssessment) ||
          asRecord(metadata?.planRiskAssessment) ||
          Array.isArray(metadata?.categories),
      ) ?? null;
  const readiness = asRecord(latestReadiness?.readiness);
  const reasons = Array.isArray(readiness?.reasons)
    ? readiness.reasons
        .map((reason) => asRecord(reason)?.message)
        .filter(
          (message): message is string =>
            typeof message === "string" && message.length > 0,
        )
    : [];
  const unverifiedFromMetadata = stringArray(latestReadiness?.unverifiedTests);
  const testResult = asRecord(latestReadiness?.testResult);
  const testResultUnverified = testResult?.unverified === true;
  const latestLifecycle =
    [...events]
      .reverse()
      .map((event) => parseJsonObject(event.metadata_json))
      .find(
        (metadata) =>
          asRecord(metadata?.sdkLifecycleSummary) ||
          asRecord(metadata?.sdk_lifecycle_summary),
      ) ?? null;
  const sdkLifecycleSummary =
    asRecord(latestLifecycle?.sdkLifecycleSummary) ??
    asRecord(latestLifecycle?.sdk_lifecycle_summary);
  const latestPlannerDiagnostics =
    [...events]
      .reverse()
      .map((event) => parseJsonObject(event.metadata_json))
      .find(
        (metadata) =>
          metadata?.reason === "planner_failed_attempt" ||
          metadata?.reason === "planner_completed" ||
          asRecord(metadata?.plannerStructuredOutputRepair) ||
          asRecord(metadata?.planner_structured_output_repair),
      ) ?? null;

  return {
    completionStatus: parseCompletionStatus(readiness?.completionStatus),
    readiness: parseReadiness(readiness?.readiness),
    readinessReasons: reasons,
    riskAssessment:
      asRecord(latestReadiness?.riskAssessment) ??
      asRecord(latestRisk?.riskAssessment) ??
      asRecord(latestRisk),
    externalSpecEvidence:
      asRecord(latestReadiness?.externalSpecEvidence) ??
      asRecord(latestRisk?.externalSpecEvidence),
    ciStatus: asRecord(latestReadiness?.ciStatus),
    unverifiedTests:
      unverifiedFromMetadata.length > 0
        ? unverifiedFromMetadata
        : testResultUnverified
          ? stringArray(testResult?.skippedTestCommands)
          : [],
    plannerAttemptDiagnostics: latestPlannerDiagnostics
      ? {
          reason: latestPlannerDiagnostics.reason ?? null,
          failureKind: latestPlannerDiagnostics.failureKind ?? null,
          failureCategory: latestPlannerDiagnostics.failureCategory ?? null,
          version: latestPlannerDiagnostics.version ?? null,
          revision: latestPlannerDiagnostics.revision ?? null,
          schemaRepair:
            latestPlannerDiagnostics.plannerStructuredOutputRepair ??
            latestPlannerDiagnostics.planner_structured_output_repair ??
            null,
          toolBudgetUsed:
            sdkLifecycleSummary?.toolBudgetUsed ??
            latestPlannerDiagnostics.tool_budget_used ??
            null,
          toolBudgetLimit:
            sdkLifecycleSummary?.toolBudgetLimit ??
            latestPlannerDiagnostics.tool_budget_limit ??
            null,
          toolBudgetDenials:
            sdkLifecycleSummary?.toolBudgetDenials ??
            latestPlannerDiagnostics.tool_budget_denials ??
            null,
          postToolIdleTimeoutMs:
            sdkLifecycleSummary?.postToolIdleTimeoutMs ??
            latestPlannerDiagnostics.post_tool_idle_timeout_ms ??
            null,
          diagnosticArtifactKeys:
            normalizeDiagnosticArtifactKeys(
              latestPlannerDiagnostics.diagnosticArtifactKeys,
            ) ??
            normalizeDiagnosticArtifactKeys(
              latestPlannerDiagnostics.planner_diagnostic_artifacts,
            ) ??
            {},
        }
      : null,
    sdkLifecycleSummary,
  };
}

function parseQualifierOutcome(value: JsonValue): QualifierOutcome | null {
  const metadata = parseJsonObject(value);
  const rawOutcome = metadata?.qualifierOutcome;
  if (!rawOutcome || typeof rawOutcome !== "object") {
    return null;
  }

  const outcome = rawOutcome as Record<string, unknown>;
  if (
    typeof outcome.disposition !== "string" ||
    typeof outcome.reasonCode !== "string" ||
    typeof outcome.reason !== "string"
  ) {
    return null;
  }
  const rawRepoResolution = outcome.repoResolution;
  const rawOutcomeMetadata = outcome.metadata;
  const repoResolution =
    rawRepoResolution && typeof rawRepoResolution === "object"
      ? (rawRepoResolution as Record<string, unknown>)
      : null;
  const outcomeMetadata =
    rawOutcomeMetadata &&
    typeof rawOutcomeMetadata === "object" &&
    !Array.isArray(rawOutcomeMetadata)
      ? (rawOutcomeMetadata as Record<string, unknown>)
      : typeof metadata?.routerVersion === "string"
        ? { routerVersion: metadata.routerVersion }
        : null;

  return {
    disposition: outcome.disposition as QualifierOutcome["disposition"],
    reasonCode: outcome.reasonCode as QualifierOutcome["reasonCode"],
    reason: outcome.reason,
    qualifierMode:
      outcome.qualifierMode === "fresh" ||
      outcome.qualifierMode === "force_approve" ||
      outcome.qualifierMode === "replan"
        ? outcome.qualifierMode
        : null,
    labels: Array.isArray(outcome.labels)
      ? outcome.labels.filter(
          (label): label is string => typeof label === "string",
        )
      : [],
    latestRunState:
      typeof outcome.latestRunState === "string"
        ? outcome.latestRunState
        : null,
    ...(repoResolution &&
    typeof repoResolution.disposition === "string" &&
    typeof repoResolution.source === "string"
      ? {
          repoResolution: {
            disposition: repoResolution.disposition,
            source: repoResolution.source,
            matchedRepos: Array.isArray(repoResolution.matchedRepos)
              ? repoResolution.matchedRepos.filter(
                  (repo): repo is string => typeof repo === "string",
                )
              : [],
            candidateRepos: Array.isArray(repoResolution.candidateRepos)
              ? repoResolution.candidateRepos.filter(
                  (repo): repo is string => typeof repo === "string",
                )
              : [],
            evidence: Array.isArray(repoResolution.evidence)
              ? repoResolution.evidence.filter(
                  (item): item is string => typeof item === "string",
                )
              : [],
          },
        }
      : {}),
    ...(typeof outcome.gateScore === "number"
      ? { gateScore: outcome.gateScore }
      : {}),
    ...(outcome.gateDisposition === "hard_fail" ||
    outcome.gateDisposition === "direct_qualify" ||
    outcome.gateDisposition === "code_adjudicate"
      ? { gateDisposition: outcome.gateDisposition }
      : {}),
    ...(typeof outcome.acceptanceCriteriaPresent === "boolean"
      ? { acceptanceCriteriaPresent: outcome.acceptanceCriteriaPresent }
      : {}),
    metadata: outcomeMetadata,
  };
}

function parseQualifierCostSummary(value: JsonValue): {
  tokens: number;
  usd: number;
  source: OneShotCostSource;
} {
  const metadata = parseJsonObject(value);
  if (!metadata) {
    return { tokens: 0, usd: 0, source: "estimated" };
  }
  const tokenSource =
    typeof metadata.totalTokens === "object" && metadata.totalTokens !== null
      ? (metadata.totalTokens as Record<string, unknown>)
      : typeof metadata.tokensUsed === "object" && metadata.tokensUsed !== null
        ? (metadata.tokensUsed as Record<string, unknown>)
        : null;
  const input =
    typeof tokenSource?.input === "number" && Number.isFinite(tokenSource.input)
      ? tokenSource.input
      : 0;
  const output =
    typeof tokenSource?.output === "number" &&
    Number.isFinite(tokenSource.output)
      ? tokenSource.output
      : 0;
  const cost =
    typeof metadata.costUsd === "number" && Number.isFinite(metadata.costUsd)
      ? metadata.costUsd
      : typeof metadata.cost === "number" && Number.isFinite(metadata.cost)
        ? metadata.cost
        : 0;
  return {
    tokens: input + output,
    usd: Number(cost.toFixed(6)),
    source: cost > 0 ? "actual" : "estimated",
  };
}

function toIsoString(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function truncate(text: string, maxLength = 180): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

// Strip leading Jira-key prefixes: CPDEV-123, CPDEV-123:, CPDEV-123 -, [CPDEV-123], etc.
function stripJiraPrefix(text: string, jiraKey: string): string {
  const escaped = jiraKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(
      new RegExp(
        `^(?:\\[${escaped}\\]|${escaped})(?:\\s*[-–—:]\\s*|\\s+)`,
        "i",
      ),
      "",
    )
    .trim();
}

function extractTitle(taskDescription: string | null, jiraKey: string): string {
  if (!taskDescription) {
    return jiraKey;
  }

  const lines = taskDescription
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const taskHeading = lines.find((line) => /^#\s*Task:/i.test(line));
  if (taskHeading) {
    let title = taskHeading.replace(/^#\s*Task:\s*/i, "").trim();
    title = stripJiraPrefix(title, jiraKey);
    return truncate(title || jiraKey);
  }

  const firstUsefulLine = lines.find((line) => !/^#{1,6}\s/.test(line));
  const candidate = firstUsefulLine
    ? stripJiraPrefix(firstUsefulLine, jiraKey)
    : null;
  return truncate(candidate || jiraKey);
}

function getQualificationSummary(
  displayState: OneShotDisplayState,
  title: string,
  lastError: string | null,
): string | null {
  switch (displayState) {
    case "qualification_pending":
      return `QUALIFIER is still assessing ${title}.`;
    case "repo_confirmation_pending":
      return "QUALIFIER is waiting for repository confirmation.";
    case "qualification_failed":
      return (
        lastError ||
        "Ticket did not qualify for OneShot. Review the JIRA comment for the blocking reasons."
      );
    default:
      return null;
  }
}

function buildImplementationBranchName(jiraKey: string, runId: number): string {
  const normalizedKey = jiraKey.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return `oneshot/${normalizedKey}-run-${runId}`;
}

function isRetryPendingState(
  displayState: OneShotDisplayState,
  lastError: string | null,
): boolean {
  return (
    Boolean(lastError) &&
    QUEUED_STATES.includes(displayState as (typeof QUEUED_STATES)[number]) &&
    !TERMINAL_STATES.includes(displayState as (typeof TERMINAL_STATES)[number])
  );
}

function isStaleRouterOutcome(
  qualifierOutcome: QualifierOutcome | null,
  createdAt: Date | string,
): boolean {
  if (qualifierOutcome?.reasonCode !== "repo_resolution_failed") {
    return false;
  }
  if (qualifierOutcome.metadata?.routerVersion) {
    return false;
  }
  return new Date(createdAt).getTime() < Date.parse(ROUTER_SHIP_ISO);
}

function getImplementationMetadata(row: OneShotRunRow): {
  implementationBranch: string | null;
  implementationCommitSha: string | null;
} {
  const implementationMetadata = parseJsonObject(
    row.implementation_metadata_json,
  );
  const implementationCommitSha =
    typeof implementationMetadata?.implementationCommitSha === "string"
      ? implementationMetadata.implementationCommitSha
      : null;

  const hasImplementationVersion =
    implementationMetadata !== null || row.current_pr_url !== null;

  return {
    implementationBranch: hasImplementationVersion
      ? buildImplementationBranchName(row.jira_key, row.oneshot_run_id)
      : null,
    implementationCommitSha,
  };
}

function getProgress(
  displayState: OneShotDisplayState,
  stageOverride?: FailedProgressStage | PausedProgressStage,
): {
  progressStage: OneShotProgressStage;
  progressPercent: number;
} {
  switch (displayState) {
    case "qualification_pending":
      return { progressStage: "qualification", progressPercent: 5 };
    case "repo_confirmation_pending":
      return { progressStage: "qualification", progressPercent: 5 };
    case "qualification_failed":
    case "qualification_no_action":
      return { progressStage: "qualification", progressPercent: 10 };
    case "queued_for_planning":
      return { progressStage: "planning", progressPercent: 15 };
    case "planning":
      return { progressStage: "planning", progressPercent: 22 };
    case "needs_revision":
      return { progressStage: "review", progressPercent: 30 };
    case "queued_for_review":
      return { progressStage: "review", progressPercent: 33 };
    case "reviewing":
      return { progressStage: "review", progressPercent: 38 };
    case "escalated":
    case "blocked":
      return progressForPausedStage(
        (stageOverride as PausedProgressStage | undefined) ?? "review",
      );
    case "approved":
      return { progressStage: "review", progressPercent: 42 };
    case "queued_for_implementation":
      return { progressStage: "implementation", progressPercent: 45 };
    case "implementing":
      return { progressStage: "implementation", progressPercent: 55 };
    case "queued_for_code_review":
      return { progressStage: "code_review", progressPercent: 62 };
    case "code_reviewing":
      return { progressStage: "code_review", progressPercent: 70 };
    case "queued_for_testing":
      return { progressStage: "testing", progressPercent: 78 };
    case "testing":
      return { progressStage: "testing", progressPercent: 85 };
    case "replan_required":
      return progressForPausedStage(
        (stageOverride as PausedProgressStage | undefined) ?? "implementation",
      );
    case "pr_open":
      return { progressStage: "pr_complete", progressPercent: 95 };
    case "completed":
      return { progressStage: "pr_complete", progressPercent: 100 };
    case "failed":
      return progressForFailedStage(
        (stageOverride as FailedProgressStage | undefined) ?? "qualification",
      );
  }
}

function buildRetryCapability(
  row: OneShotRunRow,
  stage: FailedProgressStage | undefined,
  context: RunNormalizationContext,
): OneShotRetryCapability | null {
  if (row.state !== "failed") {
    return null;
  }

  const retryStage = normalizeRetryableStage(stage);
  if (!retryStage) {
    return null;
  }

  const attemptsUsed =
    context.manualRetryCountByRunStage.get(
      makeManualRetryStageKey(row.oneshot_run_id, retryStage),
    ) ?? 0;
  const attemptsRemaining = Math.max(0, MANUAL_STAGE_RETRY_MAX - attemptsUsed);

  return {
    stage: retryStage,
    eligible: attemptsRemaining > 0,
    attemptsUsed,
    attemptsRemaining,
    maxAttempts: MANUAL_STAGE_RETRY_MAX,
    disabledReason:
      attemptsRemaining > 0 ? null : "Retry limit reached for this stage.",
  };
}

function matchesSearch(row: OneShotDashboardRow, term: string): boolean {
  const haystack = [
    row.jiraKey,
    row.title,
    row.ticketType,
    row.jiraIssueType ?? "",
    row.repoName ?? "",
    row.baseBranch ?? "",
    row.implementationBranch ?? "",
  ]
    .join(" ")
    .toLowerCase();

  return haystack.includes(term);
}

function completionStatusToReadiness(finalDisposition: string | null): {
  completionStatus: OneShotDashboardRow["completionStatus"];
  readiness: OneShotDashboardRow["readiness"];
} {
  switch (finalDisposition) {
    case "completed_ready":
      return { completionStatus: "completed_ready", readiness: "ready" };
    case "completed_draft":
      return { completionStatus: "completed_draft", readiness: "draft" };
    case "completed_needs_review":
      return {
        completionStatus: "completed_needs_review",
        readiness: "needs_review",
      };
    case "completed_with_risks":
      return {
        completionStatus: "completed_with_risks",
        readiness: "with_risks",
      };
    case "completed_no_action":
      return {
        completionStatus: "completed_no_action",
        readiness: "no_action",
      };
    default:
      return { completionStatus: null, readiness: null };
  }
}

function normalizeRunRow(
  row: OneShotRunRow,
  context: RunNormalizationContext,
): OneShotDashboardRow {
  const title = extractTitle(row.task_description, row.jira_key);
  const { implementationBranch, implementationCommitSha } =
    getImplementationMetadata(row);
  const displayState = row.state;
  const transitionStage =
    displayState === "failed" ||
    displayState === "blocked" ||
    displayState === "escalated" ||
    displayState === "replan_required"
      ? (context.transitionStageByRunState.get(
          makeTransitionStageKey(row.oneshot_run_id, displayState),
        ) ?? null)
      : null;
  const latestArtifactStage =
    context.latestArtifactStageByRunId.get(row.oneshot_run_id) ?? null;
  const stageInferenceInput = {
    transitionStage,
    finalDisposition: row.final_disposition,
    latestArtifactStage,
    currentPlanVersion: row.current_plan_version,
    currentReviewVersion: row.current_review_version,
    currentImplementationVersion: row.current_implementation_version,
    currentCodeReviewVersion: row.current_code_review_version,
    currentTestVersion: row.current_test_version,
  };
  const inferredStage =
    displayState === "failed"
      ? inferFailedStage(stageInferenceInput)
      : displayState === "blocked" || displayState === "escalated"
        ? inferBlockedOrEscalatedStage(stageInferenceInput)
        : displayState === "replan_required"
          ? inferReplanRequiredStage(stageInferenceInput)
          : undefined;
  const { progressStage, progressPercent } = getProgress(
    displayState,
    inferredStage,
  );
  const deployment = buildDeploymentSummaryFromRecord(
    context.deploymentByRunId.get(row.oneshot_run_id) ?? null,
    row.repo_name === "core-app" &&
      row.final_disposition === "completed_ready" &&
      Boolean(implementationBranch) &&
      Boolean(implementationCommitSha),
  );

  const parsedTotalTokensUsed = Number(row.total_tokens_used ?? 0);
  const totalTokensUsed = Number.isFinite(parsedTotalTokensUsed)
    ? parsedTotalTokensUsed
    : 0;
  const displayCost = buildDisplayCostSummary(
    totalTokensUsed,
    context.costSummaryByRunId.get(row.oneshot_run_id),
  );
  const readinessEvidence =
    context.readinessEvidenceByRunId.get(row.oneshot_run_id) ?? null;
  const dispositionReadiness = completionStatusToReadiness(
    row.final_disposition,
  );
  const preferEvidence = row.state === "pr_open" && readinessEvidence !== null;
  const completionStatus = preferEvidence
    ? (readinessEvidence?.completionStatus ??
      dispositionReadiness.completionStatus ??
      null)
    : (dispositionReadiness.completionStatus ??
      readinessEvidence?.completionStatus ??
      null);
  const readiness = preferEvidence
    ? (readinessEvidence?.readiness ?? dispositionReadiness.readiness ?? null)
    : (dispositionReadiness.readiness ?? readinessEvidence?.readiness ?? null);
  const readinessReasons = readinessEvidence?.readinessReasons.length
    ? readinessEvidence.readinessReasons
    : completionStatus &&
        completionStatus !== "completed_ready" &&
        row.last_error
      ? [summarizeRunError(row.last_error) ?? row.last_error]
      : [];
  const latestManualRestartAt =
    context.latestManualRestartAtByRunId.get(row.oneshot_run_id) ?? null;
  const retryPending = isRetryPendingState(displayState, row.last_error);
  const retryEta = retryPending
    ? (context.retryEtaByRunState.get(
        makeRetryEtaStateKey(row.oneshot_run_id, displayState),
      ) ?? null)
    : null;

  return {
    dashboardId: `run-${row.oneshot_run_id}`,
    jiraKey: row.jira_key,
    title,
    jiraIssueType: row.jira_issue_type,
    ticketType: normalizeOneShotTicketType(row.ticket_type) ?? "unknown",
    ticketTypeSource: row.ticket_type_source ?? "unknown",
    ticketTypeUpdatedBy: row.ticket_type_updated_by,
    ticketTypeUpdatedAt: row.ticket_type_updated_at
      ? toIsoString(row.ticket_type_updated_at)
      : null,
    sourceTaskManagementId: row.source_task_management_id,
    oneshotRunId: row.oneshot_run_id,
    runGroupId: row.run_group_id ?? null,
    groupMetadata: (row.run_group_metadata_json as import("../types/oneshot.js").OneShotRunGroupMetadata | null) ?? null,
    customerName: row.customer_name,
    displayState,
    progressStage,
    progressPercent,
    repoName: row.repo_name,
    repoUrl: row.repo_url,
    baseBranch: row.branch_name,
    baseCommitSha: row.base_commit_sha,
    implementationBranch,
    implementationCommitSha,
    workspace: {
      mode: normalizeDashboardWorkspaceMode(row.workspace_mode),
      runBranchName: row.run_branch_name,
      runBranchBaseSha: row.run_branch_base_sha,
      runBranchCreatedAt: row.run_branch_created_at
        ? toIsoString(row.run_branch_created_at)
        : null,
      phase: row.workspace_phase,
      headSha: row.workspace_head_sha,
      currentCandidateVersion: row.current_candidate_version,
      currentCandidateSha: row.current_candidate_sha,
      lastRepoFetchAt: row.last_repo_fetch_at
        ? toIsoString(row.last_repo_fetch_at)
        : null,
      lastRemoteHeadSha: row.last_remote_head_sha,
    },
    reviewLoopCount: row.review_loop_count,
    maxReviewLoops: row.max_review_loops,
    planReviewLoopCount: row.review_loop_count,
    maxPlanReviewLoops: row.max_review_loops,
    verificationLoopCount: row.verification_loop_count,
    maxVerificationLoops: row.max_verification_loops,
    currentPrUrl: row.current_pr_url,
    qualificationSummary: null,
    qualifierOutcome: null,
    lastError: row.last_error,
    lastErrorSummary: summarizeRunError(row.last_error),
    retryPending,
    retryPendingStage: retryPending ? progressStage : null,
    retryPendingNextRetryAt: retryPending ? (retryEta?.nextRetryAt ?? null) : null,
    retryPendingDelaySeconds: retryPending ? (retryEta?.delaySeconds ?? null) : null,
    retryPendingAttempt: retryPending ? (retryEta?.attempt ?? null) : null,
    retryPendingMaxAttempts: retryPending ? (retryEta?.maxAttempts ?? null) : null,
    retryPendingVisibilityStatus: retryPending
      ? (retryEta?.visibilityStatus ?? null)
      : null,
    staleRouter: false,
    completionStatus,
    readiness,
    readinessReasons,
    riskAssessment: readinessEvidence?.riskAssessment ?? null,
    externalSpecEvidence: readinessEvidence?.externalSpecEvidence ?? null,
    ciStatus: readinessEvidence?.ciStatus ?? null,
    unverifiedTests: readinessEvidence?.unverifiedTests ?? [],
    plannerAttemptDiagnostics:
      readinessEvidence?.plannerAttemptDiagnostics ?? null,
    sdkLifecycleSummary: readinessEvidence?.sdkLifecycleSummary ?? null,
    retry: buildRetryCapability(row, inferredStage, context),
    deployment,
    createdAt: toIsoString(row.created_at),
    lastManualRestartAt: latestManualRestartAt
      ? toIsoString(latestManualRestartAt)
      : null,
    updatedAt: toIsoString(row.updated_at),
    totalTokensUsed,
    estimatedCostUsd: displayCost.estimatedCostUsd,
    costSource: displayCost.costSource,
  };
}

function normalizeQualifierTaskRow(row: QualifierTaskRow): OneShotDashboardRow {
  const qualifierOutcome = parseQualifierOutcome(row.metrics_json);
  const qualifierCost = parseQualifierCostSummary(row.metrics_json);
  const displayState: OneShotDisplayState =
    row.task_status === "assigned" ||
    row.task_status === "in_progress" ||
    row.task_status === "posting_to_jira"
      ? "qualification_pending"
      : row.task_status === "waiting_repo_confirmation"
        ? "repo_confirmation_pending"
        : qualifierOutcome?.disposition === "no_action"
          ? "qualification_no_action"
          : "qualification_failed";

  const title = extractTitle(row.task_description, row.jira_number);
  const { progressStage, progressPercent } = getProgress(displayState);
  const staleRouter = isStaleRouterOutcome(qualifierOutcome, row.created_at);

  return {
    dashboardId: `qualifier-task-${row.task_management_id}`,
    jiraKey: row.jira_number,
    title,
    jiraIssueType: null,
    ticketType: "unknown",
    ticketTypeSource: "unknown",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
    sourceTaskManagementId: row.task_management_id,
    oneshotRunId: null,
    customerName: row.customer_name,
    displayState,
    progressStage,
    progressPercent,
    repoName: null,
    repoUrl: null,
    baseBranch: null,
    baseCommitSha: null,
    implementationBranch: null,
    implementationCommitSha: null,
    workspace: null,
    reviewLoopCount: 0,
    maxReviewLoops: DEFAULT_MAX_REVIEW_LOOPS,
    planReviewLoopCount: 0,
    maxPlanReviewLoops: DEFAULT_MAX_REVIEW_LOOPS,
    verificationLoopCount: 0,
    maxVerificationLoops: 0,
    currentPrUrl: null,
    qualificationSummary:
      row.task_status === "waiting_repo_confirmation"
        ? row.error_message
          ? (summarizeRunError(row.error_message) ?? row.error_message)
          : "Waiting for repository confirmation."
        : (qualifierOutcome?.reason ??
          getQualificationSummary(displayState, title, row.error_message)),
    qualifierOutcome,
    lastError: row.error_message,
    lastErrorSummary: summarizeRunError(row.error_message),
    retryPending: false,
    retryPendingStage: null,
    staleRouter,
    completionStatus: null,
    readiness: null,
    readinessReasons: [],
    riskAssessment: null,
    externalSpecEvidence: null,
    ciStatus: null,
    unverifiedTests: [],
    plannerAttemptDiagnostics: null,
    sdkLifecycleSummary: null,
    retry: null,
    deployment: buildDeploymentSummaryFromRecord(null, false),
    createdAt: toIsoString(row.created_at),
    lastManualRestartAt: null,
    updatedAt: toIsoString(row.updated_at),
    totalTokensUsed: qualifierCost.tokens,
    estimatedCostUsd: qualifierCost.usd,
    costSource: qualifierCost.source,
  };
}

const RUN_ROW_SELECT = `SELECT
   r.id AS oneshot_run_id,
   r.jira_key,
   r.jira_issue_type,
   r.ticket_type,
   r.ticket_type_source,
   r.ticket_type_updated_by,
   r.ticket_type_updated_at,
   r.source_task_management_id,
   cb.customer AS customer_name,
   r.workspace_mode,
   r.state,
   r.review_loop_count,
   r.max_review_loops,
   r.verification_loop_count,
   r.max_verification_loops,
   r.current_pr_url,
   r.current_plan_version,
   r.current_review_version,
   r.current_implementation_version,
   r.current_code_review_version,
   r.current_test_version,
   r.final_disposition,
   r.last_error,
   cr.repo_name,
   cr.repo_url,
	   r.branch_name,
	   r.base_commit_sha,
	   r.run_branch_name,
	   r.run_branch_base_sha,
	   r.run_branch_created_at,
	   t.task_description,
   ia.metadata_json AS implementation_metadata_json,
   ws.workspace_phase,
   ws.workspace_head_sha,
   ws.current_candidate_version,
   ws.current_candidate_sha,
   ws.last_repo_fetch_at,
   ws.last_remote_head_sha,
   r.total_tokens_used,
   r.created_at,
   r.updated_at,
   r.run_group_id,
   rg.metadata_json AS run_group_metadata_json
 FROM oneshot_runs r
 JOIN customer_branches cb
   ON cb.id = r.customer_id
 JOIN code_repositories cr
   ON cr.id = r.repo_id
 LEFT JOIN task_management tm
   ON tm.id = r.source_task_management_id
 LEFT JOIN tasks t
   ON t.id = tm.task_id
LEFT JOIN oneshot_artifacts ia
   ON ia.oneshot_run_id = r.id
  AND ia.stage = 'implementation'
  AND ia.version = r.current_implementation_version
 LEFT JOIN oneshot_workspace_state ws
   ON ws.oneshot_run_id = r.id
 LEFT JOIN oneshot_run_groups rg
   ON rg.id = r.run_group_id`;

const QUALIFIER_TASK_SELECT = `SELECT
   tm.id AS task_management_id,
   tm.jira_number,
   tm.status AS task_status,
   cb.customer AS customer_name,
   t.task_description,
   t.error_message,
   t.metrics_json,
   tm.created_at,
   tm.updated_at
 FROM task_management tm
 JOIN agents a
   ON a.id = tm.agent_id
 JOIN customer_branches cb
   ON cb.id = tm.customer_id
 LEFT JOIN tasks t
   ON t.id = tm.task_id
 LEFT JOIN oneshot_runs r
   ON r.source_task_management_id = tm.id
 WHERE a.name = 'QUALIFIER'
   AND tm.cancelled_at IS NULL
   AND r.id IS NULL`;

function buildPlaceholders(ids: readonly number[]): string {
  return ids.map(() => "?").join(", ");
}

async function fetchOneShotRunRows(): Promise<OneShotRunRow[]> {
  const [idRows] = await getPool().query<OneShotRunIdRow[]>(
    `SELECT r.id AS oneshot_run_id
     FROM oneshot_runs r
     ORDER BY r.updated_at DESC, r.id DESC`,
  );

  const orderedRunIds = idRows.map((row) => Number(row.oneshot_run_id));
  if (orderedRunIds.length === 0) {
    return [];
  }

  const placeholders = buildPlaceholders(orderedRunIds);
  const [rows] = await getPool().query<OneShotRunRow[]>(
    `${RUN_ROW_SELECT}
     WHERE r.id IN (${placeholders})`,
    orderedRunIds,
  );

  const rowsById = new Map(
    rows.map((row) => [Number(row.oneshot_run_id), row]),
  );
  return orderedRunIds
    .map((runId) => rowsById.get(runId))
    .filter((row): row is OneShotRunRow => Boolean(row));
}

async function fetchOneShotRunRowById(
  runId: number,
): Promise<OneShotRunRow | null> {
  const [rows] = await getPool().query<OneShotRunRow[]>(
    `${RUN_ROW_SELECT}
     WHERE r.id = ?
     LIMIT 1`,
    [runId],
  );

  return rows[0] ?? null;
}

async function fetchQualifierTaskRows(): Promise<QualifierTaskRow[]> {
  const [rows] = await getPool().query<QualifierTaskRow[]>(
    `${QUALIFIER_TASK_SELECT}
     ORDER BY tm.updated_at DESC`,
  );

  return rows;
}

async function fetchQualifierTaskRowById(
  taskManagementId: number,
): Promise<QualifierTaskRow | null> {
  const [rows] = await getPool().query<QualifierTaskRow[]>(
    `${QUALIFIER_TASK_SELECT}
     AND tm.id = ?
     LIMIT 1`,
    [taskManagementId],
  );

  return rows[0] ?? null;
}

async function fetchArtifactRunRows(): Promise<ArtifactRunRow[]> {
  try {
    const [rows] = await getPool().query<ArtifactRunRow[]>(
      `SELECT
         id,
         source_key,
         source_parent_key,
         mode,
         status,
         title,
         generated_count,
         generated_tickets_json,
         human_review_required,
         human_review_count,
         review_items_json,
         evidence_json,
         artifact_refs_json,
         jira_summary,
         completed_at,
         created_at,
         updated_at
       FROM oneshot_artifact_runs
       ORDER BY updated_at DESC, id DESC
       LIMIT 200`,
    );
    return rows;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/oneshot_artifact_runs/i.test(message)) {
      return [];
    }
    throw error;
  }
}

function jiraIssueUrl(issueKey: string): string | null {
  const baseUrl = process.env.JIRA_BASE_URL?.trim();
  if (!baseUrl) {
    return null;
  }
  return `${baseUrl.replace(/\/$/, "")}/browse/${issueKey}`;
}

function artifactTicketFromValue(
  value: unknown,
  runByJiraKey: ReadonlyMap<string, OneShotDashboardRow>,
): OneShotArtifactRunTicket | null {
  const record = asRecord(value);
  const key =
    typeof value === "string"
      ? value.trim().toUpperCase()
      : typeof record?.key === "string"
        ? record.key.trim().toUpperCase()
        : "";
  if (!/^[A-Z]+-\d+$/.test(key)) {
    return null;
  }

  const linkedRun = runByJiraKey.get(key) ?? null;
  return {
    key,
    title:
      typeof record?.title === "string"
        ? record.title
        : typeof record?.summary === "string"
          ? record.summary
          : null,
    kind:
      typeof record?.kind === "string"
        ? record.kind
        : typeof record?.type === "string"
          ? record.type
          : null,
    status:
      typeof record?.status === "string"
        ? record.status
        : linkedRun
          ? displayStateLabelForArtifact(linkedRun.displayState)
          : null,
    jiraUrl:
      typeof record?.jiraUrl === "string" ? record.jiraUrl : jiraIssueUrl(key),
    oneshotRunDashboardId: linkedRun?.dashboardId ?? null,
    oneshotRunState: linkedRun?.displayState ?? null,
    currentPrUrl: linkedRun?.currentPrUrl ?? null,
  };
}

function displayStateLabelForArtifact(state: OneShotDisplayState): string {
  return state.replace(/_/g, " ");
}

function normalizeReviewItems(value: JsonValue): string[] {
  return parseJsonArray(value)
    .map((item) => {
      if (typeof item === "string") {
        return item;
      }
      const record = asRecord(item);
      if (!record) {
        return null;
      }
      return typeof record.reason === "string"
        ? record.reason
        : typeof record.title === "string"
          ? record.title
          : typeof record.summary === "string"
            ? record.summary
            : null;
    })
    .filter((item): item is string => Boolean(item?.trim()));
}

function normalizeArtifactRunRows(
  rows: readonly ArtifactRunRow[],
  dashboardRows: readonly OneShotDashboardRow[],
): OneShotArtifactRun[] {
  const runByJiraKey = new Map(
    dashboardRows
      .filter((row) => row.oneshotRunId !== null)
      .map((row) => [row.jiraKey.toUpperCase(), row]),
  );

  return rows.map((row) => {
    const generatedTickets = parseJsonArray(row.generated_tickets_json)
      .map((item) => artifactTicketFromValue(item, runByJiraKey))
      .filter((ticket): ticket is OneShotArtifactRunTicket => Boolean(ticket));
    const oneshotRunCount = generatedTickets.filter(
      (ticket) => ticket.oneshotRunDashboardId !== null,
    ).length;

    return {
      id: `artifact-${row.id}`,
      sourceKey: row.source_key,
      sourceParentKey: row.source_parent_key,
      mode: row.mode,
      status: row.status,
      title: row.title,
      generatedCount: Number(row.generated_count) || generatedTickets.length,
      generatedTickets,
      oneshotRunCount,
      humanReviewRequired:
        row.human_review_required === true ||
        Number(row.human_review_required) === 1,
      humanReviewCount: Number(row.human_review_count) || 0,
      reviewItems: normalizeReviewItems(row.review_items_json),
      evidence: parseJsonObject(row.evidence_json),
      artifactRefs: parseJsonObject(row.artifact_refs_json),
      jiraSummary: row.jira_summary,
      completedAt: row.completed_at ? toIsoString(row.completed_at) : null,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  });
}

async function fetchLatestTransitionStages(
  runIds: readonly number[],
): Promise<Map<string, string | null>> {
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = buildPlaceholders(runIds);
  const [rows] = await getPool().query<LatestTransitionStageRow[]>(
    `SELECT
       e.oneshot_run_id,
       e.to_state,
       COALESCE(e.stage, e.from_state) AS transition_stage
     FROM oneshot_run_events e
     JOIN (
       SELECT oneshot_run_id, to_state, MAX(id) AS latest_event_id
       FROM oneshot_run_events
       WHERE event_type = 'state_transition'
         AND to_state IN ('failed', 'blocked', 'escalated', 'replan_required')
         AND oneshot_run_id IN (${placeholders})
       GROUP BY oneshot_run_id, to_state
     ) latest
       ON latest.latest_event_id = e.id`,
    [...runIds],
  );

  return new Map(
    rows.map((row) => [
      makeTransitionStageKey(row.oneshot_run_id, row.to_state),
      row.transition_stage,
    ]),
  );
}

async function fetchLatestArtifactStages(
  runIds: readonly number[],
): Promise<Map<number, string | null>> {
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = buildPlaceholders(runIds);
  const [rows] = await getPool().query<LatestArtifactStageRow[]>(
    `SELECT
       a.oneshot_run_id,
       a.stage AS latest_artifact_stage
     FROM oneshot_artifacts a
     JOIN (
       SELECT oneshot_run_id, MAX(id) AS latest_artifact_id
       FROM oneshot_artifacts
       WHERE oneshot_run_id IN (${placeholders})
       GROUP BY oneshot_run_id
     ) latest
       ON latest.latest_artifact_id = a.id`,
    [...runIds],
  );

  return new Map(
    rows.map((row) => [row.oneshot_run_id, row.latest_artifact_stage]),
  );
}

async function fetchManualRetryCounts(
  runIds: readonly number[],
): Promise<Map<string, number>> {
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = buildPlaceholders(runIds);
  const [rows] = await getPool().query<ManualRetryCountRow[]>(
    `SELECT
       oneshot_run_id,
       stage AS retry_stage,
       COUNT(*) AS retry_count
     FROM oneshot_run_events
     WHERE oneshot_run_id IN (${placeholders})
       AND event_type = 'state_transition'
       AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) = 'manual_stage_retry'
     GROUP BY oneshot_run_id, stage`,
    [...runIds],
  );

  const counts = new Map<string, number>();
  for (const row of rows) {
    const stage = normalizeRetryableStage(row.retry_stage);
    if (!stage) {
      continue;
    }
    counts.set(
      makeManualRetryStageKey(row.oneshot_run_id, stage),
      Number(row.retry_count) || 0,
    );
  }
  return counts;
}

async function fetchLatestManualStageRestarts(
  runIds: readonly number[],
): Promise<Map<number, Date | string>> {
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = buildPlaceholders(runIds);
  const [rows] = await getPool().query<ManualStageRestartRow[]>(
    `SELECT
       oneshot_run_id,
       occurred_at
     FROM oneshot_run_events
     WHERE oneshot_run_id IN (${placeholders})
       AND event_type = 'state_transition'
       AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) = 'manual_stage_restart'
     ORDER BY oneshot_run_id ASC, occurred_at DESC, id DESC`,
    [...runIds],
  );

  const latestByRunId = new Map<number, Date | string>();
  for (const row of rows) {
    if (!latestByRunId.has(row.oneshot_run_id)) {
      latestByRunId.set(row.oneshot_run_id, row.occurred_at);
    }
  }
  return latestByRunId;
}

async function fetchReadinessEvidence(
  runIds: readonly number[],
): Promise<Map<number, RunReadinessEvidence>> {
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = buildPlaceholders(runIds);
  const [rows] = await getPool().query<ReadinessEventRow[]>(
    `SELECT id, oneshot_run_id, event_type, metadata_json
     FROM oneshot_run_events
     WHERE oneshot_run_id IN (${placeholders})
       AND event_type IN ('readiness_classified', 'risk_classification_observed', 'risk_classification_finalized', 'stage_attempt_metrics', 'sdk_lifecycle_observed')
     ORDER BY oneshot_run_id ASC, id ASC`,
    [...runIds],
  );

  const byRunId = new Map<number, ReadinessEventRow[]>();
  for (const row of rows) {
    const events = byRunId.get(row.oneshot_run_id) ?? [];
    events.push(row);
    byRunId.set(row.oneshot_run_id, events);
  }

  return new Map(
    Array.from(byRunId.entries()).map(([runId, events]) => [
      runId,
      extractReadinessEvidence(events),
    ]),
  );
}

async function fetchRunArtifactCosts(
  runIds: readonly number[],
): Promise<
  Map<number, { estimatedCostUsd: number; costSource: OneShotCostSource }>
> {
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = buildPlaceholders(runIds);
  const [rows] = await getPool().query<DashboardArtifactCostRow[]>(
    `SELECT
       a.oneshot_run_id,
       CAST(a.stage AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS artifact_stage,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS stage_cost_usd,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(a.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS stage_tokens_used,
       CAST(a.model AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS model,
       CAST(a.provider AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS provider
     FROM oneshot_artifacts a
     WHERE a.oneshot_run_id IN (${placeholders})
     UNION ALL
     SELECT
       e.oneshot_run_id,
       CAST(e.stage AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS artifact_stage,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_cost_usd')) AS DOUBLE) AS stage_cost_usd,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.stage_tokens_used')) AS UNSIGNED) AS stage_tokens_used,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.model')) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS model,
       CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata_json, '$.provider')) AS CHAR CHARACTER SET utf8mb4) COLLATE utf8mb4_unicode_ci AS provider
     FROM oneshot_run_events e
     WHERE e.oneshot_run_id IN (${placeholders})
       AND e.event_type = 'stage_attempt_metrics'`,
    [...runIds, ...runIds],
  );

  return aggregateArtifactCostsByRun(rows);
}

type RetryEtaEventRow = mysql.RowDataPacket & {
  oneshot_run_id: number;
  to_state: string | null;
  metadata_json: JsonValue;
};

async function fetchRetryEtaData(
  runIds: readonly number[],
): Promise<Map<string, RetryEtaData>> {
  if (runIds.length === 0) {
    return new Map();
  }

  const placeholders = buildPlaceholders(runIds);
  const [rows] = await getPool().query<RetryEtaEventRow[]>(
    `SELECT
       oneshot_run_id,
       to_state,
       metadata_json
     FROM oneshot_run_events
     WHERE oneshot_run_id IN (${placeholders})
       AND event_type = 'state_transition'
       AND JSON_EXTRACT(metadata_json, '$.transientRetry') IS NOT NULL
     ORDER BY oneshot_run_id ASC, id DESC`,
    [...runIds],
  );

  const result = new Map<string, RetryEtaData>();
  for (const row of rows) {
    if (!row.to_state) {
      continue;
    }
    const key = makeRetryEtaStateKey(row.oneshot_run_id, row.to_state);
    // Only take the latest (first in DESC order) for each run/state pair.
    if (result.has(key)) {
      continue;
    }
    const meta = parseJsonObject(row.metadata_json);
    const mapped = mapTransientRetryMetadata(meta?.transientRetry);
    if (mapped !== null) {
      result.set(key, mapped);
    }
  }
  return result;
}

async function buildRunNormalizationContext(
  runRows: readonly OneShotRunRow[],
): Promise<RunNormalizationContext> {
  const runIds = runRows.map((row) => row.oneshot_run_id);
  const [
    deploymentByRunId,
    transitionStageByRunState,
    latestArtifactStageByRunId,
    manualRetryCountByRunStage,
    latestManualRestartAtByRunId,
    costSummaryByRunId,
    readinessEvidenceByRunId,
    retryEtaByRunState,
  ] = await Promise.all([
    getLatestDeploymentsByRunIds(runIds),
    fetchLatestTransitionStages(runIds),
    fetchLatestArtifactStages(runIds),
    fetchManualRetryCounts(runIds),
    fetchLatestManualStageRestarts(runIds),
    fetchRunArtifactCosts(runIds),
    fetchReadinessEvidence(runIds),
    fetchRetryEtaData(runIds),
  ]);

  return {
    deploymentByRunId,
    transitionStageByRunState,
    latestArtifactStageByRunId,
    manualRetryCountByRunStage,
    latestManualRestartAtByRunId,
    costSummaryByRunId,
    readinessEvidenceByRunId,
    retryEtaByRunState,
  };
}

async function normalizeRunRows(
  runRows: readonly OneShotRunRow[],
): Promise<OneShotDashboardRow[]> {
  const context = await buildRunNormalizationContext(runRows);
  return runRows.map((row) => normalizeRunRow(row, context));
}

function withFailureAttribution(row: OneShotDashboardRow): OneShotDashboardRow {
  return {
    ...row,
    failureAttribution: classifyFailureForRow(row),
  };
}

export async function getOneShotDashboardRows(): Promise<
  OneShotDashboardRow[]
> {
  const [runRows, qualifierRows] = await Promise.all([
    fetchOneShotRunRows(),
    fetchQualifierTaskRows(),
  ]);

  const normalizedRunRows = await normalizeRunRows(runRows);
  return [
    ...normalizedRunRows,
    ...qualifierRows.map(normalizeQualifierTaskRow),
  ].map(withFailureAttribution);
}

function applyFilters(
  rows: OneShotDashboardRow[],
  query: OneShotRunsQuery,
): OneShotDashboardRow[] {
  let filtered = [...rows];

  const search = query.jiraKey?.trim().toLowerCase() ?? "";
  if (search) {
    filtered = filtered.filter((row) => matchesSearch(row, search));
  }

  if (query.state && query.state !== "all") {
    filtered = filtered.filter((row) => row.displayState === query.state);
  }

  if (query.ticketType && query.ticketType !== "all") {
    filtered = filtered.filter((row) => row.ticketType === query.ticketType);
  }

  if (query.deployment && query.deployment !== "all") {
    filtered = filtered.filter((row) => {
      if (query.deployment === "eligible") {
        // The "eligible" query param now surfaces the tightened "ready"
        // predicate — runs that are eligible AND have no existing
        // deployment record. The Deploy Ready stat card relies on this.
        return row.deployment.ready;
      }
      if (query.deployment === "active") {
        return row.deployment.active;
      }
      if (query.deployment === "inflight") {
        return row.deployment.light === "amber";
      }
      return true;
    });
  }

  filtered.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const shouldLimitQualificationFailuresByDefault =
    !search && (!query.state || query.state === "all");
  if (shouldLimitQualificationFailuresByDefault) {
    const qualificationFailures = filtered
      .filter((row) => row.displayState === "qualification_failed")
      .slice(0, DEFAULT_QUALIFICATION_FAILURES)
      .map((row) => row.dashboardId);

    const allowedFailureIds = new Set(qualificationFailures);
    filtered = filtered.filter(
      (row) =>
        row.displayState !== "qualification_failed" ||
        allowedFailureIds.has(row.dashboardId),
    );
  }

  return filtered;
}

function clampLimit(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.trunc(value), MAX_LIMIT);
}

function clampOffset(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.trunc(value);
}

export async function getOneShotRuns(
  query: Partial<OneShotRunsQuery>,
  options: {
    capabilities?: OneShotDashboardCapabilities;
  } = {},
): Promise<OneShotRunsResponse> {
  const limit = clampLimit(Number(query.limit ?? DEFAULT_LIMIT));
  const offset = clampOffset(Number(query.offset ?? 0));

  const normalizedRows = await getOneShotDashboardRows();
  const artifactRuns = normalizeArtifactRunRows(
    await fetchArtifactRunRows(),
    normalizedRows,
  );
  const analytics = await buildOneShotDashboardAnalytics(
    normalizedRows,
    query.range,
  );

  // Stats computed over ALL rows before any view/state/search filter so stat
  // tiles are stable regardless of the active tab. inProgress uses
  // EXECUTING_STATES — the exact same predicate the Running tab's filter uses —
  // so the stat card count and the Running list always agree.
  const byView = { running: 0, queued: 0, waiting: 0, history: 0 };
  const stats: OneShotRunsStats = {
    inProgress: 0,
    failed: 0,
    blocked: 0,
    deployReady: 0,
    byView,
  };
  for (const row of normalizedRows) {
    if (EXECUTING_STATES.has(row.displayState)) stats.inProgress += 1;
    if (
      row.displayState === "failed" ||
      row.displayState === "qualification_failed"
    ) {
      stats.failed += 1;
    }
    if (row.displayState === "blocked") stats.blocked += 1;
    // "Deploy Ready" = eligible AND no existing deployment record. The
    // `ready` flag carries the tightened semantics; `eligible` alone also
    // catches runs that have already been deployed (or failed/cancelled).
    if (row.deployment.ready) stats.deployReady += 1;
    const bucket = bucketForView(row.displayState);
    if (bucket !== "other") byView[bucket] += 1;
  }

  // Apply view-bucket filter first so pagination.total reflects only the
  // rows belonging to the requested view. This ensures the footer count and
  // pager are consistent with what the client renders.
  const view = query.view ?? "all";
  const viewFilteredRows =
    view === "all"
      ? normalizedRows
      : normalizedRows.filter(
          (row) => bucketForView(row.displayState) === view,
        );

  const filteredRows = applyFilters(viewFilteredRows, {
    limit,
    offset,
    state: query.state,
    jiraKey: query.jiraKey,
    deployment: query.deployment,
    ticketType: query.ticketType,
  });

  const useDashboardSnapshot = query.snapshot === "dashboard";
  const pagedRows = useDashboardSnapshot
    ? filteredRows
    : filteredRows.slice(offset, offset + limit);
  const pagination = useDashboardSnapshot
    ? {
        limit: filteredRows.length,
        offset: 0,
        hasMore: false,
        total: filteredRows.length,
      }
    : {
        limit,
        offset,
        hasMore: offset + limit < filteredRows.length,
        total: filteredRows.length,
      };

  return {
    runs: pagedRows,
    artifactRuns,
    pagination,
    stats,
    capabilities: options.capabilities ?? DEFAULT_CAPABILITIES,
    analytics,
  };
}

export async function updateOneShotRunTicketType(input: {
  dashboardId: string;
  ticketType: OneShotTicketType;
  operator: { id: string; display: string };
}): Promise<OneShotDashboardRow> {
  const lookup = parseDashboardId(input.dashboardId);
  if (!lookup || lookup.kind !== "run") {
    throw new OneShotTicketTypeUpdateError(
      "Ticket type can only be updated for OneShot run rows.",
      400,
    );
  }

  const connection = await getPool().getConnection();
  try {
    await connection.beginTransaction();

    const [rows] = await connection.query<OneShotTicketTypeRow[]>(
      `SELECT id, ticket_type, ticket_type_source, state
       FROM oneshot_runs
       WHERE id = ?
       FOR UPDATE`,
      [lookup.id],
    );
    const row = rows[0];
    if (!row) {
      throw new OneShotTicketTypeUpdateError("OneShot run not found", 404);
    }

    const previousTicketType =
      normalizeOneShotTicketType(row.ticket_type) ?? "unknown";

    await connection.query(
      `UPDATE oneshot_runs
       SET ticket_type = ?,
           ticket_type_source = 'manual',
           ticket_type_updated_by = ?,
           ticket_type_updated_at = NOW(6),
           updated_at = NOW()
       WHERE id = ?`,
      [input.ticketType, input.operator.display, lookup.id],
    );

    await connection.query(
      `INSERT INTO oneshot_run_events
         (oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW(3))`,
      [
        lookup.id,
        "ticket_type_updated",
        row.state,
        row.state,
        "qualification",
        JSON.stringify({
          previousTicketType,
          ticketType: input.ticketType,
          previousSource: row.ticket_type_source ?? "unknown",
          ticketTypeSource: "manual",
          operatorId: input.operator.id,
          operatorDisplay: input.operator.display,
        }),
      ],
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  const updated = await getOneShotRowByDashboardId(input.dashboardId);
  if (!updated) {
    throw new OneShotTicketTypeUpdateError(
      "Updated OneShot run could not be loaded",
      500,
    );
  }
  return updated;
}

export async function getOneShotRowByDashboardId(
  dashboardId: string,
): Promise<OneShotDashboardRow | null> {
  const lookup = parseDashboardId(dashboardId);
  if (!lookup) {
    return null;
  }

  if (lookup.kind === "run") {
    const row = await fetchOneShotRunRowById(lookup.id);
    if (!row) {
      return null;
    }
    const normalizedRows = await normalizeRunRows([row]);
    return normalizedRows[0] ? withFailureAttribution(normalizedRows[0]) : null;
  }

  const qualifierRow = await fetchQualifierTaskRowById(lookup.id);
  return qualifierRow
    ? withFailureAttribution(normalizeQualifierTaskRow(qualifierRow))
    : null;
}
