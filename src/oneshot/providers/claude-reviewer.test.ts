import * as fs from 'fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptComposer } from '../prompt-composer.js'
import type { OneShotPlan } from '../schema/plan.js'
import type { ReviewContext } from '../review-context.js'

const { runAgentMock, registerRepoFromPathMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  registerRepoFromPathMock: vi.fn(() => 'workspace'),
}))

vi.mock('../claude-sdk.js', async () => {
  const actual = await vi.importActual<
    typeof import('../claude-sdk.js')
  >('../claude-sdk.js')

  return {
    ...actual,
    runAgent: runAgentMock,
    registerRepoFromPath: registerRepoFromPathMock,
  }
})

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

describe('ClaudeReviewerProvider', () => {
  beforeEach(() => {
    runAgentMock.mockReset()
    registerRepoFromPathMock.mockClear()
  })

  it('parses structured output from the Claude SDK and reports anthropic as the provider', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')

    runAgentMock.mockResolvedValue({
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
        durationMs: 2345,
        toolCalls: 3,
        tokensUsed: {
          input: 100,
          output: 20,
          cacheRead: 50,
          cacheWrite: 0,
        },
        costUsd: 0.5,
      },
    })

    const promptComposer = {
      composePrompt: vi.fn().mockResolvedValue('Review this plan'),
    } as unknown as PromptComposer

    const provider = new ClaudeReviewerProvider(promptComposer, {
      modelId: 'us.anthropic.claude-opus-4-6-v1',
    })

    expect(provider.providerName).toBe('anthropic')
    expect(provider.modelId).toBe('us.anthropic.claude-opus-4-6-v1')

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
    expect(result.metrics.tokensUsed).toMatchObject({
      input: 100,
      output: 20,
      cacheRead: 50,
    })
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    const runAgentArgs = runAgentMock.mock.calls[0][0] as {
      bedrockConfig: { model: string }
      allowedTools: string[]
      permissionLevel: string
    }
    expect(runAgentArgs.bedrockConfig.model).toBe('us.anthropic.claude-opus-4-6-v1')
    expect(runAgentArgs.allowedTools).toEqual(['Read', 'Glob', 'Grep'])
    expect(runAgentArgs.permissionLevel).toBe('read_only')
    expect(registerRepoFromPathMock).toHaveBeenCalledWith(
      '/tmp/workspace',
      'oneshot-run-CPDEV-1-reviewer',
    )
    expect(promptComposer.composePrompt).toHaveBeenCalledWith(
      'review',
      expect.objectContaining({ jiraKey: 'CPDEV-1', repoName: 'core-app' }),
    )
  })

  it('uses the default Opus 4.6 model id when none is supplied', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')
    const provider = new ClaudeReviewerProvider({
      composePrompt: vi.fn(),
    } as unknown as PromptComposer)
    expect(provider.modelId).toBe('us.anthropic.claude-opus-4-6-v1')
  })

  it('injects the retrofit workflow fragment for retrofit plan validation', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')

    runAgentMock.mockResolvedValue({
      success: true,
      output: '{"decision":"APPROVED"}',
      structuredOutput: {
        decision: 'APPROVED',
        score: 90,
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
      .mockResolvedValue(
        'CANONICAL RETROFIT WORKFLOW\n- Validate must reject missing selected source SHA proof.',
      )
    const provider = new ClaudeReviewerProvider({
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
        jiraKey: 'CPDEV-650',
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
    expect(variables.retrofitWorkflowSection).toContain('reviewer')
    expect(variables.retrofitWorkflowSection).not.toBe('')
  })

  it('injects the retrofit workflow from qualification source evidence when the draft plan omitted retrofit evidence', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')

    runAgentMock.mockResolvedValue({
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
    const provider = new ClaudeReviewerProvider({
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

  it('does not fall back to raw output when structured output is null', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        decision: 'APPROVED',
        score: 92,
        sageDimensions: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        coverageAssessment: 'Raw fallback should not be used.',
      }),
      structuredOutput: null,
      metrics: {
        durationMs: 100,
        toolCalls: 0,
      },
    })

    const provider = new ClaudeReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue('Review this plan'),
    } as unknown as PromptComposer)

    await expect(
      provider.reviewPlan({
        jiraKey: 'CPDEV-1',
        repoName: 'core-app',
        branchName: 'master',
        baseCommitSha: 'abc1234',
        workspacePath: '/tmp/workspace',
        plan: PLAN,
        reviewContext: REVIEW_CONTEXT,
      }),
    ).rejects.toThrow()
  })

  it('throws when the SDK reports failure without an error message', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')
    runAgentMock.mockResolvedValue({ success: false })

    const provider = new ClaudeReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    await expect(
      provider.reviewPlan({
        jiraKey: 'CPDEV-1',
        repoName: 'core-app',
        branchName: 'master',
        baseCommitSha: 'abc1234',
        workspacePath: '/tmp/workspace',
        plan: PLAN,
        reviewContext: REVIEW_CONTEXT,
      }),
    ).rejects.toThrow(/Claude reviewer failed without an explicit error/)
  })

  it('loads only the Sonar review extension from processingMode', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')

    runAgentMock.mockResolvedValue({
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
        durationMs: 100,
        toolCalls: 1,
      },
    })

    const loadSecurityReviewExtension = vi.fn().mockResolvedValue('SECURITY_EXTENSION')
    const loadSonarReviewExtension = vi.fn().mockResolvedValue('SONAR_EXTENSION')
    const provider = new ClaudeReviewerProvider({
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
      processingMode: 'sonar_autofix',
      jiraLabels: ['SONAR-AUTOFIX', 'security'],
    })

    expect(loadSonarReviewExtension).toHaveBeenCalledTimes(1)
    expect(loadSecurityReviewExtension).not.toHaveBeenCalled()
    expect(runAgentMock.mock.calls[0]?.[0].taskPrompt).toContain('SONAR_EXTENSION')
    expect(runAgentMock.mock.calls[0]?.[0].taskPrompt).not.toContain(
      'SECURITY_EXTENSION',
    )
  })

  it('rejects prompts that exceed the 400KB guard before calling the SDK', async () => {
    const { ClaudeReviewerProvider } = await import('./claude-reviewer.js')
    const giantPrompt = 'x'.repeat(500_000)
    const provider = new ClaudeReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue(giantPrompt),
    } as unknown as PromptComposer)

    await expect(
      provider.reviewPlan({
        jiraKey: 'CPDEV-1',
        repoName: 'core-app',
        branchName: 'master',
        baseCommitSha: 'abc1234',
        workspacePath: '/tmp/workspace',
        plan: PLAN,
        reviewContext: REVIEW_CONTEXT,
      }),
    ).rejects.toThrow(/exceeds maximum size/)
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('documents mandatory plan contract and guardrail enforcement in the review prompt asset', async () => {
    const promptAsset = await fs.readFile(
      new URL('../../../oneshot-prompts/prompts/review-plan.md', import.meta.url),
      'utf8',
    )

    expect(promptAsset).toContain('guardrailReport')
    expect(promptAsset).toContain('fileChangeContract')
    expect(promptAsset).toContain('plannedCodeChanges')
    expect(promptAsset).toContain('testingStrategy')
    expect(promptAsset).toContain('plannedAutomatedTests')
    expect(promptAsset).toContain('testing-adequacy')
    expect(promptAsset).toContain('implementerGuardrails')
    expect(promptAsset).toContain('Block critical/high guardrail failures')
    expect(promptAsset).toContain('PFOS label alone is not evidence')
    expect(promptAsset).toContain('{{retrofitWorkflowSection}}')
  })
})
