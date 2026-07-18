import type { InvestigationEnvironment } from '../types/investigation.js'

export type InvestigationHostNetworkPath = 'private_vpc' | 'ssm' | 'ssh_public'
export type InvestigationHostSshAuthMode = 'operator_ldap' | 'service_account' | 'ssh_agent'

export interface InvestigationS3LogArchive {
  bucket: string
  prefixTemplate?: string
  region?: string
}

export type InvestigationCloudWatchLogScopeKind = 'ws' | 'catalina' | 'batch' | 'core' | 'cas' | 'portal' | 'spagobi' | 'knowage' | 'service' | 'custom'

export interface InvestigationCloudWatchLogScope {
  id: string
  kind?: InvestigationCloudWatchLogScopeKind
  nameTemplate?: string
  prefixTemplate?: string
  region?: string
  default?: boolean
  serviceIds?: string[]
  keywords?: string[]
  maxGroups?: number
}

export interface InvestigationHostTarget {
  id: string
  scopeKind?: 'host' | 'aws_service'
  clientId: string
  environment: InvestigationEnvironment
  envId: string
  awsAccountId: string
  region: string
  instanceId: string
  instanceName: string
  vpcId: string
  subnetId: string
  networkPath: InvestigationHostNetworkPath
  instanceProfileArn: string
  expectedRoleName: string
  awsProfile?: string
  publicHost?: string
  databaseHost?: string
  databasePort?: number
  discoveryAliases?: string[]
  roleHints?: string[]
  sshPort?: number
  sshUser?: string
  sshAuthMode?: InvestigationHostSshAuthMode
  sshControlPath?: string
  sshControlPathDedicated?: boolean
  sshAllowed?: boolean
  configProbePaths?: string[]
  configProbeMaxMatches?: number
  batchProbePaths?: string[]
  batchProbeMaxMatches?: number
  ssmAllowed: boolean
  logRoots?: string[]
  cloudWatchLogScopes?: InvestigationCloudWatchLogScope[]
  s3LogArchives?: InvestigationS3LogArchive[]
  enabled: boolean
  notes?: string
}

export interface InvestigationHostTargetRegistry {
  resolveTarget(
    clientId: string,
    environment: InvestigationEnvironment,
    hostTargetId?: string,
    envId?: string,
  ): Promise<InvestigationHostTarget | null>
  listTargets(): Promise<InvestigationHostTarget[]>
  resolveRuntimeTargets?(
    clientId: string,
    environment: InvestigationEnvironment,
    envId?: string,
  ): Promise<InvestigationHostTarget[]>
}

export class InMemoryHostTargetRegistry implements InvestigationHostTargetRegistry {
  constructor(private readonly targets: InvestigationHostTarget[] = []) {}

  async resolveTarget(
    clientId: string,
    environment: InvestigationEnvironment,
    hostTargetId?: string,
    envId?: string,
  ): Promise<InvestigationHostTarget | null> {
    return this.targets.find(target =>
      target.clientId === clientId
      && target.environment === environment
      && target.enabled
      && (!hostTargetId || target.instanceId === hostTargetId || target.id === hostTargetId)
      && (!envId || target.envId === envId),
    ) ?? null
  }

  async listTargets(): Promise<InvestigationHostTarget[]> {
    return [...this.targets]
  }
}
