import { describe, expect, it } from "vitest";
import { deriveStatusTone } from "./statusTone.js";
import type { OneShotDashboardRow } from "./types.js";

function buildRow(
  overrides: Partial<OneShotDashboardRow> = {},
): OneShotDashboardRow {
  return {
    dashboardId: "qualifier-task-2009",
    jiraKey: "CPDEV-20908",
    title: 'Member Search: Style "Cancel" button',
    sourceTaskManagementId: 2009,
    oneshotRunId: null,
    customerName: "MHK",
    displayState: "qualification_no_action",
    progressStage: "qualification",
    progressPercent: 10,
    repoName: null,
    repoUrl: null,
    baseBranch: null,
    baseCommitSha: null,
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
    createdAt: "2026-04-27T14:57:46.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-04-27T15:04:32.000Z",
    totalTokensUsed: 0,
    estimatedCostUsd: 0,
    costSource: "estimated",
    ...overrides,
  };
}

describe("deriveStatusTone", () => {
  it("uses a neutral tone for qualifier no-action rows", () => {
    expect(deriveStatusTone(buildRow())).toBe("neutral");
  });

  it("shows PR-open rows as completed lifecycle tone regardless of readiness", () => {
    const readinessStates = [
      null,
      "ready",
      "needs_review",
      "draft",
      "with_risks",
    ] as const;

    for (const readiness of readinessStates) {
      expect(deriveStatusTone(buildRow({
        displayState: "pr_open",
        readiness,
      }))).toBe("completed");
    }
  });

  it("shows completed rows as completed lifecycle tone regardless of readiness", () => {
    const readinessStates = [
      null,
      "ready",
      "needs_review",
      "draft",
      "with_risks",
    ] as const;

    for (const readiness of readinessStates) {
      expect(deriveStatusTone(buildRow({
        displayState: "completed",
        readiness,
      }))).toBe("completed");
    }
  });

  it("uses an amber waiting tone for ticket-attributed qualifier rejections", () => {
    expect(deriveStatusTone(buildRow({
      displayState: "qualification_failed",
      failureAttribution: {
        attribution: "ticket",
        errorCategory: "ticket_quality",
        qualifierReasonCode: "llm_rejected",
        label: "Ticket Not Ready",
        rationale: "Ticket-quality issue.",
        excludedFromDenominator: false,
      },
    }))).toBe("waiting");
  });
});
