/**
 * ANVIL - MP Automation Config Generator
 *
 * Uses Claude Agent SDK to autonomously generate YAML configuration files
 * for the MP (MarketProminence) platform based on Jira ticket requirements.
 *
 * Supports:
 * - Single story processing (one automation request with ASD attachment)
 * - Epic processing (multiple child stories, two-phase: parallel mp_automation + consolidated file_copier)
 *
 * ## Lifecycle
 * 1. [ANVIL_INIT] - Agent created with repository path or ID
 * 2. [ANVIL_REPO_REGISTER] - Repository registered in repo registry
 * 3. [ANVIL_GENERATE_START] - Config generation begins
 * 4. [ANVIL_GENERATE_COMPLETE] - Config generation finishes
 */

import {
  runAgent,
  getAgentPrompt,
  registerRepoFromPath,
  ANVIL_OUTPUT_SCHEMA,
  type AgentResult,
  type ProgressUpdate,
} from "../../claude-sdk/index.js";
import { createLogger } from "../../utils/index.js";
import type { EventEmitter } from "events";

const logger = createLogger("anvil-agent");

export interface ANVILAgentOptions {
  /** Repository ID (registered in repo registry) - preferred */
  repoId?: string;

  /**
   * Repository path - path to mp-product-client-configs repo
   * This is the repo where config YAML files will be generated.
   */
  repositoryPath?: string;

  /** Optional event emitter for monitoring */
  eventEmitter?: EventEmitter;

  /** Optional progress callback */
  onProgress?: (message: string) => void;

  /** Timeout in milliseconds (default: 30 minutes) */
  timeoutMs?: number;

  /** Webhook URL for audit events */
  webhookUrl?: string;
}

export interface ANVILResult {
  /** Whether config generation completed successfully */
  success: boolean;

  /** Full output text */
  output: string;

  /** Structured result data */
  structured?: {
    ticket_type?: "epic" | "story";
    stories_processed?: number;
    configs_created?: Array<{
      file_path: string;
      product_type: string;
      job_type?: string;
      environment?: string;
      envid?: string;
      story_key?: string;
    }>;
    requirement_gaps?: Array<{
      field: string;
      description: string;
      assumed_value?: string;
      story_key?: string;
    }>;
    git_info?: {
      branch?: string;
      commits?: string[];
      pr_url?: string;
    };
    jira_comments_posted?: boolean;
    summary?: string;
  };

  /** Generation metrics */
  metrics: {
    durationMs: number;
    toolCalls: number;
    tokensUsed?: {
      input: number;
      output: number;
      cacheRead?: number;
      cacheWrite?: number;
    };
    costUsd?: number;
  };

  /** Error if failed */
  error?: string;
}

/**
 * ANVIL Agent - MP Automation Config Generator
 *
 * Uses Claude Agent SDK with Bedrock for autonomous config generation.
 * Operates on the mp-product-client-configs repository.
 *
 * @example
 * ```typescript
 * const agent = new ANVILAgent({
 *   repositoryPath: '/mnt/efs/specter-repo/repositories/mp-product-client-configs',
 * });
 *
 * const result = await agent.generateConfigs(taskDescription, additionalContext);
 * console.log(result.structured?.configs_created);
 * ```
 */
export class ANVILAgent {
  private options: ANVILAgentOptions;
  private repoId: string;
  private repoIds: string[] = [];
  private instanceId: string;

  constructor(options: ANVILAgentOptions) {
    this.instanceId = `anvil-${Date.now()}`;

    this.options = {
      timeoutMs: 30 * 60 * 1000, // 30 minutes default
      ...options,
    };

    const logContext = {
      instanceId: this.instanceId,
      hasRepoId: !!options.repoId,
      hasRepositoryPath: !!options.repositoryPath,
      timeoutMs: this.options.timeoutMs,
    };

    logger.debug(logContext, "[ANVIL_INIT] Creating ANVILAgent instance");

    // Resolve repoId from either repoId or repositoryPath
    if (options.repoId) {
      this.repoId = options.repoId;
      this.repoIds = [options.repoId];

      logger.info(
        {
          ...logContext,
          repoId: this.repoId,
        },
        "[ANVIL_REPO_DIRECT] Using provided repoId",
      );
    } else if (options.repositoryPath) {
      // Direct git repository (mp-product-client-configs)
      logger.debug(
        {
          ...logContext,
          repositoryPath: options.repositoryPath,
        },
        "[ANVIL_REPO_REGISTER] Registering config repository",
      );

      this.repoId = registerRepoFromPath(options.repositoryPath);
      this.repoIds = [this.repoId];

      logger.info(
        {
          ...logContext,
          repoId: this.repoId,
        },
        "[ANVIL_REPO_REGISTERED] Config repository registered",
      );
    } else {
      logger.error(
        logContext,
        "[ANVIL_INIT_ERROR] Missing repoId or repositoryPath",
      );
      throw new Error("ANVILAgent requires either repoId or repositoryPath");
    }
  }

  /**
   * Generate automation configs from a Jira ticket
   *
   * @param taskDescription - Jira ticket details (summary, description, issue type)
   * @param additionalContext - ASD file path, Jira credentials, etc.
   * @returns Config generation result
   */
  async generateConfigs(
    taskDescription: string,
    additionalContext?: string,
  ): Promise<ANVILResult> {
    const taskId = `${this.instanceId}-${Date.now()}`;
    const startTime = Date.now();

    const logContext = {
      instanceId: this.instanceId,
      taskId,
      repoId: this.repoId,
      repoIds: this.repoIds,
    };

    logger.info(
      {
        ...logContext,
        taskDescriptionLength: taskDescription.length,
        hasAdditionalContext: !!additionalContext,
        additionalContextLength: additionalContext?.length ?? 0,
      },
      "[ANVIL_GENERATE_START] Starting config generation",
    );

    // Build progress handler that emits events
    let progressCount = 0;
    const onProgress = (update: ProgressUpdate) => {
      progressCount++;

      if (this.options.onProgress) {
        const message = update.toolName
          ? `Using tool: ${update.toolName}`
          : (update.message ?? `Agent working... (${update.elapsed}ms)`);
        this.options.onProgress(message);
      }

      if (this.options.eventEmitter) {
        this.options.eventEmitter.emit("agent:progress", update);
      }

      if (update.toolName) {
        logger.debug(
          {
            ...logContext,
            toolName: update.toolName,
            progressCount,
            elapsed: update.elapsed,
          },
          "[ANVIL_TOOL_USE] Agent using tool",
        );
      }
    };

    try {
      logger.debug(
        {
          ...logContext,
          systemPromptPreview: getAgentPrompt("anvil").substring(0, 100),
        },
        "[ANVIL_RUN_AGENT] Calling runAgent",
      );

      const result = await runAgent({
        taskId,
        taskPrompt: taskDescription,
        repoIds: this.repoIds,
        agentType: "anvil",
        systemAppend: getAgentPrompt("anvil"),
        additionalContext,
        permissionLevel: "patch_proposal",
        allowWrite: true,
        webhookUrl: this.options.webhookUrl,
        timeoutMs: this.options.timeoutMs,
        onProgress,
        outputSchema: ANVIL_OUTPUT_SCHEMA,
      });

      const durationMs = Date.now() - startTime;
      const mappedResult = this.mapResult(result);

      if (result.success) {
        logger.info(
          {
            ...logContext,
            durationMs,
            toolCalls: result.metrics.toolCalls,
            progressUpdates: progressCount,
            hasStructuredOutput: !!mappedResult.structured,
            configsCreated:
              mappedResult.structured?.configs_created?.length ?? 0,
            gapsFound: mappedResult.structured?.requirement_gaps?.length ?? 0,
          },
          "[ANVIL_GENERATE_SUCCESS] Config generation completed successfully",
        );
      } else {
        logger.warn(
          {
            ...logContext,
            durationMs,
            error: result.error,
          },
          "[ANVIL_GENERATE_FAILED] Config generation failed",
        );
      }

      return mappedResult;
    } catch (error) {
      const durationMs = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      logger.error(
        {
          ...logContext,
          durationMs,
          errorMessage,
          errorStack: error instanceof Error ? error.stack : undefined,
        },
        "[ANVIL_GENERATE_ERROR] Exception during config generation",
      );

      return {
        success: false,
        output: "",
        metrics: {
          durationMs,
          toolCalls: 0,
        },
        error: errorMessage,
      };
    }
  }

  /**
   * Map AgentResult to ANVILResult
   */
  private mapResult(result: AgentResult): ANVILResult {
    return {
      success: result.success,
      output: result.output,
      structured: result.structuredOutput as ANVILResult["structured"],
      metrics: {
        durationMs: result.metrics.durationMs,
        toolCalls: result.metrics.toolCalls,
        tokensUsed: result.metrics.tokensUsed,
        costUsd: result.metrics.costUsd,
      },
      error: result.error,
    };
  }
}

export default ANVILAgent;
