/**
 * VERITASWorker - Polls for RCA generation tasks
 *
 * Monitors database for VERITAS tasks, executes RCA analysis, uploads results to S3
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates VERITASAgent and runs analyze()
 * 4. Agent collects evidence from JIRA, then uses Claude SDK for RCA
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { VERITASAgent, type VERITASResult } from '../../agents/veritas/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('veritas-worker');

/**
 * VERITAS Worker - Verified Evidence-based Root-cause Investigation Truth & Analysis System
 */
export class VERITASWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'VERITAS',
            repositoryPath,
            pollingIntervalMs: 10000, // 10 seconds
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
            pollingIntervalMs: 10000,
        }, '[VERITAS_WORKER_INIT] VERITASWorker initialized');
    }

    /**
     * Process RCA generation task
     *
     * Called by AgentWorker.processTask() after workspace setup is complete.
     * This is the agent-specific implementation that creates and runs VERITAS.
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
            correlationId: `veritas-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[VERITAS_PROCESS_START] Starting RCA generation');
        logger.debug({
            ...logContext,
            taskDescriptionLength: taskDescription.length,
            additionalContextLength: additionalContext.length,
            hasEventEmitter: !!eventEmitter,
        }, '[VERITAS_PROCESS_CONTEXT] Task context details');

        try {
            // Stage 1: Create agent (optionally with repository for code exploration)
            logger.info(logContext, '[VERITAS_AGENT_CREATE] Creating VERITASAgent instance');

            const agent = new VERITASAgent({
                jiraUsername: this.agentJiraUsername,
                jiraToken: this.agentJiraToken,
                repositoryPath,
                onProgress: (msg) => {
                    logger.debug({
                        ...logContext,
                        progressMessage: msg,
                    }, '[VERITAS_PROGRESS] Agent progress update');
                },
                eventEmitter,
            });

            logger.info(logContext, '[VERITAS_AGENT_CREATED] VERITASAgent instance created successfully');

            // Stage 2: Run analysis
            // The jiraNumber is the SEN ticket key (e.g., SEN-123)
            // Additional context from the task is passed through
            logger.info(logContext, '[VERITAS_ANALYZE_START] Starting VERITAS analysis');
            const result = await agent.analyze(jiraNumber, additionalContext || undefined);

            const durationMs = Date.now() - startTime;

            // Stage 3: Process results
            if (result.success) {
                logger.info({
                    ...logContext,
                    durationMs,
                    toolCalls: result.metrics.toolCalls,
                    tokensUsed: result.metrics.tokensUsed,
                    costUsd: result.metrics.costUsd,
                    rcaLength: result.rcaReport.length,
                    sourceCount: result.sources.length,
                    evidenceCollectionMs: result.metrics.evidenceCollectionMs,
                    rcaGenerationMs: result.metrics.rcaGenerationMs,
                }, '[VERITAS_ANALYZE_SUCCESS] RCA generation completed successfully');

                const output = this.formatOutput(jiraNumber, result);

                const actualCost = result.metrics.costUsd ?? this.estimateCost(result.metrics.tokensUsed);

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
                }, '[VERITAS_ANALYZE_FAILED] RCA generation failed');

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
            }, '[VERITAS_PROCESS_ERROR] Unhandled error in VERITAS analysis');

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
     * Format RCA result for output
     */
    private formatOutput(jiraNumber: string, result: VERITASResult): string {
        const sourcesList = result.sources
            .map(s => `- ${s.key}${s.commentCount ? ` (${s.commentCount} comments)` : ''}`)
            .join('\n');

        return `## VERITAS Root Cause Analysis: ${jiraNumber}

${result.rcaReport}

---

**Evidence Sources:**
${sourcesList}

<sub>⏱️ ${(result.metrics.durationMs / 1000).toFixed(2)}s (evidence: ${(result.metrics.evidenceCollectionMs / 1000).toFixed(2)}s, RCA: ${(result.metrics.rcaGenerationMs / 1000).toFixed(2)}s) | 🔧 ${result.metrics.toolCalls} tool calls${result.metrics.costUsd ? ` | 💰 $${result.metrics.costUsd.toFixed(4)}` : ''} | 🤖 VERITAS v1.0.0</sub>
`;
    }
}
