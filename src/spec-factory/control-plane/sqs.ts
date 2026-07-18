import { randomUUID } from "node:crypto";
import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
  type Message,
} from "@aws-sdk/client-sqs";
import type mysql from "mysql2/promise";
import { getDatabase } from "../../orchestrator/database.js";
import type { AsyncWorkScope } from "./ecs-task-protection.js";
import type { ClaimedOutboxEvent } from "./outbox.js";
import type { OutboxPublisher } from "./outbox-relay.js";
import type { CapabilityName } from "../agents/capability-registry.js";

export const SPEC_FACTORY_QUEUE_MESSAGE_VERSION = 1;

export type SpecFactoryQueueName =
  | "turn"
  | "context"
  | "research"
  | "conversion"
  | "draft"
  | "events";

export interface SpecFactoryQueueEnvelope {
  schemaVersion: number;
  messageId: string;
  outboxId: number;
  queueGeneration: number;
  queue: SpecFactoryQueueName;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  occurredAt: string;
  mode: "shadow" | "primary";
  payload: unknown;
}

export interface SpecFactoryQueueUrls {
  turn: string;
  context: string;
  research: string;
  conversion: string;
  draft: string;
  events: string;
}

type QueuedAgentCapability = Exclude<
  CapabilityName,
  "legacy_compose_chat" | "chat_coordination"
>;

const AGENT_CAPABILITY_QUEUE: Record<
  QueuedAgentCapability,
  Extract<SpecFactoryQueueName, "context" | "research" | "draft">
> = {
  source_distillation: "context",
  context_merge: "context",
  code_research: "research",
  config_research: "research",
  devops_research: "research",
  critic_review: "context",
  handoff_build: "context",
};

export class SpecFactorySqsPublisher implements OutboxPublisher {
  constructor(
    private readonly client: Pick<SQSClient, "send">,
    private readonly queueUrls: SpecFactoryQueueUrls,
    private readonly mode: "shadow" | "primary" = "shadow",
  ) {}

  async publish(event: ClaimedOutboxEvent): Promise<void> {
    const queue = routeOutboxEvent(event);
    const queueGeneration = Math.max(1, event.publishAttempts);
    const envelope: SpecFactoryQueueEnvelope = {
      schemaVersion: SPEC_FACTORY_QUEUE_MESSAGE_VERSION,
      messageId: `outbox-${event.id}-g${queueGeneration}`,
      outboxId: event.id,
      queueGeneration,
      queue,
      eventType: event.eventType,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      occurredAt: event.createdAt,
      mode: this.mode,
      payload: event.payload,
    };
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrls[queue],
        MessageBody: JSON.stringify(envelope),
        MessageAttributes: {
          eventType: { DataType: "String", StringValue: event.eventType },
          aggregateType: {
            DataType: "String",
            StringValue: event.aggregateType,
          },
          mode: { DataType: "String", StringValue: this.mode },
        },
      }),
    );
  }
}

export function routeOutboxEvent(
  event: Pick<ClaimedOutboxEvent, "aggregateType" | "eventType" | "payload">,
): SpecFactoryQueueName {
  // Session events are fanout notifications, not executable work. Their
  // domain event names intentionally overlap worker lifecycle events.
  if (event.aggregateType === "session_event") return "events";
  const payload = asRecord(event.payload);
  const capability = String(payload.capability ?? "");
  if (event.eventType.startsWith("turn.")) return "turn";
  const capabilityQueue =
    AGENT_CAPABILITY_QUEUE[capability as QueuedAgentCapability];
  if (capabilityQueue) return capabilityQueue;
  if (
    event.eventType.startsWith("context.") ||
    event.eventType.startsWith("source.distillation")
  ) {
    return "context";
  }
  if (event.eventType.startsWith("research.")) {
    return "research";
  }
  if (
    event.eventType.startsWith("source.conversion") ||
    capability === "source_conversion"
  ) {
    return "conversion";
  }
  if (
    event.eventType.startsWith("handoff.") ||
    event.eventType.startsWith("draft.") ||
    capability.startsWith("draft_")
  ) {
    return "draft";
  }
  return "events";
}

type ReceiptPool = Pick<mysql.Pool, "query">;

export class SpecFactoryQueueReceiptRepository {
  constructor(private readonly pool: ReceiptPool = getDatabase().getPool()) {}

  async begin(input: {
    consumerName: string;
    envelope: SpecFactoryQueueEnvelope;
    leaseToken: string;
    leaseUntil: Date;
  }): Promise<"acquired" | "completed" | "busy"> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT IGNORE INTO spec_factory_queue_receipts
       (consumer_name, message_id, outbox_id, queue_generation, status,
        lease_token, lease_until)
       VALUES (?, ?, ?, ?, 'processing', ?, ?)`,
      [
        input.consumerName,
        input.envelope.messageId,
        input.envelope.outboxId,
        input.envelope.queueGeneration,
        input.leaseToken,
        input.leaseUntil,
      ],
    );
    if (result.affectedRows === 1) return "acquired";
    const [rows] = await this.pool.query<
      Array<mysql.RowDataPacket & { status: string }>
    >(
      `SELECT status
       FROM spec_factory_queue_receipts
       WHERE consumer_name = ?
         AND message_id = ?
       LIMIT 1`,
      [input.consumerName, input.envelope.messageId],
    );
    if (rows[0]?.status === "completed") return "completed";
    const [reacquire] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_queue_receipts
       SET status = 'processing', lease_token = ?, lease_until = ?,
           error_message = NULL, started_at = CURRENT_TIMESTAMP(3),
           completed_at = NULL, updated_at = CURRENT_TIMESTAMP(3)
       WHERE consumer_name = ?
         AND message_id = ?
         AND (status = 'failed'
              OR (status = 'processing'
                  AND lease_until < CURRENT_TIMESTAMP(3)))`,
      [
        input.leaseToken,
        input.leaseUntil,
        input.consumerName,
        input.envelope.messageId,
      ],
    );
    return reacquire.affectedRows === 1 ? "acquired" : "busy";
  }

  async complete(input: {
    consumerName: string;
    messageId: string;
    leaseToken: string;
    result?: unknown;
  }): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_queue_receipts
       SET status = 'completed',
           result_json = CAST(? AS JSON),
           error_message = NULL,
           lease_token = NULL,
           lease_until = NULL,
           completed_at = CURRENT_TIMESTAMP(3),
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE consumer_name = ?
         AND message_id = ?
         AND status = 'processing'
         AND lease_token = ?
         AND lease_until >= CURRENT_TIMESTAMP(3)`,
      [
        JSON.stringify(input.result ?? null),
        input.consumerName,
        input.messageId,
        input.leaseToken,
      ],
    );
    return result.affectedRows === 1;
  }

  async renew(input: {
    consumerName: string;
    messageId: string;
    leaseToken: string;
    leaseUntil: Date;
  }): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_queue_receipts
       SET lease_until = ?, updated_at = CURRENT_TIMESTAMP(3)
       WHERE consumer_name = ?
         AND message_id = ?
         AND status = 'processing'
         AND lease_token = ?
         AND lease_until >= CURRENT_TIMESTAMP(3)`,
      [input.leaseUntil, input.consumerName, input.messageId, input.leaseToken],
    );
    return result.affectedRows === 1;
  }

  async fail(input: {
    consumerName: string;
    messageId: string;
    leaseToken: string;
    error: string;
  }): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_queue_receipts
       SET status = 'failed',
           error_message = ?,
           lease_token = NULL,
           lease_until = NULL,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE consumer_name = ?
         AND message_id = ?
         AND status = 'processing'
         AND lease_token = ?
         AND lease_until >= CURRENT_TIMESTAMP(3)`,
      [
        input.error.slice(0, 4096),
        input.consumerName,
        input.messageId,
        input.leaseToken,
      ],
    );
    return result.affectedRows === 1;
  }
}

export class SpecFactorySqsConsumer {
  constructor(
    private readonly client: Pick<SQSClient, "send">,
    private readonly queueUrl: string,
    private readonly consumerName: string,
    private readonly receipts: Pick<
      SpecFactoryQueueReceiptRepository,
      "begin" | "complete" | "renew" | "fail"
    >,
    private readonly handler: (
      envelope: SpecFactoryQueueEnvelope,
    ) => Promise<unknown>,
    private readonly options: {
      visibilityTimeoutSeconds?: number;
      heartbeatSeconds?: number;
      receiptLeaseMs?: number;
      quarantineQueueUrl?: string;
      expectedQueue?: SpecFactoryQueueName;
      workScope?: AsyncWorkScope;
    } = {},
  ) {}

  async pollOnce(): Promise<number> {
    const response = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: this.queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 10,
        VisibilityTimeout: this.visibilityTimeoutSeconds(),
      }),
    );
    const messages = response.Messages ?? [];
    await Promise.all(messages.map((message) => this.consume(message)));
    return messages.length;
  }

  private async consume(message: Message): Promise<void> {
    if (!message.Body || !message.ReceiptHandle) return;
    let envelope: SpecFactoryQueueEnvelope;
    try {
      envelope = parseQueueEnvelope(message.Body);
      if (
        this.options.expectedQueue &&
        envelope.queue !== this.options.expectedQueue
      ) {
        throw new Error(
          `queue_envelope_mismatch:${this.options.expectedQueue}:${envelope.queue}`,
        );
      }
    } catch (error) {
      if (!this.options.quarantineQueueUrl) throw error;
      await this.client.send(
        new SendMessageCommand({
          QueueUrl: this.options.quarantineQueueUrl,
          MessageBody: message.Body,
          MessageAttributes: {
            consumerName: {
              DataType: "String",
              StringValue: this.consumerName,
            },
            quarantineReason: {
              DataType: "String",
              StringValue: (error instanceof Error
                ? error.message
                : String(error)
              ).slice(0, 256),
            },
          },
        }),
      );
      await this.deleteMessage(message.ReceiptHandle);
      return;
    }
    const leaseToken = randomUUID();
    const receipt = await this.receipts.begin({
      consumerName: this.consumerName,
      envelope,
      leaseToken,
      leaseUntil: new Date(Date.now() + this.receiptLeaseMs()),
    });
    if (receipt === "busy") {
      await this.extendVisibility(message.ReceiptHandle);
      return;
    }
    if (receipt === "acquired") {
      let executionStarted = false;
      const process = () => {
        executionStarted = true;
        return this.processAcquiredMessage(
          message.ReceiptHandle!,
          envelope,
          leaseToken,
        );
      };
      if (this.options.workScope) {
        try {
          await this.options.workScope.run(process);
        } catch (error) {
          if (!executionStarted) {
            await Promise.allSettled([
              this.receipts.fail({
                consumerName: this.consumerName,
                messageId: envelope.messageId,
                leaseToken,
                error: error instanceof Error ? error.message : String(error),
              }),
              this.changeVisibility(message.ReceiptHandle, 30),
            ]);
          }
          throw error;
        }
      } else {
        await process();
      }
    }
    await this.deleteMessage(message.ReceiptHandle);
  }

  private async processAcquiredMessage(
    receiptHandle: string,
    envelope: SpecFactoryQueueEnvelope,
    leaseToken: string,
  ): Promise<void> {
    const stopHeartbeat = this.startVisibilityHeartbeat(
      receiptHandle,
      envelope,
      leaseToken,
    );
    try {
      const result =
        envelope.mode === "shadow"
          ? { shadowValidated: true }
          : await this.handler(envelope);
      const completed = await this.receipts.complete({
        consumerName: this.consumerName,
        messageId: envelope.messageId,
        leaseToken,
        result,
      });
      if (!completed) {
        throw new Error("queue_receipt_completion_fence_rejected");
      }
    } catch (error) {
      await this.receipts.fail({
        consumerName: this.consumerName,
        messageId: envelope.messageId,
        leaseToken,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      stopHeartbeat();
    }
  }

  private visibilityTimeoutSeconds(): number {
    return clampInteger(this.options.visibilityTimeoutSeconds, 900, 30, 43_200);
  }

  private receiptLeaseMs(): number {
    const configured = this.options.receiptLeaseMs;
    if (!Number.isFinite(configured) || (configured ?? 0) <= 0) {
      return (this.visibilityTimeoutSeconds() + 60) * 1_000;
    }
    return Math.max(60_000, Math.trunc(configured!));
  }

  private startVisibilityHeartbeat(
    receiptHandle: string,
    envelope: SpecFactoryQueueEnvelope,
    leaseToken: string,
  ): () => void {
    const heartbeatSeconds = clampInteger(
      this.options.heartbeatSeconds,
      60,
      10,
      Math.max(10, this.visibilityTimeoutSeconds() - 5),
    );
    const timer = setInterval(() => {
      void Promise.all([
        this.extendVisibility(receiptHandle),
        this.receipts.renew({
          consumerName: this.consumerName,
          messageId: envelope.messageId,
          leaseToken,
          leaseUntil: new Date(Date.now() + this.receiptLeaseMs()),
        }),
      ]).catch(() => undefined);
    }, heartbeatSeconds * 1_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private async extendVisibility(receiptHandle: string): Promise<void> {
    await this.changeVisibility(receiptHandle, this.visibilityTimeoutSeconds());
  }

  private async changeVisibility(
    receiptHandle: string,
    visibilityTimeout: number,
  ): Promise<void> {
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: visibilityTimeout,
      }),
    );
  }

  private async deleteMessage(receiptHandle: string): Promise<void> {
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }
}

export function parseQueueEnvelope(body: string): SpecFactoryQueueEnvelope {
  const value = JSON.parse(body) as Partial<SpecFactoryQueueEnvelope>;
  if (value.schemaVersion !== SPEC_FACTORY_QUEUE_MESSAGE_VERSION) {
    throw new Error(`unsupported_queue_schema:${value.schemaVersion}`);
  }
  if (
    !value.messageId ||
    !value.outboxId ||
    !Number.isInteger(value.outboxId) ||
    !value.queueGeneration ||
    !Number.isInteger(value.queueGeneration) ||
    !value.queue ||
    !value.eventType ||
    !value.aggregateType ||
    !value.aggregateId ||
    !value.occurredAt ||
    !value.mode ||
    !["shadow", "primary"].includes(value.mode) ||
    !["turn", "context", "research", "conversion", "draft", "events"].includes(
      value.queue,
    )
  ) {
    throw new Error("invalid_queue_envelope");
  }
  return value as SpecFactoryQueueEnvelope;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function clampInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.trunc(value!)));
}
