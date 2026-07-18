/**
 * Harvey Task Creator
 *
 * Bridges the conversational intake to the existing task_management pipeline.
 * Takes resolved conversation parameters and creates a task_management row
 * identical to what the Orchestrator would create from a JIRA ticket.
 */

import { getDatabase, type Database } from '../orchestrator/database.js';
import { getStorage, type Storage } from '../orchestrator/storage.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('harvey-task-creator');

export interface CreateTaskParams {
  /** Chat session DB id */
  chatSessionId: number;
  /** Resolved agent DB id */
  agentId: number;
  /** Resolved customer_branches DB id */
  customerId: number;
  /** CSV of repo IDs (from agents table or user selection) */
  relatedCode: string;
  /** Task type from agent config (e.g., 'defect_analysis') */
  taskType: string;
  /** Full task description built from the conversation */
  taskDescription: string;
  /** Optional JIRA ticket key if the user wants one created */
  jiraNumber?: string;
}

export interface CreateTaskResult {
  taskManagementId: number;
  s3Bucket: string;
  s3Key: string;
}

export class TaskCreator {
  private db: Database;
  private storage: Storage;

  constructor() {
    this.db = getDatabase();
    this.storage = getStorage();
  }

  /**
   * Create a task_management entry from a Harvey conversation.
   *
   * This mirrors what Orchestrator.assignIssueToAgent() does:
   * 1. Upload task description to S3
   * 2. Insert into task_management with status = 'assigned'
   *
   * The existing AgentWorker pipeline picks it up from there.
   */
  async createTask(params: CreateTaskParams): Promise<CreateTaskResult> {
    const logContext = {
      chatSessionId: params.chatSessionId,
      agentId: params.agentId,
      customerId: params.customerId,
      jiraNumber: params.jiraNumber,
    };

    logger.info(logContext, '[TASK_CREATE_START] Creating task from Harvey conversation');

    // Use a synthetic reference if no JIRA ticket
    const reference = params.jiraNumber || `HARVEY-${params.chatSessionId}`;

    // Step 1: Upload task description to S3
    const { bucket, key } = await this.storage.uploadTaskDescription(
      reference,
      params.taskDescription,
    );

    logger.info({
      ...logContext,
      bucket,
      key,
      descriptionLength: params.taskDescription.length,
    }, '[TASK_S3_UPLOADED] Task description uploaded to S3');

    // Step 2: Create task_management entry
    const taskManagementId = await this.db.createTaskManagement({
      jira_number: reference,
      customer_id: params.customerId,
      agent_id: params.agentId,
      related_code: params.relatedCode,
      task_type: params.taskType,
      task_s3_bucket: bucket,
      task_s3_key: key,
      source: 'harvey',
      chat_session_id: params.chatSessionId,
    });

    logger.info({
      ...logContext,
      taskManagementId,
      reference,
    }, '[TASK_CREATED] task_management entry created — AgentWorker will pick up');

    return { taskManagementId, s3Bucket: bucket, s3Key: key };
  }
}
