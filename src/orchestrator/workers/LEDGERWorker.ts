/**
 * LEDGERWorker - Polls for LOE analysis tasks
 *
 * Monitors database for LEDGER tasks, executes LOE analysis, uploads results to S3
 * and posts the complete analysis back as a JIRA comment.
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates LEDGERAgent and runs analyze()
 * 4. Claude reads repos, produces LOE report (with SQL only if needed)
 * 5. Result uploaded to S3, posted to JIRA, status updated in DB
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { LEDGERAgent, type LedgerResult } from '../../agents/ledger/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('ledger-worker');

export class LEDGERWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'LEDGER',
            repositoryPath,
            pollingIntervalMs: 10000,
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
        }, '[LEDGER_WORKER_INIT] LEDGERWorker initialized');
    }

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
            correlationId: `ledger-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[LEDGER_PROCESS_START] Starting LOE analysis');

        try {
            const agent = new LEDGERAgent({
                jiraUsername: this.agentJiraUsername,
                jiraToken: this.agentJiraToken,
                repositoryPath,
                onProgress: (msg) => {
                    logger.debug({ ...logContext, progressMessage: msg }, '[LEDGER_PROGRESS]');
                },
                eventEmitter,
            });

            const result: LedgerResult = await agent.analyze(
                jiraNumber,
                taskDescription,
                additionalContext || undefined,
            );

            const durationMs = Date.now() - startTime;

            if (result.success) {
                logger.info({
                    ...logContext,
                    durationMs,
                    toolCalls: result.metrics.toolCalls,
                    tokensUsed: result.metrics.tokensUsed,
                    costUsd: result.metrics.costUsd,
                    reportLength: result.loeReport.length,
                    taskCategories: result.taskCategories,
                    reposConsulted: result.reposConsulted,
                }, '[LEDGER_ANALYZE_SUCCESS] LOE analysis completed successfully');

                return {
                    success: true,
                    output: this.formatOutput(jiraNumber, result),
                    metrics: {
                        totalTokens: result.metrics.tokensUsed,
                        iterations: result.metrics.toolCalls,
                        cost: result.metrics.costUsd ?? this.estimateCost(result.metrics.tokensUsed),
                        durationMs,
                    },
                };
            } else {
                logger.error({
                    ...logContext,
                    durationMs,
                    error: result.error,
                }, '[LEDGER_ANALYZE_FAILED] LOE analysis failed');

                return {
                    success: false,
                    output: '',
                    error: result.error || 'Unknown error',
                    metrics: { durationMs },
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
            }, '[LEDGER_PROCESS_ERROR] Unhandled error in LEDGER analysis');

            return {
                success: false,
                output: '',
                error: error.message,
                metrics: { durationMs },
            };
        }
    }

    private estimateCost(tokensUsed?: { input: number; output: number }): number {
        if (!tokensUsed) return 0;
        return (tokensUsed.input / 1000) * 0.003 + (tokensUsed.output / 1000) * 0.015;
    }

    private formatOutput(jiraNumber: string, result: LedgerResult): string {
        const categories = result.taskCategories.join(', ');
        const repos = result.reposConsulted.join(', ');

        return `## LEDGER LOE Analysis: ${jiraNumber}

${result.loeReport}

---

**Task Categories:** ${categories}
**Repos Consulted:** ${repos}

<sub>⏱️ ${(result.metrics.durationMs / 1000).toFixed(2)}s (repo scan: ${((result.metrics.evidenceCollectionMs ?? 0) / 1000).toFixed(2)}s, analysis: ${((result.metrics.analysisMs ?? 0) / 1000).toFixed(2)}s) | 🔧 ${result.metrics.toolCalls ?? 0} tool calls${result.metrics.costUsd ? ` | 💰 $${result.metrics.costUsd.toFixed(4)}` : ''} | 🤖 LEDGER v1.0.0</sub>
`;
    }
}
