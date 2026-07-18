import { createLogger } from "../../utils/logger.js";
import type {
  ClaimedOutboxEvent,
  SpecFactoryOutboxRepository,
} from "./outbox.js";

const logger = createLogger("spec-factory-outbox-relay");

export interface OutboxPublisher {
  publish(event: ClaimedOutboxEvent): Promise<void>;
}

export class SpecFactoryOutboxRelay {
  constructor(
    private readonly repository: Pick<
      SpecFactoryOutboxRepository,
      "claimBatch" | "markPublished" | "markFailed"
    >,
    private readonly publisher: OutboxPublisher,
    private readonly options: {
      workerId: string;
      batchSize?: number;
      leaseMs?: number;
      maxAttempts?: number;
      retryBaseMs?: number;
      concurrency?: number;
    },
  ) {}

  async drainOnce(): Promise<number> {
    const leaseMs = this.options.leaseMs ?? 60_000;
    const events = await this.repository.claimBatch({
      workerId: this.options.workerId,
      leaseUntil: new Date(Date.now() + leaseMs),
      limit: this.options.batchSize ?? 50,
    });
    await mapWithConcurrency(
      events,
      this.options.concurrency ?? 10,
      async (event) => {
        try {
          await this.publisher.publish(event);
          const marked = await this.repository.markPublished({
            id: event.id,
            workerId: this.options.workerId,
          });
          if (!marked) throw new Error("outbox_publish_fence_rejected");
        } catch (error) {
          const retryMs =
            (this.options.retryBaseMs ?? 1_000) *
            2 ** Math.min(8, Math.max(0, event.publishAttempts - 1));
          await this.repository.markFailed({
            id: event.id,
            workerId: this.options.workerId,
            error: errorMessage(error),
            retryAt: new Date(Date.now() + retryMs),
            maxAttempts: this.options.maxAttempts ?? 12,
          });
          logger.warn(
            { err: error, outboxId: event.id, eventType: event.eventType },
            "Spec Factory outbox publish failed",
          );
        }
      },
    );
    return events.length;
  }
}

async function mapWithConcurrency<T>(
  values: T[],
  concurrency: number,
  mapper: (value: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, concurrency), values.length) },
      async () => {
        while (cursor < values.length) {
          const index = cursor;
          cursor += 1;
          await mapper(values[index]!);
        }
      },
    ),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
