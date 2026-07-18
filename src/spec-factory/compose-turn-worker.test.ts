import { describe, expect, it, vi } from "vitest";
import { ComposeTurnWorker } from "./compose-turn-worker.js";
import { currentSpecFactoryCorrelation } from "./telemetry/correlation.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function claimedTurn(overrides = {}) {
  return {
    id: 101,
    sessionId: 7,
    turnKind: "chat",
    userMessageId: 51,
    status: "running",
    requestId: "request-turn-101",
    leaseGeneration: 1,
    activeWorkerId: "turn-worker-a",
    queuedAt: "2026-07-05T09:59:58.000Z",
    ...overrides,
  };
}

function buildWorker(options = {}) {
  const repository = {
    claimNextTurnJob: vi.fn(),
    recoverExpiredTurnLeases: vi.fn().mockResolvedValue({
      requeued: 0,
      abandoned: 0,
      skippedWithOutput: 0,
    }),
    expireStaleClarificationTurns: vi.fn().mockResolvedValue([]),
  };
  const service = {
    executeClaimedTurn: vi.fn().mockResolvedValue(undefined),
  };
  const eventPublisher = {
    appendSessionEvent: vi.fn().mockResolvedValue(undefined),
  };
  const livePublisher = {
    publish: vi.fn(),
  };
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const worker = new ComposeTurnWorker(repository as never, service as never, {
    workerId: "turn-worker-a",
    leaseMs: 60_000,
    maxTurnsPerDrain: 3,
    logger,
    eventPublisher,
    livePublisher,
    ...options,
  });
  return { worker, repository, service, eventPublisher, livePublisher, logger };
}

describe("ComposeTurnWorker", () => {
  it("drain claims queued durable turns and executes each claimed turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00.000Z"));
    try {
      const { worker, repository, service } = buildWorker();
      repository.claimNextTurnJob
        .mockResolvedValueOnce(claimedTurn({ id: 101 }))
        .mockResolvedValueOnce(claimedTurn({ id: 102, userMessageId: 52 }))
        .mockResolvedValueOnce(null);

      await expect(worker.drain()).resolves.toEqual({
        recovered: { requeued: 0, abandoned: 0, skippedWithOutput: 0 },
        expiredClarifications: 0,
        claimed: 2,
        completed: 2,
        failed: 0,
      });

      expect(repository.recoverExpiredTurnLeases).toHaveBeenCalledWith({
        expiredBefore: new Date("2026-07-05T10:00:00.000Z"),
        limit: 100,
        abandonedErrorMessage:
          "Durable turn lease expired before the worker completed",
      });
      expect(repository.claimNextTurnJob).toHaveBeenCalledWith({
        workerId: "turn-worker-a",
        leaseUntil: new Date("2026-07-05T10:01:00.000Z"),
      });
      expect(service.executeClaimedTurn).toHaveBeenCalledTimes(2);
      expect(service.executeClaimedTurn).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ id: 101 }),
      );
      expect(service.executeClaimedTurn).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ id: 102 }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores persisted correlation and records queue/run telemetry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00.000Z"));
    try {
      const metrics = {
        recordLeaseEvent: vi.fn(),
        recordWorkStarted: vi.fn(),
        recordWorkCompleted: vi.fn(),
      };
      const { worker, repository, service } = buildWorker({ metrics });
      repository.claimNextTurnJob
        .mockResolvedValueOnce(claimedTurn())
        .mockResolvedValueOnce(null);
      service.executeClaimedTurn.mockImplementationOnce(async () => {
        expect(currentSpecFactoryCorrelation()).toMatchObject({
          requestId: "request-turn-101",
          sessionId: 7,
          turnJobId: 101,
          workerId: "turn-worker-a",
          leaseGeneration: 1,
        });
      });

      await worker.drain();

      expect(metrics.recordWorkStarted).toHaveBeenCalledWith({
        workType: "turn",
        subtype: "chat",
        queuedAt: "2026-07-05T09:59:58.000Z",
        startedAt: new Date("2026-07-05T10:00:00.000Z").getTime(),
      });
      expect(metrics.recordWorkCompleted).toHaveBeenCalledWith(
        expect.objectContaining({
          workType: "turn",
          subtype: "chat",
          outcome: "succeeded",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain records a failed turn and continues with the next claim", async () => {
    const { worker, repository, service, logger } = buildWorker();
    repository.claimNextTurnJob
      .mockResolvedValueOnce(claimedTurn({ id: 101 }))
      .mockResolvedValueOnce(claimedTurn({ id: 102 }))
      .mockResolvedValueOnce(null);
    service.executeClaimedTurn
      .mockRejectedValueOnce(new Error("model failed"))
      .mockResolvedValueOnce(undefined);

    await expect(worker.drain()).resolves.toEqual({
      recovered: { requeued: 0, abandoned: 0, skippedWithOutput: 0 },
      expiredClarifications: 0,
      claimed: 2,
      completed: 1,
      failed: 1,
    });

    expect(service.executeClaimedTurn).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), turnJobId: 101 }),
      "Compose durable turn execution failed",
    );
  });

  it("executes different sessions concurrently", async () => {
    const { worker, repository, service } = buildWorker({
      maxConcurrentTurns: 2,
      maxTurnsPerDrain: 2,
    });
    const first = deferred<void>();
    const second = deferred<void>();
    repository.claimNextTurnJob
      .mockResolvedValueOnce(claimedTurn({ id: 101, sessionId: 7 }))
      .mockResolvedValueOnce(claimedTurn({ id: 102, sessionId: 8 }));
    service.executeClaimedTurn
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const draining = worker.drain();
    await vi.waitFor(() => {
      expect(service.executeClaimedTurn).toHaveBeenCalledTimes(2);
    });
    first.resolve();
    second.resolve();

    await expect(draining).resolves.toMatchObject({ completed: 2, failed: 0 });
  });

  it("serializes same-session jobs as a defense behind the DB exclusion", async () => {
    const { worker, repository, service } = buildWorker({
      maxConcurrentTurns: 2,
      maxTurnsPerDrain: 2,
    });
    const first = deferred<void>();
    repository.claimNextTurnJob
      .mockResolvedValueOnce(claimedTurn({ id: 101, sessionId: 7 }))
      .mockResolvedValueOnce(claimedTurn({ id: 102, sessionId: 7 }));
    service.executeClaimedTurn
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(undefined);

    const draining = worker.drain();
    await vi.waitFor(() => {
      expect(service.executeClaimedTurn).toHaveBeenCalledTimes(1);
    });
    first.resolve();
    await draining;

    expect(service.executeClaimedTurn).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ id: 102 }),
    );
  });

  it("drain is non-reentrant", async () => {
    const { worker, repository, service } = buildWorker();
    const release = deferred<void>();
    repository.claimNextTurnJob
      .mockResolvedValueOnce(claimedTurn())
      .mockResolvedValueOnce(null);
    service.executeClaimedTurn.mockReturnValueOnce(release.promise);

    const running = worker.drain();
    await expect(worker.drain()).resolves.toEqual({
      recovered: { requeued: 0, abandoned: 0, skippedWithOutput: 0 },
      expiredClarifications: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
    });

    release.resolve();
    await running;
  });

  it("drain reports expired lease recovery counts", async () => {
    const { worker, repository } = buildWorker({ recoveryLimit: 7 });
    repository.recoverExpiredTurnLeases.mockResolvedValueOnce({
      requeued: 2,
      abandoned: 1,
      skippedWithOutput: 3,
    });
    repository.claimNextTurnJob.mockResolvedValueOnce(null);

    await expect(worker.drain()).resolves.toEqual({
      recovered: { requeued: 2, abandoned: 1, skippedWithOutput: 3 },
      expiredClarifications: 0,
      claimed: 0,
      completed: 0,
      failed: 0,
    });

    expect(repository.recoverExpiredTurnLeases).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 7 }),
    );
  });

  it("expires stale clarification turns before claiming new turns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-05T10:00:00.000Z"));
    try {
      const { worker, repository, service, eventPublisher, livePublisher } =
        buildWorker();
      repository.expireStaleClarificationTurns.mockResolvedValueOnce([
        { sessionId: 7, turnJobId: 101 },
      ]);
      repository.claimNextTurnJob.mockResolvedValueOnce(null);

      await expect(worker.drain()).resolves.toEqual({
        recovered: { requeued: 0, abandoned: 0, skippedWithOutput: 0 },
        expiredClarifications: 1,
        claimed: 0,
        completed: 0,
        failed: 0,
      });

      expect(repository.expireStaleClarificationTurns).toHaveBeenCalledWith({
        expiredBefore: new Date("2026-07-05T10:00:00.000Z"),
        limit: 100,
      });
      expect(eventPublisher.appendSessionEvent).toHaveBeenCalledWith({
        sessionId: 7,
        eventType: "turn.clarification_expired",
        payload: { turnJobId: 101 },
        actorType: "system",
        actorId: "turn-worker-a",
        turnJobId: 101,
      });
      expect(livePublisher.publish).toHaveBeenCalledWith(7, {
        type: "status",
        status: "error",
        code: "clarification_expired",
        message:
          "Clarification expired. Send a new message to continue with fresh context.",
      });
      expect(service.executeClaimedTurn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
