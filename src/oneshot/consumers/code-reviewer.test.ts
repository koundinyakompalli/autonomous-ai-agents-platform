import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@aws-sdk/client-sqs";
import type { OneShotConsumerConfig } from "../config.js";
import type { OneShotRun } from "../types.js";
import type { OneShotCodeReview } from "../schema/code-review.js";

const {
  buildCodeReviewContextMock,
  materializeRunArtifactsMock,
  transitionRunWithNotificationMock,
  recordLlmMetricsMock,
  verificationLoopCounterAddMock,
  ensureDraftPullRequestMock,
  parseGitHubRepoUrlMock,
  loadRunQualificationSummaryMock,
  loadRunTicketSummaryMock,
  getCurrentHeadShaMock,
  ensureRunBranchContractMock,
  evaluateCandidateShaGuardMock,
} = vi.hoisted(() => ({
  buildCodeReviewContextMock: vi
    .fn()
    .mockResolvedValue({ files: [], truncated: false }),
  materializeRunArtifactsMock: vi.fn().mockResolvedValue(undefined),
  transitionRunWithNotificationMock: vi.fn().mockResolvedValue(true),
  recordLlmMetricsMock: vi.fn(),
  verificationLoopCounterAddMock: vi.fn(),
  ensureDraftPullRequestMock: vi
    .fn()
    .mockResolvedValue({ htmlUrl: "https://github.com/org/core-app/pull/12" }),
  parseGitHubRepoUrlMock: vi
    .fn()
    .mockReturnValue({ owner: "org", repo: "core-app" }),
  loadRunQualificationSummaryMock: vi.fn().mockResolvedValue(null),
  loadRunTicketSummaryMock: vi
    .fn()
    .mockResolvedValue("Code review soft gate test"),
  getCurrentHeadShaMock: vi.fn(),
  ensureRunBranchContractMock: vi.fn().mockResolvedValue({
    branchName: "oneshot/cpdev-20686-run-84",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    expectedHeadSha: "fedcba9876543210fedcba9876543210fedcba98",
    workspaceBaseSha: "fedcba9876543210fedcba9876543210fedcba98",
    currentCandidateSha: null,
    remoteHeadSha: "fedcba9876543210fedcba9876543210fedcba98",
    repairedMetadata: false,
    createdRemoteBranch: false,
    sharedEpicBranch: false,
  }),
  evaluateCandidateShaGuardMock: vi.fn().mockResolvedValue({
    action: "continue",
    candidateSha: "fedcba9876543210fedcba9876543210fedcba98",
    legacyUnpinned: false,
  }),
}));

vi.mock("../code-review-context.js", () => ({
  buildCodeReviewContext: buildCodeReviewContextMock,
}));

vi.mock("../workspace-artifacts.js", () => ({
  materializeRunArtifacts: materializeRunArtifactsMock,
}));

vi.mock("../state-transitions.js", () => ({
  buildPostmortemContext: vi.fn().mockReturnValue({}),
  transitionRunWithNotification: transitionRunWithNotificationMock,
}));

vi.mock("../telemetry/metrics.js", () => ({
  recordLlmMetrics: recordLlmMetricsMock,
  verificationLoopCounter: {
    add: verificationLoopCounterAddMock,
  },
}));

vi.mock("../github.js", () => ({
  ensureDraftPullRequest: ensureDraftPullRequestMock,
  parseGitHubRepoUrl: parseGitHubRepoUrlMock,
}));

vi.mock("../qualification-artifact.js", () => ({
  loadRunQualificationSummary: loadRunQualificationSummaryMock,
  loadRunTicketSummary: loadRunTicketSummaryMock,
}));

vi.mock("../run-branch-contract.js", () => ({
  ensureRunBranchContract: ensureRunBranchContractMock,
}));

vi.mock("../stage-candidate-guard.js", () => ({
  evaluateCandidateShaGuard: evaluateCandidateShaGuardMock,
}));

vi.mock("../pr-title.js", () => ({
  buildOneShotPullRequestTitle: vi.fn().mockReturnValue("[WIP] CPDEV-20686"),
}));

vi.mock("../git.js", () => ({
  getCurrentHeadSha: getCurrentHeadShaMock,
}));

import { CodeReviewerConsumer } from "./code-reviewer.js";

class TestableCodeReviewerConsumer extends CodeReviewerConsumer {
  async processMessage(
    message: Message,
    receiveCount: number,
  ): Promise<boolean> {
    return this.handleMessage(message, receiveCount);
  }
}

const config: OneShotConsumerConfig = {
  role: "CODE_REVIEWER",
  region: "us-east-1",
  artifactBucket: "artifact-bucket",
  artifactPrefix: "oneshot",
  maxReviewLoops: 3,
  maxVerificationLoops: 3,
  maxTotalTokens: 50_000_000,
  maxStageTokens: {
    planning: 4_000_000,
    review: 2_000_000,
    implementation: 4_000_000,
    code_review: 2_000_000,
    testing: 2_000_000,
  },
  maxStageAttempts: 5,
  reconcileStaleMinutes: 10,
  reviewerEnabled: true,
  codeReviewerEnabled: true,
  traceEnabled: true,
  tracePostToJira: true,
  verifyEnabled: true,
  verifyMode: "balanced",
  reviewStagesBlockOnExhaustion: false,
  reviewerProvider: "openai",
  reviewerModelId: undefined,
  codeReviewerProvider: "openai",
  codeReviewerModelId: undefined,
  plannerModelId: undefined,
  plannerMaxOutputTokens: 100_000,
  implementerModelId: "us.anthropic.claude-sonnet-test",
  implementerMaxOutputTokens: 100_000,
  plannerClaudePermissionMode: "default",
  plannerClaudeToolVisibility: "restricted",
  plannerClaudeToolGuard: "enabled",
  plannerScoutEnabled: false,
  plannerScoutModelId: "us.anthropic.claude-haiku-test-v1:0",
  reviewerBypassReason: undefined,
  codeReviewerBypassReason: undefined,
  repoBasePath: "/tmp/repos",
  repoAdminBasePath: "/tmp/repos",
  repoCacheBasePath: "/tmp/workspaces/repos",
  workspaceBasePath: "/tmp/workspaces",
  worktreeBasePath: "/tmp/workspaces",
  retrofitRepoCacheLeaseWaitMs: 300_000,
  promptSource: "local",
  promptBucket: "artifact-bucket",
  promptManifestKey: "oneshot/manifest.json",
  promptManifestVersionId: undefined,
  promptCacheTtlMs: 60_000,
  healthcareGuardrailsEnabled: false,
  promptLocalPath: "/tmp/prompts",
  commentAssetBaseUrl: "https://productFactory.mhkdevsandbox.com",
  dashboardBaseUrl: "https://productFactory.mhkdevsandbox.com",
  planningQueueUrl: "planning-queue",
  reviewQueueUrl: "review-queue",
  implementationQueueUrl: "implementation-queue",
  codeReviewQueueUrl: "code-review-queue",
  testingQueueUrl: "testing-queue",
};

function buildPlan() {
  return {
    jiraKey: "CPDEV-20686",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Code review soft gate test plan",
    specs: [
      {
        id: "spec-1",
        objective: "Exercise code reviewer state transitions",
        acceptanceCriteria: ["Code reviewer transitions are correct"],
        targetFiles: ["src/example.ts"],
        implementationNotes: ["Follow local patterns"],
        validationSteps: ["npm test -- src/oneshot"],
      },
    ],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
  };
}

function buildImplementation(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Implemented the requested change",
    completedSpecIds: ["spec-1"],
    changedFiles: ["src/example.ts"],
    testCommands: ["npm test -- src/oneshot"],
    validationCommands: [],
    validationChecks: [],
    manualVerificationSteps: [],
    testResults: [
      {
        command: "npm test -- src/oneshot",
        status: "passed",
        summary: "Tests passed",
      },
    ],
    deviationsFromPlan: [],
    residualRisks: [],
    openFollowUps: [],
    implementationBranch: "oneshot/cpdev-20686-run-84",
    implementationCommitSha: "fedcba9876543210fedcba9876543210fedcba98",
    ...overrides,
  };
}

function buildCodeReview(
  overrides: Partial<OneShotCodeReview> = {},
): OneShotCodeReview {
  return {
    decision: "NEEDS_CHANGES",
    score: 70,
    sageDimensions: [],
    findings: [],
    blockingFindings: [],
    requiredChanges: ["Fix the missing null guard"],
    nonBlockingSuggestions: ["Add a regression test"],
    confidence: "medium",
    summary: "Implementation needs one correctness fix.",
    implementationVersion: 1,
    ...overrides,
  };
}

function buildRun(overrides: Partial<OneShotRun> = {}): OneShotRun {
  const now = new Date();

  return {
    id: 84,
    run_group_id: null,
    workspace_mode: "v2",
    jira_key: "CPDEV-20686",
    source_task_management_id: 7,
    customer_id: 1,
    repo_id: 11,
    branch_name: "master",
    base_commit_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_name: "oneshot/cpdev-20686-run-84",
    run_branch_base_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_created_at: now,
    state: "queued_for_code_review",
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: 1,
    current_review_version: 1,
    current_implementation_version: 1,
    current_implementation_branch: "oneshot/cpdev-20686-run-84",
    current_implementation_commit_sha:
      "fedcba9876543210fedcba9876543210fedcba98",
    current_code_review_version: 1,
    current_test_version: null,
    current_pr_url: null,
    final_disposition: null,
    last_error: null,
    max_total_tokens: 2_000_000,
    total_tokens_used: 0,
    verification_loop_count: 0,
    max_verification_loops: 3,
    planning_attempt_count: 0,
    implementation_attempt_count: 0,
    code_review_attempt_count: 0,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

function buildMessage(): Message {
  return {
    Body: JSON.stringify({
      run_id: 84,
      stage: "code_review",
      version: 1,
      expected_state: "queued_for_code_review",
      revision: false,
      emitted_at: "2026-04-17T12:00:00.000Z",
      expected_implementation_commit_sha:
        "fedcba9876543210fedcba9876543210fedcba98",
      expected_implementation_version: 1,
    }),
  };
}

function buildDeps(
  options: {
    run?: OneShotRun;
    review?: OneShotCodeReview;
    providerError?: Error;
    implementation?: Record<string, unknown>;
    tokenBudgetWithin?: boolean;
    stageAttemptWithin?: boolean;
    verificationBudgetWithin?: boolean;
    artifactUpsertError?: Error;
    configOverrides?: Partial<OneShotConsumerConfig>;
  } = {},
) {
  const run = options.run ?? buildRun();
  const review = options.review ?? buildCodeReview();
  const implementation = buildImplementation(options.implementation);
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const publisher = {
    publishStageMessage: vi.fn().mockResolvedValue(undefined),
  };
  const oneShotDb = {
    runs: {
      getRunById: vi.fn().mockResolvedValue(run),
      claimQueuedRun: vi.fn().mockResolvedValue(true),
      checkTokenBudgetWithProjection: vi.fn().mockResolvedValue({
        withinBudget: options.tokenBudgetWithin ?? true,
        tokensUsed: 1_990_000,
        maxTokens: 2_000_000,
      }),
      checkStageAttemptBudget: vi
        .fn()
        .mockResolvedValue(options.stageAttemptWithin ?? true),
      incrementStageAttempts: vi.fn().mockResolvedValue(undefined),
      ensureRunBranchContract: vi.fn().mockResolvedValue(undefined),
      addTokenUsage: vi.fn().mockResolvedValue(undefined),
      incrementVerificationLoop: vi.fn().mockResolvedValue(undefined),
      checkVerificationBudget: vi
        .fn()
        .mockResolvedValue(options.verificationBudgetWithin ?? true),
      updateRunState: vi.fn().mockResolvedValue(undefined),
      updateRunStateIfCurrentState: vi.fn().mockResolvedValue(true),
    },
    artifacts: {
      getArtifactsForRun: vi
        .fn()
        .mockResolvedValue(
          options.tokenBudgetWithin === false
            ? [
                {
                  stage: "code_review",
                  version: 1,
                  metadata_json: { stage_tokens_used: 1_950_000 },
                },
              ]
            : [],
        ),
      getArtifact: vi
        .fn()
        .mockImplementation((_runId: number, stage: string) => {
          if (stage === "plan") {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "plan.json",
            });
          }
          if (stage === "implementation") {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "implementation.json",
              metadata_json: {
                implementationCommitSha:
                  run.current_implementation_commit_sha,
              },
            });
          }
          return Promise.resolve(null);
        }),
      getLatestArtifact: vi
        .fn()
        .mockImplementation((_runId: number, stage: string) => {
          if (stage === "implementation") {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "implementation.json",
            });
          }
          return Promise.resolve(null);
        }),
      upsertArtifact: options.artifactUpsertError
        ? vi.fn().mockRejectedValue(options.artifactUpsertError)
        : vi.fn().mockResolvedValue(undefined),
    },
    events: {
      getEventsForRun: vi.fn().mockResolvedValue([]),
      getLatestManualStageRestartAt: vi.fn().mockResolvedValue(null),
      getStageAttemptMetricEventsForBudget: vi.fn().mockResolvedValue([]),
      createEvent: vi.fn().mockResolvedValue(undefined),
    },
    candidateVersions: {
      getCurrentCandidate: vi.fn().mockResolvedValue({
        oneshotRunId: run.id,
        candidateVersion: run.current_implementation_version,
        candidateCommitSha: run.current_implementation_commit_sha,
        previousCandidateCommitSha: null,
        status: "current",
        supersededByCandidateVersion: null,
        targetFiles: [],
        metadata: null,
        finalizedAt: new Date("2026-04-17T12:00:00.000Z"),
      }),
      backfillCurrentCandidate: vi.fn().mockResolvedValue(true),
    },
  };
  const s3Client = {
    send: vi
      .fn()
      .mockImplementation((command: { input?: { Key?: string } }) => {
        if (command.input?.Key === "plan.json") {
          return Promise.resolve({
            Body: {
              transformToString: vi
                .fn()
                .mockResolvedValue(JSON.stringify(buildPlan())),
            },
          });
        }
        if (command.input?.Key === "implementation.json") {
          return Promise.resolve({
            Body: {
              transformToString: vi
                .fn()
                .mockResolvedValue(JSON.stringify(implementation)),
            },
          });
        }
        return Promise.resolve({});
      }),
  };
  const db = {
    getPool: vi.fn(() => ({})),
    getRepositoryById: vi.fn().mockResolvedValue({
      id: 11,
      repo_name: "core-app",
      repo_url: "https://github.com/org/core-app",
    }),
  };
  const workspaceManager = {
    prepareCodeReviewerWorkspace: vi.fn().mockResolvedValue({
      workspacePath: "/tmp/code-review-workspace",
      statePath: "/tmp/code-review-state",
      cleanup,
    }),
  };
  const codeReviewerProvider = {
    providerName: "openai" as const,
    modelId: "gpt-5.4",
    reviewCode: options.providerError
      ? vi.fn().mockRejectedValue(options.providerError)
      : vi.fn().mockResolvedValue({
          review,
          rawOutput: JSON.stringify(review),
          metrics: {
            durationMs: 1_000,
            tokensUsed: {
              input: 10,
              output: 20,
            },
            costUsd: 0.01,
          },
        }),
  };
  const consumer = new TestableCodeReviewerConsumer({
    config: { ...config, ...options.configOverrides },
    db: db as never,
    sqsClient: { send: vi.fn() } as never,
    s3Client: s3Client as never,
    publisher: publisher as never,
    workspaceManager: workspaceManager as never,
    codeReviewerProvider: codeReviewerProvider as never,
  });

  (consumer as { oneShotDb: unknown }).oneShotDb = oneShotDb;

  return {
    consumer,
    oneShotDb,
    publisher,
    codeReviewerProvider,
  };
}

function mockDateNow(iso: string) {
  return vi.spyOn(Date, "now").mockReturnValue(new Date(iso).getTime());
}

describe("CodeReviewerConsumer soft gate behavior", () => {
  beforeEach(() => {
    buildCodeReviewContextMock.mockClear();
    materializeRunArtifactsMock.mockClear();
    transitionRunWithNotificationMock.mockClear();
    recordLlmMetricsMock.mockClear();
    verificationLoopCounterAddMock.mockClear();
    ensureDraftPullRequestMock.mockClear();
    parseGitHubRepoUrlMock.mockClear();
    loadRunQualificationSummaryMock.mockReset();
    loadRunQualificationSummaryMock.mockResolvedValue(null);
    loadRunTicketSummaryMock.mockClear();
    getCurrentHeadShaMock.mockResolvedValue(
      "fedcba9876543210fedcba9876543210fedcba98",
    );
    ensureRunBranchContractMock.mockClear();
    evaluateCandidateShaGuardMock.mockReset();
    evaluateCandidateShaGuardMock.mockResolvedValue({
      action: "continue",
      candidateSha: "fedcba9876543210fedcba9876543210fedcba98",
      legacyUnpinned: false,
    });
  });

  it("abandons old runs using created_at when there is no manual restart", async () => {
    const dateNowSpy = mockDateNow("2026-05-08T05:32:46.000Z");
    const createdAt = new Date("2026-05-04T02:22:42.000Z");
    try {
      const { consumer, oneShotDb, codeReviewerProvider } = buildDeps({
        run: buildRun({
          created_at: createdAt,
        }),
      });

      const shouldDelete = await consumer.processMessage(buildMessage(), 1);

      expect(shouldDelete).toBe(true);
      expect(
        oneShotDb.events.getLatestManualStageRestartAt,
      ).toHaveBeenCalledWith(84);
      expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fromState: "code_reviewing",
          toState: "failed",
          updates: expect.objectContaining({
            final_disposition: "run_failed",
            last_error:
              "Run exceeded maximum age of 24 hours (age: 99h). Run has been abandoned.",
          }),
        }),
      );
      expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          event_type: "state_transition",
          from_state: "code_reviewing",
          to_state: "failed",
          stage: "code_review",
          metadata_json: expect.objectContaining({
            reason: "run_age_exceeded",
            ageBaselineSource: "created_at",
            ageBaselineAt: createdAt.toISOString(),
            manualRestartAt: null,
            effectiveAgeHours: 99,
          }),
        }),
      );
      expect(codeReviewerProvider.reviewCode).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("lets old runs continue when a recent manual restart resets the age baseline", async () => {
    const dateNowSpy = mockDateNow("2026-05-08T05:32:46.000Z");
    try {
      const { consumer, oneShotDb, codeReviewerProvider } = buildDeps({
        run: buildRun({
          created_at: new Date("2026-05-04T02:22:42.000Z"),
        }),
      });
      oneShotDb.events.getLatestManualStageRestartAt.mockResolvedValueOnce(
        new Date("2026-05-08T05:20:18.000Z"),
      );

      const shouldDelete = await consumer.processMessage(buildMessage(), 1);

      expect(shouldDelete).toBe(true);
      expect(transitionRunWithNotificationMock).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          toState: "failed",
          updates: expect.objectContaining({
            last_error: expect.stringContaining("maximum age"),
          }),
        }),
      );
      expect(codeReviewerProvider.reviewCode).toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("passes qualification retrofit source evidence into code review provider", async () => {
    loadRunQualificationSummaryMock.mockResolvedValueOnce({
      jiraLabels: ["PFOS"],
      repoSelectionMetadata: {
        retrofitContext: {
          sourceJiraKey: "CPDEV-25281",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.0",
        },
        retrofitSourceEvidence: {
          sourceJiraKey: "CPDEV-25281",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.0",
          sourceRepoName: "core-app",
          sourceRepoUrl:
            "https://github.com/mhk-repos/cp-medhok-monorepo.git",
          selectedCommits: [
            {
              sha: "9ce5326",
              subject: "CPDEV-25281 fix",
              files: ["src/BaseUtils.java"],
              alreadyApplied: false,
            },
          ],
          touchedFiles: ["src/BaseUtils.java"],
          evidenceSummary: "Source patch needs adaptation.",
        },
      },
    });
    const { consumer, codeReviewerProvider } = buildDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(codeReviewerProvider.reviewCode).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitContext: expect.objectContaining({
          sourceJiraKey: "CPDEV-25281",
        }),
        retrofitSourceEvidence: expect.objectContaining({
          selectedCommits: [
            expect.objectContaining({
              sha: "9ce5326",
            }),
          ],
        }),
      }),
    );
  });

  it("abandons old manually restarted runs from the latest restart baseline", async () => {
    const dateNowSpy = mockDateNow("2026-05-08T05:32:46.000Z");
    const manualRestartAt = new Date("2026-05-06T00:00:00.000Z");
    try {
      const { consumer, oneShotDb, codeReviewerProvider } = buildDeps({
        run: buildRun({
          created_at: new Date("2026-05-04T02:22:42.000Z"),
        }),
      });
      oneShotDb.events.getLatestManualStageRestartAt.mockResolvedValueOnce(
        manualRestartAt,
      );

      const shouldDelete = await consumer.processMessage(buildMessage(), 1);

      expect(shouldDelete).toBe(true);
      expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          updates: expect.objectContaining({
            last_error:
              "Run exceeded maximum age of 24 hours (age: 54h). Run has been abandoned.",
          }),
        }),
      );
      expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata_json: expect.objectContaining({
            reason: "run_age_exceeded",
            ageBaselineSource: "manual_restart",
            ageBaselineAt: manualRestartAt.toISOString(),
            manualRestartAt: manualRestartAt.toISOString(),
            effectiveAgeHours: 54,
          }),
        }),
      );
      expect(codeReviewerProvider.reviewCode).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("fails before provider work when the prepared workspace HEAD differs from the candidate SHA", async () => {
    getCurrentHeadShaMock.mockResolvedValue(
      "1111111111111111111111111111111111111111",
    );
    const { consumer, oneShotDb, publisher, codeReviewerProvider } = buildDeps({
      review: buildCodeReview({
        decision: "APPROVED",
        requiredChanges: [],
        findings: [],
        blockingFindings: [],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(codeReviewerProvider.reviewCode).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        fromState: "code_reviewing",
        toState: "failed",
        updates: expect.objectContaining({
          final_disposition: "run_failed",
          last_error: expect.stringContaining("workspace HEAD mismatch"),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "candidate_workspace_head_mismatch",
          expectedImplementationCommitSha:
            "fedcba9876543210fedcba9876543210fedcba98",
          workspaceHead: "1111111111111111111111111111111111111111",
        }),
      }),
    );
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("queues implementation revision when NEEDS_CHANGES is within verification budget", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.objectContaining({
        current_code_review_version: 1,
        current_implementation_version: 2,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      2,
      "queued_for_implementation",
      true,
    );
  });

  it("uses stage-attempt-only events for code-review budget preflight", async () => {
    const { consumer, oneShotDb } = buildDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(
      oneShotDb.events.getStageAttemptMetricEventsForBudget,
    ).toHaveBeenCalledWith(84, "code_review");
    expect(oneShotDb.events.getEventsForRun).not.toHaveBeenCalled();
  });

  it("requeues after workspace lease loss without code-review failure side effects", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      providerError: new Error("Lost OneShot workspace lease during code review"),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "code_reviewing",
      "queued_for_code_review",
      {
        last_error:
          "Workspace lease lost during code_review; stage requeued for retry",
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "code_reviewing",
        to_state: "queued_for_code_review",
        stage: "code_review",
        metadata_json: expect.objectContaining({
          reason: "workspace_lease_lost",
          version: 1,
          revision: false,
          receiveCount: 1,
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("continues to testing when verification budget is exhausted in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({ verification_loop_count: 2, max_verification_loops: 3 }),
      verificationBudgetWithin: false,
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_testing",
        updates: expect.objectContaining({
          current_code_review_version: 1,
          current_test_version: 1,
          final_disposition: null,
        }),
        notification: expect.objectContaining({
          notification_type: "code_review_completed",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "verification_budget_exhausted",
          originalDecision: "NEEDS_CHANGES",
          requiredChanges: ["Fix the missing null guard"],
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "testing",
      1,
      "queued_for_testing",
      false,
      {
        expectedImplementationCommitSha:
          "fedcba9876543210fedcba9876543210fedcba98",
        expectedImplementationVersion: 1,
      },
    );
  });

  it("restores test version when testing publish fails after code-review completion", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({ current_test_version: 4 }),
      review: buildCodeReview({
        decision: "APPROVED",
        requiredChanges: [],
        findings: [],
        blockingFindings: [],
      }),
    });
    publisher.publishStageMessage.mockRejectedValueOnce(new Error("sqs down"));

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_testing",
        updates: expect.objectContaining({
          current_test_version: 5,
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_testing",
      "code_reviewing",
      expect.objectContaining({
        current_test_version: 4,
        last_error: "sqs down",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_testing",
        to_state: "code_reviewing",
        stage: "code_review",
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "code_reviewing",
      "queued_for_code_review",
      { last_error: "sqs down" },
    );
  });

  it("keeps real code findings on the implementation path when declared tests were skipped", async () => {
    const { consumer, oneShotDb, publisher, codeReviewerProvider } = buildDeps({
      implementation: {
        testResults: [
          {
            command: "npm test -- src/oneshot",
            status: "skipped",
            summary: "npm was not available in the sandbox",
          },
        ],
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(codeReviewerProvider.reviewCode).toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        metadata_json: expect.objectContaining({
          decision: "NEEDS_CHANGES",
          testEvidenceStatus: "missing",
          testEvidenceBlockingFindings: expect.arrayContaining([
            expect.stringContaining("Implementation artifact is unverified"),
          ]),
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.objectContaining({
        current_code_review_version: 1,
        current_implementation_version: 2,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      2,
      "queued_for_implementation",
      true,
    );
    expect(ensureDraftPullRequestMock).not.toHaveBeenCalled();
  });

  it("routes approved code with missing deterministic test proof to Tester", async () => {
    const { consumer, oneShotDb, publisher, codeReviewerProvider } = buildDeps({
      review: buildCodeReview({
        decision: "APPROVED",
        score: 92,
        findings: [],
        blockingFindings: [],
        requiredChanges: [],
      }),
      implementation: {
        testResults: [
          {
            command: "npm test -- src/oneshot",
            status: "skipped",
            summary: "npm was not available in the sandbox",
          },
        ],
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(codeReviewerProvider.reviewCode).toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        metadata_json: expect.objectContaining({
          decision: "APPROVED",
          testEvidenceStatus: "missing",
          testEvidenceBlockingFindings: expect.arrayContaining([
            expect.stringContaining("Implementation artifact is unverified"),
          ]),
        }),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_testing",
        updates: expect.objectContaining({
          current_code_review_version: 1,
          current_test_version: 1,
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "testing",
      1,
      "queued_for_testing",
      false,
      {
        expectedImplementationCommitSha:
          "fedcba9876543210fedcba9876543210fedcba98",
        expectedImplementationVersion: 1,
      },
    );
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.anything(),
    );
  });

  it("creates a needs-review draft PR for exhausted verification when blocking mode is enabled", async () => {
    const { consumer } = buildDeps({
      run: buildRun({ verification_loop_count: 2, max_verification_loops: 3 }),
      verificationBudgetWithin: false,
      configOverrides: { reviewStagesBlockOnExhaustion: true },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
          current_pr_url: "https://github.com/org/core-app/pull/12",
        }),
        notification: expect.objectContaining({
          notification_type: "code_review_escalated",
        }),
      }),
    );
    expect(ensureDraftPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: true,
      }),
    );
  });

  it("blocks exhausted verification when the WIP PR cannot be created", async () => {
    ensureDraftPullRequestMock.mockRejectedValueOnce(
      new Error("GitHub pull request update failed with status 500"),
    );
    const { consumer } = buildDeps({
      run: buildRun({ verification_loop_count: 2, max_verification_loops: 3 }),
      verificationBudgetWithin: false,
      configOverrides: { reviewStagesBlockOnExhaustion: true },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "code_review_blocked",
          current_pr_url: null,
        }),
      }),
    );
  });

  it("blocks exhausted verification when the WIP PR cannot be converted back to draft", async () => {
    ensureDraftPullRequestMock.mockResolvedValueOnce({
      htmlUrl: "https://github.com/org/core-app/pull/12",
      draftSyncError:
        "GitHub pull request draft-state sync returned draft=false",
    });
    const { consumer } = buildDeps({
      run: buildRun({ verification_loop_count: 2, max_verification_loops: 3 }),
      verificationBudgetWithin: false,
      configOverrides: { reviewStagesBlockOnExhaustion: true },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "code_review_blocked",
          current_pr_url: null,
          last_error: expect.stringContaining("pr_state_sync_failed"),
        }),
      }),
    );
  });

  it("blocks code-review BLOCKED results when the WIP PR cannot be converted back to draft", async () => {
    ensureDraftPullRequestMock.mockResolvedValueOnce({
      htmlUrl: "https://github.com/org/core-app/pull/12",
      draftSyncError:
        "GitHub pull request draft-state sync returned draft=false",
    });
    const { consumer } = buildDeps({
      review: buildCodeReview({
        decision: "BLOCKED",
        requiredChanges: [],
        blockingFindings: ["The implementation skips a required guard"],
      }),
      configOverrides: { reviewStagesBlockOnExhaustion: true },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "code_review_blocked",
          current_pr_url: null,
          last_error: expect.stringContaining("pr_state_sync_failed"),
        }),
      }),
    );
  });

  it("treats BLOCKED as a soft implementation revision when verification budget remains", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      review: buildCodeReview({
        decision: "BLOCKED",
        requiredChanges: [],
        blockingFindings: ["The implementation skips a required guard"],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.objectContaining({
        current_implementation_version: 2,
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "blocked_revision",
          originalDecision: "BLOCKED",
          blockingFindings: ["The implementation skips a required guard"],
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      2,
      "queued_for_implementation",
      true,
    );
  });

  it("restores implementation version when implementation publish fails after needs-changes transition", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({
        current_implementation_version: 7,
        current_code_review_version: 1,
        verification_loop_count: 2,
      }),
    });
    publisher.publishStageMessage.mockRejectedValueOnce(new Error("sqs down"));

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.objectContaining({
        current_implementation_version: 8,
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      "code_reviewing",
      expect.objectContaining({
        current_code_review_version: 1,
        current_implementation_version: 7,
        verification_loop_count: 2,
        last_error: "sqs down",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_implementation",
        to_state: "code_reviewing",
        stage: "code_review",
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "code_reviewing",
      "queued_for_code_review",
      { last_error: "sqs down" },
    );
  });

  it("continues to testing when the implementer disagrees in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      implementation: {
        implementerDisagrees: true,
        implementerDisagreementReason:
          "The requested change would undo the ticket fix",
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "implementer_disagrees",
          originalDecision: "NEEDS_CHANGES",
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "testing",
      1,
      "queued_for_testing",
      false,
      {
        expectedImplementationCommitSha:
          "fedcba9876543210fedcba9876543210fedcba98",
        expectedImplementationVersion: 1,
      },
    );
  });

  it("continues to testing after provider retry exhaustion in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      providerError: new Error("OpenAI code reviewer timed out"),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 4);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "soft_gate",
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "provider_retry_exhausted",
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "testing",
      1,
      "queued_for_testing",
      false,
      {
        expectedImplementationCommitSha:
          "fedcba9876543210fedcba9876543210fedcba98",
        expectedImplementationVersion: 1,
      },
    );
  });

  it("fails after provider success when code-review artifact persistence is exhausted", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      artifactUpsertError: new Error("artifact database unavailable"),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 4);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledTimes(1);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
        updates: expect.objectContaining({
          final_disposition: "run_failed",
          last_error: "artifact database unavailable",
        }),
        notification: expect.objectContaining({
          notification_type: "run_failed",
        }),
      }),
    );
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("continues to testing on code-review budget skip in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher, codeReviewerProvider } = buildDeps({
      tokenBudgetWithin: false,
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(codeReviewerProvider.reviewCode).not.toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "soft_gate",
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "stage_budget_exceeded",
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "testing",
      1,
      "queued_for_testing",
      false,
      {
        expectedImplementationCommitSha:
          "fedcba9876543210fedcba9876543210fedcba98",
        expectedImplementationVersion: 1,
      },
    );
  });

  it("attributes code-review artifact + telemetry to anthropic when provider reports providerName='anthropic'", async () => {
    const { consumer, oneShotDb } = buildDeps({
      review: buildCodeReview({
        decision: "APPROVED",
        requiredChanges: [],
        findings: [],
        blockingFindings: [],
      }),
    });

    (
      consumer as unknown as { codeReviewerProvider: unknown }
    ).codeReviewerProvider = {
      providerName: "anthropic" as const,
      modelId: "us.anthropic.claude-opus-4-6-v1",
      reviewCode: vi.fn().mockResolvedValue({
        review: buildCodeReview({
          decision: "APPROVED",
          requiredChanges: [],
          findings: [],
          blockingFindings: [],
        }),
        rawOutput: "{}",
        metrics: {
          durationMs: 2_500,
          tokensUsed: { input: 300, output: 120, cacheRead: 50, cacheWrite: 0 },
          costUsd: 0.75,
        },
      }),
    };

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(recordLlmMetricsMock).toHaveBeenCalledWith(
      "code_review",
      "anthropic",
      expect.any(Number),
      expect.any(Object),
      expect.any(Number),
    );
    // Budget accounting counts input + output only (420 = 300 + 120). Cache
    // tokens are kept in the artifact for observability but don't feed the
    // run budget — see planner.ts:calculateTokenUsage for rationale.
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "us.anthropic.claude-opus-4-6-v1",
        metadata_json: expect.objectContaining({
          stage_tokens_used: 420,
          tokens_used: {
            input: 300,
            output: 120,
            cacheRead: 50,
            cacheWrite: 0,
          },
        }),
      }),
    );
    expect(oneShotDb.runs.addTokenUsage).toHaveBeenCalledWith(84, 420);
  });
});

describe("CodeReviewerConsumer transient retry backoff", () => {
  beforeEach(() => {
    buildCodeReviewContextMock.mockClear();
    materializeRunArtifactsMock.mockClear();
    transitionRunWithNotificationMock.mockClear();
    recordLlmMetricsMock.mockClear();
    getCurrentHeadShaMock.mockResolvedValue(
      "fedcba9876543210fedcba9876543210fedcba98",
    );
    ensureRunBranchContractMock.mockClear();
    evaluateCandidateShaGuardMock.mockReset();
    evaluateCandidateShaGuardMock.mockResolvedValue({
      action: "continue",
      candidateSha: "fedcba9876543210fedcba9876543210fedcba98",
      legacyUnpinned: false,
    });
    loadRunQualificationSummaryMock.mockReset();
    loadRunQualificationSummaryMock.mockResolvedValue(null);
    loadRunTicketSummaryMock.mockClear();
  });

  it("requeues with transientRetry metadata at receiveCount=3 (not exhausted)", async () => {
    const providerError = new Error("Provider timed out");
    const { consumer, oneShotDb } = buildDeps({ providerError });

    const message = {
      ...buildMessage(),
      ReceiptHandle: "receipt-handle-rc3",
    };

    // The SQS client send is set to { send: vi.fn() } in buildDeps
    // shortenVisibilityForTransientRetry will call extendVisibilityTimeout via sqsClient
    const shouldDelete = await consumer.processMessage(message, 3);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "code_reviewing",
      "queued_for_code_review",
      expect.objectContaining({ last_error: "Provider timed out" }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "code_reviewing",
        to_state: "queued_for_code_review",
        metadata_json: expect.objectContaining({
          reason: "transient_error",
          receiveCount: 3,
          transientRetry: expect.objectContaining({
            retryAttempt: 3,
            retryDelaySeconds: 600,
          }),
        }),
      }),
    );
  });

  it("activates soft-gate continuation at receiveCount=4 (exhausted, blockOnExhaustion=false)", async () => {
    const providerError = new Error("Provider failed repeatedly");
    const { consumer, oneShotDb } = buildDeps({
      providerError,
      configOverrides: { reviewStagesBlockOnExhaustion: false },
    });

    const message = {
      ...buildMessage(),
      ReceiptHandle: "receipt-handle-rc4",
    };

    const shouldDelete = await consumer.processMessage(message, 4);

    // Should soft-gate and continue to testing rather than return false
    expect(shouldDelete).toBe(true);
    // Should NOT have tried to requeue the run
    expect(oneShotDb.runs.updateRunStateIfCurrentState).not.toHaveBeenCalledWith(
      expect.anything(),
      "code_reviewing",
      "queued_for_code_review",
      expect.anything(),
    );
  });
});
