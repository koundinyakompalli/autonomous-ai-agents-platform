import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, type Message } from "@aws-sdk/client-sqs";
import * as fs from "fs/promises";
import * as path from "path";
import { ZodError } from "zod";
import { getDatabase, type Database } from "../../orchestrator/database.js";
import { getStorage, type Storage } from "../../orchestrator/storage.js";
import { createS3Client } from "../../utils/awsClients.js";
import { createLogger } from "../../utils/logger.js";
import { QueueConsumerBase } from "../consumer-base.js";
import {
  getOneShotConsumerConfig,
  type OneShotConsumerConfig,
  buildOneShotArtifactKey,
} from "../config.js";
import { parseOneShotQueueMessage } from "../contracts.js";
import { OneShotDatabase } from "../database/index.js";
import { OneShotPublisher } from "../publisher.js";
import { isDeterministicFailure } from "../retry-classifier.js";
import {
  getVisibilityTimeoutFromEnv,
  TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT,
} from "../consumer-visibility.js";
import {
  getPlanImpactedFiles,
  parseOneShotPlan,
  sanitizePlannerDiscoveries,
  type OneShotRetrofitEvidence,
  type OneShotPlan,
} from "../schema/plan.js";
import {
  buildRetrofitBranchMismatchMessage,
  parsePlannerRetrofitContext,
  PlannerRetrofitAlreadyAppliedError,
  type PlannerRetrofitContext,
} from "../retrofit-context.js";
import type {
  QualificationAssessment,
  MultiRepoBrief,
} from "../schema/qualification.js";
import { MultiRepoBriefSchema } from "../schema/qualification.js";
import { PromptComposer } from "../prompt-composer.js";
import { createPromptLoader } from "../prompt-loader.js";
import { renderOneShotPlanMarkdown } from "../renderers.js";
import {
  createLeasedOneShotWorkspaceManager,
  OneShotWorkspaceManager,
} from "../workspaces.js";
import { ensureRunBranchContract } from "../run-branch-contract.js";
import {
  materializeRunArtifacts,
  type WorkspaceArtifactFile,
} from "../workspace-artifacts.js";
import {
  TICKET_EVIDENCE_SCHEMA_VERSION,
  renderTicketEvidencePromptSection,
  renderTicketEvidenceSidecars,
  type TicketEvidenceRef,
  type TicketEvidenceStats,
  type TicketEvidenceV1,
} from "../ticket-evidence.js";
import {
  ClaudePlannerProvider,
  PlannerStallError,
  type PlannerErrorWithAttemptDetails,
  type PlannerRevisionContext,
  type PlannerAttemptOverrides,
  type PlannerAttemptMetrics,
} from "../providers/claude-planner.js";
import {
  PLANNER_SCOUT_IDLE_TIMEOUT_MS,
  PLANNER_SCOUT_TIMEOUT_MS,
  PlannerScoutProvider,
  type PlannerScoutRunResult,
} from "../providers/planner-scouts.js";
import {
  ScoutWorkplanProvider,
  type PlannerPriorDiagnosticInput,
} from "../providers/scout-workplan.js";
import type { ScoutWorkplanResult } from "../providers/scout-workplan.js";
import { scanRepo, formatScanForPrompt } from "../repo-scanner.js";
import { buildRepoRouteCardContext } from "../repo-route-cards.js";
import {
  buildPlannerGroundingContext,
  buildPlannerEvidenceContext,
  formatPlannerEvidenceForPrompt,
  formatPlannerGroundingForPrompt,
  isPlannerEvidenceStrong,
  isPlannerGroundingStrong,
  PlannerGroundingValidationError,
  type PlannerEvidenceContext,
  type PlannerGroundingContext,
} from "../planner-grounding.js";
import { mergeModelUsage } from "../model-usage.js";
import {
  buildModelCostUsage,
  mergeModelCostUsage,
} from "../model-cost-usage.js";
import {
  buildPostmortemContext,
  transitionRunWithNotification,
} from "../state-transitions.js";
import { recordLlmMetrics } from "../telemetry/metrics.js";
import {
  buildBudgetExceededComment,
  buildPlanningCompletedComment,
  buildRunFailedComment,
} from "../jira-comments.js";
import {
  checkOneShotTokenBudget,
  formatTokenBudgetFailure,
  tokenBudgetEventMetadata,
} from "../token-budget.js";
import {
  claimGuardForQueueStage,
  handleClaimMissAfterVersionGuard,
  handleStaleStageVersionMessage,
} from "../stage-version-guard.js";
import {
  assessOneShotPlanRisk,
  assessOneShotQualificationRisk,
  detectExternalSpecEvidence,
  getActiveReadinessRiskCategories,
} from "../readiness.js";
import { resolveExternalSpecEvidence } from "../external-spec-evidence.js";
import { eventEmitFailureLogger } from "../event-emit.js";
import type { OneShotRun } from "../types.js";
import type { OneShotRunEvent } from "../database/events.js";
import {
  isWorkspaceCheckoutTimeoutError,
  isWorkspaceLeaseLossError,
  recoverStageAfterWorkspaceLeaseLoss,
} from "../workspace-lease-errors.js";
import {
  resolveOneShotProcessingMode,
  type OneShotProcessingMode,
} from "../processing-mode.js";
import {
  parseRetrofitSourceEvidence,
  type RetrofitSourceEvidence,
} from "../retrofit-source-evidence.js";
import {
  fetchPullRequestCommandEvidence,
  parseGitHubPullRequestUrl,
} from "../github.js";
import {
  formatGitHubCommandContextForPlanner,
} from "../github-command-context.js";

const logger = createLogger("oneshot-planner-consumer");

const PROJECTED_STAGE_TOKENS = 200_000; // planner
const DEFAULT_PLANNER_POST_TOOL_IDLE_TIMEOUT_MS = 30_000;

interface PlannerConsumerDeps {
  config?: OneShotConsumerConfig;
  db?: Database;
  storage?: Storage;
  sqsClient?: SQSClient;
  s3Client?: S3Client;
  publisher?: OneShotPublisher;
  workspaceManager?: OneShotWorkspaceManager;
  promptComposer?: PromptComposer;
  plannerProvider?: ClaudePlannerProvider;
  scoutProvider?: PlannerScoutProvider;
  scoutWorkplanProvider?: ScoutWorkplanProvider;
}

interface QualificationArtifact extends QualificationAssessment {
  jiraKey: string;
  ticketSummary?: string;
  ticketEvidenceRef?: TicketEvidenceRef | null;
  ticketEvidenceStats?: TicketEvidenceStats | null;
  processingMode?: OneShotProcessingMode;
  repoId: number;
  repoName: string;
  repoUrl: string;
  branchName: string;
  baseCommitSha: string;
  repoSelectionMetadata?: Record<string, unknown> | null;
}

function extractRetrofitContext(
  qualificationArtifact: QualificationArtifact,
): PlannerRetrofitContext | null {
  const metadata = qualificationArtifact.repoSelectionMetadata;
  const retrofit =
    metadata && typeof metadata === "object"
      ? (metadata.retrofitContext as Record<string, unknown> | null | undefined)
      : null;
  return parsePlannerRetrofitContext(retrofit);
}

function extractMultiRepoBrief(
  qualificationArtifact: QualificationArtifact,
): MultiRepoBrief | null {
  const metadata = qualificationArtifact.repoSelectionMetadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  const briefRaw = (metadata as Record<string, unknown>).multiRepoBrief;
  if (!briefRaw) {
    return null;
  }
  const parsed = MultiRepoBriefSchema.safeParse(briefRaw);
  return parsed.success ? parsed.data : null;
}

function extractRetrofitSourceEvidence(
  qualificationArtifact: QualificationArtifact,
): RetrofitSourceEvidence | null {
  const metadata = qualificationArtifact.repoSelectionMetadata;
  if (!metadata || typeof metadata !== "object") {
    return null;
  }
  return parseRetrofitSourceEvidence(
    (metadata as Record<string, unknown>).retrofitSourceEvidence,
  );
}

function buildMultiRepoScopeSection(brief: MultiRepoBrief): string {
  const acList = brief.acceptanceCriteria.map((ac) => `  - ${ac}`).join("\n");
  return [
    "## Multi-Repo Scope (child run)",
    "",
    `This is a multi-repo child run. Plan ONLY for this repo: **${brief.repoRef}**.`,
    "",
    `**Objective:** ${brief.objective}`,
    "",
    "**Acceptance Criteria (this repo only):**",
    acList,
    "",
    `**Merge order:** ${brief.mergeOrder} (merge this repo's PR at position ${brief.mergeOrder} in the group).`,
    "",
    "Do NOT plan changes for other repositories in the group. Scope every spec, target file, and acceptance criterion strictly to this repo.",
  ].join("\n");
}

function combineAdditionalScopeSections(
  sections: Array<string | null | undefined>,
): string | undefined {
  const combined = sections
    .filter((section): section is string => Boolean(section?.trim()))
    .join("\n\n---\n\n");
  return combined || undefined;
}

type PlannerContractViolationContext = NonNullable<
  PlannerRevisionContext["contractViolationContext"]
>;
type PlannerRetrofitPatchConflictContext = NonNullable<
  PlannerRevisionContext["retrofitPatchConflictContext"]
>;

function metadataStringList(
  metadata: Record<string, unknown>,
  key: string,
  maxItems = 50,
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

function metadataRecordList(
  metadata: Record<string, unknown>,
  key: string,
  maxItems = 20,
): Array<Record<string, unknown>> {
  const value = metadata[key];
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && !Array.isArray(item),
    )
    .slice(0, maxItems);
}

function metadataStringOrNull(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataNumberOrNull(
  metadata: Record<string, unknown>,
  key: string,
): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function metadataBooleanOrNull(
  metadata: Record<string, unknown>,
  key: string,
): boolean | null {
  const value = metadata[key];
  return typeof value === "boolean" ? value : null;
}

function latestPlanContractViolationContext(
  events: readonly OneShotRunEvent[],
): PlannerContractViolationContext | undefined {
  const event = [...events].reverse().find(
    (candidate) =>
      candidate.event_type === "state_transition" &&
      candidate.stage === "implementation" &&
      (candidate.metadata_json?.reason ===
        "plan_contract_violation_auto_replan" ||
        candidate.metadata_json?.reason ===
          "manual_plan_contract_violation_recovery"),
  );
  const metadata = event?.metadata_json;
  if (!metadata) {
    return undefined;
  }
  const violatingFiles = metadataStringList(metadata, "violatingFiles");
  if (violatingFiles.length === 0) {
    return undefined;
  }
  return {
    implementationVersion: metadataNumberOrNull(metadata, "version"),
    revision: metadataBooleanOrNull(metadata, "revision"),
    currentPlanVersion: metadataNumberOrNull(metadata, "currentPlanVersion"),
    nextPlanVersion: metadataNumberOrNull(metadata, "nextPlanVersion"),
    editableFiles: metadataStringList(metadata, "editableFiles"),
    changedFiles: metadataStringList(metadata, "changedFiles"),
    violatingFiles,
    autoReplanAttempt: metadataNumberOrNull(metadata, "autoReplanAttempt"),
    autoReplanMaxAttempts: metadataNumberOrNull(
      metadata,
      "autoReplanMaxAttempts",
    ),
  };
}

function latestRetrofitPatchConflictContext(
  events: readonly OneShotRunEvent[],
): PlannerRetrofitPatchConflictContext | undefined {
  const event = [...events].reverse().find(
    (candidate) =>
      candidate.event_type === "state_transition" &&
      candidate.stage === "implementation" &&
      candidate.metadata_json?.reason ===
        "retrofit_patch_incomplete_auto_replan",
  );
  const metadata = event?.metadata_json;
  if (!metadata) {
    return undefined;
  }
  const selectedShas = metadataStringList(metadata, "selectedShas", 20);
  const violations = metadataStringList(metadata, "violations", 20);
  if (selectedShas.length === 0 && violations.length === 0) {
    return undefined;
  }
  return {
    implementationVersion: metadataNumberOrNull(metadata, "version"),
    revision: metadataBooleanOrNull(metadata, "revision"),
    currentPlanVersion: metadataNumberOrNull(metadata, "currentPlanVersion"),
    nextPlanVersion: metadataNumberOrNull(metadata, "nextPlanVersion"),
    sourceJiraKey: metadataStringOrNull(metadata, "sourceJiraKey"),
    sourceBranch: metadataStringOrNull(metadata, "sourceBranch"),
    targetBranch: metadataStringOrNull(metadata, "targetBranch"),
    selectedShas,
    allowedFiles: metadataStringList(metadata, "allowedFiles", 100),
    changedFiles: metadataStringList(metadata, "changedFiles", 100),
    violations,
    recoverySubtype: metadataStringOrNull(metadata, "recoverySubtype"),
    perCommitStatus: metadataRecordList(metadata, "perCommitStatus").map(
      (entry) => ({
        sha: typeof entry.sha === "string" ? entry.sha : "unknown",
        subject: typeof entry.subject === "string" ? entry.subject : null,
        status: typeof entry.status === "string" ? entry.status : "unknown",
        sourceFiles: Array.isArray(entry.sourceFiles)
          ? entry.sourceFiles.filter((item): item is string => typeof item === "string")
          : [],
        targetFiles: Array.isArray(entry.targetFiles)
          ? entry.targetFiles.filter((item): item is string => typeof item === "string")
          : [],
        adaptationFiles: Array.isArray(entry.adaptationFiles)
          ? entry.adaptationFiles.filter((item): item is string => typeof item === "string")
          : [],
        conflictDiagnostics:
          typeof entry.conflictDiagnostics === "string"
            ? entry.conflictDiagnostics
            : null,
        proofSnippets: Array.isArray(entry.proofSnippets)
          ? entry.proofSnippets.filter((item): item is string => typeof item === "string")
          : [],
        validationEvidence: Array.isArray(entry.validationEvidence)
          ? entry.validationEvidence.filter((item): item is string => typeof item === "string")
          : [],
        rationale: typeof entry.rationale === "string" ? entry.rationale : null,
      }),
    ),
    autoReplanAttempt: metadataNumberOrNull(metadata, "autoReplanAttempt"),
    autoReplanMaxAttempts: metadataNumberOrNull(
      metadata,
      "autoReplanMaxAttempts",
    ),
  };
}

function formatPlanContractViolationScopeSection(
  context?: PlannerContractViolationContext,
): string | undefined {
  if (!context) {
    return undefined;
  }
  return [
    "## Plan Contract Violation Replan",
    "",
    "The previous implementation changed files outside the approved fileChangeContract. Replan the same run in place; do not treat this as a fresh ticket.",
    "",
    `- Implementation version that violated the contract: ${context.implementationVersion ?? "unknown"}`,
    `- Previous plan version: ${context.currentPlanVersion ?? "unknown"}`,
    `- Queued plan version: ${context.nextPlanVersion ?? "unknown"}`,
    `- Violating files: ${context.violatingFiles.join(", ")}`,
    `- Previously editable files: ${context.editableFiles.join(", ") || "none"}`,
    `- Rejected attempt changed files: ${context.changedFiles.join(", ") || "none"}`,
    `- Auto-replan attempt: ${context.autoReplanAttempt ?? "unknown"}/${context.autoReplanMaxAttempts ?? "unknown"}`,
    "",
    "For every violating file, choose one explicit outcome:",
    "- Add it to fileChangeContract with concrete supporting evidence, rationale, allowed changes, and matching plannedCodeChanges when it is truly required.",
    "- Or reject it explicitly in assumptions/outOfScope/implementation notes and constrain implementer guardrails to avoid the file.",
  ].join("\n");
}

function formatRetrofitPatchConflictScopeSection(
  context?: PlannerRetrofitPatchConflictContext,
): string | undefined {
  if (!context) {
    return undefined;
  }
  return [
    "## Retrofit Patch Proof Replan",
    "",
    "The previous implementation could not prove that every selected source retrofit commit was applied, adapted, already present, or explicitly excluded. Replan the same run in place; do not create a new run and do not treat this as a fresh implementation.",
    "",
    `- Implementation version with incomplete proof: ${context.implementationVersion ?? "unknown"}`,
    `- Previous plan version: ${context.currentPlanVersion ?? "unknown"}`,
    `- Queued plan version: ${context.nextPlanVersion ?? "unknown"}`,
    `- Source Jira: ${context.sourceJiraKey ?? "unknown"}`,
    `- Source branch: ${context.sourceBranch ?? "unknown"}`,
    `- Target branch: ${context.targetBranch ?? "unknown"}`,
    `- Selected source SHAs: ${context.selectedShas.join(", ") || "none"}`,
    `- Rejected attempt changed files: ${context.changedFiles.join(", ") || "none"}`,
    `- Prior allowed files: ${context.allowedFiles.join(", ") || "none"}`,
    `- Violations: ${context.violations.join(" | ") || "none"}`,
    `- Recovery subtype: ${context.recoverySubtype ?? "retrofit_patch_proof"}`,
    `- Auto-replan attempt: ${context.autoReplanAttempt ?? "unknown"}/${context.autoReplanMaxAttempts ?? "unknown"}`,
    "",
    "For every conflicted or unaccounted source commit, choose one explicit outcome:",
    "- Add mapped target/adaptation files to fileChangeContract with concrete supporting evidence, rationale, and allowed changes when the source commit must be adapted on this branch.",
    "- Or explicitly exclude/reject the source commit with a durable rationale when it should not apply to the target branch.",
    "",
    "Per-commit status from rejected attempt:",
    ...context.perCommitStatus.map(
      (entry) =>
        `- ${entry.sha}: ${entry.status}; source=${entry.sourceFiles.join(", ") || "none"}; target=${entry.targetFiles.join(", ") || "none"}; adaptation=${entry.adaptationFiles.join(", ") || "none"}; conflict=${entry.conflictDiagnostics ?? "none"}`,
    ),
  ].join("\n");
}

function planTextSegmentsForContractViolationDecision(
  plan: OneShotPlan,
): string[] {
  return [
    plan.summary,
    ...plan.assumptions,
    ...plan.openQuestions,
    ...plan.outOfScope,
    ...plan.risks,
    ...plan.specs.flatMap((spec) => [
      spec.objective,
      ...spec.implementationNotes,
      ...spec.validationSteps,
      ...(spec.targetFileRationales ?? []).flatMap((rationale) => [
        [
          rationale.targetFile,
          rationale.rationale,
          rationale.uncertainty ?? "",
          ...rationale.rejectedAlternatives,
        ].join("\n"),
      ]),
    ]),
    ...(plan.implementerGuardrails ?? []).flatMap((guardrail) => [
      [guardrail.id, guardrail.instruction, ...guardrail.appliesToFiles].join(
        "\n",
      ),
    ]),
  ]
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
}

function planAddressesContractViolation(
  plan: OneShotPlan,
  context?: PlannerContractViolationContext,
): string[] {
  if (!context) {
    return [];
  }
  const contractFiles = new Set(
    (plan.fileChangeContract ?? []).map((entry) => entry.path.toLowerCase()),
  );
  const decisionSegments = planTextSegmentsForContractViolationDecision(plan);
  const rejectionPattern =
    /(reject|avoid|do not|don't|not edit|forbid|forbidden|out of scope|constrain)/i;
  return context.violatingFiles.filter((file) => {
    const normalizedFile = file.toLowerCase();
    if (contractFiles.has(normalizedFile)) {
      return false;
    }
    const rejectsFile = decisionSegments.some(
      (segment) =>
        segment.includes(normalizedFile) && rejectionPattern.test(segment),
    );
    return !rejectsFile;
  });
}

function planAddressesRetrofitPatchConflict(
  plan: OneShotPlan,
  context?: PlannerRetrofitPatchConflictContext,
): string[] {
  if (!context) {
    return [];
  }
  const contractFiles = new Set(
    (plan.fileChangeContract ?? []).map((entry) => entry.path.toLowerCase()),
  );
  const decisionSegments = [
    ...planTextSegmentsForContractViolationDecision(plan),
    JSON.stringify(plan.plannerDiscoveries ?? {}).toLowerCase(),
  ];
  const rejectionPattern =
    /(exclude|excluded|reject|avoid|do not|don't|not edit|not apply|forbid|forbidden|out of scope|constrain)/i;
  const filesToDecide = new Set(
    [
      ...context.changedFiles,
      ...context.perCommitStatus.flatMap((entry) => [
        ...entry.targetFiles,
        ...entry.adaptationFiles,
      ]),
    ]
      .map((file) => file.trim())
      .filter(Boolean),
  );
  const unresolvedFiles = Array.from(filesToDecide).filter((file) => {
    const normalizedFile = file.toLowerCase();
    if (contractFiles.has(normalizedFile)) {
      return false;
    }
    const rejectsFile = decisionSegments.some(
      (segment) =>
        segment.includes(normalizedFile) && rejectionPattern.test(segment),
    );
    return !rejectsFile;
  });
  if (unresolvedFiles.length > 0) {
    return unresolvedFiles;
  }

  const unresolvedShas = new Set(
    context.perCommitStatus
      .filter(
        (entry) => entry.status === "failed" || entry.status === "not_attempted",
      )
      .map((entry) => entry.sha.trim().toLowerCase())
      .filter(Boolean),
  );
  const planText = decisionSegments.join("\n");
  return context.selectedShas.filter((sha) => {
    const normalizedSha = sha.toLowerCase();
    return (
      normalizedSha &&
      unresolvedShas.has(normalizedSha) &&
      !planText.includes(normalizedSha)
    );
  });
}

export function detectRetrofitAlreadyAppliedEvidence(
  plan: OneShotPlan,
  context?: PlannerRetrofitContext | null,
): OneShotRetrofitEvidence | null {
  if (!context) {
    return null;
  }

  const evidence = plan.plannerDiscoveries?.retrofitEvidence;
  if (!evidence) {
    return null;
  }

  const selectedCommits = evidence.selectedCommits ?? [];
  const allSelectedCommitsAlreadyApplied =
    selectedCommits.length > 0 &&
    selectedCommits.every((commit) => commit.alreadyApplied === true);
  if (!evidence.alreadyApplied && !allSelectedCommitsAlreadyApplied) {
    return null;
  }

  return {
    ...evidence,
    sourceJiraKey: evidence.sourceJiraKey || context.sourceJiraKey,
    sourceBranch: evidence.sourceBranch || context.sourceBranch,
    targetBranch: evidence.targetBranch || context.targetBranch,
    alreadyApplied: true,
  };
}

type PlannerFailureKind =
  | "already_applied"
  | "idle_timeout"
  | "no_progress"
  | "post_tool_idle_timeout"
  | "schema_invalid_after_success"
  | "retrofit_contract_missing_after_normalization"
  | "structured_output_retries_exhausted"
  | "tool_stall"
  | "wall_timeout"
  | "workspace_checkout_timeout"
  | "plan_validation"
  | "other";

type PlannerFailureCategory =
  | "model_stall"
  | "planner_no_progress"
  | "wall_timeout"
  | "workspace"
  | "plan_validation"
  | "other";

type PlannerDiagnosticArtifactKeys = Partial<
  Record<
    | "sdkLifecycle"
    | "sdkMessageSummary"
    | "toolCallProfiles"
    | "rawTrace"
    | "failedOutput"
    | "draftPlan"
    | "groundingDiagnostics",
    string
  >
>;

type PlannerDiagnosticWarningTag =
  | "sdk_lifecycle_artifact_failed"
  | "sdk_message_summary_artifact_failed"
  | "tool_call_profile_artifact_failed"
  | "sdk_raw_trace_artifact_failed";

export function classifyPlannerFailure(error: unknown): {
  failureKind: PlannerFailureKind;
  failureCategory: PlannerFailureCategory;
} {
  if (isWorkspaceCheckoutTimeoutError(error)) {
    return {
      failureKind: "workspace_checkout_timeout",
      failureCategory: "workspace",
    };
  }

  if (
    error instanceof PlannerRetrofitAlreadyAppliedError ||
    (error instanceof Error && error.message.startsWith("already_applied:"))
  ) {
    return {
      failureKind: "already_applied",
      failureCategory: "plan_validation",
    };
  }

  if (
    error instanceof Error &&
    error.message.startsWith("Plan ignored plan-contract violation context")
  ) {
    return {
      failureKind: "plan_validation",
      failureCategory: "plan_validation",
    };
  }

  if (error instanceof PlannerStallError) {
    switch (error.failureKind) {
      case "no_progress":
        return {
          failureKind: "no_progress",
          failureCategory: "planner_no_progress",
        };
      case "idle_timeout":
      case "post_tool_idle_timeout":
      case "tool_stall":
        return {
          failureKind: error.failureKind,
          failureCategory: "model_stall",
        };
      case "schema_invalid_after_success":
      case "retrofit_contract_missing_after_normalization":
      case "structured_output_retries_exhausted":
        return {
          failureKind: error.failureKind,
          failureCategory: "plan_validation",
        };
      case "wall_timeout":
        return {
          failureKind: "wall_timeout",
          failureCategory: "wall_timeout",
        };
      default:
        return { failureKind: "other", failureCategory: "other" };
    }
  }

  if (
    error instanceof ZodError ||
    error instanceof PlannerGroundingValidationError
  ) {
    return {
      failureKind: "plan_validation",
      failureCategory: "plan_validation",
    };
  }

  return { failureKind: "other", failureCategory: "other" };
}

// Budget-facing token total. Counts only input + output — the units Anthropic
// bills at full rate. Cache-read (10% rate) and cache-write (125% rate) tokens
// are tracked separately in artifacts and OTEL metrics for observability, but
// folding them 1:1 into the budget overstates consumption by ~10x on runs that
// prompt-cache well, which is the opposite of the signal we want (good caching
// should reduce apparent consumption, not increase it).
function calculateTokenUsage(metrics: {
  tokensUsed?: {
    input: number;
    output: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
}): number {
  const usage = metrics.tokensUsed;
  if (!usage) {
    return 0;
  }
  return (usage.input || 0) + (usage.output || 0);
}

export function combinePlannerMetrics(
  primary: PlannerAttemptMetrics,
  secondary?: PlannerAttemptMetrics,
): PlannerAttemptMetrics {
  if (!secondary) {
    return primary;
  }
  const tokensUsed =
    primary.tokensUsed || secondary.tokensUsed
      ? {
          input:
            (primary.tokensUsed?.input ?? 0) +
            (secondary.tokensUsed?.input ?? 0),
          output:
            (primary.tokensUsed?.output ?? 0) +
            (secondary.tokensUsed?.output ?? 0),
          cacheRead:
            (primary.tokensUsed?.cacheRead ?? 0) +
            (secondary.tokensUsed?.cacheRead ?? 0),
          cacheWrite:
            (primary.tokensUsed?.cacheWrite ?? 0) +
            (secondary.tokensUsed?.cacheWrite ?? 0),
        }
      : undefined;
  const modelUsage = mergeModelUsage(primary.modelUsage, secondary.modelUsage);
  const modelCostUsage = mergeModelCostUsage(
    primary.modelCostUsage,
    secondary.modelCostUsage,
  );
  const costUsd =
    primary.costUsd === undefined && secondary.costUsd === undefined
      ? undefined
      : (primary.costUsd ?? 0) + (secondary.costUsd ?? 0);
  const costUsdExact =
    costUsd === undefined
      ? undefined
      : (primary.costUsd === undefined || primary.costUsdExact !== false) &&
        (secondary.costUsd === undefined || secondary.costUsdExact !== false);
  return {
    ...primary,
    durationMs: primary.durationMs + secondary.durationMs,
    toolCalls: primary.toolCalls + secondary.toolCalls,
    llmToolCalls:
      (primary.llmToolCalls ?? primary.toolCalls) +
      (secondary.llmToolCalls ?? secondary.toolCalls),
    costUsd,
    costUsdExact,
    tokensUsed,
    modelUsage,
    modelCostUsage,
    modelUsed: primary.modelUsed ?? secondary.modelUsed,
    groundingCandidateFiles:
      primary.groundingCandidateFiles ?? secondary.groundingCandidateFiles,
    groundingConfidence:
      primary.groundingConfidence ?? secondary.groundingConfidence,
    groundingSource: primary.groundingSource ?? secondary.groundingSource,
    plannerScoutStatus:
      primary.plannerScoutStatus ?? secondary.plannerScoutStatus,
    scoutReports: primary.scoutReports ?? secondary.scoutReports,
    scoutCoverage: primary.scoutCoverage ?? secondary.scoutCoverage,
    scoutInvocationFailed:
      primary.scoutInvocationFailed ?? secondary.scoutInvocationFailed,
    scoutReturnedNothing:
      primary.scoutReturnedNothing ?? secondary.scoutReturnedNothing,
    proceededWithWeakScout:
      primary.proceededWithWeakScout ?? secondary.proceededWithWeakScout,
    warnings: [...(primary.warnings ?? []), ...(secondary.warnings ?? [])],
    readCalls:
      primary.readCalls === undefined && secondary.readCalls === undefined
        ? undefined
        : (primary.readCalls ?? 0) + (secondary.readCalls ?? 0),
    grepCalls:
      primary.grepCalls === undefined && secondary.grepCalls === undefined
        ? undefined
        : (primary.grepCalls ?? 0) + (secondary.grepCalls ?? 0),
    globCalls:
      primary.globCalls === undefined && secondary.globCalls === undefined
        ? undefined
        : (primary.globCalls ?? 0) + (secondary.globCalls ?? 0),
    effectiveReads:
      primary.effectiveReads === undefined &&
      secondary.effectiveReads === undefined
        ? undefined
        : (primary.effectiveReads ?? 0) + (secondary.effectiveReads ?? 0),
    groundingOverlap:
      primary.groundingOverlap === undefined &&
      secondary.groundingOverlap === undefined
        ? undefined
        : (primary.groundingOverlap ?? 0) + (secondary.groundingOverlap ?? 0),
    searchCallRatio: primary.searchCallRatio ?? secondary.searchCallRatio,
    repeatedSearchGlobCount:
      primary.repeatedSearchGlobCount === undefined &&
      secondary.repeatedSearchGlobCount === undefined
        ? undefined
        : (primary.repeatedSearchGlobCount ?? 0) +
          (secondary.repeatedSearchGlobCount ?? 0),
    broadSearchCount:
      primary.broadSearchCount === undefined &&
      secondary.broadSearchCount === undefined
        ? undefined
        : (primary.broadSearchCount ?? 0) + (secondary.broadSearchCount ?? 0),
    plannerOutputSanitized:
      primary.plannerOutputSanitized ?? secondary.plannerOutputSanitized,
    plannerOutputTruncatedChars:
      primary.plannerOutputTruncatedChars ??
      secondary.plannerOutputTruncatedChars,
    plannerOutputSanitization:
      primary.plannerOutputSanitization ?? secondary.plannerOutputSanitization,
    plannerStructuredOutputRepair:
      primary.plannerStructuredOutputRepair ??
      secondary.plannerStructuredOutputRepair,
    plannerSubagentAttempted:
      primary.plannerSubagentAttempted === undefined &&
      secondary.plannerSubagentAttempted === undefined
        ? undefined
        : Boolean(primary.plannerSubagentAttempted) ||
          Boolean(secondary.plannerSubagentAttempted),
    plannerSubagentAttemptMissing:
      primary.plannerSubagentAttemptMissing === undefined &&
      secondary.plannerSubagentAttemptMissing === undefined
        ? undefined
        : Boolean(primary.plannerSubagentAttempted) ||
            Boolean(secondary.plannerSubagentAttempted)
          ? false
          : Boolean(primary.plannerSubagentAttemptMissing) ||
            Boolean(secondary.plannerSubagentAttemptMissing),
    plannerSubagentOutcome: combinePlannerSubagentOutcome(
      primary.plannerSubagentOutcome,
      secondary.plannerSubagentOutcome,
    ),
    sdkLifecycleSummary:
      primary.sdkLifecycleSummary ?? secondary.sdkLifecycleSummary,
    sdkRawTrace: primary.sdkRawTrace ?? secondary.sdkRawTrace,
    plannerSourceRecoveryAccepted:
      primary.plannerSourceRecoveryAccepted ??
      secondary.plannerSourceRecoveryAccepted,
    plannerSourceRecoveryRejected:
      primary.plannerSourceRecoveryRejected ??
      secondary.plannerSourceRecoveryRejected,
    plannerSourceRecoveryCandidates:
      primary.plannerSourceRecoveryCandidates ??
      secondary.plannerSourceRecoveryCandidates,
    toolCallProfiles: [
      ...(primary.toolCallProfiles ?? []),
      ...(secondary.toolCallProfiles ?? []),
    ],
  };
}

function combinePlannerSubagentOutcome(
  primary?: PlannerAttemptMetrics["plannerSubagentOutcome"],
  secondary?: PlannerAttemptMetrics["plannerSubagentOutcome"],
): PlannerAttemptMetrics["plannerSubagentOutcome"] | undefined {
  if (primary === "attempted_succeeded" || secondary === "attempted_succeeded") {
    return "attempted_succeeded";
  }
  if (
    primary === "attempted_failed_or_denied" ||
    secondary === "attempted_failed_or_denied"
  ) {
    return "attempted_failed_or_denied";
  }
  if (
    primary === "configured_not_attempted" ||
    secondary === "configured_not_attempted"
  ) {
    return "configured_not_attempted";
  }
  return undefined;
}

function withPlannerMainModelCostUsage(
  metrics: PlannerAttemptMetrics,
): PlannerAttemptMetrics {
  if (metrics.modelCostUsage) {
    return metrics;
  }
  return {
    ...metrics,
    modelCostUsage: buildModelCostUsage(metrics, "planner_main", {
      mixedModelNote: "native_agent_mixed_model_cost_estimated",
    }),
  };
}

function metricsFromScoutRun(
  scoutRun: PlannerScoutRunResult | null,
): PlannerAttemptMetrics | undefined {
  if (!scoutRun) {
    return undefined;
  }
  return scoutRun.reports.reduce<PlannerAttemptMetrics>(
    (total, report) => ({
      durationMs: total.durationMs + report.durationMs,
      toolCalls: total.toolCalls + report.toolCalls,
      llmToolCalls: (total.llmToolCalls ?? total.toolCalls) + report.toolCalls,
      costUsd:
        total.costUsd === undefined && report.costUsd === undefined
          ? undefined
          : (total.costUsd ?? 0) + (report.costUsd ?? 0),
      costUsdExact:
        total.costUsd === undefined && report.costUsd === undefined
          ? undefined
          : (total.costUsd === undefined || total.costUsdExact !== false) &&
            (report.costUsd === undefined || report.costUsdExact !== false),
      tokensUsed: {
        input: (total.tokensUsed?.input ?? 0) + (report.tokensUsed?.input ?? 0),
        output:
          (total.tokensUsed?.output ?? 0) + (report.tokensUsed?.output ?? 0),
        cacheRead:
          (total.tokensUsed?.cacheRead ?? 0) +
          (report.tokensUsed?.cacheRead ?? 0),
        cacheWrite:
          (total.tokensUsed?.cacheWrite ?? 0) +
          (report.tokensUsed?.cacheWrite ?? 0),
      },
      modelUsage: mergeModelUsage(total.modelUsage, report.modelUsage),
      modelCostUsage: mergeModelCostUsage(
        total.modelCostUsage,
        buildModelCostUsage(report, "planner_scouts"),
      ),
      warnings: total.warnings,
      scoutCoverage: total.scoutCoverage,
      scoutInvocationFailed: total.scoutInvocationFailed,
      scoutReturnedNothing: total.scoutReturnedNothing,
    }),
    {
      durationMs: scoutRun.workplanMetrics?.durationMs ?? 0,
      toolCalls: scoutRun.workplanMetrics?.toolCalls ?? 0,
      llmToolCalls: scoutRun.workplanMetrics?.toolCalls ?? 0,
      warnings: scoutRun.warnings,
      tokensUsed: scoutRun.workplanMetrics?.tokensUsed,
      costUsd: scoutRun.workplanMetrics?.costUsd,
      costUsdExact: scoutRun.workplanMetrics?.costUsdExact,
      modelUsage: scoutRun.workplanMetrics?.modelUsage,
      modelCostUsage: buildModelCostUsage(
        scoutRun.workplanMetrics,
        "planner_scout_workplan",
      ),
      scoutCoverage: scoutRun.coverage,
      scoutInvocationFailed: scoutRun.scoutInvocationFailed,
      scoutReturnedNothing: scoutRun.scoutReturnedNothing,
    },
  );
}

function statusFromScoutRun(
  scoutRun: PlannerScoutRunResult,
): PlannerEvidenceContext["scoutStatus"] {
  if (scoutRun.scoutInvocationFailed) {
    return "scouts_error";
  }
  if (scoutRun.coverage.requirementCount === 0 && scoutRun.workplan) {
    return "scouts_no_work_items";
  }
  if (scoutRun.coverage.requirementCount === 0) {
    return "scouts_no_requirements";
  }
  if (scoutRun.workItems.length === 0) {
    return "scouts_no_work_items";
  }
  if (scoutRun.reports.length === 0) {
    logger.warn(
      {
        event: "scout_invariant_violation",
        workItems: scoutRun.workItems.length,
        reports: scoutRun.reports.length,
      },
      "Planner scout returned work items without reports",
    );
    return "scouts_all_failed";
  }
  const validScoutCount = scoutRun.reports.filter(
    (report) =>
      report.status === "valid" && report.verifiedInspectedFiles.length > 0,
  ).length;
  if (validScoutCount === 0) {
    return "scouts_all_failed";
  }
  if (validScoutCount < scoutRun.reports.length) {
    return "scouts_partial_success";
  }
  return "scouts_supported_plan";
}

function enrichPlannerErrorWithScoutContext(
  error: unknown,
  input: {
    scoutMetrics?: PlannerAttemptMetrics;
    scoutStatus: PlannerEvidenceContext["scoutStatus"];
    evidenceContext: PlannerEvidenceContext;
    groundingContext?: Pick<
      PlannerGroundingContext,
      "confidence" | "candidateFiles"
    > | null;
    outputPreview?: string;
    proceededWithWeakScout: boolean;
  },
): void {
  if (!(error instanceof Error)) {
    return;
  }
  const existing = plannerAttemptDetails(error) ?? {};
  const existingMetrics = existing.metrics
    ? withPlannerMainModelCostUsage(existing.metrics)
    : undefined;
  const mergedMetrics = existing.metrics
    ? input.scoutMetrics
      ? combinePlannerMetrics(existingMetrics!, input.scoutMetrics)
      : existingMetrics
    : input.scoutMetrics;
  const enrichedMetrics = mergedMetrics
    ? {
        ...mergedMetrics,
        plannerScoutStatus:
          mergedMetrics.plannerScoutStatus ?? input.scoutStatus,
        scoutReports:
          mergedMetrics.scoutReports ??
          input.evidenceContext.scoutReports.length,
        scoutCoverage:
          mergedMetrics.scoutCoverage ?? input.evidenceContext.scoutCoverage,
        scoutInvocationFailed:
          mergedMetrics.scoutInvocationFailed ??
          input.evidenceContext.scoutInvocationFailed,
        scoutReturnedNothing:
          mergedMetrics.scoutReturnedNothing ??
          input.evidenceContext.scoutReturnedNothing,
        proceededWithWeakScout:
          mergedMetrics.proceededWithWeakScout ?? input.proceededWithWeakScout,
      }
    : undefined;
  const enriched = {
    ...existing,
    ...(enrichedMetrics ? { metrics: enrichedMetrics } : {}),
    groundingConfidence:
      existing.groundingConfidence ??
      input.evidenceContext.confidence ??
      input.groundingContext?.confidence,
    groundingCandidateFiles:
      existing.groundingCandidateFiles ??
      input.groundingContext?.candidateFiles?.length,
    plannerScoutStatus: existing.plannerScoutStatus ?? input.scoutStatus,
    outputPreview:
      existing.outputPreview ?? input.outputPreview?.slice(0, 2_000),
  };
  if (error instanceof PlannerStallError) {
    Object.assign(error.details, enriched);
    return;
  }
  (error as PlannerErrorWithAttemptDetails).plannerAttemptDetails = enriched;
}

function failedPlannerMetrics(error: unknown): {
  metrics: PlannerAttemptMetrics;
  model: string;
  groundingConfidence: string | null;
  groundingCandidateFiles: number | null;
  plannerScoutStatus: PlannerEvidenceContext["scoutStatus"] | null;
  hasStructuredOutput: boolean | null;
  outputPreview: string | null;
  structuredOutputRepair:
    | PlannerAttemptMetrics["plannerStructuredOutputRepair"]
    | null;
} | null {
  const details = plannerAttemptDetails(error);
  if (!details?.metrics) {
    return null;
  }

  const metrics = {
    ...details.metrics,
    plannerStructuredOutputRepair:
      details.metrics.plannerStructuredOutputRepair ??
      details.structuredOutputRepair,
  };
  return {
    metrics,
    model: details.modelUsed ?? metrics.modelUsed ?? "unknown",
    groundingConfidence:
      details.groundingConfidence ?? metrics.groundingConfidence ?? null,
    groundingCandidateFiles:
      details.groundingCandidateFiles ??
      metrics.groundingCandidateFiles ??
      null,
    plannerScoutStatus:
      details.plannerScoutStatus ?? metrics.plannerScoutStatus ?? null,
    hasStructuredOutput: details.hasStructuredOutput ?? null,
    outputPreview: details.outputPreview ?? null,
    structuredOutputRepair: metrics.plannerStructuredOutputRepair ?? null,
  };
}

function plannerAttemptDetails(error: unknown) {
  return error instanceof PlannerStallError
    ? error.details
    : error instanceof Error
      ? (error as PlannerErrorWithAttemptDetails).plannerAttemptDetails
      : undefined;
}

function plannerToolSummary(metrics?: PlannerAttemptMetrics) {
  const profiles = metrics?.toolCallProfiles ?? [];
  const byTool = profiles.reduce<
    Record<string, { calls: number; success: number; failed: number }>
  >((summary, profile) => {
    const current = summary[profile.tool] ?? {
      calls: 0,
      success: 0,
      failed: 0,
    };
    current.calls += 1;
    if (profile.success) {
      current.success += 1;
    } else {
      current.failed += 1;
    }
    summary[profile.tool] = current;
    return summary;
  }, {});
  return {
    total: metrics?.toolCalls ?? profiles.length,
    llmToolCalls:
      metrics?.llmToolCalls ?? metrics?.toolCalls ?? profiles.length,
    byTool,
  };
}

function compactPlannerDiagnosticBody(body: unknown): unknown {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return body;
  }
  const record = body as Record<string, unknown>;
  const compact: Record<string, unknown> = {};
  for (const key of [
    "errors",
    "warnings",
    "decisions",
    "outputPreview",
    "hasStructuredOutput",
    "structuredOutputRepair",
    "schemaValidationErrors",
    "schemaValidationStage",
    "retrofitContractNormalization",
    "toolSummary",
    "metrics",
  ]) {
    if (key in record) {
      compact[key] = record[key];
    }
  }
  return Object.keys(compact).length > 0 ? compact : body;
}

function diagnosticArtifactKeysFromEvent(
  event: OneShotRunEvent,
): PlannerDiagnosticArtifactKeys {
  const metadata = event.metadata_json ?? {};
  const direct = metadata.planner_diagnostic_artifacts;
  const lifecycle = metadata.diagnosticArtifactKeys;
  const candidate =
    direct && typeof direct === "object" && !Array.isArray(direct)
      ? direct
      : lifecycle && typeof lifecycle === "object" && !Array.isArray(lifecycle)
        ? lifecycle
        : undefined;
  if (!candidate) {
    return {};
  }
  const keys: PlannerDiagnosticArtifactKeys = {};
  for (const key of [
    "failedOutput",
    "draftPlan",
    "groundingDiagnostics",
  ] as const) {
    const value = (candidate as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      keys[key] = value;
    }
  }
  return keys;
}

function buildRevisionSummary(context?: PlannerRevisionContext): string {
  if (!context) {
    return "";
  }
  return JSON.stringify({
    previousPlanSummary: context.previousPlan
      ? {
          summary: context.previousPlan.summary,
          specs: context.previousPlan.specs.map((spec) => ({
            id: spec.id,
            objective: spec.objective,
            targetFiles: spec.targetFiles,
          })),
          risks: context.previousPlan.risks,
          openQuestions: context.previousPlan.openQuestions,
        }
      : null,
    previousReview: context.previousReview ?? null,
  });
}

function formatScoutWorkplanForPrompt(
  result: ScoutWorkplanResult | null,
): string {
  if (!result) {
    return "";
  }
  const scouts = result.workplan.scouts.length > 0
    ? result.workplan.scouts
        .map((scout) => {
          return [
            `- ${scout.id} (${scout.priority}, max tools ${scout.maxToolCalls})`,
            `  objective: ${scout.objective}`,
            `  why: ${scout.whyNeeded}`,
            `  must answer: ${scout.mustAnswer.join("; ")}`,
            `  expected evidence: ${scout.expectedEvidence.join("; ")}`,
            `  fallback: ${scout.fallbackIfIncomplete}`,
          ].join("\n");
        })
        .join("\n")
    : "- none";
  return [
    "## Planner Scout Workplan",
    "",
    `Source: ${result.source}`,
    `Complexity: ${result.workplan.complexity}`,
    `Direct planning allowed: ${result.workplan.directPlanningAllowed ? "yes" : "no"}`,
    `Rationale: ${result.workplan.rationale}`,
    `Global risks: ${result.workplan.globalRisks.join("; ") || "none"}`,
    `Evidence gaps: ${result.workplan.evidenceGaps.join("; ") || "none"}`,
    `Warnings: ${result.warnings.join("; ") || "none"}`,
    "",
    "Scouts:",
    scouts,
  ].join("\n");
}

export class PlannerConsumer extends QueueConsumerBase {
  private readonly db: Database;
  private readonly oneShotDb: OneShotDatabase;
  private readonly publisher: OneShotPublisher;
  private readonly storage: Storage;
  private readonly s3Client: S3Client;
  private readonly workspaceManager: OneShotWorkspaceManager;
  private readonly plannerProvider: ClaudePlannerProvider;
  private readonly scoutProvider: PlannerScoutProvider;
  private readonly scoutWorkplanProvider: ScoutWorkplanProvider;
  private readonly config: OneShotConsumerConfig;

  constructor(private readonly deps: PlannerConsumerDeps = {}) {
    const config = deps.config ?? getOneShotConsumerConfig();
    const sqsClient =
      deps.sqsClient ?? new SQSClient({ region: config.region });
    super(config.planningQueueUrl, "planning", sqsClient);
    this.config = config;

    const db = deps.db ?? getDatabase();
    this.db = db;
    this.oneShotDb = new OneShotDatabase(db.getPool());
    this.publisher = deps.publisher ?? new OneShotPublisher(config.region);
    this.storage = deps.storage ?? getStorage({ region: config.region });
    this.s3Client = deps.s3Client ?? createS3Client({ region: config.region });
    this.workspaceManager =
      deps.workspaceManager ??
      createLeasedOneShotWorkspaceManager(this.oneShotDb, {
        repoBasePath: config.repoAdminBasePath,
        repoCacheBasePath: config.repoCacheBasePath,
        workspaceBasePath: config.workspaceBasePath,
        worktreeBasePath: config.worktreeBasePath,
        leaseOwnerTaskArn: process.env.ECS_TASK_ARN ?? `pid:${process.pid}`,
        leaseTtlSeconds: config.workspaceLeaseTtlSeconds,
        leaseHeartbeatSeconds: config.workspaceLeaseHeartbeatSeconds,
        repoCacheFreshnessTtlMs: config.repoCacheFreshnessTtlMs,
      });
    const promptComposer =
      deps.promptComposer ??
      new PromptComposer(createPromptLoader(config, this.s3Client), {
        healthcareGuardrailsEnabled: config.healthcareGuardrailsEnabled,
      });
    this.plannerProvider =
      deps.plannerProvider ?? new ClaudePlannerProvider(promptComposer);
    this.scoutProvider = deps.scoutProvider ?? new PlannerScoutProvider();
    this.scoutWorkplanProvider =
      deps.scoutWorkplanProvider ?? new ScoutWorkplanProvider();
  }

  protected getVisibilityTimeoutSeconds(): number {
    // Prod default 2700s (45 min) covers a 30 minute planner attempt plus
    // scout/workspace/artifact overhead before a stuck retry becomes visible.
    return getVisibilityTimeoutFromEnv(
      "ONESHOT_PLANNER_VISIBILITY_TIMEOUT_SECONDS",
      2700,
    );
  }

  private async persistPlannerDiagnosticArtifact(input: {
    runId: number;
    jiraKey: string;
    key: string;
    body: unknown;
    warningTag: PlannerDiagnosticWarningTag;
    metrics?: Pick<PlannerAttemptMetrics, "warnings">;
    logMessage: string;
  }): Promise<string | undefined> {
    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.artifactBucket,
          Key: input.key,
          Body: JSON.stringify(input.body, null, 2),
          ContentType: "application/json",
        }),
      );
      return input.key;
    } catch (error) {
      logger.warn(
        {
          runId: input.runId,
          jiraKey: input.jiraKey,
          artifactKey: input.key,
          warningTag: input.warningTag,
          error: error instanceof Error ? error.message : String(error),
        },
        input.logMessage,
      );
      if (input.metrics) {
        input.metrics.warnings = [
          ...(input.metrics.warnings ?? []),
          input.warningTag,
        ];
      }
      return undefined;
    }
  }

  protected async handleRunHeartbeat(runId: number): Promise<void> {
    await this.oneShotDb.runs.touchRun(runId);
  }

  protected async handleMessage(
    message: Message,
    receiveCount: number,
  ): Promise<boolean> {
    if (!message.Body) {
      return true;
    }

    const payload = parseOneShotQueueMessage(JSON.parse(message.Body));
    let run = await this.oneShotDb.runs.getRunById(payload.run_id);
    if (!run) {
      logger.warn({ payload }, "Dropping planning message for missing run");
      return true;
    }

    if (run.state !== payload.expected_state) {
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          stage: payload.stage,
          messageId: message.MessageId,
          receiveCount,
          currentState: run.state,
          expectedState: payload.expected_state,
          payloadVersion: payload.version,
          revision: payload.revision,
        },
        "Dropping stale planning message because run state has moved on",
      );
      return true;
    }

    if (
      await handleStaleStageVersionMessage({
        run,
        payload,
        oneShotDb: this.oneShotDb,
        publisher: this.publisher,
        logger,
        messageId: message.MessageId,
        receiveCount,
      })
    ) {
      return true;
    }

    const claimed = await this.oneShotDb.runs.claimQueuedRun(
      run.id,
      payload.expected_state,
      "planning",
      claimGuardForQueueStage(payload.stage, payload.version),
    );
    if (!claimed) {
      return handleClaimMissAfterVersionGuard({
        run,
        payload,
        oneShotDb: this.oneShotDb,
        publisher: this.publisher,
        logger,
        messageId: message.MessageId,
        receiveCount,
      });
    }

    const refreshedRun = await this.oneShotDb.runs.getRunById(run.id);
    if (!refreshedRun) {
      logger.error(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          payload,
          messageId: message.MessageId,
          receiveCount,
        },
        "Dropping claimed planning message because run disappeared after claim",
      );
      return true;
    }
    run = refreshedRun;

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: run.id,
        event_type: "run_claimed",
        from_state: payload.expected_state,
        to_state: "planning",
        stage: "planning",
      })
      .catch(() => undefined);

    if (
      this.config.configWarnings?.includes(
        "planner_scout_model_legacy_haiku_3_5_normalized",
      )
    ) {
      logger.warn(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          plannerScoutModelId: this.config.plannerScoutModelId,
        },
        "Normalized legacy OneShot planner scout model to Haiku 4.5",
      );
      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "planner_config_warning",
          from_state: payload.expected_state,
          to_state: "planning",
          stage: "planning",
          metadata_json: {
            warning: "planner_scout_model_legacy_haiku_3_5_normalized",
            plannerScoutModelId: this.config.plannerScoutModelId,
          },
        })
        .catch(() => undefined);
    }

    let cleanupWorkspace: (() => Promise<void>) | undefined;
    let assertWorkspaceLease: (() => Promise<void>) | undefined;
    let selectedAttemptOverrides: PlannerAttemptOverrides | undefined;

    try {
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          revision: payload.revision,
          version: payload.version,
        },
        "Planner claimed run",
      );

      const [budgetArtifacts, budgetEvents] = await Promise.all([
        this.oneShotDb.artifacts.getArtifactsForRun(run.id),
        this.oneShotDb.events.getEventsForRun(run.id),
      ]);
      const budgetCheck = checkOneShotTokenBudget({
        run,
        config: this.config,
        stage: "planning",
        stageVersion: payload.version,
        artifacts: budgetArtifacts,
        events: budgetEvents,
        projectedTokens: PROJECTED_STAGE_TOKENS,
      });
      if (!budgetCheck.withinBudget) {
        const errorMessage = formatTokenBudgetFailure("planner", budgetCheck);
        await this.failRun(
          run.id,
          run.jira_key,
          "budget_exceeded",
          errorMessage,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "planning",
            to_state: "failed",
            stage: "planning",
            metadata_json: tokenBudgetEventMetadata(
              budgetCheck,
              payload.revision,
            ),
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: run.id,
              eventType: "state_transition",
              stage: "planning",
            }),
          );
        return true;
      }

      const withinStageAttemptBudget =
        await this.oneShotDb.runs.checkStageAttemptBudget(
          run.id,
          "planning",
          this.config.maxStageAttempts,
        );
      if (!withinStageAttemptBudget) {
        await this.failRun(
          run.id,
          run.jira_key,
          "run_failed",
          `OneShot planner exhausted the maximum of ${this.config.maxStageAttempts} stage attempt(s).`,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "planning",
            to_state: "failed",
            stage: "planning",
            metadata_json: {
              reason: "stage_attempts_exhausted",
              maxAttempts: this.config.maxStageAttempts,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: run.id,
              eventType: "state_transition",
              stage: "planning",
            }),
          );
        return true;
      }
      await this.oneShotDb.runs.incrementStageAttempts(run.id, "planning");

      const qualificationArtifact = await this.loadQualificationArtifact(
        run.id,
      );
      const taskManagement = await this.db.getTaskManagementById(
        run.source_task_management_id,
      );
      if (!taskManagement?.task_s3_bucket || !taskManagement.task_s3_key) {
        throw new Error(
          `Missing task description S3 reference for oneshot run ${run.id}`,
        );
      }

      const taskDescription = await this.storage.downloadResult(
        taskManagement.task_s3_bucket,
        taskManagement.task_s3_key,
      );
      const ticketEvidence = await this.loadTicketEvidence(
        qualificationArtifact.ticketEvidenceRef,
        run.id,
        run.jira_key,
      );

      const repo = await this.db.getRepositoryById(run.repo_id);
      if (!repo) {
        throw new Error(
          `Repository ${run.repo_id} not found for oneshot run ${run.id}`,
        );
      }

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          repoName: repo.repo_name,
          branchName: run.branch_name,
          baseCommitSha: run.base_commit_sha,
        },
        "Planner preparing workspace",
      );

      const retrofitContext = extractRetrofitContext(qualificationArtifact);
      const multiRepoBrief = extractMultiRepoBrief(qualificationArtifact);
      const retrofitSourceEvidence =
        extractRetrofitSourceEvidence(qualificationArtifact);
      if (retrofitContext && retrofitContext.targetBranch !== run.branch_name) {
        throw new Error(
          buildRetrofitBranchMismatchMessage(retrofitContext, run.branch_name),
        );
      }
      const runBranch = await ensureRunBranchContract({
        run,
        repo,
        oneShotDb: this.oneShotDb,
        workspaceManager: this.workspaceManager,
        stage: "planner",
        logger,
      });
      const retrofitAdditionalBranches =
        retrofitContext &&
        retrofitContext.sourceBranch.trim() &&
        retrofitContext.sourceBranch !== run.branch_name
          ? [retrofitContext.sourceBranch]
          : [];
      const retrofitRepoCacheLeaseOptions =
        retrofitAdditionalBranches.length > 0
          ? {
              repoCacheLeaseMaxWaitMs:
                this.config.retrofitRepoCacheLeaseWaitMs,
              repoCacheLeaseMetadata: {
                reason: "multi_branch_retrofit_repo_cache_wait",
                runId: run.id,
                groupId: run.run_group_id,
                jiraKey: run.jira_key,
                repoId: run.repo_id,
                repoName: repo.repo_name,
                targetBranch: run.branch_name,
                sourceBranch: retrofitContext.sourceBranch,
                maxWaitMs: this.config.retrofitRepoCacheLeaseWaitMs,
                retryable: true,
              },
            }
          : undefined;
      const workspace = retrofitRepoCacheLeaseOptions
        ? await this.workspaceManager.preparePlannerWorkspace(
            run.id,
            repo,
            runBranch.workspaceBaseSha,
            runBranch.branchName,
            retrofitAdditionalBranches,
            retrofitRepoCacheLeaseOptions,
          )
        : await this.workspaceManager.preparePlannerWorkspace(
            run.id,
            repo,
            runBranch.workspaceBaseSha,
            runBranch.branchName,
            retrofitAdditionalBranches,
          );
      const ticketEvidenceRootPath = ticketEvidence
        ? path.join(workspace.statePath, "planner", "ticket-evidence")
        : undefined;
      const ticketEvidenceSummary =
        ticketEvidence && ticketEvidenceRootPath
          ? renderTicketEvidencePromptSection({
              evidence: ticketEvidence,
              evidenceRootRelativePath: ticketEvidenceRootPath,
            })
          : "";
      const plannerAdditionalDirectories = ticketEvidenceRootPath
        ? [ticketEvidenceRootPath]
        : undefined;
      cleanupWorkspace = workspace.cleanup;
      assertWorkspaceLease = async () => {
        await workspace.assertLeaseValid?.("planning");
      };
      const contractViolationContext = payload.revision
        ? latestPlanContractViolationContext(budgetEvents)
        : undefined;
      const retrofitPatchConflictContext = payload.revision
        ? latestRetrofitPatchConflictContext(budgetEvents)
        : undefined;
      const revisionContext = payload.revision
        ? {
            ...(await this.loadRevisionContext(run.id)),
            ...(contractViolationContext ? { contractViolationContext } : {}),
            ...(retrofitPatchConflictContext
              ? { retrofitPatchConflictContext }
              : {}),
          }
        : undefined;
      const githubCommandContext = payload.revision
        ? await this.loadGitHubCommandContext(run, payload.version)
        : "";
      const priorPlannerDiagnostics = await this.loadPriorPlannerDiagnostics(
        run.id,
        run.jira_key,
        budgetEvents,
      );

      let plannerResponse;
      const workspaceArtifacts: WorkspaceArtifactFile[] = [
        {
          fileName: "qualification.v1.json",
          body: qualificationArtifact,
          format: "json" as const,
        },
      ];
      if (ticketEvidence) {
        workspaceArtifacts.push(...renderTicketEvidenceSidecars(ticketEvidence));
      }
      if (revisionContext?.previousPlan) {
        workspaceArtifacts.push({
          fileName: "plan.previous.json",
          body: revisionContext.previousPlan,
          format: "json" as const,
        });
        workspaceArtifacts.push({
          fileName: "plan.previous.md",
          body: renderOneShotPlanMarkdown(revisionContext.previousPlan),
          format: "md" as const,
        });
      }
      if (revisionContext?.previousReview) {
        workspaceArtifacts.push({
          fileName: "review.previous.json",
          body: revisionContext.previousReview,
          format: "json" as const,
        });
      }
      await materializeRunArtifacts(
        workspace.statePath,
        workspaceArtifacts,
        "planner",
      );

      // Try to reuse prior scan if the base commit hasn't changed
      let repoScan: Awaited<ReturnType<typeof scanRepo>> | null = null;
      const cachedScanPath = path.join(
        workspace.statePath,
        "planner",
        "repo-scan.json",
      );
      try {
        const cached = JSON.parse(await fs.readFile(cachedScanPath, "utf8"));
        if (cached?.baseCommitSha === runBranch.workspaceBaseSha) {
          repoScan = cached;
          logger.info(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              cachedScanPath,
            },
            "Planner reusing cached repo scan",
          );
        }
      } catch {
        // Cache miss — fall through to fresh scan
      }

      if (!repoScan) {
        repoScan = await scanRepo(workspace.workspacePath).catch(() => null);
        if (repoScan) {
          // Attach baseCommitSha for cache validation
          repoScan = {
            ...repoScan,
            baseCommitSha: runBranch.workspaceBaseSha,
          } as typeof repoScan;
        }
      }

      const repoScanSummary = repoScan ? formatScanForPrompt(repoScan) : "";
      const routeCardContext = buildRepoRouteCardContext(
        repo.repo_name,
        [
          run.jira_key,
          qualificationArtifact.ticketSummary ?? "",
          taskDescription,
        ].join("\n\n"),
      );
      const groundingContext = await buildPlannerGroundingContext({
        workspacePath: workspace.workspacePath,
        repoName: repo.repo_name,
        jiraKey: run.jira_key,
        ticketSummary: qualificationArtifact.ticketSummary || run.jira_key,
        taskDescription,
        qualificationSummary: {
          qualified: qualificationArtifact.qualified,
          requirementsSummary: qualificationArtifact.requirementsSummary,
          acceptanceCriteriaPresent:
            qualificationArtifact.acceptanceCriteriaPresent,
          blockingReasons: qualificationArtifact.blockingReasons,
          nonBlockingWarnings: qualificationArtifact.nonBlockingWarnings,
          repoInspectionPerformed:
            qualificationArtifact.repoInspectionPerformed,
          inspectedFiles: qualificationArtifact.inspectedFiles,
          inspectionSummary: qualificationArtifact.inspectionSummary,
        },
        repoScan,
        routeCardContext,
        ticketEvidence,
      }).catch((error) => {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            error: error instanceof Error ? error.message : String(error),
          },
          "Planner deterministic grounding failed; falling back to provider-only planning",
        );
        return null;
      });
      const groundingSummary = groundingContext
        ? formatPlannerGroundingForPrompt(groundingContext)
        : "";
      if (repoScan) {
        await materializeRunArtifacts(
          workspace.statePath,
          [
            {
              fileName: "repo-scan.json",
              body: repoScan,
              format: "json",
            },
          ],
          "planner",
        ).catch(() => undefined);
      }
      if (groundingContext) {
        await materializeRunArtifacts(
          workspace.statePath,
          [
            {
              fileName: "planner-grounding.json",
              body: groundingContext,
              format: "json",
            },
          ],
          "planner",
        ).catch(() => undefined);
      }

      let scoutRun: PlannerScoutRunResult | null = null;
      let scoutWorkplanResult: ScoutWorkplanResult | null = null;
      let scoutStatus: PlannerEvidenceContext["scoutStatus"] =
        "scouts_disabled";
      if (!this.config.plannerScoutEnabled) {
        scoutStatus = "scouts_disabled";
      } else {
        scoutWorkplanResult = await this.scoutWorkplanProvider.generateWorkplan({
          jiraKey: run.jira_key,
          repoName: repo.repo_name,
          workspacePath: workspace.workspacePath,
          taskDescription,
          ticketEvidenceSummary,
          qualificationSummary: {
            requirementsSummary: qualificationArtifact.requirementsSummary,
            acceptanceCriteriaPresent:
              qualificationArtifact.acceptanceCriteriaPresent,
            nonBlockingWarnings: qualificationArtifact.nonBlockingWarnings,
          },
          repoScanSummary,
          routeCardContext,
          groundingSummary,
          revisionSummary: buildRevisionSummary(revisionContext),
          priorDiagnostics: priorPlannerDiagnostics,
          scoutModelId: this.config.plannerScoutModelId,
          permissionMode: this.config.plannerClaudePermissionMode,
          toolVisibility: this.config.plannerClaudeToolVisibility,
          toolGuard: this.config.plannerClaudeToolGuard,
        });
        scoutRun = await this.scoutProvider
          .runScouts({
            jiraKey: run.jira_key,
            repoName: repo.repo_name,
            workspacePath: workspace.workspacePath,
            taskDescription,
            qualificationSummary: {
              requirementsSummary: qualificationArtifact.requirementsSummary,
              nonBlockingWarnings: qualificationArtifact.nonBlockingWarnings,
            },
            groundingContext,
            workplan: scoutWorkplanResult.workplan,
            workplanSource: scoutWorkplanResult.source,
            workplanWarnings: scoutWorkplanResult.warnings,
            workplanMetrics: scoutWorkplanResult.metrics,
            scoutModelId: this.config.plannerScoutModelId,
            permissionMode: this.config.plannerClaudePermissionMode,
            toolVisibility: this.config.plannerClaudeToolVisibility,
            toolGuard: this.config.plannerClaudeToolGuard,
          })
          .catch((error) => ({
            workItems: [],
            reports: [],
            coverage: {
              requirementCount: 0,
              evidenceBackedRequirementCount: 0,
              uncoveredRequirementCount: 0,
            },
            scoutInvocationFailed: true,
            scoutReturnedNothing: false,
            warnings: [
              `Planner scout fallback failed: ${error instanceof Error ? error.message : String(error)}`,
            ],
            workplan: scoutWorkplanResult?.workplan,
            workplanSource: scoutWorkplanResult?.source,
            workplanWarnings: scoutWorkplanResult?.warnings,
            workplanMetrics: scoutWorkplanResult?.metrics,
          }));
        if (scoutRun && scoutWorkplanResult?.metrics && !scoutRun.workplanMetrics) {
          scoutRun = {
            ...scoutRun,
            workplan: scoutRun.workplan ?? scoutWorkplanResult.workplan,
            workplanSource: scoutRun.workplanSource ?? scoutWorkplanResult.source,
            workplanWarnings:
              scoutRun.workplanWarnings ?? scoutWorkplanResult.warnings,
            workplanMetrics: scoutWorkplanResult.metrics,
          };
        }
        scoutStatus = statusFromScoutRun(scoutRun);
      }

      const evidenceContext = buildPlannerEvidenceContext({
        jiraKey: run.jira_key,
        repoName: repo.repo_name,
        grounding: groundingContext,
        scoutStatus,
        scoutReports: scoutRun?.reports ?? [],
        scoutCoverage: scoutRun?.coverage,
        scoutInvocationFailed: scoutRun?.scoutInvocationFailed ?? false,
        scoutReturnedNothing: scoutRun?.scoutReturnedNothing ?? false,
        warnings: scoutRun?.warnings ?? [],
      });
      const evidenceSummary = formatPlannerEvidenceForPrompt(evidenceContext);
      const scoutWorkplanSummary =
        formatScoutWorkplanForPrompt(scoutWorkplanResult);
      const combinedEvidenceSummary = [
        ticketEvidenceSummary,
        scoutWorkplanSummary,
        evidenceSummary,
      ]
        .filter((section) => section.trim().length > 0)
        .join("\n\n---\n\n");
      if (scoutRun) {
        await materializeRunArtifacts(
          workspace.statePath,
          [
            ...(scoutWorkplanResult
              ? [
                  {
                    fileName: "planner-scout-workplan.json",
                    body: {
                      workplan: scoutWorkplanResult.workplan,
                      source: scoutWorkplanResult.source,
                      warnings: scoutWorkplanResult.warnings,
                      priorDiagnostics: priorPlannerDiagnostics.map(
                        (diagnostic) => ({
                          key: diagnostic.key,
                          kind: diagnostic.kind,
                        }),
                      ),
                    },
                    format: "json" as const,
                  },
                ]
              : []),
            {
              fileName: "planner-scouts.json",
              body: scoutRun,
              format: "json",
            },
          ],
          "planner",
        ).catch(() => undefined);
      }
      await materializeRunArtifacts(
        workspace.statePath,
        [
          {
            fileName: "planner-evidence.json",
            body: evidenceContext,
            format: "json",
          },
          ...(retrofitContext
            ? [
                {
                  fileName: "retrofit-context.json",
                  body: retrofitContext,
                  format: "json" as const,
                },
              ]
            : []),
          ...(retrofitSourceEvidence
            ? [
                {
                  fileName: "retrofit-source-evidence.json",
                  body: retrofitSourceEvidence,
                  format: "json" as const,
                },
              ]
            : []),
        ],
        "planner",
      ).catch(() => undefined);

      const scoutMetrics = metricsFromScoutRun(scoutRun);
      const proceededWithWeakScout =
        (scoutStatus === "scouts_all_failed" ||
          scoutStatus === "scouts_error" ||
          scoutStatus === "scouts_no_requirements") &&
        !isPlannerEvidenceStrong(evidenceContext);

      const plannerStartedAt = new Date().toISOString();
      const plannerStartedMs = Date.now();

      // Progressive retry strategy — build attempt overrides based on receiveCount.
      // The planner always runs with schema enforcement because the raw-text
      // recovery path was allowing attempt 1 to burn a full run and then fail
      // validation on missing top-level plan fields.
      const attempt = receiveCount;
      const plannerModel = this.config.plannerModelId?.trim();
      const bedrockConfigFor = (model?: string) => ({
        bedrockConfig: {
          ...(model ? { model } : {}),
          maxOutputTokens: this.config.plannerMaxOutputTokens,
          ...(this.config.plannerMaxThinkingTokens
            ? { maxThinkingTokens: this.config.plannerMaxThinkingTokens }
            : {}),
        },
      });
      const basePlannerControls: Pick<
        PlannerAttemptOverrides,
        | "postToolIdleTimeoutMs"
        | "toolBudgetGuard"
        | "sdkTraceMode"
        | "sdkStallThinkingPreview"
        | "maxTurns"
      > = {
        postToolIdleTimeoutMs: DEFAULT_PLANNER_POST_TOOL_IDLE_TIMEOUT_MS,
        sdkTraceMode: this.config.sdkTraceMode,
        sdkStallThinkingPreview: this.config.sdkStallThinkingPreview,
        maxTurns: this.config.plannerMaxTurns,
        toolBudgetGuard: {
          enabled: true,
          tools: ["Read", "Glob", "Grep"],
          maxCalls: this.config.plannerMaxRepoToolCalls,
          message:
            "Tool budget exhausted. Emit the structured OneShot plan JSON now. Do not request more tools.",
        },
      };
      const attemptOverrides: PlannerAttemptOverrides = (() => {
        if (attempt === 1) {
          // Attempt 1: give broad tickets enough wall time to finish while
          // preserving the 2 minute idle guard for true stalls.
          return {
            ...basePlannerControls,
            useOutputSchema: true,
            timeoutMs: 1_800_000,
            idleTimeoutMs: 120_000,
            permissionMode: this.config.plannerClaudePermissionMode,
            toolVisibility: this.config.plannerClaudeToolVisibility,
            toolGuard: this.config.plannerClaudeToolGuard,
            toolSprawlGuard: this.config.plannerToolSprawlGuard,
            ...bedrockConfigFor(plannerModel),
          };
        } else if (attempt === 2) {
          // Attempt 2: keep the same budget after grounding or parse failures;
          // the work is usually not smaller on retry.
          return {
            ...basePlannerControls,
            useOutputSchema: true,
            timeoutMs: 1_800_000,
            idleTimeoutMs: 120_000,
            permissionMode: this.config.plannerClaudePermissionMode,
            toolVisibility: this.config.plannerClaudeToolVisibility,
            toolGuard: this.config.plannerClaudeToolGuard,
            toolSprawlGuard: this.config.plannerToolSprawlGuard,
            ...bedrockConfigFor(plannerModel),
          };
        } else if (attempt === 3) {
          // Attempt 3: reduce the wall cap, but keep enough time for a large
          // grounded plan to complete.
          return {
            ...basePlannerControls,
            useOutputSchema: true,
            timeoutMs: 1_200_000,
            idleTimeoutMs: 120_000,
            permissionMode: this.config.plannerClaudePermissionMode,
            toolVisibility: this.config.plannerClaudeToolVisibility,
            toolGuard: this.config.plannerClaudeToolGuard,
            toolSprawlGuard: this.config.plannerToolSprawlGuard,
            ...bedrockConfigFor(plannerModel),
          };
        } else {
          // Attempt 4+: keep schema ON with a bounded but still realistic wall
          // cap. Model selection remains stage-level; retries must not silently
          // downgrade the main planner to the scout model.
          return {
            ...basePlannerControls,
            useOutputSchema: true,
            timeoutMs: 900_000,
            idleTimeoutMs: 120_000,
            permissionMode: this.config.plannerClaudePermissionMode,
            toolVisibility: this.config.plannerClaudeToolVisibility,
            toolGuard: this.config.plannerClaudeToolGuard,
            toolSprawlGuard: this.config.plannerToolSprawlGuard,
            ...bedrockConfigFor(plannerModel),
          };
        }
      })();
      selectedAttemptOverrides = attemptOverrides;

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          workspacePath: workspace.workspacePath,
          revision: payload.revision,
          startedAt: plannerStartedAt,
          repoScanAvailable: Boolean(repoScan),
          routeCardContextAvailable: Boolean(routeCardContext),
          groundingConfidence: groundingContext?.confidence,
          groundingCandidateFiles: groundingContext?.candidateFiles.length,
          attempt,
          attemptOverrides,
        },
        "Planner invoking provider",
      );

      try {
        plannerResponse = await this.plannerProvider.generatePlan({
          jiraKey: run.jira_key,
          repoName: repo.repo_name,
          branchName: run.branch_name,
          baseCommitSha: runBranch.workspaceBaseSha,
          workspacePath: workspace.workspacePath,
          ticketSummary: qualificationArtifact.ticketSummary || run.jira_key,
          taskDescription,
          processingMode: resolveOneShotProcessingMode(qualificationArtifact),
          qualificationSummary: {
            requirementsSummary: qualificationArtifact.requirementsSummary,
            acceptanceCriteriaPresent:
              qualificationArtifact.acceptanceCriteriaPresent,
            nonBlockingWarnings: qualificationArtifact.nonBlockingWarnings,
          },
          revision: payload.revision,
          revisionContext,
          repoScanSummary,
          routeCardContext,
          groundingContext: groundingContext ?? undefined,
          groundingSummary,
          evidenceContext,
          evidenceSummary: combinedEvidenceSummary,
          additionalDirectories: plannerAdditionalDirectories,
          retrofitContext: retrofitContext ?? undefined,
          retrofitSourceEvidence: retrofitSourceEvidence ?? undefined,
          additionalScopeSection: combineAdditionalScopeSections([
            formatPlanContractViolationScopeSection(contractViolationContext),
            formatRetrofitPatchConflictScopeSection(
              retrofitPatchConflictContext,
            ),
            githubCommandContext,
            multiRepoBrief ? buildMultiRepoScopeSection(multiRepoBrief) : undefined,
          ]),
          plannerSkillsEnabled: this.config.plannerSkillsEnabled,
          plannerSubagentsEnabled: this.config.plannerSubagentsEnabled,
          plannerSubagentMaxTurns: this.config.plannerSubagentMaxTurns,
          plannerPluginPath: this.config.plannerPluginPath,
          plannerSubagentModelId: this.config.plannerScoutModelId,
          attemptOverrides,
        });
      } catch (error) {
        enrichPlannerErrorWithScoutContext(error, {
          scoutMetrics,
          scoutStatus,
          evidenceContext,
          groundingContext,
          outputPreview: scoutRun?.warnings.join("; "),
          proceededWithWeakScout,
        });
        throw error;
      }
      if (scoutMetrics) {
        plannerResponse = {
          ...plannerResponse,
          metrics: withPlannerMainModelCostUsage(plannerResponse.metrics),
        };
        plannerResponse = {
          ...plannerResponse,
          metrics: combinePlannerMetrics(plannerResponse.metrics, scoutMetrics),
        };
      } else {
        plannerResponse = {
          ...plannerResponse,
          metrics: withPlannerMainModelCostUsage(plannerResponse.metrics),
        };
      }
      plannerResponse = {
        ...plannerResponse,
        metrics: {
          ...plannerResponse.metrics,
          groundingConfidence:
            plannerResponse.metrics.groundingConfidence ??
            evidenceContext.confidence,
          plannerScoutStatus:
            plannerResponse.metrics.plannerScoutStatus ??
            evidenceContext.scoutStatus,
          scoutReports:
            plannerResponse.metrics.scoutReports ??
            evidenceContext.scoutReports.length,
          scoutCoverage:
            plannerResponse.metrics.scoutCoverage ??
            evidenceContext.scoutCoverage,
          scoutInvocationFailed:
            plannerResponse.metrics.scoutInvocationFailed ??
            evidenceContext.scoutInvocationFailed,
          scoutReturnedNothing:
            plannerResponse.metrics.scoutReturnedNothing ??
            evidenceContext.scoutReturnedNothing,
          proceededWithWeakScout:
            plannerResponse.metrics.proceededWithWeakScout ??
            proceededWithWeakScout,
        },
      };
      recordLlmMetrics(
        "planning",
        "anthropic",
        plannerResponse.metrics.durationMs,
        plannerResponse.metrics.tokensUsed,
        plannerResponse.metrics.costUsd,
        {
          model: plannerResponse.metrics.modelUsed ?? "unknown",
          groundingSource: plannerResponse.metrics.groundingSource ?? "unknown",
          groundingConfidence:
            plannerResponse.metrics.groundingConfidence ?? "unknown",
          effectiveReads: plannerResponse.metrics.effectiveReads ?? 0,
          groundingOverlap: plannerResponse.metrics.groundingOverlap ?? 0,
          searchCallRatio: plannerResponse.metrics.searchCallRatio ?? 0,
          plannerSourceRecoveryAccepted:
            plannerResponse.metrics.plannerSourceRecoveryAccepted ?? 0,
          plannerSourceRecoveryRejected:
            plannerResponse.metrics.plannerSourceRecoveryRejected ?? 0,
          plannerScoutStatus:
            plannerResponse.metrics.plannerScoutStatus ?? "unknown",
          scoutInvocationFailed:
            plannerResponse.metrics.scoutInvocationFailed ?? false,
          scoutReturnedNothing:
            plannerResponse.metrics.scoutReturnedNothing ?? false,
          proceededWithWeakScout:
            plannerResponse.metrics.proceededWithWeakScout ?? false,
        },
      );
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          revision: payload.revision,
          completedAt: new Date().toISOString(),
          providerDurationMs: Date.now() - plannerStartedMs,
        },
        "Planner provider completed",
      );

      const plan = this.parsePlanWithDiagnostics(
        plannerResponse.plan,
        run.id,
        run.jira_key,
      );
      const unresolvedContractViolations = planAddressesContractViolation(
        plan,
        contractViolationContext,
      );
      if (unresolvedContractViolations.length > 0) {
        throw new Error(
          `Plan ignored plan-contract violation context for file(s): ${unresolvedContractViolations.join(", ")}`,
        );
      }
      const unresolvedRetrofitPatchContext = planAddressesRetrofitPatchConflict(
        plan,
        retrofitPatchConflictContext,
      );
      if (unresolvedRetrofitPatchContext.length > 0) {
        throw new Error(
          `Plan ignored retrofit patch conflict context for item(s): ${unresolvedRetrofitPatchContext.join(", ")}`,
        );
      }
      const alreadyAppliedEvidence = detectRetrofitAlreadyAppliedEvidence(
        plan,
        retrofitContext,
      );
      if (alreadyAppliedEvidence) {
        throw new PlannerRetrofitAlreadyAppliedError(alreadyAppliedEvidence);
      }
      const qualificationRiskAssessment = assessOneShotQualificationRisk(
        qualificationArtifact,
      );
      const planRiskAssessment = assessOneShotPlanRisk(plan);
      const detectedExternalSpecEvidence = detectExternalSpecEvidence({
        plan,
        qualification: qualificationArtifact,
        ticketSummary: qualificationArtifact.ticketSummary,
        taskDescription,
      });
      const activeReadinessCategories = getActiveReadinessRiskCategories();
      const externalSpecFetchActive =
        activeReadinessCategories === "all" ||
        activeReadinessCategories.has("external_spec_contract");
      const externalSpecEvidence = await resolveExternalSpecEvidence({
        detected: detectedExternalSpecEvidence,
        s3Client: this.s3Client,
        bucket: this.config.artifactBucket,
        fetchActive: externalSpecFetchActive,
      }).catch((error) => {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            detectedUrls: detectedExternalSpecEvidence.urls.length,
            error: error instanceof Error ? error.message : String(error),
          },
          "External spec evidence resolution failed; continuing with observe-only evidence",
        );
        return detectedExternalSpecEvidence;
      });
      const artifactKey = buildOneShotArtifactKey(
        this.config,
        run.jira_key,
        run.id,
        "plan",
        payload.version,
      );

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          artifactKey,
          impactedFiles: getPlanImpactedFiles(plan).length,
        },
        "Planner writing plan artifact",
      );

      await assertWorkspaceLease?.();
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.artifactBucket,
          Key: artifactKey,
          Body: JSON.stringify(plan, null, 2),
          ContentType: "application/json",
        }),
      );

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.artifactBucket,
          Key: artifactKey.replace(/\.json$/i, ".md"),
          Body: renderOneShotPlanMarkdown(plan),
          ContentType: "text/markdown",
        }),
      );
      const plannerDiagnosticArtifactKeys: PlannerDiagnosticArtifactKeys = {};
      if (plannerResponse.metrics.sdkLifecycleSummary) {
        const lifecycleArtifactKey = artifactKey.replace(
          /plan\.json$/i,
          "sdk-lifecycle.json",
        );
        const persistedLifecycleKey =
          await this.persistPlannerDiagnosticArtifact({
            runId: run.id,
            jiraKey: run.jira_key,
            key: lifecycleArtifactKey,
            body: plannerResponse.metrics.sdkLifecycleSummary,
            warningTag: "sdk_lifecycle_artifact_failed",
            metrics: plannerResponse.metrics,
            logMessage:
              "Failed to persist planner SDK lifecycle artifact; continuing",
          });
        if (persistedLifecycleKey) {
          plannerDiagnosticArtifactKeys.sdkLifecycle = persistedLifecycleKey;
        }
        const messageSummaryArtifactKey = artifactKey.replace(
          /plan\.json$/i,
          "sdk-message-summary.json",
        );
        const lifecycle = plannerResponse.metrics.sdkLifecycleSummary;
        const persistedMessageSummaryKey =
          await this.persistPlannerDiagnosticArtifact({
            runId: run.id,
            jiraKey: run.jira_key,
            key: messageSummaryArtifactKey,
            body: {
              messageTypeCounts: lifecycle.messageTypeCounts,
              systemSubtypeCounts: lifecycle.systemSubtypeCounts,
              hookEventCounts: lifecycle.hookEventCounts,
              apiRetryCount: lifecycle.apiRetryCount,
              rateLimitCount: lifecycle.rateLimitCount,
              compactBoundaryCount: lifecycle.compactBoundaryCount,
            },
            warningTag: "sdk_message_summary_artifact_failed",
            metrics: plannerResponse.metrics,
            logMessage:
              "Failed to persist planner SDK message summary artifact; continuing",
          });
        if (persistedMessageSummaryKey) {
          plannerDiagnosticArtifactKeys.sdkMessageSummary =
            persistedMessageSummaryKey;
        }
      }
      if (plannerResponse.metrics.toolCallProfiles?.length) {
        const toolProfileArtifactKey = artifactKey.replace(
          /plan\.json$/i,
          "tool-call-profile.json",
        );
        const persistedToolProfileKey =
          await this.persistPlannerDiagnosticArtifact({
            runId: run.id,
            jiraKey: run.jira_key,
            key: toolProfileArtifactKey,
            body: plannerResponse.metrics.toolCallProfiles,
            warningTag: "tool_call_profile_artifact_failed",
            metrics: plannerResponse.metrics,
            logMessage:
              "Failed to persist planner tool-call profile artifact; continuing",
          });
        if (persistedToolProfileKey) {
          plannerDiagnosticArtifactKeys.toolCallProfiles =
            persistedToolProfileKey;
        }
      }
      if (
        this.config.sdkTraceMode === "always" &&
        plannerResponse.metrics.sdkRawTrace?.length
      ) {
        const rawTraceArtifactKey = artifactKey.replace(
          /plan\.json$/i,
          "sdk-raw-trace.json",
        );
        const persistedRawTraceKey =
          await this.persistPlannerDiagnosticArtifact({
            runId: run.id,
            jiraKey: run.jira_key,
            key: rawTraceArtifactKey,
            body: plannerResponse.metrics.sdkRawTrace,
            warningTag: "sdk_raw_trace_artifact_failed",
            metrics: plannerResponse.metrics,
            logMessage:
              "Failed to persist planner SDK raw trace artifact; continuing",
          });
        if (persistedRawTraceKey) {
          plannerDiagnosticArtifactKeys.rawTrace = persistedRawTraceKey;
        }
      }

      const tokenUsage = calculateTokenUsage(plannerResponse.metrics);

      await assertWorkspaceLease?.();
      await this.oneShotDb.artifacts.upsertArtifact({
        oneshot_run_id: run.id,
        stage: "plan",
        version: payload.version,
        status: "completed",
        s3_bucket: this.config.artifactBucket,
        s3_key: artifactKey,
        provider: "anthropic",
        model:
          plannerResponse.metrics.modelUsed ||
          this.config.plannerModelId ||
          process.env.ANTHROPIC_MODEL ||
          "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        metadata_json: {
          impactedFiles: getPlanImpactedFiles(plan),
          revision: payload.revision,
          stage_tokens_used: tokenUsage,
          tokens_used: plannerResponse.metrics.tokensUsed ?? null,
          stage_cost_usd: plannerResponse.metrics.costUsd ?? null,
          model_usage: plannerResponse.metrics.modelUsage ?? null,
          model_cost_usage: plannerResponse.metrics.modelCostUsage ?? null,
          stage_duration_ms: plannerResponse.metrics.durationMs,
          llm_tool_calls:
            plannerResponse.metrics.llmToolCalls ??
            plannerResponse.metrics.toolCalls,
          planner_attempt_timeout_ms: attemptOverrides.timeoutMs ?? null,
          planner_idle_timeout_ms: attemptOverrides.idleTimeoutMs ?? null,
          planner_scout_timeout_ms: PLANNER_SCOUT_TIMEOUT_MS,
          planner_scout_idle_timeout_ms: PLANNER_SCOUT_IDLE_TIMEOUT_MS,
          grounding_source: plannerResponse.metrics.groundingSource ?? null,
          grounding_candidate_files:
            plannerResponse.metrics.groundingCandidateFiles ?? null,
          grounding_confidence:
            plannerResponse.metrics.groundingConfidence ?? null,
          planner_scout_status:
            plannerResponse.metrics.plannerScoutStatus ?? null,
          planner_scout_reports: plannerResponse.metrics.scoutReports ?? null,
          planner_scout_coverage: plannerResponse.metrics.scoutCoverage ?? null,
          planner_subagent_attempted:
            plannerResponse.metrics.plannerSubagentAttempted ?? null,
          planner_subagent_attempt_missing:
            plannerResponse.metrics.plannerSubagentAttemptMissing ?? false,
          planner_scout_invocation_failed:
            plannerResponse.metrics.scoutInvocationFailed ?? false,
          planner_scout_returned_nothing:
            plannerResponse.metrics.scoutReturnedNothing ?? false,
          planner_proceeded_with_weak_scout:
            plannerResponse.metrics.proceededWithWeakScout ?? false,
          grounding_warnings: plannerResponse.metrics.warnings ?? [],
          read_calls: plannerResponse.metrics.readCalls ?? null,
          grep_calls: plannerResponse.metrics.grepCalls ?? null,
          glob_calls: plannerResponse.metrics.globCalls ?? null,
          effective_reads: plannerResponse.metrics.effectiveReads ?? null,
          grounding_overlap: plannerResponse.metrics.groundingOverlap ?? null,
          search_call_ratio: plannerResponse.metrics.searchCallRatio ?? null,
          repeated_search_glob_count:
            plannerResponse.metrics.repeatedSearchGlobCount ?? null,
          broad_search_count: plannerResponse.metrics.broadSearchCount ?? null,
          planner_output_sanitized:
            plannerResponse.metrics.plannerOutputSanitized ?? false,
          planner_output_truncated_chars:
            plannerResponse.metrics.plannerOutputTruncatedChars ?? 0,
          planner_output_sanitization:
            plannerResponse.metrics.plannerOutputSanitization ?? null,
          planner_source_recovery_accepted:
            plannerResponse.metrics.plannerSourceRecoveryAccepted ?? 0,
          planner_source_recovery_rejected:
            plannerResponse.metrics.plannerSourceRecoveryRejected ?? 0,
          planner_source_recovery_candidates:
            plannerResponse.metrics.plannerSourceRecoveryCandidates ?? 0,
          planner_structured_output_repair:
            plannerResponse.metrics.plannerStructuredOutputRepair ?? null,
          planner_grounding_repair_attempted:
            plannerResponse.metrics.plannerGroundingRepairAttempted ?? false,
          planner_grounding_repair_accepted:
            plannerResponse.metrics.plannerGroundingRepairAccepted ?? false,
          planner_grounding_repair_rejected:
            plannerResponse.metrics.plannerGroundingRepairRejected ?? false,
          planner_grounding_repair_mode:
            plannerResponse.metrics.plannerGroundingRepairMode ?? null,
          planner_grounding_repair_rejected_target_count:
            plannerResponse.metrics.plannerGroundingRepairRejectedTargetCount ??
            null,
          planner_grounding_repair_target_files:
            plannerResponse.metrics.plannerGroundingRepairTargetFiles ?? [],
          planner_grounding_repair_read_files:
            plannerResponse.metrics.plannerGroundingRepairReadFiles ?? [],
          planner_grounding_repair_error:
            plannerResponse.metrics.plannerGroundingRepairError ?? null,
          sdk_lifecycle_summary:
            plannerResponse.metrics.sdkLifecycleSummary ?? null,
          tool_budget_used:
            plannerResponse.metrics.sdkLifecycleSummary?.toolBudgetUsed ?? null,
          tool_budget_limit:
            plannerResponse.metrics.sdkLifecycleSummary?.toolBudgetLimit ??
            null,
          tool_budget_denials:
            plannerResponse.metrics.sdkLifecycleSummary?.toolBudgetDenials ??
            null,
          post_tool_idle_timeout_ms:
            plannerResponse.metrics.sdkLifecycleSummary
              ?.postToolIdleTimeoutMs ?? null,
          planner_diagnostic_artifacts: plannerDiagnosticArtifactKeys,
          planRiskAssessment,
          qualificationRiskAssessment,
          externalSpecEvidence,
        },
        started_at: new Date(Date.now() - plannerResponse.metrics.durationMs),
        completed_at: new Date(),
      });
      if (tokenUsage > 0) {
        await this.oneShotDb.runs.addTokenUsage(run.id, tokenUsage);
      }

      if (plannerResponse.metrics.sdkLifecycleSummary) {
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "sdk_lifecycle_observed",
            from_state: "planning",
            to_state: "planning",
            stage: "planning",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
              reason: "planner_completed",
              sdkLifecycleSummary: plannerResponse.metrics.sdkLifecycleSummary,
              plannerStructuredOutputRepair:
                plannerResponse.metrics.plannerStructuredOutputRepair ?? null,
              diagnosticArtifactKeys: plannerDiagnosticArtifactKeys,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: run.id,
              eventType: "sdk_lifecycle_observed",
              stage: "planning",
            }),
          );
      }

      await assertWorkspaceLease?.();
      const transitioned = await transitionRunWithNotification(this.db, {
        runId: run.id,
        fromState: "planning",
        toState: "queued_for_review",
        updates: {
          current_plan_version: payload.version,
          last_error: null,
        },
        notification: {
          oneshot_run_id: run.id,
          jira_key: run.jira_key,
          notification_type: "planning_completed",
          body_markdown: buildPlanningCompletedComment({
            assetBaseUrl: this.config.commentAssetBaseUrl,
            jiraKey: run.jira_key,
            plan,
          }),
        },
      });
      if (!transitioned) {
        logger.warn(
          { runId: run.id, jiraKey: run.jira_key },
          "Planner queued-for-review transition skipped because run state already moved",
        );
        return true;
      }

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "risk_classification_observed",
          from_state: "planning",
          to_state: "planning",
          stage: "planning",
          metadata_json: {
            version: payload.version,
            planRiskAssessment: {
              wouldAffectReadiness: planRiskAssessment.wouldAffectReadiness,
              blockingCandidateCount: planRiskAssessment.blockingCandidateCount,
              advisoryCount: planRiskAssessment.advisoryCount,
              categories: [
                ...new Set(
                  planRiskAssessment.findings.map(
                    (finding) => finding.category,
                  ),
                ),
              ],
            },
            qualificationRiskAssessment: {
              wouldAffectReadiness:
                qualificationRiskAssessment.wouldAffectReadiness,
              promotedWarningCount:
                qualificationRiskAssessment.promotedWarningCount,
              categories: [
                ...new Set(
                  qualificationRiskAssessment.findings.map(
                    (finding) => finding.category,
                  ),
                ),
              ],
            },
            externalSpecEvidence: {
              detectedUrls: externalSpecEvidence.urls.length,
              unavailable: externalSpecEvidence.unavailable,
              statuses: externalSpecEvidence.urls.map((entry) => ({
                url: entry.url,
                status: entry.status,
                cacheKey: entry.cacheKey,
              })),
            },
            activeReadinessCategories:
              activeReadinessCategories === "all"
                ? "all"
                : [...activeReadinessCategories],
            actualOutcome: "pending",
            humanReviewConfirmedRisk: null,
            observationWindow: {
              minimumCompletedRuns: 10,
              minimumDurationDays: 14,
              perCategoryFlip: true,
            },
            wouldAffectReadiness:
              planRiskAssessment.wouldAffectReadiness ||
              qualificationRiskAssessment.wouldAffectReadiness ||
              externalSpecEvidence.urls.length > 0 ||
              externalSpecEvidence.unavailable,
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "risk_classification_observed",
            stage: "planning",
          }),
        );

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "planning",
          to_state: "queued_for_review",
          stage: "planning",
          metadata_json: {
            version: payload.version,
            revision: payload.revision,
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "state_transition",
            stage: "planning",
          }),
        );

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          planVersion: payload.version,
        },
        "Planner queued run for review",
      );

      try {
        await assertWorkspaceLease?.();
        await this.publisher.publishStageMessage(
          run.id,
          "review",
          payload.version,
          "queued_for_review",
          false,
        );
      } catch (publishError) {
        // Compensate the earlier queued_for_review transition so the outer
        // catch's retry path (which expects current_state === 'planning')
        // can successfully requeue.
        // TODO(follow-up): replace with transactional outbox pattern so the
        // state flip and SQS publish commit atomically.
        const publishErrorMessage =
          publishError instanceof Error
            ? publishError.message
            : String(publishError);
        logger.error(
          {
            runId: run.id,
            error: publishErrorMessage,
          },
          "Failed to publish review message for oneshot plan; reverting state to planning",
        );
        const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
          run.id,
          "queued_for_review",
          "planning",
          {
            last_error: publishErrorMessage,
          },
        );
        if (reverted) {
          this.oneShotDb.events
            .createEvent({
              oneshot_run_id: run.id,
              event_type: "state_revert",
              from_state: "queued_for_review",
              to_state: "planning",
              stage: "planning",
              metadata_json: {
                reason: "publish_failed",
                publishError: publishErrorMessage,
                version: payload.version,
              },
            })
            .catch(
              eventEmitFailureLogger({
                logger,
                runId: run.id,
                eventType: "state_revert",
                stage: "planning",
              }),
            );
        } else {
          logger.warn(
            { runId: run.id, jiraKey: run.jira_key },
            "Planner state revert skipped because run state already moved",
          );
        }
        throw publishError;
      }

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      // Keep the detailed failure kind for retry/event metadata, and retain
      // a broader category for dashboards that want coarse grouping.
      const { failureKind, failureCategory } = classifyPlannerFailure(error);
      const surfacedErrorMessage =
        failureCategory === "planner_no_progress"
          ? `planner_no_progress: ${errorMessage}`
          : errorMessage;

      logger.error(
        {
          runId: run.id,
          receiveCount,
          error: errorMessage,
          failureKind,
          failureCategory,
        },
        "Planner consumer failed to process run",
      );

      await this.shortenVisibilityForRepoCacheContention(
        error,
        message,
        receiveCount,
      );

      if (isWorkspaceLeaseLossError(error)) {
        return recoverStageAfterWorkspaceLeaseLoss({
          oneShotDb: this.oneShotDb,
          logger,
          runId: run.id,
          jiraKey: run.jira_key,
          payload,
          receiveCount,
          error,
          updates: {
            planning_attempt_count: run.planning_attempt_count,
          },
          metadata: {
            planningAttemptCountReset: true,
            previousPlanningAttemptCount: run.planning_attempt_count,
          },
        });
      }

      await this.persistFailedAttemptMetrics(
        run.id,
        run.jira_key,
        payload.version,
        payload.revision,
        error,
        receiveCount,
        failureKind,
        failureCategory,
        selectedAttemptOverrides,
      );

      // Skip SQS retry for failures that are guaranteed to reproduce. The
      // failed-attempt metrics above already captured diagnostics; retrying
      // would just burn more wall time and tokens producing the same result.
      // See src/oneshot/retry-classifier.ts.
      if (isDeterministicFailure(errorMessage)) {
        logger.warn(
          {
            runId: run.id,
            receiveCount,
            failureKind,
            failureCategory,
            error: errorMessage,
          },
          "Planner failing deterministic error immediately without retry",
        );
        await this.failRun(
          run.id,
          run.jira_key,
          "run_failed",
          surfacedErrorMessage,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "planning",
            to_state: "failed",
            stage: "planning",
            metadata_json: {
              reason: "deterministic_failure",
              receiveCount,
              failureKind,
              failureCategory,
            },
          })
          .catch(() => undefined);
        return true;
      }

      if (receiveCount >= TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT) {
        await this.failRun(
          run.id,
          run.jira_key,
          "run_failed",
          surfacedErrorMessage,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "planning",
            to_state: "failed",
            stage: "planning",
            metadata_json: {
              reason: "run_failed",
              receiveCount,
              failureKind,
              failureCategory,
            },
          })
          .catch(() => undefined);
        return true;
      }

      const requeued = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        run.id,
        "planning",
        "queued_for_planning",
        {
          last_error: surfacedErrorMessage,
        },
      );
      if (!requeued) {
        logger.warn(
          { runId: run.id, jiraKey: run.jira_key, receiveCount },
          "Planner retry skipped because run state already moved",
        );
        return true;
      }

      const retryMeta = await this.shortenVisibilityForTransientRetry(message, receiveCount);

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "planning",
          to_state: "queued_for_planning",
          stage: "planning",
          metadata_json: {
            reason: "retry",
            receiveCount,
            failureKind,
            failureCategory,
            transientRetry: retryMeta,
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "state_transition",
            stage: "planning",
          }),
        );
      return false;
    } finally {
      await cleanupWorkspace?.().catch(() => undefined);
    }
  }

  private async persistPlannerValidationFailureDiagnostics(
    runId: number,
    jiraKey: string,
    version: number,
    error: unknown,
  ): Promise<PlannerDiagnosticArtifactKeys> {
    const details = plannerAttemptDetails(error);
    if (
      !details?.groundingValidation &&
      details?.structuredOutput === undefined &&
      details?.rawOutput === undefined
    ) {
      return {};
    }

    const basePlanKey = buildOneShotArtifactKey(
      this.config,
      jiraKey,
      runId,
      "plan",
      version,
    );
    const artifactBase = basePlanKey.replace(/plan\.json$/i, "");
    const artifacts: Record<string, { key: string; body: unknown }> = {
      failedOutput: {
        key: `${artifactBase}planner-failed-output.json`,
        body: {
          rawOutput: details.rawOutput ?? null,
          structuredOutput: details.structuredOutput ?? null,
          outputPreview: details.outputPreview ?? null,
          hasStructuredOutput: details.hasStructuredOutput ?? null,
          structuredOutputRepair: details.structuredOutputRepair ?? null,
          schemaValidationErrors: details.schemaValidationErrors ?? [],
          schemaValidationStage: details.schemaValidationStage ?? null,
          retrofitContractNormalization:
            details.retrofitPlanNormalization ?? null,
        },
      },
    };

    if (details.draftPlan) {
      artifacts.draftPlan = {
        key: `${artifactBase}planner-failed-draft-plan.json`,
        body: details.draftPlan ?? null,
      };
    }

    if (details.groundingValidation) {
      artifacts.groundingDiagnostics = {
        key: `${artifactBase}planner-grounding-diagnostics.json`,
        body: {
          errors:
            error instanceof PlannerGroundingValidationError
              ? error.errors
              : details.groundingValidation.errors,
          warnings: details.groundingValidation.warnings,
          decisions: details.groundingValidation.decisions,
          finalPlannerReadFiles: details.finalPlannerReadFiles ?? [],
          finalPlannerDiscoveredFiles:
            details.finalPlannerDiscoveredFiles ?? [],
          groundingEvidence: details.groundingEvidence ?? null,
          metrics: details.metrics ?? null,
          model: details.modelUsed ?? details.metrics?.modelUsed ?? null,
          toolSummary: plannerToolSummary(details.metrics),
          stopReason: null,
        },
      };
    }

    const written: Record<string, string> = {};
    for (const [name, artifact] of Object.entries(artifacts)) {
      try {
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.config.artifactBucket,
            Key: artifact.key,
            Body: JSON.stringify(artifact.body, null, 2),
            ContentType: "application/json",
          }),
        );
        written[name] = artifact.key;
      } catch (diagnosticError) {
        logger.error(
          {
            runId,
            jiraKey,
            artifactKey: artifact.key,
            error:
              diagnosticError instanceof Error
                ? diagnosticError.message
                : String(diagnosticError),
          },
          "Failed to persist planner validation diagnostic artifact",
        );
      }
    }

    if (Object.keys(written).length > 0) {
      logger.info(
        { runId, jiraKey, diagnosticArtifacts: written },
        "Persisted planner validation diagnostic artifacts",
      );
    }

    return written;
  }

  private async persistFailedAttemptMetrics(
    runId: number,
    jiraKey: string,
    version: number,
    revision: boolean,
    error: unknown,
    receiveCount: number,
    failureKind: PlannerFailureKind,
    failureCategory: PlannerFailureCategory,
    attemptOverrides?: PlannerAttemptOverrides,
  ): Promise<void> {
    const diagnosticArtifactKeys: PlannerDiagnosticArtifactKeys =
      await this.persistPlannerValidationFailureDiagnostics(
        runId,
        jiraKey,
        version,
        error,
      );
    const failureMetrics = failedPlannerMetrics(error);
    const attemptDetails = plannerAttemptDetails(error);
    const schemaValidationErrors =
      attemptDetails?.schemaValidationErrors ?? [];
    const schemaValidationPaths = schemaValidationErrors
      .slice(0, 5)
      .map((issue) => issue.path);
    if (!failureMetrics) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      try {
        await this.oneShotDb.events.createEvent({
          oneshot_run_id: runId,
          event_type: "stage_attempt_metrics",
          stage: "planning",
          metadata_json: {
            reason: "planner_failed_attempt",
            receiveCount,
            failureKind,
            failureCategory,
            version,
            revision,
            provider: "anthropic",
            stage_tokens_used: 0,
            stage_cost_usd: null,
            stage_duration_ms: null,
            llm_tool_calls: null,
            planner_attempt_timeout_ms: attemptOverrides?.timeoutMs ?? null,
            planner_idle_timeout_ms: attemptOverrides?.idleTimeoutMs ?? null,
            planner_scout_timeout_ms: PLANNER_SCOUT_TIMEOUT_MS,
            planner_scout_idle_timeout_ms: PLANNER_SCOUT_IDLE_TIMEOUT_MS,
            schema_validation_errors: schemaValidationErrors.slice(0, 5),
            schema_validation_paths: schemaValidationPaths,
            schema_validation_stage:
              attemptDetails?.schemaValidationStage ?? null,
            retrofit_contract_normalization:
              attemptDetails?.retrofitPlanNormalization ?? null,
            error: errorMessage.slice(0, 2000),
            planner_diagnostic_artifacts: diagnosticArtifactKeys,
          },
        });
      } catch (metricsError) {
        logger.error(
          {
            runId,
            error:
              metricsError instanceof Error
                ? metricsError.message
                : String(metricsError),
          },
          "Failed to persist planner failed-attempt metrics",
        );
      }
      return;
    }

    const { metrics } = failureMetrics;
    if (metrics.sdkLifecycleSummary) {
      const messageSummaryArtifactKey = `${this.config.artifactPrefix}/${jiraKey}/run-${runId}/plans/v${version}/sdk-message-summary-attempt-${receiveCount}.json`;
      const lifecycle = metrics.sdkLifecycleSummary;
      const persistedMessageSummaryKey =
        await this.persistPlannerDiagnosticArtifact({
          runId,
          jiraKey,
          key: messageSummaryArtifactKey,
          body: {
            messageTypeCounts: lifecycle.messageTypeCounts,
            systemSubtypeCounts: lifecycle.systemSubtypeCounts,
            hookEventCounts: lifecycle.hookEventCounts,
            apiRetryCount: lifecycle.apiRetryCount,
            rateLimitCount: lifecycle.rateLimitCount,
            compactBoundaryCount: lifecycle.compactBoundaryCount,
          },
          warningTag: "sdk_message_summary_artifact_failed",
          metrics,
          logMessage:
            "Failed to persist planner SDK message summary artifact; continuing",
        });
      if (persistedMessageSummaryKey) {
        diagnosticArtifactKeys.sdkMessageSummary = persistedMessageSummaryKey;
      }
    }
    if (metrics.sdkRawTrace?.length) {
      const rawTraceArtifactKey = `${this.config.artifactPrefix}/${jiraKey}/run-${runId}/plans/v${version}/sdk-raw-trace-attempt-${receiveCount}.json`;
      const persistedRawTraceKey = await this.persistPlannerDiagnosticArtifact({
        runId,
        jiraKey,
        key: rawTraceArtifactKey,
        body: metrics.sdkRawTrace,
        warningTag: "sdk_raw_trace_artifact_failed",
        metrics,
        logMessage:
          "Failed to persist planner SDK raw trace artifact; continuing",
      });
      if (persistedRawTraceKey) {
        diagnosticArtifactKeys.rawTrace = persistedRawTraceKey;
      }
    }
    const tokenUsage = calculateTokenUsage(metrics);
    recordLlmMetrics(
      "planning",
      "anthropic",
      metrics.durationMs,
      metrics.tokensUsed,
      metrics.costUsd,
      {
        model: failureMetrics.model,
        groundingConfidence: failureMetrics.groundingConfidence ?? "unknown",
        failureKind,
        failureCategory,
        outcome: "failed",
        effectiveReads: metrics.effectiveReads ?? 0,
        groundingOverlap: metrics.groundingOverlap ?? 0,
        searchCallRatio: metrics.searchCallRatio ?? 0,
        plannerSourceRecoveryAccepted:
          metrics.plannerSourceRecoveryAccepted ?? 0,
        plannerSourceRecoveryRejected:
          metrics.plannerSourceRecoveryRejected ?? 0,
        plannerScoutStatus:
          metrics.plannerScoutStatus ??
          failureMetrics.plannerScoutStatus ??
          "unknown",
        scoutInvocationFailed: metrics.scoutInvocationFailed ?? false,
        scoutReturnedNothing: metrics.scoutReturnedNothing ?? false,
        proceededWithWeakScout: metrics.proceededWithWeakScout ?? false,
      },
    );

    try {
      if (tokenUsage > 0) {
        await this.oneShotDb.runs.addTokenUsage(runId, tokenUsage);
      }
      await this.oneShotDb.events.createEvent({
        oneshot_run_id: runId,
        event_type: "stage_attempt_metrics",
        stage: "planning",
        metadata_json: {
          reason: "planner_failed_attempt",
          receiveCount,
          failureKind,
          failureCategory,
          version,
          revision,
          provider: "anthropic",
          model: failureMetrics.model,
          stage_tokens_used: tokenUsage,
          tokens_used: metrics.tokensUsed ?? null,
          stage_cost_usd: metrics.costUsd ?? null,
          model_usage: metrics.modelUsage ?? null,
          model_cost_usage: metrics.modelCostUsage ?? null,
          stage_duration_ms: metrics.durationMs,
          llm_tool_calls: metrics.llmToolCalls ?? metrics.toolCalls,
          planner_attempt_timeout_ms: attemptOverrides?.timeoutMs ?? null,
          planner_idle_timeout_ms: attemptOverrides?.idleTimeoutMs ?? null,
          planner_scout_timeout_ms: PLANNER_SCOUT_TIMEOUT_MS,
          planner_scout_idle_timeout_ms: PLANNER_SCOUT_IDLE_TIMEOUT_MS,
          schema_validation_errors: schemaValidationErrors.slice(0, 5),
          schema_validation_paths: schemaValidationPaths,
          schema_validation_stage:
            attemptDetails?.schemaValidationStage ?? null,
          retrofit_contract_normalization:
            attemptDetails?.retrofitPlanNormalization ?? null,
          grounding_confidence: failureMetrics.groundingConfidence,
          grounding_candidate_files: failureMetrics.groundingCandidateFiles,
          planner_scout_status:
            metrics.plannerScoutStatus ?? failureMetrics.plannerScoutStatus,
          planner_scout_coverage: metrics.scoutCoverage ?? null,
          planner_subagent_attempted:
            metrics.plannerSubagentAttempted ?? null,
          planner_subagent_attempt_missing:
            metrics.plannerSubagentAttemptMissing ?? false,
          planner_scout_invocation_failed:
            metrics.scoutInvocationFailed ?? false,
          planner_scout_returned_nothing: metrics.scoutReturnedNothing ?? false,
          planner_proceeded_with_weak_scout:
            metrics.proceededWithWeakScout ?? false,
          has_structured_output: failureMetrics.hasStructuredOutput,
          output_preview: failureMetrics.outputPreview,
          read_calls: metrics.readCalls ?? null,
          grep_calls: metrics.grepCalls ?? null,
          glob_calls: metrics.globCalls ?? null,
          effective_reads: metrics.effectiveReads ?? null,
          grounding_overlap: metrics.groundingOverlap ?? null,
          search_call_ratio: metrics.searchCallRatio ?? null,
          repeated_search_glob_count: metrics.repeatedSearchGlobCount ?? null,
          broad_search_count: metrics.broadSearchCount ?? null,
          planner_output_sanitized: metrics.plannerOutputSanitized ?? false,
          planner_output_truncated_chars:
            metrics.plannerOutputTruncatedChars ?? 0,
          planner_output_sanitization:
            metrics.plannerOutputSanitization ?? null,
          planner_source_recovery_accepted:
            metrics.plannerSourceRecoveryAccepted ?? 0,
          planner_source_recovery_rejected:
            metrics.plannerSourceRecoveryRejected ?? 0,
          planner_source_recovery_candidates:
            metrics.plannerSourceRecoveryCandidates ?? 0,
          planner_structured_output_repair:
            failureMetrics.structuredOutputRepair ?? null,
          planner_grounding_repair_attempted:
            metrics.plannerGroundingRepairAttempted ?? false,
          planner_grounding_repair_accepted:
            metrics.plannerGroundingRepairAccepted ?? false,
          planner_grounding_repair_rejected:
            metrics.plannerGroundingRepairRejected ?? false,
          planner_grounding_repair_mode:
            metrics.plannerGroundingRepairMode ?? null,
          planner_grounding_repair_rejected_target_count:
            metrics.plannerGroundingRepairRejectedTargetCount ?? null,
          planner_grounding_repair_target_files:
            metrics.plannerGroundingRepairTargetFiles ?? [],
          planner_grounding_repair_read_files:
            metrics.plannerGroundingRepairReadFiles ?? [],
          planner_grounding_repair_error:
            metrics.plannerGroundingRepairError ?? null,
          sdk_lifecycle_summary: metrics.sdkLifecycleSummary ?? null,
          tool_budget_used: metrics.sdkLifecycleSummary?.toolBudgetUsed ?? null,
          tool_budget_limit:
            metrics.sdkLifecycleSummary?.toolBudgetLimit ?? null,
          tool_budget_denials:
            metrics.sdkLifecycleSummary?.toolBudgetDenials ?? null,
          post_tool_idle_timeout_ms:
            metrics.sdkLifecycleSummary?.postToolIdleTimeoutMs ?? null,
          api_retry_count: metrics.sdkLifecycleSummary?.apiRetryCount ?? null,
          rate_limit_count: metrics.sdkLifecycleSummary?.rateLimitCount ?? null,
          compaction_count:
            metrics.sdkLifecycleSummary?.compactBoundaryCount ?? null,
          compaction_duration_ms:
            metrics.sdkLifecycleSummary?.compactDurationMs ?? null,
          permission_denial_count:
            metrics.sdkLifecycleSummary?.permissionDenials?.length ?? null,
          subagent_count:
            (metrics.sdkLifecycleSummary?.subagentStartCount ?? 0) +
            (metrics.sdkLifecycleSummary?.taskStartedCount ?? 0),
          planner_diagnostic_artifacts: diagnosticArtifactKeys,
        },
      });
      if (metrics.sdkLifecycleSummary) {
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: runId,
            event_type: "sdk_lifecycle_observed",
            stage: "planning",
            metadata_json: {
              reason: "planner_failed_attempt",
              receiveCount,
              failureKind,
              failureCategory,
              version,
              revision,
              sdkLifecycleSummary: metrics.sdkLifecycleSummary,
              plannerStructuredOutputRepair:
                failureMetrics.structuredOutputRepair ?? null,
              diagnosticArtifactKeys,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId,
              eventType: "sdk_lifecycle_observed",
              stage: "planning",
            }),
          );
      }
    } catch (metricsError) {
      logger.error(
        {
          runId,
          error:
            metricsError instanceof Error
              ? metricsError.message
              : String(metricsError),
        },
        "Failed to persist planner failed-attempt metrics",
      );
    }
  }

  private parsePlanWithDiagnostics(
    rawPlan: unknown,
    runId: number,
    jiraKey: string,
  ): OneShotPlan {
    try {
      const sanitized = sanitizePlannerDiscoveries(rawPlan);
      return parseOneShotPlan(sanitized.value);
    } catch (error) {
      if (error instanceof ZodError) {
        const serialized = JSON.stringify(rawPlan) ?? String(rawPlan);
        logger.error(
          {
            runId,
            jiraKey,
            topLevelKeys:
              rawPlan && typeof rawPlan === "object"
                ? Object.keys(rawPlan as Record<string, unknown>)
                : null,
            rawPayloadType: typeof rawPlan,
            rawPayloadLength: serialized.length,
            rawPayloadPreview: serialized.slice(0, 2000),
            zodIssues: error.issues,
          },
          "Planner SDK output failed schema validation",
        );
        (error as PlannerErrorWithAttemptDetails).plannerAttemptDetails = {
          hasStructuredOutput: rawPlan !== undefined,
          structuredOutput: rawPlan,
          outputPreview: serialized.slice(0, 2000),
        };
      }
      throw error;
    }
  }

  private async loadQualificationArtifact(
    runId: number,
  ): Promise<QualificationArtifact> {
    const artifact = await this.oneShotDb.artifacts.getLatestArtifact(
      runId,
      "qualification",
    );
    if (!artifact) {
      throw new Error(
        `Missing qualification artifact for oneshot run ${runId}`,
      );
    }

    const response = await this.s3Client.send(
      new GetObjectCommand({
        Bucket: artifact.s3_bucket,
        Key: artifact.s3_key,
      }),
    );

    if (!response.Body) {
      throw new Error(
        `Empty qualification artifact body for oneshot run ${runId}`,
      );
    }

    return JSON.parse(
      await response.Body.transformToString(),
    ) as QualificationArtifact;
  }

  private async loadTicketEvidence(
    ref: TicketEvidenceRef | null | undefined,
    runId: number,
    jiraKey: string,
  ): Promise<TicketEvidenceV1 | null> {
    if (!ref?.bucket || !ref.key) {
      return null;
    }

    try {
      const response = await this.s3Client.send(
        new GetObjectCommand({
          Bucket: ref.bucket,
          Key: ref.key,
        }),
      );

      if (!response.Body) {
        logger.warn(
          {
            runId,
            jiraKey,
            bucket: ref.bucket,
            key: ref.key,
          },
          "Ticket evidence object is empty; continuing with legacy planner inputs",
        );
        return null;
      }

      const parsed = JSON.parse(
        await response.Body.transformToString(),
      ) as TicketEvidenceV1;
      if (
        parsed.schemaVersion !== TICKET_EVIDENCE_SCHEMA_VERSION ||
        parsed.jiraKey !== jiraKey
      ) {
        logger.warn(
          {
            runId,
            jiraKey,
            bucket: ref.bucket,
            key: ref.key,
            schemaVersion: parsed.schemaVersion,
            evidenceJiraKey: parsed.jiraKey,
          },
          "Ticket evidence object did not match this run; continuing with legacy planner inputs",
        );
        return null;
      }

      return parsed;
    } catch (error) {
      logger.warn(
        {
          runId,
          jiraKey,
          bucket: ref.bucket,
          key: ref.key,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to load ticket evidence; continuing with legacy planner inputs",
      );
      return null;
    }
  }

  private async loadPriorPlannerDiagnostics(
    runId: number,
    jiraKey: string,
    events: OneShotRunEvent[],
  ): Promise<PlannerPriorDiagnosticInput[]> {
    const diagnosticInputs: PlannerPriorDiagnosticInput[] = [];
    const seen = new Set<string>();
    const planningFailures = [...events]
      .reverse()
      .filter(
        (event) =>
          event.stage === "planning" &&
          event.metadata_json?.reason === "planner_failed_attempt",
      );

    for (const event of planningFailures) {
      const keys = diagnosticArtifactKeysFromEvent(event);
      for (const [kind, key] of Object.entries(keys)) {
        if (!key || seen.has(key)) {
          continue;
        }
        seen.add(key);
        try {
          const body = await this.readArtifactJson<unknown>(
            this.config.artifactBucket,
            key,
          );
          diagnosticInputs.push({
            key,
            kind,
            body: compactPlannerDiagnosticBody(body),
          });
        } catch (error) {
          logger.warn(
            {
              runId,
              jiraKey,
              diagnosticKey: key,
              error: error instanceof Error ? error.message : String(error),
            },
            "Failed to load prior planner diagnostic artifact; continuing without it",
          );
        }
        if (diagnosticInputs.length >= 4) {
          return diagnosticInputs;
        }
      }
    }

    return diagnosticInputs;
  }

  private async loadRevisionContext(
    runId: number,
  ): Promise<PlannerRevisionContext> {
    const latestPlanArtifact = await this.oneShotDb.artifacts.getLatestArtifact(
      runId,
      "plan",
    );
    const latestReviewArtifact =
      await this.oneShotDb.artifacts.getLatestArtifact(runId, "review");

    const previousPlan = latestPlanArtifact
      ? await this.readArtifactJson(
          latestPlanArtifact.s3_bucket,
          latestPlanArtifact.s3_key,
          parseOneShotPlan,
        )
      : undefined;
    const previousReview = latestReviewArtifact
      ? await this.readArtifactJson<Record<string, unknown>>(
          latestReviewArtifact.s3_bucket,
          latestReviewArtifact.s3_key,
        )
      : null;

    return {
      previousPlan,
      previousReview,
    };
  }

  private async loadGitHubCommandContext(
    run: OneShotRun,
    requestedPlanVersion: number,
  ): Promise<string> {
    if (!run.current_pr_url) {
      return "";
    }

    const commands = await this.oneShotDb.githubCommands.getCommandsForPlanning({
      oneshotRunId: run.id,
      requestedPlanVersion,
    });
    if (commands.length === 0) {
      return "";
    }

    let evidence = null;
    if (run.current_implementation_commit_sha) {
      try {
        const pr = parseGitHubPullRequestUrl(run.current_pr_url);
        evidence = await fetchPullRequestCommandEvidence({
          owner: pr.owner,
          repo: pr.repo,
          pullNumber: pr.pullNumber,
          ref: run.current_implementation_commit_sha,
        });
      } catch (error) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            currentPrUrl: run.current_pr_url,
            error: error instanceof Error ? error.message : String(error),
          },
          "Failed to load GitHub PR check evidence for /oneshot planning context",
        );
      }
    }

    return formatGitHubCommandContextForPlanner({
      pullRequest: {
        url: run.current_pr_url,
        headSha: run.current_implementation_commit_sha,
        headRef: run.current_implementation_branch,
      },
      commands: commands.map((command) => ({
        requesterLogin: command.requesterLogin,
        commandText: command.commandText,
        createdAt: command.createdAt,
      })),
      evidence,
    });
  }

  private async readArtifactJson<T>(
    bucket: string,
    key: string,
    validator?: (value: unknown) => T,
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

    const raw = await response.Body.transformToString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(
        `Corrupted artifact JSON at ${bucket}/${key} (${raw.length} bytes, starts with: ${raw.slice(0, 100)})`,
      );
    }
    if (validator) {
      try {
        return validator(parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Artifact at ${bucket}/${key} failed schema validation: ${msg}`,
        );
      }
    }
    return parsed as T;
  }

  private async failRun(
    runId: number,
    jiraKey: string,
    notificationType: "run_failed" | "budget_exceeded",
    errorMessage: string,
  ): Promise<void> {
    const transitioned = await transitionRunWithNotification(this.db, {
      runId,
      fromState: "planning",
      toState: "failed",
      updates: {
        last_error: errorMessage,
        final_disposition: notificationType,
      },
      notification: {
        oneshot_run_id: runId,
        jira_key: jiraKey,
        notification_type: notificationType,
        body_markdown:
          notificationType === "budget_exceeded"
            ? buildBudgetExceededComment({
                assetBaseUrl: this.config.commentAssetBaseUrl,
                jiraKey,
                stageLabel: "Planning",
                errorMessage,
              })
            : buildRunFailedComment({
                assetBaseUrl: this.config.commentAssetBaseUrl,
                jiraKey,
                stageLabel: "Planning",
                errorMessage,
              }),
      },
      postmortemContext: buildPostmortemContext({
        s3Client: this.s3Client,
        artifactBucket: this.config.artifactBucket,
        artifactPrefix: this.config.artifactPrefix,
        jiraKey,
        failedStage: "planning",
      }),
      workspaceCleanupContext: {
        repoAdminBasePath: this.config.repoAdminBasePath,
        repoCacheBasePath: this.config.repoCacheBasePath,
        workspaceBasePath: this.config.workspaceBasePath,
        worktreeBasePath: this.config.worktreeBasePath,
      },
    });
    if (!transitioned) {
      logger.warn(
        { runId, jiraKey, notificationType },
        "Planner failRun skipped because run state already moved",
      );
    }
  }
}
