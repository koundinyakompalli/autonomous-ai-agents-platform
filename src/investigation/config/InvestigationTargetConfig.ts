import { readFileSync } from 'node:fs'
import type {
  InvestigationCodeDerivedDiagnostic,
  InvestigationCodeSemanticProfile,
  InvestigationCodeSemanticRule,
} from '../data/CodeSemanticProfileRegistry.js'
import type { InvestigationCodeTarget } from '../data/CodeTargetRegistry.js'
import type { InvestigationConnectionTarget } from '../data/ConnectionRegistry.js'
import type {
  InvestigationHostNetworkPath,
  InvestigationHostSshAuthMode,
  InvestigationHostTarget,
} from '../data/HostTargetRegistry.js'
import type {
  InvestigationEnvironment,
  InvestigationLogSource,
  InvestigationQueryPack,
} from '../types/investigation.js'

export interface InvestigationClientTarget {
  id: string
  displayName: string
  aliases: string[]
  defaultEnvironment?: InvestigationEnvironment
  serviceIds?: string[]
  keywords?: string[]
  repoNames?: string[]
  enabled: boolean
}

export type InvestigationServerlessService = 'lambda' | 'sns' | 'sqs' | 'events' | 'apigateway'

export interface InvestigationServerlessEvidenceScope {
  clientId?: string
  environment?: InvestigationEnvironment
  resourceNameHints: string[]
  resourceNameExclusions: string[]
  enabled: boolean
  services: InvestigationServerlessService[]
  regions: string[]
  maxResources: number
  maxRequests: number
  maxLogEvents: number
  timelineLookbackHours: number
  timelineBucketMinutes: number
  timelineMaxPagesPerWindow: number
  timelineMaxEventsPerWindow: number
  inspectDeploymentPackages: boolean
  maxDeploymentPackageBytes: number
  maxInspectedSourceBytes: number
}

export interface InvestigationServerlessEvidenceConfig {
  defaults: InvestigationServerlessEvidenceScope
  scopes: InvestigationServerlessEvidenceScope[]
}

export interface InvestigationTargetConfig {
  clients: InvestigationClientTarget[]
  hostTargets: InvestigationHostTarget[]
  connections: InvestigationConnectionTarget[]
  codeTargets: InvestigationCodeTarget[]
  codeSemanticProfiles: InvestigationCodeSemanticProfile[]
  logSources: InvestigationLogSource[]
  queryPacks: InvestigationQueryPack[]
  serverlessEvidence?: InvestigationServerlessEvidenceConfig
}

type RawRecord = Record<string, unknown>

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  return asArray(value)
    .map(asString)
    .filter((entry): entry is string => Boolean(entry))
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const SERVERLESS_SERVICES: InvestigationServerlessService[] = ['lambda', 'sns', 'sqs', 'events', 'apigateway']

function normalizeServerlessScope(raw: RawRecord, fallback: InvestigationServerlessEvidenceScope): InvestigationServerlessEvidenceScope {
  const services = asStringArray(raw.services)
    .filter((service): service is InvestigationServerlessService => SERVERLESS_SERVICES.includes(service as InvestigationServerlessService))
  return {
    clientId: asString(raw.clientId),
    environment: normalizeInvestigationEnvironment(raw.environment),
    resourceNameHints: asStringArray(raw.resourceNameHints).length
      ? asStringArray(raw.resourceNameHints)
      : fallback.resourceNameHints,
    resourceNameExclusions: asStringArray(raw.resourceNameExclusions).length
      ? asStringArray(raw.resourceNameExclusions)
      : fallback.resourceNameExclusions,
    enabled: asBoolean(raw.enabled, fallback.enabled),
    services: services.length ? services : fallback.services,
    regions: asStringArray(raw.regions).length ? asStringArray(raw.regions) : fallback.regions,
    maxResources: Math.max(1, Math.min(asNumber(raw.maxResources, fallback.maxResources), 25)),
    maxRequests: Math.max(10, Math.min(asNumber(raw.maxRequests, fallback.maxRequests), 250)),
    maxLogEvents: Math.max(1, Math.min(asNumber(raw.maxLogEvents, fallback.maxLogEvents), 200)),
    timelineLookbackHours: Math.max(1, Math.min(asNumber(raw.timelineLookbackHours, fallback.timelineLookbackHours), 336)),
    timelineBucketMinutes: Math.max(15, Math.min(asNumber(raw.timelineBucketMinutes, fallback.timelineBucketMinutes), 1_440)),
    timelineMaxPagesPerWindow: Math.max(1, Math.min(asNumber(raw.timelineMaxPagesPerWindow, fallback.timelineMaxPagesPerWindow), 10)),
    timelineMaxEventsPerWindow: Math.max(10, Math.min(asNumber(raw.timelineMaxEventsPerWindow, fallback.timelineMaxEventsPerWindow), 2_000)),
    inspectDeploymentPackages: asBoolean(raw.inspectDeploymentPackages, fallback.inspectDeploymentPackages),
    maxDeploymentPackageBytes: Math.max(1_048_576, Math.min(asNumber(raw.maxDeploymentPackageBytes, fallback.maxDeploymentPackageBytes), 52_428_800)),
    maxInspectedSourceBytes: Math.max(65_536, Math.min(asNumber(raw.maxInspectedSourceBytes, fallback.maxInspectedSourceBytes), 5_242_880)),
  }
}

function normalizeServerlessEvidence(value: unknown): InvestigationServerlessEvidenceConfig {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as RawRecord : {}
  const base: InvestigationServerlessEvidenceScope = {
    enabled: true,
    resourceNameHints: [],
    resourceNameExclusions: [],
    services: [...SERVERLESS_SERVICES],
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
  }
  const defaults = normalizeServerlessScope(
    raw.defaults && typeof raw.defaults === 'object' ? raw.defaults as RawRecord : raw,
    base,
  )
  return {
    defaults,
    scopes: asArray(raw.scopes).map(scope => normalizeServerlessScope(scope as RawRecord, defaults)),
  }
}

function normalizeHostNetworkPath(value: unknown): InvestigationHostNetworkPath {
  const normalized = asString(value)
  if (normalized === 'private_vpc') {
    return 'private_vpc'
  }
  if (normalized === 'ssh_public' || normalized === 'public_ssh') {
    return 'ssh_public'
  }
  return 'ssm'
}

function normalizeHostSshAuthMode(value: unknown): InvestigationHostSshAuthMode | undefined {
  const normalized = asString(value)
  if (normalized === 'operator_ldap' || normalized === 'service_account') {
    return normalized
  }
  return undefined
}

export function normalizeInvestigationEnvironment(value: unknown): InvestigationEnvironment | undefined {
  const normalized = asString(value)?.toUpperCase().replace(/-/g, '_')
  if (
    normalized === 'DEV'
    || normalized === 'INT'
    || normalized === 'UAT'
    || normalized === 'STAGE'
    || normalized === 'PROD_REPLICA'
  ) {
    return normalized
  }
  return undefined
}

function normalizeClient(raw: RawRecord): InvestigationClientTarget | null {
  const id = asString(raw.id)
  const displayName = asString(raw.displayName) || asString(raw.name) || id
  if (!id || !displayName) {
    return null
  }

  return {
    id,
    displayName,
    aliases: [...new Set([displayName, id, ...asStringArray(raw.aliases)])],
    defaultEnvironment: normalizeInvestigationEnvironment(raw.defaultEnvironment),
    serviceIds: asStringArray(raw.serviceIds),
    keywords: asStringArray(raw.keywords),
    repoNames: asStringArray(raw.repoNames),
    enabled: asBoolean(raw.enabled, true),
  }
}

function normalizeHostTarget(raw: RawRecord): InvestigationHostTarget | null {
  const id = asString(raw.id)
  const clientId = asString(raw.clientId)
  const environment = normalizeInvestigationEnvironment(raw.environment)
  const instanceId = asString(raw.instanceId)
  const region = asString(raw.region)
  if (!id || !clientId || !environment || !instanceId || !region) {
    return null
  }

  return {
    id,
    scopeKind: asString(raw.scopeKind) === 'aws_service' ? 'aws_service' : 'host',
    clientId,
    environment,
    envId: asString(raw.envId) || environment,
    awsAccountId: asString(raw.awsAccountId) || '',
    region,
    instanceId,
    instanceName: asString(raw.instanceName) || id,
    vpcId: asString(raw.vpcId) || '',
    subnetId: asString(raw.subnetId) || '',
    networkPath: normalizeHostNetworkPath(raw.networkPath),
    instanceProfileArn: asString(raw.instanceProfileArn) || '',
    expectedRoleName: asString(raw.expectedRoleName) || '',
    awsProfile: asString(raw.awsProfile),
    publicHost: asString(raw.publicHost) || asString(raw.publicIp) || asString(raw.publicDnsName),
    databaseHost: asString(raw.databaseHost),
    databasePort: asNumber(raw.databasePort, 3306),
    discoveryAliases: asStringArray(raw.discoveryAliases),
    roleHints: asStringArray(raw.roleHints),
    sshPort: asNumber(raw.sshPort, 22),
    sshUser: asString(raw.sshUser),
    sshAuthMode: normalizeHostSshAuthMode(raw.sshAuthMode),
    sshControlPath: asString(raw.sshControlPath),
    sshAllowed: asBoolean(raw.sshAllowed, false),
    configProbePaths: asStringArray(raw.configProbePaths),
    configProbeMaxMatches: asNumber(raw.configProbeMaxMatches, 25),
    batchProbePaths: asStringArray(raw.batchProbePaths),
    batchProbeMaxMatches: asNumber(raw.batchProbeMaxMatches, 25),
    ssmAllowed: asBoolean(raw.ssmAllowed, true),
    enabled: asBoolean(raw.enabled, true),
    notes: asString(raw.notes),
  }
}

function normalizeConnection(raw: RawRecord): InvestigationConnectionTarget | null {
  const id = asString(raw.id)
  const clientId = asString(raw.clientId)
  const environment = normalizeInvestigationEnvironment(raw.environment)
  const host = asString(raw.host)
  const dbUser = asString(raw.dbUser)
  const secretRef = asString(raw.secretRef)
  if (!id || !clientId || !environment || !host || !dbUser || !secretRef) {
    return null
  }

  const topology = asString(raw.topology) === 'rds_mysql' ? 'rds_mysql' : 'ec2_mysql'
  const accessClass = asString(raw.accessClass) === 'prod_replica_ro' ? 'prod_replica_ro' : 'lower_ro'
  const networkPath = asString(raw.networkPath)

  return {
    id,
    clientId,
    environment,
    envId: asString(raw.envId) || environment,
    topology,
    engine: 'mysql',
    host,
    port: asNumber(raw.port, 3306),
    databaseName: asString(raw.databaseName),
    networkPath: networkPath === 'vpn' || networkPath === 'private_vpc'
      ? networkPath
      : networkPath === 'ssh_public' || networkPath === 'ldap_ssh' || networkPath === 'ssh'
        ? 'ssh_public'
        : 'ssm',
    authMode: 'username_password',
    secretRef,
    dbUser,
    hostTargetId: asString(raw.hostTargetId),
    hostAuthFile: asString(raw.hostAuthFile),
    accessClass,
    allowedQueryPacks: asStringArray(raw.allowedQueryPacks),
    phiAccess: false,
    enabled: asBoolean(raw.enabled, true),
    sslRequired: asBoolean(raw.sslRequired, false),
    notes: asString(raw.notes),
  }
}

function normalizeCodeTarget(raw: RawRecord): InvestigationCodeTarget | null {
  const id = asString(raw.id)
  const clientId = asString(raw.clientId)
  const repoName = asString(raw.repoName)
  const repoPath = asString(raw.repoPath)
  if (!id || !clientId || !repoName || !repoPath) {
    return null
  }

  return {
    id,
    clientId,
    environment: normalizeInvestigationEnvironment(raw.environment),
    repoName,
    repoPath,
    repoUrl: asString(raw.repoUrl),
    branch: asString(raw.branch),
    branchCandidates: asStringArray(raw.branchCandidates),
    branchFamilyPatterns: asStringArray(raw.branchFamilyPatterns),
    defaultBranch: asString(raw.defaultBranch),
    refreshFromRemote: asBoolean(raw.refreshFromRemote, true),
    enabled: asBoolean(raw.enabled, true),
    notes: asString(raw.notes),
  }
}

function normalizeLogSource(raw: RawRecord): InvestigationLogSource | null {
  const id = asString(raw.id)
  const clientId = asString(raw.clientId)
  const environment = normalizeInvestigationEnvironment(raw.environment)
  const rawKind = asString(raw.kind)
  const kind = rawKind === 's3_archive' ? 's3_archive' : rawKind === 'cloudwatch' ? 'cloudwatch' : undefined
  if (!id || !clientId || !environment || !kind) {
    return null
  }

  if (kind === 'cloudwatch') {
    const logGroupName = asString(raw.logGroupName)
    const logGroupTemplate = asString(raw.logGroupTemplate)
    if (!logGroupName && !logGroupTemplate) {
      return null
    }
    return {
      id,
      clientId,
      environment,
      envId: asString(raw.envId),
      region: asString(raw.region),
      serviceId: asString(raw.serviceId),
      component: asString(raw.component),
      kind,
      logGroupName,
      logGroupTemplate,
      filterPattern: asString(raw.filterPattern),
      maxEvents: asNumber(raw.maxEvents, 10),
      optional: asBoolean(raw.optional, false),
      enabled: asBoolean(raw.enabled, true),
      notes: asString(raw.notes),
    }
  }

  const bucket = asString(raw.bucket)
  const prefix = asString(raw.prefix)
  const prefixTemplate = asString(raw.prefixTemplate)
  if (!bucket || (!prefix && !prefixTemplate)) {
    return null
  }
  return {
    id,
    clientId,
    environment,
    envId: asString(raw.envId),
    region: asString(raw.region),
    serviceId: asString(raw.serviceId),
    component: asString(raw.component),
    kind,
    bucket,
    prefix,
    prefixTemplate,
    maxObjects: asNumber(raw.maxObjects, 10),
    optional: asBoolean(raw.optional, true),
    enabled: asBoolean(raw.enabled, true),
    notes: asString(raw.notes),
  }
}

function normalizeQueryPack(raw: RawRecord): InvestigationQueryPack | null {
  const id = asString(raw.id)
  const sql = asString(raw.sql)
  const environments = asArray(raw.environments)
    .map(normalizeInvestigationEnvironment)
    .filter((entry): entry is InvestigationEnvironment => Boolean(entry))
  if (!id || !sql || environments.length === 0) {
    return null
  }

  return {
    id,
    description: asString(raw.description) || id,
    environments,
    allowedTables: asStringArray(raw.allowedTables),
    parameterNames: asStringArray(raw.parameterNames),
    sql,
    maxRows: asNumber(raw.maxRows, 100),
    timeoutMs: asNumber(raw.timeoutMs, 5_000),
    redactionTags: asStringArray(raw.redactionTags),
  }
}

function normalizeCodeDerivedDiagnostic(raw: RawRecord): InvestigationCodeDerivedDiagnostic | null {
  const pack = normalizeQueryPack(raw)
  if (!pack) {
    return null
  }

  return {
    ...pack,
    sourceFiles: asStringArray(raw.sourceFiles),
  }
}

function normalizeCodeSemanticRule(raw: unknown): InvestigationCodeSemanticRule | null {
  const record = raw as RawRecord
  const score = typeof record.score === 'number' && Number.isFinite(record.score) ? record.score : undefined
  if (score === undefined) {
    return null
  }

  return {
    score,
    reason: asString(record.reason),
    textAll: asStringArray(record.textAll),
    textAny: asStringArray(record.textAny),
    pathAll: asStringArray(record.pathAll),
    pathAny: asStringArray(record.pathAny),
    previewAll: asStringArray(record.previewAll),
    previewAny: asStringArray(record.previewAny),
    unlessTextAny: asStringArray(record.unlessTextAny),
  }
}

function normalizeCodeSemanticProfile(raw: RawRecord): InvestigationCodeSemanticProfile | null {
  const id = asString(raw.id)
  const title = asString(raw.title) || id
  const preferredTerms = asStringArray(raw.preferredTerms)
  if (!id || !title || preferredTerms.length === 0) {
    return null
  }

  const environments = asArray(raw.environments)
    .map(normalizeInvestigationEnvironment)
    .filter((entry): entry is InvestigationEnvironment => Boolean(entry))
  const priority = typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : undefined

  return {
    id,
    title,
    summary: asString(raw.summary) || title,
    clientId: asString(raw.clientId),
    environments,
    priority,
    matchAll: asStringArray(raw.matchAll),
    matchAny: asStringArray(raw.matchAny),
    preferredTerms,
    pathBoosts: asStringArray(raw.pathBoosts),
    previewBoosts: asStringArray(raw.previewBoosts),
    negativePathTerms: asStringArray(raw.negativePathTerms),
    rules: asArray(raw.rules)
      .map(normalizeCodeSemanticRule)
      .filter((entry): entry is InvestigationCodeSemanticRule => Boolean(entry)),
    dataDiagnostics: asArray(raw.dataDiagnostics)
      .map(entry => normalizeCodeDerivedDiagnostic(entry as RawRecord))
      .filter((entry): entry is InvestigationCodeDerivedDiagnostic => Boolean(entry)),
    enabled: asBoolean(raw.enabled, true),
  }
}

function readJsonConfig(env: NodeJS.ProcessEnv): RawRecord {
  const raw = env.INVESTIGATION_TARGETS_JSON?.trim()
  if (!raw) {
    return {}
  }
  return JSON.parse(raw) as RawRecord
}

function readFileConfig(env: NodeJS.ProcessEnv): RawRecord {
  const file = env.INVESTIGATION_TARGETS_FILE?.trim()
  if (!file) {
    return {}
  }
  return JSON.parse(readFileSync(file, 'utf8')) as RawRecord
}

function mergeConfigs(left: RawRecord, right: RawRecord): RawRecord {
  return {
    clients: [...asArray(left.clients), ...asArray(right.clients)],
    hostTargets: [...asArray(left.hostTargets), ...asArray(right.hostTargets)],
    connections: [...asArray(left.connections), ...asArray(right.connections)],
    codeTargets: [...asArray(left.codeTargets), ...asArray(right.codeTargets)],
    codeSemanticProfiles: [...asArray(left.codeSemanticProfiles), ...asArray(right.codeSemanticProfiles)],
    logSources: [...asArray(left.logSources), ...asArray(right.logSources)],
    queryPacks: [...asArray(left.queryPacks), ...asArray(right.queryPacks)],
    serverlessEvidence: right.serverlessEvidence || left.serverlessEvidence,
  }
}

export function loadInvestigationTargetConfig(
  env: NodeJS.ProcessEnv = process.env,
): InvestigationTargetConfig {
  const raw = mergeConfigs(readFileConfig(env), readJsonConfig(env))

  return {
    clients: asArray(raw.clients)
      .map(entry => normalizeClient(entry as RawRecord))
      .filter((entry): entry is InvestigationClientTarget => Boolean(entry?.enabled)),
    hostTargets: asArray(raw.hostTargets)
      .map(entry => normalizeHostTarget(entry as RawRecord))
      .filter((entry): entry is InvestigationHostTarget => Boolean(entry?.enabled)),
    connections: asArray(raw.connections)
      .map(entry => normalizeConnection(entry as RawRecord))
      .filter((entry): entry is InvestigationConnectionTarget => Boolean(entry?.enabled)),
    codeTargets: asArray(raw.codeTargets)
      .map(entry => normalizeCodeTarget(entry as RawRecord))
      .filter((entry): entry is InvestigationCodeTarget => Boolean(entry?.enabled)),
    codeSemanticProfiles: asArray(raw.codeSemanticProfiles)
      .map(entry => normalizeCodeSemanticProfile(entry as RawRecord))
      .filter((entry): entry is InvestigationCodeSemanticProfile => Boolean(entry?.enabled)),
    logSources: asArray(raw.logSources)
      .map(entry => normalizeLogSource(entry as RawRecord))
      .filter((entry): entry is InvestigationLogSource => Boolean(entry?.enabled)),
    queryPacks: asArray(raw.queryPacks)
      .map(entry => normalizeQueryPack(entry as RawRecord))
      .filter((entry): entry is InvestigationQueryPack => Boolean(entry)),
    serverlessEvidence: normalizeServerlessEvidence(raw.serverlessEvidence),
  }
}
