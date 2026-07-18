import type { InvestigationAdapterRequest, InvestigationEnvironment, InvestigationQueryPack } from '../types/investigation.js'

export interface InvestigationCodeSemanticRule {
  score: number
  reason?: string
  textAll?: string[]
  textAny?: string[]
  pathAll?: string[]
  pathAny?: string[]
  previewAll?: string[]
  previewAny?: string[]
  unlessTextAny?: string[]
}

export interface InvestigationCodeDerivedDiagnostic extends InvestigationQueryPack {
  sourceFiles?: string[]
}

export interface InvestigationCodeSemanticProfile {
  id: string
  title: string
  summary: string
  clientId?: string
  environments?: InvestigationEnvironment[]
  priority?: number
  matchAll?: string[]
  matchAny?: string[]
  preferredTerms: string[]
  pathBoosts?: string[]
  previewBoosts?: string[]
  negativePathTerms?: string[]
  rules?: InvestigationCodeSemanticRule[]
  dataDiagnostics?: InvestigationCodeDerivedDiagnostic[]
  enabled: boolean
}

export interface InvestigationCodeSemanticProfileRegistry {
  resolveProfile(request: InvestigationAdapterRequest): Promise<InvestigationCodeSemanticProfile | null>
}

function includesNormalized(source: string, needle: string): boolean {
  const normalizedSource = source.toLowerCase()
  const normalizedNeedle = needle.toLowerCase()
  return normalizedSource.includes(normalizedNeedle)
    || normalizedSource.replace(/[^a-z0-9]+/g, '').includes(normalizedNeedle.replace(/[^a-z0-9]+/g, ''))
}

function ticketSearchText(request: InvestigationAdapterRequest): string {
  const context = request.scope.ticketContext
  return [
    request.jiraKey,
    ...(request.scope.keywords ?? []),
    ...(request.scope.serviceIds ?? []),
    ...(request.scope.repoNames ?? []),
    context?.title,
    ...(context?.extractedTerms ?? []),
    ...(context?.attachments ?? []).flatMap(attachment => [attachment.filename, attachment.textExcerpt, ...(attachment.extractedTerms ?? [])]),
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .join('\n')
}

function profileMatchesRequest(
  profile: InvestigationCodeSemanticProfile,
  request: InvestigationAdapterRequest,
  text: string,
): boolean {
  if (!profile.enabled) {
    return false
  }
  if (profile.clientId && profile.clientId !== request.scope.clientId) {
    return false
  }
  if (profile.environments?.length && !profile.environments.includes(request.scope.environment)) {
    return false
  }
  if (profile.matchAll?.length && !profile.matchAll.every(term => includesNormalized(text, term))) {
    return false
  }
  if (profile.matchAny?.length && !profile.matchAny.some(term => includesNormalized(text, term))) {
    return false
  }
  return Boolean(profile.matchAll?.length || profile.matchAny?.length)
}

export class NoopCodeSemanticProfileRegistry implements InvestigationCodeSemanticProfileRegistry {
  async resolveProfile(_request: InvestigationAdapterRequest): Promise<InvestigationCodeSemanticProfile | null> {
    return null
  }
}

export class InMemoryCodeSemanticProfileRegistry implements InvestigationCodeSemanticProfileRegistry {
  constructor(private readonly profiles: InvestigationCodeSemanticProfile[] = []) {}

  async resolveProfile(request: InvestigationAdapterRequest): Promise<InvestigationCodeSemanticProfile | null> {
    const text = ticketSearchText(request)
    const matches = this.profiles
      .filter(profile => profileMatchesRequest(profile, request, text))
      .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0))

    return matches[0] ?? null
  }
}
