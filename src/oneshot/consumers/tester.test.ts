import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@aws-sdk/client-sqs";
import type { OneShotConsumerConfig } from "../config.js";
import type { OneShotRun } from "../types.js";

const {
  resolveTestCommandsMock,
  executeTestCommandMock,
  executeGitDiffCheckMock,
  executeValidationCheckMock,
  captureTestReportSnapshotMock,
  findAndParseTestReportsMock,
  findAndParseCoverageMock,
  transitionRunWithNotificationMock,
  withOneShotTransactionMock,
  ensureDraftPullRequestMock,
  fetchCommitStatusSummaryMock,
  parseGitHubRepoUrlMock,
  verificationLoopCounterAddMock,
  getCurrentHeadShaMock,
  ensureRunBranchContractMock,
} = vi.hoisted(() => ({
  resolveTestCommandsMock: vi.fn(),
  executeTestCommandMock: vi.fn(),
  executeGitDiffCheckMock: vi.fn(),
  executeValidationCheckMock: vi.fn(),
  captureTestReportSnapshotMock: vi.fn(),
  findAndParseTestReportsMock: vi.fn(),
  findAndParseCoverageMock: vi.fn(),
  transitionRunWithNotificationMock: vi.fn(),
  withOneShotTransactionMock: vi.fn(),
  ensureDraftPullRequestMock: vi.fn(),
  fetchCommitStatusSummaryMock: vi.fn(),
  parseGitHubRepoUrlMock: vi.fn(),
  verificationLoopCounterAddMock: vi.fn(),
  getCurrentHeadShaMock: vi.fn(),
  ensureRunBranchContractMock: vi.fn().mockResolvedValue({
    branchName: "oneshot/cpdev-21090-run-84",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    expectedHeadSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    workspaceBaseSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    currentCandidateSha: null,
    remoteHeadSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    repairedMetadata: false,
    createdRemoteBranch: false,
    sharedEpicBranch: false,
  }),
}));

vi.mock("../test-executor.js", async () => {
  const actual = await vi.importActual<typeof import("../test-executor.js")>(
    "../test-executor.js",
  );

  return {
    ...actual,
    resolveTestCommands: resolveTestCommandsMock,
    executeTestCommand: executeTestCommandMock,
    executeGitDiffCheck: executeGitDiffCheckMock,
    executeValidationCheck: executeValidationCheckMock,
    captureTestReportSnapshot: captureTestReportSnapshotMock,
    findAndParseTestReports: findAndParseTestReportsMock,
    findAndParseCoverage: findAndParseCoverageMock,
  };
});

vi.mock("../state-transitions.js", () => ({
  buildPostmortemContext: vi.fn().mockReturnValue({}),
  transitionRunWithNotification: transitionRunWithNotificationMock,
  withOneShotTransaction: withOneShotTransactionMock,
}));

vi.mock("../github.js", () => ({
  ensureDraftPullRequest: ensureDraftPullRequestMock,
  fetchCommitStatusSummary: fetchCommitStatusSummaryMock,
  parseGitHubRepoUrl: parseGitHubRepoUrlMock,
}));

vi.mock("../telemetry/metrics.js", () => ({
  verificationLoopCounter: {
    add: verificationLoopCounterAddMock,
  },
  candidateShaMismatchCounter: {
    add: vi.fn(),
  },
}));

vi.mock("../git.js", () => ({
  getCurrentHeadSha: getCurrentHeadShaMock,
}));

vi.mock("../run-branch-contract.js", () => ({
  ensureRunBranchContract: ensureRunBranchContractMock,
}));

import { TesterConsumer } from "./tester.js";

class TestableTesterConsumer extends TesterConsumer {
  async processMessage(
    message: Message,
    receiveCount: number,
  ): Promise<boolean> {
    return this.handleMessage(message, receiveCount);
  }
}

const config: OneShotConsumerConfig = {
  role: "TESTER",
  region: "us-east-1",
  artifactBucket: "artifact-bucket",
  artifactPrefix: "oneshot",
  maxReviewLoops: 3,
  maxVerificationLoops: 3,
  maxTotalTokens: 10_000_000,
  maxStageTokens: {
    planning: 2_000_000,
    review: 2_000_000,
    implementation: 2_000_000,
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
  mavenBuildsEnabled: true,
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

function buildRun(overrides?: Partial<OneShotRun>): OneShotRun {
  const now = new Date();

  return {
    id: 84,
    run_group_id: null,
    workspace_mode: "v2",
    jira_key: "CPDEV-21090",
    source_task_management_id: 7,
    customer_id: 1,
    repo_id: 11,
    branch_name: "master",
    base_commit_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_name: "oneshot/cpdev-21090-run-84",
    run_branch_base_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_created_at: now,
    state: "queued_for_testing",
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: 1,
    current_review_version: 1,
    current_implementation_version: 2,
    current_implementation_branch: "oneshot/cpdev-21090-run-84",
    current_implementation_commit_sha:
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    current_code_review_version: 1,
    current_test_version: 2,
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
      stage: "testing",
      version: 2,
      expected_state: "queued_for_testing",
      revision: false,
      emitted_at: "2026-04-20T17:28:47.000Z",
      expected_implementation_commit_sha:
        "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      expected_implementation_version: 2,
    }),
  };
}

function buildLegacyMessage(): Message {
  const body = JSON.parse(buildMessage().Body!);
  delete body.expected_implementation_commit_sha;
  delete body.expected_implementation_version;
  return { Body: JSON.stringify(body) };
}

function buildPlan(
  overrides?: Partial<{
    plannerDiscoveries: {
      testCommand?: string;
    };
  }>,
) {
  return {
    jiraKey: "CPDEV-21090",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Style the cancel button red.",
    specs: [
      {
        id: "SPEC-1",
        objective: "Style the cancel button red.",
        acceptanceCriteria: [
          "Cancel button renders red in the member search modal.",
        ],
        targetFiles: [
          "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
        ],
        implementationNotes: ["Reuse existing button style conventions."],
        validationSteps: ["mvn test -B"],
      },
    ],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
    plannerDiscoveries: overrides?.plannerDiscoveries,
  };
}

function buildImplementation(
  overrides?: Partial<{
    testCommands: string[];
    validationCommands: string[];
    validationChecks: Array<{
      kind: "must_match" | "must_not_match";
      pattern: string;
      paths: string[];
    }>;
    manualVerificationSteps: string[];
  }>,
) {
  return {
    summary: "Implemented the cancel button styling.",
    completedSpecIds: ["SPEC-1"],
    implementationBranch: "oneshot/cpdev-21090-run-84",
    implementationCommitSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    changedFiles: [
      "MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java",
      "MedicalMgmt/src/main/webapp/Medhok3.css",
    ],
    testCommands: overrides?.testCommands ?? ["mvn test -B"],
    validationCommands: overrides?.validationCommands ?? [],
    validationChecks: overrides?.validationChecks ?? [],
    manualVerificationSteps: overrides?.manualVerificationSteps ?? [],
    testResults: [
      {
        command: "mvn test -B",
        status: "passed" as const,
        summary: "Tests passed in implementer workspace.",
      },
    ],
    deviationsFromPlan: [],
    residualRisks: [],
    openFollowUps: [],
  };
}

function buildTesterDeps(
  options?: Partial<{
    plan: ReturnType<typeof buildPlan>;
    implementation: ReturnType<typeof buildImplementation>;
    run: OneShotRun;
    qualificationTicketSummary: string | null;
    qualificationProcessingMode:
      | "security_wiz"
      | "wiz_code"
      | "sonar_autofix"
      | "standard";
    qualificationJiraLabels: string[];
    priorEvents: Array<{
      event_type?: string;
      stage?: string | null;
      to_state?: string | null;
      metadata_json?: Record<string, unknown> | null;
    }>;
    planMetadata: Record<string, unknown> | null;
    codeReviewMetadata: Record<string, unknown> | null;
    configOverrides: Partial<OneShotConsumerConfig>;
  }>,
) {
  const run = options?.run ?? buildRun();
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const plan = options?.plan ?? buildPlan();
  const implementation = options?.implementation ?? buildImplementation();

  const oneShotDb = {
    runs: {
      getRunById: vi.fn().mockResolvedValue(run),
      claimQueuedRun: vi.fn().mockResolvedValue(true),
      incrementVerificationLoop: vi.fn().mockResolvedValue(undefined),
      checkVerificationBudget: vi.fn().mockResolvedValue(true),
      updateRunState: vi.fn().mockResolvedValue(undefined),
      updateRunStateIfCurrentState: vi.fn().mockResolvedValue(true),
      ensureRunBranchContract: vi.fn().mockResolvedValue(undefined),
      touchRun: vi.fn().mockResolvedValue(undefined),
    },
    artifacts: {
      getLatestArtifact: vi
        .fn()
        .mockImplementation((_runId: number, stage: string) => {
          if (stage === "qualification") {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "qualification.json",
            });
          }
          return Promise.resolve(null);
        }),
      getArtifact: vi
        .fn()
        .mockImplementation((_runId: number, stage: string) => {
          if (stage === "plan") {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "plan.json",
              metadata_json: options?.planMetadata ?? null,
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
          if (stage === "code_review") {
            if (options?.codeReviewMetadata === null) {
              return Promise.resolve(null);
            }
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "code-review.json",
              metadata_json: {
                reviewedImplementationCommitSha:
                  run.current_implementation_commit_sha,
                ...(options?.codeReviewMetadata ?? {}),
              },
            });
          }
          return Promise.resolve(null);
        }),
      upsertArtifact: vi.fn().mockResolvedValue(undefined),
    },
    events: {
      createEvent: vi.fn().mockResolvedValue(undefined),
      getEventsForRun: vi.fn().mockResolvedValue(options?.priorEvents ?? []),
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
        finalizedAt: new Date("2026-04-20T17:28:47.000Z"),
      }),
      backfillCurrentCandidate: vi.fn().mockResolvedValue(true),
    },
  };

  withOneShotTransactionMock.mockImplementation(
    async (_db: unknown, operation: (txdb: unknown) => Promise<unknown>) =>
      operation(oneShotDb),
  );

  const s3Client = {
    send: vi
      .fn()
      .mockImplementation((command: { input?: { Key?: string } }) => {
        switch (command.input?.Key) {
          case "qualification.json":
            return Promise.resolve({
              Body: {
                transformToString: vi.fn().mockResolvedValue(
                  JSON.stringify({
                    ticketSummary:
                      options?.qualificationTicketSummary ??
                      'Style "Cancel" button',
                    processingMode:
                      options?.qualificationProcessingMode ?? "standard",
                    jiraLabels: options?.qualificationJiraLabels ?? [],
                  }),
                ),
              },
            });
          case "plan.json":
            return Promise.resolve({
              Body: {
                transformToString: vi
                  .fn()
                  .mockResolvedValue(JSON.stringify(plan)),
              },
            });
          case "implementation.json":
            return Promise.resolve({
              Body: {
                transformToString: vi
                  .fn()
                  .mockResolvedValue(JSON.stringify(implementation)),
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
    upsertHistoricalTicketIndex: vi.fn().mockResolvedValue(undefined),
  };

  const workspaceManager = {
    prepareTesterWorkspace: vi.fn().mockResolvedValue({
      workspacePath: "/tmp/tester-workspace",
      statePath: "/tmp/tester-state",
      cleanup,
    }),
  };

  const publisher = {
    publishStageMessage: vi.fn().mockResolvedValue(undefined),
  };

  const consumer = new TestableTesterConsumer({
    config: { ...config, ...(options?.configOverrides ?? {}) },
    db: db as never,
    sqsClient: { send: vi.fn() } as never,
    s3Client: s3Client as never,
    publisher: publisher as never,
    workspaceManager: workspaceManager as never,
    ciPollDelay: vi.fn().mockResolvedValue(undefined),
    ciPollIntervalMs: 0,
  });

  (consumer as { oneShotDb: unknown }).oneShotDb = oneShotDb;

  return {
    consumer,
    oneShotDb,
    db,
    s3Client,
    publisher,
    cleanup,
  };
}

function readTestResultPutBody(s3Client: {
  send: {
    mock: {
      calls: Array<Array<{ input?: { Body?: unknown } }>>;
    };
  };
}) {
  const putCommand = s3Client.send.mock.calls
    .map((call) => call[0])
    .find((command) => typeof command?.input?.Body === "string");
  expect(putCommand).toBeDefined();
  return JSON.parse(String(putCommand?.input?.Body));
}

function mockAutomatedTestFailure() {
  resolveTestCommandsMock.mockResolvedValue({
    kind: "commands",
    executionKind: "automated_tests",
    automatedCommands: ["mvn test -B"],
    validationCommands: [],
    validationChecks: [],
    skippedTestCommands: [],
    source: "implementation",
    parserNotes: [],
  });
  executeTestCommandMock.mockResolvedValue({
    exitCode: 1,
    stdout: "",
    stderr: "tests failed",
    durationMs: 250,
  });
  findAndParseTestReportsMock.mockResolvedValue({
    passCount: 0,
    failCount: 1,
    skipCount: 0,
    failedTests: [
      {
        testName: "cancelButtonStyleSpec",
        message: "Expected cancel button style to be cancelButtonRed",
      },
    ],
  });
}

function mockValidationOnlyFailure() {
  const failingCheck = {
    kind: "must_match" as const,
    pattern: "cancelButtonRed::START",
    paths: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
  };
  resolveTestCommandsMock.mockResolvedValue({
    kind: "commands",
    executionKind: "validation_only",
    automatedCommands: [],
    validationCommands: [],
    validationChecks: [failingCheck],
    skippedTestCommands: [],
    source: "implementation",
    parserNotes: [],
  });
  executeValidationCheckMock.mockResolvedValue({
    check: failingCheck,
    command: "rg --line-number ...",
    exitCode: 1,
    passed: false,
    stdout: "",
    stderr: "marker missing",
    durationMs: 40,
  });
  return failingCheck;
}

describe("TesterConsumer", () => {
  beforeEach(() => {
    resolveTestCommandsMock.mockReset();
    executeTestCommandMock.mockReset();
    executeGitDiffCheckMock.mockReset();
    executeValidationCheckMock.mockReset();
    captureTestReportSnapshotMock.mockReset();
    findAndParseTestReportsMock.mockReset();
    findAndParseCoverageMock.mockReset();
    transitionRunWithNotificationMock.mockReset();
    withOneShotTransactionMock.mockReset();
    ensureDraftPullRequestMock.mockReset();
    fetchCommitStatusSummaryMock.mockReset();
    parseGitHubRepoUrlMock.mockReset();
    verificationLoopCounterAddMock.mockReset();
    ensureRunBranchContractMock.mockClear();
    getCurrentHeadShaMock.mockResolvedValue(
      "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    );
    captureTestReportSnapshotMock.mockResolvedValue(new Map());
    executeGitDiffCheckMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 15,
    });

    transitionRunWithNotificationMock.mockResolvedValue(true);
    ensureDraftPullRequestMock.mockResolvedValue({
      number: 12,
      htmlUrl: "https://github.com/org/core-app/pull/12",
      reused: false,
    });
    fetchCommitStatusSummaryMock.mockResolvedValue({
      state: "success",
      description:
        "GitHub combined status is success across 1 status check(s).",
    });
    parseGitHubRepoUrlMock.mockReturnValue({
      owner: "org",
      repo: "core-app",
    });
    findAndParseCoverageMock.mockResolvedValue(undefined);
  });

  it("fails when no code-review artifact exists for the candidate SHA", async () => {
    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      codeReviewMetadata: null,
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        fromState: "testing",
        toState: "failed",
        updates: expect.objectContaining({
          final_disposition: "run_failed",
          last_error: expect.stringContaining("missing code review artifact"),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        metadata_json: expect.objectContaining({
          reason: "candidate_sha_integrity_error",
          expectedImplementationCommitSha:
            "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        }),
      }),
    );
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("republishes legacy testing messages before processing an unpinned code-review artifact", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 120,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps({
      codeReviewMetadata: {
        reviewedImplementationCommitSha: undefined,
      },
    });

    const shouldDelete = await consumer.processMessage(buildLegacyMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "candidate_sha_mismatch_dropped",
        metadata_json: expect.objectContaining({
          reason: "candidate_sha_missing_v2",
          candidateTableCommitSha:
            "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
          candidateTableVersion: 2,
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "testing",
      2,
      "queued_for_testing",
      false,
      expect.objectContaining({
        expectedImplementationCommitSha:
          "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
        expectedImplementationVersion: 2,
      }),
    );
    expect(cleanup).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
  });

  it("passes Sonar mode into test resolution and runs built-in diff check", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn -pl MedicalMgmt -am -B test"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 120,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });

    const { consumer } = buildTesterDeps({
      qualificationProcessingMode: "sonar_autofix",
      qualificationJiraLabels: ["SONAR-AUTOFIX"],
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(resolveTestCommandsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Array),
      undefined,
      expect.any(Array),
      {
        mavenBuildsEnabled: true,
        requireModuleScopedMaven: true,
      },
    );
    expect(executeGitDiffCheckMock).toHaveBeenCalledWith(
      expect.any(String),
      "0123456789abcdef0123456789abcdef01234567",
    );
  });

  it("requires module-scoped Maven and runs the diff check in wiz_code mode", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn -pl ProviderPortal -am -B test"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 120,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });

    const { consumer } = buildTesterDeps({
      qualificationProcessingMode: "wiz_code",
      qualificationJiraLabels: ["WIZ-CODE"],
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(resolveTestCommandsMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.any(Array),
      undefined,
      expect.any(Array),
      {
        mavenBuildsEnabled: true,
        requireModuleScopedMaven: true,
      },
    );
    expect(executeGitDiffCheckMock).toHaveBeenCalledWith(
      expect.any(String),
      "0123456789abcdef0123456789abcdef01234567",
    );
  });

  it("fails Sonar testing when built-in diff check reports whitespace issues", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn -pl MedicalMgmt -am -B test"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
      durationMs: 120,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    executeGitDiffCheckMock.mockResolvedValue({
      exitCode: 2,
      stdout: "src/Foo.java:1: trailing whitespace.",
      stderr: "",
      durationMs: 20,
    });

    const { consumer, oneShotDb } = buildTesterDeps({
      qualificationProcessingMode: "sonar_autofix",
      qualificationJiraLabels: ["SONAR-AUTOFIX"],
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          passed: false,
          failCount: 1,
        }),
      }),
    );
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
        last_error: "1 validation command(s) failed",
      }),
    );
  });

  it("fails when the tester workspace HEAD does not match the candidate SHA", async () => {
    getCurrentHeadShaMock.mockResolvedValue(
      "1111111111111111111111111111111111111111",
    );
    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        fromState: "testing",
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
            "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
          workspaceHead: "1111111111111111111111111111111111111111",
        }),
      }),
    );
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("requeues after workspace lease loss without test failure side effects", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockRejectedValue(
      new Error("Lost OneShot workspace lease during testing"),
    );
    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_testing",
      {
        last_error:
          "Workspace lease lost during testing; stage requeued for retry",
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "testing",
        to_state: "queued_for_testing",
        stage: "testing",
        metadata_json: expect.objectContaining({
          reason: "workspace_lease_lost",
          version: 2,
          revision: false,
          receiveCount: 1,
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
  });

  it("creates a needs-review draft PR when no runnable automated test command exists", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "none",
      executionKind: "no_runnable_command",
      source: "none",
      validationChecks: [],
      skippedTestCommands: [],
      parserNotes: [
        'Ignoring implementation-provided test command "Verify the button is red in the browser" because it appears to be manual or interactive verification.',
      ],
      failureReason:
        "No runnable automated test command available; implementation only provided manual verification steps.",
    });

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        manualVerificationSteps: [
          "Verify the Cancel button is red in the member search modal.",
        ],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
          current_pr_url: "https://github.com/org/core-app/pull/12",
        }),
        notification: expect.objectContaining({
          notification_type: "pr_needs_review",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        to_state: "pr_open",
        metadata_json: expect.objectContaining({
          reason: "no_runnable_command",
          readiness: expect.objectContaining({
            completionStatus: "completed_needs_review",
          }),
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          commandSource: "none",
          executionKind: "no_runnable_command",
          failCount: 1,
        }),
      }),
    );
  });

  it("creates a needs-review draft PR when a wrapper test command is rejected and no validation checks remain", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "none",
      executionKind: "no_runnable_command",
      source: "none",
      validationChecks: [],
      skippedTestCommands: [],
      parserNotes: [
        'Ignoring implementation-provided test command "npm --silent test" because package.json scripts.test resolves to "vitest" but underlying runner "vitest" is not available from the repo root.',
      ],
      failureReason:
        'No runnable automated test command found after rejecting package.json-backed "npm --silent test" because the underlying runner is unavailable.',
    });

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: ["npm --silent test"],
        validationChecks: [],
        manualVerificationSteps: [],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          commandSource: "none",
          executionKind: "no_runnable_command",
          failCount: 1,
        }),
      }),
    );
  });

  it("passes via validation checks when automated npm test is rejected for a metadata-only run", async () => {
    const passingCheck = {
      kind: "must_match" as const,
      pattern: 'ONESHOT_VERSION = "1.20.00"',
      paths: ["src/oneshot/contracts.ts"],
    };
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "validation_only",
      automatedCommands: [],
      validationCommands: [],
      validationChecks: [passingCheck],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [
        'Ignoring implementation-provided test command "npm --silent test" because package.json scripts.test resolves to "vitest" but underlying runner "vitest" is not available from the repo root.',
      ],
    });
    executeValidationCheckMock.mockResolvedValue({
      check: passingCheck,
      command: "rg --line-number ...",
      exitCode: 0,
      passed: true,
      stdout: "src/oneshot/contracts.ts:4:export const ONESHOT_VERSION = \"1.20.00\";",
      stderr: "",
      durationMs: 20,
    });

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: ["npm --silent test"],
        validationCommands: [],
        validationChecks: [passingCheck],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.anything(),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_ready",
        }),
        notification: expect.objectContaining({
          notification_type: "pr_ready",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          commandSource: "implementation",
          executionKind: "validation_only",
          failCount: 0,
          passCount: 1,
        }),
      }),
    );
  });

  it("creates a needs-review draft PR when an accepted test command fails before startup because the runner is missing", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["npm test"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "planner",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 127,
      stdout: "> specter@2.0.0 test\n> vitest\n",
      stderr: "sh: 1: vitest: not found",
      durationMs: 99,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    findAndParseCoverageMock.mockResolvedValue({
      linePercent: 12,
      branchPercent: 8,
      threshold: 80,
      passed: false,
    });

    const { consumer, oneShotDb, publisher, s3Client } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationChecks: [],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(findAndParseTestReportsMock).toHaveBeenCalled();
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          commandSource: "planner",
          executionKind: "automated_tests",
          failCount: 1,
          unverified: true,
          skippedTestCommands: ["npm test"],
        }),
      }),
    );
    expect(readTestResultPutBody(s3Client)).toEqual(
      expect.objectContaining({
        parserNotes: expect.arrayContaining([
          expect.stringContaining("vitest: not found"),
        ]),
        coverage: expect.objectContaining({
          passed: false,
        }),
        truncatedOutput: expect.stringContaining("vitest: not found"),
      }),
    );
  });

  it("continues structured validation checks after a runtime missing test runner", async () => {
    const passingCheck = {
      kind: "must_match" as const,
      pattern: 'ONESHOT_VERSION = "1.20.00"',
      paths: ["src/oneshot/contracts.ts"],
    };
    const largeValidationOutput = `src/oneshot/contracts.ts:4:export const ONESHOT_VERSION = "1.20.00";\n${"validation output\n".repeat(700)}`;
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["npm test"],
      validationCommands: [],
      validationChecks: [passingCheck],
      skippedTestCommands: [],
      source: "planner",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 127,
      stdout: "> specter@2.0.0 test\n> vitest\n",
      stderr: "sh: 1: vitest: not found",
      durationMs: 99,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    executeValidationCheckMock.mockResolvedValue({
      check: passingCheck,
      command: "rg --line-number ...",
      exitCode: 0,
      passed: true,
      stdout: largeValidationOutput,
      stderr: "",
      durationMs: 20,
    });

    const { consumer, oneShotDb, publisher, s3Client } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationChecks: [passingCheck],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(findAndParseTestReportsMock).toHaveBeenCalled();
    expect(executeValidationCheckMock).toHaveBeenCalledWith(
      expect.any(String),
      passingCheck,
      expect.objectContaining({
        baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      }),
    );
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
        }),
        notification: expect.objectContaining({
          notification_type: "pr_needs_review",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          commandSource: "planner",
          executionKind: "automated_tests",
          failCount: 0,
          passCount: 1,
          unverified: true,
          skippedTestCommands: ["npm test"],
        }),
      }),
    );
    expect(readTestResultPutBody(s3Client)).toEqual(
      expect.objectContaining({
        parserNotes: expect.arrayContaining([
          expect.stringContaining("vitest: not found"),
        ]),
        truncatedOutput: expect.stringContaining("vitest: not found"),
      }),
    );
  });

  it("does not classify exit 127 with startup text as missing-runner proof when XML test evidence exists", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["npm test"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "planner",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 127,
      stdout: "> specter@2.0.0 test\n> vitest\n",
      stderr: "sh: 1: vitest: not found",
      durationMs: 99,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 0,
      failCount: 1,
      skipCount: 0,
      failedTests: [
        {
          testName: "suite fails after startup",
          message: "assertion failed after test startup",
        },
      ],
    });

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationChecks: [],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(findAndParseTestReportsMock).toHaveBeenCalled();
    expect(oneShotDb.runs.incrementVerificationLoop).toHaveBeenCalledWith(84);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      3,
      "queued_for_implementation",
      true,
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          failCount: 1,
          unverified: false,
          skippedTestCommands: [],
        }),
      }),
    );
  });

  it("does not classify exit 127 as missing-runner proof without startup failure text", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["npm test"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "planner",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 127,
      stdout: "",
      stderr: "assertion reported expected item not found",
      durationMs: 99,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 0,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationChecks: [],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(findAndParseTestReportsMock).toHaveBeenCalled();
    expect(oneShotDb.runs.incrementVerificationLoop).toHaveBeenCalledWith(84);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      3,
      "queued_for_implementation",
      true,
    );
  });

  it("treats disabled Maven-only proof as needs-review without implementation revision churn", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "none",
      executionKind: "no_runnable_command",
      source: "none",
      validationChecks: [],
      skippedTestCommands: ["mvn test -B"],
      mavenSkippedTestCommands: ["mvn test -B"],
      mavenBuildsDisabled: true,
      parserNotes: [
        'Skipping implementation-provided test command "mvn test -B" because ONESHOT_MAVEN_BUILDS_ENABLED=false.',
      ],
      failureReason:
        "No runnable automated test command found from implementation output, planner discoveries, or project heuristics.",
    });

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      configOverrides: { mavenBuildsEnabled: false },
      implementation: buildImplementation({
        testCommands: ["mvn test -B"],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(resolveTestCommandsMock).toHaveBeenCalledWith(
      expect.any(String),
      ["mvn test -B"],
      [],
      undefined,
      [],
      { mavenBuildsEnabled: false },
    );
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          skippedTestCommands: ["mvn test -B"],
          mavenSkippedTestCommands: ["mvn test -B"],
          mavenBuildsDisabled: true,
          unverified: true,
          passed: true,
          failCount: 0,
        }),
      }),
    );
  });

  it("creates a needs-review draft PR with an explicit shell-syntax error when testCommands contain chaining", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "none",
      executionKind: "invalid_command",
      source: "none",
      validationChecks: [],
      skippedTestCommands: [],
      parserNotes: [
        'Ignoring implementation-provided test command "grep foo file && grep bar file" because Unsupported shell syntax in testCommands or validationCommands; split chained checks into separate array entries.',
      ],
      failureReason:
        "Unsupported shell syntax in testCommands or validationCommands; split chained checks into separate array entries.",
    });

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: ["grep foo file && grep bar file"],
        manualVerificationSteps: [],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
          current_pr_url: "https://github.com/org/core-app/pull/12",
        }),
        notification: expect.objectContaining({
          notification_type: "pr_needs_review",
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        to_state: "pr_open",
        metadata_json: expect.objectContaining({
          reason: "invalid_command",
          readiness: expect.objectContaining({
            completionStatus: "completed_needs_review",
          }),
        }),
      }),
    );
  });

  it("keeps the existing implementation-revision path for real automated test failures", async () => {
    mockAutomatedTestFailure();

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.incrementVerificationLoop).toHaveBeenCalledWith(84);
    expect(verificationLoopCounterAddMock).toHaveBeenCalledWith(1, {
      stage: "testing",
    });
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
        last_error: "1 test(s) failed",
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      3,
      "queued_for_implementation",
      true,
    );
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
  });

  it("reverts implementation revision state when publish fails after test failure transition", async () => {
    mockAutomatedTestFailure();

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps();
    publisher.publishStageMessage.mockRejectedValueOnce(new Error("sqs down"));

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
        last_error: "1 test(s) failed",
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      "testing",
      expect.objectContaining({
        current_implementation_version: 2,
        current_test_version: 2,
        verification_loop_count: 0,
        last_error: "sqs down",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_implementation",
        to_state: "testing",
        stage: "testing",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          version: 2,
          nextImplementationVersion: 3,
          failCount: 1,
          publishError: "sqs down",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_testing",
      { last_error: "sqs down" },
    );
  });

  it("reverts implementation revision state before lease-loss recovery after test failure transition", async () => {
    mockAutomatedTestFailure();

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps();
    publisher.publishStageMessage.mockRejectedValueOnce(
      new Error("Lost OneShot workspace lease during testing"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      "testing",
      expect.objectContaining({
        verification_loop_count: 0,
        last_error: "Lost OneShot workspace lease during testing",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_implementation",
        to_state: "testing",
        stage: "testing",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          publishError: "Lost OneShot workspace lease during testing",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_testing",
      {
        last_error:
          "Workspace lease lost during testing; stage requeued for retry",
      },
    );
  });

  it("does not publish an implementation revision if test failure transition loses the state race", async () => {
    mockAutomatedTestFailure();

    const { consumer, oneShotDb, publisher } = buildTesterDeps();
    oneShotDb.runs.updateRunStateIfCurrentState.mockResolvedValueOnce(false);

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(oneShotDb.events.createEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "testing",
        to_state: "queued_for_implementation",
      }),
    );
  });

  it("allows exactly one implementation revision for validation-only failures", async () => {
    // Regression protection for iteration 5: the failing signal is now
    // validationChecks[] (structured), not raw validationCommands[].
    const failingCheck = {
      kind: "must_match" as const,
      pattern: "cancelButtonRed::START",
      paths: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
    };
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "validation_only",
      automatedCommands: [],
      validationCommands: [],
      validationChecks: [failingCheck],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeValidationCheckMock.mockResolvedValue({
      check: failingCheck,
      command: "rg --line-number ...",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: "marker missing",
      durationMs: 40,
    });

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
        last_error: "1 validation command(s) failed",
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      3,
      "queued_for_implementation",
      true,
    );
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
  });

  it("still allows the dedicated validation retry after earlier real test loops were consumed", async () => {
    const failingCheck = {
      kind: "must_match" as const,
      pattern: "cancelButtonRed::START",
      paths: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
    };
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "validation_only",
      automatedCommands: [],
      validationCommands: [],
      validationChecks: [failingCheck],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeValidationCheckMock.mockResolvedValue({
      check: failingCheck,
      command: "rg --line-number ...",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: "marker missing",
      durationMs: 40,
    });

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      run: buildRun({
        verification_loop_count: 2,
      }),
      implementation: buildImplementation({
        testCommands: [],
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
        last_error: "1 validation command(s) failed",
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      3,
      "queued_for_implementation",
      true,
    );
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalled();
  });

  it("reverts implementation revision state when validation retry publish fails", async () => {
    const failingCheck = mockValidationOnlyFailure();

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
    });
    publisher.publishStageMessage.mockRejectedValueOnce(new Error("sqs down"));

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      "testing",
      expect.objectContaining({
        current_implementation_version: 2,
        current_test_version: 2,
        last_error: "sqs down",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_implementation",
        to_state: "testing",
        stage: "testing",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          version: 2,
          nextImplementationVersion: 3,
          publishError: "sqs down",
          validationOnly: true,
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_testing",
      { last_error: "sqs down" },
    );
  });

  it("allows validation retry again when the prior validation handoff was reverted", async () => {
    const failingCheck = mockValidationOnlyFailure();

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
      priorEvents: [
        {
          event_type: "state_transition",
          stage: "testing",
          to_state: "queued_for_implementation",
          metadata_json: {
            reason: "validation_failure",
            version: 2,
          },
        },
        {
          event_type: "state_revert",
          stage: "testing",
          to_state: "testing",
          metadata_json: {
            reason: "publish_failed",
            validationOnly: true,
            version: 2,
          },
        },
      ],
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        current_test_version: 2,
        current_implementation_version: 3,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      84,
      "implementation",
      3,
      "queued_for_implementation",
      true,
    );
  });

  it("reverts validation retry state before lease-loss recovery", async () => {
    const failingCheck = mockValidationOnlyFailure();

    const { consumer, oneShotDb, publisher, cleanup } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
    });
    publisher.publishStageMessage.mockRejectedValueOnce(
      new Error("Lost OneShot workspace lease during testing"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(cleanup).toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      "testing",
      expect.objectContaining({
        last_error: "Lost OneShot workspace lease during testing",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_implementation",
        to_state: "testing",
        stage: "testing",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          publishError: "Lost OneShot workspace lease during testing",
          validationOnly: true,
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_testing",
      {
        last_error:
          "Workspace lease lost during testing; stage requeued for retry",
      },
    );
  });

  it("does not publish a validation retry if the transition loses the state race", async () => {
    const failingCheck = mockValidationOnlyFailure();

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: [],
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
    });
    oneShotDb.runs.updateRunStateIfCurrentState.mockResolvedValueOnce(false);

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(oneShotDb.events.createEvent).not.toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "testing",
        to_state: "queued_for_implementation",
        metadata_json: expect.objectContaining({
          reason: "validation_failure",
        }),
      }),
    );
  });

  it("creates a needs-review draft PR once the dedicated validation retry was already used", async () => {
    const failingCheck = {
      kind: "must_match" as const,
      pattern: "cancelButtonRed::START",
      paths: ["MedicalMgmt/src/main/webapp/Medhok3.css"],
    };
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "validation_only",
      automatedCommands: [],
      validationCommands: [],
      validationChecks: [failingCheck],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeValidationCheckMock.mockResolvedValue({
      check: failingCheck,
      command: "rg --line-number ...",
      exitCode: 1,
      passed: false,
      stdout: "",
      stderr: "marker missing",
      durationMs: 40,
    });

    const { consumer, oneShotDb, publisher } = buildTesterDeps({
      priorEvents: [
        {
          event_type: "state_transition",
          stage: "testing",
          to_state: "queued_for_implementation",
          metadata_json: { reason: "validation_failure" },
        },
      ],
      implementation: buildImplementation({
        testCommands: [],
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.incrementVerificationLoop).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.anything(),
    );
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
          current_pr_url: "https://github.com/org/core-app/pull/12",
        }),
        notification: expect.objectContaining({
          notification_type: "pr_needs_review",
        }),
      }),
    );
  });

  it("uses the qualification ticket summary for the draft PR title", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "tests passed",
      stderr: "",
      durationMs: 250,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });

    const { consumer, cleanup, db } = buildTesterDeps({
      qualificationTicketSummary: 'Member Search: Style "Cancel" button',
      implementation: buildImplementation({
        testCommands: ["mvn test -B"],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(cleanup).toHaveBeenCalled();
    expect(ensureDraftPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'OneShot - CPDEV-21090: Member Search: Style "Cancel" button',
      }),
    );
    expect(ensureDraftPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining(
          '- Summary: Member Search: Style "Cancel" button',
        ),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        notification: expect.objectContaining({
          notification_type: "pr_ready",
          body_markdown: expect.stringContaining(
            "![OneShot](https://productFactory.mhkdevsandbox.com/oneshot/oneshot-logo-jira.png)",
          ),
        }),
      }),
    );
    expect(db.upsertHistoricalTicketIndex).not.toHaveBeenCalled();
  });

  it("creates the PR as draft before CI and keeps it draft when GitHub checks fail", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "tests passed",
      stderr: "",
      durationMs: 250,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    fetchCommitStatusSummaryMock
      .mockResolvedValueOnce({
        state: "success",
        description:
          "No GitHub CI checks were reported and branch protection confirms no required checks.",
        statusCount: 0,
        checkRunCount: 0,
        requiredCheckState: "none",
      })
      .mockResolvedValueOnce({
        state: "failure",
        description:
          "GitHub CI is failing across 0 status check(s) and 1 check run(s).",
        statusCount: 0,
        checkRunCount: 1,
        requiredCheckState: "present",
      });

    const { consumer, oneShotDb } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: ["mvn test -B"],
      }),
      planMetadata: {
        planRiskAssessment: {
          mode: "observe",
          blockingCandidateCount: 1,
          advisoryCount: 0,
          wouldAffectReadiness: true,
          findings: [
            {
              code: "endpoint_api_uncertainty",
              category: "endpoint_or_api_surface",
              severity: "high",
              source: "plan.openQuestions[0]",
              message: "endpoint/API evidence: endpoint unresolved",
            },
          ],
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(ensureDraftPullRequestMock).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        draft: true,
      }),
    );
    expect(ensureDraftPullRequestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        draft: true,
      }),
    );
    expect(fetchCommitStatusSummaryMock).toHaveBeenCalledTimes(2);
    expect(fetchCommitStatusSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "master",
        pullNumber: 12,
        ref: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
          last_error: expect.stringContaining("GitHub CI is failing"),
        }),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "risk_classification_finalized",
        metadata_json: expect.objectContaining({
          actualOutcome: "needs_review",
          categories: ["endpoint_or_api_surface"],
          affectedReadiness: false,
          affectedCategories: [],
          categoryOutcomes: [
            {
              category: "endpoint_or_api_surface",
              affectedReadiness: false,
            },
          ],
          ciState: "failure",
        }),
      }),
    );
  });

  it("keeps the PR draft when the PR branch head differs from the tested commit", async () => {
    const prHeadSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "tests passed",
      stderr: "",
      durationMs: 250,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    ensureDraftPullRequestMock.mockResolvedValue({
      number: 12,
      htmlUrl: "https://github.com/org/core-app/pull/12",
      reused: true,
      headSha: prHeadSha,
    });

    const { consumer } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: ["mvn test -B"],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(fetchCommitStatusSummaryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        base: "master",
        pullNumber: 12,
        ref: prHeadSha,
      }),
    );
    expect(ensureDraftPullRequestMock).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        draft: true,
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        updates: expect.objectContaining({
          final_disposition: "completed_needs_review",
          last_error: expect.stringContaining("PR branch head changed"),
        }),
        notification: expect.objectContaining({
          notification_type: "pr_needs_review",
        }),
      }),
    );
  });

  it("finalizes external spec observations as risk categories", async () => {
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "tests passed",
      stderr: "",
      durationMs: 250,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 1,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });

    const { consumer, oneShotDb } = buildTesterDeps({
      implementation: buildImplementation({
        testCommands: ["mvn test -B"],
      }),
      planMetadata: {
        externalSpecEvidence: {
          mode: "observe",
          unavailable: true,
          urls: [
            {
              url: "https://build.fhir.org/ig/HL7/davinci-dtr/StructureDefinition-dtr-questionnaire.html",
              status: "unavailable",
              cacheKey: "external-specs/example.json",
              error: "insufficient_external_spec_evidence",
            },
          ],
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "risk_classification_finalized",
        metadata_json: expect.objectContaining({
          actualOutcome: "needs_review",
          categories: ["external_spec_contract"],
          affectedReadiness: true,
          affectedCategories: ["external_spec_contract"],
          categoryOutcomes: [
            {
              category: "external_spec_contract",
              affectedReadiness: true,
            },
          ],
        }),
      }),
    );
  });

  // -----------------------------------------------------------
  // Iteration 5: validationCommands[] is advisory-only; only
  // validationChecks[] gates. These tests lock in that behavior.
  // -----------------------------------------------------------

  it("does not gate on validationCommands[] even when they would fail", async () => {
    // Iteration 5 regression anchor. Previously, a raw grep for a pattern
    // that was absent (exit 1) would fail the run even though the absence
    // was the intended outcome (CPDEV-21565). Now validationCommands[] is
    // advisory only; absence of validationChecks[] means nothing to gate on.
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [
        "grep -n 'absentString' mhk-interopt-fhirhelper/src/main/java/com/example/AbsentFile.java",
      ],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 200,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 10,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });

    const { consumer, oneShotDb } = buildTesterDeps({
      implementation: buildImplementation({
        validationCommands: [
          "grep -n 'absentString' mhk-interopt-fhirhelper/src/main/java/com/example/AbsentFile.java",
        ],
        validationChecks: [],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // Critical: validationCommands[] did NOT produce a validation_failure.
    // Tester reaches the PR-ready happy path (pr_open with pr_ready notification),
    // not the implementation-revision path.
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        notification: expect.objectContaining({
          notification_type: "pr_ready",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.anything(),
    );
  });

  it("treats validationCommands[] as advisory when non-empty (does not fail the run)", async () => {
    // Runs the tester with non-empty validationCommands[] AND a passing set
    // of automatedCommands + no validationChecks. Iteration-5 contract: the
    // deprecated field must not change the run's terminal state.
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: ["grep -n 'X' f1.java", "grep -n 'Y' f2.java"],
      validationChecks: [],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 10,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 3,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });

    const { consumer, oneShotDb } = buildTesterDeps({
      implementation: buildImplementation({
        validationCommands: ["grep -n 'X' f1.java", "grep -n 'Y' f2.java"],
        validationChecks: [],
      }),
    });

    await consumer.processMessage(buildMessage(), 1);

    // Confirm the run reached pr_open / pr_ready, NOT queued_for_implementation.
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
      }),
    );
    expect(oneShotDb.runs.updateRunState).not.toHaveBeenCalledWith(
      84,
      "queued_for_implementation",
      expect.anything(),
    );
  });

  it("still passes the gate when validationChecks[] must_not_match is satisfied (absent)", async () => {
    const passingCheck = {
      kind: "must_not_match" as const,
      pattern: "toJsonWithoutNulls",
      paths: [
        "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/common/service/CoreRestClient.java",
      ],
      scope: "changed_lines" as const,
    };
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [passingCheck],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 200,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 10,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    executeValidationCheckMock.mockResolvedValue({
      check: passingCheck,
      command: "rg --line-number ...",
      exitCode: 1,
      passed: true, // must_not_match + no matches = pass
      stdout: "",
      stderr: "",
      durationMs: 30,
    });

    const { consumer, oneShotDb } = buildTesterDeps({
      implementation: buildImplementation({
        validationCommands: [],
        validationChecks: [passingCheck],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(executeValidationCheckMock).toHaveBeenCalledWith(
      expect.any(String),
      passingCheck,
      { baseCommitSha: "0123456789abcdef0123456789abcdef01234567" },
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          executedValidationChecks: expect.arrayContaining([
            expect.objectContaining({
              scope: "changed_lines",
            }),
          ]),
        }),
      }),
    );
    // must_not_match + absent = pass → run reaches PR-ready happy path.
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        runId: 84,
        toState: "pr_open",
        notification: expect.objectContaining({
          notification_type: "pr_ready",
        }),
      }),
    );
  });

  it("still fails the gate when validationChecks[] must_not_match finds a violation", async () => {
    const failingCheck = {
      kind: "must_not_match" as const,
      pattern: "toJsonWithoutNulls",
      paths: [
        "mhk-interopt-fhirhelper/src/main/java/com/mhkinterop/common/service/CoreRestClient.java",
      ],
    };
    resolveTestCommandsMock.mockResolvedValue({
      kind: "commands",
      executionKind: "automated_tests",
      automatedCommands: ["mvn test -B"],
      validationCommands: [],
      validationChecks: [failingCheck],
      skippedTestCommands: [],
      source: "implementation",
      parserNotes: [],
    });
    executeTestCommandMock.mockResolvedValue({
      exitCode: 0,
      stdout: "",
      stderr: "",
      durationMs: 200,
    });
    findAndParseTestReportsMock.mockResolvedValue({
      passCount: 10,
      failCount: 0,
      skipCount: 0,
      failedTests: [],
    });
    executeValidationCheckMock.mockResolvedValue({
      check: failingCheck,
      command: "rg --line-number ...",
      exitCode: 0,
      passed: false, // must_not_match + matches found = fail
      stdout: "CoreRestClient.java:153: toJsonWithoutNulls(body)",
      stderr: "",
      durationMs: 30,
    });

    const { consumer, oneShotDb } = buildTesterDeps({
      implementation: buildImplementation({
        validationCommands: [],
        validationChecks: [failingCheck],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // Run goes back for one implementation revision (same escalation
    // path as before; only the signal source changed).
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_implementation",
      expect.objectContaining({
        last_error: "1 validation command(s) failed",
      }),
    );
  });
});

describe("TesterConsumer transient retry backoff", () => {
  it("requeues with transientRetry metadata at receiveCount=3 (not exhausted)", async () => {
    resolveTestCommandsMock.mockRejectedValue(new Error("Transient workspace error"));

    const message = {
      ...buildMessage(),
      ReceiptHandle: "receipt-handle-rc3",
    };
    const { consumer, oneShotDb } = buildTesterDeps();

    const shouldDelete = await consumer.processMessage(message, 3);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_testing",
      expect.objectContaining({ last_error: "Transient workspace error" }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "testing",
        to_state: "queued_for_testing",
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

  it("fails the run at receiveCount=4 (exhausted)", async () => {
    resolveTestCommandsMock.mockRejectedValue(new Error("Persistent workspace error"));

    const message = {
      ...buildMessage(),
      ReceiptHandle: "receipt-handle-rc4",
    };
    const { consumer, oneShotDb } = buildTesterDeps();

    const shouldDelete = await consumer.processMessage(message, 4);

    expect(shouldDelete).toBe(true);
    // Should NOT have requeued
    expect(oneShotDb.runs.updateRunStateIfCurrentState).not.toHaveBeenCalledWith(
      84,
      "testing",
      "queued_for_testing",
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// T7 — PR-body retrofitTraceability threading (SPEC-3)
// ---------------------------------------------------------------------------

// Build a tester deps variant that injects retrofit manifest into impl artifact metadata
function buildTesterDepsWithRetrofit() {
  const retrofitManifest = {
    entries: [
      { sha: "abc1234", subject: "CPDEV-12345 fix auth", files: ["src/AuthClient.ts"], status: "clean_applied" },
      { sha: "def5678", subject: "CPDEV-12345 fix test", files: ["src/AuthClient.test.ts"], status: "clean_applied" },
    ],
  };
  const retrofitContext = {
    sourceJiraKey: "CPDEV-12345",
    sourceBranch: "master",
    targetBranch: "release-4.0",
  };

  // Replicate the relevant parts of buildTesterDeps with retrofit metadata injected
  const run = buildRun();
  const plan = buildPlan();
  const implementation = buildImplementation();
  const cleanup = vi.fn().mockResolvedValue(undefined);

  const oneShotDb = {
    runs: {
      getRunById: vi.fn().mockResolvedValue(run),
      claimQueuedRun: vi.fn().mockResolvedValue(true),
      incrementVerificationLoop: vi.fn().mockResolvedValue(undefined),
      checkVerificationBudget: vi.fn().mockResolvedValue(true),
      updateRunState: vi.fn().mockResolvedValue(undefined),
      updateRunStateIfCurrentState: vi.fn().mockResolvedValue(true),
      ensureRunBranchContract: vi.fn().mockResolvedValue(undefined),
      touchRun: vi.fn().mockResolvedValue(undefined),
    },
    artifacts: {
      getLatestArtifact: vi.fn().mockImplementation((_runId: number, stage: string) => {
      if (stage === 'qualification') {
        return Promise.resolve({ s3_bucket: 'artifact-bucket', s3_key: 'qualification.json' });
      }
      return Promise.resolve(null);
    }),
      getArtifact: vi.fn().mockImplementation((_runId: number, stage: string) => {
        if (stage === "plan") {
          return Promise.resolve({
            s3_bucket: "artifact-bucket",
            s3_key: "plan.json",
            metadata_json: null,
          });
        }
        if (stage === "implementation") {
          return Promise.resolve({
            s3_bucket: "artifact-bucket",
            s3_key: "implementation.json",
            metadata_json: {
              implementationCommitSha: run.current_implementation_commit_sha,
              retrofitManifest,
              retrofitContext,
            },
          });
        }
        if (stage === "code_review") {
          return Promise.resolve({
            s3_bucket: "artifact-bucket",
            s3_key: "code-review.json",
            metadata_json: {
              reviewedImplementationCommitSha: run.current_implementation_commit_sha,
            },
          });
        }
        return Promise.resolve(null);
      }),
      upsertArtifact: vi.fn().mockResolvedValue(undefined),
    },
    events: {
      createEvent: vi.fn().mockResolvedValue(undefined),
      getEventsForRun: vi.fn().mockResolvedValue([]),
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
        finalizedAt: new Date("2026-04-20T17:28:47.000Z"),
      }),
      backfillCurrentCandidate: vi.fn().mockResolvedValue(true),
    },
  };

  withOneShotTransactionMock.mockImplementation(
    async (_db: unknown, operation: (txdb: unknown) => Promise<unknown>) =>
      operation(oneShotDb),
  );

  const s3Client = {
    send: vi.fn().mockImplementation((command: { input?: { Key?: string } }) => {
      switch (command.input?.Key) {
        case "qualification.json":
          return Promise.resolve({
            Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify({ ticketSummary: "Retrofit CPDEV-12345" })) },
          });
        case "plan.json":
          return Promise.resolve({
            Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify(plan)) },
          });
        case "implementation.json":
          return Promise.resolve({
            Body: { transformToString: vi.fn().mockResolvedValue(JSON.stringify(implementation)) },
          });
        default:
          return Promise.resolve({ Body: { transformToString: vi.fn().mockResolvedValue("{}") } });
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
    prepareTesterWorkspace: vi.fn().mockResolvedValue({
      workspacePath: "/tmp/tester-workspace",
      statePath: "/tmp/tester-state",
      cleanup,
      assertLeaseValid: vi.fn().mockResolvedValue(undefined),
      lease: { scope: "run-worktree:84", fencingToken: 42 },
    }),
  };

  const publisher = { publishStageMessage: vi.fn().mockResolvedValue(undefined) };

  const consumer = new TestableTesterConsumer({
    config: config as never,
    db: db as never,
    sqsClient: { send: vi.fn() } as never,
    s3Client: s3Client as never,
    publisher: publisher as never,
    workspaceManager: workspaceManager as never,
  });
  (consumer as unknown as { oneShotDb: unknown }).oneShotDb = oneShotDb;

  return { consumer, oneShotDb, retrofitManifest, retrofitContext };
}

// Shared mock setup for T7 tests
function setupT7Mocks() {
  resolveTestCommandsMock.mockReset();
  executeTestCommandMock.mockReset();
  executeGitDiffCheckMock.mockReset();
  executeValidationCheckMock.mockReset();
  captureTestReportSnapshotMock.mockReset();
  findAndParseTestReportsMock.mockReset();
  findAndParseCoverageMock.mockReset();
  transitionRunWithNotificationMock.mockReset();
  withOneShotTransactionMock.mockReset();
  ensureDraftPullRequestMock.mockReset();
  fetchCommitStatusSummaryMock.mockReset();
  parseGitHubRepoUrlMock.mockReset();
  verificationLoopCounterAddMock.mockReset();
  getCurrentHeadShaMock.mockReset();
  ensureRunBranchContractMock.mockClear();
  resolveTestCommandsMock.mockResolvedValue({
    kind: "commands",
    executionKind: "automated_tests",
    automatedCommands: ["npm test"],
    validationCommands: [],
    validationChecks: [],
    skippedTestCommands: [],
    mavenSkippedTestCommands: [],
    mavenBuildsDisabled: false,
    source: "implementation",
    parserNotes: [],
  });
  executeTestCommandMock.mockResolvedValue({
    exitCode: 0,
    stdout: "1 passed",
    stderr: "",
    durationMs: 100,
  });
  findAndParseTestReportsMock.mockResolvedValue({
    passCount: 1,
    failCount: 0,
    skipCount: 0,
    failedTests: [],
  });
  findAndParseCoverageMock.mockResolvedValue(undefined);
  captureTestReportSnapshotMock.mockResolvedValue(new Map());
  executeGitDiffCheckMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", durationMs: 10 });
  getCurrentHeadShaMock.mockResolvedValue("abcdefabcdefabcdefabcdefabcdefabcdefabcd");
  ensureRunBranchContractMock.mockResolvedValue({
    branchName: "oneshot/cpdev-21090-run-84",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    expectedHeadSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    workspaceBaseSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    currentCandidateSha: null,
    remoteHeadSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    repairedMetadata: false,
    createdRemoteBranch: false,
    sharedEpicBranch: false,
  });
  parseGitHubRepoUrlMock.mockReturnValue({ owner: "org", repo: "core-app" });
  ensureDraftPullRequestMock.mockResolvedValue({
    htmlUrl: "https://github.com/org/core-app/pull/7",
    number: 7,
    reused: false,
    headSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
  });
  fetchCommitStatusSummaryMock.mockResolvedValue({
    state: "success",
    description: "All checks passed",
    statusCount: 1,
    checkRunCount: 0,
    requiredCheckState: "passing",
    details: [],
  });
  transitionRunWithNotificationMock.mockResolvedValue(true);
}

describe("Tester PR-body retrofitTraceability threading (T7)", () => {
  it("threads retrofitTraceability into buildOneShotPullRequestBody calls for retrofit runs", async () => {
    setupT7Mocks();

    const { consumer } = buildTesterDepsWithRetrofit();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // The PR was created — verify retrofitTraceability was threaded into the body
    expect(ensureDraftPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("CPDEV-12345"),
      }),
    );
    expect(ensureDraftPullRequestMock).toHaveBeenCalledWith(
      expect.objectContaining({
        body: expect.stringContaining("Retrofit Traceability"),
      }),
    );
  });

  it("omits retrofitTraceability from PR body for non-retrofit runs", async () => {
    setupT7Mocks();
    // Override PR mock to use a different number to distinguish calls
    ensureDraftPullRequestMock.mockResolvedValue({
      htmlUrl: "https://github.com/org/core-app/pull/8",
      number: 8,
      reused: false,
      headSha: "abcdefabcdefabcdefabcdefabcdefabcdefabcd",
    });

    // Use a normal (non-retrofit) dep builder — no retrofit manifest/context in impl metadata
    const { consumer } = buildTesterDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    if (ensureDraftPullRequestMock.mock.calls.length > 0) {
      const prBody = ensureDraftPullRequestMock.mock.calls[0][0]?.body ?? "";
      expect(prBody).not.toContain("Retrofit Traceability");
    }
  });
});
