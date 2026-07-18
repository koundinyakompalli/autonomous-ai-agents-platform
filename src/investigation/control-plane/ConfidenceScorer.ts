import type {
  InvestigationCorrelationResult,
  InvestigationFinding,
} from '../types/investigation.js'

const SEVERITY_WEIGHTS: Record<InvestigationFinding['severity'], number> = {
  critical: 1.0,
  high: 0.85,
  medium: 0.65,
  low: 0.4,
  info: 0.2,
}

export class ConfidenceScorer {
  score(findings: InvestigationFinding[]): InvestigationCorrelationResult {
    if (findings.length === 0) {
      return {
        confidence: 0,
        summary: 'No investigation findings were produced.',
        shouldEscalate: true,
        shouldProbeCode: false,
        shouldProbeData: false,
        shouldProbeHost: false,
        shouldComplete: false,
      }
    }

    const weighted = findings.reduce((total, finding) => {
      return total + (finding.confidence * SEVERITY_WEIGHTS[finding.severity])
    }, 0)
    const confidence = Math.min(1, Number((weighted / findings.length).toFixed(2)))

    const shouldProbeCode = findings.some(finding => finding.requiresCodeChange)
    const shouldProbeData = findings.some(finding => finding.requiresDataChange)
    const shouldProbeHost = findings.some(finding => finding.type.includes('host'))
    const shouldEscalate = confidence < 0.4

    return {
      confidence,
      summary: this.buildSummary(findings, confidence),
      shouldEscalate,
      shouldProbeCode,
      shouldProbeData,
      shouldProbeHost,
      shouldComplete: !shouldEscalate && confidence >= 0.75,
    }
  }

  private buildSummary(findings: InvestigationFinding[], confidence: number): string {
    const top = findings
      .slice()
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 2)
      .map(finding => `[${finding.adapter}] ${finding.title}`)

    return `Correlation confidence ${Math.round(confidence * 100)}% based on ${top.join(' and ')}.`
  }
}
