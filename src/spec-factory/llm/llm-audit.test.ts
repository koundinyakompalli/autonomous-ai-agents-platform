import { describe, expect, it, vi } from "vitest";
import {
  SpecFactoryLlmCallAuditRepository,
  resolveLlmPromptLoggingMode,
} from "./llm-audit.js";

describe("resolveLlmPromptLoggingMode", () => {
  it("defaults prompt/response artifact logging to none", () => {
    expect(resolveLlmPromptLoggingMode(undefined)).toBe("none");
    expect(resolveLlmPromptLoggingMode("")).toBe("none");
  });

  it("accepts explicit prompt logging modes", () => {
    expect(resolveLlmPromptLoggingMode("redacted")).toBe("redacted");
    expect(resolveLlmPromptLoggingMode("full")).toBe("full");
    expect(resolveLlmPromptLoggingMode(" none ")).toBe("none");
  });

  it("rejects invalid prompt logging modes", () => {
    expect(() => resolveLlmPromptLoggingMode("raw")).toThrow(
      "invalid_llm_prompt_logging_mode:raw",
    );
  });
});

describe("SpecFactoryLlmCallAuditRepository", () => {
  it("inserts LLM call audit rows with nullable product correlation IDs", async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 42 }]);
    const repository = new SpecFactoryLlmCallAuditRepository({
      query,
    } as never);

    await expect(
      repository.recordCall({
        sessionId: 7,
        turnJobId: 101,
        agentTaskId: null,
        requestId: "request-llm-42",
        purpose: "chat_coordinator_fast",
        provider: "bedrock",
        model: "claude-fast",
        promptVersion: "chat_coordinator@v1",
        contextVersionUsed: 4,
        inputTokens: 12,
        outputTokens: 8,
        latencyMs: 1234,
        estimatedCostUsd: 0.012345,
        status: "succeeded",
        redactedPromptUri: "s3://audit/prompt.txt",
        redactedResponseUri: "s3://audit/response.txt",
      }),
    ).resolves.toBe(42);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("INSERT INTO spec_factory_llm_calls"),
      [
        7,
        101,
        null,
        "request-llm-42",
        "chat_coordinator_fast",
        "bedrock",
        "claude-fast",
        "chat_coordinator@v1",
        4,
        12,
        8,
        20,
        1234,
        0.012345,
        "succeeded",
        null,
        "s3://audit/prompt.txt",
        "s3://audit/response.txt",
      ],
    );
  });

  it("stores failed calls without token usage or artifact URIs", async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 43 }]);
    const repository = new SpecFactoryLlmCallAuditRepository({
      query,
    } as never);

    await repository.recordCall({
      purpose: "conversation_summary",
      provider: "bedrock",
      model: "claude-global",
      latencyMs: 50,
      status: "failed",
      errorCode: "Bedrock throttled",
    });

    expect(query.mock.calls[0][1]).toEqual([
      null,
      null,
      null,
      null,
      "conversation_summary",
      "bedrock",
      "claude-global",
      null,
      null,
      null,
      null,
      null,
      50,
      null,
      "failed",
      "Bedrock throttled",
      null,
      null,
    ]);
  });

  it("truncates error codes to the schema limit before insert", async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 44 }]);
    const repository = new SpecFactoryLlmCallAuditRepository({
      query,
    } as never);
    const longErrorCode = `bedrock:${"x".repeat(180)}`;

    await repository.recordCall({
      purpose: "conversation_summary",
      provider: "bedrock",
      model: "claude-global",
      status: "failed",
      errorCode: longErrorCode,
    });

    const params = query.mock.calls[0][1];
    expect(params[15]).toHaveLength(128);
    expect(params[15]).toBe(longErrorCode.slice(0, 128));
  });

  it("sums session and global daily budget usage", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          session_cost_usd: "1.250000",
          global_day_cost_usd: "4.500000",
        },
      ],
    ]);
    const repository = new SpecFactoryLlmCallAuditRepository({
      query,
    } as never);
    const since = new Date("2026-07-06T00:00:00.000Z");

    await expect(
      repository.getBudgetUsage({ sessionId: 7, since }),
    ).resolves.toEqual({
      sessionCostUsd: 1.25,
      globalDayCostUsd: 4.5,
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("SUM(estimated_cost_usd)"),
      [7, since, since],
    );
  });

  it("lists old audit artifact URIs for retention cleanup", async () => {
    const query = vi.fn().mockResolvedValue([
      [
        {
          id: 9,
          redacted_prompt_uri: "file:///audit/9/prompt.txt",
          redacted_response_uri: "file:///audit/9/response.txt",
        },
      ],
    ]);
    const repository = new SpecFactoryLlmCallAuditRepository({
      query,
    } as never);
    const createdBefore = new Date("2026-06-01T00:00:00.000Z");

    await expect(
      repository.listAuditArtifactsForRetention({
        createdBefore,
        limit: 20,
      }),
    ).resolves.toEqual([
      {
        id: 9,
        redactedPromptUri: "file:///audit/9/prompt.txt",
        redactedResponseUri: "file:///audit/9/response.txt",
      },
    ]);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("FROM spec_factory_llm_calls"),
      [createdBefore, 20],
    );
  });

  it("clears retained audit artifact URIs only after cleanup succeeds", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }]);
    const repository = new SpecFactoryLlmCallAuditRepository({
      query,
    } as never);

    await expect(repository.clearAuditArtifactUris(9)).resolves.toBe(1);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("UPDATE spec_factory_llm_calls"),
      [9],
    );
  });
});
