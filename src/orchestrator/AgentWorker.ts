/**
 * AgentWorker - Base class for agents that poll task_management table
 *
 * Each agent extends this class and implements the `process()` method
 *
 * ## Task Lifecycle Stages (logged with lifecycle markers)
 *
 * 1. [POLL_START] - Begin polling for assigned tasks
 * 2. [TASK_FOUND] - Found task in task_management table
 * 3. [TASK_STATUS_UPDATE] - Status changed to 'in_progress'
 * 4. [TASK_S3_DOWNLOAD] - Download task description from S3
 * 5. [REPO_SETUP_START] - Begin repository workspace setup
 * 6. [REPO_CLONE] - Clone/update repository
 * 7. [WORKTREE_CREATE] - Create git worktree for branch
 * 8. [WORKSPACE_READY] - Customer workspace with symlinks ready
 * 9. [CONTEXT_BUILD] - Building additional context from database
 * 10. [TASK_CREATE] - Create task entry in tasks table
 * 11. [AGENT_PROCESS_START] - Hand off to agent-specific processing
 * 12. [AGENT_PROCESS_COMPLETE] - Agent processing completed
 * 13. [S3_UPLOAD] - Upload result to S3
 * 14. [TASK_COMPLETE] - Final status update
 *
 * All logs include correlationId for cross-service tracing.
 */

import {
  getDatabase,
  type CodeRepository,
  type Database,
  type RouterDecisionRecord,
  type TaskManagement,
} from "./database.js";
import { getStorage, type Storage } from "./storage.js";
import { getStatusServer, type StatusServer } from "./StatusServer.js";
import { TaskDescriptionGenerator } from "./TaskDescriptionGenerator.js";
import { withFilesystemLock } from "./filesystemLock.js";
import {
  buildDefaultBranchRefreshCommands,
  buildRemoteRefRefreshCommands,
  buildWorktreeCreateCommands,
  isExpectedWorktreeUpstream,
} from "./gitRepoSync.js";
import { classifyAgentFailure } from "./agentFailureTaxonomy.js";
import { getAgentFailedLabel } from "./agentDoneLabels.js";
import {
  MAX_TASK_PROCESSING_ATTEMPTS,
  willExhaustTaskProcessingAttempts,
} from "./agentRetryPolicy.js";
import { isOneShotRepoEnabled } from "../oneshot/repo-metadata.js";
import { buildQualifierConfirmationPlan } from "../oneshot/qualifier-confirmation-plan.js";
import { getGitHubRepoToken } from "../oneshot/github-app-auth.js";
import type {
  RoutingPlan,
  RouterTicketInput,
} from "../oneshot/repo-router/types.js";
import { createLogger } from "../utils/logger.js";
import { applyAgentModelToProcessEnv } from "../utils/agentModel.js";
import { exec } from "child_process";
import { promisify } from "util";
import * as fs from "fs/promises";
import * as path from "path";
import { EventEmitter } from "events";

const logger = createLogger("agent-worker");
const execAsync = promisify(exec);
const TRANSIENT_RETRY_AGENT_NAMES = new Set([
  "DARCI",
  "HERMES",
  "SCRIBE",
  "VERITAS",
]);
const DEFAULT_TRANSIENT_AGENT_MAX_RETRIES = MAX_TASK_PROCESSING_ATTEMPTS - 1;

/**
 * Agents that legitimately need to push to GitHub from within their Bash tool.
 *
 * Only agents in this set receive an authenticated `origin` URL in the EFS
 * repository clone. All other agents get their origin URL stripped of
 * credentials after clone/update, so that a runaway `git push` attempt fails
 * at authentication rather than relying on the Bash denylist alone.
 *
 * Currently only ANVIL (MP automation config YAML generator) pushes branches
 * and opens PRs via `git push -u origin` + `gh pr create`. OneShot providers
 * have their own workspace setup (src/oneshot/workspaces.ts) and are not
 * affected by this allowlist.
 *
 * Agent names are compared case-insensitively against `AgentWorkerConfig.agentName`.
 */
export const AGENTS_ALLOWED_TO_PUSH: ReadonlySet<string> = new Set(["ANVIL"]);

/**
 * Returns true if the given agent should keep an authenticated `origin` URL
 * on the shared repository clone. Defaults to false (credentials stripped).
 */
export function shouldUsePushAuth(
  agentName: string | undefined | null,
): boolean {
  if (!agentName) return false;
  return AGENTS_ALLOWED_TO_PUSH.has(agentName.toUpperCase());
}

/**
 * Strip embedded credentials (x-access-token:<token>@) from a GitHub HTTPS URL.
 */
export function stripCredentialsFromUrl(url: string): string {
  return url.replace(/https:\/\/[^@/]+@/, "https://");
}

function toFilesystemLockKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function isTransientAgentFailure(errorMessage: string): boolean {
  return classifyAgentFailure(errorMessage).retryable;
}

export function shouldRetryTransientAgentFailure(
  agentName: string,
  errorMessage: string | undefined | null,
  retryCount: number | undefined | null,
  maxRetries = DEFAULT_TRANSIENT_AGENT_MAX_RETRIES,
): boolean {
  const normalizedAgentName = agentName.toUpperCase();
  if ((retryCount ?? 0) >= maxRetries) {
    return false;
  }
  const classification = classifyAgentFailure(errorMessage ?? "");
  if (normalizedAgentName === "QUALIFIER") {
    return (
      classification.category === "provider_transient" &&
      classification.retryable
    );
  }
  if (!TRANSIENT_RETRY_AGENT_NAMES.has(normalizedAgentName)) {
    return false;
  }
  return classification.retryable;
}

export interface AgentWorkerConfig {
  agentName: string;
  pollingIntervalMs?: number;
  batchSize?: number;
  repositoryPath: string;
  /** Enable status server integration for real-time monitoring */
  enableStatusServer?: boolean;
}

export interface ProcessResult {
  success: boolean;
  output: string;
  error?: string;
  /**
   * Optional override for the final task_management.status. When provided,
   * AgentWorker uses this value instead of the default ('completed' on
   * success, 'failed' on failure). QUALIFIER uses this to leave a parked
   * task at 'waiting_repo_confirmation' so the materializer can pick it up.
   */
  taskManagementStatus?: TaskManagement["status"];
  metrics?: {
    totalTokens?: {
      input: number;
      output: number;
    };
    iterations?: number;
    cost?: number;
    costUsd?: number;
    durationMs?: number;
    tokensUsed?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    modelUsed?: string;
    provider?: string;
    qualifierOutcome?: Record<string, unknown>;
  };
}

/**
 * Base class for agent workers
 */
export abstract class AgentWorker {
  protected config: AgentWorkerConfig;
  private databaseInstance?: Database;
  private storageInstance?: Storage;
  protected agentId: number | null = null;
  protected agentModel: string = "";
  protected agentJiraToken: string = "";
  protected agentJiraUsername: string = "";
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private pollingTimer: NodeJS.Timeout | null = null;
  private consecutiveErrors: number = 0;
  private readonly MAX_BACKOFF_MS = 60000; // Max 1 minute backoff

  constructor(config: AgentWorkerConfig) {
    this.config = {
      pollingIntervalMs: 10000, // 10 seconds default
      batchSize: 1, // Process one at a time by default
      ...config,
    };
  }

  /**
   * Queue-backed workers need the platform database and object storage, while
   * direct execution paths can process a ticket without either dependency.
   * Resolve these services only when a queue lifecycle method uses them.
   */
  protected get db(): Database {
    this.databaseInstance ??= getDatabase();
    return this.databaseInstance;
  }

  protected set db(database: Database) {
    this.databaseInstance = database;
  }

  protected get storage(): Storage {
    this.storageInstance ??= getStorage();
    return this.storageInstance;
  }

  protected set storage(storage: Storage) {
    this.storageInstance = storage;
  }

  /**
   * Start the agent worker
   */
  async start(): Promise<void> {
    const startTime = Date.now();

    logger.info(
      {
        agent: this.config.agentName,
        repositoryPath: this.config.repositoryPath,
      },
      "[WORKER_START] Starting agent worker",
    );

    // Ensure database is connected
    logger.debug(
      { agent: this.config.agentName },
      "[DB_CONNECT] Connecting to database",
    );
    await this.db.connect();
    logger.info(
      { agent: this.config.agentName },
      "[DB_CONNECTED] Database connected",
    );

    // Get agent ID
    const agent = await this.db.getAgentByName(this.config.agentName);
    if (!agent) {
      logger.error(
        { agent: this.config.agentName },
        "[WORKER_ERROR] Agent not found in database",
      );
      throw new Error(`Agent not found: ${this.config.agentName}`);
    }
    this.agentId = agent.id;
    this.agentModel = agent.model;
    this.agentJiraToken = agent.jira_token || process.env.JIRA_TOKEN || "";
    this.agentJiraUsername =
      agent.jira_username || process.env.JIRA_USERNAME || "";

    applyAgentModelToProcessEnv(agent.model, {
      agentName: this.config.agentName,
    });

    if (!this.agentJiraToken || !this.agentJiraUsername) {
      logger.error(
        {
          agent: this.config.agentName,
          agentId: this.agentId,
          hasAgentToken: !!agent.jira_token,
          hasFallbackToken: !!process.env.JIRA_TOKEN,
          hasAgentUsername: !!agent.jira_username,
          hasFallbackUsername: !!process.env.JIRA_USERNAME,
        },
        "[WORKER_ERROR] JIRA credentials are not configured for agent worker",
      );
      throw new Error(
        `JIRA credentials are not configured for ${this.config.agentName}`,
      );
    }

    logger.info(
      {
        agent: this.config.agentName,
        agentId: this.agentId,
        model: agent.model,
        taskType: agent.task_type,
        jql: agent.jql,
        startupDurationMs: Date.now() - startTime,
      },
      "[WORKER_INITIALIZED] Agent worker initialized",
    );

    this.isRunning = true;

    // Start polling loop
    this.startPolling();

    logger.info(
      {
        agent: this.config.agentName,
        pollingInterval: this.config.pollingIntervalMs,
        batchSize: this.config.batchSize,
      },
      "[WORKER_POLLING] Agent worker started polling",
    );
  }

  /**
   * Stop the agent worker
   */
  async stop(): Promise<void> {
    logger.info({ agent: this.config.agentName }, "Stopping agent worker");

    this.isRunning = false;

    if (this.pollingTimer) {
      clearTimeout(this.pollingTimer);
      this.pollingTimer = null;
    }

    // Wait for any in-progress processing to complete
    if (this.isProcessing) {
      logger.info(
        {
          agent: this.config.agentName,
        },
        "Waiting for in-progress task to complete",
      );
      // Give up to 5 minutes for task to complete
      const maxWait = 300000;
      const startWait = Date.now();
      while (this.isProcessing && Date.now() - startWait < maxWait) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (this.isProcessing) {
        logger.warn(
          {
            agent: this.config.agentName,
          },
          "Task still processing after timeout, forcing stop",
        );
      }
    }

    logger.info({ agent: this.config.agentName }, "Agent worker stopped");
  }

  /**
   * Start polling loop
   */
  private startPolling(): void {
    // Run immediately
    this.schedulePoll();
  }

  /**
   * Schedule next poll with exponential backoff on errors
   */
  private schedulePoll(): void {
    if (!this.isRunning) return;

    // Calculate delay with exponential backoff
    const backoffDelay =
      this.consecutiveErrors > 0
        ? Math.min(
            this.config.pollingIntervalMs! *
              Math.pow(2, this.consecutiveErrors),
            this.MAX_BACKOFF_MS,
          )
        : this.config.pollingIntervalMs!;

    if (this.consecutiveErrors > 0) {
      logger.warn(
        {
          agent: this.config.agentName,
          consecutiveErrors: this.consecutiveErrors,
          backoffMs: backoffDelay,
        },
        "Polling with backoff due to errors",
      );
    }

    this.pollingTimer = setTimeout(
      async () => {
        if (!this.isRunning) return;

        // Prevent overlapping poll cycles
        if (this.isProcessing) {
          logger.debug(
            {
              agent: this.config.agentName,
            },
            "Skipping poll cycle - previous still processing",
          );
          this.schedulePoll();
          return;
        }

        this.isProcessing = true;
        try {
          await this.pollAndProcess();
          this.consecutiveErrors = 0; // Reset on success
        } catch (error) {
          this.consecutiveErrors++;
          logger.error(
            {
              agent: this.config.agentName,
              error,
              consecutiveErrors: this.consecutiveErrors,
            },
            "Error in polling loop",
          );
        } finally {
          this.isProcessing = false;
          this.schedulePoll(); // Schedule next poll
        }
      },
      this.pollingTimer ? backoffDelay : 0,
    ); // Run immediately first time
  }

  /**
   * Poll for assigned tasks and process them
   */
  private async pollAndProcess(): Promise<void> {
    if (!this.agentId) {
      logger.error(
        { agent: this.config.agentName },
        "[POLL_ERROR] Agent ID not set",
      );
      return;
    }

    logger.debug(
      {
        agent: this.config.agentName,
        agentId: this.agentId,
        batchSize: this.config.batchSize,
      },
      "[POLL_START] Polling for assigned tasks",
    );

    // Get assigned tasks
    const assignedTasks = await this.db.getAssignedTasksForAgent(
      this.agentId,
      this.config.batchSize!,
    );

    if (assignedTasks.length === 0) {
      logger.debug(
        {
          agent: this.config.agentName,
          agentId: this.agentId,
        },
        "[POLL_EMPTY] No assigned tasks found",
      );
      return;
    }

    logger.info(
      {
        agent: this.config.agentName,
        count: assignedTasks.length,
        jiraNumbers: assignedTasks.map((t) => t.jira_number),
      },
      "[TASK_FOUND] Found assigned tasks",
    );

    // Process each task
    for (const taskManagement of assignedTasks) {
      await this.processTask(taskManagement);
    }
  }

  /**
   * Process a single task
   *
   * This is the main orchestration method that coordinates:
   * - Task state management
   * - Repository setup
   * - Context building
   * - Agent execution
   * - Result storage
   */
  private async processTask(taskManagement: TaskManagement): Promise<void> {
    const jiraNumber = taskManagement.jira_number;
    const processStartTime = Date.now();
    let taskId: number | undefined;
    let workspaceCleaned = false;

    // Create correlation context for all logs in this task
    const logContext = {
      agent: this.config.agentName,
      jira: jiraNumber,
      tmId: taskManagement.id,
      customerId: taskManagement.customer_id,
      correlationId: `${this.config.agentName.toLowerCase()}-tm${taskManagement.id}-${jiraNumber}`,
    };

    logger.info(logContext, "[TASK_PROCESS_START] Beginning task processing");

    try {
      // Stage 1: Atomically claim the task (assigned → in_progress).
      // If another worker container already claimed it, skip silently.
      logger.debug(
        logContext,
        "[TASK_CLAIM] Attempting to claim task for processing",
      );
      const claimed = await this.db.claimTaskForProcessing(taskManagement.id);
      if (!claimed) {
        logger.info(
          logContext,
          "[TASK_CLAIM_SKIP] Task already claimed by another worker, skipping",
        );
        return;
      }
      logger.debug(logContext, "[TASK_CLAIMED] Task claimed successfully");

      if (
        this.config.agentName.toUpperCase() === "QUALIFIER" &&
        (!taskManagement.task_s3_bucket || !taskManagement.task_s3_key)
      ) {
        const shouldSkipPayload =
          await this.shouldSkipMissingQualifierPayloadGeneration(
            taskManagement,
            logContext,
          );
        if (!shouldSkipPayload) {
          logger.info(
            logContext,
            "[TASK_S3_GENERATE_AFTER_CONFIRMATION] Generating missing QUALIFIER task description after repo confirmation",
          );
          const generatedPayload = await this.generateAndPersistTaskDescription(
            taskManagement,
            logContext,
          );
          taskManagement.task_s3_bucket = generatedPayload.bucket;
          taskManagement.task_s3_key = generatedPayload.key;
        }
      }

      // Stage 2: Download task description from S3
      let taskDescription = `Process JIRA ${jiraNumber}`;
      if (taskManagement.task_s3_bucket && taskManagement.task_s3_key) {
        logger.info(
          {
            ...logContext,
            bucket: taskManagement.task_s3_bucket,
            key: taskManagement.task_s3_key,
          },
          "[TASK_S3_DOWNLOAD] Downloading task description from S3",
        );

        const downloadStart = Date.now();
        taskDescription = await this.storage.downloadResult(
          taskManagement.task_s3_bucket,
          taskManagement.task_s3_key,
        );

        logger.info(
          {
            ...logContext,
            downloadDurationMs: Date.now() - downloadStart,
            descriptionLength: taskDescription.length,
          },
          "[TASK_S3_DOWNLOADED] Task description downloaded",
        );
      } else {
        logger.warn(
          logContext,
          "[TASK_S3_MISSING] No task description in S3, using default",
        );
      }

      // Stage 3: Clone repositories and get customer workspace path
      logger.info(
        logContext,
        "[REPO_SETUP_START] Setting up repositories for task",
      );
      const repoSetupStart = Date.now();
      const customerWorkspace = await this.cloneRepositories(taskManagement);

      logger.info(
        {
          ...logContext,
          customerWorkspace,
          repoSetupDurationMs: Date.now() - repoSetupStart,
        },
        "[WORKSPACE_READY] Customer workspace ready",
      );

      // Stage 4: Build rich additional context from database
      logger.debug(logContext, "[CONTEXT_BUILD] Building additional context");
      const contextBuildStart = Date.now();
      const additionalContext = await this.buildAdditionalContext(
        taskManagement,
        customerWorkspace,
      );

      logger.debug(
        {
          ...logContext,
          contextLength: additionalContext.length,
          contextBuildDurationMs: Date.now() - contextBuildStart,
        },
        "[CONTEXT_BUILT] Additional context prepared",
      );

      // Stage 5: Create task entry in tasks table
      logger.debug(logContext, "[TASK_CREATE] Creating task entry in database");
      taskId = await this.db.createTask({
        task_type: this.config.agentName,
        task_description: taskDescription,
        status: "in_progress",
      });

      // Update correlation context with taskId
      const fullLogContext = {
        ...logContext,
        taskId,
      };

      // Update task_management with task_id
      await this.db.updateTaskManagementStatus(
        taskManagement.id,
        "in_progress",
        {
          task_id: taskId,
        },
      );

      logger.info(
        fullLogContext,
        "[TASK_CREATED] Task entry created in database",
      );

      // Stage 6: Create event emitter for status tracking
      const eventEmitter = this.createEventEmitter(
        `task-${taskId}`,
        jiraNumber,
      );

      // Stage 7: Call the agent-specific processing logic
      logger.info(
        {
          ...fullLogContext,
          workspace: customerWorkspace,
        },
        "[AGENT_PROCESS_START] Handing off to agent-specific processing",
      );

      const agentStartTime = Date.now();
      const result = await this.process(
        jiraNumber,
        taskId,
        taskDescription,
        additionalContext,
        customerWorkspace,
        eventEmitter,
      );
      const agentDurationMs = Date.now() - agentStartTime;

      logger.info(
        {
          ...fullLogContext,
          success: result.success,
          agentDurationMs,
          hasMetrics: !!result.metrics,
        },
        "[AGENT_PROCESS_COMPLETE] Agent processing completed",
      );

      // Stage 8: Handle result
      if (result.success) {
        // Upload result to S3
        logger.debug(fullLogContext, "[S3_UPLOAD] Uploading result to S3");
        const uploadStart = Date.now();
        const { bucket, key } = await this.storage.uploadResult(
          this.config.agentName,
          taskId,
          jiraNumber,
          result.output,
        );

        logger.info(
          {
            ...fullLogContext,
            bucket,
            key,
            outputLength: result.output.length,
            uploadDurationMs: Date.now() - uploadStart,
          },
          "[S3_UPLOADED] Result uploaded to S3",
        );

        // Extract metrics from result
        const tokensConsumed = result.metrics?.totalTokens
          ? `input:${result.metrics.totalTokens.input},output:${result.metrics.totalTokens.output}`
          : undefined;

        const cost = result.metrics?.cost
          ? result.metrics.cost.toFixed(4)
          : undefined;

        // Update task as completed with full metrics
        await this.db.updateTaskStatus(taskId, "completed", {
          result_s3_bucket: bucket,
          result_s3_key: key,
          metrics_json: result.metrics,
          tokens_consumed: tokensConsumed,
          cost: cost,
        });

        // Honor the worker's task_management status override when present
        // (QUALIFIER uses this for waiting_repo_confirmation parking so the
        // materializer can pick the task up later).
        const finalTaskManagementStatus =
          result.taskManagementStatus ?? "completed";
        await this.db.updateTaskManagementStatus(
          taskManagement.id,
          finalTaskManagementStatus,
        );

        const totalDurationMs = Date.now() - processStartTime;
        logger.info(
          {
            ...fullLogContext,
            tokensConsumed,
            cost,
            s3Bucket: bucket,
            s3Key: key,
            totalDurationMs,
            agentDurationMs,
          },
          "[TASK_COMPLETE] Task completed successfully",
        );
      } else {
        const failureMessage = result.error || "Unknown error";
        const parkedForRepoConfirmation =
          await this.parkQualifierTimeoutForRepoConfirmation(
            taskManagement,
            failureMessage,
            fullLogContext,
            taskId,
          );

        // Update task as failed
        const retryable = shouldRetryTransientAgentFailure(
          this.config.agentName,
          failureMessage,
          taskManagement.retry_count,
        );
        const failureTaxonomy = classifyAgentFailure(failureMessage);
        await this.db.updateTaskStatus(taskId, "failed", {
          error_message: failureMessage,
          metrics_json: {
            ...(result.metrics ?? {}),
            failureTaxonomy,
            retry: {
              retryable,
              retryCount: taskManagement.retry_count ?? 0,
              nextRetryCount: retryable
                ? (taskManagement.retry_count ?? 0) + 1
                : (taskManagement.retry_count ?? 0),
              agent: this.config.agentName,
            },
          },
        });

        if (parkedForRepoConfirmation) {
          const totalDurationMs = Date.now() - processStartTime;
          logger.warn(
            {
              ...fullLogContext,
              error: failureMessage,
              totalDurationMs,
              agentDurationMs,
            },
            "[TASK_PARKED_REPO_CONFIRMATION] QUALIFIER timed out; task is waiting for repo confirmation",
          );
          return;
        }

        if (retryable) {
          await this.cleanupTaskWorkspace(taskManagement.id, fullLogContext);
          workspaceCleaned = true;
          await this.db.requeueTaskManagementAfterTransientFailure(
            taskManagement.id,
            failureMessage,
          );
          const totalDurationMs = Date.now() - processStartTime;
          logger.warn(
            {
              ...fullLogContext,
              error: failureMessage,
              retryCount: taskManagement.retry_count ?? 0,
              nextRetryCount: (taskManagement.retry_count ?? 0) + 1,
              totalDurationMs,
              agentDurationMs,
            },
            "[TASK_REQUEUED_TRANSIENT_FAILURE] Agent transient failure requeued for another attempt",
          );
          return;
        }

        // Update task_management as failed — UNLESS the worker already
        // transitioned it to waiting_repo_confirmation as part of its
        // failure handling (atomic parking flow that surfaced an error).
        // Stomping that status would leave the parked task invisible to
        // the materializer.
        await this.markTaskManagementFailedUnlessParked(
          taskManagement.id,
          failureMessage,
          fullLogContext,
          taskManagement,
        );

        const totalDurationMs = Date.now() - processStartTime;
        logger.error(
          {
            ...fullLogContext,
            error: failureMessage,
            totalDurationMs,
            agentDurationMs,
          },
          "[TASK_FAILED] Task failed during agent processing",
        );
      }
    } catch (error: any) {
      const totalDurationMs = Date.now() - processStartTime;
      const failureMessage = error?.message || String(error);

      logger.error(
        {
          ...logContext,
          errorName: error.name,
          errorMessage: failureMessage,
          errorStack: error.stack,
          totalDurationMs,
        },
        "[TASK_ERROR] Unhandled error during task processing",
      );

      const parkedForRepoConfirmation =
        await this.parkQualifierTimeoutForRepoConfirmation(
          taskManagement,
          failureMessage,
          logContext,
          taskId,
        );
      if (parkedForRepoConfirmation) {
        if (taskId) {
          await this.db.updateTaskStatus(taskId, "failed", {
            error_message: failureMessage,
          });
        }
        logger.warn(
          {
            ...logContext,
            error: failureMessage,
            totalDurationMs,
          },
          "[TASK_ERROR_PARKED_REPO_CONFIRMATION] QUALIFIER timed out; task is waiting for repo confirmation",
        );
        return;
      }

      if (taskId) {
        const retryable = shouldRetryTransientAgentFailure(
          this.config.agentName,
          failureMessage,
          taskManagement.retry_count,
        );
        const failureTaxonomy = classifyAgentFailure(failureMessage);
        await this.db.updateTaskStatus(taskId, "failed", {
          error_message: failureMessage,
          metrics_json: {
            failureTaxonomy,
            retry: {
              retryable,
              retryCount: taskManagement.retry_count ?? 0,
              nextRetryCount: retryable
                ? (taskManagement.retry_count ?? 0) + 1
                : (taskManagement.retry_count ?? 0),
              agent: this.config.agentName,
            },
          },
        });
        if (retryable) {
          await this.cleanupTaskWorkspace(taskManagement.id, logContext);
          workspaceCleaned = true;
          await this.db.requeueTaskManagementAfterTransientFailure(
            taskManagement.id,
            failureMessage,
          );
          logger.warn(
            {
              ...logContext,
              error: failureMessage,
              retryCount: taskManagement.retry_count ?? 0,
              nextRetryCount: (taskManagement.retry_count ?? 0) + 1,
              totalDurationMs,
            },
            "[TASK_ERROR_REQUEUED_TRANSIENT_FAILURE] Agent thrown transient failure requeued for another attempt",
          );
          return;
        }
      }

      // Update task_management as failed (preserving an existing
      // waiting_repo_confirmation status so atomic-parking failures don't
      // get re-stomped).
      await this.markTaskManagementFailedUnlessParked(
        taskManagement.id,
        failureMessage,
        logContext,
        taskManagement,
      );
    } finally {
      // Clean up task-specific workspace to avoid accumulating directories
      if (!workspaceCleaned) {
        await this.cleanupTaskWorkspace(taskManagement.id, logContext);
      }
    }
  }

  private async generateAndPersistTaskDescription(
    taskManagement: TaskManagement,
    logContext: Record<string, any>,
  ): Promise<{ bucket: string; key: string }> {
    const generator = new TaskDescriptionGenerator({
      jiraBaseUrl: process.env.JIRA_BASE_URL,
      jiraUsername: this.agentJiraUsername || process.env.JIRA_USERNAME,
      jiraToken: this.agentJiraToken || process.env.JIRA_TOKEN,
      awsRegion: process.env.AWS_REGION,
      bedrockModel: process.env.BEDROCK_MODEL,
    });
    const taskGenStart = Date.now();
    const taskPayload = await generator.generateTaskPayloadFromTicketKey(
      taskManagement.jira_number,
      this.agentJiraToken,
    );
    const { taskDescription, ticketEvidence } = taskPayload;
    logger.info(
      {
        ...logContext,
        generationDurationMs: Date.now() - taskGenStart,
        descriptionLength: taskDescription.length,
      },
      "[TASK_S3_GENERATED_AFTER_CONFIRMATION] Task description generated",
    );

    const uploadStart = Date.now();
    const uploaded = await this.storage.uploadTaskDescription(
      taskManagement.jira_number,
      taskDescription,
    );
    if (ticketEvidence) {
      try {
        await this.storage.uploadTicketEvidence(
          taskManagement.jira_number,
          uploaded.key,
          ticketEvidence,
        );
      } catch (error) {
        logger.warn(
          {
            ...logContext,
            key: uploaded.key,
            error: error instanceof Error ? error.message : String(error),
          },
          "[TASK_S3_TICKET_EVIDENCE_UPLOAD_FAILED] Ticket evidence upload failed after task description upload; continuing with legacy task-description handoff",
        );
      }
    }
    await this.db.updateTaskManagementTaskPayload(
      taskManagement.id,
      uploaded.bucket,
      uploaded.key,
    );
    logger.info(
      {
        ...logContext,
        bucket: uploaded.bucket,
        key: uploaded.key,
        uploadDurationMs: Date.now() - uploadStart,
      },
      "[TASK_S3_GENERATED_AFTER_CONFIRMATION_UPLOADED] Task description uploaded",
    );
    return uploaded;
  }

  private async shouldSkipMissingQualifierPayloadGeneration(
    taskManagement: TaskManagement,
    logContext: Record<string, any>,
  ): Promise<boolean> {
    const latestDecision = await this.db.getLatestRouterDecisionForTicket(
      taskManagement.jira_number,
    );
    if (latestDecision?.outcome !== "unsupported") {
      return false;
    }

    logger.info(
      {
        ...logContext,
        routerDecisionId: latestDecision.id,
        routerOutcome: latestDecision.outcome,
      },
      "[TASK_S3_SKIP_UNSUPPORTED_REPO] Skipping QUALIFIER task payload generation for unsupported repo outcome",
    );
    return true;
  }

  private isQualifierWorker(): boolean {
    return this.config.agentName.toUpperCase() === "QUALIFIER";
  }

  private isQualifierSdkTimeout(
    errorMessage: string | undefined | null,
  ): boolean {
    return /SDK timeout after\s+600000ms/i.test(errorMessage ?? "");
  }

  /**
   * Transition task_management to 'failed' UNLESS the row is already in a
   * state we must preserve (e.g. waiting_repo_confirmation set by an
   * atomic parking transaction earlier in this same task run).
   *
   * Without this guard, a worker that successfully parked the task and
   * then threw an unrelated error during cleanup would have its parked
   * status stomped to 'failed', making the task invisible to the
   * RepoRouterConfirmationMaterializer.
   */
  private async markTaskManagementFailedUnlessParked(
    taskManagementId: number,
    errorMessage: string,
    logContext: Record<string, any>,
    taskManagement?: Pick<
      TaskManagement,
      "jira_number" | "retry_count" | "source"
    >,
  ): Promise<void> {
    let retryCount = taskManagement?.retry_count ?? 0;
    try {
      const current = await this.db.getTaskManagementById(taskManagementId);
      if (current?.status === "waiting_repo_confirmation") {
        logger.warn(
          {
            ...logContext,
            taskManagementId,
            error: errorMessage,
          },
          "[TASK_FAIL_PRESERVE_PARKED] Worker errored after parking; preserving waiting_repo_confirmation status",
        );
        return;
      }
      retryCount = current?.retry_count ?? 0;
    } catch (error) {
      logger.warn(
        {
          ...logContext,
          taskManagementId,
          error: error instanceof Error ? error.message : String(error),
        },
        "[TASK_FAIL_STATUS_LOOKUP_FAILED] Could not read task_management before marking failed; proceeding to fail-mark",
      );
    }

    const status = willExhaustTaskProcessingAttempts(retryCount)
      ? "failed_retries_exhausted"
      : "failed";
    await this.db.updateTaskManagementStatus(taskManagementId, status, {
      error_message: errorMessage,
      increment_retry_count: true,
    });

    if (status === "failed_retries_exhausted") {
      await this.addAgentFailedLabel(taskManagement, logContext);
    }
  }

  private async addAgentFailedLabel(
    taskManagement:
      | Pick<TaskManagement, "jira_number" | "retry_count" | "source">
      | undefined,
    logContext: Record<string, any>,
  ): Promise<void> {
    if (taskManagement?.source !== "jira") {
      return;
    }

    const failedLabel = getAgentFailedLabel(this.config.agentName);
    const jiraNumber = taskManagement.jira_number;
    const baseUrl = process.env.JIRA_BASE_URL?.trim().replace(/\/+$/, "");
    const jiraUsername = this.agentJiraUsername || process.env.JIRA_USERNAME;
    const jiraToken = this.agentJiraToken || process.env.JIRA_TOKEN;
    if (
      !failedLabel ||
      !jiraNumber ||
      !baseUrl ||
      !jiraUsername ||
      !jiraToken
    ) {
      logger.warn(
        {
          ...logContext,
          failedLabel,
          hasJiraNumber: !!jiraNumber,
          hasJiraBaseUrl: !!baseUrl,
          hasJiraUsername: !!jiraUsername,
          hasJiraToken: !!jiraToken,
        },
        "[TASK_FAILED_LABEL_SKIPPED] Could not add agent failed label because Jira configuration is incomplete",
      );
      return;
    }

    try {
      const response = await fetch(
        `${baseUrl}/rest/api/3/issue/${encodeURIComponent(jiraNumber)}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Basic ${Buffer.from(`${jiraUsername}:${jiraToken}`).toString("base64")}`,
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            update: {
              labels: [{ add: failedLabel }],
            },
          }),
        },
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `JIRA failed-label update failed: ${response.status} ${response.statusText} - ${errorText.substring(0, 200)}`,
        );
      }

      logger.info(
        {
          ...logContext,
          failedLabel,
        },
        "[TASK_FAILED_LABEL_ADDED] Added agent failed label after retry exhaustion",
      );
    } catch (error) {
      logger.warn(
        {
          ...logContext,
          failedLabel,
          error: error instanceof Error ? error.message : String(error),
        },
        "[TASK_FAILED_LABEL_WARN] Failed to add agent failed label; terminal DB state is preserved",
      );
    }
  }

  private async parkQualifierTimeoutForRepoConfirmation(
    taskManagement: TaskManagement,
    errorMessage: string,
    logContext: Record<string, any>,
    taskId?: number,
  ): Promise<boolean> {
    if (
      !this.isQualifierWorker() ||
      !this.isQualifierSdkTimeout(errorMessage)
    ) {
      return false;
    }

    const parkingMessage = `${errorMessage}. QUALIFIER timed out after 10 minutes; select the target repository to retry.`;

    let plan: RoutingPlan | null = null;
    let availableRepos: CodeRepository[] = [];
    try {
      const ticket = await this.fetchJiraIssueForRouting(
        taskManagement.jira_number,
      );
      availableRepos = await this.db.getAllRepositories();
      plan = buildQualifierConfirmationPlan({ ticket, availableRepos });
    } catch (error) {
      logger.warn(
        {
          ...logContext,
          error: error instanceof Error ? error.message : String(error),
        },
        "[QUALIFIER_TIMEOUT_REPO_CONFIRMATION_BUILD_FAILED] Could not build confirmation plan; aborting park",
      );
      return false;
    }

    if (plan.candidates.length === 0) {
      // No OneShot-enabled repos exist in the fleet — nothing for a human
      // to pick. Better to fail than to create an unresolvable parking row.
      logger.error(
        {
          ...logContext,
          jiraNumber: taskManagement.jira_number,
        },
        "[QUALIFIER_TIMEOUT_REPO_CONFIRMATION_NO_CANDIDATES] Zero enabled repos; refusing to park (will fail instead)",
      );
      return false;
    }

    const latestDecision = await this.db
      .getLatestRouterDecisionForTicket(taskManagement.jira_number)
      .catch(() => null);
    const candidates = await this.buildQualifierTimeoutRepoCandidates(
      taskManagement,
      latestDecision,
      plan,
      availableRepos,
    );

    try {
      const { routerDecisionId, routerConfirmationId } =
        await this.db.parkQualifierForRepoConfirmation({
          plan,
          candidates,
          evidence: [
            {
              type: "qualifier_timeout",
              detail: parkingMessage,
            },
          ],
          snapshotHash: plan.snapshotHash,
          taskManagementId: taskManagement.id,
          currentLogicResult: { reason: parkingMessage },
          currentLogicDisposition: "needs_confirmation",
        });

      if (taskId !== undefined) {
        // Atomic helper does NOT touch task_id or error_message — those
        // are AgentWorker concerns. Apply them in a follow-up update.
        await this.db.updateTaskManagementStatus(
          taskManagement.id,
          "waiting_repo_confirmation",
          {
            task_id: taskId,
            error_message: parkingMessage,
          },
        );
      }

      logger.warn(
        {
          ...logContext,
          routerDecisionId,
          routerConfirmationId,
          candidateRepoIds: candidates.map((candidate) => candidate.repoId),
        },
        "[QUALIFIER_TIMEOUT_REPO_CONFIRMATION] Parked QUALIFIER timeout for repo confirmation (atomic)",
      );
      return true;
    } catch (parkingError) {
      const parkingErrorMessage =
        parkingError instanceof Error
          ? parkingError.message
          : String(parkingError);
      logger.error(
        {
          ...logContext,
          error: parkingErrorMessage,
        },
        "[QUALIFIER_TIMEOUT_REPO_CONFIRMATION_FAILED] Atomic park failed; surfacing failure (will retry on next poll)",
      );
      // Critical: do NOT silently re-park (the prior code's bug). Atomic
      // helper rolled back, so task_management is in its prior status.
      // Returning false makes AgentWorker hit its normal failure path.
      return false;
    }
  }

  private async buildQualifierTimeoutRepoCandidates(
    taskManagement: TaskManagement,
    latestDecision: RouterDecisionRecord | null,
    freshPlan?: RoutingPlan,
    availableReposOverride?: CodeRepository[],
  ): Promise<
    Array<{
      repoId: number;
      repoName: string;
      score: number;
      evidence: unknown[];
    }>
  > {
    const availableRepos =
      availableReposOverride ?? (await this.db.getAllRepositories());
    const enabledRepos = availableRepos.filter(isOneShotRepoEnabled);
    const selectedRepoIds = this.getSelectedRepoIdsForTimeout(
      taskManagement,
      latestDecision,
      freshPlan,
    );
    const scoreByRepoId = new Map<
      number,
      { score: number; evidence: unknown[] }
    >();

    for (const candidate of freshPlan?.candidates ?? []) {
      scoreByRepoId.set(candidate.repo.id, {
        score: candidate.score,
        evidence: candidate.evidence,
      });
    }

    for (const score of this.parseJsonArray<{
      repoId?: number;
      score?: number;
      evidence?: unknown[];
    }>(latestDecision?.scores_json)) {
      if (!Number.isInteger(score.repoId)) {
        continue;
      }
      scoreByRepoId.set(Number(score.repoId), {
        score: typeof score.score === "number" ? score.score : 0,
        evidence: Array.isArray(score.evidence) ? score.evidence : [],
      });
    }

    return enabledRepos
      .map((repo) => {
        const scored = scoreByRepoId.get(repo.id);
        return {
          repoId: repo.id,
          repoName: repo.repo_name,
          score: scored?.score ?? 0,
          evidence: scored?.evidence ?? [],
        };
      })
      .sort((left, right) => {
        const leftSelected = selectedRepoIds.has(left.repoId) ? 1 : 0;
        const rightSelected = selectedRepoIds.has(right.repoId) ? 1 : 0;
        if (leftSelected !== rightSelected) {
          return rightSelected - leftSelected;
        }
        if (left.score !== right.score) {
          return right.score - left.score;
        }
        return left.repoName.localeCompare(right.repoName);
      });
  }

  private getSelectedRepoIdsForTimeout(
    taskManagement: TaskManagement,
    latestDecision: RouterDecisionRecord | null,
    freshPlan?: RoutingPlan,
  ): Set<number> {
    const selectedRepoIds = new Set<number>();
    for (const repoId of freshPlan?.selectedRepoIds ?? []) {
      if (Number.isInteger(repoId)) {
        selectedRepoIds.add(Number(repoId));
      }
    }

    for (const repoId of this.parseJsonArray<number>(
      latestDecision?.selected_repo_ids_json,
    )) {
      if (Number.isInteger(repoId)) {
        selectedRepoIds.add(Number(repoId));
      }
    }

    for (const raw of (taskManagement.related_code ?? "").split(",")) {
      const repoId = Number(raw.trim());
      if (Number.isInteger(repoId)) {
        selectedRepoIds.add(repoId);
      }
    }

    return selectedRepoIds;
  }

  private async fetchJiraIssueForRouting(
    issueKey: string,
  ): Promise<RouterTicketInput> {
    const jiraBaseUrl = process.env.JIRA_BASE_URL?.trim();
    const jiraUsername = this.agentJiraUsername || process.env.JIRA_USERNAME;
    const jiraToken = this.agentJiraToken || process.env.JIRA_TOKEN;
    if (!jiraBaseUrl || !jiraUsername || !jiraToken) {
      throw new Error(
        "Jira credentials are not configured for timeout routing",
      );
    }

    const authHeader = `Basic ${Buffer.from(
      `${jiraUsername}:${jiraToken}`,
    ).toString("base64")}`;
    const params = new URLSearchParams({
      expand: "names",
      fields: "*all",
    });
    const issueResponse = await fetch(
      `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Authorization: authHeader,
          Accept: "application/json",
        },
      },
    );
    if (!issueResponse.ok) {
      const errorText = await issueResponse.text().catch(() => "");
      throw new Error(
        `Failed to fetch Jira issue for timeout routing: ${issueResponse.status} ${issueResponse.statusText} ${errorText}`.trim(),
      );
    }

    const issue = (await issueResponse.json()) as RouterTicketInput;
    const comments = await this.fetchJiraCommentsForRouting(
      issueKey,
      jiraBaseUrl,
      authHeader,
    );
    issue.fields.comment = {
      comments,
      maxResults: comments.length,
      total: comments.length,
      startAt: 0,
    };
    return issue;
  }

  private async fetchJiraCommentsForRouting(
    issueKey: string,
    jiraBaseUrl: string,
    authHeader: string,
  ): Promise<unknown[]> {
    const comments: unknown[] = [];
    const pageSize = 100;
    let startAt = 0;

    while (true) {
      const params = new URLSearchParams({
        startAt: String(startAt),
        maxResults: String(pageSize),
        orderBy: "created",
      });
      const response = await fetch(
        `${jiraBaseUrl}/rest/api/3/issue/${encodeURIComponent(issueKey)}/comment?${params.toString()}`,
        {
          method: "GET",
          headers: {
            Authorization: authHeader,
            Accept: "application/json",
          },
        },
      );
      if (!response.ok) {
        logger.warn(
          {
            issueKey,
            status: response.status,
            statusText: response.statusText,
          },
          "[QUALIFIER_TIMEOUT_REPO_CONFIRMATION_COMMENTS_FAILED] Failed to fetch Jira comments for timeout routing",
        );
        return comments;
      }

      const page = (await response.json()) as {
        comments?: unknown[];
        startAt?: number;
        maxResults?: number;
        total?: number;
      };
      comments.push(...(Array.isArray(page.comments) ? page.comments : []));
      const currentStart = page.startAt ?? startAt;
      const currentMax = page.maxResults ?? pageSize;
      const total = page.total ?? comments.length;
      startAt = currentStart + currentMax;
      if (startAt >= total || currentMax <= 0) {
        break;
      }
    }

    return comments;
  }

  private parseJsonArray<T>(value: unknown): T[] {
    if (Array.isArray(value)) {
      return value as T[];
    }
    if (typeof value !== "string" || !value.trim()) {
      return [];
    }
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
      return [];
    }
  }

  /**
   * Clean up task-specific workspace after processing completes
   * This prevents accumulation of task directories on EFS
   */
  private async cleanupTaskWorkspace(
    taskId: number,
    logContext: Record<string, any>,
  ): Promise<void> {
    const taskWorkspace = `/mnt/efs/specter-repo/repositories/tasks/task-${taskId}`;

    try {
      // Remove the task-specific workspace directory
      await fs.rm(taskWorkspace, { recursive: true, force: true });
      logger.debug(
        {
          ...logContext,
          workspace: taskWorkspace,
        },
        "[WORKSPACE_CLEANUP_COMPLETE] Task workspace removed",
      );
    } catch (cleanupErr: any) {
      // Don't fail the task if cleanup fails - just log a warning
      logger.warn(
        {
          ...logContext,
          workspace: taskWorkspace,
          error: cleanupErr.message,
        },
        "[WORKSPACE_CLEANUP_FAILED] Could not remove task workspace",
      );
    }
  }

  /**
   * Clone repositories with git worktrees and create customer workspace with symlinks
   * Returns: Customer workspace path to use as agent repositoryPath
   *
   * Directory structure created:
   *   /mnt/efs/specter-repo/repositories/
   *     ├── core-app/                 (main folder = main branch)
   *     │   ├── 3.16/                 (worktree for branch 3.16)
   *     │   └── 3.20/                 (worktree for branch 3.20)
   *     ├── batch-jobs/               (main folder = main branch)
   *     │   └── 3.16/                 (worktree)
   *     └── tasks/
   *         └── Aetna_CP/             (customer workspace)
   *             ├── core-app -> ../../core-app/3.16       (symlink)
   *             └── batch-jobs -> ../../batch-jobs/3.16   (symlink)
   */
  private async cloneRepositories(
    taskManagement: TaskManagement,
  ): Promise<string> {
    const logContext = {
      agent: this.config.agentName,
      jira: taskManagement.jira_number,
      tmId: taskManagement.id,
    };

    if (!taskManagement.related_code) {
      logger.info(logContext, "[REPO_SKIP] No repositories specified in task");
      return this.config.repositoryPath;
    }

    const customer = await this.db.getCustomerBranchById(
      taskManagement.customer_id,
    );
    if (!customer) {
      logger.error(
        {
          ...logContext,
          customerId: taskManagement.customer_id,
        },
        "[REPO_ERROR] Customer not found",
      );
      throw new Error(`Customer not found: ${taskManagement.customer_id}`);
    }

    const repoIds = taskManagement.related_code
      .split(",")
      .map((id) => parseInt(id.trim()));
    const repos = await this.db.getRepositoriesByIds(repoIds);

    if (repos.length === 0) {
      logger.warn(
        {
          ...logContext,
          repoIds,
        },
        "[REPO_WARN] No repositories found for specified IDs",
      );
      return this.config.repositoryPath;
    }

    const sharedRepoBase = `/mnt/efs/specter-repo/repositories`;

    logger.info(
      {
        ...logContext,
        customer: customer.customer,
        branch: customer.branch,
        repoCount: repos.length,
        repoNames: repos.map((r) => r.repo_name),
        repoIds,
      },
      "[REPO_SETUP] Setting up repositories with worktrees",
    );

    // Ensure all repos have worktrees for this branch.
    // Returns the EFFECTIVE branch actually used per repo: the requested branch if it exists
    // on the remote, or the default branch as a fallback when the repo hasn't been branched yet.
    const effectiveBranchByRepo = new Map<string, string>();
    for (const repo of repos) {
      const effectiveBranch = await this.ensureRepoWithWorktree(repo, customer);
      effectiveBranchByRepo.set(repo.repo_name, effectiveBranch);
    }

    // Create task-specific workspace with symlinks
    // IMPORTANT: Use task ID to prevent race conditions when multiple agents work on same customer
    const customerWorkspace = path.join(
      sharedRepoBase,
      "tasks",
      `task-${taskManagement.id}`,
    );

    logger.debug(
      {
        ...logContext,
        customerWorkspace,
      },
      "[WORKSPACE_CREATE] Creating customer workspace directory",
    );

    // IMPORTANT: Clean up the workspace directory to remove stale symlinks from previous tasks
    // This ensures the agent only sees repos for THIS task, not leftover repos from past tasks
    try {
      const existingEntries = await fs.readdir(customerWorkspace, {
        withFileTypes: true,
      });
      for (const entry of existingEntries) {
        if (entry.isSymbolicLink()) {
          const linkPath = path.join(customerWorkspace, entry.name);
          await fs.unlink(linkPath);
          logger.debug(
            {
              ...logContext,
              symlink: entry.name,
            },
            "[WORKSPACE_CLEANUP] Removed stale symlink",
          );
        }
      }
    } catch (cleanupErr: any) {
      // Directory might not exist yet - that's fine
      if (cleanupErr.code !== "ENOENT") {
        logger.warn(
          {
            ...logContext,
            error: cleanupErr.message,
          },
          "[WORKSPACE_CLEANUP_WARN] Could not clean workspace",
        );
      }
    }

    await fs.mkdir(customerWorkspace, { recursive: true });

    // Create symlinks for each repo
    const symlinks: Array<{ repo: string; from: string; to: string }> = [];

    // IMPORTANT: Always add config directory for HERMES config lookups
    const configDir = path.join(sharedRepoBase, "config");
    const configLinkPath = path.join(customerWorkspace, "config");

    // Check if config directory exists before symlinking
    const configExists = await fs
      .access(configDir)
      .then(() => true)
      .catch(() => false);
    if (configExists) {
      // Remove old symlink if exists
      await fs.unlink(configLinkPath).catch(() => {});

      // Create symlink to config directory
      await fs.symlink("../../config", configLinkPath);

      symlinks.push({
        repo: "config",
        from: configLinkPath,
        to: "../../config",
      });

      logger.debug(
        {
          ...logContext,
          configDir,
          linkPath: configLinkPath,
        },
        "[SYMLINK_CONFIG] Config directory symlinked for HERMES",
      );
    } else {
      logger.warn(
        {
          ...logContext,
          configDir,
        },
        "[CONFIG_MISSING] Config directory not found - HERMES config lookups may fail",
      );
    }

    for (const repo of repos) {
      // Use the effective branch resolved during worktree setup.
      // If the versioned branch (e.g. 3.15) didn't exist on the remote, ensureRepoWithWorktree
      // fell back to the default branch for this repo — in that case the symlink must point to the
      // base repo folder (not a non-existent 3.15/ worktree directory).
      const effectiveBranch =
        effectiveBranchByRepo.get(repo.repo_name) ?? customer.branch;
      const defaultBranch = this.db.getRepositoryDefaultBranch(repo);
      const target =
        effectiveBranch === defaultBranch
          ? `../../${repo.repo_name}` // Base repo folder is the default branch
          : `../../${repo.repo_name}/${effectiveBranch}`; // Worktree folder

      const linkPath = path.join(customerWorkspace, repo.repo_name);

      // Remove old symlink if exists
      await fs.unlink(linkPath).catch(() => {});

      // Create new symlink
      await fs.symlink(target, linkPath);

      symlinks.push({
        repo: repo.repo_name,
        from: linkPath,
        to: target,
      });

      logger.debug(
        {
          ...logContext,
          repo: repo.repo_name,
          branch: customer.branch,
          linkPath,
          targetPath: target,
        },
        "[SYMLINK_CREATE] Symlink created",
      );
    }

    logger.info(
      {
        ...logContext,
        customer: customer.customer,
        workspace: customerWorkspace,
        repos: repos.map((r) => r.repo_name),
        symlinkCount: symlinks.length,
      },
      "[WORKSPACE_READY] Customer workspace ready with symlinks",
    );

    return customerWorkspace;
  }

  /**
   * Ensure repository has a worktree for the specified branch
   *
   * ## Clone Strategy (CRITICAL for DARCI)
   *
   * We use FULL CLONES (no --depth flag) because:
   * - DARCI needs `git blame` to find who introduced defective code
   * - DARCI needs `git log` to track history of changes
   * - DARCI needs `git diff master` to check if defect is fixed
   *
   * ## Git Worktree Benefits
   *
   * Worktrees SHARE the same .git history with the main clone:
   * ```
   * core-app/         # Main clone with .git/ (master)
   * ├── .git/         # FULL history - all commits, all branches
   * └── 3.16/         # Worktree - shares parent's .git!
   *     └── .git      # FILE pointing to: ../.git/worktrees/3.16
   * ```
   *
   * Result: `git blame`, `git log`, `git diff` all work in worktrees!
   *
   * Note: Some repos don't have versioned branches (Ai-agents, Document-ai, React-based-new-ui)
   *
   * ## Credential hygiene
   *
   * During setup, the orchestrator keeps `origin` authenticated so
   * clone/fetch/reset work against private repos. On the way out, for agents
   * NOT in `AGENTS_ALLOWED_TO_PUSH`, credentials are stripped from `origin` so
   * that if the agent's Bash tool tries to
   * `git push`, it fails at authentication instead of relying on the Bash
   * denylist alone. See `shouldUsePushAuth`.
   */
  private async ensureRepoWithWorktree(
    repo: any,
    customer: any,
  ): Promise<string> {
    const repoPath = `/mnt/efs/specter-repo/repositories/${repo.repo_name}`;
    const lockPath = path.join(
      "/mnt/efs/specter-repo/repositories/.locks",
      `${toFilesystemLockKey(repo.repo_name)}.lock`,
    );

    return withFilesystemLock(
      lockPath,
      async () => {
        try {
          return await this.ensureRepoWithWorktreeInner(repo, customer);
        } finally {
          // Defense-in-depth: for read-only agents, remove credentials from
          // `origin` before handing the repo to the agent. Orchestrator-side
          // setup above has already completed all needed network operations.
          if (!shouldUsePushAuth(this.config.agentName)) {
            try {
              const authUrl = await this.buildAuthUrl(repo);
              const unauthUrl = stripCredentialsFromUrl(authUrl);
              await execAsync(
                `cd "${repoPath}" && git remote set-url origin "${unauthUrl}"`,
              );
            } catch (err: any) {
              logger.warn(
                {
                  agent: this.config.agentName,
                  repo: repo.repo_name,
                  error: err?.message,
                },
                "[REPO_REMOTE_WARN] Failed to strip credentials from origin before agent run",
              );
            }
          }
        }
      },
      {
        owner: `${this.config.agentName}:${repo.repo_name}:${customer.branch}`,
        staleAfterMs: 10 * 60 * 1_000,
        heartbeatIntervalMs: 10_000,
        timeoutMs: 15 * 60 * 1_000,
        retryDelayMs: 1_000,
      },
    );
  }

  private async runGitCommandPlan(
    cwd: string,
    commands: string[],
    logContext: Record<string, any>,
    failureMarker: string,
  ): Promise<void> {
    for (const command of commands) {
      try {
        await execAsync(command, { cwd });
      } catch (err: any) {
        logger.error(
          {
            ...logContext,
            cwd,
            command,
            error: err?.message,
          },
          failureMarker,
        );
        throw err;
      }
    }
  }

  private async refreshDefaultBranchRepo(
    repoPath: string,
    defaultBranch: string,
    logContext: Record<string, any>,
  ): Promise<void> {
    await this.runGitCommandPlan(
      repoPath,
      buildDefaultBranchRefreshCommands(defaultBranch),
      logContext,
      "[REPO_DEFAULT_SYNC_FAILED] Failed to refresh default branch from origin",
    );
    logger.info(
      {
        ...logContext,
        repoPath,
        defaultBranch,
      },
      "[REPO_DEFAULT_SYNCED] Default branch refreshed from origin",
    );
  }

  private async resolveWorktreeRemoteRef(
    branchPath: string,
    branchCandidates: string[],
    logContext: Record<string, any>,
  ): Promise<string> {
    try {
      const { stdout } = await execAsync(
        "git rev-parse --abbrev-ref --symbolic-full-name @{u}",
        { cwd: branchPath },
      );
      const upstream = stdout.trim();
      if (isExpectedWorktreeUpstream(upstream, branchCandidates)) {
        return upstream;
      }
      logger.warn(
        {
          ...logContext,
          branchPath,
          upstream,
          branchCandidates,
        },
        "[WORKTREE_UPSTREAM_WARN] Worktree upstream does not match versioned branch candidates",
      );
    } catch (err: any) {
      logger.warn(
        {
          ...logContext,
          branchPath,
          error: err?.message,
        },
        "[WORKTREE_UPSTREAM_WARN] Could not determine worktree upstream",
      );
    }

    for (const candidateBranch of branchCandidates) {
      try {
        await execAsync(`git fetch --prune origin ${candidateBranch}`, {
          cwd: branchPath,
        });
        await execAsync(`git rev-parse --verify origin/${candidateBranch}`, {
          cwd: branchPath,
        });
        return `origin/${candidateBranch}`;
      } catch (err: any) {
        logger.warn(
          {
            ...logContext,
            branchPath,
            gitBranch: candidateBranch,
            error: err?.message,
          },
          "[WORKTREE_REMOTE_REF_WARN] Versioned branch candidate not found for existing worktree",
        );
      }
    }

    throw new Error(
      `Unable to resolve upstream remote ref for worktree ${branchPath}`,
    );
  }

  private async isUsableWorktreePath(
    branchPath: string,
    logContext: Record<string, any>,
  ): Promise<boolean> {
    const gitFilePath = path.join(branchPath, ".git");
    const hasGitFile = await fs
      .access(gitFilePath)
      .then(() => true)
      .catch(() => false);

    if (!hasGitFile) {
      logger.warn(
        {
          ...logContext,
          branchPath,
          gitFilePath,
        },
        "[WORKTREE_STALE_PATH] Existing branch path is missing .git metadata",
      );
      return false;
    }

    try {
      const { stdout } = await execAsync("git rev-parse --show-toplevel", {
        cwd: branchPath,
      });
      const topLevel = path.resolve(stdout.trim());
      const expectedTopLevel = path.resolve(branchPath);
      if (topLevel === expectedTopLevel) {
        return true;
      }

      logger.warn(
        {
          ...logContext,
          branchPath,
          topLevel,
          expectedTopLevel,
        },
        "[WORKTREE_STALE_PATH] Existing branch path resolves to a different Git worktree",
      );
      return false;
    } catch (err: any) {
      logger.warn(
        {
          ...logContext,
          branchPath,
          error: err?.message,
        },
        "[WORKTREE_STALE_PATH] Existing branch path is not a valid Git worktree",
      );
      return false;
    }
  }

  private async ensureRepoWithWorktreeInner(
    repo: any,
    customer: any,
  ): Promise<string> {
    const repoPath = `/mnt/efs/specter-repo/repositories/${repo.repo_name}`;
    const gitDir = path.join(repoPath, ".git");
    const defaultBranch = this.db.getRepositoryDefaultBranch(repo);

    const logContext = {
      agent: this.config.agentName,
      repo: repo.repo_name,
      customer: customer.customer,
      branch: customer.branch,
    };

    // Build authenticated URL for git operations
    const authUrl = await this.buildAuthUrl(repo);

    // Check if main repo is cloned
    const repoExists = await fs
      .access(gitDir)
      .then(() => true)
      .catch(() => false);

    // Defense-in-depth: only agents that legitimately push (e.g. ANVIL) should
    // see an authenticated `origin` URL when the agent's Bash tool runs. All
    // other agents get their `origin` URL stripped of credentials at the end
    // of this method, so that a runaway `git push` from within the Bash tool
    // fails at auth rather than relying on the Bash denylist alone. During the
    // orchestrator's own setup (clone/fetch/reset) below, `origin` remains
    // authenticated so private repos are reachable.
    const allowPushAuth = shouldUsePushAuth(this.config.agentName);

    if (!repoExists) {
      // First time - clone repository with FULL HISTORY (no --depth flag!)
      // This is REQUIRED for DARCI to run git blame, git log, etc.
      logger.info(
        {
          ...logContext,
          repoPath,
          allowPushAuth,
        },
        "[REPO_CLONE] Initializing repository with FULL clone (needed for DARCI git blame/log)",
      );

      await fs.mkdir(repoPath, { recursive: true });

      const cloneStart = Date.now();
      // IMPORTANT: No --depth flag! DARCI needs full history for git blame/log
      // Clone with auth (required for private repos). Credentials on `origin`
      // will be stripped at the end of this method for non-push agents.
      await execAsync(`git clone "${authUrl}" .`, { cwd: repoPath });

      logger.info(
        {
          ...logContext,
          repoPath,
          cloneDurationMs: Date.now() - cloneStart,
        },
        "[REPO_CLONED] Repository initialized",
      );
    } else {
      // IMPORTANT: Update remote URL with token for authenticated fetch/reset
      // below. The token may have been rotated or this is a fresh container.
      // If this is a read-only agent, credentials are stripped again at the
      // end of this method before returning.
      await execAsync(
        `cd "${repoPath}" && git remote set-url origin "${authUrl}"`,
      ).catch((err) => {
        logger.warn(
          {
            ...logContext,
            error: err.message,
          },
          "[REPO_AUTH_WARN] Failed to update remote URL with auth token",
        );
      });
    }

    // Repos that do not use customer-versioned branches always work from the
    // repository's configured default branch.
    const isSingleBranch = !this.db.isVersionedRepository(repo);

    if (
      isSingleBranch ||
      customer.branch === defaultBranch ||
      customer.branch === "master"
    ) {
      logger.debug(
        {
          ...logContext,
          reason: isSingleBranch ? "single-branch repo" : "default branch",
          repoPath,
        },
        "[REPO_MAIN] Using default-branch folder (no worktree needed)",
      );

      // Keep shared default-branch clones deterministic. `git pull` preserves
      // local drift and fails on dirty/diverged branches; workers need a clean
      // cache pinned to the remote branch before handing it to agent tooling.
      await this.refreshDefaultBranchRepo(repoPath, defaultBranch, logContext);
      return defaultBranch;
    }

    // For versioned branch repositories (core-app, batch-jobs, client-services, provider-portal)
    const branchPath = path.join(repoPath, customer.branch);
    let worktreeExists = await fs
      .access(branchPath)
      .then(() => true)
      .catch(() => false);

    if (
      worktreeExists &&
      !(await this.isUsableWorktreePath(branchPath, logContext))
    ) {
      logger.warn(
        {
          ...logContext,
          branchPath,
        },
        "[WORKTREE_STALE_PATH_REMOVED] Removing stale partial worktree path before recreate",
      );
      await fs.rm(branchPath, { recursive: true, force: true });
      worktreeExists = false;
    }

    if (!worktreeExists) {
      // Create worktree for this branch
      const branchCandidates = this.db.getRepoBranchCandidates(repo, customer);

      logger.info(
        {
          ...logContext,
          branchPath,
          gitBranchCandidates: branchCandidates,
        },
        "[WORKTREE_CREATE] Creating worktree for branch",
      );

      const worktreeStart = Date.now();

      // Step 1: Try candidate remote branches in order. Migrated GitHub repos may still
      // use legacy versioned prefixes after the provider move, so check both legacy and
      // repo-slug patterns before falling back to the default branch.
      let resolvedRemoteBranch: string | null = null;
      for (const candidateBranch of branchCandidates) {
        try {
          await execAsync(
            `cd "${repoPath}" && git fetch origin ${candidateBranch}`,
          );
          await execAsync(
            `cd "${repoPath}" && git rev-parse --verify origin/${candidateBranch}`,
          );
          resolvedRemoteBranch = candidateBranch;
          break;
        } catch (fetchErr: any) {
          logger.warn(
            {
              ...logContext,
              gitBranch: candidateBranch,
              error: fetchErr.message,
            },
            "[WORKTREE_FETCH_WARN] Versioned branch candidate not found on remote",
          );
        }
      }

      // Step 2: If no candidate exists, fall back to the default branch.
      if (!resolvedRemoteBranch) {
        // Fall back: refresh the default branch in the main repo folder and return it
        // so that the caller symlinks to the main repo folder instead of a worktree.
        logger.info(
          {
            ...logContext,
            requestedBranch: customer.branch,
            effectiveBranch: defaultBranch,
          },
          "[WORKTREE_FALLBACK] Using default branch for this repo",
        );

        await this.refreshDefaultBranchRepo(
          repoPath,
          defaultBranch,
          logContext,
        );
        return defaultBranch;
      }

      // Step 3: Create the worktree checked out at the remote-tracking ref.
      // If a prior failed run left only the local branch behind, reuse it
      // instead of failing with "a branch named ... already exists".
      await this.runGitCommandPlan(
        repoPath,
        buildWorktreeCreateCommands(
          resolvedRemoteBranch,
          customer.branch,
          `origin/${resolvedRemoteBranch}`,
        ),
        {
          ...logContext,
          branchPath,
          remoteRef: `origin/${resolvedRemoteBranch}`,
        },
        "[WORKTREE_CREATE_FAILED] Failed to create worktree",
      );

      logger.info(
        {
          ...logContext,
          branchPath,
          worktreeDurationMs: Date.now() - worktreeStart,
        },
        "[WORKTREE_CREATED] Worktree created",
      );

      return customer.branch;
    } else {
      // Worktree exists - update it (using authenticated remote from main repo)
      logger.debug(
        {
          ...logContext,
          branchPath,
        },
        "[WORKTREE_UPDATE] Updating existing worktree",
      );

      const remoteRef = await this.resolveWorktreeRemoteRef(
        branchPath,
        this.db.getRepoBranchCandidates(repo, customer),
        logContext,
      );
      await this.runGitCommandPlan(
        branchPath,
        buildRemoteRefRefreshCommands(remoteRef),
        {
          ...logContext,
          remoteRef,
        },
        "[WORKTREE_SYNC_FAILED] Failed to refresh worktree from origin",
      );
      logger.info(
        {
          ...logContext,
          branchPath,
          remoteRef,
        },
        "[WORKTREE_SYNCED] Worktree refreshed from origin",
      );

      return customer.branch;
    }
  }

  /**
   * Build authenticated Git URL
   */
  private async buildAuthUrl(repo: any): Promise<string> {
    const githubToken = await getGitHubRepoToken();
    return repo.repo_url.replace(
      "https://",
      `https://x-access-token:${encodeURIComponent(githubToken)}@`,
    );
  }

  /**
   * Build additional context from database metadata
   */
  private async buildAdditionalContext(
    taskManagement: TaskManagement,
    customerWorkspace: string,
  ): Promise<string> {
    const contextParts: string[] = [];

    try {
      // Get agent info for any agent-specific context
      const agent = await this.db.getAgentById(taskManagement.agent_id);
      if (agent?.additional_context) {
        contextParts.push(`## Agent Instructions\n${agent.additional_context}`);
      }

      // Get customer and branch information
      const customer = await this.db.getCustomerBranchById(
        taskManagement.customer_id,
      );
      if (customer) {
        contextParts.push(
          `## Customer Context\n` +
            `- **Customer**: ${customer.customer}\n` +
            `- **Code Branch**: ${customer.branch}\n` +
            `- **Workspace**: \`${customerWorkspace}\``,
        );
      }

      // Add DARCI-specific git context for branch-aware analysis
      if (this.config.agentName === "DARCI" && taskManagement.related_code) {
        const repoIds = taskManagement.related_code
          .split(",")
          .map((id) => parseInt(id.trim()));
        const repos = await this.db.getRepositoriesByIds(repoIds);
        if (repos.length > 0) {
          const primaryRepo = repos[0];
          const defaultBranch = this.db.getRepositoryDefaultBranch(primaryRepo);
          contextParts.push(
            `## Git Analysis Context\n` +
              `- **Default Branch**: \`${defaultBranch}\` (use for \`git diff\` to check if fix exists)\n` +
              `- **Git Provider**: GitHub\n\n` +
              `When checking if a defect is already fixed, use: \`git diff ${defaultBranch} -- <file>\``,
          );
        }
      }

      // Get repository information
      if (taskManagement.related_code) {
        const repoIds = taskManagement.related_code
          .split(",")
          .map((id) => parseInt(id.trim()));
        const repos = await this.db.getRepositoriesByIds(repoIds);

        if (repos.length > 0) {
          contextParts.push(
            `## Repositories Available\n` +
              `You have access to the following repositories via symlinks in your workspace.\n` +
              `All file paths are relative to your workspace root.\n\n` +
              repos
                .map((r) => {
                  const branchName = customer
                    ? this.db.getRepoBranchName(r, customer)
                    : this.db.getRepositoryDefaultBranch(r);
                  return (
                    `- **${r.repo_name}/**\n` +
                    `  - Description: ${r.description}\n` +
                    `  - Git Branch: \`${branchName}\`\n` +
                    `  - Access files using: \`${r.repo_name}/src/...\``
                  );
                })
                .join("\n\n") +
              `\n\n**Example tool calls:**\n` +
              `- read_file({ path: '${repos[0].repo_name}/src/main/java/com/medhok/...' })\n` +
              `- search_files({ path: '${repos[0].repo_name}', pattern: 'LoginService' })\n` +
              (this.config.agentName === "DARCI"
                ? `- git_analysis({ filePath: '${repos[0].repo_name}/src/...' })`
                : ""),
          );
        }
      }

      // Add config directory for HERMES
      if (this.config.agentName === "HERMES") {
        contextParts.push(
          `## Configuration Reference Files\n` +
            `You have access to configuration reference documentation:\n\n` +
            `- **config/**\n` +
            `  - Contains reference files for system variables, SLA configurations, and other settings\n` +
            `  - Check here first for configuration documentation\n` +
            `  - Access using: \`config/system_variables.md\`, \`config/sla_configs.md\`, etc.\n\n` +
            `**Example searches:**\n` +
            `- read_file({ path: 'config/system_variables.md' })\n` +
            `- search_files({ path: 'config', pattern: 'SLA' })\n` +
            `- grep({ path: 'config', pattern: 'your-setting-name' })`,
        );
      }

      // Add task type context
      if (taskManagement.task_type) {
        contextParts.push(`## Task Type\n${taskManagement.task_type}`);
      }
    } catch (error: any) {
      logger.warn(
        { error: error.message },
        "Failed to build additional context",
      );
    }

    return contextParts.length > 0 ? "\n\n" + contextParts.join("\n\n") : "";
  }

  /**
   * Create an event emitter for Phoenix that integrates with StatusServer
   * @param taskId - Task ID string for status tracking
   * @param jiraNumber - JIRA number for display
   * @returns EventEmitter to pass to Phoenix
   */
  protected createEventEmitter(
    taskId: string,
    jiraNumber?: string,
  ): EventEmitter {
    // If status server is not enabled, return a plain emitter
    if (!this.config.enableStatusServer) {
      return new EventEmitter();
    }

    try {
      const statusServer = getStatusServer();
      return statusServer.createEventBridge(
        taskId,
        this.config.agentName,
        jiraNumber,
      );
    } catch {
      // Status server not initialized, return plain emitter
      logger.debug("StatusServer not available, using plain EventEmitter");
      return new EventEmitter();
    }
  }

  /**
   * Process a task (implemented by subclasses)
   *
   * @param jiraNumber - JIRA ticket number (e.g., "PROJ-123")
   * @param taskId - Task ID in database
   * @param taskDescription - Full task description from S3 (markdown)
   * @param additionalContext - Rich context built from database (customer, repos, etc.)
   * @param repositoryPath - Customer workspace path with symlinks to repos
   * @param eventEmitter - Optional event emitter for status tracking
   * @returns Processing result with output markdown
   */
  protected abstract process(
    jiraNumber: string,
    taskId: number,
    taskDescription: string,
    additionalContext: string,
    repositoryPath: string,
    eventEmitter?: EventEmitter,
  ): Promise<ProcessResult>;

  /**
   * Get worker status
   */
  getStatus(): {
    agentName: string;
    agentId: number | null;
    isRunning: boolean;
    pollingInterval: number;
  } {
    return {
      agentName: this.config.agentName,
      agentId: this.agentId,
      isRunning: this.isRunning,
      pollingInterval: this.config.pollingIntervalMs!,
    };
  }
}
