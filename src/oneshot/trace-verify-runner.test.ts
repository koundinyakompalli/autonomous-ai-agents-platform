import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotConsumerConfig } from "./config.js";
import type { OneShotPlan } from "./schema/plan.js";
import type { OneShotRun } from "./types.js";

const { jiraAttachFileToIssueMock, jiraClientConstructorMock } = vi.hoisted(
  () => ({
    jiraAttachFileToIssueMock: vi
      .fn()
      .mockResolvedValue({ status: "attached" }),
    jiraClientConstructorMock: vi.fn(),
  }),
);

vi.mock("../orchestrator/JiraClient.js", () => ({
  JiraClient: vi.fn(function (
    this: { attachFileToIssue?: unknown },
    config: unknown,
  ) {
    jiraClientConstructorMock(config);
    this.attachFileToIssue = jiraAttachFileToIssueMock;
  }),
}));

import { runOneShotTraceVerify } from "./trace-verify-runner.js";

function buildPlan(): OneShotPlan {
  return {
    jiraKey: "CPDEV-20686",
    repoName: "core-app",
    branchName: "master",
    baseCommitSha: "0123456789abcdef0123456789abcdef01234567",
    summary: "Generate final TRACE coverage after plan validation.",
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

function buildRun(): OneShotRun {
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
    state: "reviewing",
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
  };
}

function buildDeps(
  options: { priorEvents?: Array<Record<string, unknown>> } = {},
) {
  const config = {
    artifactBucket: "artifact-bucket",
    artifactPrefix: "oneshot",
    traceEnabled: true,
    tracePostToJira: true,
    verifyEnabled: true,
    verifyMode: "balanced",
  } as OneShotConsumerConfig;
  const oneShotDb = {
    artifacts: {
      upsertArtifact: vi.fn().mockResolvedValue(undefined),
    },
    events: {
      getEventsForRun: vi.fn().mockResolvedValue(options.priorEvents ?? []),
      createEvent: vi.fn().mockResolvedValue(undefined),
    },
    notifications: {
      createNotification: vi.fn().mockResolvedValue(123),
    },
  };
  const s3Client = {
    send: vi.fn().mockResolvedValue({}),
  };

  return {
    config,
    oneShotDb,
    s3Client,
  };
}

describe("runOneShotTraceVerify", () => {
  beforeEach(() => {
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

  it("writes TRACE and VERIFY artifacts and posts Jira output from the review stage", async () => {
    const { config, oneShotDb, s3Client } = buildDeps();

    await runOneShotTraceVerify(
      {
        config,
        oneShotDb: oneShotDb as never,
        s3Client: s3Client as never,
        visibilityTimeoutSeconds: 300,
      },
      {
        run: buildRun(),
        plan: buildPlan(),
        planVersion: 1,
        ticketSummary: "Reviewer transitions are correct",
        stageStartedMs: Date.now(),
        eventStage: "review",
        eventState: "reviewing",
      },
    );

    expect(s3Client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: "oneshot/CPDEV-20686/run-42/trace/v1/test-cases.csv",
          ContentType: "text/csv",
        }),
      }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "trace", status: "completed" }),
    );
    expect(oneShotDb.artifacts.upsertArtifact).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "verify", status: "completed" }),
    );
    expect(jiraAttachFileToIssueMock).toHaveBeenCalledWith(
      "CPDEV-20686",
      "test-cases-CPDEV-20686.csv",
      expect.stringContaining(
        "References/Key ID,Req Id/Acceptance criteria ID,Test Case Id",
      ),
      "text/csv",
    );
    expect(oneShotDb.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "progress_update",
        body_markdown: expect.stringContaining(
          "OneShot | TRACE Test Cases Generated",
        ),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "trace_generated",
        from_state: "reviewing",
        to_state: "reviewing",
        stage: "review",
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "trace_jira_post_completed",
        from_state: "reviewing",
        to_state: "reviewing",
        stage: "review",
        metadata_json: expect.objectContaining({
          attachmentStatus: "attached",
          commentStatus: "enqueued",
          traceCsvS3Key: "oneshot/CPDEV-20686/run-42/trace/v1/test-cases.csv",
        }),
      }),
    );
  });

  it("posts TRACE attachments with supplied DB-backed Jira credentials", async () => {
    const { config, oneShotDb, s3Client } = buildDeps();

    await runOneShotTraceVerify(
      {
        config,
        oneShotDb: oneShotDb as never,
        s3Client: s3Client as never,
        visibilityTimeoutSeconds: 300,
        jiraCredentials: {
          username: "devai@mhk.com",
          token: "db-backed-token",
          source: "qualifier_agent",
        },
      },
      {
        run: buildRun(),
        plan: buildPlan(),
        planVersion: 1,
        ticketSummary: "Reviewer transitions are correct",
        stageStartedMs: Date.now(),
        eventStage: "review",
        eventState: "reviewing",
      },
    );

    expect(jiraClientConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: "https://jira.example.test",
        username: "devai@mhk.com",
        token: "db-backed-token",
      }),
    );
    expect(jiraClientConstructorMock).not.toHaveBeenCalledWith(
      expect.objectContaining({
        token: "secret-token",
      }),
    );
  });

  it("does not duplicate Jira attachment or comment when a post marker already completed", async () => {
    const { config, oneShotDb, s3Client } = buildDeps({
      priorEvents: [
        {
          id: 900,
          oneshot_run_id: 42,
          event_type: "trace_jira_post_completed",
          from_state: "reviewing",
          to_state: "reviewing",
          stage: "review",
          metadata_json: {
            traceCsvS3Key: "oneshot/CPDEV-20686/run-42/trace/v1/test-cases.csv",
            attachmentStatus: "attached",
            commentStatus: "enqueued",
            notificationId: 321,
          },
          occurred_at: new Date(),
        },
      ],
    });

    await runOneShotTraceVerify(
      {
        config,
        oneShotDb: oneShotDb as never,
        s3Client: s3Client as never,
        visibilityTimeoutSeconds: 300,
      },
      {
        run: buildRun(),
        plan: buildPlan(),
        planVersion: 1,
        stageStartedMs: Date.now(),
        eventStage: "review",
        eventState: "reviewing",
      },
    );

    expect(s3Client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Key: "oneshot/CPDEV-20686/run-42/trace/v1/test-cases.json",
        }),
      }),
    );
    expect(jiraAttachFileToIssueMock).not.toHaveBeenCalled();
    expect(oneShotDb.notifications.createNotification).not.toHaveBeenCalled();
  });

  it("records TRACE attachment as skipped when Jira mutations are disabled", async () => {
    jiraAttachFileToIssueMock.mockResolvedValueOnce({
      status: "skipped",
      reason: "mutations_disabled",
    });
    const { config, oneShotDb, s3Client } = buildDeps();

    await runOneShotTraceVerify(
      {
        config,
        oneShotDb: oneShotDb as never,
        s3Client: s3Client as never,
        visibilityTimeoutSeconds: 300,
      },
      {
        run: buildRun(),
        plan: buildPlan(),
        planVersion: 1,
        stageStartedMs: Date.now(),
        eventStage: "review",
        eventState: "reviewing",
      },
    );

    expect(oneShotDb.notifications.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        notification_type: "progress_update",
        body_markdown: expect.stringContaining("Jira attachment: skipped"),
      }),
    );
    expect(oneShotDb.events.createEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: "trace_jira_post_completed",
        metadata_json: expect.objectContaining({
          attachmentStatus: "skipped",
          attachmentError: "mutations_disabled",
        }),
      }),
    );
  });
});
