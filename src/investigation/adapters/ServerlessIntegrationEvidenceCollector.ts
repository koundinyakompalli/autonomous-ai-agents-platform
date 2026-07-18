import { createHash } from 'node:crypto'
import AdmZip from 'adm-zip'
import type { InvestigationHostTarget } from '../data/HostTargetRegistry.js'
import type {
  InvestigationServerlessEvidenceConfig,
  InvestigationServerlessEvidenceScope,
  InvestigationServerlessService,
} from '../config/InvestigationTargetConfig.js'
import type {
  InvestigationAdapterRequest,
  InvestigationAdapterResult,
  InvestigationAdapterTraceStep,
  InvestigationEvidenceArtifact,
  InvestigationEvidenceFactType,
  InvestigationFinding,
} from '../types/investigation.js'
import { redactInvestigationText } from '../utils/RuntimeEvidence.js'

export interface ServerlessAwsCommandRunner {
  runJson<T>(command: { args: string[] }, timeoutMs?: number): Promise<T>
}

export interface ServerlessArtifactFetcher {
  fetch(location: string, maxBytes: number, timeoutMs: number): Promise<Buffer>
}

interface TopicList { Topics?: Array<{ TopicArn?: string }> }
interface SubscriptionList { Subscriptions?: Array<{ Protocol?: string; Endpoint?: string; SubscriptionArn?: string }> }
interface QueueList { QueueUrls?: string[] }
interface QueueUrlResponse { QueueUrl?: string }
interface QueueAttributes { Attributes?: Record<string, string> }
interface FunctionList { Functions?: Array<{ FunctionName?: string; FunctionArn?: string }> }
interface EventSourceMappings { EventSourceMappings?: Array<{ UUID?: string; FunctionArn?: string; State?: string; LastModified?: string }> }
interface FunctionConfiguration {
  FunctionName?: string
  FunctionArn?: string
  Handler?: string
  Runtime?: string
  LastModified?: string
  CodeSha256?: string
  Timeout?: number
  Environment?: { Variables?: Record<string, string> }
  DeadLetterConfig?: { TargetArn?: string }
}
interface FunctionResponse { Code?: { Location?: string }; Configuration?: FunctionConfiguration }
interface FunctionInvokeConfig { DestinationConfig?: { OnSuccess?: { Destination?: string }; OnFailure?: { Destination?: string } } }
interface LogEvents { events?: Array<{ eventId?: string; timestamp?: number; message?: string; logStreamName?: string }>; nextToken?: string }
interface EventRuleList { Rules?: Array<{ Name?: string; Arn?: string; EventBusName?: string; State?: string }> }
interface EventTargets { Targets?: Array<{ Id?: string; Arn?: string; DeadLetterConfig?: { Arn?: string } }> }
interface RestApiList { items?: Array<{ id?: string; name?: string; createdDate?: string }> }
interface HttpApiList { Items?: Array<{ ApiId?: string; Name?: string; ProtocolType?: string; CreatedDate?: string }> }
interface RestResourceList { items?: Array<{ id?: string; path?: string; resourceMethods?: Record<string, unknown> }> }
interface RestIntegration { type?: string; uri?: string }
interface HttpIntegrationList { Items?: Array<{ IntegrationId?: string; IntegrationType?: string; IntegrationUri?: string }> }
interface CloudWatchMetricData {
  MetricDataResults?: Array<{ Id?: string; Label?: string; Timestamps?: string[]; Values?: number[] }>
}
interface RegionList { Regions?: Array<{ RegionName?: string }> }

interface TopologyNode {
  id: string
  kind: 'sns_topic' | 'sqs_queue' | 'lambda' | 'eventbridge_rule' | 'api_gateway'
  name: string
  arn?: string
  url?: string
  state?: string
  region?: string
}

interface TopologyEdge {
  from: string
  relation: 'publishes_to' | 'subscribes' | 'consumes' | 'targets' | 'dead_letters_to'
  to: string
  evidence: string
}

interface ContractSnapshot {
  discriminatorValues: Record<string, string[]>
  fieldTypes: Record<string, string[]>
  eventCount: number
  errorCount: number
  observations: Array<{ timestamp?: string; key: string; value: string }>
}

interface ContractTransition {
  key: string
  controlValue: string
  incidentValue: string
  lastSupportedAt: number
  firstUnsupportedAt: number
}

interface QueueMetricSummary {
  queueId: string
  queueName: string
  region: string
  before: Record<'sent' | 'received' | 'deleted', number>
  incident: Record<'sent' | 'received' | 'deleted', number>
}

interface ArtifactAnalysis {
  checksumVerified: boolean
  inspectedFiles: string[]
  discriminatorValues: Record<string, string[]>
  discriminatorGroups: Record<string, string[][]>
  hasUncheckedGet: boolean
  uncheckedGetReceivers: string[]
  hasReturnInFinally: boolean
  queueReferences: string[]
}

interface FunctionInspection {
  region: string
  configuration: FunctionConfiguration
  errors: Array<{ timestamp?: string; message: string; signals: string[] }>
  before: ContractSnapshot
  after: ContractSnapshot
  contractTransition?: ContractTransition
  timeline?: {
    failureSignature: string
    firstFailureAt?: string
    comparisonStart: string
    lookbackExhausted: boolean
  }
  artifact?: ArtifactAnalysis
}

type ServerlessEvidenceSource = 'topology' | 'runtime' | 'deployment' | 'metrics'

interface ServerlessEvidenceRefs {
  topology: string
  runtime: string
  deployment: string
  metrics: string
}

interface CausalMetadata {
  evidenceFacts: Record<ServerlessEvidenceSource, unknown[]>
  rcaLinks: Record<ServerlessEvidenceSource, unknown[]>
  symptomClusters: unknown[]
}

interface CausalRoles {
  component?: string
  trigger?: string
  operation?: string
  error?: string
  failureHandling?: string
  impact?: string
}

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_DYNAMIC_REGIONS = ['us-east-2', 'us-east-1', 'us-west-2']
const MAX_DYNAMIC_REGIONS = 8
const REGION_PREFLIGHT_BATCH_SIZE = 3
const CONTRACT_KEYS = ['resourceType', 'eventType', 'detail-type', 'type', 'action', 'operation']
const SOURCE_EXTENSIONS = /\.(?:py|js|mjs|cjs|ts|java|kt|properties|ya?ml|json)$/i
const INTEGRATION_SIGNAL = /\b(?:lambda|sns|sqs|eventbridge|event bus|event publishing|api gateway|serverless|queue|publisher|subscriber|message|webhook|downstream|integration)\b/i
const MISSING_DELIVERY_SIGNAL = /\b(?:not receiving|stopped receiving|no longer receiving|missing|dropped)\b[^\n]{0,160}\b(?:requests?|events?|messages?)\b/i

class HttpsServerlessArtifactFetcher implements ServerlessArtifactFetcher {
  async fetch(location: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
    const url = new URL(location)
    if (url.protocol !== 'https:' || !/(?:^|\.)amazonaws\.com(?:\.cn)?$/i.test(url.hostname)) {
      throw new Error('Lambda deployment URL was not an approved AWS HTTPS endpoint')
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: controller.signal, redirect: 'error' })
      if (!response.ok) throw new Error(`Lambda deployment download returned HTTP ${response.status}`)
      const declared = Number(response.headers.get('content-length') || 0)
      if (declared > maxBytes) throw new Error(`Lambda deployment package exceeds the configured ${maxBytes} byte limit`)
      if (!response.body) throw new Error('Lambda deployment response had no body')
      const reader = response.body.getReader()
      const chunks: Buffer[] = []
      let total = 0
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        total += value.byteLength
        if (total > maxBytes) {
          await reader.cancel()
          throw new Error(`Lambda deployment package exceeds the configured ${maxBytes} byte limit`)
        }
        chunks.push(Buffer.from(value))
      }
      return Buffer.concat(chunks, total)
    } finally {
      clearTimeout(timer)
    }
  }
}

export class ServerlessIntegrationEvidenceCollector {
  constructor(
    private readonly config: InvestigationServerlessEvidenceConfig,
    private readonly artifactFetcher: ServerlessArtifactFetcher = new HttpsServerlessArtifactFetcher(),
  ) {}

  shouldCollect(request: InvestigationAdapterRequest): boolean {
    const scope = this.resolveScope(request)
    if (!scope.enabled) return false
    if (request.scope.planningContext?.activeProbeIntent && [
      'trace_message_route',
      'identify_queue_consumer',
      'inspect_serverless_runtime_failure',
      'compare_message_contract',
      'inspect_deployed_handler',
      'verify_recovery_semantics',
    ].includes(request.scope.planningContext.activeProbeIntent)) return true
    const text = ticketText(request)
    return INTEGRATION_SIGNAL.test(text) || MISSING_DELIVERY_SIGNAL.test(text)
  }

  async collect(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    runner: ServerlessAwsCommandRunner,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now()
    const safetyMarginMs = Math.min(10_000, Math.max(1_000, Math.floor(timeoutMs * 0.15)))
    const collectionDeadline = startedAt + Math.max(250, timeoutMs - safetyMarginMs)
    const remainingBudgetMs = (): number => Math.max(0, collectionDeadline - Date.now())
    const contractReserveMs = Math.min(15_000, Math.max(2_000, Math.floor(timeoutMs * 0.25)))
    const scope = this.resolveScope(request)
    const traceSteps: InvestigationAdapterTraceStep[] = []
    const failures: string[] = []
    let requestsIssued = 0
    const run = async <T>(phase: InvestigationAdapterTraceStep['phase'], title: string, args: string[]): Promise<T | undefined> => {
      const remainingMs = remainingBudgetMs()
      if (remainingMs <= 250) {
        if (!failures.some(failure => failure.startsWith('AWS collection time budget exhausted'))) {
          failures.push(`AWS collection time budget exhausted after ${Date.now() - startedAt}ms`)
        }
        return undefined
      }
      if (requestsIssued >= scope.maxRequests) {
        if (!failures.some(failure => failure.startsWith('AWS read budget exhausted'))) {
          failures.push(`AWS read budget exhausted after ${scope.maxRequests} approved calls`)
        }
        return undefined
      }
      const step: InvestigationAdapterTraceStep = {
        id: `${request.runId}-serverless-step-${traceSteps.length + 1}`,
        adapter: 'aws',
        phase,
        title,
        detail: safeCommandDescription(args),
        startedAt: new Date().toISOString(),
      }
      traceSteps.push(step)
      requestsIssued += 1
      try {
        const result = await runner.runJson<T>({ args }, Math.min(DEFAULT_TIMEOUT_MS, remainingMs))
        step.completedAt = new Date().toISOString()
        return result
      } catch (error) {
        step.completedAt = new Date().toISOString()
        const message = safeError(error)
        const expectedMissingInvokeConfig = title === 'Read Lambda asynchronous destinations'
          && /(?:ResourceNotFoundException|doesn't have an EventInvokeConfig)/i.test(message)
        if (!expectedMissingInvokeConfig) failures.push(`${title}: ${message}`)
        return undefined
      }
    }

    const configuredRegions = scope.regions.length ? scope.regions : [target.region]
    const regions = configuredRegions.some(region => region === 'aws-dynamic' || region === 'auto')
      ? await this.discoverScopedRegions(request, scope, run)
      : configuredRegions.filter(Boolean).slice(0, MAX_DYNAMIC_REGIONS)
    if (regions.length === 0) {
      failures.push(`No ${request.scope.clientId} ${request.scope.environment} serverless resources were found in the bounded AWS region scan`)
    }
    const allNodes: TopologyNode[] = []
    const allEdges: TopologyEdge[] = []
    const inspections: FunctionInspection[] = []

    for (const region of regions) {
      const { nodes, edges, functions } = await this.discoverRegion(
        request, region, scope, run,
      )
      allNodes.push(...nodes)
      allEdges.push(...edges)
      const rankedFunctions = functions
        .map((functionName, index) => ({
          functionName,
          index,
          score: functionInvestigationScore(functionName, request),
        }))
        .sort((left, right) => right.score - left.score || left.index - right.index)
        .map(entry => entry.functionName)
      for (const functionName of rankedFunctions.slice(0, scope.maxResources)) {
        const inspection = await this.inspectFunction(
          request,
          region,
          functionName,
          scope,
          run,
          remainingBudgetMs,
          contractReserveMs,
        )
        if (!inspection) continue
        inspections.push(inspection)
        if (inspection.errors.length > 0 && selectMeaningfulContractChange(contractChanges(inspection.before, inspection.after))) break
      }
    }

    for (const inspection of inspections) {
      const functionId = inspection.configuration.FunctionArn || `lambda:${inspection.region}:${inspection.configuration.FunctionName || 'unknown'}`
      const references = unique([
        ...safeAwsResourceReferences(inspection.configuration.Environment?.Variables || {}),
        ...(inspection.artifact?.queueReferences || []),
      ])
      for (const reference of references) {
        const node = topologyNodeFromReference(reference, inspection.region)
        if (!node) continue
        allNodes.push(node)
        allEdges.push({ from: functionId, relation: 'targets', to: node.id, evidence: 'Checksum-verified handler or safe Lambda resource configuration' })
      }
    }

    const nodes = uniqueBy(allNodes, node => node.id).slice(0, scope.maxResources * 5)
    const edges = uniqueBy(allEdges, edge => `${edge.from}:${edge.relation}:${edge.to}`).slice(0, scope.maxResources * 8)
    if (!nodes.length && !inspections.length) {
      return {
        findings: failures.length ? [limitationFinding(request, failures)] : [],
        evidence: [],
        telemetry: { durationMs: Date.now() - startedAt, requestsIssued, traceSteps },
      }
    }

    const queueMetrics: QueueMetricSummary[] = []
    for (const batch of chunks(nodes.filter(node => node.kind === 'sqs_queue').slice(0, scope.maxResources), 3)) {
      const metrics = await Promise.all(batch.map(node => this.collectQueueMetrics(request, node, run)))
      queueMetrics.push(...metrics.filter((entry): entry is QueueMetricSummary => Boolean(entry)))
    }

    const refs: ServerlessEvidenceRefs = {
      topology: `${request.runId}-aws-serverless-topology`,
      runtime: `${request.runId}-aws-serverless-runtime`,
      deployment: `${request.runId}-aws-serverless-deployment`,
      metrics: `${request.runId}-aws-serverless-metrics`,
    }
    const causal = buildCausalMetadata(refs, nodes, edges, inspections, queueMetrics)
    const commonMetadata = {
      regions,
      services: scope.services,
      rawPayloadsStored: false,
      signedArtifactUrlsStored: false,
      deploymentPackagesStored: false,
    }
    const evidence: InvestigationEvidenceArtifact[] = [
      {
        id: refs.topology,
        adapter: 'aws',
        title: 'AWS integration topology evidence',
        summary: `Discovered ${nodes.length} scoped resource(s) and ${edges.length} relationship(s).`,
        contentType: 'application/json',
        metadata: { ...commonMetadata, topology: { nodes, edges }, evidenceFacts: causal.evidenceFacts.topology, rcaLinks: causal.rcaLinks.topology },
      },
      {
        id: refs.runtime,
        adapter: 'aws',
        title: 'Lambda runtime and payload-contract evidence',
        summary: `Inspected ${inspections.length} Lambda runtime(s) and retained ${inspections.reduce((sum, inspection) => sum + inspection.errors.length, 0)} redacted error event(s).`,
        contentType: 'application/json',
        metadata: {
          ...commonMetadata,
          functions: inspections.map(toSafeRuntimeInspection),
          evidenceFacts: causal.evidenceFacts.runtime,
          rcaLinks: causal.rcaLinks.runtime,
          symptomClusters: causal.symptomClusters,
        },
      },
      {
        id: refs.deployment,
        adapter: 'aws',
        title: 'Checksum-verified Lambda deployment evidence',
        summary: `Checksum-verified ${inspections.filter(inspection => inspection.artifact?.checksumVerified).length} deployed package(s).`,
        contentType: 'application/json',
        metadata: {
          ...commonMetadata,
          functions: inspections.map(toSafeDeploymentInspection),
          evidenceFacts: causal.evidenceFacts.deployment,
          rcaLinks: causal.rcaLinks.deployment,
          collectionFailures: failures.slice(0, 10),
        },
      },
      {
        id: refs.metrics,
        adapter: 'aws',
        title: 'SQS stage comparison evidence',
        summary: `Compared bounded pre-incident and incident throughput for ${queueMetrics.length} queue(s).`,
        contentType: 'application/json',
        metadata: { ...commonMetadata, queueMetrics, evidenceFacts: causal.evidenceFacts.metrics, rcaLinks: causal.rcaLinks.metrics },
      },
    ]
    const findings: InvestigationFinding[] = [
      {
        id: `${request.runId}-aws-serverless-route`,
        adapter: 'aws',
        type: 'serverless_message_route_traced',
        severity: Object.values(causal.rcaLinks).some(links => links.length > 0) ? 'high' : 'medium',
        confidence: Object.values(causal.rcaLinks).some(links => links.length > 0) ? 0.94 : 0.76,
        title: 'AWS messaging and serverless execution path traced',
        summary: summarizeEvidence(nodes, edges, inspections),
        evidenceRefs: Object.values(refs),
        requiresCodeChange: Object.values(causal.rcaLinks).some(links => links.length > 0),
        requiresDataChange: false,
      },
      ...(failures.length ? [limitationFinding(request, failures)] : []),
    ]
    return {
      findings,
      evidence,
      telemetry: { durationMs: Date.now() - startedAt, requestsIssued, artifactsStored: evidence.length, traceSteps },
    }
  }

  private resolveScope(request: InvestigationAdapterRequest): InvestigationServerlessEvidenceScope {
    return this.config.scopes.find(scope =>
      (!scope.clientId || normalize(scope.clientId) === normalize(request.scope.clientId))
      && (!scope.environment || scope.environment === request.scope.environment),
    ) || this.config.defaults
  }

  private async discoverScopedRegions(
    request: InvestigationAdapterRequest,
    scope: InvestigationServerlessEvidenceScope,
    run: <T>(phase: InvestigationAdapterTraceStep['phase'], title: string, args: string[]) => Promise<T | undefined>,
  ): Promise<string[]> {
    const response = await run<RegionList>('resolve_target', 'Discover enabled AWS regions', [
      'ec2', 'describe-regions', '--region', 'us-east-1',
      '--filters', 'Name=opt-in-status,Values=opt-in-not-required,opted-in', '--output', 'json',
    ])
    const candidates = unique([
      ...DEFAULT_DYNAMIC_REGIONS,
      ...(response?.Regions || []).map(region => region.RegionName).filter(isString),
    ]).slice(0, MAX_DYNAMIC_REGIONS)
    const enabled = relevantServices(request, scope.services)

    for (const batch of chunks(candidates, REGION_PREFLIGHT_BATCH_SIZE)) {
      const matches = await Promise.all(batch.map(async region => {
        const [functions, queues, topics, rules, restApis, httpApis] = await Promise.all([
          enabled.has('lambda')
            ? run<FunctionList>('resolve_target', 'Locate scoped Lambda region', [
                'lambda', 'list-functions', '--region', region,
                '--max-items', String(Math.min(scope.maxResources * 10, 1000)), '--output', 'json',
              ])
            : undefined,
          enabled.has('sqs')
            ? run<QueueList>('resolve_target', 'Locate scoped SQS region', [
                'sqs', 'list-queues', '--region', region,
                '--max-results', String(Math.min(scope.maxResources * 10, 1000)), '--output', 'json',
              ])
            : undefined,
          enabled.has('sns')
            ? run<TopicList>('resolve_target', 'Locate scoped SNS region', [
                'sns', 'list-topics', '--region', region,
                '--max-items', String(Math.min(scope.maxResources * 10, 1000)), '--output', 'json',
              ])
            : undefined,
          enabled.has('events')
            ? run<EventRuleList>('resolve_target', 'Locate scoped EventBridge region', [
                'events', 'list-rules', '--region', region,
                '--limit', String(Math.min(scope.maxResources * 5, 100)), '--output', 'json',
              ])
            : undefined,
          enabled.has('apigateway')
            ? run<RestApiList>('resolve_target', 'Locate scoped REST API region', [
                'apigateway', 'get-rest-apis', '--region', region,
                '--limit', String(scope.maxResources * 5), '--output', 'json',
              ])
            : undefined,
          enabled.has('apigateway')
            ? run<HttpApiList>('resolve_target', 'Locate scoped HTTP API region', [
                'apigatewayv2', 'get-apis', '--region', region,
                '--max-results', String(Math.min(scope.maxResources * 5, 500)), '--output', 'json',
              ])
            : undefined,
        ])
        const seeds = [
          ...(functions?.Functions || []).flatMap(fn => [fn.FunctionName, fn.FunctionArn]),
          ...(queues?.QueueUrls || []),
          ...(topics?.Topics || []).map(topic => topic.TopicArn),
          ...(rules?.Rules || []).flatMap(rule => [rule.Name, rule.Arn]),
          ...(restApis?.items || []).map(api => api.name),
          ...(httpApis?.Items || []).map(api => api.Name),
        ].filter(isString)
        return seeds.some(seed => seedResourceMatches(seed, request, scope)) ? region : undefined
      }))
      const selected = matches.filter(isString)
      if (selected.length > 0) return selected
    }
    return []
  }

  private async discoverRegion(
    request: InvestigationAdapterRequest,
    region: string,
    scope: InvestigationServerlessEvidenceScope,
    run: <T>(phase: InvestigationAdapterTraceStep['phase'], title: string, args: string[]) => Promise<T | undefined>,
  ): Promise<{ nodes: TopologyNode[]; edges: TopologyEdge[]; functions: string[] }> {
    const nodes: TopologyNode[] = []
    const edges: TopologyEdge[] = []
    const functions = new Set<string>()
    const enabled = relevantServices(request, scope.services)

    const topics = enabled.has('sns')
      ? await run<TopicList>('discover_topology', 'List scoped SNS topics', ['sns', 'list-topics', '--region', region, '--output', 'json'])
      : undefined
    const topicArns = (topics?.Topics || []).map(item => item.TopicArn).filter(isString)
      .filter(arn => seedResourceMatches(arn, request, scope)).slice(0, scope.maxResources)
    for (const arn of topicArns) nodes.push({ id: arn, kind: 'sns_topic', name: arn.split(':').pop() || arn, arn, region })

    const queues = enabled.has('sqs')
      ? await run<QueueList>('discover_topology', 'List scoped SQS queues', ['sqs', 'list-queues', '--region', region, '--max-results', String(Math.min(scope.maxResources * 10, 1000)), '--output', 'json'])
      : undefined
    const queueUrls = (queues?.QueueUrls || []).filter(url => seedResourceMatches(url, request, scope)).slice(0, scope.maxResources)
    const queueArnToUrl = new Map<string, string>()
    for (const url of queueUrls) {
      const attrs = await run<QueueAttributes>('discover_topology', 'Read SQS queue topology attributes', [
        'sqs', 'get-queue-attributes', '--region', region, '--queue-url', url,
        '--attribute-names', 'QueueArn', 'RedrivePolicy', '--output', 'json',
      ])
      const arn = attrs?.Attributes?.QueueArn
      const id = arn || url
      nodes.push({ id, kind: 'sqs_queue', name: url.split('/').pop() || url, arn, url, region })
      if (arn) queueArnToUrl.set(arn, url)
      const dlqArn = parseDeadLetterArn(attrs?.Attributes?.RedrivePolicy)
      if (dlqArn) edges.push({ from: id, relation: 'dead_letters_to', to: dlqArn, evidence: 'SQS RedrivePolicy' })
    }

    for (const topicArn of topicArns) {
      const subscriptions = await run<SubscriptionList>('discover_topology', 'Read SNS topic subscriptions', [
        'sns', 'list-subscriptions-by-topic', '--region', region, '--topic-arn', topicArn, '--output', 'json',
      ])
      for (const subscription of subscriptions?.Subscriptions || []) {
        if (!subscription.Endpoint) continue
        edges.push({ from: topicArn, relation: 'publishes_to', to: subscription.Endpoint, evidence: `SNS ${subscription.Protocol || 'subscription'}` })
        if (subscription.Protocol === 'lambda') functions.add(functionNameFromArn(subscription.Endpoint))
        if (subscription.Protocol === 'sqs' && !queueArnToUrl.has(subscription.Endpoint)) {
          const queueName = subscription.Endpoint.split(':').pop()
          if (!queueName) continue
          const queue = await run<QueueUrlResponse>('discover_topology', 'Resolve subscribed SQS queue URL', [
            'sqs', 'get-queue-url', '--region', region, '--queue-name', queueName, '--output', 'json',
          ])
          if (!queue?.QueueUrl) continue
          queueArnToUrl.set(subscription.Endpoint, queue.QueueUrl)
          nodes.push({ id: subscription.Endpoint, kind: 'sqs_queue', name: queueName, arn: subscription.Endpoint, url: queue.QueueUrl, region })
        }
      }
    }

    for (const queueArn of queueArnToUrl.keys()) {
      const mappings = await run<EventSourceMappings>('discover_topology', 'Resolve Lambda queue consumers', [
        'lambda', 'list-event-source-mappings', '--region', region, '--event-source-arn', queueArn, '--output', 'json',
      ])
      for (const mapping of mappings?.EventSourceMappings || []) {
        if (!mapping.FunctionArn) continue
        const name = functionNameFromArn(mapping.FunctionArn)
        functions.add(name)
        nodes.push({ id: mapping.FunctionArn, kind: 'lambda', name, arn: mapping.FunctionArn, state: mapping.State, region })
        edges.push({ from: queueArn, relation: 'consumes', to: mapping.FunctionArn, evidence: 'Lambda event source mapping' })
      }
    }

    if (enabled.has('lambda') && functions.size === 0) {
      const listed = await run<FunctionList>('discover_topology', 'List scoped Lambda functions', [
        'lambda', 'list-functions', '--region', region, '--max-items', String(Math.min(scope.maxResources * 10, 1000)), '--output', 'json',
      ])
      for (const fn of (listed?.Functions || []).filter(fn => seedResourceMatches(`${fn.FunctionName} ${fn.FunctionArn}`, request, scope)).slice(0, scope.maxResources)) {
        if (!fn.FunctionName) continue
        functions.add(fn.FunctionName)
        nodes.push({ id: fn.FunctionArn || fn.FunctionName, kind: 'lambda', name: fn.FunctionName, arn: fn.FunctionArn, region })
      }
    }

    if (enabled.has('events')) {
      const rules = await run<EventRuleList>('discover_topology', 'List scoped EventBridge rules', [
        'events', 'list-rules', '--region', region, '--limit', String(Math.min(scope.maxResources * 5, 100)), '--output', 'json',
      ])
      for (const rule of (rules?.Rules || []).filter(rule => seedResourceMatches(`${rule.Name} ${rule.Arn}`, request, scope)).slice(0, scope.maxResources)) {
        if (!rule.Name) continue
        const id = rule.Arn || `eventbridge:${region}:${rule.Name}`
        nodes.push({ id, kind: 'eventbridge_rule', name: rule.Name, arn: rule.Arn, state: rule.State, region })
        const targets = await run<EventTargets>('discover_topology', 'Read EventBridge rule targets', [
          'events', 'list-targets-by-rule', '--region', region, '--rule', rule.Name, '--output', 'json',
        ])
        for (const target of targets?.Targets || []) {
          if (!target.Arn) continue
          edges.push({ from: id, relation: 'targets', to: target.Arn, evidence: 'EventBridge target' })
          if (target.Arn.includes(':lambda:')) functions.add(functionNameFromArn(target.Arn))
        }
      }
    }

    if (enabled.has('apigateway')) {
      const [rest, http] = await Promise.all([
        run<RestApiList>('discover_topology', 'List scoped REST APIs', ['apigateway', 'get-rest-apis', '--region', region, '--limit', String(scope.maxResources * 5), '--output', 'json']),
        run<HttpApiList>('discover_topology', 'List scoped HTTP APIs', ['apigatewayv2', 'get-apis', '--region', region, '--max-results', String(Math.min(scope.maxResources * 5, 500)), '--output', 'json']),
      ])
      for (const api of (rest?.items || []).filter(api => seedResourceMatches(api.name, request, scope)).slice(0, scope.maxResources)) {
        if (!api.id || !api.name) continue
        const apiNode = `apigateway:${region}:${api.id}`
        nodes.push({ id: apiNode, kind: 'api_gateway', name: api.name, region })
        const resources = await run<RestResourceList>('discover_topology', 'Read REST API resources', [
          'apigateway', 'get-resources', '--region', region, '--rest-api-id', api.id, '--limit', String(scope.maxResources * 5), '--output', 'json',
        ])
        for (const resource of (resources?.items || []).slice(0, scope.maxResources * 5)) {
          for (const method of Object.keys(resource.resourceMethods || {}).slice(0, 10)) {
            if (!resource.id) continue
            const integration = await run<RestIntegration>('discover_topology', 'Read REST API integration target', [
              'apigateway', 'get-integration', '--region', region, '--rest-api-id', api.id,
              '--resource-id', resource.id, '--http-method', method, '--output', 'json',
            ])
            const targetArn = lambdaArnFromIntegrationUri(integration?.uri)
            if (!targetArn) continue
            edges.push({ from: apiNode, relation: 'targets', to: targetArn, evidence: `API Gateway ${method} ${resource.path || ''}`.trim() })
            functions.add(functionNameFromArn(targetArn))
          }
        }
      }
      for (const api of (http?.Items || []).filter(api => seedResourceMatches(api.Name, request, scope)).slice(0, scope.maxResources)) {
        if (!api.ApiId || !api.Name) continue
        const apiNode = `apigatewayv2:${region}:${api.ApiId}`
        nodes.push({ id: apiNode, kind: 'api_gateway', name: api.Name, region })
        const integrations = await run<HttpIntegrationList>('discover_topology', 'Read HTTP API integration targets', [
          'apigatewayv2', 'get-integrations', '--region', region, '--api-id', api.ApiId,
          '--max-results', String(Math.min(scope.maxResources * 5, 500)), '--output', 'json',
        ])
        for (const integration of integrations?.Items || []) {
          const targetArn = lambdaArnFromIntegrationUri(integration.IntegrationUri)
          if (!targetArn) continue
          edges.push({ from: apiNode, relation: 'targets', to: targetArn, evidence: `API Gateway v2 ${integration.IntegrationType || 'integration'}` })
          functions.add(functionNameFromArn(targetArn))
        }
      }
    }
    for (const functionName of Array.from(functions).slice(0, scope.maxResources)) {
      const invokeConfig = await run<FunctionInvokeConfig>('discover_topology', 'Read Lambda asynchronous destinations', [
        'lambda', 'get-function-event-invoke-config', '--region', region, '--function-name', functionName, '--output', 'json',
      ])
      const functionNode = `lambda:${region}:${functionName}`
      const success = invokeConfig?.DestinationConfig?.OnSuccess?.Destination
      const failure = invokeConfig?.DestinationConfig?.OnFailure?.Destination
      if (success) edges.push({ from: functionNode, relation: 'targets', to: success, evidence: 'Lambda asynchronous success destination' })
      if (failure) edges.push({ from: functionNode, relation: 'dead_letters_to', to: failure, evidence: 'Lambda asynchronous failure destination' })
    }
    return { nodes, edges, functions: Array.from(functions).filter(Boolean) }
  }

  private async inspectFunction(
    request: InvestigationAdapterRequest,
    region: string,
    functionName: string,
    scope: InvestigationServerlessEvidenceScope,
    run: <T>(phase: InvestigationAdapterTraceStep['phase'], title: string, args: string[]) => Promise<T | undefined>,
    remainingBudgetMs: () => number,
    contractReserveMs: number,
  ): Promise<FunctionInspection | undefined> {
    const configuration = await run<FunctionConfiguration>('inspect_runtime', 'Read Lambda configuration', [
      'lambda', 'get-function-configuration', '--region', region, '--function-name', functionName, '--output', 'json',
    ])
    if (!configuration) return undefined
    let artifact: ArtifactAnalysis | undefined
    if (scope.inspectDeploymentPackages) {
      const response = await run<FunctionResponse>('inspect_artifact', 'Read Lambda deployment metadata', [
        'lambda', 'get-function', '--region', region, '--function-name', functionName, '--output', 'json',
      ])
      if (response?.Code?.Location && configuration.CodeSha256) {
        try {
          const remainingMs = remainingBudgetMs()
          if (remainingMs <= 250) throw new Error('AWS collection time budget exhausted before artifact inspection')
          const zip = await this.artifactFetcher.fetch(response.Code.Location, scope.maxDeploymentPackageBytes, remainingMs)
          artifact = inspectArtifact(zip, configuration.CodeSha256, scope.maxInspectedSourceBytes)
        } catch (error) {
          artifact = {
            checksumVerified: false,
            inspectedFiles: [],
            discriminatorValues: {},
            discriminatorGroups: {},
            hasUncheckedGet: false,
            uncheckedGetReceivers: [],
            hasReturnInFinally: false,
            queueReferences: [],
          }
        }
      }
    }
    const { beforeStart, incidentStart, incidentEnd } = comparisonWindow(request, scope.timelineLookbackHours)
    const logGroup = `/aws/lambda/${functionName}`
    const contractFilter = '?resourceType ?eventType ?"detail-type" ?action ?operation'
    const errorFilter = '?ERROR ?Exception ?Traceback ?TypeError ?AttributeError ?KeyError ?failed ?ineligible ?deleted'
    const readLogWindow = async (
      phase: InvestigationAdapterTraceStep['phase'],
      title: string,
      startTime: number,
      endTime: number,
      filterPattern?: string,
      maxPages = scope.timelineMaxPagesPerWindow,
    ): Promise<NonNullable<LogEvents['events']>> => {
      const events: NonNullable<LogEvents['events']> = []
      const seenEvents = new Set<string>()
      const seenTokens = new Set<string>()
      let nextToken: string | undefined
      for (let page = 0; page < maxPages && events.length < scope.timelineMaxEventsPerWindow; page += 1) {
        const response = await run<LogEvents>(phase, `${title} page ${page + 1}`, [
          'logs', 'filter-log-events', '--region', region, '--log-group-name', logGroup,
          '--start-time', String(startTime), '--end-time', String(endTime),
          ...(filterPattern ? ['--filter-pattern', filterPattern] : []),
          '--limit', String(Math.min(scope.maxLogEvents, scope.timelineMaxEventsPerWindow - events.length)),
          '--no-paginate',
          ...(nextToken ? ['--next-token', nextToken] : []),
          '--output', 'json',
        ])
        if (!response) break
        for (const event of response.events || []) {
          const key = event.eventId || `${event.timestamp || 0}:${event.logStreamName || ''}:${event.message || ''}`
          if (seenEvents.has(key)) continue
          seenEvents.add(key)
          events.push(event)
          if (events.length >= scope.timelineMaxEventsPerWindow) break
        }
        const token = response.nextToken
        if (!token || token === nextToken || seenTokens.has(token)) break
        seenTokens.add(token)
        nextToken = token
      }
      return events.sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0))
    }

    const seedErrorEvents = await readLogWindow(
      'inspect_runtime', 'Read incident Lambda runtime errors', incidentStart, incidentEnd, errorFilter,
    )
    const failureSignature = selectDominantFailureSignature(seedErrorEvents)
    const timelineErrorEvents = [...seedErrorEvents]
    let firstFailureAt = earliestSignatureTimestamp(seedErrorEvents, failureSignature)
    let lookbackExhausted = false
    if (failureSignature) {
      let bucketMs = scope.timelineBucketMinutes * 60 * 1000
      let cursor = incidentStart
      let emptyBuckets = 0
      let failureBucketsScanned = 0
      while (
        cursor > beforeStart
        && emptyBuckets < 2
        && failureBucketsScanned < 4
        && remainingBudgetMs() > contractReserveMs + DEFAULT_TIMEOUT_MS
      ) {
        const bucketStart = Math.max(beforeStart, cursor - bucketMs)
        const bucketEvents = await readLogWindow(
          'inspect_runtime', 'Scan prior Lambda failure-signature bucket', bucketStart, cursor, errorFilter, 1,
        )
        timelineErrorEvents.push(...bucketEvents)
        failureBucketsScanned += 1
        const timestamp = earliestSignatureTimestamp(bucketEvents, failureSignature)
        if (timestamp !== undefined) {
          firstFailureAt = firstFailureAt === undefined ? timestamp : Math.min(firstFailureAt, timestamp)
          emptyBuckets = 0
        } else {
          emptyBuckets += 1
        }
        cursor = bucketStart
        if (timestamp !== undefined) {
          bucketMs = Math.min(bucketMs * 2, scope.timelineLookbackHours * 60 * 60 * 1000)
        }
      }
      lookbackExhausted = cursor <= beforeStart && emptyBuckets < 2
      firstFailureAt = recurringFailureOnset(timelineErrorEvents, failureSignature) ?? firstFailureAt
    }
    const supportedContracts = artifact?.checksumVerified ? artifact.discriminatorValues : {}
    const supportedContractGroups = artifact?.checksumVerified ? artifact.discriminatorGroups : {}
    const contractTimelineEvents: NonNullable<LogEvents['events']> = []
    let directControlEvents: NonNullable<LogEvents['events']> = []
    let directIncidentEvents: NonNullable<LogEvents['events']> = []
    let hasDirectComparison = false
    let comparisonStart = Math.max(beforeStart, (firstFailureAt ?? incidentStart) - 15 * 60 * 1000)
    if (firstFailureAt && Object.keys(supportedContracts).length > 0) {
      const minimumBucketMs = 30 * 60 * 1000
      directIncidentEvents = await readLogWindow(
        'compare_contract',
        'Read incident Lambda contract discriminators',
        Math.max(beforeStart, firstFailureAt - minimumBucketMs),
        Math.min(incidentEnd, firstFailureAt + 5 * 60 * 1000),
        contractFilter,
      )
      const incidentContract = extractContract(directIncidentEvents)
      for (const value of (supportedContracts.resourceType || [])
        .filter(value => !(incidentContract.discriminatorValues.resourceType || []).includes(value))
        .slice(0, 4)) {
        const candidates = await readLogWindow(
          'compare_contract',
          'Find prior supported Lambda contract discriminator',
          beforeStart,
          firstFailureAt,
          value,
        )
        directControlEvents.push(...candidates.filter(event =>
          (extractContract([event]).discriminatorValues.resourceType || []).includes(value),
        ))
      }
      if (directControlEvents.length > 0 && selectMeaningfulContractChange(contractChanges(
        extractContract(directControlEvents),
        incidentContract,
      ))) {
        hasDirectComparison = true
        contractTimelineEvents.push(...directControlEvents, ...directIncidentEvents)
        comparisonStart = Math.min(...directIncidentEvents
          .map(event => event.timestamp)
          .filter((timestamp): timestamp is number => Number.isFinite(timestamp)))
      }
      const maxContractBuckets = Math.min(12, Math.max(4, Math.ceil(scope.timelineBucketMinutes / 30) + 2))
      let cursorEnd = Math.min(incidentEnd, firstFailureAt + minimumBucketMs)
      let bucketMs = minimumBucketMs
      for (let bucket = 0; !hasDirectComparison && bucket < maxContractBuckets && cursorEnd > beforeStart; bucket += 1) {
        const bucketStart = Math.max(beforeStart, cursorEnd - bucketMs)
        let bucketEvents = await readLogWindow(
          'compare_contract', 'Scan Lambda contract-transition bucket', bucketStart, cursorEnd, contractFilter,
        )
        if (!hasContractDiscriminator(extractContract(bucketEvents))) {
          bucketEvents = await readLogWindow(
            'compare_contract', 'Scan fallback Lambda contract-transition bucket', bucketStart, cursorEnd,
          )
        }
        contractTimelineEvents.push(...bucketEvents)
        const observedTransition = selectPreferredContractTransition(contractTimelineEvents, firstFailureAt, supportedContracts, supportedContractGroups)
        if (observedTransition && observedTransition.key !== 'type') break
        cursorEnd = bucketStart
        if (bucket >= 1) bucketMs = Math.min(bucketMs * 2, scope.timelineBucketMinutes * 60 * 1000)
      }
      const transition = selectPreferredContractTransition(contractTimelineEvents, firstFailureAt, supportedContracts, supportedContractGroups)
      if (transition) comparisonStart = transition.firstUnsupportedAt
    }
    const comparisonBeforeStart = Math.max(beforeStart, comparisonStart - scope.timelineBucketMinutes * 60 * 1000)
    const comparisonEnd = Math.min(incidentEnd, Math.max(comparisonStart + 30 * 60 * 1000, firstFailureAt || comparisonStart))
    let beforeEvents = hasDirectComparison
      ? uniqueBy(directControlEvents, event => event.eventId || `${event.timestamp || 0}:${event.message || ''}`)
      : contractTimelineEvents.filter(event => (event.timestamp || 0) < comparisonStart)
    let afterEvents = hasDirectComparison
      ? uniqueBy(directIncidentEvents, event => event.eventId || `${event.timestamp || 0}:${event.message || ''}`)
      : contractTimelineEvents.filter(event => (event.timestamp || 0) >= comparisonStart && (event.timestamp || 0) <= comparisonEnd)
    if (beforeEvents.length === 0) {
      beforeEvents = await readLogWindow('compare_contract', 'Read pre-failure Lambda contract timeline', comparisonBeforeStart, comparisonStart, contractFilter)
    }
    if (afterEvents.length === 0) {
      afterEvents = await readLogWindow('compare_contract', 'Read post-failure Lambda contract timeline', comparisonStart, comparisonEnd, contractFilter)
    }
    let before = extractContract(beforeEvents)
    let after = extractContract(afterEvents)
    if (!hasContractDiscriminator(before) || !hasContractDiscriminator(after)) {
      const [broadBefore, broadAfter] = await Promise.all([
        readLogWindow('compare_contract', 'Read fallback pre-failure Lambda contract timeline', comparisonBeforeStart, comparisonStart),
        readLogWindow('compare_contract', 'Read fallback post-failure Lambda contract timeline', comparisonStart, comparisonEnd),
      ])
      if (!hasContractDiscriminator(before)) before = extractContract(broadBefore)
      if (!hasContractDiscriminator(after)) after = extractContract(broadAfter)
    }
    const relevantErrorEvents = uniqueBy(timelineErrorEvents, event => event.eventId || `${event.timestamp || 0}:${event.message || ''}`)
      .filter(event => /\b(?:error|exception|failed|failure|traceback|timeout|typeerror|attributeerror|keyerror|nullpointer|deleted from|ineligible)\b/i.test(event.message || ''))
      .filter(event => {
        if (!failureSignature || failureSignatureForMessage(event.message || '') === failureSignature) return true
        if (!firstFailureAt || !event.timestamp) return false
        return Math.abs(event.timestamp - firstFailureAt) <= 5 * 60 * 1000
      })
      .sort((left, right) => (left.timestamp || 0) - (right.timestamp || 0))
    const errors = relevantErrorEvents
      .slice(0, 20)
      .map(event => ({
        timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : undefined,
        message: summarizeRuntimeFailure(event.message || ''),
        signals: runtimeSignals(event.message || ''),
      }))

    return {
      region,
      configuration,
      errors,
      before,
      after,
      contractTransition: selectPreferredContractTransition(
        uniqueBy([...directControlEvents, ...directIncidentEvents, ...contractTimelineEvents], event =>
          event.eventId || `${event.timestamp || 0}:${event.message || ''}`),
        firstFailureAt || incidentEnd,
        supportedContracts,
        supportedContractGroups,
      ),
      timeline: failureSignature ? {
        failureSignature,
        firstFailureAt: firstFailureAt ? new Date(firstFailureAt).toISOString() : undefined,
        comparisonStart: new Date(comparisonStart).toISOString(),
        lookbackExhausted,
      } : undefined,
      artifact,
    }
  }

  private async collectQueueMetrics(
    request: InvestigationAdapterRequest,
    node: TopologyNode,
    run: <T>(phase: InvestigationAdapterTraceStep['phase'], title: string, args: string[]) => Promise<T | undefined>,
  ): Promise<QueueMetricSummary | undefined> {
    const region = node.region
    if (!region || !node.name) return undefined
    const { beforeStart, incidentStart, incidentEnd } = comparisonWindow(request)
    const metricDataQueries = [
      ['sent', 'NumberOfMessagesSent'],
      ['received', 'NumberOfMessagesReceived'],
      ['deleted', 'NumberOfMessagesDeleted'],
    ].map(([id, metricName]) => ({
      Id: id,
      MetricStat: {
        Metric: {
          Namespace: 'AWS/SQS',
          MetricName: metricName,
          Dimensions: [{ Name: 'QueueName', Value: node.name }],
        },
        Period: 300,
        Stat: 'Sum',
      },
      ReturnData: true,
    }))
    const response = await run<CloudWatchMetricData>('compare_contract', 'Compare SQS stage input and output metrics', [
      'cloudwatch', 'get-metric-data', '--region', region,
      '--metric-data-queries', JSON.stringify(metricDataQueries),
      '--start-time', new Date(beforeStart).toISOString(),
      '--end-time', new Date(incidentEnd).toISOString(),
      '--scan-by', 'TimestampAscending', '--output', 'json',
    ])
    if (!response) return undefined
    const result: QueueMetricSummary = {
      queueId: node.id,
      queueName: node.name,
      region,
      before: { sent: 0, received: 0, deleted: 0 },
      incident: { sent: 0, received: 0, deleted: 0 },
    }
    for (const metric of response.MetricDataResults || []) {
      const id = metric.Id as 'sent' | 'received' | 'deleted' | undefined
      if (!id || !(id in result.before)) continue
      for (let index = 0; index < (metric.Values || []).length; index += 1) {
        const timestamp = Date.parse(metric.Timestamps?.[index] || '')
        const value = Number(metric.Values?.[index] || 0)
        if (!Number.isFinite(timestamp) || !Number.isFinite(value)) continue
        if (timestamp < incidentStart) result.before[id] += value
        else result.incident[id] += value
      }
    }
    return result
  }
}

function ticketText(request: InvestigationAdapterRequest): string {
  return [
    request.scope.clientId,
    ...(request.scope.serviceIds || []),
    ...(request.scope.keywords || []),
    request.scope.ticketContext?.title,
    request.scope.ticketContext?.description,
    ...(request.scope.ticketContext?.extractedTerms || []),
    ...(request.scope.planningContext?.searchHints || []),
  ].filter(Boolean).join('\n')
}

function relevantServices(
  request: InvestigationAdapterRequest,
  allowed: InvestigationServerlessService[],
): Set<InvestigationServerlessService> {
  const text = ticketText(request).toLowerCase()
  const requested = new Set<InvestigationServerlessService>(['lambda'])
  if (/\b(?:sns|sqs|queue|publisher|subscriber|message|event publishing)\b/.test(text)) {
    requested.add('sns')
    requested.add('sqs')
  }
  if (/\b(?:eventbridge|event bus)\b/.test(text)) requested.add('events')
  if (/\b(?:api gateway|webhook)\b/.test(text)) requested.add('apigateway')
  return new Set(allowed.filter(service => requested.has(service)))
}

function functionInvestigationScore(functionName: string, request: InvestigationAdapterRequest): number {
  const name = normalize(functionName)
  const text = ticketText(request).toLowerCase()
  let score = 0
  for (const term of [...(request.scope.serviceIds || []), ...(request.scope.planningContext?.searchHints || [])]) {
    const candidate = normalize(term)
    if (candidate.length >= 4 && name.includes(candidate)) score += 60
  }
  if (/\b(?:not receiving|stopped|missing|dropped|ineligible|subscriber|route|routing)\b/.test(text)) {
    if (/(?:filter|router|routing|subscriber)/.test(name)) score += 50
    if (/(?:publisher|producer)/.test(name)) score += 30
  }
  if (/\b(?:queue|message|event publishing)\b/.test(text) && /(?:filter|processor|consumer)/.test(name)) score += 20
  return score
}

function seedResourceMatches(
  value: string | undefined,
  request: InvestigationAdapterRequest,
  scope: InvestigationServerlessEvidenceScope,
): boolean {
  const raw = value || ''
  const candidate = normalize(raw)
  if (!candidate || environmentConflicts(raw, request.scope.environment)) return false
  if (scope.resourceNameExclusions.some(term => candidate.includes(normalize(term)))) return false
  const identities = unique([request.scope.clientId, scope.clientId, ...scope.resourceNameHints])
    .map(normalize)
    .filter(term => term.length >= 3)
  return identities.some(term => candidate.includes(term))
}

function environmentConflicts(value: string, environment: InvestigationAdapterRequest['scope']['environment']): boolean {
  const tokens = value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  const has = (pattern: RegExp): boolean => tokens.some(token => pattern.test(token))
  if (environment === 'PROD_REPLICA') return has(/^(?:uat|int|dev|qa|test|demo|pilot)\d*$/)
  if (environment === 'UAT') return has(/^(?:prod|int|dev|qa|test|demo|pilot)\d*$/)
  if (environment === 'INT') return has(/^(?:prod|uat|dev|qa|test|demo|pilot)\d*$/)
  if (environment === 'DEV') return has(/^(?:prod|uat|int|qa|test|demo|pilot)\d*$/)
  return false
}

function normalize(value: string | undefined): string {
  return (value || '').toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function functionNameFromArn(value: string): string {
  const marker = ':function:'
  return value.includes(marker) ? value.split(marker)[1].split(':')[0] : value.split(':').pop() || value
}

function lambdaArnFromIntegrationUri(value: string | undefined): string | undefined {
  if (!value) return undefined
  return value.match(/arn:aws[a-z-]*:lambda:[^/]+:function:[A-Za-z0-9-_]+/)?.[0]
}

function parseDeadLetterArn(value: string | undefined): string | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { deadLetterTargetArn?: string }
    return parsed.deadLetterTargetArn
  } catch {
    return undefined
  }
}

function comparisonWindow(request: InvestigationAdapterRequest, lookbackHours = 72): { beforeStart: number; incidentStart: number; incidentEnd: number } {
  const now = Date.now()
  const incidentStart = validTime(request.scope.timeWindow?.startTs, now - 24 * 60 * 60 * 1000)
  const incidentEnd = Math.max(incidentStart + 60_000, Math.min(validTime(request.scope.timeWindow?.endTs, now), now))
  const observedSpan = Math.max(15 * 60 * 1000, Math.min(incidentEnd - incidentStart, 24 * 60 * 60 * 1000))
  const controlSpan = Math.max(observedSpan, lookbackHours * 60 * 60 * 1000)
  return { beforeStart: incidentStart - controlSpan, incidentStart, incidentEnd }
}

function validTime(value: string | undefined, fallback: number): number {
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function extractContract(events: Array<{ message?: string; timestamp?: number }>): ContractSnapshot {
  const discriminatorValues: Record<string, Set<string>> = {}
  const fieldTypes: Record<string, Set<string>> = {}
  let eventCount = 0
  let errorCount = 0
  const observations: Array<{ timestamp?: string; key: string; value: string }> = []
  for (const event of events) {
    if (/\b(?:error|exception|failed|failure|traceback|timeout|typeerror|attributeerror|keyerror|nullpointer|deleted from|ineligible)\b/i.test(event.message || '')) {
      errorCount += 1
    }
    const objects = jsonObjects(event.message || '')
    let observed = false
    for (const object of objects) {
      eventCount += 1
      observed = true
      flattenContract(object, '', fieldTypes)
      for (const key of CONTRACT_KEYS) {
        for (const value of findValues(object, key)) {
          if (typeof value !== 'string' || value.length > 100) continue
          const safeValue = sanitizeContractValue(value)
          ;(discriminatorValues[key] ||= new Set()).add(safeValue)
          observations.push({ timestamp: eventTimestamp(event), key, value: safeValue })
        }
      }
    }
    for (const key of CONTRACT_KEYS) {
      const pattern = new RegExp(`(?:^|[^A-Za-z0-9_])["']?${escapeRegex(key)}["']?\\s*[:=]\\s*["']([^"']{1,100})["']`, 'i')
      const match = (event.message || '').match(pattern)
      if (!match?.[1]) continue
      ;(discriminatorValues[key] ||= new Set()).add(sanitizeContractValue(match[1]))
      observations.push({ timestamp: eventTimestamp(event), key, value: sanitizeContractValue(match[1]) })
      observed = true
    }
    if (observed && objects.length === 0) eventCount += 1
  }
  return {
    discriminatorValues: mapSets(discriminatorValues),
    fieldTypes: mapSets(fieldTypes),
    eventCount,
    errorCount,
    observations: uniqueBy(observations, observation => `${observation.timestamp}:${observation.key}:${observation.value}`),
  }
}

function hasContractDiscriminator(snapshot: ContractSnapshot): boolean {
  return Object.values(snapshot.discriminatorValues).some(values => values.length > 0)
}

function selectContractTransition(
  events: NonNullable<LogEvents['events']>,
  supported: Record<string, string[]>,
  excludedIncidentValues: Record<string, string[]> = {},
): ContractTransition | undefined {
  const observations = events
    .flatMap(event => extractContract([event]).observations.map(observation => ({
      ...observation,
      timestampMs: Date.parse(observation.timestamp || ''),
    })))
    .filter(observation => Number.isFinite(observation.timestampMs))
    .sort((left, right) => left.timestampMs - right.timestampMs)
  for (const key of CONTRACT_KEYS) {
    const allowed = supported[key] || []
    if (allowed.length === 0) continue
    const groups = new Map<number, Set<string>>()
    for (const observation of observations.filter(observation => observation.key === key)) {
      const values = groups.get(observation.timestampMs) || new Set<string>()
      values.add(observation.value)
      groups.set(observation.timestampMs, values)
    }
    let control: { timestampMs: number; values: Set<string> } | undefined
    for (const [timestampMs, values] of Array.from(groups).sort(([left], [right]) => left - right)) {
      if (Array.from(values).some(value => allowed.includes(value))) {
        if (control) {
          const prior = Array.from(control.values).find(value => allowed.includes(value))
          const current = Array.from(values).find(value => allowed.includes(value) && value !== prior)
          if (prior && current) {
            return {
              key,
              controlValue: prior,
              incidentValue: current,
              lastSupportedAt: control.timestampMs,
              firstUnsupportedAt: timestampMs,
            }
          }
        }
        control = { timestampMs, values }
        continue
      }
      if (control) {
        const removed = Array.from(control.values).filter(value => allowed.includes(value) && !values.has(value))
        const excluded = excludedIncidentValues[key] || []
        const added = Array.from(values).filter(value =>
          !control?.values.has(value) && !excluded.includes(value),
        )
        if (removed.length === 0 || added.length === 0) continue
        return {
          key,
          controlValue: removed[0],
          incidentValue: added[0],
          lastSupportedAt: control.timestampMs,
          firstUnsupportedAt: timestampMs,
        }
      }
    }
  }
  return undefined
}

function selectPreferredContractTransition(
  events: NonNullable<LogEvents['events']>,
  failureAt: number,
  candidateValues: Record<string, string[]>,
  candidateGroups: Record<string, string[][]> = {},
): ContractTransition | undefined {
  const priority = new Map(CONTRACT_KEYS.map((key, index) => [key, index]))
  const groupedCandidates = Object.entries(candidateGroups).flatMap(([key, groups]) =>
    groups.map(group => ({
      candidates: { [key]: group },
      excluded: { [key]: unique(groups.flat().filter(value => !group.includes(value))) },
    })),
  )
  const candidateSets = groupedCandidates.length > 0
    ? groupedCandidates
    : [{ candidates: candidateValues, excluded: {} }]
  return candidateSets.flatMap(({ candidates, excluded }) => [
    selectObservedContractTransition(events, failureAt, candidates),
    selectContractTransition(events, candidates, excluded),
  ])
    .filter((transition): transition is ContractTransition => Boolean(transition))
    .sort((left, right) => (priority.get(left.key) ?? 999) - (priority.get(right.key) ?? 999))[0]
}

function selectObservedContractTransition(
  events: NonNullable<LogEvents['events']>,
  failureAt: number,
  candidateValues: Record<string, string[]> = {},
): ContractTransition | undefined {
  const observations = events
    .flatMap(event => extractContract([event]).observations.map(observation => ({
      ...observation,
      timestampMs: Date.parse(observation.timestamp || ''),
    })))
    .filter(observation => Number.isFinite(observation.timestampMs) && observation.timestampMs <= failureAt)
    .sort((left, right) => left.timestampMs - right.timestampMs)
  for (const key of CONTRACT_KEYS) {
    const candidates = candidateValues[key] || []
    const keyed = observations.filter(observation =>
      observation.key === key && (candidates.length === 0 || candidates.includes(observation.value)),
    )
    const incident = keyed.at(-1)
    if (!incident) continue
    const control = keyed.slice(0, -1).filter(observation => observation.value !== incident.value).at(-1)
    if (control) {
      const firstIncident = keyed.find(observation =>
        observation.value === incident.value && observation.timestampMs > control.timestampMs,
      ) || incident
      return {
        key,
        controlValue: control.value,
        incidentValue: incident.value,
        lastSupportedAt: control.timestampMs,
        firstUnsupportedAt: firstIncident.timestampMs,
      }
    }
  }
  return undefined
}

function eventTimestamp(event: { timestamp?: number }): string | undefined {
  return event.timestamp && Number.isFinite(event.timestamp) ? new Date(event.timestamp).toISOString() : undefined
}

function jsonObjects(message: string): Record<string, unknown>[] {
  const candidates = [message]
  const start = message.indexOf('{')
  const end = message.lastIndexOf('}')
  if (start >= 0 && end > start) candidates.push(message.slice(start, end + 1))
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return [parsed as Record<string, unknown>]
    } catch { /* bounded log lines are often not JSON */ }
  }
  return []
}

function flattenContract(value: unknown, path: string, target: Record<string, Set<string>>, depth = 0): void {
  if (depth > 6 || !value || typeof value !== 'object') return
  for (const [key, child] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
    const safeKey = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key) ? key : '<dynamic-key>'
    const next = path ? `${path}.${safeKey}` : safeKey
    const kind = Array.isArray(child) ? 'array' : child === null ? 'null' : typeof child
    ;(target[next] ||= new Set()).add(kind)
    if (kind === 'object') flattenContract(child, next, target, depth + 1)
  }
}

function findValues(value: unknown, wanted: string, depth = 0): string[] {
  if (depth > 6 || !value || typeof value !== 'object') return []
  const result: string[] = []
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (key === wanted && typeof child === 'string') result.push(child)
    result.push(...findValues(child, wanted, depth + 1))
    if (result.length >= 100) break
  }
  return unique(result).slice(0, 100)
}

function inspectArtifact(
  bytes: Buffer,
  expectedSha256: string,
  maxSourceBytes: number,
): ArtifactAnalysis {
  const checksumVerified = createHash('sha256').update(bytes).digest('base64') === expectedSha256
  if (!checksumVerified) return { checksumVerified, inspectedFiles: [], discriminatorValues: {}, discriminatorGroups: {}, hasUncheckedGet: false, uncheckedGetReceivers: [], hasReturnInFinally: false, queueReferences: [] }
  const archive = new AdmZip(bytes)
  const inspectedFiles: string[] = []
  const sources: string[] = []
  let total = 0
  for (const entry of archive.getEntries()) {
    const name = entry.entryName.replace(/\\/g, '/')
    if (entry.isDirectory || name.startsWith('/') || name.split('/').includes('..') || !SOURCE_EXTENSIONS.test(name)) continue
    const size = entry.header.size
    if (size > 256 * 1024 || total + size > maxSourceBytes || inspectedFiles.length >= 40) continue
    const content = entry.getData().toString('utf8')
    total += Buffer.byteLength(content)
    inspectedFiles.push(name)
    sources.push(content)
  }
  const combined = sources.join('\n')
  const discriminatorSupport = extractArtifactDiscriminatorSupport(sources)
  return {
    checksumVerified,
    inspectedFiles,
    discriminatorValues: discriminatorSupport.values,
    discriminatorGroups: discriminatorSupport.groups,
    hasUncheckedGet: /\.(?:get)\s*\([^\n)]*\)/.test(combined),
    uncheckedGetReceivers: rankedGetReceivers(combined),
    hasReturnInFinally: /finally\s*:\s*[\s\S]{0,800}?\breturn\b/.test(combined) || /finally\s*\{[\s\S]{0,800}?\breturn\b/.test(combined),
    queueReferences: unique(Array.from(
      combined.matchAll(/(?:https:\/\/sqs\.[^\s"']+|arn:aws[a-z-]*:sqs:[^\s"']+)/g),
      match => match[0],
    ).filter(isResolvedResourceReference)).slice(0, 20),
  }
}

function extractArtifactDiscriminatorSupport(sources: string[]): {
  values: Record<string, string[]>
  groups: Record<string, string[][]>
} {
  const constants = new Map<string, string>()
  const lines = sources.flatMap(source => source.split(/\r?\n/).slice(0, 20_000))
  for (const rawLine of lines) {
    const line = rawLine.slice(0, 2_000)
    const assignment = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*["']([A-Za-z0-9_.:/-]{1,100})["']/)
    if (assignment?.[1] && assignment[2]) constants.set(assignment[1], assignment[2])
  }

  const discriminatorVariables = new Map<string, string>()
  for (const rawLine of lines) {
    const line = rawLine.slice(0, 2_000)
    for (const key of CONTRACT_KEYS) {
      const escapedKey = escapeRegExp(key)
      const assignment = line.match(new RegExp(
        `^\\s*(?:const\\s+|let\\s+|var\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*=.*(?:\\.get\\(\\s*["']${escapedKey}["']|\\[\\s*["']${escapedKey}["']\\s*\\])`,
      ))
      if (assignment?.[1]) discriminatorVariables.set(assignment[1], key)
    }
  }

  const result: Record<string, string[]> = {}
  const groups: Record<string, string[][]> = {}
  for (const key of CONTRACT_KEYS) {
    const values = new Set<string>()
    const variableNames = Array.from(discriminatorVariables)
      .filter(([, discriminator]) => discriminator === key)
      .map(([variable]) => variable)
    for (const rawLine of lines) {
      const line = rawLine.slice(0, 2_000)
      if (!line.includes(key) && !variableNames.some(variable => containsIdentifier(line, variable))) continue
      const lineValues = new Set<string>()
      const directPattern = /(?:={2,3}|!=|\bin\b|\bnot\s+in\b)\s*[\[(]?\s*["']([A-Za-z0-9_.:/-]{1,100})["']/g
      for (const match of line.matchAll(directPattern)) if (match[1]) lineValues.add(match[1])
      const constantPattern = /(?:={2,3}|!=|\bin\b|\bnot\s+in\b)\s*[\[(]?\s*(?:[A-Za-z_][A-Za-z0-9_]*\.)*([A-Za-z_][A-Za-z0-9_]*)/g
      for (const match of line.matchAll(constantPattern)) {
        const value = match[1] ? constants.get(match[1]) : undefined
        if (value) lineValues.add(value)
      }
      if (lineValues.size) {
        lineValues.forEach(value => values.add(value))
        ;(groups[key] ||= []).push(Array.from(lineValues).slice(0, 20))
      }
    }
    if (values.size) result[key] = Array.from(values).slice(0, 20)
  }
  return {
    values: result,
    groups: Object.fromEntries(Object.entries(groups).map(([key, valueGroups]) => [
      key,
      uniqueBy(valueGroups, group => group.slice().sort().join('|')).slice(0, 20),
    ])),
  }
}

function containsIdentifier(line: string, identifier: string): boolean {
  const index = line.indexOf(identifier)
  if (index < 0) return false
  const before = index > 0 ? line[index - 1] : ''
  const after = line[index + identifier.length] || ''
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function safeAwsResourceReferences(values: Record<string, string>): string[] {
  const references: string[] = []
  for (const value of Object.values(values)) {
    for (const match of value.matchAll(/arn:aws[a-z-]*:(?:sqs|sns|lambda):[A-Za-z0-9-]+:\d{12}:[A-Za-z0-9_.:/-]+/g)) references.push(match[0])
    for (const match of value.matchAll(/https:\/\/sqs\.[A-Za-z0-9-]+\.amazonaws\.com\/\d{12}\/[A-Za-z0-9_.-]+/g)) references.push(match[0])
  }
  return unique(references)
}

function rankedGetReceivers(source: string): string[] {
  const receivers = unique(Array.from(
    source.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]{0,120})\.get\s*\(/g),
    match => match[1],
  ))
  const parameterNames = new Set<string>()
  for (const match of source.matchAll(/(?:\bdef\s+[A-Za-z_]\w*|\bfunction(?:\s+[A-Za-z_]\w*)?)\s*\(([^)]*)\)/g)) {
    for (const parameter of (match[1] || '').split(',')) {
      const name = parameter.trim().replace(/[:=].*$/, '')
      if (/^[A-Za-z_]\w*$/.test(name)) parameterNames.add(name)
    }
  }
  const inputContainers = /^(?:event|context|record|payload|message|body|request|response)$/i
  return receivers.sort((left, right) => {
    const score = (receiver: string): number => {
      const root = receiver.split('.')[0]
      return Number(!parameterNames.has(root)) * 4
        + Number(!inputContainers.test(root)) * 2
        + source.lastIndexOf(`${receiver}.get`) / Math.max(1, source.length)
    }
    return score(right) - score(left)
  }).slice(0, 20)
}

function topologyNodeFromReference(reference: string, fallbackRegion: string): TopologyNode | undefined {
  if (!isResolvedResourceReference(reference)) return undefined
  if (reference.startsWith('https://sqs.')) {
    const parts = new URL(reference).pathname.split('/').filter(Boolean)
    const region = new URL(reference).hostname.split('.')[1] || fallbackRegion
    const name = parts.at(-1)
    if (!name) return undefined
    return { id: reference, kind: 'sqs_queue', name, url: reference, region }
  }
  const parts = reference.split(':')
  const service = parts[2]
  const region = parts[3] || fallbackRegion
  const name = parts.slice(5).join(':')
  if (!name) return undefined
  if (service === 'sqs') return { id: reference, kind: 'sqs_queue', name, arn: reference, region }
  if (service === 'sns') return { id: reference, kind: 'sns_topic', name, arn: reference, region }
  if (service === 'lambda') return { id: reference, kind: 'lambda', name: functionNameFromArn(reference), arn: reference, region }
  return undefined
}

function isResolvedResourceReference(value: string): boolean {
  return !/[{}$%]|(?:%7B|%7D)/i.test(value)
}

function buildCausalMetadata(
  refs: ServerlessEvidenceRefs,
  nodes: TopologyNode[],
  edges: TopologyEdge[],
  inspections: FunctionInspection[],
  queueMetrics: QueueMetricSummary[],
): CausalMetadata {
  const evidenceFacts: Record<ServerlessEvidenceSource, unknown[]> = {
    topology: edges.map((edge, index) => fact(`topology-${index}`, 'configuration', edge.from, edge.relation, edge.to, refs.topology)),
    runtime: [],
    deployment: [],
    metrics: [],
  }
  const rcaLinks: Record<ServerlessEvidenceSource, unknown[]> = { topology: [], runtime: [], deployment: [], metrics: [] }
  const symptomClusters: unknown[] = []
  for (const inspection of inspections) {
    const name = inspection.configuration.FunctionName || inspection.configuration.FunctionArn || 'lambda-function'
    const chainId = `serverless-contract:${normalize(name)}`
    const clusterId = `serverless-runtime:${normalize(name)}`
    if (inspection.errors.length) {
      evidenceFacts.runtime.push(fact(`runtime-${normalize(name)}`, 'runtime_failure', name, 'emitted incident errors', inspection.errors.flatMap(error => error.signals).join(', ') || 'runtime error', refs.runtime))
      const runtimeError = representativeRuntimeError(inspection.errors)
      const impact = inspection.errors.some(error => error.signals.includes('message_deleted'))
        ? 'The message was deleted instead of following the normal retry or recovery path.'
        : inspection.errors.some(error => error.signals.includes('not_eligible'))
          ? 'The message was classified as ineligible for downstream delivery.'
          : undefined
      rcaLinks.runtime.push(link(
        chainId,
        name,
        `serverless-component:${name}`,
        'emitted',
        `runtime-failure:${name}`,
        ['failure', 'impacted_scope', 'proof'],
        `${name} emitted the bounded incident runtime failure signal. Trigger and mechanism remain unresolved until contract or code-path evidence is linked.`,
        [refs.runtime],
        { component: name, error: runtimeError?.message, impact },
        true,
      ))
    }
    const changes = contractChanges(inspection.before, inspection.after)
    for (const change of changes) evidenceFacts.runtime.push(fact(`contract-${normalize(name)}-${normalize(change.key)}`, 'change', `${name}:${change.key}`, 'changed from', change.before.join(', ') || 'absent', refs.runtime, undefined, undefined, change.after.join(', ') || 'absent'))
    const supported = inspection.artifact?.checksumVerified ? inspection.artifact.discriminatorValues : {}
    const failureAt = Date.parse(inspection.timeline?.firstFailureAt || '')
    const deployedAt = Date.parse(inspection.configuration.LastModified || '')
    const artifactWasActiveAtFailure = Boolean(
      inspection.artifact?.checksumVerified
      && (!Number.isFinite(failureAt) || !Number.isFinite(deployedAt) || deployedAt <= failureAt),
    )
    const incompatible = artifactWasActiveAtFailure ? selectIncompatibleChange(changes, supported) : undefined
    const observedChange = selectMeaningfulContractChange(changes)
    const chronologicalChange = inspection.contractTransition
      ? {
          key: inspection.contractTransition.key,
          before: [inspection.contractTransition.controlValue],
          after: [inspection.contractTransition.incidentValue],
        }
      : undefined
    const causalChange = incompatible || (!artifactWasActiveAtFailure ? chronologicalChange || observedChange : undefined)
    if (inspection.errors.length) {
      symptomClusters.push({
        id: clusterId,
        label: `${name} runtime failure`,
        material: Boolean(causalChange),
        evidenceRefs: [refs.runtime],
        explainedByChainIds: causalChange ? [chainId] : [],
      })
    }
    if (inspection.errors.length && causalChange) {
      const triggerNode = `payload-contract:${causalChange.key}:${causalChange.after.join('|')}`
      const handlerNode = `deployed-handler:${name}`
      const trigger = `${causalChange.key} changed from ${causalChange.before.join(', ') || 'absent'} to ${causalChange.after.join(', ')}`
      const runtimeError = representativeRuntimeError(inspection.errors)
      const receiver = artifactWasActiveAtFailure ? inspection.artifact?.uncheckedGetReceivers[0] : undefined
      const operation = receiver
        ? `${receiver}.get()`
        : /attribute ['"]get['"]|\.get\b/i.test(runtimeError?.message || '') ? 'get()' : undefined
      const impact = inspection.errors.some(error => error.signals.includes('message_deleted'))
        ? 'The message was deleted instead of following the normal retry or recovery path.'
        : inspection.errors.some(error => error.signals.includes('not_eligible'))
          ? 'The message was classified as ineligible for downstream delivery.'
          : undefined
      rcaLinks.runtime.push(
        link(
          chainId,
          name,
          triggerNode,
          'reached',
          handlerNode,
          ['trigger', 'impacted_scope', 'unaffected_scope', 'proof'],
          incompatible
            ? `The incident payload changed ${causalChange.key} from ${causalChange.before.join(', ') || 'absent'} to ${causalChange.after.join(', ')}, while the checksum-verified incident handler recognizes ${supported[causalChange.key].join(', ')}.`
            : `Chronological runtime evidence changed ${causalChange.key} from ${causalChange.before.join(', ') || 'absent'} to ${causalChange.after.join(', ')} before the recurring Lambda failure; the currently deployed artifact postdates that failure and was not treated as the incident artifact.`,
          incompatible ? [refs.runtime, refs.deployment] : [refs.runtime],
          { component: name, trigger },
          true,
        ),
      )
      rcaLinks.runtime.push(
        link(chainId, name, handlerNode, 'emitted', `runtime-failure:${name}`, ['failure', 'mechanism', 'proof'], `The handler produced incident runtime errors after receiving the incompatible payload contract.`, [refs.runtime], {
          component: name,
          operation,
          error: runtimeError?.message,
          failureHandling: impact ? 'Runtime evidence shows the failed message was deleted instead of being retained for normal retry or recovery.' : undefined,
          impact,
        }, true),
      )
      const control = controlTransition(inspection, causalChange.key, causalChange.before, causalChange.after)
      if (control) {
        rcaLinks.runtime.push(link(
          chainId,
          name,
          `control-contract:${causalChange.key}:${control.supportedValue}`,
          'preceded the incompatible contract at',
          handlerNode,
          ['unaffected_scope', 'trigger', 'proof'],
          `A bounded control observation used ${causalChange.key}=${control.supportedValue}${control.lastSupportedAt ? ` at ${control.lastSupportedAt}` : ''}; ${causalChange.key}=${control.incompatibleValue}${control.firstIncompatibleAt ? ` appeared at ${control.firstIncompatibleAt}` : ''}.`,
          [refs.runtime],
        ))
      }
      if (artifactWasActiveAtFailure && inspection.artifact?.hasReturnInFinally) {
        rcaLinks.deployment.push(link(chainId, name, handlerNode, 'suppresses failure propagation through', 'return-in-finally', ['mechanism', 'proof'], 'The checksum-verified deployed handler returns from a finally block, which can suppress failure propagation and normal retry behavior.', [refs.runtime, refs.deployment], {
          component: name,
          failureHandling: 'A return inside finally suppresses the exception and normal retry propagation.',
          impact,
        }, true))
      }
      if (!artifactWasActiveAtFailure && inspection.artifact?.checksumVerified && Number.isFinite(deployedAt)) {
        rcaLinks.deployment.push(link(
          chainId,
          name,
          handlerNode,
          'has a newer checksum-verified deployment at',
          `post-incident-deployment:${name}:${new Date(deployedAt).toISOString()}`,
          ['proof'],
          `The current checksum-verified package was deployed at ${new Date(deployedAt).toISOString()}, after the observed failure, so Cockpit excluded it as evidence of the incident-time implementation.`,
          [refs.deployment],
        ))
        evidenceFacts.deployment.push(fact(
          `post-incident-deployment-${normalize(name)}`,
          'change',
          handlerNode,
          'was redeployed after the observed failure at',
          new Date(deployedAt).toISOString(),
          refs.deployment,
          chainId,
          clusterId,
        ))
      }
    }
  }
  for (const comparison of queueBoundaryComparisons(edges, queueMetrics)) {
    const chainId = `serverless-boundary:${normalize(comparison.queueName)}`
    evidenceFacts.metrics.push(fact(`boundary-${normalize(comparison.queueName)}`, 'comparison', comparison.queueName, 'changed stage throughput from', String(comparison.before), refs.metrics, undefined, undefined, String(comparison.incident)))
    rcaLinks.metrics.push(link(chainId, comparison.queueName, comparison.from, 'stopped before', comparison.to, ['failure', 'impacted_scope', 'unaffected_scope', 'trigger', 'proof'], comparison.summary, [refs.topology, refs.metrics]))
  }
  return { evidenceFacts, rcaLinks, symptomClusters }
}

function controlTransition(
  inspection: FunctionInspection,
  key: string,
  supportedValues: string[],
  incompatibleValues: string[],
): { supportedValue: string; incompatibleValue: string; lastSupportedAt?: string; firstIncompatibleAt?: string } | undefined {
  const observations = [...inspection.before.observations, ...inspection.after.observations]
    .filter(observation => observation.key === key)
    .sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')))
  const supported = observations.filter(observation => supportedValues.includes(observation.value)).at(-1)
  const incompatible = observations.find(observation =>
    incompatibleValues.includes(observation.value)
    && (!supported?.timestamp || !observation.timestamp || observation.timestamp >= supported.timestamp),
  )
  if (!supported || !incompatible) return undefined
  return {
    supportedValue: supported.value,
    incompatibleValue: incompatible.value,
    lastSupportedAt: supported.timestamp,
    firstIncompatibleAt: incompatible.timestamp,
  }
}

function queueBoundaryComparisons(
  edges: TopologyEdge[],
  metrics: QueueMetricSummary[],
): Array<{ queueName: string; from: string; to: string; before: number; incident: number; summary: string }> {
  const result: Array<{ queueName: string; from: string; to: string; before: number; incident: number; summary: string }> = []
  for (const metric of metrics) {
    if (metric.before.sent <= 0 || metric.incident.sent > 0) continue
    const incoming = edges.find(edge => edge.to === metric.queueId)
    if (!incoming) continue
    result.push({
      queueName: metric.queueName,
      from: incoming.from,
      to: metric.queueId,
      before: metric.before.sent,
      incident: metric.incident.sent,
      summary: `${metric.queueName} received ${metric.before.sent} message(s) in the bounded control period and ${metric.incident.sent} in the incident period, localizing the loss before this stage.`,
    })
  }
  return result
}

function contractChanges(before: ContractSnapshot, after: ContractSnapshot): Array<{ key: string; before: string[]; after: string[] }> {
  return unique([...Object.keys(before.discriminatorValues), ...Object.keys(after.discriminatorValues)])
    .map(key => {
      const beforeValues = before.discriminatorValues[key] || []
      const afterValues = after.discriminatorValues[key] || []
      const removed = beforeValues.filter(value => !afterValues.includes(value))
      const added = afterValues.filter(value => !beforeValues.includes(value))
      return { key, before: removed.length ? removed : beforeValues, after: added.length ? added : afterValues }
    })
    .filter(change => change.before.length && change.after.length)
    .filter(change => JSON.stringify(change.before.slice().sort()) !== JSON.stringify(change.after.slice().sort()))
}

function selectIncompatibleChange(
  changes: Array<{ key: string; before: string[]; after: string[] }>,
  supported: Record<string, string[]>,
): { key: string; before: string[]; after: string[] } | undefined {
  const priority = new Map(CONTRACT_KEYS.map((key, index) => [key, index]))
  return changes
    .filter(change => (supported[change.key] || []).length > 0)
    .filter(change => change.after.some(value => !(supported[change.key] || []).includes(value)))
    .sort((left, right) => (priority.get(left.key) ?? 999) - (priority.get(right.key) ?? 999))[0]
}

function selectMeaningfulContractChange(
  changes: Array<{ key: string; before: string[]; after: string[] }>,
): { key: string; before: string[]; after: string[] } | undefined {
  const priority = new Map(CONTRACT_KEYS.map((key, index) => [key, index]))
  return changes
    .filter(change => change.before.length > 0 && change.after.length > 0)
    .filter(change =>
      change.before.every(value => !change.after.includes(value))
      && change.after.every(value => !change.before.includes(value)),
    )
    .sort((left, right) => (priority.get(left.key) ?? 999) - (priority.get(right.key) ?? 999))[0]
}

function fact(id: string, type: InvestigationEvidenceFactType, subject: string, predicate: string, object: string, ref: string, chainId?: string, symptomClusterId?: string, value?: string): unknown {
  return { id, type, subject, predicate, object, ...(value ? { value } : {}), ...(chainId ? { chainIds: [chainId] } : {}), ...(symptomClusterId ? { symptomClusterId } : {}), confidence: 0.94, evidenceRefs: [ref], sourceRef: ref, redactionState: 'redacted' }
}

function link(chainId: string, hypothesis: string, from: string, relation: string, to: string, dimensions: string[], summary: string, refs: string[], causalRoles?: CausalRoles, precisionRequired = false): unknown {
  return { chainId, hypothesis: `A producer/consumer contract incompatibility affected ${hypothesis}.`, from, relation, to, dimensions, summary, evidenceRefs: refs, confidence: 0.94, polarity: 'supports', ...(causalRoles ? { causalRoles } : {}), ...(precisionRequired ? { precisionRequired: true } : {}) }
}

function toSafeRuntimeInspection(inspection: FunctionInspection): unknown {
  return {
    functionName: inspection.configuration.FunctionName,
    functionArn: inspection.configuration.FunctionArn,
    handler: inspection.configuration.Handler,
    runtime: inspection.configuration.Runtime,
    lastModified: inspection.configuration.LastModified,
    timeout: inspection.configuration.Timeout,
    environmentVariableNames: Object.keys(inspection.configuration.Environment?.Variables || {}).sort(),
    safeResourceReferences: safeAwsResourceReferences(inspection.configuration.Environment?.Variables || {}),
    deadLetterTargetArn: inspection.configuration.DeadLetterConfig?.TargetArn,
    errors: inspection.errors,
    timeline: inspection.timeline,
    contractTransition: inspection.contractTransition ? {
      key: inspection.contractTransition.key,
      controlValue: inspection.contractTransition.controlValue,
      incidentValue: inspection.contractTransition.incidentValue,
      lastSupportedAt: new Date(inspection.contractTransition.lastSupportedAt).toISOString(),
      firstUnsupportedAt: new Date(inspection.contractTransition.firstUnsupportedAt).toISOString(),
    } : undefined,
    preIncidentContract: inspection.before,
    incidentContract: inspection.after,
  }
}

function toSafeDeploymentInspection(inspection: FunctionInspection): unknown {
  return {
    functionName: inspection.configuration.FunctionName,
    functionArn: inspection.configuration.FunctionArn,
    handler: inspection.configuration.Handler,
    runtime: inspection.configuration.Runtime,
    lastModified: inspection.configuration.LastModified,
    codeSha256: inspection.configuration.CodeSha256,
    environmentVariableNames: Object.keys(inspection.configuration.Environment?.Variables || {}).sort(),
    safeResourceReferences: safeAwsResourceReferences(inspection.configuration.Environment?.Variables || {}),
    artifact: inspection.artifact,
  }
}

function summarizeEvidence(nodes: TopologyNode[], edges: TopologyEdge[], inspections: FunctionInspection[]): string {
  const errors = inspections.reduce((sum, inspection) => sum + inspection.errors.length, 0)
  const verified = inspections.filter(inspection => inspection.artifact?.checksumVerified).length
  return `Discovered ${nodes.length} scoped AWS integration resource(s), traced ${edges.length} relationship(s), inspected ${inspections.length} Lambda runtime(s), observed ${errors} bounded error event(s), and checksum-verified ${verified} deployed package(s).`
}

function limitationFinding(request: InvestigationAdapterRequest, failures: string[]): InvestigationFinding {
  return {
    id: `${request.runId}-aws-serverless-limitations`,
    adapter: 'aws',
    type: 'serverless_evidence_limitation',
    severity: 'medium',
    confidence: 0.45,
    title: 'Some AWS serverless evidence could not be collected',
    summary: failures.slice(0, 5).join(' '),
    evidenceRefs: [],
    requiresCodeChange: false,
    requiresDataChange: false,
  }
}

function runtimeSignals(message: string): string[] {
  return unique([
    ...Array.from(message.matchAll(/\b[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception)\b/g), match => match[0]),
    ...Array.from(message.matchAll(/\b(?:4\d\d|5\d\d)\b/g), match => match[0]),
    ...(/deleted from (?:the )?queue/i.test(message) ? ['message_deleted'] : []),
    ...(/not eligible/i.test(message) ? ['not_eligible'] : []),
  ]).slice(0, 20)
}

function summarizeRuntimeFailure(message: string): string {
  const signals = runtimeSignals(message)
  const mechanism = message.match(/(?:['"]?(?:NoneType|null|undefined)['"]?\s+object\s+has\s+no\s+attribute\s+['"][A-Za-z_][A-Za-z0-9_]*['"]|cannot\s+read\s+(?:properties|property)\s+of\s+(?:null|undefined))/i)?.[0]
  const operation = message.match(/\b[A-Za-z_][A-Za-z0-9_.]{0,120}\.get\b/)?.[0]
  return unique([
    ...signals,
    ...(mechanism ? [mechanism] : []),
    ...(operation ? [`${operation} failed`] : []),
  ]).join(', ') || 'runtime failure matched the approved error filter'
}

function representativeRuntimeError(
  errors: FunctionInspection['errors'],
): FunctionInspection['errors'][number] | undefined {
  return errors.slice().sort((left, right) => {
    const score = (entry: FunctionInspection['errors'][number]): number =>
      Number(/\.get\b|has no attribute|cannot read/i.test(entry.message)) * 8
      + Number(entry.signals.some(signal => /(?:Error|Exception)$/i.test(signal))) * 4
      + Number(entry.signals.includes('message_deleted')) * 2
      + Number(entry.signals.includes('not_eligible'))
    return score(right) - score(left)
  })[0]
}

function failureSignatureForMessage(message: string): string | undefined {
  const signals = runtimeSignals(message)
    .filter(signal => signal === 'message_deleted' || signal === 'not_eligible' || /(?:Error|Exception)$/i.test(signal))
    .sort()
  if (signals.length > 0) return signals.join('|')
  if (/\b(?:error|failed|failure|traceback|timeout)\b/i.test(message)) return 'generic-runtime-failure'
  return undefined
}

function selectDominantFailureSignature(events: NonNullable<LogEvents['events']>): string | undefined {
  const counts = new Map<string, number>()
  for (const event of events) {
    const signature = failureSignatureForMessage(event.message || '')
    if (signature) counts.set(signature, (counts.get(signature) || 0) + 1)
  }
  return Array.from(counts).sort(([leftSignature, leftCount], [rightSignature, rightCount]) => {
    const score = (signature: string, count: number): number => count * 2
      + Number(signature !== 'generic-runtime-failure') * 4
      + Number(/(?:Error|Exception)/.test(signature)) * 2
    return score(rightSignature, rightCount) - score(leftSignature, leftCount)
  })[0]?.[0]
}

function earliestSignatureTimestamp(
  events: NonNullable<LogEvents['events']>,
  signature: string | undefined,
): number | undefined {
  if (!signature) return undefined
  return events
    .filter(event => failureSignatureForMessage(event.message || '') === signature)
    .map(event => event.timestamp)
    .filter((timestamp): timestamp is number => Number.isFinite(timestamp))
    .sort((left, right) => left - right)[0]
}

function recurringFailureOnset(
  events: NonNullable<LogEvents['events']>,
  signature: string,
): number | undefined {
  const timestamps = unique(events
    .filter(event => failureSignatureForMessage(event.message || '') === signature)
    .map(event => event.timestamp)
    .filter((timestamp): timestamp is number => Number.isFinite(timestamp))
    .sort((left, right) => left - right)
    .map(timestamp => String(Math.floor(timestamp / (5 * 60 * 1000)))))
    .map(bucket => Number(bucket) * 5 * 60 * 1000)
  if (timestamps.length < 2) return timestamps[0]
  let boundary = timestamps[0]
  let largestGap = 0
  for (let index = 1; index < timestamps.length; index += 1) {
    const gap = timestamps[index] - timestamps[index - 1]
    if (gap >= 2 * 60 * 60 * 1000 && gap > largestGap) {
      largestGap = gap
      boundary = timestamps[index]
    }
  }
  return boundary
}

function safeCommandDescription(args: string[]): string {
  const hiddenAfter = new Set(['--function-name', '--queue-url', '--topic-arn', '--event-source-arn'])
  return args.map((arg, index) => hiddenAfter.has(args[index - 1]) ? '<scoped-resource>' : arg).join(' ').slice(0, 500)
}

function safeError(error: unknown): string {
  return redactInvestigationText(error instanceof Error ? error.message : String(error)).replace(/https:\/\/[^\s]+/g, '<redacted-url>').slice(0, 500)
}

function sanitizeRuntimeMessage(value: string): string {
  return redactInvestigationText(value)
    .replace(/\b[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\b/gi, '<redacted-id>')
    .replace(/\b\d{6,}(?:\/\d+)?\b/g, '<redacted-id>')
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '<redacted-email>')
    .replace(/\s+/g, ' ')
    .slice(0, 500)
}

function sanitizeContractValue(value: string): string {
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(value)) return '<redacted-value>'
  if (/\b\d{6,}(?:\/\d+)?\b/.test(value)) return '<redacted-value>'
  if (/\b[A-F0-9]{8}(?:-[A-F0-9]{4}){3}-[A-F0-9]{12}\b/i.test(value)) return '<redacted-value>'
  return redactInvestigationText(value)
}

function mapSets(input: Record<string, Set<string>>): Record<string, string[]> {
  return Object.fromEntries(Object.entries(input).map(([key, values]) => [key, Array.from(values).sort().slice(0, 30)]))
}

function unique<T>(values: T[], selector?: (value: T) => string): T[] {
  const seen = new Set<string>()
  return values.filter(value => {
    const key = selector ? selector(value) : String(value)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function uniqueBy<T>(values: T[], selector: (value: T) => string): T[] {
  return unique(values, selector)
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = []
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size))
  return result
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
