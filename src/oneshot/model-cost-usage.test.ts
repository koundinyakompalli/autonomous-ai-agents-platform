import { describe, expect, it } from "vitest";

import {
  buildModelCostUsage,
  mergeModelCostUsage,
} from "./model-cost-usage.js";

describe("model cost usage", () => {
  it("builds exact single-model cost usage from SDK call metrics", () => {
    const usage = buildModelCostUsage(
      {
        tokensUsed: {
          input: 1_000_000,
          output: 100_000,
          cacheRead: 200_000,
          cacheWrite: 50_000,
        },
        costUsd: 1.74075,
        modelUsed: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      "planner_scouts",
    );

    expect(usage).toMatchObject({
      total_cost_usd: 1.74075,
      exact_total_cost_usd: true,
      unallocated_cost_usd: 0,
      models: {
        "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cache_read_tokens: 200_000,
          cache_write_tokens: 50_000,
          cost_usd: 1.74075,
          exact_cost_usd: true,
          source: "planner_scouts",
          pricing: {
            input_usd_per_mtok: 1.1,
            output_usd_per_mtok: 5.5,
            cache_read_usd_per_mtok: 0.11,
            cache_write_usd_per_mtok: 1.375,
          },
        },
      },
    });
  });

  it("marks native mixed-model cost split as estimated while keeping exact total", () => {
    const usage = buildModelCostUsage(
      {
        costUsd: 9,
        modelUsed: "us.anthropic.claude-opus-4-8",
        modelUsage: {
          "us.anthropic.claude-opus-4-8": {
            input: 1_000_000,
            output: 100_000,
          },
          "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
            input: 100_000,
            output: 10_000,
          },
        },
      },
      "planner_main",
      { mixedModelNote: "native_agent_mixed_model_cost_estimated" },
    );

    expect(usage).toMatchObject({
      total_cost_usd: 9,
      exact_total_cost_usd: true,
      notes: [
        "native_agent_mixed_model_cost_estimated",
        "model_cost_unallocated_delta",
      ],
      models: {
        "us.anthropic.claude-opus-4-8": expect.objectContaining({
          cost_usd: 8.25,
          exact_cost_usd: false,
        }),
        "us.anthropic.claude-haiku-4-5-20251001-v1:0":
          expect.objectContaining({
            cost_usd: 0.165,
            exact_cost_usd: false,
          }),
      },
      unallocated_cost_usd: 0.585,
    });
  });

  it("marks single-model cost as estimated when SDK total cost was unavailable", () => {
    const usage = buildModelCostUsage(
      {
        tokensUsed: {
          input: 1_000_000,
          output: 100_000,
          cacheRead: 200_000,
          cacheWrite: 50_000,
        },
        costUsd: 1.74075,
        costUsdExact: false,
        modelUsed: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      "planner_scouts",
    );

    expect(usage).toMatchObject({
      total_cost_usd: 1.74075,
      exact_total_cost_usd: false,
      models: {
        "us.anthropic.claude-haiku-4-5-20251001-v1:0":
          expect.objectContaining({
            cost_usd: 1.74075,
            exact_cost_usd: false,
          }),
      },
    });
  });

  it("ignores zero modelUsage rows and attributes exact cost to configured model tokens", () => {
    const usage = buildModelCostUsage(
      {
        tokensUsed: {
          input: 1_624,
          output: 23_369,
          cacheRead: 509_981,
          cacheWrite: 139_884,
        },
        costUsd: 0.7992,
        modelUsed: "us.anthropic.claude-opus-4-8",
        modelUsage: {
          "us.anthropic.claude-opus-4-8": {
            input: 0,
            output: 0,
          },
          "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
            input: 0,
            output: 0,
          },
        },
      },
      "planner_main",
      { mixedModelNote: "native_agent_mixed_model_cost_estimated" },
    );

    expect(usage).toMatchObject({
      total_cost_usd: 0.7992,
      exact_total_cost_usd: true,
      unallocated_cost_usd: 0,
      notes: ["model_usage_zero_rows_ignored"],
      models: {
        "us.anthropic.claude-opus-4-8": {
          input_tokens: 1_624,
          output_tokens: 23_369,
          cache_read_tokens: 509_981,
          cache_write_tokens: 139_884,
          cost_usd: 0.7992,
          exact_cost_usd: true,
          source: "planner_main",
        },
      },
    });
  });

  it("drops zero modelUsage rows before estimating a true mixed-model split", () => {
    const usage = buildModelCostUsage(
      {
        costUsd: 8.5,
        modelUsed: "us.anthropic.claude-opus-4-8",
        modelUsage: {
          "us.anthropic.claude-opus-4-8": {
            input: 1_000_000,
            output: 100_000,
          },
          "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
            input: 100_000,
            output: 10_000,
          },
          "us.anthropic.claude-sonnet-4-6": {
            input: 0,
            output: 0,
          },
        },
      },
      "planner_main",
      { mixedModelNote: "native_agent_mixed_model_cost_estimated" },
    );

    expect(usage).toMatchObject({
      total_cost_usd: 8.5,
      exact_total_cost_usd: true,
      notes: [
        "model_usage_zero_rows_ignored",
        "native_agent_mixed_model_cost_estimated",
        "model_cost_unallocated_delta",
      ],
      models: {
        "us.anthropic.claude-opus-4-8": expect.objectContaining({
          input_tokens: 1_000_000,
          output_tokens: 100_000,
          cost_usd: 8.25,
          exact_cost_usd: false,
        }),
        "us.anthropic.claude-haiku-4-5-20251001-v1:0":
          expect.objectContaining({
            input_tokens: 100_000,
            output_tokens: 10_000,
            cost_usd: 0.165,
            exact_cost_usd: false,
          }),
      },
      unallocated_cost_usd: 0.085,
    });
    expect(
      usage?.models["us.anthropic.claude-sonnet-4-6"],
    ).toBeUndefined();
  });

  it("merges model rows and preserves separate sources", () => {
    const workplan = buildModelCostUsage(
      {
        tokensUsed: { input: 1, output: 2 },
        costUsd: 0.003,
        modelUsed: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      "planner_scout_workplan",
    );
    const scouts = buildModelCostUsage(
      {
        tokensUsed: { input: 10, output: 20 },
        costUsd: 0.01,
        modelUsed: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      },
      "planner_scouts",
    );

    expect(mergeModelCostUsage(workplan, scouts)).toMatchObject({
      total_cost_usd: 0.013,
      exact_total_cost_usd: true,
      models: {
        "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
          input_tokens: 11,
          output_tokens: 22,
          cost_usd: 0.013,
          exact_cost_usd: true,
          source: "planner_scout_workplan+planner_scouts",
        },
      },
    });
  });
});
