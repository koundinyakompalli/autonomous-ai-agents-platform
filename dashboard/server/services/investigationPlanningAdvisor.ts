import {
  DeterministicInvestigationPlanningAdvisor,
  buildEvidenceLedger,
  INVESTIGATION_CAUSE_HYPOTHESES,
  INVESTIGATION_WORKFLOW_TYPES,
  RCA_DIMENSIONS,
  type InvestigationCauseHypothesis,
  type InvestigationPlanningAdvice,
  type InvestigationPlanningAdvisor,
  type InvestigationPlanningInput,
  type InvestigationWorkflowType,
  type RcaDimension,
} from '../../../src/investigation/index.js'
import { redactInvestigationText } from '../../../src/investigation/utils/RuntimeEvidence.js'
import {
  runInvestigationLlmJson,
  type InvestigationLlmRequest,
  type InvestigationLlmResponse,
} from './investigationLlmProvider.js'

interface LlmPlanningPayload {
  workflowType?: string
  causeHypotheses?: string[]
  missingDimensions?: string[]
  proposedProbeIds?: string[]
  evidenceGoals?: string[]
  searchHints?: string[]
  expectedComparison?: string[]
  acceptanceCriteria?: string[]
  rationale?: string
}

type PlanningLlmInvoker = <T>(request: InvestigationLlmRequest) => Promise<InvestigationLlmResponse<T>>

function envFlag(name: string, fallback = false): boolean {
  const value = process.env[name]?.trim()
  if (!value) return fallback
  return /^(1|true|yes|on)$/i.test(value)
}

function boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] || '', 10)
  return Number.isInteger(parsed) ? Math.max(minimum, Math.min(parsed, maximum)) : fallback
}

function isWorkflowType(value: string): value is InvestigationWorkflowType {
  return INVESTIGATION_WORKFLOW_TYPES.includes(value as InvestigationWorkflowType)
}

function isCauseHypothesis(value: string): value is InvestigationCauseHypothesis {
  return INVESTIGATION_CAUSE_HYPOTHESES.includes(value as InvestigationCauseHypothesis)
}

function isRcaDimension(value: string): value is RcaDimension {
  return RCA_DIMENSIONS.includes(value as RcaDimension)
}

function boundedTextList(value: unknown, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value)) return []
  return Array.from(new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map(item => redactInvestigationText(item).trim().slice(0, maxLength))
    .filter(Boolean)))
    .slice(0, maxItems)
}

function countAnchorKinds(input: InvestigationPlanningInput): Array<{ kind: string; count: number }> {
  const counts = new Map<string, number>()
  const anchors = [
    ...(input.run.scope.evidenceAnchors || []),
    ...(input.run.scope.ticketContext?.evidenceAnchors || []),
    ...(input.run.scope.ticketContext?.identifiers || []),
  ]
  for (const anchor of anchors) {
    counts.set(anchor.kind, (counts.get(anchor.kind) || 0) + 1)
  }
  return Array.from(counts, ([kind, count]) => ({ kind, count }))
    .sort((left, right) => left.kind.localeCompare(right.kind))
    .slice(0, 20)
}

function buildCausalEvidenceDigest(input: InvestigationPlanningInput): Record<string, unknown> {
  const ticketContext = input.run.scope.ticketContext
  const diagnosticContext = input.run.scope.diagnosticContext
  const releaseBranches = input.evidence.flatMap(artifact => {
    const refresh = Array.isArray(artifact.metadata?.codeRefresh)
      ? artifact.metadata.codeRefresh
      : []
    return refresh.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return []
      const record = entry as Record<string, unknown>
      return [{
        repo: typeof record.repoName === 'string'
          ? redactInvestigationText(record.repoName).slice(0, 160)
          : undefined,
        branch: typeof record.branch === 'string'
          ? redactInvestigationText(record.branch).slice(0, 240)
          : undefined,
        status: typeof record.status === 'string'
          ? redactInvestigationText(record.status).slice(0, 120)
          : undefined,
      }]
    })
  }).slice(0, 20)
  const ledger = buildEvidenceLedger(input.run, input.findings, input.evidence)

  return {
    scope: {
      repositories: boundedTextList(input.run.scope.repoNames, 12, 160),
      codeVersion: input.run.scope.codeVersion
        ? redactInvestigationText(input.run.scope.codeVersion).slice(0, 240)
        : undefined,
      releaseVersion: input.run.scope.releaseVersion
        ? redactInvestigationText(input.run.scope.releaseVersion).slice(0, 120)
        : undefined,
      releaseBranches,
    },
    ticketEvidence: {
      anchorKinds: countAnchorKinds(input),
      attachments: (ticketContext?.attachments || []).slice(0, 20).map(attachment => ({
        filename: redactInvestigationText(attachment.filename).slice(0, 240),
        extractionStatus: attachment.extractionStatus,
        observedFieldLengths: (attachment.observedFieldLengths || []).slice(0, 20).map(field => ({
          fieldName: redactInvestigationText(field.fieldName).slice(0, 160),
          path: redactInvestigationText(field.path).slice(0, 320),
          length: field.length,
          sourceRef: redactInvestigationText(field.sourceRef).slice(0, 240),
        })),
      })),
    },
    runtimeEvidence: {
      failureColumns: boundedTextList(diagnosticContext?.runtimeFailureColumns, 20, 160),
      terms: boundedTextList(diagnosticContext?.runtimeEvidenceTerms, 20, 200),
    },
    codeDataFlow: (diagnosticContext?.dataFlowHints || []).slice(0, 20).map(hint => ({
      sourceRepo: redactInvestigationText(hint.sourceRepo).slice(0, 160),
      sourcePath: redactInvestigationText(hint.sourcePath).slice(0, 320),
      sourceLine: hint.sourceLine,
      sourceTerm: hint.sourceTerm
        ? redactInvestigationText(hint.sourceTerm).slice(0, 200)
        : undefined,
      modelName: hint.modelName
        ? redactInvestigationText(hint.modelName).slice(0, 160)
        : undefined,
      tableName: redactInvestigationText(hint.tableName).slice(0, 160),
      columns: (hint.columns || []).slice(0, 20).map(column => ({
        name: redactInvestigationText(column.name).slice(0, 160),
        propertyName: column.propertyName
          ? redactInvestigationText(column.propertyName).slice(0, 160)
          : undefined,
      })),
      linkedFields: boundedTextList(hint.linkedFields, 20, 160),
      provenance: hint.provenance,
      artifactType: hint.artifactType,
    })),
    evidenceLedger: {
      facts: ledger.facts.slice(0, 40).map(fact => ({
        type: fact.type,
        subject: redactInvestigationText(fact.subject).slice(0, 240),
        predicate: redactInvestigationText(fact.predicate).slice(0, 160),
        object: fact.object ? redactInvestigationText(fact.object).slice(0, 240) : undefined,
        value: typeof fact.value === 'string'
          ? redactInvestigationText(fact.value).slice(0, 160)
          : fact.value,
        symptomClusterId: fact.symptomClusterId,
        chainIds: fact.chainIds,
        confidence: fact.confidence,
        sourceRef: redactInvestigationText(fact.provenance.sourceRef).slice(0, 240),
        redactionState: fact.provenance.redactionState,
      })),
      symptomClusters: ledger.symptomClusters.slice(0, 20).map(cluster => ({
        id: cluster.id,
        label: redactInvestigationText(cluster.label).slice(0, 240),
        material: cluster.material,
        explainedByChainIds: cluster.explainedByChainIds,
      })),
    },
  }
}

export class SafeLlmInvestigationPlanningAdvisor implements InvestigationPlanningAdvisor {
  private readonly fallback = new DeterministicInvestigationPlanningAdvisor()
  private calls = 0
  private lastEvidenceFingerprint: string | undefined

  constructor(
    private readonly enabled = envFlag('INVESTIGATION_LLM_PLANNER_ENABLED'),
    private readonly maxCalls = boundedInteger('INVESTIGATION_LLM_PLANNER_MAX_CALLS', 4, 0, 4),
    private readonly invoke: PlanningLlmInvoker = runInvestigationLlmJson,
  ) {}

  async advise(input: InvestigationPlanningInput): Promise<InvestigationPlanningAdvice> {
    if (!this.enabled || this.calls >= this.maxCalls) {
      return this.fallback.advise(input)
    }
    const evidenceFingerprint = JSON.stringify({
      findings: input.findings.map(finding => [
        finding.id,
        finding.adapter,
        finding.type,
        finding.summary,
        finding.evidenceRefs,
      ]),
      evidence: input.evidence.map(artifact => [
        artifact.id,
        artifact.adapter,
        artifact.summary,
      ]),
      missingDimensions: input.assessment.missingDimensions,
      diagnosticContext: input.run.scope.diagnosticContext,
    })
    if (evidenceFingerprint === this.lastEvidenceFingerprint) {
      return this.fallback.advise(input)
    }
    this.lastEvidenceFingerprint = evidenceFingerprint
    this.calls += 1

    const allowedProbeIds = input.recipes.map(recipe => recipe.id)
    const schema = {
      type: 'object',
      additionalProperties: false,
      required: [
        'workflowType',
        'causeHypotheses',
        'missingDimensions',
        'proposedProbeIds',
        'evidenceGoals',
        'searchHints',
        'expectedComparison',
        'acceptanceCriteria',
        'rationale',
      ],
      properties: {
        workflowType: { type: 'string', enum: INVESTIGATION_WORKFLOW_TYPES },
        causeHypotheses: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', enum: INVESTIGATION_CAUSE_HYPOTHESES },
        },
        missingDimensions: {
          type: 'array',
          maxItems: RCA_DIMENSIONS.length,
          items: { type: 'string', enum: RCA_DIMENSIONS },
        },
        proposedProbeIds: {
          type: 'array',
          maxItems: Math.min(4, allowedProbeIds.length),
          items: { type: 'string', enum: allowedProbeIds },
        },
        evidenceGoals: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 500 },
        },
        searchHints: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 300 },
        },
        expectedComparison: {
          type: 'array',
          maxItems: 6,
          items: { type: 'string', maxLength: 500 },
        },
        acceptanceCriteria: {
          type: 'array',
          maxItems: 8,
          items: { type: 'string', maxLength: 500 },
        },
        rationale: { type: 'string', maxLength: 1_000 },
      },
    }
    const evidenceSummary = {
      ticket: {
        key: input.run.jiraKey,
        title: redactInvestigationText(input.run.title).slice(0, 500),
        clientId: input.run.scope.clientId,
        environment: input.run.scope.environment,
        releaseVersion: input.run.scope.releaseVersion,
      },
      completeness: input.assessment.dimensions.map(dimension => ({
        dimension: dimension.dimension,
        complete: dimension.complete,
        summary: redactInvestigationText(dimension.summary).slice(0, 500),
      })),
      findings: input.findings.slice(-12).map(finding => ({
        id: finding.id,
        adapter: finding.adapter,
        type: finding.type,
        title: redactInvestigationText(finding.title).slice(0, 240),
        summary: redactInvestigationText(finding.summary).slice(0, 700),
      })),
      evidence: input.evidence.slice(-12).map(artifact => ({
        id: artifact.id,
        adapter: artifact.adapter,
        title: redactInvestigationText(artifact.title).slice(0, 240),
        summary: redactInvestigationText(artifact.summary).slice(0, 700),
      })),
      allowedRecipes: input.recipes.map(recipe => ({
        id: recipe.id,
        adapter: recipe.adapter,
        intent: recipe.intent,
        description: recipe.description,
        addresses: recipe.addresses,
        executions: input.probeExecutionCounts?.[recipe.id] || 0,
        maxExecutions: recipe.maxExecutions,
      })),
      causalEvidenceDigest: buildCausalEvidenceDigest(input),
    }

    try {
      const response = await this.invoke<LlmPlanningPayload>({
        systemPrompt: [
          'You are the Investigation Cockpit causal-gap classifier.',
          'Classify workflow and cause hypotheses, identify unsupported RCA dimensions, and propose only allowlisted probe IDs.',
          'Preserve multiple contributing causal chains and require every material symptom cluster to be explained or explicitly left unresolved.',
          'A runtime error is a symptom: continue toward the triggering condition, code/configuration mechanism, affected-versus-control proof, and recovery evidence.',
          'For each proposal, state bounded evidence goals, safe search hints, the expected affected-versus-baseline comparison, and evidence-based acceptance criteria.',
          'You are not an executor. Do not produce SQL, shell commands, hosts, credentials, remediation actions, or facts absent from evidence.',
          'A finding is not a complete RCA. Prefer no probe when the catalog cannot safely address the evidence gap.',
        ].join(' '),
        userPrompt: JSON.stringify(evidenceSummary),
        schema,
        maxTokens: boundedInteger('INVESTIGATION_LLM_MAX_OUTPUT_TOKENS', 4_096, 1_024, 16_384),
        timeoutMs: boundedInteger('INVESTIGATION_LLM_PLANNER_TIMEOUT_MS', 60_000, 5_000, 120_000),
      })
      const parsed = response.parsed
      const workflowType = typeof parsed.workflowType === 'string' && isWorkflowType(parsed.workflowType)
        ? parsed.workflowType
        : 'support_investigation'
      const causeHypotheses = Array.isArray(parsed.causeHypotheses)
        ? parsed.causeHypotheses.filter((value): value is InvestigationCauseHypothesis => typeof value === 'string' && isCauseHypothesis(value))
        : []
      const missingDimensions = Array.isArray(parsed.missingDimensions)
        ? parsed.missingDimensions.filter((value): value is RcaDimension =>
            typeof value === 'string'
            && isRcaDimension(value)
            && input.assessment.missingDimensions.includes(value),
          )
        : []
      const proposedProbeIds = Array.isArray(parsed.proposedProbeIds)
        ? Array.from(new Set(parsed.proposedProbeIds.filter((value): value is string =>
            typeof value === 'string' && allowedProbeIds.includes(value),
          )))
        : []

      return {
        source: 'llm',
        workflowType,
        causeHypotheses,
        missingDimensions,
        proposedProbeIds,
        evidenceGoals: boundedTextList(parsed.evidenceGoals, 8, 500),
        searchHints: boundedTextList(parsed.searchHints, 8, 300),
        expectedComparison: boundedTextList(parsed.expectedComparison, 6, 500),
        acceptanceCriteria: boundedTextList(parsed.acceptanceCriteria, 8, 500),
        rationale: redactInvestigationText(parsed.rationale || 'LLM gap classification completed.').slice(0, 1_000),
      }
    } catch (error) {
      const fallback = await this.fallback.advise(input)
      return {
        ...fallback,
        source: 'llm_fallback',
        rationale: `LLM planning was unavailable or invalid; deterministic fallback applied. ${redactInvestigationText(error instanceof Error ? error.message : String(error)).slice(0, 300)}`,
      }
    }
  }
}

export function createInvestigationPlanningAdvisor(): InvestigationPlanningAdvisor {
  return new SafeLlmInvestigationPlanningAdvisor()
}
