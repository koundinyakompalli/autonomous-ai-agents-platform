import { createLogger } from "../utils/logger.js";

const logger = createLogger("oneshot-pricing");

export interface OneShotTokenUsage {
  input?: number;
  output?: number;
  cachedInput?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

type KnownProvider = "openai" | "anthropic";

export interface ModelPricing {
  provider: KnownProvider;
  aliases: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
  cacheReadUsdPerMillion?: number;
  cacheWriteUsdPerMillion?: number;
  blendedUsdPerMillion: number;
}

export interface OneShotUsageCostBreakdown {
  costUsd: number;
  inputCostUsd: number;
  outputCostUsd: number;
  cachedInputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  pricing: {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
    cachedInputUsdPerMillion?: number;
    cacheReadUsdPerMillion?: number;
    cacheWriteUsdPerMillion?: number;
  };
}

const UNKNOWN_PRICING_KEYS = new Set<string>();

const CLAUDE_REGIONAL_PREFIXES = ["us", "eu", "au", "jp"] as const;
const CLAUDE_GLOBAL_PREFIX = "global";

function claudeAliases(
  family: "haiku" | "sonnet" | "opus",
  version: string,
  suffixes: readonly string[] = [""],
): { global: string[]; regional: string[] } {
  const bases = suffixes.map((suffix) => `claude-${family}-${version}${suffix}`);
  const global: string[] = [];
  const regional: string[] = [];

  for (const base of bases) {
    global.push(
      base,
      `${CLAUDE_GLOBAL_PREFIX}.anthropic.${base}`,
    );
    regional.push(
      `anthropic.${base}`,
      ...CLAUDE_REGIONAL_PREFIXES.map((prefix) => `${prefix}.anthropic.${base}`),
    );
  }

  return { global, regional };
}

function claudePricing(inputUsdPerMillion: number, outputUsdPerMillion: number) {
  return {
    inputUsdPerMillion,
    outputUsdPerMillion,
    cacheReadUsdPerMillion: inputUsdPerMillion * 0.1,
    cacheWriteUsdPerMillion: inputUsdPerMillion * 1.25,
    blendedUsdPerMillion: (inputUsdPerMillion + outputUsdPerMillion) / 2,
  };
}

function regionalClaudePricing(
  inputUsdPerMillion: number,
  outputUsdPerMillion: number,
) {
  return claudePricing(inputUsdPerMillion * 1.1, outputUsdPerMillion * 1.1);
}

const sonnet45Aliases = claudeAliases("sonnet", "4-5", [
  "",
  "-20250929-v1:0",
]);
const sonnet46Aliases = claudeAliases("sonnet", "4-6");
const sonnet5Aliases = claudeAliases("sonnet", "5");
const haiku45Aliases = claudeAliases("haiku", "4-5", [
  "",
  "-20251001-v1:0",
]);
const opus46Aliases = claudeAliases("opus", "4-6", ["", "-v1"]);
const opus47Aliases = claudeAliases("opus", "4-7", ["", "-v1"]);
const opus48Aliases = claudeAliases("opus", "4-8");

const MODEL_PRICING: readonly ModelPricing[] = [
  {
    provider: "openai",
    aliases: ["gpt-5.4", "openai/gpt-5.4"],
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 15,
    cachedInputUsdPerMillion: 0.25,
    blendedUsdPerMillion: 8.75,
  },
  {
    provider: "openai",
    aliases: ["gpt-5.5", "openai/gpt-5.5"],
    inputUsdPerMillion: 5,
    outputUsdPerMillion: 30,
    cachedInputUsdPerMillion: 0.5,
    blendedUsdPerMillion: 17.5,
  },
  {
    provider: "openai",
    aliases: ["gpt-5.6-luna", "openai/gpt-5.6-luna"],
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 6,
    cachedInputUsdPerMillion: 0.1,
    cacheWriteUsdPerMillion: 1.25,
    blendedUsdPerMillion: 3.5,
  },
  {
    provider: "openai",
    aliases: ["gpt-5.6-terra", "openai/gpt-5.6-terra"],
    inputUsdPerMillion: 2.5,
    outputUsdPerMillion: 15,
    cachedInputUsdPerMillion: 0.25,
    cacheWriteUsdPerMillion: 3.125,
    blendedUsdPerMillion: 8.75,
  },
  {
    provider: "anthropic",
    aliases: sonnet45Aliases.regional,
    ...regionalClaudePricing(3, 15),
  },
  {
    provider: "anthropic",
    aliases: sonnet45Aliases.global,
    ...claudePricing(3, 15),
  },
  {
    provider: "anthropic",
    aliases: sonnet46Aliases.regional,
    ...regionalClaudePricing(3, 15),
  },
  {
    provider: "anthropic",
    aliases: sonnet46Aliases.global,
    ...claudePricing(3, 15),
  },
  {
    provider: "anthropic",
    aliases: sonnet5Aliases.regional,
    ...regionalClaudePricing(3, 15),
  },
  {
    provider: "anthropic",
    aliases: sonnet5Aliases.global,
    ...claudePricing(3, 15),
  },
  {
    provider: "anthropic",
    aliases: haiku45Aliases.regional,
    ...regionalClaudePricing(1, 5),
  },
  {
    provider: "anthropic",
    aliases: haiku45Aliases.global,
    ...claudePricing(1, 5),
  },
  {
    provider: "anthropic",
    aliases: opus46Aliases.regional,
    ...regionalClaudePricing(5, 25),
  },
  {
    provider: "anthropic",
    aliases: opus46Aliases.global,
    ...claudePricing(5, 25),
  },
  {
    provider: "anthropic",
    aliases: opus47Aliases.regional,
    ...regionalClaudePricing(5, 25),
  },
  {
    provider: "anthropic",
    aliases: opus47Aliases.global,
    ...claudePricing(5, 25),
  },
  {
    provider: "anthropic",
    aliases: opus48Aliases.regional,
    ...regionalClaudePricing(5, 25),
  },
  {
    provider: "anthropic",
    aliases: opus48Aliases.global,
    ...claudePricing(5, 25),
  },
] as const;

export const LEGACY_COST_PER_MILLION_TOKENS = 8;

function roundUsd(value: number): number {
  return Number(value.toFixed(6));
}

function normalizeProvider(
  provider: string | null | undefined,
  model: string | null | undefined,
): KnownProvider | null {
  const normalizedProvider = provider?.trim().toLowerCase();
  if (normalizedProvider === "openai" || normalizedProvider === "anthropic") {
    return normalizedProvider;
  }

  const normalizedModel = model?.trim().toLowerCase() ?? "";
  if (normalizedModel.includes("gpt-")) {
    return "openai";
  }
  if (normalizedModel.includes("claude")) {
    return "anthropic";
  }

  return null;
}

export function resolveModelPricing(
  provider: string | null | undefined,
  model: string | null | undefined,
): ModelPricing | null {
  const normalizedProvider = normalizeProvider(provider, model);
  const normalizedModel = model?.trim().toLowerCase() ?? "";
  if (!normalizedProvider || !normalizedModel) {
    return null;
  }

  const pricing =
    MODEL_PRICING.find(
      (entry) =>
        entry.provider === normalizedProvider &&
        entry.aliases.some((alias) => {
          const normalizedAlias = alias.toLowerCase();
          return (
            normalizedModel === normalizedAlias ||
            normalizedModel.startsWith(`${normalizedAlias}:`) ||
            normalizedModel.startsWith(`${normalizedAlias}-`)
          );
        }),
    ) ?? null;

  if (!pricing) {
    const key = `${normalizedProvider}:${normalizedModel}`;
    if (!UNKNOWN_PRICING_KEYS.has(key)) {
      UNKNOWN_PRICING_KEYS.add(key);
      logger.warn(
        { provider: normalizedProvider, model: normalizedModel },
        "Unknown OneShot pricing model; falling back to estimation heuristics",
      );
    }
  }

  return pricing;
}

export function calculateLegacyEstimatedCost(totalTokens: number): number {
  return roundUsd((totalTokens / 1_000_000) * LEGACY_COST_PER_MILLION_TOKENS);
}

export function calculateUsageCostUsd(
  provider: string | null | undefined,
  model: string | null | undefined,
  usage: OneShotTokenUsage | null | undefined,
): number | null {
  return calculateUsageCostBreakdown(provider, model, usage)?.costUsd ?? null;
}

export function calculateUsageCostBreakdown(
  provider: string | null | undefined,
  model: string | null | undefined,
  usage: OneShotTokenUsage | null | undefined,
): OneShotUsageCostBreakdown | null {
  if (!usage) {
    return null;
  }

  const pricing = resolveModelPricing(provider, model);
  if (!pricing) {
    return null;
  }

  const input = Math.max(usage.input ?? 0, 0);
  const output = Math.max(usage.output ?? 0, 0);
  const cachedInput = Math.min(Math.max(usage.cachedInput ?? 0, 0), input);
  const cacheRead = Math.max(usage.cacheRead ?? 0, 0);
  const cacheWrite = Math.max(usage.cacheWrite ?? 0, 0);
  // OpenAI reports cache-write tokens as part of input_tokens, while Bedrock
  // reports cache-write usage separately from input tokens.
  const embeddedCacheWrite =
    normalizeProvider(provider, model) === "openai"
      ? Math.min(cacheWrite, Math.max(input - cachedInput, 0))
      : 0;
  const uncachedInput = Math.max(
    input - cachedInput - embeddedCacheWrite,
    0,
  );

  const cachedInputRate =
    pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
  const cacheReadRate =
    pricing.cacheReadUsdPerMillion ?? pricing.inputUsdPerMillion;
  const cacheWriteRate =
    pricing.cacheWriteUsdPerMillion ?? pricing.inputUsdPerMillion;

  const inputCostUsd = roundUsd(
    (uncachedInput / 1_000_000) * pricing.inputUsdPerMillion,
  );
  const outputCostUsd = roundUsd(
    (output / 1_000_000) * pricing.outputUsdPerMillion,
  );
  const cachedInputCostUsd = roundUsd(
    (cachedInput / 1_000_000) * cachedInputRate,
  );
  const cacheReadCostUsd = roundUsd(
    (cacheRead / 1_000_000) * cacheReadRate,
  );
  const cacheWriteCostUsd = roundUsd(
    (cacheWrite / 1_000_000) * cacheWriteRate,
  );

  return {
    costUsd: roundUsd(
      inputCostUsd +
        outputCostUsd +
        cachedInputCostUsd +
        cacheReadCostUsd +
        cacheWriteCostUsd,
    ),
    inputCostUsd,
    outputCostUsd,
    cachedInputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    pricing: {
      inputUsdPerMillion: roundUsd(pricing.inputUsdPerMillion),
      outputUsdPerMillion: roundUsd(pricing.outputUsdPerMillion),
      ...(pricing.cachedInputUsdPerMillion !== undefined
        ? {
            cachedInputUsdPerMillion: roundUsd(
              pricing.cachedInputUsdPerMillion,
            ),
          }
        : {}),
      ...(pricing.cacheReadUsdPerMillion !== undefined
        ? { cacheReadUsdPerMillion: roundUsd(pricing.cacheReadUsdPerMillion) }
        : {}),
      ...(pricing.cacheWriteUsdPerMillion !== undefined
        ? {
            cacheWriteUsdPerMillion: roundUsd(
              pricing.cacheWriteUsdPerMillion,
            ),
          }
        : {}),
    },
  };
}

export function estimateCostUsdFromModelTokens(
  provider: string | null | undefined,
  model: string | null | undefined,
  totalTokens: number,
): number | null {
  if (totalTokens <= 0) {
    return 0;
  }

  const pricing = resolveModelPricing(provider, model);
  if (!pricing) {
    return null;
  }

  return roundUsd((totalTokens / 1_000_000) * pricing.blendedUsdPerMillion);
}
