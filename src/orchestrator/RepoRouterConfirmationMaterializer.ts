import type mysql from "mysql2/promise";
import type { RoutingPlan } from "../oneshot/repo-router/types.js";
import { buildQualifierConfirmationPlan } from "../oneshot/qualifier-confirmation-plan.js";
import { isOneShotRepoEnabled } from "../oneshot/repo-metadata.js";
import { createLogger } from "../utils/logger.js";
import type { CodeRepository, Database } from "./database.js";
import {
  buildRouterConfirmationCandidates,
  type IssueAssignmentService,
} from "./IssueAssignmentService.js";
import type { Storage } from "./storage.js";
import type { TaskDescriptionGenerator } from "./TaskDescriptionGenerator.js";

const logger = createLogger("repo-router-confirmation-materializer");

const MATERIALIZATION_LIMIT = 5;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

type PendingConfirmationRow = mysql.RowDataPacket & {
  id: number;
  ticket_id: string;
  task_management_id: number;
  snapshot_hash: string;
  resolved_repo_id: number;
  resolved_by: string | null;
  resolution_source: string | null;
  related_code: string | null;
  retry_count: number | null;
  updated_at: Date | string;
};

export interface RepoRouterConfirmationMaterializerResult {
  processed: number;
  materialized: number;
  stale: number;
  failed: number;
  skippedBackoff: number;
}

function getRetryBackoffMs(retryCount: number): number {
  if (retryCount <= 0) {
    return 0;
  }
  return Math.min(MAX_BACKOFF_MS, 10_000 * 2 ** Math.min(retryCount - 1, 5));
}

function isBackoffActive(row: PendingConfirmationRow): boolean {
  const retryCount = Number(row.retry_count ?? 0);
  const backoffMs = getRetryBackoffMs(retryCount);
  if (backoffMs <= 0) {
    return false;
  }
  const updatedAt = new Date(row.updated_at).getTime();
  return Number.isFinite(updatedAt) && Date.now() - updatedAt < backoffMs;
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 1000 ? `${message.slice(0, 997)}...` : message;
}

function buildCandidateEvidence(routerPlan: RoutingPlan): unknown[] {
  return routerPlan.candidates.flatMap((candidate) => candidate.evidence);
}

export class RepoRouterConfirmationMaterializer {
  constructor(
    private readonly db: Database,
    private readonly storage: Storage,
    private readonly taskDescriptionGenerator: TaskDescriptionGenerator,
    private readonly issueAssignmentService: IssueAssignmentService,
  ) {}

  async processPendingSelections(
    limit = MATERIALIZATION_LIMIT,
  ): Promise<RepoRouterConfirmationMaterializerResult> {
    const rows = await this.loadPendingSelections(limit);
    const result: RepoRouterConfirmationMaterializerResult = {
      processed: 0,
      materialized: 0,
      stale: 0,
      failed: 0,
      skippedBackoff: 0,
    };

    for (const row of rows) {
      if (isBackoffActive(row)) {
        result.skippedBackoff += 1;
        continue;
      }

      result.processed += 1;
      try {
        const outcome = await this.materializeSelection(row);
        if (outcome === "materialized") {
          result.materialized += 1;
        } else {
          result.stale += 1;
        }
      } catch (error) {
        result.failed += 1;
        await this.recordMaterializationFailure(row, error);
      }
    }

    return result;
  }

  private async loadPendingSelections(
    limit: number,
  ): Promise<PendingConfirmationRow[]> {
    const [rows] = await this.db.getPool().query<PendingConfirmationRow[]>(
      `SELECT rc.id,
              rc.ticket_id,
              rc.task_management_id,
              rc.snapshot_hash,
              rc.resolved_repo_id,
              rc.resolved_by,
              rc.resolution_source,
              tm.related_code,
              tm.retry_count,
              tm.updated_at
         FROM router_confirmations rc
         JOIN task_management tm ON tm.id = rc.task_management_id
        WHERE rc.resolved_repo_id IS NOT NULL
          AND rc.resolved_at IS NULL
          AND rc.timeout_state = 'pending'
          AND tm.status = 'waiting_repo_confirmation'
        ORDER BY rc.updated_at ASC, rc.id ASC
        LIMIT ?`,
      [Math.max(1, Math.min(limit, 25))],
    );
    return rows;
  }

  private async materializeSelection(
    row: PendingConfirmationRow,
  ): Promise<"materialized" | "stale"> {
    const qualifierAgent = await this.db.getAgentByName("QUALIFIER");
    if (!qualifierAgent || !qualifierAgent.is_active) {
      throw new Error(
        "QUALIFIER agent is not active; cannot materialize repo confirmation",
      );
    }

    const issue = await this.issueAssignmentService.fetchJiraIssue(
      row.ticket_id,
      qualifierAgent.jira_token,
    );
    const availableRepos = await this.db.getAllRepositories();
    const routerPlan = buildQualifierConfirmationPlan({
      ticket: issue,
      availableRepos,
      selectedRepoIds: row.resolved_repo_id
        ? [Number(row.resolved_repo_id)]
        : [],
    });
    const routerDecisionId = await this.db.createRouterDecision(routerPlan, {
      taskManagementId: row.task_management_id,
    });

    if (routerPlan.snapshotHash !== row.snapshot_hash) {
      await this.refreshStaleConfirmation(
        row,
        routerPlan,
        availableRepos,
        routerDecisionId,
      );
      return "stale";
    }

    const selectedRepo = availableRepos.find(
      (repo) => repo.id === Number(row.resolved_repo_id),
    );
    if (!selectedRepo || !isOneShotRepoEnabled(selectedRepo)) {
      await this.refreshStaleConfirmation(
        row,
        routerPlan,
        availableRepos,
        routerDecisionId,
        "Selected repo is no longer enabled for OneShot. Please reconfirm the repository.",
      );
      return "stale";
    }

    logger.info(
      {
        jira: row.ticket_id,
        taskManagementId: row.task_management_id,
        repoId: selectedRepo.id,
        repoName: selectedRepo.repo_name,
      },
      "Materializing RepoRouter confirmation selection",
    );

    const taskDescription =
      await this.taskDescriptionGenerator.generateFromTicketKey(
        row.ticket_id,
        qualifierAgent.jira_token,
      );
    const { bucket, key } = await this.storage.uploadTaskDescription(
      row.ticket_id,
      taskDescription,
    );

    const connection = await this.db.getPool().getConnection();
    try {
      await connection.beginTransaction();
      const [taskUpdate] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE task_management
            SET related_code = ?,
                task_s3_bucket = ?,
                task_s3_key = ?,
                status = 'assigned',
                error_message = NULL,
                retry_count = 0,
                updated_at = NOW()
          WHERE id = ?
            AND status = 'waiting_repo_confirmation'`,
        [String(selectedRepo.id), bucket, key, row.task_management_id],
      );
      if (taskUpdate.affectedRows !== 1) {
        throw new Error(
          "Linked task is no longer waiting for repo confirmation",
        );
      }

      await connection.query(
        `UPDATE router_confirmations
            SET router_decision_id = COALESCE(?, router_decision_id),
                resolved_at = NOW(),
                updated_at = NOW()
          WHERE id = ?
            AND resolved_at IS NULL`,
        [routerDecisionId, row.id],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    return "materialized";
  }

  private async refreshStaleConfirmation(
    row: PendingConfirmationRow,
    routerPlan: RoutingPlan,
    availableRepos: CodeRepository[],
    routerDecisionId: number | null,
    message = "Repo selection expired because the ticket or routing inputs changed. Please reconfirm the repository.",
  ): Promise<void> {
    const candidates = buildRouterConfirmationCandidates(
      routerPlan,
      availableRepos,
    );
    await this.db.getPool().query(
      `UPDATE router_confirmations
          SET router_decision_id = ?,
              candidates_json = ?,
              evidence_json = ?,
              snapshot_hash = ?,
              resolved_repo_id = NULL,
              resolved_by = NULL,
              resolution_source = NULL,
              updated_at = NOW()
        WHERE id = ?`,
      [
        routerDecisionId,
        JSON.stringify(candidates),
        JSON.stringify(buildCandidateEvidence(routerPlan)),
        routerPlan.snapshotHash,
        row.id,
      ],
    );
    await this.db.getPool().query(
      `UPDATE task_management
          SET error_message = ?,
              retry_count = 0,
              updated_at = NOW()
        WHERE id = ?
          AND status = 'waiting_repo_confirmation'`,
      [message, row.task_management_id],
    );
    logger.info(
      {
        jira: row.ticket_id,
        taskManagementId: row.task_management_id,
        confirmationId: row.id,
      },
      "RepoRouter confirmation selection was stale; refreshed candidates",
    );
  }

  private async recordMaterializationFailure(
    row: PendingConfirmationRow,
    error: unknown,
  ): Promise<void> {
    const message = errorMessage(error);
    await this.db.getPool().query(
      `UPDATE task_management
          SET error_message = ?,
              retry_count = retry_count + 1,
              updated_at = NOW()
        WHERE id = ?
          AND status = 'waiting_repo_confirmation'`,
      [message, row.task_management_id],
    );
    logger.warn(
      {
        jira: row.ticket_id,
        taskManagementId: row.task_management_id,
        confirmationId: row.id,
        error: message,
      },
      "Failed to materialize RepoRouter confirmation selection; task remains waiting",
    );
  }
}
