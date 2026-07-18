/**
 * PRISM - Planning & Refinement with Intelligent Systems at MedHok
 *
 * Uses Claude Agent SDK to help with planning and refinement tasks by:
 * - Analyzing requirements and specifications
 * - Understanding existing code patterns
 * - Creating implementation plans
 * - Breaking down complex tasks
 *
 * ## Lifecycle
 * 1. [PRISM_INIT] - Agent created with repository path or ID
 * 2. [PRISM_REPO_REGISTER] - Repository registered in repo registry
 * 3. [PRISM_PLAN_START] - Planning begins
 * 4. [PRISM_PLAN_COMPLETE] - Planning finishes
 */

import {
    runAgent,
    getAgentPrompt,
    registerRepoFromPath,
    registerCustomerWorkspace,
    PRISM_OUTPUT_SCHEMA,
    type AgentResult,
    type ProgressUpdate,
} from '../../claude-sdk/index.js';
import { createLogger } from '../../utils/index.js';
import type { EventEmitter } from 'events';

const logger = createLogger('prism-agent');

export interface PRISMAgentOptions {
    /** Repository ID (registered in repo registry) - preferred */
    repoId?: string;

    /**
     * Repository path (legacy - will auto-register and create repoId)
     * Can be a customer workspace with symlinks or a direct git repository
     */
    repositoryPath?: string;

    /** Optional event emitter */
    eventEmitter?: EventEmitter;

    /** Optional progress callback */
    onProgress?: (message: string) => void;

    /** Timeout in milliseconds (default: 15 minutes) */
    timeoutMs?: number;

    /** Webhook URL for audit events */
    webhookUrl?: string;
}

export interface PRISMPlanResult {
    /** Whether planning completed successfully */
    success: boolean;

    /** Full plan text */
    plan: string;

    /** Structured plan data */
    structured?: {
        ticket_summary?: {
            requirements: string[];
            acceptance_criteria: string[];
            assumptions: string[];
        };
        project_identification?: {
            target_projects: string[];
            project_type: string;
            key_files: string[];
        };
        technical_approach?: string;
        planned_changes?: Array<{
            file_path: string;
            change_type: 'modify' | 'create' | 'delete';
            purpose: string;
            current_code?: string;
            planned_code?: string;
            change_summary?: string;
        }>;
        implementation_steps?: Array<{
            step: number;
            description: string;
            files: string[];
            estimated_time: string;
            complexity: 'low' | 'medium' | 'high';
        }>;
        testing_strategy?: {
            unit_tests: string[];
            integration_tests: string[];
            manual_tests: string[];
        };
        risks?: Array<{
            risk: string;
            mitigation: string;
        }>;
        estimated_effort?: {
            development_hours: number;
            testing_hours: number;
            review_hours: number;
            total_hours: number;
        };
    };

    /** Planning metrics */
    metrics: {
        durationMs: number;
        toolCalls: number;
        tokensUsed?: {
            input: number;
            output: number;
        };
    };

    /** Error if failed */
    error?: string;
}

/**
 * PRISM Agent - Planning & Refinement
 * 
 * Uses Claude Agent SDK with Bedrock for autonomous implementation planning.
 * 
 * @example
 * ```typescript
 * const agent = new PRISMAgent({
 *   repoId: 'my-project',
 * });
 * 
 * const result = await agent.plan('Add user authentication to the API');
 * console.log(result.structured?.implementation_steps);
 * ```
 */
export class PRISMAgent {
    private options: PRISMAgentOptions;
    private repoId: string;
    private repoIds: string[] = [];
    private instanceId: string;

    constructor(options: PRISMAgentOptions) {
        this.instanceId = `prism-${Date.now()}`;

        this.options = {
            timeoutMs: 30 * 60 * 1000, // 30 minutes default
            ...options,
        };

        const logContext = {
            instanceId: this.instanceId,
            hasRepoId: !!options.repoId,
            hasRepositoryPath: !!options.repositoryPath,
            timeoutMs: this.options.timeoutMs,
        };

        logger.debug(logContext, '[PRISM_INIT] Creating PRISMAgent instance');

        // Resolve repoId from either repoId or repositoryPath
        if (options.repoId) {
            this.repoId = options.repoId;
            this.repoIds = [options.repoId];

            logger.info({
                ...logContext,
                repoId: this.repoId,
                repoIds: this.repoIds,
            }, '[PRISM_REPO_DIRECT] Using provided repoId');
        } else if (options.repositoryPath) {
            // Check if this is a customer workspace with symlinks (contains /tasks/)
            if (options.repositoryPath.includes('/tasks/')) {
                logger.debug({
                    ...logContext,
                    repositoryPath: options.repositoryPath,
                }, '[PRISM_WORKSPACE_REGISTER] Registering customer workspace');

                const result = registerCustomerWorkspace(options.repositoryPath);
                this.repoId = result.workspaceId;
                this.repoIds = result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];

                logger.info({
                    ...logContext,
                    workspaceId: result.workspaceId,
                    repoIds: this.repoIds,
                    symlinkCount: result.repoIds.length,
                }, '[PRISM_WORKSPACE_REGISTERED] Customer workspace registered');
            } else {
                logger.debug({
                    ...logContext,
                    repositoryPath: options.repositoryPath,
                }, '[PRISM_REPO_REGISTER] Registering direct repository');

                this.repoId = registerRepoFromPath(options.repositoryPath);
                this.repoIds = [this.repoId];

                logger.info({
                    ...logContext,
                    repoId: this.repoId,
                }, '[PRISM_REPO_REGISTERED] Direct repository registered');
            }
        } else {
            logger.error(logContext, '[PRISM_INIT_ERROR] Missing repoId or repositoryPath');
            throw new Error('PRISMAgent requires either repoId or repositoryPath');
        }
    }

    /**
     * Create an implementation plan
     *
     * @param taskDescription - Description of what needs to be planned
     * @param additionalContext - Optional additional context
     * @returns Planning result
     */
    async plan(taskDescription: string, additionalContext?: string): Promise<PRISMPlanResult> {
        const taskId = `${this.instanceId}-${Date.now()}`;
        const startTime = Date.now();

        const logContext = {
            instanceId: this.instanceId,
            taskId,
            repoId: this.repoId,
            repoIds: this.repoIds,
        };

        logger.info({
            ...logContext,
            taskDescriptionLength: taskDescription.length,
            hasAdditionalContext: !!additionalContext,
            additionalContextLength: additionalContext?.length ?? 0,
        }, '[PRISM_PLAN_START] Starting implementation planning');

        // Build progress handler that emits events
        let progressCount = 0;
        const onProgress = (update: ProgressUpdate) => {
            progressCount++;

            if (this.options.onProgress) {
                const message = update.toolName
                    ? `Analyzing: ${update.toolName}`
                    : update.message ?? `Planning... (${update.elapsed}ms)`;
                this.options.onProgress(message);
            }

            if (this.options.eventEmitter) {
                this.options.eventEmitter.emit('agent:progress', update);
            }

            if (update.toolName) {
                logger.debug({
                    ...logContext,
                    toolName: update.toolName,
                    progressCount,
                    elapsed: update.elapsed,
                }, '[PRISM_TOOL_USE] Agent using tool');
            }
        };

        try {
            logger.debug({
                ...logContext,
                systemPromptPreview: getAgentPrompt('prism').substring(0, 100),
            }, '[PRISM_RUN_AGENT] Calling runAgent');

            const result = await runAgent({
                taskId,
                taskPrompt: taskDescription,  // Pass task description directly
                repoIds: this.repoIds,  // Use all resolved repos (for symlink workspaces)
                agentType: 'prism',
                systemAppend: getAgentPrompt('prism'),
                additionalContext,  // Pass context separately
                permissionLevel: 'code_exploration',  // Use code_exploration for better tool access
                webhookUrl: this.options.webhookUrl,
                timeoutMs: this.options.timeoutMs,
                onProgress,
                outputSchema: PRISM_OUTPUT_SCHEMA,
            });

            const durationMs = Date.now() - startTime;
            const mappedResult = this.mapResult(result);

            if (result.success) {
                logger.info({
                    ...logContext,
                    durationMs,
                    toolCalls: result.metrics.toolCalls,
                    progressUpdates: progressCount,
                    hasStructuredOutput: !!mappedResult.structured,
                    planLength: mappedResult.plan.length,
                }, '[PRISM_PLAN_SUCCESS] Implementation planning completed successfully');
            } else {
                logger.warn({
                    ...logContext,
                    durationMs,
                    error: result.error,
                }, '[PRISM_PLAN_FAILED] Implementation planning failed');
            }

            return mappedResult;
        } catch (error) {
            const durationMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logger.error({
                ...logContext,
                durationMs,
                errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined,
            }, '[PRISM_PLAN_ERROR] Exception during implementation planning');

            return {
                success: false,
                plan: '',
                metrics: {
                    durationMs,
                    toolCalls: 0,
                },
                error: errorMessage,
            };
        }
    }

    /**
     * Refine requirements into technical specifications
     */
    async refineRequirements(requirements: string): Promise<PRISMPlanResult> {
        const question = `Analyze and refine these requirements into technical specifications:\n\n${requirements}`;
        return this.plan(question);
    }

    /**
     * Break down a large task into smaller tasks
     */
    async breakdown(task: string): Promise<PRISMPlanResult> {
        const question = `Break down this task into smaller, actionable sub-tasks:\n\n${task}`;
        return this.plan(question);
    }

    /**
     * Analyze impact of a change
     */
    async analyzeImpact(changeDescription: string): Promise<PRISMPlanResult> {
        const question = `Analyze the impact of this change - what files/systems will be affected:\n\n${changeDescription}`;
        return this.plan(question);
    }

    /**
     * Create a migration plan
     */
    async planMigration(from: string, to: string, context?: string): Promise<PRISMPlanResult> {
        const question = context
            ? `Create a migration plan from ${from} to ${to}. Context: ${context}`
            : `Create a migration plan from ${from} to ${to}`;
        return this.plan(question);
    }

    /**
     * Map AgentResult to PRISMPlanResult
     */
    private mapResult(result: AgentResult): PRISMPlanResult {
        return {
            success: result.success,
            plan: result.output,
            structured: result.structuredOutput as PRISMPlanResult['structured'],
            metrics: {
                durationMs: result.metrics.durationMs,
                toolCalls: result.metrics.toolCalls,
                tokensUsed: result.metrics.tokensUsed,
            },
            error: result.error,
        };
    }
}

export default PRISMAgent;
