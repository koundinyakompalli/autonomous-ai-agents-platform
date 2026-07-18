import { describe, expect, it, vi } from "vitest";
import {
  SpecFactoryOutboxRepository,
  appendSpecFactoryOutboxEvent,
} from "./outbox.js";
import { SpecFactoryOutboxRelay } from "./outbox-relay.js";

function connection() {
  return {
    query: vi.fn(),
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
  };
}

describe("Spec Factory transactional outbox", () => {
  it("inserts an idempotent outbox event on the caller transaction", async () => {
    const query = vi.fn().mockResolvedValue([{ insertId: 91 }, []]);
    const availableAt = new Date("2026-07-10T05:00:00.000Z");

    await expect(
      appendSpecFactoryOutboxEvent({ query } as never, {
        aggregateType: "turn",
        aggregateId: 101,
        eventType: "turn.queued",
        dedupeKey: "turn:101:queued",
        payload: { sessionId: 7 },
        availableAt,
      }),
    ).resolves.toBe(91);

    expect(String(query.mock.calls[0][0])).toContain(
      "ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      "turn",
      "101",
      "turn.queued",
      1,
      "turn:101:queued",
      '{"sessionId":7}',
      availableAt,
    ]);
  });

  it("claims a locked batch with a fencing owner", async () => {
    const db = connection();
    db.query
      .mockResolvedValueOnce([
        [
          {
            id: 91,
            aggregate_type: "turn",
            aggregate_id: "101",
            event_type: "turn.queued",
            schema_version: 1,
            dedupe_key: "turn:101:queued",
            payload_json: '{"sessionId":7}',
            publish_attempts: 0,
            created_at: "2026-07-10T05:00:00.000Z",
          },
        ],
        [],
      ])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const repo = new SpecFactoryOutboxRepository({
      query: vi.fn(),
      getConnection: vi.fn().mockResolvedValue(db),
    } as never);
    const leaseUntil = new Date("2026-07-10T05:01:00.000Z");

    await expect(
      repo.claimBatch({ workerId: "relay-a", leaseUntil, limit: 50 }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: 91,
        eventType: "turn.queued",
        payload: { sessionId: 7 },
        publishAttempts: 1,
      }),
    ]);
    expect(String(db.query.mock.calls[0][0])).toContain(
      "FOR UPDATE SKIP LOCKED",
    );
    expect(String(db.query.mock.calls[1][0])).toContain(
      "status = 'publishing'",
    );
    expect(db.commit).toHaveBeenCalledOnce();
  });

  it("publishes claimed events and marks them complete", async () => {
    const event = {
      id: 91,
      aggregateType: "turn",
      aggregateId: "101",
      eventType: "turn.queued",
      schemaVersion: 1,
      dedupeKey: "turn:101:queued",
      payload: { sessionId: 7 },
      publishAttempts: 1,
      createdAt: "2026-07-10T05:00:00.000Z",
    };
    const repository = {
      claimBatch: vi.fn().mockResolvedValue([event]),
      markPublished: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn(),
    };
    const publisher = { publish: vi.fn().mockResolvedValue(undefined) };
    const relay = new SpecFactoryOutboxRelay(repository as never, publisher, {
      workerId: "relay-a",
    });

    await expect(relay.drainOnce()).resolves.toBe(1);
    expect(publisher.publish).toHaveBeenCalledWith(event);
    expect(repository.markPublished).toHaveBeenCalledWith({
      id: 91,
      workerId: "relay-a",
    });
    expect(repository.markFailed).not.toHaveBeenCalled();
  });
});
