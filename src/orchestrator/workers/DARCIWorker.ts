/**
 * DARCIWorker - Polls for defect analysis tasks
 *
 * Monitors database for DARCI tasks, executes analysis, uploads results to S3
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates DARCIAgent and runs analysis
 * 4. Agent uses Claude CLI with Bedrock for LLM inference
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import {
  DARCIAgent,
  type DARCIAnalysisResult,
} from "../../agents/darci/index.js";
import { createLogger } from "../../utils/logger.js";
import type { EventEmitter } from "events";

const logger = createLogger("darci-worker");

/**
 * DARCI Worker - Defect Analysis & Root Cause Identification
 */
export class DARCIWorker extends AgentWorker {
  constructor(repositoryPath: string, enableStatusServer: boolean = false) {
    super({
      agentName: "DARCI",
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
      "[DARCI_WORKER_INIT] DARCIWorker initialized",
    );
  }

  /**
   * Process defect analysis task
   *
   * Called by AgentWorker.processTask() after workspace setup is complete.
   * This is the agent-specific implementation that creates and runs DARCI.
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
      correlationId: `darci-${taskId}-${jiraNumber}`,
    };

    logger.info(logContext, "[DARCI_PROCESS_START] Starting defect analysis");
    logger.debug(
      {
        ...logContext,
        taskDescriptionLength: taskDescription.length,
        additionalContextLength: additionalContext.length,
        hasEventEmitter: !!eventEmitter,
      },
      "[DARCI_PROCESS_CONTEXT] Task context details",
    );

    try {
      // Stage 1: Create agent with customer-specific workspace
      logger.info(
        logContext,
        "[DARCI_AGENT_CREATE] Creating DARCIAgent instance",
      );

      const agent = new DARCIAgent({
        repositoryPath,
        onProgress: (msg) => {
          logger.debug(
            {
              ...logContext,
              progressMessage: msg,
            },
            "[DARCI_PROGRESS] Agent progress update",
          );
        },
        eventEmitter,
      });

      logger.info(
        logContext,
        "[DARCI_AGENT_CREATED] DARCIAgent instance created successfully",
      );

      // Stage 2: Run analysis with task description and additional context separately
      // This allows the agent to properly pass additionalContext to runAgent
      logger.info(
        logContext,
        "[DARCI_ANALYSIS_START] Starting Claude analysis",
      );
      const result = await agent.analyze(taskDescription, additionalContext);

      const durationMs = Date.now() - startTime;

      // Stage 4: Process results
      if (result.success) {
        logger.info(
          {
            ...logContext,
            durationMs,
            toolCalls: result.metrics.toolCalls,
            tokensUsed: result.metrics.tokensUsed,
            costUsd: result.metrics.costUsd,
            hasStructuredOutput: !!result.structured,
          },
          "[DARCI_ANALYSIS_SUCCESS] Analysis completed successfully",
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
            iterations: result.metrics.toolCalls, // Tool calls as proxy for iterations
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
          "[DARCI_ANALYSIS_FAILED] Analysis failed",
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
        "[DARCI_PROCESS_ERROR] Unhandled error in DARCI analysis",
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
   * Format analysis result as markdown
   */
  private formatOutput(
    jiraNumber: string,
    result: DARCIAnalysisResult,
  ): string {
    // Safely access structured output fields (may use snake_case from schema)
    const structured = result.structured;
    const rootCause = structured?.root_cause;
    const introducingCommit = structured?.introducing_commit;
    const proposedFix = structured?.proposed_fix;
    const testingRecommendations = structured?.testing_recommendations;
    const evidence = structured?.evidence ?? [];
    const hypothesesRejected = structured?.hypotheses_rejected ?? [];

    return `# DARCI Analysis for ${jiraNumber}

## Defect Analysis & Root Cause Identification

${result.analysis}

${
  structured
    ? `
## Structured Output

${
  structured.resolution_status
    ? `
### Resolution Status
${structured.resolution_status}
`
    : ""
}

### Root Cause
${rootCause?.summary || "Not identified"}

${rootCause?.file_path ? `**File**: \`${rootCause.file_path}\`${rootCause.line_numbers ? ` (lines ${rootCause.line_numbers.start}-${rootCause.line_numbers.end})` : ""}` : ""}

${
  rootCause?.code_snippet
    ? `
### Problematic Code
\`\`\`
${rootCause.code_snippet}
\`\`\`
`
    : ""
}

${
  introducingCommit
    ? `
### Introducing Commit
- **Hash**: \`${introducingCommit.hash}\`
- **Author**: ${introducingCommit.author}
- **Date**: ${introducingCommit.date}
- **Message**: ${introducingCommit.message}
`
    : "### Introducing Commit\nNot found"
}

${
  proposedFix
    ? `
### Proposed Fix
${proposedFix.description}

${proposedFix.file_path ? `**File**: \`${proposedFix.file_path}\`` : ""}

${
  proposedFix.before
    ? `
**Before:**
\`\`\`
${proposedFix.before}
\`\`\`
`
    : ""
}

${
  proposedFix.after
    ? `
**After:**
\`\`\`
${proposedFix.after}
\`\`\`
`
    : ""
}
`
    : "### Proposed Fix\nSee analysis above"
}

${
  evidence.length > 0
    ? `
### Evidence
${evidence
  .map((item) => {
    const source = item.file_path
      ? `\`${item.file_path}${item.line_numbers ? `:${item.line_numbers}` : ""}\``
      : "Unspecified source";
    return `- ${source}: ${item.finding}`;
  })
  .join("\n")}
`
    : ""
}

${
  hypothesesRejected.length > 0
    ? `
### Hypotheses Rejected
${hypothesesRejected.map((item) => `- **${item.hypothesis}**: ${item.reason}`).join("\n")}
`
    : ""
}

${
  testingRecommendations && testingRecommendations.length > 0
    ? `
### Testing Recommendations
${testingRecommendations.map((rec: string) => `- ${rec}`).join("\n")}
`
    : ""
}

${
  structured.confidence !== undefined
    ? `
### Confidence Score
${(structured.confidence * 100).toFixed(0)}%
`
    : ""
}
`
    : ""
}

## Metrics

- **Duration**: ${(result.metrics.durationMs / 1000).toFixed(2)}s
- **Tool Calls**: ${result.metrics.toolCalls}
${result.metrics.tokensUsed ? `- **Tokens Used**: Input: ${result.metrics.tokensUsed.input}, Output: ${result.metrics.tokensUsed.output}` : ""}

---
*Generated by DARCI (Defect Analysis & Root Cause Identification) at ${new Date().toISOString()}*
`;
  }
}
