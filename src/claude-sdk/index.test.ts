import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const queryMock = vi.fn();
const loggerMock = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};
const originalAnthropicModel = process.env.ANTHROPIC_MODEL;
const originalBedrockModel = process.env.BEDROCK_MODEL;

function restoreEnv(
  name: "ANTHROPIC_MODEL" | "BEDROCK_MODEL",
  value: string | undefined,
) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: queryMock,
}));

vi.mock("../utils/index.js", async () => {
  const actual =
    await vi.importActual<typeof import("../utils/index.js")>(
      "../utils/index.js",
    );

  return {
    ...actual,
    createLogger: vi.fn(() => loggerMock),
  };
});

function buildSuccessResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: false,
    num_turns: 1,
    result: '{"result":"ok"}',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    modelUsage: {},
    permission_denials: [],
    uuid: "uuid-1",
    session_id: "session-1",
    ...overrides,
  };
}

async function simulatePreToolUse(
  options: { hooks?: any },
  toolName: string,
  toolInput: Record<string, unknown>,
  toolUseId: string,
): Promise<unknown> {
  const hooks = options.hooks as any;
  return hooks.PreToolUse[0].hooks[0](
    {
      hook_event_name: "PreToolUse",
      tool_name: toolName,
      tool_input: toolInput,
      tool_use_id: toolUseId,
    },
    toolUseId,
  );
}

function buildErrorResult(overrides: Record<string, unknown> = {}) {
  return {
    type: "result",
    subtype: "error_during_execution",
    duration_ms: 1,
    duration_api_ms: 1,
    is_error: true,
    num_turns: 1,
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
    },
    modelUsage: {},
    permission_denials: [],
    errors: ["command failed"],
    uuid: "uuid-2",
    session_id: "session-2",
    ...overrides,
  };
}

function waitForAbort(signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (!signal) {
      reject(new Error("missing abort signal"));
      return;
    }

    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }

    signal.addEventListener("abort", () => reject(new Error("aborted")), {
      once: true,
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

describe("claude-sdk runAgent", () => {
  beforeEach(() => {
    queryMock.mockReset();
    loggerMock.info.mockReset();
    loggerMock.warn.mockReset();
    loggerMock.error.mockReset();
    loggerMock.debug.mockReset();
    process.env.ANTHROPIC_MODEL = "";
    process.env.BEDROCK_MODEL = "";
  });

  afterEach(() => {
    vi.useRealTimers();
    restoreEnv("ANTHROPIC_MODEL", originalAnthropicModel);
    restoreEnv("BEDROCK_MODEL", originalBedrockModel);
  });

  it("passes json schema output format through to the Claude SDK", async () => {
    const schema = {
      type: "object",
      properties: {
        result: { type: "string" },
      },
      required: ["result"],
    };

    queryMock.mockImplementation(({ options }) => {
      expect(options.outputFormat).toEqual({
        type: "json_schema",
        schema,
      });

      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: '{"result":"ok"}' }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        };
        yield {
          type: "result",
          subtype: "success",
          usage: {
            input_tokens: 1,
            output_tokens: 1,
          },
          total_cost_usd: 0.01,
        };
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace", "/tmp");

    const result = await runAgent({
      taskId: "planner-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace"],
      outputSchema: schema,
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.structuredOutput).toEqual({ result: "ok" });
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("passes additional read directories through to the Claude SDK", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.additionalDirectories).toEqual([
        "/tmp/oneshot/state/planner/ticket-evidence",
      ]);

      async function* messages() {
        yield buildSuccessResult();
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace", "/tmp/workspace");

    const result = await runAgent({
      taskId: "planner-evidence-test",
      taskPrompt: "Read evidence sidecars",
      repoIds: ["workspace"],
      allowedTools: ["Read"],
      additionalDirectories: ["/tmp/oneshot/state/planner/ticket-evidence"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    } as Parameters<typeof runAgent>[0] & { additionalDirectories: string[] });

    expect(result.success).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("records structured-output retry failure details when the SDK exposes them", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildErrorResult({
          subtype: "error_max_structured_output_retries",
          errors: [
            "schema path /: additionalProperties must NOT have additional property 'metadata'",
          ],
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-structured-output-retry", "/tmp");

    const result = await runAgent({
      taskId: "structured-output-retry-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-structured-output-retry"],
      outputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
        required: ["result"],
      },
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("structured_output_retries_exhausted");
    expect(
      result.metrics.sdkLifecycleSummary?.structuredOutputErrorDetails,
    ).toEqual([
      "schema path /: additionalProperties must NOT have additional property 'metadata'",
    ]);
  });

  it("uses an injected SDK binding query and native resolver when provided", async () => {
    const injectedQueryMock = vi.fn(({ options }) => {
      expect(options.pathToClaudeCodeExecutable).toBe(
        "/tmp/claude-from-binding",
      );

      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-injected-sdk", "/tmp");

    const result = await runAgent({
      taskId: "planner-injected-sdk-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-injected-sdk"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      sdkBinding: {
        query: injectedQueryMock,
        resolvePackageBinary: () => "/tmp/claude-from-binding",
        sdkSource: "test",
        sdkPackageName: "@specter/oneshot-claude-agent-sdk",
        sdkPackageVersion: "0.3.183",
      },
    });

    expect(result.success).toBe(true);
    expect(injectedQueryMock).toHaveBeenCalledTimes(1);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it("passes SDK plugins, skills, and agents through to the Claude SDK", async () => {
    const plugins = [
      {
        type: "local" as const,
        path: "/app/oneshot-prompts/plugins/oneshot-planner",
      },
    ];
    const skills = [
      "oneshot-planner:planner-grounding",
      "oneshot-planner:logical-decomposition",
    ];
    const agents = {
      "oneshot-grounding-scout": {
        description: "Read-only OneShot grounding scout.",
        prompt: "Inspect repository evidence and return concise findings.",
        tools: ["Read", "Glob", "Grep"],
        model: "us.anthropic.claude-haiku-test-v1:0",
        disallowedTools: ["Agent", "Task"],
        maxTurns: 8,
      },
    };

    queryMock.mockImplementation(({ options }) => {
      expect(options.plugins).toEqual(plugins);
      expect(options.skills).toEqual(skills);
      expect(options.agents).toEqual(agents);
      expect(options.settingSources).toEqual([]);

      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-sdk-extensions", "/tmp");

    const result = await runAgent({
      taskId: "planner-sdk-extensions-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-sdk-extensions"],
      allowedTools: ["Read", "Agent"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      settingSources: [],
      plugins,
      skills,
      agents,
    });

    expect(result.success).toBe(true);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });

  it("ignores optional assistant tool_use_meta sidecar fields from SDK 0.3.x", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: '{"result":"ok"}' }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
          tool_use_meta: {
            tool_use_id: "toolu_123",
            name: "Read",
          },
        };
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-use-meta", "/tmp");

    const result = await runAgent({
      taskId: "planner-tool-use-meta-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-tool-use-meta"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.structuredOutput).toEqual({ result: "ok" });
  });

  it("passes partial message opt-in through to the Claude SDK and reports modelUsed", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.includePartialMessages).toBe(true);

      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
          modelUsage: {
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
              input_tokens: 3,
              output_tokens: 5,
            },
          },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-partial-opt-in", "/tmp");

    const result = await runAgent({
      taskId: "planner-partial-opt-in-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-partial-opt-in"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.modelUsed).toBe(
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
    );
  });

  it("summarizes SDK lifecycle result, retry, rate-limit, and compaction signals", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield {
          type: "system",
          subtype: "api_retry",
          attempt: 1,
          max_retries: 3,
          retry_delay_ms: 250,
          error_status: 529,
          error: "rate_limit",
        };
        yield {
          type: "rate_limit_event",
          rate_limit_info: { status: "allowed_warning" },
        };
        yield {
          type: "system",
          subtype: "compact_boundary",
          compact_metadata: {
            trigger: "auto",
            pre_tokens: 1000,
            post_tokens: 400,
            duration_ms: 321,
          },
        };
        yield buildSuccessResult({
          duration_api_ms: 42,
          num_turns: 3,
          stop_reason: "end_turn",
          permission_denials: [
            {
              tool_name: "Read",
              tool_use_id: "toolu_denied",
              tool_input: { path: "secret.txt" },
            },
          ],
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-lifecycle-signals", "/tmp");

    const result = await runAgent({
      taskId: "lifecycle-signals-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-lifecycle-signals"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.sdkLifecycleSummary).toMatchObject({
      sdkResultSubtype: "success",
      apiDurationMs: 42,
      numTurns: 3,
      stopReason: "end_turn",
      apiRetryCount: 1,
      rateLimitCount: 1,
      lastRateLimitStatus: "allowed_warning",
      compactBoundaryCount: 1,
      compactDurationMs: 321,
    });
    expect(result.metrics.sdkLifecycleSummary?.permissionDenials).toHaveLength(
      1,
    );
  });

  it("uses hook callbacks for hook event counts and terminal permission denials as canonical", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        const hooks = options.hooks as any;
        await hooks.PermissionDenied[0].hooks[0]({
          hook_event_name: "PermissionDenied",
          tool_name: "Read",
          tool_input: { path: "hook-secret.txt" },
          tool_use_id: "toolu_hook_denied",
        });
        yield {
          type: "system",
          subtype: "hook_started",
          hook_event: "PermissionDenied",
          hook_id: "hook-1",
          hook_name: "observe",
        };
        yield {
          type: "system",
          subtype: "hook_response",
          hook_event: "PermissionDenied",
          hook_id: "hook-1",
          hook_name: "observe",
          outcome: "success",
        };
        yield buildSuccessResult({
          permission_denials: [
            {
              tool_name: "Read",
              tool_use_id: "toolu_result_denied",
              tool_input: { path: "result-secret.txt" },
            },
          ],
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-hook-count-canonical", "/tmp");

    const result = await runAgent({
      taskId: "hook-count-canonical-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-hook-count-canonical"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.sdkLifecycleSummary?.hookStartedCount).toBe(1);
    expect(result.metrics.sdkLifecycleSummary?.hookResponseCount).toBe(1);
    expect(result.metrics.sdkLifecycleSummary?.hookEventCounts).toEqual({
      PermissionDenied: 1,
    });
    expect(result.metrics.sdkLifecycleSummary?.permissionDenials).toEqual([
      {
        toolName: "Read",
        toolUseId: "toolu_result_denied",
        inputKeys: ["path"],
      },
    ]);
  });

  it("returns buffered raw trace in failure trace mode after SDK success", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: '{"result":"ok"}' }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-failure-trace-success", "/tmp");

    const result = await runAgent({
      taskId: "failure-trace-success-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-failure-trace-success"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      sdkTraceMode: "failure",
    });

    expect(result.success).toBe(true);
    expect(result.metrics.sdkRawTrace?.length).toBeGreaterThan(0);
  });

  it("marks raw SDK traces as truncated when the trace buffer cap is exceeded", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        for (let i = 0; i < 2001; i += 1) {
          yield {
            type: "assistant",
            message: {
              content: [{ type: "text", text: "" }],
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          };
        }
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-trace-truncated", "/tmp");

    const result = await runAgent({
      taskId: "trace-truncated-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-trace-truncated"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      sdkTraceMode: "always",
    });

    expect(result.success).toBe(true);
    expect(result.metrics.sdkRawTrace).toHaveLength(2000);
    expect(result.metrics.sdkLifecycleSummary?.rawTraceTruncated).toBe(true);
  });

  it("uses per-call Bedrock model override when success metrics omit modelUsage", async () => {
    let capturedOptions: Parameters<typeof queryMock>[0]["options"] | undefined;

    queryMock.mockImplementation(({ options }) => {
      capturedOptions = options;

      async function* messages() {
        yield buildSuccessResult({
          total_cost_usd: undefined,
          usage: {
            input_tokens: 500_000,
            output_tokens: 50_000,
            cache_read_input_tokens: 200_000,
            cache_creation_input_tokens: 100_000,
          },
          modelUsage: {},
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-bedrock-model-success", "/tmp");

    const result = await runAgent({
      taskId: "planner-bedrock-model-success-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-bedrock-model-success"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 10,
      bedrockConfig: {
        model: "us.anthropic.claude-opus-4-6-v1",
      },
    });

    expect(result.success).toBe(true);
    expect(result.metrics.modelUsed).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(result.metrics.costUsd).toBe(4.9225);
    expect(capturedOptions?.model).toBe("us.anthropic.claude-opus-4-6-v1");
  });

  it("uses per-call Bedrock model override when failure metrics omit modelUsage", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildErrorResult({
          total_cost_usd: undefined,
          usage: {
            input_tokens: 500_000,
            output_tokens: 50_000,
            cache_read_input_tokens: 200_000,
            cache_creation_input_tokens: 100_000,
          },
          modelUsage: {},
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-bedrock-model-failure", "/tmp");

    const result = await runAgent({
      taskId: "planner-bedrock-model-failure-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-bedrock-model-failure"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 10,
      bedrockConfig: {
        model: "us.anthropic.claude-opus-4-6-v1",
      },
    });

    expect(result.success).toBe(false);
    expect(result.metrics.modelUsed).toBe("us.anthropic.claude-opus-4-6-v1");
    expect(result.metrics.costUsd).toBe(4.9225);
  });

  it("passes the inherited ANTHROPIC_MODEL through to the Claude SDK model option", async () => {
    const previousModel = process.env.ANTHROPIC_MODEL;
    process.env.ANTHROPIC_MODEL = "us.anthropic.claude-sonnet-4-6";
    let capturedOptions: Parameters<typeof queryMock>[0]["options"] | undefined;

    queryMock.mockImplementation(({ options }) => {
      capturedOptions = options;

      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
          total_cost_usd: undefined,
          modelUsage: {},
        });
      }

      return messages();
    });

    try {
      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-env-model", "/tmp");

      const result = await runAgent({
        taskId: "env-model-test",
        taskPrompt: "Return structured output",
        repoIds: ["workspace-env-model"],
        allowedTools: ["Read"],
        maxTurns: 1,
        maxBudgetUsd: 1,
      });

      expect(result.success).toBe(true);
      expect(result.metrics.modelUsed).toBe("us.anthropic.claude-sonnet-4-6");
      expect(capturedOptions?.model).toBe("us.anthropic.claude-sonnet-4-6");
    } finally {
      if (previousModel === undefined) {
        delete process.env.ANTHROPIC_MODEL;
      } else {
        process.env.ANTHROPIC_MODEL = previousModel;
      }
    }
  });

  it("keeps the configured stage model even when SDK modelUsage reports a helper model", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
          modelUsage: {
            "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
              input_tokens: 100,
              output_tokens: 20,
            },
            "us.anthropic.claude-sonnet-4-6": {
              input_tokens: 1_000,
              output_tokens: 100,
            },
          },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-configured-model-wins", "/tmp");

    const result = await runAgent({
      taskId: "configured-model-wins-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-configured-model-wins"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      bedrockConfig: {
        model: "us.anthropic.claude-sonnet-4-6",
      },
    });

    expect(result.success).toBe(true);
    expect(result.metrics.modelUsed).toBe("us.anthropic.claude-sonnet-4-6");
    expect(result.metrics.modelUsage).toHaveProperty(
      "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
  });

  it("omits SDK modelUsage rows whose input and output tokens are both zero", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildSuccessResult({
          total_cost_usd: 0.7992,
          usage: {
            input_tokens: 1_624,
            output_tokens: 23_369,
            cache_read_input_tokens: 509_981,
            cache_creation_input_tokens: 139_884,
          },
          modelUsage: {
            "us.anthropic.claude-opus-4-8": {
              input_tokens: 0,
              output_tokens: 0,
            },
            "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-zero-model-usage", "/tmp");

    const result = await runAgent({
      taskId: "zero-model-usage-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-zero-model-usage"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      bedrockConfig: {
        model: "us.anthropic.claude-opus-4-8",
      },
    });

    expect(result.success).toBe(true);
    expect(result.metrics.modelUsed).toBe("us.anthropic.claude-opus-4-8");
    expect(result.metrics.modelUsage).toBeUndefined();
    expect(result.metrics.tokensUsed).toEqual({
      input: 1_624,
      output: 23_369,
      cacheRead: 509_981,
      cacheWrite: 139_884,
    });
    expect(result.metrics.costUsd).toBe(0.7992);
    expect(result.metrics.costUsdExact).toBe(true);
  });

  it("keeps positive SDK modelUsage rows while dropping zero rows", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildSuccessResult({
          total_cost_usd: 1,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
          modelUsage: {
            "us.anthropic.claude-opus-4-8": {
              input_tokens: 100,
              output_tokens: 20,
            },
            "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
              input_tokens: 0,
              output_tokens: 0,
            },
          },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-positive-model-usage", "/tmp");

    const result = await runAgent({
      taskId: "positive-model-usage-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-positive-model-usage"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      bedrockConfig: {
        model: "us.anthropic.claude-opus-4-8",
      },
    });

    expect(result.success).toBe(true);
    expect(result.metrics.modelUsage).toEqual({
      "us.anthropic.claude-opus-4-8": {
        input: 100,
        output: 20,
      },
    });
  });

  it("normalizes current SDK camel-case modelUsage rows", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildSuccessResult({
          total_cost_usd: 1,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
          },
          modelUsage: {
            "us.anthropic.claude-opus-4-8": {
              inputTokens: 100,
              outputTokens: 20,
            },
            "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
              inputTokens: 0,
              outputTokens: 0,
            },
          },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-camel-model-usage", "/tmp");

    const result = await runAgent({
      taskId: "camel-model-usage-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-camel-model-usage"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      bedrockConfig: {
        model: "us.anthropic.claude-opus-4-8",
      },
    });

    expect(result.success).toBe(true);
    expect(result.metrics.modelUsage).toEqual({
      "us.anthropic.claude-opus-4-8": {
        input: 100,
        output: 20,
      },
    });
  });

  it("logs effective SDK model binding at info level and persists lifecycle model controls", async () => {
    let capturedOptions: Parameters<typeof queryMock>[0]["options"] | undefined;
    queryMock.mockImplementation(({ options }) => {
      capturedOptions = options;
      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-model-binding-log", "/tmp");

    const result = await runAgent({
      taskId: "model-binding-log-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-model-binding-log"],
      agentType: "darci",
      sdkStage: "planning",
      allowedTools: ["Read"],
      maxTurns: 7,
      maxBudgetUsd: 1,
      outputSchema: {
        type: "object",
        properties: { result: { type: "string" } },
        required: ["result"],
      },
      bedrockConfig: {
        model: "us.anthropic.claude-opus-4-6-v1",
        maxOutputTokens: 50_000,
        maxThinkingTokens: 2_048,
      },
      toolBudgetGuard: {
        tools: ["Read"],
        maxCalls: 75,
      },
      resumeSessionId: "session-existing",
      forkSessionOnResume: true,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.sdkLifecycleSummary).toMatchObject({
      sdkStage: "planning",
      configuredModel: "us.anthropic.claude-opus-4-6-v1",
      modelSource: "options.env.ANTHROPIC_MODEL",
      maxOutputTokens: 50_000,
      maxThinkingTokens: 2_048,
      toolBudgetLimit: 75,
    });
    expect(loggerMock.info).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "model-binding-log-test",
        stage: "planning",
        model: "us.anthropic.claude-opus-4-6-v1",
        modelSource: "options.env.ANTHROPIC_MODEL",
        maxTurns: 7,
        maxOutputTokens: 50_000,
        maxThinkingTokens: 2_048,
        hasOutputSchema: true,
        toolBudgetLimit: 75,
        resumeSessionId: "[set]",
        forkSessionOnResume: true,
      }),
      "[SDK_MODEL_BINDING] Claude Agent SDK effective model binding",
    );
    expect(capturedOptions).toMatchObject({
      model: "us.anthropic.claude-opus-4-6-v1",
      maxThinkingTokens: 2_048,
      thinking: {
        type: "enabled",
        budgetTokens: 2_048,
      },
    });
  });

  it("passes an explicit disabled thinking mode without a fixed thinking budget", async () => {
    let capturedOptions: Parameters<typeof queryMock>[0]["options"] | undefined;
    queryMock.mockImplementation(({ options }) => {
      capturedOptions = options;
      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const previousMaxThinkingTokens = process.env.MAX_THINKING_TOKENS;
    process.env.MAX_THINKING_TOKENS = "2048";
    try {
      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-thinking-disabled", "/tmp");

      const result = await runAgent({
        taskId: "thinking-disabled-test",
        taskPrompt: "Return a short routing decision",
        repoIds: ["workspace-thinking-disabled"],
        allowedTools: [],
        disableTools: true,
        maxTurns: 1,
        thinking: { type: "disabled" },
        bedrockConfig: { maxOutputTokens: 10_000 },
      });

      expect(result.success).toBe(true);
      expect(capturedOptions).toMatchObject({
        thinking: { type: "disabled" },
      });
      expect(capturedOptions?.maxThinkingTokens).toBeUndefined();
    } finally {
      if (previousMaxThinkingTokens === undefined) {
        delete process.env.MAX_THINKING_TOKENS;
      } else {
        process.env.MAX_THINKING_TOKENS = previousMaxThinkingTokens;
      }
    }
  });

  it("passes the resolved Claude executable path through to the Claude SDK", async () => {
    let capturedOptions: Parameters<typeof queryMock>[0]["options"] | undefined;

    queryMock.mockImplementation(({ options }) => {
      capturedOptions = options;

      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-claude-executable", "/tmp");

    const result = await runAgent({
      taskId: "claude-executable-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-claude-executable"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      pathToClaudeCodeExecutable: "/tmp/claude-test",
    });

    expect(result.success).toBe(true);
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.pathToClaudeCodeExecutable).toBe(
      "/tmp/claude-test",
    );
  });

  it("passes resume, forkSession, and Claude config dir through to the Claude SDK", async () => {
    let capturedOptions: Parameters<typeof queryMock>[0]["options"] | undefined;

    queryMock.mockImplementation(({ options }) => {
      capturedOptions = options;

      async function* messages() {
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
          session_id: "session-forked",
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-claude-resume", "/tmp");

    const result = await runAgent({
      taskId: "claude-resume-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-claude-resume"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      resumeSessionId: "session-previous",
      forkSessionOnResume: true,
      claudeConfigDir: "/tmp/claude-resume-test",
    });

    expect(result.success).toBe(true);
    expect(result.sessionId).toBe("session-forked");
    expect(capturedOptions).toBeDefined();
    expect(capturedOptions!.resume).toBe("session-previous");
    expect(capturedOptions!.forkSession).toBe(true);
    expect(capturedOptions!.env?.CLAUDE_CONFIG_DIR).toBe(
      "/tmp/claude-resume-test",
    );
  });

  it("returns a normal failed result when Claude config dir cannot be created", async () => {
    queryMock.mockImplementation(() => {
      throw new Error("query should not be called");
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-claude-config-dir-error", "/tmp");

    const result = await runAgent({
      taskId: "claude-config-dir-error-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-claude-config-dir-error"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      claudeConfigDir: "/dev/null/claude-config-dir-error",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to create Claude config directory");
    expect(queryMock).not.toHaveBeenCalled();
    expect(loggerMock.error).toHaveBeenCalledWith(
      expect.objectContaining({
        claudeConfigDir: "/dev/null/claude-config-dir-error",
      }),
      "[CLAUDE_CONFIG_DIR_ERROR] Failed to create Claude config directory",
    );
  });

  it("defaults read-only calls to Claude SDK default permission mode", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.permissionMode).toBe("default");
      expect(options.settingSources).toBeUndefined();

      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-permission-default", "/tmp");

    const result = await runAgent({
      taskId: "permission-default-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-permission-default"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
  });

  it("uses explicit bypassPermissions override for read-only calls", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.permissionMode).toBe("bypassPermissions");
      expect(options.allowDangerouslySkipPermissions).toBe(true);

      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-permission-bypass", "/tmp");

    const result = await runAgent({
      taskId: "permission-bypass-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-permission-bypass"],
      allowedTools: ["Read"],
      permissionMode: "bypassPermissions",
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
  });

  it("can explicitly opt into selected Claude filesystem setting sources", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.settingSources).toEqual(["project"]);

      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-setting-sources", "/tmp");

    const result = await runAgent({
      taskId: "setting-sources-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-setting-sources"],
      allowedTools: ["Read"],
      settingSources: ["project"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
  });

  it("can use legacy allowed-tools-only visibility while keeping canUseTool guard", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.allowedTools).toEqual(["Read", "Glob", "Grep"]);
      expect(options.tools).toBeUndefined();
      expect(options.canUseTool).toBeDefined();

      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-visibility-legacy", "/tmp");

    const result = await runAgent({
      taskId: "tool-visibility-legacy-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-tool-visibility-legacy"],
      allowedTools: ["Read", "Glob", "Grep"],
      toolVisibility: "legacyAllowedToolsOnly",
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
  });

  it("can omit canUseTool only when visible tools stay read-only restricted", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.tools).toEqual(["Read", "Glob", "Grep"]);
      expect(options.canUseTool).toBeUndefined();

      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-guard-disabled", "/tmp");

    const result = await runAgent({
      taskId: "tool-guard-disabled-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-tool-guard-disabled"],
      allowedTools: ["Read", "Glob", "Grep"],
      toolVisibility: "restricted",
      toolGuard: "disabledWhenRestricted",
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
  });

  it("can explicitly disable all SDK tools without changing empty allowedTools fallback semantics", async () => {
    queryMock.mockImplementation(({ options }) => {
      expect(options.allowedTools).toEqual([]);
      expect(options.tools).toEqual([]);

      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-disable-tools", "/tmp");

    const result = await runAgent({
      taskId: "disable-tools-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-disable-tools"],
      allowedTools: [],
      disableTools: true,
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
  });

  it("counts tool calls reported through SDK hook events", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        const hooks = options.hooks as any;
        await hooks.PreToolUse[0].hooks[0](
          {
            hook_event_name: "PreToolUse",
            tool_name: "Read",
            tool_input: { path: "src/example.ts" },
            tool_use_id: "toolu_read_1",
          },
          "toolu_read_1",
        );
        await hooks.PostToolUseFailure[0].hooks[0](
          {
            hook_event_name: "PostToolUseFailure",
            tool_name: "Read",
            tool_input: { path: "src/example.ts" },
            tool_use_id: "toolu_read_1",
            error: "File does not exist",
          },
          "toolu_read_1",
        );
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_read_1",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-hook-tool-counts", "/tmp");

    const result = await runAgent({
      taskId: "hook-tool-counts-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-hook-tool-counts"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.toolCalls).toBe(1);
    expect(result.metrics.toolCallProfiles?.[0]).toMatchObject({
      tool: "Read",
      success: false,
      filePath: "src/example.ts",
    });
  });

  it("denies repository tools after the configured planner tool budget", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        const first = await simulatePreToolUse(
          options,
          "Read",
          { path: "a.ts" },
          "tool-budget-1",
        );
        const second = await simulatePreToolUse(
          options,
          "Read",
          { path: "b.ts" },
          "tool-budget-2",
        );
        expect(first).toEqual({});
        expect(second).toMatchObject({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: expect.stringContaining(
              "Emit structured output",
            ),
          },
        });
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-budget", "/tmp");

    const result = await runAgent({
      taskId: "tool-budget-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-tool-budget"],
      allowedTools: ["Read", "Glob", "Grep"],
      toolBudgetGuard: {
        tools: ["Read", "Glob", "Grep"],
        maxCalls: 1,
        message: "Emit structured output now.",
      },
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.sdkLifecycleSummary).toMatchObject({
      toolBudgetUsed: 1,
      toolBudgetLimit: 1,
      toolBudgetDenials: 1,
    });
  });

  it("keeps zero-tool runs at zero tool calls", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-zero-tool-counts", "/tmp");

    const result = await runAgent({
      taskId: "zero-tool-counts-test",
      taskPrompt: "Return structured output without tools",
      repoIds: ["workspace-zero-tool-counts"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.toolCalls).toBe(0);
    expect(result.metrics.toolCallProfiles).toBeUndefined();
  });

  it("preserves read, grep, and glob tool metadata in profiles", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_glob_1",
                name: "Glob",
                input: { directory: ".", pattern: "**/*.java" },
              },
              {
                type: "tool_use",
                id: "toolu_grep_1",
                name: "Grep",
                input: { path: "src", pattern: "UserSession" },
              },
              {
                type: "tool_use",
                id: "toolu_read_1",
                name: "Read",
                input: { file_path: "src/UserSession.java" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-metadata", "/tmp");

    const result = await runAgent({
      taskId: "tool-metadata-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-tool-metadata"],
      allowedTools: ["Read", "Glob", "Grep"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.toolCalls).toBe(3);
    expect(result.metrics.toolCallProfiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tool: "Glob",
          directory: ".",
          pattern: "**/*.java",
        }),
        expect.objectContaining({
          tool: "Grep",
          searchPath: "src",
          pattern: "UserSession",
        }),
        expect.objectContaining({
          tool: "Read",
          filePath: "src/UserSession.java",
        }),
      ]),
    );
  });

  it("captures successful Glob result filenames in tool profiles", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_glob_assets",
                name: "Glob",
                input: {
                  directory: "src/core/design-system/icons/assets/action",
                  pattern: "*.svg",
                },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_glob_assets",
                content: {
                  filenames: [
                    "src/core/design-system/icons/assets/action/expand-all.svg",
                    "src/core/design-system/icons/assets/action/collapse-all.svg",
                  ],
                },
              },
            ],
          },
        };
        yield buildSuccessResult({ result: '{"result":"ok"}' });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-glob-filenames", "/tmp");

    const result = await runAgent({
      taskId: "glob-filenames-test",
      taskPrompt: "Find icon assets",
      repoIds: ["workspace-glob-filenames"],
      allowedTools: ["Glob"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.toolCallProfiles).toEqual([
      expect.objectContaining({
        tool: "Glob",
        directory: "src/core/design-system/icons/assets/action",
        pattern: "*.svg",
        filenames: [
          "src/core/design-system/icons/assets/action/expand-all.svg",
          "src/core/design-system/icons/assets/action/collapse-all.svg",
        ],
      }),
    ]);
  });

  it("estimates Claude cost using cache usage when total_cost_usd is missing", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildSuccessResult({
          total_cost_usd: undefined,
          usage: {
            input_tokens: 500_000,
            output_tokens: 50_000,
            cache_read_input_tokens: 200_000,
            cache_creation_input_tokens: 100_000,
          },
          modelUsage: {
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
              input_tokens: 500_000,
              output_tokens: 50_000,
            },
          },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-cache-pricing", "/tmp");

    const result = await runAgent({
      taskId: "planner-cache-pricing-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-cache-pricing"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.tokensUsed).toEqual({
      input: 500_000,
      output: 50_000,
      cacheRead: 200_000,
      cacheWrite: 100_000,
    });
    expect(result.metrics.costUsd).toBe(2.9535);
    expect(result.metrics.costUsdExact).toBe(false);
  });

  it("fails when the Claude SDK returns an execution error result", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "partial output" }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        };
        yield buildErrorResult();
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-error", "/tmp");

    const result = await runAgent({
      taskId: "planner-error-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-error"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(false);
    expect(result.output).toBe("partial output");
    expect(result.error).toContain("Error during execution: command failed");
  });

  it("preserves cache token counts on failure when estimating cost", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield buildErrorResult({
          total_cost_usd: undefined,
          usage: {
            input_tokens: 500_000,
            output_tokens: 50_000,
            cache_read_input_tokens: 200_000,
            cache_creation_input_tokens: 100_000,
          },
          modelUsage: {
            "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
              input_tokens: 500_000,
              output_tokens: 50_000,
            },
          },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-cache-pricing-failure", "/tmp");

    const result = await runAgent({
      taskId: "planner-cache-pricing-failure-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-cache-pricing-failure"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(false);
    expect(result.metrics.tokensUsed).toEqual({
      input: 500_000,
      output: 50_000,
      cacheRead: 200_000,
      cacheWrite: 100_000,
    });
    expect(result.metrics.costUsd).toBe(2.9535);
  });

  it("classifies idle watchdog aborts after partial stream silence", async () => {
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "partial output that never completed",
            },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-idle-timeout", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-idle-timeout-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-idle-timeout"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("idle_timeout");
    expect(result.error).toContain("SDK_IDLE_TIMEOUT");
  });

  it("classifies strict post-tool idle watchdog aborts separately", async () => {
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_read_post_idle",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_read_post_idle",
                content: "file contents",
              },
            ],
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-post-tool-idle-timeout", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-post-tool-idle-timeout-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-post-tool-idle-timeout"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 90_000,
      postToolIdleTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("post_tool_idle_timeout");
    expect(result.error).toContain("SDK_POST_TOOL_IDLE_TIMEOUT");
    expect(result.metrics.sdkLifecycleSummary?.postToolIdleTimeoutMs).toBe(
      1_000,
    );
  });

  it("honors compaction grace before aborting for idle silence", async () => {
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "system",
          subtype: "status",
          status: "compacting",
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-compaction-grace", "/tmp");

    let settled = false;
    const resultPromise = runAgent({
      taskId: "planner-compaction-grace-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-compaction-grace"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      idleTimeoutMs: 1_000,
      compactionGraceMs: 15_000,
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("idle_timeout");
  });

  it("uses the longer tool idle timeout while a tool call is in flight", async () => {
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        await options.canUseTool?.(
          "Bash",
          { command: "git status --short" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
          },
        );
        await simulatePreToolUse(
          options,
          "Bash",
          { command: "git status --short" },
          "tool-1",
        );

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-idle-timeout", "/tmp");

    let settled = false;
    const resultPromise = runAgent({
      taskId: "planner-tool-idle-timeout-test",
      taskPrompt: "Wait for the in-flight tool watchdog",
      repoIds: ["workspace-tool-idle-timeout"],
      allowedTools: ["Bash"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      idleTimeoutMs: 1_000,
      toolIdleTimeoutMs: 30_000,
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("tool_stall");
    expect(result.error).toContain("30000ms");

    const stalledCall = loggerMock.warn.mock.calls.find(
      ([payload, message]) =>
        message === "[SDK_STALLED_POST_TOOLS]" &&
        typeof payload === "object" &&
        payload !== null,
    );

    expect(stalledCall).toBeDefined();

    const [payload] = stalledCall!;
    expect(payload).toEqual(
      expect.objectContaining({
        lastToolName: "Bash",
        failureKind: "tool_stall",
      }),
    );
  });

  it("starts the tool timeout budget when the tool is admitted", async () => {
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "thinking before tool",
            },
          },
        };

        await sleep(25_000);

        await options.canUseTool?.(
          "Bash",
          { command: "git status --short" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-2",
          },
        );
        await simulatePreToolUse(
          options,
          "Bash",
          { command: "git status --short" },
          "tool-2",
        );

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-budget-start", "/tmp");

    let settled = false;
    const resultPromise = runAgent({
      taskId: "planner-tool-budget-start-test",
      taskPrompt: "Ensure tool timeout resets at admission",
      repoIds: ["workspace-tool-budget-start"],
      allowedTools: ["Bash"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      idleTimeoutMs: 30_000,
      toolIdleTimeoutMs: 30_000,
      includePartialMessages: true,
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(25_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(25_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("tool_stall");
    expect(result.error).toContain("30000ms");
  });

  it("allows safe Bash commands in read-only mode", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        const decision = await options.canUseTool?.(
          "Bash",
          { command: "git status --short" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
          },
        );

        expect(decision).toEqual({
          behavior: "allow",
          updatedInput: { command: "git status --short" },
        });

        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-read-only-bash", "/tmp");

    const result = await runAgent({
      taskId: "planner-read-only-bash-test",
      taskPrompt: "Inspect git status",
      repoIds: ["workspace-read-only-bash"],
      allowedTools: ["Bash"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      allowWrite: false,
    });

    expect(result.success).toBe(true);
  });

  it("denies Bash commands outside a scoped allowlist", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        const allowed = await options.canUseTool?.(
          "Bash",
          { command: "git log --oneline origin/main..origin/release" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
          },
        );
        const denied = await options.canUseTool?.(
          "Bash",
          { command: "git checkout release" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-2",
          },
        );
        const deniedWriteFlag = await options.canUseTool?.(
          "Bash",
          {
            command:
              "git log --output=/tmp/history.txt origin/main..origin/release",
          },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-3",
          },
        );

        expect(allowed?.behavior).toBe("allow");
        expect(denied).toEqual({
          behavior: "deny",
          message: "Command blocked by scoped Bash allowlist for this run.",
        });
        expect(deniedWriteFlag).toEqual({
          behavior: "deny",
          message: "Command blocked by scoped Bash allowlist for this run.",
        });

        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-scoped-bash", "/tmp");

    const result = await runAgent({
      taskId: "planner-scoped-bash-test",
      taskPrompt: "Inspect git history",
      repoIds: ["workspace-scoped-bash"],
      allowedTools: ["Bash"],
      allowedBashCommandPatterns: [
        "^git\\s+log\\s+(?:--oneline\\s+)?origin/[A-Za-z0-9._/-]+\\.\\.origin/[A-Za-z0-9._/-]+$",
      ],
      maxTurns: 1,
      maxBudgetUsd: 1,
      allowWrite: false,
    });

    expect(result.success).toBe(true);
  });

  it("never includes raw thinking delta text in stalled-run warning logs", async () => {
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "thinking_delta",
              thinking: "sensitive internal reasoning should never reach logs",
            },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-thinking-redaction", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-thinking-redaction-test",
      taskPrompt: "Trigger idle timeout after thinking deltas",
      repoIds: ["workspace-thinking-redaction"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.success).toBe(false);

    const stalledCall = loggerMock.warn.mock.calls.find(
      ([payload, message]) =>
        message === "[SDK_STALLED_NO_TOOLS]" &&
        typeof payload === "object" &&
        payload !== null,
    );

    expect(stalledCall).toBeDefined();

    const [payload] = stalledCall!;
    expect(payload).toEqual(
      expect.objectContaining({
        preview: "",
        previewSource: "empty",
        thinkingBytesAccumulated: expect.any(Number),
      }),
    );
    expect(JSON.stringify(payload)).not.toContain(
      "sensitive internal reasoning should never reach logs",
    );
  });

  it("includes thinking tail and lastStreamEventType when sdkStallThinkingPreview=tail", async () => {
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "thinking_delta",
              thinking: "model was mid-reasoning when bedrock stalled",
            },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-thinking-preview", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-thinking-preview-test",
      taskPrompt: "Trigger idle timeout after thinking deltas with preview on",
      repoIds: ["workspace-thinking-preview"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 1_000,
      sdkStallThinkingPreview: "tail",
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.success).toBe(false);

    const stalledCall = loggerMock.warn.mock.calls.find(
      ([payload, message]) =>
        message === "[SDK_STALLED_NO_TOOLS]" &&
        typeof payload === "object" &&
        payload !== null,
    );

    expect(stalledCall).toBeDefined();

    const [payload] = stalledCall!;
    expect(payload).toEqual(
      expect.objectContaining({
        thinkingPreview: expect.stringContaining(
          "model was mid-reasoning when bedrock stalled",
        ),
        lastStreamEventType: "content_block_delta",
      }),
    );
  });

  it("suppresses post-tool-idle stall when recent active deltas show the model is still producing output", async () => {
    // The failure mode we saw on CPDEV-21561: model finished tools, then
    // emitted thinking/text deltas ("I have enough context, let me produce
    // the plan..."), then paused ~25s to synthesize structured output.
    // With a strict 30s postToolIdleTimeoutMs this used to abort, even
    // though the model had produced 5+ deltas just seconds earlier.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        // 1 completed tool -> advances toolCalls past 0
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_read_active_delta",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_read_active_delta",
                content: "file contents",
              },
            ],
          },
        };

        // Five active thinking deltas (crosses the 3-delta threshold)
        for (let i = 0; i < 5; i++) {
          yield {
            type: "stream_event",
            event: {
              type: "content_block_delta",
              delta: {
                type: "thinking_delta",
                thinking: `reasoning chunk ${i} `,
              },
            },
          };
        }

        // Now the model "pauses" — no more deltas until we abort.
        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-active-delta-grace", "/tmp");

    let settled = false;
    const resultPromise = runAgent({
      taskId: "planner-active-delta-grace-test",
      taskPrompt: "Return structured output after reasoning",
      repoIds: ["workspace-active-delta-grace"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 60_000,
      postToolIdleTimeoutMs: 30_000,
    }).finally(() => {
      settled = true;
    });

    // Advance 35s — past the strict 30s post-tool idle.
    // With active-delta grace in effect, this should NOT abort.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(settled).toBe(false);

    // Advance to 65s total — deltas are now stale vs the 60s generous
    // window, so strict post-tool fires. This is the intentional behavior:
    // grace is temporary; genuine silence still aborts.
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("post_tool_idle_timeout");
  });

  it("still fires strict post-tool idle timeout when the model produced fewer than 3 deltas", async () => {
    // Safeguard: a single-delta-then-catatonia case should NOT get the
    // generous treatment. This keeps true post-tool stalls detected fast.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_single_delta",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_single_delta",
                content: "file contents",
              },
            ],
          },
        };

        // Only 2 deltas — below the 3-delta threshold.
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "hm " },
          },
        };
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "thinking " },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-single-delta-strict", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-single-delta-strict-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-single-delta-strict"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 90_000,
      postToolIdleTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("post_tool_idle_timeout");
    expect(result.error).toContain("SDK_POST_TOOL_IDLE_TIMEOUT");

    const stalledCall = loggerMock.warn.mock.calls.find(
      ([payload, message]) =>
        message === "[SDK_STALLED_POST_TOOLS]" &&
        typeof payload === "object" &&
        payload !== null,
    );
    expect(stalledCall).toBeDefined();
    const [payload] = stalledCall!;
    expect(payload).toEqual(
      expect.objectContaining({
        lastStreamDeltaType: "thinking_delta",
        activeDeltaCount: 2,
      }),
    );
  });

  it("strict post-tool idle timeout still fires when no active deltas arrive at all", async () => {
    // Regression anchor for genuine post-tool catatonia: tools finished,
    // model went silent, no deltas. Even with the new dynamic timeout,
    // this must still trip the strict post-tool timer.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_catatonia",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_catatonia",
                content: "file contents",
              },
            ],
          },
        };
        // No deltas at all; model just goes silent.
        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-catatonia-strict", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-catatonia-strict-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-catatonia-strict"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 90_000,
      postToolIdleTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("post_tool_idle_timeout");
  });

  it("bypasses both strict and generous idle timers once input_json_delta has arrived in post-tool phase", async () => {
    // CPDEV-21565 failure mode: Bedrock emits structured-output JSON via
    // input_json_delta partials with gaps that exceed BOTH postToolIdleTimeoutMs
    // (30s strict) and idleTimeoutMs (45-60s generous). Iteration 4 extends the
    // latch to bypass both timers once emission has started; only wall
    // timeoutMs remains as the upper bound.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_latch_on",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_latch_on",
                content: "file contents",
              },
            ],
          },
        };

        // Single input_json_delta in post-tool phase — flips the latch.
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"summary":"partial',
            },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-input-json-latch", "/tmp");

    let settled = false;
    const resultPromise = runAgent({
      taskId: "planner-input-json-latch-test",
      taskPrompt: "Return structured output after tools",
      repoIds: ["workspace-input-json-latch"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      timeoutMs: 200_000,
      idleTimeoutMs: 60_000,
      postToolIdleTimeoutMs: 30_000,
    }).finally(() => {
      settled = true;
    });

    // Advance past the strict 30s. Latch set → no abort.
    await vi.advanceTimersByTimeAsync(35_000);
    expect(settled).toBe(false);

    // Advance past the generous 60s. Latch set → still no abort
    // (iteration 4 behavior; iteration 3 would have aborted here).
    await vi.advanceTimersByTimeAsync(40_000);
    expect(settled).toBe(false);

    // Advance past wall timeoutMs (200s). Wall timer is still armed.
    await vi.advanceTimersByTimeAsync(130_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("wall_timeout");
  });

  it("surfaces sawInputJsonDeltaPostTools=true in the stall log when wall timeout fires mid-emission", async () => {
    // Iteration 4: with the latch set, idle timers don't fire during
    // emission. Only wall timeoutMs can catch a true hang. When it does,
    // the [SDK_STALLED_POST_TOOLS] record must still carry
    // sawInputJsonDeltaPostTools=true so operators can distinguish
    // "wall-timeout during legitimate emission" from "wall-timeout pre-emission".
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_latch_log",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_latch_log",
                content: "file contents",
              },
            ],
          },
        };

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"summary":"',
            },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-latch-log", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-latch-log-test",
      taskPrompt: "Return structured output after tools",
      repoIds: ["workspace-latch-log"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      timeoutMs: 10_000,
      idleTimeoutMs: 5_000,
      postToolIdleTimeoutMs: 1_000,
    });

    // Advance past wall timeoutMs — the only timer that should still fire.
    await vi.advanceTimersByTimeAsync(12_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("wall_timeout");
    const stalledCall = loggerMock.warn.mock.calls.find(
      ([payload, message]) =>
        message === "[SDK_STALLED_POST_TOOLS]" &&
        typeof payload === "object" &&
        payload !== null,
    );
    expect(stalledCall).toBeDefined();
    const [payload] = stalledCall!;
    expect(payload).toEqual(
      expect.objectContaining({
        sawInputJsonDeltaPostTools: true,
      }),
    );
  });

  it("does not flip the latch when input_json_delta arrives mid-tool-call", async () => {
    // input_json_delta emitted while currentToolProfile is active (i.e. the
    // model is still streaming into the current tool's input block) must NOT
    // flip the latch — the post-tool strict guard must remain armed for the
    // NEXT post-tool window.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        // input_json_delta BEFORE any tool_result — this is a tool-input
        // stream, not a post-tool structured-output stream.
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"path":"src/',
            },
          },
        };
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_midtool_latch",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_midtool_latch",
                content: "file contents",
              },
            ],
          },
        };
        // No further deltas in post-tool phase — strict timeout should fire.
        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-midtool-latch", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-midtool-latch-test",
      taskPrompt: "Return structured output after tools",
      repoIds: ["workspace-midtool-latch"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      idleTimeoutMs: 90_000,
      postToolIdleTimeoutMs: 1_000,
    });

    await vi.advanceTimersByTimeAsync(5_001);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("post_tool_idle_timeout");
    const stalledCall = loggerMock.warn.mock.calls.find(
      ([payload, message]) =>
        message === "[SDK_STALLED_POST_TOOLS]" &&
        typeof payload === "object" &&
        payload !== null,
    );
    expect(stalledCall).toBeDefined();
    const [payload] = stalledCall!;
    expect(payload).toEqual(
      expect.objectContaining({
        sawInputJsonDeltaPostTools: false,
      }),
    );
  });

  it("latch bypass skips the generous idle check during emission (iteration 4)", async () => {
    // Primary iteration-4 behavior: after input_json_delta arrives in
    // post-tool phase, 95s of silence with idleTimeoutMs=90s should NOT
    // abort — the latch skips the entire idle check.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_bypass_generous",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_bypass_generous",
                content: "file contents",
              },
            ],
          },
        };

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"summary":"',
            },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-bypass-generous", "/tmp");

    let settled = false;
    const resultPromise = runAgent({
      taskId: "planner-bypass-generous-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-bypass-generous"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      timeoutMs: 300_000,
      idleTimeoutMs: 90_000,
      postToolIdleTimeoutMs: 30_000,
    }).finally(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(95_000);
    expect(settled).toBe(false);

    // Confirm the one-time INFO log fired for operator observability.
    const bypassLog = loggerMock.info.mock.calls.find(
      ([_payload, message]) =>
        message ===
        "[SDK_EMISSION_BYPASS] Structured-output emission detected; idle watchdog standing down for the remainder of the run",
    );
    expect(bypassLog).toBeDefined();

    // Cancel the run so the test doesn't hang waiting for wall timeout.
    await vi.advanceTimersByTimeAsync(210_000);
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("wall_timeout");
  });

  it("latch bypass does not cover wall timeoutMs — wall timer still armed during emission", async () => {
    // Safety: the latch only bypasses the idle watchdog, not the wall timer.
    // A truly hung Bedrock stream must still be caught by timeoutMs.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_wall_still_armed",
                name: "Read",
                input: { path: "src/example.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_wall_still_armed",
                content: "file contents",
              },
            ],
          },
        };

        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"jiraKey":"',
            },
          },
        };

        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-wall-still-armed", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-wall-still-armed-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-wall-still-armed"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      timeoutMs: 15_000,
      idleTimeoutMs: 120_000,
      postToolIdleTimeoutMs: 30_000,
    });

    await vi.advanceTimersByTimeAsync(20_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("wall_timeout");
  });

  it("latch bypass does not affect tool-in-flight idle behavior", async () => {
    // When a new tool call starts AFTER emission has begun, the bypass
    // must not short-circuit the tool idle timer. currentToolProfile != null
    // during the tool window reactivates the tool-idle path.
    vi.useFakeTimers();

    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        // First tool — short.
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_first",
                name: "Read",
                input: { path: "src/first.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_first",
                content: "first contents",
              },
            ],
          },
        };

        // Post-tool input_json_delta — flips the latch.
        yield {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "input_json_delta",
              partial_json: '{"summary":"',
            },
          },
        };

        // Second tool starts AFTER the latch is set.
        yield {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_second_hangs",
                name: "Read",
                input: { path: "src/second.ts" },
              },
            ],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };

        // Tool never completes — no tool_result, no more stream events.
        await waitForAbort(options.abortController?.signal);
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-after-latch", "/tmp");

    const resultPromise = runAgent({
      taskId: "planner-tool-after-latch-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-tool-after-latch"],
      allowedTools: ["Read"],
      maxTurns: 2,
      maxBudgetUsd: 1,
      includePartialMessages: true,
      timeoutMs: 200_000,
      idleTimeoutMs: 120_000,
      toolIdleTimeoutMs: 2_000,
      postToolIdleTimeoutMs: 30_000,
    });

    // Advance past toolIdleTimeoutMs (2s). Tool is in flight after the latch
    // was set, so the tool-idle guard must still fire.
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await resultPromise;

    expect(result.success).toBe(false);
    expect(result.failureKind).toBe("tool_stall");
  });

  it("prefers the canonical SDK result payload over partial assistant text", async () => {
    queryMock.mockImplementation(() => {
      async function* messages() {
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: '{"result":"partial"}' }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        };
        yield buildSuccessResult({
          result: '{"result":"final"}',
          structured_output: { result: "final" },
          session_id: "session-canonical",
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-canonical", "/tmp");

    const result = await runAgent({
      taskId: "planner-canonical-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-canonical"],
      outputSchema: {
        type: "object",
        properties: {
          result: { type: "string" },
        },
        required: ["result"],
      },
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.output).toBe('{"result":"final"}');
    expect(result.structuredOutput).toEqual({ result: "final" });
    expect(result.sessionId).toBe("session-canonical");
  });

  it("does not double-count tool calls when progress callbacks are enabled", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        await options.canUseTool?.(
          "Read",
          { path: "README.md" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
          },
        );
        await simulatePreToolUse(
          options,
          "Read",
          { path: "README.md" },
          "tool-1",
        );
        yield {
          type: "assistant",
          message: {
            content: [{ type: "text", text: '{"result":"ok"}' }],
            usage: {
              input_tokens: 1,
              output_tokens: 1,
            },
          },
        };
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const progress = vi.fn();
    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-progress", "/tmp");

    const result = await runAgent({
      taskId: "planner-progress-test",
      taskPrompt: "Return structured output",
      repoIds: ["workspace-progress"],
      allowedTools: ["Read"],
      maxTurns: 1,
      maxBudgetUsd: 1,
      onProgress: progress,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.toolCalls).toBe(1);
    expect(progress).toHaveBeenCalled();
  });

  it("finalizes the last tool profile from the tool_result payload instead of leaving output bytes empty", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        await options.canUseTool?.(
          "Bash",
          { command: "echo ok" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-1",
          },
        );
        await simulatePreToolUse(
          options,
          "Bash",
          { command: "echo ok" },
          "tool-1",
        );
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: "exit code: 0\nok",
                is_error: false,
              },
            ],
          },
        };
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-profile", "/tmp");

    const result = await runAgent({
      taskId: "tool-profile-success",
      taskPrompt: "Run a bash command",
      repoIds: ["workspace-tool-profile"],
      allowedTools: ["Bash"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.toolCallProfiles).toEqual([
      expect.objectContaining({
        tool: "Bash",
        outputBytes: expect.any(Number),
        success: true,
        exitCode: 0,
      }),
    ]);
    expect(result.metrics.toolCallProfiles?.[0].outputBytes).toBeGreaterThan(0);
  });

  it("marks tool profiles as failed when tool_result reports an error", async () => {
    queryMock.mockImplementation(({ options }) => {
      async function* messages() {
        await options.canUseTool?.(
          "Bash",
          { command: "echo failure" },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-2",
          },
        );
        await simulatePreToolUse(
          options,
          "Bash",
          { command: "echo failure" },
          "tool-2",
        );
        yield {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                content: "exit code: 2\nfailure",
                is_error: true,
              },
            ],
          },
        };
        yield buildSuccessResult({
          result: '{"result":"ok"}',
          structured_output: { result: "ok" },
        });
      }

      return messages();
    });

    const { registerRepo, runAgent } = await import("./index.js");
    registerRepo("workspace-tool-profile-error", "/tmp");

    const result = await runAgent({
      taskId: "tool-profile-error",
      taskPrompt: "Run a failing bash command",
      repoIds: ["workspace-tool-profile-error"],
      allowedTools: ["Bash"],
      maxTurns: 1,
      maxBudgetUsd: 1,
    });

    expect(result.success).toBe(true);
    expect(result.metrics.toolCallProfiles).toEqual([
      expect.objectContaining({
        tool: "Bash",
        success: false,
        exitCode: 2,
      }),
    ]);
  });

  describe("tools availability cap", () => {
    it("sets sdkOptions.tools equal to the resolved tool set", async () => {
      let capturedOptions:
        | Parameters<typeof queryMock>[0]["options"]
        | undefined;

      queryMock.mockImplementation(({ options }) => {
        capturedOptions = options;

        async function* messages() {
          yield buildSuccessResult({
            result: '{"result":"ok"}',
            structured_output: { result: "ok" },
          });
        }

        return messages();
      });

      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-tools-cap", "/tmp");

      const result = await runAgent({
        taskId: "tools-cap-test",
        taskPrompt: "Return structured output",
        repoIds: ["workspace-tools-cap"],
        permissionLevel: "read_only",
        maxTurns: 1,
        maxBudgetUsd: 1,
      });

      expect(result.success).toBe(true);
      expect(capturedOptions).toBeDefined();
      // Real SDK availability cap — must be set (not undefined), otherwise
      // the model sees every built-in tool (Task, WebFetch, NotebookEdit, ...).
      expect(capturedOptions!.tools).toBeDefined();
      // tools (availability cap) and allowedTools (auto-approve) should be
      // the same resolved list — we never expose a tool we don't auto-approve.
      expect(capturedOptions!.tools).toEqual(capturedOptions!.allowedTools);
      // read_only resolves to Read, Glob, Grep, Bash, BashOutput.
      expect(capturedOptions!.tools).toEqual(
        expect.arrayContaining(["Read", "Glob", "Grep", "Bash"]),
      );
      expect(capturedOptions!.tools).not.toContain("Edit");
      expect(capturedOptions!.tools).not.toContain("Write");
    });

    it("canUseTool denies tools not in the resolved set", async () => {
      let capturedOptions:
        | Parameters<typeof queryMock>[0]["options"]
        | undefined;

      queryMock.mockImplementation(({ options }) => {
        capturedOptions = options;

        async function* messages() {
          yield buildSuccessResult({
            result: '{"result":"ok"}',
            structured_output: { result: "ok" },
          });
        }

        return messages();
      });

      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-default-deny", "/tmp");

      const result = await runAgent({
        taskId: "default-deny-test",
        taskPrompt: "Return structured output",
        repoIds: ["workspace-default-deny"],
        permissionLevel: "read_only",
        maxTurns: 1,
        maxBudgetUsd: 1,
      });

      expect(result.success).toBe(true);
      expect(capturedOptions).toBeDefined();
      expect(capturedOptions!.canUseTool).toBeDefined();

      const decision = await capturedOptions!.canUseTool!(
        "WebSearch",
        { query: "x" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-out-of-set",
        },
      );

      expect(decision).toEqual(
        expect.objectContaining({
          behavior: "deny",
          message: expect.stringContaining("WebSearch"),
        }),
      );
    });

    it("canUseTool constrains Agent calls to configured programmatic subagents", async () => {
      let capturedOptions:
        | Parameters<typeof queryMock>[0]["options"]
        | undefined;
      const agents = {
        "oneshot-grounding-scout": {
          description: "Read-only OneShot grounding scout.",
          prompt: "Inspect repository evidence and return concise findings.",
          tools: ["Read", "Glob", "Grep"],
          model: "us.anthropic.claude-haiku-test-v1:0",
          disallowedTools: ["Agent", "Task"],
          maxTurns: 24,
        },
      };

      queryMock.mockImplementation(({ options }) => {
        capturedOptions = options;

        async function* messages() {
          yield buildSuccessResult({
            result: '{"result":"ok"}',
            structured_output: { result: "ok" },
          });
        }

        return messages();
      });

      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-agent-policy", "/tmp");

      const result = await runAgent({
        taskId: "agent-policy-test",
        taskPrompt: "Return structured output",
        repoIds: ["workspace-agent-policy"],
        permissionLevel: "read_only",
        allowedTools: ["Read", "Agent"],
        agents,
        maxTurns: 1,
        maxBudgetUsd: 1,
      });

      expect(result.success).toBe(true);
      expect(capturedOptions?.canUseTool).toBeDefined();

      await expect(
        capturedOptions!.canUseTool!(
          "Agent",
          {
            subagent_type: "oneshot-grounding-scout",
            description: "Inspect target files",
            prompt: "Find relevant evidence.",
          },
          {
            signal: new AbortController().signal,
            toolUseID: "tool-agent-allowed",
          },
        ),
      ).resolves.toMatchObject({ behavior: "allow" });

      const readDecision = await capturedOptions!.canUseTool!(
        "Read",
        { file_path: "src/oneshot/providers/claude-planner.ts" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-read-agent-policy",
        },
      );
      expect(readDecision).toMatchObject({ behavior: "allow" });

      const missingType = await capturedOptions!.canUseTool!(
        "Agent",
        { description: "Inspect target files", prompt: "Find evidence." },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-missing-type",
        },
      );
      expect(missingType).toEqual(
        expect.objectContaining({
          behavior: "deny",
          message: expect.stringContaining("subagent_type"),
        }),
      );

      const unknownType = await capturedOptions!.canUseTool!(
        "Agent",
        { subagent_type: "general-purpose", prompt: "Find evidence." },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-agent-unknown-type",
        },
      );
      expect(unknownType).toEqual(
        expect.objectContaining({
          behavior: "deny",
          message: expect.stringContaining("oneshot-grounding-scout"),
        }),
      );

      for (const field of [
        "run_in_background",
        "model",
        "mode",
        "isolation",
        "name",
        "team_name",
      ]) {
        const denied = await capturedOptions!.canUseTool!(
          "Agent",
          {
            subagent_type: "oneshot-grounding-scout",
            prompt: "Find evidence.",
            [field]: field === "run_in_background" ? true : "blocked",
          },
          {
            signal: new AbortController().signal,
            toolUseID: `tool-agent-denied-${field}`,
          },
        );
        expect(denied).toEqual(
          expect.objectContaining({
            behavior: "deny",
            message: expect.stringContaining(field),
          }),
        );
      }

      const webDecision = await capturedOptions!.canUseTool!(
        "WebSearch",
        { query: "x" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-web-agent-policy",
        },
      );
      expect(webDecision).toEqual(
        expect.objectContaining({ behavior: "deny" }),
      );
    });

    it("PreToolUse constrains Agent calls to configured programmatic subagents without telemetry leakage", async () => {
      const agents = {
        "oneshot-grounding-scout": {
          description: "Read-only OneShot grounding scout.",
          prompt: "Inspect repository evidence and return concise findings.",
          tools: ["Read", "Glob", "Grep"],
          model: "us.anthropic.claude-haiku-test-v1:0",
          disallowedTools: ["Agent", "Task"],
          maxTurns: 24,
        },
      };

      queryMock.mockImplementation(({ options }) => {
        async function* messages() {
          const allowed = await simulatePreToolUse(
            options,
            "Agent",
            {
              subagent_type: "oneshot-grounding-scout",
              description: "Inspect target files",
              prompt: "Find relevant evidence.",
            },
            "tool-agent-hook-allowed",
          );
          expect(allowed).toEqual({});

          await options.hooks.PostToolUse[0].hooks[0](
            {
              hook_event_name: "PostToolUse",
              tool_name: "Agent",
              tool_input: {
                subagent_type: "oneshot-grounding-scout",
                description: "Inspect target files",
                prompt: "Find relevant evidence.",
              },
              tool_response: "scout complete",
              tool_use_id: "tool-agent-hook-allowed",
            },
            "tool-agent-hook-allowed",
          );

          const missingType = await simulatePreToolUse(
            options,
            "Agent",
            { description: "Inspect target files", prompt: "Find evidence." },
            "tool-agent-hook-missing-type",
          );
          expect(missingType).toEqual({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: expect.stringContaining(
                "subagent_type",
              ),
            },
          });

          const unknownType = await simulatePreToolUse(
            options,
            "Agent",
            { subagent_type: "general-purpose", prompt: "Find evidence." },
            "tool-agent-hook-unknown-type",
          );
          expect(unknownType).toEqual({
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: expect.stringContaining(
                "oneshot-grounding-scout",
              ),
            },
          });

          for (const field of [
            "run_in_background",
            "model",
            "mode",
            "isolation",
            "name",
            "team_name",
          ]) {
            const denied = await simulatePreToolUse(
              options,
              "Agent",
              {
                subagent_type: "oneshot-grounding-scout",
                prompt: "Find evidence.",
                [field]: field === "run_in_background" ? true : "blocked",
              },
              `tool-agent-hook-denied-${field}`,
            );
            expect(denied).toEqual({
              hookSpecificOutput: {
                hookEventName: "PreToolUse",
                permissionDecision: "deny",
                permissionDecisionReason: expect.stringContaining(field),
              },
            });
          }

          const readDecision = await simulatePreToolUse(
            options,
            "Read",
            { file_path: "src/oneshot/providers/claude-planner.ts" },
            "tool-read-hook-agent-policy",
          );
          expect(readDecision).toEqual({});

          await options.hooks.PostToolUse[0].hooks[0](
            {
              hook_event_name: "PostToolUse",
              tool_name: "Read",
              tool_input: {
                file_path: "src/oneshot/providers/claude-planner.ts",
              },
              tool_response: "source",
              tool_use_id: "tool-read-hook-agent-policy",
            },
            "tool-read-hook-agent-policy",
          );

          yield buildSuccessResult({
            result: '{"result":"ok"}',
            structured_output: { result: "ok" },
          });
        }

        return messages();
      });

      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-agent-hook-policy", "/tmp");

      const result = await runAgent({
        taskId: "agent-hook-policy-test",
        taskPrompt: "Return structured output",
        repoIds: ["workspace-agent-hook-policy"],
        permissionLevel: "read_only",
        allowedTools: ["Read", "Agent"],
        agents,
        maxTurns: 1,
        maxBudgetUsd: 10,
      });

      expect(result.success).toBe(true);
      expect(result.metrics.toolCalls).toBe(2);
      expect(result.metrics.toolCallProfiles).toHaveLength(2);
      expect(
        result.metrics.toolCallProfiles?.map((profile) => profile.tool),
      ).toEqual(["Agent", "Read"]);
      const agentDenials =
        result.metrics.sdkLifecycleSummary?.permissionDenials?.filter(
          (denial) =>
            !!denial &&
            typeof denial === "object" &&
            !Array.isArray(denial) &&
            (denial as Record<string, unknown>).tool_name === "Agent",
        ) ?? [];
      expect(agentDenials).toHaveLength(8);
      expect(agentDenials[0]).toMatchObject({
        source: "pre_tool_use_policy",
        reason: expect.stringContaining("subagent_type"),
      });
    });

    it("canUseTool denies repeated planner search sprawl while allowing reads", async () => {
      let capturedOptions:
        | Parameters<typeof queryMock>[0]["options"]
        | undefined;

      queryMock.mockImplementation(({ options }) => {
        capturedOptions = options;

        async function* messages() {
          yield buildSuccessResult({
            result: '{"result":"ok"}',
            structured_output: { result: "ok" },
          });
        }

        return messages();
      });

      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-sprawl-guard", "/tmp");

      const result = await runAgent({
        taskId: "sprawl-guard-test",
        taskPrompt: "Return structured output",
        repoIds: ["workspace-sprawl-guard"],
        permissionLevel: "read_only",
        toolSprawlGuard: { enabled: true, maxRepeatedSearches: 2 },
        maxTurns: 1,
        maxBudgetUsd: 1,
      });

      expect(result.success).toBe(true);
      expect(capturedOptions?.canUseTool).toBeDefined();

      const readDecision = await capturedOptions!.canUseTool!(
        "Read",
        { file_path: "src/oneshot/providers/claude-planner.ts" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-read-focused",
        },
      );
      expect(readDecision).toMatchObject({ behavior: "allow" });

      const first = await capturedOptions!.canUseTool!(
        "Glob",
        { pattern: "**/*" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-glob-1",
        },
      );
      const second = await capturedOptions!.canUseTool!(
        "Glob",
        { pattern: "**/*" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-glob-2",
        },
      );
      const third = await capturedOptions!.canUseTool!(
        "Glob",
        { pattern: "**/*" },
        {
          signal: new AbortController().signal,
          toolUseID: "tool-glob-3",
        },
      );

      expect(first).toMatchObject({ behavior: "allow" });
      expect(second).toMatchObject({ behavior: "allow" });
      expect(third).toMatchObject({
        behavior: "deny",
        message: expect.stringContaining("search-sprawl guard"),
      });
    });
  });

  describe("blocked bash bookkeeping", () => {
    it("denied bash commands do not inflate toolCalls or leave in-flight state", async () => {
      let capturedOptions:
        | Parameters<typeof queryMock>[0]["options"]
        | undefined;

      queryMock.mockImplementation(({ options }) => {
        capturedOptions = options;

        async function* messages() {
          // Simulate the model attempting a dangerous command that should
          // be blocked by the Bash denylist — this must NOT advance the
          // toolCalls counter or create a pending tool profile.
          const denied = await options.canUseTool?.(
            "Bash",
            { command: "sudo rm -rf /" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-blocked-1",
            },
          );

          expect(denied).toEqual(expect.objectContaining({ behavior: "deny" }));

          // Now issue a legitimate tool call. If bookkeeping leaked from
          // the denied call, toolCalls would end at 2 instead of 1.
          const allowed = await options.canUseTool?.(
            "Bash",
            { command: "git status --short" },
            {
              signal: new AbortController().signal,
              toolUseID: "tool-allowed-1",
            },
          );

          expect(allowed).toEqual(
            expect.objectContaining({ behavior: "allow" }),
          );

          const hooks = options.hooks as any;
          await hooks.PreToolUse[0].hooks[0](
            {
              hook_event_name: "PreToolUse",
              tool_name: "Bash",
              tool_input: { command: "git status --short" },
              tool_use_id: "tool-allowed-1",
            },
            "tool-allowed-1",
          );
          await hooks.PostToolUse[0].hooks[0](
            {
              hook_event_name: "PostToolUse",
              tool_name: "Bash",
              tool_input: { command: "git status --short" },
              tool_response: "clean",
              tool_use_id: "tool-allowed-1",
            },
            "tool-allowed-1",
          );

          yield buildSuccessResult({
            result: '{"result":"ok"}',
            structured_output: { result: "ok" },
          });
        }

        return messages();
      });

      const { registerRepo, runAgent } = await import("./index.js");
      registerRepo("workspace-blocked-bash-bookkeeping", "/tmp");

      const result = await runAgent({
        taskId: "blocked-bash-bookkeeping-test",
        taskPrompt: "Attempt a blocked command, then a safe one",
        repoIds: ["workspace-blocked-bash-bookkeeping"],
        allowedTools: ["Bash"],
        maxTurns: 1,
        maxBudgetUsd: 1,
      });

      expect(result.success).toBe(true);
      expect(capturedOptions).toBeDefined();

      // Core assertion: denied call did not leak into the counter.
      // Only the one allowed call should be counted.
      expect(result.metrics.toolCalls).toBe(1);

      // Also confirm the denied call did not leave a phantom profile.
      // Exactly one profile should exist — the allowed Bash call.
      expect(result.metrics.toolCallProfiles).toHaveLength(1);
      expect(result.metrics.toolCallProfiles?.[0]).toEqual(
        expect.objectContaining({ tool: "Bash" }),
      );
    });
  });
});
