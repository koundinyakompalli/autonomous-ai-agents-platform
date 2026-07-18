import { describe, expect, it, vi } from "vitest";
import { createCanonicalSessionEvent } from "./canonical-event.js";
import { InMemorySessionEventFanout } from "./valkey-fanout.js";

describe("session event fanout", () => {
  it("fans one canonical event to every replica listener", async () => {
    const fanout = new InMemorySessionEventFanout();
    const first = vi.fn();
    const second = vi.fn();
    await fanout.subscribe(first);
    await fanout.subscribe(second);
    const event = createCanonicalSessionEvent({
      id: 1,
      eventType: "turn.completed",
      occurredAt: "2026-07-10T01:00:00.000Z",
      sessionId: 7,
      data: {},
    });
    await fanout.publish(event);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
  });
});
