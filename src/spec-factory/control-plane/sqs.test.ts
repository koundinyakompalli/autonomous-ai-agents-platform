import { describe, expect, it, vi } from "vitest";
import {
  SpecFactorySqsConsumer,
  SpecFactorySqsPublisher,
  SpecFactoryQueueReceiptRepository,
  parseQueueEnvelope,
  routeOutboxEvent,
} from "./sqs.js";

const queueUrls = {
  turn: "https://sqs/turn",
  context: "https://sqs/context",
  research: "https://sqs/research",
  conversion: "https://sqs/conversion",
  draft: "https://sqs/draft",
  events: "https://sqs/events",
};

describe("Spec Factory SQS transport", () => {
  it("reacquires failed receipts with a new fenced lease", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 0 }, []])
      .mockResolvedValueOnce([[{ status: "failed" }], []])
      .mockResolvedValueOnce([{ affectedRows: 1 }, []]);
    const receipts = new SpecFactoryQueueReceiptRepository({ query } as never);
    const leaseUntil = new Date("2026-07-10T05:15:00.000Z");

    await expect(
      receipts.begin({
        consumerName: "turn-primary",
        envelope: {
          schemaVersion: 1,
          messageId: "outbox-91",
          outboxId: 91,
          queueGeneration: 1,
          queue: "turn",
          eventType: "turn.queued",
          aggregateType: "turn",
          aggregateId: "101",
          occurredAt: "2026-07-10T05:00:00.000Z",
          mode: "primary",
          payload: { sessionId: 7 },
        },
        leaseToken: "11111111-1111-4111-8111-111111111111",
        leaseUntil,
      }),
    ).resolves.toBe("acquired");
    expect(String(query.mock.calls[2][0])).toContain("status = 'failed'");
    expect(query.mock.calls[2][1]).toEqual([
      "11111111-1111-4111-8111-111111111111",
      leaseUntil,
      "turn-primary",
      "outbox-91",
    ]);
  });

  it("renews only the active receipt lease token", async () => {
    const query = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    const receipts = new SpecFactoryQueueReceiptRepository({ query } as never);
    const leaseUntil = new Date("2026-07-10T05:30:00.000Z");

    await expect(
      receipts.renew({
        consumerName: "turn-primary",
        messageId: "outbox-91-g1",
        leaseToken: "11111111-1111-4111-8111-111111111111",
        leaseUntil,
      }),
    ).resolves.toBe(true);
    expect(String(query.mock.calls[0][0])).toContain(
      "lease_until >= CURRENT_TIMESTAMP(3)",
    );
    expect(query.mock.calls[0][1]).toEqual([
      leaseUntil,
      "turn-primary",
      "outbox-91-g1",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("routes capability and lifecycle events to isolated queues", () => {
    expect(
      routeOutboxEvent({
        aggregateType: "turn",
        eventType: "turn.queued",
        payload: {},
      }),
    ).toBe("turn");
    expect(
      routeOutboxEvent({
        aggregateType: "agent_task",
        eventType: "task.queued",
        payload: { capability: "code_research" },
      }),
    ).toBe("research");
    expect(
      routeOutboxEvent({
        aggregateType: "context_patch",
        eventType: "context.patch.created",
        payload: {},
      }),
    ).toBe("context");
    for (const [capability, queue] of Object.entries({
      source_distillation: "context",
      context_merge: "context",
      code_research: "research",
      config_research: "research",
      devops_research: "research",
      critic_review: "context",
      handoff_build: "context",
    })) {
      expect(
        routeOutboxEvent({
          aggregateType: "agent_task",
          eventType: "task.queued",
          payload: { capability },
        }),
      ).toBe(queue);
    }
  });

  it("always routes persisted session events to the fanout queue", () => {
    expect(
      routeOutboxEvent({
        aggregateType: "session_event",
        eventType: "turn.status",
        payload: { canonicalEvent: { eventType: "turn.status" } },
      }),
    ).toBe("events");
  });

  it("publishes an immutable versioned shadow envelope", async () => {
    const send = vi.fn().mockResolvedValue({ MessageId: "sqs-1" });
    const publisher = new SpecFactorySqsPublisher(
      { send } as never,
      queueUrls,
      "shadow",
    );
    await publisher.publish({
      id: 91,
      aggregateType: "turn",
      aggregateId: "101",
      eventType: "turn.queued",
      schemaVersion: 1,
      dedupeKey: "turn:101:queued",
      payload: { sessionId: 7 },
      publishAttempts: 1,
      createdAt: "2026-07-10T05:00:00.000Z",
    });

    const command = send.mock.calls[0][0];
    expect(command.input.QueueUrl).toBe(queueUrls.turn);
    expect(JSON.parse(command.input.MessageBody)).toMatchObject({
      schemaVersion: 1,
      messageId: "outbox-91-g1",
      outboxId: 91,
      queue: "turn",
      mode: "shadow",
    });
  });

  it("validates shadow messages exactly once and deletes duplicates", async () => {
    const envelope = {
      schemaVersion: 1,
      messageId: "outbox-91",
      outboxId: 91,
      queueGeneration: 1,
      queue: "turn",
      eventType: "turn.queued",
      aggregateType: "turn",
      aggregateId: "101",
      occurredAt: "2026-07-10T05:00:00.000Z",
      mode: "shadow",
      payload: { sessionId: 7 },
    };
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          {
            Body: JSON.stringify(envelope),
            ReceiptHandle: "receipt-1",
          },
        ],
      })
      .mockResolvedValueOnce({});
    const receipts = {
      begin: vi.fn().mockResolvedValue("acquired"),
      complete: vi.fn().mockResolvedValue(true),
      renew: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };
    const handler = vi.fn();
    const consumer = new SpecFactorySqsConsumer(
      { send } as never,
      queueUrls.turn,
      "turn-shadow",
      receipts as never,
      handler,
    );

    await expect(consumer.pollOnce()).resolves.toBe(1);
    expect(handler).not.toHaveBeenCalled();
    const receiptInput = receipts.begin.mock.calls[0][0];
    expect(receiptInput).toEqual(
      expect.objectContaining({
        consumerName: "turn-shadow",
        envelope,
        leaseToken: expect.any(String),
        leaseUntil: expect.any(Date),
      }),
    );
    expect(receipts.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { shadowValidated: true },
        leaseToken: receiptInput.leaseToken,
      }),
    );
    expect(send.mock.calls[0][0].input.VisibilityTimeout).toBe(900);
    expect(send.mock.calls[1][0].input.ReceiptHandle).toBe("receipt-1");
  });

  it("rejects unsupported message schemas", () => {
    expect(() =>
      parseQueueEnvelope(JSON.stringify({ schemaVersion: 99 })),
    ).toThrow("unsupported_queue_schema:99");
  });

  it("quarantines and acknowledges unsupported schemas without executing them", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          {
            Body: JSON.stringify({ schemaVersion: 99, messageId: "future" }),
            ReceiptHandle: "receipt-future",
          },
        ],
      })
      .mockResolvedValueOnce({ MessageId: "quarantine-1" })
      .mockResolvedValueOnce({});
    const receipts = {
      begin: vi.fn(),
      complete: vi.fn(),
      renew: vi.fn(),
      fail: vi.fn(),
    };
    const handler = vi.fn();
    const consumer = new SpecFactorySqsConsumer(
      { send } as never,
      queueUrls.turn,
      "turn-primary",
      receipts as never,
      handler,
      { quarantineQueueUrl: "https://sqs/quarantine" },
    );

    await expect(consumer.pollOnce()).resolves.toBe(1);
    expect(send.mock.calls[1][0].input).toMatchObject({
      QueueUrl: "https://sqs/quarantine",
      MessageAttributes: {
        quarantineReason: {
          StringValue: "unsupported_queue_schema:99",
        },
      },
    });
    expect(send.mock.calls[2][0].input).toMatchObject({
      QueueUrl: queueUrls.turn,
      ReceiptHandle: "receipt-future",
    });
    expect(receipts.begin).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("quarantines an envelope delivered to the wrong worker queue", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          {
            Body: JSON.stringify({
              schemaVersion: 1,
              messageId: "outbox-91-g1",
              outboxId: 91,
              queueGeneration: 1,
              queue: "research",
              eventType: "task.queued",
              aggregateType: "agent_task",
              aggregateId: "101",
              occurredAt: "2026-07-10T05:00:00.000Z",
              mode: "primary",
              payload: { capability: "code_research" },
            }),
            ReceiptHandle: "receipt-wrong-queue",
          },
        ],
      })
      .mockResolvedValueOnce({ MessageId: "quarantine-1" })
      .mockResolvedValueOnce({});
    const handler = vi.fn();
    const consumer = new SpecFactorySqsConsumer(
      { send } as never,
      queueUrls.turn,
      "turn-primary",
      { begin: vi.fn(), complete: vi.fn(), renew: vi.fn(), fail: vi.fn() },
      handler,
      {
        quarantineQueueUrl: "https://sqs/quarantine",
        expectedQueue: "turn",
      },
    );

    await expect(consumer.pollOnce()).resolves.toBe(1);
    expect(send.mock.calls[1][0].input.MessageAttributes).toMatchObject({
      quarantineReason: {
        StringValue: "queue_envelope_mismatch:turn:research",
      },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps the message when durable receipt completion loses its fence", async () => {
    const envelope = {
      schemaVersion: 1,
      messageId: "outbox-91-g1",
      outboxId: 91,
      queueGeneration: 1,
      queue: "turn",
      eventType: "turn.queued",
      aggregateType: "turn",
      aggregateId: "101",
      occurredAt: "2026-07-10T05:00:00.000Z",
      mode: "primary",
      payload: { sessionId: 7 },
    } as const;
    const send = vi.fn().mockResolvedValueOnce({
      Messages: [
        { Body: JSON.stringify(envelope), ReceiptHandle: "receipt-1" },
      ],
    });
    const receipts = {
      begin: vi.fn().mockResolvedValue("acquired"),
      complete: vi.fn().mockResolvedValue(false),
      renew: vi.fn().mockResolvedValue(true),
      fail: vi.fn().mockResolvedValue(false),
    };
    const handler = vi.fn().mockResolvedValue({ drained: 1 });
    const consumer = new SpecFactorySqsConsumer(
      { send } as never,
      queueUrls.turn,
      "turn-primary",
      receipts as never,
      handler,
    );

    await expect(consumer.pollOnce()).rejects.toThrow(
      "queue_receipt_completion_fence_rejected",
    );
    expect(handler).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("holds the work scope until the durable receipt is complete", async () => {
    const envelope = {
      schemaVersion: 1,
      messageId: "outbox-92-g1",
      outboxId: 92,
      queueGeneration: 1,
      queue: "turn",
      eventType: "turn.queued",
      aggregateType: "turn",
      aggregateId: "102",
      occurredAt: "2026-07-13T18:00:00.000Z",
      mode: "primary",
      payload: { sessionId: 8 },
    } as const;
    const order: string[] = [];
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          { Body: JSON.stringify(envelope), ReceiptHandle: "receipt-2" },
        ],
      })
      .mockResolvedValueOnce({});
    const receipts = {
      begin: vi.fn().mockResolvedValue("acquired"),
      complete: vi.fn(async () => {
        order.push("receipt-complete");
        return true;
      }),
      renew: vi.fn().mockResolvedValue(true),
      fail: vi.fn(),
    };
    const handler = vi.fn(async () => {
      order.push("handler");
      return { drained: 1 };
    });
    const workScope = {
      run: async <T>(work: () => Promise<T>): Promise<T> => {
        order.push("protected");
        try {
          return await work();
        } finally {
          order.push("released");
        }
      },
    };
    const consumer = new SpecFactorySqsConsumer(
      { send } as never,
      queueUrls.turn,
      "turn-primary",
      receipts as never,
      handler,
      { workScope },
    );

    await expect(consumer.pollOnce()).resolves.toBe(1);
    expect(order).toEqual([
      "protected",
      "handler",
      "receipt-complete",
      "released",
    ]);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("releases a receipt quickly when the work scope cannot be acquired", async () => {
    const envelope = {
      schemaVersion: 1,
      messageId: "outbox-93-g1",
      outboxId: 93,
      queueGeneration: 1,
      queue: "research",
      eventType: "task.queued",
      aggregateType: "agent_task",
      aggregateId: "103",
      occurredAt: "2026-07-13T18:00:00.000Z",
      mode: "primary",
      payload: { capability: "code_research" },
    } as const;
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Messages: [
          { Body: JSON.stringify(envelope), ReceiptHandle: "receipt-3" },
        ],
      })
      .mockResolvedValueOnce({});
    const receipts = {
      begin: vi.fn().mockResolvedValue("acquired"),
      complete: vi.fn(),
      renew: vi.fn(),
      fail: vi.fn().mockResolvedValue(true),
    };
    const handler = vi.fn();
    const consumer = new SpecFactorySqsConsumer(
      { send } as never,
      queueUrls.research,
      "research-primary",
      receipts as never,
      handler,
      {
        workScope: {
          run: async <T>(_work: () => Promise<T>): Promise<T> => {
            throw new Error("ecs_task_protection_http_503");
          },
        },
      },
    );

    await expect(consumer.pollOnce()).rejects.toThrow(
      "ecs_task_protection_http_503",
    );
    expect(handler).not.toHaveBeenCalled();
    expect(receipts.fail).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: envelope.messageId,
        error: "ecs_task_protection_http_503",
      }),
    );
    expect(send.mock.calls[1][0].input).toMatchObject({
      ReceiptHandle: "receipt-3",
      VisibilityTimeout: 30,
    });
  });
});
