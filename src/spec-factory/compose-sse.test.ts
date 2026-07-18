import { describe, expect, it, vi } from "vitest";
import { ComposeSseHub, formatSseEvent } from "./compose-sse.js";

function fakeRes() {
  return {
    written: [] as string[],
    headersSent: false,
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write(chunk: string) {
      this.written.push(chunk);
      return true;
    },
    end: vi.fn(),
    on: vi.fn(),
  };
}

describe("ComposeSseHub", () => {
  it("formatSseEvent serializes a named JSON event", () => {
    const s = formatSseEvent({
      type: "message",
      role: "assistant",
      content: "hi",
    });
    expect(s).toContain("event: message");
    expect(s).toContain('data: {"type":"message"');
    expect(s.endsWith("\n\n")).toBe(true);
  });

  it("formatSseEvent includes durable event ids when provided", () => {
    const s = formatSseEvent(
      { type: "status", status: "thinking", message: "Reading" },
      { id: 91 },
    );

    expect(s).toContain("id: 91\n");
    expect(s).toContain("event: status");
  });

  it("publish writes to all subscribers of a session only", () => {
    const hub = new ComposeSseHub();
    const a = fakeRes();
    const b = fakeRes();
    const other = fakeRes();
    hub.subscribe(7, a as never);
    hub.subscribe(7, b as never);
    hub.subscribe(9, other as never);

    hub.publish(7, { type: "status", status: "thinking" });

    expect(a.written.join("")).toContain("event: status");
    expect(b.written.join("")).toContain("event: status");
    expect(other.written.join("")).toBe("");
  });

  it("publish persists durable events before live fanout when configured", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn().mockImplementation(async () => {
        expect(a.written.join("")).toBe("");
        return { id: 91 };
      }),
    };
    const hub = new ComposeSseHub({ eventStore });
    const event = {
      type: "status" as const,
      status: "thinking" as const,
      message: "Reading sources",
    };
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, event);

    expect(eventStore.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "turn.status",
      payload: event,
      actorType: "system",
      actorId: "spec-factory-operator",
    });
    expect(a.written.join("")).toContain("id: 91");
    expect(a.written.join("")).toContain("Reading sources");
    expect(hub.getRuntimeHealth()).toMatchObject({
      liveDeliveredByThisReplica: 1,
      replayedByThisReplica: 0,
    });
  });

  it("tracks replay delivery separately from live fanout", () => {
    const hub = new ComposeSseHub();
    const live = fakeRes();
    hub.subscribe(7, live as never);
    hub.publish(7, { type: "status", status: "thinking" });

    const replay = fakeRes();
    hub.subscribe(7, replay as never);
    hub.recordReplayedEvents(2);

    expect(replay.written.join("")).toContain("event: status");
    expect(hub.getRuntimeHealth()).toMatchObject({
      liveDeliveredByThisReplica: 1,
      replayedByThisReplica: 3,
    });
  });

  it("tracks active and lifetime stream connections", () => {
    const hub = new ComposeSseHub();
    const a = fakeRes();
    const b = fakeRes();
    hub.subscribe(7, a as never);
    hub.subscribe(8, b as never);

    expect(hub.getRuntimeHealth()).toMatchObject({
      activeSubscribers: 2,
      activeSessions: 2,
      connectedByThisReplica: 2,
      disconnectedByThisReplica: 0,
    });

    hub.unsubscribe(7, a as never);

    expect(hub.getRuntimeHealth()).toMatchObject({
      activeSubscribers: 1,
      activeSessions: 1,
      connectedByThisReplica: 2,
      disconnectedByThisReplica: 1,
    });
  });

  it("maps session archived events to the durable lifecycle event type", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 92 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    const event = {
      type: "session" as const,
      status: "archived" as const,
    };
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, event);

    expect(eventStore.appendSessionEvent).toHaveBeenCalledWith({
      sessionId: 7,
      eventType: "session.archived",
      payload: event,
      actorType: "system",
      actorId: "spec-factory-operator",
    });
    expect(a.written.join("")).toContain("event: canonical");
    expect(a.written.join("")).toContain('"eventType":"session.archived"');
    expect(a.written.join("")).toContain("id: 92");
  });

  it("publishes a compact invalidation when a message payload is too large", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 92 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, {
      type: "message",
      role: "assistant",
      content: "x".repeat(17 * 1024),
    });

    expect(eventStore.appendSessionEvent).toHaveBeenCalledTimes(1);
    expect(eventStore.appendSessionEvent.mock.calls[0][0].eventType).toBe(
      "assistant.final",
    );
    expect(
      eventStore.appendSessionEvent.mock.calls[0][0].payload,
    ).toMatchObject({
      type: "invalidate",
      resource: "messages",
      role: "assistant",
    });
    const written = a.written.join("");
    expect(written).toContain("id: 92");
    expect(written).toContain('"resource":"messages"');
    expect(written).not.toContain("x".repeat(1024));
  });

  it("publishes a compact invalidation when a readiness payload is too large", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 93 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, {
      type: "readiness",
      readiness: {
        ready: false,
        openQuestions: ["x".repeat(17 * 1024)],
        summary: "Needs clarification",
      },
    });

    expect(eventStore.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "readiness.updated",
        payload: { type: "invalidate", resource: "readiness" },
      }),
    );
    expect(a.written.join("")).toContain('"resource":"readiness"');
  });

  it("retains the durable payload error for oversized control events", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn().mockResolvedValue({ id: 94 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "x".repeat(17 * 1024),
    });

    expect(eventStore.appendSessionEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "error",
        payload: expect.objectContaining({
          type: "status",
          status: "error",
          code: "payload_too_large",
        }),
      }),
    );
  });

  it("publishes a durable error event instead of live-only fanout when persistence fails", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi
        .fn()
        .mockRejectedValueOnce(new Error("db down"))
        .mockResolvedValueOnce({ id: 93 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "Reading sources",
    });

    expect(eventStore.appendSessionEvent).toHaveBeenCalledTimes(2);
    expect(eventStore.appendSessionEvent.mock.calls[1][0].eventType).toBe(
      "error",
    );
    const written = a.written.join("");
    expect(written).toContain("id: 93");
    expect(written).toContain("event_persist_failed");
    expect(written).not.toContain("Reading sources");
  });

  it("requires a durable id before live fanout when durable events are required", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 94 }),
    };
    const hub = new ComposeSseHub({
      eventStore,
      durableEventsRequired: true,
    });
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "Reading sources",
    });

    expect(eventStore.appendSessionEvent).toHaveBeenCalledTimes(2);
    expect(eventStore.appendSessionEvent.mock.calls[1][0].eventType).toBe(
      "error",
    );
    const written = a.written.join("");
    expect(written).toContain("id: 94");
    expect(written).toContain("event_persist_failed");
    expect(written).not.toContain("Reading sources");
  });

  it("allows live best-effort fanout without a durable id when durable events are not required", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn().mockResolvedValue(null),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false });

    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "Reading sources",
    });

    const written = a.written.join("");
    expect(written).not.toContain("id:");
    expect(written).toContain("Reading sources");
  });

  it("filters live durable fanout at or below a subscriber's replay cursor", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi
        .fn()
        .mockResolvedValueOnce({ id: 10 })
        .mockResolvedValueOnce({ id: 11 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false, afterEventId: 10 });

    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "old",
    });
    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "new",
    });

    const written = a.written.join("");
    expect(written).not.toContain("old");
    expect(written).toContain("id: 11");
    expect(written).toContain("new");
  });

  it("advances a durable subscriber cursor without rewinding it", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi
        .fn()
        .mockResolvedValueOnce({ id: 11 })
        .mockResolvedValueOnce({ id: 13 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false, afterEventId: 10 });

    hub.advanceSubscriberAfterEventId(7, a as never, 12);
    hub.advanceSubscriberAfterEventId(7, a as never, 5);
    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "below cursor",
    });
    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "above cursor",
    });

    const written = a.written.join("");
    expect(written).not.toContain("below cursor");
    expect(written).toContain("id: 13");
    expect(written).toContain("above cursor");
  });

  it("exposes the current durable subscriber cursor for route catch-up dedupe", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn().mockResolvedValueOnce({ id: 11 }),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false, afterEventId: 10 });

    expect(hub.getSubscriberAfterEventId(7, a as never)).toBe(10);

    await hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "next",
    });

    expect(hub.getSubscriberAfterEventId(7, a as never)).toBe(11);
  });

  it("polls durable events for live subscribers after their replay cursor", async () => {
    const a = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn(),
      listSessionEventsAfter: vi.fn().mockResolvedValue([
        {
          id: 105,
          sessionId: 7,
          eventType: "turn.status",
          payload: {
            type: "status",
            status: "thinking",
            message: "from another replica",
          },
        },
      ]),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false, afterEventId: 100 });

    await hub.pollDurableEventsOnce();

    expect(eventStore.listSessionEventsAfter).toHaveBeenCalledWith(7, 100, 100);
    const written = a.written.join("");
    expect(written).toContain("id: 105");
    expect(written).toContain("from another replica");
  });

  it("batches durable fallback reads across active session cursors", async () => {
    const a = fakeRes();
    const b = fakeRes();
    const eventStore = {
      appendSessionEvent: vi.fn(),
      listSessionEventsAfter: vi.fn(),
      listSessionEventsForCursors: vi.fn().mockResolvedValue([
        {
          id: 105,
          sessionId: 7,
          eventType: "turn.status",
          payload: { type: "status", status: "thinking", message: "seven" },
        },
        {
          id: 205,
          sessionId: 8,
          eventType: "turn.status",
          payload: { type: "status", status: "thinking", message: "eight" },
        },
      ]),
    };
    const hub = new ComposeSseHub({ eventStore });
    hub.subscribe(7, a as never, { replay: false, afterEventId: 100 });
    hub.subscribe(8, b as never, { replay: false, afterEventId: 200 });

    await hub.pollDurableEventsOnce();

    expect(eventStore.listSessionEventsForCursors).toHaveBeenCalledWith(
      [
        { sessionId: 7, afterEventId: 100 },
        { sessionId: 8, afterEventId: 200 },
      ],
      200,
    );
    expect(eventStore.listSessionEventsAfter).not.toHaveBeenCalled();
    expect(a.written.join("")).toContain("seven");
    expect(a.written.join("")).not.toContain("eight");
    expect(b.written.join("")).toContain("eight");
  });

  it("replays recent session events to a new subscriber after reconnect", () => {
    const hub = new ComposeSseHub();
    hub.publish(7, {
      type: "status",
      status: "thinking",
      message: "Reading sources",
    });
    hub.publish(7, { type: "message", role: "assistant", content: "Ready" });
    hub.publish(9, { type: "message", role: "assistant", content: "Other" });

    const reconnect = fakeRes();
    hub.subscribe(7, reconnect as never);

    const replay = reconnect.written.join("");
    expect(replay).toContain("Reading sources");
    expect(replay).toContain("Ready");
    expect(replay).not.toContain("Other");
  });

  it("caps replay history to the configured latest events per session", () => {
    const hub = new ComposeSseHub({ replayLimit: 2 });
    hub.publish(7, { type: "message", role: "assistant", content: "one" });
    hub.publish(7, { type: "message", role: "assistant", content: "two" });
    hub.publish(7, { type: "message", role: "assistant", content: "three" });

    const reconnect = fakeRes();
    hub.subscribe(7, reconnect as never);

    const replay = reconnect.written.join("");
    expect(replay).not.toContain("one");
    expect(replay).toContain("two");
    expect(replay).toContain("three");
  });

  it("unsubscribe removes a subscriber", () => {
    const hub = new ComposeSseHub();
    const a = fakeRes();
    hub.subscribe(7, a as never);
    hub.unsubscribe(7, a as never);
    hub.publish(7, { type: "status", status: "idle" });
    expect(a.written.join("")).toBe("");
  });

  it("heartbeat writes a comment ping to subscribers", () => {
    const hub = new ComposeSseHub();
    const a = fakeRes();
    hub.subscribe(7, a as never);
    hub.heartbeat();
    expect(a.written.join("")).toContain(": ping");
  });
});
