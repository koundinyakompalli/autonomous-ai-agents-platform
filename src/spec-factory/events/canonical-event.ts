import { z } from "zod";

export const CanonicalEventCorrelationSchema = z
  .object({
    turnJobId: z.number().int().positive().nullable().default(null),
    agentTaskId: z.number().int().positive().nullable().default(null),
    handoffId: z.number().int().positive().nullable().default(null),
    workflowId: z.number().int().positive().nullable().default(null),
    sourceId: z.number().int().positive().nullable().default(null),
    contextVersion: z.number().int().nonnegative().nullable().default(null),
    requestId: z.string().max(128).nullable().default(null),
  })
  .strict();

export const CanonicalSessionEventSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.number().int().positive(),
    eventType: z.string().trim().min(1).max(128),
    occurredAt: z.string().datetime(),
    sessionId: z.number().int().positive(),
    correlation: CanonicalEventCorrelationSchema,
    data: z.unknown(),
  })
  .strict();

export type CanonicalSessionEvent = z.infer<typeof CanonicalSessionEventSchema>;

export function createCanonicalSessionEvent(input: {
  id: number;
  eventType: string;
  occurredAt: string;
  sessionId: number;
  turnJobId?: number | null;
  agentTaskId?: number | null;
  handoffId?: number | null;
  workflowId?: number | null;
  sourceId?: number | null;
  contextVersion?: number | null;
  requestId?: string | null;
  data: unknown;
}): CanonicalSessionEvent {
  return CanonicalSessionEventSchema.parse({
    schemaVersion: 1,
    id: input.id,
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    sessionId: input.sessionId,
    correlation: {
      turnJobId: input.turnJobId ?? null,
      agentTaskId: input.agentTaskId ?? null,
      handoffId: input.handoffId ?? null,
      workflowId: input.workflowId ?? null,
      sourceId: input.sourceId ?? null,
      contextVersion: input.contextVersion ?? null,
      requestId: input.requestId ?? null,
    },
    data: input.data,
  });
}

export function isCanonicalSessionEvent(
  value: unknown,
): value is CanonicalSessionEvent {
  return CanonicalSessionEventSchema.safeParse(value).success;
}
