/**
 * HERMESWorker - Polls for configuration lookup tasks
 *
 * Monitors database for HERMES tasks, executes config search, uploads results to S3
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates HERMESAgent and runs lookup
 * 4. Agent uses Claude CLI with Bedrock for LLM inference
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from "../AgentWorker.js";
import {
  HERMESAgent,
  type HERMESConfigResult,
} from "../../agents/hermes/index.js";
import { createLogger } from "../../utils/logger.js";
import type { EventEmitter } from "events";

const logger = createLogger("hermes-worker");

/**
 * HERMES Worker - Heuristic Engine for Rules, Modes, and Environment Settings
 */
export class HERMESWorker extends AgentWorker {
  constructor(repositoryPath: string, enableStatusServer: boolean = false) {
    super({
      agentName: "HERMES",
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
      "[HERMES_WORKER_INIT] HERMESWorker initialized",
    );
  }

  /**
   * Process configuration lookup task
   *
   * Called by AgentWorker.processTask() after workspace setup is complete.
   * This is the agent-specific implementation that creates and runs HERMES.
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
      correlationId: `hermes-${taskId}-${jiraNumber}`,
    };

    logger.info(
      logContext,
      "[HERMES_PROCESS_START] Starting configuration lookup",
    );
    logger.debug(
      {
        ...logContext,
        taskDescriptionLength: taskDescription.length,
        additionalContextLength: additionalContext.length,
        hasEventEmitter: !!eventEmitter,
      },
      "[HERMES_PROCESS_CONTEXT] Task context details",
    );

    try {
      // Stage 1: Create agent with customer-specific workspace
      logger.info(
        logContext,
        "[HERMES_AGENT_CREATE] Creating HERMESAgent instance",
      );

      const agent = new HERMESAgent({
        repositoryPath,
        onProgress: (msg) => {
          logger.debug(
            {
              ...logContext,
              progressMessage: msg,
            },
            "[HERMES_PROGRESS] Agent progress update",
          );
        },
        eventEmitter,
      });

      logger.info(
        logContext,
        "[HERMES_AGENT_CREATED] HERMESAgent instance created successfully",
      );

      // Stage 2: Run lookup with task description and additional context separately
      logger.info(logContext, "[HERMES_LOOKUP_START] Starting Claude lookup");
      const result = await agent.findConfig(taskDescription, additionalContext);

      const durationMs = Date.now() - startTime;

      // Stage 3: Process results
      if (result.success) {
        logger.info(
          {
            ...logContext,
            durationMs,
            toolCalls: result.metrics.toolCalls,
            tokensUsed: result.metrics.tokensUsed,
            hasStructuredOutput: !!result.structured,
          },
          "[HERMES_LOOKUP_SUCCESS] Lookup completed successfully",
        );

        const output = this.formatOutput(jiraNumber, result);

        // Estimate cost if not provided
        const actualCost = this.estimateCost(result.metrics.tokensUsed);

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
          "[HERMES_LOOKUP_FAILED] Lookup failed",
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
        "[HERMES_PROCESS_ERROR] Unhandled error in HERMES lookup",
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
   * Format config result as markdown
   */
  private formatOutput(jiraNumber: string, result: HERMESConfigResult): string {
    // Safely access structured output fields
    const structured = result.structured;
    const config = structured?.configuration;
    const location = structured?.location;
    const currentValue = structured?.current_value;
    const usage = structured?.usage;
    const impactAnalysis = structured?.impact_analysis;
    const security = structured?.security;
    const evidence = structured?.evidence ?? [];
    const relatedConfigurations = structured?.related_configurations ?? [];

    return `# HERMES Configuration Lookup for ${jiraNumber}

## Configuration Details

${result.configuration}

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

### Configuration
${config?.name ? `- **Name**: ${config.name}` : ""}
${config?.type ? `- **Type**: ${config.type}` : ""}
${config?.table_name ? `- **Table**: ${config.table_name}` : ""}

${
  location
    ? `
### Location
${location.hibernate_mapping ? `- **Hibernate Mapping**: \`${location.hibernate_mapping}\`` : ""}
${location.java_model ? `- **Java Model**: \`${location.java_model}\`` : ""}
${location.service ? `- **Service**: \`${location.service}\`` : ""}
`
    : ""
}

${
  currentValue
    ? `
### Current Value
${currentValue.code ? `- **Code**: \`${currentValue.code}\`` : ""}
${currentValue.str_value ? `- **String Value**: ${currentValue.str_value}` : ""}
${currentValue.int_value !== undefined ? `- **Integer Value**: ${currentValue.int_value}` : ""}
${currentValue.client !== undefined ? `- **Client-Specific**: ${currentValue.client}` : ""}
${currentValue.is_locked !== undefined ? `- **Locked**: ${currentValue.is_locked}` : ""}
`
    : ""
}

${
  structured.description
    ? `
### Description
${structured.description}
`
    : ""
}

${
  evidence.length > 0
    ? `
### Evidence
${evidence
  .map((item) => {
    const source = item.source_path
      ? `\`${item.source_path}\``
      : "Unspecified source";
    const precedence = item.precedence ? ` (${item.precedence})` : "";
    return `- ${source}${precedence}: ${item.finding}`;
  })
  .join("\n")}
`
    : ""
}

${
  usage
    ? `
### Usage
${usage.service_layer ? `- **Service Layer**: ${usage.service_layer}` : ""}
${usage.referenced_by?.length ? `- **Referenced By**: ${usage.referenced_by.join(", ")}` : ""}
`
    : ""
}

${
  impactAnalysis
    ? `
### Impact Analysis
${impactAnalysis.if_changed?.length ? `- **If Changed**: ${impactAnalysis.if_changed.join(", ")}` : ""}
${impactAnalysis.dependencies?.length ? `- **Dependencies**: ${impactAnalysis.dependencies.join(", ")}` : ""}
`
    : ""
}

${
  relatedConfigurations.length > 0
    ? `
### Related Configurations
${relatedConfigurations.map((item) => `- **${item.name}**: ${item.relationship}`).join("\n")}
`
    : ""
}

${
  security
    ? `
### Security
${security.phi_pii !== undefined ? `- **Contains PHI/PII**: ${security.phi_pii}` : ""}
${security.hipaa_considerations ? `- **HIPAA Considerations**: ${security.hipaa_considerations}` : ""}
${security.access_control ? `- **Access Control**: ${security.access_control}` : ""}
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
*Generated by HERMES (Heuristic Engine for Rules, Modes, and Environment Settings) at ${new Date().toISOString()}*
`;
  }
}
