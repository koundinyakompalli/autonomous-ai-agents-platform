import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ScoutWorkplanProvider,
  buildScoutWorkplanPrompt,
} from './scout-workplan.js'
import { ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA } from '../schema/scout-workplan.js'

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

function buildRequest() {
  return {
    jiraKey: 'CPSUP-43828',
    repoName: 'core-app',
    workspacePath: '/tmp/workspace',
    taskDescription: 'Ticket asks to update a UI workflow using attached evidence.',
    ticketEvidenceSummary: [
      'Attachment Review Reference',
      'Reviewed: design-notes.docx, reproduction.txt',
      'Not reviewed: raw-export.xlsx unsupported spreadsheet',
    ].join('\n'),
    qualificationSummary: {
      requirementsSummary: ['Update the related workflow and preserve source parity.'],
      acceptanceCriteriaPresent: true,
      nonBlockingWarnings: ['Spreadsheet attachment was not reviewed.'],
    },
    repoScanSummary: 'MedicalMgmt contains Java, CSS, SCSS, and JUnit surfaces.',
    routeCardContext: 'Route card suggests MedicalMgmt/src/main/java and loaded CSS.',
    groundingSummary: 'Candidate files: MedicalMgmt/src/main/java/.../MemberSearchForm.java',
    revisionSummary: 'Reviewer asked for source parity and a clearer test strategy.',
    priorDiagnostics: [{
      key: 'oneshot/CPSUP-43828/run-7/planning/diagnostic.json',
      kind: 'failedOutput',
      body: {
        errors: [{ path: '/testingStrategy', message: 'missing' }],
        outputPreview: '{ "summary": "too small" }',
      },
    }],
    scoutModelId: 'haiku-test',
    permissionMode: 'default' as const,
    toolVisibility: 'restricted' as const,
    toolGuard: 'enabled' as const,
  }
}

function buildStructuredWorkplan() {
  return {
    complexity: 'broad',
    directPlanningAllowed: false,
    rationale: 'Attachment-heavy UI ticket needs focused evidence before final planning.',
    scouts: [{
      id: 'target-grounding',
      objective: 'Find target runtime and style files.',
      whyNeeded: 'The planner needs exact editable files.',
      startingPoints: ['MedicalMgmt/src'],
      searchTerms: ['MemberSearchForm', 'cancel'],
      mustAnswer: ['Which Java and CSS files are loaded for the UI?'],
      expectedEvidence: ['verified Java and CSS paths'],
      priority: 'critical',
      maxToolCalls: 10,
      stopConditions: ['Runtime and style files are identified.'],
      fallbackIfIncomplete: 'Proceed with explicit file-scope uncertainty.',
    }],
    globalRisks: ['source parity may require SCSS and generated CSS'],
    evidenceGaps: ['spreadsheet attachment unsupported'],
  }
}

describe('ScoutWorkplanProvider', () => {
  beforeEach(() => {
    runAgentMock.mockReset()
    registerRepoFromPathMock.mockReset()
    registerRepoFromPathMock.mockReturnValue('workspace')
  })

  it('builds a prompt with ticket evidence, grounding, revision context, and prior diagnostics', () => {
    const prompt = buildScoutWorkplanPrompt(buildRequest())

    expect(prompt).toContain('Attachment Review Reference')
    expect(prompt).toContain('Reviewed: design-notes.docx')
    expect(prompt).toContain('Not reviewed: raw-export.xlsx unsupported spreadsheet')
    expect(prompt).toContain('MedicalMgmt contains Java, CSS, SCSS, and JUnit surfaces')
    expect(prompt).toContain('Route card suggests MedicalMgmt/src/main/java')
    expect(prompt).toContain('Candidate files: MedicalMgmt/src/main/java')
    expect(prompt).toContain('Reviewer asked for source parity')
    expect(prompt).toContain('oneshot/CPSUP-43828/run-7/planning/diagnostic.json')
    expect(prompt).toContain('/testingStrategy')
    expect(prompt).toContain('Do not create an implementation plan')
    expect(prompt).toContain('Scouts are read-only and may use only Read, Glob, and Grep')
  })

  it('calls the SDK with no repo tools and sanitizes structured workplan output', async () => {
    runAgentMock.mockResolvedValue({
      success: true,
      output: JSON.stringify(buildStructuredWorkplan()),
      structuredOutput: buildStructuredWorkplan(),
      metrics: {
        durationMs: 100,
        toolCalls: 0,
        tokensUsed: { input: 11, output: 12 },
        costUsd: 0.003,
        modelUsed: 'haiku-test',
      },
    })

    const result = await new ScoutWorkplanProvider().generateWorkplan(buildRequest())

    expect(registerRepoFromPathMock).toHaveBeenCalledWith(
      '/tmp/workspace',
      expect.stringContaining('oneshot-run-CPSUP-43828-scout-workplan'),
    )
    expect(runAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sdkStage: 'planning_scout_workplan',
        repoIds: ['workspace'],
        allowedTools: [],
        disableTools: true,
        outputSchema: ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA,
        timeoutMs: 180_000,
        maxTurns: 4,
        maxBudgetUsd: 2,
        bedrockConfig: { model: 'haiku-test' },
        permissionMode: 'default',
        toolVisibility: 'restricted',
        toolGuard: 'enabled',
        settingSources: [],
      }),
    )
    expect(result).toMatchObject({
      source: 'llm',
      workplan: {
        complexity: 'broad',
        scouts: [expect.objectContaining({ id: 'target-grounding' })],
      },
      metrics: expect.objectContaining({
        tokensUsed: { input: 11, output: 12 },
      }),
    })
  })

  it('falls back non-blockingly when workplan generation fails', async () => {
    runAgentMock.mockResolvedValue({
      success: false,
      output: '',
      error: 'structured output failed',
      metrics: {
        durationMs: 100,
        toolCalls: 0,
      },
    })

    const result = await new ScoutWorkplanProvider().generateWorkplan(buildRequest())

    expect(result.source).toBe('fallback')
    expect(result.warnings[0]).toBe('structured output failed')
    expect(result.workplan.scouts.map((scout) => scout.id)).toEqual([
      'target-grounding',
      'test-surface',
    ])
  })

  it('falls back non-blockingly when repo registration fails', async () => {
    registerRepoFromPathMock.mockImplementation(() => {
      throw new Error('repo registration failed')
    })

    const result = await new ScoutWorkplanProvider().generateWorkplan(buildRequest())

    expect(runAgentMock).not.toHaveBeenCalled()
    expect(result.source).toBe('fallback')
    expect(result.warnings[0]).toContain('repo registration failed')
  })
})
