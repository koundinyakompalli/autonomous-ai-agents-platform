import type { Logger } from "pino";
import type { OneShotQueueMessage } from "./contracts.js";
import type { OneShotDatabase } from "./database/index.js";
import { expectedVersionForQueuedStage } from "./stage-version-guard.js";
import type { OneShotState, UpdateOneShotRunFields } from "./types.js";

export class WorkspaceLeaseLostError extends Error {
  readonly kind: string = "workspace_lease_lost";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspaceLeaseLostError";
  }
}

export class RepoCacheLeaseTimeoutError extends WorkspaceLeaseLostError {
  readonly kind = "repo_cache_lease_timeout";
  readonly metadata?: Record<string, unknown>;

  constructor(
    public readonly scope: string,
    options?: { cause?: unknown; metadata?: Record<string, unknown> },
  ) {
    super(`Timed out acquiring OneShot workspace lease ${scope}`, options);
    this.name = "RepoCacheLeaseTimeoutError";
    this.metadata = options?.metadata;
  }
}

export class WorkspaceCheckoutTimeoutError extends Error {
  readonly kind = "workspace_checkout_timeout";

  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "WorkspaceCheckoutTimeoutError";
  }
}

export function isRepoCacheLeaseTimeoutError(error: unknown): boolean {
  if (error instanceof RepoCacheLeaseTimeoutError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Timed out acquiring OneShot workspace lease repo-cache:")
  );
}

export function repoCacheLeaseTimeoutMetadata(
  error: unknown,
): Record<string, unknown> | undefined {
  return error instanceof RepoCacheLeaseTimeoutError
    ? error.metadata
    : undefined;
}

export function isWorkspaceCheckoutTimeoutError(error: unknown): boolean {
  if (error instanceof WorkspaceCheckoutTimeoutError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return message.includes("workspace_checkout_timeout");
}

export function isWorkspaceLeaseLossError(error: unknown): boolean {
  if (error instanceof WorkspaceLeaseLostError) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Lost OneShot workspace lease") ||
    message.includes("Lost workspace lease") ||
    message.includes("Timed out acquiring OneShot workspace lease repo-cache:")
  );
}

const ACTIVE_STATE_BY_STAGE: Record<OneShotQueueMessage["stage"], OneShotState> =
  {
    planning: "planning",
    review: "reviewing",
    implementation: "implementing",
    code_review: "code_reviewing",
    testing: "testing",
  };

export async function recoverStageAfterWorkspaceLeaseLoss(input: {
  oneShotDb: OneShotDatabase;
  logger: Logger;
  runId: number;
  jiraKey: string;
  payload: OneShotQueueMessage;
  receiveCount: number;
  error: unknown;
  updates?: UpdateOneShotRunFields;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  const errorMessage =
    input.error instanceof Error ? input.error.message : String(input.error);
  const activeState = ACTIVE_STATE_BY_STAGE[input.payload.stage];
  const lastError = `Workspace lease lost during ${input.payload.stage}; stage requeued for retry`;

  const requeued = await input.oneShotDb.runs.updateRunStateIfCurrentState(
    input.runId,
    activeState,
    input.payload.expected_state,
    { last_error: lastError, ...(input.updates ?? {}) },
  );

  if (requeued) {
    const repoCacheMetadata = repoCacheLeaseTimeoutMetadata(input.error);
    input.oneShotDb.events
      .createEvent({
        oneshot_run_id: input.runId,
        event_type: "state_transition",
        from_state: activeState,
        to_state: input.payload.expected_state,
        stage: input.payload.stage,
        metadata_json: {
          reason: "workspace_lease_lost",
          version: input.payload.version,
          revision: input.payload.revision,
          receiveCount: input.receiveCount,
          error: errorMessage,
          retryable: true,
          ...(input.metadata ?? {}),
          ...(repoCacheMetadata
            ? { repo_cache_lease_timeout: repoCacheMetadata }
            : {}),
        },
      })
      .catch((eventError: unknown) => {
        input.logger.warn(
          {
            runId: input.runId,
            jiraKey: input.jiraKey,
            stage: input.payload.stage,
            eventType: "state_transition",
            error:
              eventError instanceof Error
                ? eventError.message
                : String(eventError),
          },
          "Failed to persist workspace lease-loss recovery event; continuing redelivery",
        );
      });

    input.logger.warn(
      {
        runId: input.runId,
        jiraKey: input.jiraKey,
        stage: input.payload.stage,
        version: input.payload.version,
        revision: input.payload.revision,
        receiveCount: input.receiveCount,
        fromState: activeState,
        toState: input.payload.expected_state,
        error: errorMessage,
      },
      "Recovered OneShot stage after workspace lease loss; leaving message for redelivery",
    );
    return false;
  }

  const latestRun = await input.oneShotDb.runs.getRunById(input.runId);
  if (
    latestRun &&
    latestRun.state === input.payload.expected_state &&
    expectedVersionForQueuedStage(latestRun, input.payload.stage) ===
      input.payload.version
  ) {
    input.logger.warn(
      {
        runId: input.runId,
        jiraKey: input.jiraKey,
        stage: input.payload.stage,
        version: input.payload.version,
        revision: input.payload.revision,
        receiveCount: input.receiveCount,
        currentState: latestRun.state,
        error: errorMessage,
      },
      "Workspace lease-loss recovery found run already queued; leaving message for redelivery",
    );
    return false;
  }

  input.logger.warn(
    {
      runId: input.runId,
      jiraKey: input.jiraKey,
      stage: input.payload.stage,
      version: input.payload.version,
      revision: input.payload.revision,
      receiveCount: input.receiveCount,
      expectedState: input.payload.expected_state,
      activeState,
      currentState: latestRun?.state ?? null,
      currentVersion: latestRun
        ? expectedVersionForQueuedStage(latestRun, input.payload.stage)
        : null,
      error: errorMessage,
    },
    "Workspace lease-loss recovery skipped because another owner or state transition superseded this worker",
  );
  return true;
}
