import { describe, expect, it } from 'vitest'
import { parseOneShotCodeReview } from './code-review.js'

describe('parseOneShotCodeReview', () => {
  const validApproved = {
    decision: 'APPROVED',
    score: 88,
    sageDimensions: [
      { name: 'Correctness', score: 90, weight: 0.25, notes: 'All logic correct.' },
    ],
    findings: [],
    blockingFindings: [],
    requiredChanges: [],
    nonBlockingSuggestions: ['Consider adding JSDoc.'],
    confidence: 'high',
    summary: 'Clean implementation that follows plan.',
    implementationVersion: 1,
  }

  it('accepts a valid APPROVED review', () => {
    const review = parseOneShotCodeReview(validApproved)
    expect(review.decision).toBe('APPROVED')
    expect(review.score).toBe(88)
    expect(review.sageDimensions).toHaveLength(1)
  })

  it('accepts NEEDS_CHANGES with required changes', () => {
    const review = parseOneShotCodeReview({
      ...validApproved,
      decision: 'NEEDS_CHANGES',
      score: 62,
      requiredChanges: ['Fix SQL injection in query builder.'],
      findings: [
        { severity: 'high', category: 'security', file: 'src/db.ts', description: 'Unsanitized input in query' },
      ],
    })
    expect(review.decision).toBe('NEEDS_CHANGES')
    expect(review.requiredChanges).toHaveLength(1)
  })

  it('normalizes nullable OpenAI finding fields to omitted optional fields', () => {
    const review = parseOneShotCodeReview({
      ...validApproved,
      findings: [
        {
          severity: 'low',
          category: 'maintainability',
          file: 'src/service.ts',
          line: null,
          description: 'Minor cleanup opportunity.',
          suggestion: null,
        },
      ],
    })

    expect(review.findings[0]).toEqual({
      severity: 'low',
      category: 'maintainability',
      file: 'src/service.ts',
      description: 'Minor cleanup opportunity.',
    })
  })

  it('rejects NEEDS_CHANGES without required changes', () => {
    expect(() => parseOneShotCodeReview({
      ...validApproved,
      decision: 'NEEDS_CHANGES',
      requiredChanges: [],
    })).toThrow(/requiredChanges/)
  })

  it('rejects BLOCKED without blocking findings', () => {
    expect(() => parseOneShotCodeReview({
      ...validApproved,
      decision: 'BLOCKED',
      blockingFindings: [],
    })).toThrow(/blockingFindings/)
  })

  it('rejects APPROVED with required changes', () => {
    expect(() => parseOneShotCodeReview({
      ...validApproved,
      decision: 'APPROVED',
      requiredChanges: ['Something must change.'],
    })).toThrow(/requiredChanges/)
  })

  it('validates finding severity enum', () => {
    expect(() => parseOneShotCodeReview({
      ...validApproved,
      findings: [
        { severity: 'extreme', category: 'test', file: 'x.ts', description: 'bad' },
      ],
    })).toThrow()
  })

  it('requires implementationVersion to be positive', () => {
    expect(() => parseOneShotCodeReview({
      ...validApproved,
      implementationVersion: 0,
    })).toThrow()
  })
})
