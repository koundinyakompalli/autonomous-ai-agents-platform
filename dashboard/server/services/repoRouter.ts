import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type { OperatorIdentity } from "../types/oneshotDeployments.js";

export class RepoRouterDashboardError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "RepoRouterDashboardError";
  }
}

type JsonValue = unknown;

type RouterDecisionRow = mysql.RowDataPacket & {
  id: number;
  ticket_id: string;
  task_management_id: number | null;
  ts: Date | string;
  outcome: string;
  decision_source: string;
  signals_json: JsonValue;
  scores_json: JsonValue;
  top1_repo_id: number | null;
  top1_score: string | number | null;
  top1_repo_name: string | null;
  top2_repo_id: number | null;
  top2_score: string | number | null;
  top2_repo_name: string | null;
  chosen_repo_id: number | null;
  chosen_repo_name: string | null;
  selected_repo_ids_json: JsonValue;
  unsupported_repo_ids_json: JsonValue;
  blocking_reasons_json: JsonValue;
  current_logic_disposition: string | null;
  profile_versions_json: JsonValue;
  weights_version: string | null;
  extractor_schema_version: string | null;
  snapshot_hash: string;
};

type RouterConfirmationRow = mysql.RowDataPacket & {
  id: number;
  ticket_id: string;
  task_management_id: number | null;
  router_decision_id: number | null;
  candidates_json: JsonValue;
  evidence_json: JsonValue;
  jira_comment_id: string | null;
  requested_at: Date | string;
  resolved_at: Date | string | null;
  resolved_by: string | null;
  resolved_repo_id: number | null;
  resolved_repo_name: string | null;
  resolution_source: string | null;
  timeout_state: string;
  snapshot_hash: string;
  signals_json?: JsonValue;
  scores_json?: JsonValue;
};

export interface RepoRouterDecisionSummary {
  id: number;
  ticketId: string;
  taskManagementId: number | null;
  decidedAt: string;
  outcome: string;
  decisionSource: string;
  top1: { repoId: number; repoName: string | null; score: number | null } | null;
  top2: { repoId: number; repoName: string | null; score: number | null } | null;
  chosen: { repoId: number; repoName: string | null } | null;
  selectedRepoIds: number[];
  unsupportedRepoIds: number[];
  blockingReasons: string[];
  scores: unknown[];
  currentLogicDisposition: string | null;
  weightsVersion: string | null;
  extractorSchemaVersion: string | null;
  profileVersions: Record<string, string>;
  snapshotHash: string;
}

export interface RepoRouterConfirmationSummary {
  id: number;
  ticketId: string;
  taskManagementId: number | null;
  routerDecisionId: number | null;
  candidates: Array<{ repoId: number; repoName: string; score?: number; evidence?: unknown[] }>;
  evidence: unknown[];
  jiraCommentId: string | null;
  requestedAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedRepo: { repoId: number; repoName: string | null } | null;
  resolutionSource: string | null;
  timeoutState: string;
  snapshotHash: string;
}

export interface RepoRouterDecisionList {
  decisions: RepoRouterDecisionSummary[];
}

export interface RepoRouterConfirmationList {
  confirmations: RepoRouterConfirmationSummary[];
}

function toIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseJson<T>(value: JsonValue, fallback: T): T {
  if (value === null || value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function parseNumber(value: string | number | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeNumberArray(value: JsonValue): number[] {
  return parseJson<unknown[]>(value, [])
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function mapDecision(row: RouterDecisionRow): RepoRouterDecisionSummary {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    taskManagementId: row.task_management_id,
    decidedAt: toIsoString(row.ts)!,
    outcome: row.outcome,
    decisionSource: row.decision_source,
    top1: row.top1_repo_id
      ? {
          repoId: row.top1_repo_id,
          repoName: row.top1_repo_name,
          score: parseNumber(row.top1_score),
        }
      : null,
    top2: row.top2_repo_id
      ? {
          repoId: row.top2_repo_id,
          repoName: row.top2_repo_name,
          score: parseNumber(row.top2_score),
        }
      : null,
    chosen: row.chosen_repo_id
      ? {
          repoId: row.chosen_repo_id,
          repoName: row.chosen_repo_name,
        }
      : null,
    selectedRepoIds: normalizeNumberArray(row.selected_repo_ids_json),
    unsupportedRepoIds: normalizeNumberArray(row.unsupported_repo_ids_json),
    blockingReasons: parseJson<string[]>(row.blocking_reasons_json, []),
    scores: parseJson<unknown[]>(row.scores_json, []),
    currentLogicDisposition: row.current_logic_disposition,
    weightsVersion: row.weights_version,
    extractorSchemaVersion: row.extractor_schema_version,
    profileVersions: parseJson<Record<string, string>>(row.profile_versions_json, {}),
    snapshotHash: row.snapshot_hash,
  };
}

function normalizeCandidates(value: JsonValue): RepoRouterConfirmationSummary["candidates"] {
  return parseJson<RepoRouterConfirmationSummary["candidates"]>(value, [])
    .filter((candidate) => Number.isInteger(Number(candidate.repoId)));
}

function mapConfirmation(row: RouterConfirmationRow): RepoRouterConfirmationSummary {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    taskManagementId: row.task_management_id,
    routerDecisionId: row.router_decision_id,
    candidates: normalizeCandidates(row.candidates_json),
    evidence: parseJson<unknown[]>(row.evidence_json, []),
    jiraCommentId: row.jira_comment_id,
    requestedAt: toIsoString(row.requested_at)!,
    resolvedAt: toIsoString(row.resolved_at),
    resolvedBy: row.resolved_by,
    resolvedRepo: row.resolved_repo_id
      ? {
          repoId: row.resolved_repo_id,
          repoName: row.resolved_repo_name,
        }
      : null,
    resolutionSource: row.resolution_source,
    timeoutState: row.timeout_state,
    snapshotHash: row.snapshot_hash,
  };
}

function isMissingRouterTable(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "ER_NO_SUCH_TABLE"
  );
}

export async function getRecentRepoRouterDecisions(options: {
  limit?: unknown;
  outcome?: unknown;
} = {}): Promise<RepoRouterDecisionList> {
  const limit = normalizeLimit(options.limit, 50, 200);
  const outcome = typeof options.outcome === "string" && options.outcome.trim()
    ? options.outcome.trim()
    : null;

  try {
    const params: unknown[] = [];
    let where = "";
    if (outcome) {
      where = "WHERE rd.outcome = ?";
      params.push(outcome);
    }
    params.push(limit);

    const [rows] = await getPool().query<RouterDecisionRow[]>(
      `SELECT rd.*,
              top1.repo_name AS top1_repo_name,
              top2.repo_name AS top2_repo_name,
              chosen.repo_name AS chosen_repo_name
       FROM router_decisions rd
       LEFT JOIN code_repositories top1 ON top1.id = rd.top1_repo_id
       LEFT JOIN code_repositories top2 ON top2.id = rd.top2_repo_id
       LEFT JOIN code_repositories chosen ON chosen.id = rd.chosen_repo_id
       ${where}
       ORDER BY rd.ts DESC, rd.id DESC
       LIMIT ?`,
      params,
    );

    return { decisions: rows.map(mapDecision) };
  } catch (error) {
    if (isMissingRouterTable(error)) {
      throw new RepoRouterDashboardError(
        "RepoRouter tables are not configured in this environment",
        503,
      );
    }
    throw error;
  }
}

export async function getPendingRepoRouterConfirmations(options: {
  limit?: unknown;
} = {}): Promise<RepoRouterConfirmationList> {
  const limit = normalizeLimit(options.limit, 50, 200);

  try {
    const [rows] = await getPool().query<RouterConfirmationRow[]>(
      `SELECT rc.*,
              resolved.repo_name AS resolved_repo_name
       FROM router_confirmations rc
       LEFT JOIN code_repositories resolved ON resolved.id = rc.resolved_repo_id
       WHERE rc.resolved_at IS NULL
         AND rc.timeout_state = 'pending'
       ORDER BY rc.requested_at ASC, rc.id ASC
       LIMIT ?`,
      [limit],
    );

    return { confirmations: rows.map(mapConfirmation) };
  } catch (error) {
    if (isMissingRouterTable(error)) {
      throw new RepoRouterDashboardError(
        "RepoRouter tables are not configured in this environment",
        503,
      );
    }
    throw error;
  }
}

export async function resolveRepoRouterConfirmation(input: {
  confirmationId: number;
  repoId: number;
  operator: OperatorIdentity;
}): Promise<RepoRouterConfirmationSummary> {
  if (!Number.isInteger(input.confirmationId) || input.confirmationId <= 0) {
    throw new RepoRouterDashboardError("confirmationId must be a positive integer", 400);
  }
  if (!Number.isInteger(input.repoId) || input.repoId <= 0) {
    throw new RepoRouterDashboardError("repoId must be a positive integer", 400);
  }

  const connection = await getPool().getConnection();
  let transactionOpen = false;
  try {
    await connection.beginTransaction();
    transactionOpen = true;

    const [rows] = await connection.query<RouterConfirmationRow[]>(
      `SELECT rc.*,
              rd.signals_json,
              rd.scores_json,
              resolved.repo_name AS resolved_repo_name
       FROM router_confirmations rc
       LEFT JOIN router_decisions rd ON rd.id = rc.router_decision_id
       LEFT JOIN code_repositories resolved ON resolved.id = rc.resolved_repo_id
       WHERE rc.id = ?
       LIMIT 1
       FOR UPDATE`,
      [input.confirmationId],
    );

    const confirmation = rows[0];
    if (!confirmation) {
      throw new RepoRouterDashboardError("Repo confirmation not found", 404);
    }
    if (confirmation.resolved_at) {
      throw new RepoRouterDashboardError("Repo confirmation is already resolved", 409);
    }
    if (!confirmation.task_management_id) {
      throw new RepoRouterDashboardError(
        "Repo confirmation is not linked to a task_management row",
        409,
      );
    }

    const candidates = normalizeCandidates(confirmation.candidates_json);
    const selectedCandidate = candidates.find(
      (candidate) => Number(candidate.repoId) === input.repoId,
    );
    if (!selectedCandidate) {
      throw new RepoRouterDashboardError(
        "Selected repo must be one of the confirmation candidates",
        400,
      );
    }

    const [repoRows] = await connection.query<Array<mysql.RowDataPacket & { id: number; repo_name: string }>>(
      `SELECT id, repo_name
       FROM code_repositories
       WHERE id = ?
       LIMIT 1`,
      [input.repoId],
    );
    const repo = repoRows[0];
    if (!repo) {
      throw new RepoRouterDashboardError("Selected repo does not exist", 400);
    }

    const [taskUpdate] = await connection.query<mysql.ResultSetHeader>(
      `UPDATE task_management
       SET error_message = NULL,
           retry_count = 0,
           updated_at = NOW()
       WHERE id = ?
         AND status = 'waiting_repo_confirmation'`,
      [confirmation.task_management_id],
    );
    if (taskUpdate.affectedRows !== 1) {
      throw new RepoRouterDashboardError(
        "Linked task is no longer waiting for repo confirmation",
        409,
      );
    }

    await connection.query(
      `UPDATE router_confirmations
       SET resolved_by = ?,
           resolved_repo_id = ?,
           resolution_source = 'dashboard',
           updated_at = NOW()
       WHERE id = ?`,
      [input.operator.display || input.operator.id, input.repoId, input.confirmationId],
    );

    await connection.commit();
    transactionOpen = false;

    return {
      ...mapConfirmation({
        ...confirmation,
        resolved_at: null,
        resolved_by: input.operator.display || input.operator.id,
        resolved_repo_id: input.repoId,
        resolved_repo_name: repo.repo_name,
        resolution_source: "dashboard",
      }),
      candidates,
    };
  } catch (error) {
    if (transactionOpen) {
      await connection.rollback();
    }
    if (isMissingRouterTable(error)) {
      throw new RepoRouterDashboardError(
        "RepoRouter tables are not configured in this environment",
        503,
      );
    }
    throw error;
  } finally {
    connection.release();
  }
}
