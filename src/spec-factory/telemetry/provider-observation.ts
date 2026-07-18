import { specFactoryMetrics } from "./metrics.js";

interface ProviderMetrics {
  modelUsed?: string;
  tokensUsed?: { input?: number; output?: number };
  costUsd?: number;
}

export function recordAgentSdkProviderResult(input: {
  purpose: string;
  configuredModel?: string | null;
  startedAt: number;
  result: {
    success: boolean;
    error?: string;
    metrics?: ProviderMetrics;
  };
}): void {
  const error = input.result.error ?? "";
  specFactoryMetrics.recordProviderCall({
    purpose: input.purpose,
    provider: "bedrock",
    model:
      input.result.metrics?.modelUsed || input.configuredModel || "unknown",
    outcome: input.result.success ? "succeeded" : providerFailureOutcome(error),
    latencyMs: Date.now() - input.startedAt,
    inputTokens: input.result.metrics?.tokensUsed?.input,
    outputTokens: input.result.metrics?.tokensUsed?.output,
    costUsd: input.result.metrics?.costUsd,
  });
}

export function recordAgentSdkProviderError(input: {
  purpose: string;
  configuredModel?: string | null;
  startedAt: number;
  error: unknown;
}): void {
  const message =
    input.error instanceof Error ? input.error.message : String(input.error);
  specFactoryMetrics.recordProviderCall({
    purpose: input.purpose,
    provider: "bedrock",
    model: input.configuredModel || "unknown",
    outcome: providerFailureOutcome(message),
    latencyMs: Date.now() - input.startedAt,
  });
}

export function providerFailureOutcome(
  message: string,
): "failed" | "throttled" {
  return /throttl|rate.?limit|too ?many ?requests|\b429\b/i.test(message)
    ? "throttled"
    : "failed";
}
