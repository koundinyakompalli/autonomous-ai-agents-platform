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
import { buildOneShotPullRequestBody, type RetrofitTraceability } from "../pr-body.js";
import {
  buildOneShotArtifactKey,
  getOneShotConsumerConfig,
  type OneShotConsumerConfig,
} from "../config.js";
import { parseOneShotQueueMessage } from "../contracts.js";
import { OneShotDatabase } from "../database/index.js";
import { OneShotPublisher } from "../publisher.js";
import { TRANSIENT_RETRY_EXHAUSTION_RECEIVE_COUNT } from "../consumer-visibility.js";
import { parseOneShotPlan, type OneShotPlan } from "../schema/plan.js";
import {
  parseOneShotImplementation,
  type OneShotImplementation,
} from "../schema/implementation.js";
import {
  parseOneShotTestResult,
  type OneShotTestResult,
} from "../schema/test-result.js";
import {
  createLeasedOneShotWorkspaceManager,
  OneShotWorkspaceManager,
} from "../workspaces.js";
import { ensureRunBranchContract } from "../run-branch-contract.js";
import {
  ensureDraftPullRequest,
  fetchCommitStatusSummary,
  updatePullRequest,
  parseGitHubRepoUrl,
  type CreatedPullRequest,
  type GitHubCommitStatusSummary,
} from "../github.js";
import {
  loadRunQualificationSummary,
  loadRunTicketSummary,
} from "../qualification-artifact.js";
import {
  resolveOneShotProcessingMode,
  type OneShotProcessingMode,
} from "../processing-mode.js";
import { buildOneShotPullRequestTitle } from "../pr-title.js";
import type { NotificationType } from "../types.js";
import {
  buildPrReadyComment,
  buildRunFailedComment,
} from "../jira-comments.js";
import {
  resolveTestCommands,
  executeTestCommand,
  executeGitDiffCheck,
  executeValidationCheck,
  captureTestReportSnapshot,
  findAndParseTestReports,
  findAndParseCoverage,
  truncateOutput,
} from "../test-executor.js";
import {
  buildPostmortemContext,
  transitionRunWithNotification,
  withOneShotTransaction,
} from "../state-transitions.js";
import { verificationLoopCounter } from "../telemetry/metrics.js";
import {
  claimGuardForQueueStage,
  handleClaimMissAfterVersionGuard,
  handleStaleStageVersionMessage,
} from "../stage-version-guard.js";
import {
  buildOneShotReadinessClassification,
  isExternalSpecEvidence,
  isPlanRiskAssessment,
  isQualificationRiskAssessment,
  type ExternalSpecEvidence,
  type OneShotReadinessClassification,
  type OneShotReadinessReason,
  type OneShotRiskCategory,
  type PlanRiskAssessment,
  type QualificationRiskAssessment,
} from "../readiness.js";
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
import type { OneShotRunEvent } from "../database/events.js";

const logger = createLogger("oneshot-tester-consumer");
const CI_POLL_ATTEMPTS = 6;
const CI_POLL_INTERVAL_MS = 15_000;

type TestFailureKind =
  | "passed"
  | "automated_test_failure"
  | "validation_failure"
  | "invalid_command"
  | "no_runnable_command";

interface TestRunOutcome {
  testResult: OneShotTestResult;
  failureKind: TestFailureKind;
}

function isMissingRunnerStartupFailure(result: {
  exitCode: number;
  stdout: string;
  stderr: string;
}): boolean {
  if (result.exitCode !== 127) {
    return false;
  }

  const output = `${result.stdout}\n${result.stderr}`;
  return /(?:^|\n)\s*(?:npm ERR!\s+)?(?:[^:\n]+:\s*)?(?:\d+:\s*)?(?:[^:\n]+:\s*)?(?:command not found|not found|No such file or directory)\s*(?:\n|$)/i.test(
    output,
  );
}

function hasParsedTestReportEvidence(report: {
  passCount: number;
  failCount: number;
  skipCount: number;
  failedTests: unknown[];
}): boolean {
  return (
    report.passCount > 0 ||
    report.failCount > 0 ||
    report.skipCount > 0 ||
    report.failedTests.length > 0
  );
}

function hasUnrevertedValidationRetry(events: OneShotRunEvent[]): boolean {
  const validationRetryTransitions = events.filter(
    (event) =>
      event.event_type === "state_transition" &&
      event.stage === "testing" &&
      event.metadata_json?.reason === "validation_failure" &&
      event.to_state === "queued_for_implementation",
  ).length;
  const validationRetryReverts = events.filter(
    (event) =>
      event.event_type === "state_revert" &&
      event.stage === "testing" &&
      event.metadata_json?.reason === "publish_failed" &&
      event.metadata_json?.validationOnly === true,
  ).length;
  return validationRetryTransitions > validationRetryReverts;
}

function notificationTypeForReadiness(
  readiness: OneShotReadinessClassification,
): NotificationType {
  switch (readiness.readiness) {
    case "ready":
      return "pr_ready";
    case "draft":
      return "pr_draft";
    case "with_risks":
      return "pr_with_risks";
    case "needs_review":
    case "no_action":
      return "pr_needs_review";
  }
}

function previewReadyForReadiness(
  repoName: string,
  readiness: OneShotReadinessClassification,
): boolean {
  return repoName === "core-app" && readiness.readiness === "ready";
}

function pullRequestSyncError(
  pr: Pick<CreatedPullRequest, "draftSyncError" | "updateSyncError">,
): string | null {
  return pr.updateSyncError ?? pr.draftSyncError ?? null;
}

interface TesterConsumerDeps {
  config?: OneShotConsumerConfig;
  db?: Database;
  sqsClient?: SQSClient;
  s3Client?: S3Client;
  publisher?: OneShotPublisher;
  workspaceManager?: OneShotWorkspaceManager;
  ciPollDelay?: (ms: number) => Promise<void>;
  ciPollAttempts?: number;
  ciPollIntervalMs?: number;
}

export class TesterConsumer extends QueueConsumerBase {
  private readonly config: OneShotConsumerConfig;
  private readonly db: Database;
  private readonly oneShotDb: OneShotDatabase;
  private readonly publisher: OneShotPublisher;
  private readonly s3Client: S3Client;
  private readonly workspaceManager: OneShotWorkspaceManager;
  private readonly ciPollDelay: (ms: number) => Promise<void>;
  private readonly ciPollAttempts: number;
  private readonly ciPollIntervalMs: number;

  constructor(private readonly deps: TesterConsumerDeps = {}) {
    const config = deps.config ?? getOneShotConsumerConfig();
    const sqsClient =
      deps.sqsClient ?? new SQSClient({ region: config.region });
    super(config.testingQueueUrl, "testing", sqsClient);
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
    this.ciPollDelay =
      deps.ciPollDelay ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.ciPollAttempts = deps.ciPollAttempts ?? CI_POLL_ATTEMPTS;
    this.ciPollIntervalMs = deps.ciPollIntervalMs ?? CI_POLL_INTERVAL_MS;
  }

  protected getVisibilityTimeoutSeconds(): number {
    return 1800;
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
      logger.warn({ payload }, "Dropping testing message for missing run");
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
        "Dropping stale testing message because run state has moved on",
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
      "testing",
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
      await this.failRun(run.id, run.jira_key, candidateGuard.message);
      await recordCandidateShaIntegrityFailure({
        runId: run.id,
        fromState: "testing",
        toState: "failed",
        stage: "testing",
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
        to_state: "testing",
        stage: "testing",
        metadata_json: { version: payload.version },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: run.id,
          eventType: "run_claimed",
          stage: "testing",
        }),
      );

    let cleanupWorkspace: (() => Promise<void>) | undefined;
    let assertWorkspaceLease: (() => Promise<void>) | undefined;

    try {
      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          testVersion: payload.version,
        },
        "Tester claimed run",
      );

      const implementationVersion = run.current_implementation_version;
      if (!implementationVersion) {
        throw new Error(
          `Run ${run.id} does not have an implementation version for testing`,
        );
      }

      const planVersion = run.current_plan_version;
      if (!planVersion) {
        throw new Error(`Run ${run.id} does not have a plan version`);
      }

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

      const repo = await this.db.getRepositoryById(run.repo_id);
      if (!repo) {
        throw new Error(
          `Repository ${run.repo_id} not found for oneshot run ${run.id}`,
        );
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

      // Extract retrofit traceability from implementation artifact metadata for PR body rendering.
      const retrofitTraceability: RetrofitTraceability | undefined = (() => {
        const meta = implArtifact.metadata_json;
        if (!meta || typeof meta !== 'object') return undefined;
        const m = meta as Record<string, unknown>;
        const manifest = m.retrofitManifest;
        const ctx = m.retrofitContext;
        if (!manifest || !ctx || typeof ctx !== 'object' || Array.isArray(ctx)) return undefined;
        const mf = manifest as { entries?: Array<{ sha: string; status: string }> };
        const cx = ctx as Record<string, unknown>;
        if (!mf.entries || !Array.isArray(mf.entries)) return undefined;
        if (typeof cx.sourceJiraKey !== 'string' || typeof cx.sourceBranch !== 'string' || typeof cx.targetBranch !== 'string') return undefined;
        return {
          sourceJiraKey: cx.sourceJiraKey,
          sourceBranch: cx.sourceBranch,
          targetBranch: cx.targetBranch,
          selectedShas: mf.entries.map((e) => e.sha),
          commitCount: mf.entries.length,
          perCommitStatus: mf.entries.map((e) => ({ sha: e.sha, status: e.status })),
        };
      })();

      const implementationBaseCommitSha =
        implementation.baseCommitSha ?? run.base_commit_sha;
      const codeReviewVersion = run.current_code_review_version;
      const codeReviewArtifact = codeReviewVersion
        ? await this.oneShotDb.artifacts.getArtifact(
            run.id,
            "code_review",
            codeReviewVersion,
          )
        : null;
      const reviewedImplementationCommitSha =
        typeof codeReviewArtifact?.metadata_json?.reviewedImplementationCommitSha ===
        "string"
          ? codeReviewArtifact.metadata_json.reviewedImplementationCommitSha
          : null;
      const legacyUnpinnedCodeReviewArtifact =
        candidateGuard.action === "continue" &&
        candidateGuard.legacyUnpinned &&
        Boolean(codeReviewArtifact) &&
        !reviewedImplementationCommitSha;
      if (
        !codeReviewArtifact ||
        (!legacyUnpinnedCodeReviewArtifact &&
          reviewedImplementationCommitSha !== implementationCommitSha)
      ) {
        const errorMessage = !codeReviewArtifact
          ? `Candidate SHA integrity check failed: missing code review artifact for candidate ${implementationCommitSha}.`
          : `Candidate SHA integrity check failed: code review artifact reviewed ${reviewedImplementationCommitSha ?? "unknown"}, expected ${implementationCommitSha}.`;
        await this.failRun(run.id, run.jira_key, errorMessage);
        await recordCandidateShaIntegrityFailure({
          runId: run.id,
          fromState: "testing",
          toState: "failed",
          stage: "testing",
          metadata: {
            reason: "candidate_sha_integrity_error",
            version: payload.version,
            codeReviewVersion,
            expectedImplementationCommitSha: implementationCommitSha,
            reviewedImplementationCommitSha,
          },
          oneShotDb: this.oneShotDb,
          logger,
        });
        return true;
      }
      if (legacyUnpinnedCodeReviewArtifact) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            testVersion: payload.version,
            codeReviewVersion,
            implementationCommitSha,
          },
          "Allowing legacy testing message with code review artifact missing reviewed candidate SHA",
        );
        this.oneShotDb.events
          .createEvent({
            oneshot_run_id: run.id,
            event_type: "candidate_sha_legacy_unpinned",
            from_state: "testing",
            to_state: "testing",
            stage: "testing",
            metadata_json: {
              reason: "legacy_code_review_artifact_unpinned",
              version: payload.version,
              codeReviewVersion,
              expectedImplementationCommitSha: implementationCommitSha,
            },
          })
          .catch(
            eventEmitFailureLogger({
              logger,
              runId: run.id,
              eventType: "candidate_sha_legacy_unpinned",
              stage: "testing",
            }),
          );
      }

      await ensureRunBranchContract({
        run,
        repo,
        oneShotDb: this.oneShotDb,
        workspaceManager: this.workspaceManager,
        stage: "tester",
        logger,
      });
      const workspace = await this.workspaceManager.prepareTesterWorkspace(
        run.id,
        repo,
        implementationCommitSha,
        implementationBranch,
        implementationBranch,
      );
      cleanupWorkspace = workspace.cleanup;
      assertWorkspaceLease = async () => {
        await workspace.assertLeaseValid?.("testing");
      };

      let testOutcome: TestRunOutcome;
        await assertWorkspaceLease?.();
        const workspaceHead = await getCurrentHeadSha(workspace.workspacePath);
        await assertWorkspaceLease?.();
        if (workspaceHead !== implementationCommitSha) {
          const errorMessage =
            `Tester workspace HEAD mismatch for candidate ${implementationCommitSha}; prepared ${workspaceHead}.`;
          await assertWorkspaceLease?.();
          await this.failRun(run.id, run.jira_key, errorMessage);
          this.oneShotDb.events
            .createEvent({
              oneshot_run_id: run.id,
              event_type: "state_transition",
              from_state: "testing",
              to_state: "failed",
              stage: "testing",
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
                stage: "testing",
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
            implementationVersion,
            testVersion: payload.version,
          },
          "Tester preparing workspace",
        );
        const testStartedAt = new Date().toISOString();
        const testStartedMs = Date.now();
        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            testVersion: payload.version,
            startedAt: testStartedAt,
          },
          "Tester starting test execution loop",
        );
        const qualificationSummary = await loadRunQualificationSummary(
          this.oneShotDb,
          this.s3Client,
          run.id,
        );
        const processingMode = resolveOneShotProcessingMode(
          qualificationSummary,
        );
        testOutcome = await this.runTests(
          run.id,
          workspace.workspacePath,
          implementationBaseCommitSha,
          plan,
          implementation,
          implementationVersion,
          run.current_code_review_version,
          processingMode,
        );
        const { testResult } = testOutcome;
        logger.info(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            testVersion: payload.version,
            completedAt: new Date().toISOString(),
            testDurationMs: Date.now() - testStartedMs,
            passed: testResult.passed,
            passCount: testResult.passCount,
            failCount: testResult.failCount,
            skipCount: testResult.skipCount,
          },
          "Tester completed test execution loop",
        );

      await assertWorkspaceLease?.();

      const artifactKey = buildOneShotArtifactKey(
        this.config,
        run.jira_key,
        run.id,
        "test_result",
        payload.version,
      );

      await assertWorkspaceLease?.();
      await this.s3Client.send(
        new PutObjectCommand({
          Bucket: this.config.artifactBucket,
          Key: artifactKey,
          Body: JSON.stringify(testResult, null, 2),
          ContentType: "application/json",
        }),
      );

      await assertWorkspaceLease?.();
      await this.oneShotDb.artifacts.upsertArtifact({
        oneshot_run_id: run.id,
        stage: "test_result",
        version: payload.version,
        status: "completed",
        s3_bucket: this.config.artifactBucket,
        s3_key: artifactKey,
        provider: "none",
        model: "none",
        metadata_json: {
          passed: testResult.passed,
          passCount: testResult.passCount,
          failCount: testResult.failCount,
          skipCount: testResult.skipCount,
          commandSource: testResult.commandSource,
          executionKind: testResult.executionKind,
          executedCommands: testResult.executedCommands,
          executedValidationChecks: testResult.executedValidationChecks,
          skippedTestCommands: testResult.skippedTestCommands,
          mavenSkippedTestCommands: testResult.mavenSkippedTestCommands,
          mavenBuildsDisabled: testResult.mavenBuildsDisabled,
          unverified: testResult.unverified,
          implementationVersion,
          testedImplementationCommitSha: implementationCommitSha,
          stage_duration_ms: testResult.durationMs ?? 0,
        },
        started_at: new Date(Date.now() - (testResult.durationMs ?? 0)),
        completed_at: new Date(),
      });

      if (
        testOutcome.failureKind === "invalid_command" ||
        testOutcome.failureKind === "no_runnable_command"
      ) {
        return await this.handleNoRunnableTestCommand(
          run,
          implementationBranch,
          plan,
          implementation,
          planArtifact.metadata_json,
          payload.version,
          testResult,
          testOutcome.failureKind,
          assertWorkspaceLease,
        );
      }

      if (testResult.passed) {
        return await this.handleTestsPassed(
          run,
          implementationBranch,
          plan,
          implementation,
          planArtifact.metadata_json,
          testResult,
          assertWorkspaceLease,
          retrofitTraceability,
        );
      }

      if (testOutcome.failureKind === "validation_failure") {
        return await this.handleValidationFailure(
          run,
          implementationBranch,
          plan,
          implementation,
          planArtifact.metadata_json,
          payload.version,
          testResult,
          assertWorkspaceLease,
        );
      }

      return await this.handleTestsFailed(
        run,
        implementationBranch,
        plan,
        implementation,
        planArtifact.metadata_json,
        payload.version,
        testResult,
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
        "Tester consumer failed to process run",
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
        await this.failRun(run.id, run.jira_key, errorMessage);
        return true;
      }

      logger.warn(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          receiveCount,
          nextState: "queued_for_testing",
          error: errorMessage,
        },
        "Tester returning run to queue after transient failure",
      );

      const requeued = await this.oneShotDb.runs.updateRunStateIfCurrentState(
        run.id,
        "testing",
        "queued_for_testing",
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
          "Tester retry skipped because run state already moved",
        );
        return true;
      }

      const retryMeta = await this.shortenVisibilityForTransientRetry(message, receiveCount);

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "testing",
          to_state: "queued_for_testing",
          stage: "testing",
          metadata_json: { reason: "transient_error", receiveCount, transientRetry: retryMeta },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "state_transition",
            stage: "testing",
          }),
        );

      return false;
    } finally {
      await cleanupWorkspace?.().catch(() => undefined);
    }
  }

  private async runTests(
    runId: number,
    workspacePath: string,
    baseCommitSha: string,
    plan: OneShotPlan,
    implementation: OneShotImplementation,
    implementationVersion: number,
    codeReviewVersion: number | null,
    processingMode: OneShotProcessingMode,
  ): Promise<TestRunOutcome> {
    // SonarQube and Wiz Code (SAST) remediations both change source in a single
    // module; a bare repo-root `mvn ... -DskipTests` can skip that module's compile
    // and tests, letting a compile break or regression slip through to the PR.
    // Require module-scoped Maven validation for both lanes.
    const requiresModuleScopedMaven =
      processingMode === "sonar_autofix" || processingMode === "wiz_code";
    const resolution = await resolveTestCommands(
      workspacePath,
      implementation.testCommands,
      implementation.validationCommands,
      plan.plannerDiscoveries?.testCommand,
      implementation.validationChecks,
      {
        mavenBuildsEnabled: this.config.mavenBuildsEnabled,
        ...(requiresModuleScopedMaven ? { requireModuleScopedMaven: true } : {}),
      },
    );

    const parserNotes = [...resolution.parserNotes];
    const mavenSkippedTestCommands = resolution.mavenSkippedTestCommands ?? [];
    const mavenBuildsDisabled = resolution.mavenBuildsDisabled ?? false;
    if (resolution.kind === "none") {
      const unverified = resolution.skippedTestCommands.length > 0;
      const nonMavenSkippedTestCommands = resolution.skippedTestCommands.filter(
        (command) => !mavenSkippedTestCommands.includes(command),
      );
      const skippedOnlyBecauseMavenDisabled =
        mavenBuildsDisabled &&
        mavenSkippedTestCommands.length > 0 &&
        nonMavenSkippedTestCommands.length === 0;
      let noCommandMessage = resolution.failureReason;
      if (skippedOnlyBecauseMavenDisabled) {
        noCommandMessage = `Maven test proof skipped because ONESHOT_MAVEN_BUILDS_ENABLED=false: ${mavenSkippedTestCommands.join(" | ")}`;
      } else if (implementation.manualVerificationSteps.length > 0) {
        noCommandMessage =
          "No runnable automated test command available; implementation only provided manual verification steps.";
      }

      if (implementation.manualVerificationSteps.length > 0) {
        parserNotes.push(
          `Manual verification steps were provided instead: ${implementation.manualVerificationSteps.join(" | ")}`,
        );
      }

      logger.warn(
        {
          runId,
          workspacePath,
          reason: noCommandMessage,
        },
        "No runnable automated test command resolved",
      );

      return {
        failureKind: resolution.executionKind,
        testResult: parseOneShotTestResult({
          resolvedCommand: "(no automated test command available)",
          executionKind: resolution.executionKind,
          executedCommands: [],
          executedValidationChecks: [],
          skippedTestCommands: resolution.skippedTestCommands,
          mavenSkippedTestCommands,
          mavenBuildsDisabled,
          unverified,
          commandSource: "none",
          exitCode: skippedOnlyBecauseMavenDisabled ? 0 : 1,
          passed: skippedOnlyBecauseMavenDisabled,
          passCount: 0,
          failCount: skippedOnlyBecauseMavenDisabled ? 0 : 1,
          skipCount: 0,
          failedTests: skippedOnlyBecauseMavenDisabled
            ? []
            : [
                {
                  testName: "automated-test-command",
                  message: noCommandMessage,
                },
              ],
          truncatedOutput: "",
          parserNotes,
          implementationVersion,
          codeReviewVersion: codeReviewVersion ?? undefined,
          durationMs: 0,
        }),
      };
    }

    const automatedCommands = resolution.automatedCommands;
    const validationCommands = resolution.validationCommands;
    const validationChecks = resolution.validationChecks;
    const skippedTestCommands = resolution.skippedTestCommands;
    const commandSource = resolution.source;
    logger.info(
      {
        automatedCommands,
        validationCommands,
        validationChecksCount: validationChecks.length,
        skippedTestCommands,
        mavenSkippedTestCommands,
        mavenBuildsDisabled,
        source: commandSource,
        executionKind: resolution.executionKind,
      },
      "Resolved test commands",
    );

    let totalPassCount = 0;
    let totalFailCount = 0;
    let totalSkipCount = 0;
    const allFailedTests: Array<{
      testName: string;
      className?: string;
      message: string;
      stackTrace?: string;
    }> = [];
    let lastExitCode = 0;
    let totalDurationMs = 0;
    let lastStdout = "";
    let lastStderr = "";
    const executedCommands: string[] = [];
    const executedValidationChecks: OneShotTestResult["executedValidationChecks"] =
      [];
    const runtimeMissingRunnerCommands: string[] = [];
    const runtimeMissingRunnerOutputs: string[] = [];
    let lastOutputBelongsToRuntimeMissingRunner = false;
    let failureKind: TestFailureKind = "passed";

    const executeCommands = async (
      commands: string[],
      phase: "automated" | "validation",
    ): Promise<void> => {
      for (const command of commands) {
        logger.info({ command, phase }, "Executing test command");
        executedCommands.push(command);
        const reportSnapshot = await captureTestReportSnapshot(workspacePath);
        const execResult = await executeTestCommand(workspacePath, command);
        totalDurationMs += execResult.durationMs;
        lastStdout = execResult.stdout;
        lastStderr = execResult.stderr;
        lastOutputBelongsToRuntimeMissingRunner = false;

        const xmlReport = await findAndParseTestReports(
          workspacePath,
          reportSnapshot,
        );

        if (
          phase === "automated" &&
          isMissingRunnerStartupFailure(execResult) &&
          !hasParsedTestReportEvidence(xmlReport)
        ) {
          if (!skippedTestCommands.includes(command)) {
            skippedTestCommands.push(command);
          }
          runtimeMissingRunnerCommands.push(command);
          lastOutputBelongsToRuntimeMissingRunner = true;
          const diagnosticOutput = truncateOutput(
            execResult.stdout,
            execResult.stderr,
            2000,
          );
          runtimeMissingRunnerOutputs.push(
            `Missing-runner output for "${command}":\n${diagnosticOutput}`,
          );
          parserNotes.push(
            `Automated test command "${command}" exited 127 before tests could start because the runner/environment was unavailable; treating it as unverified proof instead of a source-code test failure. Diagnostic output:\n${diagnosticOutput}`,
          );
          return;
        }

        let passCount = xmlReport.passCount;
        let failCount = xmlReport.failCount;
        const skipCount = xmlReport.skipCount;
        const failedTests = xmlReport.failedTests;

        if (passCount === 0 && failCount === 0) {
          parserNotes.push(
            `No XML test reports found for "${command}"; inferring pass/fail from exit code.`,
          );
          if (execResult.exitCode === 0) {
            passCount = 1;
          } else {
            failCount = 1;
            if (failedTests.length === 0) {
              failedTests.push({
                testName:
                  phase === "validation" ? "validation-command" : "unknown",
                message: `${phase === "validation" ? "Validation" : "Test"} command "${command}" exited with code ${execResult.exitCode}`,
              });
            }
          }
        }

        totalPassCount += passCount;
        totalFailCount += failCount;
        totalSkipCount += skipCount;
        allFailedTests.push(...failedTests);

        if (execResult.exitCode !== 0 || failCount > 0) {
          lastExitCode = execResult.exitCode || 1;
          failureKind =
            phase === "validation"
              ? "validation_failure"
              : "automated_test_failure";
          parserNotes.push(
            `Short-circuiting: "${command}" failed (exit ${execResult.exitCode}, ${failCount} failure(s)). Remaining commands skipped.`,
          );
          return;
        }
      }
    };

    if (automatedCommands.length > 0) {
      await executeCommands(automatedCommands, "automated");
    }

    // validationCommands[] is accepted by the schema for back-compat but is
    // no longer executed as a gate. Raw shell greps cannot express both
    // "must match" and "must not match" intents unambiguously (grep exits 1
    // on no-match, which inverts `must_not_match` semantics into a failure).
    // Structural assertions go through `validationChecks[]` instead, which
    // carries the intent explicitly and runs through `executeValidationCheck`.
    // Surface the deprecated field as advisory so implementer-prompt drift
    // stays visible.
    if (validationCommands.length > 0) {
      parserNotes.push(
        `Found ${validationCommands.length} validationCommands entries — these are advisory only ` +
          `and not executed as gates. Use validationChecks[] for structural assertions.`,
      );
      logger.warn(
        {
          runId,
          count: validationCommands.length,
          commands: validationCommands,
        },
        "[TESTER_VALIDATION_COMMANDS_IGNORED] validationCommands are deprecated as gates; use validationChecks[]",
      );
    }

    if (failureKind === "passed" && validationChecks.length > 0) {
      if (automatedCommands.length > 0) {
        parserNotes.push(
          runtimeMissingRunnerCommands.length > 0
            ? "Automated test proof unavailable because a runner/environment was missing; running structured validation checks next."
            : "Automated tests passed; running structured validation checks next.",
        );
      }
      for (const check of validationChecks) {
        const checkResult = await executeValidationCheck(workspacePath, check, {
          baseCommitSha,
        });
        totalDurationMs += checkResult.durationMs;
        lastStdout = checkResult.stdout;
        lastStderr = checkResult.stderr;
        lastOutputBelongsToRuntimeMissingRunner = false;
        lastExitCode = checkResult.passed
          ? lastExitCode
          : checkResult.exitCode || 1;
        executedCommands.push(checkResult.command);
        executedValidationChecks.push({
          kind: check.kind,
          pattern: check.pattern,
          paths: check.paths,
          scope: check.scope ?? "file",
          passed: checkResult.passed,
          exitCode: checkResult.exitCode,
          outputPreview: truncateOutput(
            checkResult.stdout,
            checkResult.stderr,
            2000,
          ),
        });

        if (checkResult.passed) {
          totalPassCount += 1;
          continue;
        }

        totalFailCount += 1;
        failureKind = "validation_failure";
        allFailedTests.push({
          testName: "validation-check",
          message:
            check.kind === "must_match"
              ? `Structured validation check expected a match for pattern "${check.pattern}" but found none.`
              : `Structured validation check expected no matches for pattern "${check.pattern}" but found matches.`,
          stackTrace: truncateOutput(
            checkResult.stdout,
            checkResult.stderr,
            4000,
          ),
        });
        parserNotes.push(
          `Short-circuiting: structured validation check "${check.kind}:${check.pattern}" failed (exit ${checkResult.exitCode}). Remaining checks skipped.`,
        );
        break;
      }
    }

    if (failureKind === "passed" && requiresModuleScopedMaven) {
      const remediationLabel =
        processingMode === "wiz_code" ? "Wiz Code remediation" : "SonarQube remediation";
      const diffCheck = await executeGitDiffCheck(workspacePath, baseCommitSha);
      totalDurationMs += diffCheck.durationMs;
      lastStdout = diffCheck.stdout;
      lastStderr = diffCheck.stderr;
      lastOutputBelongsToRuntimeMissingRunner = false;
      lastExitCode = diffCheck.exitCode === 0 ? lastExitCode : diffCheck.exitCode || 1;
      executedCommands.push(`git diff --check ${baseCommitSha} HEAD --`);
      if (diffCheck.exitCode === 0) {
        totalPassCount += 1;
        parserNotes.push(
          `${remediationLabel} diff-check passed with no whitespace/conflict-marker issues.`,
        );
      } else {
        totalFailCount += 1;
        failureKind = "validation_failure";
        allFailedTests.push({
          testName: "remediation-diff-check",
          message:
            `${remediationLabel} failed git diff --check; clean whitespace/conflict markers before approval.`,
          stackTrace: truncateOutput(diffCheck.stdout, diffCheck.stderr, 4000),
        });
        parserNotes.push(
          `Short-circuiting: ${remediationLabel} git diff --check failed (exit ${diffCheck.exitCode}).`,
        );
      }
    }

    const unverified = skippedTestCommands.length > 0;
    const nonMavenSkippedTestCommands = skippedTestCommands.filter(
      (command) => !mavenSkippedTestCommands.includes(command),
    );
    const skippedOnlyBecauseMavenDisabled =
      mavenBuildsDisabled &&
      mavenSkippedTestCommands.length > 0 &&
      nonMavenSkippedTestCommands.length === 0;
    const shouldFailForSkippedCommands =
      (commandSource === "implementation" ||
        runtimeMissingRunnerCommands.length > 0) &&
      skippedTestCommands.length > 0 &&
      executedValidationChecks.length === 0 &&
      !skippedOnlyBecauseMavenDisabled;
    if (shouldFailForSkippedCommands && failureKind === "passed") {
      failureKind = "no_runnable_command";
      lastExitCode = 1;
      totalFailCount += 1;
      allFailedTests.push({
        testName: "automated-test-command",
        message: skippedOnlyBecauseMavenDisabled
          ? `Declared Maven test command(s) were skipped because ONESHOT_MAVEN_BUILDS_ENABLED=false: ${mavenSkippedTestCommands.join(" | ")}`
          : `Declared test command(s) were skipped because the executable/environment was unavailable: ${skippedTestCommands.join(" | ")}`,
      });
      parserNotes.push(
        skippedOnlyBecauseMavenDisabled
          ? "Marking artifact unverified because Maven builds are disabled and no non-Maven automated test command ran."
          : "Marking artifact unverified because at least one declared testCommands entry was skipped due to missing executable/environment.",
      );
    } else if (skippedTestCommands.length > 0 && failureKind === "passed") {
      parserNotes.push(
        runtimeMissingRunnerCommands.length > 0
          ? "Automated test proof was skipped because a runner/environment was unavailable, but structured validation checks passed; retaining skipped-command metadata as unverified proof without treating it as a test failure."
          : `Command(s) were skipped, but ${commandSource} automated test command(s) ran successfully; retaining skipped-command metadata as unverified proof without treating it as a test failure.`,
      );
    }

    const coverage =
      automatedCommands.length > 0
        ? await findAndParseCoverage(workspacePath)
        : undefined;
    const coveragePassed = !coverage || coverage.passed;
    const passed = lastExitCode === 0 && totalFailCount === 0 && coveragePassed;

    if (coverage && !coverage.passed && failureKind === "passed") {
      parserNotes.push(
        `Coverage below threshold: line=${coverage.linePercent ?? "N/A"}%, branch=${coverage.branchPercent ?? "N/A"}%`,
      );
      failureKind = "automated_test_failure";
    }

    const executionKind =
      automatedCommands.length > 0 ? "automated_tests" : "validation_only";
    const truncatedOutput =
      runtimeMissingRunnerOutputs.length > 0
        ? truncateOutput(
            lastOutputBelongsToRuntimeMissingRunner
              ? ""
              : `${lastStdout}\n${lastStderr}`,
            runtimeMissingRunnerOutputs.join("\n\n"),
            6000,
          )
        : truncateOutput(lastStdout, lastStderr, 6000);

    return {
      failureKind: passed ? "passed" : failureKind,
      testResult: parseOneShotTestResult({
        resolvedCommand:
          executedCommands.length > 0
            ? executedCommands.join(" && ")
            : "(no commands executed)",
        executionKind,
        executedCommands,
        executedValidationChecks,
        skippedTestCommands,
        mavenSkippedTestCommands,
        mavenBuildsDisabled,
        unverified,
        commandSource,
        exitCode: lastExitCode,
        passed,
        passCount: totalPassCount,
        failCount: totalFailCount,
        skipCount: totalSkipCount,
        coverage: coverage
          ? {
              linePercent: coverage.linePercent,
              branchPercent: coverage.branchPercent,
              threshold: coverage.threshold,
              passed: coverage.passed,
            }
          : undefined,
        failedTests: allFailedTests,
        truncatedOutput,
        parserNotes,
        implementationVersion,
        codeReviewVersion: codeReviewVersion ?? undefined,
        durationMs: totalDurationMs,
      }),
    };
  }

  private async handleNoRunnableTestCommand(
    run: {
      id: number;
      jira_key: string;
      branch_name: string;
      base_commit_sha: string;
      repo_id: number;
      current_code_review_version: number | null;
    },
    implementationBranch: string,
    plan: OneShotPlan,
    implementation: OneShotImplementation,
    planMetadata: Record<string, unknown> | null | undefined,
    testVersion: number,
    testResult: OneShotTestResult,
    failureKind: "invalid_command" | "no_runnable_command",
    assertWorkspaceLease?: () => Promise<void>,
  ): Promise<boolean> {
    const failedMessage =
      testResult.mavenBuildsDisabled &&
      testResult.mavenSkippedTestCommands.length > 0
        ? `Maven test proof skipped because ONESHOT_MAVEN_BUILDS_ENABLED=false: ${testResult.mavenSkippedTestCommands.join(" | ")}`
        : (testResult.failedTests[0]?.message ??
          "No runnable automated test command available.");

    return this.finalizeTestingQualityGate(
      run,
      implementationBranch,
      plan,
      implementation,
      planMetadata,
      testVersion,
      testResult,
      failedMessage,
      failureKind,
      assertWorkspaceLease,
    );
  }

  private async handleValidationFailure(
    run: {
      id: number;
      jira_key: string;
      branch_name: string;
      base_commit_sha: string;
      repo_id: number;
      current_implementation_version: number | null;
      current_code_review_version: number | null;
      current_test_version: number | null;
    },
    implementationBranch: string,
    plan: OneShotPlan,
    implementation: OneShotImplementation,
    planMetadata: Record<string, unknown> | null | undefined,
    testVersion: number,
    testResult: OneShotTestResult,
    assertWorkspaceLease?: () => Promise<void>,
  ): Promise<boolean> {
    verificationLoopCounter.add(1, { stage: "testing" });

    const priorEvents = await this.oneShotDb.events.getEventsForRun(run.id);
    const hasPriorValidationRetry = hasUnrevertedValidationRetry(priorEvents);

    if (!hasPriorValidationRetry) {
      const nextImplVersion = (run.current_implementation_version ?? 0) + 1;
      await assertWorkspaceLease?.();
      const transitioned = await withOneShotTransaction(this.db, async (txdb) => {
        const didTransition = await txdb.runs.updateRunStateIfCurrentState(
          run.id,
          "testing",
          "queued_for_implementation",
          {
            current_test_version: testVersion,
            current_implementation_version: nextImplVersion,
            last_error: `${testResult.failCount} validation command(s) failed`,
          },
        );
        if (!didTransition) {
          return false;
        }

        await txdb.events.createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "testing",
          to_state: "queued_for_implementation",
          stage: "testing",
          metadata_json: {
            version: testVersion,
            failCount: testResult.failCount,
            reason: "validation_failure",
          },
        });
        return true;
      });
      if (!transitioned) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            testVersion,
            nextImplVersion,
          },
          "Tester validation retry transition skipped because run state already moved",
        );
        return true;
      }

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
          "Failed to publish implementation message after validation failure; reverting state to testing",
        );
        const reverted = await withOneShotTransaction(this.db, async (txdb) => {
          const didRevert = await txdb.runs.updateRunStateIfCurrentState(
            run.id,
            "queued_for_implementation",
            "testing",
            {
              current_implementation_version: run.current_implementation_version,
              current_test_version: run.current_test_version,
              last_error: publishErrorMessage,
            },
          );
          if (!didRevert) {
            return false;
          }

          await txdb.events.createEvent({
            oneshot_run_id: run.id,
            event_type: "state_revert",
            from_state: "queued_for_implementation",
            to_state: "testing",
            stage: "testing",
            metadata_json: {
              reason: "publish_failed",
              version: testVersion,
              nextImplementationVersion: nextImplVersion,
              failCount: testResult.failCount,
              publishError: publishErrorMessage,
              validationOnly: true,
            },
          });
          return true;
        });
        if (reverted) {
          logger.info(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              testVersion,
              nextImplVersion,
            },
            "Tester validation publish-failure revert persisted durably",
          );
        } else {
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              testVersion,
              nextImplVersion,
            },
            "Skipped tester validation publish-failure revert because run state already moved",
          );
        }
        throw publishError;
      }

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          testVersion,
          failCount: testResult.failCount,
        },
        "Validation commands failed, queued for single implementation revision",
      );

      return true;
    }

    return this.finalizeTestingQualityGate(
      run,
      implementationBranch,
      plan,
      implementation,
      planMetadata,
      testVersion,
      testResult,
      `${testResult.failCount} validation command(s) failed after one validation-only retry`,
      "validation_failed",
      assertWorkspaceLease,
    );
  }

  private async pollCommitStatusSummary(input: {
    owner: string;
    repo: string;
    ref: string;
    base: string;
    pullNumber?: number | null;
  }): Promise<GitHubCommitStatusSummary> {
    let latest: GitHubCommitStatusSummary | null = null;
    let consecutiveZeroCheckSuccesses = 0;
    for (let attempt = 1; attempt <= this.ciPollAttempts; attempt++) {
      latest = await fetchCommitStatusSummary({
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        base: input.base,
        pullNumber: input.pullNumber,
      }).catch((error) => ({
        state: "unavailable" as const,
        description: `GitHub CI status lookup failed: ${error instanceof Error ? error.message : String(error)}`,
        statusCount: 0,
        checkRunCount: 0,
        requiredCheckState: "unavailable" as const,
        details: ["lookup exception"],
      }));
      const zeroCheckSuccess =
        Boolean(input.pullNumber) &&
        latest.state === "success" &&
        (latest.statusCount ?? 0) === 0 &&
        (latest.checkRunCount ?? 0) === 0 &&
        latest.requiredCheckState === "none";
      consecutiveZeroCheckSuccesses = zeroCheckSuccess
        ? consecutiveZeroCheckSuccesses + 1
        : 0;
      if (
        zeroCheckSuccess &&
        consecutiveZeroCheckSuccesses < 2 &&
        attempt < this.ciPollAttempts
      ) {
        await this.ciPollDelay(this.ciPollIntervalMs);
        continue;
      }
      if (
        latest.state === "success" ||
        latest.state === "failure" ||
        latest.state === "error"
      ) {
        return latest;
      }
      if (attempt < this.ciPollAttempts) {
        await this.ciPollDelay(this.ciPollIntervalMs);
      }
    }
    return (
      latest ?? {
        state: "unavailable",
        description: "GitHub CI status lookup did not return a result.",
        statusCount: 0,
        checkRunCount: 0,
        requiredCheckState: "unavailable",
        details: ["no result"],
      }
    );
  }

  /**
   * Build the multi-repo context for the PR body when this run belongs to a
   * run group. Returns null for ungrouped (single-repo) runs. Non-fatal: on
   * any DB error the context is omitted rather than aborting PR creation.
   */
  private async buildMultiRepoContextForPr(
    runGroupId: number | null | undefined,
    currentRepoName: string,
  ): Promise<import("../pr-body.js").MultiRepoContext | null> {
    if (!runGroupId) {
      return null;
    }
    try {
      const group = await this.oneShotDb.runGroups.getGroupById(runGroupId);
      if (!group?.metadata_json) {
        return null;
      }
      const metadata = group.metadata_json as {
        mode?: string;
        repos?: Array<{ repo_name: string }>;
        mergeOrder?: Record<string, number>;
      };
      if (metadata.mode !== "multi_repo") {
        return null;
      }
      const repos = metadata.repos ?? [];
      const totalRepos = repos.length;
      const siblingRepos = repos
        .map((r) => r.repo_name)
        .filter((name) => name !== currentRepoName);
      const mergeOrder = metadata.mergeOrder ?? {};
      const currentMergeOrder = mergeOrder[currentRepoName] ?? 1;
      return {
        repoRef: currentRepoName,
        mergeOrder: currentMergeOrder,
        totalRepos: totalRepos > 0 ? totalRepos : siblingRepos.length + 1,
        siblingRepos,
      };
    } catch (error) {
      logger.warn(
        {
          runGroupId,
          repoName: currentRepoName,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to load run group metadata for PR body multi-repo context; omitting section",
      );
      return null;
    }
  }

  private prStateSyncFailureReason(message: string): OneShotReadinessReason {
    return {
      code: "pr_state_sync_failed",
      category: "code_review",
      severity: "high",
      source: "github_pr_state",
      message: `GitHub PR title/body or draft/ready state could not be synchronized: ${message}`,
    };
  }

  private prHeadChangedAfterTestReason(input: {
    testedCommitSha: string;
    prHeadSha: string;
  }): OneShotReadinessReason {
    return {
      code: "pr_head_changed_after_test",
      category: "unverified_tests",
      severity: "high",
      source: "github_pr_state",
      message:
        `PR branch head changed to ${input.prHeadSha} after this run tested ${input.testedCommitSha}; ` +
        "latest branch head needs its own completed test evidence before the PR can be marked ready.",
    };
  }

  private readinessEvidenceMetadata(input: {
    readiness: OneShotReadinessClassification;
    ciStatus?: GitHubCommitStatusSummary | null;
    planMetadata: Record<string, unknown> | null | undefined;
    testResult?: OneShotTestResult | null;
  }): Record<string, unknown> {
    const planMetadata = input.planMetadata ?? {};
    return {
      readiness: input.readiness,
      ciStatus: input.ciStatus ?? null,
      riskAssessment: {
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
      },
      externalSpecEvidence: isExternalSpecEvidence(
        planMetadata.externalSpecEvidence,
      )
        ? planMetadata.externalSpecEvidence
        : null,
      unverifiedTests: input.testResult?.unverified
        ? (input.testResult.skippedTestCommands ?? [])
        : [],
      testResult: input.testResult
        ? {
            executionKind: input.testResult.executionKind,
            unverified: input.testResult.unverified ?? false,
            skippedTestCommands: input.testResult.skippedTestCommands ?? [],
            mavenSkippedTestCommands:
              input.testResult.mavenSkippedTestCommands ?? [],
            mavenBuildsDisabled:
              input.testResult.mavenBuildsDisabled ?? false,
          }
        : null,
    };
  }

  private finalizedRiskOutcome(
    readiness: OneShotReadinessClassification,
  ): "ready" | "draft" | "needs_review" {
    if (readiness.readiness === "ready") {
      return "ready";
    }
    if (readiness.readiness === "needs_review") {
      return "needs_review";
    }
    return "draft";
  }

  private emitReadinessEvents(input: {
    runId: number;
    fromState: "testing";
    toState: "pr_open";
    stage: "testing";
    readiness: OneShotReadinessClassification;
    ciStatus?: GitHubCommitStatusSummary | null;
    planMetadata: Record<string, unknown> | null | undefined;
    testResult: OneShotTestResult;
    extraStateTransitionMetadata?: Record<string, unknown>;
  }): void {
    const metadata = this.readinessEvidenceMetadata({
      readiness: input.readiness,
      ciStatus: input.ciStatus,
      planMetadata: input.planMetadata,
      testResult: input.testResult,
    });
    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.runId,
        event_type: "state_transition",
        from_state: input.fromState,
        to_state: input.toState,
        stage: input.stage,
        metadata_json: {
          ...input.extraStateTransitionMetadata,
          ...metadata,
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.runId,
          eventType: "state_transition",
          stage: input.stage,
        }),
      );

    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.runId,
        event_type: "readiness_classified",
        from_state: input.fromState,
        to_state: input.toState,
        stage: input.stage,
        metadata_json: metadata,
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.runId,
          eventType: "readiness_classified",
          stage: input.stage,
        }),
      );

    const planMetadata = input.planMetadata ?? {};
    const planRiskAssessment = isPlanRiskAssessment(
      planMetadata.planRiskAssessment,
    )
      ? planMetadata.planRiskAssessment
      : null;
    const qualificationRiskAssessment = isQualificationRiskAssessment(
      planMetadata.qualificationRiskAssessment,
    )
      ? planMetadata.qualificationRiskAssessment
      : null;
    const externalSpecEvidence = isExternalSpecEvidence(
      planMetadata.externalSpecEvidence,
    )
      ? planMetadata.externalSpecEvidence
      : null;
    const categories: OneShotRiskCategory[] = [
      ...(planRiskAssessment?.findings ?? []).map(
        (finding) => finding.category,
      ),
      ...(qualificationRiskAssessment?.findings ?? []).map(
        (finding) => finding.category,
      ),
    ];
    if (
      externalSpecEvidence &&
      (externalSpecEvidence.urls.length > 0 || externalSpecEvidence.unavailable)
    ) {
      categories.push("external_spec_contract");
    }
    const observedCategories = [...new Set(categories)];
    const readinessCategories = new Set(
      input.readiness.reasons.map((reason) => reason.category),
    );
    const affectedCategories = observedCategories.filter((category) =>
      readinessCategories.has(category),
    );
    this.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.runId,
        event_type: "risk_classification_finalized",
        from_state: input.fromState,
        to_state: input.toState,
        stage: input.stage,
        metadata_json: {
          categories: observedCategories,
          completionStatus: input.readiness.completionStatus,
          readiness: input.readiness.readiness,
          ciState: input.ciStatus?.state ?? null,
          affectedReadiness: affectedCategories.length > 0,
          affectedCategories,
          categoryOutcomes: observedCategories.map((category) => ({
            category,
            affectedReadiness: readinessCategories.has(category),
          })),
          actualOutcome: this.finalizedRiskOutcome(input.readiness),
        },
      })
      .catch(
        eventEmitFailureLogger({
          logger,
          runId: input.runId,
          eventType: "risk_classification_finalized",
          stage: input.stage,
        }),
      );
  }

  private async createPullRequestWithFinalReadiness(input: {
    run: {
      id: number;
      jira_key: string;
      branch_name: string;
      current_code_review_version: number | null;
      run_group_id?: number | null;
    };
    owner: string;
    repoName: string;
    implementationBranch: string;
    plan: OneShotPlan;
    implementation: OneShotImplementation;
    planMetadata: Record<string, unknown> | null | undefined;
    testResult: OneShotTestResult;
    ticketSummary: string;
    testFailureReason?: string | null;
    retrofitTraceability?: RetrofitTraceability;
  }): Promise<{
    pr: CreatedPullRequest & { reused: boolean };
    readiness: OneShotReadinessClassification;
    ciStatus: GitHubCommitStatusSummary;
  }> {
    const provisionalCiStatus: GitHubCommitStatusSummary = {
      state: "pending",
      description:
        "GitHub CI will be checked after the draft pull request is created.",
      statusCount: 0,
      checkRunCount: 0,
      requiredCheckState: "unavailable",
      details: ["waiting for PR creation"],
    };

    // Build multi-repo context for PR body when this run belongs to a group.
    const multiRepoContext = await this.buildMultiRepoContextForPr(
      input.run.run_group_id ?? null,
      input.repoName,
    );

    const provisionalReadiness = await this.buildReadinessClassification({
      runId: input.run.id,
      codeReviewVersion: input.run.current_code_review_version,
      planMetadata: input.planMetadata,
      testResult: input.testResult,
      testFailureReason: input.testFailureReason,
      ciStatus: provisionalCiStatus,
    });
    const provisionalBody = buildOneShotPullRequestBody({
      jiraKey: input.run.jira_key,
      ticketSummary: input.ticketSummary,
      plan: input.plan,
      implementation: input.implementation,
      readiness: provisionalReadiness,
      multiRepoContext: multiRepoContext ?? undefined,
      retrofitTraceability: input.retrofitTraceability,
    });
    let pr = await ensureDraftPullRequest({
      owner: input.owner,
      repo: input.repoName,
      title: buildOneShotPullRequestTitle({
        jiraKey: input.run.jira_key,
        ticketSummary: input.ticketSummary,
        wip: true,
      }),
      head: input.implementationBranch,
      base: input.run.branch_name,
      body: provisionalBody,
      draft: true,
    });
    const prHeadChangedReason =
      pr.headSha && pr.headSha !== input.implementation.implementationCommitSha
        ? this.prHeadChangedAfterTestReason({
            testedCommitSha: input.implementation.implementationCommitSha,
            prHeadSha: pr.headSha,
          })
        : null;

    const ciStatus = await this.pollCommitStatusSummary({
      owner: input.owner,
      repo: input.repoName,
      ref: pr.headSha ?? input.implementation.implementationCommitSha,
      base: input.run.branch_name,
      pullNumber: pr.number,
    });
    let readiness = await this.buildReadinessClassification({
      runId: input.run.id,
      codeReviewVersion: input.run.current_code_review_version,
      planMetadata: input.planMetadata,
      testResult: input.testResult,
      testFailureReason: input.testFailureReason,
      ciStatus,
      additionalReasons: prHeadChangedReason ? [prHeadChangedReason] : [],
    });
    let finalBody = buildOneShotPullRequestBody({
      jiraKey: input.run.jira_key,
      ticketSummary: input.ticketSummary,
      plan: input.plan,
      implementation: input.implementation,
      readiness,
      multiRepoContext: multiRepoContext ?? undefined,
      retrofitTraceability: input.retrofitTraceability,
    });
    pr = await ensureDraftPullRequest({
      owner: input.owner,
      repo: input.repoName,
      title: buildOneShotPullRequestTitle({
        jiraKey: input.run.jira_key,
        ticketSummary: input.ticketSummary,
        wip: readiness.readiness !== "ready",
      }),
      head: input.implementationBranch,
      base: input.run.branch_name,
      body: finalBody,
      draft: readiness.readiness !== "ready",
    });

    const prSyncError = pullRequestSyncError(pr);
    if (prSyncError) {
      readiness = await this.buildReadinessClassification({
        runId: input.run.id,
        codeReviewVersion: input.run.current_code_review_version,
        planMetadata: input.planMetadata,
        testResult: input.testResult,
        testFailureReason: input.testFailureReason,
        ciStatus,
        additionalReasons: [
          ...(prHeadChangedReason ? [prHeadChangedReason] : []),
          this.prStateSyncFailureReason(prSyncError),
        ],
      });
      finalBody = buildOneShotPullRequestBody({
        jiraKey: input.run.jira_key,
        ticketSummary: input.ticketSummary,
        plan: input.plan,
        implementation: input.implementation,
        readiness,
        multiRepoContext: multiRepoContext ?? undefined,
        retrofitTraceability: input.retrofitTraceability,
      });
      if (!pr.updateSyncError) {
        try {
          const updated = await updatePullRequest({
            owner: input.owner,
            repo: input.repoName,
            pullNumber: pr.number,
            title: buildOneShotPullRequestTitle({
              jiraKey: input.run.jira_key,
              ticketSummary: input.ticketSummary,
              wip: true,
            }),
            body: finalBody,
          });
          pr = {
            ...pr,
            ...updated,
            reused: pr.reused,
            draftSyncError: pr.draftSyncError,
            updateSyncError: pr.updateSyncError,
          };
        } catch (error) {
          pr = {
            ...pr,
            updateSyncError:
              error instanceof Error ? error.message : String(error),
          };
        }
      }
    }

    return { pr, readiness, ciStatus };
  }

  private async handleTestsPassed(
    run: {
      id: number;
      jira_key: string;
      branch_name: string;
      base_commit_sha: string;
      repo_id: number;
      current_code_review_version: number | null;
      run_group_id?: number | null;
    },
    implementationBranch: string,
    plan: OneShotPlan,
    implementation: OneShotImplementation,
    planMetadata: Record<string, unknown> | null | undefined,
    testResult: OneShotTestResult,
    assertWorkspaceLease?: () => Promise<void>,
    retrofitTraceability?: RetrofitTraceability,
  ): Promise<boolean> {
    const repo = await this.db.getRepositoryById(run.repo_id);
    if (!repo) {
      throw new Error(`Repository ${run.repo_id} not found for PR creation`);
    }

    const { owner, repo: repoName } = parseGitHubRepoUrl(repo.repo_url);
    const ticketSummary = await loadRunTicketSummary(
      this.oneShotDb,
      this.s3Client,
      run.id,
    );
    await assertWorkspaceLease?.();
    const { pr, readiness, ciStatus } =
      await this.createPullRequestWithFinalReadiness({
        run,
        owner,
        repoName,
        implementationBranch,
        plan,
        implementation,
        planMetadata,
        testResult,
        ticketSummary,
        retrofitTraceability,
      });

    await assertWorkspaceLease?.();
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: run.id,
      fromState: "testing",
      toState: "pr_open",
      updates: {
        current_pr_url: pr.htmlUrl,
        last_error:
          readiness.reasons.length > 0
            ? readiness.reasons.map((reason) => reason.message).join(" | ")
            : null,
        final_disposition: readiness.completionStatus,
      },
      notification: {
        oneshot_run_id: run.id,
        jira_key: run.jira_key,
        notification_type: notificationTypeForReadiness(readiness),
        body_markdown: buildPrReadyComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey: run.jira_key,
          prNumber: pr.number,
          prUrl: pr.htmlUrl,
          testResult,
          readiness,
          previewReady: previewReadyForReadiness(repo.repo_name, readiness),
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
          prUrl: pr.htmlUrl,
        },
        "Tester PR-open transition skipped because run state already moved",
      );
      return true;
    }

    this.emitReadinessEvents({
      runId: run.id,
      fromState: "testing",
      toState: "pr_open",
      stage: "testing",
      readiness,
      ciStatus,
      planMetadata,
      testResult,
      extraStateTransitionMetadata: {
        prNumber: pr.number,
        prUrl: pr.htmlUrl,
      },
    });

    logger.info(
      {
        runId: run.id,
        jiraKey: run.jira_key,
        prNumber: pr.number,
        prUrl: pr.htmlUrl,
        reusedExistingPr: pr.reused,
        readiness: readiness.readiness,
      },
      readiness.readiness === "ready"
        ? "Tests passed, ready PR created"
        : "Tests passed, draft PR created",
    );

    return true;
  }

  private async handleTestsFailed(
    run: {
      id: number;
      jira_key: string;
      branch_name: string;
      base_commit_sha: string;
      repo_id: number;
      verification_loop_count: number;
      max_verification_loops: number;
      current_implementation_version: number | null;
      current_code_review_version: number | null;
      current_test_version: number | null;
    },
    implementationBranch: string,
    plan: OneShotPlan,
    implementation: OneShotImplementation,
    planMetadata: Record<string, unknown> | null | undefined,
    testVersion: number,
    testResult: OneShotTestResult,
    assertWorkspaceLease?: () => Promise<void>,
  ): Promise<boolean> {
    await assertWorkspaceLease?.();
    await this.oneShotDb.runs.incrementVerificationLoop(run.id);
    verificationLoopCounter.add(1, { stage: "testing" });
    const withinBudget = await this.oneShotDb.runs.checkVerificationBudget(
      run.id,
    );

    if (withinBudget) {
      const nextImplVersion = (run.current_implementation_version ?? 0) + 1;
      await assertWorkspaceLease?.();
      const transitioned =
        await this.oneShotDb.runs.updateRunStateIfCurrentState(
          run.id,
          "testing",
          "queued_for_implementation",
          {
            current_test_version: testVersion,
            current_implementation_version: nextImplVersion,
            last_error: `${testResult.failCount} test(s) failed`,
          },
        );
      if (!transitioned) {
        logger.warn(
          {
            runId: run.id,
            jiraKey: run.jira_key,
            testVersion,
            nextImplVersion,
          },
          "Tester implementation revision transition skipped because run state already moved",
        );
        return true;
      }

      this.oneShotDb.events
        .createEvent({
          oneshot_run_id: run.id,
          event_type: "state_transition",
          from_state: "testing",
          to_state: "queued_for_implementation",
          stage: "testing",
          metadata_json: {
            version: testVersion,
            failCount: testResult.failCount,
          },
        })
        .catch(
          eventEmitFailureLogger({
            logger,
            runId: run.id,
            eventType: "state_transition",
            stage: "testing",
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
          "Failed to publish implementation message after test failure; reverting state to testing",
        );
        const reverted = await this.oneShotDb.runs.updateRunStateIfCurrentState(
          run.id,
          "queued_for_implementation",
          "testing",
          {
            current_implementation_version: run.current_implementation_version,
            current_test_version: run.current_test_version,
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
              to_state: "testing",
              stage: "testing",
              metadata_json: {
                reason: "publish_failed",
                version: testVersion,
                nextImplementationVersion: nextImplVersion,
                failCount: testResult.failCount,
                publishError: publishErrorMessage,
              },
            })
            .catch(
              eventEmitFailureLogger({
                logger,
                runId: run.id,
                eventType: "state_revert",
                stage: "testing",
              }),
            );
        } else {
          logger.warn(
            {
              runId: run.id,
              jiraKey: run.jira_key,
              testVersion,
              nextImplVersion,
            },
            "Skipped tester publish-failure revert because run state already moved",
          );
        }
        throw publishError;
      }

      logger.info(
        {
          runId: run.id,
          jiraKey: run.jira_key,
          testVersion,
          failCount: testResult.failCount,
        },
        "Tests failed, queued for implementation revision",
      );

      return true;
    }

    return this.finalizeTestingQualityGate(
      run,
      implementationBranch,
      plan,
      implementation,
      planMetadata,
      testVersion,
      testResult,
      `${testResult.failCount} test(s) failed after ${run.max_verification_loops} verification loop(s)`,
      "verification_budget_exhausted",
      assertWorkspaceLease,
    );
  }

  private async finalizeTestingQualityGate(
    run: {
      id: number;
      jira_key: string;
      branch_name: string;
      base_commit_sha: string;
      repo_id: number;
      current_code_review_version: number | null;
      run_group_id?: number | null;
    },
    implementationBranch: string,
    plan: OneShotPlan,
    implementation: OneShotImplementation,
    planMetadata: Record<string, unknown> | null | undefined,
    testVersion: number,
    testResult: OneShotTestResult,
    lastError: string,
    reason: string,
    assertWorkspaceLease?: () => Promise<void>,
  ): Promise<boolean> {
    const repo = await this.db.getRepositoryById(run.repo_id);
    if (!repo) {
      throw new Error(`Repository ${run.repo_id} not found for PR creation`);
    }

    const { owner, repo: repoName } = parseGitHubRepoUrl(repo.repo_url);
    const ticketSummary = await loadRunTicketSummary(
      this.oneShotDb,
      this.s3Client,
      run.id,
    );
    await assertWorkspaceLease?.();
    const { pr, readiness, ciStatus } =
      await this.createPullRequestWithFinalReadiness({
        run,
        owner,
        repoName,
        implementationBranch,
        plan,
        implementation,
        planMetadata,
        testResult,
        testFailureReason: lastError,
        ticketSummary,
      });

    await assertWorkspaceLease?.();
    const transitioned = await transitionRunWithNotification(this.db, {
      runId: run.id,
      fromState: "testing",
      toState: "pr_open",
      updates: {
        current_test_version: testVersion,
        current_pr_url: pr.htmlUrl,
        final_disposition: readiness.completionStatus,
        last_error:
          readiness.reasons.length > 0
            ? readiness.reasons
                .map((readinessReason) => readinessReason.message)
                .join(" | ")
            : lastError,
      },
      notification: {
        oneshot_run_id: run.id,
        jira_key: run.jira_key,
        notification_type: notificationTypeForReadiness(readiness),
        body_markdown: buildPrReadyComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey: run.jira_key,
          prNumber: pr.number,
          prUrl: pr.htmlUrl,
          testResult,
          readiness,
          previewReady: previewReadyForReadiness(repo.repo_name, readiness),
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
        "Tester failed transition skipped because run state already moved",
      );
      return true;
    }

    this.emitReadinessEvents({
      runId: run.id,
      fromState: "testing",
      toState: "pr_open",
      stage: "testing",
      readiness,
      ciStatus,
      planMetadata,
      testResult,
      extraStateTransitionMetadata: {
        version: testVersion,
        reason,
        failCount: testResult.failCount,
        prNumber: pr.number,
        prUrl: pr.htmlUrl,
      },
    });

    logger.info(
      {
        runId: run.id,
        jiraKey: run.jira_key,
        testVersion,
        reason,
        readiness: readiness.readiness,
        prUrl: pr.htmlUrl,
      },
      "Testing quality gate completed with draft PR readiness",
    );

    return true;
  }

  private async buildReadinessClassification(input: {
    runId: number;
    codeReviewVersion: number | null;
    planMetadata: Record<string, unknown> | null | undefined;
    testResult: OneShotTestResult;
    testFailureReason?: string | null;
    ciStatus?: {
      state:
        | "success"
        | "failure"
        | "error"
        | "pending"
        | "unavailable"
        | "unconfigured";
      description: string;
      targetUrl?: string | null;
      statusCount?: number;
      checkRunCount?: number;
      requiredCheckState?: "none" | "present" | "unavailable";
      details?: string[];
    } | null;
    additionalReasons?: OneShotReadinessReason[];
  }) {
    const codeReviewArtifact = input.codeReviewVersion
      ? await this.oneShotDb.artifacts.getArtifact(
          input.runId,
          "code_review",
          input.codeReviewVersion,
        )
      : null;
    const codeReviewMetadata = codeReviewArtifact?.metadata_json ?? null;
    const planMetadata = input.planMetadata ?? {};

    return buildOneShotReadinessClassification({
      testResult: input.testResult,
      testFailureReason: input.testFailureReason,
      codeReviewMetadata,
      planRiskAssessment: isPlanRiskAssessment(planMetadata.planRiskAssessment)
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
      ciStatus: input.ciStatus ?? null,
      additionalReasons: input.additionalReasons,
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
    errorMessage: string,
  ): Promise<void> {
    logger.error(
      {
        runId,
        jiraKey,
        error: errorMessage,
      },
      "Tester failing OneShot run",
    );

    const transitioned = await transitionRunWithNotification(this.db, {
      runId,
      fromState: "testing",
      toState: "failed",
      updates: {
        last_error: errorMessage,
        final_disposition: "run_failed",
      },
      notification: {
        oneshot_run_id: runId,
        jira_key: jiraKey,
        notification_type: "run_failed",
        body_markdown: buildRunFailedComment({
          assetBaseUrl: this.config.commentAssetBaseUrl,
          jiraKey,
          stageLabel: "Testing",
          errorMessage,
        }),
      },
      postmortemContext: buildPostmortemContext({
        s3Client: this.s3Client,
        artifactBucket: this.config.artifactBucket,
        artifactPrefix: this.config.artifactPrefix,
        jiraKey,
        failedStage: "testing",
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
        },
        "Tester failRun skipped because run state already moved",
      );
    }
  }
}
