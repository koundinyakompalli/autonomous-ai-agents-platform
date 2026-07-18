import { z } from 'zod'

export const CodeReviewDecisionSchema = z.enum([
  'APPROVED',
  'NEEDS_CHANGES',
  'BLOCKED',
])

export const CodeReviewFindingSchema = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  category: z.string().min(1),
  file: z.string().min(1),
  line: z.preprocess(
    value => value === null ? undefined : value,
    z.number().int().nonnegative().optional(),
  ),
  description: z.string().min(1),
  suggestion: z.preprocess(
    value => value === null ? undefined : value,
    z.string().min(1).optional(),
  ),
})

export const CodeReviewSageDimensionSchema = z.object({
  name: z.string().min(1),
  score: z.number().min(0).max(100),
  weight: z.number().min(0).max(1),
  notes: z.string().min(1),
})

export const OneShotCodeReviewSchema = z.object({
  decision: CodeReviewDecisionSchema,
  score: z.number().min(0).max(100),
  sageDimensions: z.array(CodeReviewSageDimensionSchema),
  findings: z.array(CodeReviewFindingSchema),
  blockingFindings: z.array(z.string().min(1)),
  requiredChanges: z.array(z.string().min(1)),
  nonBlockingSuggestions: z.array(z.string().min(1)),
  confidence: z.enum(['low', 'medium', 'high']),
  summary: z.string().min(1),
  implementationVersion: z.number().int().positive(),
})
  .superRefine((value, ctx) => {
    if (value.decision === 'NEEDS_CHANGES' && value.requiredChanges.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredChanges'],
        message: 'requiredChanges must be non-empty when decision is NEEDS_CHANGES',
      })
    }

    if (value.decision === 'BLOCKED' && value.blockingFindings.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['blockingFindings'],
        message: 'blockingFindings must be non-empty when decision is BLOCKED',
      })
    }

    if (value.decision === 'APPROVED' && value.requiredChanges.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requiredChanges'],
        message: 'requiredChanges must be empty when decision is APPROVED',
      })
    }
  })

export type OneShotCodeReview = z.infer<typeof OneShotCodeReviewSchema>
export type CodeReviewFinding = z.infer<typeof CodeReviewFindingSchema>
export type CodeReviewSageDimension = z.infer<typeof CodeReviewSageDimensionSchema>

export const ONE_SHOT_CODE_REVIEW_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    decision: {
      type: 'string' as const,
      enum: ['APPROVED', 'NEEDS_CHANGES', 'BLOCKED'],
    },
    score: { type: 'number' as const },
    sageDimensions: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          name: { type: 'string' as const },
          score: { type: 'number' as const },
          weight: { type: 'number' as const },
          notes: { type: 'string' as const },
        },
        required: ['name', 'score', 'weight', 'notes'],
      },
    },
    findings: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          severity: {
            type: 'string' as const,
            enum: ['critical', 'high', 'medium', 'low'],
          },
          category: { type: 'string' as const },
          file: { type: 'string' as const },
          line: { type: ['number', 'null'] as const },
          description: { type: 'string' as const },
          suggestion: { type: ['string', 'null'] as const },
        },
        required: ['severity', 'category', 'file', 'line', 'description', 'suggestion'],
      },
    },
    blockingFindings: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    requiredChanges: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    nonBlockingSuggestions: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    confidence: {
      type: 'string' as const,
      enum: ['low', 'medium', 'high'],
    },
    summary: { type: 'string' as const },
    implementationVersion: { type: 'number' as const },
  },
  required: [
    'decision',
    'score',
    'sageDimensions',
    'findings',
    'blockingFindings',
    'requiredChanges',
    'nonBlockingSuggestions',
    'confidence',
    'summary',
    'implementationVersion',
  ],
}

export function parseOneShotCodeReview(value: unknown): OneShotCodeReview {
  return OneShotCodeReviewSchema.parse(value)
}
