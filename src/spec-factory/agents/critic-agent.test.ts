import { describe, expect, it, vi } from "vitest";
import {
  CriticExecutor,
  createCriticExecutorRegistry,
} from "./critic-agent.js";
import type { ClaimedAgentTask } from "../compose-database.js";

function task(input: unknown): ClaimedAgentTask {
  return {
    id: 601,
    sessionId: 7,
    turnJobId: 101,
    capability: "critic_review",
    executorType: "critic_review",
    status: "running",
    input,
    leaseGeneration: 2,
    activeWorkerId: "worker-a",
  };
}

describe("CriticExecutor", () => {
  it("reviews an answer through the LLM Gateway and returns structured output", async () => {
    const review = {
      verdict: "needs_revision",
      confidence: "medium",
      summary: "One claim needs stronger evidence.",
      findings: [
        {
          severity: "medium",
          claim: "Retry handling is in compose-service.ts.",
          issue: "Evidence points to compose-database.ts.",
          evidence: "generated research task 501",
          recommendation: "Cite compose-database.ts instead.",
        },
      ],
    };
    const llmGateway = {
      generateObject: vi.fn().mockResolvedValue(review),
    };
    const executor = new CriticExecutor(llmGateway);

    await expect(
      executor.execute(
        task({
          userMessage: "Where is retry implemented?",
          answer: "Retry handling is in compose-service.ts.",
          workingContextMarkdown: "# Context",
          generatedResearch: [{ sourceId: 31, summary: "Retry evidence" }],
          contextVersionUsed: 4,
        }),
      ),
    ).resolves.toEqual({
      output: {
        review,
        input: {
          userMessage: "Where is retry implemented?",
          answer: "Retry handling is in compose-service.ts.",
          contextVersionUsed: 4,
        },
      },
      contextVersionUsed: 4,
    });

    expect(llmGateway.generateObject).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        turnJobId: 101,
        agentTaskId: 601,
        purpose: "critic_review",
        promptVersion: "critic_review@v1",
        contextVersionUsed: 4,
      }),
    );
    expect(llmGateway.generateObject.mock.calls[0]?.[0].prompt).toContain(
      "Retry handling is in compose-service.ts.",
    );
  });

  it("rejects tasks without review material before calling the gateway", async () => {
    const llmGateway = {
      generateObject: vi.fn(),
    };
    const executor = new CriticExecutor(llmGateway);

    await expect(executor.execute(task({}))).rejects.toThrow(
      "critic_input_missing_review_material",
    );
    expect(llmGateway.generateObject).not.toHaveBeenCalled();
  });

  it("accepts null optional text fields from queued critic tasks", async () => {
    const review = {
      verdict: "supported",
      confidence: "high",
      summary: "The answer is grounded.",
      findings: [],
    };
    const llmGateway = {
      generateObject: vi.fn().mockResolvedValue(review),
    };
    const executor = new CriticExecutor(llmGateway);

    await expect(
      executor.execute(
        task({
          userMessage: null,
          answer: "Use compose-database.ts.",
          workingContextMarkdown: null,
          generatedResearch: [],
          contextVersionUsed: null,
        }),
      ),
    ).resolves.toEqual({
      output: {
        review,
        input: {
          userMessage: null,
          answer: "Use compose-database.ts.",
          contextVersionUsed: null,
        },
      },
      contextVersionUsed: null,
    });
  });

  it("builds a registry with the critic executor", () => {
    const registry = createCriticExecutorRegistry({
      generateObject: vi.fn(),
    });

    expect(registry.listExecutorTypes()).toEqual(["critic_review"]);
  });
});
