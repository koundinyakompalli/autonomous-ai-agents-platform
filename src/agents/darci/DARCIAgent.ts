/**
 * DARCI - Defect Analysis & Root Cause Identification
 *
 * Uses Claude Agent SDK to autonomously analyze software defects by:
 * - Searching and reading code files
 * - Investigating git history (git blame, log, diff)
 * - Identifying root causes and introducing commits
 * - Proposing fixes with before/after code
 *
 * ## Lifecycle
 * 1. [DARCI_INIT] - Agent created with repository path or ID
 * 2. [DARCI_REPO_REGISTER] - Repository registered in repo registry
 * 3. [DARCI_ANALYZE_START] - Analysis begins
 * 4. [DARCI_ANALYZE_COMPLETE] - Analysis finishes
 */

import {
  runAgent,
  getAgentPrompt,
  registerRepoFromPath,
  registerCustomerWorkspace,
  DARCI_OUTPUT_SCHEMA,
  type AgentResult,
  type AgentRunnerOptions,
  type ProgressUpdate,
} from "../../claude-sdk/index.js";
import { createLogger } from "../../utils/index.js";
import type { EventEmitter } from "events";
import path from "node:path";
import { buildDarciEvidencePack } from "./evidencePack.js";
import { buildQualityGateRetryContext } from "../shared/qualityGate.js";

const logger = createLogger("darci-agent");

const DARCI_ALLOWED_BASH_COMMAND_PATTERNS = [
  "^git\\s+(status|branch|rev-parse|merge-base|log|show|blame|diff|ls-files|grep)(\\s+[^;&|`$<>]*)?$",
  "^(pwd|ls|find|rg|grep|cat|sed|head|tail)(\\s+[^;&|`$<>]*)?$",
];

const DARCI_TOOL_BUDGET_TOOLS = ["Read", "Glob", "Grep", "Bash"];

function buildClaudeConfigDir(taskId: string): string {
  return path.join(
    process.env.CLAUDE_AGENT_CONFIG_BASE_DIR || "/tmp/specter-claude-sessions",
    "darci",
    taskId,
  );
}

export interface DARCIAgentOptions {
  /** Repository ID (registered in repo registry) - preferred */
  repoId?: string;

  /**
   * Repository path (legacy - will auto-register and create repoId)
   * Can be:
   * - A customer workspace with symlinks: /mnt/efs/specter-repo/repositories/tasks/CustomerName
   * - A direct git repository path: /mnt/efs/specter-repo/repositories/core-app
   */
  repositoryPath?: string;

  /** Optional event emitter for monitoring */
  eventEmitter?: EventEmitter;

  /** Optional progress callback */
  onProgress?: (message: string) => void;

  /** Timeout in milliseconds (default: 10 minutes) */
  timeoutMs?: number;

  /** Webhook URL for audit events */
  webhookUrl?: string;
}

export interface DARCIAnalysisResult {
  /** Whether analysis completed successfully */
  success: boolean;

  /** Full analysis text */
  analysis: string;

  /** Structured analysis data */
  structured?: {
    root_cause?: {
      summary: string;
      file_path?: string;
      line_numbers?: { start: number; end: number };
      code_snippet?: string;
    };
    introducing_commit?: {
      hash: string;
      author: string;
      date: string;
      message: string;
    };
    proposed_fix?: {
      description: string;
      before?: string;
      after?: string;
      file_path?: string;
    };
    testing_recommendations?: string[];
    confidence?: number;
    resolution_status?:
      | "root_cause_found"
      | "insufficient_evidence"
      | "fixed_on_default_branch"
      | "ambiguous";
    evidence?: Array<{
      file_path?: string;
      line_numbers?: string;
      finding: string;
    }>;
    hypotheses_rejected?: Array<{
      hypothesis: string;
      reason: string;
    }>;
    files_examined?: string[];
    verification?: string[];
  };

  /** Analysis metrics */
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
 * DARCI Agent - Defect Analysis & Root Cause Identification
 *
 * Uses Claude Agent SDK with Bedrock for autonomous defect analysis.
 *
 * @example
 * ```typescript
 * const agent = new DARCIAgent({
 *   repoId: 'my-project',
 * });
 *
 * const result = await agent.analyze('Users cannot login after password reset');
 * console.log(result.structured?.root_cause?.summary);
 * ```
 */
export class DARCIAgent {
  private options: DARCIAgentOptions;
  private repoId: string;
  private repoIds: string[] = [];
  private instanceId: string;

  constructor(options: DARCIAgentOptions) {
    this.instanceId = `darci-${Date.now()}`;

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

    logger.debug(logContext, "[DARCI_INIT] Creating DARCIAgent instance");

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
        "[DARCI_REPO_DIRECT] Using provided repoId",
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
          "[DARCI_WORKSPACE_REGISTER] Registering customer workspace",
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
          "[DARCI_WORKSPACE_REGISTERED] Customer workspace registered",
        );
      } else {
        // Direct git repository
        logger.debug(
          {
            ...logContext,
            repositoryPath: options.repositoryPath,
          },
          "[DARCI_REPO_REGISTER] Registering direct repository",
        );

        this.repoId = registerRepoFromPath(options.repositoryPath);
        this.repoIds = [this.repoId];

        logger.info(
          {
            ...logContext,
            repoId: this.repoId,
          },
          "[DARCI_REPO_REGISTERED] Direct repository registered",
        );
      }
    } else {
      logger.error(
        logContext,
        "[DARCI_INIT_ERROR] Missing repoId or repositoryPath",
      );
      throw new Error("DARCIAgent requires either repoId or repositoryPath");
    }
  }

  /**
   * Analyze a software defect
   *
   * @param defectDescription - Description of the defect to analyze
   * @param additionalContext - Optional additional context (stack traces, logs, etc.)
   * @returns Defect analysis result
   */
  async analyze(
    defectDescription: string,
    additionalContext?: string,
  ): Promise<DARCIAnalysisResult> {
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
        defectDescriptionLength: defectDescription.length,
        hasAdditionalContext: !!additionalContext,
        additionalContextLength: additionalContext?.length ?? 0,
      },
      "[DARCI_ANALYZE_START] Starting defect analysis",
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

      // Log tool usage periodically
      if (update.toolName) {
        logger.debug(
          {
            ...logContext,
            toolName: update.toolName,
            progressCount,
            elapsed: update.elapsed,
          },
          "[DARCI_TOOL_USE] Agent using tool",
        );
      }
    };

    try {
      const evidencePack = await buildDarciEvidencePack({
        repositoryPath: this.options.repositoryPath,
        defectDescription,
        additionalContext,
      });
      const enrichedAdditionalContext = [
        evidencePack,
        additionalContext?.trim()
          ? `## Original Additional Context\n${additionalContext.trim()}`
          : "",
      ]
        .filter(Boolean)
        .join("\n\n");

      logger.debug(
        {
          ...logContext,
          systemPromptPreview: getAgentPrompt("darci").substring(0, 100),
          evidencePackLength: evidencePack.length,
        },
        "[DARCI_RUN_AGENT] Calling runAgent",
      );

      const baseRunOptions: AgentRunnerOptions = {
        taskId,
        taskPrompt: defectDescription,
        repoIds: this.repoIds, // Use all resolved repos (for symlink workspaces)
        agentType: "darci",
        sdkStage: "darci_analysis",
        systemAppend: getAgentPrompt("darci"),
        additionalContext: enrichedAdditionalContext,
        permissionLevel: "analysis",
        webhookUrl: this.options.webhookUrl,
        timeoutMs: this.options.timeoutMs,
        maxTurns: 140,
        maxBudgetUsd: 12,
        includePartialMessages: true,
        idleTimeoutMs: 180_000,
        postToolIdleTimeoutMs: 90_000,
        toolIdleTimeoutMs: 600_000,
        sdkTraceMode: "failure",
        claudeConfigDir: buildClaudeConfigDir(taskId),
        allowedBashCommandPatterns: DARCI_ALLOWED_BASH_COMMAND_PATTERNS,
        bedrockConfig: {
          maxOutputTokens: 50_000,
          maxThinkingTokens: 2_048,
        },
        toolSprawlGuard: {
          enabled: true,
          maxRepeatedSearches: 2,
          maxBroadSearches: 4,
        },
        toolBudgetGuard: {
          enabled: true,
          tools: DARCI_TOOL_BUDGET_TOOLS,
          maxCalls: 120,
          message:
            "DARCI tool budget reached. Stop searching and return the strongest evidence-backed root-cause analysis now, including any uncertainty.",
        },
        onProgress,
        outputSchema: DARCI_OUTPUT_SCHEMA,
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
          "[DARCI_QUALITY_RETRY] Output failed quality gate; retrying once with narrower instructions",
        );

        result = await runAgent({
          ...baseRunOptions,
          taskId: `${taskId}-quality-retry`,
          sdkStage: "darci_quality_retry",
          maxTurns: 80,
          toolBudgetGuard: {
            ...baseRunOptions.toolBudgetGuard,
            maxCalls: 60,
            message:
              "DARCI quality retry tool budget reached. Return the structured evidence-backed answer now; if evidence is still missing, set resolution_status=insufficient_evidence.",
          },
          additionalContext: [
            enrichedAdditionalContext,
            buildQualityGateRetryContext({
              agentName: "DARCI",
              failureReason: firstQualityGate.reason ?? "quality gate failed",
              previousOutput: result.output,
              contractLines: [
                "Return structured JSON matching the DARCI schema.",
                "For root_cause_found or fixed_on_default_branch, cite a root_cause.file_path or evidence[].file_path.",
                "If evidence is insufficient, set resolution_status=insufficient_evidence and explain the missing evidence.",
                "Keep the final answer concise and evidence-first.",
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
            analysisLength: mappedResult.analysis.length,
          },
          "[DARCI_ANALYZE_SUCCESS] Defect analysis completed successfully",
        );
      } else {
        logger.warn(
          {
            ...logContext,
            durationMs,
            error: result.error,
          },
          "[DARCI_ANALYZE_FAILED] Defect analysis failed",
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
        "[DARCI_ANALYZE_ERROR] Exception during defect analysis",
      );

      return {
        success: false,
        analysis: "",
        metrics: {
          durationMs,
          toolCalls: 0,
        },
        error: errorMessage,
      };
    }
  }

  /**
   * Quick defect triage (faster, less thorough)
   */
  async quickTriage(defectDescription: string): Promise<DARCIAnalysisResult> {
    const taskId = `${this.instanceId}-triage-${Date.now()}`;

    const logContext = {
      instanceId: this.instanceId,
      taskId,
      repoId: this.repoId,
    };

    logger.info(
      {
        ...logContext,
        defectDescriptionLength: defectDescription.length,
      },
      "[DARCI_TRIAGE_START] Starting quick triage",
    );

    const startTime = Date.now();

    try {
      const result = await runAgent({
        taskId,
        taskPrompt: `Quick triage: ${defectDescription}`,
        repoIds: this.repoIds, // Use all resolved repos
        agentType: "darci",
        systemAppend:
          getAgentPrompt("darci") +
          "\n\nThis is a quick triage - focus on the most likely cause.",
        permissionLevel: "read_only",
        timeoutMs: 2 * 60 * 1000, // 2 minutes for quick triage
      });

      const durationMs = Date.now() - startTime;

      logger.info(
        {
          ...logContext,
          durationMs,
          success: result.success,
        },
        "[DARCI_TRIAGE_COMPLETE] Quick triage completed",
      );

      return this.mapResult(result);
    } catch (error) {
      const durationMs = Date.now() - startTime;

      logger.error(
        {
          ...logContext,
          durationMs,
          error: error instanceof Error ? error.message : "Unknown",
        },
        "[DARCI_TRIAGE_ERROR] Quick triage failed",
      );

      return {
        success: false,
        analysis: "",
        metrics: {
          durationMs,
          toolCalls: 0,
        },
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Map AgentResult to DARCIAnalysisResult
   */
  private mapResult(result: AgentResult): DARCIAnalysisResult {
    const mapped: DARCIAnalysisResult = {
      success: result.success,
      analysis: result.output,
      structured: result.structuredOutput as DARCIAnalysisResult["structured"],
      metrics: {
        durationMs: result.metrics.durationMs,
        toolCalls: result.metrics.toolCalls,
        tokensUsed: result.metrics.tokensUsed,
        costUsd: result.metrics.costUsd,
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
      | DARCIAnalysisResult["structured"]
      | undefined;
    if (!structured) {
      return { passed: false, reason: "missing structured output" };
    }
    if (structured?.resolution_status === "insufficient_evidence") {
      return { passed: true };
    }
    if (structured?.root_cause?.file_path) {
      return { passed: true };
    }
    if (structured?.evidence?.some((item) => item.file_path && item.finding)) {
      return { passed: true };
    }
    if (
      /[\w./-]+\.(java|ts|tsx|js|xml|sql|md|properties|ya?ml)(?::\d+)?/i.test(
        result.output,
      )
    ) {
      return { passed: true };
    }
    return { passed: false, reason: "missing evidence citations" };
  }
}

export default DARCIAgent;
