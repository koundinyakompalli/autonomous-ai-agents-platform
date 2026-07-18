import { describe, expect, it } from 'vitest'
import { enrichScopeWithDiagnosticEvidence } from './DiagnosticScope.js'
import type { InvestigationEvidenceArtifact, InvestigationScope } from '../types/investigation.js'

describe('enrichScopeWithDiagnosticEvidence', () => {
  it('carries redacted runtime failure signals into diagnostic context', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
    }
    const evidence: InvestigationEvidenceArtifact[] = [{
      id: 'runtime-log',
      adapter: 'host',
      title: 'Application runtime logs',
      summary: 'Bounded runtime search returned a failure.',
      contentType: 'application/json',
      metadata: {
        redactedSamples: [{
          message: "Data too long for column 'contact_value' at row 1 user@example.test",
        }],
      },
    }]

    const enriched = enrichScopeWithDiagnosticEvidence(scope, [], evidence)

    expect(enriched.diagnosticContext?.runtimeFailureColumns).toEqual(['contact_value'])
    expect(enriched.diagnosticContext?.runtimeEvidencePreviews?.[0]).toContain('[REDACTED_EMAIL]')
    expect(enriched.diagnosticContext?.runtimeEvidencePreviews?.[0]).not.toContain('user@example.test')
  })

  it('promotes checksum-verified serverless handler metadata into code discovery context', () => {
    const scope: InvestigationScope = {
      clientId: 'CLIENT',
      environment: 'PROD_REPLICA',
    }
    const evidence: InvestigationEvidenceArtifact[] = [{
      id: 'serverless-deployment',
      adapter: 'aws',
      title: 'Checksum-verified Lambda deployment evidence',
      summary: 'Inspected one deployed function.',
      contentType: 'application/json',
      metadata: {
        functions: [{
          functionName: 'CLIENT-CP-PROD1-OUTBOUND-FILTER',
          handler: 'integration_event_filter_oob.lambda_handler',
          artifact: {
            checksumVerified: true,
            inspectedFiles: ['integration_event_filter_oob.py'],
            uncheckedGetReceivers: ['expected_header'],
          },
        }],
      },
    }]

    const enriched = enrichScopeWithDiagnosticEvidence(scope, [], evidence)

    expect(enriched.diagnosticContext?.codeEvidenceTerms).toEqual(expect.arrayContaining([
      'CLIENT-CP-PROD1-OUTBOUND-FILTER',
      'integration_event_filter_oob.lambda_handler',
      'integration_event_filter_oob.py',
      'expected_header',
    ]))
  })
})
