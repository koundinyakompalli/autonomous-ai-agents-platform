import * as fs from 'fs/promises'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptComposer } from '../prompt-composer.js'
import type { OneShotCodeReview } from '../schema/code-review.js'
import type { OneShotPlan } from '../schema/plan.js'
import { buildOneShotTraceArtifact } from '../schema/trace-verify.js'
import {
  ClaudeImplementerProvider,
  ImplementerStallError,
} from './claude-implementer.js'

const { runAgentMock, registerRepoFromPathMock } = vi.hoisted(() => ({
  runAgentMock: vi.fn(),
  registerRepoFromPathMock: vi.fn(),
}))

vi.mock('../claude-sdk.js', async () => {
  const actual = await vi.importActual<typeof import('../claude-sdk.js')>(
    '../claude-sdk.js',
  )

  return {
    ...actual,
    runAgent: runAgentMock,
    registerRepoFromPath: registerRepoFromPathMock,
  }
})

const plan: OneShotPlan = {
  jiraKey: 'CPDEV-20686',
  repoName: 'core-app',
  branchName: 'master',
  baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
  summary: 'Implement the approved PFOS change.',
  specs: [
    {
      id: 'spec-1',
      objective: 'Add the implementer fallback.',
      acceptanceCriteria: ['Implementer returns a valid structured payload.'],
      targetFiles: ['src/oneshot/providers/claude-implementer.ts'],
      implementationNotes: ['Use schema-aware JSON scanning.'],
      validationSteps: ['pnpm vitest src/oneshot/providers/claude-implementer.test.ts'],
    },
  ],
  assumptions: [],
  openQuestions: [],
  outOfScope: [],
  risks: [],
}

function buildStructuredOutput() {
  return {
    summary: 'Implemented the planner parsing fix.',
    completedSpecIds: ['spec-1'],
    implementedTraceTestIds: ['CPDEV-20686-TRACE-C-001'],
    changedFiles: ['src/oneshot/providers/claude-planner.ts'],
    testCommands: ['npm test -- src/oneshot/providers/claude-planner.test.ts'],
    validationCommands: [],
    validationChecks: [],
    manualVerificationSteps: [],
    testResults: [
      {
        command: 'npm test -- src/oneshot/providers/claude-planner.test.ts',
        status: 'passed' as const,
        summary: 'Planner provider tests passed.',
      },
    ],
    deviationsFromPlan: [],
    residualRisks: [],
    openFollowUps: [],
    sessionNotes: 'Provider session notes.',
  }
}

function buildAgentResult(overrides: Record<string, unknown> = {}) {
  return {
    success: true,
    output: JSON.stringify(buildStructuredOutput()),
    structuredOutput: buildStructuredOutput(),
    sessionId: 'session-new',
    metrics: {
      durationMs: 1_000,
      toolCalls: 2,
      tokensUsed: {
        input: 10,
        output: 20,
      },
      costUsd: 0.01,
      modelUsed: 'us.anthropic.claude-sonnet-test-v1:0',
    },
    ...overrides,
  }
}

function buildCodeReview(
  overrides: Partial<OneShotCodeReview> = {},
): OneShotCodeReview {
  return {
    decision: 'NEEDS_CHANGES',
    score: 60,
    sageDimensions: [],
    findings: [],
    blockingFindings: [],
    requiredChanges: ['Fix the missing null guard.'],
    nonBlockingSuggestions: [],
    confidence: 'high',
    summary: 'Implementation needs one correction.',
    implementationVersion: 1,
    ...overrides,
  }
}

function buildRequest(overrides: Partial<Parameters<ClaudeImplementerProvider['implementPlan']>[0]> = {}) {
  return {
    jiraKey: 'CPDEV-20686',
    repoName: 'core-app',
    branchName: 'master',
    baseCommitSha: '0123456789abcdef0123456789abcdef01234567',
    implementationBranch: 'oneshot/cpdev-20686-run-1',
    workspacePath: '/tmp/workspace',
    ticketSummary: 'Fix OneShot planner parsing',
    plan,
    ...overrides,
  }
}

describe('ClaudeImplementerProvider', () => {
  beforeEach(() => {
    runAgentMock.mockReset()
    registerRepoFromPathMock.mockReset()
    registerRepoFromPathMock.mockReturnValue('workspace')
  })

  it('falls back to a later valid JSON candidate when structured output is invalid', async () => {
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    runAgentMock.mockResolvedValue({
      success: true,
      output: `Scratch output:

{"summary":"missing implementation fields"}

Final answer:
\`\`\`json
{
  "summary": "Implemented the planner parsing fix.",
  "completedSpecIds": ["spec-1"],
  "implementedTraceTestIds": ["CPDEV-20686-TRACE-C-001"],
  "changedFiles": ["src/oneshot/providers/claude-planner.ts"],
  "testCommands": ["npm test -- src/oneshot/providers/claude-planner.test.ts"],
  "validationCommands": [],
  "manualVerificationSteps": [],
  "testResults": [
    {
      "command": "npm test -- src/oneshot/providers/claude-planner.test.ts",
      "status": "passed",
      "summary": "Planner provider tests passed."
    }
  ],
  "deviationsFromPlan": [],
  "residualRisks": [],
  "openFollowUps": []
}
\`\`\``,
      structuredOutput: {
        summary: 'missing implementation fields',
      },
      metrics: {
        durationMs: 123,
        toolCalls: 0,
      },
    })

    const response = await provider.implementPlan(buildRequest())

    expect(registerRepoFromPathMock).toHaveBeenCalledWith(
      '/tmp/workspace',
      'oneshot-run-CPDEV-20686-implementer',
    )
    expect(response.implementation).toMatchObject({
      summary: 'Implemented the planner parsing fix.',
      completedSpecIds: ['spec-1'],
      changedFiles: ['src/oneshot/providers/claude-planner.ts'],
    })
  })

  it('enables Claude-stage streaming observability when invoking runAgent', async () => {
    const provider = new ClaudeImplementerProvider(
      {
        composePrompt: vi.fn().mockResolvedValue('prompt'),
      } as unknown as PromptComposer,
      { maxOutputTokens: 100_000 },
    )

    runAgentMock.mockResolvedValue(buildAgentResult())

    await provider.implementPlan(buildRequest())

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        includePartialMessages: true,
        idleTimeoutMs: 300_000,
        toolIdleTimeoutMs: 1_800_000,
        compactionGraceMs: 120_000,
        bedrockConfig: {
          model: "us.anthropic.claude-sonnet-5",
          maxOutputTokens: 100_000,
        },
      }),
    )
  })

  it('loads the Sonar implementation extension only for sonar_autofix runs', async () => {
    const loadSonarImplementationExtension = vi
      .fn()
      .mockResolvedValue('SONAR_IMPLEMENTATION_EXTENSION')
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('Implement this plan'),
      loadSonarImplementationExtension,
    } as unknown as PromptComposer)

    runAgentMock.mockResolvedValue(buildAgentResult())

    await provider.implementPlan(
      buildRequest({ processingMode: 'sonar_autofix' }),
    )

    expect(loadSonarImplementationExtension).toHaveBeenCalledTimes(1)
    expect(runAgentMock.mock.calls[0]?.[0].taskPrompt).toContain(
      'SONAR_IMPLEMENTATION_EXTENSION',
    )
  })

  it('passes TRACE Section C specs into the implementer prompt context', async () => {
    const composePrompt = vi.fn().mockResolvedValue('prompt')
    const provider = new ClaudeImplementerProvider({
      composePrompt,
    } as unknown as PromptComposer)
    runAgentMock.mockResolvedValue(buildAgentResult())

    const trace = buildOneShotTraceArtifact({
      jiraKey: 'CPDEV-20686',
      planVersion: 1,
      plan,
      generatedAt: '2026-05-28T12:00:00.000Z',
    })
    await provider.implementPlan(buildRequest({ trace }))

    const variables = composePrompt.mock.calls[0][1]
    expect(JSON.parse(variables.traceSectionCJson)).toMatchObject({
      sectionCUnitTestSpecs: [
        expect.objectContaining({
          id: 'CPDEV-20686-TRACE-C-001',
          section: 'C',
        }),
      ],
      acceptanceCriteriaCoverage: expect.objectContaining({
        coveragePercent: 100,
      }),
    })
  })

  it('passes a scratch Maven repository to Claude SDK command execution', async () => {
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)
    const priorMavenOpts = process.env.MAVEN_OPTS
    process.env.MAVEN_OPTS = '-Dmaven.repo.local=.m2/repository -Dkeep=true'

    try {
      runAgentMock.mockResolvedValue(buildAgentResult())

      await provider.implementPlan(buildRequest())

      const agentOptions = runAgentMock.mock.calls[0]?.[0]
      expect(agentOptions?.env?.MAVEN_OPTS).toContain('/implementer/.m2/repository')
      expect(agentOptions?.env?.MAVEN_OPTS).toContain('-Dkeep=true')
      expect(agentOptions?.env?.MAVEN_OPTS).not.toContain(
        '-Dmaven.repo.local=.m2/repository',
      )
    } finally {
      process.env.MAVEN_OPTS = priorMavenOpts
    }
  })

  it('instructs Claude not to run or declare Maven commands when Maven builds are disabled', async () => {
    const composePrompt = vi.fn().mockResolvedValue('prompt')
    const provider = new ClaudeImplementerProvider(
      { composePrompt } as unknown as PromptComposer,
      { mavenBuildsEnabled: false },
    )

    runAgentMock.mockResolvedValue(buildAgentResult())

    await provider.implementPlan(buildRequest())

    expect(composePrompt).toHaveBeenCalledWith(
      'implementation',
      expect.objectContaining({
        mavenBuildsInstruction: expect.stringContaining(
          'Maven builds and Maven test commands are disabled',
        ),
      }),
    )
    const agentOptions = runAgentMock.mock.calls[0]?.[0]
    expect(agentOptions?.env?.ONESHOT_MAVEN_BUILDS_ENABLED).toBe('false')
  })

  it('passes the configured stage-level implementer model to Claude SDK', async () => {
    const provider = new ClaudeImplementerProvider(
      {
        composePrompt: vi.fn().mockResolvedValue('prompt'),
      } as unknown as PromptComposer,
      { modelId: 'us.anthropic.claude-sonnet-5' },
    )

    runAgentMock.mockResolvedValue(buildAgentResult())

    await provider.implementPlan(buildRequest())

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sdkStage: 'implementation',
        bedrockConfig: expect.objectContaining({
          model: 'us.anthropic.claude-sonnet-5',
        }),
      }),
    )
  })

  it('preserves runner failure classification via ImplementerStallError', async () => {
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    runAgentMock.mockResolvedValue({
      success: false,
      error: 'SDK_IDLE_TIMEOUT: no stream event for 300000ms, toolCalls=1, output=0',
      failureKind: 'idle_timeout',
      metrics: {
        durationMs: 123,
        toolCalls: 1,
      },
    })

    await expect(
      provider.implementPlan(buildRequest()),
    ).rejects.toEqual(
      expect.objectContaining<Partial<ImplementerStallError>>({
        name: 'ImplementerStallError',
        failureKind: 'idle_timeout',
        message:
          'SDK_IDLE_TIMEOUT: no stream event for 300000ms, toolCalls=1, output=0',
      }),
    )
  })

  it('keeps the shared Claude config dir while omitting resume options for a fresh implementation pass', async () => {
    runAgentMock.mockResolvedValueOnce(buildAgentResult())
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    const response = await provider.implementPlan(buildRequest({
      claudeConfigDir: '/tmp/workspaces/claude-sessions',
    }))

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(runAgentMock.mock.calls[0][0].resumeSessionId).toBeUndefined()
    expect(runAgentMock.mock.calls[0][0].forkSessionOnResume).toBeUndefined()
    expect(runAgentMock.mock.calls[0][0].claudeConfigDir).toBe('/tmp/workspaces/claude-sessions')
    expect(response.resumeMode).toBe('fresh')
    expect(response.resumeAttempted).toBe(false)
    expect(response.resumeSucceeded).toBe(false)
    expect(response.sessionId).toBe('session-new')
  })

  it('passes prior session ID with fork mode for revision implementation', async () => {
    runAgentMock.mockResolvedValueOnce(buildAgentResult({
      sessionId: 'session-forked',
    }))
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    const response = await provider.implementPlan(buildRequest({
      revisionContext: {
        previousProviderSessionId: 'session-previous',
      },
      resumeSessionId: 'session-previous',
      forkSessionOnResume: true,
      claudeConfigDir: '/tmp/workspaces/claude-sessions',
    }))

    expect(runAgentMock).toHaveBeenCalledTimes(1)
    expect(runAgentMock.mock.calls[0][0]).toMatchObject({
      resumeSessionId: 'session-previous',
      forkSessionOnResume: true,
      claudeConfigDir: '/tmp/workspaces/claude-sessions',
    })
    expect(response.sessionId).toBe('session-forked')
    expect(response.resumedFromSessionId).toBe('session-previous')
    expect(response.resumeMode).toBe('fork_resume')
    expect(response.resumeAttempted).toBe(true)
    expect(response.resumeSucceeded).toBe(true)
  })

  it('falls back to exactly one fresh attempt when Claude cannot load the resumed session', async () => {
    runAgentMock
      .mockResolvedValueOnce(buildAgentResult({
        success: false,
        output: '',
        structuredOutput: undefined,
        error: 'Could not resume session: session not found',
        sessionId: undefined,
        metrics: {
          durationMs: 250,
          toolCalls: 0,
        },
      }))
      .mockResolvedValueOnce(buildAgentResult({
        sessionId: 'session-fresh-fallback',
      }))
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    const response = await provider.implementPlan(buildRequest({
      revisionContext: {
        previousProviderSessionId: 'session-previous',
      },
      resumeSessionId: 'session-previous',
      forkSessionOnResume: true,
      claudeConfigDir: '/tmp/workspaces/claude-sessions',
    }))

    expect(runAgentMock).toHaveBeenCalledTimes(2)
    expect(runAgentMock.mock.calls[0][0].resumeSessionId).toBe('session-previous')
    expect(runAgentMock.mock.calls[1][0].resumeSessionId).toBeUndefined()
    expect(runAgentMock.mock.calls[1][0].forkSessionOnResume).toBeUndefined()
    expect(runAgentMock.mock.calls[1][0].claudeConfigDir).toBe('/tmp/workspaces/claude-sessions')
    expect(response.sessionId).toBe('session-fresh-fallback')
    expect(response.resumedFromSessionId).toBe('session-previous')
    expect(response.resumeMode).toBe('fork_resume_fallback_fresh')
    expect(response.resumeAttempted).toBe(true)
    expect(response.resumeSucceeded).toBe(false)
  })

  it('tells revision implementers to edit files or explicitly disagree with code review', async () => {
    runAgentMock.mockResolvedValueOnce(buildAgentResult())
    const composePrompt = vi.fn().mockResolvedValue('prompt')
    const provider = new ClaudeImplementerProvider({
      composePrompt,
    } as unknown as PromptComposer)

    await provider.implementPlan(buildRequest({
      revisionContext: {
        codeReviewFindings: buildCodeReview(),
        previousProviderSessionId: 'session-previous',
      },
      resumeSessionId: 'session-previous',
      forkSessionOnResume: true,
    }))

    expect(composePrompt).toHaveBeenCalledWith(
      'implementation',
      expect.objectContaining({
        revisionSection: expect.stringContaining(
          'You must either edit files or set implementerDisagrees=true',
        ),
      }),
    )
    expect(composePrompt.mock.calls[0][1].revisionSection).toContain(
      'non-empty implementerDisagreementReason',
    )
  })

  it('passes PRISM-style plan contracts, code sketches, and guardrails into the implementer prompt', async () => {
    runAgentMock.mockResolvedValueOnce(buildAgentResult())
    const composePrompt = vi.fn().mockResolvedValue('prompt')
    const provider = new ClaudeImplementerProvider({
      composePrompt,
    } as unknown as PromptComposer)

    await provider.implementPlan(
      buildRequest({
        plan: {
          ...plan,
          fileChangeContract: [
            {
              path: 'src/oneshot/providers/claude-implementer.ts',
              role: 'runtime_required',
              editable: true,
              rationale: 'Implementer provider owns the prompt handoff.',
              supportingEvidence: ['Read claude-implementer.ts.'],
              allowedChanges: ['Add prompt contract language.'],
            },
          ],
          plannedCodeChanges: [
            {
              targetFile: 'src/oneshot/providers/claude-implementer.ts',
              symbolOrRegion: 'build prompt variables',
              changeType: 'update',
              afterSketch: 'Pass full plan JSON including fileChangeContract.',
              rationale: 'Implementer needs the planner contract.',
              supportingEvidence: ['Existing planJson prompt variable.'],
              confidence: 'high',
            },
          ],
          guardrailReport: {
            coreChecks: [
              {
                id: 'scope-discipline',
                severity: 'high',
                status: 'passed',
                applicabilityReason: 'Core guardrail applies to every run.',
                evidence: ['fileChangeContract is present.'],
                requiredAction: 'Stay inside editable files.',
              },
            ],
            domainChecks: [],
            implementerChecks: [
              {
                id: 'editable-file-contract',
                severity: 'high',
                status: 'passed',
                applicabilityReason: 'Editable files are explicit.',
                evidence: ['Contract names claude-implementer.ts.'],
                requiredAction: 'Only edit editable files.',
              },
            ],
          },
          testingStrategy: {
            mode: 'test_first',
            existingTestEvidence: [
              {
                id: 'implementer-provider-test-surface',
                kind: 'test_file',
                path: 'src/oneshot/providers/claude-implementer.test.ts',
                summary: 'Provider test covers prompt handoff.',
                supportingEvidence: ['Read claude-implementer.test.ts.'],
              },
            ],
            plannedAutomatedTests: [
              {
                id: 'AUTO-SPEC-1',
                testFile: 'src/oneshot/providers/claude-implementer.test.ts',
                relatedSpecIds: ['SPEC-1'],
                testType: 'unit',
                scenario: 'Implementer prompt includes the planner testing contract.',
                assertions: ['planJson contains testingStrategy.'],
                failFirst: true,
                command: 'npm test -- src/oneshot/providers/claude-implementer.test.ts',
                syntheticDataNotes: 'Use synthetic request fixtures only.',
              },
            ],
            validationCommands: [
              {
                command: 'npm test -- src/oneshot/providers/claude-implementer.test.ts',
                expectedResult: 'Focused implementer provider tests pass.',
                scope: 'focused',
                relatedSpecIds: ['SPEC-1'],
              },
            ],
            manualChecks: [],
            traceGuidance: [
              {
                id: 'TRACE-IMPLEMENTER-HANDOFF',
                section: 'C',
                testType: 'Unit',
                scenario: 'TRACE should preserve planned test handoff.',
                relatedSpecIds: ['SPEC-1'],
                priority: 'High',
              },
            ],
            coverageGaps: [],
          },
          implementerGuardrails: [
            {
              id: 'implementation-file-scope',
              instruction: 'Return a deviation instead of editing unlisted files.',
              appliesToFiles: ['src/oneshot/providers/claude-implementer.ts'],
              required: true,
            },
          ],
        },
      }),
    )

    const planJson = composePrompt.mock.calls[0][1].planJson
    expect(planJson).toContain('"fileChangeContract"')
    expect(planJson).toContain('"plannedCodeChanges"')
    expect(planJson).toContain('"guardrailReport"')
    expect(planJson).toContain('"testingStrategy"')
    expect(planJson).toContain('"plannedAutomatedTests"')
    expect(planJson).toContain('"AUTO-SPEC-1"')
    expect(planJson).toContain('"implementerGuardrails"')
  })

  it('falls back when resume fails before Claude starts work even if SDK error wording changes', async () => {
    runAgentMock
      .mockResolvedValueOnce(buildAgentResult({
        success: false,
        output: '',
        structuredOutput: undefined,
        error: 'Anthropic API returned 404 for conversation history lookup',
        sessionId: undefined,
        failureKind: 'other',
        metrics: {
          durationMs: 250,
          toolCalls: 0,
        },
      }))
      .mockResolvedValueOnce(buildAgentResult({
        sessionId: 'session-fresh-fallback',
      }))
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    const response = await provider.implementPlan(buildRequest({
      revisionContext: {
        previousProviderSessionId: 'session-previous',
      },
      resumeSessionId: 'session-previous',
      forkSessionOnResume: true,
      claudeConfigDir: '/tmp/workspaces/claude-sessions/run-84',
    }))

    expect(runAgentMock).toHaveBeenCalledTimes(2)
    expect(runAgentMock.mock.calls[0][0].resumeSessionId).toBe('session-previous')
    expect(runAgentMock.mock.calls[1][0].resumeSessionId).toBeUndefined()
    expect(runAgentMock.mock.calls[1][0].claudeConfigDir).toBe('/tmp/workspaces/claude-sessions/run-84')
    expect(response.sessionId).toBe('session-fresh-fallback')
    expect(response.resumeMode).toBe('fork_resume_fallback_fresh')
    expect(response.resumeAttempted).toBe(true)
    expect(response.resumeSucceeded).toBe(false)
  })

  it('does not fresh-retry arbitrary implementer failures', async () => {
    runAgentMock.mockResolvedValueOnce(buildAgentResult({
      success: false,
      output: '',
      structuredOutput: undefined,
      error: 'Bash command failed after editing files',
    }))
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    await expect(provider.implementPlan(buildRequest({
      revisionContext: {
        previousProviderSessionId: 'session-previous',
      },
      resumeSessionId: 'session-previous',
      forkSessionOnResume: true,
      claudeConfigDir: '/tmp/workspaces/claude-sessions',
    }))).rejects.toBeInstanceOf(ImplementerStallError)

    expect(runAgentMock).toHaveBeenCalledTimes(1)
  })

  it('does not fresh-retry resume-labeled failures after Claude has started work', async () => {
    runAgentMock.mockResolvedValueOnce(buildAgentResult({
      success: false,
      output: 'Partial implementation notes',
      structuredOutput: undefined,
      error: 'failed to resume after tool execution reached a bad state',
      sessionId: 'session-started',
      metrics: {
        durationMs: 250,
        toolCalls: 1,
      },
    }))
    const provider = new ClaudeImplementerProvider({
      composePrompt: vi.fn().mockResolvedValue('prompt'),
    } as unknown as PromptComposer)

    await expect(provider.implementPlan(buildRequest({
      revisionContext: {
        previousProviderSessionId: 'session-previous',
      },
      resumeSessionId: 'session-previous',
      forkSessionOnResume: true,
      claudeConfigDir: '/tmp/workspaces/claude-sessions',
    }))).rejects.toBeInstanceOf(ImplementerStallError)

    expect(runAgentMock).toHaveBeenCalledTimes(1)
  })

  it('documents the one-command-per-entry validation contract in the prompt asset', async () => {
    const promptAsset = await fs.readFile(
      new URL('../../../oneshot-prompts/prompts/build.md', import.meta.url),
      'utf8',
    )

    expect(promptAsset).toContain('Structural assertions (grep/rg-style "must match" / "must not match") MUST go in `validationChecks`, not in `validationCommands`.')
    expect(promptAsset).toContain('"scope"?: "file" | "changed_lines"')
    expect(promptAsset).toContain('Use whole-file `must_not_match` only when the approved plan explicitly requires the pattern to be absent from the entire file.')
    expect(promptAsset).toContain('For removals/refactors, prefer `scope: "changed_lines"` on negative structural checks')
    expect(promptAsset).toContain('Put exactly one command invocation in each `testCommands` entry.')
    expect(promptAsset).toContain('Do not use shell chaining, pipes, redirects, command substitution, or env-prefixes in `testCommands`.')
    expect(promptAsset).toContain('Bad: `testCommands = ["grep foo file && grep bar file"]`')
    expect(promptAsset).toContain('Bad: broad `must_not_match` for a common API unless the plan says every call in the file is invalid.')
    expect(promptAsset).toContain('fileChangeContract')
    expect(promptAsset).toContain('plannedCodeChanges')
    expect(promptAsset).toContain('testingStrategy')
    expect(promptAsset).toContain('plannedAutomatedTests')
    expect(promptAsset).toContain('failFirst')
    expect(promptAsset).toContain('implementerGuardrails')
    expect(promptAsset.toLowerCase()).toContain(
      'return a structured deviation instead of silently editing it',
    )
  })

  it('documents generated/cache candidate-diff exclusions in build prompts and guardrails', async () => {
    const [promptAsset, guardrailAsset] = await Promise.all([
      fs.readFile(
        new URL('../../../oneshot-prompts/prompts/build.md', import.meta.url),
        'utf8',
      ),
      fs.readFile(
        new URL(
          '../../../oneshot-prompts/guardrails/build-guardrails.md',
          import.meta.url,
        ),
        'utf8',
      ),
    ])

    expect(promptAsset).toContain(
      'Keep generated/cache/build outputs out of the candidate diff.',
    )
    expect(guardrailAsset).toContain('Generated/Cache Artifact Exclusion')
    expect(guardrailAsset).toContain('forbidden candidate-diff paths')
    expect(guardrailAsset).toContain('**/.m2/repository/**')
    expect(guardrailAsset).toContain(
      'Maven local repository output is disposable scratch data',
    )
    expect(guardrailAsset).toContain('.m2/settings.xml')
  })

  it('documents required retrofit workflow slots in the implementation prompt asset', async () => {
    const promptAsset = await fs.readFile(
      new URL('../../../oneshot-prompts/prompts/build.md', import.meta.url),
      'utf8',
    )

    expect(promptAsset).toContain('{{retrofitWorkflowSection}}')
    expect(promptAsset).toContain('{{retrofitAdaptationSection}}')
    expect(promptAsset.indexOf('{{retrofitWorkflowSection}}')).toBeLessThan(
      promptAsset.indexOf('## Implementation Methodology'),
    )
    expect(promptAsset.indexOf('{{retrofitAdaptationSection}}')).toBeLessThan(
      promptAsset.indexOf('## Implementation Methodology'),
    )
  })

  it('includes the retrofit workflow fragment and adaptation facts when retrofitAdaptationContext is set', async () => {
    const composePrompt = vi.fn().mockResolvedValue('prompt')
    const loadRetrofitWorkflowPrompt = vi
      .fn()
      .mockResolvedValue(
        'CANONICAL RETROFIT WORKFLOW\n- Every selected source SHA needs accepted proof.',
      )
    const provider = new ClaudeImplementerProvider({
      composePrompt,
      loadRetrofitWorkflowPrompt,
    } as unknown as PromptComposer)
    runAgentMock.mockResolvedValue(buildAgentResult())

    await provider.implementPlan(
      buildRequest({
        retrofitAdaptationContext: {
          sourcePatch: 'diff --git a/src/File.ts b/src/File.ts\n+new line',
          conflictDiagnostics: 'patch does not apply: context mismatch',
          allowedFiles: ['src/File.ts'],
          sourceShas: ['abc1234'],
        },
      }),
    )

    const variables = composePrompt.mock.calls[0][1]
    expect(loadRetrofitWorkflowPrompt).toHaveBeenCalledTimes(1)
    expect(variables.retrofitWorkflowSection).toContain(
      'CANONICAL RETROFIT WORKFLOW',
    )
    expect(variables.retrofitWorkflowSection).toContain('abc1234')
    expect(variables.retrofitAdaptationSection).toContain('RETROFIT ADAPTATION MODE')
    expect(variables.retrofitAdaptationSection).toContain('src/File.ts')
    expect(variables.retrofitAdaptationSection).toContain('abc1234')
    expect(variables.retrofitAdaptationSection).toContain('context mismatch')
    expect(variables.retrofitAdaptationSection).toContain('+new line')
  })

  it('includes prior retrofit proof and workflow fragment in revision prompts', async () => {
    const composePrompt = vi.fn().mockResolvedValue('prompt')
    const loadRetrofitWorkflowPrompt = vi
      .fn()
      .mockResolvedValue(
        'CANONICAL RETROFIT WORKFLOW\n- Implementation revisions must preserve prior accepted retrofit proof and must not re-run source patch application.',
      )
    const provider = new ClaudeImplementerProvider({
      composePrompt,
      loadRetrofitWorkflowPrompt,
    } as unknown as PromptComposer)
    runAgentMock.mockResolvedValue(buildAgentResult())

    await provider.implementPlan(
      buildRequest({
        revisionContext: {
          previousImplementationVersion: 1,
          previousProviderSessionId: 'session-previous',
          priorRetrofitSourceCommitStatuses: [
            {
              sourceSha: '9ce5326',
              status: 'adapted',
              sourceFiles: ['src/UIComponentService.java'],
              targetFiles: ['src/UIComponentService.java'],
              adaptationFiles: ['src/BaseUtils.java'],
              proofSnippets: ['Mapped source reroute behavior into target service.'],
              validationEvidence: ['Implementation v1 proof accepted.'],
              rationale: 'Release branch required BaseUtils adaptation.',
            },
          ],
          priorRetrofitAdaptationCoverage: [
            {
              sourceSha: '9ce5326',
              filesCovered: ['src/UIComponentService.java', 'src/BaseUtils.java'],
              hunkEvidence: ['BaseUtils preserves the source guard behavior.'],
            },
          ],
          codeReviewFindings: buildCodeReview({
            requiredChanges: ['Fix excludeIgnoredRerouteQueue in BaseUtils.'],
          }),
        },
      }),
    )

    const variables = composePrompt.mock.calls[0][1]
    expect(loadRetrofitWorkflowPrompt).toHaveBeenCalledTimes(1)
    expect(variables.retrofitWorkflowSection).toContain(
      'must not re-run source patch application',
    )
    expect(variables.retrofitWorkflowSection).toContain('9ce5326')
    expect(variables.revisionSection).toContain('Prior Retrofit Source Proof')
    expect(variables.revisionSection).toContain('9ce5326 status=adapted')
    expect(variables.revisionSection).toContain('src/BaseUtils.java')
    expect(variables.revisionSection).toContain(
      'Fix excludeIgnoredRerouteQueue in BaseUtils.',
    )
  })

  it('omits the retrofit adaptation instruction when retrofitAdaptationContext is absent', async () => {
    const composePrompt = vi.fn().mockResolvedValue('prompt')
    const provider = new ClaudeImplementerProvider({
      composePrompt,
    } as unknown as PromptComposer)
    runAgentMock.mockResolvedValue(buildAgentResult())

    await provider.implementPlan(buildRequest())

    const variables = composePrompt.mock.calls[0][1]
    // Field should be empty string or falsy when not in adaptation mode
    expect(variables.retrofitAdaptationSection || '').toBe('')
    expect(variables.retrofitWorkflowSection || '').toBe('')
  })
})
