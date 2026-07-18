import type {
  InvestigationDataFlowHint,
  InvestigationQueryPack,
  InvestigationScope,
} from '../types/investigation.js'
import {
  extractTicketPayloadEvidence,
  normalizeObservedFieldName,
} from '../utils/TicketPayloadEvidence.js'

export const SCHEMA_COLUMN_CONSTRAINT_DIAGNOSTIC_ID = 'appcode_schema_column_constraint_check'
export const MEMBER_IDENTIFIER_AGGREGATE_DIAGNOSTIC_ID = 'appcode_member_identifier_aggregate_check'

const WORKFLOW_ROUTING_TABLES = new Set([
  'queue_authorization',
  'task_configuration',
  'queues',
  'adhok_business_process',
  'adhok_business_task',
  'process_flow',
])

const WORKFLOW_ROUTING_SIGNAL_TERMS = [
  'queueauthorization',
  'queue_authorization',
  'getappgroupbytaskname',
  'adhok_business_process',
  'adhokbusinessprocess',
  'adhok_business_task',
  'adhokbusinesstask',
  'process_flow',
  'processflow',
  'active_group',
  'activegroup',
]

export function planCodeDerivedDiagnostic(scope: InvestigationScope): InvestigationQueryPack | null {
  const schemaConstraint = planSchemaColumnConstraintDiagnostic(scope)
  if (schemaConstraint) {
    return schemaConstraint
  }
  const memberIdentifier = planMemberIdentifierAggregateDiagnostic(scope)
  if (memberIdentifier) {
    return memberIdentifier
  }
  const workflowRouting = planWorkflowQueueRoutingDiagnostic(scope)
  if (workflowRouting) {
    return workflowRouting
  }
  return null
}

export function planSchemaColumnConstraintDiagnostic(scope: InvestigationScope): InvestigationQueryPack | null {
  const text = diagnosticSearchText(scope)
  const hasRuntimeWidthViolation = /\b(?:data too long for column|value too long|string data right truncation|data truncation|mysqldatatruncation)\b/i.test(text)
  const payloadEvidence = extractTicketPayloadEvidence(scope.ticketContext)
  if (!hasRuntimeWidthViolation && payloadEvidence.observedFieldLengths.length === 0) {
    return null
  }

  const failureColumns = extractTruncatedColumns(text)
  if (hasRuntimeWidthViolation && failureColumns.length === 0) {
    return null
  }

  const observedLengths = new Map<string, number>()
  const observedPathLengths = new Map<string, number>()
  for (const observation of payloadEvidence.observedFieldLengths) {
    const key = normalizeObservedFieldName(observation.fieldName)
    observedLengths.set(key, Math.max(observedLengths.get(key) || 0, observation.length))
    const pathKey = normalizeObservedFieldName(observation.path)
    if (pathKey) {
      observedPathLengths.set(pathKey, Math.max(observedPathLengths.get(pathKey) || 0, observation.length))
      observedLengths.set(pathKey, Math.max(observedLengths.get(pathKey) || 0, observation.length))
    }
  }

  const allCandidatePairs = (scope.diagnosticContext?.dataFlowHints || [])
    .flatMap(hint => {
      if (!isCausallyLinkedMapping(hint)) {
        return []
      }
      const tableName = normalizeIdentifier(hint.tableName)
      if (!tableName) {
        return []
      }
      return (hint.columns || [])
        .map(column => {
          const columnName = normalizeIdentifier(column.name)
          if (!columnName) return null
          const propertyKey = normalizeObservedFieldName(column.propertyName || '')
          const columnKey = normalizeObservedFieldName(column.name)
          // A model-level hint may contain fields for many columns. Reusing it
          // for an unlinked column creates false payload-to-schema relationships.
          const linkedFieldKeys = new Set(
            (column.linkedFields || []).map(normalizeObservedFieldName),
          )
          if (
            hint.provenance
            && (linkedFieldKeys.size === 0 || (!linkedFieldKeys.has(propertyKey) && !linkedFieldKeys.has(columnKey)))
          ) return null
          const observedLength = Math.max(
            observedLengths.get(propertyKey) || 0,
            observedLengths.get(columnKey) || 0,
            ...Array.from(linkedFieldKeys).map(key => observedLengths.get(key) || 0),
            ...Array.from(linkedFieldKeys).flatMap(key =>
              Array.from(observedPathLengths)
                .filter(([pathKey]) => pathKey.endsWith(key))
                .map(([, length]) => length),
            ),
          ) || undefined
          const observedPath = Array.from(observedPathLengths)
            .map(([pathKey, length]) => ({
              pathKey,
              length,
              score: Array.from(linkedFieldKeys).reduce((score, key) => Math.max(
                score,
                pathKey === key ? 1_000 + key.length : pathKey.endsWith(key) ? 100 + key.length : 0,
              ), 0),
            }))
            .filter(candidate => candidate.score > 0)
            .sort((left, right) => right.score - left.score || right.length - left.length)[0]?.pathKey
          if (hasRuntimeWidthViolation && !failureColumns.includes(columnName)) return null
          if (!hasRuntimeWidthViolation && observedLength === undefined) return null
          const pathMatchScore = Array.from(linkedFieldKeys).reduce((score, key) => Math.max(
            score,
            ...Array.from(observedPathLengths.keys()).map(pathKey =>
              pathKey === key ? 1_000 + key.length : pathKey.endsWith(key) ? 100 + key.length : 0,
            ),
          ), 0)
          return { tableName, columnName, observedLength, observedPath, pathMatchScore }
        })
        .filter((pair): pair is NonNullable<typeof pair> => pair !== null)
    })
  const candidatePairs = allCandidatePairs.filter((pair, index, pairs) => {
    const matching = pairs.filter(candidate =>
      candidate.tableName === pair.tableName && candidate.columnName === pair.columnName)
    const bestScore = Math.max(...matching.map(candidate => candidate.pathMatchScore))
    return pair.pathMatchScore === bestScore
      && pairs.findIndex(candidate =>
        candidate.tableName === pair.tableName
        && candidate.columnName === pair.columnName
        && candidate.pathMatchScore === bestScore,
      ) === index
  })
  const hintedPairs = candidatePairs
    .filter(pair => pair.pathMatchScore === Math.max(
      ...candidatePairs
        .filter(candidate => candidate.columnName === pair.columnName)
        .map(candidate => candidate.pathMatchScore),
    ))
    .slice(0, 12)

  if (!hasRuntimeWidthViolation && hintedPairs.length === 0) {
    return null
  }

  const predicate = hintedPairs.length > 0
    ? hintedPairs
      .map(pair => `(table_name = ${sqlStringLiteral(pair.tableName)} AND column_name = ${sqlStringLiteral(pair.columnName)})`)
      .join(' OR ')
    : `column_name IN (${failureColumns.map(sqlStringLiteral).join(', ')})`
  const observedLengthExpression = hintedPairs.some(pair => pair.observedLength !== undefined)
    ? [
        '  CASE',
        ...hintedPairs
          .filter(pair => pair.observedLength !== undefined)
          .map(pair => `    WHEN table_name = ${sqlStringLiteral(pair.tableName)} AND column_name = ${sqlStringLiteral(pair.columnName)} THEN ${pair.observedLength}`),
        '    ELSE NULL',
        '  END AS observed_length,',
      ]
    : ['  NULL AS observed_length,']
  const observedPathExpression = hintedPairs.some(pair => pair.observedPath)
    ? [
        '  CASE',
        ...hintedPairs
          .filter(pair => pair.observedPath)
          .map(pair => `    WHEN table_name = ${sqlStringLiteral(pair.tableName)} AND column_name = ${sqlStringLiteral(pair.columnName)} THEN ${sqlStringLiteral(pair.observedPath as string)}`),
        '    ELSE NULL',
        '  END AS observed_path,',
      ]
    : ['  NULL AS observed_path,']
  const schemaSelect = [
    'SELECT',
    "  'schema_width' AS source_name,",
    "  CONCAT(table_name, '.', column_name) AS scope_key,",
    ...observedLengthExpression,
    ...observedPathExpression,
    '  CAST(character_maximum_length AS CHAR) AS max_length,',
    '  data_type,',
    '  is_nullable,',
    '  NULL AS total_rows,',
    '  NULL AS enabled_rows,',
    '  NULL AS disabled_or_null_rows,',
    '  NULL AS latest_update_at',
    'FROM information_schema.columns',
    'WHERE table_schema = DATABASE()',
    `  AND (${predicate})`,
  ].join('\n')

  return {
    id: SCHEMA_COLUMN_CONSTRAINT_DIAGNOSTIC_ID,
    description: 'Code-derived schema constraint and sensitive-anchor aggregate diagnostic.',
    environments: [scope.environment],
    allowedTables: ['information_schema.columns'],
    parameterNames: [
      'runtime_failure_columns',
      'attachment_field_lengths',
      'code_derived_table_columns',
    ],
    sql: [schemaSelect, 'LIMIT 100'].join('\n'),
    maxRows: 100,
    timeoutMs: 10_000,
    redactionTags: [
      'application_code_derived',
      'schema_only',
      'aggregate_only',
      'no_phi_output',
    ],
  }
}

interface MemberIdentifierAggregateSelect {
  tableName: string
  sql: string
}

export function planMemberIdentifierAggregateDiagnostic(
  scope: InvestigationScope,
): InvestigationQueryPack | null {
  const selects = buildMemberIdentifierAggregateSelects(scope)
  if (selects.length === 0) {
    return null
  }
  return {
    id: MEMBER_IDENTIFIER_AGGREGATE_DIAGNOSTIC_ID,
    description: 'Aggregate-only member identifier diagnostic derived from ticket anchors and code mappings.',
    environments: [scope.environment],
    allowedTables: Array.from(new Set(selects.map(select => select.tableName))),
    parameterNames: ['ticket_member_identifiers', 'code_derived_member_columns'],
    sql: [
      selects.map(select => select.sql).join('\nUNION ALL\n'),
      'LIMIT 100',
    ].join('\n'),
    maxRows: 100,
    timeoutMs: 10_000,
    redactionTags: ['application_code_derived', 'aggregate_only', 'no_phi_output'],
  }
}

function buildMemberIdentifierAggregateSelects(
  scope: InvestigationScope,
): MemberIdentifierAggregateSelect[] {
  const values = memberIdentifierValues(scope)
  if (values.length === 0) {
    return []
  }
  const valueList = values.map(sqlStringLiteral).join(', ')
  const pairs = (scope.diagnosticContext?.dataFlowHints || [])
    .flatMap(hint => {
      const tableName = normalizeIdentifier(hint.tableName)
      if (!tableName) return []
      return (hint.columns || [])
        .map(column => {
          const columnName = normalizeIdentifier(column.name)
          const propertyName = normalizeObservedFieldName(column.propertyName || '')
          if (!columnName || !isMemberIdentifierColumn(columnName, propertyName)) return null
          return { tableName, columnName }
        })
        .filter((pair): pair is { tableName: string; columnName: string } => Boolean(pair))
    })
    .filter((pair, index, all) => all.findIndex(candidate =>
      candidate.tableName === pair.tableName && candidate.columnName === pair.columnName,
    ) === index)
    .sort((left, right) => memberColumnRank(left.columnName) - memberColumnRank(right.columnName))
    .slice(0, 12)

  return pairs.map(pair => ({
    tableName: pair.tableName,
    sql: [
      'SELECT',
      "  'member_identifier_match' AS source_name,",
      `  ${sqlStringLiteral(`${pair.tableName}.${pair.columnName}`)} AS scope_key,`,
      '  NULL AS observed_length,',
      '  NULL AS max_length,',
      '  NULL AS data_type,',
      '  NULL AS is_nullable,',
      '  CAST(COUNT(*) AS CHAR) AS total_rows,',
      '  NULL AS enabled_rows,',
      '  NULL AS disabled_or_null_rows,',
      '  NULL AS latest_update_at',
      `FROM ${pair.tableName}`,
      `WHERE ${pair.columnName} IN (${valueList})`,
    ].join('\n'),
  }))
}

function memberIdentifierValues(scope: InvestigationScope): string[] {
  const values = new Set<string>()
  const candidates = [
    ...(scope.ticketContext?.identifiers || [])
      .filter(identifier => identifier.kind === 'member_identifier')
      .map(identifier => identifier.value),
    ...(scope.evidenceAnchors || [])
      .filter(anchor => anchor.kind === 'member_identifier')
      .map(anchor => anchor.value),
    ...(scope.ticketContext?.evidenceAnchors || [])
      .filter(anchor => anchor.kind === 'member_identifier')
      .map(anchor => anchor.value),
  ]
  for (const candidate of candidates) {
    const value = candidate.trim()
    if (!/^(?=[A-Za-z0-9/-]*\d)[A-Za-z0-9]{4,30}(?:[-/][A-Za-z0-9]{1,10})?$/.test(value)) {
      continue
    }
    values.add(value)
    if (/[-/]/.test(value)) {
      values.add(value.split(/[-/]/)[0] || value)
    }
    if (values.size >= 10) break
  }
  return Array.from(values).slice(0, 10)
}

function isMemberIdentifierColumn(columnName: string, propertyName: string): boolean {
  const candidates = [columnName, propertyName].filter(Boolean)
  return candidates.some(candidate =>
    /^(?:member|subscriber|person|patient)(?:_?(?:ext|external))?_?(?:id|no|num|number)$/.test(candidate),
  )
}

function memberColumnRank(columnName: string): number {
  if (/(?:ext|external)/.test(columnName)) return 0
  if (/(?:subscriber|person|patient)/.test(columnName)) return 1
  return 2
}

function isCausallyLinkedMapping(hint: InvestigationDataFlowHint): boolean {
  if (!hint.provenance) {
    return true
  }
  if (hint.artifactType !== 'hibernate_mapping') {
    return hint.provenance !== 'direct_field_match'
  }
  if (
    hint.provenance !== 'derived_reference'
    || !hint.sourceTerm
    || !hint.modelName
    || !hint.linkedFields?.length
  ) {
    return false
  }
  return normalizedLinkKey(hint.sourceTerm) === normalizedLinkKey(hint.modelName)
}

function normalizedLinkKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function extractTruncatedColumns(text: string): string[] {
  const columns = new Set<string>()
  const patterns = [
    /data too long for column\s+['"`]?([A-Za-z_][A-Za-z0-9_]*)/gi,
    /value too long[^\n]{0,120}\bcolumn\s+['"`]?([A-Za-z_][A-Za-z0-9_]*)/gi,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const column = normalizeIdentifier(match[1] || '')
      if (column) {
        columns.add(column)
      }
    }
  }
  return Array.from(columns).slice(0, 12)
}

export function planWorkflowQueueRoutingDiagnostic(scope: InvestigationScope): InvestigationQueryPack | null {
  if (!hasWorkflowRoutingSignals(scope)) {
    return null
  }

  const processNames = deriveWorkflowProcessNames(scope)
  if (processNames.length === 0) {
    return null
  }

  const processNameSqlList = processNames.map(sqlStringLiteral).join(', ')
  return {
    id: 'appcode_workflow_queue_routing',
    description: 'Code-derived workflow queue-routing diagnostic from QueueAuthorization/task routing evidence.',
    environments: [scope.environment],
    allowedTables: Array.from(WORKFLOW_ROUTING_TABLES),
    parameterNames: ['workflow_process_names', 'window_start'],
    sql: buildWorkflowQueueRoutingSql(processNameSqlList),
    maxRows: 100,
    timeoutMs: 20_000,
    redactionTags: ['application_code_derived', 'config_only', 'aggregate_only'],
  }
}

function hasWorkflowRoutingSignals(scope: InvestigationScope): boolean {
  const tables = new Set(
    (scope.diagnosticContext?.dataFlowHints || [])
      .map(hint => normalizeIdentifier(hint.tableName))
      .filter((value): value is string => Boolean(value)),
  )
  const text = diagnosticSearchText(scope)
  const hasQueueAuthorization =
    tables.has('queue_authorization')
    || /(?:^|[^a-z0-9])(?:queueauthorization|queue_authorization)(?=$|[^a-z0-9])/i.test(text)
  const hasWorkflowTaskTable =
    tables.has('adhok_business_task')
    || tables.has('process_flow')
    || tables.has('adhok_business_process')
    || /(?:^|[^a-z0-9])(?:adhok_business_task|adhokbusinesstask|process_flow|processflow|adhok_business_process|adhokbusinessprocess|active_group|activegroup)(?=$|[^a-z0-9])/i.test(text)
  const ticketWorkflowText = [
    scope.ticketContext?.title,
    scope.ticketContext?.description,
    ...(scope.ticketContext?.comments || []).map(comment => comment.body),
  ].filter((entry): entry is string => Boolean(entry?.trim())).join('\n')
  const hasWorkflowTicketSignal = /\b(?:queue|routing|route|assigned|assignment|portlet|unassigned|task|subtask|workflow)\b/i.test(ticketWorkflowText)

  return hasQueueAuthorization && hasWorkflowTaskTable && hasWorkflowTicketSignal
}

function deriveWorkflowProcessNames(scope: InvestigationScope): string[] {
  const text = [
    scope.ticketContext?.title,
    scope.ticketContext?.description,
    ...(scope.ticketContext?.comments || []).map(comment => comment.body),
    ...(scope.ticketContext?.extractedTerms || []),
    ...(scope.keywords || []),
    ...(scope.diagnosticContext?.codeEvidenceTerms || []),
    ...(scope.diagnosticContext?.codeEvidencePreviews || []),
  ].filter((entry): entry is string => Boolean(entry?.trim())).join('\n')

  const candidates = new Set<string>()
  for (const match of text.matchAll(/\b([A-Z][A-Za-z0-9&'/-]*(?:\s+[A-Z][A-Za-z0-9&'/-]*){0,4}\s+Review)\b/g)) {
    addProcessCandidate(candidates, match[1])
  }
  for (const match of text.matchAll(/\b([A-Z]{2,8})(?:\s+(?:task|subtask|review|queue|portlet)|\b)/g)) {
    const acronym = match[1]
    if (!acronym || COMMON_ACRONYM_STOP_WORDS.has(acronym)) {
      continue
    }
    addProcessCandidate(candidates, acronym)
    addProcessCandidate(candidates, `${acronym} Review`)
  }

  return Array.from(candidates)
    .filter(candidate => candidate.length <= 80 && !/\b(?:PROD|UAT|DEV|INT|STAGE|INC|CPSUP)\b/i.test(candidate))
    .slice(0, 12)
}

const COMMON_ACRONYM_STOP_WORDS = new Set([
  'API',
  'AWS',
  'CPU',
  'DB',
  'ID',
  'INC',
  'JIRA',
  'LLM',
  'MHK',
  'PII',
  'PHI',
  'PROD',
  'RCA',
  'SQL',
  'TTL',
  'UAT',
  'UI',
])

function addProcessCandidate(candidates: Set<string>, value: string | undefined): void {
  const normalized = value
    ?.replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .trim()
  if (!normalized || normalized.length < 2 || /\d{4,}/.test(normalized)) {
    return
  }
  candidates.add(normalized)
}

function buildWorkflowQueueRoutingSql(processNameSqlList: string): string {
  return [
    'SELECT',
    "  'current_config' AS source_name,",
    "  CONCAT(abp.description, ' -> ', COALESCE(q.GROUP_ID, '[NO QUEUE]')) AS scope_key,",
    '  CAST(COUNT(qa.id) AS CHAR) AS total_rows,',
    '  CAST(SUM(CASE WHEN qa.id IS NOT NULL AND COALESCE(qa.inactive, 0) = 0 AND COALESCE(qa.default_group, 0) = 0 THEN 1 ELSE 0 END) AS CHAR) AS enabled_rows,',
    '  CAST(SUM(CASE WHEN qa.id IS NULL OR COALESCE(qa.inactive, 0) <> 0 OR COALESCE(qa.default_group, 0) <> 0 THEN 1 ELSE 0 END) AS CHAR) AS disabled_or_null_rows,',
    '  CAST(MAX(COALESCE(qa.update_datetime, qa.insert_datetime, abp.update_datetime, abp.insert_datetime)) AS CHAR) AS latest_update_at',
    'FROM adhok_business_process abp',
    'LEFT JOIN queue_authorization qa ON qa.adhok_business_process_id = abp.ID',
    'LEFT JOIN task_configuration tc ON tc.id = qa.task_configuration_id',
    'LEFT JOIN queues q ON q.ID = qa.group_id',
    `WHERE abp.description IN (${processNameSqlList})`,
    "  AND (tc.task_name = 'open' OR tc.id IS NULL)",
    'GROUP BY abp.ID, abp.description, q.GROUP_ID',
    'UNION ALL',
    'SELECT',
    "  'open_task_routing' AS source_name,",
    "  CONCAT(abp.description, ' -> ', COALESCE(pf.active_group, '[NULL]'), ' expected=', COALESCE(expected.expected_groups, '[NONE]')) AS scope_key,",
    '  CAST(COUNT(*) AS CHAR) AS total_rows,',
    '  CAST(SUM(CASE WHEN expected.expected_groups IS NOT NULL AND pf.active_group IS NOT NULL AND FIND_IN_SET(pf.active_group, expected.expected_groups) > 0 THEN 1 ELSE 0 END) AS CHAR) AS enabled_rows,',
    '  CAST(SUM(CASE WHEN expected.expected_groups IS NULL OR pf.active_group IS NULL OR FIND_IN_SET(pf.active_group, expected.expected_groups) = 0 THEN 1 ELSE 0 END) AS CHAR) AS disabled_or_null_rows,',
    '  CAST(MAX(abt.insert_datetime) AS CHAR) AS latest_update_at',
    'FROM adhok_business_task abt',
    'JOIN adhok_business_process abp ON abp.ID = abt.fcontext',
    'LEFT JOIN process_flow pf ON pf.ID = abt.process_flow_id',
    'LEFT JOIN (',
    '  SELECT qa_expected.adhok_business_process_id AS process_id, GROUP_CONCAT(DISTINCT q_expected.GROUP_ID ORDER BY q_expected.GROUP_ID) AS expected_groups',
    '  FROM queue_authorization qa_expected',
    '  LEFT JOIN task_configuration tc_expected ON tc_expected.id = qa_expected.task_configuration_id',
    '  LEFT JOIN queues q_expected ON q_expected.ID = qa_expected.group_id',
    '  WHERE COALESCE(qa_expected.inactive, 0) = 0',
    '    AND COALESCE(qa_expected.default_group, 0) = 0',
    "    AND (tc_expected.task_name = 'open' OR tc_expected.id IS NULL)",
    '  GROUP BY qa_expected.adhok_business_process_id',
    ') expected ON expected.process_id = abp.ID',
    `WHERE abp.description IN (${processNameSqlList})`,
    "  AND abt.insert_datetime >= '__WINDOW_START__'",
    '  AND abt.complete_datetime IS NULL',
    'GROUP BY abp.ID, abp.description, pf.active_group, expected.expected_groups',
    'LIMIT 100',
  ].join('\n')
}

function diagnosticSearchText(scope: InvestigationScope): string {
  return [
    scope.clientId,
    scope.environment,
    ...(scope.serviceIds || []),
    ...(scope.keywords || []),
    ...(scope.repoNames || []),
    scope.ticketContext?.title,
    scope.ticketContext?.description,
    ...(scope.ticketContext?.comments || []).map(comment => comment.body),
    ...(scope.ticketContext?.extractedTerms || []),
    ...(scope.ticketContext?.attachments || []).flatMap(attachment => [
      attachment.filename,
      attachment.textExcerpt,
      ...(attachment.extractedTerms || []),
    ]),
    ...(scope.diagnosticContext?.codeEvidenceTerms || []),
    ...(scope.diagnosticContext?.codeEvidencePaths || []),
    ...(scope.diagnosticContext?.codeEvidencePreviews || []),
    ...(scope.diagnosticContext?.runtimeEvidenceTerms || []),
    ...(scope.diagnosticContext?.runtimeEvidencePreviews || []),
    ...(scope.diagnosticContext?.runtimeFailureColumns || []),
    ...(scope.diagnosticContext?.dataFlowHints || []).flatMap(hint => [
      hint.tableName,
      hint.sourcePath,
      ...(hint.columns || []).flatMap(column => [column.name, column.propertyName]),
    ]),
  ].filter((entry): entry is string => Boolean(entry?.trim())).join('\n')
}

function normalizeIdentifier(value: string): string | null {
  const normalized = value.trim().toLowerCase()
  return /^[a-z_][a-z0-9_]*$/.test(normalized) ? normalized : null
}

function sqlStringLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
