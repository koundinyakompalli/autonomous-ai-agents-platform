import { generateKeyPairSync } from 'crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ensureDraftPullRequest,
  fetchCommitStatusSummary,
  fetchPullRequestCommandEvidence,
  fetchMergedPullRequestDetails,
  parseGitHubPullRequestUrl,
  parseGitHubRepoUrl,
  postIssueComment,
  searchMergedPullRequestsByJiraKey,
} from './github.js'
import { clearGitHubAppTokenCacheForTests } from './github-app-auth.js'

function setGitHubAppCredentials(): void {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  process.env.GITHUB_APP_CREDENTIALS = JSON.stringify({
    appId: '12345',
    installationId: '67890',
    privateKey: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  })
}

describe('parseGitHubRepoUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    delete process.env.GITHUB_TOKEN
    delete process.env.GITHUB_REPO_TOKEN
    delete process.env.GITHUB_WRITE_TOKEN
    delete process.env.GITHUB_APP_CREDENTIALS
    delete process.env.GITHUB_APP_ID
    delete process.env.GITHUB_APP_INSTALLATION_ID
    delete process.env.GITHUB_APP_PRIVATE_KEY
    delete process.env.ONESHOT_DISABLE_GITHUB_MUTATIONS
    clearGitHubAppTokenCacheForTests()
  })

  it('parses a standard github url', () => {
    expect(parseGitHubRepoUrl('https://github.com/mhk-repos/cp-medhok-monorepo.git')).toEqual({
      owner: 'mhk-repos',
      repo: 'cp-medhok-monorepo',
    })
  })

  it('rejects unsupported repository urls', () => {
    expect(() => parseGitHubRepoUrl('https://example.com/not-supported.git')).toThrow(/Unsupported/)
  })

  it('parses pull request web and API urls', () => {
    expect(parseGitHubPullRequestUrl('https://github.com/org/repo/pull/42')).toEqual({
      owner: 'org',
      repo: 'repo',
      pullNumber: 42,
    })
    expect(parseGitHubPullRequestUrl('https://api.github.com/repos/org/repo/pulls/7')).toEqual({
      owner: 'org',
      repo: 'repo',
      pullNumber: 7,
    })
  })

  it('fetches merged PR details and touched files', async () => {
    process.env.GITHUB_TOKEN = 'read-token'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          html_url: 'https://github.com/org/repo/pull/42',
          merged: true,
          merged_at: '2026-04-29T00:00:00Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([
          { filename: 'src/a.ts' },
          { filename: 'src/b.ts' },
        ]),
      })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchMergedPullRequestDetails('https://github.com/org/repo/pull/42')).resolves.toEqual({
      owner: 'org',
      repo: 'repo',
      pullNumber: 42,
      htmlUrl: 'https://github.com/org/repo/pull/42',
      files: ['src/a.ts', 'src/b.ts'],
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('does not return learning details for unmerged PRs', async () => {
    process.env.GITHUB_TOKEN = 'read-token'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        number: 42,
        html_url: 'https://github.com/org/repo/pull/42',
        merged: false,
        merged_at: null,
      }),
    }))

    await expect(fetchMergedPullRequestDetails('https://github.com/org/repo/pull/42')).resolves.toBeNull()
  })

  it('searches merged PRs by Jira key and keeps matching repository results', async () => {
    process.env.GITHUB_TOKEN = 'read-token'
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        items: [
          {
            html_url: 'https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575',
            title: 'CPDEV-25448 source fix',
            state: 'closed',
          },
          {
            html_url: 'https://github.com/mhk-repos/other-repo/pull/99',
            title: 'Wrong repo should be ignored',
            state: 'closed',
          },
          {
            html_url: 'not a url',
            title: 'Malformed URL should be ignored',
            state: 'closed',
          },
        ],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      searchMergedPullRequestsByJiraKey({
        owner: 'mhk-repos',
        repo: 'cp-medhok-monorepo',
        jiraKey: 'CPDEV-25448',
        timeoutMs: 1234,
      }),
    ).resolves.toEqual([
      {
        owner: 'mhk-repos',
        repo: 'cp-medhok-monorepo',
        pullNumber: 2575,
        htmlUrl: 'https://github.com/mhk-repos/cp-medhok-monorepo/pull/2575',
        title: 'CPDEV-25448 source fix',
        state: 'closed',
      },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/search/issues?'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer read-token',
        }),
        signal: expect.any(AbortSignal),
      }),
    )
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0] ?? ''))
    expect(requestedUrl.searchParams.get('q')).toBe(
      'repo:mhk-repos/cp-medhok-monorepo is:pr is:merged CPDEV-25448 in:title,body',
    )
  })

  it('fetches combined CI status for a commit', async () => {
    process.env.GITHUB_TOKEN = 'read-token'
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'failure',
        total_count: 2,
        statuses: [
          { target_url: 'https://github.com/org/repo/actions/runs/123' },
        ],
      }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total_count: 0,
        check_runs: [],
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCommitStatusSummary({
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
    })).resolves.toEqual({
      state: 'failure',
      description: 'GitHub CI is failing across 2 status check(s) and 0 check run(s).',
      targetUrl: 'https://github.com/org/repo/actions/runs/123',
      statusCount: 2,
      checkRunCount: 0,
      requiredCheckState: 'unavailable',
      details: [
        'combined_status:failure:2',
        'required_checks:unavailable',
      ],
    })
  })

  it('includes pull request status check rollup when a PR number is available', async () => {
    process.env.GITHUB_TOKEN = 'read-token'
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        state: 'pending',
        total_count: 0,
        statuses: [],
      }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        total_count: 0,
        check_runs: [],
      }),
    }).mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: async () => ({ message: 'branch protection not enabled' }),
    }).mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: {
          repository: {
            pullRequest: {
              commits: {
                nodes: [{
                  commit: {
                    statusCheckRollup: {
                      state: 'FAILURE',
                      contexts: {
                        nodes: [{
                          __typename: 'CheckRun',
                          name: 'build',
                          status: 'COMPLETED',
                          conclusion: 'FAILURE',
                          detailsUrl: 'https://github.com/org/repo/actions/runs/456',
                        }],
                      },
                    },
                  },
                }],
              },
            },
          },
        },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchCommitStatusSummary({
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
      base: 'main',
      pullNumber: 42,
    })).resolves.toMatchObject({
      state: 'failure',
      targetUrl: 'https://github.com/org/repo/actions/runs/456',
      statusCount: 0,
      checkRunCount: 1,
      requiredCheckState: 'none',
      details: expect.arrayContaining([
        'pull_request_rollup:FAILURE',
        'pull_request_check:build:FAILURE',
      ]),
    })
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(String(fetchMock.mock.calls[3]?.[0])).toBe('https://api.github.com/graphql')
    expect(String(fetchMock.mock.calls[3]?.[1]?.body)).toContain('statusCheckRollup')
  })

  it('returns unconfigured CI status when no read token is configured', async () => {
    await expect(fetchCommitStatusSummary({
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
    })).resolves.toMatchObject({
      state: 'unconfigured',
      description: 'GitHub read token is not configured; CI status was not checked.',
      statusCount: 0,
      checkRunCount: 0,
      requiredCheckState: 'unavailable',
    })
  })

  it('creates a new draft pull request when no open PR exists', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          url: 'https://api.github.com/repos/org/repo/pulls/42',
          html_url: 'https://github.com/org/repo/pull/42',
          draft: true,
          node_id: 'PR_kw42',
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'body',
    })

    expect(result).toEqual({
      number: 42,
      url: 'https://api.github.com/repos/org/repo/pulls/42',
      htmlUrl: 'https://github.com/org/repo/pull/42',
      draft: true,
      nodeId: 'PR_kw42',
      headSha: null,
      reused: false,
      updateSyncError: null,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      draft: true,
    })
  })

  it('uses a GitHub App installation token for pull request writes when configured', async () => {
    setGitHubAppCredentials()

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'installation-token',
          expires_at: '2099-01-01T00:00:00Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 42,
          url: 'https://api.github.com/repos/org/repo/pulls/42',
          html_url: 'https://github.com/org/repo/pull/42',
          draft: true,
          node_id: 'PR_kw42',
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'body',
    })

    expect(result.reused).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.github.com/app/installations/67890/access_tokens',
    )
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
      repositories: ['repo'],
      permissions: {
        contents: 'write',
        pull_requests: 'write',
      },
    })
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer installation-token',
    })
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toMatchObject({
      Authorization: 'Bearer installation-token',
    })
  })

  it('rejects incomplete GitHub App credentials instead of falling back to a PAT', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'fallback-token'
    process.env.GITHUB_APP_CREDENTIALS = JSON.stringify({
      appId: '12345',
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'body',
    })).rejects.toThrow(/appId, installationId, and privateKey/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('posts issue comments with the GitHub App command permissions', async () => {
    setGitHubAppCredentials()
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          token: 'installation-token',
          expires_at: '2026-06-24T17:00:00Z',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          html_url: 'https://github.com/org/repo/issues/42#issuecomment-99',
          url: 'https://api.github.com/repos/org/repo/issues/comments/99',
          id: 99,
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    await expect(postIssueComment({
      owner: 'org',
      repo: 'repo',
      issueNumber: 42,
      body: 'queued',
    })).resolves.toEqual({
      id: '99',
      url: 'https://api.github.com/repos/org/repo/issues/comments/99',
      htmlUrl: 'https://github.com/org/repo/issues/42#issuecomment-99',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      repositories: ['repo'],
      permissions: {
        actions: 'read',
        checks: 'read',
        contents: 'read',
        issues: 'write',
        pull_requests: 'write',
        statuses: 'read',
      },
    })
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(
      'https://api.github.com/repos/org/repo/issues/42/comments',
    )
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      body: 'queued',
    })
  })

  it('caps and redacts PR command check evidence', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          state: 'failure',
          total_count: 1,
          statuses: [{
            context: 'legacy-build',
            state: 'failure',
            description: 'secret=abc123 failed',
            target_url: 'https://github.com/org/repo/actions/runs/1',
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          total_count: 1,
          check_runs: [{
            name: 'build',
            status: 'completed',
            conclusion: 'failure',
            html_url: 'https://github.com/org/repo/actions/runs/1/job/55',
            details_url: 'https://github.com/org/repo/actions/runs/1/job/55',
            output: {
              title: 'build failed',
              summary: 'password = hunter2\n'.repeat(300),
            },
          }],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        text: async () => 'TOKEN=topsecret\ncompile failed\n'.repeat(300),
      })
    vi.stubGlobal('fetch', fetchMock)

    const evidence = await fetchPullRequestCommandEvidence({
      owner: 'org',
      repo: 'repo',
      ref: 'abc123',
      pullNumber: 42,
    })

    expect(evidence.state).toBe('failure')
    expect(evidence.statuses).toHaveLength(1)
    expect(evidence.checkRuns).toHaveLength(1)
    expect(evidence.checkRuns[0].outputSummary).not.toContain('hunter2')
    expect(evidence.checkRuns[0].logSnippet).not.toContain('topsecret')
    expect(evidence.checkRuns[0].outputSummary.length).toBeLessThanOrEqual(2000)
    expect(evidence.checkRuns[0].logSnippet?.length).toBeLessThanOrEqual(2000)
  })

  it('can create a ready pull request when readiness gates are clean', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [],
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 43,
          url: 'https://api.github.com/repos/org/repo/pulls/43',
          html_url: 'https://github.com/org/repo/pull/43',
          draft: false,
          node_id: 'PR_kw43',
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    await ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'body',
      draft: false,
    })

    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
      draft: false,
    })
  })

  it('reuses and refreshes an existing open pull request', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{
          number: 7,
          url: 'https://api.github.com/repos/org/repo/pulls/7',
          html_url: 'https://github.com/org/repo/pull/7',
          draft: true,
          node_id: 'PR_kw7',
        }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 7,
          url: 'https://api.github.com/repos/org/repo/pulls/7',
          html_url: 'https://github.com/org/repo/pull/7',
          draft: true,
          node_id: 'PR_kw7',
        }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'updated title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'updated body',
    })

    expect(result).toEqual({
      number: 7,
      url: 'https://api.github.com/repos/org/repo/pulls/7',
      htmlUrl: 'https://github.com/org/repo/pull/7',
      draft: true,
      nodeId: 'PR_kw7',
      headSha: null,
      draftSyncError: null,
      updateSyncError: null,
      reused: true,
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'PATCH',
    })
  })

  it('returns an update sync error when refreshing an existing pull request fails', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{
          number: 7,
          url: 'https://api.github.com/repos/org/repo/pulls/7',
          html_url: 'https://github.com/org/repo/pull/7',
          draft: true,
          node_id: 'PR_kw7',
        }]),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ message: 'server error' }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'updated title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'updated body',
    })

    expect(result).toMatchObject({
      number: 7,
      reused: true,
      updateSyncError: 'GitHub pull request update failed with status 500',
    })
  })

  it('marks an existing draft pull request ready when gates are clean', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{
          number: 8,
          url: 'https://api.github.com/repos/org/repo/pulls/8',
          html_url: 'https://github.com/org/repo/pull/8',
          draft: true,
          node_id: 'PR_kw8',
        }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 8,
          url: 'https://api.github.com/repos/org/repo/pulls/8',
          html_url: 'https://github.com/org/repo/pull/8',
          draft: true,
          node_id: 'PR_kw8',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markPullRequestReadyForReview: { pullRequest: { number: 8, isDraft: false } } } }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'updated title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'updated body',
      draft: false,
    })

    expect(result.draft).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMock.mock.calls[2]?.[0])).toBe('https://api.github.com/graphql')
    expect(String(fetchMock.mock.calls[2]?.[1]?.body)).toContain('markPullRequestReadyForReview')
  })

  it('reports draft sync failure when GraphQL returns the wrong PR state', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ([{
          number: 8,
          url: 'https://api.github.com/repos/org/repo/pulls/8',
          html_url: 'https://github.com/org/repo/pull/8',
          draft: true,
          node_id: 'PR_kw8',
        }]),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          number: 8,
          url: 'https://api.github.com/repos/org/repo/pulls/8',
          html_url: 'https://github.com/org/repo/pull/8',
          draft: true,
          node_id: 'PR_kw8',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { markPullRequestReadyForReview: { pullRequest: { number: 8, isDraft: true } } } }),
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = await ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'updated title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'updated body',
      draft: false,
    })

    expect(result.draft).toBe(true)
    expect(result.draftSyncError).toContain('draft=true')
  })

  it('blocks write APIs when the local mutation guard is set', async () => {
    process.env.GITHUB_WRITE_TOKEN = 'token'
    process.env.ONESHOT_DISABLE_GITHUB_MUTATIONS = 'true'

    await expect(ensureDraftPullRequest({
      owner: 'org',
      repo: 'repo',
      title: 'title',
      head: 'oneshot/branch',
      base: 'master',
      body: 'body',
    })).rejects.toThrow(/GitHub mutation is disabled/)
  })
})
