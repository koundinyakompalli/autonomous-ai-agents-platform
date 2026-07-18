import { describe, expect, it } from 'vitest'
import { InvestigationRunner } from './InvestigationRunner.js'
import type { RcaCompletenessEvaluator } from './RcaCompletenessEvaluator.js'
import type { InvestigationPlanningAdvisor } from './InvestigationPlanning.js'
import type { InvestigationAdapter, InvestigationAdapterRegistry } from '../adapters/types.js'
import type {
  InvestigationAdapterRequest,
  InvestigationAdapterResult,
  InvestigationRunRecord,
} from '../types/investigation.js'

class FakeAdapter implements InvestigationAdapter {
  readonly requests: InvestigationAdapterRequest[] = []

  constructor(
    readonly kind: InvestigationAdapter['kind'],
    private readonly result: InvestigationAdapterResult,
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    this.requests.push(request)
    return this.result
  }
}

function emptyResult(): InvestigationAdapterResult {
  return {
    findings: [],
    evidence: [],
    telemetry: {
      durationMs: 0,
      requestsIssued: 0,
    },
  }
}

const run: InvestigationRunRecord = {
  id: 'inv-runner-test',
  jiraKey: 'CPCLIENT-1',
  title: 'API returns 500',
  scope: {
    clientId: 'PERFORMRX',
    environment: 'UAT',
    serviceIds: ['core-app'],
    repoNames: ['core-app'],
    keywords: ['api failure'],
  },
  status: 'running',
  currentStage: 'aws_triage',
  confidence: null,
  summary: null,
  createdAt: '2026-06-18T00:00:00.000Z',
  updatedAt: '2026-06-18T00:00:00.000Z',
}

describe('InvestigationRunner evidence-driven scope enrichment', () => {
  it('assigns the serverless evidence budget to a missing-delivery ticket without AWS product keywords', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { maxPlanningIterations: 0, adapterTimeoutMs: 30_000 },
    )

    await runner.execute({
      ...run,
      title: 'Partner is not receiving any requests from the application',
      scope: { ...run.scope, keywords: [] },
    })

    expect(aws.requests[0]?.constraints.timeoutMs).toBe(90_000)
  })

  it('routes an explicit planned data change without executing incident adapters', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const runner = new InvestigationRunner({ aws, code, data, host } as InvestigationAdapterRegistry)

    const result = await runner.execute({
      ...run,
      scope: { ...run.scope, workflowType: 'planned_data_change' },
    })

    expect(result.nextStep).toMatchObject({ status: 'awaiting_review', stage: 'summary' })
    expect(result.run.summary).toContain('bypassed incident evidence probes')
    expect(aws.requests).toHaveLength(0)
    expect(code.requests).toHaveLength(0)
    expect(data.requests).toHaveLength(0)
    expect(host.requests).toHaveLength(0)
  })

  it('appends deterministic runnable probes when LLM advice is empty', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: [],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: [],
        evidenceGoals: [],
        searchHints: [],
        expectedComparison: [],
        acceptanceCriteria: [],
        rationale: 'No probe proposed.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 1 },
    )

    const result = await runner.execute(run)

    expect(code.requests).toHaveLength(1)
    expect(result.planningTrace[0]).toMatchObject({
      selectedProbeId: 'code-release-correlation',
      selectedAdapter: 'code',
      outcome: 'executed',
    })
    expect(result.planningTrace[0]?.advice.rationale).toContain('Deterministic authority appended')
  })

  it('gates an incomplete RCA when automated planning is disabled', async () => {
    const aws = new FakeAdapter('aws', {
      findings: [{
        id: 'neutral-code-signal',
        adapter: 'aws',
        type: 'runtime_failure',
        severity: 'medium',
        confidence: 0.8,
        title: 'Runtime operation failed',
        summary: 'A bounded runtime failure requires code inspection.',
        evidenceRefs: [],
        requiresCodeChange: true,
        requiresDataChange: false,
      }],
      evidence: [],
      telemetry: { durationMs: 1, requestsIssued: 1 },
    })
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { maxPlanningIterations: 0 },
    )

    const result = await runner.execute(run)

    expect(code.requests).toHaveLength(0)
    expect(result.rcaAssessment.complete).toBe(false)
    expect(result.nextStep).toMatchObject({ status: 'awaiting_review', stage: 'summary' })
    expect(result.nextStep.reason).toContain('No automated remediation is permitted')
  })

  it('passes CloudWatch runtime signals into downstream code, host, and data probes', async () => {
    const aws = new FakeAdapter('aws', {
      findings: [{
        id: 'inv-runner-test-aws-runtime',
        adapter: 'aws',
        type: 'runtime_log_error_evidence',
        severity: 'medium',
        confidence: 0.72,
        title: 'Runtime log evidence requires code/config follow-up',
        summary: 'CloudWatch found ApiClientException and api.endpoint.url with 500 status.',
        evidenceRefs: ['inv-runner-test-aws-cloudwatch'],
        requiresCodeChange: true,
        requiresDataChange: true,
        metadata: {
          runtimeSignals: ['ApiClientException', 'api.endpoint.url', '500'],
        },
      }],
      evidence: [{
        id: 'inv-runner-test-aws-cloudwatch',
        adapter: 'aws',
        title: 'Approved CloudWatch log sources',
        summary: 'Captured redacted runtime samples.',
        contentType: 'application/json',
        metadata: {
          runtimeSignals: ['ApiClientException', 'api.endpoint.url', '500'],
        },
      }],
      telemetry: {
        durationMs: 1,
        requestsIssued: 1,
      },
    })
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const runner = new InvestigationRunner({ aws, code, data, host } as InvestigationAdapterRegistry)

    const result = await runner.execute(run)

    expect(code.requests[0]?.scope.keywords).toEqual(expect.arrayContaining([
      'ApiClientException',
      'api.endpoint.url',
      '500',
    ]))
    expect(host.requests[0]?.scope.keywords).toEqual(expect.arrayContaining([
      'ApiClientException',
      'api.endpoint.url',
    ]))
    expect(data.requests[0]?.scope.keywords).toEqual(expect.arrayContaining([
      'api.endpoint.url',
    ]))
    expect(result.run.status).toBe('awaiting_review')
    expect(result.run.currentStage).toBe('summary')
    expect(result.nextStep.reason).toContain('Diagnosis is not ready')
  })

  it('passes code-derived data-flow hints into the downstream data probe', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const code = new FakeAdapter('code', {
      findings: [{
        id: 'inv-runner-test-code-candidates',
        adapter: 'code',
        type: 'code_path_candidates',
        severity: 'medium',
        confidence: 0.74,
        title: 'Code Agent found file-level candidate evidence',
        summary: 'QueueAuthorization and process_flow are relevant.',
        evidenceRefs: ['inv-runner-test-code-evidence'],
        requiresCodeChange: true,
        requiresDataChange: false,
      }],
      evidence: [{
        id: 'inv-runner-test-code-evidence',
        adapter: 'code',
        title: 'Code Agent strict validation scan',
        summary: 'Found routing code evidence.',
        contentType: 'application/json',
        metadata: {
          terms: ['QueueAuthorization', 'process_flow'],
          dataFlowHints: [
            {
              sourceRepo: 'core-app',
              sourcePath: 'BPMSharedService.java',
              artifactType: 'hql_literal',
              tableName: 'queue_authorization',
            },
          ],
          hits: [
            {
              path: 'BPMSharedService.java',
              term: 'QueueAuthorization',
              preview: 'select model from QueueAuthorization as model',
            },
          ],
        },
      }],
      telemetry: {
        durationMs: 1,
        requestsIssued: 1,
      },
    })
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const runner = new InvestigationRunner({ aws, code, data, host } as InvestigationAdapterRegistry)

    await runner.execute(run)

    expect(data.requests[0]?.scope.diagnosticContext?.codeEvidenceTerms).toEqual(expect.arrayContaining([
      'QueueAuthorization',
      'process_flow',
    ]))
    expect(data.requests[0]?.scope.diagnosticContext?.dataFlowHints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        tableName: 'queue_authorization',
        sourcePath: 'BPMSharedService.java',
      }),
    ]))
  })

  it('reruns an allowlisted probe when later evidence changes its scope', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', {
      findings: [{
        id: 'data-schema-width',
        adapter: 'data',
        type: 'database_schema_comparison',
        severity: 'medium',
        confidence: 0.8,
        title: 'Schema width comparison found a mismatch',
        summary: 'member_documents.first_name payload length exceeds schema width.',
        evidenceRefs: ['data-schema-width-evidence'],
        requiresCodeChange: true,
        requiresDataChange: false,
      }],
      evidence: [{
        id: 'data-schema-width-evidence',
        adapter: 'data',
        title: 'Read-only schema width comparison',
        summary: 'member_documents.first_name payload length exceeds schema width.',
        contentType: 'application/json',
      }],
      telemetry: { durationMs: 1, requestsIssued: 1 },
    })
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['code', 'data'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: [
          input.iteration === 2
            ? 'data-readonly-comparison'
            : 'code-release-correlation',
        ],
        evidenceGoals: [],
        searchHints: [],
        expectedComparison: [],
        acceptanceCriteria: [],
        rationale: input.iteration === 3
          ? 'The schema comparison introduced a new code-search anchor.'
          : 'Collect the next bounded evidence layer.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 3 },
    )

    const result = await runner.execute(run)

    expect(code.requests).toHaveLength(2)
    expect(code.requests[1]?.scope.keywords).toEqual(expect.arrayContaining([
      'member_documents.first_name',
    ]))
    expect(code.requests[1]?.scope.planningContext).toMatchObject({
      activeProbeId: 'code-release-correlation',
      workflowType: 'support_investigation',
      planningIteration: 3,
    })
    expect(result.planningTrace[2]).toMatchObject({
      selectedProbeId: 'code-release-correlation',
      selectedAdapter: 'code',
      outcome: 'executed',
    })
    expect(result.rcaAssessment.complete).toBe(false)
    expect(result.nextStep.reason).toContain('Diagnosis is not ready')
  })

  it('retries a no-evidence probe after another adapter enriches its diagnostic scope', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const code = new FakeAdapter('code', {
      findings: [],
      evidence: [{
        id: 'code-workflow-state',
        adapter: 'code',
        title: 'Code-derived workflow state mapping',
        summary: 'Mapped the runtime state to a persisted workflow column.',
        contentType: 'application/json',
        metadata: {
          dataFlowHints: [{
            sourceRepo: 'core-app',
            sourcePath: 'WorkflowMapper.java',
            artifactType: 'schema_mapping',
            tableName: 'workflow_events',
            columnName: 'state',
          }],
        },
      }],
      telemetry: { durationMs: 1, requestsIssued: 1 },
    })
    let dataAttempt = 0
    const data: InvestigationAdapter = {
      kind: 'data',
      execute: async () => {
        dataAttempt += 1
        return dataAttempt === 1
          ? emptyResult()
          : {
              findings: [],
              evidence: [{
                id: 'data-workflow-state',
                adapter: 'data',
                title: 'Read-only workflow state comparison',
                summary: 'Compared the mapped workflow state without modifying data.',
                contentType: 'application/json',
              }],
              telemetry: { durationMs: 1, requestsIssued: 1 },
            }
      },
    }
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: input.iteration === 1 ? 'llm' : 'deterministic',
        workflowType: 'support_investigation',
        causeHypotheses: ['workflow', 'data'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: [
          input.iteration === 2
            ? 'code-release-correlation'
            : 'data-readonly-comparison',
        ],
        rationale: 'Collect the next bounded evidence layer.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 3 },
    )

    const result = await runner.execute(run)

    expect(dataAttempt).toBe(2)
    expect(result.planningTrace.map(entry => entry.selectedAdapter)).toEqual([
      'data',
      'code',
      'data',
    ])
    expect(result.evidence.some(item => item.id === 'data-workflow-state')).toBe(true)
  })

  it('counts empty probe attempts against the adapter execution budget', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    let codeAttempt = 0
    const code: InvestigationAdapter = {
      kind: 'code',
      execute: async () => {
        codeAttempt += 1
        return {
          findings: [],
          evidence: [{
            id: `neutral-code-evidence-${codeAttempt}`,
            adapter: 'code',
            title: 'Code evidence introduced a bounded search term',
            summary: `NeutralSearchTerm${codeAttempt}`,
            contentType: 'application/json',
            metadata: { terms: [`NeutralSearchTerm${codeAttempt}`] },
          }],
          telemetry: { durationMs: 1, requestsIssued: 1 },
        }
      },
    }
    const data = new FakeAdapter('data', emptyResult())
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['code', 'data'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: [input.iteration % 2 === 1
          ? 'data-readonly-comparison'
          : 'code-release-correlation'],
        evidenceGoals: [],
        searchHints: [],
        expectedComparison: [],
        acceptanceCriteria: [],
        rationale: 'Alternate bounded evidence adapters.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 6 },
    )

    await runner.execute(run)

    expect(data.requests).toHaveLength(2)
  })

  it('retains partial adapter evidence when a later probe exceeds the wall budget', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const code: InvestigationAdapter = {
      kind: 'code',
      execute: async request => {
        request.onPartialResult?.({
          findings: [],
          evidence: [{
            id: 'completed-code-slice',
            adapter: 'code',
            title: 'Completed repository slice',
            summary: 'A bounded repository finished before another repository timed out.',
            contentType: 'application/json',
          }],
          telemetry: { durationMs: 10, requestsIssued: 1 },
        })
        return await new Promise<InvestigationAdapterResult>(() => undefined)
      },
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { maxPlanningIterations: 1, adapterTimeoutMs: 100 },
    )

    const result = await runner.execute(run)

    expect(result.evidence.map(item => item.id)).toContain('completed-code-slice')
    expect(result.findings.map(item => item.type)).toContain('code_probe_failure')
  })

  it('keeps the latest evidence snapshot when an adaptive probe reuses a stable artifact id', async () => {
    let attempt = 0
    const aws: InvestigationAdapter = {
      kind: 'aws',
      execute: async () => {
        attempt += 1
        return {
          findings: [],
          evidence: [{
            id: 'stable-runtime-evidence',
            adapter: 'aws',
            title: 'Runtime evidence',
            summary: attempt === 1 ? 'Initial bounded snapshot.' : 'Continuation snapshot with contract transition.',
            contentType: 'application/json',
            metadata: attempt === 1
              ? { symptomClusters: [{ id: 'serverless-runtime:filter', label: 'Filter failure', material: true, evidenceRefs: ['stable-runtime-evidence'], explainedByChainIds: [] }] }
              : { evidenceFacts: [{ id: 'transition', type: 'change', subject: 'resourceType', predicate: 'changed', value: 'ContractV2', provenance: { environment: 'UAT', sourceRef: 'stable-runtime-evidence', confidence: 0.9, redactionState: 'redacted', probeId: 'aws-serverless-integration-trace' } }] },
          }],
          telemetry: { durationMs: 1, requestsIssued: 1 },
        }
      },
    }
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['integration'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: ['aws-serverless-integration-trace'],
        evidenceGoals: ['Complete the contract comparison.'],
        searchHints: ['payload contract'],
        expectedComparison: ['Compare control and incident payloads.'],
        acceptanceCriteria: ['Retain the continuation evidence.'],
        rationale: 'Continue the bounded serverless probe.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 1 },
    )

    const result = await runner.execute({
      ...run,
      title: 'Subscriber is not receiving messages',
      scope: { ...run.scope, keywords: ['lambda', 'message'] },
    })

    expect(attempt).toBe(2)
    expect(result.evidence.find(item => item.id === 'stable-runtime-evidence')?.summary)
      .toBe('Continuation snapshot with contract transition.')
  })

  it('allows a distinct probe on an adapter after its initial scope probe times out', async () => {
    let awsAttempt = 0
    const aws: InvestigationAdapter = {
      kind: 'aws',
      execute: async request => {
        awsAttempt += 1
        if (awsAttempt === 1) {
          return await new Promise<InvestigationAdapterResult>(() => undefined)
        }
        return {
          findings: [],
          evidence: [{
            id: 'serverless-route-evidence',
            adapter: 'aws',
            title: 'Serverless message route',
            summary: 'Traced the bounded queue and Lambda route after generic scope discovery timed out.',
            contentType: 'application/json',
          }],
          telemetry: { durationMs: 1, requestsIssued: 1 },
        }
      },
    }
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['integration'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: ['aws-serverless-integration-trace'],
        evidenceGoals: ['Trace the message route.'],
        searchHints: ['queue', 'lambda'],
        expectedComparison: ['Compare the last successful message with the first failed message.'],
        acceptanceCriteria: ['The failing transition is supported by AWS evidence.'],
        rationale: 'The initial AWS scope timeout must not suppress a distinct serverless probe.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 2, adapterTimeoutMs: 100 },
    )

    const result = await runner.execute(run)

    expect(awsAttempt).toBe(2)
    expect(result.planningTrace.filter(entry => entry.selectedProbeId === 'aws-serverless-integration-trace')).toHaveLength(1)
    expect(result.planningTrace[0]).toMatchObject({
      selectedProbeId: 'aws-serverless-integration-trace',
      selectedAdapter: 'aws',
    })
    expect(result.evidence.map(item => item.id)).toContain('serverless-route-evidence')
  })

  it('does not replace an explicit batch file-flow investigation with speculative serverless discovery', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['runtime_environment', 'integration'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: ['aws-serverless-integration-trace', 'host-failing-stage'],
        evidenceGoals: ['Identify the failing file-polling stage.'],
        searchHints: ['inbound folders', 'scheduled poller'],
        expectedComparison: ['Compare folders that are collected with folders that are not collected.'],
        acceptanceCriteria: ['The executing batch stage and failure boundary are supported by runtime evidence.'],
        rationale: 'Test that deterministic eligibility constrains an over-broad model proposal.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 1 },
    )

    const result = await runner.execute({
      ...run,
      title: 'Scheduled job is not pulling files from three subfolders',
      scope: {
        ...run.scope,
        serviceIds: ['inbound-document-batch'],
        keywords: ['folder polling', 'file ingestion'],
      },
    })

    expect(aws.requests).toHaveLength(1)
    expect(host.requests).toHaveLength(1)
    expect(result.planningTrace[0]).toMatchObject({
      selectedProbeId: 'host-failing-stage',
      selectedAdapter: 'host',
    })
  })

  it('does not repeat a completed serverless trace or fan out to unmanaged host probes', async () => {
    const aws = new FakeAdapter('aws', {
      findings: [{
        id: 'serverless-route-finding',
        adapter: 'aws',
        type: 'serverless_message_route_traced',
        severity: 'high',
        confidence: 0.9,
        title: 'AWS messaging and serverless execution path traced',
        summary: 'A queue-to-Lambda route contains a bounded runtime failure.',
        evidenceRefs: ['serverless-route-evidence'],
        requiresCodeChange: true,
        requiresDataChange: false,
      }],
      evidence: [{
        id: 'serverless-route-evidence',
        adapter: 'aws',
        title: 'AWS integration topology evidence',
        summary: 'Traced the managed queue and Lambda route.',
        contentType: 'application/json',
        metadata: { topology: { nodes: [], edges: [] } },
      }],
      telemetry: { durationMs: 1, requestsIssued: 1 },
    })
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['integration'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: ['host-runtime-evidence', 'aws-serverless-integration-trace'],
        evidenceGoals: ['Find the managed integration failure mechanism.'],
        searchHints: ['lambda', 'payload contract'],
        expectedComparison: ['Compare the last successful and first failed payload contracts.'],
        acceptanceCriteria: ['The Lambda mechanism is linked to AWS and code evidence.'],
        rationale: 'Request managed integration follow-up.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 1 },
    )

    const result = await runner.execute({
      ...run,
      title: 'External requests stopped at the subscriber Lambda',
      scope: {
        ...run.scope,
        serviceIds: ['event-publishing-service'],
        keywords: ['queue', 'lambda', 'external request'],
      },
    })

    expect(aws.requests).toHaveLength(1)
    expect(host.requests).toHaveLength(0)
    expect(code.requests).toHaveLength(1)
    expect(result.planningTrace[0]).toMatchObject({
      selectedProbeId: 'code-release-correlation',
      selectedAdapter: 'code',
    })
  })

  it('continues from causal diagnosis into bounded code prevention evidence', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    let codeCompleted = false
    const code: InvestigationAdapter = {
      kind: 'code',
      execute: async () => {
        codeCompleted = true
        return emptyResult()
      },
    }
    const completenessEvaluator = {
      evaluate: () => ({
        complete: codeCompleted,
        diagnosisReady: true,
        operationallyClosed: codeCompleted,
        score: codeCompleted ? 1 : 0.75,
        dimensions: [],
        missingDimensions: codeCompleted ? [] : ['prevention'],
        missingDiagnosisDimensions: [],
        missingClosureDimensions: codeCompleted ? [] : ['prevention'],
        selectedHypotheses: [],
        hypotheses: [],
        symptomClusters: [],
        unexplainedSymptomClusterIds: [],
        ambiguousSymptomClusterIds: [],
        causalFindings: [],
        precisionIncompleteChainIds: [],
        summary: codeCompleted ? 'Operational closure is supported.' : 'Causal diagnosis is supported; prevention remains open.',
      }),
    } as RcaCompletenessEvaluator
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['code'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: ['code-release-correlation'],
        evidenceGoals: ['Trace the runtime handler into release source and prevention coverage.'],
        searchHints: ['deployed handler'],
        expectedComparison: ['Compare incident release code with the compatible implementation.'],
        acceptanceCriteria: ['The proposed prevention is tied to file and line evidence.'],
        rationale: 'Diagnosis is ready, but prevention still requires code evidence.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, completenessEvaluator, maxPlanningIterations: 1 },
    )

    const result = await runner.execute({
      ...run,
      title: 'Managed function rejected an incompatible event contract',
      scope: { ...run.scope, keywords: ['lambda', 'handler'] },
    })

    expect(codeCompleted).toBe(true)
    expect(result.planningTrace[0]).toMatchObject({
      selectedProbeId: 'code-release-correlation',
      selectedAdapter: 'code',
      outcome: 'complete',
    })
  })

  it('allows one bounded serverless continuation for an unexplained runtime cluster', async () => {
    const aws = new FakeAdapter('aws', {
      findings: [{
        id: 'serverless-route-finding',
        adapter: 'aws',
        type: 'serverless_message_route_traced',
        severity: 'high',
        confidence: 0.9,
        title: 'AWS messaging and serverless execution path traced',
        summary: 'A Lambda runtime failure remains unexplained after the first bounded pass.',
        evidenceRefs: ['serverless-route-evidence'],
        requiresCodeChange: true,
        requiresDataChange: false,
      }, {
        id: 'serverless-limit',
        adapter: 'aws',
        type: 'serverless_evidence_limitation',
        severity: 'medium',
        confidence: 0.5,
        title: 'Some AWS serverless evidence could not be collected',
        summary: 'The pre/post contract window needs one continuation pass.',
        evidenceRefs: ['serverless-route-evidence'],
        requiresCodeChange: false,
        requiresDataChange: false,
      }],
      evidence: [{
        id: 'serverless-route-evidence',
        adapter: 'aws',
        title: 'Lambda runtime evidence',
        summary: 'The filter function emitted an incident failure.',
        contentType: 'application/json',
        metadata: {
          functions: [{ functionName: 'CLIENT-FILTER', handler: 'event_filter.lambda_handler' }],
          symptomClusters: [{
            id: 'serverless-runtime:client-filter',
            label: 'Filter runtime failure',
            material: true,
            evidenceRefs: ['serverless-route-evidence'],
            explainedByChainIds: [],
          }],
        },
      }],
      telemetry: { durationMs: 1, requestsIssued: 1 },
    })
    const code = new FakeAdapter('code', emptyResult())
    const data = new FakeAdapter('data', emptyResult())
    const host = new FakeAdapter('host', emptyResult())
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm',
        workflowType: 'support_investigation',
        causeHypotheses: ['integration'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: ['aws-serverless-integration-trace'],
        evidenceGoals: ['Complete the pre/post message contract comparison.'],
        searchHints: ['payload contract', 'filter predicate'],
        expectedComparison: ['Compare the last accepted message with the first rejected message.'],
        acceptanceCriteria: ['The runtime failure is linked to a bounded contract transition.'],
        rationale: 'The first pass found a material but unexplained Lambda failure.',
      }),
    }
    const runner = new InvestigationRunner(
      { aws, code, data, host } as InvestigationAdapterRegistry,
      { planningAdvisor: advisor, maxPlanningIterations: 1 },
    )

    await runner.execute({
      ...run,
      title: 'External requests stopped at the subscriber Lambda',
      scope: { ...run.scope, keywords: ['lambda', 'message'] },
    })

    expect(aws.requests).toHaveLength(2)
  })

  it('does not rerun a probe when only evidence-derived scope context changes', async () => {
    const aws = new FakeAdapter('aws', emptyResult())
    let codeAttempts = 0
    const code: InvestigationAdapter = {
      kind: 'code',
      execute: async () => {
        codeAttempts += 1
        return {
          findings: [],
          evidence: [{
            id: `code-evidence-${codeAttempts}`,
            adapter: 'code',
            title: 'Code evidence',
            summary: 'Adds evidence-derived terms without changing the investigation target.',
            contentType: 'application/json',
            metadata: { searchTerms: [`derived-term-${codeAttempts}`] },
          }],
          telemetry: { durationMs: 1, requestsIssued: 1 },
        }
      },
    }
    const advisor: InvestigationPlanningAdvisor = {
      advise: async input => ({
        source: 'llm', workflowType: 'support_investigation', causeHypotheses: ['code'],
        missingDimensions: input.assessment.missingDimensions,
        proposedProbeIds: ['code-release-correlation'], evidenceGoals: [], searchHints: [],
        expectedComparison: [], acceptanceCriteria: [], rationale: 'Inspect the release code.',
      }),
    }
    const runner = new InvestigationRunner({
      aws, code, data: new FakeAdapter('data', emptyResult()), host: new FakeAdapter('host', emptyResult()),
    } as InvestigationAdapterRegistry, { planningAdvisor: advisor, maxPlanningIterations: 2 })

    const result = await runner.execute(run)

    expect(codeAttempts).toBeGreaterThanOrEqual(1)
    expect(result.planningTrace.filter(entry => entry.selectedProbeId === 'code-release-correlation')).toHaveLength(1)
  })
})
