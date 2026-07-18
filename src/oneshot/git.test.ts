import { generateKeyPairSync } from 'crypto'
import { execFileSync } from 'child_process'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  applyPatch,
  buildAuthenticatedRepoUrl,
  buildWriteAuthenticatedRepoUrl,
  createRemoteBranchIfMissing,
  exportSourceCommitPatch,
  getCurrentHeadSha,
  isAncestor,
  isPatchAlreadyApplied,
  isPatchApplicable,
  listChangedFiles,
  pushBranch,
  resolveFirstRemoteBranchHeadClassified,
  runGitCommand,
} from './git.js'
import { clearGitHubAppTokenCacheForTests } from './github-app-auth.js'

function runGit(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
  }).trim()
}

async function createTempRepo(): Promise<string> {
  const repoPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-git-test-'))
  runGit(repoPath, ['init', '-q'])
  runGit(repoPath, ['config', 'user.name', 'OneShot Git Test'])
  runGit(repoPath, ['config', 'user.email', 'oneshot-git-test@example.com'])
  return repoPath
}

describe('listChangedFiles', () => {
  const tempRepos: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempRepos.splice(0).map(async (repoPath) => {
        await fs.rm(repoPath, { recursive: true, force: true })
      }),
    )
  })

  it('includes staged tracked changes and untracked files from workspace status', async () => {
    const repoPath = await createTempRepo()
    tempRepos.push(repoPath)

    await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'initial\n')
    runGit(repoPath, ['add', 'tracked.txt'])
    runGit(repoPath, ['commit', '-qm', 'init'])

    await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'updated\n')
    runGit(repoPath, ['add', 'tracked.txt'])
    await fs.writeFile(path.join(repoPath, 'extra.txt'), 'extra\n')

    await expect(listChangedFiles(repoPath)).resolves.toEqual([
      'extra.txt',
      'tracked.txt',
    ])
  })

  it('includes both old and new paths for staged renames in workspace status', async () => {
    const repoPath = await createTempRepo()
    tempRepos.push(repoPath)

    await fs.writeFile(path.join(repoPath, 'old.txt'), 'initial\n')
    runGit(repoPath, ['add', 'old.txt'])
    runGit(repoPath, ['commit', '-qm', 'init'])

    await fs.rename(
      path.join(repoPath, 'old.txt'),
      path.join(repoPath, 'new.txt'),
    )
    runGit(repoPath, ['add', '-A'])

    await expect(listChangedFiles(repoPath)).resolves.toEqual([
      'new.txt',
      'old.txt',
    ])
  })

  it('includes committed rename and added-file paths between two refs', async () => {
    const repoPath = await createTempRepo()
    tempRepos.push(repoPath)

    await fs.writeFile(path.join(repoPath, 'old.txt'), 'initial\n')
    runGit(repoPath, ['add', 'old.txt'])
    runGit(repoPath, ['commit', '-qm', 'init'])
    const startHead = await getCurrentHeadSha(repoPath)

    await fs.rename(
      path.join(repoPath, 'old.txt'),
      path.join(repoPath, 'new.txt'),
    )
    await fs.writeFile(path.join(repoPath, 'added.txt'), 'added\n')
    runGit(repoPath, ['add', '-A'])
    runGit(repoPath, ['commit', '-qm', 'rename and add'])
    const endHead = await getCurrentHeadSha(repoPath)

    await expect(listChangedFiles(repoPath, startHead, endHead)).resolves.toEqual([
      'added.txt',
      'new.txt',
      'old.txt',
    ])
  })
})

describe('resolveFirstRemoteBranchHeadClassified', () => {
  it('returns the first resolved branch head', async () => {
    const resolveBranchHead = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        branchName: 'master',
        headSha: 'abc123',
      })

    await expect(
      resolveFirstRemoteBranchHeadClassified(
        {
          repo_name: 'core-app',
          repo_url: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
        },
        ['4.3', 'master'],
        { resolveBranchHead },
      ),
    ).resolves.toEqual({
      status: 'resolved',
      branchName: 'master',
      headSha: 'abc123',
      branchCandidates: ['4.3', 'master'],
      attempts: [
        { branchName: '4.3', status: 'not_found' },
        { branchName: 'master', status: 'resolved', headSha: 'abc123' },
      ],
    })
  })

  it('returns not_found when all candidate lookups complete empty', async () => {
    const resolveBranchHead = vi.fn().mockResolvedValue(null)

    await expect(
      resolveFirstRemoteBranchHeadClassified(
        {
          repo_name: 'core-app',
          repo_url: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
        },
        ['4.3', 'master'],
        { resolveBranchHead },
      ),
    ).resolves.toMatchObject({
      status: 'not_found',
      branchCandidates: ['4.3', 'master'],
      attempts: [
        { branchName: '4.3', status: 'not_found' },
        { branchName: 'master', status: 'not_found' },
      ],
    })
  })

  it('returns lookup_failed with sanitized diagnostics when a candidate lookup throws', async () => {
    const resolveBranchHead = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(
        new Error(
          'Command failed: git ls-remote https://x-access-token:secret-token@github.com/mhk-repos/cp-medhok-monorepo.git\nfatal: Authentication failed',
        ),
      )

    const result = await resolveFirstRemoteBranchHeadClassified(
      {
        repo_name: 'core-app',
        repo_url: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
      },
      ['4.3', 'master'],
      { resolveBranchHead },
    )

    expect(result).toMatchObject({
      status: 'lookup_failed',
      repoName: 'core-app',
      githubOwner: 'mhk-repos',
      githubRepo: 'cp-medhok-monorepo',
      failedBranchName: 'master',
      failureCategory: 'auth',
      branchCandidates: ['4.3', 'master'],
    })
    expect(JSON.stringify(result)).not.toContain('secret-token')
  })
})

describe('pushBranch', () => {
  const tempRepos: string[] = []
  const originalReadToken = process.env.GITHUB_REPO_TOKEN
  const originalWriteToken = process.env.GITHUB_WRITE_TOKEN
  const originalAppCredentials = process.env.GITHUB_APP_CREDENTIALS

  afterEach(async () => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (originalReadToken === undefined) {
      delete process.env.GITHUB_REPO_TOKEN
    } else {
      process.env.GITHUB_REPO_TOKEN = originalReadToken
    }
    if (originalWriteToken === undefined) {
      delete process.env.GITHUB_WRITE_TOKEN
    } else {
      process.env.GITHUB_WRITE_TOKEN = originalWriteToken
    }
    if (originalAppCredentials === undefined) {
      delete process.env.GITHUB_APP_CREDENTIALS
    } else {
      process.env.GITHUB_APP_CREDENTIALS = originalAppCredentials
    }
    clearGitHubAppTokenCacheForTests()
    await Promise.all(
      tempRepos.splice(0).map(async (repoPath) => {
        await fs.rm(repoPath, { recursive: true, force: true })
      }),
    )
  })

  it('uses a GitHub App installation token for GitHub HTTPS read URLs', async () => {
    delete process.env.GITHUB_REPO_TOKEN
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    process.env.GITHUB_APP_CREDENTIALS = JSON.stringify({
      appId: '12345',
      installationId: '67890',
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'installation-token',
        expires_at: '2099-01-01T00:00:00Z',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(buildAuthenticatedRepoUrl({
      repo_name: 'repo',
      repo_url: 'https://github.com/org/repo.git',
    })).resolves.toBe('https://x-access-token:installation-token@github.com/org/repo.git')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      repositories: ['repo'],
      permissions: {
        contents: 'read',
      },
    })
  })

  it('uses a GitHub App installation token for GitHub HTTPS write URLs', async () => {
    delete process.env.GITHUB_WRITE_TOKEN
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    process.env.GITHUB_APP_CREDENTIALS = JSON.stringify({
      appId: '12345',
      installationId: '67890',
      privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'installation-token',
        expires_at: '2099-01-01T00:00:00Z',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(buildWriteAuthenticatedRepoUrl({
      repo_name: 'repo',
      repo_url: 'https://github.com/org/repo.git',
    })).resolves.toBe('https://x-access-token:installation-token@github.com/org/repo.git')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      repositories: ['repo'],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
      },
    })
  })

  it('accepts GitHub App credentials JSON with raw PEM newlines', async () => {
    delete process.env.GITHUB_WRITE_TOKEN
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
    const privateKeyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString()
    process.env.GITHUB_APP_CREDENTIALS =
      `{"appId":"12345","installationId":"67890","privateKey":"${privateKeyPem}"}`
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        token: 'installation-token',
        expires_at: '2099-01-01T00:00:00Z',
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(buildWriteAuthenticatedRepoUrl({
      repo_name: 'repo',
      repo_url: 'https://github.com/org/repo.git',
    })).resolves.toBe('https://x-access-token:installation-token@github.com/org/repo.git')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('updates an existing branch when pushing to a raw URL with an explicit lease', async () => {
    process.env.GITHUB_REPO_TOKEN = 'read-token'
    process.env.GITHUB_WRITE_TOKEN = 'write-token'

    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-git-push-test-'))
    tempRepos.push(rootPath)
    const remotePath = path.join(rootPath, 'remote.git')
    const workPath = path.join(rootPath, 'work')

    runGit(rootPath, ['init', '--bare', 'remote.git'])
    runGit(rootPath, ['clone', remotePath, 'work'])
    runGit(workPath, ['config', 'user.name', 'OneShot Git Test'])
    runGit(workPath, ['config', 'user.email', 'oneshot-git-test@example.com'])
    await fs.writeFile(path.join(workPath, 'tracked.txt'), 'initial\n')
    runGit(workPath, ['add', 'tracked.txt'])
    runGit(workPath, ['commit', '-qm', 'init'])
    runGit(workPath, ['switch', '-c', 'feature'])
    runGit(workPath, ['push', 'origin', 'feature'])

    await fs.writeFile(path.join(workPath, 'tracked.txt'), 'updated\n')
    runGit(workPath, ['commit', '-am', 'update'])
    const updatedHead = runGit(workPath, ['rev-parse', 'HEAD'])

    await pushBranch(workPath, { repo_name: 'test-repo', repo_url: remotePath }, 'feature')

    expect(runGit(remotePath, ['rev-parse', 'refs/heads/feature'])).toBe(updatedHead)
  })

  it('creates a new branch when the explicit lease expects the remote ref to be absent', async () => {
    process.env.GITHUB_REPO_TOKEN = 'read-token'
    process.env.GITHUB_WRITE_TOKEN = 'write-token'

    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-git-push-test-'))
    tempRepos.push(rootPath)
    const remotePath = path.join(rootPath, 'remote.git')
    const workPath = path.join(rootPath, 'work')

    runGit(rootPath, ['init', '--bare', 'remote.git'])
    runGit(rootPath, ['clone', remotePath, 'work'])
    runGit(workPath, ['config', 'user.name', 'OneShot Git Test'])
    runGit(workPath, ['config', 'user.email', 'oneshot-git-test@example.com'])
    await fs.writeFile(path.join(workPath, 'tracked.txt'), 'initial\n')
    runGit(workPath, ['add', 'tracked.txt'])
    runGit(workPath, ['commit', '-qm', 'init'])
    runGit(workPath, ['switch', '-c', 'feature'])
    const featureHead = runGit(workPath, ['rev-parse', 'HEAD'])

    await pushBranch(workPath, { repo_name: 'test-repo', repo_url: remotePath }, 'feature')

    expect(runGit(remotePath, ['rev-parse', 'refs/heads/feature'])).toBe(featureHead)
  })

  it('rejects a push when the caller expected a different remote head', async () => {
    process.env.GITHUB_REPO_TOKEN = 'read-token'
    process.env.GITHUB_WRITE_TOKEN = 'write-token'

    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-git-push-test-'))
    tempRepos.push(rootPath)
    const remotePath = path.join(rootPath, 'remote.git')
    const workPath = path.join(rootPath, 'work')

    runGit(rootPath, ['init', '--bare', 'remote.git'])
    runGit(rootPath, ['clone', remotePath, 'work'])
    runGit(workPath, ['config', 'user.name', 'OneShot Git Test'])
    runGit(workPath, ['config', 'user.email', 'oneshot-git-test@example.com'])
    await fs.writeFile(path.join(workPath, 'tracked.txt'), 'initial\n')
    runGit(workPath, ['add', 'tracked.txt'])
    runGit(workPath, ['commit', '-qm', 'init'])
    runGit(workPath, ['switch', '-c', 'feature'])
    runGit(workPath, ['push', 'origin', 'feature'])
    const originalHead = runGit(workPath, ['rev-parse', 'HEAD'])

    await fs.writeFile(path.join(workPath, 'tracked.txt'), 'updated\n')
    runGit(workPath, ['commit', '-am', 'update'])

    await expect(
      pushBranch(
        workPath,
        { repo_name: 'test-repo', repo_url: remotePath },
        'feature',
        { expectedRemoteHeadSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      ),
    ).rejects.toThrow(
      'Remote branch feature changed before push: expected aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    )
    expect(runGit(remotePath, ['rev-parse', 'refs/heads/feature'])).toBe(originalHead)
  })

  it('detects whether one commit is an ancestor of another', async () => {
    const repoPath = await createTempRepo()
    tempRepos.push(repoPath)

    await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'initial\n')
    runGit(repoPath, ['add', 'tracked.txt'])
    runGit(repoPath, ['commit', '-qm', 'init'])
    const baseHead = await getCurrentHeadSha(repoPath)

    await fs.writeFile(path.join(repoPath, 'tracked.txt'), 'updated\n')
    runGit(repoPath, ['commit', '-am', 'update'])
    const updatedHead = await getCurrentHeadSha(repoPath)

    await expect(isAncestor(repoPath, baseHead, updatedHead)).resolves.toBe(true)
    await expect(isAncestor(repoPath, updatedHead, baseHead)).resolves.toBe(false)
  })

  it('creates a remote branch from an immutable commit without resetting an existing different head', async () => {
    process.env.GITHUB_REPO_TOKEN = 'read-token'
    process.env.GITHUB_WRITE_TOKEN = 'write-token'

    const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'oneshot-git-branch-test-'))
    tempRepos.push(rootPath)
    const remotePath = path.join(rootPath, 'remote.git')
    const workPath = path.join(rootPath, 'work')

    runGit(rootPath, ['init', '--bare', 'remote.git'])
    runGit(rootPath, ['clone', remotePath, 'work'])
    runGit(workPath, ['config', 'user.name', 'OneShot Git Test'])
    runGit(workPath, ['config', 'user.email', 'oneshot-git-test@example.com'])
    await fs.writeFile(path.join(workPath, 'tracked.txt'), 'initial\n')
    runGit(workPath, ['add', 'tracked.txt'])
    runGit(workPath, ['commit', '-qm', 'init'])
    const baseHead = runGit(workPath, ['rev-parse', 'HEAD'])

    await expect(
      createRemoteBranchIfMissing(
        workPath,
        { repo_name: 'test-repo', repo_url: remotePath },
        'oneshot/cpdev-1-run-2',
        baseHead,
      ),
    ).resolves.toEqual({ created: true, headSha: baseHead })
    expect(runGit(remotePath, ['rev-parse', 'refs/heads/oneshot/cpdev-1-run-2'])).toBe(baseHead)

    await expect(
      createRemoteBranchIfMissing(
        workPath,
        { repo_name: 'test-repo', repo_url: remotePath },
        'oneshot/cpdev-1-run-2',
        baseHead,
      ),
    ).resolves.toEqual({ created: false, headSha: baseHead })

    await fs.writeFile(path.join(workPath, 'tracked.txt'), 'updated\n')
    runGit(workPath, ['commit', '-am', 'update'])
    const updatedHead = runGit(workPath, ['rev-parse', 'HEAD'])

    await expect(
      createRemoteBranchIfMissing(
        workPath,
        { repo_name: 'test-repo', repo_url: remotePath },
        'oneshot/cpdev-1-run-2',
        updatedHead,
      ),
    ).rejects.toThrow(
      `Remote branch oneshot/cpdev-1-run-2 already exists at ${baseHead}; expected ${updatedHead}`,
    )
    expect(runGit(remotePath, ['rev-parse', 'refs/heads/oneshot/cpdev-1-run-2'])).toBe(baseHead)
  })

  it('redacts x-access-token values from failed git command errors', async () => {
    await expect(
      runGitCommand(
        'sh -c \'echo "Command failed: git ls-remote --heads https://x-access-token:secret-token@github.com/org/repo.git refs/heads/main" >&2; exit 1\'',
      ),
    ).rejects.toMatchObject({
      message: expect.stringContaining('x-access-token:***@github.com/org/repo.git'),
      cmd: expect.stringContaining('x-access-token:***@github.com/org/repo.git'),
      stderr: expect.stringContaining('x-access-token:***@github.com/org/repo.git'),
    })
  })
})

describe('retrofit patch primitives', () => {
  const tempRepos: string[] = []

  afterEach(async () => {
    await Promise.all(
      tempRepos.splice(0).map(async (repoPath) => {
        await fs.rm(repoPath, { recursive: true, force: true })
      }),
    )
  })

  async function createRepoWithCommit(): Promise<{ repoPath: string; sha: string }> {
    const repoPath = await createTempRepo()
    tempRepos.push(repoPath)

    await fs.writeFile(path.join(repoPath, 'file.txt'), 'line1\nline2\nline3\n')
    runGit(repoPath, ['add', 'file.txt'])
    runGit(repoPath, ['commit', '-qm', 'initial commit'])

    await fs.writeFile(path.join(repoPath, 'file.txt'), 'line1\nline2\nline3\nline4\n')
    runGit(repoPath, ['add', 'file.txt'])
    runGit(repoPath, ['commit', '-qm', 'add line4'])
    const sha = await getCurrentHeadSha(repoPath)

    return { repoPath, sha }
  }

  it('exportSourceCommitPatch returns the full patch text for a commit', async () => {
    const { repoPath, sha } = await createRepoWithCommit()

    const patch = await exportSourceCommitPatch(repoPath, sha)

    expect(patch).toContain('diff --git')
    expect(patch).toContain('+line4')
    expect(patch).toContain(sha.slice(0, 7))
  })

  it('isPatchApplicable returns true when the patch can be applied cleanly', async () => {
    const { repoPath, sha } = await createRepoWithCommit()

    // Reset to the parent commit so the patch is applicable
    const parentSha = runGit(repoPath, ['rev-parse', `${sha}~1`])
    runGit(repoPath, ['reset', '--hard', parentSha])

    const patch = await exportSourceCommitPatch(repoPath, sha)
    await expect(isPatchApplicable(repoPath, patch)).resolves.toBe(true)
  })

  it('isPatchApplicable returns false when the patch conflicts', async () => {
    const { repoPath, sha } = await createRepoWithCommit()

    // Diverge the file to cause a conflict
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'completely different\n')
    runGit(repoPath, ['add', 'file.txt'])
    runGit(repoPath, ['commit', '-qm', 'diverge'])

    const patch = await exportSourceCommitPatch(repoPath, sha)
    await expect(isPatchApplicable(repoPath, patch)).resolves.toBe(false)
  })

  it('isPatchAlreadyApplied returns true when the patch is already present', async () => {
    const { repoPath, sha } = await createRepoWithCommit()

    const patch = await exportSourceCommitPatch(repoPath, sha)

    // The patch for sha is already applied (HEAD == sha)
    await expect(isPatchAlreadyApplied(repoPath, patch)).resolves.toBe(true)
  })

  it('isPatchAlreadyApplied returns false when the patch is not yet applied', async () => {
    const { repoPath, sha } = await createRepoWithCommit()

    const patch = await exportSourceCommitPatch(repoPath, sha)

    // Reset back to parent so the patch is not applied
    const parentSha = runGit(repoPath, ['rev-parse', `${sha}~1`])
    runGit(repoPath, ['reset', '--hard', parentSha])

    await expect(isPatchAlreadyApplied(repoPath, patch)).resolves.toBe(false)
  })

  it('applyPatch returns ok:true and applies the patch to the workspace', async () => {
    const { repoPath, sha } = await createRepoWithCommit()

    const patch = await exportSourceCommitPatch(repoPath, sha)

    // Reset to parent before applying
    const parentSha = runGit(repoPath, ['rev-parse', `${sha}~1`])
    runGit(repoPath, ['reset', '--hard', parentSha])

    const result = await applyPatch(repoPath, patch)
    expect(result.ok).toBe(true)
    expect(result.conflictDiagnostics).toBeUndefined()

    const content = await fs.readFile(path.join(repoPath, 'file.txt'), 'utf8')
    expect(content).toContain('line4')
  })

  it('applyPatch returns ok:false with diagnostics on conflict', async () => {
    const { repoPath, sha } = await createRepoWithCommit()

    // Diverge so patch fails
    await fs.writeFile(path.join(repoPath, 'file.txt'), 'completely different\n')
    runGit(repoPath, ['add', 'file.txt'])
    runGit(repoPath, ['commit', '-qm', 'diverge'])

    const patch = await exportSourceCommitPatch(repoPath, sha)

    const result = await applyPatch(repoPath, patch)
    expect(result.ok).toBe(false)
    expect(result.conflictDiagnostics).toBeTruthy()
  })
})
