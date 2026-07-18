import type mysql from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'
import { parseJsonValue, type JsonObjectRowValue } from './utils.js'
import type {
  ArtifactStage,
  OneShotArtifact,
  UpsertOneShotArtifactInput,
} from '../types.js'

type OneShotArtifactRow = mysql.RowDataPacket & {
  id: number
  oneshot_run_id: number
  stage: ArtifactStage
  version: number
  status: string
  s3_bucket: string
  s3_key: string
  provider: string | null
  model: string | null
  metadata_json: JsonObjectRowValue
  started_at: Date | string | null
  completed_at: Date | string | null
  created_at: Date | string
}

function toOptionalDate(value: Date | string | null): Date | null {
  if (!value) {
    return null
  }
  return value instanceof Date ? value : new Date(value)
}

function mapArtifact(row: OneShotArtifactRow): OneShotArtifact {
  return {
    id: row.id,
    oneshot_run_id: row.oneshot_run_id,
    stage: row.stage,
    version: row.version,
    status: row.status,
    s3_bucket: row.s3_bucket,
    s3_key: row.s3_key,
    provider: row.provider,
    model: row.model,
    metadata_json: parseJsonValue(row.metadata_json),
    started_at: toOptionalDate(row.started_at),
    completed_at: toOptionalDate(row.completed_at),
    created_at: toOptionalDate(row.created_at)!,
  }
}

export class OneShotArtifactsDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  async upsertArtifact(data: UpsertOneShotArtifactInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO oneshot_artifacts (
         oneshot_run_id,
         stage,
         version,
         status,
         s3_bucket,
         s3_key,
         provider,
         model,
         metadata_json,
         started_at,
         completed_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         status = VALUES(status),
         s3_bucket = VALUES(s3_bucket),
         s3_key = VALUES(s3_key),
         provider = VALUES(provider),
         model = VALUES(model),
         metadata_json = VALUES(metadata_json),
         started_at = VALUES(started_at),
         completed_at = VALUES(completed_at)`,
      [
        data.oneshot_run_id,
        data.stage,
        data.version,
        data.status,
        data.s3_bucket,
        data.s3_key,
        data.provider ?? null,
        data.model ?? null,
        data.metadata_json ? JSON.stringify(data.metadata_json) : null,
        data.started_at ?? null,
        data.completed_at ?? null,
      ],
    )
  }

  async getArtifact(
    runId: number,
    stage: ArtifactStage,
    version: number,
  ): Promise<OneShotArtifact | null> {
    const [rows] = await this.pool.query<OneShotArtifactRow[]>(
      `SELECT * FROM oneshot_artifacts
       WHERE oneshot_run_id = ? AND stage = ? AND version = ?
       LIMIT 1`,
      [runId, stage, version],
    )

    return rows.length > 0 ? mapArtifact(rows[0]) : null
  }

  async getLatestArtifact(
    runId: number,
    stage: ArtifactStage,
  ): Promise<OneShotArtifact | null> {
    const [rows] = await this.pool.query<OneShotArtifactRow[]>(
      `SELECT * FROM oneshot_artifacts
       WHERE oneshot_run_id = ? AND stage = ?
       ORDER BY version DESC
       LIMIT 1`,
      [runId, stage],
    )

    return rows.length > 0 ? mapArtifact(rows[0]) : null
  }

  async getArtifactsForRun(runId: number): Promise<OneShotArtifact[]> {
    const [rows] = await this.pool.query<OneShotArtifactRow[]>(
      `SELECT * FROM oneshot_artifacts
       WHERE oneshot_run_id = ?
       ORDER BY created_at ASC`,
      [runId],
    )

    return rows.map(mapArtifact)
  }

  async mergeArtifactMetadata(
    runId: number,
    stage: ArtifactStage,
    version: number,
    metadata: Record<string, unknown>,
  ): Promise<boolean> {
    const existing = await this.getArtifact(runId, stage, version)
    if (!existing) {
      return false
    }

    const currentMetadata =
      existing.metadata_json &&
      typeof existing.metadata_json === 'object' &&
      !Array.isArray(existing.metadata_json)
        ? existing.metadata_json
        : {}

    await this.pool.query(
      `UPDATE oneshot_artifacts
       SET metadata_json = ?
       WHERE oneshot_run_id = ?
         AND stage = ?
         AND version = ?`,
      [
        JSON.stringify({
          ...currentMetadata,
          ...metadata,
        }),
        runId,
        stage,
        version,
      ],
    )

    return true
  }
}
