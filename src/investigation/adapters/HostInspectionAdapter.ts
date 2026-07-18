import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HostInspectionAdapter } from './types.js'
import type { InvestigationAdapterRequest, InvestigationAdapterResult } from '../types/investigation.js'
import type { InvestigationHostTarget, InvestigationHostTargetRegistry } from '../data/HostTargetRegistry.js'
import {
  extractInvestigationSignals,
  extractPersistenceFailureColumns,
  redactInvestigationText,
} from '../utils/RuntimeEvidence.js'

const execFileAsync = promisify(execFile)

interface CliCommandRunner {
  runJson<T>(args: string[], timeoutMs?: number): Promise<T>
  runText(args: string[], timeoutMs?: number): Promise<string>
}

interface SshCommandRunner {
  runRemoteText(command: string, timeoutMs?: number): Promise<string>
}

class AwsCliRunner implements CliCommandRunner {
  constructor(private readonly profile?: string) {}

  async runJson<T>(args: string[], timeoutMs = DEFAULT_HOST_CLI_TIMEOUT_MS): Promise<T> {
    const baseArgs = this.profile ? ['--profile', this.profile] : []
    const { stdout } = await execFileAsync('aws', [...baseArgs, ...args], {
      maxBuffer: 1024 * 1024 * 4,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    })
    return JSON.parse(stdout) as T
  }

  async runText(args: string[], timeoutMs = DEFAULT_HOST_CLI_TIMEOUT_MS): Promise<string> {
    const baseArgs = this.profile ? ['--profile', this.profile] : []
    const { stdout } = await execFileAsync('aws', [...baseArgs, ...args], {
      maxBuffer: 1024 * 1024 * 4,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    })
    return stdout
  }
}

class SshCliRunner implements SshCommandRunner {
  constructor(private readonly target: InvestigationHostTarget) {}

  async runRemoteText(command: string, timeoutMs = DEFAULT_HOST_CLI_TIMEOUT_MS): Promise<string> {
    const publicHost = this.target.publicHost?.trim()
    const sshUser = this.target.sshUser?.trim() || process.env.INVESTIGATION_OPERATOR_SSH_USER?.trim()
    if (!publicHost || !sshUser) {
      throw new Error('Operator LDAP SSH target requires publicHost and sshUser; credentials are not accepted by Cockpit.')
    }

    const args = [
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'StrictHostKeyChecking=accept-new',
    ]
    if (this.target.sshControlPath?.trim()) {
      args.push('-S', this.target.sshControlPath.trim())
    }
    args.push('-p', String(this.target.sshPort || 22))
    args.push(`${sshUser}@${publicHost}`, command)

    const { stdout } = await execFileAsync('ssh', args, {
      maxBuffer: 1024 * 1024 * 4,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    })
    return stdout
  }
}

interface SsmDescribeInstanceInformationResponse {
  InstanceInformationList?: Array<{
    InstanceId?: string
    PingStatus?: string
    PlatformName?: string
    PlatformVersion?: string
    AgentVersion?: string
    LastPingDateTime?: string
    IPAddress?: string
    ComputerName?: string
  }>
}

interface SsmCommandInvocationResponse {
  Status?: string
  StandardOutputContent?: string
  StandardErrorContent?: string
}

const DEFAULT_CONFIG_PROBE_MAX_MATCHES = 25
const DEFAULT_BATCH_PROBE_MAX_MATCHES = 25
const DEFAULT_RUNTIME_LOG_MAX_MATCHES = 40
const DEFAULT_HOST_CLI_TIMEOUT_MS = 15_000
const DEFAULT_BATCH_PROBE_PATHS = [
  '/opt/software/medhok/batch',
  '/opt/software/medhok/jobs',
  '/opt/software/medhok',
]
const DEFAULT_RUNTIME_LOG_PATHS = [
  '/opt/software/medhok',
  '/opt/apps',
  '/opt/ws-apps',
  '/opt/ws9443-apps',
  '/usr/local/tomcat/logs',
  '/medhok/logs',
  '/var/log',
]

function commandTimeoutMs(request: InvestigationAdapterRequest): number {
  const configured = Number(request.constraints.timeoutMs)
  if (!Number.isFinite(configured) || configured <= 0) {
    return DEFAULT_HOST_CLI_TIMEOUT_MS
  }
  // Leave budget for target resolution, posture and result materialization.
  return Math.max(1_000, Math.min(Math.floor(configured / 2), 25_000))
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function escapeExtendedRegex(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')
}

function resolveConfigProbeTerms(request: InvestigationAdapterRequest): string[] {
  const terms = new Set<string>()
  const source = [
    ...(request.scope.keywords || []),
    ...(request.scope.planningContext?.searchHints || []),
    ...(request.scope.serviceIds || []),
    request.jiraKey,
  ].join('\n')

  for (const signal of extractInvestigationSignals(source, 40)) {
    if (
      /\.(?:url|uri|endpoint|host|path|enabled|allowed|timeout|baseUrl|serviceUrl|server|port)$/i.test(signal)
      || /(?:Exception|Error)$/.test(signal)
      || /(?:Controller|Service|Processor|Batch|Job|Scheduler|Task|Command|Handler|Repository|Dao|DAO|Client|Utility|Util)$/i.test(signal)
      || /\.(?:jar|war|ear|sh|ksh|bat|cmd|properties|xml|yml|yaml|log)$/i.test(signal)
      || /\b(?:skybot|autosys|cron|batch|job)\b/i.test(signal)
      || /\b(?:ttl|timeout|session|retry|pageSize|concurrency|handler|alias|dlq|dataset|parameter|render)\b/i.test(signal)
      || /^\/[A-Za-z0-9._~:/?#@!$&()*+,;=%-]{4,120}$/.test(signal)
    ) {
      terms.add(signal)
    }
  }

  return Array.from(terms).slice(0, 12)
}

function parseConfigProbeOutput(output: string, maxMatches: number): Array<{
  file: string
  line?: number
  preview: string
  signals: string[]
}> {
  return output
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, maxMatches)
    .map(line => {
      const redacted = redactInvestigationText(line).slice(0, 600)
      const [file = 'unknown', maybeLine = '', ...rest] = redacted.split(':')
      const lineNumber = Number.parseInt(maybeLine, 10)
      return {
        file,
        line: Number.isFinite(lineNumber) ? lineNumber : undefined,
        preview: rest.length ? rest.join(':').trim() : redacted,
        signals: extractInvestigationSignals(redacted),
      }
    })
}

function buildConfigProbeCommand(paths: string[], terms: string[], maxMatches: number): string {
  const regex = terms.map(escapeExtendedRegex).join('|')
  const pathList = paths.map(shellSingleQuote).join(' ')
  return [
    'set +e',
    `PATTERN=${shellSingleQuote(regex)}`,
    `MAX_MATCHES=${Math.max(1, Math.min(maxMatches, 100))}`,
    `for probe_path in ${pathList}; do`,
    '  [ -e "$probe_path" ] || continue',
    '  find "$probe_path" -maxdepth 5 -type f \\( -name "*.properties" -o -name "*.yml" -o -name "*.yaml" -o -name "*.xml" -o -name "*.conf" -o -name "*.ini" \\) -print0 2>/dev/null | xargs -0 grep -HInE "$PATTERN" 2>/dev/null',
    'done | head -n "$MAX_MATCHES"',
  ].join('\n')
}

function runtimeLogProbeEnabled(request: InvestigationAdapterRequest): boolean {
  if (!envFlagEnabled('INVESTIGATION_RUNTIME_LOGS_ENABLED', true)) return false
  const text = [
    ...(request.scope.serviceIds || []),
    ...(request.scope.keywords || []),
    request.scope.ticketContext?.title,
    request.scope.ticketContext?.description,
  ].filter(Boolean).join('\n')
  return (request.scope.serviceIds?.length || 0) > 0
    || /\b(?:error|exception|failed|failure|timeout|runtime|api|service|member|search|save|persist|database|sql|truncat|overflow)\b/i.test(text)
}

function resolveRuntimeLogProbeTerms(request: InvestigationAdapterRequest): string[] {
  const terms = new Set([
    'data too long for column',
    'value too long',
    'string data right truncation',
    'DataTruncation',
    'SQLDataException',
    'SQLException',
    'timed out',
    'timeout',
    'HTTP 500',
    'HTTP 504',
    'exception',
    'failed',
  ])
  const source = [
    ...(request.scope.serviceIds || []),
    ...(request.scope.keywords || []),
    ...(request.scope.planningContext?.searchHints || []),
    ...(request.scope.diagnosticContext?.codeEvidenceTerms || []),
    ...(request.scope.diagnosticContext?.runtimeEvidenceTerms || []),
  ].join('\n')
  for (const signal of extractInvestigationSignals(source, 24)) {
    if (
      signal.length >= 4
      && signal.length <= 120
      && /(?:error|exception|fail|timeout|truncat|too long|http.?[45]\d\d|unavailable|refused|reset|deadlock)/i.test(signal)
    ) terms.add(signal)
  }
  return Array.from(terms).slice(0, 16)
}

function resolveRuntimeCorrelationAnchors(request: InvestigationAdapterRequest): string[] {
  return Array.from(new Set([
    ...(request.scope.ticketContext?.identifiers || []).map(identifier => identifier.value),
    ...(request.scope.evidenceAnchors || []).map(anchor => anchor.value),
    ...(request.scope.ticketContext?.evidenceAnchors || []).map(anchor => anchor.value),
  ].map(value => value.trim()).filter(value => value.length >= 4 && value.length <= 160))).slice(0, 12)
}

function buildRuntimeLogProbeCommand(
  paths: string[],
  terms: string[],
  maxMatches: number,
  request: InvestigationAdapterRequest,
): string {
  const regex = terms.map(escapeExtendedRegex).join('|')
  const correlationAnchors = resolveRuntimeCorrelationAnchors(request)
  const anchorRegex = correlationAnchors.map(escapeExtendedRegex).join('|')
  const pathList = paths.map(shellSingleQuote).join(' ')
  const endTs = remoteFindTimestamp(request.scope.timeWindow?.endTs || new Date().toISOString())
  const startTs = remoteFindTimestamp(
    request.scope.timeWindow?.startTs || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
  )
  return [
    'set +e',
    `PATTERN=${shellSingleQuote(regex)}`,
    `SPECIFIC_PATTERN=${shellSingleQuote('data too long for column|value too long|string data right truncation|DataTruncation|SQLDataException')}`,
    `ANCHOR_PATTERN=${shellSingleQuote(anchorRegex)}`,
    `START_TS=${shellSingleQuote(startTs)}`,
    `END_TS=${shellSingleQuote(endTs)}`,
    `MAX_MATCHES=${Math.max(1, Math.min(maxMatches, 100))}`,
    'TMP_ALL_FILES=$(mktemp)',
    'TMP_FILES=$(mktemp)',
    'TMP_PLAIN_FILES=$(mktemp)',
    'TMP_SPECIFIC=$(mktemp)',
    'TMP_GENERIC=$(mktemp)',
    'trap \'rm -f "$TMP_ALL_FILES" "$TMP_FILES" "$TMP_PLAIN_FILES" "$TMP_SPECIFIC" "$TMP_GENERIC"\' EXIT',
    `for probe_path in ${pathList}; do`,
    '  [ -d "$probe_path" ] || continue',
    // File mtimes are only a discovery hint. Active logs are commonly modified
    // after the incident window while still containing the relevant entries.
    '  find "$probe_path" -maxdepth 7 -type f \\( -name "*.log" -o -name "*.log.*" -o -name "*.out" -o -name "*.txt" -o -name "*.gz" -o -name "*.zip" \\) -newermt "$START_TS" -printf "%T@ %p\\n" 2>/dev/null',
    'done | sort -rn | cut -d" " -f2- > "$TMP_ALL_FILES"',
    '{ grep -Ev \'\.(gz|zip)$\' "$TMP_ALL_FILES" | grep -Ei \'/(medhok|catalina|localhost|application|server)[^/]*\.(log|out|txt)\' | head -n 40; grep -Ev \'\.(gz|zip)$\' "$TMP_ALL_FILES" | head -n 100; } | awk \'!seen[$0]++\' | head -n 100 > "$TMP_PLAIN_FILES"',
    '{ head -n 10 "$TMP_PLAIN_FILES"; { grep -E \'\.(gz|zip)$\' "$TMP_ALL_FILES" | grep -Ei \'/(medhok|catalina|localhost|application|server)\'; grep -E \'\.(gz|zip)$\' "$TMP_ALL_FILES"; } | awk \'!seen[$0]++\' | head -n 10; } > "$TMP_FILES"',
    'timeout 30s xargs -r grep -HInE -m 12 "$SPECIFIC_PATTERN" < "$TMP_PLAIN_FILES" 2>/dev/null | head -n 24 > "$TMP_SPECIFIC"',
    'while IFS= read -r FILE; do',
    '  [ -f "$FILE" ] || continue',
    '  CONTEXT=',
    '  GLOBAL_SPECIFIC=',
    '  SPECIFIC_MATCHES=',
    '  GENERIC_MATCHES=',
    '  if [ -n "$ANCHOR_PATTERN" ]; then',
    '    case "$FILE" in',
    '      *.gz) CONTEXT=$(timeout 8s gzip -cd "$FILE" 2>/dev/null | grep -Ein -C 600 -m 8 "$ANCHOR_PATTERN" 2>/dev/null) ;;',
    '      *.zip) CONTEXT=$(timeout 8s unzip -p "$FILE" 2>/dev/null | grep -Ein -C 600 -m 8 "$ANCHOR_PATTERN" 2>/dev/null) ;;',
    '      *) CONTEXT=$(timeout 8s grep -Ein -C 600 -m 8 "$ANCHOR_PATTERN" "$FILE" 2>/dev/null) ;;',
    '    esac',
    '    case "$FILE" in',
    '      *.gz) GLOBAL_SPECIFIC=$(timeout 5s gzip -cd "$FILE" 2>/dev/null | grep -Ein -m 12 "$SPECIFIC_PATTERN" 2>/dev/null) ;;',
    '      *.zip) GLOBAL_SPECIFIC=$(timeout 5s unzip -p "$FILE" 2>/dev/null | grep -Ein -m 12 "$SPECIFIC_PATTERN" 2>/dev/null) ;;',
    '      *) GLOBAL_SPECIFIC= ;;',
    '    esac',
    '    SPECIFIC_MATCHES=$({ printf "%s\n" "$GLOBAL_SPECIFIC"; printf "%s\n" "$CONTEXT" | grep -Ein -m 12 "$SPECIFIC_PATTERN" 2>/dev/null; } | awk \'NF && !seen[$0]++\' | head -n 24)',
    '    GENERIC_MATCHES=$(printf "%s\n" "$CONTEXT" | grep -Ein -m 12 "$PATTERN" 2>/dev/null)',
    '  else',
    '    case "$FILE" in',
    '      *.gz) GENERIC_MATCHES=$(timeout 3s zgrep -Ein -m 12 "$PATTERN" "$FILE" 2>/dev/null) ;;',
    '      *.zip) GENERIC_MATCHES=$(timeout 3s unzip -p "$FILE" 2>/dev/null | grep -Ein -m 12 "$PATTERN" 2>/dev/null) ;;',
    '      *) GENERIC_MATCHES=$(timeout 3s grep -Ein -m 12 "$PATTERN" "$FILE" 2>/dev/null) ;;',
    '    esac',
    '    SPECIFIC_MATCHES=$(printf "%s\n" "$GENERIC_MATCHES" | grep -Ein -m 12 "$SPECIFIC_PATTERN" 2>/dev/null)',
    '  fi',
    '  [ -n "$SPECIFIC_MATCHES" ] && printf "###FILE:%s\\n%s\\n" "$FILE" "$SPECIFIC_MATCHES" >> "$TMP_SPECIFIC"',
    '  [ -n "$GENERIC_MATCHES" ] && printf "###FILE:%s\\n%s\\n" "$FILE" "$GENERIC_MATCHES" >> "$TMP_GENERIC"',
    'done < "$TMP_FILES"',
    '{ cat "$TMP_SPECIFIC"; cat "$TMP_GENERIC"; } | head -n "$MAX_MATCHES"',
  ].join('\n')
}

function remoteFindTimestamp(value: string): string {
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC')
}

function redactKnownTicketIdentifiers(value: string, request: InvestigationAdapterRequest): string {
  let output = value
  for (const identifier of request.scope.ticketContext?.identifiers || []) {
    if (!identifier.sensitive || !identifier.value) continue
    output = output.replaceAll(identifier.value, '[REDACTED_PHI]')
  }
  return redactInvestigationText(output)
}

function parseRuntimeLogProbeOutput(
  output: string,
  request: InvestigationAdapterRequest,
  maxMatches: number,
): Array<{ file: string; preview: string; signals: string[]; failureColumns: string[] }> {
  const matches: Array<{ file: string; preview: string; signals: string[]; failureColumns: string[] }> = []
  let currentFile = 'unknown'
  for (const rawLine of output.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    if (line.startsWith('###FILE:')) {
      currentFile = redactKnownTicketIdentifiers(line.slice('###FILE:'.length), request).slice(0, 300)
      continue
    }
    const preview = redactKnownTicketIdentifiers(line, request).slice(0, 600)
    matches.push({
      file: currentFile,
      preview,
      signals: extractInvestigationSignals(preview, 16),
      failureColumns: extractPersistenceFailureColumns(preview, 16),
    })
    if (matches.length >= maxMatches) break
  }
  return matches
}

function envFlagEnabled(name: string, fallback: boolean): boolean {
  const value = process.env[name]?.trim()
  if (!value) {
    return fallback
  }
  return /^(1|true|yes)$/i.test(value)
}

function normalizeEvidenceHostCandidate(value: string): string | undefined {
  const candidate = value
    .trim()
    .replace(/^ssh:\/\/|^host[=:]/i, '')
    .replace(/^[A-Za-z0-9_.-]+@/, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9.-]+$/g, '')
    .toLowerCase()

  if (
    candidate.length < 4
    || candidate.length > 253
    || candidate.includes('..')
    || !/^[a-z0-9.-]+$/.test(candidate)
    || (!candidate.includes('.') && !envFlagEnabled('INVESTIGATION_ALLOW_SHORT_SSH_HOSTS', false))
    || /(?:^|[-.])(?:db|database|mysql|rds|aurora|replica|slave)(?:[-.]|$)/i.test(candidate)
    || /(?:^|[-.])(?:archive|s3|cloudwatch|log|logs|source|metadata|prefix|bucket)(?:[-.]|$)/i.test(candidate)
    || /(?:^|[-.])(?:branch|code|git|github|java|monorepo|repo|repository|refs?|src|worktree)(?:[-.]|$)/i.test(candidate)
    || !/(?:^|[-.])(?:batch\d*|job\d*|skybot|runtime|app\d*|web\d*|host|server|node|instance)(?:[-.]|$)/i.test(candidate)
  ) {
    return undefined
  }

  return candidate
}

function evidenceDerivedPublicHost(request: InvestigationAdapterRequest): string | undefined {
  if (!envFlagEnabled('INVESTIGATION_EVIDENCE_DERIVED_SSH_HOSTS', true)) {
    return undefined
  }

  const text = [
    ...(request.scope.keywords || []),
    ...(request.scope.serviceIds || []),
    request.jiraKey,
  ].filter(Boolean).join('\n')
  const candidates = [
    ...Array.from(text.matchAll(/\b[A-Za-z0-9][A-Za-z0-9.-]{2,252}\b/g)).map(match => match[0]),
  ]

  return candidates
    .map(normalizeEvidenceHostCandidate)
    .find((candidate): candidate is string => Boolean(candidate))
}

function withEvidenceDerivedSshTarget(
  target: InvestigationHostTarget,
  request: InvestigationAdapterRequest,
): InvestigationHostTarget {
  if (target.publicHost || target.networkPath !== 'ssh_public') {
    return target
  }

  const publicHost = evidenceDerivedPublicHost(request)
  if (!publicHost) {
    return target
  }

  return {
    ...target,
    publicHost,
    sshAllowed: true,
    sshAuthMode: target.sshAuthMode || 'operator_ldap',
    notes: [
      target.notes,
      'SSH public host was derived from bounded runtime evidence for batch/app inspection.',
    ].filter(Boolean).join(' '),
  }
}

function batchProbeEnabled(request: InvestigationAdapterRequest): boolean {
  const text = [
    request.jiraKey,
    ...(request.scope.serviceIds || []),
    ...(request.scope.keywords || []),
    request.scope.ticketContext?.title,
    ...(request.scope.ticketContext?.extractedTerms || []),
  ].filter(Boolean).join('\n')

  return /\b(?:batch|job|skybot|autosys|cron|scheduler|command|\.sh|\.ksh|\.jar|log path)\b/i.test(text)
}

function safeBatchSearchTerm(value: string): string | undefined {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, '')
  if (
    trimmed.length < 4
    || trimmed.length > 120
    || /(?:password|passwd|secret|token|credential|member|subscriber|patient|person|dob|ssn)/i.test(trimmed)
  ) {
    return undefined
  }

  if (
    /[/.](?:jar|sh|ksh|properties|xml|yml|yaml|conf|log)$/i.test(trimmed)
    || /\b(?:batch|job|skybot|autosys|cron|scheduler|command|utility|template|letter|medpharm)\b/i.test(trimmed)
    || /(?:Batch|Job|Scheduler|Command|Utility|Template|Letter)$/i.test(trimmed)
  ) {
    return trimmed
  }

  return undefined
}

function basenameSearchTerm(value: string): string | undefined {
  const basename = value.split(/[\\/]/).filter(Boolean).pop()?.replace(/\.(?:jar|sh|ksh|properties|xml|yml|yaml|conf|log)$/i, '')
  return basename ? safeBatchSearchTerm(basename) : undefined
}

function resolveBatchProbeTerms(request: InvestigationAdapterRequest): string[] {
  if (!batchProbeEnabled(request)) {
    return []
  }

  const terms = new Set<string>()
  for (const token of (request.scope.ticketContext?.title || '').split(/[^A-Za-z0-9]+/).filter(Boolean)) {
    if (token.length >= 3 && !/^(?:api|prod|production|service|batch|job|failure|failed|error|intake)$/i.test(token)) {
      terms.add(token)
    }
  }
  const sourceTerms = [
    ...(request.scope.keywords || []),
    ...(request.scope.serviceIds || []),
    request.scope.ticketContext?.title,
    ...(request.scope.ticketContext?.extractedTerms || []),
  ].filter((entry): entry is string => Boolean(entry?.trim()))

  for (const source of sourceTerms) {
    const direct = safeBatchSearchTerm(source)
    if (direct) {
      terms.add(direct)
    }
    const basename = basenameSearchTerm(source)
    if (basename) {
      terms.add(basename)
    }
    for (const signal of extractInvestigationSignals(source, 8)) {
      const safeSignal = safeBatchSearchTerm(signal)
      if (safeSignal) {
        terms.add(safeSignal)
      }
      const safeBasename = basenameSearchTerm(signal)
      if (safeBasename) {
        terms.add(safeBasename)
      }
    }
    for (const token of source.split(/[^A-Za-z0-9]+/).map(value => value.trim()).filter(Boolean)) {
      if (token.length >= 3 && !/^(?:api|prod|production|service|batch|job|failure|failed|error|intake)$/i.test(token)) {
        terms.add(token)
      }
    }
  }

  return Array.from(terms)
    .filter(term => !/^(?:batch|job|jobs|skybot|command|scheduler)$/i.test(term))
    .slice(0, 12)
}

function buildBatchScriptProbeCommand(paths: string[], terms: string[], maxMatches: number): string {
  const regex = terms.map(escapeExtendedRegex).join('|')
  const pathList = paths.map(shellSingleQuote).join(' ')
  return [
    'set +e',
    `PATTERN=${shellSingleQuote(regex)}`,
    `MAX_MATCHES=${Math.max(1, Math.min(maxMatches, 100))}`,
    `for probe_path in ${pathList}; do`,
    '  [ -e "$probe_path" ] || continue',
    '  find "$probe_path" -maxdepth 3 \\( -type f -o -type l \\) -name "*.jar" ! -path "*/lib/*" ! -path "*/*backup*/*" ! -path "*/*rollback*/*" -print 2>/dev/null | while IFS= read -r artifact; do target=$(readlink "$artifact" 2>/dev/null || true); printf "%s%s%s\\n" "$artifact" "${target:+ -> }" "$target"; done | grep -iE "$PATTERN"',
    '  find "$probe_path" -maxdepth 6 -type f \\( -name "*.sh" -o -name "*.ksh" -o -name "*.properties" -o -name "*.xml" -o -name "*.yml" -o -name "*.yaml" -o -name "*.conf" -o -name "*.ini" \\) -print0 2>/dev/null | xargs -0 grep -HInE "$PATTERN" 2>/dev/null',
    'done | head -n "$MAX_MATCHES"',
  ].join('\n')
}

function mergeHostInspectionResults(results: InvestigationAdapterResult[]): InvestigationAdapterResult {
  return {
    findings: results.flatMap(result => result.findings),
    evidence: results.flatMap(result => result.evidence),
    telemetry: {
      durationMs: Math.max(0, ...results.map(result => result.telemetry.durationMs)),
      requestsIssued: results.reduce((total, result) => total + result.telemetry.requestsIssued, 0),
      rowsRead: results.reduce((total, result) => total + (result.telemetry.rowsRead || 0), 0),
      artifactsStored: results.reduce((total, result) => total + (result.telemetry.artifactsStored || 0), 0),
      traceSteps: results.flatMap(result => result.telemetry.traceSteps || []),
    },
  }
}

function runtimeTargetRunId(runId: string, target: InvestigationHostTarget): string {
  const suffix = target.id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)
  return `${runId}-runtime-${suffix || 'host'}`
}

export class NoopHostInspectionAdapter implements HostInspectionAdapter {
  readonly kind = 'host' as const

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

export class CliHostInspectionAdapter implements HostInspectionAdapter {
  readonly kind = 'host' as const

  constructor(
    private readonly hostRegistry: InvestigationHostTargetRegistry,
    private readonly runnerFactory: (target: InvestigationHostTarget) => CliCommandRunner = target => new AwsCliRunner(target.awsProfile),
    private readonly sshRunnerFactory: (target: InvestigationHostTarget) => SshCommandRunner = target => new SshCliRunner(target),
  ) {}

  async execute(request: InvestigationAdapterRequest): Promise<InvestigationAdapterResult> {
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
            id: `${request.runId}-host-not-allowed`,
            adapter: 'host',
            type: 'host_scope_denied',
            severity: 'high',
            confidence: 0.25,
            title: 'Host inspection is not approved for this scope',
            summary: `No host target was registered for ${request.scope.clientId} ${request.scope.environment}.`,
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

    const effectiveTarget = withEvidenceDerivedSshTarget(target, request)

    if (effectiveTarget.networkPath === 'ssh_public') {
      const runtimeTargets = await this.hostRegistry.resolveRuntimeTargets?.(
        request.scope.clientId,
        request.scope.environment,
        effectiveTarget.envId,
      ).catch(() => []) || []
      const additionalTargets = runtimeTargets
        .filter(runtimeTarget => runtimeTarget.enabled && runtimeTarget.networkPath === 'ssh_public')
        .filter(runtimeTarget => runtimeTarget.id !== effectiveTarget.id && runtimeTarget.instanceId !== effectiveTarget.instanceId)
        .slice(0, 8)
      const primaryLooksLikeDatabase = /(?:database|(?:^|[^a-z])db(?:[^a-z]*(?:slave|replica|server))?(?:[^a-z]|$)|dbsl)/i.test(
        `${effectiveTarget.id} ${effectiveTarget.instanceName}`,
      )
      const selectedTargets = primaryLooksLikeDatabase && additionalTargets.length > 0
        ? additionalTargets
        : [effectiveTarget, ...additionalTargets]
      const runtimeResults = await Promise.all(selectedTargets.map(runtimeTarget => this.executeViaSsh(
        runtimeTarget.id === effectiveTarget.id
          ? request
          : { ...request, runId: runtimeTargetRunId(request.runId, runtimeTarget) },
        runtimeTarget,
        startedAt,
      ).then(result => {
        request.onPartialResult?.(result)
        return result
      })))
      return mergeHostInspectionResults(runtimeResults)
    }

    if (!effectiveTarget.ssmAllowed) {
      return {
        findings: [
          {
            id: `${request.runId}-host-not-allowed`,
            adapter: 'host',
            type: 'host_scope_denied',
            severity: 'high',
            confidence: 0.25,
            title: 'Host inspection is not approved for this scope',
            summary: `Host target ${effectiveTarget.instanceId} is registered, but SSM host inspection is not allowed.`,
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

    try {
      const runner = this.runnerFactory(target)
      const timeoutMs = commandTimeoutMs(request)
      const response = await runner.runJson<SsmDescribeInstanceInformationResponse>([
        'ssm',
        'describe-instance-information',
        '--region',
        target.region,
        '--filters',
        `Key=InstanceIds,Values=${target.instanceId}`,
        '--output',
        'json',
      ], timeoutMs)

      const info = response.InstanceInformationList?.[0]
      const pingStatus = info?.PingStatus ?? 'Unknown'
      const isOnline = pingStatus.toLowerCase() === 'online'
      const configProbe = isOnline
        ? await this.runConfigProbe(request, target, runner, timeoutMs)
        : null
      const batchProbe = isOnline
        ? await this.runBatchScriptProbe(request, target, runner, timeoutMs)
        : null
      const configFinding = configProbe?.matches.length
        ? [{
          id: `${request.runId}-host-config-candidates`,
          adapter: 'host' as const,
          type: 'host_config_path_candidates',
          severity: 'medium' as const,
          confidence: 0.7,
          title: 'SSM config probe found property/config candidates',
          summary: `Found ${configProbe.matches.length} redacted config line candidate(s) under approved path(s) for runtime/code evidence terms.`,
          evidenceRefs: [`${request.runId}-host-config-probe`],
          requiresCodeChange: false,
          requiresDataChange: false,
          metadata: {
            terms: configProbe.terms,
            paths: configProbe.paths,
          },
        }]
        : []
      const batchFinding = batchProbe?.matches.length
        ? [{
          id: `${request.runId}-host-batch-script-candidates`,
          adapter: 'host' as const,
          type: 'host_batch_script_candidates',
          severity: 'medium' as const,
          confidence: 0.72,
          title: 'Host batch script probe found command candidates',
          summary: `Found ${batchProbe.matches.length} redacted batch script/config candidate(s) under approved path(s) for runtime evidence terms.`,
          evidenceRefs: [`${request.runId}-host-batch-script-probe`],
          requiresCodeChange: true,
          requiresDataChange: false,
          metadata: {
            terms: batchProbe.terms,
            paths: batchProbe.paths,
          },
        }]
        : []

      return {
        findings: [
          {
            id: `${request.runId}-host-posture`,
            adapter: 'host',
            type: 'host_runtime_posture',
            severity: isOnline ? 'medium' : 'high',
            confidence: isOnline ? 0.84 : 0.58,
            title: isOnline
              ? 'Host runtime is ready for bounded triage'
              : 'Host runtime requires attention before deeper inspection',
            summary: isOnline
              ? `SSM reports ${target.instanceId} online on ${info?.PlatformName ?? 'Linux'} ${info?.PlatformVersion ?? ''}.`
              : `SSM reports ${target.instanceId} as ${pingStatus}.`,
            evidenceRefs: [`${request.runId}-host-ssm`],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
          ...configFinding,
          ...batchFinding,
        ],
        evidence: [
          {
            id: `${request.runId}-host-ssm`,
            adapter: 'host',
            title: 'Host inspection via SSM',
            summary: `Observed SSM posture for ${target.instanceName} (${target.instanceId}) with agent ${info?.AgentVersion ?? 'unknown'}.`,
            contentType: 'application/json',
            metadata: {
              traceSteps: [
                {
                  title: 'Resolved approved host target',
                  detail: `Selected ${target.instanceName} (${target.instanceId}) from the host registry.`,
                },
                {
                  title: 'Read SSM runtime posture',
                  detail: `Ping status ${pingStatus}${info?.LastPingDateTime ? ` at ${info.LastPingDateTime}` : ''}.`,
                },
              ],
              platformName: info?.PlatformName,
              platformVersion: info?.PlatformVersion,
              agentVersion: info?.AgentVersion,
              ipAddress: info?.IPAddress,
              computerName: info?.ComputerName,
            },
          },
          ...(configProbe
            ? [{
              id: `${request.runId}-host-config-probe`,
              adapter: 'host' as const,
              title: 'SSM config/property probe',
              summary: configProbe.matches.length
                ? `Searched approved config path(s) and found ${configProbe.matches.length} redacted candidate line(s).`
                : `Searched approved config path(s) for runtime/code evidence terms; no candidate lines were found.`,
              contentType: 'application/json',
              metadata: {
                rawOutputStored: false,
                terms: configProbe.terms,
                paths: configProbe.paths,
                matches: configProbe.matches,
                traceSteps: [
                  {
                    title: 'Resolve approved config probe paths',
                    detail: `Using ${configProbe.paths.length} configured SSM config path(s) for ${target.instanceName}.`,
                  },
                  {
                    title: 'Search host config through SSM',
                    detail: `Searched for ${configProbe.terms.length} runtime/code evidence term(s); stored redacted matches only.`,
                    rowCount: configProbe.matches.length,
                  },
                ],
              },
            }]
            : []),
          ...(batchProbe
            ? [{
              id: `${request.runId}-host-batch-script-probe`,
              adapter: 'host' as const,
              title: 'SSM batch script/command probe',
              summary: batchProbe.matches.length
                ? `Searched approved batch script path(s) and found ${batchProbe.matches.length} redacted candidate line(s).`
                : `Searched approved batch script path(s) for runtime evidence terms; no candidate lines were found.`,
              contentType: 'application/json',
              metadata: {
                rawOutputStored: false,
                terms: batchProbe.terms,
                paths: batchProbe.paths,
                matches: batchProbe.matches,
                traceSteps: [
                  {
                    title: 'Resolve approved batch script probe paths',
                    detail: `Using ${batchProbe.paths.length} configured SSM batch path(s) for ${target.instanceName}.`,
                  },
                  {
                    title: 'Search host batch scripts through SSM',
                    detail: `Searched for ${batchProbe.terms.length} runtime evidence term(s); stored redacted matches only.`,
                    rowCount: batchProbe.matches.length,
                  },
                ],
              },
            }]
            : []),
        ],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 1 + (configProbe?.requestsIssued ?? 0) + (batchProbe?.requestsIssued ?? 0),
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        findings: [
          {
            id: `${request.runId}-host-access-failure`,
            adapter: 'host',
            type: 'host_access_failure',
            severity: 'critical',
            confidence: 0.2,
            title: 'Host inspection failed for the approved Client A target',
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

  private async executeViaSsh(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    startedAt: number,
  ): Promise<InvestigationAdapterResult> {
    if (!target.publicHost && target.sshAllowed === false && target.ssmAllowed === false) {
      return {
        findings: [
          {
            id: `${request.runId}-host-deferred`,
            adapter: 'host',
            type: 'host_inspection_deferred',
            severity: 'info',
            confidence: 0.6,
            title: 'Host inspection deferred until a real SSH host is identified',
            summary: `Cockpit has an AWS/log evidence scope for ${target.instanceName}, but no approved publicHost was derived from bounded ticket or runtime evidence. CloudWatch/S3 evidence can continue without operator LDAP SSH.`,
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

    if (!target.sshAllowed || !target.publicHost || target.sshAuthMode !== 'operator_ldap') {
      return {
        findings: [
          {
            id: `${request.runId}-host-not-allowed`,
            adapter: 'host',
            type: 'host_scope_denied',
            severity: 'high',
            confidence: 0.25,
            title: 'Operator LDAP SSH inspection is not approved for this scope',
            summary: `Host target ${target.instanceName} must explicitly configure networkPath=ssh_public, sshAuthMode=operator_ldap, sshAllowed=true, and publicHost before Cockpit can use operator LDAP SSH.`,
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

    try {
      const runner = this.sshRunnerFactory(target)
      const timeoutMs = commandTimeoutMs(request)
      const postureOutput = await runner.runRemoteText(
        'printf "host=%s\\nuser=%s\\nkernel=%s\\n" "$(hostname 2>/dev/null)" "$(id -un 2>/dev/null)" "$(uname -srm 2>/dev/null)"',
        timeoutMs,
      )
      const [runtimeLogProbe, configProbe, batchProbe] = await Promise.all([
        this.runSshRuntimeLogProbe(request, target, runner, timeoutMs),
        this.runSshConfigProbe(request, target, runner, Math.min(timeoutMs, 10_000)).catch(() => null),
        this.runSshBatchScriptProbe(request, target, runner, Math.min(timeoutMs, 10_000)).catch(() => null),
      ])
      const configFinding = configProbe?.matches.length
        ? [{
          id: `${request.runId}-host-config-candidates`,
          adapter: 'host' as const,
          type: 'host_config_path_candidates',
          severity: 'medium' as const,
          confidence: 0.7,
          title: 'SSH config probe found property/config candidates',
          summary: `Found ${configProbe.matches.length} redacted config line candidate(s) under approved path(s) for runtime/code evidence terms.`,
          evidenceRefs: [`${request.runId}-host-config-probe`],
          requiresCodeChange: false,
          requiresDataChange: false,
          metadata: {
            terms: configProbe.terms,
            paths: configProbe.paths,
          },
        }]
        : []
      const batchFinding = batchProbe?.matches.length
        ? [{
          id: `${request.runId}-host-batch-script-candidates`,
          adapter: 'host' as const,
          type: 'host_batch_script_candidates',
          severity: 'medium' as const,
          confidence: 0.72,
          title: 'SSH batch script probe found command candidates',
          summary: `Found ${batchProbe.matches.length} redacted batch script/config candidate(s) under approved path(s) for runtime evidence terms.`,
          evidenceRefs: [`${request.runId}-host-batch-script-probe`],
          requiresCodeChange: true,
          requiresDataChange: false,
          metadata: {
            terms: batchProbe.terms,
            paths: batchProbe.paths,
          },
        }]
        : []
      const runtimeLogFinding = runtimeLogProbe
        ? [{
          id: `${request.runId}-host-runtime-log-${runtimeLogProbe.error ? 'unavailable' : runtimeLogProbe.matches.length ? 'evidence' : 'empty'}`,
          adapter: 'host' as const,
          type: runtimeLogProbe.error
            ? 'runtime_log_access_blocked'
            : runtimeLogProbe.matches.length
              ? 'runtime_log_error_evidence'
              : 'host_runtime_log_no_evidence',
          severity: runtimeLogProbe.error ? 'medium' as const : runtimeLogProbe.matches.length ? 'high' as const : 'info' as const,
          confidence: runtimeLogProbe.error ? 0.45 : runtimeLogProbe.matches.length ? 0.86 : 0.58,
          title: runtimeLogProbe.error
            ? 'Application runtime-log probe could not complete'
            : runtimeLogProbe.matches.length
              ? 'Application logs contain bounded runtime failure evidence'
              : 'Application runtime-log probe found no matching failures',
          summary: runtimeLogProbe.error
            ? runtimeLogProbe.error
            : runtimeLogProbe.matches.length
              ? `Found ${runtimeLogProbe.matches.length} redacted failure line(s) under approved log roots on ${target.instanceName}.`
              : `Searched approved log roots on ${target.instanceName}; no matching failure lines were found in the ticket time window.`,
          evidenceRefs: [`${request.runId}-host-runtime-log-probe`],
          requiresCodeChange: runtimeLogProbe.matches.length > 0,
          requiresDataChange: false,
          metadata: {
            failureColumns: runtimeLogProbe.failureColumns,
            signals: runtimeLogProbe.signals,
            targetId: target.id,
          },
        }]
        : []

      return {
        findings: [
          {
            id: `${request.runId}-host-posture`,
            adapter: 'host',
            type: 'host_runtime_posture',
            severity: 'medium',
            confidence: 0.76,
            title: 'Host runtime reached through operator LDAP SSH',
            summary: `SSH reached ${target.instanceName} through the configured public endpoint; Cockpit did not receive or store the LDAP password.`,
            evidenceRefs: [`${request.runId}-host-ssh`],
            requiresCodeChange: false,
            requiresDataChange: false,
          },
          ...runtimeLogFinding,
          ...configFinding,
          ...batchFinding,
        ],
        evidence: [
          {
            id: `${request.runId}-host-ssh`,
            adapter: 'host',
            title: 'Host inspection via operator LDAP SSH',
            summary: `Reached ${target.instanceName} (${target.publicHost}) using non-interactive SSH; no password material was accepted by Cockpit.`,
            contentType: 'application/json',
            metadata: {
              authMode: target.sshAuthMode,
              publicHost: target.publicHost,
              port: target.sshPort || 22,
              rawOutputStored: false,
              posture: redactInvestigationText(postureOutput).slice(0, 600),
              traceSteps: [
                {
                  title: 'Resolved approved SSH host target',
                  detail: `Selected ${target.instanceName} from the host registry with networkPath=ssh_public.`,
                },
                {
                  title: 'Use non-interactive operator LDAP SSH',
                  detail: 'SSH was invoked with BatchMode=yes and can use an existing operator-authenticated control socket or key; Cockpit does not prompt for, log, or store the LDAP password.',
                },
              ],
            },
          },
          ...(runtimeLogProbe
            ? [{
              id: `${request.runId}-host-runtime-log-probe`,
              adapter: 'host' as const,
              title: 'SSH application runtime-log probe',
              summary: runtimeLogProbe.error
                ? runtimeLogProbe.error
                : `Searched ${runtimeLogProbe.paths.length} approved log root(s) and retained ${runtimeLogProbe.matches.length} redacted failure line(s).`,
              contentType: 'application/json',
              metadata: {
                rawOutputStored: false,
                targetId: target.id,
                targetName: target.instanceName,
                terms: runtimeLogProbe.terms,
                paths: runtimeLogProbe.paths,
                failureColumns: runtimeLogProbe.failureColumns,
                signals: runtimeLogProbe.signals,
                redactedSamples: runtimeLogProbe.matches,
                traceSteps: [
                  {
                    title: 'Resolve approved application log roots',
                    detail: `Using ${runtimeLogProbe.paths.length} bounded log root(s) on ${target.instanceName}.`,
                  },
                  {
                    title: 'Search and redact runtime failures',
                    detail: runtimeLogProbe.error
                      ? 'The SSH log search did not complete; the sanitized access gap was retained.'
                      : `Searched the ticket time window and retained ${runtimeLogProbe.matches.length} redacted line(s).`,
                    rowCount: runtimeLogProbe.matches.length,
                  },
                ],
              },
            }]
            : []),
          ...(configProbe
            ? [{
              id: `${request.runId}-host-config-probe`,
              adapter: 'host' as const,
              title: 'SSH config/property probe',
              summary: configProbe.matches.length
                ? `Searched approved config path(s) and found ${configProbe.matches.length} redacted candidate line(s).`
                : `Searched approved config path(s) for runtime/code evidence terms; no candidate lines were found.`,
              contentType: 'application/json',
              metadata: {
                rawOutputStored: false,
                terms: configProbe.terms,
                paths: configProbe.paths,
                matches: configProbe.matches,
                traceSteps: [
                  {
                    title: 'Resolve approved config probe paths',
                    detail: `Using ${configProbe.paths.length} configured SSH config path(s) for ${target.instanceName}.`,
                  },
                  {
                    title: 'Search host config through SSH',
                    detail: `Searched for ${configProbe.terms.length} runtime/code evidence term(s); stored redacted matches only.`,
                    rowCount: configProbe.matches.length,
                  },
                ],
              },
            }]
            : []),
          ...(batchProbe
            ? [{
              id: `${request.runId}-host-batch-script-probe`,
              adapter: 'host' as const,
              title: 'SSH batch script/command probe',
              summary: batchProbe.matches.length
                ? `Searched approved batch script path(s) and found ${batchProbe.matches.length} redacted candidate line(s).`
                : `Searched approved batch script path(s) for runtime evidence terms; no candidate lines were found.`,
              contentType: 'application/json',
              metadata: {
                rawOutputStored: false,
                terms: batchProbe.terms,
                paths: batchProbe.paths,
                matches: batchProbe.matches,
                traceSteps: [
                  {
                    title: 'Resolve approved batch script probe paths',
                    detail: `Using ${batchProbe.paths.length} configured SSH batch path(s) for ${target.instanceName}.`,
                  },
                  {
                    title: 'Search host batch scripts through SSH',
                    detail: `Searched for ${batchProbe.terms.length} runtime evidence term(s); stored redacted matches only.`,
                    rowCount: batchProbe.matches.length,
                  },
                ],
              },
            }]
            : []),
        ],
        telemetry: {
          durationMs: Date.now() - startedAt,
          requestsIssued: 1 + (runtimeLogProbe?.requestsIssued ?? 0) + (configProbe?.requestsIssued ?? 0) + (batchProbe?.requestsIssued ?? 0),
        },
      }
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error)
      const message = /permission denied|authentication failed|no supported authentication methods/i.test(rawMessage)
        ? 'The approved LDAP SSH target rejected the attended session credential or had no reusable authenticated ControlMaster. Host evidence was not collected.'
        : /control socket|mux_client/i.test(rawMessage)
          ? 'The approved LDAP SSH ControlMaster was unavailable or refused the command session. Host evidence was not collected.'
          : redactInvestigationText(rawMessage)
      return {
        findings: [
          {
            id: `${request.runId}-host-access-failure`,
            adapter: 'host',
            type: 'host_access_failure',
            severity: 'medium',
            confidence: 0.2,
            title: 'Operator LDAP SSH host inspection failed',
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

  private async runSshRuntimeLogProbe(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    runner: SshCommandRunner,
    timeoutMs: number,
  ): Promise<{
    terms: string[]
    paths: string[]
    matches: Array<{ file: string; preview: string; signals: string[]; failureColumns: string[] }>
    failureColumns: string[]
    signals: string[]
    requestsIssued: number
    error?: string
  } | null> {
    if (!runtimeLogProbeEnabled(request)) return null
    const configuredPaths = target.logRoots?.filter(Boolean) || []
    const paths = configuredPaths.length > 0 ? configuredPaths : DEFAULT_RUNTIME_LOG_PATHS
    const terms = resolveRuntimeLogProbeTerms(request)
    const maxMatches = DEFAULT_RUNTIME_LOG_MAX_MATCHES
    try {
      const output = await runner.runRemoteText(
        buildRuntimeLogProbeCommand(paths, terms, maxMatches, request),
        request.runId.startsWith('preflight-') ? Math.min(timeoutMs, 10_000) : Math.max(timeoutMs * 2, 60_000),
      )
      const matches = parseRuntimeLogProbeOutput(output, request, maxMatches)
      return {
        terms,
        paths,
        matches,
        failureColumns: Array.from(new Set(matches.flatMap(match => match.failureColumns))).slice(0, 20),
        signals: Array.from(new Set(matches.flatMap(match => match.signals))).slice(0, 40),
        requestsIssued: 1,
      }
    } catch (error) {
      const message = redactInvestigationText(error instanceof Error ? error.message : String(error))
        .replace(/Command failed:\s*ssh[\s\S]*/i, 'SSH runtime-log command failed; command details redacted.')
        .slice(0, 500)
      return {
        terms,
        paths,
        matches: [],
        failureColumns: [],
        signals: [],
        requestsIssued: 1,
        error: message,
      }
    }
  }

  private async runSshConfigProbe(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    runner: SshCommandRunner,
    timeoutMs: number,
  ): Promise<{
    terms: string[]
    paths: string[]
    matches: Array<{ file: string; line?: number; preview: string; signals: string[] }>
    requestsIssued: number
  } | null> {
    const paths = target.configProbePaths?.filter(Boolean) || []
    const terms = resolveConfigProbeTerms(request)
    if (paths.length === 0 || terms.length === 0) {
      return null
    }

    const maxMatches = target.configProbeMaxMatches || DEFAULT_CONFIG_PROBE_MAX_MATCHES
    const output = await runner.runRemoteText(buildConfigProbeCommand(paths, terms, maxMatches), timeoutMs)
    return {
      terms,
      paths,
      matches: parseConfigProbeOutput(output, maxMatches),
      requestsIssued: 1,
    }
  }

  private async runSshBatchScriptProbe(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    runner: SshCommandRunner,
    timeoutMs: number,
  ): Promise<{
    terms: string[]
    paths: string[]
    matches: Array<{ file: string; line?: number; preview: string; signals: string[] }>
    requestsIssued: number
  } | null> {
    const terms = resolveBatchProbeTerms(request)
    if (terms.length === 0) {
      return null
    }

    const configuredPaths = target.batchProbePaths?.filter(Boolean) || []
    const paths = configuredPaths.length > 0 ? configuredPaths : DEFAULT_BATCH_PROBE_PATHS
    const maxMatches = target.batchProbeMaxMatches || DEFAULT_BATCH_PROBE_MAX_MATCHES
    const output = await runner.runRemoteText(buildBatchScriptProbeCommand(paths, terms, maxMatches), timeoutMs)
    return {
      terms,
      paths,
      matches: parseConfigProbeOutput(output, maxMatches),
      requestsIssued: 1,
    }
  }

  private async runConfigProbe(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    runner: CliCommandRunner,
    timeoutMs: number,
  ): Promise<{
    terms: string[]
    paths: string[]
    matches: Array<{ file: string; line?: number; preview: string; signals: string[] }>
    requestsIssued: number
  } | null> {
    const paths = target.configProbePaths?.filter(Boolean) || []
    const terms = resolveConfigProbeTerms(request)
    if (paths.length === 0 || terms.length === 0) {
      return null
    }

    const maxMatches = target.configProbeMaxMatches || DEFAULT_CONFIG_PROBE_MAX_MATCHES
    const command = buildConfigProbeCommand(paths, terms, maxMatches)

    const commandId = (await runner.runText([
      'ssm',
      'send-command',
      '--region',
      target.region,
      '--instance-ids',
      target.instanceId,
      '--document-name',
      'AWS-RunShellScript',
      '--comment',
      `investigation cockpit config probe ${request.runId}`,
      '--parameters',
      JSON.stringify({ commands: [command] }),
      '--query',
      'Command.CommandId',
      '--output',
      'text',
    ], timeoutMs)).trim()

    const invocation = await this.waitForCommand(runner, commandId, target, timeoutMs)
    const output = invocation.StandardOutputContent || ''
    const stderr = invocation.StandardErrorContent || ''
    const status = invocation.Status || 'Unknown'
    if (status !== 'Success' && !output) {
      return {
        terms,
        paths,
        matches: [{
          file: 'ssm-command',
          preview: `Config probe did not complete: ${redactInvestigationText(stderr || status).slice(0, 300)}`,
          signals: [],
        }],
        requestsIssued: 2,
      }
    }

    return {
      terms,
      paths,
      matches: parseConfigProbeOutput(output, maxMatches),
      requestsIssued: 2,
    }
  }

  private async runBatchScriptProbe(
    request: InvestigationAdapterRequest,
    target: InvestigationHostTarget,
    runner: CliCommandRunner,
    timeoutMs: number,
  ): Promise<{
    terms: string[]
    paths: string[]
    matches: Array<{ file: string; line?: number; preview: string; signals: string[] }>
    requestsIssued: number
  } | null> {
    const terms = resolveBatchProbeTerms(request)
    if (terms.length === 0) {
      return null
    }

    const configuredPaths = target.batchProbePaths?.filter(Boolean) || []
    const paths = configuredPaths.length > 0 ? configuredPaths : DEFAULT_BATCH_PROBE_PATHS
    const maxMatches = target.batchProbeMaxMatches || DEFAULT_BATCH_PROBE_MAX_MATCHES
    const command = buildBatchScriptProbeCommand(paths, terms, maxMatches)

    const commandId = (await runner.runText([
      'ssm',
      'send-command',
      '--region',
      target.region,
      '--instance-ids',
      target.instanceId,
      '--document-name',
      'AWS-RunShellScript',
      '--comment',
      `investigation cockpit batch script probe ${request.runId}`,
      '--parameters',
      JSON.stringify({ commands: [command] }),
      '--query',
      'Command.CommandId',
      '--output',
      'text',
    ], timeoutMs)).trim()

    const invocation = await this.waitForCommand(runner, commandId, target, timeoutMs)
    const output = invocation.StandardOutputContent || ''
    const stderr = invocation.StandardErrorContent || ''
    const status = invocation.Status || 'Unknown'
    if (status !== 'Success' && !output) {
      return {
        terms,
        paths,
        matches: [{
          file: 'ssm-command',
          preview: `Batch script probe did not complete: ${redactInvestigationText(stderr || status).slice(0, 300)}`,
          signals: [],
        }],
        requestsIssued: 2,
      }
    }

    return {
      terms,
      paths,
      matches: parseConfigProbeOutput(output, maxMatches),
      requestsIssued: 2,
    }
  }

  private async waitForCommand(
    runner: CliCommandRunner,
    commandId: string,
    target: InvestigationHostTarget,
    timeoutMs: number,
  ): Promise<SsmCommandInvocationResponse> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const payload = await runner.runJson<SsmCommandInvocationResponse>([
        'ssm',
        'get-command-invocation',
        '--region',
        target.region,
        '--command-id',
        commandId,
        '--instance-id',
        target.instanceId,
        '--output',
        'json',
      ], timeoutMs)
      const status = payload.Status || 'Unknown'
      if (!['Pending', 'InProgress', 'Delayed'].includes(status)) {
        return payload
      }
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    return {
      Status: 'TimedOut',
      StandardErrorContent: 'Timed out waiting for SSM config probe command completion.',
    }
  }
}
