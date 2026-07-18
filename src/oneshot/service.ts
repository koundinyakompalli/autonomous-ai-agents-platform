import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type mysql from "mysql2/promise";
import type { Database, CodeRepository } from "../orchestrator/database.js";
import { createS3Client } from "../utils/awsClients.js";
import { createLogger } from "../utils/logger.js";
import { buildOneShotArtifactKey, getOneShotSharedConfig } from "./config.js";
import type { OneShotRunEvent } from "./database/events.js";
import { OneShotDatabase } from "./database/index.js";
import { OneShotPublisher } from "./publisher.js";
import {
  buildPostmortemContext,
  generatePostmortemArtifact,
} from "./state-transitions.js";
import {
  createLeasedOneShotWorkspaceManager,
  type CleanupRunWorkspaceStatus,
  OneShotWorkspaceManager,
} from "./workspaces.js";
import {
  classifyBaseDrift,
  type BaseDriftClassification,
} from "./branch-drift.js";
import type { OneShotQueueStage } from "./contracts.js";
import { buildBranchDriftComment } from "./jira-comments.js";
import type { QualificationAssessment } from "./schema/qualification.js";
import {
  compactTicketEvidenceMetadata,
  publicTicketEvidenceRef,
  type TicketEvidenceRef,
} from "./ticket-evidence.js";
import { parseOneShotTestResult } from "./schema/test-result.js";
import type { OneShotModelUsage } from "./model-usage.js";
import { persistTicketReadinessScore } from "./ticket-readiness-score.js";
import { resolveOneShotProcessingMode } from "./processing-mode.js";
import { resolveOneShotTicketType } from "./ticket-type.js";
import {
  buildOneShotReadinessClassification,
  isExternalSpecEvidence,
  isPlanRiskAssessment,
  isQualificationRiskAssessment,
  type CiStatusSummary,
  type OneShotReadinessReason,
} from "./readiness.js";
import {
  fetchCommitStatusSummary,
  findOpenPullRequest,
  parseGitHubRepoUrl,
} from "./github.js";
import {
  createRemoteBranchIfMissing,
  getRemoteBranchHead,
  isAncestor,
  pushBranch,
} from "./git.js";
import {
  buildImplementationBranchName,
  buildRunImplementationBranchName,
  isSharedEpicImplementationBranchName,
  resolveRunBranchName,
} from "./implementation-branch.js";
import { sanitizeErrorMessage, classifyHandoffError } from "./errors.js";
import type { OneShotRun, OneShotState } from "./types.js";

const logger = createLogger("oneshot-service");
const ACTIVE_RUN_STALE_SCAN_MINUTES = 20;
const TERMINATION_POSTMORTEM_BACKFILL_HOURS = 24;
const STALE_EXECUTING_STATES = new Set<OneShotState>([
  "planning",
  "reviewing",
  "implementing",
  "code_reviewing",
  "testing",
]);
const TERMINATION_POSTMORTEM_REASONS = new Set([
  "stale_timeout",
  "operator_kill",
]);

function canNormalizePrePlanningSharedEpicHandoffRun(
  run: OneShotRun,
  currentCandidateSha: string | null,
): boolean {
  return (
    run.state === "failed" &&
    (run.final_disposition === "workspace_setup_failed" ||
      run.final_disposition === "planning_publish_failed") &&
    isSharedEpicImplementationBranchName(run.run_branch_name) &&
    run.current_plan_version === null &&
    run.current_review_version === null &&
    run.current_implementation_version === null &&
    run.current_implementation_commit_sha === null &&
    currentCandidateSha === null &&
    run.current_code_review_version === null &&
    run.current_test_version === null &&
    run.current_pr_url === null
  );
}

const REPLAN_IN_FLIGHT_STATES = new Set<OneShotState>([
  "queued_for_planning",
  "planning",
]);

function hasOpenPullRequest(run: Pick<OneShotRun, "state" | "current_pr_url">) {
  return run.state === "pr_open" || Boolean(run.current_pr_url?.trim());
}

function controlReplanNoActionReason(run: OneShotRun): string | null {
  if (run.state === "completed") {
    return "completed";
  }
  if (hasOpenPullRequest(run)) {
    return "pr_open";
  }
  if (REPLAN_IN_FLIGHT_STATES.has(run.state)) {
    return "planning_already_in_flight";
  }
  return null;
}

function latestEventIndex(
  events: OneShotRunEvent[],
  eventType: OneShotRunEvent["event_type"],
): number {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]?.event_type === eventType) {
      return index;
    }
  }
  return -1;
}

function hasUncleanedReplanCommand(events: OneShotRunEvent[]): boolean {
  const latestRequest = latestEventIndex(events, "control_replan_requested");
  const latestCleanupFailure = latestEventIndex(
    events,
    "replan_label_cleanup_failed",
  );
  const latestCleanupObserved = latestEventIndex(
    events,
    "replan_label_cleanup_observed",
  );
  return (
    latestRequest >= 0 &&
    latestCleanupFailure > latestRequest &&
    latestCleanupFailure > latestCleanupObserved
  );
}

export interface CreateQualifiedRunInput {
  jiraKey: string;
  epicKey?: string | null;
  ticketSummary: string;
  taskDescription?: string | null;
  ticketEvidenceRef?: TicketEvidenceRef | null;
  jiraIssueType?: string | null;
  jiraLabels?: string[];
  sourceTaskManagementId: number;
  customerId: number;
  repo: CodeRepository;
  branchName: string;
  baseCommitSha: string;
  qualification: QualificationAssessment;
  qualificationProvider?: string;
  qualificationModel?: string;
  qualificationMetrics?: QualificationStageMetrics;
  runGroupId?: number | null;
  repoSelectionMetadata?: Record<string, unknown>;
}

export interface CreateQualifiedRunGroupInput {
  jiraKey: string;
  epicKey?: string | null;
  ticketSummary: string;
  taskDescription?: string | null;
  ticketEvidenceRef?: TicketEvidenceRef | null;
  jiraIssueType?: string | null;
  jiraLabels?: string[];
  sourceTaskManagementId: number;
  customerId: number;
  groupMode?: "multi_repo" | "multi_branch_retrofit";
  groupMetadata?: Record<string, unknown>;
  runs: Array<{
    repo: CodeRepository;
    branchName: string;
    baseCommitSha: string;
    qualification: QualificationAssessment;
    qualificationProvider?: string;
    qualificationModel?: string;
    qualificationMetrics?: QualificationStageMetrics;
    repoSelectionMetadata?: Record<string, unknown>;
  }>;
}

export interface QualificationStageMetrics {
  durationMs?: number;
  toolCalls?: number;
  tokensUsed?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  costUsd?: number;
  modelUsed?: string;
  modelUsage?: OneShotModelUsage;
}

export interface OneShotMutationResult {
  publishError?: string;
}

export interface RecoverPlanningHandoffInput {
  runId: number;
  operatorId: string;
  operatorName: string;
  reason?: string;
}

export interface RecoverPlanningHandoffResult {
  oneshotRunId: number;
  stage: "planning";
  state: "queued_for_planning";
  version: 1;
}

export interface RecoverPlanContractViolationInput {
  runId: number;
  operatorId: string;
  operatorName: string;
  reason?: string;
}

export interface RecoverPlanContractViolationResult {
  oneshotRunId: number;
  stage: "planning";
  state: "queued_for_planning";
  version: number;
}

export interface ForceApproveResult extends OneShotMutationResult {
  state: OneShotRun["state"];
  implementationVersion?: number;
}

type HandoffRetryStep = "setup" | "publish";

const DEFAULT_HANDOFF_RETRY_DELAYS_MS = [0, 5000, 20000] as const;

type PlanContractViolationEventRow = mysql.RowDataPacket & {
  id: number;
  event_type?: string | null;
  from_state?: string | null;
  to_state?: string | null;
  metadata_json: string | Record<string, unknown> | null;
};

const PLAN_CONTRACT_RECOVERY_BLOCK_REASONS = new Set([
  "plan_contract_violation",
  "plan_contract_violation_replan_exhausted",
]);
const PLAN_CONTRACT_RECOVERY_REVERT_REASONS = new Set([
  "manual_plan_contract_violation_recovery_event_failed",
  "manual_plan_contract_violation_recovery_publish_failed",
]);

function parseMetadataObject(
  value: string | Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  if (typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return null;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function metadataStringArray(
  metadata: Record<string, unknown>,
  key: string,
  maxItems = 100,
): string[] {
  const value = metadata[key];
  if (!Array.isArray(value)) {
    return [];
  }
  const output: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const trimmed = item.trim();
    if (!trimmed || output.includes(trimmed)) {
      continue;
    }
    output.push(trimmed);
    if (output.length >= maxItems) {
      break;
    }
  }
  return output;
}

function metadataNumber(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataBoolean(
  metadata: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = metadata[key];
  return typeof value === "boolean" ? value : null;
}

function metadataReason(metadata: Record<string, unknown> | null): string | null {
  const reason = metadata?.reason;
  return typeof reason === "string" ? reason : null;
}

function isPlanContractRecoveryCandidateEvent(
  event: PlanContractViolationEventRow | null,
  metadata: Record<string, unknown> | null,
): boolean {
  const reason = metadataReason(metadata);
  if (!event || !reason) {
    return false;
  }
  if (
    event.event_type === "state_transition" &&
    event.to_state === "blocked" &&
    PLAN_CONTRACT_RECOVERY_BLOCK_REASONS.has(reason)
  ) {
    return true;
  }
  return (
    event.event_type === "state_revert" &&
    event.to_state === "blocked" &&
    PLAN_CONTRACT_RECOVERY_REVERT_REASONS.has(reason)
  );
}

function handoffRetryDelaysMs(): number[] {
  const raw = process.env.ONESHOT_HANDOFF_RETRY_DELAYS_MS?.trim();
  if (!raw) {
    return [...DEFAULT_HANDOFF_RETRY_DELAYS_MS];
  }

  const parsed = raw
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value >= 0);
  return parsed.length > 0 ? parsed : [...DEFAULT_HANDOFF_RETRY_DELAYS_MS];
}

export interface ReplanResult extends OneShotMutationResult {
  state: OneShotRun["state"];
  nextPlanVersion: number;
  skipped?: boolean;
  noActionReason?: string;
}

export interface OneShotReconcileResult {
  republished: number;
  terminated: number;
  failed: number;
}

export interface OneShotCiReconcileResult {
  checked: number;
  refreshed: number;
  blocked: number;
  failed: number;
}

interface TerminateRunInput {
  run: OneShotRun;
  reason: "stale_timeout" | "operator_kill";
  operator?: {
    id: string;
    display: string;
  };
  operatorReason?: string;
  staleTimeoutMinutes?: number;
}

interface TerminateRunResult {
  terminated: boolean;
  workspaceCleanupSucceeded: boolean;
}

function isStaleExecutingState(state: OneShotState): boolean {
  return STALE_EXECUTING_STATES.has(state);
}

function mapFailureStage(
  run: Pick<OneShotRun, "state" | "final_disposition">,
): "planning" | "review" | "implementation" | "code_review" | "testing" {
  switch (run.state) {
    case "queued_for_planning":
    case "planning":
      return "planning";
    case "queued_for_review":
    case "reviewing":
    case "needs_revision":
    case "approved":
      return "review";
    case "queued_for_implementation":
    case "implementing":
    case "replan_required":
      return "implementation";
    case "queued_for_code_review":
    case "code_reviewing":
      return "code_review";
    case "queued_for_testing":
    case "testing":
      return "testing";
    case "escalated":
      return run.final_disposition === "code_review_escalated"
        ? "code_review"
        : "review";
    default:
      return "planning";
  }
}

function sumQualificationTokens(
  metrics?: QualificationStageMetrics,
): number | null {
  if (!metrics?.tokensUsed) {
    return null;
  }

  const usage = metrics.tokensUsed;
  return (usage.input ?? 0) + (usage.output ?? 0);
}

function buildQualificationMetricMetadata(
  metrics?: QualificationStageMetrics,
): Record<string, unknown> {
  if (!metrics) {
    return {};
  }

  const metadata: Record<string, unknown> = {};
  const tokenUsage = sumQualificationTokens(metrics);
  if (tokenUsage !== null) {
    metadata.stage_tokens_used = tokenUsage;
  }
  if (metrics.tokensUsed) {
    metadata.tokens_used = metrics.tokensUsed;
  }
  if (metrics.modelUsage) {
    metadata.model_usage = metrics.modelUsage;
  }
  if (typeof metrics.costUsd === "number" && Number.isFinite(metrics.costUsd)) {
    metadata.stage_cost_usd = metrics.costUsd;
  }
  if (
    typeof metrics.durationMs === "number" &&
    Number.isFinite(metrics.durationMs)
  ) {
    metadata.stage_duration_ms = metrics.durationMs;
  }
  return metadata;
}

function inferProviderForModel(model?: string): string {
  const normalized = model?.toLowerCase() ?? "";
  if (normalized.includes("gpt") || normalized.includes("openai")) {
    return "openai";
  }
  return "anthropic";
}

function qualificationProvider(
  explicitProvider: string | undefined,
  metrics?: QualificationStageMetrics,
): string {
  return explicitProvider ?? inferProviderForModel(metrics?.modelUsed);
}

function qualificationModel(
  explicitModel: string | undefined,
  metrics?: QualificationStageMetrics,
): string {
  return (
    explicitModel ||
    metrics?.modelUsed ||
    process.env.ANTHROPIC_MODEL ||
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
  );
}

function buildTerminationLastError(input: TerminateRunInput): string {
  if (input.reason === "stale_timeout") {
    return (
      `OneShot run auto-terminated after exceeding the ${input.staleTimeoutMinutes ?? ACTIVE_RUN_STALE_SCAN_MINUTES} minute ` +
      `stale timeout while in ${input.run.state}.`
    );
  }

  const operator = input.operator;
  const reasonSuffix = input.operatorReason?.trim()
    ? ` Reason: ${input.operatorReason.trim()}`
    : "";
  return `OneShot run terminated by ${operator?.display ?? "unknown operator"} (${operator?.id ?? "unknown"}).${reasonSuffix}`;
}

function buildTerminationNotificationBody(
  input: TerminateRunInput,
  errorMessage: string,
): string {
  if (input.reason === "stale_timeout") {
    return `# OneShot Run Failed for ${input.run.jira_key}\n\n${errorMessage}`;
  }

  const reasonLine = input.operatorReason?.trim()
    ? `\n\nOperator reason: ${input.operatorReason.trim()}`
    : "";
  return (
    `# OneShot Run Failed for ${input.run.jira_key}\n\n` +
    `Run terminated by ${input.operator?.display ?? "unknown operator"} (${input.operator?.id ?? "unknown"}).` +
    reasonLine
  );
}

function hasStoredPostmortemEvent(events: OneShotRunEvent[]): boolean {
  return events.some(
    (event) =>
      event.event_type === "artifact_stored" && event.stage === "postmortem",
  );
}

function findTerminationFailureEvent(
  events: OneShotRunEvent[],
): OneShotRunEvent | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (
      event.event_type !== "state_transition" ||
      event.to_state !== "failed"
    ) {
      continue;
    }

    const reason = event.metadata_json?.reason;
    if (
      typeof reason === "string" &&
      TERMINATION_POSTMORTEM_REASONS.has(reason)
    ) {
      return event;
    }
  }

  return null;
}

function extractImpactedFilesFromArtifactMetadata(
  metadata: Record<string, unknown> | null,
): string[] {
  const impactedFiles = metadata?.impactedFiles;
  return Array.isArray(impactedFiles)
    ? impactedFiles.filter(
        (file): file is string =>
          typeof file === "string" && file.trim().length > 0,
      )
    : [];
}

function hasPriorImplementationOutput(
  run: Pick<
    OneShotRun,
    "current_implementation_branch" | "current_implementation_commit_sha"
  >,
): boolean {
  return Boolean(
    run.current_implementation_branch && run.current_implementation_commit_sha,
  );
}

function getRequeueDetails(run: OneShotRun): {
  stage: OneShotQueueStage;
  version: number;
  revision: boolean;
} | null {
  switch (run.state) {
    case "queued_for_planning":
      return {
        stage: "planning",
        version: (run.current_plan_version ?? 0) + 1,
        revision:
          run.current_plan_version !== null &&
          run.final_disposition !== "replan_requested",
      };
    case "queued_for_review":
      if (!run.current_plan_version) {
        return null;
      }
      return {
        stage: "review",
        version: run.current_plan_version,
        revision: false,
      };
    case "queued_for_implementation":
      if (!run.current_implementation_version) {
        return null;
      }
      return {
        stage: "implementation",
        version: run.current_implementation_version,
        revision: hasPriorImplementationOutput(run),
      };
    case "queued_for_code_review":
      if (!run.current_code_review_version) {
        return null;
      }
      return {
        stage: "code_review",
        version: run.current_code_review_version,
        revision: false,
      };
    case "queued_for_testing":
      if (!run.current_test_version) {
        return null;
      }
      return {
        stage: "testing",
        version: run.current_test_version,
        revision: false,
      };
    case "planning":
      return {
        stage: "planning",
        version: (run.current_plan_version ?? 0) + 1,
        revision:
          run.current_plan_version !== null &&
          run.final_disposition !== "replan_requested",
      };
    case "reviewing":
      if (!run.current_plan_version) {
        return null;
      }
      return {
        stage: "review",
        version: run.current_plan_version,
        revision: false,
      };
    case "implementing":
      return {
        stage: "implementation",
        version: (run.current_implementation_version ?? 0) + 1,
        revision: hasPriorImplementationOutput(run),
      };
    case "code_reviewing":
      if (!run.current_code_review_version) {
        return null;
      }
      return {
        stage: "code_review",
        version: run.current_code_review_version,
        revision: false,
      };
    case "testing":
      if (!run.current_test_version) {
        return null;
      }
      return {
        stage: "testing",
        version: run.current_test_version,
        revision: false,
      };
    default:
      return null;
  }
}

export class OneShotService {
  private readonly publisher: OneShotPublisher;
  private readonly s3Client: S3Client;
  private readonly config = getOneShotSharedConfig();

  constructor(
    private readonly db: Database,
    publisher?: OneShotPublisher,
    s3Client?: S3Client,
  ) {
    this.publisher = publisher ?? new OneShotPublisher();
    this.s3Client =
      s3Client ??
      createS3Client({
        region: process.env.AWS_REGION || "us-east-2",
      });
  }

  get database(): OneShotDatabase {
    return new OneShotDatabase(this.db.getPool());
  }

  private createWorkspaceManager(): OneShotWorkspaceManager {
    return createLeasedOneShotWorkspaceManager(this.database, {
      repoBasePath: this.config.repoAdminBasePath,
      repoCacheBasePath: this.config.repoCacheBasePath,
      workspaceBasePath: this.config.workspaceBasePath,
      worktreeBasePath: this.config.worktreeBasePath,
      leaseOwnerTaskArn: process.env.ECS_TASK_ARN ?? `pid:${process.pid}`,
      leaseTtlSeconds: this.config.workspaceLeaseTtlSeconds,
      leaseHeartbeatSeconds: this.config.workspaceLeaseHeartbeatSeconds,
      repoCacheFreshnessTtlMs: this.config.repoCacheFreshnessTtlMs,
    });
  }

  private async prepareInitialRunBranchWorkspace(input: {
    runId: number;
    jiraKey: string;
    repo: CodeRepository;
    targetBranchName: string;
    baseCommitSha: string;
    implementationBranch: string;
    allowExistingBranchHead?: boolean;
  }): Promise<void> {
    const workspaceManager = this.createWorkspaceManager();
    const existingRemoteBranch = input.allowExistingBranchHead
      ? await getRemoteBranchHead(input.repo, input.implementationBranch)
      : null;
    const workspaceBaseSha = existingRemoteBranch?.headSha ?? input.baseCommitSha;
    const workspace = await workspaceManager.prepareImplementerWorkspace(
      input.runId,
      input.repo,
      workspaceBaseSha,
      input.implementationBranch,
    );

    try {
      let branch: { created: boolean; headSha: string };
      if (existingRemoteBranch) {
        if (existingRemoteBranch.headSha !== input.baseCommitSha) {
          const targetBaseIsAncestor = await isAncestor(
            workspace.workspacePath,
            input.baseCommitSha,
            existingRemoteBranch.headSha,
          );
          if (!targetBaseIsAncestor) {
            throw new Error(
              `Remote Epic branch ${input.implementationBranch} already exists at ${existingRemoteBranch.headSha}, which is not a descendant of target base ${input.baseCommitSha}`,
            );
          }
        }
        branch = {
          created: false,
          headSha: existingRemoteBranch.headSha,
        };
      } else {
        branch = await createRemoteBranchIfMissing(
          workspace.workspacePath,
          input.repo,
          input.implementationBranch,
          input.baseCommitSha,
        );
      }
      await this.database.runs.ensureRunBranchContract({
        runId: input.runId,
        branchName: input.implementationBranch,
        baseCommitSha: input.baseCommitSha,
      });
      await this.database.events.createEvent({
        oneshot_run_id: input.runId,
        event_type: branch.created ? "run_branch_created" : "run_branch_reused",
        from_state: "queued_for_planning",
        to_state: "queued_for_planning",
        stage: "qualification",
        metadata_json: {
          jiraKey: input.jiraKey,
          repoId: input.repo.id,
          repoName: input.repo.repo_name,
          targetBranchName: input.targetBranchName,
          implementationBranch: input.implementationBranch,
          baseCommitSha: input.baseCommitSha,
          branchHeadSha: branch.headSha,
          workspaceBaseSha,
          sharedEpicBranch: Boolean(input.allowExistingBranchHead),
        },
      });
      await this.database.events.createEvent({
        oneshot_run_id: input.runId,
        event_type: "run_workspace_prepared",
        from_state: "queued_for_planning",
        to_state: "queued_for_planning",
        stage: "qualification",
        metadata_json: {
          jiraKey: input.jiraKey,
          repoId: input.repo.id,
          repoName: input.repo.repo_name,
          workspacePath: workspace.workspacePath,
          statePath: workspace.statePath,
          targetBranchName: input.targetBranchName,
          implementationBranch: input.implementationBranch,
          baseCommitSha: input.baseCommitSha,
          workspaceBaseSha,
          branchHeadSha: branch.headSha,
          sharedEpicBranch: Boolean(input.allowExistingBranchHead),
        },
      });
      logger.info(
        {
          runId: input.runId,
          jiraKey: input.jiraKey,
          repoName: input.repo.repo_name,
          targetBranchName: input.targetBranchName,
          implementationBranch: input.implementationBranch,
          baseCommitSha: input.baseCommitSha,
          workspaceBaseSha,
          branchCreated: branch.created,
          workspacePath: workspace.workspacePath,
          sharedEpicBranch: Boolean(input.allowExistingBranchHead),
        },
        "Prepared initial OneShot run branch workspace before planning",
      );
    } finally {
      await workspace.cleanup().catch((error: unknown) => {
        logger.warn(
          {
            runId: input.runId,
            jiraKey: input.jiraKey,
            repoName: input.repo.repo_name,
            workspacePath: workspace.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          },
          "Initial OneShot run branch workspace cleanup failed",
        );
        return undefined;
      });
    }
  }

  private async alignRunBranchForReplan(input: {
    run: OneShotRun;
    repo: CodeRepository;
    baseCommitSha: string;
    normalizeSharedEpicBranch: boolean;
  }): Promise<{
    branchName: string;
    previousBranchName: string | null;
    previousRemoteHeadSha: string | null;
    branchHeadSha: string;
    normalizedSharedEpicBranch: boolean;
  }> {
    const previousBranchName = input.run.run_branch_name;
    const branchName = input.normalizeSharedEpicBranch
      ? buildImplementationBranchName(input.run.jira_key, input.run.id)
      : resolveRunBranchName(input.run);
    const workspaceManager = this.createWorkspaceManager();
    const remoteHead = await getRemoteBranchHead(input.repo, branchName);
    const workspace = await workspaceManager.prepareImplementerWorkspace(
      input.run.id,
      input.repo,
      input.baseCommitSha,
      branchName,
    );

    try {
      let branchHeadSha = input.baseCommitSha;
      let createdRemoteBranch = false;
      let resetRemoteBranch = false;
      if (!remoteHead) {
        const branch = await createRemoteBranchIfMissing(
          workspace.workspacePath,
          input.repo,
          branchName,
          input.baseCommitSha,
        );
        branchHeadSha = branch.headSha;
        createdRemoteBranch = branch.created;
      } else if (remoteHead.headSha !== input.baseCommitSha) {
        await pushBranch(workspace.workspacePath, input.repo, branchName, {
          expectedRemoteHeadSha: remoteHead.headSha,
        });
        branchHeadSha = input.baseCommitSha;
        resetRemoteBranch = true;
      } else {
        branchHeadSha = remoteHead.headSha;
      }

      await this.database.runs.ensureRunBranchContract({
        runId: input.run.id,
        branchName,
        baseCommitSha: input.baseCommitSha,
      });
      await this.database.events.createEvent({
        oneshot_run_id: input.run.id,
        event_type:
          input.normalizeSharedEpicBranch || resetRemoteBranch
            ? "run_branch_repaired"
            : createdRemoteBranch
              ? "run_branch_created"
              : "run_branch_reused",
        from_state: input.run.state,
        to_state: input.run.state,
        stage: "qualification",
        metadata_json: {
          reason: "control_replan_branch_aligned",
          repoId: input.repo.id,
          repoName: input.repo.repo_name,
          targetBranchName: input.run.branch_name,
          previousRunBranchName: previousBranchName,
          runBranchName: branchName,
          baseCommitSha: input.baseCommitSha,
          previousRemoteHeadSha: remoteHead?.headSha ?? null,
          branchHeadSha,
          createdRemoteBranch,
          resetRemoteBranch,
          normalizedSharedEpicBranch: input.normalizeSharedEpicBranch,
          sharedEpicBranch: isSharedEpicImplementationBranchName(branchName),
          workspacePath: workspace.workspacePath,
        },
      });
      return {
        branchName,
        previousBranchName,
        previousRemoteHeadSha: remoteHead?.headSha ?? null,
        branchHeadSha,
        normalizedSharedEpicBranch: input.normalizeSharedEpicBranch,
      };
    } finally {
      await workspace.cleanup().catch((error: unknown) => {
        logger.warn(
          {
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            repoName: input.repo.repo_name,
            workspacePath: workspace.workspacePath,
            error: error instanceof Error ? error.message : String(error),
          },
          "Replan run branch alignment workspace cleanup failed",
        );
        return undefined;
      });
    }
  }

  private async failRunBeforePlanning(input: {
    runId: number;
    jiraKey: string;
    reason: string;
    error: unknown;
  }): Promise<string> {
    const errorMessage = sanitizeErrorMessage(
      input.error instanceof Error ? input.error.message : String(input.error),
    );
    const lastError = `${input.reason}: ${errorMessage}`;
    await this.database.runs.updateRunState(input.runId, "failed", {
      last_error: lastError,
      final_disposition: "workspace_setup_failed",
    });
    await this.database.events.createEvent({
      oneshot_run_id: input.runId,
      event_type: "state_transition",
      from_state: "queued_for_planning",
      to_state: "failed",
      stage: "qualification",
      metadata_json: {
        reason: "initial_run_workspace_setup_failed",
        error: errorMessage,
      },
    });
    logger.error(
      {
        runId: input.runId,
        jiraKey: input.jiraKey,
        error: errorMessage,
      },
      "Failed to prepare initial OneShot run branch workspace before planning",
    );
    return lastError;
  }

  private async createHandoffRetryEvent(input: {
    runId: number;
    jiraKey: string;
    step: HandoffRetryStep;
    state: OneShotState;
    attemptNumber: number;
    maxAttempts: number;
    reason:
      | "post_qualification_handoff_retry"
      | "post_qualification_handoff_retry_exhausted";
    error: unknown;
    nextDelayMs?: number | null;
  }): Promise<void> {
    const classified = classifyHandoffError(input.error);
    try {
      await this.database.events.createEvent({
        oneshot_run_id: input.runId,
        event_type: "state_transition",
        from_state: input.state,
        to_state: input.state,
        stage: "qualification",
        metadata_json: {
          reason: input.reason,
          step: input.step,
          attemptNumber: input.attemptNumber,
          maxAttempts: input.maxAttempts,
          retryable: classified.retryable,
          errorCategory: classified.category,
          error: classified.message,
          nextDelayMs: input.nextDelayMs ?? null,
        },
      });
    } catch (error) {
      logger.warn(
        {
          runId: input.runId,
          jiraKey: input.jiraKey,
          step: input.step,
          eventReason: input.reason,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to persist post-qualification handoff retry event; continuing retry flow",
      );
    }
  }

  /**
   * Retry helper for handoff operations (workspace setup + planning publish).
   * Attempts up to 3 total tries by default: immediate, then after 5s/20s.
   */
  private async retryHandoff<T>(input: {
    runId: number;
    jiraKey: string;
    step: HandoffRetryStep;
    label: string;
    fn: () => Promise<T>;
    eventState?: OneShotState;
  }): Promise<T> {
    const delays = handoffRetryDelaysMs();
    const maxAttempts = delays.length;
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await input.fn();
      } catch (error) {
        lastError = error;
        const classified = classifyHandoffError(error);
        const attemptNumber = attempt + 1;
        const nextDelayMs = delays[attempt + 1] ?? null;

        if (!classified.retryable) {
          logger.warn(
            {
              label: input.label,
              runId: input.runId,
              jiraKey: input.jiraKey,
              step: input.step,
              attempt: attemptNumber,
              errorCategory: classified.category,
              error: classified.message,
            },
            "Handoff non-retryable error; failing immediately",
          );
          throw error;
        }

        if (attempt < maxAttempts - 1) {
          await this.createHandoffRetryEvent({
            runId: input.runId,
            jiraKey: input.jiraKey,
            step: input.step,
            state: input.eventState ?? "queued_for_planning",
            attemptNumber,
            maxAttempts,
            reason: "post_qualification_handoff_retry",
            error,
            nextDelayMs,
          });
          logger.warn(
            {
              label: input.label,
              runId: input.runId,
              jiraKey: input.jiraKey,
              step: input.step,
              attempt: attemptNumber,
              nextDelayMs,
              errorCategory: classified.category,
              error: classified.message,
            },
            "Handoff retryable error; retrying after backoff",
          );
          if (nextDelayMs && nextDelayMs > 0) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, nextDelayMs),
            );
          }
          continue;
        }

        await this.createHandoffRetryEvent({
          runId: input.runId,
          jiraKey: input.jiraKey,
          step: input.step,
          state: input.eventState ?? "queued_for_planning",
          attemptNumber,
          maxAttempts,
          reason: "post_qualification_handoff_retry_exhausted",
          error,
          nextDelayMs: null,
        });
      }
    }

    throw lastError;
  }

  /**
   * Guarded failure path for publish exhaustion: only writes failed state if
   * the run is still in queued_for_planning (the planner hasn't claimed it).
   * Uses conditional update to close the race window between the read and write.
   */
  private async failRunAfterPublishExhaustion(input: {
    runId: number;
    jiraKey: string;
    error: unknown;
  }): Promise<void> {
    const errorMessage = sanitizeErrorMessage(
      input.error instanceof Error
        ? input.error.message
        : String(input.error),
    );
    const transitioned = await this.database.runs.updateRunStateIfCurrentState(
      input.runId,
      "queued_for_planning",
      "failed",
      {
        last_error: `Planning publish exhausted all retry attempts: ${errorMessage}`,
        final_disposition: "planning_publish_failed",
      },
    );
    if (!transitioned) {
      logger.warn(
        {
          runId: input.runId,
          jiraKey: input.jiraKey,
        },
        "Skipping publish-exhaustion failure write because run has already moved past queued_for_planning",
      );
      return;
    }
    await this.database.events.createEvent({
      oneshot_run_id: input.runId,
      event_type: "state_transition",
      from_state: "queued_for_planning",
      to_state: "failed",
      stage: "qualification",
      metadata_json: {
        reason: "planning_publish_exhausted",
        error: errorMessage,
      },
    });
    logger.error(
      {
        runId: input.runId,
        jiraKey: input.jiraKey,
        error: errorMessage,
      },
      "Planning publish exhausted all retry attempts — run marked failed",
    );
  }

  async getActiveRunByJiraKey(jiraKey: string): Promise<OneShotRun | null> {
    return this.database.runs.getActiveRunByJiraKey(jiraKey);
  }

  async getLatestRunByJiraKey(jiraKey: string): Promise<OneShotRun | null> {
    return this.database.runs.getLatestRunByJiraKey(jiraKey);
  }

  async getLatestRunWithPrByJiraKey(
    jiraKey: string,
  ): Promise<OneShotRun | null> {
    return this.database.runs.getLatestRunWithPrByJiraKey(jiraKey);
  }

  async createQualifiedRun(
    input: CreateQualifiedRunInput,
  ): Promise<{ runId: number } & OneShotMutationResult> {
    const artifactBucket = this.config.artifactBucket;
    const processingMode = resolveOneShotProcessingMode({
      jiraLabels: input.jiraLabels,
      ticketSummary: input.ticketSummary,
    });
    const ticketType = resolveOneShotTicketType({
      jiraIssueType: input.jiraIssueType,
      jiraLabels: input.jiraLabels,
      ticketSummary: input.ticketSummary,
      taskDescription: input.taskDescription,
    });
    const connection = await this.db.getPool().getConnection();
    let runId = 0;
    const qualificationTokenUsage = sumQualificationTokens(
      input.qualificationMetrics,
    );
    const qualificationMetricMetadata = buildQualificationMetricMetadata(
      input.qualificationMetrics,
    );
    const artifactProvider = qualificationProvider(
      input.qualificationProvider,
      input.qualificationMetrics,
    );
    const artifactModel = qualificationModel(
      input.qualificationModel,
      input.qualificationMetrics,
    );
    logger.info(
      {
        jiraKey: input.jiraKey,
        sourceTaskManagementId: input.sourceTaskManagementId,
        customerId: input.customerId,
        repoId: input.repo.id,
        repoName: input.repo.repo_name,
        branchName: input.branchName,
        baseCommitSha: input.baseCommitSha,
      },
      "Creating OneShot run from qualification",
    );

    try {
      await connection.beginTransaction();

      const txdb = new OneShotDatabase(connection);
      runId = await txdb.runs.createRun({
        jira_key: input.jiraKey,
        epic_key: input.epicKey ?? null,
        jira_issue_type: ticketType.jiraIssueType,
        ticket_type: ticketType.ticketType,
        ticket_type_source: ticketType.ticketTypeSource,
        source_task_management_id: input.sourceTaskManagementId,
        run_group_id: input.runGroupId ?? null,
        workspace_mode: "v2",
        customer_id: input.customerId,
        repo_id: input.repo.id,
        branch_name: input.branchName,
        base_commit_sha: input.baseCommitSha,
        state: "queued_for_planning",
        max_review_loops: this.config.maxReviewLoops,
        max_verification_loops: this.config.maxVerificationLoops,
        max_total_tokens: this.config.maxTotalTokens,
      });
      const runImplementationBranch = buildRunImplementationBranchName({
        jiraKey: input.jiraKey,
        runId,
        epicKey: input.epicKey,
        targetBranchName: input.branchName,
      });
      await txdb.runs.ensureRunBranchContract({
        runId,
        branchName: runImplementationBranch,
        baseCommitSha: input.baseCommitSha,
      });

      const artifactKey = buildOneShotArtifactKey(
        this.config,
        input.jiraKey,
        runId,
        "qualification",
        1,
      );
      const artifactBody = {
        ...input.qualification,
        jiraKey: input.jiraKey,
        epicKey: input.epicKey ?? null,
        ticketSummary: input.ticketSummary,
        ticketEvidenceRef: publicTicketEvidenceRef(input.ticketEvidenceRef),
        ticketEvidenceStats: input.ticketEvidenceRef?.stats ?? null,
        jiraIssueType: ticketType.jiraIssueType,
        ticketType: ticketType.ticketType,
        ticketTypeSource: ticketType.ticketTypeSource,
        jiraLabels: input.jiraLabels ?? [],
        repoId: input.repo.id,
        repoName: input.repo.repo_name,
        repoUrl: input.repo.repo_url,
        branchName: input.branchName,
        baseCommitSha: input.baseCommitSha,
        implementationBranch: runImplementationBranch,
        runGroupId: input.runGroupId ?? null,
        processingMode,
        repoSelectionMetadata: input.repoSelectionMetadata ?? null,
        storedAt: new Date().toISOString(),
      };

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: artifactBucket,
          Key: artifactKey,
          Body: JSON.stringify(artifactBody, null, 2),
          ContentType: "application/json",
        }),
      );

      await txdb.artifacts.upsertArtifact({
        oneshot_run_id: runId,
        stage: "qualification",
        version: 1,
        status: "completed",
        s3_bucket: artifactBucket,
        s3_key: artifactKey,
        provider: artifactProvider,
        model: artifactModel,
        metadata_json: {
          qualified: input.qualification.qualified,
          epic_key: input.epicKey ?? null,
          repo_id: input.repo.id,
          branch_name: input.branchName,
          implementation_branch: runImplementationBranch,
          run_group_id: input.runGroupId ?? null,
          processing_mode: processingMode,
          jira_issue_type: ticketType.jiraIssueType,
          ticket_type: ticketType.ticketType,
          ticket_type_source: ticketType.ticketTypeSource,
          repo_selection: input.repoSelectionMetadata ?? null,
          ticket_evidence: compactTicketEvidenceMetadata(
            input.ticketEvidenceRef,
          ),
          ...qualificationMetricMetadata,
        },
        started_at: new Date(),
        completed_at: new Date(),
      });

      if (qualificationTokenUsage !== null && qualificationTokenUsage > 0) {
        await txdb.runs.addTokenUsage(runId, qualificationTokenUsage);
      }

      await persistTicketReadinessScore(connection, {
        taskManagementId: input.sourceTaskManagementId,
        title: input.ticketSummary,
        taskDescription: input.taskDescription ?? input.ticketSummary,
        scoreSource: "intake",
        acceptanceCriteriaPresent:
          input.qualification.acceptanceCriteriaPresent,
      });

      await connection.commit();
      logger.info(
        {
          jiraKey: input.jiraKey,
          runId,
          artifactBucket,
          artifactStage: "qualification",
        },
        "Created OneShot run and stored qualification artifact",
      );
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const runImplementationBranch = buildRunImplementationBranchName({
      jiraKey: input.jiraKey,
      runId,
      epicKey: input.epicKey,
      targetBranchName: input.branchName,
    });
    try {
      await this.retryHandoff({
        runId,
        jiraKey: input.jiraKey,
        step: "setup",
        label: `workspace-setup:${runId}`,
        fn: () =>
          this.prepareInitialRunBranchWorkspace({
            runId,
            jiraKey: input.jiraKey,
            repo: input.repo,
            targetBranchName: input.branchName,
            baseCommitSha: input.baseCommitSha,
            implementationBranch: runImplementationBranch,
            allowExistingBranchHead: false,
          }),
      });
    } catch (error) {
      const publishError = await this.failRunBeforePlanning({
        runId,
        jiraKey: input.jiraKey,
        reason: "Initial run branch workspace setup failed",
        error,
      });
      return { runId, publishError };
    }

    try {
      await this.retryHandoff({
        runId,
        jiraKey: input.jiraKey,
        step: "publish",
        label: `planning-publish:${runId}`,
        fn: () =>
          this.publisher.publishStageMessage(
            runId,
            "planning",
            1,
            "queued_for_planning",
            false,
          ),
      });
      logger.info(
        {
          jiraKey: input.jiraKey,
          runId,
          planVersion: 1,
        },
        "Queued OneShot run for planning after qualification",
      );
      return { runId };
    } catch (error) {
      const publishError =
        error instanceof Error ? error.message : String(error);
      logger.error(
        {
          jiraKey: input.jiraKey,
          runId,
          publishError,
        },
        "Failed to publish planning message after qualification — attempting guarded state write",
      );
      await this.failRunAfterPublishExhaustion({
        runId,
        jiraKey: input.jiraKey,
        error,
      });
      return {
        runId,
        publishError,
      };
    }
  }

  async createQualifiedRunGroup(input: CreateQualifiedRunGroupInput): Promise<
    {
      runGroupId: number;
      runIds: number[];
    } & OneShotMutationResult
  > {
    if (input.runs.length < 2) {
      throw new Error(
        "createQualifiedRunGroup requires at least two child runs",
      );
    }

    const artifactBucket = this.config.artifactBucket;
    const processingMode = resolveOneShotProcessingMode({
      jiraLabels: input.jiraLabels,
      ticketSummary: input.ticketSummary,
    });
    const ticketType = resolveOneShotTicketType({
      jiraIssueType: input.jiraIssueType,
      jiraLabels: input.jiraLabels,
      ticketSummary: input.ticketSummary,
      taskDescription: input.taskDescription,
    });
    const connection = await this.db.getPool().getConnection();
    let runGroupId = 0;
    const runIds: number[] = [];
    const initialRunWorkspaces: Array<{
      runId: number;
      repo: CodeRepository;
      targetBranchName: string;
      baseCommitSha: string;
      implementationBranch: string;
    }> = [];

    logger.info(
      {
        jiraKey: input.jiraKey,
        sourceTaskManagementId: input.sourceTaskManagementId,
        customerId: input.customerId,
        repos: input.runs.map((run) => run.repo.repo_name),
      },
      "Creating multi-repo OneShot run group from qualification",
    );

    try {
      await connection.beginTransaction();

      const txdb = new OneShotDatabase(connection);
      runGroupId = await txdb.runGroups.createGroup({
        jira_key: input.jiraKey,
        source_task_management_id: input.sourceTaskManagementId,
        metadata_json: {
          // Spread caller-supplied groupMetadata first so the structured
          // mode/repos keys always win, preventing accidental clobbering by
          // future callers that pass a groupMetadata with those keys.
          ...(input.groupMetadata ?? {}),
          mode: input.groupMode ?? "multi_repo",
          repos: input.runs.map((run) => ({
            repo_id: run.repo.id,
            repo_name: run.repo.repo_name,
            branch_name: run.branchName,
            base_commit_sha: run.baseCommitSha,
          })),
        },
      });

      for (const child of input.runs) {
        const qualificationTokenUsage = sumQualificationTokens(
          child.qualificationMetrics,
        );
        const qualificationMetricMetadata = buildQualificationMetricMetadata(
          child.qualificationMetrics,
        );
        const artifactProvider = qualificationProvider(
          child.qualificationProvider,
          child.qualificationMetrics,
        );
        const artifactModel = qualificationModel(
          child.qualificationModel,
          child.qualificationMetrics,
        );
        const runId = await txdb.runs.createRun({
          run_group_id: runGroupId,
          workspace_mode: "v2",
          jira_key: input.jiraKey,
          epic_key: input.epicKey ?? null,
          jira_issue_type: ticketType.jiraIssueType,
          ticket_type: ticketType.ticketType,
          ticket_type_source: ticketType.ticketTypeSource,
          source_task_management_id: input.sourceTaskManagementId,
          customer_id: input.customerId,
          repo_id: child.repo.id,
          branch_name: child.branchName,
          base_commit_sha: child.baseCommitSha,
          state: "queued_for_planning",
          max_review_loops: this.config.maxReviewLoops,
          max_verification_loops: this.config.maxVerificationLoops,
          max_total_tokens: this.config.maxTotalTokens,
        });
        runIds.push(runId);
        const implementationBranch = buildRunImplementationBranchName({
          jiraKey: input.jiraKey,
          runId,
          epicKey: input.epicKey,
          targetBranchName: child.branchName,
        });
        await txdb.runs.ensureRunBranchContract({
          runId,
          branchName: implementationBranch,
          baseCommitSha: child.baseCommitSha,
        });
        initialRunWorkspaces.push({
          runId,
          repo: child.repo,
          targetBranchName: child.branchName,
          baseCommitSha: child.baseCommitSha,
          implementationBranch,
        });

        const artifactKey = buildOneShotArtifactKey(
          this.config,
          input.jiraKey,
          runId,
          "qualification",
          1,
        );
        const artifactBody = {
          ...child.qualification,
          jiraKey: input.jiraKey,
          epicKey: input.epicKey ?? null,
          ticketSummary: input.ticketSummary,
          ticketEvidenceRef: publicTicketEvidenceRef(input.ticketEvidenceRef),
          ticketEvidenceStats: input.ticketEvidenceRef?.stats ?? null,
          jiraIssueType: ticketType.jiraIssueType,
          ticketType: ticketType.ticketType,
          ticketTypeSource: ticketType.ticketTypeSource,
          jiraLabels: input.jiraLabels ?? [],
          repoId: child.repo.id,
          repoName: child.repo.repo_name,
          repoUrl: child.repo.repo_url,
          branchName: child.branchName,
          baseCommitSha: child.baseCommitSha,
          implementationBranch,
          runGroupId,
          processingMode,
          repoSelectionMetadata: child.repoSelectionMetadata ?? null,
          storedAt: new Date().toISOString(),
        };

        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: artifactBucket,
            Key: artifactKey,
            Body: JSON.stringify(artifactBody, null, 2),
            ContentType: "application/json",
          }),
        );

        await txdb.artifacts.upsertArtifact({
          oneshot_run_id: runId,
          stage: "qualification",
          version: 1,
          status: "completed",
          s3_bucket: artifactBucket,
          s3_key: artifactKey,
          provider: artifactProvider,
          model: artifactModel,
          metadata_json: {
            qualified: child.qualification.qualified,
            epic_key: input.epicKey ?? null,
            repo_id: child.repo.id,
            branch_name: child.branchName,
            implementation_branch: implementationBranch,
            run_group_id: runGroupId,
            processing_mode: processingMode,
            jira_issue_type: ticketType.jiraIssueType,
            ticket_type: ticketType.ticketType,
            ticket_type_source: ticketType.ticketTypeSource,
            repo_selection: child.repoSelectionMetadata ?? null,
            ticket_evidence: compactTicketEvidenceMetadata(
              input.ticketEvidenceRef,
            ),
            ...qualificationMetricMetadata,
          },
          started_at: new Date(),
          completed_at: new Date(),
        });

        if (qualificationTokenUsage !== null && qualificationTokenUsage > 0) {
          await txdb.runs.addTokenUsage(runId, qualificationTokenUsage);
        }
      }

      await persistTicketReadinessScore(connection, {
        taskManagementId: input.sourceTaskManagementId,
        title: input.ticketSummary,
        taskDescription: input.taskDescription ?? input.ticketSummary,
        scoreSource: "intake",
        acceptanceCriteriaPresent: input.runs.some(
          (run) => run.qualification.acceptanceCriteriaPresent,
        ),
      });

      await connection.commit();
      logger.info(
        {
          jiraKey: input.jiraKey,
          runGroupId,
          runIds,
          artifactBucket,
        },
        "Created multi-repo OneShot run group and stored qualification artifacts",
      );
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const publishErrors: string[] = [];
    const setupFailedRunIds = new Set<number>();
    for (const workspaceInput of initialRunWorkspaces) {
      try {
        await this.retryHandoff({
          runId: workspaceInput.runId,
          jiraKey: input.jiraKey,
          step: "setup",
          label: `workspace-setup:${workspaceInput.runId}`,
          fn: () =>
            this.prepareInitialRunBranchWorkspace({
              ...workspaceInput,
              jiraKey: input.jiraKey,
              allowExistingBranchHead: false,
            }),
        });
      } catch (error) {
        const setupError = await this.failRunBeforePlanning({
          runId: workspaceInput.runId,
          jiraKey: input.jiraKey,
          reason: "Initial run branch workspace setup failed",
          error,
        });
        setupFailedRunIds.add(workspaceInput.runId);
        publishErrors.push(`run-${workspaceInput.runId}: ${setupError}`);
      }
    }

    for (const runId of runIds) {
      if (setupFailedRunIds.has(runId)) {
        continue;
      }
      try {
        await this.retryHandoff({
          runId,
          jiraKey: input.jiraKey,
          step: "publish",
          label: `planning-publish:${runId}`,
          fn: () =>
            this.publisher.publishStageMessage(
              runId,
              "planning",
              1,
              "queued_for_planning",
              false,
            ),
        });
      } catch (error) {
        const publishError =
          error instanceof Error ? error.message : String(error);
        publishErrors.push(`run-${runId}: ${publishError}`);
        logger.error(
          {
            jiraKey: input.jiraKey,
            runGroupId,
            runId,
            publishError,
          },
          "Failed to publish planning message after multi-repo qualification — attempting guarded state write",
        );
        await this.failRunAfterPublishExhaustion({
          runId,
          jiraKey: input.jiraKey,
          error,
        });
      }
    }

    return {
      runGroupId,
      runIds,
      publishError:
        publishErrors.length > 0 ? publishErrors.join("; ") : undefined,
    };
  }

  async recoverPlanningHandoff(
    input: RecoverPlanningHandoffInput,
  ): Promise<RecoverPlanningHandoffResult> {
    const run = await this.database.runs.getRunById(input.runId);
    if (!run) {
      throw new Error(`OneShot run ${input.runId} was not found`);
    }
    if (run.state !== "failed") {
      throw new Error(
        `Only failed OneShot runs can be recovered; current state is ${run.state}`,
      );
    }
    if (
      run.final_disposition !== "workspace_setup_failed" &&
      run.final_disposition !== "planning_publish_failed"
    ) {
      throw new Error(
        `Run ${run.id} is not a qualification-to-planning handoff failure`,
      );
    }

    const currentCandidate =
      await this.database.candidateVersions.getCurrentCandidate(run.id);
    const normalizeSharedEpicBranch =
      canNormalizePrePlanningSharedEpicHandoffRun(
        run,
        currentCandidate?.candidateCommitSha ?? null,
      );
    if (
      isSharedEpicImplementationBranchName(run.run_branch_name) &&
      !normalizeSharedEpicBranch
    ) {
      throw new Error(
        `Run ${run.id} uses legacy shared Epic branch ${run.run_branch_name}; recover it manually because it is no longer a pre-planning handoff-only run`,
      );
    }

    if (
      run.final_disposition === "workspace_setup_failed" ||
      normalizeSharedEpicBranch
    ) {
      const repo = await this.db.getRepositoryById(run.repo_id);
      if (!repo) {
        throw new Error(
          `Repository ${run.repo_id} was not found for run ${run.id}`,
        );
      }

      const implementationBranch = normalizeSharedEpicBranch
        ? buildImplementationBranchName(run.jira_key, run.id)
        : resolveRunBranchName(run);
      const baseCommitSha = normalizeSharedEpicBranch
        ? run.base_commit_sha
        : (run.run_branch_base_sha ?? run.base_commit_sha);

      try {
        await this.retryHandoff({
          runId: run.id,
          jiraKey: run.jira_key,
          step: "setup",
          label: `workspace-setup-recovery:${run.id}`,
          eventState: "failed",
          fn: () =>
            this.prepareInitialRunBranchWorkspace({
              runId: run.id,
              jiraKey: run.jira_key,
              repo,
              targetBranchName: run.branch_name,
              baseCommitSha,
              implementationBranch,
              allowExistingBranchHead: false,
            }),
        });
      } catch (error) {
        const errorMessage = sanitizeErrorMessage(
          error instanceof Error ? error.message : String(error),
        );
        await this.database.runs.updateRunState(run.id, "failed", {
          last_error: `Planning handoff recovery setup failed: ${errorMessage}`,
          final_disposition: "workspace_setup_failed",
        });
        await this.database.events.createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "failed",
          to_state: "failed",
          stage: "qualification",
          metadata_json: {
            reason: "manual_planning_handoff_recovery_failed",
            step: "setup",
            operatorId: input.operatorId,
            operatorDisplay: input.operatorName,
            recoveryReason: input.reason ?? null,
            error: errorMessage,
          },
        });
        throw error;
      }
    }

    const recovered = await this.database.runs.updateRunStateIfCurrentState(
      run.id,
      "failed",
      "queued_for_planning",
      {
        last_error: null,
        final_disposition: null,
      },
    );
    if (!recovered) {
      throw new Error(
        `Run ${run.id} changed state before planning handoff recovery could be queued`,
      );
    }

    const recoveryDedupeToken = `handoff-recovery:${run.id}:${Date.now()}`;
    await this.database.events.createEvent({
      oneshot_run_id: run.id,
      event_type: "state_transition",
      from_state: "failed",
      to_state: "queued_for_planning",
      stage: "qualification",
      metadata_json: {
        reason: "manual_planning_handoff_recovery",
        operatorId: input.operatorId,
        operatorDisplay: input.operatorName,
        recoveryReason: input.reason ?? null,
        previousFinalDisposition: run.final_disposition,
        previousLastError: run.last_error
          ? sanitizeErrorMessage(run.last_error)
          : null,
        dedupeToken: recoveryDedupeToken,
      },
    });

    try {
      await this.retryHandoff({
        runId: run.id,
        jiraKey: run.jira_key,
        step: "publish",
        label: `planning-publish-recovery:${run.id}`,
        fn: () =>
          this.publisher.publishStageMessage(
            run.id,
            "planning",
            1,
            "queued_for_planning",
            false,
            { dedupeToken: recoveryDedupeToken },
          ),
      });
    } catch (error) {
      await this.failRunAfterPublishExhaustion({
        runId: run.id,
        jiraKey: run.jira_key,
        error,
      });
      throw error;
    }

    return {
      oneshotRunId: run.id,
      stage: "planning",
      state: "queued_for_planning",
      version: 1,
    };
  }

  async recoverPlanContractViolation(
    input: RecoverPlanContractViolationInput,
  ): Promise<RecoverPlanContractViolationResult> {
    const run = await this.database.runs.getRunById(input.runId);
    if (!run) {
      throw new Error(`OneShot run ${input.runId} was not found`);
    }
    if (run.state !== "blocked") {
      throw new Error(
        `Only blocked OneShot runs can be recovered from plan-contract violation; current state is ${run.state}`,
      );
    }

    const [latestStateEventRows] = await this.db.getPool().query<
      PlanContractViolationEventRow[]
    >(
      `SELECT id, event_type, from_state, to_state, metadata_json
       FROM oneshot_run_events
       WHERE oneshot_run_id = ?
         AND stage = 'implementation'
         AND event_type IN ('state_transition', 'state_revert')
       ORDER BY id DESC
       LIMIT 1`,
      [run.id],
    );
    const latestStateEvent = latestStateEventRows[0] ?? null;
    const latestStateMetadata = parseMetadataObject(
      latestStateEvent?.metadata_json ?? null,
    );
    if (
      !isPlanContractRecoveryCandidateEvent(
        latestStateEvent,
        latestStateMetadata,
      )
    ) {
      throw new Error(
        `Run ${run.id} is not a blocked plan-contract violation recovery candidate`,
      );
    }

    const [eventRows] = await this.db.getPool().query<
      PlanContractViolationEventRow[]
    >(
      `SELECT id, event_type, from_state, to_state, metadata_json
       FROM oneshot_run_events
       WHERE oneshot_run_id = ?
         AND event_type = 'state_transition'
         AND stage = 'implementation'
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) IN (
           'plan_contract_violation',
           'plan_contract_violation_replan_exhausted'
         )
       ORDER BY id DESC
       LIMIT 1`,
      [run.id],
    );
    const latestViolationEvent = eventRows[0] ?? null;
    const latestViolationMetadata = parseMetadataObject(
      latestViolationEvent?.metadata_json ?? null,
    );
    if (!latestViolationEvent || !latestViolationMetadata) {
      throw new Error(
        `Run ${run.id} is not a blocked plan-contract violation recovery candidate`,
      );
    }
    const editableFiles = metadataStringArray(
      latestViolationMetadata,
      "editableFiles",
    );
    const changedFiles = metadataStringArray(
      latestViolationMetadata,
      "changedFiles",
    );
    const violatingFiles = metadataStringArray(
      latestViolationMetadata,
      "violatingFiles",
    );
    if (violatingFiles.length === 0) {
      throw new Error(
        `Run ${run.id} plan-contract violation event is missing violating file metadata`,
      );
    }

    const nextPlanVersion = (run.current_plan_version ?? 0) + 1;
    const recoveryDedupeToken = `plan-contract-recovery:${run.id}:${Date.now()}`;
    const recovered = await this.database.runs.updateRunStateIfCurrentState(
      run.id,
      "blocked",
      "queued_for_planning",
      {
        current_plan_version: nextPlanVersion,
        current_review_version: null,
        current_implementation_version: null,
        current_implementation_branch: null,
        current_implementation_commit_sha: null,
        current_code_review_version: null,
        current_test_version: null,
        review_loop_count: 0,
        planning_attempt_count: 0,
        implementation_attempt_count: 0,
        code_review_attempt_count: 0,
        verification_loop_count: 0,
        final_disposition: null,
        last_error: null,
      },
    );
    if (!recovered) {
      throw new Error(
        `Run ${run.id} changed state before plan-contract recovery could be queued`,
      );
    }

    let recoveryEventWritten = false;
    try {
      await this.database.events.createEvent({
        oneshot_run_id: run.id,
        event_type: "state_transition",
        from_state: "blocked",
        to_state: "queued_for_planning",
        stage: "implementation",
        metadata_json: {
          reason: "manual_plan_contract_violation_recovery",
          operatorId: input.operatorId,
          operatorDisplay: input.operatorName,
          recoveryReason: input.reason ?? null,
          previousFinalDisposition: run.final_disposition,
          previousLastError: run.last_error
            ? sanitizeErrorMessage(run.last_error)
            : null,
          latestViolationEventId: latestViolationEvent.id,
          latestViolationMetadata,
          version:
            metadataNumber(latestViolationMetadata, "version") ??
            run.current_implementation_version,
          revision: metadataBoolean(latestViolationMetadata, "revision"),
          currentPlanVersion: run.current_plan_version,
          nextPlanVersion,
          editableFiles,
          changedFiles,
          violatingFiles,
          autoReplanAttempt: null,
          autoReplanMaxAttempts: metadataNumber(
            latestViolationMetadata,
            "autoReplanMaxAttempts",
          ),
          dedupeToken: recoveryDedupeToken,
        },
      });
      recoveryEventWritten = true;
      await this.publisher.publishStageMessage(
        run.id,
        "planning",
        nextPlanVersion,
        "queued_for_planning",
        true,
        { dedupeToken: recoveryDedupeToken },
      );
    } catch (error) {
      const recoveryErrorMessage =
        error instanceof Error ? error.message : String(error);
      const reverted = await this.database.runs.updateRunStateIfCurrentState(
        run.id,
        "queued_for_planning",
        "blocked",
        {
          current_plan_version: run.current_plan_version,
          current_review_version: run.current_review_version,
          current_implementation_version: run.current_implementation_version,
          current_implementation_branch: run.current_implementation_branch,
          current_implementation_commit_sha:
            run.current_implementation_commit_sha,
          current_code_review_version: run.current_code_review_version,
          current_test_version: run.current_test_version,
          review_loop_count: run.review_loop_count,
          planning_attempt_count: run.planning_attempt_count,
          implementation_attempt_count: run.implementation_attempt_count,
          code_review_attempt_count: run.code_review_attempt_count,
          verification_loop_count: run.verification_loop_count,
          final_disposition: run.final_disposition,
          last_error: recoveryErrorMessage,
        },
      );
      if (reverted) {
        await this.database.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_revert",
            from_state: "queued_for_planning",
            to_state: "blocked",
            stage: "implementation",
            metadata_json: {
              operatorId: input.operatorId,
              operatorDisplay: input.operatorName,
              reason: recoveryEventWritten
                ? "manual_plan_contract_violation_recovery_publish_failed"
                : "manual_plan_contract_violation_recovery_event_failed",
              nextPlanVersion,
              recoveryError: recoveryErrorMessage,
              dedupeToken: recoveryDedupeToken,
            },
          })
          .catch(() => undefined);
      }
      throw error;
    }

    return {
      oneshotRunId: run.id,
      stage: "planning",
      state: "queued_for_planning",
      version: nextPlanVersion,
    };
  }

  async forceApproveRun(
    run: OneShotRun,
    currentHeadSha: string,
  ): Promise<ForceApproveResult> {
    const connection = await this.db.getPool().getConnection();
    let resultingState: OneShotRun["state"];
    let publishStage: OneShotQueueStage;
    let publishVersion: number;
    let publishCandidateSha: string | null = null;
    let publishCandidateVersion: number | null = null;

    // Branch by escalation source:
    // - review_escalated (plan review): resume to implementation
    // - code_review_escalated: skip re-implementation, resume to testing
    const isCodeReviewEscalation =
      run.final_disposition === "code_review_escalated";

    if (isCodeReviewEscalation) {
      resultingState = "queued_for_testing";
      publishStage = "testing";
      publishVersion = (run.current_test_version ?? 0) + 1;
    } else {
      resultingState = "queued_for_implementation";
      publishStage = "implementation";
      publishVersion = (run.current_implementation_version ?? 0) + 1;
    }

    logger.info(
      {
        runId: run.id,
        jiraKey: run.jira_key,
        escalationSource: isCodeReviewEscalation
          ? "code_review"
          : "plan_review",
        currentHeadSha,
        publishStage,
        publishVersion,
      },
      "Force-approving OneShot run",
    );

    const driftClassification =
      run.base_commit_sha !== currentHeadSha
        ? await this.classifyForceApproveDrift(run, currentHeadSha)
        : null;

    try {
      await connection.beginTransaction();

      const txdb = new OneShotDatabase(connection);
      const freshRun = await txdb.runs.getRunById(run.id);
      if (!freshRun || freshRun.state !== "escalated") {
        throw new Error(`Run ${run.id} is not eligible for force-approve`);
      }

      if (freshRun.base_commit_sha !== currentHeadSha) {
        if (
          driftClassification?.status === "safe_fast_forward" &&
          driftClassification.previousBaseCommitSha ===
            freshRun.base_commit_sha &&
          driftClassification.currentHeadSha === currentHeadSha
        ) {
          await txdb.events.createEvent({
            oneshot_run_id: run.id,
            event_type: "base_refreshed",
            from_state: "escalated",
            to_state: "escalated",
            stage: isCodeReviewEscalation ? "code_review" : "review",
            metadata_json: {
              reason: "safe_fast_forward",
              previousBaseCommitSha: driftClassification.previousBaseCommitSha,
              currentHeadSha: driftClassification.currentHeadSha,
              changedFileCount: driftClassification.changedFiles.length,
              changedFiles: driftClassification.changedFiles.slice(0, 25),
              evidence: driftClassification.evidence,
              escalationSource: isCodeReviewEscalation
                ? "code_review"
                : "review",
            },
          });
        } else {
          const driftEvidence = driftClassification?.evidence ?? [
            "Unable to classify drift safely during force approve.",
          ];
          await txdb.runs.updateRunState(run.id, "replan_required", {
            last_error:
              `Branch head moved from ${freshRun.base_commit_sha} to ${currentHeadSha}. ` +
              `Drift classification: ${driftClassification?.status ?? "unknown"}.`,
            final_disposition: "branch_drift",
            base_commit_sha: freshRun.base_commit_sha,
          });
          await txdb.events.createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "escalated",
            to_state: "replan_required",
            stage: isCodeReviewEscalation ? "code_review" : "review",
            metadata_json: {
              reason: "branch_drift",
              driftStatus: driftClassification?.status ?? "unknown",
              previousBaseCommitSha: freshRun.base_commit_sha,
              currentHeadSha,
              changedFileCount:
                driftClassification?.changedFiles.length ?? null,
              overlappingFiles: driftClassification?.overlappingFiles ?? [],
              riskyFiles: driftClassification?.riskyFiles ?? [],
              evidence: driftEvidence,
              escalationSource: isCodeReviewEscalation
                ? "code_review"
                : "review",
            },
          });

          await txdb.notifications.createNotification({
            oneshot_run_id: run.id,
            jira_key: run.jira_key,
            notification_type: "branch_drift",
            body_markdown: buildBranchDriftComment({
              assetBaseUrl: this.config.commentAssetBaseUrl,
              jiraKey: run.jira_key,
              previousBaseCommitSha: freshRun.base_commit_sha,
              currentHeadSha,
              driftStatus: driftClassification?.status ?? "unknown",
              overlappingFiles: driftClassification?.overlappingFiles ?? [],
              riskyFiles: driftClassification?.riskyFiles ?? [],
              evidence: driftEvidence,
            }),
          });

          await connection.commit();
          return { state: "replan_required" };
        }
      }

      const updateFields: Record<string, unknown> = {
        last_error: null,
        final_disposition: "force_approved",
      };

      if (
        freshRun.base_commit_sha !== currentHeadSha &&
        driftClassification?.status === "safe_fast_forward"
      ) {
        updateFields.base_commit_sha = currentHeadSha;
      }

      if (isCodeReviewEscalation) {
        updateFields.current_test_version = publishVersion;
        publishCandidateSha = freshRun.current_implementation_commit_sha;
        publishCandidateVersion = freshRun.current_implementation_version;
      } else {
        updateFields.current_implementation_version = publishVersion;
      }

      await txdb.runs.updateRunState(run.id, resultingState, updateFields);

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    try {
      await this.publisher.publishStageMessage(
        run.id,
        publishStage,
        publishVersion,
        resultingState,
        false,
        isCodeReviewEscalation
          ? {
              expectedImplementationCommitSha: publishCandidateSha,
              expectedImplementationVersion: publishCandidateVersion,
            }
          : undefined,
      );
      return {
        state: resultingState,
        implementationVersion: isCodeReviewEscalation
          ? undefined
          : publishVersion,
      };
    } catch (error) {
      const publishError =
        error instanceof Error ? error.message : String(error);
      logger.error(
        {
          runId: run.id,
          stage: publishStage,
          escalationSource: isCodeReviewEscalation
            ? "code_review"
            : "plan_review",
          publishError,
        },
        "Failed to publish message after force-approve",
      );

      return {
        state: resultingState,
        implementationVersion: isCodeReviewEscalation
          ? undefined
          : publishVersion,
        publishError,
      };
    }
  }

  private async classifyForceApproveDrift(
    run: OneShotRun,
    currentHeadSha: string,
  ): Promise<BaseDriftClassification | null> {
    try {
      const latestPlanArtifact =
        await this.database.artifacts.getLatestArtifact(run.id, "plan");
      const plannedFiles = extractImpactedFilesFromArtifactMetadata(
        latestPlanArtifact?.metadata_json ?? null,
      );
      if (plannedFiles.length === 0) {
        return null;
      }

      const repo = await this.db.getRepositoryById(run.repo_id);
      if (!repo) {
        return null;
      }

      const workspace = await this.createWorkspaceManager().prepareWorkspace(
        run.id,
        repo,
        currentHeadSha,
        "reviewer",
        run.branch_name,
      );

      try {
        return await classifyBaseDrift(
          workspace.workspacePath,
          run.base_commit_sha,
          currentHeadSha,
          plannedFiles,
        );
      } finally {
        await workspace.cleanup().catch(() => undefined);
      }
    } catch (error) {
      logger.warn(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          error: error instanceof Error ? error.message : String(error),
        },
        "Unable to classify force-approve branch drift; replan will be required",
      );
      return null;
    }
  }

  async queueReplanRun(
    run: OneShotRun,
    currentHeadSha: string,
  ): Promise<ReplanResult> {
    const latestRun = await this.database.runs.getRunById(run.id);
    if (!latestRun) {
      throw new Error(`Run ${run.id} was not found for replan`);
    }
    const nextPlanVersion = (latestRun.current_plan_version ?? 0) + 1;
    const existingEvents = await this.database.events.getEventsForRun(
      latestRun.id,
    );
    const noActionReason = controlReplanNoActionReason(latestRun);
    if (noActionReason) {
      await this.recordControlReplanNoop(latestRun, noActionReason, {
        currentHeadSha,
        nextPlanVersion,
      });
      return {
        state: latestRun.state,
        nextPlanVersion,
        skipped: true,
        noActionReason,
      };
    }
    if (hasUncleanedReplanCommand(existingEvents)) {
      const reason = "replan_label_cleanup_pending";
      await this.recordControlReplanNoop(latestRun, reason, {
        currentHeadSha,
        nextPlanVersion,
      });
      return {
        state: latestRun.state,
        nextPlanVersion,
        skipped: true,
        noActionReason: reason,
      };
    }
    const currentCandidate =
      await this.database.candidateVersions.getCurrentCandidate(latestRun.id);
    const normalizeSharedEpicBranch =
      canNormalizePrePlanningSharedEpicHandoffRun(
        latestRun,
        currentCandidate?.candidateCommitSha ?? null,
      );
    if (
      isSharedEpicImplementationBranchName(latestRun.run_branch_name) &&
      !normalizeSharedEpicBranch
    ) {
      throw new Error(
        `Run ${latestRun.id} uses legacy shared Epic branch ${latestRun.run_branch_name}; same-run replan cannot safely rewrite it after planning or implementation started`,
      );
    }

    const repo = await this.db.getRepositoryById(latestRun.repo_id);
    if (!repo) {
      throw new Error(
        `Repository ${latestRun.repo_id} was not found for run ${latestRun.id}`,
      );
    }
    const branchAlignment = await this.retryHandoff({
      runId: latestRun.id,
      jiraKey: latestRun.jira_key,
      step: "setup",
      label: `control-replan-branch:${latestRun.id}`,
      eventState: latestRun.state,
      fn: () =>
        this.alignRunBranchForReplan({
          run: latestRun,
          repo,
          baseCommitSha: currentHeadSha,
          normalizeSharedEpicBranch,
        }),
    });
    const connection = await this.db.getPool().getConnection();

    logger.info(
      {
        runId: latestRun.id,
        jiraKey: latestRun.jira_key,
        nextPlanVersion,
        currentHeadSha,
        previousBaseCommitSha: latestRun.base_commit_sha,
        previousState: latestRun.state,
      },
      "Queueing OneShot replan request",
    );

    try {
      await connection.beginTransaction();

      const txdb = new OneShotDatabase(connection);
      const freshRun = await txdb.runs.getRunById(latestRun.id);
      if (!freshRun) {
        throw new Error(`Run ${latestRun.id} was not found for replan`);
      }
      const refreshedNoActionReason = controlReplanNoActionReason(freshRun);
      if (refreshedNoActionReason) {
        await txdb.events.createEvent({
          oneshot_run_id: freshRun.id,
          event_type: "control_replan_noop",
          from_state: freshRun.state,
          to_state: freshRun.state,
          stage: "qualification",
          metadata_json: {
            reason: refreshedNoActionReason,
            runId: freshRun.id,
            jiraKey: freshRun.jira_key,
            sourceLabel: "PFOS-REPLAN",
            currentHeadSha,
            nextPlanVersion,
          },
        });
        await connection.commit();
        return {
          state: freshRun.state,
          nextPlanVersion,
          skipped: true,
          noActionReason: refreshedNoActionReason,
        };
      }

      await txdb.candidateVersions.supersedeCurrentCandidatesForReplan(
        freshRun.id,
      );
      const queued = await txdb.runs.updateRunStateIfCurrentState(
        freshRun.id,
        freshRun.state,
        "queued_for_planning",
        {
          base_commit_sha: currentHeadSha,
          run_branch_base_sha: currentHeadSha,
          current_review_version: null,
          current_implementation_version: null,
          current_implementation_commit_sha: null,
          current_code_review_version: null,
          current_test_version: null,
          review_loop_count: 0,
          verification_loop_count: 0,
          planning_attempt_count: 0,
          implementation_attempt_count: 0,
          code_review_attempt_count: 0,
          last_error: null,
          final_disposition: "replan_requested",
        },
      );
      if (!queued) {
        throw new Error(
          `Run ${freshRun.id} changed state before replan could be queued`,
        );
      }
      await txdb.events.createEvent({
        oneshot_run_id: freshRun.id,
        event_type: "control_replan_requested",
        from_state: freshRun.state,
        to_state: "queued_for_planning",
        stage: "qualification",
        metadata_json: {
          reason: "pfos_replan_label",
          runId: freshRun.id,
          jiraKey: freshRun.jira_key,
          previousState: freshRun.state,
          previousBaseCommitSha: freshRun.base_commit_sha,
          newBaseCommitSha: currentHeadSha,
          previousPlanVersion: freshRun.current_plan_version,
          nextPlanVersion,
          sourceLabel: "PFOS-REPLAN",
          previousRunBranchName: branchAlignment.previousBranchName,
          runBranchName: branchAlignment.branchName,
          previousRemoteHeadSha: branchAlignment.previousRemoteHeadSha,
          branchHeadSha: branchAlignment.branchHeadSha,
          normalizedSharedEpicBranch:
            branchAlignment.normalizedSharedEpicBranch,
          supersededCurrentCandidateSha:
            currentCandidate?.candidateCommitSha ?? null,
        },
      });

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    try {
      await this.publisher.publishStageMessage(
        latestRun.id,
        "planning",
        nextPlanVersion,
        "queued_for_planning",
        true,
      );

      return {
        state: "queued_for_planning",
        nextPlanVersion,
      };
    } catch (error) {
      const publishError =
        error instanceof Error ? error.message : String(error);
      logger.error(
        {
          runId: latestRun.id,
          nextPlanVersion,
          publishError,
        },
        "Failed to publish planning message after replan request",
      );

      return {
        state: "queued_for_planning",
        nextPlanVersion,
        publishError,
      };
    }
  }

  async recordControlReplanNoop(
    run: OneShotRun,
    reason: string,
    metadata: Record<string, unknown> = {},
  ): Promise<void> {
    await this.database.events.createEvent({
      oneshot_run_id: run.id,
      event_type: "control_replan_noop",
      from_state: run.state,
      to_state: run.state,
      stage: "qualification",
      metadata_json: {
        reason,
        runId: run.id,
        jiraKey: run.jira_key,
        sourceLabel: "PFOS-REPLAN",
        ...metadata,
      },
    });
  }

  async recordReplanLabelCleanupFailed(input: {
    run: OneShotRun;
    reason: string;
    error: unknown;
  }): Promise<void> {
    await this.database.events.createEvent({
      oneshot_run_id: input.run.id,
      event_type: "replan_label_cleanup_failed",
      from_state: input.run.state,
      to_state: input.run.state,
      stage: "qualification",
      metadata_json: {
        reason: input.reason,
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        sourceLabel: "PFOS-REPLAN",
        error: sanitizeErrorMessage(
          input.error instanceof Error
            ? input.error.message
            : String(input.error),
        ),
      },
    });
  }

  async recordReplanLabelCleanupObserved(
    run: OneShotRun,
    reason: string,
  ): Promise<boolean> {
    const existingEvents = await this.database.events.getEventsForRun(run.id);
    if (!hasUncleanedReplanCommand(existingEvents)) {
      return false;
    }
    await this.database.events.createEvent({
      oneshot_run_id: run.id,
      event_type: "replan_label_cleanup_observed",
      from_state: run.state,
      to_state: run.state,
      stage: "qualification",
      metadata_json: {
        reason,
        runId: run.id,
        jiraKey: run.jira_key,
        sourceLabel: "PFOS-REPLAN",
      },
    });
    return true;
  }

  async terminateRun(input: TerminateRunInput): Promise<TerminateRunResult> {
    const workspaceManager = this.createWorkspaceManager();
    const failureStage = mapFailureStage(input.run);
    const errorMessage = buildTerminationLastError(input);
    const notificationBody = buildTerminationNotificationBody(
      input,
      errorMessage,
    );

    const connection = await this.db.getPool().getConnection();
    let transitioned = false;

    try {
      await connection.beginTransaction();

      const txdb = new OneShotDatabase(connection);
      const freshRun = await txdb.runs.getRunById(input.run.id);
      if (!freshRun) {
        throw new Error(`OneShot run ${input.run.id} no longer exists`);
      }

      transitioned = await txdb.runs.updateRunStateIfCurrentState(
        input.run.id,
        input.run.state,
        "failed",
        {
          final_disposition: "run_failed",
          last_error: errorMessage,
        },
      );

      if (transitioned) {
        await txdb.events.createEvent({
          oneshot_run_id: input.run.id,
          event_type: "state_transition",
          from_state: input.run.state,
          to_state: "failed",
          stage: failureStage,
          metadata_json: {
            reason: input.reason,
            staleTimeoutMinutes:
              input.reason === "stale_timeout"
                ? (input.staleTimeoutMinutes ?? ACTIVE_RUN_STALE_SCAN_MINUTES)
                : undefined,
            operatorId: input.operator?.id,
            operatorDisplay: input.operator?.display,
            operatorReason: input.operatorReason?.trim() || undefined,
          },
        });

        await txdb.notifications.createNotification({
          oneshot_run_id: input.run.id,
          jira_key: input.run.jira_key,
          notification_type: "run_failed",
          body_markdown: notificationBody,
        });
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          expectedState: input.run.state,
          terminationReason: input.reason,
        },
        "Skipped OneShot termination because run state already moved",
      );
      return {
        terminated: false,
        workspaceCleanupSucceeded: true,
      };
    }

    try {
      await this.generateTerminationPostmortem(input.run, failureStage);
    } catch (error) {
      logger.error(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          terminationReason: input.reason,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to generate OneShot termination postmortem artifact",
      );
    }

    let workspaceCleanupSucceeded = true;
    try {
      const cleanupStatus = await workspaceManager.cleanupRunWorkspace(
        input.run.id,
      );
      if (cleanupStatus === "cleaned") {
        logger.info(
          {
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            terminationReason: input.reason,
          },
          "Cleaned OneShot workspace after terminating run",
        );
      }
    } catch (error) {
      workspaceCleanupSucceeded = false;
      logger.error(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          terminationReason: input.reason,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to cleanup OneShot workspace after terminating run",
      );
    }

    logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        previousState: input.run.state,
        terminationReason: input.reason,
        workspaceCleanupSucceeded,
      },
      "Terminated OneShot run",
    );

    return {
      terminated: true,
      workspaceCleanupSucceeded,
    };
  }

  async backfillTerminationPostmortems(
    limit = 10,
  ): Promise<{ generated: number; failed: number }> {
    const candidateLimit = Math.max(limit * 3, limit);
    const [rows] = await this.db
      .getPool()
      .query<Array<mysql.RowDataPacket & { id: number; jira_key: string }>>(
        `SELECT id, jira_key FROM oneshot_runs
       WHERE state = 'failed'
         AND updated_at >= DATE_SUB(NOW(), INTERVAL ? HOUR)
       ORDER BY updated_at DESC
       LIMIT ?`,
        [TERMINATION_POSTMORTEM_BACKFILL_HOURS, candidateLimit],
      );

    let generated = 0;
    let failed = 0;
    const database = this.database;

    for (const run of rows) {
      if (generated + failed >= limit) {
        break;
      }

      try {
        const events = await database.events.getEventsForRun(run.id);
        if (hasStoredPostmortemEvent(events)) {
          continue;
        }

        const failureEvent = findTerminationFailureEvent(events);
        if (!failureEvent) {
          continue;
        }

        await this.generateTerminationPostmortem(
          { id: run.id, jira_key: run.jira_key },
          failureEvent.stage,
        );
        generated += 1;
      } catch (error) {
        failed += 1;
        logger.error(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to backfill OneShot termination postmortem artifact",
        );
      }
    }

    if (generated > 0 || failed > 0) {
      logger.info(
        { generated, failed },
        "OneShot termination postmortem backfill completed",
      );
    }

    return { generated, failed };
  }

  private staleMinutesForState(state: OneShotState): number {
    switch (state) {
      case "implementing":
        return this.config.staleMinutesImplementation;
      case "planning":
        return this.config.staleMinutesPlanning;
      case "testing":
        return this.config.staleMinutesTesting;
      default:
        return ACTIVE_RUN_STALE_SCAN_MINUTES;
    }
  }

  async reconcileStuckRuns(limit = 10): Promise<OneShotReconcileResult> {
    // Use ACTIVE_RUN_STALE_SCAN_MINUTES (the minimum/default) as the SQL fetch
    // threshold so we never hold reviewing/code_reviewing runs longer than
    // their intended 20-minute window. Per-stage overrides (e.g.
    // ONESHOT_STALE_MINUTES_IMPLEMENTATION=90) are applied in-memory by
    // staleMinutesForState() below — runs fetched too early for their
    // per-stage threshold are simply skipped in this pass and picked up on
    // the next reconcile cycle.
    const staleRuns = await this.database.runs.getStuckRuns(
      this.config.reconcileStaleMinutes,
      ACTIVE_RUN_STALE_SCAN_MINUTES,
    );
    if (staleRuns.length === 0) {
      return { republished: 0, terminated: 0, failed: 0 };
    }

    let republished = 0;
    let terminated = 0;
    let failed = 0;

    for (const run of staleRuns.slice(0, limit)) {
      if (isStaleExecutingState(run.state)) {
        const staleMinutes = this.staleMinutesForState(run.state);
        // Skip runs that haven't yet exceeded their per-stage threshold.
        // getStuckRuns fetches with ACTIVE_RUN_STALE_SCAN_MINUTES (the minimum) so
        // runs whose per-stage override is longer will appear here before they
        // are actually stale — filter them out in-memory.
        const ageMinutes = run.updated_at
          ? (Date.now() - new Date(run.updated_at).getTime()) / 60_000
          : Infinity;
        if (ageMinutes < staleMinutes) {
          continue;
        }
        try {
          const termination = await this.terminateRun({
            run,
            reason: "stale_timeout",
            staleTimeoutMinutes: staleMinutes,
          });

          if (termination.terminated) {
            terminated += 1;
          }
        } catch (error) {
          failed += 1;
          logger.error(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              state: run.state,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to terminate stale active OneShot run",
          );
        }
        continue;
      }

      const requeue = getRequeueDetails(run);
      if (!requeue) {
        failed += 1;
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            state: run.state,
            currentPlanVersion: run.current_plan_version,
            currentImplementationVersion: run.current_implementation_version,
          },
          "Skipping stale OneShot run because the queued version is not derivable",
        );
        continue;
      }

      try {
        const queuedState = `queued_for_${requeue.stage}` as OneShotState;
        await this.publisher.publishStageMessage(
          run.id,
          requeue.stage,
          requeue.version,
          queuedState,
          requeue.revision,
          requeue.stage === "code_review" || requeue.stage === "testing"
            ? {
                expectedImplementationCommitSha:
                  run.current_implementation_commit_sha,
                expectedImplementationVersion:
                  run.current_implementation_version,
              }
            : undefined,
        );
        await this.database.runs.touchRun(run.id);
        republished += 1;

        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            state: run.state,
            stage: requeue.stage,
            version: requeue.version,
            revision: requeue.revision,
          },
          "Republished stale OneShot queue message",
        );
      } catch (error) {
        failed += 1;
        logger.error(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            state: run.state,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to republish stale OneShot queue message",
        );
      }
    }

    return { republished, terminated, failed };
  }

  async reconcilePrOpenCiReadiness(
    limit = 10,
  ): Promise<OneShotCiReconcileResult> {
    const runs =
      await this.database.runs.getPrOpenRunsForCiReconciliation(limit);
    let checked = 0;
    let refreshed = 0;
    let blocked = 0;
    let failed = 0;

    for (const run of runs) {
      checked += 1;
      try {
        const candidateSha = run.current_implementation_commit_sha;
        if (!candidateSha || !run.current_implementation_branch) {
          continue;
        }
        const repo = await this.db.getRepositoryById(run.repo_id);
        if (!repo) {
          failed += 1;
          continue;
        }

        const { owner, repo: repoName } = parseGitHubRepoUrl(repo.repo_url);
        const pr = await findOpenPullRequest({
          owner,
          repo: repoName,
          head: run.current_implementation_branch,
          base: run.branch_name,
        });
        const additionalReasons: OneShotReadinessReason[] = [];
        if (pr?.headSha && pr.headSha !== candidateSha) {
          additionalReasons.push({
            code: "pr_head_drift_detected",
            category: "ci",
            severity: "high",
            source: "github_pr_head",
            message: `GitHub PR head ${pr.headSha} does not match reviewed/tested candidate ${candidateSha}.`,
          });
        }

        let ciStatus: CiStatusSummary;
        if (pr?.headSha && pr.headSha !== candidateSha) {
          ciStatus = {
            state: "failure",
            description: `GitHub PR head ${pr.headSha} differs from candidate ${candidateSha}.`,
            statusCount: 0,
            checkRunCount: 0,
            requiredCheckState: "unavailable",
            details: ["pr_head_drift_detected"],
          };
        } else {
          ciStatus = await fetchCommitStatusSummary({
            owner,
            repo: repoName,
            ref: candidateSha,
            base: run.branch_name,
            pullNumber: pr?.number,
          });
        }

        const [
          planArtifact,
          codeReviewArtifact,
          testArtifact,
          implementationArtifact,
        ] = await Promise.all([
          run.current_plan_version
            ? this.database.artifacts.getArtifact(
                run.id,
                "plan",
                run.current_plan_version,
              )
            : null,
          run.current_code_review_version
            ? this.database.artifacts.getArtifact(
                run.id,
                "code_review",
                run.current_code_review_version,
              )
            : null,
          run.current_test_version
            ? this.database.artifacts.getArtifact(
                run.id,
                "test_result",
                run.current_test_version,
              )
            : null,
          run.current_implementation_version
            ? this.database.artifacts.getArtifact(
                run.id,
                "implementation",
                run.current_implementation_version,
              )
            : null,
        ]);

        const implementationArtifactSha =
          typeof implementationArtifact?.metadata_json
            ?.implementationCommitSha === "string"
            ? implementationArtifact.metadata_json.implementationCommitSha
            : null;
        if (!implementationArtifactSha && candidateSha) {
          await this.database.events.createEvent({
            oneshot_run_id: run.id,
            event_type: "candidate_sha_legacy_unpinned",
            from_state: "pr_open",
            to_state: "pr_open",
            stage: "testing",
            metadata_json: {
              reason: "candidate_metadata_legacy_inferred",
              candidateSha,
              implementationVersion: run.current_implementation_version,
            },
          });
        }

        const testResult = testArtifact
          ? await this.readArtifactJson(
              testArtifact.s3_bucket,
              testArtifact.s3_key,
              parseOneShotTestResult,
            )
          : null;
        if (!testResult) {
          continue;
        }

        const planMetadata = planArtifact?.metadata_json ?? {};
        const readiness = buildOneShotReadinessClassification({
          testResult,
          codeReviewMetadata: codeReviewArtifact?.metadata_json ?? null,
          planRiskAssessment: isPlanRiskAssessment(
            planMetadata.planRiskAssessment,
          )
            ? planMetadata.planRiskAssessment
            : null,
          qualificationRiskAssessment: isQualificationRiskAssessment(
            planMetadata.qualificationRiskAssessment,
          )
            ? planMetadata.qualificationRiskAssessment
            : null,
          externalSpecEvidence: isExternalSpecEvidence(
            planMetadata.externalSpecEvidence,
          )
            ? planMetadata.externalSpecEvidence
            : null,
          ciStatus,
          additionalReasons,
        });

        await this.database.runs.updateRunState(run.id, "pr_open", {
          last_error:
            readiness.reasons.length > 0
              ? readiness.reasons.map((reason) => reason.message).join(" | ")
              : null,
          final_disposition: readiness.completionStatus,
        });
        await this.database.events.createEvent({
          oneshot_run_id: run.id,
          event_type: "readiness_classified",
          from_state: "pr_open",
          to_state: "pr_open",
          stage: "testing",
          metadata_json: {
            readiness,
            ciStatus,
            candidateSha,
            prNumber: pr?.number ?? null,
            prHeadSha: pr?.headSha ?? null,
          },
        });
        refreshed += 1;
        if (readiness.readiness !== "ready") {
          blocked += 1;
        }
      } catch (error) {
        failed += 1;
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to reconcile PR-open OneShot CI readiness",
        );
      }
    }

    return { checked, refreshed, blocked, failed };
  }

  private async readArtifactJson<T>(
    bucket: string,
    key: string,
    validator: (value: unknown) => T,
  ): Promise<T> {
    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: bucket,
        Key: key,
      }),
    );
    if (!response.Body) {
      throw new Error(`Empty artifact body for ${bucket}/${key}`);
    }
    return validator(JSON.parse(await response.Body.transformToString()));
  }

  async cleanupTerminalWorkspaces(
    olderThanHours = 24,
    limit = 20,
  ): Promise<{ cleaned: number; failed: number }> {
    const [rows] = await this.db
      .getPool()
      .query<Array<mysql.RowDataPacket & { id: number; jira_key: string }>>(
        `SELECT r.id, r.jira_key
       FROM oneshot_runs r
       WHERE r.state IN ('completed', 'failed', 'blocked', 'pr_open')
         AND NOT EXISTS (
           SELECT 1
             FROM oneshot_run_events completed
            WHERE completed.oneshot_run_id = r.id
              AND completed.event_type = 'workspace_cleanup_completed'
              AND JSON_UNQUOTE(JSON_EXTRACT(completed.metadata_json, '$.status')) IN ('cleaned', 'not_found')
         )
         AND (
           r.updated_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
           OR EXISTS (
             SELECT 1
               FROM oneshot_run_events requested
              WHERE requested.oneshot_run_id = r.id
                AND requested.event_type = 'workspace_cleanup_requested'
           )
         )
       ORDER BY r.updated_at ASC
       LIMIT ?`,
        [olderThanHours, limit],
      );

    let cleaned = 0;
    let failed = 0;

    const workspaceManager = this.createWorkspaceManager();

    for (const run of rows) {
      let cleanupStatus: CleanupRunWorkspaceStatus | "failed";
      try {
        cleanupStatus = await workspaceManager.cleanupRunWorkspace(run.id);
        await this.database.events.createEvent({
          oneshot_run_id: run.id,
          event_type: "workspace_cleanup_completed",
          stage: null,
          metadata_json: {
            status: cleanupStatus,
            trigger: "terminal_cleanup",
            olderThanHours,
          },
        });
        if (cleanupStatus === "cleaned") {
          cleaned += 1;
        }
      } catch (error) {
        failed += 1;
        cleanupStatus = "failed";
        try {
          await this.database.events.createEvent({
            oneshot_run_id: run.id,
            event_type: "workspace_cleanup_completed",
            stage: null,
            metadata_json: {
              status: cleanupStatus,
              trigger: "terminal_cleanup",
              olderThanHours,
              error: error instanceof Error ? error.message : String(error),
            },
          });
        } catch (eventError) {
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              error:
                eventError instanceof Error
                  ? eventError.message
                  : String(eventError),
            },
            "Failed to record OneShot workspace cleanup failure event",
          );
        }
        logger.error(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to cleanup workspace for terminal OneShot run",
        );
      }
    }

    if (cleaned > 0 || failed > 0) {
      logger.info(
        { cleaned, failed, olderThanHours },
        "OneShot workspace cleanup completed",
      );
    }

    return { cleaned, failed };
  }

  private async generateTerminationPostmortem(
    run: Pick<OneShotRun, "id" | "jira_key">,
    failedStage?: string | null,
  ): Promise<void> {
    await generatePostmortemArtifact(
      this.db,
      run.id,
      buildPostmortemContext({
        s3Client: this.s3Client,
        artifactBucket: this.config.artifactBucket,
        artifactPrefix: this.config.artifactPrefix,
        jiraKey: run.jira_key,
        failedStage: failedStage ?? undefined,
      }),
    );
  }
}
