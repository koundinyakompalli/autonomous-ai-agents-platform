/**
 * HERMES - Heuristic Engine for Rules, Modes, and Environment Settings
 *
 * Uses Claude Agent SDK to find and explain configuration settings by:
 * - Searching for configuration files
 * - Finding environment variables
 * - Explaining settings and their effects
 *
 * ## Lifecycle
 * 1. [HERMES_INIT] - Agent created with repository path or ID
 * 2. [HERMES_REPO_REGISTER] - Repository registered in repo registry
 * 3. [HERMES_LOOKUP_START] - Config lookup begins
 * 4. [HERMES_LOOKUP_COMPLETE] - Lookup finishes
 */

import {
  runAgent,
  getAgentPrompt,
  registerRepoFromPath,
  registerCustomerWorkspace,
  HERMES_OUTPUT_SCHEMA,
  type AgentResult,
  type AgentRunnerOptions,
  type ProgressUpdate,
} from "../../claude-sdk/index.js";
import { createLogger } from "../../utils/index.js";
import type { EventEmitter } from "events";
import path from "node:path";
import { buildHermesConfigIndex } from "./configIndex.js";
import { buildQualityGateRetryContext } from "../shared/qualityGate.js";

const logger = createLogger("hermes-agent");

const HERMES_ALLOWED_BASH_COMMAND_PATTERNS = [
  "^(pwd|ls|find|rg|grep|cat|sed|head|tail)(\\s+[^;&|`$<>]*)?$",
];

const HERMES_TOOL_BUDGET_TOOLS = ["Read", "Glob", "Grep", "Bash"];

function buildClaudeConfigDir(taskId: string): string {
  return path.join(
    process.env.CLAUDE_AGENT_CONFIG_BASE_DIR || "/tmp/specter-claude-sessions",
    "hermes",
    taskId,
  );
}

export interface HERMESAgentOptions {
  /** Repository ID (registered in repo registry) - preferred */
  repoId?: string;

  /**
   * Repository path (legacy - will auto-register and create repoId)
   * Can be a customer workspace with symlinks or a direct git repository
   */
  repositoryPath?: string;

  /** Optional event emitter */
  eventEmitter?: EventEmitter;

  /** Optional progress callback */
  onProgress?: (message: string) => void;

  /** Timeout in milliseconds (default: 10 minutes - same as DARCI) */
  timeoutMs?: number;

  /** Webhook URL for audit events */
  webhookUrl?: string;
}

export interface HERMESConfigResult {
  /** Whether lookup completed successfully */
  success: boolean;

  /** Full configuration explanation */
  configuration: string;

  /** Structured configuration data */
  structured?: {
    resolution_status?:
      | "found"
      | "not_found"
      | "ambiguous"
      | "runtime_value_unverified";
    configuration?: {
      name: string;
      type?: string;
      table_name?: string;
    };
    evidence?: Array<{
      source_path?: string;
      finding: string;
      precedence?: string;
    }>;
    location?: {
      hibernate_mapping?: string;
      java_model?: string;
      service?: string;
    };
    current_value?: {
      code?: string;
      str_value?: string;
      int_value?: number;
      client?: boolean;
      is_locked?: boolean;
    };
    description?: string;
    usage?: {
      service_layer?: string;
      referenced_by?: string[];
    };
    impact_analysis?: {
      if_changed?: string[];
      dependencies?: string[];
    };
    related_configurations?: Array<{
      name: string;
      relationship: string;
    }>;
    security?: {
      phi_pii?: boolean;
      hipaa_considerations?: string;
      access_control?: string;
    };
  };

  /** Lookup metrics */
  metrics: {
    durationMs: number;
    toolCalls: number;
    tokensUsed?: {
      input: number;
      output: number;
    };
  };

  /** Error if failed */
  error?: string;
}

/**
 * HERMES Agent - Configuration and Settings Lookup
 *
 * Uses Claude Agent SDK with Bedrock for autonomous configuration discovery.
 *
 * @example
 * ```typescript
 * const agent = new HERMESAgent({
 *   repoId: 'my-project',
 * });
 *
 * const result = await agent.findConfig('database connection timeout');
 * console.log(result.structured?.current_value);
 * ```
 */
export class HERMESAgent {
  private options: HERMESAgentOptions;
  private repoId: string;
  private repoIds: string[] = [];
  private instanceId: string;

  constructor(options: HERMESAgentOptions) {
    this.instanceId = `hermes-${Date.now()}`;

    this.options = {
      timeoutMs: 15 * 60 * 1000, // 15 minutes — HERMES is a config lookup
      ...options,
    };

    const logContext = {
      instanceId: this.instanceId,
      hasRepoId: !!options.repoId,
      hasRepositoryPath: !!options.repositoryPath,
      timeoutMs: this.options.timeoutMs,
    };

    logger.debug(logContext, "[HERMES_INIT] Creating HERMESAgent instance");

    // Resolve repoId from either repoId or repositoryPath
    if (options.repoId) {
      this.repoId = options.repoId;
      this.repoIds = [options.repoId];

      logger.info(
        {
          ...logContext,
          repoId: this.repoId,
          repoIds: this.repoIds,
        },
        "[HERMES_REPO_DIRECT] Using provided repoId",
      );
    } else if (options.repositoryPath) {
      // Check if this is a customer workspace with symlinks (contains /tasks/)
      if (options.repositoryPath.includes("/tasks/")) {
        // Customer workspace: register workspace + all symlinked repos
        logger.debug(
          {
            ...logContext,
            repositoryPath: options.repositoryPath,
          },
          "[HERMES_WORKSPACE_REGISTER] Registering customer workspace",
        );

        const result = registerCustomerWorkspace(options.repositoryPath);
        this.repoId = result.workspaceId;
        this.repoIds =
          result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];

        logger.info(
          {
            ...logContext,
            workspaceId: result.workspaceId,
            repoIds: this.repoIds,
            symlinkCount: result.repoIds.length,
          },
          "[HERMES_WORKSPACE_REGISTERED] Customer workspace registered",
        );
      } else {
        // Direct git repository
        logger.debug(
          {
            ...logContext,
            repositoryPath: options.repositoryPath,
          },
          "[HERMES_REPO_REGISTER] Registering direct repository",
        );

        this.repoId = registerRepoFromPath(options.repositoryPath);
        this.repoIds = [this.repoId];

        logger.info(
          {
            ...logContext,
            repoId: this.repoId,
          },
          "[HERMES_REPO_REGISTERED] Direct repository registered",
        );
      }
    } else {
      logger.error(
        logContext,
        "[HERMES_INIT_ERROR] Missing repoId or repositoryPath",
      );
      throw new Error("HERMESAgent requires either repoId or repositoryPath");
    }
  }

  /**
   * Find and explain a configuration setting
   *
   * @param query - What configuration to find
   * @param additionalContext - Optional additional context
   * @returns Configuration result
   */
  async findConfig(
    query: string,
    additionalContext?: string,
  ): Promise<HERMESConfigResult> {
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
        queryLength: query.length,
        hasAdditionalContext: !!additionalContext,
        additionalContextLength: additionalContext?.length ?? 0,
      },
      "[HERMES_LOOKUP_START] Starting configuration lookup",
    );

    // Build progress handler that emits events
    let progressCount = 0;
    const onProgress = (update: ProgressUpdate) => {
      progressCount++;

      if (this.options.onProgress) {
        const message = update.toolName
          ? `Searching: ${update.toolName}`
          : (update.message ?? `Looking up config... (${update.elapsed}ms)`);
        this.options.onProgress(message);
      }

      if (this.options.eventEmitter) {
        this.options.eventEmitter.emit("agent:progress", update);
      }

      // Log tool usage periodically
      if (update.toolName) {
        logger.debug(
          {
            ...logContext,
            toolName: update.toolName,
            progressCount,
            elapsed: update.elapsed,
          },
          "[HERMES_TOOL_USE] Agent using tool",
        );
      }
    };

    try {
      const configIndex = await buildHermesConfigIndex({
        repositoryPath: this.options.repositoryPath,
        query,
        additionalContext,
      });
      const enrichedAdditionalContext = [
        configIndex,
        additionalContext?.trim()
          ? `## Original Additional Context\n${additionalContext.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      logger.debug(
        {
          ...logContext,
          systemPromptPreview: getAgentPrompt("hermes").substring(0, 100),
          configIndexLength: configIndex.length,
        },
        "[HERMES_RUN_AGENT] Calling runAgent",
      );

      const baseRunOptions: AgentRunnerOptions = {
        taskId,
        taskPrompt: query, // Pass query directly, not wrapped
        repoIds: this.repoIds, // Use all resolved repos (for symlink workspaces)
        agentType: "hermes",
        sdkStage: "hermes_lookup",
        systemAppend: getAgentPrompt("hermes"),
        additionalContext: enrichedAdditionalContext,
        permissionLevel: "read_only", // HERMES needs Bash for filesystem exploration (ls/find/cat)
        webhookUrl: this.options.webhookUrl,
        timeoutMs: this.options.timeoutMs,
        maxTurns: 60,
        maxBudgetUsd: 5,
        includePartialMessages: true,
        idleTimeoutMs: 120_000,
        postToolIdleTimeoutMs: 60_000,
        toolIdleTimeoutMs: 300_000,
        sdkTraceMode: "failure",
        claudeConfigDir: buildClaudeConfigDir(taskId),
        allowedBashCommandPatterns: HERMES_ALLOWED_BASH_COMMAND_PATTERNS,
        bedrockConfig: {
          maxOutputTokens: 50_000,
          maxThinkingTokens: 2_048,
        },
        toolSprawlGuard: {
          enabled: true,
          maxRepeatedSearches: 2,
          maxBroadSearches: 3,
        },
        toolBudgetGuard: {
          enabled: true,
          tools: HERMES_TOOL_BUDGET_TOOLS,
          maxCalls: 60,
          message:
            "HERMES tool budget reached. Stop searching and return the best configuration answer from gathered evidence, marking ambiguity explicitly.",
        },
        onProgress,
        outputSchema: HERMES_OUTPUT_SCHEMA,
      };

      let result = await runAgent(baseRunOptions);
      const firstQualityGate = this.assessQuality(result);
      if (result.success && !firstQualityGate.passed) {
        logger.warn(
          {
            ...logContext,
            reason: firstQualityGate.reason,
            outputLength: result.output.length,
          },
          "[HERMES_QUALITY_RETRY] Output failed quality gate; retrying once with narrower instructions",
        );

        result = await runAgent({
          ...baseRunOptions,
          taskId: `${taskId}-quality-retry`,
          sdkStage: "hermes_quality_retry",
          maxTurns: 35,
          toolBudgetGuard: {
            ...baseRunOptions.toolBudgetGuard,
            maxCalls: 35,
            message:
              "HERMES quality retry tool budget reached. Return the structured configuration answer now; if runtime value is unverified, say so explicitly.",
          },
          additionalContext: [
            enrichedAdditionalContext,
            buildQualityGateRetryContext({
              agentName: "HERMES",
              failureReason: firstQualityGate.reason ?? "quality gate failed",
              previousOutput: result.output,
              contractLines: [
                "Return structured JSON matching the HERMES schema.",
                "For resolution_status=found, include configuration.name and at least one evidence[].source_path or location field.",
                "Use not_found, ambiguous, or runtime_value_unverified instead of guessing.",
                "Follow the source precedence from the deterministic config index.",
              ],
            }),
          ]
            .filter(Boolean)
            .join("\n\n"),
        });
      }

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
            configurationLength: mappedResult.configuration.length,
          },
          "[HERMES_LOOKUP_SUCCESS] Configuration lookup completed successfully",
        );
      } else {
        logger.warn(
          {
            ...logContext,
            durationMs,
            error: result.error,
          },
          "[HERMES_LOOKUP_FAILED] Configuration lookup failed",
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
        "[HERMES_LOOKUP_ERROR] Exception during configuration lookup",
      );

      return {
        success: false,
        configuration: "",
        metrics: {
          durationMs,
          toolCalls: 0,
        },
        error: errorMessage,
      };
    }
  }

  /**
   * Find environment variable definition
   */
  async findEnvVar(varName: string): Promise<HERMESConfigResult> {
    const query = `Find where environment variable ${varName} is defined and used`;
    return this.findConfig(query);
  }

  /**
   * List all configurations in a module
   */
  async listConfigs(moduleName: string): Promise<HERMESConfigResult> {
    const query = `List all configuration options for the ${moduleName} module`;
    return this.findConfig(query);
  }

  /**
   * Explain a feature flag
   */
  async explainFeatureFlag(flagName: string): Promise<HERMESConfigResult> {
    const query = `Find and explain the feature flag: ${flagName}`;
    return this.findConfig(query);
  }

  /**
   * Find database configuration
   */
  async findDatabaseConfig(): Promise<HERMESConfigResult> {
    return this.findConfig(
      "database connection configuration - host, port, credentials, pool settings",
    );
  }

  /**
   * Find API configuration
   */
  async findAPIConfig(): Promise<HERMESConfigResult> {
    return this.findConfig(
      "API configuration - base URL, timeouts, authentication",
    );
  }

  /**
   * Find system variable by code
   */
  async findSystemVariable(code: string): Promise<HERMESConfigResult> {
    return this.findConfig(`system_variables configuration with code: ${code}`);
  }

  /**
   * Find SLA configuration
   */
  async findSLAConfig(slaName?: string): Promise<HERMESConfigResult> {
    const query = slaName
      ? `Find SLA configuration for: ${slaName}`
      : "List all SLA configurations and their relationships";
    return this.findConfig(query);
  }

  /**
   * Map AgentResult to HERMESConfigResult
   */
  private mapResult(result: AgentResult): HERMESConfigResult {
    const mapped: HERMESConfigResult = {
      success: result.success,
      configuration: result.output,
      structured: result.structuredOutput as HERMESConfigResult["structured"],
      metrics: {
        durationMs: result.metrics.durationMs,
        toolCalls: result.metrics.toolCalls,
        tokensUsed: result.metrics.tokensUsed,
      },
      error: result.error,
    };
    const quality = this.assessQuality(result);
    if (mapped.success && !quality.passed) {
      return {
        ...mapped,
        success: false,
        error: `Analysis incomplete: ${quality.reason}`,
      };
    }
    return mapped;
  }

  private assessQuality(result: AgentResult): {
    passed: boolean;
    reason?: string;
  } {
    if (!result.success) {
      return { passed: true };
    }
    const structured = result.structuredOutput as
      | HERMESConfigResult["structured"]
      | undefined;
    if (!structured) {
      return { passed: false, reason: "missing structured output" };
    }
    if (
      structured?.resolution_status === "not_found" ||
      structured?.resolution_status === "ambiguous" ||
      structured?.resolution_status === "runtime_value_unverified"
    ) {
      return { passed: true };
    }
    if (!structured?.configuration?.name) {
      return { passed: false, reason: "missing configuration name" };
    }
    if (
      structured?.evidence?.some((item) => item.source_path && item.finding)
    ) {
      return { passed: true };
    }
    if (
      structured?.location?.hibernate_mapping ||
      structured?.location?.java_model ||
      structured?.location?.service
    ) {
      return { passed: true };
    }
    if (
      /[\w./-]+\.(md|java|xml|properties|ya?ml|sql)(?::\d+)?/i.test(
        result.output,
      )
    ) {
      return { passed: true };
    }
    return { passed: false, reason: "missing evidence sources" };
  }
}

export default HERMESAgent;
