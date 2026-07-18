import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type { OperatorIdentity } from "../types/oneshotDeployments.js";
import type { OneShotProgressStage } from "../types/oneshot.js";
import {
  inferFailedStage,
  parseDashboardId,
  type FailedProgressStage,
} from "./oneshotRowHelpers.js";

const MANUAL_STAGE_RETRY_MAX = 2;

type RetryStage = Exclude<
  OneShotProgressStage,
  "qualification" | "pr_complete"
>;

type RetryRunRow = mysql.RowDataPacket & {
  id: number;
  jira_key: string;
  state: string;
  final_disposition: string | null;
  last_error: string | null;
  current_plan_version: number | null;
  current_review_version: number | null;
  current_implementation_version: number | null;
  current_implementation_branch: string | null;
  current_implementation_commit_sha: string | null;
  current_code_review_version: number | null;
  current_test_version: number | null;
};

type RetryCountRow = mysql.RowDataPacket & {
  retry_count: number;
};

type StageRow = mysql.RowDataPacket & {
  stage: string | null;
};

type RetryPlan = {
  stage: RetryStage;
  queuedState:
    | "queued_for_planning"
    | "queued_for_review"
    | "queued_for_implementation"
    | "queued_for_code_review"
    | "queued_for_testing";
  version: number;
  revision: boolean;
  manualRetryDedupeToken?: string;
  expectedImplementationCommitSha?: string | null;
  updates: Record<string, number | string | null>;
};

export class OneShotRunRetryError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "OneShotRunRetryError";
  }
}

function normalizeRetryStage(stage: FailedProgressStage): RetryStage | null {
  switch (stage) {
    case "planning":
    case "review":
    case "implementation":
    case "code_review":
    case "testing":
      return stage;
    default:
      return null;
  }
}

function queueEnvForStage(stage: RetryStage): string {
  switch (stage) {
    case "planning":
      return "ONESHOT_PLANNING_QUEUE_URL";
    case "review":
      return "ONESHOT_REVIEW_QUEUE_URL";
    case "implementation":
      return "ONESHOT_IMPLEMENTATION_QUEUE_URL";
    case "code_review":
      return "ONESHOT_CODE_REVIEW_QUEUE_URL";
    case "testing":
      return "ONESHOT_TESTING_QUEUE_URL";
  }
}

async function publishStageMessage(
  runId: number,
  plan: RetryPlan,
  sqsClient = new SQSClient({ region: process.env.AWS_REGION || "us-east-2" }),
): Promise<void> {
  const queueUrl = process.env[queueEnvForStage(plan.stage)];
  if (!queueUrl) {
    throw new Error(
      `Missing required OneShot queue environment variable: ${queueEnvForStage(plan.stage)}`,
    );
  }

  const message = {
    run_id: runId,
    stage: plan.stage,
    version: plan.version,
    expected_state: plan.queuedState,
    revision: plan.revision,
    emitted_at: new Date().toISOString(),
    ...(plan.expectedImplementationCommitSha
      ? { expected_implementation_commit_sha: plan.expectedImplementationCommitSha }
      : {}),
  };
  const dedupeKind = plan.revision ? "revision" : "base";
  const manualRetryDedupeSuffix = plan.manualRetryDedupeToken
    ? `:${plan.manualRetryDedupeToken}`
    : "";

  await sqsClient.send(
    new SendMessageCommand({
      QueueUrl: queueUrl,
      MessageBody: JSON.stringify(message),
      MessageGroupId: String(runId),
      MessageDeduplicationId: `${runId}:${plan.stage}:${plan.version}:${dedupeKind}${manualRetryDedupeSuffix}`,
    }),
  );
}

async function fetchLatestFailedTransitionStage(
  connection: mysql.Connection,
  runId: number,
): Promise<string | null> {
  const [rows] = await connection.query<StageRow[]>(
    `SELECT COALESCE(stage, from_state) AS stage
     FROM oneshot_run_events
     WHERE oneshot_run_id = ?
       AND event_type = 'state_transition'
       AND to_state = 'failed'
     ORDER BY id DESC
     LIMIT 1`,
    [runId],
  );
  return rows[0]?.stage ?? null;
}

async function fetchLatestArtifactStage(
  connection: mysql.Connection,
  runId: number,
): Promise<string | null> {
  const [rows] = await connection.query<StageRow[]>(
    `SELECT stage
     FROM oneshot_artifacts
     WHERE oneshot_run_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [runId],
  );
  return rows[0]?.stage ?? null;
}

async function countManualRetries(
  connection: mysql.Connection,
  runId: number,
  stage: RetryStage,
): Promise<number> {
  const [rows] = await connection.query<RetryCountRow[]>(
    `SELECT COUNT(*) AS retry_count
     FROM oneshot_run_events
     WHERE oneshot_run_id = ?
       AND event_type = 'state_transition'
       AND stage = ?
       AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) = 'manual_stage_retry'`,
    [runId, stage],
  );
  return Number(rows[0]?.retry_count ?? 0);
}

function buildRetryPlan(run: RetryRunRow, stage: RetryStage): RetryPlan {
  switch (stage) {
    case "planning":
      return {
        stage,
        queuedState: "queued_for_planning",
        version: (run.current_plan_version ?? 0) + 1,
        revision:
          run.current_plan_version !== null &&
          run.final_disposition !== "replan_requested",
        updates: {
          planning_attempt_count: 0,
        },
      };
    case "review":
      if (!run.current_plan_version) {
        throw new OneShotRunRetryError(
          "Cannot retry review without an approved plan version.",
          409,
        );
      }
      return {
        stage,
        queuedState: "queued_for_review",
        version: run.current_plan_version,
        revision: false,
        updates: {},
      };
    case "implementation": {
      const hasPriorImplementationOutput = Boolean(
        run.current_implementation_branch && run.current_implementation_commit_sha,
      );
      return {
        stage,
        queuedState: "queued_for_implementation",
        version: (run.current_implementation_version ?? 0) + 1,
        revision: hasPriorImplementationOutput,
        updates: {
          implementation_attempt_count: 0,
          current_implementation_version:
            (run.current_implementation_version ?? 0) + 1,
          current_implementation_commit_sha: null,
        },
      };
    }
    case "code_review":
      if (!run.current_implementation_version) {
        throw new OneShotRunRetryError(
          "Cannot retry code review without an implementation version.",
          409,
        );
      }
      if (!run.current_implementation_branch || !run.current_implementation_commit_sha) {
        throw new OneShotRunRetryError(
          "Cannot retry code review without an implementation branch and commit.",
          409,
        );
      }
      return {
        stage,
        queuedState: "queued_for_code_review",
        version: (run.current_code_review_version ?? 0) + 1,
        revision: false,
        expectedImplementationCommitSha: run.current_implementation_commit_sha,
        updates: {
          code_review_attempt_count: 0,
          current_code_review_version:
            (run.current_code_review_version ?? 0) + 1,
        },
      };
    case "testing":
      if (!run.current_implementation_version) {
        throw new OneShotRunRetryError(
          "Cannot retry testing without an implementation version.",
          409,
        );
      }
      if (!run.current_implementation_branch || !run.current_implementation_commit_sha) {
        throw new OneShotRunRetryError(
          "Cannot retry testing without an implementation branch and commit.",
          409,
        );
      }
      return {
        stage,
        queuedState: "queued_for_testing",
        version: (run.current_test_version ?? 0) + 1,
        revision: false,
        expectedImplementationCommitSha: run.current_implementation_commit_sha,
        updates: {
          current_test_version: (run.current_test_version ?? 0) + 1,
        },
      };
  }
}

function buildUpdateStatement(plan: RetryPlan): {
  sql: string;
  values: Array<number | string | null>;
} {
  const setClauses = [
    "state = ?",
    "last_error = NULL",
    "final_disposition = NULL",
    "updated_at = NOW()",
  ];
  const values: Array<number | string | null> = [plan.queuedState];

  for (const [column, value] of Object.entries(plan.updates)) {
    setClauses.push(`${column} = ?`);
    values.push(value);
  }

  return {
    sql: `UPDATE oneshot_runs SET ${setClauses.join(", ")} WHERE id = ? AND state = 'failed'`,
    values,
  };
}

function truncateMetadataText(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return value.length > 1000 ? `${value.slice(0, 1000)}...` : value;
}

export async function retryOneShotRunStage(
  input: {
    dashboardId: string;
    operator: OperatorIdentity;
  },
  deps: {
    publish?: (runId: number, plan: RetryPlan) => Promise<void>;
  } = {},
): Promise<{
  oneshotRunId: number;
  stage: RetryStage;
  state: RetryPlan["queuedState"];
  version: number;
  attemptsUsed: number;
  attemptsRemaining: number;
  publishError?: string;
}> {
  const lookup = parseDashboardId(input.dashboardId);
  if (!lookup || lookup.kind !== "run") {
    throw new OneShotRunRetryError("Only OneShot run rows can be retried.", 409);
  }

  const connection = await getPool().getConnection();
  let runId = lookup.id;
  let plan: RetryPlan | null = null;
  let attemptsUsed = 0;

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query<RetryRunRow[]>(
      `SELECT
         id,
         jira_key,
         state,
         final_disposition,
         last_error,
         current_plan_version,
         current_review_version,
         current_implementation_version,
         current_implementation_branch,
         current_implementation_commit_sha,
         current_code_review_version,
         current_test_version
       FROM oneshot_runs
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [lookup.id],
    );
    const run = rows[0] ?? null;
    if (!run) {
      throw new OneShotRunRetryError("OneShot run not found.", 404);
    }
    runId = run.id;

    if (run.state !== "failed") {
      throw new OneShotRunRetryError(
        `Only failed OneShot runs can be retried; current state is ${run.state}.`,
        409,
      );
    }

    const transitionStage = await fetchLatestFailedTransitionStage(connection, run.id);
    const latestArtifactStage = await fetchLatestArtifactStage(connection, run.id);
    const failedStage = inferFailedStage({
      transitionStage,
      finalDisposition: run.final_disposition,
      latestArtifactStage,
      currentPlanVersion: run.current_plan_version,
      currentReviewVersion: run.current_review_version,
      currentImplementationVersion: run.current_implementation_version,
      currentCodeReviewVersion: run.current_code_review_version,
      currentTestVersion: run.current_test_version,
    });
    const retryStage = normalizeRetryStage(failedStage);
    if (!retryStage) {
      throw new OneShotRunRetryError(
        `Stage ${failedStage} is not retryable from the OneShot run retry button.`,
        409,
      );
    }

    attemptsUsed = await countManualRetries(connection, run.id, retryStage);
    if (attemptsUsed >= MANUAL_STAGE_RETRY_MAX) {
      throw new OneShotRunRetryError(
        `Retry limit reached for ${retryStage}.`,
        409,
      );
    }

    plan = buildRetryPlan(run, retryStage);
    const update = buildUpdateStatement(plan);
    const [updateResult] = await connection.query<mysql.ResultSetHeader>(
      update.sql,
      [...update.values, run.id],
    );
    if (updateResult.affectedRows !== 1) {
      throw new OneShotRunRetryError(
        `OneShot run ${run.id} changed state before retry could be queued.`,
        409,
      );
    }

    const [eventResult] = await connection.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_run_events
         (oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        run.id,
        "state_transition",
        "failed",
        plan.queuedState,
        plan.stage,
        JSON.stringify({
          reason: "manual_stage_retry",
          operatorId: input.operator.id,
          operatorDisplay: input.operator.display,
          attemptNumber: attemptsUsed + 1,
          maxAttempts: MANUAL_STAGE_RETRY_MAX,
          version: plan.version,
          revision: plan.revision,
          previousFinalDisposition: run.final_disposition,
          previousLastError: truncateMetadataText(run.last_error),
        }),
      ],
    );
    const eventId = Number(eventResult.insertId);
    plan.manualRetryDedupeToken = Number.isFinite(eventId) && eventId > 0
      ? `manual-retry:${eventId}`
      : `manual-retry:${attemptsUsed + 1}:${Date.now()}`;

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  if (!plan) {
    throw new OneShotRunRetryError("Retry plan was not created.", 500);
  }

  let publishError: string | undefined;
  try {
    await (deps.publish ?? publishStageMessage)(runId, plan);
  } catch (error) {
    publishError = error instanceof Error ? error.message : String(error);
  }

  return {
    oneshotRunId: runId,
    stage: plan.stage,
    state: plan.queuedState,
    version: plan.version,
    attemptsUsed: attemptsUsed + 1,
    attemptsRemaining: Math.max(
      0,
      MANUAL_STAGE_RETRY_MAX - (attemptsUsed + 1),
    ),
    publishError,
  };
}
