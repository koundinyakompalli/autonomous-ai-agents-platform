// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Statistics } from "./Statistics.js";
import type {
  OneShotDashboardRow,
  OneShotStatisticsResponse,
} from "./types.js";

function row(): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Auth login ticket",
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: null,
    displayState: "completed",
    progressStage: "pr_complete",
    progressPercent: 100,
    repoName: "core-app",
    repoUrl: null,
    baseBranch: "main",
    baseCommitSha: "abc123",
    implementationBranch: null,
    implementationCommitSha: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    currentPrUrl: null,
    qualificationSummary: null,
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
    createdAt: "2026-05-14T10:00:00.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-05-14T11:00:00.000Z",
    totalTokensUsed: 1000,
    estimatedCostUsd: 0.01,
    costSource: "actual",
  };
}

function statistics(): OneShotStatisticsResponse {
  const example = {
    jiraKey: "CPDEV-1",
    dashboardId: "run-1",
    title: "Auth login ticket",
    jiraUrl: "https://jira.example.com/browse/CPDEV-1",
  };
  return {
    status: "ready",
    range: "24h",
    window: {
      range: "24h",
      label: "Last 24h",
      shortLabel: "24h",
      bucketLabel: "48 x 30-min buckets",
      isAllTime: false,
    },
    summary: "Auth tickets are moving cleanly.",
    scorecard: {
      intake: 6,
      qualifiedRuns: 6,
      completed: 5,
      failed: 1,
      noAction: 0,
      passRate: 5 / 6,
      totalTokens: 12000,
      totalUsd: 1.25,
      p50TimeToPrMs: 3_600_000,
      p90TimeToPrMs: 7_200_000,
      deltas: {
        intake: { currentValue: 6, priorValue: 5, delta: 1, pctChange: 20 },
        passRate: {
          currentValue: 5 / 6,
          priorValue: 0.7,
          delta: 13.3,
          pctChange: 19,
        },
        completed: null,
        failed: null,
        totalUsd: null,
        totalTokens: null,
        p50TimeToPrMs: null,
      },
    },
    buckets: [],
    workingWell: [
      {
        id: "working:ticket-family-authentication",
        bucketId: "ticket_family:authentication",
        title: "Authentication tickets are performing well",
        summary: "They complete with strong pass rate.",
        reason: "The bucket is above baseline.",
        sampleSize: 6,
        passRate: 5 / 6,
        confidence: 0.8,
        examples: [example],
      },
    ],
    needsImprovement: [],
    businessMetrics: [
      {
        id: "pass-rate",
        title: "Pass rate",
        summary: "Pass rate improved.",
        delta: {
          currentValue: 5 / 6,
          priorValue: 0.7,
          delta: 13.3,
          pctChange: 19,
        },
      },
    ],
    ticketQuality: {
      rubric: {
        rubricVersion: "v1.0",
        detectionPatternsVersion: "v1.0",
        weights: {
          acceptance_criteria: 35,
          substantive_description: 20,
          expected_behavior_scope: 15,
          repo_file_service_hints: 15,
          testing_notes: 10,
          out_of_scope_constraints: 5,
        },
        tierCutoffs: { strong: 80, adequate: 60, weak: 30 },
        thresholds: {
          bucketClaimMinN: 10,
          missingSignalCohortMinN: 10,
          weakRecommendationMinShare: 0.2,
          dataHygieneMissingDescriptionMinShare: 0.15,
          dataHygieneMinN: 10,
          stratifiedCoverageMinShare: 0.6,
        },
      },
      disclaimer:
        "Score reflects ticket text captured at OneShot intake, not current Jira text.",
      totalIntake: 6,
      averageScore: 84.5,
      readinessDistribution: [
        {
          id: "strong",
          label: "Strong",
          sampleSize: 4,
          share: 4 / 6,
          cohort: {
            sampleSize: 4,
            terminalCount: 4,
            completed: 4,
            failed: 0,
            noAction: 0,
            passRate: 1,
            wilson95: { low: 0.51, high: 1 },
          },
          averageScore: 92,
          examples: [example],
        },
        {
          id: "adequate",
          label: "Adequate",
          sampleSize: 1,
          share: 1 / 6,
          cohort: {
            sampleSize: 1,
            terminalCount: 1,
            completed: 1,
            failed: 0,
            noAction: 0,
            passRate: 1,
            wilson95: { low: 0.2, high: 1 },
          },
          averageScore: 65,
          examples: [],
        },
        {
          id: "weak",
          label: "Weak",
          sampleSize: 1,
          share: 1 / 6,
          cohort: {
            sampleSize: 1,
            terminalCount: 1,
            completed: 0,
            failed: 1,
            noAction: 0,
            passRate: 0,
            wilson95: { low: 0, high: 0.8 },
          },
          averageScore: 35,
          examples: [],
        },
        {
          id: "missing_description",
          label: "Missing description",
          sampleSize: 0,
          share: 0,
          cohort: {
            sampleSize: 0,
            terminalCount: 0,
            completed: 0,
            failed: 0,
            noAction: 0,
            passRate: 0,
            wilson95: null,
          },
          averageScore: 0,
          examples: [],
        },
      ],
      passRateByTier: [],
      templateFit: [
        {
          id: "cpdev_template",
          label: "CPDEV template",
          sampleSize: 4,
          share: 4 / 6,
          cohort: {
            sampleSize: 4,
            terminalCount: 4,
            completed: 4,
            failed: 0,
            noAction: 0,
            passRate: 1,
            wilson95: { low: 0.51, high: 1 },
          },
          averageScore: 92,
          examples: [example],
        },
        {
          id: "retrofit_template",
          label: "Retrofit template",
          sampleSize: 0,
          share: 0,
          cohort: {
            sampleSize: 0,
            terminalCount: 0,
            completed: 0,
            failed: 0,
            noAction: 0,
            passRate: 0,
            wilson95: null,
          },
          averageScore: 0,
          examples: [],
        },
        {
          id: "non_template_clear",
          label: "Clear non-template",
          sampleSize: 1,
          share: 1 / 6,
          cohort: {
            sampleSize: 1,
            terminalCount: 1,
            completed: 1,
            failed: 0,
            noAction: 0,
            passRate: 1,
            wilson95: { low: 0.2, high: 1 },
          },
          averageScore: 65,
          examples: [],
        },
        {
          id: "non_template_weak",
          label: "Weak non-template",
          sampleSize: 1,
          share: 1 / 6,
          cohort: {
            sampleSize: 1,
            terminalCount: 1,
            completed: 0,
            failed: 1,
            noAction: 0,
            passRate: 0,
            wilson95: { low: 0, high: 0.8 },
          },
          averageScore: 35,
          examples: [],
        },
        {
          id: "missing_description",
          label: "Missing description",
          sampleSize: 0,
          share: 0,
          cohort: {
            sampleSize: 0,
            terminalCount: 0,
            completed: 0,
            failed: 0,
            noAction: 0,
            passRate: 0,
            wilson95: null,
          },
          averageScore: 0,
          examples: [],
        },
      ],
      missingSignalImpact: [
        {
          signal: "acceptance_criteria",
          label: "Acceptance criteria",
          missing: {
            sampleSize: 10,
            terminalCount: 10,
            completed: 3,
            failed: 7,
            noAction: 0,
            passRate: 0.3,
            wilson95: { low: 0.1, high: 0.61 },
          },
          present: {
            sampleSize: 10,
            terminalCount: 10,
            completed: 9,
            failed: 1,
            noAction: 0,
            passRate: 0.9,
            wilson95: { low: 0.6, high: 0.98 },
          },
          deltaPassRate: 60,
          significant: false,
          examples: {
            missingFailedOrNoAction: [example],
            presentPassed: [example],
          },
        },
      ],
      dataHygieneCallout: null,
      stratifiedReadinessGap: {
        weak: {
          sampleSize: 1,
          terminalCount: 1,
          completed: 0,
          failed: 1,
          noAction: 0,
          passRate: 0,
          wilson95: { low: 0, high: 0.8 },
        },
        nonWeak: {
          sampleSize: 5,
          terminalCount: 5,
          completed: 5,
          failed: 0,
          noAction: 0,
          passRate: 1,
          wilson95: { low: 0.57, high: 1 },
        },
        significantOverall: false,
        eligibleWeakCoverageShare: 0,
        significantWeakCoverageShare: 0,
        qualifiesForRecommendation: false,
        dominantStrata: [],
        recommendationSummary: null,
      },
    },
    repoStatus: {
      range: "24h",
      generatedAt: "2026-05-14T12:00:00.000Z",
      statusVersion: 1,
      rows: [
        {
          repoKey: "repo:core-app",
          repoLabel: "core-app",
          status: "watch",
          statusReason:
            "5/6 completed; 1 issue concentrated in Testing.",
          isUnresolved: false,
          sampleSize: 6,
          terminalCount: 6,
          completed: 5,
          failed: 1,
          noAction: 0,
          passRate: 5 / 6,
          wilson95: { low: 0.44, high: 0.97 },
          avgTokens: 2000,
          avgUsd: 0.21,
          topStageIssue: {
            stage: "testing",
            label: "Testing",
            failed: 1,
            noAction: 0,
            affected: 1,
            shareOfRepoIssues: 1,
          },
          topFailureAttribution: {
            attribution: "oneshot",
            errorCategory: "test_runner_skipped",
            label: "Testing Error",
            sampleSize: 1,
          },
          examples: [example],
        },
      ],
    },
    operationalBottlenecks: {
      range: "24h",
      generatedAt: "2026-05-14T12:00:00.000Z",
      bottleneckVersion: 1,
      rows: [
        {
          id: "stage_cluster:testing",
          kind: "stage_cluster",
          severity: "medium",
          title: "Testing stage cluster",
          summary:
            "1 failed or no-action item is concentrated in Testing.",
          nextStep:
            "Review testing evidence for the linked examples and compare with the repo status row.",
          affected: 1,
          failed: 1,
          noAction: 0,
          passRate: 0,
          wilson95: { low: 0, high: 0.8 },
          repoKey: null,
          repoLabel: null,
          stage: "testing",
          stageLabel: "Testing",
          failureAttribution: null,
          costUsd: 0.21,
          tokens: 2000,
          examples: [example],
        },
      ],
    },
    recommendedActions: [
      {
        id: "watch-auth",
        priority: "low",
        title: "Keep auth ticket pattern",
        summary: "Keep sending these through OneShot.",
        bucketId: "ticket_family:authentication",
        examples: [example],
      },
    ],
    selfFixCandidates: [],
    selfFixConfig: {
      minSampleSize: 5,
      autoCreateEnabled: false,
      autoRunEnabled: false,
      targetEpicKey: "CPDEV-23232",
      targetRepo: "mhk-repos/cp-autonomous-ai-agents-platform",
      targetBranch: "main",
    },
    minSampleSize: 5,
    modelInfo: {
      provider: "bedrock_runtime",
      model: "claude-sonnet",
      generatedAt: "2026-05-14T12:00:00.000Z",
      expiresAt: "2026-05-14T12:30:00.000Z",
      nextRefreshAt: "2026-05-14T12:30:00.000Z",
      dataFingerprint: "abc",
      refreshing: false,
      lastError: null,
    },
  };
}

describe("Statistics", () => {
  it("renders example Jira keys as Jira links", () => {
    render(
      <Statistics
        statistics={statistics()}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    const links = screen.getAllByRole("link", { name: "CPDEV-1" });
    expect(links[0].getAttribute("href")).toBe(
      "https://jira.example.com/browse/CPDEV-1",
    );
    expect(
      screen.getByText("Authentication tickets are performing well"),
    ).toBeTruthy();
    expect(screen.getByText("ticket readiness")).toBeTruthy();
    expect(
      screen.getByText(
        "Readiness rubric v1.0 · score reflects ticket text captured at OneShot intake",
      ),
    ).toBeTruthy();
  });

  it("renders repo status rows with stage notes and linked examples", () => {
    const payload = statistics();
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("repo status")).toBeTruthy();
    expect(screen.getByText("core-app")).toBeTruthy();
    expect(screen.getByText("watch")).toBeTruthy();
    expect(screen.getByText(/5\/6 completed/)).toBeTruthy();
    expect(screen.getByText(/Testing · 1/)).toBeTruthy();
    expect(screen.getByText(/top issue: Testing Error/)).toBeTruthy();
  });

  it("renders operational bottlenecks with ranked labels and examples", () => {
    const payload = statistics();
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("operational bottlenecks")).toBeTruthy();
    expect(screen.getByText("What to look at first")).toBeTruthy();
    expect(screen.getByText("Testing stage cluster")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText(/Review testing evidence/)).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "CPDEV-1" }).length).toBeGreaterThan(
      0,
    );
  });

  it("renders unresolved repo bottlenecks with friendly routing copy", () => {
    const payload = statistics();
    payload.operationalBottlenecks.rows = [
      {
        ...payload.operationalBottlenecks.rows[0],
        id: "repo_resolution:unresolved",
        kind: "repo_resolution",
        severity: "high",
        title: "Unresolved repository routing",
        summary:
          "3 intake items could not be tied to a repository in this range.",
        nextStep:
          "Review repo routing evidence for these tickets before guessing a target repository.",
        affected: 3,
        failed: 3,
        noAction: 0,
        repoKey: "repo:unresolved",
        repoLabel: "Unresolved repository",
        stage: "qualification",
        stageLabel: "Qualification",
        examples: [
          {
            jiraKey: "CPDEV-22346",
            dashboardId: "qualifier-task-22346",
            title: "Repo resolution failed",
            jiraUrl: null,
          },
        ],
      },
    ];
    render(
      <Statistics
        statistics={payload}
        rows={[
          {
            ...row(),
            dashboardId: "qualifier-task-22346",
            jiraKey: "CPDEV-22346",
          },
        ]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("Unresolved repository routing")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText(/repo routing evidence/i)).toBeTruthy();
    expect(screen.queryByText(/Expected ',' or/)).toBeNull();
    expect(screen.getByRole("link", { name: "CPDEV-22346" })).toBeTruthy();
  });

  it("renders unresolved repo status without guessing a target repo", () => {
    const payload = statistics();
    payload.repoStatus.rows = [
      {
        ...payload.repoStatus.rows[0],
        repoKey: "repo:unresolved",
        repoLabel: "Unresolved repository",
        status: "blocked",
        statusReason:
          "3 intake items could not be tied to a repository; review the examples and qualifier reasons.",
        isUnresolved: true,
        sampleSize: 3,
        terminalCount: 3,
        completed: 0,
        failed: 3,
        noAction: 0,
        passRate: 0,
        examples: [
          {
            jiraKey: "CPDEV-22346",
            dashboardId: "qualifier-task-22346",
            title: "Repo resolution failed",
            jiraUrl: null,
          },
        ],
      },
    ];
    render(
      <Statistics
        statistics={payload}
        rows={[
          {
            ...row(),
            dashboardId: "qualifier-task-22346",
            jiraKey: "CPDEV-22346",
          },
        ]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("Unresolved repository")).toBeTruthy();
    expect(screen.getByText("blocked")).toBeTruthy();
    expect(screen.getByText(/could not be tied to a repository/i)).toBeTruthy();
    expect(screen.queryByText(/batch-monorepo/i)).toBeNull();
    expect(screen.getByRole("link", { name: "CPDEV-22346" })).toBeTruthy();
  });

  it("marks higher failure deltas as unfavorable", () => {
    const payload = statistics();
    payload.businessMetrics = [
      {
        id: "failed",
        title: "Failures",
        summary: "Failures moved up.",
        delta: { currentValue: 4, priorValue: 1, delta: 3, pctChange: 300 },
      },
    ];

    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("+3 · +300.0%").className).toContain("down");
  });

  it("renders 'Statistics' eyebrow with 'no AI snapshot yet' badge when no LLM has run", () => {
    const payload = statistics();
    payload.modelInfo = {
      ...payload.modelInfo,
      provider: null,
      model: null,
      generatedAt: null,
    };
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    // Hero eyebrow shows "Statistics", not "AI statistics"
    const eyebrows = screen.getAllByText(/^Statistics$/);
    expect(eyebrows.length).toBeGreaterThan(0);
    expect(screen.getByText("no AI snapshot yet")).toBeTruthy();
    expect(screen.queryByText("AI statistics")).toBeNull();
  });

  it("renders 'AI statistics' eyebrow with 'ai snapshot' badge when LLM has run", () => {
    render(
      <Statistics
        statistics={statistics()}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByText("AI statistics")).toBeTruthy();
    expect(screen.getByText("ai snapshot")).toBeTruthy();
  });

  it("does not render Wilson or confidence wording in insight cards", () => {
    const payload = statistics();
    payload.workingWell[0] = {
      ...payload.workingWell[0],
      reason:
        "Wilson 95% lower bound (82.3%) sits above the 67.0% baseline; gap survives stratification by repo + stage.",
    };
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(
      screen.getByText(
        "Pass-rate gap remains above the selected-window baseline after sample-size and repo/stage checks.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Wilson/i)).toBeNull();
    expect(screen.queryByText(/95% lower bound/i)).toBeNull();
    expect(screen.queryByText(/95% upper bound/i)).toBeNull();
    expect(screen.queryByText(/confidence/i)).toBeNull();
  });

  it("renders friendly copy for AI refresh parse failures", () => {
    const payload = statistics();
    payload.modelInfo = {
      ...payload.modelInfo,
      refreshing: true,
      lastError:
        "LLM statistics JSON could not be parsed: Expected ',' or ']' after array element in JSON at position 6743",
    };

    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("ai retrying")).toBeTruthy();
    expect(
      screen.getByText(
        /AI summary refresh failed; showing deterministic statistics/i,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Expected ',' or ']'/)).toBeNull();
  });

  it("renders '—' instead of a 'NEW' pill when both prior and current values are zero", () => {
    const payload = statistics();
    payload.businessMetrics = [
      {
        id: "completed",
        title: "Completions",
        summary: "Nothing happened.",
        delta: { currentValue: 0, priorValue: 0, delta: 0, pctChange: null },
      },
    ];
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    // The misleading "· new" pill suffix should be gone — but unrelated copy
    // (e.g. the "+ new run" button) is fine.
    expect(screen.queryByText(/^·\s*new$/i)).toBeNull();
  });

  it("renders '· first' suffix instead of '· new' when there's a real current but no prior", () => {
    const payload = statistics();
    payload.businessMetrics = [
      {
        id: "intake",
        title: "Intake volume",
        summary: "First observation.",
        delta: { currentValue: 42, priorValue: 0, delta: 42, pctChange: null },
      },
    ];
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByText("+42 · first")).toBeTruthy();
  });

  it("hides non-significant missing-signal rows under a 'within statistical noise' details", () => {
    const payload = statistics();
    // The default statistics() fixture already has significant: false on its single row.
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    // Empty-state copy when no significant rows exist
    expect(
      screen.getByText(/No signal shows a statistically significant/i),
    ).toBeTruthy();
    // The collapsed details summary should be visible
    expect(screen.getByText(/Within statistical noise/i)).toBeTruthy();
    // The +pp pill should NOT be rendered for the noisy row
    expect(screen.queryByText("+60.0pp")).toBeNull();
  });

  it("renders FailureAttributionSection segments when failureAttribution is present", () => {
    const payload = statistics();
    payload.failureAttribution = {
      totalFailures: 5,
      excludedFromDenominator: 2,
      countsByAttribution: {
        oneshot: 3,
        ticket: 1,
        mixed: 1,
        unknown: 0,
      },
      byCategory: [
        {
          errorCategory: "llm_provider",
          attribution: "oneshot",
          sampleSize: 3,
          passRateInCohort: 0,
          wilson95: { low: 0, high: 0.6 },
          examples: [
            {
              jiraKey: "CPDEV-1",
              dashboardId: "run-1",
              title: "x",
              jiraUrl: null,
            },
          ],
          significant: true,
        },
      ],
      attributionVersion: 1,
    };
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.getByText("failure attribution")).toBeTruthy();
    expect(screen.getByText(/5 failures classified/)).toBeTruthy();
    expect(screen.getByText(/2 gating outcomes excluded/)).toBeTruthy();
    expect(screen.getByText("LLM provider")).toBeTruthy();
  });

  it("labels unknown error categories as Uncategorized without showing the triage note for known owners", () => {
    const payload = statistics();
    payload.failureAttribution = {
      totalFailures: 1,
      excludedFromDenominator: 0,
      countsByAttribution: {
        oneshot: 1,
        ticket: 0,
        mixed: 0,
        unknown: 0,
      },
      byCategory: [
        {
          errorCategory: "unknown",
          attribution: "oneshot",
          sampleSize: 1,
          passRateInCohort: 0,
          wilson95: { low: 0, high: 0.8 },
          examples: [
            {
              jiraKey: "CPDEV-1",
              dashboardId: "run-1",
              title: "x",
              jiraUrl: null,
            },
          ],
          significant: false,
        },
      ],
      attributionVersion: 3,
    };

    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("Uncategorized")).toBeTruthy();
    expect(screen.queryByText("Unrecognized")).toBeNull();
    expect(screen.queryByText(/Unknown attributions need human triage/)).toBeNull();
  });

  it("shows ticket-quality ticket rows and reserves the triage note for unknown attribution", () => {
    const payload = statistics();
    payload.failureAttribution = {
      totalFailures: 2,
      excludedFromDenominator: 0,
      countsByAttribution: {
        oneshot: 0,
        ticket: 1,
        mixed: 0,
        unknown: 1,
      },
      byCategory: [
        {
          errorCategory: "ticket_quality",
          attribution: "ticket",
          sampleSize: 1,
          passRateInCohort: 0,
          wilson95: { low: 0, high: 0.8 },
          examples: [
            {
              jiraKey: "CPDEV-21156",
              dashboardId: "qualifier-task-2026",
              title: "x",
              jiraUrl: null,
            },
          ],
          significant: false,
        },
        {
          errorCategory: "unknown",
          attribution: "unknown",
          sampleSize: 1,
          passRateInCohort: 0,
          wilson95: { low: 0, high: 0.8 },
          examples: [
            {
              jiraKey: "CPDEV-99999",
              dashboardId: "qualifier-task-99999",
              title: "x",
              jiraUrl: null,
            },
          ],
          significant: false,
        },
      ],
      attributionVersion: 3,
    };

    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("Ticket quality")).toBeTruthy();
    expect(screen.getByText("Ticket")).toBeTruthy();
    expect(screen.getByText(/Unknown attributions need human triage/)).toBeTruthy();
  });

  it("does not render FailureAttributionSection when failureAttribution is absent (back-compat)", () => {
    const payload = statistics();
    delete (payload as { failureAttribution?: unknown }).failureAttribution;
    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(screen.queryByText("failure attribution")).toBeNull();
  });

  it("renders eligible self-fix candidates with defect actions", () => {
    const payload = statistics();
    payload.selfFixCandidates = [
      {
        id: "oneshot-self-fix-agent_logic-oneshot",
        category: "agent_logic",
        attribution: "oneshot",
        sampleSize: 5,
        significant: true,
        wilson95: { low: 0, high: 0.43 },
        passRateBaseline: 0.57,
        range: "24h",
        examples: [
          {
            jiraKey: "CPDEV-1",
            dashboardId: "run-1",
            title: "Auth login ticket",
            jiraUrl: null,
          },
        ],
        status: "eligible",
      },
    ];

    render(
      <Statistics
        statistics={payload}
        rows={[row()]}
        range="24h"
        isLoading={false}
        error={null}
        onRangeChange={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.getByText("self-fix candidates")).toBeTruthy();
    expect(screen.getByText("Agent logic")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create defect" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create + run" })).toBeTruthy();
  });
});
