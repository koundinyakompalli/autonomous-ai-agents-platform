import { describe, expect, it } from 'vitest'
import { RcaCompletenessEvaluator, RCA_DIMENSIONS } from './RcaCompletenessEvaluator.js'
import type { InvestigationEvidenceArtifact, InvestigationFinding, InvestigationRunRecord } from '../types/investigation.js'

const run: InvestigationRunRecord = {
  id: 'inv-rca-test',
  jiraKey: 'CPSUP-1',
  title: 'Workflow request fails after release',
  scope: {
    clientId: 'CLIENT',
    environment: 'PROD_REPLICA',
    serviceIds: ['core-app'],
    releaseVersion: '3.20',
    evidenceAnchors: [{
      kind: 'case_number',
      source: 'description',
      value: 'redacted-case',
      sensitive: true,
    }],
  },
  status: 'running',
  currentStage: 'correlation',
  confidence: null,
  summary: null,
  createdAt: '2026-07-14T00:00:00.000Z',
  updatedAt: '2026-07-14T00:00:00.000Z',
}

describe('RcaCompletenessEvaluator', () => {
  it('does not confuse a ticket symptom with a complete causal RCA', () => {
    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], [])

    expect(assessment.complete).toBe(false)
    expect(assessment.diagnosisReady).toBe(false)
    expect(assessment.dimensions.find(entry => entry.dimension === 'failure')?.complete).toBe(false)
    expect(assessment.dimensions.find(entry => entry.dimension === 'impacted_scope')?.complete).toBe(false)
    expect(assessment.missingDimensions).toEqual(expect.arrayContaining([
      'unaffected_scope',
      'trigger',
      'mechanism',
      'proof',
      'recovery',
      'prevention',
    ]))
  })

  it('accepts one connected, independently referenced evidence graph', () => {
    const common = {
      chainId: 'generic-contract-mismatch',
      hypothesis: 'An input contract differs from the persisted contract.',
      confidence: 0.9,
      polarity: 'supports',
      evidenceRefs: ['runtime-evidence', 'contract-evidence'],
    }
    const runtimeEvidence: InvestigationEvidenceArtifact = {
      id: 'runtime-evidence',
      adapter: 'host',
      title: 'Runtime evidence',
      summary: 'The affected request reached the failing layer.',
      contentType: 'application/json',
      metadata: {
        rcaLinks: [{
          ...common,
          from: 'affected-request',
          relation: 'failed in',
          to: 'persistence-operation',
          dimensions: ['failure', 'impacted_scope', 'unaffected_scope'],
          summary: 'Affected and control requests delimit the failing persistence operation.',
        }],
      },
    }
    const contractEvidence: InvestigationEvidenceArtifact = {
      id: 'contract-evidence',
      adapter: 'code',
      title: 'Contract comparison',
      summary: 'The input differs from the persisted constraint.',
      contentType: 'application/json',
      metadata: {
        rcaLinks: [
          {
            ...common,
            from: 'persistence-operation',
            relation: 'writes through',
            to: 'mapped-field',
            dimensions: ['mechanism'],
            summary: 'The operation maps the input to the persisted field.',
          },
          {
            ...common,
            from: 'mapped-field',
            relation: 'rejects',
            to: 'out-of-contract-input',
            dimensions: ['trigger', 'proof'],
            summary: 'The observed input violates the verified persisted constraint.',
          },
          {
            ...common,
            from: 'out-of-contract-input',
            relation: 'is recovered by',
            to: 'validated-restoration',
            dimensions: ['recovery'],
            summary: 'A restoration action was validated.',
          },
          {
            ...common,
            from: 'validated-restoration',
            relation: 'is protected by',
            to: 'regression-control',
            dimensions: ['prevention'],
            summary: 'A recurrence control was verified.',
          },
        ],
      },
    }

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], [runtimeEvidence, contractEvidence])

    expect(assessment.complete).toBe(true)
    expect(assessment.diagnosisReady).toBe(true)
    expect(assessment.operationallyClosed).toBe(true)
    expect(assessment.score).toBe(1)
    expect(assessment.missingDimensions).toEqual([])
  })

  it('keeps a precision-required diagnosis open when the exact failing operation is missing', () => {
    const common = {
      chainId: 'precise-runtime-chain',
      hypothesis: 'A changed input caused a runtime failure.',
      evidenceRefs: ['runtime-precision', 'deployment-precision'],
      precisionRequired: true,
      causalRoles: {
        component: 'runtime-component',
        trigger: 'input changed from supported to unsupported',
        error: 'runtime exception',
        impact: 'downstream delivery stopped',
      },
    }
    const evidence: InvestigationEvidenceArtifact[] = [
      {
        id: 'runtime-precision', adapter: 'host', title: 'Runtime', summary: 'Runtime failed.', contentType: 'application/json',
        metadata: { rcaLinks: [{ ...common, from: 'input', relation: 'reached', to: 'handler', dimensions: ['trigger', 'impacted_scope', 'unaffected_scope', 'proof'], summary: 'The changed input reached the handler.' }] },
      },
      {
        id: 'deployment-precision', adapter: 'code', title: 'Deployment', summary: 'Handler inspected.', contentType: 'application/json',
        metadata: { rcaLinks: [{ ...common, from: 'handler', relation: 'failed in', to: 'runtime-error', dimensions: ['failure', 'mechanism', 'proof'], summary: 'The handler emitted the runtime error.' }] },
      },
    ]

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], evidence)

    expect(assessment.diagnosisReady).toBe(false)
    expect(assessment.precisionIncompleteChainIds).toEqual(['precise-runtime-chain'])
    expect(assessment.primaryCausalFinding?.missingRoles).toEqual(['operation'])
  })

  it('does not treat probe access failures as ticket RCA evidence', () => {
    const accessFailure: InvestigationFinding = {
      id: 'aws-access-failure',
      adapter: 'aws',
      type: 'aws_access_failure',
      severity: 'medium',
      confidence: 0.9,
      title: 'AWS evidence collection failed',
      summary: 'Authorization failed because policy monitoring denied the probe.',
      evidenceRefs: [],
      requiresCodeChange: false,
      requiresDataChange: false,
    }

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [accessFailure], [])

    expect(assessment.dimensions.find(item => item.dimension === 'failure')?.complete).toBe(false)
    expect(assessment.dimensions.find(item => item.dimension === 'mechanism')?.complete).toBe(false)
    expect(assessment.dimensions.find(item => item.dimension === 'prevention')?.complete).toBe(false)
  })

  it('correlates structured payload length, code mapping, and schema width', () => {
    const evidence: InvestigationEvidenceArtifact[] = [
      {
        id: 'code-map',
        adapter: 'code',
        title: 'Release-family code evidence',
        summary: 'Mapped persistence field discovered.',
        contentType: 'application/json',
        metadata: {
          dataFlowHints: [{
            tableName: 'request_metadata',
            columns: [{ name: 'display_label' }],
          }],
        },
      },
      {
        id: 'schema-row',
        adapter: 'data',
        title: 'Read-only schema width',
        summary: 'Schema metadata query completed.',
        contentType: 'application/json',
        metadata: {
          safeRows: [{
            source_name: 'schema_width',
            scope_key: 'request_metadata.display_label',
            observed_length: '70',
            max_length: '64',
          }],
        },
      },
    ]

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], evidence)

    expect(assessment.dimensions.find(item => item.dimension === 'mechanism')).toMatchObject({ complete: true })
    expect(assessment.dimensions.find(item => item.dimension === 'proof')?.summary).toContain('persisted maximum 64')
    expect(assessment.dimensions.find(item => item.dimension === 'trigger')).toMatchObject({ complete: true })
    expect(assessment.missingDimensions).toEqual(expect.arrayContaining(['recovery', 'prevention']))
    expect(assessment.diagnosisReady).toBe(false)
  })

  it('does not merge unrelated evidence chains to create a diagnosis', () => {
    const evidence: InvestigationEvidenceArtifact[] = RCA_DIAGNOSTIC_FIXTURES.map((fixture, index) => ({
      id: `isolated-${index}`,
      adapter: index % 2 === 0 ? 'host' : 'code',
      title: 'Isolated evidence',
      summary: fixture.summary,
      contentType: 'application/json',
      metadata: {
        rcaLinks: [{
          chainId: `unrelated-${index}`,
          hypothesis: `Unrelated hypothesis ${index}`,
          from: `node-${index}-a`,
          relation: 'relates to',
          to: `node-${index}-b`,
          dimensions: fixture.dimensions,
          summary: fixture.summary,
          evidenceRefs: [`isolated-${index}`],
        }],
      },
    }))

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], evidence)

    expect(assessment.diagnosisReady).toBe(false)
  })

  it('accepts multiple independently supported causal chains when they explain every material symptom cluster', () => {
    const evidence = [
      ...compositeEvidence('ttl-chain', 'http-504', 'batch-run', 'expired-session', 'runtime-ttl'),
      ...compositeEvidence('retry-chain', 'queue-backlog', 'retry-loop', 'backlog', 'runtime-retry'),
    ]

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], evidence)

    expect(assessment.diagnosisReady).toBe(true)
    expect(assessment.selectedHypotheses.map(item => item.chainId).sort()).toEqual([
      'retry-chain',
      'ttl-chain',
    ])
    expect(assessment.unexplainedSymptomClusterIds).toEqual([])
  })

  it('keeps the diagnosis open when one material symptom cluster is not explained', () => {
    const evidence = [
      ...compositeEvidence('ttl-chain', 'http-504', 'batch-run', 'expired-session', 'runtime-ttl'),
      {
        id: 'unexplained-runtime',
        adapter: 'host' as const,
        title: 'A separate failure cluster remains',
        summary: 'A report-rendering failure was also observed.',
        contentType: 'application/json',
        metadata: {
          symptomClusters: [{
            id: 'report-rendering',
            label: 'Report rendering failures',
            material: true,
            evidenceRefs: ['unexplained-runtime'],
            explainedByChainIds: [],
          }],
        },
      },
    ]

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], evidence)

    expect(assessment.diagnosisReady).toBe(false)
    expect(assessment.unexplainedSymptomClusterIds).toEqual(['report-rendering'])
  })

  it('proves every material persistence field through runtime, mapping, schema, and payload evidence', () => {
    const evidence: InvestigationEvidenceArtifact[] = [
      {
        id: 'runtime-save-failure',
        adapter: 'host',
        title: 'Application save failed after the integration response',
        summary: "Data too long for column 'email'; Data too long for column 'first_name'.",
        contentType: 'application/json',
        metadata: { failureColumns: ['email', 'first_name'] },
      },
      {
        id: 'release-mapper-evidence',
        adapter: 'code',
        title: 'Release-family mapper relationships',
        summary: 'The active mapper writes both returned fields to persistence models.',
        contentType: 'application/json',
        metadata: {
          dataFlowHints: [
            {
              sourceRepo: 'client-app',
              sourcePath: 'IntegrationMapper.java',
              artifactType: 'hibernate_mapping',
              tableName: 'member_address',
              columns: [{ name: 'email', propertyName: 'email' }],
            },
            {
              sourceRepo: 'client-app',
              sourcePath: 'IntegrationMapper.java',
              artifactType: 'hibernate_mapping',
              tableName: 'member_documents',
              columns: [{ name: 'first_name', propertyName: 'firstName' }],
            },
          ],
        },
      },
      {
        id: 'readonly-contract-comparison',
        adapter: 'data',
        title: 'Read-only record and schema comparison',
        summary: 'The record is valid, while both observed fields exceed their persistence constraints.',
        contentType: 'application/json',
        metadata: {
          safeRows: [
            { source_name: 'member_identifier_match', total_rows: 1 },
            { source_name: 'schema_width', scope_key: 'member_address.email', observed_length: 58, max_length: 45 },
            { source_name: 'schema_width', scope_key: 'member_documents.first_name', observed_length: 47, max_length: 45 },
          ],
        },
      },
    ]

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], evidence)

    expect(assessment.diagnosisReady).toBe(true)
    expect(assessment.unexplainedSymptomClusterIds).toEqual([])
    expect(assessment.selectedHypotheses.map(item => item.chainId).sort()).toEqual([
      'persistence-contract:member_address.email',
      'persistence-contract:member_documents.first_name',
    ])
    expect(assessment.dimensions.find(item => item.dimension === 'unaffected_scope')?.summary)
      .toContain('upstream identity exists')
  })

  it('rejects a payload overflow when multiple persistence targets remain plausible', () => {
    const evidence: InvestigationEvidenceArtifact[] = [{
      id: 'candidate-mappers',
      adapter: 'code',
      title: 'Candidate first-name mappings',
      summary: 'Two persistence models consume a first-name field.',
      contentType: 'application/json',
      metadata: {
        dataFlowHints: [
          {
            sourceRepo: 'app', sourcePath: 'MemberMapper.java', artifactType: 'hibernate_mapping',
            tableName: 'member', columns: [{ name: 'first_name', propertyName: 'firstName' }],
          },
          {
            sourceRepo: 'app', sourcePath: 'DocumentMapper.java', artifactType: 'hibernate_mapping',
            tableName: 'member_documents', columns: [{ name: 'first_name', propertyName: 'firstName' }],
          },
        ],
      },
    }, {
      id: 'candidate-widths',
      adapter: 'data',
      title: 'Candidate schema comparisons',
      summary: 'Both candidate columns are narrower than the observed payload field.',
      contentType: 'application/json',
      metadata: {
        safeRows: [
          { source_name: 'schema_width', scope_key: 'member.first_name', observed_path: 'membereligibility.aor.firstname', observed_length: 47, max_length: 45 },
          { source_name: 'schema_width', scope_key: 'member_documents.first_name', observed_path: 'membereligibility.aor.firstname', observed_length: 47, max_length: 45 },
        ],
      },
    }]

    const assessment = new RcaCompletenessEvaluator().evaluate(run, [], evidence)

    expect(assessment.diagnosisReady).toBe(false)
    expect(assessment.ambiguousSymptomClusterIds).toEqual([
      'payload-field:membereligibility.aor.firstname',
    ])
  })
})

function compositeEvidence(
  chainId: string,
  clusterId: string,
  triggerNode: string,
  failureNode: string,
  idPrefix: string,
): InvestigationEvidenceArtifact[] {
  const evidenceId = `${idPrefix}-evidence`
  const comparisonRef = `${idPrefix}-comparison`
  const common = {
    chainId,
    hypothesis: `${triggerNode} caused ${failureNode}`,
    evidenceRefs: [evidenceId, comparisonRef],
  }
  return [{
    id: evidenceId,
    adapter: 'host',
    title: `Runtime evidence for ${clusterId}`,
    summary: `A bounded runtime cluster ${clusterId} was observed.`,
    contentType: 'application/json',
    metadata: {
      symptomClusters: [{
        id: clusterId,
        label: clusterId,
        material: true,
        evidenceRefs: [evidenceId],
        explainedByChainIds: [chainId],
      }],
      rcaLinks: [
        {
          ...common,
          from: `affected:${clusterId}`,
          relation: 'reached',
          to: triggerNode,
          dimensions: ['impacted_scope'],
          summary: `The affected scope reached ${triggerNode}.`,
        },
        {
          ...common,
          from: triggerNode,
          relation: 'triggered',
          to: failureNode,
          dimensions: ['trigger', 'mechanism'],
          summary: `${triggerNode} triggered ${failureNode}.`,
        },
        {
          ...common,
          from: failureNode,
          relation: 'surfaced as',
          to: `symptom:${clusterId}`,
          dimensions: ['failure', 'proof'],
          summary: `${failureNode} surfaced as ${clusterId}.`,
        },
      ],
    },
  }, {
    id: comparisonRef,
    adapter: 'data',
    title: `Control comparison for ${clusterId}`,
    summary: 'A bounded control remained healthy.',
    contentType: 'application/json',
    metadata: {
      rcaLinks: [{
        ...common,
        from: `healthy:${clusterId}`,
        relation: 'remained healthy compared with',
        to: `affected:${clusterId}`,
        dimensions: ['unaffected_scope', 'proof'],
        summary: 'A bounded healthy control did not exhibit the same failure.',
      }],
    },
  }]
}

const RCA_DIAGNOSTIC_FIXTURES: Array<{ dimensions: (typeof RCA_DIMENSIONS)[number][]; summary: string }> = [
  { dimensions: ['failure', 'impacted_scope'], summary: 'A failure affected one bounded scope.' },
  { dimensions: ['unaffected_scope', 'proof'], summary: 'A separate control remained healthy.' },
  { dimensions: ['trigger', 'mechanism'], summary: 'A different condition caused another symptom.' },
]
