import { describe, expect, it, vi } from "vitest";
import { AgentTaskExecutorRegistry } from "./agents/executor-registry.js";
import { ComposeAgentTaskWorker } from "./compose-agent-task-worker.js";
import { currentSpecFactoryCorrelation } from "./telemetry/correlation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function claimedTask(overrides = {}) {
  return {
    id: 501,
    sessionId: 7,
    turnJobId: 101,
    capability: "source_distillation",
    executorType: "source_distillation",
    status: "running",
    requestId: "request-agent-501",
    input: { sourceId: 12 },
    leaseGeneration: 2,
    activeWorkerId: "agent-worker-a",
    queuedAt: "2026-07-05T09:59:57.000Z",
    ...overrides,
  };
}

function buildWorker(options = {}) {
  const repository = {
    claimNextAgentTask: vi.fn(),
    startAgentRuntimeRun: vi.fn().mockResolvedValue(7001),
    finishAgentRuntimeRun: vi.fn().mockResolvedValue(true),
    completeAgentTask: vi.fn().mockResolvedValue(true),
    markAgentTaskFailed: vi.fn().mockResolvedValue(true),
    recoverExpiredAgentTaskLeases: vi.fn().mockResolvedValue({
      requeued: 0,
      abandoned: 0,
    }),
    enqueueContextMergeTaskIfNeeded: vi.fn().mockResolvedValue(null),
  };
  const execute = vi.fn().mockResolvedValue({
    output: { summary: "distilled" },
    contextVersionUsed: 4,
    outputSourceId: 12,
  });
  const executors = new AgentTaskExecutorRegistry([
    { executorType: "source_distillation", execute },
    { executorType: "context_merge", execute },
    { executorType: "handoff_build", execute },
  ]);
  const eventPublisher = {
    appendSessionEvent: vi.fn().mockResolvedValue({ id: 900 }),
  };
  const logger = {
    error: vi.fn(),
  };
  const worker = new ComposeAgentTaskWorker(repository as never, executors, {
    workerId: "agent-worker-a",
    leaseMs: 60_000,
    maxTasksPerDrain: 3,
    capabilities: ["source_distillation", "context_merge"],
    eventPublisher,
    logger,
    ...options,
  });
  return { worker, repository, execute, eventPublisher, logger };
}

describe("ComposeAgentTaskWorker", () => {
  it("uses a default lease long enough for the research runner timeout", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00.000Z"));
    try {
      const { worker, repository } = buildWorker({ leaseMs: undefined });
      repository.claimNextAgentTask.mockResolvedValueOnce(null);

      await worker.drain();

      expect(repository.claimNextAgentTask).toHaveBeenCalledWith({
        workerId: "agent-worker-a",
        leaseUntil: new Date("2026-07-05T10:15:00.000Z"),
        capabilities: ["source_distillation", "context_merge"],
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain claims queued agent tasks, executes them, and completes with the current lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00.000Z"));
    try {
      const { worker, repository, execute, eventPublisher } = buildWorker();
      repository.claimNextAgentTask
        .mockResolvedValueOnce(claimedTask())
        .mockResolvedValueOnce(null);

      await expect(worker.drain()).resolves.toEqual({
        recovered: { requeued: 0, abandoned: 0 },
        claimed: 1,
        completed: 1,
        failed: 0,
      });

      expect(repository.recoverExpiredAgentTaskLeases).toHaveBeenCalledWith({
        expiredBefore: new Date("2026-07-05T10:00:00.000Z"),
        limit: 100,
        abandonedErrorMessage:
          "Agent task lease expired before the worker completed",
      });
      expect(repository.claimNextAgentTask).toHaveBeenCalledWith({
        workerId: "agent-worker-a",
        leaseUntil: new Date("2026-07-05T10:01:00.000Z"),
        capabilities: ["source_distillation", "context_merge"],
      });
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({ id: 501 }),
      );
      expect(repository.startAgentRuntimeRun).toHaveBeenCalledWith({
        sessionId: 7,
        agentTaskId: 501,
        executorType: "source_distillation",
        workspaceUri: null,
      });
      expect(repository.completeAgentTask).toHaveBeenCalledWith({
        agentTaskId: 501,
        workerId: "agent-worker-a",
        leaseGeneration: 2,
        output: { summary: "distilled" },
        contextVersionUsed: 4,
        outputSourceId: 12,
      });
      expect(repository.finishAgentRuntimeRun).toHaveBeenCalledWith({
        runtimeRunId: 7001,
        status: "completed",
        provider: null,
        model: null,
        traceUri: null,
        outputArtifactUri: null,
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
        errorCode: null,
        errorMessage: null,
      });
      expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 7,
          eventType: "task.started",
          agentTaskId: 501,
        }),
      );
      expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: 7,
          eventType: "task.completed",
          agentTaskId: 501,
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("reconciles ready patches after a context merge releases its active-task fence", async () => {
    const { worker, repository } = buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(
        claimedTask({
          capability: "context_merge",
          executorType: "context_merge",
        }),
      )
      .mockResolvedValueOnce(null);

    await worker.drain();

    expect(repository.enqueueContextMergeTaskIfNeeded).toHaveBeenCalledWith({
      sessionId: 7,
    });
  });

  it("restores task correlation and records queue/run telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00.000Z"));
    try {
      const metrics = {
        recordLeaseEvent: vi.fn(),
        recordWorkStarted: vi.fn(),
        recordWorkCompleted: vi.fn(),
      };
      const { worker, repository, execute, eventPublisher } = buildWorker({
        metrics,
      });
      repository.claimNextAgentTask
        .mockResolvedValueOnce(claimedTask())
        .mockResolvedValueOnce(null);
      execute.mockImplementationOnce(async () => {
        expect(currentSpecFactoryCorrelation()).toMatchObject({
          requestId: "request-agent-501",
          sessionId: 7,
          turnJobId: 101,
          agentTaskId: 501,
          workerId: "agent-worker-a",
          leaseGeneration: 2,
        });
        return {
          output: { summary: "distilled" },
          contextVersionUsed: 4,
          outputSourceId: 12,
        };
      });

      await worker.drain();

      expect(metrics.recordWorkStarted).toHaveBeenCalledWith({
        workType: "agent_task",
        subtype: "source_distillation",
        queuedAt: "2026-07-05T09:59:57.000Z",
        startedAt: new Date("2026-07-05T10:00:00.000Z").getTime(),
      });
      expect(metrics.recordWorkCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          workType: "agent_task",
          subtype: "source_distillation",
          outcome: "succeeded",
        }),
      );
      expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: "request-agent-501" }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fail task execution when lifecycle event writes fail", async () => {
    const { worker, repository, execute, eventPublisher, logger } =
      buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(claimedTask())
      .mockResolvedValueOnce(null);
    eventPublisher.appendSessionEvent.mockRejectedValue(
      new Error("event db down"),
    );

    await expect(worker.drain()).resolves.toEqual({
      recovered: { requeued: 0, abandoned: 0 },
      claimed: 1,
      completed: 1,
      failed: 0,
    });

    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ id: 501 }));
    expect(repository.completeAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({ agentTaskId: 501 }),
    );
    expect(repository.markAgentTaskFailed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        err: expect.any(Error),
        agentTaskId: 501,
        eventType: "task.started",
      }),
      "Compose agent task event write failed",
    );
  });

  it("publishes a lease-fence event when completion loses the active lease", async () => {
    const { worker, repository, eventPublisher } = buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(claimedTask())
      .mockResolvedValueOnce(null);
    repository.completeAgentTask.mockResolvedValueOnce(false);

    await expect(worker.drain()).resolves.toEqual({
      recovered: { requeued: 0, abandoned: 0 },
      claimed: 1,
      completed: 0,
      failed: 1,
    });

    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 7,
        eventType: "task.lease_fence_rejected",
        payload: expect.objectContaining({
          capability: "source_distillation",
          executorType: "source_distillation",
          reason: "completion_rejected",
        }),
        agentTaskId: 501,
      }),
    );
    const eventTypes = eventPublisher.appendSessionEvent.mock.calls.map(
      ([input]) => input.eventType,
    );
    expect(eventTypes).not.toContain("task.completed");
  });

  it("publishes handoff completion when a handoff_build task finishes", async () => {
    const { worker, repository, execute, eventPublisher } = buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(
        claimedTask({
          turnJobId: null,
          capability: "handoff_build",
          executorType: "handoff_build",
          input: {
            sourceId: 88,
            actor: "kompallik",
            reusedExistingSource: false,
          },
        }),
      )
      .mockResolvedValueOnce(null);
    execute.mockResolvedValueOnce({
      outputSourceId: null,
      contextVersionUsed: 4,
      output: {
        sourceId: 88,
        evidenceSnapshotId: 777,
        artifactBytes: {
          markdown: 100,
          json: 50,
          total: 150,
        },
      },
    });

    await worker.drain();

    expect(repository.completeAgentTask).toHaveBeenCalledWith(
      expect.objectContaining({
        outputSourceId: null,
      }),
    );
    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.completed",
      payload: {
        sourceJiraKey: "COMPOSE-7",
        sourceId: 88,
        reusedExistingSource: false,
        enriched: true,
        buildTaskId: 501,
        artifactBytes: {
          markdown: 100,
          json: 50,
          total: 150,
        },
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: null,
      agentTaskId: 501,
      contextVersion: 4,
    });
  });

  it("publishes handoff failure when a handoff_build task fails", async () => {
    const { worker, repository, execute, eventPublisher } = buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(
        claimedTask({
          turnJobId: null,
          capability: "handoff_build",
          executorType: "handoff_build",
          input: {
            sourceId: 88,
            actor: "kompallik",
            reusedExistingSource: true,
          },
        }),
      )
      .mockResolvedValueOnce(null);
    execute.mockRejectedValueOnce(new Error("bundle write failed"));

    await worker.drain();

    expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "handoff.failed",
      payload: {
        sourceJiraKey: "COMPOSE-7",
        sourceId: 88,
        buildTaskId: 501,
        reason: "handoff_build_failed",
        message: "bundle write failed",
      },
      actorType: "user",
      actorId: "kompallik",
      turnJobId: null,
      agentTaskId: 501,
    });
  });

  it("marks a claimed task failed when the executor throws and continues", async () => {
    const { worker, repository, execute, logger } = buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(claimedTask({ id: 501 }))
      .mockResolvedValueOnce(claimedTask({ id: 502 }))
      .mockResolvedValueOnce(null);
    execute
      .mockRejectedValueOnce(new Error("distillation failed"))
      .mockResolvedValueOnce({ output: { summary: "ok" } });

    await expect(worker.drain()).resolves.toEqual({
      recovered: { requeued: 0, abandoned: 0 },
      claimed: 2,
      completed: 1,
      failed: 1,
    });

    expect(repository.markAgentTaskFailed).toHaveBeenCalledWith({
      agentTaskId: 501,
      workerId: "agent-worker-a",
      leaseGeneration: 2,
      errorCode: "executor_failed",
      errorMessage: "distillation failed",
    });
    expect(repository.finishAgentRuntimeRun).toHaveBeenCalledWith({
      runtimeRunId: 7001,
      status: "failed",
      provider: null,
      model: null,
      traceUri: null,
      outputArtifactUri: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      errorCode: "executor_failed",
      errorMessage: "distillation failed",
    });
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), agentTaskId: 501 }),
      "Compose agent task execution failed",
    );
  });

  it("does not publish failure events when the failure write loses the lease fence", async () => {
    const { worker, repository, execute, eventPublisher } = buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(
        claimedTask({
          capability: "handoff_build",
          executorType: "handoff_build",
          input: { sourceId: 88 },
        }),
      )
      .mockResolvedValueOnce(null);
    execute.mockRejectedValueOnce(new Error("stale worker failure"));
    repository.markAgentTaskFailed.mockResolvedValueOnce(false);

    await expect(worker.drain()).resolves.toMatchObject({
      claimed: 1,
      completed: 0,
      failed: 1,
    });

    expect(repository.markAgentTaskFailed).toHaveBeenCalledWith(
      expect.objectContaining({ agentTaskId: 501 }),
    );
    const eventTypes = eventPublisher.appendSessionEvent.mock.calls.map(
      ([input]) => input.eventType,
    );
    expect(eventTypes).toContain("task.started");
    expect(eventTypes).toContain("task.lease_fence_rejected");
    expect(eventTypes).not.toContain("task.failed");
    expect(eventTypes).not.toContain("handoff.failed");
  });

  it("records executor runtime metadata when provided by the executor", async () => {
    const { worker, repository, execute } = buildWorker();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(claimedTask())
      .mockResolvedValueOnce(null);
    execute.mockResolvedValueOnce({
      output: { summary: "distilled" },
      runtime: {
        provider: "bedrock",
        model: "anthropic.claude-3-5-sonnet",
        traceUri: "s3://bucket/compose/7/traces/task-501.jsonl",
        outputArtifactUri: "s3://bucket/compose/7/output/task-501.md",
        inputTokens: 1200,
        outputTokens: 300,
        estimatedCostUsd: 0.42,
      },
    });

    await worker.drain();

    expect(repository.finishAgentRuntimeRun).toHaveBeenCalledWith({
      runtimeRunId: 7001,
      status: "completed",
      provider: "bedrock",
      model: "anthropic.claude-3-5-sonnet",
      traceUri: "s3://bucket/compose/7/traces/task-501.jsonl",
      outputArtifactUri: "s3://bucket/compose/7/output/task-501.md",
      inputTokens: 1200,
      outputTokens: 300,
      estimatedCostUsd: 0.42,
      errorCode: null,
      errorMessage: null,
    });
  });

  it("drain is non-reentrant", async () => {
    const { worker, repository, execute } = buildWorker();
    const release = deferred<{ output: unknown }>();
    repository.claimNextAgentTask
      .mockResolvedValueOnce(claimedTask())
      .mockResolvedValueOnce(null);
    execute.mockReturnValueOnce(release.promise);

    const running = worker.drain();
    await expect(worker.drain()).resolves.toEqual({
      recovered: { requeued: 0, abandoned: 0 },
      claimed: 0,
      completed: 0,
      failed: 0,
    });

    release.resolve({ output: { summary: "ok" } });
    await running;
  });
});
