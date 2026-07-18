import type {
  InvestigationEvidenceFact,
  InvestigationEvidenceArtifact,
  InvestigationFinding,
  InvestigationRunRecord,
  InvestigationSymptomCluster,
} from '../types/investigation.js'
import { buildEvidenceLedger } from './EvidenceLedger.js'

export const RCA_DIMENSIONS = [
  'failure',
  'impacted_scope',
  'unaffected_scope',
  'trigger',
  'mechanism',
  'proof',
  'recovery',
  'prevention',
] as const

export const RCA_DIAGNOSIS_DIMENSIONS = [
  'failure',
  'impacted_scope',
  'unaffected_scope',
  'trigger',
  'mechanism',
  'proof',
] as const

export const RCA_CLOSURE_DIMENSIONS = ['recovery', 'prevention'] as const

export type RcaDimension = (typeof RCA_DIMENSIONS)[number]
export type RcaEvidencePolarity = 'supports' | 'contradicts' | 'rules_out'

export interface InvestigationRcaContribution {
  dimension: RcaDimension
  summary: string
  evidenceRefs: string[]
  confidence?: number
}

export interface InvestigationRcaLink {
  chainId: string
  hypothesis: string
  from: string
  relation: string
  to: string
  dimensions: RcaDimension[]
  summary: string
  evidenceRefs: string[]
  confidence?: number
  polarity?: RcaEvidencePolarity
  causalRoles?: RcaCausalRoles
  precisionRequired?: boolean
}

export interface RcaCausalRoles {
  component?: string
  trigger?: string
  operation?: string
  error?: string
  failureHandling?: string
  impact?: string
}

export interface RcaCausalFinding extends RcaCausalRoles {
  chainId: string
  hypothesis: string
  statement: string
  evidenceRefs: string[]
  precisionComplete: boolean
  missingRoles: Array<keyof Pick<RcaCausalRoles, 'component' | 'trigger' | 'operation' | 'error' | 'impact'>>
}

export interface RcaDimensionAssessment {
  dimension: RcaDimension
  label: string
  complete: boolean
  summary: string
  evidenceRefs: string[]
}

export interface RcaHypothesisAssessment {
  chainId: string
  hypothesis: string
  connected: boolean
  dimensions: RcaDimension[]
  evidenceRefs: string[]
  supportingLinks: number
  rulingOutLinks: number
  contradictingLinks: number
  nodeIds: string[]
  symptomClusterIds: string[]
}

export interface RcaCompletenessAssessment {
  /** Backward-compatible closure flag. Automated investigation uses diagnosisReady. */
  complete: boolean
  diagnosisReady: boolean
  operationallyClosed: boolean
  score: number
  dimensions: RcaDimensionAssessment[]
  missingDimensions: RcaDimension[]
  missingDiagnosisDimensions: RcaDimension[]
  missingClosureDimensions: RcaDimension[]
  leadingHypothesis?: RcaHypothesisAssessment
  selectedHypotheses: RcaHypothesisAssessment[]
  hypotheses: RcaHypothesisAssessment[]
  symptomClusters: InvestigationSymptomCluster[]
  unexplainedSymptomClusterIds: string[]
  ambiguousSymptomClusterIds: string[]
  causalFindings: RcaCausalFinding[]
  primaryCausalFinding?: RcaCausalFinding
  precisionIncompleteChainIds: string[]
  summary: string
}

const DIMENSION_LABELS: Record<RcaDimension, string> = {
  failure: 'What failed and at which layer?',
  impacted_scope: 'Who or what was affected?',
  unaffected_scope: 'What was not affected or was ruled out?',
  trigger: 'What condition or change preceded the failure?',
  mechanism: 'Why did the condition cause the symptom?',
  proof: 'What comparison proves the mechanism?',
  recovery: 'What restored service?',
  prevention: 'What prevents recurrence?',
}

interface EvidenceLink extends InvestigationRcaLink {
  sourceId: string
}

interface UnlinkedContribution {
  summary: string
  evidenceRefs: string[]
}

export class RcaCompletenessEvaluator {
  evaluate(
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
  ): RcaCompletenessAssessment {
    const items = [...findings, ...evidence]
    const validRefs = new Set(items.map(item => item.id))
    const ledger = buildEvidenceLedger(run, findings, evidence)
    const links = this.collectStructuredLinks(run, items, validRefs)
    links.push(...this.schemaConstraintLinks(run, findings, evidence))
    links.push(...this.factLinks(ledger.facts))
    const unlinked = this.collectUnlinkedContext(run, findings, evidence)
    const hypotheses = this.assessHypotheses(links)
    const leadingHypothesis = hypotheses[0]
    const selectedHypotheses = selectCausalSet(hypotheses, ledger.symptomClusters)
    const causalFindings = synthesizeCausalFindings(selectedHypotheses, links)
    const primaryCausalFinding = causalFindings[0]
    const precisionRequiredChainIds = new Set(links.filter(link => link.precisionRequired).map(link => link.chainId))
    const precisionIncompleteChainIds = selectedHypotheses
      .filter(hypothesis => precisionRequiredChainIds.has(hypothesis.chainId))
      .filter(hypothesis => !causalFindings.find(finding => finding.chainId === hypothesis.chainId)?.precisionComplete)
      .map(hypothesis => hypothesis.chainId)
    const selectedChainIds = new Set(selectedHypotheses.map(hypothesis => hypothesis.chainId))
    const covered = new Set(selectedHypotheses.flatMap(hypothesis => hypothesis.dimensions))
    const unexplainedSymptomClusterIds = ledger.symptomClusters
      .filter(cluster => cluster.material)
      .filter(cluster => !cluster.explainedByChainIds.some(chainId => selectedChainIds.has(chainId)))
      .map(cluster => cluster.id)
    const ambiguousSymptomClusterIds = Array.from(new Set([
      ...ledger.symptomClusters
      .filter(cluster => cluster.material)
      .filter(cluster => hypotheses.filter(hypothesis =>
        hypothesis.connected
        && hypothesis.contradictingLinks === 0
        && cluster.explainedByChainIds.includes(hypothesis.chainId)
        && ['failure', 'impacted_scope', 'trigger', 'mechanism', 'proof']
          .every(dimension => hypothesis.dimensions.includes(dimension as RcaDimension)),
      ).length > 1)
      .map(cluster => cluster.id),
      ...payloadFieldAmbiguities(evidence, hypotheses),
    ]))

    const dimensions = RCA_DIMENSIONS.map((dimension): RcaDimensionAssessment => {
      const linked = links.filter(link =>
        selectedChainIds.has(link.chainId)
        && link.polarity !== 'contradicts'
        && link.dimensions.includes(dimension),
      )
      const contextual = unlinked.get(dimension) || []
      const linkedSummaries = linked.map(link => link.summary)
      const summaries = linkedSummaries.length > 0
        ? linkedSummaries
        : contextual.map(entry => entry.summary)
      const evidenceRefs = Array.from(new Set(
        (linked.length > 0 ? linked.flatMap(link => link.evidenceRefs) : contextual.flatMap(entry => entry.evidenceRefs)),
      ))
      return {
        dimension,
        label: DIMENSION_LABELS[dimension],
        complete: Boolean(selectedHypotheses.length > 0 && covered.has(dimension)),
        summary: summaries.join(' ').slice(0, 1_200),
        evidenceRefs,
      }
    })

    const missingDimensions = dimensions.filter(entry => !entry.complete).map(entry => entry.dimension)
    const missingDiagnosisDimensions = RCA_DIAGNOSIS_DIMENSIONS.filter(dimension => !covered.has(dimension))
    const missingClosureDimensions = RCA_CLOSURE_DIMENSIONS.filter(dimension => !covered.has(dimension))
    const diagnosisReady = Boolean(
      selectedHypotheses.length > 0
      && selectedHypotheses.every(hypothesis => hypothesis.connected && hypothesis.contradictingLinks === 0)
      && missingDiagnosisDimensions.length === 0
      && unexplainedSymptomClusterIds.length === 0
      && ambiguousSymptomClusterIds.length === 0
      && precisionIncompleteChainIds.length === 0
    )
    const operationallyClosed = diagnosisReady && missingClosureDimensions.length === 0
    const score = Number(((RCA_DIMENSIONS.length - missingDimensions.length) / RCA_DIMENSIONS.length).toFixed(2))

    return {
      complete: operationallyClosed,
      diagnosisReady,
      operationallyClosed,
      score,
      dimensions,
      missingDimensions,
      missingDiagnosisDimensions,
      missingClosureDimensions,
      leadingHypothesis,
      selectedHypotheses,
      hypotheses,
      symptomClusters: ledger.symptomClusters,
      unexplainedSymptomClusterIds,
      ambiguousSymptomClusterIds,
      causalFindings,
      primaryCausalFinding,
      precisionIncompleteChainIds,
      summary: operationallyClosed
        ? `${primaryCausalFinding?.statement || 'The causal diagnosis is supported by the selected connected evidence graph set.'} Operational recovery and prevention are verified.`
        : diagnosisReady
          ? `${primaryCausalFinding?.statement || 'Causal diagnosis is supported.'} Operational closure still requires ${missingClosureDimensions.map(dimension => DIMENSION_LABELS[dimension]).join(' ')}`
          : `Diagnosis is not ready; ${[
              missingDiagnosisDimensions.length
                ? `missing linked evidence for ${missingDiagnosisDimensions.map(dimension => DIMENSION_LABELS[dimension]).join(' ')}`
                : '',
              unexplainedSymptomClusterIds.length
                ? `unexplained material symptom clusters: ${unexplainedSymptomClusterIds.join(', ')}`
                : '',
              ambiguousSymptomClusterIds.length
                ? `ambiguous material symptom clusters: ${ambiguousSymptomClusterIds.join(', ')}`
                : '',
              precisionIncompleteChainIds.length
                ? `mechanism-level causal roles are incomplete for: ${precisionIncompleteChainIds.join(', ')}`
                : '',
            ].filter(Boolean).join(' ')}`,
    }
  }

  private factLinks(facts: InvestigationEvidenceFact[]): EvidenceLink[] {
    return facts.flatMap(fact => (fact.chainIds || []).map(chainId => ({
      chainId,
      hypothesis: `Evidence chain ${chainId}`,
      from: fact.subject,
      relation: fact.predicate,
      to: fact.object || `${fact.subject}:${String(fact.value ?? fact.type)}`,
      dimensions: factDimensions(fact),
      summary: `${fact.subject} ${fact.predicate} ${fact.object || String(fact.value ?? '')}`.trim(),
      evidenceRefs: fact.evidenceRefs,
      confidence: fact.confidence,
      polarity: 'supports' as const,
      causalRoles: undefined,
      precisionRequired: false,
      sourceId: fact.evidenceRefs[0] || fact.provenance.sourceRef,
    })).filter(link => link.dimensions.length > 0))
  }

  private collectStructuredLinks(
    run: InvestigationRunRecord,
    items: Array<InvestigationFinding | InvestigationEvidenceArtifact>,
    validRefs: Set<string>,
  ): EvidenceLink[] {
    const links: EvidenceLink[] = []
    for (const item of items) {
      const rawLinks = Array.isArray(item.metadata?.rcaLinks) ? item.metadata.rcaLinks : []
      for (const raw of rawLinks) {
        const record = asRecord(raw)
        const chainId = asString(record.chainId)
        const hypothesis = asString(record.hypothesis)
        const from = asString(record.from)
        const relation = asString(record.relation)
        const to = asString(record.to)
        const summary = asString(record.summary)
        const confidence = asNumber(record.confidence) ?? 1
        const dimensions = asStringArray(record.dimensions)
          .filter((dimension): dimension is RcaDimension => RCA_DIMENSIONS.includes(dimension as RcaDimension))
        const polarity = asString(record.polarity)
        const causalRoles = normalizeCausalRoles(record.causalRoles)
        const precisionRequired = record.precisionRequired === true
        const evidenceRefs = asStringArray(record.evidenceRefs)
          .filter(ref => validRefs.has(ref) || ref.startsWith(`ticket:${run.jiraKey}`))
        if (!chainId || !hypothesis || !from || !relation || !to || !summary || confidence < 0.5) continue
        if (dimensions.length === 0 || evidenceRefs.length === 0) continue
        if (polarity && !['supports', 'contradicts', 'rules_out'].includes(polarity)) continue
        links.push({
          chainId,
          hypothesis,
          from,
          relation,
          to,
          dimensions,
          summary,
          evidenceRefs,
          confidence,
          polarity: (polarity as RcaEvidencePolarity | undefined) || 'supports',
          causalRoles,
          precisionRequired,
          sourceId: item.id,
        })
      }
    }
    return links
  }

  private collectUnlinkedContext(
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
  ): Map<RcaDimension, UnlinkedContribution[]> {
    const result = new Map<RcaDimension, UnlinkedContribution[]>()
    const add = (dimension: RcaDimension, summary: string, evidenceRefs: string[]) => {
      result.set(dimension, [...(result.get(dimension) || []), { summary, evidenceRefs }])
    }
    const ticketRef = `ticket:${run.jiraKey}`
    const anchors = [...(run.scope.evidenceAnchors || []), ...(run.scope.ticketContext?.evidenceAnchors || [])]
    if (anchors.length > 0 || run.scope.ticketContext?.identifiers?.length) {
      add('impacted_scope', 'Ticket anchors identify candidate affected entities, pending correlation to runtime evidence.', [ticketRef])
    }
    for (const item of [...findings.filter(finding => !isProbeLimitationFinding(finding)), ...evidence]) {
      const text = `${item.title}\n${item.summary}`
      if (/\b(?:exception|timeout|failed|failure|data too long|truncat|invalid state|query failed)\b/i.test(text)) {
        add('failure', 'An adapter observed a failure signal that is not yet part of a verified causal chain.', [item.id])
      }
    }
    return result
  }

  private schemaConstraintLinks(
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
  ): EvidenceLink[] {
    const runtimeColumns = new Map<string, string[]>()
    for (const item of [...findings, ...evidence]) {
      const text = `${item.title}\n${item.summary}\n${boundedJson(item.metadata, 100_000)}`
      for (const match of text.matchAll(/(?:data too long for column|value too long[^\n]{0,120}\bcolumn)\s+['"`]?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
        const column = match[1]?.toLowerCase()
        if (column) runtimeColumns.set(column, [...(runtimeColumns.get(column) || []), item.id])
      }
    }

    const mappings = new Map<string, string[]>()
    for (const artifact of evidence.filter(item => item.adapter === 'code')) {
      for (const rawHint of asRecordArray(asRecord(artifact.metadata).dataFlowHints)) {
        if (!isCausallyLinkedMapping(rawHint)) continue
        const table = asString(rawHint.tableName)?.toLowerCase()
        if (!table) continue
        const requiresLinkedField = Boolean(asString(rawHint.provenance))
        for (const rawColumn of asRecordArray(rawHint.columns)) {
          const column = asString(rawColumn.name)?.toLowerCase()
          if (!column) continue
          const columnLinkedFields = asStringArray(rawColumn.linkedFields)
          const linkedFields = new Set(
            (columnLinkedFields.length ? columnLinkedFields : asStringArray(rawHint.linkedFields)).map(normalizedLinkKey),
          )
          const propertyKey = normalizedLinkKey(asString(rawColumn.propertyName) || '')
          if (requiresLinkedField && (linkedFields.size === 0 || (!linkedFields.has(propertyKey) && !linkedFields.has(normalizedLinkKey(column))))) continue
          const key = `${table}.${column}`
          mappings.set(key, [...(mappings.get(key) || []), artifact.id])
        }
      }
    }

    const widths = new Map<string, { maxLength: number; observedLength?: number; observedPath?: string; ref: string }>()
    const intactScopeRefs: string[] = []
    for (const artifact of evidence.filter(item => item.adapter === 'data')) {
      for (const row of asRecordArray(asRecord(artifact.metadata).safeRows)) {
        const sourceName = asString(row.source_name)
        if (sourceName === 'schema_width') {
          const key = asString(row.scope_key)?.toLowerCase()
          const maxLength = asNumber(row.max_length)
          const observedLength = asNumber(row.observed_length)
          const observedPath = asString(row.observed_path)
          if (key && maxLength !== undefined) widths.set(key, { maxLength, observedLength, observedPath, ref: artifact.id })
        } else if (sourceName === 'member_identifier_match' && (asNumber(row.total_rows) || 0) > 0) {
          intactScopeRefs.push(artifact.id)
        }
      }
    }

    const links: EvidenceLink[] = []
    for (const [scopeKey, width] of widths) {
      const mappingRefs = mappings.get(scopeKey) || []
      if (mappingRefs.length === 0) continue
      const column = scopeKey.split('.').pop() || scopeKey
      const runtimeRefs = runtimeColumns.get(column) || []
      const overflow = width.observedLength !== undefined && width.observedLength > width.maxLength
      if (runtimeRefs.length === 0 && !overflow) continue
      const ticketRef = `ticket:${run.jiraKey}:structured-payload`
      const chainId = `persistence-contract:${scopeKey}`
      const hypothesis = `A persisted value violates the application storage contract for ${scopeKey}.`
      const common = { chainId, hypothesis, confidence: 0.95, polarity: 'supports' as const }
      const runtimeNode = `runtime-failure:${column}`
      const fieldNode = `persisted-field:${scopeKey}`
      links.push({
        ...common,
        sourceId: mappingRefs[0] || width.ref,
        from: runtimeNode,
        relation: 'is caused by a write to',
        to: fieldNode,
        dimensions: ['failure', 'mechanism'],
        summary: `Runtime persistence failure on ${column} maps to ${scopeKey}.`,
        evidenceRefs: Array.from(new Set([...runtimeRefs, ...mappingRefs])),
      })
      links.push({
        ...common,
        sourceId: width.ref,
        from: fieldNode,
        relation: 'is constrained by',
        to: `schema-limit:${scopeKey}:${width.maxLength}`,
        dimensions: ['mechanism', 'proof'],
        summary: `${scopeKey} has a verified maximum length of ${width.maxLength}.`,
        evidenceRefs: Array.from(new Set([...mappingRefs, width.ref])),
      })
      if (overflow) {
        links.push({
          ...common,
          sourceId: width.ref,
          from: `observed-input:${scopeKey}:${width.observedLength}`,
          relation: 'exceeds the limit for',
          to: fieldNode,
          dimensions: ['trigger', 'proof'],
          summary: `Observed input length ${width.observedLength} exceeds the persisted maximum ${width.maxLength}.`,
          evidenceRefs: [ticketRef, width.ref],
        })
      }
      const scopeRefs = Array.from(new Set([ticketRef, ...runtimeRefs, ...intactScopeRefs]))
      if (scopeRefs.length >= 2) {
        links.push({
          ...common,
          sourceId: scopeRefs[0],
          from: 'affected-scope:ticket-anchors',
          relation: 'produced',
          to: runtimeNode,
          dimensions: ['impacted_scope'],
          summary: 'Ticket anchors and runtime evidence identify the affected request scope.',
          evidenceRefs: scopeRefs,
        })
      }
      if (intactScopeRefs.length > 0) {
        links.push({
          ...common,
          sourceId: intactScopeRefs[0],
          from: 'affected-scope:ticket-anchors',
          relation: 'retains valid upstream identity while reaching',
          to: runtimeNode,
          dimensions: ['unaffected_scope', 'proof'],
          summary: 'Read-only anchor checks confirm the referenced upstream identity exists, ruling out a missing-record explanation.',
          evidenceRefs: Array.from(new Set([ticketRef, ...intactScopeRefs, ...runtimeRefs])),
        })
      }
    }
    return links.filter(link => link.evidenceRefs.length > 0)
  }

  private assessHypotheses(links: EvidenceLink[]): RcaHypothesisAssessment[] {
    const byChain = new Map<string, EvidenceLink[]>()
    for (const link of links) byChain.set(link.chainId, [...(byChain.get(link.chainId) || []), link])
    return Array.from(byChain, ([chainId, chainLinks]) => {
      const activeLinks = chainLinks.filter(link => link.polarity !== 'contradicts')
      const evidenceRefs = Array.from(new Set(activeLinks.flatMap(link => link.evidenceRefs)))
      const independentArtifacts = new Set(activeLinks.map(link => link.sourceId))
      const connected = isConnected(activeLinks)
        && evidenceRefs.length >= 2
        && independentArtifacts.size >= 2
      const dimensions = Array.from(new Set(activeLinks.flatMap(link => link.dimensions)))
      const nodeIds = Array.from(new Set(activeLinks.flatMap(link => [link.from, link.to])))
      return {
        chainId,
        hypothesis: chainLinks[0]?.hypothesis || chainId,
        connected,
        dimensions,
        evidenceRefs,
        supportingLinks: chainLinks.filter(link => link.polarity === 'supports').length,
        rulingOutLinks: chainLinks.filter(link => link.polarity === 'rules_out').length,
        contradictingLinks: chainLinks.filter(link => link.polarity === 'contradicts').length,
        nodeIds,
        symptomClusterIds: [],
      }
    }).sort((left, right) =>
      Number(right.connected) - Number(left.connected)
      || right.dimensions.length - left.dimensions.length
      || left.contradictingLinks - right.contradictingLinks
      || right.evidenceRefs.length - left.evidenceRefs.length,
    )
  }
}

function payloadFieldAmbiguities(
  evidence: InvestigationEvidenceArtifact[],
  hypotheses: RcaHypothesisAssessment[],
): string[] {
  const readyChains = new Set(hypotheses
    .filter(hypothesis => hypothesis.connected && hypothesis.contradictingLinks === 0)
    .map(hypothesis => hypothesis.chainId))
  const candidates = new Map<string, Set<string>>()
  for (const artifact of evidence.filter(item => item.adapter === 'data')) {
    for (const row of asRecordArray(asRecord(artifact.metadata).safeRows)) {
      if (asString(row.source_name) !== 'schema_width') continue
      const scopeKey = asString(row.scope_key)?.toLowerCase()
      const observedPath = asString(row.observed_path)?.toLowerCase()
      const observedLength = asNumber(row.observed_length)
      const maxLength = asNumber(row.max_length)
      if (!scopeKey || !observedPath || observedLength === undefined || maxLength === undefined || observedLength <= maxLength) continue
      const chainId = `persistence-contract:${scopeKey}`
      if (!readyChains.has(chainId)) continue
      candidates.set(observedPath, new Set([...(candidates.get(observedPath) || []), chainId]))
    }
  }
  return Array.from(candidates)
    .filter(([, chainIds]) => chainIds.size > 1)
    .map(([observedPath]) => `payload-field:${observedPath}`)
}

const REQUIRED_CAUSAL_ROLES = ['component', 'trigger', 'operation', 'error', 'impact'] as const

function synthesizeCausalFindings(
  hypotheses: RcaHypothesisAssessment[],
  links: EvidenceLink[],
): RcaCausalFinding[] {
  return hypotheses.flatMap(hypothesis => {
    const chainLinks = links.filter(link => link.chainId === hypothesis.chainId && link.polarity !== 'contradicts')
    const roles = chainLinks.reduce<RcaCausalRoles>((result, link) => ({
      ...result,
      ...Object.fromEntries(Object.entries(link.causalRoles || {}).filter(([, value]) => Boolean(value))),
    }), {})
    if (Object.keys(roles).length === 0) return []
    const missingRoles = REQUIRED_CAUSAL_ROLES.filter(role => !roles[role])
    const sentences = [
      roles.component && roles.trigger ? `${roles.component} received ${roles.trigger}` : roles.component || roles.trigger,
      roles.operation && roles.error ? `${roles.operation} failed with ${roles.error}` : roles.operation || roles.error,
      roles.failureHandling,
      roles.impact,
    ].filter((entry): entry is string => Boolean(entry)).map(sentence => sentence.replace(/[.\s]+$/, ''))
    return [{
      chainId: hypothesis.chainId,
      hypothesis: hypothesis.hypothesis,
      ...roles,
      statement: `${sentences.join('. ')}.`,
      evidenceRefs: Array.from(new Set(chainLinks.flatMap(link => link.evidenceRefs))),
      precisionComplete: missingRoles.length === 0,
      missingRoles,
    }]
  }).sort((left, right) => causalFindingScore(right) - causalFindingScore(left))
}

function causalFindingScore(finding: RcaCausalFinding): number {
  return Number(finding.precisionComplete) * 100
    + REQUIRED_CAUSAL_ROLES.filter(role => finding[role]).length * 10
    + Number(Boolean(finding.failureHandling)) * 5
    + Number(Boolean(finding.error)) * 3
    + Number(/deleted|retry|recovery|downstream/i.test(finding.impact || '')) * 2
}

function normalizeCausalRoles(value: unknown): RcaCausalRoles | undefined {
  const record = asRecord(value)
  const roles: RcaCausalRoles = {
    component: asString(record.component),
    trigger: asString(record.trigger),
    operation: asString(record.operation),
    error: asString(record.error),
    failureHandling: asString(record.failureHandling),
    impact: asString(record.impact),
  }
  return Object.values(roles).some(Boolean) ? roles : undefined
}

function selectCausalSet(
  hypotheses: RcaHypothesisAssessment[],
  symptomClusters: InvestigationSymptomCluster[],
): RcaHypothesisAssessment[] {
  const candidates = hypotheses.filter(hypothesis => hypothesis.connected && hypothesis.contradictingLinks === 0)
  const materialClusters = symptomClusters.filter(cluster => cluster.material)
  if (materialClusters.length === 0) return candidates.slice(0, 1)

  const selected = new Map<string, RcaHypothesisAssessment>()
  for (const cluster of materialClusters) {
    const explaining = candidates.find(hypothesis =>
      cluster.explainedByChainIds.includes(hypothesis.chainId)
      && ['failure', 'impacted_scope', 'trigger', 'mechanism', 'proof']
        .every(dimension => hypothesis.dimensions.includes(dimension as RcaDimension)),
    )
    if (explaining) {
      selected.set(explaining.chainId, {
        ...explaining,
        symptomClusterIds: Array.from(new Set([...explaining.symptomClusterIds, cluster.id])),
      })
    }
  }

  let changed = true
  while (changed && selected.size > 0) {
    changed = false
    const selectedValues = Array.from(selected.values())
    for (const candidate of candidates) {
      if (selected.has(candidate.chainId)) continue
      const related = selectedValues.some(existing =>
        candidate.nodeIds.some(node => existing.nodeIds.includes(node))
        || candidate.evidenceRefs.some(ref => existing.evidenceRefs.includes(ref)),
      )
      if (related) {
        selected.set(candidate.chainId, candidate)
        changed = true
      }
    }
  }
  return Array.from(selected.values())
}

function factDimensions(fact: InvestigationEvidenceFact): RcaDimension[] {
  switch (fact.type) {
    case 'symptom':
    case 'runtime_failure':
      return ['failure']
    case 'scope_state':
    case 'record_state':
      return /(?:unaffected|healthy|rules?_out|exists|active|valid)/i.test(`${fact.predicate} ${fact.object || ''}`)
        ? ['impacted_scope', 'unaffected_scope']
        : ['impacted_scope']
    case 'job_execution':
    case 'configuration':
    case 'change':
      return ['trigger']
    case 'code_relationship':
    case 'schema_constraint':
      return ['mechanism']
    case 'comparison':
      return ['proof']
    case 'recovery':
      return ['recovery']
    case 'prevention':
      return ['prevention']
  }
}

function isConnected(links: EvidenceLink[]): boolean {
  if (links.length === 0) return false
  const adjacency = new Map<string, Set<string>>()
  for (const link of links) {
    adjacency.set(link.from, new Set([...(adjacency.get(link.from) || []), link.to]))
    adjacency.set(link.to, new Set([...(adjacency.get(link.to) || []), link.from]))
  }
  const first = adjacency.keys().next().value as string | undefined
  if (!first) return false
  const visited = new Set<string>([first])
  const queue = [first]
  while (queue.length > 0) {
    const node = queue.shift() as string
    for (const neighbor of adjacency.get(node) || []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor)
        queue.push(neighbor)
      }
    }
  }
  return visited.size === adjacency.size
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter(entry => Object.keys(entry).length > 0) : []
}

function asString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text || undefined
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((entry): entry is string => Boolean(entry)) : []
}

function asNumber(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

function isCausallyLinkedMapping(hint: Record<string, unknown>): boolean {
  const provenance = asString(hint.provenance)
  if (!provenance) return true
  const artifactType = asString(hint.artifactType)
  if (artifactType !== 'hibernate_mapping') return provenance !== 'direct_field_match'
  const sourceTerm = asString(hint.sourceTerm)
  const modelName = asString(hint.modelName)
  const linkedFields = asStringArray(hint.linkedFields)
  return provenance === 'derived_reference'
    && Boolean(sourceTerm && modelName)
    && linkedFields.length > 0
    && normalizedLinkKey(sourceTerm as string) === normalizedLinkKey(modelName as string)
}

function normalizedLinkKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function isProbeLimitationFinding(finding: InvestigationFinding): boolean {
  return /(?:^|_)(?:access_failure|collection_failure|probe_failure|scope_unavailable|workspace_missing|no_candidate|target_unavailable|query_unavailable)$/i.test(finding.type)
    || /(?:evidence collection|inspection|probe|agent) (?:failed|did not find|could not|was unavailable)/i.test(`${finding.title}\n${finding.summary}`)
}

function boundedJson(value: unknown, maxChars: number): string {
  const serialized = JSON.stringify(value ?? {})
  return serialized.length > maxChars ? serialized.slice(0, maxChars) : serialized
}
