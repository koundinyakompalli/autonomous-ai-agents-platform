import { describe, expect, it } from 'vitest'
import {
  parseOneShotImplementation,
  parseOneShotImplementerOutput,
} from './implementation.js'

describe('parseOneShotImplementation', () => {
  it('accepts a valid persisted implementation payload', () => {
    const implementation = parseOneShotImplementation({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      implementationBranch: 'oneshot/mpdev-123-run-42',
      implementationCommitSha: '0123456789abcdef0123456789abcdef01234567',
      prUrl: 'https://github.com/mhk-repos/cp-autonomous-ai-agents-platform/pull/42',
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: ['npm run build'],
      validationCommands: ['grep -n "queue consumer" src/oneshot/main.ts'],
      manualVerificationSteps: ['Verify the dashboard still loads in Safari.'],
      testResults: [
        {
          command: 'npm run build',
          status: 'passed',
          summary: 'Build passed.',
        },
      ],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })

    expect(implementation.implementationBranch).toContain('oneshot/')
  })

  it('accepts implementer model output before commit sha is injected', () => {
    const implementation = parseOneShotImplementerOutput({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: ['npm run build'],
      validationCommands: ['grep -n "queue consumer" src/oneshot/main.ts'],
      manualVerificationSteps: [],
      testResults: [
        {
          command: 'npm run build',
          status: 'passed',
          summary: 'Build passed.',
        },
      ],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })

    expect(implementation.completedSpecIds).toContain('SPEC-1')
  })

  it('defaults validation check scope to file', () => {
    const implementation = parseOneShotImplementerOutput({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: [],
      validationCommands: [],
      validationChecks: [{
        kind: 'must_not_match',
        pattern: 'legacyCall',
        paths: ['src/oneshot/main.ts'],
      }],
      manualVerificationSteps: [],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })

    expect(implementation.validationChecks[0].scope).toBe('file')
  })

  it('accepts changed_lines validation check scope', () => {
    const implementation = parseOneShotImplementerOutput({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: [],
      validationCommands: [],
      validationChecks: [{
        kind: 'must_not_match',
        pattern: 'legacyCall',
        paths: ['src/oneshot/main.ts'],
        scope: 'changed_lines',
      }],
      manualVerificationSteps: [],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })

    expect(implementation.validationChecks[0].scope).toBe('changed_lines')
  })

  it('preserves optional retrofit adaptation coverage from implementer output', () => {
    const implementation = parseOneShotImplementerOutput({
      summary: 'Adapted the conflicted retrofit patch.',
      completedSpecIds: ['SPEC-1'],
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: [],
      validationCommands: [],
      validationChecks: [],
      manualVerificationSteps: [],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
      retrofitAdaptationCoverage: [
        {
          sourceSha: 'abc1234',
          filesCovered: ['src/oneshot/main.ts'],
          hunkEvidence: ['Mapped the source hunk into the renamed target file.'],
          rationale: 'Target branch file names differ from the source branch.',
        },
      ],
    })

    expect(implementation.retrofitAdaptationCoverage).toEqual([
      expect.objectContaining({
        sourceSha: 'abc1234',
        filesCovered: ['src/oneshot/main.ts'],
      }),
    ])
  })

  it('preserves optional retrofit source commit statuses from implementer output', () => {
    const implementation = parseOneShotImplementerOutput({
      summary: 'Adapted the conflicted retrofit patch.',
      completedSpecIds: ['SPEC-1'],
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: [],
      validationCommands: [],
      validationChecks: [],
      manualVerificationSteps: [],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
      retrofitSourceCommitStatuses: [
        {
          sourceSha: 'abc1234',
          status: 'adapted',
          sourceFiles: ['src/Source.ts'],
          targetFiles: ['src/oneshot/main.ts'],
          adaptationFiles: [],
          proofSnippets: ['Mapped the source hunk into the target file.'],
          validationEvidence: ['must_match check covers the adapted branch.'],
          rationale: 'Target branch file names differ from the source branch.',
        },
      ],
    })

    expect(implementation.retrofitSourceCommitStatuses).toEqual([
      expect.objectContaining({
        sourceSha: 'abc1234',
        status: 'adapted',
        targetFiles: ['src/oneshot/main.ts'],
      }),
    ])
  })

  it('rejects invalid validation check scopes', () => {
    expect(() => parseOneShotImplementerOutput({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: [],
      validationCommands: [],
      validationChecks: [{
        kind: 'must_not_match',
        pattern: 'legacyCall',
        paths: ['src/oneshot/main.ts'],
        scope: 'method',
      }],
      manualVerificationSteps: [],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })).toThrow()
  })

  it('rejects invalid test result statuses', () => {
    expect(() => parseOneShotImplementation({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      implementationBranch: 'oneshot/mpdev-123-run-42',
      implementationCommitSha: '0123456789abcdef0123456789abcdef01234567',
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: ['npm run build'],
      validationCommands: [],
      manualVerificationSteps: [],
      testResults: [
        {
          command: 'npm run build',
          status: 'unknown',
          summary: 'Build passed.',
        },
      ],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })).toThrow()
  })

  it('rejects persisted payloads without an implementation commit sha', () => {
    expect(() => parseOneShotImplementation({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      implementationBranch: 'oneshot/mpdev-123-run-42',
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: ['npm run build'],
      validationCommands: [],
      manualVerificationSteps: [],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })).toThrow()
  })

  it('defaults manualVerificationSteps to an empty array for older persisted artifacts', () => {
    const implementation = parseOneShotImplementation({
      summary: 'Implemented the null-check guard and matching unit test.',
      completedSpecIds: ['SPEC-1'],
      implementationBranch: 'oneshot/mpdev-123-run-42',
      implementationCommitSha: '0123456789abcdef0123456789abcdef01234567',
      changedFiles: ['src/oneshot/main.ts'],
      testCommands: ['npm run build'],
      testResults: [],
      deviationsFromPlan: [],
      residualRisks: [],
      openFollowUps: [],
    })

    expect(implementation.manualVerificationSteps).toEqual([])
    expect(implementation.validationCommands).toEqual([])
    expect(implementation.implementedTraceTestIds).toEqual([])
  })
})
