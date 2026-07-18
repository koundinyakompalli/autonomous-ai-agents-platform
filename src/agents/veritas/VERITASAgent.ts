/**
 * VERITAS - Verified Evidence-based Root-cause Investigation Truth & Analysis System
 *
 * Hybrid agent: deterministic evidence collection + Claude SDK RCA generation.
 *
 * ## Lifecycle
 * 1. [VERITAS_INIT] - Agent created with options
 * 2. [VERITAS_EVIDENCE_COLLECT] - Phase 1: Fetch SEN + linked tickets from JIRA
 * 3. [VERITAS_RCA_GENERATE] - Phase 2: Claude SDK generates 6-section RCA
 * 4. [VERITAS_LABELS_MANAGE] - Phase 3: Remove VERITAS, add VERITAS-COMPLETED + RCA-AVAILABLE
 * 5. [VERITAS_COMPLETE] - Return RCA markdown
 */

import fs from 'fs';
import path from 'path';
import {
    runAgent,
    getAgentPrompt,
    registerRepo,
    registerRepoFromPath,
    registerCustomerWorkspace,
    type AgentResult,
    type ProgressUpdate,
} from '../../claude-sdk/index.js';
import { createLogger } from '../../utils/index.js';
import { VERITASJiraService } from './VERITASJiraService.js';
import { EvidenceCollector } from './EvidenceCollector.js';
import type { EvidencePackage, VERITASAgentOptions, VERITASResult } from './types.js';
import type { EventEmitter } from 'events';

const logger = createLogger('veritas-agent');

/** Maps evidence hints to repository directory names on EFS */
const REPO_HINT_MAP: Record<string, string[]> = {
    // JIRA project keys
    'CPCLIENT':          ['client-services', 'core-app'],
    'SEN':               ['core-app'],

    // Component / module names
    'web-services':      ['core-app'],
    'mm-web-services':   ['core-app'],
    'shared-services':   ['core-app'],
    'mm-shared-services':['core-app'],
    'business-layer':    ['core-app'],

    'batch-jobs':        ['batch-jobs'],
    'fax-intake':        ['batch-jobs'],
    'queue-monitor':     ['batch-jobs'],
    'auto-tasking':      ['batch-jobs'],
    'correspondence':    ['batch-jobs'],
    'assessments':       ['batch-jobs'],
    'workflow':          ['batch-jobs'],

    'provider-portal':   ['provider-portal'],
    'react':             ['React-based-new-ui'],
    'ocr':               ['React-based-new-ui', 'Document-ai'],
    'md-review':         ['React-based-new-ui'],
    'document-ai':       ['Document-ai'],

    // Java package patterns
    'com.medhok':        ['core-app'],
    'com.medhok.batch':  ['batch-jobs'],
    'MedicalMgmt':       ['core-app'],
};

/** Default EFS base path for repositories */
const EFS_BASE_PATH = '/mnt/efs/specter-repo/repositories';

export class VERITASAgent {
    private options: VERITASAgentOptions;
    private repoId: string | null = null;
    private repoIds: string[] = [];
    private instanceId: string;
    private jira: VERITASJiraService;
    private evidenceCollector: EvidenceCollector;

    constructor(options: VERITASAgentOptions) {
        this.instanceId = `veritas-${Date.now()}`;

        this.options = {
            timeoutMs: 20 * 60 * 1000, // 20 minutes default
            ...options,
        };

        const logContext = {
            instanceId: this.instanceId,
            hasRepoId: !!options.repoId,
            hasRepositoryPath: !!options.repositoryPath,
            timeoutMs: this.options.timeoutMs,
        };

        logger.debug(logContext, '[VERITAS_INIT] Creating VERITASAgent instance');

        // Initialize JIRA service — prefer DB values passed via options, fall back to env vars
        const jiraBaseUrl = process.env.JIRA_BASE_URL || 'https://medhokapps.atlassian.net';
        const jiraUsername = options.jiraUsername || process.env.JIRA_USERNAME || '';
        const jiraToken = options.jiraToken || process.env.JIRA_TOKEN || '';
        this.jira = new VERITASJiraService(jiraBaseUrl, jiraUsername, jiraToken);
        this.evidenceCollector = new EvidenceCollector(this.jira);

        // Resolve repo if provided (optional for VERITAS — works without repos too)
        if (options.repoId) {
            this.repoId = options.repoId;
            this.repoIds = [options.repoId];

            logger.info({
                ...logContext,
                repoId: this.repoId,
            }, '[VERITAS_REPO_DIRECT] Using provided repoId');
        } else if (options.repositoryPath) {
            if (options.repositoryPath.includes('/tasks/')) {
                const result = registerCustomerWorkspace(options.repositoryPath);
                this.repoId = result.workspaceId;
                this.repoIds = result.repoIds.length > 0 ? result.repoIds : [result.workspaceId];

                logger.info({
                    ...logContext,
                    workspaceId: result.workspaceId,
                    repoIds: this.repoIds,
                }, '[VERITAS_WORKSPACE_REGISTERED] Customer workspace registered');
            } else {
                this.repoId = registerRepoFromPath(options.repositoryPath);
                this.repoIds = [this.repoId];

                logger.info({
                    ...logContext,
                    repoId: this.repoId,
                }, '[VERITAS_REPO_REGISTERED] Repository registered');
            }
        } else {
            logger.info(logContext, '[VERITAS_NO_REPO] No repository configured — RCA will use JIRA evidence only');
        }
    }

    /**
     * Phase 1.5: Discover repos on EFS based on evidence hints and register them.
     *
     * For each hint from the evidence, maps it to repo directory names via REPO_HINT_MAP,
     * then checks EFS paths in priority order:
     *   1. Customer workspace (task-{id}/{repo}) — already symlinked
     *   2. Customer worktree ({repo}/{branch}/) — branch-specific
     *   3. Master fallback ({repo}/) — always exists
     *
     * Always includes core-app as a fallback.
     */
    private discoverAndRegisterRepos(evidence: EvidencePackage, additionalContext?: string): string[] {
        const hints = evidence.repoHints;
        const customerBranch = this.parseCustomerBranch(additionalContext);

        logger.info({
            instanceId: this.instanceId,
            hints,
            customerBranch,
            existingRepoIds: this.repoIds,
        }, '[VERITAS_REPO_DISCOVER_START] Phase 1.5: Discovering repos from evidence');

        // If we already have repos registered (orchestrator found them), skip discovery
        if (this.repoIds.length > 0) {
            logger.info({
                instanceId: this.instanceId,
                repoIds: this.repoIds,
            }, '[VERITAS_REPO_DISCOVER_SKIP] Repos already registered by orchestrator');
            return this.repoIds;
        }

        // Map hints to unique repo directory names
        const repoNames = new Set<string>();
        for (const hint of hints) {
            const mapped = REPO_HINT_MAP[hint];
            if (mapped) {
                for (const name of mapped) repoNames.add(name);
            }
        }

        // Always include core-app as fallback
        repoNames.add('core-app');

        logger.info({
            instanceId: this.instanceId,
            repoNames: Array.from(repoNames),
        }, '[VERITAS_REPO_DISCOVER_MAPPED] Mapped hints to repo names');

        // Discover each repo on EFS
        const discoveredRepoIds: string[] = [];
        const repoBasePath = this.options.repositoryPath || EFS_BASE_PATH;

        for (const repoName of repoNames) {
            const repoId = this.findAndRegisterRepo(repoName, repoBasePath, customerBranch);
            if (repoId) {
                discoveredRepoIds.push(repoId);
            }
        }

        logger.info({
            instanceId: this.instanceId,
            discoveredRepoIds,
            discoveredCount: discoveredRepoIds.length,
        }, '[VERITAS_REPO_DISCOVER_COMPLETE] Phase 1.5 complete');

        return discoveredRepoIds;
    }

    /**
     * Find a repo on EFS and register it. Checks paths in priority order:
     * 1. Workspace task path (repoBasePath/{repoName} when basePath is a task dir)
     * 2. Customer worktree ({repoName}/{branch}/)
     * 3. Master/root fallback ({repoName}/)
     */
    private findAndRegisterRepo(repoName: string, repoBasePath: string, customerBranch?: string): string | null {
        const pathsToCheck: Array<{ label: string; repoPath: string }> = [];

        // If repoBasePath is a task workspace, check for the repo directly inside it
        if (repoBasePath.includes('/tasks/')) {
            pathsToCheck.push({
                label: 'workspace',
                repoPath: path.join(repoBasePath, repoName),
            });
        }

        // Customer worktree: /mnt/efs/specter-repo/repositories/{repo}/{branch}/
        if (customerBranch) {
            pathsToCheck.push({
                label: 'worktree',
                repoPath: path.join(EFS_BASE_PATH, repoName, customerBranch),
            });
        }

        // Default-branch fallback: /mnt/efs/specter-repo/repositories/{repo}/
        pathsToCheck.push({
            label: 'default',
            repoPath: path.join(EFS_BASE_PATH, repoName),
        });

        for (const { label, repoPath } of pathsToCheck) {
            try {
                if (fs.existsSync(repoPath)) {
                    const repoId = `veritas_${repoName}`;
                    registerRepo(repoId, repoPath);

                    logger.info({
                        instanceId: this.instanceId,
                        repoName,
                        repoId,
                        repoPath,
                        pathType: label,
                    }, '[VERITAS_REPO_DISCOVER] Registered repo from EFS');

                    return repoId;
                }
            } catch (err) {
                logger.debug({
                    instanceId: this.instanceId,
                    repoName,
                    repoPath,
                    error: err instanceof Error ? err.message : 'Unknown',
                }, '[VERITAS_REPO_DISCOVER_CHECK] Path check failed');
            }
        }

        logger.debug({
            instanceId: this.instanceId,
            repoName,
            checkedPaths: pathsToCheck.map(p => p.repoPath),
        }, '[VERITAS_REPO_DISCOVER_MISS] Repo not found on EFS');

        return null;
    }

    /**
     * Parse customer branch from additionalContext.
     * Looks for "Code Branch: <branch>" pattern set by AgentWorker.buildAdditionalContext.
     */
    private parseCustomerBranch(additionalContext?: string): string | undefined {
        if (!additionalContext) return undefined;

        const match = additionalContext.match(/\*\*Code Branch\*\*:\s*(\S+)/);
        return match?.[1] || undefined;
    }

    /**
     * Resolve the directory path where evidence files should be written.
     * Uses the workspace/repository path if available, otherwise a temp directory.
     */
    private resolveEvidenceDir(jiraNumber: string): string {
        const basePath = this.options.repositoryPath || EFS_BASE_PATH;

        // If we have a task workspace, write evidence inside it
        if (basePath.includes('/tasks/')) {
            return path.join(basePath, 'evidence');
        }

        // Otherwise, create an evidence directory under the EFS base
        return path.join(basePath, 'evidence', jiraNumber.replace(/[^a-zA-Z0-9-]/g, '_'));
    }

    /**
     * Format bytes for human-readable display in logs and prompts
     */
    private formatBytes(bytes: number): string {
        if (bytes < 1024) return `${bytes} B`;
        if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
        return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    /**
     * Run the full VERITAS analysis pipeline:
     * 1. Collect evidence from JIRA (deterministic)
     * 1.5a. Write evidence files to disk for Claude to explore
     * 1.5b. Discover and register repos from evidence hints
     * 2. Generate 6-section RCA via Claude SDK
     * 3. Manage labels on the SEN ticket
     *
     * @param jiraNumber - SEN ticket key (e.g., SEN-123)
     * @param additionalContext - Optional additional context from task description
     */
    async analyze(
        jiraNumber: string,
        additionalContext?: string,
    ): Promise<VERITASResult> {
        const taskId = `${this.instanceId}-${Date.now()}`;
        const startTime = Date.now();

        const logContext = {
            instanceId: this.instanceId,
            taskId,
            jiraNumber,
            repoId: this.repoId,
            repoIds: this.repoIds,
        };

        logger.info({
            ...logContext,
            hasAdditionalContext: !!additionalContext,
        }, '[VERITAS_ANALYZE_START] Starting VERITAS RCA analysis');

        try {
            // ================================================================
            // Phase 1: Deterministic Evidence Collection
            // ================================================================
            logger.info(logContext, '[VERITAS_EVIDENCE_START] Phase 1: Collecting evidence from JIRA');
            const evidenceStartTime = Date.now();

            const evidence = await this.evidenceCollector.collectEvidence(jiraNumber);
            const evidenceCollectionMs = Date.now() - evidenceStartTime;

            logger.info({
                ...logContext,
                evidenceCollectionMs,
                sourceCount: evidence.sources.length,
                linkedTicketCount: evidence.linkedTickets.length,
                evidenceMarkdownLength: evidence.evidenceMarkdown.length,
            }, '[VERITAS_EVIDENCE_COMPLETE] Phase 1 complete: Evidence collected');

            // ================================================================
            // Phase 1.5a: Write evidence files to disk
            // ================================================================
            const evidenceDir = this.resolveEvidenceDir(jiraNumber);
            let evidenceWriteResult;
            try {
                evidenceWriteResult = this.evidenceCollector.writeEvidenceFiles(evidence, evidenceDir);

                // Register evidence directory so Claude can access it via Read/Glob/Grep
                const evidenceRepoId = `veritas_evidence_${jiraNumber.replace(/[^a-zA-Z0-9]/g, '_')}`;
                registerRepo(evidenceRepoId, evidenceDir);

                logger.info({
                    ...logContext,
                    evidenceDir,
                    evidenceRepoId,
                    filesWritten: evidenceWriteResult.filesWritten,
                    totalBytesWritten: evidenceWriteResult.totalBytesWritten,
                    fileSizes: evidenceWriteResult.fileSizes,
                }, '[VERITAS_EVIDENCE_WRITTEN] Evidence files written to disk and registered');

                // Ensure evidence dir is in repoIds so Claude can access it
                // Place it first — evidence is the primary working directory for Claude
                this.repoIds = [evidenceRepoId, ...this.repoIds];
                this.repoId = this.repoId || evidenceRepoId;
            } catch (writeError) {
                // Evidence write failure is non-fatal — fall back to prompt-embedded evidence
                logger.error({
                    ...logContext,
                    evidenceDir,
                    errorMessage: writeError instanceof Error ? writeError.message : 'Unknown',
                    errorStack: writeError instanceof Error ? writeError.stack : undefined,
                }, '[VERITAS_EVIDENCE_WRITE_FAILED] Failed to write evidence files — falling back to prompt-embedded evidence');
                evidenceWriteResult = null;
            }

            // ================================================================
            // Phase 1.5b: Evidence-Driven Repo Discovery
            // ================================================================
            logger.info(logContext, '[VERITAS_REPO_DISCOVER] Phase 1.5b: Discovering repos from evidence');

            const discoveredRepoIds = this.discoverAndRegisterRepos(evidence, additionalContext);
            if (discoveredRepoIds.length > 0) {
                // Append discovered repos after evidence dir (which is already first)
                const existingIds = new Set(this.repoIds);
                for (const id of discoveredRepoIds) {
                    if (!existingIds.has(id)) {
                        this.repoIds.push(id);
                    }
                }
            }

            logger.info({
                ...logContext,
                discoveredRepoIds,
                finalRepoIds: this.repoIds,
            }, '[VERITAS_REPO_DISCOVER_DONE] Phase 1.5 complete');

            // ================================================================
            // Phase 2: Claude SDK RCA Generation
            // ================================================================
            logger.info(logContext, '[VERITAS_RCA_START] Phase 2: Generating RCA via Claude SDK');
            const rcaStartTime = Date.now();

            // Build progress handler
            let progressCount = 0;
            const onProgress = (update: ProgressUpdate) => {
                progressCount++;
                if (this.options.onProgress) {
                    const message = update.toolName
                        ? `Analyzing: ${update.toolName}`
                        : update.message ?? `Generating RCA... (${update.elapsed}ms)`;
                    this.options.onProgress(message);
                }
                if (this.options.eventEmitter) {
                    this.options.eventEmitter.emit('agent:progress', update);
                }
            };

            // Build task prompt — lean pointer if evidence files were written, full embed as fallback
            let taskPrompt: string;
            if (evidenceWriteResult) {
                // Evidence is on disk — give Claude a lean prompt directing it to the files
                // Note: The evidence dir is registered as the first repoId, so it becomes cwd.
                // File paths are relative to the evidence dir (e.g., _INDEX.md, SEN-123.md).
                taskPrompt = [
                    `Generate a Root Cause Analysis (RCA) report for incident ${jiraNumber}.`,
                    ``,
                    `## Evidence Location`,
                    ``,
                    `Pre-collected JIRA evidence is available as files in your working directory.`,
                    ``,
                    `**Start by reading \`_INDEX.md\`** — it lists all available evidence files with metadata.`,
                    `Then read individual ticket files (e.g., \`${jiraNumber}.md\`) for full details.`,
                    `Use \`Grep\` to search across all evidence files for specific error messages, stack traces, or component names.`,
                    ``,
                    `### Evidence Summary`,
                    `- **SEN Ticket**: ${evidence.senTicket.key} — ${evidence.senTicket.summary}`,
                    `- **Linked Tickets**: ${evidence.linkedTickets.length} (${evidence.linkedTickets.map(lt => lt.key).join(', ') || 'none'})`,
                    `- **Total Comments**: ${evidence.senTicket.comments.length + evidence.linkedTickets.reduce((s, lt) => s + lt.comments.length, 0)}`,
                    `- **Evidence Files**: ${evidenceWriteResult.filesWritten.length} files (${this.formatBytes(evidenceWriteResult.totalBytesWritten)})`,
                    `- **Evidence Directory**: \`${evidenceDir}\``,
                ].join('\n');
            } else {
                // Fallback: embed evidence in prompt (original behavior)
                logger.warn(logContext, '[VERITAS_PROMPT_FALLBACK] Using prompt-embedded evidence (file write failed)');
                taskPrompt = `Generate a Root Cause Analysis (RCA) report for incident ${jiraNumber}.\n\n`;
                taskPrompt += evidence.evidenceMarkdown;
            }

            if (additionalContext) {
                taskPrompt += `\n---\n## Additional Context\n${additionalContext}\n`;
            }

            logger.info({
                ...logContext,
                taskPromptLength: taskPrompt.length,
                taskPromptBytes: Buffer.byteLength(taskPrompt, 'utf8'),
                evidenceDelivery: evidenceWriteResult ? 'file-based' : 'prompt-embedded',
            }, '[VERITAS_PROMPT_BUILT] Task prompt built for Claude');

            // Run Claude SDK — evidence dir is always first repoId, code repos follow
            const runOptions: any = {
                taskId,
                taskPrompt,
                repoIds: this.repoIds.length > 0 ? this.repoIds : ['__no_repo__'],
                agentType: 'veritas' as const,
                systemAppend: getAgentPrompt('veritas'),
                permissionLevel: 'analysis' as const,
                webhookUrl: this.options.webhookUrl,
                timeoutMs: this.options.timeoutMs,
                onProgress,
                // No outputSchema — VERITAS returns plain markdown enforced via system prompt
                bedrockConfig: {
                    maxOutputTokens: 16384, // RCA reports can be large — override Claude Code's 4096 default
                },
            };

            // If no repos at all (no evidence dir, no code repos), use evidence-only mode
            if (this.repoIds.length === 0) {
                runOptions.repoIds = ['__evidence_only__'];
                runOptions.permissionLevel = 'code_exploration';
            }

            const result = await runAgent(runOptions);
            const rcaGenerationMs = Date.now() - rcaStartTime;

            logger.info({
                ...logContext,
                rcaGenerationMs,
                toolCalls: result.metrics.toolCalls,
                outputLength: result.output.length,
                success: result.success,
            }, '[VERITAS_RCA_COMPLETE] Phase 2 complete: RCA generated');

            if (!result.success) {
                logger.error({
                    ...logContext,
                    error: result.error,
                }, '[VERITAS_RCA_FAILED] Claude SDK returned failure');

                return {
                    success: false,
                    rcaReport: '',
                    sources: evidence.sources,
                    metrics: {
                        durationMs: Date.now() - startTime,
                        toolCalls: result.metrics.toolCalls,
                        tokensUsed: result.metrics.tokensUsed,
                        costUsd: result.metrics.costUsd,
                        evidenceCollectionMs,
                        rcaGenerationMs,
                    },
                    error: result.error || 'RCA generation failed',
                };
            }

            // ================================================================
            // Phase 3: Label Management (deterministic)
            // ================================================================
            logger.info(logContext, '[VERITAS_LABELS_START] Phase 3: Managing labels');

            try {
                await this.jira.removeLabel(jiraNumber, 'VERITAS');
                await this.jira.addLabel(jiraNumber, 'VERITAS-COMPLETED');
                await this.jira.addLabel(jiraNumber, 'RCA-AVAILABLE');

                logger.info(logContext, '[VERITAS_LABELS_COMPLETE] Labels updated successfully');
            } catch (labelError) {
                // Label management failure is non-fatal — log and continue
                logger.warn({
                    ...logContext,
                    error: labelError instanceof Error ? labelError.message : 'Unknown',
                }, '[VERITAS_LABELS_WARN] Label management failed (non-fatal)');
            }

            // ================================================================
            // Return result
            // ================================================================
            const durationMs = Date.now() - startTime;

            logger.info({
                ...logContext,
                durationMs,
                rcaLength: result.output.length,
                toolCalls: result.metrics.toolCalls,
                costUsd: result.metrics.costUsd,
            }, '[VERITAS_ANALYZE_SUCCESS] VERITAS analysis completed successfully');

            return {
                success: true,
                rcaReport: result.output,
                sources: evidence.sources,
                metrics: {
                    durationMs,
                    toolCalls: result.metrics.toolCalls,
                    tokensUsed: result.metrics.tokensUsed,
                    costUsd: result.metrics.costUsd,
                    evidenceCollectionMs,
                    rcaGenerationMs,
                },
            };
        } catch (error) {
            const durationMs = Date.now() - startTime;
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';

            logger.error({
                ...logContext,
                durationMs,
                errorMessage,
                errorStack: error instanceof Error ? error.stack : undefined,
            }, '[VERITAS_ANALYZE_ERROR] Exception during VERITAS analysis');

            return {
                success: false,
                rcaReport: '',
                sources: [],
                metrics: {
                    durationMs,
                    toolCalls: 0,
                    evidenceCollectionMs: 0,
                    rcaGenerationMs: 0,
                },
                error: errorMessage,
            };
        }
    }
}

export default VERITASAgent;
