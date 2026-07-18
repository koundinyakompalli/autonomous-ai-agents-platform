import Ajv from 'ajv'
import { describe, expect, it } from 'vitest'
import {
  ONE_SHOT_SCOUT_WORKPLAN_MAX_SCOUTS,
  ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA,
  OneShotScoutWorkplanSchema,
  sanitizeScoutWorkplan,
} from './scout-workplan.js'

function buildScout(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `scout-${index}`,
    objective: `Investigate focused area ${index}.`,
    whyNeeded: 'The final planner needs grounded repository evidence.',
    startingPoints: [`src/area-${index}`],
    searchTerms: [`area-${index}`],
    mustAnswer: ['Which files and tests are relevant?'],
    expectedEvidence: ['verified file paths', 'test surface evidence'],
    priority: index === 1 ? 'critical' : 'medium',
    maxToolCalls: 8,
    stopConditions: ['Stop after relevant files or explicit gaps are found.'],
    fallbackIfIncomplete: 'Proceed with explicit evidence gaps.',
    ...overrides,
  }
}

function buildWorkplan(overrides: Record<string, unknown> = {}) {
  return {
    complexity: 'moderate',
    directPlanningAllowed: false,
    rationale: 'The ticket needs bounded scout exploration before final planning.',
    scouts: [buildScout(1)],
    globalRisks: ['large repo search could miss source/test parity'],
    evidenceGaps: [],
    ...overrides,
  }
}

describe('OneShot scout workplan schema', () => {
  it('accepts valid structured workplans in zod and the SDK output schema', () => {
    const workplan = buildWorkplan()
    expect(OneShotScoutWorkplanSchema.parse(workplan)).toMatchObject({
      complexity: 'moderate',
      scouts: [expect.objectContaining({ id: 'scout-1' })],
    })

    const validate = new Ajv().compile(ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA)
    expect(validate(workplan)).toBe(true)
  })

  it('rejects final-plan-shaped output and falls back to generic scouts', () => {
    const finalPlanShapedOutput = {
      implementationMode: 'code',
      specs: [],
      guardrailReport: {},
    }
    const validate = new Ajv().compile(ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA)
    expect(validate(finalPlanShapedOutput)).toBe(true)

    const result = sanitizeScoutWorkplan(finalPlanShapedOutput)

    expect(result.source).toBe('fallback')
    expect(result.warnings[0]).toContain('Rejected final-plan-shaped')
    expect(result.workplan.scouts.map((scout) => scout.id)).toEqual([
      'target-grounding',
      'test-surface',
    ])
  })

  it('clamps scout count, budgets, and unsafe starting paths', () => {
    const overBudgetWorkplan = buildWorkplan({
      scouts: [
        buildScout(1, {
          priority: 'low',
          maxToolCalls: 100,
          startingPoints: [
            'src/safe',
            '../outside',
            '/tmp/absolute',
            'C:/absolute',
            './src/normalized',
          ],
        }),
        buildScout(2, { priority: 'critical', maxToolCalls: 1 }),
        buildScout(3, { priority: 'high', maxToolCalls: 12 }),
        buildScout(4, { priority: 'medium', maxToolCalls: 12 }),
        buildScout(5, { priority: 'low', maxToolCalls: 12 }),
        buildScout(6, { priority: 'low', maxToolCalls: 12 }),
        buildScout(7, { priority: 'low', maxToolCalls: 12 }),
      ],
    })
    const validate = new Ajv().compile(ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA)
    expect(validate(overBudgetWorkplan)).toBe(true)

    const result = sanitizeScoutWorkplan(overBudgetWorkplan)

    expect(result.source).toBe('llm')
    expect(result.workplan.scouts).toHaveLength(ONE_SHOT_SCOUT_WORKPLAN_MAX_SCOUTS)
    expect(result.workplan.scouts.map((scout) => scout.id)).toEqual([
      'scout-2',
      'scout-3',
      'scout-4',
      'scout-1',
      'scout-5',
      'scout-6',
    ])
    expect(result.workplan.scouts[0].maxToolCalls).toBe(4)
    expect(result.workplan.scouts[3].maxToolCalls).toBe(12)
    expect(result.workplan.scouts[3].startingPoints).toEqual([
      'src/safe',
      'src/normalized',
    ])
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Clamped scout count from 7 to 6'),
        expect.stringContaining('Clamped scout scout-2 maxToolCalls from 1 to 4'),
        expect.stringContaining('Clamped scout scout-1 maxToolCalls from 100 to 12'),
      ]),
    )
  })

  it('lets the sanitizer default optional workplan fields and strip unknown scout fields', () => {
    const scout = buildScout(1)
    delete (scout as Record<string, unknown>).startingPoints
    delete (scout as Record<string, unknown>).searchTerms
    delete (scout as Record<string, unknown>).priority
    delete (scout as Record<string, unknown>).maxToolCalls
    ;(scout as Record<string, unknown>).tools = ['Bash']
    const workplan = buildWorkplan({ scouts: [scout] })
    delete (workplan as Record<string, unknown>).globalRisks
    delete (workplan as Record<string, unknown>).evidenceGaps

    const validate = new Ajv().compile(ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA)
    expect(validate(workplan)).toBe(true)

    const result = sanitizeScoutWorkplan(workplan)

    expect(result.source).toBe('llm')
    expect(result.workplan.globalRisks).toEqual([])
    expect(result.workplan.evidenceGaps).toEqual([])
    expect(result.workplan.scouts[0]).toMatchObject({
      startingPoints: [],
      searchTerms: [],
      priority: 'medium',
      maxToolCalls: 8,
    })
    expect((result.workplan.scouts[0] as Record<string, unknown>).tools).toBeUndefined()
  })
})
