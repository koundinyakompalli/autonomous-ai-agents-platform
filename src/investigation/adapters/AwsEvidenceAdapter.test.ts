import { describe, expect, it } from 'vitest'
import { CliAwsEvidenceAdapter } from './AwsEvidenceAdapter.js'
import type { InvestigationAdapterRequest, InvestigationLogSource } from '../types/investigation.js'
import type { InvestigationHostTarget, InvestigationHostTargetRegistry } from '../data/HostTargetRegistry.js'

const fakeSecretFixture = ['password', 'fake-redaction-fixture'].join('=')

class StaticHostRegistry implements InvestigationHostTargetRegistry {
  constructor(private readonly target: InvestigationHostTarget) {}

  async resolveTarget(): Promise<InvestigationHostTarget | null> {
    return this.target
  }

  async listTargets(): Promise<InvestigationHostTarget[]> {
    return [this.target]
  }
}

class FakeAwsRunner {
  readonly calls: string[][] = []

  constructor(private readonly options: { cloudWatchRegion?: string } = {}) {}

  async runJson<T>(command: { args: string[] }): Promise<T> {
    this.calls.push(command.args)
    const service = command.args[0]
    const operation = command.args[1]
    if (service === 'sts') {
      return { Account: '123456789012', Arn: 'arn:aws:sts::123456789012:assumed-role/readonly/operator' } as T
    }
    if (service === 'ec2' && operation === 'describe-regions') {
      return {
        Regions: [
          { RegionName: 'us-east-1', OptInStatus: 'opt-in-not-required' },
          { RegionName: 'us-east-2', OptInStatus: 'opt-in-not-required' },
        ],
      } as T
    }
    if (service === 'ec2') {
      return {
        Reservations: [{
          Instances: [{
            InstanceId: 'i-123',
            State: { Name: 'running' },
            PlatformDetails: 'Linux/UNIX',
            PrivateIpAddress: '10.0.0.10',
          }],
        }],
      } as T
    }
    if (service === 'ssm') {
      return {
        InstanceInformationList: [{
          InstanceId: 'i-123',
          PingStatus: 'Online',
          AgentVersion: '3.3.1',
        }],
      } as T
    }
    if (service === 'logs' && operation === 'describe-log-groups') {
      const region = command.args[command.args.indexOf('--region') + 1]
      if (this.options.cloudWatchRegion && region !== this.options.cloudWatchRegion) {
        return { logGroups: [] } as T
      }
      const prefix = command.args[command.args.indexOf('--log-group-name-prefix') + 1] || '/CP/HUMANA/PROD1/core'
      const logGroupName = prefix.endsWith('/core') ? prefix : `${prefix.replace(/\/?$/, '/') }batch/CorrespondenceUtility`
      return {
        logGroups: [{
          logGroupName,
          storedBytes: 1024,
        }],
      } as T
    }
    if (service === 'logs' && operation === 'filter-log-events') {
      return {
        events: [{
          eventId: 'evt-1',
          logStreamName: 'app/i-123',
          timestamp: Date.parse('2026-06-17T12:00:00.000Z'),
          message: `ERROR ApiClientException status=500 endpoint=/api/provider ${fakeSecretFixture} api.endpoint.url=https://internal/service`,
        }],
      } as T
    }
    if (service === 's3api' && operation === 'get-bucket-location') {
      return { LocationConstraint: 'us-east-2' } as T
    }
    if (service === 's3api' && operation === 'list-objects-v2') {
      return {
        KeyCount: 2,
        IsTruncated: false,
        Contents: [
          { LastModified: '2026-06-17T10:00:00.000Z', Size: 100 },
          { LastModified: '2026-06-17T11:00:00.000Z', Size: 200 },
        ],
      } as T
    }
    throw new Error(`unexpected aws command: ${command.args.join(' ')}`)
  }
}

const target: InvestigationHostTarget = {
  id: 'humana-prod-batch',
  clientId: 'HUMANA',
  environment: 'PROD_REPLICA',
  envId: 'PROD1',
  awsAccountId: '123456789012',
  region: 'us-east-1',
  instanceId: 'i-123',
  instanceName: 'humana-prod-batch',
  vpcId: 'vpc-123',
  subnetId: 'subnet-123',
  networkPath: 'ssm',
  instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/prod',
  expectedRoleName: 'prod',
  awsProfile: 'prod',
  ssmAllowed: true,
  enabled: true,
}

const logSources: InvestigationLogSource[] = [
  {
    id: 'humana-core-cloudwatch',
    clientId: 'HUMANA',
    environment: 'PROD_REPLICA',
    envId: 'PROD1',
    serviceId: 'core-app',
    kind: 'cloudwatch',
    logGroupTemplate: '/CP/{clientId}/{envId}/core',
    filterPattern: '?ERROR ?Exception',
    maxEvents: 5,
    enabled: true,
  },
  {
    id: 'humana-batch-s3-archive',
    clientId: 'HUMANA',
    environment: 'PROD_REPLICA',
    envId: 'PROD1',
    serviceId: 'batch-jobs',
    kind: 's3_archive',
    bucket: 'com.medhok.recursive-archiver',
    prefixTemplate: '{clientId}/{envId}/',
    enabled: true,
  },
]

const request: InvestigationAdapterRequest = {
  runId: 'inv-aws-log-test',
  jiraKey: 'CPSUP-1',
  adapter: 'aws',
  scope: {
    clientId: 'HUMANA',
    environment: 'PROD_REPLICA',
    serviceIds: ['core-app', 'batch-jobs'],
  },
  constraints: {
    timeoutMs: 60_000,
    maxRows: 100,
    maxArtifacts: 20,
    redactionRequired: true,
  },
}

describe('CliAwsEvidenceAdapter direct log source collection', () => {
  it('keeps generic AWS scope resolution separate from the dedicated serverless trace', async () => {
    const runner = new FakeAwsRunner()
    const adapter = new CliAwsEvidenceAdapter(
      new StaticHostRegistry(target),
      logSources,
      () => runner,
    )

    await adapter.execute({
      ...request,
      scope: {
        ...request.scope,
        keywords: ['lambda', 'queue', 'subscriber'],
      },
    })

    expect(runner.calls.some(call => call[0] === 'lambda')).toBe(false)
    expect(runner.calls.some(call => call[0] === 'logs')).toBe(true)
  })

  it('uses direct CloudWatch and S3 archive metadata calls from configured sources', async () => {
    const runner = new FakeAwsRunner()
    const adapter = new CliAwsEvidenceAdapter(
      new StaticHostRegistry(target),
      logSources,
      () => runner,
    )

    const result = await adapter.execute(request)

    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'logs',
      'describe-log-groups',
      '--log-group-name-prefix',
      '/CP/HUMANA/PROD1/core',
    ]))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'logs',
      'filter-log-events',
      '--log-group-name',
      '/CP/HUMANA/PROD1/core',
      '--filter-pattern',
      '?ERROR ?Exception',
      '--limit',
      '5',
    ]))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      's3api',
      'list-objects-v2',
      '--bucket',
      'com.medhok.recursive-archiver',
      '--prefix',
      'HUMANA/PROD1/',
    ]))
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'inv-aws-log-test-aws-cloudwatch-log-sources',
        title: 'Approved CloudWatch log sources',
      }),
      expect.objectContaining({
        id: 'inv-aws-log-test-aws-s3-archive-log-sources',
        title: 'Approved S3 archived log sources',
      }),
    ]))
    expect(result.findings.map(finding => finding.type)).toEqual(expect.arrayContaining([
      'cloudwatch_log_sources_selected',
      'runtime_log_error_evidence',
      's3_archive_log_sources_selected',
    ]))
    expect(result.telemetry.requestsIssued).toBe(6)
    const cloudWatchEvidence = result.evidence.find(artifact => artifact.id === 'inv-aws-log-test-aws-cloudwatch-log-sources')
    expect(JSON.stringify(cloudWatchEvidence?.metadata)).toContain('[REDACTED_SECRET]')
    expect(JSON.stringify(cloudWatchEvidence?.metadata)).not.toContain(fakeSecretFixture)
  })

  it('keeps CloudWatch/S3 collection active when host access uses LDAP SSH instead of SSM', async () => {
    const runner = new FakeAwsRunner()
    const sshTarget: InvestigationHostTarget = {
      ...target,
      networkPath: 'ssh_public',
      ssmAllowed: false,
      publicHost: 'wellcare-prod-batch.example.test',
      sshUser: 'operator',
      sshAuthMode: 'operator_ldap',
    }
    const adapter = new CliAwsEvidenceAdapter(
      new StaticHostRegistry(sshTarget),
      logSources,
      () => runner,
    )

    const result = await adapter.execute(request)

    expect(runner.calls).not.toContainEqual(expect.arrayContaining(['sts']))
    expect(runner.calls).not.toContainEqual(expect.arrayContaining(['ec2']))
    expect(runner.calls).not.toContainEqual(expect.arrayContaining(['ssm']))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'logs',
      'describe-log-groups',
      '--log-group-name-prefix',
      '/CP/HUMANA/PROD1/core',
    ]))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      's3api',
      'list-objects-v2',
      '--bucket',
      'com.medhok.recursive-archiver',
    ]))
    expect(result.findings.map(finding => finding.type)).toEqual(expect.arrayContaining([
      'ldap_ssh_host_scope_selected',
      'cloudwatch_log_sources_selected',
      's3_archive_log_sources_selected',
    ]))
    expect(result.evidence.map(artifact => artifact.id)).toEqual(expect.arrayContaining([
      'inv-aws-log-test-aws-ldap-ssh-scope',
      'inv-aws-log-test-aws-cloudwatch-log-sources',
      'inv-aws-log-test-aws-s3-archive-log-sources',
    ]))
  })

  it('collects CloudWatch/S3 evidence for a log-only AWS scope without SSM or SSH host access', async () => {
    const runner = new FakeAwsRunner()
    const logOnlyTarget: InvestigationHostTarget = {
      ...target,
      id: 'jira-aws-log-scope',
      instanceId: 'jira-aws-log-scope',
      instanceName: 'Wellcare PROD-REPLICA AWS logs',
      networkPath: 'ssh_public',
      ssmAllowed: false,
      publicHost: undefined,
      sshAllowed: false,
      sshAuthMode: 'operator_ldap',
    }
    const adapter = new CliAwsEvidenceAdapter(
      new StaticHostRegistry(logOnlyTarget),
      logSources,
      () => runner,
    )

    const result = await adapter.execute(request)

    expect(runner.calls).not.toContainEqual(expect.arrayContaining(['ssm']))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'logs',
      'describe-log-groups',
      '--log-group-name-prefix',
      '/CP/HUMANA/PROD1/core',
    ]))
    expect(result.findings.map(finding => finding.type)).toEqual(expect.arrayContaining([
      'aws_log_scope_selected',
      'cloudwatch_log_sources_selected',
      's3_archive_log_sources_selected',
    ]))
    const scopeEvidence = result.evidence.find(artifact => artifact.id === 'inv-aws-log-test-aws-ldap-ssh-scope')
    expect(scopeEvidence?.title).toBe('AWS log evidence scope')
    expect(scopeEvidence?.metadata).toMatchObject({ logOnly: true })
  })

  it('checks discovered AWS regions for a Jira-scoped dynamic CloudWatch prefix', async () => {
    const runner = new FakeAwsRunner({ cloudWatchRegion: 'us-east-2' })
    const logOnlyTarget: InvestigationHostTarget = {
      ...target,
      id: 'jira-aws-log-scope',
      clientId: 'WELLCARE',
      region: 'aws-dynamic',
      envId: 'PROD_REPLICA',
      instanceId: 'jira-aws-log-scope',
      instanceName: 'Wellcare PROD-REPLICA AWS logs',
      networkPath: 'ssh_public',
      ssmAllowed: false,
      publicHost: undefined,
      sshAllowed: false,
      sshAuthMode: 'operator_ldap',
    }
    const dynamicSources: InvestigationLogSource[] = [
      {
        id: 'jira-wellcare-prod-replica-dynamic-cloudwatch',
        clientId: 'WELLCARE',
        environment: 'PROD_REPLICA',
        envId: 'CONFIG1',
        kind: 'cloudwatch',
        logGroupTemplate: '/CP/{clientId}/{envId}/',
        maxEvents: 5,
        enabled: true,
      },
      {
        id: 'jira-wellcare-prod-replica-batch-s3-archive',
        clientId: 'WELLCARE',
        environment: 'PROD_REPLICA',
        envId: 'CONFIG1',
        kind: 's3_archive',
        bucket: 'com.medhok.recursive-archiver',
        prefixTemplate: '{clientId}/{envId}/',
        maxObjects: 10,
        optional: true,
        enabled: true,
      },
    ]
    const dynamicRequest: InvestigationAdapterRequest = {
      ...request,
      runId: 'inv-aws-dynamic-region-test',
      scope: {
        ...request.scope,
        clientId: 'WELLCARE',
        serviceIds: ['batch-jobs'],
        hostTargets: ['jira-aws-log-scope'],
      },
    }
    const adapter = new CliAwsEvidenceAdapter(
      new StaticHostRegistry(logOnlyTarget),
      dynamicSources,
      () => runner,
    )

    const result = await adapter.execute(dynamicRequest)

    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'ec2',
      'describe-regions',
      '--region',
      'us-east-1',
    ]))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      'logs',
      'describe-log-groups',
      '--region',
      'us-east-2',
      '--log-group-name-prefix',
      '/CP/WELLCARE/CONFIG1/',
    ]))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      's3api',
      'get-bucket-location',
      '--region',
      'us-east-1',
      '--bucket',
      'com.medhok.recursive-archiver',
    ]))
    expect(runner.calls).toContainEqual(expect.arrayContaining([
      's3api',
      'list-objects-v2',
      '--region',
      'us-east-2',
      '--bucket',
      'com.medhok.recursive-archiver',
      '--prefix',
      'WELLCARE/CONFIG1/',
    ]))
    expect(result.findings.map(finding => finding.type)).toEqual(expect.arrayContaining([
      'aws_log_scope_selected',
      'cloudwatch_log_sources_selected',
      's3_archive_log_sources_selected',
    ]))
    const cloudWatchEvidence = result.evidence.find(artifact => artifact.id === 'inv-aws-dynamic-region-test-aws-cloudwatch-log-sources')
    expect(JSON.stringify(cloudWatchEvidence?.metadata)).toContain('"region":"us-east-2"')
    const s3Evidence = result.evidence.find(artifact => artifact.id === 'inv-aws-dynamic-region-test-aws-s3-archive-log-sources')
    expect(JSON.stringify(s3Evidence?.metadata)).toContain('"region":"us-east-2"')
  })
})
