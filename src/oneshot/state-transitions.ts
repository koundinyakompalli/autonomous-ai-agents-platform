import { PutObjectCommand, type S3Client } from "@aws-sdk/client-s3";
import type { Database } from "../orchestrator/database.js";
import { createLogger } from "../utils/logger.js";
import { OneShotDatabase } from "./database/index.js";
import { buildPostmortem, renderPostmortemMarkdown } from "./postmortem.js";
import { runOutcomeCounter } from "./telemetry/metrics.js";
import { createLeasedOneShotWorkspaceManager } from "./workspaces.js";
import { maybeGenerateTriageReport } from "./triage-report.js";
import type {
  CreateOneShotNotificationInput,
  OneShotState,
  UpdateOneShotRunFields,
} from "./types.js";

const logger = createLogger("oneshot:state-transitions");
const STACK_PREVIEW_LIMIT = 2_000;

export interface PostmortemContext {
  s3Client: S3Client;
  artifactBucket: string;
  artifactPrefix: string;
  jiraKey: string;
  failedStage?: string;
}

export function buildPostmortemContext(
  input: PostmortemContext,
): PostmortemContext {
  return input;
}

interface TransitionRunWithNotificationInput {
  runId: number;
  toState: OneShotState;
  fromState?: OneShotState;
  updates?: UpdateOneShotRunFields;
  notification?: CreateOneShotNotificationInput;
  notifications?: CreateOneShotNotificationInput[];
  postmortemContext?: PostmortemContext;
  workspaceCleanupContext?: {
    repoAdminBasePath: string;
    repoCacheBasePath?: string;
    workspaceBasePath: string;
    worktreeBasePath?: string;
  };
}

export async function withOneShotTransaction<T>(
  db: Database,
  operation: (txdb: OneShotDatabase) => Promise<T>,
): Promise<T> {
  const connection = await db.getPool().getConnection();

  try {
    await connection.beginTransaction();
    const txdb = new OneShotDatabase(connection);
    const result = await operation(txdb);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function transitionRunWithNotification(
  db: Database,
  input: TransitionRunWithNotificationInput,
): Promise<boolean> {
  const transitioned = await withOneShotTransaction(db, async (txdb) => {
    const didTransition = input.fromState
      ? await txdb.runs.updateRunStateIfCurrentState(
          input.runId,
          input.fromState,
          input.toState,
          input.updates ?? {},
        )
      : (await txdb.runs.updateRunState(
          input.runId,
          input.toState,
          input.updates ?? {},
        ),
        true);

    if (!didTransition) {
      return false;
    }

    const notifications = [
      ...(input.notification ? [input.notification] : []),
      ...(input.notifications ?? []),
    ];

    for (const notification of notifications) {
      await txdb.notifications.createNotification(notification);
    }

    return true;
  });

  // Fire-and-forget postmortem generation after the transaction commits.
  // This runs outside the transaction because it reads the data just written
  // and performs non-critical S3 writes that should not block or roll back
  // the state transition.
  if (transitioned && input.toState === "failed" && input.postmortemContext) {
    generatePostmortemArtifact(db, input.runId, input.postmortemContext).catch(
      (err) => {
        void recordPostmortemFailure(
          db,
          input.runId,
          err,
          input.postmortemContext?.failedStage,
        ).catch((recordErr) => {
          logger.error(
            {
              runId: input.runId,
              error:
                recordErr instanceof Error
                  ? recordErr.message
                  : String(recordErr),
              stack: recordErr instanceof Error ? recordErr.stack : undefined,
            },
            "Failed to record postmortem failure event",
          );
        });
      },
    );
  }

  const TERMINAL_STATES: OneShotState[] = [
    "completed",
    "failed",
    "blocked",
    "escalated",
    "pr_open",
  ];
  if (
    transitioned &&
    TERMINAL_STATES.includes(input.toState) &&
    input.workspaceCleanupContext
  ) {
    cleanupTerminalWorkspace(
      db,
      input.runId,
      input.workspaceCleanupContext,
    ).catch((err) => {
      logger.error(
        {
          runId: input.runId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to cleanup terminal workspace",
      );
    });
  }

  // Fire-and-forget: when a run in a group reaches terminal state, check if
  // all runs in the group are done and generate the TRIAGE leadership report.
  // Requires the run to have a run_group_id (set for PFOS batch runs).
  if (transitioned && TERMINAL_STATES.includes(input.toState)) {
    maybeCheckGroupCompletion(db, input.runId).catch((err) => {
      logger.error(
        {
          runId: input.runId,
          error: err instanceof Error ? err.message : String(err),
        },
        "Failed to check run group completion for TRIAGE report",
      );
    });
  }

  return transitioned;
}

async function maybeCheckGroupCompletion(
  db: Database,
  runId: number,
): Promise<void> {
  // Use the pool (not getConnection) to avoid leaking a dedicated connection.
  // OneShotDatabase accepts a Pool and issues queries that auto-return to pool.
  const oneShotDb = new OneShotDatabase(db.getPool());
  const run = await oneShotDb.runs.getRunById(runId);
  if (!run) return;
  // Pass run_group_id (may be null for individual TRIAGE runs — report
  // generator handles both cases: grouped and individual-by-EPIC).
  await maybeGenerateTriageReport(
    db,
    oneShotDb,
    runId,
    run.run_group_id ?? null,
  );
}

async function cleanupTerminalWorkspace(
  db: Database,
  runId: number,
  ctx: {
    repoAdminBasePath: string;
    repoCacheBasePath?: string;
    workspaceBasePath: string;
    worktreeBasePath?: string;
  },
): Promise<void> {
  const oneShotDb = new OneShotDatabase(db.getPool());
  const manager = createLeasedOneShotWorkspaceManager(oneShotDb, {
    repoBasePath: ctx.repoAdminBasePath,
    repoCacheBasePath: ctx.repoCacheBasePath,
    workspaceBasePath: ctx.workspaceBasePath,
    worktreeBasePath: ctx.worktreeBasePath,
    leaseOwnerTaskArn: process.env.ECS_TASK_ARN ?? `pid:${process.pid}`,
  });
  const status = await manager.cleanupRunWorkspace(runId);
  if (status === "cleaned") {
    logger.info({ runId }, "Cleaned up terminal workspace");
  }
}

export async function generatePostmortemArtifact(
  db: Database,
  runId: number,
  ctx: PostmortemContext,
): Promise<void> {
  const oneShotDb = new OneShotDatabase(db.getPool());
  const run = await oneShotDb.runs.getRunById(runId);
  if (!run) return;

  const events = await oneShotDb.events.getEventsForRun(runId);
  const allArtifacts = await oneShotDb.artifacts.getArtifactsForRun(runId);

  const postmortem = buildPostmortem(
    run,
    events,
    allArtifacts,
    ctx.failedStage,
  );
  const postmortemJson = JSON.stringify(postmortem, null, 2);
  const postmortemMd = renderPostmortemMarkdown(postmortem);

  const keyBase = `${ctx.artifactPrefix}/${ctx.jiraKey}/run-${runId}/postmortem`;

  await ctx.s3Client.send(
    new PutObjectCommand({
      Bucket: ctx.artifactBucket,
      Key: `${keyBase}/postmortem.json`,
      Body: postmortemJson,
      ContentType: "application/json",
    }),
  );

  await ctx.s3Client.send(
    new PutObjectCommand({
      Bucket: ctx.artifactBucket,
      Key: `${keyBase}/postmortem.md`,
      Body: postmortemMd,
      ContentType: "text/markdown",
    }),
  );

  await oneShotDb.events.createEvent({
    oneshot_run_id: runId,
    event_type: "artifact_stored",
    stage: "postmortem",
    metadata_json: {
      bucket: ctx.artifactBucket,
      jsonKey: `${keyBase}/postmortem.json`,
      markdownKey: `${keyBase}/postmortem.md`,
    },
  });
}

export async function recordPostmortemFailure(
  db: Database,
  runId: number,
  error: unknown,
  failedStage?: string,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : undefined;

  logger.error(
    {
      runId,
      error: errorMessage,
      stack: errorStack,
    },
    "Failed to generate postmortem artifact",
  );
  runOutcomeCounter.add(1, {
    stage: "postmortem",
    outcome: "failed",
  });

  const oneShotDb = new OneShotDatabase(db.getPool());
  await oneShotDb.events.createEvent({
    oneshot_run_id: runId,
    event_type: "artifact_generation_failed",
    stage: "postmortem",
    metadata_json: {
      failedStage: failedStage ?? null,
      error: errorMessage,
      stack: errorStack ?? null,
      stackPreview: errorStack
        ? errorStack.slice(0, STACK_PREVIEW_LIMIT)
        : null,
    },
  });
}
