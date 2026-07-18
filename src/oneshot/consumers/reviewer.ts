import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, type Message } from "@aws-sdk/client-sqs";
import { getDatabase, type Database } from "../../orchestrator/database.js";
import { JiraClient } from "../../orchestrator/JiraClient.js";
import { createS3Client } from "../../utils/awsClients.js";
import { createLogger } from "../../utils/logger.js";
import { QueueConsumerBase } from "../consumer-base.js";
import {
  buildOneShotReviewArtifactKey,
  buildOneShotVerificationOnlyCompletionArtifactKey,
  getOneShotConsumerConfig,
  type OneShotConsumerConfig,
} from "../config.js";
import { parseOneShotQueueMessage } from "../contracts.js";
import { OneShotDatabase } from "../database/index.js";
import { OneShotPublisher } from "../publisher.js";
import { eventEmitFailureLogger } from "../event-emit.js";
import {
  getVisibilityTimeoutFromEnv,
  TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT,
} from "../consumer-visibility.js";
import { buildReviewContext } from "../review-context.js";
import {
  getPlanImpactedFiles,
  getPlanValidationSteps,
  getVerificationOnlyPlanReason,
  parseOneShotPlan,
  type OneShotPlan,
} from "../schema/plan.js";
import {
  parsePlannerRetrofitContext,
  type PlannerRetrofitContext,
} from "../retrofit-context.js";
import { parseOneShotReview, type OneShotReview } from "../schema/review.js";
import {
  parseOneShotTraceArtifact,
  parseOneShotVerifyReport,
} from "../schema/trace-verify.js";
import { runOneShotTraceVerify } from "../trace-verify-runner.js";
import {
  resolveOneShotJiraCredentials,
  type OneShotJiraCredentials,
} from "../jira-credentials.js";
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
import { OpenAiReviewerProvider } from "../providers/openai-reviewer.js";
import { ClaudeReviewerProvider } from "../providers/claude-reviewer.js";
import type {
  ReviewerProvider,
  ReviewerProviderMetrics,
} from "../providers/reviewer-provider.js";
import {
  buildPostmortemContext,
  transitionRunWithNotification,
} from "../state-transitions.js";
import { recordLlmMetrics, reviewLoopCounter } from "../telemetry/metrics.js";
import {
  buildImplementationPlanReadyComment,
  buildBudgetExceededComment,
  buildReviewBlockedComment,
  buildReviewCompletedComment,
  buildReviewEscalatedComment,
  buildRunFailedComment,
  buildVerificationOnlyCompletedComment,
} from "../jira-comments.js";
import { resolveOneShotProcessingMode } from "../processing-mode.js";
import {
  buildPlanContractReviewMessage,
  validateOneShotPlanContract,
  type PlanContractValidationResult,
} from "../plan-contract.js";
import type { OneShotRun } from "../types.js";
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
  isWorkspaceLeaseLossError,
  recoverStageAfterWorkspaceLeaseLoss,
} from "../workspace-lease-errors.js";

import {
  deriveRetrofitAllowedFiles,
  findUnaccountedRetrofitCommits,
  parseRetrofitSourceEvidence,
  type RetrofitCommitManifest,
} from "../retrofit-source-evidence.js";
import {
  parseRetrofitExecutionContract,
  validateRetrofitExecutionContractForPlan,
} from "../retrofit-execution-contract.js";

const logger = createLogger("oneshot-reviewer-consumer");

// ---------------------------------------------------------------------------
// Retrofit coverage and file-scope enforcement helpers (exported for testing)
// ---------------------------------------------------------------------------

/**
 * Validates that every selected source commit in the manifest is accounted for.
 * Returns an array of retrofit_patch_incomplete requiredChange strings for any
 * unaccounted commits. An empty array means full coverage.
 *
 * This reuses the existing requiredChanges/blockingFindings mechanism — it does
 * NOT introduce a new review-decision enum.
 */
export function validateRetrofitCoverage(
  manifest: RetrofitCommitManifest,
): string[] {
  const unaccounted = findUnaccountedRetrofitCommits(manifest);
  if (unaccounted.length === 0) {
    return [];
  }
  return unaccounted.map(
    (entry) =>
      `retrofit_patch_incomplete: Source commit ${entry.sha} ("${entry.subject}") ` +
      `is unaccounted for (status=${entry.status}). ` +
      `All selected source commits must be classified as already_applied, clean_applied, ` +
      `adapted, excluded, or explicitly excluded with a rationale.`,
  );
}

/**
 * Validates that changed files are within the retrofit allowlist
 * (source touchedFiles + explicitly justified adaptation files).
 * Returns an array of retrofit_patch_incomplete requiredChange strings for
 * violating files. Non-retrofit runs should not call this function.
 */
export function validateRetrofitFileScope(
  changedFiles: readonly string[],
  allowedFiles: readonly string[],
): string[] {
  const allowedSet = new Set(allowedFiles.map((f) => f.trim()).filter(Boolean));
  const violating = changedFiles.filter((f) => !allowedSet.has(f.trim()));
  if (violating.length === 0) {
    return [];
  }
  return violating.map(
    (f) =>
      `retrofit_patch_incomplete: Changed file "${f}" is outside the source touchedFiles ` +
      `and adaptation-file allowlist. Only files from the source commit(s) or explicitly ` +
      `justified adaptation targets may be modified.`,
  );
}

// Provider-aware per-run token projection. Anthropic reviewer runs include
// extended thinking and larger tool transcripts so we reserve more headroom.
function projectedReviewerTokens(provider: "openai" | "anthropic"): number {
  return provider === "anthropic" ? 200_000 : 80_000;
}

interface ReviewerConsumerDeps {
  config?: OneShotConsumerConfig;
  db?: Database;
  sqsClient?: SQSClient;
  s3Client?: S3Client;
  publisher?: OneShotPublisher;
  workspaceManager?: OneShotWorkspaceManager;
  promptComposer?: PromptComposer;
  reviewerProvider?: ReviewerProvider;
}

interface ReviewSoftGateContinuation {
  reason: string;
  originalDecision: OneShotReview["decision"];
  errorMessage?: string;
}

type TraceVerifyReason =
  | "approved"
  | "review_loop_exhausted"
  | "blocked_review_loop_exhausted";

interface ReviewerQualificationContext {
  ticketSummary?: string;
  templateMatched?: string;
  processingMode?: string;
  jiraLabels?: string[];
  repoSelectionMetadata?: Record<string, unknown> | null;
}

function extractReviewerRetrofitPromptContext(
  qualificationContext: ReviewerQualificationContext | null,
): {
  retrofitContext?: PlannerRetrofitContext | null;
  retrofitSourceEvidence?: ReturnType<typeof parseRetrofitSourceEvidence>;
} {
  const metadata = qualificationContext?.repoSelectionMetadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return {};
  }
  const record = metadata as Record<string, unknown>;
  return {
    retrofitContext: parsePlannerRetrofitContext(record.retrofitContext),
    retrofitSourceEvidence: parseRetrofitSourceEvidence(
      record.retrofitSourceEvidence,
    ),
  };
}

function hasRetrofitQualificationContext(
  qualificationContext: ReviewerQualificationContext | null,
): boolean {
  const metadata = qualificationContext?.repoSelectionMetadata;
  if (qualificationContext?.templateMatched === "retrofit_template") {
    return true;
  }
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return false;
  }

  const record = metadata as Record<string, unknown>;
  if (parsePlannerRetrofitContext(record.retrofitContext)) {
    return true;
  }

  return record.templateMatched === "retrofit_template";
}

function getUnsupportedRetrofitVerificationOnlyChange(
  plan: OneShotPlan,
  qualificationContext: ReviewerQualificationContext | null,
): string | null {
  if (plan.implementationMode !== "verification_only") {
    return null;
  }

  const evidence = plan.plannerDiscoveries?.retrofitEvidence;
  const isRetrofitPlan =
    Boolean(evidence) || hasRetrofitQualificationContext(qualificationContext);
  if (!isRetrofitPlan) {
    return null;
  }

  const selectedCommits = evidence?.selectedCommits ?? [];
  const allSelectedCommitsAlreadyApplied =
    selectedCommits.length > 0 &&
    selectedCommits.every((commit) => commit.alreadyApplied === true);
  const executionContract = parseRetrofitExecutionContract(
    plan.plannerDiscoveries?.retrofitExecutionContract,
  );
  const contractProvesAlreadyApplied =
    executionContract?.selectedCommits.length
      ? executionContract.selectedCommits.every(
          (commit) => commit.status === "already_applied",
        )
      : false;
  if (
    evidence?.alreadyApplied === true ||
    allSelectedCommitsAlreadyApplied ||
    contractProvesAlreadyApplied
  ) {
    return null;
  }

  return (
    "Retrofit verification_only requires deterministic retrofitEvidence proving " +
    "the exact source patch is already present or patch-equivalent on the target branch. " +
    "Replan against the original source PR/commit files instead of inferring semantic equivalence."
  );
}

function getMissingRetrofitPlanEvidenceChange(
  plan: OneShotPlan,
  qualificationContext: ReviewerQualificationContext | null,
): string | null {
  if (!hasRetrofitQualificationContext(qualificationContext)) {
    return null;
  }

  const selectedCommits =
    plan.plannerDiscoveries?.retrofitEvidence?.selectedCommits ?? [];
  const qualificationSelectedCommits =
    extractReviewerRetrofitPromptContext(qualificationContext)
      .retrofitSourceEvidence?.selectedCommits ?? [];
  if (selectedCommits.length > 0 || qualificationSelectedCommits.length > 0) {
    return null;
  }

  return (
    "Retrofit validation requires selected source commit SHAs from plan retrofitEvidence " +
    "or qualification source evidence. Replan against the original source " +
    "PR/commit evidence instead of reviewing a generic implementation plan."
  );
}

function buildBypassedReview(reason?: string): OneShotReview {
  return parseOneShotReview({
    decision: "APPROVED",
    score: 0,
    coverageAssessment:
      "Plan review was bypassed by configuration; no automated plan validation was performed.",
    blockingFindings: [],
    requiredChanges: [],
    nonBlockingSuggestions: [
      `Reviewer bypassed by ONESHOT_REVIEWER_ENABLED=false. Reason: ${reason ?? "UNSPECIFIED"}`,
    ],
    confidence: "low",
  });
}

function buildSoftGateReview(
  reason: string,
  errorMessage: string,
): OneShotReview {
  return parseOneShotReview({
    decision: "BLOCKED",
    score: 0,
    sageDimensions: [],
    blockingFindings: [errorMessage],
    requiredChanges: [],
    nonBlockingSuggestions: [
      `Soft-gate mode continued the run after Validate could not complete normally. Reason: ${reason}`,
    ],
    confidence: "low",
    coverageAssessment:
      "Plan review did not complete successfully; findings are advisory because soft-gate mode is enabled.",
  });
}

function buildPlanContractReview(
  result: PlanContractValidationResult,
): OneShotReview {
  const message = buildPlanContractReviewMessage(result);
  const criticalFindings = result.findings.filter(
    (finding) => finding.severity === "critical",
  );
  const missingGuardrailIds = result.findings
    .filter((finding) =>
      [
        "missing_guardrail_report",
        "missing_core_guardrail_checks",
        "missing_implementer_guardrails",
        "missing_pfos_guardrail",
        "missing_sonar_guardrail",
        "missing_testing_strategy",
      ].includes(finding.code),
    )
    .flatMap((finding) => finding.guardrailIds ?? [finding.code]);
  const failedGuardrailIds = result.findings
    .filter((finding) => finding.code === "guardrail_failed")
    .flatMap((finding) => finding.guardrailIds ?? []);
  const weakApplicabilityIds = result.findings
    .filter((finding) =>
      [
        "unsupported_pfos_applicability",
        "planned_test_outside_contract",
        "testing_adequacy_without_evidence",
        "missing_automated_test_or_gap",
      ].includes(finding.code),
    )
    .flatMap((finding) => finding.guardrailIds ?? [finding.code]);

  return parseOneShotReview({
    decision: criticalFindings.length > 0 ? "BLOCKED" : "NEEDS_CHANGES",
    score: 0,
    sageDimensions: [],
    blockingFindings: criticalFindings.map((finding) => finding.message),
    requiredChanges:
      criticalFindings.length > 0
        ? []
        : result.findings.map((finding) => finding.message),
    nonBlockingSuggestions: [],
    confidence: "high",
    coverageAssessment:
      "Deterministic OneShot plan contract validation found mandatory guardrail or file-scope issues before LLM review.",
    guardrailAssessment: {
      missingGuardrailIds,
      failedGuardrailIds,
      weakApplicabilityIds,
      decisionImpact:
        criticalFindings.length > 0 ? "blocked" : "needs_changes",
      notes: message || "Plan contract validation failed.",
    },
  });
}

function buildReviewSoftGateMetadata(
  review: OneShotReview,
  softGate: ReviewSoftGateContinuation,
): Record<string, unknown> {
  return {
    softGateContinued: true,
    softGateReason: softGate.reason,
    originalDecision: softGate.originalDecision,
    errorMessage: softGate.errorMessage,
    requiredChanges: review.requiredChanges,
    blockingFindings: review.blockingFindings,
    score: review.score ?? null,
    confidence: review.confidence,
  };
}

function getTraceVerifyReasonForSoftGate(
  softGate: ReviewSoftGateContinuation,
): TraceVerifyReason | undefined {
  if (
    softGate.reason === "review_loop_exhausted" ||
    softGate.reason === "blocked_review_loop_exhausted"
  ) {
    return softGate.reason;
  }
  return undefined;
}

// Budget-facing token total. See note in planner.ts:calculateTokenUsage —
// counts only input + output to avoid overstating spend when prompt caching
// is working well.
function calculateTokenUsage(
  metrics: Pick<ReviewerProviderMetrics, "tokensUsed">,
): number {
  const usage = metrics.tokensUsed;
  if (!usage) {
    return 0;
  }
  return (usage.input || 0) + (usage.output || 0);
}

export class ReviewerConsumer extends QueueConsumerBase {
  private readonly config: OneShotConsumerConfig;
  private readonly db: Database;
  private readonly oneShotDb: OneShotDatabase;
  private readonly publisher: OneShotPublisher;
  private readonly s3Client: S3Client;
  private readonly workspaceManager: OneShotWorkspaceManager;
  private readonly reviewerProvider: ReviewerProvider;

  constructor(private readonly deps: ReviewerConsumerDeps = {}) {
    const config = deps.config ?? getOneShotConsumerConfig();
    const sqsClient =
      deps.sqsClient ?? new SQSClient({ region: config.region });
    super(config.reviewQueueUrl, "review", sqsClient);
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
    this.reviewerProvider =
      deps.reviewerProvider ??
      (config.reviewerProvider === "anthropic"
        ? new ClaudeReviewerProvider(promptComposer, {
            modelId: config.reviewerModelId,
          })
        : new OpenAiReviewerProvider(promptComposer));
  }

  protected getVisibilityTimeoutSeconds(): number {
    // Prod default 900s (15 min). Env-gated for local iteration;
    // invalid/unset falls back to prod.
    return getVisibilityTimeoutFromEnv(
      "ONESHOT_REVIEWER_VISIBILITY_TIMEOUT_SECONDS",
      900,
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
      logger.warn({ payload }, "Dropping review message for missing run");
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
        "Dropping stale review message because run state has moved on",
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
      "reviewing",
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
        to_state: "reviewing",
        stage: "review",
      })
      .catch(() => undefined);

    let providerRetrySoftGateEligible = false;
    let cleanupWorkspace: (() => Promise<void>) | undefined;
    let assertWorkspaceLease: (() => Promise<void>) | undefined;
    let reviewedPlan: OneShotPlan | undefined;
    let qualificationContext: ReviewerQualificationContext | null = null;

    try {
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          planVersion: payload.version,
          revision: payload.revision,
        },
        "Reviewer claimed run",
      );

      const plan = await this.loadPlanArtifact(run.id, payload.version);
      reviewedPlan = plan;
      qualificationContext = await this.loadQualificationContext(run.id);

      let review: OneShotReview | undefined;
      let reviewProvider: string = this.reviewerProvider.providerName;
      let reviewModel: string = this.reviewerProvider.modelId;
      let reviewerDurationMs = 0;
      let reviewerTokensUsed = 0;
      let reviewerTokenUsage: ReviewerProviderMetrics["tokensUsed"] = undefined;
      let reviewerCostUsd: number | null = null;
      let reviewerModelUsage: ReviewerProviderMetrics["modelUsage"] = undefined;
      const [traceArtifact, verifyArtifact] = await Promise.all([
        this.oneShotDb.artifacts.getArtifact(run.id, "trace", payload.version),
        this.oneShotDb.artifacts.getArtifact(run.id, "verify", payload.version),
      ]);
      const trace = traceArtifact
        ? await this.readArtifactJson(
            traceArtifact.s3_bucket,
            traceArtifact.s3_key,
            parseOneShotTraceArtifact,
          )
        : null;
      const verify = verifyArtifact
        ? await this.readArtifactJson(
            verifyArtifact.s3_bucket,
            verifyArtifact.s3_key,
            parseOneShotVerifyReport,
          )
        : null;

      const contractProcessingMode =
        resolveOneShotProcessingMode(qualificationContext);
      const planContractValidation = validateOneShotPlanContract(plan, {
        processingMode: contractProcessingMode,
        jiraLabels: qualificationContext?.jiraLabels,
      });
      if (!planContractValidation.passed) {
        review = buildPlanContractReview(planContractValidation);
        reviewProvider = "deterministic_guardrail";
        reviewModel = "plan-contract-v1";
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            planVersion: payload.version,
            findings: planContractValidation.findings,
          },
          "[PLAN_CONTRACT_BLOCKED] Validate rejected plan before reviewer provider invocation",
        );
      }

      if (!review) {
        const [budgetArtifacts, budgetEvents] = await Promise.all([
          this.oneShotDb.artifacts.getArtifactsForRun(run.id),
          this.oneShotDb.events.getEventsForRun(run.id),
        ]);
        const budgetCheck = checkOneShotTokenBudget({
          run,
          config: this.config,
          stage: "review",
          stageVersion: payload.version,
          artifacts: budgetArtifacts,
          events: budgetEvents,
          projectedTokens: projectedReviewerTokens(
            this.reviewerProvider.providerName,
          ),
        });
        if (!budgetCheck.withinBudget) {
          const errorMessage = formatTokenBudgetFailure("reviewer", budgetCheck);
          if (
            budgetCheck.failureReason === "stage_budget_exceeded" &&
            !this.config.reviewStagesBlockOnExhaustion
          ) {
            const reviewRound = (run.current_review_version ?? 0) + 1;
            const softGateReview = buildSoftGateReview(
              "stage_budget_exceeded",
              errorMessage,
            );
            const softGate: ReviewSoftGateContinuation = {
              reason: "stage_budget_exceeded",
              originalDecision: softGateReview.decision,
              errorMessage,
            };
            await this.persistReviewArtifact({
              run,
              planVersion: payload.version,
              reviewRound,
              review: softGateReview,
              reviewProvider: "soft_gate",
              reviewModel: "advisory",
              reviewerTokensUsed: 0,
              reviewerCostUsd: null,
              reviewerDurationMs: 0,
              softGate,
              assertWorkspaceLease,
            });
            return await this.queueImplementationAfterReview({
              run,
              planVersion: payload.version,
              revision: payload.revision,
              reviewRound,
              review: softGateReview,
              plan,
              ticketSummary: qualificationContext?.ticketSummary,
              softGate,
              assertWorkspaceLease,
            });
          }
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
              from_state: "reviewing",
              to_state: "failed",
              stage: "review",
              metadata_json: tokenBudgetEventMetadata(
                budgetCheck,
                payload.revision,
              ),
            })
            .catch(() => undefined);
          return true;
        }
      }

      if (!review && !this.config.reviewerEnabled) {
        review = buildBypassedReview(this.config.reviewerBypassReason);
        reviewProvider = "config";
        reviewModel = "disabled";
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            planVersion: payload.version,
            bypassReason: this.config.reviewerBypassReason ?? "UNSPECIFIED",
          },
          "[REVIEWER_BYPASSED] Plan auto-approved because ONESHOT_REVIEWER_ENABLED=false",
        );
      } else if (!review) {
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
          "Reviewer preparing workspace",
        );

        const runBranch = await ensureRunBranchContract({
          run,
          repo,
          oneShotDb: this.oneShotDb,
          workspaceManager: this.workspaceManager,
          stage: "reviewer",
          logger,
        });
        const workspace = await this.workspaceManager.prepareReviewerWorkspace(
          run.id,
          repo,
          runBranch.workspaceBaseSha,
          runBranch.branchName,
        );
        cleanupWorkspace = workspace.cleanup;
        assertWorkspaceLease = async () => {
          await workspace.assertLeaseValid?.("review");
        };

        let reviewerResponse;
        const reviewContext = await buildReviewContext(
          workspace.workspacePath,
          plan,
        );

        let priorReviewContext: Record<string, unknown> | null = null;
        if ((run.current_review_version ?? 0) >= 1) {
          const priorReviewArtifact =
            await this.oneShotDb.artifacts.getLatestArtifact(run.id, "review");
          if (priorReviewArtifact) {
            priorReviewContext = await this.readArtifactJson<
              Record<string, unknown>
            >(priorReviewArtifact.s3_bucket, priorReviewArtifact.s3_key);
          }
        }

        const workspaceArtifacts: WorkspaceArtifactFile[] = [
          {
            fileName: `plan.v${payload.version}.json`,
            body: plan,
            format: "json",
          },
          {
            fileName: `plan.v${payload.version}.md`,
            body: renderOneShotPlanMarkdown(plan),
            format: "md",
          },
          {
            fileName: `review-context.v${payload.version}.json`,
            body: reviewContext,
            format: "json",
          },
        ];
        if (priorReviewContext) {
          workspaceArtifacts.push({
            fileName: `review.previous.json`,
            body: priorReviewContext,
            format: "json",
          });
        }
        if (trace) {
          workspaceArtifacts.push({
            fileName: `trace.v${payload.version}.json`,
            body: trace,
            format: "json",
          });
        }
        if (verify) {
          workspaceArtifacts.push({
            fileName: `verify.v${payload.version}.json`,
            body: verify,
            format: "json",
          });
        }
        await materializeRunArtifacts(
          workspace.statePath,
          workspaceArtifacts,
          "reviewer",
        );
        const reviewerStartedAt = new Date().toISOString();
        const reviewerStartedMs = Date.now();
        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            workspacePath: workspace.workspacePath,
            planVersion: payload.version,
            startedAt: reviewerStartedAt,
          },
          "Reviewer invoking provider",
        );
        let jiraLabels: string[] | undefined;
        let processingMode:
          | ReturnType<typeof resolveOneShotProcessingMode>
          | undefined;
        if (qualificationContext) {
          jiraLabels = qualificationContext.jiraLabels;
          processingMode = resolveOneShotProcessingMode(qualificationContext);
        }
        const retrofitPromptContext =
          extractReviewerRetrofitPromptContext(qualificationContext);

        providerRetrySoftGateEligible = true;
        reviewerResponse = await this.reviewerProvider.reviewPlan({
          jiraKey: run.jira_key,
          repoName: repo.repo_name,
          branchName: run.branch_name,
          baseCommitSha: runBranch.workspaceBaseSha,
          workspacePath: workspace.workspacePath,
          plan,
          trace,
          verify,
          reviewContext,
          retrofitContext: retrofitPromptContext.retrofitContext,
          retrofitSourceEvidence: retrofitPromptContext.retrofitSourceEvidence,
          processingMode,
          jiraLabels,
        });
        providerRetrySoftGateEligible = false;
        reviewerDurationMs = Date.now() - reviewerStartedMs;
        reviewerTokenUsage = reviewerResponse.metrics.tokensUsed;
        reviewerCostUsd = reviewerResponse.metrics.costUsd ?? null;
        reviewerModelUsage = reviewerResponse.metrics.modelUsage;
        recordLlmMetrics(
          "review",
          this.reviewerProvider.providerName,
          reviewerResponse.metrics.durationMs,
          reviewerResponse.metrics.tokensUsed,
          reviewerResponse.metrics.costUsd,
        );
        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            planVersion: payload.version,
            completedAt: new Date().toISOString(),
            providerDurationMs: reviewerDurationMs,
          },
          "Reviewer provider completed",
        );

        await assertWorkspaceLease?.();
        providerRetrySoftGateEligible = true;
        review = parseOneShotReview(reviewerResponse.review);
        reviewerTokensUsed = calculateTokenUsage(reviewerResponse.metrics);
        providerRetrySoftGateEligible = false;
      }
      if (!review) {
        throw new Error("Reviewer did not produce a review decision");
      }
      const missingRetrofitPlanEvidenceChange =
        getMissingRetrofitPlanEvidenceChange(plan, qualificationContext);
      if (
        missingRetrofitPlanEvidenceChange &&
        review.decision === "APPROVED" &&
        review.requiredChanges.length === 0 &&
        review.blockingFindings.length === 0
      ) {
        review = parseOneShotReview({
          ...review,
          decision: "NEEDS_CHANGES",
          requiredChanges: [
            missingRetrofitPlanEvidenceChange,
            ...review.requiredChanges,
          ],
          coverageAssessment: [
            review.coverageAssessment,
            missingRetrofitPlanEvidenceChange,
          ]
            .filter(Boolean)
            .join(" "),
        });
      }
      const retrofitVerificationOnlyChange =
        getUnsupportedRetrofitVerificationOnlyChange(
          plan,
          qualificationContext,
        );
      if (
        retrofitVerificationOnlyChange &&
        review.decision === "APPROVED" &&
        review.requiredChanges.length === 0 &&
        review.blockingFindings.length === 0
      ) {
        review = parseOneShotReview({
          ...review,
          decision: "NEEDS_CHANGES",
          requiredChanges: [
            retrofitVerificationOnlyChange,
            ...review.requiredChanges,
          ],
          coverageAssessment: [
            review.coverageAssessment,
            retrofitVerificationOnlyChange,
          ]
            .filter(Boolean)
            .join(" "),
        });
      }

      // Plan-time retrofit file-scope gate: enforce that planned changed files
      // are within source touchedFiles or explicitly justified adaptation files.
      if (hasRetrofitQualificationContext(qualificationContext)) {
        const metadata = qualificationContext?.repoSelectionMetadata;
        const evidenceRaw =
          metadata && typeof metadata === "object"
            ? (metadata as Record<string, unknown>).retrofitSourceEvidence
            : undefined;
        const evidence = parseRetrofitSourceEvidence(evidenceRaw);
        const executionContract = parseRetrofitExecutionContract(
          plan.plannerDiscoveries?.retrofitExecutionContract,
        );
        const contractViolations = validateRetrofitExecutionContractForPlan({
          contract: executionContract,
          evidence:
            evidence ?? plan.plannerDiscoveries?.retrofitEvidence ?? null,
          fileChangeContract: plan.fileChangeContract,
          requireContract: true,
        });
        const retrofitAllowedFiles = deriveRetrofitAllowedFiles(
          evidence ?? plan.plannerDiscoveries?.retrofitEvidence ?? null,
          plan.fileChangeContract,
          executionContract,
        );
        const plannedChangedFiles = (() => {
          const editableFromContract = (plan.fileChangeContract ?? [])
            .filter(
              (e) =>
                e.editable &&
                e.role !== "read_only_evidence" &&
                e.role !== "forbidden",
            )
            .map((e) => e.path);
          const fromSpecs = (plan.specs ?? []).flatMap(
            (spec) => (spec as { targetFiles?: string[] }).targetFiles ?? [],
          );
          return Array.from(new Set([...editableFromContract, ...fromSpecs]));
        })();
        if (contractViolations.length > 0 && review.decision === "APPROVED") {
          review = parseOneShotReview({
            ...review,
            decision: "NEEDS_CHANGES",
            requiredChanges: [
              ...contractViolations,
              ...review.requiredChanges,
            ],
            coverageAssessment: [
              review.coverageAssessment,
              `Retrofit execution contract violation: ${contractViolations[0]}`,
            ]
              .filter(Boolean)
              .join(" "),
          });
        }
        if (
          plan.implementationMode !== "verification_only" &&
          retrofitAllowedFiles.length > 0 &&
          plannedChangedFiles.length > 0
        ) {
          const scopeViolations = validateRetrofitFileScope(
            plannedChangedFiles,
            retrofitAllowedFiles,
          );
          if (scopeViolations.length > 0 && review.decision === "APPROVED") {
            review = parseOneShotReview({
              ...review,
              decision: "NEEDS_CHANGES",
              requiredChanges: [
                ...scopeViolations,
                ...review.requiredChanges,
              ],
              coverageAssessment: [
                review.coverageAssessment,
                `Retrofit file-scope violation: ${scopeViolations[0]}`,
              ]
                .filter(Boolean)
                .join(" "),
            });
          }
        }
      }

      const reviewRound = (run.current_review_version ?? 0) + 1;
      const nextLoopCount = run.review_loop_count + 1;
      const softGate = this.getReviewDecisionSoftGate(
        review,
        nextLoopCount,
        run.max_review_loops,
      );

      await this.persistReviewArtifact({
        run,
        planVersion: payload.version,
        reviewRound,
        review,
        reviewProvider,
        reviewModel,
        reviewerTokensUsed,
        reviewerTokenUsage,
        reviewerCostUsd,
        reviewerDurationMs,
        reviewerModelUsage,
        softGate,
        assertWorkspaceLease,
      });

      if (reviewerTokensUsed > 0) {
        await assertWorkspaceLease?.();
        await this.oneShotDb.runs.addTokenUsage(run.id, reviewerTokensUsed);
      }

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          planVersion: payload.version,
          reviewRound,
          decision: review.decision,
          requiredChangesCount: review.requiredChanges.length,
          blockingFindingsCount: review.blockingFindings.length,
        },
        "Reviewer completed decision",
      );

      if (review.decision === "APPROVED") {
        const verificationOnlyReason =
          review.requiredChanges.length === 0 &&
          review.blockingFindings.length === 0
            ? getVerificationOnlyPlanReason(plan)
            : null;
        if (verificationOnlyReason) {
          return await this.completeVerificationOnlyAfterReview({
            run,
            plan,
            planVersion: payload.version,
            revision: payload.revision,
            reviewRound,
            review,
            reason: verificationOnlyReason,
            ticketSummary: qualificationContext?.ticketSummary,
            traceVerifyReason: "approved",
            assertWorkspaceLease,
          });
        }

        return await this.queueImplementationAfterReview({
          run,
          planVersion: payload.version,
          revision: payload.revision,
          reviewRound,
          review,
          plan,
          ticketSummary: qualificationContext?.ticketSummary,
          bypassedReview: !this.config.reviewerEnabled
            ? {
                reason:
                  this.config.reviewerBypassReason ??
                  "ONESHOT_REVIEWER_ENABLED=false",
              }
            : undefined,
          traceVerifyReason: "approved",
          assertWorkspaceLease,
        });
      }

      if (
        (review.decision === "NEEDS_CHANGES" ||
          (!this.config.reviewStagesBlockOnExhaustion &&
            review.decision === "BLOCKED")) &&
        nextLoopCount <= run.max_review_loops
      ) {
        reviewLoopCounter.add(1, { stage: "review" });
        const nextPlanVersion =
          (run.current_plan_version ?? payload.version) + 1;
        await assertWorkspaceLease?.();
        const transitioned =
          await this.oneShotDb.runs.updateRunStateIfCurrentState(
            run.id,
            "reviewing",
            "queued_for_planning",
            {
              current_review_version: reviewRound,
              review_loop_count: nextLoopCount,
              planning_attempt_count: 0,
              last_error: null,
              final_disposition: null,
            },
          );
        if (!transitioned) {
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              reviewRound,
              nextPlanVersion,
            },
            "Reviewer planning transition skipped because run state already moved",
          );
          return true;
        }
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "reviewing",
            to_state: "queued_for_planning",
            stage: "review",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
              nextPlanVersion,
              planningAttemptCountReset: true,
              previousPlanningAttemptCount: run.planning_attempt_count,
              ...(softGate
                ? buildReviewSoftGateMetadata(review, softGate)
                : {}),
            },
          })
          .catch(() => undefined);

        try {
          await assertWorkspaceLease?.();
          await this.publisher.publishStageMessage(
            run.id,
            "planning",
            nextPlanVersion,
            "queued_for_planning",
            true,
          );
        } catch (publishError) {
          const publishErrorMessage =
            publishError instanceof Error
              ? publishError.message
              : String(publishError);
          logger.error(
            {
              runId: run.id,
              nextPlanVersion,
              error: publishErrorMessage,
            },
            "Failed to publish planning message after reviewer revision request; reverting state to reviewing",
          );
          const reverted =
            await this.oneShotDb.runs.updateRunStateIfCurrentState(
              run.id,
              "queued_for_planning",
              "reviewing",
              {
                current_review_version: run.current_review_version,
                review_loop_count: run.review_loop_count,
                planning_attempt_count: run.planning_attempt_count,
                final_disposition: run.final_disposition,
                last_error: publishErrorMessage,
              },
            );
          if (reverted) {
            this.oneShotDb.events
              .createEvent({
                oneshot_run_id: run.id,
                event_type: "state_revert",
                from_state: "queued_for_planning",
                to_state: "reviewing",
                stage: "review",
                metadata_json: {
                  reason: "publish_failed",
                  version: payload.version,
                  revision: payload.revision,
                  reviewRound,
                  nextPlanVersion,
                  publishError: publishErrorMessage,
                },
              })
              .catch(
                eventEmitFailureLogger({
                  logger,
                  runId: run.id,
                  eventType: "state_revert",
                  stage: "review",
                }),
              );
          } else {
            logger.warn(
              {
                runId: run.id,
                jiraKey: run.jira_key,
                reviewRound,
                nextPlanVersion,
              },
              "Skipped reviewer replanning publish-failure revert because run state already moved",
            );
          }
          throw publishError;
        }

        return true;
      }

      if (softGate && !this.config.reviewStagesBlockOnExhaustion) {
        reviewLoopCounter.add(1, { stage: "review" });
        return await this.queueImplementationAfterReview({
          run,
          planVersion: payload.version,
          revision: payload.revision,
          reviewRound,
          review,
          plan,
          ticketSummary: qualificationContext?.ticketSummary,
          softGate,
          reviewLoopCount: nextLoopCount,
          traceVerifyReason: getTraceVerifyReasonForSoftGate(softGate),
          assertWorkspaceLease,
        });
      }

      if (review.decision === "NEEDS_CHANGES") {
        reviewLoopCounter.add(1, { stage: "review" });
        await assertWorkspaceLease?.();
        const transitioned = await transitionRunWithNotification(this.db, {
          runId: run.id,
          fromState: "reviewing",
          toState: "escalated",
          updates: {
            current_review_version: reviewRound,
            review_loop_count: nextLoopCount,
            final_disposition: "review_escalated",
            last_error: review.requiredChanges.join(" | "),
          },
          notification: {
            oneshot_run_id: run.id,
            jira_key: run.jira_key,
            notification_type: "review_escalated",
            body_markdown: buildReviewEscalatedComment({
              assetBaseUrl: this.config.commentAssetBaseUrl,
              jiraKey: run.jira_key,
              maxReviewLoops: run.max_review_loops,
              requiredChanges: review.requiredChanges,
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
              runId: run.id,
              jiraKey: run.jira_key,
            },
            "Reviewer escalation skipped because run state already moved",
          );
          return true;
        }
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "reviewing",
            to_state: "escalated",
            stage: "review",
            metadata_json: {
              version: payload.version,
              revision: payload.revision,
            },
          })
          .catch(() => undefined);

        return true;
      }

      await assertWorkspaceLease?.();
      const transitioned = await transitionRunWithNotification(this.db, {
        runId: run.id,
        fromState: "reviewing",
        toState: "blocked",
        updates: {
          current_review_version: reviewRound,
          final_disposition: "review_blocked",
          last_error: review.blockingFindings.join(" | "),
        },
        notification: {
          oneshot_run_id: run.id,
          jira_key: run.jira_key,
          notification_type: "review_blocked",
          body_markdown: buildReviewBlockedComment({
            assetBaseUrl: this.config.commentAssetBaseUrl,
            jiraKey: run.jira_key,
            blockingFindings: review.blockingFindings,
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
            runId: run.id,
            jiraKey: run.jira_key,
          },
          "Reviewer block transition skipped because run state already moved",
        );
        return true;
      }
      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "reviewing",
          to_state: "blocked",
          stage: "review",
          metadata_json: {
            version: payload.version,
            revision: payload.revision,
          },
        })
        .catch(() => undefined);

      return true;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        {
          runId: run.id,
          receiveCount,
          error: errorMessage,
        },
        "Reviewer consumer failed to process run",
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
        });
      }

      if (receiveCount >= TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT) {
        if (
          !this.config.reviewStagesBlockOnExhaustion &&
          providerRetrySoftGateEligible
        ) {
          const reviewRound = (run.current_review_version ?? 0) + 1;
          const review = buildSoftGateReview(
            "provider_retry_exhausted",
            errorMessage,
          );
          const softGate: ReviewSoftGateContinuation = {
            reason: "provider_retry_exhausted",
            originalDecision: review.decision,
            errorMessage,
          };
          const plan =
            reviewedPlan ??
            (await this.loadPlanArtifact(run.id, payload.version));
          reviewedPlan = plan;
          qualificationContext ??= await this.loadQualificationContext(run.id);
          await this.persistReviewArtifact({
            run,
            planVersion: payload.version,
            reviewRound,
            review,
            reviewProvider: "soft_gate",
            reviewModel: "advisory",
            reviewerTokensUsed: 0,
            reviewerCostUsd: null,
            reviewerDurationMs: 0,
            softGate,
            assertWorkspaceLease,
          });
          return await this.queueImplementationAfterReview({
            run,
            planVersion: payload.version,
            revision: payload.revision,
            reviewRound,
            review,
            plan,
            ticketSummary: qualificationContext?.ticketSummary,
            softGate,
            assertWorkspaceLease,
          });
        }
        await this.failRun(run.id, run.jira_key, "run_failed", errorMessage);
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "reviewing",
            to_state: "failed",
            stage: "review",
            metadata_json: { reason: "run_failed", receiveCount },
          })
          .catch(() => undefined);
        return true;
      }

      logger.warn(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          nextState: "queued_for_review",
          error: errorMessage,
        },
        "Reviewer returning run to queue after transient failure",
      );

      const requeued = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        run.id,
        "reviewing",
        "queued_for_review",
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
          "Reviewer retry skipped because run state already moved",
        );
        return true;
      }

      const retryMeta = await this.shortenVisibilityForTransientRetry(message, receiveCount);

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "reviewing",
          to_state: "queued_for_review",
          stage: "review",
          metadata_json: { reason: "retry", receiveCount, transientRetry: retryMeta },
        })
        .catch(() => undefined);
      return false;
    } finally {
      await cleanupWorkspace?.().catch(() => undefined);
    }
  }

  private async loadPlanArtifact(
    runId: number,
    planVersion: number,
  ): Promise<OneShotPlan> {
    const planArtifact = await this.oneShotDb.artifacts.getArtifact(
      runId,
      "plan",
      planVersion,
    );
    if (!planArtifact) {
      throw new Error(
        `Missing plan artifact v${planVersion} for oneshot run ${runId}`,
      );
    }

    return this.readArtifactJson(
      planArtifact.s3_bucket,
      planArtifact.s3_key,
      parseOneShotPlan,
    );
  }

  private async loadQualificationContext(
    runId: number,
  ): Promise<ReviewerQualificationContext | null> {
    const qualArtifact = await this.oneShotDb.artifacts
      .getLatestArtifact(runId, "qualification")
      .catch(() => null);
    if (!qualArtifact) {
      return null;
    }

    try {
      return await this.readArtifactJson<ReviewerQualificationContext>(
        qualArtifact.s3_bucket,
        qualArtifact.s3_key,
      );
    } catch {
      // Non-fatal — Validate still runs without qualification extensions.
      return null;
    }
  }

  private async runTraceVerifyAfterValidation(input: {
    run: OneShotRun;
    plan: OneShotPlan;
    planVersion: number;
    ticketSummary?: string;
    traceVerifyReason: TraceVerifyReason;
    assertWorkspaceLease?: () => Promise<void>;
  }): Promise<void> {
    const traceVerify = await runOneShotTraceVerify(
      {
        config: this.config,
        oneShotDb: this.oneShotDb,
        s3Client: this.s3Client,
        visibilityTimeoutSeconds: this.getVisibilityTimeoutSeconds(),
        jiraCredentials: await this.resolveJiraCredentials(),
      },
      {
        run: input.run,
        plan: input.plan,
        planVersion: input.planVersion,
        ticketSummary: input.ticketSummary,
        stageStartedMs: Date.now(),
        eventStage: "review",
        eventState: "reviewing",
        assertWorkspaceLease: input.assertWorkspaceLease,
      },
    );
    if (traceVerify.verify?.recommendation !== "REJECTED") {
      return;
    }

    const rejectionSummary = traceVerify.verify.gaps
      .slice(0, 5)
      .map((gap) => `${gap.severity}:${gap.id}:${gap.message}`)
      .join(", ");
    logger.warn(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        planVersion: input.planVersion,
        traceVerifyReason: input.traceVerifyReason,
        verifyRecommendation: traceVerify.verify.recommendation,
        verifyRiskLevel: traceVerify.verify.riskLevel,
        verifyGapCount: traceVerify.verify.gaps.length,
        rejectionSummary: rejectionSummary || "no gap details",
      },
      "VERIFY rejected final TRACE output; continuing with advisory rejection context",
    );
  }

  private getReviewDecisionSoftGate(
    review: OneShotReview,
    nextLoopCount: number,
    maxReviewLoops: number,
  ): ReviewSoftGateContinuation | undefined {
    if (
      this.config.reviewStagesBlockOnExhaustion ||
      review.decision === "APPROVED"
    ) {
      return undefined;
    }

    if (review.decision === "BLOCKED" && nextLoopCount <= maxReviewLoops) {
      return {
        reason: "blocked_replanned",
        originalDecision: review.decision,
      };
    }

    if (review.decision === "BLOCKED") {
      return {
        reason: "blocked_review_loop_exhausted",
        originalDecision: review.decision,
      };
    }

    if (review.decision === "NEEDS_CHANGES" && nextLoopCount > maxReviewLoops) {
      return {
        reason: "review_loop_exhausted",
        originalDecision: review.decision,
      };
    }

    return undefined;
  }

  private async persistReviewArtifact(input: {
    run: Pick<OneShotRun, "id" | "jira_key">;
    planVersion: number;
    reviewRound: number;
    review: OneShotReview;
    reviewProvider: string;
    reviewModel: string;
    reviewerTokensUsed: number;
    reviewerTokenUsage?: ReviewerProviderMetrics["tokensUsed"];
    reviewerCostUsd: number | null;
    reviewerDurationMs: number;
    reviewerModelUsage?: ReviewerProviderMetrics["modelUsage"];
    softGate?: ReviewSoftGateContinuation;
    assertWorkspaceLease?: () => Promise<void>;
  }): Promise<void> {
    const artifactKey = buildOneShotReviewArtifactKey(
      this.config,
      input.run.jira_key,
      input.run.id,
      input.planVersion,
      input.reviewRound,
    );

    logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        planVersion: input.planVersion,
        reviewRound: input.reviewRound,
        artifactKey,
        softGateReason: input.softGate?.reason,
      },
      "Reviewer writing review artifact",
    );

    await input.assertWorkspaceLease?.();
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.artifactBucket,
        Key: artifactKey,
        Body: JSON.stringify(input.review, null, 2),
        ContentType: "application/json",
      }),
    );

    await input.assertWorkspaceLease?.();
    await this.oneShotDb.artifacts.upsertArtifact({
      oneshot_run_id: input.run.id,
      stage: "review",
      version: input.reviewRound,
      status: "completed",
      s3_bucket: this.config.artifactBucket,
      s3_key: artifactKey,
      provider: input.reviewProvider,
      model: input.reviewModel,
      metadata_json: {
        decision: input.review.decision,
        plan_version: input.planVersion,
        bypassed: !this.config.reviewerEnabled,
        stage_tokens_used: input.reviewerTokensUsed,
        tokens_used: input.reviewerTokenUsage ?? null,
        stage_cost_usd: input.reviewerCostUsd,
        model_usage: input.reviewerModelUsage ?? null,
        stage_duration_ms: input.reviewerDurationMs,
        ...(input.softGate
          ? buildReviewSoftGateMetadata(input.review, input.softGate)
          : {}),
      },
      started_at: new Date(Date.now() - input.reviewerDurationMs),
      completed_at: new Date(),
    });
  }

  private async queueImplementationAfterReview(input: {
    run: OneShotRun;
    plan: OneShotPlan;
    planVersion: number;
    revision: boolean;
    reviewRound: number;
    review: OneShotReview;
    ticketSummary?: string;
    softGate?: ReviewSoftGateContinuation;
    bypassedReview?: {
      reason: string;
    };
    reviewLoopCount?: number;
    traceVerifyReason?: TraceVerifyReason;
    assertWorkspaceLease?: () => Promise<void>;
  }): Promise<boolean> {
    const implementationVersion =
      (input.run.current_implementation_version ?? 0) + 1;
    if (input.traceVerifyReason) {
      await this.runTraceVerifyAfterValidation({
        run: input.run,
        plan: input.plan,
        planVersion: input.planVersion,
        ticketSummary: input.ticketSummary,
        traceVerifyReason: input.traceVerifyReason,
        assertWorkspaceLease: input.assertWorkspaceLease,
      });
    }
    await input.assertWorkspaceLease?.();
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "reviewing",
      toState: "queued_for_implementation",
      updates: {
        current_review_version: input.reviewRound,
        current_implementation_version: implementationVersion,
        ...(input.reviewLoopCount !== undefined
          ? { review_loop_count: input.reviewLoopCount }
          : {}),
        last_error: null,
        final_disposition: null,
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "review_completed",
        body_markdown: buildReviewCompletedComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey: input.run.jira_key,
          review: input.review,
          softGate: input.softGate
            ? { reason: input.softGate.reason }
            : undefined,
          bypassedReview: input.bypassedReview,
        }),
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
        },
        "Reviewer implementation transition skipped because run state already moved",
      );
      return true;
    }
    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "state_transition",
        from_state: "reviewing",
        to_state: "queued_for_implementation",
        stage: "review",
        metadata_json: {
          version: input.planVersion,
          revision: input.revision,
          reviewBypassed: Boolean(input.bypassedReview),
          bypassReason: input.bypassedReview?.reason,
          ...(input.softGate
            ? buildReviewSoftGateMetadata(input.review, input.softGate)
            : {}),
        },
      })
      .catch(() => undefined);

    try {
      await input.assertWorkspaceLease?.();
      await this.publisher.publishStageMessage(
        input.run.id,
        "implementation",
        implementationVersion,
        "queued_for_implementation",
        false,
      );
      await this.enqueueImplementationPlanReadyNotification({
        run: input.run,
        plan: input.plan,
        planVersion: input.planVersion,
        reviewRound: input.reviewRound,
        implementationVersion,
        softGate: input.softGate,
        bypassedReview: input.bypassedReview,
      });
    } catch (publishError) {
      const publishErrorMessage =
        publishError instanceof Error
          ? publishError.message
          : String(publishError);
      logger.error(
        {
          runId: input.run.id,
          reviewRound: input.reviewRound,
          implementationVersion,
          error: publishErrorMessage,
        },
        "Failed to publish implementation message after review completion; reverting state to reviewing",
      );
      const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        input.run.id,
        "queued_for_implementation",
        "reviewing",
        {
          current_review_version: input.run.current_review_version,
          current_implementation_version:
            input.run.current_implementation_version,
          review_loop_count: input.run.review_loop_count,
          last_error: publishErrorMessage,
        },
      );
      if (reverted) {
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: input.run.id,
            event_type: "state_revert",
            from_state: "queued_for_implementation",
            to_state: "reviewing",
            stage: "review",
            metadata_json: {
              reason: "publish_failed",
              version: input.planVersion,
              revision: input.revision,
              reviewRound: input.reviewRound,
              implementationVersion,
              publishError: publishErrorMessage,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: input.run.id,
              eventType: "state_revert",
              stage: "review",
            }),
          );
      } else {
        logger.warn(
          {
            runId: input.run.id,
            reviewRound: input.reviewRound,
            implementationVersion,
          },
          "Skipped review publish-failure revert because run state already moved",
        );
      }
      throw publishError;
    }

    return true;
  }

  private async enqueueImplementationPlanReadyNotification(input: {
    run: OneShotRun;
    plan: OneShotPlan;
    planVersion: number;
    reviewRound: number;
    implementationVersion: number;
    softGate?: ReviewSoftGateContinuation;
    bypassedReview?: {
      reason: string;
    };
  }): Promise<void> {
    if (!this.config.implementationPlanPostToJira) {
      return;
    }

    const filename = `implementation-plan-${input.run.jira_key}-v${input.planVersion}-r${input.reviewRound}.md`;
    const priorPost = await this.getImplementationPlanJiraPostCompletion(
      input.run.id,
      filename,
    );
    const attachmentAlreadyCompleted = priorPost.attachmentCompleted;
    const commentAlreadyQueued = priorPost.commentQueued;
    let attachmentStatus: "attached" | "skipped" | "failed" =
      attachmentAlreadyCompleted ? "attached" : "skipped";
    let attachmentError: string | undefined;
    let commentStatus: "enqueued" | "failed" = commentAlreadyQueued
      ? "enqueued"
      : "failed";
    let commentError: string | undefined;
    let notificationId: number | undefined = priorPost.notificationId;

    if (attachmentAlreadyCompleted) {
      logger.info(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          filename,
        },
        "Skipping implementation plan Jira attachment because it already completed",
      );
    } else {
      const jiraBaseUrl = process.env.JIRA_BASE_URL?.trim();
      const jiraCredentials = await this.resolveJiraCredentials();
      if (jiraBaseUrl && jiraCredentials?.username && jiraCredentials.token) {
        try {
          const attachmentResult = await new JiraClient({
            baseUrl: jiraBaseUrl,
            username: jiraCredentials.username,
            token: jiraCredentials.token,
          }).attachFileToIssue(
            input.run.jira_key,
            filename,
            renderOneShotPlanMarkdown(input.plan),
            "text/markdown",
          );
          if (attachmentResult.status === "attached") {
            attachmentStatus = "attached";
          } else {
            attachmentStatus = "skipped";
            attachmentError = attachmentResult.reason;
            this.oneShotDb.events
              .createEvent({
                oneshot_run_id: input.run.id,
                event_type: "implementation_plan_jira_attachment_skipped",
                from_state: "reviewing",
                to_state: "queued_for_implementation",
                stage: "review",
                metadata_json: {
                  filename,
                  reason: attachmentResult.reason,
                  credentialSource: jiraCredentials.source,
                },
              })
              .catch(
                eventEmitFailureLogger({
                  logger,
                  runId: input.run.id,
                  eventType: "implementation_plan_jira_attachment_skipped",
                  stage: "review",
                }),
              );
          }
        } catch (error) {
          attachmentStatus = "failed";
          attachmentError = error instanceof Error ? error.message : String(error);
          this.oneShotDb.events
            .createEvent({
              oneshot_run_id: input.run.id,
              event_type: "implementation_plan_jira_attachment_failed",
              from_state: "reviewing",
              to_state: "queued_for_implementation",
              stage: "review",
              metadata_json: {
                filename,
                error: attachmentError,
                credentialSource: jiraCredentials.source,
              },
            })
            .catch(
              eventEmitFailureLogger({
                logger,
                runId: input.run.id,
                eventType: "implementation_plan_jira_attachment_failed",
                stage: "review",
              }),
            );
        }
      } else {
        attachmentError =
          "Jira attachment skipped because Jira base URL or usable Jira credentials are not configured in the reviewer environment.";
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: input.run.id,
            event_type: "implementation_plan_jira_attachment_skipped",
            from_state: "reviewing",
            to_state: "queued_for_implementation",
            stage: "review",
            metadata_json: {
              filename,
              reason: "missing_jira_credentials",
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: input.run.id,
              eventType: "implementation_plan_jira_attachment_skipped",
              stage: "review",
            }),
          );
      }
    }

    if (commentAlreadyQueued) {
      logger.info(
        {
          runId: input.run.id,
          jiraKey: input.run.jira_key,
          filename,
          notificationId,
        },
        "Skipping implementation plan Jira comment because it was already queued",
      );
    } else {
      try {
        notificationId = await this.oneShotDb.notifications.createNotification({
          oneshot_run_id: input.run.id,
          jira_key: input.run.jira_key,
          notification_type: "implementation_plan_ready",
          body_markdown: buildImplementationPlanReadyComment({
            assetBaseUrl: this.config.commentAssetBaseUrl,
            jiraKey: input.run.jira_key,
            plan: input.plan,
            planVersion: input.planVersion,
            reviewRound: input.reviewRound,
            implementationVersion: input.implementationVersion,
            planAttachment: {
              filename,
              status: attachmentStatus,
              error: attachmentError,
            },
            softGate: input.softGate
              ? { reason: input.softGate.reason }
              : undefined,
            bypassedReview: input.bypassedReview,
          }),
        });
        commentStatus = "enqueued";
      } catch (error) {
        commentError = error instanceof Error ? error.message : String(error);
        logger.warn(
          {
            runId: input.run.id,
            jiraKey: input.run.jira_key,
            planVersion: input.planVersion,
            reviewRound: input.reviewRound,
            implementationVersion: input.implementationVersion,
            error: commentError,
          },
          "Failed to enqueue implementation plan Jira notification after implementation publish",
        );
        await this.oneShotDb.events
          .createEvent({
            oneshot_run_id: input.run.id,
            event_type: "implementation_plan_ready_notification_failed",
            from_state: "reviewing",
            to_state: "queued_for_implementation",
            stage: "review",
            metadata_json: {
              filename,
              planVersion: input.planVersion,
              reviewRound: input.reviewRound,
              implementationVersion: input.implementationVersion,
              error: commentError,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: input.run.id,
              eventType: "implementation_plan_ready_notification_failed",
              stage: "review",
            }),
          );
      }
    }

    await this.recordImplementationPlanJiraPostCompleted({
      runId: input.run.id,
      filename,
      planVersion: input.planVersion,
      reviewRound: input.reviewRound,
      implementationVersion: input.implementationVersion,
      attachmentStatus,
      commentStatus,
      notificationId,
      attachmentAlreadyCompleted,
      commentAlreadyQueued,
      attachmentError,
      commentError,
    });
  }

  private async getImplementationPlanJiraPostCompletion(
    runId: number,
    filename: string,
  ): Promise<{
    attachmentCompleted: boolean;
    commentQueued: boolean;
    notificationId?: number;
  }> {
    try {
      const events = await this.oneShotDb.events.getEventsForRun(runId);
      const matchingEvents = events.filter(
        (event) =>
          event.event_type === "implementation_plan_jira_post_completed" &&
          event.metadata_json?.filename === filename,
      );

      let notificationId: number | undefined;
      for (const event of matchingEvents) {
        const recordedId = event.metadata_json?.notificationId;
        if (typeof recordedId === "number") {
          notificationId = recordedId;
        }
      }

      return {
        attachmentCompleted: matchingEvents.some(
          (event) => event.metadata_json?.attachmentStatus === "attached",
        ),
        commentQueued: matchingEvents.some(
          (event) => event.metadata_json?.commentStatus === "enqueued",
        ),
        notificationId,
      };
    } catch (error) {
      logger.warn(
        {
          runId,
          filename,
          error: error instanceof Error ? error.message : String(error),
        },
        "Unable to check implementation plan Jira post idempotency marker; proceeding with post attempt",
      );
      return { attachmentCompleted: false, commentQueued: false };
    }
  }

  private async recordImplementationPlanJiraPostCompleted(input: {
    runId: number;
    filename: string;
    planVersion: number;
    reviewRound: number;
    implementationVersion: number;
    attachmentStatus: "attached" | "skipped" | "failed";
    commentStatus: "enqueued" | "failed";
    notificationId?: number;
    attachmentAlreadyCompleted?: boolean;
    commentAlreadyQueued?: boolean;
    attachmentError?: string;
    commentError?: string;
  }): Promise<void> {
    try {
      await this.oneShotDb.events.createEvent({
        oneshot_run_id: input.runId,
        event_type: "implementation_plan_jira_post_completed",
        from_state: "reviewing",
        to_state: "queued_for_implementation",
        stage: "review",
        metadata_json: {
          filename: input.filename,
          planVersion: input.planVersion,
          reviewRound: input.reviewRound,
          implementationVersion: input.implementationVersion,
          attachmentStatus: input.attachmentStatus,
          commentStatus: input.commentStatus,
          notificationId: input.notificationId,
          attachmentAlreadyCompleted: input.attachmentAlreadyCompleted,
          commentAlreadyQueued: input.commentAlreadyQueued,
          attachmentError: input.attachmentError,
          commentError: input.commentError,
        },
      });
    } catch (error) {
      logger.warn(
        {
          runId: input.runId,
          filename: input.filename,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to record implementation plan Jira post idempotency marker",
      );
    }
  }

  private async completeVerificationOnlyAfterReview(input: {
    run: OneShotRun;
    plan: OneShotPlan;
    planVersion: number;
    revision: boolean;
    reviewRound: number;
    review: OneShotReview;
    reason: string;
    ticketSummary?: string;
    traceVerifyReason?: TraceVerifyReason;
    assertWorkspaceLease?: () => Promise<void>;
  }): Promise<boolean> {
    const completedAt = new Date();
    if (input.traceVerifyReason) {
      await this.runTraceVerifyAfterValidation({
        run: input.run,
        plan: input.plan,
        planVersion: input.planVersion,
        ticketSummary: input.ticketSummary,
        traceVerifyReason: input.traceVerifyReason,
        assertWorkspaceLease: input.assertWorkspaceLease,
      });
    }
    const targetFiles = getPlanImpactedFiles(input.plan);
    const validationSteps = getPlanValidationSteps(input.plan);
    const completionArtifactKey =
      buildOneShotVerificationOnlyCompletionArtifactKey(
        this.config,
        input.run.jira_key,
        input.run.id,
        input.planVersion,
      );
    const completionArtifact = {
      schemaVersion: 1,
      disposition: "completed_no_action",
      completedAt: completedAt.toISOString(),
      jiraKey: input.run.jira_key,
      runId: input.run.id,
      planVersion: input.planVersion,
      reviewRound: input.reviewRound,
      implementationMode: input.plan.implementationMode ?? "code_change",
      reason: input.reason,
      repoName: input.plan.repoName,
      branchName: input.plan.branchName,
      baseCommitSha: input.plan.baseCommitSha,
      targetFiles,
      validationSteps,
      review: {
        decision: input.review.decision,
        confidence: input.review.confidence,
        score: input.review.score ?? null,
        coverageAssessment: input.review.coverageAssessment,
        nonBlockingSuggestions: input.review.nonBlockingSuggestions,
      },
    };

    await input.assertWorkspaceLease?.();
    await this.s3Client.send(
      new PutObjectCommand({
        Bucket: this.config.artifactBucket,
        Key: completionArtifactKey,
        Body: JSON.stringify(completionArtifact, null, 2),
        ContentType: "application/json",
      }),
    );

    await input.assertWorkspaceLease?.();
    const metadataMerged = await this.oneShotDb.artifacts.mergeArtifactMetadata(
      input.run.id,
      "review",
      input.reviewRound,
      {
        artifact_kind: "verification_only_completion",
        verification_only_completion: {
          s3_bucket: this.config.artifactBucket,
          s3_key: completionArtifactKey,
          completed_at: completedAt.toISOString(),
          reason: input.reason,
          target_files: targetFiles,
          validation_steps: validationSteps,
        },
      },
    );
    if (!metadataMerged) {
      throw new Error(
        `Unable to attach verification-only completion metadata to review artifact v${input.reviewRound}`,
      );
    }

    await input.assertWorkspaceLease?.();
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: input.run.id,
      fromState: "reviewing",
      toState: "completed",
      updates: {
        current_review_version: input.reviewRound,
        last_error: null,
        final_disposition: "completed_no_action",
      },
      notification: {
        oneshot_run_id: input.run.id,
        jira_key: input.run.jira_key,
        notification_type: "verification_only_completed",
        body_markdown: buildVerificationOnlyCompletedComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey: input.run.jira_key,
          plan: input.plan,
          review: input.review,
          reason: input.reason,
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
          reviewRound: input.reviewRound,
        },
        "Reviewer verification-only completion skipped because run state already moved",
      );
      return true;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.run.id,
        event_type: "verification_only_completed",
        from_state: "reviewing",
        to_state: "completed",
        stage: "review",
        metadata_json: {
          version: input.planVersion,
          revision: input.revision,
          reviewRound: input.reviewRound,
          reason: input.reason,
          targetFiles,
          validationSteps,
          completionArtifact: {
            s3_bucket: this.config.artifactBucket,
            s3_key: completionArtifactKey,
          },
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.run.id,
          eventType: "verification_only_completed",
          stage: "review",
        }),
      );

    return true;
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
    logger.error(
      {
        runId,
        jiraKey,
        notificationType,
        error: errorMessage,
      },
      "Reviewer failing OneShot run",
    );

    const transitioned = await transitionRunWithNotification(this.db, {
      runId,
      fromState: "reviewing",
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
                stageLabel: "Review",
                errorMessage,
              })
            : buildRunFailedComment({
                assetBaseUrl: this.config.commentAssetBaseUrl,
                jiraKey,
                stageLabel: "Review",
                errorMessage,
              }),
      },
      postmortemContext: buildPostmortemContext({
        s3Client: this.s3Client,
        artifactBucket: this.config.artifactBucket,
        artifactPrefix: this.config.artifactPrefix,
        jiraKey,
        failedStage: "review",
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
        "Reviewer failRun skipped because run state already moved",
      );
    }
  }

  private async resolveJiraCredentials(): Promise<OneShotJiraCredentials | null> {
    return resolveOneShotJiraCredentials({
      getAgentByName: (name) => this.db.getAgentByName(name),
      fallbackUsername: process.env.JIRA_USERNAME,
      fallbackToken: process.env.JIRA_TOKEN,
      logger,
      warningMessage:
        "Unable to load QUALIFIER Jira credentials for reviewer Jira posting; falling back to reviewer environment credentials",
    });
  }
}
