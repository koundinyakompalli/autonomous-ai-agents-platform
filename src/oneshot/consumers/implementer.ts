import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, type Message } from "@aws-sdk/client-sqs";
import * as path from "path";
import { ZodError } from "zod";
import { getDatabase, type Database } from "../../orchestrator/database.js";
import { createS3Client } from "../../utils/awsClients.js";
import { createLogger } from "../../utils/logger.js";
import { QueueConsumerBase } from "../consumer-base.js";
import {
  buildOneShotArtifactKey,
  getOneShotConsumerConfig,
  type OneShotConsumerConfig,
} from "../config.js";
import {
  normalizeJiraLabels,
  parseOneShotQueueMessage,
  PFOS_LABEL,
  SONAR_AUTOFIX_LABEL,
} from "../contracts.js";
import { OneShotDatabase } from "../database/index.js";
import {
  branchExistsOnRemote,
  commitAllChanges,
  getCurrentHeadSha,
  getRemoteBranchHead,
  isAncestor,
  listChangedFiles,
  pushBranch,
  runGitCommand,
  exportSourceCommitPatch,
  isPatchAlreadyApplied,
  isPatchApplicable,
  applyPatch,
} from "../git.js";
import {
  cleanGeneratedBranchChanges,
  checkSecurityRemediationScope,
  isBlockedGeneratedPath,
  type BranchHygieneSummary,
} from "../branch-hygiene.js";
import { OneShotPublisher } from "../publisher.js";
import {
  getVisibilityTimeoutFromEnv,
  TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT,
} from "../consumer-visibility.js";
import {
  parseOneShotImplementation,
  type OneShotImplementation,
} from "../schema/implementation.js";
import {
  getPlanImpactedFiles,
  parseOneShotPlan,
  type OneShotPlan,
} from "../schema/plan.js";
import { parseOneShotTraceArtifact } from "../schema/trace-verify.js";
import {
  parseOneShotCodeReview,
  type OneShotCodeReview,
} from "../schema/code-review.js";
import {
  parseOneShotTestResult,
  type OneShotTestResult,
} from "../schema/test-result.js";
import { PromptComposer } from "../prompt-composer.js";
import { createPromptLoader } from "../prompt-loader.js";
import {
  renderOneShotImplementationMarkdown,
  renderOneShotPlanMarkdown,
} from "../renderers.js";
import {
  createLeasedOneShotWorkspaceManager,
  OneShotWorkspaceManager,
} from "../workspaces.js";
import {
  isWorkspaceCheckoutTimeoutError,
  isWorkspaceLeaseLossError,
  recoverStageAfterWorkspaceLeaseLoss,
  WorkspaceLeaseLostError,
} from "../workspace-lease-errors.js";
import {
  materializeRunArtifacts,
  type WorkspaceArtifactFile,
} from "../workspace-artifacts.js";
import {
  ClaudeImplementerProvider,
  ImplementerStallError,
  type ImplementerResponse,
  type ImplementerRevisionContext,
} from "../providers/claude-implementer.js";
import {
  buildPostmortemContext,
  transitionRunWithNotification,
} from "../state-transitions.js";
import { recordLlmMetrics } from "../telemetry/metrics.js";
import {
  buildBudgetExceededComment,
  buildImplementationCompletedComment,
  buildRunFailedComment,
  type RetrofitTraceabilityComment,
} from "../jira-comments.js";
import { ensureDraftPullRequest, parseGitHubRepoUrl } from "../github.js";
import { loadRunTicketSummary } from "../qualification-artifact.js";
import {
  resolveOneShotProcessingMode,
  type OneShotProcessingMode,
} from "../processing-mode.js";
import {
  validateImplementedFilesAgainstPlanContract,
  type ImplementationFileContractResult,
} from "../plan-contract.js";
import {
  parsePlannerRetrofitContext,
  type PlannerRetrofitContext,
} from "../retrofit-context.js";
import {
  deriveRetrofitAllowedFiles,
  hasRetrofitAdaptationCoverage,
  parseRetrofitAdaptationCoverage,
  parseRetrofitSourceCommitStatuses,
  parseRetrofitSourceEvidence,
  type RetrofitAdaptationCoverageEntry,
  type RetrofitCommitManifest,
  type RetrofitCommitManifestEntry,
  type RetrofitSourceCommitStatus,
  type RetrofitSourceEvidence,
} from "../retrofit-source-evidence.js";
import {
  buildRetrofitExecutionContractFromEvidence,
  deriveRetrofitAllowedFilesFromExecutionContract,
  mergeRetrofitExecutionContractWithStatuses,
  parseRetrofitExecutionContract,
  validateRetrofitExecutionContractForPlan,
  type RetrofitExecutionContractV1,
} from "../retrofit-execution-contract.js";
import {
  validateRetrofitCoverage,
  validateRetrofitFileScope,
} from "./reviewer.js";
import { buildOneShotPullRequestTitle } from "../pr-title.js";
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
import { eventEmitFailureLogger } from "../event-emit.js";
import { ensureRunBranchContract } from "../run-branch-contract.js";
import type { OneShotRun } from "../types.js";
import type { OneShotRunEvent } from "../database/events.js";

const logger = createLogger("oneshot-implementer-consumer");

const PROJECTED_STAGE_TOKENS = 500_000; // implementer (120 turns x many tool calls + output)
const PLAN_CONTRACT_AUTO_REPLAN_MAX_ATTEMPTS = 2;
const RETROFIT_PATCH_AUTO_REPLAN_MAX_ATTEMPTS = 2;

function planContractAutoReplanEventKey(
  metadata: Record<string, unknown> | null,
): string | null {
  if (!metadata) {
    return null;
  }
  const dedupeToken = metadata.dedupeToken;
  if (typeof dedupeToken === "string" && dedupeToken.trim()) {
    return dedupeToken.trim();
  }
  const version = metadata.version;
  const nextPlanVersion = metadata.nextPlanVersion;
  if (typeof version === "number" && typeof nextPlanVersion === "number") {
    return `${version}:${nextPlanVersion}`;
  }
  return null;
}

function countPlanContractAutoReplans(events: readonly OneShotRunEvent[]): number {
  const revertedAutoReplans = new Set(
    events
      .filter(
        (event) =>
          event.event_type === "state_revert" &&
          event.stage === "implementation" &&
          event.metadata_json?.originalReason ===
            "plan_contract_violation_auto_replan",
      )
      .map((event) => planContractAutoReplanEventKey(event.metadata_json))
      .filter((key): key is string => Boolean(key)),
  );
  return events.filter((event) => {
    if (
      event.event_type === "state_transition" &&
      event.stage === "implementation" &&
      event.metadata_json?.reason === "plan_contract_violation_auto_replan"
    ) {
      const key = planContractAutoReplanEventKey(event.metadata_json);
      return !key || !revertedAutoReplans.has(key);
    }
    return false;
  }).length;
}

function countRetrofitPatchAutoReplans(events: readonly OneShotRunEvent[]): number {
  const revertedAutoReplans = new Set(
    events
      .filter(
        (event) =>
          event.event_type === "state_revert" &&
          event.stage === "implementation" &&
          event.metadata_json?.originalReason ===
            "retrofit_patch_incomplete_auto_replan",
      )
      .map((event) => planContractAutoReplanEventKey(event.metadata_json))
      .filter((key): key is string => Boolean(key)),
  );
  return events.filter((event) => {
    if (
      event.event_type === "state_transition" &&
      event.stage === "implementation" &&
      event.metadata_json?.reason === "retrofit_patch_incomplete_auto_replan"
    ) {
      const key = planContractAutoReplanEventKey(event.metadata_json);
      return !key || !revertedAutoReplans.has(key);
    }
    return false;
  }).length;
}

function normalizeStringList(values: readonly string[] | undefined): string[] {
  const output: string[] = [];
  for (const value of values ?? []) {
    const trimmed = value.trim();
    if (trimmed && !output.includes(trimmed)) {
      output.push(trimmed);
    }
  }
  return output;
}

function mergeProviderRetrofitStatus(
  entry: RetrofitCommitManifestEntry,
  status: RetrofitSourceCommitStatus | undefined,
): void {
  if (!status || status.sourceSha.trim() !== entry.sha) {
    return;
  }
  entry.sourceFiles = normalizeStringList(status.sourceFiles);
  entry.targetFiles = normalizeStringList(status.targetFiles);
  entry.adaptationFiles = normalizeStringList(status.adaptationFiles);
  entry.proofSnippets = normalizeStringList(status.proofSnippets);
  entry.validationEvidence = normalizeStringList(status.validationEvidence);
  entry.conflictDiagnostics = status.conflictDiagnostics?.trim() || entry.conflictDiagnostics;
  entry.rationale = status.rationale?.trim() || entry.rationale;
  if (status.status === "excluded" && status.rationale?.trim()) {
    entry.status = "excluded";
    entry.excludedRationale = status.rationale.trim();
  }
}

function isAcceptedRetrofitSourceStatus(
  status: RetrofitSourceCommitStatus | undefined,
): status is RetrofitSourceCommitStatus {
  if (!status) {
    return false;
  }
  switch (status.status) {
    case "already_applied":
    case "clean_applied":
    case "adapted":
      return true;
    case "excluded":
      return Boolean(status.rationale?.trim());
    default:
      return false;
  }
}

function applyRetrofitSourceStatusToManifestEntry(
  entry: RetrofitCommitManifestEntry,
  status: RetrofitSourceCommitStatus,
): void {
  mergeProviderRetrofitStatus(entry, status);
  entry.status = status.status;
  if (status.status === "excluded" && status.rationale?.trim()) {
    entry.excludedRationale = status.rationale.trim();
  }
}

function entryHasStructuredAdaptationProof(
  entry: RetrofitCommitManifestEntry,
): boolean {
  const mappedFiles = [
    ...normalizeStringList(entry.targetFiles),
    ...normalizeStringList(entry.adaptationFiles),
  ];
  const evidence = [
    ...normalizeStringList(entry.proofSnippets),
    ...normalizeStringList(entry.validationEvidence),
    ...(entry.rationale?.trim() ? [entry.rationale.trim()] : []),
  ];
  return mappedFiles.length > 0 && evidence.length > 0;
}

function entryHasCarriedForwardProof(
  entry: RetrofitCommitManifestEntry,
): boolean {
  if (entry.status === "excluded") {
    return Boolean(entry.excludedRationale?.trim() || entry.rationale?.trim());
  }
  if (entry.status === "adapted") {
    return entryHasStructuredAdaptationProof(entry);
  }
  const files = [
    ...normalizeStringList(entry.sourceFiles ?? entry.files),
    ...normalizeStringList(entry.targetFiles),
    ...normalizeStringList(entry.adaptationFiles),
  ];
  return files.length > 0;
}

function buildRetrofitSourceStatusFromManifestEntry(
  entry: RetrofitCommitManifestEntry,
): RetrofitSourceCommitStatus {
  const status = entry.status === "not_attempted" ? "failed" : entry.status;
  return {
    sourceSha: entry.sha,
    status,
    sourceFiles: normalizeStringList(entry.sourceFiles ?? entry.files),
    targetFiles: normalizeStringList(entry.targetFiles),
    adaptationFiles: normalizeStringList(entry.adaptationFiles),
    conflictDiagnostics: entry.conflictDiagnostics,
    proofSnippets: normalizeStringList(entry.proofSnippets),
    validationEvidence: normalizeStringList(entry.validationEvidence),
    rationale: entry.rationale ?? entry.excludedRationale,
  };
}

function proofMentionsTouchedFile(
  entry: RetrofitCommitManifestEntry,
  touchedFile: string,
): boolean {
  const fileName = path.basename(touchedFile);
  const extension = path.extname(fileName);
  const fileStem = extension ? fileName.slice(0, -extension.length) : fileName;
  const evidence = [
    ...normalizeStringList(entry.proofSnippets),
    ...normalizeStringList(entry.validationEvidence),
    entry.rationale ?? "",
    entry.excludedRationale ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return (
    evidence.includes(touchedFile.toLowerCase()) ||
    (fileName.length > 0 && evidence.includes(fileName.toLowerCase())) ||
    (fileStem.length > 0 && evidence.includes(fileStem.toLowerCase()))
  );
}

function validatePriorAcceptedRetrofitRevisionProof(input: {
  manifest: RetrofitCommitManifest;
  sourceShasWithPriorAcceptedProof: ReadonlySet<string>;
  changedFiles: readonly string[];
}): string[] {
  if (input.sourceShasWithPriorAcceptedProof.size === 0) {
    return [];
  }
  const changed = new Set(input.changedFiles.map((file) => file.trim()));
  const violations: string[] = [];

  for (const sourceSha of input.sourceShasWithPriorAcceptedProof) {
    const entry = input.manifest.entries.find(
      (candidate) => candidate.sha === sourceSha,
    );
    if (!entry) {
      violations.push(
        `retrofit_revision_proof_regressed: Prior accepted source commit ${sourceSha} was not present in the revision manifest.`,
      );
      continue;
    }
    if (!isAcceptedRetrofitSourceStatus(buildRetrofitSourceStatusFromManifestEntry(entry))) {
      violations.push(
        `retrofit_revision_proof_regressed: Prior accepted source commit ${sourceSha} was downgraded to status=${entry.status} during the revision.`,
      );
      continue;
    }

    const proofFiles = normalizeStringList([
      ...(entry.targetFiles ?? []),
      ...(entry.adaptationFiles ?? []),
    ]);
    const touchedProofFiles = proofFiles.filter((file) => changed.has(file));
    if (touchedProofFiles.length === 0) {
      continue;
    }

    const unconfirmedTouchedFiles = touchedProofFiles.filter(
      (file) => !proofMentionsTouchedFile(entry, file),
    );
    if (unconfirmedTouchedFiles.length > 0) {
      violations.push(
        `retrofit_revision_proof_regressed: Revision changed previously proven file(s) ${unconfirmedTouchedFiles.join(", ")} for source commit ${sourceSha}, but the carried-forward proof does not mention the touched file(s). The revision must preserve or update source proof for touched target/adaptation files.`,
      );
    }
  }

  return violations;
}

interface ImplementerConsumerDeps {
  config?: OneShotConsumerConfig;
  db?: Database;
  sqsClient?: SQSClient;
  s3Client?: S3Client;
  publisher?: OneShotPublisher;
  workspaceManager?: OneShotWorkspaceManager;
  promptComposer?: PromptComposer;
  implementerProvider?: ClaudeImplementerProvider;
}

interface QualificationArtifactSummary {
  ticketSummary?: string;
  /** Jira labels stored by TRIAGE alongside the task description. */
  jiraLabels?: string[];
  processingMode?: OneShotProcessingMode;
  /** Carries retrofitContext + retrofitSourceEvidence (same shape the planner uses). */
  repoSelectionMetadata?: Record<string, unknown> | null;
}

type ImplementerFailureKind =
  | "idle_timeout"
  | "tool_stall"
  | "wall_timeout"
  | "turn_limit"
  | "workspace_checkout_timeout"
  | "implementation_validation"
  | "other";

type ImplementerFailureCategory =
  | "model_stall"
  | "wall_timeout"
  | "turn_limit"
  | "workspace"
  | "implementation_validation"
  | "other";

export function classifyImplementerFailure(error: unknown): {
  failureKind: ImplementerFailureKind;
  failureCategory: ImplementerFailureCategory;
} {
  if (isWorkspaceCheckoutTimeoutError(error)) {
    return {
      failureKind: "workspace_checkout_timeout",
      failureCategory: "workspace",
    };
  }

  if (error instanceof ImplementerStallError) {
    switch (error.failureKind) {
      case "idle_timeout":
      case "tool_stall":
        return {
          failureKind: error.failureKind,
          failureCategory: "model_stall",
        };
      case "wall_timeout":
        return {
          failureKind: "wall_timeout",
          failureCategory: "wall_timeout",
        };
      case "turn_limit":
        return {
          failureKind: "turn_limit",
          failureCategory: "turn_limit",
        };
      default:
        return { failureKind: "other", failureCategory: "other" };
    }
  }

  if (error instanceof ZodError) {
    return {
      failureKind: "implementation_validation",
      failureCategory: "implementation_validation",
    };
  }

  return { failureKind: "other", failureCategory: "other" };
}

// Budget-facing token total. See note in planner.ts:calculateTokenUsage —
// counts only input + output to avoid overstating spend when prompt caching
// is working well.
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

function buildRevisionDiagnostics(
  revisionContext: ImplementerRevisionContext | undefined,
  response: ImplementerResponse,
): Record<string, unknown> {
  const codeReview = revisionContext?.codeReviewFindings;
  const testFailures = revisionContext?.testFailures;
  return {
    sessionId: response.sessionId ?? null,
    resumedFromSessionId: response.resumedFromSessionId ?? null,
    resumeMode: response.resumeMode ?? null,
    resumeAttempted: response.resumeAttempted ?? false,
    resumeSucceeded: response.resumeSucceeded ?? false,
    codeReviewDecision: codeReview?.decision ?? null,
    codeReviewFindingCount: codeReview?.findings.length ?? 0,
    requiredChangeCount: codeReview?.requiredChanges.length ?? 0,
    blockingFindingCount: codeReview?.blockingFindings.length ?? 0,
    validationRetryRequested:
      revisionContext?.validationRetryRequested ?? false,
    testExecutionKind: testFailures?.executionKind ?? null,
    testFailCount: testFailures?.failCount ?? 0,
    failedValidationCheckCount:
      testFailures?.executedValidationChecks?.filter((check) => !check.passed)
        .length ?? 0,
  };
}

function getImplementationDisagreementReason(
  response: ImplementerResponse,
): string | null {
  if (!response.implementation.implementerDisagrees) {
    return null;
  }

  const reason = response.implementation.implementerDisagreementReason?.trim();
  return reason && reason.length > 0 ? reason : null;
}

function isValidationOnlyRevisionDispute(
  revisionContext: ImplementerRevisionContext | undefined,
): boolean {
  if (!revisionContext?.validationRetryRequested) {
    return false;
  }
  if (revisionContext.testFailures?.executionKind !== "validation_only") {
    return false;
  }
  return (
    !revisionContext.codeReviewFindings ||
    revisionContext.codeReviewFindings.decision === "APPROVED"
  );
}

interface RetrofitCommitTrace {
  sourceJiraKey: string;
  sourceBranch: string;
  targetBranch: string;
  count: number;
  perCommit: Array<{ sha: string; status: string }>;
}

function buildCommitMessage(
  jiraKey: string,
  ticketSummary: string,
  jiraLabels?: string[],
  retrofitTrace?: RetrofitCommitTrace,
): string {
  const labels = normalizeJiraLabels(jiraLabels);
  const prefix = labels.has(SONAR_AUTOFIX_LABEL)
    ? "SONAR"
    : labels.has(PFOS_LABEL)
      ? "PFOS"
      : "ONESHOT";
  const base = `[${prefix}] ${jiraKey}: ${ticketSummary}`;
  if (!retrofitTrace) {
    return base;
  }
  const perCommitLine = retrofitTrace.perCommit
    .map((c) => `${c.sha}=${c.status}`)
    .join(", ");
  return (
    base +
    `\n\nRetrofit-Source: ${retrofitTrace.sourceJiraKey}` +
    `\nSource-Branch: ${retrofitTrace.sourceBranch} -> ${retrofitTrace.targetBranch}` +
    `\nSource-Commits (${retrofitTrace.count}): ${perCommitLine}`
  );
}

function buildRetrofitTraceabilityComment(
  retrofitContext: PlannerRetrofitContext,
  retrofitManifest: RetrofitCommitManifest,
): RetrofitTraceabilityComment {
  return {
    sourceJiraKey: retrofitContext.sourceJiraKey,
    sourceBranch: retrofitContext.sourceBranch,
    targetBranch: retrofitContext.targetBranch,
    selectedShas: retrofitManifest.entries.map((entry) => entry.sha),
    commitCount: retrofitManifest.entries.length,
    perCommitStatus: retrofitManifest.entries.map((entry) => ({
      sha: entry.sha,
      status: entry.status,
    })),
  };
}

async function validateFinalRetrofitPatchProof(input: {
  workspacePath: string;
  manifest: RetrofitCommitManifest;
  sourcePatchesBySha: ReadonlyMap<string, string>;
  adaptationCoverageEntries: readonly RetrofitAdaptationCoverageEntry[];
  sourceShasWithPriorAcceptedProof?: ReadonlySet<string>;
}): Promise<string[]> {
  const violations: string[] = [];

  for (const entry of input.manifest.entries) {
    if (entry.status === "failed" || entry.status === "not_attempted") {
      continue;
    }

    if (entry.status === "excluded") {
      if (!entry.excludedRationale?.trim() && !entry.rationale?.trim()) {
        violations.push(
          `retrofit_patch_incomplete: Source commit ${entry.sha} was excluded without a durable rationale.`,
        );
      }
      continue;
    }

    const patch = input.sourcePatchesBySha.get(entry.sha);
    if (!patch) {
      if (
        input.sourceShasWithPriorAcceptedProof?.has(entry.sha) &&
        entryHasCarriedForwardProof(entry)
      ) {
        continue;
      }
      violations.push(
        `retrofit_patch_incomplete: Source commit ${entry.sha} has status=${entry.status} but no source patch was retained for final proof.`,
      );
      continue;
    }

    if (await isPatchAlreadyApplied(input.workspacePath, patch)) {
      continue;
    }

    if (
      entry.status === "adapted" &&
      (hasRetrofitAdaptationCoverage(input.adaptationCoverageEntries, entry.sha) ||
        entryHasStructuredAdaptationProof(entry))
    ) {
      continue;
    }

    violations.push(
      `retrofit_patch_incomplete: Source commit ${entry.sha} was classified as ${entry.status}, but its source patch is not patch-equivalent at final workspace head.`,
    );
  }

  return violations;
}

async function repairRetrofitPatchProof(input: {
  workspacePath: string;
  manifest: RetrofitCommitManifest;
  sourcePatchesBySha: ReadonlyMap<string, string>;
  adaptationCoverageEntries: readonly RetrofitAdaptationCoverageEntry[];
}): Promise<{
  repairedShas: string[];
  unresolvedShas: string[];
}> {
  const repairedShas: string[] = [];

  for (const entry of input.manifest.entries) {
    if (entry.status === "excluded") {
      continue;
    }

    const coverage = input.adaptationCoverageEntries.find(
      (candidate) => candidate.sourceSha.trim() === entry.sha,
    );
    if (coverage) {
      entry.targetFiles = normalizeStringList([
        ...(entry.targetFiles ?? []),
        ...coverage.filesCovered,
      ]);
      entry.proofSnippets = normalizeStringList([
        ...(entry.proofSnippets ?? []),
        ...coverage.hunkEvidence,
      ]);
      entry.rationale = coverage.rationale?.trim() || entry.rationale;
    }

    if (entry.status === "adapted" && entryHasStructuredAdaptationProof(entry)) {
      continue;
    }

    if (entry.status !== "failed" && entry.status !== "not_attempted") {
      continue;
    }

    const patch = input.sourcePatchesBySha.get(entry.sha);
    if (patch && (await isPatchAlreadyApplied(input.workspacePath, patch))) {
      entry.status = "adapted";
      entry.targetFiles = normalizeStringList([
        ...(entry.targetFiles ?? []),
        ...entry.files,
      ]);
      entry.validationEvidence = normalizeStringList([
        ...(entry.validationEvidence ?? []),
        "Proof repair verified the source patch is patch-equivalent at final workspace head.",
      ]);
      repairedShas.push(entry.sha);
      continue;
    }

    if (coverage && entryHasStructuredAdaptationProof(entry)) {
      entry.status = "adapted";
      repairedShas.push(entry.sha);
    }
  }

  return {
    repairedShas,
    unresolvedShas: input.manifest.entries
      .filter((entry) => entry.status === "failed" || entry.status === "not_attempted")
      .map((entry) => entry.sha),
  };
}

export class ImplementerConsumer extends QueueConsumerBase {
  private readonly config: OneShotConsumerConfig;
  private readonly db: Database;
  private readonly oneShotDb: OneShotDatabase;
  private readonly publisher: OneShotPublisher;
  private readonly s3Client: S3Client;
  private readonly workspaceManager: OneShotWorkspaceManager;
  private readonly implementerProvider: ClaudeImplementerProvider;

  constructor(private readonly deps: ImplementerConsumerDeps = {}) {
    const config = deps.config ?? getOneShotConsumerConfig();
    const sqsClient =
      deps.sqsClient ?? new SQSClient({ region: config.region });
    super(config.implementationQueueUrl, "implementation", sqsClient);
    this.config = config;
    this.db = deps.db ?? getDatabase();
    this.oneShotDb = new OneShotDatabase(this.db.getPool());
    this.publisher = deps.publisher ?? new OneShotPublisher(config.region);
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
    this.implementerProvider =
      deps.implementerProvider ??
      new ClaudeImplementerProvider(promptComposer, {
        modelId: config.implementerModelId,
        maxOutputTokens: config.implementerMaxOutputTokens,
        maxTurns: config.implementerMaxTurns,
        mavenBuildsEnabled: config.mavenBuildsEnabled,
      });
  }

  protected getVisibilityTimeoutSeconds(): number {
    // Prod default 5400s (90 min) covers long implementer runs including Java
    // build+test loops. Env-gated for local iteration; invalid/unset falls
    // back to prod.
    return getVisibilityTimeoutFromEnv(
      "ONESHOT_IMPLEMENTER_VISIBILITY_TIMEOUT_SECONDS",
      5400,
    );
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
    const run = await this.oneShotDb.runs.getRunById(payload.run_id);
    if (!run) {
      logger.warn(
        { payload, messageId: message.MessageId, receiveCount },
        "Dropping implementation message for missing run",
      );
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
        "Dropping stale implementation message because run state has moved on",
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
      "implementing",
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

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: run.id,
        event_type: "run_claimed",
        from_state: payload.expected_state,
        to_state: "implementing",
        stage: "implementation",
        metadata_json: { version: payload.version, revision: payload.revision },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: run.id,
            jiraKey: run.jira_key,
            stage: "implementation",
          },
          "[EVENT_EMIT_FAILED] run_claimed createEvent failed",
        );
        return undefined;
      });

    // Hoisted so the outer catch can persist a partial-diff artifact even if
    // an error fires before these variables would have been assigned in the
    // normal control flow.
    let workspace:
      | Awaited<
          ReturnType<OneShotWorkspaceManager["prepareImplementerWorkspace"]>
        >
      | undefined;
    let workspaceBaseCommitSha: string | undefined;

    try {
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          implementationVersion: payload.version,
          revision: payload.revision,
        },
        "Implementer claimed run",
      );

      const MAX_RUN_AGE_MS = 24 * 60 * 60 * 1000;
      // Manual stage restart keeps the same run ID, so max-age guards must
      // measure from the latest restart event instead of original creation.
      const manualRestartAt =
        await this.oneShotDb.events.getLatestManualStageRestartAt(run.id);
      const ageBaseline = manualRestartAt ?? run.created_at;
      const ageBaselineSource = manualRestartAt
        ? "manual_restart"
        : "created_at";
      const runAgeMs = Date.now() - ageBaseline.getTime();
      const effectiveAgeHours = Math.round(runAgeMs / 3600000);
      if (runAgeMs > MAX_RUN_AGE_MS) {
        await this.failRun(
          run.id,
          run.jira_key,
          "run_failed",
          `Run exceeded maximum age of 24 hours (age: ${effectiveAgeHours}h). Run has been abandoned.`,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "failed",
            stage: "implementation",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
              reason: "run_age_exceeded",
              ageBaselineSource,
              ageBaselineAt: ageBaseline.toISOString(),
              manualRestartAt: manualRestartAt?.toISOString() ?? null,
              effectiveAgeHours,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: run.id,
              eventType: "state_transition",
              stage: "implementation",
            }),
          );
        return true;
      }

      const [budgetArtifacts, budgetEvents] = await Promise.all([
        this.oneShotDb.artifacts.getArtifactsForRun(run.id),
        this.oneShotDb.events.getEventsForRun(run.id),
      ]);
      const budgetCheck = checkOneShotTokenBudget({
        run,
        config: this.config,
        stage: "implementation",
        stageVersion: payload.version,
        artifacts: budgetArtifacts,
        events: budgetEvents,
        projectedTokens: PROJECTED_STAGE_TOKENS,
      });
      if (!budgetCheck.withinBudget) {
        const errorMessage = formatTokenBudgetFailure(
          "implementer",
          budgetCheck,
        );
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
            from_state: "implementing",
            to_state: "failed",
            stage: "implementation",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
              ...tokenBudgetEventMetadata(budgetCheck, payload.revision),
            },
          })
          .catch((err: unknown) => {
            logger.warn(
              {
                err,
                runId: run.id,
                jiraKey: run.jira_key,
                stage: "implementation",
                reason: "budget_exceeded",
              },
              "[EVENT_EMIT_FAILED] state_transition createEvent failed (budget_exceeded)",
            );
            return undefined;
          });
        return true;
      }

      const withinStageAttemptBudget =
        await this.oneShotDb.runs.checkStageAttemptBudget(
          run.id,
          "implementation",
          this.config.maxStageAttempts,
        );
      if (!withinStageAttemptBudget) {
        await this.failRun(
          run.id,
          run.jira_key,
          "run_failed",
          `OneShot implementer exhausted the maximum of ${this.config.maxStageAttempts} stage attempt(s).`,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "failed",
            stage: "implementation",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
              reason: "stage_attempts_exhausted",
              maxAttempts: this.config.maxStageAttempts,
            },
          })
          .catch((err: unknown) => {
            logger.warn(
              {
                err,
                runId: run.id,
                jiraKey: run.jira_key,
                stage: "implementation",
                reason: "stage_attempts_exhausted",
              },
              "[EVENT_EMIT_FAILED] state_transition createEvent failed (stage_attempts_exhausted)",
            );
            return undefined;
          });
        return true;
      }
      await this.oneShotDb.runs.incrementStageAttempts(
        run.id,
        "implementation",
      );

      const planVersion = run.current_plan_version;
      if (!planVersion) {
        throw new Error(`Run ${run.id} does not have an approved plan version`);
      }

      const repo = await this.db.getRepositoryById(run.repo_id);
      if (!repo) {
        throw new Error(
          `Repository ${run.repo_id} not found for oneshot run ${run.id}`,
        );
      }

      const runBranch = await ensureRunBranchContract({
        run,
        repo,
        oneShotDb: this.oneShotDb,
        workspaceManager: this.workspaceManager,
        stage: "implementer",
        logger,
      });
      const implementationBranch = runBranch.branchName;
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          targetBranchName: run.branch_name,
          frozenBaseCommitSha: run.base_commit_sha,
          workspaceBaseSha: runBranch.workspaceBaseSha,
          implementationVersion: payload.version,
          implementationBranch,
          revision: payload.revision,
        },
        "Implementer using persistent run branch without target branch head validation",
      );

      const planArtifact = await this.oneShotDb.artifacts.getArtifact(
        run.id,
        "plan",
        planVersion,
      );
      if (!planArtifact) {
        throw new Error(
          `Missing approved plan artifact v${planVersion} for oneshot run ${run.id}`,
        );
      }

      let plan = await this.readArtifactJson(
        planArtifact.s3_bucket,
        planArtifact.s3_key,
        parseOneShotPlan,
      );
      const traceArtifact = await this.oneShotDb.artifacts.getArtifact(
        run.id,
        "trace",
        planVersion,
      );
      const trace = traceArtifact
        ? await this.readArtifactJson(
            traceArtifact.s3_bucket,
            traceArtifact.s3_key,
            parseOneShotTraceArtifact,
          )
        : null;
      let effectiveBaseCommitSha = runBranch.workspaceBaseSha;
      if (plan.baseCommitSha !== effectiveBaseCommitSha) {
        plan = { ...plan, baseCommitSha: effectiveBaseCommitSha };
      }

      const qualificationSummary = await this.loadQualificationSummary(run.id);
      // Extract retrofit context and source evidence from qualification metadata.
      const retrofitContext = parsePlannerRetrofitContext(
        qualificationSummary.repoSelectionMetadata?.retrofitContext,
      );
      const retrofitSourceEvidence = retrofitContext
        ? parseRetrofitSourceEvidence(
            qualificationSummary.repoSelectionMetadata?.retrofitSourceEvidence,
          )
        : null;
      const previousImplementationCommitSha = payload.revision
        ? (run.current_implementation_commit_sha ??
          runBranch.currentCandidateSha)
        : null;
      workspaceBaseCommitSha =
        previousImplementationCommitSha ?? effectiveBaseCommitSha;
      const workspaceFetchBranch = implementationBranch;

      if (payload.revision && !previousImplementationCommitSha) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            implementationVersion: payload.version,
            frozenBaseCommitSha: effectiveBaseCommitSha,
          },
          "Revision implementation has no prior implementation commit; preparing from frozen base",
        );
      }

      // Load revision context if this is a code review or test failure revision
      const revisionContext = payload.revision
        ? await this.loadRevisionContext(run.id, payload.version)
        : undefined;
      const resumeSessionId = revisionContext?.previousProviderSessionId;
      const claudeConfigDir = path.join(
        this.config.workspaceBasePath,
        "claude-sessions",
        `run-${run.id}`,
      );

      workspace = await this.workspaceManager.prepareImplementerWorkspace(
        run.id,
        repo,
        workspaceBaseCommitSha,
        implementationBranch,
        workspaceFetchBranch,
        retrofitContext ? [retrofitContext.sourceBranch] : [],
      );
      const workspaceStartHead = await getCurrentHeadSha(
        workspace.workspacePath,
      );
      const parsedRetrofitExecutionContract = parseRetrofitExecutionContract(
        plan.plannerDiscoveries?.retrofitExecutionContract,
      );
      const retrofitExecutionContract: RetrofitExecutionContractV1 | null =
        parsedRetrofitExecutionContract ??
        (retrofitContext && retrofitSourceEvidence
          ? buildRetrofitExecutionContractFromEvidence({
              evidence: retrofitSourceEvidence,
              fileChangeContract: plan.fileChangeContract,
            })
          : null);
      const retrofitManifest: RetrofitCommitManifest | null =
        retrofitContext && retrofitExecutionContract
          ? {
              entries: retrofitExecutionContract.selectedCommits.map((commit) => ({
                sha: commit.sha,
                subject: commit.subject,
                files: commit.sourceFiles,
                sourceFiles: commit.sourceFiles,
                targetFiles: commit.targetFiles,
                adaptationFiles: commit.adaptationFiles,
                conflictDiagnostics: commit.conflictDiagnostics,
                proofSnippets: commit.proofSnippets,
                validationEvidence: commit.validationEvidence,
                rationale: commit.rationale,
                status: 'not_attempted' as const,
              })),
            }
          : null;
      const retrofitAllowedFiles = retrofitExecutionContract
        ? deriveRetrofitAllowedFilesFromExecutionContract(
            retrofitExecutionContract,
          )
        : deriveRetrofitAllowedFiles(retrofitSourceEvidence, plan.fileChangeContract);
      const retrofitSourcePatchesBySha = new Map<string, string>();
      const retrofitAdaptationCoverageEntries: RetrofitAdaptationCoverageEntry[] =
        [];
      const carriedForwardRetrofitSourceShas = new Set<string>();
      const priorAcceptedProofRetrofitSourceShas = new Set<string>();
      const priorRetrofitStatusesBySha = new Map(
        (revisionContext?.priorRetrofitSourceCommitStatuses ?? [])
          .filter(isAcceptedRetrofitSourceStatus)
          .map((status) => [status.sourceSha.trim(), status] as const),
      );
      if (revisionContext?.priorRetrofitAdaptationCoverage) {
        retrofitAdaptationCoverageEntries.push(
          ...revisionContext.priorRetrofitAdaptationCoverage,
        );
      }

      let implementerResponse;
      let changedFiles: string[] = [];
      let revisionChangedFiles: string[] | undefined;
      let implementationCommitSha: string | null = null;
      let commitDiff: string | undefined;
      let branchHygieneSummary: BranchHygieneSummary | null = null;
      let retrofitProviderProofMergedDuringPatchLane = false;
      {
        const workspaceArtifacts: WorkspaceArtifactFile[] = [
          {
            fileName: `plan.v${planVersion}.json`,
            body: plan,
            format: "json" as const,
          },
          {
            fileName: `plan.v${planVersion}.md`,
            body: renderOneShotPlanMarkdown(plan),
            format: "md" as const,
          },
        ];

        if (revisionContext?.codeReviewFindings) {
          workspaceArtifacts.push({
            fileName: "code-review.latest.json",
            body: revisionContext.codeReviewFindings,
            format: "json" as const,
          });
        }

        if (revisionContext?.testFailures) {
          workspaceArtifacts.push({
            fileName: "test-result.latest.json",
            body: revisionContext.testFailures,
            format: "json" as const,
          });
        }

        if (trace) {
          workspaceArtifacts.push({
            fileName: `trace.v${planVersion}.json`,
            body: trace,
            format: "json" as const,
          });
        }

        await materializeRunArtifacts(
          workspace.statePath,
          workspaceArtifacts,
          "implementer",
        );

        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            repoName: repo.repo_name,
            implementationBranch,
            baseCommitSha: effectiveBaseCommitSha,
            workspaceBaseCommitSha,
            workspaceFetchBranch,
            resumeSessionId: resumeSessionId ? "[set]" : undefined,
            claudeConfigDir,
          },
          "Implementer preparing workspace",
        );

        const processingMode =
          resolveOneShotProcessingMode(qualificationSummary);
        const invokeImplementerProvider = async (input: {
          attemptMode: "primary" | "fresh_after_no_changes";
          resumeSessionId?: string;
          forkSessionOnResume?: boolean;
          retrofitAdaptationContext?: {
            sourcePatch: string;
            conflictDiagnostics: string;
            allowedFiles: string[];
            sourceShas: string[];
          };
        }): Promise<ImplementerResponse> => {
          logger.info(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              workspacePath: workspace.workspacePath,
              implementationVersion: payload.version,
              revision: payload.revision,
              attemptMode: input.attemptMode,
              startedAt: new Date().toISOString(),
            },
            "Implementer invoking provider",
          );
          const implementerStartedMs = Date.now();

          const response = await this.implementerProvider.implementPlan({
            jiraKey: run.jira_key,
            repoName: repo.repo_name,
            branchName: run.branch_name,
            baseCommitSha: effectiveBaseCommitSha,
            implementationBranch,
            workspacePath: workspace.workspacePath,
            ticketSummary: qualificationSummary.ticketSummary || run.jira_key,
            plan,
            trace,
            revisionContext,
            resumeSessionId: input.resumeSessionId,
            forkSessionOnResume: input.forkSessionOnResume,
            claudeConfigDir,
            processingMode,
            retrofitAdaptationContext: input.retrofitAdaptationContext,
          });
          recordLlmMetrics(
            "implementation",
            "anthropic",
            response.metrics.durationMs,
            response.metrics.tokensUsed,
            response.metrics.costUsd,
            {
              model: response.metrics.modelUsed ?? "unknown",
            },
          );
          logger.info(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              implementationVersion: payload.version,
              revision: payload.revision,
              attemptMode: input.attemptMode,
              completedAt: new Date().toISOString(),
              providerDurationMs: Date.now() - implementerStartedMs,
              sessionId: response.sessionId,
              resumedFromSessionId: response.resumedFromSessionId,
              resumeMode: response.resumeMode,
              resumeAttempted: response.resumeAttempted ?? false,
              resumeSucceeded: response.resumeSucceeded ?? false,
            },
            "Implementer provider completed",
          );

          if (response.resumeAttempted) {
            this.oneShotDb.events
              .createEvent({
                oneshot_run_id: run.id,
                event_type: "implementation_session_resume",
                from_state: "implementing",
                to_state: "implementing",
                stage: "implementation",
                metadata_json: {
                  version: payload.version,
                  revision: payload.revision,
                  attemptMode: input.attemptMode,
                  sessionId: response.sessionId ?? null,
                  resumedFromSessionId: response.resumedFromSessionId ?? null,
                  resumeMode: response.resumeMode ?? null,
                  resumeAttempted: response.resumeAttempted ?? false,
                  resumeSucceeded: response.resumeSucceeded ?? false,
                },
              })
              .catch((err: unknown) => {
                logger.warn(
                  {
                    err,
                    runId: run.id,
                    jiraKey: run.jira_key,
                    stage: "implementation",
                    reason: "implementation_session_resume",
                  },
                  "[EVENT_EMIT_FAILED] implementation_session_resume createEvent failed",
                );
                return undefined;
              });
          }

          return response;
        };

        const collectProviderChanges = async (): Promise<{
          postProviderHead: string;
          providerChangedFiles: string[];
          dirtyFiles: string[];
        }> => {
          const postProviderHead = await getCurrentHeadSha(
            workspace.workspacePath,
          );
          const providerCommittedFiles = await listChangedFiles(
            workspace.workspacePath,
            workspaceStartHead,
            postProviderHead,
          );
          const dirtyFiles = await listChangedFiles(workspace.workspacePath);
          const providerChangedFiles = Array.from(
            new Set([...providerCommittedFiles, ...dirtyFiles]),
          ).sort((left, right) => left.localeCompare(right));
          return { postProviderHead, providerChangedFiles, dirtyFiles };
        };

        const mergeBranchHygieneSummary = (
          left: BranchHygieneSummary | null,
          right: BranchHygieneSummary,
        ): BranchHygieneSummary => {
          const removedFiles = Array.from(
            new Set([...(left?.removedFiles ?? []), ...right.removedFiles]),
          ).sort((a, b) => a.localeCompare(b));
          const preservedFiles = Array.from(
            new Set([...(left?.preservedFiles ?? []), ...right.preservedFiles]),
          ).sort((a, b) => a.localeCompare(b));
          const blockedFiles = Array.from(new Set(right.blockedFiles)).sort(
            (a, b) => a.localeCompare(b),
          );
          return {
            removedFiles,
            removedFilesSample: removedFiles.slice(0, 50),
            removedFilesCount: removedFiles.length,
            preservedFiles,
            preservedFilesSample: preservedFiles.slice(0, 50),
            preservedFilesCount: preservedFiles.length,
            blockedFiles,
            blockedFilesSample: blockedFiles.slice(0, 50),
            blockedFilesCount: blockedFiles.length,
          };
        };

        const applyBranchHygiene = async (
          postProviderHead: string,
        ): Promise<boolean> => {
          await workspace.assertLeaseValid?.("implementation");
          const hygiene = await cleanGeneratedBranchChanges({
            workspacePath: workspace.workspacePath,
            baseRef: effectiveBaseCommitSha,
            currentHead: postProviderHead,
          });
          await workspace.assertLeaseValid?.("implementation");
          if (
            hygiene.removedFilesCount === 0 &&
            hygiene.preservedFilesCount === 0
          ) {
            branchHygieneSummary = mergeBranchHygieneSummary(
              branchHygieneSummary,
              hygiene,
            );
            return false;
          }

          branchHygieneSummary = mergeBranchHygieneSummary(
            branchHygieneSummary,
            hygiene,
          );
          this.oneShotDb.events
            .createEvent({
              oneshot_run_id: run.id,
              event_type: "branch_hygiene",
              from_state: "implementing",
              to_state: "implementing",
              stage: "implementation",
              metadata_json: {
                version: payload.version,
                revision: payload.revision,
                ...hygiene,
              },
            })
            .catch(
              eventEmitFailureLogger({
                logger,
                runId: run.id,
                eventType: "branch_hygiene",
                stage: "implementation",
              }),
            );
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              implementationVersion: payload.version,
              removedFilesCount: hygiene.removedFilesCount,
              removedFilesSample: hygiene.removedFilesSample,
              preservedFilesCount: hygiene.preservedFilesCount,
            },
            "Implementer branch hygiene removed generated/cache changes before candidate review",
          );
          return true;
        };

        // ---------------------------------------------------------------------------
        // RETROFIT PATCH-FIRST LANE
        // Gated on retrofitContext/retrofitSourceEvidence presence.
        // Non-retrofit runs skip this block entirely.
        // ---------------------------------------------------------------------------
        let retrofitAllAlreadyApplied = false;
        if (retrofitManifest && retrofitContext && retrofitSourceEvidence) {
          const allowedFiles = retrofitAllowedFiles;

          for (const entry of retrofitManifest.entries) {
            try {
              const priorStatus = payload.revision
                ? priorRetrofitStatusesBySha.get(entry.sha)
                : undefined;
              if (priorStatus) {
                applyRetrofitSourceStatusToManifestEntry(entry, priorStatus);
                carriedForwardRetrofitSourceShas.add(entry.sha);
                priorAcceptedProofRetrofitSourceShas.add(entry.sha);
                await this.recordRetrofitPatchEvent(
                  run,
                  "retrofit_revision_proof_carried_forward",
                  {
                    version: payload.version,
                    revision: payload.revision,
                    sourceSha: entry.sha,
                    status: entry.status,
                    previousImplementationVersion:
                      revisionContext?.previousImplementationVersion ?? null,
                    sourceFiles: entry.sourceFiles ?? entry.files,
                    targetFiles: entry.targetFiles ?? [],
                    adaptationFiles: entry.adaptationFiles ?? [],
                    proofSnippets: entry.proofSnippets ?? [],
                    validationEvidence: entry.validationEvidence ?? [],
                    rationale:
                      entry.rationale ?? entry.excludedRationale ?? null,
                  },
                );
                continue;
              }
              const patch = await exportSourceCommitPatch(
                workspace.workspacePath,
                entry.sha,
              );
              retrofitSourcePatchesBySha.set(entry.sha, patch);
              if (await isPatchAlreadyApplied(workspace.workspacePath, patch)) {
                entry.status = 'already_applied';
                entry.targetFiles = normalizeStringList(entry.files);
                await this.recordRetrofitPatchEvent(run, "retrofit_patch_apply_result", {
                  version: payload.version,
                  revision: payload.revision,
                  sourceSha: entry.sha,
                  status: entry.status,
                  sourceFiles: entry.files,
                  targetFiles: entry.targetFiles,
                });
                continue;
              }
              if (await isPatchApplicable(workspace.workspacePath, patch)) {
                const applyResult = await applyPatch(workspace.workspacePath, patch);
                if (applyResult.ok) {
                  entry.status = 'clean_applied';
                  entry.targetFiles = normalizeStringList(entry.files);
                  await this.recordRetrofitPatchEvent(run, "retrofit_patch_apply_result", {
                    version: payload.version,
                    revision: payload.revision,
                    sourceSha: entry.sha,
                    status: entry.status,
                    sourceFiles: entry.files,
                    targetFiles: entry.targetFiles,
                  });
                  continue;
                }
                // Applicable check passed but apply failed — fall through to conflict path
                // (applyResult.conflictDiagnostics already captured below)
              }
              // Conflict path (applies cleanly failed OR patch not applicable):
              // invoke LLM in adaptation-only mode, then verify the patch landed.
              {
                const conflictResult = await applyPatch(workspace.workspacePath, patch);
                const conflictDiagnostics =
                  conflictResult.conflictDiagnostics ?? 'patch does not apply cleanly';
                entry.conflictDiagnostics = conflictDiagnostics;
                logger.warn(
                  { runId: run.id, sha: entry.sha, conflictDiagnostics },
                  'Retrofit patch conflict — invoking LLM adaptation',
                );
                await this.recordRetrofitPatchEvent(run, "retrofit_adaptation_started", {
                  version: payload.version,
                  revision: payload.revision,
                  sourceSha: entry.sha,
                  status: "conflicted",
                  sourceFiles: entry.files,
                  allowedFiles,
                  conflictDiagnostics,
                });
                const adaptResponse = await invokeImplementerProvider({
                  attemptMode: 'primary',
                  retrofitAdaptationContext: {
                    sourcePatch: patch,
                    conflictDiagnostics,
                    allowedFiles,
                    sourceShas: [entry.sha],
                  },
                });
                implementerResponse = adaptResponse;
                const parsedCoverage = parseRetrofitAdaptationCoverage(
                  adaptResponse.implementation.retrofitAdaptationCoverage,
                );
                const providerCommitStatuses = parseRetrofitSourceCommitStatuses(
                  adaptResponse.implementation.retrofitSourceCommitStatuses,
                );
                const providerCommitStatus = providerCommitStatuses.find(
                  (status) => status.sourceSha.trim() === entry.sha,
                );
                mergeProviderRetrofitStatus(entry, providerCommitStatus);
                retrofitAdaptationCoverageEntries.push(
                  ...parsedCoverage.filter(
                    (coverage) => coverage.sourceSha.trim() === entry.sha,
                  ),
                );
                retrofitProviderProofMergedDuringPatchLane = true;
                // Verify the adaptation actually applied the source patch (adapted check):
                // isPatchAlreadyApplied(patch) must be true post-adaptation, else classify
                // as failed so validateRetrofitCoverage surfaces retrofit_patch_incomplete.
                // This closes the PR#82→#83 dropped-change gap.
                const patchNowApplied = await isPatchAlreadyApplied(workspace.workspacePath, patch); // post-adapt adapted/failed gate
                const coverageAccountsForSha = hasRetrofitAdaptationCoverage(
                  adaptResponse.implementation.retrofitAdaptationCoverage,
                  entry.sha,
                );
                if (patchNowApplied || coverageAccountsForSha) {
                  entry.status = 'adapted';
                } else if (
                  providerCommitStatus?.status === "adapted" &&
                  entryHasStructuredAdaptationProof(entry)
                ) {
                  entry.status = "adapted";
                } else if (entry.status === "excluded" && entry.excludedRationale?.trim()) {
                  // Explicitly excluded source commits remain accounted for by rationale.
                } else {
                  logger.warn(
                    { runId: run.id, sha: entry.sha },
                    'Retrofit adaptation provider did not apply source patch; classifying as failed',
                  );
                  entry.status = 'failed';
                }
                await this.recordRetrofitPatchEvent(run, "retrofit_patch_apply_result", {
                  version: payload.version,
                  revision: payload.revision,
                  sourceSha: entry.sha,
                  status: entry.status,
                  sourceFiles: entry.files,
                  targetFiles: entry.targetFiles ?? [],
                  adaptationFiles: entry.adaptationFiles ?? [],
                  proofSnippets: entry.proofSnippets ?? [],
                  validationEvidence: entry.validationEvidence ?? [],
                  conflictDiagnostics,
                  rationale: entry.rationale ?? entry.excludedRationale ?? null,
                });
              }
            } catch (patchError) {
              // exportSourceCommitPatch or other primitives threw — classify as failed
              const errorMsg =
                patchError instanceof Error ? patchError.message : String(patchError);
              entry.conflictDiagnostics = errorMsg;
              logger.warn(
                { runId: run.id, sha: entry.sha, error: errorMsg },
                'Retrofit patch processing failed for commit',
              );
              entry.status = 'failed';
              await this.recordRetrofitPatchEvent(run, "retrofit_patch_apply_result", {
                version: payload.version,
                revision: payload.revision,
                sourceSha: entry.sha,
                status: entry.status,
                sourceFiles: entry.files,
                conflictDiagnostics: errorMsg,
              });
            }
          }

          // Persist manifest artifact
          await materializeRunArtifacts(
            workspace.statePath,
            [
              {
                fileName: 'retrofit-manifest.json',
                body: retrofitManifest,
                format: 'json' as const,
              },
            ],
            'implementer',
          );

          // If every commit is already_applied, route as verification-only / no-action
          retrofitAllAlreadyApplied = retrofitManifest.entries.every(
            (e) => e.status === 'already_applied',
          );
          if (retrofitAllAlreadyApplied) {
            logger.info(
              { runId: run.id, jiraKey: run.jira_key, commitCount: retrofitManifest.entries.length },
              'Retrofit patch-first lane: all source commits already applied; completing as no-action',
            );
            // Provider not called; persist a no-op implementation artifact before
            // completing so downstream traceability can read the normal artifact stage.
            const noActionMsg =
              `All ${retrofitManifest.entries.length} retrofit source commit(s) are already present on ` +
              `the target branch. No code changes required.`;
            await this.persistRetrofitNoActionImplementationArtifact({
              run,
              plan,
              payloadVersion: payload.version,
              revision: payload.revision,
              effectiveBaseCommitSha,
              implementationBranch,
              implementationCommitSha: workspaceStartHead,
              retrofitManifest,
              retrofitContext,
              retrofitSourceEvidence,
              message: noActionMsg,
            });
            await this.blockForRetrofitAlreadyApplied({
              run,
              payloadVersion: payload.version,
              revision: payload.revision,
              message: noActionMsg,
              implementationBranch,
              implementationCommitSha: workspaceStartHead,
              retrofitTraceability: buildRetrofitTraceabilityComment(
                retrofitContext,
                retrofitManifest,
              ),
            });
            return true;
          }
        }
        // ---------------------------------------------------------------------------
        // END RETROFIT PATCH-FIRST LANE
        // ---------------------------------------------------------------------------

        // For retrofit runs where ALL commits were handled mechanically (no LLM),
        // synthesize a minimal implementation response. For conflict adaptation cases,
        // implementerResponse was set inside the loop. For normal non-retrofit runs,
        // invoke the provider now.
        const retrofitAllMechanical =
          retrofitManifest !== null &&
          retrofitManifest.entries.length > 0 &&
          !retrofitAllAlreadyApplied &&
          implementerResponse === undefined &&
          retrofitManifest.entries.every(
            (e) => e.status === 'clean_applied' || e.status === 'already_applied',
          );

        if (retrofitAllMechanical) {
          // Mechanical retrofit: synthesize a minimal provider response — no LLM call
          const mechanicalShas = retrofitManifest!.entries
            .filter((e) => e.status === 'clean_applied')
            .map((e) => e.sha);
          implementerResponse = {
            implementation: {
              summary:
                `Retrofit mechanical apply: ${mechanicalShas.length} source commit(s) applied via git apply ` +
                `(clean_applied). Source: ${retrofitContext!.sourceJiraKey} -> ${retrofitContext!.targetBranch}.`,
              completedSpecIds: plan.specs.map((s: { id: string }) => s.id),
              implementedTraceTestIds: [],
              changedFiles: [],
              testCommands: [],
              validationCommands: [],
              validationChecks: [],
              manualVerificationSteps: [],
              testResults: [],
              deviationsFromPlan: [],
              residualRisks: [],
              openFollowUps: [],
            },
            rawOutput: '{"retrofit":"mechanical"}',
            metrics: { durationMs: 0, toolCalls: 0 },
          };
          logger.info(
            { runId: run.id, jiraKey: run.jira_key, mechanicalShas },
            'Retrofit patch-first lane: all patches applied mechanically, skipping LLM provider',
          );
        } else if (!implementerResponse) {
          implementerResponse = await invokeImplementerProvider({
            attemptMode: "primary",
            resumeSessionId,
            forkSessionOnResume: !!resumeSessionId,
          });
        }
        if (
          retrofitManifest &&
          implementerResponse &&
          !retrofitProviderProofMergedDuringPatchLane
        ) {
          const providerStatuses = parseRetrofitSourceCommitStatuses(
            implementerResponse.implementation.retrofitSourceCommitStatuses,
          );
          const providerCoverage = parseRetrofitAdaptationCoverage(
            implementerResponse.implementation.retrofitAdaptationCoverage,
          );
          for (const status of providerStatuses) {
            const sha = status.sourceSha.trim();
            const entry = retrofitManifest.entries.find(
              (candidate) => candidate.sha === sha,
            );
            if (!entry) {
              continue;
            }
            applyRetrofitSourceStatusToManifestEntry(entry, status);
            if (payload.revision && isAcceptedRetrofitSourceStatus(status)) {
              const wasCarriedForward =
                carriedForwardRetrofitSourceShas.has(sha);
              carriedForwardRetrofitSourceShas.delete(sha);
              await this.recordRetrofitPatchEvent(
                run,
                "retrofit_revision_proof_updated",
                {
                  version: payload.version,
                  revision: payload.revision,
                  sourceSha: sha,
                  status: entry.status,
                  previousImplementationVersion:
                    revisionContext?.previousImplementationVersion ?? null,
                  replacedCarriedForwardProof: wasCarriedForward,
                  sourceFiles: entry.sourceFiles ?? entry.files,
                  targetFiles: entry.targetFiles ?? [],
                  adaptationFiles: entry.adaptationFiles ?? [],
                  proofSnippets: entry.proofSnippets ?? [],
                  validationEvidence: entry.validationEvidence ?? [],
                  rationale:
                    entry.rationale ?? entry.excludedRationale ?? null,
                },
              );
            }
          }
          retrofitAdaptationCoverageEntries.push(...providerCoverage);
        }
        await workspace.assertLeaseValid?.("implementation");

        let { postProviderHead, providerChangedFiles, dirtyFiles } =
          await collectProviderChanges();

        if (await applyBranchHygiene(postProviderHead)) {
          ({ postProviderHead, providerChangedFiles, dirtyFiles } =
            await collectProviderChanges());
        }

        if (
          processingMode === "security_wiz" &&
          providerChangedFiles.length > 0
        ) {
          const scopeResult =
            checkSecurityRemediationScope(providerChangedFiles);
          if (!scopeResult.compliant) {
            const violationMsg =
              `PFOS security remediation scope violation: implementation changed ` +
              `${scopeResult.violatingFiles.length} file(s) outside pom.xml scope. ` +
              `Violating: ${scopeResult.violatingFiles.slice(0, 5).join(", ")}. ` +
              `Only pom.xml and security-baseline.properties are permitted for CVE tickets.`;
            this.oneShotDb.events
              .createEvent({
                oneshot_run_id: run.id,
                event_type: "branch_hygiene",
                from_state: "implementing",
                to_state: "implementing",
                stage: "implementation",
                metadata_json: {
                  version: payload.version,
                  revision: payload.revision,
                  reason: "pfos_scope_violation_warning",
                  warning: violationMsg,
                  violations: scopeResult.violations,
                  allowedFiles: scopeResult.allowedFiles,
                  violatingFiles: scopeResult.violatingFiles,
                },
              })
              .catch(
                eventEmitFailureLogger({
                  logger,
                  runId: run.id,
                  eventType: "branch_hygiene",
                  stage: "implementation",
                }),
              );
            logger.warn(
              {
                runId: run.id,
                jiraKey: run.jira_key,
                violations: scopeResult.violations,
                allowedFiles: scopeResult.allowedFiles,
                violatingFiles: scopeResult.violatingFiles,
                warning: violationMsg,
              },
              "PFOS security remediation scope violation observed — continuing run",
            );
          }
        }

        if (providerChangedFiles.length === 0) {
          if (branchHygieneSummary?.removedFilesCount) {
            await this.failNoChangedFiles({
              run,
              payloadVersion: payload.version,
              revision: payload.revision,
              reason: "branch_hygiene_no_valid_changes",
              message:
                "Implementation only changed generated/cache files that were removed by branch hygiene.",
              metadata: {
                branchHygiene: branchHygieneSummary,
              },
            });
            return true;
          }

          const disagreementReason =
            revisionContext?.codeReviewFindings ||
            isValidationOnlyRevisionDispute(revisionContext)
              ? getImplementationDisagreementReason(implementerResponse)
              : null;
          if (disagreementReason) {
            const validationDispute =
              isValidationOnlyRevisionDispute(revisionContext);
            await this.persistNoChangeRevisionAttemptMetrics({
              runId: run.id,
              jiraKey: run.jira_key,
              payloadVersion: payload.version,
              revisionContext,
              response: implementerResponse,
              reason: validationDispute
                ? "validation_dispute_needs_review"
                : "implementation_disagreed_with_review",
              retryOutcome: validationDispute ? "pr_open" : "blocked",
            }).catch((metricsError: unknown) => {
              logger.warn(
                {
                  runId: run.id,
                  jiraKey: run.jira_key,
                  implementationVersion: payload.version,
                  error:
                    metricsError instanceof Error
                      ? metricsError.message
                      : String(metricsError),
                },
                "Failed to persist implementation disagreement attempt metrics",
              );
              return undefined;
            });
            if (validationDispute) {
              await this.openDraftPrForValidationDispute({
                run,
                payloadVersion: payload.version,
                revisionContext,
                response: implementerResponse,
                disagreementReason,
              });
              return true;
            }
            await this.blockForImplementationDisagreement({
              run,
              payloadVersion: payload.version,
              revisionContext,
              response: implementerResponse,
              disagreementReason,
            });
            return true;
          }

          const canRetryFresh =
            payload.revision &&
            !!resumeSessionId &&
            implementerResponse.resumeAttempted === true &&
            implementerResponse.resumeMode === "fork_resume" &&
            implementerResponse.resumeSucceeded === true;

          if (canRetryFresh) {
            await this.persistNoChangeRevisionAttemptMetrics({
              runId: run.id,
              jiraKey: run.jira_key,
              payloadVersion: payload.version,
              revisionContext,
              response: implementerResponse,
              reason: "revision_no_changed_files_retry_fresh",
              retryOutcome: "fresh_retry_started",
            }).catch((metricsError: unknown) => {
              logger.warn(
                {
                  runId: run.id,
                  jiraKey: run.jira_key,
                  implementationVersion: payload.version,
                  error:
                    metricsError instanceof Error
                      ? metricsError.message
                      : String(metricsError),
                },
                "Failed to persist no-change revision attempt metrics",
              );
              return undefined;
            });

            const retryBudgetOk = await this.checkRevisionFreshRetryBudget({
              run,
              payloadVersion: payload.version,
              revisionContext,
              response: implementerResponse,
            });
            if (!retryBudgetOk) {
              return true;
            }

            this.oneShotDb.events
              .createEvent({
                oneshot_run_id: run.id,
                event_type: "state_transition",
                from_state: "implementing",
                to_state: "implementing",
                stage: "implementation",
                metadata_json: {
                  version: payload.version,
                  revision: payload.revision,
                  reason: "revision_no_changed_files_retry_fresh",
                  retryOutcome: "fresh_retry_started",
                  ...buildRevisionDiagnostics(
                    revisionContext,
                    implementerResponse,
                  ),
                },
              })
              .catch((err: unknown) => {
                logger.warn(
                  {
                    err,
                    runId: run.id,
                    jiraKey: run.jira_key,
                    stage: "implementation",
                    reason: "revision_no_changed_files_retry_fresh",
                  },
                  "[EVENT_EMIT_FAILED] state_transition createEvent failed (revision_no_changed_files_retry_fresh)",
                );
                return undefined;
              });

            logger.warn(
              {
                runId: run.id,
                jiraKey: run.jira_key,
                implementationVersion: payload.version,
                ...buildRevisionDiagnostics(
                  revisionContext,
                  implementerResponse,
                ),
              },
              "Resumed implementation revision produced no changes; retrying once with a fresh provider session",
            );

            implementerResponse = await invokeImplementerProvider({
              attemptMode: "fresh_after_no_changes",
            });
            await workspace.assertLeaseValid?.("implementation");
            ({ postProviderHead, providerChangedFiles, dirtyFiles } =
              await collectProviderChanges());
            if (await applyBranchHygiene(postProviderHead)) {
              ({ postProviderHead, providerChangedFiles, dirtyFiles } =
                await collectProviderChanges());
            }
          }

          if (providerChangedFiles.length === 0) {
            const postRetryDisagreementReason =
              revisionContext?.codeReviewFindings ||
              isValidationOnlyRevisionDispute(revisionContext)
                ? getImplementationDisagreementReason(implementerResponse)
                : null;
            if (postRetryDisagreementReason) {
              const validationDispute =
                isValidationOnlyRevisionDispute(revisionContext);
              await this.persistNoChangeRevisionAttemptMetrics({
                runId: run.id,
                jiraKey: run.jira_key,
                payloadVersion: payload.version,
                revisionContext,
                response: implementerResponse,
                reason: validationDispute
                  ? "validation_dispute_needs_review"
                  : "implementation_disagreed_with_review",
                retryOutcome: validationDispute
                  ? "pr_open_after_fresh_retry"
                  : "blocked_after_fresh_retry",
              }).catch((metricsError: unknown) => {
                logger.warn(
                  {
                    runId: run.id,
                    jiraKey: run.jira_key,
                    implementationVersion: payload.version,
                    error:
                      metricsError instanceof Error
                        ? metricsError.message
                        : String(metricsError),
                  },
                  "Failed to persist implementation disagreement attempt metrics",
                );
                return undefined;
              });
              if (validationDispute) {
                await this.openDraftPrForValidationDispute({
                  run,
                  payloadVersion: payload.version,
                  revisionContext,
                  response: implementerResponse,
                  disagreementReason: postRetryDisagreementReason,
                });
                return true;
              }
              await this.blockForImplementationDisagreement({
                run,
                payloadVersion: payload.version,
                revisionContext,
                response: implementerResponse,
                disagreementReason: postRetryDisagreementReason,
              });
              return true;
            }

            await this.failNoChangedFiles({
              run,
              payloadVersion: payload.version,
              revision: payload.revision,
              reason: canRetryFresh
                ? "revision_no_changed_files_after_fresh_retry"
                : "no_changed_files",
              message: canRetryFresh
                ? "Implementer revision produced no file changes after a fresh-session retry."
                : "Implementer completed without producing any file changes.",
            });
            return true;
          }
        }

        const fileContractResult = validateImplementedFilesAgainstPlanContract(
          plan,
          providerChangedFiles,
          { workspacePath: workspace.workspacePath },
        );
        if (!fileContractResult.passed) {
          await this.handlePlanContractViolation({
            run,
            payloadVersion: payload.version,
            revision: payload.revision,
            result: fileContractResult,
            priorEvents: budgetEvents,
          });
          return true;
        }

        // Post-implementation retrofit validation (gated on retrofit context).
        if (retrofitManifest && retrofitContext && retrofitSourceEvidence) {
          const proofRepair = await repairRetrofitPatchProof({
            workspacePath: workspace.workspacePath,
            manifest: retrofitManifest,
            sourcePatchesBySha: retrofitSourcePatchesBySha,
            adaptationCoverageEntries: retrofitAdaptationCoverageEntries,
          });
          if (
            proofRepair.repairedShas.length > 0 ||
            proofRepair.unresolvedShas.length > 0
          ) {
            await this.recordRetrofitPatchEvent(
              run,
              "retrofit_adaptation_proof_repaired",
              {
                version: payload.version,
                revision: payload.revision,
                repairedShas: proofRepair.repairedShas,
                unresolvedShas: proofRepair.unresolvedShas,
                perCommitStatus: retrofitManifest.entries.map((entry) => ({
                  sha: entry.sha,
                  status: entry.status,
                  targetFiles: entry.targetFiles ?? [],
                  adaptationFiles: entry.adaptationFiles ?? [],
                  proofSnippets: entry.proofSnippets ?? [],
                  validationEvidence: entry.validationEvidence ?? [],
                  rationale: entry.rationale ?? entry.excludedRationale ?? null,
                })),
              },
            );
          }
          const coverageViolations = [
            ...validateRetrofitCoverage(retrofitManifest),
            ...validatePriorAcceptedRetrofitRevisionProof({
              manifest: retrofitManifest,
              sourceShasWithPriorAcceptedProof:
                priorAcceptedProofRetrofitSourceShas,
              changedFiles: providerChangedFiles,
            }),
            ...(await validateFinalRetrofitPatchProof({
              workspacePath: workspace.workspacePath,
              manifest: retrofitManifest,
              sourcePatchesBySha: retrofitSourcePatchesBySha,
              adaptationCoverageEntries: retrofitAdaptationCoverageEntries,
              sourceShasWithPriorAcceptedProof:
                priorAcceptedProofRetrofitSourceShas,
            })),
          ];
          const cumulativeRetrofitContract =
            retrofitExecutionContract &&
            mergeRetrofitExecutionContractWithStatuses({
              contract: retrofitExecutionContract,
              statuses: retrofitManifest.entries.map((entry) => ({
                sourceSha: entry.sha,
                status: entry.status === "not_attempted" ? "failed" : entry.status,
                sourceFiles: entry.sourceFiles ?? entry.files,
                targetFiles: entry.targetFiles ?? [],
                adaptationFiles: entry.adaptationFiles ?? [],
                conflictDiagnostics: entry.conflictDiagnostics,
                proofSnippets: entry.proofSnippets ?? [],
                validationEvidence: entry.validationEvidence ?? [],
                rationale: entry.rationale ?? entry.excludedRationale,
              })),
            });
          const contractViolations = validateRetrofitExecutionContractForPlan({
            contract: cumulativeRetrofitContract,
            evidence: retrofitSourceEvidence,
            fileChangeContract: plan.fileChangeContract,
            changedFiles: providerChangedFiles,
            requireContract: Boolean(parsedRetrofitExecutionContract),
          });
          // Use the same allowedFiles set as the adaptation context (touchedFiles + plan-declared
          // editable adaptation files) so the two gates are consistent and legitimate
          // target-branch-renamed files that passed the LLM allowlist also pass here.
          const scopeViolations = validateRetrofitFileScope(
            providerChangedFiles,
            retrofitAllowedFiles,
          );
          const allViolations = [
            ...coverageViolations,
            ...contractViolations,
            ...scopeViolations,
          ];
          if (allViolations.length > 0) {
            const hasRevisionProofRegressionViolation = coverageViolations.some(
              (violation) =>
                violation.includes("retrofit_revision_proof_regressed"),
            );
            const isRevisionProofRegression =
              payload.revision &&
              (carriedForwardRetrofitSourceShas.size > 0 ||
                hasRevisionProofRegressionViolation);
            logger.warn(
              {
                runId: run.id,
                jiraKey: run.jira_key,
                violations: allViolations.slice(0, 5),
              },
              '[RETROFIT_VALIDATION] Retrofit patch validation failed; attempting same-run recovery',
            );
            await this.recordRetrofitPatchEvent(run, "retrofit_patch_validation_failed", {
              version: payload.version,
              revision: payload.revision,
              violations: allViolations,
              coverageViolations,
              contractViolations,
              scopeViolations,
              retrofitExecutionContractVersion:
                cumulativeRetrofitContract?.version ?? null,
              selectedShas: retrofitManifest.entries.map((entry) => entry.sha),
              perCommitStatus: retrofitManifest.entries.map((entry) => ({
                sha: entry.sha,
                status: entry.status,
                sourceFiles: entry.sourceFiles ?? entry.files,
                targetFiles: entry.targetFiles ?? [],
                adaptationFiles: entry.adaptationFiles ?? [],
                conflictDiagnostics: entry.conflictDiagnostics ?? null,
                proofSnippets: entry.proofSnippets ?? [],
                validationEvidence: entry.validationEvidence ?? [],
                rationale: entry.rationale ?? entry.excludedRationale ?? null,
              })),
            });
            if (isRevisionProofRegression) {
              await this.recordRetrofitPatchEvent(
                run,
                "retrofit_revision_proof_regressed",
                {
                  version: payload.version,
                  revision: payload.revision,
                  previousImplementationVersion:
                    revisionContext?.previousImplementationVersion ?? null,
                  carriedForwardSourceShas: Array.from(
                    carriedForwardRetrofitSourceShas,
                  ),
                  violations: allViolations,
                  coverageViolations,
                  scopeViolations,
                  changedFiles: providerChangedFiles,
                  perCommitStatus: retrofitManifest.entries.map((entry) => ({
                    sha: entry.sha,
                    status: entry.status,
                    sourceFiles: entry.sourceFiles ?? entry.files,
                    targetFiles: entry.targetFiles ?? [],
                    adaptationFiles: entry.adaptationFiles ?? [],
                    proofSnippets: entry.proofSnippets ?? [],
                    validationEvidence: entry.validationEvidence ?? [],
                    rationale:
                      entry.rationale ?? entry.excludedRationale ?? null,
                  })),
                },
              );
            }
            await materializeRunArtifacts(
              workspace.statePath,
              [
                {
                  fileName: 'retrofit-manifest.json',
                  body: retrofitManifest,
                  format: 'json' as const,
                },
              ],
              'implementer',
            );
            await this.handleRetrofitPatchIncomplete({
              run,
              payloadVersion: payload.version,
              revision: payload.revision,
              violations: allViolations,
              manifest: retrofitManifest,
              retrofitContext,
              allowedFiles: retrofitAllowedFiles,
              changedFiles: providerChangedFiles,
              priorEvents: budgetEvents,
              recoverySubtype: isRevisionProofRegression
                ? "retrofit_revision_proof_regressed"
                : undefined,
              exhaustedReason: isRevisionProofRegression
                ? "retrofit_revision_proof_regressed"
                : undefined,
            });
            return true;
          }
        }

        // Build retrofit trace for commit message and Jira comment.
        const retrofitTrace: RetrofitCommitTrace | undefined =
          retrofitManifest && retrofitContext
            ? {
                sourceJiraKey: retrofitContext.sourceJiraKey,
                sourceBranch: retrofitContext.sourceBranch,
                targetBranch: retrofitContext.targetBranch,
                count: retrofitManifest.entries.length,
                perCommit: retrofitManifest.entries.map((e) => ({
                  sha: e.sha,
                  status: e.status,
                })),
              }
            : undefined;

        if (dirtyFiles.length > 0) {
          await workspace.assertLeaseValid?.("implementation");
          await commitAllChanges(
            workspace.workspacePath,
            buildCommitMessage(
              run.jira_key,
              qualificationSummary.ticketSummary || run.jira_key,
              qualificationSummary.jiraLabels,
              retrofitTrace,
            ),
          );
          try {
            await workspace.assertLeaseValid?.("implementation");
          } catch (leaseError) {
            logger.warn(
              {
                runId: run.id,
                jiraKey: run.jira_key,
                implementationVersion: payload.version,
                workspacePath: workspace.workspacePath,
                resetToSha: workspaceStartHead,
                error:
                  leaseError instanceof Error
                    ? leaseError.message
                    : String(leaseError),
              },
              "Implementation commit completed after workspace lease loss; quarantining unadvertised commit",
            );
            await runGitCommand(
              `git reset --hard ${JSON.stringify(workspaceStartHead)}`,
              workspace.workspacePath,
            ).catch((resetError: unknown) => {
              logger.warn(
                {
                  runId: run.id,
                  jiraKey: run.jira_key,
                  error:
                    resetError instanceof Error
                      ? resetError.message
                      : String(resetError),
                },
                "Failed to reset implementation worktree after lease-lost commit",
              );
              return undefined;
            });
            await runGitCommand(
              "git clean -ffd",
              workspace.workspacePath,
            ).catch((cleanError: unknown) => {
              logger.warn(
                {
                  runId: run.id,
                  jiraKey: run.jira_key,
                  error:
                    cleanError instanceof Error
                      ? cleanError.message
                      : String(cleanError),
                },
                "Failed to clean implementation worktree after lease-lost commit",
              );
              return undefined;
            });
            throw leaseError;
          }
          implementationCommitSha = await getCurrentHeadSha(
            workspace.workspacePath,
          );

          logger.info(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              implementationBranch,
              implementationCommitSha,
              dirtyFilesCount: dirtyFiles.length,
              changedFilesCount: providerChangedFiles.length,
            },
            "Implementer committed workspace changes",
          );
        } else {
          implementationCommitSha = postProviderHead;

          logger.info(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              implementationBranch,
              implementationCommitSha,
              changedFilesCount: providerChangedFiles.length,
            },
            "Implementer finalized provider-created commit without creating an extra commit",
          );
        }

        if (!implementationCommitSha) {
          throw new Error(
            `Implementation commit SHA missing for oneshot run ${run.id}`,
          );
        }

        revisionChangedFiles = await listChangedFiles(
          workspace.workspacePath,
          workspaceStartHead,
          implementationCommitSha,
        );
        changedFiles = await listChangedFiles(
          workspace.workspacePath,
          effectiveBaseCommitSha,
          implementationCommitSha,
        );
        if (changedFiles.length === 0) {
          await this.failNoChangedFiles({
            run,
            payloadVersion: payload.version,
            revision: payload.revision,
            reason: branchHygieneSummary?.removedFilesCount
              ? "branch_hygiene_no_valid_changes"
              : "no_changed_files",
            message: branchHygieneSummary?.removedFilesCount
              ? "Implementation only changed generated/cache files that were removed by branch hygiene."
              : "Implementer completed without producing any file changes.",
            metadata: branchHygieneSummary?.removedFilesCount
              ? { branchHygiene: branchHygieneSummary }
              : undefined,
          });
          return true;
        }

        const blockedChangedFiles = changedFiles.filter(isBlockedGeneratedPath);
        if (blockedChangedFiles.length > 0) {
          await this.failNoChangedFiles({
            run,
            payloadVersion: payload.version,
            revision: payload.revision,
            reason: "branch_hygiene_failed",
            message:
              "Implementation candidate still contains generated/cache file changes after branch hygiene.",
            metadata: {
              branchHygiene: branchHygieneSummary,
              blockedFiles: blockedChangedFiles,
              blockedFilesSample: blockedChangedFiles.slice(0, 50),
              blockedFilesCount: blockedChangedFiles.length,
            },
          });
          return true;
        }

        const { stdout: rawCommitDiff } = await runGitCommand(
          `git diff ${JSON.stringify(effectiveBaseCommitSha)} ${JSON.stringify(implementationCommitSha)} --unified=5`,
          workspace.workspacePath,
        ).catch((err: unknown) => {
          logger.warn(
            {
              err,
              runId: run.id,
              jiraKey: run.jira_key,
              stage: "implementation",
              workspacePath: workspace.workspacePath,
              fromRef: effectiveBaseCommitSha,
              toRef: implementationCommitSha,
            },
            "[GIT_DIFF_FAILED] git diff base..final failed; proceeding without commit diff",
          );
          return { stdout: "" };
        });
        commitDiff = rawCommitDiff.slice(0, 100 * 1024) || undefined;

        const remoteBranchExists = await branchExistsOnRemote(
          repo,
          implementationBranch,
        );
        if (remoteBranchExists) {
          logger.warn(
            {
              runId: run.id,
              implementationBranch,
            },
            "Implementation branch already exists on remote; pushing updated draft branch",
          );
        }

        if (workspace.lease) {
          await workspace.assertLeaseValid?.("implementation");
          const leaseStillHeld =
            await this.oneShotDb.workspaceLeases.verifyLease(
              workspace.lease.scope,
              workspace.lease.fencingToken,
            );
          if (!leaseStillHeld) {
            await this.oneShotDb.workspaceLeases.recordLeaseLost(
              workspace.lease.scope,
              "implementation",
              "pre_push",
            );
            throw new WorkspaceLeaseLostError(
              `Lost workspace lease before pushing candidate v${payload.version} for run ${run.id}`,
            );
          }
        }

        let expectedRemoteHeadSha: string | null | undefined;
        if (runBranch.sharedEpicBranch) {
          const latestRemoteHead = await getRemoteBranchHead(
            repo,
            implementationBranch,
          );
          expectedRemoteHeadSha = latestRemoteHead?.headSha ?? null;
          if (latestRemoteHead) {
            const remoteHeadIsIncluded = await isAncestor(
              workspace.workspacePath,
              latestRemoteHead.headSha,
              implementationCommitSha,
            );
            if (!remoteHeadIsIncluded) {
              throw new Error(
                `Shared Epic branch ${implementationBranch} advanced to ${latestRemoteHead.headSha} after this run started from ${workspaceStartHead}; refusing to overwrite newer Epic work`,
              );
            }
          }
        }

        if (expectedRemoteHeadSha === undefined) {
          await pushBranch(workspace.workspacePath, repo, implementationBranch);
        } else {
          await pushBranch(
            workspace.workspacePath,
            repo,
            implementationBranch,
            { expectedRemoteHeadSha },
          );
        }
        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            implementationBranch,
            implementationCommitSha,
          },
          "Implementer pushed branch to remote",
        );

        // Verify push actually landed on remote
        const verifiedHead = await getRemoteBranchHead(
          repo,
          implementationBranch,
        );
        if (!verifiedHead || verifiedHead.headSha !== implementationCommitSha) {
          throw new Error(
            `Push verification failed for ${implementationBranch}: ` +
              `expected ${implementationCommitSha} on remote, got ${verifiedHead?.headSha ?? "no branch"}`,
          );
        }

        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            implementationBranch,
            verifiedHeadSha: verifiedHead.headSha,
          },
          "Implementer verified push landed on remote",
        );

        if (workspace.lease) {
          await workspace.assertLeaseValid?.("implementation");
          const candidateFinalized =
            await this.oneShotDb.candidateVersions.finalizeCandidate({
              oneshotRunId: run.id,
              candidateVersion: payload.version,
              candidateCommitSha: implementationCommitSha,
              previousCandidateCommitSha: previousImplementationCommitSha,
              targetFiles: getPlanImpactedFiles(plan),
              metadata: {
                implementationBranch,
                changedFiles,
                branchHygiene: branchHygieneSummary,
              },
              leaseScope: workspace.lease.scope,
              fencingToken: workspace.lease.fencingToken,
            });
          if (!candidateFinalized) {
            await this.oneShotDb.workspaceLeases.recordLeaseLost(
              workspace.lease.scope,
              "implementation",
              "candidate_finalize",
            );
            throw new WorkspaceLeaseLostError(
              `Lost workspace lease before finalizing candidate v${payload.version} for run ${run.id}`,
            );
          }
          const workspaceStateUpdated =
            await this.oneShotDb.workspaceState.conditionalUpdateWithLease({
              oneshotRunId: run.id,
              leaseScope: workspace.lease.scope,
              fencingToken: workspace.lease.fencingToken,
              workspacePhase: "candidate_finalized",
              workspaceHeadSha: implementationCommitSha,
              currentCandidateVersion: payload.version,
              currentCandidateSha: implementationCommitSha,
              metadata: {
                implementationBranch,
                changedFilesCount: changedFiles.length,
              },
            });
          if (!workspaceStateUpdated) {
            await this.oneShotDb.workspaceLeases.recordLeaseLost(
              workspace.lease.scope,
              "implementation",
              "workspace_state_update",
            );
            throw new WorkspaceLeaseLostError(
              `Lost workspace lease before updating candidate workspace state for run ${run.id}`,
            );
          }
        }
      }

      if (!implementationCommitSha) {
        throw new Error(
          `Implementation commit SHA missing for oneshot run ${run.id}`,
        );
      }

      if (!implementerResponse) {
        throw new Error(
          `Implementer response missing for oneshot run ${run.id} — this indicates a logic error in the retrofit lane`,
        );
      }

      const normalizedRetrofitSourceCommitStatuses = retrofitManifest
        ? retrofitManifest.entries.map(buildRetrofitSourceStatusFromManifestEntry)
        : implementerResponse.implementation.retrofitSourceCommitStatuses;
      const normalizedRetrofitAdaptationCoverage =
        retrofitAdaptationCoverageEntries.length > 0
          ? retrofitAdaptationCoverageEntries
          : implementerResponse.implementation.retrofitAdaptationCoverage;

      const implementation = parseOneShotImplementation({
        ...implementerResponse.implementation,
        retrofitSourceCommitStatuses: normalizedRetrofitSourceCommitStatuses,
        retrofitAdaptationCoverage: normalizedRetrofitAdaptationCoverage,
        baseCommitSha: effectiveBaseCommitSha,
        implementationBranch,
        implementationCommitSha,
        changedFiles,
        commitDiff,
      });

      await workspace.assertLeaseValid?.("implementation");

      const artifactKey = buildOneShotArtifactKey(
        this.config,
        run.jira_key,
        run.id,
        "implementation",
        payload.version,
      );

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          implementationVersion: payload.version,
          artifactKey,
          changedFilesCount: changedFiles.length,
          implementationBranch,
          implementationCommitSha,
        },
        "Implementer writing implementation artifact",
      );

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.artifactBucket,
          Key: artifactKey,
          Body: JSON.stringify(implementation, null, 2),
          ContentType: "application/json",
        }),
      );

      await workspace.assertLeaseValid?.("implementation");

      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.artifactBucket,
          Key: artifactKey.replace(/\.json$/i, ".md"),
          Body: renderOneShotImplementationMarkdown(plan, implementation),
          ContentType: "text/markdown",
        }),
      );

      await workspace.assertLeaseValid?.("implementation");

      const tokenUsage = calculateTokenUsage(implementerResponse.metrics);

      await this.oneShotDb.artifacts.upsertArtifact({
        oneshot_run_id: run.id,
        stage: "implementation",
        version: payload.version,
        status: "completed",
        s3_bucket: this.config.artifactBucket,
        s3_key: artifactKey,
        provider: "anthropic",
        model:
          implementerResponse.metrics.modelUsed ||
          process.env.ANTHROPIC_MODEL ||
          "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        metadata_json: {
          changedFiles,
          implementedTraceTestIds: implementation.implementedTraceTestIds,
          revisionChangedFiles: payload.revision
            ? (revisionChangedFiles ?? [])
            : undefined,
          implementationBranch,
          implementationCommitSha,
          baseCommitSha: implementation.baseCommitSha,
          revision: payload.revision,
          branchHygiene: branchHygieneSummary,
          sessionId: implementerResponse.sessionId ?? null,
          resumedFromSessionId:
            implementerResponse.resumedFromSessionId ?? null,
          resumeMode: implementerResponse.resumeMode ?? "fresh",
          resumeAttempted: implementerResponse.resumeAttempted ?? false,
          resumeSucceeded: implementerResponse.resumeSucceeded ?? false,
          stage_tokens_used: tokenUsage,
          tokens_used: implementerResponse.metrics.tokensUsed ?? null,
          stage_cost_usd: implementerResponse.metrics.costUsd ?? null,
          model_usage: implementerResponse.metrics.modelUsage ?? null,
          stage_duration_ms: implementerResponse.metrics.durationMs,
          retrofitManifest: retrofitManifest ?? null,
          retrofitContext: retrofitContext ?? null,
        },
        started_at: new Date(
          Date.now() - implementerResponse.metrics.durationMs,
        ),
        completed_at: new Date(),
      });
      await workspace.assertLeaseValid?.("implementation");
      if (tokenUsage > 0) {
        await this.oneShotDb.runs.addTokenUsage(run.id, tokenUsage);
      }
      await workspace.assertLeaseValid?.("implementation");

      // Route to code review instead of PR creation
      const codeReviewVersion = (run.current_code_review_version ?? 0) + 1;

      await workspace.assertLeaseValid?.("implementation");
      const transitioned = await transitionRunWithNotification(this.db, {
        runId: run.id,
        fromState: "implementing",
        toState: "queued_for_code_review",
        updates: {
          current_implementation_version: payload.version,
          current_implementation_branch: implementationBranch,
          current_implementation_commit_sha: implementationCommitSha,
          current_code_review_version: codeReviewVersion,
          last_error: null,
        },
        notification: {
          oneshot_run_id: run.id,
          jira_key: run.jira_key,
          notification_type: "implementation_completed",
          body_markdown: buildImplementationCompletedComment({
            assetBaseUrl: this.config.commentAssetBaseUrl,
            jiraKey: run.jira_key,
            implementation,
            retrofitTraceability: retrofitManifest && retrofitContext
              ? ({
                  sourceJiraKey: retrofitContext.sourceJiraKey,
                  sourceBranch: retrofitContext.sourceBranch,
                  targetBranch: retrofitContext.targetBranch,
                  selectedShas: retrofitManifest.entries.map((e) => e.sha),
                  commitCount: retrofitManifest.entries.length,
                  perCommitStatus: retrofitManifest.entries.map((e) => ({
                    sha: e.sha,
                    status: e.status,
                  })),
                } satisfies RetrofitTraceabilityComment)
              : undefined,
          }),
        },
      });
      if (!transitioned) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
          },
          "Implementation completion transition skipped because run state already moved",
        );
        return true;
      }
      await workspace.assertLeaseValid?.("implementation");
      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "implementing",
          to_state: "queued_for_code_review",
          stage: "implementation",
          metadata_json: {
            version: payload.version,
            revision: payload.revision,
            branchHygiene: branchHygieneSummary,
          },
        })
        .catch((err: unknown) => {
          logger.warn(
            {
              err,
              runId: run.id,
              jiraKey: run.jira_key,
              stage: "implementation",
              toState: "queued_for_code_review",
            },
            "[EVENT_EMIT_FAILED] state_transition createEvent failed (queued_for_code_review)",
          );
          return undefined;
        });

      try {
        await workspace.assertLeaseValid?.("implementation");
        await this.publisher.publishStageMessage(
          run.id,
          "code_review",
          codeReviewVersion,
          "queued_for_code_review",
          false,
          {
            expectedImplementationCommitSha: implementationCommitSha,
            expectedImplementationVersion: payload.version,
          },
        );
      } catch (publishError) {
        const publishErrorMessage =
          publishError instanceof Error
            ? publishError.message
            : String(publishError);
        logger.error(
          {
            err: publishError,
            runId: run.id,
            jiraKey: run.jira_key,
            implementationVersion: payload.version,
            codeReviewVersion,
          },
          "Failed to publish code-review message after implementation completion; reverting state to implementing",
        );
        const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
          run.id,
          "queued_for_code_review",
          "implementing",
          {
            current_implementation_version: run.current_implementation_version,
            current_implementation_branch: run.current_implementation_branch,
            current_implementation_commit_sha:
              run.current_implementation_commit_sha,
            current_code_review_version: run.current_code_review_version,
            last_error: publishErrorMessage,
          },
        );
        if (reverted) {
          this.oneShotDb.events
            .createEvent({
              oneshot_run_id: run.id,
              event_type: "state_revert",
              from_state: "queued_for_code_review",
              to_state: "implementing",
              stage: "implementation",
              metadata_json: {
                reason: "publish_failed",
                version: payload.version,
                revision: payload.revision,
                codeReviewVersion,
                publishError: publishErrorMessage,
              },
            })
            .catch(
              eventEmitFailureLogger({
                logger,
                runId: run.id,
                eventType: "state_revert",
                stage: "implementation",
              }),
            );
        } else {
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              implementationVersion: payload.version,
              codeReviewVersion,
            },
            "Skipped implementation publish-failure revert because run state already moved",
          );
        }
        throw publishError;
      }

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          implementationVersion: payload.version,
          codeReviewVersion,
          changedFiles: changedFiles.length,
        },
        "Implementation complete, queued for code review",
      );

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const { failureKind, failureCategory } =
        classifyImplementerFailure(error);
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
        });
      }
      await this.persistFailedAttemptMetrics({
        runId: run.id,
        jiraKey: run.jira_key,
        payloadVersion: payload.version,
        revision: payload.revision,
        error,
        failureKind,
        failureCategory,
        receiveCount,
      }).catch((metricsError: unknown) => {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            implementationVersion: payload.version,
            error:
              metricsError instanceof Error
                ? metricsError.message
                : String(metricsError),
          },
          "Failed to persist implementer failed-attempt metrics",
        );
        return undefined;
      });

      logger.error(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          implementationVersion: payload.version,
          error: errorMessage,
          failureKind,
          failureCategory,
        },
        "Implementer consumer failed to process run",
      );

      // Persist partial diff if the workspace exists and has unstaged edits.
      // This turns undebuggable turn-limit / stall failures into artifacts an
      // operator can inspect and potentially resume from. Best-effort —
      // failures here never mask the original failure path below.
      if (workspace?.workspacePath && workspaceBaseCommitSha) {
        await this.persistPartialDiff({
          runId: run.id,
          jiraKey: run.jira_key,
          implementationVersion: payload.version,
          workspacePath: workspace.workspacePath,
          baseCommitSha: workspaceBaseCommitSha,
          failureKind,
          failureCategory,
          errorMessage,
        }).catch((diffError: unknown) => {
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              err:
                diffError instanceof Error
                  ? diffError.message
                  : String(diffError),
            },
            "[PARTIAL_DIFF] Unhandled error persisting partial diff; continuing with failure path",
          );
          return undefined;
        });
      }

      if (failureKind === "turn_limit") {
        await this.failRun(
          run.id,
          run.jira_key,
          "run_failed",
          `OneShot implementer turn_limit: ${errorMessage}. Same-version redelivery was skipped because this failure is deterministic.`,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "failed",
            stage: "implementation",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
              reason: "turn_limit",
              failureKind,
              failureCategory,
            },
          })
          .catch((err: unknown) => {
            logger.warn(
              {
                err,
                runId: run.id,
                jiraKey: run.jira_key,
                stage: "implementation",
                reason: "turn_limit",
              },
              "[EVENT_EMIT_FAILED] state_transition createEvent failed (turn_limit)",
            );
            return undefined;
          });
        return true;
      }

      if (receiveCount >= TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT) {
        await this.failRun(run.id, run.jira_key, "run_failed", errorMessage);
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "failed",
            stage: "implementation",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
              reason: "max_retries_exceeded",
              failureKind,
              failureCategory,
            },
          })
          .catch((err: unknown) => {
            logger.warn(
              {
                err,
                runId: run.id,
                jiraKey: run.jira_key,
                stage: "implementation",
                reason: "max_retries_exceeded",
                failureKind,
                failureCategory,
              },
              "[EVENT_EMIT_FAILED] state_transition createEvent failed (max_retries_exceeded)",
            );
            return undefined;
          });
        return true;
      }

      const [retryBudgetArtifacts, retryBudgetEvents] = await Promise.all([
        this.oneShotDb.artifacts.getArtifactsForRun(run.id),
        this.oneShotDb.events.getEventsForRun(run.id),
      ]);
      const retryBudgetCheck = checkOneShotTokenBudget({
        run: (await this.oneShotDb.runs.getRunById(run.id)) ?? run,
        config: this.config,
        stage: "implementation",
        stageVersion: payload.version,
        artifacts: retryBudgetArtifacts,
        events: retryBudgetEvents,
        projectedTokens: PROJECTED_STAGE_TOKENS,
      });
      if (!retryBudgetCheck.withinBudget) {
        const budgetErrorMessage = formatTokenBudgetFailure(
          "implementer retry",
          retryBudgetCheck,
        );
        await this.failRun(
          run.id,
          run.jira_key,
          "budget_exceeded",
          budgetErrorMessage,
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "implementing",
            to_state: "failed",
            stage: "implementation",
            metadata_json: {
              ...tokenBudgetEventMetadata(retryBudgetCheck, payload.revision),
              version: payload.version,
              revision: payload.revision,
              reason: "retry_budget_projection_exceeded",
              failureKind,
              failureCategory,
            },
          })
          .catch((err: unknown) => {
            logger.warn(
              {
                err,
                runId: run.id,
                jiraKey: run.jira_key,
                stage: "implementation",
                reason: "retry_budget_projection_exceeded",
              },
              "[EVENT_EMIT_FAILED] state_transition createEvent failed (retry_budget_projection_exceeded)",
            );
            return undefined;
          });
        return true;
      }

      logger.warn(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          nextState: "queued_for_implementation",
          error: errorMessage,
          failureKind,
          failureCategory,
        },
        "Implementer returning run to queue after transient failure",
      );

      const requeued = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        run.id,
        "implementing",
        "queued_for_implementation",
        {
          last_error: errorMessage,
        },
      );
      if (!requeued) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            receiveCount,
          },
          "Implementer retry skipped because run state already moved",
        );
        return true;
      }

      const retryMeta = await this.shortenVisibilityForTransientRetry(message, receiveCount);

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "implementing",
          to_state: "queued_for_implementation",
          stage: "implementation",
          metadata_json: {
            version: payload.version,
            revision: payload.revision,
            reason: "transient_error_retry",
            failureKind,
            failureCategory,
            transientRetry: retryMeta,
          },
        })
        .catch((err: unknown) => {
          logger.warn(
            {
              err,
              runId: run.id,
              jiraKey: run.jira_key,
              stage: "implementation",
              reason: "transient_error_retry",
              failureKind,
              failureCategory,
            },
            "[EVENT_EMIT_FAILED] state_transition createEvent failed (transient_error_retry)",
          );
          return undefined;
        });
      return false;
    } finally {
      await workspace?.cleanup().catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: run.id,
            jiraKey: run.jira_key,
            stage: "implementation",
            workspacePath: workspace?.workspacePath,
          },
          "[WORKSPACE_CLEANUP_FAILED] implementer workspace cleanup failed",
        );
        return undefined;
      });
    }
  }

  /**
   * Persist a partial-diff artifact when the implementer fails mid-flight
   * (turn_limit, stall, provider error) after having already made edits in
   * the workspace. Without this, the implementation artifact is only written
   * on success and any real edits the model made are thrown away — making
   * these failures both undebuggable and unrecoverable.
   *
   * Best-effort: all git reads are wrapped in try/catch so a git failure
   * does not itself fail the run. The partial diff artifact includes the
   * full `git diff` against the base commit, `git status --short`, and the
   * list of modified files, keyed at implementation/v{V}/partial-diff.json.
   */
  private async persistPartialDiff(input: {
    runId: number;
    jiraKey: string;
    implementationVersion: number;
    workspacePath: string;
    baseCommitSha: string;
    failureKind: ImplementerFailureKind;
    failureCategory: ImplementerFailureCategory;
    errorMessage: string;
  }): Promise<void> {
    const {
      runId,
      jiraKey,
      implementationVersion,
      workspacePath,
      baseCommitSha,
      failureKind,
      failureCategory,
      errorMessage,
    } = input;

    let diff = "";
    let status = "";
    let changedFiles: string[] = [];

    try {
      const diffResult = await runGitCommand(
        `git diff ${JSON.stringify(baseCommitSha)} -- .`,
        workspacePath,
      );
      diff = diffResult.stdout;
    } catch (err) {
      logger.warn(
        {
          runId,
          jiraKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "[PARTIAL_DIFF] git diff failed; capturing status + filenames only",
      );
    }

    try {
      const statusResult = await runGitCommand(
        "git status --short",
        workspacePath,
      );
      status = statusResult.stdout;
    } catch (err) {
      logger.warn(
        {
          runId,
          jiraKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "[PARTIAL_DIFF] git status failed",
      );
    }

    try {
      changedFiles = await listChangedFiles(workspacePath);
    } catch (err) {
      logger.warn(
        {
          runId,
          jiraKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "[PARTIAL_DIFF] listChangedFiles failed",
      );
    }

    if (!diff && !status && changedFiles.length === 0) {
      logger.info(
        { runId, jiraKey },
        "[PARTIAL_DIFF] No workspace changes to persist; skipping partial-diff artifact",
      );
      return;
    }

    const partialDiff = {
      runId,
      jiraKey,
      implementationVersion,
      baseCommitSha,
      failureKind,
      failureCategory,
      errorMessage,
      capturedAt: new Date().toISOString(),
      changedFiles,
      gitStatus: status,
      gitDiff: diff,
    };

    const artifactKey = buildOneShotArtifactKey(
      this.config,
      jiraKey,
      runId,
      "implementation",
      implementationVersion,
    ).replace(/implementation\.json$/i, "partial-diff.json");

    try {
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.artifactBucket,
          Key: artifactKey,
          Body: JSON.stringify(partialDiff, null, 2),
          ContentType: "application/json",
        }),
      );
      logger.info(
        {
          runId,
          jiraKey,
          artifactKey,
          changedFilesCount: changedFiles.length,
          diffBytes: diff.length,
        },
        "[PARTIAL_DIFF] Persisted partial implementer diff",
      );
    } catch (err) {
      // Don't mask the original failure with a persistence error — log and
      // move on. The run is already being failed; diagnostics are best-effort.
      logger.error(
        {
          runId,
          jiraKey,
          artifactKey,
          err: err instanceof Error ? err.message : String(err),
        },
        "[PARTIAL_DIFF_WRITE_FAILED] Could not persist partial-diff artifact",
      );
    }
  }

  private async persistNoChangeRevisionAttemptMetrics(input: {
    runId: number;
    jiraKey: string;
    payloadVersion: number;
    revisionContext: ImplementerRevisionContext | undefined;
    response: ImplementerResponse;
    reason:
      | "revision_no_changed_files_retry_fresh"
      | "implementation_disagreed_with_review"
      | "validation_dispute_needs_review";
    retryOutcome:
      | "fresh_retry_started"
      | "blocked"
      | "blocked_after_fresh_retry"
      | "pr_open"
      | "pr_open_after_fresh_retry";
  }): Promise<void> {
    const tokenUsage = calculateTokenUsage(input.response.metrics);
    if (tokenUsage > 0) {
      await this.oneShotDb.runs.addTokenUsage(input.runId, tokenUsage);
    }

    await this.oneShotDb.events.createEvent({
      oneshot_run_id: input.runId,
      event_type: "stage_attempt_metrics",
      stage: "implementation",
      metadata_json: {
        version: input.payloadVersion,
        revision: true,
        reason: input.reason,
        retryOutcome: input.retryOutcome,
        model: input.response.metrics.modelUsed ?? null,
        stage_tokens_used: tokenUsage,
        tokens_used: input.response.metrics.tokensUsed ?? null,
        stage_cost_usd: input.response.metrics.costUsd ?? null,
        model_usage: input.response.metrics.modelUsage ?? null,
        stage_duration_ms: input.response.metrics.durationMs,
        llm_tool_calls: input.response.metrics.toolCalls,
        ...buildRevisionDiagnostics(input.revisionContext, input.response),
      },
    });
  }

  private async checkRevisionFreshRetryBudget(input: {
    run: OneShotRun;
    payloadVersion: number;
    revisionContext: ImplementerRevisionContext | undefined;
    response: ImplementerResponse;
  }): Promise<boolean> {
    const [retryBudgetArtifacts, retryBudgetEvents, latestRun] =
      await Promise.all([
        this.oneShotDb.artifacts.getArtifactsForRun(input.run.id),
        this.oneShotDb.events.getEventsForRun(input.run.id),
        this.oneShotDb.runs.getRunById(input.run.id),
      ]);
    const noChangeTokenUsage = calculateTokenUsage(input.response.metrics);
    const budgetRun = latestRun ?? input.run;
    const retryBudgetCheck = checkOneShotTokenBudget({
      run: {
        ...budgetRun,
        total_tokens_used: Math.max(
          budgetRun.total_tokens_used,
          input.run.total_tokens_used + noChangeTokenUsage,
        ),
      },
      config: this.config,
      stage: "implementation",
      stageVersion: input.payloadVersion,
      artifacts: retryBudgetArtifacts,
      events: retryBudgetEvents,
      projectedTokens: PROJECTED_STAGE_TOKENS,
    });

    if (retryBudgetCheck.withinBudget) {
      return true;
    }

    const budgetErrorMessage = formatTokenBudgetFailure(
      "implementer fresh retry after no-change revision",
      retryBudgetCheck,
    );
    await this.failRun(
      input.run.id,
      input.run.jira_key,
      "budget_exceeded",
      budgetErrorMessage,
    );
    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "failed",
        stage: "implementation",
        metadata_json: {
          ...tokenBudgetEventMetadata(retryBudgetCheck, true),
          version: input.payloadVersion,
          revision: true,
          reason: "revision_no_change_retry_budget_exceeded",
          ...buildRevisionDiagnostics(input.revisionContext, input.response),
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: "implementation",
            reason: "revision_no_change_retry_budget_exceeded",
          },
          "[EVENT_EMIT_FAILED] state_transition createEvent failed (revision_no_change_retry_budget_exceeded)",
        );
        return undefined;
      });
    return false;
  }

  private async openDraftPrForValidationDispute(input: {
    run: OneShotRun;
    payloadVersion: number;
    revisionContext: ImplementerRevisionContext | undefined;
    response: ImplementerResponse;
    disagreementReason: string;
  }): Promise<void> {
    const implementationBranch = input.run.current_implementation_branch;
    if (!implementationBranch) {
      await this.blockForImplementationDisagreement({
        run: input.run,
        payloadVersion: input.payloadVersion,
        revisionContext: input.revisionContext,
        response: input.response,
        disagreementReason: `${input.disagreementReason} Draft PR could not be opened because the implementation branch is missing.`,
      });
      return;
    }

    const testFailures = input.revisionContext?.testFailures;
    const failedChecks =
      testFailures?.executedValidationChecks?.filter(
        (check) => !check.passed,
      ) ?? [];

    let prUrl: string | null = null;
    let prStateSyncError: string | null = null;
    try {
      const repo = await this.db.getRepositoryById(input.run.repo_id);
      if (!repo) {
        throw new Error(`Repository ${input.run.repo_id} was not found`);
      }
      const { owner, repo: repoName } = parseGitHubRepoUrl(repo.repo_url);
      const ticketSummary = await loadRunTicketSummary(
        this.oneShotDb,
        this.s3Client,
        input.run.id,
      );
      const failedCheckLines =
        failedChecks.length > 0
          ? failedChecks
              .map(
                (check) =>
                  `- ${check.kind} (${check.scope ?? "file"}): \`${check.pattern}\` in ${check.paths.map((entry) => `\`${entry}\``).join(", ")}`,
              )
              .join("\n")
          : "- No structured failed validation checks were recorded.";
      const pr = await ensureDraftPullRequest({
        owner,
        repo: repoName,
        title: buildOneShotPullRequestTitle({
          jiraKey: input.run.jira_key,
          ticketSummary,
          wip: true,
        }),
        head: implementationBranch,
        base: input.run.branch_name,
        draft: true,
        body:
          `## OneShot Validation Dispute Needs Review\n\n` +
          `This draft PR was created because the implementation revision disputed a validation-only failure after the original implementation had passed code review.\n\n` +
          `## Autonomous Readiness\n` +
          `- Classification: Needs review\n` +
          `- Completion status: \`completed_needs_review\`\n\n` +
          `## Implementer Disagreement\n${input.disagreementReason}\n\n` +
          `## Failed Validation Checks\n${failedCheckLines}`,
      });
      prUrl = pr.htmlUrl;
      prStateSyncError = pr.updateSyncError ?? pr.draftSyncError ?? null;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.blockForImplementationDisagreement({
        run: input.run,
        payloadVersion: input.payloadVersion,
        revisionContext: input.revisionContext,
        response: input.response,
        disagreementReason: `${input.disagreementReason} Draft PR could not be opened for validation-dispute review: ${errorMessage}`,
      });
      return;
    }

    const lastError = `Validation-only check disputed by implementer; draft PR needs human review: ${input.disagreementReason}`;
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "pr_open",
      updates: {
        current_pr_url: prUrl,
        final_disposition: "completed_needs_review",
        last_error: lastError,
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "pr_needs_review",
        body_markdown:
          `# OneShot Validation Dispute Needs Review\n\n` +
          `OneShot opened a draft PR because the implementation revision disputed a validation-only failure.\n\n` +
          `PR: ${prUrl}\n\n` +
          `Disagreement: ${input.disagreementReason}`,
      },
      workspaceCleanupContext: {
        repoAdminBasePath: this.config.repoAdminBasePath,
        repoCacheBasePath: this.config.repoCacheBasePath,
        workspaceBasePath: this.config.workspaceBasePath,
        worktreeBasePath: this.config.worktreeBasePath,
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          reason: "validation_dispute_needs_review",
        },
        "Validation-dispute transition skipped because run state already moved",
      );
      return;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "pr_open",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: true,
          reason: "validation_dispute_needs_review",
          prUrl,
          prStateSyncError,
          disagreementReason: input.disagreementReason,
          failedValidationChecks: failedChecks,
          testExecutionKind: testFailures?.executionKind ?? null,
          testFailCount: testFailures?.failCount ?? null,
          testVersion: input.run.current_test_version,
          implementationVersion: input.run.current_implementation_version,
          ...buildRevisionDiagnostics(input.revisionContext, input.response),
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: "implementation",
            reason: "validation_dispute_needs_review",
          },
          "[EVENT_EMIT_FAILED] state_transition createEvent failed (validation_dispute_needs_review)",
        );
        return undefined;
      });
  }

  private async blockForImplementationDisagreement(input: {
    run: OneShotRun;
    payloadVersion: number;
    revisionContext: ImplementerRevisionContext | undefined;
    response: ImplementerResponse;
    disagreementReason: string;
  }): Promise<void> {
    const lastError = `Implementer disagreed with code review: ${input.disagreementReason}`;
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "blocked",
      updates: {
        final_disposition: "code_review_blocked",
        last_error: lastError,
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "code_review_blocked",
        body_markdown: buildRunFailedComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey: input.run.jira_key,
          stageLabel: "Implementation Revision",
          errorMessage: lastError,
        }),
      },
      workspaceCleanupContext: {
        repoAdminBasePath: this.config.repoAdminBasePath,
        repoCacheBasePath: this.config.repoCacheBasePath,
        workspaceBasePath: this.config.workspaceBasePath,
        worktreeBasePath: this.config.worktreeBasePath,
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          reason: "implementation_disagreed_with_review",
        },
        "Implementation disagreement transition skipped because run state already moved",
      );
      return;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "blocked",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: true,
          reason: "implementation_disagreed_with_review",
          disagreementReason: input.disagreementReason,
          ...buildRevisionDiagnostics(input.revisionContext, input.response),
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: "implementation",
            reason: "implementation_disagreed_with_review",
          },
          "[EVENT_EMIT_FAILED] state_transition createEvent failed (implementation_disagreed_with_review)",
        );
        return undefined;
      });
  }

  private async failNoChangedFiles(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    reason:
      | "no_changed_files"
      | "revision_no_changed_files_after_fresh_retry"
      | "branch_hygiene_no_valid_changes"
      | "branch_hygiene_failed";
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    if (
      input.reason === "no_changed_files" ||
      input.reason === "revision_no_changed_files_after_fresh_retry"
    ) {
      await this.blockNoChangedFiles({
        run: input.run,
        payloadVersion: input.payloadVersion,
        revision: input.revision,
        reason: input.reason,
        message: input.message,
        metadata: input.metadata,
      });
      return;
    }

    await this.failRun(
      input.run.id,
      input.run.jira_key,
      "run_failed",
      input.message,
    );
    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "failed",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: input.revision,
          reason: input.reason,
          ...(input.metadata ?? {}),
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: "implementation",
            reason: input.reason,
          },
          `[EVENT_EMIT_FAILED] state_transition createEvent failed (${input.reason})`,
        );
        return undefined;
      });
  }

  private async blockNoChangedFiles(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    reason: "no_changed_files" | "revision_no_changed_files_after_fresh_retry";
    message: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    const lastError = `${input.message} Source may already be clean or the remediation may require human review.`;
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "blocked",
      updates: {
        final_disposition: "source_already_clean_or_no_changes",
        last_error: lastError,
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "progress_update",
        body_markdown:
          `# OneShot Implementation Needs Review\n\n` +
          `${lastError}\n\n` +
          `No pull request was created because OneShot found no file changes to commit.`,
      },
      workspaceCleanupContext: {
        repoAdminBasePath: this.config.repoAdminBasePath,
        repoCacheBasePath: this.config.repoCacheBasePath,
        workspaceBasePath: this.config.workspaceBasePath,
        worktreeBasePath: this.config.worktreeBasePath,
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          reason: input.reason,
        },
        "No-change implementation block skipped because run state already moved",
      );
      return;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "blocked",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: input.revision,
          reason: input.reason,
          reviewReason: "source_already_clean_or_no_changes",
          ...(input.metadata ?? {}),
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: "implementation",
            reason: input.reason,
          },
          `[EVENT_EMIT_FAILED] state_transition createEvent failed (${input.reason})`,
        );
        return undefined;
      });
  }

  private async handlePlanContractViolation(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    result: ImplementationFileContractResult;
    priorEvents: readonly OneShotRunEvent[];
  }): Promise<void> {
    const autoReplansUsed = countPlanContractAutoReplans(input.priorEvents);
    if (autoReplansUsed >= PLAN_CONTRACT_AUTO_REPLAN_MAX_ATTEMPTS) {
      await this.blockForPlanContractViolation({
        ...input,
        reason: "plan_contract_violation_replan_exhausted",
        autoReplansUsed,
      });
      return;
    }

    await this.queuePlanContractViolationReplan({
      ...input,
      autoReplansUsed,
    });
  }

  private async recordRetrofitPatchEvent(
    run: OneShotRun,
    eventType:
      | "retrofit_patch_apply_result"
      | "retrofit_adaptation_started"
      | "retrofit_adaptation_proof_repaired"
      | "retrofit_patch_validation_failed"
      | "retrofit_revision_proof_carried_forward"
      | "retrofit_revision_proof_updated"
      | "retrofit_revision_proof_regressed",
    metadata: Record<string, unknown>,
  ): Promise<void> {
    await this.oneShotDb.events
      .createEvent({
        oneshot_run_id: run.id,
        event_type: eventType,
        from_state: "implementing",
        to_state: "implementing",
        stage: "implementation",
        metadata_json: metadata,
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: run.id,
          eventType,
          stage: "implementation",
        }),
      );
  }

  private async queuePlanContractViolationReplan(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    result: ImplementationFileContractResult;
    autoReplansUsed: number;
  }): Promise<void> {
    const nextPlanVersion =
      (input.run.current_plan_version ?? input.payloadVersion) + 1;
    const autoReplanAttempt = input.autoReplansUsed + 1;
    const violatingSample = input.result.violatingFiles.slice(0, 10);
    const lastError =
      `Implementation changed files outside the approved plan contract: ` +
      `${violatingSample.join(", ")}${
        input.result.violatingFiles.length > violatingSample.length
          ? ` (+${input.result.violatingFiles.length - violatingSample.length} more)`
          : ""
      }.`;

    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "queued_for_planning",
      updates: {
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
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "progress_update",
        body_markdown:
          `# OneShot Replanning Needed\n\n` +
          `${lastError}\n\n` +
          `OneShot is sending the same run back to planning so the plan contract can either approve those files with evidence or constrain the next implementation attempt.`,
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          reason: "plan_contract_violation_auto_replan",
          violatingFiles: input.result.violatingFiles,
        },
        "Plan-contract auto-replan skipped because run state already moved",
      );
      return;
    }

    const dedupeToken = [
      "plan-contract-replan",
      input.payloadVersion,
      nextPlanVersion,
      autoReplanAttempt,
      Date.now(),
    ].join(":");

    try {
      await this.oneShotDb.events.createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "queued_for_planning",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: input.revision,
          reason: "plan_contract_violation_auto_replan",
          currentPlanVersion: input.run.current_plan_version,
          nextPlanVersion,
          editableFiles: input.result.editableFiles,
          changedFiles: input.result.changedFiles,
          violatingFiles: input.result.violatingFiles,
          violatingFilesSample: violatingSample,
          violatingFilesCount: input.result.violatingFiles.length,
          autoReplanAttempt,
          autoReplanMaxAttempts: PLAN_CONTRACT_AUTO_REPLAN_MAX_ATTEMPTS,
          dedupeToken,
        },
      });
      await this.publisher.publishStageMessage(
        input.run.id,
        "planning",
        nextPlanVersion,
        "queued_for_planning",
        true,
        { dedupeToken },
      );
    } catch (publishError) {
      const publishErrorMessage =
        publishError instanceof Error
          ? publishError.message
          : String(publishError);
      logger.error(
        {
          err: publishError,
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          implementationVersion: input.payloadVersion,
          nextPlanVersion,
        },
        "Failed to publish planning message after plan-contract auto-replan; reverting state to implementing",
      );
      const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        input.run.id,
        "queued_for_planning",
        "implementing",
        {
          current_plan_version: input.run.current_plan_version,
          current_review_version: input.run.current_review_version,
          current_implementation_version:
            input.run.current_implementation_version,
          current_implementation_branch: input.run.current_implementation_branch,
          current_implementation_commit_sha:
            input.run.current_implementation_commit_sha,
          current_code_review_version: input.run.current_code_review_version,
          current_test_version: input.run.current_test_version,
          review_loop_count: input.run.review_loop_count,
          planning_attempt_count: input.run.planning_attempt_count,
          implementation_attempt_count: input.run.implementation_attempt_count,
          code_review_attempt_count: input.run.code_review_attempt_count,
          verification_loop_count: input.run.verification_loop_count,
          final_disposition: input.run.final_disposition,
          last_error: publishErrorMessage,
        },
      );
      if (reverted) {
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: input.run.id,
            event_type: "state_revert",
            from_state: "queued_for_planning",
            to_state: "implementing",
            stage: "implementation",
            metadata_json: {
              reason: "publish_failed",
              originalReason: "plan_contract_violation_auto_replan",
              version: input.payloadVersion,
              revision: input.revision,
              nextPlanVersion,
              autoReplanAttempt,
              dedupeToken,
              publishError: publishErrorMessage,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: input.run.id,
              eventType: "state_revert",
              stage: "implementation",
            }),
          );
      } else {
        logger.warn(
          {
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            implementationVersion: input.payloadVersion,
            nextPlanVersion,
          },
          "Skipped plan-contract auto-replan publish-failure revert because run state already moved",
        );
      }
      throw publishError;
    }

    logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        implementationVersion: input.payloadVersion,
        nextPlanVersion,
        violatingFilesCount: input.result.violatingFiles.length,
        autoReplanAttempt,
      },
      "Implementation plan-contract violation queued same-run replanning",
    );
  }

  private async handleRetrofitPatchIncomplete(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    violations: string[];
    manifest: RetrofitCommitManifest;
    retrofitContext: PlannerRetrofitContext;
    allowedFiles: readonly string[];
    changedFiles: readonly string[];
    priorEvents: readonly OneShotRunEvent[];
    recoverySubtype?: "retrofit_revision_proof_regressed";
    exhaustedReason?: "retrofit_revision_proof_regressed";
  }): Promise<void> {
    const autoReplansUsed = countRetrofitPatchAutoReplans(input.priorEvents);
    if (autoReplansUsed >= RETROFIT_PATCH_AUTO_REPLAN_MAX_ATTEMPTS) {
      await this.blockForRetrofitPatchIncomplete({
        ...input,
        reason: input.exhaustedReason ?? "retrofit_patch_proof_missing",
        autoReplansUsed,
      });
      return;
    }

    await this.queueRetrofitPatchReplan({
      ...input,
      autoReplansUsed,
    });
  }

  private async queueRetrofitPatchReplan(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    violations: string[];
    manifest: RetrofitCommitManifest;
    retrofitContext: PlannerRetrofitContext;
    allowedFiles: readonly string[];
    changedFiles: readonly string[];
    autoReplansUsed: number;
    recoverySubtype?: "retrofit_revision_proof_regressed";
  }): Promise<void> {
    const nextPlanVersion =
      (input.run.current_plan_version ?? input.payloadVersion) + 1;
    const autoReplanAttempt = input.autoReplansUsed + 1;
    const violationSample = input.violations.slice(0, 5);
    const perCommitStatus = input.manifest.entries.map((entry) => ({
      sha: entry.sha,
      subject: entry.subject,
      status: entry.status,
      sourceFiles: entry.sourceFiles ?? entry.files,
      targetFiles: entry.targetFiles ?? [],
      adaptationFiles: entry.adaptationFiles ?? [],
      conflictDiagnostics: entry.conflictDiagnostics ?? null,
      proofSnippets: entry.proofSnippets ?? [],
      validationEvidence: entry.validationEvidence ?? [],
      rationale: entry.rationale ?? entry.excludedRationale ?? null,
    }));
    const lastError =
      `Retrofit source commit proof is incomplete: ${violationSample.join(" | ")}` +
      (input.violations.length > violationSample.length
        ? ` (+${input.violations.length - violationSample.length} more)`
        : "");

    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "queued_for_planning",
      updates: {
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
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "progress_update",
        body_markdown:
          `# OneShot Retrofit Replanning Needed\n\n` +
          `${lastError}\n\n` +
          `OneShot is sending the same run back to planning so the retrofit plan can map the conflicted source commit(s) to target-branch files with evidence or explicitly exclude them with rationale.`,
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          reason: "retrofit_patch_incomplete_auto_replan",
          violations: input.violations,
        },
        "Retrofit patch auto-replan skipped because run state already moved",
      );
      return;
    }

    const dedupeToken = [
      "retrofit-patch-replan",
      input.payloadVersion,
      nextPlanVersion,
      autoReplanAttempt,
      Date.now(),
    ].join(":");

    try {
      await this.oneShotDb.events.createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "queued_for_planning",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: input.revision,
          reason: "retrofit_patch_incomplete_auto_replan",
          currentPlanVersion: input.run.current_plan_version,
          nextPlanVersion,
          sourceJiraKey: input.retrofitContext.sourceJiraKey,
          sourceBranch: input.retrofitContext.sourceBranch,
          targetBranch: input.retrofitContext.targetBranch,
          selectedShas: input.manifest.entries.map((entry) => entry.sha),
          perCommitStatus,
          allowedFiles: Array.from(input.allowedFiles),
          changedFiles: Array.from(input.changedFiles),
          violations: input.violations,
          violationSample,
          violationCount: input.violations.length,
          recoverySubtype: input.recoverySubtype ?? null,
          autoReplanAttempt,
          autoReplanMaxAttempts: RETROFIT_PATCH_AUTO_REPLAN_MAX_ATTEMPTS,
          dedupeToken,
        },
      });
      await this.publisher.publishStageMessage(
        input.run.id,
        "planning",
        nextPlanVersion,
        "queued_for_planning",
        true,
        { dedupeToken },
      );
    } catch (publishError) {
      const publishErrorMessage =
        publishError instanceof Error
          ? publishError.message
          : String(publishError);
      logger.error(
        {
          err: publishError,
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          implementationVersion: input.payloadVersion,
          nextPlanVersion,
        },
        "Failed to publish planning message after retrofit patch auto-replan; reverting state to implementing",
      );
      const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        input.run.id,
        "queued_for_planning",
        "implementing",
        {
          current_plan_version: input.run.current_plan_version,
          current_review_version: input.run.current_review_version,
          current_implementation_version:
            input.run.current_implementation_version,
          current_implementation_branch: input.run.current_implementation_branch,
          current_implementation_commit_sha:
            input.run.current_implementation_commit_sha,
          current_code_review_version: input.run.current_code_review_version,
          current_test_version: input.run.current_test_version,
          review_loop_count: input.run.review_loop_count,
          planning_attempt_count: input.run.planning_attempt_count,
          implementation_attempt_count: input.run.implementation_attempt_count,
          code_review_attempt_count: input.run.code_review_attempt_count,
          verification_loop_count: input.run.verification_loop_count,
          final_disposition: input.run.final_disposition,
          last_error: publishErrorMessage,
        },
      );
      if (reverted) {
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: input.run.id,
            event_type: "state_revert",
            from_state: "queued_for_planning",
            to_state: "implementing",
            stage: "implementation",
            metadata_json: {
              reason: "publish_failed",
              originalReason: "retrofit_patch_incomplete_auto_replan",
              version: input.payloadVersion,
              revision: input.revision,
              nextPlanVersion,
              autoReplanAttempt,
              dedupeToken,
              publishError: publishErrorMessage,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: input.run.id,
              eventType: "state_revert",
              stage: "implementation",
            }),
          );
      } else {
        logger.warn(
          {
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            implementationVersion: input.payloadVersion,
            nextPlanVersion,
          },
          "Skipped retrofit patch auto-replan publish-failure revert because run state already moved",
        );
      }
      throw publishError;
    }

    logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        implementationVersion: input.payloadVersion,
        nextPlanVersion,
        violationCount: input.violations.length,
        autoReplanAttempt,
      },
      "Retrofit patch proof failure queued same-run replanning",
    );
  }

  private async blockForPlanContractViolation(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    result: ImplementationFileContractResult;
    reason?: "plan_contract_violation" | "plan_contract_violation_replan_exhausted";
    autoReplansUsed?: number;
  }): Promise<void> {
    const reason = input.reason ?? "plan_contract_violation";
    const violatingSample = input.result.violatingFiles.slice(0, 10);
    const violationText =
      `${violatingSample.join(", ")}${
        input.result.violatingFiles.length > violatingSample.length
          ? ` (+${input.result.violatingFiles.length - violatingSample.length} more)`
          : ""
      }`;
    const lastError =
      reason === "plan_contract_violation_replan_exhausted"
        ? `Plan-contract auto-replan exhausted after ${input.autoReplansUsed ?? PLAN_CONTRACT_AUTO_REPLAN_MAX_ATTEMPTS} attempt(s). Implementation changed files outside the approved plan contract: ${violationText}.`
        : `Implementation changed files outside the approved plan contract: ${violationText}.`;
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "blocked",
      updates: {
        final_disposition: "implementation_blocked",
        last_error: lastError,
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "progress_update",
        body_markdown:
          `# OneShot Implementation Needs Plan Revision\n\n` +
          `${lastError}\n\n` +
          `No pull request was created because the candidate diff exceeded \`fileChangeContract\`. ` +
          (reason === "plan_contract_violation_replan_exhausted"
            ? `Automatic same-run replanning has already been attempted and exhausted. Planner/Validate must approve the additional files or the Implementer must return a structured deviation.`
            : `Planner/Validate must approve the additional files or the Implementer must return a structured deviation.`),
      },
      workspaceCleanupContext: {
        repoAdminBasePath: this.config.repoAdminBasePath,
        repoCacheBasePath: this.config.repoCacheBasePath,
        workspaceBasePath: this.config.workspaceBasePath,
        worktreeBasePath: this.config.worktreeBasePath,
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          reason: "plan_contract_violation",
          violatingFiles: input.result.violatingFiles,
        },
        "Plan-contract implementation block skipped because run state already moved",
      );
      return;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "blocked",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: input.revision,
          reason,
          editableFiles: input.result.editableFiles,
          changedFiles: input.result.changedFiles,
          violatingFiles: input.result.violatingFiles,
          violatingFilesSample: violatingSample,
          violatingFilesCount: input.result.violatingFiles.length,
          autoReplanAttemptsUsed: input.autoReplansUsed ?? null,
          autoReplanMaxAttempts: PLAN_CONTRACT_AUTO_REPLAN_MAX_ATTEMPTS,
        },
      })
      .catch((err: unknown) => {
        logger.warn(
          {
            err,
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            stage: "implementation",
            reason,
          },
          "[EVENT_EMIT_FAILED] state_transition createEvent failed (plan_contract_violation)",
        );
        return undefined;
      });
  }

  private async persistRetrofitNoActionImplementationArtifact(input: {
    run: OneShotRun;
    plan: OneShotPlan;
    payloadVersion: number;
    revision: boolean;
    effectiveBaseCommitSha: string;
    implementationBranch: string;
    implementationCommitSha: string;
    retrofitManifest: RetrofitCommitManifest;
    retrofitContext: PlannerRetrofitContext;
    retrofitSourceEvidence: RetrofitSourceEvidence;
    message: string;
  }): Promise<OneShotImplementation> {
    const implementation = parseOneShotImplementation({
      summary: input.message,
      completedSpecIds: input.plan.specs.map((spec) => spec.id),
      implementedTraceTestIds: [],
      changedFiles: [],
      testCommands: [],
      validationCommands: [],
      validationChecks: [],
      manualVerificationSteps: [],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
      baseCommitSha: input.effectiveBaseCommitSha,
      implementationBranch: input.implementationBranch,
      implementationCommitSha: input.implementationCommitSha,
    });
    const artifactKey = buildOneShotArtifactKey(
      this.config,
      input.run.jira_key,
      input.run.id,
      "implementation",
      input.payloadVersion,
    );
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.artifactBucket,
        Key: artifactKey,
        Body: JSON.stringify(implementation, null, 2),
        ContentType: "application/json",
      }),
    );
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.artifactBucket,
        Key: artifactKey.replace(/\.json$/i, ".md"),
        Body: renderOneShotImplementationMarkdown(input.plan, implementation),
        ContentType: "text/markdown",
      }),
    );
    const selectedShas = input.retrofitManifest.entries.map(
      (entry) => entry.sha,
    );
    await this.oneShotDb.artifacts.upsertArtifact({
      oneshot_run_id: input.run.id,
      stage: "implementation",
      version: input.payloadVersion,
      status: "completed_no_action",
      s3_bucket: this.config.artifactBucket,
      s3_key: artifactKey,
      provider: "system",
      model: null,
      metadata_json: {
        changedFiles: [],
        implementationBranch: input.implementationBranch,
        implementationCommitSha: input.implementationCommitSha,
        baseCommitSha: implementation.baseCommitSha,
        revision: input.revision,
        retrofitManifest: input.retrofitManifest,
        retrofitContext: input.retrofitContext,
        retrofitSourceEvidence: input.retrofitSourceEvidence,
        selectedShas,
        sourceJiraKey: input.retrofitContext.sourceJiraKey,
        sourceBranch: input.retrofitContext.sourceBranch,
        targetBranch: input.retrofitContext.targetBranch,
        commitCount: input.retrofitManifest.entries.length,
        perCommitStatus: input.retrofitManifest.entries.map((entry) => ({
          sha: entry.sha,
          status: entry.status,
        })),
        noActionReason: "retrofit_already_applied",
      },
      started_at: new Date(),
      completed_at: new Date(),
    });

    return implementation;
  }

  /** Route a fully-already-applied retrofit to completed_no_action. */
  private async blockForRetrofitAlreadyApplied(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    message: string;
    implementationBranch: string;
    implementationCommitSha: string;
    retrofitTraceability: RetrofitTraceabilityComment;
  }): Promise<void> {
    const retrofitLines = [
      `- Source Jira: ${input.retrofitTraceability.sourceJiraKey}`,
      `- Source branch: ${input.retrofitTraceability.sourceBranch}`,
      `- Target branch: ${input.retrofitTraceability.targetBranch}`,
      `- Source commit count: ${input.retrofitTraceability.commitCount}`,
      `- Selected SHAs: ${input.retrofitTraceability.selectedShas.join(", ")}`,
      ...input.retrofitTraceability.perCommitStatus.map(
        (entry) => `- ${entry.sha}: ${entry.status}`,
      ),
    ].join("\n");
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "completed",
      updates: {
        current_implementation_version: input.payloadVersion,
        current_implementation_branch: input.implementationBranch,
        current_implementation_commit_sha: input.implementationCommitSha,
        final_disposition: "completed_no_action",
        last_error: null,
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "progress_update",
        body_markdown:
          `# OneShot Retrofit | No Action Required\n\n` +
          `${input.message}\n\n` +
          `## Retrofit Traceability\n\n` +
          `${retrofitLines}\n\n` +
          `No pull request was created because all retrofit source commits are already present on the target branch.`,
      },
      workspaceCleanupContext: {
        repoAdminBasePath: this.config.repoAdminBasePath,
        repoCacheBasePath: this.config.repoCacheBasePath,
        workspaceBasePath: this.config.workspaceBasePath,
        worktreeBasePath: this.config.worktreeBasePath,
      },
    });
    if (!transitioned) {
      logger.warn(
        { runId: input.run.id, jiraKey: input.run.jira_key },
        "Retrofit already-applied completion skipped because run state already moved",
      );
      return;
    }
    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "completed",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: input.revision,
          reason: "retrofit_already_applied",
          message: input.message,
          implementationBranch: input.implementationBranch,
          implementationCommitSha: input.implementationCommitSha,
          sourceJiraKey: input.retrofitTraceability.sourceJiraKey,
          sourceBranch: input.retrofitTraceability.sourceBranch,
          targetBranch: input.retrofitTraceability.targetBranch,
          selectedShas: input.retrofitTraceability.selectedShas,
          perCommitStatus: input.retrofitTraceability.perCommitStatus,
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.run.id,
          eventType: "state_transition",
          stage: "implementation",
        }),
      );
  }

  /** Block a retrofit run when coverage or file-scope validation fails. */
  private async blockForRetrofitPatchIncomplete(input: {
    run: OneShotRun;
    payloadVersion: number;
    revision: boolean;
    violations: string[];
    manifest?: RetrofitCommitManifest;
    retrofitContext?: PlannerRetrofitContext;
    allowedFiles?: readonly string[];
    changedFiles?: readonly string[];
    reason?:
      | "retrofit_patch_incomplete"
      | "retrofit_patch_proof_missing"
      | "retrofit_revision_proof_regressed";
    autoReplansUsed?: number;
  }): Promise<void> {
    const reason = input.reason ?? "retrofit_patch_incomplete";
    const sample = input.violations.slice(0, 5);
    const exhaustedAttempts =
      input.autoReplansUsed ?? RETROFIT_PATCH_AUTO_REPLAN_MAX_ATTEMPTS;
    const lastError =
      (reason === "retrofit_revision_proof_regressed"
        ? `Retrofit revision proof regressed after ${exhaustedAttempts} auto-replan attempt(s): `
        : reason === "retrofit_patch_proof_missing"
          ? `Retrofit patch proof missing after ${exhaustedAttempts} auto-replan attempt(s): `
          : "Retrofit patch incomplete: ") +
      sample.join(" | ") +
      (input.violations.length > sample.length
        ? ` (+${input.violations.length - sample.length} more)`
        : "");
    const perCommitStatus =
      input.manifest?.entries.map((entry) => ({
        sha: entry.sha,
        subject: entry.subject,
        status: entry.status,
        sourceFiles: entry.sourceFiles ?? entry.files,
        targetFiles: entry.targetFiles ?? [],
        adaptationFiles: entry.adaptationFiles ?? [],
        conflictDiagnostics: entry.conflictDiagnostics ?? null,
        proofSnippets: entry.proofSnippets ?? [],
        validationEvidence: entry.validationEvidence ?? [],
        rationale: entry.rationale ?? entry.excludedRationale ?? null,
      })) ?? [];
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "implementing",
      toState: "blocked",
      updates: {
        final_disposition: "implementation_blocked",
        last_error: lastError,
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "progress_update",
        body_markdown:
          `# OneShot Retrofit Patch Incomplete\n\n` +
          `${lastError}\n\n` +
          `The retrofit implementation did not cover all required source commits or modified ` +
          `files outside the source touchedFiles allowlist. ` +
          (reason === "retrofit_revision_proof_regressed"
            ? `Automatic same-run replanning has already been attempted; operator recovery needs a revision that preserves or updates the prior accepted retrofit proof instead of rerunning patch-first proof.`
            : reason === "retrofit_patch_proof_missing"
              ? `Automatic same-run replanning has already been attempted; operator recovery needs a plan that maps or excludes each conflicted source commit with evidence.`
            : ""),
      },
      workspaceCleanupContext: {
        repoAdminBasePath: this.config.repoAdminBasePath,
        repoCacheBasePath: this.config.repoCacheBasePath,
        workspaceBasePath: this.config.workspaceBasePath,
        worktreeBasePath: this.config.worktreeBasePath,
      },
    });
    if (!transitioned) {
      logger.warn(
        { runId: input.run.id, jiraKey: input.run.jira_key },
        "Retrofit patch-incomplete block skipped because run state already moved",
      );
      return;
    }
    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "blocked",
        stage: "implementation",
        metadata_json: {
          version: input.payloadVersion,
          revision: input.revision,
          reason,
          legacyReason: "retrofit_patch_incomplete",
          violations: input.violations,
          sourceJiraKey: input.retrofitContext?.sourceJiraKey ?? null,
          sourceBranch: input.retrofitContext?.sourceBranch ?? null,
          targetBranch: input.retrofitContext?.targetBranch ?? null,
          selectedShas: input.manifest?.entries.map((entry) => entry.sha) ?? [],
          perCommitStatus,
          allowedFiles: input.allowedFiles ? Array.from(input.allowedFiles) : [],
          changedFiles: input.changedFiles ? Array.from(input.changedFiles) : [],
          autoReplanAttemptsUsed: input.autoReplansUsed ?? null,
          autoReplanMaxAttempts: RETROFIT_PATCH_AUTO_REPLAN_MAX_ATTEMPTS,
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.run.id,
          eventType: "state_transition",
          stage: "implementation",
        }),
      );
  }

  private async persistFailedAttemptMetrics(input: {
    runId: number;
    jiraKey: string;
    payloadVersion: number;
    revision: boolean;
    error: unknown;
    failureKind: ImplementerFailureKind;
    failureCategory: ImplementerFailureCategory;
    receiveCount: number;
  }): Promise<void> {
    if (
      !(input.error instanceof ImplementerStallError) ||
      !input.error.metrics
    ) {
      return;
    }

    const metrics = input.error.metrics;
    const tokenUsage = calculateTokenUsage(metrics);
    recordLlmMetrics(
      "implementation",
      "anthropic",
      metrics.durationMs,
      metrics.tokensUsed,
      metrics.costUsd,
      { model: metrics.modelUsed ?? "unknown" },
    );
    if (tokenUsage > 0) {
      await this.oneShotDb.runs.addTokenUsage(input.runId, tokenUsage);
    }

    await this.oneShotDb.events.createEvent({
      oneshot_run_id: input.runId,
      event_type: "stage_attempt_metrics",
      stage: "implementation",
      metadata_json: {
        version: input.payloadVersion,
        revision: input.revision,
        reason: "failed_attempt",
        receiveCount: input.receiveCount,
        failureKind: input.failureKind,
        failureCategory: input.failureCategory,
        model: metrics.modelUsed ?? null,
        stage_tokens_used: tokenUsage,
        tokens_used: metrics.tokensUsed ?? null,
        stage_cost_usd: metrics.costUsd ?? null,
        model_usage: metrics.modelUsage ?? null,
        stage_duration_ms: metrics.durationMs,
        llm_tool_calls: metrics.toolCalls,
      },
    });
  }

  private async loadRevisionContext(runId: number, payloadVersion: number): Promise<{
    codeReviewFindings?: OneShotCodeReview;
    testFailures?: OneShotTestResult;
    validationRetryRequested?: boolean;
    previousCompletedSpecIds?: string[];
    previousSessionNotes?: string;
    previousProviderSessionId?: string;
    previousImplementationVersion?: number;
    priorRetrofitSourceCommitStatuses?: RetrofitSourceCommitStatus[];
    priorRetrofitAdaptationCoverage?: RetrofitAdaptationCoverageEntry[];
  }> {
    const context: {
      codeReviewFindings?: OneShotCodeReview;
      testFailures?: OneShotTestResult;
      validationRetryRequested?: boolean;
      previousCompletedSpecIds?: string[];
      previousSessionNotes?: string;
      previousProviderSessionId?: string;
      previousImplementationVersion?: number;
      priorRetrofitSourceCommitStatuses?: RetrofitSourceCommitStatus[];
      priorRetrofitAdaptationCoverage?: RetrofitAdaptationCoverageEntry[];
    } = {};

    const codeReviewArtifact = await this.oneShotDb.artifacts.getLatestArtifact(
      runId,
      "code_review",
    );
    if (codeReviewArtifact) {
      context.codeReviewFindings = await this.readArtifactJson(
        codeReviewArtifact.s3_bucket,
        codeReviewArtifact.s3_key,
        parseOneShotCodeReview,
      );
    }

    const testArtifact = await this.oneShotDb.artifacts.getLatestArtifact(
      runId,
      "test_result",
    );
    if (testArtifact) {
      context.testFailures = await this.readArtifactJson(
        testArtifact.s3_bucket,
        testArtifact.s3_key,
        parseOneShotTestResult,
      );
    }

    const events = await this.oneShotDb.events.getEventsForRun(runId);
    context.validationRetryRequested = events.some(
      (event) =>
        event.event_type === "state_transition" &&
        event.from_state === "testing" &&
        event.to_state === "queued_for_implementation" &&
        event.stage === "testing" &&
        event.metadata_json?.reason === "validation_failure",
    );

    const implArtifact = await this.oneShotDb.artifacts.getLatestArtifact(
      runId,
      "implementation",
    );
    if (implArtifact) {
      const metadata = implArtifact.metadata_json;
      if (
        metadata &&
        typeof metadata === "object" &&
        !Array.isArray(metadata)
      ) {
        const sessionId = (metadata as Record<string, unknown>).sessionId;
        if (typeof sessionId === "string" && sessionId.length > 0) {
          context.previousProviderSessionId = sessionId;
        }
      }

      const artifactVersion = (implArtifact as { version?: unknown }).version;
      context.previousImplementationVersion =
        typeof artifactVersion === "number"
          ? artifactVersion
          : Math.max(1, payloadVersion - 1);

      const prevImpl = await this.readArtifactJson<{
        completedSpecIds?: string[];
        sessionNotes?: string;
        retrofitSourceCommitStatuses?: unknown;
        retrofitAdaptationCoverage?: unknown;
      }>(implArtifact.s3_bucket, implArtifact.s3_key);
      context.previousCompletedSpecIds = prevImpl.completedSpecIds ?? [];
      context.previousSessionNotes = prevImpl.sessionNotes;
      const priorStatuses = parseRetrofitSourceCommitStatuses(
        prevImpl.retrofitSourceCommitStatuses,
      );
      if (priorStatuses.length > 0) {
        context.priorRetrofitSourceCommitStatuses = priorStatuses;
      }
      const priorCoverage = parseRetrofitAdaptationCoverage(
        prevImpl.retrofitAdaptationCoverage,
      );
      if (priorCoverage.length > 0) {
        context.priorRetrofitAdaptationCoverage = priorCoverage;
      }
    }

    return context;
  }

  private async loadQualificationSummary(
    runId: number,
  ): Promise<QualificationArtifactSummary> {
    const artifact = await this.oneShotDb.artifacts.getLatestArtifact(
      runId,
      "qualification",
    );
    if (!artifact) {
      return {};
    }

    return this.readArtifactJson<QualificationArtifactSummary>(
      artifact.s3_bucket,
      artifact.s3_key,
    );
  }

  private async readArtifactJson<T>(
    bucket: string,
    key: string,
    validator?: (value: unknown) => T,
  ): Promise<T> {
    const response = await this.s3Client.send(
      new GetObjectCommand({ Bucket: bucket, Key: key }),
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
    logger.error(
      {
        runId,
        jiraKey,
        notificationType,
        error: errorMessage,
      },
      "Implementer failing OneShot run",
    );

    const transitioned = await transitionRunWithNotification(this.db, {
      runId,
      fromState: "implementing",
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
                stageLabel: "Implementation",
                errorMessage,
              })
            : buildRunFailedComment({
                assetBaseUrl: this.config.commentAssetBaseUrl,
                jiraKey,
                stageLabel: "Implementation",
                errorMessage,
              }),
      },
      postmortemContext: buildPostmortemContext({
        s3Client: this.s3Client,
        artifactBucket: this.config.artifactBucket,
        artifactPrefix: this.config.artifactPrefix,
        jiraKey,
        failedStage: "implementation",
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
        {
          runId,
          jiraKey,
          notificationType,
        },
        "Implementer failRun skipped because run state already moved",
      );
    }
  }
}
