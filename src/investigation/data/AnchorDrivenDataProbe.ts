import {
  getAnchorDiagnosticsConfig,
  isConfiguredPhiColumn,
  type AnchorDiagnosticsConfig,
} from '../config/AnchorDiagnosticsConfig.js'
import type {
  InvestigationDataFlowColumnHint,
  InvestigationDataFlowHint,
  InvestigationEvidenceAnchor,
  InvestigationEvidenceAnchorKind,
  InvestigationScope,
} from '../types/investigation.js'

export interface CodeFlowColumnInventoryRow {
  table_name?: string
  TABLE_NAME?: string
  column_name?: string
  COLUMN_NAME?: string
}

export interface AnchorProbeQuery {
  id: string
  title: string
  sql: string
  parameters: unknown[]
  tableName: string
  anchorKind: InvestigationEvidenceAnchorKind
  anchorColumn: string
  sourcePath: string
  relationship?: {
    rootTable: string
    rootAnchorColumn: string
    rootKeyColumn: string
  }
}

interface ColumnMatchContext {
  columnName: string
  hint?: InvestigationDataFlowColumnHint
}

export function getScopeEvidenceAnchors(scope: InvestigationScope): InvestigationEvidenceAnchor[] {
  const anchors = [
    ...(scope.evidenceAnchors || []),
    ...(scope.ticketContext?.evidenceAnchors || []),
    ...(scope.ticketContext?.identifiers || []).map(identifier => ({
      kind: identifier.kind,
      source: identifier.source,
      value: identifier.value,
      label: identifier.kind === 'member_identifier' ? 'member identifier' : 'case number',
      sensitive: true as const,
    })),
  ]
  const seen = new Set<string>()
  return anchors
    .map(anchor => ({
      ...anchor,
      value: anchor.value.trim(),
    }))
    .filter(anchor => anchor.value.length > 0 && anchor.value.length <= 160)
    .filter(anchor => {
      const key = `${anchor.kind}:${anchor.value.toLowerCase()}`
      if (seen.has(key)) {
        return false
      }
      seen.add(key)
      return true
    })
}

export function getCodeFlowTables(scope: InvestigationScope): string[] {
  const config = getAnchorDiagnosticsConfig()
  const hints = scope.diagnosticContext?.dataFlowHints || []
  const tableNames = hints
    .map(hint => safeIdentifier(hint.tableName))
    .filter((value): value is string => Boolean(value))
  return Array.from(new Set(tableNames)).slice(0, config.limits.maxCodeFlowTables)
}

export function getAnchorDiagnosticTables(scope: InvestigationScope): string[] {
  const config = getAnchorDiagnosticsConfig()
  const foundational = getScopeEvidenceAnchors(scope)
    .flatMap(anchor => config.foundationalTables[anchor.kind] || [])
  return Array.from(new Set([
    ...foundational.map(safeIdentifier).filter((value): value is string => Boolean(value)),
    ...getCodeFlowTables(scope),
  ])).slice(0, config.limits.maxCodeFlowTables)
}

export function buildColumnInventoryQuery(tableNames: string[]): { sql: string; parameters: unknown[] } | null {
  const config = getAnchorDiagnosticsConfig()
  const safeTables = tableNames
    .map(safeIdentifier)
    .filter((value): value is string => Boolean(value))
    .slice(0, config.limits.maxCodeFlowTables)
  if (safeTables.length === 0) {
    return null
  }

  return {
    sql: [
      'SELECT table_name, column_name',
      'FROM information_schema.columns',
      'WHERE table_schema = DATABASE()',
      `AND table_name IN (${safeTables.map(() => '?').join(', ')})`,
      'ORDER BY table_name, ordinal_position',
      'LIMIT 500',
    ].join(' '),
    parameters: safeTables,
  }
}

export function buildAnchorProbeQueries(
  scope: InvestigationScope,
  inventoryRows: CodeFlowColumnInventoryRow[],
): AnchorProbeQuery[] {
  const config = getAnchorDiagnosticsConfig()
  const anchors = getScopeEvidenceAnchors(scope)
  const hintsByTable = buildHintsByTable(scope.diagnosticContext?.dataFlowHints || [])
  const columnsByTable = buildColumnsByTable(inventoryRows)
  const relationalRoots = buildRelationalRoots(anchors, columnsByTable, config)

  const queries: AnchorProbeQuery[] = []
  for (const [tableName, columns] of columnsByTable) {
    if (queries.length >= config.limits.maxProbeQueries) {
      break
    }
    const sourcePath = hintsByTable.get(tableName)?.sourcePath || tableName
    const safeSampleColumns = selectSafeSampleColumns(tableName, columns, hintsByTable.get(tableName), config)

    for (const anchorKind of anchorKindsByPriority(anchors, config)) {
      if (queries.length >= config.limits.maxProbeQueries) {
        break
      }
      if (anchorKind === 'config_key') {
        continue
      }
      const values = anchors
        .filter(anchor => anchor.kind === anchorKind)
        .flatMap(anchor => anchorLookupValues(anchor))
        .filter((value, index, candidates) => candidates.indexOf(value) === index)
        .slice(0, config.limits.maxAnchorValues)
      if (values.length === 0) {
        continue
      }
      const anchorColumn = chooseAnchorColumn({
        tableName,
        columns,
        anchorKind,
        anchors: anchors.filter(anchor => anchor.kind === anchorKind),
        hint: hintsByTable.get(tableName),
        config,
      })
      if (!anchorColumn) {
        continue
      }
      queries.push(buildAnchorProbeQuery({
        tableName,
        anchorColumn,
        anchorKind,
        values,
        safeSampleColumns,
        sourcePath,
        relationship: relationalRelationship(
          tableName,
          anchorColumn,
          anchorKind,
          relationalRoots.get(anchorKind),
        ),
      }))
    }

    if (queries.length < config.limits.maxProbeQueries && isConfigTable(tableName, config)) {
      const configColumns = selectConfigSampleColumns(tableName, columns, anchors, hintsByTable.get(tableName), config)
      if (configColumns.length > 0) {
        queries.push(buildConfigSampleQuery({
          tableName,
          columns: configColumns,
          sourcePath,
          queryIndex: queries.length + 1,
        }))
      }
    }
  }

  return queries
}

function anchorLookupValues(anchor: InvestigationEvidenceAnchor): string[] {
  if (anchor.kind !== 'member_identifier') return [anchor.value]
  const parts = anchor.value.split(/[\/-]/).filter(Boolean)
  if (parts.length < 2) return [anchor.value]
  const base = parts[0] as string
  const suffix = parts.slice(1).join('')
  return Array.from(new Set([
    anchor.value,
    `${base}/${suffix}`,
    `${base}-${suffix}`,
    base,
  ]))
}

export function hasAnchorDrivenProbeScope(scope: InvestigationScope): boolean {
  return getScopeEvidenceAnchors(scope).length > 0 && getAnchorDiagnosticTables(scope).length > 0
}

function buildHintsByTable(hints: InvestigationDataFlowHint[]): Map<string, InvestigationDataFlowHint> {
  const hintsByTable = new Map<string, InvestigationDataFlowHint>()
  for (const hint of hints) {
    const tableName = safeIdentifier(hint.tableName)
    if (tableName && !hintsByTable.has(tableName)) {
      hintsByTable.set(tableName, hint)
    }
  }
  return hintsByTable
}

function buildColumnsByTable(inventoryRows: CodeFlowColumnInventoryRow[]): Map<string, string[]> {
  const columnsByTable = new Map<string, string[]>()
  for (const row of inventoryRows) {
    const tableName = safeIdentifier(String(row.table_name ?? row.TABLE_NAME ?? ''))
    const columnName = safeIdentifier(String(row.column_name ?? row.COLUMN_NAME ?? ''))
    if (!tableName || !columnName) {
      continue
    }
    columnsByTable.set(tableName, [...(columnsByTable.get(tableName) || []), columnName])
  }
  return columnsByTable
}

function buildAnchorProbeQuery(input: {
  tableName: string
  anchorColumn: string
  anchorKind: InvestigationEvidenceAnchorKind
  values: string[]
  safeSampleColumns: string[]
  sourcePath: string
  relationship?: AnchorProbeQuery['relationship']
}): AnchorProbeQuery {
  const sampleExpressions = input.safeSampleColumns
    .filter(column => column !== input.anchorColumn)
    .map(column => `MAX(CAST(\`${column}\` AS CHAR)) AS \`${column}_sample\``)

  return {
    id: `anchor-probe-${input.tableName}-${input.anchorColumn}-${input.anchorKind}`,
    title: `Code-flow ${input.anchorKind} lookup in ${input.tableName}`,
    sql: [
      `SELECT '[ANCHOR]' AS anchor_scope`,
      `'${input.anchorKind}' AS anchor_kind`,
      `'${input.tableName}' AS code_flow_table`,
      `'${input.anchorColumn}' AS anchor_column`,
      'COUNT(*) AS matched_rows',
      ...sampleExpressions,
      `FROM \`${input.tableName}\``,
      input.relationship
        ? `WHERE \`${input.anchorColumn}\` IN (SELECT \`${input.relationship.rootKeyColumn}\` FROM \`${input.relationship.rootTable}\` WHERE \`${input.relationship.rootAnchorColumn}\` IN (${input.values.map(() => '?').join(', ')}))`
        : `WHERE \`${input.anchorColumn}\` IN (${input.values.map(() => '?').join(', ')})`,
      'LIMIT 1',
    ].join(', ').replace(', FROM', ' FROM').replace(', WHERE', ' WHERE').replace(', LIMIT', ' LIMIT'),
    parameters: input.values,
    tableName: input.tableName,
    anchorKind: input.anchorKind,
    anchorColumn: input.anchorColumn,
    sourcePath: input.sourcePath,
    relationship: input.relationship,
  }
}

interface RelationalAnchorRoot {
  tableName: string
  anchorColumn: string
  keyColumn: string
}

function buildRelationalRoots(
  anchors: InvestigationEvidenceAnchor[],
  columnsByTable: Map<string, string[]>,
  config: AnchorDiagnosticsConfig,
): Map<InvestigationEvidenceAnchorKind, RelationalAnchorRoot> {
  const roots = new Map<InvestigationEvidenceAnchorKind, RelationalAnchorRoot>()
  for (const kind of anchorKindsByPriority(anchors, config)) {
    const candidates = Array.from(columnsByTable, ([tableName, columns]) => {
      const keyColumn = columns.find(column => /^id$/i.test(column))
      const anchorColumn = columns
        .filter(column => !/^id$/i.test(column))
        .map(column => ({
          column,
          score: columnAnchorScore({
            column,
            anchorKind: kind,
            anchors: anchors.filter(anchor => anchor.kind === kind),
            config,
          }),
        }))
        .filter(candidate => candidate.score > 0)
        .sort((left, right) => right.score - left.score || left.column.localeCompare(right.column))[0]
      return keyColumn && anchorColumn
        ? { tableName, anchorColumn: anchorColumn.column, keyColumn, score: anchorColumn.score }
        : null
    }).filter((candidate): candidate is RelationalAnchorRoot & { score: number } => Boolean(candidate))
      .sort((left, right) => right.score - left.score || left.tableName.localeCompare(right.tableName))
    const root = candidates[0]
    if (root) roots.set(kind, root)
  }
  return roots
}

function relationalRelationship(
  tableName: string,
  anchorColumn: string,
  anchorKind: InvestigationEvidenceAnchorKind,
  root: RelationalAnchorRoot | undefined,
): AnchorProbeQuery['relationship'] {
  if (!root || tableName === root.tableName) return undefined
  const foreignKeyLike = anchorKind === 'member_identifier'
    ? /^(?:member|subscriber|person|patient)_?id$/i.test(anchorColumn)
    : /_id$/i.test(anchorColumn)
  if (!foreignKeyLike) return undefined
  return {
    rootTable: root.tableName,
    rootAnchorColumn: root.anchorColumn,
    rootKeyColumn: root.keyColumn,
  }
}

function buildConfigSampleQuery(input: {
  tableName: string
  columns: string[]
  sourcePath: string
  queryIndex: number
}): AnchorProbeQuery {
  const sampleExpressions = input.columns.flatMap(column => [
    `MAX(CAST(\`${column}\` AS CHAR)) AS \`${column}_sample\``,
    `SUM(CASE WHEN UPPER(TRIM(CAST(\`${column}\` AS CHAR))) IN ('Y', 'YES', 'TRUE', '1', 'ENABLED') THEN 1 ELSE 0 END) AS \`${column}_truthy_rows\``,
    `SUM(CASE WHEN UPPER(TRIM(CAST(\`${column}\` AS CHAR))) IN ('N', 'NO', 'FALSE', '0', 'DISABLED') THEN 1 ELSE 0 END) AS \`${column}_falsy_rows\``,
  ])

  return {
    id: `anchor-probe-${input.queryIndex}-${input.tableName}-config`,
    title: `Code-flow config sample for ${input.tableName}`,
    sql: [
      `SELECT '${input.tableName}' AS code_flow_table`,
      'COUNT(*) AS sampled_rows',
      ...sampleExpressions,
      `FROM \`${input.tableName}\``,
      'LIMIT 1',
    ].join(', ').replace(', FROM', ' FROM').replace(', LIMIT', ' LIMIT'),
    parameters: [],
    tableName: input.tableName,
    anchorKind: 'config_key',
    anchorColumn: 'config_sample',
    sourcePath: input.sourcePath,
  }
}

function anchorKindsByPriority(
  anchors: InvestigationEvidenceAnchor[],
  config: AnchorDiagnosticsConfig,
): InvestigationEvidenceAnchorKind[] {
  const present = new Set(anchors.map(anchor => anchor.kind))
  return config.anchorPriority.filter(kind => present.has(kind))
}

function chooseAnchorColumn(input: {
  tableName: string
  columns: string[]
  anchorKind: InvestigationEvidenceAnchorKind
  anchors: InvestigationEvidenceAnchor[]
  hint?: InvestigationDataFlowHint
  config: AnchorDiagnosticsConfig
}): string | null {
  const candidates = input.columns
    .map(column => ({
      column,
      score: columnAnchorScore({
        column,
        anchorKind: input.anchorKind,
        anchors: input.anchors,
        hint: input.hint,
        config: input.config,
      }),
    }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.column.localeCompare(b.column))

  return candidates[0]?.column || null
}

function selectSafeSampleColumns(
  tableName: string,
  columns: string[],
  hint: InvestigationDataFlowHint | undefined,
  config: AnchorDiagnosticsConfig,
): string[] {
  const allowDescription = isConfigTable(tableName, config)
  return columns
    .filter(column => config.safeSampleColumns.allowPatterns.some(pattern => pattern.test(column)))
    .filter(column => allowDescription || !config.safeSampleColumns.nonConfigTextDenyPatterns.some(pattern => pattern.test(column)))
    .filter(column => !isUnsafeSampleColumn(tableName, column, config))
    .sort((a, b) =>
      stateColumnPriority(b) - stateColumnPriority(a)
      || columnHintScore(b, hint) - columnHintScore(a, hint)
      || a.localeCompare(b),
    )
    .slice(0, config.limits.maxSampleColumns)
}

function stateColumnPriority(columnName: string): number {
  if (/^(?:in_?active|active|enabled|status|state)$/i.test(columnName)) return 3
  if (/(?:active|enabled|status|state|effective|term|end)_?(?:flag|date|datetime)?$/i.test(columnName)) return 2
  if (/(?:insert|update|created|updated)_?(?:date|datetime|at)$/i.test(columnName)) return 1
  return 0
}

function selectConfigSampleColumns(
  tableName: string,
  columns: string[],
  anchors: InvestigationEvidenceAnchor[],
  hint: InvestigationDataFlowHint | undefined,
  config: AnchorDiagnosticsConfig,
): string[] {
  const configAnchors = anchors.filter(anchor => anchor.kind === 'config_key')
  return columns
    .filter(column => !isUnsafeSampleColumn(tableName, column, config))
    .map(column => ({
      column,
      score: Math.max(
        config.configSampleColumns.allowPatterns.some(pattern => pattern.test(column)) ? 0.8 : 0,
        ...configAnchors.map(anchor => fuzzyColumnScore(column, columnHint(column, hint), anchor, config.fuzzyMatching.configThreshold)),
      ),
    }))
    .filter(candidate => candidate.score >= config.fuzzyMatching.configThreshold)
    .sort((a, b) => b.score - a.score || a.column.localeCompare(b.column))
    .map(candidate => candidate.column)
    .slice(0, config.limits.maxConfigSampleColumns)
}

function columnAnchorScore(input: {
  column: string
  anchorKind: InvestigationEvidenceAnchorKind
  anchors: InvestigationEvidenceAnchor[]
  hint?: InvestigationDataFlowHint
  config: AnchorDiagnosticsConfig
}): number {
  const configuredPatterns = input.config.anchorColumnPatterns[input.anchorKind]
  const patternIndex = configuredPatterns.findIndex(pattern => pattern.test(input.column))
  const regexScore = patternIndex >= 0
    ? 1 + (configuredPatterns.length - patternIndex) / 100
    : 0
  if (input.anchorKind === 'member_identifier') {
    return regexScore
  }
  const fuzzyScore = input.config.fuzzyMatching.enabled
    ? Math.max(
      ...input.anchors.map(anchor => fuzzyColumnScore(
        input.column,
        columnHint(input.column, input.hint),
        anchor,
        input.anchorKind === 'config_key'
          ? input.config.fuzzyMatching.configThreshold
          : input.config.fuzzyMatching.threshold,
      )),
      fuzzyTextScore(input.column, input.anchorKind.replace(/_/g, ' ')),
    )
    : 0
  return Math.max(regexScore, fuzzyScore)
}

function fuzzyColumnScore(
  columnName: string,
  hint: InvestigationDataFlowColumnHint | undefined,
  anchor: InvestigationEvidenceAnchor,
  threshold: number,
): number {
  const candidateTexts = [
    columnName,
    hint?.name,
    hint?.propertyName,
  ].filter((value): value is string => Boolean(value))
  const anchorTexts = [
    anchor.label,
    anchor.kind.replace(/_/g, ' '),
    anchor.kind === 'config_key' || !anchor.sensitive ? anchor.value : undefined,
  ].filter((value): value is string => Boolean(value))
  const score = Math.max(
    ...candidateTexts.flatMap(candidate =>
      anchorTexts.map(anchorText => fuzzyTextScore(candidate, anchorText)),
    ),
  )
  return score >= threshold ? score : 0
}

function fuzzyTextScore(left: string, right: string): number {
  const normalizedLeft = normalizeFuzzyText(left)
  const normalizedRight = normalizeFuzzyText(right)
  if (!normalizedLeft || !normalizedRight) {
    return 0
  }
  if (normalizedLeft === normalizedRight) {
    return 1
  }
  if (
    normalizedLeft.length >= 4
    && normalizedRight.length >= 4
    && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft))
  ) {
    return 0.95
  }

  const leftTokens = expandTokens(normalizedLeft.split(' ').filter(Boolean))
  const rightTokens = expandTokens(normalizedRight.split(' ').filter(Boolean))
  const intersection = leftTokens.filter(token => rightTokens.includes(token)).length
  const tokenScore = Math.min(leftTokens.length, rightTokens.length) > 0
    ? intersection / Math.min(leftTokens.length, rightTokens.length)
    : 0
  const editScore = 1 - levenshtein(normalizedLeft, normalizedRight) / Math.max(normalizedLeft.length, normalizedRight.length)
  return Math.max(tokenScore, editScore)
}

function normalizeFuzzyText(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .trim()
    .toLowerCase()
}

function expandTokens(tokens: string[]): string[] {
  const synonyms: Record<string, string[]> = {
    allowed: ['supported', 'enabled'],
    supported: ['allowed', 'enabled'],
    enabled: ['allowed', 'supported'],
    no: ['number', 'id'],
    num: ['number', 'id'],
    number: ['no', 'num', 'id'],
    id: ['identifier', 'number', 'no'],
  }
  return Array.from(new Set(tokens.flatMap(token => [token, ...(synonyms[token] || [])])))
}

function levenshtein(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1),
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[right.length] ?? 0
}

function columnHint(columnName: string, hint: InvestigationDataFlowHint | undefined): InvestigationDataFlowColumnHint | undefined {
  return hint?.columns?.find(column =>
    column.name.toLowerCase() === columnName.toLowerCase()
    || column.propertyName?.toLowerCase() === columnName.toLowerCase(),
  )
}

function columnHintScore(columnName: string, hint: InvestigationDataFlowHint | undefined): number {
  return columnHint(columnName, hint) ? 1 : 0
}

function isConfigTable(tableName: string, config: AnchorDiagnosticsConfig): boolean {
  return config.configTablePatterns.some(pattern => pattern.test(tableName))
}

function isUnsafeSampleColumn(tableName: string, column: string, config: AnchorDiagnosticsConfig): boolean {
  return isConfiguredPhiColumn(column, tableName)
    || config.safeSampleColumns.denyPatterns.some(pattern => pattern.test(column))
}

function safeIdentifier(value: string): string | null {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ? value : null
}
