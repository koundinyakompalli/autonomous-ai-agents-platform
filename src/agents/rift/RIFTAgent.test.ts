import { describe, expect, it } from 'vitest';

import { RIFTAgent } from './RIFTAgent.js';
import type { RIFTWorkspace } from './RIFTWorkspaceManager.js';

function createAgent() {
    return new RIFTAgent({
        repositoryBasePath: '/mnt/efs/specter-repo/repositories/tasks/task-1234',
        repositoryType: 'core-app',
        oldBranch: '3.13',
        newBranch: '4.0',
        taskId: 1234,
    });
}

function createWorkspace(): RIFTWorkspace {
    return {
        taskId: 1234,
        workspaceRoot: '/mnt/efs/specter-repo/repositories/tasks/rift-workspaces/task-1234',
        workspaceId: 'rift_1234_workspace',
        repositoryType: 'core-app',
        oldVersion: {
            branch: '3.13',
            path: '/mnt/efs/specter-repo/repositories/tasks/rift-workspaces/task-1234/old',
            repoId: 'rift_1234_old',
            sourceRepoPath: '/mnt/efs/specter-repo/repositories/tasks/task-1234/core-app',
            isGitWorktree: true,
        },
        newVersion: {
            branch: '4.0',
            path: '/mnt/efs/specter-repo/repositories/tasks/rift-workspaces/task-1234/new',
            repoId: 'rift_1234_new',
            sourceRepoPath: '/mnt/efs/specter-repo/repositories/tasks/task-1234/core-app',
            isGitWorktree: true,
        },
    };
}

describe('RIFTAgent analysis context', () => {
    it('describes the actual workspace-root contract instead of fake repoIds', () => {
        const agent = createAgent();
        const context = (agent as any).buildAnalysisContext(
            'Claims fail after upgrade',
            'stack trace here',
            createWorkspace(),
        ) as string;

        expect(context).toContain('The current working directory is a scratch workspace for this analysis.');
        expect(context).toContain('version is available under `./old`');
        expect(context).toContain('version is available under `./new`');
        expect(context).toContain('cd new');
        expect(context).not.toContain('repoId: old');
        expect(context).not.toContain('repoId: new');
    });

    it('does not promise database access unless credentials are actually present', () => {
        const agent = new RIFTAgent({
            repositoryBasePath: '/mnt/efs/specter-repo/repositories/tasks/task-1234',
            repositoryType: 'core-app',
            oldBranch: '3.13',
            newBranch: '4.0',
            taskId: 1234,
            clientDb: {
                client: 'BCBSNC',
                envId: 'UAT',
            },
        });

        const section = (agent as any).buildClientDbSection() as string;

        expect(section).toContain('potential');
        expect(section).toContain('does not include resolved database credentials');
    });
});
