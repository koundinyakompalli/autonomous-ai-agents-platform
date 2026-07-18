import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Message } from "@aws-sdk/client-sqs";
import type { OneShotConsumerConfig } from "../config.js";
import type { OneShotRun } from "../types.js";
import type { OneShotReview } from "../schema/review.js";
import { CORE_GUARDRAIL_IDS } from "../schema/plan.js";

const {
  buildReviewContextMock,
  materializeRunArtifactsMock,
  transitionRunWithNotificationMock,
  recordLlmMetricsMock,
  reviewLoopCounterAddMock,
  ensureRunBranchContractMock,
  verifyOneShotTraceArtifactMock,
  jiraAttachFileToIssueMock,
  jiraClientConstructorMock,
} = vi.hoisted(() => ({
  buildReviewContextMock: vi
    .fn()
    .mockResolvedValue({ files: [], truncated: false }),
  materializeRunArtifactsMock: vi.fn().mockResolvedValue(undefined),
  transitionRunWithNotificationMock: vi.fn().mockResolvedValue(true),
  recordLlmMetricsMock: vi.fn(),
  reviewLoopCounterAddMock: vi.fn(),
  verifyOneShotTraceArtifactMock: vi.fn(),
  ensureRunBranchContractMock: vi.fn().mockResolvedValue({
    branchName: "oneshot/cpdev-20686-run-42",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    expectedHeadSha: "0123456789abcdef0123456789abcdef01234567",
    workspaceBaseSha: "0123456789abcdef0123456789abcdef01234567",
    currentCandidateSha: null,
    remoteHeadSha: "0123456789abcdef0123456789abcdef01234567",
    repairedMetadata: false,
    createdRemoteBranch: false,
    sharedEpicBranch: false,
  }),
  jiraAttachFileToIssueMock: vi.fn().mockResolvedValue({ status: "attached" }),
  jiraClientConstructorMock: vi.fn(),
}));

vi.mock("../review-context.js", () => ({
  buildReviewContext: buildReviewContextMock,
}));

vi.mock("../workspace-artifacts.js", () => ({
  materializeRunArtifacts: materializeRunArtifactsMock,
}));

vi.mock("../state-transitions.js", () => ({
  buildPostmortemContext: vi.fn().mockReturnValue({}),
  transitionRunWithNotification: transitionRunWithNotificationMock,
}));

vi.mock("../run-branch-contract.js", () => ({
  ensureRunBranchContract: ensureRunBranchContractMock,
}));

vi.mock("../telemetry/metrics.js", () => ({
  recordLlmMetrics: recordLlmMetricsMock,
  reviewLoopCounter: {
    add: reviewLoopCounterAddMock,
  },
}));

vi.mock("../schema/trace-verify.js", async () => {
  const actual = await vi.importActual<
    typeof import("../schema/trace-verify.js")
  >("../schema/trace-verify.js");

  return {
    ...actual,
    verifyOneShotTraceArtifact: vi.fn(
      (input: Parameters<typeof actual.verifyOneShotTraceArtifact>[0]) =>
        verifyOneShotTraceArtifactMock(input) ??
        actual.verifyOneShotTraceArtifact(input),
    ),
  };
});

vi.mock("../providers/claude-reviewer.js", () => ({
  ClaudeReviewerProvider: vi.fn(),
}));

vi.mock("../../orchestrator/JiraClient.js", () => ({
  JiraClient: vi.fn(function (
    this: { attachFileToIssue?: unknown },
    config: unknown,
  ) {
    jiraClientConstructorMock(config);
    this.attachFileToIssue = jiraAttachFileToIssueMock;
  }),
}));

import { ReviewerConsumer } from "./reviewer.js";

class TestableReviewerConsumer extends ReviewerConsumer {
  async processMessage(
    message: Message,
    receiveCount: number,
  ): Promise<boolean> {
    return this.handleMessage(message, receiveCount);
  }
}

const config: OneShotConsumerConfig = {
  role: "REVIEWER",
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
  implementationPlanPostToJira: true,
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
    summary: "Review soft gate test plan",
    specs: [
      {
        id: "spec-1",
        objective: "Exercise reviewer state transitions",
        acceptanceCriteria: ["Reviewer transitions are correct"],
        targetFiles: ["src/example.ts", "src/example.test.ts"],
        implementationNotes: ["Follow local patterns"],
        validationSteps: ["npm test -- src/oneshot"],
      },
    ],
    assumptions: [],
    openQuestions: [],
    outOfScope: [],
    risks: [],
    fileChangeContract: [
      {
        path: "src/example.ts",
        role: "runtime_required",
        editable: true,
        rationale: "The example source file owns the reviewed behavior.",
        supportingEvidence: ["Read src/example.ts."],
        allowedChanges: ["Apply the localized behavior update."],
      },
      {
        path: "src/example.test.ts",
        role: "test_required",
        editable: true,
        rationale: "The focused test file verifies the reviewed behavior.",
        supportingEvidence: ["Read src/example.test.ts."],
        allowedChanges: ["Add or update the fail-first regression test."],
      },
    ],
    plannedCodeChanges: [
      {
        targetFile: "src/example.ts",
        symbolOrRegion: "example behavior",
        changeType: "update",
        afterSketch: "Update the existing branch without broad refactors.",
        rationale: "Localized code-change plan.",
        supportingEvidence: ["Reviewed src/example.ts."],
        confidence: "high",
      },
    ],
    guardrailReport: {
      coreChecks: CORE_GUARDRAIL_IDS.map((id) => ({
        id,
        severity: "high",
        status: "passed",
        applicabilityReason: "Core guardrail applies to every ticket.",
        evidence: ["Plan includes explicit scope, tests, and risks."],
        requiredAction: "Implementer must preserve this guardrail.",
      })),
      domainChecks: [
        {
          id: "pfos-security-remediation-scope",
          severity: "high",
          status: "not_applicable",
          applicabilityReason:
            "The test fixture is a standard code-change plan, not CVE remediation.",
          evidence: ["No security remediation evidence is present."],
          requiredAction: "Do not apply pom.xml-only remediation scope.",
        },
      ],
      implementerChecks: [
        {
          id: "editable-file-contract",
          severity: "high",
          status: "passed",
          applicabilityReason: "Editable files are listed explicitly.",
          evidence: ["fileChangeContract contains src/example.ts."],
          requiredAction: "Only edit files marked editable.",
        },
      ],
    },
    testingStrategy: {
      mode: "test_first",
      existingTestEvidence: [
        {
          id: "example-test-surface",
          kind: "test_file",
          path: "src/example.test.ts",
          summary: "Focused example test surface exists.",
          supportingEvidence: ["Read src/example.test.ts."],
        },
      ],
      plannedAutomatedTests: [
        {
          id: "AUTO-SPEC-1",
          testFile: "src/example.test.ts",
          relatedSpecIds: ["spec-1"],
          testType: "unit",
          scenario: "Reviewer transitions remain correct for the planned behavior.",
          assertions: ["The reviewed behavior follows the expected transition."],
          failFirst: true,
          command: "npm test -- src/example.test.ts",
          syntheticDataNotes: "Use synthetic reviewer fixtures only.",
        },
      ],
      validationCommands: [
        {
          command: "npm test -- src/example.test.ts",
          expectedResult: "Focused example tests pass.",
          scope: "focused",
          relatedSpecIds: ["spec-1"],
        },
      ],
      manualChecks: [],
      traceGuidance: [
        {
          id: "TRACE-AUTO-SPEC-1",
          section: "C",
          testType: "Unit",
          scenario: "Preserve the planned unit test in TRACE Section C.",
          relatedSpecIds: ["spec-1"],
          priority: "High",
        },
      ],
      coverageGaps: [],
    },
    implementerGuardrails: [
      {
        id: "example-file-scope",
        instruction:
          "Only edit src/example.ts or src/example.test.ts unless returning a structured deviation.",
        appliesToFiles: ["src/example.ts", "src/example.test.ts"],
        required: true,
      },
    ],
  };
}

function buildLegacyCompactPlan() {
  return {
    jiraKey: "CPDEV-20686",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Review soft gate test plan",
    implementationMode: "code_change",
    specs: [
      {
        id: "spec-1",
        objective: "Exercise reviewer state transitions",
        acceptanceCriteria: ["Reviewer transitions are correct"],
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

function buildReview(overrides: Partial<OneShotReview> = {}): OneShotReview {
  return {
    decision: "NEEDS_CHANGES",
    score: 72,
    sageDimensions: [],
    blockingFindings: [],
    requiredChanges: ["Tighten the plan before implementation"],
    nonBlockingSuggestions: ["Add more detail to validation steps"],
    confidence: "medium",
    coverageAssessment: "The plan is mostly covered but needs refinement.",
    ...overrides,
  };
}

function buildRun(overrides: Partial<OneShotRun> = {}): OneShotRun {
  const now = new Date("2026-04-17T12:00:00.000Z");

  return {
    id: 42,
    run_group_id: null,
    workspace_mode: "v2",
    jira_key: "CPDEV-20686",
    source_task_management_id: 7,
    customer_id: 1,
    repo_id: 11,
    branch_name: "master",
    base_commit_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_name: "oneshot/cpdev-20686-run-42",
    run_branch_base_sha: "0123456789abcdef0123456789abcdef01234567",
    run_branch_created_at: now,
    state: "queued_for_review",
    max_review_loops: 3,
    review_loop_count: 0,
    current_plan_version: 1,
    current_review_version: null,
    current_implementation_version: null,
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
    ...overrides,
  };
}

function buildMessage(): Message {
  return {
    Body: JSON.stringify({
      run_id: 42,
      stage: "review",
      version: 1,
      expected_state: "queued_for_review",
      revision: false,
      emitted_at: "2026-04-17T12:00:00.000Z",
    }),
  };
}

function buildDeps(
  options: {
    run?: OneShotRun;
    review?: OneShotReview;
    providerError?: Error;
    budgetWithin?: boolean;
    artifactUpsertError?: Error;
    notificationError?: Error;
    priorEvents?: Array<Record<string, unknown>>;
    jiraAgent?: { jira_username?: string | null; jira_token?: string | null };
    configOverrides?: Partial<OneShotConsumerConfig>;
    qualificationArtifact?: Record<string, unknown> | null;
    plan?: Record<string, unknown>;
  } = {},
) {
  const run = options.run ?? buildRun();
  const review = options.review ?? buildReview();
  const cleanup = vi.fn().mockResolvedValue(undefined);
  const publisher = {
    publishStageMessage: vi.fn().mockResolvedValue(undefined),
  };
  const oneShotDb = {
    runs: {
      getRunById: vi.fn().mockResolvedValue(run),
      claimQueuedRun: vi.fn().mockResolvedValue(true),
      checkTokenBudgetWithProjection: vi.fn().mockResolvedValue({
        withinBudget: options.budgetWithin ?? true,
        tokensUsed: 1_990_000,
        maxTokens: 2_000_000,
      }),
      ensureRunBranchContract: vi.fn().mockResolvedValue(undefined),
      addTokenUsage: vi.fn().mockResolvedValue(undefined),
      updateRunState: vi.fn().mockResolvedValue(undefined),
      updateRunStateIfCurrentState: vi.fn().mockResolvedValue(true),
    },
    artifacts: {
      getArtifactsForRun: vi.fn().mockResolvedValue(
        options.budgetWithin === false
          ? [
              {
                stage: "review",
                version: 1,
                metadata_json: { stage_tokens_used: 1_950_000 },
              },
            ]
          : [],
      ),
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
          if (stage === "qualification" && options.qualificationArtifact) {
            return Promise.resolve({
              s3_bucket: "artifact-bucket",
              s3_key: "qualification.json",
            });
          }
          return Promise.resolve(null);
        }),
      upsertArtifact: options.artifactUpsertError
        ? vi.fn().mockRejectedValue(options.artifactUpsertError)
        : vi.fn().mockResolvedValue(undefined),
      mergeArtifactMetadata: vi.fn().mockResolvedValue(true),
    },
    events: {
      getEventsForRun: vi.fn().mockResolvedValue(options.priorEvents ?? []),
      createEvent: vi.fn().mockResolvedValue(undefined),
    },
    notifications: {
      createNotification: options.notificationError
        ? vi.fn().mockRejectedValue(options.notificationError)
        : vi.fn().mockResolvedValue(123),
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
                .mockResolvedValue(JSON.stringify(options.plan ?? buildPlan())),
            },
          });
        }
        if (command.input?.Key === "qualification.json") {
          return Promise.resolve({
            Body: {
              transformToString: vi
                .fn()
                .mockResolvedValue(
                  JSON.stringify(options.qualificationArtifact ?? {}),
                ),
            },
          });
        }
        return Promise.resolve({});
      }),
  };
  const db = {
    getPool: vi.fn(() => ({})),
    getAgentByName: vi.fn().mockResolvedValue(options.jiraAgent ?? null),
    getRepositoryById: vi.fn().mockResolvedValue({
      id: 11,
      repo_name: "core-app",
      repo_url: "https://github.com/org/core-app",
    }),
  };
  const workspaceManager = {
    prepareReviewerWorkspace: vi.fn().mockResolvedValue({
      workspacePath: "/tmp/reviewer-workspace",
      statePath: "/tmp/reviewer-state",
      cleanup,
    }),
  };
  const reviewerProvider = {
    providerName: "openai" as const,
    modelId: "gpt-5.4",
    reviewPlan: options.providerError
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
  const consumer = new TestableReviewerConsumer({
    config: { ...config, ...options.configOverrides },
    db: db as never,
    sqsClient: { send: vi.fn() } as never,
    s3Client: s3Client as never,
    publisher: publisher as never,
    workspaceManager: workspaceManager as never,
    reviewerProvider: reviewerProvider as never,
  });

  (consumer as { oneShotDb: unknown }).oneShotDb = oneShotDb;

  return {
    consumer,
    oneShotDb,
    publisher,
    cleanup,
    reviewerProvider,
    s3Client,
  };
}

describe("ReviewerConsumer soft gate behavior", () => {
  beforeEach(() => {
    buildReviewContextMock.mockClear();
    materializeRunArtifactsMock.mockClear();
    transitionRunWithNotificationMock.mockClear();
    recordLlmMetricsMock.mockClear();
    reviewLoopCounterAddMock.mockClear();
    ensureRunBranchContractMock.mockClear();
    verifyOneShotTraceArtifactMock.mockReset();
    jiraAttachFileToIssueMock.mockResolvedValue({ status: "attached" });
    jiraAttachFileToIssueMock.mockClear();
    jiraClientConstructorMock.mockClear();
    vi.stubEnv("JIRA_BASE_URL", "https://jira.example.test");
    vi.stubEnv("JIRA_USERNAME", "oneshot");
    vi.stubEnv("JIRA_TOKEN", "secret-token");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("queues planning when NEEDS_CHANGES is still within the review loop budget", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps();

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.objectContaining({
        current_review_version: 1,
        review_loop_count: 1,
        planning_attempt_count: 0,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "reviewing",
        to_state: "queued_for_planning",
        stage: "review",
        metadata_json: expect.objectContaining({
          nextPlanVersion: 2,
          planningAttemptCountReset: true,
          previousPlanningAttemptCount: 0,
        }),
      }),
    );
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toContain("review");
    expect(artifactStages).not.toEqual(
      expect.arrayContaining(["trace", "verify"]),
    );
  });

  it("blocks code-change plans missing mandatory guardrail reports before invoking the reviewer provider", async () => {
    const { consumer, oneShotDb, publisher, reviewerProvider } = buildDeps({
      plan: buildLegacyCompactPlan(),
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(reviewerProvider.reviewPlan).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.objectContaining({
        current_review_version: 1,
        review_loop_count: 1,
        last_error: null,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
    const persistedReview = oneShotDb.artifacts.upsertArtifact.mock.calls.find(
      ([artifact]) => artifact.stage === "review",
    )?.[0];
    expect(persistedReview).toEqual(
      expect.objectContaining({
        provider: "deterministic_guardrail",
        model: "plan-contract-v1",
        metadata_json: expect.objectContaining({
          decision: "NEEDS_CHANGES",
        }),
      }),
    );
  });

  it("resolves legacy Sonar qualification artifacts to the sonar lane", async () => {
    const sonarPlan = buildPlan();
    sonarPlan.guardrailReport.domainChecks.push({
      id: "sonar-remediation-scope",
      severity: "high",
      status: "passed",
      applicabilityReason:
        "Qualification labels include SONAR-AUTOFIX, so Sonar remediation scope applies.",
      evidence: ["Legacy qualification artifact includes SONAR-AUTOFIX."],
      requiredAction: "Keep changes scoped to the Sonar remediation plan.",
    });
    const { consumer, reviewerProvider } = buildDeps({
      qualificationArtifact: {
        jiraLabels: ["SONAR-AUTOFIX", "security"],
        ticketSummary: "[Security] Sonar vulnerability story",
      },
      plan: sonarPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(reviewerProvider.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        processingMode: "sonar_autofix",
        jiraLabels: ["SONAR-AUTOFIX", "security"],
      }),
    );
  });

  it("queues implementation for approved code-change plans", async () => {
    const { consumer, oneShotDb, publisher, s3Client } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toEqual(
      expect.arrayContaining(["review", "trace", "verify"]),
    );
    expect(artifactStages.indexOf("review")).toBeLessThan(
      artifactStages.indexOf("trace"),
    );
    expect(artifactStages.indexOf("trace")).toBeLessThan(
      artifactStages.indexOf("verify"),
    );
    expect(s3Client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: "oneshot/CPDEV-20686/run-42/trace/v1/test-cases.csv",
          ContentType: "text/csv",
        }),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_implementation",
        updates: expect.objectContaining({
          current_review_version: 1,
          current_implementation_version: 1,
          final_disposition: null,
        }),
        notification: expect.objectContaining({
          notification_type: "review_completed",
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
    expect(oneShotDb.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        oneshot_run_id: 42,
        jira_key: "CPDEV-20686",
        notification_type: "implementation_plan_ready",
        body_markdown: expect.stringContaining(
          "implementation-plan-CPDEV-20686-v1-r1.md",
        ),
      }),
    );
    expect(oneShotDb.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
        body_markdown: expect.not.stringContaining(
          "# OneShot Plan for CPDEV-20686",
        ),
      }),
    );
    expect(jiraAttachFileToIssueMock).toHaveBeenCalledWith(
      "CPDEV-20686",
      "implementation-plan-CPDEV-20686-v1-r1.md",
      expect.stringContaining("# OneShot Plan for CPDEV-20686"),
      "text/markdown",
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "implementation_plan_jira_post_completed",
        stage: "review",
        metadata_json: expect.objectContaining({
          filename: "implementation-plan-CPDEV-20686-v1-r1.md",
          attachmentStatus: "attached",
          commentStatus: "enqueued",
        }),
      }),
    );
    const planNotificationCallIndex =
      oneShotDb.notifications.createNotification.mock.calls.findIndex(
        ([notification]) =>
          notification.notification_type === "implementation_plan_ready",
      );
    expect(planNotificationCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      oneShotDb.notifications.createNotification.mock.invocationCallOrder[
        planNotificationCallIndex
      ],
    ).toBeGreaterThan(publisher.publishStageMessage.mock.invocationCallOrder[0]);
  });

  it("posts reviewer Jira attachments with DB-backed QUALIFIER credentials", async () => {
    const { consumer } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      jiraAgent: {
        jira_username: "devai@mhk.com",
        jira_token: "db-backed-token",
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    const jiraConfigs = jiraClientConstructorMock.mock.calls.map(
      ([config]) => config,
    );
    expect(jiraConfigs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          baseUrl: "https://jira.example.test",
          username: "devai@mhk.com",
          token: "db-backed-token",
        }),
      ]),
    );
    expect(jiraConfigs).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          token: "secret-token",
        }),
      ]),
    );
  });

  it("does not duplicate implementation plan Jira postback when marker already completed", async () => {
    const { consumer, oneShotDb } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      priorEvents: [
        {
          id: 900,
          oneshot_run_id: 42,
          event_type: "implementation_plan_jira_post_completed",
          from_state: "reviewing",
          to_state: "queued_for_implementation",
          stage: "review",
          metadata_json: {
            filename: "implementation-plan-CPDEV-20686-v1-r1.md",
            attachmentStatus: "attached",
            commentStatus: "enqueued",
            notificationId: 321,
          },
          occurred_at: new Date(),
        },
      ],
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(jiraAttachFileToIssueMock).not.toHaveBeenCalledWith(
      "CPDEV-20686",
      "implementation-plan-CPDEV-20686-v1-r1.md",
      expect.anything(),
      expect.anything(),
    );
    expect(oneShotDb.notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
      }),
    );
  });

  it("continues implementation with compact comment when implementation-plan attachment fails", async () => {
    jiraAttachFileToIssueMock
      .mockResolvedValueOnce({ status: "attached" })
      .mockRejectedValueOnce(new Error("upload boom"));
    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
    expect(oneShotDb.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
        body_markdown: expect.stringContaining(
          "Plan attachment status: failed",
        ),
      }),
    );
    const planNotificationCallIndex =
      oneShotDb.notifications.createNotification.mock.calls.findIndex(
        ([notification]) =>
          notification.notification_type === "implementation_plan_ready",
      );
    expect(planNotificationCallIndex).toBeGreaterThanOrEqual(0);
    expect(
      oneShotDb.notifications.createNotification.mock.invocationCallOrder[
        planNotificationCallIndex
      ],
    ).toBeGreaterThan(publisher.publishStageMessage.mock.invocationCallOrder[0]);
  });

  it("records implementation-plan attachment as skipped when Jira mutations are disabled", async () => {
    jiraAttachFileToIssueMock
      .mockResolvedValueOnce({ status: "attached" })
      .mockResolvedValueOnce({ status: "skipped", reason: "mutations_disabled" });
    const { consumer, oneShotDb } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
        body_markdown: expect.stringContaining("Plan attachment status: skipped"),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "implementation_plan_jira_post_completed",
        metadata_json: expect.objectContaining({
          filename: "implementation-plan-CPDEV-20686-v1-r1.md",
          attachmentStatus: "skipped",
          attachmentError: "mutations_disabled",
        }),
      }),
    );
  });

  it("does not enqueue implementation plan Jira notification when disabled", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      configOverrides: {
        implementationPlanPostToJira: false,
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
    expect(oneShotDb.notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
      }),
    );
  });

  it("continues implementation when implementation-plan notification enqueue fails", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      notificationError: new Error("notification insert failed"),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "implementation_plan_ready_notification_failed",
        stage: "review",
        metadata_json: expect.objectContaining({
          planVersion: 1,
          reviewRound: 1,
          implementationVersion: 1,
          error: "notification insert failed",
        }),
      }),
    );
  });

  it("keeps VERIFY rejection advisory after Validate approves the plan", async () => {
    verifyOneShotTraceArtifactMock.mockImplementation((input) => ({
      jiraKey: input.trace.jiraKey,
      planVersion: input.trace.planVersion,
      generatedAt: "2026-04-17T12:00:00.000Z",
      mode: "balanced",
      recommendation: "REJECTED",
      riskLevel: "HIGH",
      traceTestCaseCount: input.trace.testCases.length,
      sectionCounts: {
        A: input.trace.sections.A.length,
        B: input.trace.sections.B.length,
        C: input.trace.sections.C.length,
      },
      acceptanceCriteriaCoverage: input.trace.acceptanceCriteriaCoverage,
      gaps: [
        {
          id: "verify_forced_rejection",
          severity: "critical",
          message:
            "Forced verifier rejection for reviewer advisory-flow coverage.",
          affectedAcceptanceCriteria: ["Reviewer transitions are correct"],
          testCaseId: input.trace.testCases[0]?.id,
        },
      ],
      verifyGuardrailResult: input.trace.traceGuardrailResult,
      unverifiedClaims: ["UNABLE_TO_VERIFY: forced verifier rejection."],
      degradedModeDisclaimers: [],
    }));

    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "verify",
        status: "completed",
        metadata_json: expect.objectContaining({
          recommendation: "REJECTED",
          riskLevel: "HIGH",
          criticalGapCount: 1,
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
    expect(
      oneShotDb.runs.updateRunStateIfCurrentState,
    ).not.toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.anything(),
    );
  });

  it("completes approved verification-only plans without queueing implementation", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify the existing remediation is already applied.",
      implementationMode: "verification_only",
    };
    const { consumer, oneShotDb, publisher, s3Client } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(oneShotDb.notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
      }),
    );
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toEqual(
      expect.arrayContaining(["review", "trace", "verify"]),
    );
    expect(s3Client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: "artifact-bucket",
          Key: "oneshot/CPDEV-20686/run-42/verification-only/v1/completion.json",
          ContentType: "application/json",
        }),
      }),
    );
    expect(oneShotDb.artifacts.mergeArtifactMetadata).toHaveBeenCalledWith(
      42,
      "review",
      1,
      expect.objectContaining({
        artifact_kind: "verification_only_completion",
        verification_only_completion: expect.objectContaining({
          s3_key:
            "oneshot/CPDEV-20686/run-42/verification-only/v1/completion.json",
          reason: "Plan declares implementationMode=verification_only.",
        }),
      }),
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "completed",
        updates: expect.objectContaining({
          current_review_version: 1,
          final_disposition: "completed_no_action",
          last_error: null,
        }),
        notification: expect.objectContaining({
          notification_type: "verification_only_completed",
          body_markdown: expect.stringContaining("No PR Required"),
        }),
        workspaceCleanupContext: expect.any(Object),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "verification_only_completed",
        from_state: "reviewing",
        to_state: "completed",
        stage: "review",
        metadata_json: expect.objectContaining({
          version: 1,
          reviewRound: 1,
          targetFiles: ["src/example.ts", "src/example.test.ts"],
          validationSteps: ["npm test -- src/oneshot"],
        }),
      }),
    );
  });

  it("does not apply retrofit verification-only guardrails to non-retrofit qualification metadata", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify the existing remediation is already applied.",
      implementationMode: "verification_only",
    };
    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Normal verification ticket",
        repoSelectionMetadata: {
          retrofitContext: null,
          retrofitSourceEvidence: null,
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "completed",
        updates: expect.objectContaining({
          final_disposition: "completed_no_action",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).not.toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.anything(),
    );
  });

  it("does not apply retrofit verification-only guardrails to non-retrofit multi-repo child metadata", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify this multi-repo child already satisfies its scope.",
      implementationMode: "verification_only",
    };
    const { consumer, publisher } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Normal multi-repo verification child",
        repoSelectionMetadata: {
          multiRepoBrief: {
            repoRef: "core-app",
            objective: "Verify core-app child scope.",
            acceptanceCriteria: ["The core-app child requires no code changes."],
            mergeOrder: 1,
          },
          retrofitContext: null,
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "completed",
        updates: expect.objectContaining({
          final_disposition: "completed_no_action",
        }),
      }),
    );
  });

  it("requires deterministic already-applied evidence before completing retrofit verification-only plans", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify CPDEV-24856 is already present.",
      implementationMode: "verification_only",
      plannerDiscoveries: {
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-24856",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.0",
          selectedCommits: [
            {
              sha: "de882e2",
              subject: "CPDEV-24856 Tufts | Fix Dropdown Sort Issue",
              files: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
              alreadyApplied: false,
            },
          ],
          touchedFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
          ],
          alreadyApplied: false,
          evidenceSummary:
            "The planner inspected a semantic sort path but did not prove the source patch is present.",
        },
      },
    };
    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
    expect(transitionRunWithNotificationMock).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "completed",
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.objectContaining({
        last_error: null,
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        to_state: "queued_for_planning",
      }),
    );
  });

  it("requires deterministic evidence for single-target retrofit verification-only plans identified by qualification metadata", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify CPDEV-24856 is already present on the target branch.",
      implementationMode: "verification_only",
    };
    const { consumer, publisher } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Retrofit CPDEV-24856",
        repoSelectionMetadata: {
          retrofitContext: {
            sourceJiraKey: "CPDEV-24856",
            sourceBranch: "master",
            targetBranch: "medhok-monorepo-4.0",
          },
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
  });

  it("requires selected source commit evidence in retrofit plans identified by qualification metadata", async () => {
    const retrofitPlanWithoutEvidence = {
      ...buildPlan(),
      summary: "Retrofit CPDEV-24856 onto the target branch.",
      implementationMode: "code_change",
    };
    const { consumer, publisher, reviewerProvider } = buildDeps({
      plan: retrofitPlanWithoutEvidence,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Retrofit CPDEV-24856",
        repoSelectionMetadata: {
          templateMatched: "retrofit_template",
          retrofitContext: {
            sourceJiraKey: "CPDEV-24856",
            sourceBranch: "master",
            targetBranch: "medhok-monorepo-4.2",
          },
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(reviewerProvider.reviewPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        retrofitContext: expect.objectContaining({
          sourceJiraKey: "CPDEV-24856",
        }),
        retrofitSourceEvidence: null,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
  });

  it("requires deterministic evidence for multi-branch retrofit child verification-only plans", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify CPDEV-24856 is already present on medhok-monorepo-4.1.",
      implementationMode: "verification_only",
    };
    const { consumer, publisher } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Multi-branch retrofit child",
        repoSelectionMetadata: {
          multiBranchRetrofitBrief: {
            sourceJiraKey: "CPDEV-24856",
            repoRef: "core-app",
            sourceBranch: "master",
            targetBranch: "medhok-monorepo-4.1",
            targetOrder: 2,
            totalTargets: 3,
          },
          retrofitContext: {
            sourceJiraKey: "CPDEV-24856",
            sourceBranch: "master",
            targetBranch: "medhok-monorepo-4.1",
          },
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
  });

  it("requires deterministic evidence for multi-repo retrofit child verification-only plans", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify CPDEV-24856 is already present for core-app.",
      implementationMode: "verification_only",
    };
    const { consumer, publisher } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Multi-repo retrofit child",
        repoSelectionMetadata: {
          multiRepoBrief: {
            repoRef: "core-app",
            objective: "Retrofit CPDEV-24856 source changes for core-app.",
            acceptanceCriteria: [
              "The target branch contains the source patch for CPDEV-24856.",
            ],
            mergeOrder: 1,
          },
          retrofitContext: {
            sourceJiraKey: "CPDEV-24856",
            sourceBranch: "master",
            targetBranch: "medhok-monorepo-4.2",
          },
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
  });

  it("completes retrofit verification-only plans when deterministic evidence proves the patch is already applied", async () => {
    const verificationPlan = {
      ...buildPlan(),
      summary: "Verify CPDEV-24856 is already present.",
      implementationMode: "verification_only",
      plannerDiscoveries: {
        retrofitEvidence: {
          sourceJiraKey: "CPDEV-24856",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.2",
          selectedCommits: [
            {
              sha: "de882e2",
              subject: "CPDEV-24856 Tufts | Fix Dropdown Sort Issue",
              files: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
              alreadyApplied: true,
            },
          ],
          touchedFiles: [
            "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
          ],
          alreadyApplied: true,
          evidenceSummary:
            "The exact source patch is already present on the target branch.",
        },
        retrofitExecutionContract: {
          version: "retrofit_execution_contract.v1",
          sourceJiraKey: "CPDEV-24856",
          sourceBranch: "master",
          targetBranch: "medhok-monorepo-4.2",
          commitSelectionMethod: "source_pr",
          sourceCommitSelectionComplete: true,
          selectedCommits: [
            {
              sha: "de882e2",
              subject: "CPDEV-24856 Tufts | Fix Dropdown Sort Issue",
              sourceFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
              targetFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
              adaptationFiles: [],
              status: "already_applied",
              proofSnippets: [
                "Target branch already contains the CPDEV-24856 UIComponentDetailView.java source patch.",
              ],
              validationEvidence: [
                "Patch-equivalence check confirmed de882e2 is already applied.",
              ],
            },
          ],
          allowedFileMappings: [
            {
              sourceSha: "de882e2",
              sourceFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
              targetFiles: [
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
              adaptationFiles: [],
              rationale:
                "Target branch uses the same UIComponentDetailView.java source file for de882e2.",
              evidence: [
                "de882e2",
                "MedicalMgmt/src/main/java/com/medhok/mm/client/admin/UIComponentDetailView.java",
              ],
            },
          ],
        },
      },
    };
    const { consumer, publisher } = buildDeps({
      plan: verificationPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Retrofit CPDEV-24856",
        repoSelectionMetadata: {
          retrofitContext: {
            sourceJiraKey: "CPDEV-24856",
            sourceBranch: "master",
            targetBranch: "medhok-monorepo-4.2",
          },
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "completed",
        updates: expect.objectContaining({
          final_disposition: "completed_no_action",
        }),
      }),
    );
  });

  it("completes approved legacy no-change plans through the fallback detector", async () => {
    const { consumer, publisher } = buildDeps({
      plan: {
        ...buildPlan(),
        summary:
          "No code changes required; existing behavior satisfies the ticket.",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(publisher.publishStageMessage).not.toHaveBeenCalled();
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "completed",
        updates: expect.objectContaining({
          final_disposition: "completed_no_action",
        }),
      }),
    );
  });

  it("queues implementation when explicit code-change plans contain legacy no-change text", async () => {
    const { consumer, publisher } = buildDeps({
      plan: {
        ...buildPlan(),
        summary:
          "No code changes required for the existing helper; update the queue wiring.",
        implementationMode: "code_change",
      },
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_implementation",
        updates: expect.objectContaining({
          current_implementation_version: 1,
          final_disposition: null,
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
  });

  it("does not complete no-action when an approved review still has blocking findings", async () => {
    const { consumer, publisher } = buildDeps({
      plan: {
        ...buildPlan(),
        implementationMode: "verification_only",
      },
      review: buildReview({
        decision: "APPROVED",
        requiredChanges: [],
        blockingFindings: ["Validation evidence is incomplete."],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_implementation",
        updates: expect.objectContaining({
          final_disposition: null,
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
  });

  it("reverts planning queue state when publish fails after reviewer replanning transition", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({ planning_attempt_count: 2 }),
    });
    publisher.publishStageMessage.mockRejectedValueOnce(new Error("sqs down"));

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "queued_for_planning",
      "reviewing",
      expect.objectContaining({
        current_review_version: null,
        review_loop_count: 0,
        planning_attempt_count: 2,
        final_disposition: null,
        last_error: "sqs down",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_planning",
        to_state: "reviewing",
        stage: "review",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          reviewRound: 1,
          nextPlanVersion: 2,
          publishError: "sqs down",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_review",
      { last_error: "sqs down" },
    );
    expect(oneShotDb.notifications.createNotification).not.toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
      }),
    );
  });

  it("reverts planning queue state before lease-loss recovery after reviewer replanning transition", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps();
    publisher.publishStageMessage.mockRejectedValueOnce(
      new Error("Lost OneShot workspace lease during review"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "queued_for_planning",
      "reviewing",
      expect.objectContaining({
        review_loop_count: 0,
        last_error: "Lost OneShot workspace lease during review",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_planning",
        to_state: "reviewing",
        stage: "review",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          publishError: "Lost OneShot workspace lease during review",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_review",
      {
        last_error:
          "Workspace lease lost during review; stage requeued for retry",
      },
    );
  });

  it("requeues after workspace lease loss without review failure side effects", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      providerError: new Error("Lost OneShot workspace lease during review"),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_review",
      {
        last_error:
          "Workspace lease lost during review; stage requeued for retry",
      },
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_transition",
        from_state: "reviewing",
        to_state: "queued_for_review",
        stage: "review",
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

  it("continues to implementation when NEEDS_CHANGES exhausts loops in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({ review_loop_count: 3 }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_implementation",
        updates: expect.objectContaining({
          current_review_version: 1,
          current_implementation_version: 1,
          review_loop_count: 4,
          final_disposition: null,
        }),
        notification: expect.objectContaining({
          notification_type: "review_completed",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "review_loop_exhausted",
          originalDecision: "NEEDS_CHANGES",
          requiredChanges: ["Tighten the plan before implementation"],
        }),
      }),
    );
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toEqual(
      expect.arrayContaining(["review", "trace", "verify"]),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
    expect(oneShotDb.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "implementation_plan_ready",
        body_markdown: expect.stringContaining(
          "Handoff status: soft-gated to implementation",
        ),
      }),
    );
  });

  it("reverts implementation queue state when publish fails after review transition", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({
        review_loop_count: 3,
        current_review_version: null,
        current_implementation_version: null,
      }),
    });
    publisher.publishStageMessage.mockRejectedValueOnce(new Error("sqs down"));

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_implementation",
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "queued_for_implementation",
      "reviewing",
      expect.objectContaining({
        current_review_version: null,
        current_implementation_version: null,
        review_loop_count: 3,
        last_error: "sqs down",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_implementation",
        to_state: "reviewing",
        stage: "review",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          reviewRound: 1,
          implementationVersion: 1,
          publishError: "sqs down",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_review",
      { last_error: "sqs down" },
    );
  });

  it("reverts implementation queue state before lease-loss recovery after review transition", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({
        review_loop_count: 3,
        current_review_version: null,
        current_implementation_version: null,
      }),
    });
    publisher.publishStageMessage.mockRejectedValueOnce(
      new Error("Lost OneShot workspace lease during review"),
    );

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(false);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "queued_for_implementation",
      "reviewing",
      expect.objectContaining({
        last_error: "Lost OneShot workspace lease during review",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "state_revert",
        from_state: "queued_for_implementation",
        to_state: "reviewing",
        stage: "review",
        metadata_json: expect.objectContaining({
          reason: "publish_failed",
          publishError: "Lost OneShot workspace lease during review",
        }),
      }),
    );
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_review",
      {
        last_error:
          "Workspace lease lost during review; stage requeued for retry",
      },
    );
  });

  it("blocks exhausted NEEDS_CHANGES when blocking mode is enabled", async () => {
    const { consumer } = buildDeps({
      run: buildRun({ review_loop_count: 3 }),
      configOverrides: { reviewStagesBlockOnExhaustion: true },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "escalated",
        updates: expect.objectContaining({
          final_disposition: "review_escalated",
        }),
        notification: expect.objectContaining({
          notification_type: "review_escalated",
        }),
      }),
    );
  });

  it("treats BLOCKED as a soft refinement when review loop budget remains", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      review: buildReview({
        decision: "BLOCKED",
        requiredChanges: [],
        blockingFindings: ["The plan omits a required safety check"],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.objectContaining({
        review_loop_count: 1,
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "blocked_replanned",
          originalDecision: "BLOCKED",
          blockingFindings: ["The plan omits a required safety check"],
        }),
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toContain("review");
    expect(artifactStages).not.toEqual(
      expect.arrayContaining(["trace", "verify"]),
    );
  });

  it("continues to implementation with TRACE and VERIFY when BLOCKED exhausts loops in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      run: buildRun({ review_loop_count: 3 }),
      review: buildReview({
        decision: "BLOCKED",
        requiredChanges: [],
        blockingFindings: ["The plan omits a required safety check"],
      }),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "blocked_review_loop_exhausted",
          originalDecision: "BLOCKED",
        }),
      }),
    );
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toEqual(
      expect.arrayContaining(["review", "trace", "verify"]),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
  });

  it("continues to implementation after provider retry exhaustion in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher } = buildDeps({
      providerError: new Error("OpenAI reviewer timed out"),
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
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toContain("review");
    expect(artifactStages).not.toEqual(
      expect.arrayContaining(["trace", "verify"]),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
  });

  it("fails after provider success when review artifact persistence is exhausted", async () => {
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

  it("continues to implementation on review budget skip in soft-gate mode", async () => {
    const { consumer, oneShotDb, publisher, reviewerProvider } = buildDeps({
      budgetWithin: false,
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(reviewerProvider.reviewPlan).not.toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "soft_gate",
        metadata_json: expect.objectContaining({
          softGateContinued: true,
          softGateReason: "stage_budget_exceeded",
        }),
      }),
    );
    const artifactStages = oneShotDb.artifacts.upsertArtifact.mock.calls.map(
      ([artifact]) => artifact.stage,
    );
    expect(artifactStages).toContain("review");
    expect(artifactStages).not.toEqual(
      expect.arrayContaining(["trace", "verify"]),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      1,
      "queued_for_implementation",
      false,
    );
  });

  it("rejects weak plan contracts before budget soft-gate implementation", async () => {
    const { consumer, oneShotDb, publisher, reviewerProvider } = buildDeps({
      budgetWithin: false,
      plan: buildLegacyCompactPlan(),
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(reviewerProvider.reviewPlan).not.toHaveBeenCalled();
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "deterministic_guardrail",
        model: "plan-contract-v1",
      }),
    );
    expect(oneShotDb.artifacts.getArtifactsForRun).not.toHaveBeenCalled();
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.objectContaining({
        review_loop_count: 1,
      }),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      2,
      "queued_for_planning",
      true,
    );
    expect(publisher.publishStageMessage).not.toHaveBeenCalledWith(
      42,
      "implementation",
      expect.any(Number),
      expect.any(String),
      expect.any(Boolean),
    );
  });

  it("attributes artifact + telemetry to anthropic when provider reports providerName='anthropic'", async () => {
    const { consumer, oneShotDb } = buildDeps({
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
    });

    (consumer as unknown as { reviewerProvider: unknown }).reviewerProvider = {
      providerName: "anthropic" as const,
      modelId: "us.anthropic.claude-opus-4-6-v1",
      reviewPlan: vi.fn().mockResolvedValue({
        review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
        rawOutput: "{}",
        metrics: {
          durationMs: 1_234,
          tokensUsed: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0 },
          costUsd: 0.25,
        },
      }),
    };

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(recordLlmMetricsMock).toHaveBeenCalledWith(
      "review",
      "anthropic",
      expect.any(Number),
      expect.any(Object),
      expect.any(Number),
    );
    // Budget accounting counts input + output only (150 = 100 + 50). Cache
    // tokens are kept in the artifact for observability but don't feed the
    // run budget — see planner.ts:calculateTokenUsage for rationale.
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "anthropic",
        model: "us.anthropic.claude-opus-4-6-v1",
        metadata_json: expect.objectContaining({
          stage_tokens_used: 150,
          tokens_used: {
            input: 100,
            output: 50,
            cacheRead: 10,
            cacheWrite: 0,
          },
        }),
      }),
    );
    expect(oneShotDb.runs.addTokenUsage).toHaveBeenCalledWith(42, 150);
  });
});

// ---------------------------------------------------------------------------
// Retrofit coverage and file-scope enforcement unit tests (SPEC-5)
// ---------------------------------------------------------------------------

import {
  validateRetrofitCoverage,
  validateRetrofitFileScope,
} from "./reviewer.js";
import type { RetrofitCommitManifest } from "../retrofit-source-evidence.js";

describe("validateRetrofitCoverage", () => {
  it("returns empty array when all commits are already_applied", () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        { sha: "abc1234", subject: "Fix A", files: ["src/A.ts"], status: "already_applied" },
        { sha: "def5678", subject: "Fix B", files: ["src/B.ts"], status: "already_applied" },
      ],
    };
    expect(validateRetrofitCoverage(manifest)).toEqual([]);
  });

  it("returns empty array when all commits are clean_applied", () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        { sha: "abc1234", subject: "Fix A", files: [], status: "clean_applied" },
      ],
    };
    expect(validateRetrofitCoverage(manifest)).toEqual([]);
  });

  it("returns empty array when all commits are adapted", () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        { sha: "abc1234", subject: "Fix A", files: [], status: "adapted" },
      ],
    };
    expect(validateRetrofitCoverage(manifest)).toEqual([]);
  });

  it("returns empty array when failed commits have excludedRationale", () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        {
          sha: "abc1234",
          subject: "Test-only change",
          files: [],
          status: "failed",
          excludedRationale: "Test-only commit not needed on target branch",
        },
      ],
    };
    expect(validateRetrofitCoverage(manifest)).toEqual([]);
  });

  it("flags a failed commit as retrofit_patch_incomplete", () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        { sha: "abc1234", subject: "Add response.getHeaders() capture", files: ["src/Client.ts"], status: "failed" },
      ],
    };
    const result = validateRetrofitCoverage(manifest);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("retrofit_patch_incomplete");
    expect(result[0]).toContain("abc1234");
    expect(result[0]).toContain("Add response.getHeaders() capture");
  });

  it("flags a not_attempted commit as retrofit_patch_incomplete", () => {
    const manifest: RetrofitCommitManifest = {
      entries: [
        { sha: "bcd5678", subject: "Capture success response headers", files: ["src/Client.ts"], status: "not_attempted" },
      ],
    };
    const result = validateRetrofitCoverage(manifest);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("retrofit_patch_incomplete");
    expect(result[0]).toContain("bcd5678");
  });

  it("catches the PR #82 -> #83 class of missing-hunk regression", () => {
    // Simulates a 7-commit source PR where the 'response.getHeaders()' capture
    // hunk was silently dropped. The commit is in failed/not_attempted status
    // because the patch was never applied.
    const manifest: RetrofitCommitManifest = {
      entries: [
        { sha: "sha-1", subject: "CPDEV-24856 Add authorization header", files: ["src/AuthClient.ts"], status: "clean_applied" },
        { sha: "sha-2", subject: "CPDEV-24856 Handle request retry", files: ["src/AuthClient.ts"], status: "clean_applied" },
        { sha: "sha-3", subject: "CPDEV-24856 Log request start", files: ["src/AuthClient.ts"], status: "already_applied" },
        { sha: "sha-4", subject: "CPDEV-24856 Capture response.getHeaders() on success", files: ["src/AuthClient.ts"], status: "failed" },
        { sha: "sha-5", subject: "CPDEV-24856 Update tests", files: ["src/AuthClient.test.ts"], status: "clean_applied" },
        { sha: "sha-6", subject: "CPDEV-24856 Add integration test", files: ["src/AuthClient.test.ts"], status: "clean_applied" },
        { sha: "sha-7", subject: "CPDEV-24856 Update changelog", files: ["CHANGELOG.md"], status: "clean_applied" },
      ],
    };
    const result = validateRetrofitCoverage(manifest);
    // Only sha-4 is unaccounted; it would be caught
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("sha-4");
    expect(result[0]).toContain("response.getHeaders()");
    expect(result[0]).toContain("retrofit_patch_incomplete");
  });
});

describe("validateRetrofitFileScope", () => {
  it("returns empty array when all changed files are within the allowlist", () => {
    const changedFiles = ["src/AuthClient.ts", "src/AuthClient.test.ts"];
    const allowedFiles = ["src/AuthClient.ts", "src/AuthClient.test.ts", "src/OtherFile.ts"];
    expect(validateRetrofitFileScope(changedFiles, allowedFiles)).toEqual([]);
  });

  it("flags files outside the allowlist", () => {
    const changedFiles = ["src/AuthClient.ts", "src/UnrelatedFile.ts"];
    const allowedFiles = ["src/AuthClient.ts"];
    const result = validateRetrofitFileScope(changedFiles, allowedFiles);
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("retrofit_patch_incomplete");
    expect(result[0]).toContain("src/UnrelatedFile.ts");
  });

  it("returns empty array when changedFiles is empty", () => {
    expect(validateRetrofitFileScope([], ["src/AuthClient.ts"])).toEqual([]);
  });

  it("flags all out-of-allowlist files individually", () => {
    const changedFiles = ["src/A.ts", "src/B.ts", "src/C.ts"];
    const allowedFiles = ["src/A.ts"];
    const result = validateRetrofitFileScope(changedFiles, allowedFiles);
    expect(result).toHaveLength(2);
    expect(result.some((r) => r.includes("src/B.ts"))).toBe(true);
    expect(result.some((r) => r.includes("src/C.ts"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T6 — Retrofit plan-review file-scope gate (SPEC-2)
// ---------------------------------------------------------------------------
describe("ReviewerConsumer retrofit plan-review file-scope gate (T6)", () => {
  it("forces NEEDS_CHANGES when approved retrofit plan targets out-of-source files without adaptation rationale", async () => {
    const retrofitPlan = {
      ...buildPlan(),
      implementationMode: "code_change",
      specs: [
        {
          id: "spec-1",
          objective: "Apply retrofit changes",
          acceptanceCriteria: ["Source changes are applied"],
          targetFiles: [
            "src/example.ts",
            "src/OutOfScope.ts", // NOT in touchedFiles
          ],
          implementationNotes: ["Apply the source patch"],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: "src/example.ts",
          role: "runtime_required",
          editable: true,
          rationale: "Source file",
          supportingEvidence: [],
          allowedChanges: [],
        },
        {
          path: "src/example.test.ts",
          role: "test_required",
          editable: true,
          rationale: "Focused regression coverage for the source file.",
          supportingEvidence: [],
          allowedChanges: [],
        },
      ],
    };
    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: retrofitPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
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
            selectedCommits: [
              { sha: "abc1234", subject: "CPDEV-12345 fix", files: ["src/example.ts"] },
            ],
            touchedFiles: ["src/example.ts"], // OutOfScope.ts is NOT here
            evidenceSummary: "Source changes to AuthClient only.",
          },
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // NEEDS_CHANGES routes the run back to planning via updateRunStateIfCurrentState
    expect(oneShotDb.runs.updateRunStateIfCurrentState).toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.anything(),
    );
    // And queues re-planning
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "planning",
      expect.any(Number),
      "queued_for_planning",
      true,
    );
  });

  it("allows out-of-source retrofit files explicitly listed with editable rationale", async () => {
    const retrofitPlan = {
      ...buildPlan(),
      implementationMode: "code_change",
      specs: [
        {
          id: "spec-1",
          objective: "Apply retrofit changes to target branch equivalent file",
          acceptanceCriteria: ["Source changes are adapted"],
          targetFiles: ["src/example.ts", "src/TargetBranchEquivalent.ts"],
          implementationNotes: ["Apply the source patch intent"],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: "src/example.ts",
          role: "runtime_required",
          editable: true,
          rationale: "Source file",
          supportingEvidence: [],
          allowedChanges: [],
        },
        {
          path: "src/TargetBranchEquivalent.ts",
          role: "runtime_required",
          editable: true,
          rationale:
            "Target branch renamed the source implementation, so this file is the explicit adaptation target.",
          supportingEvidence: [
            "Source commit abc1234 changes src/example.ts; target branch equivalent is src/TargetBranchEquivalent.ts.",
          ],
          allowedChanges: ["Adapt only the source patch behavior from abc1234."],
        },
        {
          path: "src/example.test.ts",
          role: "test_required",
          editable: true,
          rationale: "Focused regression coverage for the adapted target.",
          supportingEvidence: [
            "Source commit abc1234 changes src/example.ts; this test verifies the adapted behavior.",
          ],
          allowedChanges: [
            "Add focused regression coverage for the source patch behavior from abc1234.",
          ],
        },
      ],
      plannerDiscoveries: {
        retrofitExecutionContract: {
          version: "retrofit_execution_contract.v1",
          sourceJiraKey: "CPDEV-12345",
          sourceBranch: "master",
          targetBranch: "release-4.0",
          commitSelectionMethod: "subject_grep_only",
          sourceCommitSelectionComplete: false,
          selectedCommits: [
            {
              sha: "abc1234",
              subject: "CPDEV-12345 fix",
              sourceFiles: ["src/example.ts"],
              targetFiles: ["src/example.ts"],
              adaptationFiles: [
                "src/TargetBranchEquivalent.ts",
                "src/example.test.ts",
              ],
              status: "adapted",
              rationale:
                "Target branch uses src/TargetBranchEquivalent.ts for the source implementation and needs focused regression coverage.",
              proofSnippets: [],
              validationEvidence: [],
            },
          ],
          allowedFileMappings: [
            {
              sourceSha: "abc1234",
              sourceFiles: ["src/example.ts"],
              targetFiles: ["src/example.ts"],
              adaptationFiles: [
                "src/TargetBranchEquivalent.ts",
                "src/example.test.ts",
              ],
              rationale:
                "Map source commit abc1234 from src/example.ts to the target branch equivalent and focused test.",
              evidence: [
                "abc1234",
                "src/example.ts",
                "src/TargetBranchEquivalent.ts",
              ],
            },
          ],
        },
      },
      plannedCodeChanges: [
        {
          targetFile: "src/example.ts",
          symbolOrRegion: "source behavior",
          changeType: "update",
          afterSketch: "Keep the source behavior aligned.",
          rationale: "Source file remains part of the retrofit scope.",
          supportingEvidence: ["Reviewed src/example.ts."],
          confidence: "high",
        },
        {
          targetFile: "src/TargetBranchEquivalent.ts",
          symbolOrRegion: "target branch equivalent behavior",
          changeType: "update",
          afterSketch: "Adapt only the source patch behavior into the target branch equivalent file.",
          rationale:
            "The target branch renamed the source implementation, so this file receives the adaptation.",
          supportingEvidence: ["Compared source and target branch file layout."],
          confidence: "high",
        },
      ],
      implementerGuardrails: [
        {
          id: "retrofit-file-scope",
          instruction:
            "Only edit source touched files, explicit adaptation files, or their focused tests.",
          appliesToFiles: [
            "src/example.ts",
            "src/TargetBranchEquivalent.ts",
            "src/example.test.ts",
          ],
          required: true,
        },
      ],
    };
    const { consumer, oneShotDb, publisher } = buildDeps({
      plan: retrofitPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
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
            selectedCommits: [
              {
                sha: "abc1234",
                subject: "CPDEV-12345 fix",
                files: ["src/example.ts"],
              },
            ],
            touchedFiles: ["src/example.ts"],
            evidenceSummary: "Source changes to example only.",
          },
        },
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    expect(oneShotDb.runs.updateRunStateIfCurrentState).not.toHaveBeenCalledWith(
      42,
      "reviewing",
      "queued_for_planning",
      expect.anything(),
    );
    expect(publisher.publishStageMessage).toHaveBeenCalledWith(
      42,
      "implementation",
      expect.any(Number),
      "queued_for_implementation",
      false,
    );
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_implementation",
      }),
    );
  });

  it("does not apply file-scope gate to non-retrofit plans", async () => {
    const normalPlan = {
      ...buildPlan(),
      implementationMode: "code_change",
      specs: [
        {
          id: "spec-1",
          objective: "Normal change",
          acceptanceCriteria: ["Change is made"],
          targetFiles: ["src/example.ts", "src/AnyOtherFile.ts"],
          implementationNotes: ["Implement normally"],
          validationSteps: ["npm test"],
        },
      ],
      fileChangeContract: [
        {
          path: "src/example.ts",
          role: "runtime_required",
          editable: true,
          rationale: "Source file",
          supportingEvidence: [],
          allowedChanges: [],
        },
        {
          path: "src/AnyOtherFile.ts",
          role: "runtime_required",
          editable: true,
          rationale: "Any file can be changed in non-retrofit",
          supportingEvidence: [],
          allowedChanges: [],
        },
      ],
    };
    const { consumer } = buildDeps({
      plan: normalPlan,
      review: buildReview({ decision: "APPROVED", requiredChanges: [] }),
      qualificationArtifact: {
        ticketSummary: "Normal ticket",
        repoSelectionMetadata: null,
      },
    });

    const shouldDelete = await consumer.processMessage(buildMessage(), 1);

    expect(shouldDelete).toBe(true);
    // Should queue for implementation, not send back for planning
    expect(transitionRunWithNotificationMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toState: "queued_for_implementation",
      }),
    );
  });
});
