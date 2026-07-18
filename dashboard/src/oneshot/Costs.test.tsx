// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Costs, isDeterministicGuardrailRow } from "./Costs.js";
import type {
  OneShotCostsAnalytics,
  OneShotDashboardRow,
} from "./types.js";
import { isDeterministicGuardrailRow as isDeterministicGuardrailRowBackend } from "../../server/services/oneshotCosting.js";

function buildRow(): OneShotDashboardRow {
  return {
    dashboardId: "run-1",
    jiraKey: "CPDEV-1",
    title: "Cost fixture",
    jiraIssueType: "Story",
    ticketType: "story",
    ticketTypeSource: "jira_issue_type",
    ticketTypeUpdatedBy: null,
    ticketTypeUpdatedAt: null,
    sourceTaskManagementId: 1,
    oneshotRunId: 1,
    customerName: null,
    displayState: "pr_open",
    progressStage: "pr_complete",
    progressPercent: 95,
    repoName: "core-app",
    repoUrl: null,
    baseBranch: "main",
    baseCommitSha: "abc",
    implementationBranch: null,
    implementationCommitSha: null,
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
    createdAt: "2026-05-04T12:00:00.000Z",
    lastManualRestartAt: null,
    updatedAt: "2026-05-04T12:05:00.000Z",
    totalTokensUsed: 58_000,
    estimatedCostUsd: 8.55,
    costSource: "actual",
  };
}

function buildAnalytics(): OneShotCostsAnalytics {
  return {
    window: {
      range: "24h",
      label: "Last 24 hours",
      shortLabel: "24h",
      bucketLabel: "hour",
      isAllTime: false,
    },
    totalUsd: 8.55,
    totalTokens: 58_000,
    costSource: "actual",
    trend: null,
    byStage: [
      { stage: "planning", tokens: 25_650, usd: 1.387335, share: 0.16 },
      { stage: "implementation", tokens: 33_346, usd: 7.020226, share: 0.82 },
      { stage: "review", tokens: 12_602, usd: 1.532462, share: 0.18 },
      { stage: "code_review", tokens: 7_500, usd: 0.9, share: 0.1 },
      { stage: "testing", tokens: 0, usd: 0, share: 0 },
      { stage: "qualification", tokens: null, usd: null, share: null },
    ],
    byModel: [
      {
        model: "claude-sonnet-4-6",
        provider: "anthropic",
        rawModelIds: ["us.anthropic.claude-sonnet-4-6"],
        pricing: {
          inputUsdPerMillion: 3.3,
          outputUsdPerMillion: 16.5,
          blendedUsdPerMillion: 9.9,
          cacheReadUsdPerMillion: 0.33,
          cacheWriteUsdPerMillion: 4.125,
          sourceModel: "us.anthropic.claude-sonnet-4-6",
        },
        tokens: 33_346,
        usd: 7.020226,
        share: 0.82,
      },
      {
        model: "us.anthropic.claude-sonnet-4-6",
        provider: null,
        tokens: 1_000,
        usd: 0.1,
        share: 0.01,
      },
      {
        model: "claude-opus-4-6",
        provider: "anthropic",
        rawModelIds: ["us.anthropic.claude-opus-4-6-v1"],
        pricing: {
          inputUsdPerMillion: 5.5,
          outputUsdPerMillion: 27.5,
          blendedUsdPerMillion: 16.5,
          cacheReadUsdPerMillion: 0.55,
          cacheWriteUsdPerMillion: 6.875,
          sourceModel: "us.anthropic.claude-opus-4-6-v1",
        },
        tokens: 38_252,
        usd: 2.919797,
        share: 0.34,
      },
      {
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        provider: "anthropic",
        pricing: {
          inputUsdPerMillion: 1.1,
          outputUsdPerMillion: 5.5,
          blendedUsdPerMillion: 3.3,
          cacheReadUsdPerMillion: 0.11,
          cacheWriteUsdPerMillion: 1.375,
          sourceModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        },
        tokens: 10_000,
        usd: 1,
        share: 0.12,
      },
      {
        model: "anthropic.claude-haiku-4-5-20251001-v1:0",
        provider: null,
        tokens: 2_000,
        usd: 0.2,
        share: 0.02,
      },
      {
        model: "gpt-5.4",
        provider: "openai",
        pricing: {
          inputUsdPerMillion: 2.5,
          outputUsdPerMillion: 15,
          blendedUsdPerMillion: 8.75,
          cachedInputUsdPerMillion: 0.25,
          sourceModel: "gpt-5.4",
        },
        tokens: 1_000,
        usd: 0.1,
        share: 0.01,
      },
      {
        model: "mystery-model",
        provider: null,
        pricing: null,
        tokens: 123,
        usd: 0.5,
        share: 0.05,
      },
      {
        model: "disabled",
        provider: "config",
        tokens: 0,
        usd: 0,
        share: 0,
      },
      {
        model: "advisory",
        provider: "soft_gate",
        tokens: 0,
        usd: 0,
        share: 0,
      },
      {
        model: "unknown",
        provider: "anthropic",
        tokens: 0,
        usd: 0,
        share: 0,
      },
      {
        model: "us.anthropic.claude-sonnet-5",
        provider: "anthropic",
        pricing: {
          inputUsdPerMillion: 3.3,
          outputUsdPerMillion: 16.5,
          blendedUsdPerMillion: 9.9,
          cacheReadUsdPerMillion: 0.33,
          cacheWriteUsdPerMillion: 4.125,
          sourceModel: "us.anthropic.claude-sonnet-5",
        },
        tokens: 5_000,
        usd: 0.6,
        share: 0.07,
      },
      {
        model: "plan-contract-v1",
        provider: "deterministic_guardrail",
        tokens: 0,
        usd: 0,
        share: 0,
      },
    ],
    topRuns: [
      {
        dashboardId: "run-1",
        jiraKey: "CPDEV-1",
        title: "Cost fixture",
        totalTokensUsed: 58_000,
        estimatedCostUsd: 8.55,
        costSource: "actual",
        progressStage: "pr_complete",
        displayState: "pr_open",
      },
    ],
  };
}

describe("Costs", () => {
  it("renders friendly model names while preserving raw model ids as titles", () => {
    render(
      <Costs
        analytics={buildAnalytics()}
        rows={[buildRow()]}
        range="24h"
        onRangeChange={() => undefined}
        onOpenDetail={() => undefined}
        onSearch={vi.fn()}
        onNewRun={vi.fn()}
      />,
    );

    expect(screen.getByText("Sonnet 4.6")).toBeTruthy();
    expect(screen.getByText("Opus 4.6")).toBeTruthy();
    expect(screen.getByText("Haiku 4.5")).toBeTruthy();
    expect(screen.getByText("GPT-5.4")).toBeTruthy();
    expect(
      screen.getByTitle("us.anthropic.claude-sonnet-4-6"),
    ).toBeTruthy();
    expect(screen.getAllByText("Sonnet 4.6")).toHaveLength(1);
    expect(screen.getAllByText("Haiku 4.5")).toHaveLength(1);
    expect(screen.queryByText("disabled")).toBeNull();
    expect(screen.queryByText("advisory")).toBeNull();
    expect(screen.queryByText("unknown")).toBeNull();
    expect(screen.getByText("Sonnet 5")).toBeTruthy();
    // "mystery-model" legitimately falls back to Unattributed LLM; the
    // Sonnet 5 row must not add a second one.
    expect(screen.getAllByText("Unattributed LLM")).toHaveLength(1);
    expect(screen.queryByText("plan-contract-v1")).toBeNull();
    expect(screen.queryByText("Plan Contract Check")).toBeNull();
    expect(screen.queryByText(/tokens.*dollars per agent/)).toBeNull();
    expect(screen.queryByText("who drives the spend")).toBeNull();
    expect(screen.getAllByText(/anthropic/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("$7.12").length).toBeGreaterThan(0);
    expect(screen.getAllByText("34.3k").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$1.20").length).toBeGreaterThan(0);
    expect(screen.getAllByText("12.0k").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Tokens").length).toBe(2);
    expect(screen.getAllByText("Cost").length).toBe(2);
    expect(screen.getAllByText("Input")).toHaveLength(5);
    expect(screen.getAllByText("Output")).toHaveLength(5);
    expect(screen.getAllByText("Blended")).toHaveLength(5);
    expect(screen.getAllByText("$3.30/M").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$16.50/M").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$9.90/M").length).toBeGreaterThan(0);
    expect(screen.getAllByText("$1.10/M").length).toBeGreaterThan(0);
    expect(screen.getByText("pricing unavailable")).toBeTruthy();
  });

  it("builds cost report download URLs from the selected range and ticket type", () => {
    render(
      <Costs
        analytics={buildAnalytics()}
        rows={[buildRow()]}
        range="7d"
        onRangeChange={() => undefined}
        onOpenDetail={() => undefined}
        onSearch={vi.fn()}
        onNewRun={vi.fn()}
      />,
    );

    const ticketType = screen.getByRole("combobox", {
      name: "Report ticket type",
    }) as HTMLSelectElement;
    const csvLink = screen.getByLabelText(
      "Download cost report CSV",
    ) as HTMLAnchorElement;
    const htmlLink = screen.getByLabelText(
      "Download cost report HTML",
    ) as HTMLAnchorElement;

    expect(csvLink.getAttribute("href")).toBe(
      "/api/oneshot/reports/costs.csv?range=7d&ticketType=all",
    );
    expect(htmlLink.getAttribute("href")).toBe(
      "/api/oneshot/reports/costs.html?range=7d&ticketType=all",
    );
    expect(ticketType.tagName).toBe("SELECT");
    expect(ticketType.value).toBe("all");

    fireEvent.change(ticketType, { target: { value: "sonar" } });

    expect(csvLink.getAttribute("href")).toBe(
      "/api/oneshot/reports/costs.csv?range=7d&ticketType=sonar",
    );
    expect(htmlLink.getAttribute("href")).toBe(
      "/api/oneshot/reports/costs.html?range=7d&ticketType=sonar",
    );
    expect(ticketType.value).toBe("sonar");
  });

  it("keeps the frontend deterministic-guardrail predicate mirror in behavioral parity with the backend export", () => {
    const cases: Array<[string | null, string | null]> = [
      ["deterministic_guardrail", "plan-contract-v1"],
      [null, "plan-contract-v1"],
      ["deterministic_guardrail", null],
      ["deterministic", "trace-port"],
      ["deterministic", "verify-port"],
      ["anthropic", "claude-sonnet-5"],
      [null, null],
    ];

    for (const [provider, model] of cases) {
      expect(isDeterministicGuardrailRow(provider, model)).toBe(
        isDeterministicGuardrailRowBackend(provider, model),
      );
    }
  });
});
