/**
 * SCRIBEWorker - Polls for code explanation tasks
 *
 * Monitors database for SCRIBE tasks, executes explanation, uploads results to S3
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates SCRIBEAgent and runs explanation
 * 4. Agent uses Claude CLI with Bedrock for LLM inference
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { SCRIBEAgent, type SCRIBEExplanationResult } from '../../agents/scribe/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('scribe-worker');

/**
 * SCRIBE Worker - Simple Clear Rundown of Implementations, Behavior, and Endpoints
 */
export class SCRIBEWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'SCRIBE',
            repositoryPath,
            pollingIntervalMs: 10000, // 10 seconds
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
            pollingIntervalMs: 10000,
        }, '[SCRIBE_WORKER_INIT] SCRIBEWorker initialized');
    }

    /**
     * Process explanation task
     *
     * Called by AgentWorker.processTask() after workspace setup is complete.
     * This is the agent-specific implementation that creates and runs SCRIBE.
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
            correlationId: `scribe-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[SCRIBE_PROCESS_START] Starting code explanation');
        logger.debug({
            ...logContext,
            taskDescriptionLength: taskDescription.length,
            additionalContextLength: additionalContext.length,
            hasEventEmitter: !!eventEmitter,
        }, '[SCRIBE_PROCESS_CONTEXT] Task context details');

        try {
            // Stage 1: Create agent with customer-specific workspace
            logger.info(logContext, '[SCRIBE_AGENT_CREATE] Creating SCRIBEAgent instance');

            const agent = new SCRIBEAgent({
                repositoryPath,
                onProgress: (msg) => {
                    logger.debug({
                        ...logContext,
                        progressMessage: msg,
                    }, '[SCRIBE_PROGRESS] Agent progress update');
                },
                eventEmitter,
            });

            logger.info(logContext, '[SCRIBE_AGENT_CREATED] SCRIBEAgent instance created successfully');

            // Stage 2: Run explanation with task description and additional context separately
            logger.info(logContext, '[SCRIBE_EXPLAIN_START] Starting Claude explanation');
            const result = await agent.explain(taskDescription, additionalContext);

            const durationMs = Date.now() - startTime;

            // Stage 3: Process results
            if (result.success) {
                logger.info({
                    ...logContext,
                    durationMs,
                    toolCalls: result.metrics.toolCalls,
                    tokensUsed: result.metrics.tokensUsed,
                    hasStructuredOutput: !!result.structured,
                }, '[SCRIBE_EXPLAIN_SUCCESS] Explanation completed successfully');

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
                }, '[SCRIBE_EXPLAIN_FAILED] Explanation failed');

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
            }, '[SCRIBE_PROCESS_ERROR] Unhandled error in SCRIBE explanation');

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
     * Format explanation result as markdown
     */
    private formatOutput(jiraNumber: string, result: SCRIBEExplanationResult): string {
        const structured = result.structured;

        return `# SCRIBE Explanation for ${jiraNumber}

## Code Explanation

${result.explanation}

${structured ? `
## Structured Output

${structured.summary ? `
### Summary
${structured.summary}
` : ''}

${structured.how_it_works ? `
### How It Works
${structured.how_it_works.overview || ''}

${structured.how_it_works.key_components?.length ? `
**Key Components:**
${structured.how_it_works.key_components.map(c => `- **${c.name}** (\`${c.file_path}\`): ${c.purpose}`).join('\n')}
` : ''}

${structured.how_it_works.execution_flow?.length ? `
**Execution Flow:**
${structured.how_it_works.execution_flow.map((step, i) => `${i + 1}. ${step}`).join('\n')}
` : ''}
` : ''}

${structured.key_concepts?.length ? `
### Key Concepts
${structured.key_concepts.map(c => `- **${c.concept}**: ${c.explanation}`).join('\n')}
` : ''}
` : ''}

## Metrics

- **Duration**: ${(result.metrics.durationMs / 1000).toFixed(2)}s
- **Tool Calls**: ${result.metrics.toolCalls}
${result.metrics.tokensUsed ? `- **Tokens Used**: Input: ${result.metrics.tokensUsed.input}, Output: ${result.metrics.tokensUsed.output}` : ''}

---
*Generated by SCRIBE (Simple Clear Rundown of Implementations, Behavior, and Endpoints) at ${new Date().toISOString()}*
`;
    }
}
