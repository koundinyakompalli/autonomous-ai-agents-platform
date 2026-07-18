import { describe, expect, it, vi } from "vitest";
import { LegacyComposeChatExecutor } from "./legacy-compose-chat-executor.js";
import type {
  ComposeChatRunInput,
  ComposeChatRunOutput,
} from "../compose-chat-agent.js";

function input(overrides: Partial<ComposeChatRunInput> = {}): ComposeChatRunInput {
  return {
    sessionId: 7,
    workspaceRepoId: "spec-factory-compose-7",
    mode: "chat",
    resumeSessionId: "claude-session-1",
    latestUserMessage: "What remains unclear?",
    codeRepoIds: ["core-app"],
    ...overrides,
  };
}

function output(): ComposeChatRunOutput {
  return {
    envelope: {
      reply: "Ask about rollout constraints.",
      readiness: {
        ready: false,
        openQuestions: ["Which regions are in scope?"],
        summary: "Need rollout boundaries.",
        details: {
          module: null,
          repositories: [],
          difficulty: null,
          loeHours: null,
          storyPoints: null,
        },
      },
    },
    sessionId: "claude-session-2",
    metrics: {
      durationMs: 123,
      toolCalls: 2,
      modelUsed: "test-model",
    },
  };
}

describe("LegacyComposeChatExecutor", () => {
  it("wraps ComposeChatAgent.run behind the legacy_compose_chat executor type", async () => {
    const chatAgent = {
      run: vi.fn().mockResolvedValue(output()),
    };
    const executor = new LegacyComposeChatExecutor(chatAgent);
    const runInput = input();

    const result = await executor.execute(runInput);

    expect(executor.executorType).toBe("legacy_compose_chat");
    expect(chatAgent.run).toHaveBeenCalledWith(runInput);
    expect(result.envelope.reply).toBe("Ask about rollout constraints.");
    expect(result.sessionId).toBe("claude-session-2");
  });

  it("propagates chat-agent failures without wrapping them", async () => {
    const chatAgent = {
      run: vi.fn().mockRejectedValue(new Error("model unavailable")),
    };
    const executor = new LegacyComposeChatExecutor(chatAgent);

    await expect(executor.execute(input({ mode: "analyze" }))).rejects.toThrow(
      "model unavailable",
    );
  });
});
