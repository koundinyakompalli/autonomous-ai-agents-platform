import type {
  InvestigationCorrelationResult,
  InvestigationRunStatus,
  InvestigationStage,
} from '../types/investigation.js'

export interface InvestigationNextStep {
  status: InvestigationRunStatus
  stage: InvestigationStage
  reason: string
}

export class EscalationPolicy {
  decide(result: InvestigationCorrelationResult): InvestigationNextStep {
    if (result.shouldEscalate) {
      return {
        status: 'escalated',
        stage: 'summary',
        reason: 'Confidence below escalation floor after correlation.',
      }
    }

    if (result.shouldComplete) {
      return {
        status: 'awaiting_review',
        stage: 'summary',
        reason: 'Evidence is strong enough for an operator-ready summary.',
      }
    }

    if (result.shouldProbeCode) {
      return {
        status: 'running',
        stage: 'code_probe',
        reason: 'Findings indicate a likely code path or defect signal.',
      }
    }

    if (result.shouldProbeData) {
      return {
        status: 'running',
        stage: 'data_probe',
        reason: 'Findings indicate a likely data or configuration signal.',
      }
    }

    if (result.shouldProbeHost) {
      return {
        status: 'running',
        stage: 'host_probe',
        reason: 'Findings indicate a likely host/runtime inspection need.',
      }
    }

    return {
      status: 'awaiting_review',
      stage: 'summary',
      reason: 'No deeper probe is needed based on current evidence.',
    }
  }
}
