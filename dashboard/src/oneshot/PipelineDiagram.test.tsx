// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PipelineDiagram } from "./PipelineDiagram.js";
import type { OneShotDashboardRow, OneShotStageDetail } from "./types.js";

const NOW = new Date("2026-04-23T12:00:00.000Z");

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Live-ticker fixture",
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: null,
    displayState: "implementing",
    progressStage: "implementation",
    progressPercent: 40,
    repoName: "core-app",
    repoUrl: null,
    baseBranch: "main",
    baseCommitSha: "abc",
    implementationBranch: null,
    implementationCommitSha: null,
    workspace: null,
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
      light: "red",
      status: "not_eligible",
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: new Date(NOW.getTime() - 120_000).toISOString(),
    lastManualRestartAt: null,
    updatedAt: NOW.toISOString(),
    totalTokensUsed: 0,
    estimatedCostUsd: 0,
    costSource: "estimated",
    ...overrides,
  };
}

function buildStage(
  overrides: Partial<OneShotStageDetail> = {},
): OneShotStageDetail {
  return {
    stage: "implementation",
    state: "running",
    attempts: 1,
    latestVersion: null,
    artifactStatus: "started",
    startedAt: null,
    completedAt: null,
    durationMs: null,
    tokensUsed: null,
    costUsd: null,
    totalTokensUsed: null,
    totalCostUsd: null,
    totalCostSource: null,
    provider: null,
    model: null,
    metadataSummary: [],
    eventCount: 0,
    lastEventAt: null,
    ...overrides,
  };
}

describe("PipelineDiagram RunningMeta ticker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("renders a ticking M:SS counter for a running stage with startedAt", () => {
    const stage = buildStage({
      startedAt: new Date(NOW.getTime() - 42_000).toISOString(),
    });
    render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );

    expect(screen.getByText("0:42")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    expect(screen.getByText("0:43")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(17_000);
    });

    expect(screen.getByText("1:00")).toBeTruthy();
  });

  it("clamps future startedAt to 0:00 (clock skew)", () => {
    const stage = buildStage({
      startedAt: new Date(NOW.getTime() + 5 * 60_000).toISOString(),
    });
    render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );

    expect(screen.getByText("0:00")).toBeTruthy();
  });

  it("falls back to stageMeta when startedAt is null", () => {
    const stage = buildStage({ startedAt: null });
    render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );

    expect(screen.queryByText(/^\d+:\d{2}$/)).toBeNull();
  });

  it("renders model in the top-right and tokens · cost · duration in the bottom row", () => {
    const stage = buildStage({
      state: "completed",
      latestVersion: 2,
      model: "us.anthropic.claude-opus-4-6-v1",
      totalCostUsd: 1.532461,
      totalTokensUsed: 12_602,
      durationMs: 120_000,
      startedAt: null,
    });
    render(
      <PipelineDiagram
        row={buildRow({
          displayState: "pr_open",
          progressStage: "pr_complete",
        })}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );

    expect(screen.getByText("Opus 4.6")).toBeTruthy();
    expect(screen.getByText(/12\.6k/)).toBeTruthy();
    expect(screen.getByText(/\$1\.53/)).toBeTruthy();
    expect(screen.getByText(/2m/)).toBeTruthy();
  });

  it("falls back to stageMeta when startedAt is unparseable", () => {
    const stage = buildStage({ startedAt: "not-a-date" });
    render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );

    expect(screen.queryByText(/^\d+:\d{2}$/)).toBeNull();
  });

  it("applies the running class and renders the orb layer for the active stage", () => {
    const stage = buildStage({
      startedAt: new Date(NOW.getTime() - 10_000).toISOString(),
    });
    const { container } = render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );
    const card = container.querySelector(
      '.stream-card[data-stage="implementation"]',
    );
    expect(card).toBeTruthy();
    expect(card?.classList.contains("running")).toBe(true);
    expect(card?.querySelector(".c2-orb")).toBeTruthy();
    expect(card?.querySelectorAll(".c2-orb-blob").length).toBe(3);
    expect(card?.querySelector(".border-runner")).toBeTruthy();
    expect(card?.querySelectorAll(".border-runner .bead").length).toBe(3);
  });

  it("renders the failed class and X icon for an oneshot-attributed failure", () => {
    const stage = buildStage({ state: "failed", startedAt: null });
    const { container } = render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );
    const card = container.querySelector(
      '.stream-card[data-stage="implementation"]',
    );
    expect(card?.classList.contains("failed")).toBe(true);
    expect(card?.querySelector(".stream-icon.bad")).toBeTruthy();
  });

  it("adds rail-live to the connector that follows a running stage", () => {
    const stage = buildStage({
      startedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    });
    const { container } = render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );
    // The implementation stage is followed by review — that channel
    // should render the rail-live overlay because prev=running.
    const channels = container.querySelectorAll(".stream-channel");
    expect(channels.length).toBeGreaterThan(0);
    const liveRail = container.querySelector(".stream-channel .rail-live");
    expect(liveRail).toBeTruthy();
    const liveChannel = liveRail?.closest(".stream-channel");
    const motionStarts = Array.from(
      liveChannel?.querySelectorAll("animateMotion") ?? [],
    ).map((node) => node.getAttribute("begin"));
    expect(motionStarts.length).toBeGreaterThan(0);
    expect(motionStarts.every((value) => value?.startsWith("-"))).toBe(true);
  });

  it("inherits theme via the .liquid-glass-scope[data-theme] ancestor, not its own attribute", () => {
    const { container } = render(
      <div className="liquid-glass-scope" data-theme="light">
        <PipelineDiagram
          row={buildRow()}
          selectedStage="implementation"
          onSelectStage={() => undefined}
          stages={[]}
        />
      </div>,
    );
    const wrapper = container.querySelector(".liquid-glass-scope");
    const nav = container.querySelector(".pipeline");
    expect(wrapper?.getAttribute("data-theme")).toBe("light");
    expect(nav?.hasAttribute("data-theme")).toBe(false);
  });

  it("clears the interval on unmount without warnings", () => {
    const stage = buildStage({
      startedAt: new Date(NOW.getTime() - 5_000).toISOString(),
    });
    const { unmount } = render(
      <PipelineDiagram
        row={buildRow()}
        selectedStage="implementation"
        onSelectStage={() => undefined}
        stages={[stage]}
      />,
    );

    expect(screen.getByText("0:05")).toBeTruthy();
    unmount();

    // Advancing timers after unmount must not throw or log (no stray setState
    // on an unmounted component).
    expect(() => {
      act(() => {
        vi.advanceTimersByTime(5_000);
      });
    }).not.toThrow();
  });
});
