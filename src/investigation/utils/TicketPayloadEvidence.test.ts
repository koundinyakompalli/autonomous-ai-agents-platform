import { describe, expect, it } from 'vitest'
import { extractJsonPayloadEvidence, extractTicketPayloadEvidence } from './TicketPayloadEvidence.js'

describe('extractTicketPayloadEvidence', () => {
  it('retains JSON field paths and lengths without retaining values', () => {
    const evidence = extractTicketPayloadEvidence({
      source: 'jira',
      jiraKey: 'CPSUP-1',
      fetchStatus: 'fetched',
      attachments: [{
        id: 'attachment-1',
        filename: 'payload.json',
        extractionStatus: 'text_extracted',
        textExcerpt: JSON.stringify({ member: { AOR: { firstName: 'A'.repeat(47) } } }),
        contentRef: 'jira-attachment:attachment-1',
      }],
    })

    expect(evidence.fieldTerms).toEqual(expect.arrayContaining(['member', 'AOR', 'firstName']))
    expect(evidence.observedFieldLengths).toContainEqual({
      fieldName: 'firstName',
      path: 'member.AOR.firstName',
      length: 47,
      sourceRef: 'jira-attachment:attachment-1',
    })
    expect(JSON.stringify(evidence)).not.toContain('AAAA')
  })

  it('uses pre-redaction structural evidence when the stored excerpt is not parseable JSON', () => {
    const structural = extractJsonPayloadEvidence(
      JSON.stringify({ metadata: { displayLabel: 'X'.repeat(70) } }),
      'jira-attachment:payload',
    )
    const evidence = extractTicketPayloadEvidence({
      attachments: [{
        id: 'payload',
        filename: 'payload.json',
        extractionStatus: 'text_extracted',
        textExcerpt: '{"metadata":{"displayLabel"=[REDACTED]}}',
        payloadFieldTerms: structural.fieldTerms,
        observedFieldLengths: structural.observedFieldLengths,
      }],
    })

    expect(evidence.fieldTerms).toContain('displayLabel')
    expect(evidence.observedFieldLengths[0]?.length).toBe(70)
    expect(JSON.stringify(evidence)).not.toContain('XXXX')
  })
})
