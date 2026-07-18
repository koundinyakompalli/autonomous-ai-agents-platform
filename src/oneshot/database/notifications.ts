import type mysql from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'
import type {
  CreateOneShotNotificationInput,
  OneShotNotification,
} from '../types.js'

type OneShotNotificationRow = mysql.RowDataPacket & {
  id: number
  oneshot_run_id: number
  jira_key: string
  notification_type: OneShotNotification['notification_type']
  body_markdown: string
  status: OneShotNotification['status']
  error: string | null
  created_at: Date | string
  posted_at: Date | string | null
}

function toOptionalDate(value: Date | string | null): Date | null {
  if (!value) {
    return null
  }
  return value instanceof Date ? value : new Date(value)
}

function mapNotification(row: OneShotNotificationRow): OneShotNotification {
  return {
    id: row.id,
    oneshot_run_id: row.oneshot_run_id,
    jira_key: row.jira_key,
    notification_type: row.notification_type,
    body_markdown: row.body_markdown,
    status: row.status,
    error: row.error,
    created_at: toOptionalDate(row.created_at)!,
    posted_at: toOptionalDate(row.posted_at),
  }
}

export class OneShotNotificationsDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  async createNotification(data: CreateOneShotNotificationInput): Promise<number> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_notifications (
         oneshot_run_id,
         jira_key,
         notification_type,
         body_markdown
       ) VALUES (?, ?, ?, ?)`,
      [
        data.oneshot_run_id,
        data.jira_key,
        data.notification_type,
        data.body_markdown,
      ],
    )

    return result.insertId
  }

  async getPendingNotifications(limit = 25): Promise<OneShotNotification[]> {
    const [rows] = await this.pool.query<OneShotNotificationRow[]>(
      `SELECT * FROM oneshot_notifications
       WHERE status = 'pending'
       ORDER BY created_at ASC
       LIMIT ?`,
      [limit],
    )

    return rows.map(mapNotification)
  }

  async claimNotificationForPosting(id: number): Promise<boolean> {
    const [result] = await this.pool.query<mysql.ResultSetHeader>(
      `UPDATE oneshot_notifications
       SET status = 'posting'
       WHERE id = ? AND status = 'pending'`,
      [id],
    )

    return result.affectedRows === 1
  }

  async markNotificationPosted(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_notifications
       SET status = 'posted',
           error = NULL,
           posted_at = NOW()
       WHERE id = ?`,
      [id],
    )
  }

  async markNotificationFailed(id: number, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_notifications
       SET status = 'failed',
           error = ?,
           posted_at = NULL
       WHERE id = ?`,
      [error, id],
    )
  }

  async releaseNotificationClaim(id: number): Promise<void> {
    await this.pool.query(
      `UPDATE oneshot_notifications
       SET status = 'pending'
       WHERE id = ? AND status = 'posting'`,
      [id],
    )
  }
}
