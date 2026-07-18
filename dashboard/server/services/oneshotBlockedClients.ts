import type mysql from "mysql2/promise";
import { getPool } from "../db.js";
import type { OperatorIdentity } from "../types/oneshotDeployments.js";
import {
  isPolicyStoreUnavailableError,
  normalizeClientDisplayName,
  normalizeClientKey,
} from "../../../src/oneshot/client-eligibility.js";

export type BlockedClientAuditAction =
  | "created"
  | "updated"
  | "deactivated"
  | "reactivated";

export interface BlockedClientRecord {
  clientKey: string;
  displayName: string;
  reason: string | null;
  isActive: boolean;
  createdBy: string;
  createdByDisplay: string;
  updatedBy: string;
  updatedByDisplay: string;
  createdAt: string;
  updatedAt: string;
}

export interface BlockedClientMutationResult {
  action: BlockedClientAuditAction;
  client: BlockedClientRecord;
}

export class OneShotBlockedClientPolicyError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
    readonly code: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "OneShotBlockedClientPolicyError";
  }
}

type PoolLike = Pick<mysql.Pool, "query" | "getConnection">;
type ExecutorLike = Pick<mysql.Pool | mysql.PoolConnection, "query">;

type BlockedClientRow = mysql.RowDataPacket & {
  client_key: string;
  display_name: string;
  reason: string | null;
  is_active: number | boolean;
  created_by: string;
  created_by_display: string;
  updated_by: string;
  updated_by_display: string;
  created_at: Date | string;
  updated_at: Date | string;
};

function normalizeReason(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value.trim().replace(/\s+/g, " ") || null;
}

function formatTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function mapRow(row: BlockedClientRow): BlockedClientRecord {
  return {
    clientKey: row.client_key,
    displayName: row.display_name,
    reason: row.reason ?? null,
    isActive: Boolean(row.is_active),
    createdBy: row.created_by,
    createdByDisplay: row.created_by_display,
    updatedBy: row.updated_by,
    updatedByDisplay: row.updated_by_display,
    createdAt: formatTimestamp(row.created_at),
    updatedAt: formatTimestamp(row.updated_at),
  };
}

function policyStoreUnavailableError(error: unknown): OneShotBlockedClientPolicyError {
  void error;
  return new OneShotBlockedClientPolicyError(
    "Blocked-client policy store is unavailable",
    503,
    "policy_store_unavailable",
  );
}

function rethrowPolicyError(error: unknown): never {
  if (error instanceof OneShotBlockedClientPolicyError) {
    throw error;
  }
  if (isPolicyStoreUnavailableError(error)) {
    throw policyStoreUnavailableError(error);
  }
  throw error;
}

function assertClientKey(value: unknown): string {
  const clientKey = normalizeClientKey(value);
  if (!clientKey) {
    throw new OneShotBlockedClientPolicyError(
      "clientKey must be a non-empty string",
      400,
      "invalid_client_key",
    );
  }
  return clientKey;
}

function assertDisplayName(value: unknown): {
  displayName: string;
  clientKey: string;
} {
  const displayName = normalizeClientDisplayName(value);
  const clientKey = normalizeClientKey(displayName);
  if (!displayName || !clientKey) {
    throw new OneShotBlockedClientPolicyError(
      "displayName must be a non-empty string",
      400,
      "invalid_display_name",
    );
  }
  return { displayName, clientKey };
}

function assertReason(value: unknown): string {
  const reason = normalizeReason(value);
  if (!reason) {
    throw new OneShotBlockedClientPolicyError(
      "reason must be a non-empty string",
      400,
      "invalid_reason",
    );
  }
  return reason;
}

async function selectBlockedClient(
  executor: ExecutorLike,
  clientKey: string,
): Promise<BlockedClientRecord | null> {
  const [rows] = await executor.query<BlockedClientRow[]>(
    `SELECT client_key, display_name, reason, is_active,
            created_by, created_by_display, updated_by, updated_by_display,
            created_at, updated_at
       FROM oneshot_blocked_clients
      WHERE client_key = ?
      LIMIT 1`,
    [clientKey],
  );
  return rows[0] ? mapRow(rows[0]) : null;
}

async function insertAuditEvent(
  executor: ExecutorLike,
  input: {
    action: BlockedClientAuditAction;
    client: BlockedClientRecord;
    oldSnapshot: BlockedClientRecord | null;
    operator: OperatorIdentity;
    reason: string | null;
  },
): Promise<void> {
  await executor.query(
    `INSERT INTO oneshot_blocked_client_audit_events (
       client_key, display_name, action, reason,
       operator_id, operator_display, old_snapshot_json, new_snapshot_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.client.clientKey,
      input.client.displayName,
      input.action,
      input.reason,
      input.operator.id,
      input.operator.display,
      input.oldSnapshot ? JSON.stringify(input.oldSnapshot) : null,
      JSON.stringify(input.client),
    ],
  );
}

async function withConnection<T>(
  pool: PoolLike,
  operation: (connection: mysql.PoolConnection) => Promise<T>,
): Promise<T> {
  let connection: mysql.PoolConnection | null = null;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const result = await operation(connection);
    await connection.commit();
    return result;
  } catch (error) {
    if (connection) {
      await connection.rollback().catch(() => undefined);
    }
    return rethrowPolicyError(error);
  } finally {
    connection?.release();
  }
}

export async function listBlockedClients(
  input: { includeInactive?: boolean },
  pool: Pick<mysql.Pool, "query"> = getPool(),
): Promise<BlockedClientRecord[]> {
  try {
    const whereClause = input.includeInactive ? "" : "WHERE is_active = TRUE";
    const [rows] = await pool.query<BlockedClientRow[]>(
      `SELECT client_key, display_name, reason, is_active,
              created_by, created_by_display, updated_by, updated_by_display,
              created_at, updated_at
         FROM oneshot_blocked_clients
         ${whereClause}
        ORDER BY display_name ASC, client_key ASC`,
    );
    return rows.map(mapRow);
  } catch (error) {
    rethrowPolicyError(error);
  }
}

export async function upsertBlockedClient(
  input: {
    displayName: string;
    reason: string;
    operator: OperatorIdentity;
  },
  pool: PoolLike = getPool(),
): Promise<BlockedClientMutationResult> {
  const { displayName, clientKey } = assertDisplayName(input.displayName);
  const reason = assertReason(input.reason);

  return withConnection(pool, async (connection) => {
    const existing = await selectBlockedClient(connection, clientKey);
    const action: BlockedClientAuditAction = existing
      ? existing.isActive
        ? "updated"
        : "reactivated"
      : "created";

    await connection.query(
      `INSERT INTO oneshot_blocked_clients (
         client_key, display_name, reason, is_active,
         created_by, created_by_display, updated_by, updated_by_display
       ) VALUES (?, ?, ?, TRUE, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = VALUES(display_name),
         reason = VALUES(reason),
         is_active = TRUE,
         updated_by = VALUES(updated_by),
         updated_by_display = VALUES(updated_by_display)`,
      [
        clientKey,
        displayName,
        reason,
        input.operator.id,
        input.operator.display,
        input.operator.id,
        input.operator.display,
      ],
    );

    const client = await selectBlockedClient(connection, clientKey);
    if (!client) {
      throw new OneShotBlockedClientPolicyError(
        "Blocked client was not persisted",
        500,
        "blocked_client_persist_failed",
      );
    }

    await insertAuditEvent(connection, {
      action,
      client,
      oldSnapshot: existing,
      operator: input.operator,
      reason,
    });

    return { action, client };
  });
}

export async function deactivateBlockedClient(
  input: {
    clientKey: string;
    reason: string;
    operator: OperatorIdentity;
  },
  pool: PoolLike = getPool(),
): Promise<BlockedClientMutationResult> {
  const clientKey = assertClientKey(input.clientKey);
  const reason = assertReason(input.reason);

  return withConnection(pool, async (connection) => {
    const existing = await selectBlockedClient(connection, clientKey);
    if (!existing) {
      throw new OneShotBlockedClientPolicyError(
        "Blocked client was not found",
        404,
        "blocked_client_not_found",
        { clientKey },
      );
    }

    await connection.query(
      `UPDATE oneshot_blocked_clients
          SET is_active = FALSE,
              reason = ?,
              updated_by = ?,
              updated_by_display = ?
        WHERE client_key = ?`,
      [reason, input.operator.id, input.operator.display, clientKey],
    );

    const client = await selectBlockedClient(connection, clientKey);
    if (!client) {
      throw new OneShotBlockedClientPolicyError(
        "Blocked client was not found after deactivation",
        500,
        "blocked_client_persist_failed",
      );
    }

    await insertAuditEvent(connection, {
      action: "deactivated",
      client,
      oldSnapshot: existing,
      operator: input.operator,
      reason,
    });

    return { action: "deactivated", client };
  });
}

export async function reactivateBlockedClient(
  input: {
    clientKey: string;
    reason: string;
    operator: OperatorIdentity;
  },
  pool: PoolLike = getPool(),
): Promise<BlockedClientMutationResult> {
  const clientKey = assertClientKey(input.clientKey);
  const reason = assertReason(input.reason);

  return withConnection(pool, async (connection) => {
    const existing = await selectBlockedClient(connection, clientKey);
    if (!existing) {
      throw new OneShotBlockedClientPolicyError(
        "Blocked client was not found",
        404,
        "blocked_client_not_found",
        { clientKey },
      );
    }

    await connection.query(
      `UPDATE oneshot_blocked_clients
          SET is_active = TRUE,
              reason = ?,
              updated_by = ?,
              updated_by_display = ?
        WHERE client_key = ?`,
      [reason, input.operator.id, input.operator.display, clientKey],
    );

    const client = await selectBlockedClient(connection, clientKey);
    if (!client) {
      throw new OneShotBlockedClientPolicyError(
        "Blocked client was not found after reactivation",
        500,
        "blocked_client_persist_failed",
      );
    }

    await insertAuditEvent(connection, {
      action: "reactivated",
      client,
      oldSnapshot: existing,
      operator: input.operator,
      reason,
    });

    return { action: "reactivated", client };
  });
}
