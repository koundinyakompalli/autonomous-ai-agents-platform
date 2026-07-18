import { z } from 'zod'

export const ONE_SHOT_SCOUT_WORKPLAN_MAX_SCOUTS = 6
export const ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MAX_SCOUTS = 12
export const ONE_SHOT_SCOUT_WORKPLAN_TOTAL_TOOL_BUDGET = 72
export const ONE_SHOT_SCOUT_WORKPLAN_MAX_TOOL_CALLS_PER_SCOUT = 12
export const ONE_SHOT_SCOUT_WORKPLAN_MIN_TOOL_CALLS_PER_SCOUT = 4
export const ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MAX_TOOL_CALLS_PER_SCOUT = 100
export const ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MIN_TOOL_CALLS_PER_SCOUT = 1

export const OneShotScoutWorkplanComplexitySchema = z.enum([
  'simple',
  'moderate',
  'broad',
  'uncertain',
])

export const OneShotScoutWorkplanPrioritySchema = z.enum([
  'critical',
  'high',
  'medium',
  'low',
])

export const OneShotScoutBriefSchema = z.object({
  id: z.string().min(1).max(80),
  objective: z.string().min(1).max(1000),
  whyNeeded: z.string().min(1).max(1200),
  startingPoints: z.array(z.string().min(1).max(500)).max(12).default([]),
  searchTerms: z.array(z.string().min(1).max(120)).max(16).default([]),
  mustAnswer: z.array(z.string().min(1).max(500)).min(1).max(10),
  expectedEvidence: z.array(z.string().min(1).max(500)).min(1).max(10),
  priority: OneShotScoutWorkplanPrioritySchema.default('medium'),
  maxToolCalls: z.number().int().min(ONE_SHOT_SCOUT_WORKPLAN_MIN_TOOL_CALLS_PER_SCOUT).max(ONE_SHOT_SCOUT_WORKPLAN_MAX_TOOL_CALLS_PER_SCOUT).default(8),
  stopConditions: z.array(z.string().min(1).max(500)).min(1).max(8),
  fallbackIfIncomplete: z.string().min(1).max(1000),
})

export const OneShotScoutWorkplanSchema = z.object({
  complexity: OneShotScoutWorkplanComplexitySchema,
  directPlanningAllowed: z.boolean(),
  rationale: z.string().min(1).max(2000),
  scouts: z.array(OneShotScoutBriefSchema).max(ONE_SHOT_SCOUT_WORKPLAN_MAX_SCOUTS).default([]),
  globalRisks: z.array(z.string().min(1).max(1000)).max(12).default([]),
  evidenceGaps: z.array(z.string().min(1).max(1000)).max(12).default([]),
})

const OneShotScoutBriefSanitizerSchema = OneShotScoutBriefSchema.extend({
  maxToolCalls: z.number().int()
    .min(ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MIN_TOOL_CALLS_PER_SCOUT)
    .max(ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MAX_TOOL_CALLS_PER_SCOUT)
    .default(8),
})

const OneShotScoutWorkplanSanitizerSchema = OneShotScoutWorkplanSchema.extend({
  scouts: z.array(OneShotScoutBriefSanitizerSchema)
    .max(ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MAX_SCOUTS)
    .default([]),
})

export type OneShotScoutBrief = z.infer<typeof OneShotScoutBriefSchema>
export type OneShotScoutWorkplan = z.infer<typeof OneShotScoutWorkplanSchema>
export type OneShotScoutWorkplanSource = 'llm' | 'fallback'

export interface OneShotScoutWorkplanSanitizationResult {
  workplan: OneShotScoutWorkplan
  source: OneShotScoutWorkplanSource
  warnings: string[]
}

export const ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: true,
  properties: {
    complexity: {
      type: 'string' as const,
      enum: ['simple', 'moderate', 'broad', 'uncertain'],
    },
    directPlanningAllowed: { type: 'boolean' as const },
    rationale: { type: 'string' as const, minLength: 1, maxLength: 2000 },
    scouts: {
      type: 'array' as const,
      maxItems: ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MAX_SCOUTS,
      items: {
        type: 'object' as const,
        additionalProperties: true,
        properties: {
          id: { type: 'string' as const, minLength: 1, maxLength: 80 },
          objective: { type: 'string' as const, minLength: 1, maxLength: 1000 },
          whyNeeded: { type: 'string' as const, minLength: 1, maxLength: 1200 },
          startingPoints: {
            type: 'array' as const,
            maxItems: 12,
            items: { type: 'string' as const, minLength: 1, maxLength: 500 },
          },
          searchTerms: {
            type: 'array' as const,
            maxItems: 16,
            items: { type: 'string' as const, minLength: 1, maxLength: 120 },
          },
          mustAnswer: {
            type: 'array' as const,
            minItems: 1,
            maxItems: 10,
            items: { type: 'string' as const, minLength: 1, maxLength: 500 },
          },
          expectedEvidence: {
            type: 'array' as const,
            minItems: 1,
            maxItems: 10,
            items: { type: 'string' as const, minLength: 1, maxLength: 500 },
          },
          priority: {
            type: 'string' as const,
            enum: ['critical', 'high', 'medium', 'low'],
          },
          maxToolCalls: {
            type: 'integer' as const,
            minimum: ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MIN_TOOL_CALLS_PER_SCOUT,
            maximum: ONE_SHOT_SCOUT_WORKPLAN_OUTPUT_MAX_TOOL_CALLS_PER_SCOUT,
          },
          stopConditions: {
            type: 'array' as const,
            minItems: 1,
            maxItems: 8,
            items: { type: 'string' as const, minLength: 1, maxLength: 500 },
          },
          fallbackIfIncomplete: {
            type: 'string' as const,
            minLength: 1,
            maxLength: 1000,
          },
        },
        required: [
          'id',
          'objective',
          'whyNeeded',
          'mustAnswer',
          'expectedEvidence',
          'stopConditions',
          'fallbackIfIncomplete',
        ],
      },
    },
    globalRisks: {
      type: 'array' as const,
      maxItems: 12,
      items: { type: 'string' as const, minLength: 1, maxLength: 1000 },
    },
    evidenceGaps: {
      type: 'array' as const,
      maxItems: 12,
      items: { type: 'string' as const, minLength: 1, maxLength: 1000 },
    },
  },
  required: [],
}

const FINAL_PLAN_KEYS = new Set([
  'jiraKey',
  'repoName',
  'branchName',
  'baseCommitSha',
  'implementationMode',
  'specs',
  'fileChangeContract',
  'plannedCodeChanges',
  'guardrailReport',
  'testingStrategy',
  'implementerGuardrails',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizePathLike(value: string): string | null {
  const normalized = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) {
    return null
  }
  if (/^(?:[a-zA-Z]:)?\//.test(normalized)) {
    return null
  }
  if (normalized.split('/').some(part => part === '..')) {
    return null
  }
  return normalized
}

function sanitizeStringList(
  values: string[],
  maxItems: number,
  options: { pathLike?: boolean } = {},
): string[] {
  const sanitized: string[] = []
  for (const value of values) {
    const trimmed = value.trim()
    if (!trimmed) {
      continue
    }
    const candidate = options.pathLike ? normalizePathLike(trimmed) : trimmed
    if (!candidate) {
      continue
    }
    if (!sanitized.includes(candidate)) {
      sanitized.push(candidate)
    }
    if (sanitized.length >= maxItems) {
      break
    }
  }
  return sanitized
}

function priorityRank(priority: OneShotScoutBrief['priority']): number {
  switch (priority) {
    case 'critical':
      return 0
    case 'high':
      return 1
    case 'medium':
      return 2
    case 'low':
      return 3
  }
}

function clampScoutBudget(
  scouts: OneShotScoutBrief[],
  warnings: string[],
): OneShotScoutBrief[] {
  let remaining = ONE_SHOT_SCOUT_WORKPLAN_TOTAL_TOOL_BUDGET
  const clamped: OneShotScoutBrief[] = []

  for (const scout of scouts) {
    const maxToolCalls = Math.min(
      ONE_SHOT_SCOUT_WORKPLAN_MAX_TOOL_CALLS_PER_SCOUT,
      Math.max(ONE_SHOT_SCOUT_WORKPLAN_MIN_TOOL_CALLS_PER_SCOUT, scout.maxToolCalls),
    )
    if (remaining < ONE_SHOT_SCOUT_WORKPLAN_MIN_TOOL_CALLS_PER_SCOUT) {
      warnings.push(`Dropped scout ${scout.id} because the scout workplan tool budget was exhausted.`)
      continue
    }
    const allocated = Math.min(maxToolCalls, remaining)
    remaining -= allocated
    if (allocated !== scout.maxToolCalls) {
      warnings.push(`Clamped scout ${scout.id} maxToolCalls from ${scout.maxToolCalls} to ${allocated}.`)
    }
    clamped.push({
      ...scout,
      maxToolCalls: allocated,
    })
  }

  return clamped
}

export function createFallbackScoutWorkplan(reason: string): OneShotScoutWorkplan {
  return {
    complexity: 'uncertain',
    directPlanningAllowed: false,
    rationale: `Scout workplan fallback was used: ${reason}`,
    scouts: [
      {
        id: 'target-grounding',
        objective: 'Identify exact repository files and symbols that ground the requested change.',
        whyNeeded: 'The planner needs concrete file evidence before producing an implementation contract.',
        startingPoints: [],
        searchTerms: [],
        mustAnswer: [
          'Which existing files, symbols, configs, or tests are most likely relevant?',
          'Which candidate files should be editable and which should be read-only evidence?',
        ],
        expectedEvidence: ['verified source/config/test file paths', 'short snippets or symbol names'],
        priority: 'critical',
        maxToolCalls: 12,
        stopConditions: ['At least one concrete relevant file is verified or the search space is exhausted.'],
        fallbackIfIncomplete: 'Planner should proceed with explicit evidence gaps and avoid inventing target files.',
      },
      {
        id: 'test-surface',
        objective: 'Identify existing tests, fixtures, and runnable validation commands for the planned change.',
        whyNeeded: 'The final plan must include a test strategy grounded in the repository test surface.',
        startingPoints: [],
        searchTerms: ['test', 'spec', 'fixture'],
        mustAnswer: [
          'What automated test files or fixtures are adjacent to the likely change?',
          'Which validation command should the Implementer run, or why is no suitable test surface available?',
        ],
        expectedEvidence: ['verified test file paths', 'validation commands or explicit test-surface gaps'],
        priority: 'high',
        maxToolCalls: 8,
        stopConditions: ['A concrete test surface is found or a no-test-surface gap is justified.'],
        fallbackIfIncomplete: 'Planner should mark testing adequacy as warning or failed with manual checks and coverage gaps.',
      },
    ],
    globalRisks: [],
    evidenceGaps: [reason],
  }
}

export function sanitizeScoutWorkplan(raw: unknown): OneShotScoutWorkplanSanitizationResult {
  const warnings: string[] = []
  if (isRecord(raw)) {
    const finalPlanKeys = Object.keys(raw).filter(key => FINAL_PLAN_KEYS.has(key))
    if (finalPlanKeys.length > 0) {
      return {
        workplan: createFallbackScoutWorkplan(
          `Scout workplan output looked like a final OneShot plan (${finalPlanKeys.join(', ')}).`,
        ),
        source: 'fallback',
        warnings: [
          `Rejected final-plan-shaped scout workplan output containing keys: ${finalPlanKeys.join(', ')}`,
        ],
      }
    }
  }

  const parsed = OneShotScoutWorkplanSanitizerSchema.safeParse(raw)
  if (!parsed.success) {
    return {
      workplan: createFallbackScoutWorkplan(`Scout workplan schema validation failed: ${parsed.error.message}`),
      source: 'fallback',
      warnings: [`Scout workplan schema validation failed: ${parsed.error.message}`],
    }
  }

  const scouts = parsed.data.scouts
    .slice(0, ONE_SHOT_SCOUT_WORKPLAN_MAX_SCOUTS)
    .map((scout, index) => ({
      ...scout,
      id: scout.id.trim() || `scout-${index + 1}`,
      objective: scout.objective.trim(),
      whyNeeded: scout.whyNeeded.trim(),
      startingPoints: sanitizeStringList(scout.startingPoints, 12, { pathLike: true }),
      searchTerms: sanitizeStringList(scout.searchTerms, 16),
      mustAnswer: sanitizeStringList(scout.mustAnswer, 10),
      expectedEvidence: sanitizeStringList(scout.expectedEvidence, 10),
      stopConditions: sanitizeStringList(scout.stopConditions, 8),
      fallbackIfIncomplete: scout.fallbackIfIncomplete.trim(),
    }))
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority))

  if (parsed.data.scouts.length > ONE_SHOT_SCOUT_WORKPLAN_MAX_SCOUTS) {
    warnings.push(`Clamped scout count from ${parsed.data.scouts.length} to ${ONE_SHOT_SCOUT_WORKPLAN_MAX_SCOUTS}.`)
  }

  return {
    workplan: {
      ...parsed.data,
      rationale: parsed.data.rationale.trim(),
      scouts: clampScoutBudget(scouts, warnings),
      globalRisks: sanitizeStringList(parsed.data.globalRisks, 12),
      evidenceGaps: sanitizeStringList(parsed.data.evidenceGaps, 12),
    },
    source: 'llm',
    warnings,
  }
}

export function parseOneShotScoutWorkplan(value: unknown): OneShotScoutWorkplan {
  return OneShotScoutWorkplanSchema.parse(value)
}
