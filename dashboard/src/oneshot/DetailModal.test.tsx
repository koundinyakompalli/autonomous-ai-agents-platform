// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildRepoRouterAuthStartUrl, DetailModal } from "./DetailModal.js";
import { formatDateTime } from "./formatters.js";
import type { OneShotDashboardRow } from "./types.js";

const CORE_APP_PREVIEW_URL =
  "https://devaccountqa.mhkdevsandbox.com/cas/login?service=https%3A%2F%2Fclient-a-cp-dev-mhk-core.mhkdevsandbox.com%2Fmedhok%2F";

const {
  listRepoRouterConfirmationsMock,
  requestOneShotCiRefreshMock,
  resolveRepoRouterConfirmationMock,
  retryOneShotRunMock,
  updateOneShotTicketTypeMock,
} = vi.hoisted(() => ({
  listRepoRouterConfirmationsMock: vi.fn(),
  requestOneShotCiRefreshMock: vi.fn(),
  resolveRepoRouterConfirmationMock: vi.fn(),
  retryOneShotRunMock: vi.fn(),
  updateOneShotTicketTypeMock: vi.fn(),
}));

vi.mock("./repoRouterApi.js", () => ({
  listRepoRouterConfirmations: listRepoRouterConfirmationsMock,
  resolveRepoRouterConfirmation: resolveRepoRouterConfirmationMock,
}));

vi.mock("./runCiRefreshApi.js", () => ({
  requestOneShotCiRefresh: requestOneShotCiRefreshMock,
}));

vi.mock("./runRetryApi.js", () => ({
  retryOneShotRun: retryOneShotRunMock,
}));

vi.mock("./ticketTypeApi.js", () => ({
  updateOneShotTicketType: updateOneShotTicketTypeMock,
}));

vi.mock("../hooks/useOneShotRunTimeline.js", () => ({
  useOneShotRunTimeline: () => ({
    data: null,
    isLoading: false,
    error: null,
  }),
}));

beforeEach(() => {
  listRepoRouterConfirmationsMock.mockReset();
  requestOneShotCiRefreshMock.mockReset();
  resolveRepoRouterConfirmationMock.mockReset();
  retryOneShotRunMock.mockReset();
  updateOneShotTicketTypeMock.mockReset();
  window.history.replaceState({}, "", "/oneshot");
});

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-1000",
    jiraKey: "INFRA-4286",
    title: "Refactor auth middleware to use async context",
    jiraIssueType: "Story",
    ticketType: "story",
    ticketTypeSource: "jira_issue_type",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
    sourceTaskManagementId: 2000,
    oneshotRunId: 1000,
    customerName: "Northstar Health",
    displayState: "qualification_pending",
    progressStage: "qualification",
    progressPercent: 8,
    repoName: "platform-infra",
    repoUrl: "https://github.com/example/platform-infra",
    baseBranch: "main",
    baseCommitSha: "platforminfr",
    implementationBranch: "oneshot/infra-4286",
    implementationCommitSha: null,
    reviewLoopCount: 0,
    maxReviewLoops: 3,
    currentPrUrl: null,
    qualificationSummary: "QUALIFIER is still assessing the ticket.",
    lastError: null,
    lastErrorSummary: null,
    retry: null,
    deployment: {
      eligible: false,
      ready: false,
      active: false,
      light: "grey",
      status: "not_eligible",
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: "2026-04-23T21:16:44.330Z",
    lastManualRestartAt: null,
    updatedAt: "2026-04-23T21:21:05.540Z",
    totalTokensUsed: 21007,
    estimatedCostUsd: 0.17,
    costSource: "mixed",
    ...overrides,
  };
}

describe("DetailModal error surface", () => {
  it("updates normalized ticket type from the detail metadata selector", async () => {
    const row = buildRow();
    const updatedRow = {
      ...row,
      ticketType: "defect" as const,
      ticketTypeSource: "manual",
      ticketTypeUpdatedBy: "Ravi",
      ticketTypeUpdatedAt: "2026-05-01T00:08:00.000Z",
    };
    updateOneShotTicketTypeMock.mockResolvedValue(updatedRow);
    const onChanged = vi.fn();

    render(
      <DetailModal row={row} onClose={() => undefined} onChanged={onChanged} />,
    );

    fireEvent.change(screen.getByLabelText("Ticket type for INFRA-4286"), {
      target: { value: "defect" },
    });

    await waitFor(() => {
      expect(updateOneShotTicketTypeMock).toHaveBeenCalledWith(
        "run-1000",
        "defect",
      );
    });
    expect(onChanged).toHaveBeenCalledWith("Ticket type updated.", updatedRow);
  });

  it("shows worker heartbeat wording for active OneShot run stages", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "implementing",
          progressStage: "implementation",
          updatedAt: new Date().toISOString(),
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(/worker active · heartbeat/)).toBeTruthy();
  });

  it("does not render a failure surface for an in-progress qualification summary", () => {
    render(<DetailModal row={buildRow()} onClose={() => undefined} />);

    expect(screen.queryByText("Failure in Qualify")).toBeNull();
    expect(
      screen.getByRole("heading", {
        name: "Refactor auth middleware to use async context",
      }),
    ).toBeTruthy();
  });

  it("uses the latest manual restart for elapsed time while keeping created time as audit data", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "implementing",
          progressStage: "implementation",
          createdAt: "2026-04-20T21:16:44.330Z",
          lastManualRestartAt: "2026-04-23T21:00:00.000Z",
          updatedAt: "2026-04-23T21:21:05.540Z",
        })}
        onClose={() => undefined}
      />,
    );

    const elapsedChip = screen
      .getAllByText("21m")
      .map((node) => node.closest(".meta-chip"))
      .find((node) => node?.getAttribute("title") === "elapsed since restart");
    expect(elapsedChip?.getAttribute("title")).toBe("elapsed since restart");
    expect(
      screen.getAllByText(formatDateTime("2026-04-20T21:16:44.330Z")).length,
    ).toBeGreaterThan(0);
  });

  it("renders a failure surface for a failed qualification summary", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "qualification_failed",
          qualificationSummary: "Ticket did not qualify for OneShot.",
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("Failure in Qualify")).toBeTruthy();
    expect(
      screen.getByText("Ticket did not qualify for OneShot."),
    ).toBeTruthy();
  });

  it("anchors the failure surface to the failed stage tile only", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "qualification_failed",
          progressStage: "qualification",
          qualificationSummary: "Ticket did not qualify for OneShot.",
        })}
        onClose={() => undefined}
      />,
    );

    // Default selection is the failed stage, so the surface is shown.
    expect(screen.getByText("Failure in Qualify")).toBeTruthy();

    // Clicking another stage tile hides the failure surface — the failure
    // belongs to Qualify, not Validate.
    fireEvent.click(screen.getByRole("button", { name: /Validate stage/i }));
    expect(screen.queryByText("Failure in Qualify")).toBeNull();

    // Returning to the failed stage brings the surface back.
    fireEvent.click(screen.getByRole("button", { name: /Qualify stage/i }));
    expect(screen.getByText("Failure in Qualify")).toBeTruthy();
  });

  it("renders ticket-attributed qualifier rejections as Ticket Not Ready", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "qualification_failed",
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
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText("Ticket Not Ready").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Ticket author action/).length).toBeGreaterThan(
      0,
    );
    expect(
      screen.getByText(/update Jira with acceptance criteria/),
    ).toBeTruthy();
    expect(screen.getByText(/acceptance_criteria_missing/)).toBeTruthy();
    expect(screen.queryByText("Qualification Failed")).toBeNull();
  });

  it("renders OneShot-side qualifier failures as Qualifier Error", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "qualification_failed",
          progressStage: "qualification",
          lastError: "Bedrock 503 overloaded",
          lastErrorSummary: "Bedrock 503 overloaded",
          failureAttribution: {
            attribution: "oneshot",
            errorCategory: "llm_provider",
            qualifierReasonCode: null,
            label: "Qualifier Error",
            rationale: "OneShot-side issue.",
            excludedFromDenominator: false,
          },
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText("Qualifier Error").length).toBeGreaterThan(0);
    expect(screen.getByText(/OneShot platform action/)).toBeTruthy();
    expect(screen.getByText(/Bedrock 503 overloaded/)).toBeTruthy();
  });

  it("renders non-qualifier OneShot failures with stage-specific labels", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "failed",
          progressStage: "implementation",
          lastError:
            "Run exceeded maximum age of 24 hours (age: 99h). Run has been abandoned.",
          lastErrorSummary:
            "Run exceeded maximum age of 24 hours (age: 99h). Run has been abandoned.",
          failureAttribution: {
            attribution: "oneshot",
            errorCategory: "budget",
            qualifierReasonCode: null,
            label: "Implementation Error",
            rationale: "OneShot-side issue.",
            excludedFromDenominator: false,
          },
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText("Implementation Error").length).toBeGreaterThan(
      0,
    );
    expect(screen.queryByText("Qualifier Error")).toBeNull();
    expect(screen.getByText(/failed OneShot stage or runtime/)).toBeTruthy();
    expect(
      screen.getAllByText(/Run exceeded maximum age/).length,
    ).toBeGreaterThan(0);
  });

  it("renders retry for failed OneShot stages and refreshes after queueing", async () => {
    const row = buildRow({
      dashboardId: "run-1000",
      oneshotRunId: 1000,
      displayState: "failed",
      progressStage: "implementation",
      lastError: "implementation failed",
      lastErrorSummary: "implementation failed",
      retry: {
        stage: "implementation",
        eligible: true,
        attemptsUsed: 0,
        attemptsRemaining: 2,
        maxAttempts: 2,
      },
    });
    const updatedRow = {
      ...row,
      displayState: "queued_for_implementation" as const,
      lastError: null,
      lastErrorSummary: null,
      retry: null,
    };
    retryOneShotRunMock.mockResolvedValue({
      row: updatedRow,
      retry: {
        oneshotRunId: 1000,
        stage: "implementation",
        state: "queued_for_implementation",
        version: 2,
        attemptsUsed: 1,
        attemptsRemaining: 1,
      },
    });
    const onChanged = vi.fn();

    render(
      <DetailModal row={row} onClose={() => undefined} onChanged={onChanged} />,
    );

    const retryButton = screen.getByRole("button", { name: /Retry Build/ });
    expect(retryButton.className).toContain("error-retry-button");
    expect(retryButton.className).not.toContain("btn-primary");
    expect(screen.getByText("2 retries left").className).toContain(
      "error-retry-meta",
    );
    expect(screen.getByRole("button", { name: "Copy error" })).toBeTruthy();
    fireEvent.click(retryButton);

    await waitFor(() => {
      expect(retryOneShotRunMock).toHaveBeenCalledWith("run-1000");
    });
    expect(onChanged).toHaveBeenCalledWith("Build retry queued.", updatedRow);
  });

  it("does not render retry for qualifier failure rows", () => {
    render(
      <DetailModal
        row={buildRow({
          dashboardId: "qualifier-task-1000",
          oneshotRunId: null,
          displayState: "qualification_failed",
          progressStage: "qualification",
          qualificationSummary: "Ticket did not qualify for OneShot.",
          retry: null,
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByRole("button", { name: /Retry/ })).toBeNull();
  });

  it("shows an amber retry-pending notice for queued rows with a prior timeout", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "queued_for_planning",
          progressStage: "planning",
          lastError: "SDK timeout after 360000ms",
          lastErrorSummary: "SDK timeout after 6m",
          retryPending: true,
          retryPendingStage: "planning",
        })}
        onClose={() => undefined}
      />,
    );

    expect(
      screen.getByText(/Last plan attempt timed out,\s+waiting for retry/),
    ).toBeTruthy();
    expect(screen.getByText("SDK timeout after 6m")).toBeTruthy();
    expect(screen.queryByText("Failure in Plan")).toBeNull();
  });

  it("shows retry ETA when retryPendingAttempt and retryPendingNextRetryAt are provided", () => {
    const nextRetryAt = new Date(Date.now() + 120_000).toISOString();
    render(
      <DetailModal
        row={buildRow({
          displayState: "queued_for_planning",
          progressStage: "planning",
          lastError: "SDK timeout after 360000ms",
          lastErrorSummary: "SDK timeout after 6m",
          retryPending: true,
          retryPendingStage: "planning",
          retryPendingAttempt: 1,
          retryPendingMaxAttempts: 3,
          retryPendingNextRetryAt: nextRetryAt,
          retryPendingDelaySeconds: 120,
          retryPendingVisibilityStatus: "success",
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(/Retry 1 of 3 expected around/)).toBeTruthy();
  });

  it("does not show retry ETA when retryPendingAttempt is missing", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "queued_for_planning",
          progressStage: "planning",
          lastError: "SDK timeout after 360000ms",
          lastErrorSummary: "SDK timeout after 6m",
          retryPending: true,
          retryPendingStage: "planning",
          retryPendingAttempt: null,
          retryPendingNextRetryAt: null,
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByText(/Retry \d+ of/)).toBeNull();
  });

  it("does not show retry ETA when nextRetryAt is in the past", () => {
    const pastRetryAt = new Date(Date.now() - 60_000).toISOString();
    render(
      <DetailModal
        row={buildRow({
          displayState: "queued_for_planning",
          progressStage: "planning",
          lastError: "SDK timeout after 360000ms",
          lastErrorSummary: "SDK timeout after 6m",
          retryPending: true,
          retryPendingStage: "planning",
          retryPendingAttempt: 2,
          retryPendingMaxAttempts: 3,
          retryPendingNextRetryAt: pastRetryAt,
          retryPendingDelaySeconds: 300,
          retryPendingVisibilityStatus: "success",
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByText(/Retry \d+ of/)).toBeNull();
  });

  it("does not show retry ETA when visibility shortening failed", () => {
    const nextRetryAt = new Date(Date.now() + 120_000).toISOString();
    render(
      <DetailModal
        row={buildRow({
          displayState: "queued_for_planning",
          progressStage: "planning",
          lastError: "SDK timeout after 360000ms",
          lastErrorSummary: "SDK timeout after 6m",
          retryPending: true,
          retryPendingStage: "planning",
          retryPendingAttempt: 1,
          retryPendingMaxAttempts: 3,
          retryPendingNextRetryAt: nextRetryAt,
          retryPendingDelaySeconds: 120,
          retryPendingVisibilityStatus: "failed",
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByText(/Retry \d+ of/)).toBeNull();
  });
});

describe("DetailModal readiness presentation", () => {
  it("hides needs-review metadata while preserving autonomous readiness details", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "pr_open",
          progressStage: "pr_complete",
          readiness: "needs_review",
          readinessReasons: ["CI checks require manual inspection."],
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.queryByText("readiness")).toBeNull();
    expect(screen.queryByText("Needs review")).toBeNull();
    expect(screen.getByText("Autonomous Readiness")).toBeTruthy();
    expect(
      screen.getByText("CI checks require manual inspection."),
    ).toBeTruthy();
  });

  it("requests CI readiness refresh for PR-open runs", async () => {
    const row = buildRow({
      displayState: "pr_open",
      progressStage: "pr_complete",
      currentPrUrl: "https://github.com/example/platform-infra/pull/42",
      ciStatus: {
        state: "pending",
        description: "GitHub CI is pending",
        details: ["build pending"],
      },
    });
    const updatedRow = {
      ...row,
      ciStatus: {
        state: "success",
        description: "GitHub CI passed",
        details: ["build passed"],
      },
    } as OneShotDashboardRow;
    requestOneShotCiRefreshMock.mockResolvedValue({
      row: updatedRow,
      refresh: { requested: true, mode: "scheduled_reconciler" },
    });
    const onChanged = vi.fn();

    render(
      <DetailModal row={row} onClose={() => undefined} onChanged={onChanged} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh CI" }));

    await waitFor(() =>
      expect(requestOneShotCiRefreshMock).toHaveBeenCalledWith("run-1000"),
    );
    expect(onChanged).toHaveBeenCalledWith(
      "CI readiness refresh requested.",
      updatedRow,
    );
  });
});

describe("DetailModal repo confirmation", () => {
  it("builds an auth URL that preserves the selected repo and detail route", () => {
    const url = new URL(
      buildRepoRouterAuthStartUrl(
        18,
        2,
        "/oneshot",
        "?view=waiting&run=qualifier-task-2429&repoConfirm=1",
      ),
      "https://dashboard.local",
    );

    expect(url.pathname).toBe("/auth/repo-router/start");
    expect(url.searchParams.get("returnTo")).toBe(
      "/oneshot?view=waiting&run=qualifier-task-2429&repoConfirm=1&repoConfirmationId=18&repoId=2",
    );
  });

  it("shows the timeout failure while waiting for repo selection", async () => {
    listRepoRouterConfirmationsMock.mockResolvedValue([
      {
        id: 12,
        ticketId: "INFRA-4286",
        taskManagementId: 2000,
        candidates: [
          { repoId: 1, repoName: "core-app" },
          { repoId: 2, repoName: "interop" },
        ],
      },
    ]);

    render(
      <DetailModal
        row={buildRow({
          displayState: "repo_confirmation_pending",
          progressStage: "qualification",
          qualificationSummary: "SDK timeout after 10m",
          lastError: "SDK timeout after 600000ms",
          lastErrorSummary: "SDK timeout after 10m",
        })}
        onClose={() => undefined}
      />,
    );

    expect(
      await screen.findByText(
        "Qualification attempt failed: SDK timeout after 10m",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Repository")).toBeTruthy();
  });

  it("resolves the selected repo after returning from repo auth", async () => {
    window.history.replaceState(
      {},
      "",
      "/oneshot?view=waiting&run=qualifier-task-1000&repoConfirm=1&repoConfirmationId=12&repoId=2",
    );
    listRepoRouterConfirmationsMock.mockResolvedValue([
      {
        id: 12,
        ticketId: "INFRA-4286",
        taskManagementId: 2000,
        candidates: [
          { repoId: 1, repoName: "core-app" },
          { repoId: 2, repoName: "interop" },
        ],
      },
    ]);
    resolveRepoRouterConfirmationMock.mockResolvedValue(undefined);
    const onChanged = vi.fn();

    render(
      <DetailModal
        row={buildRow({
          displayState: "repo_confirmation_pending",
          progressStage: "qualification",
        })}
        onClose={() => undefined}
        onChanged={onChanged}
      />,
    );

    await waitFor(() =>
      expect(resolveRepoRouterConfirmationMock).toHaveBeenCalledWith(12, 2),
    );
    expect(window.location.search).toBe(
      "?view=waiting&run=qualifier-task-1000",
    );
    expect(onChanged).toHaveBeenCalledWith(
      "Repo confirmed; QUALIFIER will resume.",
    );
  });

  it("shows a sign-in prompt when repo resolution still lacks identity headers", async () => {
    window.history.replaceState(
      {},
      "",
      "/oneshot?view=waiting&run=qualifier-task-1000&repoConfirm=1&repoConfirmationId=12&repoId=2",
    );
    listRepoRouterConfirmationsMock.mockResolvedValue([
      {
        id: 12,
        ticketId: "INFRA-4286",
        taskManagementId: 2000,
        candidates: [
          { repoId: 1, repoName: "core-app" },
          { repoId: 2, repoName: "interop" },
        ],
      },
    ]);
    resolveRepoRouterConfirmationMock.mockRejectedValue(
      new Error("Trusted operator identity headers are missing"),
    );

    render(
      <DetailModal
        row={buildRow({
          displayState: "repo_confirmation_pending",
          progressStage: "qualification",
        })}
        onClose={() => undefined}
      />,
    );

    expect(
      await screen.findByText(
        "Sign in is required to select a repo. Click Select Repo to authenticate and try again.",
      ),
    ).toBeTruthy();
  });
});

describe("DetailModal planner diagnostics", () => {
  it("does not render zero-valued SDK lifecycle chips", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "failed",
          progressStage: "planning",
          plannerAttemptDiagnostics: {
            reason: "planner_completed",
          },
          sdkLifecycleSummary: {
            apiRetryCount: 0,
            rateLimitCount: 0,
            permissionDenials: [],
            compactBoundaryCount: 0,
            compactDurationMs: 0,
            taskStartedCount: 0,
            subagentStartCount: 0,
            hookFailureCount: 0,
            rawTraceTruncated: false,
          },
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText("planner_completed")).toBeTruthy();
    expect(screen.queryByText(/api retries=0/)).toBeNull();
    expect(screen.queryByText(/rate limits=0/)).toBeNull();
    expect(screen.queryByText(/permission denials=0/)).toBeNull();
    expect(screen.queryByText(/compactions=0/)).toBeNull();
    expect(screen.queryByText(/tasks=0/)).toBeNull();
    expect(screen.queryByText(/subagents=0/)).toBeNull();
  });

  it("renders positive SDK lifecycle provider and lifecycle signals", () => {
    render(
      <DetailModal
        row={buildRow({
          displayState: "failed",
          progressStage: "planning",
          sdkLifecycleSummary: {
            sdkResultSubtype: "success",
            apiDurationMs: 1200,
            numTurns: 3,
            stopReason: "end_turn",
            apiRetryCount: 2,
            rateLimitCount: 1,
            permissionDenials: [{ toolName: "Read" }],
            compactBoundaryCount: 1,
            compactDurationMs: 900,
            taskStartedCount: 2,
            subagentStartCount: 1,
            hookFailureCount: 1,
            rawTraceTruncated: true,
          },
        })}
        onClose={() => undefined}
      />,
    );

    expect(screen.getByText(/success · stop=end_turn · 3 turn/)).toBeTruthy();
    expect(
      screen.getByText(/api retries=2 · rate limits=1 · permission denials=1/),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /compactions=1 · compact time=<1m · tasks=2 · subagents=1 · hook failures=1 · raw trace truncated/,
      ),
    ).toBeTruthy();
  });
});

describe("DetailModal deploy action", () => {
  it("always renders Preview Deployment in the hero action cluster and opens dev", () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const onDeploy = vi.fn();
    const row = buildRow();

    render(
      <DetailModal row={row} onClose={() => undefined} onDeploy={onDeploy} />,
    );

    const button = screen.getByRole("button", {
      name: /Preview Deployment/,
    });

    expect(button.closest(".detail-hero-actions")).toBeTruthy();

    fireEvent.click(button);

    expect(openSpy).toHaveBeenCalledWith(
      CORE_APP_PREVIEW_URL,
      "_blank",
      "noopener,noreferrer",
    );
    expect(onDeploy).not.toHaveBeenCalled();
  });

  it("keeps Preview Deployment available for pending deployment rows", () => {
    const baseRow = buildRow();
    const row = buildRow({
      displayState: "approved",
      progressStage: "pr_complete",
      deployment: {
        ...baseRow.deployment,
        eligible: true,
        ready: true,
        light: "amber",
        status: "workflow_pending",
        workflowUrl: "https://github.com/example/platform/actions/runs/123",
      },
    });

    render(
      <DetailModal row={row} onClose={() => undefined} onDeploy={vi.fn()} />,
    );

    const button = screen.getByRole("button", {
      name: /Preview Deployment/,
    }) as HTMLButtonElement;

    expect(button.closest(".detail-hero-actions")).toBeTruthy();
    expect(button.disabled).toBe(false);
  });
});
