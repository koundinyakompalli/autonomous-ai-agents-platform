import { describe, expect, it } from 'vitest'
import { CliHostInspectionAdapter } from './HostInspectionAdapter.js'
import type { InvestigationAdapterRequest } from '../types/investigation.js'
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

class RuntimeFanoutHostRegistry implements InvestigationHostTargetRegistry {
  constructor(
    private readonly primary: InvestigationHostTarget,
    private readonly runtimeTargets: InvestigationHostTarget[],
  ) {}

  async resolveTarget(): Promise<InvestigationHostTarget | null> {
    return this.primary
  }

  async listTargets(): Promise<InvestigationHostTarget[]> {
    return [this.primary, ...this.runtimeTargets]
  }

  async resolveRuntimeTargets(): Promise<InvestigationHostTarget[]> {
    return this.runtimeTargets
  }
}

class FakeHostRunner {
  readonly jsonCalls: string[][] = []
  readonly textCalls: string[][] = []

  async runJson<T>(args: string[]): Promise<T> {
    this.jsonCalls.push(args)
    if (args[0] === 'ssm' && args[1] === 'describe-instance-information') {
      return {
        InstanceInformationList: [{
          InstanceId: 'i-123',
          PingStatus: 'Online',
          PlatformName: 'Amazon Linux',
          AgentVersion: '3.3.1',
        }],
      } as T
    }
    if (args[0] === 'ssm' && args[1] === 'get-command-invocation') {
      return {
        Status: 'Success',
        StandardOutputContent: `/opt/app/config/app.properties:42:api.endpoint.url=https://service ${fakeSecretFixture}`,
      } as T
    }
    throw new Error(`unexpected json call: ${args.join(' ')}`)
  }

  async runText(args: string[]): Promise<string> {
    this.textCalls.push(args)
    return 'cmd-123\n'
  }
}

class FakeSshRunner {
  readonly commands: string[] = []

  async runRemoteText(command: string): Promise<string> {
    this.commands.push(command)
    if (this.commands.length === 1) {
      return 'host=performrxuatbatch\nuser=test-operator\nkernel=Linux 5.10\n'
    }
    if (command.includes('*.log')) {
      return "###FILE:/opt/app/logs/application.log\n42:Data too long for column 'contact_value' at row 1 user@example.test"
    }
    return `/opt/app/config/app.properties:42:api.endpoint.url=https://service ${fakeSecretFixture}`
  }
}

class FakeBatchSshRunner {
  readonly commands: string[] = []

  async runRemoteText(command: string): Promise<string> {
    this.commands.push(command)
    if (this.commands.length === 1) {
      return 'host=centene-prod-batch01\nuser=test-operator\nkernel=Linux 5.10\n'
    }
    if (command.includes('*.log')) {
      return ''
    }
    if (command.includes('*.properties') && !command.includes('*.sh')) {
      return `/opt/app/config/batch.properties:7:CorrespondenceUtility.enabled=true ${fakeSecretFixture}`
    }
    return '/opt/software/medhok/batch/runCorrespondenceUtility.sh:14:java -jar CorrespondenceUtility.jar --branch cp-batch-monorepo-3.18'
  }
}

const target: InvestigationHostTarget = {
  id: 'performrx-uat-core',
  clientId: 'PERFORMRX',
  environment: 'UAT',
  envId: 'UAT1',
  awsAccountId: '123456789012',
  region: 'us-east-2',
  instanceId: 'i-123',
  instanceName: 'performrx-uat-core',
  vpcId: 'vpc-123',
  subnetId: 'subnet-123',
  networkPath: 'ssm',
  instanceProfileArn: 'arn:aws:iam::123456789012:instance-profile/uat',
  expectedRoleName: 'uat',
  awsProfile: 'performrx',
  configProbePaths: ['/opt/app/config'],
  configProbeMaxMatches: 10,
  ssmAllowed: true,
  enabled: true,
}

const request: InvestigationAdapterRequest = {
  runId: 'inv-host-config-test',
  jiraKey: 'CPCLIENT-1',
  adapter: 'host',
  scope: {
    clientId: 'PERFORMRX',
    environment: 'UAT',
    serviceIds: ['core-app'],
    keywords: ['ApiClientException', 'api.endpoint.url', '/api/provider'],
  },
  constraints: {
    timeoutMs: 60_000,
    maxRows: 100,
    maxArtifacts: 20,
    redactionRequired: true,
  },
}

describe('CliHostInspectionAdapter config probe', () => {
  it('prefers application runtime targets when the primary SSH target is a database host', async () => {
    const databaseTarget: InvestigationHostTarget = {
      ...target,
      id: 'client-prod-db-slave',
      instanceName: 'CLIENT PROD DB Slave',
      networkPath: 'ssh_public',
      publicHost: 'db.example.test',
      sshUser: 'test-operator',
      sshAuthMode: 'operator_ldap',
      sshAllowed: true,
      ssmAllowed: false,
    }
    const applicationTarget: InvestigationHostTarget = {
      ...databaseTarget,
      id: 'client-prod-app-1',
      instanceId: 'i-app-1',
      instanceName: 'CLIENT PROD App 1',
      publicHost: 'app-1.example.test',
    }
    const runners = new Map<string, FakeSshRunner>()
    const adapter = new CliHostInspectionAdapter(
      new RuntimeFanoutHostRegistry(databaseTarget, [applicationTarget]),
      () => { throw new Error('SSM runner should not be used for SSH targets') },
      resolvedTarget => {
        const runner = new FakeSshRunner()
        runners.set(resolvedTarget.id, runner)
        return runner
      },
    )

    await adapter.execute(request)

    expect(runners.has(databaseTarget.id)).toBe(false)
    expect(runners.has(applicationTarget.id)).toBe(true)
  })

  it('fans runtime log collection out to application targets without replacing the primary target', async () => {
    const primaryTarget: InvestigationHostTarget = {
      ...target,
      id: 'client-prod-login',
      instanceId: 'i-login',
      instanceName: 'CLIENT PROD LOGIN',
      networkPath: 'ssh_public',
      publicHost: 'login.example.test',
      sshUser: 'test-operator',
      sshAuthMode: 'operator_ldap',
      sshAllowed: true,
      ssmAllowed: false,
    }
    const applicationTarget: InvestigationHostTarget = {
      ...primaryTarget,
      id: 'client-prod-app-1',
      instanceId: 'i-app-1',
      instanceName: 'CLIENT PROD App 1',
      publicHost: 'app-1.example.test',
      sshControlPath: '/tmp/app-1.sock',
      sshControlPathDedicated: true,
    }
    const runners = new Map<string, FakeSshRunner>()
    const adapter = new CliHostInspectionAdapter(
      new RuntimeFanoutHostRegistry(primaryTarget, [applicationTarget]),
      () => {
        throw new Error('SSM runner should not be used for SSH targets')
      },
      (resolvedTarget) => {
        const runner = new FakeSshRunner()
        runners.set(resolvedTarget.id, runner)
        return runner
      },
    )

    const result = await adapter.execute({
      ...request,
      scope: {
        ...request.scope,
        timeWindow: {
          startTs: '2026-07-10T00:00:00.000Z',
          endTs: '2026-07-16T00:00:00.000Z',
        },
      },
    })

    expect(runners.has(primaryTarget.id)).toBe(true)
    expect(runners.has(applicationTarget.id)).toBe(true)
    const runtimeCommand = runners.get(applicationTarget.id)?.commands.find(command => command.includes('*.log'))
    expect(runtimeCommand).toContain("SPECIFIC_PATTERN='data too long for column")
    expect(runtimeCommand).toContain('TMP_SPECIFIC=$(mktemp)')
    expect(runtimeCommand).toContain('-newermt "$START_TS"')
    expect(runtimeCommand).not.toContain('! -newermt "$END_TS"')
    expect(runtimeCommand).toContain('head -n 100 > "$TMP_PLAIN_FILES"')
    expect(runtimeCommand).toContain('timeout 30s xargs -r grep -HInE')
    expect(runtimeCommand).toContain('{ cat "$TMP_SPECIFIC"; cat "$TMP_GENERIC"; }')
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'inv-host-config-test-host-runtime-log-probe' }),
      expect.objectContaining({ id: expect.stringContaining('runtime-client-prod-app-1-host-runtime-log-probe') }),
    ]))
  })

  it('runs a bounded SSM config probe for evidence-derived terms and redacts output', async () => {
    const runner = new FakeHostRunner()
    const adapter = new CliHostInspectionAdapter(
      new StaticHostRegistry(target),
      () => runner,
    )

    const result = await adapter.execute({
      ...request,
      scope: {
        ...request.scope,
        timeWindow: {
          startTs: '2026-07-10T00:00:00.000Z',
          endTs: '2026-07-16T00:00:00.000Z',
        },
      },
    })

    expect(runner.textCalls).toHaveLength(1)
    expect(runner.textCalls[0]).toContain('send-command')
    expect(result.findings.map(finding => finding.type)).toContain('host_config_path_candidates')
    const evidence = result.evidence.find(artifact => artifact.id === 'inv-host-config-test-host-config-probe')
    expect(evidence?.summary).toContain('1 redacted candidate')
    expect(JSON.stringify(evidence?.metadata)).toContain('[REDACTED_SECRET]')
    expect(JSON.stringify(evidence?.metadata)).not.toContain(fakeSecretFixture)
  })

  it('uses configured public SSH endpoint for operator LDAP host inspection without accepting passwords', async () => {
    const sshTarget: InvestigationHostTarget = {
      ...target,
      id: 'performrx-uat-batch-ssh',
      networkPath: 'ssh_public',
      publicHost: '203.0.113.86',
      sshPort: 22,
      sshUser: 'test-operator',
      sshAuthMode: 'operator_ldap',
      sshAllowed: true,
      ssmAllowed: false,
    }
    const sshRunner = new FakeSshRunner()
    const adapter = new CliHostInspectionAdapter(
      new StaticHostRegistry(sshTarget),
      () => {
        throw new Error('SSM runner should not be used for ssh_public targets')
      },
      () => sshRunner,
    )

    const result = await adapter.execute({
      ...request,
      scope: {
        ...request.scope,
        ticketContext: {
          jiraKey: 'CPCLIENT-1',
          title: 'Runtime failure for reported member',
          description: 'A reported member request failed.',
          identifiers: [{
            kind: 'member_identifier',
            source: 'description',
            value: 'TEST-MEMBER-961144558-12',
            sensitive: true,
          }],
        },
        timeWindow: {
          startTs: '2026-07-10T00:00:00.000Z',
          endTs: '2026-07-16T00:00:00.000Z',
        },
      },
    })

    expect(sshRunner.commands).toHaveLength(3)
    expect(sshRunner.commands[1]).toContain('*.log')
    expect(sshRunner.commands[1]).toContain('/opt/apps')
    expect(sshRunner.commands[1]).toContain('*.zip')
    expect(sshRunner.commands[1]).toContain('unzip -p')
    expect(sshRunner.commands[1]).toContain('timeout 3s')
    expect(sshRunner.commands[1]).toContain('TEST-MEMBER-961144558-12')
    expect(sshRunner.commands[1]).toContain('2026-07-10 00:00:00 UTC')
    expect(sshRunner.commands[1]).not.toContain('2026-07-10T00:00:00.000Z')
    expect(sshRunner.commands[2]).toContain('find "$probe_path"')
    expect(result.findings.map(finding => finding.type)).toContain('host_runtime_posture')
    expect(result.findings.map(finding => finding.type)).toContain('runtime_log_error_evidence')
    expect(result.findings.map(finding => finding.type)).toContain('host_config_path_candidates')
    const hostEvidence = result.evidence.find(artifact => artifact.id === 'inv-host-config-test-host-ssh')
    expect(hostEvidence?.summary).toContain('no password material was accepted')
    const configEvidence = result.evidence.find(artifact => artifact.id === 'inv-host-config-test-host-config-probe')
    expect(JSON.stringify(configEvidence?.metadata)).toContain('[REDACTED_SECRET]')
    expect(JSON.stringify(configEvidence?.metadata)).not.toContain(fakeSecretFixture)
    const runtimeEvidence = result.evidence.find(artifact => artifact.id === 'inv-host-config-test-host-runtime-log-probe')
    expect(runtimeEvidence?.metadata).toMatchObject({ failureColumns: ['contact_value'] })
    expect(JSON.stringify(runtimeEvidence?.metadata)).toContain('[REDACTED_EMAIL]')
    expect(JSON.stringify(runtimeEvidence?.metadata)).not.toContain('TEST-MEMBER-961144558-12')
  })

  it('derives a bounded LDAP SSH host from runtime evidence and probes batch scripts', async () => {
    const logOnlyTarget: InvestigationHostTarget = {
      ...target,
      id: 'jira-aws-log-scope',
      clientId: 'WELLCARE',
      environment: 'PROD_REPLICA',
      envId: 'PROD1',
      networkPath: 'ssh_public',
      publicHost: undefined,
      sshPort: 22,
      sshUser: 'test-operator',
      sshAuthMode: 'operator_ldap',
      sshAllowed: false,
      ssmAllowed: false,
      batchProbePaths: ['/opt/software/medhok/batch'],
    }
    const batchRequest: InvestigationAdapterRequest = {
      ...request,
      runId: 'inv-host-batch-test',
      jiraKey: 'CPSUP-50343',
      scope: {
        clientId: 'WELLCARE',
        environment: 'PROD_REPLICA',
        serviceIds: ['batch-jobs'],
        keywords: [
          'batch-archive-s3-archive',
          'centene-prod-batch01.internal.mhk',
          '/CP/WELLCARE/PROD1/batch/CorrespondenceUtility',
          'CorrespondenceUtility',
        ],
      },
    }
    const sshRunner = new FakeBatchSshRunner()
    const adapter = new CliHostInspectionAdapter(
      new StaticHostRegistry(logOnlyTarget),
      () => {
        throw new Error('SSM runner should not be used for evidence-derived ssh_public targets')
      },
      () => sshRunner,
    )

    const result = await adapter.execute(batchRequest)

    expect(sshRunner.commands).toHaveLength(4)
    expect(sshRunner.commands[3]).toContain('/opt/software/medhok/batch')
    expect(result.findings.map(finding => finding.type)).toEqual(expect.arrayContaining([
      'host_runtime_posture',
      'host_batch_script_candidates',
    ]))
    const hostEvidence = result.evidence.find(artifact => artifact.id === 'inv-host-batch-test-host-ssh')
    expect(hostEvidence?.metadata).toMatchObject({ publicHost: 'centene-prod-batch01.internal.mhk' })
    const batchEvidence = result.evidence.find(artifact => artifact.id === 'inv-host-batch-test-host-batch-script-probe')
    expect(JSON.stringify(batchEvidence?.metadata)).toContain('cp-batch-monorepo-3.18')
    expect(JSON.stringify(batchEvidence?.metadata)).not.toContain(fakeSecretFixture)
  })

  it('does not treat code worktree labels as evidence-derived SSH hosts', async () => {
    const logOnlyTarget: InvestigationHostTarget = {
      ...target,
      id: 'jira-aws-log-scope',
      clientId: 'CLIENTX',
      environment: 'PROD_REPLICA',
      envId: 'PROD1',
      networkPath: 'ssh_public',
      publicHost: undefined,
      sshAllowed: false,
      ssmAllowed: false,
    }
    const sshRunner = new FakeSshRunner()
    const adapter = new CliHostInspectionAdapter(
      new StaticHostRegistry(logOnlyTarget),
      () => {
        throw new Error('SSM runner should not be used for a log-only target')
      },
      () => sshRunner,
    )

    const result = await adapter.execute({
      ...request,
      scope: {
        clientId: 'CLIENTX',
        environment: 'PROD_REPLICA',
        serviceIds: ['core-app'],
        keywords: ['3fb7a981-core-app-medhok-monorepo-3.15-9ngzxn'],
      },
    })

    expect(sshRunner.commands).toHaveLength(0)
    expect(result.findings.map(finding => finding.type)).toContain('host_inspection_deferred')
  })

  it('defers log-only Jira scopes instead of reporting LDAP SSH as denied', async () => {
    const logOnlyTarget: InvestigationHostTarget = {
      ...target,
      id: 'jira-aws-log-scope',
      clientId: 'WELLCARE',
      environment: 'PROD_REPLICA',
      envId: 'PROD1',
      instanceName: 'Wellcare PROD-REPLICA LDAP SSH',
      networkPath: 'ssh_public',
      publicHost: undefined,
      sshPort: 22,
      sshUser: 'test-operator',
      sshAuthMode: 'operator_ldap',
      sshAllowed: false,
      ssmAllowed: false,
    }
    const sshRunner = new FakeSshRunner()
    const adapter = new CliHostInspectionAdapter(
      new StaticHostRegistry(logOnlyTarget),
      () => {
        throw new Error('SSM runner should not be used for log-only targets')
      },
      () => sshRunner,
    )

    const result = await adapter.execute({
      ...request,
      runId: 'inv-host-log-only-test',
      jiraKey: 'CPSUP-50343',
      scope: {
        clientId: 'WELLCARE',
        environment: 'PROD_REPLICA',
        serviceIds: ['batch-jobs'],
        keywords: ['batch job failed', 'batch-archive-s3-archive'],
      },
    })

    expect(sshRunner.commands).toHaveLength(0)
    expect(result.findings).toEqual([
      expect.objectContaining({
        type: 'host_inspection_deferred',
        severity: 'info',
        requiresCodeChange: false,
        requiresDataChange: false,
      }),
    ])
  })
})
