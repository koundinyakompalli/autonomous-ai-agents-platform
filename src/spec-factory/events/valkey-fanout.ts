import { createClient, type RedisClientType } from "redis";
import {
  CanonicalSessionEventSchema,
  type CanonicalSessionEvent,
} from "./canonical-event.js";

export interface SessionEventFanout {
  publish(event: CanonicalSessionEvent): Promise<void>;
  subscribe(
    listener: (event: CanonicalSessionEvent) => void | Promise<void>,
  ): Promise<() => Promise<void>>;
  close(): Promise<void>;
}

export interface ValkeySessionEventFanoutOptions {
  url: string;
  channelPrefix?: string;
  connectTimeoutMs?: number;
}

export class ValkeySessionEventFanout implements SessionEventFanout {
  private readonly publisher: RedisClientType;
  private readonly subscriber: RedisClientType;
  private readonly channelPrefix: string;
  private publisherConnect: Promise<unknown> | null = null;
  private subscriberConnect: Promise<unknown> | null = null;

  constructor(private readonly options: ValkeySessionEventFanoutOptions) {
    const socket = {
      connectTimeout: Math.max(250, options.connectTimeoutMs ?? 2_000),
      reconnectStrategy: (retries: number) =>
        Math.min(5_000, 100 * 2 ** retries),
    };
    this.publisher = createClient({ url: options.url, socket });
    this.subscriber = createClient({ url: options.url, socket });
    this.channelPrefix = options.channelPrefix ?? "spec-factory:session-events";
  }

  async publish(event: CanonicalSessionEvent): Promise<void> {
    await this.ensurePublisher();
    await this.publisher.publish(
      `${this.channelPrefix}:${event.sessionId}`,
      JSON.stringify(event),
    );
  }

  async subscribe(
    listener: (event: CanonicalSessionEvent) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    await this.ensureSubscriber();
    const pattern = `${this.channelPrefix}:*`;
    await this.subscriber.pSubscribe(pattern, async (message) => {
      try {
        const event = CanonicalSessionEventSchema.parse(JSON.parse(message));
        await listener(event);
      } catch {
        // A malformed live message is ignored. Durable replay remains canonical.
      }
    });
    return async () => {
      if (this.subscriber.isOpen) await this.subscriber.pUnsubscribe(pattern);
    };
  }

  async close(): Promise<void> {
    await Promise.allSettled([
      this.publisher.isOpen ? this.publisher.quit() : Promise.resolve(),
      this.subscriber.isOpen ? this.subscriber.quit() : Promise.resolve(),
    ]);
  }

  private ensurePublisher(): Promise<unknown> {
    if (!this.publisherConnect) {
      this.publisherConnect = this.publisher.connect().catch((error) => {
        this.publisherConnect = null;
        throw error;
      });
    }
    return this.publisherConnect;
  }

  private ensureSubscriber(): Promise<unknown> {
    if (!this.subscriberConnect) {
      this.subscriberConnect = this.subscriber.connect().catch((error) => {
        this.subscriberConnect = null;
        throw error;
      });
    }
    return this.subscriberConnect;
  }
}

export class InMemorySessionEventFanout implements SessionEventFanout {
  private readonly listeners = new Set<
    (event: CanonicalSessionEvent) => void | Promise<void>
  >();

  async publish(event: CanonicalSessionEvent): Promise<void> {
    await Promise.all([...this.listeners].map((listener) => listener(event)));
  }

  async subscribe(
    listener: (event: CanonicalSessionEvent) => void | Promise<void>,
  ): Promise<() => Promise<void>> {
    this.listeners.add(listener);
    return async () => {
      this.listeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }
}
