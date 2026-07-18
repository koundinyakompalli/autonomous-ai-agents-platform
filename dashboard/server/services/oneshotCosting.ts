import type mysql from "mysql2/promise";

export type OneShotCostSource = "actual" | "estimated" | "mixed";

export interface DashboardArtifactCostRow extends mysql.RowDataPacket {
  oneshot_run_id: number;
  artifact_stage: string;
  stage_cost_usd: number | string | null;
  stage_tokens_used: number | string | null;
  model: string | null;
  provider: string | null;
}

export interface DisplayCostSummary {
  estimatedCostUsd: number;
  costSource: OneShotCostSource;
}

export interface ModelPricingMetadata {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  blendedUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  sourceModel: string;
}

const UNKNOWN_PRICING_KEYS = new Set<string>();
const LEGACY_COST_PER_MILLION_TOKENS = 8;

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeProvider(
  provider: string | null | undefined,
  model: string | null | undefined,
): "openai" | "anthropic" | null {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === "openai" || normalizedProvider === "anthropic") {
    return normalizedProvider;
  }

  const normalizedModel = model?.trim().toLowerCase() ?? "";
  if (normalizedModel.includes("gpt-")) return "openai";
  if (normalizedModel.includes("claude")) return "anthropic";
  return null;
}

function coerceFiniteNumber(
  value: number | string | null | undefined,
): number | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function isRegionalClaudeModel(model: string): boolean {
  return (
    /(?:^|[/.])(us|eu|au|jp)\.anthropic\.claude-/.test(model) ||
    /(?:^|[/])anthropic\.claude-/.test(model)
  );
}

function isGlobalClaudeModel(model: string): boolean {
  return /(?:^|[/.])global\.anthropic\.claude-/.test(model);
}

function claudeBlendedUsdPerMillion(model: string): number | null {
  const regionalMultiplier =
    isRegionalClaudeModel(model) && !isGlobalClaudeModel(model) ? 1.1 : 1;
  if (model.includes("claude-haiku-4-5")) return 3 * regionalMultiplier;
  if (model.includes("claude-sonnet-4-5")) return 9 * regionalMultiplier;
  if (model.includes("claude-sonnet-4-6")) return 9 * regionalMultiplier;
  if (model.includes("claude-sonnet-5")) return 9 * regionalMultiplier;
  if (model.includes("claude-opus-4-6")) return 15 * regionalMultiplier;
  if (model.includes("claude-opus-4-7")) return 15 * regionalMultiplier;
  if (model.includes("claude-opus-4-8")) return 15 * regionalMultiplier;
  return null;
}

function claudeUsagePriceUsdPerMillion(
  model: string,
): { input: number; output: number } | null {
  const regionalMultiplier =
    isRegionalClaudeModel(model) && !isGlobalClaudeModel(model) ? 1.1 : 1;
  if (model.includes("claude-haiku-4-5")) {
    return { input: 1 * regionalMultiplier, output: 5 * regionalMultiplier };
  }
  if (
    model.includes("claude-sonnet-4-5") ||
    model.includes("claude-sonnet-4-6") ||
    model.includes("claude-sonnet-5")
  ) {
    return { input: 3 * regionalMultiplier, output: 15 * regionalMultiplier };
  }
  if (
    model.includes("claude-opus-4-6") ||
    model.includes("claude-opus-4-7") ||
    model.includes("claude-opus-4-8")
  ) {
    return { input: 5 * regionalMultiplier, output: 25 * regionalMultiplier };
  }
  return null;
}

function resolveBlendedUsdPerMillion(
  provider: string | null | undefined,
  model: string | null | undefined,
): number | null {
  const normalizedProvider = normalizeProvider(provider, model);
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }

  const blended =
    normalizedProvider === "openai" && normalizedModel.includes("gpt-5.4")
      ? 8.75
      : normalizedProvider === "anthropic"
        ? claudeBlendedUsdPerMillion(normalizedModel)
        : null;

  if (blended === null) {
    const key = `${normalizedProvider}:${normalizedModel}`;
    if (!UNKNOWN_PRICING_KEYS.has(key)) {
      UNKNOWN_PRICING_KEYS.add(key);
      console.warn(
        `[oneshot-costing] Unknown pricing model: provider=${normalizedProvider} model=${normalizedModel}`,
      );
    }
  }

  return blended;
}

export function resolveModelPricingMetadata(
  provider: string | null | undefined,
  model: string | null | undefined,
): ModelPricingMetadata | null {
  const normalizedProvider = normalizeProvider(provider, model);
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }

  if (normalizedProvider === "openai" && normalizedModel.includes("gpt-5.4")) {
    return {
      inputUsdPerMillion: 2.5,
      outputUsdPerMillion: 15,
      cachedInputUsdPerMillion: 0.25,
      blendedUsdPerMillion: 8.75,
      sourceModel: model?.trim() ?? "gpt-5.4",
    };
  }

  if (normalizedProvider !== "anthropic") {
    return null;
  }

  const usagePricing = claudeUsagePriceUsdPerMillion(normalizedModel);
  const blendedUsdPerMillion = claudeBlendedUsdPerMillion(normalizedModel);
  if (!usagePricing || blendedUsdPerMillion === null) {
    return null;
  }

  return {
    inputUsdPerMillion: roundUsd(usagePricing.input),
    outputUsdPerMillion: roundUsd(usagePricing.output),
    cacheReadUsdPerMillion: roundUsd(usagePricing.input * 0.1),
    cacheWriteUsdPerMillion: roundUsd(usagePricing.input * 1.25),
    blendedUsdPerMillion: roundUsd(blendedUsdPerMillion),
    sourceModel: model?.trim() ?? normalizedModel,
  };
}

export function calculateLegacyEstimatedCost(totalTokens: number): number {
  return roundUsd((totalTokens / 1_000_000) * LEGACY_COST_PER_MILLION_TOKENS);
}

export function estimateCostUsdFromArtifact(
  provider: string | null | undefined,
  model: string | null | undefined,
  totalTokens: number,
): number | null {
  if (totalTokens <= 0) {
    return 0;
  }

  const blendedUsdPerMillion = resolveBlendedUsdPerMillion(provider, model);
  if (blendedUsdPerMillion === null) {
    return null;
  }

  return roundUsd((totalTokens / 1_000_000) * blendedUsdPerMillion);
}

export function estimateCostUsdFromModelUsage(
  provider: string | null | undefined,
  model: string | null | undefined,
  usage: { input: number; output: number },
): number | null {
  const normalizedProvider = normalizeProvider(provider, model);
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }

  if (normalizedProvider === "openai" && normalizedModel.includes("gpt-5.4")) {
    return roundUsd(
      (usage.input / 1_000_000) * 2.5 +
        (usage.output / 1_000_000) * 15,
    );
  }
  if (normalizedProvider !== "anthropic") {
    return null;
  }

  const pricing = claudeUsagePriceUsdPerMillion(normalizedModel);
  if (!pricing) {
    return null;
  }

  return roundUsd(
    (usage.input / 1_000_000) * pricing.input +
      (usage.output / 1_000_000) * pricing.output,
  );
}

export function resolveArtifactCostContribution(
  row: DashboardArtifactCostRow,
): { usd: number; source: "actual" | "estimated" } | null {
  const actualCost = coerceFiniteNumber(row.stage_cost_usd);
  if (actualCost !== null) {
    return {
      usd: roundUsd(actualCost),
      source: "actual",
    };
  }

  const modelEstimate = estimateCostUsdFromArtifact(
    row.provider,
    row.model,
    coerceFiniteNumber(row.stage_tokens_used) ?? 0,
  );
  if (modelEstimate !== null) {
    return {
      usd: modelEstimate,
      source: "estimated",
    };
  }

  const stageTokens = coerceFiniteNumber(row.stage_tokens_used) ?? 0;
  if (stageTokens > 0) {
    return {
      usd: calculateLegacyEstimatedCost(stageTokens),
      source: "estimated",
    };
  }

  return null;
}

/**
 * Deterministic plan-contract guardrail rows are recorded with a $0.00
 * "actual" cost so they never contribute to LLM spend or model attribution,
 * and must not flip a run's cost source to "mixed". Scoped narrowly to the
 * plan-contract identifier/provider so genuine deterministic timeline rows
 * (e.g. provider "deterministic", model "trace-port"/"verify-port") are
 * unaffected.
 */
export function isDeterministicGuardrailRow(
  provider: string | null | undefined,
  model: string | null | undefined,
): boolean {
  const normalizedProvider = provider?.trim().toLowerCase() ?? null;
  const normalizedModel = model?.trim().toLowerCase() ?? null;
  return (
    normalizedModel === "plan-contract-v1" ||
    normalizedProvider === "deterministic_guardrail"
  );
}

export function mergeCostSources(
  sources: Iterable<OneShotCostSource>,
): OneShotCostSource {
  let sawActual = false;
  let sawEstimated = false;
  for (const source of sources) {
    if (source === "actual") sawActual = true;
    if (source === "estimated") sawEstimated = true;
    if (source === "mixed") {
      sawActual = true;
      sawEstimated = true;
    }
  }

  if (sawActual && sawEstimated) return "mixed";
  if (sawActual) return "actual";
  return "estimated";
}

export function aggregateArtifactCostsByRun(
  rows: readonly DashboardArtifactCostRow[],
): Map<number, DisplayCostSummary> {
  const summaries = new Map<
    number,
    { usd: number; actualCount: number; estimatedCount: number }
  >();

  for (const row of rows) {
    // Zero-cost deterministic guardrail rows must not affect cost-source labeling.
    if (isDeterministicGuardrailRow(row.provider, row.model)) {
      continue;
    }
    const contribution = resolveArtifactCostContribution(row);
    if (!contribution) {
      continue;
    }

    const existing = summaries.get(row.oneshot_run_id) ?? {
      usd: 0,
      actualCount: 0,
      estimatedCount: 0,
    };
    existing.usd += contribution.usd;
    if (contribution.source === "actual") {
      existing.actualCount += 1;
    } else {
      existing.estimatedCount += 1;
    }
    summaries.set(row.oneshot_run_id, existing);
  }

  return new Map(
    Array.from(summaries.entries()).map(([runId, summary]) => [
      runId,
      {
        estimatedCostUsd: roundUsd(summary.usd),
        costSource:
          summary.actualCount > 0 && summary.estimatedCount > 0
            ? "mixed"
            : summary.actualCount > 0
              ? "actual"
              : "estimated",
      } satisfies DisplayCostSummary,
    ]),
  );
}

export function buildDisplayCostSummary(
  totalTokensUsed: number,
  artifactSummary?: DisplayCostSummary,
): DisplayCostSummary {
  if (artifactSummary) {
    return artifactSummary;
  }

  return {
    estimatedCostUsd: calculateLegacyEstimatedCost(totalTokensUsed),
    costSource: "estimated",
  };
}
