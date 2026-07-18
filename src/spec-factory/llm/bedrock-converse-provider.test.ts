import { describe, expect, it, vi } from "vitest";
import {
  BedrockConverseProvider,
  type SendBedrockConverse,
} from "./bedrock-converse-provider.js";

describe("BedrockConverseProvider", () => {
  it("uses Converse native structured output and returns token/cost metrics", async () => {
    const send = vi.fn<SendBedrockConverse>().mockResolvedValue({
      output: {
        message: {
          role: "assistant",
          content: [
            {
              text: JSON.stringify({
                action: "answer",
                answer: "done",
              }),
            },
          ],
        },
      },
      stopReason: "end_turn",
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        cacheReadInputTokens: 10,
        cacheWriteInputTokens: 5,
      },
      metrics: { latencyMs: 8 },
      $metadata: {},
    });
    const provider = new BedrockConverseProvider({ send });
    const jsonSchema = {
      type: "object",
      properties: {
        action: { const: "answer" },
        answer: { type: "string" },
      },
      required: ["action", "answer"],
      additionalProperties: false,
    };

    await expect(
      provider.invoke({
        purpose: "chat_coordinator_fast",
        requestId: "request-1",
        model: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        prompt: "Answer directly.",
        system: "Be concise.",
        cacheSystem: true,
        cacheTtl: "1h",
        jsonSchema,
        maxOutputTokens: 1000,
        timeoutMs: 15_000,
      }),
    ).resolves.toMatchObject({
      success: true,
      output: '{"action":"answer","answer":"done"}',
      structuredOutput: { action: "answer", answer: "done" },
      metrics: {
        toolCalls: 0,
        modelUsed: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
        tokensUsed: {
          input: 100,
          output: 20,
          cacheRead: 10,
          cacheWrite: 5,
        },
        costUsd: expect.any(Number),
      },
    });

    const command = send.mock.calls[0]?.[0];
    expect(command?.input).toMatchObject({
      modelId: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
      system: [
        { text: "Be concise." },
        { cachePoint: { type: "default", ttl: "1h" } },
      ],
      messages: [{ role: "user", content: [{ text: "Answer directly." }] }],
      inferenceConfig: { maxTokens: 1000 },
      outputConfig: {
        textFormat: {
          type: "json_schema",
          structure: {
            jsonSchema: {
              schema: JSON.stringify(jsonSchema),
              name: "spec_factory_chat_coordinator_fast",
            },
          },
        },
      },
      requestMetadata: {
        spec_factory_purpose: "chat_coordinator_fast",
        spec_factory_request_id: "request-1",
      },
    });
    expect(send.mock.calls[0]?.[1]?.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("rejects malformed structured output", async () => {
    const send = vi.fn<SendBedrockConverse>().mockResolvedValue({
      output: {
        message: {
          role: "assistant",
          content: [{ text: "not-json" }],
        },
      },
      stopReason: "end_turn",
      usage: undefined,
      metrics: undefined,
      $metadata: {},
    });
    const provider = new BedrockConverseProvider({ send });

    await expect(
      provider.invoke({
        purpose: "chat_coordinator_fast",
        requestId: "request-2",
        model: "model",
        prompt: "Answer.",
        jsonSchema: { type: "object" },
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("llm_gateway_invalid_structured_output");
  });

  it("rejects an empty provider response", async () => {
    const send = vi.fn<SendBedrockConverse>().mockResolvedValue({
      output: {
        message: { role: "assistant", content: [] },
      },
      stopReason: "end_turn",
      usage: undefined,
      metrics: undefined,
      $metadata: {},
    });
    const provider = new BedrockConverseProvider({ send });

    await expect(
      provider.invoke({
        purpose: "conversation_summary",
        requestId: "request-3",
        model: "model",
        prompt: "Summarize.",
        timeoutMs: 1000,
      }),
    ).rejects.toThrow("llm_gateway_missing_provider_output");
  });
});
