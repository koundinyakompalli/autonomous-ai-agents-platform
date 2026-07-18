import type {
  InvestigationObservedFieldLength,
  InvestigationTicketContext,
} from '../types/investigation.js'

export interface TicketPayloadEvidence {
  fieldTerms: string[]
  observedFieldLengths: InvestigationObservedFieldLength[]
}

export function extractTicketPayloadEvidence(
  context: InvestigationTicketContext | undefined,
): TicketPayloadEvidence {
  const terms = new Set<string>()
  const observations = new Map<string, InvestigationObservedFieldLength>()

  for (const attachment of context?.attachments || []) {
    for (const term of attachment.payloadFieldTerms || []) {
      terms.add(term)
    }
    for (const observation of attachment.observedFieldLengths || []) {
      addObservation(observations, observation)
    }
    const text = attachment.textExcerpt?.trim()
    if (!text || attachment.extractionStatus !== 'text_extracted') {
      continue
    }
    const extracted = extractJsonPayloadEvidence(
      text,
      attachment.contentRef || `jira-attachment:${attachment.id}`,
    )
    for (const term of extracted.fieldTerms) {
      terms.add(term)
    }
    extracted.observedFieldLengths.forEach(observation => addObservation(observations, observation))
  }

  const observedFieldLengths = Array.from(observations.values())
    .sort((left, right) => right.length - left.length || left.path.localeCompare(right.path))
    .slice(0, 80)
  const observedTerms = observedFieldLengths.map(observation => observation.fieldName)

  return {
    fieldTerms: Array.from(new Set([...observedTerms, ...terms])).slice(0, 80),
    observedFieldLengths,
  }
}

export function extractJsonPayloadEvidence(text: string, sourceRef: string): TicketPayloadEvidence {
  let payload: unknown
  try {
    payload = JSON.parse(text)
  } catch {
    return { fieldTerms: [], observedFieldLengths: [] }
  }
  const terms = new Set<string>()
  const observations = new Map<string, InvestigationObservedFieldLength>()
  visitJsonValue(payload, [], sourceRef, terms, observations, { remaining: 5_000 })
  return {
    fieldTerms: Array.from(terms).slice(0, 80),
    observedFieldLengths: Array.from(observations.values())
      .sort((left, right) => right.length - left.length || left.path.localeCompare(right.path))
      .slice(0, 80),
  }
}

function visitJsonValue(
  value: unknown,
  path: string[],
  sourceRef: string,
  terms: Set<string>,
  observations: Map<string, InvestigationObservedFieldLength>,
  traversalBudget: { remaining: number },
): void {
  if (path.length > 20 || traversalBudget.remaining-- <= 0) {
    return
  }
  if (Array.isArray(value)) {
    for (const entry of value.slice(0, 100)) {
      visitJsonValue(entry, [...path, '[]'], sourceRef, terms, observations, traversalBudget)
    }
    return
  }
  if (!value || typeof value !== 'object') {
    return
  }

  for (const [fieldName, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{1,79}$/.test(fieldName)) {
      continue
    }
    terms.add(fieldName)
    const fieldPath = [...path, fieldName]
    if (typeof fieldValue === 'string') {
      const observation: InvestigationObservedFieldLength = {
        fieldName,
        path: fieldPath.join('.'),
        length: Array.from(fieldValue).length,
        sourceRef,
      }
      addObservation(observations, observation)
    } else {
      visitJsonValue(fieldValue, fieldPath, sourceRef, terms, observations, traversalBudget)
    }
  }
}

function addObservation(
  observations: Map<string, InvestigationObservedFieldLength>,
  observation: InvestigationObservedFieldLength,
): void {
  const key = `${normalizeFieldName(observation.fieldName)}:${observation.sourceRef}`
  const existing = observations.get(key)
  if (!existing || observation.length > existing.length) {
    observations.set(key, observation)
  }
}

export function normalizeObservedFieldName(value: string): string {
  return normalizeFieldName(value)
}

function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}
