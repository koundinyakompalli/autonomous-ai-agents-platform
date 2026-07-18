import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotDashboardRow } from "../types/oneshot.js";

const { getOneShotDashboardRowsMock, queryMock } = vi.hoisted(() => ({
  getOneShotDashboardRowsMock: vi.fn(),
  queryMock: vi.fn(),
}));

vi.mock("../db.js", () => ({
  getPool: () => ({
    query: queryMock,
  }),
}));

vi.mock("./oneshot.js", () => ({
  getOneShotDashboardRows: getOneShotDashboardRowsMock,
}));

const {
  generateOneShotCostReport,
  renderOneShotCostReportCsv,
  renderOneShotCostReportHtml,
} = await import("./oneshotCostReports.js");

function makeRow(
  overrides: Partial<OneShotDashboardRow>,
): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Fixture title",
    jiraIssueType: "Story",
    ticketType: "story",
    ticketTypeSource: "jira_issue_type",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: "Acme",
    displayState: "completed",
    progressStage: "pr_complete",
    progressPercent: 100,
    repoName: "core-app",
    repoUrl: null,
    baseBranch: "main",
    baseCommitSha: "abc123",
    implementationBranch: "oneshot/cpdev-1-run-1",
    implementationCommitSha: "def456",
    workspace: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    planReviewLoopCount: 0,
    maxPlanReviewLoops: 3,
    verificationLoopCount: 0,
    maxVerificationLoops: 0,
    currentPrUrl: null,
    qualificationSummary: null,
    lastError: null,
    lastErrorSummary: null,
    readiness: "ready",
    readinessReasons: [],
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
    createdAt: "2026-06-08T10:00:00.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-06-08T11:00:00.000Z",
    totalTokensUsed: 1_000,
    estimatedCostUsd: 1.25,
    costSource: "actual",
    ...overrides,
  };
}

describe("oneshot cost reports", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-08T12:00:00.000Z"));
    getOneShotDashboardRowsMock.mockReset();
    queryMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes all runs created in range and computes terminal vs active durations", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        title: 'Sonar "failed" issue',
        jiraIssueType: "Defect",
        ticketType: "sonar",
        displayState: "failed",
        progressStage: "implementation",
        createdAt: "2026-06-07T10:00:00.000Z",
        updatedAt: "2026-06-07T11:00:00.000Z",
        totalTokensUsed: 1_500,
        estimatedCostUsd: 12.34,
      }),
      makeRow({
        dashboardId: "run-2",
        oneshotRunId: 2,
        jiraKey: "CPDEV-2",
        title: "Sonar active issue",
        ticketType: "sonar",
        displayState: "planning",
        progressStage: "planning",
        createdAt: "2026-06-08T10:00:00.000Z",
        updatedAt: "2026-06-08T11:00:00.000Z",
        totalTokensUsed: 900,
        estimatedCostUsd: 0.5,
        costSource: "estimated",
      }),
      makeRow({
        dashboardId: "run-3",
        oneshotRunId: 3,
        jiraKey: "CPDEV-3",
        ticketType: "story",
        createdAt: "2026-06-08T10:00:00.000Z",
      }),
      makeRow({
        dashboardId: "run-4",
        oneshotRunId: 4,
        jiraKey: "CPDEV-4",
        ticketType: "sonar",
        createdAt: "2026-05-30T10:00:00.000Z",
      }),
      makeRow({
        dashboardId: "qualifier-task-9",
        oneshotRunId: null,
        jiraKey: "CPDEV-9",
        ticketType: "sonar",
      }),
    ]);
    queryMock.mockResolvedValue([
      [
        {
          oneshot_run_id: 1,
          stage_cost_usd: null,
          stage_tokens_used: null,
          tokens_used: null,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
          model_usage: JSON.stringify({
            "us.anthropic.claude-sonnet-4-6": {
              input: 1_000,
              output: 500,
            },
          }),
        },
        {
          oneshot_run_id: 2,
          stage_cost_usd: "0.2",
          stage_tokens_used: "1000",
          tokens_used: null,
          model: "us.anthropic.claude-opus-4-6",
          provider: "anthropic",
          model_usage: null,
        },
      ],
    ]);

    const report = await generateOneShotCostReport({
      range: "7d",
      ticketType: "sonar",
    });

    expect(report.rows.map((row) => row.jiraKey)).toEqual([
      "CPDEV-2",
      "CPDEV-1",
    ]);
    expect(report.rows.map((row) => row.displayState)).toEqual([
      "planning",
      "failed",
    ]);
    expect(report.rows.find((row) => row.jiraKey === "CPDEV-1")?.durationMs).toBe(
      60 * 60 * 1000,
    );
    expect(report.rows.find((row) => row.jiraKey === "CPDEV-2")?.durationMs).toBe(
      2 * 60 * 60 * 1000,
    );
    expect(report.totals).toMatchObject({
      runCount: 2,
      totalCostUsd: 12.84,
      totalTokens: 2400,
      costSource: "mixed",
    });
    expect(report.byTicketType).toMatchObject([
      { ticketType: "sonar", runCount: 2, totalCostUsd: 12.84 },
    ]);
    expect(report.byTicketTypeAndState).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ticketType: "sonar",
          displayState: "failed",
          runCount: 1,
        }),
        expect.objectContaining({
          ticketType: "sonar",
          displayState: "planning",
          runCount: 1,
        }),
      ]),
    );
    expect(report.modelColumns.map((column) => column.costColumn)).toEqual(
      expect.arrayContaining([
        "claude_opus_4_6_cost_usd",
        "claude_sonnet_4_6_cost_usd",
      ]),
    );
  });

  it("renders a wide CSV with escaped values and model columns", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        title: 'CSV, "wide" ticket',
        ticketType: "security",
      }),
    ]);
    queryMock.mockResolvedValue([
      [
        {
          oneshot_run_id: 1,
          stage_cost_usd: "1.5",
          stage_tokens_used: "3000",
          tokens_used: null,
          model: "gpt-5.4",
          provider: "openai",
          model_usage: null,
        },
      ],
    ]);

    const report = await generateOneShotCostReport({
      range: "24h",
      ticketType: "all",
    });
    const csv = renderOneShotCostReportCsv(report);

    expect(csv.split("\n")[0]).toContain("gpt_5_4_cost_usd,gpt_5_4_tokens");
    expect(csv).toContain('"CSV, ""wide"" ticket"');
    expect(csv).toContain("security");
    expect(csv).not.toContain("model_breakdown");
  });

  it("adds an unattributed model bucket when row totals have no model metrics", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        ticketType: "story",
        totalTokensUsed: 4_200,
        estimatedCostUsd: 9.75,
      }),
    ]);
    queryMock.mockResolvedValue([[]]);

    const report = await generateOneShotCostReport({
      range: "24h",
      ticketType: "all",
    });

    expect(report.modelColumns.map((column) => column.costColumn)).toContain(
      "unattributed_llm_cost_usd",
    );
    const csv = renderOneShotCostReportCsv(report);
    expect(csv.split("\n")[0]).toContain(
      "unattributed_llm_cost_usd,unattributed_llm_tokens",
    );
    expect(csv).toContain(",9.75,4200\n");
    expect(csv).not.toContain("model_breakdown");
    expect(report.rows[0]?.modelValues.unattributed_llm).toEqual({
      costUsd: 9.75,
      tokens: 4_200,
    });
    expect(report.rows[0]?.modelBreakdown).toEqual([
      expect.objectContaining({
        key: "unattributed_llm",
        label: "Unattributed LLM",
        costUsd: 9.75,
        tokens: 4_200,
      }),
    ]);
  });

  it("adds only residual unattributed cost and tokens for partial model metrics", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        ticketType: "story",
        totalTokensUsed: 1_000,
        estimatedCostUsd: 5,
      }),
    ]);
    queryMock.mockResolvedValue([
      [
        {
          oneshot_run_id: 1,
          stage_cost_usd: "2",
          stage_tokens_used: "400",
          tokens_used: null,
          model: "gpt-5.4",
          provider: "openai",
          model_usage: null,
        },
      ],
    ]);

    const report = await generateOneShotCostReport({
      range: "24h",
      ticketType: "all",
    });

    expect(report.rows[0]?.modelValues.gpt_5_4).toEqual({
      costUsd: 2,
      tokens: 400,
    });
    expect(report.rows[0]?.modelValues.unattributed_llm).toEqual({
      costUsd: 3,
      tokens: 600,
    });
  });

  it("does not create negative residuals when captured model metrics exceed row totals", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        ticketType: "story",
        totalTokensUsed: 100,
        estimatedCostUsd: 1,
      }),
    ]);
    queryMock.mockResolvedValue([
      [
        {
          oneshot_run_id: 1,
          stage_cost_usd: "2",
          stage_tokens_used: "200",
          tokens_used: null,
          model: "gpt-5.4",
          provider: "openai",
          model_usage: null,
        },
      ],
    ]);

    const report = await generateOneShotCostReport({
      range: "24h",
      ticketType: "all",
    });

    expect(report.rows[0]?.modelValues.gpt_5_4).toEqual({
      costUsd: 2,
      tokens: 200,
    });
    expect(report.rows[0]?.modelValues.unattributed_llm).toBeUndefined();
  });

  it("neutralizes spreadsheet formulas in CSV text cells while preserving numeric cells", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        title: '=HYPERLINK("https://example.test","open")',
        ticketType: "story",
        totalTokensUsed: 1_000,
        estimatedCostUsd: 1.25,
        createdAt: "2026-06-08T10:00:00.000Z",
        updatedAt: "2026-06-08T11:00:00.000Z",
      }),
    ]);
    queryMock.mockResolvedValue([[]]);

    const report = await generateOneShotCostReport({
      range: "24h",
      ticketType: "all",
    });
    const csv = renderOneShotCostReportCsv(report);

    expect(csv).toContain(
      `"'=HYPERLINK(""https://example.test"",""open"")"`,
    );
    expect(csv).toContain(",60,1,1.25,1000,actual,1.25,1000");
  });

  it("renders escaped HTML summaries and run rows", async () => {
    getOneShotDashboardRowsMock.mockResolvedValue([
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        title: "<script>alert(1)</script>",
        ticketType: "defect",
        displayState: "completed",
      }),
    ]);
    queryMock.mockResolvedValue([[]]);

    const report = await generateOneShotCostReport({
      range: "24h",
      ticketType: "defect",
    });
    const html = renderOneShotCostReportHtml(report);

    expect(html).toContain("By Ticket Type");
    expect(html).toContain("By Ticket Type and State");
    expect(html).toContain("Unattributed LLM Cost");
    expect(html).toContain("Unattributed LLM Tokens");
    expect(html).not.toContain("Model Breakdown");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
});
