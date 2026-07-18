import { z } from 'zod'

export const OneShotReviewDecisionSchema = z.enum([
  'APPROVED',
  'NEEDS_CHANGES',
  'BLOCKED',
])

export const OneShotReviewSageDimensionSchema = z.object({
  name: z.string().min(1),
  score: z.number().min(0).max(100),
  weight: z.number().min(0).max(1),
  notes: z.string().min(1),
})

export const OneShotReviewGuardrailAssessmentSchema = z.object({
  missingGuardrailIds: z.array(z.string().min(1)).default([]),
  failedGuardrailIds: z.array(z.string().min(1)).default([]),
  weakApplicabilityIds: z.array(z.string().min(1)).default([]),
  decisionImpact: z.enum(['pass', 'needs_changes', 'blocked']),
  notes: z.string().min(1),
})

export const OneShotReviewSchema = z.object({
  decision: OneShotReviewDecisionSchema,
  score: z.number().min(0).max(100).optional(),
  sageDimensions: z.array(OneShotReviewSageDimensionSchema).default([]),
  guardrailAssessment: OneShotReviewGuardrailAssessmentSchema.default({
    missingGuardrailIds: [],
    failedGuardrailIds: [],
    weakApplicabilityIds: [],
    decisionImpact: 'pass',
    notes: 'No explicit guardrail assessment was provided.',
  }),
  blockingFindings: z.array(z.string().min(1)),
  requiredChanges: z.array(z.string().min(1)),
  nonBlockingSuggestions: z.array(z.string().min(1)),
  confidence: z.enum(['low', 'medium', 'high']),
  coverageAssessment: z.string().min(1),
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

export type OneShotReview = z.infer<typeof OneShotReviewSchema>

export const ONE_SHOT_REVIEW_OUTPUT_SCHEMA = {
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
    guardrailAssessment: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        missingGuardrailIds: {
          type: 'array' as const,
          items: { type: 'string' as const },
        },
        failedGuardrailIds: {
          type: 'array' as const,
          items: { type: 'string' as const },
        },
        weakApplicabilityIds: {
          type: 'array' as const,
          items: { type: 'string' as const },
        },
        decisionImpact: {
          type: 'string' as const,
          enum: ['pass', 'needs_changes', 'blocked'],
        },
        notes: { type: 'string' as const },
      },
      required: [
        'missingGuardrailIds',
        'failedGuardrailIds',
        'weakApplicabilityIds',
        'decisionImpact',
        'notes',
      ],
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
    coverageAssessment: { type: 'string' as const },
  },
  required: [
    'decision',
    'score',
    'sageDimensions',
    'guardrailAssessment',
    'blockingFindings',
    'requiredChanges',
    'nonBlockingSuggestions',
    'confidence',
    'coverageAssessment',
  ],
}

export function parseOneShotReview(value: unknown): OneShotReview {
  return OneShotReviewSchema.parse(value)
}
