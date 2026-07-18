import {
  query,
  type Options,
  type SDKMessage,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from "@aws-sdk/client-bedrock-runtime";
import { WatchdogServiceError } from "./watchdogErrors.js";

export type WatchdogLlmProviderKey = "claude_agent_sdk" | "bedrock_runtime";

export interface WatchdogLlmFinding {
  kind?: string;
  severity?: string;
  title?: string;
  summary?: string;
  details?: Record<string, unknown>;
  confidence?: number;
  evidenceIds?: string[];
}

export interface WatchdogLlmAnalysis {
  findings?: WatchdogLlmFinding[];
}

export interface WatchdogLlmRequest {
  systemPrompt: string;
  userPrompt: string;
  maxTokens?: number;
  schema?: Record<string, unknown>;
  timeoutMs?: number;
}

export interface WatchdogLlmResponse<T> {
  providerKey: WatchdogLlmProviderKey;
  modelId: string;
  text: string;
  parsed: T;
  metrics: {
    durationMs: number;
    toolCalls: number;
    inputTokens?: number;
    outputTokens?: number;
    costUsd?: number;
    sessionId?: string;
  };
}

const WATCHDOG_ANALYSIS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "severity", "title", "summary", "details", "confidence", "evidenceIds"],
        properties: {
          kind: { type: "string", enum: ["finding", "limitation", "no_evidence"] },
          severity: { type: "string", enum: ["info", "low", "medium", "high", "critical"] },
          title: { type: "string", maxLength: 180 },
          summary: { type: "string", maxLength: 1000 },
          details: {
            type: "object",
            additionalProperties: true,
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceIds: {
            type: "array",
            items: { type: "string" },
          },
        },
      },
    },
  },
} satisfies Record<string, unknown>;

export function getWatchdogLlmConfig(): {
  providerKey: WatchdogLlmProviderKey;
  modelId: string;
  region: string;
  configured: boolean;
  message?: string;
} {
  const modelId =
    process.env.WATCHDOG_LLM_MODEL_ID?.trim() ||
    process.env.ANTHROPIC_MODEL?.trim() ||
    process.env.BEDROCK_MODEL?.trim() ||
    process.env.BEDROCK_MODEL_ID?.trim() ||
    "us.anthropic.claude-sonnet-4-6";
  const region =
    process.env.WATCHDOG_BEDROCK_REGION?.trim() ||
    process.env.AWS_REGION?.trim() ||
    "us-east-2";

  return {
    providerKey: "claude_agent_sdk",
    modelId,
    region,
    configured: Boolean(modelId),
    message: modelId,
  };
}

export async function runWatchdogLlmJson<T>(
  request: WatchdogLlmRequest,
): Promise<WatchdogLlmResponse<T>> {
  const config = getWatchdogLlmConfig();
  if (!config.configured) {
    throw new WatchdogServiceError("Watchdog Claude model is not configured", 503, "llm_not_configured");
  }

  const startedAt = Date.now();
  const env = {
    ...process.env,
    CLAUDE_CODE_USE_BEDROCK: "1",
    AWS_REGION: config.region,
    ANTHROPIC_MODEL: config.modelId,
    ...(request.maxTokens ? { CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(request.maxTokens) } : {}),
  };
  const options: Options = {
    cwd: process.cwd(),
    env,
    systemPrompt: request.systemPrompt,
    allowedTools: [],
    tools: [],
    disallowedTools: ["Bash", "Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "WebFetch", "Task"],
    maxTurns: Number(process.env.WATCHDOG_CLAUDE_MAX_TURNS || "1"),
    maxBudgetUsd: Number(process.env.WATCHDOG_CLAUDE_MAX_BUDGET_USD || "1"),
    settingSources: [],
    outputFormat: {
      type: "json_schema",
      schema: WATCHDOG_ANALYSIS_SCHEMA,
    },
    permissionMode: "default",
  };

  let assistantText = "";
  let resultText = "";
  let structuredOutput: unknown;
  let sessionId: string | undefined;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd: number | undefined;
  let success = false;

  const timeoutMs = Math.max(5_000, request.timeoutMs || Number(process.env.WATCHDOG_CLAUDE_TIMEOUT_MS || "120000"));
  await withTimeout((async () => {
    for await (const message of query({ prompt: request.userPrompt, options: {
      ...options,
      outputFormat: {
        type: "json_schema",
        schema: request.schema || WATCHDOG_ANALYSIS_SCHEMA,
      },
    } })) {
    const typedMessage = message as SDKMessage;
    if (typedMessage.type === "system" && "session_id" in typedMessage) {
      sessionId = typedMessage.session_id as string;
    }
    if (typedMessage.type === "assistant" && "message" in typedMessage && typedMessage.message?.content) {
      for (const block of typedMessage.message.content) {
        if (typeof block === "object" && block && "type" in block && block.type === "text" && "text" in block) {
          assistantText += String(block.text);
        }
      }
      if (typedMessage.message.usage) {
        inputTokens += typedMessage.message.usage.input_tokens || 0;
        outputTokens += typedMessage.message.usage.output_tokens || 0;
      }
    }
    if (typedMessage.type === "result") {
      const result = typedMessage as SDKResultMessage;
      sessionId = result.session_id || sessionId;
      if ("total_cost_usd" in result && typeof result.total_cost_usd === "number") {
        costUsd = result.total_cost_usd;
      }
      if ("usage" in result && result.usage) {
        inputTokens = result.usage.input_tokens || inputTokens;
        outputTokens = result.usage.output_tokens || outputTokens;
      }
      if (result.subtype === "success") {
        success = true;
        if ("result" in result && typeof result.result === "string") {
          resultText = result.result;
        }
        if ("structured_output" in result) {
          structuredOutput = result.structured_output;
        }
      } else {
        throw new WatchdogServiceError(`Claude Agent SDK returned ${result.subtype}`, 502, "llm_provider_failed");
      }
    }
    }
  })(), timeoutMs);

  if (!success) {
    throw new WatchdogServiceError("Claude Agent SDK completed without a success result", 502, "llm_provider_failed");
  }

  const text = resultText || assistantText;
  return {
    providerKey: config.providerKey,
    modelId: config.modelId,
    text,
    parsed: (structuredOutput !== undefined ? structuredOutput : parseJsonResponse<T>(text)) as T,
    metrics: {
      durationMs: Date.now() - startedAt,
      toolCalls: 0,
      inputTokens: inputTokens || undefined,
      outputTokens: outputTokens || undefined,
      costUsd,
      sessionId,
    },
  };
}

export async function runWatchdogBedrockJson<T>(
  request: WatchdogLlmRequest,
): Promise<WatchdogLlmResponse<T>> {
  const config = getWatchdogLlmConfig();
  if (!config.configured) {
    throw new WatchdogServiceError("Watchdog Claude model is not configured", 503, "llm_not_configured");
  }

  const startedAt = Date.now();
  const timeoutMs = Math.max(5_000, request.timeoutMs || Number(process.env.WATCHDOG_PREVIEW_LLM_TIMEOUT_MS || "45000"));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const client = new BedrockRuntimeClient({ region: config.region });
    const body = {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: request.maxTokens || 900,
      temperature: 0,
      system: [
        request.systemPrompt,
        "Return a single valid JSON object only. Do not include markdown fences or explanatory text.",
      ].join("\n"),
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.userPrompt }],
        },
      ],
    };

    const response = await client.send(new InvokeModelCommand({
      modelId: config.modelId,
      contentType: "application/json",
      accept: "application/json",
      body: Buffer.from(JSON.stringify(body)),
    }), { abortSignal: controller.signal });

    const decoded = new TextDecoder().decode(response.body);
    const payload = JSON.parse(decoded) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    const text = (payload.content || [])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new WatchdogServiceError("Bedrock response did not contain text", 502, "llm_provider_failed");
    }

    return {
      providerKey: "bedrock_runtime",
      modelId: config.modelId,
      text,
      parsed: parseJsonResponse<T>(text),
      metrics: {
        durationMs: Date.now() - startedAt,
        toolCalls: 0,
        inputTokens: payload.usage?.input_tokens,
        outputTokens: payload.usage?.output_tokens,
      },
    };
  } catch (error) {
    if ((error as Error).name === "AbortError") {
      throw new WatchdogServiceError(
        `Bedrock preview exceeded ${timeoutMs}ms timeout`,
        504,
        "llm_timeout",
      );
    }
    if (error instanceof WatchdogServiceError) throw error;
    throw new WatchdogServiceError(
      `Bedrock preview failed: ${error instanceof Error ? error.message : String(error)}`,
      502,
      "llm_provider_failed",
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new WatchdogServiceError(
            `Claude Agent SDK exceeded ${timeoutMs}ms timeout`,
            504,
            "llm_timeout",
          ));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function parseJsonResponse<T>(text: string): T {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() || extractFirstJsonObject(trimmed);
  try {
    return JSON.parse(candidate) as T;
  } catch (error) {
    throw new WatchdogServiceError(
      `LLM response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      502,
      "llm_json_invalid",
    );
  }
}

function extractFirstJsonObject(text: string): string {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new WatchdogServiceError("LLM response did not contain a JSON object", 502, "llm_json_missing");
  }
  return text.slice(start, end + 1);
}
