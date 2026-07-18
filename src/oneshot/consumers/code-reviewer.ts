import {
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { SQSClient, type Message } from "@aws-sdk/client-sqs";
import { getDatabase, type Database } from "../../orchestrator/database.js";
import { createS3Client } from "../../utils/awsClients.js";
import { createLogger } from "../../utils/logger.js";
import { QueueConsumerBase } from "../consumer-base.js";
import {
  buildOneShotArtifactKey,
  getOneShotConsumerConfig,
  type OneShotConsumerConfig,
} from "../config.js";
import { parseOneShotQueueMessage } from "../contracts.js";
import { OneShotDatabase } from "../database/index.js";
import { OneShotPublisher } from "../publisher.js";
import { isDeterministicFailure } from "../retry-classifier.js";
import {
  getVisibilityTimeoutFromEnv,
  TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT,
} from "../consumer-visibility.js";
import { buildCodeReviewContext } from "../code-review-context.js";
import { parseOneShotPlan, type OneShotPlan } from "../schema/plan.js";
import { parseOneShotImplementation } from "../schema/implementation.js";
import { parsePlannerRetrofitContext } from "../retrofit-context.js";
import { parseRetrofitSourceEvidence } from "../retrofit-source-evidence.js";
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
import { ensureRunBranchContract } from "../run-branch-contract.js";
import { OpenAiCodeReviewerProvider } from "../providers/openai-code-reviewer.js";
import { ClaudeCodeReviewerProvider } from "../providers/claude-code-reviewer.js";
import type {
  CodeReviewerProvider,
  ReviewerProviderMetrics,
} from "../providers/reviewer-provider.js";
import {
  parseOneShotCodeReview,
  type OneShotCodeReview,
} from "../schema/code-review.js";
import {
  materializeRunArtifacts,
  type WorkspaceArtifactFile,
} from "../workspace-artifacts.js";
import { ensureDraftPullRequest, parseGitHubRepoUrl } from "../github.js";
import {
  loadRunQualificationSummary,
  loadRunTicketSummary,
} from "../qualification-artifact.js";
import { resolveOneShotProcessingMode } from "../processing-mode.js";
import { buildOneShotPullRequestTitle } from "../pr-title.js";
import {
  buildPostmortemContext,
  transitionRunWithNotification,
} from "../state-transitions.js";
import {
  recordLlmMetrics,
  verificationLoopCounter,
} from "../telemetry/metrics.js";
import {
  buildBudgetExceededComment,
  buildCodeReviewBlockedComment,
  buildCodeReviewCompletedComment,
  buildCodeReviewEscalatedComment,
  buildRunFailedComment,
} from "../jira-comments.js";
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
import { eventEmitFailureLogger } from "../event-emit.js";
import { getCurrentHeadSha } from "../git.js";
import {
  evaluateCandidateShaGuard,
  recordCandidateShaIntegrityFailure,
} from "../stage-candidate-guard.js";
import {
  isWorkspaceLeaseLossError,
  recoverStageAfterWorkspaceLeaseLoss,
} from "../workspace-lease-errors.js";
import { applySonarRemediationGuard } from "../sonar-remediation-guard.js";

const logger = createLogger("oneshot-code-reviewer-consumer");

// Provider-aware per-run token projection. Anthropic runs (with extended
// thinking and larger tool transcripts) need more headroom than the OpenAI
// reasoning path.
function projectedCodeReviewerTokens(provider: "openai" | "anthropic"): number {
  return provider === "anthropic" ? 300_000 : 120_000;
}

interface CodeReviewerConsumerDeps {
  config?: OneShotConsumerConfig;
  db?: Database;
  sqsClient?: SQSClient;
  s3Client?: S3Client;
  publisher?: OneShotPublisher;
  workspaceManager?: OneShotWorkspaceManager;
  promptComposer?: PromptComposer;
  codeReviewerProvider?: CodeReviewerProvider;
}

interface CodeReviewSoftGateContinuation {
  reason: string;
  originalDecision: OneShotCodeReview["decision"];
  errorMessage?: string;
}

interface PriorFindingsLedger {
  priorReviewCount: number;
  requiredChanges: Array<{ version: number; text: string }>;
  blockingFindings: Array<{ version: number; text: string }>;
  findings: Array<{
    version: number;
    severity: string;
    category: string;
    file: string;
    line?: number;
    description: string;
  }>;
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

function buildBypassedCodeReview(
  implementationVersion: number,
  reason?: string,
): OneShotCodeReview {
  return parseOneShotCodeReview({
    decision: "APPROVED",
    score: 100,
    sageDimensions: [],
    findings: [],
    blockingFindings: [],
    requiredChanges: [],
    nonBlockingSuggestions: [
      `Code review bypassed by ONESHOT_CODE_REVIEWER_ENABLED=false. Reason: ${reason ?? "UNSPECIFIED"}`,
    ],
    confidence: "low",
    summary: "Code review was bypassed by configuration.",
    implementationVersion,
  });
}

function buildSoftGateCodeReview(
  implementationVersion: number,
  reason: string,
  errorMessage: string,
): OneShotCodeReview {
  return parseOneShotCodeReview({
    decision: "BLOCKED",
    score: 0,
    sageDimensions: [],
    findings: [],
    blockingFindings: [errorMessage],
    requiredChanges: [],
    nonBlockingSuggestions: [
      `Soft-gate mode continued the run after Review could not complete normally. Reason: ${reason}`,
    ],
    confidence: "low",
    summary:
      "Code review did not complete successfully; findings are advisory because soft-gate mode is enabled.",
    implementationVersion,
  });
}

function planExpectedRunnableTests(plan: OneShotPlan): boolean {
  return plan.specs.some((spec) =>
    spec.validationSteps.some((step) =>
      /\b(?:test|tests|junit|mvn|gradle|surefire|unit|integration)\b/i.test(
        step,
      ),
    ),
  );
}

function buildUnverifiedImplementationReview(
  implementationVersion: number,
  implementation: {
    testCommands: string[];
    testResults: Array<{ status: string; command: string; summary: string }>;
  },
  plan: OneShotPlan,
): OneShotCodeReview | null {
  const hasDeclaredRunnableTests = implementation.testCommands.length > 0;
  const expectedRunnableTests =
    hasDeclaredRunnableTests || planExpectedRunnableTests(plan);
  if (!expectedRunnableTests) {
    return null;
  }

  const resultByCommand = new Map(
    implementation.testResults
      .filter((result) => result.command.trim().length > 0)
      .map((result) => [result.command.trim(), result]),
  );
  const skippedSummaries = implementation.testResults
    .filter((result) => result.status === "skipped")
    .map((result) => `${result.command}: ${result.summary}`);
  const missingDeclaredCommands = implementation.testCommands.filter(
    (command) => !resultByCommand.has(command.trim()),
  );
  const missingExpectedTests =
    !hasDeclaredRunnableTests && implementation.testResults.length === 0;
  const evidence = [
    ...skippedSummaries.map((summary) => `skipped: ${summary}`),
    ...missingDeclaredCommands.map(
      (command) => `missing result for declared command: ${command}`,
    ),
    ...(missingExpectedTests
      ? [
          "plan expected runnable tests, but implementation artifact reported no test results",
        ]
      : []),
  ];
  if (evidence.length === 0) {
    return null;
  }

  return parseOneShotCodeReview({
    decision: "BLOCKED",
    score: 0,
    sageDimensions: [],
    findings: [
      {
        severity: "critical",
        category: "test-verification",
        file: "(implementation artifact)",
        line: null,
        description:
          "Implementation test evidence is incomplete or skipped, so the code has not been verified.",
        suggestion:
          "Install/fix the required test environment and rerun the declared automated tests before code review can approve.",
      },
    ],
    blockingFindings: [
      `Implementation artifact is unverified: ${evidence.join(" | ")}`,
    ],
    requiredChanges: [
      "Run the declared automated test command(s) successfully, or replace them with correct repo-root test commands that the tester can execute.",
    ],
    nonBlockingSuggestions: [],
    confidence: "high",
    summary:
      "Deterministic test-verification gate found unverified implementation test evidence.",
    implementationVersion,
  });
}

function buildTestEvidenceMetadata(
  blocker: OneShotCodeReview | null,
): Record<string, unknown> {
  if (!blocker) {
    return { testEvidenceStatus: "verified" };
  }

  return {
    testEvidenceStatus: "missing",
    testEvidenceBlockingFindings: blocker.blockingFindings,
    testEvidenceRequiredChanges: blocker.requiredChanges,
  };
}

function buildCodeReviewSoftGateMetadata(
  codeReview: OneShotCodeReview,
  softGate: CodeReviewSoftGateContinuation,
): Record<string, unknown> {
  return {
    softGateContinued: true,
    softGateReason: softGate.reason,
    originalDecision: softGate.originalDecision,
    errorMessage: softGate.errorMessage,
    requiredChanges: codeReview.requiredChanges,
    blockingFindings: codeReview.blockingFindings,
    score: codeReview.score,
    confidence: codeReview.confidence,
  };
}

function requiredCodeReviewChanges(codeReview: OneShotCodeReview): string[] {
  return [...codeReview.requiredChanges, ...codeReview.blockingFindings];
}

export class CodeReviewerConsumer extends QueueConsumerBase {
  private readonly config: OneShotConsumerConfig;
  private readonly db: Database;
  private readonly oneShotDb: OneShotDatabase;
  private readonly publisher: OneShotPublisher;
  private readonly s3Client: S3Client;
  private readonly workspaceManager: OneShotWorkspaceManager;
  private readonly codeReviewerProvider: CodeReviewerProvider;

  constructor(private readonly deps: CodeReviewerConsumerDeps = {}) {
    const config = deps.config ?? getOneShotConsumerConfig();
    const sqsClient =
      deps.sqsClient ?? new SQSClient({ region: config.region });
    super(config.codeReviewQueueUrl, "code_review", sqsClient);
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
    this.codeReviewerProvider =
      deps.codeReviewerProvider ??
      (config.codeReviewerProvider === "anthropic"
        ? new ClaudeCodeReviewerProvider(promptComposer, {
            modelId: config.codeReviewerModelId,
            maxOutputTokens: config.codeReviewerMaxOutputTokens,
          })
        : new OpenAiCodeReviewerProvider(promptComposer));
  }

  protected getVisibilityTimeoutSeconds(): number {
    // Prod default 3600s (60 min). Env-gated for local iteration;
    // invalid/unset falls back to prod.
    return getVisibilityTimeoutFromEnv(
      "ONESHOT_CODE_REVIEWER_VISIBILITY_TIMEOUT_SECONDS",
      3600,
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
      logger.warn({ payload }, "Dropping code review message for missing run");
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
        "Dropping stale code review message because run state has moved on",
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

    const candidateGuard = await evaluateCandidateShaGuard({
      run,
      payload,
      oneShotDb: this.oneShotDb,
      publisher: this.publisher,
      logger,
      messageId: message.MessageId,
      receiveCount,
    });
    if (candidateGuard.action === "drop_republished") {
      return true;
    }

    const claimed = await this.oneShotDb.runs.claimQueuedRun(
      run.id,
      payload.expected_state,
      "code_reviewing",
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

    if (candidateGuard.action === "fail") {
      await this.failRun(
        run.id,
        run.jira_key,
        "run_failed",
        candidateGuard.message,
      );
      await recordCandidateShaIntegrityFailure({
        runId: run.id,
        fromState: "code_reviewing",
        toState: "failed",
        stage: "code_review",
        metadata: candidateGuard.metadata,
        oneShotDb: this.oneShotDb,
        logger,
      });
      return true;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: run.id,
        event_type: "run_claimed",
        from_state: payload.expected_state,
        to_state: "code_reviewing",
        stage: "code_review",
        metadata_json: { version: payload.version },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: run.id,
          eventType: "run_claimed",
          stage: "code_review",
        }),
      );

    let providerRetrySoftGateEligible = false;
    let implementationVersionForSoftGate: number | undefined;
    let cleanupWorkspace: (() => Promise<void>) | undefined;
    let assertWorkspaceLease: (() => Promise<void>) | undefined;

    try {
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          codeReviewVersion: payload.version,
        },
        "Code reviewer claimed run",
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
            from_state: "code_reviewing",
            to_state: "failed",
            stage: "code_review",
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
              stage: "code_review",
            }),
          );
        return true;
      }

      const implementationVersion = run.current_implementation_version;
      if (!implementationVersion) {
        throw new Error(
          `Run ${run.id} does not have an implementation version for code review`,
        );
      }
      implementationVersionForSoftGate = implementationVersion;

      const [budgetArtifacts, budgetEvents] = await Promise.all([
        this.oneShotDb.artifacts.getArtifactsForRun(run.id),
        this.oneShotDb.events.getStageAttemptMetricEventsForBudget(
          run.id,
          "code_review",
        ),
      ]);
      const budgetCheck = checkOneShotTokenBudget({
        run,
        config: this.config,
        stage: "code_review",
        stageVersion: payload.version,
        artifacts: budgetArtifacts,
        events: budgetEvents,
        projectedTokens: projectedCodeReviewerTokens(
          this.codeReviewerProvider.providerName,
        ),
      });
      if (!budgetCheck.withinBudget) {
        const errorMessage = formatTokenBudgetFailure(
          "code reviewer",
          budgetCheck,
        );
        if (
          budgetCheck.failureReason === "stage_budget_exceeded" &&
          !this.config.reviewStagesBlockOnExhaustion
        ) {
          const review = buildSoftGateCodeReview(
            implementationVersion,
            "stage_budget_exceeded",
            errorMessage,
          );
          const softGate: CodeReviewSoftGateContinuation = {
            reason: "stage_budget_exceeded",
            originalDecision: review.decision,
            errorMessage,
          };
          await this.persistCodeReviewArtifact({
            run,
            codeReviewVersion: payload.version,
            implementationVersion,
            review,
            reviewProvider: "soft_gate",
            reviewModel: "advisory",
            reviewerTokensUsed: 0,
            reviewerCostUsd: null,
            reviewerDurationMs: 0,
            reviewedImplementationCommitSha:
              run.current_implementation_commit_sha ?? null,
            softGate,
            assertWorkspaceLease,
          });
          return await this.queueTestingAfterCodeReview(
            run.id,
            run.jira_key,
            payload.version,
            run.current_test_version,
            review,
            run.current_implementation_commit_sha,
            run.current_implementation_version,
            softGate,
            assertWorkspaceLease,
          );
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
            from_state: "code_reviewing",
            to_state: "failed",
            stage: "code_review",
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
              stage: "code_review",
            }),
          );
        return true;
      }

      const withinStageAttemptBudget =
        await this.oneShotDb.runs.checkStageAttemptBudget(
          run.id,
          "code_review",
          this.config.maxStageAttempts,
        );
      if (!withinStageAttemptBudget) {
        const errorMessage = `OneShot code reviewer exhausted the maximum of ${this.config.maxStageAttempts} stage attempt(s).`;
        if (!this.config.reviewStagesBlockOnExhaustion) {
          const review = buildSoftGateCodeReview(
            implementationVersion,
            "stage_attempts_exhausted",
            errorMessage,
          );
          const softGate: CodeReviewSoftGateContinuation = {
            reason: "stage_attempts_exhausted",
            originalDecision: review.decision,
            errorMessage,
          };
          await this.persistCodeReviewArtifact({
            run,
            codeReviewVersion: payload.version,
            implementationVersion,
            review,
            reviewProvider: "soft_gate",
            reviewModel: "advisory",
            reviewerTokensUsed: 0,
            reviewerCostUsd: null,
            reviewerDurationMs: 0,
            reviewedImplementationCommitSha:
              run.current_implementation_commit_sha ?? null,
            softGate,
            assertWorkspaceLease,
          });
          return await this.queueTestingAfterCodeReview(
            run.id,
            run.jira_key,
            payload.version,
            run.current_test_version,
            review,
            run.current_implementation_commit_sha,
            run.current_implementation_version,
            softGate,
            assertWorkspaceLease,
          );
        }
        await this.failRun(run.id, run.jira_key, "run_failed", errorMessage);
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "code_reviewing",
            to_state: "failed",
            stage: "code_review",
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
              stage: "code_review",
            }),
          );
        return true;
      }
      await this.oneShotDb.runs.incrementStageAttempts(run.id, "code_review");

      const implementationCommitSha = run.current_implementation_commit_sha;
      if (!implementationCommitSha) {
        throw new Error(
          `Run ${run.id} does not have an implementation commit SHA`,
        );
      }

      const implementationBranch = run.current_implementation_branch;
      if (!implementationBranch) {
        throw new Error(`Run ${run.id} does not have an implementation branch`);
      }

      const planVersion = run.current_plan_version;
      if (!planVersion) {
        throw new Error(`Run ${run.id} does not have a plan version`);
      }

      const planArtifact = await this.oneShotDb.artifacts.getArtifact(
        run.id,
        "plan",
        planVersion,
      );
      if (!planArtifact) {
        throw new Error(
          `Missing plan artifact v${planVersion} for oneshot run ${run.id}`,
        );
      }

      const plan = await this.readArtifactJson(
        planArtifact.s3_bucket,
        planArtifact.s3_key,
        parseOneShotPlan,
      );

      const implArtifact = await this.oneShotDb.artifacts.getArtifact(
        run.id,
        "implementation",
        implementationVersion,
      );
      if (!implArtifact) {
        throw new Error(
          `Missing implementation artifact v${implementationVersion} for oneshot run ${run.id}`,
        );
      }

      const implementation = await this.readArtifactJson(
        implArtifact.s3_bucket,
        implArtifact.s3_key,
        parseOneShotImplementation,
      );
      const implementationBaseCommitSha =
        implementation.baseCommitSha ?? run.base_commit_sha;
      const priorFindingsLedger = await this.buildPriorFindingsLedger(
        run.id,
        payload.version,
      );

      let review: OneShotCodeReview;
      let reviewProvider: string = this.codeReviewerProvider.providerName;
      let reviewModel: string = this.codeReviewerProvider.modelId;
      let reviewerDurationMs = 0;
      let reviewerTokensUsed = 0;
      let reviewerTokenUsage: ReviewerProviderMetrics["tokensUsed"] = undefined;
      let reviewerCostUsd: number | null = null;
      let reviewerModelUsage: ReviewerProviderMetrics["modelUsage"] = undefined;

      const deterministicTestReview = buildUnverifiedImplementationReview(
        implementationVersion,
        implementation,
        plan,
      );
      if (deterministicTestReview) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            implementationVersion,
            codeReviewVersion: payload.version,
            testCommands: implementation.testCommands,
          },
          "Code review observed missing deterministic implementation test proof",
        );
      }
      if (!this.config.codeReviewerEnabled) {
        review = buildBypassedCodeReview(
          implementationVersion,
          this.config.codeReviewerBypassReason,
        );
        reviewProvider = "config";
        reviewModel = "disabled";
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            implementationVersion,
            codeReviewVersion: payload.version,
            bypassReason: this.config.codeReviewerBypassReason ?? "UNSPECIFIED",
          },
          "[CODE_REVIEWER_BYPASSED] Implementation auto-approved because ONESHOT_CODE_REVIEWER_ENABLED=false",
        );
      } else {
        const repo = await this.db.getRepositoryById(run.repo_id);
        if (!repo) {
          throw new Error(
            `Repository ${run.repo_id} not found for oneshot run ${run.id}`,
          );
        }

        await ensureRunBranchContract({
          run,
          repo,
          oneShotDb: this.oneShotDb,
          workspaceManager: this.workspaceManager,
          stage: "code-reviewer",
          logger,
        });
        const workspace =
          await this.workspaceManager.prepareCodeReviewerWorkspace(
            run.id,
            repo,
            implementationCommitSha,
            implementationBranch,
          );
        cleanupWorkspace = workspace.cleanup;
        assertWorkspaceLease = async () => {
          await workspace.assertLeaseValid?.("code_review");
        };

        let reviewerResponse;
        await assertWorkspaceLease?.();
        const workspaceHead = await getCurrentHeadSha(workspace.workspacePath);
        await assertWorkspaceLease?.();
        if (workspaceHead !== implementationCommitSha) {
          const message = `Code review workspace HEAD mismatch for candidate ${implementationCommitSha}; prepared ${workspaceHead}.`;
          await assertWorkspaceLease?.();
          await this.failRun(run.id, run.jira_key, "run_failed", message);
          this.oneShotDb.events
            .createEvent({
              oneshot_run_id: run.id,
              event_type: "state_transition",
              from_state: "code_reviewing",
              to_state: "failed",
              stage: "code_review",
              metadata_json: {
                reason: "candidate_workspace_head_mismatch",
                expectedImplementationCommitSha: implementationCommitSha,
                workspaceHead,
                version: payload.version,
              },
            })
            .catch(
              eventEmitFailureLogger({
                logger,
                runId: run.id,
                eventType: "state_transition",
                stage: "code_review",
              }),
            );
          return true;
        }

        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            repoName: repo.repo_name,
            implementationBranch,
            implementationCommitSha,
          },
          "Code reviewer preparing workspace",
        );

        const codeReviewContext = await buildCodeReviewContext(
          workspace.workspacePath,
          implementationBaseCommitSha,
          implementation.changedFiles,
        );
        const qualificationSummary = await loadRunQualificationSummary(
          this.oneShotDb,
          this.s3Client,
          run.id,
        );
        const retrofitContext = parsePlannerRetrofitContext(
          qualificationSummary?.repoSelectionMetadata?.retrofitContext,
        );
        const retrofitSourceEvidence = retrofitContext
          ? parseRetrofitSourceEvidence(
              qualificationSummary?.repoSelectionMetadata
                ?.retrofitSourceEvidence,
            )
          : null;
        const processingMode = resolveOneShotProcessingMode(
          qualificationSummary,
        );
        const workspaceArtifacts: WorkspaceArtifactFile[] = [
          {
            fileName: `plan.v${planVersion}.json`,
            body: plan,
            format: "json",
          },
          {
            fileName: `plan.v${planVersion}.md`,
            body: renderOneShotPlanMarkdown(plan),
            format: "md",
          },
          {
            fileName: `implementation.v${implementationVersion}.json`,
            body: implementation,
            format: "json",
          },
          {
            fileName: `implementation.v${implementationVersion}.md`,
            body: renderOneShotImplementationMarkdown(plan, implementation),
            format: "md",
          },
          {
            fileName: `code-review-context.v${payload.version}.json`,
            body: codeReviewContext,
            format: "json",
          },
          {
            fileName: `prior-findings-ledger.v${payload.version}.json`,
            body: priorFindingsLedger,
            format: "json",
          },
        ];
        if (implementation.commitDiff) {
          workspaceArtifacts.push({
            fileName: `commit-diff.v${implementationVersion}.txt`,
            body: implementation.commitDiff,
            format: "txt",
          });
        }
        await materializeRunArtifacts(
          workspace.statePath,
          workspaceArtifacts,
          "code-reviewer",
        );

        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            workspacePath: workspace.workspacePath,
            changedFilesCount: implementation.changedFiles.length,
            implementationVersion,
            codeReviewVersion: payload.version,
            startedAt: new Date().toISOString(),
          },
          "Code reviewer invoking provider",
        );
        const reviewerStartedMs = Date.now();

        providerRetrySoftGateEligible = true;
        reviewerResponse = await this.codeReviewerProvider.reviewCode({
          jiraKey: run.jira_key,
          repoName: repo.repo_name,
          branchName: run.branch_name,
          baseCommitSha: implementationBaseCommitSha,
          workspacePath: workspace.workspacePath,
          implementationBranch,
          implementationCommitSha,
          implementationVersion,
          plan,
          codeReviewContext,
          priorFindingsLedger,
          retrofitContext,
          retrofitSourceEvidence,
          processingMode,
          jiraLabels: qualificationSummary?.jiraLabels,
        });
        providerRetrySoftGateEligible = false;
        reviewerDurationMs = Date.now() - reviewerStartedMs;
        reviewerTokenUsage = reviewerResponse.metrics.tokensUsed;
        reviewerCostUsd = reviewerResponse.metrics.costUsd ?? null;
        reviewerModelUsage = reviewerResponse.metrics.modelUsage;
        recordLlmMetrics(
          "code_review",
          this.codeReviewerProvider.providerName,
          reviewerResponse.metrics.durationMs,
          reviewerResponse.metrics.tokensUsed,
          reviewerResponse.metrics.costUsd,
        );
        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            implementationVersion,
            codeReviewVersion: payload.version,
            completedAt: new Date().toISOString(),
            providerDurationMs: reviewerDurationMs,
          },
          "Code reviewer provider completed",
        );

        await assertWorkspaceLease?.();
        providerRetrySoftGateEligible = true;
        review = reviewerResponse.review;
        if (processingMode === "sonar_autofix") {
          review = applySonarRemediationGuard(review, codeReviewContext);
        }
        reviewerTokensUsed = calculateTokenUsage(reviewerResponse.metrics);
        providerRetrySoftGateEligible = false;
      }
      const missingTestEvidenceWithApprovedCode =
        !!deterministicTestReview && review.decision === "APPROVED";
      const softGate = await this.getCodeReviewDecisionSoftGate(run, review);
      const testEvidenceMetadata = buildTestEvidenceMetadata(
        deterministicTestReview,
      );
      await this.persistCodeReviewArtifact({
        run,
        codeReviewVersion: payload.version,
        implementationVersion,
        review,
        reviewProvider,
        reviewModel,
        reviewerTokensUsed,
        reviewerTokenUsage,
        reviewerCostUsd,
        reviewerDurationMs,
        reviewerModelUsage,
        reviewedImplementationCommitSha: implementationCommitSha,
        softGate,
        testEvidenceMetadata,
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
          codeReviewVersion: payload.version,
          decision: review.decision,
          findingsCount: review.findings.length,
          requiredChangesCount: review.requiredChanges.length,
          blockingFindingsCount: review.blockingFindings.length,
          score: review.score,
        },
        "Code reviewer completed decision",
      );

      if (review.decision === "APPROVED") {
        return await this.queueTestingAfterCodeReview(
          run.id,
          run.jira_key,
          payload.version,
          run.current_test_version,
          review,
          implementationCommitSha,
          run.current_implementation_version,
          undefined,
          assertWorkspaceLease,
          missingTestEvidenceWithApprovedCode ? testEvidenceMetadata : undefined,
        );
      }

      if (review.decision === "NEEDS_CHANGES") {
        return await this.handleNeedsChanges(
          run,
          payload.version,
          review,
          softGate,
          assertWorkspaceLease,
        );
      }

      if (softGate && !this.config.reviewStagesBlockOnExhaustion) {
        return await this.handleNeedsChanges(
          run,
          payload.version,
          review,
          softGate,
          assertWorkspaceLease,
        );
      }

      return await this.handleBlocked(
        run,
        payload.version,
        review,
        assertWorkspaceLease,
      );
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      logger.error(
        {
          runId: run.id,
          receiveCount,
          error: errorMessage,
        },
        "Code reviewer consumer failed to process run",
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

      // Skip SQS retry for failures that are guaranteed to reproduce
      // (output-cap overflow, schema-invalid-after-success, etc.). Without
      // this gate we burn 3× SQS deliveries + tokens on a deterministic
      // outcome. See src/oneshot/retry-classifier.ts for the patterns.
      if (isDeterministicFailure(errorMessage)) {
        logger.warn(
          {
            runId: run.id,
            receiveCount,
            error: errorMessage,
          },
          "Code reviewer failing deterministic error immediately without retry",
        );
        await this.failRun(run.id, run.jira_key, "run_failed", errorMessage);
        return true;
      }

      if (receiveCount >= TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT) {
        if (
          !this.config.reviewStagesBlockOnExhaustion &&
          providerRetrySoftGateEligible &&
          implementationVersionForSoftGate
        ) {
          const review = buildSoftGateCodeReview(
            implementationVersionForSoftGate,
            "provider_retry_exhausted",
            errorMessage,
          );
          const softGate: CodeReviewSoftGateContinuation = {
            reason: "provider_retry_exhausted",
            originalDecision: review.decision,
            errorMessage,
          };
          await this.persistCodeReviewArtifact({
            run,
            codeReviewVersion: payload.version,
            implementationVersion: implementationVersionForSoftGate,
            review,
            reviewProvider: "soft_gate",
            reviewModel: "advisory",
            reviewerTokensUsed: 0,
            reviewerCostUsd: null,
            reviewerDurationMs: 0,
            reviewedImplementationCommitSha:
              run.current_implementation_commit_sha ?? null,
            softGate,
          });
          return await this.queueTestingAfterCodeReview(
            run.id,
            run.jira_key,
            payload.version,
            run.current_test_version,
            review,
            run.current_implementation_commit_sha,
            run.current_implementation_version,
            softGate,
            assertWorkspaceLease,
          );
        }
        await this.failRun(run.id, run.jira_key, "run_failed", errorMessage);
        return true;
      }

      logger.warn(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          nextState: "queued_for_code_review",
          error: errorMessage,
        },
        "Code reviewer returning run to queue after transient failure",
      );

      const requeued = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        run.id,
        "code_reviewing",
        "queued_for_code_review",
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
          "Code reviewer retry skipped because run state already moved",
        );
        return true;
      }

      const retryMeta = await this.shortenVisibilityForTransientRetry(message, receiveCount);

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "code_reviewing",
          to_state: "queued_for_code_review",
          stage: "code_review",
          metadata_json: { reason: "transient_error", receiveCount, transientRetry: retryMeta },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "state_transition",
            stage: "code_review",
          }),
        );

      return false;
    } finally {
      await cleanupWorkspace?.().catch(() => undefined);
    }
  }

  private async getCodeReviewDecisionSoftGate(
    run: Pick<
      OneShotRun,
      "id" | "verification_loop_count" | "max_verification_loops"
    >,
    codeReview: OneShotCodeReview,
  ): Promise<CodeReviewSoftGateContinuation | undefined> {
    if (
      this.config.reviewStagesBlockOnExhaustion ||
      codeReview.decision === "APPROVED"
    ) {
      return undefined;
    }

    const nextVerificationLoopCount = run.verification_loop_count + 1;

    if (codeReview.decision === "BLOCKED") {
      return {
        reason:
          nextVerificationLoopCount < run.max_verification_loops
            ? "blocked_revision"
            : "blocked_verification_budget_exhausted",
        originalDecision: codeReview.decision,
      };
    }

    const implDisagreement = await this.loadImplementationDisagreement(
      run.id,
    ).catch((error) => {
      logger.warn(
        {
          runId: run.id,
          error: error instanceof Error ? error.message : String(error),
        },
        "Unable to inspect implementation disagreement before soft-gate metadata is written",
      );
      return null;
    });
    if (implDisagreement?.implementerDisagrees) {
      return {
        reason: "implementer_disagrees",
        originalDecision: codeReview.decision,
        errorMessage: implDisagreement.implementerDisagreementReason,
      };
    }

    if (nextVerificationLoopCount >= run.max_verification_loops) {
      return {
        reason: "verification_budget_exhausted",
        originalDecision: codeReview.decision,
      };
    }

    return undefined;
  }

  private async loadImplementationDisagreement(runId: number): Promise<{
    implementerDisagrees?: boolean;
    implementerDisagreementReason?: string;
  } | null> {
    const implArtifact = await this.oneShotDb.artifacts.getLatestArtifact(
      runId,
      "implementation",
    );
    if (!implArtifact) {
      return null;
    }
    return await this.readArtifactJson<{
      implementerDisagrees?: boolean;
      implementerDisagreementReason?: string;
    }>(implArtifact.s3_bucket, implArtifact.s3_key);
  }

  private async buildPriorFindingsLedger(
    runId: number,
    currentCodeReviewVersion: number,
  ): Promise<PriorFindingsLedger> {
    const artifacts = await this.oneShotDb.artifacts.getArtifactsForRun(runId);
    const priorCodeReviewArtifacts = artifacts
      .filter(
        (artifact) =>
          artifact.stage === "code_review" &&
          artifact.version < currentCodeReviewVersion,
      )
      .sort((left, right) => left.version - right.version);

    const ledger: PriorFindingsLedger = {
      priorReviewCount: 0,
      requiredChanges: [],
      blockingFindings: [],
      findings: [],
    };

    for (const artifact of priorCodeReviewArtifacts) {
      const review = await this.readArtifactJson(
        artifact.s3_bucket,
        artifact.s3_key,
        parseOneShotCodeReview,
      ).catch((error: unknown) => {
        logger.warn(
          {
            runId,
            codeReviewVersion: artifact.version,
            error: error instanceof Error ? error.message : String(error),
          },
          "Skipping prior code-review artifact while building findings ledger",
        );
        return null;
      });
      if (!review) {
        continue;
      }
      ledger.priorReviewCount += 1;
      ledger.requiredChanges.push(
        ...review.requiredChanges.map((text) => ({
          version: artifact.version,
          text,
        })),
      );
      ledger.blockingFindings.push(
        ...review.blockingFindings.map((text) => ({
          version: artifact.version,
          text,
        })),
      );
      ledger.findings.push(
        ...review.findings
          .filter(
            (finding) =>
              finding.severity === "critical" || finding.severity === "high",
          )
          .map((finding) => ({
            version: artifact.version,
            severity: finding.severity,
            category: finding.category,
            file: finding.file,
            line: finding.line,
            description: finding.description,
          })),
      );
    }

    return {
      priorReviewCount: ledger.priorReviewCount,
      requiredChanges: ledger.requiredChanges.slice(-50),
      blockingFindings: ledger.blockingFindings.slice(-50),
      findings: ledger.findings.slice(-50),
    };
  }

  private async persistCodeReviewArtifact(input: {
    run: Pick<OneShotRun, "id" | "jira_key">;
    codeReviewVersion: number;
    implementationVersion: number;
    review: OneShotCodeReview;
    reviewProvider: string;
    reviewModel: string;
    reviewerTokensUsed: number;
    reviewerTokenUsage?: ReviewerProviderMetrics["tokensUsed"];
    reviewerCostUsd: number | null;
    reviewerDurationMs: number;
    reviewerModelUsage?: ReviewerProviderMetrics["modelUsage"];
    reviewedImplementationCommitSha: string | null;
    softGate?: CodeReviewSoftGateContinuation;
    testEvidenceMetadata?: Record<string, unknown>;
    assertWorkspaceLease?: () => Promise<void>;
  }): Promise<void> {
    const artifactKey = buildOneShotArtifactKey(
      this.config,
      input.run.jira_key,
      input.run.id,
      "code_review",
      input.codeReviewVersion,
    );

    logger.info(
      {
        runId: input.run.id,
        jiraKey: input.run.jira_key,
        codeReviewVersion: input.codeReviewVersion,
        artifactKey,
        softGateReason: input.softGate?.reason,
      },
      "Code reviewer writing artifact",
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
      stage: "code_review",
      version: input.codeReviewVersion,
      status: "completed",
      s3_bucket: this.config.artifactBucket,
      s3_key: artifactKey,
      provider: input.reviewProvider,
      model: input.reviewModel,
      metadata_json: {
        decision: input.review.decision,
        score: input.review.score,
        findingsCount: input.review.findings.length,
        implementationVersion: input.implementationVersion,
        reviewedImplementationCommitSha: input.reviewedImplementationCommitSha,
        bypassed: !this.config.codeReviewerEnabled,
        stage_tokens_used: input.reviewerTokensUsed,
        tokens_used: input.reviewerTokenUsage ?? null,
        stage_cost_usd: input.reviewerCostUsd,
        model_usage: input.reviewerModelUsage ?? null,
        stage_duration_ms: input.reviewerDurationMs,
        ...(input.softGate
          ? buildCodeReviewSoftGateMetadata(input.review, input.softGate)
          : {}),
        ...(input.testEvidenceMetadata ?? {}),
      },
      started_at: new Date(Date.now() - input.reviewerDurationMs),
      completed_at: new Date(),
    });
  }

  private async queueTestingAfterCodeReview(
    runId: number,
    jiraKey: string,
    codeReviewVersion: number,
    currentTestVersion: number | null,
    codeReview: OneShotCodeReview,
    expectedImplementationCommitSha: string | null,
    expectedImplementationVersion: number | null,
    softGate?: CodeReviewSoftGateContinuation,
    assertWorkspaceLease?: () => Promise<void>,
    extraMetadata?: Record<string, unknown>,
  ): Promise<boolean> {
    const nextTestVersion = (currentTestVersion ?? 0) + 1;

    await assertWorkspaceLease?.();
    const transitioned = await transitionRunWithNotification(this.db, {
      runId,
      fromState: "code_reviewing",
      toState: "queued_for_testing",
      updates: {
        current_code_review_version: codeReviewVersion,
        current_test_version: nextTestVersion,
        last_error: null,
        final_disposition: null,
      },
      notification: {
        oneshot_run_id: runId,
        jira_key: jiraKey,
        notification_type: "code_review_completed",
        body_markdown: buildCodeReviewCompletedComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey,
          codeReview,
          softGate: softGate ? { reason: softGate.reason } : undefined,
        }),
      },
    });
    if (!transitioned) {
      logger.warn(
        {
          runId,
          jiraKey,
        },
        "Code review completion transition skipped because run state already moved",
      );
      return true;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: runId,
        event_type: "state_transition",
        from_state: "code_reviewing",
        to_state: "queued_for_testing",
        stage: "code_review",
        metadata_json: {
          version: codeReviewVersion,
          ...(softGate
            ? buildCodeReviewSoftGateMetadata(codeReview, softGate)
            : {}),
          ...(extraMetadata ?? {}),
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId,
          eventType: "state_transition",
          stage: "code_review",
        }),
      );

    try {
      await assertWorkspaceLease?.();
      await this.publisher.publishStageMessage(
        runId,
        "testing",
        nextTestVersion,
        "queued_for_testing",
        false,
        {
          expectedImplementationCommitSha,
          expectedImplementationVersion,
        },
      );
    } catch (publishError) {
      // Compensate the earlier queued_for_testing transition so the run can
      // be re-driven. Without this the run strands with a valid state and
      // no SQS message. See planner.ts for the same pattern.
      // TODO(follow-up): replace with transactional outbox pattern.
      const publishErrorMessage =
        publishError instanceof Error
          ? publishError.message
          : String(publishError);
      logger.error(
        {
          runId,
          codeReviewVersion,
          error: publishErrorMessage,
        },
        "Failed to publish testing message after code review completion; reverting state to code_reviewing",
      );
      const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        runId,
        "queued_for_testing",
        "code_reviewing",
        {
          current_test_version: currentTestVersion,
          last_error: publishErrorMessage,
        },
      );
      if (reverted) {
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: runId,
            event_type: "state_revert",
            from_state: "queued_for_testing",
            to_state: "code_reviewing",
            stage: "code_review",
            metadata_json: {
              reason: "publish_failed",
              publishError: publishErrorMessage,
              version: codeReviewVersion,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId,
              eventType: "state_revert",
              stage: "code_review",
            }),
          );
      } else {
        logger.warn(
          { runId, jiraKey },
          "Code-reviewer state revert skipped because run state already moved",
        );
      }
      throw publishError;
    }

    logger.info(
      {
        runId,
        jiraKey,
        codeReviewVersion,
        nextTestVersion,
        softGateReason: softGate?.reason,
      },
      "Code review completed, queued for testing",
    );

    return true;
  }

  private async handleNeedsChanges(
    run: {
      id: number;
      jira_key: string;
      verification_loop_count: number;
      max_verification_loops: number;
      current_implementation_version: number | null;
      current_implementation_commit_sha: string | null;
      current_code_review_version: number | null;
      current_test_version: number | null;
    },
    codeReviewVersion: number,
    codeReview: OneShotCodeReview,
    softGate?: CodeReviewSoftGateContinuation,
    assertWorkspaceLease?: () => Promise<void>,
  ): Promise<boolean> {
    const requiredChanges = requiredCodeReviewChanges(codeReview);
    await assertWorkspaceLease?.();
    await this.oneShotDb.runs.incrementVerificationLoop(run.id);
    verificationLoopCounter.add(1, { stage: "code_review" });

    const implArtifact = await this.oneShotDb.artifacts.getLatestArtifact(
      run.id,
      "implementation",
    );
    if (implArtifact) {
      const impl = await this.readArtifactJson<{
        implementerDisagrees?: boolean;
        implementerDisagreementReason?: string;
      }>(implArtifact.s3_bucket, implArtifact.s3_key);
      if (impl.implementerDisagrees) {
        if (!this.config.reviewStagesBlockOnExhaustion) {
          const disagreementSoftGate: CodeReviewSoftGateContinuation =
            softGate ?? {
              reason: "implementer_disagrees",
              originalDecision: codeReview.decision,
              errorMessage: impl.implementerDisagreementReason,
            };
          return await this.queueTestingAfterCodeReview(
            run.id,
            run.jira_key,
            codeReviewVersion,
            run.current_test_version,
            codeReview,
            run.current_implementation_commit_sha,
            run.current_implementation_version,
            disagreementSoftGate,
            assertWorkspaceLease,
          );
        }
        await assertWorkspaceLease?.();
        const transitioned = await transitionRunWithNotification(this.db, {
          runId: run.id,
          fromState: "code_reviewing",
          toState: "escalated",
          updates: {
            current_code_review_version: codeReviewVersion,
            final_disposition: "code_review_escalated",
            last_error: `Implementer disagrees with code review: ${impl.implementerDisagreementReason ?? "no reason given"}`,
          },
          notification: {
            oneshot_run_id: run.id,
            jira_key: run.jira_key,
            notification_type: "code_review_escalated",
            body_markdown: buildCodeReviewEscalatedComment({
              assetBaseUrl: this.config.commentAssetBaseUrl,
              jiraKey: run.jira_key,
              requiredChanges,
              implementerDisagreementReason: impl.implementerDisagreementReason,
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
            "Code review escalation skipped because run state already moved",
          );
          return true;
        }

        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "state_transition",
            from_state: "code_reviewing",
            to_state: "escalated",
            stage: "code_review",
            metadata_json: {
              version: codeReviewVersion,
              reason: "implementer_disagrees",
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: run.id,
              eventType: "state_transition",
              stage: "code_review",
            }),
          );
        return true;
      }
    }

    const withinBudget = await this.oneShotDb.runs.checkVerificationBudget(
      run.id,
    );

    if (withinBudget) {
      const nextImplVersion = (run.current_implementation_version ?? 0) + 1;
      await assertWorkspaceLease?.();
      await this.oneShotDb.runs.updateRunState(
        run.id,
        "queued_for_implementation",
        {
          current_code_review_version: codeReviewVersion,
          current_implementation_version: nextImplVersion,
          last_error: null,
        },
      );

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "code_reviewing",
          to_state: "queued_for_implementation",
          stage: "code_review",
          metadata_json: {
            version: codeReviewVersion,
            ...(softGate
              ? buildCodeReviewSoftGateMetadata(codeReview, softGate)
              : {}),
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "state_transition",
            stage: "code_review",
          }),
        );

      try {
        await assertWorkspaceLease?.();
        await this.publisher.publishStageMessage(
          run.id,
          "implementation",
          nextImplVersion,
          "queued_for_implementation",
          true,
        );
      } catch (publishError) {
        // Compensate the earlier queued_for_implementation transition so the
        // run can be re-driven. See planner.ts for the same pattern.
        // TODO(follow-up): replace with transactional outbox pattern.
        const publishErrorMessage =
          publishError instanceof Error
            ? publishError.message
            : String(publishError);
        logger.error(
          {
            runId: run.id,
            nextImplVersion,
            error: publishErrorMessage,
          },
          "Failed to publish implementation message after code review needs_changes; reverting state to code_reviewing",
        );
        const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
          run.id,
          "queued_for_implementation",
          "code_reviewing",
          {
            current_code_review_version: run.current_code_review_version,
            current_implementation_version: run.current_implementation_version,
            verification_loop_count: run.verification_loop_count,
            last_error: publishErrorMessage,
          },
        );
        if (reverted) {
          this.oneShotDb.events
            .createEvent({
              oneshot_run_id: run.id,
              event_type: "state_revert",
              from_state: "queued_for_implementation",
              to_state: "code_reviewing",
              stage: "code_review",
              metadata_json: {
                reason: "publish_failed",
                publishError: publishErrorMessage,
                version: codeReviewVersion,
              },
            })
            .catch(
              eventEmitFailureLogger({
                logger,
                runId: run.id,
                eventType: "state_revert",
                stage: "code_review",
              }),
            );
        } else {
          logger.warn(
            { runId: run.id, jiraKey: run.jira_key },
            "Code-reviewer state revert skipped because run state already moved",
          );
        }
        throw publishError;
      }

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          codeReviewVersion,
          nextImplVersion,
        },
        "Code review needs changes, queued for implementation revision",
      );

      return true;
    }

    if (!this.config.reviewStagesBlockOnExhaustion) {
      const exhaustedSoftGate: CodeReviewSoftGateContinuation = softGate ?? {
        reason: "verification_budget_exhausted",
        originalDecision: codeReview.decision,
      };
      return await this.queueTestingAfterCodeReview(
        run.id,
        run.jira_key,
        codeReviewVersion,
        run.current_test_version,
        codeReview,
        run.current_implementation_commit_sha,
        run.current_implementation_version,
        exhaustedSoftGate,
        assertWorkspaceLease,
      );
    }

    let wipPrUrl: string | null = null;
    let prStateSyncError: string | null = null;
    await assertWorkspaceLease?.();
    try {
      const fullRun = await this.oneShotDb.runs.getRunById(run.id);
      const repo = fullRun
        ? await this.db.getRepositoryById(fullRun.repo_id)
        : null;
      const implBranch = fullRun?.current_implementation_branch;
      if (repo && implBranch && fullRun) {
        const { owner, repo: repoName } = parseGitHubRepoUrl(repo.repo_url);
        const ticketSummary = await loadRunTicketSummary(
          this.oneShotDb,
          this.s3Client,
          run.id,
        );
        const pr = await ensureDraftPullRequest({
          owner,
          repo: repoName,
          title: buildOneShotPullRequestTitle({
            jiraKey: run.jira_key,
            ticketSummary,
            wip: true,
          }),
          head: implBranch,
          base: fullRun.branch_name,
          draft: true,
          body:
            `## OneShot Code Review Escalated\n\n` +
            `This is a WIP draft PR created because the automated code review loop was exhausted ` +
            `after ${run.max_verification_loops} iteration(s).\n\n` +
            `**Required changes from last review:**\n${requiredChanges.map((c) => `- ${c}`).join("\n")}\n\n` +
            `Review the code and either:\n` +
            `- Add \`PFOS-FORCE-APPROVE\` label to proceed to testing\n` +
            `- Make manual fixes on the \`${implBranch}\` branch`,
        });
        const prSyncError = pr.updateSyncError ?? pr.draftSyncError ?? null;
        if (prSyncError) {
          prStateSyncError = prSyncError;
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              prUrl: pr.htmlUrl,
              error: prSyncError,
              updateSyncError: pr.updateSyncError ?? null,
              draftSyncError: pr.draftSyncError ?? null,
            },
            "WIP PR sync failed on code review escalation",
          );
        } else {
          wipPrUrl = pr.htmlUrl;
        }
      }
    } catch (prError) {
      logger.warn(
        {
          runId: run.id,
          error: prError instanceof Error ? prError.message : String(prError),
        },
        "Failed to create WIP PR on code review escalation",
      );
    }

    const escalationToState = wipPrUrl ? "pr_open" : "blocked";
    const escalationDisposition = wipPrUrl
      ? "completed_needs_review"
      : "code_review_blocked";
    const escalationLastError = [
      ...requiredChanges,
      ...(prStateSyncError
        ? [`pr_state_sync_failed: ${prStateSyncError}`]
        : []),
    ].join(" | ");

    await assertWorkspaceLease?.();
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: run.id,
      fromState: "code_reviewing",
      toState: escalationToState,
      updates: {
        current_code_review_version: codeReviewVersion,
        current_pr_url: wipPrUrl,
        final_disposition: escalationDisposition,
        last_error: escalationLastError,
      },
      notification: {
        oneshot_run_id: run.id,
        jira_key: run.jira_key,
        notification_type: "code_review_escalated",
        body_markdown: buildCodeReviewEscalatedComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey: run.jira_key,
          requiredChanges,
          wipPrUrl,
          maxVerificationLoops: run.max_verification_loops,
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
        "Code review escalation after verification exhaustion skipped because run state already moved",
      );
      return true;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: run.id,
        event_type: "state_transition",
        from_state: "code_reviewing",
        to_state: escalationToState,
        stage: "code_review",
        metadata_json: {
          version: codeReviewVersion,
          reason: "verification_budget_exhausted",
          prUrl: wipPrUrl,
          prStateSyncError,
          readiness: wipPrUrl
            ? {
                completionStatus: "completed_needs_review",
                readiness: "needs_review",
                reasons: requiredChanges.map((change) => ({
                  code: "code_review_soft_gate",
                  category: "code_review",
                  severity: "high",
                  source: "code_review",
                  message: change,
                })),
              }
            : undefined,
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: run.id,
          eventType: "state_transition",
          stage: "code_review",
        }),
      );

    if (wipPrUrl) {
      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "readiness_classified",
          from_state: "code_reviewing",
          to_state: "pr_open",
          stage: "code_review",
          metadata_json: {
            readiness: {
              completionStatus: "completed_needs_review",
              readiness: "needs_review",
              reasons: requiredChanges.map((change) => ({
                code: "code_review_soft_gate",
                category: "code_review",
                severity: "high",
                source: "code_review",
                message: change,
              })),
            },
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "readiness_classified",
            stage: "code_review",
          }),
        );
    }

    logger.info(
      {
        runId: run.id,
        jiraKey: run.jira_key,
        codeReviewVersion,
        wipPrUrl,
      },
      "Code review escalated after verification loop exhaustion",
    );

    return true;
  }

  private async handleBlocked(
    run: Pick<
      OneShotRun,
      | "id"
      | "jira_key"
      | "repo_id"
      | "branch_name"
      | "current_implementation_branch"
    >,
    codeReviewVersion: number,
    codeReview: OneShotCodeReview,
    assertWorkspaceLease?: () => Promise<void>,
  ): Promise<boolean> {
    const blockingFindings = codeReview.blockingFindings;
    let wipPrUrl: string | null = null;
    let prStateSyncError: string | null = null;
    await assertWorkspaceLease?.();
    try {
      const repo = await this.db.getRepositoryById(run.repo_id);
      const implBranch = run.current_implementation_branch;
      if (repo && implBranch) {
        const { owner, repo: repoName } = parseGitHubRepoUrl(repo.repo_url);
        const ticketSummary = await loadRunTicketSummary(
          this.oneShotDb,
          this.s3Client,
          run.id,
        );
        const pr = await ensureDraftPullRequest({
          owner,
          repo: repoName,
          title: buildOneShotPullRequestTitle({
            jiraKey: run.jira_key,
            ticketSummary,
            wip: true,
          }),
          head: implBranch,
          base: run.branch_name,
          draft: true,
          body:
            `## OneShot Code Review Needs Review\n\n` +
            `This draft PR was created because automated code review blocked the implementation.\n\n` +
            `## Autonomous Readiness\n` +
            `- Classification: Needs review\n` +
            `- Completion status: \`completed_needs_review\`\n\n` +
            `## Blocking Findings\n${blockingFindings.map((finding) => `- ${finding}`).join("\n")}\n\n` +
            `## Required Changes\n${codeReview.requiredChanges.map((change) => `- ${change}`).join("\n")}`,
        });
        const prSyncError = pr.updateSyncError ?? pr.draftSyncError ?? null;
        if (prSyncError) {
          prStateSyncError = prSyncError;
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              prUrl: pr.htmlUrl,
              error: prSyncError,
              updateSyncError: pr.updateSyncError ?? null,
              draftSyncError: pr.draftSyncError ?? null,
            },
            "WIP PR sync failed on code review block",
          );
        } else {
          wipPrUrl = pr.htmlUrl;
        }
      }
    } catch (prError) {
      logger.warn(
        {
          runId: run.id,
          error: prError instanceof Error ? prError.message : String(prError),
        },
        "Failed to create WIP PR on code review block",
      );
    }

    const blockingLastError = [
      ...blockingFindings,
      ...(prStateSyncError
        ? [`pr_state_sync_failed: ${prStateSyncError}`]
        : []),
    ].join(" | ");

    await assertWorkspaceLease?.();
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: run.id,
      fromState: "code_reviewing",
      toState: wipPrUrl ? "pr_open" : "blocked",
      updates: {
        current_code_review_version: codeReviewVersion,
        current_pr_url: wipPrUrl,
        final_disposition: wipPrUrl
          ? "completed_needs_review"
          : "code_review_blocked",
        last_error: blockingLastError,
      },
      notification: {
        oneshot_run_id: run.id,
        jira_key: run.jira_key,
        notification_type: "code_review_blocked",
        body_markdown: buildCodeReviewBlockedComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey: run.jira_key,
          blockingFindings,
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
        "Code review blocked transition skipped because run state already moved",
      );
      return true;
    }

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: run.id,
        event_type: "state_transition",
        from_state: "code_reviewing",
        to_state: wipPrUrl ? "pr_open" : "blocked",
        stage: "code_review",
        metadata_json: {
          version: codeReviewVersion,
          prUrl: wipPrUrl,
          prStateSyncError,
          readiness: wipPrUrl
            ? {
                completionStatus: "completed_needs_review",
                readiness: "needs_review",
                reasons: blockingFindings.map((finding) => ({
                  code: "code_review_blocked",
                  category: "code_review",
                  severity: "high",
                  source: "code_review",
                  message: finding,
                })),
              }
            : undefined,
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: run.id,
          eventType: "state_transition",
          stage: "code_review",
        }),
      );

    if (wipPrUrl) {
      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "readiness_classified",
          from_state: "code_reviewing",
          to_state: "pr_open",
          stage: "code_review",
          metadata_json: {
            readiness: {
              completionStatus: "completed_needs_review",
              readiness: "needs_review",
              reasons: blockingFindings.map((finding) => ({
                code: "code_review_blocked",
                category: "code_review",
                severity: "high",
                source: "code_review",
                message: finding,
              })),
            },
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "readiness_classified",
            stage: "code_review",
          }),
        );
    }

    logger.info(
      {
        runId: run.id,
        jiraKey: run.jira_key,
        codeReviewVersion,
        wipPrUrl,
      },
      "Code review blocked",
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
      "Code reviewer failing OneShot run",
    );

    const transitioned = await transitionRunWithNotification(this.db, {
      runId,
      fromState: "code_reviewing",
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
                stageLabel: "Code Review",
                errorMessage,
              })
            : buildRunFailedComment({
                assetBaseUrl: this.config.commentAssetBaseUrl,
                jiraKey,
                stageLabel: "Code Review",
                errorMessage,
              }),
      },
      postmortemContext: buildPostmortemContext({
        s3Client: this.s3Client,
        artifactBucket: this.config.artifactBucket,
        artifactPrefix: this.config.artifactPrefix,
        jiraKey,
        failedStage: "code_review",
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
        "Code reviewer failRun skipped because run state already moved",
      );
    }
  }
}
