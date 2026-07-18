import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type { OperatorIdentity } from "../types/oneshotDeployments.js";

const TERMINAL_STATES = new Set(["completed", "failed", "blocked", "pr_open"]);

export type WorkspaceCleanupStatus =
  | "requested"
  | "cleaned"
  | "not_found"
  | "skipped_lease_held"
  | "failed";

type KillableRunState =
  | "queued_for_planning"
  | "planning"
  | "queued_for_review"
  | "reviewing"
  | "needs_revision"
  | "approved"
  | "escalated"
  | "queued_for_implementation"
  | "implementing"
  | "queued_for_code_review"
  | "code_reviewing"
  | "queued_for_testing"
  | "testing"
  | "replan_required";

type TerminationRunRow = mysql.RowDataPacket & {
  id: number;
  jira_key: string;
  state: string;
  final_disposition: string | null;
};

export class OneShotRunTerminationError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "OneShotRunTerminationError";
  }
}

function mapFailureStage(
  state: string,
  finalDisposition: string | null,
): "planning" | "review" | "implementation" | "code_review" | "testing" {
  switch (state as KillableRunState) {
    case "queued_for_planning":
    case "planning":
      return "planning";
    case "queued_for_review":
    case "reviewing":
    case "needs_revision":
    case "approved":
      return "review";
    case "queued_for_implementation":
    case "implementing":
    case "replan_required":
      return "implementation";
    case "queued_for_code_review":
    case "code_reviewing":
      return "code_review";
    case "queued_for_testing":
    case "testing":
      return "testing";
    case "escalated":
      return finalDisposition === "code_review_escalated"
        ? "code_review"
        : "review";
  }
}

function buildOperatorKillMessage(
  operator: OperatorIdentity,
  reason?: string,
): string {
  const reasonSuffix = reason?.trim() ? ` Reason: ${reason.trim()}` : "";
  return `OneShot run terminated by ${operator.display} (${operator.id}).${reasonSuffix}`;
}

function buildOperatorKillNotificationBody(
  jiraKey: string,
  operator: OperatorIdentity,
  reason?: string,
): string {
  const reasonLine = reason?.trim()
    ? `\n\nOperator reason: ${reason.trim()}`
    : "";

  return (
    `# OneShot Run Failed for ${jiraKey}\n\n` +
    `Run terminated by ${operator.display} (${operator.id}).` +
    reasonLine
  );
}

export async function terminateOneShotRun(input: {
  oneshotRunId: number;
  operator: OperatorIdentity;
  reason?: string;
}): Promise<{
  oneshotRunId: number;
  workspaceCleanupStatus: WorkspaceCleanupStatus;
  workspaceCleanupSucceeded: boolean;
}> {
  const connection = await getPool().getConnection();
  const trimmedReason = input.reason?.trim() || undefined;

  try {
    await connection.beginTransaction();

    const [rows] = await connection.query<TerminationRunRow[]>(
      `SELECT id, jira_key, state, final_disposition
       FROM oneshot_runs
       WHERE id = ?
       LIMIT 1
       FOR UPDATE`,
      [input.oneshotRunId],
    );

    const runRow = rows[0] ?? null;
    if (!runRow) {
      throw new OneShotRunTerminationError("OneShot run not found", 404);
    }

    if (TERMINAL_STATES.has(runRow.state)) {
      throw new OneShotRunTerminationError(
        `OneShot run ${input.oneshotRunId} is already terminal`,
        409,
      );
    }

    const failureStage = mapFailureStage(
      runRow.state,
      runRow.final_disposition,
    );
    const lastError = buildOperatorKillMessage(input.operator, trimmedReason);
    const notificationBody = buildOperatorKillNotificationBody(
      runRow.jira_key,
      input.operator,
      trimmedReason,
    );
    const metadata = JSON.stringify({
      reason: "operator_kill",
      operatorId: input.operator.id,
      operatorDisplay: input.operator.display,
      operatorReason: trimmedReason,
    });

    const [updateResult] = await connection.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_runs
       SET state = 'failed',
           final_disposition = 'run_failed',
           last_error = ?,
           updated_at = NOW()
       WHERE id = ?
         AND state = ?`,
      [lastError, input.oneshotRunId, runRow.state],
    );

    if (updateResult.affectedRows !== 1) {
      throw new OneShotRunTerminationError(
        `OneShot run ${input.oneshotRunId} changed state before termination could be applied`,
        409,
      );
    }

    await connection.query(
      `INSERT INTO oneshot_run_events
         (oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        input.oneshotRunId,
        "state_transition",
        runRow.state,
        "failed",
        failureStage,
        metadata,
      ],
    );

    await connection.query(
      `INSERT INTO oneshot_notifications
         (oneshot_run_id, jira_key, notification_type, body_markdown)
       VALUES (?, ?, ?, ?)`,
      [input.oneshotRunId, runRow.jira_key, "run_failed", notificationBody],
    );

    await connection.query(
      `INSERT INTO oneshot_run_events
         (oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        input.oneshotRunId,
        "workspace_cleanup_requested",
        null,
        null,
        failureStage,
        metadata,
      ],
    );

    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  return {
    oneshotRunId: input.oneshotRunId,
    workspaceCleanupStatus: "requested",
    workspaceCleanupSucceeded: true,
  };
}
