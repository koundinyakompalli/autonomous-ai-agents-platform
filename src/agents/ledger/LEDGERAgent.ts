/**
 * LEDGER - Level-of-Effort Data Guidance Estimation Reporter
 *
 * Hybrid agent: deterministic JIRA evidence collection + Claude SDK LOE analysis.
 *
 * Covers four work types using the repos actually provisioned into the task workspace:
 *   - Data loads / schema changes → core-app HBM models + any available import repos
 *   - Data extracts               → any available extract repos + core-app HBM models
 *   - Queue/routing               → core-app + batch-jobs + client-services when present
 *   - BI/datamart                 → any available BI/datamart repo
 *
 * ## Lifecycle
 * 1. [LEDGER_INIT]              - Agent created, repos registered
 * 2. [LEDGER_REPO_REGISTER]     - Register workspace and detect available repos
 * 4. [LEDGER_ANALYZE]           - Claude SDK performs deep analysis
 * 5. [LEDGER_COMPLETE]          - Return LOE report markdown
 */

import fs from 'fs';
import path from 'path';
import {
    runAgent,
    getAgentPrompt,
    registerRepoFromPath,
    registerCustomerWorkspace,
    type AgentResult,
    type ProgressUpdate,
} from '../../claude-sdk/index.js';
import { createLogger } from '../../utils/index.js';
import type { EventEmitter } from 'events';
import type { LedgerAgentOptions, LedgerResult, LedgerTaskCategory } from './types.js';

const logger = createLogger('ledger-agent');

type LedgerRepoCategory =
    | 'core'
    | 'batch'
    | 'client_services'
    | 'data_import'
    | 'data_extract'
    | 'bi_datamart';

interface RepoSignalDefinition {
    category: LedgerRepoCategory;
    displayName: string;
    aliases: string[];
    signals: string[];
}

/**
 * Keywords that signal which workspace repos are relevant for a given ticket.
 *
 * LEDGER only uses repos that are actually provisioned into the task workspace.
 * That keeps the analysis branch-aware and aligned with current orchestrator
 * worktree behavior instead of reaching into shared repo roots directly.
 */
const REPO_SIGNAL_DEFINITIONS: RepoSignalDefinition[] = [
    {
        category: 'core',
        displayName: 'core-app',
        aliases: ['core-app', 'cp-medhok-monorepo'],
        signals: [],
    },
    {
        category: 'batch',
        displayName: 'batch-jobs',
        aliases: ['batch-jobs', 'cp-batch-monorepo'],
        signals: [
            'batch', 'job', 'scheduler', 'cron', 'queue monitor', 'auto-tasking',
            'correspondence', 'fax intake', 'workflow', 'assessment',
            'queue routing', 'queue update', 'queue_authorization', 'incoming_image_config',
        ],
    },
    {
        category: 'client_services',
        displayName: 'client-services',
        aliases: ['client-services', 'cp-client-services-monorepo'],
        signals: [
            'client service', 'web service', 'api', 'rest', 'soap', 'endpoint',
            'integration', 'external', 'client-facing',
        ],
    },
    {
        category: 'data_import',
        displayName: 'cp-medhok-data-import-monorepo',
        aliases: ['cp-medhok-data-import-monorepo'],
        signals: [
            'import', 'loader', 'data load', 'onboard', 'ingest', 'bulk insert',
            'client data', 'eligibility load', 'member load', 'provider load',
        ],
    },
    {
        category: 'data_extract',
        displayName: 'cp-medhok-data-extract-monorepo',
        aliases: ['cp-medhok-data-extract-monorepo'],
        signals: [
            'extract', 'export', 'outbound', 'feed', 'file generation',
            'data extract', 'csv', 'flat file', 'sftp',
        ],
    },
    {
        category: 'bi_datamart',
        displayName: 'cp-medhok-bi-datamart-monorepo',
        aliases: ['cp-medhok-bi-datamart-monorepo'],
        signals: [
            'bi', 'datamart', 'data mart', 'warehouse', 'analytics', 'reporting',
            'dashboard', 'tableau', 'cognos', 'mart',
        ],
    },
];

export interface LedgerRepoSelection {
    availableWorkspaceRepos: string[];
    selectedRepos: string[];
    unavailableExpectedRepos: string[];
}

function normalizeRepoName(value: string): string {
    return value.trim().toLowerCase();
}

function inferRepoNameFromPath(repoPath: string): string {
    const normalized = repoPath.replace(/\\/g, '/');
    const parts = normalized.split('/').filter(Boolean);
    const repositoriesIndex = parts.lastIndexOf('repositories');

    if (repositoriesIndex >= 0 && repositoriesIndex + 1 < parts.length) {
        const firstSegment = parts[repositoriesIndex + 1];
        if (firstSegment === 'tasks') {
            return parts[parts.length - 1] || 'workspace';
        }

        return firstSegment;
    }

    return path.basename(normalized) || 'workspace';
}

export function discoverLedgerWorkspaceRepos(repositoryPath: string): string[] {
    try {
        if (repositoryPath.includes('/tasks/')) {
            const entries = fs.readdirSync(repositoryPath, { withFileTypes: true });
            return entries
                .filter((entry) => !entry.name.startsWith('.') && entry.name !== 'config')
                .filter((entry) => entry.isSymbolicLink() || entry.isDirectory())
                .map((entry) => entry.name)
                .sort();
        }

        return [inferRepoNameFromPath(repositoryPath)];
    } catch {
        return [];
    }
}

export function selectLedgerWorkspaceRepos(
    ticketText: string,
    availableWorkspaceRepos: string[],
): LedgerRepoSelection {
    const normalizedText = ticketText.toLowerCase();
    const availableByNormalizedName = new Map(
        availableWorkspaceRepos.map((repoName) => [normalizeRepoName(repoName), repoName] as const),
    );
    const selectedRepos = new Set<string>();
    const unavailableExpectedRepos = new Set<string>();

    const resolveAvailableAlias = (aliases: string[]): string | null => {
        for (const alias of aliases) {
            const match = availableByNormalizedName.get(normalizeRepoName(alias));
            if (match) {
                return match;
            }
        }
        return null;
    };

    for (const definition of REPO_SIGNAL_DEFINITIONS) {
        const shouldInclude =
            definition.category === 'core' ||
            definition.signals.some((signal) => normalizedText.includes(signal));

        if (!shouldInclude) {
            continue;
        }

        const availableRepo = resolveAvailableAlias(definition.aliases);
        if (availableRepo) {
            selectedRepos.add(availableRepo);
        } else {
            unavailableExpectedRepos.add(definition.displayName);
        }
    }

    return {
        availableWorkspaceRepos: [...availableWorkspaceRepos],
        selectedRepos: [...selectedRepos],
        unavailableExpectedRepos: [...unavailableExpectedRepos],
    };
}

export class LEDGERAgent {
    private options: LedgerAgentOptions;
    private repoIds: string[] = [];
    private reposConsulted: string[] = [];
    private availableWorkspaceRepos: string[] = [];
    private unavailableExpectedRepos: string[] = [];
    private instanceId: string;

    constructor(options: LedgerAgentOptions) {
        this.instanceId = `ledger-${Date.now()}`;
        this.options = {
            timeoutMs: 15 * 60 * 1000, // 15 minutes
            ...options,
        };

        logger.debug({
            instanceId: this.instanceId,
            hasRepoId: !!options.repoId,
            hasRepositoryPath: !!options.repositoryPath,
        }, '[LEDGER_INIT] Creating LEDGERAgent instance');

        // Register the provided workspace/repo (core-app or task workspace)
        if (options.repoId) {
            this.repoIds = [options.repoId];
        } else if (options.repositoryPath) {
            this.availableWorkspaceRepos = discoverLedgerWorkspaceRepos(options.repositoryPath);

            if (options.repositoryPath.includes('/tasks/')) {
                const result = registerCustomerWorkspace(options.repositoryPath);
                this.repoIds = [
                    result.workspaceId,
                    ...result.repoIds,
                ];
            } else {
                const id = registerRepoFromPath(options.repositoryPath);
                this.repoIds = [id];
            }
        }
    }

    /**
     * Select the relevant repos that are already provisioned into the task workspace.
     * Never reaches into shared repo roots directly; if a useful repo is not present
     * in the workspace, LEDGER records that gap and tells the model to call it out.
     */
    private selectWorkspaceRepos(ticketText: string): void {
        const selection = selectLedgerWorkspaceRepos(ticketText, this.availableWorkspaceRepos);
        this.reposConsulted = selection.selectedRepos;
        this.unavailableExpectedRepos = selection.unavailableExpectedRepos;

        logger.info({
            instanceId: this.instanceId,
            availableWorkspaceRepos: this.availableWorkspaceRepos,
            reposConsulted: this.reposConsulted,
            unavailableExpectedRepos: this.unavailableExpectedRepos,
            repoIds: this.repoIds,
        }, '[LEDGER_REPOS_SELECTED] Workspace repos selected for analysis');
    }

    /**
     * Run the LEDGER analysis pipeline:
     * 1. Register repos based on ticket signals
     * 2. Build analysis prompt from ticket description + JIRA context
     * 3. Claude SDK performs deep codebase analysis
     * 4. Return structured LOE report with SQL (if needed), test cases, clarifications
     */
    async analyze(
        jiraNumber: string,
        taskDescription: string,
        additionalContext?: string,
    ): Promise<LedgerResult> {
        const taskId = `${this.instanceId}-${jiraNumber}`;
        const startTime = Date.now();

        const logContext = {
            instanceId: this.instanceId,
            taskId,
            jiraNumber,
        };

        logger.info(logContext, '[LEDGER_ANALYZE_START] Starting LEDGER LOE analysis');

        try {
            // Phase 1: Select relevant repos from the branch-aware task workspace
            const evidenceCollectionStart = Date.now();
            const combinedText = `${taskDescription} ${additionalContext ?? ''}`;
            this.selectWorkspaceRepos(combinedText);
            const evidenceCollectionMs = Date.now() - evidenceCollectionStart;

            logger.info({
                ...logContext,
                availableWorkspaceRepos: this.availableWorkspaceRepos,
                reposConsulted: this.reposConsulted,
                unavailableExpectedRepos: this.unavailableExpectedRepos,
                repoIds: this.repoIds,
                evidenceCollectionMs,
            }, '[LEDGER_REPOS_READY] Repos registered, starting Claude SDK analysis');

            // Phase 2: Build task prompt
            const taskPrompt = this.buildTaskPrompt(jiraNumber, taskDescription, additionalContext);

            // Phase 3: Run Claude SDK analysis
            const analysisStart = Date.now();

            const onProgress = (update: ProgressUpdate) => {
                if (this.options.onProgress) {
                    const message = update.toolName
                        ? `Analyzing: ${update.toolName}`
                        : update.message ?? `Generating LOE analysis... (${update.elapsed}ms)`;
                    this.options.onProgress(message);
                }
                if (this.options.eventEmitter) {
                    this.options.eventEmitter.emit('agent:progress', update);
                }
            };

            const result: AgentResult = await runAgent({
                taskId,
                taskPrompt,
                repoIds: this.repoIds.length > 0 ? this.repoIds : ['__no_repo__'],
                agentType: 'ledger' as any,
                systemAppend: getAgentPrompt('ledger' as any),
                permissionLevel: 'code_exploration' as const,
                webhookUrl: this.options.webhookUrl,
                timeoutMs: this.options.timeoutMs,
                onProgress,
                bedrockConfig: {
                    region: process.env.AWS_REGION || 'us-east-1',
                    maxOutputTokens: 16384,
                },
            });

            const analysisMs = Date.now() - analysisStart;
            const durationMs = Date.now() - startTime;

            if (!result.success) {
                logger.error({
                    ...logContext,
                    error: result.error,
                    durationMs,
                }, '[LEDGER_ANALYZE_FAILED] Claude SDK returned failure');

                return {
                    success: false,
                    loeReport: '',
                    taskCategories: ['unknown'],
                    reposConsulted: this.reposConsulted,
                    metrics: { durationMs, evidenceCollectionMs, analysisMs },
                    error: result.error || 'LEDGER analysis failed',
                };
            }

            logger.info({
                ...logContext,
                durationMs,
                analysisMs,
                toolCalls: result.metrics.toolCalls,
                outputLength: result.output.length,
                reposConsulted: this.reposConsulted,
            }, '[LEDGER_ANALYZE_SUCCESS] LEDGER analysis completed');

            return {
                success: true,
                loeReport: result.output,
                taskCategories: this.detectCategories(combinedText),
                reposConsulted: this.reposConsulted,
                metrics: {
                    durationMs,
                    evidenceCollectionMs,
                    analysisMs,
                    toolCalls: result.metrics.toolCalls,
                    tokensUsed: result.metrics.tokensUsed,
                    costUsd: result.metrics.costUsd,
                },
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logger.error({
                ...logContext,
                durationMs,
                errorMessage,
            }, '[LEDGER_ANALYZE_ERROR] Exception during LEDGER analysis');

            return {
                success: false,
                loeReport: '',
                taskCategories: ['unknown'],
                reposConsulted: this.reposConsulted,
                metrics: { durationMs },
                error: errorMessage,
            };
        }
    }

    private buildTaskPrompt(
        jiraNumber: string,
        taskDescription: string,
        additionalContext?: string,
    ): string {
        const lines = [
            `Perform a complete LEDGER LOE analysis for JIRA ticket ${jiraNumber}.`,
            ``,
            `## Ticket Description`,
            ``,
            taskDescription,
        ];

        if (additionalContext) {
            lines.push(``, `## Additional Context`, ``, additionalContext);
        }

        lines.push(
            ``,
            `## Repositories Available`,
            ``,
            `Use only the repos that are provisioned in the current task workspace. Do not assume access to any shared repo root that is not listed here.`,
            ``,
            `The following repositories are registered and accessible via workspace-relative paths with Read/Glob/Grep:`,
            ...(this.reposConsulted.length > 0
                ? this.reposConsulted.map(r => `- \`${r}\``)
                : ['- No additional repo-specific symlinks were provisioned beyond the current workspace context.']),
            ``,
            `Use these repos to:`,
            `- Verify table/column existence in HBM model files (usually \`core-app/MedicalMgmtModels/\`)`,
            `- Check if flyway migrations are needed for new columns (usually \`core-app/flyway/sql/\`)`,
            `- Inspect batch jobs consuming queue tables (typically \`batch-jobs/\` when present)`,
            `- Inspect client-facing service layer for API impact (typically \`client-services/\` when present)`,
            `- Inspect any loader/extract/datamart repos only if they are explicitly present in this workspace`,
            `- Verify queue routing logic and group IDs through the repo(s) that are actually available here`,
        );

        if (this.unavailableExpectedRepos.length > 0) {
            lines.push(
                ``,
                `## Expected But Unavailable Repositories`,
                ``,
                `The ticket text suggests these repos may matter, but they were not provisioned in the current branch-aware task workspace:`,
                ...this.unavailableExpectedRepos.map(r => `- \`${r}\``),
                ``,
                `Do not assume their contents. Call this out explicitly under "Clarifications Needed" or "Impact Assessment" if it materially affects confidence or scope.`,
            );
        }

        lines.push(
            ``,
            `## Workspace Path Rules`,
            ``,
            `Use workspace-relative paths exactly as they appear above (for example \`core-app/MedicalMgmtModels/... \` or \`batch-jobs/... \`).`,
            `Do not reference direct shared-root locations like \`/mnt/efs/specter-repo/repositories/<repo>\` in the report.`,
        );

        return lines.join('\n');
    }

    private detectCategories(text: string): LedgerTaskCategory[] {
        const t = text.toLowerCase();
        const categories: LedgerTaskCategory[] = [];

        if (['import', 'loader', 'data load', 'onboard', 'ingest'].some(s => t.includes(s)))
            categories.push('data_load');
        if (['extract', 'export', 'outbound', 'feed', 'flat file'].some(s => t.includes(s)))
            categories.push('data_extract');
        if (['queue_authorization', 'incoming_image_config', 'routing', 'intake queue'].some(s => t.includes(s)))
            categories.push('queue_update');
        if (['alter table', 'flyway', 'add column', 'schema'].some(s => t.includes(s)))
            categories.push('schema_change');
        if (['product_group', 'sla_master', 'sla_bundle', 'system_variable', 'config'].some(s => t.includes(s)))
            categories.push('config_change');
        if (['bi', 'datamart', 'data mart', 'warehouse'].some(s => t.includes(s)))
            categories.push('bi_datamart');

        return categories.length > 0 ? categories : ['unknown'];
    }
}

export default LEDGERAgent;
