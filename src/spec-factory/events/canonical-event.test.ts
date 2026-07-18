import { describe, expect, it } from "vitest";
import {
  createCanonicalSessionEvent,
  isCanonicalSessionEvent,
} from "./canonical-event.js";

describe("canonical session events", () => {
  it("keeps backend-owned ids and correlation separate from domain data", () => {
    const event = createCanonicalSessionEvent({
      id: 19,
      eventType: "handoff.snapshot_ready",
      occurredAt: "2026-07-10T01:00:00.000Z",
      sessionId: 81,
      handoffId: 44,
      contextVersion: 4,
      data: { status: "ready" },
    });
    expect(event.correlation).toMatchObject({
      handoffId: 44,
      contextVersion: 4,
      turnJobId: null,
    });
    expect(isCanonicalSessionEvent(event)).toBe(true);
  });
});
