// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RunsView } from "./RunsView.js";
import type { OneShotArtifactRun, OneShotDashboardRow } from "./types.js";

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-74",
    jiraKey: "CPDEV-21090",
    title: 'CLONE - Member Search: Style "Cancel" button',
    jiraIssueType: "Story",
    ticketType: "story",
    ticketTypeSource: "jira_issue_type",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
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

function buildArtifactRun(
  overrides: Partial<OneShotArtifactRun> = {},
): OneShotArtifactRun {
  return {
    id: "artifact-1",
    sourceKey: "TEST-1001",
    sourceParentKey: null,
    mode: "documentation",
    status: "review_ready",
    title: "Artifact run fixture",
    generatedCount: 3,
    generatedTickets: [
      {
        key: "TEST-1002",
        title: "Generated artifact fixture",
        kind: "documentation",
        status: "created",
        jiraUrl: "https://example.atlassian.net/browse/TEST-1002",
        oneshotRunDashboardId: "run-90",
        oneshotRunState: "pr_open",
        currentPrUrl: "https://github.com/example/repo/pull/1",
      },
    ],
    oneshotRunCount: 1,
    humanReviewRequired: true,
    humanReviewCount: 2,
    reviewItems: ["Fixture review item A.", "Fixture review item B."],
    evidence: { totalRows: 10 },
    artifactRefs: null,
    jiraSummary: "Artifact summary fixture.",
    completedAt: null,
    createdAt: "2026-04-21T18:32:28.000Z",
    updatedAt: "2026-04-21T18:45:36.000Z",
    ...overrides,
  };
}

function buildArtifactRuns(
  n: number,
  overrides: Partial<OneShotArtifactRun> = {},
): OneShotArtifactRun[] {
  return Array.from({ length: n }, (_, i) =>
    buildArtifactRun({
      id: `artifact-page-${i}`,
      sourceKey: `ART-${9000 + i}`,
      title: `Artifact title ${i}`,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n - 1 - i)).toISOString(),
      ...overrides,
    }),
  );
}

describe("RunsView PR-open semantics", () => {
  it("renders a visible PR Open chip for pr_open rows", () => {
    render(
      <RunsView
        rows={[buildRow({ title: "PR row" })]}
        onOpenDetail={() => undefined}
      />,
    );

    const chip = screen.getByText("PR Open");
    expect(screen.getByText("PR row")).toBeTruthy();
    expect(chip.className).toContain("run-status-chip");
  });

  it("shows elapsed duration from the latest manual restart when present", () => {
    render(
      <RunsView
        rows={[
          buildRow({
            title: "Restarted row",
            createdAt: "2026-04-20T18:00:00.000Z",
            lastManualRestartAt: "2026-04-21T18:00:00.000Z",
            updatedAt: "2026-04-21T18:45:36.000Z",
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    expect(screen.getByText("45m")).toBeTruthy();
    expect(screen.queryByText("1d")).toBeNull();
    expect(screen.getByText("45m").getAttribute("title")).toBe(
      "elapsed since restart",
    );
  });

  it("hides the needs-review readiness chip while preserving the PR Open chip", () => {
    const { container } = render(
      <RunsView
        rows={[
          buildRow({
            title: "PR row",
            readiness: "needs_review",
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    expect(screen.getByText("PR Open")).toBeTruthy();
    expect(screen.queryByText("Needs Review")).toBeNull();
    expect(container.querySelector(".readiness-needs_review")).toBeNull();
  });

  it("keeps PR Open text in the title cell instead of the status or ticket cells", () => {
    render(
      <RunsView
        rows={[buildRow({ title: "PR row" })]}
        onOpenDetail={() => undefined}
      />,
    );

    const row = screen.getByRole("button", {
      name: /Open details for CPDEV-21090: PR row — PR Open/,
    });
    const chip = screen.getByText("PR Open");
    const titleCell = row.querySelector(".col-title");
    const statusCell = row.querySelector(".col-status");
    const ticketCell = row.querySelector(".col-ticket");

    expect(titleCell?.contains(chip)).toBe(true);
    expect(statusCell?.textContent).toBe("");
    expect(statusCell?.querySelector(".row-status")?.className).toContain(
      "status-completed",
    );
    expect(ticketCell?.contains(chip)).toBe(false);
  });

  it("excludes pr_open rows from the Active filter", () => {
    render(
      <RunsView
        rows={[
          buildRow({ title: "PR row" }),
          buildRow({
            dashboardId: "run-75",
            jiraKey: "CPDEV-20908",
            title: "Implementing row",
            displayState: "implementing",
            progressStage: "implementation",
          }),
          buildRow({
            dashboardId: "run-76",
            jiraKey: "CPDEV-20909",
            title: "Failed row",
            displayState: "failed",
            progressStage: "testing",
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "active" }));

    expect(screen.queryByText("PR row")).toBeNull();
    expect(screen.getByText("Implementing row")).toBeTruthy();
    expect(screen.queryByText("Failed row")).toBeNull();
  });

  it("includes pr_open rows in the Completed filter while leaving other waiting states out", () => {
    render(
      <RunsView
        rows={[
          buildRow({ title: "PR row" }),
          buildRow({
            dashboardId: "run-76",
            jiraKey: "CPDEV-20909",
            title: "Needs revision row",
            displayState: "needs_revision",
            progressStage: "review",
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "completed" }));

    expect(screen.getByText("PR row")).toBeTruthy();
    expect(screen.queryByText("Needs revision row")).toBeNull();
  });

  it("filters pipeline rows by normalized ticket type", () => {
    const { container } = render(
      <RunsView
        rows={[
          buildRow({
            title: "Story row",
            ticketType: "story",
          }),
          buildRow({
            dashboardId: "run-80",
            jiraKey: "CPDEV-30080",
            title: "Sonar row",
            ticketType: "sonar",
            jiraIssueType: "Story",
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    fireEvent.change(screen.getByLabelText("Filter by ticket type"), {
      target: { value: "sonar" },
    });

    expect(screen.queryByText("Story row")).toBeNull();
    expect(screen.getByText("Sonar row")).toBeTruthy();
    expect(container.querySelector(".run-ticket-type-chip")?.textContent).toBe(
      "Sonar",
    );
  });

  it("treats pr_open as completed even in the waiting bucket view", () => {
    render(
      <RunsView
        rows={[
          buildRow({ title: "PR row" }),
          buildRow({
            dashboardId: "run-77",
            jiraKey: "CPDEV-20910",
            title: "Waiting row",
            displayState: "needs_revision",
            progressStage: "review",
          }),
        ]}
        bucketFilter="waiting"
        onOpenDetail={() => undefined}
      />,
    );

    expect(screen.queryByText("PR row")).toBeNull();
    expect(screen.getByText("Waiting row")).toBeTruthy();
  });

  it("shows no-action rows in the all list and hides stale router rows", () => {
    render(
      <RunsView
        rows={[
          buildRow({
            dashboardId: "qualifier-task-1",
            jiraKey: "CPDEV-1",
            title: "No action row",
            oneshotRunId: null,
            displayState: "qualification_no_action",
            progressStage: "qualification",
          }),
          buildRow({
            dashboardId: "qualifier-task-2",
            jiraKey: "CPDEV-2",
            title: "Stale router row",
            oneshotRunId: null,
            displayState: "qualification_failed",
            progressStage: "qualification",
            staleRouter: true,
          }),
          buildRow({
            dashboardId: "run-75",
            jiraKey: "CPDEV-20908",
            title: "Implementing row",
            displayState: "implementing",
            progressStage: "implementation",
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    expect(screen.getByText("Implementing row")).toBeTruthy();
    expect(screen.getByText("No action row")).toBeTruthy();
    expect(screen.queryByText("Stale router row")).toBeNull();
  });

  it("renders ticket-attributed qualifier failures as Ticket Not Ready", () => {
    render(
      <RunsView
        rows={[
          buildRow({
            dashboardId: "qualifier-task-2487",
            jiraKey: "CPDEV-22346",
            title: "Missing AC row",
            oneshotRunId: null,
            displayState: "qualification_failed",
            progressStage: "qualification",
            failureAttribution: {
              attribution: "ticket",
              errorCategory: "ticket_quality",
              qualifierReasonCode: "llm_rejected",
              label: "Ticket Not Ready",
              rationale: "Ticket-quality issue.",
              excludedFromDenominator: false,
            },
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    const chip = screen.getByText("Ticket Not Ready");
    const row = screen.getByRole("button", {
      name: /Open details for CPDEV-22346: Missing AC row — Ticket Not Ready/,
    });

    expect(chip.className).toContain("run-attribution-chip");
    expect(chip.className).toContain("attribution-ticket");
    expect(row.querySelector(".row-status")?.className).toContain(
      "status-waiting",
    );
    expect(screen.queryByText("Qualification Failed")).toBeNull();
  });

  it("renders OneShot stage failures with no title attribution chip", () => {
    const { container } = render(
      <RunsView
        rows={[
          buildRow({
            dashboardId: "run-106",
            jiraKey: "CPDEV-15158",
            title: "Implementation aged out",
            displayState: "failed",
            progressStage: "implementation",
            failureAttribution: {
              attribution: "oneshot",
              errorCategory: "budget",
              qualifierReasonCode: null,
              label: "Implementation Error",
              rationale: "OneShot-side issue.",
              excludedFromDenominator: false,
            },
          }),
        ]}
        onOpenDetail={() => undefined}
      />,
    );

    expect(screen.getByLabelText("Implementation Error")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: /Open details for CPDEV-15158: Implementation aged out — Implementation Error/,
      }),
    ).toBeTruthy();
    expect(container.querySelector(".run-attribution-chip")).toBeNull();
  });

  it("renders artifact runs separately from pipeline runs", () => {
    const artifactRun = buildArtifactRun();
    const pipelineTitle = "Pipeline row";

    render(
      <RunsView
        rows={[buildRow({ title: pipelineTitle })]}
        artifactRuns={[artifactRun]}
        onOpenDetail={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Artifact Runs" }));

    expect(screen.getByText(artifactRun.sourceKey)).toBeTruthy();
    expect(screen.getByText("Documentation")).toBeTruthy();
    expect(screen.getByText(artifactRun.title)).toBeTruthy();
    expect(
      screen.getByText(`${artifactRun.humanReviewCount} items`),
    ).toBeTruthy();
    expect(screen.queryByText(pipelineTitle)).toBeNull();
  });

  it("opens artifact run detail with generated tickets and review items", () => {
    const artifactRun = buildArtifactRun();

    render(
      <RunsView
        rows={[]}
        artifactRuns={[artifactRun]}
        onOpenDetail={() => undefined}
      />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Artifact Runs" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: new RegExp(`Open artifact run for ${artifactRun.sourceKey}`),
      }),
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(
      screen.getByText(artifactRun.generatedTickets[0]?.key ?? ""),
    ).toBeTruthy();
    expect(screen.getByText(artifactRun.reviewItems[0] ?? "")).toBeTruthy();
    expect(screen.getByText(artifactRun.jiraSummary ?? "")).toBeTruthy();
  });
});

describe("RunsView multi-repo group rendering", () => {
  function buildGroupRow(overrides: Partial<OneShotDashboardRow> = {}): OneShotDashboardRow {
    return buildRow({
      runGroupId: 42,
      title: "Update EFax, CTM logs, and OneShot metadata",
      groupMetadata: {
        mode: "multi_repo",
        repos: [
          { repo_id: 1, repo_name: "repo-a", branch_name: "master", base_commit_sha: "abc123" },
          { repo_id: 2, repo_name: "repo-b", branch_name: "master", base_commit_sha: "def456" },
        ],
        mergeOrder: { "repo-a": 1, "repo-b": 2 },
      },
      ...overrides,
    });
  }

  it("renders an aggregate collapsed group header for runs sharing a runGroupId", () => {
    const row1 = buildGroupRow({
      dashboardId: "run-100",
      jiraKey: "CPDEV-50001",
      oneshotRunId: 100,
      repoName: "repo-a",
      jiraIssueType: "Sonar",
      ticketType: "sonar",
      displayState: "pr_open",
      createdAt: "2026-04-21T18:00:00.000Z",
      updatedAt: "2026-04-21T18:12:00.000Z",
      totalTokensUsed: 1000,
      estimatedCostUsd: 1.5,
    });
    const row2 = buildGroupRow({
      dashboardId: "run-101",
      jiraKey: "CPDEV-50001",
      oneshotRunId: 101,
      repoName: "repo-b",
      displayState: "implementing",
      createdAt: "2026-04-21T18:05:00.000Z",
      updatedAt: "2026-04-21T18:35:00.000Z",
      totalTokensUsed: 2500,
      estimatedCostUsd: 2.25,
    });

    const { container } = render(
      <RunsView
        rows={[row1, row2]}
        onOpenDetail={() => undefined}
      />,
    );

    expect(screen.getByText("CPDEV-50001")).toBeTruthy();
    expect(
      screen.getByText("Update EFax, CTM logs, and OneShot metadata"),
    ).toBeTruthy();
    const groupHeader = container.querySelector(".run-group-header");
    expect(groupHeader?.querySelector(".run-ticket-type-chip")?.textContent).toBe("Sonar");
    expect(groupHeader?.querySelector(".run-status-chip")?.textContent).toBe("PR Open");
    expect(screen.getByRole("button", { name: /1\/2 pipelines done/ })).toBeTruthy();
    // Row is padded to a fixed 7 slots: 2 real repo rings + 5 ghost placeholders.
    expect(
      container.querySelectorAll(".run-group-header .stage-rings svg"),
    ).toHaveLength(7);
    expect(
      container.querySelectorAll(
        ".run-group-header .stage-rings .stage-ring-ghost",
      ),
    ).toHaveLength(5);
    expect(screen.queryByText("Multiple Pipelines")).toBeNull();
    expect(screen.queryByText("multi-repo")).toBeNull();
    expect(screen.queryByText("2 repos")).toBeNull();
    expect(screen.getByText("35m")).toBeTruthy();
    expect(screen.getByText("3.5k")).toBeTruthy();
    expect(screen.getByText("$3.75")).toBeTruthy();
    expect(container.querySelector(".run-group-toggle")).toBeNull();
    expect(
      container.querySelector(".run-group-header .run-group-toggle-tri"),
    ).toBeTruthy();
    // Child rows should NOT be visible until expanded; only the group header
    // ticket cell should be present while collapsed.
    expect(screen.getAllByText("CPDEV-50001")).toHaveLength(1);
    expect(screen.queryByText("repo-a")).toBeNull();
    expect(screen.queryByText("repo-b")).toBeNull();
  });

  it("expands a group to show repo lanes and opens child run details", () => {
    const row1 = buildGroupRow({
      dashboardId: "run-102",
      jiraKey: "CPDEV-50002",
      oneshotRunId: 102,
      repoName: "repo-a",
      displayState: "pr_open",
      title: "Shared ticket title",
    });
    const row2 = buildGroupRow({
      dashboardId: "run-103",
      jiraKey: "CPDEV-50002",
      oneshotRunId: 103,
      repoName: "repo-b",
      displayState: "implementing",
      title: "Shared ticket title",
    });
    const onOpenDetail = vi.fn();

    const { container } = render(
      <RunsView
        rows={[row1, row2]}
        onOpenDetail={onOpenDetail}
      />,
    );

    const header = screen.getByRole("button", {
      name: /Multi-repo group 42/,
    });
    fireEvent.click(header);

    expect(screen.getByText("repo-a")).toBeTruthy();
    expect(screen.getByText("repo-b")).toBeTruthy();
    expect(screen.getByText("repo 1")).toBeTruthy();
    expect(screen.getByText("repo 2")).toBeTruthy();
    expect(screen.getAllByText("master").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Shared ticket title")).toHaveLength(1);
    expect(container.querySelectorAll(".run-group-child .mini-pipeline")).toHaveLength(2);
    expect(container.querySelectorAll(".run-group-child .row-status .dot")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /Open details for repo-a/ }));
    expect(onOpenDetail).toHaveBeenCalledWith(row1);
  });

  it("renders multi-branch retrofit groups as target branch lanes", () => {
    const groupMetadata = {
      mode: "multi_branch_retrofit",
      repos: [
        {
          repo_id: 1,
          repo_name: "core-app",
          branch_name: "medhok-monorepo-3.17",
          base_commit_sha: "abc123",
        },
        {
          repo_id: 1,
          repo_name: "core-app",
          branch_name: "medhok-monorepo-3.18",
          base_commit_sha: "def456",
        },
      ],
      sourceJiraKey: "CPDEV-1234",
      sourceBranch: "master",
      repo: { repo_id: 1, repo_name: "core-app" },
      targetBranches: [
        { targetBranch: "medhok-monorepo-3.17", targetOrder: 1 },
        { targetBranch: "medhok-monorepo-3.18", targetOrder: 2 },
      ],
      skippedTargetBranches: [],
    } as unknown as OneShotDashboardRow["groupMetadata"];
    const row1 = buildGroupRow({
      dashboardId: "run-201",
      runGroupId: 77,
      groupMetadata,
      jiraKey: "CPDEV-65000",
      oneshotRunId: 201,
      repoName: "core-app",
      baseBranch: "medhok-monorepo-3.17",
      displayState: "pr_open",
      title: "Retrofit CPDEV-1234",
    });
    const row2 = buildGroupRow({
      dashboardId: "run-202",
      runGroupId: 77,
      groupMetadata,
      jiraKey: "CPDEV-65000",
      oneshotRunId: 202,
      repoName: "core-app",
      baseBranch: "medhok-monorepo-3.18",
      displayState: "implementing",
      title: "Retrofit CPDEV-1234",
    });
    const onOpenDetail = vi.fn();

    const { container } = render(
      <RunsView
        rows={[row2, row1]}
        onOpenDetail={onOpenDetail}
      />,
    );

    const header = screen.getByRole("button", {
      name: /Multi-branch retrofit group 77/,
    });
    // Aggregate count stays in the accessible label only.
    expect(header.getAttribute("aria-label")).toContain("1/2 retrofits done");
    // Parent pipeline cell now shows stage rings, not the visible text label.
    expect(screen.queryByText("1/2 retrofits done")).toBeNull();
    expect(container.querySelector(".run-group-pipeline-label")).toBeNull();
    // 2 real child rings + 5 ghost placeholders = 7 fixed slots (mirrors multi-repo).
    expect(container.querySelectorAll(".run-group-header .stage-rings svg")).toHaveLength(7);
    expect(container.querySelectorAll(".run-group-header .stage-rings .stage-ring-ghost")).toHaveLength(5);
    expect(screen.queryByText("target 1")).toBeNull();
    expect(screen.queryByText("medhok-monorepo-3.17")).toBeNull();

    fireEvent.click(header);

    expect(screen.getByText("target 1")).toBeTruthy();
    expect(screen.getByText("target 2")).toBeTruthy();
    expect(screen.getByText("medhok-monorepo-3.17")).toBeTruthy();
    expect(screen.getByText("medhok-monorepo-3.18")).toBeTruthy();
    expect(screen.queryByText("repo 1")).toBeNull();
    expect(screen.queryByText("repo 2")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: /Open details for medhok-monorepo-3\.17/,
      }),
    );
    expect(onOpenDetail).toHaveBeenCalledWith(row1);
  });

  it("renders ungrouped runs without modification when no runGroupId present", () => {
    const ungrouped = buildRow({
      dashboardId: "run-200",
      jiraKey: "CPDEV-60001",
      title: "Normal single-repo run",
      runGroupId: null,
    });

    render(
      <RunsView
        rows={[ungrouped]}
        onOpenDetail={() => undefined}
      />,
    );

    expect(screen.getByText("Normal single-repo run")).toBeTruthy();
    // No group header rendered
    expect(screen.queryByText("pipelines done")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Helper: build N deterministic rows sorted newest→oldest by createdAt
// (RunsView sorts desc by createdAt, so index 0 = most recent = first rendered)
// ---------------------------------------------------------------------------
function buildRows(n: number): ReturnType<typeof buildRow>[] {
  return Array.from({ length: n }, (_, i) =>
    buildRow({
      dashboardId: `run-page-${i}`,
      jiraKey: `CPDEV-${9000 + i}`,
      title: `Row title ${i}`,
      // Descending: index 0 gets the latest timestamp so it sorts first.
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, n - 1 - i)).toISOString(),
    }),
  );
}

describe("RunsView pagination", () => {
  // t-page-default
  it("renders only the first 25 rows by default when more than 25 exist", () => {
    const rows = buildRows(30);
    const { container } = render(
      <RunsView rows={rows} onOpenDetail={vi.fn()} />,
    );

    // 25 visible table-row buttons on first render
    const tableRows = container.querySelectorAll(".table-row");
    expect(tableRows).toHaveLength(25);

    // Pager count text reflects total
    expect(screen.getByText(/Showing 1–25 of 30/)).toBeTruthy();

    // Previous is disabled on page 1
    expect(
      screen.getByRole("button", { name: /previous/i }).hasAttribute("disabled"),
    ).toBe(true);
  });

  // t-next-prev
  it("navigates to the next page and disables Next on the last page", () => {
    const rows = buildRows(30);
    const { container } = render(
      <RunsView rows={rows} onOpenDetail={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /next/i }));

    // Page 2 shows the remaining 5 rows
    const tableRows = container.querySelectorAll(".table-row");
    expect(tableRows).toHaveLength(5);

    // Count text reflects page 2 position
    expect(screen.getByText(/Showing 26–30 of 30/)).toBeTruthy();

    // Previous now enabled, Next disabled
    expect(
      screen.getByRole("button", { name: /previous/i }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      screen.getByRole("button", { name: /next/i }).hasAttribute("disabled"),
    ).toBe(true);

    // Going back to page 1 via Previous
    fireEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(container.querySelectorAll(".table-row")).toHaveLength(25);
    expect(screen.getByText(/Showing 1–25 of 30/)).toBeTruthy();
  });

  // t-page-size
  it("resets to page 1 and shows correct count when page size is changed", () => {
    const rows = buildRows(60);
    const { container } = render(
      <RunsView rows={rows} onOpenDetail={vi.fn()} />,
    );

    // Advance to page 2 first
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(container.querySelectorAll(".table-row")).toHaveLength(25);

    // Change page size to 50
    const select = screen.getByLabelText("Rows per page");
    fireEvent.change(select, { target: { value: "50" } });

    // Should reset to page 1 showing 50 rows
    expect(container.querySelectorAll(".table-row")).toHaveLength(50);
    expect(screen.getByText(/Showing 1–50 of 60/)).toBeTruthy();
  });

  it("keeps the page-size selector visible when the selected size exceeds the result count", () => {
    const rows = buildRows(30);
    const { container } = render(
      <RunsView rows={rows} onOpenDetail={vi.fn()} />,
    );

    expect(
      screen.getByRole("navigation", { name: /pipeline runs pagination/i }),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Rows per page"), {
      target: { value: "50" },
    });

    expect(container.querySelectorAll(".table-row")).toHaveLength(30);
    expect(screen.getByText(/Showing 1–30 of 30/)).toBeTruthy();
    expect(screen.getByLabelText("Rows per page")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Rows per page"), {
      target: { value: "25" },
    });

    expect(container.querySelectorAll(".table-row")).toHaveLength(25);
    expect(screen.getByText(/Showing 1–25 of 30/)).toBeTruthy();
  });

  // t-reset-matrix
  it("resets both pagers when search query changes", () => {
    const rows = buildRows(30);
    const { container } = render(
      <RunsView rows={rows} onOpenDetail={vi.fn()} />,
    );

    // Advance pipeline page to 2
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(container.querySelectorAll(".table-row")).toHaveLength(5);

    // Change search query — should reset pipeline back to page 1
    const searchInput = container.querySelector(".search-input") as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "Row title 0" } });

    // Only 1 row matches, pager hidden (total ≤ pageSize), but count must start at 1
    // The search found row "Row title 0" so it rendered.
    expect(screen.getByText("Row title 0")).toBeTruthy();
  });

  it("resets only pipelinePage when a pipeline filter tab changes", () => {
    // Use rows with mixed displayState so the filter actually changes results
    const rows = [
      ...buildRows(30),
      buildRow({
        dashboardId: "active-run",
        jiraKey: "CPDEV-8000",
        title: "Active run",
        displayState: "implementing",
        progressStage: "implementation",
        createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      }),
    ];
    const { container } = render(
      <RunsView rows={rows} onOpenDetail={vi.fn()} />,
    );

    // Advance pipeline to page 2
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(container.querySelectorAll(".table-row").length).toBeGreaterThan(0);

    // Click the Active filter tab — resets pipeline pager to page 1
    fireEvent.click(screen.getByRole("tab", { name: "active" }));

    // "Active run" has displayState implementing which is active
    expect(screen.getByText("Active run")).toBeTruthy();
  });

  it("resets pipeline pagination when stage and ticket type filters change", () => {
    const rows = [
      ...buildRows(30),
      buildRow({
        dashboardId: "implementation-stage-run",
        jiraKey: "CPDEV-8200",
        title: "Implementation stage run",
        progressStage: "implementation",
        createdAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      }),
      buildRow({
        dashboardId: "sonar-ticket-run",
        jiraKey: "CPDEV-8201",
        title: "Sonar ticket run",
        ticketType: "sonar",
        jiraIssueType: "Sonar",
        createdAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
      }),
    ];

    render(<RunsView rows={rows} onOpenDetail={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.change(screen.getByLabelText("Filter by stage"), {
      target: { value: "implementation" },
    });
    expect(screen.getByText("Implementation stage run")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter by stage"), {
      target: { value: "any" },
    });
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.change(screen.getByLabelText("Filter by ticket type"), {
      target: { value: "sonar" },
    });
    expect(screen.getByText("Sonar ticket run")).toBeTruthy();
  });

  it("resets pipeline pagination when the bucket filter changes", () => {
    const rows = [
      ...buildRows(60),
      buildRow({
        dashboardId: "running-bucket-run",
        jiraKey: "CPDEV-8202",
        title: "Running bucket run",
        displayState: "implementing",
        progressStage: "implementation",
        createdAt: new Date(Date.UTC(2026, 0, 3)).toISOString(),
      }),
    ];
    const onOpenDetail = vi.fn();
    const { rerender } = render(
      <RunsView rows={rows} onOpenDetail={onOpenDetail} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/Showing 26–50 of 61/)).toBeTruthy();

    rerender(
      <RunsView
        rows={rows}
        bucketFilter="running"
        onOpenDetail={onOpenDetail}
      />,
    );
    expect(screen.getByText("Running bucket run")).toBeTruthy();

    rerender(<RunsView rows={rows} onOpenDetail={onOpenDetail} />);
    expect(screen.getByText(/Showing 1–25 of 61/)).toBeTruthy();
  });

  it("paginates artifact runs with the same previous and next behavior", () => {
    const artifacts = buildArtifactRuns(30);
    const { container } = render(
      <RunsView rows={[]} artifactRuns={artifacts} onOpenDetail={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Artifact Runs" }));

    expect(
      screen.getByRole("navigation", { name: /artifact runs pagination/i }),
    ).toBeTruthy();
    expect(container.querySelectorAll(".table-row")).toHaveLength(25);
    expect(screen.getByText(/Showing 1–25 of 30/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(container.querySelectorAll(".table-row")).toHaveLength(5);
    expect(screen.getByText(/Showing 26–30 of 30/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /previous/i }));
    expect(container.querySelectorAll(".table-row")).toHaveLength(25);
    expect(screen.getByText(/Showing 1–25 of 30/)).toBeTruthy();
  });

  it("resets artifact pagination when page size and artifact mode change", () => {
    const artifacts = [
      ...buildArtifactRuns(30, { mode: "documentation" }),
      buildArtifactRun({
        id: "wiz-artifact",
        sourceKey: "ART-WIZ",
        title: "Wiz artifact run",
        mode: "wiz",
        updatedAt: new Date(Date.UTC(2026, 0, 2)).toISOString(),
      }),
    ];
    const { container } = render(
      <RunsView rows={[]} artifactRuns={artifacts} onOpenDetail={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("tab", { name: "Artifact Runs" }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.change(screen.getByLabelText("Rows per page"), {
      target: { value: "50" },
    });

    expect(container.querySelectorAll(".table-row")).toHaveLength(31);
    expect(screen.getByText(/Showing 1–31 of 31/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Filter artifact mode"), {
      target: { value: "wiz" },
    });
    expect(screen.getByText("Wiz artifact run")).toBeTruthy();
  });

  it("resets both sections when the shared page size changes", () => {
    const rows = buildRows(75);
    const artifacts = buildArtifactRuns(60);
    const { container } = render(
      <RunsView rows={rows} artifactRuns={artifacts} onOpenDetail={vi.fn()} />,
    );

    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/Showing 51–75 of 75/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Artifact Runs" }));
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(screen.getByText(/Showing 26–50 of 60/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Rows per page"), {
      target: { value: "50" },
    });
    expect(screen.getByText(/Showing 1–50 of 60/)).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Pipeline Runs" }));
    expect(container.querySelectorAll(".table-row")).toHaveLength(50);
    expect(screen.getByText(/Showing 1–50 of 75/)).toBeTruthy();
  });

  it("labels pager navigation and styles pager buttons as visible controls", () => {
    render(
      <RunsView
        rows={buildRows(30)}
        artifactRuns={buildArtifactRuns(30)}
        onOpenDetail={vi.fn()}
      />,
    );

    const pipelinePager = screen.getByRole("navigation", {
      name: /pipeline runs pagination/i,
    });
    expect(pipelinePager).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /previous page/i }).className,
    ).toContain("btn-ghost");
    expect(
      screen.getByRole("button", { name: /next page/i }).className,
    ).toContain("btn-ghost");

    fireEvent.click(screen.getByRole("tab", { name: "Artifact Runs" }));
    expect(
      screen.getByRole("navigation", { name: /artifact runs pagination/i }),
    ).toBeTruthy();
  });

  // t-group-atomic
  it("counts a group as one paginated item, keeping children on the same page", () => {
    const groupMetadata = {
      mode: "multi_repo",
      repos: [
        { repo_id: 1, repo_name: "repo-a", branch_name: "master", base_commit_sha: "abc" },
        { repo_id: 2, repo_name: "repo-b", branch_name: "master", base_commit_sha: "def" },
        { repo_id: 3, repo_name: "repo-c", branch_name: "master", base_commit_sha: "ghi" },
      ],
      mergeOrder: { "repo-a": 1, "repo-b": 2, "repo-c": 3 },
    } as unknown as import("./types.js").OneShotDashboardRow["groupMetadata"];

    // 3 grouped rows (runGroupId 99) + 24 ungrouped rows = 25 items on page 1
    // (group counts as ONE item, not 3)
    const groupedRows = [
      buildRow({
        dashboardId: "group-run-1",
        jiraKey: "CPDEV-7001",
        runGroupId: 99,
        groupMetadata,
        repoName: "repo-a",
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, 0)).toISOString(),
      }),
      buildRow({
        dashboardId: "group-run-2",
        jiraKey: "CPDEV-7001",
        runGroupId: 99,
        groupMetadata,
        repoName: "repo-b",
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, 1)).toISOString(),
      }),
      buildRow({
        dashboardId: "group-run-3",
        jiraKey: "CPDEV-7001",
        runGroupId: 99,
        groupMetadata,
        repoName: "repo-c",
        createdAt: new Date(Date.UTC(2026, 3, 1, 0, 0, 2)).toISOString(),
      }),
    ];
    // 24 ungrouped rows with older timestamps so the group sorts first
    const ungroupedRows = Array.from({ length: 24 }, (_, i) =>
      buildRow({
        dashboardId: `ungrouped-${i}`,
        jiraKey: `CPDEV-${8000 + i}`,
        title: `Ungrouped ${i}`,
        createdAt: new Date(Date.UTC(2026, 2, 1, 0, 0, i)).toISOString(),
      }),
    );

    const { container } = render(
      <RunsView
        rows={[...groupedRows, ...ungroupedRows]}
        onOpenDetail={vi.fn()}
      />,
    );

    // Page 1: group header (1 item) + 24 ungrouped = 25 items; pager hidden (total === pageSize)
    // The group header button is present
    const groupHeader = container.querySelector(".run-group-header") as HTMLElement;
    expect(groupHeader).toBeTruthy();

    // The 24 ungrouped rows should also appear
    expect(screen.getByText("Ungrouped 0")).toBeTruthy();
    expect(screen.getByText("Ungrouped 23")).toBeTruthy();

    // Expand the group and confirm children render on the same page
    fireEvent.click(groupHeader);
    expect(screen.getByText("repo-a")).toBeTruthy();
    expect(screen.getByText("repo-b")).toBeTruthy();
    expect(screen.getByText("repo-c")).toBeTruthy();

    // Group expansion does NOT overflow onto page 2 — all ungrouped still visible
    expect(screen.getByText("Ungrouped 0")).toBeTruthy();
  });

  // t-clamp
  it("clamps to the last valid page when rows shrink due to polling", () => {
    const rows = buildRows(30);
    const { rerender, container } = render(
      <RunsView rows={rows} onOpenDetail={vi.fn()} />,
    );

    // Advance to page 2
    fireEvent.click(screen.getByRole("button", { name: /next/i }));
    expect(container.querySelectorAll(".table-row")).toHaveLength(5);

    // Simulate polling shrink: only 10 rows remain
    const smallerRows = buildRows(10);
    rerender(<RunsView rows={smallerRows} onOpenDetail={vi.fn()} />);

    // Should clamp to page 1 (only one page for 10 rows at page size 25)
    // Pager should be hidden (10 < 25), all 10 rows visible
    expect(container.querySelectorAll(".table-row")).toHaveLength(10);
    expect(screen.queryByText(/Showing/)).toBeNull(); // pager hidden
  });
});
