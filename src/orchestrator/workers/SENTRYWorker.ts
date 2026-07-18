/**
 * SENTRYWorker - Polls for MySQL execution ticket review tasks
 *
 * Monitors database for SENTRY tasks, executes SQL review, uploads results to S3
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates SENTRYAgent and runs review
 * 4. Agent uses Claude CLI with Bedrock for LLM inference
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import {
  SENTRYAgent,
  type SENTRYReviewResult,
  type ChecklistCategory,
  type ChecklistItem,
} from "../../agents/sentry/index.js";
import { createLogger } from "../../utils/logger.js";
import type { EventEmitter } from "events";

const logger = createLogger("sentry-worker");

/**
 * SENTRY Worker - Safety & Execution eNtry Risk analYzer
 */
export class SENTRYWorker extends AgentWorker {
  constructor(repositoryPath: string, enableStatusServer: boolean = false) {
    super({
      agentName: "SENTRY",
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
      "[SENTRY_WORKER_INIT] SENTRYWorker initialized",
    );
  }

  /**
   * Process MySQL execution ticket review task
   *
   * Called by AgentWorker.processTask() after workspace setup is complete.
   * This is the agent-specific implementation that creates and runs SENTRY.
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

    // Create correlation context for all logs in this task
    const logContext = {
      jira: jiraNumber,
      taskId,
      repositoryPath,
      correlationId: `sentry-${taskId}-${jiraNumber}`,
    };

    logger.info(
      logContext,
      "[SENTRY_PROCESS_START] Starting MySQL ticket review",
    );
    logger.debug(
      {
        ...logContext,
        taskDescriptionLength: taskDescription.length,
        additionalContextLength: additionalContext.length,
        hasEventEmitter: !!eventEmitter,
      },
      "[SENTRY_PROCESS_CONTEXT] Task context details",
    );

    try {
      // Stage 1: Create agent with repository (usually core-app for HBM models)
      logger.info(
        logContext,
        "[SENTRY_AGENT_CREATE] Creating SENTRYAgent instance",
      );

      const agent = new SENTRYAgent({
        repositoryPath,
        onProgress: (msg) => {
          logger.debug(
            {
              ...logContext,
              progressMessage: msg,
            },
            "[SENTRY_PROGRESS] Agent progress update",
          );
        },
        eventEmitter,
      });

      logger.info(
        logContext,
        "[SENTRY_AGENT_CREATED] SENTRYAgent instance created successfully",
      );

      // Stage 2: Run review with task description as ticket text
      // Additional context may contain repo hints for HBM model lookup
      logger.info(logContext, "[SENTRY_REVIEW_START] Starting Claude review");
      const result = await agent.review(
        taskDescription,
        additionalContext || undefined,
      );

      const durationMs = Date.now() - startTime;

      // Stage 3: Process results
      if (result.success) {
        logger.info(
          {
            ...logContext,
            durationMs,
            toolCalls: result.metrics.toolCalls,
            tokensUsed: result.metrics.tokensUsed,
            costUsd: result.metrics.costUsd,
            hasStructuredOutput: !!result.structured,
            decision: result.structured?.risk_decision?.decision,
            riskLevel: result.structured?.risk_decision?.risk_level,
          },
          "[SENTRY_REVIEW_SUCCESS] Review completed successfully",
        );

        const output = this.formatOutput(jiraNumber, result);

        // Use actual cost from SDK if available, otherwise estimate
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
          "[SENTRY_REVIEW_FAILED] Review failed",
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
        "[SENTRY_PROCESS_ERROR] Unhandled error in SENTRY review",
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
   * Format review result as a minimal checklist + recommendation
   */
  private formatOutput(jiraNumber: string, result: SENTRYReviewResult): string {
    const riskDecision = result.structured?.risk_decision;
    const checklist = result.structured?.checklist;

    let passCount = 0;
    const failures: string[] = [];
    const warnings: string[] = [];
    const passes: string[] = [];

    checklist?.forEach((category) => {
      category.items.forEach((item: ChecklistItem) => {
        if (item.status === "PASS") {
          passCount++;
          passes.push(`- ✅ ${item.check}: ${item.note}`);
        } else if (item.status === "FAIL") {
          failures.push(`- ❌ ${item.check}: ${item.note}`);
        } else if (item.status === "WARN") {
          warnings.push(`- ⚠️ ${item.check}: ${item.note}`);
        }
      });
    });

    const decision = riskDecision?.decision ?? "NOT DETERMINED";
    const riskLevel = riskDecision?.risk_level ?? "UNKNOWN";
    const rationale = riskDecision?.risk_rationale ?? "";

    const isSafe = decision === "SAFE TO EXECUTE";
    const isConditional = decision === "EXECUTE WITH CONDITIONS";
    const isBlocked = decision === "NOT SAFE" || decision === "DO NOT EXECUTE";

    const decisionEmoji = isSafe
      ? "✅"
      : isConditional
        ? "⚠️"
        : isBlocked
          ? "🚫"
          : "❓";
    const riskEmoji =
      riskLevel === "LOW"
        ? "🟢"
        : riskLevel === "MED"
          ? "🟡"
          : riskLevel === "HIGH"
            ? "🔴"
            : "⚪";

    // Top 3 failures for the executive summary (warnings excluded — not blockers)
    const topBlockers = failures.slice(0, 3).join("\n");
    const moreCount =
      failures.length > 3
        ? `\n*...and ${failures.length - 3} more — see full checklist below*`
        : "";

    const warningRow =
      warnings.length > 0
        ? `| **Warnings** | ⚠️ ${warnings.length} checks |\n`
        : "";

    const executiveSummary = `---
## ⚡ DBA Executive Summary

| | |
|---|---|
| **Decision** | ${decisionEmoji} **${decision}** |
| **Risk Level** | ${riskEmoji} **${riskLevel}** |
| **Passed** | ✅ ${passCount} checks |
${warningRow}| **Failed** | ❌ ${failures.length} checks |
${rationale ? `\n> ${rationale}\n` : ""}${failures.length > 0 ? `\n**Top blockers:**\n${topBlockers}${moreCount}` : "\n✅ No blockers — all checks passed."}

---`;

    const failSection =
      failures.length > 0
        ? `\n**Failed checks:**\n${failures.join("\n")}\n`
        : "";

    const warnSection =
      warnings.length > 0
        ? `\n**Warnings** *(advisable to fix, not blocking)*:\n${warnings.join("\n")}\n`
        : "";

    const passSection =
      passes.length > 0
        ? `\n<details>\n<summary>✅ ${passCount} checks passed (click to expand)</summary>\n\n${passes.join("\n")}\n\n</details>\n`
        : `\n✅ ${passCount} checks passed\n`;

    const conditions = riskDecision?.conditions?.length
      ? "\n" +
        riskDecision.conditions
          .map((c: string, i: number) => `${i + 1}. ${c}`)
          .join("\n")
      : "";

    const correctedSection = this.buildCorrectedStatements(
      result.structured?.corrected_statements,
    );

    return `## SENTRY Review: ${jiraNumber}

${executiveSummary}
${passSection}${failSection}${warnSection}
---

**Recommendation: ${decisionEmoji} ${decision}**
${rationale ? `> ${rationale}\n` : ""}${conditions}
${correctedSection}
<sub>⏱️ ${(result.metrics.durationMs / 1000).toFixed(2)}s | 🔧 ${result.metrics.toolCalls} tool calls${result.metrics.costUsd ? ` | 💰 $${result.metrics.costUsd.toFixed(4)}` : ""} | 🤖 SENTRY v3.2</sub>
`;
  }

  /**
   * Build corrected statements section — only rendered when corrections exist
   */
  private buildCorrectedStatements(
    corrected?: NonNullable<
      SENTRYReviewResult["structured"]
    >["corrected_statements"],
  ): string {
    if (!corrected) return "";

    const {
      forward_sql,
      rollback_sql,
      preview_query,
      verification_query,
      changes_made,
    } = corrected;

    if (!forward_sql && !rollback_sql && !preview_query && !verification_query)
      return "";

    const parts: string[] = ["---\n\n## Suggested Corrections\n"];

    if (changes_made?.length) {
      parts.push("**What was changed:**");
      parts.push(changes_made.map((c) => `- ${c}`).join("\n"));
      parts.push("");
    }

    if (forward_sql) {
      parts.push("**Forward SQL**");
      parts.push("```sql\n" + forward_sql + "\n```");
    }

    if (rollback_sql) {
      parts.push("**Rollback SQL**");
      parts.push("```sql\n" + rollback_sql + "\n```");
    }

    if (preview_query) {
      parts.push("**Preview Query** *(run before executing)*");
      parts.push("```sql\n" + preview_query + "\n```");
    }

    if (verification_query) {
      parts.push("**Verification Query** *(run after executing)*");
      parts.push("```sql\n" + verification_query + "\n```");
    }

    return "\n" + parts.join("\n") + "\n";
  }
}
