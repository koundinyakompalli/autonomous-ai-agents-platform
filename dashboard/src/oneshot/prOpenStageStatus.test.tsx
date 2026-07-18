// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PipelineDiagram } from "./PipelineDiagram.js";
import { StagePanel } from "./StagePanel.js";
import type { OneShotDashboardRow } from "./types.js";

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-74",
    jiraKey: "CPDEV-21090",
    title: 'CLONE - Member Search: Style "Cancel" button',
    sourceTaskManagementId: 1862,
    oneshotRunId: 74,
    customerName: "MHK (internal)",
    displayState: "pr_open",
    progressStage: "pr_complete",
    progressPercent: 95,
    repoName: "core-app",
    repoUrl: "https://github.com/mhk-repos/cp-medhok-monorepo.git",
    baseBranch: "master",
    baseCommitSha: "5d9d51f42d0f8e4c1c67dfc32de49107a77585ea",
    implementationBranch: "oneshot/cpdev-21090-run-74",
    implementationCommitSha: "f7dd0ec1f9ff5020bfb02823c61d243ab746078f",
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    currentPrUrl: "https://github.com/mhk-repos/cp-medhok-monorepo/pull/1454",
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
    createdAt: "2026-04-21T18:32:28.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-04-21T18:45:36.000Z",
    totalTokensUsed: 398860,
    estimatedCostUsd: 0.494586,
    costSource: "mixed",
    ...overrides,
  };
}

describe("PR-open pipeline status", () => {
  it("renders the PR stage as done in the pipeline", () => {
    render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="pr_complete"
        onSelectStage={() => undefined}
      />,
    );

    expect(screen.getByLabelText("Ship stage (Done)")).toBeTruthy();
  });

  it("renders the PR stage panel as completed while keeping the PR Open note", () => {
    render(<StagePanel row={buildRow()} stage="pr_complete" />);

    expect(screen.getAllByText("Completed").length).toBeGreaterThan(0);
    expect(screen.getByText("Dashboard state: PR Open")).toBeTruthy();
  });

  it("renders DB-backed timeline events and artifact metadata", () => {
    render(
      <StagePanel
        row={buildRow()}
        stage="testing"
        timeline={{
          dashboardId: "run-74",
          oneshotRunId: 74,
          updatedAt: "2026-04-21T18:45:36.000Z",
          isFallback: false,
          stages: [
            {
              stage: "testing",
              state: "completed",
              attempts: 1,
              latestVersion: 1,
              artifactStatus: "completed",
              startedAt: "2026-04-21T18:40:00.000Z",
              completedAt: "2026-04-21T18:45:00.000Z",
              durationMs: 300000,
              tokensUsed: null,
              costUsd: null,
              totalTokensUsed: null,
              totalCostUsd: null,
              totalCostSource: null,
              provider: "none",
              model: "none",
              metadataSummary: ["tests passed", "pass count: 12"],
              eventCount: 1,
              lastEventAt: "2026-04-21T18:45:00.000Z",
            },
          ],
          events: [
            {
              id: "1",
              occurredAt: "2026-04-21T18:45:00.000Z",
              eventType: "state_transition",
              stage: "testing",
              fromState: "testing",
              toState: "pr_open",
              tone: "success",
              label: "testing → pr_open",
              metadata: { prNumber: 1454 },
            },
          ],
        }}
      />,
    );

    expect(screen.getByText("tests passed")).toBeTruthy();
    expect(screen.getByText("pass count: 12")).toBeTruthy();
    expect(screen.getByText("testing → pr_open")).toBeTruthy();
    expect(
      screen.getByText("artifact v1 · completed · 1 attempt"),
    ).toBeTruthy();
  });

  it("shows cumulative stage cost while keeping latest artifact metrics visible", () => {
    render(
      <StagePanel
        row={buildRow()}
        stage="implementation"
        timeline={{
          dashboardId: "run-86",
          oneshotRunId: 86,
          updatedAt: "2026-04-30T15:00:00.000Z",
          isFallback: false,
          stages: [
            {
              stage: "implementation",
              state: "completed",
              attempts: 3,
              latestVersion: 3,
              artifactStatus: "completed",
              startedAt: "2026-04-30T14:00:00.000Z",
              completedAt: "2026-04-30T14:10:00.000Z",
              durationMs: 600000,
              tokensUsed: 500,
              costUsd: 0.01,
              totalTokensUsed: 1200,
              totalCostUsd: 0.042,
              totalCostSource: "actual",
              provider: "anthropic",
              model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
              metadataSummary: ["tokens: 500", "cost: 0.01"],
              eventCount: 1,
              lastEventAt: "2026-04-30T14:10:00.000Z",
            },
          ],
          events: [],
        }}
      />,
    );

    expect(screen.getByText("total tokens")).toBeTruthy();
    expect(screen.getByText("latest tokens")).toBeTruthy();
    expect(screen.getByText("latest cost")).toBeTruthy();
    expect(screen.getByText("Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("500")).toBeTruthy();
    expect(screen.getByText("$0.01")).toBeTruthy();
    expect(screen.getByText("1.2k")).toBeTruthy();
    expect(screen.getByText("$0.04")).toBeTruthy();
    expect(
      screen.getByText("artifact v3 · completed · 3 attempts"),
    ).toBeTruthy();
  });

  it("keeps fallback timeline rows in snapshot mode", () => {
    render(
      <StagePanel
        row={buildRow()}
        stage="pr_complete"
        timeline={{
          dashboardId: "run-74",
          oneshotRunId: 74,
          updatedAt: "2026-04-21T18:45:36.000Z",
          isFallback: true,
          stages: [],
          events: [],
        }}
      />,
    );

    expect(screen.getByText("Dashboard snapshot")).toBeTruthy();
    expect(screen.getByText("Dashboard state: PR Open")).toBeTruthy();
    expect(screen.queryByText("No stage timeline events recorded.")).toBeNull();
  });

  it("labels executing, queued, failed, and completed stages distinctly", () => {
    const { rerender } = render(
      <PipelineDiagram
        row={buildRow({
          displayState: "implementing",
          progressStage: "implementation",
        })}
        selectedStage="implementation"
        onSelectStage={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Build stage (Running)")).toBeTruthy();

    rerender(
      <PipelineDiagram
        row={buildRow({
          displayState: "queued_for_review",
          progressStage: "review",
        })}
        selectedStage="review"
        onSelectStage={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Validate stage (Queued)")).toBeTruthy();

    rerender(
      <PipelineDiagram
        row={buildRow({
          displayState: "replan_required",
          progressStage: "code_review",
        })}
        selectedStage="code_review"
        onSelectStage={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Review stage (Waiting)")).toBeTruthy();

    rerender(
      <PipelineDiagram
        row={buildRow({
          displayState: "failed",
          progressStage: "testing",
        })}
        selectedStage="testing"
        onSelectStage={() => undefined}
      />,
    );
    expect(screen.getByLabelText("Test stage (Failed)")).toBeTruthy();
    expect(screen.getByLabelText("Build stage (Done)")).toBeTruthy();
  });
});
