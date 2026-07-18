import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptComposer } from '../prompt-composer.js'
import type { OneShotPlan } from '../schema/plan.js'
import type { ReviewContext } from '../review-context.js'

const { runOpenAiAgentMock } = vi.hoisted(() => ({
  runOpenAiAgentMock: vi.fn(),
}))

vi.mock('../../openai-sdk/index.js', () => ({
  runOpenAiAgent: runOpenAiAgentMock,
}))

const PLAN: OneShotPlan = {
  jiraKey: 'CPDEV-1',
  repoName: 'core-app',
  branchName: 'master',
  baseCommitSha: 'abc1234',
  summary: 'Test plan',
  specs: [
    {
      id: 'spec-1',
      objective: 'Review a bounded change',
      acceptanceCriteria: ['Criteria 1'],
      targetFiles: ['src/example.ts'],
      implementationNotes: ['Note 1'],
      validationSteps: ['Run test 1'],
    },
  ],
  assumptions: [],
  openQuestions: [],
  outOfScope: [],
  risks: [],
}

const REVIEW_CONTEXT: ReviewContext = {
  impactedFiles: [
    {
      path: 'src/example.ts',
      exists: true,
      included: true,
      truncated: false,
      sizeBytes: 20,
      content: 'export const value = 1\n',
    },
  ],
  totalBytesIncluded: 20,
  truncated: false,
}

describe('OpenAiReviewerProvider', () => {
  beforeEach(() => {
    runOpenAiAgentMock.mockReset()
  })

  it('parses structured output from the shared OpenAI SDK without changing the provider contract', async () => {
    const { OpenAiReviewerProvider } = await import('./openai-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 92,
        sageDimensions: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: ['Looks good'],
        confidence: 'high',
        coverageAssessment: 'Reviewed impacted files and context.',
      },
      metrics: {
        durationMs: 1234,
        toolCalls: 2,
        tokensUsed: {
          input: 100,
          output: 20,
        },
        costUsd: 0.25,
      },
    })

    const promptComposer = {
      composePrompt: vi.fn().mockResolvedValue('Review this plan'),
    } as unknown as PromptComposer

    const provider = new OpenAiReviewerProvider(promptComposer)
    const result = await provider.reviewPlan({
      jiraKey: 'CPDEV-1',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: 'abc1234',
      workspacePath: '/tmp/workspace',
      plan: PLAN,
      reviewContext: REVIEW_CONTEXT,
    })

    expect(result.review).toMatchObject({
      decision: 'APPROVED',
      score: 92,
      confidence: 'high',
    })
    expect(result.rawOutput).toBe('{"decision":"APPROVED"}')
    expect(result.metrics).toEqual({
      durationMs: 1234,
      toolCalls: 2,
      tokensUsed: {
        input: 100,
        output: 20,
      },
      costUsd: 0.25,
    })
    expect(runOpenAiAgentMock).toHaveBeenCalledTimes(1)
    expect(promptComposer.composePrompt).toHaveBeenCalledWith(
      'review',
      expect.objectContaining({
        jiraKey: 'CPDEV-1',
        repoName: 'core-app',
      }),
    )
  })

  it('loads only the security review extension from processingMode', async () => {
    const { OpenAiReviewerProvider } = await import('./openai-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 92,
        sageDimensions: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        coverageAssessment: 'Reviewed impacted files and context.',
      },
      metrics: {
        durationMs: 1234,
        toolCalls: 2,
      },
    })

    const loadSecurityReviewExtension = vi.fn().mockResolvedValue(
      'SECURITY_EXTENSION',
    )
    const loadSonarReviewExtension = vi.fn().mockResolvedValue(
      'SONAR_EXTENSION',
    )
    const provider = new OpenAiReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue('Review this plan'),
      loadSecurityReviewExtension,
      loadSonarReviewExtension,
    } as unknown as PromptComposer)

    await provider.reviewPlan({
      jiraKey: 'CPDEV-1',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: 'abc1234',
      workspacePath: '/tmp/workspace',
      plan: PLAN,
      reviewContext: REVIEW_CONTEXT,
      processingMode: 'security_wiz',
      jiraLabels: ['PFOS'],
    })

    expect(loadSecurityReviewExtension).toHaveBeenCalledTimes(1)
    expect(loadSonarReviewExtension).not.toHaveBeenCalled()
    expect(runOpenAiAgentMock.mock.calls[0]?.[0].userPrompt).toContain(
      'SECURITY_EXTENSION',
    )
    expect(runOpenAiAgentMock.mock.calls[0]?.[0].userPrompt).not.toContain(
      'SONAR_EXTENSION',
    )
  })

  it('loads only the Wiz Code review extension in wiz_code mode', async () => {
    const { OpenAiReviewerProvider } = await import('./openai-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 92,
        sageDimensions: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        coverageAssessment: 'Reviewed impacted files and context.',
      },
      metrics: {
        durationMs: 1234,
        toolCalls: 2,
      },
    })

    const loadSecurityReviewExtension = vi.fn().mockResolvedValue(
      'SECURITY_EXTENSION',
    )
    const loadWizCodeReviewExtension = vi.fn().mockResolvedValue(
      'WIZ_CODE_EXTENSION',
    )
    const loadSonarReviewExtension = vi.fn().mockResolvedValue(
      'SONAR_EXTENSION',
    )
    const provider = new OpenAiReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue('Review this plan'),
      loadSecurityReviewExtension,
      loadWizCodeReviewExtension,
      loadSonarReviewExtension,
    } as unknown as PromptComposer)

    await provider.reviewPlan({
      jiraKey: 'CPDEV-1',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: 'abc1234',
      workspacePath: '/tmp/workspace',
      plan: PLAN,
      reviewContext: REVIEW_CONTEXT,
      processingMode: 'wiz_code',
      jiraLabels: ['WIZ-CODE'],
    })

    expect(loadWizCodeReviewExtension).toHaveBeenCalledTimes(1)
    expect(loadSecurityReviewExtension).not.toHaveBeenCalled()
    expect(loadSonarReviewExtension).not.toHaveBeenCalled()
    expect(runOpenAiAgentMock.mock.calls[0]?.[0].userPrompt).toContain(
      'WIZ_CODE_EXTENSION',
    )
    expect(runOpenAiAgentMock.mock.calls[0]?.[0].userPrompt).not.toContain(
      'SONAR_EXTENSION',
    )
  })

  it('injects the retrofit workflow fragment for retrofit plan validation', async () => {
    const { OpenAiReviewerProvider } = await import('./openai-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 92,
        sageDimensions: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        coverageAssessment: 'Retrofit proof contract is present.',
      },
      metrics: {
        durationMs: 100,
        toolCalls: 1,
      },
    })

    const composePrompt = vi.fn().mockResolvedValue('Review this plan')
    const loadRetrofitWorkflowPrompt = vi
      .fn()
      .mockResolvedValue('CANONICAL RETROFIT WORKFLOW')
    const provider = new OpenAiReviewerProvider({
      composePrompt,
      loadRetrofitWorkflowPrompt,
    } as unknown as PromptComposer)

    await provider.reviewPlan({
      jiraKey: 'CPDEV-650',
      repoName: 'core-app',
      branchName: 'medhok-monorepo-4.0',
      baseCommitSha: 'abc1234',
      workspacePath: '/tmp/workspace',
      plan: {
        ...PLAN,
        plannerDiscoveries: {
          retrofitEvidence: {
            sourceJiraKey: 'CPDEV-25281',
            sourceBranch: 'master',
            targetBranch: 'medhok-monorepo-4.0',
            selectedCommits: [
              {
                sha: '9ce5326',
                subject: 'CPDEV-25281 fix',
                files: ['src/BaseUtils.java'],
                alreadyApplied: false,
              },
            ],
            touchedFiles: ['src/BaseUtils.java'],
            alreadyApplied: false,
            evidenceSummary: 'Source patch needs adaptation.',
          },
        },
      },
      reviewContext: REVIEW_CONTEXT,
    })

    const variables = composePrompt.mock.calls[0][1]
    expect(loadRetrofitWorkflowPrompt).toHaveBeenCalledTimes(1)
    expect(variables.retrofitWorkflowSection).toContain(
      'CANONICAL RETROFIT WORKFLOW',
    )
    expect(variables.retrofitWorkflowSection).toContain('9ce5326')
  })

  it('injects the retrofit workflow from qualification source evidence when the draft plan omitted retrofit evidence', async () => {
    const { OpenAiReviewerProvider } = await import('./openai-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"NEEDS_CHANGES"}',
      structuredOutput: {
        decision: 'NEEDS_CHANGES',
        score: 70,
        sageDimensions: [],
        blockingFindings: [],
        requiredChanges: [
          'Add plannerDiscoveries.retrofitEvidence with selected source SHAs.',
        ],
        nonBlockingSuggestions: [],
        confidence: 'high',
        coverageAssessment: 'Retrofit source evidence is missing from the plan.',
      },
      metrics: {
        durationMs: 100,
        toolCalls: 1,
      },
    })

    const composePrompt = vi.fn().mockResolvedValue('Review this plan')
    const loadRetrofitWorkflowPrompt = vi
      .fn()
      .mockResolvedValue('CANONICAL RETROFIT WORKFLOW')
    const provider = new OpenAiReviewerProvider({
      composePrompt,
      loadRetrofitWorkflowPrompt,
    } as unknown as PromptComposer)

    await provider.reviewPlan({
      jiraKey: 'CPDEV-650',
      repoName: 'core-app',
      branchName: 'medhok-monorepo-4.0',
      baseCommitSha: 'abc1234',
      workspacePath: '/tmp/workspace',
      plan: PLAN,
      retrofitSourceEvidence: {
        sourceJiraKey: 'CPDEV-25281',
        sourceBranch: 'master',
        targetBranch: 'medhok-monorepo-4.0',
        sourceRepoName: 'core-app',
        sourceRepoUrl: 'https://github.com/mhk-repos/cp-medhok-monorepo.git',
        selectedCommits: [
          {
            sha: '9ce5326',
            subject: 'CPDEV-25281 fix',
            files: ['src/BaseUtils.java'],
            alreadyApplied: false,
          },
        ],
        touchedFiles: ['src/BaseUtils.java'],
        evidenceSummary: 'Source patch needs adaptation.',
      },
      reviewContext: REVIEW_CONTEXT,
    })

    const variables = composePrompt.mock.calls[0][1]
    expect(loadRetrofitWorkflowPrompt).toHaveBeenCalledTimes(1)
    expect(variables.retrofitWorkflowSection).toContain(
      'CANONICAL RETROFIT WORKFLOW',
    )
    expect(variables.retrofitWorkflowSection).toContain('CPDEV-25281')
    expect(variables.retrofitWorkflowSection).toContain('9ce5326')
  })
})
