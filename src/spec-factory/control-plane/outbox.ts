import type mysql from "mysql2/promise";
import { getDatabase } from "../../orchestrator/database.js";

type Queryable = Pick<mysql.PoolConnection, "query">;
type OutboxPool = Pick<mysql.Pool, "query" | "getConnection">;

export interface AppendOutboxEventInput {
  aggregateType: string;
  aggregateId: string | number;
  eventType: string;
  dedupeKey: string;
  payload: unknown;
  schemaVersion?: number;
  availableAt?: Date;
}

export interface ClaimedOutboxEvent {
  id: number;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  schemaVersion: number;
  dedupeKey: string;
  payload: unknown;
  publishAttempts: number;
  createdAt: string;
}

interface OutboxRow extends mysql.RowDataPacket {
  id: number | string;
  aggregate_type: string;
  aggregate_id: string;
  event_type: string;
  schema_version: number | string;
  dedupe_key: string;
  payload_json: string | unknown;
  publish_attempts: number | string;
  created_at: Date | string;
}

export async function appendSpecFactoryOutboxEvent(
  connection: Queryable,
  input: AppendOutboxEventInput,
): Promise<number> {
  const response = await connection.query<mysql.ResultSetHeader>(
    `INSERT INTO spec_factory_outbox
     (aggregate_type, aggregate_id, event_type, schema_version, dedupe_key,
      payload_json, status, available_at)
     VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), 'pending', ?)
     ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id)`,
    [
      input.aggregateType.slice(0, 64),
      String(input.aggregateId).slice(0, 128),
      input.eventType.slice(0, 128),
      input.schemaVersion ?? 1,
      input.dedupeKey.slice(0, 191),
      JSON.stringify(input.payload ?? null),
      input.availableAt ?? new Date(),
    ],
  );
  const result = Array.isArray(response)
    ? (response[0] as mysql.ResultSetHeader)
    : (response as unknown as mysql.ResultSetHeader | undefined);
  return result?.insertId ?? 0;
}

export class SpecFactoryOutboxRepository {
  constructor(private readonly pool: OutboxPool = getDatabase().getPool()) {}

  async claimBatch(input: {
    workerId: string;
    leaseUntil: Date;
    limit: number;
  }): Promise<ClaimedOutboxEvent[]> {
    const limit = Math.max(1, Math.min(500, Math.trunc(input.limit)));
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<OutboxRow[]>(
        `SELECT id, aggregate_type, aggregate_id, event_type, schema_version,
                dedupe_key, payload_json, publish_attempts, created_at
         FROM spec_factory_outbox
         WHERE status IN ('pending', 'failed', 'publishing')
           AND available_at <= CURRENT_TIMESTAMP(3)
           AND (status <> 'publishing' OR lease_until < CURRENT_TIMESTAMP(3))
         ORDER BY id ASC
         LIMIT ?
         FOR UPDATE SKIP LOCKED`,
        [limit],
      );
      if (rows.length === 0) {
        await connection.commit();
        return [];
      }
      const ids = rows.map((row) => Number(row.id));
      const placeholders = ids.map(() => "?").join(", ");
      await connection.query(
        `UPDATE spec_factory_outbox
         SET status = 'publishing',
             lease_owner = ?,
             lease_until = ?,
             publish_attempts = publish_attempts + 1,
             updated_at = CURRENT_TIMESTAMP(3)
         WHERE id IN (${placeholders})`,
        [input.workerId, input.leaseUntil, ...ids],
      );
      await connection.commit();
      return rows.map((row) => ({
        id: Number(row.id),
        aggregateType: row.aggregate_type,
        aggregateId: row.aggregate_id,
        eventType: row.event_type,
        schemaVersion: Number(row.schema_version),
        dedupeKey: row.dedupe_key,
        payload: parseJson(row.payload_json),
        publishAttempts: Number(row.publish_attempts) + 1,
        createdAt: toIso(row.created_at),
      }));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  async markPublished(input: {
    id: number;
    workerId: string;
  }): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_outbox
       SET status = 'published',
           published_at = CURRENT_TIMESTAMP(3),
           lease_owner = NULL,
           lease_until = NULL,
           last_error = NULL,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'publishing'
         AND lease_owner = ?`,
      [input.id, input.workerId],
    );
    return result.affectedRows === 1;
  }

  async markFailed(input: {
    id: number;
    workerId: string;
    error: string;
    retryAt: Date;
    maxAttempts: number;
  }): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE spec_factory_outbox
       SET status = CASE WHEN publish_attempts >= ? THEN 'dead' ELSE 'failed' END,
           available_at = ?,
           lease_owner = NULL,
           lease_until = NULL,
           last_error = ?,
           updated_at = CURRENT_TIMESTAMP(3)
       WHERE id = ?
         AND status = 'publishing'
         AND lease_owner = ?`,
      [
        Math.max(1, input.maxAttempts),
        input.retryAt,
        input.error.slice(0, 4096),
        input.id,
        input.workerId,
      ],
    );
    return result.affectedRows === 1;
  }

  async getBacklog(): Promise<{
    pending: number;
    publishing: number;
    failed: number;
    dead: number;
    oldestAvailableAt: string | null;
  }> {
    const [rows] = await this.pool.query<
      Array<
        mysql.RowDataPacket & {
          pending: number | string;
          publishing: number | string;
          failed: number | string;
          dead: number | string;
          oldest_available_at: Date | string | null;
        }
      >
    >(
      `SELECT
         SUM(status = 'pending') AS pending,
         SUM(status = 'publishing') AS publishing,
         SUM(status = 'failed') AS failed,
         SUM(status = 'dead') AS dead,
         MIN(CASE WHEN status IN ('pending','failed') THEN available_at END)
           AS oldest_available_at
       FROM spec_factory_outbox`,
    );
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      publishing: Number(row?.publishing ?? 0),
      failed: Number(row?.failed ?? 0),
      dead: Number(row?.dead ?? 0),
      oldestAvailableAt: row?.oldest_available_at
        ? toIso(row.oldest_available_at)
        : null,
    };
  }
}

function parseJson(value: string | unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date
    ? value.toISOString()
    : new Date(value).toISOString();
}
