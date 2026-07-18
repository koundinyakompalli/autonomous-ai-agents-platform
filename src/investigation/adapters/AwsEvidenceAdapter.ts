import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AwsEvidenceAdapter } from './types.js'
import type {
  InvestigationAdapterRequest,
  InvestigationAdapterResult,
  InvestigationEvidenceArtifact,
  InvestigationFinding,
  InvestigationLogSource,
} from '../types/investigation.js'
import type { InvestigationHostTargetRegistry, InvestigationHostTarget } from '../data/HostTargetRegistry.js'
import type { InvestigationServerlessEvidenceConfig } from '../config/InvestigationTargetConfig.js'
import { ServerlessIntegrationEvidenceCollector } from './ServerlessIntegrationEvidenceCollector.js'
import {
  extractInvestigationSignals,
  redactInvestigationText,
} from '../utils/RuntimeEvidence.js'

const execFileAsync = promisify(execFile)

interface AwsCliJsonCommand {
  args: string[]
}

export interface CliCommandRunner {
  runJson<T>(command: AwsCliJsonCommand, timeoutMs?: number): Promise<T>
}

class AwsCliRunner implements CliCommandRunner {
  constructor(private readonly profile?: string) {}

  async runJson<T>(command: AwsCliJsonCommand, timeoutMs = DEFAULT_AWS_CLI_TIMEOUT_MS): Promise<T> {
    const baseArgs = this.profile ? ['--profile', this.profile] : []
    const { stdout } = await execFileAsync('aws', [...baseArgs, ...command.args], {
      maxBuffer: 1024 * 1024 * 4,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    })
    return JSON.parse(stdout) as T
  }
}

interface CallerIdentity {
  Account?: string
  Arn?: string
}

interface Ec2DescribeInstancesResponse {
  Reservations?: Array<{
    Instances?: Array<{
      InstanceId?: string
      State?: { Name?: string }
      PlatformDetails?: string
      IamInstanceProfile?: { Arn?: string }
      VpcId?: string
      SubnetId?: string
      PrivateIpAddress?: string
    }>
  }>
}

interface Ec2DescribeRegionsResponse {
  Regions?: Array<{
    RegionName?: string
    OptInStatus?: string
  }>
}

interface SsmDescribeInstanceInformationResponse {
  InstanceInformationList?: Array<{
    InstanceId?: string
    PingStatus?: string
    PlatformName?: string
    PlatformVersion?: string
    AgentVersion?: string
    LastPingDateTime?: string
  }>
}

interface CloudWatchDescribeLogGroupsResponse {
  logGroups?: Array<{
    logGroupName?: string
    creationTime?: number
    retentionInDays?: number
    storedBytes?: number
  }>
}

interface CloudWatchFilterLogEventsResponse {
  events?: Array<{
    eventId?: string
    logGroupName?: string
    logStreamName?: string
    timestamp?: number
    message?: string
  }>
}

interface S3ListObjectsV2Response {
  KeyCount?: number
  IsTruncated?: boolean
  Contents?: Array<{
    Key?: string
    LastModified?: string
    Size?: number
  }>
}

interface S3GetBucketLocationResponse {
  LocationConstraint?: string | null
}

interface LogSourceCollection {
  findings: InvestigationFinding[]
  evidence: InvestigationEvidenceArtifact[]
  requestsIssued: number
}

interface ResolvedCloudWatchSource {
  source: InvestigationLogSource
  logGroupName: string
  region: string
}

interface ResolvedS3ArchiveSource {
  source: InvestigationLogSource
  bucket: string
  prefix: string
  region: string
  maxObjects: number
}

const DEFAULT_S3_ARCHIVE_OBJECT_LIMIT = 10
const DEFAULT_CLOUDWATCH_EVENT_LIMIT = 10
const MAX_CLOUDWATCH_GROUP_EVENT_SCANS = 8
const MAX_DYNAMIC_AWS_REGION_SCANS = 24
const DYNAMIC_AWS_REGION = 'aws-dynamic'
const DEFAULT_AWS_LOG_DISCOVERY_REGIONS = ['us-east-2', 'us-east-1']
const DEFAULT_RUNTIME_FILTER_PATTERN = '?ERROR ?Error ?Exception ?exception ?failed ?failure ?timeout ?truncation ?DataTruncation ?"too long for column" ?" 500 " ?" 502 " ?" 503 " ?" 504 " ?" 400 " ?" 401 " ?" 403 " ?" 404 "'
const DEFAULT_AWS_CLI_TIMEOUT_MS = 15_000
const SERVERLESS_PROBE_INTENTS = new Set([
  'trace_message_route',
  'identify_queue_consumer',
  'inspect_serverless_runtime_failure',
  'compare_message_contract',
  'inspect_deployed_handler',
  'verify_recovery_semantics',
])

function commandTimeoutMs(request: InvestigationAdapterRequest): number {
  const configured = Number(request.constraints.timeoutMs)
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_AWS_CLI_TIMEOUT_MS
  }
  return Math.max(1_000, Math.min(configured, 60_000))
}

function serverlessCollectionTimeoutMs(request: InvestigationAdapterRequest): number {
  const configured = Number(request.constraints.timeoutMs)
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_AWS_CLI_TIMEOUT_MS
  }
  return Math.max(1_000, Math.min(configured, 120_000))
}

function normalizeLookup(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[_\s]+/g, '-')
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, key: string) => values[key] ?? '')
}

function s3Prefix(value: string): string {
  return value.replace(/^\/+/, '')
}

function safeErrorMessage(error: unknown): string {
  return redactInvestigationText(error instanceof Error ? error.message : String(error))
    .replace(/\b(AKIA|ASIA)[A-Z0-9]{16}\b/g, '<redacted-access-key>')
}

function cloudWatchTimeWindowArgs(request: InvestigationAdapterRequest): string[] {
  const now = Date.now()
  const defaultStart = now - 24 * 60 * 60 * 1000
  const start = request.scope.timeWindow?.startTs
    ? new Date(request.scope.timeWindow.startTs).getTime()
    : defaultStart
  const end = request.scope.timeWindow?.endTs
    ? new Date(request.scope.timeWindow.endTs).getTime()
    : now

  return [
    '--start-time',
    String(Number.isFinite(start) ? start : defaultStart),
    '--end-time',
    String(Number.isFinite(end) ? end : now),
  ]
}

function summarizeRuntimeSignalScope(signals: string[]): string {
  const statusCodes = signals.filter(signal => /^[45]\d\d$/.test(signal))
  const exceptions = signals.filter(signal => /(?:Exception|Error)$/.test(signal))
  const configTerms = signals.filter(signal => /\.(?:url|uri|endpoint|host|path|enabled|allowed|timeout|baseUrl|serviceUrl|server|port)$/i.test(signal))
  const pieces = [
    statusCodes.length ? `${statusCodes.length} status signal(s)` : null,
    exceptions.length ? `${exceptions.length} exception/error signal(s)` : null,
    configTerms.length ? `${configTerms.length} config/property signal(s)` : null,
  ].filter((entry): entry is string => Boolean(entry))
  return pieces.length ? pieces.join(', ') : `${signals.length} runtime signal(s)`
}

function isDynamicAwsRegion(region: string | undefined): boolean {
  return !region || region === DYNAMIC_AWS_REGION || region === 'auto'
}

function orderedAwsRegions(regions: string[]): string[] {
  const ordered = [
    ...DEFAULT_AWS_LOG_DISCOVERY_REGIONS,
    ...regions,
  ]
    .map(region => region.trim())
    .filter(Boolean)
  return Array.from(new Set(ordered)).slice(0, MAX_DYNAMIC_AWS_REGION_SCANS)
}

function normalizeS3BucketRegion(region: string | null | undefined): string {
  if (!region || region === 'null') {
    return 'us-east-1'
  }
  if (region === 'EU') {
    return 'eu-west-1'
  }
  return region
}

export class NoopAwsEvidenceAdapter implements AwsEvidenceAdapter {
  readonly kind = 'aws' as const

  async execute(_request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    return {
      findings: [],
      evidence: [],
      telemetry: {
        durationMs: 0,
        requestsIssued: 0,
      },
    }
  }
}

export class CliAwsEvidenceAdapter implements AwsEvidenceAdapter {
  readonly kind = 'aws' as const
  private readonly logSources: InvestigationLogSource[]
  private readonly runnerFactory: (target: InvestigationHostTarget) => CliCommandRunner
  private readonly serverlessCollector: ServerlessIntegrationEvidenceCollector

  constructor(
    private readonly hostRegistry: InvestigationHostTargetRegistry,
    logSources: InvestigationLogSource[] = [],
    runnerFactory: (target: InvestigationHostTarget) => CliCommandRunner = target => new AwsCliRunner(target.awsProfile),
    serverlessConfig: InvestigationServerlessEvidenceConfig = DEFAULT_SERVERLESS_EVIDENCE_CONFIG,
  ) {
    this.logSources = logSources
    this.runnerFactory = runnerFactory
    this.serverlessCollector = new ServerlessIntegrationEvidenceCollector(serverlessConfig)
  }

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const activeIntent = request.scope.planningContext?.activeProbeIntent
    if (!activeIntent || !SERVERLESS_PROBE_INTENTS.has(activeIntent)) {
      return this.executeCore(request)
    }
    if (!this.serverlessCollector.shouldCollect(request)) return this.executeCore(request)
    const target = await this.hostRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      request.scope.hostTargets?.[0],
    )
    if (!target) return this.executeCore(request)
    const serverless = await this.serverlessCollector.collect(
      request,
      target,
      this.runnerFactory(target),
      serverlessCollectionTimeoutMs(request),
    )
    if (serverless.findings.length || serverless.evidence.length) {
      request.onPartialResult?.(serverless)
      return serverless
    }
    return mergeAwsResults(await this.executeCore(request), serverless)
  }

  private async executeCore(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now()
    const target = await this.hostRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      request.scope.hostTargets?.[0],
    )

    if (!target) {
      return {
        findings: [
          {
            id: `${request.runId}-aws-no-target`,
            adapter: 'aws',
            type: 'aws_scope_resolution',
            severity: 'high',
            confidence: 0.88,
            title: 'No approved AWS target was found for this investigation scope',
            summary: `The AWS adapter could not resolve a host target for ${request.scope.clientId} ${request.scope.environment}.`,
            evidenceRefs: [],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
        ],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
        },
      }
    }

    if (target.networkPath === 'ssh_public' && target.ssmAllowed === false) {
      const runner = this.runnerFactory(target)
      const logCollection = await this.collectLogSourceEvidence(request, target, runner, commandTimeoutMs(request))
      const hasSshHost = Boolean(target.publicHost) && target.sshAllowed !== false
      return {
        findings: [
          {
            id: `${request.runId}-aws-ldap-ssh-scope`,
            adapter: 'aws',
            type: hasSshHost ? 'ldap_ssh_host_scope_selected' : 'aws_log_scope_selected',
            severity: 'medium',
            confidence: 0.72,
            title: hasSshHost
              ? 'Operator LDAP SSH target selected for bounded host access'
              : 'AWS log evidence scope selected without SSM host access',
            summary: hasSshHost
              ? `Cockpit selected ${target.instanceName} for ${request.scope.clientId} ${request.scope.environment} using operator LDAP SSH; AWS SSM collection is disabled for this scope.`
              : `Cockpit selected ${target.instanceName} for ${request.scope.clientId} ${request.scope.environment} using the AWS profile for approved log-source collection; AWS SSM and SSH host collection are disabled for this scope.`,
            evidenceRefs: [`${request.runId}-aws-ldap-ssh-scope`],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
          ...logCollection.findings,
        ],
        evidence: [
          {
            id: `${request.runId}-aws-ldap-ssh-scope`,
            adapter: 'aws',
            title: hasSshHost ? 'Operator LDAP SSH scope' : 'AWS log evidence scope',
            summary: hasSshHost
              ? `Runtime scope is ${target.clientId} ${target.environment}; host access is delegated to the Host adapter over SSH, not SSM.`
              : `Runtime scope is ${target.clientId} ${target.environment}; AWS collection is limited to approved CloudWatch/S3 log-source metadata and redacted samples.`,
            contentType: 'application/json',
            metadata: {
              networkPath: target.networkPath,
              ssmAllowed: target.ssmAllowed,
              sshAuthMode: target.sshAuthMode,
              sshControlPath: target.sshControlPath,
              publicHost: target.publicHost,
              logOnly: !hasSshHost,
              rawCredentialsStored: false,
              traceSteps: [
                {
                  title: hasSshHost ? 'Resolved Jira-scoped SSH target' : 'Resolved Jira-scoped AWS log target',
                  detail: hasSshHost
                    ? `Selected ${target.instanceName} with networkPath=ssh_public and sshAuthMode=operator_ldap.`
                    : `Selected ${target.instanceName} with AWS profile based log collection and no SSM/SSH host access.`,
                },
                {
                  title: 'Bypass SSM collection',
                  detail: hasSshHost
                    ? 'SSM is disabled for this LDAP SSH scope; Cockpit will not invoke aws ssm for host access.'
                    : 'SSM is disabled for this log-only scope; Cockpit will not invoke aws ssm for host access.',
                },
              ],
            },
          },
          ...logCollection.evidence,
        ],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: logCollection.requestsIssued,
        },
      }
    }

    const runner = this.runnerFactory(target)
    const timeoutMs = commandTimeoutMs(request)

    try {
      const [caller, ec2, ssm] = await Promise.all([
        runner.runJson<CallerIdentity>({ args: ['sts', 'get-caller-identity', '--output', 'json'] }, timeoutMs),
        runner.runJson<Ec2DescribeInstancesResponse>({
          args: ['ec2', 'describe-instances', '--region', target.region, '--instance-ids', target.instanceId, '--output', 'json'],
        }, timeoutMs),
        runner.runJson<SsmDescribeInstanceInformationResponse>({
          args: [
            'ssm',
            'describe-instance-information',
            '--region',
            target.region,
            '--filters',
            `Key=InstanceIds,Values=${target.instanceId}`,
            '--output',
            'json',
          ],
        }, timeoutMs),
      ])

      const instance = ec2.Reservations?.[0]?.Instances?.[0]
      const ssmInfo = ssm.InstanceInformationList?.[0]
      const pingStatus = ssmInfo?.PingStatus ?? 'Unknown'
      const isOnline = pingStatus.toLowerCase() === 'online'
      const logCollection = await this.collectLogSourceEvidence(request, target, runner, timeoutMs)

      return {
        findings: [
          {
            id: `${request.runId}-aws-target-ready`,
            adapter: 'aws',
            type: 'host_target_ready',
            severity: isOnline ? 'medium' : 'high',
            confidence: isOnline ? 0.68 : 0.55,
            title: isOnline
              ? `${target.instanceName} host target is reachable for bounded triage`
              : `${target.instanceName} host target resolved, but SSM reachability is degraded`,
            summary: isOnline
              ? `Resolved ${target.instanceName} (${target.instanceId}) in ${target.region}; SSM is online and host probe can continue.`
              : `Resolved ${target.instanceName} (${target.instanceId}) in ${target.region}, but the SSM ping status is ${pingStatus}.`,
            evidenceRefs: [
              `${request.runId}-aws-account`,
              `${request.runId}-aws-instance`,
              ...logCollection.evidence.map(artifact => artifact.id),
            ],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
          ...logCollection.findings,
        ],
        evidence: [
          {
            id: `${request.runId}-aws-account`,
            adapter: 'aws',
            title: 'AWS caller identity',
            summary: `Caller resolved to account ${caller.Account ?? 'unknown'} and ARN ${caller.Arn ?? 'unknown'}.`,
            contentType: 'application/json',
            metadata: {
              traceSteps: [
                {
                  title: 'Resolved host target',
                  detail: `Selected ${target.instanceId} from the approved host registry for ${target.clientId} ${target.environment}.`,
                },
                {
                  title: 'Read caller identity',
                  detail: 'Confirmed the active AWS identity before collecting instance evidence.',
                },
              ],
            },
          },
          {
            id: `${request.runId}-aws-instance`,
            adapter: 'aws',
            title: 'EC2 and SSM posture',
            summary: `Instance ${instance?.InstanceId ?? target.instanceId} is ${instance?.State?.Name ?? 'unknown'} with SSM status ${pingStatus}.`,
            contentType: 'application/json',
            metadata: {
              instanceId: instance?.InstanceId ?? target.instanceId,
              privateIp: instance?.PrivateIpAddress,
              platformDetails: instance?.PlatformDetails,
              instanceProfileArn: instance?.IamInstanceProfile?.Arn,
              vpcId: instance?.VpcId,
              subnetId: instance?.SubnetId,
              traceSteps: [
                {
                  title: 'Read EC2 instance metadata',
                  detail: `Collected state, platform, network, and instance profile details for ${target.instanceId}.`,
                },
                {
                  title: 'Read SSM managed-instance state',
                  detail: `Observed ping status ${pingStatus}${ssmInfo?.AgentVersion ? ` and agent version ${ssmInfo.AgentVersion}` : ''}.`,
                },
              ],
            },
          },
          ...logCollection.evidence,
        ],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 3 + logCollection.requestsIssued,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        findings: [
          {
            id: `${request.runId}-aws-access-failure`,
            adapter: 'aws',
            type: 'aws_access_failure',
            severity: 'critical',
            confidence: 0.2,
            title: 'AWS evidence collection failed for the approved Client A target',
            summary: message,
            evidenceRefs: [],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
        ],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 1,
        },
      }
    }
  }

  private resolveLogSources(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
  ): {
    cloudwatch: ResolvedCloudWatchSource[]
    s3Archives: ResolvedS3ArchiveSource[]
  } {
    const serviceIds = new Set((request.scope.serviceIds || []).map(normalizeLookup))
    const templateValues = {
      client: target.clientId,
      clientId: target.clientId,
      env: target.envId || request.scope.environment,
      envId: target.envId || request.scope.environment,
      environment: request.scope.environment,
      region: target.region,
    }

    const scoped = this.logSources.filter(source => {
      if (!source.enabled || source.clientId !== target.clientId || source.environment !== request.scope.environment) {
        return false
      }
      if (source.serviceId && serviceIds.size > 0 && !serviceIds.has(normalizeLookup(source.serviceId))) {
        return false
      }
      return true
    })

    const cloudwatch: ResolvedCloudWatchSource[] = []
    const s3Archives: ResolvedS3ArchiveSource[] = []

    for (const source of scoped) {
      const sourceEnvId = source.envId || target.envId || request.scope.environment
      const values = {
        ...templateValues,
        env: sourceEnvId,
        envId: sourceEnvId,
        serviceId: source.serviceId || request.scope.serviceIds?.[0] || '',
        component: source.component || '',
      }
      if (source.kind === 'cloudwatch') {
        const logGroupName = source.logGroupName || (source.logGroupTemplate ? renderTemplate(source.logGroupTemplate, values) : '')
        if (logGroupName) {
          cloudwatch.push({
            source,
            logGroupName,
            region: source.region || target.region,
          })
        }
      } else if (source.kind === 's3_archive' && source.bucket) {
        const prefix = source.prefix || (source.prefixTemplate ? renderTemplate(source.prefixTemplate, values) : '')
        if (prefix) {
          s3Archives.push({
            source,
            bucket: source.bucket,
            prefix: s3Prefix(prefix),
            region: source.region || target.region,
            maxObjects: source.maxObjects || DEFAULT_S3_ARCHIVE_OBJECT_LIMIT,
          })
        }
      }
    }

    return { cloudwatch, s3Archives }
  }

  private async cloudWatchRegionsForEntry(
    entry: ResolvedCloudWatchSource,
    runner: CliCommandRunner,
    countRequest: () => void,
    timeoutMs: number,
  ): Promise<string[]> {
    if (!isDynamicAwsRegion(entry.region)) {
      return [entry.region]
    }

    try {
      countRequest()
      const response = await runner.runJson<Ec2DescribeRegionsResponse>({
        args: [
          'ec2',
          'describe-regions',
          '--region',
          'us-east-1',
          '--all-regions',
          '--filters',
          'Name=opt-in-status,Values=opt-in-not-required,opted-in',
          '--output',
          'json',
        ],
      }, timeoutMs)
      const discovered = (response.Regions || [])
        .map(region => region.RegionName)
        .filter((region): region is string => Boolean(region))
      return orderedAwsRegions(discovered)
    } catch {
      return DEFAULT_AWS_LOG_DISCOVERY_REGIONS
    }
  }

  private async s3ArchiveRegionsForEntry(
    entry: ResolvedS3ArchiveSource,
    runner: CliCommandRunner,
    countRequest: () => void,
    timeoutMs: number,
  ): Promise<string[]> {
    if (!isDynamicAwsRegion(entry.region)) {
      return [entry.region]
    }

    try {
      countRequest()
      const response = await runner.runJson<S3GetBucketLocationResponse>({
        args: [
          's3api',
          'get-bucket-location',
          '--region',
          'us-east-1',
          '--bucket',
          entry.bucket,
          '--output',
          'json',
        ],
      }, timeoutMs)
      return [normalizeS3BucketRegion(response.LocationConstraint)]
    } catch {
      return ['us-east-1']
    }
  }

  private async collectLogSourceEvidence(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    runner: CliCommandRunner,
    timeoutMs: number,
  ): Promise<LogSourceCollection> {
    const resolved = this.resolveLogSources(request, target)
    const findings: InvestigationFinding[] = []
    const evidence: InvestigationEvidenceArtifact[] = []
    let requestsIssued = 0

    if (resolved.cloudwatch.length > 0) {
      const inspectedGroups: Array<{
        sourceId: string
        requestedName: string
        region: string
        matchedNames: string[]
        storedBytes: number
        optional: boolean
        error?: string
      }> = []
      const redactedSamples: Array<{
        sourceId: string
        logGroupName: string
        logStreamName?: string
        timestamp?: string
        message: string
        signals: string[]
      }> = []
      const runtimeSignals = new Set<string>()

      for (const entry of resolved.cloudwatch) {
        const regions = await this.cloudWatchRegionsForEntry(entry, runner, () => {
          requestsIssued += 1
        }, timeoutMs)
        for (const region of regions) {
          try {
            requestsIssued += 1
            const response = await runner.runJson<CloudWatchDescribeLogGroupsResponse>({
              args: [
                'logs',
                'describe-log-groups',
                '--region',
                region,
                '--log-group-name-prefix',
                entry.logGroupName,
                '--limit',
                '20',
                '--output',
                'json',
              ],
            }, timeoutMs)
            const groups = response.logGroups || []
            inspectedGroups.push({
              sourceId: entry.source.id,
              requestedName: entry.logGroupName,
              region,
              matchedNames: groups
                .map(group => group.logGroupName)
                .filter((name): name is string => Boolean(name)),
              storedBytes: groups.reduce((total, group) => total + (group.storedBytes || 0), 0),
              optional: Boolean(entry.source.optional),
            })

            for (const logGroupName of groups
              .map(group => group.logGroupName)
              .filter((name): name is string => Boolean(name))
              .slice(0, MAX_CLOUDWATCH_GROUP_EVENT_SCANS)) {
              try {
                requestsIssued += 1
                const eventsResponse = await runner.runJson<CloudWatchFilterLogEventsResponse>({
                  args: [
                    'logs',
                    'filter-log-events',
                    '--region',
                    region,
                    '--log-group-name',
                    logGroupName,
                    '--filter-pattern',
                    entry.source.filterPattern || DEFAULT_RUNTIME_FILTER_PATTERN,
                    '--limit',
                    String(entry.source.maxEvents || DEFAULT_CLOUDWATCH_EVENT_LIMIT),
                    ...cloudWatchTimeWindowArgs(request),
                    '--output',
                    'json',
                  ],
                }, timeoutMs)
                for (const event of eventsResponse.events || []) {
                  const redacted = redactInvestigationText(event.message || '').slice(0, 600)
                  const signals = extractInvestigationSignals(redacted)
                  signals.forEach(signal => runtimeSignals.add(signal))
                  redactedSamples.push({
                    sourceId: entry.source.id,
                    logGroupName,
                    logStreamName: event.logStreamName,
                    timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : undefined,
                    message: redacted,
                    signals,
                  })
                }
              } catch (error) {
                redactedSamples.push({
                  sourceId: entry.source.id,
                  logGroupName,
                  message: `CloudWatch filter-log-events failed: ${safeErrorMessage(error)}`,
                  signals: [],
                })
              }
            }
          } catch (error) {
            inspectedGroups.push({
              sourceId: entry.source.id,
              requestedName: entry.logGroupName,
              region,
              matchedNames: [],
              storedBytes: 0,
              optional: Boolean(entry.source.optional),
              error: safeErrorMessage(error),
            })
          }
        }
      }

      const matchedCount = inspectedGroups.reduce((total, group) => total + group.matchedNames.length, 0)
      const evidenceId = `${request.runId}-aws-cloudwatch-log-sources`
      evidence.push({
        id: evidenceId,
        adapter: 'aws',
        title: 'Approved CloudWatch log sources',
        summary: `Selected ${matchedCount} CloudWatch log group(s) from ${resolved.cloudwatch.length} approved source definition(s) and captured ${redactedSamples.length} redacted runtime event sample(s).`,
        contentType: 'application/json',
        metadata: {
          collectionMode: 'direct_cloudwatch_describe_and_filter_log_events',
          rawLogEventsStored: false,
          redactedSamples,
          inspectedGroups,
          traceSteps: [
            {
              title: 'Resolved approved log group prefixes',
              detail: 'Rendered client/environment log-source templates without storing raw ticket prose.',
            },
            {
              title: 'Described CloudWatch log groups',
              detail: 'Used aws logs describe-log-groups to bound the approved log group scope.',
            },
            {
              title: 'Sampled redacted runtime events',
              detail: `Used aws logs filter-log-events with bounded filter patterns and stored only redacted snippets from ${redactedSamples.length} event sample(s).`,
            },
          ],
        },
      })
      findings.push({
        id: `${request.runId}-aws-cloudwatch-sources-selected`,
        adapter: 'aws',
        type: 'cloudwatch_log_sources_selected',
        severity: matchedCount > 0 ? 'medium' : 'low',
        confidence: matchedCount > 0 ? 0.72 : 0.42,
        title: matchedCount > 0 ? 'CloudWatch log sources matched investigation scope' : 'CloudWatch log source scope checked without matching groups',
        summary: matchedCount > 0
          ? `Found ${matchedCount} CloudWatch group(s) across ${resolved.cloudwatch.length} approved source definition(s).`
          : 'CloudWatch source selection ran, but no configured log groups were found in the target account/region.',
        evidenceRefs: [evidenceId],
        requiresCodeChange: false,
        requiresDataChange: false,
      })
      if (runtimeSignals.size > 0) {
        findings.push({
          id: `${request.runId}-aws-runtime-error-evidence`,
          adapter: 'aws',
          type: 'runtime_log_error_evidence',
          severity: 'medium',
          confidence: 0.66,
          title: 'Runtime logs contain ticket-relevant error/config signals',
          summary: `Redacted CloudWatch samples yielded ${summarizeRuntimeSignalScope(Array.from(runtimeSignals))}.`,
          evidenceRefs: [evidenceId],
          requiresCodeChange: true,
          requiresDataChange: false,
        })
      }
    }

    if (resolved.s3Archives.length > 0) {
      const archives: Array<{
        sourceId: string
        bucket: string
        prefix: string
        region: string
        objectCount: number
        isTruncated?: boolean
        latestLastModified?: string
        error?: string
      }> = []

      for (const entry of resolved.s3Archives) {
        const regions = await this.s3ArchiveRegionsForEntry(entry, runner, () => {
          requestsIssued += 1
        }, timeoutMs)
        for (const region of regions) {
          try {
            requestsIssued += 1
            const response = await runner.runJson<S3ListObjectsV2Response>({
              args: [
                's3api',
                'list-objects-v2',
                '--region',
                region,
                '--bucket',
                entry.bucket,
                '--prefix',
                entry.prefix,
                '--max-keys',
                String(entry.maxObjects),
                '--output',
                'json',
              ],
            }, timeoutMs)
            const contents = response.Contents || []
            archives.push({
              sourceId: entry.source.id,
              bucket: entry.bucket,
              prefix: entry.prefix,
              region,
              objectCount: response.KeyCount ?? contents.length,
              isTruncated: response.IsTruncated,
              latestLastModified: contents
                .map(item => item.LastModified)
                .filter((value): value is string => Boolean(value))
                .sort()
                .at(-1),
            })
          } catch (error) {
            archives.push({
              sourceId: entry.source.id,
              bucket: entry.bucket,
              prefix: entry.prefix,
              region,
              objectCount: 0,
              error: safeErrorMessage(error),
            })
          }
        }
      }

      const objectCount = archives.reduce((total, archive) => total + archive.objectCount, 0)
      const evidenceId = `${request.runId}-aws-s3-archive-log-sources`
      evidence.push({
        id: evidenceId,
        adapter: 'aws',
        title: 'Approved S3 archived log sources',
        summary: `Selected ${resolved.s3Archives.length} S3 archive prefix(es) with ${objectCount} visible object metadata result(s).`,
        contentType: 'application/json',
        metadata: {
          collectionMode: 'direct_s3_list_objects_v2_metadata_only',
          bucketPolicy: 'configured_archive_sources_only',
          noObjectBodiesDownloaded: true,
          archives,
          traceSteps: [
            {
              title: 'Resolved configured S3 archive prefixes',
              detail: `Rendered approved archive prefixes for ${target.clientId} ${target.envId || request.scope.environment}.`,
            },
            {
              title: 'Listed S3 object metadata',
              detail: 'Used aws s3api list-objects-v2 only; archived log object bodies were not downloaded.',
            },
          ],
        },
      })
      findings.push({
        id: `${request.runId}-aws-s3-archive-sources-selected`,
        adapter: 'aws',
        type: 's3_archive_log_sources_selected',
        severity: objectCount > 0 ? 'info' : 'low',
        confidence: objectCount > 0 ? 0.62 : 0.46,
        title: 'S3 archived log source scope selected from Cockpit config',
        summary: objectCount > 0
          ? `S3 archive source selection found metadata for ${objectCount} object(s) under approved prefixes.`
          : 'S3 archive source selection ran, but no objects were visible under the approved prefixes.',
        evidenceRefs: [evidenceId],
        requiresCodeChange: false,
        requiresDataChange: false,
      })
    }

    return { findings, evidence, requestsIssued }
  }
}

const DEFAULT_SERVERLESS_EVIDENCE_CONFIG: InvestigationServerlessEvidenceConfig = {
  defaults: {
    enabled: true,
    resourceNameHints: [],
    resourceNameExclusions: [],
    services: ['lambda', 'sns', 'sqs', 'events', 'apigateway'],
    regions: [],
    maxResources: 8,
    maxRequests: 120,
    maxLogEvents: 50,
    timelineLookbackHours: 72,
    timelineBucketMinutes: 360,
    timelineMaxPagesPerWindow: 2,
    timelineMaxEventsPerWindow: 200,
    inspectDeploymentPackages: true,
    maxDeploymentPackageBytes: 15 * 1024 * 1024,
    maxInspectedSourceBytes: 1024 * 1024,
  },
  scopes: [],
}

function mergeAwsResults(left: InvestigationAdapterResult, right: InvestigationAdapterResult): InvestigationAdapterResult {
  return {
    findings: uniqueArtifacts([...left.findings, ...right.findings]),
    evidence: uniqueArtifacts([...left.evidence, ...right.evidence]),
    telemetry: {
      durationMs: left.telemetry.durationMs + right.telemetry.durationMs,
      requestsIssued: left.telemetry.requestsIssued + right.telemetry.requestsIssued,
      rowsRead: (left.telemetry.rowsRead || 0) + (right.telemetry.rowsRead || 0) || undefined,
      artifactsStored: (left.telemetry.artifactsStored || 0) + (right.telemetry.artifactsStored || 0) || undefined,
      traceSteps: [...(left.telemetry.traceSteps || []), ...(right.telemetry.traceSteps || [])],
    },
  }
}

function uniqueArtifacts<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>()
  return items.filter(item => !seen.has(item.id) && Boolean(seen.add(item.id)))
}
