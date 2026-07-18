import type mysql from "mysql2/promise";
import { getDatabase } from "../../orchestrator/database.js";

type MaintenancePool = Pick<mysql.Pool, "query">;

export interface ControlPlaneMaintenanceOptions {
  now?: Date;
  limit?: number;
  outboxRetentionDays?: number;
  receiptRetentionDays?: number;
  strandedDispatchSeconds?: number;
}

export interface ControlPlaneMaintenanceResult {
  recoveredOutboxRows: number;
  requeuedStrandedDispatches: number;
  recoveredDraftStages: number;
  terminalDraftStages: number;
  recoveredQueueReceipts: number;
  purgedQueueReceipts: number;
  purgedOutboxRows: number;
}

export class SpecFactoryControlPlaneMaintenance {
  constructor(
    private readonly pool: MaintenancePool = getDatabase().getPool(),
  ) {}

  async run(
    options: ControlPlaneMaintenanceOptions = {},
  ): Promise<ControlPlaneMaintenanceResult> {
    const now = options.now ?? new Date();
    const limit = boundedPositive(options.limit, 500, 5_000);
    const outboxBefore = new Date(
      now.getTime() -
        boundedPositive(options.outboxRetentionDays, 14, 365) * 86_400_000,
    );
    const receiptBefore = new Date(
      now.getTime() -
        boundedPositive(options.receiptRetentionDays, 7, 365) * 86_400_000,
    );
    const strandedBefore = new Date(
      now.getTime() -
        boundedPositive(options.strandedDispatchSeconds, 300, 86_400) * 1000,
    );
    const [outboxRecovery] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_outbox
       SET status = 'pending', lease_owner = NULL, lease_until = NULL,
           available_at = CURRENT_TIMESTAMP(3),
           last_error = 'publishing_lease_expired'
       WHERE status = 'publishing'
         AND lease_until < CURRENT_TIMESTAMP(3)
       LIMIT ?`,
      [limit],
    );
    const [strandedDispatches] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_outbox outbox
       JOIN (
         SELECT bounded.id
         FROM (
           SELECT candidate.id
           FROM spec_factory_outbox candidate
           WHERE candidate.status = 'published'
             AND candidate.updated_at < ?
             AND EXISTS (
               SELECT 1
               FROM spec_factory_queue_receipts receipt
               WHERE receipt.outbox_id = candidate.id
                 AND receipt.status = 'completed'
             )
             AND (
               (candidate.aggregate_type = 'turn' AND EXISTS (
                 SELECT 1 FROM compose_turn_jobs turn_job
                 WHERE turn_job.id = CAST(candidate.aggregate_id AS UNSIGNED)
                   AND turn_job.status = 'queued'
               ))
               OR (candidate.aggregate_type = 'agent_task' AND EXISTS (
                 SELECT 1 FROM compose_agent_tasks agent_task
                 WHERE agent_task.id = CAST(candidate.aggregate_id AS UNSIGNED)
                   AND agent_task.status = 'queued'
               ))
               OR (candidate.aggregate_type = 'source_conversion' AND EXISTS (
                 SELECT 1 FROM compose_session_sources source
                 WHERE source.id = CAST(candidate.aggregate_id AS UNSIGNED)
                   AND source.conversion_status = 'pending'
                   AND source.deleted_at IS NULL
               ))
               OR (candidate.aggregate_type = 'draft_workflow' AND EXISTS (
                 SELECT 1
                 FROM spec_factory_draft_stage_runs stage
                 WHERE stage.workflow_id = CAST(candidate.aggregate_id AS UNSIGNED)
                   AND stage.status = 'queued'
               ))
             )
           ORDER BY candidate.updated_at ASC, candidate.id ASC
           LIMIT ?
         ) bounded
       ) candidates ON candidates.id = outbox.id
       SET outbox.status = 'pending',
           outbox.available_at = CURRENT_TIMESTAMP(3),
           outbox.lease_owner = NULL,
           outbox.lease_until = NULL,
           outbox.last_error = 'authoritative_work_still_queued',
           outbox.updated_at = CURRENT_TIMESTAMP(3)`,
      [strandedBefore, limit],
    );
    const [draftRecovery] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_draft_stage_runs
       SET status = 'queued', active_worker_id = NULL, lease_until = NULL,
           error_code = 'stage_lease_expired',
           error_message = 'Stage lease expired and was recovered',
           retryable = TRUE
       WHERE status = 'running'
         AND lease_until < CURRENT_TIMESTAMP(3)
         AND attempt_count < max_attempts
       LIMIT ?`,
      [limit],
    );
    const [draftTerminal] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_draft_stage_runs stage
       JOIN (
         SELECT bounded.id
         FROM (
           SELECT id
           FROM spec_factory_draft_stage_runs
           WHERE status = 'running'
             AND lease_until < CURRENT_TIMESTAMP(3)
             AND attempt_count >= max_attempts
           ORDER BY lease_until ASC, id ASC
           LIMIT ?
         ) bounded
       ) candidates ON candidates.id = stage.id
       JOIN spec_factory_draft_workflows workflow ON workflow.id = stage.workflow_id
       LEFT JOIN compose_handoffs handoff ON handoff.draft_workflow_id = workflow.id
       SET stage.status = 'failed', stage.active_worker_id = NULL,
           stage.lease_until = NULL,
           stage.error_code = 'stage_attempts_exhausted',
           stage.error_message = 'Stage lease expired after its final attempt',
           stage.retryable = FALSE,
           stage.completed_at = CURRENT_TIMESTAMP(3),
           workflow.status = 'failed',
           workflow.error_code = 'stage_attempts_exhausted',
           workflow.error_message = CONCAT('Stage ', stage.stage_name, ' exhausted attempts'),
           workflow.completed_at = CURRENT_TIMESTAMP(3),
           handoff.status = CASE
             WHEN handoff.status IS NULL OR handoff.status IN ('published','cancelled')
               THEN handoff.status
             ELSE 'failed'
           END,
           handoff.error_code = CASE
             WHEN handoff.status IS NULL OR handoff.status IN ('published','cancelled')
               THEN handoff.error_code
             ELSE 'stage_attempts_exhausted'
           END,
           handoff.error_message = CASE
             WHEN handoff.status IS NULL OR handoff.status IN ('published','cancelled')
               THEN handoff.error_message
             ELSE CONCAT('Draft stage ', stage.stage_name, ' exhausted attempts')
           END
       WHERE stage.status = 'running'`,
      [limit],
    );
    const [receiptRecovery] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_queue_receipts
       SET status = 'failed', lease_token = NULL, lease_until = NULL,
           error_message = 'processing_lease_expired',
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE status = 'processing'
         AND lease_until < CURRENT_TIMESTAMP(3)
       LIMIT ?`,
      [limit],
    );
    const [receiptPurge] = await this.pool.query<mysql.ResultSetHeader>(
      `DELETE FROM spec_factory_queue_receipts
       WHERE status IN ('completed','failed')
         AND updated_at < ?
       LIMIT ?`,
      [receiptBefore, limit],
    );
    const [outboxPurge] = await this.pool.query<mysql.ResultSetHeader>(
      `DELETE FROM spec_factory_outbox
       WHERE status IN ('published','dead')
         AND updated_at < ?
         AND NOT EXISTS (
           SELECT 1
           FROM spec_factory_queue_receipts receipt
           WHERE receipt.outbox_id = spec_factory_outbox.id
         )
       LIMIT ?`,
      [outboxBefore, limit],
    );
    return {
      recoveredOutboxRows: outboxRecovery.affectedRows,
      requeuedStrandedDispatches: strandedDispatches.affectedRows,
      recoveredDraftStages: draftRecovery.affectedRows,
      terminalDraftStages: draftTerminal.affectedRows,
      recoveredQueueReceipts: receiptRecovery.affectedRows,
      purgedQueueReceipts: receiptPurge.affectedRows,
      purgedOutboxRows: outboxPurge.affectedRows,
    };
  }
}

function boundedPositive(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  if (!Number.isFinite(value) || (value ?? 0) <= 0) return fallback;
  return Math.min(maximum, Math.max(1, Math.trunc(value!)));
}
