import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { calculateUsageCostUsd } from "../../oneshot/pricing.js";
import type { LlmPurpose } from "./llm-gateway.js";

export interface BedrockConverseProviderRequest {
  purpose: LlmPurpose;
  requestId: string;
  model: string;
  prompt: string;
  system?: string;
  cacheSystem?: boolean;
  cacheTtl?: "5m" | "1h";
  jsonSchema?: Record<string, unknown>;
  maxOutputTokens?: number;
  timeoutMs: number;
}

export interface BedrockConverseProviderResult {
  success: true;
  output: string;
  structuredOutput?: unknown;
  metrics: {
    durationMs: number;
    toolCalls: 0;
    modelUsed: string;
    tokensUsed?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    costUsd?: number;
  };
}

export type SendBedrockConverse = (
  command: ConverseCommand,
  options?: { abortSignal?: AbortSignal },
) => Promise<ConverseCommandOutput>;

export interface BedrockConverseProviderOptions {
  region?: string;
  send?: SendBedrockConverse;
}

export const DIRECT_BEDROCK_PROVIDER_NAME = "bedrock_converse";

export class BedrockConverseProvider {
  private readonly send: SendBedrockConverse;

  constructor(options: BedrockConverseProviderOptions = {}) {
    if (options.send) {
      this.send = options.send;
      return;
    }
    const client = new BedrockRuntimeClient({
      region: options.region?.trim() || "us-east-2",
      // The gateway owns bounded retries and audit semantics.
      maxAttempts: 1,
    });
    this.send = (command, requestOptions) =>
      client.send(command, requestOptions);
  }

  async invoke(
    input: BedrockConverseProviderRequest,
  ): Promise<BedrockConverseProviderResult> {
    const startedAt = Date.now();
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), input.timeoutMs);
    let response: ConverseCommandOutput;
    try {
      response = await this.send(
        new ConverseCommand({
          modelId: input.model,
          messages: [
            {
              role: "user",
              content: [{ text: input.prompt }],
            },
          ],
          ...(input.system?.trim()
            ? {
                system: [
                  { text: input.system.trim() },
                  ...(input.cacheSystem
                    ? [
                        {
                          cachePoint: {
                            type: "default" as const,
                            ttl: input.cacheTtl ?? "1h",
                          },
                        },
                      ]
                    : []),
                ],
              }
            : {}),
          ...(input.maxOutputTokens !== undefined
            ? { inferenceConfig: { maxTokens: input.maxOutputTokens } }
            : {}),
          ...(input.jsonSchema
            ? {
                outputConfig: {
                  textFormat: {
                    type: "json_schema",
                    structure: {
                      jsonSchema: {
                        schema: JSON.stringify(input.jsonSchema),
                        name: `spec_factory_${input.purpose}`,
                        description: `Spec Factory ${input.purpose} response`,
                      },
                    },
                  },
                },
              }
            : {}),
          requestMetadata: {
            spec_factory_purpose: input.purpose,
            spec_factory_request_id: input.requestId,
          },
        }),
        { abortSignal: abortController.signal },
      );
    } finally {
      clearTimeout(timeout);
    }

    const output = (response.output?.message?.content ?? [])
      .flatMap((block) => (typeof block.text === "string" ? [block.text] : []))
      .join("")
      .trim();
    if (!output) {
      throw new Error("llm_gateway_missing_provider_output");
    }

    const tokensUsed = tokenUsage(response);
    const costUsd = calculateUsageCostUsd("anthropic", input.model, tokensUsed);
    return {
      success: true,
      output,
      ...(input.jsonSchema
        ? { structuredOutput: parseStructuredOutput(output) }
        : {}),
      metrics: {
        durationMs: Date.now() - startedAt,
        toolCalls: 0,
        modelUsed: input.model,
        ...(tokensUsed ? { tokensUsed } : {}),
        ...(costUsd !== null ? { costUsd } : {}),
      },
    };
  }
}

function tokenUsage(
  response: ConverseCommandOutput,
): BedrockConverseProviderResult["metrics"]["tokensUsed"] | undefined {
  const usage = response.usage;
  if (!usage) return undefined;
  return {
    input: Math.max(0, usage.inputTokens ?? 0),
    output: Math.max(0, usage.outputTokens ?? 0),
    ...(typeof usage.cacheReadInputTokens === "number"
      ? { cacheRead: Math.max(0, usage.cacheReadInputTokens) }
      : {}),
    ...(typeof usage.cacheWriteInputTokens === "number"
      ? { cacheWrite: Math.max(0, usage.cacheWriteInputTokens) }
      : {}),
  };
}

function parseStructuredOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error("llm_gateway_invalid_structured_output");
  }
}
