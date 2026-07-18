import type mysql from 'mysql2/promise'
import type { PoolConnection } from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'

export interface FinalizeCandidateVersionInput {
  oneshotRunId: number
  candidateVersion: number
  candidateCommitSha: string
  previousCandidateCommitSha?: string | null
  targetFiles?: string[] | null
  metadata?: Record<string, unknown> | null
  leaseScope: string
  fencingToken: number
}

export interface BackfillCurrentCandidateInput {
  oneshotRunId: number
  candidateVersion: number
  candidateCommitSha: string
  targetFiles?: string[] | null
  metadata?: Record<string, unknown> | null
}

export interface AdoptCurrentCandidateInput {
  oneshotRunId: number
  candidateCommitSha: string
  targetFiles?: string[] | null
  metadata?: Record<string, unknown> | null
}

export interface AdoptCurrentCandidateResult {
  adopted: boolean
  candidateVersion: number
  candidateCommitSha: string
  previousCandidateCommitSha: string | null
  targetFiles: string[]
}

export interface OneShotCandidateVersionRecord {
  oneshotRunId: number
  candidateVersion: number
  candidateCommitSha: string
  previousCandidateCommitSha: string | null
  status: string
  supersededByCandidateVersion: number | null
  targetFiles: string[]
  metadata: Record<string, unknown> | null
  finalizedAt: Date | null
}

class RollbackFinalizeCandidate extends Error {
  constructor() {
    super('rollback candidate finalization')
  }
}

function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value
  }
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

export class OneShotCandidateVersionsDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  private mapCandidateRow(
    row: mysql.RowDataPacket | undefined,
  ): OneShotCandidateVersionRecord | null {
    if (!row) {
      return null
    }
    const targetFilesJson = parseJsonColumn(row.target_files_json)
    const metadataJson = parseJsonColumn(row.metadata_json)
    return {
      oneshotRunId: Number(row.oneshot_run_id),
      candidateVersion: Number(row.candidate_version),
      candidateCommitSha: String(row.candidate_commit_sha),
      previousCandidateCommitSha: row.previous_candidate_commit_sha ?? null,
      status: String(row.status),
      supersededByCandidateVersion:
        row.superseded_by_candidate_version == null
          ? null
          : Number(row.superseded_by_candidate_version),
      targetFiles: Array.isArray(targetFilesJson)
        ? targetFilesJson.filter((value) => typeof value === 'string')
        : [],
      metadata:
        metadataJson && typeof metadataJson === 'object'
          ? metadataJson as Record<string, unknown>
          : null,
      finalizedAt: row.finalized_at ? new Date(row.finalized_at) : null,
    }
  }

  async getCurrentCandidate(
    oneshotRunId: number,
  ): Promise<OneShotCandidateVersionRecord | null> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT oneshot_run_id,
              candidate_version,
              candidate_commit_sha,
              previous_candidate_commit_sha,
              status,
              superseded_by_candidate_version,
              target_files_json,
              metadata_json,
              finalized_at
       FROM oneshot_candidate_versions
       WHERE oneshot_run_id = ?
         AND status = 'current'
       ORDER BY candidate_version DESC
       LIMIT 1`,
      [oneshotRunId],
    )
    return this.mapCandidateRow(rows[0])
  }

  async getCandidate(
    oneshotRunId: number,
    candidateVersion: number,
  ): Promise<OneShotCandidateVersionRecord | null> {
    const [rows] = await this.pool.query<mysql.RowDataPacket[]>(
      `SELECT oneshot_run_id,
              candidate_version,
              candidate_commit_sha,
              previous_candidate_commit_sha,
              status,
              superseded_by_candidate_version,
              target_files_json,
              metadata_json,
              finalized_at
       FROM oneshot_candidate_versions
       WHERE oneshot_run_id = ?
         AND candidate_version = ?
       LIMIT 1`,
      [oneshotRunId, candidateVersion],
    )
    return this.mapCandidateRow(rows[0])
  }

  async supersedeCurrentCandidatesForReplan(
    oneshotRunId: number,
  ): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_candidate_versions
       SET status = 'superseded',
           superseded_by_candidate_version = NULL
       WHERE oneshot_run_id = ?
         AND status = 'current'`,
      [oneshotRunId],
    )
    return result.affectedRows
  }

  private async withTransaction<T>(
    fn: (connection: PoolConnection | OneShotQueryExecutor) => Promise<T>,
  ): Promise<T> {
    const poolLike = this.pool as mysql.Pool
    const hasGetConnection = typeof poolLike.getConnection === 'function'
    const connection = hasGetConnection ? await poolLike.getConnection() : this.pool
    const transactional = connection as PoolConnection
    const canTransact =
      hasGetConnection && typeof transactional.beginTransaction === 'function'

    if (!canTransact) {
      return fn(connection)
    }

    try {
      await transactional.beginTransaction()
      const result = await fn(transactional)
      await transactional.commit()
      return result
    } catch (error) {
      await transactional.rollback()
      throw error
    } finally {
      if (hasGetConnection) {
        transactional.release()
      }
    }
  }

  async finalizeCandidate(
    input: FinalizeCandidateVersionInput,
  ): Promise<boolean> {
    try {
      return await this.withTransaction(async (connection) => {
        const [runRows] = await connection.query<mysql.RowDataPacket[]>(
          `SELECT id
           FROM oneshot_runs
           WHERE id = ?
           FOR UPDATE`,
          [input.oneshotRunId],
        )
        if (runRows.length !== 1) {
          return false
        }

        const [leaseRows] = await connection.query<mysql.RowDataPacket[]>(
          `SELECT 1
           FROM oneshot_workspace_leases
           WHERE scope = ?
             AND fencing_token = ?
             AND expires_at > NOW(6)
           LIMIT 1
           FOR UPDATE`,
          [input.leaseScope, input.fencingToken],
        )
        if (leaseRows.length !== 1) {
          return false
        }

        const [currentRows] = await connection.query<
          Array<mysql.RowDataPacket & { candidate_version: number }>
        >(
          `SELECT candidate_version
           FROM oneshot_candidate_versions
           WHERE oneshot_run_id = ?
             AND status = 'current'
           ORDER BY candidate_version DESC
           FOR UPDATE`,
          [input.oneshotRunId],
        )
        const currentVersion = currentRows[0]?.candidate_version
        if (
          Number.isFinite(currentVersion) &&
          Number(currentVersion) > input.candidateVersion
        ) {
          return false
        }
        const olderCurrentCount = currentRows.filter(
          (row) => Number(row.candidate_version) < input.candidateVersion,
        ).length

        const [existingRows] = await connection.query<
          Array<mysql.RowDataPacket & { candidate_commit_sha: string }>
        >(
          `SELECT candidate_commit_sha
           FROM oneshot_candidate_versions
           WHERE oneshot_run_id = ?
             AND candidate_version = ?
           LIMIT 1
           FOR UPDATE`,
          [input.oneshotRunId, input.candidateVersion],
        )
        const existingSha = existingRows[0]?.candidate_commit_sha
        if (existingSha && existingSha !== input.candidateCommitSha) {
          throw new Error(
            `Candidate v${input.candidateVersion} for OneShot run ${input.oneshotRunId} already points to ${existingSha}, refusing to replace it with ${input.candidateCommitSha}`,
          )
        }

        const [result] = await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO oneshot_candidate_versions (
             oneshot_run_id,
             candidate_version,
             candidate_commit_sha,
             previous_candidate_commit_sha,
             status,
             target_files_json,
             metadata_json,
             finalized_at
           )
           SELECT ?, ?, ?, ?, 'current', ?, ?, NOW(6)
           FROM oneshot_workspace_leases
           WHERE scope = ?
             AND fencing_token = ?
             AND expires_at > NOW(6)
           ON DUPLICATE KEY UPDATE
             candidate_commit_sha = candidate_commit_sha,
             previous_candidate_commit_sha = VALUES(previous_candidate_commit_sha),
             status = VALUES(status),
             target_files_json = VALUES(target_files_json),
             metadata_json = VALUES(metadata_json),
             finalized_at = VALUES(finalized_at)`,
          [
            input.oneshotRunId,
            input.candidateVersion,
            input.candidateCommitSha,
            input.previousCandidateCommitSha ?? null,
            input.targetFiles ? JSON.stringify(input.targetFiles) : null,
            input.metadata ? JSON.stringify(input.metadata) : null,
            input.leaseScope,
            input.fencingToken,
          ],
        )

        if (result.affectedRows === 0) {
          return false
        }

        const [supersedeResult] = await connection.query<mysql.ResultSetHeader>(
          `UPDATE oneshot_candidate_versions
           SET status = 'superseded',
               superseded_by_candidate_version = ?
           WHERE oneshot_run_id = ?
             AND candidate_version < ?
             AND status = 'current'
             AND EXISTS (
               SELECT 1
               FROM oneshot_workspace_leases
               WHERE scope = ?
                 AND fencing_token = ?
                 AND expires_at > NOW(6)
             )`,
          [
            input.candidateVersion,
            input.oneshotRunId,
            input.candidateVersion,
            input.leaseScope,
            input.fencingToken,
          ],
        )
        if (olderCurrentCount > 0 && supersedeResult.affectedRows < olderCurrentCount) {
          throw new RollbackFinalizeCandidate()
        }

        const [finalLeaseRows] = await connection.query<mysql.RowDataPacket[]>(
          `SELECT 1
           FROM oneshot_workspace_leases
           WHERE scope = ?
             AND fencing_token = ?
             AND expires_at > NOW(6)
           LIMIT 1
           FOR UPDATE`,
          [input.leaseScope, input.fencingToken],
        )
        if (finalLeaseRows.length !== 1) {
          throw new RollbackFinalizeCandidate()
        }

        return true
      })
    } catch (error) {
      if (error instanceof RollbackFinalizeCandidate) {
        return false
      }
      throw error
    }
  }

  async backfillCurrentCandidate(
    input: BackfillCurrentCandidateInput,
  ): Promise<boolean> {
    return this.withTransaction(async (connection) => {
      const [currentRows] = await connection.query<
        Array<mysql.RowDataPacket & {
          candidate_version: number
          candidate_commit_sha: string
        }>
      >(
        `SELECT candidate_version, candidate_commit_sha
         FROM oneshot_candidate_versions
         WHERE oneshot_run_id = ?
           AND status = 'current'
         ORDER BY candidate_version DESC
         FOR UPDATE`,
        [input.oneshotRunId],
      )
      const current = currentRows[0]
      if (current) {
        return (
          Number(current.candidate_version) === input.candidateVersion &&
          current.candidate_commit_sha === input.candidateCommitSha
        )
      }

      const [existingRows] = await connection.query<
        Array<mysql.RowDataPacket & { candidate_commit_sha: string }>
      >(
        `SELECT candidate_commit_sha
         FROM oneshot_candidate_versions
         WHERE oneshot_run_id = ?
           AND candidate_version = ?
         LIMIT 1
         FOR UPDATE`,
        [input.oneshotRunId, input.candidateVersion],
      )
      const existingSha = existingRows[0]?.candidate_commit_sha
      if (existingSha && existingSha !== input.candidateCommitSha) {
        return false
      }

      await connection.query(
        `INSERT INTO oneshot_candidate_versions (
           oneshot_run_id,
           candidate_version,
           candidate_commit_sha,
           previous_candidate_commit_sha,
           status,
           target_files_json,
           metadata_json,
           finalized_at
         ) VALUES (?, ?, ?, NULL, 'current', ?, ?, NOW(6))
         ON DUPLICATE KEY UPDATE
           candidate_commit_sha = VALUES(candidate_commit_sha),
           status = 'current',
           target_files_json = VALUES(target_files_json),
           metadata_json = VALUES(metadata_json),
           finalized_at = COALESCE(finalized_at, VALUES(finalized_at))`,
        [
          input.oneshotRunId,
          input.candidateVersion,
          input.candidateCommitSha,
          JSON.stringify(input.targetFiles ?? []),
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      )
      return true
    })
  }

  async adoptCurrentCandidate(
    input: AdoptCurrentCandidateInput,
  ): Promise<AdoptCurrentCandidateResult> {
    return this.withTransaction(async (connection) => {
      const [runRows] = await connection.query<
        Array<mysql.RowDataPacket & { current_implementation_version: number | null }>
      >(
        `SELECT current_implementation_version
         FROM oneshot_runs
         WHERE id = ?
         FOR UPDATE`,
        [input.oneshotRunId],
      )
      if (runRows.length !== 1) {
        throw new Error(`OneShot run ${input.oneshotRunId} not found while adopting current candidate`)
      }
      const runCurrentVersion = Number(runRows[0].current_implementation_version ?? 0)

      const [currentRows] = await connection.query<
        Array<mysql.RowDataPacket & {
          candidate_version: number
          candidate_commit_sha: string
          target_files_json: unknown
        }>
      >(
        `SELECT candidate_version, candidate_commit_sha, target_files_json
         FROM oneshot_candidate_versions
         WHERE oneshot_run_id = ?
           AND status = 'current'
         ORDER BY candidate_version DESC
         FOR UPDATE`,
        [input.oneshotRunId],
      )
      const current = currentRows[0] ?? null
      const currentVersion = Number(current?.candidate_version ?? 0)
      const targetFilesJson = current ? parseJsonColumn(current.target_files_json) : null
      const targetFiles = input.targetFiles
        ? input.targetFiles
        : Array.isArray(targetFilesJson)
          ? targetFilesJson.filter((value) => typeof value === 'string')
          : []

      if (current?.candidate_commit_sha === input.candidateCommitSha) {
        return {
          adopted: false,
          candidateVersion: currentVersion,
          candidateCommitSha: input.candidateCommitSha,
          previousCandidateCommitSha: current.candidate_commit_sha,
          targetFiles,
        }
      }

      const candidateVersion = Math.max(runCurrentVersion, currentVersion) + 1
      const previousCandidateCommitSha = current?.candidate_commit_sha ?? null

      await connection.query(
        `UPDATE oneshot_candidate_versions
         SET status = 'superseded',
             superseded_by_candidate_version = ?
         WHERE oneshot_run_id = ?
           AND candidate_version < ?
           AND status = 'current'`,
        [
          candidateVersion,
          input.oneshotRunId,
          candidateVersion,
        ],
      )

      await connection.query(
        `INSERT INTO oneshot_candidate_versions (
           oneshot_run_id,
           candidate_version,
           candidate_commit_sha,
           previous_candidate_commit_sha,
           status,
           target_files_json,
           metadata_json,
           finalized_at
         ) VALUES (?, ?, ?, ?, 'current', ?, ?, NOW(6))
         ON DUPLICATE KEY UPDATE
           candidate_commit_sha = VALUES(candidate_commit_sha),
           previous_candidate_commit_sha = VALUES(previous_candidate_commit_sha),
           status = 'current',
           superseded_by_candidate_version = NULL,
           target_files_json = VALUES(target_files_json),
           metadata_json = VALUES(metadata_json),
           finalized_at = VALUES(finalized_at)`,
        [
          input.oneshotRunId,
          candidateVersion,
          input.candidateCommitSha,
          previousCandidateCommitSha,
          JSON.stringify(targetFiles),
          input.metadata ? JSON.stringify(input.metadata) : null,
        ],
      )

      return {
        adopted: true,
        candidateVersion,
        candidateCommitSha: input.candidateCommitSha,
        previousCandidateCommitSha,
        targetFiles,
      }
    })
  }
}
