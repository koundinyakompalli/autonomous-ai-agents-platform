/**
 * BCAT-PLANNER Worker
 * Processes JIRA tickets labeled with "BCAT" that have not been planned yet
 *
 * Workflow:
 * 1. Poll for BCAT labeled tickets (no bcat-planned label)
 * 2. Download Excel attachment from JIRA
 * 3. Detect scenario type
 * 4. Preview tickets to create → post plan comment → add bcat-planned label
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { BCATplannerAgent } from '../../agents/bcat/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('bcat-planner-worker');

/**
 * BCAT-PLANNER Worker - Plans bulk JIRA ticket creation
 */
export class BCATplannerWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'BCAT-PLANNER',
            repositoryPath,
            pollingIntervalMs: 15000,
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
            pollingIntervalMs: 15000,
        }, '[BCAT_PLANNER_INIT] BCATplannerWorker initialized');
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
            correlationId: `bcat-planner-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[BCAT_PLANNER_PROCESS_START] Starting BCAT planning');

        try {
            const agent = new BCATplannerAgent(this.agentJiraUsername, this.agentJiraToken);
            const output = await agent.plan(jiraNumber, additionalContext);
            const durationMs = Date.now() - startTime;

            logger.info({ ...logContext, durationMs }, '[BCAT_PLANNER_PROCESS_COMPLETE] Planning complete');

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
            }, '[BCAT_PLANNER_PROCESS_ERROR] Planning failed');

            return {
                success: false,
                output: '',
                error: error.message,
                metrics: { durationMs },
            };
        }
    }
}
