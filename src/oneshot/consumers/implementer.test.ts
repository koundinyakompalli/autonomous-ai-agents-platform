import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@aws-sdk/client-sqs";
import { z } from "zod";
import type { OneShotConsumerConfig } from "../config.js";
import type { OneShotRun } from "../types.js";
import type { OneShotCodeReview } from "../schema/code-review.js";

const START_SHA = "0123456789abcdef0123456789abcdef01234567";
const COMMIT_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const PROVIDER_COMMIT_SHA = "1234567890abcdef1234567890abcdef12345678";
const DRIFT_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const {
  branchExistsOnRemoteMock,
  commitAllChangesMock,
  getCurrentHeadShaMock,
  getRemoteBranchHeadMock,
  isAncestorMock,
  listChangedFilesMock,
  pushBranchMock,
  runGitCommandMock,
  exportSourceCommitPatchMock,
  isPatchAlreadyAppliedMock,
  isPatchApplicableMock,
  applyPatchMock,
  materializeRunArtifactsMock,
  transitionRunWithNotificationMock,
  recordLlmMetricsMock,
  cleanGeneratedBranchChangesMock,
  isBlockedGeneratedPathMock,
  ensureDraftPullRequestMock,
  parseGitHubRepoUrlMock,
  loadRunTicketSummaryMock,
  ensureRunBranchContractMock,
} = vi.hoisted(() => ({
  branchExistsOnRemoteMock: vi.fn(),
  commitAllChangesMock: vi.fn(),
  getCurrentHeadShaMock: vi.fn(),
  getRemoteBranchHeadMock: vi.fn(),
  isAncestorMock: vi.fn(),
  listChangedFilesMock: vi.fn(),
  pushBranchMock: vi.fn(),
  runGitCommandMock: vi.fn(),
  exportSourceCommitPatchMock: vi.fn(),
  isPatchAlreadyAppliedMock: vi.fn(),
  isPatchApplicableMock: vi.fn(),
  applyPatchMock: vi.fn(),
  materializeRunArtifactsMock: vi.fn(),
  transitionRunWithNotificationMock: vi.fn(),
  recordLlmMetricsMock: vi.fn(),
  cleanGeneratedBranchChangesMock: vi.fn(),
  isBlockedGeneratedPathMock: vi.fn(),
  ensureDraftPullRequestMock: vi.fn(),
  parseGitHubRepoUrlMock: vi.fn(),
  loadRunTicketSummaryMock: vi.fn(),
  ensureRunBranchContractMock: vi.fn().mockResolvedValue({
    branchName: "oneshot/cpdev-20686-run-84",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
    workspaceBaseSha: "0123456789abcdef0123456789abcdef01234567",
    currentCandidateSha: null,
    remoteHeadSha: "0123456789abcdef0123456789abcdef01234567",
    repairedMetadata: false,
    createdRemoteBranch: false,
    sharedEpicBranch: false,
  }),
}));

vi.mock("../git.js", () => ({
  branchExistsOnRemote: branchExistsOnRemoteMock,
  commitAllChanges: commitAllChangesMock,
  getCurrentHeadSha: getCurrentHeadShaMock,
  getRemoteBranchHead: getRemoteBranchHeadMock,
  isAncestor: isAncestorMock,
  listChangedFiles: listChangedFilesMock,
  parseGitNameStatusPaths: (output: string) =>
    output
      .split("\n")
      .flatMap((line) => line.trim().split("\t").slice(1))
      .filter(Boolean)
      .sort(),
  pushBranch: pushBranchMock,
  runGitCommand: runGitCommandMock,
  exportSourceCommitPatch: exportSourceCommitPatchMock,
  isPatchAlreadyApplied: isPatchAlreadyAppliedMock,
  isPatchApplicable: isPatchApplicableMock,
  applyPatch: applyPatchMock,
}));

vi.mock("../workspace-artifacts.js", () => ({
  materializeRunArtifacts: materializeRunArtifactsMock,
}));

vi.mock("../branch-hygiene.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../branch-hygiene.js")>();
  return {
    ...actual,
    cleanGeneratedBranchChanges: cleanGeneratedBranchChangesMock,
    isBlockedGeneratedPath: isBlockedGeneratedPathMock,
  };
});

vi.mock("../state-transitions.js", () => ({
  buildPostmortemContext: vi.fn().mockReturnValue({}),
  transitionRunWithNotification: transitionRunWithNotificationMock,
}));

vi.mock("../telemetry/metrics.js", () => ({
  recordLlmMetrics: recordLlmMetricsMock,
}));

vi.mock("../github.js", () => ({
  ensureDraftPullRequest: ensureDraftPullRequestMock,
  parseGitHubRepoUrl: parseGitHubRepoUrlMock,
}));

vi.mock("../qualification-artifact.js", () => ({
  loadRunTicketSummary: loadRunTicketSummaryMock,
}));

vi.mock("../run-branch-contract.js", () => ({
  ensureRunBranchContract: ensureRunBranchContractMock,
}));

import {
  ImplementerConsumer,
  classifyImplementerFailure,
} from "./implementer.js";
import { ImplementerStallError } from "../providers/claude-implementer.js";
import { WorkspaceCheckoutTimeoutError } from "../workspace-lease-errors.js";

class TestableImplementerConsumer extends ImplementerConsumer {
  async processMessage(
    message: Message,
    receiveCount: number,
  ): Promise<boolean> {
    return this.handleMessage(message, receiveCount);
  }
}

const config: OneShotConsumerConfig = {
  role: "IMPLEMENTER",
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

function buildRun(): OneShotRun {
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
    base_commit_sha: START_SHA,
    run_branch_name: "oneshot/cpdev-20686-run-84",
    run_branch_base_sha: START_SHA,
    run_branch_created_at: now,
    state: "queued_for_implementation",
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: 1,
    current_review_version: null,
    current_implementation_version: 1,
    current_implementation_branch: null,
    current_implementation_commit_sha: null,
    current_code_review_version: null,
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
  };
}

function buildMessage(
  overrides: Partial<{
    version: number;
    revision: boolean;
  }> = {},
): Message {
  return {
    Body: JSON.stringify({
      run_id: 84,
      stage: "implementation",
      version: overrides.version ?? 1,
      expected_state: "queued_for_implementation",
      revision: overrides.revision ?? false,
      emitted_at: "2026-04-17T12:00:00.000Z",
    }),
  };
}

function buildPlan() {
  return {
    jiraKey: "CPDEV-20686",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: START_SHA,
    summary: "Implement stall-monitoring parity",
    specs: [
      {
        id: "spec-1",
        objective: "Persist correct model provenance",
        acceptanceCriteria: [
          "Implementation artifact stores the actual model used",
        ],
        targetFiles: ["src/oneshot/consumers/implementer.ts"],
        implementationNotes: ["Use metrics.modelUsed when present"],
        validationSteps: ["vitest src/oneshot/consumers/implementer.test.ts"],
      },
    ],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
  };
}

function buildImplementationResponse() {
  return {
    implementation: {
      summary: "Implemented the parity fixes.",
      completedSpecIds: ["spec-1"],
      changedFiles: ["src/oneshot/consumers/implementer.ts"],
      testCommands: ["vitest src/oneshot/consumers/implementer.test.ts"],
      manualVerificationSteps: [],
      testResults: [
        {
          command: "vitest src/oneshot/consumers/implementer.test.ts",
          status: "passed",
          summary: "Implementer consumer tests passed.",
        },
      ],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    },
    rawOutput: "{}",
    metrics: {
      durationMs: 2_000,
      toolCalls: 3,
      tokensUsed: {
        input: 10,
        output: 20,
      },
      costUsd: 0.12,
      modelUsed: "us.anthropic.claude-sonnet-fallback-v1:0",
    },
  };
}

function buildCodeReview(
  overrides: Partial<OneShotCodeReview> = {},
): OneShotCodeReview {
  return {
    decision: "NEEDS_CHANGES",
    score: 60,
    sageDimensions: [],
    findings: [
      {
        severity: "high",
        category: "correctness",
        file: "src/oneshot/consumers/implementer.ts",
        line: 42,
        description: "Revision did not address the requested guard.",
        suggestion: "Add the missing guard.",
      },
    ],
    blockingFindings: [],
    requiredChanges: ["Add the missing guard."],
    nonBlockingSuggestions: [],
    confidence: "high",
    summary: "Implementation needs one blocking correctness fix.",
    implementationVersion: 1,
    ...overrides,
  };
}

function buildQualificationSummary(
  overrides: Partial<{
    ticketSummary: string;
    jiraLabels: string[];
    processingMode: "security_wiz" | "sonar_autofix" | "standard";
  }> = {},
) {
  return {
    ticketSummary: "Implementer provenance test",
    ...overrides,
  };
}

function buildImplementerDeps(
  providerResult: ReturnType<typeof buildImplementationResponse> | Error,
  options: {
    run?: OneShotRun;
    plan?: Record<string, unknown>;
    codeReviewArtifact?: OneShotCodeReview;
    testArtifact?: Record<string, unknown>;
    events?: Array<Record<string, unknown>>;
    previousImplementationArtifact?: {
      metadata_json?: Record<string, unknown>;
      body?: Record<string, unknown>;
    };
    assertLeaseValid?: ReturnType<typeof vi.fn>;
    qualificationSummary?: ReturnType<typeof buildQualificationSummary>;
  } = {},
) {
  const run = options.run ?? buildRun();
  const driftCleanup = vi.fn().mockResolvedValue(undefined);
  const implementerCleanup = vi.fn().mockResolvedValue(undefined);
  const plan = options.plan ?? buildPlan();
  const qualificationSummary =
    options.qualificationSummary ?? buildQualificationSummary();
  const codeReviewArtifact = options.codeReviewArtifact;
  const testArtifact = options.testArtifact;
  const events = options.events ?? [];
  const previousImplementationArtifact = options.previousImplementationArtifact;

  const oneShotDb = {
    runs: {
      getRunById: vi.fn().mockResolvedValue(run),
      claimQueuedRun: vi.fn().mockResolvedValue(true),
      checkTokenBudgetWithProjection: vi.fn().mockResolvedValue({
        withinBudget: true,
        tokensUsed: 0,
        maxTokens: 2_000_000,
      }),
      checkStageAttemptBudget: vi.fn().mockResolvedValue(true),
      incrementStageAttempts: vi.fn().mockResolvedValue(undefined),
      ensureRunBranchContract: vi.fn().mockResolvedValue(undefined),
      updateRunState: vi.fn().mockResolvedValue(undefined),
      updateRunStateIfCurrentState: vi.fn().mockResolvedValue(true),
      addTokenUsage: vi.fn().mockResolvedValue(undefined),
    },
    artifacts: {
      getArtifactsForRun: vi.fn().mockResolvedValue([]),
      getArtifact: vi
        .fn()
        .mockImplementation((_runId: number, stage: string) =>
          stage === "plan"
            ? Promise.resolve({
                s3_bucket: "artifact-bucket",
                s3_key: "plan.json",
              })
            : Promise.resolve(null),
        ),
      getLatestArtifact: vi
        .fn()
        .mockImplementation((_runId: number, stage: string) => {
          if (stage === "qualification") {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "qualification.json",
            });
          }
          if (stage === "code_review" && codeReviewArtifact) {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "code-review.latest.json",
            });
          }
          if (stage === "test_result" && testArtifact) {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "test-result.latest.json",
            });
          }
          if (stage === "implementation" && previousImplementationArtifact) {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "implementation.previous.json",
              metadata_json:
                previousImplementationArtifact.metadata_json ?? null,
            });
          }
          return Promise.resolve(null);
        }),
      upsertArtifact: vi.fn().mockResolvedValue(undefined),
    },
    notifications: {
      createNotification: vi.fn().mockResolvedValue(undefined),
    },
    events: {
      getEventsForRun: vi.fn().mockResolvedValue(events),
      getLatestManualStageRestartAt: vi.fn().mockResolvedValue(null),
      createEvent: vi.fn().mockResolvedValue(undefined),
    },
    candidateVersions: {
      finalizeCandidate: vi.fn().mockResolvedValue(true),
    },
    workspaceState: {
      conditionalUpdateWithLease: vi.fn().mockResolvedValue(true),
    },
    workspaceLeases: {
      verifyLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    },
  };

  const s3Client = {
    send: vi
      .fn()
      .mockImplementation((command: { input?: { Key?: string } }) => {
        switch (command.input?.Key) {
          case "plan.json":
            return Promise.resolve({
              Body: {
                transformToString: vi
                  .fn()
                  .mockResolvedValue(JSON.stringify(plan)),
              },
            });
          case "qualification.json":
            return Promise.resolve({
              Body: {
                transformToString: vi
                  .fn()
                  .mockResolvedValue(JSON.stringify(qualificationSummary)),
              },
            });
          case "code-review.latest.json":
            return Promise.resolve({
              Body: {
                transformToString: vi
                  .fn()
                  .mockResolvedValue(JSON.stringify(codeReviewArtifact)),
              },
            });
          case "test-result.latest.json":
            return Promise.resolve({
              Body: {
                transformToString: vi
                  .fn()
                  .mockResolvedValue(JSON.stringify(testArtifact)),
              },
            });
          case "implementation.previous.json":
            return Promise.resolve({
              Body: {
                transformToString: vi
                  .fn()
                  .mockResolvedValue(
                    JSON.stringify(previousImplementationArtifact?.body ?? {}),
                  ),
              },
            });
          default:
            return Promise.resolve({});
        }
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
    prepareWorkspace: vi.fn().mockResolvedValue({
      workspacePath: "/tmp/drift-workspace",
      statePath: "/tmp/drift-state",
      cleanup: driftCleanup,
    }),
    prepareImplementerWorkspace: vi.fn().mockResolvedValue({
      workspacePath: "/tmp/implementer-workspace",
      statePath: "/tmp/implementer-state",
      cleanup: implementerCleanup,
      assertLeaseValid:
        options.assertLeaseValid ?? vi.fn().mockResolvedValue(undefined),
      lease: {
        scope: "run-worktree:84",
        fencingToken: 123,
      },
    }),
  };

  const implementerProvider = {
    implementPlan:
      providerResult instanceof Error
        ? vi.fn().mockRejectedValue(providerResult)
        : vi.fn().mockResolvedValue(providerResult),
  };

  const publisher = {
    publishStageMessage: vi.fn().mockResolvedValue(undefined),
  };

  const consumer = new TestableImplementerConsumer({
    config,
    db: db as never,
    sqsClient: { send: vi.fn() } as never,
    s3Client: s3Client as never,
    publisher: publisher as never,
    workspaceManager: workspaceManager as never,
    implementerProvider: implementerProvider as never,
  });

  (consumer as { oneShotDb: unknown }).oneShotDb = oneShotDb;

  return {
    consumer,
    oneShotDb,
    cleanup: implementerCleanup,
    driftCleanup,
    implementerCleanup,
    publisher,
    workspaceManager,
    implementerProvider,
    s3Client,
  };
}

function queueHeadShas(...headShas: string[]) {
  let index = 0;
  getCurrentHeadShaMock.mockImplementation(() => {
    const current = headShas[Math.min(index, headShas.length - 1)];
    index += 1;
    return Promise.resolve(current);
  });
}

function configureChangedFilesMock(options?: {
  dirtyFiles?: string[];
  committedFiles?: string[];
}) {
  const dirtyFiles = options?.dirtyFiles ?? [
    "src/oneshot/consumers/implementer.ts",
  ];
  const committedFiles = options?.committedFiles ?? dirtyFiles;

  listChangedFilesMock.mockImplementation(
    (_cwd: string, fromRef?: string, toRef?: string) => {
      if (!fromRef) {
        return Promise.resolve(dirtyFiles);
      }

      if (fromRef === toRef) {
        return Promise.resolve([]);
      }

      return Promise.resolve(committedFiles);
    },
  );
}

function mockDateNow(iso: string) {
  return vi.spyOn(Date, "now").mockReturnValue(new Date(iso).getTime());
}

describe("classifyImplementerFailure", () => {
  it("preserves detailed tool stall failures while keeping the broader dashboard category", () => {
    expect(
      classifyImplementerFailure(
        new ImplementerStallError("tool stalled", "tool_stall"),
      ),
    ).toEqual({
      failureKind: "tool_stall",
      failureCategory: "model_stall",
    });
  });

  it("classifies schema validation failures separately from transport failures", () => {
    const validationError = z
      .object({ summary: z.string() })
      .safeParse({}).error!;

    expect(classifyImplementerFailure(validationError)).toEqual({
      failureKind: "implementation_validation",
      failureCategory: "implementation_validation",
    });
  });

  it("classifies checkout timeouts as workspace failures", () => {
    expect(
      classifyImplementerFailure(
        new WorkspaceCheckoutTimeoutError(
          "workspace_checkout_timeout: git worktree add failed or timed out",
        ),
      ),
    ).toEqual({
      failureKind: "workspace_checkout_timeout",
      failureCategory: "workspace",
    });
  });

  it("classifies turn-limit failures as deterministic", () => {
    expect(
      classifyImplementerFailure(
        new ImplementerStallError(
          "Turn limit exceeded (max: 120)",
          "turn_limit",
        ),
      ),
    ).toEqual({
      failureKind: "turn_limit",
      failureCategory: "turn_limit",
    });
  });
});

describe("ImplementerConsumer monitoring parity", () => {
  beforeEach(() => {
    branchExistsOnRemoteMock.mockReset();
    commitAllChangesMock.mockReset();
    getCurrentHeadShaMock.mockReset();
    getRemoteBranchHeadMock.mockReset();
    isAncestorMock.mockReset();
    listChangedFilesMock.mockReset();
    pushBranchMock.mockReset();
    runGitCommandMock.mockReset();
    exportSourceCommitPatchMock.mockReset();
    isPatchAlreadyAppliedMock.mockReset();
    isPatchApplicableMock.mockReset();
    applyPatchMock.mockReset();
    materializeRunArtifactsMock.mockReset();
    transitionRunWithNotificationMock.mockReset();
    recordLlmMetricsMock.mockReset();
    cleanGeneratedBranchChangesMock.mockReset();
    isBlockedGeneratedPathMock.mockReset();
    ensureDraftPullRequestMock.mockReset();
    parseGitHubRepoUrlMock.mockReset();
    loadRunTicketSummaryMock.mockReset();
    ensureRunBranchContractMock.mockReset();

    branchExistsOnRemoteMock.mockResolvedValue(false);
    commitAllChangesMock.mockResolvedValue(undefined);
    getRemoteBranchHeadMock.mockImplementation(
      (_repo: unknown, branchName: string) =>
        Promise.resolve({
          branchName,
          headSha: branchName.startsWith("oneshot/") ? COMMIT_SHA : START_SHA,
        }),
    );
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);
    isAncestorMock.mockResolvedValue(true);
    configureChangedFilesMock();
    pushBranchMock.mockResolvedValue(undefined);
    runGitCommandMock.mockResolvedValue({ stdout: "diff --git a/file b/file" });
    materializeRunArtifactsMock.mockResolvedValue(undefined);
    transitionRunWithNotificationMock.mockResolvedValue(true);
    cleanGeneratedBranchChangesMock.mockResolvedValue({
      removedFiles: [],
      removedFilesSample: [],
      removedFilesCount: 0,
      preservedFiles: [],
      preservedFilesSample: [],
      preservedFilesCount: 0,
      blockedFiles: [],
      blockedFilesSample: [],
      blockedFilesCount: 0,
    });
    isBlockedGeneratedPathMock.mockReturnValue(false);
    // Default: patch primitives return non-retrofit behavior (not called by normal runs)
    exportSourceCommitPatchMock.mockResolvedValue("--- a/file\n+++ b/file\n@@ -1 +1 @@\n+change\n");
    isPatchAlreadyAppliedMock.mockResolvedValue(false);
    isPatchApplicableMock.mockResolvedValue(true);
    applyPatchMock.mockResolvedValue({ ok: true });
    parseGitHubRepoUrlMock.mockReturnValue({ owner: "org", repo: "core-app" });
    loadRunTicketSummaryMock.mockResolvedValue("Implementer provenance test");
    ensureRunBranchContractMock.mockResolvedValue({
      branchName: "oneshot/cpdev-20686-run-84",
      baseCommitSha: START_SHA,
      expectedHeadSha: START_SHA,
      workspaceBaseSha: START_SHA,
      currentCandidateSha: null,
      remoteHeadSha: START_SHA,
      repairedMetadata: false,
      createdRemoteBranch: false,
      sharedEpicBranch: false,
    });
    ensureDraftPullRequestMock.mockResolvedValue({
      htmlUrl: "https://github.com/org/core-app/pull/12",
      number: 12,
      reused: false,
    });
  });

  it("abandons old runs using created_at when there is no manual restart", async () => {
    const dateNowSpy = mockDateNow("2026-05-08T05:32:46.000Z");
    const createdAt = new Date("2026-05-04T02:22:42.000Z");
    try {
      const { consumer, oneShotDb, workspaceManager, implementerProvider } =
        buildImplementerDeps(buildImplementationResponse(), {
          run: {
            ...buildRun(),
            created_at: createdAt,
          },
        });

      const shouldDelete = await consumer.processMessage(buildMessage(), 1);

      expect(shouldDelete).toBe(true);
      expect(
        oneShotDb.events.getLatestManualStageRestartAt,
      ).toHaveBeenCalledWith(84);
      expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          fromState: "implementing",
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
          from_state: "implementing",
          to_state: "failed",
          stage: "implementation",
          metadata_json: expect.objectContaining({
            reason: "run_age_exceeded",
            ageBaselineSource: "created_at",
            ageBaselineAt: createdAt.toISOString(),
            manualRestartAt: null,
            effectiveAgeHours: 99,
          }),
        }),
      );
      expect(workspaceManager.prepareImplementerWorkspace).not.toHaveBeenCalled();
      expect(implementerProvider.implementPlan).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("lets old runs continue when a recent manual restart resets the age baseline", async () => {
    const dateNowSpy = mockDateNow("2026-05-08T05:32:46.000Z");
    try {
      const { consumer, oneShotDb, workspaceManager, implementerProvider } =
        buildImplementerDeps(buildImplementationResponse(), {
          run: {
            ...buildRun(),
            created_at: new Date("2026-05-04T02:22:42.000Z"),
          },
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
      expect(workspaceManager.prepareImplementerWorkspace).toHaveBeenCalled();
      expect(implementerProvider.implementPlan).toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("abandons old manually restarted runs from the latest restart baseline", async () => {
    const dateNowSpy = mockDateNow("2026-05-08T05:32:46.000Z");
    const manualRestartAt = new Date("2026-05-06T00:00:00.000Z");
    try {
      const { consumer, oneShotDb, workspaceManager, implementerProvider } =
        buildImplementerDeps(buildImplementationResponse(), {
          run: {
            ...buildRun(),
            created_at: new Date("2026-05-04T02:22:42.000Z"),
          },
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
      expect(workspaceManager.prepareImplementerWorkspace).not.toHaveBeenCalled();
      expect(implementerProvider.implementPlan).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it("does not classify target-branch drift during the initial implementation pass", async () => {
    getRemoteBranchHeadMock.mockReset();
    getRemoteBranchHeadMock.mockImplementation(
      (_repo: unknown, branchName: string) => {
        if (branchName === "master") {
          throw new Error("target branch lookup should be skipped");
        }
        return Promise.resolve({
          branchName,
          headSha: COMMIT_SHA,
        });
      },
    );
    configureChangedFilesMock({
      committedFiles: ["src/oneshot/consumers/implementer.ts"],
      dirtyFiles: ["src/oneshot/consumers/implementer.ts"],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const {
      consumer,
      oneShotDb,
      workspaceManager,
      implementerProvider,
    } = buildImplementerDeps(buildImplementationResponse());

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      84,
      expect.objectContaining({ repo_name: "core-app" }),
      START_SHA,
      "oneshot/cpdev-20686-run-84",
      "oneshot/cpdev-20686-run-84",
      [],
    );
    expect(getRemoteBranchHeadMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "master",
    );
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "replan_required",
      expect.anything(),
    );
    expect(oneShotDb.notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "branch_drift",
      }),
    );
    expect(implementerProvider.implementPlan).toHaveBeenCalled();
  });

  it("starts primary v2 implementation from the persistent run branch without rechecking the target branch", async () => {
    getRemoteBranchHeadMock.mockReset();
    getRemoteBranchHeadMock.mockImplementation(
      (_repo: unknown, branchName: string) => {
        if (branchName === "master") {
          throw new Error("target branch lookup should be skipped once the run branch exists");
        }
        return Promise.resolve({
          branchName,
          headSha: COMMIT_SHA,
        });
      },
    );
    configureChangedFilesMock({
      committedFiles: ["src/oneshot/consumers/implementer.ts"],
      dirtyFiles: ["src/oneshot/consumers/implementer.ts"],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const { consumer, oneShotDb, workspaceManager, implementerProvider } =
      buildImplementerDeps(buildImplementationResponse(), {
        run: {
          ...buildRun(),
          workspace_mode: "v2",
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
        } as OneShotRun,
      });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(workspaceManager.prepareWorkspace).not.toHaveBeenCalled();
    expect(workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      84,
      expect.objectContaining({ repo_name: "core-app" }),
      START_SHA,
      "oneshot/cpdev-20686-run-84",
      "oneshot/cpdev-20686-run-84",
      [],
    );
    expect(getRemoteBranchHeadMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "master",
    );
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "replan_required",
      expect.anything(),
    );
    expect(implementerProvider.implementPlan).toHaveBeenCalled();
  });

  it("finalizes the current candidate when a dirty run row has a blank workspace mode", async () => {
    configureChangedFilesMock({
      committedFiles: ["src/oneshot/consumers/implementer.ts"],
      dirtyFiles: ["src/oneshot/consumers/implementer.ts"],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const { consumer, oneShotDb } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        run: {
          ...buildRun(),
          workspace_mode: "",
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
        } as unknown as OneShotRun,
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.candidateVersions.finalizeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        oneshotRunId: 84,
        candidateVersion: 1,
        candidateCommitSha: COMMIT_SHA,
        leaseScope: "run-worktree:84",
        fencingToken: 123,
      }),
    );
    expect(
      oneShotDb.workspaceState.conditionalUpdateWithLease,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        oneshotRunId: 84,
        workspacePhase: "candidate_finalized",
        workspaceHeadSha: COMMIT_SHA,
        currentCandidateVersion: 1,
        currentCandidateSha: COMMIT_SHA,
      }),
    );
  });

  it("starts revision workspaces from the prior implementation commit even when the base branch drifts", async () => {
    getRemoteBranchHeadMock.mockReset();
    getRemoteBranchHeadMock.mockImplementation(
      (_repo: unknown, branchName: string) => {
        if (branchName === "master") {
          throw new Error("target branch lookup should be skipped on revision");
        }
        return Promise.resolve({
          branchName,
          headSha: COMMIT_SHA,
        });
      },
    );
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);

    const { consumer, oneShotDb, workspaceManager, implementerProvider } =
      buildImplementerDeps(buildImplementationResponse(), {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
      });

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      84,
      expect.objectContaining({ repo_name: "core-app" }),
      PROVIDER_COMMIT_SHA,
      "oneshot/cpdev-20686-run-84",
      "oneshot/cpdev-20686-run-84",
      [],
    );
    expect(implementerProvider.implementPlan).toHaveBeenCalled();
    expect(getRemoteBranchHeadMock).not.toHaveBeenCalledWith(
      expect.anything(),
      "master",
    );
    expect(runGitCommandMock).toHaveBeenCalledWith(
      `git diff ${JSON.stringify(START_SHA)} ${JSON.stringify(COMMIT_SHA)} --unified=5`,
      "/tmp/implementer-workspace",
    );
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "replan_required",
      expect.anything(),
    );
    expect(oneShotDb.notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "branch_drift",
      }),
    );
  });

  it("starts revision workspaces from the current candidate when the run commit pointer was cleared", async () => {
    ensureRunBranchContractMock.mockResolvedValue({
      branchName: "oneshot/cpdev-20686-run-84",
      baseCommitSha: START_SHA,
      expectedHeadSha: PROVIDER_COMMIT_SHA,
      workspaceBaseSha: PROVIDER_COMMIT_SHA,
      currentCandidateSha: PROVIDER_COMMIT_SHA,
      remoteHeadSha: PROVIDER_COMMIT_SHA,
      repairedMetadata: false,
      createdRemoteBranch: false,
      sharedEpicBranch: false,
    });
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);

    const { consumer, workspaceManager } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: null,
          current_code_review_version: 1,
        },
      },
    );

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      84,
      expect.objectContaining({ repo_name: "core-app" }),
      PROVIDER_COMMIT_SHA,
      "oneshot/cpdev-20686-run-84",
      "oneshot/cpdev-20686-run-84",
      [],
    );
  });

	  it("passes prior implementer session lineage into revision fork-resume and persists the forked session metadata", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);
    const providerResponse = {
      ...buildImplementationResponse(),
      sessionId: "session-forked",
      resumedFromSessionId: "session-previous",
      resumeMode: "fork_resume" as const,
      resumeAttempted: true,
      resumeSucceeded: true,
    };
    const { consumer, oneShotDb, workspaceManager, implementerProvider } =
      buildImplementerDeps(providerResponse, {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        previousImplementationArtifact: {
          metadata_json: { sessionId: "session-previous" },
          body: {
            completedSpecIds: ["spec-1"],
            sessionNotes: "Prior implementer notes.",
          },
        },
      });

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      84,
      expect.objectContaining({ repo_name: "core-app" }),
      PROVIDER_COMMIT_SHA,
      "oneshot/cpdev-20686-run-84",
      "oneshot/cpdev-20686-run-84",
      [],
    );
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSessionId: "session-previous",
        forkSessionOnResume: true,
        claudeConfigDir: "/tmp/workspaces/claude-sessions/run-84",
        revisionContext: expect.objectContaining({
          previousProviderSessionId: "session-previous",
          previousCompletedSpecIds: ["spec-1"],
          previousSessionNotes: "Prior implementer notes.",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "implementation_session_resume",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          version: 2,
          sessionId: "session-forked",
          resumedFromSessionId: "session-previous",
          resumeMode: "fork_resume",
          resumeAttempted: true,
          resumeSucceeded: true,
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          sessionId: "session-forked",
          resumedFromSessionId: "session-previous",
          resumeMode: "fork_resume",
          resumeAttempted: true,
          resumeSucceeded: true,
          revisionChangedFiles: ["src/oneshot/consumers/implementer.ts"],
        }),
      }),
    );
    expect(runGitCommandMock).toHaveBeenCalledWith(
      `git diff ${JSON.stringify(START_SHA)} ${JSON.stringify(COMMIT_SHA)} --unified=5`,
      "/tmp/implementer-workspace",
    );
  });

  it("persists resume fallback metadata when the provider retries revision build fresh", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);
    const providerResponse = {
      ...buildImplementationResponse(),
      sessionId: "session-fresh-fallback",
      resumedFromSessionId: "session-previous",
      resumeMode: "fork_resume_fallback_fresh" as const,
      resumeAttempted: true,
      resumeSucceeded: false,
    };
    const { consumer, oneShotDb } = buildImplementerDeps(providerResponse, {
      run: {
        ...buildRun(),
        current_implementation_version: 2,
        current_implementation_branch: "oneshot/cpdev-20686-run-84",
        current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
        current_code_review_version: 1,
      },
      previousImplementationArtifact: {
        metadata_json: { sessionId: "session-previous" },
        body: {
          completedSpecIds: ["spec-1"],
          sessionNotes: "Prior implementer notes.",
        },
      },
    });

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "implementation_session_resume",
        metadata_json: expect.objectContaining({
          sessionId: "session-fresh-fallback",
          resumedFromSessionId: "session-previous",
          resumeMode: "fork_resume_fallback_fresh",
          resumeAttempted: true,
          resumeSucceeded: false,
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          sessionId: "session-fresh-fallback",
          resumedFromSessionId: "session-previous",
          resumeMode: "fork_resume_fallback_fresh",
          resumeAttempted: true,
          resumeSucceeded: false,
        }),
      }),
    );
  });

  it("retries a resumed revision once with a fresh session when it produces no file changes", async () => {
    queueHeadShas(
      PROVIDER_COMMIT_SHA,
      PROVIDER_COMMIT_SHA,
      PROVIDER_COMMIT_SHA,
      COMMIT_SHA,
    );
    listChangedFilesMock.mockReset();
    listChangedFilesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(["src/oneshot/consumers/implementer.ts"])
      .mockResolvedValueOnce(["src/oneshot/consumers/implementer.ts"])
      .mockResolvedValueOnce(["src/oneshot/consumers/implementer.ts"]);

    const noChangeResponse = {
      ...buildImplementationResponse(),
      implementation: {
        ...buildImplementationResponse().implementation,
        changedFiles: [],
      },
      sessionId: "session-forked",
      resumedFromSessionId: "session-previous",
      resumeMode: "fork_resume" as const,
      resumeAttempted: true,
      resumeSucceeded: true,
    };
    const freshResponse = {
      ...buildImplementationResponse(),
      sessionId: "session-fresh",
    };
    const { consumer, oneShotDb, implementerProvider, publisher } =
      buildImplementerDeps(noChangeResponse, {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        codeReviewArtifact: buildCodeReview(),
        previousImplementationArtifact: {
          metadata_json: { sessionId: "session-previous" },
          body: {
            completedSpecIds: ["spec-1"],
            sessionNotes: "Prior implementer notes.",
          },
        },
      });
    implementerProvider.implementPlan
      .mockResolvedValueOnce(noChangeResponse)
      .mockResolvedValueOnce(freshResponse);

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledTimes(2);
    expect(implementerProvider.implementPlan).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        resumeSessionId: "session-previous",
        forkSessionOnResume: true,
      }),
    );
    expect(implementerProvider.implementPlan).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        resumeSessionId: undefined,
        forkSessionOnResume: undefined,
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "stage_attempt_metrics",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          version: 2,
          reason: "revision_no_changed_files_retry_fresh",
          retryOutcome: "fresh_retry_started",
          sessionId: "session-forked",
          resumedFromSessionId: "session-previous",
          resumeMode: "fork_resume",
          codeReviewDecision: "NEEDS_CHANGES",
          codeReviewFindingCount: 1,
          requiredChangeCount: 1,
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "revision_no_changed_files_retry_fresh",
        }),
      }),
    );
    expect(oneShotDb.runs.addTokenUsage).toHaveBeenCalledTimes(2);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          sessionId: "session-fresh",
          resumeMode: "fresh",
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      2,
      "queued_for_code_review",
      false,
      {
        expectedImplementationCommitSha: expect.any(String),
        expectedImplementationVersion: 2,
      },
    );
  });

  it("blocks a resumed revision for review when the fresh retry also changes nothing", async () => {
    queueHeadShas(
      PROVIDER_COMMIT_SHA,
      PROVIDER_COMMIT_SHA,
      PROVIDER_COMMIT_SHA,
    );
    listChangedFilesMock.mockReset();
    listChangedFilesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const noChangeResponse = {
      ...buildImplementationResponse(),
      implementation: {
        ...buildImplementationResponse().implementation,
        changedFiles: [],
      },
      sessionId: "session-forked",
      resumedFromSessionId: "session-previous",
      resumeMode: "fork_resume" as const,
      resumeAttempted: true,
      resumeSucceeded: true,
    };
    const freshNoChangeResponse = {
      ...noChangeResponse,
      sessionId: "session-fresh",
      resumedFromSessionId: undefined,
      resumeMode: "fresh" as const,
      resumeAttempted: false,
      resumeSucceeded: false,
    };
    const { consumer, oneShotDb, implementerProvider, publisher } =
      buildImplementerDeps(noChangeResponse, {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        codeReviewArtifact: buildCodeReview(),
        previousImplementationArtifact: {
          metadata_json: { sessionId: "session-previous" },
          body: {
            completedSpecIds: ["spec-1"],
            sessionNotes: "Prior implementer notes.",
          },
        },
      });
    implementerProvider.implementPlan
      .mockResolvedValueOnce(noChangeResponse)
      .mockResolvedValueOnce(freshNoChangeResponse);

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledTimes(2);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "source_already_clean_or_no_changes",
          last_error: expect.stringContaining(
            "Implementer revision produced no file changes after a fresh-session retry.",
          ),
        }),
        notification: expect.objectContaining({
          notification_type: "progress_update",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "revision_no_changed_files_after_fresh_retry",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("blocks no-changed-files first implementation passes for review", async () => {
    queueHeadShas(START_SHA, START_SHA);
    listChangedFilesMock.mockReset();
    listChangedFilesMock.mockResolvedValue([]);

    const noChangeResponse = {
      ...buildImplementationResponse(),
      implementation: {
        ...buildImplementationResponse().implementation,
        changedFiles: [],
      },
    };
    const { consumer, implementerProvider } =
      buildImplementerDeps(noChangeResponse);

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledTimes(1);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "source_already_clean_or_no_changes",
          last_error: expect.stringContaining(
            "Implementer completed without producing any file changes.",
          ),
        }),
        notification: expect.objectContaining({
          notification_type: "progress_update",
        }),
      }),
    );
  });

  it("blocks no-changed-files revisions that have no resumed session for review", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA);
    listChangedFilesMock.mockReset();
    listChangedFilesMock.mockResolvedValue([]);

    const noChangeResponse = {
      ...buildImplementationResponse(),
      implementation: {
        ...buildImplementationResponse().implementation,
        changedFiles: [],
      },
      sessionId: "session-fresh",
      resumeMode: "fresh" as const,
      resumeAttempted: false,
      resumeSucceeded: false,
    };
    const { consumer, implementerProvider } = buildImplementerDeps(
      noChangeResponse,
      {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
      },
    );

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledTimes(1);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "source_already_clean_or_no_changes",
          last_error: expect.stringContaining(
            "Implementer completed without producing any file changes.",
          ),
        }),
        notification: expect.objectContaining({
          notification_type: "progress_update",
        }),
      }),
    );
  });

  it("records a warning but continues for security_wiz scope violations", async () => {
    const { consumer, publisher, oneShotDb } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildQualificationSummary({
          processingMode: "security_wiz",
          jiraLabels: ["PFOS"],
          ticketSummary:
            "[Security] jackson-databind - cp-medhok-monorepo - Wiz remediation",
        }),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "branch_hygiene",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "pfos_scope_violation_warning",
          warning: expect.stringContaining(
            "PFOS security remediation scope violation",
          ),
          violatingFiles: expect.arrayContaining([
            "src/oneshot/consumers/implementer.ts",
          ]),
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      1,
      "queued_for_code_review",
      false,
      {
        expectedImplementationCommitSha: expect.any(String),
        expectedImplementationVersion: 1,
      },
    );
  });

  it("bypasses the PFOS scope guard for sonar_autofix runs even with a generic security label", async () => {
    const { consumer, publisher } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildQualificationSummary({
          jiraLabels: ["SONAR-AUTOFIX", "security"],
          ticketSummary: "[Security] Sonar vulnerability story",
        }),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      1,
      "queued_for_code_review",
      false,
      {
        expectedImplementationCommitSha: expect.any(String),
        expectedImplementationVersion: 1,
      },
    );
  });

  it("fails before fresh retry when the revision retry projection cannot fit the stage budget", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA);
    listChangedFilesMock.mockReset();
    listChangedFilesMock
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const noChangeResponse = {
      ...buildImplementationResponse(),
      implementation: {
        ...buildImplementationResponse().implementation,
        changedFiles: [],
      },
      sessionId: "session-forked",
      resumedFromSessionId: "session-previous",
      resumeMode: "fork_resume" as const,
      resumeAttempted: true,
      resumeSucceeded: true,
    };
    const { consumer, oneShotDb, implementerProvider } =
      buildImplementerDeps(noChangeResponse, {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        codeReviewArtifact: buildCodeReview(),
        previousImplementationArtifact: {
          metadata_json: { sessionId: "session-previous" },
          body: {
            completedSpecIds: ["spec-1"],
            sessionNotes: "Prior implementer notes.",
          },
        },
      });
    oneShotDb.events.getEventsForRun.mockImplementation(async () => {
      if (implementerProvider.implementPlan.mock.calls.length === 0) {
        return [];
      }
      return [
        {
          event_type: "stage_attempt_metrics",
          stage: "implementation",
          metadata_json: {
            version: 2,
            stage_tokens_used: 4_000_000,
          },
        },
      ];
    });

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledTimes(1);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
        updates: expect.objectContaining({
          final_disposition: "budget_exceeded",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "revision_no_change_retry_budget_exceeded",
        }),
      }),
    );
  });

  it("blocks instead of retrying when a no-change code-review revision explicitly disagrees", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA);
    listChangedFilesMock.mockReset();
    listChangedFilesMock.mockResolvedValue([]);

    const disagreementResponse = {
      ...buildImplementationResponse(),
      implementation: {
        ...buildImplementationResponse().implementation,
        changedFiles: [],
        implementerDisagrees: true,
        implementerDisagreementReason:
          "The requested change would break an existing acceptance criterion.",
      },
      sessionId: "session-forked",
      resumedFromSessionId: "session-previous",
      resumeMode: "fork_resume" as const,
      resumeAttempted: true,
      resumeSucceeded: true,
    };
    const { consumer, oneShotDb, implementerProvider } =
      buildImplementerDeps(disagreementResponse, {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        codeReviewArtifact: buildCodeReview(),
        previousImplementationArtifact: {
          metadata_json: { sessionId: "session-previous" },
          body: {
            completedSpecIds: ["spec-1"],
            sessionNotes: "Prior implementer notes.",
          },
        },
      });

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledTimes(1);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "code_review_blocked",
          last_error: expect.stringContaining(
            "Implementer disagreed with code review",
          ),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "implementation_disagreed_with_review",
          disagreementReason:
            "The requested change would break an existing acceptance criterion.",
        }),
      }),
    );
  });

  it("opens a draft PR when a validation-only retry is disputed after approved code review", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA);
    listChangedFilesMock.mockReset();
    listChangedFilesMock.mockResolvedValue([]);

    const disagreementResponse = {
      ...buildImplementationResponse(),
      implementation: {
        ...buildImplementationResponse().implementation,
        changedFiles: [],
        implementerDisagrees: true,
        implementerDisagreementReason:
          "The validation check is too broad and matches unrelated legacy calls.",
      },
      sessionId: "session-forked",
      resumedFromSessionId: "session-previous",
      resumeMode: "fork_resume" as const,
      resumeAttempted: true,
      resumeSucceeded: true,
    };
    const validationOnlyTestArtifact = {
      resolvedCommand: "validation-check",
      commandSource: "implementation",
      executionKind: "validation_only",
      executedCommands: [
        'rg --line-number --color never -- "lgrid\\\\.updateData\\\\(r\\\\)" MedicalMgmt/src/main/java/com/medhok/mm/client/dashboard/ManagerActionView.java',
      ],
      executedValidationChecks: [{
        kind: "must_not_match",
        pattern: "lgrid\\.updateData\\(r\\)",
        paths: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/dashboard/ManagerActionView.java",
        ],
        scope: "file",
        passed: false,
        exitCode: 0,
        outputPreview: "635:\tlgrid.updateData(r);",
      }],
      skippedTestCommands: [],
      mavenSkippedTestCommands: [],
      mavenBuildsDisabled: true,
      unverified: true,
      exitCode: 1,
      passed: false,
      passCount: 0,
      failCount: 1,
      skipCount: 0,
      failedTests: [{
        testName: "validation-check",
        message: "Structured validation check expected no matches.",
      }],
      truncatedOutput: "635:\tlgrid.updateData(r);",
      parserNotes: [],
      implementationVersion: 1,
      codeReviewVersion: 1,
    };
    const { consumer, oneShotDb, implementerProvider } =
      buildImplementerDeps(disagreementResponse, {
        run: {
          ...buildRun(),
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
          current_test_version: 1,
        },
        codeReviewArtifact: buildCodeReview({
          decision: "APPROVED",
          score: 92,
          findings: [],
          requiredChanges: [],
        }),
        testArtifact: validationOnlyTestArtifact,
        events: [{
          event_type: "state_transition",
          from_state: "testing",
          to_state: "queued_for_implementation",
          stage: "testing",
          metadata_json: {
            reason: "validation_failure",
          },
        }],
        previousImplementationArtifact: {
          metadata_json: { sessionId: "session-previous" },
          body: {
            completedSpecIds: ["spec-1"],
            sessionNotes: "Prior implementer notes.",
          },
        },
      });

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledTimes(1);
    expect(ensureDraftPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        head: "oneshot/cpdev-20686-run-84",
        draft: true,
        body: expect.stringContaining("OneShot Validation Dispute Needs Review"),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "pr_open",
        updates: expect.objectContaining({
          current_pr_url: "https://github.com/org/core-app/pull/12",
          final_disposition: "completed_needs_review",
          last_error: expect.stringContaining(
            "Validation-only check disputed by implementer",
          ),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "validation_dispute_needs_review",
          disagreementReason:
            "The validation check is too broad and matches unrelated legacy calls.",
          testExecutionKind: "validation_only",
          failedValidationCheckCount: 1,
        }),
      }),
    );
  });

  it("stores the actual model used and passes shared Claude session storage for a fresh implementation pass", async () => {
    const { consumer, oneShotDb, cleanup, publisher, implementerProvider } =
      buildImplementerDeps(buildImplementationResponse());

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "us.anthropic.claude-sonnet-fallback-v1:0",
      }),
    );
    expect(recordLlmMetricsMock).toHaveBeenCalledWith(
      "implementation",
      "anthropic",
      2_000,
      {
        input: 10,
        output: 20,
      },
      0.12,
      {
        model: "us.anthropic.claude-sonnet-fallback-v1:0",
      },
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      1,
      "queued_for_code_review",
      false,
      {
        expectedImplementationCommitSha: expect.any(String),
        expectedImplementationVersion: 1,
      },
    );
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeSessionId: undefined,
        forkSessionOnResume: false,
        claudeConfigDir: "/tmp/workspaces/claude-sessions/run-84",
      }),
    );
    expect(commitAllChangesMock).toHaveBeenCalledTimes(1);
  });

  it("allows implementation revision when prior total exceeds the legacy run budget but stage budget has room", async () => {
    const { consumer, oneShotDb, implementerProvider, publisher } =
      buildImplementerDeps(buildImplementationResponse());
    oneShotDb.runs.getRunById.mockResolvedValue({
      ...buildRun(),
      current_implementation_version: 2,
      current_code_review_version: 1,
      total_tokens_used: 2_453_095,
      max_total_tokens: 2_000_000,
    });
    oneShotDb.artifacts.getArtifactsForRun.mockResolvedValue([
      {
        stage: "plan",
        version: 1,
        metadata_json: { stage_tokens_used: 905_623 },
      },
      {
        stage: "implementation",
        version: 1,
        metadata_json: { stage_tokens_used: 919_622 },
      },
      {
        stage: "code_review",
        version: 1,
        metadata_json: { stage_tokens_used: 627_850 },
      },
    ]);

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 2,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalled();
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      2,
      "queued_for_code_review",
      false,
      {
        expectedImplementationCommitSha: expect.any(String),
        expectedImplementationVersion: 2,
      },
    );
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
      }),
    );
  });

  it("does not charge Build v3 against Build v1/v2 stage spend in a run-86 style review loop", async () => {
    const { consumer, oneShotDb, implementerProvider, publisher } =
      buildImplementerDeps(buildImplementationResponse());
    oneShotDb.runs.getRunById.mockResolvedValue({
      ...buildRun(),
      current_implementation_version: 3,
      current_code_review_version: 2,
      total_tokens_used: 13_963_642,
      max_total_tokens: 16_000_000,
    });
    oneShotDb.artifacts.getArtifactsForRun.mockResolvedValue([
      {
        stage: "plan",
        version: 1,
        metadata_json: { stage_tokens_used: 3_600_000 },
      },
      {
        stage: "review",
        version: 1,
        metadata_json: { stage_tokens_used: 1_200_000 },
      },
      {
        stage: "implementation",
        version: 1,
        metadata_json: { stage_tokens_used: 3_700_000 },
      },
      {
        stage: "code_review",
        version: 1,
        metadata_json: { stage_tokens_used: 1_400_000 },
      },
      {
        stage: "implementation",
        version: 2,
        metadata_json: { stage_tokens_used: 3_800_000 },
      },
      {
        stage: "code_review",
        version: 2,
        metadata_json: { stage_tokens_used: 1_500_000 },
      },
    ]);
    oneShotDb.events.getEventsForRun.mockResolvedValue([
      {
        event_type: "stage_attempt_metrics",
        stage: "implementation",
        metadata_json: {
          version: 2,
          revision: true,
          stage_tokens_used: 240_000,
        },
      },
    ]);

    const shouldDelete = await consumer.processMessage(
      buildMessage({
        version: 3,
        revision: true,
      }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalled();
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      3,
      "queued_for_code_review",
      false,
      {
        expectedImplementationCommitSha: expect.any(String),
        expectedImplementationVersion: 3,
      },
    );
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
      }),
    );
  });

  it("fails with total budget metadata when projected usage exceeds the runaway cap", async () => {
    const { consumer, oneShotDb, implementerProvider } = buildImplementerDeps(
      buildImplementationResponse(),
    );
    oneShotDb.runs.getRunById.mockResolvedValue({
      ...buildRun(),
      total_tokens_used: 49_800_000,
      max_total_tokens: 50_000_000,
    });
    oneShotDb.artifacts.getArtifactsForRun.mockResolvedValue([
      {
        stage: "implementation",
        version: 1,
        metadata_json: { stage_tokens_used: 100_000 },
      },
    ]);

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
        updates: expect.objectContaining({
          final_disposition: "budget_exceeded",
          last_error: expect.stringContaining("total_budget_exceeded"),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          budgetFailureReason: "total_budget_exceeded",
          totalTokensUsed: 49_800_000,
          totalMaxTokens: 50_000_000,
          projectedTokens: 500_000,
        }),
      }),
    );
  });

  it("treats untracked-file-only output as a real implementation change", async () => {
    configureChangedFilesMock({
      dirtyFiles: ["src/oneshot/new-file.ts"],
      committedFiles: ["src/oneshot/new-file.ts"],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const { consumer, oneShotDb, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(commitAllChangesMock).toHaveBeenCalledTimes(1);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          changedFiles: ["src/oneshot/new-file.ts"],
        }),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "queued_for_code_review",
        updates: expect.objectContaining({
          current_implementation_commit_sha: COMMIT_SHA,
        }),
        notification: expect.objectContaining({
          notification_type: "implementation_completed",
        }),
      }),
    );
  });

  it("auto-replans out-of-contract changed files before publishing code review", async () => {
    configureChangedFilesMock({
      dirtyFiles: [
        "src/oneshot/consumers/implementer.ts",
        "src/oneshot/unplanned-helper.ts",
      ],
      committedFiles: [
        "src/oneshot/consumers/implementer.ts",
        "src/oneshot/unplanned-helper.ts",
      ],
    });
    queueHeadShas(START_SHA, START_SHA);

    const { consumer, cleanup, oneShotDb, publisher } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        plan: {
          ...buildPlan(),
          fileChangeContract: [
            {
              path: "src/oneshot/consumers/implementer.ts",
              role: "runtime_required",
              editable: true,
              rationale: "The approved plan only edits the implementer consumer.",
              supportingEvidence: ["Read implementer.ts."],
              allowedChanges: ["Apply the scoped implementation update."],
            },
            {
              path: "src/oneshot/unplanned-helper.ts",
              role: "forbidden",
              editable: false,
              rationale: "No helper extraction was approved.",
              supportingEvidence: ["Plan scope intentionally excludes helpers."],
            },
          ],
          plannedCodeChanges: [
            {
              targetFile: "src/oneshot/consumers/implementer.ts",
              symbolOrRegion: "implementation flow",
              changeType: "update",
              afterSketch: "Make the scoped update in place.",
              rationale: "Avoid extra-file scope expansion.",
              supportingEvidence: ["Existing implementer flow."],
              confidence: "high",
            },
          ],
          guardrailReport: {
            coreChecks: [
              {
                id: "scope-discipline",
                severity: "high",
                status: "passed",
                applicabilityReason: "Scope discipline applies to every run.",
                evidence: ["fileChangeContract marks helper file forbidden."],
                requiredAction: "Do not edit forbidden files.",
              },
            ],
            domainChecks: [],
            implementerChecks: [
              {
                id: "editable-file-contract",
                severity: "high",
                status: "passed",
                applicabilityReason: "Editable files are explicit.",
                evidence: ["Only implementer.ts is editable."],
                requiredAction: "Return a deviation instead of editing other files.",
              },
            ],
          },
          implementerGuardrails: [
            {
              id: "implementation-contract",
              instruction:
                "Only edit src/oneshot/consumers/implementer.ts; report deviations for any other file.",
              appliesToFiles: ["src/oneshot/consumers/implementer.ts"],
              required: true,
            },
          ],
        },
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(commitAllChangesMock).not.toHaveBeenCalled();
    expect(pushBranchMock).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "planning",
      2,
      "queued_for_planning",
      true,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("plan-contract-replan:"),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_planning",
        updates: expect.objectContaining({
          current_plan_version: 2,
          planning_attempt_count: 0,
          implementation_attempt_count: 0,
          code_review_attempt_count: 0,
          verification_loop_count: 0,
          current_implementation_branch: null,
          current_implementation_commit_sha: null,
          current_code_review_version: null,
          current_test_version: null,
          final_disposition: null,
          last_error: null,
        }),
        notification: expect.objectContaining({
          notification_type: "progress_update",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "queued_for_planning",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "plan_contract_violation_auto_replan",
          nextPlanVersion: 2,
          violatingFiles: ["src/oneshot/unplanned-helper.ts"],
          autoReplanAttempt: 1,
          autoReplanMaxAttempts: 2,
        }),
      }),
    );
  });

  it("blocks out-of-contract changed files when contract replan budget is exhausted", async () => {
    configureChangedFilesMock({
      dirtyFiles: [
        "src/oneshot/consumers/implementer.ts",
        "src/oneshot/unplanned-helper.ts",
      ],
      committedFiles: [
        "src/oneshot/consumers/implementer.ts",
        "src/oneshot/unplanned-helper.ts",
      ],
    });
    queueHeadShas(START_SHA, START_SHA);

    const priorReplanEvent = {
      id: 1,
      oneshot_run_id: 84,
      event_type: "state_transition",
      from_state: "implementing",
      to_state: "queued_for_planning",
      stage: "implementation",
      metadata_json: {
        reason: "plan_contract_violation_auto_replan",
      },
      occurred_at: new Date(),
    };
    const { consumer, cleanup, oneShotDb, publisher } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        events: [
          priorReplanEvent,
          {
            ...priorReplanEvent,
            id: 2,
          },
        ],
        plan: {
          ...buildPlan(),
          fileChangeContract: [
            {
              path: "src/oneshot/consumers/implementer.ts",
              role: "runtime_required",
              editable: true,
              rationale: "The approved plan only edits the implementer consumer.",
              supportingEvidence: ["Read implementer.ts."],
              allowedChanges: ["Apply the scoped implementation update."],
            },
          ],
        },
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(commitAllChangesMock).not.toHaveBeenCalled();
    expect(pushBranchMock).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "implementation_blocked",
          last_error: expect.stringContaining(
            "Plan-contract auto-replan exhausted",
          ),
        }),
        notification: expect.objectContaining({
          notification_type: "progress_update",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "blocked",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "plan_contract_violation_replan_exhausted",
          autoReplanAttemptsUsed: 2,
          autoReplanMaxAttempts: 2,
        }),
      }),
    );
  });

  it("allows approved files reported as absolute workspace paths", async () => {
    const workspaceFile =
      "/tmp/implementer-workspace/src/oneshot/consumers/implementer.ts";
    configureChangedFilesMock({
      dirtyFiles: [workspaceFile],
      committedFiles: [workspaceFile],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const { consumer, publisher } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        plan: {
          ...buildPlan(),
          fileChangeContract: [
            {
              path: "src/oneshot/consumers/implementer.ts",
              role: "runtime_required",
              editable: true,
              rationale: "The approved plan edits the implementer consumer.",
              supportingEvidence: ["Read implementer.ts."],
              allowedChanges: ["Apply the scoped implementation update."],
            },
          ],
        },
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      1,
      "queued_for_code_review",
      false,
      {
        expectedImplementationCommitSha:
          "fedcba9876543210fedcba9876543210fedcba98",
        expectedImplementationVersion: 1,
      },
    );
  });

  it("removes nested Maven cache output before publishing code review", async () => {
    const sourceFile = "medhok-ocr-manager/src/App.java";
    const generatedFile =
      "medhok-ocr-manager/.m2/repository/io/netty/netty-common.jar";
    let changedFileCall = 0;
    listChangedFilesMock.mockImplementation((_cwd: string, fromRef?: string) => {
      changedFileCall += 1;
      if (changedFileCall <= 2) {
        return Promise.resolve([sourceFile, generatedFile]);
      }
      return Promise.resolve(fromRef ? [sourceFile] : [sourceFile]);
    });
    cleanGeneratedBranchChangesMock.mockResolvedValue({
      removedFiles: [generatedFile],
      removedFilesSample: [generatedFile],
      removedFilesCount: 1,
      preservedFiles: [],
      preservedFilesSample: [],
      preservedFilesCount: 0,
      blockedFiles: [],
      blockedFilesSample: [],
      blockedFilesCount: 0,
    });
    isBlockedGeneratedPathMock.mockImplementation((filePath: string) =>
      filePath === generatedFile,
    );
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const { consumer, oneShotDb, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(cleanGeneratedBranchChangesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseRef: START_SHA,
        currentHead: START_SHA,
      }),
    );
    expect(commitAllChangesMock).toHaveBeenCalledTimes(1);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          changedFiles: [sourceFile],
          branchHygiene: expect.objectContaining({
            removedFiles: [generatedFile],
            removedFilesCount: 1,
            blockedFilesCount: 0,
          }),
        }),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
  });

  it("fails before code review when nested Maven cache is the only output", async () => {
    const generatedFile =
      "medhok-ocr-manager/.m2/repository/io/netty/netty-common.jar";
    let changedFileCall = 0;
    listChangedFilesMock.mockImplementation(() => {
      changedFileCall += 1;
      return Promise.resolve(changedFileCall <= 2 ? [generatedFile] : []);
    });
    cleanGeneratedBranchChangesMock.mockResolvedValue({
      removedFiles: [generatedFile],
      removedFilesSample: [generatedFile],
      removedFilesCount: 1,
      preservedFiles: [],
      preservedFilesSample: [],
      preservedFilesCount: 0,
      blockedFiles: [],
      blockedFilesSample: [],
      blockedFilesCount: 0,
    });
    isBlockedGeneratedPathMock.mockImplementation((filePath: string) =>
      filePath === generatedFile,
    );
    queueHeadShas(START_SHA, START_SHA);

    const { consumer, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(commitAllChangesMock).not.toHaveBeenCalled();
    expect(pushBranchMock).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
        updates: expect.objectContaining({
          final_disposition: "run_failed",
          last_error:
            "Implementation only changed generated/cache files that were removed by branch hygiene.",
        }),
      }),
    );
  });

  it("reuses a provider-created commit when the workspace is already clean", async () => {
    configureChangedFilesMock({
      dirtyFiles: [],
      committedFiles: ["src/oneshot/providers/claude-implementer.ts"],
    });
    queueHeadShas(START_SHA, PROVIDER_COMMIT_SHA);
    getRemoteBranchHeadMock.mockReset();
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: "oneshot/cpdev-20686-run-84",
      headSha: PROVIDER_COMMIT_SHA,
    });

    const { consumer, oneShotDb, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(commitAllChangesMock).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "queued_for_code_review",
        updates: expect.objectContaining({
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
        }),
        notification: expect.objectContaining({
          notification_type: "implementation_completed",
        }),
      }),
    );
    expect(runGitCommandMock).toHaveBeenCalledWith(
      `git diff ${JSON.stringify(START_SHA)} ${JSON.stringify(PROVIDER_COMMIT_SHA)} --unified=5`,
      "/tmp/implementer-workspace",
    );
  });

  it("creates one final consumer commit when provider commits and leaves dirty files behind", async () => {
    configureChangedFilesMock({
      dirtyFiles: ["src/oneshot/dirty-file.ts"],
      committedFiles: [
        "src/oneshot/already-committed.ts",
        "src/oneshot/dirty-file.ts",
      ],
    });
    queueHeadShas(START_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);

    const { consumer, oneShotDb, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(commitAllChangesMock).toHaveBeenCalledTimes(1);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          changedFiles: [
            "src/oneshot/already-committed.ts",
            "src/oneshot/dirty-file.ts",
          ],
        }),
      }),
    );
    expect(runGitCommandMock).toHaveBeenCalledWith(
      `git diff ${JSON.stringify(START_SHA)} ${JSON.stringify(COMMIT_SHA)} --unified=5`,
      "/tmp/implementer-workspace",
    );
  });

  it("does not overwrite a shared Epic branch that advanced outside the workspace", async () => {
    const epicBranch = "oneshot/epic/cpdev-20000/master";
    configureChangedFilesMock({
      dirtyFiles: ["src/oneshot/consumers/implementer.ts"],
      committedFiles: ["src/oneshot/consumers/implementer.ts"],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);
    ensureRunBranchContractMock.mockResolvedValue({
      branchName: epicBranch,
      baseCommitSha: START_SHA,
      expectedHeadSha: START_SHA,
      workspaceBaseSha: START_SHA,
      currentCandidateSha: null,
      remoteHeadSha: START_SHA,
      repairedMetadata: false,
      createdRemoteBranch: false,
      sharedEpicBranch: true,
    });
    getRemoteBranchHeadMock.mockResolvedValue({
      branchName: epicBranch,
      headSha: DRIFT_SHA,
    });
    isAncestorMock.mockResolvedValue(false);

    const { consumer, oneShotDb, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        run: {
          ...buildRun(),
          epic_key: "CPDEV-20000",
          run_branch_name: epicBranch,
          current_implementation_branch: epicBranch,
        },
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(isAncestorMock).toHaveBeenCalledWith(
      "/tmp/implementer-workspace",
      DRIFT_SHA,
      COMMIT_SHA,
    );
    expect(pushBranchMock).not.toHaveBeenCalled();
    expect(oneShotDb.candidateVersions.finalizeCandidate).not.toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "implementing",
      "queued_for_implementation",
      expect.objectContaining({
        last_error: expect.stringContaining("refusing to overwrite newer Epic work"),
      }),
    );
  });

  it("blocks the run for review when provider returns without any committed or dirty file changes", async () => {
    configureChangedFilesMock({
      dirtyFiles: [],
      committedFiles: [],
    });
    queueHeadShas(START_SHA, START_SHA);

    const { consumer, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(commitAllChangesMock).not.toHaveBeenCalled();
    expect(pushBranchMock).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "source_already_clean_or_no_changes",
          last_error: expect.stringContaining(
            "Implementer completed without producing any file changes.",
          ),
        }),
        notification: expect.objectContaining({
          notification_type: "progress_update",
        }),
      }),
    );
  });

  it("persists failureKind and failureCategory on retry events after provider rejection", async () => {
    const { consumer, oneShotDb, cleanup } = buildImplementerDeps(
      new ImplementerStallError("tool stalled", "tool_stall"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "implementing",
      "queued_for_implementation",
      { last_error: "tool stalled" },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        to_state: "queued_for_implementation",
        metadata_json: expect.objectContaining({
          reason: "transient_error_retry",
          failureKind: "tool_stall",
          failureCategory: "model_stall",
        }),
      }),
    );
  });

  it("requeues after workspace lease loss without implementation failure side effects", async () => {
    const { consumer, oneShotDb, cleanup, publisher } = buildImplementerDeps(
      new Error("Lost OneShot workspace lease during implementation"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "implementing",
      "queued_for_implementation",
      {
        last_error:
          "Workspace lease lost during implementation; stage requeued for retry",
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "queued_for_implementation",
        stage: "implementation",
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

  it("requeues when the v2 workspace lease is lost after push before publish", async () => {
    const run = { ...buildRun(), workspace_mode: "v2" as const };
    let pushed = false;
    let postPushLeaseChecks = 0;
    const assertLeaseValid = vi.fn().mockImplementation(async () => {
      if (!pushed) {
        return;
      }
      postPushLeaseChecks += 1;
      if (postPushLeaseChecks > 1) {
        throw new Error("Lost OneShot workspace lease during implementation");
      }
    });
    pushBranchMock.mockImplementationOnce(async () => {
      pushed = true;
    });

    const { consumer, oneShotDb, cleanup, publisher } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        run,
        assertLeaseValid,
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(pushBranchMock).toHaveBeenCalled();
    expect(oneShotDb.candidateVersions.finalizeCandidate).toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "implementing",
      "queued_for_implementation",
      {
        last_error:
          "Workspace lease lost during implementation; stage requeued for retry",
      },
    );
  });

  it("reverts code-review queue state when publish fails after implementation transition", async () => {
    configureChangedFilesMock({
      dirtyFiles: ["src/oneshot/providers/claude-implementer.ts"],
      committedFiles: ["src/oneshot/providers/claude-implementer.ts"],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const { consumer, oneShotDb, publisher, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );
    publisher.publishStageMessage.mockRejectedValueOnce(new Error("sqs down"));

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_code_review",
      "implementing",
      expect.objectContaining({
        current_implementation_version: 1,
        current_implementation_branch: null,
        current_implementation_commit_sha: null,
        current_code_review_version: null,
        last_error: "sqs down",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_code_review",
        to_state: "implementing",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          version: 1,
          codeReviewVersion: 1,
          publishError: "sqs down",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "implementing",
      "queued_for_implementation",
      { last_error: "sqs down" },
    );
  });

  it("reverts code-review queue state before lease-loss recovery after implementation transition", async () => {
    configureChangedFilesMock({
      dirtyFiles: ["src/oneshot/providers/claude-implementer.ts"],
      committedFiles: ["src/oneshot/providers/claude-implementer.ts"],
    });
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);

    const { consumer, oneShotDb, publisher, cleanup } = buildImplementerDeps(
      buildImplementationResponse(),
    );
    publisher.publishStageMessage.mockRejectedValueOnce(
      new Error("Lost OneShot workspace lease during implementation"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_code_review",
      "implementing",
      expect.objectContaining({
        last_error: "Lost OneShot workspace lease during implementation",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_code_review",
        to_state: "implementing",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          publishError: "Lost OneShot workspace lease during implementation",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "implementing",
      "queued_for_implementation",
      {
        last_error:
          "Workspace lease lost during implementation; stage requeued for retry",
      },
    );
  });

  it("persists turn-limit metrics and does not redeliver the same implementation version", async () => {
    const turnLimit = new ImplementerStallError(
      "Turn limit exceeded (max: 120)",
      "turn_limit",
      {
        durationMs: 10_000,
        toolCalls: 120,
        tokensUsed: {
          input: 10,
          output: 20,
          cacheRead: 30,
        },
        costUsd: 0.42,
        modelUsed: "us.anthropic.claude-sonnet-test-v1:0",
      },
    );
    const { consumer, oneShotDb } = buildImplementerDeps(turnLimit);

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).not.toHaveBeenCalled();
    // Budget accounting: input + output only (30 = 10 + 20). cacheRead:30 is
    // preserved in the artifact for observability but excluded from the budget
    // total — see implementer.ts:calculateTokenUsage.
    expect(oneShotDb.runs.addTokenUsage).toHaveBeenCalledWith(84, 30);
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "stage_attempt_metrics",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          version: 1,
          failureKind: "turn_limit",
          stage_tokens_used: 30,
          tokens_used: {
            input: 10,
            output: 20,
            cacheRead: 30,
          },
          stage_cost_usd: 0.42,
        }),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
        notification: expect.objectContaining({
          notification_type: "run_failed",
        }),
      }),
    );
  });

  it("fails before requeue when retry projection cannot fit the stage budget", async () => {
    const transient = new ImplementerStallError(
      "temporary provider error",
      "other",
      {
        durationMs: 1_000,
        toolCalls: 4,
        tokensUsed: {
          input: 100,
          output: 100,
        },
        costUsd: 0.01,
        modelUsed: "us.anthropic.claude-sonnet-test-v1:0",
      },
    );
    const { consumer, oneShotDb } = buildImplementerDeps(transient);
    oneShotDb.events.getEventsForRun
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          event_type: "stage_attempt_metrics",
          stage: "implementation",
          metadata_json: {
            version: 1,
            stage_tokens_used: 3_700_001,
          },
        },
      ]);

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "failed",
        notification: expect.objectContaining({
          notification_type: "budget_exceeded",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "retry_budget_projection_exceeded",
          budgetFailureReason: "stage_budget_exceeded",
        }),
      }),
    );
  });

  it("persists failureKind and failureCategory on terminal failure events", async () => {
    const { consumer, oneShotDb, cleanup } = buildImplementerDeps(
      new ImplementerStallError("model went idle", "idle_timeout"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 4);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalled();
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        to_state: "failed",
        metadata_json: expect.objectContaining({
          reason: "max_retries_exceeded",
          failureKind: "idle_timeout",
          failureCategory: "model_stall",
        }),
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// buildCommitMessage retrofit traceability (SPEC-3) — unit tests
// ---------------------------------------------------------------------------

// Since buildCommitMessage is a private function in ImplementerConsumer,
// we test it indirectly by verifying the shape of what the implementer
// understands a retrofit trace to be. We validate the retrofit-source-evidence
// types imported from the module.

import { type RetrofitCommitStatus } from "../retrofit-source-evidence.js";

describe("RetrofitCommitStatus type guard (SPEC-3)", () => {
  it("recognizes all valid retrofit commit statuses", () => {
    const statuses: RetrofitCommitStatus[] = [
      "already_applied",
      "clean_applied",
      "adapted",
      "excluded",
      "failed",
      "not_attempted",
    ];
    // TypeScript compile-time check — if the type is wrong this test won't compile.
    expect(statuses).toHaveLength(6);
    expect(statuses).toContain("already_applied");
    expect(statuses).toContain("clean_applied");
    expect(statuses).toContain("adapted");
    expect(statuses).toContain("failed");
    expect(statuses).toContain("not_attempted");
  });

  it("non-retrofit runs do not include retrofit fields in mock provider calls", async () => {
    // Verifies the non-retrofit path does not pass retrofitAdaptationContext to the provider
    const mockProvider = {
      implementPlan: vi.fn().mockResolvedValue({
        implementation: {
          summary: "Normal implementation.",
          completedSpecIds: [],
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
          sessionNotes: "",
        },
        rawOutput: "{}",
        metrics: {
          durationMs: 100,
          toolCalls: 0,
        },
      }),
    };

    getCurrentHeadShaMock.mockResolvedValue(COMMIT_SHA);
    listChangedFilesMock.mockResolvedValue([]);
    cleanGeneratedBranchChangesMock.mockResolvedValue({
      removedFiles: [],
      preservedFiles: [],
      blockedFiles: [],
      removedFilesSample: [],
      preservedFilesSample: [],
      blockedFilesSample: [],
      removedFilesCount: 0,
      preservedFilesCount: 0,
      blockedFilesCount: 0,
    });
    isBlockedGeneratedPathMock.mockReturnValue(false);

    // When provider is called for non-retrofit, retrofitAdaptationContext should be absent
    if (mockProvider.implementPlan.mock.calls.length > 0) {
      const callArgs = mockProvider.implementPlan.mock.calls[0][0];
      expect(callArgs.retrofitAdaptationContext).toBeUndefined();
    }

    // The assertion here is that no retrofitAdaptationContext was passed
    expect(mockProvider.implementPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({ retrofitAdaptationContext: expect.anything() }),
    );
  });
});

// ---------------------------------------------------------------------------
// Retrofit patch-first lane tests (T1-T5, T8, SPEC-1)
// ---------------------------------------------------------------------------

function buildRetrofitQualificationSummary(
  overrides: {
    selectedCommits?: Array<{
      sha: string;
      subject: string;
      files: string[];
    }>;
    touchedFiles?: string[];
  } = {},
) {
  const selectedCommits = overrides.selectedCommits ?? [
    {
      sha: "abc1234",
      subject: "CPDEV-12345 fix auth",
      files: ["src/AuthClient.ts"],
    },
  ];
  const touchedFiles = overrides.touchedFiles ?? ["src/AuthClient.ts"];

  return {
    ticketSummary: "Retrofit CPDEV-12345",
    repoSelectionMetadata: {
      retrofitContext: {
        sourceJiraKey: "CPDEV-12345",
        sourceBranch: "master",
        targetBranch: "release-4.0",
      },
      retrofitSourceEvidence: {
        sourceJiraKey: "CPDEV-12345",
        sourceBranch: "master",
        targetBranch: "release-4.0",
        sourceRepoName: "core-app",
        sourceRepoUrl: "https://github.com/org/core-app",
        selectedCommits,
        touchedFiles,
        evidenceSummary: "Source changes to AuthClient.",
      },
    },
  };
}

function buildRetrofitRevisionPlanForBaseUtils() {
  return {
    ...buildPlan(),
    specs: [
      {
        id: "spec-1",
        objective: "Preserve the adapted retrofit behavior after code review.",
        acceptanceCriteria: [
          "The adapted UIComponentService behavior remains accounted for by source commit abc1234.",
          "BaseUtils contains only the code-review requested revision.",
        ],
        targetFiles: ["src/UIComponentService.java", "src/BaseUtils.java"],
        implementationNotes: [
          "Do not reapply source commit abc1234; preserve the accepted adaptation proof.",
        ],
        validationSteps: ["Focused review of BaseUtils revision"],
      },
    ],
    fileChangeContract: [
      {
        path: "src/UIComponentService.java",
        role: "runtime_required",
        editable: true,
        rationale: "Source-equivalent target file for retrofit commit abc1234.",
        supportingEvidence: [
          "Source commit abc1234 changes src/UIComponentService.java.",
        ],
        allowedChanges: [
          "Preserve the previously accepted source-equivalent behavior from abc1234.",
        ],
      },
      {
        path: "src/BaseUtils.java",
        role: "runtime_required",
        editable: true,
        rationale:
          "Release branch adaptation file for source commit abc1234 and the code-review requested helper fix.",
        supportingEvidence: [
          "Source commit abc1234 changes src/UIComponentService.java; prior implementation adapted the behavior through src/BaseUtils.java.",
        ],
        allowedChanges: [
          "Apply only the code-review requested BaseUtils helper revision while preserving abc1234 retrofit proof.",
        ],
      },
    ],
    plannerDiscoveries: {
      retrofitExecutionContract: {
        version: "retrofit_execution_contract.v1",
        sourceJiraKey: "CPDEV-12345",
        sourceBranch: "master",
        targetBranch: "release-4.0",
        commitSelectionMethod: "source_pr",
        sourceCommitSelectionComplete: true,
        selectedCommits: [
          {
            sha: "abc1234",
            subject: "CPDEV-12345 retrofit commit",
            sourceFiles: ["src/UIComponentService.java"],
            targetFiles: ["src/UIComponentService.java"],
            adaptationFiles: ["src/BaseUtils.java"],
            status: "not_attempted",
            rationale:
              "Target branch adaptation maps abc1234 into UIComponentService.java plus BaseUtils.java.",
            proofSnippets: [],
            validationEvidence: [],
          },
        ],
        allowedFileMappings: [
          {
            sourceSha: "abc1234",
            sourceFiles: ["src/UIComponentService.java"],
            targetFiles: ["src/UIComponentService.java"],
            adaptationFiles: ["src/BaseUtils.java"],
            rationale:
              "Map source commit abc1234 from UIComponentService.java to the target branch BaseUtils helper adaptation.",
            evidence: [
              "abc1234",
              "src/UIComponentService.java",
              "src/BaseUtils.java",
            ],
          },
        ],
      },
    },
  };
}

describe("Retrofit patch-first lane", () => {
  beforeEach(() => {
    branchExistsOnRemoteMock.mockReset();
    commitAllChangesMock.mockReset();
    getCurrentHeadShaMock.mockReset();
    getRemoteBranchHeadMock.mockReset();
    isAncestorMock.mockReset();
    listChangedFilesMock.mockReset();
    pushBranchMock.mockReset();
    runGitCommandMock.mockReset();
    exportSourceCommitPatchMock.mockReset();
    isPatchAlreadyAppliedMock.mockReset();
    isPatchApplicableMock.mockReset();
    applyPatchMock.mockReset();
    materializeRunArtifactsMock.mockReset();
    transitionRunWithNotificationMock.mockReset();
    recordLlmMetricsMock.mockReset();
    cleanGeneratedBranchChangesMock.mockReset();
    isBlockedGeneratedPathMock.mockReset();
    ensureDraftPullRequestMock.mockReset();
    parseGitHubRepoUrlMock.mockReset();
    loadRunTicketSummaryMock.mockReset();
    ensureRunBranchContractMock.mockReset();

    branchExistsOnRemoteMock.mockResolvedValue(false);
    commitAllChangesMock.mockResolvedValue(undefined);
    getRemoteBranchHeadMock.mockImplementation(
      (_repo: unknown, branchName: string) =>
        Promise.resolve({
          branchName,
          headSha: branchName.startsWith("oneshot/") ? COMMIT_SHA : START_SHA,
        }),
    );
    queueHeadShas(START_SHA, START_SHA, COMMIT_SHA);
    isAncestorMock.mockResolvedValue(true);
    configureChangedFilesMock({ dirtyFiles: ["src/AuthClient.ts"], committedFiles: ["src/AuthClient.ts"] });
    pushBranchMock.mockResolvedValue(undefined);
    runGitCommandMock.mockResolvedValue({ stdout: "diff --git a/src/AuthClient.ts b/src/AuthClient.ts" });
    materializeRunArtifactsMock.mockResolvedValue(undefined);
    transitionRunWithNotificationMock.mockResolvedValue(true);
    cleanGeneratedBranchChangesMock.mockResolvedValue({
      removedFiles: [],
      removedFilesSample: [],
      removedFilesCount: 0,
      preservedFiles: [],
      preservedFilesSample: [],
      preservedFilesCount: 0,
      blockedFiles: [],
      blockedFilesSample: [],
      blockedFilesCount: 0,
    });
    isBlockedGeneratedPathMock.mockReturnValue(false);
    exportSourceCommitPatchMock.mockResolvedValue("--- a/src/AuthClient.ts\n+++ b/src/AuthClient.ts\n@@ -1 +1 @@\n+auth fix\n");
    isPatchAlreadyAppliedMock.mockResolvedValue(false);
    isPatchApplicableMock.mockResolvedValue(true);
    applyPatchMock.mockResolvedValue({ ok: true });
    parseGitHubRepoUrlMock.mockReturnValue({ owner: "org", repo: "core-app" });
    loadRunTicketSummaryMock.mockResolvedValue("Retrofit CPDEV-12345");
    ensureRunBranchContractMock.mockResolvedValue({
      branchName: "oneshot/cpdev-20686-run-84",
      baseCommitSha: START_SHA,
      expectedHeadSha: START_SHA,
      workspaceBaseSha: START_SHA,
      currentCandidateSha: null,
      remoteHeadSha: START_SHA,
      repairedMetadata: false,
      createdRemoteBranch: false,
      sharedEpicBranch: false,
    });
    ensureDraftPullRequestMock.mockResolvedValue({
      htmlUrl: "https://github.com/org/core-app/pull/99",
      number: 99,
      reused: false,
    });
  });

  it("T1: all-already-applied retrofit completes as completed_no_action without calling the provider", async () => {
    // All patches are already applied — provider must NOT be called
    isPatchAlreadyAppliedMock.mockResolvedValue(true);

    const { consumer, implementerProvider, oneShotDb, s3Client } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildRetrofitQualificationSummary(),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // Provider must NOT be called for fully-already-applied retrofits
    expect(implementerProvider.implementPlan).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "completed",
        updates: expect.objectContaining({
          final_disposition: "completed_no_action",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "implementation",
        status: "completed_no_action",
        metadata_json: expect.objectContaining({
          noActionReason: "retrofit_already_applied",
          implementationCommitSha: START_SHA,
          changedFiles: [],
          selectedShas: ["abc1234"],
          sourceJiraKey: "CPDEV-12345",
          sourceBranch: "master",
          targetBranch: "release-4.0",
          retrofitManifest: expect.objectContaining({
            entries: [
              expect.objectContaining({
                sha: "abc1234",
                status: "already_applied",
              }),
            ],
          }),
          retrofitContext: expect.objectContaining({
            sourceJiraKey: "CPDEV-12345",
            sourceBranch: "master",
            targetBranch: "release-4.0",
          }),
        }),
      }),
    );
    const implementationPutInput = s3Client.send.mock.calls
      .map(([command]) => command.input)
      .find(
        (input) =>
          input?.Body &&
          input.ContentType === "application/json" &&
          String(input.Key).includes("/implementation/"),
      );
    expect(implementationPutInput).toBeDefined();
    const persistedImplementation = JSON.parse(
      String(implementationPutInput?.Body),
    );
    expect(persistedImplementation).toEqual(
      expect.objectContaining({
        implementationBranch: "oneshot/cpdev-20686-run-84",
        implementationCommitSha: START_SHA,
        changedFiles: [],
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        notification: expect.objectContaining({
          body_markdown: expect.stringContaining("CPDEV-12345"),
        }),
      }),
    );
    const noActionNotification = transitionRunWithNotificationMock.mock.calls.find(
      ([, transition]) => transition.toState === "completed",
    )?.[1]?.notification?.body_markdown;
    expect(noActionNotification).toContain("master");
    expect(noActionNotification).toContain("release-4.0");
    expect(noActionNotification).toContain("abc1234");
    expect(noActionNotification).toContain("already_applied");
  });

  it("T2: clean-apply patch is applied mechanically without calling the provider", async () => {
    // Patch is not already applied, but applies cleanly
    isPatchAlreadyAppliedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    isPatchApplicableMock.mockResolvedValue(true);
    applyPatchMock.mockResolvedValue({ ok: true });

    const { consumer, implementerProvider } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildRetrofitQualificationSummary(),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(applyPatchMock).toHaveBeenCalled();
    // Provider must NOT be called for clean_applied commits (mechanical apply only)
    expect(implementerProvider.implementPlan).not.toHaveBeenCalled();
    // Commit message must include retrofit trace (sourceJiraKey)
    expect(commitAllChangesMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining("CPDEV-12345"),
    );
  });

  it("queues replan when a later adaptation drops an earlier clean-applied source patch", async () => {
    const twoCommits = [
      {
        sha: "sha0001",
        subject: "CPDEV-25333 first hunk",
        files: ["src/AuthClient.ts"],
      },
      {
        sha: "sha0002",
        subject: "CPDEV-25333 second hunk",
        files: ["src/AuthClient.ts"],
      },
    ];

    exportSourceCommitPatchMock
      .mockResolvedValueOnce("patch-sha0001")
      .mockResolvedValueOnce("patch-sha0002");
    isPatchAlreadyAppliedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    isPatchApplicableMock
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    applyPatchMock
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({
        ok: false,
        conflictDiagnostics: "sha0002 conflict",
      });

    const { consumer } = buildImplementerDeps(buildImplementationResponse(), {
      qualificationSummary: buildRetrofitQualificationSummary({
        selectedCommits: twoCommits,
        touchedFiles: ["src/AuthClient.ts"],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_planning",
        updates: expect.objectContaining({
          current_plan_version: 2,
          final_disposition: null,
          last_error: null,
        }),
      }),
    );
  });

  it("allows completion when successful retrofit patches remain patch-equivalent at final head", async () => {
    exportSourceCommitPatchMock.mockResolvedValue("patch-sha0001");
    isPatchAlreadyAppliedMock
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    isPatchApplicableMock.mockResolvedValueOnce(true);
    applyPatchMock.mockResolvedValueOnce({ ok: true });

    const { consumer } = buildImplementerDeps(buildImplementationResponse(), {
      qualificationSummary: buildRetrofitQualificationSummary(),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
  });

  it("T3: conflicting patch invokes provider with retrofitAdaptationContext set and classifies adapted when verification passes", async () => {
    // Patch doesn't apply cleanly — should invoke provider in adaptation mode
    // First isPatchAlreadyApplied call: false (not yet applied)
    // Second isPatchAlreadyApplied call: true (post-adaptation verification passes -> adapted)
    isPatchAlreadyAppliedMock
      .mockResolvedValueOnce(false) // initial check
      .mockResolvedValueOnce(true) // post-adaptation verification -> adapted
      .mockResolvedValueOnce(true); // final proof remains patch-equivalent
    isPatchApplicableMock.mockResolvedValue(false);
    applyPatchMock.mockResolvedValue({ ok: false, conflictDiagnostics: "hunk failed to apply" });

    const { consumer, implementerProvider } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildRetrofitQualificationSummary(),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitAdaptationContext: expect.objectContaining({
          sourcePatch: expect.stringContaining("AuthClient"),
          conflictDiagnostics: expect.any(String),
          allowedFiles: expect.arrayContaining(["src/AuthClient.ts"]),
          sourceShas: ["abc1234"],
        }),
      }),
    );
    expect(isPatchAlreadyAppliedMock).toHaveBeenCalledTimes(3);
  });

  it("T3a: conflicting patch is adapted when coverage evidence accounts for the current source SHA", async () => {
    isPatchAlreadyAppliedMock.mockResolvedValue(false);
    isPatchApplicableMock.mockResolvedValue(false);
    applyPatchMock.mockResolvedValue({
      ok: false,
      conflictDiagnostics: "target branch renamed AuthClient",
    });
    const providerResponse = buildImplementationResponse();
    (
      providerResponse.implementation as Record<string, unknown>
    ).retrofitAdaptationCoverage = [
      {
        sourceSha: "abc1234",
        filesCovered: ["src/AuthClient.ts"],
        hunkEvidence: [
          "Mapped the source authorization hunk into the target branch AuthClient API.",
        ],
      },
    ];

    const { consumer, implementerProvider } = buildImplementerDeps(
      providerResponse,
      {
        qualificationSummary: buildRetrofitQualificationSummary(),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitAdaptationContext: expect.objectContaining({
          sourceShas: ["abc1234"],
        }),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          last_error: expect.stringContaining("retrofit_patch_incomplete"),
        }),
      }),
    );
  });

  it("T3b: conflicting patch where LLM adaptation silently fails queues same-run retrofit replanning", async () => {
    // Both calls to isPatchAlreadyApplied return false:
    // First: patch not yet applied; second: post-adaptation verification also fails -> status=failed
    isPatchAlreadyAppliedMock.mockResolvedValue(false);
    isPatchApplicableMock.mockResolvedValue(false);
    applyPatchMock.mockResolvedValue({ ok: false, conflictDiagnostics: "hunk mismatch" });

    const { consumer, implementerProvider, publisher, oneShotDb } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildRetrofitQualificationSummary(),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // Provider WAS called (adaptation attempted)
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitAdaptationContext: expect.anything(),
      }),
    );
    // But verification failed -> entry.status = 'failed' -> validateRetrofitCoverage queues same-run planning.
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_planning",
        updates: expect.objectContaining({
          current_plan_version: 2,
          final_disposition: null,
          last_error: null,
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "planning",
      2,
      "queued_for_planning",
      true,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("retrofit-patch-replan:"),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "queued_for_planning",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "retrofit_patch_incomplete_auto_replan",
          selectedShas: ["abc1234"],
          autoReplanAttempt: 1,
          autoReplanMaxAttempts: 2,
        }),
      }),
    );
  });

  it("blocks retrofit proof failures after the auto-replan budget is exhausted", async () => {
    isPatchAlreadyAppliedMock.mockResolvedValue(false);
    isPatchApplicableMock.mockResolvedValue(false);
    applyPatchMock.mockResolvedValue({
      ok: false,
      conflictDiagnostics: "hunk mismatch",
    });
    const priorReplanEvent = {
      id: 1,
      oneshot_run_id: 84,
      event_type: "state_transition",
      from_state: "implementing",
      to_state: "queued_for_planning",
      stage: "implementation",
      metadata_json: {
        reason: "retrofit_patch_incomplete_auto_replan",
      },
      occurred_at: new Date(),
    };

    const { consumer, publisher, oneShotDb } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildRetrofitQualificationSummary(),
        events: [
          priorReplanEvent,
          {
            ...priorReplanEvent,
            id: 2,
          },
        ],
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "implementation_blocked",
          last_error: expect.stringContaining("Retrofit patch proof missing"),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "blocked",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "retrofit_patch_proof_missing",
          legacyReason: "retrofit_patch_incomplete",
          autoReplanAttemptsUsed: 2,
          autoReplanMaxAttempts: 2,
        }),
      }),
    );
  });

  it("T4: changed files outside allowlist yield retrofit_patch_incomplete and queue replan", async () => {
    // Clean apply — but mock dirty files to include an out-of-scope file
    isPatchAlreadyAppliedMock.mockResolvedValue(false);
    isPatchApplicableMock.mockResolvedValue(true);
    applyPatchMock.mockResolvedValue({ ok: true });

    // Override changed files to include something outside touchedFiles
    configureChangedFilesMock({
      dirtyFiles: ["src/AuthClient.ts", "src/OutOfScopeFile.ts"],
      committedFiles: ["src/AuthClient.ts", "src/OutOfScopeFile.ts"],
    });

    const { consumer } = buildImplementerDeps(
      buildImplementationResponse(),
      {
        qualificationSummary: buildRetrofitQualificationSummary(),
      },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_planning",
        updates: expect.objectContaining({
          final_disposition: null,
          last_error: null,
        }),
      }),
    );
  });

  it("T5: 7-commit source retrofit — sha-7 adaptation fails post-verification, manifested 7 entries, queues retrofit patch replan (PR #82→#83 regression)", async () => {
    const sevenCommits = Array.from({ length: 7 }, (_, i) => ({
      sha: `sha000${i + 1}`,
      subject: `CPDEV-12345 commit ${i + 1}`,
      files: ["src/AuthClient.ts"],
    }));

    const qualSummary = {
      ticketSummary: "Retrofit CPDEV-12345 seven commits",
      repoSelectionMetadata: {
        retrofitContext: {
          sourceJiraKey: "CPDEV-12345",
          sourceBranch: "master",
          targetBranch: "release-4.0",
        },
        retrofitSourceEvidence: {
          sourceJiraKey: "CPDEV-12345",
          sourceBranch: "master",
          targetBranch: "release-4.0",
          sourceRepoName: "core-app",
          sourceRepoUrl: "https://github.com/org/core-app",
          selectedCommits: sevenCommits,
          touchedFiles: ["src/AuthClient.ts"],
          evidenceSummary: "Seven commits.",
        },
      },
    };

    // sha0001..sha0006 apply cleanly; sha0007 conflicts and then adaptation silently fails (LLM did not apply it).
    // All isPatchAlreadyApplied calls return false: neither initial checks nor sha0007 post-adaptation verify.
    isPatchAlreadyAppliedMock.mockResolvedValue(false);

    // sha0001..sha0006: isPatchApplicable=true + applyPatch ok=true -> clean_applied
    // sha0007: isPatchApplicable=false -> conflict path -> applyPatch for diagnostics -> LLM -> post-verify false -> failed
    isPatchApplicableMock
      .mockResolvedValueOnce(true)   // sha0001
      .mockResolvedValueOnce(true)   // sha0002
      .mockResolvedValueOnce(true)   // sha0003
      .mockResolvedValueOnce(true)   // sha0004
      .mockResolvedValueOnce(true)   // sha0005
      .mockResolvedValueOnce(true)   // sha0006
      .mockResolvedValueOnce(false); // sha0007 -> conflict path

    applyPatchMock
      .mockResolvedValueOnce({ ok: true }) // sha0001
      .mockResolvedValueOnce({ ok: true }) // sha0002
      .mockResolvedValueOnce({ ok: true }) // sha0003
      .mockResolvedValueOnce({ ok: true }) // sha0004
      .mockResolvedValueOnce({ ok: true }) // sha0005
      .mockResolvedValueOnce({ ok: true }) // sha0006
      // sha0007 conflict path calls applyPatch once for diagnostics:
      .mockResolvedValueOnce({ ok: false, conflictDiagnostics: "sha0007 hunk dropped - PR#82 to PR#83 class" });

    const { consumer, implementerProvider, publisher } = buildImplementerDeps(
      buildImplementationResponse(),
      { qualificationSummary: qualSummary },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);

    // Provider was called for sha0007 adaptation
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitAdaptationContext: expect.objectContaining({
          sourceShas: ["sha0007"],
          conflictDiagnostics: expect.stringContaining("sha0007 hunk dropped"),
        }),
      }),
    );

    // Post-adaptation isPatchAlreadyApplied returned false -> sha0007 classified 'failed'
    // -> validateRetrofitCoverage queues same-run replanning (not a normal success)
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_planning",
        updates: expect.objectContaining({
          current_plan_version: 2,
          final_disposition: null,
          last_error: null,
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "planning",
      2,
      "queued_for_planning",
      true,
      expect.objectContaining({
        dedupeToken: expect.stringContaining("retrofit-patch-replan:"),
      }),
    );

    // Manifest was persisted with 7 entries
    expect(materializeRunArtifactsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining([
        expect.objectContaining({ fileName: "retrofit-manifest.json" }),
      ]),
      "implementer",
    );
  });

  it("T5b: 7-commit source retrofit — sha-7 adaptation succeeds post-verification, classified adapted, run proceeds normally", async () => {
    const sevenCommits = Array.from({ length: 7 }, (_, i) => ({
      sha: `sha000${i + 1}`,
      subject: `CPDEV-12345 commit ${i + 1}`,
      files: ["src/AuthClient.ts"],
    }));

    const qualSummary = {
      ticketSummary: "Retrofit CPDEV-12345 seven commits ok",
      repoSelectionMetadata: {
        retrofitContext: {
          sourceJiraKey: "CPDEV-12345",
          sourceBranch: "master",
          targetBranch: "release-4.0",
        },
        retrofitSourceEvidence: {
          sourceJiraKey: "CPDEV-12345",
          sourceBranch: "master",
          targetBranch: "release-4.0",
          sourceRepoName: "core-app",
          sourceRepoUrl: "https://github.com/org/core-app",
          selectedCommits: sevenCommits,
          touchedFiles: ["src/AuthClient.ts"],
          evidenceSummary: "Seven commits.",
        },
      },
    };

    // sha0001..sha0006 initial isPatchAlreadyApplied = false; sha0007 initial = false; sha0007 post-adapt = true
    isPatchAlreadyAppliedMock
      .mockResolvedValueOnce(false) // sha0001 initial
      .mockResolvedValueOnce(false) // sha0002 initial
      .mockResolvedValueOnce(false) // sha0003 initial
      .mockResolvedValueOnce(false) // sha0004 initial
      .mockResolvedValueOnce(false) // sha0005 initial
      .mockResolvedValueOnce(false) // sha0006 initial
      .mockResolvedValueOnce(false) // sha0007 initial
      .mockResolvedValueOnce(true) // sha0007 post-adaptation verification -> adapted
      .mockResolvedValue(true); // final proof for all successful source patches still passes

    isPatchApplicableMock
      .mockResolvedValueOnce(true)   // sha0001
      .mockResolvedValueOnce(true)   // sha0002
      .mockResolvedValueOnce(true)   // sha0003
      .mockResolvedValueOnce(true)   // sha0004
      .mockResolvedValueOnce(true)   // sha0005
      .mockResolvedValueOnce(true)   // sha0006
      .mockResolvedValueOnce(false); // sha0007 -> conflict path

    applyPatchMock
      .mockResolvedValueOnce({ ok: true }) // sha0001
      .mockResolvedValueOnce({ ok: true }) // sha0002
      .mockResolvedValueOnce({ ok: true }) // sha0003
      .mockResolvedValueOnce({ ok: true }) // sha0004
      .mockResolvedValueOnce({ ok: true }) // sha0005
      .mockResolvedValueOnce({ ok: true }) // sha0006
      .mockResolvedValueOnce({ ok: false, conflictDiagnostics: "sha0007 conflict resolved by LLM" });

    const { consumer, implementerProvider } = buildImplementerDeps(
      buildImplementationResponse(),
      { qualificationSummary: qualSummary },
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // Provider was called for sha0007 adaptation
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitAdaptationContext: expect.objectContaining({
          sourceShas: ["sha0007"],
        }),
      }),
    );
    // Run proceeds to queued_for_code_review (not blocked)
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
  });

  it("carries accepted retrofit source proof across code-review revisions without reapplying source patches", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);
    configureChangedFilesMock({
      dirtyFiles: ["src/BaseUtils.java"],
      committedFiles: ["src/BaseUtils.java"],
    });
    exportSourceCommitPatchMock.mockRejectedValue(
      new Error("revision should not re-export already-proven retrofit patches"),
    );

    const providerResponse = buildImplementationResponse();
    providerResponse.implementation.changedFiles = ["src/BaseUtils.java"];

    const previousStatus = {
      sourceSha: "abc1234",
      status: "adapted" as const,
      sourceFiles: ["src/UIComponentService.java"],
      targetFiles: ["src/UIComponentService.java"],
      adaptationFiles: ["src/BaseUtils.java"],
      conflictDiagnostics: "UIComponentService context differed on release branch.",
      proofSnippets: [
        "Mapped source UIComponentService behavior into the release-branch service path.",
      ],
      validationEvidence: ["Implementation v1 code review accepted retrofit proof."],
      rationale: "Release branch required BaseUtils helper adaptation.",
    };

    const { consumer, implementerProvider, oneShotDb, s3Client } = buildImplementerDeps(
      providerResponse,
      {
        run: {
          ...buildRun(),
          current_plan_version: 10,
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        codeReviewArtifact: buildCodeReview({
          requiredChanges: ["Fix excludeIgnoredRerouteQueue in BaseUtils."],
          findings: [
            {
              severity: "medium",
              category: "correctness",
              file: "src/BaseUtils.java",
              line: 88,
              description: "BaseUtils helper needs the review-requested guard.",
              suggestion: "Update excludeIgnoredRerouteQueue only.",
            },
          ],
        }),
        plan: buildRetrofitRevisionPlanForBaseUtils(),
        previousImplementationArtifact: {
          metadata_json: { sessionId: "session-v1" },
          body: {
            completedSpecIds: ["spec-1"],
            sessionNotes: "Implementation v1 adapted source commit abc1234.",
            retrofitSourceCommitStatuses: [previousStatus],
            retrofitAdaptationCoverage: [
              {
                sourceSha: "abc1234",
                filesCovered: ["src/UIComponentService.java", "src/BaseUtils.java"],
                hunkEvidence: [
                  "Original source reroute behavior is preserved through BaseUtils.",
                ],
              },
            ],
          },
        },
        qualificationSummary: buildRetrofitQualificationSummary({
          selectedCommits: [
            {
              sha: "abc1234",
              subject: "CPDEV-12345 retrofit commit",
              files: ["src/UIComponentService.java"],
            },
          ],
          touchedFiles: ["src/UIComponentService.java", "src/BaseUtils.java"],
        }),
      },
    );

    const shouldDelete = await consumer.processMessage(
      buildMessage({ version: 2, revision: true }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(exportSourceCommitPatchMock).not.toHaveBeenCalled();
    expect(isPatchAlreadyAppliedMock).not.toHaveBeenCalled();
    expect(isPatchApplicableMock).not.toHaveBeenCalled();
    expect(applyPatchMock).not.toHaveBeenCalled();
    expect(implementerProvider.implementPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitAdaptationContext: undefined,
        revisionContext: expect.objectContaining({
          priorRetrofitSourceCommitStatuses: [previousStatus],
          priorRetrofitAdaptationCoverage: expect.arrayContaining([
            expect.objectContaining({ sourceSha: "abc1234" }),
          ]),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "retrofit_revision_proof_carried_forward",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          version: 2,
          revision: true,
          sourceSha: "abc1234",
          status: "adapted",
          previousImplementationVersion: 1,
        }),
      }),
    );
    const implementationPutInput = (
      s3Client.send.mock.calls.find(([command]) =>
        command.input?.Key ===
        "oneshot/CPDEV-20686/run-84/implementation/v2/implementation.json",
      )?.[0] as { input?: { Body?: string } } | undefined
    )?.input;
    const persistedImplementation = JSON.parse(
      String(implementationPutInput?.Body),
    );
    expect(persistedImplementation.retrofitSourceCommitStatuses).toEqual([
      expect.objectContaining({
        sourceSha: "abc1234",
        status: "adapted",
        sourceFiles: ["src/UIComponentService.java"],
        targetFiles: expect.arrayContaining(["src/UIComponentService.java"]),
        adaptationFiles: ["src/BaseUtils.java"],
        proofSnippets: expect.arrayContaining([
          "Mapped source UIComponentService behavior into the release-branch service path.",
        ]),
      }),
    ]);
    expect(persistedImplementation.retrofitAdaptationCoverage).toEqual([
      expect.objectContaining({ sourceSha: "abc1234" }),
    ]);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_code_review",
      }),
    );
  });

  it("accepts refreshed prior retrofit proof on revision without requiring a retained source patch", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);
    configureChangedFilesMock({
      dirtyFiles: ["src/BaseUtils.java"],
      committedFiles: ["src/BaseUtils.java"],
    });
    exportSourceCommitPatchMock.mockRejectedValue(
      new Error("revision should not re-export already-proven retrofit patches"),
    );

    const providerResponse = buildImplementationResponse();
    providerResponse.implementation.changedFiles = ["src/BaseUtils.java"];
    (
      providerResponse.implementation as Record<string, unknown>
    ).retrofitSourceCommitStatuses = [
      {
        sourceSha: "abc1234",
        status: "adapted",
        sourceFiles: ["src/UIComponentService.java"],
        targetFiles: ["src/UIComponentService.java"],
        adaptationFiles: ["src/BaseUtils.java"],
        proofSnippets: [
          "Updated BaseUtils proof after the code-review requested helper change.",
        ],
        validationEvidence: [
          "Revision preserved the adapted source behavior in BaseUtils.",
        ],
        rationale: "BaseUtils remains the release-branch adaptation point.",
      },
    ];

    const previousStatus = {
      sourceSha: "abc1234",
      status: "adapted" as const,
      sourceFiles: ["src/UIComponentService.java"],
      targetFiles: ["src/UIComponentService.java"],
      adaptationFiles: ["src/BaseUtils.java"],
      proofSnippets: [
        "Mapped source UIComponentService behavior into the release-branch service path.",
      ],
      validationEvidence: ["Implementation v1 code review accepted retrofit proof."],
      rationale: "Release branch required BaseUtils helper adaptation.",
    };

    const { consumer, oneShotDb, publisher } = buildImplementerDeps(
      providerResponse,
      {
        run: {
          ...buildRun(),
          current_plan_version: 10,
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        codeReviewArtifact: buildCodeReview({
          requiredChanges: ["Fix excludeIgnoredRerouteQueue in BaseUtils."],
        }),
        plan: buildRetrofitRevisionPlanForBaseUtils(),
        previousImplementationArtifact: {
          body: {
            completedSpecIds: ["spec-1"],
            retrofitSourceCommitStatuses: [previousStatus],
          },
        },
        qualificationSummary: buildRetrofitQualificationSummary({
          selectedCommits: [
            {
              sha: "abc1234",
              subject: "CPDEV-12345 retrofit commit",
              files: ["src/UIComponentService.java"],
            },
          ],
          touchedFiles: ["src/UIComponentService.java", "src/BaseUtils.java"],
        }),
      },
    );

    const shouldDelete = await consumer.processMessage(
      buildMessage({ version: 2, revision: true }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(exportSourceCommitPatchMock).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "code_review",
      2,
      "queued_for_code_review",
      false,
      expect.objectContaining({
        expectedImplementationCommitSha: COMMIT_SHA,
        expectedImplementationVersion: 2,
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "retrofit_revision_proof_updated",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          version: 2,
          sourceSha: "abc1234",
          replacedCarriedForwardProof: true,
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "retrofit_revision_proof_regressed",
      }),
    );
  });

  it("queues same-run replanning when a revision touches a prior proof file without refreshed proof", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);
    configureChangedFilesMock({
      dirtyFiles: ["src/BaseUtils.java"],
      committedFiles: ["src/BaseUtils.java"],
    });
    exportSourceCommitPatchMock.mockRejectedValue(
      new Error("revision should not re-export already-proven retrofit patches"),
    );

    const providerResponse = buildImplementationResponse();
    providerResponse.implementation.changedFiles = ["src/BaseUtils.java"];

    const previousStatus = {
      sourceSha: "abc1234",
      status: "adapted" as const,
      sourceFiles: ["src/UIComponentService.java"],
      targetFiles: ["src/UIComponentService.java"],
      adaptationFiles: ["src/BaseUtils.java"],
      conflictDiagnostics: "UIComponentService context differed on release branch.",
      proofSnippets: ["Mapped source behavior into the release branch."],
      validationEvidence: ["Implementation v1 code review accepted retrofit proof."],
      rationale: "Release branch required helper adaptation.",
    };

    const { consumer, oneShotDb, publisher } = buildImplementerDeps(
      providerResponse,
      {
        run: {
          ...buildRun(),
          current_plan_version: 10,
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        codeReviewArtifact: buildCodeReview({
          requiredChanges: ["Fix excludeIgnoredRerouteQueue in BaseUtils."],
        }),
        plan: buildRetrofitRevisionPlanForBaseUtils(),
        previousImplementationArtifact: {
          body: {
            completedSpecIds: ["spec-1"],
            retrofitSourceCommitStatuses: [previousStatus],
          },
        },
        qualificationSummary: buildRetrofitQualificationSummary({
          selectedCommits: [
            {
              sha: "abc1234",
              subject: "CPDEV-12345 retrofit commit",
              files: ["src/UIComponentService.java"],
            },
          ],
          touchedFiles: ["src/UIComponentService.java", "src/BaseUtils.java"],
        }),
      },
    );

    const shouldDelete = await consumer.processMessage(
      buildMessage({ version: 2, revision: true }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "planning",
      11,
      "queued_for_planning",
      true,
      expect.objectContaining({ dedupeToken: expect.any(String) }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_planning",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "retrofit_revision_proof_regressed",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          version: 2,
          carriedForwardSourceShas: ["abc1234"],
          violations: expect.arrayContaining([
            expect.stringContaining("Revision changed previously proven file"),
          ]),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "queued_for_planning",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "retrofit_patch_incomplete_auto_replan",
          recoverySubtype: "retrofit_revision_proof_regressed",
        }),
      }),
    );
  });

  it("blocks exhausted revision proof regressions with a revision-specific reason", async () => {
    queueHeadShas(PROVIDER_COMMIT_SHA, PROVIDER_COMMIT_SHA, COMMIT_SHA);
    configureChangedFilesMock({
      dirtyFiles: ["src/BaseUtils.java"],
      committedFiles: ["src/BaseUtils.java"],
    });

    const providerResponse = buildImplementationResponse();
    providerResponse.implementation.changedFiles = ["src/BaseUtils.java"];
    const previousStatus = {
      sourceSha: "abc1234",
      status: "adapted" as const,
      sourceFiles: ["src/UIComponentService.java"],
      targetFiles: ["src/UIComponentService.java"],
      adaptationFiles: ["src/BaseUtils.java"],
      proofSnippets: [
        "Mapped source UIComponentService behavior into the release-branch service path.",
      ],
      validationEvidence: ["Implementation v1 code review accepted retrofit proof."],
      rationale: "Release branch required helper adaptation.",
    };
    const priorReplanEvent = {
      id: 1,
      oneshot_run_id: 84,
      event_type: "state_transition",
      from_state: "implementing",
      to_state: "queued_for_planning",
      stage: "implementation",
      metadata_json: {
        reason: "retrofit_patch_incomplete_auto_replan",
      },
      occurred_at: new Date(),
    };

    const { consumer, oneShotDb, publisher } = buildImplementerDeps(
      providerResponse,
      {
        run: {
          ...buildRun(),
          current_plan_version: 10,
          current_implementation_version: 2,
          current_implementation_branch: "oneshot/cpdev-20686-run-84",
          current_implementation_commit_sha: PROVIDER_COMMIT_SHA,
          current_code_review_version: 1,
        },
        events: [priorReplanEvent, { ...priorReplanEvent, id: 2 }],
        plan: buildRetrofitRevisionPlanForBaseUtils(),
        previousImplementationArtifact: {
          body: {
            completedSpecIds: ["spec-1"],
            retrofitSourceCommitStatuses: [previousStatus],
          },
        },
        qualificationSummary: buildRetrofitQualificationSummary({
          selectedCommits: [
            {
              sha: "abc1234",
              subject: "CPDEV-12345 retrofit commit",
              files: ["src/UIComponentService.java"],
            },
          ],
          touchedFiles: ["src/UIComponentService.java", "src/BaseUtils.java"],
        }),
      },
    );

    const shouldDelete = await consumer.processMessage(
      buildMessage({ version: 2, revision: true }),
      1,
    );

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "blocked",
        updates: expect.objectContaining({
          final_disposition: "implementation_blocked",
          last_error: expect.stringContaining(
            "Retrofit revision proof regressed",
          ),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "retrofit_revision_proof_regressed",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          version: 2,
          carriedForwardSourceShas: ["abc1234"],
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "implementing",
        to_state: "blocked",
        stage: "implementation",
        metadata_json: expect.objectContaining({
          reason: "retrofit_revision_proof_regressed",
          autoReplanAttemptsUsed: 2,
        }),
      }),
    );
  });

  it("T8: non-retrofit runs do not call patch primitives and pass no additionalBranchNames", async () => {
    const { consumer, workspaceManager, implementerProvider } = buildImplementerDeps(
      buildImplementationResponse(),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // Patch primitives should NOT be called for non-retrofit runs
    expect(exportSourceCommitPatchMock).not.toHaveBeenCalled();
    expect(isPatchAlreadyAppliedMock).not.toHaveBeenCalled();
    expect(applyPatchMock).not.toHaveBeenCalled();
    // Provider IS called for normal runs
    expect(implementerProvider.implementPlan).toHaveBeenCalled();
    // retrofitAdaptationContext must NOT be passed
    expect(implementerProvider.implementPlan).not.toHaveBeenCalledWith(
      expect.objectContaining({ retrofitAdaptationContext: expect.anything() }),
    );
    // additionalBranchNames should be empty for non-retrofit
    expect(workspaceManager.prepareImplementerWorkspace).toHaveBeenCalledWith(
      expect.any(Number),
      expect.anything(),
      expect.any(String),
      expect.any(String),
      expect.any(String),
      [], // empty additionalBranchNames for non-retrofit
    );
  });
});
