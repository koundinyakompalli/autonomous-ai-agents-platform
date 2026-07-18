import type mysql from 'mysql2/promise'
import type { PoolConnection } from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'
import {
  leaseAcquireRetryCounter,
  leaseLostCounter,
  leaseReclaimCounter,
} from '../telemetry/metrics.js'

export interface OneShotWorkspaceLease {
  scope: string
  fencingToken: number
  ownerTaskArn: string
  ownerStage: string
}

export interface AcquireWorkspaceLeaseInput {
  scope: string
  ownerTaskArn: string
  ownerStage: string
  ttlSeconds: number
  metadata?: Record<string, unknown> | null
}

function hasGetConnection(
  executor: OneShotQueryExecutor,
): executor is mysql.Pool {
  return typeof (executor as mysql.Pool).getConnection === 'function'
}

async function withLeaseConnection<T>(
  executor: OneShotQueryExecutor,
  fn: (connection: PoolConnection | OneShotQueryExecutor) => Promise<T>,
): Promise<T> {
  if (!hasGetConnection(executor)) {
    return fn(executor)
  }
  const connection = await executor.getConnection()
  try {
    return await fn(connection)
  } finally {
    connection.release()
  }
}

export class OneShotWorkspaceLeasesDB {
  constructor(private readonly executor: OneShotQueryExecutor) {}

  async acquireLease(
    input: AcquireWorkspaceLeaseInput,
  ): Promise<OneShotWorkspaceLease | null> {
    return withLeaseConnection(this.executor, async (connection) => {
      await connection.query(
        `INSERT IGNORE INTO oneshot_workspace_leases
           (scope, fencing_token, metadata_json, created_at, updated_at)
         VALUES (?, 0, NULL, NOW(6), NOW(6))`,
        [input.scope],
      )

      const [currentRows] = await connection.query<
        Array<mysql.RowDataPacket & { owner_task_arn: string | null; expired: number }>
      >(
        `SELECT owner_task_arn, expires_at < NOW(6) AS expired
         FROM oneshot_workspace_leases
         WHERE scope = ?`,
        [input.scope],
      )
      const reclaiming = Boolean(
        currentRows[0]?.owner_task_arn && Number(currentRows[0]?.expired ?? 0) === 1,
      )

      const [result] = await connection.query<mysql.ResultSetHeader>(
        `UPDATE oneshot_workspace_leases
         SET fencing_token = LAST_INSERT_ID(fencing_token + 1),
             owner_task_arn = ?,
             owner_stage = ?,
             heartbeat_at = NOW(6),
             expires_at = DATE_ADD(NOW(6), INTERVAL ? SECOND),
             metadata_json = ?,
             updated_at = NOW(6)
         WHERE scope = ?
           AND (owner_task_arn IS NULL OR expires_at < NOW(6))`,
        [
          input.ownerTaskArn,
          input.ownerStage,
          input.ttlSeconds,
          input.metadata ? JSON.stringify(input.metadata) : null,
          input.scope,
        ],
      )

      if (result.affectedRows !== 1) {
        leaseAcquireRetryCounter.add(1, {
          scope: input.scope,
          owner_stage: input.ownerStage,
        })
        return null
      }

      const [tokenRows] = await connection.query<
        Array<mysql.RowDataPacket & { token: number }>
      >('SELECT LAST_INSERT_ID() AS token')
      const fencingToken = Number(tokenRows[0]?.token)
      if (!Number.isFinite(fencingToken) || fencingToken <= 0) {
        throw new Error(`Unable to resolve fencing token for lease ${input.scope}`)
      }

      if (reclaiming) {
        leaseReclaimCounter.add(1, {
          scope: input.scope,
          owner_stage: input.ownerStage,
          reason: 'expired',
        })
      }

      return {
        scope: input.scope,
        fencingToken,
        ownerTaskArn: input.ownerTaskArn,
        ownerStage: input.ownerStage,
      }
    })
  }

  async heartbeatLease(
    scope: string,
    fencingToken: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    const [result] = await this.executor.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_workspace_leases
       SET heartbeat_at = NOW(6),
           expires_at = DATE_ADD(NOW(6), INTERVAL ? SECOND),
           updated_at = NOW(6)
       WHERE scope = ?
         AND fencing_token = ?
         AND expires_at > NOW(6)`,
      [ttlSeconds, scope, fencingToken],
    )
    return result.affectedRows === 1
  }

  async verifyLease(scope: string, fencingToken: number): Promise<boolean> {
    const [rows] = await this.executor.query<mysql.RowDataPacket[]>(
      `SELECT 1
       FROM oneshot_workspace_leases
       WHERE scope = ?
         AND fencing_token = ?
         AND expires_at > NOW(6)
       LIMIT 1`,
      [scope, fencingToken],
    )
    return rows.length === 1
  }

  async releaseLease(scope: string, fencingToken: number): Promise<boolean> {
    const [result] = await this.executor.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_workspace_leases
       SET owner_task_arn = NULL,
           owner_stage = NULL,
           heartbeat_at = NULL,
           expires_at = NULL,
           metadata_json = NULL,
           updated_at = NOW(6)
       WHERE scope = ?
         AND fencing_token = ?`,
      [scope, fencingToken],
    )
    return result.affectedRows === 1
  }

  async recordLeaseLost(
    scope: string,
    stage: string,
    reason: string,
  ): Promise<void> {
    leaseLostCounter.add(1, { scope, stage, reason })
  }
}
