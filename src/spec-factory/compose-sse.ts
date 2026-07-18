import type { Response } from "express";
import type { ComposeChatEvent } from "./compose-types.js";
import {
  createCanonicalSessionEvent,
  type CanonicalSessionEvent,
} from "./events/canonical-event.js";

interface FormatSseEventOptions {
  id?: number | string | null;
}

interface SubscribeOptions {
  replay?: boolean;
  afterEventId?: number;
}

export interface ComposeSseRuntimeHealth {
  liveDeliveredByThisReplica: number;
  replayedByThisReplica: number;
  activeSubscribers: number;
  activeSessions: number;
  connectedByThisReplica: number;
  disconnectedByThisReplica: number;
}

interface SubscriberState {
  afterEventId?: number;
}

interface ComposeSseEventStore {
  appendSessionEvent(input: {
    sessionId: number;
    eventType: string;
    payload: ComposeChatEvent;
    actorType?: string | null;
    actorId?: string | null;
  }): Promise<{ id: number } | null>;
  listSessionEventsAfter?(
    sessionId: number,
    afterEventId?: number,
    limit?: number,
  ): Promise<
    Array<{
      id: number;
      sessionId: number;
      eventType?: string;
      payload: unknown;
      createdAt?: string;
      turnJobId?: number | null;
      agentTaskId?: number | null;
      contextVersion?: number | null;
      requestId?: string | null;
    }>
  >;
  listSessionEventsForCursors?(
    cursors: Array<{ sessionId: number; afterEventId: number }>,
    limit?: number,
  ): Promise<
    Array<{
      id: number;
      sessionId: number;
      eventType?: string;
      payload: unknown;
      createdAt?: string;
      turnJobId?: number | null;
      agentTaskId?: number | null;
      contextVersion?: number | null;
      requestId?: string | null;
    }>
  >;
}

interface ReplayEvent {
  event: ComposeChatEvent;
  id?: number;
}

export function formatSseEvent(
  event: ComposeChatEvent,
  options: FormatSseEventOptions = {},
): string {
  const idLine =
    options.id === null || options.id === undefined
      ? ""
      : `id: ${options.id}\n`;
  return `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

export function formatCanonicalSseEvent(event: CanonicalSessionEvent): string {
  return `id: ${event.id}\nevent: canonical\ndata: ${JSON.stringify(event)}\n\n`;
}

interface ComposeSseHubOptions {
  replayLimit?: number;
  eventStore?: ComposeSseEventStore;
  durableEventsRequired?: boolean;
}

const MAX_DURABLE_EVENT_PAYLOAD_BYTES = 16 * 1024;

function durableEventType(event: ComposeChatEvent): string {
  switch (event.type) {
    case "message":
      return event.role === "assistant" ? "assistant.final" : "message.created";
    case "readiness":
      return "readiness.updated";
    case "invalidate":
      if (event.resource === "readiness") return "readiness.updated";
      return event.role === "assistant" ? "assistant.final" : "message.created";
    case "session":
      return "session.archived";
    case "status":
      return event.status === "error" ? "error" : "turn.status";
  }
}

function eventPayloadBytes(event: ComposeChatEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function durableErrorEvent(code: string, message: string): ComposeChatEvent {
  return {
    type: "status",
    status: "error",
    code,
    message,
  };
}

function oversizedEventInvalidation(
  event: ComposeChatEvent,
): ComposeChatEvent | null {
  if (event.type === "message") {
    return { type: "invalidate", resource: "messages", role: event.role };
  }
  if (event.type === "readiness") {
    return { type: "invalidate", resource: "readiness" };
  }
  return null;
}

export class ComposeSseHub {
  private readonly subscribers = new Map<
    number,
    Map<Response, SubscriberState>
  >();
  private readonly replay = new Map<number, ReplayEvent[]>();
  private readonly replayLimit: number;
  private readonly eventStore?: ComposeSseEventStore;
  private readonly durableEventsRequired: boolean;
  private liveDeliveredByThisReplica = 0;
  private replayedByThisReplica = 0;
  private connectedByThisReplica = 0;
  private disconnectedByThisReplica = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private durablePollTimer: NodeJS.Timeout | null = null;

  constructor(options: ComposeSseHubOptions = {}) {
    const replayLimit = options.replayLimit ?? 20;
    this.replayLimit = Number.isFinite(replayLimit)
      ? Math.max(0, Math.trunc(replayLimit))
      : 20;
    this.eventStore = options.eventStore;
    this.durableEventsRequired = options.durableEventsRequired ?? false;
  }

  subscribe(
    sessionId: number,
    res: Response,
    options: SubscribeOptions = {},
  ): void {
    // Contract: the caller MUST unsubscribe(sessionId, res) when the connection
    // closes (the /stream route's req.on("close") handler) — the registry does
    // not self-evict dead Responses; publish/heartbeat only swallow write errors.
    let subscribers = this.subscribers.get(sessionId);
    if (!subscribers) {
      subscribers = new Map();
      this.subscribers.set(sessionId, subscribers);
    }
    if (!subscribers.has(res)) {
      this.connectedByThisReplica += 1;
    }
    subscribers.set(res, { afterEventId: options.afterEventId });
    const replay =
      (options.replay ?? true) ? this.replay.get(sessionId) : undefined;
    if (replay?.length) {
      for (const item of replay) {
        if (
          item.id !== undefined &&
          options.afterEventId !== undefined &&
          item.id <= options.afterEventId
        ) {
          continue;
        }
        try {
          res.write(formatSseEvent(item.event, { id: item.id }));
          this.recordReplayedEvents(1);
        } catch {
          // drop broken pipes; the connection close handler unsubscribes
        }
      }
    }
  }

  unsubscribe(sessionId: number, res: Response): void {
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    if (set.delete(res)) {
      this.disconnectedByThisReplica += 1;
    }
    if (set.size === 0) this.subscribers.delete(sessionId);
  }

  setSubscriberAfterEventId(
    sessionId: number,
    res: Response,
    afterEventId: number,
  ): void {
    const subscriber = this.subscribers.get(sessionId)?.get(res);
    if (!subscriber) return;
    subscriber.afterEventId = afterEventId;
  }

  advanceSubscriberAfterEventId(
    sessionId: number,
    res: Response,
    afterEventId: number,
  ): void {
    const subscriber = this.subscribers.get(sessionId)?.get(res);
    if (!subscriber || !Number.isFinite(afterEventId)) return;
    subscriber.afterEventId = Math.max(
      subscriber.afterEventId ?? 0,
      Math.trunc(afterEventId),
    );
  }

  getSubscriberAfterEventId(
    sessionId: number,
    res: Response,
  ): number | undefined {
    return this.subscribers.get(sessionId)?.get(res)?.afterEventId;
  }

  recordReplayedEvents(count: number): void {
    if (!Number.isFinite(count) || count <= 0) return;
    this.replayedByThisReplica += Math.trunc(count);
  }

  getRuntimeHealth(): ComposeSseRuntimeHealth {
    return {
      liveDeliveredByThisReplica: this.liveDeliveredByThisReplica,
      replayedByThisReplica: this.replayedByThisReplica,
      activeSubscribers: [...this.subscribers.values()].reduce(
        (sum, subscribers) => sum + subscribers.size,
        0,
      ),
      activeSessions: this.subscribers.size,
      connectedByThisReplica: this.connectedByThisReplica,
      disconnectedByThisReplica: this.disconnectedByThisReplica,
    };
  }

  publish(sessionId: number, event: ComposeChatEvent): void | Promise<void> {
    if (this.eventStore) {
      return this.publishDurably(sessionId, event);
    }
    this.publishLive(sessionId, event);
  }

  publishCanonical(event: CanonicalSessionEvent): void {
    const set = this.subscribers.get(event.sessionId);
    if (!set) return;
    const payload = formatCanonicalSseEvent(event);
    for (const [res, subscriber] of set) {
      if (
        subscriber.afterEventId !== undefined &&
        event.id <= subscriber.afterEventId
      ) {
        continue;
      }
      try {
        res.write(payload);
        this.liveDeliveredByThisReplica += 1;
        subscriber.afterEventId = Math.max(
          subscriber.afterEventId ?? 0,
          event.id,
        );
      } catch {
        // The route close handler removes broken subscribers.
      }
    }
  }

  async pollDurableEventsOnce(limit = 100): Promise<void> {
    if (
      !this.eventStore?.listSessionEventsAfter &&
      !this.eventStore?.listSessionEventsForCursors
    ) {
      return;
    }
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(500, Math.trunc(limit)))
      : 100;
    const cursors = [...this.subscribers.keys()]
      .map((sessionId) => this.durableSessionCursor(sessionId))
      .filter(
        (cursor): cursor is { sessionId: number; afterEventId: number } =>
          cursor !== null && cursor.afterEventId !== Number.MAX_SAFE_INTEGER,
      );
    if (this.eventStore.listSessionEventsForCursors) {
      const chunkSize = 100;
      await Promise.allSettled(
        Array.from(
          { length: Math.ceil(cursors.length / chunkSize) },
          (_, index) =>
            cursors.slice(index * chunkSize, (index + 1) * chunkSize),
        ).map(async (chunk) => {
          const events = await this.eventStore!.listSessionEventsForCursors!(
            chunk,
            Math.min(5_000, safeLimit * chunk.length),
          );
          for (const event of events) this.publishStoredEvent(event);
        }),
      );
      return;
    }
    await Promise.allSettled(
      cursors.map(({ sessionId }) =>
        this.pollDurableSessionEvents(sessionId, safeLimit),
      ),
    );
  }

  private async publishDurably(
    sessionId: number,
    event: ComposeChatEvent,
  ): Promise<void> {
    let durableEvent = event;
    if (eventPayloadBytes(durableEvent) > MAX_DURABLE_EVENT_PAYLOAD_BYTES) {
      const invalidation = oversizedEventInvalidation(durableEvent);
      if (!invalidation) {
        await this.publishDurableError(
          sessionId,
          "payload_too_large",
          `SSE event payload exceeds ${MAX_DURABLE_EVENT_PAYLOAD_BYTES} bytes`,
        );
        return;
      }
      durableEvent = invalidation;
    }
    try {
      const stored = await this.eventStore?.appendSessionEvent({
        sessionId,
        eventType: durableEventType(durableEvent),
        payload: durableEvent,
        actorType: "system",
        actorId: "spec-factory-operator",
      });
      if (this.durableEventsRequired && stored?.id === undefined) {
        await this.publishDurableError(
          sessionId,
          "event_persist_failed",
          "SSE event persistence did not return a durable id",
        );
        return;
      }
      if (stored?.id !== undefined) {
        this.publishCanonical(
          createCanonicalSessionEvent({
            id: stored.id,
            eventType: durableEventType(durableEvent),
            occurredAt: new Date().toISOString(),
            sessionId,
            data: durableEvent,
          }),
        );
      } else {
        this.publishLive(sessionId, durableEvent);
      }
    } catch {
      await this.publishDurableError(
        sessionId,
        "event_persist_failed",
        "SSE event persistence failed",
      );
    }
  }

  private async publishDurableError(
    sessionId: number,
    code: string,
    message: string,
  ): Promise<void> {
    const event = durableErrorEvent(code, message);
    try {
      const stored = await this.eventStore?.appendSessionEvent({
        sessionId,
        eventType: "error",
        payload: event,
        actorType: "system",
        actorId: "spec-factory-operator",
      });
      if (stored?.id !== undefined) {
        this.publishCanonical(
          createCanonicalSessionEvent({
            id: stored.id,
            eventType: "error",
            occurredAt: new Date().toISOString(),
            sessionId,
            data: event,
          }),
        );
      } else {
        this.publishLive(sessionId, event);
      }
    } catch {
      this.publishLive(sessionId, event);
    }
  }

  private publishLive(
    sessionId: number,
    event: ComposeChatEvent,
    id?: number,
  ): void {
    this.remember(sessionId, event, id);
    const set = this.subscribers.get(sessionId);
    if (!set) return;
    const payload = formatSseEvent(event, { id });
    for (const [res, subscriber] of set) {
      if (
        id !== undefined &&
        subscriber.afterEventId !== undefined &&
        id <= subscriber.afterEventId
      ) {
        continue;
      }
      try {
        res.write(payload);
        this.liveDeliveredByThisReplica += 1;
        if (id !== undefined && subscriber.afterEventId !== undefined) {
          subscriber.afterEventId = Math.max(subscriber.afterEventId, id);
        }
      } catch {
        // drop broken pipes; the connection close handler unsubscribes
      }
    }
  }

  private remember(
    sessionId: number,
    event: ComposeChatEvent,
    id?: number,
  ): void {
    if (this.replayLimit <= 0) return;
    const events = this.replay.get(sessionId) ?? [];
    events.push({ event, id });
    if (events.length > this.replayLimit) {
      events.splice(0, events.length - this.replayLimit);
    }
    this.replay.set(sessionId, events);
  }

  private async pollDurableSessionEvents(
    sessionId: number,
    limit: number,
  ): Promise<void> {
    if (!this.eventStore?.listSessionEventsAfter) return;
    const cursor = this.durableSessionCursor(sessionId);
    if (!cursor) return;
    const afterEventId = cursor.afterEventId;
    if (afterEventId === Number.MAX_SAFE_INTEGER) return;
    const events = await this.eventStore.listSessionEventsAfter(
      sessionId,
      afterEventId,
      limit,
    );
    for (const event of events) this.publishStoredEvent(event);
  }

  private durableSessionCursor(
    sessionId: number,
  ): { sessionId: number; afterEventId: number } | null {
    const subscribers = this.subscribers.get(sessionId);
    if (!subscribers?.size) return null;
    const cursors = [...subscribers.values()]
      .map((subscriber) => subscriber.afterEventId)
      .filter(
        (afterEventId): afterEventId is number =>
          afterEventId !== undefined &&
          Number.isFinite(afterEventId) &&
          afterEventId >= 0,
      );
    return cursors.length
      ? { sessionId, afterEventId: Math.min(...cursors) }
      : null;
  }

  private publishStoredEvent(event: {
    id: number;
    sessionId: number;
    eventType?: string;
    payload: unknown;
    createdAt?: string;
    turnJobId?: number | null;
    agentTaskId?: number | null;
    contextVersion?: number | null;
    requestId?: string | null;
  }): void {
    this.publishCanonical(
      createCanonicalSessionEvent({
        id: event.id,
        eventType: event.eventType ?? "session.event",
        occurredAt: event.createdAt ?? new Date().toISOString(),
        sessionId: event.sessionId,
        requestId: event.requestId ?? null,
        turnJobId: event.turnJobId ?? null,
        agentTaskId: event.agentTaskId ?? null,
        contextVersion: event.contextVersion ?? null,
        data: event.payload,
      }),
    );
  }

  /** Write a comment ping to every open connection (keeps the ALB from reaping idle SSE). */
  heartbeat(): void {
    for (const set of this.subscribers.values()) {
      for (const res of set.keys()) {
        try {
          res.write(": ping\n\n");
        } catch {
          // ignore
        }
      }
    }
  }

  /** Start the heartbeat loop (call once at server boot). Default 20s < ALB 60s idle. */
  startHeartbeat(intervalMs = 20000): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => this.heartbeat(), intervalMs);
    this.heartbeatTimer.unref?.();
  }

  startDurableEventPolling(intervalMs = 1000): void {
    if (this.durablePollTimer || !this.eventStore?.listSessionEventsAfter) {
      return;
    }
    const safeIntervalMs = Number.isFinite(intervalMs)
      ? Math.max(250, Math.trunc(intervalMs))
      : 1000;
    this.durablePollTimer = setInterval(() => {
      void this.pollDurableEventsOnce().catch(() => undefined);
    }, safeIntervalMs);
    this.durablePollTimer.unref?.();
  }

  stopDurableEventPolling(): void {
    if (!this.durablePollTimer) return;
    clearInterval(this.durablePollTimer);
    this.durablePollTimer = null;
  }
}
