import { describe, expect, it, vi } from 'vitest'
import type { CodeRepository, CustomerBranch, Database } from '../orchestrator/database.js'
import { resolveBranchForQualification } from './branch-resolution.js'

const VERSIONED_REPO: CodeRepository = {
  id: 1,
  repo_name: 'core-app',
  repo_url: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
  description: 'core app',
  default_branch: 'master',
  created_at: new Date(),
}

const SINGLE_BRANCH_REPO: CodeRepository = {
  id: 9,
  repo_name: 'mp-product-client-configs',
  repo_url: 'https://github.com/mhk-repos/mp-product-client-configs.git',
  description: 'mp configs',
  default_branch: 'main',
  created_at: new Date(),
}

const CUSTOMER_BRANCH: CustomerBranch = {
  id: 7,
  customer: 'Humana CP',
  branch: '3.18',
  default: false,
}

function createDatabaseStub(): Database {
  return {
    getRepositoryDefaultBranch: vi.fn((repo: CodeRepository) => repo.default_branch || 'main'),
    isVersionedRepository: vi.fn((repo: CodeRepository) => repo.repo_name === 'core-app'),
    getRepoBranchCandidates: vi.fn((repo: CodeRepository, customerBranch: CustomerBranch) => {
      if (repo.repo_name !== 'core-app') {
        return [repo.default_branch || 'main']
      }

      return [
        `medhok-monorepo-${customerBranch.branch}`,
        customerBranch.branch,
      ]
    }),
  } as unknown as Database
}

describe('resolveBranchForQualification', () => {
  it('uses explicit release/version hints for versioned repos', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue({
      branchName: 'medhok-monorepo-3.18',
      headSha: 'abc1234',
    })

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'Please apply this for release 3.18.',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBe('medhok-monorepo-3.18')
    expect(result.baseCommitSha).toBe('abc1234')
    expect(result.resolutionSource).toBe('explicit')
    expect(result.nonBlockingWarnings).toEqual([])
    expect(resolveRemoteBranchHead).toHaveBeenCalledWith(VERSIONED_REPO, [
      '3.18',
      'medhok-monorepo-3.18',
      'master',
    ])
  })

  it('uses labeled FixVersion hints for versioned repos', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue({
      branchName: 'medhok-monorepo-4.0',
      headSha: 'fix4000',
    })

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'Fix version: 4.0',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBe('medhok-monorepo-4.0')
    expect(result.resolutionSource).toBe('explicit')
    expect(result.selectedBranchHint).toMatchObject({
      kind: 'version',
      value: '4.0',
    })
    expect(resolveRemoteBranchHead).toHaveBeenCalledWith(VERSIONED_REPO, [
      '4.0',
      'medhok-monorepo-4.0',
      'master',
    ])
  })

  it('falls back to the configured default branch for single-branch repos', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue({
      branchName: 'main',
      headSha: 'def5678',
    })

    const result = await resolveBranchForQualification(
      db,
      SINGLE_BRANCH_REPO,
      CUSTOMER_BRANCH,
      'No branch hint here.',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBe('main')
    expect(result.baseCommitSha).toBe('def5678')
    expect(result.resolutionSource).toBe('default_branch')
  })

  it('falls back to the configured default branch when an explicit versioned branch is missing', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue({
      branchName: 'master',
      headSha: 'master123',
    })

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'Please apply this for release 3.18.',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBe('master')
    expect(result.baseCommitSha).toBe('master123')
    expect(result.resolutionSource).toBe('default_branch')
    expect(result.fallbackBranchHint).toMatchObject({
      kind: 'release',
      value: '3.18',
    })
    expect(result.nonBlockingWarnings).toEqual([
      'Branch hint release=3.18 did not resolve on core-app; falling back to default branch master. Tried: 3.18, medhok-monorepo-3.18, master.',
    ])
  })

  it('fails when no explicit or default remote branch candidate can be resolved', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue(null)

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'Please apply this for release 3.18.',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBeNull()
    expect(result.baseCommitSha).toBeNull()
    expect(result.failureKind).toBe('branch_not_found')
    expect(result.failureDiagnostics).toMatchObject({
      status: 'not_found',
      branchCandidates: ['3.18', 'medhok-monorepo-3.18', 'master'],
    })
    expect(result.blockingReasons[0]).toBe(
      "No release branch found for FixVersion 3.18 on core-app, and default branch master could not be resolved. Tried: 3.18, medhok-monorepo-3.18, master. Either cut the 3.18 release branch, update the ticket's FixVersion to a branch that exists, or verify the repository default branch master.",
    )
    expect(resolveRemoteBranchHead).toHaveBeenCalledWith(VERSIONED_REPO, [
      '3.18',
      'medhok-monorepo-3.18',
      'master',
    ])
  })

  it('classifies GitHub branch lookup failures as infrastructure rather than branch absence', async () => {
    const db = createDatabaseStub()
    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'FixVersion: 4.3',
      {
        resolveRemoteBranchHeadClassified: vi.fn().mockResolvedValue({
          status: 'lookup_failed',
          repoName: 'core-app',
          githubOwner: 'mhk-repos',
          githubRepo: 'cp-medhok-monorepo',
          failedBranchName: 'master',
          failureCategory: 'auth',
          sanitizedError:
            'Command failed: git ls-remote https://x-access-token:[REDACTED]@github.com/mhk-repos/cp-medhok-monorepo.git\nfatal: Authentication failed',
          branchCandidates: ['4.3', 'medhok-monorepo-4.3', 'master'],
          attempts: [
            { branchName: '4.3', status: 'not_found' },
            { branchName: 'medhok-monorepo-4.3', status: 'not_found' },
            {
              branchName: 'master',
              status: 'lookup_failed',
              failureCategory: 'auth',
              sanitizedError: 'fatal: Authentication failed',
            },
          ],
        }),
      } as any,
    )

    expect(result.branchName).toBeNull()
    expect(result.baseCommitSha).toBeNull()
    expect(result.failureKind).toBe('branch_lookup_failed')
    expect(result.failureDiagnostics).toMatchObject({
      status: 'lookup_failed',
      failedBranchName: 'master',
      failureCategory: 'auth',
    })
    expect(result.blockingReasons[0]).toContain(
      'GitHub branch lookup failed while resolving core-app',
    )
    expect(result.blockingReasons[0]).not.toContain('cut the 4.3 release branch')
    expect(result.blockingReasons[0]).not.toContain('x-access-token')
  })

  it('classifies thrown legacy remote lookup dependencies as branch lookup failures', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockRejectedValue(
      new Error(
        'Command failed: git ls-remote https://x-access-token:secret-token@github.com/mhk-repos/cp-medhok-monorepo.git\nfatal: Authentication failed',
      ),
    )

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'FixVersion: 4.3',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBeNull()
    expect(result.baseCommitSha).toBeNull()
    expect(result.failureKind).toBe('branch_lookup_failed')
    expect(result.failureDiagnostics).toMatchObject({
      status: 'lookup_failed',
      failureCategory: 'auth',
    })
    expect(result.blockingReasons[0]).toContain(
      'GitHub branch lookup failed while resolving core-app',
    )
    expect(result.blockingReasons[0]).not.toContain('secret-token')
  })

  it('uses retrofit target as the run branch and preserves retrofit context', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue({
      branchName: 'batch-monorepo-3.18',
      headSha: 'abc9999',
    })

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      [
        'Retrofit: CPDEV-1234',
        'From: batch-monorepo-master',
        'Target: batch-monorepo-3.18',
      ].join('\n'),
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBe('batch-monorepo-3.18')
    expect(result.retrofitContext).toEqual({
      sourceJiraKey: 'CPDEV-1234',
      sourceBranch: 'batch-monorepo-master',
      targetBranch: 'batch-monorepo-3.18',
    })
    expect(result.selectedBranchHint).toMatchObject({
      kind: 'retrofit_target',
      value: 'batch-monorepo-3.18',
    })
  })

  it('ignores negated branch-looking text when a positive target branch is present', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue({
      branchName: 'batch-monorepo-3.11',
      headSha: 'sha311',
    })

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      [
        'Target Branch: batch-monorepo-3.11',
        'Do not use fix/mm-member-merge-jbpm-log4j.',
      ].join('\n'),
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBe('batch-monorepo-3.11')
    expect(result.ignoredNegatedBranchHints).toEqual([
      expect.objectContaining({
        value: 'fix/mm-member-merge-jbpm-log4j',
        negationPhrase: 'do not use',
      }),
    ])
    expect(resolveRemoteBranchHead).toHaveBeenCalledWith(
      VERSIONED_REPO,
      expect.arrayContaining(['batch-monorepo-3.11']),
    )
  })

  it('blocks conflicting retrofit target and target branch hints', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn()

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      [
        'Retrofit: CPDEV-1234',
        'From: batch-monorepo-master',
        'Target: batch-monorepo-3.18',
        'Target Branch: batch-monorepo-3.11',
      ].join('\n'),
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBeNull()
    expect(result.blockingReasons[0]).toContain('Conflicting target branch hints')
    expect(resolveRemoteBranchHead).not.toHaveBeenCalled()
  })

  it('uses the configured default branch for versioned repos without an explicit branch hint', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue({
      branchName: 'master',
      headSha: 'default999',
    })

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'No branch hint here.',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBe('master')
    expect(result.baseCommitSha).toBe('default999')
    expect(result.resolutionSource).toBe('default_branch')
    expect(result.nonBlockingWarnings).toEqual([])
    expect(resolveRemoteBranchHead).toHaveBeenCalledWith(VERSIONED_REPO, [
      'master',
    ])
  })

  it('does not mention FixVersion when the default branch cannot be resolved without an explicit branch hint', async () => {
    const db = createDatabaseStub()
    const resolveRemoteBranchHead = vi.fn().mockResolvedValue(null)

    const result = await resolveBranchForQualification(
      db,
      VERSIONED_REPO,
      CUSTOMER_BRANCH,
      'No branch hint here.',
      { resolveRemoteBranchHead },
    )

    expect(result.branchName).toBeNull()
    expect(result.baseCommitSha).toBeNull()
    expect(result.blockingReasons[0]).toBe(
      'No qualifying branch was found on core-app. Tried: master.',
    )
  })
})
