import type mysql from "mysql2/promise";
import type { OneShotQueryExecutor } from "./index.js";
import { parseJsonValue, type JsonObjectRowValue } from "./utils.js";
import type { OneShotState } from "../types.js";

export type RunEventType =
  | "run_created"
  | "state_transition"
  | "state_revert"
  | "token_usage_added"
  | "artifact_stored"
  | "artifact_generation_failed"
  | "trace_generated"
  | "verify_completed"
  | "trace_jira_attachment_failed"
  | "trace_jira_attachment_skipped"
  | "trace_jira_comment_failed"
  | "trace_jira_post_completed"
  | "notification_created"
  | "implementation_plan_jira_attachment_failed"
  | "implementation_plan_jira_attachment_skipped"
  | "implementation_plan_jira_post_completed"
  | "implementation_plan_ready_notification_failed"
  | "verification_only_completed"
  | "run_claimed"
  | "reconciliation_republished"
  | "stale_stage_message_dropped"
  | "candidate_sha_legacy_unpinned"
  | "candidate_sha_mismatch_dropped"
  | "branch_hygiene"
  | "base_refreshed"
  | "ci_refresh_requested"
  | "risk_classification_observed"
  | "risk_classification_finalized"
  | "ticket_type_updated"
  | "readiness_classified"
  | "stage_attempt_metrics"
  | "sdk_lifecycle_observed"
  | "planner_config_warning"
  | "implementation_session_resume"
  | "run_branch_created"
  | "run_branch_reused"
  | "run_branch_repaired"
  | "run_workspace_prepared"
  | "retrofit_patch_apply_result"
  | "retrofit_adaptation_started"
  | "retrofit_adaptation_proof_repaired"
  | "retrofit_patch_validation_failed"
  | "retrofit_revision_proof_carried_forward"
  | "retrofit_revision_proof_updated"
  | "retrofit_revision_proof_regressed"
  | "control_replan_requested"
  | "control_replan_noop"
  | "replan_label_cleanup_failed"
  | "replan_label_cleanup_observed"
  | "workspace_cleanup_requested"
  | "workspace_cleanup_completed";

export interface OneShotRunEvent {
  id: number;
  oneshot_run_id: number;
  event_type: RunEventType;
  from_state: OneShotState | null;
  to_state: OneShotState | null;
  stage: string | null;
  metadata_json: Record<string, unknown> | null;
  occurred_at: Date;
}

export type OneShotBudgetEvent = Pick<
  OneShotRunEvent,
  "event_type" | "stage" | "metadata_json"
>;

export interface CreateOneShotRunEventInput {
  oneshot_run_id: number;
  event_type: RunEventType;
  from_state?: OneShotState | null;
  to_state?: OneShotState | null;
  stage?: string | null;
  metadata_json?: Record<string, unknown> | null;
}

type OneShotRunEventRow = mysql.RowDataPacket & {
  id: number;
  oneshot_run_id: number;
  event_type: RunEventType;
  from_state: string | null;
  to_state: string | null;
  stage: string | null;
  metadata_json: JsonObjectRowValue;
  occurred_at: Date | string;
};

type OneShotRunEventIdRow = mysql.RowDataPacket & {
  id: number;
};

type OneShotRunEventOccurredAtRow = mysql.RowDataPacket & {
  occurred_at: Date | string;
};

type OneShotBudgetEventRow = mysql.RowDataPacket & {
  event_type: RunEventType;
  stage: string | null;
  metadata_json: JsonObjectRowValue;
};

function mapEvent(row: OneShotRunEventRow): OneShotRunEvent {
  return {
    id: row.id,
    oneshot_run_id: row.oneshot_run_id,
    event_type: row.event_type,
    from_state: (row.from_state as OneShotState) ?? null,
    to_state: (row.to_state as OneShotState) ?? null,
    stage: row.stage,
    metadata_json: parseJsonValue(row.metadata_json),
    occurred_at:
      row.occurred_at instanceof Date
        ? row.occurred_at
        : new Date(row.occurred_at),
  };
}

export class OneShotRunEventsDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  async createEvent(input: CreateOneShotRunEventInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO oneshot_run_events
         (oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, NOW())`,
      [
        input.oneshot_run_id,
        input.event_type,
        input.from_state ?? null,
        input.to_state ?? null,
        input.stage ?? null,
        input.metadata_json ? JSON.stringify(input.metadata_json) : null,
      ],
    );
  }

  async getEventsForRun(runId: number): Promise<OneShotRunEvent[]> {
    const [idRows] = await this.pool.query<OneShotRunEventIdRow[]>(
      `SELECT id
       FROM oneshot_run_events
       WHERE oneshot_run_id = ?
       ORDER BY occurred_at ASC, id ASC`,
      [runId],
    );
    const orderedIds = idRows.map((row) => row.id);
    if (orderedIds.length === 0) {
      return [];
    }

    const [rows] = await this.pool.query<OneShotRunEventRow[]>(
      `SELECT id, oneshot_run_id, event_type, from_state, to_state, stage, metadata_json, occurred_at
       FROM oneshot_run_events
       WHERE id IN (?)`,
      [orderedIds],
    );
    const orderById = new Map(orderedIds.map((id, index) => [id, index]));
    return rows
      .sort(
        (left, right) =>
          (orderById.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
          (orderById.get(right.id) ?? Number.MAX_SAFE_INTEGER),
      )
      .map(mapEvent);
  }

  async getLatestManualStageRestartAt(runId: number): Promise<Date | null> {
    const [rows] = await this.pool.query<OneShotRunEventOccurredAtRow[]>(
      `SELECT occurred_at
       FROM oneshot_run_events
       WHERE oneshot_run_id = ?
         AND event_type = 'state_transition'
         AND JSON_UNQUOTE(JSON_EXTRACT(metadata_json, '$.reason')) = 'manual_stage_restart'
       ORDER BY occurred_at DESC, id DESC
       LIMIT 1`,
      [runId],
    );
    const occurredAt = rows[0]?.occurred_at;
    if (!occurredAt) {
      return null;
    }

    return occurredAt instanceof Date ? occurredAt : new Date(occurredAt);
  }

  async getStageAttemptMetricEventsForBudget(
    runId: number,
    stage: string,
  ): Promise<OneShotBudgetEvent[]> {
    const [rows] = await this.pool.query<OneShotBudgetEventRow[]>(
      `SELECT event_type, stage, metadata_json
       FROM oneshot_run_events
       WHERE oneshot_run_id = ?
         AND event_type = 'stage_attempt_metrics'
         AND stage = ?
       ORDER BY occurred_at ASC, id ASC`,
      [runId, stage],
    );

    return rows.map((row) => ({
      event_type: row.event_type,
      stage: row.stage,
      metadata_json: parseJsonValue(row.metadata_json),
    }));
  }
}
