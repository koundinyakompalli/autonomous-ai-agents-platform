import type {
  InvestigationAdapterKind,
  InvestigationEvidenceArtifact,
  InvestigationFinding,
  InvestigationProbeIntent,
  InvestigationRunRecord,
} from '../types/investigation.js'
import { RCA_DIMENSIONS, type RcaCompletenessAssessment, type RcaDimension } from './RcaCompletenessEvaluator.js'

export const INVESTIGATION_WORKFLOW_TYPES = [
  'support_investigation',
  'meridian_remediation',
] as const

export type InvestigationWorkflowType = (typeof INVESTIGATION_WORKFLOW_TYPES)[number]

export const INVESTIGATION_CAUSE_HYPOTHESES = [
  'configuration',
  'data',
  'code',
  'runtime_environment',
  'integration',
  'workflow',
  'ui_report',
  'authentication_authorization',
] as const

export type InvestigationCauseHypothesis = (typeof INVESTIGATION_CAUSE_HYPOTHESES)[number]

export interface InvestigationProbeRecipe {
  id: string
  adapter: InvestigationAdapterKind
  intent: InvestigationProbeIntent
  description: string
  addresses: RcaDimension[]
  maxExecutions: number
}

export const DEFAULT_INVESTIGATION_PROBE_RECIPES: InvestigationProbeRecipe[] = [
  {
    id: 'aws-runtime-scope',
    adapter: 'aws',
    intent: 'resolve_runtime_scope',
    description: 'Resolve approved infrastructure, runtime log sources, and impacted environment scope.',
    addresses: ['failure', 'impacted_scope', 'trigger', 'proof'],
    maxExecutions: 1,
  },
  {
    id: 'aws-serverless-integration-trace',
    adapter: 'aws',
    intent: 'trace_message_route',
    description: 'Trace bounded SNS, SQS, EventBridge, API Gateway, and Lambda relationships; compare runtime contracts and inspect verified deployed handlers read-only.',
    addresses: ['failure', 'impacted_scope', 'unaffected_scope', 'trigger', 'mechanism', 'proof', 'recovery'],
    maxExecutions: 2,
  },
  {
    id: 'host-runtime-evidence',
    adapter: 'host',
    intent: 'read_effective_configuration',
    description: 'Collect bounded runtime, deployed configuration, and recovery-state evidence.',
    addresses: ['failure', 'unaffected_scope', 'trigger', 'mechanism', 'recovery', 'proof'],
    maxExecutions: 2,
  },
  {
    id: 'host-failing-stage',
    adapter: 'host',
    intent: 'identify_failing_stage',
    description: 'Separate runtime stages, executing programs, and bounded failure clusters.',
    addresses: ['failure', 'impacted_scope', 'proof'],
    maxExecutions: 1,
  },
  {
    id: 'host-recovery-verification',
    adapter: 'host',
    intent: 'verify_recovery',
    description: 'Correlate a bounded recovery action with symptom cessation and recurrence controls.',
    addresses: ['recovery', 'prevention', 'proof'],
    maxExecutions: 1,
  },
  {
    id: 'code-release-correlation',
    adapter: 'code',
    intent: 'trace_code_path',
    description: 'Correlate release-family source, deployed symbols, mechanism, and prevention candidates.',
    addresses: ['trigger', 'mechanism', 'proof', 'prevention'],
    maxExecutions: 2,
  },
  {
    id: 'code-setting-consumer',
    adapter: 'code',
    intent: 'trace_setting_to_code_consumer',
    description: 'Trace an effective setting through its code consumer and runtime behavior.',
    addresses: ['trigger', 'mechanism', 'proof'],
    maxExecutions: 2,
  },
  {
    id: 'data-readonly-comparison',
    adapter: 'data',
    intent: 'compare_affected_to_unaffected_scope',
    description: 'Run parameterized read-only comparisons for affected and unaffected data state.',
    addresses: ['impacted_scope', 'unaffected_scope', 'mechanism', 'proof', 'recovery'],
    maxExecutions: 2,
  },
  {
    id: 'data-affected-entity-state',
    adapter: 'data',
    intent: 'verify_affected_entity_state',
    description: 'Verify bounded affected records and explicitly rule out invalid upstream state.',
    addresses: ['impacted_scope', 'unaffected_scope', 'proof'],
    maxExecutions: 1,
  },
  {
    id: 'data-persistence-constraint',
    adapter: 'data',
    intent: 'compare_observed_value_to_constraint',
    description: 'Compare redacted observed metadata with an approved persistence constraint.',
    addresses: ['trigger', 'mechanism', 'proof'],
    maxExecutions: 2,
  },
]

export class InvestigationProbeRecipeRegistry {
  private readonly byId: Map<string, InvestigationProbeRecipe>

  constructor(recipes: InvestigationProbeRecipe[] = DEFAULT_INVESTIGATION_PROBE_RECIPES) {
    this.byId = new Map(recipes.map(recipe => [recipe.id, recipe]))
  }

  get(id: string): InvestigationProbeRecipe | undefined {
    return this.byId.get(id)
  }

  list(): InvestigationProbeRecipe[] {
    return Array.from(this.byId.values())
  }

  listByIntent(intent: InvestigationProbeIntent): InvestigationProbeRecipe[] {
    return this.list().filter(recipe => recipe.intent === intent)
  }

  recommend(missingDimensions: RcaDimension[]): InvestigationProbeRecipe[] {
    const missing = new Set(missingDimensions)
    return this.list()
      .map(recipe => ({
        recipe,
        score: recipe.addresses.filter(dimension => missing.has(dimension)).length,
      }))
      .filter(candidate => candidate.score > 0)
      .sort((left, right) => right.score - left.score || left.recipe.id.localeCompare(right.recipe.id))
      .map(candidate => candidate.recipe)
  }
}

export interface InvestigationPlanningInput {
  run: InvestigationRunRecord
  findings: InvestigationFinding[]
  evidence: InvestigationEvidenceArtifact[]
  assessment: RcaCompletenessAssessment
  recipes: InvestigationProbeRecipe[]
  executionCounts: Partial<Record<InvestigationAdapterKind, number>>
  probeExecutionCounts?: Record<string, number>
  iteration: number
}

export interface InvestigationPlanningAdvice {
  source: 'deterministic' | 'llm' | 'llm_fallback'
  workflowType: InvestigationWorkflowType
  causeHypotheses: InvestigationCauseHypothesis[]
  missingDimensions: RcaDimension[]
  proposedProbeIds: string[]
  evidenceGoals: string[]
  searchHints: string[]
  expectedComparison: string[]
  acceptanceCriteria: string[]
  rationale: string
}

export interface InvestigationPlanningAdvisor {
  advise(input: InvestigationPlanningInput): Promise<InvestigationPlanningAdvice>
}

export class DeterministicInvestigationPlanningAdvisor implements InvestigationPlanningAdvisor {
  async advise(input: InvestigationPlanningInput): Promise<InvestigationPlanningAdvice> {
    const text = [
      input.run.title,
      input.run.scope.ticketContext?.title,
      input.run.scope.ticketContext?.description,
      ...(input.run.scope.keywords || []),
      ...input.findings.map(finding => `${finding.type} ${finding.title} ${finding.summary}`),
    ].filter(Boolean).join('\n').toLowerCase()
    const hypotheses = new Set<InvestigationCauseHypothesis>()

    if (/\b(?:config|property|flag|setting)\b/.test(text)) hypotheses.add('configuration')
    if (/\b(?:data|database|sql|row|schema|mapping|eligibility)\b/.test(text)) hypotheses.add('data')
    if (/\b(?:code|class|method|stack|exception|release|commit)\b/.test(text)) hypotheses.add('code')
    if (/\b(?:host|runtime|node|server|restart|reboot|mount|environment|lambda|container|pod)\b/.test(text)) hypotheses.add('runtime_environment')
    if (/\b(?:api|vendor|integration|certificate|token|rate limit|http)\b/.test(text)) hypotheses.add('integration')
    if (/\b(?:workflow|queue|transition|status|downstream action|batch|scheduler|job|retry)\b/.test(text)) hypotheses.add('workflow')
    if (/\b(?:ui|report|browser|render|parameter|dataset|dashboard)\b/.test(text)) hypotheses.add('ui_report')
    if (/\b(?:auth|sso|shibboleth|role|permission|access)\b/.test(text)) hypotheses.add('authentication_authorization')
    if (hypotheses.size === 0) hypotheses.add('runtime_environment')

    const recommended = new InvestigationProbeRecipeRegistry(input.recipes)
      .recommend(input.assessment.missingDimensions)
      .filter(recipe => (input.probeExecutionCounts?.[recipe.id] || 0) < recipe.maxExecutions)
      .sort((left, right) =>
        probePriority(left.adapter, input, text) - probePriority(right.adapter, input, text)
        || (input.probeExecutionCounts?.[left.id] || 0) - (input.probeExecutionCounts?.[right.id] || 0),
      )

    return {
      source: 'deterministic',
      workflowType: /\b(?:meridian|remediation|correction|dml|data fix)\b/.test(text)
        ? 'meridian_remediation'
        : 'support_investigation',
      causeHypotheses: Array.from(hypotheses),
      missingDimensions: input.assessment.missingDimensions.filter(dimension => RCA_DIMENSIONS.includes(dimension)),
      proposedProbeIds: recommended.map(recipe => recipe.id),
      evidenceGoals: input.assessment.missingDimensions
        .slice(0, 8)
        .map(dimension => `Collect evidence that addresses the ${dimension} RCA dimension.`),
      searchHints: deriveGenericSearchHints(text),
      expectedComparison: [
        'Compare affected evidence with an unaffected or expected baseline when one is available.',
      ],
      acceptanceCriteria: [
        'Each claimed causal link is supported by a referenced evidence artifact.',
      ],
      rationale: recommended.length > 0
        ? `RCA gaps remain; proposed ${recommended.map(recipe => recipe.id).join(', ')} from the allowlisted recipe catalog.`
        : 'No allowlisted recipe remains within the execution budget for the outstanding RCA gaps.',
    }
  }
}

function deriveGenericSearchHints(text: string): string[] {
  const hints = new Set<string>()
  if (/\b(?:5\d\d|timeout|timed out|gateway|api|http)\b/.test(text)) {
    for (const hint of ['timeout', 'session', 'ttl', 'retry', 'circuit breaker']) hints.add(hint)
  }
  if (/\b(?:batch|queue|scheduler|job|backlog)\b/.test(text)) {
    for (const hint of ['batch', 'queue', 'pageSize', 'retry', 'scheduler']) hints.add(hint)
  }
  if (/\b(?:report|dataset|render|dashboard|parameter)\b/.test(text)) {
    for (const hint of ['report', 'query', 'dataset', 'parameter', 'role', 'render']) hints.add(hint)
  }
  if (/\b(?:lambda|cloudwatch|dlq|serverless)\b/.test(text)) {
    for (const hint of ['lambda', 'handler', 'alias', 'concurrency', 'DLQ', 'timeout', 'environment']) hints.add(hint)
  }
  if (/\b(?:sns|sqs|eventbridge|event bus|event publishing|api gateway|publisher|subscriber|message|queue)\b/.test(text)) {
    for (const hint of ['publisher', 'subscriber', 'event source', 'handler', 'payload contract', 'DLQ', 'retry']) hints.add(hint)
  }
  if (/\b(?:terraform|tfstate|infrastructure as code|iac|drift)\b/.test(text)) {
    for (const hint of ['terraform', 'module', 'resource', 'state', 'plan', 'drift']) hints.add(hint)
  }
  return Array.from(hints).slice(0, 12)
}

function probePriority(
  adapter: InvestigationAdapterKind,
  input: InvestigationPlanningInput,
  evidenceText: string,
): number {
  const count = input.executionCounts[adapter] || 0
  const hasCodeScope = (input.run.scope.repoNames?.length || 0) > 0
  const relationshipKeys = new Set([
    ...(input.run.scope.diagnosticContext?.runtimeFailureColumns || []),
    ...(input.run.scope.ticketContext?.attachments || []).flatMap(attachment =>
      (attachment.observedFieldLengths || []).flatMap(field => [field.fieldName, field.path.split('.').pop() || '']),
    ),
  ].map(value => value.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter(Boolean))
  const structuredHints = input.run.scope.diagnosticContext?.dataFlowHints || []
  const hasStructuredCodeRelationships = structuredHints.some(hint => {
    const fields = [
      ...(hint.columns || []).flatMap(column => [column.name, column.propertyName || '']),
      ...(hint.linkedFields || []),
    ].map(value => value.toLowerCase().replace(/[^a-z0-9]+/g, '')).filter(Boolean)
    return fields.length > 0 && (
      relationshipKeys.size === 0
      || fields.some(field => relationshipKeys.has(field))
    )
  })
  const hasRuntimeFailure = input.findings.some(finding =>
    finding.adapter === 'aws'
    && /(?:exception|error|failure|timeout|unavailable|http\s*[45]\d\d)/i.test(`${finding.type} ${finding.title} ${finding.summary}`),
  )
  const serverlessEvidence = /\b(?:lambda|sns|sqs|eventbridge|event publishing|api gateway|publisher|subscriber|message|queue)\b/.test(evidenceText)

  if (adapter === 'aws' && serverlessEvidence && count <= 1) return 0
  if (adapter === 'host' && hasRuntimeFailure && count === 0) return 0
  if (adapter === 'code' && hasCodeScope && count === 0) return 1
  if (adapter === 'code' && hasCodeScope && count === 1 && !hasStructuredCodeRelationships) return 1
  if (adapter === 'data' && count === 0 && (!hasCodeScope || (input.executionCounts.code || 0) > 0)) return 2
  if (adapter === 'host' && count === 0) return 3
  if (adapter === 'data' && count === 0) return 4
  if (adapter === 'code' && count === 0) return 5
  if (adapter === 'data' && /\b(?:data|database|sql|schema|mapping|eligibility)\b/.test(evidenceText)) return 6
  if (adapter === 'code' && hasCodeScope) return 7
  if (adapter === 'host') return 8
  return 9
}
