import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OneShotDashboardRow } from "../types/oneshot.js";

const queryMock = vi.fn();

vi.mock("../db.js", () => ({
  getPool: () => ({
    query: queryMock,
  }),
}));

const { buildOneShotDashboardAnalytics } =
  await import("./oneshotAnalytics.js");

type ArtifactFixture = {
  oneshot_run_id: number;
  artifact_stage: string;
  recorded_at: string;
  stage_duration_ms: number | string | null;
  stage_cost_usd: number | string | null;
  stage_tokens_used: number | string | null;
  tokens_used?: unknown;
  model: string | null;
  provider: string | null;
  model_usage?: unknown;
};

type EventFixture = {
  oneshot_run_id?: number;
  stage: string;
  event_type: "run_claimed" | "state_transition";
  to_state?: string;
  occurred_at: string;
};

function isoHoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function isWithinQueryStart(
  timestamp: string,
  params: readonly unknown[] | undefined,
): boolean {
  const start = params?.[0];
  if (!(start instanceof Date)) {
    return true;
  }
  return new Date(timestamp).getTime() >= start.getTime();
}

function groupedStageRows(events: readonly EventFixture[]) {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.stage, (counts.get(event.stage) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([stage, stage_count]) => ({
    stage,
    stage_count,
  }));
}

function installBackendSignalMock({
  artifacts = [],
  events = [],
}: {
  artifacts?: ArtifactFixture[];
  events?: EventFixture[];
}) {
  queryMock.mockImplementation(
    async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes("FROM oneshot_artifacts a")) {
        return [
          artifacts.filter((row) =>
            isWithinQueryStart(row.recorded_at, params),
          ),
        ];
      }

      if (
        sql.includes("SELECT oneshot_run_id") &&
        sql.includes("to_state IN ('pr_open'")
      ) {
        return [
          events
            .filter(
              (event) =>
                event.oneshot_run_id != null &&
                event.event_type === "state_transition" &&
                (event.to_state === "pr_open" ||
                  event.to_state === "failed" ||
                  event.to_state === "qualification_failed"),
            )
            .map((event) => ({
              oneshot_run_id: event.oneshot_run_id,
              to_state: event.to_state,
              occurred_at: event.occurred_at,
            })),
        ];
      }

      if (sql.includes("event_type = 'run_claimed'")) {
        return [
          groupedStageRows(
            events.filter(
              (event) =>
                event.event_type === "run_claimed" &&
                isWithinQueryStart(event.occurred_at, params),
            ),
          ),
        ];
      }

      if (sql.includes("to_state = 'failed'")) {
        return [
          groupedStageRows(
            events.filter(
              (event) =>
                event.event_type === "state_transition" &&
                event.to_state === "failed" &&
                isWithinQueryStart(event.occurred_at, params),
            ),
          ),
        ];
      }

      if (sql.includes("FROM agents")) {
        return [[{ worker_count: 6 }]];
      }

      throw new Error(`Unexpected query: ${sql}`);
    },
  );
}

function makeRow(overrides: Partial<OneShotDashboardRow>): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Test row",
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
    createdAt: isoHoursAgo(2),
    lastManualRestartAt: null,
    updatedAt: isoHoursAgo(1),
    totalTokensUsed: 1_000,
    estimatedCostUsd: 0.01,
    costSource: "actual",
    ...overrides,
  };
}

function excludedQualifierFailure(): NonNullable<
  OneShotDashboardRow["failureAttribution"]
> {
  return {
    attribution: "unknown",
    errorCategory: "unknown",
    qualifierReasonCode: "repo_resolution_failed",
    label: "Needs Triage",
    rationale: "Gating outcome — excluded from failure denominator.",
    excludedFromDenominator: true,
  };
}

describe("buildOneShotDashboardAnalytics", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
    queryMock.mockReset();
    process.env = { ...originalEnv };
    delete process.env.QUALIFIER_DESIRED_COUNT;
    delete process.env.ONESHOT_PLANNER_DESIRED_COUNT;
    delete process.env.ONESHOT_REVIEWER_DESIRED_COUNT;
    delete process.env.ONESHOT_IMPLEMENTER_DESIRED_COUNT;
    delete process.env.ONESHOT_CODE_REVIEWER_DESIRED_COUNT;
    delete process.env.ONESHOT_TESTER_DESIRED_COUNT;

    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 4,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: "120000",
          stage_cost_usd: "0.123",
          stage_tokens_used: "1500",
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
      ],
      events: [
        {
          stage: "implementation",
          event_type: "run_claimed",
          occurred_at: isoHoursAgo(2),
        },
        {
          stage: "implementation",
          event_type: "run_claimed",
          occurred_at: isoHoursAgo(1),
        },
        {
          stage: "implementation",
          event_type: "state_transition",
          to_state: "failed",
          occurred_at: isoHoursAgo(1),
        },
      ],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("builds overview, agent, and queue analytics from backend-backed signals", async () => {
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-1",
        jiraKey: "CPDEV-1",
        displayState: "completed",
        progressStage: "pr_complete",
        completionStatus: "completed_ready",
        readiness: "ready",
        createdAt: isoHoursAgo(5),
        updatedAt: isoHoursAgo(4),
        totalTokensUsed: 2_000,
      }),
      makeRow({
        dashboardId: "qualifier-task-2",
        jiraKey: "CPDEV-2",
        oneshotRunId: null,
        displayState: "qualification_failed",
        progressStage: "qualification",
        repoName: null,
        repoUrl: null,
        baseBranch: null,
        baseCommitSha: null,
        implementationBranch: null,
        implementationCommitSha: null,
        currentPrUrl: null,
        totalTokensUsed: 0,
        estimatedCostUsd: 0,
        costSource: "estimated",
      }),
      makeRow({
        dashboardId: "run-3",
        jiraKey: "CPDEV-3",
        displayState: "queued_for_planning",
        progressStage: "planning",
        createdAt: isoHoursAgo(3),
        updatedAt: isoHoursAgo(3),
        totalTokensUsed: 0,
        estimatedCostUsd: 0,
        costSource: "estimated",
      }),
      makeRow({
        dashboardId: "run-4",
        jiraKey: "CPDEV-4",
        displayState: "implementing",
        progressStage: "implementation",
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
        totalTokensUsed: 4_000,
      }),
      makeRow({
        dashboardId: "run-5",
        jiraKey: "CPDEV-5",
        displayState: "approved",
        progressStage: "review",
        createdAt: isoHoursAgo(1),
        updatedAt: isoHoursAgo(1),
        totalTokensUsed: 500,
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.runs24h).toBe(5);
    expect(analytics.overview24h.completed).toBe(1);
    expect(analytics.overview24h.failed).toBe(1);
    expect(analytics.overview24h.running).toBe(1);
    expect(analytics.overview24h.queued).toBe(1);
    expect(analytics.overview24h.waiting).toBe(1);
    expect(analytics.overview24h.passRate).toBe(0.5);
    // Tokens stay aligned with the Costs tab attribution total, while Overview
    // spend uses the same row-level top-line USD as the Costs tab.
    expect(analytics.overview24h.totalTokens).toBe(8_000);
    expect(analytics.overview24h.estimatedCostUsd).toBe(
      analytics.costs.totalUsd,
    );
    expect(analytics.overview24h.estimatedCostUsd).toBe(0.03);
    expect(analytics.overview24h.costSource).toBe("actual");
    expect(analytics.overview24h.attemptFailures24h).toBe(1);

    expect(analytics.queue).toEqual({
      queued: 1,
      running: 1,
      waiting: 1,
      recentlyFinished: 2,
      workerCapacity: 6,
    });

    const qualification = analytics.agents.find(
      (entry) => entry.stage === "qualification",
    );
    expect(qualification).toMatchObject({
      runs: 1,
      failRate: 1,
      avgTokens: 0,
    });

    const implementation = analytics.agents.find(
      (entry) => entry.stage === "implementation",
    );
    expect(implementation).toMatchObject({
      runs: 2,
      avgLatencyMs: 120_000,
      failRate: 0.5,
      avgTokens: 1_500,
    });
    expect(implementation?.recentSamples.length).toBeGreaterThan(0);

    expect(analytics.throughput.window.range).toBe("24h");
    expect(analytics.throughput.totalRuns).toBe(5);
    expect(analytics.throughput.buckets).toHaveLength(48);

    expect(analytics.costs.totalUsd).toBe(0.03);
    expect(analytics.costs.costSource).toBe("actual");
    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "implementation"),
    ).toMatchObject({
      tokens: 1_500,
      usd: 0.123,
    });
    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "qualification"),
    ).toMatchObject({
      tokens: null,
      usd: null,
      share: null,
    });
    expect(analytics.costs.byModel[0]).toMatchObject({
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      usd: 0.123,
    });
  });

  it("treats ticket-attributed qualifier rejections as warning samples and clusters by qualification reason", async () => {
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "qualifier-task-2487",
        jiraKey: "CPDEV-22346",
        oneshotRunId: null,
        displayState: "qualification_failed",
        progressStage: "qualification",
        qualificationSummary:
          "acceptance_criteria_missing: no explicit Acceptance Criteria section is present",
        failureAttribution: {
          attribution: "ticket",
          errorCategory: "ticket_quality",
          qualifierReasonCode: "llm_rejected",
          label: "Ticket Not Ready",
          rationale: "Ticket-quality issue.",
          excludedFromDenominator: false,
        },
        repoName: null,
        repoUrl: null,
        baseBranch: null,
        baseCommitSha: null,
        implementationBranch: null,
        implementationCommitSha: null,
        currentPrUrl: null,
        totalTokensUsed: 0,
        estimatedCostUsd: 0,
        costSource: "estimated",
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);
    const qualification = analytics.agents.find(
      (entry) => entry.stage === "qualification",
    );

    expect(analytics.overview24h.failed).toBe(1);
    expect(qualification).toMatchObject({
      runs: 1,
      failRate: 0,
      recentSamples: [
        expect.objectContaining({
          dashboardId: "qualifier-task-2487",
          tone: "warning",
        }),
      ],
    });
    expect(analytics.failures.clusters[0]).toMatchObject({
      headline:
        "acceptance_criteria_missing: no explicit Acceptance Criteria section is present",
      representativeDashboardId: "qualifier-task-2487",
    });
    expect(analytics.failures.clusters[0].headline).not.toBe("Unknown error");
  });

  it("aggregates Opus planning artifacts under the Opus model", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 85,
          artifact_stage: "plan",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 86_214,
          stage_cost_usd: 1.5,
          stage_tokens_used: 115_947,
          model: "us.anthropic.claude-opus-4-6-v1",
          provider: "anthropic",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-85",
        jiraKey: "CPDEV-21586",
        oneshotRunId: 85,
        displayState: "queued_for_review",
        progressStage: "review",
        totalTokensUsed: 115_947,
        estimatedCostUsd: 1.5,
        costSource: "actual",
      }),
    ]);

    expect(analytics.costs.byModel).toContainEqual(
      expect.objectContaining({
        model: "claude-opus-4-6",
        provider: "anthropic",
        tokens: 115_947,
        usd: 1.5,
        rawModelIds: ["us.anthropic.claude-opus-4-6-v1"],
      }),
    );
    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "planning"),
    ).toMatchObject({
      tokens: 115_947,
      usd: 1.5,
    });
  });

  it("keeps per-provider model cost buckets distinct for mixed stage models", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 90,
          artifact_stage: "plan",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 86_214,
          stage_cost_usd: 1.5,
          stage_tokens_used: 115_947,
          model: "us.anthropic.claude-opus-4-6-v1",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 90,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 120_000,
          stage_cost_usd: 7.02,
          stage_tokens_used: 33_346,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 90,
          artifact_stage: "review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 45_000,
          stage_cost_usd: 1.53,
          stage_tokens_used: 12_602,
          model: "us.anthropic.claude-opus-4-6-v1",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 91,
          artifact_stage: "code_review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 45_000,
          stage_cost_usd: 0.2,
          stage_tokens_used: 1_000,
          model: "gpt-5.4",
          provider: "openai",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-90",
        jiraKey: "CPDEV-90",
        oneshotRunId: 90,
        totalTokensUsed: 161_895,
        estimatedCostUsd: 10.05,
        costSource: "actual",
      }),
      makeRow({
        dashboardId: "run-91",
        jiraKey: "CPDEV-91",
        oneshotRunId: 91,
        totalTokensUsed: 1_000,
        estimatedCostUsd: 0.2,
        costSource: "actual",
      }),
    ]);

    expect(analytics.costs.byModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "claude-opus-4-6",
          provider: "anthropic",
          tokens: 128_549,
          usd: 3.03,
        }),
        expect.objectContaining({
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          tokens: 33_346,
          usd: 7.02,
        }),
        expect.objectContaining({
          model: "gpt-5.4",
          provider: "openai",
          tokens: 1_000,
          usd: 0.2,
        }),
      ]),
    );
  });

  it("cleans non-billable model buckets and merges resolvable aliases", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 93,
          artifact_stage: "plan",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 1,
          stage_tokens_used: 1_000,
          model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          provider: null,
        },
        {
          oneshot_run_id: 93,
          artifact_stage: "review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 2,
          stage_tokens_used: 2_000,
          model: "anthropic.claude-haiku-4-5-20251001-v1:0",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 93,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0.5,
          stage_tokens_used: 123,
          model: "mystery-model",
          provider: null,
        },
        {
          oneshot_run_id: 93,
          artifact_stage: "code_review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0,
          stage_tokens_used: 0,
          model: "disabled",
          provider: "config",
        },
        {
          oneshot_run_id: 93,
          artifact_stage: "code_review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0,
          stage_tokens_used: 0,
          model: "advisory",
          provider: "soft_gate",
        },
        {
          oneshot_run_id: 93,
          artifact_stage: "testing",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0,
          stage_tokens_used: 0,
          model: "unknown",
          provider: "anthropic",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-93",
        jiraKey: "CPDEV-93",
        oneshotRunId: 93,
        totalTokensUsed: 3_123,
        estimatedCostUsd: 3.5,
        costSource: "actual",
      }),
    ]);

    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "planning"),
    ).toMatchObject({ tokens: 1_000, usd: 1 });
    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "review"),
    ).toMatchObject({ tokens: 2_000, usd: 2 });
    expect(analytics.costs.totalUsd).toBe(3.5);
    expect(analytics.costs.totalTokens).toBe(3_123);
    expect(analytics.costs.byModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "claude-haiku-4-5",
          provider: "anthropic",
          tokens: 3_000,
          usd: 3,
          rawModelIds: [
            "anthropic.claude-haiku-4-5-20251001-v1:0",
            "us.anthropic.claude-haiku-4-5-20251001-v1:0",
          ],
        }),
        expect.objectContaining({
          model: "Unattributed LLM",
          provider: null,
          tokens: 123,
          usd: 0.5,
          rawModelIds: ["mystery-model"],
        }),
      ]),
    );
    expect(
      analytics.costs.byModel.map((entry) => `${entry.provider}:${entry.model}`),
    ).not.toEqual(
      expect.arrayContaining([
        "config:disabled",
        "soft_gate:advisory",
        "anthropic:unknown",
      ]),
    );
    expect(
      analytics.costs.byModel.find(
        (entry) => entry.model === "claude-haiku-4-5",
      )?.pricing,
    ).toMatchObject({
      inputUsdPerMillion: 1.1,
      outputUsdPerMillion: 5.5,
      blendedUsdPerMillion: 3.3,
    });
    expect(
      analytics.costs.byModel.find(
        (entry) => entry.model === "Unattributed LLM",
      )?.pricing,
    ).toBeNull();
  });

  it("uses the highest-token raw model id for merged pricing metadata", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 96,
          artifact_stage: "plan",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0.027,
          stage_tokens_used: 3_000,
          model: "global.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 96,
          artifact_stage: "review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0.0099,
          stage_tokens_used: 1_000,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-96",
        jiraKey: "CPDEV-96",
        oneshotRunId: 96,
        totalTokensUsed: 4_000,
        estimatedCostUsd: 0.0369,
        costSource: "actual",
      }),
    ]);

    expect(
      analytics.costs.byModel.find(
        (entry) => entry.model === "claude-sonnet-4-6",
      ),
    ).toMatchObject({
      provider: "anthropic",
      tokens: 4_000,
      usd: 0.0369,
      rawModelIds: [
        "global.anthropic.claude-sonnet-4-6",
        "us.anthropic.claude-sonnet-4-6",
      ],
      pricing: expect.objectContaining({
        inputUsdPerMillion: 3,
        outputUsdPerMillion: 15,
        blendedUsdPerMillion: 9,
        sourceModel: "global.anthropic.claude-sonnet-4-6",
      }),
    });
  });

  it("normalizes Sonnet 5 model rows and exposes dashboard pricing metadata", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 97,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: null,
          stage_tokens_used: 1_000_000,
          model: "us.anthropic.claude-sonnet-5-20260701-v1:0",
          provider: "anthropic",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-97",
        jiraKey: "CPDEV-97",
        oneshotRunId: 97,
        totalTokensUsed: 1_000_000,
        estimatedCostUsd: 9.9,
        costSource: "estimated",
      }),
    ]);

    expect(analytics.costs.byModel).toContainEqual(
      expect.objectContaining({
        model: "claude-sonnet-5",
        provider: "anthropic",
        tokens: 1_000_000,
        usd: 9.9,
        rawModelIds: ["us.anthropic.claude-sonnet-5-20260701-v1:0"],
        pricing: expect.objectContaining({
          inputUsdPerMillion: 3.3,
          outputUsdPerMillion: 16.5,
          blendedUsdPerMillion: 9.9,
          cacheReadUsdPerMillion: 0.33,
          cacheWriteUsdPerMillion: 4.125,
          sourceModel: "us.anthropic.claude-sonnet-5-20260701-v1:0",
        }),
      }),
    );
  });

  it("excludes deterministic plan-contract guardrail rows from the by-model ladder while retaining Sonnet 5", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 98,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: null,
          stage_tokens_used: 1_000_000,
          model: "us.anthropic.claude-sonnet-5",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 98,
          artifact_stage: "review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0,
          stage_tokens_used: 0,
          model: "plan-contract-v1",
          provider: "deterministic_guardrail",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-98",
        jiraKey: "CPDEV-98",
        oneshotRunId: 98,
        totalTokensUsed: 1_000_000,
        estimatedCostUsd: 9.9,
        costSource: "estimated",
      }),
    ]);

    expect(analytics.costs.byModel).toContainEqual(
      expect.objectContaining({
        model: "claude-sonnet-5",
        provider: "anthropic",
        tokens: 1_000_000,
        usd: 9.9,
      }),
    );
    expect(
      analytics.costs.byModel.map((entry) => `${entry.provider}:${entry.model}`),
    ).not.toEqual(
      expect.arrayContaining([
        "deterministic_guardrail:plan-contract-v1",
      ]),
    );
    expect(
      analytics.costs.byModel.find((entry) => entry.model === "plan-contract-v1"),
    ).toBeUndefined();
  });

  it("splits by-model attribution from persisted Claude model_usage", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 92,
          artifact_stage: "plan",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0.999,
          stage_tokens_used: 1_500,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
          model_usage: JSON.stringify({
            "claude-sonnet-4-6": { input: 1_000, output: 100 },
            "claude-haiku-4-5": { input: 300, output: 100 },
          }),
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-92",
        jiraKey: "CPDEV-92",
        oneshotRunId: 92,
        totalTokensUsed: 1_500,
        estimatedCostUsd: 0.999,
        costSource: "actual",
      }),
    ]);

    expect(analytics.costs.byStage.find((entry) => entry.stage === "planning"))
      .toMatchObject({ tokens: 1_500, usd: 0.999 });
    expect(analytics.costs.byModel).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "claude-sonnet-4-6",
          provider: "anthropic",
          tokens: 1_100,
          usd: 0.00495,
          pricing: expect.objectContaining({
            inputUsdPerMillion: 3.3,
            outputUsdPerMillion: 16.5,
            blendedUsdPerMillion: 9.9,
            sourceModel: "us.anthropic.claude-sonnet-4-6",
          }),
        }),
        expect.objectContaining({
          model: "claude-haiku-4-5",
          provider: "anthropic",
          tokens: 400,
          usd: 0.00088,
          pricing: expect.objectContaining({
            inputUsdPerMillion: 1.1,
            outputUsdPerMillion: 5.5,
            blendedUsdPerMillion: 3.3,
            sourceModel: "us.anthropic.claude-haiku-4-5",
          }),
        }),
      ]),
    );
  });

  it("prefers raw input and output usage over normalized stage token totals", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 93,
          artifact_stage: "review",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0.5,
          stage_tokens_used: 57_143,
          tokens_used: JSON.stringify({
            input: 120,
            output: 30,
            cacheRead: 50_000,
            cacheWrite: 10_000,
          }),
          model: "gpt-5.4",
          provider: "openai",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-93",
        jiraKey: "CPDEV-93",
        oneshotRunId: 93,
        totalTokensUsed: 150,
        estimatedCostUsd: 0.5,
        costSource: "actual",
      }),
    ]);

    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "review"),
    ).toMatchObject({ tokens: 150, usd: 0.5 });
    expect(analytics.costs.byModel).toContainEqual(
      expect.objectContaining({
        model: "gpt-5.4",
        provider: "openai",
        tokens: 150,
        usd: 0.5,
      }),
    );
  });

  it("keeps legacy row token totals when no stage metrics are captured", async () => {
    installBackendSignalMock({});

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-94",
        jiraKey: "CPDEV-94",
        oneshotRunId: 94,
        totalTokensUsed: 900,
        estimatedCostUsd: 7.2,
        costSource: "estimated",
      }),
    ]);

    expect(analytics.costs.totalUsd).toBe(7.2);
    expect(analytics.costs.totalTokens).toBe(900);
    expect(analytics.costs.topRuns[0]).toMatchObject({
      dashboardId: "run-94",
      totalTokensUsed: 900,
    });
    expect(analytics.costs.byModel).toContainEqual(
      expect.objectContaining({
        model: "Unattributed LLM",
        provider: null,
        tokens: 900,
        usd: 7.2,
        pricing: null,
      }),
    );
  });

  it("includes newly captured qualification metrics in stage and model costs", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 86,
          artifact_stage: "qualification",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 33_000,
          stage_cost_usd: 0.04,
          stage_tokens_used: 4_500,
          model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          provider: "anthropic",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-86",
        jiraKey: "CPDEV-21640",
        oneshotRunId: 86,
        displayState: "queued_for_planning",
        progressStage: "planning",
        totalTokensUsed: 4_500,
        estimatedCostUsd: 0.04,
        costSource: "actual",
      }),
    ]);

    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "qualification"),
    ).toMatchObject({
      tokens: 4_500,
      usd: 0.04,
    });
    expect(analytics.costs.byModel).toContainEqual(
      expect.objectContaining({
        model: "claude-sonnet-4-5",
        provider: "anthropic",
        tokens: 4_500,
        usd: 0.04,
      }),
    );
  });

  it("includes qualifier-only LLM task metrics without requiring a child OneShot run", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 0,
          artifact_stage: "qualification",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 18_000,
          stage_cost_usd: 0.025,
          stage_tokens_used: 1_500,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "qualifier-task-2164",
        jiraKey: "CPDEV-2164",
        oneshotRunId: null,
        displayState: "qualification_no_action",
        progressStage: "qualification",
        repoName: null,
        repoUrl: null,
        baseBranch: null,
        baseCommitSha: null,
        implementationBranch: null,
        implementationCommitSha: null,
        currentPrUrl: null,
        totalTokensUsed: 1_500,
        estimatedCostUsd: 0.025,
        costSource: "actual",
      }),
    ]);

    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "qualification"),
    ).toMatchObject({
      tokens: 1_500,
      usd: 0.025,
    });
    expect(analytics.costs.byModel).toContainEqual(
      expect.objectContaining({
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        tokens: 1_500,
        usd: 0.025,
      }),
    );
  });

  it("queries qualifier task metrics with a child-run double-counting guard", async () => {
    await buildOneShotDashboardAnalytics([]);

    const sql = String(queryMock.mock.calls[0]?.[0] ?? "");
    expect(sql).toContain("FROM task_management tm");
    expect(sql).toContain("NOT EXISTS");
    expect(sql).toContain("qa.stage = 'qualification'");
  });

  it("keeps legacy qualification artifacts without metrics as unknown cost", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 85,
          artifact_stage: "qualification",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: null,
          stage_cost_usd: null,
          stage_tokens_used: null,
          model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
          provider: "anthropic",
        },
      ],
    });

    const analytics = await buildOneShotDashboardAnalytics([
      makeRow({
        dashboardId: "run-85",
        jiraKey: "CPDEV-21639",
        oneshotRunId: 85,
        displayState: "queued_for_planning",
        progressStage: "planning",
        totalTokensUsed: 0,
        estimatedCostUsd: 0,
        costSource: "estimated",
      }),
    ]);

    expect(
      analytics.costs.byStage.find((entry) => entry.stage === "qualification"),
    ).toMatchObject({
      tokens: null,
      usd: null,
      share: null,
    });
  });

  it("excludes qualifier no-action rows from failure counts and measured health", async () => {
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "qualifier-task-1",
        jiraKey: "CPDEV-1",
        oneshotRunId: null,
        displayState: "qualification_no_action",
        progressStage: "qualification",
        qualificationSummary:
          "No OneShot action was taken because the PFOS label was missing when QUALIFIER processed the task.",
        repoName: null,
        repoUrl: null,
        baseBranch: null,
        baseCommitSha: null,
        implementationBranch: null,
        implementationCommitSha: null,
        currentPrUrl: null,
        totalTokensUsed: 0,
        estimatedCostUsd: 0,
        costSource: "estimated",
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);
    const qualification = analytics.agents.find(
      (entry) => entry.stage === "qualification",
    );

    expect(analytics.overview24h.failed).toBe(0);
    expect(analytics.failures.totalFailures).toBe(0);
    expect(analytics.failures.clusters).toEqual([]);
    expect(qualification).toMatchObject({
      runs: 0,
      failRate: 0,
      recentSamples: [],
    });
  });

  it("marks successful stage artifacts as warning when the run failed later", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 10,
          artifact_stage: "planning",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 30_000,
          stage_cost_usd: 0.05,
          stage_tokens_used: 500,
          model: "model-a",
          provider: "anthropic",
        },
      ],
      events: [],
    });
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-10",
        oneshotRunId: 10,
        jiraKey: "CPDEV-10",
        displayState: "failed",
        progressStage: "testing",
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);
    const planning = analytics.agents.find((entry) => entry.stage === "planning");

    expect(planning?.recentSamples[0]).toMatchObject({
      dashboardId: "run-10",
      tone: "warning",
    });
  });

  it("applies 24h, 7d, 30d, and all-time windows to selected analytics", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 1,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(2),
          stage_duration_ms: 10_000,
          stage_cost_usd: 0.1,
          stage_tokens_used: 100,
          model: "model-a",
          provider: "openai",
        },
        {
          oneshot_run_id: 2,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(3 * 24),
          stage_duration_ms: 20_000,
          stage_cost_usd: 0.2,
          stage_tokens_used: 200,
          model: "model-a",
          provider: "openai",
        },
        {
          oneshot_run_id: 3,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(20 * 24),
          stage_duration_ms: 30_000,
          stage_cost_usd: 0.3,
          stage_tokens_used: 300,
          model: "model-b",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 4,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(45 * 24),
          stage_duration_ms: 40_000,
          stage_cost_usd: 0.4,
          stage_tokens_used: 400,
          model: "model-c",
          provider: "anthropic",
        },
      ],
      events: [
        {
          stage: "implementation",
          event_type: "run_claimed",
          occurred_at: isoHoursAgo(2),
        },
        {
          stage: "implementation",
          event_type: "run_claimed",
          occurred_at: isoHoursAgo(3 * 24),
        },
        {
          stage: "implementation",
          event_type: "run_claimed",
          occurred_at: isoHoursAgo(20 * 24),
        },
        {
          stage: "implementation",
          event_type: "run_claimed",
          occurred_at: isoHoursAgo(45 * 24),
        },
      ],
    });

    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-1",
        oneshotRunId: 1,
        jiraKey: "CPDEV-1",
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
        estimatedCostUsd: 0.1,
      }),
      makeRow({
        dashboardId: "run-2",
        oneshotRunId: 2,
        jiraKey: "CPDEV-2",
        createdAt: isoHoursAgo(3 * 24),
        updatedAt: isoHoursAgo(3 * 24),
        estimatedCostUsd: 0.2,
      }),
      makeRow({
        dashboardId: "run-3",
        oneshotRunId: 3,
        jiraKey: "CPDEV-3",
        createdAt: isoHoursAgo(20 * 24),
        updatedAt: isoHoursAgo(20 * 24),
        estimatedCostUsd: 0.3,
      }),
      makeRow({
        dashboardId: "run-4",
        oneshotRunId: 4,
        jiraKey: "CPDEV-4",
        createdAt: isoHoursAgo(45 * 24),
        updatedAt: isoHoursAgo(45 * 24),
        estimatedCostUsd: 0.4,
      }),
    ];

    const analytics24h = await buildOneShotDashboardAnalytics(rows, "24h");
    const analytics7d = await buildOneShotDashboardAnalytics(rows, "7d");
    const analytics30d = await buildOneShotDashboardAnalytics(rows, "30d");
    const analyticsAll = await buildOneShotDashboardAnalytics(rows, "all");

    expect(analytics24h.throughput.totalRuns).toBe(1);
    expect(
      analytics24h.costs.byStage.find(
        (entry) => entry.stage === "implementation",
      ),
    ).toMatchObject({ tokens: 100, usd: 0.1 });
    expect(
      analytics24h.throughput.stageCompletion.find(
        (entry) => entry.stage === "implementation",
      ),
    ).toMatchObject({ attempts: 1 });

    expect(analytics7d.throughput.totalRuns).toBe(2);
    expect(analytics7d.throughput.buckets).toHaveLength(28);
    expect(
      analytics7d.costs.byStage.find(
        (entry) => entry.stage === "implementation",
      ),
    ).toMatchObject({ tokens: 300, usd: 0.3 });

    expect(analytics30d.throughput.totalRuns).toBe(3);
    expect(analytics30d.throughput.buckets).toHaveLength(30);
    expect(
      analytics30d.costs.byStage.find(
        (entry) => entry.stage === "implementation",
      ),
    ).toMatchObject({ tokens: 600, usd: 0.6 });

    expect(analyticsAll.throughput.totalRuns).toBe(4);
    expect(analyticsAll.throughput.window).toMatchObject({
      range: "all",
      isAllTime: true,
    });
    expect(analyticsAll.throughput.buckets.length).toBeLessThanOrEqual(36);
    expect(analyticsAll.throughput.trend).toBeNull();
    expect(analyticsAll.costs.trend).toBeNull();
    expect(
      analyticsAll.costs.byStage.find(
        (entry) => entry.stage === "implementation",
      ),
    ).toMatchObject({ tokens: 1_000, usd: 1 });
  });

  it("computes overview24h live counts across ALL ages, matching the Queue view", async () => {
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "old-waiting",
        jiraKey: "CPDEV-100",
        displayState: "approved",
        progressStage: "review",
        createdAt: isoHoursAgo(48),
        updatedAt: isoHoursAgo(48),
      }),
      makeRow({
        dashboardId: "old-queued",
        jiraKey: "CPDEV-101",
        displayState: "queued_for_planning",
        progressStage: "planning",
        createdAt: isoHoursAgo(72),
        updatedAt: isoHoursAgo(72),
      }),
      makeRow({
        dashboardId: "old-running",
        jiraKey: "CPDEV-102",
        displayState: "implementing",
        progressStage: "implementation",
        createdAt: isoHoursAgo(50),
        updatedAt: isoHoursAgo(50),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.runs24h).toBe(0);
    expect(analytics.overview24h.waiting).toBe(1);
    expect(analytics.overview24h.queued).toBe(1);
    expect(analytics.overview24h.running).toBe(1);
    expect(analytics.overview24h.running).toBe(analytics.queue.running);
    expect(analytics.overview24h.queued).toBe(analytics.queue.queued);
    expect(analytics.overview24h.waiting).toBe(analytics.queue.waiting);
  });

  it("computes PR pass rate from 24h terminal outcomes without a readiness gate, excluding qualification_no_action", async () => {
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "pr-open-not-ready",
        jiraKey: "CPDEV-110",
        displayState: "pr_open",
        readiness: "needs_review",
        createdAt: isoHoursAgo(3),
        updatedAt: isoHoursAgo(1),
      }),
      makeRow({
        dashboardId: "completed-ready",
        jiraKey: "CPDEV-111",
        displayState: "completed",
        readiness: "ready",
        createdAt: isoHoursAgo(4),
        updatedAt: isoHoursAgo(2),
      }),
      makeRow({
        dashboardId: "failed-row",
        jiraKey: "CPDEV-112",
        displayState: "failed",
        readiness: "draft",
        createdAt: isoHoursAgo(5),
        updatedAt: isoHoursAgo(1),
      }),
      makeRow({
        dashboardId: "no-action-row",
        jiraKey: "CPDEV-113",
        oneshotRunId: null,
        displayState: "qualification_no_action",
        progressStage: "qualification",
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    // pr_open with readiness=needs_review still counts as a pass; the
    // qualification_no_action row is excluded from both numerator/denominator.
    expect(analytics.overview24h.completed).toBe(2);
    expect(analytics.overview24h.failed).toBe(1);
    expect(analytics.overview24h.passRate).toBeCloseTo(2 / 3);
  });

  it("excludes qualifier-gating failures from the overview outcome denominator", async () => {
    installBackendSignalMock({});
    const passRows = Array.from({ length: 7 }, (_, idx) =>
      makeRow({
        dashboardId: `run-pass-${idx + 1}`,
        jiraKey: `CPDEV-${300 + idx}`,
        oneshotRunId: 300 + idx,
        displayState: "pr_open",
        progressStage: "pr_complete",
        createdAt: isoHoursAgo(3 + idx),
        updatedAt: isoHoursAgo(1),
      }),
    );
    const rows: OneShotDashboardRow[] = [
      ...passRows,
      makeRow({
        dashboardId: "run-real-failure",
        jiraKey: "CPDEV-390",
        oneshotRunId: 390,
        displayState: "failed",
        progressStage: "planning",
        createdAt: isoHoursAgo(4),
        updatedAt: isoHoursAgo(1),
      }),
      makeRow({
        dashboardId: "qualifier-task-excluded",
        jiraKey: "CPDEV-391",
        oneshotRunId: null,
        displayState: "qualification_failed",
        progressStage: "qualification",
        repoName: null,
        repoUrl: null,
        baseBranch: null,
        baseCommitSha: null,
        implementationBranch: null,
        implementationCommitSha: null,
        currentPrUrl: null,
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
        failureAttribution: excludedQualifierFailure(),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.completed).toBe(7);
    expect(analytics.overview24h.failed).toBe(1);
    expect(analytics.overview24h.passRate).toBe(0.875);
  });

  it("uses the PR-open transition timestamp for overview outcome inclusion and time-to-PR", async () => {
    installBackendSignalMock({
      events: [
        {
          oneshot_run_id: 210,
          stage: "testing",
          event_type: "state_transition",
          to_state: "pr_open",
          occurred_at: isoHoursAgo(2),
        },
        {
          oneshot_run_id: 211,
          stage: "testing",
          event_type: "state_transition",
          to_state: "pr_open",
          occurred_at: isoHoursAgo(25),
        },
      ],
    });
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-pr-open-in-window",
        jiraKey: "CPDEV-210",
        oneshotRunId: 210,
        displayState: "pr_open",
        createdAt: isoHoursAgo(10),
        updatedAt: isoHoursAgo(1),
      }),
      makeRow({
        dashboardId: "run-pr-open-outside-window",
        jiraKey: "CPDEV-211",
        oneshotRunId: 211,
        displayState: "pr_open",
        createdAt: isoHoursAgo(30),
        updatedAt: isoHoursAgo(1),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.completed).toBe(1);
    expect(analytics.overview24h.failed).toBe(0);
    expect(analytics.overview24h.avgTimeToPrMs).toBe(8 * 60 * 60 * 1000);
    expect(analytics.overview24h.medianTimeToPrMs).toBe(8 * 60 * 60 * 1000);
  });

  it("uses the latest manual restart as the time-to-PR start", async () => {
    installBackendSignalMock({
      events: [
        {
          oneshot_run_id: 212,
          stage: "testing",
          event_type: "state_transition",
          to_state: "pr_open",
          occurred_at: isoHoursAgo(1),
        },
      ],
    });
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-restarted-pr-open",
        jiraKey: "CPDEV-212",
        oneshotRunId: 212,
        displayState: "pr_open",
        createdAt: isoHoursAgo(80),
        lastManualRestartAt: isoHoursAgo(3),
        updatedAt: isoHoursAgo(1),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.completed).toBe(1);
    expect(analytics.overview24h.avgTimeToPrMs).toBe(2 * 60 * 60 * 1000);
    expect(analytics.overview24h.medianTimeToPrMs).toBe(2 * 60 * 60 * 1000);
  });

  it("uses the failure transition timestamp for overview failure outcome inclusion", async () => {
    installBackendSignalMock({
      events: [
        {
          oneshot_run_id: 220,
          stage: "implementation",
          event_type: "state_transition",
          to_state: "failed",
          occurred_at: isoHoursAgo(2),
        },
        {
          oneshot_run_id: 221,
          stage: "planning",
          event_type: "state_transition",
          to_state: "failed",
          occurred_at: isoHoursAgo(25),
        },
      ],
    });
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-failed-in-window",
        jiraKey: "CPDEV-220",
        oneshotRunId: 220,
        displayState: "failed",
        progressStage: "implementation",
        createdAt: isoHoursAgo(30),
        updatedAt: isoHoursAgo(1),
      }),
      makeRow({
        dashboardId: "run-failed-outside-window",
        jiraKey: "CPDEV-221",
        oneshotRunId: 221,
        displayState: "failed",
        progressStage: "planning",
        createdAt: isoHoursAgo(30),
        updatedAt: isoHoursAgo(1),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.completed).toBe(0);
    expect(analytics.overview24h.failed).toBe(1);
    expect(analytics.overview24h.passRate).toBe(0);
  });

  it("returns an empty time-to-PR signal (completed=0, avg/median=0) when there are no 24h PR-outcome rows", async () => {
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-running",
        jiraKey: "CPDEV-120",
        displayState: "implementing",
        progressStage: "implementation",
        createdAt: isoHoursAgo(1),
        updatedAt: isoHoursAgo(1),
      }),
      makeRow({
        dashboardId: "run-queued",
        jiraKey: "CPDEV-121",
        displayState: "queued_for_planning",
        progressStage: "planning",
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(2),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.completed).toBe(0);
    expect(analytics.overview24h.avgTimeToPrMs).toBe(0);
    expect(analytics.overview24h.medianTimeToPrMs).toBe(0);
  });

  it("computes qualification agent health from qualification artifact metrics after rows move forward", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 230,
          artifact_stage: "qualification",
          recorded_at: isoHoursAgo(2),
          stage_duration_ms: 120_000,
          stage_cost_usd: 0.02,
          stage_tokens_used: 1_000,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
        {
          oneshot_run_id: 0,
          artifact_stage: "qualification",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 60_000,
          stage_cost_usd: 0.01,
          stage_tokens_used: 500,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
      ],
    });
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-moved-past-qualification",
        jiraKey: "CPDEV-230",
        oneshotRunId: 230,
        displayState: "pr_open",
        progressStage: "pr_complete",
        createdAt: isoHoursAgo(3),
        updatedAt: isoHoursAgo(1),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);
    const qualification = analytics.agents.find(
      (entry) => entry.stage === "qualification",
    );

    expect(qualification).toMatchObject({
      runs: 2,
      avgLatencyMs: 90_000,
      avgTokens: 750,
      failRate: 0,
    });
  });

  it("does not treat excluded qualifier-gating rows as measured qualification health", async () => {
    installBackendSignalMock({});
    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "qualifier-task-excluded",
        jiraKey: "CPDEV-240",
        oneshotRunId: null,
        displayState: "qualification_failed",
        progressStage: "qualification",
        repoName: null,
        repoUrl: null,
        baseBranch: null,
        baseCommitSha: null,
        implementationBranch: null,
        implementationCommitSha: null,
        currentPrUrl: null,
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
        failureAttribution: excludedQualifierFailure(),
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);
    const qualification = analytics.agents.find(
      (entry) => entry.stage === "qualification",
    );

    expect(qualification).toMatchObject({
      runs: 0,
      failRate: 0,
      avgLatencyMs: 0,
      avgTokens: 0,
      recentSamples: [],
    });
  });

  it("derives 24h spend/tokens from artifact stage metrics, falling back to row cost for unattributed runs", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 200,
          artifact_stage: "implementation",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 60_000,
          stage_cost_usd: "0.5",
          stage_tokens_used: "5000",
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
      ],
    });

    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "run-with-artifact",
        jiraKey: "CPDEV-130",
        oneshotRunId: 200,
        displayState: "completed",
        progressStage: "pr_complete",
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
        // Row-level tokens should be ignored in favor of the artifact stage
        // metric for this attributed run; row-level USD remains the Costs tab
        // top-line source of truth.
        totalTokensUsed: 999_999,
        estimatedCostUsd: 99,
        costSource: "actual",
      }),
      makeRow({
        dashboardId: "run-without-artifact",
        jiraKey: "CPDEV-131",
        oneshotRunId: 201,
        displayState: "completed",
        progressStage: "pr_complete",
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
        totalTokensUsed: 300,
        estimatedCostUsd: 0.03,
        costSource: "estimated",
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.totalTokens).toBe(5_000 + 300);
    expect(analytics.overview24h.estimatedCostUsd).toBe(
      analytics.costs.totalUsd,
    );
    expect(analytics.overview24h.estimatedCostUsd).toBe(99.03);
    expect(analytics.overview24h.costSource).toBe("mixed");
  });

  it("counts qualifier-only task spend exactly once in overview24h (no double-count against the row-cost fallback), matching the Costs view total", async () => {
    installBackendSignalMock({
      artifacts: [
        {
          oneshot_run_id: 0,
          artifact_stage: "qualification",
          recorded_at: isoHoursAgo(1),
          stage_duration_ms: 18_000,
          stage_cost_usd: 0.025,
          stage_tokens_used: 1_500,
          model: "us.anthropic.claude-sonnet-4-6",
          provider: "anthropic",
        },
      ],
    });

    const rows: OneShotDashboardRow[] = [
      makeRow({
        dashboardId: "qualifier-task-2164",
        jiraKey: "CPDEV-2164",
        oneshotRunId: null,
        displayState: "qualification_no_action",
        progressStage: "qualification",
        repoName: null,
        repoUrl: null,
        baseBranch: null,
        baseCommitSha: null,
        implementationBranch: null,
        implementationCommitSha: null,
        currentPrUrl: null,
        createdAt: isoHoursAgo(2),
        updatedAt: isoHoursAgo(1),
        // Row-level cost/tokens mirror the artifact totals, as they would for
        // a real qualifier-only task; the artifact/union path (run_id=0)
        // already attributes this spend, so the row-cost fallback must NOT
        // add it again.
        totalTokensUsed: 1_500,
        estimatedCostUsd: 0.025,
        costSource: "actual",
      }),
    ];

    const analytics = await buildOneShotDashboardAnalytics(rows);

    expect(analytics.overview24h.totalTokens).toBe(1_500);
    expect(analytics.overview24h.estimatedCostUsd).toBe(0.025);
    expect(analytics.overview24h.estimatedCostUsd).toBe(
      analytics.costs.totalUsd,
    );
  });
});
