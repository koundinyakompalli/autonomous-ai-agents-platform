import type mysql from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'
import type {
  CreateOneShotRunGroupInput,
  OneShotRunGroup,
} from '../types.js'

type OneShotRunGroupRow = mysql.RowDataPacket & {
  id: number
  jira_key: string
  source_task_management_id: number
  status: string
  metadata_json: Record<string, unknown> | string | null
  created_at: Date | string
  updated_at: Date | string
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function parseMetadata(value: OneShotRunGroupRow['metadata_json']): Record<string, unknown> | null {
  if (!value) {
    return null
  }
  if (typeof value === 'string') {
    return JSON.parse(value) as Record<string, unknown>
  }
  return value
}

function mapRunGroup(row: OneShotRunGroupRow): OneShotRunGroup {
  return {
    id: row.id,
    jira_key: row.jira_key,
    source_task_management_id: row.source_task_management_id,
    status: row.status,
    metadata_json: parseMetadata(row.metadata_json),
    created_at: toDate(row.created_at),
    updated_at: toDate(row.updated_at),
  }
}

export class OneShotRunGroupsDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  async createGroup(data: CreateOneShotRunGroupInput): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_run_groups (
         jira_key,
         source_task_management_id,
         status,
         metadata_json
       ) VALUES (?, ?, ?, ?)`,
      [
        data.jira_key,
        data.source_task_management_id,
        data.status ?? 'active',
        data.metadata_json ? JSON.stringify(data.metadata_json) : null,
      ],
    )

    return result.insertId
  }

  async getGroupById(id: number): Promise<OneShotRunGroup | null> {
    const [rows] = await this.pool.query<OneShotRunGroupRow[]>(
      'SELECT * FROM oneshot_run_groups WHERE id = ?',
      [id],
    )

    return rows.length > 0 ? mapRunGroup(rows[0]) : null
  }
}
