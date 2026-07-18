import type {
  InvestigationDataFlowHint,
  InvestigationEvidenceArtifact,
  InvestigationFinding,
  InvestigationScope,
} from '../types/investigation.js'
import {
  extractInvestigationSignals,
  extractPersistenceFailureColumns,
  redactInvestigationText,
} from '../utils/RuntimeEvidence.js'

export function enrichScopeWithDiagnosticEvidence(
  scope: InvestigationScope,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): InvestigationScope {
  const codeEvidence = evidence.filter(artifact => artifact.adapter === 'code')
  const codeFindings = findings.filter(finding => finding.adapter === 'code')
  const terms = new Set(scope.diagnosticContext?.codeEvidenceTerms || [])
  const paths = new Set(scope.diagnosticContext?.codeEvidencePaths || [])
  const previews = new Set(scope.diagnosticContext?.codeEvidencePreviews || [])
  const runtimeTerms = new Set(scope.diagnosticContext?.runtimeEvidenceTerms || [])
  const runtimePreviews = new Set(scope.diagnosticContext?.runtimeEvidencePreviews || [])
  const runtimeFailureColumns = new Set(scope.diagnosticContext?.runtimeFailureColumns || [])
  const dataFlowHints = new Map<string, InvestigationDataFlowHint>()

  for (const hint of scope.diagnosticContext?.dataFlowHints || []) {
    dataFlowHints.set(dataFlowHintKey(hint), hint)
  }

  for (const artifact of codeEvidence) {
    const metadata = asRecord(artifact.metadata)
    for (const term of asStringArray(metadata.terms)) {
      terms.add(term)
    }
    for (const hint of asDataFlowHints(metadata.dataFlowHints)) {
      dataFlowHints.set(dataFlowHintKey(hint), hint)
    }
    for (const hit of asRecordArray(metadata.hits)) {
      const path = asString(hit.path)
      const preview = asString(hit.preview)
      const term = asString(hit.term)
      if (path) paths.add(path)
      if (preview) previews.add(preview)
      if (term) terms.add(term)
    }
  }

  for (const finding of codeFindings) {
    const metadata = asRecord(finding.metadata)
    const strongestCandidate = asString(metadata.strongestCandidate)
    if (strongestCandidate) {
      paths.add(strongestCandidate)
    }
  }

  for (const item of [
    ...findings.filter(finding => finding.adapter === 'aws' || finding.adapter === 'host'),
    ...evidence.filter(artifact => artifact.adapter === 'aws' || artifact.adapter === 'host'),
  ]) {
    const metadata = asRecord(item.metadata)
    for (const serverlessFunction of asRecordArray(metadata.functions)) {
      for (const value of [
        asString(serverlessFunction.functionName),
        asString(serverlessFunction.handler),
      ]) {
        if (value) terms.add(value)
      }
      const artifact = asRecord(serverlessFunction.artifact)
      for (const value of [
        ...asStringArray(artifact.inspectedFiles),
        ...asStringArray(artifact.uncheckedGetReceivers),
      ]) {
        terms.add(value)
      }
    }
    const samples = [
      ...asRecordArray(metadata.redactedSamples),
      ...asRecordArray(metadata.samples),
      ...asRecordArray(metadata.matches),
    ]
    const runtimeText = [
      item.title,
      item.summary,
      ...asStringArray(metadata.runtimeSignals),
      ...asStringArray(metadata.signals),
      ...asStringArray(metadata.failureColumns),
      ...samples.flatMap(sample => [
        asString(sample.message),
        asString(sample.preview),
        ...asStringArray(sample.signals),
      ]),
    ].filter((entry): entry is string => Boolean(entry)).join('\n')

    for (const term of extractInvestigationSignals(runtimeText, 24)) runtimeTerms.add(term)
    for (const column of extractPersistenceFailureColumns(runtimeText, 16)) runtimeFailureColumns.add(column)
    for (const column of asStringArray(metadata.failureColumns)) runtimeFailureColumns.add(column.toLowerCase())
    for (const sample of samples) {
      const preview = redactInvestigationText(asString(sample.message) || asString(sample.preview) || '').trim()
      if (preview && isRuntimeFailurePreview(preview)) runtimePreviews.add(preview.slice(0, 600))
    }
  }

  if (
    terms.size === 0
    && paths.size === 0
    && previews.size === 0
    && runtimeTerms.size === 0
    && runtimePreviews.size === 0
    && runtimeFailureColumns.size === 0
    && dataFlowHints.size === 0
  ) {
    return scope
  }

  return {
    ...scope,
    diagnosticContext: {
      ...scope.diagnosticContext,
      codeEvidenceTerms: Array.from(terms).slice(0, 80),
      codeEvidencePaths: Array.from(paths).slice(0, 80),
      codeEvidencePreviews: Array.from(previews).slice(0, 40),
      runtimeEvidenceTerms: Array.from(runtimeTerms).slice(0, 80),
      runtimeEvidencePreviews: Array.from(runtimePreviews).slice(0, 40),
      runtimeFailureColumns: Array.from(runtimeFailureColumns).slice(0, 40),
      dataFlowHints: Array.from(dataFlowHints.values()).slice(0, 80),
    },
  }
}

function isRuntimeFailurePreview(value: string): boolean {
  return /\b(?:exception|error|failed|failure|timeout|data too long for column|value too long|string data right truncation|truncat|overflow|http\s*[45]\d\d)\b/i.test(value)
}

function dataFlowHintKey(hint: InvestigationDataFlowHint): string {
  return `${hint.sourceRepo}:${hint.sourcePath}:${hint.tableName}`.toLowerCase()
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter(entry => Object.keys(entry).length > 0) : []
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(asString).filter((entry): entry is string => Boolean(entry))
    : []
}

function asDataFlowHints(value: unknown): InvestigationDataFlowHint[] {
  return asRecordArray(value)
    .map((entry): InvestigationDataFlowHint | null => {
      const sourceRepo = asString(entry.sourceRepo)
      const sourcePath = asString(entry.sourcePath)
      const tableName = asString(entry.tableName)
      if (!sourceRepo || !sourcePath || !tableName) {
        return null
      }
      return {
        sourceRepo,
        sourcePath,
        sourceLine: typeof entry.sourceLine === 'number' ? entry.sourceLine : undefined,
        sourceTerm: asString(entry.sourceTerm),
        modelName: asString(entry.modelName),
        linkedFields: asStringArray(entry.linkedFields),
        provenance: entry.provenance === 'runtime_context'
          || entry.provenance === 'derived_reference'
          || entry.provenance === 'direct_field_match'
          ? entry.provenance
          : undefined,
        artifactType: entry.artifactType === 'hibernate_mapping'
          || entry.artifactType === 'sql_literal'
          || entry.artifactType === 'hql_literal'
          || entry.artifactType === 'config_reference'
          || entry.artifactType === 'unknown'
          ? entry.artifactType
          : 'unknown',
        tableName,
        columns: asRecordArray(entry.columns).map(column => ({
          name: asString(column.name) || '',
          propertyName: asString(column.propertyName),
        })).filter(column => Boolean(column.name)),
      }
    })
    .filter((entry): entry is InvestigationDataFlowHint => Boolean(entry))
}
