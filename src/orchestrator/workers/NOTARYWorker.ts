/**
 * NOTARYWorker — Client Notes Review Worker
 *
 * Polls task_management for NOTARY tasks triggered via Teams (Harvey).
 * Each task carries a release source version (e.g. "1.10.23") in jira_number.
 *
 * ## Task Lifecycle
 * 1. pollAndProcess() picks up 'assigned' NOTARY tasks
 * 2. process() (this file) resolves the release version and sets up a git
 *    worktree at the matching release tag in the mpweb repository
 * 3. NOTARYAgent fetches all MPDEV tickets for the release, classifies them,
 *    runs Claude SDK for draft generation + verification, writes back to Jira
 * 4. Summary report uploaded to S3; task marked complete
 *
 * ## Git Worktree Strategy
 * Unlike DARCI (branch worktrees), NOTARY checks out a TAG:
 *
 *   /mnt/efs/specter-repo/repositories/
 *     └── mpweb/                   (main clone — master)
 *         └── 1.10.23/             (detached worktree at tag 1.10.23)
 *
 * The tag name matches the JIRA Release Source field exactly (e.g. "1.10.23").
 * This ensures the agent verifies notes against exactly what the client runs.
 */

import * as path from 'path';
import * as fs from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';

import { AgentWorker, type ProcessResult } from '../AgentWorker.js';
import { NOTARYAgent, type NOTARYResult } from '../../agents/notary/index.js';
import { createLogger } from '../../utils/logger.js';
import { EventEmitter } from 'events';

const execAsync = promisify(exec);
const logger = createLogger('notary-worker');

/** Name of the mp-web repository in code_repositories table */
const MPWEB_REPO_NAME = 'mp-web';

/**
 * Captured at module scope — inside the process() method override,
 * 'process' resolves to 'this.process' (the inherited abstract method),
 * causing a TypeScript name collision with the Node.js global.
 */
const JIRA_BASE_URL = process.env.JIRA_BASE_URL ?? 'https://mhkjira.atlassian.net';

/**
 * Run a git command in a specific directory.
 * Matches the execAsync pattern used in AgentWorker.
 */
async function git(cwd: string, ...args: string[]): Promise<string> {
    const cmd = `git ${args.map(a => `"${a}"`).join(' ')}`;
    const { stdout } = await execAsync(cmd, { cwd });
    return stdout.trim();
}

export class NOTARYWorker extends AgentWorker {
    constructor(repositoryPath: string, enableStatusServer: boolean = false) {
        super({
            agentName: 'NOTARY',
            repositoryPath,
            pollingIntervalMs: 15000, // 15 seconds — lower frequency than code agents
            batchSize: 1,             // Process one release at a time
            enableStatusServer,
        });

        logger.info({
            repositoryPath,
            enableStatusServer,
        }, '[NOTARY_WORKER_INIT] NOTARYWorker initialized');
    }

    /**
     * Process a NOTARY task.
     *
     * jira_number holds the release source version (e.g. "1.10.23").
     * task_description may contain a human-readable description from Harvey.
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
        const releaseVersion = jiraNumber.trim();

        const logCtx = {
            releaseVersion,
            taskId,
            correlationId: `notary-${taskId}-${releaseVersion}`,
        };

        logger.info(logCtx, '[NOTARY_PROCESS_START] Starting client notes review');

        try {
            // Step 1: Ensure the mpweb repo is cloned and has a worktree at the tag
            const tagWorktreePath = await this.ensureRepoAtTag(repositoryPath, releaseVersion, logCtx);

            logger.info({ ...logCtx, tagWorktreePath }, '[NOTARY_REPO_READY] Repo at tag ready');
            this.reportProgress(eventEmitter, `Repo ready at tag ${releaseVersion}: ${tagWorktreePath}`);

            // Step 2: JIRA base URL — captured at module scope to avoid
            // collision with the inherited process() method name
            const jiraBaseUrl = JIRA_BASE_URL;

            // Step 3: Run the NOTARY agent
            const agent = new NOTARYAgent({
                jiraBaseUrl,
                jiraUsername: this.agentJiraUsername,
                jiraToken: this.agentJiraToken,
                repositoryPath: tagWorktreePath,
                releaseVersion,
                eventEmitter,
                onProgress: (msg) => {
                    logger.debug({ ...logCtx, msg }, '[NOTARY_PROGRESS]');
                    this.reportProgress(eventEmitter, msg);
                },
                timeoutMs: 45 * 60 * 1000,
            });

            const result: NOTARYResult = await agent.analyze();
            const durationMs = Date.now() - startTime;

            if (result.success) {
                logger.info({
                    ...logCtx,
                    durationMs,
                    ticketsProcessed: result.metrics.ticketsProcessed,
                    draftsGenerated: result.metrics.draftsGenerated,
                    notesVerified: result.metrics.notesVerified,
                    toolCalls: result.metrics.toolCalls,
                    costUsd: result.metrics.costUsd,
                }, '[NOTARY_PROCESS_SUCCESS] Client notes review completed');

                const output = this.formatOutput(releaseVersion, result);
                const cost = result.metrics.costUsd ?? this.estimateCost(result.metrics.tokensUsed);

                return {
                    success: true,
                    output,
                    metrics: {
                        totalTokens: result.metrics.tokensUsed,
                        iterations: result.metrics.toolCalls,
                        cost,
                        durationMs,
                    },
                };
            } else {
                logger.error({ ...logCtx, durationMs, error: result.error },
                    '[NOTARY_PROCESS_FAILED] Client notes review failed');
                return {
                    success: false,
                    output: '',
                    error: result.error ?? 'Unknown error',
                    metrics: { durationMs },
                };
            }

        } catch (error: any) {
            const durationMs = Date.now() - startTime;
            logger.error({
                ...logCtx,
                durationMs,
                errorName: error.name,
                errorMessage: error.message,
                errorStack: error.stack,
            }, '[NOTARY_PROCESS_ERROR] Unhandled error in NOTARY worker');

            return {
                success: false,
                output: '',
                error: error.message,
                metrics: { durationMs },
            };
        }
    }

    // ─── Tag Worktree Setup ───────────────────────────────────────────────────

    /**
     * Ensure the mpweb repo has a worktree checked out at the given release tag.
     *
     * Directory layout:
     *   <repositoryPath>/mpweb/          — main clone (master)
     *   <repositoryPath>/mpweb/1.10.23/  — detached worktree at tag 1.10.23
     *
     * Returns the absolute path to the tag worktree.
     */
    private async ensureRepoAtTag(
        repositoryPath: string,
        tagVersion: string,
        logCtx: object,
    ): Promise<string> {
        const repoPath = path.join(repositoryPath, MPWEB_REPO_NAME);
        const tagPath  = path.join(repoPath, tagVersion);

        // Step 1: Clone mpweb if not already present
        await this.ensureMpwebCloned(repoPath, logCtx);

        // Step 2: Check if worktree already exists at this tag
        const worktreeExists = await fs.access(tagPath).then(() => true).catch(() => false);
        if (worktreeExists) {
            logger.debug({ ...logCtx, tagPath }, '[NOTARY_WORKTREE_EXISTS] Tag worktree already exists');
            return tagPath;
        }

        // Step 3: Fetch the tag from remote
        logger.info({ ...logCtx, tagVersion }, '[NOTARY_TAG_FETCH] Fetching tag from remote');
        try {
            await git(repoPath, 'fetch', 'origin', `refs/tags/${tagVersion}:refs/tags/${tagVersion}`, '--no-tags');
        } catch (fetchErr: any) {
            throw new Error(
                `Failed to fetch tag ${tagVersion} from remote mpweb: ${fetchErr.message}. ` +
                `Ensure the tag exists on origin and the agent has repo access.`,
            );
        }

        // Step 4: Verify the tag ref exists locally
        try {
            await git(repoPath, 'rev-parse', '--verify', `refs/tags/${tagVersion}`);
        } catch {
            throw new Error(`Tag ${tagVersion} not found in mpweb after fetch. Check that the tag was pushed to origin.`);
        }

        // Step 5: Create a detached worktree at the tag
        logger.info({ ...logCtx, tagVersion, tagPath }, '[NOTARY_WORKTREE_CREATE] Creating detached worktree at tag');
        try {
            await git(repoPath, 'worktree', 'add', '--detach', tagPath, `refs/tags/${tagVersion}`);
        } catch (worktreeErr: any) {
            throw new Error(`git worktree add failed for tag ${tagVersion}: ${worktreeErr.message}`);
        }

        logger.info({ ...logCtx, tagVersion, tagPath }, '[NOTARY_WORKTREE_CREATED] Tag worktree created');
        return tagPath;
    }

    /**
     * Clone the mpweb repository if it doesn't already exist on EFS.
     * Uses the same DB + buildAuthUrl pattern as all other agents.
     */
    private async ensureMpwebCloned(repoPath: string, logCtx: object): Promise<void> {
        const gitDir = path.join(repoPath, '.git');
        const alreadyCloned = await fs.access(gitDir).then(() => true).catch(() => false);

        // Lookup mpweb from code_repositories table — same as DARCI/SCRIBE/etc.
        const repo = await this.db.getRepositoryByName(MPWEB_REPO_NAME);
        if (!repo) {
            throw new Error(`Repository "${MPWEB_REPO_NAME}" not found in code_repositories table. Add it before running NOTARY.`);
        }

        const githubToken = process.env.GITHUB_REPO_TOKEN;
        if (!githubToken) {
            throw new Error(
                `No GitHub token configured for repository "${MPWEB_REPO_NAME}". ` +
                'Ensure the worker task definition injects GITHUB_REPO_TOKEN.',
            );
        }

        const authUrl = repo.repo_url.replace(
            'https://',
            `https://x-access-token:${encodeURIComponent(githubToken)}@`,
        );

        if (alreadyCloned) {
            // Update remote with current token (may have rotated) — same pattern as AgentWorker
            logger.debug({ ...logCtx, repoPath }, '[NOTARY_REPO_EXISTS] mpweb already cloned, refreshing remote URL');
            await git(repoPath, 'remote', 'set-url', 'origin', authUrl).catch(err => {
                logger.warn({ ...logCtx, error: err.message }, '[NOTARY_REPO_AUTH_WARN] Failed to update remote URL');
            });
            return;
        }

        logger.info({ ...logCtx, repoPath }, '[NOTARY_REPO_CLONE] Cloning mpweb repository');
        await fs.mkdir(repoPath, { recursive: true });

        // Full clone — tags need full history (no --depth)
        await git(repoPath, 'clone', '--no-single-branch', authUrl, '.');

        logger.info({ ...logCtx, repoPath }, '[NOTARY_REPO_CLONED] mpweb cloned successfully');
    }

    // ─── Helpers ──────────────────────────────────────────────────────────────

    private reportProgress(eventEmitter: EventEmitter | undefined, message: string): void {
        if (eventEmitter) {
            eventEmitter.emit('agent:progress', { message, elapsed: 0 });
        }
    }

    private estimateCost(tokensUsed?: { input: number; output: number }): number {
        if (!tokensUsed) return 0;
        return (tokensUsed.input / 1000) * 0.003 + (tokensUsed.output / 1000) * 0.015;
    }

    private formatOutput(releaseVersion: string, result: NOTARYResult): string {
        const s = result.structured;
        const counts = s
            ? `**Tickets:** ${s.total_tickets} total | ` +
              `${s.already_reviewed} pre-reviewed | ` +
              `${s.drafts_generated} drafts generated | ` +
              `${s.verified} verified | ` +
              `${s.internal_no_notes} internal | ` +
              `${s.skipped_issue_type} skipped`
            : '';

        return `## NOTARY Client Notes Review — Release ${releaseVersion}

${result.report}

---

${counts ? `${counts}\n\n` : ''}<sub>⏱️ ${(result.metrics.durationMs / 1000).toFixed(1)}s | 🔧 ${result.metrics.toolCalls} tool calls${result.metrics.costUsd ? ` | 💰 $${result.metrics.costUsd.toFixed(4)}` : ''} | 🤖 NOTARY v1.0.0</sub>
`;
    }
}
