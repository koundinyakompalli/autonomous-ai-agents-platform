import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import type { DataDiagnosticsAdapter } from './types.js'
import type { InvestigationAdapterRequest, InvestigationAdapterResult, InvestigationAdapterTraceStep, InvestigationQueryPack } from '../types/investigation.js'
import type { InvestigationConnectionRegistry, InvestigationConnectionTarget } from '../data/ConnectionRegistry.js'
import type { InvestigationHostTargetRegistry, InvestigationHostTarget } from '../data/HostTargetRegistry.js'
import {
  NoopCodeSemanticProfileRegistry,
  type InvestigationCodeSemanticProfileRegistry,
} from '../data/CodeSemanticProfileRegistry.js'
import { planCodeDerivedDiagnostic } from '../data/CodeDerivedDiagnosticPlanner.js'
import { QueryValidator } from '../data/QueryValidator.js'
import { PhiGuard } from '../data/PhiGuard.js'
import {
  buildAnchorProbeQueries,
  buildColumnInventoryQuery,
  getAnchorDiagnosticTables,
  hasAnchorDrivenProbeScope,
  type AnchorProbeQuery,
  type CodeFlowColumnInventoryRow,
} from '../data/AnchorDrivenDataProbe.js'
import { startSshTunnel, stopSshTunnel, type SshTunnel } from '../utils/SshTunnel.js'

const execFileAsync = promisify(execFile)
const DEFAULT_DATA_DIAGNOSTIC_TIMEOUT_MS = 5_000
const MAX_DATA_DIAGNOSTIC_TIMEOUT_MS = 60_000
const DEFAULT_SECRET_LOOKUP_TIMEOUT_MS = 15_000

interface SecretResolver {
  resolve(
    target: InvestigationConnectionTarget,
  ): Promise<{ password: string | null }>
}

interface DbCredentialMaterial {
  username: string
  password: string
  database?: string
  source: 'operator_runtime' | 'target_secret'
}

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  if (!value) {
    return fallback
  }
  return ['1', 'true', 'yes', 'on'].includes(value)
}

function requireOperatorDbCredentials(): boolean {
  return envFlag('INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS', true)
}

function allowTargetSecretDbCredentials(): boolean {
  return envFlag('INVESTIGATION_ALLOW_TARGET_SECRET_DB_CREDENTIALS', false)
}

function operatorDbCredentialMaterial(target: InvestigationConnectionTarget): DbCredentialMaterial {
  const username = process.env.INVESTIGATION_DB_USERNAME?.trim() || process.env.MERIDIAN_DB_USERNAME?.trim()
  const password = process.env.INVESTIGATION_DB_PASSWORD || process.env.MERIDIAN_DB_PASSWORD
  const database = process.env.INVESTIGATION_DB_DATABASE?.trim() || process.env.MERIDIAN_DB_DATABASE?.trim() || target.databaseName || undefined

  if (!username || !password) {
    throw new Error(
      'Investigation Cockpit operator DB credential mode is enabled. '
      + 'Set INVESTIGATION_DB_USERNAME/INVESTIGATION_DB_PASSWORD or MERIDIAN_DB_USERNAME/MERIDIAN_DB_PASSWORD for the attended run; '
      + 'target/shared DB credentials are not allowed in this mode.',
    )
  }

  return {
    username,
    password,
    database,
    source: 'operator_runtime',
  }
}

function dbSslOptions(target: InvestigationConnectionTarget): { ca: string; rejectUnauthorized: true } | undefined {
  if (!target.sslRequired) {
    return undefined
  }

  const caPath = target.sslCa || process.env.INVESTIGATION_DB_SSL_CA?.trim()
  if (!caPath) {
    throw new Error(`DB target ${target.id} requires TLS, but no sslCa or INVESTIGATION_DB_SSL_CA is configured`)
  }

  return {
    ca: readFileSync(caPath, 'utf8'),
    rejectUnauthorized: true,
  }
}

async function enforceReadonlyMysqlSession(connection: mysql.Connection, targetId: string): Promise<void> {
  await connection.query('SET SESSION max_execution_time=10000, SESSION transaction_read_only=ON')
  const [readonlyRows] = await connection.query<RowDataPacket[]>('SELECT @@session.transaction_read_only AS session_readonly')
  const sessionReadonly =
    Array.isArray(readonlyRows) && readonlyRows.length > 0
      ? String((readonlyRows[0] as Record<string, unknown>).session_readonly)
      : '0'
  if (!['1', 'ON', 'on', 'true', 'True'].includes(sessionReadonly)) {
    throw new Error(`DB target ${targetId} did not enter transaction_read_only session mode`)
  }
}


class DefaultSecretResolver implements SecretResolver {
  async resolve(target: InvestigationConnectionTarget): Promise<{ password: string | null }> {
    if (target.secretRef.startsWith('env://')) {
      const envName = target.secretRef.slice('env://'.length)
      return {
        password: process.env[envName]?.trim()
          || (envName === 'INVESTIGATION_DB_PASSWORD' ? process.env.MERIDIAN_DB_PASSWORD?.trim() : undefined)
          || null,
      }
    }

    if (target.secretRef.startsWith('sm://')) {
      const secretId = target.secretRef.slice('sm://'.length)
      const args = [
        ...(process.env.INVESTIGATION_CLIENT_A_AWS_PROFILE ? ['--profile', process.env.INVESTIGATION_CLIENT_A_AWS_PROFILE] : []),
        'secretsmanager',
        'get-secret-value',
        '--region',
        process.env.INVESTIGATION_CLIENT_A_AWS_REGION || 'us-east-2',
        '--secret-id',
        secretId,
        '--output',
        'json',
      ]
      const { stdout } = await execFileAsync('aws', args, {
        maxBuffer: 1024 * 1024 * 4,
        timeout: DEFAULT_SECRET_LOOKUP_TIMEOUT_MS,
        killSignal: 'SIGTERM',
      })
      const payload = JSON.parse(stdout) as { SecretString?: string }
      if (!payload.SecretString) {
        return { password: null }
      }
      try {
        const parsed = JSON.parse(payload.SecretString) as { password?: string }
        return { password: parsed.password?.trim() || null }
      } catch {
        return { password: payload.SecretString.trim() || null }
      }
    }

    return { password: null }
  }
}

export class NoopDataDiagnosticsAdapter implements DataDiagnosticsAdapter {
  readonly kind = 'data' as const

  async execute(_request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    return {
      findings: [],
      evidence: [],
      telemetry: {
        durationMs: 0,
        requestsIssued: 0,
        rowsRead: 0,
        traceSteps: [],
      },
    }
  }
}

function boundedTimeoutMs(value: unknown, fallback = DEFAULT_DATA_DIAGNOSTIC_TIMEOUT_MS): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback
  }
  return Math.max(1_000, Math.min(parsed, MAX_DATA_DIAGNOSTIC_TIMEOUT_MS))
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    timer.unref?.()
  })

  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) {
      clearTimeout(timer)
    }
  }
}

function resolveDbUser(target: InvestigationConnectionTarget): string | null {
  if (target.dbUser.startsWith('env://')) {
    const envName = target.dbUser.slice('env://'.length)
    return process.env[envName]?.trim()
      || (envName === 'INVESTIGATION_DB_USERNAME' ? process.env.MERIDIAN_DB_USERNAME?.trim() : undefined)
      || null
  }
  return target.dbUser.trim() || null
}

export class MysqlDataDiagnosticsAdapter implements DataDiagnosticsAdapter {
  readonly kind = 'data' as const

  constructor(
    private readonly connectionRegistry: InvestigationConnectionRegistry,
    private readonly hostTargetRegistry?: InvestigationHostTargetRegistry,
    private readonly codeSemanticProfileRegistry: InvestigationCodeSemanticProfileRegistry = new NoopCodeSemanticProfileRegistry(),
    private readonly queryValidator = new QueryValidator(),
    private readonly phiGuard = new PhiGuard(),
    private readonly secretResolver: SecretResolver = new DefaultSecretResolver(),
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
    const startedAt = Date.now()
    const traceSteps: InvestigationAdapterTraceStep[] = []

    const target = await this.connectionRegistry.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
    )

    traceSteps.push({
      id: `${request.runId}-data-resolve`,
      adapter: 'data',
      phase: 'resolve_target',
      title: 'Resolve approved DB target',
      detail: target
        ? `Resolved ${target.topology} target ${target.id} for ${request.scope.clientId} ${request.scope.environment}.`
        : `No approved DB target exists for ${request.scope.clientId} ${request.scope.environment}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      connectionTargetId: target?.id,
    })

    if (!target) {
      return {
        findings: [],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      }
    }

    const codeDerivedDiagnostic = this.shouldUseApplicationCodeDerivedDiagnostic(target)
      ? await this.resolveCodeDerivedDiagnostic(request)
      : null
    const pack = codeDerivedDiagnostic ? this.withRequestContext(codeDerivedDiagnostic, request) : null
    const anchorDriven = hasAnchorDrivenProbeScope(request.scope)

    traceSteps.push({
      id: `${request.runId}-data-pack`,
      adapter: 'data',
      phase: 'select_query_pack',
      title: 'Select code-derived SQL diagnostic',
      detail: pack
        ? `Selected ${pack.id} from application-code-derived diagnostics for operator LDAP target ${target.id}.`
        : `No code-derived SQL diagnostic matched the ticket/code context for ${target.id}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId: pack?.id,
      connectionTargetId: target.id,
    })

    if (!pack && !anchorDriven) {
      return {
        findings: [],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      }
    }

    const validation = pack ? this.queryValidator.validate(pack) : null
    traceSteps.push({
      id: `${request.runId}-data-validate`,
      adapter: 'data',
      phase: 'validate_query',
      title: 'Validate code-derived SQL',
      detail: pack && validation?.valid
        ? `Validated ${pack.id} against read-only query guardrails.`
        : pack
          ? `Validation failed for ${pack.id}: ${validation?.reasons.join('; ')}`
          : 'Validated the configured anchor-driven path; only parameter-bound SELECT statements may execute.',
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId: pack?.id,
      connectionTargetId: target.id,
      safeSql: pack ? this.safeSqlForTrace(pack.sql, request) : undefined,
    })

    if (pack && validation && !validation.valid) {
      return {
        findings: [
          {
            id: `${request.runId}-data-pack-invalid`,
            adapter: 'data',
            type: 'code_derived_diagnostic_invalid',
            severity: 'critical',
            confidence: 0.2,
            title: 'Code-derived data diagnostic failed validation',
            summary: validation.reasons.join('; '),
            evidenceRefs: [],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
        ],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      }
    }

    if (pack && target.topology === 'ec2_mysql' && target.hostTargetId && target.hostAuthFile) {
      if (requireOperatorDbCredentials() || !allowTargetSecretDbCredentials()) {
        traceSteps.push({
          id: `${request.runId}-data-secret`,
          adapter: 'data',
          phase: 'load_secret',
          title: 'Reject host-side DB auth source',
          detail: 'Operator DB credential mode is the default; host-side shared auth sources require separate explicit approval.',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
        })
        return {
          findings: [
            {
              id: `${request.runId}-data-access-failure`,
              adapter: 'data',
              type: 'database_access_failure',
              severity: 'high',
              confidence: 0.25,
              title: 'Operator database credential mode blocked host-side DB diagnostics',
              summary: 'SSM host-side DB auth cannot attribute the diagnostic query to the operator LDAP identity.',
              evidenceRefs: [],
              requiresCodeChange: false,
              requiresDataChange: false,
            },
          ],
          evidence: [],
          telemetry: {
            durationMs: Date.now() - startedAt,
            requestsIssued: 1,
            rowsRead: 0,
            traceSteps,
          },
        }
      }


      traceSteps.push({
        id: `${request.runId}-data-secret`,
        adapter: 'data',
        phase: 'load_secret',
        title: 'Load approved host DB auth source',
        detail: `Using host-side auth source ${target.hostAuthFile} on ${target.hostTargetId}.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
      })
      try {
        return await this.executeViaSsmHost(request, target, pack.sql, pack.id, traceSteps, startedAt)
      } catch (error) {
        return {
          findings: [
            {
              id: `${request.runId}-data-access-failure`,
              adapter: 'data',
              type: 'database_access_failure',
              severity: 'high',
              confidence: 0.25,
              title: 'SSM-backed database diagnostic could not complete the bounded query',
              summary: error instanceof Error ? error.message : String(error),
              evidenceRefs: [],
              requiresCodeChange: false,
              requiresDataChange: false,
            },
          ],
          evidence: [],
          telemetry: {
            durationMs: Date.now() - startedAt,
            requestsIssued: 1,
            rowsRead: 0,
            traceSteps,
          },
        }
      }
    }

    const dbUser = resolveDbUser(target)
    const { password } = await this.secretResolver.resolve(target)
    traceSteps.push({
      id: `${request.runId}-data-secret`,
      adapter: 'data',
      phase: 'load_secret',
      title: 'Load DB credential',
      detail: dbUser && password
        ? `Loaded runtime DB credentials from the approved references for ${target.id}.`
        : `DB username or password is not configured yet for ${target.id}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      connectionTargetId: target.id,
    })

    if (!dbUser || !password) {
      return {
        findings: [],
        evidence: [
          {
            id: `${request.runId}-data-config-pending`,
            adapter: 'data',
            title: 'Approved data path is configured but credentials are not loaded',
            summary: `Target ${target.id} (${target.topology}) is registered, but runtime DB credentials are not configured in this runtime.`,
            contentType: 'text/plain',
            metadata: {
              topology: target.topology,
              traceSteps: traceSteps.map(step => ({
                title: step.title,
                detail: step.detail,
                safeSql: step.safeSql,
                rowCount: step.rowCount,
              })),
            },
          },
        ],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      }
    }

    const timeoutMs = boundedTimeoutMs(pack?.timeoutMs, boundedTimeoutMs(request.constraints.timeoutMs))
    let connection: mysql.Connection | null = null
    // eslint-disable-next-line prefer-const
    let sshTunnel: SshTunnel | undefined
    try {
      // For ssh_public targets, open an SSH tunnel through the batch host before
      // connecting mysql2. The tunnel is torn down in the finally block regardless
      // of success or failure. No pre-existing tunnel is required.
      const connectHost = await (async () => {
        if (target.networkPath !== 'ssh_public' || !target.hostTargetId) {
          return { host: target.host, port: target.port }
        }
        const hostTarget = await this.hostTargetRegistry?.resolveTarget(
          request.scope.clientId,
          request.scope.environment,
          target.hostTargetId,
        ) as InvestigationHostTarget | undefined
        if (!hostTarget?.publicHost) {
          return { host: target.host, port: target.port }
        }
        sshTunnel = await startSshTunnel({
          sshHost: hostTarget.publicHost,
          sshPort: hostTarget.sshPort ?? 22,
          sshUser: hostTarget.sshUser
            ?? process.env.INVESTIGATION_OPERATOR_SSH_USER
            ?? process.env.MERIDIAN_SSH_USER
            ?? process.env.INVESTIGATION_SSH_USER,
          remoteHost: target.host,
          remotePort: target.port,
          controlPath: hostTarget.sshControlPath
            ?? process.env.INVESTIGATION_SSH_CONTROL_PATH
            ?? process.env.MERIDIAN_SSH_CONTROL_PATH,
        })
        traceSteps.push({
          id: `${request.runId}-data-tunnel-open`,
          adapter: 'data',
          phase: 'open_connection',
          title: 'Open SSH tunnel to DB',
          detail: `Opened SSH tunnel through ${hostTarget.publicHost} → ${target.host}:${target.port} on local port ${sshTunnel.localPort}.`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
        })
        return { host: '127.0.0.1', port: sshTunnel.localPort }
      })()

      connection = await withTimeout(mysql.createConnection({
        host: connectHost.host,
        port: connectHost.port,
        user: dbUser,
        password,
        database: target.databaseName || undefined,
        ssl: dbSslOptions(target),
        connectTimeout: timeoutMs,
      }), timeoutMs, `Open MySQL session for ${target.id}`)

      await withTimeout(
        connection.query('SET SESSION max_execution_time=7000, SESSION transaction_read_only = ON'),
        timeoutMs,
        `Enable read-only DB session for ${target.id}`,
      )
      const [readonlyRows] = await withTimeout(connection.query<RowDataPacket[]>(
        'SELECT @@session.transaction_read_only AS transaction_read_only',
      ), timeoutMs, `Verify read-only DB session for ${target.id}`)
      const sessionReadonly = Number(readonlyRows[0]?.transaction_read_only) === 1
      traceSteps.push({
        id: `${request.runId}-data-readonly`,
        adapter: 'data',
        phase: 'open_connection',
        title: 'Enforce read-only DB session',
        detail: sessionReadonly
          ? 'SET SESSION transaction_read_only=ON was verified before executing diagnostics.'
          : 'SET SESSION transaction_read_only=ON did not verify before executing diagnostics.',
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
      })

      if (!sessionReadonly) {
        throw new Error('DB diagnostics session did not verify transaction_read_only=ON.')
      }

      traceSteps.push({
        id: `${request.runId}-data-open`,
        adapter: 'data',
        phase: 'open_connection',
        title: 'Open read-only DB session',
        detail: `Opened a ${target.topology} MySQL session to ${target.host}:${target.port}.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        connectionTargetId: target.id,
      })

      if (!pack) {
        return await this.executeAnchorDrivenProbe(
          request,
          target,
          connection,
          traceSteps,
          startedAt,
        )
      }

      const [rows] = await withTimeout(
        connection.query<RowDataPacket[]>(pack.sql),
        timeoutMs,
        `Execute data diagnostic ${pack.id}`,
      )
      const redactedRows = this.phiGuard.redactRows(rows as Array<Record<string, unknown>>)

      traceSteps.push({
        id: `${request.runId}-data-exec`,
        adapter: 'data',
        phase: 'execute_query',
        title: 'Execute approved data diagnostic',
        detail: `Executed ${pack.id} against ${target.topology}.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        queryPackId: pack.id,
        connectionTargetId: target.id,
        safeSql: this.safeSqlForTrace(pack.sql, request),
        rowCount: redactedRows.length,
      })

      traceSteps.push({
        id: `${request.runId}-data-redact`,
        adapter: 'data',
        phase: 'redact_results',
        title: 'Redact diagnostic output',
        detail: `Applied PHI redaction rules to ${redactedRows.length} rows.`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        queryPackId: pack.id,
        connectionTargetId: target.id,
        rowCount: redactedRows.length,
      })

      const packResult = this.buildSuccessResult(request, target, pack.id, redactedRows, traceSteps, startedAt)
      if (!anchorDriven) {
        return packResult
      }
      const anchorResult = await this.executeAnchorDrivenProbe(
        request,
        target,
        connection,
        traceSteps,
        startedAt,
      )
      return {
        findings: [...packResult.findings, ...anchorResult.findings],
        evidence: [...packResult.evidence, ...anchorResult.evidence],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: packResult.telemetry.requestsIssued + anchorResult.telemetry.requestsIssued,
          rowsRead: (packResult.telemetry.rowsRead || 0) + (anchorResult.telemetry.rowsRead || 0),
          traceSteps,
        },
      }
    } catch (error) {
      return {
        findings: [
          {
            id: `${request.runId}-data-access-failure`,
            adapter: 'data',
            type: 'database_access_failure',
            severity: 'high',
            confidence: 0.25,
            title: 'Code-derived database diagnostic could not complete the bounded query',
            summary: error instanceof Error ? error.message : String(error),
            evidenceRefs: [`${request.runId}-data-attempt-failed`],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
        ],
        evidence: [
          {
            id: `${request.runId}-data-attempt-failed`,
            adapter: 'data',
            title: 'Code-derived database diagnostic attempt failed',
            summary: `Selected ${pack?.id || 'anchor-driven diagnostic'} for ${target.topology} target ${target.id}, but the DB connection failed before SQL execution: ${error instanceof Error ? error.message : String(error)}`,
            contentType: 'application/json',
            metadata: {
              topology: target.topology,
              queryPackId: pack?.id,
              traceSteps: traceSteps.map(step => ({
                title: step.title,
                detail: step.detail,
                safeSql: step.safeSql,
                rowCount: step.rowCount,
              })),
            },
          },
        ],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 1,
          rowsRead: 0,
          traceSteps,
        },
      }
    } finally {
      if (connection) {
        await withTimeout(
          connection.end(),
          Math.min(timeoutMs, 1_000),
          `Close MySQL session for ${target.id}`,
        ).catch(() => undefined)
        traceSteps.push({
          id: `${request.runId}-data-close`,
          adapter: 'data',
          phase: 'close_connection',
          title: 'Close DB session',
          detail: `Closed the MySQL session for ${target.id}.`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
        })
      }
      const tunnel = sshTunnel
      if (tunnel) {
        await stopSshTunnel(tunnel).catch(() => undefined)
        traceSteps.push({
          id: `${request.runId}-data-tunnel-close`,
          adapter: 'data',
          phase: 'close_connection',
          title: 'Close SSH tunnel',
          detail: `Closed SSH tunnel on local port ${tunnel.localPort}.`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
        })
      }
    }
  }

  private async executeAnchorDrivenProbe(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    connection: mysql.Connection,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): Promise<InvestigationAdapterResult> {
    const tableNames = getAnchorDiagnosticTables(request.scope)
    const inventoryQuery = buildColumnInventoryQuery(tableNames)
    if (!inventoryQuery) {
      return this.buildAnchorDrivenResult(request, target, [], [], traceSteps, startedAt)
    }

    const [inventoryRows] = await withTimeout(
      connection.query<RowDataPacket[]>(inventoryQuery.sql, inventoryQuery.parameters),
      8_000,
      'Read anchor diagnostic column inventory',
    )
    traceSteps.push({
      id: `${request.runId}-data-anchor-inventory`,
      adapter: 'data',
      phase: 'execute_query',
      title: 'Read anchor diagnostic column inventory',
      detail: `Loaded column metadata for ${tableNames.length} configured/code-derived table(s).`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      connectionTargetId: target.id,
      safeSql: inventoryQuery.sql,
      rowCount: inventoryRows.length,
    })

    const probes = buildAnchorProbeQueries(
      request.scope,
      inventoryRows as CodeFlowColumnInventoryRow[],
    )
    const rows: Array<Record<string, unknown>> = []
    const probeSummaries: Array<Record<string, unknown>> = []
    for (const probe of probes) {
      try {
        const [probeRows] = await withTimeout(
          connection.query<RowDataPacket[]>(probe.sql, probe.parameters),
          8_000,
          `Execute anchor diagnostic for ${probe.tableName}`,
        )
        const redacted = this.phiGuard.redactRows(probeRows as Array<Record<string, unknown>>)
        rows.push(...redacted)
        probeSummaries.push(this.summarizeAnchorProbe(probe, redacted))
        traceSteps.push({
          id: `${request.runId}-data-${probe.id}`,
          adapter: 'data',
          phase: 'execute_query',
          title: probe.title,
          detail: `Executed a parameter-bound read-only diagnostic for ${probe.tableName}.${probe.anchorColumn}; anchor values are omitted from traces.`,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
          safeSql: probe.sql,
          rowCount: redacted.length,
        })
      } catch (error) {
        probeSummaries.push({
          tableName: probe.tableName,
          anchorKind: probe.anchorKind,
          anchorColumn: probe.anchorColumn,
          sourcePath: probe.sourcePath,
          rowCount: 0,
          matchedRows: 0,
          incomplete: true,
          failure: error instanceof Error ? error.message : String(error),
        })
        traceSteps.push({
          id: `${request.runId}-data-${probe.id}-incomplete`,
          adapter: 'data',
          phase: 'execute_query',
          title: `${probe.title} did not complete`,
          detail: 'The bounded query exceeded its per-query budget; later probes were not started on the same connection.',
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          connectionTargetId: target.id,
          safeSql: probe.sql,
          rowCount: 0,
        })
        break
      }
    }
    return this.buildAnchorDrivenResult(request, target, rows, probeSummaries, traceSteps, startedAt)
  }

  private summarizeAnchorProbe(
    probe: AnchorProbeQuery,
    rows: Array<Record<string, unknown>>,
  ): Record<string, unknown> {
    const first = rows[0] || {}
    return {
      tableName: probe.tableName,
      anchorKind: probe.anchorKind,
      anchorColumn: probe.anchorColumn,
      sourcePath: probe.sourcePath,
      relationship: probe.relationship,
      rowCount: rows.length,
      matchedRows: Number(first.matched_rows ?? first.MATCHED_ROWS ?? 0) || 0,
    }
  }

  private buildAnchorDrivenResult(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    rows: Array<Record<string, unknown>>,
    probeSummaries: Array<Record<string, unknown>>,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): InvestigationAdapterResult {
    const matchedRows = probeSummaries.reduce(
      (total, summary) => total + (typeof summary.matchedRows === 'number' ? summary.matchedRows : 0),
      0,
    )
    const evidenceId = `${request.runId}-data-anchor-evidence`
    const chainIds = Array.from(new Set(
      (request.scope.diagnosticContext?.dataFlowHints || []).flatMap(hint =>
        (hint.columns || []).map(column => `persistence-contract:${hint.tableName.toLowerCase()}.${column.name.toLowerCase()}`),
      ),
    )).slice(0, 40)
    const matchedProbeSummaries = probeSummaries.filter(summary => Number(summary.matchedRows || 0) > 0)
    return {
      findings: [{
        id: `${request.runId}-data-anchor`,
        adapter: 'data',
        type: matchedRows > 0 ? 'anchor_data_match' : 'anchor_data_probe',
        severity: matchedRows > 0 ? 'medium' : 'low',
        confidence: matchedRows > 0 ? 0.74 : probeSummaries.length > 0 ? 0.58 : 0.4,
        title: matchedRows > 0
          ? 'Read-only data evidence matched ticket anchors'
          : 'Read-only anchor probe completed without a record match',
        summary: `Executed ${probeSummaries.length} bounded read-only diagnostic(s) for ${target.id}; ${matchedRows} anchored row match(es) were found.`,
        evidenceRefs: [evidenceId],
        requiresCodeChange: false,
        requiresDataChange: false,
        metadata: { probeCount: probeSummaries.length, matchedRows },
      }],
      evidence: [{
        id: evidenceId,
        adapter: 'data',
        title: 'Parameter-bound anchor diagnostic evidence',
        summary: `Ran bounded read-only diagnostics across configured/code-derived tables and returned ${rows.length} redacted aggregate row(s).`,
        contentType: 'application/json',
        metadata: {
          topology: target.topology,
          probeSummaries,
          safeRows: rows,
          evidenceFacts: matchedProbeSummaries.flatMap((summary, summaryIndex) =>
            chainIds.map((chainId, chainIndex) => {
              const scopeKey = chainId.replace(/^persistence-contract:/, '')
              const column = scopeKey.split('.').pop() || scopeKey
              return {
                id: `${evidenceId}-record-state-${summaryIndex + 1}-${chainIndex + 1}`,
                type: 'record_state',
                subject: 'affected-scope:ticket-anchors',
                predicate: summary.relationship
                  ? `resolves through ${String((summary.relationship as Record<string, unknown>).rootTable || 'root')} and retains relational state before reaching`
                  : 'exists before reaching',
                object: `runtime-failure:${column}`,
                value: true,
                confidence: 0.9,
                evidenceRefs: [evidenceId],
                chainIds: [chainId],
                redactionState: 'metadata_only',
                sourceRef: `${String(summary.tableName)}.${String(summary.anchorColumn)}`,
              }
            }),
          ),
          traceSteps: traceSteps.map(step => ({
            title: step.title,
            detail: step.detail,
            safeSql: step.safeSql,
            rowCount: step.rowCount,
          })),
        },
      }],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: Math.max(1, probeSummaries.length + 1),
        rowsRead: rows.length,
        traceSteps,
      },
    }
  }

  private async resolveDbCredentialMaterial(target: InvestigationConnectionTarget): Promise<DbCredentialMaterial | null> {
    if (requireOperatorDbCredentials()) {
      return operatorDbCredentialMaterial(target)
    }

    if (!allowTargetSecretDbCredentials()) {
      throw new Error(
        'Target/shared DB credentials are disabled by default for Investigation Cockpit. '
        + 'Use INVESTIGATION_DB_USERNAME/INVESTIGATION_DB_PASSWORD or MERIDIAN_DB_USERNAME/MERIDIAN_DB_PASSWORD for the attended run; '
        + 'set INVESTIGATION_ALLOW_TARGET_SECRET_DB_CREDENTIALS=true only after separate approval.',
      )
    }

    const { password } = await this.secretResolver.resolve(target)
    if (!password) {
      return null
    }

    return {
      username: target.dbUser,
      password,
      database: target.databaseName || undefined,
      source: 'target_secret',
    }
  }

  private shouldUseApplicationCodeDerivedDiagnostic(target: InvestigationConnectionTarget): boolean {
    return this.isOperatorLdapTarget(target)
  }

  private async resolveCodeDerivedDiagnostic(
    request: InvestigationAdapterRequest,
  ): Promise<InvestigationQueryPack | null> {
    const profile = await this.codeSemanticProfileRegistry.resolveProfile(request)
    const profileDiagnostic = profile?.dataDiagnostics
      ?.find(diagnostic => diagnostic.environments.includes(request.scope.environment))
    if (profileDiagnostic) {
      return profileDiagnostic
    }
    return planCodeDerivedDiagnostic(request.scope)
  }

  private isOperatorLdapTarget(target: InvestigationConnectionTarget): boolean {
    const host = target.host.toLowerCase()
    const localHost = host === 'localhost' || host === '127.0.0.1' || host === '::1'
    const operatorCredentialMode = /^(1|true|yes)$/i.test(
      process.env.INVESTIGATION_REQUIRE_OPERATOR_DB_CREDENTIALS?.trim() || '',
    )
    const runtimePassword = [
      'env://INVESTIGATION_DB_PASSWORD',
      'env://INVESTIGATION_OPERATOR_SSH_PASSWORD',
      'env://INVESTIGATION_SSH_PASSWORD',
    ].includes(target.secretRef)

    return runtimePassword
      && (localHost || target.networkPath === 'ssh_public')
      && (operatorCredentialMode || target.networkPath === 'ssh_public')
  }

  private withRequestContext(
    pack: InvestigationQueryPack,
    request: InvestigationAdapterRequest,
  ): InvestigationQueryPack {
    if (
      !pack.sql.includes('__WINDOW_START__')
      && !pack.sql.includes('__WINDOW_END__')
      && !pack.sql.includes('__CASE_ID_LIST__')
    ) {
      return pack
    }

    const now = new Date()
    const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
    const windowStart = this.toMysqlDateTime(request.scope.timeWindow?.startTs ?? defaultStart.toISOString())
    const windowEnd = this.toMysqlDateTime(request.scope.timeWindow?.endTs ?? now.toISOString())
    const caseIdList = this.caseIdentifierSqlList(request)

    return {
      ...pack,
      sql: pack.sql
        .replaceAll('__WINDOW_START__', windowStart)
        .replaceAll('__WINDOW_END__', windowEnd)
        .replaceAll('__CASE_ID_LIST__', caseIdList),
    }
  }

  private caseIdentifiersForRequest(request: InvestigationAdapterRequest): string[] {
    if (request.scope.ticketContext?.fetchStatus !== 'fetched') {
      return []
    }

    const seen = new Set<string>()
    const values: string[] = []
    for (const identifier of request.scope.ticketContext.identifiers || []) {
      const value = identifier.value.trim()
      if (identifier.kind !== 'case_number' || !/^\d{5,20}$/.test(value) || seen.has(value)) {
        continue
      }
      seen.add(value)
      values.push(value)
      if (values.length >= 50) {
        break
      }
    }
    return values
  }

  private caseIdentifierSqlList(request: InvestigationAdapterRequest): string {
    const values = this.caseIdentifiersForRequest(request)
    if (values.length === 0) {
      return 'NULL'
    }
    return values.map(value => this.sqlStringLiteral(value)).join(', ')
  }

  private sqlStringLiteral(value: string): string {
    return `'${value.replaceAll("'", "''")}'`
  }

  private safeSqlForTrace(sql: string, request: InvestigationAdapterRequest): string {
    let safeSql = sql
    for (const value of this.sensitiveIdentifiersForRequest(request)) {
      safeSql = safeSql.replaceAll(this.sqlStringLiteral(value), "'[SENSITIVE_ID]'")
    }
    return safeSql
  }

  private sensitiveIdentifiersForRequest(request: InvestigationAdapterRequest): string[] {
    if (request.scope.ticketContext?.fetchStatus !== 'fetched') {
      return []
    }
    const values = new Set<string>()
    for (const identifier of request.scope.ticketContext.identifiers || []) {
      const value = identifier.value.trim()
      if (value && value !== '[REDACTED]') {
        values.add(value)
        if (identifier.kind === 'member_identifier' && /[-/]/.test(value)) {
          values.add(value.split(/[-/]/)[0] || value)
        }
      }
    }
    return Array.from(values).slice(0, 100)
  }

  private toMysqlDateTime(value: string): string {
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) {
      throw new Error(`Invalid investigation time window value: ${value}`)
    }

    return parsed.toISOString().slice(0, 19).replace('T', ' ')
  }

  private async executeViaSsmHost(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    sql: string,
    queryPackId: string,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): Promise<InvestigationAdapterResult> {
    const hostTarget = await this.hostTargetRegistry?.resolveTarget(
      request.scope.clientId,
      request.scope.environment,
      target.hostTargetId,
    )

    if (!hostTarget) {
      return {
        findings: [
          {
            id: `${request.runId}-data-host-missing`,
            adapter: 'data',
            type: 'database_access_failure',
            severity: 'high',
            confidence: 0.2,
            title: 'Approved host bridge is not available for database diagnostics',
            summary: `Host target ${target.hostTargetId} could not be resolved for ${target.id}.`,
            evidenceRefs: [],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
        ],
        evidence: [],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 0,
          rowsRead: 0,
          traceSteps,
        },
      }
    }

    const sqlBase64 = Buffer.from(sql, 'utf8').toString('base64')
    const timeoutMs = boundedTimeoutMs(request.constraints.timeoutMs)
    const mysqlCommand = [
      `source ${target.hostAuthFile}`,
      `SQL=$(printf '%s' '${sqlBase64}' | base64 -d)`,
      `mysql -h ${target.host} -u"$DB_USER" -p"$DB_PASSWORD" --batch --raw -e "$SQL"`,
    ].join(' && ')

    const args = [
      ...(hostTarget.awsProfile ? ['--profile', hostTarget.awsProfile] : []),
      'ssm',
      'send-command',
      '--region',
      hostTarget.region,
      '--instance-ids',
      hostTarget.instanceId,
      '--document-name',
      'AWS-RunShellScript',
      '--comment',
      `investigation cockpit data query ${queryPackId}`,
      '--parameters',
      JSON.stringify({ commands: [mysqlCommand] }),
      '--query',
      'Command.CommandId',
      '--output',
      'text',
    ]

    traceSteps.push({
      id: `${request.runId}-data-open`,
      adapter: 'data',
      phase: 'open_connection',
      title: 'Dispatch bounded DB query through SSM',
      detail: `Sent ${queryPackId} to ${hostTarget.instanceId} for execution against ${target.host}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId,
      connectionTargetId: target.id,
      safeSql: this.safeSqlForTrace(sql, request),
    })

    const { stdout } = await execFileAsync('aws', args, {
      maxBuffer: 1024 * 1024 * 4,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    })
    const commandId = stdout.trim()
    const invocation = await this.waitForSsmCommand(
      commandId,
      hostTarget.region,
      hostTarget.instanceId,
      hostTarget.awsProfile,
      timeoutMs,
    )

    if (invocation.status !== 'Success') {
      throw new Error(invocation.stderr || invocation.stdout || `SSM execution failed with status ${invocation.status}`)
    }

    const rows = this.parseMysqlBatchOutput(invocation.stdout)
    const redactedRows = this.phiGuard.redactRows(rows)

    traceSteps.push({
      id: `${request.runId}-data-exec`,
      adapter: 'data',
      phase: 'execute_query',
      title: 'Execute approved data diagnostic',
      detail: `Executed ${queryPackId} on ${target.topology} through ${hostTarget.instanceId}.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId,
      connectionTargetId: target.id,
      safeSql: this.safeSqlForTrace(sql, request),
      rowCount: redactedRows.length,
    })

    traceSteps.push({
      id: `${request.runId}-data-redact`,
      adapter: 'data',
      phase: 'redact_results',
      title: 'Redact diagnostic output',
      detail: `Applied PHI redaction rules to ${redactedRows.length} rows.`,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      queryPackId,
      connectionTargetId: target.id,
      rowCount: redactedRows.length,
    })

    return this.buildSuccessResult(request, target, queryPackId, redactedRows, traceSteps, startedAt)
  }

  private async waitForSsmCommand(
    commandId: string,
    region: string,
    instanceId: string,
    profile?: string,
    timeoutMs = DEFAULT_DATA_DIAGNOSTIC_TIMEOUT_MS,
  ): Promise<{ status: string; stdout: string; stderr: string }> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const args = [
        ...(profile ? ['--profile', profile] : []),
        'ssm',
        'get-command-invocation',
        '--region',
        region,
        '--command-id',
        commandId,
        '--instance-id',
        instanceId,
        '--output',
        'json',
      ]
      const { stdout } = await execFileAsync('aws', args, {
        maxBuffer: 1024 * 1024 * 4,
        timeout: boundedTimeoutMs(timeoutMs),
        killSignal: 'SIGTERM',
      })
      const payload = JSON.parse(stdout) as {
        Status?: string
        StandardOutputContent?: string
        StandardErrorContent?: string
      }
      const status = payload.Status || 'Unknown'
      if (!['Pending', 'InProgress', 'Delayed'].includes(status)) {
        return {
          status,
          stdout: payload.StandardOutputContent || '',
          stderr: payload.StandardErrorContent || '',
        }
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return {
      status: 'TimedOut',
      stdout: '',
      stderr: 'Timed out waiting for SSM command completion.',
    }
  }

  private parseMysqlBatchOutput(output: string): Array<Record<string, unknown>> {
    const lines = output
      .split('\n')
      .map(line => line.trimEnd())
      .filter(Boolean)

    if (lines.length === 0) {
      return []
    }

    const headers = lines[0].split('\t')
    return lines.slice(1).map(line => {
      const values = line.split('\t')
      return headers.reduce<Record<string, unknown>>((row, header, index) => {
        row[header] = values[index] ?? null
        return row
      }, {})
    })
  }

  private buildSuccessResult(
    request: InvestigationAdapterRequest,
    target: InvestigationConnectionTarget,
    queryPackId: string,
    redactedRows: Array<Record<string, unknown>>,
    traceSteps: InvestigationAdapterTraceStep[],
    startedAt: number,
  ): InvestigationAdapterResult {
    const topologyLabel = target.topology === 'rds_mysql' ? 'RDS' : 'host-backed'
    const isCodeDerivedDiagnostic = queryPackId.startsWith('appcode_')
    const diagnosticSummary = this.summarizeDiagnosticRows(redactedRows)
    const diagnosticKind = isCodeDerivedDiagnostic ? 'code-derived DB diagnostic' : 'metadata path'
    const diagnosticTitle = isCodeDerivedDiagnostic
      ? `${topologyLabel} code-derived DB diagnostic completed`
      : `${topologyLabel} metadata path is available for bounded diagnostics`

    return {
      findings: [
        {
          id: `${request.runId}-data-success`,
          adapter: 'data',
          type: isCodeDerivedDiagnostic ? 'database_code_derived_diagnostic_ready' : 'database_metadata_ready',
          severity: 'medium',
          confidence: 0.78,
          title: diagnosticTitle,
          summary: diagnosticSummary
            ? `Executed ${queryPackId} against ${target.id}. Result highlights: ${diagnosticSummary}.`
            : `Executed ${queryPackId} against ${target.id} and returned ${redactedRows.length} redacted row(s).`,
          evidenceRefs: [`${request.runId}-data-evidence`],
          requiresCodeChange: false,
          requiresDataChange: false,
        },
      ],
      evidence: [
        {
          id: `${request.runId}-data-evidence`,
          adapter: 'data',
          title: `${topologyLabel} ${diagnosticKind}`,
          summary: `Executed ${queryPackId} on ${target.topology} target ${target.id} and returned ${redactedRows.length} redacted rows.`,
          contentType: 'application/json',
          metadata: {
            topology: target.topology,
            queryPackId,
            safeRows: redactedRows,
            traceSteps: traceSteps.map(step => ({
              title: step.title,
              detail: step.detail,
              safeSql: step.safeSql,
              rowCount: step.rowCount,
            })),
          },
        },
      ],
      telemetry: {
        durationMs: Date.now() - startedAt,
        requestsIssued: 1,
        rowsRead: redactedRows.length,
        traceSteps,
      },
    }
  }

  private summarizeDiagnosticRows(rows: Array<Record<string, unknown>>): string {
    const formatted = rows
      .slice(0, 4)
      .map(row => {
        const sourceName = this.readRowValue(row, 'source_name')
        if (sourceName) {
          const scopeKey = this.readRowValue(row, 'scope_key')
          if (sourceName === 'schema_width') {
            const observedLength = this.readRowValue(row, 'observed_length')
            const maxLength = this.readRowValue(row, 'max_length')
            const dataType = this.readRowValue(row, 'data_type')
            const nullable = this.readRowValue(row, 'is_nullable')
            const properties = [
              observedLength ? `observed_length=${observedLength}` : null,
              maxLength ? `max_length=${maxLength}` : null,
              dataType ? `type=${dataType}` : null,
              nullable ? `nullable=${nullable}` : null,
            ].filter((entry): entry is string => Boolean(entry))
            return `${sourceName}${scopeKey ? `/${scopeKey}` : ''}${properties.length ? ` (${properties.join(', ')})` : ''}`
          }
          const totalRows = this.readRowValue(row, 'total_rows')
          const enabledRows = this.readRowValue(row, 'enabled_rows')
          const disabledRows = this.readRowValue(row, 'disabled_or_null_rows')
          const latestUpdate = this.readRowValue(row, 'latest_update_at')
          const metrics = [
            totalRows ? `total=${totalRows}` : null,
            enabledRows ? `enabled=${enabledRows}` : null,
            disabledRows ? `disabled_or_null=${disabledRows}` : null,
            latestUpdate ? `latest=${latestUpdate}` : null,
          ].filter((entry): entry is string => Boolean(entry))
          return `${sourceName}${scopeKey ? `/${scopeKey}` : ''}${metrics.length ? ` (${metrics.join(', ')})` : ''}`
        }

        const schema = this.readRowValue(row, 'table_schema')
        if (schema) {
          const tableCount = this.readRowValue(row, 'table_count') ?? this.readRowValue(row, 'table_name') ?? 'metadata'
          return `${schema} (${tableCount})`
        }

        return null
      })
      .filter((entry): entry is string => Boolean(entry))

    return formatted.join('; ')
  }

  private readRowValue(row: Record<string, unknown>, key: string): string | null {
    const value = row[key]
    if (value === null || value === undefined) {
      return null
    }
    const text = String(value).trim()
    return text ? text : null
  }
}
