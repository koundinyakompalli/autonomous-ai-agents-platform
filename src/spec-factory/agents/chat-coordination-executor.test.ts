import { describe, expect, it, vi } from "vitest";
import { ChatCoordinationExecutor } from "./chat-coordination-executor.js";
import type {
  CoordinatorContextBundle,
  CoordinatorDecision,
} from "./chat-coordinator.js";

function bundle(): CoordinatorContextBundle {
  return {
    sessionId: 7,
    userMessage: "Can you answer from context?",
    requestedContextVersion: 4,
    contextVersionUsed: 4,
    recentMessages: [],
    sourceStatus: {
      total: 0,
      byKind: {},
      byConversionStatus: {},
      convertedSourceIds: [],
      failedSourceIds: [],
      generatedResearchSourceIds: [],
    },
    generatedResearch: [],
    pendingTasks: [],
    capabilities: [],
  };
}

describe("ChatCoordinationExecutor", () => {
  it("wraps ChatCoordinator.decide behind the chat_coordination executor type", async () => {
    const decision: CoordinatorDecision = {
      action: "answer",
      answer: "The committed context is sufficient.",
      confidence: "high",
      contextVersionUsed: 4,
    };
    const coordinator = {
      decide: vi.fn().mockResolvedValue(decision),
    };
    const executor = new ChatCoordinationExecutor(coordinator);
    const input = bundle();

    await expect(executor.execute(input)).resolves.toEqual(decision);
    expect(executor.executorType).toBe("chat_coordination");
    expect(coordinator.decide).toHaveBeenCalledWith(input);
  });
});
