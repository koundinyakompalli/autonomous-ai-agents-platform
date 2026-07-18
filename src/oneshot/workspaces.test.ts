import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isMissingRemoteBranchFetchError,
  OneShotWorkspaceManager,
} from './workspaces.js'
import {
  RepoCacheLeaseTimeoutError,
  WorkspaceCheckoutTimeoutError,
} from './workspace-lease-errors.js'
import {
  repoCacheColdHydrationDurationHistogram,
  repoCacheLockHoldHistogram,
} from './telemetry/metrics.js'

const ORIGINAL_GITHUB_REPO_TOKEN = process.env.GITHUB_REPO_TOKEN
const tempRoots: string[] = []

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function normalizeGitComparablePath(targetPath: string): string {
  const resolved = path.resolve(targetPath)
  if (resolved === '/private/var' || resolved.startsWith('/private/var/')) {
    return resolved.slice('/private'.length)
  }
  if (resolved === '/private/tmp' || resolved.startsWith('/private/tmp/')) {
    return resolved.slice('/private'.length)
  }
  return resolved
}

function worktreeListIncludesPath(output: string, targetPath: string): boolean {
  const normalizedTarget = normalizeGitComparablePath(targetPath)
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .some((line) => normalizeGitComparablePath(line.slice('worktree '.length)) === normalizedTarget)
}

function countWorktreeListPath(output: string, targetPath: string): number {
  const normalizedTarget = normalizeGitComparablePath(targetPath)
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .filter((line) => normalizeGitComparablePath(line.slice('worktree '.length)) === normalizedTarget)
    .length
}

async function createTempRoot(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'specter-oneshot-workspaces-'))
  tempRoots.push(root)
  return root
}

async function createHydratedRepo(repoBasePath: string, repoName: string): Promise<{
  commitSha: string
  repoRoot: string
  sourceRoot: string
}> {
  const sourceRoot = path.join(repoBasePath, repoName)
  const repoRoot = path.join(repoBasePath, `${repoName}.git`)
  await fs.mkdir(sourceRoot, { recursive: true })
  git(['init'], sourceRoot)
  git(['checkout', '-B', 'master'], sourceRoot)
  git(['config', 'user.email', 'specter-tests@example.com'], sourceRoot)
  git(['config', 'user.name', 'Specter Tests'], sourceRoot)
  await fs.writeFile(path.join(sourceRoot, 'tracked.txt'), 'base\n', 'utf8')
  git(['add', 'tracked.txt'], sourceRoot)
  git(['commit', '-m', 'Initial commit'], sourceRoot)
  git(['remote', 'add', 'origin', sourceRoot], sourceRoot)
  const commitSha = git(['rev-parse', 'HEAD'], sourceRoot)
  git(['clone', '--mirror', sourceRoot, repoRoot], repoBasePath)
  await fs.writeFile(
    path.join(repoRoot, 'oneshot-cache-state.json'),
    JSON.stringify({
      branches: {
        master: {
          lastFetchAt: new Date().toISOString(),
          remoteHeadSha: commitSha,
        },
      },
    }),
    'utf8',
  )

  return {
    commitSha,
    repoRoot,
    sourceRoot,
  }
}

async function createRemoteRepo(root: string, repoName: string): Promise<{
  remoteUrl: string
  sourceRoot: string
  commitSha: string
}> {
  const sourceRoot = path.join(root, `${repoName}-source`)
  const remoteRoot = path.join(root, `${repoName}.git`)
  await fs.mkdir(sourceRoot, { recursive: true })
  git(['init'], sourceRoot)
  git(['checkout', '-B', 'master'], sourceRoot)
  git(['config', 'user.email', 'specter-tests@example.com'], sourceRoot)
  git(['config', 'user.name', 'Specter Tests'], sourceRoot)
  await fs.writeFile(path.join(sourceRoot, 'tracked.txt'), 'base\n', 'utf8')
  git(['add', 'tracked.txt'], sourceRoot)
  git(['commit', '-m', 'Initial commit'], sourceRoot)
  const commitSha = git(['rev-parse', 'HEAD'], sourceRoot)
  git(['clone', '--bare', sourceRoot, remoteRoot], root)
  return {
    remoteUrl: remoteRoot,
    sourceRoot,
    commitSha,
  }
}

function buildV2Stores(runId = 42) {
  let repoLeaseAcquisitions = 0
  const repoLease = {
    scope: 'repo-cache:core-app',
    fencingToken: 1,
    ownerTaskArn: 'task-arn',
    ownerStage: 'planner',
  }
  const runLease = {
    scope: `run-worktree:${runId}`,
    fencingToken: 2,
    ownerTaskArn: 'task-arn',
    ownerStage: 'planner',
  }
  return {
    leaseStore: {
      acquireLease: vi.fn().mockImplementation(async (input: { scope: string }) => {
        if (input.scope === repoLease.scope) {
          repoLeaseAcquisitions += 1
          return {
            ...repoLease,
            fencingToken: repoLeaseAcquisitions === 1 ? 1 : repoLeaseAcquisitions + 1,
          }
        }
        if (input.scope === runLease.scope) {
          return runLease
        }
        return null
      }),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    },
    workspaceStateStore: {
      upsertState: vi.fn().mockResolvedValue(undefined),
      upsertStateWithLease: vi.fn().mockResolvedValue(true),
      conditionalUpdateWithLease: vi.fn().mockResolvedValue(true),
    },
    repoLease,
    runLease,
  }
}

function buildSharedV2Stores() {
  let fencingToken = 0
  const activeLeases = new Set<string>()
  const leaseStore = {
    acquireLease: vi.fn().mockImplementation(async (input: { scope: string; ownerTaskArn: string; ownerStage: string }) => {
      if (activeLeases.has(input.scope)) {
        return null
      }
      activeLeases.add(input.scope)
      fencingToken += 1
      return {
        scope: input.scope,
        fencingToken,
        ownerTaskArn: input.ownerTaskArn,
        ownerStage: input.ownerStage,
      }
    }),
    verifyLease: vi.fn().mockImplementation(async (scope: string) => activeLeases.has(scope)),
    releaseLease: vi.fn().mockImplementation(async (scope: string) => {
      activeLeases.delete(scope)
      return true
    }),
    heartbeatLease: vi.fn().mockResolvedValue(true),
    recordLeaseLost: vi.fn().mockResolvedValue(undefined),
  }
  return {
    leaseStore,
    workspaceStateStore: {
      upsertState: vi.fn().mockResolvedValue(undefined),
      upsertStateWithLease: vi.fn().mockResolvedValue(true),
      conditionalUpdateWithLease: vi.fn().mockResolvedValue(true),
    },
  }
}

class SlowCleanupWorkspaceManager extends OneShotWorkspaceManager {
  protected override async cleanupWorktree(
    repoRoot: string,
    workspacePath: string,
    context: Record<string, unknown>,
    // The guard type is intentionally private to the production module.
    guard?: any,
  ) {
    await new Promise((resolve) => setTimeout(resolve, 50))
    return super.cleanupWorktree(repoRoot, workspacePath, context, guard)
  }
}

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  process.env.GITHUB_REPO_TOKEN = ORIGINAL_GITHUB_REPO_TOKEN
  while (tempRoots.length > 0) {
    const root = tempRoots.pop()
    if (root) {
      await fs.rm(root, { recursive: true, force: true })
    }
  }
})

describe('OneShotWorkspaceManager', () => {
  it('recognizes missing remote branch fetch stderr phrasings', () => {
    const missingBranchMessages = [
      "fatal: couldn't find remote ref refs/heads/missing-retrofit-source",
      'fatal: could not find remote ref refs/heads/missing-retrofit-source',
      'fatal: remote ref does not exist: refs/heads/missing-retrofit-source',
      "fatal: couldn't find remote branch missing-retrofit-source",
      'fatal: could not find remote branch missing-retrofit-source',
    ]

    for (const stderr of missingBranchMessages) {
      const error = new Error('git fetch failed') as Error & { stderr?: string }
      error.stderr = stderr
      expect(isMissingRemoteBranchFetchError(error)).toBe(true)
    }

    const networkError = new Error(
      'fatal: unable to access repository: Could not resolve host: github.com',
    ) as Error & { stderr?: Buffer }
    networkError.stderr = Buffer.from(
      'fatal: unable to access repository: Could not resolve host: github.com',
    )
    expect(isMissingRemoteBranchFetchError(networkError)).toBe(false)
  })

  it('reuses one worktree per run and keeps stage state outside the repo tree', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
	    const root = await createTempRoot()
	    const repoBasePath = path.join(root, 'repositories')
	    const workspaceBasePath = path.join(root, 'oneshot')
	    const { leaseStore, workspaceStateStore } = buildV2Stores()
	    const manager = new OneShotWorkspaceManager({
	      repoBasePath,
	      workspaceBasePath,
	      leaseStore: leaseStore as never,
	      workspaceStateStore: workspaceStateStore as never,
	    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    const first = await manager.prepareWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'planner',
      'master',
    )

	    expect(first.workspacePath).toBe(path.join(workspaceBasePath, '42', 'worktree'))
	    expect(first.statePath).toBe(path.join(workspaceBasePath, '42', 'state'))
    expect(await pathExists(path.join(first.workspacePath, '.git'))).toBe(true)

    await fs.writeFile(path.join(first.workspacePath, 'scratch.tmp'), 'remove me\n', 'utf8')
    await fs.mkdir(path.join(first.statePath, 'planner'), { recursive: true })
    await fs.writeFile(path.join(first.statePath, 'planner', 'old.json'), '{"stale":true}', 'utf8')
    await fs.mkdir(path.join(first.statePath, 'reviewer'), { recursive: true })
    await fs.writeFile(path.join(first.statePath, 'reviewer', 'keep.json'), '{"keep":true}', 'utf8')

    const second = await manager.prepareWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'planner',
      'master',
    )

    expect(second.workspacePath).toBe(first.workspacePath)
    expect(await pathExists(path.join(second.workspacePath, 'scratch.tmp'))).toBe(false)
    expect(await fs.readFile(path.join(second.workspacePath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await pathExists(path.join(second.statePath, 'planner', 'old.json'))).toBe(false)
    expect(await pathExists(path.join(second.statePath, 'reviewer', 'keep.json'))).toBe(true)
  })

  it('prepares branch workspaces through the mirror cache and reuses the worktree', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repositories')
    const workspaceBasePath = path.join(root, 'branch-workspaces')
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      repoCacheBasePath: repoBasePath,
      workspaceBasePath,
      repoCacheFreshnessTtlMs: 300_000,
    })
    const { remoteUrl, commitSha } = await createRemoteRepo(root, 'core-app')

    const first = await manager.prepareBranchWorkspace({
      runId: 42,
      repo: {
        repo_name: 'core-app',
        repo_url: remoteUrl,
      },
      branchName: 'master',
      stage: 'planner',
    })

    expect(first.repoRoot).toBe(path.join(repoBasePath, 'core-app.git'))
    expect(first.workspacePath).toBe(path.join(workspaceBasePath, '42', 'workspace'))
    expect(first.statePath).toBe(path.join(workspaceBasePath, '42', 'state'))
    expect(first.headSha).toBe(commitSha)
    expect(first.branchName).toBe('master')
    expect(first.repoFetchReason).toBe('clone')
    expect(first.reused).toBe(false)
    expect(await fs.readFile(path.join(first.workspacePath, 'tracked.txt'), 'utf8')).toBe('base\n')

    await fs.writeFile(path.join(first.workspacePath, 'scratch.tmp'), 'remove me\n', 'utf8')
    const second = await manager.prepareBranchWorkspace({
      runId: 42,
      repo: {
        repo_name: 'core-app',
        repo_url: remoteUrl,
      },
      branchName: 'master',
      stage: 'planner',
    })

    expect(second.workspacePath).toBe(first.workspacePath)
    expect(second.headSha).toBe(commitSha)
    expect(second.repoFetchReason).toBe('fresh_cache')
    expect(second.reused).toBe(true)
    expect(await pathExists(path.join(second.workspacePath, 'scratch.tmp'))).toBe(false)

    const cacheState = JSON.parse(
      await fs.readFile(
        path.join(repoBasePath, 'core-app.git', 'oneshot-cache-state.json'),
        'utf8',
      ),
    )
    expect(cacheState.branches.master.remoteHeadSha).toBe(commitSha)
  })

  it('prepares branch workspaces under the configured local worktree base', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repositories')
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const workspaceBasePath = path.join(root, 'legacy-branch-workspaces')
    const worktreeBasePath = path.join(root, 'local-branch-worktrees')
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      repoCacheFreshnessTtlMs: 300_000,
    })
    const { remoteUrl, commitSha } = await createRemoteRepo(root, 'core-app')

    const workspace = await manager.prepareBranchWorkspace({
      runId: 42,
      repo: {
        repo_name: 'core-app',
        repo_url: remoteUrl,
      },
      branchName: 'master',
      stage: 'planner',
    })

    expect(workspace.repoRoot).toBe(path.join(repoCacheBasePath, 'core-app.git'))
    expect(workspace.runPath).toBe(path.join(worktreeBasePath, '42'))
    expect(workspace.workspacePath).toBe(path.join(worktreeBasePath, '42', 'worktree'))
    expect(workspace.statePath).toBe(path.join(worktreeBasePath, '42', 'state'))
    expect(await pathExists(path.join(workspaceBasePath, '42'))).toBe(false)
    expect(workspace.headSha).toBe(commitSha)

    await workspace.cleanup()

    expect(await pathExists(workspace.runPath)).toBe(false)
    expect(await pathExists(workspace.workspacePath)).toBe(false)
  })

  it('cleans up the git worktree registration before deleting a terminal run workspace', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
	    const root = await createTempRoot()
	    const repoBasePath = path.join(root, 'repositories')
	    const workspaceBasePath = path.join(root, 'oneshot')
	    const { leaseStore, workspaceStateStore } = buildV2Stores()
	    const manager = new OneShotWorkspaceManager({
	      repoBasePath,
	      workspaceBasePath,
	      leaseStore: leaseStore as never,
	      workspaceStateStore: workspaceStateStore as never,
	    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const repoRoot = path.join(repoBasePath, 'core-app.git')

    const workspace = await manager.prepareWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'planner',
      'master',
    )

    expect(worktreeListIncludesPath(git(['worktree', 'list', '--porcelain'], repoRoot), workspace.workspacePath)).toBe(true)

    const cleanupStatus = await manager.cleanupRunWorkspace(42)

    expect(cleanupStatus).toBe('cleaned')
    expect(await pathExists(path.join(workspaceBasePath, '42'))).toBe(false)
    expect(worktreeListIncludesPath(git(['worktree', 'list', '--porcelain'], repoRoot), workspace.workspacePath)).toBe(false)
  })

  it('repairs a missing locked worktree registration before recreating the workspace', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
	    const root = await createTempRoot()
	    const repoBasePath = path.join(root, 'repositories')
	    const workspaceBasePath = path.join(root, 'oneshot')
	    const { leaseStore, workspaceStateStore } = buildV2Stores()
	    const manager = new OneShotWorkspaceManager({
	      repoBasePath,
	      workspaceBasePath,
	      leaseStore: leaseStore as never,
	      workspaceStateStore: workspaceStateStore as never,
	    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const repoRoot = path.join(repoBasePath, 'core-app.git')

    const workspace = await manager.prepareWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'planner',
      'master',
    )

    git(['worktree', 'lock', workspace.workspacePath], repoRoot)
    await fs.rm(path.join(workspaceBasePath, '42'), { recursive: true, force: true })

    const staleWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot)
    expect(worktreeListIncludesPath(staleWorktrees, workspace.workspacePath)).toBe(true)
    expect(staleWorktrees).toContain('locked')

    const recreated = await manager.prepareWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'planner',
      'master',
    )

    expect(recreated.workspacePath).toBe(workspace.workspacePath)
    expect(await fs.readFile(path.join(recreated.workspacePath, 'tracked.txt'), 'utf8')).toBe('base\n')

    const repairedWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot)
    expect(worktreeListIncludesPath(repairedWorktrees, recreated.workspacePath)).toBe(true)
    expect(repairedWorktrees).not.toContain('locked')
    expect(repairedWorktrees).not.toContain('prunable')
  })

  it('uses pinned v2 worktree paths and records workspace state under MySQL leases', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const { leaseStore, workspaceStateStore, runLease } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      leaseTtlSeconds: 2700,
      leaseHeartbeatSeconds: 30,
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
    )

    expect(workspace.workspacePath).toBe(path.join(workspaceBasePath, '42', 'worktree'))
    expect(workspace.statePath).toBe(path.join(workspaceBasePath, '42', 'state'))
    expect(workspace.lease).toEqual(runLease)
    expect(leaseStore.acquireLease).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ scope: 'repo-cache:core-app' }),
    )
    expect(leaseStore.acquireLease).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ scope: 'run-worktree:42' }),
    )
    expect(workspaceStateStore.upsertStateWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        oneshotRunId: 42,
        workspaceMode: 'v2',
        workspacePath: workspace.workspacePath,
        workspaceHeadSha: commitSha,
        leaseScope: 'run-worktree:42',
        fencingToken: 2,
      }),
    )

    await workspace.cleanup()
    expect(leaseStore.releaseLease).toHaveBeenCalledWith('run-worktree:42', 2)
    expect(leaseStore.releaseLease).toHaveBeenCalledWith('repo-cache:core-app', 1)
  })

  it('splits v2 repo caches from local worktree paths', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoCacheBasePath, 'core-app')

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
    )

    expect(workspace.repoRoot).toBe(path.join(repoCacheBasePath, 'core-app.git'))
    expect(workspace.runPath).toBe(path.join(worktreeBasePath, '42'))
    expect(workspace.workspacePath).toBe(path.join(worktreeBasePath, '42', 'worktree'))
    expect(workspace.statePath).toBe(path.join(worktreeBasePath, '42', 'state'))
    expect(await pathExists(path.join(workspaceBasePath, '42'))).toBe(false)
    expect(workspaceStateStore.upsertStateWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: workspace.workspacePath,
        statePath: workspace.statePath,
      }),
    )

    await workspace.cleanup()
  })

  it('lets two v2 runs share one repo cache with isolated local worktrees', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const firstStores = buildV2Stores(42)
    const secondStores = buildV2Stores(43)
    const firstManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const first = await firstManager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
    )
    const second = await secondManager.preparePlannerWorkspace(
      43,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
    )

    expect(first.repoRoot).toBe(second.repoRoot)
    expect(first.workspacePath).not.toBe(second.workspacePath)
    expect(git(['rev-parse', 'HEAD'], first.workspacePath)).toBe(commitSha)
    expect(git(['rev-parse', 'HEAD'], second.workspacePath)).toBe(commitSha)

    await first.cleanup()
    await second.cleanup()
  })

  it('prepares concurrent same-repo v2 workspaces through one bounded repo-cache lease queue', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const stores = buildSharedV2Stores()
    const holdRecord = vi.spyOn(repoCacheLockHoldHistogram, 'record')

    const prepareRun = async (runId: number) => {
      const manager = new OneShotWorkspaceManager({
        repoBasePath: path.join(root, 'repo-admin'),
        repoCacheBasePath,
        workspaceBasePath,
        worktreeBasePath,
        leaseStore: stores.leaseStore as never,
        workspaceStateStore: stores.workspaceStateStore as never,
        leaseOwnerTaskArn: `task-${runId}`,
        repoCacheFreshnessTtlMs: 300_000,
      })
      return manager.preparePlannerWorkspace(
        runId,
        {
          repo_name: 'core-app',
          repo_url: sourceRoot,
        },
        commitSha,
        'master',
      )
    }

    const startedAt = Date.now()
    const workspaces = await Promise.all([41, 42, 43].map((runId) => prepareRun(runId)))

    expect(Date.now() - startedAt).toBeLessThan(30_000)
    expect(new Set(workspaces.map((workspace) => workspace.workspacePath)).size).toBe(3)
    expect(workspaces.every((workspace) => workspace.repoRoot === workspaces[0].repoRoot)).toBe(true)
    expect(workspaces.every((workspace) => workspace.workspacePath.startsWith(worktreeBasePath))).toBe(true)
    expect(holdRecord.mock.calls.some((call) => call[1]?.phase === 'worktree_add')).toBe(true)
    expect(Math.max(...holdRecord.mock.calls.map((call) => call[0] as number))).toBeLessThan(30_000)
    expect(stores.leaseStore.recordLeaseLost).not.toHaveBeenCalled()

    await Promise.all(workspaces.map((workspace) => workspace.cleanup()))
  })

  it('serializes concurrent same-repo v2 implementation branch setup under the repo-cache lease', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, repoRoot, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const stores = buildSharedV2Stores()
    const holdRecord = vi.spyOn(repoCacheLockHoldHistogram, 'record')
    const repo = {
      repo_name: 'core-app',
      repo_url: sourceRoot,
    }

    const prepareRun = async (runId: number) => {
      const manager = new OneShotWorkspaceManager({
        repoBasePath: path.join(root, 'repo-admin'),
        repoCacheBasePath,
        workspaceBasePath,
        worktreeBasePath,
        leaseStore: stores.leaseStore as never,
        workspaceStateStore: stores.workspaceStateStore as never,
        leaseOwnerTaskArn: `task-${runId}`,
        repoCacheFreshnessTtlMs: 300_000,
      })
      return manager.prepareImplementerWorkspace(
        runId,
        repo,
        commitSha,
        `oneshot/run-${runId}`,
        'master',
      )
    }

    const workspaces = await Promise.all([51, 52, 53].map((runId) => prepareRun(runId)))

    expect(new Set(workspaces.map((workspace) => workspace.workspacePath)).size).toBe(3)
    expect(workspaces.every((workspace) => workspace.workspacePath.startsWith(worktreeBasePath))).toBe(true)
    expect(holdRecord.mock.calls.some((call) => call[1]?.phase === 'worktree_ref')).toBe(true)
    expect(Math.max(...holdRecord.mock.calls.map((call) => call[0] as number))).toBeLessThan(30_000)
    expect(stores.leaseStore.recordLeaseLost).not.toHaveBeenCalled()
    for (const [index, workspace] of workspaces.entries()) {
      const branchName = `oneshot/run-${[51, 52, 53][index]}`
      expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.workspacePath)).toBe(branchName)
      expect(git(['rev-parse', 'HEAD'], workspace.workspacePath)).toBe(commitSha)
      expect(git([`--git-dir=${repoRoot}`, 'rev-parse', `refs/heads/${branchName}`], root)).toBe(commitSha)
    }

    await Promise.all(workspaces.map((workspace) => workspace.cleanup()))
  })

  it('detaches reused v2 worktrees before local cleanup without moving the old branch ref', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, repoRoot, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const repo = {
      repo_name: 'core-app',
      repo_url: sourceRoot,
    }
    const implementationBranch = 'oneshot/run-42'
    const firstStores = buildV2Stores()
    const firstManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'implementer-task',
    })
    const implementationWorkspace = await firstManager.prepareImplementerWorkspace(
      42,
      repo,
      commitSha,
      implementationBranch,
      'master',
    )
    await fs.writeFile(path.join(implementationWorkspace.workspacePath, 'tracked.txt'), 'dirty\n', 'utf8')
    await fs.writeFile(path.join(implementationWorkspace.workspacePath, 'generated.tmp'), 'temp\n', 'utf8')
    await implementationWorkspace.cleanup()

    const holdRecord = vi.spyOn(repoCacheLockHoldHistogram, 'record')
    const secondStores = buildV2Stores()
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'reviewer-task',
    })

    const reviewerWorkspace = await secondManager.prepareReviewerWorkspace(
      42,
      repo,
      commitSha,
      'master',
    )

    expect(holdRecord.mock.calls.some((call) => call[1]?.phase === 'worktree_ref')).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], reviewerWorkspace.workspacePath)).toBe('HEAD')
    expect(git(['rev-parse', 'HEAD'], reviewerWorkspace.workspacePath)).toBe(commitSha)
    expect(git([`--git-dir=${repoRoot}`, 'rev-parse', `refs/heads/${implementationBranch}`], root)).toBe(commitSha)
    expect(await fs.readFile(path.join(reviewerWorkspace.workspacePath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await pathExists(path.join(reviewerWorkspace.workspacePath, 'generated.tmp'))).toBe(false)

    await reviewerWorkspace.cleanup()
  })

  it('attaches tester v2 workspaces to the implementation branch under the repo-cache lease', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, repoRoot, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const implementationBranch = 'oneshot/run-42'
    git(['checkout', '-B', implementationBranch, 'master'], sourceRoot)
    git(['checkout', 'master'], sourceRoot)
    const stores = buildV2Stores()
    const holdRecord = vi.spyOn(repoCacheLockHoldHistogram, 'record')
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: stores.leaseStore as never,
      workspaceStateStore: stores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'tester-task',
    })

    const workspace = await manager.prepareTesterWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: sourceRoot,
      },
      commitSha,
      implementationBranch,
      implementationBranch,
    )

    expect(holdRecord.mock.calls.some((call) => call[1]?.phase === 'worktree_ref')).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.workspacePath)).toBe(implementationBranch)
    expect(git(['rev-parse', 'HEAD'], workspace.workspacePath)).toBe(commitSha)
    expect(git([`--git-dir=${repoRoot}`, 'rev-parse', `refs/heads/${implementationBranch}`], root)).toBe(commitSha)

    await workspace.cleanup()
  })

  it('does not prune unrelated missing local worktree registrations during same-repo prep', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const repoRoot = path.join(repoCacheBasePath, 'core-app.git')
    const repo = {
      repo_name: 'core-app',
      repo_url: sourceRoot,
    }
    const firstStores = buildV2Stores(41)
    const firstManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'planner-task',
    })
    const first = await firstManager.preparePlannerWorkspace(41, repo, commitSha, 'master')
    await first.cleanup()
    await fs.rm(path.join(worktreeBasePath, '41'), { recursive: true, force: true })

    const beforePrepare = git(['worktree', 'list', '--porcelain'], repoRoot)
    expect(worktreeListIncludesPath(beforePrepare, first.workspacePath)).toBe(true)

    const secondStores = buildV2Stores(42)
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'reviewer-task',
    })
    const second = await secondManager.preparePlannerWorkspace(42, repo, commitSha, 'master')

    const afterPrepare = git(['worktree', 'list', '--porcelain'], repoRoot)
    expect(countWorktreeListPath(afterPrepare, first.workspacePath)).toBe(1)
    expect(countWorktreeListPath(afterPrepare, second.workspacePath)).toBe(1)

    await second.cleanup()
  })

  it('hydrates cold v2 caches as bare mirrors while files land only in the local worktree', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const remote = await createRemoteRepo(root, 'core-app')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const coldRecord = vi.spyOn(repoCacheColdHydrationDurationHistogram, 'record')
    const holdRecord = vi.spyOn(repoCacheLockHoldHistogram, 'record')
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: remote.remoteUrl,
      },
      remote.commitSha,
      'master',
    )
    const mirrorRoot = path.join(repoCacheBasePath, 'core-app.git')

    expect(workspace.repoRoot).toBe(mirrorRoot)
    expect(git([`--git-dir=${mirrorRoot}`, 'rev-parse', '--is-bare-repository'], root)).toBe('true')
    expect(await pathExists(path.join(mirrorRoot, 'tracked.txt'))).toBe(false)
    expect(await fs.readFile(path.join(workspace.workspacePath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(coldRecord).toHaveBeenCalledWith(expect.any(Number), {
      repo_name: 'core-app',
    })
    expect(holdRecord.mock.calls.some((call) => call[1]?.phase === 'fetch')).toBe(true)

    await workspace.cleanup()
  })

  it('repairs bare mirror fetch config before branch fetches without moving checked-out local heads', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, repoRoot, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const checkedOutBranch = 'oneshot/run-214'
    const checkedOutPath = path.join(root, 'checked-out-branch')
    git(['worktree', 'add', '--detach', checkedOutPath, commitSha], repoRoot)
    git(['switch', '-C', checkedOutBranch, commitSha], checkedOutPath)
    git(['checkout', '-B', checkedOutBranch, 'master'], sourceRoot)
    await fs.writeFile(path.join(sourceRoot, 'tracked.txt'), 'remote candidate\n', 'utf8')
    git(['commit', '-am', 'Remote candidate'], sourceRoot)
    const remoteBranchSha = git(['rev-parse', 'HEAD'], sourceRoot)
    git(['checkout', 'master'], sourceRoot)
    expect(git([`--git-dir=${repoRoot}`, 'config', '--get-all', 'remote.origin.fetch'], root)).toBe('+refs/*:refs/*')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'planner-task',
    })

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: sourceRoot,
      },
      remoteBranchSha,
      checkedOutBranch,
    )

    expect(git([`--git-dir=${repoRoot}`, 'config', '--get-all', 'remote.origin.fetch'], root)).toBe(
      '+refs/heads/*:refs/remotes/origin/*',
    )
    expect(() => git([`--git-dir=${repoRoot}`, 'config', '--get', 'remote.origin.mirror'], root)).toThrow()
    expect(git([`--git-dir=${repoRoot}`, 'rev-parse', `refs/remotes/origin/${checkedOutBranch}`], root)).toBe(
      remoteBranchSha,
    )
    expect(git([`--git-dir=${repoRoot}`, 'rev-parse', `refs/heads/${checkedOutBranch}`], root)).toBe(commitSha)
    expect(git(['rev-parse', 'HEAD'], workspace.workspacePath)).toBe(remoteBranchSha)
    expect(() => git([`--git-dir=${repoRoot}`, 'fetch', '--all', '--prune'], root)).not.toThrow()

    await workspace.cleanup()
  })

  it('prepares code-reviewer from a local candidate SHA without fetching a checked-out implementation branch', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, repoRoot, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const implementationBranch = 'oneshot/cpdev-23339-run-214'
    const repo = {
      repo_name: 'core-app',
      repo_url: sourceRoot,
    }
    const implementerStores = buildV2Stores(214)
    const implementerManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: implementerStores.leaseStore as never,
      workspaceStateStore: implementerStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'implementer-task',
    })
    const implementerWorkspace = await implementerManager.prepareImplementerWorkspace(
      214,
      repo,
      commitSha,
      implementationBranch,
      'master',
    )
    git(['config', 'user.email', 'specter-tests@example.com'], implementerWorkspace.workspacePath)
    git(['config', 'user.name', 'Specter Tests'], implementerWorkspace.workspacePath)
    await fs.writeFile(path.join(implementerWorkspace.workspacePath, 'tracked.txt'), 'candidate\n', 'utf8')
    git(['commit', '-am', 'Implementation candidate'], implementerWorkspace.workspacePath)
    const candidateSha = git(['rev-parse', 'HEAD'], implementerWorkspace.workspacePath)
    await implementerWorkspace.cleanup()
    await fs.rm(path.join(worktreeBasePath, '214'), { recursive: true, force: true })
    expect(worktreeListIncludesPath(git(['worktree', 'list', '--porcelain'], repoRoot), implementerWorkspace.workspacePath)).toBe(
      true,
    )
    const reviewerStores = buildV2Stores(214)
    const reviewerManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: reviewerStores.leaseStore as never,
      workspaceStateStore: reviewerStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'code-reviewer-task',
    })

    const reviewerWorkspace = await reviewerManager.prepareCodeReviewerWorkspace(
      214,
      repo,
      candidateSha,
      implementationBranch,
    )

    expect(reviewerWorkspace.workspacePath).toBe(implementerWorkspace.workspacePath)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], reviewerWorkspace.workspacePath)).toBe('HEAD')
    expect(git(['rev-parse', 'HEAD'], reviewerWorkspace.workspacePath)).toBe(candidateSha)
    expect(reviewerStores.workspaceStateStore.upsertStateWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          repoCacheFetchReason: 'candidate_sha_local',
        }),
      }),
    )
    expect(countWorktreeListPath(git(['worktree', 'list', '--porcelain'], repoRoot), reviewerWorkspace.workspacePath)).toBe(1)

    await reviewerWorkspace.cleanup()
  })

  it('fetches missing candidate branches safely for tester workspaces before attaching the implementation branch', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const implementationBranch = 'oneshot/cpdev-23339-run-214'
    git(['checkout', '-B', implementationBranch, 'master'], sourceRoot)
    await fs.writeFile(path.join(sourceRoot, 'tracked.txt'), 'tester candidate\n', 'utf8')
    git(['commit', '-am', 'Tester candidate'], sourceRoot)
    const candidateSha = git(['rev-parse', 'HEAD'], sourceRoot)
    git(['checkout', 'master'], sourceRoot)
    const repoRoot = path.join(repoCacheBasePath, 'core-app.git')
    const { leaseStore, workspaceStateStore } = buildV2Stores(214)
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'tester-task',
    })

    const workspace = await manager.prepareTesterWorkspace(
      214,
      {
        repo_name: 'core-app',
        repo_url: sourceRoot,
      },
      candidateSha,
      implementationBranch,
      implementationBranch,
    )

    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.workspacePath)).toBe(implementationBranch)
    expect(git(['rev-parse', 'HEAD'], workspace.workspacePath)).toBe(candidateSha)
    expect(git([`--git-dir=${repoRoot}`, 'rev-parse', `refs/remotes/origin/${implementationBranch}`], root)).toBe(
      candidateSha,
    )
    expect(git([`--git-dir=${repoRoot}`, 'rev-parse', `refs/heads/${implementationBranch}`], root)).toBe(candidateSha)
    expect(workspaceStateStore.upsertStateWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          repoCacheFetchReason: 'missing_required_sha',
        }),
      }),
    )

    await workspace.cleanup()
  })

  it('replaces invalid partial bare mirrors before v2 hydration', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const mirrorRoot = path.join(repoCacheBasePath, 'core-app.git')
    const remote = await createRemoteRepo(root, 'core-app')
    await fs.mkdir(mirrorRoot, { recursive: true })
    await fs.writeFile(path.join(mirrorRoot, 'partial.txt'), 'not a git repo\n', 'utf8')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: remote.remoteUrl,
      },
      remote.commitSha,
      'master',
    )

    expect(git([`--git-dir=${mirrorRoot}`, 'rev-parse', '--is-bare-repository'], root)).toBe('true')
    expect(await pathExists(path.join(mirrorRoot, 'partial.txt'))).toBe(false)
    expect(git(['rev-parse', 'HEAD'], workspace.workspacePath)).toBe(remote.commitSha)

    await workspace.cleanup()
  })

  it('ignores legacy checked-out caches when hydrating new v2 bare mirrors', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const legacyRoot = path.join(repoCacheBasePath, 'core-app')
    const remote = await createRemoteRepo(root, 'upstream-core-app')
    await fs.mkdir(legacyRoot, { recursive: true })
    git(['init'], legacyRoot)
    git(['checkout', '-B', 'master'], legacyRoot)
    git(['config', 'user.email', 'specter-tests@example.com'], legacyRoot)
    git(['config', 'user.name', 'Specter Tests'], legacyRoot)
    await fs.writeFile(path.join(legacyRoot, 'tracked.txt'), 'legacy cache\n', 'utf8')
    git(['add', 'tracked.txt'], legacyRoot)
    git(['commit', '-m', 'Legacy cache'], legacyRoot)
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: remote.remoteUrl,
      },
      remote.commitSha,
      'master',
    )

    expect(await pathExists(legacyRoot)).toBe(true)
    expect(workspace.repoRoot).toBe(path.join(repoCacheBasePath, 'core-app.git'))
    expect(await fs.readFile(path.join(workspace.workspacePath, 'tracked.txt'), 'utf8')).toBe('base\n')

    await workspace.cleanup()
  })

  it('clears stale split v2 registrations before recreating a missing local worktree', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const { commitSha } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const repoRoot = path.join(repoCacheBasePath, 'core-app.git')
    const firstStores = buildV2Stores(42)
    const firstManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'planner-task',
    })
    const first = await firstManager.preparePlannerWorkspace(42, repo, commitSha, 'master')
    await first.cleanup()

    await fs.rm(path.join(worktreeBasePath, '42'), { recursive: true, force: true })
    const staleWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot)
    expect(worktreeListIncludesPath(staleWorktrees, first.workspacePath)).toBe(true)

    const secondStores = buildV2Stores(42)
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'reviewer-task',
    })
    const second = await secondManager.prepareReviewerWorkspace(42, repo, commitSha, 'master')

    expect(second.workspacePath).toBe(first.workspacePath)
    expect(git(['rev-parse', 'HEAD'], second.workspacePath)).toBe(commitSha)
    const repairedWorktrees = git(['worktree', 'list', '--porcelain'], repoRoot)
    expect(countWorktreeListPath(repairedWorktrees, second.workspacePath)).toBe(1)
    expect(repairedWorktrees).not.toContain('prunable')

    await second.cleanup()
  })

  it('fetches retrofit source branches so local v2 worktrees can inspect origin refs', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const sourceBranch = 'retrofit/source'
    git(['checkout', '-B', sourceBranch, 'master'], sourceRoot)
    await fs.writeFile(path.join(sourceRoot, 'retrofit.txt'), 'source branch\n', 'utf8')
    git(['add', 'retrofit.txt'], sourceRoot)
    git(['commit', '-m', 'Retrofit source change'], sourceRoot)
    const sourceSha = git(['rev-parse', 'HEAD'], sourceRoot)
    git(['checkout', 'master'], sourceRoot)
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: sourceRoot,
      },
      commitSha,
      'master',
      [sourceBranch],
    )

    expect(git(['rev-parse', `refs/remotes/origin/${sourceBranch}`], workspace.workspacePath)).toBe(sourceSha)
    expect(git(['log', '--oneline', '-1', `origin/${sourceBranch}`], workspace.workspacePath)).toContain(
      'Retrofit source change',
    )

    await workspace.cleanup()
  })

  it('skips v2 repo fetch when the required SHA exists and branch cache is fresh', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const cacheStatePath = path.join(repoBasePath, 'core-app.git', 'oneshot-cache-state.json')
    const lastFetchAt = new Date().toISOString()
    await fs.writeFile(
      cacheStatePath,
      JSON.stringify({
        branches: {
          master: {
            lastFetchAt,
            remoteHeadSha: commitSha,
          },
        },
      }),
      'utf8',
    )
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      repoCacheFreshnessTtlMs: 300_000,
    })

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
    )

    expect(workspaceStateStore.upsertStateWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lastRepoFetchAt: new Date(lastFetchAt),
        lastRemoteHeadSha: commitSha,
        metadata: expect.objectContaining({
          repoCacheFetchReason: 'fresh_cache',
        }),
      }),
    )
    await workspace.cleanup()
  })

  it('refreshes stale v2 repo cache metadata under the repo lease', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const remote = await createRemoteRepo(root, 'core-app')
    const firstStores = buildV2Stores()
    const firstManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      repoCacheFreshnessTtlMs: 300_000,
    })
    const firstWorkspace = await firstManager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: remote.remoteUrl,
      },
      remote.commitSha,
      'master',
    )
    await firstWorkspace.cleanup()

    const staleFetchAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    const cacheStatePath = path.join(repoBasePath, 'core-app.git', 'oneshot-cache-state.json')
    await fs.writeFile(
      cacheStatePath,
      JSON.stringify({
        branches: {
          master: {
            lastFetchAt: staleFetchAt,
            remoteHeadSha: remote.commitSha,
          },
        },
      }),
      'utf8',
    )
    const secondStores = buildV2Stores()
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      repoCacheFreshnessTtlMs: 1_000,
    })

    const secondWorkspace = await secondManager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: remote.remoteUrl,
      },
      remote.commitSha,
      'master',
    )

    expect(secondStores.workspaceStateStore.upsertStateWithLease).toHaveBeenCalledWith(
      expect.objectContaining({
        lastRemoteHeadSha: remote.commitSha,
        metadata: expect.objectContaining({
          repoCacheFetchReason: 'stale_cache',
        }),
      }),
    )
    const refreshedCache = JSON.parse(await fs.readFile(cacheStatePath, 'utf8'))
    expect(refreshedCache.branches.master.lastFetchAt).not.toBe(staleFetchAt)
    await secondWorkspace.cleanup()
  })

  it('refreshes rewritten draft branches in the v2 repo cache', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const remote = await createRemoteRepo(root, 'core-app')
    git(['remote', 'add', 'origin', remote.remoteUrl], remote.sourceRoot)
    const branchName = 'oneshot/test-run-42'

    git(['checkout', '-B', branchName, 'master'], remote.sourceRoot)
    await fs.writeFile(path.join(remote.sourceRoot, 'tracked.txt'), 'draft-a\n', 'utf8')
    git(['commit', '-am', 'Draft A'], remote.sourceRoot)
    const draftA = git(['rev-parse', 'HEAD'], remote.sourceRoot)
    git(['push', '-u', 'origin', branchName], remote.sourceRoot)

    const firstStores = buildV2Stores()
    const firstManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      repoCacheFreshnessTtlMs: 300_000,
    })
    const firstWorkspace = await firstManager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: remote.remoteUrl,
      },
      draftA,
      branchName,
    )
    await firstWorkspace.cleanup()

    git(['checkout', '-B', branchName, 'master'], remote.sourceRoot)
    await fs.writeFile(path.join(remote.sourceRoot, 'tracked.txt'), 'draft-b\n', 'utf8')
    git(['commit', '-am', 'Draft B'], remote.sourceRoot)
    const draftB = git(['rev-parse', 'HEAD'], remote.sourceRoot)
    git(['push', '--force', 'origin', branchName], remote.sourceRoot)
    const cacheStatePath = path.join(repoBasePath, 'core-app.git', 'oneshot-cache-state.json')
    const staleFetchAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    await fs.writeFile(
      cacheStatePath,
      JSON.stringify({
        branches: {
          [branchName]: {
            lastFetchAt: staleFetchAt,
            remoteHeadSha: draftA,
          },
        },
      }),
      'utf8',
    )

    const secondStores = buildV2Stores()
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      repoCacheFreshnessTtlMs: 1_000,
    })

    const secondWorkspace = await secondManager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: remote.remoteUrl,
      },
      draftB,
      branchName,
    )

    expect(git(['rev-parse', `refs/remotes/origin/${branchName}`], path.join(repoBasePath, 'core-app.git'))).toBe(
      draftB,
    )
    expect(git(['rev-parse', 'HEAD'], secondWorkspace.workspacePath)).toBe(draftB)
    await secondWorkspace.cleanup()
  })

  it('fails v2 workspace prep when the lease is lost before recording state', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    workspaceStateStore.upsertStateWithLease.mockResolvedValueOnce(false)
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    await expect(
      manager.preparePlannerWorkspace(
        42,
        {
          repo_name: 'core-app',
          repo_url: 'https://github.com/example/core-app.git',
        },
        commitSha,
        'master',
      ),
    ).rejects.toThrow(/before recording prepared workspace state/)

    expect(leaseStore.recordLeaseLost).toHaveBeenCalledWith(
      'run-worktree:42',
      'planner',
      'workspace_state_prepare',
    )
  })

  it('fails missing additional planner branches before acquiring the v2 run lease', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
	    const root = await createTempRoot()
	    const repoBasePath = path.join(root, 'repo-admin')
	    const workspaceBasePath = path.join(root, 'oneshot')
	    const { leaseStore, workspaceStateStore } = buildV2Stores()
	    class MissingBranchWorkspaceManager extends OneShotWorkspaceManager {
	      protected override async runGitStep(
	        args: string[],
	        cwd: string,
	        context: Record<string, unknown>,
	      ) {
	        if (
	          context.action === 'git_fetch_branch' &&
	          args.some((arg) => arg.includes('missing-retrofit-source'))
	        ) {
	          const error = new Error('git fetch failed') as Error & { stderr?: string }
	          error.stderr =
	            "fatal: couldn't find remote ref refs/heads/missing-retrofit-source"
	          throw error
	        }
	        return super.runGitStep(args, cwd, context)
	      }
	    }
	    const manager = new MissingBranchWorkspaceManager({
	      repoBasePath,
	      workspaceBasePath,
	      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    await expect(
      manager.preparePlannerWorkspace(
        42,
        {
          repo_name: 'core-app',
          repo_url: path.join(repoBasePath, 'core-app'),
        },
        commitSha,
        'master',
        ['missing-retrofit-source'],
      ),
    ).rejects.toThrow(
      /retrofit_source_branch_missing: Retrofit source branch missing-retrofit-source was not found on origin\./,
    )

    expect(leaseStore.acquireLease).toHaveBeenCalledTimes(1)
    expect(leaseStore.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'repo-cache:core-app',
        ownerTaskArn: 'task-arn',
        ownerStage: 'planner',
        ttlSeconds: expect.any(Number),
      }),
    )
    expect(leaseStore.releaseLease).toHaveBeenCalledWith(
      'repo-cache:core-app',
      1,
    )
    expect(workspaceStateStore.upsertStateWithLease).not.toHaveBeenCalled()
  })

  it('throws a typed repo-cache lease timeout before workspace prep', async () => {
    vi.useFakeTimers()
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const workspaceBasePath = path.join(root, 'oneshot')
    const leaseStore = {
      acquireLease: vi.fn().mockResolvedValue(null),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const workspaceStateStore = {
      upsertStateWithLease: vi.fn().mockResolvedValue(true),
      conditionalUpdateWithLease: vi.fn().mockResolvedValue(true),
    }
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const promise = manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      'deadbeef',
      'master',
    )
    const assertion = expect(promise).rejects.toBeInstanceOf(RepoCacheLeaseTimeoutError)
    await vi.advanceTimersByTimeAsync(61_000)

    await assertion
    expect(leaseStore.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'repo-cache:core-app' }),
    )
    expect(workspaceStateStore.upsertStateWithLease).not.toHaveBeenCalled()
  })

  it('uses a per-call repo-cache lease wait override with retry metadata', async () => {
    vi.useFakeTimers()
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const workspaceBasePath = path.join(root, 'oneshot')
    const leaseStore = {
      acquireLease: vi.fn().mockResolvedValue(null),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const workspaceStateStore = {
      upsertStateWithLease: vi.fn().mockResolvedValue(true),
      conditionalUpdateWithLease: vi.fn().mockResolvedValue(true),
    }
    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const promise = manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      'deadbeef',
      'master',
      ['medhok-monorepo-master'],
      {
        repoCacheLeaseMaxWaitMs: 3_000,
        repoCacheLeaseMetadata: {
          reason: 'multi_branch_retrofit_repo_cache_wait',
          groupId: 7,
          repoId: 11,
          targetBranch: 'master',
        },
      },
    )
    const assertion = expect(promise).rejects.toMatchObject({
      metadata: expect.objectContaining({
        reason: 'multi_branch_retrofit_repo_cache_wait',
        groupId: 7,
        repoId: 11,
        targetBranch: 'master',
        maxWaitMs: 3_000,
        retryable: true,
      }),
    })
    await vi.advanceTimersByTimeAsync(4_000)

    await assertion
    expect(leaseStore.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'repo-cache:core-app' }),
    )
    expect(workspaceStateStore.upsertStateWithLease).not.toHaveBeenCalled()
  })

  it('throws a typed checkout timeout when git worktree add is killed', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    class WorktreeAddTimeoutWorkspaceManager extends OneShotWorkspaceManager {
      protected override async execGitCommand(
        args: string[],
        cwd: string,
        timeoutMs?: number,
      ) {
        const worktreeIndex = args.findIndex((arg) => arg === 'worktree')
        if (worktreeIndex >= 0 && args[worktreeIndex + 1] === 'add') {
          const error = new Error('Command failed: git worktree add') as Error & {
            code?: number | null
            killed?: boolean
            signal?: NodeJS.Signals | null
            stderr?: string
            stdout?: string
          }
          error.code = null
          error.killed = true
          error.signal = 'SIGTERM'
          error.stderr = 'Updating files:  29% (9092/31115)'
          throw error
        }
        return super.execGitCommand(args, cwd, timeoutMs)
      }
    }
    const manager = new WorktreeAddTimeoutWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    await expect(
      manager.preparePlannerWorkspace(
        42,
        {
          repo_name: 'core-app',
          repo_url: 'https://github.com/example/core-app.git',
        },
        commitSha,
        'master',
      ),
    ).rejects.toBeInstanceOf(WorkspaceCheckoutTimeoutError)
    expect(workspaceStateStore.upsertStateWithLease).not.toHaveBeenCalled()
  })

  it('preserves transient additional planner branch fetch failures as retryable errors', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    class TransientFetchFailureWorkspaceManager extends OneShotWorkspaceManager {
      protected override async runGitStep(
        args: string[],
        cwd: string,
        context: Record<string, unknown>,
      ) {
        if (context.action === 'git_fetch_branch') {
          const error = new Error(
            'fatal: unable to access repository: Could not resolve host: github.com',
          ) as Error & { stderr?: string }
          error.stderr =
            'fatal: unable to access repository: Could not resolve host: github.com'
          throw error
        }
        return super.runGitStep(args, cwd, context)
      }
    }
    const manager = new TransientFetchFailureWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    const promise = manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
      ['batch-monorepo-master'],
    )

    await expect(promise).rejects.toThrow(/Could not resolve host/)
    await expect(promise).rejects.not.toThrow(/retrofit_source_branch_missing/)
  })

  it('fails closed after three consecutive v2 heartbeat failures', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      leaseHeartbeatSeconds: 0.01,
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
    )

    const heartbeatCallsBeforeFailure = leaseStore.heartbeatLease.mock.calls.length
    leaseStore.heartbeatLease.mockResolvedValue(false)
    await vi.waitFor(() => {
      expect(leaseStore.heartbeatLease.mock.calls.length).toBeGreaterThanOrEqual(
        heartbeatCallsBeforeFailure + 3,
      )
    })

    await expect(workspace.assertLeaseValid?.('planner')).rejects.toThrow(
      /after heartbeat failures/,
    )
    expect(leaseStore.recordLeaseLost).toHaveBeenCalledWith(
      'run-worktree:42',
      'planner',
      'heartbeat_failed',
    )
    await workspace.cleanup()
  })

  it('resets v2 heartbeat failure count after a successful renewal', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const { leaseStore, workspaceStateStore } = buildV2Stores()
    let heartbeatCalls = 0
    leaseStore.heartbeatLease.mockImplementation(async () => {
      heartbeatCalls += 1
      return heartbeatCalls === 3 || heartbeatCalls > 5
    })
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: leaseStore as never,
      workspaceStateStore: workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
      leaseHeartbeatSeconds: 0.01,
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    const workspace = await manager.preparePlannerWorkspace(
      42,
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/example/core-app.git',
      },
      commitSha,
      'master',
    )

    await vi.waitFor(() => {
      expect(leaseStore.heartbeatLease.mock.calls.length).toBeGreaterThanOrEqual(5)
    })

    await expect(workspace.assertLeaseValid?.('planner')).resolves.toBeUndefined()
    expect(leaseStore.recordLeaseLost).not.toHaveBeenCalledWith(
      'run-worktree:42',
      'planner',
      'heartbeat_failed',
    )
    await workspace.cleanup()
  })

  it('resets and cleans a reused pinned v2 worktree before handing it to a stage', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const firstStores = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')

    const dirtyWorkspace = await manager.preparePlannerWorkspace(
      42,
      repo,
      commitSha,
      'master',
    )
    await fs.writeFile(path.join(dirtyWorkspace.workspacePath, 'tracked.txt'), 'dirty\n', 'utf8')
    await fs.writeFile(path.join(dirtyWorkspace.workspacePath, 'generated.tmp'), 'artifact\n', 'utf8')
    await dirtyWorkspace.cleanup()

    const secondStores = buildV2Stores()
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const reusedWorkspace = await secondManager.preparePlannerWorkspace(
      42,
      repo,
      commitSha,
      'master',
    )

    expect(await fs.readFile(path.join(reusedWorkspace.workspacePath, 'tracked.txt'), 'utf8')).toBe('base\n')
    expect(await pathExists(path.join(reusedWorkspace.workspacePath, 'generated.tmp'))).toBe(false)
    expect(git(['status', '--porcelain'], reusedWorkspace.workspacePath)).toBe('')
    await reusedWorkspace.cleanup()
  })

  it('rebuilds a pinned v2 worktree when the existing HEAD is stale', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const firstStores = buildV2Stores()
    const manager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: firstStores.leaseStore as never,
      workspaceStateStore: firstStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha: firstCommitSha, sourceRoot } = await createHydratedRepo(repoBasePath, 'core-app')
    repo.repo_url = sourceRoot
    await fs.writeFile(path.join(sourceRoot, 'tracked.txt'), 'second\n', 'utf8')
    git(['add', 'tracked.txt'], sourceRoot)
    git(['commit', '-m', 'Second commit'], sourceRoot)
    const secondCommitSha = git(['rev-parse', 'HEAD'], sourceRoot)

    const firstWorkspace = await manager.preparePlannerWorkspace(
      42,
      repo,
      firstCommitSha,
      'master',
    )
    await firstWorkspace.cleanup()

    const secondStores = buildV2Stores()
    const secondManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: secondStores.leaseStore as never,
      workspaceStateStore: secondStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })

    const repaired = await secondManager.preparePlannerWorkspace(
      42,
      repo,
      secondCommitSha,
      'master',
    )

    expect(git(['rev-parse', 'HEAD'], repaired.workspacePath)).toBe(secondCommitSha)
    expect(await fs.readFile(path.join(repaired.workspacePath, 'tracked.txt'), 'utf8')).toBe('second\n')
    await repaired.cleanup()
  })

  it('acquires the v2 run-worktree lease before terminal cleanup', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const prepareStores = buildV2Stores()
    const prepareManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: prepareStores.leaseStore as never,
      workspaceStateStore: prepareStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const workspace = await prepareManager.preparePlannerWorkspace(42, repo, commitSha, 'master')
    await workspace.cleanup()

    const cleanupRepoLease = {
      scope: 'repo-cache:core-app',
      fencingToken: 98,
      ownerTaskArn: 'cleanup-task',
      ownerStage: 'cleanup',
    }
    const cleanupLease = {
      scope: 'run-worktree:42',
      fencingToken: 99,
      ownerTaskArn: 'cleanup-task',
      ownerStage: 'cleanup',
    }
    const cleanupLeaseStore = {
      acquireLease: vi.fn().mockImplementation(async (input: { scope: string }) => {
        if (input.scope === 'repo-cache:core-app') return cleanupRepoLease
        if (input.scope === 'run-worktree:42') return cleanupLease
        return null
      }),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const cleanupManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: cleanupLeaseStore as never,
      leaseOwnerTaskArn: 'cleanup-task',
    })

    await expect(cleanupManager.cleanupRunWorkspace(42)).resolves.toBe('cleaned')
    expect(cleanupLeaseStore.acquireLease.mock.calls.map((call) => call[0].scope)).toEqual([
      'repo-cache:core-app',
      'run-worktree:42',
    ])
    expect(cleanupLeaseStore.acquireLease.mock.invocationCallOrder[0]).toBeLessThan(
      cleanupLeaseStore.acquireLease.mock.invocationCallOrder[1],
    )
    expect(cleanupLeaseStore.releaseLease).toHaveBeenCalledWith('run-worktree:42', 99)
    expect(cleanupLeaseStore.releaseLease).toHaveBeenCalledWith('repo-cache:core-app', 98)
    expect(await pathExists(path.join(workspaceBasePath, '42'))).toBe(false)
  })

  it('cleans split local v2 worktree paths and exact shared repo cache registrations', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const prepareStores = buildV2Stores()
    const prepareManager = new OneShotWorkspaceManager({
      repoBasePath,
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: prepareStores.leaseStore as never,
      workspaceStateStore: prepareStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const workspace = await prepareManager.preparePlannerWorkspace(42, repo, commitSha, 'master')
    await workspace.cleanup()

    const cleanupRepoLease = {
      scope: 'repo-cache:core-app',
      fencingToken: 98,
      ownerTaskArn: 'cleanup-task',
      ownerStage: 'cleanup',
    }
    const cleanupLease = {
      scope: 'run-worktree:42',
      fencingToken: 99,
      ownerTaskArn: 'cleanup-task',
      ownerStage: 'cleanup',
    }
    const cleanupLeaseStore = {
      acquireLease: vi.fn().mockImplementation(async (input: { scope: string }) => {
        if (input.scope === 'repo-cache:core-app') return cleanupRepoLease
        if (input.scope === 'run-worktree:42') return cleanupLease
        return null
      }),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const cleanupManager = new OneShotWorkspaceManager({
      repoBasePath,
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: cleanupLeaseStore as never,
      leaseOwnerTaskArn: 'cleanup-task',
    })

    await expect(cleanupManager.cleanupRunWorkspace(42)).resolves.toBe('cleaned')
    expect(await pathExists(path.join(worktreeBasePath, '42'))).toBe(false)
    expect(await pathExists(path.join(workspaceBasePath, '42'))).toBe(false)
    expect(
      worktreeListIncludesPath(
        git(['worktree', 'list', '--porcelain'], path.join(repoCacheBasePath, 'core-app.git')),
        workspace.workspacePath,
      ),
    ).toBe(false)
  })

  it('skips v2 terminal cleanup while the run-worktree lease is held', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const prepareStores = buildV2Stores()
    const prepareManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: prepareStores.leaseStore as never,
      workspaceStateStore: prepareStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const workspace = await prepareManager.preparePlannerWorkspace(42, repo, commitSha, 'master')
    await workspace.cleanup()

    const cleanupRepoLease = {
      scope: 'repo-cache:core-app',
      fencingToken: 98,
      ownerTaskArn: 'cleanup-task',
      ownerStage: 'cleanup',
    }
    const cleanupLeaseStore = {
      acquireLease: vi.fn().mockImplementation(async (input: { scope: string }) => {
        if (input.scope === 'repo-cache:core-app') return cleanupRepoLease
        if (input.scope === 'run-worktree:42') return null
        return null
      }),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const cleanupManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: cleanupLeaseStore as never,
      leaseOwnerTaskArn: 'cleanup-task',
    })

    await expect(cleanupManager.cleanupRunWorkspace(42)).resolves.toBe('skipped_lease_held')
    expect(cleanupLeaseStore.acquireLease.mock.calls.map((call) => call[0].scope)).toEqual([
      'repo-cache:core-app',
      'run-worktree:42',
    ])
    expect(cleanupLeaseStore.releaseLease).toHaveBeenCalledWith('repo-cache:core-app', 98)
    expect(await pathExists(path.join(workspaceBasePath, '42', 'worktree'))).toBe(true)
  })

  it('skips v2 terminal cleanup while the repo-cache lease is held', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const prepareStores = buildV2Stores()
    const prepareManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: prepareStores.leaseStore as never,
      workspaceStateStore: prepareStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const workspace = await prepareManager.preparePlannerWorkspace(42, repo, commitSha, 'master')
    await workspace.cleanup()

    const cleanupLeaseStore = {
      acquireLease: vi.fn().mockResolvedValue(null),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const cleanupManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: cleanupLeaseStore as never,
      leaseOwnerTaskArn: 'cleanup-task',
    })

    await expect(cleanupManager.cleanupRunWorkspace(42)).resolves.toBe('skipped_lease_held')
    expect(cleanupLeaseStore.acquireLease).toHaveBeenCalledTimes(1)
    expect(cleanupLeaseStore.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'repo-cache:core-app',
        ownerStage: 'cleanup',
      }),
    )
    expect(cleanupLeaseStore.releaseLease).not.toHaveBeenCalled()
    expect(await pathExists(path.join(workspaceBasePath, '42', 'worktree'))).toBe(true)
  })

  it('fails closed when cleanup lease heartbeats are lost before the next guarded mutation', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const repo = {
      repo_name: 'core-app',
      repo_url: 'https://github.com/example/core-app.git',
    }
    const prepareStores = buildV2Stores()
    const prepareManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: prepareStores.leaseStore as never,
      workspaceStateStore: prepareStores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'task-arn',
    })
    const { commitSha } = await createHydratedRepo(repoBasePath, 'core-app')
    const workspace = await prepareManager.preparePlannerWorkspace(42, repo, commitSha, 'master')
    await workspace.cleanup()

    const cleanupRepoLease = {
      scope: 'repo-cache:core-app',
      fencingToken: 98,
      ownerTaskArn: 'cleanup-task',
      ownerStage: 'cleanup',
    }
    const cleanupLease = {
      scope: 'run-worktree:42',
      fencingToken: 99,
      ownerTaskArn: 'cleanup-task',
      ownerStage: 'cleanup',
    }
    const cleanupLeaseStore = {
      acquireLease: vi.fn().mockImplementation(async (input: { scope: string }) => {
        if (input.scope === 'repo-cache:core-app') return cleanupRepoLease
        if (input.scope === 'run-worktree:42') return cleanupLease
        return null
      }),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(false),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const cleanupManager = new SlowCleanupWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: cleanupLeaseStore as never,
      leaseOwnerTaskArn: 'cleanup-task',
      leaseHeartbeatSeconds: 0.01,
    })

    await expect(cleanupManager.cleanupRunWorkspace(42)).rejects.toThrow(/after heartbeat failures/)
    expect(cleanupLeaseStore.heartbeatLease).toHaveBeenCalled()
    expect(cleanupLeaseStore.recordLeaseLost).toHaveBeenCalledWith(
      'repo-cache:core-app',
      'cleanup',
      'heartbeat_failed',
    )
    expect(await pathExists(path.join(workspaceBasePath, '42', 'worktree'))).toBe(true)
  })

  it('uses the run workspace mode to protect v2 cleanup even when the worktree is missing', async () => {
    const root = await createTempRoot()
    const repoBasePath = path.join(root, 'repo-admin')
    const workspaceBasePath = path.join(root, 'oneshot')
    const runPath = path.join(workspaceBasePath, '42')
    await fs.mkdir(path.join(runPath, 'state'), { recursive: true })
    await fs.writeFile(path.join(runPath, 'state', 'marker.json'), '{}', 'utf8')

    const cleanupLeaseStore = {
      acquireLease: vi.fn().mockResolvedValue(null),
      verifyLease: vi.fn().mockResolvedValue(true),
      releaseLease: vi.fn().mockResolvedValue(true),
      heartbeatLease: vi.fn().mockResolvedValue(true),
      recordLeaseLost: vi.fn().mockResolvedValue(undefined),
    }
    const cleanupManager = new OneShotWorkspaceManager({
      repoBasePath,
      workspaceBasePath,
      leaseStore: cleanupLeaseStore as never,
      leaseOwnerTaskArn: 'cleanup-task',
    })

    await expect(cleanupManager.cleanupRunWorkspace(42)).resolves.toBe('skipped_lease_held')
    expect(cleanupLeaseStore.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: 'run-worktree:42',
        ownerStage: 'cleanup',
      }),
    )
    expect(await pathExists(runPath)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// prepareImplementerWorkspace additionalBranchNames forwarding (SPEC-3)
// ---------------------------------------------------------------------------

describe('prepareImplementerWorkspace additionalBranchNames', () => {
  afterEach(async () => {
    if (ORIGINAL_GITHUB_REPO_TOKEN === undefined) {
      delete process.env.GITHUB_REPO_TOKEN
    } else {
      process.env.GITHUB_REPO_TOKEN = ORIGINAL_GITHUB_REPO_TOKEN
    }
    await Promise.all(
      tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
    )
  })

  it('accepts additionalBranchNames parameter and defaults to empty array without it', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const repo = { repo_name: 'core-app', repo_url: sourceRoot }
    const stores = buildV2Stores(55)

    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: stores.leaseStore as never,
      workspaceStateStore: stores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'implementer-task',
      repoCacheFreshnessTtlMs: 300_000,
    })

    // Without additionalBranchNames — should default to [] and not fail
    const workspace = await manager.prepareImplementerWorkspace(
      55,
      repo,
      commitSha,
      'oneshot/cpdev-25333-run-55',
      'master',
    )

    expect(workspace.workspacePath).toBeTruthy()
    expect(workspace.workspacePath.startsWith(worktreeBasePath)).toBe(true)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.workspacePath)).toBe('oneshot/cpdev-25333-run-55')

    await workspace.cleanup()
  })

  it('forwards additionalBranchNames when provided, allowing source branch fetch', async () => {
    process.env.GITHUB_REPO_TOKEN = 'test-token'
    const root = await createTempRoot()
    const repoCacheBasePath = path.join(root, 'efs', 'oneshot', 'repos')
    const worktreeBasePath = path.join(root, 'local-workspaces')
    const workspaceBasePath = path.join(root, 'legacy-oneshot')
    const { commitSha, sourceRoot } = await createHydratedRepo(repoCacheBasePath, 'core-app')
    const repo = { repo_name: 'core-app', repo_url: sourceRoot }
    const stores = buildV2Stores(56)

    const manager = new OneShotWorkspaceManager({
      repoBasePath: path.join(root, 'repo-admin'),
      repoCacheBasePath,
      workspaceBasePath,
      worktreeBasePath,
      leaseStore: stores.leaseStore as never,
      workspaceStateStore: stores.workspaceStateStore as never,
      leaseOwnerTaskArn: 'implementer-task',
      repoCacheFreshnessTtlMs: 300_000,
    })

    // With additionalBranchNames — 'master' is already the base branch so it
    // won't fail due to missing branch; the important thing is the param is accepted.
    const workspace = await manager.prepareImplementerWorkspace(
      56,
      repo,
      commitSha,
      'oneshot/cpdev-25333-run-56',
      'master',
      ['master'], // source branch (using 'master' as a stand-in here)
    )

    expect(workspace.workspacePath).toBeTruthy()
    expect(workspace.workspacePath.startsWith(worktreeBasePath)).toBe(true)

    await workspace.cleanup()
  })
})
