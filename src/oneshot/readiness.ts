import type { OneShotCodeReview } from './schema/code-review.js'
import type { OneShotPlan } from './schema/plan.js'
import type { QualificationAssessment } from './schema/qualification.js'
import type { OneShotTestResult } from './schema/test-result.js'

export const ONESHOT_COMPLETION_STATUSES = [
  'completed_ready',
  'completed_draft',
  'completed_needs_review',
  'completed_with_risks',
  'completed_no_action',
] as const

export type OneShotCompletionStatus = (typeof ONESHOT_COMPLETION_STATUSES)[number]

export const ONESHOT_READINESS_LEVELS = [
  'ready',
  'draft',
  'needs_review',
  'with_risks',
  'no_action',
] as const

export type OneShotReadinessLevel = (typeof ONESHOT_READINESS_LEVELS)[number]

export type OneShotRiskSeverity = 'critical' | 'high' | 'medium' | 'low'

export type OneShotRiskCategory =
  | 'endpoint_or_api_surface'
  | 'data_model_or_type_contract'
  | 'domain_value_or_business_default'
  | 'error_handling_policy'
  | 'layering_or_ownership'
  | 'external_spec_contract'
  | 'test_fixture_invariant'
  | 'security_or_phi'
  | 'peer_implementation_completeness'
  | 'unverified_tests'
  | 'code_review'
  | 'ci'

const READINESS_ACTIVE_RISK_CATEGORIES_ENV = 'ONESHOT_READINESS_ACTIVE_RISK_CATEGORIES'

export interface OneShotReadinessReason {
  code: string
  category: OneShotRiskCategory
  severity: OneShotRiskSeverity
  message: string
  source: string
}

export interface PlanRiskAssessment {
  mode: 'observe'
  blockingCandidateCount: number
  advisoryCount: number
  wouldAffectReadiness: boolean
  findings: OneShotReadinessReason[]
}

export interface QualificationRiskAssessment {
  mode: 'observe'
  promotedWarningCount: number
  wouldAffectReadiness: boolean
  findings: OneShotReadinessReason[]
}

export interface ExternalSpecEvidence {
  mode: 'observe'
  urls: Array<{
    url: string
    status: 'detected' | 'not_fetched_observe_mode' | 'cached' | 'fetched' | 'unavailable'
    cacheKey: string
    fetchedAt?: string
    expiresAt?: string
    error?: string
    evidence?: ExternalSpecEvidenceSummary
  }>
  unavailable: boolean
}

export interface ExternalSpecEvidenceSummary {
  schemaVersion: 1
  url: string
  fetchedAt: string
  sourceBytes: number
  contentHash: string
  profileRequirements: string[]
  bundleStructure: string[]
  parameterContracts: string[]
  questionnaireRequirements: string[]
  operationContracts: string[]
  notes: string[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isPlanRiskAssessment(value: unknown): value is PlanRiskAssessment {
  return isRecord(value) && Array.isArray(value.findings)
}

export function isQualificationRiskAssessment(
  value: unknown,
): value is QualificationRiskAssessment {
  return isRecord(value) && Array.isArray(value.findings)
}

export function isExternalSpecEvidence(value: unknown): value is ExternalSpecEvidence {
  return isRecord(value) && Array.isArray(value.urls)
}

export interface CiStatusSummary {
  state: 'success' | 'failure' | 'error' | 'pending' | 'unavailable' | 'unconfigured'
  description: string
  targetUrl?: string | null
  statusCount?: number
  checkRunCount?: number
  requiredCheckState?: 'none' | 'present' | 'unavailable'
  details?: string[]
}

export interface OneShotReadinessClassification {
  completionStatus: OneShotCompletionStatus
  readiness: OneShotReadinessLevel
  reasons: OneShotReadinessReason[]
  observedRisks?: OneShotReadinessReason[]
}

interface RiskRule {
  code: string
  category: OneShotRiskCategory
  severity: OneShotRiskSeverity
  sourceHint: string
  patterns: RegExp[]
}

function parseRiskCategory(value: string): OneShotRiskCategory | null {
  const normalized = value.trim()
  if (!normalized) {
    return null
  }
  const known: OneShotRiskCategory[] = [
    'endpoint_or_api_surface',
    'data_model_or_type_contract',
    'domain_value_or_business_default',
    'error_handling_policy',
    'layering_or_ownership',
    'external_spec_contract',
    'test_fixture_invariant',
    'security_or_phi',
    'peer_implementation_completeness',
    'unverified_tests',
    'code_review',
    'ci',
  ]
  return known.includes(normalized as OneShotRiskCategory)
    ? normalized as OneShotRiskCategory
    : null
}

export function getActiveReadinessRiskCategories(
  raw = process.env[READINESS_ACTIVE_RISK_CATEGORIES_ENV] ?? '',
): Set<OneShotRiskCategory> | 'all' {
  if (raw.trim().toLowerCase() === 'all') {
    return 'all'
  }
  const categories = new Set<OneShotRiskCategory>()
  for (const part of raw.split(',')) {
    const category = parseRiskCategory(part)
    if (category) {
      categories.add(category)
    }
  }
  return categories
}

function isReadinessActiveCategory(
  category: OneShotRiskCategory,
  active: Set<OneShotRiskCategory> | 'all',
): boolean {
  return active === 'all' || active.has(category)
}

const RISK_RULES: RiskRule[] = [
  {
    code: 'endpoint_api_uncertainty',
    category: 'endpoint_or_api_surface',
    severity: 'high',
    sourceHint: 'endpoint/API evidence',
    patterns: [
      /\bclosest match\b/i,
      /\b(no|not|does not)\s+(?:such\s+)?(?:method|endpoint|api|route|service)\s+(?:exists?|found|available)\b/i,
      /\bmissing\s+(?:method|endpoint|api|route)\b/i,
      /\binvent(?:ed|s)?\s+(?:method|helper|endpoint|api|surface)\b/i,
      /\bgetUM?QuestionSet\b/i,
    ],
  },
  {
    code: 'data_model_contract_uncertainty',
    category: 'data_model_or_type_contract',
    severity: 'high',
    sourceHint: 'type/model contract',
    patterns: [
      /\bstring\s+vs\s+enum\b/i,
      /\benum\b.*\b(?:unknown|unclear|assum)/i,
      /\btype\b.*\b(?:unknown|unclear|mismatch|assum)/i,
      /\bdata\s+model\b.*\b(?:unknown|unclear|assum)/i,
      /\bcontract\b.*\b(?:unknown|unclear|assum)/i,
    ],
  },
  {
    code: 'domain_default_uncertainty',
    category: 'domain_value_or_business_default',
    severity: 'high',
    sourceHint: 'domain value/default',
    patterns: [
      /\breasonable default\b/i,
      /\bsemantically neutral\b/i,
      /\bhard-?cod(?:e|ed|ing)\b/i,
      /\brequestedUnits\b/i,
      /\bauthRequestType\b/i,
      /\bauthIntakeType\b/i,
    ],
  },
  {
    code: 'error_policy_uncertainty',
    category: 'error_handling_policy',
    severity: 'medium',
    sourceHint: 'error-handling policy',
    patterns: [
      /\bswallow(?:ing)?\s+(?:the\s+)?error\b/i,
      /\bcontinue\b.*\b(?:external|provider|service)\s+fail/i,
      /\bif desired behavior (?:is )?different\b/i,
      /\bgraceful degradation\b/i,
      /\bOperationOutcome\b/i,
      /\bpropagat(?:e|ing)\s+(?:the\s+)?error\b/i,
    ],
  },
  {
    code: 'ownership_layer_uncertainty',
    category: 'layering_or_ownership',
    severity: 'medium',
    sourceHint: 'class/layer ownership',
    patterns: [
      /\b(?:class|layer|service|owner|ownership)\b.*\b(?:unclear|assum|choice)\b/i,
      /\bAbstractCDSOrderService\b/i,
      /\bDTRService\b/i,
      /\bnew helper\b/i,
    ],
  },
  {
    code: 'external_spec_evidence_needed',
    category: 'external_spec_contract',
    severity: 'high',
    sourceHint: 'external spec',
    patterns: [
      /\bFHIR\b/i,
      /\bHL7\b/i,
      /\bDa\s*Vinci\b/i,
      /\bDTR\b/i,
      /\bPAS\b/i,
      /\bPackageBundle\b/i,
      /\bQuestionnaireResponse\b/i,
      /\bmeta\.profile\b/i,
    ],
  },
  {
    code: 'fhir_fixture_invariant',
    category: 'test_fixture_invariant',
    severity: 'high',
    sourceHint: 'FHIR fixture invariant',
    patterns: [
      /\bPatient\b.*\b(?:bundle|fixture|required|missing)\b/i,
      /\bCoverage\b.*\b(?:bundle|fixture|required|missing)\b/i,
      /\bprocessBundle\b/i,
      /\bPatient not found in bundle\b/i,
    ],
  },
  {
    code: 'phi_security_risk',
    category: 'security_or_phi',
    severity: 'critical',
    sourceHint: 'healthcare security guardrail',
    patterns: [
      /\bPHI\b/i,
      /\bPII\b/i,
      /\braw response bod(?:y|ies)\b/i,
      /\blog(?:ger)?\.(?:info|warn|error)\b.*\b(?:response|answer|questionnaire|patient|coverage)\b/i,
    ],
  },
  {
    code: 'peer_implementation_gap',
    category: 'peer_implementation_completeness',
    severity: 'medium',
    sourceHint: 'sibling implementation coverage',
    patterns: [
      /\bsibling implementation\b/i,
      /\bsister implementation\b/i,
      /\bpeer implementation\b/i,
      /\bInterqualDtrClient\b/i,
      /\bmissing mapped fields?\b/i,
      /\bsource-to-target\b/i,
    ],
  },
]

const ALLOWLISTED_SPEC_HOSTS = [
  'build.fhir.org',
  'hl7.org',
  'www.hl7.org',
]

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function addUniqueReason(
  reasons: OneShotReadinessReason[],
  candidate: OneShotReadinessReason,
): void {
  if (reasons.some((reason) => reason.code === candidate.code && reason.message === candidate.message)) {
    return
  }
  reasons.push(candidate)
}

function classifyRiskText(
  text: string,
  source: string,
): OneShotReadinessReason[] {
  const normalized = normalizeText(text)
  if (!normalized) {
    return []
  }

  const findings: OneShotReadinessReason[] = []
  for (const rule of RISK_RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(normalized))) {
      continue
    }
    addUniqueReason(findings, {
      code: rule.code,
      category: rule.category,
      severity: rule.severity,
      source,
      message: `${rule.sourceHint}: ${normalized}`,
    })
  }
  return findings
}

function riskSourceEntries(plan: OneShotPlan): Array<{ source: string; value: string }> {
  const entries: Array<{ source: string; value: string }> = [
    ...plan.openQuestions.map((value, index) => ({ source: `plan.openQuestions[${index}]`, value })),
    ...plan.assumptions.map((value, index) => ({ source: `plan.assumptions[${index}]`, value })),
    ...plan.risks.map((value, index) => ({ source: `plan.risks[${index}]`, value })),
  ]

  for (const [specIndex, spec] of plan.specs.entries()) {
    entries.push(
      ...spec.implementationNotes.map((value, index) => ({
        source: `plan.specs[${specIndex}].implementationNotes[${index}]`,
        value,
      })),
      ...spec.validationSteps.map((value, index) => ({
        source: `plan.specs[${specIndex}].validationSteps[${index}]`,
        value,
      })),
      ...spec.targetFileRationales.flatMap((rationale, index) => [
        rationale.uncertainty
          ? {
              source: `plan.specs[${specIndex}].targetFileRationales[${index}].uncertainty`,
              value: rationale.uncertainty,
            }
          : null,
        ...rationale.rejectedAlternatives.map((value, altIndex) => ({
          source: `plan.specs[${specIndex}].targetFileRationales[${index}].rejectedAlternatives[${altIndex}]`,
          value,
        })),
      ].filter((entry): entry is { source: string; value: string } => entry !== null)),
    )
  }

  return entries
}

export function assessOneShotPlanRisk(plan: OneShotPlan): PlanRiskAssessment {
  const findings: OneShotReadinessReason[] = []
  for (const entry of riskSourceEntries(plan)) {
    for (const finding of classifyRiskText(entry.value, entry.source)) {
      addUniqueReason(findings, finding)
    }
  }

  const blockingCandidateCount = findings.filter((finding) =>
    finding.severity === 'critical' || finding.severity === 'high',
  ).length

  return {
    mode: 'observe',
    blockingCandidateCount,
    advisoryCount: findings.length - blockingCandidateCount,
    wouldAffectReadiness: findings.length > 0,
    findings,
  }
}

export function assessOneShotQualificationRisk(
  qualification: Pick<QualificationAssessment, 'blockingReasons' | 'nonBlockingWarnings'>,
): QualificationRiskAssessment {
  const findings: OneShotReadinessReason[] = []
  for (const [index, value] of qualification.blockingReasons.entries()) {
    for (const finding of classifyRiskText(value, `qualification.blockingReasons[${index}]`)) {
      addUniqueReason(findings, finding)
    }
  }
  for (const [index, value] of qualification.nonBlockingWarnings.entries()) {
    for (const finding of classifyRiskText(value, `qualification.nonBlockingWarnings[${index}]`)) {
      addUniqueReason(findings, finding)
    }
  }

  return {
    mode: 'observe',
    promotedWarningCount: findings.filter((finding) =>
      finding.source.startsWith('qualification.nonBlockingWarnings'),
    ).length,
    wouldAffectReadiness: findings.length > 0,
    findings,
  }
}

function extractUrls(text: string): string[] {
  const urls = new Set<string>()
  const matcher = /https?:\/\/[^\s)\]}>"']+/gi
  for (const match of text.matchAll(matcher)) {
    const rawUrl = match[0].replace(/[.,;:]+$/g, '')
    try {
      const parsed = new URL(rawUrl)
      if (ALLOWLISTED_SPEC_HOSTS.includes(parsed.hostname.toLowerCase())) {
        urls.add(parsed.toString())
      }
    } catch {
      // Ignore malformed URL-looking text.
    }
  }
  return [...urls]
}

export function detectExternalSpecEvidence(input: {
  plan: OneShotPlan
  qualification?: Pick<QualificationAssessment, 'requirementsSummary' | 'nonBlockingWarnings' | 'blockingReasons' | 'inspectionSummary'> | null
  ticketSummary?: string | null
  taskDescription?: string | null
}): ExternalSpecEvidence {
  const text = [
    input.ticketSummary,
    input.taskDescription,
    input.plan.summary,
    ...input.plan.assumptions,
    ...input.plan.openQuestions,
    ...input.plan.risks,
    ...input.plan.specs.flatMap((spec) => [
      spec.objective,
      ...spec.acceptanceCriteria,
      ...spec.implementationNotes,
      ...spec.validationSteps,
    ]),
    ...(input.qualification?.requirementsSummary ?? []),
    ...(input.qualification?.nonBlockingWarnings ?? []),
    ...(input.qualification?.blockingReasons ?? []),
    input.qualification?.inspectionSummary,
  ].filter((value): value is string => typeof value === 'string' && value.length > 0).join('\n')

  const urls = extractUrls(text).map((url) => ({
    url,
    status: 'not_fetched_observe_mode' as const,
    cacheKey: `external-spec/${encodeURIComponent(url)}.json`,
  }))

  return {
    mode: 'observe',
    urls,
    unavailable: false,
  }
}

function reasonFromCodeReviewMetadata(metadata: Record<string, unknown> | null | undefined): OneShotReadinessReason[] {
  if (!metadata?.softGateContinued) {
    return []
  }
  const reason = typeof metadata.softGateReason === 'string' ? metadata.softGateReason : 'soft_gate'
  const originalDecision = typeof metadata.originalDecision === 'string' ? metadata.originalDecision : 'UNKNOWN'
  const requiredChanges = Array.isArray(metadata.requiredChanges)
    ? metadata.requiredChanges.filter((value): value is string => typeof value === 'string')
    : []
  const blockingFindings = Array.isArray(metadata.blockingFindings)
    ? metadata.blockingFindings.filter((value): value is string => typeof value === 'string')
    : []

  return [{
    code: 'code_review_soft_gate',
    category: 'code_review',
    severity: originalDecision === 'BLOCKED' ? 'high' : 'medium',
    source: 'code_review.metadata',
    message: [
      `Code review continued through soft-gate mode (${reason}, original decision ${originalDecision}).`,
      ...requiredChanges.slice(0, 2),
      ...blockingFindings.slice(0, 2),
    ].join(' '),
  }]
}

export function buildOneShotReadinessClassification(input: {
  testResult?: OneShotTestResult | null
  testFailureReason?: string | null
  codeReviewMetadata?: Record<string, unknown> | null
  planRiskAssessment?: PlanRiskAssessment | null
  qualificationRiskAssessment?: QualificationRiskAssessment | null
  externalSpecEvidence?: ExternalSpecEvidence | null
  ciStatus?: CiStatusSummary | null
  activeRiskCategories?: Set<OneShotRiskCategory> | 'all' | null
  additionalReasons?: OneShotReadinessReason[]
}): OneShotReadinessClassification {
  const reasons: OneShotReadinessReason[] = []
  const observedRisks: OneShotReadinessReason[] = []
  const activeRiskCategories = input.activeRiskCategories ?? getActiveReadinessRiskCategories()
  const testResult = input.testResult ?? null
  if (testResult?.unverified) {
    addUniqueReason(reasons, {
      code: 'unverified_tests',
      category: 'unverified_tests',
      severity: 'high',
      source: 'test_result',
      message: `Declared runnable test command(s) were skipped: ${testResult?.skippedTestCommands.join(' | ')}`,
    })
  }
  if (testResult && !testResult.passed) {
    addUniqueReason(reasons, {
      code: 'test_result_not_passing',
      category: 'unverified_tests',
      severity: testResult.executionKind === 'validation_only' ? 'medium' : 'high',
      source: 'test_result',
      message: input.testFailureReason ?? `${testResult.failCount} test/validation failure(s) remained.`,
    })
  }

  for (const reason of reasonFromCodeReviewMetadata(input.codeReviewMetadata)) {
    addUniqueReason(reasons, reason)
  }
  for (const finding of input.planRiskAssessment?.findings ?? []) {
    if (!isReadinessActiveCategory(finding.category, activeRiskCategories)) {
      addUniqueReason(observedRisks, {
        ...finding,
        source: `observed_risk_assessment:${finding.source}`,
      })
      continue
    }
    addUniqueReason(reasons, {
      ...finding,
      source: `risk_assessment:${finding.source}`,
    })
  }
  for (const finding of input.qualificationRiskAssessment?.findings ?? []) {
    if (!isReadinessActiveCategory(finding.category, activeRiskCategories)) {
      addUniqueReason(observedRisks, {
        ...finding,
        source: `observed_qualification_risk:${finding.source}`,
      })
      continue
    }
    addUniqueReason(reasons, {
      ...finding,
      source: `qualification_risk:${finding.source}`,
    })
  }
  const unresolvedSpecUrls = (input.externalSpecEvidence?.urls ?? []).filter((entry) =>
    entry.status !== 'cached' &&
    entry.status !== 'fetched' &&
    (entry.status === 'unavailable' || isReadinessActiveCategory('external_spec_contract', activeRiskCategories)),
  )
  if (unresolvedSpecUrls.length > 0) {
    addUniqueReason(reasons, {
      code: 'external_spec_observed',
      category: 'external_spec_contract',
      severity: 'medium',
      source: 'external_spec_evidence',
      message: `External healthcare spec URL(s) were detected and need cached evidence before marking ready: ${unresolvedSpecUrls.map((entry) => entry.url).join(', ')}`,
    })
  }
  if (input.externalSpecEvidence?.unavailable) {
    addUniqueReason(reasons, {
      code: 'external_spec_unavailable',
      category: 'external_spec_contract',
      severity: 'high',
      source: 'external_spec_evidence',
      message: 'Referenced external spec evidence was unavailable.',
    })
  }
  if (input.ciStatus?.state === 'failure' || input.ciStatus?.state === 'error') {
    addUniqueReason(reasons, {
      code: 'ci_failed',
      category: 'ci',
      severity: 'high',
      source: 'github_checks',
      message: input.ciStatus.description,
    })
  } else if (input.ciStatus?.state === 'pending') {
    addUniqueReason(reasons, {
      code: 'ci_pending',
      category: 'ci',
      severity: 'medium',
      source: 'github_checks',
      message: input.ciStatus.description,
    })
  } else if (input.ciStatus?.state === 'unconfigured') {
    addUniqueReason(reasons, {
      code: 'ci_configuration_missing',
      category: 'ci',
      severity: 'high',
      source: 'github_checks',
      message: input.ciStatus.description,
    })
  } else if (input.ciStatus?.state === 'unavailable') {
    addUniqueReason(reasons, {
      code: 'ci_unavailable',
      category: 'ci',
      severity: 'medium',
      source: 'github_checks',
      message: input.ciStatus.description,
    })
  }

  for (const reason of input.additionalReasons ?? []) {
    addUniqueReason(reasons, reason)
  }

  const hasCriticalOrHigh = reasons.some((reason) =>
    reason.severity === 'critical' || reason.severity === 'high',
  )
  const hasReviewReason = reasons.some((reason) =>
    reason.category === 'code_review' ||
    reason.category === 'unverified_tests' ||
    reason.category === 'security_or_phi' ||
    reason.category === 'ci',
  )
  const hasMedium = reasons.some((reason) => reason.severity === 'medium')

  if (hasCriticalOrHigh || hasReviewReason) {
    return {
      completionStatus: 'completed_needs_review',
      readiness: 'needs_review',
      reasons,
      observedRisks,
    }
  }
  if (hasMedium) {
    return {
      completionStatus: 'completed_draft',
      readiness: 'draft',
      reasons,
      observedRisks,
    }
  }
  if (reasons.length > 0) {
    return {
      completionStatus: 'completed_with_risks',
      readiness: 'with_risks',
      reasons,
      observedRisks,
    }
  }

  return {
    completionStatus: 'completed_ready',
    readiness: 'ready',
    reasons: [],
    observedRisks,
  }
}

export function readinessLabel(readiness: OneShotReadinessLevel): string {
  switch (readiness) {
    case 'ready':
      return 'Ready'
    case 'draft':
      return 'Draft'
    case 'needs_review':
      return 'Needs review'
    case 'with_risks':
      return 'With risks'
    case 'no_action':
      return 'No action'
  }
}

export function completionStatusToReadiness(
  completionStatus: string | null | undefined,
): OneShotReadinessLevel | null {
  switch (completionStatus) {
    case 'completed_ready':
      return 'ready'
    case 'completed_draft':
      return 'draft'
    case 'completed_needs_review':
      return 'needs_review'
    case 'completed_with_risks':
      return 'with_risks'
    case 'completed_no_action':
      return 'no_action'
    default:
      return null
  }
}
