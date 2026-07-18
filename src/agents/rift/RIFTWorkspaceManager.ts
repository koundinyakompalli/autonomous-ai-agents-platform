/**
 * RIFTWorkspaceManager - Manages dual-version workspaces for upgrade analysis
 *
 * Creates and maintains two separate repository checkouts:
 * - Old version (client's current version)
 * - New version (target upgrade version)
 */

import { promises as fs } from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createLogger } from '../../utils/index.js';
import { deregisterRepo, registerRepoFromPath } from '../../claude-sdk/index.js';

const logger = createLogger('rift-workspace-manager');

export interface VersionContext {
    branch: string;
    path: string;
    repoId: string;
    sourceRepoPath: string;
    isGitWorktree: boolean;
}

export interface RIFTWorkspace {
    taskId: number;
    workspaceRoot: string;
    workspaceId: string;
    oldVersion: VersionContext;
    newVersion: VersionContext;
    repositoryType: string;
}

export interface WorkspaceSetupOptions {
    taskId: number;
    repositoryBasePath: string;
    repositoryType: string;
    oldBranch: string;
    newBranch: string;
}

export const RIFT_REPOSITORY_ALIASES: Record<string, string> = {
    'medhok-monorepo': 'core-app',
    'cp-medhok-monorepo': 'core-app',
    'core-app': 'core-app',
    'batch-monorepo': 'batch-jobs',
    'cp-batch-monorepo': 'batch-jobs',
    'batch-jobs': 'batch-jobs',
    'client-services-monorepo': 'client-services',
    'cp-client-services-monorepo': 'client-services',
    'client-services': 'client-services',
    'provider-portal': 'provider-portal',
    'cp-provider-portal': 'provider-portal',
    'provider-portal-monorepo': 'provider-portal',
};

export function resolveRiftRepositoryName(repositoryType: string): string {
    const normalized = repositoryType.trim().toLowerCase();
    return RIFT_REPOSITORY_ALIASES[normalized] ?? repositoryType.trim();
}

export class RIFTWorkspaceManager {
    /**
     * Setup dual-version workspace for upgrade analysis
     */
    async setupWorkspace(options: WorkspaceSetupOptions): Promise<RIFTWorkspace> {
        const {
            taskId,
            repositoryBasePath,
            repositoryType,
            oldBranch,
            newBranch,
        } = options;

        const logContext = { taskId, repositoryType, oldBranch, newBranch };

        logger.info(logContext, '[RIFT_WORKSPACE_SETUP] Starting dual-version workspace setup');

        const canonicalRepositoryName = resolveRiftRepositoryName(repositoryType);

        logger.info({
            ...logContext,
            canonicalRepositoryName,
        }, '[RIFT_WORKSPACE_REPO_RESOLVE] Resolved canonical repository name');

        // Create workspace root adjacent to the task workspace. The task workspace
        // itself is branch-aware and contains symlinks to the effective repo roots.
        const workspaceRoot = path.join(
            path.dirname(repositoryBasePath),
            'rift-workspaces',
            `task-${taskId}`
        );

        await fs.mkdir(workspaceRoot, { recursive: true });
        logger.info({ ...logContext, workspaceRoot }, '[RIFT_WORKSPACE_CREATED] Workspace root created');

        // Setup old version workspace
        const oldVersionPath = path.join(workspaceRoot, 'old');
        const oldVersion = await this.setupVersionWorkspace(
            repositoryBasePath,
            canonicalRepositoryName,
            oldBranch,
            oldVersionPath,
            'old',
            `rift_${taskId}_old`
        );

        logger.info({
            ...logContext,
            oldVersionPath,
            oldRepoId: oldVersion.repoId,
        }, '[RIFT_OLD_VERSION_READY] Old version workspace ready');

        // Setup new version workspace
        const newVersionPath = path.join(workspaceRoot, 'new');
        const newVersion = await this.setupVersionWorkspace(
            repositoryBasePath,
            canonicalRepositoryName,
            newBranch,
            newVersionPath,
            'new',
            `rift_${taskId}_new`
        );

        const workspaceId = registerRepoFromPath(workspaceRoot, `rift_${taskId}_workspace`);

        logger.info({
            ...logContext,
            newVersionPath,
            newRepoId: newVersion.repoId,
            workspaceId,
        }, '[RIFT_NEW_VERSION_READY] New version workspace ready');

        const workspace: RIFTWorkspace = {
            taskId,
            workspaceRoot,
            workspaceId,
            oldVersion,
            newVersion,
            repositoryType: canonicalRepositoryName,
        };

        logger.info({
            ...logContext,
            workspaceRoot,
            oldRepoId: oldVersion.repoId,
            newRepoId: newVersion.repoId,
        }, '[RIFT_WORKSPACE_COMPLETE] Dual-version workspace setup complete');

        return workspace;
    }

    /**
     * Setup a single version workspace (old or new)
     */
    private async setupVersionWorkspace(
        repositoryBasePath: string,
        repositoryName: string,
        branch: string,
        targetPath: string,
        versionLabel: string,
        explicitRepoId: string
    ): Promise<VersionContext> {
        const logContext = { repositoryName, branch, targetPath, versionLabel };

        logger.debug(logContext, '[RIFT_VERSION_SETUP] Setting up version workspace');

        const sourceRepoPath = path.join(repositoryBasePath, repositoryName);

        // Check if source repo exists
        try {
            await fs.access(sourceRepoPath);
        } catch (error) {
            logger.error({
                ...logContext,
                sourceRepoPath,
                error: error instanceof Error ? error.message : 'Unknown error',
            }, '[RIFT_VERSION_SETUP_ERROR] Source repository not found');
            throw new Error(`Source repository not found: ${sourceRepoPath}`);
        }

        let isGitWorktree = false;

        // Use git worktree for efficient branch checkout
        logger.debug({
            ...logContext,
            sourceRepoPath,
        }, '[RIFT_WORKTREE_CREATE] Creating git worktree');

        try {
            // Create worktree for the specified branch. Use `git -C` so removal can
            // later be anchored against the same source repo instead of the current cwd.
            const worktreeCmd = `git -C "${sourceRepoPath}" worktree add "${targetPath}" "${branch}"`;
            execSync(worktreeCmd, { encoding: 'utf-8', stdio: 'pipe' });
            isGitWorktree = true;

            logger.info({
                ...logContext,
                worktreeCmd,
            }, '[RIFT_WORKTREE_CREATED] Git worktree created successfully');
        } catch (error) {
            logger.error({
                ...logContext,
                error: error instanceof Error ? error.message : 'Unknown error',
            }, '[RIFT_WORKTREE_ERROR] Failed to create git worktree');

            // Fallback: clone the repo and checkout branch
            logger.info(logContext, '[RIFT_CLONE_FALLBACK] Falling back to git clone');
            await this.cloneAndCheckout(sourceRepoPath, targetPath, branch);
        }

        // Register this repo in the repo registry
        const repoId = registerRepoFromPath(targetPath, explicitRepoId);

        logger.info({
            ...logContext,
            repoId,
        }, '[RIFT_VERSION_REGISTERED] Version workspace registered');

        return {
            branch,
            path: targetPath,
            repoId,
            sourceRepoPath,
            isGitWorktree,
        };
    }

    /**
     * Fallback: Clone repository and checkout branch
     */
    private async cloneAndCheckout(sourceRepoPath: string, targetPath: string, branch: string): Promise<void> {
        const logContext = { sourceRepoPath, targetPath, branch };

        logger.debug(logContext, '[RIFT_CLONE] Cloning repository');

        try {
            // Clone the repository
            const cloneCmd = `git clone "${sourceRepoPath}" "${targetPath}"`;
            execSync(cloneCmd, { encoding: 'utf-8', stdio: 'pipe' });

            // Checkout the branch
            const checkoutCmd = `cd "${targetPath}" && git checkout "${branch}"`;
            execSync(checkoutCmd, { encoding: 'utf-8', stdio: 'pipe' });

            logger.info(logContext, '[RIFT_CLONE_SUCCESS] Repository cloned and branch checked out');
        } catch (error) {
            logger.error({
                ...logContext,
                error: error instanceof Error ? error.message : 'Unknown error',
            }, '[RIFT_CLONE_ERROR] Failed to clone repository');
            throw error;
        }
    }

    /**
     * Cleanup workspace after analysis
     */
    async cleanupWorkspace(workspace: RIFTWorkspace): Promise<void> {
        const logContext = { taskId: workspace.taskId, workspaceRoot: workspace.workspaceRoot };

        logger.info(logContext, '[RIFT_CLEANUP] Cleaning up workspace');

        try {
            // Remove git worktrees first
            await this.removeVersionWorkspace(workspace.oldVersion);
            await this.removeVersionWorkspace(workspace.newVersion);

            deregisterRepo(workspace.oldVersion.repoId);
            deregisterRepo(workspace.newVersion.repoId);
            deregisterRepo(workspace.workspaceId);

            // Remove workspace directory
            await fs.rm(workspace.workspaceRoot, { recursive: true, force: true });

            logger.info(logContext, '[RIFT_CLEANUP_SUCCESS] Workspace cleaned up successfully');
        } catch (error) {
            logger.error({
                ...logContext,
                error: error instanceof Error ? error.message : 'Unknown error',
            }, '[RIFT_CLEANUP_ERROR] Failed to cleanup workspace');
        }
    }

    /**
     * Remove git worktree
     */
    private async removeVersionWorkspace(version: VersionContext): Promise<void> {
        try {
            if (version.isGitWorktree) {
                const removeCmd = `git -C "${version.sourceRepoPath}" worktree remove "${version.path}" --force`;
                execSync(removeCmd, { encoding: 'utf-8', stdio: 'pipe' });
                logger.debug({
                    worktreePath: version.path,
                    sourceRepoPath: version.sourceRepoPath,
                }, '[RIFT_WORKTREE_REMOVED] Worktree removed');
            }

            await fs.rm(version.path, { recursive: true, force: true });
        } catch (error) {
            logger.debug({
                worktreePath: version.path,
                sourceRepoPath: version.sourceRepoPath,
                error: error instanceof Error ? error.message : 'Unknown error',
            }, '[RIFT_WORKTREE_REMOVE_SKIP] Worktree removal skipped');
        }
    }

    /**
     * Verify workspace is valid
     */
    async verifyWorkspace(workspace: RIFTWorkspace): Promise<boolean> {
        const logContext = { taskId: workspace.taskId };

        logger.debug(logContext, '[RIFT_VERIFY] Verifying workspace');

        try {
            // Check old version path exists
            await fs.access(workspace.oldVersion.path);

            // Check new version path exists
            await fs.access(workspace.newVersion.path);

            // Verify git repos
            const oldGitPath = path.join(workspace.oldVersion.path, '.git');
            const newGitPath = path.join(workspace.newVersion.path, '.git');

            await fs.access(oldGitPath);
            await fs.access(newGitPath);

            logger.info(logContext, '[RIFT_VERIFY_SUCCESS] Workspace verification passed');
            return true;
        } catch (error) {
            logger.error({
                ...logContext,
                error: error instanceof Error ? error.message : 'Unknown error',
            }, '[RIFT_VERIFY_FAILED] Workspace verification failed');
            return false;
        }
    }
}

export default RIFTWorkspaceManager;
