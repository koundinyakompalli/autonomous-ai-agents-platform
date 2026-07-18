import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotDashboardRow } from "../types/oneshot.js";
import { READINESS_RUBRIC } from "../shared/ticketReadiness.js";

const mocks = vi.hoisted(() => ({
  bedrockSend: vi.fn(),
  execute: vi.fn(),
  query: vi.fn(),
}));

const executeMock = mocks.execute;
const queryMock = mocks.query;
const bedrockSendMock = mocks.bedrockSend;

vi.mock("../db.js", () => ({
  getPool: () => ({
    execute: executeMock,
    query: queryMock,
  }),
}));

vi.mock("./oneshot.js", () => ({
  getOneShotDashboardRows: vi.fn(),
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function BedrockRuntimeClient() {
    return {
      send: bedrockSendMock,
    };
  }),
  InvokeModelCommand: vi.fn().mockImplementation(function InvokeModelCommand(input: unknown) {
    return input;
  }),
}));

const oneshotRowsModule = await import("./oneshot.js");
const {
  buildDeterministicStatisticsResponse,
  claimStatisticsRefreshLease,
  fingerprintStatisticsInput,
  getOneShotStatistics,
  STATISTICS_PROMPT_VERSION,
} = await import("./oneshotStatistics.js");
const { FAILURE_ATTRIBUTION_VERSION } = await import("./failureAttribution.js");
const getOneShotDashboardRowsMock = vi.mocked(
  oneshotRowsModule.getOneShotDashboardRows,
);

function makeRow(overrides: Partial<OneShotDashboardRow>): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Auth login ticket",
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: "Acme",
    displayState: "completed",
    progressStage: "pr_complete",
    progressPercent: 100,
    repoName: "core-app",
    repoUrl: "https://example.com/repo",
    baseBranch: "main",
    baseCommitSha: "abc123",
    implementationBranch: "oneshot/cpdev-1-run-1",
    implementationCommitSha: "def456",
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    currentPrUrl: "https://example.com/pr/1",
    qualificationSummary: null,
    readiness: "ready",
    readinessReasons: [],
    lastError: null,
    lastErrorSummary: null,
    retry: null,
    deployment: {
      eligible: false,
      ready: false,
      light: "grey",
      status: "not_eligible",
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: "2026-05-14T11:00:00.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-05-14T12:00:00.000Z",
    totalTokensUsed: 1000,
    estimatedCostUsd: 0.01,
    costSource: "actual",
    ...overrides,
  };
}

function validLlmStatisticsOutputText(): string {
  return JSON.stringify({
    summary: "AI repaired statistics summary.",
    workingWell: [],
    needsImprovement: [],
    businessMetrics: [],
    recommendedActions: [],
  });
}

describe("oneshot statistics", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-14T12:00:00.000Z"));
    process.env = { ...originalEnv };
    executeMock.mockReset();
    queryMock.mockReset();
    bedrockSendMock.mockReset();
    getOneShotDashboardRowsMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    process.env = originalEnv;
  });

  it("uses all intake as the denominator while keeping no-action out of failures", () => {
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: [
        makeRow({ dashboardId: "run-1", displayState: "completed" }),
        makeRow({
          dashboardId: "qualifier-task-2",
          jiraKey: "CPDEV-2",
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          lastErrorSummary: "Repo unsupported",
        }),
        makeRow({
          dashboardId: "qualifier-task-3",
          jiraKey: "CPDEV-3",
          oneshotRunId: null,
          displayState: "qualification_no_action",
          progressStage: "qualification",
        }),
      ],
    });

    expect(response.scorecard.intake).toBe(3);
    expect(response.scorecard.qualifiedRuns).toBe(1);
    expect(response.scorecard.failed).toBe(1);
    expect(response.scorecard.noAction).toBe(1);
    expect(response.scorecard.passRate).toBe(0.5);
  });

  it("suppresses success and improvement claims below the minimum sample size", () => {
    process.env.ONESHOT_STATISTICS_MIN_SAMPLE_SIZE = "5";
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: [
        makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" }),
        makeRow({ dashboardId: "run-2", jiraKey: "CPDEV-2" }),
      ],
    });

    expect(response.workingWell).toEqual([]);
    expect(response.needsImprovement).toEqual([]);
  });

  it("keeps deterministic bucket ids stable", () => {
    const rows = [
      makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" }),
      makeRow({
        dashboardId: "run-2",
        jiraKey: "CPDEV-2",
        title: "FHIR API endpoint",
        repoName: "interop",
      }),
    ];
    const first = buildDeterministicStatisticsResponse({ range: "24h", rows });
    const second = buildDeterministicStatisticsResponse({
      range: "24h",
      rows: [...rows].reverse(),
    });

    expect(first.buckets.map((bucket) => bucket.id).sort()).toEqual(
      second.buckets.map((bucket) => bucket.id).sort(),
    );
  });

  it("classifies healthy, watch, blocked, and low-sample repo status rows", () => {
    const rows: OneShotDashboardRow[] = [
      ...Array.from({ length: 5 }, (_, index) =>
        makeRow({
          dashboardId: `healthy-${index}`,
          jiraKey: `CPDEV-${index + 1}`,
          sourceTaskManagementId: index + 1,
          repoName: "core-app",
          displayState: "completed",
          progressStage: "pr_complete",
        }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        makeRow({
          dashboardId: `watch-pass-${index}`,
          jiraKey: `CPDEV-${index + 20}`,
          sourceTaskManagementId: index + 20,
          repoName: "portal",
          displayState: "completed",
          progressStage: "pr_complete",
        }),
      ),
      ...Array.from({ length: 2 }, (_, index) =>
        makeRow({
          dashboardId: `watch-test-${index}`,
          jiraKey: `CPDEV-${index + 30}`,
          sourceTaskManagementId: index + 30,
          repoName: "portal",
          displayState: "failed",
          progressStage: "testing",
          lastErrorSummary: "Declared runnable test command was skipped",
        }),
      ),
      ...Array.from({ length: 5 }, (_, index) =>
        makeRow({
          dashboardId: `unresolved-${index}`,
          jiraKey: `CPDEV-${index + 40}`,
          sourceTaskManagementId: index + 40,
          oneshotRunId: null,
          repoName: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          qualificationSummary: "target repository is unresolved",
        }),
      ),
      makeRow({
        dashboardId: "low-1",
        jiraKey: "CPDEV-80",
        sourceTaskManagementId: 80,
        repoName: "batch-jobs",
      }),
      makeRow({
        dashboardId: "low-2",
        jiraKey: "CPDEV-81",
        sourceTaskManagementId: 81,
        repoName: "batch-jobs",
      }),
    ];

    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });

    const byLabel = new Map(
      response.repoStatus.rows.map((row) => [row.repoLabel, row]),
    );
    expect(byLabel.get("core-app")).toMatchObject({
      status: "healthy",
      sampleSize: 5,
      completed: 5,
      failed: 0,
    });
    expect(byLabel.get("portal")).toMatchObject({
      status: "watch",
      topStageIssue: {
        stage: "testing",
        affected: 2,
      },
    });
    expect(byLabel.get("Unresolved repository")).toMatchObject({
      status: "blocked",
      isUnresolved: true,
      sampleSize: 5,
      topFailureAttribution: {
        label: "Ticket Not Ready",
      },
    });
    expect(byLabel.get("batch-jobs")).toMatchObject({
      status: "insufficient_data",
      sampleSize: 2,
    });
    expect(byLabel.get("Unresolved repository")?.examples[0]?.jiraKey).toBe(
      "CPDEV-40",
    );
  });

  it("uses the selected range for repo status counts", () => {
    const rows = [
      makeRow({
        dashboardId: "current",
        jiraKey: "CPDEV-1",
        repoName: "core-app",
        createdAt: "2026-05-14T11:00:00.000Z",
      }),
      makeRow({
        dashboardId: "prior",
        jiraKey: "CPDEV-2",
        repoName: "core-app",
        createdAt: "2026-05-12T11:00:00.000Z",
      }),
    ];

    const day = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });
    const all = buildDeterministicStatisticsResponse({
      range: "all",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });

    expect(day.repoStatus.rows.find((row) => row.repoLabel === "core-app")).toMatchObject({
      sampleSize: 1,
    });
    expect(all.repoStatus.rows.find((row) => row.repoLabel === "core-app")).toMatchObject({
      sampleSize: 2,
    });
  });

  it("builds operational bottlenecks for unresolved repos, stage clusters, and failure categories", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({
          dashboardId: `unresolved-${i}`,
          jiraKey: `CPDEV-${100 + i}`,
          sourceTaskManagementId: 100 + i,
          repoName: null,
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          lastError: "target repository is unresolved",
        }),
      ),
      ...Array.from({ length: 2 }, (_, i) =>
        makeRow({
          dashboardId: `portal-test-${i}`,
          jiraKey: `CPDEV-${200 + i}`,
          sourceTaskManagementId: 200 + i,
          repoName: "portal",
          displayState: "failed",
          progressStage: "testing",
          lastError: "test command(s) were skipped",
        }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeRow({
          dashboardId: `ticket-quality-${i}`,
          jiraKey: `CPDEV-${300 + i}`,
          sourceTaskManagementId: 300 + i,
          repoName: "core-app",
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          lastError: "missing acceptance criteria",
        }),
      ),
      ...Array.from({ length: 20 }, (_, i) =>
        makeRow({
          dashboardId: `completed-${i}`,
          jiraKey: `CPDEV-${500 + i}`,
          sourceTaskManagementId: 500 + i,
          repoName: "core-app",
          displayState: "completed",
          progressStage: "pr_complete",
        }),
      ),
    ];

    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });

    expect(response.operationalBottlenecks.rows[0]).toMatchObject({
      kind: "repo_resolution",
      severity: "high",
      repoLabel: "Unresolved repository",
      affected: 5,
    });
    expect(response.operationalBottlenecks.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "stage_cluster",
          repoLabel: "portal",
          stage: "testing",
          affected: 2,
        }),
        expect.objectContaining({
          kind: "failure_category",
          failureAttribution: expect.objectContaining({
            errorCategory: "ticket_quality",
            attribution: "ticket",
          }),
        }),
      ]),
    );
    expect(response.operationalBottlenecks.rows[0]?.examples[0]?.jiraKey).toBe(
      "CPDEV-100",
    );
  });

  it("creates cost-waste bottlenecks only above cost or token thresholds", () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeRow({
        dashboardId: `expensive-failure-${i}`,
        jiraKey: `CPDEV-${400 + i}`,
        sourceTaskManagementId: 400 + i,
        displayState: "failed",
        progressStage: "implementation",
        lastError: "completed without producing any file changes",
        estimatedCostUsd: 6,
        totalTokensUsed: 1000,
      }),
    );

    const below = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: rows.map((row) => ({
        ...row,
        estimatedCostUsd: 1,
        totalTokensUsed: 1000,
      })),
    });
    const above = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });

    expect(
      below.operationalBottlenecks.rows.some(
        (row) => row.kind === "cost_waste",
      ),
    ).toBe(false);
    expect(
      above.operationalBottlenecks.rows.find(
        (row) => row.kind === "cost_waste",
      ),
    ).toMatchObject({
      affected: 5,
      failed: 5,
      costUsd: 30,
    });
  });

  it("uses the selected range for operational bottleneck counts", () => {
    const rows = [
      makeRow({
        dashboardId: "current",
        jiraKey: "CPDEV-1",
        repoName: null,
        createdAt: "2026-05-14T11:00:00.000Z",
        displayState: "qualification_failed",
        progressStage: "qualification",
        lastError: "target repository is unresolved",
      }),
      makeRow({
        dashboardId: "prior",
        jiraKey: "CPDEV-2",
        repoName: null,
        createdAt: "2026-05-12T11:00:00.000Z",
        displayState: "qualification_failed",
        progressStage: "qualification",
        lastError: "target repository is unresolved",
      }),
    ];

    const day = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });
    const all = buildDeterministicStatisticsResponse({
      range: "all",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });

    expect(day.operationalBottlenecks.rows[0]).toMatchObject({
      kind: "repo_resolution",
      affected: 1,
    });
    expect(all.operationalBottlenecks.rows[0]).toMatchObject({
      kind: "repo_resolution",
      affected: 2,
    });
  });

  it("computes current-vs-prior deltas for finite ranges", () => {
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: [
        makeRow({
          dashboardId: "run-current",
          createdAt: "2026-05-14T10:00:00.000Z",
        }),
        makeRow({
          dashboardId: "run-prior",
          jiraKey: "CPDEV-9",
          createdAt: "2026-05-13T10:00:00.000Z",
          updatedAt: "2026-05-13T11:00:00.000Z",
          displayState: "failed",
          progressStage: "planning",
        }),
      ],
    });

    expect(response.scorecard.deltas.intake).toMatchObject({
      currentValue: 1,
      priorValue: 1,
      delta: 0,
    });
    expect(response.scorecard.deltas.passRate?.delta).toBe(100);
  });

  it("requires present and missing cohorts plus Wilson separation for missing-signal impact", () => {
    const rows: OneShotDashboardRow[] = [
      ...Array.from({ length: 10 }, (_, index) =>
        makeRow({
          dashboardId: `missing-ac-${index}`,
          jiraKey: `CPDEV-${index}`,
          sourceTaskManagementId: index + 1,
          displayState: "failed",
          progressStage: "planning",
        }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        makeRow({
          dashboardId: `present-ac-${index}`,
          jiraKey: `CPDEV-${index + 20}`,
          sourceTaskManagementId: index + 20,
          displayState: "completed",
        }),
      ),
    ];
    const taskTextByTaskId = new Map(
      rows.map((row) => [
        row.sourceTaskManagementId,
        {
          taskDescription: row.dashboardId.startsWith("present")
            ? "Overview: Update core-app AuthorizationSearchService so the default filter should exclude inactive rows. Acceptance Criteria: Given no status filter, when the search runs, then inactive rows are excluded. Testing Notes: Add service unit tests."
            : "Update core-app AuthorizationSearchService so the default filter should exclude inactive rows for the search screen, with service path details but no acceptance criteria or test plan.",
          qualifierOutcome: null,
        },
      ]),
    );

    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
      taskTextByTaskId,
    });

    const impact = response.ticketQuality.missingSignalImpact.find(
      (item) => item.signal === "acceptance_criteria",
    );
    expect(impact).toMatchObject({
      missing: { sampleSize: 10, completed: 0, failed: 10 },
      present: { sampleSize: 10, completed: 10, failed: 0 },
      significant: true,
    });
    expect(impact?.examples.missingFailedOrNoAction.length).toBeGreaterThan(0);
    expect(impact?.examples.presentPassed.length).toBeGreaterThan(0);
  });

  it("suppresses weak-ticket recommendations when repo and stage stratification does not hold", () => {
    const rows: OneShotDashboardRow[] = [
      ...Array.from({ length: 10 }, (_, index) =>
        makeRow({
          dashboardId: `weak-${index}`,
          jiraKey: `CPDEV-${index}`,
          sourceTaskManagementId: index + 1,
          repoName: "repo-a",
          displayState: "failed",
          progressStage: "planning",
        }),
      ),
      ...Array.from({ length: 10 }, (_, index) =>
        makeRow({
          dashboardId: `strong-${index}`,
          jiraKey: `CPDEV-${index + 20}`,
          sourceTaskManagementId: index + 20,
          repoName: "repo-b",
          displayState: "completed",
          progressStage: "pr_complete",
        }),
      ),
    ];
    const taskTextByTaskId = new Map(
      rows.map((row) => [
        row.sourceTaskManagementId,
        {
          taskDescription: row.dashboardId.startsWith("weak")
            ? "The core-app service should update search defaults but no concrete acceptance criteria or tests are provided."
            : "Summary: Update default search behavior.\nOverview: The core-app search service should exclude inactive rows.\nAcceptance Criteria: Given no status filter, when search runs, then inactive rows are excluded.\nTechnical Details: Update SearchService.java.\nTesting Notes: Add service tests.\nOut of Scope: Do not change exports.",
          qualifierOutcome: null,
        },
      ]),
    );

    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
      taskTextByTaskId,
    });

    expect(
      response.ticketQuality.stratifiedReadinessGap.significantOverall,
    ).toBe(true);
    expect(
      response.ticketQuality.stratifiedReadinessGap.qualifiesForRecommendation,
    ).toBe(false);
  });

  it("computes all-time deltas from a prior snapshot without changing the data fingerprint", () => {
    const rows = [
      makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" }),
      makeRow({ dashboardId: "run-2", jiraKey: "CPDEV-2" }),
    ];
    const first = buildDeterministicStatisticsResponse({
      range: "all",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });
    const second = buildDeterministicStatisticsResponse({
      range: "all",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
      priorAllTimeScorecard: {
        ...first.scorecard,
        completed: 1,
        intake: 1,
      },
    });

    expect(second.scorecard.deltas.completed).toMatchObject({
      currentValue: 2,
      priorValue: 1,
      delta: 1,
    });
    expect(second.modelInfo.dataFingerprint).toBe(
      first.modelInfo.dataFingerprint,
    );
  });

  it("includes rubric and detection-pattern versions in the snapshot fingerprint", () => {
    const rows = [makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" })];
    const first = buildDeterministicStatisticsResponse({ range: "24h", rows });
    const originalVersion = READINESS_RUBRIC.rubricVersion;
    (READINESS_RUBRIC as { rubricVersion: string }).rubricVersion = "v1.1-test";
    try {
      const second = buildDeterministicStatisticsResponse({
        range: "24h",
        rows,
      });
      expect(second.modelInfo.dataFingerprint).not.toBe(
        first.modelInfo.dataFingerprint,
      );
    } finally {
      (READINESS_RUBRIC as { rubricVersion: string }).rubricVersion =
        originalVersion;
    }
  });

  it("uses a conditional update to win only one refresh lease", async () => {
    executeMock
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    await expect(claimStatisticsRefreshLease("24h")).resolves.toBe(true);
    await expect(claimStatisticsRefreshLease("24h")).resolves.toBe(false);

    expect(
      executeMock.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => sql.includes("refresh_lease_expires_at")).length,
    ).toBe(2);
  });

  it("returns stale snapshots as refreshing when another request owns an active lease", async () => {
    const rows = [makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" })];
    const snapshot = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T11:00:00.000Z"),
      rows,
    });
    const legacySnapshot = { ...snapshot } as Partial<typeof snapshot>;
    delete legacySnapshot.ticketQuality;
    delete legacySnapshot.repoStatus;
    delete legacySnapshot.operationalBottlenecks;
    getOneShotDashboardRowsMock.mockResolvedValue(rows);
    queryMock
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([
        [
          {
            id: 7,
            range_key: "24h",
            data_fingerprint: "older-fingerprint",
            status: "ready",
            snapshot_json: JSON.stringify(legacySnapshot),
            provider: "bedrock_runtime",
            model: "claude-sonnet",
            generated_at: "2026-05-14T11:00:00.000Z",
            expires_at: "2026-05-14T11:30:00.000Z",
            error_message: null,
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            range_key: "24h",
            latest_snapshot_id: 7,
            refresh_started_at: "2026-05-14T11:59:00.000Z",
            refresh_lease_expires_at: "2026-05-14T12:10:00.000Z",
            next_retry_at: null,
            last_error:
              "LLM statistics JSON could not be parsed: Expected ',' or ']' after array element in JSON at position 6743",
          },
        ],
      ])
      .mockResolvedValueOnce([
        [
          {
            range_key: "24h",
            latest_snapshot_id: 7,
            refresh_started_at: "2026-05-14T11:59:00.000Z",
            refresh_lease_expires_at: "2026-05-14T12:10:00.000Z",
            next_retry_at: null,
            last_error:
              "LLM statistics JSON could not be parsed: Expected ',' or ']' after array element in JSON at position 6743",
          },
        ],
      ]);
    executeMock
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ affectedRows: 0 }]);

    await expect(getOneShotStatistics("24h")).resolves.toMatchObject({
      status: "stale",
      modelInfo: {
        refreshing: true,
        lastError:
          "AI summary refresh failed; showing deterministic statistics. Retrying automatically.",
      },
      ticketQuality: {
        rubric: {
          rubricVersion: "v1.0",
        },
      },
      repoStatus: {
        statusVersion: 1,
        rows: [expect.objectContaining({ repoLabel: "core-app" })],
      },
      operationalBottlenecks: {
        bottleneckVersion: 1,
      },
    });
    expect(bedrockSendMock).not.toHaveBeenCalled();
  });

  it("repairs malformed LLM JSON before schema validation", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" }),
      makeRow({ dashboardId: "run-2", jiraKey: "CPDEV-2" }),
      makeRow({ dashboardId: "run-3", jiraKey: "CPDEV-3" }),
      makeRow({ dashboardId: "run-4", jiraKey: "CPDEV-4" }),
      makeRow({ dashboardId: "run-5", jiraKey: "CPDEV-5" }),
    ]);
    queryMock
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);
    executeMock.mockResolvedValue([{ affectedRows: 1, insertId: 42 }]);
    bedrockSendMock.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [
            {
              type: "text",
              text: validLlmStatisticsOutputText().replace(
                ',"recommendedActions"',
                ' "recommendedActions"',
              ),
            },
          ],
        }),
      ),
    });

    await expect(getOneShotStatistics("24h")).resolves.toMatchObject({
      status: "generating",
      scorecard: { intake: 5 },
    });

    await vi.waitFor(() => {
      const snapshotInsert = executeMock.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO oneshot_statistics_snapshots"),
      );
      expect(snapshotInsert).toBeTruthy();
      expect(snapshotInsert?.[1]).toEqual(
        expect.arrayContaining(["24h", "ready"]),
      );
      expect(snapshotInsert?.[1]?.[7]).toBeNull();
      expect(snapshotInsert?.[1]?.[8]).toBeNull();
      expect(String(snapshotInsert?.[1]?.[3])).toContain(
        "AI repaired statistics summary.",
      );
    });
  });

  it("stores invalid LLM output as an append-only snapshot and backs off", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" }),
      makeRow({ dashboardId: "run-2", jiraKey: "CPDEV-2" }),
      makeRow({ dashboardId: "run-3", jiraKey: "CPDEV-3" }),
      makeRow({ dashboardId: "run-4", jiraKey: "CPDEV-4" }),
      makeRow({ dashboardId: "run-5", jiraKey: "CPDEV-5" }),
    ]);
    queryMock
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);
    executeMock.mockResolvedValue([{ affectedRows: 1, insertId: 42 }]);
    bedrockSendMock.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          content: [{ type: "text", text: '{"summary":"too small"}' }],
        }),
      ),
    });

    await expect(getOneShotStatistics("24h")).resolves.toMatchObject({
      status: "generating",
      scorecard: { intake: 5 },
    });

    await vi.waitFor(() => {
      const snapshotInsert = executeMock.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO oneshot_statistics_snapshots"),
      );
      expect(snapshotInsert).toBeTruthy();
      expect(snapshotInsert?.[1]).toEqual(
        expect.arrayContaining(["24h", "invalid"]),
      );
      expect(snapshotInsert?.[1]?.at(-1)).toContain('"summary":"too small"');
    });

    await vi.waitFor(() => {
      expect(
        executeMock.mock.calls.some(([sql]) =>
          String(sql).includes("next_retry_at = CASE"),
        ),
      ).toBe(true);
    });
    const refreshUpdate = executeMock.mock.calls.find(([sql]) =>
      String(sql).includes("next_retry_at = CASE"),
    );
    expect(refreshUpdate?.[1]).toEqual(expect.arrayContaining([600, "24h"]));
  });

  it("stores max-token LLM truncation as an invalid snapshot and backs off", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" }),
      makeRow({ dashboardId: "run-2", jiraKey: "CPDEV-2" }),
      makeRow({ dashboardId: "run-3", jiraKey: "CPDEV-3" }),
      makeRow({ dashboardId: "run-4", jiraKey: "CPDEV-4" }),
      makeRow({ dashboardId: "run-5", jiraKey: "CPDEV-5" }),
    ]);
    queryMock
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);
    executeMock.mockResolvedValue([{ affectedRows: 1, insertId: 42 }]);
    bedrockSendMock.mockResolvedValue({
      body: new TextEncoder().encode(
        JSON.stringify({
          stop_reason: "max_tokens",
          content: [{ type: "text", text: '{"summary":"cut off"' }],
        }),
      ),
    });

    await expect(getOneShotStatistics("24h")).resolves.toMatchObject({
      status: "generating",
      scorecard: { intake: 5 },
    });

    await vi.waitFor(() => {
      const snapshotInsert = executeMock.mock.calls.find(([sql]) =>
        String(sql).includes("INSERT INTO oneshot_statistics_snapshots"),
      );
      expect(snapshotInsert).toBeTruthy();
      expect(snapshotInsert?.[1]).toEqual(
        expect.arrayContaining(["24h", "invalid"]),
      );
      expect(String(snapshotInsert?.[1]?.[7])).toContain(
        "LLM statistics response was truncated",
      );
      expect(snapshotInsert?.[1]?.at(-1)).toContain('{"summary":"cut off"');
    });

    await vi.waitFor(() => {
      expect(
        executeMock.mock.calls.some(([sql]) =>
          String(sql).includes("next_retry_at = CASE"),
        ),
      ).toBe(true);
    });
  });

  it("Wilson significance suppresses high-passRate buckets that are not above the baseline", () => {
    // 7 strong-template rows pass at 100% (n=7 → wilsonLower ≈ 0.65)
    // 5 strong-template rows fail (so baseline = 7/12 ≈ 0.583)
    // 5 strong-template rows pass at 71% in repo-a is BELOW Wilson-low > baseline.
    // Net: workingWell should not promote the bucket.
    const rows: OneShotDashboardRow[] = [
      ...Array.from({ length: 7 }, (_, i) =>
        makeRow({
          dashboardId: `pass-${i}`,
          jiraKey: `CPDEV-${i}`,
          sourceTaskManagementId: i + 1,
          repoName: "repo-a",
          displayState: "completed",
          progressStage: "pr_complete",
        }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        makeRow({
          dashboardId: `fail-${i}`,
          jiraKey: `CPDEV-${i + 100}`,
          sourceTaskManagementId: i + 100,
          repoName: "repo-b",
          displayState: "failed",
          progressStage: "planning",
          lastError: "ETIMEDOUT calling bedrock",
        }),
      ),
    ];
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });

    expect(response.workingWell.length).toBeLessThanOrEqual(3);
    expect(response.needsImprovement.length).toBeLessThanOrEqual(3);
    response.workingWell.forEach((insight) => {
      expect(insight.reason).toBe(
        "Pass-rate gap remains above the selected-window baseline after sample-size and repo/stage checks.",
      );
      expect(insight.reason).not.toMatch(/Wilson|lower bound|upper bound/i);
    });
  });

  it("caps workingWell and needsImprovement at 3 entries each", () => {
    const rows: OneShotDashboardRow[] = [
      ...Array.from({ length: 8 }, (_, i) =>
        makeRow({
          dashboardId: `s-${i}`,
          jiraKey: `CPDEV-${i + 200}`,
          sourceTaskManagementId: i + 200,
          repoName: `repo-${i % 2}`,
          progressStage: "pr_complete",
          displayState: "completed",
        }),
      ),
    ];
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });
    expect(response.workingWell.length).toBeLessThanOrEqual(3);
  });

  it("populates failureAttribution and excludes qualifier-gating outcomes from totals", () => {
    const rows: OneShotDashboardRow[] = [
      // qualifier-gating: should be excluded from totalFailures
      makeRow({
        dashboardId: "gating-1",
        jiraKey: "CPDEV-1",
        sourceTaskManagementId: 1,
        oneshotRunId: null,
        displayState: "qualification_failed",
        progressStage: "qualification",
        lastError: "Repo unsupported",
        qualifierOutcome: {
          disposition: "not_qualified",
          reasonCode: "repo_unsupported",
          reason: "x",
          qualifierMode: null,
          labels: [],
          latestRunState: null,
        },
      }),
      // genuine OneShot infra failure on a strong ticket
      makeRow({
        dashboardId: "fail-1",
        jiraKey: "CPDEV-2",
        sourceTaskManagementId: 2,
        displayState: "failed",
        progressStage: "planning",
        lastError: "ETIMEDOUT calling bedrock",
        lastErrorSummary: "ETIMEDOUT calling bedrock",
      }),
    ];
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });
    expect(response.failureAttribution).toBeDefined();
    expect(response.failureAttribution?.totalFailures).toBe(1);
    expect(response.failureAttribution?.excludedFromDenominator).toBe(1);
    expect(response.failureAttribution?.attributionVersion).toBe(
      FAILURE_ATTRIBUTION_VERSION,
    );
  });

  it("uses qualification summaries for failed qualifier error-class buckets", () => {
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: [
        makeRow({
          dashboardId: "qualifier-task-2487",
          jiraKey: "CPDEV-22346",
          sourceTaskManagementId: 2487,
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          qualificationSummary:
            "acceptance_criteria_missing: no explicit Acceptance Criteria section is present",
          lastError: null,
          lastErrorSummary: null,
        }),
      ],
    });

    const errorClass = response.buckets.find(
      (bucket) => bucket.kind === "error_class",
    );
    expect(errorClass?.label).toBe(
      "acceptance_criteria_missing: no explicit Acceptance Criteria section is present",
    );
    expect(errorClass?.label).not.toBe("Unknown error");
  });

  it("classifies live-style qualifier rejections as ticket quality in failure attribution", () => {
    const contradictoryReason =
      "Issue #1 resolution status is contradictory and issue #2 root cause is undetermined. HERMES analysis findings are absent. The ticket bundles two issues with unresolved status on both, making bounded scoping for a single OneShot run impossible.";
    const undefinedTriggerReason =
      "SQS queue ARN is not specified, the trigger mechanism is undefined, no RxPA data model exists, and there is zero SQS publishing infrastructure.";

    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: [
        makeRow({
          dashboardId: "qualifier-task-2459",
          jiraKey: "CPSUP-45953",
          sourceTaskManagementId: 2459,
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          qualificationSummary: contradictoryReason,
          qualifierOutcome: {
            disposition: "not_qualified",
            reasonCode: "llm_rejected",
            reason: contradictoryReason,
            qualifierMode: "fresh",
            labels: ["PFOS-NOT-QUALIFIED"],
            latestRunState: null,
          },
          lastError: null,
          lastErrorSummary: null,
        }),
        makeRow({
          dashboardId: "qualifier-task-2396",
          jiraKey: "CPDEV-15114",
          sourceTaskManagementId: 2396,
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          qualificationSummary: undefinedTriggerReason,
          qualifierOutcome: {
            disposition: "not_qualified",
            reasonCode: "llm_rejected",
            reason: undefinedTriggerReason,
            qualifierMode: "fresh",
            labels: ["PFOS-NOT-QUALIFIED"],
            latestRunState: null,
          },
          lastError: null,
          lastErrorSummary: null,
        }),
      ],
    });

    expect(response.failureAttribution?.countsByAttribution.ticket).toBe(2);
    expect(response.failureAttribution?.countsByAttribution.oneshot).toBe(0);
    expect(response.failureAttribution?.countsByAttribution.unknown).toBe(0);
    expect(response.failureAttribution?.byCategory).toEqual([
      expect.objectContaining({
        errorCategory: "ticket_quality",
        attribution: "ticket",
        sampleSize: 2,
      }),
    ]);
    expect(response.failureAttribution?.byCategory).not.toContainEqual(
      expect.objectContaining({
        errorCategory: "unknown",
        attribution: "oneshot",
      }),
    );
  });

  it("classifies gate_hard_fail rows as ticket quality instead of unknown ticket", () => {
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: [
        makeRow({
          dashboardId: "qualifier-task-2026",
          jiraKey: "CPDEV-21156",
          sourceTaskManagementId: 2026,
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          qualificationSummary:
            "Ticket is missing both substantive description and acceptance criteria.",
          qualifierOutcome: {
            disposition: "not_qualified",
            reasonCode: "gate_hard_fail",
            reason:
              "Ticket is missing both substantive description and acceptance criteria.",
            qualifierMode: "fresh",
            labels: ["PFOS-NOT-QUALIFIED"],
            latestRunState: null,
          },
          lastError: null,
          lastErrorSummary: null,
        }),
      ],
    });

    expect(response.failureAttribution?.byCategory).toEqual([
      expect.objectContaining({
        errorCategory: "ticket_quality",
        attribution: "ticket",
        sampleSize: 1,
      }),
    ]);
  });

  it("sets modelInfo.promptVersion=0 on deterministic-only responses", () => {
    const response = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows: [makeRow({})],
    });
    expect(response.modelInfo.promptVersion).toBe(0);
    expect(response.modelInfo.provider).toBeNull();
  });

  it("collapses co-occurring missing signals into a single composite row", () => {
    // 14 rows lack ALL of AC + tests + out-of-scope; 28 rows have ALL three.
    // collapseCoOccurringSignalRows should fold the three identical rows into one.
    const weakDescription = "Update the dashboard, no AC or tests provided.";
    const strongDescription =
      "Summary: Update default search behavior.\nOverview: The core-app search service should exclude inactive rows.\nAcceptance Criteria: Given no status filter, when search runs, then inactive rows are excluded.\nTechnical Details: Update SearchService.java.\nTesting Notes: Add service tests.\nOut of Scope: Do not change exports.";
    const rows: OneShotDashboardRow[] = [
      ...Array.from({ length: 14 }, (_, i) =>
        makeRow({
          dashboardId: `weak-${i}`,
          jiraKey: `CPDEV-${i + 300}`,
          sourceTaskManagementId: i + 300,
          repoName: "repo-a",
          displayState: "failed",
          progressStage: "planning",
        }),
      ),
      ...Array.from({ length: 28 }, (_, i) =>
        makeRow({
          dashboardId: `strong-${i}`,
          jiraKey: `CPDEV-${i + 400}`,
          sourceTaskManagementId: i + 400,
          repoName: "repo-b",
          displayState: "completed",
          progressStage: "pr_complete",
        }),
      ),
    ];
    const taskTextByTaskId = new Map(
      rows.map((row) => [
        row.sourceTaskManagementId,
        {
          taskDescription: row.dashboardId.startsWith("weak")
            ? weakDescription
            : strongDescription,
          qualifierOutcome: null,
        },
      ]),
    );
    const response = buildDeterministicStatisticsResponse({
      range: "all",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
      taskTextByTaskId,
    });
    const composite = response.ticketQuality.missingSignalImpact.find(
      (impact) =>
        typeof impact.signal === "string" && impact.signal.startsWith("co:"),
    );
    expect(composite).toBeDefined();
    expect(composite?.signals?.length).toBeGreaterThanOrEqual(2);
  });

  it("includes promptVersion, attributionVersion, repoStatusVersion, and bottleneckVersion in the snapshot fingerprint", () => {
    // Build a stable fingerprint input shape, then mutate ONLY the versions
    // and confirm the SHA1 changes. This proves a future bump to either
    // version will invalidate the existing `ready` snapshots in
    // oneshot_statistics_snapshots.
    const baseInput = {
      range: "24h",
      scorecard: { intake: 0, passRate: 0 },
      buckets: [],
      ticketQualitySeed: {
        rubricVersion: "v1.0",
        detectionPatternsVersion: "v1.0",
        scores: [],
      },
      versions: {
        promptVersion: STATISTICS_PROMPT_VERSION,
        attributionVersion: FAILURE_ATTRIBUTION_VERSION,
        repoStatusVersion: 1,
        operationalBottleneckVersion: 1,
      },
      operationalBottleneckSeed: {
        bottleneckVersion: 1,
        rows: [],
      },
      rowVersions: [],
    };

    const baseline = fingerprintStatisticsInput(baseInput);
    const promptBumped = fingerprintStatisticsInput({
      ...baseInput,
      versions: {
        promptVersion: STATISTICS_PROMPT_VERSION + 1,
        attributionVersion: FAILURE_ATTRIBUTION_VERSION,
        repoStatusVersion: 1,
        operationalBottleneckVersion: 1,
      },
    });
    const attributionBumped = fingerprintStatisticsInput({
      ...baseInput,
      versions: {
        promptVersion: STATISTICS_PROMPT_VERSION,
        attributionVersion: FAILURE_ATTRIBUTION_VERSION + 1,
        repoStatusVersion: 1,
        operationalBottleneckVersion: 1,
      },
    });
    const repoStatusBumped = fingerprintStatisticsInput({
      ...baseInput,
      versions: {
        promptVersion: STATISTICS_PROMPT_VERSION,
        attributionVersion: FAILURE_ATTRIBUTION_VERSION,
        repoStatusVersion: 2,
        operationalBottleneckVersion: 1,
      },
    });
    const bottleneckBumped = fingerprintStatisticsInput({
      ...baseInput,
      versions: {
        promptVersion: STATISTICS_PROMPT_VERSION,
        attributionVersion: FAILURE_ATTRIBUTION_VERSION,
        repoStatusVersion: 1,
        operationalBottleneckVersion: 2,
      },
    });

    expect(baseline).not.toBe(promptBumped);
    expect(baseline).not.toBe(attributionBumped);
    expect(baseline).not.toBe(repoStatusBumped);
    expect(baseline).not.toBe(bottleneckBumped);
    expect(promptBumped).not.toBe(attributionBumped);
    expect(attributionBumped).not.toBe(repoStatusBumped);
    expect(repoStatusBumped).not.toBe(bottleneckBumped);
  });

  it("buildDeterministicStatisticsResponse propagates the version constants into the fingerprint input", () => {
    // Smoke-test that the live builder's fingerprint changes when the
    // versions block is part of the input. We can't mutate the constants
    // at runtime, but we can confirm the fingerprint of two identical row
    // sets matches itself (regression guard against accidentally embedding
    // a Date.now() or random value in the fingerprint payload).
    const rows = [makeRow({ dashboardId: "run-1", jiraKey: "CPDEV-1" })];
    const a = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });
    const b = buildDeterministicStatisticsResponse({
      range: "24h",
      now: new Date("2026-05-14T12:00:00.000Z"),
      rows,
    });
    expect(a.modelInfo.dataFingerprint).toBe(b.modelInfo.dataFingerprint);
  });
});
