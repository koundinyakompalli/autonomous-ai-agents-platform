import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { submitCreateRun } from "./newRunApi.js";
import type { OneShotDashboardRow } from "./types.js";

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "run-9001",
    jiraKey: "CPDEV-123",
    title: "Mock run for CPDEV-123",
    sourceTaskManagementId: 3001,
    oneshotRunId: 9001,
    customerName: null,
    displayState: "qualification_pending",
    progressStage: "qualification",
    progressPercent: 4,
    repoName: "product-factory",
    repoUrl: "https://github.com/example/product-factory",
    baseBranch: "main",
    baseCommitSha: "abc123",
    implementationBranch: null,
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
      light: "grey",
      status: "not_eligible",
      active: false,
      previewUrl: null,
      workflowUrl: null,
      imageUri: null,
      deployedCommitSha: null,
    },
    createdAt: "2026-04-21T00:00:00.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-04-21T00:00:00.000Z",
    totalTokensUsed: 0,
    estimatedCostUsd: 0,
    costSource: "estimated",
    ...overrides,
  };
}

describe("submitCreateRun", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("submits durable run requests through the real queue endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 42,
          jiraKey: "CPDEV-123",
          status: "queued",
          submittedAt: "2026-04-21T12:00:00.000Z",
        }),
        { status: 202, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitCreateRun("request", "cpdev-123"),
    ).resolves.toEqual({
      kind: "request",
      request: {
        id: 42,
        jiraKey: "CPDEV-123",
        status: "queued",
        submittedAt: "2026-04-21T12:00:00.000Z",
      },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oneshot/run-requests",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ jiraKey: "CPDEV-123" }),
      }),
    );
  });

  it("creates local mock rows through the mock endpoint with a synthetic title", async () => {
    const row = buildRow();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(row), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      submitCreateRun("mock", "cpdev-123"),
    ).resolves.toEqual({
      kind: "mock",
      row,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/oneshot/mock-runs",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          jiraKey: "CPDEV-123",
          title: "Mock run for CPDEV-123",
        }),
      }),
    );
  });
});
