import { describe, expect, it } from 'vitest'
import { buildOneShotPullRequestBody } from './pr-body.js'

describe('buildOneShotPullRequestBody', () => {
  it('renders the expected major sections', () => {
    const body = buildOneShotPullRequestBody({
      jiraKey: 'MPDEV-123',
      ticketSummary: 'Create PFOS draft PR',
      plan: {
        summary: 'Implement the approved PFOS flow.',
        specs: [
          {
            id: 'SPEC-1',
            objective: 'Add queue consumer wiring',
            acceptanceCriteria: ['Queue consumer starts successfully'],
            targetFiles: ['src/oneshot/main.ts', 'src/oneshot/provider.ts'],
            implementationNotes: ['Wire the provider into startup'],
            validationSteps: ['npm run build', 'npm test -- --run src/oneshot'],
          },
        ],
        risks: ['Draft PR may still need human refinement.'],
      },
      implementation: {
        summary: 'Added the queue consumer and provider wiring.',
        completedSpecIds: ['SPEC-1'],
        changedFiles: ['src/oneshot/main.ts', 'src/oneshot/github.ts'],
        testResults: [
          {
            command: 'npm run build',
            status: 'passed',
            summary: 'TypeScript build succeeded.',
          },
        ],
        deviationsFromPlan: [],
        residualRisks: [],
        openFollowUps: [],
      },
    })

    expect(body).toContain('## OneShot Ticket')
    expect(body).toContain('## Changed Files')
    expect(body).toContain('src/oneshot/github.ts')
    expect(body).toContain('npm run build')
  })

  it('renders autonomous readiness when supplied', () => {
    const body = buildOneShotPullRequestBody({
      jiraKey: 'CPDEV-20626',
      ticketSummary: 'Build DTR package',
      plan: {
        summary: 'Implement the package endpoint.',
        specs: [{
          id: 'SPEC-1',
          objective: 'Build package bundle',
          acceptanceCriteria: ['Bundle is created'],
          targetFiles: ['src/service.java'],
          implementationNotes: ['Use local patterns'],
          validationSteps: ['mvn test'],
        }],
        risks: [],
      },
      implementation: {
        summary: 'Implemented package endpoint.',
        completedSpecIds: ['SPEC-1'],
        changedFiles: ['src/service.java'],
        testResults: [],
        deviationsFromPlan: [],
        residualRisks: [],
        openFollowUps: [],
      },
      readiness: {
        completionStatus: 'completed_needs_review',
        readiness: 'needs_review',
        reasons: [{
          code: 'external_spec_observed',
          category: 'external_spec_contract',
          severity: 'medium',
          source: 'external_spec_evidence',
          message: 'External DTR spec evidence needs review.',
        }],
      },
    })

    expect(body).toContain('## Autonomous Readiness')
    expect(body).toContain('Completion status: `completed_needs_review`')
    expect(body).toContain('External DTR spec evidence needs review.')
  })

  it('includes Multi-Repo Context section when multiRepoContext is provided', () => {
    const body = buildOneShotPullRequestBody({
      jiraKey: 'CPDEV-23936',
      ticketSummary: 'Multi-repo feature',
      plan: {
        summary: 'Plan for repo-a.',
        specs: [],
        risks: [],
      },
      implementation: {
        summary: 'Implemented repo-a changes.',
        completedSpecIds: [],
        changedFiles: ['src/api.ts'],
        testResults: [],
        deviationsFromPlan: [],
        residualRisks: [],
        openFollowUps: [],
      },
      multiRepoContext: {
        repoRef: 'org/repo-a',
        mergeOrder: 1,
        totalRepos: 2,
        siblingRepos: ['org/repo-b'],
      },
    })

    expect(body).toContain('## Multi-Repo Context')
    expect(body).toContain('This PR is part of a multi-repo feature group.')
    expect(body).toContain('Merge order: 1 of 2')
    expect(body).toContain('Sibling repos: org/repo-b')
  })

  it('omits Multi-Repo Context section when multiRepoContext is not provided', () => {
    const body = buildOneShotPullRequestBody({
      jiraKey: 'CPDEV-99999',
      ticketSummary: 'Single-repo ticket',
      plan: {
        summary: 'Standard single-repo plan.',
        specs: [],
        risks: [],
      },
      implementation: {
        summary: 'Implemented.',
        completedSpecIds: [],
        changedFiles: [],
        testResults: [],
        deviationsFromPlan: [],
        residualRisks: [],
        openFollowUps: [],
      },
    })

    expect(body).not.toContain('## Multi-Repo Context')
  })

  it('includes Retrofit Traceability section when retrofitTraceability is provided', () => {
    const body = buildOneShotPullRequestBody({
      jiraKey: 'CPDEV-25333',
      ticketSummary: 'Retrofit fix to 3.17',
      plan: {
        summary: 'Retrofit plan.',
        specs: [],
        risks: [],
      },
      implementation: {
        summary: 'Retrofit applied.',
        completedSpecIds: [],
        changedFiles: ['src/service.ts'],
        testResults: [],
        deviationsFromPlan: [],
        residualRisks: [],
        openFollowUps: [],
      },
      retrofitTraceability: {
        sourceJiraKey: 'CPDEV-24856',
        sourceBranch: 'medhok-monorepo-master',
        targetBranch: 'medhok-monorepo-3.17',
        selectedShas: ['abc1234', 'def5678'],
        commitCount: 2,
        perCommitStatus: [
          { sha: 'abc1234', status: 'clean_applied' },
          { sha: 'def5678', status: 'already_applied' },
        ],
      },
    })

    expect(body).toContain('## Retrofit Traceability')
    expect(body).toContain('Source Jira: CPDEV-24856')
    expect(body).toContain('Source branch: `medhok-monorepo-master`')
    expect(body).toContain('Target branch: `medhok-monorepo-3.17`')
    expect(body).toContain('Source commit count: 2')
    expect(body).toContain('abc1234, def5678')
    expect(body).toContain('`abc1234`: clean_applied')
    expect(body).toContain('`def5678`: already_applied')
  })

  it('omits Retrofit Traceability section when retrofitTraceability is not provided', () => {
    const body = buildOneShotPullRequestBody({
      jiraKey: 'CPDEV-99999',
      ticketSummary: 'Normal ticket',
      plan: {
        summary: 'Normal plan.',
        specs: [],
        risks: [],
      },
      implementation: {
        summary: 'Implemented.',
        completedSpecIds: [],
        changedFiles: [],
        testResults: [],
        deviationsFromPlan: [],
        residualRisks: [],
        openFollowUps: [],
      },
    })

    expect(body).not.toContain('## Retrofit Traceability')
  })
})
