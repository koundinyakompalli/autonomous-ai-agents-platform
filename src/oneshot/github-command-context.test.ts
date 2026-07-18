import { describe, expect, it } from 'vitest'
import { formatGitHubCommandContextForPlanner } from './github-command-context.js'

describe('formatGitHubCommandContextForPlanner', () => {
  it('labels /oneshot comments and CI evidence as external PR feedback', () => {
    const context = formatGitHubCommandContextForPlanner({
      pullRequest: {
        url: 'https://github.com/mhk-repos/cp-medhok-monorepo/pull/2454',
        headSha: 'abc123',
        headRef: 'oneshot/CPDEV-123',
      },
      commands: [
        {
          requesterLogin: 'rmadhukar',
          commandText: 'fix the build',
          createdAt: new Date('2026-06-24T12:00:00.000Z'),
        },
      ],
      evidence: {
        state: 'failure',
        description: 'GitHub CI is failing.',
        statuses: [
          {
            context: 'legacy-build',
            state: 'failure',
            description: 'compile failed',
            targetUrl: 'https://github.com/mhk-repos/cp-medhok-monorepo/actions/runs/1',
          },
        ],
        checkRuns: [
          {
            name: 'build',
            status: 'completed',
            conclusion: 'failure',
            htmlUrl: 'https://github.com/mhk-repos/cp-medhok-monorepo/actions/runs/1/job/55',
            outputSummary: 'Tests failed in module cp-core.',
            logSnippet: 'Compilation failure: cannot find symbol.',
          },
        ],
      },
    })

    expect(context).toContain('## GitHub PR feedback for /oneshot replan')
    expect(context).toContain('External PR feedback')
    expect(context).toContain('/oneshot fix the build')
    expect(context).toContain('GitHub CI is failing.')
    expect(context).toContain('legacy-build: failure - compile failed')
    expect(context).toContain('build: failure')
    expect(context).toContain('Compilation failure: cannot find symbol.')
  })
})
