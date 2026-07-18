import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotDashboardRow } from "../types/oneshot.js";

const { queryMock, getOneShotRowByDashboardIdMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  getOneShotRowByDashboardIdMock: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getPool: () => ({
    query: queryMock,
  }),
}));

vi.mock("./oneshot.js", () => ({
  getOneShotRowByDashboardId: getOneShotRowByDashboardIdMock,
}));

const { getOneShotRunTimeline } = await import("./oneshotTimeline.js");

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-75",
    jiraKey: "CPDEV-20908",
    title: "Member Search",
    sourceTaskManagementId: 1824,
    oneshotRunId: 75,
    customerName: "MHK",
    displayState: "pr_open",
    progressStage: "pr_complete",
    progressPercent: 95,
    repoName: "core-app",
    repoUrl: "https://example.com/repo.git",
    baseBranch: "master",
    baseCommitSha: "abc123",
    implementationBranch: "oneshot/cpdev-20908-run-75",
    implementationCommitSha: "def456",
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    currentPrUrl: "https://example.com/pr/1457",
    qualificationSummary: null,
    lastError: null,
    lastErrorSummary: null,
    retry: null,
    deployment: {
      eligible: true,
      ready: true,
      light: "red",
      status: "ready",
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: "2026-04-22T01:54:03.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-04-22T02:13:16.000Z",
    totalTokensUsed: 1067180,
    estimatedCostUsd: 1.184819,
    costSource: "mixed",
    ...overrides,
  };
}

describe("getOneShotRunTimeline", () => {
  beforeEach(() => {
    queryMock.mockReset();
    getOneShotRowByDashboardIdMock.mockReset();
  });

  it("builds DB-backed stage details from run events and artifacts", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(buildRow());
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM oneshot_run_events")) {
        return [
          [
            {
              id: 10,
              oneshot_run_id: 75,
              event_type: "run_claimed",
              from_state: "queued_for_planning",
              to_state: "planning",
              stage: "planning",
              metadata_json: JSON.stringify({ version: 1 }),
              occurred_at: "2026-04-22T01:54:10.000Z",
            },
            {
              id: 12,
              oneshot_run_id: 75,
              event_type: "stage_attempt_metrics",
              from_state: null,
              to_state: null,
              stage: "planning",
              metadata_json: JSON.stringify({
                reason: "planner_failed_attempt",
                receiveCount: 1,
                failureKind: "no_progress",
                failureCategory: "planner_no_progress",
                provider: "anthropic",
                model: "us.anthropic.claude-opus-4-6-v1",
                stage_tokens_used: 349530,
                stage_cost_usd: 1.7226,
                stage_duration_ms: 161596,
                llm_tool_calls: 0,
                grounding_confidence: "medium",
                grounding_candidate_files: 24,
                has_structured_output: true,
                output_preview: '{"summary":"schema-valid plan"}',
              }),
              occurred_at: "2026-04-22T01:55:10.000Z",
            },
            {
              id: 11,
              oneshot_run_id: 75,
              event_type: "state_transition",
              from_state: "testing",
              to_state: "pr_open",
              stage: "testing",
              metadata_json: JSON.stringify({ prNumber: 1457 }),
              occurred_at: "2026-04-22T02:13:16.000Z",
            },
            {
              id: 13,
              oneshot_run_id: 75,
              event_type: "artifact_generation_failed",
              from_state: null,
              to_state: null,
              stage: "postmortem",
              metadata_json: JSON.stringify({
                failedStage: "planning",
                error: "s3 write failed",
                stack: "full stack hidden",
                stackPreview: "full stack",
              }),
              occurred_at: "2026-04-22T02:14:16.000Z",
            },
          ],
        ];
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [
          [
            {
              id: 20,
              oneshot_run_id: 75,
              stage: "plan",
              version: 1,
              status: "completed",
              provider: "anthropic",
              model: "us.anthropic.claude-opus-4-6-v1",
              metadata_json: JSON.stringify({
                impactedFiles: ["src/a.ts"],
                stage_tokens_used: 1000,
                stage_cost_usd: 0.12,
                stage_duration_ms: 120000,
              }),
              started_at: "2026-04-22T01:54:10.000Z",
              completed_at: "2026-04-22T01:56:10.000Z",
              created_at: "2026-04-22T01:56:10.000Z",
            },
          ],
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const timeline = await getOneShotRunTimeline("run-75");

    expect(timeline?.isFallback).toBe(false);
    expect(timeline?.events).toHaveLength(4);
    expect(
      timeline?.events.find(
        (event) => event.eventType === "stage_attempt_metrics",
      ),
    ).toMatchObject({
      stage: "planning",
      tone: "warning",
      metadata: expect.objectContaining({
        stage_tokens_used: 349530,
        stage_cost_usd: 1.7226,
        model: "us.anthropic.claude-opus-4-6-v1",
        grounding_confidence: "medium",
        output_preview: '{"summary":"schema-valid plan"}',
      }),
    });
    expect(
      timeline?.events.find(
        (event) => event.eventType === "artifact_generation_failed",
      ),
    ).toMatchObject({
      tone: "error",
      metadata: expect.objectContaining({
        failedStage: "planning",
        error: "s3 write failed",
        stackPreview: "full stack",
      }),
    });
    expect(timeline?.events[1]).toMatchObject({
      stage: "planning",
      tone: "warning",
    });
    expect(timeline?.events[2]).toMatchObject({
      stage: "testing",
      tone: "warning",
      metadata: { prNumber: 1457 },
    });
    expect(
      timeline?.stages.find((stage) => stage.stage === "planning"),
    ).toMatchObject({
      state: "completed",
      attempts: 1,
      latestVersion: 1,
      provider: "anthropic",
      model: "us.anthropic.claude-opus-4-6-v1",
      tokensUsed: 1000,
      costUsd: 0.12,
      totalTokensUsed: 350530,
      totalCostUsd: 1.8426,
      totalCostSource: "actual",
      metadataSummary: [
        "tokens: 1000",
        "cost: 0.12",
        "impacted files: 1 (src/a.ts)",
      ],
    });
    expect(
      timeline?.stages.find((stage) => stage.stage === "pr_complete"),
    ).toMatchObject({
      state: "completed",
    });
  });

  it("surfaces TRACE and VERIFY evidence in the planning timeline", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(
      buildRow({
        displayState: "queued_for_review",
        progressStage: "review",
      }),
    );
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM oneshot_run_events")) {
        return [
          [
            {
              id: 30,
              oneshot_run_id: 75,
              event_type: "trace_generated",
              from_state: "planning",
              to_state: "planning",
              stage: "planning",
              metadata_json: JSON.stringify({
                version: 1,
                traceS3Key: "oneshot/CPDEV-20908/run-75/trace/v1/test-cases.json",
                traceCsvS3Key: "oneshot/CPDEV-20908/run-75/trace/v1/test-cases.csv",
              }),
              occurred_at: "2026-04-22T01:57:10.000Z",
            },
            {
              id: 31,
              oneshot_run_id: 75,
              event_type: "verify_completed",
              from_state: "planning",
              to_state: "planning",
              stage: "planning",
              metadata_json: JSON.stringify({
                version: 1,
                verifyS3Key: "oneshot/CPDEV-20908/run-75/verify/v1/verify-report.json",
                recommendation: "APPROVED",
                riskLevel: "LOW",
                gapCount: 0,
                criticalGapCount: 0,
                highGapCount: 0,
              }),
              occurred_at: "2026-04-22T01:58:10.000Z",
            },
          ],
        ];
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [
          [
            {
              id: 20,
              oneshot_run_id: 75,
              stage: "plan",
              version: 1,
              status: "completed",
              provider: "anthropic",
              model: "us.anthropic.claude-opus-4-6-v1",
              metadata_json: JSON.stringify({ stage_tokens_used: 1000 }),
              started_at: "2026-04-22T01:54:10.000Z",
              completed_at: "2026-04-22T01:56:10.000Z",
              created_at: "2026-04-22T01:56:10.000Z",
            },
            {
              id: 21,
              oneshot_run_id: 75,
              stage: "trace",
              version: 1,
              status: "completed",
              provider: "deterministic",
              model: "trace-port",
              metadata_json: JSON.stringify({
                traceGuardrailResult: { passed: true },
                acceptanceCriteriaCoverage: {
                  covered: 20,
                  total: 20,
                  coveragePercent: 100,
                },
                sectionCounts: { A: 26, B: 3, C: 3 },
                sectionCTestCaseIds: [
                  "CPDEV-20908-TRACE-C-001",
                  "CPDEV-20908-TRACE-C-002",
                  "CPDEV-20908-TRACE-C-003",
                ],
              }),
              started_at: "2026-04-22T01:56:10.000Z",
              completed_at: "2026-04-22T01:57:10.000Z",
              created_at: "2026-04-22T01:57:10.000Z",
            },
            {
              id: 22,
              oneshot_run_id: 75,
              stage: "verify",
              version: 1,
              status: "completed",
              provider: "deterministic",
              model: "verify-port:balanced",
              metadata_json: JSON.stringify({
                verifyGuardrailResult: { passed: true },
                recommendation: "APPROVED",
                riskLevel: "LOW",
                acceptanceCriteriaCoverage: {
                  covered: 20,
                  total: 20,
                  coveragePercent: 100,
                },
                gapCount: 0,
                criticalGapCount: 0,
                highGapCount: 0,
                unverifiedClaims: ["UNABLE_TO_VERIFY historical Jira patterns"],
                degradedModeDisclaimers: [
                  "UNABLE_TO_VERIFY: Historical Jira defect patterns were not queried.",
                ],
              }),
              started_at: "2026-04-22T01:57:10.000Z",
              completed_at: "2026-04-22T01:58:10.000Z",
              created_at: "2026-04-22T01:58:10.000Z",
            },
          ],
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const timeline = await getOneShotRunTimeline("run-75");

    expect(timeline?.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "trace_generated",
          label: "TRACE test cases generated",
          stage: "planning",
          metadata: expect.objectContaining({
            traceCsvS3Key:
              "oneshot/CPDEV-20908/run-75/trace/v1/test-cases.csv",
          }),
        }),
        expect.objectContaining({
          eventType: "verify_completed",
          label: "VERIFY completed · APPROVED · risk LOW",
          stage: "planning",
          metadata: expect.objectContaining({
            recommendation: "APPROVED",
            riskLevel: "LOW",
            gapCount: 0,
          }),
        }),
      ]),
    );
    expect(
      timeline?.stages.find((stage) => stage.stage === "planning"),
    ).toMatchObject({
      attempts: 1,
      latestVersion: 1,
      provider: "deterministic",
      model: "verify-port:balanced",
      metadataSummary: [
        "verify: APPROVED",
        "risk: LOW",
        "gaps: 0",
        "critical gaps: 0",
        "high gaps: 0",
        "VERIFY guardrails: passed",
        "AC coverage: 20/20 (100%)",
        "unverified claims: 1",
        "disclaimers: 1",
      ],
    });
  });

  it("returns null for a missing dashboard row", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(null);

    await expect(getOneShotRunTimeline("run-999")).resolves.toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("falls back when ordered timeline queries hit MySQL sort-buffer memory", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(
      buildRow({
        displayState: "queued_for_code_review",
        progressStage: "code_review",
        progressPercent: 62,
        lastErrorSummary:
          "Out of sort memory, consider increasing server sort buffer size",
      }),
    );
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM oneshot_run_events")) {
        throw new Error(
          "Out of sort memory, consider increasing server sort buffer size",
        );
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [[]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const timeline = await getOneShotRunTimeline("run-75");

    expect(timeline).toMatchObject({
      dashboardId: "run-75",
      oneshotRunId: 75,
      isFallback: true,
      events: [],
    });
    expect(
      timeline?.stages.find((stage) => stage.stage === "code_review"),
    ).toMatchObject({
      state: "queued",
      metadataSummary: expect.arrayContaining([
        "Out of sort memory, consider increasing server sort buffer size",
      ]),
    });
  });

  it("does not hide non-sort timeline query failures", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(buildRow());
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM oneshot_run_events")) {
        throw new Error("database unavailable");
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [[]];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    await expect(getOneShotRunTimeline("run-75")).rejects.toThrow(
      "database unavailable",
    );
  });

  it("keeps action-needed states waiting even when they have error tone", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(
      buildRow({
        displayState: "replan_required",
        progressStage: "code_review",
      }),
    );
    queryMock.mockResolvedValue([[]]);

    const timeline = await getOneShotRunTimeline("run-75");

    expect(
      timeline?.stages.find((stage) => stage.stage === "code_review"),
    ).toMatchObject({
      state: "waiting",
    });
  });

  it("shows latest failed attempt metrics instead of older artifact metrics for an active failed stage", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(
      buildRow({
        displayState: "failed",
        progressStage: "planning",
      }),
    );
    queryMock.mockImplementation(async (sql: string) => {
      if (sql.includes("FROM oneshot_run_events")) {
        return [
          [
            {
              id: 30,
              oneshot_run_id: 75,
              event_type: "stage_attempt_metrics",
              from_state: null,
              to_state: null,
              stage: "planning",
              metadata_json: JSON.stringify({
                version: 2,
                status: "failed",
                provider: "anthropic",
                model: "us.anthropic.claude-opus-4-6-v1",
                stage_tokens_used: 64000,
                stage_cost_usd: 2.25,
                stage_duration_ms: 90000,
              }),
              occurred_at: "2026-04-22T02:05:10.000Z",
            },
          ],
        ];
      }
      if (sql.includes("FROM oneshot_artifacts")) {
        return [
          [
            {
              id: 21,
              oneshot_run_id: 75,
              stage: "plan",
              version: 1,
              status: "completed",
              provider: "anthropic",
              model: "us.anthropic.claude-sonnet-4-6",
              metadata_json: JSON.stringify({
                stage_tokens_used: 1000,
                stage_cost_usd: 0.12,
                stage_duration_ms: 120000,
              }),
              started_at: "2026-04-22T01:54:10.000Z",
              completed_at: "2026-04-22T01:56:10.000Z",
              created_at: "2026-04-22T01:56:10.000Z",
            },
          ],
        ];
      }
      throw new Error(`Unexpected query: ${sql}`);
    });

    const timeline = await getOneShotRunTimeline("run-75");

    expect(
      timeline?.stages.find((stage) => stage.stage === "planning"),
    ).toMatchObject({
      state: "failed",
      latestVersion: 2,
      artifactStatus: "failed",
      startedAt: null,
      completedAt: "2026-04-22T02:05:10.000Z",
      provider: "anthropic",
      model: "us.anthropic.claude-opus-4-6-v1",
      tokensUsed: 64000,
      costUsd: 2.25,
      totalTokensUsed: 65000,
      totalCostUsd: 2.37,
    });
  });

  it("returns a qualification-only fallback for qualifier task rows", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(
      buildRow({
        dashboardId: "qualifier-task-1901",
        oneshotRunId: null,
        displayState: "qualification_failed",
        progressStage: "qualification",
        qualificationSummary: "Ticket did not qualify for OneShot.",
      }),
    );

    const timeline = await getOneShotRunTimeline("qualifier-task-1901");

    expect(timeline?.isFallback).toBe(true);
    expect(
      timeline?.stages.find((stage) => stage.stage === "qualification"),
    ).toMatchObject({
      state: "failed",
      metadataSummary: expect.arrayContaining([
        "Ticket did not qualify for OneShot.",
      ]),
    });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("renders no-action qualifier task fallbacks as skipped instead of completed", async () => {
    getOneShotRowByDashboardIdMock.mockResolvedValue(
      buildRow({
        dashboardId: "qualifier-task-2009",
        oneshotRunId: null,
        displayState: "qualification_no_action",
        progressStage: "qualification",
        qualificationSummary:
          "No OneShot action was taken because the PFOS label was missing when QUALIFIER processed the task.",
      }),
    );

    const timeline = await getOneShotRunTimeline("qualifier-task-2009");

    expect(timeline?.isFallback).toBe(true);
    expect(
      timeline?.stages.find((stage) => stage.stage === "qualification"),
    ).toMatchObject({
      state: "skipped",
      metadataSummary: expect.arrayContaining([
        "dashboard state: qualification_no_action",
        "No OneShot action was taken because the PFOS label was missing when QUALIFIER processed the task.",
      ]),
    });
    expect(queryMock).not.toHaveBeenCalled();
  });
});
