import type mysql from 'mysql2/promise'
import type { OneShotQueryExecutor } from './index.js'

export type OneShotGitHubCommandStatus =
  | 'accepted'
  | 'coalesced'
  | 'duplicate'
  | 'rejected'
  | 'completed'
  | 'failed'

export interface OneShotGitHubCommandRecord {
  id: number
  oneshotRunId: number | null
  deliveryId: string
  repositoryFullName: string
  pullNumber: number
  commentId: string
  commentUrl: string | null
  requesterLogin: string
  authorAssociation: string | null
  commandText: string
  requestedPlanVersion: number | null
  status: OneShotGitHubCommandStatus
  responseCommentUrl: string | null
  rejectionReason: string | null
  createdAt: Date
  updatedAt: Date
}

export interface CreateOneShotGitHubCommandInput {
  oneshotRunId?: number | null
  deliveryId: string
  repositoryFullName: string
  pullNumber: number
  commentId: string
  commentUrl?: string | null
  requesterLogin: string
  authorAssociation?: string | null
  commandText: string
  requestedPlanVersion?: number | null
  status: OneShotGitHubCommandStatus
  responseCommentUrl?: string | null
  rejectionReason?: string | null
}

type CommandRow = mysql.RowDataPacket & {
  id: number
  oneshot_run_id: number | null
  delivery_id: string
  repository_full_name: string
  pull_number: number
  comment_id: string
  comment_url: string | null
  requester_login: string
  author_association: string | null
  command_text: string
  requested_plan_version: number | null
  status: OneShotGitHubCommandStatus
  response_comment_url: string | null
  rejection_reason: string | null
  created_at: Date | string
  updated_at: Date | string
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function mapRow(row: CommandRow): OneShotGitHubCommandRecord {
  return {
    id: Number(row.id),
    oneshotRunId: row.oneshot_run_id == null ? null : Number(row.oneshot_run_id),
    deliveryId: row.delivery_id,
    repositoryFullName: row.repository_full_name,
    pullNumber: Number(row.pull_number),
    commentId: row.comment_id,
    commentUrl: row.comment_url ?? null,
    requesterLogin: row.requester_login,
    authorAssociation: row.author_association ?? null,
    commandText: row.command_text,
    requestedPlanVersion:
      row.requested_plan_version == null
        ? null
        : Number(row.requested_plan_version),
    status: row.status,
    responseCommentUrl: row.response_comment_url ?? null,
    rejectionReason: row.rejection_reason ?? null,
    createdAt: toDate(row.created_at),
    updatedAt: toDate(row.updated_at),
  }
}

export class OneShotGitHubCommandsDB {
  constructor(private readonly pool: OneShotQueryExecutor) {}

  async getByDeliveryId(deliveryId: string): Promise<OneShotGitHubCommandRecord | null> {
    const [rows] = await this.pool.query<CommandRow[]>(
      `SELECT *
       FROM oneshot_github_commands
       WHERE delivery_id = ?
       LIMIT 1`,
      [deliveryId],
    )
    return rows[0] ? mapRow(rows[0]) : null
  }

  async createCommand(
    input: CreateOneShotGitHubCommandInput,
  ): Promise<OneShotGitHubCommandRecord> {
    await this.pool.query(
      `INSERT INTO oneshot_github_commands (
         oneshot_run_id,
         delivery_id,
         repository_full_name,
         pull_number,
         comment_id,
         comment_url,
         requester_login,
         author_association,
         command_text,
         requested_plan_version,
         status,
         response_comment_url,
         rejection_reason
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         id = LAST_INSERT_ID(id)`,
      [
        input.oneshotRunId ?? null,
        input.deliveryId,
        input.repositoryFullName,
        input.pullNumber,
        input.commentId,
        input.commentUrl ?? null,
        input.requesterLogin,
        input.authorAssociation ?? null,
        input.commandText,
        input.requestedPlanVersion ?? null,
        input.status,
        input.responseCommentUrl ?? null,
        input.rejectionReason ?? null,
      ],
    )
    const record = await this.getByDeliveryId(input.deliveryId)
    if (!record) {
      throw new Error(`Failed to load OneShot GitHub command ${input.deliveryId} after insert`)
    }
    return record
  }

  async updateResponse(input: {
    id: number
    responseCommentUrl?: string | null
    status?: OneShotGitHubCommandStatus
    rejectionReason?: string | null
  }): Promise<void> {
    const setClauses = ['updated_at = NOW(6)']
    const values: Array<string | number | null> = []
    if (Object.prototype.hasOwnProperty.call(input, 'responseCommentUrl')) {
      setClauses.push('response_comment_url = ?')
      values.push(input.responseCommentUrl ?? null)
    }
    if (input.status) {
      setClauses.push('status = ?')
      values.push(input.status)
    }
    if (Object.prototype.hasOwnProperty.call(input, 'rejectionReason')) {
      setClauses.push('rejection_reason = ?')
      values.push(input.rejectionReason ?? null)
    }
    values.push(input.id)
    await this.pool.query(
      `UPDATE oneshot_github_commands
       SET ${setClauses.join(', ')}
       WHERE id = ?`,
      values,
    )
  }

  async getCommandsForPlanning(input: {
    oneshotRunId: number
    requestedPlanVersion: number
  }): Promise<OneShotGitHubCommandRecord[]> {
    const [rows] = await this.pool.query<CommandRow[]>(
      `SELECT *
       FROM oneshot_github_commands
       WHERE oneshot_run_id = ?
         AND requested_plan_version = ?
         AND status IN ('accepted', 'coalesced')
       ORDER BY id ASC
       LIMIT 20`,
      [input.oneshotRunId, input.requestedPlanVersion],
    )
    return rows.map(mapRow)
  }
}
