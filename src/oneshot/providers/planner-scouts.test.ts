import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPlannerScoutWorkPlan,
  parseScoutMarkdown,
  PlannerScoutProvider,
} from './planner-scouts.js'
import type { PlannerGroundingContext } from '../planner-grounding.js'

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

const weakGrounding: PlannerGroundingContext = {
  generatedAt: '2026-04-17T12:00:00.000Z',
  jiraKey: 'CPDEV-20908',
  repoName: 'core-app',
  confidence: 'weak',
  terms: [],
  routeCards: [],
  candidateFiles: [],
  snippets: [],
  sourceTestPairs: [],
  riskFiles: [],
  warnings: [],
}

describe('PlannerScoutProvider', () => {
  let workspacePath: string

  beforeEach(async () => {
    runAgentMock.mockReset()
    registerRepoFromPathMock.mockReset()
    registerRepoFromPathMock.mockReturnValue('workspace')
    workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), 'planner-scouts-'))
  })

  afterEach(async () => {
    await fs.rm(workspacePath, { recursive: true, force: true })
  })

  it('selects uncovered requirements before requirements already backed by grounding', () => {
    const workPlan = buildPlannerScoutWorkPlan({
      qualificationSummary: {
        requirementsSummary: [
          'Update MemberSearchForm cancel button styling.',
          'Fix the queue routing behavior when approvals are reassigned.',
          'Document existing MemberSearchForm behavior.',
        ],
        nonBlockingWarnings: [],
      },
      groundingContext: {
        ...weakGrounding,
        candidateFiles: [{
          path: 'MedicalMgmt/src/main/java/com/medhok/mm/client/member/MemberSearchForm.java',
          score: 10,
          reasons: ['route card'],
          matchedTerms: ['MemberSearchForm'],
          exists: true,
        }],
      },
    })
    const workItems = workPlan.workItems

    expect(workPlan.coverage).toEqual({
      requirementCount: 3,
      evidenceBackedRequirementCount: 2,
      uncoveredRequirementCount: 1,
    })
    expect(workItems).toHaveLength(1)
    expect(workItems[0]).toMatchObject({
      objective: 'Fix the queue routing behavior when approvals are reassigned.',
      backedByExistingEvidence: false,
    })
  })

  it('reports no uncovered work when all requirements are backed by existing evidence', () => {
    const workPlan = buildPlannerScoutWorkPlan({
      qualificationSummary: {
        requirementsSummary: [
          'Fix AuthorizationService.getAuthChildMap batching for MedicalMgmt/src/main/java/com/medhok/mm/server/service/AuthorizationService.java.',
        ],
        nonBlockingWarnings: [],
      },
      groundingContext: {
        ...weakGrounding,
        confidence: 'medium',
        candidateFiles: [{
          path: 'MedicalMgmt/src/main/java/com/medhok/mm/server/service/AuthorizationService.java',
          score: 10,
          reasons: ['qualifier inspected target service'],
          matchedTerms: ['AuthorizationService', 'getAuthChildMap'],
          exists: true,
        }],
        qualificationEvidence: {
          strong: false,
          trusted: true,
          verifiedInspectedFiles: [
            'MedicalMgmt/src/main/java/com/medhok/mm/server/service/AuthorizationService.java',
          ],
          inspectionSummary: 'Qualifier inspected AuthorizationService.getAuthChildMap.',
          reasons: ['verified inspected file'],
        },
      },
    })

    expect(workPlan.workItems).toEqual([])
    expect(workPlan.coverage).toEqual({
      requirementCount: 1,
      evidenceBackedRequirementCount: 1,
      uncoveredRequirementCount: 0,
    })
  })

  it('reports zero requirements when qualification produced no requirement summaries', async () => {
    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Fallback prose should be left for the main planner.',
      qualificationSummary: {
        requirementsSummary: [],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
    })

    expect(runAgentMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      workItems: [],
      reports: [],
      coverage: {
        requirementCount: 0,
        evidenceBackedRequirementCount: 0,
        uncoveredRequirementCount: 0,
      },
      scoutInvocationFailed: false,
      scoutReturnedNothing: false,
    })
    expect(result.warnings[0]).toContain('No qualification requirements')
  })

  it('returns valid scout evidence with verified inspected files', async () => {
    await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspacePath, 'src/ApprovalQueue.ts'), 'export const queue = true\n')
    runAgentMock.mockResolvedValue({
      success: true,
      output: [
        '## FILES',
        '- src/ApprovalQueue.ts - approval queue implementation',
        '## SNIPPETS',
        '- src/ApprovalQueue.ts:1 - export const queue = true',
        '## SUMMARY',
        'Found approval queue implementation.',
      ].join('\n'),
      metrics: {
        durationMs: 1000,
        toolCalls: 2,
        tokensUsed: { input: 10, output: 20 },
        costUsd: 0.01,
        modelUsed: 'haiku-test',
      },
    })

    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Fix approval queue routing.',
      qualificationSummary: {
        requirementsSummary: ['Fix approval queue routing.'],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
      permissionMode: 'bypassPermissions',
      toolVisibility: 'legacyAllowedToolsOnly',
      toolGuard: 'enabled',
    })

    expect(result.reports).toHaveLength(1)
    expect(result).toMatchObject({
      coverage: {
        requirementCount: 1,
        evidenceBackedRequirementCount: 0,
        uncoveredRequirementCount: 1,
      },
      scoutInvocationFailed: false,
      scoutReturnedNothing: false,
    })
    expect(result.reports[0]).toMatchObject({
      status: 'valid',
      verifiedInspectedFiles: ['src/ApprovalQueue.ts'],
      toolCalls: 2,
      costUsd: 0.01,
    })
    expect(runAgentMock).toHaveBeenCalledWith(expect.objectContaining({
      sdkStage: 'planning_scout',
      allowedTools: ['Read', 'Glob', 'Grep'],
      timeoutMs: 300_000,
      idleTimeoutMs: 60_000,
      maxTurns: 12,
      maxBudgetUsd: 1,
      bedrockConfig: { model: 'haiku-test' },
      permissionMode: 'bypassPermissions',
      toolVisibility: 'legacyAllowedToolsOnly',
        toolGuard: 'enabled',
        settingSources: [],
      }))
  })

  it('runs up to six fallback evidence scouts in parallel with the expanded scout timeout', async () => {
    const releaseScouts: Array<(value: unknown) => void> = []
    runAgentMock.mockImplementation(() =>
      new Promise((resolve) => {
        releaseScouts.push(resolve)
      }),
    )

    await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspacePath, 'src/SharedEvidence.ts'), 'export const shared = true\n')

    const runPromise = new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Large ticket needs parallel scout coverage.',
      qualificationSummary: {
        requirementsSummary: [
          'Investigate area alpha.',
          'Investigate area beta.',
          'Investigate area gamma.',
          'Investigate area delta.',
          'Investigate area epsilon.',
          'Investigate area zeta.',
          'Investigate area eta.',
          'Investigate area theta.',
        ],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
    })

    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(6))
    for (const release of releaseScouts) {
      release({
        success: true,
        output: [
          '## FILES',
          '- src/SharedEvidence.ts - shared evidence file',
          '## SUMMARY',
          'Found shared evidence.',
        ].join('\n'),
        metrics: {
          durationMs: 1000,
          toolCalls: 1,
        },
      })
    }
    const result = await runPromise

    expect(result.workItems).toHaveLength(6)
    expect(new Set(result.workItems.map(workItem => workItem.id)).size).toBe(6)
    expect(result.workItems.every(workItem => /^scout-\d+$/.test(workItem.id))).toBe(true)
    expect(runAgentMock).toHaveBeenCalledTimes(6)
    for (const call of runAgentMock.mock.calls) {
      expect(call[0]).toMatchObject({
        sdkStage: 'planning_scout',
        timeoutMs: 300_000,
        idleTimeoutMs: 60_000,
      })
    }
  })

  it('drops zero-tool reports with no verified files', async () => {
    runAgentMock.mockResolvedValue({
      success: true,
      output: [
        '## FILES',
        '- src/Missing.ts - maybe relevant',
        '## SUMMARY',
        'I did not use tools.',
      ].join('\n'),
      metrics: {
        durationMs: 500,
        toolCalls: 0,
        tokensUsed: { input: 5, output: 5 },
        costUsd: 0.002,
      },
    })

    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Find missing route.',
      qualificationSummary: {
        requirementsSummary: ['Find missing route.'],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
    })

    expect(result.reports[0]).toMatchObject({
      status: 'ignored',
      failureReason: 'scout returned without repository tool calls',
      toolCalls: 0,
    })
    expect(result.scoutReturnedNothing).toBe(true)
  })

  it('marks scout invocation failures separately from empty scout results', async () => {
    runAgentMock.mockRejectedValue(new Error('Bedrock auth failed'))

    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Find missing route.',
      qualificationSummary: {
        requirementsSummary: ['Find missing route.'],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
    })

    expect(result.scoutInvocationFailed).toBe(true)
    expect(result.scoutReturnedNothing).toBe(false)
    expect(result.reports[0]).toMatchObject({
      status: 'failed',
      invocationFailed: true,
      failureReason: 'Bedrock auth failed',
    })
  })

  it('preserves coverage when scout setup fails before SDK invocation', async () => {
    registerRepoFromPathMock.mockImplementation(() => {
      throw new Error('repo registration failed')
    })

    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Find missing route.',
      qualificationSummary: {
        requirementsSummary: ['Find missing route.'],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
    })

    expect(runAgentMock).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      reports: [],
      coverage: {
        requirementCount: 1,
        evidenceBackedRequirementCount: 0,
        uncoveredRequirementCount: 1,
      },
      scoutInvocationFailed: true,
      scoutReturnedNothing: false,
    })
    expect(result.warnings[0]).toContain('repo registration failed')
  })

  it('drops tool-using reports when markdown has no parseable files', async () => {
    runAgentMock.mockResolvedValue({
      success: true,
      output: [
        '## SUMMARY',
        'I searched but did not find a specific file.',
      ].join('\n'),
      metrics: {
        durationMs: 500,
        toolCalls: 2,
      },
    })

    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Find missing route.',
      qualificationSummary: {
        requirementsSummary: ['Find missing route.'],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
    })

    expect(result.reports[0]).toMatchObject({
      status: 'ignored',
      failureReason: 'scout returned no parseable files',
      toolCalls: 2,
    })
  })

  it('filters hallucinated file paths before accepting scout evidence', async () => {
    runAgentMock.mockResolvedValue({
      success: true,
      output: [
        '## FILES',
        '- src/DoesNotExist.ts - hallucinated file',
        '## SNIPPETS',
        '- src/DoesNotExist.ts:1 - missing',
        '## SUMMARY',
        'Found a likely file.',
      ].join('\n'),
      metrics: {
        durationMs: 500,
        toolCalls: 2,
      },
    })

    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Find missing route.',
      qualificationSummary: {
        requirementsSummary: ['Find missing route.'],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      scoutModelId: 'haiku-test',
    })

    expect(result.reports[0]).toMatchObject({
      status: 'ignored',
      inspectedFiles: ['src/DoesNotExist.ts'],
      verifiedInspectedFiles: [],
      failureReason: 'no inspected files were found in the workspace',
    })
  })

  it('parses scout markdown sections into files, snippets, and summary', () => {
    const parsed = parseScoutMarkdown([
      '## FILES',
      '- `src/ApprovalQueue.ts` - queue implementation',
      '## SNIPPETS',
      '- src/ApprovalQueue.ts:12 - routeApproval(user)',
      '## SUMMARY',
      'Approval routing starts here.',
    ].join('\n'))

    expect(parsed).toEqual({
      files: ['src/ApprovalQueue.ts'],
      snippets: [{
        file: 'src/ApprovalQueue.ts',
        line: 12,
        term: 'scout',
        text: 'routeApproval(user)',
      }],
      symbols: [],
      testFiles: [],
      commands: [],
      templateMappings: [],
      blockers: [],
      summary: 'Approval routing starts here.',
    })
  })

  it('uses LLM-generated workplan briefs for scout prompts and bounded tool budgets', async () => {
    await fs.mkdir(path.join(workspacePath, 'src'), { recursive: true })
    await fs.writeFile(path.join(workspacePath, 'src/Workflow.ts'), 'export const workflow = true\n')
    await fs.writeFile(path.join(workspacePath, 'src/Workflow.test.ts'), 'test("workflow", () => {})\n')
    runAgentMock.mockResolvedValue({
      success: true,
      output: [
        '## FILES',
        '- src/Workflow.ts - runtime implementation',
        '## SNIPPETS',
        '- src/Workflow.ts:1 - export const workflow = true',
        '## SYMBOLS',
        '- workflow - exported runtime flag',
        '## TESTS',
        '- src/Workflow.test.ts - adjacent unit test',
        '## COMMANDS',
        '- npm test -- Workflow',
        '## TEMPLATE MAPPINGS',
        '- new workflow case <- src/Workflow.ts - match existing runtime pattern',
        '## RISKS',
        '- source parity must be checked',
        '## SUMMARY',
        'Found runtime and test evidence.',
      ].join('\n'),
      metrics: {
        durationMs: 500,
        toolCalls: 3,
        tokensUsed: { input: 5, output: 6 },
        costUsd: 0.001,
      },
    })

    const workplan = {
      complexity: 'broad' as const,
      directPlanningAllowed: false,
      rationale: 'Need focused scout evidence.',
      scouts: [{
        id: 'runtime-and-tests',
        objective: 'Find runtime and test files for workflow change.',
        whyNeeded: 'Final plan needs exact file contract and testing strategy.',
        startingPoints: ['src'],
        searchTerms: ['workflow'],
        mustAnswer: ['Which runtime and test files should shape the plan?'],
        expectedEvidence: ['verified runtime file', 'verified test file'],
        priority: 'critical' as const,
        maxToolCalls: 6,
        stopConditions: ['Runtime and test files are verified.'],
        fallbackIfIncomplete: 'Proceed with explicit gaps.',
      }],
      globalRisks: [],
      evidenceGaps: [],
    }

    const result = await new PlannerScoutProvider().runScouts({
      jiraKey: 'CPDEV-20908',
      repoName: 'core-app',
      workspacePath,
      taskDescription: 'Fix workflow routing.',
      qualificationSummary: {
        requirementsSummary: ['Fix workflow routing.'],
        nonBlockingWarnings: [],
      },
      groundingContext: weakGrounding,
      workplan,
      workplanSource: 'llm',
      workplanWarnings: ['workplan warning'],
      scoutModelId: 'haiku-test',
    })

    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toolBudgetGuard: expect.objectContaining({
          enabled: true,
          tools: ['Read', 'Glob', 'Grep'],
          maxCalls: 6,
        }),
        settingSources: [],
      }),
    )
    const prompt = runAgentMock.mock.calls[0][0].taskPrompt
    expect(prompt).toContain('one focused planner workplan brief')
    expect(prompt).toContain('Why needed: Final plan needs exact file contract and testing strategy.')
    expect(prompt).toContain('Must Answer:')
    expect(prompt).toContain('Which runtime and test files should shape the plan?')
    expect(result.workItems).toHaveLength(1)
    expect(result.workplanSource).toBe('llm')
    expect(result.warnings).toContain('workplan warning')
    expect(result.reports[0]).toMatchObject({
      status: 'valid',
      verifiedInspectedFiles: ['src/Workflow.ts', 'src/Workflow.test.ts'],
      symbols: ['workflow - exported runtime flag'],
      testFiles: ['src/Workflow.test.ts'],
      commands: ['npm test -- Workflow'],
      templateMappings: [{
        targetPattern: 'new workflow case',
        templateFile: 'src/Workflow.ts',
        rationale: 'match existing runtime pattern',
      }],
      blockers: ['source parity must be checked'],
    })
  })
})
