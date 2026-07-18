import { describe, expect, it } from "vitest";

import {
  aggregateArtifactCostsByRun,
  buildDisplayCostSummary,
  calculateLegacyEstimatedCost,
  estimateCostUsdFromArtifact,
  isDeterministicGuardrailRow,
  resolveArtifactCostContribution,
  resolveModelPricingMetadata,
} from "./oneshotCosting.js";

describe("oneshotCosting", () => {
  it("prefers stored artifact cost when present", () => {
    const contribution = resolveArtifactCostContribution({
      oneshot_run_id: 1,
      artifact_stage: "review",
      stage_cost_usd: 1.2345,
      stage_tokens_used: 1000,
      model: "gpt-5.4",
      provider: "openai",
    });

    expect(contribution).toEqual({
      usd: 1.2345,
      source: "actual",
    });
  });

  it("estimates artifact cost from model-aware blended rates when exact cost is missing", () => {
    expect(
      estimateCostUsdFromArtifact("openai", "gpt-5.4", 1_000_000),
    ).toBe(8.75);
    expect(
      estimateCostUsdFromArtifact(
        "anthropic",
        "us.anthropic.claude-sonnet-4-6",
        1_000_000,
      ),
    ).toBe(9.9);
    expect(
      estimateCostUsdFromArtifact(
        "anthropic",
        "us.anthropic.claude-sonnet-5",
        1_000_000,
      ),
    ).toBe(9.9);
    expect(
      estimateCostUsdFromArtifact(
        "anthropic",
        "global.anthropic.claude-sonnet-4-6",
        1_000_000,
      ),
    ).toBe(9);
    expect(
      estimateCostUsdFromArtifact(
        "anthropic",
        "us.anthropic.claude-opus-4-7",
        1_000_000,
      ),
    ).toBe(16.5);
    expect(
      estimateCostUsdFromArtifact(
        "anthropic",
        "us.anthropic.claude-opus-4-8",
        1_000_000,
      ),
    ).toBe(16.5);
  });

  it("resolves display pricing metadata for model rows", () => {
    const haikuPricing = resolveModelPricingMetadata(
      "anthropic",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    expect(haikuPricing).toMatchObject({
      inputUsdPerMillion: 1.1,
      outputUsdPerMillion: 5.5,
      blendedUsdPerMillion: 3.3,
      cacheWriteUsdPerMillion: 1.375,
      sourceModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    });
    expect(haikuPricing?.cacheReadUsdPerMillion).toBeCloseTo(0.11);

    expect(resolveModelPricingMetadata(null, "gpt-5.4")).toMatchObject({
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cachedInputUsdPerMillion: 0.25,
      blendedUsdPerMillion: 8.75,
      sourceModel: "gpt-5.4",
    });
    expect(
      resolveModelPricingMetadata(
        "anthropic",
        "us.anthropic.claude-sonnet-5",
      ),
    ).toMatchObject({
      inputUsdPerMillion: 3.3,
      outputUsdPerMillion: 16.5,
      blendedUsdPerMillion: 9.9,
      cacheReadUsdPerMillion: 0.33,
      cacheWriteUsdPerMillion: 4.125,
      sourceModel: "us.anthropic.claude-sonnet-5",
    });
    expect(
      resolveModelPricingMetadata(
        "anthropic",
        "global.anthropic.claude-opus-4-8",
      ),
    ).toMatchObject({
      inputUsdPerMillion: 5,
      outputUsdPerMillion: 25,
      blendedUsdPerMillion: 15,
      cacheReadUsdPerMillion: 0.5,
      cacheWriteUsdPerMillion: 6.25,
      sourceModel: "global.anthropic.claude-opus-4-8",
    });
    expect(resolveModelPricingMetadata(null, "mystery-model")).toBeNull();
  });

  it("falls back to the legacy blended estimate when model pricing is unavailable", () => {
    const summary = buildDisplayCostSummary(
      1_000_000,
      aggregateArtifactCostsByRun([
        {
          oneshot_run_id: 12,
          artifact_stage: "implementation",
          stage_cost_usd: null,
          stage_tokens_used: 1_000_000,
          model: "unknown-model",
          provider: null,
        },
      ]).get(12),
    );

    expect(summary).toEqual({
      estimatedCostUsd: calculateLegacyEstimatedCost(1_000_000),
      costSource: "estimated",
    });
  });

  it("preserves sub-cent legacy fallback costs before aggregation", () => {
    const summary = buildDisplayCostSummary(
      1_000,
      aggregateArtifactCostsByRun([
        {
          oneshot_run_id: 13,
          artifact_stage: "implementation",
          stage_cost_usd: null,
          stage_tokens_used: 1_000,
          model: "unknown-model",
          provider: null,
        },
      ]).get(13),
    );

    expect(summary).toEqual({
      estimatedCostUsd: 0.008,
      costSource: "estimated",
    });
  });

  it("marks a run as mixed when some artifacts are actual and some are estimated", () => {
    const summary = aggregateArtifactCostsByRun([
      {
        oneshot_run_id: 91,
        artifact_stage: "plan",
        stage_cost_usd: 0.5,
        stage_tokens_used: 10_000,
        model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
        provider: "anthropic",
      },
      {
        oneshot_run_id: 91,
        artifact_stage: "review",
        stage_cost_usd: null,
        stage_tokens_used: 1_000_000,
        model: "gpt-5.4",
        provider: "openai",
      },
    ]).get(91);

    expect(summary).toEqual({
      estimatedCostUsd: 9.25,
      costSource: "mixed",
    });
  });

  it("aggregates failed stage attempt metric rows with completed artifact costs", () => {
    const summary = aggregateArtifactCostsByRun([
      {
        oneshot_run_id: 80,
        artifact_stage: "planning",
        stage_cost_usd: 1.7226,
        stage_tokens_used: 349530,
        model: "us.anthropic.claude-opus-4-6-v1",
        provider: "anthropic",
      },
      {
        oneshot_run_id: 80,
        artifact_stage: "planning",
        stage_cost_usd: 2.5098,
        stage_tokens_used: 573190,
        model: "us.anthropic.claude-opus-4-6-v1",
        provider: "anthropic",
      },
    ]).get(80);

    expect(summary).toEqual({
      estimatedCostUsd: 4.2324,
      costSource: "actual",
    });
  });

  it("excludes deterministic plan-contract guardrail rows from cost-source aggregation", () => {
    const summary = aggregateArtifactCostsByRun([
      {
        oneshot_run_id: 99,
        artifact_stage: "implementation",
        stage_cost_usd: null,
        stage_tokens_used: 1_000_000,
        model: "us.anthropic.claude-sonnet-5",
        provider: "anthropic",
      },
      {
        oneshot_run_id: 99,
        artifact_stage: "review",
        stage_cost_usd: 0,
        stage_tokens_used: 0,
        model: "plan-contract-v1",
        provider: "deterministic_guardrail",
      },
    ]).get(99);

    expect(summary).toEqual({
      estimatedCostUsd: 9.9,
      costSource: "estimated",
    });
  });

  it("scopes the deterministic guardrail predicate to plan-contract rows only", () => {
    expect(
      isDeterministicGuardrailRow("deterministic_guardrail", "plan-contract-v1"),
    ).toBe(true);
    expect(isDeterministicGuardrailRow(null, "plan-contract-v1")).toBe(true);
    expect(isDeterministicGuardrailRow("deterministic_guardrail", null)).toBe(
      true,
    );
    expect(isDeterministicGuardrailRow("deterministic", "trace-port")).toBe(
      false,
    );
    expect(isDeterministicGuardrailRow("deterministic", "verify-port")).toBe(
      false,
    );
    expect(isDeterministicGuardrailRow("anthropic", "claude-sonnet-5")).toBe(
      false,
    );
  });
});
