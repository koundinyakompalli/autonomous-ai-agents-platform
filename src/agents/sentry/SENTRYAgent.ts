/**
 * SENTRY - Safety & Execution eNtry Risk analYzer
 *
 * Uses Claude Agent SDK to review MySQL execution tickets by:
 * - Validating SQL syntax and safety
 * - Correlating SQL with HBM models and code
 * - Checking for proper rollback/backup plans
 * - Assessing risk and providing go/no-go decision
 *
 * ## Lifecycle
 * 1. [SENTRY_INIT] - Agent created with repository path or ID
 * 2. [SENTRY_REPO_REGISTER] - Repository registered in repo registry
 * 3. [SENTRY_REVIEW_START] - SQL review begins
 * 4. [SENTRY_REVIEW_COMPLETE] - Review finishes with checklist
 */

import {
    runAgent,
    getAgentPrompt,
    registerRepoFromPath,
    registerCustomerWorkspace,
    SENTRY_OUTPUT_SCHEMA,
    type AgentResult,
    type ProgressUpdate,
} from '../../claude-sdk/index.js';
import { createLogger } from '../../utils/index.js';
import type { EventEmitter } from 'events';

const logger = createLogger('sentry-agent');

export interface SENTRYAgentOptions {
    /** Repository ID (registered in repo registry) - preferred */
    repoId?: string;

    /**
     * Repository path (legacy - will auto-register and create repoId)
     * For SENTRY, this should typically point to core-app which contains
     * the MedicalMgmtModels folder with HBM mappings.
     */
    repositoryPath?: string;

    /** Optional event emitter for monitoring */
    eventEmitter?: EventEmitter;

    /** Optional progress callback */
    onProgress?: (message: string) => void;

    /** Timeout in milliseconds (default: 15 minutes) */
    timeoutMs?: number;

    /** Webhook URL for audit events */
    webhookUrl?: string;
}

/** Individual checklist item result */
export interface ChecklistItem {
    check: string;
    status: 'PASS' | 'FAIL' | 'WARN' | 'NA';
    note: string;
}

/** Checklist category with items */
export interface ChecklistCategory {
    category: string;
    items: ChecklistItem[];
}

export interface SENTRYReviewResult {
    /** Whether review completed successfully */
    success: boolean;

    /** Full review text */
    review: string;

    /** Structured review data */
    structured?: {
        /** Extracted SQL inputs */
        inputs?: {
            sql_provided: boolean;
            rollback_sql_provided: boolean;
            expected_rows_provided: boolean;
            justification_provided: boolean;
            verification_queries_provided: boolean;
        };
        /** MySQL syntax validation */
        mysql_syntax?: {
            valid_syntax: boolean;
            version_sensitive_features: boolean;
            notes?: string;
        };
        /** Code lookup results */
        code_lookup?: {
            tables_columns_exist: boolean;
            intent_matches_model: boolean;
            scope_keys_verified: boolean;
            join_determinism_verified: boolean;
            no_conflicting_logic: boolean;
            model_references?: string[];
        };
        /** Safety gate results */
        safety_gates?: {
            has_where_clause: boolean;
            predicate_scoped: boolean;
            no_dangerous_ddl: boolean;
            write_deterministic: boolean;
        };
        /** Row impact assessment */
        row_impact?: {
            where_aligns_expected: boolean;
            preview_query_exists: boolean;
        };
        /** Performance/locking assessment */
        performance?: {
            indexed_filters: boolean;
            long_transaction_addressed: boolean;
        };
        /** Rollback/recovery assessment */
        rollback?: {
            targets_same_rows: boolean;
            restores_original_values: boolean;
            snapshot_plan_exists: boolean;
        };
        /** Verification assessment */
        verification?: {
            proves_intended_state: boolean;
            detects_collateral_impact: boolean;
        };
        /** Overall risk and decision */
        risk_decision?: {
            risk_level: 'LOW' | 'MED' | 'HIGH';
            risk_rationale: string;
            decision: 'SAFE TO EXECUTE' | 'EXECUTE WITH CONDITIONS' | 'NOT SAFE' | 'NOT READY' | 'DO NOT EXECUTE';
            conditions?: string[];
        };
        /** Full checklist */
        checklist?: ChecklistCategory[];
        /** Corrected SQL statements addressing any failures */
        corrected_statements?: {
            forward_sql?: string;
            rollback_sql?: string;
            preview_query?: string;
            verification_query?: string;
            changes_made?: string[];
        };
    };

    /** Review metrics */
    metrics: {
        durationMs: number;
        toolCalls: number;
        tokensUsed?: {
            input: number;
            output: number;
            cacheRead?: number;
            cacheWrite?: number;
        };
        costUsd?: number;
    };

    /** Error if failed */
    error?: string;
}

/**
 * SENTRY Agent - Safety & Execution eNtry Risk analYzer
 *
 * Reviews MySQL execution tickets against HBM models and validates
 * safety, rollback plans, and overall risk before execution.
 *
 * @example
 * ```typescript
 * const agent = new SENTRYAgent({
 *   repoId: 'core-app',  // core-app contains MedicalMgmtModels
 * });
 *
 * const result = await agent.review(jiraTicketText, 'PatientEntity');
 * console.log(result.structured?.risk_decision?.decision);
 * ```
 */
export class SENTRYAgent {
    private options: SENTRYAgentOptions;
    private repoId: string;
    private repoIds: string[] = [];
    private instanceId: string;

    constructor(options: SENTRYAgentOptions) {
        this.instanceId = `sentry-${Date.now()}`;

        this.options = {
            timeoutMs: 15 * 60 * 1000, // 15 minutes default
            ...options,
        };

        const logContext = {
            instanceId: this.instanceId,
            hasRepoId: !!options.repoId,
            hasRepositoryPath: !!options.repositoryPath,
            timeoutMs: this.options.timeoutMs,
        };

        logger.debug(logContext, '[SENTRY_INIT] Creating SENTRYAgent instance');

        // Resolve repoId from either repoId or repositoryPath
        if (options.repoId) {
            this.repoId = options.repoId;
            this.repoIds = [options.repoId];

            logger.info({
                ...logContext,
                repoId: this.repoId,
                repoIds: this.repoIds,
            }, '[SENTRY_REPO_DIRECT] Using provided repoId');
        } else if (options.repositoryPath) {
            // Check if this is a customer workspace with symlinks (contains /tasks/)
            if (options.repositoryPath.includes('/tasks/')) {
                logger.debug({
                    ...logContext,
                    repositoryPath: options.repositoryPath,
                }, '[SENTRY_WORKSPACE_REGISTER] Registering customer workspace');

                const result = registerCustomerWorkspace(options.repositoryPath);
                this.repoId = result.workspaceId;
                this.repoIds = result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];

                logger.info({
                    ...logContext,
                    workspaceId: result.workspaceId,
                    repoIds: this.repoIds,
                    symlinkCount: result.repoIds.length,
                }, '[SENTRY_WORKSPACE_REGISTERED] Customer workspace registered');
            } else {
                logger.debug({
                    ...logContext,
                    repositoryPath: options.repositoryPath,
                }, '[SENTRY_REPO_REGISTER] Registering direct repository');

                this.repoId = registerRepoFromPath(options.repositoryPath);
                this.repoIds = [this.repoId];

                logger.info({
                    ...logContext,
                    repoId: this.repoId,
                }, '[SENTRY_REPO_REGISTERED] Direct repository registered');
            }
        } else {
            logger.error(logContext, '[SENTRY_INIT_ERROR] Missing repoId or repositoryPath');
            throw new Error('SENTRYAgent requires either repoId or repositoryPath');
        }
    }

    /**
     * Review a MySQL execution ticket
     *
     * @param ticketText - Full JIRA ticket text containing SQL, rollback, etc.
     * @param repoHints - Optional hints for locating HBM models (entity names, DAO paths)
     * @returns Review result with checklist and decision
     */
    async review(
        ticketText: string,
        repoHints?: string
    ): Promise<SENTRYReviewResult> {
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
            ticketTextLength: ticketText.length,
            hasRepoHints: !!repoHints,
            repoHintsLength: repoHints?.length ?? 0,
        }, '[SENTRY_REVIEW_START] Starting MySQL ticket review');

        // Build progress handler that emits events
        let progressCount = 0;
        const onProgress = (update: ProgressUpdate) => {
            progressCount++;

            if (this.options.onProgress) {
                const message = update.toolName
                    ? `Checking: ${update.toolName}`
                    : update.message ?? `Reviewing... (${update.elapsed}ms)`;
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
                }, '[SENTRY_TOOL_USE] Agent using tool');
            }
        };

        try {
            // Build the task prompt with ticket and optional hints
            const taskPrompt = repoHints
                ? `Review this MySQL execution ticket:\n\n${ticketText}\n\nRepo hints for HBM/model lookup:\n${repoHints}`
                : `Review this MySQL execution ticket:\n\n${ticketText}`;

            logger.debug({
                ...logContext,
                systemPromptPreview: getAgentPrompt('sentry').substring(0, 100),
            }, '[SENTRY_RUN_AGENT] Calling runAgent');

            const result = await runAgent({
                taskId,
                taskPrompt,
                repoIds: this.repoIds,
                agentType: 'sentry',
                systemAppend: getAgentPrompt('sentry'),
                permissionLevel: 'code_exploration',  // Read-only, no git needed
                webhookUrl: this.options.webhookUrl,
                timeoutMs: this.options.timeoutMs,
                onProgress,
                outputSchema: SENTRY_OUTPUT_SCHEMA,
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
                    reviewLength: mappedResult.review.length,
                    decision: mappedResult.structured?.risk_decision?.decision,
                }, '[SENTRY_REVIEW_SUCCESS] MySQL ticket review completed successfully');
            } else {
                logger.warn({
                    ...logContext,
                    durationMs,
                    error: result.error,
                }, '[SENTRY_REVIEW_FAILED] MySQL ticket review failed');
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
            }, '[SENTRY_REVIEW_ERROR] Exception during MySQL ticket review');

            return {
                success: false,
                review: '',
                metrics: {
                    durationMs,
                    toolCalls: 0,
                },
                error: errorMessage,
            };
        }
    }

    /**
     * Quick safety check (faster, less thorough)
     * Only checks critical safety gates without deep code lookup
     */
    async quickSafetyCheck(sql: string): Promise<SENTRYReviewResult> {
        const taskId = `${this.instanceId}-quick-${Date.now()}`;

        const logContext = {
            instanceId: this.instanceId,
            taskId,
            repoId: this.repoId,
        };

        logger.info({
            ...logContext,
            sqlLength: sql.length,
        }, '[SENTRY_QUICK_START] Starting quick safety check');

        const startTime = Date.now();

        try {
            const result = await runAgent({
                taskId,
                taskPrompt: `Quick safety check for this SQL (no deep code analysis needed):\n\n${sql}`,
                repoIds: this.repoIds,
                agentType: 'sentry',
                systemAppend: getAgentPrompt('sentry') + '\n\nThis is a QUICK safety check - focus only on MySQL syntax and safety gates. Skip code lookup.',
                permissionLevel: 'code_exploration',
                timeoutMs: 3 * 60 * 1000, // 3 minutes for quick check
            });

            const durationMs = Date.now() - startTime;

            logger.info({
                ...logContext,
                durationMs,
                success: result.success,
            }, '[SENTRY_QUICK_COMPLETE] Quick safety check completed');

            return this.mapResult(result);
        } catch (error) {
            const durationMs = Date.now() - startTime;

            logger.error({
                ...logContext,
                durationMs,
                error: error instanceof Error ? error.message : 'Unknown',
            }, '[SENTRY_QUICK_ERROR] Quick safety check failed');

            return {
                success: false,
                review: '',
                metrics: {
                    durationMs,
                    toolCalls: 0,
                },
                error: error instanceof Error ? error.message : 'Unknown error',
            };
        }
    }

    /**
     * Validate SQL against a specific HBM model
     */
    async validateAgainstModel(sql: string, modelName: string): Promise<SENTRYReviewResult> {
        const question = `Validate this SQL against the ${modelName} HBM model:\n\n${sql}`;
        return this.review(question, modelName);
    }

    /**
     * Map AgentResult to SENTRYReviewResult
     */
    private mapResult(result: AgentResult): SENTRYReviewResult {
        return {
            success: result.success,
            review: result.output,
            structured: result.structuredOutput as SENTRYReviewResult['structured'],
            metrics: {
                durationMs: result.metrics.durationMs,
                toolCalls: result.metrics.toolCalls,
                tokensUsed: result.metrics.tokensUsed,
                costUsd: result.metrics.costUsd,
            },
            error: result.error,
        };
    }
}

export default SENTRYAgent;
