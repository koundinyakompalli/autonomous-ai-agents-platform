import { describe, expect, it } from 'vitest'
import { evaluateInvestigationResolutionGate } from './ResolutionGate.js'

describe('evaluateInvestigationResolutionGate', () => {
  it('blocks resolution actions when a material symptom cluster is unexplained', () => {
    const decision = evaluateInvestigationResolutionGate({
      action: 'approve_recommendation',
      assessment: {
        diagnosisReady: false,
        missingDiagnosisDimensions: [],
        unexplainedSymptomClusterIds: ['report-rendering'],
      },
    })

    expect(decision.allowed).toBe(false)
    expect(decision.reason).toContain('report-rendering')
  })

  it('allows an evidence-derived remediation only after diagnosis readiness', () => {
    const decision = evaluateInvestigationResolutionGate({
      action: 'request_code_fix',
      assessment: {
        diagnosisReady: true,
        missingDiagnosisDimensions: [],
        unexplainedSymptomClusterIds: [],
      },
    })

    expect(decision.allowed).toBe(true)
  })

  it('allows an explicit governed data-change request to enter planning without inventing an RCA', () => {
    const decision = evaluateInvestigationResolutionGate({
      action: 'request_data_remediation',
      assessment: undefined,
      plannedChange: true,
    })

    expect(decision.allowed).toBe(true)
  })

  it('allows a DBA ticket for explicit planned work but blocks an unproven incident remediation', () => {
    expect(evaluateInvestigationResolutionGate({
      action: 'create_dba_ticket',
      assessment: undefined,
      plannedChange: true,
    }).allowed).toBe(true)

    expect(evaluateInvestigationResolutionGate({
      action: 'create_dba_ticket',
      assessment: undefined,
      plannedChange: false,
    }).allowed).toBe(false)
  })
})
