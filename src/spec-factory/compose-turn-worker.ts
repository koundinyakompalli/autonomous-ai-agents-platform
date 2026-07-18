import { createLogger, type Logger } from "../utils/logger.js";
import type {
  ClaimedTurnJob,
  ComposeRepository,
  ExpiredClarificationTurn,
  ExpiredTurnLeaseRecoveryResult,
} from "./compose-database.js";
import type { ComposeChatEvent } from "./compose-types.js";
import {
  specFactoryMetrics,
  type SpecFactoryMetrics,
} from "./telemetry/metrics.js";
import { withSpecFactorySpan } from "./telemetry/tracing.js";

const DEFAULT_TURN_LEASE_MS = 300_000;
const DEFAULT_MAX_TURNS_PER_DRAIN = 25;
const DEFAULT_MAX_CONCURRENT_TURNS = 8;
const DEFAULT_RECOVERY_LIMIT = 100;
const DEFAULT_CLARIFICATION_EXPIRY_LIMIT = 100;
const EXPIRED_LEASE_MESSAGE =
  "Durable turn lease expired before the worker completed";

export interface ComposeTurnWorkerDrainResult {
  recovered: ExpiredTurnLeaseRecoveryResult;
  expiredClarifications: number;
  claimed: number;
  completed: number;
  failed: number;
}

export interface ComposeTurnWorkerRepository {
  claimNextTurnJob(input: {
    workerId: string;
    leaseUntil: Date;
  }): Promise<ClaimedTurnJob | null>;
  recoverExpiredTurnLeases(input: {
    expiredBefore: Date;
    limit: number;
    abandonedErrorMessage?: string;
  }): Promise<ExpiredTurnLeaseRecoveryResult>;
  expireStaleClarificationTurns(input: {
    expiredBefore: Date;
    limit: number;
  }): Promise<ExpiredClarificationTurn[]>;
}

export interface ComposeTurnWorkerService {
  executeClaimedTurn(job: ClaimedTurnJob): Promise<void>;
}

interface TurnWorkerEventPublisher {
  appendSessionEvent(input: {
    sessionId: number;
    eventType: string;
    payload: unknown;
    actorType?: string | null;
    actorId?: string | null;
    turnJobId?: number | null;
  }): Promise<unknown>;
}

interface TurnWorkerLivePublisher {
  publish(sessionId: number, event: ComposeChatEvent): void | Promise<void>;
}

export class ComposeTurnWorker {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxTurnsPerDrain: number;
  private readonly maxConcurrentTurns: number;
  private readonly recoveryLimit: number;
  private readonly clarificationExpiryLimit: number;
  private readonly eventPublisher?: TurnWorkerEventPublisher;
  private readonly livePublisher?: TurnWorkerLivePublisher;
  private readonly logger: Pick<Logger, "error">;
  private readonly metrics: Pick<
    SpecFactoryMetrics,
    "recordLeaseEvent" | "recordWorkStarted" | "recordWorkCompleted"
  >;
  private running = false;

  constructor(
    private readonly repository: ComposeTurnWorkerRepository &
      Pick<
        ComposeRepository,
        | "claimNextTurnJob"
        | "recoverExpiredTurnLeases"
        | "expireStaleClarificationTurns"
      >,
    private readonly service: ComposeTurnWorkerService,
    options: {
      workerId?: string;
      leaseMs?: number;
      maxTurnsPerDrain?: number;
      maxConcurrentTurns?: number;
      recoveryLimit?: number;
      clarificationExpiryLimit?: number;
      eventPublisher?: TurnWorkerEventPublisher;
      livePublisher?: TurnWorkerLivePublisher;
      logger?: Pick<Logger, "error">;
      metrics?: Pick<
        SpecFactoryMetrics,
        "recordLeaseEvent" | "recordWorkStarted" | "recordWorkCompleted"
      >;
    } = {},
  ) {
    this.workerId = options.workerId ?? `compose-turn-worker-${process.pid}`;
    this.leaseMs = positiveInteger(options.leaseMs, DEFAULT_TURN_LEASE_MS);
    this.maxTurnsPerDrain = positiveInteger(
      options.maxTurnsPerDrain,
      DEFAULT_MAX_TURNS_PER_DRAIN,
    );
    this.maxConcurrentTurns = positiveInteger(
      options.maxConcurrentTurns,
      DEFAULT_MAX_CONCURRENT_TURNS,
    );
    this.recoveryLimit = positiveInteger(
      options.recoveryLimit,
      DEFAULT_RECOVERY_LIMIT,
    );
    this.clarificationExpiryLimit = positiveInteger(
      options.clarificationExpiryLimit,
      DEFAULT_CLARIFICATION_EXPIRY_LIMIT,
    );
    this.eventPublisher = options.eventPublisher;
    this.livePublisher = options.livePublisher;
    this.logger = options.logger ?? createLogger("compose-turn-worker");
    this.metrics = options.metrics ?? specFactoryMetrics;
  }

  async drain(): Promise<ComposeTurnWorkerDrainResult> {
    if (this.running) return emptyResult();
    this.running = true;
    const result = emptyResult();
    try {
      const now = new Date(Date.now());
      result.recovered = await this.repository.recoverExpiredTurnLeases({
        expiredBefore: now,
        limit: this.recoveryLimit,
        abandonedErrorMessage: EXPIRED_LEASE_MESSAGE,
      });
      this.metrics.recordLeaseEvent({
        workType: "turn",
        event: "expired",
        count: result.recovered.requeued + result.recovered.abandoned,
      });
      const expiredClarifications =
        await this.repository.expireStaleClarificationTurns({
          expiredBefore: now,
          limit: this.clarificationExpiryLimit,
        });
      result.expiredClarifications = expiredClarifications.length;
      for (const turn of expiredClarifications) {
        await this.publishClarificationExpired(turn);
      }
      while (result.claimed < this.maxTurnsPerDrain) {
        const batchSize = Math.min(
          this.maxConcurrentTurns,
          this.maxTurnsPerDrain - result.claimed,
        );
        const claimed = (
          await Promise.all(
            Array.from({ length: batchSize }, () =>
              this.repository.claimNextTurnJob({
                workerId: this.workerId,
                leaseUntil: new Date(Date.now() + this.leaseMs),
              }),
            ),
          )
        ).filter((job): job is ClaimedTurnJob => job != null);
        if (claimed.length === 0) break;
        result.claimed += claimed.length;
        await this.executeClaimedBatch(claimed, result);
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private async executeClaimedBatch(
    jobs: ClaimedTurnJob[],
    result: ComposeTurnWorkerDrainResult,
  ): Promise<void> {
    const bySession = new Map<number, ClaimedTurnJob[]>();
    for (const job of jobs) {
      const sessionJobs = bySession.get(job.sessionId) ?? [];
      sessionJobs.push(job);
      bySession.set(job.sessionId, sessionJobs);
    }
    await Promise.all(
      [...bySession.values()].map(async (sessionJobs) => {
        for (const job of sessionJobs) await this.executeJob(job, result);
      }),
    );
  }

  private async executeJob(
    job: ClaimedTurnJob,
    result: ComposeTurnWorkerDrainResult,
  ): Promise<void> {
    const startedAt = Date.now();
    this.metrics.recordWorkStarted({
      workType: "turn",
      subtype: job.turnKind,
      queuedAt: job.queuedAt,
      startedAt,
    });
    try {
      await withSpecFactorySpan(
        "turn.execute",
        {
          requestId: job.requestId ?? undefined,
          sessionId: job.sessionId,
          turnJobId: job.id,
          workerId: this.workerId,
          leaseGeneration: job.leaseGeneration,
        },
        async (span) => {
          span.setAttribute("spec_factory.turn_kind", job.turnKind);
          await this.service.executeClaimedTurn(job);
        },
      );
      result.completed += 1;
      this.metrics.recordWorkCompleted({
        workType: "turn",
        subtype: job.turnKind,
        outcome: "succeeded",
        startedAt,
      });
    } catch (error) {
      result.failed += 1;
      const fenceRejected =
        error instanceof Error && /lease was lost/i.test(error.message);
      if (fenceRejected) {
        this.metrics.recordLeaseEvent({
          workType: "turn",
          event: "fence_rejected",
          subtype: job.turnKind,
        });
      }
      this.metrics.recordWorkCompleted({
        workType: "turn",
        subtype: job.turnKind,
        outcome: fenceRejected ? "fence_rejected" : "failed",
        startedAt,
      });
      this.logger.error(
        { err: error, turnJobId: job.id, sessionId: job.sessionId },
        "Compose durable turn execution failed",
      );
    }
  }

  private async publishClarificationExpired(
    turn: ExpiredClarificationTurn,
  ): Promise<void> {
    if (this.eventPublisher) {
      try {
        await this.eventPublisher.appendSessionEvent({
          sessionId: turn.sessionId,
          eventType: "turn.clarification_expired",
          payload: { turnJobId: turn.turnJobId },
          actorType: "system",
          actorId: this.workerId,
          turnJobId: turn.turnJobId,
        });
      } catch (error) {
        this.logger.error(
          { err: error, turnJobId: turn.turnJobId, sessionId: turn.sessionId },
          "Compose turn clarification expiration event failed",
        );
      }
    }
    if (this.livePublisher) {
      try {
        await this.livePublisher.publish(turn.sessionId, {
          type: "status",
          status: "error",
          code: "clarification_expired",
          message:
            "Clarification expired. Send a new message to continue with fresh context.",
        });
      } catch (error) {
        this.logger.error(
          { err: error, turnJobId: turn.turnJobId, sessionId: turn.sessionId },
          "Compose turn clarification expiration live publish failed",
        );
      }
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function emptyResult(): ComposeTurnWorkerDrainResult {
  return {
    recovered: { requeued: 0, abandoned: 0, skippedWithOutput: 0 },
    expiredClarifications: 0,
    claimed: 0,
    completed: 0,
    failed: 0,
  };
}
