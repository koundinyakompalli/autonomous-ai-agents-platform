/**
 * BC-INTAKE Worker - BC Upgrade Ticket Validation Worker
 *
 * Monitors JIRA for BC Upgrade tickets and validates intake forms
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' tasks from task_management
 * 2. processTask() in AgentWorker sets up workspace and context
 * 3. process() (this file) creates BCIntakeAgent and runs validate()
 * 4. Agent downloads attachment, parses form, validates fields
 * 5. Results posted to JIRA, uploaded to S3, status updated in database
 */

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { BCIntakeAgent, type BCIntakeResult } from '../../agents/bc-intake/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EventEmitter } from 'events';

const logger = createLogger('bc-intake-worker');

/**
 * BC-INTAKE Worker - BC Upgrade Ticket Validation
 */
export class BCIntakeWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'BC-INTAKE',
            repositoryPath,
            pollingIntervalMs: 10000, // 10 seconds
            batchSize: 1,
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
            pollingIntervalMs: 10000,
        }, '[BC_INTAKE_WORKER_INIT] BCIntakeWorker initialized');
    }

    /**
     * Process BC Upgrade ticket validation task
     *
     * Called by AgentWorker.processTask() after workspace setup is complete.
     * This is the agent-specific implementation that creates and runs BC-INTAKE.
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
            correlationId: `bc-intake-${taskId}-${jiraNumber}`,
        };

        logger.info(logContext, '[BC_INTAKE_PROCESS_START] Starting BC Upgrade ticket validation');
        logger.debug({
            ...logContext,
            taskDescriptionLength: taskDescription.length,
            additionalContextLength: additionalContext.length,
            hasEventEmitter: !!eventEmitter,
        }, '[BC_INTAKE_PROCESS_CONTEXT] Task context details');

        try {
            // Stage 1: Create agent
            logger.info(logContext, '[BC_INTAKE_AGENT_CREATE] Creating BCIntakeAgent instance');

            const agent = new BCIntakeAgent({
                jiraUsername: this.agentJiraUsername,
                jiraToken: this.agentJiraToken,
                repositoryPath, // Optional - BC-INTAKE doesn't need repos
                onProgress: (msg) => {
                    logger.debug({
                        ...logContext,
                        progressMessage: msg,
                    }, '[BC_INTAKE_PROGRESS] Agent progress update');
                },
                eventEmitter,
            });

            logger.info(logContext, '[BC_INTAKE_AGENT_CREATED] BCIntakeAgent instance created successfully');

            // Stage 2: Run validation
            logger.info(logContext, '[BC_INTAKE_VALIDATE_START] Starting BC Upgrade validation');
            const result = await agent.validate(jiraNumber, additionalContext || undefined);

            const durationMs = Date.now() - startTime;

            // Stage 3: Process results
            if (result.success) {
                logger.info({
                    ...logContext,
                    durationMs,
                    isComplete: result.validation.isComplete,
                    completedFields: result.validation.completedCount,
                    missingFields: result.validation.missingFields.length,
                    commentPosted: result.actionsT.commentPosted,
                    labelAdded: result.actionsT.labelAdded,
                    configDateSet: result.actionsT.configDateSet,
                }, '[BC_INTAKE_VALIDATE_SUCCESS] BC Upgrade validation completed successfully');

                const output = this.formatOutput(jiraNumber, result);

                return {
                    success: true,
                    output,
                    metrics: {
                        durationMs,
                    },
                };
            } else {
                logger.error({
                    ...logContext,
                    durationMs,
                    error: result.error,
                }, '[BC_INTAKE_VALIDATE_FAILED] BC Upgrade validation failed');

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
            }, '[BC_INTAKE_PROCESS_ERROR] Unhandled error in BC Upgrade validation');

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
     * Format BC Upgrade validation result for output
     */
    private formatOutput(jiraNumber: string, result: BCIntakeResult): string {
        const statusIcon = result.validation.isComplete ? '✅' : '⚠️';
        const status = result.validation.isComplete ? 'COMPLETE' : 'INCOMPLETE';

        let output = `## BC Upgrade Ticket Validation: ${jiraNumber}

${statusIcon} **Status:** ${status}

### Validation Summary

- **Total Mandatory Fields:** ${result.validation.totalFields}
- **Completed:** ${result.validation.completedCount}
- **Missing:** ${result.validation.missingFields.length}
`;

        // Add completed fields list
        if (result.validation.completedFields.length > 0) {
            output += `\n### ✅ Completed Fields (${result.validation.completedCount})\n\n`;
            for (const field of result.validation.completedFields) {
                output += `- ✅ ${field.field}\n`;
            }
        }

        // Add missing fields list for incomplete tickets
        if (result.validation.missingFields.length > 0) {
            output += `\n### ❌ Missing Fields (${result.validation.missingFields.length})\n\n`;
            for (const field of result.validation.missingFields) {
                output += `- ❌ **${field.field}** - ${field.reason}\n`;
            }
        }

        // Add source document
        if (result.validation.sourceDocument) {
            output += `\n---\n\n**Source Document:** ${result.validation.sourceDocument}\n`;
        }

        // Add actions taken
        output += `\n### Actions Taken\n\n`;
        output += `- ${result.actionsT.commentPosted ? '✅' : '❌'} Validation comment posted to JIRA\n`;

        if (result.validation.isComplete) {
            output += `- ${result.actionsT.labelAdded ? '✅' : '❌'} DARCI label added\n`;
            output += `- ${result.actionsT.configDateSet ? '✅' : '❌'} Configuration Start Date set`;
            if (result.configurationStartDate) {
                output += ` (${result.configurationStartDate})`;
            }
            output += `\n`;
        }

        // Add metrics
        output += `\n---\n\n`;
        output += `<sub>⏱️ ${(result.metrics.durationMs / 1000).toFixed(2)}s`;
        output += ` | 📄 ${result.metrics.documentParsed ? 'Document parsed' : 'No document'}`;
        output += ` | 🔍 ${result.metrics.fieldsValidated} fields validated`;
        output += ` | 🤖 BC-INTAKE v1.0.0</sub>`;

        return output;
    }
}
