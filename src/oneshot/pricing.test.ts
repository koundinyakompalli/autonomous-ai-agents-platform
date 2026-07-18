import { describe, expect, it } from "vitest";

import {
  calculateLegacyEstimatedCost,
  calculateUsageCostBreakdown,
  calculateUsageCostUsd,
  estimateCostUsdFromModelTokens,
} from "./pricing.js";

describe("oneshot pricing", () => {
  it("calculates GPT-5.4 cost including cached input pricing", () => {
    const cost = calculateUsageCostUsd("openai", "gpt-5.4", {
      input: 1_000_000,
      output: 100_000,
      cachedInput: 250_000,
    });

    expect(cost).toBe(3.4375);
  });

  it("calculates GPT-5.5 cost including cached input pricing", () => {
    const cost = calculateUsageCostUsd("openai", "gpt-5.5", {
      input: 1_000_000,
      output: 100_000,
      cachedInput: 250_000,
    });

    expect(cost).toBe(6.875);
  });

  it("prices OpenAI cache writes without double-counting input tokens", () => {
    const breakdown = calculateUsageCostBreakdown("openai", "gpt-5.6-luna", {
      input: 1_000_000,
      output: 100_000,
      cachedInput: 200_000,
      cacheWrite: 100_000,
    });

    expect(breakdown).toMatchObject({
      costUsd: 1.445,
      inputCostUsd: 0.7,
      outputCostUsd: 0.6,
      cachedInputCostUsd: 0.02,
      cacheWriteCostUsd: 0.125,
      pricing: {
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 6,
        cachedInputUsdPerMillion: 0.1,
        cacheWriteUsdPerMillion: 1.25,
      },
    });
  });

  it("resolves dated GPT-5.5 and GPT-5.6 Terra model aliases", () => {
    expect(
      calculateUsageCostUsd("openai", "gpt-5.5-2026-04-23", {
        input: 1_000_000,
        output: 100_000,
      }),
    ).toBe(8);
    expect(
      calculateUsageCostUsd("openai", "openai/gpt-5.6-terra", {
        input: 1_000_000,
        output: 100_000,
      }),
    ).toBe(4);
  });

  it("calculates Claude Sonnet cache-aware fallback cost", () => {
    const cost = calculateUsageCostUsd(
      "anthropic",
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      {
        input: 500_000,
        output: 50_000,
        cacheRead: 200_000,
        cacheWrite: 100_000,
      },
    );

    expect(cost).toBe(2.9535);
  });

  it("estimates blended model cost when only total tokens are known", () => {
    expect(estimateCostUsdFromModelTokens("openai", "gpt-5.4", 1_000_000)).toBe(
      8.75,
    );
    expect(
      estimateCostUsdFromModelTokens(
        "anthropic",
        "us.anthropic.claude-sonnet-4-6",
        1_000_000,
      ),
    ).toBe(9.9);
    expect(
      estimateCostUsdFromModelTokens(
        "anthropic",
        "anthropic.claude-sonnet-4-6",
        1_000_000,
      ),
    ).toBe(9.9);
    expect(
      estimateCostUsdFromModelTokens(
        "anthropic",
        "global.anthropic.claude-sonnet-4-6",
        1_000_000,
      ),
    ).toBe(9);
    expect(
      estimateCostUsdFromModelTokens(
        "anthropic",
        "claude-sonnet-4-6",
        1_000_000,
      ),
    ).toBe(9);
    expect(
      estimateCostUsdFromModelTokens(
        "anthropic",
        "us.anthropic.claude-sonnet-5",
        1_000_000,
      ),
    ).toBe(9.9);
    expect(
      estimateCostUsdFromModelTokens(
        "anthropic",
        "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        1_000_000,
      ),
    ).toBe(3.3);
    expect(calculateLegacyEstimatedCost(1_000_000)).toBe(8);
  });

  it("prices Claude Opus 4.7 Bedrock inference profile", () => {
    const cost = calculateUsageCostUsd(
      "anthropic",
      "us.anthropic.claude-opus-4-7",
      {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 200_000,
        cacheWrite: 50_000,
      },
    );

    // Regional Bedrock pricing is 10% above global: 1M input*$5.50 + 0.1M output*$27.50 + 0.2M cacheRead*$0.55 + 0.05M cacheWrite*$6.875
    expect(cost).toBe(8.70375);
    expect(cost).not.toBeNull();
  });

  it("prices Claude Opus 4.8 Bedrock inference profile", () => {
    expect(
      calculateUsageCostUsd("anthropic", "us.anthropic.claude-opus-4-8", {
        input: 1_000_000,
        output: 100_000,
      }),
    ).toBe(8.25);

    expect(
      estimateCostUsdFromModelTokens(
        "anthropic",
        "global.anthropic.claude-opus-4-8",
        1_000_000,
      ),
    ).toBe(15);
  });

  it("returns detailed regional Claude Sonnet 5 cost components", () => {
    const breakdown = calculateUsageCostBreakdown(
      "anthropic",
      "us.anthropic.claude-sonnet-5",
      {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 200_000,
        cacheWrite: 50_000,
      },
    );

    expect(breakdown).toMatchObject({
      costUsd: 5.22225,
      inputCostUsd: 3.3,
      outputCostUsd: 1.65,
      cacheReadCostUsd: 0.066,
      cacheWriteCostUsd: 0.20625,
      pricing: {
        inputUsdPerMillion: 3.3,
        outputUsdPerMillion: 16.5,
        cacheReadUsdPerMillion: 0.33,
        cacheWriteUsdPerMillion: 4.125,
      },
    });
  });

  it("returns detailed regional Claude Haiku 4.5 cost components", () => {
    const breakdown = calculateUsageCostBreakdown(
      "anthropic",
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 200_000,
        cacheWrite: 50_000,
      },
    );

    expect(breakdown).toMatchObject({
      costUsd: 1.74075,
      inputCostUsd: 1.1,
      outputCostUsd: 0.55,
      cacheReadCostUsd: 0.022,
      cacheWriteCostUsd: 0.06875,
      pricing: {
        inputUsdPerMillion: 1.1,
        outputUsdPerMillion: 5.5,
        cacheReadUsdPerMillion: 0.11,
        cacheWriteUsdPerMillion: 1.375,
      },
    });
  });

  it("returns detailed regional Claude Opus 4.8 cost components", () => {
    const breakdown = calculateUsageCostBreakdown(
      "anthropic",
      "us.anthropic.claude-opus-4-8",
      {
        input: 1_000_000,
        output: 100_000,
        cacheRead: 200_000,
        cacheWrite: 50_000,
      },
    );

    expect(breakdown).toMatchObject({
      costUsd: 8.70375,
      inputCostUsd: 5.5,
      outputCostUsd: 2.75,
      cacheReadCostUsd: 0.11,
      cacheWriteCostUsd: 0.34375,
      pricing: {
        inputUsdPerMillion: 5.5,
        outputUsdPerMillion: 27.5,
        cacheReadUsdPerMillion: 0.55,
        cacheWriteUsdPerMillion: 6.875,
      },
    });
  });
});
