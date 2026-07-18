import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  ClaudeAgentSdkBedrockLlmGateway,
  createSpecFactoryLlmGateway,
  resolveDirectBedrockPurposes,
  resolveLlmModelRoute,
} from "./llm-gateway.js";

describe("resolveLlmModelRoute", () => {
  it("routes by purpose with a Bedrock provider and default model", () => {
    expect(resolveLlmModelRoute("chat_coordinator_fast", {})).toEqual({
      provider: "bedrock",
      model: "us.anthropic.claude-sonnet-5",
      requireStructuredOutput: true,
    });
  });

  it("honors purpose-specific model overrides before global defaults", () => {
    expect(
      resolveLlmModelRoute("chat_coordinator_fast", {
        env: {
          SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
          SPEC_FACTORY_MODEL_ID: "claude-global",
        },
      }),
    ).toMatchObject({ model: "claude-fast" });
  });

  it("rejects models outside the configured allowlist", () => {
    expect(() =>
      resolveLlmModelRoute("chat_coordinator_fast", {
        env: {
          SPEC_FACTORY_MODEL_ID: "blocked-model",
          SPEC_FACTORY_LLM_MODEL_ALLOWLIST: "allowed-model, another-model",
        },
      }),
    ).toThrow("llm_model_not_allowed:blocked-model");
  });
});

describe("resolveDirectBedrockPurposes", () => {
  it("parses purpose-scoped direct Bedrock routing", () => {
    expect([
      ...resolveDirectBedrockPurposes({
        SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES:
          "chat_coordinator_fast, conversation_summary",
      }),
    ]).toEqual(["chat_coordinator_fast", "conversation_summary"]);
  });

  it("fails startup validation for an unknown purpose", () => {
    expect(() =>
      resolveDirectBedrockPurposes({
        SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES: "unknown",
      }),
    ).toThrow("invalid_llm_direct_bedrock_purpose:unknown");
  });
});

describe("ClaudeAgentSdkBedrockLlmGateway", () => {
  it("routes configured purposes directly to Bedrock without Agent SDK setup", async () => {
    const runAgent = vi.fn();
    const registerRepoFromPath = vi.fn(() => "llm-scratch");
    const directBedrockProvider = {
      invoke: vi.fn().mockResolvedValue({
        success: true,
        output: '{"action":"answer","answer":"direct"}',
        structuredOutput: { action: "answer", answer: "direct" },
        metrics: {
          durationMs: 20,
          toolCalls: 0,
          tokensUsed: { input: 10, output: 5 },
          costUsd: 0.001,
          modelUsed: "claude-fast",
        },
      }),
    };
    const auditSink = { recordCall: vi.fn() };
    const metrics = { recordProviderCall: vi.fn() };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES: "chat_coordinator_fast",
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
      },
      directBedrockProvider,
      registerRepoFromPath,
      auditSink,
      metrics,
    });
    const schema = z.object({
      action: z.literal("answer"),
      answer: z.string(),
    });
    const jsonSchema = {
      type: "object",
      properties: {
        action: { const: "answer" },
        answer: { type: "string" },
      },
      required: ["action", "answer"],
    };
    const directJsonSchema = {
      oneOf: [jsonSchema],
    };

    await expect(
      gateway.generateObject({
        purpose: "chat_coordinator_fast",
        prompt: "Decide.",
        schema,
        jsonSchema,
        directJsonSchema,
        system: "Stable organizational context",
        cacheSystem: true,
        cacheTtl: "1h",
        maxOutputTokens: 1000,
        timeoutMs: 15_000,
      }),
    ).resolves.toEqual({ action: "answer", answer: "direct" });

    expect(directBedrockProvider.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "chat_coordinator_fast",
        model: "claude-fast",
        prompt: "Decide.",
        system: "Stable organizational context",
        cacheSystem: true,
        cacheTtl: "1h",
        jsonSchema: directJsonSchema,
        maxOutputTokens: 1000,
        timeoutMs: 15_000,
      }),
    );
    expect(runAgent).not.toHaveBeenCalled();
    expect(registerRepoFromPath).not.toHaveBeenCalled();
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "bedrock",
        status: "succeeded",
      }),
    );
    expect(metrics.recordProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "bedrock_converse",
        outcome: "succeeded",
      }),
    );
  });

  it("retries direct Bedrock throttles inside the gateway", async () => {
    const directBedrockProvider = {
      invoke: vi
        .fn()
        .mockRejectedValueOnce(
          Object.assign(new Error("Rate exceeded"), {
            name: "ThrottlingException",
            $metadata: { httpStatusCode: 429 },
          }),
        )
        .mockResolvedValue({
          success: true,
          output: "done",
          metrics: {
            durationMs: 10,
            toolCalls: 0,
            modelUsed: "claude-fast",
          },
        }),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(vi.fn() as never, {
      env: {
        SPEC_FACTORY_LLM_DIRECT_BEDROCK_PURPOSES: "conversation_summary",
        SPEC_FACTORY_LLM_MODEL_CONVERSATION_SUMMARY: "claude-fast",
      },
      directBedrockProvider,
      maxAttempts: 2,
      retryBaseMs: 0,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).resolves.toMatchObject({ text: "done", modelUsed: "claude-fast" });
    expect(directBedrockProvider.invoke).toHaveBeenCalledTimes(2);
  });

  it("generates typed objects through the Bedrock-backed SDK runner with tools disabled", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: JSON.stringify({ action: "answer", answer: "Use retryOnce." }),
      structuredOutput: { action: "answer", answer: "Use retryOnce." },
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 12, output: 8 },
        costUsd: 0.01,
        modelUsed: "claude-fast",
      },
    });
    const registerRepoFromPath = vi.fn(() => "llm-scratch");
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
      },
      registerRepoFromPath,
    });
    const schema = z.object({
      action: z.literal("answer"),
      answer: z.string(),
    });
    const jsonSchema = {
      type: "object",
      properties: {
        action: { const: "answer" },
        answer: { type: "string" },
      },
      required: ["action", "answer"],
    };

    await expect(
      gateway.generateObject({
        purpose: "chat_coordinator_fast",
        prompt: "Decide how to answer the user.",
        schema,
        jsonSchema,
        maxCostUsd: 0.25,
        timeoutMs: 15_000,
      }),
    ).resolves.toEqual({ action: "answer", answer: "Use retryOnce." });

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: expect.stringMatching(
          /^spec-factory-llm-chat_coordinator_fast-/,
        ),
        taskPrompt: "Decide how to answer the user.",
        repoIds: ["llm-scratch"],
        agentType: "custom",
        sdkStage: "spec_factory_llm_chat_coordinator_fast",
        permissionLevel: "read_only",
        allowWrite: false,
        disableTools: true,
        allowedTools: [],
        settingSources: [],
        thinking: { type: "disabled" },
        outputSchema: jsonSchema,
        maxBudgetUsd: 0.25,
        timeoutMs: 15_000,
        bedrockConfig: {
          region: "us-east-2",
          model: "claude-fast",
        },
      }),
    );
    expect(registerRepoFromPath).toHaveBeenCalledWith(
      "/tmp",
      "spec-factory-llm-scratch",
    );
  });

  it("records successful gateway calls in the audit sink", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Plain answer",
      metrics: {
        durationMs: 111,
        toolCalls: 0,
        tokensUsed: { input: 12, output: 8 },
        costUsd: 0.012345,
        modelUsed: "claude-fast",
      },
    });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(44),
    };
    const metrics = { recordProviderCall: vi.fn() };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
      },
      auditSink,
      metrics,
    });

    await gateway.generateText({
      sessionId: 7,
      turnJobId: 101,
      purpose: "chat_coordinator_fast",
      prompt: "Answer from context.",
      promptVersion: "chat_coordinator@v1",
      contextVersionUsed: 4,
    });

    expect(auditSink.recordCall).toHaveBeenCalledWith({
      sessionId: 7,
      turnJobId: 101,
      agentTaskId: null,
      requestId: null,
      purpose: "chat_coordinator_fast",
      provider: "bedrock",
      model: "claude-fast",
      promptVersion: "chat_coordinator@v1",
      contextVersionUsed: 4,
      inputTokens: 12,
      outputTokens: 8,
      latencyMs: expect.any(Number),
      estimatedCostUsd: 0.012345,
      status: "succeeded",
      errorCode: null,
      redactedPromptUri: null,
      redactedResponseUri: null,
    });
    expect(metrics.recordProviderCall).toHaveBeenCalledWith({
      purpose: "chat_coordinator_fast",
      provider: "bedrock",
      model: "claude-fast",
      outcome: "succeeded",
      latencyMs: expect.any(Number),
      inputTokens: 12,
      outputTokens: 8,
      costUsd: 0.012345,
    });
  });

  it("normalizes text generation into a stream of text and done events", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Streaming fallback answer",
      metrics: {
        durationMs: 111,
        toolCalls: 0,
        tokensUsed: { input: 12, output: 8 },
        costUsd: 0.012345,
        modelUsed: "claude-fast",
      },
    });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(44),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
      },
      auditSink,
    });

    const events = [];
    for await (const event of gateway.streamText({
      sessionId: 7,
      turnJobId: 101,
      purpose: "chat_coordinator_fast",
      prompt: "Stream the answer from context.",
      promptVersion: "chat_coordinator@v1",
      contextVersionUsed: 4,
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text", text: "Streaming fallback answer" },
      {
        type: "done",
        usage: {
          inputTokens: 12,
          outputTokens: 8,
          costUsd: 0.012345,
        },
      },
    ]);
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        promptVersion: "chat_coordinator@v1",
      }),
    );
  });

  it("retries transient SDK exceptions before auditing success", async () => {
    const runAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 throttled"))
      .mockResolvedValueOnce({
        success: true,
        output: "Recovered answer",
        metrics: {
          durationMs: 111,
          toolCalls: 0,
          tokensUsed: { input: 12, output: 8 },
          costUsd: 0.012345,
          modelUsed: "claude-fast",
        },
      });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(44),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
      },
      auditSink,
      retryBaseMs: 0,
    });

    await expect(
      gateway.generateText({
        sessionId: 7,
        turnJobId: 101,
        purpose: "chat_coordinator_fast",
        prompt: "Answer from context.",
        promptVersion: "chat_coordinator@v1",
      }),
    ).resolves.toMatchObject({ text: "Recovered answer" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(auditSink.recordCall).toHaveBeenCalledTimes(1);
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", errorCode: null }),
    );
  });

  it("retries transient failed SDK results before returning success", async () => {
    const runAgent = vi
      .fn()
      .mockResolvedValueOnce({
        success: false,
        output: "",
        error: "503 Service Unavailable",
        metrics: { durationMs: 50, toolCalls: 0 },
      })
      .mockResolvedValueOnce({
        success: true,
        output: "Recovered answer",
        metrics: {
          durationMs: 111,
          toolCalls: 0,
          tokensUsed: { input: 12, output: 8 },
          costUsd: 0.012345,
          modelUsed: "claude-fast",
        },
      });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(44),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
      },
      auditSink,
      retryBaseMs: 0,
    });

    await expect(
      gateway.generateText({
        sessionId: 7,
        turnJobId: 101,
        purpose: "chat_coordinator_fast",
        prompt: "Answer from context.",
        promptVersion: "chat_coordinator@v1",
      }),
    ).resolves.toMatchObject({ text: "Recovered answer" });

    expect(runAgent).toHaveBeenCalledTimes(2);
    expect(auditSink.recordCall).toHaveBeenCalledTimes(1);
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded", errorCode: null }),
    );
  });

  it("rejects a prompt version that is not registered for the purpose before provider execution", async () => {
    const runAgent = vi.fn();
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never);

    await expect(
      gateway.generateText({
        purpose: "critic_review",
        prompt: "Review this answer.",
        promptVersion: "chat_coordinator@v1",
      }),
    ).rejects.toThrow(
      "prompt_version_purpose_mismatch:chat_coordinator@v1:critic_review",
    );
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("consults the configured prompt registry before running the provider", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Coordinated answer",
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 12, output: 8 },
        costUsd: 0.01,
        modelUsed: "claude-fast",
      },
    });
    const promptRegistry = {
      resolvePromptVersion: vi.fn().mockResolvedValue("chat_coordinator@v2"),
    };
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(42),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
        SPEC_FACTORY_PROMPT_REGISTRY_SOURCE: "db",
      },
      auditSink,
      promptRegistry,
    });

    await gateway.generateText({
      purpose: "chat_coordinator_fast",
      prompt: "Answer from the bundle.",
    });

    expect(promptRegistry.resolvePromptVersion).toHaveBeenCalledWith({
      purpose: "chat_coordinator_fast",
      requestedVersion: undefined,
      allowDefault: true,
    });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        promptVersion: "chat_coordinator@v2",
      }),
    );
  });

  it("rejects unknown prompt versions from the configured registry before provider execution", async () => {
    const runAgent = vi.fn();
    const promptRegistry = {
      resolvePromptVersion: vi
        .fn()
        .mockRejectedValue(
          new Error("prompt_version_not_registered:missing_prompt@v1"),
        ),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: { SPEC_FACTORY_PROMPT_REGISTRY_SOURCE: "db" },
      promptRegistry,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
        promptVersion: "missing_prompt@v1",
      }),
    ).rejects.toThrow("prompt_version_not_registered:missing_prompt@v1");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("denies a provider call before execution when the session budget would be exceeded", async () => {
    const runAgent = vi.fn();
    const budgetStore = {
      getBudgetUsage: vi.fn().mockResolvedValue({
        sessionCostUsd: 0.9,
        globalDayCostUsd: 1.5,
      }),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_SESSION_COST_CEILING_USD: "1.00",
      },
      budgetStore,
    });

    await expect(
      gateway.generateText({
        sessionId: 7,
        purpose: "critic_review",
        prompt: "Review this answer.",
        promptVersion: "critic_review@v1",
        maxCostUsd: 0.25,
      }),
    ).rejects.toThrow("llm_budget_exceeded:session");
    expect(budgetStore.getBudgetUsage).toHaveBeenCalledWith({
      sessionId: 7,
      since: expect.any(Date),
    });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("requires maxCostUsd when aggregate LLM budgets are configured", async () => {
    const runAgent = vi.fn();
    const budgetStore = {
      getBudgetUsage: vi.fn(),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_GLOBAL_DAILY_COST_CEILING_USD: "10.00",
      },
      budgetStore,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize this session.",
      }),
    ).rejects.toThrow("llm_budget_requires_max_cost");
    expect(budgetStore.getBudgetUsage).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects requested output tokens above the configured purpose cap before provider execution", async () => {
    const runAgent = vi.fn();
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
        SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS_CHAT_COORDINATOR_FAST: "1024",
      },
    });

    await expect(
      gateway.generateText({
        purpose: "chat_coordinator_fast",
        prompt: "Answer from context.",
        maxOutputTokens: 2048,
      }),
    ).rejects.toThrow("llm_max_output_tokens_exceeded:2048:1024");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("passes the effective output-token cap into the Bedrock SDK config", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Plain answer",
      metrics: {
        durationMs: 111,
        toolCalls: 0,
        tokensUsed: { input: 12, output: 8 },
        costUsd: 0.012345,
        modelUsed: "claude-fast",
      },
    });
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
        SPEC_FACTORY_LLM_MAX_OUTPUT_TOKENS: "4096",
      },
    });

    await gateway.generateText({
      purpose: "chat_coordinator_fast",
      prompt: "Answer from context.",
      maxOutputTokens: 1024,
    });

    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        bedrockConfig: {
          region: "us-east-2",
          model: "claude-fast",
          maxOutputTokens: 1024,
        },
      }),
    );
  });

  it("does not fail a successful gateway call when audit persistence fails", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Plain answer",
      metrics: {
        durationMs: 111,
        toolCalls: 0,
        tokensUsed: { input: 12, output: 8 },
        costUsd: 0.012345,
        modelUsed: "claude-fast",
      },
    });
    const auditSink = {
      recordCall: vi.fn().mockRejectedValue(new Error("audit db down")),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_LLM_MODEL_CHAT_COORDINATOR_FAST: "claude-fast",
      },
      auditSink,
    });

    await expect(
      gateway.generateText({
        sessionId: 7,
        turnJobId: 101,
        purpose: "chat_coordinator_fast",
        prompt: "Answer from context.",
      }),
    ).resolves.toEqual({
      text: "Plain answer",
      modelUsed: "claude-fast",
      usage: {
        inputTokens: 12,
        outputTokens: 8,
        costUsd: 0.012345,
      },
    });

    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({ status: "succeeded" }),
    );
  });

  it("records failed gateway calls before surfacing the error", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: false,
      output: "",
      error: "Bedrock throttled",
      metrics: { durationMs: 50, toolCalls: 0 },
    });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(45),
    };
    const metrics = { recordProviderCall: vi.fn() };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: { SPEC_FACTORY_MODEL_ID: "claude-global" },
      auditSink,
      metrics,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).rejects.toThrow("llm_gateway_failed:Bedrock throttled");

    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "conversation_summary",
        provider: "bedrock",
        model: "claude-global",
        status: "failed",
        errorCode: "Bedrock throttled",
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      }),
    );
    expect(metrics.recordProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "conversation_summary",
        provider: "bedrock",
        model: "claude-global",
        outcome: "throttled",
      }),
    );
  });

  it("preserves failed gateway errors when audit persistence fails", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: false,
      output: "",
      error: "Bedrock throttled",
      metrics: { durationMs: 50, toolCalls: 0 },
    });
    const auditSink = {
      recordCall: vi.fn().mockRejectedValue(new Error("audit db down")),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: { SPEC_FACTORY_MODEL_ID: "claude-global" },
      auditSink,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).rejects.toThrow("llm_gateway_failed:Bedrock throttled");

    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "Bedrock throttled",
      }),
    );
  });

  it("records rejected SDK calls before rethrowing the error", async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error("network down"));
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(47),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: { SPEC_FACTORY_MODEL_ID: "claude-global" },
      auditSink,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).rejects.toThrow("network down");

    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        purpose: "conversation_summary",
        provider: "bedrock",
        model: "claude-global",
        status: "failed",
        errorCode: "network down",
      }),
    );
  });

  it("preserves rejected SDK errors when audit persistence fails", async () => {
    const runAgent = vi.fn().mockRejectedValue(new Error("network down"));
    const auditSink = {
      recordCall: vi.fn().mockRejectedValue(new Error("audit db down")),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: { SPEC_FACTORY_MODEL_ID: "claude-global" },
      auditSink,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).rejects.toThrow("network down");

    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "network down",
      }),
    );
  });

  it("writes redacted prompt and response artifacts when redacted prompt logging is enabled", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "password: hunter2",
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 10, output: 4 },
        costUsd: 0.005,
        modelUsed: "claude-global",
      },
    });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(46),
    };
    const artifactWriter = {
      writeArtifact: vi
        .fn()
        .mockResolvedValueOnce({ artifactUri: "s3://audit/prompt.txt" })
        .mockResolvedValueOnce({ artifactUri: "s3://audit/response.txt" }),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_MODEL_ID: "claude-global",
        SPEC_FACTORY_LLM_PROMPT_LOGGING: "redacted",
      },
      auditSink,
      artifactWriter,
    });

    await gateway.generateText({
      purpose: "conversation_summary",
      prompt: "JIRA_TOKEN=abc123",
    });

    expect(artifactWriter.writeArtifact).toHaveBeenNthCalledWith(1, {
      relativePath: expect.stringMatching(
        /^llm-audit\/conversation_summary\/.*\/prompt\.txt$/,
      ),
      content: "JIRA_TOKEN=[REDACTED]\n",
    });
    expect(artifactWriter.writeArtifact).toHaveBeenNthCalledWith(2, {
      relativePath: expect.stringMatching(
        /^llm-audit\/conversation_summary\/.*\/response\.txt$/,
      ),
      content: "password: [REDACTED]\n",
    });
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        redactedPromptUri: "s3://audit/prompt.txt",
        redactedResponseUri: "s3://audit/response.txt",
      }),
    );
  });

  it("does not fail a successful gateway call when audit artifact writing fails", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Plain answer",
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 10, output: 4 },
        costUsd: 0.005,
        modelUsed: "claude-global",
      },
    });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(48),
    };
    const artifactWriter = {
      writeArtifact: vi.fn().mockRejectedValue(new Error("s3 down")),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_MODEL_ID: "claude-global",
        SPEC_FACTORY_LLM_PROMPT_LOGGING: "redacted",
      },
      auditSink,
      artifactWriter,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).resolves.toMatchObject({
      text: "Plain answer",
      modelUsed: "claude-global",
    });
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "succeeded",
        redactedPromptUri: null,
        redactedResponseUri: null,
      }),
    );
  });

  it("rejects full prompt logging without explicit secure debug", async () => {
    const runAgent = vi.fn();
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_MODEL_ID: "claude-global",
        SPEC_FACTORY_LLM_PROMPT_LOGGING: "full",
      },
      artifactWriter: {
        writeArtifact: vi.fn(),
      },
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).rejects.toThrow("llm_full_prompt_logging_requires_secure_debug");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("rejects full prompt logging in production even with secure debug enabled", async () => {
    const runAgent = vi.fn();
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        NODE_ENV: "production",
        SPEC_FACTORY_MODEL_ID: "claude-global",
        SPEC_FACTORY_LLM_PROMPT_LOGGING: "full",
        SPEC_FACTORY_LLM_SECURE_DEBUG: "true",
      },
      artifactWriter: {
        writeArtifact: vi.fn(),
      },
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).rejects.toThrow("llm_full_prompt_logging_forbidden_in_production");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("allows full prompt logging only in explicit non-production secure debug", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "password: hunter2",
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 10, output: 4 },
        costUsd: 0.005,
        modelUsed: "claude-global",
      },
    });
    const artifactWriter = {
      writeArtifact: vi
        .fn()
        .mockResolvedValueOnce({ artifactUri: "s3://audit/prompt.txt" })
        .mockResolvedValueOnce({ artifactUri: "s3://audit/response.txt" }),
    };
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        NODE_ENV: "test",
        SPEC_FACTORY_MODEL_ID: "claude-global",
        SPEC_FACTORY_LLM_PROMPT_LOGGING: "full",
        SPEC_FACTORY_LLM_SECURE_DEBUG: "true",
      },
      artifactWriter,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "JIRA_TOKEN=abc123",
      }),
    ).resolves.toMatchObject({ text: "password: hunter2" });

    expect(artifactWriter.writeArtifact).toHaveBeenNthCalledWith(1, {
      relativePath: expect.stringMatching(
        /^llm-audit\/conversation_summary\/.*\/prompt\.txt$/,
      ),
      content: "JIRA_TOKEN=abc123\n",
    });
    expect(artifactWriter.writeArtifact).toHaveBeenNthCalledWith(2, {
      relativePath: expect.stringMatching(
        /^llm-audit\/conversation_summary\/.*\/response\.txt$/,
      ),
      content: "password: hunter2\n",
    });
  });

  it("rejects invalid prompt logging config before invoking the SDK", async () => {
    const runAgent = vi.fn();
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: {
        SPEC_FACTORY_MODEL_ID: "claude-global",
        SPEC_FACTORY_LLM_PROMPT_LOGGING: "raw",
      },
      artifactWriter: {
        writeArtifact: vi.fn(),
      },
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize.",
      }),
    ).rejects.toThrow("invalid_llm_prompt_logging_mode:raw");
    expect(runAgent).not.toHaveBeenCalled();
  });

  it("generates plain text without an output schema", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Plain answer",
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 10, output: 4 },
        costUsd: 0.005,
        modelUsed: "claude-global",
      },
    });
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never, {
      env: { SPEC_FACTORY_MODEL_ID: "claude-global" },
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize the conversation.",
      }),
    ).resolves.toEqual({
      text: "Plain answer",
      modelUsed: "claude-global",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        costUsd: 0.005,
      },
    });
    expect(runAgent.mock.calls[0][0]).not.toHaveProperty("outputSchema");
  });

  it("surfaces failed SDK calls as gateway errors", async () => {
    const runAgent = vi.fn().mockResolvedValue({
      success: false,
      output: "",
      error: "Bedrock throttled",
      metrics: { durationMs: 50, toolCalls: 0 },
    });
    const gateway = new ClaudeAgentSdkBedrockLlmGateway(runAgent as never);

    await expect(
      gateway.generateText({
        purpose: "chat_coordinator_fast",
        prompt: "Answer.",
      }),
    ).rejects.toThrow("llm_gateway_failed:Bedrock throttled");
  });
});

describe("createSpecFactoryLlmGateway", () => {
  it("passes retry options through the default factory", async () => {
    const runAgent = vi
      .fn()
      .mockRejectedValueOnce(new Error("429 throttled"))
      .mockResolvedValueOnce({
        success: true,
        output: "Recovered answer",
        metrics: {
          durationMs: 75,
          toolCalls: 0,
          tokensUsed: { input: 5, output: 3 },
          costUsd: 0.004,
          modelUsed: "claude-global",
        },
      });
    const auditSink = {
      recordCall: vi.fn().mockResolvedValue(93),
    };
    const gateway = createSpecFactoryLlmGateway({
      runAgent: runAgent as never,
      auditSink,
      env: { SPEC_FACTORY_MODEL_ID: "claude-global" },
      maxAttempts: 1,
      retryBaseMs: 0,
    });

    await expect(
      gateway.generateText({
        purpose: "conversation_summary",
        prompt: "Summarize the session.",
      }),
    ).rejects.toThrow("429 throttled");

    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(auditSink.recordCall).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "failed",
        errorCode: "429 throttled",
      }),
    );
  });

  it("constructs an audited gateway backed by spec_factory_llm_calls", async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 91 }]);
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "Audited answer",
      metrics: {
        durationMs: 75,
        toolCalls: 0,
        tokensUsed: { input: 5, output: 3 },
        costUsd: 0.004,
        modelUsed: "claude-global",
      },
    });
    const gateway = createSpecFactoryLlmGateway({
      runAgent: runAgent as never,
      auditPool: { query } as never,
      env: { SPEC_FACTORY_MODEL_ID: "claude-global" },
    });

    await gateway.generateText({
      sessionId: 7,
      purpose: "conversation_summary",
      prompt: "Summarize the session.",
    });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO spec_factory_llm_calls"),
      expect.arrayContaining([
        7,
        null,
        null,
        "conversation_summary",
        "bedrock",
        "claude-global",
        null,
        null,
        5,
        3,
        8,
      ]),
    );
  });

  it("passes an optional audit artifact writer through the default factory", async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 92 }]);
    const runAgent = vi.fn().mockResolvedValue({
      success: true,
      output: "password: hunter2",
      metrics: {
        durationMs: 75,
        toolCalls: 0,
        tokensUsed: { input: 5, output: 3 },
        costUsd: 0.004,
        modelUsed: "claude-global",
      },
    });
    const artifactWriter = {
      writeArtifact: vi
        .fn()
        .mockResolvedValueOnce({ artifactUri: "s3://audit/prompt.txt" })
        .mockResolvedValueOnce({ artifactUri: "s3://audit/response.txt" }),
    };
    const gateway = createSpecFactoryLlmGateway({
      runAgent: runAgent as never,
      auditPool: { query } as never,
      artifactWriter,
      env: {
        SPEC_FACTORY_MODEL_ID: "claude-global",
        SPEC_FACTORY_LLM_PROMPT_LOGGING: "redacted",
      },
    });

    await gateway.generateText({
      purpose: "conversation_summary",
      prompt: "JIRA_TOKEN=abc123",
    });

    expect(artifactWriter.writeArtifact).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][1]).toEqual(
      expect.arrayContaining([
        "s3://audit/prompt.txt",
        "s3://audit/response.txt",
      ]),
    );
  });

  it("writes redacted audit artifacts to the configured filesystem base", async () => {
    const artifactBase = await mkdtemp(path.join(tmpdir(), "sf-llm-audit-"));
    try {
      const query = vi.fn().mockResolvedValue([{ insertId: 93 }]);
      const runAgent = vi.fn().mockResolvedValue({
        success: true,
        output: "password: hunter2",
        metrics: {
          durationMs: 75,
          toolCalls: 0,
          tokensUsed: { input: 5, output: 3 },
          costUsd: 0.004,
          modelUsed: "claude-global",
        },
      });
      const gateway = createSpecFactoryLlmGateway({
        runAgent: runAgent as never,
        auditPool: { query } as never,
        env: {
          SPEC_FACTORY_MODEL_ID: "claude-global",
          SPEC_FACTORY_LLM_PROMPT_LOGGING: "redacted",
          SPEC_FACTORY_LLM_AUDIT_ARTIFACT_BASE: artifactBase,
        },
      });

      await gateway.generateText({
        purpose: "conversation_summary",
        prompt: "JIRA_TOKEN=abc123",
      });

      const bindings = query.mock.calls[0][1] as unknown[];
      const artifactUris = bindings.filter(
        (value): value is string =>
          typeof value === "string" && value.startsWith("file://"),
      );
      expect(artifactUris).toHaveLength(2);
      expect(await readFile(fileURLToPath(artifactUris[0]), "utf8")).toBe(
        "JIRA_TOKEN=[REDACTED]\n",
      );
      expect(await readFile(fileURLToPath(artifactUris[1]), "utf8")).toBe(
        "password: [REDACTED]\n",
      );
    } finally {
      await rm(artifactBase, { recursive: true, force: true });
    }
  });
});
