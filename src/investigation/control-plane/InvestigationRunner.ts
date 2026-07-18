import { createLogger } from '../../utils/logger.js'
import type { InvestigationAdapterRegistry } from '../adapters/types.js'
import { ConfidenceScorer } from './ConfidenceScorer.js'
import { enrichScopeWithDiagnosticEvidence } from './DiagnosticScope.js'
import { EscalationPolicy, type InvestigationNextStep } from './EscalationPolicy.js'
import {
  DeterministicInvestigationPlanningAdvisor,
  InvestigationProbeRecipeRegistry,
  type InvestigationPlanningAdvice,
  type InvestigationPlanningAdvisor,
  type InvestigationProbeRecipe,
} from './InvestigationPlanning.js'
import {
  RcaCompletenessEvaluator,
  type RcaCompletenessAssessment,
} from './RcaCompletenessEvaluator.js'
import type {
  InvestigationAdapterKind,
  InvestigationAdapterRequest,
  InvestigationCorrelationResult,
  InvestigationEvidenceArtifact,
  InvestigationFinding,
  InvestigationRunRecord,
} from '../types/investigation.js'
import {
  extractEvidenceSearchTerms,
} from '../utils/RuntimeEvidence.js'
import { buildEvidenceLedger } from './EvidenceLedger.js'
import type { InvestigationEvidenceFact, InvestigationSymptomCluster } from '../types/investigation.js'

const logger = createLogger('investigation-runner')
const SERVERLESS_TRACE_PROBE_ID = 'aws-serverless-integration-trace'

function hasServerlessRouteEvidence(
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): boolean {
  return findings.some(finding => finding.type === 'serverless_message_route_traced')
    || evidence.some(artifact => artifact.adapter === 'aws' && (
      artifact.id.includes('aws-serverless-')
      || Boolean(artifact.metadata?.topology)
    ))
}

function ticketExplicitlyRequiresManagedHost(run: InvestigationRunRecord): boolean {
  const text = [
    run.title,
    run.scope.ticketContext?.title,
    run.scope.ticketContext?.description,
    ...(run.scope.ticketContext?.extractedTerms || []),
    ...(run.scope.serviceIds || []),
  ].filter(Boolean).join('\n')
  return /\b(?:ec2|ssh|host|server|node|tomcat|jboss|weblogic|mount|reboot|systemd|on[- ]prem|batch|scheduler)\b|\bdeployed\s+(?:jar|war|properties?)\b|\bproperties?\s+file\b/i.test(text)
}

function ticketExplicitlyIdentifiesServerless(run: InvestigationRunRecord): boolean {
  const text = [
    run.title,
    run.scope.ticketContext?.title,
    run.scope.ticketContext?.description,
    ...(run.scope.ticketContext?.extractedTerms || []),
    ...(run.scope.serviceIds || []),
  ].filter(Boolean).join('\n')
  return /\b(?:lambda|sns|sqs|eventbridge|event bus|api gateway|serverless|event source mapping|cloudwatch logs?[^\n]{0,80}\/aws\/lambda)\b/i.test(text)
}

function ticketExplicitlyIdentifiesBatchOrFileFlow(run: InvestigationRunRecord): boolean {
  const text = [
    run.title,
    run.scope.ticketContext?.title,
    run.scope.ticketContext?.description,
    ...(run.scope.ticketContext?.extractedTerms || []),
    ...(run.scope.serviceIds || []),
  ].filter(Boolean).join('\n')
  return /\b(?:batch|cron|scheduler|scheduled job|poller|file watcher|inbound files?|outbound files?|subfolders?|directories|file transfer|sftp|extracts?)\b/i.test(text)
    || /\b(?:pulling|reading|picking up|depositing|moving|copying|writing)\b[^\n]{0,100}\b(?:files?|faxes|folders?|directories|extracts?)\b/i.test(text)
}

function runLooksServerless(run: InvestigationRunRecord): boolean {
  const text = [
    run.title,
    run.scope.ticketContext?.title,
    run.scope.ticketContext?.description,
    ...(run.scope.ticketContext?.extractedTerms || []),
    ...(run.scope.keywords || []),
    ...(run.scope.serviceIds || []),
  ].filter(Boolean).join('\n')
  return /\b(?:lambda|sns|sqs|eventbridge|event bus|api gateway|serverless|queue|publisher|subscriber|event publishing|webhook)\b/i.test(text)
    || /\b(?:not receiving|stopped receiving|no longer receiving|missing|dropped)\b[^\n]{0,160}\b(?:requests?|events?|messages?)\b/i.test(text)
}

function probeAppliesToEvidence(
  recipe: InvestigationProbeRecipe,
  run: InvestigationRunRecord,
  findings: InvestigationFinding[],
  evidence: InvestigationEvidenceArtifact[],
): boolean {
  if (recipe.id === SERVERLESS_TRACE_PROBE_ID) {
    if (hasServerlessRouteEvidence(findings, evidence) || ticketExplicitlyIdentifiesServerless(run)) return true
    if (ticketExplicitlyIdentifiesBatchOrFileFlow(run)) return false
  }
  if (recipe.adapter !== 'host') return true
  if (!hasServerlessRouteEvidence(findings, evidence)) return true
  return ticketExplicitlyRequiresManagedHost(run)
}

export interface InvestigationRunExecution {
  run: InvestigationRunRecord
  findings: InvestigationFinding[]
  evidence: InvestigationEvidenceArtifact[]
  correlation: InvestigationCorrelationResult
  nextStep: InvestigationNextStep
  rcaAssessment: RcaCompletenessAssessment
  planningTrace: InvestigationPlanningTraceEntry[]
  facts: InvestigationEvidenceFact[]
  symptomClusters: InvestigationSymptomCluster[]
}

export interface InvestigationPlanningTraceEntry {
  iteration: number
  assessment: RcaCompletenessAssessment
  advice: InvestigationPlanningAdvice
  selectedProbeId?: string
  selectedAdapter?: InvestigationAdapterKind
  outcome: 'executed' | 'complete' | 'no_runnable_probe' | 'reviewed'
}

export interface InvestigationRunnerOptions {
  planningAdvisor?: InvestigationPlanningAdvisor
  probeRegistry?: InvestigationProbeRecipeRegistry
  completenessEvaluator?: RcaCompletenessEvaluator
  maxPlanningIterations?: number
  adapterTimeoutMs?: number
  onProgress?: (progress: InvestigationRunProgress) => void
}

export interface InvestigationRunProgress {
  phase: 'adapter_started' | 'adapter_partial' | 'adapter_completed' | 'planning'
  adapter?: InvestigationAdapterKind
  probeId?: string
  iteration?: number
  findingCount: number
  evidenceCount: number
  message: string
  findings?: InvestigationFinding[]
  evidence?: InvestigationEvidenceArtifact[]
}

export class InvestigationRunner {
  private readonly scorer = new ConfidenceScorer()
  private readonly escalationPolicy = new EscalationPolicy()
  private readonly planningAdvisor: InvestigationPlanningAdvisor
  private readonly deterministicPlanningAdvisor = new DeterministicInvestigationPlanningAdvisor()
  private readonly probeRegistry: InvestigationProbeRecipeRegistry
  private readonly completenessEvaluator: RcaCompletenessEvaluator
  private readonly maxPlanningIterations: number
  private readonly adapterTimeoutMs: number
  private readonly onProgress?: (progress: InvestigationRunProgress) => void

  constructor(
    private readonly adapters: InvestigationAdapterRegistry,
    options: InvestigationRunnerOptions = {},
  ) {
    this.planningAdvisor = options.planningAdvisor ?? new DeterministicInvestigationPlanningAdvisor()
    this.probeRegistry = options.probeRegistry ?? new InvestigationProbeRecipeRegistry()
    this.completenessEvaluator = options.completenessEvaluator ?? new RcaCompletenessEvaluator()
    this.maxPlanningIterations = Math.max(0, Math.min(options.maxPlanningIterations ?? 4, 12))
    this.adapterTimeoutMs = Math.max(100, Math.min(options.adapterTimeoutMs ?? 60_000, 120_000))
    this.onProgress = options.onProgress
  }

  async execute(run: InvestigationRunRecord): Promise<InvestigationRunExecution> {
    if (run.scope.workflowType === 'planned_data_change') {
      return this.routePlannedDataChange(run)
    }

    const findings: InvestigationFinding[] = []
    const evidence: InvestigationEvidenceArtifact[] = []
    const planningTrace: InvestigationPlanningTraceEntry[] = []
    const executionCounts: Partial<Record<InvestigationAdapterKind, number>> = {}
    const probeExecutionCounts: Record<string, number> = {}
    const lastScopeFingerprints: Record<string, string> = {}
    const failedProbes = new Set<string>()
    const probesWithMaterialEvidence = new Set<string>()
    let lastExecutedProbeId: string | undefined

    // Intake is currently represented by the existing normalized scope on the run.
    const awsFindingStart = findings.length
    await this.executeAdapter('aws', run, findings, evidence, 'aws-runtime-scope')
    if (this.adapterFailedSince(findings, 'aws', awsFindingStart)) failedProbes.add('aws-runtime-scope')
    this.recordAdapterAttempt('aws', 'aws-runtime-scope', run, executionCounts, probeExecutionCounts, lastScopeFingerprints)
    if (hasServerlessRouteEvidence(findings, evidence)) {
      probeExecutionCounts[SERVERLESS_TRACE_PROBE_ID] = Math.max(
        1,
        probeExecutionCounts[SERVERLESS_TRACE_PROBE_ID] || 0,
      )
      lastScopeFingerprints[`aws:${SERVERLESS_TRACE_PROBE_ID}`] = this.scopeFingerprint(run)
      probesWithMaterialEvidence.add(SERVERLESS_TRACE_PROBE_ID)
    }

    let hostProbeRan = false
    let dataProbeRan = false
    let codeProbeRan = false
    let workingRun = this.enrichRun(run, findings, evidence)
    let rcaAssessment = this.completenessEvaluator.evaluate(workingRun, findings, evidence)
    for (let iteration = 1; iteration <= this.maxPlanningIterations && !rcaAssessment.operationallyClosed; iteration += 1) {
      this.reportProgress({
        phase: 'planning', iteration, findingCount: findings.length, evidenceCount: evidence.length,
        message: `Evaluating causal gaps before planning iteration ${iteration}.`,
      })
      const activeMissingDimensions = rcaAssessment.diagnosisReady
        ? rcaAssessment.missingClosureDimensions
        : rcaAssessment.missingDiagnosisDimensions
      const planningAssessment: RcaCompletenessAssessment = {
        ...rcaAssessment,
        missingDimensions: activeMissingDimensions,
      }
      const planningInput = {
        run: workingRun,
        findings,
        evidence,
        assessment: planningAssessment,
        recipes: this.probeRegistry.list(),
        executionCounts,
        probeExecutionCounts,
        iteration,
      }
      const advisorAdvice = await this.planningAdvisor.advise(planningInput)
      const deterministicAdvice = await this.deterministicPlanningAdvisor.advise(planningInput)
      const isRunnableRecipe = (recipe: InvestigationProbeRecipe | undefined): recipe is InvestigationProbeRecipe => Boolean(
        recipe
        && activeMissingDimensions.some(dimension => recipe.addresses.includes(dimension))
        && probeAppliesToEvidence(recipe, workingRun, findings, evidence)
        && !failedProbes.has(recipe.id)
        && (probeExecutionCounts[recipe.id] || 0) < recipe.maxExecutions
        && (recipe.id !== SERVERLESS_TRACE_PROBE_ID
          || (probeExecutionCounts[recipe.id] || 0) === 0
          || rcaAssessment.unexplainedSymptomClusterIds.some(id => id.startsWith('serverless-'))
          || findings.some(finding => finding.type === 'serverless_evidence_limitation'))
        && !(lastExecutedProbeId === recipe.id && probesWithMaterialEvidence.has(recipe.id))
        && this.scopeFingerprint(workingRun) !== lastScopeFingerprints[`${recipe.adapter}:${recipe.id}`],
      )
      const llmHasRunnableProbe = advisorAdvice.source === 'llm'
        && advisorAdvice.proposedProbeIds.some(probeId => isRunnableRecipe(this.probeRegistry.get(probeId)))
      const appendedProbeIds = llmHasRunnableProbe
        ? []
        : deterministicAdvice.proposedProbeIds
          .filter(probeId => !advisorAdvice.proposedProbeIds.includes(probeId))
      const advice: InvestigationPlanningAdvice = {
        ...advisorAdvice,
        missingDimensions: activeMissingDimensions,
        proposedProbeIds: [...advisorAdvice.proposedProbeIds, ...appendedProbeIds],
        rationale: appendedProbeIds.length > 0
          ? `${advisorAdvice.rationale} Deterministic authority appended runnable candidates: ${appendedProbeIds.join(', ')}.`
          : advisorAdvice.rationale,
      }
      const selected = advice.proposedProbeIds
        .map(probeId => this.probeRegistry.get(probeId))
        .find(isRunnableRecipe)

      if (!selected) {
        planningTrace.push({
          iteration,
          assessment: rcaAssessment,
          advice,
          outcome: 'no_runnable_probe',
        })
        break
      }

      const plannedRun: InvestigationRunRecord = {
        ...workingRun,
        scope: {
          ...workingRun.scope,
          planningContext: {
            activeProbeId: selected.id,
            activeProbeIntent: selected.intent,
            workflowType: advice.workflowType,
            causeHypotheses: advice.causeHypotheses,
            planningIteration: iteration,
            evidenceGoals: advice.evidenceGoals,
            searchHints: advice.searchHints,
            expectedComparison: advice.expectedComparison,
            acceptanceCriteria: advice.acceptanceCriteria,
          },
        },
      }
      const adapterFindingStart = findings.length
      const producedMaterialEvidence = await this.executeAdapter(selected.adapter, plannedRun, findings, evidence, selected.id)
      if (producedMaterialEvidence) probesWithMaterialEvidence.add(selected.id)
      lastExecutedProbeId = selected.id
      if (this.adapterFailedSince(findings, selected.adapter, adapterFindingStart)) {
        failedProbes.add(selected.id)
      }
      this.recordAdapterAttempt(
        selected.adapter,
        selected.id,
        plannedRun,
        executionCounts,
        probeExecutionCounts,
        lastScopeFingerprints,
      )
      hostProbeRan ||= selected.adapter === 'host'
      codeProbeRan ||= selected.adapter === 'code'
      dataProbeRan ||= selected.adapter === 'data'
      workingRun = this.enrichRun(plannedRun, findings, evidence)
      rcaAssessment = this.completenessEvaluator.evaluate(workingRun, findings, evidence)
      planningTrace.push({
        iteration,
        assessment: rcaAssessment,
        advice,
        selectedProbeId: selected.id,
        selectedAdapter: selected.adapter,
        outcome: rcaAssessment.operationallyClosed ? 'complete' : 'executed',
      })
    }

    const correlation = this.scorer.score(findings)
    const policyNextStep = this.settleCompletedProbeStage(
      this.escalationPolicy.decide(correlation),
      { codeProbeRan, dataProbeRan, hostProbeRan },
    )
    const nextStep = !rcaAssessment.diagnosisReady
      ? {
          status: correlation.shouldEscalate ? 'escalated' as const : 'awaiting_review' as const,
          stage: 'summary' as const,
          reason: `${rcaAssessment.summary} No automated remediation is permitted until the missing causal evidence is supplied.`,
        }
      : policyNextStep
    const completedRun: InvestigationRunRecord = {
      ...run,
      status: nextStep.status,
      currentStage: nextStep.stage,
      confidence: correlation.confidence,
      summary: `${correlation.summary} ${rcaAssessment.summary}`,
      updatedAt: new Date().toISOString(),
    }

    logger.info({
      runId: run.id,
      jiraKey: run.jiraKey,
      confidence: correlation.confidence,
      findingCount: findings.length,
      nextStage: nextStep.stage,
      nextStatus: nextStep.status,
    }, '[INVESTIGATION_RUN_COMPLETE]')

    const ledger = buildEvidenceLedger(completedRun, findings, evidence)
    return {
      run: completedRun,
      findings,
      evidence,
      correlation,
      nextStep,
      rcaAssessment,
      planningTrace,
      facts: ledger.facts,
      symptomClusters: ledger.symptomClusters,
    }
  }

  private routePlannedDataChange(run: InvestigationRunRecord): InvestigationRunExecution {
    const nextStep: InvestigationNextStep = {
      status: 'awaiting_review',
      stage: 'summary',
      reason: 'Explicit governed data-change request classified for Meridian planning; execution remains human-gated.',
    }
    const completedRun: InvestigationRunRecord = {
      ...run,
      status: nextStep.status,
      currentStage: nextStep.stage,
      confidence: 1,
      summary: 'Cockpit classified an explicit governed data-change request and bypassed incident evidence probes.',
      updatedAt: new Date().toISOString(),
    }
    const findings: InvestigationFinding[] = []
    const evidence: InvestigationEvidenceArtifact[] = []
    const rcaAssessment = this.completenessEvaluator.evaluate(completedRun, findings, evidence)
    const correlation: InvestigationCorrelationResult = {
      confidence: 1,
      summary: 'Explicit planned data-change routing signal confirmed.',
      shouldEscalate: false,
      shouldProbeCode: false,
      shouldProbeData: false,
      shouldProbeHost: false,
      shouldComplete: true,
    }
    const ledger = buildEvidenceLedger(completedRun, findings, evidence)

    return {
      run: completedRun,
      findings,
      evidence,
      correlation,
      nextStep,
      rcaAssessment,
      planningTrace: [],
      facts: ledger.facts,
      symptomClusters: ledger.symptomClusters,
    }
  }

  private enrichRun(
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
  ): InvestigationRunRecord {
    const keywordEnriched = this.withEvidenceDerivedKeywords(run, findings, evidence)
    return {
      ...keywordEnriched,
      scope: enrichScopeWithDiagnosticEvidence(keywordEnriched.scope, findings, evidence),
    }
  }

  private recordAdapterAttempt(
    kind: InvestigationAdapterKind,
    probeId: string,
    run: InvestigationRunRecord,
    executionCounts: Partial<Record<InvestigationAdapterKind, number>>,
    probeExecutionCounts: Record<string, number>,
    lastScopeFingerprints: Record<string, string>,
  ): void {
    executionCounts[kind] = (executionCounts[kind] || 0) + 1
    probeExecutionCounts[probeId] = (probeExecutionCounts[probeId] || 0) + 1
    lastScopeFingerprints[`${kind}:${probeId}`] = this.scopeFingerprint(run)
  }

  private scopeFingerprint(run: InvestigationRunRecord): string {
    return JSON.stringify({
      keywords: run.scope.keywords || [],
      repos: run.scope.repoNames || [],
      hosts: run.scope.hostTargets || [],
      diagnosticContext: run.scope.diagnosticContext || {},
    })
  }

  private settleCompletedProbeStage(
    nextStep: InvestigationNextStep,
    probes: { codeProbeRan: boolean; dataProbeRan: boolean; hostProbeRan: boolean },
  ): InvestigationNextStep {
    if (nextStep.status !== 'running') {
      return nextStep
    }

    const stageAlreadyRan =
      (nextStep.stage === 'code_probe' && probes.codeProbeRan)
      || (nextStep.stage === 'data_probe' && probes.dataProbeRan)
      || (nextStep.stage === 'host_probe' && probes.hostProbeRan)

    return {
      status: 'awaiting_review',
      stage: 'summary',
      reason: stageAlreadyRan
        ? 'The indicated probe completed; review correlated evidence before remediation.'
        : 'The investigation cycle completed with a recommended follow-up probe; review the causal diagnosis before starting another bounded run.',
    }
  }

  private async executeAdapter(
    kind: InvestigationAdapterKind,
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
    probeId: string,
  ): Promise<boolean> {
    const adapter = this.adapters[kind]
    let retainedPartialResult = false
    const retain = (result: { findings: InvestigationFinding[]; evidence: InvestigationEvidenceArtifact[] }): void => {
      retainedPartialResult ||= result.findings.length > 0 || result.evidence.length > 0
      appendUniqueById(findings, result.findings)
      appendUniqueById(evidence, result.evidence)
      this.reportProgress({
        phase: 'adapter_partial', adapter: kind, probeId,
        findingCount: findings.length, evidenceCount: evidence.length,
        message: `${kind.toUpperCase()} retained ${result.findings.length} finding(s) and ${result.evidence.length} evidence artifact(s).`,
        findings: result.findings,
        evidence: result.evidence,
      })
    }
    const request: InvestigationAdapterRequest = {
      runId: run.id,
      jiraKey: run.jiraKey,
      adapter: kind,
      scope: run.scope,
      constraints: {
        timeoutMs: kind === 'aws' && this.adapterTimeoutMs >= 30_000 && runLooksServerless(run)
          ? Math.min(120_000, Math.max(this.adapterTimeoutMs, 90_000))
          : this.adapterTimeoutMs,
        maxRows: 100,
        maxArtifacts: 20,
        redactionRequired: true,
      },
      onPartialResult: result => retain(result),
    }

    this.reportProgress({
      phase: 'adapter_started', adapter: kind, probeId,
      findingCount: findings.length, evidenceCount: evidence.length,
      message: `Started approved probe ${probeId} through the ${kind.toUpperCase()} adapter.`,
    })
    try {
      const result = await withWallTimeout(
        adapter.execute(request),
        request.constraints.timeoutMs,
        `${kind} investigation adapter`,
      )
      retain(result)
      this.reportProgress({
        phase: 'adapter_completed', adapter: kind, probeId,
        findingCount: findings.length, evidenceCount: evidence.length,
        message: `Completed approved probe ${probeId}.`,
      })
      return retainedPartialResult
    } catch (error) {
      findings.push({
        id: `${run.id}-${kind}-probe-failure-${findings.length + 1}`,
        adapter: kind,
        type: `${kind}_probe_failure`,
        severity: 'medium',
        confidence: 1,
        title: `${kind.toUpperCase()} evidence probe did not complete`,
        summary: error instanceof Error ? error.message : String(error),
        evidenceRefs: [],
        requiresCodeChange: false,
        requiresDataChange: false,
      })
      this.reportProgress({
        phase: 'adapter_completed', adapter: kind, probeId,
        findingCount: findings.length, evidenceCount: evidence.length,
        message: `Probe ${probeId} ended with a bounded adapter failure.`,
      })
      return retainedPartialResult
    }
  }

  private reportProgress(progress: InvestigationRunProgress): void {
    try {
      this.onProgress?.(progress)
    } catch (error) {
      logger.warn({ error }, '[INVESTIGATION_PROGRESS_CALLBACK_FAILED]')
    }
  }

  private adapterFailedSince(
    findings: InvestigationFinding[],
    kind: InvestigationAdapterKind,
    startIndex: number,
  ): boolean {
    return findings.slice(startIndex).some(finding => finding.type === `${kind}_probe_failure`)
  }

  private withEvidenceDerivedKeywords(
    run: InvestigationRunRecord,
    findings: InvestigationFinding[],
    evidence: InvestigationEvidenceArtifact[],
  ): InvestigationRunRecord {
    const evidenceTerms = extractEvidenceSearchTerms(findings, evidence)
    if (evidenceTerms.length === 0) {
      return run
    }

    const existing = run.scope.keywords ?? []
    const keywordSet = new Set<string>(existing)
    for (const term of evidenceTerms) {
      keywordSet.add(term)
    }

    return {
      ...run,
      scope: {
        ...run.scope,
        keywords: Array.from(keywordSet).slice(0, 50),
      },
    }
  }
}

function appendUniqueById<T extends { id: string }>(target: T[], incoming: T[]): void {
  const existing = new Map(target.map((item, index) => [item.id, index]))
  for (const item of incoming) {
    const index = existing.get(item.id)
    if (index !== undefined) {
      target[index] = item
      continue
    }
    existing.set(item.id, target.length)
    target.push(item)
  }
}

async function withWallTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded the ${timeoutMs}ms evidence budget.`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
