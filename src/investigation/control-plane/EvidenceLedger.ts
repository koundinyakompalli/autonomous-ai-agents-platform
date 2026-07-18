import type {
  InvestigationEvidenceArtifact,
  InvestigationEvidenceFact,
  InvestigationEvidenceFactType,
  InvestigationFinding,
  InvestigationRunRecord,
  InvestigationSymptomCluster,
} from '../types/investigation.js'
import { INVESTIGATION_EVIDENCE_FACT_TYPES } from '../types/investigation.js'

type EvidenceItem = InvestigationFinding | InvestigationEvidenceArtifact

export interface InvestigationEvidenceLedger {
  facts: InvestigationEvidenceFact[]
  symptomClusters: InvestigationSymptomCluster[]
}

/** Normalizes adapter facts into a provenance-preserving, PHI-safe working ledger. */
export function buildEvidenceLedger(
  run: InvestigationRunRecord,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): InvestigationEvidenceLedger {
  const items = [...findings, ...evidence]
  const validRefs = new Set(items.map(item => item.id))
  const facts = [
    ...items.flatMap(item => normalizeFacts(run, item, validRefs)),
    ...deriveAdapterFacts(run, items),
  ]
  const symptomClusters = collectSymptomClusters(items, facts, validRefs)
  return { facts: deduplicateFacts(facts), symptomClusters }
}

function deriveAdapterFacts(
  run: InvestigationRunRecord,
  items: EvidenceItem[],
): InvestigationEvidenceFact[] {
  const facts: InvestigationEvidenceFact[] = []
  const schemaKeys = new Set<string>()
  const codeMappingKeys = new Set<string>()
  for (const item of items) {
    for (const row of asRecordArray(asRecord(item.metadata).safeRows)) {
      if (asString(row.source_name) !== 'schema_width') continue
      const key = asString(row.scope_key)?.toLowerCase()
      if (key) schemaKeys.add(key)
    }
    for (const hint of asRecordArray(asRecord(item.metadata).dataFlowHints)) {
      const tableName = asString(hint.tableName)?.toLowerCase()
      if (!tableName) continue
      for (const column of asRecordArray(hint.columns)) {
        const columnName = asString(column.name)?.toLowerCase()
        if (columnName) codeMappingKeys.add(`${tableName}.${columnName}`)
      }
    }
  }

  for (const item of items) {
    const metadata = asRecord(item.metadata)
    const serialized = JSON.stringify(metadata)
    const runtimeColumns = new Set([
      ...asStringArray(metadata.failureColumns),
      ...asStringArray(metadata.runtimeFailureColumns),
    ].map(column => column.toLowerCase()))
    for (const match of `${item.title}\n${item.summary}\n${serialized}`.matchAll(
      /(?:data too long for column|value too long[^\n]{0,120}\bcolumn)\s+['"`]?([A-Za-z_][A-Za-z0-9_]*)/gi,
    )) {
      if (match[1]) runtimeColumns.add(match[1].toLowerCase())
    }
    for (const column of runtimeColumns) {
      const matchingKeys = Array.from(schemaKeys)
        .filter(key => key.split('.').pop() === column)
        .filter(key => codeMappingKeys.has(key))
      if (matchingKeys.length === 0) {
        facts.push(derivedFact(run, item, {
          type: 'runtime_failure',
          subject: `runtime-failure:${column}`,
          predicate: 'rejected an oversized value for',
          object: column,
          symptomClusterId: `persistence-column:${column}`,
        }))
      } else {
        for (const key of matchingKeys) {
          facts.push(derivedFact(run, item, {
            type: 'runtime_failure',
            subject: `runtime-failure:${column}`,
            predicate: 'is caused by a write to',
            object: `persisted-field:${key}`,
            symptomClusterId: `persistence-column:${column}`,
            chainIds: [`persistence-contract:${key}`],
          }))
        }
      }
    }

    for (const hint of asRecordArray(metadata.dataFlowHints)) {
      const tableName = asString(hint.tableName)
      if (!tableName) continue
      for (const column of asRecordArray(hint.columns)) {
        const columnName = asString(column.name)
        if (!columnName) continue
        facts.push(derivedFact(run, item, {
          type: 'code_relationship',
          subject: asString(hint.sourcePath) || asString(hint.sourceTerm) || item.id,
          predicate: 'maps to',
          object: `${tableName}.${columnName}`,
        }))
      }
    }

    for (const row of asRecordArray(metadata.safeRows)) {
      const sourceName = asString(row.source_name)
      if (sourceName === 'schema_width') {
        const scopeKey = asString(row.scope_key)
        const maxLength = asNumber(row.max_length)
        if (scopeKey && maxLength !== undefined) {
          facts.push(derivedFact(run, item, {
            type: 'schema_constraint',
            subject: `persisted-field:${scopeKey.toLowerCase()}`,
            predicate: 'is constrained by',
            object: `schema-limit:${scopeKey.toLowerCase()}:${maxLength}`,
            chainIds: [`persistence-contract:${scopeKey.toLowerCase()}`],
          }))
        }
      } else if (sourceName === 'member_identifier_match' && (asNumber(row.total_rows) || 0) > 0) {
        facts.push(derivedFact(run, item, {
          type: 'record_state',
          subject: 'ticket-identified-member',
          predicate: 'exists in the approved read-only target',
          value: true,
        }))
      }
    }

    for (const match of asRecordArray(metadata.matches)) {
      const file = asString(match.file)
      if (!file) continue
      facts.push(derivedFact(run, item, {
        type: 'configuration',
        subject: file,
        predicate: 'contains an effective configuration candidate',
        object: asStringArray(match.signals).join(', ') || undefined,
      }))
    }
  }
  return facts
}

function derivedFact(
  run: InvestigationRunRecord,
  item: EvidenceItem,
  fact: Pick<InvestigationEvidenceFact, 'type' | 'subject' | 'predicate'>
    & Partial<Pick<InvestigationEvidenceFact, 'object' | 'value' | 'unit' | 'symptomClusterId' | 'chainIds'>>,
): InvestigationEvidenceFact {
  return {
    id: `${item.id}-derived-${fact.type}-${factsafe(fact.subject)}-${factsafe(fact.object || String(fact.value ?? ''))}`,
    ...fact,
    confidence: 0.9,
    evidenceRefs: [item.id],
    provenance: {
      adapter: item.adapter,
      probeId: run.scope.planningContext?.activeProbeId,
      clientId: run.scope.clientId,
      environment: run.scope.environment,
      releaseVersion: run.scope.releaseVersion || run.scope.codeVersion,
      observedAt: run.updatedAt,
      sourceRef: item.id,
      redactionState: 'redacted',
    },
  }
}

function factsafe(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'fact'
}

function normalizeFacts(
  run: InvestigationRunRecord,
  item: EvidenceItem,
  validRefs: Set<string>,
): InvestigationEvidenceFact[] {
  const rawFacts = Array.isArray(item.metadata?.evidenceFacts) ? item.metadata.evidenceFacts : []
  return rawFacts.flatMap((raw, index) => {
    const record = asRecord(raw)
    const type = asString(record.type)
    const subject = asString(record.subject)
    const predicate = asString(record.predicate)
    if (!isFactType(type) || !subject || !predicate) return []
    const evidenceRefs = uniqueStrings([
      item.id,
      ...asStringArray(record.evidenceRefs).filter(ref => validRefs.has(ref)),
    ])
    const confidence = boundedConfidence(record.confidence)
    const redactionState = asString(record.redactionState)
    return [{
      id: asString(record.id) || `${item.id}-fact-${index + 1}`,
      type,
      subject,
      predicate,
      ...(asString(record.object) ? { object: asString(record.object) } : {}),
      ...(isFactValue(record.value) ? { value: record.value } : {}),
      ...(asString(record.unit) ? { unit: asString(record.unit) } : {}),
      ...(asString(record.symptomClusterId) ? { symptomClusterId: asString(record.symptomClusterId) } : {}),
      ...(asStringArray(record.chainIds).length ? { chainIds: asStringArray(record.chainIds) } : {}),
      confidence,
      evidenceRefs,
      provenance: {
        adapter: item.adapter,
        probeId: run.scope.planningContext?.activeProbeId,
        clientId: run.scope.clientId,
        environment: run.scope.environment,
        releaseVersion: run.scope.releaseVersion || run.scope.codeVersion,
        observedAt: asString(record.observedAt) || run.updatedAt,
        sourceRef: asString(record.sourceRef) || item.id,
        redactionState: redactionState === 'metadata_only' || redactionState === 'not_sensitive'
          ? redactionState
          : 'redacted',
      },
    }]
  })
}

function collectSymptomClusters(
  items: EvidenceItem[],
  facts: InvestigationEvidenceFact[],
  validRefs: Set<string>,
): InvestigationSymptomCluster[] {
  const clusters = new Map<string, InvestigationSymptomCluster>()
  for (const item of items) {
    const rawClusters = Array.isArray(item.metadata?.symptomClusters) ? item.metadata.symptomClusters : []
    for (const raw of rawClusters) {
      const record = asRecord(raw)
      const id = asString(record.id)
      if (!id) continue
      mergeCluster(clusters, {
        id,
        label: asString(record.label) || id,
        material: record.material !== false,
        evidenceRefs: uniqueStrings([
          item.id,
          ...asStringArray(record.evidenceRefs).filter(ref => validRefs.has(ref)),
        ]),
        explainedByChainIds: asStringArray(record.explainedByChainIds),
      })
    }
  }
  for (const fact of facts) {
    if (!fact.symptomClusterId || (fact.type !== 'symptom' && fact.type !== 'runtime_failure')) continue
    mergeCluster(clusters, {
      id: fact.symptomClusterId,
      label: fact.subject,
      material: true,
      evidenceRefs: fact.evidenceRefs,
      explainedByChainIds: fact.chainIds || [],
    })
  }
  return Array.from(clusters.values()).sort((left, right) => left.id.localeCompare(right.id))
}

function mergeCluster(
  clusters: Map<string, InvestigationSymptomCluster>,
  incoming: InvestigationSymptomCluster,
): void {
  const existing = clusters.get(incoming.id)
  clusters.set(incoming.id, existing
    ? {
        ...existing,
        material: existing.material || incoming.material,
        evidenceRefs: uniqueStrings([...existing.evidenceRefs, ...incoming.evidenceRefs]),
        explainedByChainIds: uniqueStrings([...existing.explainedByChainIds, ...incoming.explainedByChainIds]),
      }
    : incoming)
}

function deduplicateFacts(facts: InvestigationEvidenceFact[]): InvestigationEvidenceFact[] {
  const seen = new Set<string>()
  return facts.filter(fact => {
    const key = JSON.stringify([
      fact.type,
      fact.subject,
      fact.predicate,
      fact.object,
      fact.value,
      fact.symptomClusterId,
      fact.provenance.sourceRef,
    ])
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text || undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((entry): entry is string => Boolean(entry)) : []
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter(entry => Object.keys(entry).length > 0) : []
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function isFactType(value: string | undefined): value is InvestigationEvidenceFactType {
  return Boolean(value && INVESTIGATION_EVIDENCE_FACT_TYPES.includes(value as InvestigationEvidenceFactType))
}

function isFactValue(value: unknown): value is string | number | boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
}

function boundedConfidence(value: unknown): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.max(0, Math.min(parsed, 1)) : 1
}
