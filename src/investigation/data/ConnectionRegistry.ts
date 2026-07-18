import type { InvestigationEnvironment } from '../types/investigation.js'

export type InvestigationNetworkPath = 'private_vpc' | 'vpn' | 'ssm' | 'ssh_public'
export type InvestigationAuthMode = 'username_password'
export type InvestigationAccessClass = 'lower_ro' | 'prod_replica_ro'
export type InvestigationConnectionTopology = 'rds_mysql' | 'ec2_mysql'

export interface InvestigationConnectionTarget {
  id: string
  clientId: string
  environment: InvestigationEnvironment
  envId: string
  topology: InvestigationConnectionTopology
  engine: 'mysql'
  host: string
  port: number
  databaseName?: string
  networkPath: InvestigationNetworkPath
  authMode: InvestigationAuthMode
  secretRef: string
  dbUser: string
  hostTargetId?: string
  hostAuthFile?: string
  accessClass: InvestigationAccessClass
  allowedQueryPacks: string[]
  phiAccess: false
  enabled: boolean
  sslRequired: boolean
  sslCa?: string
  notes?: string
}

export interface InvestigationConnectionRegistry {
  resolveTarget(
    clientId: string,
    environment: InvestigationEnvironment,
    envId?: string,
  ): Promise<InvestigationConnectionTarget | null>
  listTargets(): Promise<InvestigationConnectionTarget[]>
}

export class InMemoryConnectionRegistry implements InvestigationConnectionRegistry {
  constructor(private readonly targets: InvestigationConnectionTarget[] = []) {}

  async resolveTarget(
    clientId: string,
    environment: InvestigationEnvironment,
    envId?: string,
  ): Promise<InvestigationConnectionTarget | null> {
    return this.targets.find(
      target =>
        target.clientId === clientId
        && target.environment === environment
        && target.enabled
        && (!envId || target.envId === envId),
    ) ?? null
  }

  async listTargets(): Promise<InvestigationConnectionTarget[]> {
    return [...this.targets]
  }
}
