// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Overview } from "./Overview.js";
import type {
  OneShotAgentAnalyticsEntry,
  OneShotDashboardRow,
  OneShotOverviewAnalytics,
} from "./types.js";

function isoHoursAgo(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 60 * 60 * 1000).toISOString();
}

function makeRow(overrides: Partial<OneShotDashboardRow>): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Test row",
    jiraIssueType: null,
    ticketType: "story",
    ticketTypeSource: "jira",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: "Acme",
    displayState: "implementing",
    progressStage: "implementation",
    progressPercent: 50,
    repoName: "core-app",
    repoUrl: "https://example.com/repo",
    baseBranch: "main",
    baseCommitSha: "abc123",
    implementationBranch: "oneshot/cpdev-1-run-1",
    implementationCommitSha: "def456",
    workspace: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    currentPrUrl: null,
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

function makeAnalytics(
  overrides: Partial<OneShotOverviewAnalytics>,
): OneShotOverviewAnalytics {
  return {
    runs24h: 0,
    completed: 0,
    failed: 0,
    running: 0,
    queued: 0,
    waiting: 0,
    passRate: 0,
    avgTimeToPrMs: 0,
    medianTimeToPrMs: 0,
    totalTokens: 0,
    estimatedCostUsd: 0,
    costSource: "estimated",
    throughputBuckets: Array.from({ length: 24 }, () => 0),
    attemptFailures24h: 0,
    ...overrides,
  };
}

const agentAnalytics: OneShotAgentAnalyticsEntry[] = [];

describe("Overview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-24T12:00:00.000Z"));
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("relabels the five stat cards", () => {
    render(
      <Overview
        rows={[]}
        analytics={makeAnalytics({})}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getByText("Open work")).toBeTruthy();
    expect(screen.getByText("starts 24h")).toBeTruthy();
    expect(screen.getByText("Outcomes (24h)")).toBeTruthy();
    expect(screen.getByText("PR pass rate")).toBeTruthy();
    expect(screen.getByText("Time to PR")).toBeTruthy();
    expect(screen.getByText("Spend (24h)")).toBeTruthy();
    expect(screen.getByText("Stage health")).toBeTruthy();
    expect(screen.getByText("starts/hour · past 24h")).toBeTruthy();
  });

  it("uses median time-to-PR as the primary overview value", () => {
    render(
      <Overview
        rows={[]}
        analytics={makeAnalytics({
          completed: 7,
          failed: 1,
          passRate: 7 / 8,
          avgTimeToPrMs: 46_297_857,
          medianTimeToPrMs: 4_388_000,
        })}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getByText("1h 13m")).toBeTruthy();
    expect(screen.getByText("7/8 reached PR")).toBeTruthy();
    expect(screen.getByText("median across 7 PRs opened")).toBeTruthy();
    expect(screen.queryByText("12h 51m")).toBeNull();
  });

  it("includes a waiting-state row in the Open Work table", () => {
    const waitingRow = makeRow({
      dashboardId: "waiting-run",
      jiraKey: "CPDEV-9",
      displayState: "approved",
    });

    render(
      <Overview
        rows={[waitingRow]}
        analytics={makeAnalytics({ waiting: 1 })}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getByText("Open Work")).toBeTruthy();
    expect(screen.getByText("CPDEV-9")).toBeTruthy();
  });

  it("shows waiting age from last update instead of stale run duration", () => {
    const waitingRow = makeRow({
      dashboardId: "stale-waiting-run",
      jiraKey: "CPDEV-10",
      displayState: "approved",
      createdAt: isoHoursAgo(14 * 24),
      updatedAt: isoHoursAgo(3),
    });

    render(
      <Overview
        rows={[waitingRow]}
        analytics={makeAnalytics({ waiting: 1 })}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getByText("3h")).toBeTruthy();
    expect(screen.queryByText("13d 21h")).toBeNull();
  });

  it("shows an explicit no-PR empty state instead of <1m or 0/0 when completed is 0", () => {
    render(
      <Overview
        rows={[]}
        analytics={makeAnalytics({ completed: 0, failed: 0 })}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getByText("no PRs yet")).toBeTruthy();
    expect(screen.getByText("no outcomes yet")).toBeTruthy();
    expect(screen.queryByText("<1m")).toBeNull();
    expect(screen.queryByText("0/0 completed")).toBeNull();
  });

  it("shows an explicit no-spend empty state instead of $0 when spend and tokens are both zero", () => {
    render(
      <Overview
        rows={[]}
        analytics={makeAnalytics({ estimatedCostUsd: 0, totalTokens: 0 })}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getByText("no spend yet")).toBeTruthy();
    expect(screen.queryByText("$0.00")).toBeNull();
  });

  it("does not show failed stage-attempt diagnostics on the Runs card", () => {
    render(
      <Overview
        rows={[]}
        analytics={makeAnalytics({
          runs24h: 3,
          completed: 2,
          failed: 0,
          attemptFailures24h: 3,
        })}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getByText("2 PR opened")).toBeTruthy();
    expect(screen.getByText("0 failed")).toBeTruthy();
    expect(screen.queryByText("2 completed")).toBeNull();
    expect(screen.queryByText("0 fail")).toBeNull();
    expect(screen.queryByText(/attempts failed/i)).toBeNull();
  });

  it("does not show passive freshness timestamps on Overview", () => {
    render(
      <Overview
        rows={[]}
        analytics={makeAnalytics({})}
        agentAnalytics={agentAnalytics}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.queryByText(/checked/i)).toBeNull();
    expect(screen.queryByText(/updated/i)).toBeNull();
  });

  it("renders empty agent-health metrics as no-data instead of measured zeroes", () => {
    render(
      <Overview
        rows={[]}
        analytics={makeAnalytics({})}
        agentAnalytics={[
          {
            stage: "qualification",
            runs: 0,
            avgLatencyMs: 0,
            failRate: 0,
            avgTokens: 0,
            recentSamples: [],
          },
        ]}
        onOpenDetail={() => {}}
      />,
    );

    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("0.0%")).toBeNull();
    expect(screen.queryByText("<1m")).toBeNull();
  });
});
