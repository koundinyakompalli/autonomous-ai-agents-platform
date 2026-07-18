import { describe, expect, it, vi } from "vitest";
import { AgentTaskExecutorRegistry } from "./executor-registry.js";

describe("AgentTaskExecutorRegistry", () => {
  it("dispatches a claimed task to the registered executor", async () => {
    const execute = vi.fn().mockResolvedValue({
      output: { summary: "distilled" },
      contextVersionUsed: 4,
      outputSourceId: 12,
    });
    const registry = new AgentTaskExecutorRegistry([
      {
        executorType: "source_distillation",
        execute,
      },
    ]);
    const task = {
      id: 501,
      sessionId: 7,
      turnJobId: 101,
      capability: "source_distillation",
      executorType: "source_distillation",
      status: "running",
      input: { sourceId: 12 },
      leaseGeneration: 2,
      activeWorkerId: "agent-worker-a",
    };

    await expect(registry.execute(task)).resolves.toEqual({
      output: { summary: "distilled" },
      contextVersionUsed: 4,
      outputSourceId: 12,
    });

    expect(execute).toHaveBeenCalledWith(task);
  });

  it("rejects tasks without a registered executor", async () => {
    const registry = new AgentTaskExecutorRegistry();

    await expect(
      registry.execute({
        id: 501,
        sessionId: 7,
        turnJobId: null,
        capability: "code_research",
        executorType: "code_research",
        status: "running",
        input: {},
        leaseGeneration: 1,
        activeWorkerId: "agent-worker-a",
      }),
    ).rejects.toThrow("unknown_executor:code_research");
  });
});
