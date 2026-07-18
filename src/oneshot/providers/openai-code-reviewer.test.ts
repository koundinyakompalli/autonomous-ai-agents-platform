import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptComposer } from '../prompt-composer.js'
import type { OneShotPlan } from '../schema/plan.js'
import type { CodeReviewContext } from '../code-review-context.js'

const { runOpenAiAgentMock } = vi.hoisted(() => ({
  runOpenAiAgentMock: vi.fn(),
}))

vi.mock('../../openai-sdk/index.js', () => ({
  runOpenAiAgent: runOpenAiAgentMock,
}))

const PLAN: OneShotPlan = {
  jiraKey: 'CPDEV-2',
  repoName: 'core-app',
  branchName: 'master',
  baseCommitSha: 'def5678',
  summary: 'Test code review plan',
  specs: [
    {
      id: 'spec-1',
      objective: 'Review implementation',
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

const CODE_REVIEW_CONTEXT: CodeReviewContext = {
  diff: 'diff --git a/src/example.ts b/src/example.ts\n',
  diffTruncated: false,
  changedFiles: [
    {
      path: 'src/example.ts',
      included: true,
      truncated: false,
      sizeBytes: 24,
      content: 'export const value = 2\n',
    },
  ],
  totalBytesIncluded: 24,
  truncated: false,
}

describe('OpenAiCodeReviewerProvider', () => {
  beforeEach(() => {
    runOpenAiAgentMock.mockReset()
  })

  it('parses structured output from the shared OpenAI SDK without changing the provider contract', async () => {
    const { OpenAiCodeReviewerProvider } = await import('./openai-code-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 97,
        sageDimensions: [],
        findings: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: ['Ship it'],
        confidence: 'high',
        summary: 'Implementation matches the approved plan.',
        implementationVersion: 3,
      },
      metrics: {
        durationMs: 1456,
        toolCalls: 3,
        tokensUsed: {
          input: 150,
          output: 30,
        },
        costUsd: 0.4,
      },
    })

    const promptComposer = {
      composePrompt: vi.fn().mockResolvedValue('Review this implementation'),
    } as unknown as PromptComposer

    const provider = new OpenAiCodeReviewerProvider(promptComposer)
    const result = await provider.reviewCode({
      jiraKey: 'CPDEV-2',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: 'def5678',
      workspacePath: '/tmp/workspace',
      implementationBranch: 'oneshot/CPDEV-2',
      implementationCommitSha: '1234567',
      implementationVersion: 3,
      plan: PLAN,
      codeReviewContext: CODE_REVIEW_CONTEXT,
    })

    expect(result.review).toMatchObject({
      decision: 'APPROVED',
      score: 97,
      implementationVersion: 3,
      confidence: 'high',
    })
    expect(result.rawOutput).toBe('{"decision":"APPROVED"}')
    expect(result.metrics).toEqual({
      durationMs: 1456,
      toolCalls: 3,
      tokensUsed: {
        input: 150,
        output: 30,
      },
      costUsd: 0.4,
    })
    expect(runOpenAiAgentMock).toHaveBeenCalledTimes(1)
    expect(promptComposer.composePrompt).toHaveBeenCalledWith(
      'code_review',
      expect.objectContaining({
        jiraKey: 'CPDEV-2',
        implementationVersion: '3',
      }),
    )
  })

  it('loads the Sonar code-review extension only for sonar_autofix runs', async () => {
    const { OpenAiCodeReviewerProvider } = await import('./openai-code-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 97,
        sageDimensions: [],
        findings: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        summary: 'Implementation matches the approved plan.',
        implementationVersion: 3,
      },
      metrics: {
        durationMs: 100,
        toolCalls: 1,
      },
    })

    const loadSonarCodeReviewExtension = vi
      .fn()
      .mockResolvedValue('SONAR_CODE_REVIEW_EXTENSION')
    const provider = new OpenAiCodeReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue('Review this implementation'),
      loadSonarCodeReviewExtension,
    } as unknown as PromptComposer)

    await provider.reviewCode({
      jiraKey: 'CPDEV-2',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: 'def5678',
      workspacePath: '/tmp/workspace',
      implementationBranch: 'oneshot/CPDEV-2',
      implementationCommitSha: '1234567',
      implementationVersion: 3,
      plan: PLAN,
      codeReviewContext: CODE_REVIEW_CONTEXT,
      processingMode: 'sonar_autofix',
    })

    expect(loadSonarCodeReviewExtension).toHaveBeenCalledTimes(1)
    expect(runOpenAiAgentMock.mock.calls[0]?.[0].userPrompt).toContain(
      'SONAR_CODE_REVIEW_EXTENSION',
    )
  })

  it('loads the Wiz Code code-review extension only for wiz_code runs', async () => {
    const { OpenAiCodeReviewerProvider } = await import('./openai-code-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 97,
        sageDimensions: [],
        findings: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        summary: 'Implementation matches the approved plan.',
        implementationVersion: 3,
      },
      metrics: {
        durationMs: 100,
        toolCalls: 1,
      },
    })

    const loadSonarCodeReviewExtension = vi
      .fn()
      .mockResolvedValue('SONAR_CODE_REVIEW_EXTENSION')
    const loadWizCodeCodeReviewExtension = vi
      .fn()
      .mockResolvedValue('WIZ_CODE_CODE_REVIEW_EXTENSION')
    const provider = new OpenAiCodeReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue('Review this implementation'),
      loadSonarCodeReviewExtension,
      loadWizCodeCodeReviewExtension,
    } as unknown as PromptComposer)

    await provider.reviewCode({
      jiraKey: 'CPDEV-2',
      repoName: 'core-app',
      branchName: 'master',
      baseCommitSha: 'def5678',
      workspacePath: '/tmp/workspace',
      implementationBranch: 'oneshot/CPDEV-2',
      implementationCommitSha: '1234567',
      implementationVersion: 3,
      plan: PLAN,
      codeReviewContext: CODE_REVIEW_CONTEXT,
      processingMode: 'wiz_code',
    })

    expect(loadWizCodeCodeReviewExtension).toHaveBeenCalledTimes(1)
    expect(loadSonarCodeReviewExtension).not.toHaveBeenCalled()
    expect(runOpenAiAgentMock.mock.calls[0]?.[0].userPrompt).toContain(
      'WIZ_CODE_CODE_REVIEW_EXTENSION',
    )
  })

  it('injects the retrofit workflow fragment for retrofit code review', async () => {
    const { OpenAiCodeReviewerProvider } = await import('./openai-code-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 94,
        sageDimensions: [],
        findings: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        summary: 'Retrofit proof is preserved.',
        implementationVersion: 2,
      },
      metrics: {
        durationMs: 100,
        toolCalls: 1,
      },
    })

    const composePrompt = vi.fn().mockResolvedValue('Review this implementation')
    const loadRetrofitWorkflowPrompt = vi
      .fn()
      .mockResolvedValue('CANONICAL RETROFIT WORKFLOW')
    const provider = new OpenAiCodeReviewerProvider({
      composePrompt,
      loadRetrofitWorkflowPrompt,
    } as unknown as PromptComposer)

    await provider.reviewCode({
      jiraKey: 'CPDEV-650',
      repoName: 'core-app',
      branchName: 'medhok-monorepo-4.0',
      baseCommitSha: 'def5678',
      workspacePath: '/tmp/workspace',
      implementationBranch: 'oneshot/CPDEV-650',
      implementationCommitSha: '1234567',
      implementationVersion: 2,
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
      codeReviewContext: CODE_REVIEW_CONTEXT,
    })

    const variables = composePrompt.mock.calls[0][1]
    expect(loadRetrofitWorkflowPrompt).toHaveBeenCalledTimes(1)
    expect(variables.retrofitWorkflowSection).toContain(
      'CANONICAL RETROFIT WORKFLOW',
    )
    expect(variables.retrofitWorkflowSection).toContain('code_reviewer')
    expect(variables.retrofitWorkflowSection).toContain('9ce5326')
  })

  it('injects the retrofit workflow from qualification source evidence when plan evidence is incomplete', async () => {
    const { OpenAiCodeReviewerProvider } = await import('./openai-code-reviewer.js')

    runOpenAiAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 94,
        sageDimensions: [],
        findings: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        summary: 'Retrofit proof is preserved.',
        implementationVersion: 2,
      },
      metrics: {
        durationMs: 100,
        toolCalls: 1,
      },
    })

    const composePrompt = vi.fn().mockResolvedValue('Review this implementation')
    const loadRetrofitWorkflowPrompt = vi
      .fn()
      .mockResolvedValue('CANONICAL RETROFIT WORKFLOW')
    const provider = new OpenAiCodeReviewerProvider({
      composePrompt,
      loadRetrofitWorkflowPrompt,
    } as unknown as PromptComposer)

    await provider.reviewCode({
      jiraKey: 'CPDEV-650',
      repoName: 'core-app',
      branchName: 'medhok-monorepo-4.0',
      baseCommitSha: 'def5678',
      workspacePath: '/tmp/workspace',
      implementationBranch: 'oneshot/CPDEV-650',
      implementationCommitSha: '1234567',
      implementationVersion: 2,
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
      codeReviewContext: CODE_REVIEW_CONTEXT,
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
