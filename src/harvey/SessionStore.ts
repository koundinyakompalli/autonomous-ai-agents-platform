/**
 * Harvey Session Store
 *
 * Persists chat sessions in the MySQL database.
 * Each user gets one active session at a time; starting a new conversation
 * abandons any previous active session.
 */

import { createHash } from 'crypto';
import type mysql from 'mysql2/promise';
import { getDatabase, type Database } from '../orchestrator/database.js';
import { createLogger } from '../utils/logger.js';
import type { ChatSession, ChatSessionStatus, ChatMessage } from './types.js';
import { randomUUID } from 'crypto';

const logger = createLogger('harvey-session');

export class SessionStore {
  private db: Database;

  constructor() {
    this.db = getDatabase();
  }

  /**
   * Get or create a session for a Teams user.
   * If the user already has an active session, return it.
   * Otherwise, create a new one.
   */
  async getOrCreate(
    userId: string,
    userName: string,
    channel: 'teams' | 'web',
    conversationReference?: any,
  ): Promise<ChatSession> {
    const pool = this.db.getPool();
    // MySQL GET_LOCK names must be <= 64 chars. Teams user IDs can be 80+ chars.
    // Use a short hash of the userId to stay within the limit.
    const hash = createHash('md5').update(userId).digest('hex').substring(0, 16);
    const lockName = `hs_${hash}`;

    try {
      // Acquire advisory lock (10 second timeout)
      await pool.query('SELECT GET_LOCK(?, 10)', [lockName]);

      // Check for existing active session (under lock)
      const existing = await this.getActiveByUserId(userId);
      if (existing) {
        if (conversationReference) {
          await this.updateConversationReference(existing.id, conversationReference);
          existing.conversation_reference = conversationReference;
        }
        return existing;
      }

      // New session: check if the user has a recently completed session with a summary
      // and inject it as context so Harvey has continuity without full history.
      const previousSummary = await this.getMostRecentSummary(userId);
      return await this.create(userId, userName, channel, conversationReference, previousSummary ?? undefined);
    } finally {
      await pool.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  }

  /**
   * Create a new chat session
   */
  async create(
    userId: string,
    userName: string,
    channel: 'teams' | 'web',
    conversationReference?: any,
    previousSummary?: string,
  ): Promise<ChatSession> {
    const sessionId = randomUUID();

    // Seed messages_json with the previous session summary so Harvey has
    // compact context without carrying the full conversation history forward.
    const initialMessages: ChatMessage[] = previousSummary
      ? [{ role: 'system', content: `[Previous session context]\n${previousSummary}`, timestamp: new Date().toISOString() }]
      : [];

    const pool = this.db.getPool();
    const [result] = await pool.query<mysql.ResultSetHeader>(
      `INSERT INTO chat_sessions
       (session_id, user_id, user_name, channel, status, conversation_reference, messages_json)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
      [
        sessionId,
        userId,
        userName,
        channel,
        conversationReference ? JSON.stringify(conversationReference) : null,
        JSON.stringify(initialMessages),
      ],
    );

    logger.info({
      sessionId,
      userId,
      userName,
      channel,
      dbId: result.insertId,
      hasPreviousSummary: !!previousSummary,
    }, '[SESSION_CREATED] New chat session');

    return {
      id: result.insertId,
      session_id: sessionId,
      user_id: userId,
      user_name: userName,
      channel,
      status: 'active',
      resolved_agent_id: null,
      resolved_customer_id: null,
      resolved_repo_ids: null,
      task_management_id: null,
      jira_number: null,
      conversation_reference: conversationReference || null,
      messages_json: initialMessages,
      summary: null,
      created_at: new Date(),
      updated_at: new Date(),
    };
  }

  /**
   * Get active session for a user (most recent active/routing/task_created)
   */
  async getActiveByUserId(userId: string): Promise<ChatSession | null> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT * FROM chat_sessions
       WHERE user_id = ? AND status IN ('active', 'routing', 'task_created')
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId],
    );

    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  /**
   * Get session by session_id (UUID)
   */
  async getBySessionId(sessionId: string): Promise<ChatSession | null> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM chat_sessions WHERE session_id = ?',
      [sessionId],
    );
    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  /**
   * Get session by task_management_id (for result delivery)
   */
  async getByTaskManagementId(tmId: number): Promise<ChatSession | null> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      'SELECT * FROM chat_sessions WHERE task_management_id = ?',
      [tmId],
    );
    if (rows.length === 0) return null;
    return this.rowToSession(rows[0]);
  }

  /**
   * Add a message to the session's conversation history
   */
  async addMessage(sessionId: number, message: ChatMessage): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      `UPDATE chat_sessions
       SET messages_json = JSON_ARRAY_APPEND(messages_json, '$', CAST(? AS JSON)),
           updated_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(message), sessionId],
    );
  }

  /**
   * Get recent sessions for a user, enriched with task/agent/customer info.
   * Used by the /sessions command to show a resumable history list.
   */
  async getUserSessions(userId: string, limit = 8): Promise<any[]> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT cs.id, cs.session_id, cs.status, cs.created_at, cs.updated_at,
              cs.summary, cs.task_management_id, cs.messages_json,
              a.name as agent_name,
              cb.customer as customer_name,
              t.task_description
       FROM chat_sessions cs
       LEFT JOIN task_management tm ON cs.task_management_id = tm.id
       LEFT JOIN agents a ON tm.agent_id = a.id
       LEFT JOIN customer_branches cb ON tm.customer_id = cb.id
       LEFT JOIN tasks t ON tm.task_id = t.id
       WHERE cs.user_id = ?
       ORDER BY cs.updated_at DESC
       LIMIT ?`,
      [userId, limit],
    );
    return rows;
  }

  /**
   * Resume a previous session.
   * Abandons any currently active session, then sets the chosen session to 'active'.
   */
  async resumeSession(sessionId: string, userId: string): Promise<ChatSession | null> {
    const pool = this.db.getPool();
    const lockName = `hs_${createHash('md5').update(userId).digest('hex').substring(0, 16)}`;

    try {
      await pool.query('SELECT GET_LOCK(?, 10)', [lockName]);

      // Abandon any currently active session
      await pool.query(
        `UPDATE chat_sessions SET status = 'abandoned', updated_at = NOW()
         WHERE user_id = ? AND status IN ('active', 'routing', 'task_created')
           AND session_id != ?`,
        [userId, sessionId],
      );

      // Reactivate the chosen session
      const [result] = await pool.query<mysql.ResultSetHeader>(
        `UPDATE chat_sessions SET status = 'active', updated_at = NOW()
         WHERE session_id = ? AND user_id = ?`,
        [sessionId, userId],
      );

      if (result.affectedRows === 0) return null;

      return this.getBySessionId(sessionId);
    } finally {
      await pool.query('SELECT RELEASE_LOCK(?)', [lockName]);
    }
  }

  /**
   * Reset a session for retry after a failed task.
   * Clears task_management_id so the duplicate-task guard allows a new submission.
   */
  async resetForRetry(sessionId: number): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      `UPDATE chat_sessions
       SET status = 'active', task_management_id = NULL, updated_at = NOW()
       WHERE id = ?`,
      [sessionId],
    );
  }

  /**
   * Update session status
   */
  async updateStatus(sessionId: number, status: ChatSessionStatus): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      'UPDATE chat_sessions SET status = ?, updated_at = NOW() WHERE id = ?',
      [status, sessionId],
    );
  }

  /**
   * Update resolved agent, customer, repos, and task link
   */
  async updateResolution(
    sessionId: number,
    data: {
      resolved_agent_id?: number;
      resolved_customer_id?: number;
      resolved_repo_ids?: string;
      task_management_id?: number;
      jira_number?: string;
      status?: ChatSessionStatus;
    },
  ): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      `UPDATE chat_sessions
       SET resolved_agent_id = COALESCE(?, resolved_agent_id),
           resolved_customer_id = COALESCE(?, resolved_customer_id),
           resolved_repo_ids = COALESCE(?, resolved_repo_ids),
           task_management_id = COALESCE(?, task_management_id),
           jira_number = COALESCE(?, jira_number),
           status = COALESCE(?, status),
           updated_at = NOW()
       WHERE id = ?`,
      [
        data.resolved_agent_id ?? null,
        data.resolved_customer_id ?? null,
        data.resolved_repo_ids ?? null,
        data.task_management_id ?? null,
        data.jira_number ?? null,
        data.status ?? null,
        sessionId,
      ],
    );
  }

  /**
   * Update the Teams conversation reference
   */
  async updateConversationReference(sessionId: number, convRef: any): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      'UPDATE chat_sessions SET conversation_reference = ?, updated_at = NOW() WHERE id = ?',
      [JSON.stringify(convRef), sessionId],
    );
  }

  /**
   * Get sessions that have completed tasks ready for delivery.
   * These are sessions where status = 'task_created' and the linked
   * task_management row has status = 'completed'.
   */
  async getSessionsPendingDelivery(limit = 10): Promise<ChatSession[]> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT cs.* FROM chat_sessions cs
       INNER JOIN task_management tm ON cs.task_management_id = tm.id
       WHERE cs.status = 'task_created'
         AND tm.status = 'completed'
       ORDER BY tm.updated_at ASC
       LIMIT ?`,
      [limit],
    );
    return rows.map(r => this.rowToSession(r));
  }

  /**
   * Complete a session with a summary for the next session to inherit.
   * This implements the Option B lifecycle: each task = one session.
   */
  async completeWithSummary(sessionId: number, summary: string): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      `UPDATE chat_sessions
       SET status = 'completed', summary = ?, updated_at = NOW()
       WHERE id = ?`,
      [summary, sessionId],
    );
  }

  /**
   * Get the summary from the most recent completed session for this user.
   * Used to seed a new session with compact context.
   */
  async getMostRecentSummary(userId: string): Promise<string | null> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT summary FROM chat_sessions
       WHERE user_id = ? AND status = 'completed' AND summary IS NOT NULL
       ORDER BY updated_at DESC
       LIMIT 1`,
      [userId],
    );
    return rows.length > 0 ? rows[0].summary : null;
  }

  /**
   * Force-start a new session for a user (/new-session command).
   * Abandons the current active session without writing a summary.
   */
  async forceNew(userId: string): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      `UPDATE chat_sessions
       SET status = 'abandoned', updated_at = NOW()
       WHERE user_id = ? AND status IN ('active', 'routing', 'task_created')`,
      [userId],
    );
    logger.info({ userId }, '[SESSION_FORCE_NEW] Abandoned active session for /new-session command');
  }

  /**
   * Get current task status for a user.
   * Returns the active/routing/task_created session joined with task, agent, and customer info.
   */
  async getTaskStatus(userId: string): Promise<any | null> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT cs.id, cs.session_id, cs.status, cs.created_at, cs.updated_at,
              cs.task_management_id,
              tm.status as task_status, tm.error_message,
              a.name as agent_name,
              cb.customer as customer_name,
              t.task_description, t.started_at, t.completed_at
       FROM chat_sessions cs
       LEFT JOIN task_management tm ON cs.task_management_id = tm.id
       LEFT JOIN agents a ON tm.agent_id = a.id
       LEFT JOIN customer_branches cb ON tm.customer_id = cb.id
       LEFT JOIN tasks t ON tm.task_id = t.id
       WHERE cs.user_id = ? AND cs.status IN ('active', 'routing', 'task_created')
       ORDER BY cs.updated_at DESC
       LIMIT 1`,
      [userId],
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Get completed task history for a user.
   * Returns sessions that have a completed task with an S3 result stored.
   */
  async getUserHistory(userId: string, limit = 8): Promise<any[]> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT cs.id, cs.session_id, cs.status, cs.created_at, cs.updated_at,
              cs.task_management_id,
              tm.id as tm_id, tm.status as task_status,
              a.name as agent_name,
              cb.customer as customer_name,
              t.task_description, t.completed_at,
              t.result_s3_bucket, t.result_s3_key
       FROM chat_sessions cs
       INNER JOIN task_management tm ON cs.task_management_id = tm.id
       INNER JOIN tasks t ON tm.task_id = t.id
       LEFT JOIN agents a ON tm.agent_id = a.id
       LEFT JOIN customer_branches cb ON tm.customer_id = cb.id
       WHERE cs.user_id = ?
         AND tm.status IN ('completed', 'posted_to_jira')
         AND t.result_s3_key IS NOT NULL
       ORDER BY t.completed_at DESC
       LIMIT ?`,
      [userId, limit],
    );
    return rows;
  }

  /**
   * Cancel the current in-progress task for a user.
   * Marks both task_management and tasks rows as failed, then resets the session to active.
   * Returns true if a task was cancelled, false if there was nothing to cancel.
   */
  async cancelCurrentTask(userId: string): Promise<boolean> {
    const pool = this.db.getPool();

    // Find the active session with a cancellable task
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT cs.id as session_db_id, cs.session_id,
              tm.id as tm_id, tm.task_id, tm.status as tm_status
       FROM chat_sessions cs
       INNER JOIN task_management tm ON cs.task_management_id = tm.id
       WHERE cs.user_id = ?
         AND cs.status IN ('active', 'routing', 'task_created')
         AND tm.status IN ('assigned', 'in_progress')
       LIMIT 1`,
      [userId],
    );

    if (rows.length === 0) return false;

    const row = rows[0];

    // Cancel the task_management row
    await pool.query(
      `UPDATE task_management
       SET status = 'failed', error_message = 'Cancelled by user', updated_at = NOW()
       WHERE id = ?`,
      [row.tm_id],
    );

    // Cancel the linked task row if present
    if (row.task_id) {
      await pool.query(
        `UPDATE tasks
         SET status = 'failed', error_message = 'Cancelled by user', updated_at = NOW()
         WHERE id = ?`,
        [row.task_id],
      );
    }

    // Reset the session so the user can start fresh
    await pool.query(
      `UPDATE chat_sessions
       SET status = 'active', task_management_id = NULL, updated_at = NOW()
       WHERE id = ?`,
      [row.session_db_id],
    );

    logger.info({ userId, tmId: row.tm_id }, '[SESSION_CANCEL] Task cancelled by user');
    return true;
  }

  /**
   * Get S3 info for the most recent completed task result for a user.
   * Used by the /share command to generate a pre-signed download link.
   */
  async getLastResultS3Info(userId: string): Promise<{ bucket: string; key: string; agentName: string; customerName: string } | null> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT t.result_s3_bucket as bucket, t.result_s3_key as \`key\`,
              a.name as agentName, cb.customer as customerName
       FROM chat_sessions cs
       INNER JOIN task_management tm ON cs.task_management_id = tm.id
       INNER JOIN tasks t ON tm.task_id = t.id
       LEFT JOIN agents a ON tm.agent_id = a.id
       LEFT JOIN customer_branches cb ON tm.customer_id = cb.id
       WHERE cs.user_id = ?
         AND t.result_s3_key IS NOT NULL
       ORDER BY t.completed_at DESC
       LIMIT 1`,
      [userId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      bucket: r.bucket,
      key: r.key,
      agentName: r.agentName ?? 'Agent',
      customerName: r.customerName ?? 'Unknown',
    };
  }

  /**
   * Record user feedback (thumbs up / thumbs down) for a session.
   */
  async recordFeedback(sessionUuid: string, feedback: 'positive' | 'negative'): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      `UPDATE chat_sessions SET feedback = ?, updated_at = NOW() WHERE session_id = ?`,
      [feedback, sessionUuid],
    );
    logger.info({ sessionUuid, feedback }, '[SESSION_FEEDBACK] Feedback recorded');
  }

  /**
   * Get S3 bucket/key for a specific task_management_id.
   * Used by the __download: command to generate a pre-signed URL for a history entry.
   */
  async getResultS3Info(taskManagementId: number): Promise<{ bucket: string; key: string; agentName: string; customerName: string } | null> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<mysql.RowDataPacket[]>(
      `SELECT COALESCE(t.result_s3_bucket, tm.task_s3_bucket) as bucket,
              COALESCE(t.result_s3_key, tm.task_s3_key) as \`key\`,
              a.name as agentName, cb.customer as customerName
       FROM task_management tm
       LEFT JOIN tasks t ON tm.task_id = t.id
       LEFT JOIN agents a ON tm.agent_id = a.id
       LEFT JOIN customer_branches cb ON tm.customer_id = cb.id
       WHERE tm.id = ?`,
      [taskManagementId],
    );
    if (rows.length === 0) return null;
    const r = rows[0];
    if (!r.key) return null;
    return {
      bucket: r.bucket,
      key: r.key,
      agentName: r.agentName ?? 'Agent',
      customerName: r.customerName ?? 'Unknown',
    };
  }

  /**
   * Abandon stale sessions (no activity for > 1 hour)
   */
  async abandonStaleSessions(): Promise<number> {
    const pool = this.db.getPool();
    const [result] = await pool.query<mysql.ResultSetHeader>(
      `UPDATE chat_sessions
       SET status = 'abandoned', updated_at = NOW()
       WHERE status IN ('active', 'routing')
         AND updated_at < DATE_SUB(NOW(), INTERVAL 1 HOUR)`,
    );
    // Also clean up task_created sessions stuck for > 4 hours (agent likely crashed)
    const [result2] = await pool.query<mysql.ResultSetHeader>(
      `UPDATE chat_sessions
       SET status = 'abandoned', updated_at = NOW()
       WHERE status = 'task_created'
         AND updated_at < DATE_SUB(NOW(), INTERVAL 4 HOUR)`,
    );
    const total = result.affectedRows + result2.affectedRows;
    if (total > 0) {
      logger.info({ count: total }, '[SESSION_CLEANUP] Abandoned stale sessions');
    }
    return total;
  }

  /**
   * Atomically claim a session for result delivery.
   * Prevents duplicate delivery when multiple Harvey replicas run.
   */
  async claimForDelivery(sessionId: number): Promise<boolean> {
    const pool = this.db.getPool();
    const [result] = await pool.query<mysql.ResultSetHeader>(
      `UPDATE chat_sessions
       SET status = 'delivering', updated_at = NOW()
       WHERE id = ? AND status = 'task_created'`,
      [sessionId],
    );
    return result.affectedRows === 1;
  }

  /**
   * Release delivery claim back to task_created on failure.
   */
  async releaseDeliveryClaim(sessionId: number): Promise<void> {
    const pool = this.db.getPool();
    await pool.query(
      `UPDATE chat_sessions
       SET status = 'task_created', updated_at = NOW()
       WHERE id = ? AND status = 'delivering'`,
      [sessionId],
    );
  }

  /**
   * Convert a DB row to a typed ChatSession
   */
  private rowToSession(row: any): ChatSession {
    return {
      ...row,
      conversation_reference: typeof row.conversation_reference === 'string'
        ? JSON.parse(row.conversation_reference)
        : row.conversation_reference,
      messages_json: typeof row.messages_json === 'string'
        ? JSON.parse(row.messages_json)
        : row.messages_json ?? [],
    };
  }
}
