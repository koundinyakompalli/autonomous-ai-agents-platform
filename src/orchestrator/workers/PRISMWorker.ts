/**
 * PRISMWorker - Polls for planning/refinement tasks
 *
 * Monitors database for PRISM tasks, executes planning, uploads results to S3
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates PRISMAgent and runs planning
 * 4. Agent uses Claude CLI with Bedrock for LLM inference
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { PRISMAgent, type PRISMPlanResult } from '../../agents/prism/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('prism-worker');

/**
 * PRISM Worker - Planning & Refinement with Intelligent Systems at MedHok
 */
export class PRISMWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'PRISM',
            repositoryPath,
            pollingIntervalMs: 10000, // 10 seconds
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
            pollingIntervalMs: 10000,
        }, '[PRISM_WORKER_INIT] PRISMWorker initialized');
    }

    /**
     * Process planning task
     *
     * Called by AgentWorker.processTask() after workspace setup is complete.
     * This is the agent-specific implementation that creates and runs PRISM.
     */
    protected async process(
        jiraNumber: string,
        taskId: number,
        taskDescription: string,
        additionalContext: string,
        repositoryPath: string,
        eventEmitter?: EventEmitter
    ): Promise<ProcessResult> {
        const startTime = Date.now();

        // Create correlation context for all logs in this task
        const logContext = {
            jira: jiraNumber,
            taskId,
            repositoryPath,
            correlationId: `prism-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[PRISM_PROCESS_START] Starting implementation planning');
        logger.debug({
            ...logContext,
            taskDescriptionLength: taskDescription.length,
            additionalContextLength: additionalContext.length,
            hasEventEmitter: !!eventEmitter,
        }, '[PRISM_PROCESS_CONTEXT] Task context details');

        try {
            // Stage 1: Create agent with customer-specific workspace
            logger.info(logContext, '[PRISM_AGENT_CREATE] Creating PRISMAgent instance');

            const agent = new PRISMAgent({
                repositoryPath,
                onProgress: (msg) => {
                    logger.debug({
                        ...logContext,
                        progressMessage: msg,
                    }, '[PRISM_PROGRESS] Agent progress update');
                },
                eventEmitter,
            });

            logger.info(logContext, '[PRISM_AGENT_CREATED] PRISMAgent instance created successfully');

            // Stage 2: Run planning with task description and additional context separately
            logger.info(logContext, '[PRISM_PLANNING_START] Starting Claude planning');
            const result = await agent.plan(taskDescription, additionalContext);

            const durationMs = Date.now() - startTime;

            // Stage 3: Process results
            if (result.success) {
                logger.info({
                    ...logContext,
                    durationMs,
                    toolCalls: result.metrics.toolCalls,
                    tokensUsed: result.metrics.tokensUsed,
                    hasStructuredOutput: !!result.structured,
                }, '[PRISM_PLANNING_SUCCESS] Planning completed successfully');

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
                logger.error({
                    ...logContext,
                    durationMs,
                    error: result.error,
                }, '[PRISM_PLANNING_FAILED] Planning failed');

                return {
                    success: false,
                    output: '',
                    error: result.error || 'Unknown error',
                    metrics: {
                        durationMs,
                    },
                };
            }
        } catch (error: any) {
            const durationMs = Date.now() - startTime;

            logger.error({
                ...logContext,
                durationMs,
                errorName: error.name,
                errorMessage: error.message,
                errorStack: error.stack,
            }, '[PRISM_PROCESS_ERROR] Unhandled error in PRISM planning');

            return {
                success: false,
                output: '',
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
     * Format planning result as markdown
     */
    private formatOutput(jiraNumber: string, result: PRISMPlanResult): string {
        const structured = result.structured;

        return `# PRISM Implementation Plan for ${jiraNumber}

## Planning & Refinement

${result.plan}

${structured ? `
## Structured Output

${structured.ticket_summary ? `
### Requirements Summary
${structured.ticket_summary.requirements?.length ? `- **Requirements**: ${structured.ticket_summary.requirements.join(', ')}` : ''}
${structured.ticket_summary.acceptance_criteria?.length ? `- **Acceptance Criteria**: ${structured.ticket_summary.acceptance_criteria.join(', ')}` : ''}
${structured.ticket_summary.assumptions?.length ? `- **Assumptions**: ${structured.ticket_summary.assumptions.join(', ')}` : ''}
` : ''}

${structured.implementation_steps?.length ? `
### Implementation Steps
${structured.implementation_steps.map(step => `${step.step}. ${step.description} (${step.complexity})`).join('\n')}
` : ''}

${structured.estimated_effort ? `
### Estimated Effort
- Development: ${structured.estimated_effort.development_hours}h
- Testing: ${structured.estimated_effort.testing_hours}h
- Review: ${structured.estimated_effort.review_hours}h
- **Total: ${structured.estimated_effort.total_hours}h**
` : ''}
` : ''}

## Metrics

- **Duration**: ${(result.metrics.durationMs / 1000).toFixed(2)}s
- **Tool Calls**: ${result.metrics.toolCalls}
${result.metrics.tokensUsed ? `- **Tokens Used**: Input: ${result.metrics.tokensUsed.input}, Output: ${result.metrics.tokensUsed.output}` : ''}

---
*Generated by PRISM (Planning & Refinement with Intelligent Systems at MedHok) at ${new Date().toISOString()}*
`;
    }
}
