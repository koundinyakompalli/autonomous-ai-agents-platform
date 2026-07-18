import type { RcaCompletenessAssessment, RcaDimension } from './RcaCompletenessEvaluator.js'

export const INVESTIGATION_RESOLUTION_ACTIONS = [
  'approve_recommendation',
  'publish_final_rca',
  'request_code_fix',
  'request_data_remediation',
  'create_dba_ticket',
] as const

export type InvestigationResolutionAction = (typeof INVESTIGATION_RESOLUTION_ACTIONS)[number]

export interface InvestigationResolutionSnapshot {
  diagnosisReady: boolean
  operationallyClosed?: boolean
  missingDiagnosisDimensions: Array<RcaDimension | string>
  unexplainedSymptomClusterIds: string[]
  ambiguousSymptomClusterIds?: string[]
}

export interface InvestigationResolutionDecision {
  allowed: boolean
  reason: string
}

export function evaluateInvestigationResolutionGate(input: {
  action: InvestigationResolutionAction
  assessment: InvestigationResolutionSnapshot | RcaCompletenessAssessment | undefined
  /** Explicitly requested, governed change tickets use a change contract instead of an incident RCA. */
  plannedChange?: boolean
}): InvestigationResolutionDecision {
  if (
    input.plannedChange
    && (input.action === 'request_data_remediation' || input.action === 'create_dba_ticket')
  ) {
    return {
      allowed: true,
      reason: 'An explicit governed data-change request may enter Meridian planning; execution remains human-gated.',
    }
  }
  if (!input.assessment) {
    return {
      allowed: false,
      reason: 'No shared causal resolution assessment is attached to the investigation run.',
    }
  }
  if (!input.assessment.diagnosisReady) {
    const missing = (input.assessment.missingDiagnosisDimensions || []).join(', ') || 'none'
    const clusters = (input.assessment.unexplainedSymptomClusterIds || []).join(', ') || 'none'
    const ambiguous = (input.assessment.ambiguousSymptomClusterIds || []).join(', ') || 'none'
    return {
      allowed: false,
      reason: `Causal diagnosis is incomplete. Missing dimensions: ${missing}. Unexplained symptom clusters: ${clusters}. Ambiguous symptom clusters: ${ambiguous}.`,
    }
  }
  return {
    allowed: true,
    reason: 'The causal diagnosis and material symptom-cluster coverage passed the shared resolution gate.',
  }
}
