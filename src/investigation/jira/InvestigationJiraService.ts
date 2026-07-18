import type { InvestigationRunExecution } from '../control-plane/InvestigationRunner.js'

export class InvestigationJiraService {
  buildSummaryComment(execution: InvestigationRunExecution): string {
    const topFindings = execution.findings.slice(0, 3)
      .map(finding => `- [${finding.adapter.toUpperCase()}] ${finding.title}: ${finding.summary}`)
      .join('\n')

    return [
      `Investigation Summary — ${execution.run.jiraKey}`,
      '',
      `Confidence: ${Math.round(execution.correlation.confidence * 100)}%`,
      `Next step: ${execution.nextStep.reason}`,
      '',
      'Top findings:',
      topFindings || '- No findings were produced.',
      '',
      `Operator note: results are intended to be redacted and operationally bounded.`,
    ].join('\n')
  }
}
