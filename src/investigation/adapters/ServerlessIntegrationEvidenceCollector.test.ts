import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import { describe, expect, it } from 'vitest'
import type { InvestigationServerlessEvidenceConfig } from '../config/InvestigationTargetConfig.js'
import type { InvestigationHostTarget } from '../data/HostTargetRegistry.js'
import type { InvestigationAdapterRequest } from '../types/investigation.js'
import { buildEvidenceLedger } from '../control-plane/EvidenceLedger.js'
import { RcaCompletenessEvaluator } from '../control-plane/RcaCompletenessEvaluator.js'
import {
  ServerlessIntegrationEvidenceCollector,
  type ServerlessArtifactFetcher,
} from './ServerlessIntegrationEvidenceCollector.js'

function deploymentZip(): Buffer {
  const archive = new AdmZip()
  archive.addFile('handler.py', Buffer.from(`
def handler(event, context):
    output_queue = "https://sqs.us-west-2.amazonaws.com/123456789012/SAMPLE-PROD1-OUTPUT"
    queue_template = "https://sqs.{region}.amazonaws.com/123456789012/{queue_name}"
    try:
        if event.get("resourceType") == "ContractV1":
            selected_record = event.get("selectedRecord")
        return selected_record.get("id")
    finally:
        return {"delete": True}
  `))
  return archive.toBuffer()
}

function constantBackedDeploymentZip(): Buffer {
  const archive = new AdmZip()
  archive.addFile('event_filter.py', Buffer.from(`
SUPPORTED_RESOURCE = "ContractV1"

def handler(event, context):
    try:
        resource_type = event.get("resourceType")
        if resource_type == EventTypes.SUPPORTED_RESOURCE:
            selected_record = event.get("selectedRecord")
        if event.get("resourceType") == "AuxiliaryRecord":
            rule_options = event
        return selected_record.get("id")
    finally:
        return {"delete": True}
  `))
  return archive.toBuffer()
}

function compatibleDeploymentZip(): Buffer {
  const archive = new AdmZip()
  archive.addFile('event_filter.py', Buffer.from(`
def handler(event, context):
    resource_type = event.get("resourceType")
    try:
        if resource_type == "ContractV1" or resource_type == "ContractV2":
            selected_record = event.get("selectedRecord")
        return selected_record.get("id")
    finally:
        return {"delete": True}
  `))
  return archive.toBuffer()
}

class StaticArtifactFetcher implements ServerlessArtifactFetcher {
  constructor(private readonly bytes: Buffer) {}
  async fetch(): Promise<Buffer> { return this.bytes }
}

class ServerlessRunner {
  readonly calls: string[][] = []

  constructor(
    private readonly codeSha256: string,
    private readonly paginateLogs = false,
    private readonly lastModified = '2026-07-10T12:00:00.000Z',
  ) {}

  async runJson<T>(command: { args: string[] }): Promise<T> {
    this.calls.push(command.args)
    const [service, operation] = command.args
    const region = command.args[command.args.indexOf('--region') + 1]
    if (service === 'ec2' && operation === 'describe-regions') {
      return { Regions: [
        { RegionName: 'us-east-1' },
        { RegionName: 'us-east-2' },
        { RegionName: 'us-west-2' },
      ] } as T
    }
    if (region && region !== 'us-west-2') {
      if (service === 'sns' && operation === 'list-topics') return { Topics: [] } as T
      if (service === 'sqs' && operation === 'list-queues') return { QueueUrls: [] } as T
      if (service === 'lambda' && operation === 'list-functions') return { Functions: [] } as T
    }
    if (service === 'sns' && operation === 'list-topics') {
      return { Topics: [
        { TopicArn: 'arn:aws:sns:us-west-2:123456789012:SAMPLE-PROD1-EVENTS' },
        { TopicArn: 'arn:aws:sns:us-west-2:123456789012:SAMPLE-UAT1-EVENTS' },
        { TopicArn: 'arn:aws:sns:us-west-2:123456789012:OTHER-PROD1-EVENTS' },
      ] } as T
    }
    if (service === 'sns' && operation === 'list-subscriptions-by-topic') {
      return { Subscriptions: [{ Protocol: 'sqs', Endpoint: 'arn:aws:sqs:us-west-2:123456789012:SAMPLE-PROD1-INPUT' }] } as T
    }
    if (service === 'sqs' && operation === 'list-queues') {
      return { QueueUrls: [
        'https://sqs.us-west-2.amazonaws.com/123456789012/SAMPLE-PROD1-INPUT',
        'https://sqs.us-west-2.amazonaws.com/123456789012/SAMPLE-UAT1-INPUT',
        'https://sqs.us-west-2.amazonaws.com/123456789012/OTHER-PROD1-INPUT',
      ] } as T
    }
    if (service === 'sqs' && operation === 'get-queue-attributes') {
      return { Attributes: { QueueArn: 'arn:aws:sqs:us-west-2:123456789012:SAMPLE-PROD1-INPUT' } } as T
    }
    if (service === 'lambda' && operation === 'list-event-source-mappings') {
      return { EventSourceMappings: [
        {
          FunctionArn: 'arn:aws:lambda:us-west-2:123456789012:function:SAMPLE-PROD1-FUNCTION-A',
          State: 'Enabled',
        },
      ] } as T
    }
    if (service === 'lambda' && operation === 'get-function-event-invoke-config') return {} as T
    if (service === 'lambda' && operation === 'list-functions') {
      return { Functions: [{
        FunctionName: 'SAMPLE-PROD1-FUNCTION-A',
        FunctionArn: 'arn:aws:lambda:us-west-2:123456789012:function:SAMPLE-PROD1-FUNCTION-A',
      }] } as T
    }
    if (service === 'lambda' && operation === 'get-function-configuration') {
      const functionName = command.args[command.args.indexOf('--function-name') + 1]
      return {
        FunctionName: functionName,
        FunctionArn: `arn:aws:lambda:us-west-2:123456789012:function:${functionName}`,
        Handler: functionName.endsWith('-A') ? 'handler.handler' : 'secondary.handler',
        Runtime: 'python3.12',
        LastModified: this.lastModified,
        CodeSha256: this.codeSha256,
        Environment: { Variables: { API_PASSWORD: 'never-store-this', DESTINATION_QUEUE: 'safe-reference' } },
      } as T
    }
    if (service === 'lambda' && operation === 'get-function') {
      return {
        Code: { Location: 'https://lambda-code.us-west-2.amazonaws.com/signed-secret-location' },
      } as T
    }
    if (service === 'logs' && operation === 'filter-log-events') {
      const end = Number(command.args[command.args.indexOf('--end-time') + 1])
      const filterPatternIndex = command.args.indexOf('--filter-pattern')
      const filterPattern = filterPatternIndex >= 0 ? command.args[filterPatternIndex + 1] : ''
      if (!filterPattern.includes('ERROR') && end <= Date.parse('2026-07-15T19:00:00.000Z')) {
        return {
          events: [{ eventId: 'before-1', timestamp: Date.parse('2026-07-15T17:30:00.000Z'), message: JSON.stringify({ data: [{ resourceType: 'Bundle' }, { resourceType: 'ContractV1' }, { resourceType: 'Provider' }], type: 'Notification', optional: '' }) }],
          ...(this.paginateLogs ? { nextToken: 'repeat-token' } : {}),
        } as T
      }
      return {
        events: [
          { eventId: 'after-1', timestamp: Date.parse('2026-07-15T19:00:00.000Z'), message: JSON.stringify({ data: [{ resourceType: 'Bundle' }, { resourceType: 'ContractV2' }, { resourceType: 'Provider' }], type: 'Notification', optional: '' }) },
          { eventId: 'after-envelope', timestamp: Date.parse('2026-07-15T19:00:00.500Z'), message: JSON.stringify({ type: 'message' }) },
          { eventId: 'after-2', timestamp: Date.parse('2026-07-15T19:00:01.000Z'), message: "ERROR KeyError: selectedRecord.get failed password=super-secret Message deleted from the queue" },
        ],
        ...(this.paginateLogs ? { nextToken: 'repeat-token' } : {}),
      } as T
    }
    if (service === 'cloudwatch' && operation === 'get-metric-data') {
      const query = command.args[command.args.indexOf('--metric-data-queries') + 1]
      const fulfillment = query.includes('OUTPUT')
      return { MetricDataResults: [
        { Id: 'sent', Timestamps: ['2026-07-15T17:00:00.000Z', '2026-07-15T19:00:00.000Z'], Values: [5, fulfillment ? 0 : 5] },
        { Id: 'received', Timestamps: ['2026-07-15T17:00:00.000Z', '2026-07-15T19:00:00.000Z'], Values: [5, fulfillment ? 0 : 5] },
        { Id: 'deleted', Timestamps: ['2026-07-15T17:00:00.000Z', '2026-07-15T19:00:00.000Z'], Values: [5, fulfillment ? 0 : 5] },
      ] } as T
    }
    throw new Error(`Unexpected command: ${command.args.join(' ')}`)
  }
}

const config: InvestigationServerlessEvidenceConfig = {
  defaults: {
    enabled: true,
    resourceNameHints: [],
    resourceNameExclusions: [],
    services: ['sns', 'sqs', 'lambda'],
    regions: ['us-west-2'],
    maxResources: 8,
    maxRequests: 120,
    maxLogEvents: 50,
    timelineLookbackHours: 72,
    timelineBucketMinutes: 360,
    timelineMaxPagesPerWindow: 2,
    timelineMaxEventsPerWindow: 200,
    inspectDeploymentPackages: true,
    maxDeploymentPackageBytes: 5 * 1024 * 1024,
    maxInspectedSourceBytes: 512 * 1024,
  },
  scopes: [],
}

const request: InvestigationAdapterRequest = {
  runId: 'inv-serverless-test',
  jiraKey: 'SUP-1',
  adapter: 'aws',
  scope: {
    clientId: 'SAMPLE',
    environment: 'PROD_REPLICA',
    serviceIds: ['outboundNotification'],
    keywords: ['subscriber requests stopped', 'queue'],
    timeWindow: {
      startTs: '2026-07-15T18:30:00.000Z',
      endTs: '2026-07-15T20:30:00.000Z',
    },
    planningContext: { activeProbeIntent: 'trace_message_route' },
  },
  constraints: { timeoutMs: 60_000, maxArtifacts: 10, maxRows: 100, redactionRequired: true },
}

const target: InvestigationHostTarget = {
  id: 'sample-prod',
  clientId: 'SAMPLE',
  environment: 'PROD_REPLICA',
  envId: 'PROD1',
  awsAccountId: '123456789012',
  region: 'us-west-2',
  instanceId: 'aws-log-scope',
  instanceName: 'Test AWS scope',
  vpcId: 'unknown',
  subnetId: 'unknown',
  networkPath: 'ssh_public',
  instanceProfileArn: 'unknown',
  expectedRoleName: 'readonly',
  ssmAllowed: false,
  enabled: true,
}

describe('ServerlessIntegrationEvidenceCollector', () => {
  it('discovers the matching runtime region before tracing a dynamic AWS service scope', async () => {
    const zip = deploymentZip()
    const runner = new ServerlessRunner(createHash('sha256').update(zip).digest('base64'))
    const collector = new ServerlessIntegrationEvidenceCollector({
      ...config,
      defaults: { ...config.defaults, regions: [] },
    }, new StaticArtifactFetcher(zip))

    const result = await collector.collect(request, { ...target, region: 'aws-dynamic' }, runner, 10_000)

    expect(runner.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['ec2', 'describe-regions']),
      expect.arrayContaining(['lambda', 'list-functions', '--region', 'us-east-1']),
      expect.arrayContaining(['lambda', 'list-functions', '--region', 'us-east-2']),
      expect.arrayContaining(['lambda', 'list-functions', '--region', 'us-west-2']),
      expect.arrayContaining(['lambda', 'get-function-configuration', '--region', 'us-west-2']),
    ]))
    const inspectedConfiguration = runner.calls.find(call => call.includes('get-function-configuration'))
    expect(inspectedConfiguration).toContain('SAMPLE-PROD1-FUNCTION-A')
    expect(result.evidence.find(artifact => artifact.id.endsWith('aws-serverless-topology'))?.metadata)
      .toMatchObject({ regions: ['us-west-2'] })
  })

  it('traces topology and links a pre/post payload change to a checksum-verified deployed handler', async () => {
    const zip = deploymentZip()
    const runner = new ServerlessRunner(createHash('sha256').update(zip).digest('base64'))
    const collector = new ServerlessIntegrationEvidenceCollector(config, new StaticArtifactFetcher(zip))

    const result = await collector.collect(request, target, runner, 10_000)
    const runtimeEvidence = result.evidence.find(artifact => artifact.id.endsWith('aws-serverless-runtime'))
    const runtimeFunctions = runtimeEvidence?.metadata?.functions as Array<{
      functionName?: string
      incidentContract: { discriminatorValues: Record<string, string[]> }
    }>

    expect(runner.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['sns', 'list-topics', '--region', 'us-west-2']),
      expect.arrayContaining(['sqs', 'get-queue-attributes']),
      expect.arrayContaining(['lambda', 'list-event-source-mappings']),
      expect.arrayContaining(['lambda', 'get-function-configuration']),
      expect.arrayContaining(['lambda', 'get-function']),
      expect.arrayContaining(['--filter-pattern', '?resourceType ?eventType ?"detail-type" ?action ?operation']),
    ]))
    expect(runner.calls.some(call => call.some(arg => /(?:BSCA|UAT1)/.test(arg)))).toBe(false)
    expect(runner.calls.some(call => call.some(arg => /(?:\{region\}|\{queue_name\}|%7B)/.test(arg)))).toBe(false)
    const filteredRuntime = runtimeFunctions.find((entry) => entry.functionName?.endsWith('-A'))!
    expect(filteredRuntime.incidentContract.discriminatorValues).toMatchObject({ resourceType: ['Bundle', 'ContractV2', 'Provider'] })
    expect(filteredRuntime.incidentContract.discriminatorValues.type).toEqual(['Notification', 'message'])
    const topology = result.evidence.find(artifact => artifact.id.endsWith('-topology'))!
    expect(topology.metadata).toMatchObject({
      rawPayloadsStored: false,
      signedArtifactUrlsStored: false,
      deploymentPackagesStored: false,
    })
    expect(topology.metadata?.topology).toMatchObject({
      edges: expect.arrayContaining([
        expect.objectContaining({ relation: 'publishes_to' }),
        expect.objectContaining({ relation: 'consumes' }),
      ]),
    })
    const links = result.evidence.flatMap(artifact => artifact.metadata?.rcaLinks as unknown[] || [])
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'reached', dimensions: expect.arrayContaining(['trigger', 'proof']) }),
      expect.objectContaining({ relation: 'emitted', dimensions: expect.arrayContaining(['failure', 'mechanism']) }),
      expect.objectContaining({ relation: 'suppresses failure propagation through' }),
      expect.objectContaining({ relation: 'stopped before' }),
    ]))
    const serialized = JSON.stringify(result.evidence.map(artifact => artifact.metadata))
    expect(serialized).toContain('ContractV1')
    expect(serialized).toContain('ContractV2')
    expect(serialized).not.toContain('[REDACTED_SECRET]')
    expect(serialized).not.toContain('super-secret')
    expect(serialized).not.toContain('never-store-this')
    expect(serialized).not.toContain('signed-secret-location')

    const run = {
      id: request.runId,
      jiraKey: request.jiraKey,
      title: 'External integration requests stopped',
      scope: request.scope,
      status: 'running',
      currentStage: 'correlation',
      confidence: null,
      summary: null,
      createdAt: '2026-07-15T18:30:00.000Z',
      updatedAt: '2026-07-15T20:30:00.000Z',
    } as const
    const ledger = buildEvidenceLedger(run, result.findings, result.evidence)
    expect(ledger.facts.map(fact => fact.type)).toEqual(expect.arrayContaining([
      'configuration',
      'runtime_failure',
      'change',
      'comparison',
    ]))
    expect(ledger.symptomClusters).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'serverless-runtime:sampleprod1functiona',
        explainedByChainIds: ['serverless-contract:sampleprod1functiona'],
      }),
    ]))
    const assessment = new RcaCompletenessEvaluator().evaluate(run, result.findings, result.evidence)
    expect(assessment).toMatchObject({ diagnosisReady: true, missingDiagnosisDimensions: [] })
    expect(assessment.primaryCausalFinding).toMatchObject({
      component: 'SAMPLE-PROD1-FUNCTION-A',
      trigger: 'resourceType changed from ContractV1 to ContractV2',
      operation: 'selected_record.get()',
      precisionComplete: true,
    })
    expect(assessment.primaryCausalFinding?.statement).toContain('KeyError')
    expect(assessment.primaryCausalFinding?.statement).toContain('message was deleted')
    expect(assessment.summary).toContain('SAMPLE-PROD1-FUNCTION-A')
  })

  it('resolves constant-backed deployed handler contract discriminators', async () => {
    const zip = constantBackedDeploymentZip()
    const runner = new ServerlessRunner(createHash('sha256').update(zip).digest('base64'))
    const collector = new ServerlessIntegrationEvidenceCollector(config, new StaticArtifactFetcher(zip))

    const result = await collector.collect(request, target, runner, 10_000)
    const deployment = result.evidence.find(artifact => artifact.id.endsWith('-deployment'))
    const functions = deployment?.metadata?.functions as Array<{
      artifact?: {
        discriminatorValues: Record<string, string[]>
        discriminatorGroups: Record<string, string[][]>
      }
    }>
    const links = result.evidence.flatMap(artifact => artifact.metadata?.rcaLinks as unknown[] || [])

    expect(functions[0].artifact?.discriminatorValues.resourceType).toEqual(expect.arrayContaining(['ContractV1', 'AuxiliaryRecord']))
    expect(functions[0].artifact?.discriminatorGroups.resourceType).toEqual(expect.arrayContaining([
      ['ContractV1'],
      ['AuxiliaryRecord'],
    ]))
    expect(links).toEqual(expect.arrayContaining([
      expect.objectContaining({ relation: 'reached', dimensions: expect.arrayContaining(['trigger', 'proof']) }),
      expect.objectContaining({ relation: 'emitted', dimensions: expect.arrayContaining(['failure', 'mechanism']) }),
    ]))
  })

  it('refuses deployed-code causal claims when the package checksum does not match AWS configuration', async () => {
    const zip = deploymentZip()
    const runner = new ServerlessRunner(Buffer.alloc(32, 7).toString('base64'))
    const collector = new ServerlessIntegrationEvidenceCollector(config, new StaticArtifactFetcher(zip))

    const result = await collector.collect(request, target, runner, 10_000)
    const metadata = result.evidence.find(artifact => artifact.id.endsWith('-deployment'))?.metadata as Record<string, unknown>
    const functions = metadata.functions as Array<{ artifact?: { checksumVerified: boolean; inspectedFiles: string[] } }>

    expect(functions[0].artifact).toMatchObject({ checksumVerified: false, inspectedFiles: [] })
    expect(metadata.rcaLinks).toEqual([])
  })

  it('uses chronological runtime causality when the current artifact was deployed after the failure', async () => {
    const zip = compatibleDeploymentZip()
    const runner = new ServerlessRunner(
      createHash('sha256').update(zip).digest('base64'),
      false,
      '2026-07-16T21:30:12.000Z',
    )
    const collector = new ServerlessIntegrationEvidenceCollector(config, new StaticArtifactFetcher(zip))

    const result = await collector.collect(request, target, runner, 10_000)
    const run = {
      id: request.runId,
      jiraKey: request.jiraKey,
      title: 'External integration requests stopped',
      scope: request.scope,
      status: 'running',
      currentStage: 'correlation',
      confidence: null,
      summary: null,
      createdAt: '2026-07-15T18:30:00.000Z',
      updatedAt: '2026-07-15T20:30:00.000Z',
    } as const
    const assessment = new RcaCompletenessEvaluator().evaluate(run, result.findings, result.evidence)
    const deploymentFacts = result.evidence
      .flatMap(artifact => artifact.metadata?.evidenceFacts as Array<Record<string, unknown>> || [])

    expect(assessment).toMatchObject({ diagnosisReady: true, missingDiagnosisDimensions: [] })
    expect(assessment.primaryCausalFinding).toMatchObject({
      component: 'SAMPLE-PROD1-FUNCTION-A',
      trigger: 'resourceType changed from ContractV1 to ContractV2',
      operation: 'get()',
      precisionComplete: true,
    })
    expect(deploymentFacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ predicate: 'was redeployed after the observed failure at' }),
    ]))
    expect(JSON.stringify(result.evidence)).toContain('not treated as the incident artifact')
  })

  it('paginates bounded CloudWatch windows and stops when AWS repeats a continuation token', async () => {
    const zip = deploymentZip()
    const runner = new ServerlessRunner(createHash('sha256').update(zip).digest('base64'), true)
    const collector = new ServerlessIntegrationEvidenceCollector(config, new StaticArtifactFetcher(zip))

    const result = await collector.collect(request, target, runner, 10_000)

    expect(runner.calls).toEqual(expect.arrayContaining([
      expect.arrayContaining(['logs', 'filter-log-events', '--next-token', 'repeat-token']),
    ]))
    expect(runner.calls.filter(call => call.includes('--next-token')).length).toBeLessThanOrEqual(20)
    expect(result.telemetry.requestsIssued).toBeLessThanOrEqual(config.defaults.maxRequests)
    expect(result.evidence.find(artifact => artifact.id.endsWith('aws-serverless-runtime'))?.summary)
      .toContain('1 redacted error event(s)')
  })
})
