import { beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const getConnectionMock = vi.fn();
const getLatestDeploymentsByRunIdsMock = vi.fn();

vi.mock("../db.js", () => ({
  getPool: () => ({
    query: queryMock,
    getConnection: getConnectionMock,
  }),
}));

vi.mock("./oneshotDeployments.js", () => ({
  buildDeploymentSummaryFromRecord: vi.fn(() => ({
    eligible: false,
    ready: false,
    light: "grey",
    status: "not_eligible",
    active: false,
    previewUrl: null,
    workflowUrl: null,
    imageUri: null,
    deployedCommitSha: null,
  })),
  getLatestDeploymentsByRunIds: getLatestDeploymentsByRunIdsMock,
}));

const { getOneShotRowByDashboardId, updateOneShotRunTicketType } =
  await import("./oneshot.js");

describe("getOneShotRowByDashboardId", () => {
  beforeEach(() => {
    queryMock.mockReset();
    getConnectionMock.mockReset();
    getLatestDeploymentsByRunIdsMock.mockReset();
    getLatestDeploymentsByRunIdsMock.mockResolvedValue(new Map());
  });

  function buildRunDbRow(overrides: Record<string, unknown> = {}) {
    return {
      oneshot_run_id: 123,
      jira_key: "CPDEV-123",
      jira_issue_type: "Story",
      ticket_type: "security",
      ticket_type_source: "inferred_security",
      ticket_type_updated_by: null,
      ticket_type_updated_at: null,
      source_task_management_id: 9,
      customer_name: "MHK",
      state: "pr_open",
      review_loop_count: 1,
      max_review_loops: 3,
      current_pr_url: "https://github.com/org/repo/pull/12",
      current_plan_version: 1,
      current_review_version: 1,
      current_implementation_version: 1,
      current_code_review_version: 1,
      current_test_version: 1,
      final_disposition: null,
      last_error: null,
      repo_name: "core-app",
      repo_url: "https://github.com/org/repo",
      branch_name: "master",
      base_commit_sha: "abc",
      task_description: "# Task: CPDEV-123 Restart test",
      implementation_metadata_json: JSON.stringify({
        implementationCommitSha: "def",
      }),
      total_tokens_used: 10,
      created_at: new Date("2026-05-01T00:00:00.000Z"),
      updated_at: new Date("2026-05-01T00:10:00.000Z"),
      ...overrides,
    };
  }

  function mockRunContextQueries({
    manualRestartRows = [],
    readinessRows = [],
    retryEtaRows = [],
  }: {
    manualRestartRows?: unknown[];
    readinessRows?: unknown[];
    retryEtaRows?: unknown[];
  } = {}) {
    queryMock
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([manualRestartRows])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([readinessRows])
      .mockResolvedValueOnce([retryEtaRows]);
  }

  it("returns null for malformed dashboard ids without querying", async () => {
    await expect(getOneShotRowByDashboardId("CPDEV-123")).resolves.toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("returns null when a run dashboard id is not found", async () => {
    queryMock.mockResolvedValueOnce([[]]);

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toBeNull();

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when a qualifier-task dashboard id is not found", async () => {
    queryMock.mockResolvedValueOnce([[]]);

    await expect(
      getOneShotRowByDashboardId("qualifier-task-456"),
    ).resolves.toBeNull();

    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes no-action qualifier outcomes without marking them failed", async () => {
    queryMock.mockResolvedValueOnce([
      [
        {
          task_management_id: 456,
          jira_number: "CPDEV-456",
          task_status: "completed",
          customer_name: "MHK",
          task_description: "# Task: CPDEV-456 stale qualifier task",
          error_message: null,
          metrics_json: JSON.stringify({
            qualifierOutcome: {
              disposition: "no_action",
              reasonCode: "pfos_label_missing_at_processing",
              reason:
                "No OneShot action was taken because the PFOS label was missing when QUALIFIER processed the task.",
              qualifierMode: null,
              labels: [],
              latestRunState: null,
            },
          }),
          created_at: new Date("2026-04-27T14:57:46.000Z"),
          updated_at: new Date("2026-04-27T15:04:32.000Z"),
        },
      ],
    ]);

    await expect(getOneShotRowByDashboardId("qualifier-task-456")).resolves
      .toMatchObject({
        dashboardId: "qualifier-task-456",
        displayState: "qualification_no_action",
        qualificationSummary:
          "No OneShot action was taken because the PFOS label was missing when QUALIFIER processed the task.",
        qualifierOutcome: {
          disposition: "no_action",
          reasonCode: "pfos_label_missing_at_processing",
        },
      });
  });

  it("returns null lastManualRestartAt when no manual restart event exists", async () => {
    queryMock.mockResolvedValueOnce([[buildRunDbRow()]]);
    mockRunContextQueries();

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      lastManualRestartAt: null,
    });
  });

  it("hydrates raw Jira issue type and normalized ticket type on dashboard rows", async () => {
    queryMock.mockResolvedValueOnce([
      [
        buildRunDbRow({
          jira_issue_type: "Story",
          ticket_type: "sonar",
          ticket_type_source: "inferred_sonar",
          ticket_type_updated_by: "Ravi",
          ticket_type_updated_at: new Date("2026-05-01T00:08:00.000Z"),
        }),
      ],
    ]);
    mockRunContextQueries();

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      jiraIssueType: "Story",
      ticketType: "sonar",
      ticketTypeSource: "inferred_sonar",
      ticketTypeUpdatedBy: "Ravi",
      ticketTypeUpdatedAt: "2026-05-01T00:08:00.000Z",
    });
  });

  it("updates normalized ticket type manually and returns the refreshed row", async () => {
    const connectionQuery = vi
      .fn()
      .mockResolvedValueOnce([
        [
          {
            id: 123,
            ticket_type: "story",
            ticket_type_source: "jira_issue_type",
            state: "pr_open",
          },
        ],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }])
      .mockResolvedValueOnce([{ insertId: 88 }]);
    const connection = {
      query: connectionQuery,
      beginTransaction: vi.fn().mockResolvedValue(undefined),
      commit: vi.fn().mockResolvedValue(undefined),
      rollback: vi.fn().mockResolvedValue(undefined),
      release: vi.fn(),
    };
    getConnectionMock.mockResolvedValue(connection);
    queryMock.mockResolvedValueOnce([
      [
        buildRunDbRow({
          ticket_type: "defect",
          ticket_type_source: "manual",
          ticket_type_updated_by: "Ravi",
          ticket_type_updated_at: new Date("2026-05-01T00:08:00.000Z"),
        }),
      ],
    ]);
    mockRunContextQueries();

    await expect(
      updateOneShotRunTicketType({
        dashboardId: "run-123",
        ticketType: "defect",
        operator: { id: "u-1", display: "Ravi" },
      }),
    ).resolves.toMatchObject({
      ticketType: "defect",
      ticketTypeSource: "manual",
      ticketTypeUpdatedBy: "Ravi",
    });

    expect(connection.beginTransaction).toHaveBeenCalledTimes(1);
    expect(connection.commit).toHaveBeenCalledTimes(1);
    expect(connection.rollback).not.toHaveBeenCalled();
    expect(connection.release).toHaveBeenCalledTimes(1);
    expect(connectionQuery).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining("SET ticket_type = ?"),
      ["defect", "Ravi", 123],
    );
    expect(connectionQuery).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining("INSERT INTO oneshot_run_events"),
      expect.arrayContaining(["ticket_type_updated"]),
    );
  });

  it("normalizes blank workspace mode values in dashboard rows", async () => {
    queryMock.mockResolvedValueOnce([[buildRunDbRow({ workspace_mode: "" })]]);
    mockRunContextQueries();

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      workspace: {
        mode: "v2",
      },
    });
  });

  it("hydrates lastManualRestartAt from the latest manual restart event", async () => {
    queryMock.mockResolvedValueOnce([[buildRunDbRow()]]);
    mockRunContextQueries({
      manualRestartRows: [
        {
          oneshot_run_id: 123,
          occurred_at: new Date("2026-05-01T00:07:00.000Z"),
        },
      ],
    });

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      lastManualRestartAt: "2026-05-01T00:07:00.000Z",
    });
  });

  it("keeps the first manual restart row per run after occurred_at and id ordering", async () => {
    queryMock.mockResolvedValueOnce([[buildRunDbRow()]]);
    mockRunContextQueries({
      manualRestartRows: [
        {
          oneshot_run_id: 123,
          occurred_at: new Date("2026-05-01T00:08:00.000Z"),
        },
        {
          oneshot_run_id: 123,
          occurred_at: new Date("2026-05-01T00:08:00.000Z"),
        },
        {
          oneshot_run_id: 123,
          occurred_at: new Date("2026-05-01T00:06:00.000Z"),
        },
      ],
    });

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      lastManualRestartAt: "2026-05-01T00:08:00.000Z",
    });

    const restartQuery = String(queryMock.mock.calls[4]?.[0] ?? "");
    expect(restartQuery).toContain(
      "ORDER BY oneshot_run_id ASC, occurred_at DESC, id DESC",
    );
  });

  it("hydrates retry ETA only when the retry event matches the current queued state", async () => {
    const nextRetryTimestamp = "2026-05-01T00:12:00.000Z";
    queryMock.mockResolvedValueOnce([
      [
        buildRunDbRow({
          state: "queued_for_review",
          last_error: "Reviewer timed out",
        }),
      ],
    ]);
    mockRunContextQueries({
      retryEtaRows: [
        {
          oneshot_run_id: 123,
          to_state: "queued_for_review",
          metadata_json: JSON.stringify({
            transientRetry: {
              retryAttempt: 2,
              maxRetryAttempts: 3,
              retryDelaySeconds: 300,
              nextRetryTimestamp,
              visibilityChangeStatus: "success",
            },
          }),
        },
      ],
    });

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      retryPending: true,
      retryPendingNextRetryAt: nextRetryTimestamp,
      retryPendingDelaySeconds: 300,
      retryPendingAttempt: 2,
      retryPendingMaxAttempts: 3,
      retryPendingVisibilityStatus: "success",
    });
  });

  it("ignores stale retry ETA events from a previous queued state", async () => {
    queryMock.mockResolvedValueOnce([
      [
        buildRunDbRow({
          state: "queued_for_review",
          last_error: "Reviewer timed out",
        }),
      ],
    ]);
    mockRunContextQueries({
      retryEtaRows: [
        {
          oneshot_run_id: 123,
          to_state: "queued_for_planning",
          metadata_json: JSON.stringify({
            transientRetry: {
              retryAttempt: 1,
              maxRetryAttempts: 3,
              retryDelaySeconds: 120,
              nextRetryTimestamp: "2026-05-01T00:02:00.000Z",
              visibilityChangeStatus: "success",
            },
          }),
        },
      ],
    });

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      retryPending: true,
      retryPendingNextRetryAt: null,
      retryPendingDelaySeconds: null,
      retryPendingAttempt: null,
      retryPendingVisibilityStatus: null,
    });
  });

  it("ignores state transition events with null or missing manual restart reason", async () => {
    queryMock.mockResolvedValueOnce([[buildRunDbRow()]]);
    mockRunContextQueries();

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      lastManualRestartAt: null,
    });

    const restartQuery = String(queryMock.mock.calls[4]?.[0] ?? "");
    expect(restartQuery).toContain(
      "JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) = 'manual_stage_restart'",
    );
  });

  it("hydrates readiness evidence from latest run events", async () => {
    queryMock
      .mockResolvedValueOnce([
        [
          {
            oneshot_run_id: 123,
            jira_key: "CPDEV-123",
            source_task_management_id: 9,
            customer_name: "MHK",
            state: "pr_open",
            review_loop_count: 1,
            max_review_loops: 3,
            current_pr_url: "https://github.com/org/repo/pull/12",
            current_plan_version: 1,
            current_review_version: 1,
            current_implementation_version: 1,
            current_code_review_version: 1,
            current_test_version: 1,
            final_disposition: "completed_needs_review",
            last_error: "fallback readiness reason",
            repo_name: "core-app",
            repo_url: "https://github.com/org/repo",
            branch_name: "master",
            base_commit_sha: "abc",
            task_description: "# Task: CPDEV-123 Readiness test",
            implementation_metadata_json: JSON.stringify({
              implementationCommitSha: "def",
            }),
            total_tokens_used: 10,
            created_at: new Date("2026-05-01T00:00:00.000Z"),
            updated_at: new Date("2026-05-01T00:10:00.000Z"),
          },
        ],
      ])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([
        [
          {
            id: 77,
            oneshot_run_id: 123,
            event_type: "readiness_classified",
            metadata_json: JSON.stringify({
              readiness: {
                completionStatus: "completed_needs_review",
                readiness: "needs_review",
                reasons: [
                  {
                    message: "CI failed",
                  },
                ],
              },
              ciStatus: {
                state: "failure",
                description: "GitHub CI failed",
              },
              riskAssessment: {
                planRiskAssessment: {
                  blockingCandidateCount: 1,
                },
              },
              externalSpecEvidence: {
                urls: [{ status: "fetched" }],
              },
              unverifiedTests: ["mvn test"],
            }),
          },
        ],
      ])
      .mockResolvedValueOnce([[]]);

    await expect(getOneShotRowByDashboardId("run-123")).resolves.toMatchObject({
      readinessReasons: ["CI failed"],
      ciStatus: {
        state: "failure",
      },
      riskAssessment: {
        planRiskAssessment: {
          blockingCandidateCount: 1,
        },
      },
      externalSpecEvidence: {
        urls: [{ status: "fetched" }],
      },
      unverifiedTests: ["mvn test"],
    });
  });

  it("does not surface skipped command metadata as unverified when tester marked the artifact verified", async () => {
    queryMock
      .mockResolvedValueOnce([
        [
          {
            oneshot_run_id: 125,
            jira_key: "CPDEV-125",
            source_task_management_id: 10,
            customer_name: "MHK",
            state: "pr_open",
            review_loop_count: 1,
            max_review_loops: 3,
            current_pr_url: "https://github.com/org/repo/pull/14",
            current_plan_version: 1,
            current_review_version: 1,
            current_implementation_version: 1,
            current_code_review_version: 1,
            current_test_version: 1,
            final_disposition: "completed_ready",
            last_error: null,
            repo_name: "core-app",
            repo_url: "https://github.com/org/repo",
            branch_name: "master",
            base_commit_sha: "abc",
            task_description: "# Task: CPDEV-125 Verified fallback tests",
            implementation_metadata_json: JSON.stringify({
              implementationCommitSha: "def",
            }),
            total_tokens_used: 10,
            created_at: new Date("2026-05-01T00:00:00.000Z"),
            updated_at: new Date("2026-05-01T00:10:00.000Z"),
          },
        ],
      ])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([
        [
          {
            id: 78,
            oneshot_run_id: 125,
            event_type: "readiness_classified",
            metadata_json: JSON.stringify({
              readiness: {
                completionStatus: "completed_ready",
                readiness: "ready",
                reasons: [],
              },
              unverifiedTests: [],
              testResult: {
                unverified: false,
                skippedTestCommands: ["mvn test"],
              },
            }),
          },
        ],
      ])
      .mockResolvedValueOnce([[]]);

    await expect(getOneShotRowByDashboardId("run-125")).resolves.toMatchObject({
      readiness: "ready",
      unverifiedTests: [],
    });
  });

  it("maps completed_no_action rows as successful no-action and not deploy-ready", async () => {
    queryMock.mockResolvedValueOnce([
      [
        buildRunDbRow({
          oneshot_run_id: 127,
          jira_key: "CPDEV-127",
          state: "completed",
          current_pr_url: null,
          current_implementation_version: null,
          current_code_review_version: null,
          current_test_version: null,
          final_disposition: "completed_no_action",
          implementation_metadata_json: null,
          task_description: "# Task: CPDEV-127 No code change needed",
        }),
      ],
    ]);
    mockRunContextQueries();

    await expect(getOneShotRowByDashboardId("run-127")).resolves.toMatchObject({
      displayState: "completed",
      completionStatus: "completed_no_action",
      readiness: "no_action",
      currentPrUrl: null,
      deployment: expect.objectContaining({
        ready: false,
      }),
    });
  });

  it("normalizes legacy array-shaped planner diagnostic artifacts", async () => {
    queryMock
      .mockResolvedValueOnce([
        [
          {
            oneshot_run_id: 126,
            jira_key: "CPDEV-126",
            source_task_management_id: 10,
            customer_name: "MHK",
            state: "failed",
            review_loop_count: 0,
            max_review_loops: 3,
            current_pr_url: null,
            current_plan_version: 1,
            current_review_version: 0,
            current_implementation_version: 0,
            current_code_review_version: 0,
            current_test_version: 0,
            final_disposition: null,
            last_error: "planner failed",
            repo_name: "core-app",
            repo_url: "https://github.com/org/repo",
            branch_name: "master",
            base_commit_sha: "abc",
            task_description: "# Task: CPDEV-126 Planner diagnostics",
            implementation_metadata_json: null,
            total_tokens_used: 10,
            created_at: new Date("2026-05-01T00:00:00.000Z"),
            updated_at: new Date("2026-05-01T00:10:00.000Z"),
          },
        ],
      ])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([
        [
          {
            id: 79,
            oneshot_run_id: 126,
            event_type: "sdk_lifecycle_observed",
            metadata_json: JSON.stringify({
              reason: "planner_completed",
              version: 1,
              planner_diagnostic_artifacts: [
                "oneshot/CPDEV-126/run-126/plans/v1/sdk-lifecycle.json",
                "oneshot/CPDEV-126/run-126/plans/v1/sdk-message-summary-attempt-1.json",
                "oneshot/CPDEV-126/run-126/plans/v1/tool-call-profile.json",
                "oneshot/CPDEV-126/run-126/plans/v1/sdk-raw-trace-attempt-1.json",
                "oneshot/CPDEV-126/run-126/plans/v1/planner-failed-output.json",
              ],
            }),
          },
        ],
      ])
      .mockResolvedValueOnce([[]]);

    await expect(getOneShotRowByDashboardId("run-126")).resolves.toMatchObject({
      plannerAttemptDiagnostics: {
        diagnosticArtifactKeys: {
          sdkLifecycle: "oneshot/CPDEV-126/run-126/plans/v1/sdk-lifecycle.json",
          sdkMessageSummary:
            "oneshot/CPDEV-126/run-126/plans/v1/sdk-message-summary-attempt-1.json",
          toolCallProfiles:
            "oneshot/CPDEV-126/run-126/plans/v1/tool-call-profile.json",
          rawTrace: "oneshot/CPDEV-126/run-126/plans/v1/sdk-raw-trace-attempt-1.json",
          failedOutput:
            "oneshot/CPDEV-126/run-126/plans/v1/planner-failed-output.json",
        },
      },
    });
  });

  it("does not infer ready readiness for legacy pr_open rows without readiness evidence", async () => {
    queryMock
      .mockResolvedValueOnce([
        [
          {
            oneshot_run_id: 124,
            jira_key: "CPDEV-124",
            source_task_management_id: 10,
            customer_name: "MHK",
            state: "pr_open",
            review_loop_count: 1,
            max_review_loops: 3,
            current_pr_url: "https://github.com/org/repo/pull/13",
            current_plan_version: 1,
            current_review_version: 1,
            current_implementation_version: 1,
            current_code_review_version: 1,
            current_test_version: 1,
            final_disposition: null,
            last_error: null,
            repo_name: "core-app",
            repo_url: "https://github.com/org/repo",
            branch_name: "master",
            base_commit_sha: "abc",
            task_description: "# Task: CPDEV-124 Legacy PR",
            implementation_metadata_json: JSON.stringify({
              implementationCommitSha: "def",
            }),
            total_tokens_used: 10,
            created_at: new Date("2026-05-01T00:00:00.000Z"),
            updated_at: new Date("2026-05-01T00:10:00.000Z"),
          },
        ],
      ])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([[]]);

    await expect(getOneShotRowByDashboardId("run-124")).resolves.toMatchObject({
      completionStatus: null,
      readiness: null,
      readinessReasons: [],
    });
  });
});
