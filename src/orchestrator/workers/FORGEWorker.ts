/**
 * FORGEWorker - Polls for MP job failure analysis tasks
 *
 * Monitors database for FORGE tasks, downloads .log attachments from JIRA,
 * runs failure root-cause analysis cross-referencing MP product repos,
 * uploads results to S3.
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates FORGEAgent and runs analyze()
 * 4. Agent downloads .log attachments, then uses Claude SDK for analysis
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import { FORGEAgent, type FORGEResult } from "../../agents/forge/index.js";
import { createLogger } from "../../utils/logger.js";
import type { EventEmitter } from "events";

const logger = createLogger("forge-worker");

/**
 * FORGE Worker - Failure Operations Root-cause Guidance Engine
 */
export class FORGEWorker extends AgentWorker {
  constructor(repositoryPath: string, enableStatusServer: boolean = false) {
    super({
      agentName: "FORGE",
      repositoryPath,
      pollingIntervalMs: 10000, // 10 seconds
      batchSize: 1,
      enableStatusServer,
    });

    logger.info(
      {
        repositoryPath,
        enableStatusServer,
        pollingIntervalMs: 10000,
      },
      "[FORGE_WORKER_INIT] FORGEWorker initialized",
    );
  }

  /**
   * Process MP job failure analysis task.
   *
   * Called by AgentWorker.processTask() after workspace setup is complete.
   * Creates FORGEAgent which downloads .log attachments then runs Claude SDK analysis.
   */
  protected async process(
    jiraNumber: string,
    taskId: number,
    taskDescription: string,
    additionalContext: string,
    repositoryPath: string,
    eventEmitter?: EventEmitter,
  ): Promise<ProcessResult> {
    const startTime = Date.now();

    const logContext = {
      jira: jiraNumber,
      taskId,
      repositoryPath,
      correlationId: `forge-${taskId}-${jiraNumber}`,
    };

    logger.info(
      logContext,
      "[FORGE_PROCESS_START] Starting MP job failure analysis",
    );
    logger.debug(
      {
        ...logContext,
        taskDescriptionLength: taskDescription.length,
        additionalContextLength: additionalContext.length,
        hasEventEmitter: !!eventEmitter,
      },
      "[FORGE_PROCESS_CONTEXT] Task context details",
    );

    try {
      logger.info(
        logContext,
        "[FORGE_AGENT_CREATE] Creating FORGEAgent instance",
      );

      const agent = new FORGEAgent({
        jiraUsername: this.agentJiraUsername,
        jiraToken: this.agentJiraToken,
        repositoryPath,
        onProgress: (msg) => {
          logger.debug(
            {
              ...logContext,
              progressMessage: msg,
            },
            "[FORGE_PROGRESS] Agent progress update",
          );
        },
        eventEmitter,
      });

      logger.info(
        logContext,
        "[FORGE_AGENT_CREATED] FORGEAgent instance created successfully",
      );

      logger.info(logContext, "[FORGE_ANALYZE_START] Starting FORGE analysis");
      const result = await agent.analyze(
        jiraNumber,
        additionalContext || undefined,
      );

      const durationMs = Date.now() - startTime;

      if (result.success) {
        logger.info(
          {
            ...logContext,
            durationMs,
            toolCalls: result.metrics.toolCalls,
            tokensUsed: result.metrics.tokensUsed,
            costUsd: result.metrics.costUsd,
            reportLength: result.report.length,
            errorCategory:
              result.structured?.root_cause?.error_category ?? "unknown",
            recommendedTeam:
              result.structured?.routing?.recommended_team ?? "unknown",
            errorsFound: result.structured?.summary?.total_errors ?? "unknown",
            logDownloadMs: result.metrics.logDownloadMs,
            analysisMs: result.metrics.analysisMs,
          },
          "[FORGE_ANALYZE_SUCCESS] Failure analysis completed successfully",
        );

        const output = this.formatOutput(jiraNumber, result);
        const actualCost =
          result.metrics.costUsd ??
          this.estimateCost(result.metrics.tokensUsed);

        return {
          success: true,
          output,
          metrics: {
            totalTokens: result.metrics.tokensUsed,
            iterations: result.metrics.toolCalls,
            cost: actualCost,
            durationMs,
          },
        };
      } else {
        logger.error(
          {
            ...logContext,
            durationMs,
            error: result.error,
          },
          "[FORGE_ANALYZE_FAILED] Failure analysis failed",
        );

        return {
          success: false,
          output: "",
          error: result.error || "Unknown error",
          metrics: {
            durationMs,
          },
        };
      }
    } catch (error: any) {
      const durationMs = Date.now() - startTime;

      logger.error(
        {
          ...logContext,
          durationMs,
          errorName: error.name,
          errorMessage: error.message,
          errorStack: error.stack,
        },
        "[FORGE_PROCESS_ERROR] Unhandled error in FORGE analysis",
      );

      return {
        success: false,
        output: "",
        error: error.message,
        metrics: {
          durationMs,
        },
      };
    }
  }

  /**
   * Estimate cost based on token usage (Claude Sonnet pricing via Bedrock)
   * Input: $0.003 per 1K tokens, Output: $0.015 per 1K tokens
   */
  private estimateCost(tokensUsed?: { input: number; output: number }): number {
    if (!tokensUsed) return 0;

    const inputCost = (tokensUsed.input / 1000) * 0.003;
    const outputCost = (tokensUsed.output / 1000) * 0.015;
    return inputCost + outputCost;
  }

  /**
   * Format analysis result as markdown for JIRA/S3
   */
  private formatOutput(jiraNumber: string, result: FORGEResult): string {
    const structured = result.structured;

    // Build summary section
    const parts: string[] = [];

    if (structured) {
      // Root cause badge
      const category = structured.root_cause?.error_category ?? "UNKNOWN";
      parts.push(`**Error Category:** \`${category}\``);

      if (structured.summary) {
        parts.push(
          `**Errors Found:** ${structured.summary.total_errors} (${structured.summary.critical_count} critical)`,
        );
        parts.push(`**Files Analyzed:** ${structured.summary.files_analyzed}`);
      }

      // Team routing
      if (structured.routing) {
        const team = structured.routing.recommended_team;
        const confidence = Math.round(structured.routing.confidence * 100);
        parts.push(
          `**Recommended Team:** \`${team}\` (${confidence}% confidence)`,
        );
      }

      // Proposed fix effort
      if (structured.proposed_fix?.estimated_effort) {
        parts.push(
          `**Estimated Effort:** ${structured.proposed_fix.estimated_effort}`,
        );
      }
    }

    const summarySection = parts.length > 0 ? parts.join("\n") : "";

    return `## FORGE Analysis: ${jiraNumber}

${result.report}

---

${summarySection ? `${summarySection}\n\n` : ""}<sub>⏱️ ${(result.metrics.durationMs / 1000).toFixed(2)}s (download: ${(result.metrics.logDownloadMs / 1000).toFixed(2)}s, analysis: ${(result.metrics.analysisMs / 1000).toFixed(2)}s) | 🔧 ${result.metrics.toolCalls} tool calls${result.metrics.costUsd ? ` | 💰 $${result.metrics.costUsd.toFixed(4)}` : ""} | 🤖 FORGE v1.0.0</sub>
`;
  }
}
