import { describe, expect, it } from 'vitest'
import { parseOneShotReview } from './review.js'

describe('parseOneShotReview', () => {
  it('accepts approved reviews without required changes', () => {
    const review = parseOneShotReview({
      decision: 'APPROVED',
      blockingFindings: [],
      requiredChanges: [],
      nonBlockingSuggestions: ['Consider renaming helper for clarity.'],
      confidence: 'high',
      coverageAssessment: 'The plan covers the requested scope.',
    })

    expect(review.decision).toBe('APPROVED')
  })

  it('rejects NEEDS_CHANGES without requiredChanges', () => {
    expect(() => parseOneShotReview({
      decision: 'NEEDS_CHANGES',
      blockingFindings: [],
      requiredChanges: [],
      nonBlockingSuggestions: [],
      confidence: 'medium',
      coverageAssessment: 'The plan missed a migration step.',
    })).toThrow(/requiredChanges/)
  })

  it('rejects BLOCKED without blocking findings', () => {
    expect(() => parseOneShotReview({
      decision: 'BLOCKED',
      blockingFindings: [],
      requiredChanges: [],
      nonBlockingSuggestions: [],
      confidence: 'high',
      coverageAssessment: 'The plan attempts multi-repo work in v1.',
    })).toThrow(/blockingFindings/)
  })

  it('accepts optional score and sageDimensions', () => {
    const review = parseOneShotReview({
      decision: 'APPROVED',
      score: 92,
      sageDimensions: [
        { name: 'Completeness', score: 95, weight: 0.25, notes: 'All criteria covered.' },
        { name: 'Architecture', score: 88, weight: 0.20, notes: 'Follows existing patterns.' },
      ],
      blockingFindings: [],
      requiredChanges: [],
      nonBlockingSuggestions: [],
      confidence: 'high',
      coverageAssessment: 'Comprehensive plan.',
    })

    expect(review.score).toBe(92)
    expect(review.sageDimensions).toHaveLength(2)
    expect(review.sageDimensions[0].name).toBe('Completeness')
  })

  it('defaults sageDimensions to empty array when omitted', () => {
    const review = parseOneShotReview({
      decision: 'APPROVED',
      blockingFindings: [],
      requiredChanges: [],
      nonBlockingSuggestions: [],
      confidence: 'high',
      coverageAssessment: 'Basic plan review.',
    })

    expect(review.sageDimensions).toEqual([])
    expect(review.score).toBeUndefined()
  })
})
