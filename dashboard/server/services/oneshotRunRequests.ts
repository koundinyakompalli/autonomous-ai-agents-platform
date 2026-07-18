import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type {
  OneShotRunRequestDetail,
  OneShotRunRequestSummary,
  OneShotRunRequestStatus,
} from "../types/oneshot.js";
import type { OperatorIdentity } from "../types/oneshotDeployments.js";
import {
  assertValidJiraKey,
  normalizeJiraKey,
  OneShotRunRequestError,
} from "./oneshotRunRequestSupport.js";

const RUN_REQUEST_TABLE_NAME = "oneshot_dashboard_run_requests";
const QUALIFIER_AGENT_NAME = "QUALIFIER";

type RunRequestRow = mysql.RowDataPacket & {
  id: number;
  jira_key: string;
  requested_by: string;
  requested_by_display: string;
  status: OneShotRunRequestStatus;
  error_message: string | null;
  task_management_id: number | null;
  created_at: Date | string;
  updated_at: Date | string;
  started_at: Date | string | null;
  finished_at: Date | string | null;
};

type RunLookupRow = mysql.RowDataPacket & {
  id: number;
};

let runRequestTableExistsCache: boolean | null = null;

function toIsoString(value: Date | string | null): string | null {
  if (!value) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function mapRunRequestSummary(row: RunRequestRow): OneShotRunRequestSummary {
  return {
    id: row.id,
    jiraKey: row.jira_key,
    status: row.status,
    submittedAt: toIsoString(row.created_at)!,
  };
}

async function queryRunRequestTableExists(
  forceRefresh = false,
): Promise<boolean> {
  if (!forceRefresh && runRequestTableExistsCache === true) {
    return true;
  }

  const [rows] = await getPool().query<Array<mysql.RowDataPacket & { table_name: string }>>(
    `SELECT TABLE_NAME AS table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [RUN_REQUEST_TABLE_NAME],
  );

  const exists = rows.length > 0;
  runRequestTableExistsCache = exists ? true : null;
  return exists;
}

async function ensureRunRequestTableExists(): Promise<void> {
  const exists = await queryRunRequestTableExists();
  if (!exists) {
    throw new OneShotRunRequestError(
      "OneShot dashboard run requests are not configured in this environment",
      503,
    );
  }
}

async function findRunRequestRowById(
  requestId: number,
): Promise<RunRequestRow | null> {
  const [rows] = await getPool().query<RunRequestRow[]>(
    `SELECT *
     FROM oneshot_dashboard_run_requests
     WHERE id = ?
     LIMIT 1`,
    [requestId],
  );

  return rows[0] ?? null;
}

async function findActiveRunRequestByJiraKey(
  jiraKey: string,
): Promise<RunRequestRow | null> {
  const [rows] = await getPool().query<RunRequestRow[]>(
    `SELECT *
     FROM oneshot_dashboard_run_requests
     WHERE jira_key = ?
       AND status IN ('queued', 'processing')
     ORDER BY created_at DESC
     LIMIT 1`,
    [jiraKey],
  );

  return rows[0] ?? null;
}

async function resolveDashboardId(
  taskManagementId: number | null,
): Promise<string | null> {
  if (!taskManagementId) {
    return null;
  }

  const [rows] = await getPool().query<RunLookupRow[]>(
    `SELECT id
     FROM oneshot_runs
     WHERE source_task_management_id = ?
     ORDER BY id DESC
     LIMIT 1`,
    [taskManagementId],
  );

  const runId = rows[0]?.id ?? null;
  return runId ? `run-${runId}` : `qualifier-task-${taskManagementId}`;
}

export async function isOneShotRunRequestSupported(): Promise<boolean> {
  return queryRunRequestTableExists();
}

export async function isQualifierAgentAvailable(): Promise<boolean> {
  const [rows] = await getPool().query<RunLookupRow[]>(
    `SELECT id
     FROM agents
     WHERE name = ?
       AND is_active = TRUE
     LIMIT 1`,
    [QUALIFIER_AGENT_NAME],
  );

  return rows.length > 0;
}

export async function hasExistingOneShotRunForJiraKey(
  jiraKey: string,
): Promise<boolean> {
  const normalized = normalizeJiraKey(jiraKey);
  const [rows] = await getPool().query<RunLookupRow[]>(
    `SELECT id
     FROM oneshot_runs
     WHERE jira_key = ?
     LIMIT 1`,
    [normalized],
  );

  return rows.length > 0;
}

export async function createOneShotRunRequest(input: {
  jiraKey: string;
  operator: OperatorIdentity;
}): Promise<OneShotRunRequestSummary> {
  await ensureRunRequestTableExists();

  const jiraKey = assertValidJiraKey(input.jiraKey);
  if (!(await isQualifierAgentAvailable())) {
    throw new OneShotRunRequestError(
      "QUALIFIER is not available for dashboard-submitted runs",
      503,
    );
  }

  if (await hasExistingOneShotRunForJiraKey(jiraKey)) {
    throw new OneShotRunRequestError(
      `A OneShot run already exists for ${jiraKey}; dashboard new-run only supports fresh submissions.`,
      409,
    );
  }

  const existingRequest = await findActiveRunRequestByJiraKey(jiraKey);
  if (existingRequest) {
    throw new OneShotRunRequestError(
      `A dashboard run request is already in progress for ${jiraKey}.`,
      409,
    );
  }

  try {
    const [result] = await getPool().query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_dashboard_run_requests
       (jira_key, requested_by, requested_by_display, status)
       VALUES (?, ?, ?, 'queued')`,
      [jiraKey, input.operator.id, input.operator.display],
    );

    const row = await findRunRequestRowById(result.insertId);
    if (!row) {
      throw new OneShotRunRequestError(
        "Failed to load OneShot run request after creation",
        500,
      );
    }

    return mapRunRequestSummary(row);
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as Error & { code?: string }).code === "ER_DUP_ENTRY"
    ) {
      throw new OneShotRunRequestError(
        `A dashboard run request is already in progress for ${jiraKey}.`,
        409,
      );
    }
    throw error;
  }
}

export async function getOneShotRunRequestById(
  requestId: number,
): Promise<OneShotRunRequestDetail | null> {
  await ensureRunRequestTableExists();

  const row = await findRunRequestRowById(requestId);
  if (!row) {
    return null;
  }

  return {
    ...mapRunRequestSummary(row),
    error: row.error_message,
    taskManagementId: row.task_management_id,
    dashboardId: await resolveDashboardId(row.task_management_id),
    startedAt: toIsoString(row.started_at),
    finishedAt: toIsoString(row.finished_at),
  };
}

export {
  OneShotRunRequestError,
} from "./oneshotRunRequestSupport.js";
