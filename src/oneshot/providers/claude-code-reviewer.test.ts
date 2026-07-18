import * as fs from 'fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptComposer } from '../prompt-composer.js'
import type { OneShotPlan } from '../schema/plan.js'
import type { CodeReviewContext } from '../code-review-context.js'

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

describe('ClaudeCodeReviewerProvider', () => {
  beforeEach(() => {
    runAgentMock.mockReset()
    registerRepoFromPathMock.mockClear()
  })

  it('parses structured code review output and tags the anthropic provider', async () => {
    const { ClaudeCodeReviewerProvider } = await import(
      './claude-code-reviewer.js'
    )

    runAgentMock.mockResolvedValue({
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
        durationMs: 3456,
        toolCalls: 5,
        tokensUsed: {
          input: 250,
          output: 60,
          cacheRead: 0,
          cacheWrite: 0,
        },
        costUsd: 0.8,
      },
    })

    const promptComposer = {
      composePrompt: vi.fn().mockResolvedValue('Review this implementation'),
    } as unknown as PromptComposer

    const provider = new ClaudeCodeReviewerProvider(promptComposer, {
      modelId: 'us.anthropic.claude-opus-4-6-v1',
    })

    expect(provider.providerName).toBe('anthropic')
    expect(provider.modelId).toBe('us.anthropic.claude-opus-4-6-v1')

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
    })
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    const runAgentArgs = runAgentMock.mock.calls[0][0] as {
      bedrockConfig: { model: string }
      allowedTools: string[]
      permissionLevel: string
    }
    expect(runAgentArgs.bedrockConfig.model).toBe(
      'us.anthropic.claude-opus-4-6-v1',
    )
    expect(runAgentArgs.allowedTools).toEqual(['Read', 'Glob', 'Grep'])
    expect(runAgentArgs.permissionLevel).toBe('read_only')
    expect(registerRepoFromPathMock).toHaveBeenCalledWith(
      '/tmp/workspace',
      'oneshot-run-CPDEV-2-code-reviewer',
    )
    expect(promptComposer.composePrompt).toHaveBeenCalledWith(
      'code_review',
      expect.objectContaining({
        jiraKey: 'CPDEV-2',
        implementationVersion: '3',
      }),
    )
  })

  it('rejects prompts that exceed the 600KB guard before calling the SDK', async () => {
    const { ClaudeCodeReviewerProvider } = await import(
      './claude-code-reviewer.js'
    )
    const giantPrompt = 'x'.repeat(700_000)
    const provider = new ClaudeCodeReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue(giantPrompt),
    } as unknown as PromptComposer)

    await expect(
      provider.reviewCode({
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
      }),
    ).rejects.toThrow(/exceeds maximum size/)
    expect(runAgentMock).not.toHaveBeenCalled()
  })

  it('injects the retrofit workflow fragment for retrofit code review', async () => {
    const { ClaudeCodeReviewerProvider } = await import(
      './claude-code-reviewer.js'
    )

    runAgentMock.mockResolvedValue({
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
        summary: 'Retrofit source proof is preserved.',
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
      .mockResolvedValue(
        'CANONICAL RETROFIT WORKFLOW\n- Code Review must validate source-SHA proof and proof regression.',
      )
    const provider = new ClaudeCodeReviewerProvider({
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
    const { ClaudeCodeReviewerProvider } = await import(
      './claude-code-reviewer.js'
    )

    runAgentMock.mockResolvedValue({
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
        summary: 'Retrofit source proof is preserved.',
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
    const provider = new ClaudeCodeReviewerProvider({
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

  it('does not fall back to raw output when structured output is null', async () => {
    const { ClaudeCodeReviewerProvider } = await import(
      './claude-code-reviewer.js'
    )

    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify({
        decision: 'APPROVED',
        score: 97,
        sageDimensions: [],
        findings: [],
        blockingFindings: [],
        requiredChanges: [],
        nonBlockingSuggestions: [],
        confidence: 'high',
        summary: 'Raw fallback should not be used.',
        implementationVersion: 3,
      }),
      structuredOutput: null,
      metrics: {
        durationMs: 100,
        toolCalls: 0,
      },
    })

    const provider = new ClaudeCodeReviewerProvider({
      composePrompt: vi.fn().mockResolvedValue('Review this implementation'),
    } as unknown as PromptComposer)

    await expect(
      provider.reviewCode({
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
      }),
    ).rejects.toThrow()
  })

  it('loads the Sonar code-review extension only for sonar_autofix runs', async () => {
    const { ClaudeCodeReviewerProvider } = await import(
      './claude-code-reviewer.js'
    )

    runAgentMock.mockResolvedValue({
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
    const provider = new ClaudeCodeReviewerProvider({
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
    expect(runAgentMock.mock.calls[0]?.[0].taskPrompt).toContain(
      'SONAR_CODE_REVIEW_EXTENSION',
    )
  })

  it('documents the required retrofit workflow slot in the code review prompt asset', async () => {
    const promptAsset = await fs.readFile(
      new URL('../../../oneshot-prompts/prompts/review-code.md', import.meta.url),
      'utf8',
    )

    expect(promptAsset).toContain('{{retrofitWorkflowSection}}')
    expect(promptAsset.indexOf('{{retrofitWorkflowSection}}')).toBeLessThan(
      promptAsset.indexOf('## Approved Plan JSON'),
    )
  })
})
