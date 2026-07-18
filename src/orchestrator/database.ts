/**
 * Database Connection Manager
 *
 * Supports both local (bastion) and production (RDS) environments
 */

import mysql from "mysql2/promise";
import { createLogger } from "../utils/logger.js";
import type {
  HistoricalTicketRecord,
  RoutingPlan,
} from "../oneshot/repo-router/types.js";
import {
  getInvestigationRepoBranchCandidatesForVersion,
  getInvestigationRepositoryDefaultBranchName,
  isInvestigationVersionedRepositoryName,
} from "../investigation/repo-routing/InvestigationRepoRouting.js";

const logger = createLogger("database");

function normalizeRepositoryUrlForLookup(repoUrl: string): string {
  return repoUrl
    .trim()
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .toLowerCase();
}

export interface DatabaseConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connectionLimit?: number;
  ssl?: mysql.PoolOptions["ssl"];
}

function booleanEnv(value: string | undefined): boolean {
  return ["true", "1", "yes"].includes(value?.trim().toLowerCase() ?? "");
}

export function resolveDatabaseSslOptions(
  env: NodeJS.ProcessEnv = process.env,
): mysql.PoolOptions["ssl"] | undefined {
  if (!booleanEnv(env.DB_SSL)) return undefined;
  return {
    rejectUnauthorized: !["false", "0", "no"].includes(
      env.DB_SSL_REJECT_UNAUTHORIZED?.trim().toLowerCase() ?? "",
    ),
  };
}

export interface Agent {
  id: number;
  name: string;
  description: string; // Full description of agent purpose
  additional_context?: string; // Extra context to append to every task
  model: string;
  task_type: string; // Type of task this agent handles
  jql: string;
  jira_token: string; // Agent-specific JIRA API token
  jira_username: string; // Jira account email for Basic auth (username:token)
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface CustomerBranch {
  id: number;
  customer: string;
  branch: string;
  default: boolean;
}

export interface CodeRepository {
  id: number;
  repo_name: string;
  repo_url: string;
  description: string;
  default_branch?: string | null;
  created_at: Date;
}

export interface Task {
  id: number;
  task_type: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  task_description: string;
  result_s3_bucket?: string;
  result_s3_key?: string;
  error_message?: string;
  metrics_json?: any;
  tokens_consumed?: string; // Token usage (e.g., "input:1234,output:5678")
  cost?: string; // Task cost in USD (e.g., "0.0234")
  created_at: Date;
  updated_at: Date;
  started_at?: Date;
  completed_at?: Date;
}

export interface TaskManagement {
  id: number;
  jira_number: string;
  customer_id: number; // FK to customer_branches.id
  agent_id: number;
  related_code: string; // CSV of repo IDs (e.g., "1,2,3")
  task_type: string; // Type of task from agent
  task_id?: number;
  task_s3_bucket?: string;
  task_s3_key?: string;
  status:
    | "assigned"
    | "in_progress"
    | "waiting_repo_confirmation"
    | "completed"
    | "failed"
    | "failed_retries_exhausted"
    | "posting_to_jira"
    | "posted_to_jira";
  source: "jira" | "harvey" | "api";
  jira_posted_at?: Date;
  error_message?: string;
  retry_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface OneShotDashboardRunRequest {
  id: number;
  jira_key: string;
  requested_by: string;
  requested_by_display: string;
  status: "queued" | "processing" | "task_created" | "failed";
  error_message?: string | null;
  task_management_id?: number | null;
  created_at: Date;
  updated_at: Date;
  started_at?: Date | null;
  finished_at?: Date | null;
}

export type OneShotArtifactRunMode =
  | "wiz"
  | "sonar"
  | "wiz_sast"
  | "documentation";

export interface OneShotArtifactRunUpsert {
  sourceKey: string;
  sourceParentKey?: string | null;
  mode: OneShotArtifactRunMode;
  status: string;
  title: string;
  generatedCount: number;
  generatedTickets?: unknown[];
  humanReviewRequired: boolean;
  humanReviewCount: number;
  reviewItems?: unknown[];
  evidence?: Record<string, unknown> | null;
  artifactRefs?: Record<string, unknown> | null;
  jiraSummary?: string | null;
  completedAt?: Date | string | null;
}

export interface RouterDecisionRecord {
  id: number;
  ticket_id: string;
  task_management_id?: number | null;
  outcome: string;
  decision_source: string;
  selected_repo_ids_json?: any;
  unsupported_repo_ids_json?: any;
  blocking_reasons_json?: any;
  scores_json?: any;
  snapshot_hash: string;
  created_at: Date;
}

export interface RouterConfirmationRecord {
  id: number;
  ticket_id: string;
  task_management_id?: number | null;
  router_decision_id?: number | null;
  resolved_at?: Date | null;
  resolved_by?: string | null;
  resolved_repo_id?: number | null;
  resolution_source?: string | null;
  snapshot_hash: string;
  created_at: Date;
  updated_at: Date;
}

export interface OneShotPrOpenRunForLearning {
  id: string;
  jira_key: string;
  repo_id: number;
  repo_name: string;
  repo_url: string;
  current_pr_url: string;
  created_at: Date;
}

/**
 * Get database configuration based on environment
 */
export function resolveDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
): DatabaseConfig {
  const runtime = env.NODE_ENV || "development";
  const password = env.DB_PASSWORD;
  if (!password?.trim()) {
    throw new Error("database_configuration_invalid:DB_PASSWORD_required");
  }

  if (runtime === "production") {
    // Production RDS
    return {
      host: env.DB_HOST || "specter-rds.amazonaws.com",
      port: parseInt(env.DB_PORT || "3306"),
      user: env.DB_USER || "document_ai_admin",
      password,
      database: env.DB_NAME || "Specter",
      connectionLimit: 10,
      ssl: resolveDatabaseSslOptions(env),
    };
  } else {
    // Local development (bastion tunnel)
    return {
      host: env.DB_HOST || "localhost",
      port: parseInt(env.DB_PORT || "13306"),
      user: env.DB_USER || "document_ai_admin",
      password,
      database: env.DB_NAME || "Specter",
      connectionLimit: 5,
      ssl: resolveDatabaseSslOptions(env),
    };
  }
}

/**
 * Database Connection Pool
 */
class Database {
  private pool: mysql.Pool | null = null;
  private config: DatabaseConfig;

  constructor(config?: DatabaseConfig) {
    this.config = config || resolveDatabaseConfig();
  }

  /**
   * Initialize database connection pool
   */
  async connect(): Promise<void> {
    if (this.pool) {
      logger.warn("Database pool already exists");
      return;
    }

    try {
      this.pool = mysql.createPool({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        database: this.config.database,
        ssl: this.config.ssl,
        waitForConnections: true,
        connectionLimit: this.config.connectionLimit || 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 0,
      });

      // Test connection
      const connection = await this.pool.getConnection();
      await connection.ping();
      connection.release();

      logger.info(
        {
          host: this.config.host,
          port: this.config.port,
          database: this.config.database,
        },
        "Database connected",
      );
    } catch (error) {
      logger.error({ error }, "Failed to connect to database");
      throw error;
    }
  }

  /**
   * Close database connection pool
   */
  async disconnect(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
      logger.info("Database disconnected");
    }
  }

  /**
   * Get connection pool
   */
  getPool(): mysql.Pool {
    if (!this.pool) {
      throw new Error("Database not connected. Call connect() first.");
    }
    return this.pool;
  }

  // ============================================================================
  // AGENTS TABLE
  // ============================================================================

  /**
   * Get all active agents
   */
  async getActiveAgents(): Promise<Agent[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM agents WHERE is_active = TRUE ORDER BY name",
    );
    return rows as Agent[];
  }

  /**
   * Get agent by ID
   */
  async getAgentById(agentId: number): Promise<Agent | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM agents WHERE id = ?",
      [agentId],
    );
    return rows.length > 0 ? (rows[0] as Agent) : null;
  }

  /**
   * Get agent by name
   */
  async getAgentByName(name: string): Promise<Agent | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM agents WHERE name = ?",
      [name],
    );
    return rows.length > 0 ? (rows[0] as Agent) : null;
  }

  // ============================================================================
  // TASKS TABLE
  // ============================================================================

  /**
   * Create a new task
   */
  async createTask(data: {
    task_type: string;
    task_description: string;
    status?: Task["status"];
  }): Promise<number> {
    const [result] = await this.getPool().query<mysql.ResultSetHeader>(
      `INSERT INTO tasks (task_type, task_description, status, started_at)
       VALUES (?, ?, ?, NOW())`,
      [data.task_type, data.task_description, data.status || "pending"],
    );
    return result.insertId;
  }

  /**
   * Update task status
   */
  async updateTaskStatus(
    taskId: number,
    status: Task["status"],
    updates?: {
      error_message?: string;
      result_s3_bucket?: string;
      result_s3_key?: string;
      metrics_json?: any;
      tokens_consumed?: string;
      cost?: string;
    },
  ): Promise<void> {
    const completedAt =
      status === "completed" || status === "failed" ? "NOW()" : "NULL";

    await this.getPool().query(
      `UPDATE tasks
       SET status = ?,
           error_message = ?,
           result_s3_bucket = ?,
           result_s3_key = ?,
           metrics_json = ?,
           tokens_consumed = ?,
           cost = ?,
           completed_at = ${completedAt},
           updated_at = NOW()
       WHERE id = ?`,
      [
        status,
        updates?.error_message || null,
        updates?.result_s3_bucket || null,
        updates?.result_s3_key || null,
        updates?.metrics_json ? JSON.stringify(updates.metrics_json) : null,
        updates?.tokens_consumed || null,
        updates?.cost || null,
        taskId,
      ],
    );
  }

  /**
   * Get task by ID
   */
  async getTaskById(taskId: number): Promise<Task | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM tasks WHERE id = ?",
      [taskId],
    );
    return rows.length > 0 ? (rows[0] as Task) : null;
  }

  // ============================================================================
  // TASK_MANAGEMENT TABLE
  // ============================================================================

  /**
   * Create task management entry (assign JIRA ticket to agent)
   */
  async createTaskManagement(data: {
    jira_number: string;
    customer_id: number; // FK to customer_branches.id
    agent_id: number;
    related_code: string; // CSV of repo IDs
    task_type: string;
    task_id?: number;
    task_s3_bucket?: string;
    task_s3_key?: string;
    source?: "jira" | "harvey" | "api";
    chat_session_id?: number;
    status?: TaskManagement["status"];
  }): Promise<number> {
    try {
      const [result] = await this.getPool().query<mysql.ResultSetHeader>(
        `INSERT INTO task_management
         (jira_number, customer_id, agent_id, related_code, task_type, task_id, task_s3_bucket, task_s3_key, source, chat_session_id, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          data.jira_number,
          data.customer_id,
          data.agent_id,
          data.related_code,
          data.task_type,
          data.task_id || null,
          data.task_s3_bucket || null,
          data.task_s3_key || null,
          data.source || "jira",
          data.chat_session_id || null,
          data.status || "assigned",
        ],
      );
      return result.insertId;
    } catch (error: any) {
      // Handle duplicate jira_number + agent_id combo
      if (error.code === "ER_DUP_ENTRY") {
        logger.warn(
          {
            jira_number: data.jira_number,
            agent_id: data.agent_id,
          },
          "JIRA ticket already assigned to this agent",
        );
        // Get existing ID for this jira+agent combo
        const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
          "SELECT id FROM task_management WHERE jira_number = ? AND agent_id = ?",
          [data.jira_number, data.agent_id],
        );
        return rows[0].id;
      }
      throw error;
    }
  }

  /**
   * Update task management status
   */
  async updateTaskManagementStatus(
    tmId: number,
    status: TaskManagement["status"],
    updates?: {
      task_id?: number;
      error_message?: string;
      jira_posted_at?: Date;
      increment_retry_count?: boolean;
    },
  ): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET status = ?,
           task_id = COALESCE(?, task_id),
           error_message = ?,
           jira_posted_at = ?,
           retry_count = COALESCE(retry_count, 0) + ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        status,
        updates?.task_id || null,
        updates?.error_message || null,
        updates?.jira_posted_at || null,
        updates?.increment_retry_count ? 1 : 0,
        tmId,
      ],
    );
  }

  /**
   * Get assigned tasks for a specific agent
   */
  async getAssignedTasksForAgent(
    agentId: number,
    limit = 10,
  ): Promise<TaskManagement[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT * FROM task_management
       WHERE agent_id = ? AND status = 'assigned'
       ORDER BY created_at ASC
       LIMIT ?`,
      [agentId, limit],
    );
    return rows as TaskManagement[];
  }

  /**
   * Get task management by JIRA number (returns the first one for any agent)
   */
  async getTaskManagementByJira(
    jiraNumber: string,
  ): Promise<TaskManagement | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM task_management WHERE jira_number = ?",
      [jiraNumber],
    );
    return rows.length > 0 ? (rows[0] as TaskManagement) : null;
  }

  /**
   * Get task management by JIRA number AND agent ID
   * This allows the same ticket to be processed by multiple agents
   */
  async getTaskManagementByJiraAndAgent(
    jiraNumber: string,
    agentId: number,
  ): Promise<TaskManagement | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM task_management WHERE jira_number = ? AND agent_id = ?",
      [jiraNumber, agentId],
    );
    return rows.length > 0 ? (rows[0] as TaskManagement) : null;
  }

  /**
   * Get task management row by linked task ID
   */
  async getTaskManagementByTaskId(
    taskId: number,
  ): Promise<TaskManagement | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM task_management WHERE task_id = ? LIMIT 1",
      [taskId],
    );
    return rows.length > 0 ? (rows[0] as TaskManagement) : null;
  }

  /**
   * Get task management row by primary key
   */
  async getTaskManagementById(tmId: number): Promise<TaskManagement | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM task_management WHERE id = ? LIMIT 1",
      [tmId],
    );
    return rows.length > 0 ? (rows[0] as TaskManagement) : null;
  }

  // ============================================================================
  // ONESHOT DASHBOARD RUN REQUESTS
  // ============================================================================

  async createOneShotDashboardRunRequest(data: {
    jira_key: string;
    requested_by: string;
    requested_by_display: string;
  }): Promise<number> {
    const [result] = await this.getPool().query<mysql.ResultSetHeader>(
      `INSERT INTO oneshot_dashboard_run_requests
       (jira_key, requested_by, requested_by_display, status)
       VALUES (?, ?, ?, 'queued')`,
      [data.jira_key, data.requested_by, data.requested_by_display],
    );

    return result.insertId;
  }

  async getOneShotDashboardRunRequestById(
    requestId: number,
  ): Promise<OneShotDashboardRunRequest | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM oneshot_dashboard_run_requests WHERE id = ? LIMIT 1",
      [requestId],
    );

    return rows.length > 0 ? (rows[0] as OneShotDashboardRunRequest) : null;
  }

  async getActiveOneShotDashboardRunRequestByJiraKey(
    jiraKey: string,
  ): Promise<OneShotDashboardRunRequest | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT * FROM oneshot_dashboard_run_requests
       WHERE jira_key = ?
         AND status IN ('queued', 'processing')
       ORDER BY created_at DESC
       LIMIT 1`,
      [jiraKey],
    );

    return rows.length > 0 ? (rows[0] as OneShotDashboardRunRequest) : null;
  }

  async claimNextOneShotDashboardRunRequest(): Promise<OneShotDashboardRunRequest | null> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const [rows] = await this.getPool().query<
        Array<mysql.RowDataPacket & { id: number }>
      >(
        `SELECT id
         FROM oneshot_dashboard_run_requests
         WHERE status = 'queued'
         ORDER BY created_at ASC
         LIMIT 1`,
      );

      const nextId = rows[0]?.id;
      if (!nextId) {
        return null;
      }

      const [result] = await this.getPool().query<mysql.ResultSetHeader>(
        `UPDATE oneshot_dashboard_run_requests
         SET status = 'processing',
             started_at = COALESCE(started_at, NOW()),
             updated_at = NOW()
         WHERE id = ?
           AND status = 'queued'`,
        [nextId],
      );

      if (result.affectedRows === 1) {
        return this.getOneShotDashboardRunRequestById(nextId);
      }
    }

    return null;
  }

  async markOneShotDashboardRunRequestTaskCreated(
    requestId: number,
    taskManagementId: number,
  ): Promise<void> {
    await this.getPool().query(
      `UPDATE oneshot_dashboard_run_requests
       SET status = 'task_created',
           task_management_id = ?,
           error_message = NULL,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [taskManagementId, requestId],
    );
  }

  async markOneShotDashboardRunRequestFailed(
    requestId: number,
    errorMessage: string,
  ): Promise<void> {
    await this.getPool().query(
      `UPDATE oneshot_dashboard_run_requests
       SET status = 'failed',
           error_message = ?,
           finished_at = NOW(),
           updated_at = NOW()
       WHERE id = ?`,
      [errorMessage, requestId],
    );
  }

  async upsertOneShotArtifactRun(
    data: OneShotArtifactRunUpsert,
  ): Promise<void> {
    await this.getPool().query(
      `INSERT INTO oneshot_artifact_runs (
         source_key,
         source_parent_key,
         mode,
         status,
         title,
         generated_count,
         generated_tickets_json,
         human_review_required,
         human_review_count,
         review_items_json,
         evidence_json,
         artifact_refs_json,
         jira_summary,
         completed_at
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source_parent_key = VALUES(source_parent_key),
         status = VALUES(status),
         title = VALUES(title),
         generated_count = VALUES(generated_count),
         generated_tickets_json = VALUES(generated_tickets_json),
         human_review_required = VALUES(human_review_required),
         human_review_count = VALUES(human_review_count),
         review_items_json = VALUES(review_items_json),
         evidence_json = VALUES(evidence_json),
         artifact_refs_json = VALUES(artifact_refs_json),
         jira_summary = VALUES(jira_summary),
         completed_at = VALUES(completed_at),
         updated_at = CURRENT_TIMESTAMP(3)`,
      [
        data.sourceKey,
        data.sourceParentKey ?? null,
        data.mode,
        data.status,
        data.title,
        data.generatedCount,
        JSON.stringify(data.generatedTickets ?? []),
        data.humanReviewRequired ? 1 : 0,
        data.humanReviewCount,
        JSON.stringify(data.reviewItems ?? []),
        data.evidence ? JSON.stringify(data.evidence) : null,
        data.artifactRefs ? JSON.stringify(data.artifactRefs) : null,
        data.jiraSummary ?? null,
        data.completedAt ?? null,
      ],
    );
  }

  /**
   * Requeue an existing task_management row for a fresh processing pass.
   * This is primarily used by QUALIFIER re-entry paths because task_management
   * only allows one row per jira_number + agent_id.
   */
  async requeueTaskManagement(
    tmId: number,
    updates: {
      customer_id: number;
      related_code: string;
      task_type: string;
      task_s3_bucket?: string;
      task_s3_key?: string;
      source?: "jira" | "harvey" | "api";
      status?: TaskManagement["status"];
      retry_count?: number;
    },
  ): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET customer_id = ?,
           related_code = ?,
           task_type = ?,
           task_id = NULL,
           task_s3_bucket = ?,
           task_s3_key = ?,
           source = ?,
           status = ?,
           jira_posted_at = NULL,
           error_message = NULL,
           retry_count = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [
        updates.customer_id,
        updates.related_code,
        updates.task_type,
        updates.task_s3_bucket || null,
        updates.task_s3_key || null,
        updates.source || "jira",
        updates.status || "assigned",
        updates.retry_count ?? 0,
        tmId,
      ],
    );
  }

  async updateTaskManagementRelatedCodeAndStatus(
    tmId: number,
    relatedCode: string,
    status: TaskManagement["status"] = "assigned",
  ): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET related_code = ?,
           status = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [relatedCode, status, tmId],
    );
  }

  async updateTaskManagementTaskPayload(
    tmId: number,
    taskS3Bucket: string,
    taskS3Key: string,
  ): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET task_s3_bucket = ?,
           task_s3_key = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [taskS3Bucket, taskS3Key, tmId],
    );
  }

  async createRouterDecision(
    plan: RoutingPlan,
    options: {
      taskManagementId?: number | null;
      currentLogicResult?: unknown;
      currentLogicDisposition?: string | null;
    } = {},
  ): Promise<number | null> {
    const [top1, top2] = plan.candidates;

    // v3.1: nest extractor + shortlist + decider LLM I/O under role keys so
    // all three are auditable from a single JSON blob. Cost is summed across
    // all roles.
    const anyLlmRan =
      plan.extractorLlmCall !== null ||
      plan.shortlistLlmCall !== null ||
      plan.deciderLlmCall !== null;
    const llmInputJson = !anyLlmRan
      ? null
      : JSON.stringify({
          extractor: plan.extractorLlmCall
            ? {
                model: plan.extractorLlmCall.model,
                input: plan.extractorLlmCall.input,
                timestamp: plan.extractorLlmCall.timestamp,
              }
            : null,
          shortlist: plan.shortlistLlmCall
            ? {
                model: plan.shortlistLlmCall.model,
                input: plan.shortlistLlmCall.input,
                timestamp: plan.shortlistLlmCall.timestamp,
              }
            : null,
          decider: plan.deciderLlmCall
            ? {
                model: plan.deciderLlmCall.model,
                input: plan.deciderLlmCall.input,
                timestamp: plan.deciderLlmCall.timestamp,
              }
            : null,
        });
    const llmOutputJson = !anyLlmRan
      ? null
      : JSON.stringify({
          extractor: plan.extractorLlmCall
            ? {
                output: plan.extractorLlmCall.output,
                validated: plan.extractorLlmCall.validated,
                warnings: plan.extractorLlmCall.warnings ?? null,
                usage: {
                  input_tokens: plan.extractorLlmCall.inputTokens,
                  output_tokens: plan.extractorLlmCall.outputTokens,
                },
                latencyMs: plan.extractorLlmCall.latencyMs,
                costUsd: plan.extractorLlmCall.costUsd,
              }
            : null,
          shortlist: plan.shortlistLlmCall
            ? {
                output: plan.shortlistLlmCall.output,
                validated: plan.shortlistLlmCall.validated,
                warnings: plan.shortlistLlmCall.warnings ?? null,
                usage: {
                  input_tokens: plan.shortlistLlmCall.inputTokens,
                  output_tokens: plan.shortlistLlmCall.outputTokens,
                },
                latencyMs: plan.shortlistLlmCall.latencyMs,
                costUsd: plan.shortlistLlmCall.costUsd,
              }
            : null,
          decider: plan.deciderLlmCall
            ? {
                output: plan.deciderLlmCall.output,
                validated: plan.deciderLlmCall.validated,
                abstained: plan.deciderLlmCall.abstained ?? false,
                confidence: plan.deciderConfidence,
                reasoning: plan.deciderReasoning,
                citations: plan.deciderCitations,
                usage: {
                  input_tokens: plan.deciderLlmCall.inputTokens,
                  output_tokens: plan.deciderLlmCall.outputTokens,
                },
                latencyMs: plan.deciderLlmCall.latencyMs,
                costUsd: plan.deciderLlmCall.costUsd,
              }
            : null,
        });

    try {
      const [result] = await this.getPool().query<mysql.ResultSetHeader>(
        `INSERT INTO router_decisions
         (ticket_id, task_management_id, outcome, decision_source, signals_json, scores_json,
          top1_repo_id, top1_score, top2_repo_id, top2_score, chosen_repo_id,
          selected_repo_ids_json, unsupported_repo_ids_json, blocking_reasons_json,
          llm_input_json, llm_output_json, llm_cost_usd,
          current_logic_result, current_logic_disposition, profile_versions_json,
          weights_version, extractor_schema_version, snapshot_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          plan.jiraKey,
          options.taskManagementId ?? null,
          plan.outcome,
          plan.decisionSource,
          JSON.stringify(plan.signals),
          JSON.stringify(
            plan.candidates.map((candidate) => ({
              repoId: candidate.repo.id,
              repoName: candidate.repo.repo_name,
              score: candidate.score,
              evidence: candidate.evidence,
            })),
          ),
          top1?.repo.id ?? null,
          top1?.score ?? null,
          top2?.repo.id ?? null,
          top2?.score ?? null,
          plan.selectedRepoIds[0] ?? null,
          JSON.stringify(plan.selectedRepoIds),
          JSON.stringify(plan.unsupportedRepoIds),
          JSON.stringify(plan.blockingReasons),
          llmInputJson,
          llmOutputJson,
          plan.totalLlmCostUsd ?? null,
          options.currentLogicResult === undefined
            ? null
            : JSON.stringify(options.currentLogicResult),
          options.currentLogicDisposition ?? null,
          JSON.stringify(plan.profileVersions),
          plan.weightsVersion,
          plan.extractorSchemaVersion,
          plan.snapshotHash,
        ],
      );
      return result.insertId;
    } catch (error: any) {
      if (error?.code === "ER_NO_SUCH_TABLE") {
        logger.warn(
          { jira: plan.jiraKey },
          "router_decisions table missing; skipping RepoRouter decision persistence",
        );
        return null;
      }
      throw error;
    }
  }

  async createRouterConfirmation(data: {
    ticketId: string;
    taskManagementId: number;
    routerDecisionId?: number | null;
    candidates: unknown;
    evidence?: unknown;
    snapshotHash: string;
    /** v3.5 P2 #4: id of the Jira comment posted announcing the confirmation. */
    jiraCommentId?: string | null;
  }): Promise<number> {
    if (!Number.isInteger(data.taskManagementId)) {
      throw new Error("createRouterConfirmation requires taskManagementId");
    }

    const connection = await this.getPool().getConnection();
    try {
      await connection.beginTransaction();
      const [taskRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number; status: string }>
      >(
        `SELECT id, status
         FROM task_management
         WHERE id = ?
         FOR UPDATE`,
        [data.taskManagementId],
      );
      const task = taskRows[0];
      if (!task) {
        throw new Error(
          `Cannot create RepoRouter confirmation for missing task_management ${data.taskManagementId}`,
        );
      }
      if (task.status !== "waiting_repo_confirmation") {
        throw new Error(
          `Cannot create RepoRouter confirmation for task_management ${data.taskManagementId} in status ${task.status}`,
        );
      }

      const [existingRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number }>
      >(
        `SELECT id
         FROM router_confirmations
         WHERE ticket_id = ?
           AND task_management_id = ?
           AND resolved_at IS NULL
         ORDER BY id DESC
         LIMIT 1
         FOR UPDATE`,
        [data.ticketId, data.taskManagementId],
      );

      if (existingRows[0]?.id) {
        await connection.query(
          `UPDATE router_confirmations
           SET router_decision_id = ?,
               candidates_json = ?,
               evidence_json = ?,
               timeout_state = 'pending',
               snapshot_hash = ?,
               resolved_by = NULL,
               resolved_repo_id = NULL,
               resolution_source = NULL,
               jira_comment_id = COALESCE(?, jira_comment_id),
               updated_at = NOW()
           WHERE id = ?`,
          [
            data.routerDecisionId ?? null,
            JSON.stringify(data.candidates),
            data.evidence === undefined ? null : JSON.stringify(data.evidence),
            data.snapshotHash,
            data.jiraCommentId ?? null,
            existingRows[0].id,
          ],
        );
        await connection.commit();
        return existingRows[0].id;
      }

      const [result] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO router_confirmations
         (ticket_id, task_management_id, router_decision_id, candidates_json, evidence_json, snapshot_hash, jira_comment_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          data.ticketId,
          data.taskManagementId,
          data.routerDecisionId ?? null,
          JSON.stringify(data.candidates),
          data.evidence === undefined ? null : JSON.stringify(data.evidence),
          data.snapshotHash,
          data.jiraCommentId ?? null,
        ],
      );
      await connection.commit();
      return result.insertId;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Atomically park a QUALIFIER task for repo confirmation. Updates
   * task_management.status to 'waiting_repo_confirmation', writes the
   * router_decisions row, and writes the router_confirmations row in a
   * single transaction. If any step fails, the entire write is rolled back
   * — the task stays in its original status so AgentWorker can hit its
   * normal failure path (or the worker can be re-claimed by another
   * container) instead of being silently parked with no confirmation row.
   *
   * Returns { routerDecisionId, routerConfirmationId } on success.
   */
  async parkQualifierForRepoConfirmation(input: {
    plan: RoutingPlan;
    candidates: unknown;
    evidence?: unknown;
    snapshotHash: string;
    taskManagementId: number;
    currentLogicResult?: unknown;
    currentLogicDisposition?: string | null;
    jiraCommentId?: string | null;
  }): Promise<{ routerDecisionId: number; routerConfirmationId: number }> {
    if (!Number.isInteger(input.taskManagementId)) {
      throw new Error(
        "parkQualifierForRepoConfirmation requires taskManagementId",
      );
    }
    const { plan } = input;
    const [top1, top2] = plan.candidates;

    const anyLlmRan =
      plan.extractorLlmCall !== null ||
      plan.shortlistLlmCall !== null ||
      plan.deciderLlmCall !== null;
    const llmInputJson = !anyLlmRan
      ? null
      : JSON.stringify({
          extractor: plan.extractorLlmCall
            ? {
                model: plan.extractorLlmCall.model,
                input: plan.extractorLlmCall.input,
                timestamp: plan.extractorLlmCall.timestamp,
              }
            : null,
          shortlist: plan.shortlistLlmCall
            ? {
                model: plan.shortlistLlmCall.model,
                input: plan.shortlistLlmCall.input,
                timestamp: plan.shortlistLlmCall.timestamp,
              }
            : null,
          decider: plan.deciderLlmCall
            ? {
                model: plan.deciderLlmCall.model,
                input: plan.deciderLlmCall.input,
                timestamp: plan.deciderLlmCall.timestamp,
              }
            : null,
        });
    const llmOutputJson = !anyLlmRan
      ? null
      : JSON.stringify({
          extractor: plan.extractorLlmCall,
          shortlist: plan.shortlistLlmCall,
          decider: plan.deciderLlmCall,
        });

    const connection = await this.getPool().getConnection();
    try {
      await connection.beginTransaction();

      // Lock the row first so we can't race with another worker that's
      // resetting status. If the task isn't in a state we can park, fail
      // the whole transaction without touching anything.
      const [taskRows] = await connection.query<
        Array<mysql.RowDataPacket & { id: number; status: string }>
      >(
        `SELECT id, status
         FROM task_management
         WHERE id = ?
         FOR UPDATE`,
        [input.taskManagementId],
      );
      const task = taskRows[0];
      if (!task) {
        throw new Error(
          `Cannot park missing task_management ${input.taskManagementId}`,
        );
      }
      if (
        task.status !== "in_progress" &&
        task.status !== "assigned" &&
        task.status !== "waiting_repo_confirmation"
      ) {
        throw new Error(
          `Cannot park task_management ${input.taskManagementId} in status ${task.status}`,
        );
      }

      await connection.query(
        `UPDATE task_management
         SET status = 'waiting_repo_confirmation',
             updated_at = NOW()
         WHERE id = ?`,
        [input.taskManagementId],
      );

      const [decisionResult] = await connection.query<mysql.ResultSetHeader>(
        `INSERT INTO router_decisions
         (ticket_id, task_management_id, outcome, decision_source, signals_json, scores_json,
          top1_repo_id, top1_score, top2_repo_id, top2_score, chosen_repo_id,
          selected_repo_ids_json, unsupported_repo_ids_json, blocking_reasons_json,
          llm_input_json, llm_output_json, llm_cost_usd,
          current_logic_result, current_logic_disposition, profile_versions_json,
          weights_version, extractor_schema_version, snapshot_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          plan.jiraKey,
          input.taskManagementId,
          plan.outcome,
          plan.decisionSource,
          JSON.stringify(plan.signals),
          JSON.stringify(
            plan.candidates.map((candidate) => ({
              repoId: candidate.repo.id,
              repoName: candidate.repo.repo_name,
              score: candidate.score,
              evidence: candidate.evidence,
            })),
          ),
          top1?.repo.id ?? null,
          top1?.score ?? null,
          top2?.repo.id ?? null,
          top2?.score ?? null,
          plan.selectedRepoIds[0] ?? null,
          JSON.stringify(plan.selectedRepoIds),
          JSON.stringify(plan.unsupportedRepoIds),
          JSON.stringify(plan.blockingReasons),
          llmInputJson,
          llmOutputJson,
          plan.totalLlmCostUsd ?? null,
          input.currentLogicResult === undefined
            ? null
            : JSON.stringify(input.currentLogicResult),
          input.currentLogicDisposition ?? null,
          JSON.stringify(plan.profileVersions),
          plan.weightsVersion,
          plan.extractorSchemaVersion,
          plan.snapshotHash,
        ],
      );
      const routerDecisionId = decisionResult.insertId;

      const [confirmationResult] =
        await connection.query<mysql.ResultSetHeader>(
          `INSERT INTO router_confirmations
           (ticket_id, task_management_id, router_decision_id, candidates_json, evidence_json, snapshot_hash, jira_comment_id)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            plan.jiraKey,
            input.taskManagementId,
            routerDecisionId,
            JSON.stringify(input.candidates),
            input.evidence === undefined
              ? null
              : JSON.stringify(input.evidence),
            input.snapshotHash,
            input.jiraCommentId ?? null,
          ],
        );

      await connection.commit();
      return {
        routerDecisionId,
        routerConfirmationId: confirmationResult.insertId,
      };
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * v3.5 P2 #2: backfill the task_management_id on a router_decisions row that
   * was persisted BEFORE task_management was created. We persist the router
   * decision first so that task-description generation or S3 upload failures
   * don't lose the routing attempt.
   */
  async updateRouterDecisionTaskManagementId(
    routerDecisionId: number,
    taskManagementId: number,
  ): Promise<void> {
    try {
      await this.getPool().query(
        `UPDATE router_decisions
         SET task_management_id = ?
         WHERE id = ?`,
        [taskManagementId, routerDecisionId],
      );
    } catch (error: any) {
      if (error?.code === "ER_NO_SUCH_TABLE") {
        return;
      }
      throw error;
    }
  }

  async getLatestRouterDecisionForTicket(
    ticketId: string,
  ): Promise<RouterDecisionRecord | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT *
       FROM router_decisions
       WHERE ticket_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [ticketId],
    );
    return rows.length > 0 ? (rows[0] as RouterDecisionRecord) : null;
  }

  async getLatestRouterDecisionForTaskManagement(
    taskManagementId: number,
  ): Promise<RouterDecisionRecord | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT *
       FROM router_decisions
       WHERE task_management_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [taskManagementId],
    );
    return rows.length > 0 ? (rows[0] as RouterDecisionRecord) : null;
  }

  async getLatestResolvedRouterConfirmationForTaskManagement(
    taskManagementId: number,
  ): Promise<RouterConfirmationRecord | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT *
       FROM router_confirmations
       WHERE task_management_id = ?
         AND resolved_at IS NOT NULL
       ORDER BY resolved_at DESC, id DESC
       LIMIT 1`,
      [taskManagementId],
    );
    return rows.length > 0 ? (rows[0] as RouterConfirmationRecord) : null;
  }

  async getRecentHistoricalTicketsForRouter(
    limit = 1000,
  ): Promise<HistoricalTicketRecord[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT ticket_id, text, routed_repo_id, included_reason, ticket_created_at AS created_at
       FROM historical_ticket_index
       WHERE included_reason IN ('merged_pr', 'explicit_confirmation', 'backfill_seed')
       ORDER BY COALESCE(ticket_created_at, created_at) DESC
       LIMIT ?`,
      [limit],
    );
    return rows as HistoricalTicketRecord[];
  }

  async upsertHistoricalTicketIndex(data: {
    ticketId: string;
    text: string;
    routedRepoId: number;
    disposition?: string | null;
    ticketCreatedAt?: Date | string | null;
    prFilesTouched?: string[];
    includedReason: "merged_pr" | "explicit_confirmation" | "backfill_seed";
  }): Promise<void> {
    await this.getPool().query(
      `INSERT INTO historical_ticket_index
       (ticket_id, text, routed_repo_id, disposition, ticket_created_at, pr_files_touched_json, included_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         text = VALUES(text),
         disposition = VALUES(disposition),
         ticket_created_at = VALUES(ticket_created_at),
         pr_files_touched_json = VALUES(pr_files_touched_json),
         updated_at = NOW()`,
      [
        data.ticketId,
        data.text,
        data.routedRepoId,
        data.disposition ?? null,
        data.ticketCreatedAt ?? null,
        data.prFilesTouched ? JSON.stringify(data.prFilesTouched) : null,
        data.includedReason,
      ],
    );
  }

  async getPrOpenRunsForMergedLearning(
    limit = 25,
  ): Promise<OneShotPrOpenRunForLearning[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT
         r.id,
         r.jira_key,
         r.repo_id,
         r.current_pr_url,
         r.created_at,
         cr.repo_name,
         cr.repo_url
       FROM oneshot_runs r
       JOIN code_repositories cr ON cr.id = r.repo_id
       LEFT JOIN historical_ticket_index h
         ON h.ticket_id = r.jira_key
        AND h.routed_repo_id = r.repo_id
        AND h.included_reason = 'merged_pr'
       WHERE r.state = 'pr_open'
         AND r.current_pr_url IS NOT NULL
         AND r.current_pr_url <> ''
         AND h.id IS NULL
       ORDER BY r.updated_at DESC
       LIMIT ?`,
      [limit],
    );
    return rows as OneShotPrOpenRunForLearning[];
  }

  /**
   * Get completed tasks pending JIRA posting
   */
  async getTasksPendingJiraPost(limit = 10): Promise<any[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM v_pending_jira_posts LIMIT ?",
      [limit],
    );
    return rows;
  }

  /**
   * Atomically claim a task for worker processing.
   * Uses UPDATE ... WHERE status='assigned' to prevent duplicate processing
   * when multiple worker containers are running for the same agent.
   * Returns true if claim succeeded (this worker owns it), false if already claimed.
   */
  async claimTaskForProcessing(tmId: number): Promise<boolean> {
    const [result] = await this.getPool().query<mysql.ResultSetHeader>(
      `UPDATE task_management
       SET status = 'in_progress', updated_at = NOW()
       WHERE id = ? AND status = 'assigned'`,
      [tmId],
    );
    return result.affectedRows === 1;
  }

  /**
   * Atomically claim a task for JIRA posting.
   * Uses UPDATE ... WHERE status='completed' to prevent double-posting.
   * Returns true if claim succeeded (this process owns it), false if already claimed.
   */
  async claimTaskForJiraPost(tmId: number): Promise<boolean> {
    const [result] = await this.getPool().query<mysql.ResultSetHeader>(
      `UPDATE task_management
       SET status = 'posting_to_jira', updated_at = NOW()
       WHERE id = ? AND status = 'completed'`,
      [tmId],
    );
    return result.affectedRows === 1;
  }

  /**
   * Release a claimed task back to 'completed' status on failure.
   * This allows it to be retried on the next cycle.
   */
  async releaseTaskClaim(tmId: number): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET status = 'completed', retry_count = retry_count + 1, updated_at = NOW()
       WHERE id = ? AND status = 'posting_to_jira'`,
      [tmId],
    );
  }

  /**
   * Reopen a completed task for Jira posting after its post retries were exhausted.
   * The agent result is already available, so this does not re-run the worker.
   */
  async resetTaskManagementJiraPostRetry(tmId: number): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET retry_count = 0,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = ? AND status = 'completed'`,
      [tmId],
    );
  }

  /**
   * Reset a failed/exhausted task for re-processing.
   * Used when an agent's FAILED label is removed to allow re-trigger.
   */
  async resetTaskManagementForRetrigger(tmId: number): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET status = 'failed',
           retry_count = 0,
           task_id = NULL,
           error_message = NULL,
           updated_at = NOW()
       WHERE id = ?`,
      [tmId],
    );
  }

  /**
   * Increment retry count
   */
  async incrementRetryCount(tmId: number): Promise<void> {
    await this.getPool().query(
      "UPDATE task_management SET retry_count = retry_count + 1, updated_at = NOW() WHERE id = ?",
      [tmId],
    );
  }

  async requeueTaskManagementAfterTransientFailure(
    tmId: number,
    errorMessage: string,
  ): Promise<void> {
    await this.getPool().query(
      `UPDATE task_management
       SET status = 'assigned',
           task_id = NULL,
           error_message = ?,
           retry_count = COALESCE(retry_count, 0) + 1,
           updated_at = NOW()
       WHERE id = ? AND status = 'in_progress'`,
      [errorMessage, tmId],
    );
  }

  // ============================================================================
  // VIEWS AND ANALYTICS
  // ============================================================================

  /**
   * Get active tasks with full details
   */
  async getActiveTasks(limit = 50): Promise<any[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM v_active_tasks LIMIT ?",
      [limit],
    );
    return rows;
  }

  /**
   * Get agent workload statistics
   */
  async getAgentWorkload(): Promise<any[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM v_agent_workload",
    );
    return rows;
  }

  // ============================================================================
  // CUSTOMER_BRANCHES TABLE
  // ============================================================================

  /**
   * Get customer branch by customer ID
   */
  async getCustomerBranchById(
    customerId: number,
  ): Promise<CustomerBranch | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM customer_branches WHERE id = ?",
      [customerId],
    );
    return rows.length > 0 ? (rows[0] as CustomerBranch) : null;
  }

  /**
   * Get customer branch by customer name
   */
  async getCustomerBranch(
    customerName: string,
  ): Promise<CustomerBranch | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM customer_branches WHERE customer = ?",
      [customerName],
    );
    return rows.length > 0 ? (rows[0] as CustomerBranch) : null;
  }

  /**
   * Get default customer branch
   */
  async getDefaultCustomerBranch(): Promise<CustomerBranch | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM customer_branches WHERE `default` = 1",
    );
    return rows.length > 0 ? (rows[0] as CustomerBranch) : null;
  }

  /**
   * Create new customer branch with the current platform default branch.
   */
  async createCustomerBranch(customerName: string): Promise<number> {
    const defaultBranch = "master";
    const [result] = await this.getPool().query<mysql.ResultSetHeader>(
      "INSERT INTO customer_branches (customer, branch, `default`) VALUES (?, ?, 0)",
      [customerName, defaultBranch],
    );
    logger.info(
      {
        customer: customerName,
        branch: defaultBranch,
      },
      "Created new customer branch",
    );
    return result.insertId;
  }

  /**
   * Get or create customer branch
   * Returns the branch name for a customer, creating with the default branch if not found.
   */
  async getOrCreateCustomerBranch(
    customerName: string,
  ): Promise<CustomerBranch> {
    // Try to find existing customer
    let customer = await this.getCustomerBranch(customerName);

    if (customer) {
      return customer;
    }

    // Customer not found - create with the default branch
    logger.info(
      {
        customer: customerName,
      },
      "Customer not found, creating new entry",
    );
    await this.createCustomerBranch(customerName);

    // Return the newly created entry
    customer = await this.getCustomerBranch(customerName);
    return customer!;
  }

  // ============================================================================
  // CODE_REPOSITORIES TABLE
  // ============================================================================

  /**
   * Get all code repositories
   */
  async getAllRepositories(): Promise<CodeRepository[]> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM code_repositories ORDER BY id",
    );
    return rows as CodeRepository[];
  }

  /**
   * Get repository by ID
   */
  async getRepositoryById(repoId: number): Promise<CodeRepository | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM code_repositories WHERE id = ?",
      [repoId],
    );
    return rows.length > 0 ? (rows[0] as CodeRepository) : null;
  }

  /**
   * Get repository by name
   */
  async getRepositoryByName(repoName: string): Promise<CodeRepository | null> {
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      "SELECT * FROM code_repositories WHERE repo_name = ?",
      [repoName],
    );
    return rows.length > 0 ? (rows[0] as CodeRepository) : null;
  }

  async upsertCodeRepository(input: {
    repoName: string;
    repoUrl: string;
    description: string;
    defaultBranch: string;
  }): Promise<CodeRepository> {
    const existingByName = await this.getRepositoryByName(input.repoName);
    if (existingByName) {
      await this.getPool().query<mysql.ResultSetHeader>(
        `UPDATE code_repositories
         SET repo_url = ?, description = ?, default_branch = ?
         WHERE id = ?`,
        [
          input.repoUrl,
          input.description,
          input.defaultBranch,
          existingByName.id,
        ],
      );
      const updated = await this.getRepositoryById(existingByName.id);
      if (updated) {
        return updated;
      }
    }

    const normalizedInputUrl = normalizeRepositoryUrlForLookup(input.repoUrl);
    const existingByUrl = (await this.getAllRepositories()).find(
      (repo) =>
        normalizeRepositoryUrlForLookup(repo.repo_url) === normalizedInputUrl,
    );
    if (existingByUrl) {
      return existingByUrl;
    }

    await this.getPool().query<mysql.ResultSetHeader>(
      `INSERT INTO code_repositories
       (repo_name, repo_url, description, default_branch)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         repo_url = VALUES(repo_url),
         description = VALUES(description),
         default_branch = VALUES(default_branch)`,
      [input.repoName, input.repoUrl, input.description, input.defaultBranch],
    );

    const repo = await this.getRepositoryByName(input.repoName);
    if (!repo) {
      throw new Error(`Failed to load upserted repository ${input.repoName}`);
    }
    return repo;
  }

  /**
   * Get repositories by IDs (from CSV string)
   */
  async getRepositoriesByIds(repoIds: number[]): Promise<CodeRepository[]> {
    if (repoIds.length === 0) return [];

    const placeholders = repoIds.map(() => "?").join(",");
    const [rows] = await this.getPool().query<mysql.RowDataPacket[]>(
      `SELECT * FROM code_repositories WHERE id IN (${placeholders})`,
      repoIds,
    );
    return rows as CodeRepository[];
  }

  /**
   * Get the default branch for a repository.
   * Prefer the branch stored in code_repositories. Fall back to the
   * compatibility map while older environments are still migrating.
   */
  getRepositoryDefaultBranch(repo: CodeRepository): string {
    return getInvestigationRepositoryDefaultBranchName({
      repoName: repo.repo_name,
      configuredDefaultBranch: repo.default_branch,
    });
  }

  /**
   * Determine whether a repository uses versioned customer branches
   * instead of a single shared main branch.
   */
  isVersionedRepository(repo: CodeRepository): boolean {
    return isInvestigationVersionedRepositoryName(repo.repo_name);
  }

  /**
   * Return candidate remote branch names for a repository/customer pair.
   * Migrated GitHub repos may still use legacy branch prefixes after the
   * provider move, so try both the historical prefix and the current repo slug.
   */
  getRepoBranchCandidates(
    repo: CodeRepository,
    customerBranch: CustomerBranch,
  ): string[] {
    return getInvestigationRepoBranchCandidatesForVersion({
      repoName: repo.repo_name,
      repoUrl: repo.repo_url,
      versionOrBranch: customerBranch.branch,
      defaultBranch: repo.default_branch,
    });
  }

  /**
   * Get repository branch name for a customer
   * Branch strategy is repository-specific, not provider-specific.
   * Single-branch repositories use their configured default branch; migrated monorepos may still use
   * versioned branch names such as medhok-monorepo-3.20.
   */
  getRepoBranchName(
    repo: CodeRepository,
    customerBranch: CustomerBranch,
  ): string {
    return (
      this.getRepoBranchCandidates(repo, customerBranch)[0] ||
      this.getRepositoryDefaultBranch(repo)
    );
  }
}

// Singleton instance
let dbInstance: Database | null = null;

/**
 * Get database instance (singleton)
 */
export function getDatabase(config?: DatabaseConfig): Database {
  if (!dbInstance) {
    dbInstance = new Database(config);
  }
  return dbInstance;
}

/**
 * Initialize database connection
 */
export async function initDatabase(config?: DatabaseConfig): Promise<Database> {
  const db = getDatabase(config);
  await db.connect();
  return db;
}

export { Database };
