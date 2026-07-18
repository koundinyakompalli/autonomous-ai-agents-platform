/**
 * SRLOGWorker - Polls for SQL log analysis tasks
 *
 * Monitors database for SRLOG tasks, downloads .log attachments from JIRA,
 * runs Oracle/PL-SQL error analysis, uploads results to S3.
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates SRLOGAgent and runs analyze()
 * 4. Agent downloads .log attachments, then uses Claude SDK for analysis
 * 5. Results uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { SRLOGAgent, type SRLOGResult } from '../../agents/srlog/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('srlog-worker');

/**
 * SRLOG Worker - SQL & Resource LOG Analyzer
 */
export class SRLOGWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'SRLOG',
            repositoryPath,
            pollingIntervalMs: 10000, // 10 seconds
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
            pollingIntervalMs: 10000,
        }, '[SRLOG_WORKER_INIT] SRLOGWorker initialized');
    }

    /**
     * Process SQL log analysis task.
     *
     * Called by AgentWorker.processTask() after workspace setup is complete.
     * Creates SRLOGAgent which downloads .log attachments then runs Claude SDK analysis.
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
            correlationId: `srlog-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[SRLOG_PROCESS_START] Starting SQL log analysis');
        logger.debug({
            ...logContext,
            taskDescriptionLength: taskDescription.length,
            additionalContextLength: additionalContext.length,
            hasEventEmitter: !!eventEmitter,
        }, '[SRLOG_PROCESS_CONTEXT] Task context details');

        try {
            logger.info(logContext, '[SRLOG_AGENT_CREATE] Creating SRLOGAgent instance');

            const agent = new SRLOGAgent({
                jiraUsername: this.agentJiraUsername,
                jiraToken: this.agentJiraToken,
                repositoryPath,
                onProgress: (msg) => {
                    logger.debug({
                        ...logContext,
                        progressMessage: msg,
                    }, '[SRLOG_PROGRESS] Agent progress update');
                },
                eventEmitter,
            });

            logger.info(logContext, '[SRLOG_AGENT_CREATED] SRLOGAgent instance created successfully');

            logger.info(logContext, '[SRLOG_ANALYZE_START] Starting SRLOG analysis');
            const result = await agent.analyze(jiraNumber, additionalContext || undefined);

            const durationMs = Date.now() - startTime;

            if (result.success) {
                logger.info({
                    ...logContext,
                    durationMs,
                    toolCalls: result.metrics.toolCalls,
                    tokensUsed: result.metrics.tokensUsed,
                    costUsd: result.metrics.costUsd,
                    reportLength: result.report.length,
                    errorsFound: result.structured?.summary?.total_errors ?? 'unknown',
                    logDownloadMs: result.metrics.logDownloadMs,
                    analysisMs: result.metrics.analysisMs,
                }, '[SRLOG_ANALYZE_SUCCESS] Log analysis completed successfully');

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
                }, '[SRLOG_ANALYZE_FAILED] Log analysis failed');

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
            }, '[SRLOG_PROCESS_ERROR] Unhandled error in SRLOG analysis');

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
     * Format analysis result as markdown for JIRA/S3
     */
    private formatOutput(jiraNumber: string, result: SRLOGResult): string {
        const summary = result.structured?.summary;
        const summarySection = summary
            ? `**Errors Found:** ${summary.total_errors} (${summary.critical_count} critical, ${summary.error_count} errors, ${summary.warning_count} warnings)\n**Files Analyzed:** ${summary.files_analyzed}`
            : '';

        return `## SRLOG Analysis: ${jiraNumber}

${result.report}

---

${summarySection ? `${summarySection}\n\n` : ''}<sub>⏱️ ${(result.metrics.durationMs / 1000).toFixed(2)}s (download: ${(result.metrics.logDownloadMs / 1000).toFixed(2)}s, analysis: ${(result.metrics.analysisMs / 1000).toFixed(2)}s) | 🔧 ${result.metrics.toolCalls} tool calls${result.metrics.costUsd ? ` | 💰 $${result.metrics.costUsd.toFixed(4)}` : ''} | 🤖 SRLOG v1.0.0</sub>
`;
    }
}
