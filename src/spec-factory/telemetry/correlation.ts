import { AsyncLocalStorage } from "node:async_hooks";

export interface SpecFactoryCorrelationContext {
  requestId?: string;
  actorId?: string;
  sessionId?: number;
  turnJobId?: number;
  agentTaskId?: number;
  handoffId?: number;
  workflowId?: number;
  stageRunId?: number;
  sourceId?: number;
  contextVersion?: number;
  workerId?: string;
  leaseGeneration?: number;
  outboxId?: number;
  queueMessageId?: string;
}

const correlationStorage =
  new AsyncLocalStorage<SpecFactoryCorrelationContext>();

export function currentSpecFactoryCorrelation(): SpecFactoryCorrelationContext {
  return { ...(correlationStorage.getStore() ?? {}) };
}

export function runWithSpecFactoryCorrelation<T>(
  correlation: SpecFactoryCorrelationContext,
  fn: () => T,
): T {
  return correlationStorage.run(
    compactCorrelation({
      ...(correlationStorage.getStore() ?? {}),
      ...correlation,
    }),
    fn,
  );
}

export function updateSpecFactoryCorrelation(
  correlation: SpecFactoryCorrelationContext,
): void {
  const active = correlationStorage.getStore();
  if (!active) return;
  Object.assign(active, compactCorrelation(correlation));
}

export function specFactoryCorrelationLogFields(): Record<
  string,
  string | number
> {
  const correlation = correlationStorage.getStore();
  if (!correlation) return {};
  return compactRecord({
    request_id: correlation.requestId,
    actor_id: correlation.actorId,
    session_id: correlation.sessionId,
    turn_job_id: correlation.turnJobId,
    agent_task_id: correlation.agentTaskId,
    handoff_id: correlation.handoffId,
    workflow_id: correlation.workflowId,
    stage_run_id: correlation.stageRunId,
    source_id: correlation.sourceId,
    context_version: correlation.contextVersion,
    worker_id: correlation.workerId,
    lease_generation: correlation.leaseGeneration,
    outbox_id: correlation.outboxId,
    queue_message_id: correlation.queueMessageId,
  });
}

export function specFactoryCorrelationSpanAttributes(): Record<
  string,
  string | number
> {
  const correlation = correlationStorage.getStore();
  if (!correlation) return {};
  return compactRecord({
    "spec_factory.request_id": correlation.requestId,
    "spec_factory.actor_id": correlation.actorId,
    "spec_factory.session_id": correlation.sessionId,
    "spec_factory.turn_job_id": correlation.turnJobId,
    "spec_factory.agent_task_id": correlation.agentTaskId,
    "spec_factory.handoff_id": correlation.handoffId,
    "spec_factory.workflow_id": correlation.workflowId,
    "spec_factory.stage_run_id": correlation.stageRunId,
    "spec_factory.source_id": correlation.sourceId,
    "spec_factory.context_version": correlation.contextVersion,
    "spec_factory.worker_id": correlation.workerId,
    "spec_factory.lease_generation": correlation.leaseGeneration,
    "spec_factory.outbox_id": correlation.outboxId,
    "spec_factory.queue_message_id": correlation.queueMessageId,
  });
}

function compactCorrelation(
  correlation: SpecFactoryCorrelationContext,
): SpecFactoryCorrelationContext {
  return Object.fromEntries(
    Object.entries(correlation).filter(([, value]) => value !== undefined),
  ) as SpecFactoryCorrelationContext;
}

function compactRecord(
  values: Record<string, string | number | undefined>,
): Record<string, string | number> {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as Record<string, string | number>;
}
