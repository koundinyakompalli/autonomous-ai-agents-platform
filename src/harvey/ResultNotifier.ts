/**
 * Harvey Result Notifier
 *
 * Polls for completed tasks that originated from Harvey chat sessions
 * and pushes results back to the user via Teams proactive messaging.
 *
 * ## Lifecycle
 * 1. Poll chat_sessions WHERE status = 'task_created' AND linked task is completed
 * 2. Read result from S3
 * 3. Build a summary + full result
 * 4. Push proactive message to the user's Teams conversation
 * 5. Mark session as 'delivered'
 * 6. Re-enable session for follow-up questions
 */

import type mysql from 'mysql2/promise';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CloudAdapter,
  TurnContext,
  CardFactory,
  type ConversationReference,
} from 'botbuilder';
import { getDatabase, type Database } from '../orchestrator/database.js';
import { getStorage, type Storage } from '../orchestrator/storage.js';
import { SessionStore } from './SessionStore.js';
import { IntakeAgent } from './IntakeAgent.js';
import { createLogger } from '../utils/logger.js';
import type { ChatSession, DeliveryPayload } from './types.js';
import { buildResultCard } from './cards.js';

const logger = createLogger('harvey-notifier');

export class ResultNotifier {
  private adapter: CloudAdapter;
  private appId: string;
  private db: Database;
  private storage: Storage;
  private s3: S3Client;
  private sessionStore: SessionStore;
  private intakeAgent: IntakeAgent;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private pollIntervalMs: number;

  constructor(
    adapter: CloudAdapter,
    appId: string,
    intakeAgent: IntakeAgent,
    pollIntervalMs = 15000,
  ) {
    this.adapter = adapter;
    this.appId = appId;
    this.db = getDatabase();
    this.storage = getStorage();
    this.s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
    this.sessionStore = new SessionStore();
    this.intakeAgent = intakeAgent;
    this.pollIntervalMs = pollIntervalMs;
  }

  /**
   * Start the result notification polling loop
   */
  start(): void {
    this.isRunning = true;
    this.schedulePoll();
    logger.info({ intervalMs: this.pollIntervalMs }, '[NOTIFIER_START] Result notifier started');
  }

  /**
   * Stop the result notification polling loop
   */
  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('[NOTIFIER_STOP] Result notifier stopped');
  }

  private schedulePoll(): void {
    if (!this.isRunning) return;

    this.pollTimer = setTimeout(async () => {
      try {
        await this.checkAndDeliver();
      } catch (error: any) {
        logger.error({ error: error.message }, '[NOTIFIER_ERROR] Error in delivery cycle');
      }
      this.schedulePoll();
    }, this.pollIntervalMs);
  }

  /**
   * Check for completed tasks and deliver results to Teams.
   * Also recovers sessions whose tasks failed, so users can retry.
   */
  private async checkAndDeliver(): Promise<void> {
    // Deliver completed tasks
    const sessions = await this.sessionStore.getSessionsPendingDelivery();

    if (sessions.length > 0) {
      logger.info({ count: sessions.length }, '[NOTIFIER_FOUND] Found sessions with completed tasks');
    }

    for (const session of sessions) {
      try {
        await this.deliverResult(session);
      } catch (error: any) {
        logger.error({
          sessionId: session.session_id,
          error: error.message,
        }, '[NOTIFIER_DELIVER_ERROR] Failed to deliver result');
      }
    }

    // Recover sessions whose linked task failed — reset them to 'active' so the
    // user can try again without being blocked by the duplicate-task guard.
    await this.recoverFailedTaskSessions();
  }

  /**
   * Find task_created sessions whose task_management row has status='failed',
   * notify the user, and reset the session to 'active' for retry.
   */
  private async recoverFailedTaskSessions(): Promise<void> {
    const pool = this.db.getPool();
    const [rows] = await pool.query<any[]>(
      `SELECT cs.*, a.name as agent_name
       FROM chat_sessions cs
       INNER JOIN task_management tm ON cs.task_management_id = tm.id
       LEFT JOIN agents a ON tm.agent_id = a.id
       WHERE cs.status = 'task_created'
         AND tm.status = 'failed'`,
    );

    if (rows.length === 0) return;

    logger.info({ count: rows.length }, '[NOTIFIER_RECOVER] Recovering sessions with failed tasks');

    for (const row of rows) {
      const session = row as ChatSession & { agent_name: string };

      // Notify user if we have a conversation reference
      if (session.conversation_reference) {
        try {
          await this.adapter.continueConversationAsync(
            this.appId,
            session.conversation_reference,
            async (context) => {
              await context.sendActivity(
                `Sorry, the **${session.agent_name || 'agent'}** task encountered an error and could not complete. ` +
                `Please try your request again and I'll resubmit it.`,
              );
            },
          );
        } catch (err: any) {
          logger.warn({ sessionId: session.session_id, error: err.message },
            '[NOTIFIER_RECOVER_NOTIFY_FAIL] Could not send failure notification');
        }
      }

      // Reset session for retry — clears task_management_id so duplicate guard allows resubmit
      await this.sessionStore.resetForRetry(session.id);

      logger.info({ sessionId: session.session_id, agentName: session.agent_name },
        '[NOTIFIER_RECOVERED] Session reset to active after task failure');
    }
  }

  /**
   * Deliver a single result to the user via Teams proactive messaging
   */
  private async deliverResult(session: ChatSession): Promise<void> {
    if (!session.task_management_id) {
      logger.warn({ sessionId: session.session_id }, '[NOTIFIER_SKIP] No task_management_id');
      return;
    }

    if (!session.conversation_reference) {
      logger.warn({ sessionId: session.session_id }, '[NOTIFIER_SKIP] No conversation_reference');
      await this.sessionStore.updateStatus(session.id, 'delivered');
      return;
    }

    // Atomically claim to prevent duplicate delivery
    const claimed = await this.sessionStore.claimForDelivery(session.id);
    if (!claimed) {
      logger.info({ sessionId: session.session_id }, '[NOTIFIER_SKIP] Already claimed by another instance');
      return;
    }

    const logContext = {
      sessionId: session.session_id,
      tmId: session.task_management_id,
      userId: session.user_id,
    };

    logger.info(logContext, '[NOTIFIER_DELIVER_START] Delivering result to Teams');

    try {
      // Get the task details (join through to tasks table for S3 pointers)
      const pool = this.db.getPool();
      const [rows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT tm.*,
                COALESCE(t.result_s3_bucket, tm.task_s3_bucket) as result_s3_bucket,
                COALESCE(t.result_s3_key, tm.task_s3_key) as result_s3_key,
                t.tokens_consumed, t.cost, t.completed_at, t.started_at,
                t.task_description,
                a.name as agent_name, a.model as agent_model,
                cb.customer as customer_name, cb.branch as code_branch
         FROM task_management tm
         LEFT JOIN tasks t ON tm.task_id = t.id
         LEFT JOIN agents a ON tm.agent_id = a.id
         LEFT JOIN customer_branches cb ON tm.customer_id = cb.id
         WHERE tm.id = ?`,
        [session.task_management_id],
      );

      if (rows.length === 0) {
        logger.error(logContext, '[NOTIFIER_DELIVER_ERROR] Task not found in database');
        return;
      }

      const task = rows[0];

      // Read result from S3
      let fullResult = '';
      if (task.result_s3_bucket && task.result_s3_key) {
        fullResult = await this.storage.downloadResult(task.result_s3_bucket, task.result_s3_key);
      }

      // Calculate duration
      let durationStr = 'N/A';
      if (task.started_at && task.completed_at) {
        const durationSec = Math.round(
          (new Date(task.completed_at).getTime() - new Date(task.started_at).getTime()) / 1000,
        );
        const min = Math.floor(durationSec / 60);
        const sec = durationSec % 60;
        durationStr = min > 0 ? `${min}m ${sec}s` : `${sec}s`;
      }

      // Extract a direct key answer using a quick Bedrock call
      const keyAnswer = await this.intakeAgent.extractKeyAnswer(
        fullResult,
        task.agent_name || 'Agent',
        task.task_description || '',
      );

      // Send proactive message to Teams
      const convRef = session.conversation_reference as Partial<ConversationReference>;

      await this.adapter.continueConversationAsync(
        this.appId,
        convRef as ConversationReference,
        async (context: TurnContext) => {
          // 1. Send the header card (agent, customer, duration, cost, feedback buttons)
          const card = buildResultCard(
            task.agent_name || 'Agent',
            task.customer_name || 'Unknown',
            durationStr,
            task.cost ? `$${parseFloat(task.cost).toFixed(4)}` : 'N/A',
            session.session_id,
          );
          await context.sendActivity({ attachments: [CardFactory.adaptiveCard(card)] });

          // 2. Send the direct key answer as plain text
          await context.sendActivity(keyAnswer);

          // 3. Send a pre-signed S3 download link for the full report
          if (task.result_s3_bucket && task.result_s3_key) {
            const reportUrl = await this.getReportUrl(task.result_s3_bucket, task.result_s3_key);
            const filename = `${task.agent_name || 'result'}_${task.jira_number || 'report'}.md`;
            await context.sendActivity(`📄 **[Download full report: ${filename}](${reportUrl})**\n*(link expires in 24 hours)*`);
          }
        },
      );

      // Store the result in conversation history so Harvey can answer follow-ups.
      // Capped at 8k chars to keep the context window manageable.
      await this.sessionStore.addMessage(session.id, {
        role: 'system',
        content: `[Agent result — ${task.agent_name} for ${task.customer_name}]\n\n${fullResult.substring(0, 8000)}`,
        timestamp: new Date().toISOString(),
      });

      // Re-enable session for follow-up questions.
      // User starts fresh anytime with /new.
      await this.intakeAgent.enableFollowUp(session);

      logger.info({
        ...logContext,
        agentName: task.agent_name,
        resultLength: fullResult.length,
      }, '[NOTIFIER_DELIVERED] Result delivered to Teams');
    } catch (error: any) {
      // Release claim on failure so it can be retried
      await this.sessionStore.releaseDeliveryClaim(session.id);
      throw error;
    }
  }

  /**
   * Build a compact one-liner session summary for context handoff.
   * This gets injected into the NEXT session so Harvey knows what was done recently.
   */
  private buildSessionSummary(task: any, fullResult: string): string {
    const date = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    const firstLine = fullResult.split('\n').find(l => l.trim().length > 20) ?? '';
    return `On ${date}, ran ${task.agent_name} for ${task.customer_name ?? 'unknown customer'} — task: "${task.task_description ?? 'N/A'}". Result preview: ${firstLine.substring(0, 200)}`;
  }

  /**
   * Build a truncated summary from the full result markdown
   */
  private buildSummary(fullResult: string, maxLength: number): string {
    if (fullResult.length <= maxLength) return fullResult;

    // Try to cut at a section boundary
    const truncated = fullResult.substring(0, maxLength);
    const lastSection = truncated.lastIndexOf('\n## ');
    if (lastSection > maxLength / 2) {
      return truncated.substring(0, lastSection) + '\n\n*... (truncated — ask for more details)*';
    }

    // Fall back to paragraph boundary
    const lastParagraph = truncated.lastIndexOf('\n\n');
    if (lastParagraph > maxLength / 2) {
      return truncated.substring(0, lastParagraph) + '\n\n*... (truncated — ask for more details)*';
    }

    return truncated + '\n\n*... (truncated)*';
  }

  /**
   * Generate a pre-signed S3 URL for the full report file.
   * Expires in 24 hours — enough time for the user to download it.
   */
  private async getReportUrl(bucket: string, key: string): Promise<string> {
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return getSignedUrl(this.s3, command, { expiresIn: 86400 }); // 24 hours
  }
}
