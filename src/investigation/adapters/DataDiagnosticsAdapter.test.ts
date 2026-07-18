import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MysqlDataDiagnosticsAdapter } from './DataDiagnosticsAdapter.js'
import { InMemoryCodeSemanticProfileRegistry } from '../data/CodeSemanticProfileRegistry.js'
import { QueryValidator } from '../data/QueryValidator.js'
import { PhiGuard } from '../data/PhiGuard.js'
import type { InvestigationAdapterRequest } from '../types/investigation.js'
import type { InvestigationConnectionTarget } from '../data/ConnectionRegistry.js'

const mysqlMocks = vi.hoisted(() => ({
  createConnection: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}))

const sshTunnelMocks = vi.hoisted(() => ({
  startSshTunnel: vi.fn(),
  stopSshTunnel: vi.fn(),
}))

vi.mock('mysql2/promise', () => ({
  default: {
    createConnection: mysqlMocks.createConnection,
  },
}))

vi.mock('../utils/SshTunnel.js', () => ({
  startSshTunnel: sshTunnelMocks.startSshTunnel,
  stopSshTunnel: sshTunnelMocks.stopSshTunnel,
}))

const localOperatorTarget: InvestigationConnectionTarget = {
  id: 'performrx-uat-local-ldap-tunnel',
  clientId: 'PERFORMRX',
  environment: 'UAT',
  envId: 'UAT1',
  topology: 'rds_mysql',
  engine: 'mysql',
  host: '127.0.0.1',
  port: 3332,
  databaseName: 'medhok',
  networkPath: 'vpn',
  authMode: 'username_password',
  secretRef: 'env://INVESTIGATION_DB_PASSWORD',
  dbUser: 'operator',
  accessClass: 'lower_ro',
  allowedQueryPacks: [],
  phiAccess: false,
  enabled: true,
  sslRequired: false,
}

const request: InvestigationAdapterRequest = {
  runId: 'inv-test',
  jiraKey: 'CPSUP-48576',
  adapter: 'data',
  scope: {
    clientId: 'PERFORMRX',
    environment: 'UAT',
    serviceIds: ['batch-jobs'],
    timeWindow: {
      startTs: '2026-05-26T04:00:00.000Z',
      endTs: '2026-05-27T04:00:00.000Z',
    },
    ticketContext: {
      source: 'jira',
      jiraKey: 'CPSUP-48576',
      fetchStatus: 'fetched',
      identifiers: [
        { kind: 'case_number', source: 'description', value: '12345678901', sensitive: true },
        { kind: 'case_number', source: 'description', value: '12345678902', sensitive: true },
      ],
    },
    keywords: ['ePA_Incorrect', 'EAppeal', 'Supported', 'Values'],
  },
  constraints: {
    timeoutMs: 5_000,
    redactionRequired: true,
  },
}

const epaDiagnosticSql = [
  "SELECT 'epa_config' AS source_name, 'e_appeal_allowed' AS scope_key,",
  'CAST(COUNT(*) AS CHAR) AS total_rows,',
  'CAST(SUM(CASE WHEN e_appeal_allowed = 1 THEN 1 ELSE 0 END) AS CHAR) AS enabled_rows,',
  'CAST(SUM(CASE WHEN e_appeal_allowed = 0 OR e_appeal_allowed IS NULL THEN 1 ELSE 0 END) AS CHAR) AS disabled_or_null_rows,',
  'CAST(MAX(update_datetime) AS CHAR) AS latest_update_at',
  'FROM epa_config',
  'UNION ALL',
  "SELECT 'der_defaults_epa_config' AS source_name, 'default_linkage' AS scope_key,",
  'CAST(COUNT(*) AS CHAR) AS total_rows,',
  'CAST(COUNT(DISTINCT der_defaults_epa_id) AS CHAR) AS enabled_rows,',
  'CAST(SUM(CASE WHEN der_defaults_epa_id IS NULL THEN 1 ELSE 0 END) AS CHAR) AS disabled_or_null_rows,',
  'CAST(MAX(update_datetime) AS CHAR) AS latest_update_at',
  'FROM der_defaults_epa_config',
  'UNION ALL',
  "SELECT 'der_defaults_epa_denied_context' AS source_name,",
  "CONCAT('status=', COALESCE(ds.description, 'NULL'), '/reason=', COALESCE(dsr.description, 'NULL'), '/denied=', CAST(COALESCE(ds.denied, 0) AS UNSIGNED), '/partial=', CAST(COALESCE(dsr.partial_approval, 0) AS UNSIGNED)) AS scope_key,",
  'CAST(COUNT(*) AS CHAR) AS total_rows,',
  'CAST(SUM(CASE WHEN COALESCE(ds.denied, 0) = 1 THEN 1 ELSE 0 END) AS CHAR) AS enabled_rows,',
  'CAST(SUM(CASE WHEN COALESCE(dsr.partial_approval, 0) = 1 THEN 1 ELSE 0 END) AS CHAR) AS disabled_or_null_rows,',
  'CAST(MAX(ddec.update_datetime) AS CHAR) AS latest_update_at',
  'FROM der_defaults_epa_config ddec',
  'JOIN der_defaults_epa dde ON dde.id = ddec.der_defaults_epa_id',
  'LEFT JOIN der_status ds ON ds.id = dde.status',
  'LEFT JOIN der_status_reason dsr ON dsr.id = dde.status_reason',
  'WHERE COALESCE(ds.denied, 0) = 1',
  'OR COALESCE(dsr.partial_approval, 0) = 1',
  "OR LOWER(COALESCE(ds.description, '')) LIKE '%denied%'",
  "OR LOWER(COALESCE(dsr.description, '')) LIKE '%partial%'",
  'GROUP BY COALESCE(ds.description, NULL), COALESCE(dsr.description, NULL), CAST(COALESCE(ds.denied, 0) AS UNSIGNED), CAST(COALESCE(dsr.partial_approval, 0) AS UNSIGNED)',
  'LIMIT 50',
].join(' ')

const semanticProfiles = new InMemoryCodeSemanticProfileRegistry([
  {
    id: 'performrx_epa_eappeal_response',
    title: 'PerformRx ePA eAppeal response support',
    summary: 'Rank and diagnose ePA response support behavior from mapped DER/ePA configuration code.',
    clientId: 'PERFORMRX',
    environments: ['UAT'],
    priority: 100,
    matchAny: ['ePA', 'EAppeal', 'IsEAppealSupported', 'PAResponse'],
    preferredTerms: ['IsEAppealSupported', 'PAResponse', 'e_appeal_allowed', 'DerDefaultsEpaConfig'],
    dataDiagnostics: [
      {
        id: 'appcode_epa_eappeal_config_validation',
        description: 'Configured code-derived DER/ePA configuration diagnostic.',
        environments: ['UAT'],
        allowedTables: ['epa_config', 'der_defaults_epa_config', 'der_defaults_epa', 'der_status', 'der_status_reason'],
        parameterNames: [],
        sql: epaDiagnosticSql,
        maxRows: 50,
        timeoutMs: 5_000,
        redactionTags: ['application_code_derived', 'config_only', 'aggregate_only'],
        sourceFiles: [
          'MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/DerDefaultsEpaConfig.hbm.xml',
          'MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/DerDefaultsEpa.hbm.xml',
        ],
      },
    ],
    enabled: true,
  },
])

describe('MysqlDataDiagnosticsAdapter local operator LDAP code-derived diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS', 'true')
    vi.stubEnv('INVESTIGATION_DB_USERNAME', 'operator')
    vi.stubEnv('INVESTIGATION_DB_PASSWORD', 'operator-secret')
    vi.stubEnv('MERIDIAN_DB_USERNAME', '')
    vi.stubEnv('MERIDIAN_DB_PASSWORD', '')
    mysqlMocks.query.mockImplementation(async (sql: string) => {
      if (/@@session\.transaction_read_only/i.test(sql)) {
        return [[{ transaction_read_only: 1 }]]
      }
      if (/FROM epa_config/i.test(sql)) {
        return [[{
          source_name: 'epa_config',
          scope_key: 'e_appeal_allowed',
          total_rows: '2',
          enabled_rows: '1',
          disabled_or_null_rows: '1',
        }]]
      }
      return [[]]
    })
    mysqlMocks.end.mockResolvedValue(undefined)
    mysqlMocks.createConnection.mockResolvedValue({
      query: mysqlMocks.query,
      end: mysqlMocks.end,
    })
    sshTunnelMocks.startSshTunnel.mockResolvedValue({
      localPort: 44123,
      process: { exitCode: null },
      stderrTail: [],
    })
    sshTunnelMocks.stopSshTunnel.mockResolvedValue(undefined)
  })

  it('uses a semantic-profile code-derived ePA diagnostic with empty allowedQueryPacks', async () => {
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => localOperatorTarget,
        listTargets: async () => [localOperatorTarget],
      },
      undefined,
      semanticProfiles,
      new QueryValidator(),
      new PhiGuard(),
      { resolve: async () => ({ password: 'operator-secret' }) },
    )

    const result = await adapter.execute(request)
    const traceSteps = result.telemetry.traceSteps ?? []

    expect(traceSteps.find(step => step.phase === 'select_query_pack')).toMatchObject({
      queryPackId: 'appcode_epa_eappeal_config_validation',
    })
    expect(traceSteps.find(step => step.id === 'inv-test-data-readonly')).toMatchObject({
      title: 'Enforce read-only DB session',
    })
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('SESSION transaction_read_only = ON'))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM epa_config'))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM der_defaults_epa_config'))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('JOIN der_defaults_epa'))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN der_status'))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('LEFT JOIN der_status_reason'))
    expect(mysqlMocks.query).not.toHaveBeenCalledWith(expect.stringContaining('FROM ncpdp_epa_transaction_history'))

    const executionTrace = traceSteps.find(step => step.phase === 'execute_query')
    expect(result.findings[0]?.title).toContain('code-derived DB diagnostic completed')
    expect(result.findings[0]?.summary).toContain('epa_config/e_appeal_allowed')
    expect(result.findings[0]?.summary).toContain('enabled=1')
    expect(result.findings[0]?.summary).not.toContain('undefined')
    expect(executionTrace?.safeSql).not.toContain('12345678901')
    expect(JSON.stringify(result)).not.toContain('12345678901')
    expect(JSON.stringify(result)).not.toContain('12345678902')
  })

  it('does not run SQL when no semantic profile diagnostic matches', async () => {
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => localOperatorTarget,
        listTargets: async () => [localOperatorTarget],
      },
      undefined,
      new InMemoryCodeSemanticProfileRegistry([]),
      new QueryValidator(),
      new PhiGuard(),
      { resolve: async () => ({ password: 'operator-secret' }) },
    )

    const result = await adapter.execute({
      ...request,
      scope: {
        ...request.scope,
        ticketContext: { ...request.scope.ticketContext, identifiers: [], evidenceAnchors: [] },
      },
    })
    const traceSteps = result.telemetry.traceSteps ?? []

    expect(traceSteps.find(step => step.phase === 'select_query_pack')).toMatchObject({
      queryPackId: undefined,
    })
    expect(mysqlMocks.createConnection).not.toHaveBeenCalled()
    expect(result.findings).toEqual([])
    expect(result.evidence).toEqual([])
  })

  it('runs configured foundational anchor probes without a semantic code diagnostic', async () => {
    mysqlMocks.query.mockImplementation(async (sql: string) => {
      if (/@@session\.transaction_read_only/i.test(sql)) {
        return [[{ transaction_read_only: 1 }]]
      }
      if (/information_schema\.columns/i.test(sql)) {
        return [[
          { table_name: 'auth', column_name: 'case_number' },
          { table_name: 'auth', column_name: 'status' },
        ]]
      }
      if (/FROM `auth`/i.test(sql)) {
        return [[{ anchor_scope: '[ANCHOR]', anchor_kind: 'case_number', matched_rows: 1 }]]
      }
      return [[]]
    })
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => localOperatorTarget,
        listTargets: async () => [localOperatorTarget],
      },
      undefined,
      new InMemoryCodeSemanticProfileRegistry([]),
      new QueryValidator(),
      new PhiGuard(),
      { resolve: async () => ({ password: 'operator-secret' }) },
    )

    const result = await adapter.execute(request)

    expect(result.findings[0]).toMatchObject({ type: 'anchor_data_match' })
    expect(mysqlMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.columns'),
      expect.arrayContaining(['auth']),
    )
    expect(mysqlMocks.query).toHaveBeenCalledWith(
      expect.stringContaining('WHERE `case_number` IN (?, ?)'),
      ['12345678901', '12345678902'],
    )
    expect(JSON.stringify(result)).not.toContain('12345678901')
  })

  it('falls back to a code-derived workflow queue-routing diagnostic planner when no profile pack matches', async () => {
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => localOperatorTarget,
        listTargets: async () => [localOperatorTarget],
      },
      undefined,
      new InMemoryCodeSemanticProfileRegistry([]),
      new QueryValidator(),
      new PhiGuard(),
      { resolve: async () => ({ password: 'operator-secret' }) },
    )

    const result = await adapter.execute({
      ...request,
      scope: {
        ...request.scope,
        ticketContext: {
          source: 'jira',
          jiraKey: 'CPSUP-46150',
          fetchStatus: 'fetched',
          title: 'AOR Review and VMD subtask visible in Nurse Review Unassigned portlet',
        },
        diagnosticContext: {
          codeEvidenceTerms: ['QueueAuthorization', 'getAppGroupByTaskName', 'process_flow', 'adhok_business_task'],
          dataFlowHints: [
            {
              sourceRepo: 'core-app',
              sourcePath: 'mm-shared-services/src/main/java/com/medhok/mm/shared/service/BPMSharedService.java',
              artifactType: 'hql_literal',
              tableName: 'queue_authorization',
            },
            {
              sourceRepo: 'core-app',
              sourcePath: 'MedicalMgmtModels/src/main/resources/com/medhok/mm/server/models/ProcessFlow.hbm.xml',
              artifactType: 'hibernate_mapping',
              tableName: 'process_flow',
              columns: [{ name: 'active_group', propertyName: 'activeGroup' }],
            },
          ],
        },
      },
    })
    const traceSteps = result.telemetry.traceSteps ?? []

    expect(traceSteps.find(step => step.phase === 'select_query_pack')).toMatchObject({
      queryPackId: 'appcode_workflow_queue_routing',
    })
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM adhok_business_process abp'))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining('FROM adhok_business_task abt'))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining("'AOR Review'"))
    expect(mysqlMocks.query).toHaveBeenCalledWith(expect.stringContaining("'VMD'"))
    expect(result.findings[0]?.title).toContain('code-derived DB diagnostic completed')
  })

  it('returns failed-attempt evidence with the selected code-derived diagnostic when DB connection fails', async () => {
    mysqlMocks.createConnection.mockRejectedValueOnce(new Error('connect ECONNREFUSED 127.0.0.1:3332'))
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => localOperatorTarget,
        listTargets: async () => [localOperatorTarget],
      },
      undefined,
      semanticProfiles,
      new QueryValidator(),
      new PhiGuard(),
      { resolve: async () => ({ password: 'operator-secret' }) },
    )

    const result = await adapter.execute(request)

    expect(result.findings[0]).toMatchObject({
      type: 'database_access_failure',
      summary: 'connect ECONNREFUSED 127.0.0.1:3332',
      evidenceRefs: ['inv-test-data-attempt-failed'],
    })
    expect(result.evidence[0]).toMatchObject({
      id: 'inv-test-data-attempt-failed',
      title: 'Code-derived database diagnostic attempt failed',
    })
    expect(result.evidence[0]?.metadata?.queryPackId).toBe('appcode_epa_eappeal_config_validation')
    expect(JSON.stringify(result.evidence[0]?.metadata)).toContain('der_defaults_epa_config')
  })

  it('resolves env-backed DB usernames for local operator LDAP targets', async () => {
    vi.stubEnv('INVESTIGATION_DB_USERNAME', 'test-operator')
    const envUserTarget = {
      ...localOperatorTarget,
      dbUser: 'env://INVESTIGATION_DB_USERNAME',
    }
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => envUserTarget,
        listTargets: async () => [envUserTarget],
      },
      undefined,
      semanticProfiles,
      new QueryValidator(),
      new PhiGuard(),
      { resolve: async () => ({ password: 'operator-secret' }) },
    )

    await adapter.execute(request)

    expect(mysqlMocks.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      user: 'test-operator',
      password: 'operator-secret',
    }))
  })

  it('resolves operator LDAP SSH env credentials for local database diagnostics', async () => {
    vi.stubEnv('INVESTIGATION_OPERATOR_SSH_USER', 'test-operator')
    vi.stubEnv('INVESTIGATION_OPERATOR_SSH_PASSWORD', 'operator-secret')
    const operatorLdapTarget = {
      ...localOperatorTarget,
      networkPath: 'ssh_public' as const,
      dbUser: 'env://INVESTIGATION_OPERATOR_SSH_USER',
      secretRef: 'env://INVESTIGATION_OPERATOR_SSH_PASSWORD',
    }
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => operatorLdapTarget,
        listTargets: async () => [operatorLdapTarget],
      },
      undefined,
      semanticProfiles,
    )

    await adapter.execute(request)

    expect(mysqlMocks.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      user: 'test-operator',
      password: 'operator-secret',
    }))
  })

  it('uses code-derived diagnostics for remote operator LDAP SSH database targets', async () => {
    const remoteSshTarget: InvestigationConnectionTarget = {
      ...localOperatorTarget,
      id: 'humana-prod-replica-jira-ldap-db',
      clientId: 'PERFORMRX',
      environment: 'UAT',
      topology: 'ec2_mysql',
      host: '10.241.47.82',
      port: 3306,
      networkPath: 'ssh_public',
      hostTargetId: 'humana-prod-linux-batch',
      dbUser: 'env://INVESTIGATION_DB_USERNAME',
      secretRef: 'env://INVESTIGATION_DB_PASSWORD',
    }
    const hostTarget = {
      id: 'humana-prod-linux-batch',
      clientId: 'PERFORMRX',
      environment: 'UAT' as const,
      envId: 'PROD2',
      awsAccountId: '',
      region: 'us-east-2',
      instanceId: 'i-0bcf13fa4d5875236',
      instanceName: 'HUMANA PROD1 BATCH LINUX MP',
      vpcId: '',
      subnetId: '',
      networkPath: 'ssh_public' as const,
      instanceProfileArn: '',
      expectedRoleName: '',
      publicHost: '10.241.47.84',
      sshUser: 'operator',
      sshAuthMode: 'operator_ldap' as const,
      sshControlPath: '/tmp/cockpit-operator.sock',
      sshAllowed: true,
      ssmAllowed: false,
      enabled: true,
    }
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => remoteSshTarget,
        listTargets: async () => [remoteSshTarget],
      },
      {
        resolveTarget: async () => hostTarget,
        listTargets: async () => [hostTarget],
      },
      semanticProfiles,
    )

    const result = await adapter.execute(request)
    const traceSteps = result.telemetry.traceSteps ?? []

    expect(traceSteps.find(step => step.phase === 'select_query_pack')).toMatchObject({
      queryPackId: 'appcode_epa_eappeal_config_validation',
    })
    expect(sshTunnelMocks.startSshTunnel).toHaveBeenCalledWith(expect.objectContaining({
      sshHost: '10.241.47.84',
      sshUser: 'operator',
      remoteHost: '10.241.47.82',
      remotePort: 3306,
      controlPath: '/tmp/cockpit-operator.sock',
    }))
    expect(mysqlMocks.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      host: '127.0.0.1',
      port: 44123,
      user: 'operator',
      password: 'operator-secret',
    }))
    expect(result.findings[0]?.title).toContain('code-derived DB diagnostic completed')
    expect(sshTunnelMocks.stopSshTunnel).toHaveBeenCalled()
  })

  it('falls back to MERIDIAN operator DB credentials when Cockpit DB env is not set', async () => {
    vi.stubEnv('INVESTIGATION_DB_USERNAME', '')
    vi.stubEnv('INVESTIGATION_DB_PASSWORD', '')
    vi.stubEnv('MERIDIAN_DB_USERNAME', 'meridian-operator')
    vi.stubEnv('MERIDIAN_DB_PASSWORD', 'meridian-secret')
    const meridianFallbackTarget = {
      ...localOperatorTarget,
      dbUser: 'env://INVESTIGATION_DB_USERNAME',
      secretRef: 'env://INVESTIGATION_DB_PASSWORD',
    }
    const adapter = new MysqlDataDiagnosticsAdapter(
      {
        resolveTarget: async () => meridianFallbackTarget,
        listTargets: async () => [meridianFallbackTarget],
      },
      undefined,
      semanticProfiles,
    )

    await adapter.execute(request)

    expect(mysqlMocks.createConnection).toHaveBeenCalledWith(expect.objectContaining({
      user: 'meridian-operator',
      password: 'meridian-secret',
      database: 'medhok',
    }))
  })
})
