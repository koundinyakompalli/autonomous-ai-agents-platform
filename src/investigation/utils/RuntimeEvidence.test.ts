import { describe, expect, it } from 'vitest'
import {
  extractInvestigationSignals,
  extractEvidenceSearchTerms,
  extractPersistenceFailureColumns,
  redactInvestigationText,
} from './RuntimeEvidence.js'

describe('RuntimeEvidence', () => {
  it('extracts persistence failure columns without a field allowlist', () => {
    const message = "Data too long for column 'arbitrary_field' at row 1"

    expect(extractPersistenceFailureColumns(message)).toEqual(['arbitrary_field'])
    expect(extractInvestigationSignals(message)).toEqual(expect.arrayContaining([
      'arbitrary_field',
      'Data too long for column',
    ]))
  })

  it('redacts unkeyed contact details before evidence is retained', () => {
    const redacted = redactInvestigationText('contact user@example.test or 617-555-0100')

    expect(redacted).toContain('[REDACTED_EMAIL]')
    expect(redacted).toContain('[REDACTED_PHONE]')
    expect(redacted).not.toContain('user@example.test')
  })

  it('redacts labeled secrets and PHI with bounded processing on large metadata', () => {
    const input = `${'ordinary runtime metadata '.repeat(10_000)} member_id=123456789 email=user@example.test api_token=secret-value`

    const redacted = redactInvestigationText(input)

    expect(redacted).toContain('member_id=[REDACTED_PHI]')
    expect(redacted).toContain('email=[REDACTED_PHI]')
    expect(redacted).toContain('api_token=[REDACTED_SECRET]')
    expect(redacted).not.toContain('123456789')
    expect(redacted).not.toContain('user@example.test')
    expect(redacted).not.toContain('secret-value')
  })

  it('extracts deployed source filenames as adaptive repository search terms', () => {
    const terms = extractEvidenceSearchTerms([], [{
      id: 'lambda-deployment',
      adapter: 'aws',
      title: 'Lambda deployment',
      summary: 'Checksum verified.',
      contentType: 'application/json',
      metadata: {
        functions: [{ functionName: 'SAMPLE-PROD1-FUNCTION-A', artifact: { inspectedFiles: ['integration_event_filter_oob.py'] } }],
      },
    }])

    expect(terms).toContain('integration_event_filter_oob.py')
    expect(terms).toContain('SAMPLE-PROD1-FUNCTION-A')
  })
})
