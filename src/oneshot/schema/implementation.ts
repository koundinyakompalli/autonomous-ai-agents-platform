import { z } from 'zod'
import {
  RetrofitAdaptationCoverageSchema,
  RetrofitSourceCommitStatusesSchema,
} from '../retrofit-source-evidence.js'

const OneShotTestResultSchema = z.object({
  command: z.string().min(1),
  status: z.enum(['passed', 'failed', 'skipped']),
  summary: z.string().min(1),
})

const OneShotValidationCheckSchema = z.object({
  kind: z.enum(['must_match', 'must_not_match']),
  pattern: z.string().min(1).max(1000),
  paths: z.array(z.string().min(1).max(500)).min(1).max(20),
  scope: z.enum(['file', 'changed_lines']).default('file'),
})

const OneShotImplementerOutputSchema = z.object({
  summary: z.string().min(1),
  completedSpecIds: z.array(z.string().min(1)).min(1),
  implementedTraceTestIds: z.array(z.string().min(1)).default([]),
  changedFiles: z.array(z.string().min(1)),
  testCommands: z.array(z.string().min(1)),
  validationCommands: z.array(z.string().min(1)).default([]),
  validationChecks: z.array(OneShotValidationCheckSchema).default([]),
  manualVerificationSteps: z.array(z.string().min(1)).default([]),
  testResults: z.array(OneShotTestResultSchema),
  deviationsFromPlan: z.array(z.string().min(1)).default([]),
  residualRisks: z.array(z.string().min(1)).default([]),
  openFollowUps: z.array(z.string().min(1)).default([]),
  commitDiff: z.string().optional(),
  implementerDisagrees: z.boolean().optional(),
  implementerDisagreementReason: z.string().optional(),
  sessionNotes: z.string().optional(),
  retrofitAdaptationCoverage: RetrofitAdaptationCoverageSchema.optional(),
  retrofitSourceCommitStatuses: RetrofitSourceCommitStatusesSchema.optional(),
})

export const OneShotImplementationSchema = OneShotImplementerOutputSchema.extend({
  baseCommitSha: z.string().min(7).max(40).optional(),
  implementationBranch: z.string().min(1),
  implementationCommitSha: z.string().regex(/^[a-f0-9]{40}$/i),
  prUrl: z.string().url().optional(),
})

export type OneShotImplementerOutput = z.infer<typeof OneShotImplementerOutputSchema>
export type OneShotImplementation = z.infer<typeof OneShotImplementationSchema>
export type OneShotImplementationTestResult = z.infer<typeof OneShotTestResultSchema>
export type OneShotValidationCheck = z.input<typeof OneShotValidationCheckSchema>

export const ONE_SHOT_IMPLEMENTATION_OUTPUT_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    summary: { type: 'string' as const },
    completedSpecIds: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    implementedTraceTestIds: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    changedFiles: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    testCommands: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    validationCommands: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    validationChecks: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          kind: {
            type: 'string' as const,
            enum: ['must_match', 'must_not_match'],
          },
          pattern: { type: 'string' as const },
          paths: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          scope: {
            type: 'string' as const,
            enum: ['file', 'changed_lines'],
          },
        },
        required: ['kind', 'pattern', 'paths'],
      },
    },
    manualVerificationSteps: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    testResults: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          command: { type: 'string' as const },
          status: {
            type: 'string' as const,
            enum: ['passed', 'failed', 'skipped'],
          },
          summary: { type: 'string' as const },
        },
        required: ['command', 'status', 'summary'],
      },
    },
    deviationsFromPlan: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    residualRisks: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    openFollowUps: {
      type: 'array' as const,
      items: { type: 'string' as const },
    },
    implementerDisagrees: { type: 'boolean' as const },
    implementerDisagreementReason: { type: 'string' as const },
    sessionNotes: { type: 'string' as const },
    retrofitAdaptationCoverage: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          sourceSha: { type: 'string' as const },
          filesCovered: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          hunkEvidence: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          rationale: { type: 'string' as const },
        },
        required: ['sourceSha', 'filesCovered', 'hunkEvidence'],
      },
    },
    retrofitSourceCommitStatuses: {
      type: 'array' as const,
      items: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          sourceSha: { type: 'string' as const },
          status: {
            type: 'string' as const,
            enum: [
              'already_applied',
              'clean_applied',
              'adapted',
              'excluded',
              'failed',
            ],
          },
          sourceFiles: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          targetFiles: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          adaptationFiles: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          conflictDiagnostics: { type: 'string' as const },
          proofSnippets: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          validationEvidence: {
            type: 'array' as const,
            items: { type: 'string' as const },
          },
          rationale: { type: 'string' as const },
        },
        required: [
          'sourceSha',
          'status',
          'sourceFiles',
          'targetFiles',
          'adaptationFiles',
          'proofSnippets',
          'validationEvidence',
        ],
      },
    },
  },
  required: [
    'summary',
    'completedSpecIds',
    'implementedTraceTestIds',
    'changedFiles',
    'testCommands',
    'validationCommands',
    'validationChecks',
    'manualVerificationSteps',
    'testResults',
    'deviationsFromPlan',
    'residualRisks',
    'openFollowUps',
  ],
}

export function parseOneShotImplementerOutput(value: unknown): OneShotImplementerOutput {
  return OneShotImplementerOutputSchema.parse(value)
}

export function parseOneShotImplementation(value: unknown): OneShotImplementation {
  return OneShotImplementationSchema.parse(value)
}
