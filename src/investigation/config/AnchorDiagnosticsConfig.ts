import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import type { InvestigationEvidenceAnchorKind } from '../types/investigation.js'

export interface AnchorDiagnosticsConfig {
  limits: {
    maxAnchorValues: number
    maxCodeFlowTables: number
    maxProbeQueries: number
    maxSampleColumns: number
    maxConfigSampleColumns: number
  }
  phiColumnsPath: string
  fuzzyMatching: {
    enabled: boolean
    threshold: number
    configThreshold: number
  }
  anchorColumnPatterns: Record<InvestigationEvidenceAnchorKind, RegExp[]>
  anchorPriority: InvestigationEvidenceAnchorKind[]
  foundationalTables: Partial<Record<InvestigationEvidenceAnchorKind, string[]>>
  ticketAnchorExtraction: Partial<Record<InvestigationEvidenceAnchorKind, TicketAnchorExtractionConfig>>
  configTablePatterns: RegExp[]
  safeSampleColumns: {
    allowPatterns: RegExp[]
    denyPatterns: RegExp[]
    nonConfigTextDenyPatterns: RegExp[]
  }
  configSampleColumns: {
    allowPatterns: RegExp[]
  }
  phiColumns: MeridianPhiColumns
}

export interface TicketAnchorExtractionConfig {
  labelPatterns: RegExp[]
  rejectLabelPatterns: RegExp[]
  valuePatterns: RegExp[]
  jsonKeyPatterns: RegExp[]
  filenamePatterns: RegExp[]
}

export interface MeridianPhiColumns {
  columnsByTable: Map<string, Set<string>>
  globalColumns: Set<string>
}

type RawAnchorConfig = {
  limits: AnchorDiagnosticsConfig['limits']
  phiColumnsPath: string
  fuzzyMatching: AnchorDiagnosticsConfig['fuzzyMatching']
  anchorColumnPatterns: Record<string, string[]>
  anchorPriority: string[]
  foundationalTables: Record<string, string[]>
  ticketAnchorExtraction: Record<string, {
    labelPatterns: string[]
    rejectLabelPatterns: string[]
    valuePatterns: string[]
    jsonKeyPatterns: string[]
    filenamePatterns: string[]
  }>
  configTablePatterns: string[]
  safeSampleColumns: {
    allowPatterns: string[]
    denyPatterns: string[]
    nonConfigTextDenyPatterns: string[]
  }
  configSampleColumns: {
    allowPatterns: string[]
  }
}

const ANCHOR_KINDS: InvestigationEvidenceAnchorKind[] = [
  'case_number',
  'member_identifier',
  'job_name',
  'batch_name',
  'file_name',
  'extract_id',
  'transaction_id',
  'letter_id',
  'fax_id',
  'config_key',
]

let cachedConfig: AnchorDiagnosticsConfig | null = null
let cachedPhiColumns: MeridianPhiColumns | null = null
let cachedPhiPath: string | null = null

export function getAnchorDiagnosticsConfig(): AnchorDiagnosticsConfig {
  if (cachedConfig) {
    return cachedConfig
  }

  const configPath = resolveRepoPath(
    process.env.INVESTIGATION_ANCHOR_DIAGNOSTICS_CONFIG
      || 'src/investigation/config/anchor-diagnostics.yaml',
  )
  const raw = existsSync(configPath)
    ? parseAnchorDiagnosticsYaml(readFileSync(configPath, 'utf8'))
    : defaultRawConfig()
  const phiColumns = loadMeridianPhiColumns(raw.phiColumnsPath)

  cachedConfig = {
    limits: raw.limits,
    phiColumnsPath: raw.phiColumnsPath,
    fuzzyMatching: raw.fuzzyMatching,
    anchorColumnPatterns: compileAnchorPatterns(raw.anchorColumnPatterns),
    anchorPriority: raw.anchorPriority
      .filter((entry): entry is InvestigationEvidenceAnchorKind => isAnchorKind(entry)),
    foundationalTables: compileFoundationalTables(raw.foundationalTables),
    ticketAnchorExtraction: compileTicketAnchorExtraction(raw.ticketAnchorExtraction),
    configTablePatterns: compilePatterns(raw.configTablePatterns),
    safeSampleColumns: {
      allowPatterns: compilePatterns(raw.safeSampleColumns.allowPatterns),
      denyPatterns: compilePatterns(raw.safeSampleColumns.denyPatterns),
      nonConfigTextDenyPatterns: compilePatterns(raw.safeSampleColumns.nonConfigTextDenyPatterns),
    },
    configSampleColumns: {
      allowPatterns: compilePatterns(raw.configSampleColumns.allowPatterns),
    },
    phiColumns,
  }
  return cachedConfig
}

export function loadMeridianPhiColumns(configuredPath = 'meridian/backend/config/phi_columns.yaml'): MeridianPhiColumns {
  const phiPath = resolveRepoPath(configuredPath)
  if (cachedPhiColumns && cachedPhiPath === phiPath) {
    return cachedPhiColumns
  }
  if (!existsSync(phiPath)) {
    return {
      columnsByTable: new Map(),
      globalColumns: new Set(),
    }
  }

  const columnsByTable = new Map<string, Set<string>>()
  const globalColumns = new Set<string>()
  let currentTable: string | null = null

  for (const rawLine of readFileSync(phiPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '')
    if (!line.trim() || line.trimStart().startsWith('#')) {
      continue
    }

    const tableMatch = line.match(/^([A-Za-z0-9_]+):\s*$/)
    if (tableMatch?.[1]) {
      currentTable = tableMatch[1].toLowerCase()
      if (!columnsByTable.has(currentTable)) {
        columnsByTable.set(currentTable, new Set())
      }
      continue
    }

    const columnMatch = line.match(/^\s*-\s*([A-Za-z0-9_]+)\s*$/)
    if (currentTable && columnMatch?.[1]) {
      const normalized = columnMatch[1].toLowerCase()
      columnsByTable.get(currentTable)?.add(normalized)
      globalColumns.add(normalized)
    }
  }

  cachedPhiColumns = { columnsByTable, globalColumns }
  cachedPhiPath = phiPath
  return cachedPhiColumns
}

export function isConfiguredPhiColumn(columnName: string, tableName?: string): boolean {
  const config = getAnchorDiagnosticsConfig()
  const normalizedColumn = normalizeColumnKey(columnName)
  if (!normalizedColumn) {
    return false
  }
  if (tableName) {
    const tableColumns = config.phiColumns.columnsByTable.get(tableName.toLowerCase())
    if (tableColumns?.has(normalizedColumn)) {
      return true
    }
  }
  return config.phiColumns.globalColumns.has(normalizedColumn)
}

export function normalizeColumnKey(columnName: string): string {
  return columnName
    .replace(/_sample$/i, '')
    .replace(/_(?:truthy|falsy|enabled|disabled)_rows$/i, '')
    .toLowerCase()
}

function parseAnchorDiagnosticsYaml(raw: string): RawAnchorConfig {
  const config = defaultRawConfig()
  let section = ''
  let nested = ''
  let anchorKind = ''

  for (const rawLine of raw.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trimStart().startsWith('#')) {
      continue
    }
    const indent = rawLine.match(/^\s*/)?.[0].length || 0
    const line = rawLine.trim()
    const keyValue = line.match(/^([A-Za-z0-9_]+):(?:\s*(.*))?$/)

    if (indent === 0 && keyValue?.[1]) {
      section = keyValue[1]
      nested = ''
      anchorKind = ''
      if (keyValue[2]) {
        assignTopLevelScalar(config, section, scalar(keyValue[2]))
      }
      continue
    }

    if (section === 'limits' && indent === 2 && keyValue?.[1]) {
      const parsed = Number.parseInt(scalar(keyValue[2] || ''), 10)
      if (Number.isFinite(parsed)) {
        config.limits[keyValue[1] as keyof RawAnchorConfig['limits']] = parsed
      }
      continue
    }

    if (section === 'fuzzyMatching' && indent === 2 && keyValue?.[1]) {
      const value = scalar(keyValue[2] || '')
      if (keyValue[1] === 'enabled') {
        config.fuzzyMatching.enabled = value === 'true'
      } else {
        const parsed = Number.parseFloat(value)
        if (Number.isFinite(parsed)) {
          config.fuzzyMatching[keyValue[1] as 'threshold' | 'configThreshold'] = parsed
        }
      }
      continue
    }

    if (section === 'anchorColumnPatterns') {
      if (indent === 2 && keyValue?.[1]) {
        anchorKind = keyValue[1]
        config.anchorColumnPatterns[anchorKind] ||= []
      } else if (indent === 4 && line.startsWith('- ') && anchorKind) {
        config.anchorColumnPatterns[anchorKind].push(scalar(line.slice(2)))
      }
      continue
    }

    if (section === 'anchorPriority' && indent === 2 && line.startsWith('- ')) {
      config.anchorPriority.push(scalar(line.slice(2)))
      continue
    }

    if (section === 'foundationalTables') {
      if (indent === 2 && keyValue?.[1]) {
        anchorKind = keyValue[1]
        config.foundationalTables[anchorKind] ||= []
      } else if (indent === 4 && line.startsWith('- ') && anchorKind) {
        config.foundationalTables[anchorKind].push(scalar(line.slice(2)))
      }
      continue
    }

    if (section === 'ticketAnchorExtraction') {
      if (indent === 2 && keyValue?.[1]) {
        anchorKind = keyValue[1]
        config.ticketAnchorExtraction[anchorKind] ||= emptyRawTicketAnchorExtraction()
        nested = ''
      } else if (indent === 4 && keyValue?.[1] && anchorKind) {
        nested = keyValue[1]
      } else if (indent === 6 && line.startsWith('- ') && anchorKind && nested) {
        const target = config.ticketAnchorExtraction[anchorKind]?.[
          nested as keyof RawAnchorConfig['ticketAnchorExtraction'][string]
        ]
        target?.push(scalar(line.slice(2)))
      }
      continue
    }

    if (section === 'configTablePatterns' && indent === 2 && line.startsWith('- ')) {
      config.configTablePatterns.push(scalar(line.slice(2)))
      continue
    }

    if (section === 'safeSampleColumns') {
      if (indent === 2 && keyValue?.[1]) {
        nested = keyValue[1]
      } else if (indent === 4 && line.startsWith('- ')) {
        const target = config.safeSampleColumns[nested as keyof RawAnchorConfig['safeSampleColumns']]
        target?.push(scalar(line.slice(2)))
      }
      continue
    }

    if (section === 'configSampleColumns') {
      if (indent === 2 && keyValue?.[1]) {
        nested = keyValue[1]
      } else if (indent === 4 && line.startsWith('- ')) {
        const target = config.configSampleColumns[nested as keyof RawAnchorConfig['configSampleColumns']]
        target?.push(scalar(line.slice(2)))
      }
    }
  }

  return config
}

function defaultRawConfig(): RawAnchorConfig {
  return {
    limits: {
      maxAnchorValues: 10,
      maxCodeFlowTables: 12,
      maxProbeQueries: 8,
      maxSampleColumns: 8,
      maxConfigSampleColumns: 10,
    },
    phiColumnsPath: 'meridian/backend/config/phi_columns.yaml',
    fuzzyMatching: {
      enabled: true,
      threshold: 0.72,
      configThreshold: 0.64,
    },
    anchorColumnPatterns: {},
    anchorPriority: [],
    foundationalTables: {},
    ticketAnchorExtraction: {},
    configTablePatterns: [],
    safeSampleColumns: {
      allowPatterns: [],
      denyPatterns: [],
      nonConfigTextDenyPatterns: [],
    },
    configSampleColumns: {
      allowPatterns: [],
    },
  }
}

function emptyRawTicketAnchorExtraction(): RawAnchorConfig['ticketAnchorExtraction'][string] {
  return {
    labelPatterns: [],
    rejectLabelPatterns: [],
    valuePatterns: [],
    jsonKeyPatterns: [],
    filenamePatterns: [],
  }
}

function assignTopLevelScalar(config: RawAnchorConfig, key: string, value: string): void {
  if (key === 'phiColumnsPath') {
    config.phiColumnsPath = value
  }
}

function scalar(value: string): string {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
    || (trimmed.startsWith('"') && trimmed.endsWith('"'))
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

function compileAnchorPatterns(rawPatterns: Record<string, string[]>): Record<InvestigationEvidenceAnchorKind, RegExp[]> {
  return ANCHOR_KINDS.reduce<Record<InvestigationEvidenceAnchorKind, RegExp[]>>((compiled, kind) => {
    compiled[kind] = compilePatterns(rawPatterns[kind] || [])
    return compiled
  }, {} as Record<InvestigationEvidenceAnchorKind, RegExp[]>)
}

function compilePatterns(rawPatterns: string[]): RegExp[] {
  return rawPatterns
    .map(pattern => {
      try {
        return new RegExp(pattern, 'i')
      } catch {
        return null
      }
    })
    .filter((entry): entry is RegExp => Boolean(entry))
}

function compileTicketAnchorExtraction(
  raw: RawAnchorConfig['ticketAnchorExtraction'],
): AnchorDiagnosticsConfig['ticketAnchorExtraction'] {
  const compiled: AnchorDiagnosticsConfig['ticketAnchorExtraction'] = {}
  for (const [kind, patterns] of Object.entries(raw)) {
    if (!isAnchorKind(kind)) continue
    compiled[kind] = {
      labelPatterns: compilePatterns(patterns.labelPatterns),
      rejectLabelPatterns: compilePatterns(patterns.rejectLabelPatterns),
      valuePatterns: compilePatterns(patterns.valuePatterns),
      jsonKeyPatterns: compilePatterns(patterns.jsonKeyPatterns),
      filenamePatterns: compilePatterns(patterns.filenamePatterns),
    }
  }
  return compiled
}

function compileFoundationalTables(
  raw: RawAnchorConfig['foundationalTables'],
): AnchorDiagnosticsConfig['foundationalTables'] {
  const compiled: AnchorDiagnosticsConfig['foundationalTables'] = {}
  for (const [kind, tables] of Object.entries(raw)) {
    if (!isAnchorKind(kind)) continue
    compiled[kind] = Array.from(new Set(tables
      .map(table => table.trim().toLowerCase())
      .filter(table => /^[a-z_][a-z0-9_]*$/.test(table))))
  }
  return compiled
}

function isAnchorKind(value: string): value is InvestigationEvidenceAnchorKind {
  return ANCHOR_KINDS.includes(value as InvestigationEvidenceAnchorKind)
}

function resolveRepoPath(value: string): string {
  if (path.isAbsolute(value)) return value
  const candidates = [
    path.resolve(process.cwd(), value),
    path.resolve(process.cwd(), '..', value),
    path.resolve(process.cwd(), '../..', value),
  ]
  return candidates.find(candidate => existsSync(candidate)) || candidates[0]
}
