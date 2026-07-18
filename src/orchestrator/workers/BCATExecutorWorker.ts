/**
 * BCAT-EXECUTOR Worker
 * Processes JIRA tickets labeled with "BCAT" and "bcat-planned" that have Approvers set
 *
 * Workflow:
 * 1. Poll for BCAT labeled tickets (bcat-planned, no bcat-processed, Approvers set)
 * 2. Download Excel attachment from JIRA
 * 3. Detect scenario type
 * 4. Create bulk JIRA tickets → attach per-ticket Excel → link to parent → add bcat-processed label
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { BCATExecutorAgent } from '../../agents/bcat/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('bcat-executor-worker');

/**
 * BCAT-EXECUTOR Worker - Executes bulk JIRA ticket creation
 */
export class BCATExecutorWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'BCAT-EXECUTOR',
            repositoryPath,
            pollingIntervalMs: 15000,
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
            pollingIntervalMs: 15000,
        }, '[BCAT_EXECUTOR_INIT] BCATExecutorWorker initialized');
    }

    protected async process(
        jiraNumber: string,
        taskId: number,
        taskDescription: string,
        additionalContext: string,
        repositoryPath: string,
        eventEmitter?: EventEmitter
    ): Promise<ProcessResult> {
        const startTime = Date.now();
        const logContext = {
            jira: jiraNumber,
            taskId,
            correlationId: `bcat-executor-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[BCAT_EXECUTOR_PROCESS_START] Starting BCAT execution');

        try {
            const agent = new BCATExecutorAgent(this.agentJiraUsername, this.agentJiraToken);
            const output = await agent.execute(jiraNumber, additionalContext);
            const durationMs = Date.now() - startTime;

            logger.info({ ...logContext, durationMs }, '[BCAT_EXECUTOR_PROCESS_COMPLETE] Execution complete');

            return {
                success: true,
                output,
                metrics: { durationMs },
            };
        } catch (error: any) {
            const durationMs = Date.now() - startTime;
            logger.error({
                ...logContext,
                durationMs,
                errorMessage: error.message,
            }, '[BCAT_EXECUTOR_PROCESS_ERROR] Execution failed');

            return {
                success: false,
                output: '',
                error: error.message,
                metrics: { durationMs },
            };
        }
    }
}
