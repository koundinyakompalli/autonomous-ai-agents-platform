import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type {
  OneShotAnalyticsRange,
  OneShotSelfFixCandidate,
  OneShotSelfFixCandidateStatus,
  OneShotStatisticsResponse,
} from "../types/oneshot.js";

const SELF_FIX_TICKET_TABLE_NAME = "oneshot_self_fix_tickets";

type SelfFixTicketRow = mysql.RowDataPacket & {
  id: number;
  candidate_key: string;
  range_key: OneShotAnalyticsRange;
  snapshot_fingerprint: string;
  jira_key: string;
  jira_url: string | null;
  run_request_id: number | null;
  status: OneShotSelfFixCandidateStatus;
  candidate_metadata: unknown;
  last_error: string | null;
};

let selfFixTicketTableExistsCache: boolean | null = null;

async function querySelfFixTicketTableExists(): Promise<boolean> {
  if (selfFixTicketTableExistsCache === true) return true;

  const [rows] = await getPool().query<
    Array<mysql.RowDataPacket & { table_name: string }>
  >(
    `SELECT TABLE_NAME AS table_name
     FROM information_schema.tables
     WHERE table_schema = DATABASE()
       AND table_name = ?`,
    [SELF_FIX_TICKET_TABLE_NAME],
  );

  const exists = rows.length > 0;
  selfFixTicketTableExistsCache = exists ? true : null;
  return exists;
}

export class OneShotSelfFixTicketStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
  ) {
    super(message);
    this.name = "OneShotSelfFixTicketStoreError";
  }
}

export async function ensureSelfFixTicketTableExists(): Promise<void> {
  const exists = await querySelfFixTicketTableExists();
  if (!exists) {
    throw new OneShotSelfFixTicketStoreError(
      "OneShot self-fix tickets are not configured in this environment",
      503,
    );
  }
}

export async function findActiveSelfFixTicketByCandidateKey(
  candidateKey: string,
): Promise<SelfFixTicketRow | null> {
  if (!(await querySelfFixTicketTableExists())) return null;
  const [rows] = await getPool().query<SelfFixTicketRow[]>(
    `SELECT *
     FROM oneshot_self_fix_tickets
     WHERE active_candidate_key = ?
     ORDER BY updated_at DESC, id DESC
     LIMIT 1`,
    [candidateKey],
  );
  return rows[0] ?? null;
}

export async function insertSelfFixTicket(input: {
  candidate: OneShotSelfFixCandidate;
  range: OneShotAnalyticsRange;
  snapshotFingerprint: string;
  jiraKey: string;
  jiraUrl: string | null;
  status: Extract<
    OneShotSelfFixCandidateStatus,
    "ticket_created" | "duplicate" | "run_requested"
  >;
  runRequestId?: number | null;
}): Promise<void> {
  await ensureSelfFixTicketTableExists();
  await getPool().execute(
    `INSERT INTO oneshot_self_fix_tickets
       (candidate_key, range_key, snapshot_fingerprint, jira_key, jira_url,
        run_request_id, status, candidate_metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       jira_key = VALUES(jira_key),
       jira_url = VALUES(jira_url),
       run_request_id = COALESCE(VALUES(run_request_id), run_request_id),
       status = VALUES(status),
       candidate_metadata = VALUES(candidate_metadata),
       last_error = NULL`,
    [
      input.candidate.id,
      input.range,
      input.snapshotFingerprint,
      input.jiraKey,
      input.jiraUrl,
      input.runRequestId ?? null,
      input.status,
      JSON.stringify(input.candidate),
    ],
  );
}

export async function updateSelfFixTicketRunRequest(input: {
  candidateKey: string;
  runRequestId: number;
}): Promise<void> {
  await ensureSelfFixTicketTableExists();
  await getPool().execute(
    `UPDATE oneshot_self_fix_tickets
     SET run_request_id = ?,
         status = 'run_requested',
         last_error = NULL
     WHERE active_candidate_key = ?`,
    [input.runRequestId, input.candidateKey],
  );
}

export async function enrichSelfFixCandidatesWithTicketStatus(
  response: OneShotStatisticsResponse,
): Promise<OneShotStatisticsResponse> {
  if (response.selfFixCandidates.length === 0) return response;
  if (!(await querySelfFixTicketTableExists())) return response;

  const keys = response.selfFixCandidates.map((candidate) => candidate.id);
  const placeholders = keys.map(() => "?").join(", ");
  const [rows] = await getPool().query<SelfFixTicketRow[]>(
    `SELECT *
     FROM oneshot_self_fix_tickets
     WHERE active_candidate_key IN (${placeholders})`,
    keys,
  );
  const rowsByCandidateKey = new Map(
    rows.map((row) => [row.candidate_key, row]),
  );

  return {
    ...response,
    selfFixCandidates: response.selfFixCandidates.map((candidate) => {
      const row = rowsByCandidateKey.get(candidate.id);
      if (!row) return candidate;
      return {
        ...candidate,
        ticketKey: row.jira_key,
        jiraUrl: row.jira_url,
        runRequestId: row.run_request_id ?? undefined,
        status: row.run_request_id ? "run_requested" : row.status,
      };
    }),
  };
}
