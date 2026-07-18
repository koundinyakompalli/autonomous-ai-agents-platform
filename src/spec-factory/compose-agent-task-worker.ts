import { createLogger, type Logger } from "../utils/logger.js";
import type {
  ClaimedAgentTask,
  ComposeRepository,
  ExpiredAgentTaskLeaseRecoveryResult,
} from "./compose-database.js";
import type {
  AgentTaskExecutionResult,
  AgentTaskExecutorRegistry,
} from "./agents/executor-registry.js";
import { composeSourceJiraKey } from "./compose-types.js";
import { runWithSpecFactoryCorrelation } from "./telemetry/correlation.js";
import {
  specFactoryMetrics,
  type SpecFactoryMetrics,
  type SpecFactoryWorkOutcome,
} from "./telemetry/metrics.js";
import { withSpecFactorySpan } from "./telemetry/tracing.js";

export const DEFAULT_AGENT_TASK_LEASE_MS = 900_000;
const DEFAULT_MAX_TASKS_PER_DRAIN = 25;
const DEFAULT_RECOVERY_LIMIT = 100;
const EXPIRED_LEASE_MESSAGE =
  "Agent task lease expired before the worker completed";

export interface ComposeAgentTaskWorkerDrainResult {
  recovered: ExpiredAgentTaskLeaseRecoveryResult;
  claimed: number;
  completed: number;
  failed: number;
}

export interface ComposeAgentTaskWorkerRepository {
  claimNextAgentTask(input: {
    workerId: string;
    leaseUntil: Date;
    capabilities?: string[];
  }): Promise<ClaimedAgentTask | null>;
  startAgentRuntimeRun(input: {
    sessionId: number;
    agentTaskId: number;
    executorType: string;
    workspaceUri?: string | null;
  }): Promise<number>;
  finishAgentRuntimeRun(input: {
    runtimeRunId: number;
    status: "completed" | "failed";
    provider?: string | null;
    model?: string | null;
    traceUri?: string | null;
    outputArtifactUri?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
    estimatedCostUsd?: number | null;
    errorCode?: string | null;
    errorMessage?: string | null;
  }): Promise<boolean>;
  completeAgentTask(input: {
    agentTaskId: number;
    workerId: string;
    leaseGeneration: number;
    output?: unknown;
    contextVersionUsed?: number | null;
    outputSourceId?: number | null;
  }): Promise<boolean>;
  markAgentTaskFailed(input: {
    agentTaskId: number;
    workerId: string;
    leaseGeneration: number;
    errorCode: string;
    errorMessage: string;
  }): Promise<boolean>;
  recoverExpiredAgentTaskLeases(input: {
    expiredBefore: Date;
    limit: number;
    abandonedErrorMessage?: string;
  }): Promise<ExpiredAgentTaskLeaseRecoveryResult>;
  enqueueContextMergeTaskIfNeeded?(input: {
    sessionId: number;
    triggerPatchId?: number | null;
  }): Promise<number | null>;
}

interface AgentTaskEventPublisher {
  appendSessionEvent(input: {
    sessionId: number;
    eventType: string;
    payload: unknown;
    actorType?: string | null;
    actorId?: string | null;
    turnJobId?: number | null;
    agentTaskId?: number | null;
    contextVersion?: number | null;
    requestId?: string | null;
  }): Promise<unknown>;
}

export class ComposeAgentTaskWorker {
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly maxTasksPerDrain: number;
  private readonly recoveryLimit: number;
  private readonly capabilities?: string[];
  private readonly logger: Pick<Logger, "error">;
  private readonly eventPublisher?: AgentTaskEventPublisher;
  private readonly metrics: Pick<
    SpecFactoryMetrics,
    "recordLeaseEvent" | "recordWorkStarted" | "recordWorkCompleted"
  >;
  private running = false;

  constructor(
    private readonly repository: ComposeAgentTaskWorkerRepository &
      Pick<
        ComposeRepository,
        | "claimNextAgentTask"
        | "startAgentRuntimeRun"
        | "finishAgentRuntimeRun"
        | "completeAgentTask"
        | "markAgentTaskFailed"
        | "recoverExpiredAgentTaskLeases"
      >,
    private readonly executors: AgentTaskExecutorRegistry,
    options: {
      workerId?: string;
      leaseMs?: number;
      maxTasksPerDrain?: number;
      recoveryLimit?: number;
      capabilities?: string[];
      eventPublisher?: AgentTaskEventPublisher;
      logger?: Pick<Logger, "error">;
      metrics?: Pick<
        SpecFactoryMetrics,
        "recordLeaseEvent" | "recordWorkStarted" | "recordWorkCompleted"
      >;
    } = {},
  ) {
    this.workerId =
      options.workerId ?? `compose-agent-task-worker-${process.pid}`;
    this.leaseMs = positiveInteger(
      options.leaseMs,
      DEFAULT_AGENT_TASK_LEASE_MS,
    );
    this.maxTasksPerDrain = positiveInteger(
      options.maxTasksPerDrain,
      DEFAULT_MAX_TASKS_PER_DRAIN,
    );
    this.recoveryLimit = positiveInteger(
      options.recoveryLimit,
      DEFAULT_RECOVERY_LIMIT,
    );
    this.capabilities = options.capabilities?.filter(Boolean);
    this.eventPublisher = options.eventPublisher;
    this.logger = options.logger ?? createLogger("compose-agent-task-worker");
    this.metrics = options.metrics ?? specFactoryMetrics;
  }

  async drain(): Promise<ComposeAgentTaskWorkerDrainResult> {
    if (this.running) return emptyResult();
    this.running = true;
    const result = emptyResult();
    try {
      result.recovered = await this.repository.recoverExpiredAgentTaskLeases({
        expiredBefore: new Date(Date.now()),
        limit: this.recoveryLimit,
        abandonedErrorMessage: EXPIRED_LEASE_MESSAGE,
      });
      this.metrics.recordLeaseEvent({
        workType: "agent_task",
        event: "expired",
        count: result.recovered.requeued + result.recovered.abandoned,
      });
      for (let i = 0; i < this.maxTasksPerDrain; i += 1) {
        const task = await this.repository.claimNextAgentTask({
          workerId: this.workerId,
          leaseUntil: new Date(Date.now() + this.leaseMs),
          capabilities: this.capabilities,
        });
        if (!task) break;
        result.claimed += 1;
        const startedAt = Date.now();
        this.metrics.recordWorkStarted({
          workType: "agent_task",
          subtype: task.capability,
          queuedAt: task.queuedAt,
          startedAt,
        });
        const outcome = await runWithSpecFactoryCorrelation(
          {
            requestId: task.requestId ?? undefined,
            sessionId: task.sessionId,
            turnJobId: task.turnJobId ?? undefined,
            agentTaskId: task.id,
            workerId: this.workerId,
            leaseGeneration: task.leaseGeneration,
          },
          () => this.executeTask(task),
        );
        if (outcome === "succeeded") result.completed += 1;
        else result.failed += 1;
        this.metrics.recordWorkCompleted({
          workType: "agent_task",
          subtype: task.capability,
          outcome,
          startedAt,
        });
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private async executeTask(
    task: ClaimedAgentTask,
  ): Promise<SpecFactoryWorkOutcome> {
    await this.publishTaskEvent(task, "task.started");
    let runtimeRunId: number | null = null;
    try {
      runtimeRunId = await this.repository.startAgentRuntimeRun({
        sessionId: task.sessionId,
        agentTaskId: task.id,
        executorType: executorTypeForTask(task),
        workspaceUri: workspaceUriForTask(task),
      });
      const output = await withSpecFactorySpan(
        "agent_task.execute",
        {},
        async (span) => {
          span.setAttribute("spec_factory.capability", task.capability);
          span.setAttribute(
            "spec_factory.executor_type",
            task.executorType ?? "default",
          );
          return this.executors.execute(task);
        },
      );
      const completed = await this.completeTask(task, output);
      await this.safeFinishAgentRuntimeRun(runtimeRunId, {
        status: completed ? "completed" : "failed",
        ...runtimeMetadata(output),
        errorCode: completed ? null : "completion_rejected",
        errorMessage: completed
          ? null
          : "Agent task completion was rejected by the active lease fence",
      });
      if (completed) {
        if (
          task.capability === "context_merge" &&
          this.repository.enqueueContextMergeTaskIfNeeded
        ) {
          await this.repository.enqueueContextMergeTaskIfNeeded({
            sessionId: task.sessionId,
          });
        }
        await this.publishTaskEvent(task, "task.completed", output);
        await this.publishHandoffCompleted(task, output);
        return "succeeded";
      }
      this.metrics.recordLeaseEvent({
        workType: "agent_task",
        event: "fence_rejected",
        subtype: task.capability,
      });
      await this.publishTaskLeaseFenceRejected(task, "completion_rejected");
      return "fence_rejected";
    } catch (error) {
      const markedFailed = await this.repository.markAgentTaskFailed({
        agentTaskId: task.id,
        workerId: requireWorkerId(task),
        leaseGeneration: task.leaseGeneration,
        errorCode: "executor_failed",
        errorMessage: errorMessage(error),
      });
      await this.safeFinishAgentRuntimeRun(runtimeRunId, {
        status: "failed",
        ...emptyRuntimeMetadata(),
        errorCode: "executor_failed",
        errorMessage: errorMessage(error),
      });
      if (markedFailed) {
        await this.publishTaskEvent(task, "task.failed", {
          error: errorMessage(error),
        });
        await this.publishHandoffFailed(task, error);
      } else {
        this.metrics.recordLeaseEvent({
          workType: "agent_task",
          event: "fence_rejected",
          subtype: task.capability,
        });
        await this.publishTaskLeaseFenceRejected(
          task,
          "failure_write_rejected",
        );
      }
      this.logger.error(
        { err: error, agentTaskId: task.id, sessionId: task.sessionId },
        "Compose agent task execution failed",
      );
      return markedFailed ? "failed" : "fence_rejected";
    }
  }

  private completeTask(
    task: ClaimedAgentTask,
    output: AgentTaskExecutionResult,
  ): Promise<boolean> {
    return this.repository.completeAgentTask({
      agentTaskId: task.id,
      workerId: requireWorkerId(task),
      leaseGeneration: task.leaseGeneration,
      output: output.output,
      contextVersionUsed: output.contextVersionUsed,
      outputSourceId: output.outputSourceId,
    });
  }

  private async publishTaskEvent(
    task: ClaimedAgentTask,
    eventType: string,
    payload: unknown = {},
  ): Promise<void> {
    if (!this.eventPublisher) return;
    try {
      await this.eventPublisher.appendSessionEvent({
        sessionId: task.sessionId,
        eventType,
        payload: {
          capability: task.capability,
          executorType: task.executorType,
          ...payloadObject(payload),
        },
        actorType: "system",
        actorId: this.workerId,
        turnJobId: task.turnJobId,
        agentTaskId: task.id,
        requestId: task.requestId,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          sessionId: task.sessionId,
          agentTaskId: task.id,
          eventType,
        },
        "Compose agent task event write failed",
      );
    }
  }

  private async publishTaskLeaseFenceRejected(
    task: ClaimedAgentTask,
    reason: "completion_rejected" | "failure_write_rejected",
  ): Promise<void> {
    await this.publishTaskEvent(task, "task.lease_fence_rejected", { reason });
  }

  private async publishHandoffCompleted(
    task: ClaimedAgentTask,
    output: AgentTaskExecutionResult,
  ): Promise<void> {
    if (task.capability !== "handoff_build" || !this.eventPublisher) return;
    const input = taskInputObject(task);
    const sourceId =
      positiveIntegerInput(input.sourceId) ?? output.outputSourceId ?? null;
    const actor = nullableStringInput(input.actor);
    const artifactBytes = artifactBytesFromOutput(output.output);
    try {
      await this.eventPublisher.appendSessionEvent({
        sessionId: task.sessionId,
        eventType: "handoff.completed",
        payload: {
          sourceJiraKey: composeSourceJiraKey(task.sessionId),
          sourceId,
          reusedExistingSource:
            booleanInput(input.reusedExistingSource) ?? false,
          enriched: true,
          buildTaskId: task.id,
          ...(artifactBytes ? { artifactBytes } : {}),
        },
        actorType: actor ? "user" : "system",
        actorId: actor ?? this.workerId,
        turnJobId: task.turnJobId,
        agentTaskId: task.id,
        contextVersion: output.contextVersionUsed ?? null,
      });
    } catch (error) {
      this.logger.error(
        {
          err: error,
          sessionId: task.sessionId,
          agentTaskId: task.id,
          eventType: "handoff.completed",
        },
        "Spec Factory handoff event write failed",
      );
    }
  }

  private async publishHandoffFailed(
    task: ClaimedAgentTask,
    error: unknown,
  ): Promise<void> {
    if (task.capability !== "handoff_build" || !this.eventPublisher) return;
    const input = taskInputObject(task);
    const actor = nullableStringInput(input.actor);
    try {
      await this.eventPublisher.appendSessionEvent({
        sessionId: task.sessionId,
        eventType: "handoff.failed",
        payload: {
          sourceJiraKey: composeSourceJiraKey(task.sessionId),
          sourceId: positiveIntegerInput(input.sourceId) ?? null,
          buildTaskId: task.id,
          reason: "handoff_build_failed",
          message: errorMessage(error),
        },
        actorType: actor ? "user" : "system",
        actorId: actor ?? this.workerId,
        turnJobId: task.turnJobId,
        agentTaskId: task.id,
      });
    } catch (eventError) {
      this.logger.error(
        {
          err: eventError,
          sessionId: task.sessionId,
          agentTaskId: task.id,
          eventType: "handoff.failed",
        },
        "Spec Factory handoff event write failed",
      );
    }
  }

  private async safeFinishAgentRuntimeRun(
    runtimeRunId: number | null,
    input: Omit<
      Parameters<ComposeAgentTaskWorkerRepository["finishAgentRuntimeRun"]>[0],
      "runtimeRunId"
    >,
  ): Promise<void> {
    if (runtimeRunId === null) return;
    try {
      await this.repository.finishAgentRuntimeRun({
        runtimeRunId,
        ...input,
      });
    } catch (error) {
      this.logger.error(
        { err: error, runtimeRunId },
        "Compose agent runtime run finalization failed",
      );
    }
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return fallback;
  }
  return Math.trunc(value);
}

function emptyResult(): ComposeAgentTaskWorkerDrainResult {
  return {
    recovered: { requeued: 0, abandoned: 0 },
    claimed: 0,
    completed: 0,
    failed: 0,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireWorkerId(task: ClaimedAgentTask): string {
  if (!task.activeWorkerId) {
    throw new Error(`Compose agent task ${task.id} has no active worker lease`);
  }
  return task.activeWorkerId;
}

function executorTypeForTask(task: ClaimedAgentTask): string {
  return task.executorType ?? task.capability;
}

function workspaceUriForTask(task: ClaimedAgentTask): string | null {
  if (
    !task.input ||
    typeof task.input !== "object" ||
    Array.isArray(task.input)
  ) {
    return null;
  }
  const value = (task.input as Record<string, unknown>).workspaceUri;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function emptyRuntimeMetadata(): Required<
  NonNullable<AgentTaskExecutionResult["runtime"]>
> {
  return {
    provider: null,
    model: null,
    traceUri: null,
    outputArtifactUri: null,
    inputTokens: null,
    outputTokens: null,
    estimatedCostUsd: null,
  };
}

function runtimeMetadata(
  output: AgentTaskExecutionResult,
): Required<NonNullable<AgentTaskExecutionResult["runtime"]>> {
  const runtime = output.runtime ?? {};
  return {
    provider: runtime.provider ?? null,
    model: runtime.model ?? null,
    traceUri: runtime.traceUri ?? null,
    outputArtifactUri: runtime.outputArtifactUri ?? null,
    inputTokens: runtime.inputTokens ?? null,
    outputTokens: runtime.outputTokens ?? null,
    estimatedCostUsd: runtime.estimatedCostUsd ?? null,
  };
}

function payloadObject(payload: unknown): Record<string, unknown> {
  return payload && typeof payload === "object"
    ? (payload as Record<string, unknown>)
    : { value: payload };
}

function taskInputObject(task: ClaimedAgentTask): Record<string, unknown> {
  return task.input &&
    typeof task.input === "object" &&
    !Array.isArray(task.input)
    ? (task.input as Record<string, unknown>)
    : {};
}

function nullableStringInput(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function positiveIntegerInput(value: unknown): number | null {
  const numberValue = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(numberValue) || numberValue <= 0) return null;
  return numberValue;
}

function booleanInput(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function artifactBytesFromOutput(
  output: unknown,
): { markdown: number; json: number; total: number } | null {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return null;
  }
  const artifactBytes = (output as Record<string, unknown>).artifactBytes;
  if (
    !artifactBytes ||
    typeof artifactBytes !== "object" ||
    Array.isArray(artifactBytes)
  ) {
    return null;
  }
  const record = artifactBytes as Record<string, unknown>;
  const markdown = finiteNumber(record.markdown);
  const json = finiteNumber(record.json);
  const total = finiteNumber(record.total);
  if (markdown === null || json === null || total === null) return null;
  return { markdown, json, total };
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
