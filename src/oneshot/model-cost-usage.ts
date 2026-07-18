import type { OneShotModelUsage } from "./model-usage.js";
import {
  calculateUsageCostBreakdown,
  type OneShotTokenUsage,
} from "./pricing.js";

export interface OneShotModelCostUsage {
  total_cost_usd: number;
  exact_total_cost_usd: boolean;
  models: Record<string, OneShotModelCostUsageEntry>;
  unallocated_cost_usd: number;
  notes: string[];
}

export interface OneShotModelCostUsageEntry {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  exact_cost_usd: boolean;
  source: string;
  pricing?: {
    input_usd_per_mtok: number;
    output_usd_per_mtok: number;
    cache_read_usd_per_mtok?: number;
    cache_write_usd_per_mtok?: number;
  };
}

export interface OneShotModelCostUsageInput {
  tokensUsed?: OneShotTokenUsage;
  costUsd?: number;
  costUsdExact?: boolean;
  modelUsed?: string;
  modelUsage?: OneShotModelUsage;
}

const COST_EPSILON = 0.000001;

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function finiteCost(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? roundUsd(value)
    : undefined;
}

function tokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(Math.trunc(value), 0)
    : 0;
}

function pricingFor(model: string, usage: OneShotTokenUsage) {
  const breakdown = calculateUsageCostBreakdown("anthropic", model, usage);
  if (!breakdown) {
    return undefined;
  }
  return {
    costUsd: breakdown.costUsd,
    pricing: {
      input_usd_per_mtok: breakdown.pricing.inputUsdPerMillion,
      output_usd_per_mtok: breakdown.pricing.outputUsdPerMillion,
      ...(breakdown.pricing.cacheReadUsdPerMillion !== undefined
        ? { cache_read_usd_per_mtok: breakdown.pricing.cacheReadUsdPerMillion }
        : {}),
      ...(breakdown.pricing.cacheWriteUsdPerMillion !== undefined
        ? { cache_write_usd_per_mtok: breakdown.pricing.cacheWriteUsdPerMillion }
        : {}),
    },
  };
}

function entryFromUsage(input: {
  model: string;
  source: string;
  usage: OneShotTokenUsage;
  exactCostUsd?: number;
  exactCostAllowed: boolean;
}): OneShotModelCostUsageEntry {
  const calculated = pricingFor(input.model, input.usage);
  const costUsd = input.exactCostUsd ?? calculated?.costUsd ?? 0;
  return {
    input_tokens: tokenCount(input.usage.input),
    output_tokens: tokenCount(input.usage.output),
    cache_read_tokens: tokenCount(input.usage.cacheRead),
    cache_write_tokens: tokenCount(input.usage.cacheWrite),
    cost_usd: roundUsd(costUsd),
    exact_cost_usd:
      input.exactCostAllowed && input.exactCostUsd !== undefined,
    source: input.source,
    ...(calculated?.pricing ? { pricing: calculated.pricing } : {}),
  };
}

function mergeSources(left: string, right: string): string {
  return Array.from(new Set([...left.split("+"), ...right.split("+")]))
    .filter(Boolean)
    .join("+");
}

export function mergeModelCostUsage(
  primary?: OneShotModelCostUsage,
  secondary?: OneShotModelCostUsage,
): OneShotModelCostUsage | undefined {
  if (!primary && !secondary) {
    return undefined;
  }
  if (!primary) {
    return secondary;
  }
  if (!secondary) {
    return primary;
  }

  const models: Record<string, OneShotModelCostUsageEntry> = {
    ...primary.models,
  };
  for (const [model, row] of Object.entries(secondary.models)) {
    const existing = models[model];
    if (!existing) {
      models[model] = row;
      continue;
    }
    models[model] = {
      input_tokens: existing.input_tokens + row.input_tokens,
      output_tokens: existing.output_tokens + row.output_tokens,
      cache_read_tokens:
        existing.cache_read_tokens + row.cache_read_tokens,
      cache_write_tokens:
        existing.cache_write_tokens + row.cache_write_tokens,
      cost_usd: roundUsd(existing.cost_usd + row.cost_usd),
      exact_cost_usd: existing.exact_cost_usd && row.exact_cost_usd,
      source: mergeSources(existing.source, row.source),
      pricing: existing.pricing ?? row.pricing,
    };
  }

  return {
    total_cost_usd: roundUsd(
      primary.total_cost_usd + secondary.total_cost_usd,
    ),
    exact_total_cost_usd:
      primary.exact_total_cost_usd && secondary.exact_total_cost_usd,
    models,
    unallocated_cost_usd: roundUsd(
      primary.unallocated_cost_usd + secondary.unallocated_cost_usd,
    ),
    notes: Array.from(new Set([...primary.notes, ...secondary.notes])),
  };
}

export function buildModelCostUsage(
  metrics: OneShotModelCostUsageInput | undefined,
  source: string,
  options: {
    mixedModelNote?: string;
  } = {},
): OneShotModelCostUsage | undefined {
  if (!metrics) {
    return undefined;
  }

  const exactCostUsd = finiteCost(metrics.costUsd);
  const exactCostProvided =
    exactCostUsd !== undefined && metrics.costUsdExact !== false;
  const rawModelUsageEntries = Object.entries(metrics.modelUsage ?? {});
  const modelUsageEntries = rawModelUsageEntries.filter(
    ([, usage]) => tokenCount(usage.input) > 0 || tokenCount(usage.output) > 0,
  );
  const notes: string[] = [];
  if (rawModelUsageEntries.length > modelUsageEntries.length) {
    notes.push("model_usage_zero_rows_ignored");
  }

  if (modelUsageEntries.length > 1) {
    const models: Record<string, OneShotModelCostUsageEntry> = {};
    let estimatedTotal = 0;
    for (const [model, usage] of modelUsageEntries) {
      const row = entryFromUsage({
        model,
        source,
        usage: {
          input: tokenCount(usage.input),
          output: tokenCount(usage.output),
        },
        exactCostAllowed: false,
      });
      estimatedTotal += row.cost_usd;
      models[model] = row;
    }
    if (options.mixedModelNote) {
      notes.push(options.mixedModelNote);
    }
    const totalCostUsd = exactCostUsd ?? roundUsd(estimatedTotal);
    const unallocatedCostUsd =
      exactCostUsd !== undefined
        ? roundUsd(exactCostUsd - estimatedTotal)
        : 0;
    if (Math.abs(unallocatedCostUsd) > COST_EPSILON) {
      notes.push("model_cost_unallocated_delta");
    }
    return {
      total_cost_usd: totalCostUsd,
      exact_total_cost_usd: exactCostProvided,
      models,
      unallocated_cost_usd: unallocatedCostUsd,
      notes,
    };
  }

  const model =
    modelUsageEntries[0]?.[0] ?? metrics.modelUsed?.trim() ?? "unknown";
  const modelUsage = modelUsageEntries[0]?.[1];
  const usage = metrics.tokensUsed
    ? metrics.tokensUsed
    : {
        input: tokenCount(modelUsage?.input),
        output: tokenCount(modelUsage?.output),
      };
  const row = entryFromUsage({
    model,
    source,
    usage,
    exactCostUsd,
    exactCostAllowed: exactCostProvided,
  });
  if (!row.pricing) {
    notes.push(`model_cost_pricing_unknown:${model}`);
  }
  return {
    total_cost_usd: row.cost_usd,
    exact_total_cost_usd: exactCostProvided,
    models: { [model]: row },
    unallocated_cost_usd: 0,
    notes,
  };
}
