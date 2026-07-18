/**
 * SCRIBE - Simple Clear Rundown of Implementations, Behavior, and Endpoints
 *
 * Uses Claude Agent SDK to explain how code functionality works by:
 * - Reading and understanding code
 * - Tracing execution flow
 * - Providing clear explanations with examples
 *
 * ## Lifecycle
 * 1. [SCRIBE_INIT] - Agent created with repository path or ID
 * 2. [SCRIBE_REPO_REGISTER] - Repository registered in repo registry
 * 3. [SCRIBE_EXPLAIN_START] - Explanation begins
 * 4. [SCRIBE_EXPLAIN_COMPLETE] - Explanation finishes
 */

import {
    runAgent,
    getAgentPrompt,
    registerRepoFromPath,
    registerCustomerWorkspace,
    SCRIBE_OUTPUT_SCHEMA,
    type AgentResult,
    type ProgressUpdate,
} from '../../claude-sdk/index.js';
import { createLogger } from '../../utils/index.js';
import type { EventEmitter } from 'events';
import path from 'node:path';

const logger = createLogger('scribe-agent');

const SCRIBE_TOOL_BUDGET_TOOLS = ['Read', 'Glob', 'Grep'];

function buildClaudeConfigDir(taskId: string): string {
    return path.join(
        process.env.CLAUDE_AGENT_CONFIG_BASE_DIR || '/tmp/specter-claude-sessions',
        'scribe',
        taskId,
    );
}

export interface SCRIBEAgentOptions {
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

    /** Timeout in milliseconds (default: 20 minutes) */
    timeoutMs?: number;

    /** Webhook URL for audit events */
    webhookUrl?: string;
}

export interface SCRIBEExplanationResult {
    /** Whether explanation completed successfully */
    success: boolean;

    /** Full explanation text */
    explanation: string;

    /** Structured explanation data */
    structured?: {
        summary: string;
        how_it_works?: {
            overview: string;
            key_components: Array<{
                name: string;
                file_path: string;
                purpose: string;
                how: string;
            }>;
            execution_flow: string[];
        };
        code_examples?: Array<{
            description: string;
            code: string;
            language: string;
        }>;
        key_concepts?: Array<{
            concept: string;
            explanation: string;
        }>;
    };

    /** Explanation metrics */
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
 * SCRIBE Agent - Code explanation agent
 * 
 * Uses Claude Agent SDK with Bedrock for autonomous code explanation.
 * 
 * @example
 * ```typescript
 * const agent = new SCRIBEAgent({
 *   repoId: 'my-project',
 * });
 * 
 * const result = await agent.explain('How does the authentication middleware work?');
 * console.log(result.structured?.summary);
 * ```
 */
export class SCRIBEAgent {
    private options: SCRIBEAgentOptions;
    private repoId: string;
    private repoIds: string[] = [];
    private instanceId: string;

    constructor(options: SCRIBEAgentOptions) {
        this.instanceId = `scribe-${Date.now()}`;

        this.options = {
            timeoutMs: 20 * 60 * 1000, // 20 minutes — multi-repo explanations can need near-DARCI runtime
            ...options,
        };

        const logContext = {
            instanceId: this.instanceId,
            hasRepoId: !!options.repoId,
            hasRepositoryPath: !!options.repositoryPath,
            timeoutMs: this.options.timeoutMs,
        };

        logger.debug(logContext, '[SCRIBE_INIT] Creating SCRIBEAgent instance');

        // Resolve repoId from either repoId or repositoryPath
        if (options.repoId) {
            this.repoId = options.repoId;
            this.repoIds = [options.repoId];

            logger.info({
                ...logContext,
                repoId: this.repoId,
                repoIds: this.repoIds,
            }, '[SCRIBE_REPO_DIRECT] Using provided repoId');
        } else if (options.repositoryPath) {
            // Check if this is a customer workspace with symlinks (contains /tasks/)
            if (options.repositoryPath.includes('/tasks/')) {
                logger.debug({
                    ...logContext,
                    repositoryPath: options.repositoryPath,
                }, '[SCRIBE_WORKSPACE_REGISTER] Registering customer workspace');

                const result = registerCustomerWorkspace(options.repositoryPath);
                this.repoId = result.workspaceId;
                this.repoIds = result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];

                logger.info({
                    ...logContext,
                    workspaceId: result.workspaceId,
                    repoIds: this.repoIds,
                    symlinkCount: result.repoIds.length,
                }, '[SCRIBE_WORKSPACE_REGISTERED] Customer workspace registered');
            } else {
                logger.debug({
                    ...logContext,
                    repositoryPath: options.repositoryPath,
                }, '[SCRIBE_REPO_REGISTER] Registering direct repository');

                this.repoId = registerRepoFromPath(options.repositoryPath);
                this.repoIds = [this.repoId];

                logger.info({
                    ...logContext,
                    repoId: this.repoId,
                }, '[SCRIBE_REPO_REGISTERED] Direct repository registered');
            }
        } else {
            logger.error(logContext, '[SCRIBE_INIT_ERROR] Missing repoId or repositoryPath');
            throw new Error('SCRIBEAgent requires either repoId or repositoryPath');
        }
    }

    /**
     * Explain code functionality
     *
     * @param question - What to explain
     * @param additionalContext - Optional additional context
     * @returns Explanation result
     */
    async explain(question: string, additionalContext?: string): Promise<SCRIBEExplanationResult> {
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
            questionLength: question.length,
            hasAdditionalContext: !!additionalContext,
            additionalContextLength: additionalContext?.length ?? 0,
        }, '[SCRIBE_EXPLAIN_START] Starting code explanation');

        // Build progress handler that emits events
        let progressCount = 0;
        const onProgress = (update: ProgressUpdate) => {
            progressCount++;

            if (this.options.onProgress) {
                const message = update.toolName
                    ? `Reading: ${update.toolName}`
                    : update.message ?? `Analyzing... (${update.elapsed}ms)`;
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
                }, '[SCRIBE_TOOL_USE] Agent using tool');
            }
        };

        try {
            logger.debug({
                ...logContext,
                systemPromptPreview: getAgentPrompt('scribe').substring(0, 100),
            }, '[SCRIBE_RUN_AGENT] Calling runAgent');

            const result = await runAgent({
                taskId,
                taskPrompt: question,
                repoIds: this.repoIds,  // Use all resolved repos (for symlink workspaces)
                agentType: 'scribe',
                sdkStage: 'scribe_explanation',
                systemAppend: getAgentPrompt('scribe'),
                additionalContext,
                permissionLevel: 'code_exploration',  // Use code_exploration for better tool access
                webhookUrl: this.options.webhookUrl,
                timeoutMs: this.options.timeoutMs,
                maxTurns: 100,
                maxBudgetUsd: 6,
                includePartialMessages: true,
                idleTimeoutMs: 180_000,
                postToolIdleTimeoutMs: 90_000,
                toolIdleTimeoutMs: 600_000,
                sdkTraceMode: 'failure',
                claudeConfigDir: buildClaudeConfigDir(taskId),
                bedrockConfig: {
                    maxOutputTokens: 50_000,
                    maxThinkingTokens: 2_048,
                },
                toolSprawlGuard: {
                    enabled: true,
                    maxRepeatedSearches: 2,
                    maxBroadSearches: 4,
                },
                toolBudgetGuard: {
                    enabled: true,
                    tools: SCRIBE_TOOL_BUDGET_TOOLS,
                    maxCalls: 90,
                    message:
                        'SCRIBE tool budget reached. Stop searching and return the clearest explanation from gathered evidence, marking any uncertainty explicitly.',
                },
                onProgress,
                outputSchema: SCRIBE_OUTPUT_SCHEMA,
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
                    explanationLength: mappedResult.explanation.length,
                }, '[SCRIBE_EXPLAIN_SUCCESS] Code explanation completed successfully');
            } else {
                logger.warn({
                    ...logContext,
                    durationMs,
                    error: result.error,
                }, '[SCRIBE_EXPLAIN_FAILED] Code explanation failed');
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
            }, '[SCRIBE_EXPLAIN_ERROR] Exception during code explanation');

            return {
                success: false,
                explanation: '',
                metrics: {
                    durationMs,
                    toolCalls: 0,
                },
                error: errorMessage,
            };
        }
    }

    /**
     * Explain an API endpoint
     */
    async explainEndpoint(endpoint: string, method: string = 'GET'): Promise<SCRIBEExplanationResult> {
        const question = `Explain the ${method} ${endpoint} API endpoint - what does it do, what are the parameters, and what does it return?`;
        return this.explain(question);
    }

    /**
     * Explain a function or method
     */
    async explainFunction(functionName: string, filePath?: string): Promise<SCRIBEExplanationResult> {
        const question = filePath
            ? `Explain the function '${functionName}' in ${filePath} - what does it do, what are the inputs/outputs?`
            : `Find and explain the function '${functionName}' - what does it do, what are the inputs/outputs?`;
        return this.explain(question);
    }

    /**
     * Explain a class or module
     */
    async explainClass(className: string): Promise<SCRIBEExplanationResult> {
        const question = `Explain the class/module '${className}' - what is its purpose, what are its key methods, and how does it fit into the architecture?`;
        return this.explain(question);
    }

    /**
     * Map AgentResult to SCRIBEExplanationResult
     */
    private mapResult(result: AgentResult): SCRIBEExplanationResult {
        return {
            success: result.success,
            explanation: result.output,
            structured: result.structuredOutput as SCRIBEExplanationResult['structured'],
            metrics: {
                durationMs: result.metrics.durationMs,
                toolCalls: result.metrics.toolCalls,
                tokensUsed: result.metrics.tokensUsed,
            },
            error: result.error,
        };
    }
}

export default SCRIBEAgent;
