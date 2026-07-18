import { describe, expect, it } from 'vitest'
import { buildEvidenceLedger } from './EvidenceLedger.js'
import type { InvestigationEvidenceArtifact, InvestigationRunRecord } from '../types/investigation.js'

const run: InvestigationRunRecord = {
  id: 'inv-ledger',
  jiraKey: 'SUP-1',
  title: 'Generic persistence failure',
  scope: {
    clientId: 'CLIENT',
    environment: 'PROD_REPLICA',
    serviceIds: ['application'],
    releaseVersion: '3.20',
    planningContext: {
      activeProbeId: 'host-failing-stage',
      activeProbeIntent: 'identify_failing_stage',
    },
  },
  status: 'running',
  currentStage: 'correlation',
  confidence: null,
  summary: null,
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:05:00.000Z',
}

describe('buildEvidenceLedger', () => {
  it('retains normalized fact provenance without retaining raw sensitive values', () => {
    const evidence: InvestigationEvidenceArtifact = {
      id: 'runtime-evidence',
      adapter: 'host',
      title: 'Runtime evidence',
      summary: 'A redacted runtime failure was observed.',
      contentType: 'application/json',
      metadata: {
        evidenceFacts: [{
          type: 'runtime_failure',
          subject: 'application-save',
          predicate: 'failed in',
          object: 'persistence-stage',
          confidence: 0.93,
          redactionState: 'redacted',
          sourceRef: 'approved-host-log:42',
        }],
      },
    }

    const ledger = buildEvidenceLedger(run, [], [evidence])

    expect(ledger.facts[0]).toMatchObject({
      type: 'runtime_failure',
      confidence: 0.93,
      provenance: {
        adapter: 'host',
        probeId: 'host-failing-stage',
        clientId: 'CLIENT',
        environment: 'PROD_REPLICA',
        releaseVersion: '3.20',
        sourceRef: 'approved-host-log:42',
        redactionState: 'redacted',
      },
    })
  })

  it('turns runtime truncation columns into material clusters linked to matching persistence chains', () => {
    const evidence: InvestigationEvidenceArtifact[] = [
      {
        id: 'runtime',
        adapter: 'host',
        title: 'Runtime save error',
        summary: "Data too long for column 'first_name'.",
        contentType: 'application/json',
      },
      {
        id: 'mapping',
        adapter: 'code',
        title: 'Verified mapper relationship',
        summary: 'The mapper writes the source property to the persisted field.',
        contentType: 'application/json',
        metadata: {
          dataFlowHints: [{
            sourceRepo: 'client-services',
            sourcePath: 'MemberMapper.java',
            artifactType: 'hibernate_mapping',
            tableName: 'member_documents',
            columns: [{ name: 'first_name', propertyName: 'firstName' }],
          }],
        },
      },
      {
        id: 'schema',
        adapter: 'data',
        title: 'Schema comparison',
        summary: 'Read-only schema metadata.',
        contentType: 'application/json',
        metadata: {
          safeRows: [{
            source_name: 'schema_width',
            scope_key: 'member_documents.first_name',
            max_length: 45,
            observed_length: 47,
          }],
        },
      },
    ]

    const ledger = buildEvidenceLedger(run, [], evidence)

    expect(ledger.symptomClusters).toEqual([expect.objectContaining({
      id: 'persistence-column:first_name',
      material: true,
      explainedByChainIds: ['persistence-contract:member_documents.first_name'],
    })])
  })
})
